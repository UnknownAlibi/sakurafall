import {
  normalizeAlignment,
  createEmptyAlignment,
  deriveAlignmentFromDetections,
  describeAlignment,
  isAlignmentEmpty,
  addInsertRange
} from '../../utils/danmakuAlignment.js';

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
    loadToken: 0,
    status: 'idle' // idle | ready
  },

  getters: {
    alignment: state => state.alignment,
    summary: state => describeAlignment(state.alignment),
    isCalibrated: state => !isAlignmentEmpty(state.alignment),
    hasUnsavedChange: state => JSON.stringify(state.alignment) !== JSON.stringify(state.savedAlignment),
    hasDetections: state => !!(state.detections.videoIntro || (state.detections.adRanges || []).length),
    detections: state => state.detections,
    notes: state => state.notes,
    suggestion: state => state.suggestion,
    pendingInsertStart: state => state.pendingInsertStart
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

    SET_SAVED(state, { alignment, updatedAt = 0 }) {
      state.savedAlignment = normalizeAlignment(alignment);
      state.alignment = normalizeAlignment(alignment);
      state.savedAt = updatedAt;
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

    SET_PENDING_INSERT_START(state, seconds = null) {
      state.pendingInsertStart = seconds === null ? null : Number(seconds);
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
      commit('SET_ALIGNMENT', createEmptyAlignment());
      commit('SET_SAVED', { alignment: createEmptyAlignment() });
      if (!state.episodeKey) return;
      const token = state.loadToken;

      try {
        const [record, suggestion] = await Promise.all([
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
            : null
        ]);
        if (token !== state.loadToken) return;
        if (record?.alignment) {
          commit('SET_SAVED', { alignment: record.alignment, updatedAt: record.updatedAt });
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
      commit('SET_ALIGNMENT', { ...state.alignment, offset });
      dispatch('schedulePersist');
    },

    shiftOffset({ commit, state, dispatch }, delta) {
      const next = Math.max(-60, Math.min(60, Number(state.alignment.offset || 0) + Number(delta || 0)));
      commit('SET_ALIGNMENT', { ...state.alignment, offset: Math.round(next * 10) / 10 });
      dispatch('schedulePersist');
    },

    /** 清空全部校准（含分段锚点） */
    reset({ commit, dispatch }) {
      commit('SET_ALIGNMENT', createEmptyAlignment());
      commit('SET_NOTES', []);
      dispatch('schedulePersist');
    },

    /** 用已采集的检测结果推导一份对齐配置（应用但不落库，等用户确认/继续微调后自动落库） */
    deriveFromDetections({ commit, state, dispatch }) {
      const { alignment, notes } = deriveAlignmentFromDetections({
        videoIntro: state.detections.videoIntro,
        adRanges: state.detections.adRanges,
        canonicalIntroLength: state.detections.canonicalIntroLength,
        base: state.alignment
      });
      commit('SET_ALIGNMENT', alignment);
      commit('SET_NOTES', notes);
      dispatch('schedulePersist');
    },

    /** 沿用同源历史偏移（只取偏移值，锚点仍按当前集检测） */
    applySuggestion({ commit, state, dispatch }) {
      if (!state.suggestion) return;
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
      commit('SET_ALIGNMENT', next);
      dispatch('schedulePersist');
    },

    cancelPendingInsert({ commit }) {
      commit('SET_PENDING_INSERT_START', null);
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
      try {
        const result = await window.electronAPI?.danmakuAlignmentSave?.({
          episodeKey: state.episodeKey,
          workKey: state.workKey,
          bgmId: state.bgmId,
          episodeNumber: state.episodeNumber,
          sourceId: state.sourceId,
          alignment: state.alignment
        });
        if (result?.record) {
          commit('SET_SAVED', { alignment: result.record.alignment, updatedAt: result.record.updatedAt });
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