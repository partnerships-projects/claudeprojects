// ─────────────────────────────────────────────────────────────────────────────
// Vercel Serverless Function — SalesHandy Sequence Data
// ─────────────────────────────────────────────────────────────────────────────
//
// SalesHandy API rate-limits stats requests (~30 per window).
// Strategy: fetch what we can per call, cache progressively,
// frontend auto-refreshes every 60s to fill remaining stats.
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');

const SALESHANDY_BASE = 'https://leo-open-api-gateway.saleshandy.com';
const API_KEY = process.env.SALESHANDY_API_KEY || '';
const THRESHOLD = Number(process.env.THRESHOLD) || 2000;

const TIME_BUDGET = 50000;   // 50s (10s buffer for Vercel's 60s maxDuration)
const HTTP_TIMEOUT = 8000;
const BATCH_SIZE = 3;        // conservative — SalesHandy rate-limits aggressively
const BATCH_DELAY = 500;     // ms between batches

// ── In-memory progressive cache (persists on warm instances) ──────────────

let cachedSeqList = [];
let seqListFetchedAt = 0;
let statsCache = {};           // { seqId: { notContacted, total, contacted, fetchedAt } }
let lastResponse = null;
let lastResponseAt = 0;

const RESPONSE_CACHE_TTL = 30 * 1000;  // 30s
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
    let fetchError = null;
    let pageSize = 0;

    while (elapsed() < TIME_BUDGET - 5000) { // leave 5s buffer for stats
        let data;
        try {
            data = await httpsRequest('GET', `/v1/sequences?page=${page}`, null);
        } catch (err) {
            if (!fetchError) fetchError = err.message;
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
        if (page === 1) pageSize = items.length;
        allSequences.push(...items);
        // If we got fewer items than the first page, this is the last page
        if (pageSize > 0 && items.length < pageSize) break;
        if (page >= 100) break; // safety cap
        page++;
        await sleep(100); // fast pagination — rate limit mainly affects stats
    }

    // Filter: active boolean is the only reliable signal.
    // (status field is an object with email stats, NOT a string)
    const active = allSequences.filter(s => !!s.active);

    // Diagnostic: capture one raw sequence to see all fields
    const sample = allSequences[0];
    const sampleKeys = sample ? Object.keys(sample).filter(k => typeof sample[k] !== 'object') : [];
    const sampleScalars = {};
    for (const k of sampleKeys) sampleScalars[k] = sample[k];

    return {
        active: active.map(s => ({
            id: s.id || s._id || s.sequenceId,
            name: s.name || s.title || s.sequenceName || `Sequence ${s.id}`,
            client: s.client?.companyName || null,
        })),
        totalInApi: allSequences.length,
        pagesFetched: page,
        pageSize,
        listRateLimited: rateLimited,
        fetchError,
        _sampleSeq: sampleScalars,
    };
}

// ── Fetch one stat ──────────────────────────────────────────────────────

async function fetchOneStat(seq) {
    try {
        const stats = await httpsRequest('POST', '/v1/analytics/stats', { sequenceId: seq.id });
        // Response: { payload: { prospects: [{ total: "N", notContacted: "N", contacted: "N", ... }] } }
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
        }

        if (i + BATCH_SIZE < needStats.length && !rateLimited) {
            await sleep(BATCH_DELAY);
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
    let fetchError = null;

    let pageSize = 0;
    let sampleSeq = null;

    if (cachedSeqList.length > 0 && (now - seqListFetchedAt < SEQ_LIST_TTL)) {
        activeSequences = cachedSeqList;
    } else {
        const listResult = await fetchActiveSequenceList(startTime);
        activeSequences = listResult.active;
        totalInApi = listResult.totalInApi;
        pagesFetched = listResult.pagesFetched;
        pageSize = listResult.pageSize;
        listRateLimited = listResult.listRateLimited;
        fetchError = listResult.fetchError;
        sampleSeq = listResult._sampleSeq;
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
        pageSize,
        listRateLimited,
        fetchError,
        statsFetched: statsResult.statsFetched,
        alreadyCached: statsResult.alreadyCached,
        statsRateLimited: statsResult.statsRateLimited,
        pendingStats: pendingCount,
        elapsedMs: elapsed(),
        sampleSeq,
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

        // Short response cache
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
                pageSize: result.pageSize,
                elapsedMs: result.elapsedMs,
                fetchError: result.fetchError,
                sampleSeq: result.sampleSeq,
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
