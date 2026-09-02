import { normalizeSeekStepSeconds } from '../../utils/playerPreferences.js';

const state = {
    theme: 'light',
    themePackId: 'sakurafall-default',
    customCss: '',
    uiEffectsMode: 'balanced',
    videoQuality: 'high',
    routePreference: 'stability',   // SakuraRoute P1: 稳定优先 / 清晰优先 / 低延迟优先
    autoPlay: true,
    rememberPlaybackRate: true,
    seekStepSeconds: 10,
    requestTimeout: 30,
    maxConcurrentConnections: 5,
    cacheSize: 1000,
    autoCleanCache: true,
    serviceMode: 'cloud', // cloud: 使用 SakuraFall 服务；local: 完全直连/公开镜像兜底
    proxy: '', // 代理地址，如 'http://127.0.0.1:7890'；空表示不走代理
    bangumiMirror: '', // Bangumi API 镜像基址，空表示官方 API + 自动公共镜像兜底
    // Phase 7: per-service 网络策略（direct / proxy / system）
    // 默认：Bangumi/弹幕/以图搜番/图片走代理，视频源与播放流直连
    networkPolicies: {
        bangumi: 'proxy',
        cms: 'direct',
        video: 'direct',
        danmaku: 'proxy',
        'trace-moe': 'proxy',
        image: 'proxy'
    },
    mpvPath: '',
    enableAnime4K: true,
    anime4kShaderPaths: '',
    anime4kPreset: 'balanced',  // Phase 6: Anime4K 预设（light/balanced/quality）
    // ===== 弹幕设置 =====
    enableDanmaku: false,           // 弹幕总开关
    danmakuFontSize: 20,            // 字号 12-36
    danmakuOpacity: 1.0,            // 不透明度 0.1-1.0
    danmakuSpeed: 1.0,              // 速度倍率 0.5-2.0
    danmakuDisplayArea: 0.75,       // 显示区域比例 0.25-1.0
    danmakuProviders: {
        bilibili: true,
        acfun: true,
        dandanplay: true,
        custom: true
    },
    danmakuCustomEndpoint: '',
    danmakuCustomToken: '',
    // dandanplay 凭证（用户自行注册）
    dandanplayAppId: '',
    dandanplayAppSecret: '',
    // ===== 番剧更新提醒设置 =====
    enableUpdateReminder: true,        // 是否启用更新提醒
    updateReminderInterval: 60,        // 检查间隔（分钟），最小 10
    // ===== 字幕设置 =====
    enableSubtitle: false,          // 字幕总开关
    subtitleFontSize: 24,           // 字号 12-48
    subtitleOpacity: 1.0,           // 不透明度 0.1-1.0
    subtitleBottomOffset: 80,       // 距底部偏移 0-300
    openSubtitlesApiKey: ''         // OpenSubtitles API Key（可选）
};

// saveSettings 防抖：多个 updateX action 短时间内合并为一次 localStorage 写入
let _saveTimer = null;
const SAVE_DEBOUNCE_MS = 300;

const mutations = {
    SET_THEME(state, theme) {
        state.theme = theme;
    },
    SET_THEME_PACK_ID(state, id) {
        state.themePackId = id;
    },
    SET_CUSTOM_CSS(state, css) {
        state.customCss = css;
    },
    SET_UI_EFFECTS_MODE(state, mode) {
        state.uiEffectsMode = mode;
    },
    SET_VIDEO_QUALITY(state, quality) {
        state.videoQuality = quality;
    },
    SET_ROUTE_PREFERENCE(state, val) {
        const allowed = ['stability', 'quality', 'latency'];
        const normalized = String(val || '').toLowerCase();
        state.routePreference = allowed.includes(normalized) ? normalized : 'stability';
    },
    SET_AUTO_PLAY(state, autoPlay) {
        state.autoPlay = autoPlay;
    },
    SET_REMEMBER_PLAYBACK_RATE(state, val) {
        state.rememberPlaybackRate = val;
    },
    SET_SEEK_STEP_SECONDS(state, val) {
        state.seekStepSeconds = normalizeSeekStepSeconds(val);
    },
    SET_REQUEST_TIMEOUT(state, val) {
        state.requestTimeout = val;
    },
    SET_MAX_CONCURRENT_CONNECTIONS(state, val) {
        state.maxConcurrentConnections = val;
    },
    SET_CACHE_SIZE(state, val) {
        state.cacheSize = val;
    },
    SET_AUTO_CLEAN_CACHE(state, val) {
        state.autoCleanCache = val;
    },
    SET_SERVICE_MODE(state, val) {
        state.serviceMode = val === 'local' ? 'local' : 'cloud';
    },
    SET_PROXY(state, val) {
        state.proxy = val;
    },
    SET_BANGUMI_MIRROR(state, val) {
        state.bangumiMirror = val;
    },
    SET_NETWORK_POLICIES(state, val) {
        state.networkPolicies = { ...state.networkPolicies, ...val };
    },
    SET_MPV_PATH(state, val) {
        state.mpvPath = val;
    },
    SET_ENABLE_ANIME4K(state, val) {
        state.enableAnime4K = val;
    },
    SET_ANIME4K_SHADER_PATHS(state, val) {
        state.anime4kShaderPaths = val;
    },
    SET_ANIME4K_PRESET(state, val) {
        state.anime4kPreset = val;
    },
    SET_ENABLE_DANMAKU(state, val) {
        state.enableDanmaku = val;
    },
    SET_DANMAKU_FONT_SIZE(state, val) {
        state.danmakuFontSize = val;
    },
    SET_DANMAKU_OPACITY(state, val) {
        state.danmakuOpacity = val;
    },
    SET_DANMAKU_SPEED(state, val) {
        state.danmakuSpeed = val;
    },
    SET_DANMAKU_DISPLAY_AREA(state, val) {
        state.danmakuDisplayArea = val;
    },
    SET_DANMAKU_PROVIDERS(state, val) {
        state.danmakuProviders = { ...state.danmakuProviders, ...(val || {}) };
    },
    SET_DANMAKU_CUSTOM_ENDPOINT(state, val) {
        state.danmakuCustomEndpoint = String(val || '').trim();
    },
    SET_DANMAKU_CUSTOM_TOKEN(state, val) {
        state.danmakuCustomToken = String(val || '').trim();
    },
    SET_DANDANPLAY_APP_ID(state, val) {
        state.dandanplayAppId = val;
    },
    SET_DANDANPLAY_APP_SECRET(state, val) {
        state.dandanplayAppSecret = val;
    },
    SET_ENABLE_SUBTITLE(state, val) {
        state.enableSubtitle = val;
    },
    SET_SUBTITLE_FONT_SIZE(state, val) {
        state.subtitleFontSize = val;
    },
    SET_SUBTITLE_OPACITY(state, val) {
        state.subtitleOpacity = val;
    },
    SET_SUBTITLE_BOTTOM_OFFSET(state, val) {
        state.subtitleBottomOffset = val;
    },
    SET_OPENSUBTITLES_API_KEY(state, val) {
        state.openSubtitlesApiKey = val;
    },
    SET_ENABLE_UPDATE_REMINDER(state, val) {
        state.enableUpdateReminder = val;
    },
    SET_UPDATE_REMINDER_INTERVAL(state, val) {
        state.updateReminderInterval = val;
    },
    SET_SETTINGS(state, settings) {
        const providerDefaults = { ...state.danmakuProviders };
        Object.assign(state, settings);
        state.serviceMode = settings?.serviceMode === 'local' ? 'local' : 'cloud';
        state.danmakuProviders = { ...providerDefaults, ...(settings?.danmakuProviders || {}) };
        state.seekStepSeconds = normalizeSeekStepSeconds(settings?.seekStepSeconds);
    }
};

const actions = {
    async loadSettings({ commit }) {
        try {
            const settings = JSON.parse(localStorage.getItem('app-settings') || '{}');
            const migratedKey = 'ui-effects-balanced-migration-v1';
            if (!localStorage.getItem(migratedKey)) {
                if (!settings.uiEffectsMode || settings.uiEffectsMode === 'anime') {
                    settings.uiEffectsMode = 'balanced';
                }
                localStorage.setItem(migratedKey, '1');
                localStorage.setItem('app-settings', JSON.stringify({ ...state, ...settings }));
            }
            commit('SET_SETTINGS', settings);
        } catch (error) {
            console.error('加载设置失败:', error);
        }
    },

    async saveSettings({ state }) {
        // 300ms 防抖：连续多个 updateX action 合并为一次 localStorage 写入
        if (_saveTimer) clearTimeout(_saveTimer);
        return new Promise((resolve) => {
            _saveTimer = setTimeout(() => {
                _saveTimer = null;
                try {
                    localStorage.setItem('app-settings', JSON.stringify(state));
                    resolve(true);
                } catch (error) {
                    console.error('保存设置失败:', error);
                    resolve(false);
                }
            }, SAVE_DEBOUNCE_MS);
        });
    },

    updateTheme({ commit, dispatch }, theme) {
        commit('SET_THEME', theme);
        dispatch('saveSettings');
    },

    updateThemePackId({ commit, dispatch }, id) {
        commit('SET_THEME_PACK_ID', id);
        dispatch('saveSettings');
    },

    updateCustomCss({ commit, dispatch }, css) {
        commit('SET_CUSTOM_CSS', String(css || '').slice(0, 128 * 1024));
        dispatch('saveSettings');
    },

    updateUiEffectsMode({ commit, dispatch }, mode) {
        commit('SET_UI_EFFECTS_MODE', mode);
        dispatch('saveSettings');
    },

    updateVideoQuality({ commit, dispatch }, quality) {
        commit('SET_VIDEO_QUALITY', quality);
        dispatch('saveSettings');
    },

    updateRoutePreference({ commit, dispatch }, preference) {
        commit('SET_ROUTE_PREFERENCE', preference);
        dispatch('saveSettings');
    },

    updateAutoPlay({ commit, dispatch }, autoPlay) {
        commit('SET_AUTO_PLAY', autoPlay);
        dispatch('saveSettings');
    },

    updateRememberPlaybackRate({ commit, dispatch }, val) {
        commit('SET_REMEMBER_PLAYBACK_RATE', val);
        dispatch('saveSettings');
    },

    updateSeekStepSeconds({ commit, dispatch }, val) {
        commit('SET_SEEK_STEP_SECONDS', val);
        dispatch('saveSettings');
    },

    updateRequestTimeout({ commit, dispatch }, val) {
        commit('SET_REQUEST_TIMEOUT', val);
        dispatch('saveSettings');
    },

    updateMaxConcurrentConnections({ commit, dispatch }, val) {
        commit('SET_MAX_CONCURRENT_CONNECTIONS', val);
        dispatch('saveSettings');
    },

    updateCacheSize({ commit, dispatch }, val) {
        commit('SET_CACHE_SIZE', val);
        dispatch('saveSettings');
    },

    updateAutoCleanCache({ commit, dispatch }, val) {
        commit('SET_AUTO_CLEAN_CACHE', val);
        dispatch('saveSettings');
    },

    updateServiceMode({ commit, dispatch }, val) {
        commit('SET_SERVICE_MODE', val);
        dispatch('saveSettings');
    },

    updateProxy({ commit, dispatch }, val) {
        commit('SET_PROXY', val);
        dispatch('saveSettings');
    },

    updateNetworkPolicies({ commit, dispatch }, val) {
        commit('SET_NETWORK_POLICIES', val);
        dispatch('saveSettings');
    },

    updateBangumiMirror({ commit, dispatch }, val) {
        commit('SET_BANGUMI_MIRROR', val);
        dispatch('saveSettings');
    },

    updateMpvPath({ commit, dispatch }, val) {
        commit('SET_MPV_PATH', val);
        dispatch('saveSettings');
    },

    updateEnableAnime4K({ commit, dispatch }, val) {
        commit('SET_ENABLE_ANIME4K', val);
        dispatch('saveSettings');
    },

    updateAnime4kShaderPaths({ commit, dispatch }, val) {
        commit('SET_ANIME4K_SHADER_PATHS', val);
        dispatch('saveSettings');
    },

    updateAnime4kPreset({ commit, dispatch }, val) {
        commit('SET_ANIME4K_PRESET', val);
        dispatch('saveSettings');
    },

    // ===== 弹幕设置 actions =====
    updateEnableDanmaku({ commit, dispatch }, val) {
        commit('SET_ENABLE_DANMAKU', val);
        dispatch('saveSettings');
    },
    updateDanmakuFontSize({ commit, dispatch }, val) {
        commit('SET_DANMAKU_FONT_SIZE', val);
        dispatch('saveSettings');
    },
    updateDanmakuOpacity({ commit, dispatch }, val) {
        commit('SET_DANMAKU_OPACITY', val);
        dispatch('saveSettings');
    },
    updateDanmakuSpeed({ commit, dispatch }, val) {
        commit('SET_DANMAKU_SPEED', val);
        dispatch('saveSettings');
    },
    updateDanmakuDisplayArea({ commit, dispatch }, val) {
        commit('SET_DANMAKU_DISPLAY_AREA', val);
        dispatch('saveSettings');
    },
    updateDanmakuProviders({ commit, dispatch }, val) {
        commit('SET_DANMAKU_PROVIDERS', val);
        dispatch('saveSettings');
    },
    updateDanmakuCustomEndpoint({ commit, dispatch }, val) {
        commit('SET_DANMAKU_CUSTOM_ENDPOINT', val);
        dispatch('saveSettings');
    },
    updateDanmakuCustomToken({ commit, dispatch }, val) {
        commit('SET_DANMAKU_CUSTOM_TOKEN', val);
        dispatch('saveSettings');
    },
    updateDandanplayAppId({ commit, dispatch }, val) {
        commit('SET_DANDANPLAY_APP_ID', val);
        dispatch('saveSettings');
    },
    updateDandanplayAppSecret({ commit, dispatch }, val) {
        commit('SET_DANDANPLAY_APP_SECRET', val);
        dispatch('saveSettings');
    },

    // ===== 字幕设置 actions =====
    updateEnableSubtitle({ commit, dispatch }, val) {
        commit('SET_ENABLE_SUBTITLE', val);
        dispatch('saveSettings');
    },
    updateSubtitleFontSize({ commit, dispatch }, val) {
        commit('SET_SUBTITLE_FONT_SIZE', val);
        dispatch('saveSettings');
    },
    updateSubtitleOpacity({ commit, dispatch }, val) {
        commit('SET_SUBTITLE_OPACITY', val);
        dispatch('saveSettings');
    },
    updateSubtitleBottomOffset({ commit, dispatch }, val) {
        commit('SET_SUBTITLE_BOTTOM_OFFSET', val);
        dispatch('saveSettings');
    },
    updateOpenSubtitlesApiKey({ commit, dispatch }, val) {
        commit('SET_OPENSUBTITLES_API_KEY', val);
        dispatch('saveSettings');
    },

    // ===== 番剧更新提醒设置 actions =====
    updateEnableUpdateReminder({ commit, dispatch }, val) {
        commit('SET_ENABLE_UPDATE_REMINDER', val);
        dispatch('saveSettings');
        // 同步配置到主进程的提醒服务
        if (window.electronAPI && window.electronAPI.updateReminderConfigure) {
            window.electronAPI.updateReminderConfigure({ enabled: !!val });
        }
    },
    updateUpdateReminderInterval({ commit, dispatch }, val) {
        const minutes = Math.max(10, Math.floor(Number(val) || 60));
        commit('SET_UPDATE_REMINDER_INTERVAL', minutes);
        dispatch('saveSettings');
        // 同步配置到主进程的提醒服务
        if (window.electronAPI && window.electronAPI.updateReminderConfigure) {
            window.electronAPI.updateReminderConfigure({ intervalMinutes: minutes });
        }
    }
};

const getters = {
    theme: state => state.theme,
    themePackId: state => state.themePackId,
    customCss: state => state.customCss,
    uiEffectsMode: state => state.uiEffectsMode,
    videoQuality: state => state.videoQuality,
    routePreference: state => state.routePreference,
    autoPlay: state => state.autoPlay,
    rememberPlaybackRate: state => state.rememberPlaybackRate,
    seekStepSeconds: state => state.seekStepSeconds,
    requestTimeout: state => state.requestTimeout,
    maxConcurrentConnections: state => state.maxConcurrentConnections,
    cacheSize: state => state.cacheSize,
    autoCleanCache: state => state.autoCleanCache,
    serviceMode: state => state.serviceMode,
    proxy: state => state.proxy,
    bangumiMirror: state => state.bangumiMirror,
    networkPolicies: state => state.networkPolicies,
    mpvPath: state => state.mpvPath,
    enableAnime4K: state => state.enableAnime4K,
    anime4kShaderPaths: state => state.anime4kShaderPaths,
    anime4kPreset: state => state.anime4kPreset,
    // 弹幕
    enableDanmaku: state => state.enableDanmaku,
    danmakuFontSize: state => state.danmakuFontSize,
    danmakuOpacity: state => state.danmakuOpacity,
    danmakuSpeed: state => state.danmakuSpeed,
    danmakuDisplayArea: state => state.danmakuDisplayArea,
    danmakuProviders: state => state.danmakuProviders,
    danmakuCustomEndpoint: state => state.danmakuCustomEndpoint,
    danmakuCustomToken: state => state.danmakuCustomToken,
    dandanplayAppId: state => state.dandanplayAppId,
    dandanplayAppSecret: state => state.dandanplayAppSecret,
    // 字幕
    enableSubtitle: state => state.enableSubtitle,
    subtitleFontSize: state => state.subtitleFontSize,
    subtitleOpacity: state => state.subtitleOpacity,
    subtitleBottomOffset: state => state.subtitleBottomOffset,
    openSubtitlesApiKey: state => state.openSubtitlesApiKey,
    // 番剧更新提醒
    enableUpdateReminder: state => state.enableUpdateReminder,
    updateReminderInterval: state => state.updateReminderInterval
};

export default {
    namespaced: true,
    state,
    mutations,
    actions,
    getters
};
