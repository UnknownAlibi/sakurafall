<template>
  <div class="danmaku-match-panel danmaku-settings-panel">
    <header>
      <div>
        <h3>弹幕设置</h3>
        <p>调整会实时生效并保存</p>
      </div>
      <button type="button" @click="$emit('close')" title="关闭">×</button>
    </header>
    <div class="danmaku-settings-body">
      <div class="danmaku-settings-row">
        <div class="danmaku-settings-label">
          <span>弹幕开关</span>
        </div>
        <label class="switch">
          <input type="checkbox" :checked="enableDanmaku" @change="$emit('toggle-danmaku')" />
          <span class="slider"></span>
        </label>
      </div>
      <div class="danmaku-settings-row">
        <div class="danmaku-settings-label">
          <span>字号</span>
          <small>{{ danmakuFontSize }}px（12-36）</small>
        </div>
        <input type="range" min="12" max="36" step="1" class="setting-range"
          :value="danmakuFontSize"
          @input="updateSetting('updateDanmakuFontSize', Number($event.target.value))" />
      </div>
      <div class="danmaku-settings-row">
        <div class="danmaku-settings-label">
          <span>透明度</span>
          <small>{{ Math.round(danmakuOpacity * 100) }}%（10-100）</small>
        </div>
        <input type="range" min="0.1" max="1" step="0.05" class="setting-range"
          :value="danmakuOpacity"
          @input="updateSetting('updateDanmakuOpacity', Number($event.target.value))" />
      </div>
      <div class="danmaku-settings-row">
        <div class="danmaku-settings-label">
          <span>速度</span>
          <small>{{ danmakuSpeed }}x（0.5=慢，2=快）</small>
        </div>
        <input type="range" min="0.5" max="2" step="0.25" class="setting-range"
          :value="danmakuSpeed"
          @input="updateSetting('updateDanmakuSpeed', Number($event.target.value))" />
      </div>
      <div class="danmaku-settings-row">
        <div class="danmaku-settings-label">
          <span>显示区域</span>
          <small>{{ Math.round(danmakuDisplayArea * 100) }}% 屏幕高度</small>
        </div>
        <input type="range" min="0.25" max="1" step="0.05" class="setting-range"
          :value="danmakuDisplayArea"
          @input="updateSetting('updateDanmakuDisplayArea', Number($event.target.value))" />
      </div>
      <div class="danmaku-settings-row">
        <div class="danmaku-settings-label">
          <span>同屏密度</span>
          <small>{{ danmakuDensity }} 条（20-150）</small>
        </div>
        <input type="range" min="20" max="150" step="5" class="setting-range"
          :value="danmakuDensity"
          @input="updateSetting('updateDanmakuDensity', Number($event.target.value))" />
      </div>
      <div class="danmaku-settings-row is-block">
        <div class="danmaku-settings-label">
          <span>在线弹幕源</span>
          <small>并行匹配合并结果；关闭后需重新匹配</small>
        </div>
        <div class="danmaku-settings-providers">
          <label v-for="option in providerOptions" :key="option.id" class="danmaku-settings-provider">
            <input
              type="checkbox"
              :checked="danmakuProviders[option.id] !== false"
              @change="updateProvider(option.id, $event.target.checked)"
            />
            <span>{{ option.name }}</span>
          </label>
        </div>
      </div>
      <div class="danmaku-settings-row is-block">
        <div class="danmaku-settings-label">
          <span>匹配操作</span>
          <small>{{ animeName }} · 第 {{ episodeNumber || '?' }} 集</small>
        </div>
        <div class="danmaku-settings-actions">
          <button type="button" class="danmaku-settings-action" @click="$emit('refresh')">重新匹配当前集</button>
          <button type="button" class="danmaku-settings-action" @click="$emit('import-xml')">导入本地 XML</button>
          <button type="button" class="danmaku-settings-action" :class="{ active: matchVisible }" @click="$emit('show-match')">
            {{ matchVisible ? '收起候选' : '手动校正匹配' }}
          </button>
        </div>
      </div>
      <div v-if="matchVisible" class="danmaku-settings-match">
        <div v-if="matchLoading" class="danmaku-match-state">
          <div class="loading-spinner small"></div><span>正在搜索各平台番剧库...</span>
        </div>
        <div v-else-if="!matchGroups.some(group => group.candidates?.length)" class="danmaku-match-state">
          暂未找到可校正的候选，仍可导入本地 XML 或配置自定义接口
        </div>
        <div v-else class="danmaku-match-groups">
          <section v-for="group in matchGroups" :key="group.id" v-show="group.candidates?.length">
            <div class="danmaku-match-source">
              <strong>{{ group.name }}</strong><span>{{ group.candidates.length }} 个候选</span>
            </div>
            <button
              v-for="candidate in group.candidates"
              :key="`${group.id}-${candidate.id}`"
              type="button"
              class="danmaku-match-candidate"
              @click="$emit('apply-match', group.id, candidate)"
            >
              <span>{{ candidate.title }}</span>
              <small>匹配度 {{ Math.round((candidate.score || 0) * 100) }}%</small>
            </button>
          </section>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { mapGetters } from 'vuex';

/**
 * 弹幕设置面板（播放页内嵌右下角悬浮框，聚合设置/匹配操作/手动校正候选）
 * 滑杆/开关实时写入 settings store（action 自带防抖保存），
 * 弹幕源切换会同步主进程配置并发出 notice 事件由播放器提示；
 * 匹配操作与校正候选列表内嵌展示，不再弹出第二个窗口
 */
export default {
  name: 'DanmakuSettingsPanel',
  props: {
    animeName: { type: String, default: '' },
    episodeNumber: { type: Number, default: 0 },
    // 校正候选区是否展开（由父组件控制，展开时父组件负责加载候选）
    matchVisible: { type: Boolean, default: false },
    matchLoading: { type: Boolean, default: false },
    // [{ id, name, candidates: [{ id, title, score }] }]
    matchGroups: { type: Array, default: () => [] }
  },
  emits: ['close', 'toggle-danmaku', 'notice', 'refresh', 'import-xml', 'show-match', 'apply-match'],
  data() {
    return {
      // 与 Settings.vue 的 danmakuProviderOptions 保持一致
      providerOptions: [
        { id: 'bilibili', name: '哔哩哔哩' },
        { id: 'acfun', name: 'AcFun' },
        { id: 'tencent', name: '腾讯视频' },
        { id: 'iqiyi', name: '爱奇艺' },
        { id: 'youku', name: '优酷' },
        { id: 'dandanplay', name: '弹弹play 聚合' },
        { id: 'custom', name: '自定义接口' }
      ]
    };
  },
  computed: {
    ...mapGetters('settings', [
      'enableDanmaku',
      'danmakuFontSize',
      'danmakuOpacity',
      'danmakuSpeed',
      'danmakuDisplayArea',
      'danmakuDensity',
      'danmakuProviders'
    ])
  },
  methods: {
    // 滑杆实时写入 store（action 自带防抖保存）
    updateSetting(action, value) {
      this.$store.dispatch(`settings/${action}`, value);
    },

    // 切换弹幕源：同步主进程配置，结果通过 notice 事件提示
    async updateProvider(providerId, checked) {
      const next = { ...(this.danmakuProviders || {}), [providerId]: checked };
      await this.$store.dispatch('settings/updateDanmakuProviders', next);
      const result = await window.electronAPI?.danmakuConfigureProviders?.({
        providers: next,
        customEndpoint: this.$store.state.settings.danmakuCustomEndpoint || '',
        customToken: this.$store.state.settings.danmakuCustomToken || ''
      });
      if (result?.ok === false) {
        this.$emit('notice', `弹幕源配置失败：${result.msg || '未生效'}`, 'error');
      } else {
        this.$emit('notice', '弹幕源已更新，切集或重新匹配后生效', 'info');
      }
    }
  }
};
</script>

<style scoped>
/* 面板骨架 */
.danmaku-match-panel {
  width: min(480px, calc(100% - 32px));
  max-height: min(68vh, 560px);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border: 1px solid rgba(255, 137, 177, 0.22);
  border-radius: 8px;
  background: rgba(24, 20, 35, 0.97);
  box-shadow: 0 18px 46px rgba(0, 0, 0, 0.34);
}

.danmaku-match-panel > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 15px 16px 13px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.danmaku-match-panel h3,
.danmaku-match-panel p {
  margin: 0;
  letter-spacing: 0;
}

.danmaku-match-panel h3 { color: #fff; font-size: 15px; }
.danmaku-match-panel p { margin-top: 4px; color: rgba(255, 255, 255, 0.5); font-size: 11px; }

.danmaku-match-panel > header button {
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: rgba(255, 255, 255, 0.68);
  font-size: 22px;
  cursor: pointer;
}

.danmaku-match-panel > header button:hover { background: rgba(255, 255, 255, 0.08); color: #fff; }

/* 设置区：flex 收缩 + 内部滚动，确保底部按钮始终在面板可视区内 */
.danmaku-settings-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.danmaku-settings-row {
  display: flex;
  align-items: center;
  gap: 14px;
}

.danmaku-settings-row.is-block { flex-direction: column; align-items: stretch; gap: 10px; }

.danmaku-settings-label { display: flex; flex-direction: column; gap: 2px; min-width: 118px; }
.danmaku-settings-label span { color: rgba(255, 255, 255, 0.88); font-size: 13px; }
.danmaku-settings-label small { color: rgba(255, 255, 255, 0.42); font-size: 11px; }

.danmaku-settings-row .setting-range { flex: 1; min-width: 0; }

/* 开关（与 Settings 页视觉一致） */
.switch { position: relative; display: inline-block; width: 40px; height: 22px; flex: none; }
.switch input { opacity: 0; width: 0; height: 0; }
.switch .slider {
  position: absolute;
  inset: 0;
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.16);
  transition: background-color 200ms var(--ease-smooth, ease);
  cursor: pointer;
}
.switch .slider::before {
  content: '';
  position: absolute;
  left: 3px;
  top: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  transition: transform 200ms var(--ease-smooth, ease);
}
.switch input:checked + .slider { background: rgba(255, 137, 177, 0.85); }
.switch input:checked + .slider::before { transform: translateX(18px); }

/* 滑杆（与 Settings 页视觉一致） */
.setting-range {
  -webkit-appearance: none;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.18);
  outline: none;
}
.setting-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: rgba(255, 137, 177, 0.95);
  cursor: pointer;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
}

/* 弹幕源开关网格 */
.danmaku-settings-providers {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(128px, 1fr));
  gap: 6px;
}

.danmaku-settings-provider {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.04);
  color: rgba(255, 255, 255, 0.82);
  font-size: 12px;
  cursor: pointer;
  transition: border-color 150ms ease, background-color 150ms ease;
}

.danmaku-settings-provider:hover { border-color: rgba(255, 137, 177, 0.34); background: rgba(255, 137, 177, 0.08); }
.danmaku-settings-provider input { accent-color: rgba(255, 137, 177, 0.95); }

/* 匹配操作按钮区 */
.danmaku-settings-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.danmaku-settings-action {
  padding: 7px 11px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.05);
  color: rgba(255, 255, 255, 0.85);
  font-size: 12px;
  cursor: pointer;
  transition: border-color 150ms ease, background-color 150ms ease;
}

.danmaku-settings-action:hover { border-color: rgba(255, 137, 177, 0.4); background: rgba(255, 137, 177, 0.1); }
.danmaku-settings-action.active { border-color: rgba(255, 137, 177, 0.55); background: rgba(255, 137, 177, 0.16); color: #fff; }

/* 内嵌校正候选列表 */
.danmaku-settings-match {
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding-top: 10px;
  margin: 0 -6px;
}

.danmaku-match-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 90px;
  color: rgba(255, 255, 255, 0.58);
  font-size: 12px;
  text-align: center;
}

.danmaku-match-groups {
  max-height: 220px;
  overflow-y: auto;
  padding: 2px 6px;
}

.danmaku-match-groups section + section { margin-top: 12px; }

.danmaku-match-source {
  display: flex;
  justify-content: space-between;
  padding: 4px 5px 7px;
  color: rgba(255, 255, 255, 0.72);
  font-size: 11px;
}

.danmaku-match-source span { color: rgba(255, 255, 255, 0.38); }

.danmaku-match-candidate {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  min-height: 40px;
  margin: 3px 0;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.045);
  color: rgba(255, 255, 255, 0.84);
  text-align: left;
  cursor: pointer;
  transition: background-color 150ms ease, border-color 150ms ease;
}

.danmaku-match-candidate:hover {
  border-color: rgba(255, 137, 177, 0.34);
  background: rgba(255, 137, 177, 0.1);
}

.danmaku-match-candidate span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.danmaku-match-candidate small { flex: none; color: rgba(255, 255, 255, 0.4); }
</style>
