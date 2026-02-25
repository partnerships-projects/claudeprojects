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

// ── In-memory cache (persists while the function instance is warm) ───────────

let cachedData = null;
let cacheTime = null;
const CACHE_TTL = 3 * 60 * 60 * 1000; // 3 hours

// ── HTTP helper with rate-limit awareness ────────────────────────────────────

function httpsGet(urlPath) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlPath, SALESHANDY_BASE);
        const options = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname + url.search,
            method: 'GET',
            headers: {
                'x-api-key': API_KEY,
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json',
            },
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                if (res.statusCode === 429 || (res.statusCode === 400 && body.includes('Rate Limit'))) {
                    reject(Object.assign(new Error('RATE_LIMITED'), { isRateLimit: true }));
                    return;
                }
                if (res.statusCode >= 400) {
                    let detail = body;
                    try { detail = JSON.stringify(JSON.parse(body), null, 2); } catch (_) {}
                    reject(new Error(`SalesHandy API ${res.statusCode} on ${urlPath}\n${detail}`));
                    return;
                }
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error(`Invalid JSON from ${urlPath}: ${body.slice(0, 200)}`)); }
            });
        });

        req.on('error', (err) => reject(new Error(`Network error on ${urlPath}: ${err.message}`)));
        req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Timeout on ${urlPath}`)); });
        req.end();
    });
}

async function apiGet(urlPath, retries = 3) {
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await httpsGet(urlPath);
        } catch (err) {
            lastErr = err;
            if (err.isRateLimit) {
                // Wait longer on rate limit: 3s, 6s, 12s
                const delay = Math.pow(2, attempt) * 1500;
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            const isTransient = err.message.includes('API 5') || err.message.includes('Network error') || err.message.includes('Timeout');
            if (!isTransient || attempt === retries) break;
            await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
        }
    }
    throw lastErr;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Sequence fetching (list only — no per-sequence detail calls) ─────────────

async function fetchAllSequences() {
    const allSequences = [];
    let page = 1;
    let rateLimited = false;
    const startTime = Date.now();
    const TIME_LIMIT = 45000; // stop fetching at 45s to leave room for response

    while (true) {
        // Safety: stop if we're running out of time
        if (Date.now() - startTime > TIME_LIMIT) break;

        let data;
        try {
            // SalesHandy API only accepts "page" — no other query params allowed
            data = await apiGet(`/v1/sequences?page=${page}`);
        } catch (err) {
            if (err.isRateLimit) {
                rateLimited = true;
                break; // stop gracefully, return what we have so far
            }
            throw err;
        }

        let items = null;
        for (const key of ['payload', 'data', 'sequences', 'items', 'results', 'list']) {
            if (Array.isArray(data[key])) { items = data[key]; break; }
        }
        if (!items) {
            for (const wrapKey of ['payload', 'data']) {
                if (data[wrapKey] && typeof data[wrapKey] === 'object') {
                    for (const key of ['list', 'sequences', 'items', 'results', 'data']) {
                        if (Array.isArray(data[wrapKey][key])) { items = data[wrapKey][key]; break; }
                    }
                    if (items) break;
                }
            }
        }
        if (!items && Array.isArray(data)) items = data;
        if (!items) items = [];

        if (items.length === 0) break;

        allSequences.push(...items);

        const totalPages =
            data.totalPages ?? data.total_pages ??
            data.payload?.totalPages ?? data.payload?.total_pages ??
            data.data?.totalPages ?? data.data?.total_pages ??
            data.meta?.totalPages ?? data.meta?.last_page ?? null;

        if (totalPages !== null && page >= totalPages) break;
        if (items.length < 20) break;
        if (page >= 200) break;
        page++;
        await sleep(2000); // 2 seconds between pages to respect rate limits
    }

    // Filter to only active sequences
    const active = allSequences.filter(seq => {
        if (seq.active === true) return true;
        if (seq.active === false) return false;
        const status = (seq.status || seq.state || '').toString().toLowerCase();
        const inactive = ['paused', 'stopped', 'archived', 'deleted', 'draft', 'disabled'];
        return !inactive.includes(status);
    });

    // Map to result format — use embedded counts if available, otherwise null
    const sequences = active.map(seq => {
        const id = seq.id ?? seq._id ?? seq.sequenceId;
        const name = seq.name ?? seq.title ?? seq.sequenceName ?? `Sequence ${id}`;

        // Try to extract count from embedded data
        const count = seq.notContactedCount
            ?? seq.not_contacted_count
            ?? seq.notContacted
            ?? seq.not_contacted
            ?? seq.prospects?.notContacted
            ?? seq.prospects?.not_contacted
            ?? seq.stats?.notContacted
            ?? seq.stats?.not_contacted
            ?? seq.prospectStats?.notContacted
            ?? seq.prospectStats?.not_contacted
            ?? null;

        return { id, name, notContactedCount: count !== null ? Number(count) : null };
    });

    return {
        sequences,
        totalFetched: allSequences.length,
        pagesFetched: page,
        rateLimited,
        partial: rateLimited || (Date.now() - startTime > TIME_LIMIT),
    };
}

// ── Vercel handler ───────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }

    if (!API_KEY) {
        res.status(500).json({
            error: 'SALESHANDY_API_KEY environment variable is not set. Add it in Vercel dashboard → Settings → Environment Variables.',
        });
        return;
    }

    try {
        // Debug mode: ?debug=1
        if (req.query.debug === '1') {
            const probe = req.query.probe;
            if (probe) {
                try {
                    const data = await apiGet(probe, 1);
                    return res.status(200).json({ _debug: true, endpoint: probe, raw: data });
                } catch (e) {
                    return res.status(200).json({ _debug: true, endpoint: probe, error: e.message });
                }
            }
            const listRaw = await apiGet('/v1/sequences?page=1', 1);
            return res.status(200).json({ _debug: true, raw: listRaw });
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

        const result = await fetchAllSequences();
        cachedData = result.sequences;
        cacheTime = Date.now();

        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=1800');
        res.setHeader('X-Cache', 'MISS');
        res.status(200).json({
            sequences: result.sequences,
            threshold: THRESHOLD,
            lastUpdated: new Date(cacheTime).toISOString(),
            _meta: {
                totalFetched: result.totalFetched,
                activeCount: result.sequences.length,
                pagesFetched: result.pagesFetched,
                partial: result.partial,
                rateLimited: result.rateLimited,
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
