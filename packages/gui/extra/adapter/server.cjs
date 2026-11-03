#!/usr/bin/env node
/**
 * DevSidecar 二层代理适配器：DoH 直连优先 + 兜底上游(可配置/热更新) + 重试
 * 协议: http://127.0.0.1:{port}/{secret}/{真实域名}[:port]{原始path} + header dspassword
 */
'use strict';
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// 路径可用环境变量覆盖(多实例/冒烟测试全隔离, 不触碰真实配置)
const CONF_PATH = process.env.ADAPTER_CONF || path.join(__dirname, 'conf.json');
const PID_PATH = process.env.ADAPTER_PID || path.join(__dirname, 'adapter.pid');
const LOG_PATH = process.env.ADAPTER_LOG || path.join(__dirname, 'adapter.log');
const CONF = {};
let UP = new URL('http://127.0.0.1:7890');
function applyConf(next) {
  CONF.port = Number(next.port) || 8470;
  CONF.secret = String(next.secret || '');
  CONF.password = String(next.password || '');
  CONF.upstream = String(next.upstream || 'http://127.0.0.1:7890');
  CONF.upstreamType = String(next.upstreamType || 'auto');
  CONF.directTimeoutMs = Number(next.directTimeoutMs) || 1000;
  CONF.fallbackTimeoutMs = Number(next.fallbackTimeoutMs) || 25000;
  CONF.requestBudgetMs = Number(next.requestBudgetMs) || 30000;
  const arr = Array.isArray(next.directSkipHosts) ? next.directSkipHosts : [];
  CONF.directSkipHosts = arr.map((s) => String(s).toLowerCase()).filter(Boolean);
  UP = new URL(CONF.upstream);
  directSkipHosts = new Set(CONF.directSkipHosts);
}

const MAX_BODY = 64 * 1024 * 1024;
// 指定域名强制走兜底(不走直连): conf.json directSkipHosts 数组, 后缀匹配, 改配置约3秒热生效
let directSkipHosts = new Set();
function hostSkipsDirect(h) {
  h = String(h || '').toLowerCase();
  if (!h) return false;
  if (directSkipHosts.has(h)) return true;
  for (const s of directSkipHosts) { if (s.startsWith('.') && (h.endsWith(s) || h === s.slice(1))) return true; }
  return false;
}

let logStream = null;
function log() {
  const args = Array.prototype.slice.call(arguments);
  const line = '[' + new Date().toISOString() + '] ' + args.map((a) => (a instanceof Error ? a.message + (a.code ? '/' + a.code : '') : String(a))).join(' ') + '\n';
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 5 * 1024 * 1024) {
      const fd = fs.openSync(LOG_PATH, 'r');
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(size - 2 * 1024 * 1024);
      fs.readSync(fd, buf, 0, buf.length, 2 * 1024 * 1024);
      fs.closeSync(fd);
      fs.writeFileSync(LOG_PATH, buf);
      if (logStream) { try { logStream.destroy(); } catch (e) {} logStream = null; }
    }
    if (!logStream || logStream.destroyed) logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
    logStream.write(line);
  } catch (e) {}
}

process.on('uncaughtException', (e) => log('uncaughtException', e));
process.on('unhandledRejection', (e) => log('unhandledRejection', e));

// ---------- conf.json 热更新（改上游端口/超时/密钥后约3秒生效） ----------
let confMtime = 0;
try { confMtime = fs.statSync(CONF_PATH).mtimeMs; } catch (e) {}

// 端口热切换: 必须等 close 回调完成再 listen, 否则旧 keep-alive 连接未断时新 listen 会
// EADDRINUSE/监听过期端口; pendingPort 保证关闭等待期间端口再次变更时始终用最新值
let portClosing = false;
let pendingPort = null;
function listenOn(port) {
  server.listen(port, '127.0.0.1', () => log('listening (http)', '127.0.0.1:' + port));
}
function restartListen(newPort) {
  pendingPort = newPort;
  if (portClosing) return;
  if (server.listening) {
    portClosing = true;
    if (typeof server.closeAllConnections === 'function') { try { server.closeAllConnections(); } catch (e) {} }
    server.close(() => {
      portClosing = false;
      const target = pendingPort; pendingPort = null;
      if (target !== null) listenOn(target);
    });
  } else {
    const target = pendingPort; pendingPort = null;
    listenOn(target);
  }
}
setInterval(() => {
  try {
    const st = fs.statSync(CONF_PATH);
    if (st.mtimeMs === confMtime) return;
    confMtime = st.mtimeMs;
    const next = JSON.parse(fs.readFileSync(CONF_PATH, 'utf8'));
    const oldPort = Number(CONF.port || 8470);
    applyConf(next);
    modeCache = null;
    log('CONFIG-RELOADED', 'upstream=' + UP.href, 'directTimeoutMs=' + CONF.directTimeoutMs, 'port=' + CONF.port, 'directSkipHosts=' + directSkipHosts.size);
    const newPort = Number(CONF.port || 8470);
    if (oldPort !== newPort) restartListen(newPort);
  } catch (e) { log('config reload error', e); }
}, 3000);

// ---------- 缓存清扫(10分钟一次, 防止长驻进程内存膨胀) ----------
const dnsCache = new Map();
const cleanDnsCache = new Map();
const blockedIps = new Map();
const directFails = new Map();
const directSkip = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of dnsCache) { if (now - v.ts > 600000) dnsCache.delete(k); }
  for (const [k, v] of cleanDnsCache) { if (now - v.ts > 600000) cleanDnsCache.delete(k); }
  for (const [k, v] of blockedIps) { if (now - v.ts > 600000) blockedIps.delete(k); }
  for (const [k, v] of directSkip) { if (now > v) directSkip.delete(k); }
  for (const [k, v] of directFails) { if (now - v.ts > 600000) directFails.delete(k); }
}, 600000);

// ---------- DoH 解析(阿里公共 DNS, IP 直连避免系统 DNS 污染) ----------
function blockIp(host, ip, reason) {
  if (!ip) return;
  blockedIps.set(host + '|' + ip, Date.now());
}
function isBlocked(host, ip) {
  const ts = blockedIps.get(host + '|' + ip);
  if (ts === undefined) return false;
  if (Date.now() - ts > 600000) { blockedIps.delete(host + '|' + ip); return false; }
  return true;
}
function dohResolve(hostname) {
  return new Promise((resolve) => {
    const hit = dnsCache.get(hostname);
    if (hit && Date.now() - hit.ts < 300000) return resolve(hit.ips);
    const req = https.request(
      {
        // IP直连公共DoH: 不依赖系统DNS(TUN僵尸198.18.0.1残留时getaddrinfo全挂)
        host: '223.5.5.5',
        servername: 'dns.alidns.com',
        headers: { host: 'dns.alidns.com' },
        path: '/resolve?name=' + encodeURIComponent(hostname) + '&type=A',
        method: 'GET',
        timeout: 4000,
        maxHeaderSize: 65536,
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let ips = [];
          try {
            const j = JSON.parse(buf);
            ips = (j.Answer || []).filter((a) => a.type === 1 && /^[0-9.]+$/.test(a.data)).map((a) => a.data);
          } catch (e) {}
          if (ips.length) { dnsCache.set(hostname, { ips, ts: Date.now() }); } else { dnsCache.set(hostname, { ips, ts: Date.now() - 285000 }); }  // 空=15s 短缓存
          resolve(ips);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('doh timeout')));
    req.on('error', () => resolve([]));
    req.end();
  });
}

// ---------- 通过兜底上游 HTTP CONNECT 建立到目标的 TLS 隧道 ----------
// ---------- 隧道内干净 DoH: 经兜底隧道连 1.1.1.1(IP直连,VPN无需解析域名) ----------
// 背景: VPN 本地分流对部分域名(如 ws.chatgpt.com)会解析到污染IP再经节点连死地址;
// 适配器自己解析干净IP后按 IP CONNECT,SNI/Host 保留原域名,对 VPN 零改动
function cleanResolve(hostname) {
  return new Promise(async (resolve) => {
    try {
      const hit = cleanDnsCache.get(hostname);
      if (hit && Date.now() - hit.ts < 300000) return resolve(hit.ips);
      const tlsSock = await rawTunnel('1.1.1.1', '1.1.1.1', 443);
      const req = http.request({
        hostname: '1.1.1.1',
        method: 'GET',
        path: '/dns-query?name=' + encodeURIComponent(hostname) + '&type=A',
        headers: { host: '1.1.1.1', accept: 'application/dns-json' },
        createConnection: (_o, cb) => cb(null, tlsSock),
        timeout: 5000,
      }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let ips = [];
          try {
            const j = JSON.parse(buf);
            ips = (j.Answer || []).filter((a) => a.type === 1).map((a) => a.data);
          } catch (e) {}
          if (ips.length) { cleanDnsCache.set(hostname, { ips, ts: Date.now() }); } else { cleanDnsCache.set(hostname, { ips, ts: Date.now() - 285000 }); }  // 空=15s 短缓存
          resolve(ips);
        });
      });
      req.on('timeout', () => req.destroy(new Error('clean doh timeout')));
      req.on('error', () => { cleanDnsCache.set(hostname, { ips: [], ts: Date.now() - 285000 }); resolve([]); });  // 失败只缓存15s
      req.end();
    } catch (e) {
      cleanDnsCache.set(hostname, { ips: [], ts: Date.now() - 285000 });  // 失败只缓存15s
      resolve([]);
    }
  });
}

// 兜底隧道: 先干净解析,再按真实 IP CONNECT(解析失败退回域名),SNI 保留原域名
async function tunnelConnect(targetHost, targetPort, opts) {
  let connectHost = targetHost;
  try {
    const ips = await cleanResolve(targetHost);
    if (ips && ips.length) connectHost = ips[0];
  } catch (e) {}
  return rawTunnel(connectHost, targetHost, targetPort, opts);
}

// ---------- 上游隧道: 协议自动探测(http CONNECT / socks5), 首选结果缓存 ----------
let modeCache = null; // { mode: 'http'|'socks' }

function httpConnect(connectHost, targetPort) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(UP.port) || 7890, UP.hostname);
    const to = setTimeout(() => {
      sock.destroy();
      reject(new Error('tunnel timeout'));
    }, 8000);
    sock.once('error', (e) => {
      clearTimeout(to);
      reject(e);
    });
    sock.once('connect', () => {
      sock.setKeepAlive(true, 30000);
      sock.write('CONNECT ' + connectHost + ':' + targetPort + ' HTTP/1.1\r\nHost: ' + connectHost + ':' + targetPort + '\r\n\r\n');
    });
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = buf.slice(0, idx).toString('latin1');
      sock.removeListener('data', onData);
      clearTimeout(to);
      if (!/^HTTP\/1\.[01] 200/.test(head)) {
        sock.destroy();
        return reject(new Error('tunnel refused: ' + head.split('\r\n')[0]));
      }
      const rest = buf.slice(idx + 4);
      if (rest.length) sock.unshift(rest);
      resolve(sock);
    };
    sock.on('data', onData);
  });
}

function replyLen(buf) {
  // SOCKS5 reply 总长: 4 头 + addr(按 atyp) + 2 端口
  if (buf.length < 5) return -1;
  const atyp = buf[3];
  if (atyp === 0x01) return 4 + 4 + 2;
  if (atyp === 0x04) return 4 + 16 + 2;
  if (atyp === 0x03) return 4 + 1 + buf[4] + 2;
  return -1;
}

async function socksConnect(connectHost, targetPort) {
  // SOCKS5 + 裸IP目标: 部分内核(mihomo系)对裸IP不按域名分流,TLS 握手会拿到错误出口;
  // 仅 socks 分支做 IP->域名(反解)转换,不影响 http 主路径;不可反解则保持原IP
  if (net.isIP(connectHost) && !connectHost.startsWith('127.') && !connectHost.startsWith('0.')) {
    try {
      const doms = await Promise.race([
        require('node:dns').promises.reverse(connectHost),
        new Promise((resolve) => setTimeout(() => resolve([]), 800)),
      ]);
      if (doms && doms.length) { log('socks ip->domain: ' + connectHost + ' -> ' + doms[0]); connectHost = doms[0]; }
    } catch (e) {}
  }
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(UP.port) || 7890, UP.hostname);
    const to = setTimeout(() => {
      sock.destroy();
      reject(new Error('tunnel timeout'));
    }, 8000);
    const fail = (e) => {
      clearTimeout(to);
      sock.destroy();
      reject(e);
    };
    sock.once('error', fail);
    const handler = (d) => {
      buf = Buffer.concat([buf, d]);
      if (phase === 'greeting') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail(new Error('socks greeting rejected: 0x' + buf[1].toString(16)));
        phase = 'request';
        buf = Buffer.alloc(0);
        const hostBuf = Buffer.from(connectHost, 'latin1');
        const req = Buffer.alloc(5 + 1 + hostBuf.length + 2);
        req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03; req[4] = hostBuf.length;
        hostBuf.copy(req, 5);
        req.writeUInt16BE(Number(targetPort) & 0xffff, 5 + hostBuf.length);
        sock.write(req);
      } else {
        if (buf.length < 5) return;
        const blen = replyLen(buf);
        if (blen < 0 || buf.length < blen) return;
        sock.removeListener('data', handler);
        sock.removeListener('error', fail);
        if (buf[1] !== 0x00) return fail(new Error('socks connect refused: 0x' + buf[1].toString(16)));
        clearTimeout(to);
        const rest = buf.slice(blen);
        if (rest.length) sock.unshift(rest);
        resolve(sock);
      }
    };
    let phase = 'greeting';
    sock.once('connect', () => {
      sock.setKeepAlive(true, 30000);
      // RFC1928: greeting, 无认证
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    sock.on('data', handler);
  });
}

function tlsOver(sock, sniHost, opts) {
  return new Promise((resolve, reject) => {
    const tlsOpts = { socket: sock, host: sniHost, servername: net.isIP(sniHost) ? undefined : sniHost };
    // WS upgrade 场景不声明 ALPN: 部分站点(如 ws.chatgpt.com/CF)对 http/1.1 ALPN 通道上的 Upgrade 直接断连,
    // 不带 ALPN 与 TUN 透明 TCP 转发行为一致
    if (!(opts && opts.noAlpn)) tlsOpts.ALPNProtocols = ['http/1.1'];
    const tlsSock = tls.connect(tlsOpts, () => { clearTimeout(tlsTo); resolve(tlsSock); });
    // TLS 握手硬超时: 节点假死(CONNECT 200 但无数据)时不能无限挂起
    const tlsTo = setTimeout(() => { tlsSock.destroy(new Error('tunnel tls handshake timeout')); }, 8000);
    tlsSock.once('error', (e) => { clearTimeout(tlsTo); reject(e); });
  });
}

async function rawTunnel(connectHost, sniHost, targetPort, opts) {
  const wantType = CONF.upstreamType || 'auto';
  const preferred = wantType === 'auto' && modeCache ? modeCache.mode : wantType;
  const order = preferred === 'socks' ? ['socks', 'http'] : ['http', 'socks'];
  let lastErr = null;
  for (const mode of order) {
    if (wantType !== 'auto' && mode !== wantType) continue;
    try {
      const sock = mode === 'http' ? await httpConnect(connectHost, targetPort) : await socksConnect(connectHost, targetPort);
      const tlsSock = await tlsOver(sock, sniHost, opts);
      if (wantType === 'auto' && (!modeCache || modeCache.mode !== mode)) {
        modeCache = { mode };
        log('upstream mode detected: ' + mode);
      }
      return tlsSock;
    } catch (e) {
      lastErr = e;
      log('upstream ' + mode + ' failed: ' + (e && e.message ? e.message : e));
    }
  }
  throw lastErr || new Error('all upstream modes failed');
}

// ---------- 在给定连接方式上发一个 https 请求，返回响应 ----------
function httpsOver(connectFn, targetHost, targetPort, method, reqPath, headers, bodyBuf, timeoutMs) {
  return new Promise((resolve, reject) => {
    // 注意: 必须用 http.request —— https.request 会忽略 createConnection 自己直连目标
    // (TUN 开时穿 TUN 耗套餐, TUN 关时被墙), 而我们的 connectFn 返回的是已 TLS 的 socket,
    // 明文 HTTP 应走在这个 TLS 流上
    const req = http.request(
      {
        hostname: targetHost,
        port: targetPort,
        method,
        path: reqPath,
        headers,
        // 注意: 不能设 agent:false —— 那会忽略 createConnection 改为自行 net.connect(系统DNS会被污染)
        createConnection: connectFn,
        timeout: timeoutMs || CONF.directTimeoutMs,
        maxHeaderSize: 65536,
      },
      (res) => { clearTimeout(hardTo); req.setTimeout(0); resolve(res); }
    );
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', (e) => { clearTimeout(hardTo); reject(e); });
    // 硬超时: 空闲超时事件不覆盖所有挂起场景(建连/TLS阶段),必须兜底
    const hardTo = setTimeout(() => req.destroy(new Error('hard timeout')), (timeoutMs || CONF.fallbackTimeoutMs) + 2000);
    if (bodyBuf && bodyBuf.length) req.write(bodyBuf);
    req.end();
  });
}

function directConnect(ip, targetHost, targetPort) {
  return (opts, cb) => {
    const s = tls.connect({ host: ip || targetHost, port: targetPort, servername: targetHost, ALPNProtocols: ['http/1.1'] }, () => cb(null, s));
    s.once('error', cb);
    s.setTimeout(CONF.directTimeoutMs, () => s.destroy(new Error('direct connect timeout')));
  };
}

function socketConnect(sock) {
  return (_opts, cb) => cb(null, sock);
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function relayResponse(upRes, res) {
  const h = {};
  for (const [k, v] of Object.entries(upRes.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) h[k] = v;
  }
  // SSE关键修复: 每条事件流独占连接, 防止keep-alive隧道被长流占用后同隧道请求饿死/EPIPE
  const isSSE = /text\/event-stream/i.test(upRes.headers['content-type'] || '');
  if (isSSE) {
    h['connection'] = 'close';
    delete h['content-length'];
  }
  let relayDone = false;
  res.on('close', () => { if (!relayDone && !upRes.complete) upRes.destroy(); });
  res.writeHead(upRes.statusCode, upRes.statusMessage || '', h);
  upRes.pipe(res);
  upRes.on('error', () => res.destroy());
  upRes.on('close', () => { relayDone = true; });
}

// 回环/内网目标判定: 这些地址永远不该被转发到兜底节点
function isLocalHost(h) {
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  const ip = h.replace(/^\[|\]$/g, '');
  if (!net.isIP(ip)) return false;
  if (ip === '::1' || ip === '0.0.0.0') return true;
  if (net.isIPv4(ip)) {
    return ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.') ||
      ip.startsWith('169.254.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  }
  const low = ip.toLowerCase();
  return /^f[cd][0-9a-f]{2}:/.test(low) || /^fe[89ab]/.test(low);
}

try {
  applyConf(JSON.parse(fs.readFileSync(CONF_PATH, 'utf8')));
} catch (e) {
  console.error('[adapter] FATAL conf.json unreadable:', e.message);
  process.exit(1);
}

function timingSafeEq(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// 明文 http(仅 127.0.0.1): 本地回环无证书, 从根上消除 UNABLE_TO_VERIFY_LEAF_SIGNATURE
const server = http.createServer(async (req, res) => {
  // 健康检查(管理器收养/启动探测用)
  if (req.url === '/healthz' || req.url.startsWith('/healthz?')) {
    const q = new URL(req.url, 'http://127.0.0.1').searchParams.get('secret');
    if (CONF.secret && q === CONF.secret) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, secret: CONF.secret, pid: process.pid }));
    }
    res.writeHead(403);
    return res.end('forbidden');
  }
  const m = /^\/([^/]+)\/([^/:]+)(?::([0-9]+))?(\/.*)?$/.exec(req.url);
  if (!m) { log('REJECT-nopath', req.url.slice(0, 120)); return res.writeHead(404).end('not found'); }
  if (m[1] !== CONF.secret || !timingSafeEq(req.headers.dspassword, CONF.password)) { log('REJECT-auth', req.url.slice(0, 60)); return res.writeHead(403).end('forbidden'); }
  const host = m[2];
  const port = m[3] ? Number(m[3]) : 443;
  const reqPath = m[4] || '/';
  const headers = Object.assign({}, req.headers);
  delete headers.dspassword;
  delete headers['proxy-connection'];
  delete headers['proxy-expect'];
  if (isLocalHost(host)) { log('LOOPBACK-BLOCK', host + ':' + port, reqPath.slice(0, 60)); return res.writeHead(403).end('proxy-suite: loopback rejected'); }
  headers.host = port === 443 ? host : host + ':' + port;

  let bodyBuf = null;
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE') {
    const chunks = [];
    let size = 0;
    try {
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY) return res.writeHead(413).end('body too large');
        chunks.push(c);
      }
    } catch (e) {
      return res.writeHead(400).end('bad body');
    }
    bodyBuf = Buffer.concat(chunks);
    headers['content-length'] = String(size);
  }

  const t0 = Date.now();
    const directSkipUntil = directSkip.get(host);
  const directAlive = !(directSkipUntil && Date.now() < directSkipUntil);
  let directErr = null;
  if (directAlive && hostSkipsDirect(host)) {
    directErr = new Error('direct skipped (config directSkipHosts)');
    log('DIRECT-SKIP-CONFIG', host, '命中 directSkipHosts -> 直接走兜底');
  } else if (directAlive) {
    const ips = await dohResolve(host);
    const candidates = ips.length ? ips.filter((ip) => !isBlocked(host, ip)).slice(0, 2) : [null];
    let directBlocked = false; // 直连返回了地区封锁类状态码(403/451), 需要兜底节点出口重试
    for (const ip of candidates) {
      try {
        const upRes = await httpsOver(directConnect(ip, host, port), host, port, req.method, reqPath, headers, bodyBuf, CONF.directTimeoutMs);
        log('DIRECT', host + reqPath.slice(0, 60), upRes.statusCode, Date.now() - t0 + 'ms');
        // 403/451 = 直连 IP 出口触发了目标站地区/风控拦截, 该响应不可信, 必须换兜底节点出口重试
        if (upRes.statusCode === 403 || upRes.statusCode === 451) {
          directBlocked = true;
          directErr = new Error('direct status ' + upRes.statusCode + ' (region/risk blocked)');
          try { upRes.destroy(); } catch (e) {}
          continue;
        }
        directFails.delete(host);
        return relayResponse(upRes, res);
      } catch (e) {
        directErr = e;
        if (ip && /certificate|altnames|Hostname\/IP/i.test(e && e.message)) blockIp(host, ip, 'cert-mismatch');
        if (ip && /connect timeout|hard timeout|request timeout|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(e && e.message)) blockIp(host, ip, 'dead-ip');
      }
    }
    if (directErr) {
      const cur = directFails.get(host) || { n: 0, ts: 0 };
      cur.n += 1; cur.ts = Date.now();
      directFails.set(host, cur);
      if (cur.n >= 3) {
        directSkip.set(host, Date.now() + 600000);
        directFails.delete(host);
        log('DIRECT-SKIP', host, '连续直连失败 -> 10分钟内直接走兜底');
      }
    }
  } else {
    directErr = new Error('direct skipped (recent failures)');
  }
  // 兜底重试（最多2次，每次新建隧道）：GFW 注入/连接抖动时第二次通常成功
  let lastErr = null;
  // 客户端断开时标记中止,避免僵尸上游请求
  let clientGone = false;
  res.on('close', () => { clientGone = true; });
  // 全请求预算: 直连耗掉太多时兜底只试一次, 且每次兜底超时不超过剩余预算, 保证在 DevSidecar 40s 之前返回
  const maxAttempts = (CONF.requestBudgetMs - (Date.now() - t0)) < (CONF.fallbackTimeoutMs + 5000) ? 1 : 2;
  for (let attempt = 1; attempt <= maxAttempts && !clientGone; attempt++) {
    try {
      const sock = await tunnelConnect(host, port);
      const fbTimeout = Math.max(6000, Math.min(CONF.fallbackTimeoutMs, CONF.requestBudgetMs - (Date.now() - t0) - 3000));
      const upRes = await httpsOver(socketConnect(sock), host, port, req.method, reqPath, headers, bodyBuf, fbTimeout);
      log('FALLBACK', host + reqPath.slice(0, 60), upRes.statusCode, 'direct=' + (directErr ? directErr.message : 'n/a'), 'attempt=' + attempt, Date.now() - t0 + 'ms');
      return relayResponse(upRes, res);
    } catch (e) { lastErr = e; if (/SSL|packet length|ECONNRESET|socket hang up|timeout/i.test(e && e.message)) { dnsCache.delete(host); cleanDnsCache.delete(host); } }
  }
  log('FAIL', host, 'direct=' + (directErr ? directErr.message : 'n/a'), 'fallback=' + (lastErr ? lastErr.message : 'n/a'), Date.now() - t0 + 'ms');
  if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end('proxy-suite: direct=' + (directErr ? directErr.message : 'n/a') + '; fallback=' + (lastErr ? lastErr.message : 'n/a'));
  else res.destroy();
});

// ---------- WebSocket 升级 ----------
server.on('upgrade', async (req, clientSock, head) => {
  log('UPGRADE', req.url.split('?')[0].slice(0, 80));
  const m = /^\/([^/]+)\/([^/:]+)(?::([0-9]+))?(\/.*)?$/.exec(req.url);
  if (!m || m[1] !== CONF.secret || !timingSafeEq(req.headers.dspassword, CONF.password)) return clientSock.destroy();
  const host = m[2];
  const port = m[3] ? Number(m[3]) : 443;
  const reqPath = m[4] || '/';
  const headers = Object.assign({}, req.headers);
  delete headers.dspassword;
  delete headers['proxy-connection'];
  if (isLocalHost(host)) { log('LOOPBACK-BLOCK', host + ':' + port, reqPath.slice(0, 60)); return clientSock.destroy(); }
  headers.host = port === 443 ? host : host + ':' + port;
  const raw = req.method + ' ' + reqPath + ' HTTP/1.1\r\n' + Object.entries(headers).map(([k, v]) => k + ': ' + v + '\r\n').join('') + '\r\n';
  const send = (sock) => {    sock.write(Buffer.concat([Buffer.from(raw), head && head.length ? head : Buffer.alloc(0)]));    sock.pipe(clientSock);    clientSock.pipe(sock);    let firstLine = null; let upBytes = 0; let clBytes = 0;    const probe = (chunk) => { upBytes += chunk.length; if (firstLine === null) { firstLine = chunk.toString('latin1').split('\r\n')[0]; log('WS-UPSTREAM', host, firstLine); } };    sock.on('data', probe);
    clientSock.on('data', (c) => { clBytes += c.length; });
    const wsReport = (why) => log('WS-END', host, why, 'up=' + upBytes + 'B cli=' + clBytes + 'B', (Date.now() - t0) + 'ms');
    sock.on('close', () => wsReport('upstream-close'));
    clientSock.on('close', () => wsReport('client-close'));    sock.on('error', () => clientSock.destroy());    clientSock.on('error', () => sock.destroy());    clientSock.on('close', () => log('WS-CLOSED', host, 'upstream=' + (firstLine || 'n/a'), (Date.now() - t0) + 'ms'));  };  const t0 = Date.now();
  const openDirect = () =>
    new Promise((resolve, reject) => {
      dohResolve(host).then((ips) => {
        const s = tls.connect({ host: ips[0] || host, port, servername: host, timeout: CONF.directTimeoutMs }, () => resolve(s));
        s.once('error', reject);
        s.once('timeout', () => s.destroy(new Error('direct timeout')));
      });
    });
  try {
    const s = await openDirect();
    log('UPGRADE-DIRECT', host, Date.now() - t0 + 'ms');
    send(s);
  } catch (e1) {
    try {
      const s = await tunnelConnect(host, port, { noAlpn: true });
      log('UPGRADE-FALLBACK', host, 'direct=' + e1.message, Date.now() - t0 + 'ms');
      send(s);
    } catch (e2) {
      log('UPGRADE-FAIL', host, e2);
      clientSock.destroy();
    }
  }
});

server.on('clientError', (err, socket) => {
  log('CLIENT-ERROR', err && err.message);
  if (socket.writable && !socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

fs.writeFileSync(PID_PATH, process.pid + String.fromCharCode(10));
process.on('SIGTERM', () => { try { fs.unlinkSync(PID_PATH); } catch (e) {} process.exit(0); });
process.on('exit', () => { try { fs.unlinkSync(PID_PATH); } catch (e) {} });
// listen 失败(EADDRINUSE 等)只记日志不崩进程: 管理器 healthz 探测不到会拉起新实例自愈
server.on('error', (e) => log('listen error', (e && e.code) || (e && e.message) || e));
server.listen(CONF.port || 8470, '127.0.0.1', () => log('listening (http)', '127.0.0.1:' + (CONF.port || 8470), 'upstream=' + UP.href, 'directTimeoutMs=' + CONF.directTimeoutMs, 'pid=' + process.pid));
