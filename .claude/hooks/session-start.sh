#!/bin/bash
set -euo pipefail

# Only run in remote environments (Claude Code on the web)
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  # Also run locally if curl is available
  if ! command -v curl &> /dev/null; then
    exit 0
  fi
fi

MEETGEEK_API_KEY="eu-REuDLp8xoUqkYDXqXdawOGvJUDTnkAf6k2o3smJDKhkN6GOX6ZtIFb3cg5WwXexcCHarpDoS2P0XkGtcEp1Qcuf0aiK83G19H3TqK0BHJ5uxpUachkD4nnPPbWNQd"
MEETGEEK_BASE_URL="https://api.meetgeek.ai"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-/home/user/claudeprojects}"
LAST_ANALYZED_FILE="$PROJECT_DIR/.claude/last-analyzed-meeting.txt"
PENDING_FILE="$PROJECT_DIR/.claude/pending-meeting.json"

# Get latest meeting from MeetGeek
MEETINGS_RESPONSE=$(curl -s --connect-timeout 10 \
  -H "Authorization: Bearer $MEETGEEK_API_KEY" \
  "$MEETGEEK_BASE_URL/v1/meetings?limit=1" 2>/dev/null || echo "")

if [ -z "$MEETINGS_RESPONSE" ]; then
  exit 0
fi

# Extract meeting ID (simple JSON parsing)
MEETING_ID=$(echo "$MEETINGS_RESPONSE" | grep -o '"meeting_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | grep -o '"[^"]*"$' | tr -d '"')

if [ -z "$MEETING_ID" ]; then
  exit 0
fi

# Check if already analyzed
LAST_ANALYZED=""
if [ -f "$LAST_ANALYZED_FILE" ]; then
  LAST_ANALYZED=$(cat "$LAST_ANALYZED_FILE")
fi

if [ "$MEETING_ID" = "$LAST_ANALYZED" ]; then
  # Already analyzed, nothing to do
  exit 0
fi

# New meeting found! Get the transcript
TRANSCRIPT_RESPONSE=$(curl -s --connect-timeout 15 \
  -H "Authorization: Bearer $MEETGEEK_API_KEY" \
  "$MEETGEEK_BASE_URL/v1/transcript?meeting_id=$MEETING_ID" 2>/dev/null || echo "")

# Get meeting details
MEETING_RESPONSE=$(curl -s --connect-timeout 10 \
  -H "Authorization: Bearer $MEETGEEK_API_KEY" \
  "$MEETGEEK_BASE_URL/v1/meeting?meeting_id=$MEETING_ID" 2>/dev/null || echo "")

# Save pending meeting data for Claude to pick up
cat > "$PENDING_FILE" << JSONEOF
{
  "meeting_id": "$MEETING_ID",
  "details": $MEETING_RESPONSE,
  "transcript": $TRANSCRIPT_RESPONSE
}
JSONEOF

echo "New MeetGeek meeting detected: $MEETING_ID — pending playbook analysis"
