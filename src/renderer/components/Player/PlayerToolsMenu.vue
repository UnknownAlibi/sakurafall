<template>
  <div class="player-tools-control">
    <button
      type="button"
      :class="['control-btn', 'tools-btn', { active: moreToolsActive, 'menu-open': show }]"
      title="播放工具"
      aria-label="播放工具"
      :aria-expanded="show"
      @click="$emit('toggle')"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="7" height="7" rx="2" />
        <rect x="14" y="3" width="7" height="7" rx="2" />
        <rect x="3" y="14" width="7" height="7" rx="2" />
        <rect x="14" y="14" width="7" height="7" rx="2" />
      </svg>
      <span class="control-btn-label">工具</span>
    </button>
    <transition name="settings-pop">
      <div v-if="show" class="player-tools-menu" @click.stop>
        <div class="tools-menu-heading">
          <strong>播放工具</strong>
          <span>观影辅助</span>
        </div>
        <div class="tools-menu-grid">
          <button type="button" :class="['tool-menu-item', { active: casting }]" @click="runToolAction('cast-toggle')">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M2 16.1A5 5 0 0 1 5.9 20M2 12.05A9 9 0 0 1 9.95 20M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6" />
              <line x1="2" y1="20" x2="2.01" y2="20" />
            </svg>
            <span>投屏</span>
            <small>{{ casting ? '投屏中' : 'DLNA' }}</small>
          </button>
          <button type="button" class="tool-menu-item" @click="runToolAction('picture-in-picture-toggle')">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <rect x="12" y="9" width="8" height="6" rx="1" fill="currentColor" opacity="0.35" />
            </svg>
            <span>画中画</span>
            <small>悬浮播放</small>
          </button>
          <button type="button" :class="['tool-menu-item', { active: notebookActive }]" @click="runToolAction('notebook-toggle')">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
            <span>樱月手帐</span>
            <small>时光签</small>
          </button>
          <button type="button" :class="['tool-menu-item', { active: dnaActive }]" @click="runToolAction('dna-toggle')">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 12h3l2-6 4 12 2-6h7" />
            </svg>
            <span>剧集片段</span>
            <small>片头 / 片尾</small>
          </button>
          <button type="button" :class="['tool-menu-item', 'tool-menu-item-wide', { active: watchTogetherActive }]" @click="runToolAction('watch-together-toggle')">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            <span>一起看</span>
            <small>{{ watchTogetherActive ? '房间已开启' : '邀请朋友同步观影' }}</small>
          </button>
        </div>
      </div>
    </transition>
  </div>
</template>

<script>
export default {
  name: 'PlayerToolsMenu',
  props: {
    show: {
      type: Boolean,
      default: false
    },
    moreToolsActive: {
      type: Boolean,
      default: false
    },
    casting: {
      type: Boolean,
      default: false
    },
    notebookActive: {
      type: Boolean,
      default: false
    },
    dnaActive: {
      type: Boolean,
      default: false
    },
    watchTogetherActive: {
      type: Boolean,
      default: false
    }
  },
  emits: [
    'toggle',
    'close',
    'cast-toggle',
    'picture-in-picture-toggle',
    'notebook-toggle',
    'dna-toggle',
    'watch-together-toggle'
  ],
  methods: {
    runToolAction(eventName) {
      this.$emit('close');
      this.$emit(eventName);
    }
  }
};
</script>
