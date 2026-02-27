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
    const PAGE_TIMEOUT = 3000; // 3s timeout for page fetches (fast fail)

    // Fetch page 1
    let firstData;
    try {
        firstData = await shApi('GET', '/v1/sequences?page=1', null, PAGE_TIMEOUT);
    } catch (err) {
        if (err.isRateLimit) {
            await sleep(2000);
            try { firstData = await shApi('GET', '/v1/sequences?page=1', null, PAGE_TIMEOUT); }
            catch { return []; }
        } else {
            return [];
        }
    }
    if (!firstData) return [];

    const firstItems = extractItems(firstData);
    if (!Array.isArray(firstItems) || firstItems.length === 0) return [];
    const all = [...firstItems];

    const totalPages = firstData.totalPages ?? firstData.total_pages
        ?? firstData.meta?.totalPages ?? firstData.meta?.last_page ?? null;

    if (totalPages === 1) return filterActive(all);

    // Fetch remaining pages in parallel batches of 5.
    // Stop as soon as a batch yields zero items (gone past last page).
    const maxPage = (totalPages && totalPages > 1) ? totalPages : 30;

    for (let startPage = 2; startPage <= maxPage; startPage += 5) {
        const batch = [];
        for (let p = startPage; p < startPage + 5 && p <= maxPage; p++) batch.push(p);

        const results = await Promise.all(batch.map(async (p) => {
            try { return await shApi('GET', `/v1/sequences?page=${p}`, null, PAGE_TIMEOUT); }
            catch { return null; }
        }));

        let batchItems = 0;
        for (const data of results) {
            if (!data) continue;
            const items = extractItems(data);
            if (Array.isArray(items) && items.length > 0) {
                all.push(...items);
                batchItems += items.length;
            }
        }

        // No items in this batch → we've passed the last page, stop
        if (batchItems === 0) break;
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
// runCountRound(ids, fetchFn, concurrency, deadline)
// Tries one strategy on a batch of IDs. If the first batch yields zero
// successes, abandons this strategy immediately (saves ~15s per bad strategy).
// Returns { counts: { id→count }, abandoned: bool }
// ─────────────────────────────────────────────────────────────────────────────

async function runCountRound(ids, fetchFn, concurrency, deadline) {
    const counts = {};
    let abandoned = false;

    for (let i = 0; i < ids.length; i += concurrency) {
        if (Date.now() > deadline) break;

        const chunk = ids.slice(i, i + concurrency);
        const results = await Promise.all(chunk.map(async (id) => {
            try { return { id, count: await fetchFn(id) }; }
            catch { return { id, count: null }; }
        }));

        for (const r of results) {
            counts[r.id] = r.count;
        }

        // After first batch: if zero successes, this strategy doesn't work — abort
        if (i === 0) {
            const successes = results.filter(r => r.count !== null).length;
            if (successes === 0) { abandoned = true; break; }
        }

        if (i + concurrency < ids.length) await sleep(BATCH_DELAY);
    }

    return { counts, abandoned };
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
        // 2. Fetch active sequences (SalesHandy is the source of truth)
        const activeSequences = await fetchActiveSequences();
        if (activeSequences.length === 0) {
            return { ok: false, reason: 'no_active_sequences' };
        }

        // 3. Separate sequences with/without embedded counts
        const sequences = {};   // id → not_contacted count
        const metadata = {};    // id → { name, client }
        let pending = [];       // IDs that still need counts
        let embeddedUsed = 0;

        for (const seq of activeSequences) {
            metadata[seq.id] = { name: seq.name, client: seq.client };
            if (seq.embeddedCount !== null) {
                sequences[seq.id] = seq.embeddedCount;
                embeddedUsed++;
            } else {
                pending.push(seq.id);
            }
        }

        // 4. Try count strategies in ROUNDS (test first batch, skip if useless)
        //    Each round makes ONE API call per sequence — fast discovery of what works.
        const strategies = [
            { name: 'analytics', fn: tryAnalytics },
            { name: 'detail',    fn: tryDetail },
            { name: 'prospects', fn: tryProspects },
        ];
        let timedOut = false;
        let winningStrategy = null;

        for (const strategy of strategies) {
            if (pending.length === 0 || Date.now() > deadline) break;

            const { counts, abandoned } = await runCountRound(
                pending, strategy.fn, CONCURRENCY, deadline,
            );

            // Merge successes
            let filled = 0;
            for (const [id, count] of Object.entries(counts)) {
                if (count !== null) {
                    sequences[id] = count;
                    filled++;
                }
            }

            if (abandoned) continue; // strategy failed — try next

            if (!winningStrategy && filled > 0) winningStrategy = strategy.name;

            // Remove resolved IDs from pending
            pending = pending.filter(id => sequences[id] === undefined || sequences[id] === null);

            if (Date.now() > deadline) { timedOut = true; break; }
        }

        // Mark remaining as null
        let errorCount = 0;
        for (const id of pending) {
            if (sequences[id] === undefined) sequences[id] = null;
            errorCount++;
        }

        // 5. Save to Redis (partial on timeout is better than nothing)
        const fetched = Object.keys(sequences).length;
        if (fetched > 0) {
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
            fetched,
            errors: errorCount,
            partial: timedOut,
            embeddedUsed,
            winningStrategy,
        };
    } finally {
        // 6. Release lock
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
