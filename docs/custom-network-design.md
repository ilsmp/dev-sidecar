# 自定义网络层设计备忘(2026-11-19)

本仓库在官方 dev-sidecar 之上的自定义层与运维流程。改内核(ds-core)或模板前必读。

## 路径分层

1. **增强模式(overwall)路径**: targets=true 的域名 → 适配器(127.0.0.1:6666) → 直连优先 → 失败转阡陌星云(127.0.0.1:7890)。当前仅 chatgpt/openai/claude 系。
2. **地域自适应中继路径**: 直连出口探测(regionPolicy.probes, 30分钟缓存)为受限地域(CN)时, preSetIpListRelay 声明的家族(google 系)只用中继池 8.137.102.117; 非受限地域落回官方预设直连。
3. **默认直连路径**: 其余域名走官方预设池/真实 DNS + SNI 改写拦截规则。

## 预设 IP 选择顺序(base.js _lookupWithPreSetIpList)

relay 白名单(受限地域) → 持久化黑名单过滤 → IPv6 过滤(无 IPv6 机器) → 本地优先(用户层健康 IP) → 合并池(含远程新增) → 真实 DNS 兜底链。

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
- 地域资格判定(如 Google AI 模式)依赖隧道出口地域, 属节点侧属性, 配置层只能选隧道不能改出口。
- 语义类远程变更(如官方改坏 SNI 规则)无运行时信号, 靠审计脚本+人工反馈兜底。
