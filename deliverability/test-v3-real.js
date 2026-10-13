'use strict';
/**
 * Decide v3 against REAL recorded series from the Domain Health History table
 * on 2026-10-13. Every readings array below is the actual data for that domain,
 * not an invention, which is what makes the expectations checkable by hand.
 */
const { decide, CONFIG, publishedDays, detectFleetAuthIncidents } = require('./state-machine-v3.js');

const fails = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  if (!ok) fails.push(label);
};

// date~spam~volume~dmarc, exactly as the table stores it
const parse = s => s.split('|').map(row => {
  const [date, spam, vol, dmarc] = row.split('~');
  return {
    date,
    spamRate: spam === '' ? null : Number(spam),
    volume:   vol === ''  ? null : Number(vol),
    authDmarc: dmarc === '' ? null : Number(dmarc),
  };
});

const D = (domain, series, extra = {}) => ({
  domain, inPlay: true, readings: parse(series),
  compliance: { verdictReason: 'SENDER_NOT_COMPLIANT', requirements: {} },
  ...extra,
});

const FLEET = [
  // Steady mid-range domain. Note 2026-10-10: spam IS published (1.942) but
  // volume and DMARC are not — the partial-publication pattern.
  D('advancecreators.com',
    '2026-09-27~3.289~1420~100|2026-09-28~0.676~1396~100|2026-09-29~2.162~1717~100|' +
    '2026-09-30~1.418~1431~100|2026-10-01~1.667~1665~100|2026-10-02~2.339~1598~100|' +
    '2026-10-03~4.412~1237~100|2026-10-04~2.521~1082~100|2026-10-05~1.46~1763~100|' +
    '2026-10-06~0.68~1466~100|2026-10-07~0~1203~100|2026-10-08~0.893~1185~100|' +
    '2026-10-09~0~1205~100|2026-10-10~1.942~0~0',
    { avgSpam7d: 1.071 }),

  // The worst sustained domain in the fleet: complaints nearly every day on
  // real volume.
  D('getpersonaspace.com',
    '2026-09-27~2.597~1196~100|2026-09-28~2.941~1194~100|2026-09-29~3.39~1196~100|' +
    '2026-09-30~1.333~1170~100|2026-10-01~3.597~1190~100|2026-10-02~3.39~1095~100|' +
    '2026-10-03~2.362~1094~100|2026-10-04~4.58~1096~100|2026-10-05~2.459~1143~100|' +
    '2026-10-06~1.351~1148~100|2026-10-07~1.923~1143~100|2026-10-08~2.97~1148~100|' +
    '2026-10-09~4.651~1144~100|2026-10-10~3.361~1144~100',
    { avgSpam7d: 3.042 }),

  // DMARC 0% on EVERY day, on real volume, with ZERO spam complaints. A DKIM
  // alignment fault: needs a DNS fix, not a throttle.
  D('creators-create.com',
    '2026-09-27~0~256~0|2026-09-28~0~265~0|2026-09-29~0~270~0|2026-09-30~0~276~0|' +
    '2026-10-01~0~270~0|2026-10-02~0~278~0|2026-10-03~0~272~0|2026-10-04~0~273~0|' +
    '2026-10-05~0~268~0|2026-10-06~0~282~0|2026-10-07~0~268~0|2026-10-08~0~266~0|' +
    '2026-10-09~0~270~0|2026-10-10~0~0~0',
    { avgSpam7d: 0 }),

  // Clean and quiet.
  D('creator-growth.com',
    '2026-09-27~0~258~100|2026-09-28~0~266~100|2026-09-29~0~247~100|2026-09-30~0~258~100|' +
    '2026-10-01~0~242~100|2026-10-02~0~236~100|2026-10-03~0~233~100|2026-10-04~0~220~100|' +
    '2026-10-05~0~240~100|2026-10-06~0~234~100|2026-10-07~0~231~100|2026-10-08~0~234~100|' +
    '2026-10-09~0~78~100',
    { avgSpam7d: 0 }),

  // One reading, one message. Google cannot judge it and neither can we.
  D('creatorsareamazing.com', '2026-09-27~0~1~100', { avgSpam7d: null }),

  // High rate on almost no mail: 3.571% of a day with no volume reading at all.
  D('creatorsadministration.com',
    '2026-09-27~0~13~100|2026-10-06~0~82~100|2026-10-07~0~82~100|2026-10-08~0~158~100|' +
    '2026-10-09~0~394~100|2026-10-10~3.571~0~0',
    { avgSpam7d: 1.786 }),
];

const today = '2026-10-13';
const out = decide({ domains: FLEET, today });

console.log('=== 1. published days are decided by the fleet, not by one domain ===');
const pub = publishedDays(FLEET);
check('2026-10-10 is published (spam was)', pub.has('2026-10-10'), true);
check('no day is wrongly unpublished', out.fleet.unpublishedDays, []);
console.log('    (spam for 10-10 IS published; volume and DMARC are not — that');
console.log('     split is exactly what broke v2)');

console.log('=== 2. a lag day is NOT a fleet incident ===');
// On 2026-10-10 most domains read DMARC 0 with no volume. v2 flagged that
// pattern as a fleet-wide authentication incident three times in three weeks.
check('no fleet incident raised', out.fleet.authIncidents.length, 0);
const tenth = FLEET.flatMap(d => d.readings).filter(r => r.date === '2026-10-10');
check('and the day really does look alarming',
      tenth.filter(r => r.authDmarc === 0).length, 3);
console.log('    (requiring volume>0 is what separates lag from a real incident)');

console.log('=== 3. real DMARC failure still caught — as a fix, not a throttle ===');
const cc = out.proposals.find(p => p.domain === 'creators-create.com');
const ccFix = out.fixQueue.filter(f => f.domain === 'creators-create.com');
check('flagged in the fix queue', ccFix.map(f => f.code), ['DMARC_FAILING_ON_SENDING_DAYS']);
check('but NOT pushed down the ladder', cc.state, 'HEALTHY');
console.log('    (0% DMARC on 13 sending days with zero complaints — a DNS fix,');
console.log('     and throttling it would hide the problem rather than solve it)');

console.log('=== 4. the ladder reads the published mean, it does not recompute ===');
check('advancecreators 1.071% -> THROTTLE',
      out.proposals.find(p => p.domain === 'advancecreators.com').state, 'THROTTLE');
check('getpersonaspace 3.042% -> QUARANTINE',
      out.proposals.find(p => p.domain === 'getpersonaspace.com').state, 'QUARANTINE');
check('creator-growth 0% -> HEALTHY',
      out.proposals.find(p => p.domain === 'creator-growth.com').state, 'HEALTHY');

console.log('=== 4b. RETIRE is unreachable on a first run ===');
check('no domain proposed for retirement',
      out.proposals.filter(p => p.state === 'RETIRE').map(p => p.domain), []);
check('escalation capped at THROTTLE, never RETIRE',
      out.proposals.find(p => p.domain === 'advancecreators.com').state, 'THROTTLE');
check('a domain that EARNED quarantine on magnitude keeps it',
      out.proposals.find(p => p.domain === 'getpersonaspace.com').reasons
        .some(r => /no further escalation/.test(r)), true);
console.log('    (the escalator used to reach RETIRE directly from QUARANTINE —');
console.log('     a domain could be proposed for retirement before it had a');
console.log('     prior state to have sustained)');

console.log('=== 5. no mean, no verdict ===');
check('single thin reading -> INSUFFICIENT_DATA',
      out.proposals.find(p => p.domain === 'creatorsareamazing.com').state, 'INSUFFICIENT_DATA');
console.log('    (107 of 213 domains sit here permanently — a steady state, not a fault)');

console.log('=== 6. volume gate stops a counter masquerading as a rate ===');
const adm = out.proposals.find(p => p.domain === 'creatorsadministration.com');
check('1.786% but tiny volume -> capped below QUARANTINE',
      ['THROTTLE', 'WATCH'].includes(adm.state), true);
check('and the cap is explained', 
      adm.reasons.some(r => /too little volume/.test(r)) ||
      adm.reasons.some(r => /capped at WATCH/.test(r)), true);

console.log('=== 7. nothing acts; every proposal carries advice for a human ===');
check('advisory flag', out.advisory, true);
check('every proposal has advice', out.proposals.every(p => !!p.advice), true);
check('QUARANTINE advice names a human action',
      out.proposals.find(p => p.domain === 'getpersonaspace.com').advice,
      'stop sending from this domain until someone has looked');

console.log('=== 8. the urgent list stays short ===');
console.log(`    urgent: ${out.urgent.length} of ${out.proposals.length} domains`);
check('urgent is a strict subset', out.urgent.length < out.proposals.length, true);
check('worst first', out.urgent[0] && out.urgent[0].domain, 'getpersonaspace.com');

console.log('=== 9. the accepted-risk exemption holds ===');
const withUnsub = [{
  ...D('x.com', '2026-10-01~2~900~100|2026-10-02~2~900~100|2026-10-03~2~900~100|2026-10-04~2~900~100',
       { avgSpam7d: 2.0 }),
  compliance: { verdictReason: 'SENDER_NOT_COMPLIANT',
                requirements: { HONOR_UNSUBSCRIBE: 'NEEDS_WORK', SPF_AND_DKIM: 'NEEDS_WORK' } },
}];
const o2 = decide({ domains: withUnsub, today });
check('no fix-queue item for an accepted risk', o2.fixQueue.length, 0);
check('recorded as accepted instead',
      o2.proposals[0].acceptedRisks.map(a => a.code).sort(), ['HONOR_UNSUBSCRIBE', 'SPF_AND_DKIM']);
console.log('    (v2 raised 64 permanent fix items for HONOR_UNSUBSCRIBE and, via');
console.log('     configFailEscalateAfterDays, permanently escalated all 64)');

console.log();
console.log('--- fleet summary ---');
console.log('   ', JSON.stringify(out.counts));
console.log();
console.log(fails.length ? `FAILED: ${fails.join(', ')}` : 'all checks passed');
process.exit(fails.length ? 1 : 0);
