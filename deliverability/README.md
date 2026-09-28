# Deliverability Health Monitoring — Decide stage

Detects degrading sending domains early enough to throttle or quarantine them
**before** they burn, instead of finding out after the fact.

Split by blast radius into three workflows. This directory is the middle one.

| stage | what it does | where it lives |
|---|---|---|
| **Collect** | pulls Postmaster v2 into Notion, append-only | separate track |
| **Decide** | scores each domain, proposes a state | **here** |
| **Act** | applies throttles / warmup changes | not built |

Decide is read-only by construction. It has no write node of any kind — not to
Notion, not to Saleshandy, not to Instantly. The worst it can do is put a wrong
number on a screen.

## Files

| file | what it is |
|---|---|
| `state-machine-v2.js` | the decision logic, `thresholds_v2`. Pure: no I/O, no credentials. Runnable and testable on its own. |
| `build-node.js` | joins the two Notion tables into the shape `decide()` expects |
| `gen-workflow-v2.py` | generates the n8n workflow by **injecting** the two files above |
| `decide-workflow-v2.ts` | generated n8n SDK source — do not hand-edit, regenerate |
| `test-*.js` | the tests below |

The generator matters: the logic running in n8n is byte-identical to the file
the tests run against. Hand-copying it into a Code node is how the two drift.

```
python3 gen-workflow-v2.py      # regenerate after editing state-machine-v2.js
node test-shape.js              # chronic vs spike vs trivially-healthy
node test-fleet-incident.js     # fleet-wide incident detection + exclusion
node test-e2e.js                # all three n8n Code nodes, end to end
```

## Why it is built this way

**Domain reputation is gone.** Google removed it from Postmaster permanently,
which deleted v1's entire spine. This is a rewrite, not an edit.

**Spam rate is a counter, not a rate.** At this sending volume one complaint
against a few dozen inbox placements reads as ~2%, and zero complaints reads as
0. There is no middle. Thresholding a single day is close to a coin flip, so
this scores a **30-day rolling mean per domain**.

**The mean cannot see shape.** `[0,0,0,0,5]` and `[1,1,1,1,1]` both average 1%
and are completely different situations. So there are two detectors: the mean
catches chronic elevation, and a separate spike detector catches acute onset.
A spike only ever raises an alert — never a throttle. Sudden onset needs a
human looking at what changed.

**Fleet-wide days are one event, not N faults.** On some dates every reporting
domain authenticated at 0%. Averaging those into each domain's mean smears one
incident across the whole fleet and moves the ladder for domains that did
nothing wrong. They are detected from the batch (not hardcoded), excluded from
aggregates, and raised as a fleet alert. They are never deleted from history —
they are the only evidence we have of what an incident looks like here.

**Config faults are not health faults.** Auth failure and unhonoured
unsubscribes go to a fix queue, never the ladder. Throttling a domain whose
DKIM is broken does not fix DKIM; it just sends less broken mail.

**Thresholds come from this fleet's own distribution**, not from Google's
published numbers, which are unusable at this volume — with one exception:
the healthy line is Google's 0.3% policy line, because that is the actual
enforcement threshold. Everything above it is calibrated on the fleet's clean
baseline, incident days excluded.

## Known gaps

- **Bounce rate is missing** from every source. It is the one signal that would
  make this independent of Postmaster.
- **Hysteresis is untested against real data.** It needs prior states in the
  history table. Until those exist every run is a first run and reports
  `initial classification — baseline, no action`. That is the safe failure.
- The system is **structurally ~2 days behind**: Postmaster revises recent
  days, so the newest two are excluded from every aggregate. It cannot be a
  same-day alarm.

## Safety properties

- Read-only. No write node exists in the workflow.
- Every expensive state (`QUARANTINE`, `RETIRE`) is gated `APPROVAL`.
- A circuit breaker halts on mass change, and **classifies why** first:
  auth and spam moving together is a real fleet incident and must escalate;
  auth moving alone is probably a broken feed and must not.
- Hysteresis is asymmetric: fast down, slow up.
- `RETIRE` is unreachable by escalation — only by sustained quarantine.
- Domains can be pinned out of automation by hand.
