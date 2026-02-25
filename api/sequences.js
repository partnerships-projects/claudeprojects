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
                if (res.statusCode === 429) {
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
            const isTransient = err.message.includes('5') && err.message.includes('on /') || err.message.includes('Network') || err.message.includes('Timeout');
            if (!isTransient || attempt === retries) break;
            await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
        }
    }
    throw lastErr;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Fetch active sequences + stats ──────────────────────────────────────────

async function fetchSequencesWithStats() {
    const startTime = Date.now();
    const TIME_LIMIT = 50000; // 50s to leave room for response
    const elapsed = () => Date.now() - startTime;

    // Step 1: Fetch all sequences (paginated, 100 per page)
    const allSequences = [];
    let page = 1;

    while (elapsed() < 20000) { // max 20s for sequence listing
        let data;
        try {
            data = await apiCall('GET', `/v1/sequences?page=${page}`);
        } catch (err) {
            if (err.isRateLimit) break;
            throw err;
        }

        const items = Array.isArray(data.payload) ? data.payload : [];
        if (items.length === 0) break;
        allSequences.push(...items);
        if (items.length < 100) break; // last page
        page++;
        await sleep(1500);
    }

    // Step 2: Filter to active sequences only
    const activeSequences = allSequences.filter(seq => seq.active === true);

    // Step 3: Fetch stats for each active sequence via POST /v1/analytics/stats
    const results = [];
    let statsRateLimited = false;

    for (const seq of activeSequences) {
        if (elapsed() > TIME_LIMIT) break;

        let notContacted = null;
        let total = null;
        try {
            const stats = await apiCall('POST', '/v1/analytics/stats', { sequenceId: seq.id }, 2);
            const prospects = stats.payload?.prospects?.[0];
            if (prospects) {
                notContacted = Number(prospects.notContacted) || 0;
                total = Number(prospects.total) || 0;
            }
        } catch (err) {
            if (err.isRateLimit) {
                statsRateLimited = true;
                // Still add this sequence without stats, then stop fetching more
                results.push({
                    id: seq.id,
                    name: seq.title || `Sequence ${seq.id}`,
                    notContactedCount: null,
                    totalProspects: null,
                    client: seq.client?.companyName || null,
                });
                break;
            }
            // Non-rate-limit error: add sequence without stats, continue
        }

        results.push({
            id: seq.id,
            name: seq.title || `Sequence ${seq.id}`,
            notContactedCount: notContacted,
            totalProspects: total,
            client: seq.client?.companyName || null,
        });

        await sleep(1500); // respect rate limits
    }

    // Add remaining active sequences without stats if we ran out of time/got rate limited
    const fetchedIds = new Set(results.map(r => r.id));
    for (const seq of activeSequences) {
        if (!fetchedIds.has(seq.id)) {
            results.push({
                id: seq.id,
                name: seq.title || `Sequence ${seq.id}`,
                notContactedCount: null,
                totalProspects: null,
                client: seq.client?.companyName || null,
            });
        }
    }

    return {
        sequences: results,
        totalSequences: allSequences.length,
        activeCount: activeSequences.length,
        statsCompleted: results.filter(r => r.notContactedCount !== null).length,
        statsRateLimited,
        elapsedMs: elapsed(),
    };
}

// ── Vercel handler ───────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }

    if (!API_KEY) {
        res.status(500).json({
            error: 'SALESHANDY_API_KEY environment variable is not set.',
        });
        return;
    }

    try {
        // Debug: probe a specific endpoint
        if (req.query.debug === '1' && req.query.probe) {
            try {
                const data = req.query.method === 'POST'
                    ? await httpsRequest('POST', req.query.probe, JSON.parse(req.query.body || '{}'))
                    : await httpsRequest('GET', req.query.probe);
                return res.status(200).json({ _debug: true, endpoint: req.query.probe, raw: data });
            } catch (e) {
                return res.status(200).json({ _debug: true, endpoint: req.query.probe, error: e.message });
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
                activeCount: result.activeCount,
                statsCompleted: result.statsCompleted,
                statsRateLimited: result.statsRateLimited,
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
