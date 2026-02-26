// ─────────────────────────────────────────────────────────────────────────────
// Vercel Cron — Background stats refresh
// ─────────────────────────────────────────────────────────────────────────────
//
// Runs every 5 minutes via Vercel Cron. Fetches SalesHandy stats in batches,
// stores results in Upstash Redis. The main /api/sequences endpoint reads
// from Redis and returns instantly.
//
// Each invocation fetches ~20 stats (limited by SalesHandy rate limits).
// After a few runs, all 136 sequences have cached stats.
// ─────────────────────────────────────────────────────────────────────────────

const { API_KEY, KV_URL, kvGet, kvSet, fetchActiveSequenceList, fetchOneStat, sleep } = require('./_lib');

const BATCH = 20;
const STATS_TTL = 3600;       // 1 hour — how long each stat stays valid
const DATA_TTL = 7200;        // 2 hours — Redis key TTL (safety net)

module.exports = async function handler(req, res) {
    if (!API_KEY) return res.status(500).json({ error: 'SALESHANDY_API_KEY not set' });
    if (!KV_URL) return res.status(500).json({ error: 'UPSTASH_REDIS_REST_URL not set' });

    const startTime = Date.now();

    try {
        // 1. Get sequence list (from Redis cache or fresh from API)
        let sequences = await kvGet('sh:sequences');
        if (!sequences || sequences.length === 0) {
            sequences = await fetchActiveSequenceList();
            if (sequences.length > 0) {
                await kvSet('sh:sequences', sequences, DATA_TTL);
            }
        }

        // 2. Get existing stats from Redis
        const allStats = (await kvGet('sh:stats')) || {};

        // 3. Find which sequences need fresh stats
        const now = Date.now();
        const stale = sequences.filter(s => {
            const cached = allStats[s.id];
            return !cached || (now - cached.fetchedAt > STATS_TTL * 1000);
        });

        // 4. Fetch in batches of 20, stop on rate limit
        let fetched = 0;
        let rateLimited = false;

        for (let i = 0; i < stale.length; i += BATCH) {
            const batch = stale.slice(i, i + BATCH);
            const results = await Promise.all(batch.map(seq => fetchOneStat(seq)));

            for (const r of results) {
                if (r.ok) {
                    allStats[r.id] = {
                        notContacted: r.notContacted,
                        total: r.total,
                        contacted: r.contacted,
                        fetchedAt: now,
                    };
                    fetched++;
                } else if (r.isRateLimit) {
                    rateLimited = true;
                }
            }

            if (rateLimited) break;
            if (i + BATCH < stale.length) await sleep(100);
        }

        // 5. Save updated stats back to Redis
        await kvSet('sh:stats', allStats, DATA_TTL);

        // 6. Build and cache the final response the frontend will read
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

        const cachedResponse = {
            sequences: responseSequences,
            activeInApi: sequences.length,
            pendingStats: pendingCount,
            skippedEmpty,
            lastUpdated: new Date().toISOString(),
        };
        await kvSet('sh:response', cachedResponse, DATA_TTL);

        res.status(200).json({
            ok: true,
            totalSequences: sequences.length,
            staleChecked: stale.length,
            statsFetched: fetched,
            rateLimited,
            pendingStats: pendingCount,
            withStats: responseSequences.length,
            elapsedMs: Date.now() - startTime,
        });
    } catch (err) {
        res.status(500).json({ error: err.message, elapsedMs: Date.now() - startTime });
    }
};
