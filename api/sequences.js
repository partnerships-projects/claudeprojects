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
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// ── HTTP helper ──────────────────────────────────────────────────────────────

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
                'Content-Type': 'application/json',
            },
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
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
            const isTransient = err.message.includes('API 5') || err.message.includes('Network error') || err.message.includes('Timeout');
            if (!isTransient || attempt === retries) break;
            await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
        }
    }
    throw lastErr;
}

// ── Sequence fetching ────────────────────────────────────────────────────────

async function fetchAllSequences() {
    const allSequences = [];
    let page = 1;

    while (true) {
        const data = await apiGet(`/v1/sequences?page=${page}`);
        const items = data.data || data.sequences || data.items || data.results || [];

        if (!Array.isArray(items) || items.length === 0) {
            if (page === 1 && Array.isArray(data) && data.length > 0) {
                allSequences.push(...data);
            }
            break;
        }

        allSequences.push(...items);
        const totalPages = data.totalPages ?? data.total_pages ?? data.meta?.totalPages ?? data.meta?.last_page ?? null;
        if (totalPages !== null && page >= totalPages) break;
        if (items.length < 20) break; // stop if fewer than a typical page size
        if (page >= 50) break;
        page++;
    }

    // Filter out clearly inactive sequences
    const inactive = ['paused', 'stopped', 'archived', 'deleted', 'draft', 'disabled'];
    const active = allSequences.filter(seq => {
        const status = (seq.status || seq.state || '').toString().toLowerCase();
        return !inactive.includes(status);
    });

    // Extract not-contacted counts
    const results = [];

    for (const seq of active) {
        const id = seq.id ?? seq._id ?? seq.sequenceId;
        const name = seq.name ?? seq.title ?? seq.sequenceName ?? `Sequence ${id}`;

        // Try embedded count first
        let count = seq.notContactedCount
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

        // If not embedded, fetch from detail endpoint
        if (count === null || count === undefined) {
            try {
                const detail = await apiGet(`/v1/sequences/${id}`);
                const s = detail.data || detail;
                count = s.notContactedCount ?? s.not_contacted_count
                    ?? s.notContacted ?? s.not_contacted
                    ?? s.prospects?.notContacted ?? s.prospects?.not_contacted
                    ?? s.stats?.notContacted ?? s.stats?.not_contacted
                    ?? s.prospectStats?.notContacted ?? s.prospectStats?.not_contacted
                    ?? null;
            } catch (_) {}
        }

        // Try prospect list endpoint as last resort
        if (count === null || count === undefined) {
            for (const status of ['NOT_CONTACTED', 'notContacted', 'not_contacted']) {
                try {
                    const data = await apiGet(`/v1/sequences/${id}/prospects?status=${status}`);
                    const total = data.total ?? data.totalCount ?? data.total_count
                        ?? data.meta?.total ?? data.pagination?.total;
                    if (total !== null && total !== undefined) { count = Number(total); break; }
                } catch (_) {}
            }
        }

        results.push({ id, name, notContactedCount: count !== null ? Number(count) : null });
    }

    return results;
}

// ── Vercel handler ───────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
    // CORS headers
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
        // Debug mode: return raw API response to diagnose structure
        if (req.query.debug === '1') {
            const raw = await apiGet('/v1/sequences?page=1');
            return res.status(200).json({
                _debug: true,
                topLevelKeys: Object.keys(raw),
                rawSample: JSON.stringify(raw).slice(0, 3000),
            });
        }

        const fresh = req.query.fresh === '1';

        // Use cache if available and not expired
        if (!fresh && cachedData && cacheTime && (Date.now() - cacheTime < CACHE_TTL)) {
            res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
            res.setHeader('X-Cache', 'HIT');
            return res.status(200).json({
                sequences: cachedData,
                threshold: THRESHOLD,
                lastUpdated: new Date(cacheTime).toISOString(),
            });
        }

        const sequences = await fetchAllSequences();
        cachedData = sequences;
        cacheTime = Date.now();

        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
        res.setHeader('X-Cache', 'MISS');
        res.status(200).json({
            sequences,
            threshold: THRESHOLD,
            lastUpdated: new Date(cacheTime).toISOString(),
        });
    } catch (err) {
        // Serve stale cache on error
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
