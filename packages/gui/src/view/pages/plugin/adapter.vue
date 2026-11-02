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
        this.$message.success('配置已保存。修改端口或 upstream 后需重启适配器生效')
      } catch (e) {
        this.$message.error(`保存失败：${e.message || e}`)
      } finally {
        this.loading = false
      }
    },

    async start () {
      this.starting = true
      try {
        const ret = await this.$api.adapter.start()
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

    async restart () {
      this.starting = true
      try {
        const ret = await this.$api.adapter.restart()
        if (ret && ret.ok) {
          this.$message.success('适配器已重启')
        } else {
          this.$message.warning((ret && ret.msg) || '重启后未监听，请查看日志')
        }
      } catch (e) {
        this.$message.error(`重启失败：${e.message || e}`)
      } finally {
        this.starting = false
        await Promise.all([this.refreshStatus(), this.refreshLogs()])
      }
    },

    async integrateOverwall () {
      try {
        await this.$api.adapter.integrateOverwall()
        this.$message.success('已把适配器注册为增强功能(overwall)自定义服务器 ID 1，请重启加速服务后生效')
      } catch (e) {
        this.$message.error(`接入失败：${e.message || e}`)
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
        description="所有被代理的请求先尝试国内直连（DoH 解析，超时可配）；直连失败或返回 403/451 时自动转发到下面的 upstream 代理。命中「直连跳过域名」的请求不试直连，直接走 upstream。换 VPN 只需改 upstream 地址。"
      />

      <a-form :label-col="{ span: 5 }" :wrapper-col="{ span: 19 }">
        <a-form-item label="运行状态">
          <a-space>
            <span :style="{ color: statusColor, fontWeight: 600 }">{{ statusText }}</span>
            <span v-if="status.pid">PID: {{ status.pid }}</span>
          </a-space>
        </a-form-item>

        <a-form-item label="监听端口">
          <a-input-number v-model:value="conf.port" :min="1024" :max="65535" style="width: 180px" />
          <div class="form-help">
            适配器在本机监听的端口，默认 8470。修改后需重启适配器。
          </div>
        </a-form-item>

        <a-form-item label="兜底代理 upstream">
          <a-input v-model:value="conf.upstream" placeholder="http://127.0.0.1:7890" allow-clear />
          <div class="form-help">
            直连失败时转发到的代理地址。默认是本机 7890 端口的代理软件；以后换其他 VPN 软件，只改这个地址即可。
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
            :rows="5"
            placeholder="auth.openai.com&#10;chatgpt.com&#10;.claude.com"
          />
          <div class="form-help">
            每行一个域名（支持 .example.com 后缀匹配）。命中的域名不尝试直连，直接走兜底代理——用于「直连能连上但内容被地区封锁」的站点（如 claude.com 返回封锁页、auth.openai.com 返回 403）。保存后立即生效，无需重启。
          </div>
        </a-form-item>

        <a-form-item label="探测地址">
          <a-input v-model:value="conf.probeUrl" placeholder="https://www.cloudflare.com/" allow-clear />
          <div class="form-help">
            用于检测直连/代理连通性的探测地址，一般保持默认。
          </div>
        </a-form-item>

        <a-form-item label="VPN 软件名">
          <a-input v-model:value="conf.vpnApp" placeholder="可选：VPN 软件进程名，用于守护重启" allow-clear />
          <div class="form-help">
            填写后适配器会在 VPN 进程意外退出时尝试重新拉起（需与进程名匹配）。留空则不启用守护。
          </div>
        </a-form-item>

        <a-form-item label="VPN 自动守护">
          <a-switch v-model:checked="conf.vpnAutoRestart" />
          <div class="form-help">
            开启后按上面的 VPN 软件名做进程守护。
          </div>
        </a-form-item>

        <a-form-item :wrapper-col="{ offset: 5 }">
          <a-space wrap>
            <a-button type="primary" :loading="loading" @click="save()">
              保存配置
            </a-button>
            <a-button type="primary" :loading="starting" @click="start()">
              启动
            </a-button>
            <a-button :loading="starting" @click="restart()">
              重启
            </a-button>
            <a-button danger @click="stop()">
              停止
            </a-button>
            <a-button @click="integrateOverwall()">
              接入增强功能(overwall)
            </a-button>
          </a-space>
          <div class="form-help">
            「接入增强功能」会把本适配器写为增强功能的自定义服务器 ID 1：增强功能命中的域名走适配器兜底，适配器再按「直连优先 → 失败转 upstream」处理。
          </div>
        </a-form-item>

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
</style>
