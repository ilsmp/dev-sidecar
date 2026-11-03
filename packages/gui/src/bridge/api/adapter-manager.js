/**
 * 兜底适配器管理器(二次开发新增)
 * 职责: conf 生成/校验、子进程启停、健康检查收养、状态与日志查询
 * 与官方 backend.js 完全解耦: 官方升级合并时本文件零冲突
 * 本地回环使用明文 http(仅 127.0.0.1 监听): 无证书, 从根上消除 UNABLE_TO_VERIFY_LEAF_SIGNATURE
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import crypto from 'node:crypto'
import http from 'node:http'
import { spawn } from 'node:child_process'
import log from '../../utils/util.log.gui.js'
import lodash from 'lodash'

/** mitmproxy 路径解析(与 backend.js 同源): bridge/api/../mitmproxy.js */
let _mitmproxyPath = null
function resolveMitmproxyPath () {
  if (_mitmproxyPath !== null) {
    return _mitmproxyPath
  }
  try {
    _mitmproxyPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../mitmproxy.js')
  } catch {
    _mitmproxyPath = ''
  }
  return _mitmproxyPath
}

// 路径惰性解析: ESM import 提升会先于 backend.js 的模块体执行,
// 而 DS_EXTRA_PATH 是 backend.js 在打包后设置的资源目录(resources/extra),
// 因此每次调用时再解析, 不能在模块加载期固化
function resolvePaths () {
  const base = process.env.DS_EXTRA_PATH
    || path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../extra')
  const dir = path.join(base, 'adapter')
  return {
    dir,
    serverJs: path.join(dir, 'server.cjs'),
    confJson: path.join(dir, 'conf.json'),
    pidFile: path.join(dir, 'adapter.pid'),
    logFile: path.join(dir, 'adapter.log'),
    outLog: path.join(dir, 'adapter.out.log'),
    errLog: path.join(dir, 'adapter.err.log'),
  }
}

const DEFAULT_CONF = {
  port: 8470,
  secret: '',
  password: '',
  upstream: 'http://127.0.0.1:7890',
  upstreamType: 'auto',
  directTimeoutMs: 1000,
  fallbackTimeoutMs: 25000,
  requestBudgetMs: 30000,
}
const UPSTREAM_TYPES = ['auto', 'http', 'socks']

// ---------- conf ----------
function loadConf (P) {
  try {
    return JSON.parse(fs.readFileSync(P.confJson, 'utf8'))
  } catch {
    return null
  }
}

function writeConf (P, conf) {
  fs.mkdirSync(P.dir, { recursive: true })
  fs.writeFileSync(P.confJson, `${JSON.stringify(conf, null, 2)}\n`)
}

function generateSecrets () {
  return {
    secret: crypto.randomBytes(6).toString('hex'),
    password: crypto.randomBytes(12).toString('hex'),
  }
}

function sanitizeConf (merged) {
  const conf = Object.assign({}, DEFAULT_CONF, merged || {})
  conf.port = Number.parseInt(conf.port, 10) || DEFAULT_CONF.port
  conf.directTimeoutMs = Number.parseInt(conf.directTimeoutMs, 10) || DEFAULT_CONF.directTimeoutMs
  conf.fallbackTimeoutMs = Number.parseInt(conf.fallbackTimeoutMs, 10) || DEFAULT_CONF.fallbackTimeoutMs
  conf.requestBudgetMs = Number.parseInt(conf.requestBudgetMs, 10) || DEFAULT_CONF.requestBudgetMs
  conf.upstreamType = UPSTREAM_TYPES.includes(conf.upstreamType) ? conf.upstreamType : 'auto'
  if (conf.port < 1024 || conf.port > 65535) {
    throw new Error('端口必须在 1024-65535 之间')
  }
  try {
    const u = new URL(conf.upstream)
    if (!['http:', 'https:', 'socks5:', 'socks4:'].includes(u.protocol)) {
      throw new Error('unsupported protocol')
    }
  } catch {
    throw new Error('upstream 必须是合法代理地址, 如 http://127.0.0.1:7890')
  }
  if (!Array.isArray(conf.directSkipHosts)) {
    conf.directSkipHosts = []
  }
  conf.directSkipHosts = conf.directSkipHosts
    .map(s => String(s).trim().toLowerCase())
    .filter(Boolean)
  if (!conf.secret || !conf.password) {
    Object.assign(conf, generateSecrets())
  }
  return conf
}

// ---------- 健康检查 ----------
function portOpen (port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port })
    const done = (v) => {
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

function healthz (port, secret, timeoutMs = 800) {
  return new Promise((resolve) => {
    let settled = false
    let req = null
    const done = (v) => {
      if (settled)
        return
      settled = true
      try {
        req.destroy()
      } catch {}
      resolve(v)
    }
    req = http.get(
      { host: '127.0.0.1', port, path: `/healthz?secret=${encodeURIComponent(secret)}`, timeout: timeoutMs },
      (res) => {
        let buf = ''
        res.on('data', (c) => {
          buf += c
        })
        res.on('end', () => {
          try {
            const j = JSON.parse(buf)
            done(!!(j && j.ok && j.secret === secret))
          } catch {
            done(false)
          }
        })
      },
    )
    req.once('timeout', () => done(false))
    req.once('error', () => done(false))
  })
}

function readPid (P) {
  try {
    const n = Number.parseInt(fs.readFileSync(P.pidFile, 'utf8').trim(), 10)
    return Number.isInteger(n) && n > 1 ? n : null
  } catch {
    return null
  }
}

function killPid (pid) {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {}
}

// ---------- 管理器 ----------
let child = null
let exiting = false

function isAlive () {
  return !!(child && child.pid && child.exitCode === null && !child.killed)
}

function spawnServer (P) {
  const out = fs.openSync(P.outLog, 'a')
  const err = fs.openSync(P.errLog, 'a')
  child = spawn(process.execPath, [P.serverJs], {
    cwd: P.dir,
    stdio: ['ignore', out, err],
    detached: false,
  })
  fs.writeFileSync(P.pidFile, `${String(child.pid)}\n`)
  child.once('exit', () => {
    try {
      if (Number.parseInt(fs.readFileSync(P.pidFile, 'utf8'), 10) === child.pid) {
        fs.unlinkSync(P.pidFile)
      }
    } catch {}
    child = null
  })
}

async function waitReady (conf, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await healthz(conf.port, conf.secret)) {
      return true
    }
    if (child && child.exitCode !== null) {
      return false
    }
    await new Promise(r => setTimeout(r, 300))
  }
  return false
}

const adapterApi = {
  /** 读取 conf, 不存在则用内置默认值生成(secret/password 自动生成) */
  confGet () {
    const P = resolvePaths()
    let conf = loadConf(P)
    if (!conf) {
      conf = sanitizeConf(null)
      writeConf(P, conf)
      return conf
    }
    // 兼容旧配置: 补齐缺失键但不覆盖已有值
    let dirty = false
    for (const k of Object.keys(DEFAULT_CONF)) {
      if (conf[k] === undefined) {
        conf[k] = DEFAULT_CONF[k]
        dirty = true
      }
    }
    if (!conf.secret || !conf.password) {
      Object.assign(conf, generateSecrets())
      dirty = true
    }
    if (dirty) {
      writeConf(P, conf)
    }
    return conf
  },

  /**
   * 合并保存, 校验端口/超时/域名列表
   * 全部字段热生效: 引擎 3 秒内自动重读 conf.json;
   * 仅当 port/secret/password 变化时(影响内核 overwall 注册快照), 额外做两件事:
   *   1. 自动把新值重新注册到 overwall.server(不需要再手动点接入)
   *   2. 内核代理正在运行时自动热重启(最多几秒中断), 让快照立即吸收新值
   * upstream/超时/域名列表的变化不需要重启任何东西。
   */
  async confSave (patch) {
    const cur = this.confGet()
    const P = resolvePaths()
    const conf = sanitizeConf(Object.assign({}, cur, patch || {}))
    const identityChanged = conf.port !== cur.port || conf.secret !== cur.secret || conf.password !== cur.password
    writeConf(P, conf)
    if (!identityChanged) {
      return conf
    }
    try {
      await this.integrateOverwall()
    } catch (e) {
      log.warn('[adapter] overwall 重新注册失败, 请手动点接入按钮:', e)
    }
    try {
      const { default: DevSidecar } = await import('@blue-frontier/dev-sidecar')
      if (DevSidecar.api.status.get().server?.enabled) {
        await DevSidecar.api.server.restart({ mitmproxyPath: resolveMitmproxyPath() })
        log.info('[adapter] 内核代理已热重启以同步 overwall 注册新值')
      }
    } catch (e) {
      log.warn('[adapter] 内核代理热重启失败(下次手动重启代理服务后生效):', e)
    }
    return conf
  },

  /** 状态: 进程存活 + 端口健康(含外部孤儿进程收养识别) */
  async status () {
    const P = resolvePaths()
    const conf = this.confGet()
    const alive = isAlive()
    const healthy = await healthz(conf.port, conf.secret)
    let adoptedPid = null
    if (!alive && healthy) {
      adoptedPid = readPid(P)
    }
    return {
      running: alive || healthy,
      listening: healthy,
      adopted: !alive && healthy,
      pid: alive ? child.pid : adoptedPid,
      conf,
    }
  },

  /** 启动: 端口被占时先做健康检查, 是本适配器则直接收养(幂等), 否则明确报错不假活 */
  async start () {
    const P = resolvePaths()
    if (exiting) {
      return { ok: false, msg: '应用正在退出' }
    }
    // GUI 重启后 child 引用丢失: 端口上有健康实例即视为已运行(幂等收养)
    {
      const conf0 = this.confGet()
      if (!isAlive() && (await healthz(conf0.port, conf0.secret))) {
        const pid = readPid(P)
        log.info(`[adapter] 发现健康的外部适配器实例, 幂等收养, pid=${pid || 'unknown'}`)
        return { ok: true, adopted: true, pid }
      }
    }
    if (isAlive()) {
      const conf = this.confGet()
      if (await healthz(conf.port, conf.secret)) {
        return { ok: true, already: true }
      }
      this.stop()
    }
    const conf = this.confGet()
    if (!fs.existsSync(P.serverJs)) {
      throw new Error(`适配器 server.cjs 不存在: ${P.serverJs}`)
    }
    // 外部已有进程占着端口: 健康检查通过则收养(孤儿进程), 否则明确报错
    if (await portOpen(conf.port)) {
      if (await healthz(conf.port, conf.secret)) {
        const pid = readPid(P)
        log.info(`[adapter] 收养已运行的外部适配器实例, pid=${pid || 'unknown'}`)
        return { ok: true, adopted: true, pid }
      }
      throw new Error(`端口 ${conf.port} 已被其他程序占用, 请换端口或结束该进程`)
    }
    spawnServer(P)
    const ready = await waitReady(conf)
    if (!ready) {
      return { ok: false, msg: '适配器启动后未通过健康检查, 请查看 adapter.err.log' }
    }
    return { ok: true, pid: child ? child.pid : null }
  },

  stop () {
    const P = resolvePaths()
    if (isAlive()) {
      try {
        child.kill()
      } catch {}
      child = null
    }
    // 兜底: 用 pidfile 清理孤儿进程
    const pid = readPid(P)
    if (pid) {
      killPid(pid)
      try {
        fs.unlinkSync(P.pidFile)
      } catch {}
    }
    return { ok: true }
  },

  async restart () {
    this.stop()
    await new Promise(r => setTimeout(r, 300))
    return this.start()
  },

  /** 读取引擎真实运行日志 adapter.log 尾部 */
  logs () {
    const P = resolvePaths()
    try {
      const stat = fs.statSync(P.logFile)
      const size = stat.size
      const buf = Buffer.alloc(Math.min(size, 64 * 1024))
      const fd = fs.openSync(P.logFile, 'r')
      fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length))
      fs.closeSync(fd)
      return buf.toString('utf8')
    } catch {
      return ''
    }
  },

  /** 应用退出时停掉自己拉起的子进程(没有 child 时绝不误杀 pidfile 进程) */
  shutdown () {
    exiting = true
    if (isAlive()) {
      try {
        child.kill()
      } catch {}
      child = null
    }
  },

  /**
   * 把适配器注册为内核 overwall 插件的自定义服务器(ID=1, 默认服务器):
   * domain 带 http:// 前缀 -> 内核透传 rOptions.protocol, 内核->适配器走明文回环 http,
   * 无 MITM 证书链, 从根上消除 UNABLE_TO_VERIFY_LEAF_SIGNATURE
   * 只写 plugin.overwall.server 一个键, 不动官方其他任何配置字段
   */
  async integrateOverwall () {
    const P = resolvePaths()
    const conf = this.confGet()
    if (!fs.existsSync(P.serverJs)) {
      throw new Error(`适配器 server.cjs 不存在: ${P.serverJs}`)
    }
    const { default: DevSidecar } = await import('@blue-frontier/dev-sidecar')
    const cfg = DevSidecar.api.config.get()
    const ow = lodash.get(cfg, 'plugin.overwall')
    if (!ow) {
      throw new Error('找不到 plugin.overwall 配置')
    }
    ow.server = ow.server || {}
    const key = 'http://127.0.0.1'
    ow.server[key] = {
      id: 1,
      type: 'path',
      port: conf.port,
      path: conf.secret,
      password: conf.password,
    }
    await DevSidecar.api.config.save(cfg)
    log.info(`[adapter] overwall 自定义服务器已注册: ${key}:${conf.port}/${conf.secret}`)
    try {
      if (DevSidecar.api.status.get().server?.enabled) {
        await DevSidecar.api.server.restart({ mitmproxyPath: resolveMitmproxyPath() })
        log.info('[adapter] overwall registered, server hot-restarted')
      }
    } catch (e) {
      log.warn('[adapter] overwall hot-restart failed (takes effect after manual server restart):', e)
    }
    return { ok: true, server: ow.server[key] }
  },
}

export default adapterApi
