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

// ── Count extraction helpers ──────────────────────────────────────────────────

/**
 * Unwrap common API envelope layers: payload, data, sequence, result, etc.
 * Returns an array of candidate objects to search for count fields.
 */
function unwrapAll(raw) {
    const candidates = [raw];
    if (raw && typeof raw === 'object') {
        // Common wrapper keys
        for (const key of ['payload', 'data', 'sequence', 'result', 'item', 'record']) {
            if (raw[key] && typeof raw[key] === 'object') {
                candidates.push(raw[key]);
                // Two levels deep
                for (const key2 of ['payload', 'data', 'sequence', 'result']) {
                    if (raw[key][key2] && typeof raw[key][key2] === 'object') {
                        candidates.push(raw[key][key2]);
                    }
                }
            }
        }
    }
    return candidates;
}

/**
 * Try to extract the "not contacted" count from an object by checking
 * every plausible field name and nested path.
 */
function extractNotContactedCount(obj) {
    if (!obj || typeof obj !== 'object') return null;

    // Direct field names (camelCase and snake_case variants)
    const directFields = [
        'notContactedCount', 'not_contacted_count',
        'notContacted', 'not_contacted',
        'pendingCount', 'pending_count',
        'notStartedCount', 'not_started_count',
        'newCount', 'new_count',
        'queuedCount', 'queued_count',
        'totalNotContacted', 'total_not_contacted',
        'uncontactedCount', 'uncontacted_count',
        'uncontacted',
    ];

    for (const f of directFields) {
        if (obj[f] !== undefined && obj[f] !== null) return Number(obj[f]);
    }

    // Nested stat objects
    const nestedKeys = [
        'stats', 'prospectStats', 'prospects', 'statusCounts', 'statusCount',
        'prospectCounts', 'prospectCount', 'counts', 'analytics', 'metrics',
        'sequenceStats', 'sequenceProspectStats', 'prospectStatus',
        'prospectStatusCounts', 'prospectStatusCount',
    ];
    const nestedFields = [
        'notContacted', 'not_contacted', 'notContactedCount', 'not_contacted_count',
        'NOT_CONTACTED', 'pending', 'pending_count', 'new', 'new_count',
        'queued', 'notStarted', 'not_started',
    ];

    for (const nk of nestedKeys) {
        const nested = obj[nk];
        if (nested && typeof nested === 'object') {
            for (const nf of nestedFields) {
                if (nested[nf] !== undefined && nested[nf] !== null) return Number(nested[nf]);
            }
        }
    }

    return null;
}

/**
 * Extract total count from a prospect-list API response.
 * Handles payload/data wrappers and many field name variants.
 */
function extractTotal(raw) {
    const candidates = unwrapAll(raw);
    const totalFields = ['total', 'totalCount', 'total_count', 'count', 'totalRecords', 'total_records'];
    for (const obj of candidates) {
        for (const f of totalFields) {
            if (obj[f] !== undefined && obj[f] !== null && !isNaN(obj[f])) {
                return Number(obj[f]);
            }
        }
        // Also check pagination sub-objects
        for (const pk of ['meta', 'pagination', 'paging', 'pageInfo']) {
            if (obj[pk] && typeof obj[pk] === 'object') {
                for (const f of totalFields) {
                    if (obj[pk][f] !== undefined && obj[pk][f] !== null) return Number(obj[pk][f]);
                }
            }
        }
    }
    return null;
}

// ── Sequence fetching ────────────────────────────────────────────────────────

async function fetchAllSequences() {
    const allSequences = [];
    let page = 1;

    while (true) {
        const data = await apiGet(`/v1/sequences?page=${page}`);

        let items = null;
        // Check if payload/data is a direct array
        for (const key of ['payload', 'data', 'sequences', 'items', 'results', 'list']) {
            if (Array.isArray(data[key])) { items = data[key]; break; }
        }
        // If payload is an object with a nested array
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
        // Last resort: top-level array
        if (!items && Array.isArray(data)) items = data;
        if (!items) items = [];

        if (items.length === 0) break;

        allSequences.push(...items);

        // Detect last page
        const totalPages =
            data.totalPages ?? data.total_pages ??
            data.payload?.totalPages ?? data.payload?.total_pages ??
            data.data?.totalPages ?? data.data?.total_pages ??
            data.meta?.totalPages ?? data.meta?.last_page ?? null;

        if (totalPages !== null && page >= totalPages) break;
        if (items.length < 20) break; // fewer than typical page size → last page
        if (page >= 50) break;
        page++;
    }

    // Filter out clearly inactive sequences
    const inactive = ['paused', 'stopped', 'archived', 'deleted', 'draft', 'disabled'];
    const active = allSequences.filter(seq => {
        const status = (seq.status || seq.state || '').toString().toLowerCase();
        return !inactive.includes(status);
    });

    // Extract not-contacted counts — fetch details in parallel (max 5 at a time)
    async function getSequenceCount(seq) {
        const id = seq.id ?? seq._id ?? seq.sequenceId;
        const name = seq.name ?? seq.title ?? seq.sequenceName ?? `Sequence ${id}`;

        // Strategy 1: try embedded count in the list item itself
        for (const obj of unwrapAll(seq)) {
            const count = extractNotContactedCount(obj);
            if (count !== null) return { id, name, notContactedCount: count };
        }

        // Strategy 2: fetch sequence detail endpoint
        for (const path of [`/v1/sequences/${id}`, `/v1/sequence/${id}`]) {
            try {
                const detail = await apiGet(path, 1);
                for (const obj of unwrapAll(detail)) {
                    const count = extractNotContactedCount(obj);
                    if (count !== null) return { id, name, notContactedCount: count };
                }
            } catch (_) {}
        }

        // Strategy 3: dedicated statistics / analytics endpoint
        for (const path of [
            `/v1/sequences/${id}/statistics`,
            `/v1/sequences/${id}/stats`,
            `/v1/sequences/${id}/analytics`,
            `/v1/sequences/${id}/prospect-stats`,
            `/v1/sequences/${id}/prospect-count`,
            `/v1/sequences/${id}/prospect-status-count`,
        ]) {
            try {
                const stat = await apiGet(path, 1);
                for (const obj of unwrapAll(stat)) {
                    const count = extractNotContactedCount(obj);
                    if (count !== null) return { id, name, notContactedCount: count };
                }
            } catch (_) {}
        }

        // Strategy 4: prospect list endpoint with status filter
        const statusValues = ['NOT_CONTACTED', 'notContacted', 'not_contacted', 'NOT CONTACTED', '0', 'new', 'pending'];
        for (const status of statusValues) {
            try {
                const raw = await apiGet(`/v1/sequences/${id}/prospects?status=${encodeURIComponent(status)}&limit=1`, 1);
                const total = extractTotal(raw);
                if (total !== null) return { id, name, notContactedCount: total };
            } catch (_) {}
        }

        return { id, name, notContactedCount: null };
    }

    const results = [];
    const BATCH_SIZE = 5;
    for (let i = 0; i < active.length; i += BATCH_SIZE) {
        const batch = active.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(batch.map(getSequenceCount));
        results.push(...batchResults);
    }

    return results;
}

// ── Debug helper ──────────────────────────────────────────────────────────────

/**
 * Recursively collect all leaf paths and values in an object,
 * up to maxDepth levels.  Returns an array of "path: value" strings.
 */
function flattenKeys(obj, prefix = '', depth = 0, maxDepth = 4) {
    const lines = [];
    if (!obj || typeof obj !== 'object' || depth > maxDepth) {
        lines.push(`${prefix}: ${JSON.stringify(obj)}`);
        return lines;
    }
    for (const [k, v] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            lines.push(...flattenKeys(v, path, depth + 1, maxDepth));
        } else if (Array.isArray(v)) {
            lines.push(`${path}: [Array(${v.length})]`);
            if (v.length > 0 && v[0] && typeof v[0] === 'object') {
                lines.push(...flattenKeys(v[0], `${path}[0]`, depth + 1, maxDepth));
            }
        } else {
            lines.push(`${path}: ${JSON.stringify(v)}`);
        }
    }
    return lines;
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
        // ── Debug mode ───────────────────────────────────────────────────────
        // Usage: ?debug=1              → dump first-page sequence list + first sequence detail
        //        ?debug=1&probe=PATH   → probe a specific SalesHandy API path
        if (req.query.debug === '1') {
            const probe = req.query.probe;
            if (probe) {
                try {
                    const data = await apiGet(probe, 1);
                    return res.status(200).json({
                        _debug: true,
                        endpoint: probe,
                        flatKeys: flattenKeys(data),
                        raw: data,
                    });
                } catch (e) {
                    return res.status(200).json({ _debug: true, endpoint: probe, error: e.message });
                }
            }

            // Default debug: show full structure of first sequence + its detail
            const listRaw = await apiGet('/v1/sequences?page=1', 1);

            // Find first sequence
            let firstSeq = null;
            for (const key of ['payload', 'data', 'sequences', 'items', 'results', 'list']) {
                if (Array.isArray(listRaw[key]) && listRaw[key].length > 0) {
                    firstSeq = listRaw[key][0];
                    break;
                }
                if (listRaw[key] && typeof listRaw[key] === 'object') {
                    for (const k2 of ['list', 'sequences', 'items', 'data', 'results']) {
                        if (Array.isArray(listRaw[key][k2]) && listRaw[key][k2].length > 0) {
                            firstSeq = listRaw[key][k2][0];
                            break;
                        }
                    }
                    if (firstSeq) break;
                }
            }
            if (!firstSeq && Array.isArray(listRaw) && listRaw.length > 0) firstSeq = listRaw[0];

            const result = {
                _debug: true,
                listResponseFlatKeys: flattenKeys(listRaw),
                firstSequenceFlatKeys: firstSeq ? flattenKeys(firstSeq) : null,
                firstSequence: firstSeq,
            };

            // Try fetching detail for first sequence
            if (firstSeq) {
                const id = firstSeq.id ?? firstSeq._id ?? firstSeq.sequenceId;
                try {
                    const detail = await apiGet(`/v1/sequences/${id}`, 1);
                    result.detailFlatKeys = flattenKeys(detail);
                    result.detailRaw = detail;
                } catch (e) {
                    result.detailError = e.message;
                }

                // Try prospects endpoint
                try {
                    const prospects = await apiGet(`/v1/sequences/${id}/prospects?status=NOT_CONTACTED&limit=1`, 1);
                    result.prospectsNotContactedFlatKeys = flattenKeys(prospects);
                    result.prospectsNotContactedRaw = prospects;
                } catch (e) {
                    result.prospectsError = e.message;
                }
            }

            return res.status(200).json(result);
        }

        // ── Normal mode ──────────────────────────────────────────────────────
        const fresh = req.query.fresh === '1';

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
