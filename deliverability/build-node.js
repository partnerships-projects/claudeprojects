// ── Join the two Notion tables into the shape decide() expects. ──
//
// The history table's schema is still being revised by the collect side, so
// every column is looked up through a list of candidate names rather than one
// hardcoded string. A rename upstream degrades this to a null, not a crash.
// The schema probe below reports what was ACTUALLY found, so the first run
// tells us the real column names instead of us guessing them.

function pick(o, names) {
  for (var i = 0; i < names.length; i++) {
    var v = o[names[i]];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = Number(v);
  return Number.isNaN(n) ? null : n;
}
function day(v) {
  if (v === null || v === undefined) return null;
  return String(v).slice(0, 10);
}
function dom(v) {
  if (v === null || v === undefined) return null;
  var s = String(v).toLowerCase().trim();
  if (s.indexOf('@') >= 0) s = s.split('@')[1] || '';
  return s || null;
}

var DOMAIN_KEYS = ['Domain', 'Domain Name', 'domain', 'Name', 'name'];
var DATE_KEYS   = ['Date', 'Reading Date', 'Day', 'date', 'Stat Date'];
var SPAM_KEYS   = ['Spam Rate', 'User Reported Spam Rate', 'Spam Rate (%)', 'spamRate', 'Spam'];
var DMARC_KEYS  = ['DMARC Success Rate', 'DMARC Success', 'Auth DMARC', 'DMARC', 'dmarcSuccessRate'];
var DKIM_KEYS   = ['DKIM Success Rate', 'DKIM Success', 'Auth DKIM', 'DKIM', 'dkimSuccessRate'];
var SPF_KEYS    = ['SPF Success Rate', 'SPF Success', 'Auth SPF', 'SPF', 'spfSuccessRate'];
var ERR_KEYS    = ['Delivery Error Rate', 'Delivery Errors', 'deliveryErrorRate'];
var VERDICT_KEYS= ['Compliance Verdict', 'Verdict State', 'Verdict', 'complianceState'];
var REASON_KEYS = ['Verdict Reason', 'Compliance Reason', 'Reason', 'verdictReason'];
var STATE_KEYS  = ['Health State', 'State', 'Proposed State'];
var RAW_KEYS    = ['Raw State', 'rawState'];

var historyRows = $('Read Domain Health History').all();
var mailboxRows = $('Read Mailbox Rows').all();

// ── Schema probe ──
// The single most useful output of the first run is "what is actually in
// these tables". Guessing is how the last attempt at this died.
function keysOf(rows) {
  var seen = {};
  for (var i = 0; i < rows.length && i < 200; i++) {
    var k = Object.keys(rows[i].json);
    for (var j = 0; j < k.length; j++) seen[k[j]] = (seen[k[j]] || 0) + 1;
  }
  return seen;
}
var probe = {
  historyRowCount: historyRows.length,
  mailboxRowCount: mailboxRows.length,
  historyColumns: keysOf(historyRows),
  mailboxColumns: keysOf(mailboxRows),
  historySample: historyRows.length ? historyRows[0].json : null,
  mailboxSample: mailboxRows.length ? mailboxRows[0].json : null
};

// ── Mailboxes: which domains are in play, and what each one is allowed to send ──
var byDomain = {};
var mailboxesSeen = 0;
for (var i = 0; i < mailboxRows.length; i++) {
  var p = mailboxRows[i].json;
  var email = pick(p, ['Email', 'Email Address', 'name', 'Name']);
  var d = dom(pick(p, ['Domain', 'Domain Name'])) || dom(email);
  if (!d) continue;
  mailboxesSeen++;
  if (!byDomain[d]) {
    byDomain[d] = {
      domain: d, inPlay: false, pinned: false, mailboxes: [],
      readings: [], compliance: null, configIssuesOpenSince: null
    };
  }
  var shStatus = pick(p, ['SalesHandy Status', 'Saleshandy Status', 'Status']);
  var active = shStatus !== null && String(shStatus).toLowerCase().indexOf('active') >= 0;
  if (active) byDomain[d].inPlay = true;
  // Pin / override: a human has taken this domain off automation by hand.
  if (p['Auto-Manage'] === false || p['Pinned'] === true) byDomain[d].pinned = true;

  var limit = num(pick(p, ['Baseline Daily Limit', 'Daily Limit', 'Last Sending Volume']));
  byDomain[d].mailboxes.push({
    email: email ? String(email).toLowerCase().trim() : null,
    pageId: p.id || null,
    saleshandyId: pick(p, ['SalesHandy ID', 'Saleshandy ID']),
    instantlyId: pick(p, ['Instantly ID']),
    baselineDailyLimit: limit === null ? 30 : limit
  });
}

// ── History: one reading per domain per day ──
var priorStates = {};
var priorHistory = [];
var datedRows = 0;
var undatedRows = 0;
var unknownDomainRows = 0;

for (var h = 0; h < historyRows.length; h++) {
  var r = historyRows[h].json;
  var rd = dom(pick(r, DOMAIN_KEYS));
  var date = day(pick(r, DATE_KEYS));
  if (!date) { undatedRows++; continue; }
  datedRows++;
  if (!rd) continue;
  // A domain with history but no mailbox row still gets scored — it is exactly
  // the case where something was retired in one system and not the other.
  if (!byDomain[rd]) {
    unknownDomainRows++;
    byDomain[rd] = {
      domain: rd, inPlay: false, pinned: false, mailboxes: [],
      readings: [], compliance: null, configIssuesOpenSince: null
    };
  }

  byDomain[rd].readings.push({
    date: date,
    spamRate: num(pick(r, SPAM_KEYS)),
    authDmarc: num(pick(r, DMARC_KEYS)),
    authDkim: num(pick(r, DKIM_KEYS)),
    authSpf: num(pick(r, SPF_KEYS)),
    deliveryErrorRate: num(pick(r, ERR_KEYS))
  });

  var verdict = pick(r, VERDICT_KEYS);
  var reason = pick(r, REASON_KEYS);
  if (verdict || reason) {
    var prev = byDomain[rd].compliance;
    // Keep the newest compliance reading only.
    if (!prev || !prev._date || prev._date < date) {
      byDomain[rd].compliance = {
        _date: date,
        verdictState: verdict ? String(verdict) : null,
        verdictReason: reason ? String(reason) : null,
        requirements: {}
      };
    }
  }

  var st = pick(r, STATE_KEYS);
  var rawst = pick(r, RAW_KEYS);
  if (rawst) priorHistory.push({ domain: rd, date: date, rawState: String(rawst) });
  if (st) {
    var cur = priorStates[rd];
    if (!cur || cur._date < date) {
      priorStates[rd] = { state: String(st), stateSince: date, _date: date };
    }
  }
}

// De-duplicate readings per domain-day: an append-only table can hold two rows
// for the same day after a backfill. Newest write wins.
var domains = [];
var domainKeys = Object.keys(byDomain);
for (var k = 0; k < domainKeys.length; k++) {
  var dd = byDomain[domainKeys[k]];
  var byDay = {};
  for (var q = 0; q < dd.readings.length; q++) byDay[dd.readings[q].date] = dd.readings[q];
  dd.readings = Object.keys(byDay).sort().map(function (x) { return byDay[x]; });
  domains.push(dd);
}

return [{ json: {
  domains: domains,
  priorStates: priorStates,
  history: priorHistory,
  probe: {
    historyRowCount: probe.historyRowCount,
    mailboxRowCount: probe.mailboxRowCount,
    historyColumns: probe.historyColumns,
    mailboxColumns: probe.mailboxColumns,
    historySample: probe.historySample,
    mailboxSample: probe.mailboxSample,
    domainsBuilt: domains.length,
    mailboxesSeen: mailboxesSeen,
    historyRowsWithDate: datedRows,
    historyRowsWithoutDate: undatedRows,
    historyRowsForUnknownDomain: unknownDomainRows,
    priorStatesFound: Object.keys(priorStates).length
  }
} }];
