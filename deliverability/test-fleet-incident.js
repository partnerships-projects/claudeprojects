const { decide, detectArtifactDates, CONFIG } = require('./state-machine-v2.js');
const TODAY = '2026-09-28';
const INCIDENT = ['2026-09-10', '2026-09-11'];

function day(n) { return new Date(new Date(TODAY) - n*86400000).toISOString().slice(0,10); }

// 40 domains, 28 days each. Normal: auth 100, spam 0.1. Incident days: auth 0, spam 6.
const domains = [];
for (let i = 0; i < 40; i++) {
  const readings = [];
  for (let n = 3; n <= 28; n++) {
    const d = day(n);
    const incident = INCIDENT.includes(d);
    readings.push({
      date: d,
      spamRate: incident ? 6.0 : 0.1,
      authDmarc: incident ? 0 : 100,
      deliveryErrorRate: 0,
    });
  }
  // one domain has a genuinely unsigned path on its own, unrelated to the incident
  if (i === 0) { for (let k = 5; k < 12; k++) readings[k].authDmarc = 0; }
  domains.push({
    domain: `d${i}.test`, inPlay: true,
    mailboxes: [{ email: `a@d${i}.test`, baselineDailyLimit: 40 }],
    readings,
  });
}

console.log('--- detector ---');
for (const a of detectArtifactDates(domains, CONFIG)) {
  console.log(`  ${a.date}  ${(a.authZeroShare*100).toFixed(0)}% of ${a.domainsReporting} reporting  spam that day ${a.spamMeanThatDay.toFixed(2)}%`);
}

const r = decide({ domains, priorStates: {}, history: [], today: TODAY });
console.log('\n--- verdict ---');
console.log('  ', r.verdict);
console.log('  fleetAlert:', r.fleetAlert);
console.log('  summary:', JSON.stringify(r.summary));
const d5 = r.results.find(x => x.domain === 'd5.test');
console.log(`\n  d5 (clean domain): state=${d5.state} spamMean=${d5.metrics.spamMean.toFixed(3)}% authFailRate=${d5.metrics.authFailRate}`);
console.log('  d5 reasons:', d5.reasons.join(' | '));
const d0 = r.results.find(x => x.domain === 'd0.test');
console.log(`\n  d0 (own unsigned path): authFailRate=${d0.metrics.authFailRate.toFixed(3)} configIssues=${JSON.stringify(d0.configIssues)}`);
console.log('  fixQueue size:', r.fixQueue.length);

console.log('\n--- control: same fleet, detector disabled ---');
const r2 = decide({ domains, priorStates: {}, history: [], today: TODAY,
                    config: { ...CONFIG, artifactDateThreshold: 1.1 } });
const d5b = r2.results.find(x => x.domain === 'd5.test');
console.log(`  d5 would be: state=${d5b.state} spamMean=${d5b.metrics.spamMean.toFixed(3)}%`);
console.log('  summary:', JSON.stringify(r2.summary));
