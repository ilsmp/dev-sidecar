#!/usr/bin/env node
'use strict';
// 预设IP直连 + spawn 环境修复 自动化验证
// 用法: node scripts/adapter-preset-test.mjs   (仓库根目录执行)
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import net from 'node:net'

let fail = 0
function check (name, cond, extra) {
  if (cond) { console.log('PASS', name) } else { console.log('FAIL', name, extra || ''); fail = 1 }
}

// ---- 1) 从 server.cjs 源码提取 compilePreset/presetResolve/REGEX_META/isBlocked 做单元断言 ----
const src = fs.readFileSync('packages/gui/extra/adapter/server.cjs', 'utf8')
function grab (name) {
  const start = src.indexOf('function ' + name)
  if (start < 0) throw new Error('missing fn ' + name)
  let depth = 0; let i = src.indexOf('{', start)
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1) }
  }
  throw new Error('unbalanced ' + name)
}
const metaLine = (src.match(/const REGEX_META = .*\n/) || [''])[0]
const body = [
  'const CONF = { preSetHosts: {',
  "  '^(aistudio|apis|gemini).google.com$': { '8.137.102.117': true, '142.251.189.206': false },",
  "  '*.youtube.com': { '8.137.102.117': true },",
  "  'miyun.io': { '104.21.74.96': true },",
  "  'bad-key': { 'not-an-ip': true },",
  "  'empty': {},",
  '  }, }',
  'let PRESET_RULES = []',
  metaLine,
  grab('compilePreset'),
  grab('presetResolve'),
  'const blockedIps = new Map()',
  grab('isBlocked'),
  'compilePreset()',
  'return { presetResolve, isBlocked, PRESET_RULES }',
].join('\n')
const sandbox = new Function('log', body)
const { presetResolve, PRESET_RULES } = sandbox(() => {})

check('rules compiled (empty/bad-ip dropped)', PRESET_RULES.length === 3, 'got ' + PRESET_RULES.length)
check('regex key hit', JSON.stringify(presetResolve('aistudio.google.com')) === JSON.stringify(['8.137.102.117']), JSON.stringify(presetResolve('aistudio.google.com')))
check('regex false-ip excluded', !presetResolve('apis.google.com').includes('142.251.189.206'))
check('wildcard single-segment hit', presetResolve('www.youtube.com').length === 1)
check('wildcard does not cross dots', presetResolve('a.b.youtube.com') === null, JSON.stringify(presetResolve('a.b.youtube.com')))
check('literal hit', presetResolve('miyun.io').length === 1)
check('literal miss', presetResolve('xmiyun.io') === null)
check('case-insensitive', presetResolve('WWW.YOUTUBE.COM').length === 1)
check('no match returns null', presetResolve('example.com') === null)

// ---- 2) resolveHost 优先级: 预设命中不调 DoH; 预设全拉黑降级 DoH ----
{
  const isBlockedSrc = grab('isBlocked')
  const resolveBody = [
    'const PRESET_RULES = [{ re: /google/ , ips: ["1.2.3.4"] }]',
    grab('presetResolve'),
    'const blockedIps = new Map()',
    isBlockedSrc,
    grab('resolveHost'),
    'return resolveHost',
  ].join('\n')
  const resolveHost = new Function('dohResolve', resolveBody)(async () => ['9.9.9.9'])
  const a = await resolveHost('google.com')
  check('preset priority over doh', JSON.stringify(a) === JSON.stringify(['1.2.3.4']), JSON.stringify(a))
  const body2 = [
    'const PRESET_RULES = [{ re: /google/ , ips: ["1.2.3.4"] }]',
    grab('presetResolve'),
    'const blockedIps = new Map([["google.com|1.2.3.4", Date.now()]])',
    isBlockedSrc,
    grab('resolveHost'),
    'return resolveHost',
  ].join('\n')
  const resolveHost3 = new Function('dohResolve', body2)(async () => ['9.9.9.9'])
  const b = await resolveHost3('google.com')
  check('all-preset-blocked falls back to doh', JSON.stringify(b) === JSON.stringify(['9.9.9.9']), JSON.stringify(b))
}

// ---- 3) adapter-manager: spawnServer 带 ELECTRON_RUN_AS_NODE=1 且 conf 链路含 preSetHosts ----
{
  const mgrSrc = fs.readFileSync('packages/gui/src/bridge/api/adapter-manager.js', 'utf8')
  check('manager env ELECTRON_RUN_AS_NODE', /ELECTRON_RUN_AS_NODE:\s*'1'/.test(mgrSrc))
  check('manager DEFAULT_CONF preSetHosts', /preSetHosts: \{\}/.test(mgrSrc))
  check('manager sanitize keeps preSetHosts', /conf\.preSetHosts = \{\}/.test(mgrSrc))
  check('manager syncs user config', /syncPresetFromUserConfig/.test(mgrSrc) && /server\.preSetIpList/.test(mgrSrc))
  check('server applyConf reads preSetHosts', /CONF\.preSetHosts = /.test(src))
  check('server hot-reload compiles preset', /compilePreset\(\)/.test(src))
}

// ---- 4) 真实 Electron 二进制 + ELECTRON_RUN_AS_NODE=1 跑通 server.cjs(如已安装应用存在) ----
{
  const electronBin = '/Applications/dev-sidecar.app/Contents/MacOS/dev-sidecar'
  if (fs.existsSync(electronBin)) {
    const work = fs.mkdtempSync('/tmp/ds-preset-test-')
    const confP = path.join(work, 'conf.json')
    const srvSrc = path.resolve('packages/gui/extra/adapter/server.cjs')
    fs.writeFileSync(confP, JSON.stringify({ port: 18479, secret: 'test000000', password: 'testpassword000000', upstream: 'http://127.0.0.1:7890', preSetHosts: { 'example.com': { '93.184.216.34': true } } }))
    const child = spawn(electronBin, [srvSrc], {
      cwd: work,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ADAPTER_CONF: confP, ADAPTER_PID: path.join(work, 'a.pid'), ADAPTER_LOG: path.join(work, 'a.log') },
      stdio: 'ignore',
    })
    const ok = await new Promise((resolve) => {
      const t0 = Date.now()
      const tick = () => {
        const s = net.connect({ host: '127.0.0.1', port: 18479, timeout: 400 })
        s.on('connect', () => { s.destroy(); resolve(true) })
        s.on('error', () => { if (Date.now() - t0 > 8000 || child.exitCode !== null) resolve(false); else setTimeout(tick, 300) })
        s.on('timeout', () => { s.destroy(); if (Date.now() - t0 > 8000 || child.exitCode !== null) resolve(false); else setTimeout(tick, 300) })
      }
      tick()
    })
    try { child.kill() } catch {}
    check('electron-as-node serves adapter', ok)
    fs.rmSync(work, { recursive: true, force: true })
  } else {
    console.log('SKIP electron-as-node (app not installed)')
  }
}

process.exit(fail)

