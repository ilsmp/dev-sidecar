#!/usr/bin/env bash
# 适配器引擎冒烟测试: 环境变量隔离 conf/pid/log 到临时目录, 完全不触碰仓库内真实配置
# 用法: bash scripts/adapter-smoke.sh   (仓库根目录执行, 需 node + curl 在 PATH)
set -euo pipefail
cd "$(dirname "$0")/.."

ADAPTER_DIR="packages/gui/extra/adapter"
PORT=${ADAPTER_SMOKE_PORT:-18471}
PORT2=$((PORT + 1))
WORK="$(mktemp -d)"
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then kill "$SERVER_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

SECRET=smoke000000
PASSWORD=smokepassword000000
CONF_WORK="$WORK/conf.json"
LOG_WORK="$WORK/adapter.log"
PID_WORK="$WORK/adapter.pid"

write_conf() { # $1 = port
  cat > "$CONF_WORK" <<ZEOF
{
  "port": $1,
  "secret": "$SECRET",
  "password": "$PASSWORD",
  "upstream": "http://127.0.0.1:7890",
  "directTimeoutMs": 1000
}
ZEOF
}

fail=0
check() {
  if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 (expect $2 got $3)"; fail=1; fi
}

# ---- start on PORT ----
write_conf "$PORT"
ADAPTER_CONF="$CONF_WORK" ADAPTER_PID="$PID_WORK" ADAPTER_LOG="$LOG_WORK" node "$ADAPTER_DIR/server.cjs" &
SERVER_PID=$!
for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$PORT/healthz?secret=$SECRET" >/dev/null 2>&1; then break; fi
  sleep 0.2
done

check healthz-ok 200 "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/healthz?secret=$SECRET")"
check healthz-bad 403 "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/healthz?secret=wrong")"

check path-noauth 403 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/$SECRET/example.com/")"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -H "dspassword: $PASSWORD" "http://127.0.0.1:$PORT/$SECRET/example.com/" || true)
check path-auth 200 "$code"
check path-badpw 403 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'dspassword: wrong' "http://127.0.0.1:$PORT/$SECRET/example.com/" || true)"

check loopback-block 403 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "dspassword: $PASSWORD" "http://127.0.0.1:$PORT/$SECRET/127.0.0.1:1/" || true)"

# ---- hot reload directSkipHosts ----
write_conf "$PORT"
python3 -c "import io, json, sys; p = sys.argv[1]; c = json.load(io.open(p)); c['directSkipHosts'] = ['smoke-test-invalid.example']; io.open(p, 'w').write(json.dumps(c, indent=2))" "$CONF_WORK"
sleep 4
curl -s -o /dev/null --max-time 20 -H "dspassword: $PASSWORD" "http://127.0.0.1:$PORT/$SECRET/smoke-test-invalid.example/" || true
sleep 1
if grep -q "DIRECT-SKIP-CONFIG" "$LOG_WORK" 2>/dev/null; then
  echo "PASS hot-reload"
else
  echo "FAIL hot-reload (no DIRECT-SKIP-CONFIG in log)"; fail=1
fi

# ---- port hot switch PORT -> PORT2 ----
write_conf "$PORT2"
sleep 5
check port-hot-switch-old-down 000 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$PORT/healthz?secret=$SECRET" 2>/dev/null || true)"
check port-hot-switch-new-up 200 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT2/healthz?secret=$SECRET")"

# ---- repo conf.json untouched ----
if git diff --quiet -- "$ADAPTER_DIR/conf.json"; then
  echo "PASS conf-isolated"
else
  echo "FAIL conf-isolated (repo conf.json was modified)"; fail=1
fi

if [ "$fail" = 0 ]; then echo "ALL PASS"; else exit 1; fi
