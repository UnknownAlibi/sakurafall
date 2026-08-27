const state = {
  currentVideo: null,
  isPlaying: false,
  isFullscreen: false,
  volume: 1,
  currentTime: 0,
  duration: 0,
  playbackRate: 1
};

const mutations = {
  SET_CURRENT_VIDEO(state, video) {
    state.currentVideo = video;
  },
  SET_PLAYING(state, playing) {
    state.isPlaying = playing;
  },
  SET_FULLSCREEN(state, fullscreen) {
    state.isFullscreen = fullscreen;
  },
  SET_VOLUME(state, volume) {
    state.volume = volume;
  },
  SET_CURRENT_TIME(state, time) {
    state.currentTime = time;
  },
  SET_DURATION(state, duration) {
    state.duration = duration;
  },
  SET_PLAYBACK_RATE(state, rate) {
    state.playbackRate = rate;
  }
};

const actions = {
  playVideo({ commit }, video) {
    commit('SET_PLAYING', false);
    commit('SET_CURRENT_VIDEO', video);
    commit('SET_CURRENT_TIME', 0);
    commit('SET_PLAYING', true);
    // 播放历史由 VideoPlayer 组件的定时器 + beforeUnmount 统一写入
    // 这里不再 fire-and-forget 重复写，避免双重 SQLite 写入阻塞主进程
  },
  setPlaying({ commit }, playing) {
    commit('SET_PLAYING', playing);
  },
  setCurrentTime({ commit }, time) {
    commit('SET_CURRENT_TIME', time);
  },
  setDuration({ commit }, duration) {
    commit('SET_DURATION', duration);
  },
  setVolume({ commit }, volume) {
    commit('SET_VOLUME', volume);
  },
  setFullscreen({ commit }, fullscreen) {
    commit('SET_FULLSCREEN', fullscreen);
  },
  setPlaybackRate({ commit }, rate) {
    commit('SET_PLAYBACK_RATE', rate);
  },
  stopVideo({ commit }) {
    commit('SET_CURRENT_VIDEO', null);
    commit('SET_PLAYING', false);
    commit('SET_CURRENT_TIME', 0);
  }
};

const getters = {
  currentVideo: state => state.currentVideo,
  isPlaying: state => state.isPlaying,
  isFullscreen: state => state.isFullscreen,
  volume: state => state.volume,
  currentTime: state => state.currentTime,
  duration: state => state.duration,
  playbackRate: state => state.playbackRate || 1
};

export default {
  namespaced: true,
  state,
  mutations,
  actions,
  getters
};