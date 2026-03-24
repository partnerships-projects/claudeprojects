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

**MeetGeek Integration:** The skill pulls full transcripts directly from MeetGeek via API. A session start hook automatically checks for new meetings every time a Claude Code session starts.

**Automated Analysis:** On every session start, check if `.claude/pending-meeting.json` exists. If it does:
1. Read the file — it contains meeting details and full transcript from MeetGeek
2. Run the playbook analysis on the transcript (use the Account Manager Playbook rules)
3. Post the analysis to `#playbook-channel` (channel ID: `C0ANCMX689Z`) via `slack_send_message`
4. Save the meeting ID to `.claude/last-analyzed-meeting.txt` to prevent duplicate analysis
5. Delete `.claude/pending-meeting.json`

## Project Structure
- `index.html` — Campaign performance dashboard
- `ops.sh` — Operations automation script
- `.claude/skills/` — Skill definitions for Claude Code
- `.claude/hooks/session-start.sh` — Auto-checks MeetGeek for new meetings on session start
- `.claude/settings.json` — Hook configuration
- `n8n-playbook-workflow.json` — Standalone n8n workflow (alternative automation)
- `SETUP.md` — Setup guide
