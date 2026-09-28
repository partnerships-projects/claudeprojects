/**
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
      detail: `auth failed on ${Math.round(summary.authFailRate * 100)}% of readings ` +
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
      reasons: [`Google reports ${d.compliance.verdictReason} — cannot assess`],
    };
  }

  if (summary.readingCount === 0) {
    return { state: 'NO_SIGNAL', reasons: ['sending but no readings in window'] };
  }

  if (summary.readingCount < cfg.minReadings) {
    return {
      state: 'INSUFFICIENT_DATA',
      reasons: [`only ${summary.readingCount} readings in ${cfg.windowDays}d ` +
                `(need ${cfg.minReadings})`],
    };
  }

  // ── Base state from the rolling mean ──
  let state;
  const m = summary.spamMean;
  if (m < cfg.spamMeanHealthy)       state = 'HEALTHY';
  else if (m < cfg.spamMeanWatch)    state = 'WATCH';
  else if (m < cfg.spamMeanThrottle) state = 'THROTTLE';
  else                               state = 'QUARANTINE';

  reasons.push(`spam mean ${m.toFixed(3)}% over ${summary.readingCount} readings`);

  // ── Guard: don't act hard on a single complaint day ──
  if (isWorse(state, 'WATCH') && summary.nonZeroCount < cfg.minNonZeroReadings) {
    reasons.push(`only ${summary.nonZeroCount} non-zero reading — ` +
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
    reasons.push(`complaints on ${Math.round(summary.hitRate * 100)}% of ` +
                 'sending days (+1)');
  }

  // ── Acute onset: alert, never throttle ──
  // Deliberately does NOT change the state. Sudden onset needs a human to
  // look at what changed; automating a throttle off three readings at this
  // quantisation would fire on noise.
  if (summary.spiking) {
    reasons.push(`SPIKE: recent ${summary.spikeRecentMean.toFixed(2)}% vs ` +
                 `baseline ${summary.spikeBaselineMean.toFixed(2)}% — investigate`);
  }

  // ── Google's verdict as an overlay, never the spine ──
  if (reasonClass === 'protective' && isWorse(state, 'HEALTHY')) {
    const softened = LADDER[Math.max(LADDER.indexOf(state) - 1, 0)];
    reasons.push(`Google reports ${d.compliance.verdictReason} — softened one level`);
    state = softened;
  } else if (reasonClass === 'confirming' && isWorse(state, 'HEALTHY')) {
    reasons.push(`Google agrees: ${d.compliance.verdictReason}`);
  }

  // ── Config faults left unfixed on an already-degrading domain ──
  if (d.configIssuesOpenSince && isWorse(state, 'HEALTHY')) {
    const openFor = daysBetween(today, d.configIssuesOpenSince);
    if (openFor >= cfg.configFailEscalateAfterDays) {
      state = escalate(state, 1);
      reasons.push(`config fault unfixed ${openFor}d while degrading (+1)`);
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
               reasons: [...raw.reasons, `returning from ${current} — unproven, ramping`] };
    }
    return { state: raw.state, changed: true, reasons: raw.reasons };
  }

  // Sustained quarantine → propose retirement. The only path to RETIRE.
  if (current === 'QUARANTINE' && raw.state === 'QUARANTINE' && prior.stateSince) {
    const since = daysBetween(today, prior.stateSince);
    if (since >= cfg.retireAfterQuarantineDays) {
      return { state: 'RETIRE', changed: true,
               reasons: [...raw.reasons,
                         `quarantined ${since}d — not recoverable by warming`] };
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
               reasons: [...raw.reasons, `${streak}d consecutive — demoting`] };
    }
    return { state: current, changed: false,
             reasons: [...raw.reasons,
                       `worse but only ${streak}/${cfg.demoteAfterDays}d — holding`] };
  }

  // Improving: slower, and one level at a time.
  if (streak >= cfg.promoteAfterDays) {
    return { state: LADDER[Math.max(LADDER.indexOf(current) - 1, 0)], changed: true,
             reasons: [...raw.reasons, `${streak}d clean — promoting one level`] };
  }
  return { state: current, changed: false,
           reasons: [...raw.reasons,
                     `better but only ${streak}/${cfg.promoteAfterDays}d — holding`] };
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
      ? `${recentIncidents.length} fleet-wide authentication failure day(s) in the ` +
        `last ${cfg.windowDays}d (latest ${recentIncidents[recentIncidents.length - 1].date}, ` +
        `${Math.round(recentIncidents[recentIncidents.length - 1].authZeroShare * 100)}% of ` +
        'reporting domains sent unsigned). Excluded from per-domain scoring; ' +
        'this needs a human looking at the sending path, not a throttle.'
      : null,
    changes: changes.length,
    circuitBreakerTripped: tripped,
    breakerClass,
    verdict: !tripped
      ? `${changes.length} domains changing state` +
        (baselined ? `, ${baselined} baselined (no action).` : '.')
      : breakerClass === 'FLEET_INCIDENT'
        ? `FLEET-WIDE INCIDENT — ${changes.length} domains degraded together, and ` +
          'authentication and spam moved coherently. This is real, not a bad feed. ' +
          'Automated action halted; escalate to a human NOW.'
        : `HALTED: ${changes.length} domains would change (cap ${cfg.maxChangesPerRun}) ` +
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

module.exports = {
  decide, CONFIG, LADDER, NON_LADDER,
  summarise, rawState, applyHysteresis, configIssues, escalate,
  detectArtifactDates,
};
