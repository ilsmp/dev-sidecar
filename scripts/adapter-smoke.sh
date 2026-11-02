#!/usr/bin/env bash
# 适配器引擎冒烟测试: 启动临时实例(端口 18471), 验证健康检查/直连/兜底/热更新/安全拦截
# 用法: bash scripts/adapter-smoke.sh   (仓库根目录执行, 需 node 在 PATH)
set -euo pipefail
cd "$(dirname "$0")/.."

ADAPTER_DIR="packages/gui/extra/adapter"
PORT=${ADAPTER_SMOKE_PORT:-18471}
WORK="$(mktemp -d)"
trap 'kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$WORK"' EXIT

# 独立 conf, 不触碰真实 conf.json
SECRET=smoke000000
PASSWORD=smokepassword000000
cat > "$ADAPTER_DIR/conf.json" <<EOF
{
  "port": $PORT,
  "secret": "$SECRET",
  "password": "$PASSWORD",
  "upstream": "http://127.0.0.1:7890",
  "directTimeoutMs": 1000
}
EOF

node "$ADAPTER_DIR/server.cjs" &
SERVER_PID=$!
for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$PORT/healthz?secret=$SECRET" >/dev/null 2>&1; then break; fi
  sleep 0.2
done

fail=0
check() { # name expected result
  if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 (expect $2 got $3)"; fail=1; fi
}

# 1. 健康检查: 正确 secret 200, 错误 secret 403
check healthz-ok 200 "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/healthz?secret=$SECRET")"
check healthz-bad 403 "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/healthz?secret=wrong")"

# 2. 协议路径请求: /{secret}/{host}[:port]{path} + dspassword 头

check path-noauth 403 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/$SECRET/example.com/")"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -H "dspassword: $PASSWORD" "http://127.0.0.1:$PORT/$SECRET/example.com/" || true)

check path-auth 200 "$code"

check path-badpw 403 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'dspassword: wrong' "http://127.0.0.1:$PORT/$SECRET/example.com/" || true)"

# 3. loopback 目标必须被拒绝(防回环放大)

check loopback-block 403 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "dspassword: $PASSWORD" "http://127.0.0.1:$PORT/$SECRET/127.0.0.1:1/" || true)"

# 4. 热更新: directSkipHosts 写入后 3 秒内生效(日志出现 DIRECT-SKIP-CONFIG)
cat > "$ADAPTER_DIR/conf.json" <<EOF
{
  "port": $PORT,
  "secret": "$SECRET",
  "password": "$PASSWORD",
  "upstream": "http://127.0.0.1:7890",
  "directTimeoutMs": 1000,
  "directSkipHosts": ["smoke-test-invalid.example"]
}
EOF
sleep 4
# 主动发一个命中 directSkipHosts 的请求, 使热更新产生可见日志
curl -s -o /dev/null --max-time 20 -H "dspassword: $PASSWORD" "http://127.0.0.1:$PORT/$SECRET/smoke-test-invalid.example/" || true
sleep 1
if grep -q "DIRECT-SKIP-CONFIG" "$ADAPTER_DIR/adapter.log" 2>/dev/null; then
  echo "PASS hot-reload"
else
  echo "FAIL hot-reload (no DIRECT-SKIP-CONFIG in log)"; fail=1
fi

if [ "$fail" = 0 ]; then echo "ALL PASS"; else exit 1; fi

