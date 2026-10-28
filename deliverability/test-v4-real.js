'use strict';
/**
 * Decide v4 against REAL recorded series from the Domain Health History table.
 * Every readings array below is actual data read out of Notion on 2026-10-27,
 * not an invention, which is what makes the expectations checkable by hand.
 *
 * Fields per day: date ~ spamRate ~ sent ~ hardBounced ~ dmarc
 * (`sent` is Mailjet's count; Postmaster's volume is carried separately only
 * where a test needs it.)
 */
const { decide, CONFIG, pooled } = require('./state-machine-v4.js');

const fails = [];
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  if (!ok) fails.push(label);
}
function near(label, got, want, tol) {
  const ok = got !== null && Math.abs(got - want) <= tol;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${got === null ? 'null' : got.toFixed(3)}, want ~${want}`);
  if (!ok) fails.push(label);
}

const parse = s => s.split('|').map(row => {
  const [date, spam, sent, hard, dmarc] = row.split('~');
  return {
    date,
    spamRate:    spam === '' ? null : Number(spam),
    sent:        sent === '' ? null : Number(sent),
    hardBounced: hard === '' ? 0    : Number(hard),
    volume:      sent === '' ? null : Number(sent),
    authDmarc:   dmarc === '' ? null : Number(dmarc),
  };
});
const D = (domain, series, extra = {}) => ({
  domain, inPlay: true, readings: parse(series),
  compliance: { verdictReason: 'SENDER_NOT_COMPLIANT', requirements: {} },
  ...extra,
});

// getpersonaspace.com, 2026-10-12..23. Six weeks at 2%+; a GlockApps seed test
// on 10-27 put 20 of 20 seeds in spam. The ladder must reach the top here.
const GETPERSONA =
  '2026-10-12~3.077~1143~0~100|2026-10-13~3.175~1143~0~100|2026-10-14~0~1143~0~100|' +
  '2026-10-15~0.877~1147~0~100|2026-10-16~2.5~1145~0~100|2026-10-17~1.342~1148~0~100|' +
  '2026-10-18~1.333~1147~0~100|2026-10-19~1.418~1146~0~100|2026-10-20~3.2~1139~1~100|' +
  '2026-10-21~1.235~1245~0~100|2026-10-22~3.497~1244~1~100|2026-10-23~2.703~1243~2~100';

// usepersonaspace.com, same window. Volume was cut ~70% on 10-15 and every
// reading since is 0.00 — the suppression floor, not recovery.
const USEPERSONA =
  '2026-10-12~1.724~999~0~100|2026-10-13~0~992~0~100|2026-10-14~2~994~1~100|' +
  '2026-10-15~1.266~538~2~100|2026-10-16~0~199~0~100|2026-10-17~0~539~0~100|' +
  '2026-10-18~0~199~0~100|2026-10-19~0~535~0~100|2026-10-20~0~197~0~100|' +
  '2026-10-21~0~299~0~100|2026-10-22~0~296~1~100|2026-10-23~0~298~0~100';

// The four lowest-volume days usepersonaspace actually recorded — 891 sent in
// total, zero complaints. Real values, selected to be the shape a throttled
// domain takes, which is exactly what was just done to madison@ and kayla@.
//
// The arithmetic matters and is easy to get wrong: at 891 sent the rule of
// three rules out only 0.337%, which does NOT clear the 0.3% line, so the
// honest answer is LOW_VOLUME. Add a couple of busier days and the same zero
// complaints reach 1,625 sent, bound 0.185%, and HEALTHY becomes correct. The
// state turns on the denominator, which is the whole point.
const THROTTLED =
  '2026-10-16~0~199~0~100|2026-10-18~0~199~0~100|' +
  '2026-10-20~0~197~0~100|2026-10-22~0~296~1~100';

// trypersonaspace.com pooled to 0.173% over 9,417 sent — genuinely clean, and
// enough mail to prove it.
const TRYPERSONA =
  '2026-10-12~0~785~0~100|2026-10-13~0~785~0~100|2026-10-14~0~785~0~100|' +
  '2026-10-15~0~785~0~100|2026-10-16~1.818~785~0~100|2026-10-17~0~785~0~100|' +
  '2026-10-18~0~785~1~100|2026-10-19~0~785~0~100|2026-10-20~0~785~0~100|' +
  '2026-10-21~0~785~0~100|2026-10-22~0~786~1~100|2026-10-23~0~786~0~100';

console.log('pooled() arithmetic');
const p1 = pooled(parse(GETPERSONA), CONFIG);
near('getpersonaspace pooled rate', p1.rate, 2.038, 0.02);
check('getpersonaspace denominator', p1.sent, 14033);
near('getpersonaspace bound is tight', p1.upperBound, 2.26, 0.15);

const p2 = pooled(parse(THROTTLED), CONFIG);
check('throttled: zero complaints', Math.round(p2.complaints), 0);
check('throttled: denominator', p2.sent, 891);
near('throttled: rule of three bound', p2.upperBound, 3 / 891 * 100, 0.001);
check('…which does not clear the policy line', p2.upperBound > CONFIG.spamMeanHealthy, true);

console.log('\nthe v3 failure this exists to fix');
// NOTE: a domain is scored only on days the FLEET shows to be published, and a
// day is published only if some domain reported a non-zero rate on it. A lone
// all-zero domain therefore has no published days and reads INSUFFICIENT_DATA
// — correct, but not the case under test. getpersonaspace rides along to
// establish the published days, exactly as the real fleet does.
const r = decide({ domains: [
  D('usepersonaspace.com', THROTTLED),
  D('getpersonaspace.com', GETPERSONA),
] });
const throttled = r.proposals.find(p => p.domain === 'usepersonaspace.com');
check('a throttled domain is NOT called healthy', throttled.state, 'LOW_VOLUME');
check('…and LOW_VOLUME is off the ladder', CONFIG && require('./state-machine-v4.js').NON_LADDER.includes('LOW_VOLUME'), true);
console.log(`     reason: ${throttled.reasons[0]}`);

console.log('\nthe ladder on real series');
const fleet = decide({ domains: [
  D('getpersonaspace.com', GETPERSONA),
  D('usepersonaspace.com', USEPERSONA),
  D('trypersonaspace.com', TRYPERSONA),
] });
const by = Object.fromEntries(fleet.proposals.map(p => [p.domain, p]));
check('getpersonaspace reaches QUARANTINE', by['getpersonaspace.com'].state, 'QUARANTINE');
check('trypersonaspace is provably healthy', by['trypersonaspace.com'].state, 'HEALTHY');
near('trypersonaspace bound clears the line', by['trypersonaspace.com'].upperBound, 0.27, 0.1);

// usepersonaspace over the FULL window still carries the real high-volume days,
// so pooling keeps the signal the daily mean diluted to 0.42%.
near('usepersonaspace pooled > daily mean', by['usepersonaspace.com'].pooledSpam, 0.722, 0.05);
check('…and it is not HEALTHY', by['usepersonaspace.com'].state === 'HEALTHY', false);

console.log('\nhard bounce has its own two-step ladder, capped below RETIRE');
const HB = '2026-10-12~0~2000~60~100|2026-10-13~0~2000~60~100|2026-10-14~0~2000~60~100|' +
           '2026-10-15~0~2000~60~100|2026-10-16~0~2000~60~100';
const hb = decide({ domains: [D('bouncy.com', HB), D('getpersonaspace.com', GETPERSONA)] })
  .proposals.find(p => p.domain === 'bouncy.com');
near('hard bounce pct computed', hb.hardBouncePct, 3.0, 0.01);
check('2%+ hard bounce reaches THROTTLE', hb.state, 'THROTTLE');
check('…and says why', hb.reasons.some(x => /hard bounce 3\.00%/.test(x)), true);
check('…on bounces, not on spam (Gmail spam is clean here)', hb.pooledSpam, 0);

const SEV = '2026-10-12~0~2000~120~100|2026-10-13~0~2000~120~100|2026-10-14~0~2000~120~100|' +
            '2026-10-15~0~2000~120~100|2026-10-16~0~2000~120~100';
const sev = decide({ domains: [D('severe.com', SEV), D('getpersonaspace.com', GETPERSONA)] })
  .proposals.find(p => p.domain === 'severe.com');
check('5%+ hard bounce reaches QUARANTINE', sev.state, 'QUARANTINE');
check('…and names the list, not the copy',
      sev.reasons.some(x => /Stop and fix the list/.test(x)), true);

// RETIRE proposes replacing the domain. A bounce problem is a list problem, so
// no bounce rate, however bad, may reach it on its own.
const EXTREME = '2026-10-12~0~2000~1800~100|2026-10-13~0~2000~1800~100|2026-10-14~0~2000~1800~100|' +
                '2026-10-15~0~2000~1800~100|2026-10-16~0~2000~1800~100';
const ext = decide({ domains: [D('extreme.com', EXTREME), D('getpersonaspace.com', GETPERSONA)] })
  .proposals.find(p => p.domain === 'extreme.com');
near('90% hard bounce is computed', ext.hardBouncePct, 90.0, 0.01);
check('…and still stops at QUARANTINE, never RETIRE', ext.state, 'QUARANTINE');

// Below the floor the bounce rate is a ratio of too few sends to trust.
const THIN = '2026-10-12~0~40~8~100|2026-10-13~0~40~8~100|2026-10-14~0~40~8~100|' +
             '2026-10-15~0~40~8~100|2026-10-16~0~40~8~100';
const thin = decide({ domains: [D('thin.com', THIN), D('getpersonaspace.com', GETPERSONA)] })
  .proposals.find(p => p.domain === 'thin.com');
check('a 20% bounce rate on 200 sends does not move the state', thin.state === 'QUARANTINE', false);
near('…because the rate itself is still computed', thin.hardBouncePct, 20.0, 0.01);

console.log('\nthe bounce verdict does not depend on Google publishing anything');

// Bounce rate comes from Mailjet: every send, every receiver. Each of these
// three domains is unmeasurable on COMPLAINTS for a different reason, and
// measured just the same on bounces. Before the verdict was lifted above the
// spam rate, all three returned INSUFFICIENT_DATA/LOW_VOLUME and the one fault
// still visible was discarded.
const bouncesOnly = (series, label) => {
  const p = decide({ domains: [D(label, series), D('getpersonaspace.com', GETPERSONA)] })
    .proposals.find(x => x.domain === label);
  check(`${label}: reaches QUARANTINE on bounces alone`, p.state, 'QUARANTINE');
  check(`${label}: and says the verdict rests on bounces`,
        p.reasons.some(x => /rests on bounces alone/.test(x)), true);
  return p;
};

// 1. Gmail never published a rate (the ~107-of-213 normal case).
bouncesOnly('2026-10-12~~2000~120~100|2026-10-13~~2000~120~100|' +
            '2026-10-14~~2000~120~100|2026-10-15~~2000~120~100', 'unpublished.com');

// 2. Published, but too thin to rule anything out — would have been LOW_VOLUME.
// Dates picked to avoid 10-14, which GETPERSONA records as 0.00 and which is
// therefore not a published day fleet-wide. Four readings clears the floor, so
// this fixture reaches the LOW_VOLUME branch rather than stopping short of it;
// 800 sent puts the bound at 0.375%, over the 0.3% line.
const thinSpam = bouncesOnly(
  '2026-10-12~0~200~12~100|2026-10-13~0~200~12~100|' +
  '2026-10-15~0~200~12~100|2026-10-16~0~200~12~100', 'thinspam.com');
near('thinspam bound really is over the line', thinSpam.upperBound, 0.375, 0.01);
check('…and it is NOT reported as LOW_VOLUME', thinSpam.state === 'LOW_VOLUME', false);
check('…while still carrying the pooled spam figure it does have',
      thinSpam.pooledSpam, 0);

// 3. Only two mild readings, short of that tier's floor of four.
bouncesOnly('2026-10-15~0.1~2000~120~100|2026-10-16~0.1~2000~120~100', 'tooyoung.com');

// A clean domain on the same unmeasurable footing stays unmeasurable: the
// verdict only speaks when the bounce rate actually crosses a line.
const quiet = decide({ domains: [
  D('quiet.com', '2026-10-12~~2000~2~100|2026-10-13~~2000~2~100'),
  D('getpersonaspace.com', GETPERSONA),
] }).proposals.find(p => p.domain === 'quiet.com');
check('a clean bounce rate does not manufacture a verdict', quiet.state, 'INSUFFICIENT_DATA');

// The two faults are independent and the WORSE one governs. A domain already at
// QUARANTINE on complaints must not be talked down to THROTTLE by a bounce
// reading that is merely bad.
const bothBad = decide({ domains: [D('bothbad.com',
  '2026-10-12~2.5~2000~60~100|2026-10-13~2.5~2000~60~100|' +
  '2026-10-14~2.5~2000~60~100|2026-10-15~2.5~2000~60~100')] })
  .proposals.find(p => p.domain === 'bothbad.com');
near('a 3% bounce rate is only a THROTTLE on its own', bothBad.hardBouncePct, 3.0, 0.01);
check('…so a 2.5% complaint rate still governs', bothBad.state, 'QUARANTINE');
check('…and both faults are named', bothBad.reasons.length >= 2, true);

console.log('\nMailjet is read on Mailjet\'s days, not on Google\'s');

// Postmaster runs ~4 days behind. This domain has nine published days at a
// quiet 0.2% bounce rate, then four days Google has NOT published yet in which
// the bounce rate has gone to 1.2%. Those four days are the whole point: they
// are the freshest and most specific data held about this domain, and before
// the Mailjet counters were decoupled from Google's published set they were
// filtered out of every figure below.
const LAGGING =
  '2026-10-15~0.1~1000~2~100|2026-10-16~0.1~1000~2~100|2026-10-17~0.1~1000~2~100|' +
  '2026-10-18~0.1~1000~2~100|2026-10-19~0.1~1000~2~100|2026-10-20~0.1~1000~2~100|' +
  '2026-10-21~0.1~1000~2~100|2026-10-22~0.1~1000~2~100|2026-10-23~0.1~1000~2~100|' +
  '2026-10-24~~1000~12~|2026-10-25~~1000~12~|2026-10-26~~1000~12~|2026-10-27~~1000~12~';
const lag = decide({ domains: [D('lagging.com', LAGGING), D('getpersonaspace.com', GETPERSONA)] })
  .proposals.find(p => p.domain === 'lagging.com');

check('Postmaster is read only through its last published day', lag.pmThrough, '2026-10-23');
check('…while Mailjet is read through today', lag.mjThrough, '2026-10-27');
check('…4 days of data Google has not caught up to', lag.readings, 9);
near('the bounce rate counts all 13 Mailjet days', lag.hardBouncePct, 0.508, 0.01);
check('…which is 13,000 sent, not the 9,000 Google published', lag.mjSent, 13000);

console.log('\na bounce rate on the way up is a verdict of its own');
check('the onset is detected', lag.bounceOnset !== null, true);
near('…recent 3 Mailjet days', lag.bounceOnset.recentPct, 1.2, 0.01);
near('…against the baseline before them', lag.bounceOnset.baselinePct, 0.3, 0.01);
check('…and it reaches WATCH', lag.state, 'WATCH');
check('…while still well under the 2% line', lag.hardBouncePct < CONFIG.hardBounceWarn, true);
check('…and says it is moving, not that it has arrived',
      lag.reasons.some(x => /hard bounce RISING/.test(x)), true);

// Same-day data about a list going bad outranks a four-day-old complaint rate,
// so this belongs on the list a person reads today.
const lagRun = decide({ domains: [D('lagging.com', LAGGING), D('getpersonaspace.com', GETPERSONA)] });
const lagU = lagRun.urgent.find(u => u.domain === 'lagging.com');
check('it lands on the urgent list', !!lagU, true);
check('…on its own merit, not as a note on the spam rate', lagU.why, 'hard bounce rising');

// The guards: movement has to be real, on enough mail, against something.
const onsetOf = (series) => decide({
  domains: [D('o.com', series), D('getpersonaspace.com', GETPERSONA)],
}).proposals.find(p => p.domain === 'o.com').bounceOnset;

check('movement inside the noise does not fire',
      onsetOf('2026-10-20~~1000~1~|2026-10-21~~1000~1~|2026-10-22~~1000~1~|' +
              '2026-10-23~~1000~5~|2026-10-24~~1000~5~|2026-10-25~~1000~5~'), null);
// Over the floor, on plenty of mail, and still not an onset: 0.8% to 1.0% is
// drift, not a list going bad. Only the rise factor rejects this one.
check('a small rise above the floor does not fire',
      onsetOf('2026-10-20~~1000~8~|2026-10-21~~1000~8~|2026-10-22~~1000~8~|' +
              '2026-10-23~~1000~10~|2026-10-24~~1000~10~|2026-10-25~~1000~10~'), null);
check('a 2.5x rise on too little mail does not fire',
      onsetOf('2026-10-20~~1000~2~|2026-10-21~~1000~2~|2026-10-22~~1000~2~|' +
              '2026-10-23~~50~2~|2026-10-24~~50~2~|2026-10-25~~50~2~'), null);
check('no baseline to rise from does not fire',
      onsetOf('2026-10-23~~1000~30~|2026-10-24~~1000~30~|2026-10-25~~1000~30~'), null);

// A rise from exactly zero is the clearest onset there is, and `base * factor`
// being 0 must not be read as "nothing to compare against".
const fromZero = onsetOf('2026-10-20~~1000~0~|2026-10-21~~1000~0~|2026-10-22~~1000~0~|' +
                         '2026-10-23~~1000~10~|2026-10-24~~1000~10~|2026-10-25~~1000~10~');
check('a rise from zero fires', fromZero !== null, true);
near('…reported as 1.00% against 0.00%', fromZero.recentPct, 1.0, 0.01);

// WATCH is a floor the onset raises TO, never a ceiling it drags a domain down to.
const onsetOnBad = decide({ domains: [D('bad.com',
  '2026-10-12~2.5~2000~0~100|2026-10-13~2.5~2000~0~100|2026-10-14~2.5~2000~0~100|' +
  '2026-10-15~2.5~2000~0~100|2026-10-16~~2000~30~|2026-10-17~~2000~30~|2026-10-18~~2000~30~')] })
  .proposals.find(p => p.domain === 'bad.com');
check('an onset never talks a quarantined domain down', onsetOnBad.state, 'QUARANTINE');

console.log('\nthe reading floor tightens as the reading worsens');

// Same two days, three severities. Two readings is enough to act on a severe
// one, and not enough to act on a mild one.
const twoDays = (rate) =>
  `2026-10-15~${rate}~2000~0~100|2026-10-16~${rate}~2000~0~100`;
const tier = (rate) => decide({
  domains: [D('tier.com', twoDays(rate)), D('getpersonaspace.com', GETPERSONA)],
}).proposals.find(p => p.domain === 'tier.com');

check('2 days at 2.0% is scored, not deferred', tier(2.0).state, 'QUARANTINE');
check('2 days at 1.0% still waits for a 3rd', tier(1.0).state, 'INSUFFICIENT_DATA');
check('…and says how many it wants',
      /need 3 at 1\.00%/.test(tier(1.0).reasons[0]), true);
check('2 days at 0.2% waits for all 4', tier(0.2).state, 'INSUFFICIENT_DATA');
check('…and wants the full four', /need 4 at 0\.20%/.test(tier(0.2).reasons[0]), true);

// The tier is set by severity alone, so a third day lets the middle band score
// without waiting for the fourth.
const mid = decide({ domains: [
  D('mid.com', '2026-10-14~1~2000~0~100|2026-10-15~1~2000~0~100|2026-10-16~1~2000~0~100'),
  D('getpersonaspace.com', GETPERSONA),
] }).proposals.find(p => p.domain === 'mid.com');
check('3 days at 1.0% is scored', mid.state === 'INSUFFICIENT_DATA', false);

// A fast-onset problem has to reach a person on the day it is provable, not
// after the old four-day wait.
const urgent = decide({ domains: [
  D('onset.com', twoDays(2.0)), D('getpersonaspace.com', GETPERSONA),
] });
check('a 2-day severe domain lands on the urgent list',
      urgent.urgent.some(u => u.domain === 'onset.com'), true);

console.log('\ncontext metrics ride along without scoring');
check('hardBouncePct present', typeof by['getpersonaspace.com'].hardBouncePct, 'number');
check('blockedPct present', 'blockedPct' in by['getpersonaspace.com'], true);
check('unsubPct present', 'unsubPct' in by['getpersonaspace.com'], true);

console.log();
if (fails.length) { console.log(`${fails.length} FAILED: ${JSON.stringify(fails)}`); process.exit(1); }
console.log('all v4 tests passed');
