<template>
  <div class="dna-overlay" @click.self="$emit('close')">
    <section class="dna-panel" aria-label="Episode DNA 片段标记">
      <header class="dna-header">
        <div>
          <span class="dna-kicker">EPISODE DNA</span>
          <h3>剧集片段</h3>
          <p>{{ identity.episodeTitle || identity.animeTitle || '当前剧集' }}</p>
        </div>
        <button type="button" class="dna-icon-btn" title="关闭" @click="$emit('close')">×</button>
      </header>

      <!-- 手动标记：选类型 → 标起点 → 标终点 → 确认保存 -->
      <div class="dna-compose">
        <div class="dna-kinds" role="radiogroup" aria-label="片段类型">
          <button
            v-for="option in kindOptions"
            :key="option.value"
            type="button"
            class="dna-kind"
            :class="[{ active: draftKind === option.value }, { filled: Boolean(getSegment(option.value)) }]"
            role="radio"
            :aria-checked="draftKind === option.value"
            @click="draftKind = option.value"
          >{{ option.label }}</button>
        </div>
        <div class="dna-mark-row">
          <button
            type="button"
            class="dna-mark-btn"
            :disabled="marking"
            @click="markPoint('start')"
          >{{ draftStart != null ? `起点 ${formatTime(draftStart)}` : '标记起点' }}</button>
          <span class="dna-arrow">→</span>
          <button
            type="button"
            class="dna-mark-btn"
            :disabled="draftStart == null || marking"
            @click="markPoint('end')"
          >{{ draftEnd != null ? `终点 ${formatTime(draftEnd)}` : '标记终点' }}</button>
          <button
            type="button"
            class="dna-save"
            :disabled="draftStart == null || draftEnd == null || saving"
            @click="saveSegment"
          >{{ saving ? '保存中' : '确认保存' }}</button>
        </div>
        <p v-if="draftStart != null && draftEnd != null && draftEnd - draftStart < 0.5" class="dna-hint is-error">
          片段至少需要 0.5 秒，请调整起点/终点。
        </p>
        <p v-else-if="message" class="dna-hint" :class="{ 'is-error': messageIsError }">{{ message }}</p>
      </div>

      <!-- DNA 分析候选（音频能量 + 场景切换，仅建议） -->
      <div v-if="dnaCandidates.length > 0" class="dna-candidates">
        <div class="dna-section-title">DNA 候选片头<span>仅建议，确认后生效</span></div>
        <button
          v-for="(candidate, index) in dnaCandidates"
          :key="index"
          type="button"
          class="dna-candidate"
          @click="applyCandidate(candidate)"
        >
          <span class="dna-candidate-range">{{ formatTime(candidate.start) }} - {{ formatTime(candidate.end) }}</span>
          <span class="dna-candidate-meta">{{ candidateReasonLabel(candidate.reason) }} · 置信度 {{ Math.round((candidate.confidence || 0) * 100) }}%</span>
        </button>
      </div>

      <!-- 已保存片段 -->
      <div v-if="loading" class="dna-state">正在读取片段...</div>
      <div v-else-if="error" class="dna-state is-error">{{ error }}</div>
      <div v-else-if="segments.length === 0" class="dna-empty">
        <strong>这一集还没有标记片段</strong>
        <span>标记片头/片尾后，同一作品三集稳定确认将自动升级为跳过规则。</span>
      </div>
      <ol v-else class="dna-list">
        <li v-for="segment in segments" :key="segment.id">
          <button type="button" class="dna-jump" title="跳到片段起点" @click="$emit('seek', segment.start)">
            {{ kindLabel(segment.kind) }}
          </button>
          <div class="dna-segment">
            <p>{{ formatTime(segment.start) }} - {{ formatTime(segment.end) }}</p>
            <small>{{ segment.origin === 'dna' ? 'DNA 确认' : '手动标记' }} · {{ formatDate(segment.updated_at) }}</small>
          </div>
          <button type="button" class="dna-remove dna-icon-btn" title="删除" @click="removeSegment(segment)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"/>
            </svg>
          </button>
        </li>
      </ol>

      <footer class="dna-footer">
        <div v-if="autoSkipRule" class="dna-rule">
          <span class="dna-rule-badge">已升级</span>
          <span>本作品已确认 {{ autoSkipRule.episodeCount }} 集片头稳定（{{ formatTime(autoSkipRule.start) }}-{{ formatTime(autoSkipRule.end) }}），播放时自动跳过。</span>
        </div>
        <div v-else class="dna-rule is-pending">
          <span>确认 3 集稳定片头后自动跳过 · 当前 {{ confirmedIntroCount }}/{{ 3 }}</span>
        </div>
      </footer>
    </section>
  </div>
</template>

<script>
export default {
  name: 'EpisodeDnaPanel',
  emits: ['close', 'seek', 'changed', 'rule-updated'],
  props: {
    identity: { type: Object, required: true },
    currentTime: { type: Number, default: 0 },
    duration: { type: Number, default: 0 },
    sourceId: { type: String, default: '' },
    dnaCandidates: { type: Array, default: () => [] }
  },
  data() {
    return {
      segments: [],
      autoSkipRule: null,
      draftKind: 'intro',
      draftStart: null,
      draftEnd: null,
      appliedCandidate: false,
      loading: true,
      saving: false,
      marking: false,
      error: '',
      message: '',
      messageIsError: false,
      kindOptions: [
        { value: 'intro', label: '片头' },
        { value: 'outro', label: '片尾' },
        { value: 'ad', label: '广告' },
        { value: 'highlight', label: '名场面' }
      ]
    };
  },
  computed: {
    confirmedIntroCount() {
      return this.autoSkipRule ? this.autoSkipRule.episodeCount : this.introConfirmedCount;
    },
    introConfirmedCount() {
      // 本集已确认片头时至少计 1；作品级计数在保存后由 rule 更新
      return this.segments.some(segment => segment.kind === 'intro' && segment.confirmed) ? 1 : 0;
    }
  },
  mounted() {
    this.loadSegments();
  },
  methods: {
    getSegment(kind) {
      return this.segments.find(segment => segment.kind === kind) || null;
    },
    async loadSegments() {
      this.loading = true;
      this.error = '';
      try {
        this.segments = await window.electronAPI?.episodeSegmentList?.(this.identity.key) || [];
        await this.loadRule();
      } catch (error) {
        this.error = error.message || '片段读取失败';
      } finally {
        this.loading = false;
      }
    },
    async loadRule() {
      try {
        this.autoSkipRule = await window.electronAPI?.episodeSegmentAutoSkipRule?.(
          this.identity.bgmId,
          this.identity.workKey
        ) || null;
      } catch (_) {
        this.autoSkipRule = null;
      }
    },
    markPoint(which) {
      this.appliedCandidate = false; // 手动打点视为用户标记
      const value = Math.max(0, Number(this.currentTime) || 0);
      if (which === 'start') {
        this.draftStart = value;
        if (this.draftEnd != null && this.draftEnd <= value) this.draftEnd = null;
      } else {
        this.draftEnd = Math.max(this.draftStart || 0, value);
      }
    },
    applyCandidate(candidate) {
      this.draftKind = 'intro';
      this.draftStart = Number(candidate.start) || 0;
      this.draftEnd = Number(candidate.end) || 0;
      this.appliedCandidate = true;
      this.showMessage(`已填入候选 ${this.formatTime(this.draftStart)} - ${this.formatTime(this.draftEnd)}，确认后保存`, false);
    },
    async saveSegment() {
      if (this.saving) return;
      if (this.draftStart == null || this.draftEnd == null) return;
      if (this.draftEnd - this.draftStart < 0.5) {
        this.showMessage('片段至少需要 0.5 秒', true);
        return;
      }
      this.saving = true;
      this.error = '';
      this.message = '';
      try {
        const result = await window.electronAPI?.episodeSegmentSave?.({
          episode_key: this.identity.key,
          work_key: this.identity.workKey,
          bgm_id: this.identity.bgmId,
          anime_name: this.identity.animeTitle,
          episode_number: this.identity.episodeNumber,
          episode_title: this.identity.episodeTitle,
          kind: this.draftKind,
          start: this.draftStart,
          end: this.draftEnd,
          confirmed: true,
          origin: this.appliedCandidate ? 'dna' : 'user',
          source_id: this.sourceId
        });
        if (!result || result.error) throw new Error(result?.error || '片段保存失败');
        if (result.autoSkipRule) {
          this.showMessage('已保存，且本作品片头规则已升级为自动跳过', false);
          this.$emit('rule-updated', result.autoSkipRule);
        } else {
          this.showMessage('片段已保存', false);
        }
        this.draftStart = null;
        this.draftEnd = null;
        this.appliedCandidate = false;
        await this.loadSegments();
        this.$emit('changed');
      } catch (error) {
        this.showMessage(error.message || '片段保存失败', true);
      } finally {
        this.saving = false;
      }
    },
    async removeSegment(segment) {
      const result = await window.electronAPI?.episodeSegmentRemove?.(segment.id);
      if (result?.changes > 0) {
        this.segments = this.segments.filter(item => item.id !== segment.id);
        await this.loadRule();
        this.$emit('changed');
      }
    },
    kindLabel(value) {
      const found = this.kindOptions.find(option => option.value === value);
      return found ? found.label : value;
    },
    candidateReasonLabel(reason) {
      if (reason === 'audio-energy') return '音频能量';
      if (reason === 'scene-change') return '场景切换';
      return '综合';
    },
    showMessage(text, isError) {
      this.message = text;
      this.messageIsError = Boolean(isError);
    },
    formatTime(value) {
      const total = Math.max(0, Math.floor(Number(value) || 0));
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
        : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    },
    formatDate(value) {
      const date = new Date(Number(value) || Date.now());
      return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    }
  }
};
</script>

<style scoped>
.dna-overlay {
  position: absolute;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(12, 8, 12, 0.45);
  backdrop-filter: blur(4px);
}

.dna-panel {
  width: min(420px, calc(100% - 48px));
  max-height: min(560px, calc(100% - 64px));
  display: flex;
  flex-direction: column;
  border-radius: 16px;
  background: rgba(28, 20, 26, 0.96);
  border: 1px solid rgba(255, 137, 177, 0.24);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.4);
  overflow: hidden;
}

.dna-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 16px 18px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
}

.dna-kicker {
  font-size: 10px;
  letter-spacing: 0.22em;
  color: rgba(255, 137, 177, 0.85);
}

.dna-header h3 { margin: 4px 0 2px; font-size: 17px; color: rgba(255, 255, 255, 0.94); }
.dna-header p { margin: 0; font-size: 12px; color: rgba(255, 255, 255, 0.45); }

.dna-icon-btn {
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.6);
  cursor: pointer;
  transition: background-color 160ms var(--ease-smooth, ease);
}

.dna-icon-btn:hover { background: rgba(255, 255, 255, 0.12); color: rgba(255, 255, 255, 0.9); }

.dna-compose { padding: 14px 18px; border-bottom: 1px solid rgba(255, 255, 255, 0.07); }

.dna-kinds { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }

.dna-kind {
  padding: 4px 12px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.05);
  color: rgba(255, 255, 255, 0.7);
  font-size: 12px;
  cursor: pointer;
  transition: all 160ms var(--ease-smooth, ease);
}

.dna-kind:hover { border-color: rgba(255, 137, 177, 0.4); }

.dna-kind.active {
  background: rgba(255, 137, 177, 0.2);
  border-color: rgba(255, 137, 177, 0.55);
  color: #ffd9e6;
}

.dna-kind.filled::after {
  content: ' ·';
  color: rgba(255, 137, 177, 0.8);
}

.dna-mark-row { display: flex; align-items: center; gap: 8px; }

.dna-mark-btn {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  border-radius: 9px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.05);
  color: rgba(255, 255, 255, 0.8);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  transition: all 160ms var(--ease-smooth, ease);
}

.dna-mark-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.dna-mark-btn:not(:disabled):hover { border-color: rgba(255, 137, 177, 0.45); }

.dna-arrow { color: rgba(255, 255, 255, 0.3); font-size: 12px; }

.dna-save {
  flex: none;
  padding: 7px 14px;
  border-radius: 9px;
  border: 1px solid rgba(255, 137, 177, 0.55);
  background: rgba(255, 137, 177, 0.24);
  color: #ffd9e6;
  font-size: 12px;
  cursor: pointer;
  transition: all 160ms var(--ease-smooth, ease);
}

.dna-save:disabled { opacity: 0.45; cursor: not-allowed; }
.dna-save:not(:disabled):hover { background: rgba(255, 137, 177, 0.36); }

.dna-hint { margin: 8px 0 0; font-size: 11px; color: rgba(255, 255, 255, 0.55); }
.dna-hint.is-error { color: rgba(255, 130, 130, 0.9); }

.dna-candidates { padding: 12px 18px; border-bottom: 1px solid rgba(255, 255, 255, 0.07); }

.dna-section-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.85);
  margin-bottom: 8px;
}

.dna-section-title span { font-size: 10px; color: rgba(255, 255, 255, 0.4); }

.dna-candidate {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  margin-bottom: 6px;
  border-radius: 9px;
  border: 1px dashed rgba(255, 137, 177, 0.35);
  background: rgba(255, 137, 177, 0.06);
  color: rgba(255, 255, 255, 0.85);
  cursor: pointer;
  text-align: left;
  transition: all 160ms var(--ease-smooth, ease);
}

.dna-candidate:hover { background: rgba(255, 137, 177, 0.14); }

.dna-candidate-range { font-size: 13px; color: #ffd9e6; }
.dna-candidate-meta { font-size: 10px; color: rgba(255, 255, 255, 0.45); }

.dna-state, .dna-empty { padding: 22px 18px; text-align: center; font-size: 12px; color: rgba(255, 255, 255, 0.5); }
.dna-state.is-error { color: rgba(255, 130, 130, 0.9); }

.dna-empty { display: flex; flex-direction: column; gap: 6px; }
.dna-empty strong { color: rgba(255, 255, 255, 0.8); font-size: 13px; }
.dna-empty span { font-size: 11px; line-height: 1.6; }

.dna-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0;
  padding: 8px 12px;
  list-style: none;
}

.dna-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 6px;
  border-radius: 10px;
  transition: background-color 160ms var(--ease-smooth, ease);
}

.dna-list li:hover { background: rgba(255, 255, 255, 0.05); }

.dna-jump {
  flex: none;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid rgba(255, 137, 177, 0.4);
  background: rgba(255, 137, 177, 0.12);
  color: #ffd9e6;
  font-size: 11px;
  cursor: pointer;
}

.dna-segment { flex: 1; min-width: 0; }
.dna-segment p { margin: 0; font-size: 12px; color: rgba(255, 255, 255, 0.88); }
.dna-segment small { font-size: 10px; color: rgba(255, 255, 255, 0.4); }

.dna-remove { flex: none; }

.dna-footer {
  padding: 10px 18px;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
  font-size: 11px;
  color: rgba(255, 255, 255, 0.55);
}

.dna-rule { display: flex; align-items: center; gap: 8px; line-height: 1.5; }

.dna-rule.is-pending { color: rgba(255, 255, 255, 0.4); }

.dna-rule-badge {
  flex: none;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(255, 137, 177, 0.22);
  border: 1px solid rgba(255, 137, 177, 0.5);
  color: #ffd9e6;
  font-size: 10px;
}
</style>
