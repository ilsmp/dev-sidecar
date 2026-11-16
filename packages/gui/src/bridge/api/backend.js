import fs from 'node:fs'
// 内核身份（构建期烘焙的提交 SHA），供底栏展示；内核 version 已废弃，不展示
import { KERNEL_SHA_FULL, KERNEL_SHA_SHORT } from '../../generated/kernel-info.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import DevSidecar from '@blue-frontier/dev-sidecar'
import electron from '../../electron.js'
const { app, ipcMain, shell } = electron
import lodash from 'lodash'
import jsonApi from '@blue-frontier/mitmproxy/src/json.js'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const pk = require('../../../package.json')
import configLoader from '@blue-frontier/dev-sidecar/src/config/local-config-loader.js'
import loggerFactory from '@blue-frontier/dev-sidecar/src/utils/util.logger.js'
import log from '../../utils/util.log.gui.js'
import dateUtil from '@blue-frontier/dev-sidecar/src/utils/util.date.js'
import coreConfig from '@blue-frontier/dev-sidecar/src/config/index.js'
import serviceGroup from '@blue-frontier/dev-sidecar/src/service-group.js'
import adapterApi from './adapter-manager.js'

const { defaultConfig: coreDefaultConfig } = coreConfig
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const mitmproxyPath = path.join(__dirname, '../mitmproxy.js')
// extra/ 在打包后位于 resources/extra（extraResources，asar 外）；开发时在项目根 extra/
// 不能用 getAppPath()：打包后它是 app.asar，exe 在 asar 内无法执行
process.env.DS_EXTRA_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'extra')
  : path.join(app.getAppPath(), 'extra')
let currentWin

const getDefaultConfigBasePath = function () {
  return DevSidecar.api.config.get().server.setting.userBasePath
}

function getMetaInfo (config, fallbackId) {
  const metaInfo = lodash.get(config, 'app.metaInfo') || lodash.get(config, 'metaInfo') || {}
  return {
    id: metaInfo.id || fallbackId,
    version: metaInfo.version || 0,
    updateLog: metaInfo.updateLog || '',
    showLabel: metaInfo.showLabel !== false && metaInfo.showLabel !== 'false', // 个人配置可以使用此配置隐藏footer中的 '当前配置：' 字样
  }
}

function emitConfigChanged () {
  if (currentWin) {
    currentWin.webContents.send('config.changed')
  }
}

const localApi = {
  /**
   * 返回所有api列表，供vue来ipc调用
   * @returns {[]} api列表
   */
  getApiList () {
    const core = lodash.cloneDeep(DevSidecar.api)
    const local = lodash.cloneDeep(localApi)
    lodash.merge(core, local)
    const list = []
    _deepFindFunction(list, core, '')
    // log.info('api list:', list)
    return list
  },
  info: {
    get () {
      const runtimeConfig = DevSidecar.api.config.get()
      const remoteConfig = lodash.get(runtimeConfig, 'app.remoteConfig') || {}

      const internal = getMetaInfo(coreDefaultConfig, '')
      const user = getMetaInfo(configLoader.getUserConfig(), '')
      const sharedRemote = getMetaInfo(configLoader.getRemoteConfig(), '')
      const personalRemote = getMetaInfo(configLoader.getRemoteConfig('_personal'), '')
      const selection = configLoader.getRemoteSelection()
      const history = configLoader.getRemoteConfigVersions('')
      const personalHistory = configLoader.getRemoteConfigVersions('_personal')
      // 选择记录可能指向已被删除的历史快照，这种情况下实际生效的是 live 文件，
      // 选择器应回落到「最新版本」，而不是显示一个列表里不存在的值。
      const normalizeSelected = (list, selected) => {
        return selected && list.some(item => item.version === selected) ? selected : ''
      }

      return {
        // 源码运行时由 electron-dev.mjs 注入 `<base>-dev.<指纹>`，仅用于展示
        version: process.env.DEV_SIDECAR_DISPLAY_VERSION || pk.version,
        // 内核身份只用提交 SHA（version 已废弃）
        kernel: { sha: KERNEL_SHA_SHORT, shaFull: KERNEL_SHA_FULL },
        configProfiles: {
          internal,
          user,
          sharedRemote: {
            ...sharedRemote,
            url: remoteConfig.url || '',
            enabled: remoteConfig.enabled === true && Boolean(remoteConfig.url),
          },
          personalRemote: {
            ...personalRemote,
            url: remoteConfig.personalUrl || '',
            enabled: remoteConfig.enabled === true && Boolean(remoteConfig.personalUrl),
          },
          selectedVersion: normalizeSelected(history, selection.shared),
          // core 的 setRemoteSelection 用 suffix 作为键：共享是 shared，个人是 _personal。
          personalSelectedVersion: normalizeSelected(personalHistory, selection._personal),
          history,
          personalHistory,
        },
      }
    },
    getConfigDir () {
      return getDefaultConfigBasePath()
    },
    getLogDir () {
      return loggerFactory.getLogDir()
    },
    /** 迁移 2.2.0 → 3.0.0（migrations/v3.0.0）：密钥入 SecretStore，删明文 */
    async securityMigrate () {
      const migrate = require('@blue-frontier/dev-sidecar/src/utils/util.security-migrate')
      return migrate.runMigration_to3_0_0()
    },
    /** 一键脱敏历史日志 */
    async redactLogs () {
      const dir = loggerFactory.getLogDir()
      const { redactLogDir } = require('@blue-frontier/dev-sidecar/src/utils/util.redact-logs')
      return redactLogDir(dir)
    },
    getSystemPlatform (throwIfUnknown = false) {
      return DevSidecar.api.shell.getSystemPlatform(throwIfUnknown)
    },
  },
  /**
   * 软件设置
   */
  setting: {
    load () {
      const settingPath = _getSettingsPath()
      let setting = {}
      if (fs.existsSync(settingPath)) {
        const file = fs.readFileSync(settingPath)
        try {
          setting = jsonApi.parse(file.toString())
          log.info('读取 setting.json 成功:', settingPath)
        } catch (e) {
          log.error('读取 setting.json 失败:', settingPath, ', error:', e)
        }
        if (setting == null) {
          setting = {}
        }
      }
      if (setting.overwall == null) {
        setting.overwall = false
      }

      if (setting.installTime == null) {
        // 设置安装时间
        setting.installTime = dateUtil.now()

        // 初始化 rootCa.setuped
        if (setting.rootCa == null) {
          setting.rootCa = {
            setuped: false,
            desc: '根证书未安装',
          }
        }

        // 保存 setting.json
        localApi.setting.save(setting)
      }
      return setting
    },
    save (setting = {}) {
      const settingPath = _getSettingsPath()
      try {
        fs.writeFileSync(settingPath, jsonApi.stringify(setting))
        log.info('保存 setting.json 配置文件成功:', settingPath)
      } catch (e) {
        log.error('保存 setting.json 配置文件失败:', settingPath, ', error:', e)
      }
    },
  },
  config: {
    get () {
      return DevSidecar.api.config.get()
    },
    save (newConfig) {
      const result = DevSidecar.api.config.save(newConfig)
      emitConfigChanged()
      return result
    },
    reload () {
      const result = DevSidecar.api.config.reload()
      emitConfigChanged()
      return result
    },
    /**
     * 下载远程配置。
     *
     * 下载失败是非致命的：本地已缓存的远程配置（或内置配置）仍然可用，代理不受影响。
     * 因此这里不向上抛异常，而是返回 `{ ok: true, updated }` 或 `{ ok: false, error }`，
     * 否则界面会弹出通用的「Api invoke error」提示——看起来像功能坏了，实际不影响使用。
     * @returns {Promise<{ok: boolean, updated?: boolean, error?: string}>}
     */
    async downloadRemoteConfig () {
      try {
        const updated = await DevSidecar.api.config.downloadRemoteConfig()
        return { ok: true, updated: updated === true }
      } catch (e) {
        log.error('下载远程配置失败（继续使用本地缓存/内置配置）:', e)
        return { ok: false, error: e && e.message ? e.message : String(e) }
      }
    },
    update (partConfig) {
      const result = DevSidecar.api.config.update(partConfig)
      emitConfigChanged()
      return result
    },
    resetDefault (key) {
      const result = DevSidecar.api.config.resetDefault(key)
      emitConfigChanged()
      return result
    },
    async removeUserConfig () {
      const result = await DevSidecar.api.config.removeUserConfig()
      emitConfigChanged()
      return result
    },
  },
  /**
   * 服务分组：按配置文件里的 `//` 注释分组，批量启停服务
   */
  serviceGroups: {
    /**
     * 列出所有服务分组
     */
    list () {
      return serviceGroup.listCatalog(DevSidecar.api.config.get(), {
        enhancedEnabled: localApi.setting.load().overwall === true,
      })
    },
    /**
     * 启用/停用服务
     * @param options 参数
     * @param options.ids 服务id列表
     * @param options.enabled 是否启用
     * @returns {object} { count, catalog }
     */
    setEnabled (options) {
      const { ids, enabled } = options
      const config = lodash.cloneDeep(DevSidecar.api.config.get())
      const count = serviceGroup.applyEnabled(config, ids, enabled, {
        enhancedEnabled: localApi.setting.load().overwall === true,
      })
      if (count > 0) {
        DevSidecar.api.config.save(config)
        emitConfigChanged()
      }
      return {
        count,
        catalog: localApi.serviceGroups.list(),
      }
    },
    /**
     * 修改用户自己添加/修改的配置项的值
     * @param options 参数
     * @param options.ids 服务id列表
     * @param options.section 分区名（如 intercepts、preSetIpList、dnsMapping 等）
     * @param options.text 配置值的JSON文本
     * @returns {object} { ok, error, catalog } 修改失败时 ok 为 false，error 为错误信息
     */
    setPartValue (options) {
      const { ids, section, text } = options
      let value
      try {
        value = jsonApi.parse(text)
      } catch (e) {
        return { ok: false, error: `配置格式错误：${e.message}` }
      }
      if (value === undefined) {
        return { ok: false, error: '配置值不能为空' }
      }
      const config = lodash.cloneDeep(DevSidecar.api.config.get())
      const count = serviceGroup.setPartValue(config, ids, section, value, {
        enhancedEnabled: localApi.setting.load().overwall === true,
      })
      if (count === 0) {
        return { ok: false, error: '没有找到可修改的配置项' }
      }
      DevSidecar.api.config.save(config)
      emitConfigChanged()
      return {
        ok: true,
        catalog: localApi.serviceGroups.list(),
      }
    },
    /**
     * 把用户自己添加/修改的配置项恢复为默认值（内置 + 远程配置），默认配置里不存在时直接删除
     * @param options 参数
     * @param options.ids 服务id列表
     * @param options.sections 需要恢复的分区名列表（不传表示该服务的全部配置项）
     * @returns {object} { count, catalog } count 为被恢复的配置项数量
     */
    resetItems (options) {
      const { ids, sections } = options
      const config = lodash.cloneDeep(DevSidecar.api.config.get())
      const count = serviceGroup.resetParts(config, ids, sections, {
        enhancedEnabled: localApi.setting.load().overwall === true,
      })
      if (count > 0) {
        DevSidecar.api.config.save(config)
        emitConfigChanged()
      }
      return {
        count,
        catalog: localApi.serviceGroups.list(),
      }
    },
    /**
     * 查找会作用于指定域名的所有服务（匹配规则与代理一致，支持通配符与正则匹配串）
     * @param {object} options { domain }
     * @param {string} options.domain 待查找的域名
     * @returns {object} { domain, ids } ids 为命中的服务 id 列表
     */
    matchHostname (options) {
      const { domain } = options
      const catalog = localApi.serviceGroups.list()
      return {
        domain,
        ids: serviceGroup.matchCatalog(catalog, domain).map(item => item.id),
      }
    },
  },
  /**
   * 启动所有
   * @returns {Promise<void>}
   */
  startup () {
    return DevSidecar.api.startup({ mitmproxyPath, setting: localApi.setting.load() })
  },
  server: {
    /**
     * 启动代理服务
     * @returns {Promise<{port: *}>}
     */
    start () {
      return DevSidecar.api.server.start({ mitmproxyPath, setting: localApi.setting.load() })
    },
    /**
     * 重启代理服务
     * @returns {Promise<void>}
     */
    restart () {
      return DevSidecar.api.server.restart({ mitmproxyPath, setting: localApi.setting.load() })
    },
  },
  /**
   * 兜底适配器(二次开发新增): 独立模块, 官方升级合并零冲突
   * 功能: DoH 直连优先(超时可配) -> 失败/403/451 自动降级 -> upstream 代理(可配, 换任意 VPN 只改 upstream)
   */
  adapter: adapterApi,
  shell: {
    /**
     * 使用 Electron 主进程原生 API 打开文件（避免 cmd.exe start 权限问题）
     */
    openPath (filePath) {
      return shell.openPath(path.resolve(filePath))
    },
  },
}

function _deepFindFunction (list, parent, parentKey) {
  for (const key in parent) {
    const item = parent[key]
    if (item instanceof Function) {
      list.push(parentKey + key)
    } else if (item instanceof Object) {
      _deepFindFunction(list, item, `${parentKey + key}.`)
    }
  }
}

function _getSettingsPath () {
  const dir = getDefaultConfigBasePath()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir)
  } else {
    // 兼容1.7.3及以下版本的配置文件处理逻辑
    const newFilePath = path.join(dir, '/setting.json')
    const oldFilePath = path.join(dir, '/setting.json5')
    if (!fs.existsSync(newFilePath) && fs.existsSync(oldFilePath)) {
      return oldFilePath // 如果新文件不存在，且旧文件存在，则返回旧文件路径
    }
    return newFilePath
  }
  return path.join(dir, '/setting.json')
}

/**
 * 按路径解析 API 目标，返回 { parent, fn } 以便 call 时保留 this 绑定。
 * 此前 lodash.get 取出的函数脱离所属对象后直接调用，
 * 导致 adapter.status/confSave 等内部 this.confGet() 全部报
 * "Cannot read properties of undefined (reading 'confGet')"。
 */
function resolveInvokeTarget (apiPath) {
  const segs = String(apiPath || '').split('.').filter(Boolean)
  if (segs.length === 0) return null
  const last = segs.pop()
  for (const scope of [localApi, DevSidecar.api]) {
    let cur = scope
    let ok = true
    for (const s of segs) {
      if (cur == null || typeof cur !== 'object' || !(s in cur)) {
        ok = false
        break
      }
      cur = cur[s]
    }
    if (ok && cur != null && typeof cur[last] === 'function') {
      return { parent: cur, fn: cur[last] }
    }
  }
  return null
}

function invoke (api, param) {
  const target = resolveInvokeTarget(api)
  if (!target) {
    log.error('找不到此接口方法：' + api)
    throw new Error('api 接口不存在: ' + api)
  }
  // 关键修复：call 保留 this 绑定，adapter.status/confSave 内部的 this.confGet() 才能工作
  return target.fn.call(target.parent, param)
}

/**
 * 首次安装种入个人默认配置。
 * 落点：用户层 config.json —— 合并顺序中最后合并、优先级最高，
 * 共享远程/个人远程/内置默认都无法覆盖它。
 * 模板随安装包分发（resources/extra/personal-defaults/config.personal.json5）。
 * 写入标记文件后不再重复种入：升级/重装不会覆盖用户后续修改。
 * 同时默认开启增强模式开关（setting.overwall=true），安装即生效无需二次配置。
 */
function ensurePersonalDefaults () {
  try {
    const userBase = configLoader.getUserBasePath()
    const markerPath = path.join(userBase, '.personal-defaults-applied')
    if (fs.existsSync(markerPath)) return
    const defaultsDir = process.env.DS_EXTRA_PATH || path.join(__dirname, '../../../extra')
    const defaultsSrc = path.join(defaultsDir, 'personal-defaults', 'config.personal.json5')
    if (!fs.existsSync(defaultsSrc)) {
      log.info('[personal-defaults] 模板不存在，跳过种入: ' + defaultsSrc)
      return
    }
    const defaults = jsonApi.parse(fs.readFileSync(defaultsSrc, 'utf8')) || {}
    fs.mkdirSync(userBase, { recursive: true })
    const cfgPath = configLoader.getUserConfigPath()
    let cur = {}
    if (fs.existsSync(cfgPath)) {
      try {
        cur = jsonApi.parse(fs.readFileSync(cfgPath, 'utf8')) || {}
      } catch {
        cur = {}
      }
    }
    // 深合并但用户优先:
    //  - 用户已有标量(含 null 删除标记)整值保留, 用户没配的标量用模板
    //  - 用户已有数组整组保留, 用户没配的数组用模板整组
    //  - 双方都是普通对象时递归按键补缺
    lodash.mergeWith(cur, defaults, (userVal, tmplVal) => {
      if (userVal === undefined) return undefined // 用户没配 -> 用模板值
      if (Array.isArray(userVal)) return userVal // 用户数组整组保留
      if (lodash.isPlainObject(userVal) && lodash.isPlainObject(tmplVal)) return undefined // 对象递归补缺
      return userVal // 用户标量/null 标记保留
    })
    fs.writeFileSync(cfgPath, jsonApi.stringify(cur), { mode: 0o600 })
    fs.writeFileSync(markerPath, new Date().toISOString())
    log.info('[personal-defaults] 已种入个人默认配置到用户层(最高优先级): ' + cfgPath)
    // 解锁并打开增强模式开关（仅首次；不覆盖用户已显式设置的 false）
    const settingPath = _getSettingsPath()
    let setting = {}
    try {
      if (fs.existsSync(settingPath)) {
        setting = jsonApi.parse(fs.readFileSync(settingPath, 'utf8')) || {}
      }
    } catch {
      setting = {}
    }
    if (setting.overwall !== false) {
      setting.overwall = true
      try {
        fs.writeFileSync(settingPath, jsonApi.stringify(setting))
        log.info('[personal-defaults] 已默认开启增强模式开关(setting.overwall=true)')
      } catch (e) {
        log.warn('[personal-defaults] 写 setting.json 失败(可手动开启): ' + (e && e.message))
      }
    }
  } catch (e) {
    log.error('[personal-defaults] 种入失败(不影响启动): ' + ((e && e.stack) || e))
  }
}

/** 兜底适配器自启动（conf.enabled === false 时跳过），并幂等注册 overwall 自定义服务器 */
async function autoStartAdapter () {
  try {
    const conf = adapterApi.confGet()
    if (conf.enabled === false) {
      log.info('[adapter] 兜底适配器开关为关，跳过自启动')
      return
    }
    const ret = await adapterApi.start()
    if (ret && ret.ok) {
      log.info('[adapter] 兜底适配器已自启动' + (ret.adopted ? '(收养外部实例)' : (ret.pid ? ' pid=' + ret.pid : '')))
      try {
        await adapterApi.integrateOverwall()
      } catch (e) {
        log.warn('[adapter] overwall 自动接入失败(可在兜底适配器页手动接入): ' + (e && e.message))
      }
    } else {
      log.warn('[adapter] 兜底适配器自启动未就绪: ' + ((ret && ret.msg) || 'unknown'))
    }
  } catch (e) {
    log.warn('[adapter] 兜底适配器自启动失败(可在兜底适配器页手动启动): ' + (e && e.message))
  }
}

async function doStart () {
  // 远程配置异步下载：有更新时自动 reload 并通知界面，不阻塞四个开关/代理启动
  DevSidecar.api.config.startAutoDownloadRemoteConfig({
    onUpdated: () => {
      emitConfigChanged()
    },
  })
  emitConfigChanged()
  // 启动所有（首页开关无需等待配置下载）
  localApi.startup()
  // 兜底适配器自启动（fire-and-forget，不阻塞代理服务启动）
  autoStartAdapter()
}

export default {
  install ({ win }) {
    currentWin = win
    // 首次安装种入个人默认配置（config.json 用户层，最高优先级，不被远程覆盖）
    ensurePersonalDefaults()
    // 接收view的方法调用
    ipcMain.handle('apiInvoke', async (event, args) => {
      const api = args[0]
      let param
      if (args.length >= 2) {
        param = args[1]
      }
      return invoke(api, param)
    })
    // 注册从core里来的事件，并转发给view
    DevSidecar.api.event.register('status', (event) => {
      log.info('bridge on status, event:', event)
      if (win) {
        win.webContents.send('status', { ...event })
      }
    })
    DevSidecar.api.event.register('error', (event) => {
      log.error('bridge on error, event:', event)
      if (win) {
        win.webContents.send('error.core', event)
      }
    })
    DevSidecar.api.event.register('speed', (event) => {
      if (win) {
        win.webContents.send('speed', event)
      }
    })
    DevSidecar.api.event.register('traffic', (event) => {
      if (win) {
        win.webContents.send('traffic', event)
      }
    })

    // 合并用户配置
    DevSidecar.api.config.reload()
    doStart()
  },
  devSidecar: DevSidecar,
  invoke,
  adapter: adapterApi,
}
