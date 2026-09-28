import { workflow, node, trigger, sticky, newCredential } from '@n8n/workflow-sdk';

// Deliverability Health — Decide v2
//
// READ-ONLY. Reads two Notion tables, computes a proposed health state per
// domain from a 30-day rolling aggregate, and stops. There is no write node
// of any kind in this workflow — not to Notion, not to Saleshandy, not to
// Instantly. The worst it can do is put a wrong number on a screen.

const dailyTrigger = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.4,
  config: {
    name: 'Daily 09:00',
    parameters: { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 9, triggerAtMinute: 0 }] } },
  },
  output: [{ timestamp: '2026-09-29T09:00:00.000Z' }],
});

const readHistory = node({
  type: 'n8n-nodes-base.notion',
  version: 3,
  config: {
    name: 'Read Domain Health History',
    parameters: {
      resource: 'databasePage',
      operation: 'getAll',
      dataSourceId: { __rl: true, mode: 'id', value: '3db0a93f-c145-81a5-a881-e793d037e8eb' },
      returnAll: true,
      simple: true,
      filterType: 'none',
    },
    credentials: { notionApi: newCredential('Domain Health History (read-only)') },
  },
  output: [{ id: 'h-1', Domain: 'example.com', Date: '2026-09-25', 'Spam Rate': 0.4 }],
});

const readMailboxes = node({
  type: 'n8n-nodes-base.notion',
  version: 3,
  config: {
    name: 'Read Mailbox Rows',
    parameters: {
      resource: 'databasePage',
      operation: 'getAll',
      dataSourceId: { __rl: true, mode: 'id', value: '38d0a93f-c145-810b-8441-f103edc7f5af' },
      returnAll: true,
      simple: true,
      filterType: 'none',
    },
    credentials: { notionApi: newCredential('Domain Health History (read-only)') },
  },
  output: [{ id: 'm-1', name: 'someone@example.com', Domain: 'example.com', Status: 'Active' }],
});

const build = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Domain Set',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// ── Join the two Notion tables into the shape decide() expects. ──
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
`,
    },
  },
  output: [{ domains: [], priorStates: {}, history: [], probe: { historyRowCount: 0 } }],
});

const decideNode = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Decide — State Machine v2',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `/**
 * Deliverability Health Monitoring — DECIDE stage, thresholds_v2
 *
 * Pure decision logic. No credentials, no I/O, no side effects.
 *
 * WHAT CHANGED FROM v1, AND WHY
 *
 * v1 used Google's domain reputation as the base state. That field was
 * permanently removed from Postmaster Tools, so the spine is gone and
 * this is a rewrite rather than an edit.
 *
 * v1's spam thresholds were also calibrated on biased data: the old sync
 * stored "the most recent day that had a complaint" rather than the daily
 * rate, so it never recorded a zero. The true fleet distribution has 77%
 * zeros and a much lower tail — p90 fell from 9.1 to 2.53 once measured
 * honestly.
 *
 * And spam rate at this sending volume is a COUNTER, not a rate: one
 * complaint against a few dozen inbox placements produces ~2%, zero
 * complaints produces 0. Thresholding a single day's value is close to
 * coin-flipping. So v2 scores a rolling aggregate per domain instead.
 *
 * Two outputs, deliberately separate:
 *   - health state  → drives throttle / pause (the ladder)
 *   - config issues → drives a human fix queue
 * Throttling a domain whose DKIM is broken does not fix DKIM.
 */

// ───────────────────────────────────────────────────────────────────────────
// CONFIG — every tunable number lives here and nowhere else.
// ───────────────────────────────────────────────────────────────────────────

const CONFIG = {
  version: 'thresholds_v2',

  // Rolling window the per-domain aggregate is computed over.
  windowDays: 30,

  // Postmaster publishes with a lag and revises recent figures. The newest
  // readings are provisional, so they are excluded from every aggregate.
  // Consequence: this system is structurally ~2 days behind and cannot be a
  // same-day alarm. That is a property, not a bug, but say it out loud.
  ignoreRecentDays: 2,

  // Spike detection — a SEPARATE detector from the mean.
  //
  // The mean cannot see shape: [0,0,0,0,5] and [1,1,1,1,1] both average 1%,
  // and they are completely different situations. The first is an acute
  // event — something changed yesterday. The second is chronic elevation.
  // The mean catches the chronic case; this catches the acute one.
  //
  // A spike raises an ALERT, never a throttle. Sudden onset needs a human
  // looking at what changed, and at this sending volume a single complaint
  // can look like a spike from nothing.
  spikeWindow: 3,           // recent readings
  spikeBaselineWindow: 21,  // compared against
  spikeMultiple: 3,         // recent ≥ 3× baseline
  spikeFloor: 1.0,          // ...AND above this absolute value, so a jump
                            // from 0.05% to 0.2% does not trip it

  // Below this many readings in the window, the mean is noise, not signal.
  // Fleet reference: p25 = 12 readings, median = 23, min = 1.
  minReadings: 7,

  // Base state from MEAN spam rate across the window, in percentage points.
  //
  // Lower bound is Google's published policy line (0.3%) because that is the
  // actual enforcement threshold. Upper bounds come from the fleet's own
  // distribution because that is where real outliers sit.
  //
  // Calibrated on the CLEAN baseline — fleet-wide incident days excluded.
  // With those days averaged in, the tail ran ~10-20% hot and the ladder
  // would have fired late on genuinely degrading domains.
  //   raw    fleet (150 domains): p75 0.925, p90 1.691, p95 2.003
  //   clean  fleet:               p75 0.8,   p90 1.5
  spamMeanHealthy:  0.3,    // Google's policy line
  spamMeanWatch:    0.8,    // ≈ clean p75
  spamMeanThrottle: 1.5,    // ≈ clean p90; above this → QUARANTINE

  // A single bad day can drag a mean upward. Require corroboration before
  // acting on anything worse than WATCH.
  minNonZeroReadings: 2,

  // Complaints on more than half of sending days is systemic rather than
  // incidental — escalate one level.
  // Fleet reference: median hit rate 0.083, p75 0.25, p90 0.60.
  hitRateEscalate: 0.5,

  // Config faults (auth failures, unsubscribe not honoured) route to the fix
  // queue, NOT the ladder. They escalate health only when left unfixed while
  // the domain is also degrading — at which point continuing to send is
  // compounding a known, unaddressed fault.
  configFailEscalateAfterDays: 21,
  configFailEscalateRequiresSpam: true,

  // Fraction of readings with a total authentication failure before the
  // domain lands in the fix queue.
  //
  // Calibrated AFTER artifact-date exclusion, where the distribution is
  // p75 0.05, p90 0.091, p95 0.143. Before exclusion the fleet baseline was
  // ~20% of readings, which was the incident days, not a per-domain fault.
  // At 0.15 this flags the handful of domains with a genuinely unsigned
  // sending path rather than everyone who was caught in a fleet-wide day.
  authFailRateFlag: 0.15,   // ≈ clean p95

  // ── Fleet-wide incident days ──
  //
  // On some dates EVERY reporting domain authenticated at 0%. Those are not
  // per-domain faults; they are one event. Averaging them into each domain's
  // rolling mean smears one incident across the whole fleet and moves the
  // ladder for domains that did nothing wrong.
  //
  // So they are excluded from AGGREGATES and raised as a FLEET ALERT instead.
  // They are never deleted from history — they are the only evidence we have
  // of what an incident actually looks like here.
  //
  // Detected from the batch, not hardcoded: a date is an incident day when
  // more than this share of the domains reporting that day failed auth.
  // The data is trivially separable — normal days ~2%, incident days 30-100%
  // — so the exact cutoff barely matters. Observed: Aug 24-28 and Sep 10 2026.
  artifactDateThreshold: 0.15,

  // Manual override. Normally empty: the detector above does the work. Put a
  // date here only to force-exclude one the detector cannot see (e.g. a known
  // outage that did not show up as auth failure).
  excludeDates: [],

  // Hysteresis. Valid on a day basis again in v2: the rolling mean produces
  // a value every day regardless of whether the domain sent that day, so
  // gaps in the underlying readings no longer break streaks.
  demoteAfterDays: 2,
  promoteAfterDays: 7,
  retireAfterQuarantineDays: 14,

  // A mass change means a data fault, not a fleet-wide collapse.
  maxChangesPerRun: 15,

  gates: {
    HEALTHY:           'AUTO',
    WATCH:             'AUTO',
    THROTTLE:          'AUTO_NOTIFY',
    QUARANTINE:        'APPROVAL',
    RETIRE:            'APPROVAL',
    IDLE:              'AUTO',
    INSUFFICIENT_DATA: 'AUTO',
    NO_SIGNAL:         'AUTO_NOTIFY',
  },

  actions: {
    HEALTHY:           { mult: 1.0,  warmup: 'maintain' },
    WATCH:             { mult: 1.0,  warmup: 'maintain', freeze: true },
    THROTTLE:          { mult: 0.5,  warmup: 'increase' },
    QUARANTINE:        { mult: 0.0,  warmup: 'increase' },
    RETIRE:            { mult: 0.0,  warmup: 'stop' },
    IDLE:              { mult: null, warmup: 'none' },
    INSUFFICIENT_DATA: { mult: null, warmup: 'none' },
    NO_SIGNAL:         { mult: null, warmup: 'none' },
  },
};

const LADDER = ['HEALTHY', 'WATCH', 'THROTTLE', 'QUARANTINE', 'RETIRE'];

// States that describe "we are not scoring this domain", not a health level.
const NON_LADDER = ['IDLE', 'INSUFFICIENT_DATA', 'NO_SIGNAL'];

// Google's own verdict reasons, mapped to how we treat them.
const REASON = {
  MESSAGE_VOLUME_LOW:     'unassessable', // Google can't judge — 35% of fleet
  USER_FEEDBACK_POSITIVE: 'protective',   // Google says users want this mail
  SENDER_NOT_COMPLIANT:   'confirming',
  SPAM_RATE_HIGH:         'confirming',
  USER_FEEDBACK_NEGATIVE: 'confirming',
  SMTP_ERRORS_HIGH:       'confirming',
  USER_FEEDBACK_LOW:      'neutral',
};

// Compliance requirements that are CONFIG problems, not health problems.
// A DMARC failure needs a DNS change; throttling it fixes nothing.
const CONFIG_REQUIREMENTS = [
  'SPF_AND_DKIM', 'DMARC_POLICY', 'DMARC_ALIGNMENT', 'DNS_RECORDS',
  'MESSAGE_FORMATTING', 'ENCRYPTION', 'ONE_CLICK_UNSUBSCRIBE',
  'HONOR_UNSUBSCRIBE',
];

// USER_REPORTED_SPAM_RATE is deliberately absent from both lists: it fails on
// 71% of the fleet, making it a near-constant with no discriminating power.
// We use the continuous SPAM_RATE metric instead — the same signal, measured.

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

const daysBetween = (a, b) => Math.floor((new Date(a) - new Date(b)) / 86400000);

/** Escalation never reaches RETIRE. That state is only reachable via sustained
 *  quarantine — a domain is not condemned on one window's reading. */
function escalate(state, steps) {
  const i = LADDER.indexOf(state);
  if (i < 0) return state;
  return LADDER[Math.min(i + steps, LADDER.indexOf('QUARANTINE'))];
}

const isWorse = (a, b) => LADDER.indexOf(a) > LADDER.indexOf(b);

const mean = arr => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null);

// ───────────────────────────────────────────────────────────────────────────
// 0. Fleet-wide incident days — found in the batch, not configured
// ───────────────────────────────────────────────────────────────────────────

/**
 * A date where an implausible share of the reporting fleet failed
 * authentication outright is one event, not N independent faults.
 *
 * Returns the dates, each with the evidence, so the caller can both exclude
 * them from per-domain aggregates AND alert on them. Those are different
 * jobs: excluding stops one bad day from moving 150 ladders; alerting is the
 * whole point, because a day when the entire fleet sent unsigned mail is the
 * most serious thing this system can detect.
 */
function detectArtifactDates(domains, cfg) {
  const byDate = {};

  for (const d of domains) {
    for (const r of (d.readings || [])) {
      if (r.authDmarc === null || r.authDmarc === undefined) continue;
      if (!byDate[r.date]) {
        byDate[r.date] = { date: r.date, reporting: 0, authZero: 0, spamSum: 0, spamN: 0 };
      }
      const b = byDate[r.date];
      b.reporting++;
      if (r.authDmarc === 0) b.authZero++;
      if (r.spamRate !== null && r.spamRate !== undefined) {
        b.spamSum += r.spamRate;
        b.spamN++;
      }
    }
  }

  const out = [];
  for (const date of Object.keys(byDate)) {
    const b = byDate[date];
    // A handful of domains reporting is not a fleet. Without this floor a
    // sparse early date with two domains, one of them broken, reads as 50%.
    if (b.reporting < 10) continue;

    const share = b.authZero / b.reporting;
    if (share <= cfg.artifactDateThreshold) continue;

    out.push({
      date,
      authZeroShare: share,
      domainsReporting: b.reporting,
      domainsAuthZero: b.authZero,
      spamMeanThatDay: b.spamN ? b.spamSum / b.spamN : null,
    });
  }

  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ───────────────────────────────────────────────────────────────────────────
// 1. Aggregate a domain's readings over the window
// ───────────────────────────────────────────────────────────────────────────

function summarise(readings, today, cfg) {
  const cutoff = new Date(new Date(today) - cfg.windowDays * 86400000)
    .toISOString().slice(0, 10);

  // The newest readings are provisional — Postmaster revises them.
  const settled = new Date(new Date(today) - (cfg.ignoreRecentDays || 0) * 86400000)
    .toISOString().slice(0, 10);

  const excluded = cfg.excludeDates || [];

  const inWindow = readings
    .filter(r => r.date > cutoff && r.date <= settled)
    // Fleet-wide incident days are excluded from AGGREGATES but never deleted
    // from history — they are the only evidence we have of what an incident
    // looks like.
    .filter(r => !excluded.includes(r.date));

  // A reading counts for spam only if the value is actually present. Missing
  // is not zero — that distinction is what the old sync got wrong.
  const spam = inWindow
    .filter(r => r.spamRate !== null && r.spamRate !== undefined)
    .map(r => r.spamRate);

  const auth = inWindow
    .filter(r => r.authDmarc !== null && r.authDmarc !== undefined)
    .map(r => r.authDmarc);

  const errs = inWindow
    .filter(r => r.deliveryErrorRate !== null && r.deliveryErrorRate !== undefined)
    .map(r => r.deliveryErrorRate);

  const nonZero = spam.filter(v => v > 0);

  // Spike: recent readings materially above the domain's own baseline.
  // Chronological order matters, so sort before slicing.
  const byDate = inWindow
    .filter(r => r.spamRate !== null && r.spamRate !== undefined)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const recent = byDate.slice(-cfg.spikeWindow).map(r => r.spamRate);
  const baseline = byDate
    .slice(-(cfg.spikeWindow + cfg.spikeBaselineWindow), -cfg.spikeWindow)
    .map(r => r.spamRate);

  const recentMean = mean(recent);
  const baseMean = mean(baseline);
  const spiking = recentMean !== null && baseMean !== null &&
                  baseline.length >= 5 &&
                  recentMean >= cfg.spikeFloor &&
                  recentMean >= baseMean * cfg.spikeMultiple;

  return {
    spiking,
    spikeRecentMean: recentMean,
    spikeBaselineMean: baseMean,
    readingCount:  spam.length,
    spamMean:      mean(spam),
    spamMax:       spam.length ? Math.max(...spam) : null,
    nonZeroCount:  nonZero.length,
    hitRate:       spam.length ? nonZero.length / spam.length : null,
    authFailRate:  auth.length ? auth.filter(v => v === 0).length / auth.length : null,
    errorMax:      errs.length ? Math.max(...errs) : null,
    latestReading: inWindow.length
      ? inWindow.map(r => r.date).sort().slice(-1)[0]
      : null,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 2. Config faults — a separate output, never the ladder
// ───────────────────────────────────────────────────────────────────────────

function configIssues(d, summary, cfg) {
  const issues = [];

  for (const req of CONFIG_REQUIREMENTS) {
    if (d.compliance && d.compliance.requirements &&
        d.compliance.requirements[req] === 'NEEDS_WORK') {
      issues.push({
        code: req,
        detail: req === 'HONOR_UNSUBSCRIBE'
          ? 'unsubscribes not suppressed within 48h — check sequence settings'
          : 'compliance requirement failing — needs a configuration fix',
      });
    }
  }

  // Intermittent total auth failure: on some sending days the domain's mail
  // passes neither DMARC nor DKIM. Real mail, measured, unauthenticated —
  // usually a second sending path that is not signing.
  if (summary.authFailRate !== null && summary.authFailRate >= cfg.authFailRateFlag) {
    issues.push({
      code: 'INTERMITTENT_AUTH_FAILURE',
      detail: \`auth failed on \${Math.round(summary.authFailRate * 100)}% of readings \` +
              '— likely an unsigned sending path',
    });
  }

  return issues;
}

// ───────────────────────────────────────────────────────────────────────────
// 3. Today's raw verdict, before hysteresis
// ───────────────────────────────────────────────────────────────────────────

function rawState(d, summary, today, cfg) {
  const reasons = [];

  if (!d.inPlay) {
    return { state: 'IDLE', reasons: ['not attached to an active sequence'] };
  }

  // Google itself says it cannot assess this domain. Not healthy, not
  // failing — unassessable. 35% of the fleet sits here, and calling them
  // all failures would be the fastest way to get this switched off.
  const reasonClass = d.compliance ? REASON[d.compliance.verdictReason] : null;
  if (reasonClass === 'unassessable') {
    return {
      state: 'INSUFFICIENT_DATA',
      reasons: [\`Google reports \${d.compliance.verdictReason} — cannot assess\`],
    };
  }

  if (summary.readingCount === 0) {
    return { state: 'NO_SIGNAL', reasons: ['sending but no readings in window'] };
  }

  if (summary.readingCount < cfg.minReadings) {
    return {
      state: 'INSUFFICIENT_DATA',
      reasons: [\`only \${summary.readingCount} readings in \${cfg.windowDays}d \` +
                \`(need \${cfg.minReadings})\`],
    };
  }

  // ── Base state from the rolling mean ──
  let state;
  const m = summary.spamMean;
  if (m < cfg.spamMeanHealthy)       state = 'HEALTHY';
  else if (m < cfg.spamMeanWatch)    state = 'WATCH';
  else if (m < cfg.spamMeanThrottle) state = 'THROTTLE';
  else                               state = 'QUARANTINE';

  reasons.push(\`spam mean \${m.toFixed(3)}% over \${summary.readingCount} readings\`);

  // ── Guard: don't act hard on a single complaint day ──
  if (isWorse(state, 'WATCH') && summary.nonZeroCount < cfg.minNonZeroReadings) {
    reasons.push(\`only \${summary.nonZeroCount} non-zero reading — \` +
                 'capped at WATCH pending corroboration');
    state = 'WATCH';
  }

  // ── Escalator: complaints on most sending days is systemic ──
  // Guarded on magnitude. Hit rate without magnitude is not evidence of harm:
  // a domain drawing 0.05% on every single day is healthier than one drawing
  // 3% on a third of its days. This escalator exists to sharpen a borderline
  // case, not to manufacture one out of a domain that is comfortably fine.
  if (summary.hitRate !== null && summary.hitRate >= cfg.hitRateEscalate &&
      summary.nonZeroCount >= cfg.minNonZeroReadings &&
      m >= cfg.spamMeanHealthy) {
    state = escalate(state, 1);
    reasons.push(\`complaints on \${Math.round(summary.hitRate * 100)}% of \` +
                 'sending days (+1)');
  }

  // ── Acute onset: alert, never throttle ──
  // Deliberately does NOT change the state. Sudden onset needs a human to
  // look at what changed; automating a throttle off three readings at this
  // quantisation would fire on noise.
  if (summary.spiking) {
    reasons.push(\`SPIKE: recent \${summary.spikeRecentMean.toFixed(2)}% vs \` +
                 \`baseline \${summary.spikeBaselineMean.toFixed(2)}% — investigate\`);
  }

  // ── Google's verdict as an overlay, never the spine ──
  if (reasonClass === 'protective' && isWorse(state, 'HEALTHY')) {
    const softened = LADDER[Math.max(LADDER.indexOf(state) - 1, 0)];
    reasons.push(\`Google reports \${d.compliance.verdictReason} — softened one level\`);
    state = softened;
  } else if (reasonClass === 'confirming' && isWorse(state, 'HEALTHY')) {
    reasons.push(\`Google agrees: \${d.compliance.verdictReason}\`);
  }

  // ── Config faults left unfixed on an already-degrading domain ──
  if (d.configIssuesOpenSince && isWorse(state, 'HEALTHY')) {
    const openFor = daysBetween(today, d.configIssuesOpenSince);
    if (openFor >= cfg.configFailEscalateAfterDays) {
      state = escalate(state, 1);
      reasons.push(\`config fault unfixed \${openFor}d while degrading (+1)\`);
    }
  }

  return { state, reasons };
}

// ───────────────────────────────────────────────────────────────────────────
// 4. Hysteresis — fast down, slow up
// ───────────────────────────────────────────────────────────────────────────

function applyHysteresis(d, raw, prior, history, today, cfg) {
  if (!prior || !prior.state) {
    // A first run establishes a baseline, not a transition. It must not count
    // toward the circuit breaker, or the first run halts itself by
    // classifying the whole fleet at once.
    return { state: raw.state, changed: false, initial: true,
             reasons: [...raw.reasons, 'initial classification — baseline, no action'] };
  }

  const current = prior.state;

  // IDLE / INSUFFICIENT_DATA / NO_SIGNAL are conditions, not health levels —
  // they switch immediately rather than waiting out a streak.
  if (NON_LADDER.includes(raw.state) || NON_LADDER.includes(current)) {
    if (raw.state === current) {
      return { state: current, changed: false, reasons: raw.reasons };
    }
    // Returning to scoring after a gap, a domain is unproven: re-enter at
    // WATCH so it ramps rather than resuming at full volume on thin evidence.
    if (NON_LADDER.includes(current) && raw.state === 'HEALTHY') {
      return { state: 'WATCH', changed: true,
               reasons: [...raw.reasons, \`returning from \${current} — unproven, ramping\`] };
    }
    return { state: raw.state, changed: true, reasons: raw.reasons };
  }

  // Sustained quarantine → propose retirement. The only path to RETIRE.
  if (current === 'QUARANTINE' && raw.state === 'QUARANTINE' && prior.stateSince) {
    const since = daysBetween(today, prior.stateSince);
    if (since >= cfg.retireAfterQuarantineDays) {
      return { state: 'RETIRE', changed: true,
               reasons: [...raw.reasons,
                         \`quarantined \${since}d — not recoverable by warming\`] };
    }
  }

  if (raw.state === current) {
    return { state: current, changed: false, reasons: raw.reasons };
  }

  // Consecutive days the raw verdict has agreed with today's.
  let streak = 1;
  const recent = history
    .filter(h => h.domain === d.domain)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  for (const h of recent) {
    if (h.rawState === raw.state) streak++;
    else break;
  }

  if (isWorse(raw.state, current)) {
    if (streak >= cfg.demoteAfterDays) {
      return { state: raw.state, changed: true,
               reasons: [...raw.reasons, \`\${streak}d consecutive — demoting\`] };
    }
    return { state: current, changed: false,
             reasons: [...raw.reasons,
                       \`worse but only \${streak}/\${cfg.demoteAfterDays}d — holding\`] };
  }

  // Improving: slower, and one level at a time.
  if (streak >= cfg.promoteAfterDays) {
    return { state: LADDER[Math.max(LADDER.indexOf(current) - 1, 0)], changed: true,
             reasons: [...raw.reasons, \`\${streak}d clean — promoting one level\`] };
  }
  return { state: current, changed: false,
           reasons: [...raw.reasons,
                     \`better but only \${streak}/\${cfg.promoteAfterDays}d — holding\`] };
}

// ───────────────────────────────────────────────────────────────────────────
// 5. Main entry point
// ───────────────────────────────────────────────────────────────────────────

function decide({ domains, priorStates = {}, history = [], today, config = CONFIG }) {
  // Fleet-wide incident days are found in this batch, then excluded from every
  // per-domain aggregate below. Manual excludeDates are additive, not a
  // replacement — the detector is the normal path.
  const detected = detectArtifactDates(domains, config);
  const detectedDates = detected.map(a => a.date);
  const cfg = {
    ...config,
    excludeDates: (config.excludeDates || []).concat(detectedDates),
  };

  const results = [];
  const fixQueue = [];

  for (const d of domains) {
    const summary = summarise(d.readings || [], today, cfg);
    const issues = configIssues(d, summary, cfg);
    const raw = rawState(d, summary, today, cfg);
    const prior = priorStates[d.domain];
    const decided = applyHysteresis(d, raw, prior, history, today, cfg);

    const pinned = d.pinned === true;
    const act = cfg.actions[decided.state];

    if (issues.length) {
      fixQueue.push({
        domain: d.domain,
        issues,
        healthState: decided.state,
        openSince: d.configIssuesOpenSince || today,
      });
    }

    results.push({
      domain: d.domain,
      mailboxCount: (d.mailboxes || []).length,
      priorState: prior ? prior.state : null,
      rawState: raw.state,
      state: pinned ? (prior ? prior.state : decided.state) : decided.state,
      changed: pinned ? false : decided.changed,
      initial: decided.initial === true,
      pinned,
      gate: cfg.gates[decided.state],
      reasons: pinned
        ? [...decided.reasons, 'PINNED — reported only, not actioned']
        : decided.reasons,
      metrics: summary,
      compliance: d.compliance
        ? { verdict: d.compliance.verdictState, reason: d.compliance.verdictReason }
        : null,
      configIssues: issues.map(i => i.code),
      spiking: summary.spiking === true,
      proposedActions: pinned ? [] : (d.mailboxes || []).map(m => ({
        email: m.email,
        saleshandyId: m.saleshandyId,
        instantlyId: m.instantlyId,
        newDailyLimit: act.mult === null
          ? null
          : Math.round((m.baselineDailyLimit || 0) * act.mult),
        warmup: act.warmup,
        freeze: act.freeze === true,
      })),
      thresholdVersion: cfg.version,
    });
  }

  const changes = results.filter(r => r.changed);
  const tripped = changes.length > cfg.maxChangesPerRun;
  const baselined = results.filter(r => r.initial).length;

  // When the breaker trips, classify WHY before alerting. A fleet can move in
  // lockstep for two very different reasons, and they need opposite responses:
  //
  //   auth collapses, spam unchanged  → decoupled  → data fault, investigate feed
  //   auth collapses, spam elevated   → coherent   → REAL fleet-wide incident
  //
  // Observed Aug 24-28 and Sep 10 2026: every reporting domain hit auth=0 on the
  // same dates AND spam rose (66.8% zeros vs 79.5% baseline, non-zero p90 9.09
  // vs 5.26). That was real unauthenticated sending, not a broken pipeline.
  // Halting silently on that would suppress exactly the alert you need.
  let breakerClass = null;
  if (tripped) {
    const scored = results.filter(r => r.metrics && r.metrics.readingCount > 0);
    const authBad = scored.filter(r => r.metrics.authFailRate >= 0.9).length;
    const spamUp = scored.filter(r =>
      r.metrics.spamMean !== null && r.metrics.spamMean > cfg.spamMeanHealthy).length;
    const share = n => (scored.length ? n / scored.length : 0);

    breakerClass = (share(authBad) > 0.5 && share(spamUp) > 0.5)
      ? 'FLEET_INCIDENT'
      : 'PROBABLE_DATA_FAULT';
  }

  const summary = {};
  for (const s of LADDER.concat(NON_LADDER)) {
    summary[s] = results.filter(r => r.state === s).length;
  }

  // A fleet-wide unsigned day inside the current window is the most serious
  // thing this system can find, and it is a FLEET alert, not a per-domain one.
  // It is reported whether or not the breaker tripped.
  const recentIncidents = detected.filter(a =>
    a.date > new Date(new Date(today) - cfg.windowDays * 86400000)
      .toISOString().slice(0, 10));

  return {
    today,
    thresholdVersion: cfg.version,
    domainsEvaluated: results.length,
    baselined,
    fleetIncidentDays: detected,
    fleetAlert: recentIncidents.length
      ? \`\${recentIncidents.length} fleet-wide authentication failure day(s) in the \` +
        \`last \${cfg.windowDays}d (latest \${recentIncidents[recentIncidents.length - 1].date}, \` +
        \`\${Math.round(recentIncidents[recentIncidents.length - 1].authZeroShare * 100)}% of \` +
        'reporting domains sent unsigned). Excluded from per-domain scoring; ' +
        'this needs a human looking at the sending path, not a throttle.'
      : null,
    changes: changes.length,
    circuitBreakerTripped: tripped,
    breakerClass,
    verdict: !tripped
      ? \`\${changes.length} domains changing state\` +
        (baselined ? \`, \${baselined} baselined (no action).\` : '.')
      : breakerClass === 'FLEET_INCIDENT'
        ? \`FLEET-WIDE INCIDENT — \${changes.length} domains degraded together, and \` +
          'authentication and spam moved coherently. This is real, not a bad feed. ' +
          'Automated action halted; escalate to a human NOW.'
        : \`HALTED: \${changes.length} domains would change (cap \${cfg.maxChangesPerRun}) \` +
          'but the signals are decoupled — probably a data fault rather than a ' +
          'fleet-wide failure. Check the ingest before acting.',
    summary,
    approvalsNeeded: tripped
      ? 0
      : changes.filter(r => r.gate === 'APPROVAL').length,
    // When the breaker trips nothing is actionable — the run becomes a report.
    results: results.map(r => (tripped ? { ...r, proposedActions: [] } : r)),
    // Config faults are reported regardless of the breaker: they are a human
    // fix list, not an automated action, so they cannot do any harm.
    fixQueue,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// n8n runner — everything above is the tested state machine, byte for byte.
// ───────────────────────────────────────────────────────────────────────────

const TODAY = $now.toFormat('yyyy-MM-dd');
const input = $input.first().json;

const out = decide({
  domains: input.domains || [],
  priorStates: input.priorStates || {},
  history: input.history || [],
  today: TODAY,
});

out.probe = input.probe || null;
return [{ json: out }];
`,
    },
  },
  output: [{ today: '2026-09-29', thresholdVersion: 'thresholds_v2', domainsEvaluated: 0, verdict: '0 domains changing state.' }],
});

const explode = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'One Row Per Domain',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// One readable table: a RUN row first, then one row per domain.
// The run row carries the fleet-level findings, which are not a property of
// any single domain and would be invisible if we only emitted domains.
const run = $input.first().json;

const rows = [{
  _row: 'RUN',
  domain: '— RUN SUMMARY —',
  runDate: run.today,
  thresholdVersion: run.thresholdVersion,
  domainsEvaluated: run.domainsEvaluated,
  baselined: run.baselined,
  changes: run.changes,
  circuitBreakerTripped: run.circuitBreakerTripped,
  breakerClass: run.breakerClass,
  verdict: run.verdict,
  fleetAlert: run.fleetAlert,
  fleetIncidentDays: (run.fleetIncidentDays || []).map(a => a.date).join(', ') || null,
  approvalsNeeded: run.approvalsNeeded,
  fixQueueSize: (run.fixQueue || []).length,
  summary: run.summary,
  probe: run.probe,
}];

const fixBy = {};
for (const f of (run.fixQueue || [])) {
  fixBy[f.domain] = f.issues.map(i => i.code + ': ' + i.detail).join(' | ');
}

// Worst first. Someone opening this wants the problems, not the alphabet.
const ORDER = ['RETIRE','QUARANTINE','THROTTLE','WATCH','NO_SIGNAL','HEALTHY','INSUFFICIENT_DATA','IDLE'];
const sorted = (run.results || []).slice().sort((a, b) => {
  const d = ORDER.indexOf(a.state) - ORDER.indexOf(b.state);
  if (d !== 0) return d;
  return (b.metrics && b.metrics.spamMean || 0) - (a.metrics && a.metrics.spamMean || 0);
});

for (const r of sorted) {
  rows.push({
    _row: 'DOMAIN',
    domain: r.domain,
    state: r.state,
    priorState: r.priorState,
    rawState: r.rawState,
    changed: r.changed,
    initial: r.initial,
    gate: r.gate,
    pinned: r.pinned,
    spiking: r.spiking,
    spamMean: r.metrics ? r.metrics.spamMean : null,
    spamMax: r.metrics ? r.metrics.spamMax : null,
    readings: r.metrics ? r.metrics.readingCount : null,
    hitRate: r.metrics ? r.metrics.hitRate : null,
    authFailRate: r.metrics ? r.metrics.authFailRate : null,
    latestReading: r.metrics ? r.metrics.latestReading : null,
    mailboxCount: r.mailboxCount,
    configIssues: (r.configIssues || []).join(', ') || null,
    fixDetail: fixBy[r.domain] || null,
    why: (r.reasons || []).join(' | '),
    runDate: run.today,
    runVerdict: run.verdict,
  });
}

return rows.map(j => ({ json: j }));
`,
    },
  },
  output: [{ _row: 'RUN', domain: '— RUN SUMMARY —', verdict: '0 domains changing state.' }],
});

const review = node({
  type: 'n8n-nodes-base.noOp',
  version: 1,
  config: { name: 'Proposed States — Review Only' },
  output: [{ domain: 'example.com', state: 'HEALTHY' }],
});

const noteSafety = sticky(
  `## READ-ONLY — this workflow cannot change a mailbox

It reads two Notion tables, computes a proposed health state per domain,
and stops. No Notion write node, no Saleshandy node, no Instantly node.

Keep it unpublished until the proposed-state table has been reviewed
against what you know about these domains by hand.`,
  [readHistory, readMailboxes],
  { color: 3 },
);

const noteSignal = sticky(
  `## One signal, aggregated — not a daily threshold

Domain reputation was **permanently removed** from Postmaster Tools, so the
old spine is gone. Spam rate is the only robust health signal left.

At this sending volume spam rate is a **counter, not a rate**: one complaint
against a few dozen placements reads as ~2%, zero complaints reads as 0.
Thresholding a single day is close to a coin flip — so this scores a
**30-day rolling mean per domain** instead.

Two detectors, deliberately separate:
- **mean** catches chronic elevation
- **spike** catches acute onset — and only ever raises an alert, never a
  throttle, because sudden onset needs a human looking at what changed

Newest 2 days are excluded from every aggregate: Postmaster revises them.
This system is structurally ~2 days behind. That is a property, not a bug.`,
  [build, decideNode],
  { color: 4 },
);

const noteConfig = sticky(
  `## The CONFIG block is the whole argument

Every number that decides what happens to a mailbox sits at the top of
**Decide — State Machine v2**, tagged \`thresholds_v2\`. Each run records
which version produced it, so a bad threshold is traceable afterwards.

Thresholds are calibrated on this fleet's **clean baseline** — fleet-wide
incident days excluded. With those days averaged in, the tail ran 10-20%
hot and the ladder would have fired late on genuinely degrading domains.

Config faults (auth failure, unsubscribe not honoured) go to a **fix queue**,
never the ladder. Throttling a domain whose DKIM is broken does not fix DKIM.`,
  [decideNode],
  { color: 6 },
);

const noteNext = sticky(
  `## Before this is trustworthy

1. **Attach a read-only Notion credential** to both Notion nodes. The only
   credential on this instance today lives in a personal project.
2. **Check the schema probe** on the RUN row of the output. It reports the
   real column names in both tables. Column lookups here are a list of
   candidate names, so a rename degrades to a null rather than a crash —
   but the probe is how we find out what to actually name them.
3. \`priorStates\` and \`history\` come from the history table's own state
   columns. If those do not exist yet, every run is a first run: every
   domain reports **initial classification — baseline, no action**, and
   hysteresis is untested. That is the safe failure, not a broken one.
4. **Bounce rate is still missing** from every source. It is the one signal
   that would make this independent of Postmaster.`,
  [explode, review],
  { color: 5 },
);

export default workflow('deliverability-decide-v2', 'Deliverability Health — Decide v2')
  .add(dailyTrigger)
  .to(readHistory)
  .to(readMailboxes)
  .to(build)
  .to(decideNode)
  .to(explode)
  .to(review)
  .add(noteSafety)
  .add(noteSignal)
  .add(noteConfig)
  .add(noteNext)
  .group('Read (Notion, read-only)', [readHistory, readMailboxes], { description: 'Pulls the append-only history table and the live mailbox table.' })
  .group('Decide (pure logic)', [build, decideNode], { description: 'No credentials, no side effects. Same code as the tested state machine.' })
  .group('Review', [explode, review], { description: 'Proposed states for human review. Nothing is applied.' });
