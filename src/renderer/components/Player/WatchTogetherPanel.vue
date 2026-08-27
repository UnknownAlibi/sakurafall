<template>
  <div class="watch-together-panel">
    <!-- 头部 -->
    <div class="wt-header">
      <div class="wt-title">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
        <span>一起看</span>
      </div>
      <button class="wt-close" @click="$emit('close')" title="关闭">×</button>
    </div>

    <!-- 未在房间：创建/加入表单 -->
    <div v-if="!roomInfo.roomCode" class="wt-form-area">
      <div class="wt-tabs">
        <button :class="['wt-tab', { active: mode === 'create' }]" @click="mode = 'create'">创建房间</button>
        <button :class="['wt-tab', { active: mode === 'join' }]" @click="mode = 'join'">加入房间</button>
      </div>

      <!-- 创建房间 -->
      <div v-if="mode === 'create'" class="wt-form">
        <label class="wt-field">
          <span>房间名称</span>
          <input v-model="createForm.roomName" type="text" maxlength="40" placeholder="可选，例如：SAKURAFALL放映室" @keydown.enter="onCreateRoom" />
        </label>
        <p class="wt-tip">创建后将获得 6 位房间号，分享给朋友即可一起观看当前视频。</p>
        <button class="wt-primary-btn" :disabled="creating" @click="onCreateRoom">
          {{ creating ? '创建中...' : '创建房间' }}
        </button>
      </div>

      <!-- 加入房间 -->
      <div v-else class="wt-form">
        <label class="wt-field">
          <span>房间号</span>
          <input v-model="joinForm.roomCode" type="text" maxlength="6" placeholder="6 位数字" inputmode="numeric" @keydown.enter="onJoinRoom" />
        </label>
        <label class="wt-field">
          <span>主机地址</span>
          <input v-model="joinForm.hostAddress" type="text" placeholder="localhost 或 IP 地址" @keydown.enter="onJoinRoom" />
        </label>
        <p class="wt-tip">同机调试可填 localhost；跨设备填写对方局域网 IP。</p>
        <button class="wt-primary-btn" :disabled="joining" @click="onJoinRoom">
          {{ joining ? '加入中...' : '加入房间' }}
        </button>
      </div>

      <p v-if="formError" class="wt-error">{{ formError }}</p>
    </div>

    <!-- 已在房间：房间信息 -->
    <div v-else class="wt-room-area">
      <div class="wt-room-card">
        <div class="wt-room-row">
          <span class="wt-label">房间号</span>
          <span class="wt-room-code" @click="copyRoomCode" title="点击复制">
            {{ roomInfo.roomCode }}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          </span>
        </div>
        <div class="wt-room-row">
          <span class="wt-label">身份</span>
          <span :class="['wt-role', roomInfo.isHost ? 'host' : 'member']">
            {{ roomInfo.isHost ? '主机' : '成员' }}
          </span>
        </div>
        <div class="wt-room-row">
          <span class="wt-label">成员数</span>
          <span>{{ roomInfo.memberCount }}</span>
        </div>
        <div class="wt-room-row">
          <span class="wt-label">状态</span>
          <span :class="['wt-status', statusClass]">
            <span class="wt-dot"></span>{{ statusText }}
          </span>
        </div>
        <div v-if="!roomInfo.isHost && roomInfo.hostAddress" class="wt-room-row">
          <span class="wt-label">主机</span>
          <span class="wt-host-addr">{{ roomInfo.hostAddress }}:{{ roomInfo.port || 9876 }}</span>
        </div>
      </div>

      <!-- 同步提示 -->
      <div class="wt-sync-hint">
        <template v-if="roomInfo.isHost">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 6v6l4 2"/>
          </svg>
          <span>主机模式：你的播放进度会同步给所有成员</span>
        </template>
        <template v-else>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          <span>成员模式：等待主机同步播放状态</span>
        </template>
      </div>

      <!-- 聊天区 -->
      <div class="wt-chat">
        <div ref="chatScroll" class="wt-chat-list">
          <div v-if="chatMessages.length === 0" class="wt-chat-empty">暂无消息</div>
          <div
            v-for="(msg, idx) in chatMessages"
            :key="idx"
            :class="['wt-chat-msg', { self: msg.self }]"
          >
            <span class="wt-chat-name">{{ msgLabel(msg) }}</span>
            <span class="wt-chat-text">{{ msg.text }}</span>
            <span class="wt-chat-time">{{ formatTime(msg.timestamp) }}</span>
          </div>
        </div>
        <div class="wt-chat-input">
          <input
            v-model="chatInput"
            type="text"
            maxlength="200"
            placeholder="输入消息..."
            @keydown.enter="onSendChat"
          />
          <button :disabled="!chatInput.trim()" @click="onSendChat">发送</button>
        </div>
      </div>

      <button class="wt-leave-btn" :disabled="leaving" @click="onLeaveRoom">
        {{ leaving ? '离开中...' : '离开房间' }}
      </button>
    </div>
  </div>
</template>

<script>
export default {
  name: 'WatchTogetherPanel',
  emits: ['close', 'room-changed'],
  props: {
    // 当前视频信息（创建房间时使用）
    videoInfo: {
      type: Object,
      default: () => null
    }
  },
  data() {
    return {
      mode: 'create',
      createForm: { roomName: '' },
      joinForm: { roomCode: '', hostAddress: 'localhost' },
      creating: false,
      joining: false,
      leaving: false,
      formError: '',
      roomInfo: {
        roomCode: null,
        roomName: '',
        isHost: false,
        memberCount: 1,
        hostAddress: '',
        port: 9876,
        connected: false
      },
      chatMessages: [],
      chatInput: '',
      unsubWtMessage: null
    };
  },
  computed: {
    statusClass() {
      if (!this.roomInfo.roomCode) return 'idle';
      if (this.roomInfo.connected) return 'online';
      return 'offline';
    },
    statusText() {
      if (!this.roomInfo.roomCode) return '未连接';
      if (this.roomInfo.connected) return '已连接';
      return '断开中';
    }
  },
  watch: {
    chatMessages: {
      handler() {
        this.$nextTick(() => this.scrollToBottom());
      },
      deep: true
    }
  },
  mounted() {
    this.refreshRoomInfo();
    // 监听主进程消息
    if (window.electronAPI?.onWtMessage) {
      this.unsubWtMessage = window.electronAPI.onWtMessage((msg) => {
        this.handleMessage(msg);
      });
    }
  },
  beforeUnmount() {
    if (this.unsubWtMessage) {
      this.unsubWtMessage();
      this.unsubWtMessage = null;
    }
  },
  methods: {
    async refreshRoomInfo() {
      if (!window.electronAPI?.wtGetRoomInfo) return;
      try {
        const info = await window.electronAPI.wtGetRoomInfo();
        if (info && info.success) {
          this.roomInfo = {
            roomCode: info.roomCode || null,
            roomName: info.roomName || '',
            isHost: !!info.isHost,
            memberCount: info.memberCount || 1,
            hostAddress: info.hostAddress || '',
            port: info.port || 9876,
            connected: !!info.connected
          };
          this.$emit('room-changed', { ...this.roomInfo });
        }
      } catch (_) { /* ignore */ }
    },

    handleMessage(msg) {
      if (!msg || !msg.type) return;
      switch (msg.type) {
        case 'joined':
        case 'member-joined':
        case 'member-left':
          this.refreshRoomInfo();
          break;
        case 'sync':
          // 同步消息由 VideoPlayer 处理，这里不干预
          break;
        case 'chat':
          this.chatMessages.push({
            from: msg.from,
            isHost: msg.isHost,
            text: msg.text,
            timestamp: msg.timestamp,
            self: !!msg.self
          });
          break;
        case 'reconnecting':
          this.roomInfo.connected = false;
          break;
        case 'disconnected':
          this.roomInfo.connected = false;
          this.refreshRoomInfo();
          break;
        case 'room-closed':
          this.roomInfo = {
            roomCode: null,
            roomName: '',
            isHost: false,
            memberCount: 1,
            hostAddress: '',
            port: 9876,
            connected: false
          };
          this.chatMessages.push({
            from: 'system',
            isHost: false,
            text: '房间已被主机关闭',
            timestamp: Date.now(),
            self: false
          });
          this.$emit('room-changed', { ...this.roomInfo });
          break;
        case 'left':
          this.roomInfo = {
            roomCode: null,
            roomName: '',
            isHost: false,
            memberCount: 1,
            hostAddress: '',
            port: 9876,
            connected: false
          };
          this.chatMessages = [];
          this.$emit('room-changed', { ...this.roomInfo });
          break;
        case 'error':
          this.formError = msg.message || '发生未知错误';
          break;
        default:
          break;
      }
    },

    async onCreateRoom() {
      this.formError = '';
      if (this.creating) return;
      this.creating = true;
      try {
        const videoInfo = this.videoInfo || null;
        const result = await window.electronAPI.wtCreateRoom({
          roomName: this.createForm.roomName || '',
          videoInfo
        });
        if (!result || !result.success) {
          this.formError = result?.error || '创建房间失败';
          return;
        }
        await this.refreshRoomInfo();
        this.$emit('room-changed', { ...this.roomInfo });
      } catch (e) {
        this.formError = e.message || '创建房间失败';
      } finally {
        this.creating = false;
      }
    },

    async onJoinRoom() {
      this.formError = '';
      if (this.joining) return;
      const code = String(this.joinForm.roomCode || '').trim();
      if (!/^\d{6}$/.test(code)) {
        this.formError = '房间号必须是 6 位数字';
        return;
      }
      this.joining = true;
      try {
        const result = await window.electronAPI.wtJoinRoom({
          roomCode: code,
          hostAddress: this.joinForm.hostAddress || 'localhost'
        });
        if (!result || !result.success) {
          this.formError = result?.error || '加入房间失败';
          return;
        }
        await this.refreshRoomInfo();
        this.$emit('room-changed', { ...this.roomInfo });
      } catch (e) {
        this.formError = e.message || '加入房间失败';
      } finally {
        this.joining = false;
      }
    },

    async onLeaveRoom() {
      if (this.leaving) return;
      this.leaving = true;
      try {
        await window.electronAPI.wtLeaveRoom();
        this.roomInfo = {
          roomCode: null,
          roomName: '',
          isHost: false,
          memberCount: 1,
          hostAddress: '',
          port: 9876,
          connected: false
        };
        this.chatMessages = [];
        this.$emit('room-changed', { ...this.roomInfo });
      } catch (_) { /* ignore */ } finally {
        this.leaving = false;
      }
    },

    async onSendChat() {
      const text = String(this.chatInput || '').trim();
      if (!text) return;
      if (!this.roomInfo.roomCode) return;
      try {
        await window.electronAPI.wtSendChat(text);
        this.chatInput = '';
      } catch (_) { /* ignore */ }
    },

    async copyRoomCode() {
      try {
        await navigator.clipboard.writeText(this.roomInfo.roomCode || '');
      } catch (_) { /* ignore */ }
    },

    msgLabel(msg) {
      if (msg.self) return '我';
      if (msg.from === 'system') return '系统';
      return msg.isHost ? '主机' : '成员';
    },

    formatTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return `${hh}:${mm}`;
    },

    scrollToBottom() {
      const el = this.$refs.chatScroll;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }
};
</script>

<style scoped>
.watch-together-panel {
  position: absolute;
  right: 18px;
  top: 58px;
  z-index: 46;
  width: min(340px, calc(100% - 36px));
  max-height: min(80vh, 620px);
  display: flex;
  flex-direction: column;
  padding: 14px;
  border: 1px solid rgba(255, 138, 176, 0.18);
  border-radius: 10px;
  background:
    linear-gradient(180deg, rgba(31, 27, 48, 0.96), rgba(18, 17, 31, 0.96));
  box-shadow: 0 16px 38px rgba(0, 0, 0, 0.32);
  color: rgba(255, 255, 255, 0.88);
  font-size: 13px;
}

/* ===== 头部 ===== */
.wt-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.wt-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 15px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.94);
}

.wt-close {
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.78);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
}

.wt-close:hover {
  background: rgba(255, 255, 255, 0.18);
  color: #fff;
}

/* ===== 表单区 ===== */
.wt-form-area {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.wt-tabs {
  display: flex;
  gap: 6px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  padding: 3px;
}

.wt-tab {
  flex: 1;
  padding: 7px 0;
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.6);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  border-radius: 6px;
  transition: background 0.15s, color 0.15s;
}

.wt-tab.active {
  background: rgba(var(--primary-rgb), 0.22);
  color: #fff;
}

.wt-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.wt-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.wt-field span {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.62);
}

.wt-field input {
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
  color: #fff;
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s;
}

.wt-field input:focus {
  border-color: rgba(var(--primary-rgb), 0.55);
}

.wt-tip {
  margin: 0;
  color: rgba(255, 255, 255, 0.5);
  font-size: 11px;
  line-height: 1.5;
}

.wt-primary-btn {
  height: 34px;
  border: none;
  border-radius: 8px;
  background: linear-gradient(135deg, var(--player-progress), var(--accent-lavender));
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: filter 0.15s;
}

.wt-primary-btn:hover:not(:disabled) {
  filter: brightness(1.08);
}

.wt-primary-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.wt-error {
  margin: 0;
  color: #ff8a8a;
  font-size: 12px;
  text-align: center;
}

/* ===== 房间信息区 ===== */
.wt-room-area {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  flex: 1;
}

.wt-room-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
}

.wt-room-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
}

.wt-label {
  color: rgba(255, 255, 255, 0.56);
}

.wt-room-code {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 15px;
  font-weight: 700;
  color: var(--player-progress);
  cursor: pointer;
  user-select: all;
}

.wt-room-code:hover svg {
  opacity: 1;
}

.wt-room-code svg {
  opacity: 0.45;
  transition: opacity 0.15s;
}

.wt-role {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
}

.wt-role.host {
  background: rgba(var(--primary-rgb), 0.2);
  color: #ffb3c8;
}

.wt-role.member {
  background: rgba(66, 199, 238, 0.18);
  color: #8ed8f0;
}

.wt-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
}

.wt-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}

.wt-status.online { color: #6ee68f; }
.wt-status.offline { color: #ff8a8a; }
.wt-status.idle { color: rgba(255, 255, 255, 0.4); }

.wt-host-addr {
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.78);
}

.wt-sync-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(66, 199, 238, 0.1);
  color: #8ed8f0;
  font-size: 11px;
  line-height: 1.4;
}

/* ===== 聊天 ===== */
.wt-chat {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.2);
  overflow: hidden;
}

.wt-chat-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 10px;
  max-height: 180px;
  min-height: 60px;
}

.wt-chat-empty {
  text-align: center;
  color: rgba(255, 255, 255, 0.4);
  font-size: 11px;
  padding: 14px 0;
}

.wt-chat-msg {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.wt-chat-msg:last-child {
  border-bottom: none;
}

.wt-chat-msg.self .wt-chat-name {
  color: var(--player-progress);
}

.wt-chat-name {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.62);
  font-weight: 600;
}

.wt-chat-text {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.9);
  word-break: break-word;
}

.wt-chat-time {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.36);
  align-self: flex-end;
}

.wt-chat-input {
  display: flex;
  gap: 6px;
  padding: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.wt-chat-input input {
  flex: 1;
  height: 28px;
  padding: 0 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: #fff;
  font-size: 12px;
  outline: none;
}

.wt-chat-input input:focus {
  border-color: rgba(var(--primary-rgb), 0.5);
}

.wt-chat-input button {
  height: 28px;
  padding: 0 12px;
  border: none;
  border-radius: 6px;
  background: linear-gradient(135deg, var(--player-progress), var(--accent-lavender));
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.wt-chat-input button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ===== 离开按钮 ===== */
.wt-leave-btn {
  height: 32px;
  border: 1px solid rgba(255, 107, 107, 0.4);
  border-radius: 8px;
  background: rgba(255, 107, 107, 0.1);
  color: #ff9c9c;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.wt-leave-btn:hover:not(:disabled) {
  background: rgba(255, 107, 107, 0.22);
}

.wt-leave-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

/* ===== 滚动条 ===== */
.wt-chat-list::-webkit-scrollbar {
  width: 4px;
}
.wt-chat-list::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.18);
  border-radius: 2px;
}

@media (max-width: 600px) {
  .watch-together-panel {
    right: 8px;
    top: 52px;
    width: calc(100% - 16px);
    max-height: 70vh;
  }
}
</style>
