# 自定义网络层设计备忘(2026-11-19)

本仓库在官方 dev-sidecar 之上的自定义层与运维流程。改内核(ds-core)或模板前必读。

## 路径分层

1. **增强模式(overwall)路径**: targets=true 的域名 → 适配器(127.0.0.1:6666) → 直连优先 → 失败转阡陌星云(127.0.0.1:7890)。当前仅 chatgpt/openai/claude 系。
2. **地域自适应中继路径**: 直连出口探测(regionPolicy.probes, 30分钟缓存)为受限地域(CN)时, preSetIpListRelay 声明的家族(google 系)只用中继池 8.137.102.117; 非受限地域落回官方预设直连。
3. **默认直连路径**: 其余域名走官方预设池/真实 DNS + SNI 改写拦截规则。

## 预设 IP 选择顺序(base.js _lookupWithPreSetIpList)

relay 白名单(受限地域, 池内同样过滤黑名单/IPv6) → 持久化黑名单过滤 → IPv6 过滤(无 IPv6 机器) → 本地优先(用户层健康 IP) → 合并池(含远程新增) → 真实 DNS 兜底链。

## 官方预设直连 vs 中继: 优先级结论(2026-11-19)

官方语义里没有「中继优先/官方优先」的开关: 一个域名的所有启用预设 IP 放进同一个池,
周期测速后取最快存活者。官方远程配置对 google 系给的是 `8.137.102.117: false`(阿里云中转关闭)
+ `142.251.189.206: {desc:"自动地区官方"}`(开启), 即官方默认官方预设优先、中继默认关闭。
2026-11-02 那份可用的旧配置把宽匹配 google 键翻成 `8.137.102.117: true` + `142.251.189.206: false`,
靠「手工禁用官方 IP」让中继成为池内唯一成员; 但 youtube/account/scholar 等键没禁官方 IP,
测速一旦选中 anycast 官方 IP, 出口地域就随 anycast 漂移, 这正是 AI 模式间歇性被拒的根因。

结论: 受限地域(CN)下中继必须严格优先于官方预设——「可达」不等于「出口地域合格」,
测速量不出地域资格; 非受限地域(海外)落回官方预设直连, 不绕道中继。实现即
`preSetIpListRelay`(白名单, 严格优先) + `regionPolicy`(出口探测), 比旧配置的「手工禁用」
更确定: 远程配置新增/恢复官方 IP 不会再把 google 系拽回 anycast 出口。

## 增强判定优先级与中继守卫(overwall.js matchTarget + relayGuard.js)

判定顺序(高→低): targets 显式 false → targets 显式真值 → 中继守卫 → pac.txt。
中继白名单家族(google 系)同时存在于 gfwlist(pac.txt) 中; 2026-11-19 定位的事故里,
`www.google.com` 在 targets 无条目, 被 pac 判为增强域名转发到本地适配器及其上游 VPN,
出口漂到 CN 导致 AI 模式被拒, 且只在适配器死亡退避窗口内恢复(表现为间歇性故障)。
中继守卫让白名单家族即使 pac 命中也不进适配器; targets 显式配置仍可单独覆盖守卫。

分层降级(健康信号 = 持久化黑名单, 与 DNS 层共用):

1. 中继 IP 健康 → 守卫生效, 走中继直连(出口稳定)。
2. 中继 IP 刚被拉黑(30s 宽限期内) → 守卫仍生效; DNS 层已过滤该 IP, 落回官方预设直连。
3. 中继持续不可用(超宽限期) → 守卫放行, 由 pac/targets 决定, 进适配器兜底。
4. 中继复测连续两次成功自动解禁 → 回到 1)。

## 运行时防护(ds-core fork)

- 迟滞恢复: failed IP 需连续两次成功才回池(SpeedTester)。
- 持久化黑名单: ~/.dev-sidecar/ip-blacklist.json, 连接失败自动拉黑, 测速周期复测(每周期≤2个), 连续两次成功解禁, 7天过期(ipBlacklist.js)。
- IPv6 过滤: 无 IPv6 机器过滤预设与解析结果中的 IPv6; 测速探针 EHOSTUNREACH 计入 reportIPv6Error。
- 地域探测失败缓存 60s, 未知按受限保守处理(egressRegion.js)。

## 配置层语义

- 合并顺序: 用户 > 个人远程 > 共享远程 > 默认; 按键深合并, 用户标量/整键优先。
- null = 删除标记, false = 禁用标记; 注意内核合并写回会消耗 preSetIpList 的 null 并对等价编译模式去重, 不要依赖 null 的持久性——运行时防护(本地优先/黑名单)不依赖 null。
- 模板 packages/gui/extra/personal-defaults/config.personal.json5 = curated 修正集(非全量冻结), 首次安装种入用户层(.personal-defaults-applied 标记防重复)。

## 运维脚本(packages/gui/scripts/)

- kernel-unit-tests.cjs: 内核自定义逻辑回归门禁, ds-core 改动提交前必跑。
- check-preset-leaks.mjs: 审计远程预设中未被抵消/未被 relay 覆盖的 true IP; 远程更新后跑。
- normalize-adaptive-config.mjs: 重装后清理旧式键与重复 targets 键(幂等)。

## 已知限制(接受, 不修)

- 官方内核 null socket 竞态(setServername): 触发源已在本机消除, 万一触发仅影响单请求且自动重试。
- GFW 对预设 IP 的分钟级间歇重置: 迟滞+宽池+重试缓解, 自愈, 不根除。
- 中继节点单点: google 系在 CN 依赖 8.137.102.117; 节点故障时 local-first 回退合并池降级直连。
- 中继节点单点的兜底链: 节点故障超宽限期后由中继守卫放行适配器(见上节分层降级), 不再单点裸奔。
- 地域资格判定(如 Google AI 模式)依赖隧道出口地域, 属节点侧属性, 配置层只能选隧道不能改出口。
- 语义类远程变更(如官方改坏 SNI 规则)无运行时信号, 靠审计脚本+人工反馈兜底。
