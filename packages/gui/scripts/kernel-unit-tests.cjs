// 内核自定义逻辑回归门禁: node packages/gui/scripts/kernel-unit-tests.cjs
// 覆盖: 迟滞恢复 / 本地优先远程兜底 / 持久化黑名单与自动解禁。
// 任何 ds-core 相关改动提交前应跑通本脚本(exit 0)。
process.env.DEV_SIDECAR_USER_BASE = process.env.KUT_BASE || '/tmp/ds-kernel-unit-tests';
const fs = require('fs');
fs.mkdirSync(process.env.DEV_SIDECAR_USER_BASE, { recursive: true });
const DS = '/Users/zhangjiahao/Documents/smartGit/dev-sidecar/vendor/ds-core/mitmproxy/src';
const speed = require(DS + '/lib/speed/index.js');
const SpeedTester = require(DS + '/lib/speed/SpeedTester.js');
const BaseDNS = require(DS + '/lib/dns/base.js');
const matchUtil = require(DS + '/utils/util.match.js');
const blacklist = require(DS + '/lib/speed/ipBlacklist.js');
let failed = 0;
const assert = (cond, msg) => {
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + msg);
  if (!cond) failed++;
};

// --- 迟滞恢复 ---
const st = Object.create(SpeedTester.prototype);
st.hostname = 'hyst.example.com'; st.port = 443; st.alive = []; st.backupList = []; st._probeIndex = 0; st.tryTestCount = 0;
const mk = (h, status, time) => ({ host: h, status, time, dns: 'PreSet' });
const A = mk('1.1.1.1', 'failed', 255), B = mk('2.2.2.2', 'success', 300), C = mk('3.3.3.3', undefined, undefined);
st.backupList = [A, B, C]; st.alive = [B];
st.reportProbeResult('1.1.1.1', true);
assert(A.status === 'failed' && !st.alive.includes(A), '迟滞: failed IP 单次成功不恢复');
st.reportProbeResult('1.1.1.1', true);
assert(A.status === 'success' && st.alive.includes(A), '迟滞: 连续两次成功恢复');
st.reportProbeResult('3.3.3.3', true);
assert(st.alive.includes(C), '迟滞: 健康新 IP 单次成功即启用(无回归)');

// --- 本地优先 / 黑名单 ---
let fakeStatus = {};
speed.getSpeedTester = () => ({ backupList: Object.entries(fakeStatus).map(([host, status]) => ({ host, status })) });
const merged = matchUtil.domainMapRegexply({ 'lf.example.com': { '1.1.1.1': true, '2.2.2.2': true } });
const userOnly = matchUtil.domainMapRegexply({ 'lf.example.com': { '1.1.1.1': true } });
const mkdns = () => { const d = new BaseDNS('x', 4, 'PreSet', 'preset', 100, merged); d.preSetIpUserList = userOnly; return d; };
(async () => {
  fakeStatus = {};
  let l = await mkdns()._lookupWithPreSetIpList('lf.example.com');
  assert(JSON.stringify(l) === '["1.1.1.1"]', '本地优先: 用户层健康时只用用户层 IP');
  fakeStatus = { '1.1.1.1': 'failed' };
  l = await mkdns()._lookupWithPreSetIpList('lf.example.com');
  assert(l.includes('2.2.2.2'), '远程兜底: 用户层全不健康时放开合并池');
  fakeStatus = {};
  blacklist.add('1.1.1.1', 'unit', 'lf.example.com');
  l = await mkdns()._lookupWithPreSetIpList('lf.example.com');
  assert(JSON.stringify(l) === '["2.2.2.2"]', '黑名单: 被拉黑 IP 从预设池排除');
  blacklist.remove('1.1.1.1');
  const st2 = new SpeedTester({ hostname: 'bl.example.com', port: 443 });
  st2.backupList = [{ host: '3.3.3.3', dns: 'x' }];
  st2.reportProbeResult('3.3.3.3', false);
  assert(blacklist.isBlacklisted('3.3.3.3'), '黑名单: 失败反馈自动写入');
  st2.testOne = async () => ({ by: 'TCP', target: 't', time: 1 });
  await st2.recheckBlacklist();
  await st2.recheckBlacklist();
  assert(!blacklist.isBlacklisted('3.3.3.3'), '黑名单: 复测连续两次成功自动解禁');
  console.log(failed ? `FAILED: ${failed} 项` : 'ALL_KERNEL_UNIT_TESTS_PASSED');
  process.exit(failed ? 1 : 0);
})();
