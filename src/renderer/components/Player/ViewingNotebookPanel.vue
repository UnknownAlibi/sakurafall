<template>
  <div class="notebook-overlay" @click.self="$emit('close')">
    <section class="notebook-panel" aria-label="樱月手帐">
      <header class="notebook-header">
        <div>
          <span class="notebook-kicker">YINGYUE NOTES</span>
          <h3>樱月手帐</h3>
          <p>{{ identity.episodeTitle || identity.animeTitle || '当前剧集' }}</p>
        </div>
        <button type="button" class="notebook-icon-btn" title="关闭" @click="$emit('close')">×</button>
      </header>

      <div class="notebook-compose">
        <div class="notebook-time">{{ formatTime(currentTime) }}</div>
        <textarea
          v-model="draft"
          maxlength="1000"
          rows="2"
          placeholder="记下这一刻的台词、伏笔或感想..."
          @keydown.ctrl.enter.prevent="addNote"
        ></textarea>
        <div class="notebook-categories" role="radiogroup" aria-label="时光签分类">
          <button
            v-for="option in categoryOptions"
            :key="option.value"
            type="button"
            class="notebook-category"
            :class="[`is-${option.value || 'plain'}`, { active: draftCategory === option.value }]"
            role="radio"
            :aria-checked="draftCategory === option.value"
            @click="draftCategory = option.value"
          >{{ option.label }}</button>
        </div>
        <button type="button" class="notebook-save" :disabled="saving" @click="addNote">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
          </svg>
          {{ saving ? '记录中' : '留下时光签' }}
        </button>
      </div>

      <div v-if="loading" class="notebook-state">正在翻阅手帐...</div>
      <div v-else-if="error" class="notebook-state is-error">{{ error }}</div>
      <div v-else-if="notes.length === 0" class="notebook-empty">
        <strong>这一集还没有时光签</strong>
        <span>播放到喜欢的画面时，在上面留下一句吧。</span>
      </div>
      <ol v-else class="notebook-list">
        <li v-for="note in notes" :key="note.id">
          <button type="button" class="notebook-jump" title="跳到这个时间点" @click="$emit('seek', note.position)">
            {{ formatTime(note.position) }}
          </button>
          <div class="notebook-note">
            <p>
              <span v-if="note.category" class="notebook-badge" :class="`is-${note.category}`">{{ categoryLabel(note.category) }}</span>
              {{ note.note || '收藏了这一刻' }}
            </p>
            <small>{{ formatDate(note.created_at) }}</small>
          </div>
          <button type="button" class="notebook-remove notebook-icon-btn" title="删除" @click="removeNote(note)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"/>
            </svg>
          </button>
        </li>
      </ol>

      <footer class="notebook-footer">
        <span v-if="transferMessage" class="notebook-transfer" :class="{ 'is-error': transferError }">{{ transferMessage }}</span>
        <div class="notebook-footer-actions">
          <button type="button" class="notebook-footer-btn" :disabled="transferring" @click="exportNotes">导出 Markdown</button>
          <button type="button" class="notebook-footer-btn" :disabled="transferring" @click="importNotes">导入备份</button>
        </div>
      </footer>
    </section>
  </div>
</template>

<script>
export default {
  name: 'ViewingNotebookPanel',
  emits: ['close', 'seek', 'changed'],
  props: {
    identity: { type: Object, required: true },
    currentTime: { type: Number, default: 0 },
    duration: { type: Number, default: 0 },
    sourceId: { type: String, default: '' }
  },
  data() {
    return {
      notes: [],
      draft: '',
      draftCategory: '',
      loading: true,
      saving: false,
      error: '',
      transferring: false,
      transferMessage: '',
      transferError: false,
      categoryOptions: [
        { value: '', label: '感想' },
        { value: 'line', label: '台词' },
        { value: 'foreshadow', label: '伏笔' },
        { value: 'art', label: '作画' },
        { value: 'music', label: '音乐' }
      ]
    };
  },
  mounted() {
    this.loadNotes();
  },
  methods: {
    async loadNotes() {
      this.loading = true;
      this.error = '';
      try {
        this.notes = await window.electronAPI?.viewingNoteList?.(this.identity.key, 100) || [];
      } catch (error) {
        this.error = error.message || '手帐读取失败';
      } finally {
        this.loading = false;
      }
    },
    async addNote() {
      if (this.saving) return;
      this.saving = true;
      this.error = '';
      try {
        const note = await window.electronAPI?.viewingNoteAdd?.({
          episode_key: this.identity.key,
          work_key: this.identity.workKey,
          bgm_id: this.identity.bgmId,
          anime_name: this.identity.animeTitle,
          episode_number: this.identity.episodeNumber,
          episode_title: this.identity.episodeTitle,
          position: this.currentTime,
          duration: this.duration,
          note: this.draft,
          category: this.draftCategory,
          source_id: this.sourceId
        });
        if (!note || note.error) throw new Error(note?.error || '手帐保存失败');
        this.notes = [...this.notes, note].sort((a, b) => a.position - b.position);
        this.draft = '';
        this.$emit('changed', this.notes.length);
      } catch (error) {
        this.error = error.message || '手帐保存失败';
      } finally {
        this.saving = false;
      }
    },
    async exportNotes() {
      if (this.transferring) return;
      this.transferring = true;
      this.transferMessage = '';
      this.transferError = false;
      try {
        const result = await window.electronAPI?.viewingNoteExport?.();
        if (result?.canceled) {
          this.transferMessage = '';
        } else if (result?.error) {
          this.transferError = true;
          this.transferMessage = result.error;
        } else if (result?.success) {
          this.transferMessage = `已导出 ${result.count} 条时光签`;
          setTimeout(() => { if (this.transferMessage.startsWith('已导出')) this.transferMessage = ''; }, 4000);
        }
      } catch (error) {
        this.transferError = true;
        this.transferMessage = error.message || '导出失败';
      } finally {
        this.transferring = false;
      }
    },
    async importNotes() {
      if (this.transferring) return;
      this.transferring = true;
      this.transferMessage = '';
      this.transferError = false;
      try {
        const result = await window.electronAPI?.viewingNoteImport?.();
        if (result?.canceled) {
          this.transferMessage = '';
        } else if (result?.error) {
          this.transferError = true;
          this.transferMessage = result.error;
        } else if (result?.success) {
          this.transferMessage = `导入 ${result.imported} 条，跳过重复 ${result.skipped} 条`;
          await this.loadNotes();
          this.$emit('changed', this.notes.length);
          setTimeout(() => { if (this.transferMessage.startsWith('导入')) this.transferMessage = ''; }, 4000);
        }
      } catch (error) {
        this.transferError = true;
        this.transferMessage = error.message || '导入失败';
      } finally {
        this.transferring = false;
      }
    },
    categoryLabel(value) {
      const found = this.categoryOptions.find(option => option.value === value);
      return found ? found.label : '';
    },
    async removeNote(note) {
      const result = await window.electronAPI?.viewingNoteRemove?.(note.id);
      if (result?.changes > 0) {
        this.notes = this.notes.filter(item => item.id !== note.id);
        this.$emit('changed', this.notes.length);
      }
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
.notebook-overlay {
  position: absolute;
  inset: 0;
  z-index: 54;
  display: flex;
  align-items: stretch;
  justify-content: flex-end;
  background: rgba(5, 5, 10, 0.5);
  pointer-events: auto;
  animation: notebook-fade-in 0.18s ease-out both;
}

.notebook-panel {
  width: min(390px, 92vw);
  display: flex;
  flex-direction: column;
  padding: 20px;
  border-left: 1px solid rgba(255, 146, 182, 0.2);
  background: rgba(22, 19, 32, 0.97);
  box-shadow: -18px 0 40px rgba(0, 0, 0, 0.24);
  color: #fff;
  animation: notebook-slide-in 0.22s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}

.notebook-header { display: flex; justify-content: space-between; gap: 16px; }
.notebook-header h3 { margin: 2px 0 0; font-size: 20px; }
.notebook-header p { margin: 6px 0 0; color: rgba(255, 255, 255, 0.58); font-size: 12px; }
.notebook-kicker { color: #ff91b8; font-size: 10px; font-weight: 800; letter-spacing: 1px; }

.notebook-icon-btn {
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.07);
  color: rgba(255, 255, 255, 0.72);
  cursor: pointer;
}

.notebook-compose {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 9px;
  margin: 18px 0 14px;
}

.notebook-time {
  align-self: start;
  padding: 9px 8px;
  border-radius: 6px;
  background: rgba(119, 217, 255, 0.1);
  color: #9ce4ff;
  font: 700 12px/1 monospace;
}

.notebook-compose textarea {
  min-width: 0;
  resize: none;
  padding: 9px 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 7px;
  outline: none;
  background: rgba(255, 255, 255, 0.05);
  color: #fff;
  font: inherit;
}

.notebook-compose textarea:focus { border-color: rgba(255, 145, 184, 0.52); }

.notebook-categories {
  grid-column: 2;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: -4px;
}

.notebook-category {
  padding: 5px 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.05);
  color: rgba(255, 255, 255, 0.6);
  font-size: 11px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}

.notebook-category:hover { color: rgba(255, 255, 255, 0.9); }

.notebook-category.active { color: #fff; border-color: rgba(255, 255, 255, 0.4); }

.notebook-category.is-line.active { background: rgba(142, 223, 255, 0.28); border-color: #8edfff; }
.notebook-category.is-foreshadow.active { background: rgba(199, 155, 255, 0.28); border-color: #c79bff; }
.notebook-category.is-art.active { background: rgba(255, 180, 106, 0.28); border-color: #ffb46a; }
.notebook-category.is-music.active { background: rgba(125, 232, 164, 0.28); border-color: #7de8a4; }
.notebook-category.is-plain.active { background: rgba(255, 145, 184, 0.24); border-color: #f26d9f; }

.notebook-badge {
  display: inline-block;
  margin-right: 6px;
  padding: 2px 7px;
  border-radius: 999px;
  vertical-align: 1px;
  font-size: 10px;
  font-weight: 700;
  line-height: 1.4;
}

.notebook-badge.is-line { background: rgba(142, 223, 255, 0.18); color: #8edfff; }
.notebook-badge.is-foreshadow { background: rgba(199, 155, 255, 0.18); color: #c79bff; }
.notebook-badge.is-art { background: rgba(255, 180, 106, 0.18); color: #ffb46a; }
.notebook-badge.is-music { background: rgba(125, 232, 164, 0.18); color: #7de8a4; }

.notebook-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.notebook-footer-actions { display: flex; gap: 8px; flex: 0 0 auto; }

.notebook-footer-btn {
  padding: 6px 11px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.05);
  color: rgba(255, 255, 255, 0.68);
  font-size: 11px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.notebook-footer-btn:hover { color: #fff; border-color: rgba(255, 145, 184, 0.5); }
.notebook-footer-btn:disabled { opacity: 0.5; cursor: wait; }

.notebook-transfer { min-width: 0; overflow: hidden; color: rgba(125, 232, 164, 0.9); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.notebook-transfer.is-error { color: #ff9b9b; }
.notebook-save {
  grid-column: 2;
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border: 0;
  border-radius: 7px;
  background: #f26d9f;
  color: #fff;
  cursor: pointer;
  font-weight: 700;
}

.notebook-save:disabled { opacity: 0.55; cursor: wait; }
.notebook-state, .notebook-empty { margin: auto 0; color: rgba(255, 255, 255, 0.56); text-align: center; }
.notebook-state.is-error { color: #ff9b9b; }
.notebook-empty { display: flex; flex-direction: column; gap: 6px; }
.notebook-empty strong { color: rgba(255, 255, 255, 0.84); }
.notebook-empty span { font-size: 12px; }

.notebook-list {
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0 3px 0 0;
  list-style: none;
}

.notebook-list li {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: start;
  gap: 10px;
  padding: 11px 6px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
}

.notebook-jump {
  border: 0;
  background: none;
  color: #8edfff;
  cursor: pointer;
  font: 700 12px/1.4 monospace;
}

.notebook-note { min-width: 0; }
.notebook-note p { margin: 0; overflow-wrap: anywhere; color: rgba(255, 255, 255, 0.88); font-size: 13px; line-height: 1.5; }
.notebook-note small { display: block; margin-top: 5px; color: rgba(255, 255, 255, 0.36); font-size: 10px; }
.notebook-remove { width: 26px; height: 26px; flex-basis: 26px; opacity: 0; transition: opacity 0.15s, background 0.15s; }
.notebook-list li:hover .notebook-remove, .notebook-remove:focus-visible { opacity: 1; }
.notebook-remove:hover { background: rgba(255, 100, 120, 0.18); color: #ff9caf; }

@keyframes notebook-fade-in {
  from { background: rgba(5, 5, 10, 0); }
}

@keyframes notebook-slide-in {
  from { opacity: 0; transform: translateX(18px); }
}

@media (prefers-reduced-motion: reduce) {
  .notebook-overlay, .notebook-panel { animation: none; }
}
</style>
