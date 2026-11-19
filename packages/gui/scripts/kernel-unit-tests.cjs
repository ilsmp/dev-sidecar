// 内核自定义逻辑回归门禁: node packages/gui/scripts/kernel-unit-tests.cjs
// 覆盖: 迟滞恢复 / 增强判定优先级与中继守卫 / 本地优先远程兜底 / 持久化黑名单与自动解禁。
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

// --- 增强判定优先级 / 中继守卫 ---
// 场景(2026-11-19): www.google.com 在 targets 里没有条目时被 pac.txt(gfwlist) 判为增强域名,
// 转发到本地适配器及其上游 VPN, 出口地域漂到 CN 导致 AI 模式被拒; 中继守卫必须拦下它。
const overwall = require(DS + '/lib/proxy/middleware/overwall.js');
const owTargets = matchUtil.domainMapRegexply({ 'chatgpt.com': true, 'github.com': false });
const relayMap = matchUtil.domainMapRegexply({ '^(?!fonts).*(with)?google(apis|usercontent)?.com.*$': { '8.137.102.117': true } });
const relayGuard = h => { const v = matchUtil.matchHostname(relayMap, h); return v != null && v !== false && v !== 'false'; };
const pacHit = () => 'PROXY 127.0.0.1:1080;';
assert(overwall._matchTarget('www.google.com', owTargets, { relayGuard, findProxyForURL: pacHit }) === null, '中继守卫: pac 命中的 google 家族不再被增强劫持');
assert((overwall._matchTarget('www.google.com', owTargets, { findProxyForURL: pacHit }) || {}).source === 'pac', '无守卫时 pac 命中仍走增强(官方行为不回归)');
assert((overwall._matchTarget('chatgpt.com', owTargets, { relayGuard, findProxyForURL: pacHit }) || {}).source === 'config', '显式 true 优先: 适配器域名不受中继守卫影响');
assert(overwall._matchTarget('github.com', owTargets, { relayGuard, findProxyForURL: pacHit }) === null, '显式 false 优先于 pac');
assert((overwall._matchTarget('www.google.com', matchUtil.domainMapRegexply({ 'www.google.com': true }), { relayGuard, findProxyForURL: pacHit }) || {}).source === 'config', '中继守卫不覆盖 targets 里的显式 true(使用者意图最高)');
assert(overwall._matchTarget('example.com', owTargets, { relayGuard, findProxyForURL: () => 'DIRECT' }) === null, 'pac 未命中时不增强(无回归)');

// --- 中继守卫的分层降级(健康 => 守住 / 持续不可用 => 放行适配器兜底 / 恢复 => 回中继) ---
const { createRelayGuard } = require(DS + '/lib/proxy/middleware/relayGuard.js');
const guardMap = matchUtil.domainMapRegexply({ '^(?!fonts).*(with)?google(apis|usercontent)?.com.*$': { '9.9.9.9': true } });
let fakeBlacklistTs = {};
let fakeNow = 1000000;
const guard = createRelayGuard(guardMap, {
  graceMs: 30000,
  isBlacklistedSince: ip => (fakeBlacklistTs[ip] != null ? fakeBlacklistTs[ip] : null),
  now: () => fakeNow,
  logger: { warn () {} },
});
assert(guard('www.google.com') === true, '守卫: 中继健康时生效(google 走中继直连)');
assert(guard('chatgpt.com') === false, '守卫: 非中继白名单家族不受影响(仍走适配器)');
fakeBlacklistTs['9.9.9.9'] = fakeNow - 5000;
assert(guard('www.google.com') === true, '守卫: 宽限期内视为抖动, 不翻到适配器(DNS 层落回官方预设)');
fakeNow += 60000;
assert(guard('www.google.com') === false, '守卫: 中继持续不可用超宽限期 => 放行增强/适配器兜底');
fakeBlacklistTs = {};
assert(guard('www.google.com') === true, '守卫: 中继复测解禁后自动回到中继直连');
const guardOff = createRelayGuard(matchUtil.domainMapRegexply({ 'a.example.com': { '1.1.1.1': false } }), { logger: { warn () {} } });
assert(guardOff('a.example.com') === false, '守卫: 白名单键内 IP 全部停用时等同未配置');
assert(createRelayGuard(matchUtil.domainMapRegexply({})) === null, '守卫: 未配置中继白名单时不启用(官方行为零改变)');

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
