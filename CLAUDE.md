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

**MeetGeek Integration:** The skill pulls full transcripts directly from MeetGeek via the MeetGeek MCP server (configured in `.mcp.json`). This gives access to raw transcripts with speaker labels and timestamps — not the condensed summaries from #clients-notes. A standalone n8n workflow (`n8n-playbook-workflow.json`) is also available for automated analysis when new meetings are recorded. See `SETUP.md` for configuration.

## Project Structure
- `index.html` — Campaign performance dashboard
- `ops.sh` — Operations automation script
- `.claude/skills/` — Skill definitions for Claude Code
- `.mcp.json` — MCP server config (MeetGeek integration)
- `n8n-playbook-workflow.json` — Standalone n8n workflow (import into n8n)
- `SETUP.md` — Setup guide for the MeetGeek → Playbook → Slack pipeline
