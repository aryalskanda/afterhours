#!/bin/sh
# Afterhours hook relay. Claude Code runs this for hooks in sessions Afterhours started; it
# forwards the event JSON (stdin) to the daemon and prints the daemon's decision. If the daemon is
# unreachable it prints nothing, and Claude Code carries on as if there were no hook.
[ -n "$CQ_JOB_ID" ] || exit 0
home="${CQ_HOME:-$HOME/.afterhours}"
token=$(cat "$home/token" 2>/dev/null) || exit 0
curl -s --max-time "${CQ_HOOK_MAX_TIME:-4000}" -X POST \
  -H 'content-type: application/json' -H "x-cq-token: $token" \
  --data-binary @- "http://127.0.0.1:${CQ_PORT:-7787}/hook/$1?job=$CQ_JOB_ID" || true
exit 0
