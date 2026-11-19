// 出口地域漂移守卫: 地域敏感家族声明期望出口信号, 周期探测, 漂移即告警/自动切路径。
// v1 信号: Google 按出口地域重定向国家 TLD(香港出口 => www.google.com.hk)。
// 用法: node packages/gui/scripts/egress-region-guard.mjs [--apply]
//   默认仅告警(exit 1 便于 cron/自动化捕获); --apply 把 google 系 overwall
//   targets 切 true(经适配器/VPN 出口), 需重启应用生效。
import { createRequire } from 'node:module'
import http from 'node:http'
import tls from 'node:tls'
import fs from 'node:fs'
import path from 'node:path'
const require = createRequire(import.meta.url)
const PROXY = process.env.DS_PROXY || '127.0.0.1:31181'
const EXPECT_TLD = process.env.EXPECT_TLD || 'google.com.hk'
const apply = process.argv.includes('--apply')

function probeRedirectHost (url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const [host, port] = PROXY.split(':')
    const req = http.request({ host, port: Number(port), method: 'CONNECT', path: `${u.host}:443` })
    req.on('connect', (res, sock0) => {
      const sock = tls.connect({ socket: sock0 || res.socket, servername: u.hostname }, () => {
        sock.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nconnection: close\r\n\r\n`)
        let head = ''
        sock.on('data', (c) => {
          head += c.toString('latin1')
          const end = head.indexOf('\r\n\r\n')
          if (end !== -1) {
            sock.destroy()
            const m = head.slice(0, end).match(/^location:\s*https?:\/\/([^/]+)/im)
            resolve(m ? m[1] : null)
          }
        })
        sock.on('error', reject)
      })
      sock.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

const observed = await probeRedirectHost('https://www.google.com/')
console.log(`期望出口 TLD: ${EXPECT_TLD} | 实测重定向: ${observed || '(无重定向, 出口可能为美国或未识别)'}`)
if (observed === EXPECT_TLD) {
  console.log('OK: 出口地域与期望一致')
  process.exit(0)
}
console.log('DRIFT: 出口地域漂移! 地域敏感服务(如 AI 模式)可能报资格错误')
if (!apply) {
  console.log('提示: 加 --apply 可自动把 google 系切到适配器路径(需重启应用)')
  process.exit(1)
}
const cfgPath = path.join(process.env.HOME || '', '.dev-sidecar', 'config.json')
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
const t = cfg.plugin.overwall.targets
t['^(?!fonts).*(with)?google(apis|usercontent)?\\.com.*$'] = true
t['(*account*|scholar)\\.google\\.com'] = true
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
console.log('APPLIED: google 系 overwall targets 已切 true, 重启应用生效')
