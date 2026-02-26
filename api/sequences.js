// ─────────────────────────────────────────────────────────────────────────────
// Vercel Serverless Function — SalesHandy Sequence Data
// ─────────────────────────────────────────────────────────────────────────────
//
// With Redis (Upstash):
//   1. Read cached response from Redis → return instantly (< 100ms)
//   2. If data is stale, fetch new stats from SalesHandy → save to Redis
//   3. Each page load progressively fills the cache
//   4. Once all are cached, page loads are instant until stats expire (1hr)
//
// Without Redis:
//   Falls back to direct SalesHandy fetch with in-memory cache.
// ─────────────────────────────────────────────────────────────────────────────

const {
    API_KEY, THRESHOLD, KV_URL,
    kvGet, kvSet, sleep,
    fetchActiveSequenceList, fetchOneStat,
} = require('./_lib');

const STATS_PER_REQUEST = 5;        // fetch at most 5 stats per API call → fast responses
const STATS_MAX_AGE = 3600 * 1000;  // 1 hour — refetch stats after this
const REDIS_TTL = 7200;             // 2 hours — Redis key expiry (safety net)

// ── In-memory cache (fallback when Redis not configured) ─────────────────────

let memStats = {};
let memSeqList = [];

// ── Core: fetch stats from SalesHandy and save to Redis ──────────────────────

async function refreshStats() {
    const now = Date.now();

    // 1. Get sequence list (Redis → SalesHandy API)
    let sequences = KV_URL ? await kvGet('sh:sequences') : null;
    if (!sequences || sequences.length === 0) {
        sequences = await fetchActiveSequenceList();
        if (KV_URL && sequences.length > 0) {
            await kvSet('sh:sequences', sequences, REDIS_TTL);
        }
    }
    // Also keep in memory
    if (sequences.length > 0) { memSeqList = sequences; }

    // 2. Get existing stats (Redis → memory)
    let allStats = KV_URL ? (await kvGet('sh:stats')) || {} : memStats;

    // 3. Find stale/missing stats
    const stale = sequences.filter(s => {
        const cached = allStats[s.id];
        return !cached || (now - cached.fetchedAt > STATS_MAX_AGE);
    });

    // 4. Fetch ONE AT A TIME, capped to STATS_PER_REQUEST so the API
    //    responds fast (~10s). Frontend auto-refreshes to fill the rest.
    let fetched = 0;
    let rateLimitHits = 0;
    let errors = [];
    let errorCount = 0;

    for (let i = 0; i < stale.length && fetched < STATS_PER_REQUEST; i++) {
        const r = await fetchOneStat(stale[i]);

        if (r.ok) {
            allStats[r.id] = {
                notContacted: r.notContacted,
                total: r.total,
                contacted: r.contacted,
                fetchedAt: now,
            };
            fetched++;
        } else if (r.isRateLimit) {
            rateLimitHits++;
            await sleep(3000);  // wait 3s, then retry
            i--;                // retry this same sequence
            if (rateLimitHits > 3) break;  // give up after 3 rate limits
        } else {
            errorCount++;
            if (errors.length < 3) {
                errors.push({
                    id: r.id,
                    error: r.error || 'unknown',
                    rawPayload: r.rawPayload || null,
                });
            }
        }

        // Small delay between requests to avoid rate limits
        if (i < stale.length - 1) await sleep(600);
    }

    // 5. Save stats back
    if (KV_URL) {
        await kvSet('sh:stats', allStats, REDIS_TTL);
    }
    memStats = allStats;

    // 6. Build response
    const responseSequences = [];
    let pendingCount = 0;
    let skippedEmpty = 0;

    for (const seq of sequences) {
        const stats = allStats[seq.id];
        if (!stats) { pendingCount++; continue; }
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

    // 7. Cache full response in Redis for instant reads
    const cachedResponse = {
        sequences: responseSequences,
        activeInApi: sequences.length,
        pendingStats: pendingCount,
        skippedEmpty,
        lastUpdated: new Date().toISOString(),
    };
    if (KV_URL) {
        await kvSet('sh:response', cachedResponse, REDIS_TTL);
    }

    return {
        ...cachedResponse,
        source: KV_URL ? 'redis+fresh' : 'direct',
        statsFetched: fetched,
        rateLimitHits,
        staleChecked: stale.length,
        errorCount,
        errors,
    };
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

    try {
        // ── Fast path: serve from Redis if fully loaded and fresh ──
        if (KV_URL) {
            const cached = await kvGet('sh:response');
            if (cached && cached.sequences) {
                const age = Date.now() - new Date(cached.lastUpdated).getTime();
                const hasPending = (cached.pendingStats || 0) > 0;

                // Only use cache when ALL stats are loaded AND data is fresh (< 10 min).
                // If stats are still pending, fall through to refreshStats() to fetch more.
                if (!hasPending && age < 10 * 60 * 1000) {
                    res.setHeader('X-Cache', 'HIT');
                    return res.status(200).json({
                        sequences: cached.sequences,
                        threshold: THRESHOLD,
                        lastUpdated: cached.lastUpdated,
                        _meta: {
                            source: 'redis',
                            activeInApi: cached.activeInApi,
                            withStats: cached.sequences.length,
                            pendingStats: 0,
                            skippedEmpty: cached.skippedEmpty || 0,
                            ageSeconds: Math.round(age / 1000),
                        },
                    });
                }
            }
        }

        // ── Fetch next batch of stats (5 at a time) ──
        const result = await refreshStats();

        res.setHeader('X-Cache', 'MISS');
        res.status(200).json({
            sequences: result.sequences,
            threshold: THRESHOLD,
            lastUpdated: result.lastUpdated,
            _meta: {
                source: result.source,
                activeInApi: result.activeInApi,
                withStats: result.sequences.length,
                pendingStats: result.pendingStats,
                skippedEmpty: result.skippedEmpty,
                statsFetched: result.statsFetched,
                staleChecked: result.staleChecked,
                errorCount: result.errorCount,
                errors: result.errors,
                rateLimitHits: result.rateLimitHits,
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
