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
// extractEmbeddedCount(seq)
// Try to find a not-contacted count already embedded in the sequence object.
// ─────────────────────────────────────────────────────────────────────────────

function extractEmbeddedCount(s) {
    const c = s.notContactedCount ?? s.not_contacted_count
        ?? s.notContacted ?? s.not_contacted
        ?? s.prospects?.notContacted ?? s.prospects?.not_contacted
        ?? s.stats?.notContacted ?? s.stats?.not_contacted
        ?? s.prospectStats?.notContacted ?? s.prospectStats?.not_contacted;
    return c !== null && c !== undefined ? Number(c) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchActiveSequences()
// Fetches ALL sequences from SalesHandy (paginated), returns only active ones
// (progress === 1). Paginates until no more results — does NOT assume page size.
// ─────────────────────────────────────────────────────────────────────────────

async function fetchActiveSequences() {
    // Fetch page 1 (with retry on any error)
    let firstData;
    try {
        firstData = await shApi('GET', '/v1/sequences?page=1', null);
    } catch (err) {
        await sleep(err.isRateLimit ? 2000 : 1000);
        try { firstData = await shApi('GET', '/v1/sequences?page=1', null); }
        catch { return []; }
    }
    if (!firstData) return [];

    const firstItems = extractItems(firstData);
    if (!Array.isArray(firstItems) || firstItems.length === 0) return [];
    const all = [...firstItems];

    const totalPages = firstData.totalPages ?? firstData.total_pages
        ?? firstData.meta?.totalPages ?? firstData.meta?.last_page ?? null;

    if (totalPages === 1) return filterActive(all);

    // Fetch remaining pages in parallel (all at once if totalPages is known).
    const maxPage = (totalPages && totalPages > 1) ? totalPages : 30;
    const pageNums = [];
    for (let p = 2; p <= maxPage; p++) pageNums.push(p);

    const results = await Promise.all(pageNums.map(async (p) => {
        try { return await shApi('GET', `/v1/sequences?page=${p}`, null); }
        catch { return null; }
    }));

    for (const data of results) {
        if (!data) continue;
        const items = extractItems(data);
        if (Array.isArray(items) && items.length > 0) {
            all.push(...items);
        }
    }

    return filterActive(all);
}

function filterActive(items) {
    return items
        .filter(s => s.progress === 1)
        .map(s => ({
            id: s.id || s._id || s.sequenceId,
            name: s.name || s.title || s.sequenceName || `Sequence ${s.id}`,
            client: s.client?.companyName || null,
            embeddedCount: extractEmbeddedCount(s),
        }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Count-fetching strategies (one API call each — NO retries here)
// ─────────────────────────────────────────────────────────────────────────────

async function tryAnalytics(sequenceId) {
    const stats = await shApi('POST', '/v1/analytics/stats', { sequenceId });
    const p = stats.payload?.prospects?.[0];
    if (p && p.notContacted !== undefined && p.notContacted !== null) {
        return Number(p.notContacted);
    }
    return null;
}

async function tryDetail(sequenceId) {
    const detail = await shApi('GET', `/v1/sequences/${sequenceId}`, null);
    const s = detail.payload || detail.data || detail;
    return extractEmbeddedCount(s);
}

async function tryProspects(sequenceId) {
    const data = await shApi('GET',
        `/v1/sequences/${sequenceId}/prospects?status=NOT_CONTACTED`, null);
    const total = data.total ?? data.totalCount ?? data.total_count
        ?? data.meta?.total ?? data.pagination?.total
        ?? data.payload?.total ?? data.payload?.totalCount;
    return (total !== null && total !== undefined) ? Number(total) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchCountsBatched(ids, sequences, deadline)
// Fetches "not contacted" counts via analytics API in small batches.
// Handles rate limiting with backoff instead of abandoning.
// ─────────────────────────────────────────────────────────────────────────────

async function fetchCountsBatched(ids, sequences, deadline) {
    const BATCH = 5; // smaller batches to avoid rate limits
    let timedOut = false;

    for (let i = 0; i < ids.length; i += BATCH) {
        if (Date.now() > deadline) { timedOut = true; break; }

        const chunk = ids.slice(i, i + BATCH);
        let rateLimitHit = false;

        const results = await Promise.all(chunk.map(async (id) => {
            try {
                return { id, count: await tryAnalytics(id) };
            } catch (err) {
                if (err.isRateLimit) rateLimitHit = true;
                return { id, count: null };
            }
        }));

        for (const r of results) {
            if (r.count !== null) sequences[r.id] = r.count;
        }

        if (rateLimitHit) {
            // Wait for rate limit to reset, then keep going
            const wait = Math.min(10000, deadline - Date.now() - 5000);
            if (wait > 0) await sleep(wait);
            else { timedOut = true; break; }
        } else if (i + BATCH < ids.length) {
            await sleep(300); // gentle delay between batches
        }
    }

    return timedOut;
}

// ─────────────────────────────────────────────────────────────────────────────
// refreshCache()
// Full refresh cycle:
//   1. Acquire Redis lock (prevent concurrent refreshes)
//   2. Fetch fresh list of active sequences from SalesHandy
//   3. Use embedded counts where available, fetch the rest in parallel
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
        // 2. Read existing cache — enables incremental progress across calls
        const existingCache = await kvGet(CACHE_KEY);
        const existingCounts = existingCache?.sequences || {};

        // 3. Fetch active sequences — or reuse cached list if recent (< 2 min)
        //    Skipping pagination on retries saves 10-15s for count-fetching.
        let activeSequences;
        let skippedPagination = false;

        if (existingCache?.last_updated && existingCache?.metadata) {
            const cacheAge = Date.now() - new Date(existingCache.last_updated).getTime();
            if (cacheAge < 2 * 60 * 1000 && Object.keys(existingCache.metadata).length > 0) {
                activeSequences = Object.keys(existingCache.metadata).map(id => ({
                    id,
                    name: existingCache.metadata[id]?.name || `Sequence ${id}`,
                    client: existingCache.metadata[id]?.client || null,
                    embeddedCount: null,
                }));
                skippedPagination = true;
            }
        }

        if (!skippedPagination) {
            activeSequences = await fetchActiveSequences();
        }

        if (activeSequences.length === 0) {
            return { ok: false, reason: 'no_active_sequences' };
        }

        // 4. Build maps — carry over non-null counts from previous cache
        const sequences = {};   // id → not_contacted count
        const metadata = {};    // id → { name, client }
        let pending = [];       // IDs that still need counts
        let embeddedUsed = 0;
        let carriedOver = 0;

        for (const seq of activeSequences) {
            metadata[seq.id] = { name: seq.name, client: seq.client };
            if (seq.embeddedCount !== null) {
                sequences[seq.id] = seq.embeddedCount;
                embeddedUsed++;
            } else if (existingCounts[seq.id] != null) {
                // Carry over count from previous refresh (non-null only)
                sequences[seq.id] = existingCounts[seq.id];
                carriedOver++;
            } else {
                pending.push(seq.id);
            }
        }

        // 5. Fetch counts for pending IDs using analytics API
        //    Uses small batches (5) with rate limit detection + backoff.
        let timedOut = false;

        if (pending.length > 0 && Date.now() < deadline) {
            timedOut = await fetchCountsBatched(pending, sequences, deadline);
        }

        // Update pending — remove any that got counts
        pending = pending.filter(id => sequences[id] === undefined || sequences[id] === null);

        // Mark remaining as null
        let errorCount = 0;
        for (const id of pending) {
            if (sequences[id] === undefined) sequences[id] = null;
            errorCount++;
        }

        // 6. Save to Redis (partial is better than nothing)
        const withCounts = Object.values(sequences).filter(c => c !== null).length;
        if (Object.keys(sequences).length > 0) {
            const cacheData = {
                last_updated: new Date().toISOString(),
                sequences,
                metadata,
            };
            await kvSet(CACHE_KEY, cacheData, CACHE_TTL);
            await kvSet(LAST_REFRESH_KEY, new Date().toISOString(), CACHE_TTL);
        }

        return {
            ok: true,
            total: activeSequences.length,
            fetched: withCounts,
            errors: errorCount,
            partial: errorCount > 0,
            embeddedUsed,
            carriedOver,
            skippedPagination,
        };
    } finally {
        // 7. Release lock
        await kvDel(LOCK_KEY);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// getDashboardData()
// Stale-while-revalidate:
//   - No cache        → return empty, frontend triggers refresh
//   - Cache < 3 min   → return immediately (fresh)
//   - Cache > 3 min   → return stale immediately, flag for background refresh
// ─────────────────────────────────────────────────────────────────────────────

async function getDashboardData() {
    const cached = await kvGet(CACHE_KEY);

    if (!cached) {
        return { data: null, source: 'empty', needsRefresh: true };
    }

    const age = Date.now() - new Date(cached.last_updated).getTime();

    if (age < CACHE_FRESH_MS) {
        return { data: cached, source: 'cache' };
    }

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
                const tp = data.totalPages ?? data.total_pages
                    ?? data.meta?.totalPages ?? data.meta?.last_page ?? null;
                pages.push({
                    page: p,
                    itemCount: items.length,
                    totalPagesFromApi: tp,
                    progressBreakdown: items.reduce((acc, s) => {
                        acc[`progress=${s.progress}`] = (acc[`progress=${s.progress}`] || 0) + 1;
                        return acc;
                    }, {}),
                    sampleKeys: p === 1 && items[0] ? Object.keys(items[0]) : undefined,
                });
                // Stop only when API explicitly says no more, or empty result
                if (tp !== null && p >= tp) break;
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
            const cached = await kvGet(CACHE_KEY);
            return res.status(200).json({
                ...(cached ? buildDashboardResponse(cached) : { sequences: [], threshold: THRESHOLD, lastUpdated: null }),
                _meta: { source: 'refresh-error', ...result },
            });
        }

        const fresh = await kvGet(CACHE_KEY);
        const lastRefresh = await kvGet(LAST_REFRESH_KEY);
        return res.status(200).json({
            ...buildDashboardResponse(fresh || { sequences: {}, metadata: {} }),
            lastRefresh,
            _meta: { source: result.partial ? 'refresh-partial' : 'refresh', ...result },
        });
    }

    // ── Default: stale-while-revalidate read ────────────────────────────
    try {
        const { data, source, needsRefresh } = await getDashboardData();

        if (!data) {
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

        if (needsRefresh) {
            refreshCache().catch(() => {});
        }
    } catch (err) {
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
