'use strict';
/**
 * Decide v4 — proposes a health state per domain. It never acts.
 *
 * WHAT CHANGED FROM v3, AND WHY
 *
 * v3 scored the ladder on "Avg Spam Rate (7d)", the mean of the daily
 * percentages. That mean is biased low whenever volume varies, because a
 * low-volume day contributes a 0 with the same weight as a full day's real
 * reading. Measured on the Persona Space domains over 2026-10-12..23:
 *
 *     domain                 daily mean   pooled   v3 state -> v4 state
 *     creatorpersona.com         1.32%     1.77%   THROTTLE -> QUARANTINE
 *     personaspaceapp.com        0.64%     0.87%   WATCH    -> THROTTLE
 *     usepersonaspace.com        0.42%     0.72%   WATCH    -> WATCH
 *
 * v4 pools instead: complaints are reconstructed per day as rate x sent, then
 * summed over the window and divided by total sent. One rate, one denominator,
 * no weighting artefact. The daily column stays in Notion for a human to
 * eyeball; it is no longer what the ladder reads.
 *
 * THE FAILURE THAT FORCED THIS
 *
 * Google reports SPAM_RATE as 0.00 below roughly 300 sends/day rather than
 * omitting it. Measured across the fleet: of 183 domain-days between 150 and
 * 299 sends, 183 reported exactly zero. v3 read that as a measured zero, so a
 * domain had only to be throttled to score HEALTHY.
 *
 * That is not hypothetical. madison@getpersonaspace.com ran six weeks at a
 * 2.2% pooled complaint rate; a GlockApps seed test on 2026-10-27 put 20 of 20
 * seeds in spam -- the domain was entirely filtered. Throttling it to 100/day
 * would have moved v3's reading to 0.00% and its state to HEALTHY on the next
 * run. The system would have congratulated us for burning a domain.
 *
 * So v4 never infers health from a low reading alone. It asks what the data
 * can RULE OUT: with k complaints over N sends, the 95% upper bound on the true
 * rate. A domain is HEALTHY only when that bound sits under the policy line.
 * When it does not, the state is LOW_VOLUME and carries the bound itself --
 * "<=1.0%, cannot rule out a problem" -- which is a different thing from both
 * "fine" and "broken", and was previously indistinguishable from "fine".
 *
 * WHAT v3 GOT RIGHT AND v4 KEEPS
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

  // ── Confidence ──
  //
  // A rate is only as good as the mail it was measured over. These turn "the
  // reading is 0" into "the rate is at most X", which is the statement that
  // can actually be acted on. 95% is conventional and the arithmetic is the
  // rule of three (k=0) or a normal approximation on the Poisson count (k>0).
  //
  // Nothing here invents a threshold: the bound is compared against the same
  // policy line as the rate itself. The only judgement is that we refuse to
  // call a domain healthy on evidence that cannot distinguish it from a
  // domain at the line.
  confidenceZ: 1.96,

  // ── Hard bounce ──
  //
  // Deliberately NOT calibrated on this fleet: the Mailjet counters are four
  // days old and a threshold fitted to four days is a threshold fitted to
  // noise. These are the external figures receivers publish -- 2% is where
  // list quality is called into question, 5% is where it is treated as abuse.
  // On this fleet nothing currently reaches 2% (worst is tools-forcreators.com
  // at 1.70%), which is the right property for a new signal: it fires on a
  // genuinely bad case rather than retrofitting the fleet we already have.
  // Bounce ONSET. The absolute lines above are a verdict on a level; this is a
  // verdict on a shape, and it fires below them. Mailjet reports same-day with
  // a real denominator at any volume, so a bounce rate CLIMBING is readable
  // well before it reaches 2% -- and a list going bad is a thing you want to
  // catch while it is going, not once it has gone.
  bounceSpikeWindow:  3,
  bounceSpikeFactor:  2.5,
  bounceSpikeFloor:   0.75,   // recent window must be genuinely elevated
  bounceSpikeMinSent: 300,    // ...on enough mail to be a rate, not a tally

  hardBounceWarn:   2.0,
  hardBounceSevere: 5.0,
  hardBounceMinSent: 500,   // same reasoning as the volume gate below

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
  //
  // Tiered by severity: the worse a domain looks, the less corroboration is
  // required before saying so. Four days is right for a domain hovering near
  // the line, where one noisy day would otherwise promote it; it is too slow
  // for a domain already at 1.5%+, where waiting two more days to confirm what
  // the data plainly says costs two more days of damage.
  //
  // This is affordable only because of the confidence bound above. The bound
  // already refuses to call a thin reading healthy, so the reading-count floor
  // no longer has to carry that job on its own and can be set by urgency.
  minReadings:         4,   // near the line — wait for corroboration
  minReadingsElevated: 3,   // at or above the WATCH band
  minReadingsSevere:   2,   // at or above the THROTTLE band — say it now
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
// LOW_VOLUME is deliberately NOT on the ladder. It is not a severity between
// HEALTHY and WATCH -- it is the absence of a verdict. Putting it on the ladder
// would let hysteresis promote a domain "up" into health it never demonstrated.
const NON_LADDER = ['IDLE', 'INSUFFICIENT_DATA', 'LOW_VOLUME'];

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
  INSUFFICIENT_DATA: 'no published reading at all — normal for a quiet domain, not a fault',
  LOW_VOLUME:        'not enough mail to tell healthy from harmful — send more, or seed-test it',
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
 * A hard bounce rate CLIMBING against its own recent baseline.
 *
 * Deliberately a shape rather than a level, and deliberately not borrowed from
 * the spam spike detector: the spam rate is Google's aggregate with a floor
 * under it and days of lag, while this is a plain ratio of two Mailjet counters
 * on the same day. It can be trusted at a finer grain than the spam rate can.
 *
 * A rise from exactly zero counts -- `base * factor` is then 0, and any recent
 * rate clears it. That is intended: zero to 1% is the clearest onset there is.
 */
function bounceOnset(mjRows, cfg) {
  const sorted = [...mjRows].sort((a, b) => (a.date < b.date ? 1 : -1));  // newest first
  const rate = rs => {
    const sent = rs.reduce((t, r) => t + (r.sent || 0), 0);
    if (!sent) return null;
    return { pct: (rs.reduce((t, r) => t + (r.hardBounced || 0), 0) / sent) * 100, sent };
  };
  const R = rate(sorted.slice(0, cfg.bounceSpikeWindow));
  const B = rate(sorted.slice(cfg.bounceSpikeWindow));
  if (!R || !B) return null;                          // no baseline to rise from
  if (R.sent < cfg.bounceSpikeMinSent) return null;   // a tally, not a rate
  if (R.pct < cfg.bounceSpikeFloor) return null;      // movement inside the noise
  if (R.pct < B.pct * cfg.bounceSpikeFactor) return null;
  return { recentPct: R.pct, baselinePct: B.pct, recentSent: R.sent };
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
/**
 * Pooled complaint rate and what it can rule out.
 *
 * Reconstructs the complaint COUNT per day (rate x sent) and pools it, rather
 * than averaging the daily percentages. Returns the rate, the denominator it
 * was measured over, and the 95% upper bound on the true rate.
 *
 * The bound is what makes a low reading interpretable. 0 complaints over 900
 * sends and 0 complaints over 14,000 sends are the same percentage and very
 * different facts: the first rules out nothing below 0.33%, the second rules
 * out anything above 0.02%.
 *
 * `sent` is Mailjet's count, not Postmaster's "Message Volume" -- that one is
 * a TLS-inbound proxy that reads 0 fleet-wide on some days, which would
 * silently drop real days out of the denominator.
 */
function pooled(rows, cfg) {
  let complaints = 0, sent = 0, days = 0;
  for (const r of rows) {
    if (r.spamRate === null || r.spamRate === undefined) continue;
    if (!(r.sent > 0)) continue;          // no denominator, no contribution
    complaints += (r.spamRate / 100) * r.sent;
    sent += r.sent;
    days++;
  }
  if (!sent) return { rate: null, sent: 0, complaints: 0, days: 0, upperBound: null };

  // k = 0 is the rule of three: with no events in N trials the 95% bound on the
  // rate is 3/N. For k > 0 a normal approximation on the Poisson count is close
  // enough at these magnitudes and keeps the arithmetic inspectable.
  const k = complaints;
  const upper = k === 0 ? 3 / sent
                        : (k + cfg.confidenceZ * Math.sqrt(k)) / sent;
  return {
    rate:       (complaints / sent) * 100,
    sent, complaints, days,
    upperBound: upper * 100,
  };
}

function evidence(d, published, cfg) {
  // Two different windows, on purpose.
  //
  // `rows` is what GOOGLE published, and the spam rate, auth and volume figures
  // are computed over it because those are Google's to publish.
  //
  // `mjRows` is what MAILJET recorded, and is NOT filtered by Google's
  // publication at all. Postmaster runs about four days behind; filtering the
  // Mailjet counters through Google's published set threw away the four
  // freshest days on every domain, every run -- the newest and most specific
  // data we hold, discarded because a different provider had not caught up.
  const rows = (d.readings || []).filter(r => published.has(r.date));
  const mjRows = (d.readings || []).filter(r => r.sent > 0);
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

  // Mailjet counters, pooled over the same rows. Context for a human now; see
  // "FUTURE SIGNALS" at the foot of this file for what would have to be true
  // before any of them earns a place in the ladder.
  const sum = key => mjRows.reduce((t, r) => t + (r[key] || 0), 0);
  const latest = rs => (rs.length ? rs.map(r => r.date).sort().slice(-1)[0] : null);
  const mjThrough = latest(mjRows), pmThrough = latest(rows);
  const mjSent = sum('sent');
  const pct = n => (mjSent ? (n / mjSent) * 100 : null);

  return {
    pooled: pooled(rows, cfg),
    mjSent,
    hardBounced: sum('hardBounced'), hardBouncePct: pct(sum('hardBounced')),
    blocked:     sum('blocked'),     blockedPct:    pct(sum('blocked')),
    unsubscribed: sum('unsubscribed'), unsubPct:    pct(sum('unsubscribed')),
    mjDays: mjRows.length,
    bounceOnset: bounceOnset(mjRows, cfg),
    // So a human can see at a glance which provider each figure came from and
    // how stale it is. These routinely differ by ~4 days.
    mjThrough, pmThrough,
    mjDaysAhead: (mjThrough && pmThrough) ? daysBetween(pmThrough, mjThrough) : null,
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
// Hard bounces. Not part of the spam ladder and not calibrated on this
// fleet: these are the external figures receivers publish, and they are
// reported alongside rather than folded into the complaint rate because they
// are a different fault with a different fix. A domain can have a perfect
// complaint rate and still be burning its reputation on invalid addresses,
// which no Postmaster metric would show.
//
// This reads Mailjet, not Postmaster: every send, every receiver, with no
// dependence on Google publishing anything. So it is deliberately computed
// before the spam rate is even consulted. A domain whose Gmail reading is
// unpublished, too thin or too new is unmeasurable on COMPLAINTS only -- its
// bounce rate is measured just the same, and dropping that signal because
// Google was quiet would throw away the one fault we can still see.
// `tools-forcreators.com` is exactly this shape: 1.70% hard bounce, 3.94%
// blocked, 0.00% Gmail spam.
//
// Never reaches RETIRE. RETIRE proposes replacing the domain, and a bounce
// problem is a list problem: fixable by whoever sourced the addresses,
// without burning the domain.
function bounceVerdict(ev, cfg) {
  if (ev.hardBouncePct === null || ev.mjSent < cfg.hardBounceMinSent) return null;
  const tail = `(${ev.hardBounced} of ${ev.mjSent})`;
  if (ev.hardBouncePct >= cfg.hardBounceSevere) {
    return { level: 'QUARANTINE',
             reason: `HARD BOUNCE ${ev.hardBouncePct.toFixed(2)}% ${tail} — at or above ` +
                     `the ${cfg.hardBounceSevere}% level receivers treat as abuse. ` +
                     'Stop and fix the list; the copy is not the problem.' };
  }
  if (ev.hardBouncePct >= cfg.hardBounceWarn) {
    return { level: 'THROTTLE',
             reason: `hard bounce ${ev.hardBouncePct.toFixed(2)}% ${tail} — above the ` +
                     `${cfg.hardBounceWarn}% level that calls list quality into question` };
  }
  // Below both lines, a rate on the way up is still a list going bad. WATCH is
  // the honest level for it: elevated, worth a look, not yet an action.
  const on = ev.bounceOnset;
  if (on) {
    return { level: 'WATCH',
             reason: `hard bounce RISING — ${on.recentPct.toFixed(2)}% over the last ` +
                     `${cfg.bounceSpikeWindow} Mailjet days against ${on.baselinePct.toFixed(2)}% ` +
                     `before them (${on.recentSent.toLocaleString()} sent). Below the ` +
                     `${cfg.hardBounceWarn}% line, but moving toward it.` };
  }
  return null;
}

// Raw verdict
// ───────────────────────────────────────────────────────────────────────────

function rawState(d, ev, cfg) {
  const reasons = [];

  if (!d.inPlay) return { state: 'IDLE', reasons: [ADVICE.IDLE] };

  // Measured independently of Postmaster, so it stands even when the spam rate
  // does not. Where the complaint rate is unmeasurable, this is the verdict;
  // where it is measurable, it raises it below.
  const HB = bounceVerdict(ev, cfg);
  const onBouncesAlone = (why) => ({
    state: HB.level,
    reasons: [HB.reason, `${why} — this verdict rests on bounces alone.`],
  });

  // The mean is the spine and it is not ours to invent. A domain without one
  // has no published readings, which for ~107 of 213 domains is a permanent and
  // entirely normal condition rather than something pending.
  const P = ev.pooled;
  if (P.rate === null) {
    const why = 'no published reading with a measured denominator';
    if (HB) return onBouncesAlone(why);
    return { state: 'INSUFFICIENT_DATA', reasons: [why] };
  }
  const m = P.rate;

  // How much corroboration this reading needs depends on what it says. The
  // rate has to be computed first to know which tier applies, which is why
  // this gate sits below rather than above it.
  const need = m >= cfg.spamMeanThrottle ? cfg.minReadingsSevere
             : m >= cfg.spamMeanWatch    ? cfg.minReadingsElevated
             :                             cfg.minReadings;
  if (ev.readingCount < need) {
    const why = `only ${ev.readingCount} published readings ` +
                `(need ${need} at ${m.toFixed(2)}%)`;
    if (HB) return onBouncesAlone(why);
    return { state: 'INSUFFICIENT_DATA', reasons: [why] };
  }
  let state = m < cfg.spamMeanHealthy  ? 'HEALTHY'
            : m < cfg.spamMeanWatch    ? 'WATCH'
            : m < cfg.spamMeanThrottle ? 'THROTTLE'
            :                            'QUARANTINE';
  reasons.push(`pooled ${m.toFixed(3)}% — ${Math.round(P.complaints)} complaints ` +
               `over ${P.sent.toLocaleString()} sent across ${P.days} days`);

  // The banded state. A reading under the line is only HEALTHY when the
  // evidence can actually distinguish it from a domain sitting ON the line.
  // Below that, the honest answer is the bound, and the bound is not a
  // severity -- it is the absence of a verdict, which is why LOW_VOLUME is off
  // the ladder and returns here rather than falling through to hysteresis.
  if (state === 'HEALTHY' && P.upperBound > cfg.spamMeanHealthy) {
    const thin = `pooled ${m.toFixed(3)}% over only ${P.sent.toLocaleString()} sent — ` +
                 `the most this rules out is ${P.upperBound.toFixed(2)}%`;
    if (HB) return { ...onBouncesAlone(thin), pooled: P };
    return {
      state: 'LOW_VOLUME',
      reasons: [`pooled ${m.toFixed(3)}% over only ${P.sent.toLocaleString()} sent — ` +
                `the most this rules out is ${P.upperBound.toFixed(2)}%, ` +
                `which does not clear the ${cfg.spamMeanHealthy}% line. Not a fault; ` +
                'not evidence of health either.'],
      pooled: P,
    };
  }
  if (state === 'HEALTHY') {
    reasons.push(`rules out anything above ${P.upperBound.toFixed(3)}%`);
  }

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
  // Measured on Mailjet's sent count. v3 used Postmaster's "Message Volume",
  // which is a TLS-inbound proxy that reads 0 fleet-wide on some days -- a
  // domain could be capped for "low volume" on a day it sent thousands.
  if (state === 'QUARANTINE' && P.sent < cfg.quarantineMinVolume) {
    state = 'THROTTLE';
    reasons.push(`only ${P.sent} messages sent — capped at THROTTLE, ` +
                 'too little volume for the rate to be trustworthy');
  }

  // The bounce verdict, computed at the top, raises the complaint state but
  // never lowers it: the two are separate faults and the worse one governs.
  if (HB) {
    if (isWorse(HB.level, state)) state = HB.level;
    reasons.push(HB.reason);
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
      // The pooled rate is what the ladder read; avgSpam7d rides along so a
      // human can see the daily column they are used to and the figure that
      // was actually scored, side by side.
      pooledSpam:  ev.pooled.rate,
      upperBound:  ev.pooled.upperBound,
      complaints:  Math.round(ev.pooled.complaints),
      sent:        ev.pooled.sent,
      avgSpam7d:   d.avgSpam7d,
      readings: ev.readingCount,
      volume: ev.totalVolume,
      spiking: ev.spiking,
      // Context, not score. See FUTURE SIGNALS.
      hardBouncePct: ev.hardBouncePct,
      mjSent:        ev.mjSent,
      bounceOnset:   ev.bounceOnset,
      mjThrough:     ev.mjThrough,
      pmThrough:     ev.pmThrough,
      blockedPct:    ev.blockedPct,
      unsubPct:      ev.unsubPct,
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
        ev.spiking || ev.bounceOnset ||
        ['QUARANTINE', 'RETIRE'].includes(decided.state)) {
      urgent.push({
        domain: d.domain, state: decided.state, advice: ADVICE[decided.state],
        // A bounce onset is listed on its own merit, not as a footnote to the
        // spam rate: it is same-day where the spam rate is four days old, so it
        // is routinely the only thing here that reflects what is happening now.
        why: ev.spiking         ? 'complaint rate spiking'
           : ev.bounceOnset     ? 'hard bounce rising'
           : decided.changed    ? 'state got worse'
           :                      'at the top of the ladder',
        pooledSpam: ev.pooled.rate, sent: ev.pooled.sent, volume: ev.totalVolume,
        hardBouncePct: ev.hardBouncePct, mjThrough: ev.mjThrough, pmThrough: ev.pmThrough,
      });
    }
  }

  // Worst first, then by volume: a bad domain sending a lot matters more than a
  // bad domain sending almost nothing.
  const rank = (a, b) => LADDER.indexOf(b.state) - LADDER.indexOf(a.state) ||
                         (b.sent || b.volume || 0) - (a.sent || a.volume || 0);
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

/* ───────────────────────────────────────────────────────────────────────────
 * FUTURE SIGNALS — what would have to be true before these score
 *
 * Mailjet gives seven counters per domain per day. Only `sent` (as the pooled
 * denominator) and `hardBounced` (against an external threshold) are used
 * above. The rest are carried on every proposal as context and score nothing,
 * on purpose: they are days old, and a threshold fitted to days of data is a
 * threshold fitted to noise.
 *
 * What each would need, concretely:
 *
 *   unsubscribed — the most promising. It is the only engagement-shaped signal
 *     we collect: it requires a recipient to SEE the mail and dislike it, so
 *     unlike the complaint rate it cannot be suppressed by Gmail filtering.
 *     That makes a FALLING unsub rate on steady volume a candidate proxy for
 *     the placement collapse Postmaster cannot see. Needs: ~6 weeks of history,
 *     then check whether unsub/sent fell ahead of the known open-rate drops on
 *     getpersonaspace.com and creatorpersona.com. If it leads, it belongs in
 *     the ladder; if it merely tracks, it stays context.
 *
 *   blocked — Mailjet's own suppression list being hit means the source list
 *     is re-feeding addresses already known bad. A rising rate is a list-
 *     hygiene fault, not a reputation one, so it belongs in the fix queue
 *     rather than the ladder. Needs: a baseline per sending platform, since
 *     each account has its own suppression history and they are not
 *     comparable to each other.
 *
 *   softBounced / deferred — sustained deferrals are a receiver throttling us,
 *     which historically precedes blocking. The signal is in the SHAPE (a step
 *     change against that domain's own baseline), not the level, so it needs
 *     per-domain history rather than a fleet threshold. Promising as an early
 *     warning; useless as an absolute number.
 *
 *   spamComplaints — Mailjet's feedback loops exclude Gmail entirely (7 events
 *     against 315,632 sent fleet-wide). Worth keeping only to cover non-Gmail
 *     receivers that Postmaster cannot see at all. Would need the fleet to send
 *     meaningfully outside Gmail before it says anything.
 *
 * The honest sequencing: none of these should enter the ladder until it can be
 * shown, on recorded history, that they would have fired before the thing they
 * are meant to predict. We now have the collection to check that in six weeks.
 * ─────────────────────────────────────────────────────────────────────────── */

module.exports = {
  decide, CONFIG, LADDER, NON_LADDER, ADVICE, ACCEPTED_RISKS, CONFIG_REQUIREMENTS,
  publishedDays, detectFleetAuthIncidents, evidence, configIssues, rawState,
  bounceVerdict, bounceOnset,
  applyHysteresis, pooled,
};
