#!/usr/bin/env bash
# Acceptance checks for the public API on the VM: apps/api (agent and ops modules)
# on port 8000. Never prints a token.
#   On the VM (local, through port 8000):  infra/check.sh
#   From a Mac (public proxy):
#     T=$(ssh apprentice.exe.xyz "sudo grep ^API_TOKEN= /etc/apprentice/env | cut -d= -f2") \
#       BASE=https://apprentice.exe.xyz bash <(ssh apprentice.exe.xyz cat work/ai-apprentice/infra/check.sh)
#   ORIGIN (default https://qwadratic.github.io) must be one of ALLOWED_ORIGINS.
#   T is API_TOKEN (the admin routes); DEPLOY_WEBHOOK_SECRET (or sudo on the VM) enables the signed webhook test.
# Needs curl and jq; node only for the signed webhook test. Takes a few seconds, no model calls.
set -uo pipefail
BASE="${BASE:-http://127.0.0.1:8000}"
ORIGIN="${ORIGIN:-https://qwadratic.github.io}"
if [ -z "${T:-}" ]; then T="$(sudo grep ^API_TOKEN= /etc/apprentice/env | cut -d= -f2)"; fi
[ -n "$T" ] || { echo "no API token" >&2; exit 2; }
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
# Tokens go into 0600 header files, so they never show up in `ps`.
( umask 077; printf 'Authorization: Bearer %s\n' "$T" > "$W/admin" )
unset T
ADMIN=(-H @"$W/admin")
pass=0; fail=0
ok() { echo "PASS  $*"; pass=$((pass+1)); }
ko() { echo "FAIL  $*"; fail=$((fail+1)); }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== $BASE"
# ---- health, CORS
h="$(curl -fsS -m 10 "$BASE/health")" &&
  echo "$h" | jq -e '.ok == true and ((.modules // []) | index("agent")) != null and ((.modules // []) | index("ops")) != null' >/dev/null &&
  ok "health $h" || ko "health ${h:-unreachable} (want ok:true and the agent and ops modules)"

c="$(curl -si -X OPTIONS "$BASE/health" -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST' | grep -ci access-control-allow-origin)"
[ "$c" = 0 ] && ok "foreign origin preflight has no ACAO" || ko "foreign origin preflight ACAO count $c"
pre="$(curl -si -X OPTIONS "$BASE/health" -H "Origin: $ORIGIN" -H 'Access-Control-Request-Method: POST')"
st="$(echo "$pre" | head -1 | tr -d '\r')"; acao="$(echo "$pre" | grep -i '^access-control-allow-origin' | tr -d '\r')"
if echo "$st" | grep -q ' 204' && echo "$acao" | grep -qF "$ORIGIN"; then ok "allowed preflight: $st; $acao"; else ko "allowed preflight: $st; ${acao:-no ACAO}"; fi

# ---- ops module: deploy status and VM facts, through port 8000
r="$(curl -s -w ' %{http_code}' "$BASE/ops/deploy/status")"; c="${r##* }"; b="${r% *}"
if [ "$c" = 200 ] && echo "$b" | jq -e 'has("deployed_sha") and has("last")' >/dev/null 2>&1; then
  ok "ops status is public: $(echo "$b" | jq -c '{deployed_sha: ((.deployed_sha // "")[0:12]), last: (.last.state // null)}')"
else ko "ops status -> $c"; fi
r="$(curl -s -w ' %{http_code}' "$BASE/ops/vm-health")"; c="${r##* }"; b="${r% *}"
if [ "$c" = 200 ] && echo "$b" | jq -e '.ok == true and (.runner == "up" or .runner == "down") and has("git_sha") and has("deployed_sha")' >/dev/null 2>&1; then
  [ "$(echo "$b" | jq -r .runner)" = up ] && ok "vm-health: runner up, git_sha $(echo "$b" | jq -r '.git_sha[0:12]'), deployed_sha $(echo "$b" | jq -r '(.deployed_sha // "none")[0:12]')" || ko "vm-health: runner down ($b)"
else ko "vm-health -> $c $b"; fi

# ---- agent module: a session, its token, the events route
c="$(code -X POST "$BASE/api/agent/sessions" -H 'Origin: https://evil.example')"; [ "$c" = 403 ] && ok "create session, foreign origin -> 403" || ko "create session, foreign origin -> $c"
r="$(curl -s -w ' %{http_code}' -X POST "$BASE/api/agent/sessions" -H "Origin: $ORIGIN")"; c="${r##* }"; b="${r% *}"
SID="$(echo "$b" | jq -r '.sessionId // empty' 2>/dev/null)"
if [ "$c" = 201 ] && [ -n "$SID" ] && echo "$b" | jq -e '(.token | type) == "string" and (.token | length) > 20' >/dev/null 2>&1; then
  ok "create session from $ORIGIN -> 201 with a token (session ${SID:0:8}...)"
  ( umask 077; printf 'Authorization: Bearer %s\n' "$(echo "$b" | jq -r .token)" > "$W/sess" )
else ko "create session from $ORIGIN -> $c"; SID=""; fi
unset b r
if [ -n "$SID" ]; then
  EV="$BASE/api/agent/sessions/$SID/events"
  c="$(code -X POST "$EV" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"events":[]}')"
  [ "$c" = 401 ] && ok "events without a token -> 401" || ko "events without a token -> $c"
  c="$(code -X POST "$EV" -H 'Origin: https://evil.example' -H @"$W/sess" -H 'Content-Type: application/json' -d '{"events":[]}')"
  [ "$c" = 403 ] && ok "events from a foreign origin -> 403" || ko "events from a foreign origin -> $c"
  r="$(curl -s -w ' %{http_code}' -X POST "$EV" -H "Origin: $ORIGIN" -H @"$W/sess" -H 'Content-Type: application/json' \
    -d '{"conversationId":"conv_check","events":[{"t":1,"dir":"sys","type":"check","text":"check.sh synthetic event"},{"t":2,"dir":"sent","type":"user_transcript","text":"hello"}]}')"
  c="${r##* }"; b="${r% *}"
  [ "$c" = 200 ] && echo "$b" | jq -e '.ok and .stored==2' >/dev/null && ok "events with the token -> 200 $b" || ko "events with the token -> $c $b"
  c="$(code -X POST "$EV" -H "Origin: $ORIGIN" -H @"$W/sess" -d '{"conversationId":"conv_other","events":[{"t":3,"dir":"sys","type":"check","text":"x"}]}')"
  [ "$c" = 409 ] && ok "session bound to its first conversationId (other -> 409)" || ko "session conversation mismatch -> $c"
  c="$(head -c 600000 /dev/zero | tr '\0' 'a' | curl -s -o /dev/null -w '%{http_code}' -X POST "$EV" -H "Origin: $ORIGIN" -H @"$W/sess" --data-binary @-)"
  [ "$c" = 413 ] && ok "events 600 KB -> 413" || ko "events 600 KB -> $c"
  # A second session's token is valid, but not for this session.
  c2="$(curl -s -X POST "$BASE/api/agent/sessions" -H "Origin: $ORIGIN" | jq -r '.token // empty')"
  if [ -n "$c2" ]; then
    ( umask 077; printf 'Authorization: Bearer %s\n' "$c2" > "$W/sess2" ); unset c2
    c="$(code -X POST "$EV" -H "Origin: $ORIGIN" -H @"$W/sess2" -H 'Content-Type: application/json' -d '{"events":[]}')"
    [ "$c" = 403 ] && ok "another session's token -> 403" || ko "another session's token -> $c"
  else ko "second session could not be created"; fi
  c="$(head -c 13000000 /dev/zero | curl -s -o /dev/null -w '%{http_code}' -X POST "$EV" -H "Origin: $ORIGIN" -H @"$W/sess" -H 'Content-Type: application/json' --data-binary @-)"
  [ "$c" = 413 ] && ok "13 MB JSON -> 413" || ko "13 MB JSON -> $c"

  # ElevenLabs signed URL: origin and rate-limit rules apply; 503 means the key or agent id is not configured yet.
  SU="$BASE/api/agent/elevenlabs/signed-url"
  c="$(code "$SU" -H 'Origin: https://evil.example')"; [ "$c" = 403 ] && ok "signed-url foreign origin -> 403" || ko "signed-url foreign origin -> $c"
  r="$(curl -s -w ' %{http_code}' "$SU" -H "Origin: $ORIGIN" -H @"$W/sess")"; c="${r##* }"; b="${r% *}"
  case "$c" in
    200) echo "$b" | jq -e '.signed_url|startswith("wss://")' >/dev/null 2>&1 && ok "signed-url with a session -> 200 (url not printed)" || ko "signed-url 200 without a wss:// signed_url";;
    503) ok "signed-url with a session -> 503 $b";;
    *) ko "signed-url with a session -> $c";;
  esac
fi

# ---- the retired lab routes are gone (admin routes below stay)
c="$(code "$BASE/agent/elevenlabs/signed-url" -H "Origin: $ORIGIN")"; [ "$c" = 404 ] && ok "lab signed-url route is gone -> 404" || ko "lab signed-url route -> $c"
c="$(code -X POST "$BASE/agent/sessions/check-0000-0000/events" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"events":[]}')"
[ "$c" = 404 ] && ok "lab events route (no token) is gone -> 404" || ko "lab events route -> $c"

# ---- admin routes (API_TOKEN): list, read, delete the check session
c="$(code "$BASE/agent/sessions")"; [ "$c" = 401 ] && ok "session list without token -> 401" || ko "session list without token -> $c"
if [ -n "$SID" ]; then
  r="$(curl -s "$BASE/agent/sessions" "${ADMIN[@]}")"
  echo "$r" | jq -e --arg s "$SID" '.ok and any(.sessions[]; .id==$s and .hasEvents)' >/dev/null && ok "session list has ${SID:0:8}... (total $(echo "$r" | jq .total_bytes) bytes)" || ko "session list"
  r="$(curl -s "$BASE/agent/sessions/$SID" "${ADMIN[@]}")"
  echo "$r" | jq -e '.ok and (.events|length)==2 and .events[0].conversationId=="conv_check"' >/dev/null && ok "session get returns 2 events" || ko "session get $r"
  c="$(code -X DELETE "$BASE/agent/sessions/$SID" "${ADMIN[@]}")"; [ "$c" = 200 ] && ok "check session deleted (its token expires on its own)" || ko "check session delete -> $c"
fi

# ---- deploy webhook (infra/ops behind /ops/*). The signed body is sent as
# application/octet-stream: a JSON content type would be parsed by the API's body parser, so it is refused (415).
UNSIGNED='{"sha":"0000000000000000000000000000000000000000","ts":0}'
OCTET=(-H 'Content-Type: application/octet-stream')
c="$(code -X POST "$BASE/ops/deploy" -H 'Content-Type: application/json' -d "$UNSIGNED")"
[ "$c" = 415 ] && ok "ops deploy as application/json -> 415" || ko "ops deploy as application/json -> $c"
c="$(code -X POST "$BASE/ops/deploy" "${OCTET[@]}" -d "$UNSIGNED")"
[ "$c" = 401 ] && ok "ops deploy without signature -> 401" || ko "ops deploy without signature -> $c"
c="$(code -X POST "$BASE/ops/deploy" "${OCTET[@]}" -H "X-Deploy-Signature: sha256=$(printf '0%.0s' $(seq 64))" -d "$UNSIGNED")"
[ "$c" = 401 ] && ok "ops deploy with a wrong signature -> 401" || ko "ops deploy with a wrong signature -> $c"
c="$(head -c 5000 /dev/zero | tr '\0' 'a' | curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/ops/deploy" "${OCTET[@]}" --data-binary @-)"
[ "$c" = 413 ] && ok "ops deploy body over 4 KiB -> 413" || ko "ops deploy body over 4 KiB -> $c"
# Signed request for the deployed sha: needs the secret (DEPLOY_WEBHOOK_SECRET, or
# sudo on the VM) and node. Expect 202 and then "already deployed", or 422 when
# the deployed sha is not on origin/main (a branch deployed by hand).
WS="${DEPLOY_WEBHOOK_SECRET:-}"
if [ -z "$WS" ] && [[ "$BASE" == http://127.0.0.1* ]]; then WS="$(sudo grep ^DEPLOY_WEBHOOK_SECRET= /etc/apprentice/env 2>/dev/null | cut -d= -f2)"; fi
DSHA="$(curl -s "$BASE/ops/deploy/status" | jq -r '.deployed_sha // empty' 2>/dev/null)"
if [ -n "$WS" ] && [ -n "$DSHA" ] && command -v node >/dev/null; then
  body="$(jq -cn --arg sha "$DSHA" --argjson ts "$(date +%s)" '{sha: $sha, ts: $ts}')"
  sig="$(BODY="$body" WS="$WS" node -e 'process.stdout.write(require("crypto").createHmac("sha256", process.env.WS).update(process.env.BODY).digest("hex"))')"
  r="$(curl -s -w ' %{http_code}' -X POST "$BASE/ops/deploy" "${OCTET[@]}" -H "X-Deploy-Signature: sha256=$sig" --data-raw "$body")"; c="${r##* }"
  if [ "$c" = 202 ]; then
    state=""
    for _ in $(seq 30); do
      state="$(curl -s "$BASE/ops/deploy/status" | jq -r --arg s "$DSHA" 'if .last.sha == $s then .last.state else "" end')"
      case "$state" in ok|failed|rolled_back) break ;; esac
      sleep 2
    done
    [ "$state" = ok ] && ok "signed redeploy of ${DSHA:0:12} -> 202, then ok ($(curl -s "$BASE/ops/deploy/status" | jq -r .last.message))" || ko "signed redeploy ended as '$state'"
  elif [ "$c" = 422 ]; then
    ok "signed request accepted by HMAC; ${DSHA:0:12} is not on origin/main -> 422"
  else ko "signed request -> $r"; fi
  c="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/ops/deploy" "${OCTET[@]}" -H "X-Deploy-Signature: sha256=$sig" --data-raw "$body")"
  [ "$c" = 409 ] && ok "replayed signature -> 409" || ko "replayed signature -> $c"
else
  echo "SKIP  signed webhook test (needs DEPLOY_WEBHOOK_SECRET and node)"
fi
unset WS

if [[ "$BASE" == https://* ]]; then
  host="${BASE#https://}"; host="${host%%/*}"
  c="$(curl -m 5 -s -o /dev/null -w '%{http_code}' "https://$host:8787/health")"
  [ "$c" != 200 ] && ok "public :8787/health -> $c (not 200)" || ko "public :8787/health -> 200"
fi
echo "== $pass passed, $fail failed"
[ $fail = 0 ]
