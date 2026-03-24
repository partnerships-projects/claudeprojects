# Claude Projects

## Overview
Campaign performance dashboard and account management toolkit for outreach operations.

## Skills

### Account Manager Playbook (`/account-manager-playbook`)
Analyzes meeting transcripts and client interactions against the Account Manager Playbook. Produces structured assessments including:
- Client situation and relationship pulse
- Call summary
- Performance assessment with root cause analysis
- Playbook rule compliance feedback (all 12 rules)
- Suggested next steps and risk classification

**Usage:** Invoke with `/account-manager-playbook` and provide a meeting transcript or client interaction context.

**MeetGeek Integration:** A standalone n8n workflow (`n8n-playbook-workflow.json`) connects MeetGeek to the playbook analysis. When a new meeting is recorded, MeetGeek sends the transcript via webhook → Claude analyzes it against the playbook → results post to Slack. This is independent from existing MeetGeek workflows. See `SETUP.md` for configuration.

## Project Structure
- `index.html` — Campaign performance dashboard
- `ops.sh` — Operations automation script
- `.claude/skills/` — Skill definitions for Claude Code
- `n8n-playbook-workflow.json` — Standalone n8n workflow (import into n8n)
- `SETUP.md` — Setup guide for the MeetGeek → Playbook → Slack pipeline
