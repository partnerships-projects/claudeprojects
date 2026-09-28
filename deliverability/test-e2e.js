const fs = require('fs');
const TODAY = '2026-09-28';
const day = n => new Date(new Date(TODAY) - n*86400000).toISOString().slice(0,10);

// ── Synthetic Notion rows, in the shape the Notion node emits (simple:true) ──
const histRows = [], mboxRows = [];
const INCIDENT = ['2026-09-10','2026-09-11'];
const profile = {
  'healthy.com':   n => 0.0,
  'borderline.com':n => (n % 4 === 0 ? 2.0 : 0.0),   // mean ~0.5
  'chronic.com':   n => 1.2,
  'burning.com':   n => 2.4,
  'spiky.com':     n => (n <= 5 ? 5.0 : 0.0),
  'unsigned.com':  n => 0.1,
};
// filler so the fleet clears the detector's 10-reporting-domains floor
for (let f = 0; f < 8; f++) profile['filler'+f+'.com'] = () => 0.0;
Object.keys(profile).forEach((d, di) => {
  for (let n = 3; n <= 30; n++) {
    const date = day(n);
    const inc = INCIDENT.includes(date);
    const ownUnsigned = (d === 'unsigned.com' && n % 3 === 0);
    histRows.push({ json: {
      id: 'h'+di+'-'+n, Domain: d, Date: date + 'T00:00:00.000Z',
      'Spam Rate': inc ? 6.0 : profile[d](n),
      'DMARC Success Rate': (inc || ownUnsigned) ? 0 : 100,
      'DKIM Success Rate':  (inc || ownUnsigned) ? 0 : 100,
      'Delivery Error Rate': 0,
      'Compliance Verdict': 'COMPLIANT',
      'Verdict Reason': d === 'healthy.com' ? 'USER_FEEDBACK_POSITIVE' : 'USER_FEEDBACK_LOW',
    }});
  }
  for (let m = 0; m < 3; m++) {
    mboxRows.push({ json: { id: 'm'+di+'-'+m, name: 'user'+m+'@'+d, Domain: d,
      'SalesHandy Status': 'Active', 'Daily Limit': 40 }});
  }
});
// a domain that exists as mailboxes but has never reported
mboxRows.push({ json: { id: 'mx', name: 'a@silent.com', Domain: 'silent.com', 'SalesHandy Status': 'Active', 'Daily Limit': 40 }});
// a domain parked in Notion but not sending
mboxRows.push({ json: { id: 'mp', name: 'a@parked.com', Domain: 'parked.com', 'SalesHandy Status': 'Paused', 'Daily Limit': 40 }});

// ── Run the three Code nodes exactly as n8n would ──
function runNode(file, inputItems, nodeOutputs) {
  const code = fs.readFileSync(file, 'utf8');
  const $input = { all: () => inputItems, first: () => inputItems[0] };
  const $ = name => ({ all: () => nodeOutputs[name] });
  const $now = { toFormat: () => TODAY };
  return new Function('$input','$','$now','Object','Number','Math','Date','JSON',
                      '"use strict";' + code)($input,$,$now,Object,Number,Math,Date,JSON);
}
const outs = { 'Read Domain Health History': histRows, 'Read Mailbox Rows': mboxRows };
const built   = runNode('rt/Build_Domain_Set.js', mboxRows, outs);
const decided = runNode('rt/Decide___State_Machine_v2.js', built, outs);
const rows    = runNode('rt/One_Row_Per_Domain.js', decided, outs);

const run = rows[0].json;
console.log('=== RUN ROW ===');
console.log('verdict        :', run.verdict);
console.log('fleetAlert     :', run.fleetAlert);
console.log('incident days  :', run.fleetIncidentDays);
console.log('fixQueueSize   :', run.fixQueueSize);
console.log('summary        :', JSON.stringify(run.summary));
console.log('probe          : hist=%d mbox=%d domains=%d dated=%d priorStates=%d',
  run.probe.historyRowCount, run.probe.mailboxRowCount, run.probe.domainsBuilt,
  run.probe.historyRowsWithDate, run.probe.priorStatesFound);
console.log('hist columns   :', Object.keys(run.probe.historyColumns).join(', '));
console.log('\n=== DOMAIN ROWS (worst first) ===');
console.log('state             domain           mean    rdgs  spike  auth  cfg');
for (const r of rows.slice(1).map(x => x.json)) {
  console.log(
    String(r.state).padEnd(18) + String(r.domain).padEnd(17) +
    String(r.spamMean === null ? '-' : r.spamMean.toFixed(3)).padStart(6) +
    String(r.readings).padStart(6) + String(r.spiking).padStart(7) +
    String(r.authFailRate === null ? '-' : r.authFailRate.toFixed(2)).padStart(6) +
    '  ' + (r.configIssues || ''));
}
console.log('\n=== a "why" ===');
const b = rows.slice(1).map(x=>x.json).find(r => r.domain === 'burning.com');
console.log(b.domain + ':', b.why);
const u = rows.slice(1).map(x=>x.json).find(r => r.domain === 'unsigned.com');
console.log(u.domain + ':', u.fixDetail);
