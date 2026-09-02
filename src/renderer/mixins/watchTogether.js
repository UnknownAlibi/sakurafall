// 文件路径: src/renderer/mixins/watchTogether.js
// "一起看"同步播放逻辑（从 VideoPlayer.vue 抽离，满足体积棘轮守卫）：
// - 房间状态机（主机/成员）与主机周期广播
// - 成员同步：延迟补偿 + 分级纠偏（>1.5s 硬 seek，0.35-1.5s 软调速 ±4%）
// - P1：主机切集时成员确认流程（跟随/留在本集）
// - P1：成员 RTT 单调时钟探测（ping/pong，EMA 平滑）

import { createTimelineAnchor, resolveTimelineAnchor } from '../utils/episodeIdentity.js';

export default {
  data() {
    return {
      // 一起看面板是否可见
      watchTogetherPanelVisible: false,
      // 当前是否在房间中（用于 ControlBar 按钮高亮）
      watchTogetherActive: false,
      // 房间信息（含 isHost 字段，决定本机是主机还是成员）
      wtRoomInfo: { isHost: false, roomCode: null },
      // 主机周期广播状态的定时器
      wtHostBroadcastTimer: null,
      // 成员同步节流：上次 seek 时间，避免频繁 seek 卡顿
      wtLastSeekAt: 0,
      // 成员正在应用主机同步状态时，本地播放事件不应再触发广播
      wtApplyingRemoteState: false,
      // 主进程消息订阅的取消函数
      wtUnsubscribe: null,
      // 成员 RTT 探测定时器（每 3 秒一次）
      wtPingTimer: null,
      // RTT 指数移动平均（毫秒），null 表示尚无样本
      wtRttEma: null,
      // 当前软调速因子：0=未启用，1.04/0.96=追赶/减速
      wtSoftRateFactor: 0,
      // P1：主机切集确认请求（成员侧横幅数据）
      wtEpisodeSwitchRequest: null,
      wtEpisodeSwitching: false,
      wtEpisodeSwitchError: '',
      // 本会话内已拒绝跟随的集（同一集只提示一次）
      wtDismissedEpisodeKeys: []
    };
  },

  computed: {
    // 创建房间时传递给 WatchTogetherPanel 的当前视频信息
    wtVideoInfoForRoom() {
      const v = this.currentVideo;
      if (!v) return null;
      return {
        title: v.title || '',
        url: v.url || '',
        animeName: v.anime?.name || '',
        episodeTitle: v.episode?.title || '',
        episodeIndex: v.episode?.index ?? -1,
        episodeIdentity: this.currentEpisodeIdentity
      };
    }
  },

  mounted() {
    // 订阅"一起看"主进程消息
    if (window.electronAPI?.onWtMessage) {
      this.wtUnsubscribe = window.electronAPI.onWtMessage((msg) => {
        this.onWtMessage(msg);
      });
    }
  },

  beforeUnmount() {
    this.stopWtHostBroadcast();
    this.stopWtPingLoop();
    if (this.wtUnsubscribe) {
      this.wtUnsubscribe();
      this.wtUnsubscribe = null;
    }
  },

  methods: {
    onWatchTogetherToggle() {
      this.watchTogetherPanelVisible = !this.watchTogetherPanelVisible;
    },

    /**
     * 房间状态变化回调（由 WatchTogetherPanel 触发）
     * 同步本组件状态、启动/停止主机广播定时器
     */
    onWtRoomChanged(roomInfo) {
      const prevActive = this.watchTogetherActive;
      this.wtRoomInfo = {
        isHost: !!roomInfo?.isHost,
        roomCode: roomInfo?.roomCode || null
      };
      this.watchTogetherActive = !!roomInfo?.roomCode;

      if (this.watchTogetherActive && !prevActive) {
        // 刚进入房间：主机则启动周期广播，成员则等待同步
        if (this.wtRoomInfo.isHost) {
          this.startWtHostBroadcast();
        }
      } else if (!this.watchTogetherActive && prevActive) {
        // 离开房间：清理定时器
        this.stopWtHostBroadcast();
        this.stopWtPingLoop();
        this.wtEpisodeSwitchRequest = null;
        this.wtEpisodeSwitchError = '';
      }

      // 角色切换时调整定时器
      if (this.watchTogetherActive && !this.wtRoomInfo.isHost) {
        this.stopWtHostBroadcast();
      }
    },

    /**
     * 主机：启动周期性广播播放状态（每 2 秒一次）
     */
    startWtHostBroadcast() {
      this.stopWtHostBroadcast();
      this.wtHostBroadcastTimer = setInterval(() => {
        this.broadcastWtState();
      }, 2000);
      // 立即广播一次，让新成员尽快同步
      this.broadcastWtState();
    },

    stopWtHostBroadcast() {
      if (this.wtHostBroadcastTimer) {
        clearInterval(this.wtHostBroadcastTimer);
        this.wtHostBroadcastTimer = null;
      }
    },

    /**
     * 主机：广播当前播放状态给所有成员
     */
    broadcastWtState() {
      if (!this.wtRoomInfo.isHost || !this.watchTogetherActive) return;
      if (!window.electronAPI?.wtBroadcastState) return;
      const video = this.$refs.videoElement;
      const state = {
        isPlaying: this.isPlaying,
        currentTime: video?.currentTime || this.currentTime || 0,
        duration: video?.duration || this.duration || 0,
        timelineAnchor: createTimelineAnchor(
          video?.currentTime || this.currentTime || 0,
          video?.duration || this.duration || 0
        ),
        episodeIdentity: this.currentEpisodeIdentity,
        playbackRate: this.playbackRate || 1,
        episodeIndex: this.currentVideo?.episode?.index ?? -1,
        episodeTitle: this.currentVideo?.episode?.title || '',
        animeName: this.currentVideo?.anime?.name || '',
        videoUrl: this.currentVideo?.url || ''
      };
      try {
        window.electronAPI.wtBroadcastState(state);
      } catch (_) { /* ignore */ }
    },

    /**
     * 成员：处理主机发来的同步消息，对齐本地播放器
     */
    applyWtSyncState(state) {
      if (this.wtRoomInfo.isHost) return; // 主机不需要同步自己
      const video = this.$refs.videoElement;
      if (!video) return;
      if (state.episodeIdentity?.key
        && this.currentEpisodeIdentity?.key
        && state.episodeIdentity.key !== this.currentEpisodeIdentity.key) {
        // P1：主机切到另一集时，弹出确认流程而不是静默丢弃
        this.requestWtEpisodeSwitch(state);
        return;
      }

      this.wtApplyingRemoteState = true;
      try {
        // 1. 对齐播放/暂停状态
        if (state.isPlaying && video.paused) {
          this.requestPlayback('watch-together');
        } else if (!state.isPlaying && !video.paused) {
          this.pausePlayback('watch-together');
        }

        // 2. 对齐播放进度：延迟补偿 + 分级纠偏（软调速优先于硬 seek）
        const targetTime = state.timelineAnchor
          ? resolveTimelineAnchor(state.timelineAnchor, video.duration || this.duration || 0)
          : (Number(state.currentTime) || 0);
        const baseRate = Number(state.playbackRate) || 1;
        // 单向延迟估计：RTT/2；主机状态发出后仍在继续播放，成员收到时已推进这段延迟
        const oneWayDelayMs = this.wtRttEma != null ? this.wtRttEma / 2 : 0;
        const compensatedTarget = targetTime + (oneWayDelayMs / 1000) * baseRate;
        const localTime = video.currentTime || 0;
        const drift = compensatedTarget - localTime; // 正 = 成员落后，负 = 成员超前
        const absDrift = Math.abs(drift);
        const now = Date.now();
        if (absDrift > 1.5 && now - this.wtLastSeekAt > 800) {
          this.wtLastSeekAt = now;
          if (isFinite(compensatedTarget)) {
            this.markIntentionalSeek();
            video.currentTime = Math.max(0, Math.min(compensatedTarget, video.duration || compensatedTarget));
            // 通知弹幕/字幕层重置
            if (this.$refs.danmakuLayer) {
              this.$refs.danmakuLayer.onSeek(video.currentTime);
            }
            if (this.$refs.subtitleLayer) {
              this.$refs.subtitleLayer.onSeek(video.currentTime);
            }
          }
        } else if (state.isPlaying && absDrift > 0.35 && absDrift <= 1.5) {
          // 中等偏差：软调速 ±4% 平滑追赶，避免频繁硬 seek 造成画面跳动
          const factor = drift > 0 ? 1.04 : 0.96;
          if (this.wtSoftRateFactor !== factor) {
            this.wtSoftRateFactor = factor;
            video.playbackRate = baseRate * factor;
          }
        } else if (this.wtSoftRateFactor !== 0) {
          // 已收敛或暂停：恢复主机倍速
          this.wtSoftRateFactor = 0;
          if (Math.abs(baseRate - (video.playbackRate || 1)) > 0.001) {
            video.playbackRate = baseRate;
          }
        }

        // 3. 对齐倍速（未处于软调速窗口时才直接对齐，避免覆盖纠偏速率）
        if (this.wtSoftRateFactor === 0
          && state.playbackRate && Math.abs(state.playbackRate - (video.playbackRate || 1)) > 0.01) {
          video.playbackRate = state.playbackRate;
          this.setPlaybackRate(state.playbackRate);
        }
      } finally {
        // 异步释放标志位，让本轮事件回调跳过广播；纳入 pendingTimers 跟踪避免卸载后执行
        this.trackTimer(setTimeout(() => { this.wtApplyingRemoteState = false; }, 0));
      }
    },

    /**
     * 成员：主机切到不同集时记录确认请求（同一集只提示一次）
     */
    requestWtEpisodeSwitch(state) {
      const key = state.episodeIdentity?.key;
      if (!key) return;
      if (this.wtEpisodeSwitchRequest?.episodeIdentityKey === key) return;
      if (this.wtDismissedEpisodeKeys.includes(key)) return;
      this.wtEpisodeSwitchRequest = {
        episodeIdentityKey: key,
        episodeIndex: Number(state.episodeIndex) || 0,
        episodeTitle: state.episodeTitle || '',
        animeName: state.animeName || this.currentVideo?.anime?.name || ''
      };
      this.wtEpisodeSwitchError = '';
    },

    /**
     * 成员：确认跟随主机切集 —— 先确认本地候选源可用，再切换
     */
    async followWtEpisode() {
      const request = this.wtEpisodeSwitchRequest;
      if (!request || this.wtEpisodeSwitching) return;
      this.wtEpisodeSwitching = true;
      this.wtEpisodeSwitchError = '';
      try {
        const animeName = request.animeName || this.currentVideo?.anime?.name;
        if (!animeName) throw new Error('缺少番剧信息，无法跟随切换');
        const result = await window.electronAPI.cmsMultiSelectBestEpisodeSource(animeName, {
          episodeTitle: request.episodeTitle || '',
          episodeIndex: request.episodeIndex,
          allowFirstFallback: false
        });
        const best = result?.best
          || (Array.isArray(result?.candidates) && result.candidates.length > 0 ? result.candidates[0] : null);
        if (!best?.url || !best?.anime || !best?.episode) {
          throw new Error('本地未找到该集的可用候选源');
        }
        this.wtEpisodeSwitchRequest = null;
        await this.playSourceCandidate(best);
      } catch (error) {
        this.wtEpisodeSwitchError = error.message || '跟随主机切集失败';
      } finally {
        this.wtEpisodeSwitching = false;
      }
    },

    /**
     * 成员：忽略主机切集请求，留在本集（本会话内不再重复提示同一集）
     */
    dismissWtEpisodeSwitch() {
      const request = this.wtEpisodeSwitchRequest;
      if (request?.episodeIdentityKey
        && !this.wtDismissedEpisodeKeys.includes(request.episodeIdentityKey)) {
        this.wtDismissedEpisodeKeys.push(request.episodeIdentityKey);
      }
      this.wtEpisodeSwitchRequest = null;
      this.wtEpisodeSwitchError = '';
    },

    /**
     * 成员：启动 RTT 探测（每 3 秒一次，单调时钟），pong 回显后按 EMA 平滑
     */
    startWtPingLoop() {
      this.stopWtPingLoop();
      if (!window.electronAPI?.wtSendPing) return;
      this.wtPingTimer = setInterval(() => {
        if (!this.watchTogetherActive || this.wtRoomInfo.isHost) return;
        window.electronAPI.wtSendPing(performance.now()).catch(() => { /* ignore */ });
      }, 3000);
      // 立即探测一次，尽快获得延迟样本
      if (this.watchTogetherActive && !this.wtRoomInfo.isHost) {
        window.electronAPI.wtSendPing(performance.now()).catch(() => { /* ignore */ });
      }
    },

    stopWtPingLoop() {
      if (this.wtPingTimer) {
        clearInterval(this.wtPingTimer);
        this.wtPingTimer = null;
      }
      this.wtRttEma = null;
      this.wtSoftRateFactor = 0;
    },

    /**
     * 收到主进程推送的"一起看"消息
     */
    onWtMessage(msg) {
      if (!msg || !msg.type) return;
      switch (msg.type) {
        case 'sync':
          this.applyWtSyncState(msg.state || {});
          break;
        case 'joined':
          // 成员加入房间成功
          this.wtRoomInfo = { isHost: false, roomCode: msg.roomCode };
          this.watchTogetherActive = !!msg.roomCode;
          this.startWtPingLoop();
          break;
        case 'pong':
          // RTT 探测回显：用本机单调时钟计算往返时延，EMA 平滑
          if (typeof msg.ts === 'number' && msg.ts > 0) {
            const rtt = performance.now() - msg.ts;
            if (Number.isFinite(rtt) && rtt >= 0 && rtt < 10000) {
              this.wtRttEma = this.wtRttEma == null
                ? rtt
                : this.wtRttEma * 0.7 + rtt * 0.3;
            }
          }
          break;
        case 'member-joined':
          // 有新成员加入，主机立即广播一次状态让其同步
          if (this.wtRoomInfo.isHost) {
            this.broadcastWtState();
          }
          break;
        case 'room-closed':
        case 'left':
          this.stopWtHostBroadcast();
          this.stopWtPingLoop();
          this.wtRoomInfo = { isHost: false, roomCode: null };
          this.watchTogetherActive = false;
          this.wtEpisodeSwitchRequest = null;
          this.wtEpisodeSwitchError = '';
          break;
        default:
          break;
      }
    }
  }
};
