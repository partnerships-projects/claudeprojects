// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers: SalesHandy API, Upstash Redis, config constants
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');

// ── Config ──────────────────────────────────────────────────────────────────

const SALESHANDY_BASE = 'https://leo-open-api-gateway.saleshandy.com';
const API_KEY = process.env.SALESHANDY_API_KEY || '';
const THRESHOLD = Number(process.env.THRESHOLD) || 2000;

const KV_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

// Redis keys
const CACHE_KEY = 'saleshandy:not_contacted:active_sequences';
const LOCK_KEY = 'saleshandy:refresh_lock';
const LAST_REFRESH_KEY = 'saleshandy:last_refresh';

// Timing / concurrency
const HTTP_TIMEOUT = 8000;       // 8s per API call
const CONCURRENCY = 5;           // max parallel requests to SalesHandy
const BATCH_DELAY = 250;         // ms pause between batches (200-300ms)
const CACHE_FRESH_MS = 3 * 60 * 1000;  // 3 minutes — data considered fresh
const LOCK_TTL = 180;            // 3 minutes — refresh lock expiry
const CACHE_TTL = 3600;          // 1 hour — Redis key safety-net expiry
const WALL_CLOCK_LIMIT = 50000;  // 50s — stop before Vercel 60s limit

// ── Utilities ───────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Generic HTTPS helper ────────────────────────────────────────────────────

function httpsRequest(method, url, body, headers = {}, timeout = HTTP_TIMEOUT) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const postData = body ? JSON.stringify(body) : null;
        const options = {
            hostname: parsed.hostname,
            port: 443,
            path: parsed.pathname + parsed.search,
            method,
            headers: { 'Content-Type': 'application/json', ...headers },
        };
        if (postData) options.headers['Content-Length'] = Buffer.byteLength(postData);

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => {
                if (res.statusCode === 429 || (res.statusCode === 400 && data.includes('Rate Limit'))) {
                    const err = new Error('RATE_LIMITED');
                    err.isRateLimit = true;
                    const ra = res.headers['retry-after'];
                    if (ra) {
                        const n = Number(ra);
                        err.retryAfterSec = !isNaN(n) ? n : null;
                    }
                    reject(err);
                    return;
                }
                if (res.statusCode >= 400) {
                    reject(new Error(`${method} ${res.statusCode}: ${data.slice(0, 200)}`));
                    return;
                }
                try { resolve(JSON.parse(data)); }
                catch { reject(new Error(`Invalid JSON from ${method} ${parsed.pathname}`)); }
            });
        });

        req.on('error', (err) => reject(new Error(`Network error: ${err.message}`)));
        req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Timeout')); });
        if (postData) req.write(postData);
        req.end();
    });
}

// ── SalesHandy API helper ───────────────────────────────────────────────────

function shApi(method, path, body) {
    return httpsRequest(method, SALESHANDY_BASE + path, body, {
        'x-api-key': API_KEY,
        'Authorization': `Bearer ${API_KEY}`,
    });
}

// ── Upstash Redis helpers (REST API, zero packages) ─────────────────────────

function redisCmd(cmd) {
    return httpsRequest('POST', KV_URL, cmd, {
        Authorization: `Bearer ${KV_TOKEN}`,
    });
}

async function kvGet(key) {
    if (!KV_URL) return null;
    try {
        const data = await redisCmd(['GET', key]);
        return data.result ? JSON.parse(data.result) : null;
    } catch { return null; }
}

async function kvSet(key, value, ttlSeconds) {
    if (!KV_URL) return;
    try {
        const cmd = ttlSeconds
            ? ['SET', key, JSON.stringify(value), 'EX', String(ttlSeconds)]
            : ['SET', key, JSON.stringify(value)];
        await redisCmd(cmd);
    } catch { /* best-effort */ }
}

async function kvDel(key) {
    if (!KV_URL) return;
    try { await redisCmd(['DEL', key]); } catch {}
}

// SET NX EX — acquire a lock (returns true if acquired, false if already held)
async function kvSetNX(key, value, ttlSeconds) {
    if (!KV_URL) return true; // no Redis = single-instance, always succeed
    try {
        const data = await redisCmd(
            ['SET', key, JSON.stringify(value), 'NX', 'EX', String(ttlSeconds)]
        );
        return data.result === 'OK';
    } catch { return false; }
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

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
    API_KEY, THRESHOLD, KV_URL,
    CACHE_KEY, LOCK_KEY, LAST_REFRESH_KEY,
    CONCURRENCY, BATCH_DELAY, CACHE_FRESH_MS, LOCK_TTL, CACHE_TTL, WALL_CLOCK_LIMIT,
    shApi, sleep,
    kvGet, kvSet, kvDel, kvSetNX,
    extractItems,
};
