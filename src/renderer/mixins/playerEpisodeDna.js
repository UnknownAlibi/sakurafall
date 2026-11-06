import { analyzeIntroFeatures } from '../player/episodeDnaClient.js';

export default {
  data() {
    return {
      dnaVisible: false,
      dnaCandidates: [],
      dnaAutoSkipRule: null,
      dnaAutoSkippedKey: '',
      // 本集已标记的广告段（Episode DNA 里的 ad），播放到区间内自动跳过
      dnaEpisodeAds: [],
      dnaSkippedAdIds: [],
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
      // 顺带刷新本集广告段：两者都按「当前集」加载，调用点始终成对出现
      this.loadEpisodeAdSegments();
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
    /** 本集已标记的 ad 段：用户标过一次，之后播放到该区间就自动跳过 */
    async loadEpisodeAdSegments() {
      const episodeKey = this.currentEpisodeIdentity?.key;
      this.dnaEpisodeAds = [];
      this.dnaSkippedAdIds = [];
      if (!episodeKey) return;
      try {
        const segments = await window.electronAPI?.episodeSegmentList?.(episodeKey);
        if (episodeKey !== this.currentEpisodeIdentity?.key) return;
        this.dnaEpisodeAds = (Array.isArray(segments) ? segments : [])
          .filter(row => row?.kind === 'ad' && Number(row.confirmed) !== 0)
          .map(row => ({ id: Number(row.id) || 0, start: Number(row.start) || 0, end: Number(row.end) || 0 }))
          .filter(range => range.end - range.start >= 3)
          .sort((a, b) => a.start - b.start);
      } catch (_) {
        this.dnaEpisodeAds = [];
      }
    },
    onDnaSegmentsChanged() {
      this.loadDnaAutoSkipRule();
      this.loadEpisodeAdSegments();
    },
    _showSkipNotice(text) {
      this.adSkipNotice = text;
      if (this._adSkipNoticeTimer) clearTimeout(this._adSkipNoticeTimer);
      this._adSkipNoticeTimer = setTimeout(() => {
        this._adSkipNoticeTimer = null;
        this.adSkipNotice = '';
      }, 2200);
    },
    /** 播放到本集已标记的广告段时自动跳过（每段只跳一次） */
    maybeAutoSkipDnaAd(currentTime) {
      const ads = this.dnaEpisodeAds;
      if (!Array.isArray(ads) || ads.length === 0) return;
      if (this.watchTogetherActive || this.casting) return;
      const ad = ads.find(range => currentTime >= range.start && currentTime < range.end - 0.5);
      if (!ad || this.dnaSkippedAdIds.includes(ad.id)) return;
      const video = this.$refs.videoElement;
      if (!video) return;
      this.dnaSkippedAdIds = [...this.dnaSkippedAdIds, ad.id];
      this.markIntentionalSeek?.();
      video.currentTime = Math.min(ad.end + 0.05, video.duration || ad.end + 0.05);
      this._showSkipNotice(`已自动跳过广告 ${Math.max(1, Math.round(ad.end - currentTime))} 秒`);
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
