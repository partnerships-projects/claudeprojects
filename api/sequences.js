// ─────────────────────────────────────────────────────────────────────────────
// Vercel Serverless Function — SalesHandy "Not Contacted" Dashboard
// ─────────────────────────────────────────────────────────────────────────────
//
// Endpoints:
//   GET /api/sequences            → stale-while-revalidate read from Redis
//   GET /api/sequences?refresh=1  → synchronous full refresh (called by frontend)
//   GET /api/sequences?reset=1    → clear all Redis keys
//   GET /api/sequences?debug=1    → raw pagination debug
//
// Cache structure (single Redis key "saleshandy:not_contacted:active_sequences"):
//   { last_updated, sequences: { id: count }, metadata: { id: { name, client } } }
//
// Refresh lock ("saleshandy:refresh_lock") prevents concurrent refreshes.
// ─────────────────────────────────────────────────────────────────────────────

const {
    API_KEY, THRESHOLD, KV_URL,
    CACHE_KEY, LOCK_KEY, LAST_REFRESH_KEY,
    CONCURRENCY, BATCH_DELAY, CACHE_FRESH_MS, LOCK_TTL, CACHE_TTL, WALL_CLOCK_LIMIT,
    shApi, sleep,
    kvGet, kvSet, kvDel, kvSetNX,
    extractItems,
} = require('./_lib');

// ─────────────────────────────────────────────────────────────────────────────
// fetchActiveSequences()
// Fetches ALL sequences from SalesHandy (paginated), returns only active ones
// (progress === 1). SalesHandy is always the source of truth.
// ─────────────────────────────────────────────────────────────────────────────

async function fetchActiveSequences() {
    const all = [];
    let page = 1;
    let retries = 0;

    while (page <= 50) {
        let data;
        try {
            data = await shApi('GET', `/v1/sequences?page=${page}`, null);
            retries = 0;
        } catch (err) {
            if (err.isRateLimit && retries < 3) {
                retries++;
                const wait = err.retryAfterSec || 3 * retries;
                await sleep(wait * 1000);
                continue;
            }
            break;
        }

        const items = extractItems(data);
        if (!Array.isArray(items) || items.length === 0) break;
        all.push(...items);

        const totalPages = data.totalPages ?? data.total_pages
            ?? data.meta?.totalPages ?? data.meta?.last_page ?? null;
        if (totalPages !== null && page >= totalPages) break;
        if (items.length < 100) break;
        page++;
        await sleep(300);
    }

    return all
        .filter(s => s.progress === 1)
        .map(s => ({
            id: s.id || s._id || s.sequenceId,
            name: s.name || s.title || s.sequenceName || `Sequence ${s.id}`,
            client: s.client?.companyName || null,
        }));
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchNotContacted(sequenceId)
// Fetches the "not contacted" count for a single sequence via POST analytics.
// Retries with exponential backoff on failure; respects Retry-After header.
// ─────────────────────────────────────────────────────────────────────────────

async function fetchNotContacted(sequenceId) {
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const stats = await shApi('POST', '/v1/analytics/stats', { sequenceId });
            const p = stats.payload?.prospects?.[0];
            if (!p) return null;
            return Number(p.notContacted) || 0;
        } catch (err) {
            if (attempt >= MAX_RETRIES) return null;
            if (err.isRateLimit) {
                const wait = err.retryAfterSec || Math.pow(2, attempt + 1);
                await sleep(wait * 1000);
            } else {
                await sleep(Math.pow(2, attempt + 1) * 1000);
            }
        }
    }
    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// refreshCache()
// Full refresh cycle:
//   1. Acquire Redis lock (prevent concurrent refreshes)
//   2. Fetch fresh list of active sequences from SalesHandy
//   3. Fetch not_contacted count for each (controlled concurrency, max 5)
//   4. Build a completely new cache object and atomically SET in Redis
//   5. Update saleshandy:last_refresh timestamp
//   6. Release lock
// ─────────────────────────────────────────────────────────────────────────────

async function refreshCache() {
    // 1. Acquire lock
    const acquired = await kvSetNX(LOCK_KEY, Date.now(), LOCK_TTL);
    if (!acquired) return { ok: false, reason: 'locked' };

    const deadline = Date.now() + WALL_CLOCK_LIMIT;

    try {
        // 2. Fetch active sequences (SalesHandy is the source of truth)
        const activeSequences = await fetchActiveSequences();
        if (activeSequences.length === 0) {
            return { ok: false, reason: 'no_active_sequences' };
        }

        // 3. Fetch counts with controlled concurrency (max 5 parallel)
        const sequences = {};   // id → not_contacted count
        const metadata = {};    // id → { name, client }
        let errorCount = 0;

        for (let i = 0; i < activeSequences.length; i += CONCURRENCY) {
            if (Date.now() > deadline) {
                return {
                    ok: false, reason: 'timeout',
                    fetched: Object.keys(sequences).length,
                    total: activeSequences.length,
                };
            }

            const chunk = activeSequences.slice(i, i + CONCURRENCY);
            const results = await Promise.all(chunk.map(async (seq) => {
                const count = await fetchNotContacted(seq.id);
                return { id: seq.id, name: seq.name, client: seq.client, count };
            }));

            for (const r of results) {
                sequences[r.id] = r.count;
                metadata[r.id] = { name: r.name, client: r.client };
                if (r.count === null) errorCount++;
            }

            // 200-300ms pause between batches to reduce API pressure
            if (i + CONCURRENCY < activeSequences.length) {
                await sleep(BATCH_DELAY);
            }
        }

        // 4. Build new object and atomically overwrite Redis key
        const cacheData = {
            last_updated: new Date().toISOString(),
            sequences,
            metadata,
        };
        await kvSet(CACHE_KEY, cacheData, CACHE_TTL);

        // 5. Update last_refresh timestamp
        await kvSet(LAST_REFRESH_KEY, new Date().toISOString(), CACHE_TTL);

        return { ok: true, total: activeSequences.length, errors: errorCount };
    } finally {
        // 6. Release lock
        await kvDel(LOCK_KEY);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// getDashboardData()
// Stale-while-revalidate:
//   - No cache        → blocking fetch, store, return fresh data
//   - Cache < 3 min   → return immediately (fresh)
//   - Cache > 3 min   → return stale immediately, flag for background refresh
// ─────────────────────────────────────────────────────────────────────────────

async function getDashboardData() {
    const cached = await kvGet(CACHE_KEY);

    if (!cached) {
        // No cache — don't block (would exceed Vercel 60s limit for 79+ sequences).
        // Return empty and let the frontend trigger ?refresh=1 separately.
        return { data: null, source: 'empty', needsRefresh: true };
    }

    const age = Date.now() - new Date(cached.last_updated).getTime();

    if (age < CACHE_FRESH_MS) {
        // Fresh — return immediately
        return { data: cached, source: 'cache' };
    }

    // Stale — return immediately, flag for background refresh
    return { data: cached, source: 'stale', needsRefresh: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildDashboardResponse(cacheData)
// Transforms the Redis cache structure into the dashboard JSON format.
// ─────────────────────────────────────────────────────────────────────────────

function buildDashboardResponse(data) {
    const sequences = [];
    for (const [id, count] of Object.entries(data.sequences || {})) {
        const meta = data.metadata?.[id] || {};
        sequences.push({
            id,
            name: meta.name || `Sequence ${id}`,
            notContactedCount: count,
            client: meta.client || null,
        });
    }
    return {
        sequences,
        threshold: THRESHOLD,
        lastUpdated: data.last_updated,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Handler
// ─────────────────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }

    if (!API_KEY) {
        return res.status(500).json({ error: 'SALESHANDY_API_KEY not set.' });
    }

    // ── ?reset=1 — clear all Redis keys ─────────────────────────────────
    if (req.query.reset === '1' && KV_URL) {
        await Promise.all([
            kvDel(CACHE_KEY),
            kvDel(LOCK_KEY),
            kvDel(LAST_REFRESH_KEY),
            // Clean up legacy keys from previous cache structure
            kvDel('sh:sequences'),
            kvDel('sh:stats'),
            kvDel('sh:response'),
        ]);
        return res.status(200).json({ ok: true, message: 'Cache cleared. Refresh the page.' });
    }

    // ── ?debug=1 — raw pagination debug ─────────────────────────────────
    if (req.query.debug === '1') {
        const pages = [];
        const allRaw = [];
        let retries = 0;
        for (let p = 1; p <= 50; p++) {
            try {
                const data = await shApi('GET', `/v1/sequences?page=${p}`, null);
                retries = 0;
                const items = extractItems(data);
                if (!Array.isArray(items) || items.length === 0) break;
                allRaw.push(...items);
                pages.push({
                    page: p,
                    itemCount: items.length,
                    progressBreakdown: items.reduce((acc, s) => {
                        acc[`progress=${s.progress}`] = (acc[`progress=${s.progress}`] || 0) + 1;
                        return acc;
                    }, {}),
                });
                if (items.length < 100) break;
                await sleep(300);
            } catch (err) {
                if (err.isRateLimit && retries < 3) {
                    retries++;
                    await sleep(3000 * retries);
                    p--;
                    continue;
                }
                pages.push({ page: p, error: err.message });
                break;
            }
        }
        const filtered = allRaw.filter(s => s.progress === 1);
        return res.status(200).json({
            totalRawFromApi: allRaw.length,
            withProgress1: filtered.length,
            pages,
            filteredNames: filtered.map(s => ({ id: s.id, title: s.title, progress: s.progress })),
        });
    }

    // ── ?refresh=1 — synchronous full refresh ───────────────────────────
    if (req.query.refresh === '1') {
        const result = await refreshCache();

        if (!result.ok) {
            if (result.reason === 'locked') {
                return res.status(200).json({
                    ok: false,
                    message: 'Refresh already in progress. Try again shortly.',
                });
            }
            return res.status(200).json({ ok: false, ...result });
        }

        // Return fresh data after successful refresh
        const fresh = await kvGet(CACHE_KEY);
        const lastRefresh = await kvGet(LAST_REFRESH_KEY);
        return res.status(200).json({
            ...buildDashboardResponse(fresh),
            lastRefresh,
            _meta: { source: 'refresh', ...result },
        });
    }

    // ── Default: stale-while-revalidate read ────────────────────────────
    try {
        const { data, source, needsRefresh, refreshResult } = await getDashboardData();

        if (!data) {
            // No cache yet — return empty response, frontend will call ?refresh=1
            return res.status(200).json({
                sequences: [],
                threshold: THRESHOLD,
                lastUpdated: null,
                lastRefresh: null,
                _meta: { source, needsRefresh: true, activeSequences: 0 },
            });
        }

        const lastRefresh = await kvGet(LAST_REFRESH_KEY);
        const response = {
            ...buildDashboardResponse(data),
            lastRefresh,
            _meta: {
                source,
                needsRefresh: !!needsRefresh,
                activeSequences: Object.keys(data.sequences).length,
            },
        };

        res.status(200).json(response);

        // Best-effort background refresh after responding (serverless may kill this)
        // The frontend also calls ?refresh=1 for reliability
        if (needsRefresh) {
            refreshCache().catch(() => {});
        }
    } catch (err) {
        // Try to serve stale data on error
        if (KV_URL) {
            try {
                const stale = await kvGet(CACHE_KEY);
                if (stale) {
                    return res.status(200).json({
                        ...buildDashboardResponse(stale),
                        _meta: { source: 'error-stale', error: err.message },
                    });
                }
            } catch {}
        }
        res.status(500).json({ error: err.message });
    }
};
