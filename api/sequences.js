// ─────────────────────────────────────────────────────────────────────────────
// Vercel Serverless Function — SalesHandy Sequence Data
// ─────────────────────────────────────────────────────────────────────────────
//
// Two modes:
//   GET /api/sequences         → Instant read from Redis (never calls SalesHandy)
//   GET /api/sequences?fetch=1 → Fetch next batch of stats from SalesHandy,
//                                 save to Redis, return updated data.
//
// The frontend calls the fast endpoint first (instant page load), then
// fires ?fetch=1 in the background to progressively fill stats.
// ─────────────────────────────────────────────────────────────────────────────

const {
    API_KEY, THRESHOLD, KV_URL,
    kvGet, kvSet, sleep,
    fetchActiveSequenceList, fetchOneStat,
} = require('./_lib');

const CONCURRENCY = 20;            // parallel API calls at once
const WALL_CLOCK_LIMIT = 50000;    // stop fetching after 50s (Vercel limit = 60s)
const STATS_MAX_AGE = 3600 * 1000; // 1 hour — refetch stats after this
const REDIS_TTL = 7200;            // 2 hours — Redis key expiry (safety net)

// ── Build response from cached data ─────────────────────────────────────────

async function buildResponse(sequences, allStats) {
    const responseSequences = [];
    let pendingCount = 0;
    let skippedEmpty = 0;
    const now = Date.now();

    for (const seq of sequences) {
        const stats = allStats[seq.id];
        if (!stats || (now - stats.fetchedAt > STATS_MAX_AGE)) { pendingCount++; continue; }
        if (stats.notContacted < 1) { skippedEmpty++; continue; }
        responseSequences.push({
            id: seq.id,
            name: seq.name,
            notContactedCount: stats.notContacted,
            totalProspects: stats.total,
            contacted: stats.contacted,
            client: seq.client,
        });
    }

    return {
        sequences: responseSequences,
        activeInApi: sequences.length,
        pendingStats: pendingCount,
        skippedEmpty,
        lastUpdated: new Date().toISOString(),
    };
}

// ── Ensure sequence list + stats are in Redis ───────────────────────────────

async function getSequencesAndStats() {
    let sequences = KV_URL ? await kvGet('sh:sequences') : null;
    if (!sequences || sequences.length === 0) {
        sequences = await fetchActiveSequenceList();
        if (KV_URL && sequences.length > 0) {
            await kvSet('sh:sequences', sequences, REDIS_TTL);
        }
    }
    const allStats = KV_URL ? (await kvGet('sh:stats')) || {} : {};
    return { sequences, allStats };
}

// ── Fetch ALL stale stats in parallel (with wall-clock deadline) ─────────────

async function fetchAllStatsParallel(sequences, allStats) {
    const now = Date.now();
    const deadline = now + WALL_CLOCK_LIMIT;
    const stale = sequences.filter(s => {
        const cached = allStats[s.id];
        return !cached || (now - cached.fetchedAt > STATS_MAX_AGE);
    });

    if (stale.length === 0) return { fetched: 0, staleCount: 0, errorCount: 0, errors: [], timedOut: false };

    let fetched = 0;
    let errors = [];
    let timedOut = false;

    // Process in parallel chunks, save after each chunk
    for (let i = 0; i < stale.length; i += CONCURRENCY) {
        if (Date.now() > deadline) { timedOut = true; break; }

        const chunk = stale.slice(i, i + CONCURRENCY);
        const results = await Promise.all(chunk.map(seq => fetchOneStat(seq)));

        for (let j = 0; j < results.length; j++) {
            const r = results[j];
            if (r.ok) {
                allStats[r.id] = {
                    notContacted: r.notContacted,
                    total: r.total,
                    contacted: r.contacted,
                    fetchedAt: now,
                };
                fetched++;
            } else {
                if (errors.length < 5) errors.push({ id: r.id, error: r.error || 'unknown' });
            }
        }

        // Save progress to Redis after each chunk (so timeout doesn't lose work)
        if (KV_URL && fetched > 0) await kvSet('sh:stats', allStats, REDIS_TTL);
    }

    return { fetched, staleCount: stale.length, errorCount: errors.length, errors, timedOut };
}

// ── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }

    if (!API_KEY) {
        return res.status(500).json({ error: 'SALESHANDY_API_KEY not set.' });
    }

    // ?reset=1 — clear Redis cache and start fresh
    if (req.query.reset === '1' && KV_URL) {
        await Promise.all([kvSet('sh:response', null, 1), kvSet('sh:stats', null, 1), kvSet('sh:sequences', null, 1)]);
        return res.status(200).json({ ok: true, message: 'Cache cleared. Refresh the page.' });
    }

    // ?debug=1 — single-pass: fetch all pages, show breakdown + filtered result
    if (req.query.debug === '1') {
        const { shApi, extractItems, sleep: sl } = require('./_lib');
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
                await sl(300);
            } catch (err) {
                if (err.isRateLimit && retries < 3) {
                    retries++;
                    await sl(3000 * retries);
                    p--; // retry same page
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

    try {
        const { sequences, allStats } = await getSequencesAndStats();
        const wantsFetch = req.query.fetch === '1';

        // ── ?fetch=1 → fetch next batch of stats from SalesHandy ──
        let fetchMeta = {};
        if (wantsFetch) {
            fetchMeta = await fetchAllStatsParallel(sequences, allStats);
        }

        // ── Build response from current state ──
        const result = await buildResponse(sequences, allStats);

        // Save response snapshot to Redis
        if (KV_URL) await kvSet('sh:response', result, REDIS_TTL);

        res.setHeader('X-Cache', wantsFetch ? 'FETCH' : 'READ');
        res.status(200).json({
            sequences: result.sequences,
            threshold: THRESHOLD,
            lastUpdated: result.lastUpdated,
            _meta: {
                source: wantsFetch ? 'fetch' : 'cache',
                activeInApi: result.activeInApi,
                withStats: result.sequences.length,
                pendingStats: result.pendingStats,
                skippedEmpty: result.skippedEmpty,
                ...fetchMeta,
            },
        });
    } catch (err) {
        // Try to serve stale Redis data on error
        if (KV_URL) {
            try {
                const stale = await kvGet('sh:response');
                if (stale && stale.sequences) {
                    res.setHeader('X-Cache', 'ERROR-STALE');
                    return res.status(200).json({
                        sequences: stale.sequences,
                        threshold: THRESHOLD,
                        lastUpdated: stale.lastUpdated,
                        _meta: { source: 'redis-stale', error: err.message },
                    });
                }
            } catch {}
        }
        res.status(500).json({ error: err.message });
    }
};
