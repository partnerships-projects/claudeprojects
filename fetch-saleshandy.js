#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// SalesHandy — Fetch Active Sequences & Uncontacted Prospect Counts
// ─────────────────────────────────────────────────────────────────────────────
//
// Usage:
//   node fetch-saleshandy.js
//
// The script will:
//   1. Call the SalesHandy API to list all active sequences
//   2. Fetch the "Not Contacted" count for each sequence
//   3. Print a table to your terminal (red = below threshold)
//   4. Generate saleshandy-sequences.html with the data embedded
//
// No dependencies required — uses built-in Node.js fetch (Node 18+).
// ─────────────────────────────────────────────────────────────────────────────

const API_KEY = process.env.SALESHANDY_API_KEY || '';
const BASE_URL = 'https://leo-open-api-gateway.saleshandy.com';
const THRESHOLD = 2000;

const fs = require('fs');
const path = require('path');

// ── API helpers ──────────────────────────────────────────────────────────────

async function apiRequest(urlPath, params = {}) {
    const url = new URL(urlPath, BASE_URL);
    Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null) url.searchParams.set(k, v);
    });

    const res = await fetch(url.toString(), {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
        },
    });

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`API ${res.status}: ${res.statusText} — ${body}`);
    }

    return res.json();
}

async function getAllSequences() {
    const sequences = [];
    let page = 1;
    const limit = 100;

    while (true) {
        const data = await apiRequest('/api/v1/sequences', { page, limit });
        const items = data.data || data.sequences || data.items || data.results || [];

        if (!Array.isArray(items) || items.length === 0) {
            if (page === 1 && Array.isArray(data) && data.length > 0) {
                sequences.push(...data);
            }
            break;
        }

        sequences.push(...items);
        if (items.length < limit) break;
        if (page >= 50) break;
        page++;
    }

    return sequences;
}

function extractCount(seq) {
    return seq.notContactedCount
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
}

async function getNotContactedCount(sequenceId) {
    // Strategy 1: sequence detail endpoint
    const detailPaths = [
        `/api/v1/sequences/${sequenceId}`,
        `/api/v1/sequence/${sequenceId}`,
    ];

    for (const p of detailPaths) {
        try {
            const data = await apiRequest(p);
            const seq = data.data || data;
            const count = extractCount(seq);
            if (count !== null && count !== undefined) return Number(count);
        } catch (_) {}
    }

    // Strategy 2: prospect list with status filter
    const prospectPaths = [
        `/api/v1/sequences/${sequenceId}/prospects`,
        `/api/v1/prospects`,
    ];
    const statusValues = ['NOT_CONTACTED', 'notContacted', 'not_contacted', 'Not Contacted', '0'];

    for (const p of prospectPaths) {
        for (const status of statusValues) {
            try {
                const params = { status, limit: 1 };
                if (p === '/api/v1/prospects') params.sequenceId = sequenceId;
                const data = await apiRequest(p, params);
                const total = data.total ?? data.totalCount ?? data.total_count
                    ?? data.meta?.total ?? data.pagination?.total;
                if (total !== null && total !== undefined) return Number(total);
            } catch (_) {}
        }
    }

    return null;
}

// ── Terminal output ──────────────────────────────────────────────────────────

function printTable(sequenceData) {
    const RED = '\x1b[31m';
    const GREEN = '\x1b[32m';
    const CYAN = '\x1b[36m';
    const BOLD = '\x1b[1m';
    const DIM = '\x1b[2m';
    const RESET = '\x1b[0m';

    console.log();
    console.log(`${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
    console.log(`${BOLD}  SalesHandy — Active Sequences — "Not Contacted" Prospects${RESET}`);
    console.log(`${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
    console.log();

    const belowCount = sequenceData.filter(d => d.notContactedCount !== null && d.notContactedCount < THRESHOLD).length;
    const aboveCount = sequenceData.filter(d => d.notContactedCount !== null && d.notContactedCount >= THRESHOLD).length;
    const totalUncontacted = sequenceData.reduce((s, d) => s + (d.notContactedCount ?? 0), 0);

    console.log(`  ${DIM}Total sequences:${RESET} ${BOLD}${sequenceData.length}${RESET}    ${DIM}Total not contacted:${RESET} ${BOLD}${totalUncontacted.toLocaleString()}${RESET}`);
    console.log(`  ${GREEN}Above ${THRESHOLD}:${RESET} ${BOLD}${aboveCount}${RESET}    ${RED}Below ${THRESHOLD}:${RESET} ${BOLD}${belowCount}${RESET}`);
    console.log();

    // Column widths
    const nameWidth = Math.max(30, ...sequenceData.map(d => (d.name || '').length + 2));

    console.log(`  ${DIM}${'#'.padStart(4)}  ${'Sequence Name'.padEnd(nameWidth)}  ${'Not Contacted'.padStart(15)}${RESET}`);
    console.log(`  ${DIM}${'─'.repeat(4)}  ${'─'.repeat(nameWidth)}  ${'─'.repeat(15)}${RESET}`);

    sequenceData.forEach((d, i) => {
        const count = d.notContactedCount;
        const countStr = count !== null ? count.toLocaleString() : '—';
        const isRed = count !== null && count < THRESHOLD;
        const color = isRed ? RED : '';
        const marker = isRed ? ` ${RED}◀ LOW${RESET}` : '';

        console.log(`  ${color}${String(i + 1).padStart(4)}  ${(d.name || 'Unknown').padEnd(nameWidth)}  ${countStr.padStart(15)}${RESET}${marker}`);
    });

    console.log();

    if (belowCount > 0) {
        console.log(`${RED}${BOLD}  ⚠ ${belowCount} sequence(s) have fewer than ${THRESHOLD.toLocaleString()} uncontacted prospects!${RESET}`);
        console.log();
    }
}

// ── HTML generation ──────────────────────────────────────────────────────────

function generateHTML(sequenceData) {
    const belowThreshold = sequenceData.filter(d => d.notContactedCount !== null && d.notContactedCount < THRESHOLD);
    const aboveThreshold = sequenceData.filter(d => d.notContactedCount !== null && d.notContactedCount >= THRESHOLD);
    const totalUncontacted = sequenceData.reduce((s, d) => s + (d.notContactedCount ?? 0), 0);

    const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const fmtNum = (n) => n !== null && n !== undefined ? Number(n).toLocaleString() : '—';

    const allRows = sequenceData.map((d, i) => {
        const isRed = d.notContactedCount !== null && d.notContactedCount < THRESHOLD;
        return `<tr class="${isRed ? 'row-red' : ''}">
            <td class="num">${i + 1}</td>
            <td class="seq-name">${escapeHtml(d.name)}</td>
            <td class="num">${fmtNum(d.notContactedCount)}</td>
        </tr>`;
    }).join('\n');

    const flaggedRows = belowThreshold
        .sort((a, b) => (a.notContactedCount ?? 0) - (b.notContactedCount ?? 0))
        .map((d, i) => `<tr class="row-red">
            <td class="num">${i + 1}</td>
            <td class="seq-name">${escapeHtml(d.name)}</td>
            <td class="num">${fmtNum(d.notContactedCount)}</td>
        </tr>`).join('\n');

    const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

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
            background: var(--bg-primary);
            color: var(--text-primary);
            min-height: 100vh;
            line-height: 1.5;
        }
        .page { max-width: 1100px; margin: 0 auto; padding: 40px 32px; }
        .header {
            display: flex; align-items: flex-start; justify-content: space-between;
            margin-bottom: 32px; padding-bottom: 20px; border-bottom: 1px solid var(--border);
        }
        .header h1 { font-size: 26px; font-weight: 700; letter-spacing: -0.4px; }
        .header p { color: var(--text-secondary); font-size: 13px; margin-top: 4px; }
        .date-badge {
            background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px;
            padding: 8px 16px; font-size: 13px; color: var(--text-secondary); white-space: nowrap;
        }
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
        .data-table td { padding: 13px 14px; font-size: 14px; border-bottom: 1px solid rgba(42, 47, 69, 0.5); color: var(--text-primary); }
        .data-table tbody tr:hover { background: rgba(79, 141, 245, 0.04); }
        .data-table .num { font-variant-numeric: tabular-nums; font-weight: 600; text-align: right; }
        .data-table .seq-name { font-weight: 500; }
        .data-table tr.row-red { background: var(--row-red-bg); }
        .data-table tr.row-red td { color: var(--accent-red); border-bottom-color: var(--row-red-border); }
        .data-table tr.row-red:hover { background: rgba(248, 113, 113, 0.15); }
        .hidden { display: none !important; }
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
        </div>
        <div class="date-badge">${now}</div>
    </div>

    <div class="summary-strip">
        <div class="summary-item">
            <div class="label">Total Sequences</div>
            <div class="value" style="color:var(--accent-blue);">${fmtNum(sequenceData.length)}</div>
        </div>
        <div class="summary-item">
            <div class="label">Total Not Contacted</div>
            <div class="value" style="color:var(--accent-cyan);">${fmtNum(totalUncontacted)}</div>
        </div>
        <div class="summary-item">
            <div class="label">Below ${fmtNum(THRESHOLD)}</div>
            <div class="value" style="color:var(--accent-red);">${fmtNum(belowThreshold.length)}</div>
        </div>
        <div class="summary-item">
            <div class="label">Above ${fmtNum(THRESHOLD)}</div>
            <div class="value" style="color:var(--accent-green);">${fmtNum(aboveThreshold.length)}</div>
        </div>
    </div>

    <div class="card">
        <div class="card-title">All Sequences (sorted by count, descending)</div>
        <table class="data-table">
            <thead>
                <tr>
                    <th style="width:40px;">#</th>
                    <th>Sequence Name</th>
                    <th style="text-align:right;">Not Contacted</th>
                </tr>
            </thead>
            <tbody>${allRows}</tbody>
        </table>
    </div>

    ${belowThreshold.length > 0 ? `<div class="card">
        <div class="warning-label">
            <span class="warning-dot"></span>
            Sequences below ${fmtNum(THRESHOLD)} — need more prospects
        </div>
        <table class="data-table">
            <thead>
                <tr>
                    <th style="width:40px;">#</th>
                    <th>Sequence Name</th>
                    <th style="text-align:right;">Not Contacted</th>
                </tr>
            </thead>
            <tbody>${flaggedRows}</tbody>
        </table>
    </div>` : ''}
</div>
</body>
</html>`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log('\nConnecting to SalesHandy API...');

    // 1. Fetch all sequences
    console.log('Fetching sequences...');
    const sequences = await getAllSequences();

    if (sequences.length === 0) {
        console.error('No sequences found. Check your API key.');
        process.exit(1);
    }

    console.log(`Found ${sequences.length} sequences.`);

    // 2. Filter to active sequences only
    const activeSequences = sequences.filter(seq => {
        const status = (seq.status || seq.state || '').toString().toLowerCase();
        // Include if status is active/running/live, OR if no status field (assume active)
        return !status || status === 'active' || status === 'running' || status === 'live' || status === '1';
    });

    console.log(`Active sequences: ${activeSequences.length}`);

    // 3. Get not-contacted counts
    const sequenceData = [];

    // Check if counts are embedded in the list response
    const firstSeq = activeSequences[0];
    const embeddedCount = extractCount(firstSeq);
    const hasEmbedded = embeddedCount !== null && embeddedCount !== undefined;

    if (hasEmbedded) {
        console.log('Counts found in sequence list response.');
        for (const seq of activeSequences) {
            const count = extractCount(seq);
            sequenceData.push({
                id: seq.id ?? seq._id ?? seq.sequenceId,
                name: seq.name ?? seq.title ?? seq.sequenceName ?? `Sequence ${seq.id}`,
                notContactedCount: count !== null ? Number(count) : null,
            });
        }
    } else {
        console.log('Fetching counts individually...');
        for (let i = 0; i < activeSequences.length; i++) {
            const seq = activeSequences[i];
            const id = seq.id ?? seq._id ?? seq.sequenceId;
            const name = seq.name ?? seq.title ?? seq.sequenceName ?? `Sequence ${id}`;
            process.stdout.write(`  [${i + 1}/${activeSequences.length}] ${name}...`);

            const count = await getNotContactedCount(id);
            sequenceData.push({ id, name, notContactedCount: count });
            console.log(` ${count !== null ? count.toLocaleString() : '?'}`);
        }
    }

    // Sort by count descending
    sequenceData.sort((a, b) => (b.notContactedCount ?? -1) - (a.notContactedCount ?? -1));

    // 4. Print terminal table
    printTable(sequenceData);

    // 5. Generate HTML
    const htmlPath = path.join(__dirname, 'saleshandy-sequences.html');
    fs.writeFileSync(htmlPath, generateHTML(sequenceData), 'utf-8');
    console.log(`HTML dashboard saved to: ${htmlPath}`);
    console.log('Open it in your browser to see the visual report.\n');
}

main().catch(err => {
    console.error('\nError:', err.message);
    process.exit(1);
});
