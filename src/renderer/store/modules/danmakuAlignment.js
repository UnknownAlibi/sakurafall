import {
  normalizeAlignment,
  createEmptyAlignment,
  deriveAlignmentFromDetections,
  describeAlignment,
  isAlignmentEmpty,
  addInsertRange,
  addCutRange,
  removeRangeAt,
  formatClock
} from '../../utils/danmakuAlignment.js';
import { inferDanmakuContentStart } from '../../utils/danmakuAnchors.js';

// 弹幕时间轴对齐状态
//
// 语义：
//   - 校准结果按「作品 + 集 + 播放源」记忆（同一集换源需要各自校准）
//   - 变更后自动落库（防抖），播放中即时生效
//   - 检测结果（DNA 片头 / HLS 广告段）只作为「推导初值」，用户可按需应用或清除

let persistTimer = null;

export default {
  namespaced: true,
  state: {
    episodeKey: '',
    workKey: '',
    bgmId: null,
    episodeNumber: null,
    sourceId: '',
    alignment: createEmptyAlignment(),
    savedAlignment: createEmptyAlignment(),
    detections: { videoIntro: null, adRanges: [], canonicalIntroLength: 0 },
    notes: [],
    suggestion: null,
    // 手动标记插入区间（广告）时的起点，null 表示未在标记中
    pendingInsertStart: null,
    // 手动标记删减区间（中段被剪辑）时的起点
    pendingCutStart: null,
    // 时长差提示：视频比弹幕短/长多少秒，用于「没有其它信号」时给一键解释
    durationHint: null,
    // 弹幕侧推断的锚点（来自弹幕文本，如「空降/正片开始」簇）
    danmakuAnchors: { contentStart: null, confidence: 0, samples: 0 },
    // 作品级片头长度模板：没有弹幕锚点时判断「本视频片头是否被剪短」
    template: { introLength: 0, samples: 0 },
    // 已保存校准的来源：manual 之后不再被自动结果覆盖
    savedOrigin: '',
    // 本次自动对齐的状态（用于面板提示与撤销）
    autoApplied: false,
    autoReason: '',
    // 用户撤销过自动对齐：本集+本源不再自动应用，直到重新进入
    autoSuppressed: false,
    // 暂停时的候选弹幕窗口（供「弹幕对照校准」点选）
    referenceWindow: { videoTime: 0, items: [] },
    loadToken: 0,
    status: 'idle' // idle | ready
  },

  getters: {
    alignment: state => state.alignment,
    autoApplied: state => state.autoApplied,
    autoReason: state => state.autoReason,
    template: state => state.template,
    savedOrigin: state => state.savedOrigin,
    summary: state => describeAlignment(state.alignment),
    isCalibrated: state => !isAlignmentEmpty(state.alignment),
    hasUnsavedChange: state => JSON.stringify(state.alignment) !== JSON.stringify(state.savedAlignment),
    hasDetections: state => !!(state.detections.videoIntro || (state.detections.adRanges || []).length),
    detections: state => state.detections,
    notes: state => state.notes,
    suggestion: state => state.suggestion,
    pendingInsertStart: state => state.pendingInsertStart,
    pendingCutStart: state => state.pendingCutStart,
    durationHint: state => state.durationHint,
    // 时长差提示只在「自动对齐没给出结论、当前也没有任何校准」时展示，避免和自动结果打架
    showDurationHint: state => Boolean(state.durationHint) && !state.autoApplied && isAlignmentEmpty(state.alignment),
    cuts: state => state.alignment.cuts,
    inserts: state => state.alignment.inserts,
    danmakuAnchors: state => state.danmakuAnchors,
    danmakuContentStart: state => state.danmakuAnchors.contentStart,
    referenceWindow: state => state.referenceWindow
  },

  mutations: {
    SET_CONTEXT(state, { episodeKey = '', workKey = '', bgmId = null, episodeNumber = null, sourceId = '' } = {}) {
      state.episodeKey = episodeKey || '';
      state.workKey = workKey || '';
      state.bgmId = bgmId ?? null;
      state.episodeNumber = episodeNumber ?? null;
      state.sourceId = sourceId || '';
      state.loadToken += 1;
    },

    SET_ALIGNMENT(state, alignment) {
      state.alignment = normalizeAlignment(alignment);
    },

    SET_SAVED(state, { alignment, updatedAt = 0, origin = '' }) {
      state.savedAlignment = normalizeAlignment(alignment);
      state.alignment = normalizeAlignment(alignment);
      state.savedAt = updatedAt;
      state.savedOrigin = origin === 'auto' ? 'auto' : (origin === 'manual' ? 'manual' : '');
    },

    SET_TEMPLATE(state, template = null) {
      state.template = template && Number(template.introLength) > 0
        ? { introLength: Number(template.introLength), samples: Number(template.samples) || 0 }
        : { introLength: 0, samples: 0 };
    },

    SET_AUTO_APPLIED(state, { applied = false, reason = '' } = {}) {
      state.autoApplied = !!applied;
      state.autoReason = applied ? String(reason || '') : '';
    },

    SET_AUTO_SUPPRESSED(state, suppressed = false) {
      state.autoSuppressed = !!suppressed;
    },

    SET_DETECTIONS(state, { videoIntro = null, adRanges = [], canonicalIntroLength = 0 } = {}) {
      state.detections = {
        videoIntro: videoIntro || null,
        adRanges: Array.isArray(adRanges) ? adRanges : [],
        canonicalIntroLength: Number(canonicalIntroLength) || 0
      };
    },

    SET_NOTES(state, notes = []) {
      state.notes = Array.isArray(notes) ? notes : [];
    },

    SET_SUGGESTION(state, suggestion = null) {
      state.suggestion = suggestion || null;
    },

    SET_PENDING_CUT_START(state, seconds = null) {
      state.pendingCutStart = seconds === null || seconds === undefined ? null : Math.max(0, Number(seconds) || 0);
    },

    SET_DURATION_HINT(state, hint = null) {
      state.durationHint = hint && Number(hint.gap) ? hint : null;
    },

    SET_PENDING_INSERT_START(state, seconds = null) {
      state.pendingInsertStart = seconds === null ? null : Number(seconds);
    },

    SET_DANMAKU_ANCHORS(state, anchors = null) {
      state.danmakuAnchors = anchors || { contentStart: null, confidence: 0, samples: 0 };
    },

    SET_REFERENCE_WINDOW(state, { videoTime = 0, items = [] } = {}) {
      state.referenceWindow = {
        videoTime: Number(videoTime) || 0,
        items: Array.isArray(items) ? items : []
      };
    },

    SET_STATUS(state, status) {
      state.status = status;
    }
  },

  actions: {
    /** 上下文（集/源）变化：读库 + 查同源历史建议 */
    async loadFor({ commit, state, dispatch }, context = {}) {
      // 切换上下文前先把上一组的待写入校准落库，避免防抖窗口内的改动丢失
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
        await dispatch('persist');
      }
      commit('SET_CONTEXT', context);
      commit('SET_STATUS', 'idle');
      commit('SET_NOTES', []);
      // 检测结果属于「上一集/上一源」，换上下文先清空，等播放器重新采集
      commit('SET_DETECTIONS', {});
      // 弹幕侧锚点与候选窗口同样属于上一集，弹幕加载完成后会重新推断
      commit('SET_DANMAKU_ANCHORS', null);
      commit('SET_REFERENCE_WINDOW', {});
      commit('SET_ALIGNMENT', createEmptyAlignment());
      commit('SET_SAVED', { alignment: createEmptyAlignment() });
      commit('SET_AUTO_APPLIED', {});
      commit('SET_TEMPLATE', null);
      commit('SET_PENDING_INSERT_START', null);
      commit('SET_PENDING_CUT_START', null);
      commit('SET_DURATION_HINT', null);
      if (!state.episodeKey) return;
      const token = state.loadToken;

      try {
        const [record, suggestion, template] = await Promise.all([
          window.electronAPI?.danmakuAlignmentGet?.({
            episodeKey: state.episodeKey,
            sourceId: state.sourceId
          }) || null,
          state.workKey
            ? (window.electronAPI?.danmakuAlignmentWorkSuggestion?.({
                workKey: state.workKey,
                sourceId: state.sourceId,
                excludeEpisodeKey: state.episodeKey
              }) || null)
            : null,
          state.workKey
            ? (window.electronAPI?.danmakuAlignmentWorkTemplate?.({
                bgmId: state.bgmId,
                workKey: state.workKey,
                excludeEpisodeKey: state.episodeKey
              }) || null)
            : null
        ]);
        if (token !== state.loadToken) return;
        commit('SET_TEMPLATE', template);
        if (record?.alignment) {
          commit('SET_SAVED', { alignment: record.alignment, updatedAt: record.updatedAt, origin: record.origin });
        } else if (suggestion) {
          // 本集还没有校准时，直接沿用同作品同源的历史偏移（自动应用，可在面板撤销）
          commit('SET_ALIGNMENT', { ...createEmptyAlignment(), offset: suggestion.offset });
          commit('SET_AUTO_APPLIED', {
            applied: true,
            reason: `沿用同作品同源历史对齐 ${suggestion.offset > 0 ? '+' : ''}${suggestion.offset} 秒（${suggestion.sampleCount} 集一致）`
          });
          dispatch('persist');
        }
        commit('SET_SUGGESTION', suggestion);
      } catch (error) {
        console.warn('[DanmakuAlignment] 读取校准失败:', error?.message || error);
      } finally {
        if (token === state.loadToken) commit('SET_STATUS', 'ready');
      }
    },

    /** 手动偏移：正数=弹幕往后挪（延迟显示） */
    setOffset({ commit, state, dispatch }, offset) {
      commit('SET_AUTO_APPLIED', {});
      commit('SET_ALIGNMENT', { ...state.alignment, offset });
      dispatch('schedulePersist');
    },

    shiftOffset({ commit, state, dispatch }, delta) {
      const next = Math.max(-60, Math.min(60, Number(state.alignment.offset || 0) + Number(delta || 0)));
      commit('SET_AUTO_APPLIED', {});
      commit('SET_ALIGNMENT', { ...state.alignment, offset: Math.round(next * 10) / 10 });
      dispatch('schedulePersist');
    },

    /** 清空全部校准（含分段锚点）；用户主动归零后本集不再自动应用 */
    reset({ commit, dispatch }) {
      commit('SET_AUTO_SUPPRESSED', true);
      commit('SET_AUTO_APPLIED', {});
      commit('SET_PENDING_INSERT_START', null);
      commit('SET_PENDING_CUT_START', null);
      commit('SET_DURATION_HINT', null);
      commit('SET_ALIGNMENT', createEmptyAlignment());
      commit('SET_NOTES', []);
      dispatch('schedulePersist');
    },

    /** 用已采集的检测结果推导一份对齐配置（应用但不落库，等用户确认/继续微调后自动落库） */
    deriveFromDetections({ commit, state, dispatch }) {
      const { alignment, notes } = deriveAlignmentFromDetections({
        videoIntro: state.detections.videoIntro,
        adRanges: state.detections.adRanges,
        canonicalIntroLength: state.template.introLength || state.detections.canonicalIntroLength,
        danmakuContentStart: state.danmakuAnchors.contentStart,
        base: state.alignment
      });
      commit('SET_AUTO_APPLIED', {});
      commit('SET_ALIGNMENT', alignment);
      commit('SET_NOTES', notes);
      dispatch('schedulePersist');
    },

    /**
     * 自动对齐：检测结果到位后由弹幕层触发，无需用户点按钮。
     *
     * 只在「证据明确」时应用，避免把弹幕整体搬错：
     *  - 弹幕锚点 + 视频片头（DNA）都在 → 直接算整体偏移；
     *  - 有 HLS 明确广告标记 → 补插入区间；
     *  - 有作品片头模板 + 视频片头 → 判断本集片头是否被剪短/加长。
     * 没有片头检测、只靠锚点时，用「弹幕最晚时间 vs 视频时长」校验确实少了约 anchor 秒，
     * 否则宁可不自动（DNA 漏检时也不会误移）。
     * 用户手动校准过（savedOrigin=manual）或已撤销（autoSuppressed）时不覆盖。
     */
    autoAlignFromDetections({ commit, state, dispatch }, { videoDuration = 0, maxCommentTime = 0 } = {}) {
      if (!state.episodeKey || state.autoSuppressed) return false;
      if (state.savedOrigin === 'manual') return false;
      const anchor = state.danmakuAnchors.contentStart;
      const intro = state.detections.videoIntro;
      const adRanges = state.detections.adRanges || [];
      const templateLength = state.template.introLength || 0;
      if (anchor === null && !intro && adRanges.length === 0) return false;

      if (anchor !== null && !intro) {
        const gap = Number(maxCommentTime) - Number(videoDuration);
        const expected = Number(anchor) || 0;
        if (!(expected > 5 && gap > expected * 0.5)) return false;
      }

      const { alignment, notes } = deriveAlignmentFromDetections({
        videoIntro: intro,
        adRanges,
        // 模板只在「视频片头确实检测到」时参与比较，否则无法区分剪短与漏检
        canonicalIntroLength: intro ? templateLength : 0,
        danmakuContentStart: anchor,
        base: state.alignment
      });
      if (isAlignmentEmpty(alignment)) return false;
      if (JSON.stringify(alignment) === JSON.stringify(state.alignment)) return false;

      commit('SET_ALIGNMENT', alignment);
      commit('SET_NOTES', notes);
      commit('SET_AUTO_APPLIED', {
        applied: true,
        reason: notes.join('；') || '按检测结果自动对齐'
      });
      dispatch('persist');
      return true;
    },

    /** 撤销自动对齐：清空本集校准并抑制后续自动应用 */
    undoAutoAlign({ commit, dispatch }) {
      commit('SET_AUTO_SUPPRESSED', true);
      commit('SET_AUTO_APPLIED', {});
      commit('SET_ALIGNMENT', createEmptyAlignment());
      commit('SET_NOTES', []);
      dispatch('persist');
    },

    /** 记录弹幕侧锚点（弹幕加载完成后调用；不自动改动用户已有校准） */
    ingestDanmakuComments({ commit }, comments = []) {
      commit('SET_DANMAKU_ANCHORS', inferDanmakuContentStart(comments));
    },

    /**
     * 一键打点：用户播到「正片开始」时调用，用弹幕侧锚点直接算出整体偏移。
     * 用户只需识别「片头结束了」，不需要比对任何一条弹幕。
     */
    markContentStart({ commit, state, dispatch }, videoTime) {
      const contentStart = state.danmakuAnchors.contentStart;
      if (contentStart === null || contentStart === undefined) return false;
      const offset = Math.round((Number(videoTime) - contentStart) * 10) / 10;
      commit('SET_AUTO_APPLIED', {});
      commit('SET_ALIGNMENT', { ...state.alignment, offset });
      commit('SET_NOTES', [
        `已按「此刻画面 = 正片开始」校准：弹幕整体${offset >= 0 ? '后' : '前'}移 ${Math.abs(offset)} 秒（弹幕版正片起点 ${formatClock(contentStart)}）`
      ]);
      dispatch('schedulePersist');
      return true;
    },

    /**
     * 弹幕对照校准：用户选了一条「明显属于此刻画面」的弹幕，用它的原始时间戳反推偏移。
     * 精度最高，也最适合自动锚点失灵时兜底。
     */
    alignToComment({ commit, state, dispatch }, { commentTime, videoTime } = {}) {
      const canonical = Number(commentTime);
      const current = Number(videoTime);
      if (!Number.isFinite(canonical) || !Number.isFinite(current)) return false;
      const offset = Math.round((current - canonical) * 10) / 10;
      commit('SET_AUTO_APPLIED', {});
      commit('SET_ALIGNMENT', { ...state.alignment, offset });
      commit('SET_NOTES', [
        `已按对照弹幕校准：把 ${formatClock(canonical)} 的弹幕对齐到画面 ${formatClock(current)}，弹幕整体${offset >= 0 ? '后' : '前'}移 ${Math.abs(offset)} 秒`
      ]);
      dispatch('schedulePersist');
      return true;
    },

    /** 沿用同源历史偏移（只取偏移值，锚点仍按当前集检测） */
    applySuggestion({ commit, state, dispatch }) {
      if (!state.suggestion) return;
      commit('SET_AUTO_APPLIED', {});
      commit('SET_ALIGNMENT', { ...state.alignment, offset: state.suggestion.offset });
      dispatch('schedulePersist');
    },

    /** 手动标记插入区间：在当前画面点「起点」，广告结束处点「终点」 */
    markInsertStart({ commit }, time) {
      commit('SET_PENDING_INSERT_START', Math.max(0, Math.round((Number(time) || 0) * 10) / 10));
    },

    markInsertEnd({ commit, state, dispatch }, time) {
      if (state.pendingInsertStart === null) return;
      const next = addInsertRange(state.alignment, state.pendingInsertStart, time);
      commit('SET_PENDING_INSERT_START', null);
      if (isAlignmentEmpty(next) || next.inserts.length === state.alignment.inserts.length) return;
      commit('SET_AUTO_APPLIED', {});
      commit('SET_ALIGNMENT', next);
      dispatch('schedulePersist');
    },

    cancelPendingInsert({ commit }) {
      commit('SET_PENDING_INSERT_START', null);
    },

    /**
     * 手动标记删减区间：用于「中段被剪辑、且没有自动信号」的场景。
     * 起点取官方时间轴上被删的第一帧，终点取被删的最后一帧。
     */
    markCutStart({ commit }, time) {
      commit('SET_PENDING_CUT_START', Math.max(0, Math.round((Number(time) || 0) * 10) / 10));
    },

    markCutEnd({ commit, state, dispatch }, time) {
      if (state.pendingCutStart === null) return;
      const next = addCutRange(state.alignment, state.pendingCutStart, time);
      commit('SET_PENDING_CUT_START', null);
      if (next.cuts.length === state.alignment.cuts.length) return;
      commit('SET_AUTO_APPLIED', {});
      commit('SET_ALIGNMENT', next);
      dispatch('schedulePersist');
    },

    cancelPendingCut({ commit }) {
      commit('SET_PENDING_CUT_START', null);
    },

    /** 删除第 index 段区间（标错时单条撤销，不用整体归零） */
    removeRange({ commit, state, dispatch }, { kind, index } = {}) {
      if (kind !== 'cuts' && kind !== 'inserts') return;
      const next = removeRangeAt(state.alignment, kind, index);
      if (JSON.stringify(next) === JSON.stringify(state.alignment)) return;
      commit('SET_AUTO_APPLIED', {});
      commit('SET_ALIGNMENT', next);
      dispatch('schedulePersist');
    },

    /**
     * 时长差提示：视频比弹幕覆盖范围短/长多少秒。
     * 没有锚点、没有片头检测时，这是唯一还能用的全局信号。
     */
    evaluateDurationGap({ commit }, { videoDuration = 0, danmakuEnd = 0 } = {}) {
      const video = Number(videoDuration) || 0;
      const end = Number(danmakuEnd) || 0;
      if (!(video > 60) || !(end > 60)) {
        commit('SET_DURATION_HINT', null);
        return;
      }
      const gap = Math.round((end - video) * 10) / 10;
      commit('SET_DURATION_HINT', Math.abs(gap) < 15
        ? null
        : { gap, videoDuration: video, danmakuEnd: end });
    },

    /** 把时长差按「删了片头」解释：弹幕整体前移 gap 秒 */
    applyDurationGapAsIntroCut({ commit, state, dispatch }) {
      const hint = state.durationHint;
      if (!hint || hint.gap <= 0) return;
      const offset = Math.round(-hint.gap * 10) / 10;
      commit('SET_AUTO_APPLIED', {});
      commit('SET_ALIGNMENT', { ...state.alignment, offset });
      commit('SET_NOTES', [
        `视频比弹幕覆盖范围短 ${hint.gap} 秒，已按时长差把弹幕整体前移 ${hint.gap} 秒（若实际是删了片尾，请用「归零」后改标删减段）`
      ]);
      commit('SET_DURATION_HINT', null);
      dispatch('persist');
    },

    dismissDurationHint({ commit }) {
      commit('SET_DURATION_HINT', null);
    },

    /** 防抖落库：播放中的连续微调只写一次 */
    schedulePersist({ dispatch }) {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        persistTimer = null;
        dispatch('persist');
      }, 800);
    },

    async persist({ state, commit }) {
      if (!state.episodeKey) return null;
      const origin = state.autoApplied ? 'auto' : 'manual';
      try {
        const result = await window.electronAPI?.danmakuAlignmentSave?.({
          episodeKey: state.episodeKey,
          workKey: state.workKey,
          bgmId: state.bgmId,
          episodeNumber: state.episodeNumber,
          sourceId: state.sourceId,
          alignment: state.alignment,
          origin
        });
        if (result?.record) {
          commit('SET_SAVED', {
            alignment: result.record.alignment,
            updatedAt: result.record.updatedAt,
            origin: result.record.origin
          });
        } else {
          // 空配置等价于删除
          commit('SET_SAVED', { alignment: createEmptyAlignment() });
        }
        return result;
      } catch (error) {
        console.warn('[DanmakuAlignment] 保存校准失败:', error?.message || error);
        return null;
      }
    }
  }
};