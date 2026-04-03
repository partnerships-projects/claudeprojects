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

**MeetGeek Integration:** The skill pulls full transcripts directly from MeetGeek via API when invoked manually.

## Project Structure
- `index.html` — Campaign performance dashboard
- `ops.sh` — Operations automation script
- `.claude/skills/` — Skill definitions for Claude Code
- `.claude/settings.json` — Project settings
- `n8n-playbook-workflow.json` — Standalone n8n workflow for automated MeetGeek → playbook analysis
- `SETUP.md` — Setup guide
