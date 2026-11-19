// 重装含地域自适应内核(>= ds-core 6c53d8d)的包之后运行一次:
//   node packages/gui/scripts/normalize-adaptive-config.mjs
// 清理历史遗留: 1) preSetIpList 里与 preSetIpListRelay 同名的旧式中继键
// (旧内核时期的过渡配置, 新内核下会导致非受限地域中继与官方 IP 混池);
// 2) overwall targets 里未转义/转义重复的 account/scholar 键。幂等, 可重复运行。
import fs from 'node:fs'
import path from 'node:path'
const p = path.join(process.env.HOME || '', '.dev-sidecar', 'config.json')
const cfg = JSON.parse(fs.readFileSync(p, 'utf8'))
const pl = (cfg.server && cfg.server.preSetIpList) || {}
const relay = (cfg.server && cfg.server.preSetIpListRelay) || {}
const t = (cfg.plugin && cfg.plugin.overwall && cfg.plugin.overwall.targets) || {}
let removed = 0
for (const k of Object.keys(pl)) {
  if (relay[k]) {
    delete pl[k]
    removed++
    console.log('removed legacy preSetIpList key:', k)
  }
}
const dupPairs = [['(*account*|scholar).google.com', '(*account*|scholar)\\.google\\.com'], ['scholar.googleusercontent.com', 'scholar\\.googleusercontent\\.com']]
for (const [plain, escaped] of dupPairs) {
  if (plain in t && escaped in t) {
    delete t[plain]
    removed++
    console.log('removed duplicate targets key:', plain)
  }
}
if (removed) {
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2))
  console.log(`done, removed ${removed} entries; 重启应用生效`)
} else {
  console.log('nothing to normalize')
}
