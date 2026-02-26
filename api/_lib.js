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

const HTTP_TIMEOUT = 5000;

// ── Generic HTTPS helper ────────────────────────────────────────────────────

function httpsRequest(method, url, body, headers = {}) {
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
        req.setTimeout(HTTP_TIMEOUT, () => { req.destroy(); reject(new Error('Timeout')); });
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

    while (page <= 10) {
        let data;
        try {
            data = await shApi('GET', `/v1/sequences?page=${page}&pageSize=1000`, null);
        } catch (err) {
            break;
        }
        const items = extractItems(data);
        if (items.length === 0) break;
        allSequences.push(...items);
        if (items.length < 1000) break;
        page++;
        await sleep(200);
    }

    return allSequences
        .filter(s => s.progress === 1)
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
        return {
            id: seq.id,
            notContacted: p ? (Number(p.notContacted) || 0) : 0,
            total: p ? (Number(p.total) || 0) : 0,
            contacted: p ? (Number(p.contacted) || 0) : 0,
            ok: true,
        };
    } catch (err) {
        return { id: seq.id, isRateLimit: !!err.isRateLimit, ok: false };
    }
}

module.exports = {
    API_KEY, THRESHOLD, KV_URL,
    shApi, httpsRequest, sleep,
    kvGet, kvSet,
    extractItems, fetchActiveSequenceList, fetchOneStat,
};
