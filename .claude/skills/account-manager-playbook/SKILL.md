---
name: account-manager-playbook
description: Analyzes meeting transcripts and client interactions against the Account Manager Playbook. Reads from Slack #clients-notes and posts results to #playbook-channel.
user-invocable: true
---

# Account Manager Playbook Skill

When this skill is invoked, follow these steps:

## Step 1: Get the Meeting Transcript

- If the user provides a transcript directly, use that.
- If no transcript is provided, read the latest messages from the `#clients-notes` Slack channel (channel ID: `C0AG42ULCN4`) using the `slack_read_channel` MCP tool. Pick the most recent meeting summary.
- If the user specifies a particular meeting or client name, find the matching message in `#clients-notes`.

## Step 2: Run the Playbook Analysis

Analyze the transcript/summary against the Account Manager Playbook below. Produce a structured analysis with the sections listed under "Analysis Output Format".

## Step 3: Post to Slack

After generating the analysis, post it to the `#playbook-channel` Slack channel (channel ID: `C0ANCMX689Z`) using the `slack_send_message` MCP tool.

Format the Slack message using Slack markdown:
- Use `*bold*` not `**bold**`
- Use `_italic_` not `*italic*`
- Use emojis for section headers
- End the message with `_Sent using Account Manager Playbook Skill_`

---

## Analysis Output Format

### 1. Client Situation Assessment
Based on the playbook's Weekly Client Check framework, assess:
- **Relationship Pulse**: 🔴 Cold/distant, 🟠 Neutral/transactional, or 🟢 Engaged/warm — with evidence from the transcript
- **Tone & Behavior Signals**: Note any shifts in client tone, engagement level, reply patterns
- **Red Flags Detected**: From the playbook's red flag checklist (slower replies, short responses, missed meetings, less curiosity, vague feedback, colder tone, internal pressure mentions)
- **Green Flags Detected**: From the playbook's green flag checklist (fast replies, detailed feedback, asking questions, sharing internal updates, positive tone, interest in scaling, engaging with ideas)

### 2. Call Summary
Provide a concise summary of the meeting covering:
- Key topics discussed
- Decisions made or deferred
- Client requests or concerns raised
- Internal issues or context the client shared
- Any commitments made by either side

### 3. Performance Assessment
Using Rule 5 (interpret performance, not just pass it on):
- **Current performance status**: Clearly hitting targets / Close to targets / Missing targets
- **Root cause analysis**: What is the real issue behind performance (targeting, messaging mismatch, weak offer, poor lead quality, etc.)
- **What the numbers are actually saying** about the campaign — opens, replies, conversions, and what each indicates

### 4. Playbook Rule Compliance Feedback
Evaluate the account manager's behavior in the meeting against ALL 12 rules. For each relevant rule, score and comment:

| Rule | Status | Notes |
|------|--------|-------|
| Rule 1: Act like part of the client's team | ✅/⚠️/❌ | Evidence |
| Rule 2: Build trust early | ✅/⚠️/❌ | Evidence |
| Rule 3: Communicate to reduce uncertainty | ✅/⚠️/❌ | Evidence |
| Rule 4: First month = testing, not false certainty | ✅/⚠️/❌ | Evidence |
| Rule 5: Interpret performance, don't just report | ✅/⚠️/❌ | Evidence |
| Rule 6: Active response to underperformance | ✅/⚠️/❌ | Evidence |
| Rule 7: Show the thinking, not just outcomes | ✅/⚠️/❌ | Evidence |
| Rule 8: Lead the client strategically | ✅/⚠️/❌ | Evidence |
| Rule 9: Retention signals awareness | ✅/⚠️/❌ | Evidence |
| Rule 10: Value beyond campaign scope | ✅/⚠️/❌ | Evidence |
| Rule 11: Honest, direct communication | ✅/⚠️/❌ | Evidence |
| Rule 12: Manage momentum, not just the account | ✅/⚠️/❌ | Evidence |

### 5. Suggested Next Steps
Based on the playbook's action framework:
- **Key issue to fix**: The single most important problem to address
- **Key opportunity to push forward**: The single biggest opportunity
- **Recommended client questions for next interaction**: Pick 1-2 from the playbook's Weekly Client Questions based on the current situation
- **Specific actions**: Concrete steps for the coming week
- **Risk Level Classification**: 🔴 High Risk / 🟠 Medium Risk / 🟢 Low Risk — with justification

### 6. Monthly Check Items (if applicable)
If this is a monthly review or end-of-month meeting, also assess:
- Business alignment: Has the client's goal changed?
- Satisfaction level
- Value perception
- Expansion/retention opportunities
- Monthly reflection recommendations

---

## The Playbook

### What an Account Manager Is Actually Responsible For

An account manager is not there just to pass messages between the client and the internal team, and not there just to send updates once a week and hope the client is happy. The account manager is the person who holds the relationship together, protects trust when performance is strong, and protects the account even more when performance is weak.

That means the job is not only about metrics, replies, leads, or booked calls. The job is also about how the client feels while those things are happening. A campaign can be imperfect and still be saved if the client feels there is real ownership, real effort, and real thinking behind it.

On the other side, a campaign can have decent numbers and still become unstable if the client feels ignored, confused, or unmanaged.

The standard for an account manager should be simple: the client should feel that they are working with someone who understands their business, thinks ahead, tells them the truth, and takes the partnership seriously. The role is not passive. It is not administrative. It is active, commercial, strategic, and relationship-driven.

### Rule 1: From the First Interaction, Act Like Part of the Client's Team

The client should never feel they are dealing with a distant vendor. From the very beginning, the account manager has to establish the feeling that the client has gained a real partner invested in the outcome. This is done by the tone of communication, by consistency, by speed, by memory, by care, and by the way the account manager speaks about the work.

The client should hear and feel that the account manager is speaking from ownership — using language that creates alignment rather than distance, treating the client's goal as a shared goal, behaving as if the outcome matters personally.

This difference changes:
- How much trust the client gives when results are delayed
- How open they are to feedback
- How likely they are to stay during a bad period
- How likely they are to expand when things go well

A lot of churn does not begin with performance. It begins with emotional distance.

### Rule 2: Build Trust Early, Because Trust Built Late Is Much Harder to Create

The first stage of a partnership is where the account manager sets the emotional and professional standard. That first stage should make the client feel three things clearly:
1. That they are being listened to
2. That they are being guided by someone competent
3. That communication with this team will be easy

The account manager has to be friendly, human, and easy to talk to without becoming unserious. Be warm enough that the client likes dealing with you, but grounded enough that they trust your judgment.

A strong account manager reads the client quickly and adjusts:
- If the client is open, the tone can be lighter
- If the client is formal, communication should be cleaner and more structured
- If the client becomes short or distant, trust, patience, or confidence is likely dropping

### Rule 3: Communicate to Reduce Uncertainty, Not Just Frequently

Every message from an account manager should reduce uncertainty. The client should leave the message understanding what is happening, what it means, and what happens next.

Communication should never stop at surface-level reporting. The account manager has to explain what is behind performance, whether it matters, and what action is already being taken.

- Weak communication during a weak period creates panic
- Strong communication during a weak period creates stability

Fast responses tell the client that they matter. Even when there is no final answer yet, acknowledging the issue and setting expectation is better than disappearing.

### Rule 4: The First Month Is for Testing, Not for Pretending Certainty Exists

The first month should be positioned as a testing phase where the team is learning the audience, pressure-testing assumptions, understanding which messages resonate, and identifying which segments respond best.

Strong campaigns usually do not come from guessing correctly on day one. They come from running a smart process quickly, learning fast, and improving based on what the market gives back.

"Underpromise and overdeliver" is a protective mechanism. When the client expects immediate perfection, every normal challenge feels like failure.

### Rule 5: Interpret Performance, Not Just Pass It On

Performance data by itself does not help the client very much. Numbers become valuable only when someone translates them into meaning.

- If opens are weak: audience problem, deliverability issue, or weak first impression
- If opens are strong and replies are weak: message mismatch
- If replies exist but conversions are weak: qualification, offer fit, or wrong type of interest

The account manager should never sound robotic when speaking about performance. They need to explain what deserves concern, what is normal, what is promising, what is misleading, and what should be done next.

### Rule 6: When a Campaign Starts Failing, the Response Cannot Be Passive

When a campaign underperforms, a strong account manager goes deeper immediately — not panic, but intensity. Increase focus, narrow attention, treat the issue like active problem-solving.

The client has to see that this process is happening. Invisible effort has almost no value in the client's eyes.

- If the client feels the account manager cares as much as they do, the relationship can stay healthy even during a difficult period
- If the client feels they have to chase updates, the relationship starts breaking before the campaign is fixed

### Rule 7: Show the Client the Thinking, Not Just the Outcome

Make the reasoning visible so the client understands there is a process behind the decisions. Explain why a new audience is being tested, why a segment is being deprioritized, why follow-up structure is changing.

It is not about making weak performance look good. It is about making sure the client sees the full picture: what was tested, what was learned, what was ruled out, and where the next opportunity is.

### Rule 8: Lead the Client Strategically

An account manager should never fall into the trap of becoming purely obedient. The role is to absorb what the client wants, understand the business behind it, and guide the client toward the strongest approach.

Sometimes the client will be right. Sometimes they will want something too narrow, too broad, unrealistic, or based on the wrong assumption. Push back calmly and clearly with logic.

Clients usually respect confidence more than submission, as long as confidence is backed by logic.

### Rule 9: Retention Starts Long Before Renewal Is Discussed

Retention is built every week through consistency, trust, honesty, and usefulness. Watch for signals in the relationship itself:

**Warning signals**: Delayed replies, short messages, vague feedback, missed meetings, low energy, sudden drop in interest
**Healthy signals**: Fast replies, open discussion, internal sharing, curiosity, collaborative behavior

A strong account manager notices those signals early and acts before the account formally becomes "at risk."

### Rule 10: Value Beyond Campaign Scope

The best account managers understand that value is not only generated inside formal deliverables. Sometimes value comes from bringing a useful idea, noticing a market shift, suggesting a new segment, sharing a relevant observation, or helping the client think more clearly.

A client will tolerate more imperfection from a partner that consistently thinks with them than from a vendor that only appears to explain results.

### Rule 11: Do Not Hide Behind Professionalism to Avoid Honesty

Strong account managers are direct without being rough:
- If something is weak, say it is weak
- If something needs more time, say that
- If a strategy is not working, say it
- If expectations need to be reset, do it early

Honesty gives clients confidence that when things are good, they are really good, and when things are bad, they will hear the truth quickly.

### Rule 12: The Standard Is to Manage Momentum

Accounts do not fail in one moment. They lose momentum. Good account managers keep things moving — there is always a next step, a next idea, a next learning, a next improvement.

- When performance is strong: turn wins into stronger positioning, more trust, and maybe more scope
- When performance is weak: turn uncertainty into action and confusion into a plan

The role is about holding energy, trust, and direction inside the partnership.

---

## Weekly Client Check Framework

### 1. Relationship Pulse
- Client state: 🔴 Cold/distant | 🟠 Neutral/transactional | 🟢 Engaged/warm
- Tone/behavior changes from previous week
- Interaction quality: reply speed, feedback depth, engagement level

### 2. Performance Reality Check
- Status: Clearly hitting targets | Close to targets | Missing targets
- Real issue behind performance (targeting, messaging mismatch, weak offer, poor lead quality)
- Clarity of understanding

### 3. Effort Visibility Check
- Did we clearly show what we are doing, testing, and why?
- Or only surface-level updates?

### 4. Control Check
- Leading the account or reacting to the client?
- Suggested new ideas? Challenged what didn't make sense? Guided next steps?

### 5. Recommended Client Questions
**General alignment:**
- "What's top of mind for you this week?"
- "Anything new on your side we should align with?"

**If there is risk:**
- "How are you feeling about everything so far, honestly?"
- "Is there anything you feel we should be doing differently right now?"

**If performance is weak:**
- "Are you comfortable with the direction we're taking to improve this?"
- "Does what we're testing make sense from your perspective?"

**If performance is strong:**
- "How are you presenting these results internally?"
- "Do you feel confident scaling this further?"

### 6. Red Flags Checklist
- Client replies slower than usual
- Responses are short or low-effort
- Missed or delayed meetings
- Less engagement or curiosity
- Feedback becomes vague
- Tone feels colder
- Mentions internal issues (budget, team, pressure)

### 7. Green Flags Checklist
- Fast and consistent replies
- Detailed feedback
- Asking questions
- Sharing internal updates
- Positive tone or appreciation
- Interest in scaling or expanding
- Engaging with ideas

### 8. Action Items
- One key issue to fix
- One opportunity to push forward

---

## Monthly Client Check Framework

### 1. Business Alignment
- Has the client's goal changed?
- Are we still solving the right problem?
- How do they measure success internally?

### 2. Satisfaction Check (ask directly)
- "If you had to rate how things are going right now, what would you say?"
- "What's one thing we should improve next month?"
- "Are you happy with the quality of results we're generating?"

### 3. Value Perception
- "If you had to explain our value internally, what would you say?"

### 4. Performance Understanding
- What worked this month?
- What didn't work?
- What did we learn?

### 5. Expansion & Retention
- "What would make this a no-brainer to continue or expand?"
- Opportunities to scale, test new segments, expand scope

### 6. Risk Level Classification
- 🔴 High Risk: weak performance + weak engagement
- 🟠 Medium Risk: some instability
- 🟢 Low Risk: strong engagement + stable results

### 7. Monthly Reflection (Internal)
- What was handled well?
- Where was control lost or reaction too late?
- What would be done differently if restarting this account today?
