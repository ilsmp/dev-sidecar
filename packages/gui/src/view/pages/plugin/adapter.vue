<script>
import { defineComponent } from 'vue'
import DsContainer from '../../components/container'

export default defineComponent({
  name: 'Adapter',
  components: { DsContainer },

  data () {
    return {
      conf: undefined,
      status: {},
      logs: '',
      loading: false,
      starting: false,
      directSkipHostsText: '',
      logTimer: null,
    }
  },

  computed: {
    statusText () {
      if (!this.status || !this.status.running) {
        return '未运行'
      }
      return this.status.listening ? '运行中（端口已监听）' : '运行中（端口未就绪）'
    },
    statusColor () {
      if (!this.status || !this.status.running) {
        return '#999'
      }
      return this.status.listening ? '#52c41a' : '#faad14'
    },
  },

  mounted () {
    this.load()
    // 日志每 3 秒自动刷新
    this.logTimer = setInterval(() => {
      this.refreshLogs()
      this.refreshStatus()
    }, 3000)
  },

  unmounted () {
    if (this.logTimer) {
      clearInterval(this.logTimer)
      this.logTimer = null
    }
  },

  methods: {
    async load () {
      try {
        this.conf = await this.$api.adapter.confGet()
        this.directSkipHostsText = (this.conf.directSkipHosts || []).join('\n')
        await Promise.all([this.refreshStatus(), this.refreshLogs()])
      } catch (e) {
        this.$message.error(`加载适配器配置失败：${e.message || e}`)
      }
    },

    async save () {
      if (!this.conf) {
        return
      }
      this.loading = true
      try {
        const hosts = this.directSkipHostsText
          .split(/[,\n\r]+/)
          .map(s => s.trim().toLowerCase())
          .filter(Boolean)
        this.conf.directSkipHosts = hosts
        this.conf = await this.$api.adapter.confSave(this.conf)
        this.directSkipHostsText = (this.conf.directSkipHosts || []).join('\n')
        this.$message.success('配置已保存，自动热生效（改端口时加速服务会自动热重启同步）')
      } catch (e) {
        this.$message.error(`保存失败：${e.message || e}`)
      } finally {
        this.loading = false
      }
    },

    async start () {
      this.starting = true
      try {
        const ret = await this.$api.adapter.startWithOverwallRestore()
        if (ret && ret.already) {
          this.$message.info('适配器已在运行中')
        } else if (ret && ret.ok) {
          this.$message.success('适配器已启动')
        } else {
          this.$message.warning((ret && ret.msg) || '启动失败，请查看日志')
        }
      } catch (e) {
        this.$message.error(`启动失败：${e.message || e}`)
      } finally {
        this.starting = false
        await Promise.all([this.refreshStatus(), this.refreshLogs()])
      }
    },

    async stop () {
      try {
        await this.$api.adapter.stop()
        this.$message.success('适配器已停止')
      } catch (e) {
        this.$message.error(`停止失败：${e.message || e}`)
      }
      await this.refreshStatus()
    },

    async toggleRun () {
      if (this.status && this.status.running) {
        await this.stop()
      } else {
        await this.start()
      }
    },

    async refreshStatus () {
      try {
        this.status = await this.$api.adapter.status()
      } catch { /* 忽略轮询错误 */ }
    },

    async refreshLogs () {
      try {
        this.logs = await this.$api.adapter.logs()
      } catch { /* 忽略轮询错误 */ }
    },
  },
})
</script>

<template>
  <DsContainer>
    <template #header>
      兜底适配器
    </template>

    <div v-if="conf" class="adapter-page">
      <a-alert
        type="info"
        show-icon
        style="margin-bottom: 16px"
        message="直连优先 → 失败自动兜底"
        description="所有被代理的请求先尝试国内直连（DoH 解析，超时可配）；直连失败或返回 403/451 时自动转发到下面的 upstream 代理。命中「直连跳过域名」的请求不试直连，直接走 upstream。所有配置保存后自动热生效，无需重启；换 VPN 只需改 upstream 地址。"
      />

      <a-form :label-col="{ span: 5 }" :wrapper-col="{ span: 19 }">
        <a-form-item label="运行状态">
          <a-space>
            <span :style="{ color: statusColor, fontWeight: 600 }">{{ statusText }}</span>
            <span v-if="status.pid">PID: {{ status.pid }}</span>
          </a-space>
        </a-form-item>

        <a-form-item label="自启动开关">
          <a-switch
            v-model:checked="conf.enabled"
            checked-children="开"
            un-checked-children="关"
          />
          <div class="form-help">
            开启（默认）时应用启动会自动拉起适配器并接入增强功能(overwall)；关闭后需在本页手动启动。保存后立即生效。
          </div>
        </a-form-item>

        <a-form-item label="兜底代理 upstream">
          <a-input v-model:value="conf.upstream" placeholder="http://127.0.0.1:7890" allow-clear />
          <div class="form-help">
            直连失败时转发到的代理地址。默认是本机 7890 端口的代理软件；以后换其他 VPN 软件，只改这个地址即可。
          </div>
        </a-form-item>

        <a-form-item label="增强功能接入">
          <a-space wrap>
            <a-tag :color="status.overwallRegistered ? 'green' : 'orange'">
              {{ status.overwallRegistered ? '已接入增强功能' : '未接入增强功能' }}
            </a-tag>
            <span class="form-help-inline">
              {{ status.overwallRegistered ? '增强模式流量经本适配器兜底（直连优先 → 失败转 upstream）' : '启动适配器后自动完成接入；未启动时增强模式自动走官方回退服务器或默认模式直连' }}
            </span>
          </a-space>
          <div class="form-help">
            无需手动操作：适配器启动时自动注册为增强功能的自定义服务器，停止时自动移除注册。
          </div>
        </a-form-item>

        <a-form-item :wrapper-col="{ offset: 5 }">
          <a-space wrap>
            <a-button
              :type="status && status.running ? 'default' : 'primary'"
              :danger="!!(status && status.running)"
              :loading="starting"
              @click="toggleRun()"
            >
              {{ status && status.running ? '停止适配器' : '启动适配器' }}
            </a-button>
            <a-button type="primary" :loading="loading" @click="save()">
              保存配置
            </a-button>
          </a-space>
          <div class="form-help">
            适配器默认随应用自启动，无需手动管理；「保存配置」后自动热生效，无需重启。
          </div>
        </a-form-item>

        <a-collapse style="margin-bottom: 16px">
          <a-collapse-panel key="advanced" header="高级参数（默认值即可用，一般无需修改）">
            <a-form :label-col="{ span: 5 }" :wrapper-col="{ span: 19 }">
              <a-form-item label="监听端口">
                <a-input-number v-model:value="conf.port" :min="1024" :max="65535" style="width: 180px" />
                <div class="form-help">
                  适配器在本机监听的端口，默认 8470。修改保存后自动生效（加速服务运行中会自动热重启同步，约数秒中断）。
                </div>
              </a-form-item>

              <a-form-item label="上游协议">
                <a-radio-group v-model:value="conf.upstreamType">
                  <a-radio-button value="auto">auto 自动探测</a-radio-button>
                  <a-radio-button value="http">http 代理</a-radio-button>
                  <a-radio-button value="socks">socks5 代理</a-radio-button>
                </a-radio-group>
                <div class="form-help">
                  默认 auto：引擎会先后尝试 http CONNECT 和 socks5 两种方式连接 upstream，探测成功后记住结果。上游软件只支持其中一种协议时可手动指定。
                </div>
              </a-form-item>

              <a-form-item label="兜底代理超时（毫秒）">
                <a-input-number v-model:value="conf.fallbackTimeoutMs" :min="5000" :max="60000" :step="1000" style="width: 180px" />
                <div class="form-help">
                  通过 upstream 建立连接+发送请求的最长等待时间，默认 25000 毫秒。上游节点慢时可适当调大。
                </div>
              </a-form-item>

              <a-form-item label="请求总预算（毫秒）">
                <a-input-number v-model:value="conf.requestBudgetMs" :min="10000" :max="120000" :step="1000" style="width: 180px" />
                <div class="form-help">
                  单个请求的总时间预算（直连+兜底合计），默认 30000 毫秒，需保持小于 DevSidecar 的 40 秒上限，避免上层先超时。
                </div>
              </a-form-item>

              <a-form-item label="直连超时（毫秒）">
                <a-input-number v-model:value="conf.directTimeoutMs" :min="200" :max="10000" :step="100" style="width: 180px" />
                <div class="form-help">
                  每个请求先试直连的最长等待时间，默认 1000 毫秒。被墙域名直连会等到超时才降级，超时越短切换越快，但太短容易误伤慢网站。
                </div>
              </a-form-item>

              <a-form-item label="直连跳过域名">
                <a-textarea
                  v-model:value="directSkipHostsText"
                  :rows="4"
                  placeholder="auth.openai.com&#10;.claude.com"
                />
                <div class="form-help">
                  每行一个域名（支持 .example.com 后缀匹配）。命中的域名不尝试直连，直接走兜底代理——仅用于「直连能连上但内容被地区封锁」的站点。保存后立即生效。
                </div>
              </a-form-item>
            </a-form>
          </a-collapse-panel>
        </a-collapse>

        <a-form-item label="运行日志">
          <a-textarea :value="logs" readonly :rows="10" class="log-view" />
        </a-form-item>
      </a-form>
    </div>

    <a-spin v-else style="display: block; margin: 80px auto" />
  </DsContainer>
</template>

<style scoped>
.log-view :deep(textarea) {
  font-family: Menlo, Consolas, monospace;
  font-size: 12px;
}
.form-help {
  color: #999;
  font-size: 12px;
  line-height: 1.6;
  margin-top: 4px;
}
.form-help-inline {
  color: #999;
  font-size: 12px;
}
</style>
