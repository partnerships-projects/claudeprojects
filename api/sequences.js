// ─────────────────────────────────────────────────────────────────────────────
// Vercel Serverless Function — SalesHandy Sequence Data
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');

const SALESHANDY_BASE = 'https://leo-open-api-gateway.saleshandy.com';
const API_KEY = process.env.SALESHANDY_API_KEY || '';
const THRESHOLD = Number(process.env.THRESHOLD) || 2000;

// Time budget: 50s (10s buffer for Vercel's 60s maxDuration)
const TIME_BUDGET = 50000;
const HTTP_TIMEOUT = 8000;
const BATCH_SIZE = 10; // concurrent stats requests per batch

// ── In-memory progressive cache (persists on warm instances) ──────────────

let cachedSeqList = [];
let seqListFetchedAt = 0;
let statsCache = {};           // { seqId: { notContacted, total, contacted, fetchedAt } }
let lastResponse = null;
let lastResponseAt = 0;

const RESPONSE_CACHE_TTL = 45 * 1000;  // 45s — prevents double-fetching on rapid reload
const SEQ_LIST_TTL = 15 * 60 * 1000;   // 15 min
const STATS_TTL = 60 * 60 * 1000;      // 1 hour

// ── HTTP helper ─────────────────────────────────────────────────────────────

function httpsRequest(method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlPath, SALESHANDY_BASE);
        const postData = body ? JSON.stringify(body) : null;
        const options = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname + url.search,
            method,
            headers: {
                'x-api-key': API_KEY,
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json',
            },
        };
        if (postData) options.headers['Content-Length'] = Buffer.byteLength(postData);

        const req = https.request(options, (res) => {
            let responseBody = '';
            res.on('data', (chunk) => responseBody += chunk);
            res.on('end', () => {
                if (res.statusCode === 429 || (res.statusCode === 400 && responseBody.includes('Rate Limit'))) {
                    reject(Object.assign(new Error('RATE_LIMITED'), { isRateLimit: true }));
                    return;
                }
                if (res.statusCode >= 400) {
                    reject(new Error(`${method} ${res.statusCode} on ${urlPath}`));
                    return;
                }
                try { resolve(JSON.parse(responseBody)); }
                catch (e) { reject(new Error(`Invalid JSON from ${method} ${urlPath}`)); }
            });
        });

        req.on('error', (err) => reject(new Error(`Network error: ${err.message}`)));
        req.setTimeout(HTTP_TIMEOUT, () => { req.destroy(); reject(new Error('Timeout')); });
        if (postData) req.write(postData);
        req.end();
    });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Fetch active sequence list ────────────────────────────────────────────

async function fetchActiveSequenceList(startTime) {
    const elapsed = () => Date.now() - startTime;
    const allSequences = [];
    let page = 1;
    let rateLimited = false;

    while (elapsed() < TIME_BUDGET / 2) { // use at most half the budget for pagination
        let data;
        try {
            data = await httpsRequest('GET', `/v1/sequences?page=${page}`, null);
        } catch (err) {
            if (err.isRateLimit) { rateLimited = true; break; }
            break;
        }

        const items = Array.isArray(data.payload) ? data.payload
            : Array.isArray(data.data) ? data.data
            : Array.isArray(data.sequences) ? data.sequences
            : Array.isArray(data.items) ? data.items
            : Array.isArray(data.results) ? data.results
            : Array.isArray(data) ? data : [];
        if (items.length === 0) break;
        allSequences.push(...items);
        if (items.length < 20) break;
        page++;
        await sleep(200);
    }

    // Use loose truthiness — API returns active:1 (number) not active:true (boolean)
    const active = allSequences.filter(s => !!s.active);
    return {
        active: active.map(s => ({
            id: s.id,
            name: s.name || s.title || `Sequence ${s.id}`,
            client: s.client?.companyName || null,
        })),
        totalInApi: allSequences.length,
        pagesFetched: page,
        listRateLimited: rateLimited,
    };
}

// ── Fetch one stat (no retry — just fail fast) ───────────────────────────

async function fetchOneStat(seq) {
    try {
        const stats = await httpsRequest('POST', '/v1/analytics/stats', { sequenceId: seq.id });
        const prospects = stats.payload?.prospects?.[0];
        return {
            id: seq.id,
            notContacted: prospects ? (Number(prospects.notContacted) || 0) : 0,
            total: prospects ? (Number(prospects.total) || 0) : 0,
            contacted: prospects ? (Number(prospects.contacted) || 0) : 0,
            ok: true,
        };
    } catch (err) {
        return { id: seq.id, isRateLimit: !!err.isRateLimit, ok: false };
    }
}

// ── Fetch stats in parallel batches ──────────────────────────────────────

async function fetchStatsParallel(activeSequences, startTime) {
    const elapsed = () => Date.now() - startTime;
    const now = Date.now();

    const needStats = activeSequences.filter(s => {
        const cached = statsCache[s.id];
        if (!cached) return true;
        if (now - cached.fetchedAt > STATS_TTL) return true;
        return false;
    });

    let fetched = 0;
    let rateLimited = false;

    // Process in batches of BATCH_SIZE
    for (let i = 0; i < needStats.length; i += BATCH_SIZE) {
        if (elapsed() > TIME_BUDGET || rateLimited) break;

        const batch = needStats.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(seq => fetchOneStat(seq)));

        for (const r of results) {
            if (r.ok) {
                statsCache[r.id] = {
                    notContacted: r.notContacted,
                    total: r.total,
                    contacted: r.contacted,
                    fetchedAt: now,
                };
                fetched++;
            } else if (r.isRateLimit) {
                rateLimited = true;
            }
            // If failed for other reasons, don't cache — will retry next request
        }

        // Small delay between batches to avoid rate limits
        if (i + BATCH_SIZE < needStats.length && !rateLimited) {
            await sleep(150);
        }
    }

    return {
        statsFetched: fetched,
        statsRateLimited: rateLimited,
        alreadyCached: activeSequences.length - needStats.length,
        totalNeeded: needStats.length,
    };
}

// ── Build results from cache ──────────────────────────────────────────────

function buildResults(activeSequences) {
    const sequences = [];
    let pendingCount = 0;

    for (const seq of activeSequences) {
        const stats = statsCache[seq.id];
        if (!stats) { pendingCount++; continue; }
        sequences.push({
            id: seq.id,
            name: seq.name,
            notContactedCount: stats.notContacted,
            totalProspects: stats.total,
            contacted: stats.contacted,
            client: seq.client,
        });
    }

    return { sequences, pendingCount };
}

// ── Main orchestrator ─────────────────────────────────────────────────────

async function fetchSequencesWithStats() {
    const startTime = Date.now();
    const elapsed = () => Date.now() - startTime;
    const now = Date.now();

    let activeSequences;
    let totalInApi = 0;
    let pagesFetched = 0;
    let listRateLimited = false;

    if (cachedSeqList.length > 0 && (now - seqListFetchedAt < SEQ_LIST_TTL)) {
        activeSequences = cachedSeqList;
    } else {
        const listResult = await fetchActiveSequenceList(startTime);
        activeSequences = listResult.active;
        totalInApi = listResult.totalInApi;
        pagesFetched = listResult.pagesFetched;
        listRateLimited = listResult.listRateLimited;
        if (activeSequences.length > 0) {
            cachedSeqList = activeSequences;
            seqListFetchedAt = now;
        }
    }

    const statsResult = await fetchStatsParallel(activeSequences, startTime);
    const { sequences, pendingCount } = buildResults(activeSequences);

    return {
        sequences,
        activeInApi: activeSequences.length,
        totalInApi,
        pagesFetched,
        listRateLimited,
        statsFetched: statsResult.statsFetched,
        alreadyCached: statsResult.alreadyCached,
        statsRateLimited: statsResult.statsRateLimited,
        pendingStats: pendingCount,
        elapsedMs: elapsed(),
    };
}

// ── Vercel handler ───────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }

    if (!API_KEY) {
        return res.status(500).json({ error: 'SALESHANDY_API_KEY not set.' });
    }

    try {
        // Debug endpoint
        if (req.query.debug === '1') {
            try {
                const probe = req.query.probe;
                if (probe) {
                    const method = req.query.method === 'POST' ? 'POST' : 'GET';
                    const body = req.query.body ? JSON.parse(req.query.body) : null;
                    const data = await httpsRequest(method, probe, body);
                    return res.status(200).json({ _debug: true, endpoint: probe, raw: data });
                }
                return res.status(200).json({
                    _debug: true,
                    cacheStatus: {
                        cachedSeqListLength: cachedSeqList.length,
                        seqListAge: seqListFetchedAt ? Math.round((Date.now() - seqListFetchedAt) / 1000) + 's' : 'none',
                        statsCacheEntries: Object.keys(statsCache).length,
                        lastResponseAge: lastResponseAt ? Math.round((Date.now() - lastResponseAt) / 1000) + 's' : 'none',
                    },
                });
            } catch (e) {
                return res.status(200).json({ _debug: true, error: e.message });
            }
        }

        // Short response cache — prevents hammering on rapid reload
        const fresh = req.query.fresh === '1';
        if (!fresh && lastResponse && (Date.now() - lastResponseAt < RESPONSE_CACHE_TTL)) {
            res.setHeader('X-Cache', 'HIT');
            return res.status(200).json(lastResponse);
        }

        const result = await fetchSequencesWithStats();

        const response = {
            sequences: result.sequences,
            threshold: THRESHOLD,
            lastUpdated: new Date().toISOString(),
            _meta: {
                activeInApi: result.activeInApi,
                totalInApi: result.totalInApi,
                statsFetched: result.statsFetched,
                alreadyCached: result.alreadyCached,
                withStats: result.sequences.length,
                listRateLimited: result.listRateLimited,
                statsRateLimited: result.statsRateLimited,
                pendingStats: result.pendingStats,
                pagesFetched: result.pagesFetched,
                elapsedMs: result.elapsedMs,
            },
        };

        lastResponse = response;
        lastResponseAt = Date.now();

        res.setHeader('X-Cache', 'MISS');
        res.status(200).json(response);
    } catch (err) {
        if (lastResponse) {
            res.setHeader('X-Cache', 'STALE');
            return res.status(200).json({
                ...lastResponse,
                warning: 'Serving cached data — live fetch failed: ' + err.message,
            });
        }
        res.status(500).json({ error: err.message });
    }
};
