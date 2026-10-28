'use strict';
/**
 * Decide, end to end: read the Domain Health History database, score it, and
 * print what a person should look at.
 *
 * Read-only in every sense. It writes nothing to Notion, changes no sending
 * limit, and pauses no mailbox. The intended use for its first week is to run
 * it daily alongside the existing collector and read the output, so that the
 * states can be checked against what the fleet actually did before anything
 * is wired to act on them.
 *
 *   NOTION_TOKEN=... node decide-run.js
 *   node decide-run.js --days 21 --json out.json
 *   node decide-run.js --fixture rows.json        # no token, no network
 *   node decide-run.js --save-rows rows.json      # keep the raw rows read
 *
 * --fixture exists so the scoring can be re-run and argued about without
 * going back to Notion each time: --save-rows once, then iterate offline.
 */
const fs = require('fs');
const { decide, LADDER } = require('./state-machine-v4.js');
const { loadDomains } = require('./load-history.js');
const { historyRows } = require('./notion-client.js');

// The collector's own default. Overridden by NOTION_HIST_DB_ID so the two
// halves can be pointed at a copy of the table together.
const HIST_DB_ID = (process.env.NOTION_HIST_DB_ID || '').trim() ||
                   '3db0a93f-c145-8160-b83d-000be0f62c2e';

function parseArgs(argv) {
  const a = { days: 14, json: null, fixture: null, saveRows: null, all: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--days')       a.days = Number(argv[++i]);
    else if (v === '--json')      a.json = argv[++i];
    else if (v === '--fixture')   a.fixture = argv[++i];
    else if (v === '--save-rows') a.saveRows = argv[++i];
    else if (v === '--all')       a.all = true;
    else if (v === '--help' || v === '-h') a.help = true;
    else throw new Error(`unknown argument: ${v}`);
  }
  if (!Number.isFinite(a.days) || a.days < 1) throw new Error('--days must be a positive number');
  return a;
}

const pct = v => (v === null || v === undefined ? '  —  ' : `${v.toFixed(2)}%`.padStart(6));
const n   = v => (v === null || v === undefined ? '—' : v.toLocaleString());

function report(result, { all = false } = {}) {
  const L = [];
  const { fleet, counts, urgent, proposals, fixQueue } = result;

  L.push(`Decide — ${result.today}   (advisory: nothing here acts)`);
  L.push('='.repeat(72));

  const order = [...LADDER, 'LOW_VOLUME', 'INSUFFICIENT_DATA', 'IDLE'];
  L.push('\n' + order.filter(s => counts[s]).map(s => `${s} ${counts[s]}`).join('   ')
         + `   (${proposals.length} domains)`);

  // Freshness first. Every figure below is as old as the provider it came
  // from, and the two providers are routinely four days apart.
  const pmDays = fleet.publishedDays;
  const mjThrough = proposals.map(p => p.mjThrough).filter(Boolean).sort().pop() || null;
  L.push(`Postmaster published through ${pmDays[pmDays.length - 1] || '—'}` +
         `   ·   Mailjet through ${mjThrough || '—'}`);
  if (fleet.unpublishedDays.length) {
    L.push(`Awaiting Google: ${fleet.unpublishedDays.join(', ')}  (reporting lag, not an event)`);
  }

  if (fleet.authIncidents.length) {
    L.push('\nFLEET AUTH INCIDENTS');
    for (const i of fleet.authIncidents) L.push(`  ${i.date}: ${i.detail || JSON.stringify(i)}`);
  }

  L.push(`\nURGENT — look today  (${urgent.length})`);
  L.push('-'.repeat(72));
  if (!urgent.length) L.push('  nothing');
  for (const u of urgent) {
    L.push(`  ${u.state.padEnd(11)} ${u.domain.padEnd(30)} ${u.why}`);
    L.push(`  ${''.padEnd(11)} spam ${pct(u.pooledSpam)} over ${n(u.sent)} sent` +
           `   ·   hard bounce ${pct(u.hardBouncePct)}`);
    L.push(`  ${''.padEnd(11)} → ${u.advice}`);
  }

  const shown = all ? proposals
                    : proposals.filter(p => !['HEALTHY', 'IDLE', 'INSUFFICIENT_DATA'].includes(p.state));
  L.push(`\nPROPOSALS  (${shown.length}${all ? '' : ` of ${proposals.length}; --all for every domain`})`);
  L.push('-'.repeat(72));
  L.push('  state       domain                          spam    ≤bound   bounce   sent');
  for (const p of shown) {
    L.push(`  ${p.state.padEnd(11)} ${p.domain.padEnd(30)} ${pct(p.pooledSpam)}  ` +
           `${pct(p.upperBound)}  ${pct(p.hardBouncePct)}  ${n(p.sent).padStart(8)}` +
           `${p.changed ? '  ←changed' : ''}${p.bounceOnset ? '  ←bounce rising' : ''}`);
    for (const r of p.reasons) L.push(`              ${r}`);
  }

  if (fixQueue.length) {
    L.push(`\nFIX QUEUE — configuration faults, not throttles  (${fixQueue.length})`);
    L.push('-'.repeat(72));
    for (const f of fixQueue) L.push(`  ${f.domain.padEnd(30)} ${f.code}: ${f.detail}`);
  }

  return L.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^'use strict';\n/, ''));
    return;
  }

  let rows;
  if (args.fixture) {
    rows = JSON.parse(fs.readFileSync(args.fixture, 'utf8'));
    console.error(`read ${rows.length} rows from ${args.fixture}`);
  } else {
    // A little slack beyond the scoring window: hysteresis and the bounce
    // baseline both read behind the days being scored.
    const since = new Date(Date.now() - (args.days + 7) * 86400000).toISOString().slice(0, 10);
    console.error(`reading Domain Health History since ${since}…`);
    rows = await historyRows(HIST_DB_ID, since, {
      onPage: (count, more) => console.error(`  ${count} rows${more ? '…' : ''}`),
    });
  }
  if (args.saveRows) {
    fs.writeFileSync(args.saveRows, JSON.stringify(rows));
    console.error(`saved ${rows.length} rows to ${args.saveRows}`);
  }

  const domains = loadDomains(rows, { windowDays: args.days });
  if (!domains.length) {
    console.error('no domains could be built from those rows — nothing to score');
    process.exit(2);
  }
  console.error(`scoring ${domains.length} domains over ${args.days} days\n`);

  const today = domains[0].windowThrough;
  const result = decide({ domains, today });

  console.log(report(result, { all: args.all }));
  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify(result, null, 2));
    console.error(`\nwrote ${args.json}`);
  }
}

if (require.main === module) {
  main().catch(e => { console.error(`\n${e.message}`); process.exit(1); });
}

module.exports = { report, parseArgs, HIST_DB_ID };
