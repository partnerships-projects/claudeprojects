'use strict';
/**
 * Decide v3 — proposes a health state per domain. It never acts.
 *
 * WHAT CHANGED FROM v2, AND WHY
 *
 * v2 recomputed its own rolling spam mean from the daily readings. The collect
 * stage now publishes exactly that statistic ("Avg Spam Rate (7d)"), computed
 * over the days Google has actually published, with measured zeros kept and
 * missing days excluded. Two implementations of one statistic is how the table
 * and the scorer came to disagree about a domain, so v3 READS it and refuses to
 * score a domain that does not have one. summarise() and its mean are gone.
 *
 * v2 also detected "fleet-wide incident days": dates where more than 15% of
 * reporting domains showed DMARC 0%. That signature is real but the reading was
 * wrong. Measured against the history table on 2026-10-13:
 *
 *     date         auth-zero share   volume reported   spam reported
 *     2026-09-23        100% (99/99)          0           16 domains
 *     2026-09-26        100% (81/81)          0           23 domains
 *     2026-10-10         76% (53/70)         17            9 domains
 *     every other day       1-2%            full          normal
 *
 * Google published SPAM for those days but not auth or volume, while the fleet
 * demonstrably sent mail (51k on 09-22, 47k on 09-24). That is partial
 * publication -- the same reporting lag that once made the mailbox table show a
 * fleet of false zeros -- not an incident. The 1-2% floor on every other day is
 * two genuinely broken domains, which is the real signal that was being buried.
 *
 * So v3 does not infer incidents from auth alone. A fleet alert requires auth
 * failure on a day that DID report volume: real mail, flowing, unauthenticated.
 * Reporting lag cannot imitate that.
 *
 * NOTHING HERE ACTS
 *
 * Every state is a recommendation to a human. THROTTLE means "a person should
 * look at this and probably slow it down", not "slowed down". That makes a
 * state being too severe cheap, and NOISE the real failure: a watchlist nobody
 * reads is worse than no watchlist. The output is therefore ranked and split --
 * urgent items a person must see, routine items that can sit in Notion.
 */

// ───────────────────────────────────────────────────────────────────────────
// Configuration
// ───────────────────────────────────────────────────────────────────────────

const CONFIG = {
  // ── The ladder ──
  //
  // Thresholds on the 7-day published mean, in percentage points. Carried over
  // from v2 unchanged, but for a better reason than v2 gave: v2's comments
  // claimed "clean p75 / p90" from a baseline that had been cleaned of days
  // which were not incidents. Re-checked against the live fleet on 2026-10-13,
  // these land as: 79 domains HEALTHY, 10 WATCH, 9 THROTTLE, 8 QUARANTINE, and
  // 107 with no reading at all. 27 domains needing attention out of 213 is a
  // list a person can actually work through, which is the test that matters
  // when nothing is automatic.
  spamMeanHealthy:  0.3,    // Google's published policy line
  spamMeanWatch:    0.8,
  spamMeanThrottle: 1.5,

  // ── Volume gate on the severest state ──
  //
  // Spam rate is a COUNTER at this fleet's volume: one complaint in 74 messages
  // reads as 1.35%. A domain can look terrible on a handful of messages without
  // having done anything. QUARANTINE is the state most likely to get a domain
  // retired, so it requires enough measured mail for the rate to mean
  // something. Below this a domain can still reach THROTTLE and still appears
  // on the watchlist -- it is capped, not hidden.
  quarantineMinVolume: 500,

  // ── Corroboration ──
  minReadings:         4,   // published days with a reading, else INSUFFICIENT_DATA
  minNonZeroReadings:  2,   // one bad day is never enough to go past WATCH

  // ── Escalator ──
  // Complaints on most sending days is systemic rather than incidental. Guarded
  // on magnitude: a domain drawing 0.05% every day is healthier than one
  // drawing 3% on a third of its days, so this sharpens a borderline case
  // rather than manufacturing one.
  hitRateEscalate: 0.5,
  // The escalator may sharpen a borderline case but never create the severest
  // one. Two reasons, both learned the hard way in testing against real data:
  //
  //  1. escalate() from QUARANTINE lands on RETIRE, and RETIRE is supposed to
  //     be reachable ONLY through sustained quarantine. Without this ceiling a
  //     domain could be proposed for retirement on its very first run, before
  //     any prior state existed to be sustained.
  //  2. QUARANTINE is the state that leads to retirement, so it should be
  //     earned on MAGNITUDE alone. advancecreators.com averages 1.071% but
  //     draws complaints on 86% of its days; that is a THROTTLE worth a human
  //     looking at, not a domain to stop.
  escalateCeiling: 'THROTTLE',

  // ── Hysteresis: fast down, slow up ──
  demoteAfterDays:  2,
  promoteAfterDays: 4,
  retireAfterQuarantineDays: 21,

  // ── Fleet alert ──
  // Share of domains that BOTH reported volume AND failed auth on the same day.
  // Reporting lag produces no volume, so it cannot reach this.
  fleetAuthAlertShare: 0.15,
  fleetAlertMinReporting: 10,   // a handful of domains is not a fleet

  // ── Spike ──
  spikeWindow: 3,
  spikeFactor: 3,
  spikeFloor:  0.5,
};

// Severity order. Everything outside it is a condition, not a health level.
const LADDER = ['HEALTHY', 'WATCH', 'THROTTLE', 'QUARANTINE', 'RETIRE'];
const NON_LADDER = ['IDLE', 'INSUFFICIENT_DATA'];

/**
 * What a human should do. There is no machine action: v3 proposes, a person
 * decides. Spelled out per state so the Notion row explains itself without
 * anyone having to come back here and read the code.
 */
const ADVICE = {
  HEALTHY:           'nothing to do',
  WATCH:             'keep an eye on it — no action yet',
  THROTTLE:          'a person should look and probably slow this domain down',
  QUARANTINE:        'stop sending from this domain until someone has looked',
  RETIRE:            'sustained quarantine — propose replacing this domain',
  IDLE:              'not attached to an active sequence',
  INSUFFICIENT_DATA: 'too little mail for Google to report on — normal, not a fault',
};

/**
 * Compliance requirements Google reports that are NOT faults here, with the
 * reason recorded so nobody "fixes" them back into the fix queue.
 *
 * HONOR_UNSUBSCRIBE is a deliberate copy decision: unsubscribe is a link, and
 * links are kept out of the body to keep the mail reading as 1:1. Google flags
 * 64 of 180 domains for it and always will. In v2 this fed CONFIG_REQUIREMENTS,
 * which meant 64 permanent fix-queue items nobody would ever action AND -- via
 * configFailEscalateAfterDays -- a permanent one-level escalation for every one
 * of those domains the moment it stopped being HEALTHY. A deliberate business
 * decision must not quietly make the ladder harsher.
 *
 * SPF_AND_DKIM: SPF is no longer collected. It read non-zero on 6 of 1,153 rows
 * and all 6 were influencers.club; the cold fleet is structurally 0 because the
 * sending platforms use their own envelope-from, so SPF does not ALIGN to the
 * header domain. DKIM is signed and aligned, so DMARC passes via DKIM. Google
 * flags SPF_AND_DKIM for 2 of 180 domains, not 180 -- those two are caught by
 * the DMARC check below instead.
 */
const ACCEPTED_RISKS = {
  HONOR_UNSUBSCRIBE: 'accepted: unsubscribe link deliberately omitted from copy',
  SPF_AND_DKIM:      'accepted: SPF does not align for the cold fleet by design',
};

// Requirements that really are a configuration fault someone can fix.
const CONFIG_REQUIREMENTS = ['DMARC_POLICY', 'DMARC_ALIGNMENT', 'DNS_RECORDS', 'ENCRYPTION'];

/**
 * How Google's own verdict reason should colour our state. It is an overlay,
 * never the spine: 109 of 180 domains read SENDER_NOT_COMPLIANT, so a verdict
 * alone cannot be the ladder or almost the whole fleet would be throttled.
 */
const REASON_CLASS = {
  MESSAGE_VOLUME_LOW:     'unassessable',  // Google cannot judge — ~35% of the fleet
  USER_FEEDBACK_POSITIVE: 'protective',    // Google says recipients want this mail
  SENDER_NOT_COMPLIANT:   'confirming',
  SPAM_RATE_HIGH:         'confirming',
  USER_FEEDBACK_NEGATIVE: 'confirming',
  SMTP_ERRORS_HIGH:       'confirming',
};

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const isWorse = (a, b) => LADDER.indexOf(a) > LADDER.indexOf(b);
const escalate = (s, n) => LADDER[Math.min(LADDER.indexOf(s) + n, LADDER.length - 1)];

function daysBetween(a, b) {
  return Math.round(Math.abs(new Date(a) - new Date(b)) / 86400000);
}

/**
 * The days Google has actually published, decided by the FLEET.
 *
 * A single domain cannot tell you: one with no complaints looks identical on a
 * published day and an unpublished one. The fleet can -- on a real day 16 to 27
 * of ~100 reporting domains carry a non-zero spam rate, and on an unpublished
 * one every single domain reads 0. This is the same test the collect stage uses
 * to build "Avg Spam Rate (7d)", deliberately, so the two stages agree on which
 * days exist.
 */
function publishedDays(domains) {
  const days = new Set();
  for (const d of domains) {
    for (const r of (d.readings || [])) {
      if ((r.spamRate || 0) > 0) days.add(r.date);
    }
  }
  return days;
}

/**
 * Fleet-wide authentication incident: domains that reported VOLUME on a day and
 * still failed DMARC. Requiring volume is the whole point -- it is what a
 * reporting-lag day cannot produce, and what made v2 cry incident three times
 * in three weeks over nothing.
 */
function detectFleetAuthIncidents(domains, cfg) {
  const byDate = {};
  for (const d of domains) {
    for (const r of (d.readings || [])) {
      if (!(r.volume > 0)) continue;              // no measured mail, no verdict
      if (r.authDmarc === null || r.authDmarc === undefined) continue;
      const b = byDate[r.date] || (byDate[r.date] = { sending: 0, failing: 0, domains: [] });
      b.sending++;
      if (r.authDmarc === 0) { b.failing++; b.domains.push(d.domain); }
    }
  }
  const out = [];
  for (const [date, b] of Object.entries(byDate)) {
    if (b.sending < cfg.fleetAlertMinReporting) continue;
    const share = b.failing / b.sending;
    if (share <= cfg.fleetAuthAlertShare) continue;
    out.push({ date, share, sending: b.sending, failing: b.failing, domains: b.domains });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ───────────────────────────────────────────────────────────────────────────
// Per-domain evidence
// ───────────────────────────────────────────────────────────────────────────

/**
 * Everything the ladder needs, taken from readings on PUBLISHED days only.
 *
 * The mean is NOT computed here. It arrives as d.avgSpam7d from the mailbox
 * table, already correct. What is computed here is only what needs the daily
 * series: how often this domain draws complaints, how much mail it actually
 * sent, and whether it has turned sharply worse.
 */
function evidence(d, published, cfg) {
  const rows = (d.readings || []).filter(r => published.has(r.date));
  const spam = rows.map(r => r.spamRate).filter(v => v !== null && v !== undefined);
  const vols = rows.map(r => r.volume).filter(v => v !== null && v !== undefined);

  const nonZero = spam.filter(v => v > 0).length;
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? 1 : -1));   // newest first
  const recent = sorted.slice(0, cfg.spikeWindow)
    .map(r => r.spamRate).filter(v => v !== null && v !== undefined);
  const baseline = sorted.slice(cfg.spikeWindow)
    .map(r => r.spamRate).filter(v => v !== null && v !== undefined);

  const rMean = mean(recent), bMean = mean(baseline);
  const spiking = rMean !== null && bMean !== null &&
                  rMean >= cfg.spikeFloor && rMean >= bMean * cfg.spikeFactor;

  // Auth failure counted ONLY on days this domain actually sent. On a day with
  // no volume reading an auth rate of 0 means "Google published no auth for
  // this day", not "the mail was unsigned" -- counting those is what made v2
  // read the whole fleet as intermittently broken.
  const sendingRows = rows.filter(r => r.volume > 0 &&
                                       r.authDmarc !== null && r.authDmarc !== undefined);
  const authFailRate = sendingRows.length
    ? sendingRows.filter(r => r.authDmarc === 0).length / sendingRows.length
    : null;

  return {
    readingCount: spam.length,
    nonZeroCount: nonZero,
    hitRate:      spam.length ? nonZero / spam.length : null,
    totalVolume:  vols.reduce((s, v) => s + v, 0),
    sendingDays:  sendingRows.length,
    authFailRate,
    spiking,
    spikeRecentMean:   rMean,
    spikeBaselineMean: bMean,
  };
}

function configIssues(d, ev) {
  const issues = [];
  const reqs = (d.compliance && d.compliance.requirements) || {};

  for (const req of CONFIG_REQUIREMENTS) {
    if (reqs[req] === 'NEEDS_WORK') {
      issues.push({ code: req, detail: 'compliance requirement failing — needs a configuration fix' });
    }
  }

  // Mail that is sending and failing DMARC outright. Measured on sending days
  // only, so reporting lag cannot raise it. On this fleet exactly two domains
  // do this on every single day they send -- a DKIM signature not aligned to
  // the From domain. They need a DNS fix, not a throttle, which is why this is
  // a fix-queue item and not a ladder input.
  if (ev.authFailRate !== null && ev.authFailRate > 0.5 && ev.sendingDays >= 3) {
    issues.push({
      code: 'DMARC_FAILING_ON_SENDING_DAYS',
      detail: `DMARC failed on ${Math.round(ev.authFailRate * 100)}% of ` +
              `${ev.sendingDays} sending days — DKIM alignment, not a volume problem`,
    });
  }

  const accepted = Object.keys(reqs)
    .filter(k => reqs[k] === 'NEEDS_WORK' && ACCEPTED_RISKS[k])
    .map(k => ({ code: k, detail: ACCEPTED_RISKS[k] }));

  return { issues, accepted };
}

// ───────────────────────────────────────────────────────────────────────────
// Raw verdict
// ───────────────────────────────────────────────────────────────────────────

function rawState(d, ev, cfg) {
  const reasons = [];

  if (!d.inPlay) return { state: 'IDLE', reasons: [ADVICE.IDLE] };

  // The mean is the spine and it is not ours to invent. A domain without one
  // has no published readings, which for ~107 of 213 domains is a permanent and
  // entirely normal condition rather than something pending.
  const m = d.avgSpam7d;
  if (m === null || m === undefined) {
    return { state: 'INSUFFICIENT_DATA', reasons: ['no published spam reading — too little mail for Google to report'] };
  }
  if (ev.readingCount < cfg.minReadings) {
    return { state: 'INSUFFICIENT_DATA',
             reasons: [`only ${ev.readingCount} published readings (need ${cfg.minReadings})`] };
  }

  let state = m < cfg.spamMeanHealthy  ? 'HEALTHY'
            : m < cfg.spamMeanWatch    ? 'WATCH'
            : m < cfg.spamMeanThrottle ? 'THROTTLE'
            :                            'QUARANTINE';
  reasons.push(`7d mean ${m.toFixed(3)}% over ${ev.readingCount} published days`);

  if (isWorse(state, 'WATCH') && ev.nonZeroCount < cfg.minNonZeroReadings) {
    state = 'WATCH';
    reasons.push(`only ${ev.nonZeroCount} day with complaints — capped at WATCH pending corroboration`);
  }

  if (ev.hitRate !== null && ev.hitRate >= cfg.hitRateEscalate &&
      ev.nonZeroCount >= cfg.minNonZeroReadings && m >= cfg.spamMeanHealthy) {
    // Only ever raises, and only from below the ceiling. Clamping the RESULT
    // instead would pull a domain that earned QUARANTINE on magnitude back down
    // to the ceiling — an escalator that demotes.
    const ceiling = LADDER.indexOf(cfg.escalateCeiling);
    const pct = Math.round(ev.hitRate * 100);
    if (LADDER.indexOf(state) < ceiling) {
      state = LADDER[Math.min(LADDER.indexOf(state) + 1, ceiling)];
      reasons.push(`complaints on ${pct}% of published days (+1)`);
    } else {
      reasons.push(`complaints on ${pct}% of published days ` +
                   `(already at or above ${cfg.escalateCeiling} — no further escalation)`);
    }
  }

  // Volume gate. A rate computed on very little mail is a counter wearing a
  // percentage sign, and QUARANTINE is the state that gets a domain retired.
  if (state === 'QUARANTINE' && ev.totalVolume < cfg.quarantineMinVolume) {
    state = 'THROTTLE';
    reasons.push(`only ${ev.totalVolume} messages measured — capped at THROTTLE, ` +
                 'too little volume for the rate to be trustworthy');
  }

  if (ev.spiking) {
    reasons.push(`SPIKE: recent ${ev.spikeRecentMean.toFixed(2)}% vs baseline ` +
                 `${ev.spikeBaselineMean.toFixed(2)}% — investigate`);
  }

  const cls = REASON_CLASS[d.compliance && d.compliance.verdictReason];
  if (cls === 'protective' && isWorse(state, 'HEALTHY')) {
    state = LADDER[Math.max(LADDER.indexOf(state) - 1, 0)];
    reasons.push(`Google reports ${d.compliance.verdictReason} — softened one level`);
  } else if (cls === 'confirming' && isWorse(state, 'HEALTHY')) {
    reasons.push(`Google agrees: ${d.compliance.verdictReason}`);
  }

  return { state, reasons };
}

// ───────────────────────────────────────────────────────────────────────────
// Hysteresis — fast down, slow up (carried over from v2 intact)
// ───────────────────────────────────────────────────────────────────────────

function applyHysteresis(d, raw, prior, history, today, cfg) {
  if (!prior || !prior.state) {
    return { state: raw.state, changed: false, initial: true,
             reasons: [...raw.reasons, 'initial classification — baseline'] };
  }
  const current = prior.state;

  if (NON_LADDER.includes(raw.state) || NON_LADDER.includes(current)) {
    if (raw.state === current) return { state: current, changed: false, reasons: raw.reasons };
    // Returning to scoring after a gap, a domain is unproven: re-enter at WATCH
    // so it ramps rather than resuming at full confidence on thin evidence.
    if (NON_LADDER.includes(current) && raw.state === 'HEALTHY') {
      return { state: 'WATCH', changed: true,
               reasons: [...raw.reasons, `returning from ${current} — unproven, ramping`] };
    }
    return { state: raw.state, changed: true, reasons: raw.reasons };
  }

  if (current === 'QUARANTINE' && raw.state === 'QUARANTINE' && prior.stateSince) {
    const since = daysBetween(today, prior.stateSince);
    if (since >= cfg.retireAfterQuarantineDays) {
      return { state: 'RETIRE', changed: true,
               reasons: [...raw.reasons, `quarantined ${since}d — not recoverable by warming`] };
    }
  }

  if (raw.state === current) return { state: current, changed: false, reasons: raw.reasons };

  let streak = 1;
  for (const h of history.filter(h => h.domain === d.domain)
                          .sort((a, b) => (a.date < b.date ? 1 : -1))) {
    if (h.rawState === raw.state) streak++; else break;
  }

  if (isWorse(raw.state, current)) {
    if (streak >= cfg.demoteAfterDays) {
      return { state: raw.state, changed: true,
               reasons: [...raw.reasons, `${streak}d consecutive — demoting`] };
    }
    return { state: current, changed: false,
             reasons: [...raw.reasons, `worse but only ${streak}/${cfg.demoteAfterDays}d — holding`] };
  }
  if (streak >= cfg.promoteAfterDays) {
    return { state: LADDER[Math.max(LADDER.indexOf(current) - 1, 0)], changed: true,
             reasons: [...raw.reasons, `${streak}d better — promoting one level`] };
  }
  return { state: current, changed: false,
           reasons: [...raw.reasons, `better but only ${streak}/${cfg.promoteAfterDays}d — holding`] };
}

// ───────────────────────────────────────────────────────────────────────────
// Entry point
// ───────────────────────────────────────────────────────────────────────────

/**
 * Returns a PROPOSAL. Nothing in here changes a sending platform.
 *
 *   proposals  every domain, with its state, the advice for a human, and why
 *   urgent     the short list a person must actually see this morning
 *   fixQueue   configuration faults — a different job for a different person
 *   fleet      cross-fleet alerts, and the days excluded as unpublished
 *   counts     steady-state totals, so "107 unassessable" reads as normal
 */
function decide({ domains, priorStates = {}, history = [], today, config = CONFIG }) {
  const cfg = { ...CONFIG, ...config };
  const published = publishedDays(domains);
  const fleetIncidents = detectFleetAuthIncidents(domains, cfg);

  const proposals = [], fixQueue = [], urgent = [];
  const counts = {};

  for (const d of domains) {
    const ev = evidence(d, published, cfg);
    const { issues, accepted } = configIssues(d, ev);
    const raw = rawState(d, ev, cfg);
    const decided = applyHysteresis(d, raw, priorStates[d.domain], history, today, cfg);

    const p = {
      domain: d.domain,
      state: decided.state,
      rawState: raw.state,
      changed: !!decided.changed,
      initial: !!decided.initial,
      advice: ADVICE[decided.state],
      reasons: decided.reasons,
      avgSpam7d: d.avgSpam7d,
      readings: ev.readingCount,
      volume: ev.totalVolume,
      spiking: ev.spiking,
      acceptedRisks: accepted,
    };
    proposals.push(p);
    counts[decided.state] = (counts[decided.state] || 0) + 1;

    for (const i of issues) fixQueue.push({ domain: d.domain, ...i });

    // What a person must see today: a domain that got worse, a sharp onset, or
    // anything sitting at the top of the ladder. Deliberately narrow -- a list
    // nobody reads is worse than no list, and nothing here is automatic, so the
    // only cost of a quiet day is a quiet day.
    if ((decided.changed && isWorse(decided.state, 'WATCH')) ||
        ev.spiking ||
        ['QUARANTINE', 'RETIRE'].includes(decided.state)) {
      urgent.push({
        domain: d.domain, state: decided.state, advice: ADVICE[decided.state],
        why: ev.spiking ? 'sharp onset' : decided.changed ? 'state got worse' : 'at the top of the ladder',
        avgSpam7d: d.avgSpam7d, volume: ev.totalVolume,
      });
    }
  }

  // Worst first, then by volume: a bad domain sending a lot matters more than a
  // bad domain sending almost nothing.
  const rank = (a, b) => LADDER.indexOf(b.state) - LADDER.indexOf(a.state) ||
                         (b.volume || 0) - (a.volume || 0);
  urgent.sort(rank);
  proposals.sort(rank);

  return {
    today,
    advisory: true,          // v3 proposes; a human decides. Nothing here acts.
    proposals,
    urgent,
    fixQueue,
    counts,
    fleet: {
      authIncidents: fleetIncidents,
      publishedDays: [...published].sort(),
      // Days that appear in the readings but which Google had not published
      // when they were read. Reported, never alerted on: this is reporting lag,
      // not an event.
      unpublishedDays: [...new Set(domains.flatMap(d => (d.readings || []).map(r => r.date)))]
        .filter(day => !published.has(day)).sort(),
    },
  };
}

module.exports = {
  decide, CONFIG, LADDER, NON_LADDER, ADVICE, ACCEPTED_RISKS, CONFIG_REQUIREMENTS,
  publishedDays, detectFleetAuthIncidents, evidence, configIssues, rawState, applyHysteresis,
};
