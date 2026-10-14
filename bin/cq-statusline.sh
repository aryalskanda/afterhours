#!/bin/sh
# Afterhours status line for its sessions: passes Claude Code's status JSON (which carries
# the plan's usage-limit windows) to the daemon and prints the short line it returns.
[ -n "$CQ_JOB_ID" ] || exit 0
home="${CQ_HOME:-$HOME/.afterhours}"
token=$(cat "$home/token" 2>/dev/null) || { printf 'afterhours #%s' "$CQ_JOB_ID"; exit 0; }
line=$(/usr/bin/curl -s --max-time 2 -X POST \
  -H 'content-type: application/json' -H "x-cq-token: $token" \
  --data-binary @- "http://127.0.0.1:${CQ_PORT:-7787}/statusline?job=$CQ_JOB_ID") || line=""
if [ -n "$line" ]; then printf '%s' "$line"; else printf 'afterhours #%s' "$CQ_JOB_ID"; fi
