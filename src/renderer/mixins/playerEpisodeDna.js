import { analyzeIntroFeatures } from '../player/episodeDnaClient.js';

export default {
  data() {
    return {
      dnaVisible: false,
      dnaCandidates: [],
      dnaAutoSkipRule: null,
      dnaAutoSkippedKey: '',
      _dnaRuleToken: 0
    };
  },
  computed: {
    skippableIntroRange() {
      if (this.buffering || this.loading || !this.isPlaying || this.watchTogetherActive || this.casting) return null;
      const key = this.currentEpisodeIdentity?.key;
      if (!key || this.dnaAutoSkippedKey === key) return null;
      const cur = this.currentTime;
      const rule = this.dnaAutoSkipRule;
      if (rule && rule.end > rule.start && cur >= rule.start && cur < rule.end - 1) {
        return { start: Number(rule.start), end: Number(rule.end) };
      }
      const c = this.dnaCandidates?.[0];
      if (c && c.end > c.start && cur >= c.start && cur < c.end - 1) {
        return { start: Number(c.start), end: Number(c.end) };
      }
      return null;
    }
  },
  methods: {
    skipCurrentIntro() {
      const r = this.skippableIntroRange;
      const v = this.$refs.videoElement;
      if (!r || !v) return;
      const key = this.currentEpisodeIdentity?.key;
      if (key) this.dnaAutoSkippedKey = key;
      this.markIntentionalSeek?.();
      v.currentTime = Math.min(r.end + 0.05, v.duration || r.end + 0.05);
      this.adSkipNotice = `已跳过片头 ${Math.max(1, Math.round(r.end - this.currentTime))} 秒`;
      if (this._adSkipNoticeTimer) clearTimeout(this._adSkipNoticeTimer);
      this._adSkipNoticeTimer = setTimeout(() => {
        this._adSkipNoticeTimer = null;
        this.adSkipNotice = '';
      }, 2000);
    },
    async onDnaCollectionDone(features) {
      if (this._dnaCollector) {
        this._dnaCollector = null;
      }
      if (!features) return;
      const episodeKey = this.currentEpisodeIdentity?.key;
      try {
        const candidates = await analyzeIntroFeatures(features);
        if (!episodeKey || episodeKey !== this.currentEpisodeIdentity?.key) return;
        this.dnaCandidates = Array.isArray(candidates) ? candidates : [];
      } catch (_) {
        // ignore
      }
    },
    async loadDnaAutoSkipRule() {
      const identity = this.currentEpisodeIdentity;
      if (!identity?.workKey) {
        this.dnaAutoSkipRule = null;
        return;
      }
      const token = ++this._dnaRuleToken;
      try {
        const rule = await window.electronAPI?.episodeSegmentAutoSkipRule?.(identity.bgmId, identity.workKey);
        if (token !== this._dnaRuleToken) return;
        this.dnaAutoSkipRule = rule || null;
      } catch (_) {
        if (token === this._dnaRuleToken) this.dnaAutoSkipRule = null;
      }
    },
    onDnaRuleUpdated(rule) {
      this.dnaAutoSkipRule = rule || null;
      this.dnaAutoSkippedKey = '';
    },
    maybeAutoSkipDnaIntro(currentTime) {
      const rule = this.dnaAutoSkipRule;
      const episodeKey = this.currentEpisodeIdentity?.key;
      if (!rule || !episodeKey || this.dnaAutoSkippedKey === episodeKey) return;
      if (this.watchTogetherActive || this.casting) return;
      const start = Number(rule.start) || 0;
      const end = Number(rule.end) || 0;
      if (end <= start || currentTime < start || currentTime >= end - 0.5) return;
      const video = this.$refs.videoElement;
      if (!video) return;
      this.dnaAutoSkippedKey = episodeKey;
      this.markIntentionalSeek?.();
      video.currentTime = Math.min(end + 0.05, video.duration || end + 0.05);
      this.adSkipNotice = `已自动跳过片头 ${Math.max(1, Math.round(end - currentTime))} 秒`;
      if (this._adSkipNoticeTimer) clearTimeout(this._adSkipNoticeTimer);
      this._adSkipNoticeTimer = setTimeout(() => {
        this._adSkipNoticeTimer = null;
        this.adSkipNotice = '';
      }, 2200);
    }
  }
};
