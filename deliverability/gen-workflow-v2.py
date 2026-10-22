import re, io

HIST_DB = '3db0a93f-c145-81a5-a881-e793d037e8eb'
MBOX_DB = '38d0a93f-c145-810b-8441-f103edc7f5af'

def lit(code):
    """Escape a JS source string so it can live inside a TS template literal."""
    return code.replace('\\', '\\\\').replace('`', '\\`').replace('${', '\\${')

sm = open('state-machine-v2.js', encoding='utf-8').read()
sm = sm.split('module.exports')[0].rstrip()

runner = '''

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
'''

decide_code = sm + runner
build_code = open('build-node.js', encoding='utf-8').read()

explode_code = '''// One readable table: a RUN row first, then one row per domain.
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
'''

tpl = '''import {{ workflow, node, trigger, sticky, newCredential }} from '@n8n/workflow-sdk';

// Deliverability Health — Decide v2
//
// READ-ONLY. Reads two Notion tables, computes a proposed health state per
// domain from a 30-day rolling aggregate, and stops. There is no write node
// of any kind in this workflow — not to Notion, not to Saleshandy, not to
// Instantly. The worst it can do is put a wrong number on a screen.

const dailyTrigger = trigger({{
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.4,
  config: {{
    name: 'Daily 09:00',
    parameters: {{ rule: {{ interval: [{{ field: 'days', daysInterval: 1, triggerAtHour: 9, triggerAtMinute: 0 }}] }} }},
  }},
  output: [{{ timestamp: '2026-09-29T09:00:00.000Z' }}],
}});

const readHistory = node({{
  type: 'n8n-nodes-base.notion',
  version: 3,
  config: {{
    name: 'Read Domain Health History',
    parameters: {{
      resource: 'databasePage',
      operation: 'getAll',
      dataSourceId: {{ __rl: true, mode: 'id', value: '{HIST_DB}' }},
      returnAll: true,
      simple: true,
      filterType: 'none',
    }},
    credentials: {{ notionApi: newCredential('Domain Health History (read-only)') }},
  }},
  output: [{{ id: 'h-1', Domain: 'example.com', Date: '2026-09-25', 'Spam Rate': 0.4 }}],
}});

const readMailboxes = node({{
  type: 'n8n-nodes-base.notion',
  version: 3,
  config: {{
    name: 'Read Mailbox Rows',
    parameters: {{
      resource: 'databasePage',
      operation: 'getAll',
      dataSourceId: {{ __rl: true, mode: 'id', value: '{MBOX_DB}' }},
      returnAll: true,
      simple: true,
      filterType: 'none',
    }},
    credentials: {{ notionApi: newCredential('Domain Health History (read-only)') }},
  }},
  output: [{{ id: 'm-1', name: 'someone@example.com', Domain: 'example.com', Status: 'Active' }}],
}});

const build = node({{
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {{
    name: 'Build Domain Set',
    parameters: {{
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `{BUILD}`,
    }},
  }},
  output: [{{ domains: [], priorStates: {{}}, history: [], probe: {{ historyRowCount: 0 }} }}],
}});

const decideNode = node({{
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {{
    name: 'Decide — State Machine v2',
    parameters: {{
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `{DECIDE}`,
    }},
  }},
  output: [{{ today: '2026-09-29', thresholdVersion: 'thresholds_v2', domainsEvaluated: 0, verdict: '0 domains changing state.' }}],
}});

const explode = node({{
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {{
    name: 'One Row Per Domain',
    parameters: {{
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `{EXPLODE}`,
    }},
  }},
  output: [{{ _row: 'RUN', domain: '— RUN SUMMARY —', verdict: '0 domains changing state.' }}],
}});

const review = node({{
  type: 'n8n-nodes-base.noOp',
  version: 1,
  config: {{ name: 'Proposed States — Review Only' }},
  output: [{{ domain: 'example.com', state: 'HEALTHY' }}],
}});

const noteSafety = sticky(
  `## READ-ONLY — this workflow cannot change a mailbox

It reads two Notion tables, computes a proposed health state per domain,
and stops. No Notion write node, no Saleshandy node, no Instantly node.

Keep it unpublished until the proposed-state table has been reviewed
against what you know about these domains by hand.`,
  [readHistory, readMailboxes],
  {{ color: 3 }},
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
  {{ color: 4 }},
);

const noteConfig = sticky(
  `## The CONFIG block is the whole argument

Every number that decides what happens to a mailbox sits at the top of
**Decide — State Machine v2**, tagged \\`thresholds_v2\\`. Each run records
which version produced it, so a bad threshold is traceable afterwards.

Thresholds are calibrated on this fleet's **clean baseline** — fleet-wide
incident days excluded. With those days averaged in, the tail ran 10-20%
hot and the ladder would have fired late on genuinely degrading domains.

Config faults (auth failure, unsubscribe not honoured) go to a **fix queue**,
never the ladder. Throttling a domain whose DKIM is broken does not fix DKIM.`,
  [decideNode],
  {{ color: 6 }},
);

const noteNext = sticky(
  `## Before this is trustworthy

1. **Attach a read-only Notion credential** to both Notion nodes. The only
   credential on this instance today lives in a personal project.
2. **Check the schema probe** on the RUN row of the output. It reports the
   real column names in both tables. Column lookups here are a list of
   candidate names, so a rename degrades to a null rather than a crash —
   but the probe is how we find out what to actually name them.
3. \\`priorStates\\` and \\`history\\` come from the history table's own state
   columns. If those do not exist yet, every run is a first run: every
   domain reports **initial classification — baseline, no action**, and
   hysteresis is untested. That is the safe failure, not a broken one.
4. **Bounce rate is still missing** from every source. It is the one signal
   that would make this independent of Postmaster.`,
  [explode, review],
  {{ color: 5 }},
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
  .group('Read (Notion, read-only)', [readHistory, readMailboxes], {{ description: 'Pulls the append-only history table and the live mailbox table.' }})
  .group('Decide (pure logic)', [build, decideNode], {{ description: 'No credentials, no side effects. Same code as the tested state machine.' }})
  .group('Review', [explode, review], {{ description: 'Proposed states for human review. Nothing is applied.' }});
'''

out = tpl.format(
    HIST_DB=HIST_DB, MBOX_DB=MBOX_DB,
    BUILD=lit(build_code), DECIDE=lit(decide_code), EXPLODE=lit(explode_code),
)
open('decide-workflow-v2.ts', 'w', encoding='utf-8').write(out)
print('wrote decide-workflow-v2.ts', len(out), 'bytes')
