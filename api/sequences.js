// ─────────────────────────────────────────────────────────────────────────────
// Vercel Serverless Function — SalesHandy Sequence Data
// ─────────────────────────────────────────────────────────────────────────────
//
// Environment variables (set in Vercel dashboard):
//   SALESHANDY_API_KEY  — your SalesHandy API key (required)
//   THRESHOLD           — prospect count threshold (default: 2000)
//
// Returns JSON: { sequences, threshold, lastUpdated }
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');

const SALESHANDY_BASE = 'https://leo-open-api-gateway.saleshandy.com';
const API_KEY = process.env.SALESHANDY_API_KEY || '';
const THRESHOLD = Number(process.env.THRESHOLD) || 2000;

// ── In-memory cache ─────────────────────────────────────────────────────────

let cachedData = null;
let cacheTime = null;
const CACHE_TTL = 3 * 60 * 60 * 1000; // 3 hours

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
                // SalesHandy returns rate limits as 400 (not 429)
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

// ── Fetch all sequences + batch stats ───────────────────────────────────────

async function fetchSequencesWithStats() {
    const startTime = Date.now();
    const elapsed = () => Date.now() - startTime;

    // Step 1: Fetch ALL sequences across all pages
    const allSequences = [];
    let page = 1;

    while (elapsed() < 25000) { // max 25s for listing
        let data;
        try {
            data = await apiCall('GET', `/v1/sequences?page=${page}`, null, 2);
        } catch (err) {
            if (err.isRateLimit) break;
            throw err;
        }

        const items = Array.isArray(data.payload) ? data.payload : [];
        if (items.length === 0) break;
        allSequences.push(...items);
        if (items.length < 100) break;
        page++;
        await sleep(1500);
    }

    // Build a map of sequence info by ID
    const seqMap = {};
    for (const seq of allSequences) {
        seqMap[seq.id] = {
            id: seq.id,
            name: seq.title || `Sequence ${seq.id}`,
            client: seq.client?.companyName || null,
            apiActive: seq.active,
        };
    }

    // Step 2: Fetch stats for each sequence using individual POST /v1/analytics/stats
    // (consolidated-stats format is unknown, individual stats are proven to work)
    const results = [];
    let statsRateLimited = false;
    let statsFetched = 0;

    // Get all sequence IDs (fetch stats for ALL, not just active=true)
    const allIds = allSequences.map(s => s.id);

    for (const id of allIds) {
        if (elapsed() > 50000) break; // leave 10s for response

        try {
            const stats = await apiCall('POST', '/v1/analytics/stats', { sequenceId: id }, 2);
            const prospects = stats.payload?.prospects?.[0];
            const notContacted = prospects ? (Number(prospects.notContacted) || 0) : 0;
            const total = prospects ? (Number(prospects.total) || 0) : 0;
            const contacted = prospects ? (Number(prospects.contacted) || 0) : 0;
            statsFetched++;

            // Only include sequences that have prospects (not contacted > 0)
            if (notContacted > 0) {
                results.push({
                    id,
                    name: seqMap[id]?.name || stats.payload?.sequenceName || `Sequence ${id}`,
                    notContactedCount: notContacted,
                    totalProspects: total,
                    contacted,
                    client: seqMap[id]?.client || stats.payload?.client?.companyName || null,
                });
            }
        } catch (err) {
            if (err.isRateLimit) {
                statsRateLimited = true;
                break;
            }
            // Skip sequences that error (deleted, etc.)
        }

        await sleep(1500);
    }

    return {
        sequences: results,
        totalSequences: allSequences.length,
        statsFetched,
        statsRateLimited,
        pagesFetched: page,
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
                // Default debug: try consolidated-stats to discover its format
                const listData = await apiCall('GET', '/v1/sequences?page=1', null, 2);
                const sampleIds = (listData.payload || []).slice(0, 3).map(s => s.id);
                const bodies = [
                    { sequenceIds: sampleIds },
                    { ids: sampleIds },
                    { sequences: sampleIds },
                    {},
                ];
                const probeResults = {};
                for (const body of bodies) {
                    const key = JSON.stringify(body);
                    try {
                        const data = await httpsRequest('POST', '/v1/analytics/consolidated-stats', body);
                        probeResults[key] = { status: 'OK', data };
                    } catch (e) {
                        probeResults[key] = { status: 'ERROR', message: e.message.slice(0, 300) };
                    }
                    await sleep(1500);
                }
                return res.status(200).json({ _debug: true, consolidatedStatsProbe: probeResults });
            } catch (e) {
                return res.status(200).json({ _debug: true, error: e.message });
            }
        }

        // Normal mode — use cache if available
        const fresh = req.query.fresh === '1';

        if (!fresh && cachedData && cacheTime && (Date.now() - cacheTime < CACHE_TTL)) {
            res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=1800');
            res.setHeader('X-Cache', 'HIT');
            return res.status(200).json({
                sequences: cachedData,
                threshold: THRESHOLD,
                lastUpdated: new Date(cacheTime).toISOString(),
            });
        }

        const result = await fetchSequencesWithStats();
        cachedData = result.sequences;
        cacheTime = Date.now();

        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=1800');
        res.setHeader('X-Cache', 'MISS');
        res.status(200).json({
            sequences: result.sequences,
            threshold: THRESHOLD,
            lastUpdated: new Date(cacheTime).toISOString(),
            _meta: {
                totalSequences: result.totalSequences,
                statsFetched: result.statsFetched,
                resultsShown: result.sequences.length,
                statsRateLimited: result.statsRateLimited,
                pagesFetched: result.pagesFetched,
                elapsedMs: result.elapsedMs,
            },
        });
    } catch (err) {
        if (cachedData) {
            res.setHeader('X-Cache', 'STALE');
            return res.status(200).json({
                sequences: cachedData,
                threshold: THRESHOLD,
                lastUpdated: cacheTime ? new Date(cacheTime).toISOString() : null,
                warning: 'Serving cached data — live fetch failed: ' + err.message,
            });
        }
        res.status(500).json({ error: err.message });
    }
};
