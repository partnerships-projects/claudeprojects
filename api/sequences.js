// ─────────────────────────────────────────────────────────────────────────────
// Vercel Serverless Function — Serve sequence data
// ─────────────────────────────────────────────────────────────────────────────
//
// FAST PATH: Reads pre-built response from Upstash Redis (< 100ms).
// The /api/cron endpoint refreshes the data every 5 minutes in the background.
//
// FALLBACK: If Redis isn't configured or is empty, fetches directly from
// SalesHandy API (slower, rate-limited, progressive loading).
// ─────────────────────────────────────────────────────────────────────────────

const {
    API_KEY, THRESHOLD, KV_URL,
    kvGet, kvSet, sleep,
    fetchActiveSequenceList, fetchOneStat,
} = require('./_lib');

// ── In-memory fallback cache (only used when Redis is not configured) ────────

let memCache = { sequences: [], activeInApi: 0, pendingStats: 0, lastUpdated: null };
let memStats = {};
let memSeqList = [];
let memSeqListAt = 0;

// ── Fallback: direct SalesHandy fetch (old behavior) ────────────────────────

async function fallbackFetch() {
    const now = Date.now();

    // Reuse sequence list for 15 min
    if (memSeqList.length === 0 || now - memSeqListAt > 15 * 60 * 1000) {
        const fresh = await fetchActiveSequenceList();
        if (fresh.length > 0) {
            memSeqList = fresh;
            memSeqListAt = now;
        }
    }

    // Fetch stats in batches — stop on rate limit
    const needStats = memSeqList.filter(s => !memStats[s.id] || now - memStats[s.id].fetchedAt > 3600000);
    let fetched = 0;
    const BATCH = 20;

    for (let i = 0; i < needStats.length; i += BATCH) {
        const batch = needStats.slice(i, i + BATCH);
        const results = await Promise.all(batch.map(seq => fetchOneStat(seq)));
        let hitLimit = false;
        for (const r of results) {
            if (r.ok) {
                memStats[r.id] = { notContacted: r.notContacted, total: r.total, contacted: r.contacted, fetchedAt: now };
                fetched++;
            } else if (r.isRateLimit) { hitLimit = true; }
        }
        if (hitLimit) break;
        if (i + BATCH < needStats.length) await sleep(100);
    }

    // Build response
    const sequences = [];
    let pendingCount = 0;
    for (const seq of memSeqList) {
        const stats = memStats[seq.id];
        if (!stats) { pendingCount++; continue; }
        if (stats.notContacted < 1) continue;
        sequences.push({
            id: seq.id, name: seq.name,
            notContactedCount: stats.notContacted,
            totalProspects: stats.total,
            contacted: stats.contacted,
            client: seq.client,
        });
    }

    return {
        sequences,
        activeInApi: memSeqList.length,
        pendingStats: pendingCount,
        lastUpdated: new Date().toISOString(),
        source: 'direct',
        statsFetched: fetched,
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

    try {
        let response;

        if (KV_URL) {
            // ── Fast path: read from Redis ──
            const cached = await kvGet('sh:response');
            if (cached && cached.sequences && cached.sequences.length > 0) {
                response = {
                    sequences: cached.sequences,
                    threshold: THRESHOLD,
                    lastUpdated: cached.lastUpdated,
                    _meta: {
                        source: 'redis',
                        activeInApi: cached.activeInApi,
                        withStats: cached.sequences.length,
                        pendingStats: cached.pendingStats || 0,
                        skippedEmpty: cached.skippedEmpty || 0,
                    },
                };
                res.setHeader('X-Cache', 'HIT');
                return res.status(200).json(response);
            }

            // Redis is empty (first deploy, or cron hasn't run yet).
            // Trigger a cron run inline, then return what we get.
            const cronUrl = `https://${req.headers.host}/api/cron`;
            try {
                // Fire and forget — don't wait for it to finish
                fetch(cronUrl).catch(() => {});
            } catch {}

            // Meanwhile, fall back to direct fetch
        }

        // ── Fallback: direct SalesHandy fetch ──
        const result = await fallbackFetch();
        response = {
            sequences: result.sequences,
            threshold: THRESHOLD,
            lastUpdated: result.lastUpdated,
            _meta: {
                source: result.source,
                activeInApi: result.activeInApi,
                withStats: result.sequences.length,
                pendingStats: result.pendingStats,
                statsFetched: result.statsFetched,
            },
        };

        res.setHeader('X-Cache', 'MISS');
        res.status(200).json(response);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};
