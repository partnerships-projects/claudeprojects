'use strict';
/**
 * The Collect -> Decide seam. Fixtures are the literal JSON the Notion API
 * returns for a page, in the property types history_snapshot.py writes.
 *
 * The assertion this file exists for is the first one: a blank column must
 * arrive as null, because every guard downstream treats a measured zero as
 * evidence and an unknown as the absence of it.
 */
const { loadDomains, num, rowDomain, complianceFrom } = require('./load-history.js');
const { decide } = require('./state-machine-v4.js');

const fails = [];
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  if (!ok) fails.push(label);
}

// A page exactly as Notion returns one. `opts` overrides individual columns;
// `null` means the column is present and empty, which is what the collector
// writes when it could not read a figure.
const page = (date, domain, o = {}) => ({
  id: `pg-${date}-${domain}`,
  properties: {
    Key:    { title: [{ plain_text: `${date}|${domain}` }] },
    Date:   { date: { start: date } },
    Domain: { rich_text: [{ plain_text: domain }] },
    'Active Mailboxes':   { number: 'active' in o ? o.active : 3 },
    'Spam Rate':          { number: 'spam' in o ? o.spam : null },
    'DMARC Success Rate': { number: 'dmarc' in o ? o.dmarc : 100 },
    'Message Volume':     { number: 'volume' in o ? o.volume : null },
    Sent:                 { number: 'sent' in o ? o.sent : null },
    'Hard Bounced':       { number: 'hard' in o ? o.hard : null },
    'Soft Bounced':       { number: null },
    Blocked:              { number: 'blocked' in o ? o.blocked : null },
    Unsubscribed:         { number: 'unsub' in o ? o.unsub : null },
    Deferred:             { number: null },
    'Compliance Verdict': { rich_text: o.verdict ? [{ plain_text: o.verdict }] : [] },
    'Verdict Reason':     { rich_text: o.reason ? [{ plain_text: o.reason }] : [] },
    'Compliance Issues':  { rich_text: o.issues ? [{ plain_text: o.issues }] : [] },
  },
});

console.log('blank is not zero — the assertion this seam exists for');
check('a blank number reads null', num({ number: null }), null);
check('a column that does not exist reads null', num(undefined), null);
check('a real zero is preserved', num({ number: 0 }), 0);
check('a real figure is preserved', num({ number: 2.03 }), 2.03);

const blanks = loadDomains([page('2026-10-27', 'a.com', { spam: null, sent: null, hard: null })]);
const br = blanks[0].readings[0];
check('a blank spam rate stays null, not 0', br.spamRate, null);
check('a blank send count stays null, not 0', br.sent, null);
check('a blank bounce count stays null, not 0', br.hardBounced, null);

// Proof it matters, on the four days Google has published for the fleet. A
// domain whose own columns are all blank knows nothing about itself; the same
// rows with those blanks read as zeros know that it is provably clean.
const DAYS = ['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27'];
const noisy = DAYS.map(d => page(d, 'noisy.com', { spam: 2, sent: 1000, volume: 1000 }));
const blankRows = loadDomains([...DAYS.map(d => page(d, 'blank.com')), ...noisy])
  .find(x => x.domain === 'blank.com');

check('all-blank rows are an absence of readings',
      decide({ domains: [blankRows, ...loadDomains(noisy)] })
        .proposals.find(p => p.domain === 'blank.com').state, 'INSUFFICIENT_DATA');

const zeroed = { ...blankRows,
  readings: blankRows.readings.map(r => ({ ...r, spamRate: 0, sent: 5000, volume: 5000 })) };
check('…which read as zeros would become proof of health',
      decide({ domains: [zeroed, ...loadDomains(noisy)] })
        .proposals.find(p => p.domain === 'blank.com').state, 'HEALTHY');

console.log('\nrow placement');
check('the Domain column is used when present',
      rowDomain(page('2026-10-27', 'x.com').properties), 'x.com');
check('the Key is the fallback when Domain is empty',
      rowDomain({ ...page('2026-10-27', 'x.com').properties, Domain: { rich_text: [] } }), 'x.com');
check('a row with neither is dropped rather than guessed',
      loadDomains([{ properties: { Key: { title: [] }, Date: { date: { start: '2026-10-27' } } } }]).length, 0);
check('a row with no date is dropped',
      loadDomains([{ properties: { Key: { title: [{ plain_text: '|x.com' }] }, Date: { date: null } } }]).length, 0);
check('domains are case-folded so one domain is one domain',
      loadDomains([page('2026-10-27', 'A.com'), page('2026-10-26', 'a.com')]).length, 1);

console.log('\nthe window');
const spread = [];
for (let i = 0; i < 30; i++) {
  const d = new Date(Date.UTC(2026, 9, 28) - i * 86400000).toISOString().slice(0, 10);
  spread.push(page(d, 'w.com', { spam: 1, sent: 1000, volume: 1000 }));
}
const win = loadDomains(spread, { windowDays: 14 })[0];
check('14 days means 14 readings', win.readings.length, 14);
check('…ending at the newest row', win.readings[0].date, '2026-10-28');
check('…and starting 13 days before it', win.windowFrom, '2026-10-15');

// The anchor comes from the data, so a run on a day with no rows yet still
// scores the fortnight that exists rather than an empty window.
const stale = loadDomains(spread.slice(5), { windowDays: 14 })[0];
check('a late run windows from the newest row it has', stale.readings[0].date, '2026-10-23');
check('…not from a wall clock that would empty it', stale.readings.length, 14);

console.log('\nin play');
check('active mailboxes > 0 is in play', loadDomains([page('2026-10-27', 'a.com', { active: 2 })])[0].inPlay, true);
check('zero active mailboxes is not', loadDomains([page('2026-10-27', 'a.com', { active: 0 })])[0].inPlay, false);
check('…and a rested domain reads IDLE',
      decide({ domains: loadDomains([page('2026-10-27', 'a.com', { active: 0 })]) }).proposals[0].state, 'IDLE');

// A blank here means the collector could not say. Idling a domain on that
// would hide it from scoring entirely, which is the worst way to be wrong.
check('a blank is not read as zero mailboxes',
      loadDomains([page('2026-10-27', 'a.com', { active: null })])[0].inPlay, true);
check('…and the newest row that states it wins over a newer blank',
      loadDomains([page('2026-10-27', 'a.com', { active: null }),
                   page('2026-10-26', 'a.com', { active: 0 })])[0].inPlay, false);

console.log('\ncompliance');
const comp = complianceFrom([
  { props: page('2026-10-27', 'a.com').properties },                     // no snapshot
  { props: page('2026-10-26', 'a.com', { verdict: 'SENDER_NOT_COMPLIANT',
      reason: 'SENDER_NOT_COMPLIANT', issues: 'HONOR_UNSUBSCRIBE, DMARC_POLICY' }).properties },
]);
check('it is read from the newest row that carries one', comp.verdictReason, 'SENDER_NOT_COMPLIANT');
check('every listed issue is NEEDS_WORK by construction',
      comp.requirements, { HONOR_UNSUBSCRIBE: 'NEEDS_WORK', DMARC_POLICY: 'NEEDS_WORK' });
check('no snapshot anywhere is an empty map, not a crash',
      complianceFrom([{ props: page('2026-10-27', 'a.com').properties }]).requirements, {});

// The two halves have to agree on these names or the accepted risks silently
// become fix-queue items — the bug that put 64 permanent entries in the queue.
const risks = decide({ domains: loadDomains([
  page('2026-10-27', 'a.com', { spam: 0.1, sent: 2000, volume: 2000,
    reason: 'SENDER_NOT_COMPLIANT', issues: 'HONOR_UNSUBSCRIBE, SPF_AND_DKIM' }),
]) });
check('HONOR_UNSUBSCRIBE lands in accepted risks, not the fix queue',
      risks.proposals[0].acceptedRisks.map(r => r.code).sort(), ['HONOR_UNSUBSCRIBE', 'SPF_AND_DKIM']);
check('…and the fix queue stays empty', risks.fixQueue.length, 0);
check('a real configuration fault does reach the fix queue',
      decide({ domains: loadDomains([page('2026-10-27', 'b.com', { issues: 'DMARC_POLICY' })]) })
        .fixQueue.map(i => i.code), ['DMARC_POLICY']);

console.log('\nunits survive the crossing');
// Spam Rate is stored as percentage POINTS. Read as a 0..1 rate it would be
// 100x too small and nothing would ever leave HEALTHY.
const units = loadDomains([
  page('2026-10-27', 'u.com', { spam: 2.5, sent: 3000, volume: 3000, hard: 30 }),
  page('2026-10-26', 'u.com', { spam: 2.5, sent: 3000, volume: 3000, hard: 30 }),
]);
check('spam rate crosses as percentage points', units[0].readings[0].spamRate, 2.5);
const scored = decide({ domains: units }).proposals[0];
check('…and scores on that scale', scored.pooledSpam, 2.5);
check('…reaching QUARANTINE, not HEALTHY', scored.state, 'QUARANTINE');
check('Sent is Mailjet, Message Volume is Google, and they stay apart',
      [scored.sent, scored.volume], [6000, 6000]);
check('hard bounce is computed off Mailjet Sent', scored.hardBouncePct, 1);

console.log('\nthe runner renders what it is given');
const { report } = require('./decide-run.js');
const rendered = report(decide({ domains: loadDomains([
  ...DAYS.map(d => page(d, 'bad.com',  { spam: 2.5, sent: 2000, volume: 2000, hard: 60 })),
  ...DAYS.map(d => page(d, 'good.com', { spam: 0.05, sent: 9000, volume: 9000, hard: 4 })),
]), today: '2026-10-27' }));
check('the urgent section names the bad domain', /URGENT[\s\S]*bad\.com/.test(rendered), true);
check('…and the healthy one is not in it', /URGENT[\s\S]*?\n\nPROPOSALS/.test(rendered) &&
      !/URGENT[\s\S]*?good\.com[\s\S]*?\n\nPROPOSALS/.test(rendered), true);
check('both providers are stamped so staleness is visible',
      /Postmaster published through 2026-10-27\s+·\s+Mailjet through 2026-10-27/.test(rendered), true);
check('it says plainly that nothing acts', /advisory: nothing here acts/.test(rendered), true);

console.log(fails.length ? `\n${fails.length} FAILED: ${JSON.stringify(fails)}` : '\nall loader tests passed');
process.exit(fails.length ? 1 : 0);
