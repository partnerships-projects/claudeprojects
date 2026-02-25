// ─────────────────────────────────────────────────────────────────────────────
// Vercel Serverless Function — SalesHandy Sequence Data
// ─────────────────────────────────────────────────────────────────────────────
//
// Environment variables (set in Vercel dashboard):
//   SALESHANDY_API_KEY  — your SalesHandy API key (required)
//   THRESHOLD           — prospect count threshold (default: 2000)
//
// Returns JSON: { sequences, threshold, lastUpdated }
//
// Strategy:
//   1. Fetch all sequences, filter to active=true (~66 real + some ghost)
//   2. Fetch stats individually via POST /v1/analytics/stats
//   3. Progressive: each request fetches more stats, cache persists in memory
//   4. Only show sequences where notContacted > 0 (filters out ghost sequences)
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');

const SALESHANDY_BASE = 'https://leo-open-api-gateway.saleshandy.com';
const API_KEY = process.env.SALESHANDY_API_KEY || '';
const THRESHOLD = Number(process.env.THRESHOLD) || 2000;

// ── In-memory progressive cache ───────────────────────────────────────────
// These persist across requests on the SAME warm Vercel instance.

let cachedSeqList = [];        // active sequences from API [{id, name, client}]
let seqListFetchedAt = 0;

// Stats cache: { sequenceId: { notContacted, total, contacted, fetchedAt } }
// Ghost sequences get cached with notContacted=0, so we won't re-fetch them
let statsCache = {};

// Final response cache (short TTL — just to avoid hammering on rapid reloads)
let lastResponse = null;
let lastResponseAt = 0;
const RESPONSE_CACHE_TTL = 60 * 1000; // 1 minute

const SEQ_LIST_TTL = 15 * 60 * 1000;  // 15 min for sequence list
const STATS_TTL = 60 * 60 * 1000;     // 1 hour for individual stats

// ── HTTP helpers ────────────────────────────────────────────────────────────

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
                    let detail = responseBody;
                    try { detail = JSON.stringify(JSON.parse(responseBody), null, 2); } catch (_) {}
                    reject(new Error(`${method} ${res.statusCode} on ${urlPath}\n${detail}`));
                    return;
                }
                try { resolve(JSON.parse(responseBody)); }
                catch (e) { reject(new Error(`Invalid JSON from ${method} ${urlPath}`)); }
            });
        });

        req.on('error', (err) => reject(new Error(`Network error: ${err.message}`)));
        req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Timeout on ${method} ${urlPath}`)); });
        if (postData) req.write(postData);
        req.end();
    });
}

async function apiCall(method, urlPath, body, retries = 3) {
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await httpsRequest(method, urlPath, body);
        } catch (err) {
            lastErr = err;
            if (err.isRateLimit) {
                const delay = Math.pow(2, attempt) * 1500;
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            const isTransient = err.message.includes('Network') || err.message.includes('Timeout');
            if (!isTransient || attempt === retries) break;
            await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
        }
    }
    throw lastErr;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Fetch active sequence list (all pages) ────────────────────────────────

async function fetchActiveSequenceList(startTime) {
    const elapsed = () => Date.now() - startTime;
    const allSequences = [];
    let page = 1;
    let rateLimited = false;

    while (elapsed() < 25000) {
        let data;
        try {
            data = await apiCall('GET', `/v1/sequences?page=${page}`, null, 2);
        } catch (err) {
            if (err.isRateLimit) { rateLimited = true; break; }
            throw err;
        }

        const items = Array.isArray(data.payload) ? data.payload : [];
        if (items.length === 0) break;
        allSequences.push(...items);
        if (items.length < 100) break;
        page++;
        await sleep(1200);
    }

    const active = allSequences.filter(s => s.active === true);
    return {
        active: active.map(s => ({
            id: s.id,
            name: s.title || `Sequence ${s.id}`,
            client: s.client?.companyName || null,
        })),
        totalInApi: allSequences.length,
        pagesFetched: page,
        listRateLimited: rateLimited,
    };
}

// ── Fetch stats progressively ─────────────────────────────────────────────

async function fetchStatsProgressive(activeSequences, startTime) {
    const elapsed = () => Date.now() - startTime;
    const now = Date.now();

    // Which sequences need stats? (not cached or stale)
    const needStats = activeSequences.filter(s => {
        const cached = statsCache[s.id];
        if (!cached) return true;
        if (now - cached.fetchedAt > STATS_TTL) return true;
        return false;
    });

    let statsFetched = 0;
    let statsRateLimited = false;
    const alreadyCached = activeSequences.length - needStats.length;

    // Fetch stats one at a time with minimal delay
    const TIME_LIMIT = 50000; // leave 10s buffer for Vercel's 60s limit

    for (let i = 0; i < needStats.length; i++) {
        if (elapsed() > TIME_LIMIT || statsRateLimited) break;

        const seq = needStats[i];
        try {
            const stats = await apiCall('POST', '/v1/analytics/stats', { sequenceId: seq.id }, 2);
            const prospects = stats.payload?.prospects?.[0];
            statsCache[seq.id] = {
                notContacted: prospects ? (Number(prospects.notContacted) || 0) : 0,
                total: prospects ? (Number(prospects.total) || 0) : 0,
                contacted: prospects ? (Number(prospects.contacted) || 0) : 0,
                fetchedAt: now,
            };
            statsFetched++;
        } catch (err) {
            if (err.isRateLimit) {
                statsRateLimited = true;
                break;
            }
            // Mark as fetched with 0 so we don't keep retrying broken sequences
            statsCache[seq.id] = { notContacted: 0, total: 0, contacted: 0, fetchedAt: now };
        }

        // Delay between calls to avoid rate limit
        if (i < needStats.length - 1 && !statsRateLimited) {
            await sleep(1200);
        }
    }

    return { statsFetched, statsRateLimited, alreadyCached, totalNeeded: needStats.length };
}

// ── Build final results from stats cache ──────────────────────────────────

function buildResults(activeSequences) {
    const results = [];
    let pendingCount = 0;

    for (const seq of activeSequences) {
        const stats = statsCache[seq.id];
        if (!stats) {
            pendingCount++;
            continue;
        }
        if (stats.notContacted > 0) {
            results.push({
                id: seq.id,
                name: seq.name,
                notContactedCount: stats.notContacted,
                totalProspects: stats.total,
                contacted: stats.contacted,
                client: seq.client,
            });
        }
    }

    return { sequences: results, pendingCount };
}

// ── Main orchestrator ─────────────────────────────────────────────────────

async function fetchSequencesWithStats() {
    const startTime = Date.now();
    const elapsed = () => Date.now() - startTime;
    const now = Date.now();

    // Step 1: Get active sequences (use cached list if fresh)
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

    // Step 2: Fetch stats progressively (picks up where last request left off)
    const statsResult = await fetchStatsProgressive(activeSequences, startTime);

    // Step 3: Build results
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
                    sampleActiveSequences: cachedSeqList.slice(0, 10),
                    statsCacheSample: Object.fromEntries(
                        Object.entries(statsCache).slice(0, 5).map(([k, v]) => [k, { ...v, age: Math.round((Date.now() - v.fetchedAt) / 1000) + 's' }])
                    ),
                });
            } catch (e) {
                return res.status(200).json({ _debug: true, error: e.message });
            }
        }

        // Check short response cache (1 min) — prevents hammering on rapid reloads
        const fresh = req.query.fresh === '1';
        if (!fresh && lastResponse && (Date.now() - lastResponseAt < RESPONSE_CACHE_TTL)) {
            res.setHeader('X-Cache', 'HIT');
            return res.status(200).json(lastResponse);
        }

        // Fetch data (progressive — accumulates stats across warm requests)
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
        // If we have any cached data, serve it
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
