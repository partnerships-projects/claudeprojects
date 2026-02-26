// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers: SalesHandy API + Upstash Redis
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');

const SALESHANDY_BASE = 'https://leo-open-api-gateway.saleshandy.com';
const API_KEY = process.env.SALESHANDY_API_KEY || '';
const THRESHOLD = Number(process.env.THRESHOLD) || 2000;

// Upstash Redis REST API (optional — falls back to in-memory if not set)
const KV_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

const HTTP_TIMEOUT = 8000;    // 8s per call — fail fast, retry next time

// ── Generic HTTPS helper ────────────────────────────────────────────────────

function httpsRequest(method, url, body, headers = {}, timeout = HTTP_TIMEOUT) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url.startsWith('http') ? url : url, url.startsWith('http') ? undefined : SALESHANDY_BASE);
        const postData = body ? JSON.stringify(body) : null;
        const options = {
            hostname: parsed.hostname,
            port: 443,
            path: parsed.pathname + parsed.search,
            method,
            headers: {
                'Content-Type': 'application/json',
                ...headers,
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
                    reject(new Error(`${method} ${res.statusCode}: ${responseBody.slice(0, 200)}`));
                    return;
                }
                try { resolve(JSON.parse(responseBody)); }
                catch (e) { reject(new Error(`Invalid JSON from ${method} ${parsed.pathname}`)); }
            });
        });

        req.on('error', (err) => reject(new Error(`Network error: ${err.message}`)));
        req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Timeout')); });
        if (postData) req.write(postData);
        req.end();
    });
}

function shApi(method, path, body) {
    return httpsRequest(method, SALESHANDY_BASE + path, body, {
        'x-api-key': API_KEY,
        'Authorization': `Bearer ${API_KEY}`,
    });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Upstash Redis helpers (REST API, zero packages) ─────────────────────────

async function kvGet(key) {
    if (!KV_URL) return null;
    try {
        const data = await httpsRequest('POST', `${KV_URL}`, ['GET', key], {
            Authorization: `Bearer ${KV_TOKEN}`,
        });
        return data.result ? JSON.parse(data.result) : null;
    } catch { return null; }
}

async function kvSet(key, value, ttlSeconds) {
    if (!KV_URL) return;
    try {
        const cmd = ttlSeconds
            ? ['SET', key, JSON.stringify(value), 'EX', String(ttlSeconds)]
            : ['SET', key, JSON.stringify(value)];
        await httpsRequest('POST', `${KV_URL}`, cmd, {
            Authorization: `Bearer ${KV_TOKEN}`,
        });
    } catch { /* silent fail — cache is best-effort */ }
}

// ── Extract items from SalesHandy API response ─────────────────────────────

function extractItems(data) {
    return Array.isArray(data.payload) ? data.payload
        : Array.isArray(data.data) ? data.data
        : Array.isArray(data.sequences) ? data.sequences
        : Array.isArray(data.items) ? data.items
        : Array.isArray(data.results) ? data.results
        : Array.isArray(data) ? data : [];
}

// ── Fetch active sequence list from SalesHandy ─────────────────────────────

async function fetchActiveSequenceList() {
    const allSequences = [];
    let page = 1;

    while (page <= 50) {
        let data;
        try {
            data = await shApi('GET', `/v1/sequences?page=${page}`, null);
        } catch (err) {
            break;
        }
        const items = extractItems(data);
        if (!Array.isArray(items) || items.length === 0) {
            // Page 1 might return a flat array
            if (page === 1 && Array.isArray(data) && data.length > 0) {
                allSequences.push(...data);
            }
            break;
        }
        allSequences.push(...items);

        // Respect totalPages if the API provides it
        const totalPages = data.totalPages ?? data.total_pages
            ?? data.meta?.totalPages ?? data.meta?.last_page ?? null;
        if (totalPages !== null && page >= totalPages) break;

        // Stop if we got fewer items than a typical page (API default ~20-25)
        if (items.length < 20) break;
        page++;
        await sleep(200);
    }

    // Permissive filter: include everything EXCEPT explicitly inactive
    const inactive = ['paused', 'stopped', 'archived', 'deleted', 'draft', 'disabled', 'completed', 'finished'];

    return allSequences
        .filter(s => {
            const status = (s.status || s.state || '').toString().toLowerCase();
            if (inactive.includes(status)) return false;
            return true;
        })
        .map(s => ({
            id: s.id || s._id || s.sequenceId,
            name: s.name || s.title || s.sequenceName || `Sequence ${s.id}`,
            client: s.client?.companyName || null,
        }));
}

// ── Fetch one stat from SalesHandy ──────────────────────────────────────────

async function fetchOneStat(seq) {
    try {
        const stats = await shApi('POST', '/v1/analytics/stats', { sequenceId: seq.id });
        const p = stats.payload?.prospects?.[0];
        if (!p) {
            // API returned OK but unexpected shape — log it for debugging
            return {
                id: seq.id, ok: false, isRateLimit: false,
                error: 'No prospects data. Keys: ' + Object.keys(stats.payload || stats).join(','),
                rawPayload: JSON.stringify(stats).slice(0, 300),
            };
        }
        return {
            id: seq.id,
            notContacted: Number(p.notContacted) || 0,
            total: Number(p.total) || 0,
            contacted: Number(p.contacted) || 0,
            ok: true,
        };
    } catch (err) {
        return { id: seq.id, isRateLimit: !!err.isRateLimit, ok: false, error: err.message };
    }
}

module.exports = {
    API_KEY, THRESHOLD, KV_URL,
    shApi, httpsRequest, sleep,
    kvGet, kvSet,
    extractItems, fetchActiveSequenceList, fetchOneStat,
};
