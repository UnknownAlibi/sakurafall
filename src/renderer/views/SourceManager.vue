<template>
  <div class="source-manager">
    <!-- 顶栏 -->
    <PageHeader title="片源工作室" subtitle="SOURCE STUDIO / 数据源管理">
      <template #icon>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <ellipse cx="12" cy="5" rx="8" ry="3"/>
          <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>
        </svg>
      </template>
      <span class="sm-subtitle" v-if="sources.length > 0">共 {{ sources.length }} 个源</span>
      <template #actions>
        <button class="sm-btn sm-btn-ghost" @click="goBack">← 返回设置</button>
        <button class="sm-btn sm-btn-secondary" :disabled="importing" @click="onImportFile">
          {{ importing ? '导入中...' : '安装片源包' }}
        </button>
        <button class="sm-btn sm-btn-secondary" :disabled="exporting || sources.length === 0" @click="onExportFile">
          {{ exporting ? '导出中...' : '导出片源包' }}
        </button>
        <button class="sm-btn sm-btn-secondary" :disabled="testingAll || sources.length === 0" @click="onTestAll">
          {{ testingAll ? '检测中...' : '一键检测' }}
        </button>
        <button class="sm-btn sm-btn-secondary" :disabled="clearingCache" @click="onClearCache">
          {{ clearingCache ? '清理中...' : '清理缓存' }}
        </button>
        <button class="sm-btn sm-btn-primary" @click="onAddNew">+ 新增数据源</button>
      </template>
    </PageHeader>

    <!-- 提示条 -->
    <div class="sm-tip">
      <span class="sm-tip-icon">NOTE</span>
      <div class="sm-tip-text">
        片源是独立配置，不属于应用代码。<code>.sourcepack.json</code> 可同时携带 CMS 接口与 XPath 规则，
        能自行编写或安装他人分享的源包；同名 id 的用户配置会覆盖内置配置。
      </div>
    </div>

    <section class="sm-pack-band" aria-label="已安装片源包">
      <div class="sm-pack-heading">
        <div>
          <strong>片源包仓库</strong>
          <small>{{ unifiedProviders.length }} 个统一 Provider · {{ installedSourcePacks.length }} 个已安装包</small>
        </div>
        <button class="sm-btn sm-btn-mini sm-btn-ghost" :disabled="checkingPackUpdates" @click="checkSourcePackUpdates">
          {{ checkingPackUpdates ? '检查中...' : '检查订阅更新' }}
        </button>
      </div>
      <div v-if="installedSourcePacks.length" class="sm-pack-list">
        <div v-for="pack in installedSourcePacks" :key="pack.id" class="sm-pack-item">
          <div>
            <strong>{{ pack.name }}</strong>
            <small>v{{ pack.version }} · {{ pack.sourceCount }} 个源 · {{ pack.author }}</small>
          </div>
          <span v-if="pack.updateUrl" class="sm-badge sm-badge-health">可订阅更新</span>
          <button
            v-if="packUpdates[pack.id]?.updateAvailable"
            class="sm-btn sm-btn-mini sm-btn-primary"
            @click="updateSourcePack(pack)"
          >更新到 {{ packUpdates[pack.id].latestVersion }}</button>
          <span v-if="pack.builtIn" class="sm-badge sm-badge-default">随应用提供</span>
          <button v-else class="sm-btn sm-btn-mini sm-btn-ghost" @click="onRemoveSourcePack(pack)">移除</button>
        </div>
      </div>
      <div v-else class="sm-pack-empty">尚未安装独立片源包</div>
    </section>

    <section v-if="mediaProviders.length" class="sm-pack-band" aria-label="个人媒体库">
      <div class="sm-pack-heading">
        <div>
          <strong>个人高清媒体库</strong>
          <small>本地目录 / WebDAV / Jellyfin / Emby</small>
        </div>
      </div>
      <div class="sm-pack-list">
        <div v-for="provider in mediaProviders" :key="provider.providerId" class="sm-pack-item">
          <div>
            <strong>{{ provider.name }}</strong>
            <small>{{ mediaTypeLabel(provider.mediaType) }} · 健康 {{ healthScore(provider.health) }} · 偏好 {{ provider.preference || 0 }}</small>
          </div>
          <span v-if="provider.health?.averageQualityHeight" class="sm-badge sm-badge-health">
            {{ provider.health.averageQualityHeight }}p
          </span>
          <span v-if="mediaTestResults[provider.providerId]" class="sm-badge" :class="mediaTestResults[provider.providerId].success ? 'sm-badge-health' : 'sm-badge-cooldown'">
            {{ mediaTestResults[provider.providerId].message }}
          </span>
          <button class="sm-btn sm-btn-mini sm-btn-ghost" :disabled="mediaTestingId === provider.providerId" @click="testMediaProvider(provider)">
            {{ mediaTestingId === provider.providerId ? '检测中...' : '检测' }}
          </button>
        </div>
      </div>
    </section>

    <!-- 加载中 -->
    <div v-if="loading" class="sm-loading">
      <div class="anime-loading-mascot" aria-hidden="true"></div>
      <div class="sm-loading-bubble">
        <span>樱月正在检查数据源</span>
        <i></i><i></i><i></i>
      </div>
    </div>

    <!-- 源列表 -->
    <div v-else-if="sources.length > 0" class="sm-list">
      <div
        v-for="src in sources"
        :key="src.id"
        class="sm-card"
        :class="{ 'sm-card-bad': src.available === false, 'sm-card-cooldown': src.health?.coolingDown }"
      >
        <div class="sm-card-header">
          <div class="sm-card-title-block">
            <h3 class="sm-card-title" :title="src.name">{{ src.displayName || src.name }}</h3>
            <span v-if="src.displayName && src.name !== src.displayName" class="sm-card-real-name">{{ src.name }}</span>
          </div>
          <div class="sm-card-badges">
            <span
              v-if="src.health"
              class="sm-badge sm-badge-health"
              :class="healthClass(src.health)"
              :title="healthTitle(src)"
            >健康 {{ healthScore(src.health) }}</span>
            <span v-if="src.health?.coolingDown" class="sm-badge sm-badge-cooldown">冷却中</span>
            <span
              class="sm-badge sm-badge-status"
              :class="statusClass(src.available)"
            >{{ statusLabel(src.available) }}</span>
            <span v-if="src.isCustom" class="sm-badge sm-badge-custom" title="用户自定义源">自定义</span>
            <span v-else class="sm-badge sm-badge-default" title="默认预置源">默认</span>
          </div>
        </div>

        <div class="sm-card-meta">
          <div class="sm-meta-row">
            <span class="sm-meta-label">ID</span>
            <code class="sm-meta-value sm-meta-id">{{ src.id }}</code>
          </div>
          <div class="sm-meta-row">
            <span class="sm-meta-label">API</span>
            <code class="sm-meta-value sm-meta-api" :title="src.api">{{ src.api }}</code>
          </div>
          <div v-if="src.categories && src.categories.length > 0" class="sm-meta-row">
            <span class="sm-meta-label">分类</span>
            <div class="sm-meta-categories">
              <span
                v-for="cat in src.categories"
                :key="cat.id"
                class="sm-category-tag"
              >{{ cat.name }}（{{ cat.id }}）</span>
            </div>
          </div>
          <div v-if="src.lastTestMessage" class="sm-meta-row sm-meta-test-row" :class="{ 'sm-meta-test-error': src.available === false }">
            <span class="sm-meta-label">最近检测</span>
            <span class="sm-meta-value">{{ src.lastTestMessage }}<span v-if="src.lastTestTime"> · {{ src.lastTestTime }}ms</span></span>
          </div>
        </div>

        <div class="sm-card-actions">
          <button
            class="sm-btn sm-btn-mini sm-btn-ghost"
            :disabled="testingAll || testingId === src.id"
            @click="onTestOne(src.id)"
          >{{ testingId === src.id ? '检测中...' : '检测' }}</button>
          <button
            class="sm-btn sm-btn-mini sm-btn-secondary"
            @click="onEdit(src)"
          >编辑</button>
          <button
            class="sm-btn sm-btn-mini sm-btn-danger"
            :disabled="!src.isCustom || deletingId === src.id"
            :title="src.isCustom ? '删除该自定义源' : '默认源无法删除（可编辑后覆盖）'"
            @click="onRemove(src)"
          >{{ deletingId === src.id ? '删除中…' : '删除' }}</button>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else class="sm-empty">
      <div class="sm-empty-icon">📭</div>
      <h3>暂无数据源</h3>
      <p>点击右上角"新增数据源"添加自定义 CMS 源</p>
    </div>

    <!-- 编辑/新增 弹窗 -->
    <div v-if="editorVisible" class="sm-modal-mask" @click.self="closeEditor">
      <div class="sm-modal">
        <div class="sm-modal-header">
          <h3>{{ editorMode === 'add' ? '新增数据源' : `编辑：${editorForm.originalName || editorForm.name}` }}</h3>
          <button class="sm-modal-close" @click="closeEditor" aria-label="关闭">✕</button>
        </div>

        <div class="sm-modal-body">
          <div class="sm-form-row">
            <label class="sm-form-label">
              <span class="sm-form-label-text">ID <span class="sm-req">*</span></span>
              <input
                type="text"
                v-model.trim="editorForm.id"
                class="sm-form-input"
                :disabled="editorMode === 'edit'"
                placeholder="例如 my-custom-source"
              />
            </label>
            <p class="sm-form-hint">唯一标识，只能包含字母、数字、下划线和短横线。编辑时不可修改。</p>
          </div>

          <div class="sm-form-row">
            <label class="sm-form-label">
              <span class="sm-form-label-text">名称 <span class="sm-req">*</span></span>
              <input
                type="text"
                v-model.trim="editorForm.name"
                class="sm-form-input"
                placeholder="例如 我的资源站"
              />
            </label>
          </div>

          <div class="sm-form-row">
            <label class="sm-form-label">
              <span class="sm-form-label-text">API 地址 <span class="sm-req">*</span></span>
              <input
                type="text"
                v-model.trim="editorForm.api"
                class="sm-form-input"
                placeholder="https://example.com/api.php/provide/vod/"
              />
            </label>
            <p class="sm-form-hint">苹果 CMS v10 标准接口，通常以 <code>api.php/provide/vod/</code> 结尾。</p>
          </div>

          <div class="sm-form-row">
            <div class="sm-form-label">
              <span class="sm-form-label-text">分类（可选）</span>
              <button class="sm-btn sm-btn-mini sm-btn-secondary" type="button" @click="addCategory">+ 添加分类</button>
            </div>
            <div v-if="editorForm.categories.length === 0" class="sm-form-empty">
              未配置分类。如源站支持分类列表，可添加 {id, name} 用于番剧库筛选。
            </div>
            <div v-else class="sm-category-editor">
              <div
                v-for="(cat, idx) in editorForm.categories"
                :key="idx"
                class="sm-category-edit-row"
              >
                <input
                  type="text"
                  v-model.trim="cat.id"
                  class="sm-form-input sm-cat-id"
                  placeholder="分类 ID"
                />
                <input
                  type="text"
                  v-model.trim="cat.name"
                  class="sm-form-input sm-cat-name"
                  placeholder="分类名称"
                />
                <button class="sm-btn sm-btn-mini sm-btn-danger" type="button" @click="removeCategory(idx)">删除</button>
              </div>
            </div>
          </div>

          <div class="sm-form-row">
            <label class="sm-form-label">
              <span class="sm-form-label-text">默认分类 ID（可选）</span>
              <input
                type="text"
                v-model.trim="editorForm.defaultCategory"
                class="sm-form-input"
                placeholder="留空使用第一个分类"
              />
            </label>
          </div>
        </div>

        <div class="sm-modal-footer">
          <button class="sm-btn sm-btn-ghost" @click="closeEditor">取消</button>
          <button
            class="sm-btn sm-btn-secondary"
            :disabled="testingEditor || !editorForm.api"
            @click="onTestEditor"
          >{{ testingEditor ? '检测中...' : '测试连通性' }}</button>
          <button class="sm-btn sm-btn-primary" :disabled="saving" @click="onSave">{{ saving ? '保存中...' : '保存' }}</button>
        </div>

        <p v-if="editorTestResult" class="sm-modal-test-result" :class="{ success: editorTestResult.success, error: !editorTestResult.success }">
          {{ editorTestResult.message }}
        </p>
      </div>
    </div>

    <!-- Phase 4: 插件规则源（XPath） -->
    <div class="sm-plugin-section">
      <div class="sm-section-header">
        <h3 class="sm-section-title"><span class="sm-section-index">RULE</span> 插件规则源（XPath）</h3>
        <div class="sm-section-actions">
          <button class="sm-btn sm-btn-secondary" :disabled="pluginTestingAll || pluginSources.length === 0" @click="onPluginTestAll">
            {{ pluginTestingAll ? '检测中...' : '一键检测' }}
          </button>
          <button class="sm-btn sm-btn-secondary" :disabled="pluginImporting" @click="onPluginImportInstalledRules">
            {{ pluginImporting ? '导入中...' : '导入开源片源规则' }}
          </button>
          <button class="sm-btn sm-btn-secondary" :disabled="pluginImporting" @click="onPluginImportFile">
            {{ pluginImporting ? '导入中...' : '导入 JSON' }}
          </button>
          <button class="sm-btn sm-btn-secondary" :disabled="pluginExporting || pluginSources.length === 0" @click="onPluginExportFile">
            {{ pluginExporting ? '导出中...' : '导出 JSON' }}
          </button>
          <button class="sm-btn sm-btn-primary" @click="onPluginAddNew">+ 新增规则源</button>
        </div>
      </div>
      <p class="sm-plugin-tip">
        插件规则源使用 XPath 解析 HTML 页面，适合非标准 CMS 接口的资源站。配置保存在 <code>userData/plugin-sources.json</code>，可参考 <code>config/source-plugins/example-template.json</code>。
      </p>
      <div v-if="pluginLoading" class="sm-loading">
        <div class="sm-loading-bubble"><span>加载中</span><i></i><i></i><i></i></div>
      </div>
      <div v-else-if="pluginSources.length === 0" class="sm-empty">暂无插件规则源</div>
      <div v-else class="sm-plugin-list">
        <div
          v-for="rule in pluginSources"
          :key="rule.id"
          class="sm-plugin-card"
          :class="{ 'sm-plugin-disabled': !rule.enabled }"
        >
          <div class="sm-plugin-card-header">
            <div class="sm-plugin-title-block">
              <h4 class="sm-plugin-name">{{ rule.name }}</h4>
              <span class="sm-plugin-id">{{ rule.id }}</span>
              <span class="sm-badge sm-badge-type">{{ rule.type }}</span>
              <span v-if="rule.compatibility?.family === 'xpath'" class="sm-badge sm-badge-type">开源规则</span>
              <span v-if="rule.isBuiltIn" class="sm-badge sm-badge-builtin">内置</span>
              <span v-if="!rule.enabled" class="sm-badge sm-badge-disabled">已禁用</span>
            </div>
            <div class="sm-plugin-actions">
              <button class="sm-btn sm-btn-ghost" @click="onPluginToggle(rule)">{{ rule.enabled ? '禁用' : '启用' }}</button>
              <button class="sm-btn sm-btn-secondary" :disabled="pluginTestingId === rule.id" @click="onPluginTest(rule)">
                {{ pluginTestingId === rule.id ? '检测中...' : '检测' }}
              </button>
              <button class="sm-btn sm-btn-secondary" @click="onPluginEdit(rule)">编辑</button>
              <button class="sm-btn sm-btn-ghost" :disabled="rule.isBuiltIn" @click="onPluginRemove(rule)">删除</button>
            </div>
          </div>
          <div class="sm-plugin-meta">
            <span class="sm-plugin-url" :title="rule.baseUrl">{{ rule.baseUrl }}</span>
            <span v-if="rule.health" class="sm-plugin-health">
              · 成功 {{ rule.health.successCount }} / 失败 {{ rule.health.failureCount }}
              <template v-if="rule.health.averageLatency > 0">· 平均 {{ rule.health.averageLatency }}ms</template>
            </span>
            <span
              v-if="pluginTestResults[rule.id]"
              class="sm-plugin-test-result"
              :class="{ success: pluginTestResults[rule.id].success, error: !pluginTestResults[rule.id].success }"
            >
              · {{ pluginTestResults[rule.id].message }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Phase 4: 插件规则源 JSON 编辑器 -->
    <div v-if="pluginEditorVisible" class="sm-modal-mask" @click.self="closePluginEditor">
      <div class="sm-modal sm-plugin-modal">
        <div class="sm-modal-header">
          <h3 class="sm-modal-title">{{ pluginEditorMode === 'add' ? '新增规则源' : '编辑规则源' }}</h3>
          <button class="sm-modal-close" aria-label="关闭" @click="closePluginEditor">✕</button>
        </div>
        <div class="sm-modal-body">
          <p class="sm-plugin-editor-tip">粘贴规则 JSON（结构见文档 Phase 4 规则示例）：</p>
          <textarea
            v-model="pluginEditorText"
            class="sm-plugin-editor-textarea"
            rows="18"
            spellcheck="false"
            placeholder='{"id":"example","name":"示例","type":"xpath","baseUrl":"https://...","search":{...},"detail":{...}}'
          ></textarea>
          <p v-if="pluginEditorError" class="sm-modal-test-result error">{{ pluginEditorError }}</p>
        </div>
        <div class="sm-modal-footer">
          <button class="sm-btn sm-btn-ghost" @click="closePluginEditor">取消</button>
          <button class="sm-btn sm-btn-primary" :disabled="saving" @click="onPluginSaveEditor">{{ saving ? '保存中...' : '保存' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import PageHeader from '../components/Common/PageHeader.vue';

export default {
  name: 'SourceManager',
  components: { PageHeader },
  data() {
    return {
      sources: [],
      loading: false,
      testingAll: false,
      testingId: null,
      deletingId: null,
      exporting: false,
      importing: false,
      clearingCache: false,
      installedSourcePacks: [],
      unifiedProviders: [],
      mediaTestingId: '',
      mediaTestResults: {},
      checkingPackUpdates: false,
      packUpdates: {},

      // 编辑器
      editorVisible: false,
      editorMode: 'add', // 'add' | 'edit'
      editorForm: this.emptyForm(),
      editorTestResult: null,
      testingEditor: false,
      saving: false,

      // Phase 4: 插件规则源
      pluginSources: [],
      pluginLoading: false,
      pluginTestingAll: false,
      pluginTestingId: null,
      pluginExporting: false,
      pluginImporting: false,
      pluginTestResults: {},
      pluginEditorVisible: false,
      pluginEditorMode: 'add',
      pluginEditorText: '',
      pluginEditorId: '',
      pluginEditorError: ''
    };
  },
  computed: {
    mediaProviders() {
      return this.unifiedProviders.filter(provider => provider.type === 'media');
    }
  },
  methods: {
    mediaTypeLabel(type) {
      return ({ local: '本地目录', webdav: 'WebDAV', jellyfin: 'Jellyfin', emby: 'Emby' })[type] || '媒体库';
    },

    async testMediaProvider(provider) {
      this.mediaTestingId = provider.providerId;
      try {
        const result = await window.electronAPI?.sourceProviderTest?.(provider.providerId);
        this.mediaTestResults = { ...this.mediaTestResults, [provider.providerId]: result || { success: false, message: '无返回结果' } };
      } catch (error) {
        this.mediaTestResults = { ...this.mediaTestResults, [provider.providerId]: { success: false, message: error.message } };
      } finally {
        this.mediaTestingId = '';
      }
    },
    emptyForm() {
      return {
        id: '',
        name: '',
        api: '',
        categories: [],
        defaultCategory: '',
        originalName: ''
      };
    },

    goBack() {
      this.$router.push({ name: 'settings' });
    },

    async loadSources() {
      this.loading = true;
      try {
        if (window.electronAPI && window.electronAPI.cmsMultiGetSources) {
          const list = await window.electronAPI.cmsMultiGetSources();
          // 标记 isCustom：通过对比用户配置文件来确定
          let userSourceIds = new Set();
          try {
            if (window.electronAPI.cmsExportSources) {
              const exp = await window.electronAPI.cmsExportSources();
              if (exp.success && exp.json) {
                const parsed = JSON.parse(exp.json);
                if (Array.isArray(parsed.sources)) {
                  userSourceIds = new Set(parsed.sources.map(s => s.id));
                }
              }
            }
          } catch (_) { /* 静默忽略 */ }

          this.sources = (list || []).map(s => ({
            ...s,
            isCustom: userSourceIds.has(s.id),
            lastTestMessage: s.lastTestMessage || null,
            lastTestTime: s.lastTestTime || 0
          }));
        }
      } catch (error) {
        console.error('加载数据源失败:', error);
        this.$notify?.error('错误', '加载数据源失败: ' + error.message);
      } finally {
        this.loading = false;
      }
    },

    async loadExtensionOverview() {
      const [packs, providers] = await Promise.all([
        window.electronAPI?.sourcePackList?.().catch(() => []) || [],
        window.electronAPI?.sourceProviderList?.({ includeDisabled: true }).catch(() => []) || []
      ]);
      this.installedSourcePacks = Array.isArray(packs) ? packs : [];
      this.unifiedProviders = Array.isArray(providers) ? providers : [];
    },

    async onRemoveSourcePack(pack) {
      const result = await window.electronAPI?.sourcePackRemove?.(pack.id);
      if (!result?.success) {
        this.$notify?.error('移除失败', result?.error || '无法移除片源包');
        return;
      }
      await Promise.all([this.loadSources(), this.loadPluginSources(), this.loadExtensionOverview()]);
      this.$notify?.success('片源包已移除', pack.name);
    },

    async checkSourcePackUpdates() {
      this.checkingPackUpdates = true;
      try {
        const results = await window.electronAPI?.sourcePackCheckUpdates?.() || [];
        this.packUpdates = Object.fromEntries((results || []).map(result => [result.id, result]));
        const available = (results || []).filter(result => result.updateAvailable).length;
        this.$notify?.[available ? 'success' : 'info']('片源包更新', available ? `发现 ${available} 个更新` : '当前已是最新版本');
      } finally {
        this.checkingPackUpdates = false;
      }
    },

    async updateSourcePack(pack) {
      const result = await window.electronAPI?.sourcePackUpdate?.(pack.id);
      if (!result?.success) {
        this.$notify?.error('更新失败', result?.error || '无法更新片源包');
        return;
      }
      await Promise.all([this.loadSources(), this.loadPluginSources(), this.loadExtensionOverview()]);
      await this.checkSourcePackUpdates();
      this.$notify?.success('片源包已更新', result.metadata?.name || pack.name);
    },

    statusLabel(available) {
      if (available === true) return '可用';
      if (available === false) return '不可用';
      return '未检测';
    },
    statusClass(available) {
      return {
        'sm-status-available': available === true,
        'sm-status-unavailable': available === false,
        'sm-status-unknown': available === null || available === undefined
      };
    },

    healthScore(health) {
      const score = Number(health?.score);
      return Number.isFinite(score) ? Math.round(score) : '--';
    },
    healthClass(health) {
      const score = Number(health?.score);
      return {
        'sm-health-good': !health?.coolingDown && score >= 80,
        'sm-health-warn': !health?.coolingDown && score >= 50 && score < 80,
        'sm-health-bad': health?.coolingDown || score < 50
      };
    },
    healthTitle(src) {
      const health = src?.health || {};
      const parts = [
        `健康分: ${this.healthScore(health)}`,
        `播放成功: ${health.playbackSuccessCount || 0}`,
        `播放失败: ${health.playbackFailureCount || 0}`,
        `接口失败: ${health.failureCount || 0}`
      ];
      if (health.averageLatency) parts.push(`平均延迟: ${health.averageLatency}ms`);
      if (health.playbackSessionCount) {
        parts.push(`真实播放样本: ${health.playbackSessionCount}`);
        parts.push(`平均首帧: ${health.averageStartupMs}ms`);
        parts.push(`平均卡顿: ${(Number(health.averageStallRatio || 0) * 100).toFixed(1)}%`);
        parts.push(`平均丢帧: ${(Number(health.averageDroppedFrameRatio || 0) * 100).toFixed(2)}%`);
      }
      if (health.advertisingReportCount) parts.push(`广告反馈: ${health.advertisingReportCount}`);
      if (health.reason) parts.push(`原因: ${health.reason}`);
      return parts.join('\n');
    },

    updateSourceFromTestResult(sourceId, result = {}) {
      const idx = this.sources.findIndex(s => s.id === sourceId);
      if (idx === -1) return;
      const time = Number(result.time);
      const next = {
        ...this.sources[idx],
        available: result.success === true,
        lastTestMessage: result.message || (result.success ? '连接成功' : '连接失败'),
        lastTestTime: Number.isFinite(time) && time > 0 ? Math.round(time) : 0
      };
      if (result.health) next.health = result.health;
      this.sources.splice(idx, 1, next);
    },

    async onTestOne(sourceId) {
      this.testingId = sourceId;
      try {
        if (window.electronAPI && window.electronAPI.cmsMultiSetSource) {
          await window.electronAPI.cmsMultiSetSource(sourceId);
        }
        const result = await (window.electronAPI?.cmsMultiTest
          ? window.electronAPI.cmsMultiTest()
          : Promise.resolve({ success: false, message: '无测试接口' }));
        this.updateSourceFromTestResult(sourceId, result);
        this.$notify?.[result.success ? 'success' : 'error']('源检测', result.message || (result.success ? '连接成功' : '连接失败'));
      } catch (error) {
        console.error('检测数据源失败:', error);
        this.updateSourceFromTestResult(sourceId, { success: false, message: error.message });
        this.$notify?.error('错误', '检测失败: ' + error.message);
      } finally {
        this.testingId = null;
      }
    },

    async onTestAll() {
      this.testingAll = true;
      try {
        const results = await (window.electronAPI?.cmsMultiTestAll
          ? window.electronAPI.cmsMultiTestAll()
          : Promise.resolve([]));
        if (!Array.isArray(results)) throw new Error('检测结果格式异常');
        results.filter(Boolean).forEach(r => this.updateSourceFromTestResult(r.id, r));
        const ok = results.filter(r => r?.success).length;
        const fail = results.length - ok;
        this.$notify?.[fail > 0 ? 'warning' : 'success']('源检测', `${ok} 个可用，${fail} 个异常`);
      } catch (error) {
        console.error('检测全部数据源失败:', error);
        this.$notify?.error('错误', '检测失败: ' + error.message);
      } finally {
        this.testingAll = false;
      }
    },

    async onClearCache() {
      this.clearingCache = true;
      try {
        if (window.electronAPI?.cmsCacheClear) {
          const result = await window.electronAPI.cmsCacheClear({});
          if (result?.success) {
            this.$notify?.success('成功', `已清理接口缓存 ${result.removed || 0} 条`);
          } else {
            throw new Error(result?.error || '清理失败');
          }
        } else {
          this.$notify?.warning('提示', '当前版本不支持接口缓存清理');
        }
      } catch (error) {
        console.error('清理接口缓存失败:', error);
        this.$notify?.error('错误', '清理接口缓存失败: ' + error.message);
      } finally {
        this.clearingCache = false;
      }
    },

    onAddNew() {
      this.editorMode = 'add';
      this.editorForm = this.emptyForm();
      this.editorTestResult = null;
      this.editorVisible = true;
    },

    onEdit(src) {
      this.editorMode = 'edit';
      this.editorForm = {
        id: src.id,
        name: src.name,
        api: src.api,
        categories: (src.categories || []).map(c => ({ id: c.id, name: c.name })),
        defaultCategory: src.defaultCategory || '',
        originalName: src.name
      };
      this.editorTestResult = null;
      this.editorVisible = true;
    },

    closeEditor() {
      this.editorVisible = false;
      this.editorTestResult = null;
    },

    addCategory() {
      this.editorForm.categories.push({ id: '', name: '' });
    },
    removeCategory(idx) {
      this.editorForm.categories.splice(idx, 1);
    },

    buildConfigFromForm() {
      const form = this.editorForm;
      const config = {
        id: form.id,
        name: form.name,
        api: form.api
      };
      const cats = (form.categories || [])
        .map(c => ({ id: String(c.id || '').trim(), name: String(c.name || '').trim() }))
        .filter(c => c.id && c.name);
      if (cats.length > 0) {
        config.categories = cats;
        if (form.defaultCategory) config.defaultCategory = form.defaultCategory;
      }
      return config;
    },

    async onTestEditor() {
      if (!this.editorForm.api) {
        this.$notify?.warning('提示', '请填写 API 地址');
        return;
      }
      this.testingEditor = true;
      this.editorTestResult = null;
      try {
        // 先临时保存（仅内存中切换源测试，不写入文件）
        // 这里改为：直接调用 searchInSource 风格的测试逻辑
        // 但当前 IPC 没有暴露"按 api 测试"的接口，临时方案：切换 currentSource 后测试，然后切回
        // 为了不污染当前选中源，仅在新增模式下：如果源已存在则直接测试，否则提示先保存
        const config = this.buildConfigFromForm();
        const existing = this.sources.find(s => s.id === config.id);
        if (!existing && this.editorMode === 'add') {
          this.editorTestResult = { success: false, message: '请先保存新增源，再测试连通性' };
          return;
        }
        if (window.electronAPI?.cmsMultiSetSource) {
          await window.electronAPI.cmsMultiSetSource(config.id);
        }
        const result = await (window.electronAPI?.cmsMultiTest
          ? window.electronAPI.cmsMultiTest()
          : Promise.resolve({ success: false, message: '无测试接口' }));
        this.editorTestResult = result;
      } catch (error) {
        this.editorTestResult = { success: false, message: error.message };
      } finally {
        this.testingEditor = false;
      }
    },

    async onSave() {
      const form = this.editorForm;
      if (!form.id) {
        this.$notify?.warning('提示', '请填写 ID');
        return;
      }
      if (!form.name) {
        this.$notify?.warning('提示', '请填写名称');
        return;
      }
      if (!form.api) {
        this.$notify?.warning('提示', '请填写 API 地址');
        return;
      }
      if (!/^https?:\/\//i.test(form.api)) {
        this.$notify?.warning('提示', 'API 地址必须以 http:// 或 https:// 开头');
        return;
      }

      this.saving = true;
      try {
        const config = this.buildConfigFromForm();
        const api = window.electronAPI;
        if (!api) throw new Error('无法访问主进程 API');

        let result;
        if (this.editorMode === 'add') {
          result = await api.cmsAddSource(config);
        } else {
          result = await api.cmsUpdateSource(form.id, config);
        }

        if (!result.success) {
          this.$notify?.error('保存失败', result.error || '未知错误');
          return;
        }

        // 保存成功后刷新列表
        await this.loadSources();

        // 同步：把当前主进程的 currentSource 切换到新保存的源（避免后续测试使用旧源）
        try {
          if (api.cmsMultiSetSource) await api.cmsMultiSetSource(config.id);
        } catch (_) { /* 静默 */ }

        this.$notify?.success('成功', this.editorMode === 'add' ? '数据源已添加' : '数据源已更新');
        this.closeEditor();
      } catch (error) {
        console.error('保存数据源失败:', error);
        this.$notify?.error('错误', '保存失败: ' + error.message);
      } finally {
        this.saving = false;
      }
    },

    async onRemove(src) {
      if (!src.isCustom) {
        this.$notify?.warning('提示', '默认源无法删除，可使用编辑功能覆盖');
        return;
      }
      if (this.deletingId) return;
      const confirmed = await this.$confirm({
        title: '删除数据源',
        message: `确定要删除数据源「${src.name}」吗？此操作不可撤销。`,
        confirmText: '删除',
        danger: true
      });
      if (!confirmed) return;
      this.deletingId = src.id;
      try {
        const result = await window.electronAPI.cmsRemoveSource(src.id);
        if (!result.success) {
          this.$notify?.error('删除失败', result.error || '未知错误');
          return;
        }
        await this.loadSources();
        this.$notify?.success('成功', `已删除数据源「${src.name}」`);
      } catch (error) {
        console.error('删除数据源失败:', error);
        this.$notify?.error('错误', '删除失败: ' + error.message);
      } finally {
        this.deletingId = null;
      }
    },

    async onExportFile() {
      this.exporting = true;
      try {
        const result = await window.electronAPI?.sourcePackExportFile?.({
          id: 'my-sakurafall-sources',
          name: '我的SAKURAFALL片源包'
        });
        if (!result || result.canceled) return;
        if (!result.success) throw new Error(result.error || '无法导出');
        this.$notify?.success('片源包已导出', `共 ${result.count} 项配置`);
      } catch (error) {
        console.error('导出片源包失败:', error);
        this.$notify?.error('错误', '导出失败: ' + error.message);
      } finally {
        this.exporting = false;
      }
    },

    async onImportFile() {
      this.importing = true;
      try {
        const result = await window.electronAPI?.sourcePackImportFile?.({ overwrite: true });
        if (!result || result.canceled) return;
        if (!result.success) throw new Error(result.error || '源包内容无效');

        await Promise.all([this.loadSources(), this.loadPluginSources(), this.loadExtensionOverview()]);
        const added = (result.cms?.added || 0) + (result.xpath?.added || 0);
        const overwritten = (result.cms?.overwritten || 0) + (result.xpath?.overwritten || 0);
        const skipped = (result.cms?.skipped || 0) + (result.xpath?.skipped || 0);
        this.$notify?.success('片源包已安装', `新增 ${added}，覆盖 ${overwritten}，跳过 ${skipped}`);
      } catch (error) {
        console.error('导入片源包失败:', error);
        this.$notify?.error('错误', '导入失败: ' + error.message);
      } finally {
        this.importing = false;
      }
    },

    // ===== Phase 4: 插件规则源 =====
    async loadPluginSources() {
      this.pluginLoading = true;
      try {
        this.pluginSources = await window.electronAPI.pluginGetList();
      } catch (e) {
        this.$notify?.error('错误', '加载插件源失败: ' + e.message);
      } finally {
        this.pluginLoading = false;
      }
    },

    async onPluginTest(rule) {
      this.pluginTestingId = rule.id;
      try {
        const result = await window.electronAPI.pluginTest(rule.id);
        this.pluginTestResults = Object.assign({}, this.pluginTestResults, { [rule.id]: result });
        await this.loadPluginSources(); // 刷新健康度
      } catch (e) {
        this.pluginTestResults = Object.assign({}, this.pluginTestResults, {
          [rule.id]: { success: false, message: e.message || String(e) }
        });
      } finally {
        this.pluginTestingId = null;
      }
    },

    async onPluginTestAll() {
      this.pluginTestingAll = true;
      try {
        const results = await window.electronAPI.pluginTestAll();
        const map = {};
        for (const r of results) map[r.sourceId] = r;
        this.pluginTestResults = map;
        await this.loadPluginSources();
      } catch (e) {
        this.$notify?.error('错误', '批量检测失败: ' + e.message);
      } finally {
        this.pluginTestingAll = false;
      }
    },

    async onPluginToggle(rule) {
      try {
        await window.electronAPI.pluginSetEnabled(rule.id, !rule.enabled);
        await this.loadPluginSources();
      } catch (e) {
        this.$notify?.error('错误', '切换状态失败: ' + e.message);
      }
    },

    async onPluginRemove(rule) {
      const confirmed = await this.$confirm({
        title: '删除规则源',
        message: `确认删除规则源「${rule.name}」？`,
        confirmText: '删除',
        danger: true
      });
      if (!confirmed) return;
      try {
        const result = await window.electronAPI.pluginRemove(rule.id);
        if (!result.success) {
          this.$notify?.error('错误', result.error || '删除失败');
          return;
        }
        await this.loadPluginSources();
      } catch (e) {
        this.$notify?.error('错误', '删除失败: ' + e.message);
      }
    },

    async onPluginImportFile() {
      try {
        const loadResult = await window.electronAPI.pluginLoadFile();
        if (!loadResult.success || loadResult.canceled) return;
        this.pluginImporting = true;
        const importResult = await window.electronAPI.pluginImport(loadResult.content, { overwrite: true });
        if (!importResult.success) {
          this.$notify?.error('错误', importResult.error || '导入失败');
          return;
        }
        const msg = `新增 ${importResult.added}，覆盖 ${importResult.overwritten}，跳过 ${importResult.skipped}`;
        if (importResult.errors && importResult.errors.length > 0) {
          this.$notify?.warning('部分导入', msg + '\n' + importResult.errors.join('\n'));
        } else {
          this.$notify?.success('导入成功', msg);
        }
        await this.loadPluginSources();
      } catch (e) {
        this.$notify?.error('错误', '导入失败: ' + e.message);
      } finally {
        this.pluginImporting = false;
      }
    },

    async onPluginImportInstalledRules() {
      this.pluginImporting = true;
      try {
        const result = await window.electronAPI.pluginImportInstalledRules();
        if (!result.success) {
          this.$notify?.error('导入失败', result.error || '无法读取开源片源规则');
          return;
        }
        await this.loadPluginSources();
        this.$notify?.success(
          '开源片源规则已导入',
          `新增 ${result.added}，覆盖 ${result.overwritten}，跳过 ${result.skipped}`
        );
      } catch (e) {
        this.$notify?.error('导入失败', e.message || String(e));
      } finally {
        this.pluginImporting = false;
      }
    },

    async onPluginExportFile() {
      try {
        const result = await window.electronAPI.pluginSaveFile('plugin-sources.json');
        if (!result.success) {
          if (!result.canceled) this.$notify?.error('错误', result.error || '导出失败');
          return;
        }
        this.pluginExporting = true;
        this.$notify?.success('导出成功', `已导出 ${result.count} 个规则源到 ${result.filePath}`);
      } catch (e) {
        this.$notify?.error('错误', '导出失败: ' + e.message);
      } finally {
        this.pluginExporting = false;
      }
    },

    onPluginAddNew() {
      this.pluginEditorMode = 'add';
      this.pluginEditorId = '';
      this.pluginEditorText = JSON.stringify({
        id: '',
        name: '',
        type: 'xpath',
        version: '1.0.0',
        enabled: true,
        baseUrl: 'https://',
        headers: { 'Referer': '@baseUrl' },
        search: { url: '/search?keyword=@keyword', method: 'GET', list: '', name: '', urlPath: '', cover: '' },
        detail: null
      }, null, 2);
      this.pluginEditorError = '';
      this.pluginEditorVisible = true;
    },

    onPluginEdit(rule) {
      this.pluginEditorMode = 'edit';
      this.pluginEditorId = rule.id;
      window.electronAPI.pluginGetDetail(rule.id).then(detail => {
        if (detail) {
          this.pluginEditorText = JSON.stringify(detail, null, 2);
          this.pluginEditorError = '';
          this.pluginEditorVisible = true;
        } else {
          this.$notify?.error('错误', '获取规则详情失败');
        }
      }).catch(e => this.$notify?.error('错误', e.message));
    },

    closePluginEditor() {
      this.pluginEditorVisible = false;
      this.pluginEditorText = '';
      this.pluginEditorError = '';
      this.pluginEditorId = '';
    },

    async onPluginSaveEditor() {
      this.pluginEditorError = '';
      let raw;
      try {
        raw = JSON.parse(this.pluginEditorText);
      } catch (e) {
        this.pluginEditorError = 'JSON 解析失败: ' + e.message;
        return;
      }
      this.saving = true;
      try {
        const result = this.pluginEditorMode === 'add'
          ? await window.electronAPI.pluginAdd(raw)
          : await window.electronAPI.pluginUpdate(this.pluginEditorId, raw);
        if (!result.success) {
          this.pluginEditorError = result.error || '保存失败';
          return;
        }
        this.closePluginEditor();
        await this.loadPluginSources();
        this.$notify?.success('成功', this.pluginEditorMode === 'add' ? '规则源已添加' : '规则源已更新');
      } catch (e) {
        this.pluginEditorError = e.message || String(e);
      } finally {
        this.saving = false;
      }
    }
  },
  async mounted() {
    await Promise.all([this.loadSources(), this.loadPluginSources(), this.loadExtensionOverview()]);
  }
};
</script>

<style scoped>
.sm-pack-band {
  margin: 14px 0 18px;
  padding: 12px 14px;
  border-block: 1px solid var(--border-color);
  background: color-mix(in srgb, var(--bg-surface) 90%, var(--accent-cyan) 10%);
}

.sm-pack-heading,
.sm-pack-item {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sm-pack-heading { justify-content: space-between; margin-bottom: 10px; }
.sm-pack-heading > div,
.sm-pack-item > div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.sm-pack-heading small,
.sm-pack-item small,
.sm-pack-heading > span { color: var(--text-tertiary); font-size: 11px; }
.sm-pack-list { display: flex; flex-wrap: wrap; gap: 8px; }
.sm-pack-item { min-width: 260px; flex: 1 1 320px; padding: 8px 10px; border-left: 3px solid var(--accent-cyan); background: var(--bg-card-glass); }
.sm-pack-item > div { margin-right: auto; }
.sm-pack-empty { padding: 8px 0; color: var(--text-tertiary); font-size: 12px; }

.source-manager {
  padding: 20px;
  max-width: 960px;
  margin: 0 auto;
  color: var(--text-primary);
}

/* 顶栏（结构统一使用 Common/PageHeader，仅保留计数样式） */
.sm-subtitle {
  font-size: 13px;
  color: var(--text-secondary);
}

/* 通用按钮 */
.sm-btn {
  padding: 8px 14px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  border: none;
  transition: background-color 0.2s var(--ease-smooth), color 0.2s var(--ease-smooth), opacity 0.2s var(--ease-smooth), transform 0.2s var(--ease-smooth);
  white-space: nowrap;
}
.sm-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.sm-btn-mini {
  padding: 5px 10px;
  font-size: 12px;
}
.sm-btn-primary {
  background: var(--primary-color);
  color: var(--text-inverse);
}
.sm-btn-primary:hover:not(:disabled) {
  background: var(--primary-hover);
}
.sm-btn-secondary {
  background: var(--bg-input);
  color: var(--text-primary);
  border: 1px solid var(--border-color-strong);
}
.sm-btn-secondary:hover:not(:disabled) {
  background: var(--border-color);
}
.sm-btn-ghost {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid transparent;
}
.sm-btn-ghost:hover:not(:disabled) {
  color: var(--primary-color);
  background: var(--primary-lighter);
}
.sm-btn-danger {
  background: rgba(255, 68, 68, 0.12);
  color: var(--error-color);
}
.sm-btn-danger:hover:not(:disabled) {
  background: rgba(255, 68, 68, 0.22);
}

/* 提示条 */
.sm-tip {
  display: flex;
  gap: 10px;
  padding: 12px 16px;
  background: var(--primary-lighter);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  margin-bottom: 16px;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
}
.sm-tip-icon {
  min-width: 34px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border-radius: 4px;
  background: var(--brand-ink);
  color: #fff;
  font-family: 'Segoe UI', sans-serif;
  font-size: 8px;
  font-weight: 800;
}
.sm-tip-text code {
  background: var(--bg-input);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 12px;
  color: var(--text-primary);
}

/* 加载中 */
.sm-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 60px 0;
}
.sm-loading-bubble {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 12px 20px;
  background: var(--bg-surface);
  border-radius: 8px;
  color: var(--text-secondary);
  font-size: 14px;
  box-shadow: var(--shadow-sm);
}
.sm-loading-bubble i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--primary-color);
  animation: sm-bounce 1.2s infinite ease-in-out;
}
.sm-loading-bubble i:nth-child(2) { animation-delay: 0.15s; }
.sm-loading-bubble i:nth-child(3) { animation-delay: 0.3s; }
@keyframes sm-bounce {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}

/* 源列表 */
.sm-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.sm-card {
  padding: 16px 18px;
  background: var(--bg-surface);
  border-radius: 14px;
  border: 1px solid var(--border-color);
  box-shadow: var(--shadow-sm);
  transition: border-color 0.2s var(--ease-smooth), box-shadow 0.2s var(--ease-smooth);
}
.sm-card:hover {
  border-color: var(--border-color-strong);
  box-shadow: var(--shadow-md);
}
.sm-card-bad {
  border-color: rgba(255, 68, 68, 0.35);
}
.sm-card-cooldown {
  border-color: rgba(255, 193, 7, 0.35);
}

.sm-card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.sm-card-title-block {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.sm-card-title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 360px;
}

.sm-card-real-name {
  font-size: 12px;
  color: var(--text-tertiary);
}

.sm-card-badges {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.sm-badge {
  padding: 3px 10px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.sm-badge-health.sm-health-good {
  background: rgba(40, 167, 69, 0.16);
  color: #2dd573;
}
.sm-badge-health.sm-health-warn {
  background: rgba(240, 160, 32, 0.18);
  color: #f4bf45;
}
.sm-badge-health.sm-health-bad,
.sm-badge-cooldown {
  background: rgba(255, 68, 68, 0.16);
  color: #ff8a8a;
}

.sm-badge-status.sm-status-available {
  background: var(--success-color);
  color: var(--text-inverse);
}
.sm-badge-status.sm-status-unavailable {
  background: var(--error-color);
  color: var(--text-inverse);
}
.sm-badge-status.sm-status-unknown {
  background: var(--border-color-strong);
  color: var(--text-tertiary);
}

.sm-badge-custom {
  background: rgba(66, 199, 238, 0.16);
  color: var(--accent-cyan);
}
.sm-badge-default {
  background: var(--border-color);
  color: var(--text-secondary);
}

.sm-card-meta {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}

.sm-meta-row {
  display: flex;
  gap: 10px;
  font-size: 13px;
  align-items: flex-start;
}

.sm-meta-label {
  flex: 0 0 60px;
  color: var(--text-tertiary);
  font-size: 12px;
  padding-top: 1px;
}

.sm-meta-value {
  color: var(--text-primary);
  word-break: break-all;
}

.sm-meta-id,
.sm-meta-api {
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 12px;
  background: var(--bg-input);
  padding: 2px 6px;
  border-radius: 4px;
}

.sm-meta-categories {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  flex: 1;
}

.sm-category-tag {
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--primary-lighter);
  color: var(--primary-color);
  font-size: 11px;
  font-weight: 600;
}

.sm-meta-test-row.sm-meta-test-error .sm-meta-value {
  color: var(--error-color);
}

.sm-card-actions {
  display: flex;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--divider-color);
}

/* 空状态 */
.sm-empty {
  text-align: center;
  padding: 80px 20px;
  color: var(--text-secondary);
}
.sm-empty-icon {
  font-size: 56px;
  margin-bottom: 16px;
}
.sm-empty h3 {
  margin: 0 0 8px;
  color: var(--text-primary);
  font-size: 18px;
}
.sm-empty p {
  margin: 0;
  font-size: 13px;
}

/* 弹窗 */
.sm-modal-mask {
  position: fixed;
  inset: 0;
  background: var(--bg-overlay);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 9999;
  padding: 20px;
  backdrop-filter: blur(2px);
}

.sm-modal {
  width: 100%;
  max-width: 560px;
  max-height: 90vh;
  overflow-y: auto;
  background: var(--bg-surface);
  border-radius: 16px;
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
}

.sm-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--divider-color);
}
.sm-modal-header h3 {
  margin: 0;
  font-size: 17px;
  color: var(--text-primary);
}
.sm-modal-close {
  background: transparent;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  font-size: 16px;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.2s var(--ease-smooth), color 0.2s var(--ease-smooth);
}
.sm-modal-close:hover {
  background: var(--primary-light);
  color: var(--text-primary);
}

.sm-modal-body {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  flex: 1;
  overflow-y: auto;
}

.sm-form-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sm-form-label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.sm-form-label-text {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.sm-req {
  color: var(--error-color);
}

.sm-form-input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border-color-strong);
  border-radius: 8px;
  font-size: 13px;
  background: var(--bg-input);
  color: var(--text-primary);
  transition: border-color 0.2s var(--ease-smooth), box-shadow 0.2s var(--ease-smooth);
  font-family: inherit;
}
.sm-form-input:focus {
  outline: none;
  border-color: var(--primary-color);
  box-shadow: 0 0 0 3px var(--primary-light);
}
.sm-form-input:disabled {
  background: var(--border-color);
  color: var(--text-tertiary);
  cursor: not-allowed;
}

.sm-form-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.4;
}
.sm-form-hint code {
  background: var(--bg-input);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 11px;
}

.sm-form-empty {
  padding: 10px 12px;
  font-size: 12px;
  color: var(--text-tertiary);
  background: var(--primary-lighter);
  border-radius: 8px;
  border: 1px dashed var(--border-color-strong);
}

.sm-category-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sm-category-edit-row {
  display: flex;
  gap: 8px;
}

.sm-cat-id {
  flex: 0 0 120px;
}
.sm-cat-name {
  flex: 1;
}

.sm-modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 20px;
  border-top: 1px solid var(--divider-color);
}

.sm-modal-test-result {
  margin: 0;
  padding: 8px 20px 14px;
  font-size: 12px;
  line-height: 1.5;
}
.sm-modal-test-result.success {
  color: var(--success-color);
}
.sm-modal-test-result.error {
  color: var(--error-color);
}

@media (max-width: 768px) {
  .source-manager {
    padding: 12px;
  }
  :deep(.page-header-actions) {
    justify-content: stretch;
  }
  :deep(.page-header-actions) .sm-btn {
    flex: 1;
  }
  .sm-card-header {
    flex-direction: column;
    align-items: flex-start;
  }
  .sm-meta-row {
    flex-direction: column;
    gap: 4px;
  }
  .sm-meta-label {
    flex: 0 0 auto;
  }
  .sm-category-edit-row {
    flex-wrap: wrap;
  }
  .sm-cat-id {
    flex: 1 1 100px;
  }
}

/* ===== Phase 4: 插件规则源 ===== */
.sm-plugin-section {
  margin-top: 32px;
  padding-top: 20px;
  border-top: 1px dashed var(--border-color, rgba(0,0,0,0.08));
}

.sm-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.sm-section-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary, #1f2937);
}

.sm-section-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 20px;
  margin-right: 5px;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--brand-ink);
  color: #fff;
  font-family: 'Segoe UI', sans-serif;
  font-size: 8px;
  font-weight: 800;
  vertical-align: 2px;
}

.sm-section-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.sm-plugin-tip {
  margin: 0 0 16px;
  font-size: 12px;
  color: var(--text-tertiary, #6b7280);
  line-height: 1.6;
}

.sm-plugin-tip code,
.sm-plugin-id {
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 11px;
  background: var(--bg-elevated, rgba(0,0,0,0.04));
  padding: 1px 6px;
  border-radius: 4px;
}

.sm-empty {
  text-align: center;
  padding: 32px 16px;
  color: var(--text-tertiary, #9ca3af);
  font-size: 13px;
}

.sm-plugin-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sm-plugin-card {
  border: 1px solid var(--border-color, rgba(0,0,0,0.08));
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--bg-card, #fff);
  transition: border-color 0.2s, opacity 0.2s;
}

.sm-plugin-card:hover {
  border-color: var(--primary-color, #fb7299);
}

.sm-plugin-disabled {
  opacity: 0.55;
}

.sm-plugin-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.sm-plugin-title-block {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.sm-plugin-name {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, #1f2937);
}

.sm-plugin-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.sm-plugin-meta {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-tertiary, #6b7280);
  word-break: break-all;
}

.sm-plugin-url {
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 11px;
}

.sm-plugin-test-result.success {
  color: #10b981;
}

.sm-plugin-test-result.error {
  color: #ef4444;
}

.sm-badge-type {
  background: rgba(66, 199, 238, 0.12);
  color: #42c7ee;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  text-transform: uppercase;
  font-weight: 600;
}

.sm-badge-builtin {
  background: rgba(251, 191, 36, 0.15);
  color: #d97706;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
}

.sm-badge-disabled {
  background: rgba(107, 114, 128, 0.15);
  color: #6b7280;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
}

.sm-plugin-modal {
  max-width: 640px;
  width: 90%;
}

.sm-plugin-modal .sm-modal-body {
  padding: 16px 20px;
}

.sm-plugin-editor-tip {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--text-secondary, #4b5563);
}

.sm-plugin-editor-textarea {
  width: 100%;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.5;
  padding: 10px 12px;
  border: 1px solid var(--border-color, rgba(0,0,0,0.1));
  border-radius: 8px;
  background: var(--bg-elevated, #f9fafb);
  color: var(--text-primary, #1f2937);
  resize: vertical;
  outline: none;
  transition: border-color 0.2s;
}

.sm-plugin-editor-textarea:focus {
  border-color: var(--primary-color, #fb7299);
}
</style>
