// 覆盖性审计: 证明用户层(模板)的 overwall 关键 false 不会被远程配置更新覆盖。
// 用法: node packages/gui/scripts/check-overwall-override.cjs
//
// 复刻 local-config-loader.getConfigFromFiles 的合并顺序(用户层先入、远程后入、
// 用户层最后再合并一次), 对模板做三种「远程未来更新」模拟:
//   1) 把同键改成 true        —— 同键用户层标量优先, 必须仍为 false
//   2) 新增精确主机 true       —— origin 快速匹配层先于正则, 靠模板精确 false 抵消
//   3) 新增通配 *.google.com true —— 合并后用户键在前, 正则层用户宽匹配先命中
// 同时断言适配器家族(chatgpt/openai/claude)不受影响, 仍为 true。
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '../../..')
const req = (name) => {
  try {
    return require(require.resolve(name, { paths: [root, path.join(root, 'vendor/ds-core'), path.join(root, 'packages/gui'), __dirname] }))
  } catch {
    return require(name)
  }
}
const lodash = req('lodash')
const JSON5 = req('json5')
const mergeApi = require(path.join(root, 'vendor/ds-core/core/src/merge.js'))

const templatePath = path.join(root, 'packages/gui/extra/personal-defaults/config.personal.json5')
const user = JSON5.parse(fs.readFileSync(templatePath, 'utf8'))
const liveRemote = path.join(process.env.HOME || '', '.dev-sidecar/remote_config.json5')
const remotePath = fs.existsSync(liveRemote) ? liveRemote : path.join(root, 'vendor/ds-core/core/src/config/remote_config.json5')
const remote = JSON5.parse(fs.readFileSync(remotePath, 'utf8'))

const K1 = '^(?!fonts).*(with)?google(apis|usercontent)?.com.*$'
const K2 = '^(aistudio|.*pa.clients6|apis|gemini|console.cloud|notebooklm|mail).google.com$'
const CRITICAL = ['www.google.com', 'www.google.com.hk', 'gemini.google.com', 'accounts.google.com']
const ADAPTER = ['chatgpt.com', 'openai.com', 'claude.ai']

// 个人远程配置本机不存在, 传 null 等价于空层
function build (remoteCfg, userCfg) {
  const merged = lodash.cloneDeep(userCfg)
  mergeApi.doMerge(merged, remoteCfg)
  mergeApi.doMerge(merged, {})
  mergeApi.doMerge(merged, remoteCfg)
  mergeApi.doMerge(merged, userCfg)
  mergeApi.deleteNullItems(merged)
  return merged
}

let failed = 0
const assert = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${msg}`)
  if (!cond) failed++
}
const targetsOf = m => m.plugin.overwall.targets

const cur = targetsOf(build(remote, user))
for (const k of [K1, K2, ...CRITICAL]) {
  assert(cur[k] === false, `当前远程下 ${k} = false`)
}
for (const k of ADAPTER) {
  assert(cur[k] === true, `当前远程下适配器家族 ${k} 仍为 true`)
}

const sameKey = lodash.cloneDeep(remote)
sameKey.plugin.overwall.targets[K1] = true
sameKey.plugin.overwall.targets[K2] = true
const m1 = targetsOf(build(sameKey, user))
assert(m1[K1] === false && m1[K2] === false, '远程把同键改成 true 时用户层 false 仍生效')

const exact = lodash.cloneDeep(remote)
for (const k of CRITICAL) exact.plugin.overwall.targets[k] = true
const m2 = targetsOf(build(exact, user))
for (const k of CRITICAL) {
  assert(m2[k] === false, `远程新增精确主机 ${k}=true 时被模板精确 false 抵消`)
}

const wildcard = lodash.cloneDeep(remote)
wildcard.plugin.overwall.targets['*.google.com'] = true
wildcard.plugin.overwall.targets['*google*.com'] = true
const m3 = targetsOf(build(wildcard, user))
for (const k of CRITICAL) {
  assert(m3[k] === false, `远程新增通配 true 时 ${k} 仍为 false(用户键在合并序中在前)`)
}

console.log(failed ? `FAILED: ${failed} 项` : 'OVERRIDE_AUDIT_PASSED')
process.exit(failed ? 1 : 0)
