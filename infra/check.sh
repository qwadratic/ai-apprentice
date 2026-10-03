#!/usr/bin/env bash
# Acceptance checks from doc-5. Never prints the token.
#   On the VM (local, through port 8000):  infra/check.sh
#   From a Mac (public proxy), once: brew install jq imagemagick   (curl, perl, base64 ship with macOS)
#     T=$(ssh apprentice.exe.xyz "sudo grep ^API_TOKEN= /etc/apprentice/env | cut -d= -f2") \
#       BASE=https://apprentice.exe.xyz bash <(ssh apprentice.exe.xyz cat work/ai-apprentice/infra/check.sh)
#   ORIGIN (default https://qwadratic.github.io) must be one of ALLOWED_ORIGINS.
# Needs curl, jq, perl, base64 and ImageMagick (magick or convert).
set -uo pipefail
BASE="${BASE:-http://127.0.0.1:8000}"
ORIGIN="${ORIGIN:-https://qwadratic.github.io}"
if [ -z "${T:-}" ]; then T="$(sudo grep ^API_TOKEN= /etc/apprentice/env | cut -d= -f2)"; fi
[ -n "$T" ] || { echo "no API token" >&2; exit 2; }
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
# The token goes into a 0600 header file, so it never shows up in `ps`.
( umask 077; printf 'Authorization: Bearer %s\n' "$T" > "$W/auth" )
unset T
AUTH=(-H @"$W/auth")
pass=0; fail=0
ok() { echo "PASS  $*"; pass=$((pass+1)); }
ko() { echo "FAIL  $*"; fail=$((fail+1)); }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
now_ms() { perl -MTime::HiRes=time -e 'printf "%d", time*1000'; }
p50() { sort -n | awk '{a[NR]=$1} END{print a[int((NR+1)/2)]}'; }

echo "== $BASE"
h="$(curl -fsS -m 10 "$BASE/health")" && echo "$h" | jq -e .ok >/dev/null && ok "health $h" || ko "health ${h:-unreachable}"

c="$(code -X POST "$BASE/runner/v1/complete")"; [ "$c" = 401 ] && ok "no token -> 401" || ko "no token -> $c"

c="$(curl -si -X OPTIONS "$BASE/health" -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST' | grep -ci access-control-allow-origin)"
[ "$c" = 0 ] && ok "foreign origin preflight has no ACAO" || ko "foreign origin preflight ACAO count $c"
pre="$(curl -si -X OPTIONS "$BASE/health" -H "Origin: $ORIGIN" -H 'Access-Control-Request-Method: POST')"
st="$(echo "$pre" | head -1 | tr -d '\r')"; acao="$(echo "$pre" | grep -i '^access-control-allow-origin' | tr -d '\r')"
if echo "$st" | grep -q ' 204' && echo "$acao" | grep -qF "$ORIGIN"; then ok "allowed preflight: $st; $acao"; else ko "allowed preflight: $st; ${acao:-no ACAO}"; fi

c="$(code "$BASE/agent/elevenlabs/signed-url" -H 'Origin: https://evil.example')"; [ "$c" = 403 ] && ok "signed-url foreign origin -> 403" || ko "signed-url foreign origin -> $c"
r="$(curl -s -w ' %{http_code}' "$BASE/agent/elevenlabs/signed-url" -H "Origin: $ORIGIN")"; c="${r##* }"; b="${r% *}"
case "$c" in
  200) echo "$b" | jq -e '.signed_url|startswith("wss://")' >/dev/null 2>&1 && ok "signed-url allowed origin -> 200 (url not printed)" || ko "signed-url 200 without a wss:// signed_url";;
  503) ok "signed-url allowed origin -> 503 $b";;
  *) ko "signed-url allowed origin -> $c";;
esac
SID="check-$(date +%s)-$$"
c="$(code -X POST "$BASE/agent/sessions/$SID/events" -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -d '{"events":[]}')"
[ "$c" = 403 ] && ok "session events foreign origin -> 403" || ko "session events foreign origin -> $c"
r="$(curl -s -X POST "$BASE/agent/sessions/$SID/events" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
  -d '{"conversationId":"conv_check","events":[{"t":1,"dir":"sys","type":"check","text":"check.sh synthetic event"},{"t":2,"dir":"sent","type":"user_transcript","text":"hello"}]}')"
echo "$r" | jq -e '.ok and .stored==2' >/dev/null && ok "session events stored $r" || ko "session events $r"
c="$(head -c 600000 /dev/zero | tr '\0' 'a' | curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/agent/sessions/$SID/events" -H "Origin: $ORIGIN" --data-binary @-)"
[ "$c" = 413 ] && ok "session events 600 KB -> 413" || ko "session events 600 KB -> $c"
c="$(code -X POST "$BASE/agent/sessions/$SID/events" -H "Origin: $ORIGIN" -d '{"conversationId":"conv_other","events":[{"t":3,"dir":"sys","type":"check","text":"x"}]}')"
[ "$c" = 409 ] && ok "session bound to its first conversationId (other -> 409)" || ko "session conversation mismatch -> $c"
c="$(code "$BASE/agent/sessions")"; [ "$c" = 401 ] && ok "session list without token -> 401" || ko "session list without token -> $c"
r="$(curl -s "$BASE/agent/sessions" "${AUTH[@]}")"
echo "$r" | jq -e --arg s "$SID" '.ok and any(.sessions[]; .id==$s and .hasEvents)' >/dev/null && ok "session list has $SID (total $(echo "$r" | jq .total_bytes) bytes)" || ko "session list"
r="$(curl -s "$BASE/agent/sessions/$SID" "${AUTH[@]}")"
echo "$r" | jq -e '.ok and (.events|length)==2 and .events[0].conversationId=="conv_check"' >/dev/null && ok "session get returns 2 events" || ko "session get $r"
c="$(code -X DELETE "$BASE/agent/sessions/$SID" "${AUTH[@]}")"; [ "$c" = 200 ] && ok "check session deleted" || ko "check session delete -> $c"

# ---- deploy webhook (infra/ops behind /ops/*)
r="$(curl -s -w ' %{http_code}' "$BASE/ops/deploy/status")"; c="${r##* }"; b="${r% *}"
if [ "$c" = 200 ] && echo "$b" | jq -e 'has("deployed_sha") and has("last")' >/dev/null 2>&1; then
  ok "ops status is public: $(echo "$b" | jq -c '{deployed_sha: ((.deployed_sha // "")[0:12]), last: (.last.state // null)}')"
else ko "ops status -> $c"; fi
UNSIGNED='{"sha":"0000000000000000000000000000000000000000","ts":0}'
c="$(code -X POST "$BASE/ops/deploy" -H 'Content-Type: application/json' -d "$UNSIGNED")"
[ "$c" = 401 ] && ok "ops deploy without signature -> 401" || ko "ops deploy without signature -> $c"
c="$(code -X POST "$BASE/ops/deploy" -H 'Content-Type: application/json' -H "X-Deploy-Signature: sha256=$(printf '0%.0s' $(seq 64))" -d "$UNSIGNED")"
[ "$c" = 401 ] && ok "ops deploy with a wrong signature -> 401" || ko "ops deploy with a wrong signature -> $c"
# Signed request for the deployed sha: needs the secret (DEPLOY_WEBHOOK_SECRET, or
# sudo on the VM) and node. Expect 202 and then "already deployed", or 422 when
# the deployed sha is not on origin/main (a branch deployed by hand).
WS="${DEPLOY_WEBHOOK_SECRET:-}"
if [ -z "$WS" ] && [[ "$BASE" == http://127.0.0.1* ]]; then WS="$(sudo grep ^DEPLOY_WEBHOOK_SECRET= /etc/apprentice/env 2>/dev/null | cut -d= -f2)"; fi
DSHA="$(echo "$b" | jq -r '.deployed_sha // empty' 2>/dev/null)"
if [ -n "$WS" ] && [ -n "$DSHA" ] && command -v node >/dev/null; then
  body="$(jq -cn --arg sha "$DSHA" --argjson ts "$(date +%s)" '{sha: $sha, ts: $ts}')"
  sig="$(BODY="$body" WS="$WS" node -e 'process.stdout.write(require("crypto").createHmac("sha256", process.env.WS).update(process.env.BODY).digest("hex"))')"
  r="$(curl -s -w ' %{http_code}' -X POST "$BASE/ops/deploy" -H 'Content-Type: application/json' -H "X-Deploy-Signature: sha256=$sig" --data-raw "$body")"; c="${r##* }"
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
  c="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/ops/deploy" -H 'Content-Type: application/json' -H "X-Deploy-Signature: sha256=$sig" --data-raw "$body")"
  [ "$c" = 409 ] && ok "replayed signature -> 409" || ko "replayed signature -> $c"
else
  echo "SKIP  signed webhook test (needs DEPLOY_WEBHOOK_SECRET and node)"
fi
unset WS

c="$(head -c 13000000 /dev/zero | curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/runner/v1/complete" "${AUTH[@]}" --data-binary @-)"
[ "$c" = 413 ] && ok "13 MB -> 413" || ko "13 MB -> $c"

# Large bodies through the proxy: an invalid media_type makes the runner answer
# 400 without a model call, so 400 means the body passed the proxy intact.
for mb in 6 8 10 11.9; do
  n="$(awk "BEGIN{printf \"%d\", $mb*1000000}")"
  { printf '{"prompt":"x","images":[{"media_type":"image/bmp","data":"'; head -c "$n" /dev/zero | tr '\0' 'A'; printf '"}]}'; } > "$W/big.json"
  r="$(curl -s -o /dev/null -w '%{http_code} %{time_total}s' -X POST "$BASE/runner/v1/vision" "${AUTH[@]}" -H 'Content-Type: application/json' --data-binary @"$W/big.json")"
  case "$r" in 400*) ok "${mb} MB POST passes (runner 400 on purpose) $r";; *) ko "${mb} MB POST -> $r";; esac
done

if [ "$(code "$BASE/debug/sse" -m 2)" = 404 ]; then echo "SKIP  /debug/sse (DEBUG_ENDPOINTS off)"; else
echo "-- /debug/sse arrival times (expect ~1 s apart)"
start="$(now_ms)"
curl -sN -m 15 "$BASE/debug/sse" | while IFS= read -r line; do
  case "$line" in data:*) printf '   +%5d ms %s\n' "$(( $(now_ms) - start ))" "$line";; esac
done
fi

SCHEMA_PROMPT='{"prompt":"Customer_07 asks for order data as text in the email body. Return the customer id and the requested format.","schema":{"type":"object","properties":{"customer":{"type":"string"},"format":{"type":"string"}},"required":["customer","format"],"additionalProperties":false}}'
IM="$(command -v magick || command -v convert)" || { echo "ImageMagick not found (brew install imagemagick)" >&2; exit 2; }
"$IM" -size 640x160 xc:white -pointsize 30 -fill black -draw "text 20,60 'To: customer_07'" -draw "text 20,110 'Order 1234, qty 5, 24.10.2026'" "$W/t.png"
jq -n --arg d "$(base64 < "$W/t.png" | tr -d '\n')" '{images:[{media_type:"image/png",data:$d}],prompt:"Read the text.",schema:{type:"object",properties:{recipient:{type:"string"},order:{type:"string"}},required:["recipient","order"],additionalProperties:false}}' > "$W/v.json"

: > "$W/c.ms"; : > "$W/v.ms"
for i in 1 2 3; do
  t0="$(now_ms)"
  out="$(curl -sS -m 90 -X POST "$BASE/runner/v1/complete" "${AUTH[@]}" -H 'Content-Type: application/json' -d "$SCHEMA_PROMPT")"
  echo $(( $(now_ms) - t0 )) >> "$W/c.ms"
  echo "$out" | jq -e '.ok and (.json.customer|ascii_downcase)=="customer_07"' >/dev/null && ok "complete #$i $(echo "$out" | jq -c .)" || ko "complete #$i $out"
done
for i in 1 2 3; do
  t0="$(now_ms)"
  out="$(curl -sS -m 90 -X POST "$BASE/runner/v1/vision" "${AUTH[@]}" -H 'Content-Type: application/json' -d @"$W/v.json")"
  echo $(( $(now_ms) - t0 )) >> "$W/v.ms"
  echo "$out" | jq -e '.ok and (.json.recipient|test("customer_07")) and (.json.order|test("1234"))' >/dev/null && ok "vision #$i $(echo "$out" | jq -c .)" || ko "vision #$i $out"
done
echo "   p50 complete $(p50 < "$W/c.ms") ms (all: $(tr '\n' ' ' < "$W/c.ms")); p50 vision $(p50 < "$W/v.ms") ms (all: $(tr '\n' ' ' < "$W/v.ms"))"

for i in 1 2 3 4 5; do
  curl -s -m 120 -o /dev/null -w '%{http_code}\n' -X POST "$BASE/runner/v1/complete" "${AUTH[@]}" -H 'Content-Type: application/json' -d "$SCHEMA_PROMPT" > "$W/par.$i" &
done; wait
codes="$(cat "$W"/par.* | sort | tr '\n' ' ')"
if ! cat "$W"/par.* | grep -qvE '^(200|429)$' && grep -q '^200$' "$W"/par.*; then ok "5 parallel: $codes"; else ko "5 parallel: $codes"; fi

if [[ "$BASE" == https://* ]]; then
  host="${BASE#https://}"; host="${host%%/*}"
  c="$(curl -m 5 -s -o /dev/null -w '%{http_code}' "https://$host:8787/health")"
  [ "$c" != 200 ] && ok "public :8787/health -> $c (not 200)" || ko "public :8787/health -> 200"
fi
echo "== $pass passed, $fail failed"
[ $fail = 0 ]
