# Account Manager Playbook — Setup Guide

## What This Does

When a meeting is recorded in MeetGeek, this system automatically:
1. Receives the transcript via webhook
2. Analyzes it against the Account Manager Playbook (12 rules + weekly/monthly checklists)
3. Posts a structured analysis to Slack with: client situation, call summary, performance assessment, rule compliance scorecard, next steps, and risk level

This is a **standalone workflow** — it does not interfere with your existing MeetGeek → Slack setup.

---

## Setup Steps

### Step 1: Import the n8n Workflow

1. Open your n8n instance
2. Go to **Workflows** → **Import from File**
3. Select `n8n-playbook-workflow.json` from this repo
4. The workflow will appear as: `MeetGeek → Account Manager Playbook Analysis → Slack`

### Step 2: Configure Credentials

**Anthropic API Key:**
1. In n8n, go to **Settings** → **Environment Variables**
2. Add: `ANTHROPIC_API_KEY` = your Anthropic API key
3. Or: Edit the "Claude Playbook Analysis" node and replace `{{ $env.ANTHROPIC_API_KEY }}` with your key directly

**Slack:**
1. In the "Post to Slack" node, connect your existing Slack credential
2. The default channel is `#playbook-channel` (C0ANCMX689Z) — change this if you want a dedicated channel

### Step 3: Connect MeetGeek

1. Activate the workflow in n8n — this generates a webhook URL
2. Copy the webhook URL (shown in the "MeetGeek Webhook" node)
3. In MeetGeek, go to **Settings** → **Integrations** → **Webhooks**
4. Add a new webhook with the URL from step 2
5. Set the trigger to: **When a new meeting transcript is ready**

The webhook expects a JSON payload with these fields (MeetGeek sends these automatically):
- `meeting_title` or `title`
- `meeting_date` or `date`
- `meeting_duration` or `duration`
- `participants`
- `transcript` or `text` or `content`

### Step 4: Test

1. In n8n, click **Test Workflow**
2. Send a test webhook with sample data, or wait for your next MeetGeek recording
3. Check `#playbook-channel` in Slack for the playbook analysis

---

## Slack Output Format

Each analysis posts to Slack with:

1. **🎯 Client Situation Assessment** — Relationship pulse (🔴🟠🟢), tone signals, red/green flags with evidence
2. **📝 Call Summary** — Topics, decisions, concerns, commitments
3. **📊 Performance Assessment** — Status, root cause, what the numbers mean
4. **📏 Playbook Rule Compliance** — All 12 rules scored (✅⚠️❌) with transcript evidence
5. **➡️ Suggested Next Steps** — Key issue, key opportunity, recommended questions, specific actions
6. **🚦 Risk Level** — 🔴 High / 🟠 Medium / 🟢 Low with justification

---

## Claude Code Skill

The playbook is also available as a Claude Code skill. Anyone on the team can use it by:

1. Providing a meeting transcript in a Claude Code conversation
2. Asking for a playbook analysis

The skill definition is in `.claude/skills/account-manager-playbook.md`.

---

## Customization

**Change Slack channel:** Edit the "Post to Slack" node and update the channel ID
**Adjust analysis depth:** Edit the system prompt in the "Claude Playbook Analysis" node
**Change AI model:** Replace `claude-sonnet-4-6` with another model in the HTTP request body
**Add more output channels:** Duplicate the Slack node and point to additional channels
