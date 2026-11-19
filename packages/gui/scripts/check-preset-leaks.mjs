// 审计官方远程预设中「未被用户层抵消的 true IP」(合并后会进入轮换池)。
// 地域敏感家族(google 系)出现泄漏即出口漂移风险, 参照 2026-11-19 account 系事故。
// 用法: node packages/gui/scripts/check-preset-leaks.mjs [敏感家族正则]
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const jsonApi = require('@blue-frontier/mitmproxy/src/json.js')
const fs = require('node:fs')
const path = require('node:path')
const base = process.env.DEV_SIDECAR_USER_BASE || path.join(process.env.HOME || '', '.dev-sidecar')
const remote = jsonApi.parse(fs.readFileSync(path.join(base, 'remote_config.json5'), 'utf8')) || {}
const user = JSON.parse(fs.readFileSync(path.join(base, 'config.json'), 'utf8')) || {}
const rp = (remote.server && remote.server.preSetIpList) || {}
const up = (user.server && user.server.preSetIpList) || {}
// 地域自适应中继池(白名单)覆盖的键: 受限地域走中继、非受限地域用官方预设
// 均属预期, 不计为泄漏
const relay = (user.server && user.server.preSetIpListRelay) || {}
const sensitive = new RegExp(process.argv[2] || 'google|gstatic|ggpht|ytimg|youtube|youtu\\.be|googleusercontent|googleapis|account', 'i')
let sensitiveLeaks = 0
let infoLeaks = 0
for (const [key, ips] of Object.entries(rp)) {
  // 整键 null = 用户层删除该远程键(结构性封堵), 视为全部抵消
  if (up[key] === null) continue
  if (relay[key]) continue
  const uv = up[key] || {}
  const leaked = Object.entries(ips || {}).filter(([ip, on]) => on === true && uv[ip] !== false && uv[ip] !== null).map(([ip]) => ip)
  if (!leaked.length) continue
  if (sensitive.test(key)) {
    sensitiveLeaks++
    console.log(`[地域敏感-需处理] ${key} => ${leaked.join(', ')}`)
  } else {
    infoLeaks++
    console.log(`[信息-官方直连预设] ${key} => ${leaked.join(', ')}`)
  }
}
console.log(sensitiveLeaks ? `发现 ${sensitiveLeaks} 个地域敏感预设键存在未抵消 true IP` : '地域敏感家族无泄漏: 远程 true IP 均被用户层 false/null 抵消')
console.log(`另有 ${infoLeaks} 个非敏感键沿用官方直连预设(预期行为)`)
