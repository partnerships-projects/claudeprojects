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

console.log('\nhard bounce is reported, not conflated');
const HB = '2026-10-12~0~2000~60~100|2026-10-13~0~2000~60~100|2026-10-14~0~2000~60~100|' +
           '2026-10-15~0~2000~60~100|2026-10-16~0~2000~60~100';
const hb = decide({ domains: [D('bouncy.com', HB), D('getpersonaspace.com', GETPERSONA)] })
  .proposals.find(p => p.domain === 'bouncy.com');
near('hard bounce pct computed', hb.hardBouncePct, 3.0, 0.01);
check('warn level leaves the state alone', hb.state, 'HEALTHY');
check('…but it is stated in the reasons',
      hb.reasons.some(x => /hard bounce 3\.00%/.test(x)), true);

const SEV = '2026-10-12~0~2000~120~100|2026-10-13~0~2000~120~100|2026-10-14~0~2000~120~100|' +
            '2026-10-15~0~2000~120~100|2026-10-16~0~2000~120~100';
const sev = decide({ domains: [D('severe.com', SEV), D('getpersonaspace.com', GETPERSONA)] })
  .proposals.find(p => p.domain === 'severe.com');
check('6% hard bounce reaches THROTTLE', sev.state, 'THROTTLE');

console.log('\ncontext metrics ride along without scoring');
check('hardBouncePct present', typeof by['getpersonaspace.com'].hardBouncePct, 'number');
check('blockedPct present', 'blockedPct' in by['getpersonaspace.com'], true);
check('unsubPct present', 'unsubPct' in by['getpersonaspace.com'], true);

console.log();
if (fails.length) { console.log(`${fails.length} FAILED: ${JSON.stringify(fails)}`); process.exit(1); }
console.log('all v4 tests passed');
