// ─────────────────────────────────────────────────────────────────────────────
// Vercel Serverless Function — SalesHandy "Not Contacted" Dashboard
// ─────────────────────────────────────────────────────────────────────────────
//
// Architecture: Redis always holds complete data (no nulls).
//
//   GET /api/sequences            → instant Redis read (all sequences + counts)
//   GET /api/sequences?refresh=1  → incremental refresh, returns updated data
//   GET /api/sequences?reset=1    → clear all Redis keys
//   GET /api/sequences?debug=1    → raw pagination debug
//
// Cache (Redis "saleshandy:not_contacted:active_sequences"):
//   { last_updated, sequences: { id: count }, metadata: { id: { name, client } } }
//   sequences{} only has entries with real counts — never nulls.
//   metadata{} has ALL active sequences (so pagination-skip knows the full list).
//
// Refresh is incremental:
//   - Carries over already-fetched counts from previous cache.
//   - Fetches stats only for sequences not yet in cache.
//   - Saves progress after each batch (only complete entries).
//   - Stops at 50s wall clock; frontend silently retries for the rest.
// ─────────────────────────────────────────────────────────────────────────────

const {
    API_KEY, THRESHOLD, KV_URL,
    CACHE_KEY, LOCK_KEY, LAST_REFRESH_KEY,
    PAGE_TIMEOUT, CONCURRENCY, BATCH_DELAY, THROTTLE_DELAY,
    CACHE_FRESH_MS, LOCK_TTL, CACHE_TTL, WALL_CLOCK_LIMIT,
    shApi, sleep,
    kvGet, kvSet, kvDel, kvSetNX,
    extractItems,
} = require('./_lib');

// ─────────────────────────────────────────────────────────────────────────────
// fetchActiveSequences()
// Bulk fetch via paginated /v1/sequences endpoint (fast, not rate-limited).
// Returns only active sequences (progress === 1).
// ─────────────────────────────────────────────────────────────────────────────

async function fetchActiveSequences() {
    let firstData;
    try {
        firstData = await shApi('GET', '/v1/sequences?page=1', null, PAGE_TIMEOUT);
    } catch {
        return [];
    }
    if (!firstData) return [];

    const firstItems = extractItems(firstData);
    if (!Array.isArray(firstItems) || firstItems.length === 0) return [];
    const all = [...firstItems];

    // Fetch remaining pages in batches of 5; stop on empty batch.
    for (let start = 2; start <= 30; start += 5) {
        const pages = [];
        for (let p = start; p < start + 5 && p <= 30; p++) pages.push(p);

        const results = await Promise.all(pages.map(async (p) => {
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
        if (batchItems === 0) break;
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
// fetchStat(sequenceId)
// Fetches not-contacted count for ONE sequence via the analytics endpoint.
// FAST-FAIL on 429 (rate limit): returns null immediately — no retry.
// Retrying 429 wastes 6-14s per call on backoff; the rate limit resets on its
// own. Much faster to skip failures and let the next refresh cycle pick them up.
// Only retries once on timeout (transient network issue).
// ─────────────────────────────────────────────────────────────────────────────

async function fetchStat(sequenceId) {
    try {
        const stats = await shApi('POST', '/v1/analytics/stats', { sequenceId });
        const p = stats.payload?.prospects?.[0];
        if (p && p.notContacted != null) return Number(p.notContacted);
        return null;
    } catch (err) {
        // Rate limit: fail fast — don't burn time on backoff
        if (err.isRateLimit) return null;
        // Timeout: one retry (transient network glitch)
        if (err.message === 'Timeout') {
            try {
                const stats = await shApi('POST', '/v1/analytics/stats', { sequenceId });
                const p = stats.payload?.prospects?.[0];
                if (p && p.notContacted != null) return Number(p.notContacted);
            } catch { /* give up */ }
        }
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// refreshCache()
// Incremental refresh cycle:
//   1. Acquire Redis lock (prevents concurrent refreshes)
//   2. Fetch active sequences (bulk, fast)
//   3. Carry over non-null counts from previous cache
//   4. Fetch stats for remaining IDs with controlled concurrency
//   5. Save progress after each batch (crash-safe)
//   6. Release lock
// ─────────────────────────────────────────────────────────────────────────────

async function refreshCache() {
    const acquired = await kvSetNX(LOCK_KEY, Date.now(), LOCK_TTL);
    if (!acquired) return { ok: false, reason: 'locked' };

    const deadline = Date.now() + WALL_CLOCK_LIMIT;

    try {
        // Load existing cache for incremental carry-over
        const existing = await kvGet(CACHE_KEY);
        const existingCounts = existing?.sequences || {};

        // Fetch active sequences — skip pagination if cache is recent (< 2 min)
        let activeSequences;
        let skippedPagination = false;

        if (existing?.last_updated && existing?.metadata) {
            const age = Date.now() - new Date(existing.last_updated).getTime();
            if (age < 2 * 60 * 1000 && Object.keys(existing.metadata).length > 0) {
                activeSequences = Object.keys(existing.metadata).map(id => ({
                    id,
                    name: existing.metadata[id]?.name || `Sequence ${id}`,
                    client: existing.metadata[id]?.client || null,
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

        // Build maps — carry over existing counts, queue sequences without counts.
        // INVARIANT: counts{} never contains null values — only real numbers.
        // metadata{} always has ALL active sequences (so skippedPagination works).
        const counts = {};
        const metadata = {};
        const pending = [];
        let carriedOver = 0;

        for (const seq of activeSequences) {
            metadata[seq.id] = { name: seq.name, client: seq.client };
            if (existingCounts[seq.id] != null) {
                counts[seq.id] = existingCounts[seq.id];
                carriedOver++;
            } else {
                pending.push(seq.id);
            }
        }

        // Two-phase fetch: burst then throttle.
        //   Burst:    CONCURRENCY parallel, BATCH_DELAY gap — fast until rate limit.
        //   Throttle: 1 sequential, THROTTLE_DELAY gap — stays under rate limit.
        // This maximizes calls per invocation instead of stopping and waiting.
        const failed = [];
        let newlyFetched = 0;
        let consecutiveEmpty = 0;
        let rateLimited = false;
        let throttled = false;
        let idx = 0;

        while (idx < pending.length) {
            if (Date.now() > deadline) break;

            const batchSize = throttled ? 1 : CONCURRENCY;
            const batch = pending.slice(idx, idx + batchSize);
            const results = await Promise.all(
                batch.map(id =>
                    fetchStat(id).then(count => ({ id, count }))
                )
            );

            let batchHits = 0;
            for (const { id, count } of results) {
                if (count !== null) {
                    counts[id] = count;
                    newlyFetched++;
                    batchHits++;
                } else {
                    failed.push(id);
                }
            }

            if (batchHits === 0) {
                consecutiveEmpty++;
                if (throttled && consecutiveEmpty >= 3) {
                    // Rate limit still active — wait 10s for it to reset
                    if (Date.now() + 10000 < deadline) {
                        await sleep(10000);
                        consecutiveEmpty = 0;  // reset counter and try again
                    } else {
                        rateLimited = true;
                        break;
                    }
                }
                if (!throttled && consecutiveEmpty >= 2) {
                    // Switch from burst → throttle mode
                    throttled = true;
                    consecutiveEmpty = 0;
                }
            } else {
                consecutiveEmpty = 0;
            }

            idx += batchSize;

            // Save to Redis after every batch — frontend polls Redis for progress
            if (newlyFetched > 0 || idx >= pending.length) {
                await kvSet(CACHE_KEY, {
                    last_updated: new Date().toISOString(),
                    sequences: counts,
                    metadata,
                }, CACHE_TTL);
            }

            // Pace: fast in burst mode, slow in throttled mode
            if (idx < pending.length && Date.now() < deadline) {
                await sleep(throttled ? THROTTLE_DELAY : BATCH_DELAY);
            }
        }

        // Final timestamp
        await kvSet(LAST_REFRESH_KEY, new Date().toISOString(), CACHE_TTL);

        const totalWithCounts = Object.keys(counts).length;

        return {
            ok: true,
            total: activeSequences.length,
            fetched: totalWithCounts,
            errors: failed.length,
            partial: totalWithCounts < activeSequences.length,
            rateLimited,
            throttled,
            retryAfterMs: rateLimited ? 30000 : 2000,
            carriedOver,
            newlyFetched,
            skippedPagination,
            failedSample: failed.slice(0, 5),
        };
    } finally {
        await kvDel(LOCK_KEY);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// getDashboardData()
// Always returns cached data instantly. Frontend handles background refresh.
// ─────────────────────────────────────────────────────────────────────────────

async function getDashboardData() {
    const cached = await kvGet(CACHE_KEY);

    if (!cached) {
        return { data: null, source: 'empty' };
    }

    return { data: cached, source: 'cache' };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildDashboardResponse(cacheData)
// ─────────────────────────────────────────────────────────────────────────────

function buildDashboardResponse(data) {
    const sequences = [];
    // Only return sequences that have a fetched count (counts{} has no nulls).
    // metadata{} may have more entries (sequences still pending).
    for (const [id, count] of Object.entries(data.sequences || {})) {
        if (count == null) continue;  // safety net
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

    // ── ?refresh=1 — synchronous incremental refresh ────────────────────
    if (req.query.refresh === '1') {
        const result = await refreshCache();

        if (!result.ok) {
            if (result.reason === 'locked') {
                // Another refresh is running — return current cache
                const cached = await kvGet(CACHE_KEY);
                if (cached) {
                    const totalWithCounts = Object.keys(cached.sequences || {}).length;
                    const total = Object.keys(cached.metadata || {}).length || totalWithCounts;
                    return res.status(200).json({
                        ...buildDashboardResponse(cached),
                        lastRefresh: await kvGet(LAST_REFRESH_KEY),
                        _meta: {
                            source: 'refresh-locked',
                            total,
                            fetched: totalWithCounts,
                            partial: totalWithCounts < total,
                            message: 'Refresh in progress. Showing latest cached data.',
                        },
                    });
                }
                return res.status(200).json({
                    ok: false,
                    message: 'Refresh already in progress. Try again shortly.',
                });
            }
            return res.status(200).json({
                sequences: [],
                threshold: THRESHOLD,
                lastUpdated: null,
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

    // ── Default: instant cache read ─────────────────────────────────────
    try {
        const { data, source } = await getDashboardData();

        if (!data) {
            return res.status(200).json({
                sequences: [],
                threshold: THRESHOLD,
                lastUpdated: null,
                lastRefresh: null,
                _meta: { source },
            });
        }

        const lastRefresh = await kvGet(LAST_REFRESH_KEY);
        const totalMeta = Object.keys(data.metadata || {}).length;
        const totalCounts = Object.keys(data.sequences || {}).length;

        return res.status(200).json({
            ...buildDashboardResponse(data),
            lastRefresh,
            _meta: {
                source,
                total: totalMeta || totalCounts,
                fetched: totalCounts,
                partial: totalMeta > 0 && totalCounts < totalMeta,
            },
        });
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
