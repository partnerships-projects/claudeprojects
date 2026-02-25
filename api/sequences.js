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
//   1. Fetch all sequences, filter to active=true (~134 out of ~1100)
//   2. Try POST /v1/analytics/consolidated-stats for batch stats
//   3. Fall back to individual POST /v1/analytics/stats calls
//   4. Progressive caching: fetch what we can in 45s, cache it,
//      continue fetching remaining stats on next request
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');

const SALESHANDY_BASE = 'https://leo-open-api-gateway.saleshandy.com';
const API_KEY = process.env.SALESHANDY_API_KEY || '';
const THRESHOLD = Number(process.env.THRESHOLD) || 2000;

// ── In-memory progressive cache ───────────────────────────────────────────

let cachedSequences = [];      // final results with stats
let cachedSeqList = [];        // raw active sequences from API (id, title, client)
let statsCache = {};           // { sequenceId: { notContacted, total, contacted, fetchedAt } }
let cacheTime = null;
const CACHE_TTL = 3 * 60 * 60 * 1000;    // 3 hours for full cache
const STATS_TTL = 2 * 60 * 60 * 1000;    // 2 hours for individual stats
const SEQ_LIST_TTL = 30 * 60 * 1000;     // 30 min for sequence list

let seqListFetchedAt = null;

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
        await sleep(1500);
    }

    // Filter to active sequences only (active=true)
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

// ── Try consolidated-stats batch endpoint ─────────────────────────────────

async function tryConsolidatedStats(sequenceIds) {
    // Try different body formats — we don't know the exact format yet
    const formats = [
        { sequenceIds },
        { ids: sequenceIds },
        { sequences: sequenceIds },
    ];

    for (const body of formats) {
        try {
            const data = await httpsRequest('POST', '/v1/analytics/consolidated-stats', body);
            // If we get here, it worked! Parse the response
            if (data.payload) {
                return { success: true, data, bodyFormat: body };
            }
        } catch (err) {
            if (err.isRateLimit) throw err;
            // Try next format
        }
        await sleep(500);
    }

    return { success: false };
}

// ── Fetch stats for sequences (progressive) ──────────────────────────────

async function fetchStatsProgressive(activeSequences, startTime) {
    const elapsed = () => Date.now() - startTime;
    const now = Date.now();

    // Determine which sequences need fresh stats
    const needStats = activeSequences.filter(s => {
        const cached = statsCache[s.id];
        if (!cached) return true;
        if (now - cached.fetchedAt > STATS_TTL) return true;
        return false;
    });

    // Sort: sequences without any cached stats first
    needStats.sort((a, b) => {
        const aHas = statsCache[a.id] ? 1 : 0;
        const bHas = statsCache[b.id] ? 1 : 0;
        return aHas - bHas;
    });

    let statsFetched = 0;
    let statsRateLimited = false;
    let statsSkipped = activeSequences.length - needStats.length;

    // Try consolidated-stats first (only if we have many to fetch)
    if (needStats.length > 5 && elapsed() < 30000) {
        try {
            const batchIds = needStats.slice(0, 50).map(s => s.id);
            const result = await tryConsolidatedStats(batchIds);
            if (result.success && result.data.payload) {
                // Parse batch response — try common structures
                const payload = result.data.payload;
                let parsed = 0;

                // If payload is an array of stats
                if (Array.isArray(payload)) {
                    for (const item of payload) {
                        const seqId = item.sequenceId || item.id;
                        const prospects = item.prospects?.[0] || item;
                        if (seqId) {
                            statsCache[seqId] = {
                                notContacted: Number(prospects.notContacted) || 0,
                                total: Number(prospects.total) || 0,
                                contacted: Number(prospects.contacted) || 0,
                                fetchedAt: now,
                            };
                            parsed++;
                        }
                    }
                }
                // If payload is an object with sequence IDs as keys
                else if (typeof payload === 'object') {
                    for (const [key, val] of Object.entries(payload)) {
                        if (val && typeof val === 'object') {
                            const prospects = val.prospects?.[0] || val;
                            statsCache[key] = {
                                notContacted: Number(prospects.notContacted) || 0,
                                total: Number(prospects.total) || 0,
                                contacted: Number(prospects.contacted) || 0,
                                fetchedAt: now,
                            };
                            parsed++;
                        }
                    }
                }

                if (parsed > 0) {
                    statsFetched += parsed;
                    // Remove successfully fetched from needStats
                    const fetched = new Set(Object.keys(statsCache).filter(id =>
                        statsCache[id].fetchedAt === now
                    ));
                    const remaining = needStats.filter(s => !fetched.has(s.id));
                    needStats.length = 0;
                    needStats.push(...remaining);
                }
            }
        } catch (err) {
            if (err.isRateLimit) {
                statsRateLimited = true;
            }
            // Consolidated stats didn't work, fall back to individual
        }
    }

    // Fall back to individual stats calls for remaining sequences
    // Use concurrent fetching: 2 at a time with staggered delays
    const CONCURRENT = 2;
    const DELAY_BETWEEN_BATCHES = 1800; // ms between batch starts
    const TIME_LIMIT = 50000; // leave 10s buffer for Vercel

    for (let i = 0; i < needStats.length && !statsRateLimited; i += CONCURRENT) {
        if (elapsed() > TIME_LIMIT) break;

        const batch = needStats.slice(i, i + CONCURRENT);
        const promises = batch.map(async (seq) => {
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
                }
                // Skip sequences that error (deleted, etc.)
            }
        });

        await Promise.all(promises);
        if (i + CONCURRENT < needStats.length && !statsRateLimited) {
            await sleep(DELAY_BETWEEN_BATCHES);
        }
    }

    return { statsFetched, statsRateLimited, statsSkipped };
}

// ── Build final results from cache ────────────────────────────────────────

function buildResults(activeSequences) {
    const withStats = [];
    const pending = [];

    for (const seq of activeSequences) {
        const stats = statsCache[seq.id];
        if (!stats) {
            // No stats yet — include as pending
            pending.push({
                id: seq.id,
                name: seq.name,
                notContactedCount: null,
                totalProspects: null,
                contacted: null,
                client: seq.client,
                statsPending: true,
            });
            continue;
        }

        // Only include sequences with notContacted > 0 (filters ghost/deleted)
        if (stats.notContacted > 0) {
            withStats.push({
                id: seq.id,
                name: seq.name,
                notContactedCount: stats.notContacted,
                totalProspects: stats.total,
                contacted: stats.contacted,
                client: seq.client,
            });
        }
    }

    return { withStats, pending };
}

// ── Main fetch orchestrator ───────────────────────────────────────────────

async function fetchSequencesWithStats() {
    const startTime = Date.now();
    const elapsed = () => Date.now() - startTime;
    const now = Date.now();

    // Step 1: Get active sequences list (use cached list if fresh enough)
    let activeSequences;
    let totalInApi = 0;
    let pagesFetched = 0;

    let listRateLimited = false;

    if (cachedSeqList.length > 0 && seqListFetchedAt && (now - seqListFetchedAt < SEQ_LIST_TTL)) {
        activeSequences = cachedSeqList;
        totalInApi = cachedSeqList.length; // approximate
    } else {
        const listResult = await fetchActiveSequenceList(startTime);
        activeSequences = listResult.active;
        totalInApi = listResult.totalInApi;
        pagesFetched = listResult.pagesFetched;
        listRateLimited = listResult.listRateLimited;
        // Only cache if we got some data
        if (activeSequences.length > 0) {
            cachedSeqList = activeSequences;
            seqListFetchedAt = now;
        }
    }

    // Step 2: Fetch stats progressively
    const statsResult = await fetchStatsProgressive(activeSequences, startTime);

    // Step 3: Build results from whatever stats we have
    const { withStats: sequences, pending } = buildResults(activeSequences);

    return {
        sequences,
        pendingSequences: pending,
        activeSequences: activeSequences.length,
        totalInApi,
        pagesFetched,
        listRateLimited,
        statsFetched: statsResult.statsFetched,
        statsFromCache: statsResult.statsSkipped,
        statsRateLimited: statsResult.statsRateLimited,
        pendingStats: pending.length,
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
        // Debug: probe any endpoint
        if (req.query.debug === '1') {
            try {
                const probe = req.query.probe;
                if (probe) {
                    const method = req.query.method === 'POST' ? 'POST' : 'GET';
                    const body = req.query.body ? JSON.parse(req.query.body) : null;
                    const data = await httpsRequest(method, probe, body);
                    return res.status(200).json({ _debug: true, endpoint: probe, raw: data });
                }
                // Default debug: probe consolidated-stats with sample IDs
                const listData = await apiCall('GET', '/v1/sequences?page=1', null, 2);
                const sampleIds = (listData.payload || []).filter(s => s.active).slice(0, 3).map(s => s.id);
                const probeResults = {};
                const bodies = [
                    { sequenceIds: sampleIds },
                    { ids: sampleIds },
                    { sequences: sampleIds },
                    { sequenceId: sampleIds[0] },
                ];
                for (const body of bodies) {
                    const key = JSON.stringify(body);
                    try {
                        const data = await httpsRequest('POST', '/v1/analytics/consolidated-stats', body);
                        probeResults[key] = { status: 'OK', data };
                    } catch (e) {
                        probeResults[key] = { status: 'ERROR', message: e.message.slice(0, 500) };
                    }
                    await sleep(1500);
                }
                return res.status(200).json({
                    _debug: true,
                    sampleIds,
                    consolidatedStatsProbe: probeResults,
                    cacheStatus: {
                        cachedSequences: cachedSequences.length,
                        cachedSeqList: cachedSeqList.length,
                        statsCacheEntries: Object.keys(statsCache).length,
                    },
                });
            } catch (e) {
                return res.status(200).json({ _debug: true, error: e.message });
            }
        }

        // Normal mode — use full cache if available and fresh
        const fresh = req.query.fresh === '1';

        if (!fresh && cachedSequences.length > 0 && cacheTime && (Date.now() - cacheTime < CACHE_TTL)) {
            res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=1800');
            res.setHeader('X-Cache', 'HIT');
            return res.status(200).json({
                sequences: cachedSequences,
                threshold: THRESHOLD,
                lastUpdated: new Date(cacheTime).toISOString(),
            });
        }

        const result = await fetchSequencesWithStats();

        // Combine: sequences with stats + pending sequences (without stats yet)
        const allSequences = [...result.sequences, ...result.pendingSequences];
        cachedSequences = allSequences;
        cacheTime = Date.now();

        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=1800');
        res.setHeader('X-Cache', 'MISS');
        res.status(200).json({
            sequences: allSequences,
            threshold: THRESHOLD,
            lastUpdated: new Date(cacheTime).toISOString(),
            _meta: {
                activeSequences: result.activeSequences,
                totalInApi: result.totalInApi,
                statsFetched: result.statsFetched,
                statsFromCache: result.statsFromCache,
                withStats: result.sequences.length,
                listRateLimited: result.listRateLimited,
                statsRateLimited: result.statsRateLimited,
                pendingStats: result.pendingStats,
                pagesFetched: result.pagesFetched,
                elapsedMs: result.elapsedMs,
            },
        });
    } catch (err) {
        if (cachedSequences.length > 0) {
            res.setHeader('X-Cache', 'STALE');
            return res.status(200).json({
                sequences: cachedSequences,
                threshold: THRESHOLD,
                lastUpdated: cacheTime ? new Date(cacheTime).toISOString() : null,
                warning: 'Serving cached data — live fetch failed: ' + err.message,
            });
        }
        res.status(500).json({ error: err.message });
    }
};
