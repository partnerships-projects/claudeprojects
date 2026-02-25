#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// SalesHandy — Uncontacted Prospects Server
// ─────────────────────────────────────────────────────────────────────────────
//
// Usage:
//   node server.js
//
// Then share the URL with your team:
//   http://<your-ip>:8080
//
// No dependencies — uses only built-in Node.js modules (Node 18+).
// ─────────────────────────────────────────────────────────────────────────────

const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

// ── Load .env file ──────────────────────────────────────────────────────────
try {
    const envPath = path.join(__dirname, '.env');
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx === -1) continue;
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
    }
} catch (_) { /* no .env file — use existing env vars */ }

const PORT = process.env.PORT || 8080;
const SALESHANDY_BASE = 'https://leo-open-api-gateway.saleshandy.com';
const API_KEY = (process.env.SALESHANDY_API_KEY || '').trim();
const THRESHOLD = Number(process.env.THRESHOLD) || 2000;

// ── Proxy helper ─────────────────────────────────────────────────────────────

function proxySaleshandy(targetPath, res) {
    const url = new URL(targetPath, SALESHANDY_BASE);

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

    const proxyReq = https.request(options, (proxyRes) => {
        let body = '';
        proxyRes.on('data', (chunk) => body += chunk);
        proxyRes.on('end', () => {
            res.writeHead(proxyRes.statusCode, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(body);
        });
    });

    proxyReq.on('error', (err) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
    });

    proxyReq.end();
}

// ── HTML page ────────────────────────────────────────────────────────────────

function getHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Saleshandy — Sequence Uncontacted Prospects</title>
    <style>
        :root {
            --bg-primary: #0f1117;
            --bg-secondary: #1a1d29;
            --bg-card: #1e2235;
            --bg-card-hover: #252a40;
            --border: #2a2f45;
            --text-primary: #e8eaf0;
            --text-secondary: #8b8fa3;
            --text-muted: #5c6078;
            --accent-blue: #4f8df5;
            --accent-green: #34d399;
            --accent-red: #f87171;
            --accent-yellow: #fbbf24;
            --accent-purple: #a78bfa;
            --accent-cyan: #22d3ee;
            --accent-orange: #fb923c;
            --row-red-bg: rgba(248, 113, 113, 0.10);
            --row-red-border: rgba(248, 113, 113, 0.25);
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
            background: var(--bg-primary); color: var(--text-primary);
            min-height: 100vh; line-height: 1.5;
        }
        .page { max-width: 1100px; margin: 0 auto; padding: 40px 32px; }
        .header {
            display: flex; align-items: flex-start; justify-content: space-between;
            margin-bottom: 32px; padding-bottom: 20px; border-bottom: 1px solid var(--border);
        }
        .header h1 { font-size: 26px; font-weight: 700; letter-spacing: -0.4px; }
        .header p { color: var(--text-secondary); font-size: 13px; margin-top: 4px; }
        .header-right { display: flex; gap: 10px; align-items: center; }
        .date-badge {
            background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px;
            padding: 8px 16px; font-size: 13px; color: var(--text-secondary); white-space: nowrap;
        }
        .btn {
            padding: 10px 24px; border: none; border-radius: 8px; font-size: 14px;
            font-weight: 600; cursor: pointer; transition: background 0.15s, opacity 0.15s;
        }
        .btn-primary { background: var(--accent-blue); color: #fff; }
        .btn-primary:hover { opacity: 0.88; }
        .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
        .summary-strip {
            display: flex; gap: 8px; margin-bottom: 28px; background: var(--bg-secondary);
            border-radius: 12px; padding: 16px 20px; border: 1px solid var(--border);
        }
        .summary-item { flex: 1; text-align: center; padding: 0 12px; border-right: 1px solid var(--border); }
        .summary-item:last-child { border-right: none; }
        .summary-item .label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 4px; }
        .summary-item .value { font-size: 24px; font-weight: 700; }
        .card {
            background: var(--bg-card); border: 1px solid var(--border);
            border-radius: 14px; padding: 24px; margin-bottom: 28px;
        }
        .card-title {
            font-size: 13px; font-weight: 600; color: var(--text-secondary);
            text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 16px;
        }
        .warning-label {
            font-size: 15px; font-weight: 700; color: var(--accent-red);
            margin-bottom: 14px; display: flex; align-items: center; gap: 8px;
        }
        .warning-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent-red); display: inline-block; }
        .data-table { width: 100%; border-collapse: collapse; }
        .data-table th {
            text-align: left; font-size: 11px; color: var(--text-muted); text-transform: uppercase;
            letter-spacing: 0.6px; padding: 10px 14px; border-bottom: 1px solid var(--border); font-weight: 600;
        }
        .data-table td { padding: 13px 14px; font-size: 14px; border-bottom: 1px solid rgba(42, 47, 69, 0.5); }
        .data-table tbody tr:hover { background: rgba(79, 141, 245, 0.04); }
        .data-table .num { font-variant-numeric: tabular-nums; font-weight: 600; text-align: right; }
        .data-table .seq-name { font-weight: 500; }
        .data-table tr.row-red { background: var(--row-red-bg); }
        .data-table tr.row-red td { color: var(--accent-red); border-bottom-color: var(--row-red-border); }
        .data-table tr.row-red:hover { background: rgba(248, 113, 113, 0.15); }
        .status-bar {
            padding: 12px 18px; border-radius: 10px; font-size: 13px;
            margin-bottom: 24px; display: none;
        }
        .status-bar.info { display: block; background: rgba(79, 141, 245, 0.10); border: 1px solid rgba(79, 141, 245, 0.25); color: var(--accent-blue); }
        .status-bar.error { display: block; background: rgba(248, 113, 113, 0.10); border: 1px solid rgba(248, 113, 113, 0.25); color: var(--accent-red); }
        .status-bar.success { display: block; background: rgba(52, 211, 153, 0.10); border: 1px solid rgba(52, 211, 153, 0.25); color: var(--accent-green); }
        .loader { display: none; justify-content: center; padding: 40px 0; }
        .loader.active { display: flex; }
        .spinner { width: 32px; height: 32px; border: 3px solid var(--border); border-top-color: var(--accent-blue); border-radius: 50%; animation: spin 0.7s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .hidden { display: none !important; }
        .auto-refresh { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-muted); }
        .auto-refresh select {
            background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 6px;
            color: var(--text-primary); padding: 4px 8px; font-size: 12px; outline: none;
        }
        .last-updated { font-size: 12px; color: var(--text-muted); margin-top: 6px; }
        @media (max-width: 768px) {
            .page { padding: 20px 16px; }
            .header { flex-direction: column; gap: 12px; }
            .summary-strip { flex-direction: column; }
            .summary-item { border-right: none; border-bottom: 1px solid var(--border); padding: 10px 0; }
            .summary-item:last-child { border-bottom: none; }
        }
    </style>
</head>
<body>
<div class="page">
    <div class="header">
        <div>
            <h1>Sequence — Uncontacted Prospects</h1>
            <p>Active Saleshandy sequences &amp; their "Not Contacted" prospect counts</p>
            <div class="last-updated" id="last-updated"></div>
        </div>
        <div class="header-right">
            <div class="auto-refresh">
                Auto-refresh:
                <select id="refresh-interval" onchange="setAutoRefresh()">
                    <option value="0">Off</option>
                    <option value="60">1 min</option>
                    <option value="300" selected>5 min</option>
                    <option value="900">15 min</option>
                </select>
            </div>
            <button class="btn btn-primary" id="btn-refresh" onclick="fetchData()">Refresh</button>
        </div>
    </div>

    <div class="status-bar" id="status-bar"></div>
    <div class="loader" id="loader"><div class="spinner"></div></div>

    <div id="results" class="hidden">
        <div class="summary-strip">
            <div class="summary-item">
                <div class="label">Total Sequences</div>
                <div class="value" style="color:var(--accent-blue);" id="s-total">—</div>
            </div>
            <div class="summary-item">
                <div class="label">Total Not Contacted</div>
                <div class="value" style="color:var(--accent-cyan);" id="s-uncontacted">—</div>
            </div>
            <div class="summary-item">
                <div class="label">Below ${THRESHOLD.toLocaleString()}</div>
                <div class="value" style="color:var(--accent-red);" id="s-below">—</div>
            </div>
            <div class="summary-item">
                <div class="label">Above ${THRESHOLD.toLocaleString()}</div>
                <div class="value" style="color:var(--accent-green);" id="s-above">—</div>
            </div>
        </div>

        <div class="card">
            <div class="card-title">All Active Sequences (sorted by count, descending)</div>
            <table class="data-table">
                <thead>
                    <tr>
                        <th style="width:40px;">#</th>
                        <th>Sequence Name</th>
                        <th style="text-align:right;">Not Contacted</th>
                    </tr>
                </thead>
                <tbody id="tbody-all"></tbody>
            </table>
        </div>

        <div class="card hidden" id="card-flagged">
            <div class="warning-label">
                <span class="warning-dot"></span>
                <span id="flagged-title">Sequences below ${THRESHOLD.toLocaleString()} — need more prospects</span>
            </div>
            <table class="data-table">
                <thead>
                    <tr>
                        <th style="width:40px;">#</th>
                        <th>Sequence Name</th>
                        <th style="text-align:right;">Not Contacted</th>
                    </tr>
                </thead>
                <tbody id="tbody-flagged"></tbody>
            </table>
        </div>
    </div>
</div>

<script>
const THRESHOLD = ${THRESHOLD};
let refreshTimer = null;

function setStatus(type, msg) {
    const bar = document.getElementById('status-bar');
    bar.className = 'status-bar ' + type;
    bar.textContent = msg;
}

function fmtNum(n) {
    if (n === null || n === undefined) return '—';
    return Number(n).toLocaleString();
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

function setAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    const seconds = Number(document.getElementById('refresh-interval').value);
    if (seconds > 0) {
        refreshTimer = setInterval(fetchData, seconds * 1000);
    }
}

async function fetchData() {
    const btn = document.getElementById('btn-refresh');
    btn.disabled = true;
    document.getElementById('results').classList.add('hidden');
    document.getElementById('loader').classList.add('active');
    setStatus('info', 'Fetching sequences from SalesHandy...');

    try {
        const res = await fetch('/api/sequences');
        let data;
        try { data = await res.json(); } catch (_) {
            throw new Error('Server returned ' + res.status + ' (non-JSON response)');
        }
        if (!res.ok) {
            throw new Error(data.error || 'Server returned ' + res.status);
        }

        if (data.warning) {
            setStatus('info', data.warning);
        }
        if (data.error) throw new Error(data.error);
        if (!data.sequences || data.sequences.length === 0) {
            setStatus('error', 'No active sequences found. Try http://localhost:${PORT}/api/test to diagnose.');
            return;
        }

        renderResults(data.sequences);
        const now = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const updatedText = data.lastUpdated
            ? 'Data from: ' + new Date(data.lastUpdated).toLocaleString() + ' — Page loaded: ' + now
            : 'Last updated: ' + now;
        document.getElementById('last-updated').textContent = updatedText;
        if (!data.warning) {
            setStatus('success', 'Loaded ' + data.sequences.length + ' active sequences.');
        }
    } catch (err) {
        setStatus('error', 'Error: ' + err.message + '. Visit /api/test to diagnose your API connection.');
    } finally {
        document.getElementById('loader').classList.remove('active');
        btn.disabled = false;
    }
}

function renderResults(sequences) {
    const results = document.getElementById('results');
    results.classList.remove('hidden');

    sequences.sort((a, b) => (b.notContactedCount ?? -1) - (a.notContactedCount ?? -1));

    const totalNotContacted = sequences.reduce((s, d) => s + (d.notContactedCount ?? 0), 0);
    const below = sequences.filter(d => d.notContactedCount !== null && d.notContactedCount < THRESHOLD);
    const above = sequences.filter(d => d.notContactedCount !== null && d.notContactedCount >= THRESHOLD);

    document.getElementById('s-total').textContent = fmtNum(sequences.length);
    document.getElementById('s-uncontacted').textContent = fmtNum(totalNotContacted);
    document.getElementById('s-below').textContent = fmtNum(below.length);
    document.getElementById('s-above').textContent = fmtNum(above.length);

    document.getElementById('tbody-all').innerHTML = sequences.map((d, i) => {
        const isRed = d.notContactedCount !== null && d.notContactedCount < THRESHOLD;
        return '<tr class="' + (isRed ? 'row-red' : '') + '">'
            + '<td class="num">' + (i + 1) + '</td>'
            + '<td class="seq-name">' + escapeHtml(d.name) + '</td>'
            + '<td class="num">' + fmtNum(d.notContactedCount) + '</td>'
            + '</tr>';
    }).join('');

    const cardFlagged = document.getElementById('card-flagged');
    if (below.length === 0) {
        cardFlagged.classList.add('hidden');
    } else {
        cardFlagged.classList.remove('hidden');
        document.getElementById('tbody-flagged').innerHTML = below
            .sort((a, b) => (a.notContactedCount ?? 0) - (b.notContactedCount ?? 0))
            .map((d, i) => '<tr class="row-red">'
                + '<td class="num">' + (i + 1) + '</td>'
                + '<td class="seq-name">' + escapeHtml(d.name) + '</td>'
                + '<td class="num">' + fmtNum(d.notContactedCount) + '</td>'
                + '</tr>').join('');
    }
}

// Auto-load on page open + start auto-refresh
fetchData();
setAutoRefresh();
</script>
</body>
</html>`;
}

// ── Server routes ────────────────────────────────────────────────────────────

// ── SalesHandy data fetching ─────────────────────────────────────────────────

function saleshandyGetOnce(urlPath) {
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
                if (res.statusCode >= 400) {
                    let detail = body;
                    try { detail = JSON.stringify(JSON.parse(body), null, 2); } catch (_) {}
                    reject(new Error(`SalesHandy API ${res.statusCode} on ${urlPath}\n${detail}`));
                    return;
                }
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error(`Invalid JSON from API on ${urlPath}: ${body.slice(0, 200)}`)); }
            });
        });

        req.on('error', (err) => reject(new Error(`Network error on ${urlPath}: ${err.message}`)));
        req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Timeout on ${urlPath}`)); });
        req.end();
    });
}

async function saleshandyGet(urlPath, retries = 3) {
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await saleshandyGetOnce(urlPath);
        } catch (err) {
            lastErr = err;
            const isServerError = err.message.includes('API 5') || err.message.includes('Network error') || err.message.includes('Timeout');
            if (!isServerError || attempt === retries) break;
            const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
            console.log(`  [Retry] Attempt ${attempt}/${retries} failed for ${urlPath} — retrying in ${delay / 1000}s...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastErr;
}

async function fetchAllSequences() {
    const allSequences = [];
    let page = 1;

    while (true) {
        const data = await saleshandyGet(`/v1/sequences?page=${page}`);
        const items = data.payload || data.data || data.sequences || data.items || data.results || [];

        if (!Array.isArray(items) || items.length === 0) {
            if (page === 1 && Array.isArray(data) && data.length > 0) {
                allSequences.push(...data);
            }
            break;
        }

        allSequences.push(...items);
        const totalPages = data.totalPages ?? data.total_pages ?? data.meta?.totalPages ?? data.meta?.last_page ?? null;
        if (totalPages !== null && page >= totalPages) break;
        if (items.length < 20) break;
        if (page >= 50) break;
        page++;
        await new Promise(r => setTimeout(r, 300)); // rate limit delay
    }

    // Filter to only active sequences
    const active = allSequences.filter(seq => {
        if (seq.active === true) return true;
        if (seq.active === false) return false;
        // Fallback for other API formats
        const status = (seq.status || seq.state || '').toString().toLowerCase();
        const inactive = ['paused', 'stopped', 'archived', 'deleted', 'draft', 'disabled'];
        return !inactive.includes(status);
    });
    console.log(`  [INFO] Found ${allSequences.length} total sequences, ${active.length} active.`);

    // Extract not-contacted counts with rate-limit-friendly delays
    const results = [];
    const RATE_DELAY = 300; // ms between API calls to avoid rate limiting

    for (let i = 0; i < active.length; i++) {
        const seq = active[i];
        const id = seq.id ?? seq._id ?? seq.sequenceId;
        const name = seq.name ?? seq.title ?? seq.sequenceName ?? `Sequence ${id}`;

        // Try embedded count first (no API call needed)
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
                await new Promise(r => setTimeout(r, RATE_DELAY));
                const detail = await saleshandyGet(`/v1/sequences/${id}`);
                const s = detail.payload || detail.data || detail;
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
                    await new Promise(r => setTimeout(r, RATE_DELAY));
                    const data = await saleshandyGet(`/v1/sequences/${id}/prospects?status=${status}`);
                    const total = data.total ?? data.totalCount ?? data.total_count
                        ?? data.meta?.total ?? data.pagination?.total
                        ?? data.payload?.total ?? data.payload?.totalCount;
                    if (total !== null && total !== undefined) { count = Number(total); break; }
                } catch (_) {}
            }
        }

        results.push({ id, name, notContactedCount: count !== null ? Number(count) : null });
        if ((i + 1) % 20 === 0) console.log(`  [INFO] Processed ${i + 1}/${active.length} sequences...`);
    }

    return results;
}

// ── Scheduled daily refresh at 8 AM ──────────────────────────────────────────

let cachedSequences = null;
let lastFetchTime = null;

async function refreshCache() {
    const now = new Date();
    console.log(`  [${now.toLocaleTimeString()}] Refreshing data from SalesHandy...`);
    try {
        cachedSequences = await fetchAllSequences();
        lastFetchTime = now;
        console.log(`  [${now.toLocaleTimeString()}] Done — ${cachedSequences.length} active sequences cached.`);
    } catch (err) {
        console.log(`  [${now.toLocaleTimeString()}] Error refreshing: ${err.message}`);
    }
}

function scheduleDaily8AM() {
    const now = new Date();
    const next8AM = new Date(now);
    next8AM.setHours(8, 0, 0, 0);
    if (now >= next8AM) {
        next8AM.setDate(next8AM.getDate() + 1);
    }
    const msUntil = next8AM - now;
    const hoursUntil = (msUntil / 3600000).toFixed(1);
    console.log(`  Next auto-refresh: ${next8AM.toLocaleString()} (in ${hoursUntil}h)`);

    setTimeout(() => {
        refreshCache();
        // Then repeat every 24 hours
        setInterval(refreshCache, 24 * 60 * 60 * 1000);
    }, msUntil);
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Serve the dashboard
    if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getHTML());
        return;
    }

    // API: sequences with caching
    if (url.pathname === '/api/sequences') {
        try {
            let sequences;
            if (cachedSequences && lastFetchTime && (Date.now() - lastFetchTime < 3600000)) {
                sequences = cachedSequences;
            } else {
                sequences = await fetchAllSequences();
                cachedSequences = sequences;
                lastFetchTime = new Date();
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                sequences,
                lastUpdated: lastFetchTime ? lastFetchTime.toISOString() : null,
            }));
        } catch (err) {
            if (cachedSequences) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    sequences: cachedSequences,
                    lastUpdated: lastFetchTime ? lastFetchTime.toISOString() : null,
                    warning: 'Serving cached data — live fetch failed: ' + err.message,
                }));
            } else {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        }
        return;
    }

    // API: force refresh
    if (url.pathname === '/api/refresh') {
        refreshCache();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'refresh started' }));
        return;
    }

    // API: diagnostic — test the SalesHandy connection
    if (url.pathname === '/api/test') {
        const results = {};
        const testEndpoints = [
            '/v1/sequences?page=1',
        ];
        for (const ep of testEndpoints) {
            try {
                const data = await saleshandyGetOnce(ep);
                results[ep] = { status: 'ok', keys: Object.keys(data), sample: JSON.stringify(data).slice(0, 500) };
            } catch (err) {
                results[ep] = { status: 'error', message: err.message };
            }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ apiKey: API_KEY.slice(0, 6) + '...' + API_KEY.slice(-4), results }, null, 2));
        return;
    }

    // Proxy raw SalesHandy API calls (for debugging)
    if (url.pathname.startsWith('/proxy/')) {
        const targetPath = url.pathname.replace('/proxy', '') + url.search;
        proxySaleshandy(targetPath, res);
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
});

// ── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', async () => {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    const ips = [];

    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                ips.push(iface.address);
            }
        }
    }

    console.log();
    console.log('  ┌─────────────────────────────────────────────────────┐');
    console.log('  │  SalesHandy — Uncontacted Prospects Dashboard       │');
    console.log('  ├─────────────────────────────────────────────────────┤');
    console.log(`  │  Local:   http://localhost:${PORT}                    │`);
    if (ips.length > 0) {
        for (const ip of ips) {
            const line = `  │  Network: http://${ip}:${PORT}`;
            console.log(line + ' '.repeat(Math.max(0, 56 - line.length)) + '│');
        }
    }
    console.log('  ├─────────────────────────────────────────────────────┤');
    console.log('  │  Share the Network URL with your team!              │');
    console.log('  │  Data refreshes automatically every day at 8:00 AM  │');
    console.log('  │  Server starts automatically when your PC boots     │');
    console.log('  └─────────────────────────────────────────────────────┘');
    console.log();

    // Fetch data immediately on startup
    await refreshCache();

    // Schedule daily refresh at 8 AM
    scheduleDaily8AM();
});
