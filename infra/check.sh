#!/usr/bin/env bash
# Acceptance checks from doc-5. Never prints the token.
#   On the VM (local, through port 8000):  infra/check.sh
#   From a laptop (public proxy):
#     T=$(ssh apprentice.exe.xyz "sudo grep ^API_TOKEN= /etc/apprentice/env | cut -d= -f2") \
#       BASE=https://apprentice.exe.xyz ORIGIN=https://qwadratic.github.io infra/check.sh
# Needs curl, jq, base64 and ImageMagick (convert or magick).
set -uo pipefail
BASE="${BASE:-http://127.0.0.1:8000}"
ORIGIN="${ORIGIN:-https://qwadratic.github.io}"
if [ -z "${T:-}" ]; then T="$(sudo grep ^API_TOKEN= /etc/apprentice/env | cut -d= -f2)"; fi
[ -n "$T" ] || { echo "no API token" >&2; exit 2; }
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
AUTH=(-H "Authorization: Bearer $T")
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

echo "-- /debug/sse arrival times (expect ~1 s apart)"
start="$(now_ms)"
curl -sN -m 15 "$BASE/debug/sse" | while IFS= read -r line; do
  case "$line" in data:*) printf '   +%5d ms %s\n' "$(( $(now_ms) - start ))" "$line";; esac
done

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
