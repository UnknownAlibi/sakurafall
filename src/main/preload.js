const { contextBridge, ipcRenderer } = require('electron');

// Sandboxed preload scripts cannot import local helper modules, so this IPC
// boundary conversion intentionally stays self-contained.
function toIpcSafeValue(value, seen = new WeakSet(), depth = 0) {
    if (value === null || value === undefined) return value;

    const valueType = typeof value;
    if (valueType === 'string' || valueType === 'boolean') return value;
    if (valueType === 'number') return Number.isFinite(value) ? value : null;
    if (valueType === 'bigint') return String(value);
    if (valueType === 'function' || valueType === 'symbol') return undefined;
    if (depth >= 20) return null;

    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) {
        return { name: value.name, message: value.message, stack: value.stack };
    }
    if (seen.has(value)) return null;
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map(item => toIpcSafeValue(item, seen, depth + 1));
    }

    const result = {};
    let keys = [];
    try {
        keys = Object.keys(value);
    } catch (_) {
        return result;
    }

    for (const key of keys) {
        try {
            const item = toIpcSafeValue(value[key], seen, depth + 1);
            if (item !== undefined) result[key] = item;
        } catch (_) {
            // Ignore getters and proxy properties that cannot be read safely.
        }
    }
    return result;
}

// 与主进程保持一致的开发环境判断：通过 execPath 是否为 electron.exe 判定
// 仅靠 NODE_ENV 不可靠（打包后若未显式设置，'production' 可能不存在）
const isElectronDev = /electron(?:\.exe)?$/i.test(process.execPath);

// 暴露安全的API给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
    // 系统信息
    platform: process.platform,
    isDev: isElectronDev,
    appVersion: () => ipcRenderer.invoke('app-version'),
    runtimeDiagnosticsReport: (type, details) => ipcRenderer.invoke('runtime-diagnostics-report', type, details),
    runtimeDiagnosticsSummary: () => ipcRenderer.invoke('runtime-diagnostics-summary'),
    runtimeDiagnosticsOpenFolder: () => ipcRenderer.invoke('runtime-diagnostics-open-folder'),
    databaseHealth: () => ipcRenderer.invoke('database-health'),

    // 窗口控制
    minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
    maximizeWindow: () => ipcRenderer.invoke('maximize-window'),
    closeWindow: () => ipcRenderer.invoke('close-window'),
    isMaximized: () => ipcRenderer.invoke('is-maximized'),
    onWindowStateChanged: (callback) => {
        const handler = (_, isMaximized) => callback(isMaximized);
        ipcRenderer.on('window-state-changed', handler);
        return () => ipcRenderer.removeListener('window-state-changed', handler);
    },

    // 独立播放窗口
    openPlayerWindow: (videoData) => ipcRenderer.invoke('open-player-window', toIpcSafeValue(videoData)),
    updatePlayerWindow: (windowId, videoData) => ipcRenderer.invoke('update-player-window', windowId, toIpcSafeValue(videoData)),
    closePlayerWindow: (windowId) => ipcRenderer.invoke('close-player-window', windowId),
    playerGetData: () => ipcRenderer.invoke('player-get-data'),
    playerToggleTop: () => ipcRenderer.invoke('player-toggle-top'),
    playerIsTop: () => ipcRenderer.invoke('player-is-top'),
    // Phase 9: 迷你模式
    playerToggleMini: () => ipcRenderer.invoke('player-toggle-mini'),
    playerIsMini: () => ipcRenderer.invoke('player-is-mini'),
    showMainRoute: (route) => ipcRenderer.invoke('show-main-route', String(route || '/settings')),
    onNavigateMainRoute: (callback) => {
        const handler = (_, route) => callback(route);
        ipcRenderer.on('navigate-main-route', handler);
        return () => ipcRenderer.removeListener('navigate-main-route', handler);
    },
    // 监听主进程"加载新视频"通知（复用窗口时由 createPlayerWindow 触发）
    onPlayerLoadNew: (callback) => {
        const handler = (_, data) => callback(data);
        ipcRenderer.on('player-load-new', handler);
        return () => ipcRenderer.removeListener('player-load-new', handler);
    },

    // 文件操作
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    selectFile: (filters) => ipcRenderer.invoke('select-file', filters),
    openExternal: (url) => ipcRenderer.invoke('open-external-url', url),

    // AI 增强播放（mpv + Anime4K shader）
    enhancedPlayerCheck: (options) => ipcRenderer.invoke('enhanced-player-check', toIpcSafeValue(options)),
    enhancedPlayerOpen: (options) => ipcRenderer.invoke('enhanced-player-open', toIpcSafeValue(options)),
    enhancedPlayerInstall: () => ipcRenderer.invoke('enhanced-player-install'),
    // Phase 6: Anime4K 预设（light / balanced / quality）
    enhancedPlayerPresets: () => ipcRenderer.invoke('enhanced-player-presets'),

    // Phase 5: 播放解析状态机
    // payload: { sourceId, sourceName, sourceType, sourceAnimeId, episode, anime }
    // 返回: { success, url, headers, sourceId, episodeId, qualityHint, requiresProxy, resolvedAt }
    //    或 { success: false, error, reason, category, hint, userMessage, elapsedMs }
    playbackResolve: (payload, options) => ipcRenderer.invoke(
        'playback-resolve',
        toIpcSafeValue(payload),
        toIpcSafeValue(options)
    ),
    playbackCancelAll: () => ipcRenderer.invoke('playback-cancel-all'),
    playbackClearResolveCache: () => ipcRenderer.invoke('playback-clear-resolve-cache'),

    // Phase 7: 网络与 TUN 分流策略
    networkPolicyGet: () => ipcRenderer.invoke('network-policy-get'),
    networkPolicyUpdate: (policies) => ipcRenderer.invoke('network-policy-update', policies),
    networkTestProxyPort: () => ipcRenderer.invoke('network-test-proxy-port'),
    networkTestBangumi: () => ipcRenderer.invoke('network-test-bangumi'),
    networkTestPlaybackSource: () => ipcRenderer.invoke('network-test-playback-source'),
    networkTestDanmaku: () => ipcRenderer.invoke('network-test-danmaku'),
    networkTestTraceMoe: () => ipcRenderer.invoke('network-test-trace-moe'),
    networkTestM3u8: (url, referer) => ipcRenderer.invoke('network-test-m3u8', url, referer),
    networkDetectTun: () => ipcRenderer.invoke('network-detect-tun'),
    networkRunDiagnostics: () => ipcRenderer.invoke('network-run-diagnostics'),
    networkDomainSuggestions: () => ipcRenderer.invoke('network-domain-suggestions'),

    // Phase 4: 插件式源规则系统（XPath 源）
    pluginGetList: () => ipcRenderer.invoke('plugin-get-list'),
    pluginGetDetail: (id) => ipcRenderer.invoke('plugin-get-detail', id),
    pluginAdd: (raw) => ipcRenderer.invoke('plugin-add', raw),
    pluginUpdate: (id, raw) => ipcRenderer.invoke('plugin-update', id, raw),
    pluginRemove: (id) => ipcRenderer.invoke('plugin-remove', id),
    pluginSetEnabled: (id, enabled) => ipcRenderer.invoke('plugin-set-enabled', id, enabled),
    pluginExport: () => ipcRenderer.invoke('plugin-export'),
    pluginImport: (jsonString, options) => ipcRenderer.invoke('plugin-import', jsonString, options),
    pluginImportInstalledRules: () => ipcRenderer.invoke('plugin-import-installed-rules'),
    pluginSaveFile: (defaultName) => ipcRenderer.invoke('plugin-save-file', defaultName),
    pluginLoadFile: () => ipcRenderer.invoke('plugin-load-file'),
    pluginSearch: (id, keyword, options) => ipcRenderer.invoke('plugin-search', id, keyword, options),
    pluginSearchAll: (keyword, options) => ipcRenderer.invoke('plugin-search-all', keyword, options),
    pluginParseDetail: (id, pageUrl, options) => ipcRenderer.invoke('plugin-parse-detail', id, pageUrl, options),
    pluginTest: (id) => ipcRenderer.invoke('plugin-test', id),
    pluginTestAll: () => ipcRenderer.invoke('plugin-test-all'),

    // Unified source-provider API. Provider ids are namespaced, for example
    // cms:provider-id and xpath:rule-id.
    sourceProviderList: (options) => ipcRenderer.invoke('source-provider-list', options),
    sourceProviderSearch: (providerId, keyword, options) => ipcRenderer.invoke('source-provider-search', providerId, keyword, options),
    sourceProviderSearchAll: (keyword, options) => ipcRenderer.invoke('source-provider-search-all', keyword, options),
    sourceProviderDetail: (providerId, reference, options) => ipcRenderer.invoke('source-provider-detail', providerId, reference, options),
    sourceProviderCategories: (providerId) => ipcRenderer.invoke('source-provider-categories', providerId),
    sourceProviderCatalog: (providerId, options) => ipcRenderer.invoke('source-provider-catalog', providerId, options),
    sourceProviderTest: (providerId) => ipcRenderer.invoke('source-provider-test', providerId),
    sourceProviderReportPlayback: (providerId, result) => ipcRenderer.invoke('source-provider-report-playback', providerId, result),

    // BT 资源搜索（蜜柑计划 / 动漫花园，仅检索与磁力展示，不托管内容）
    btSearch: (keyword, options) => ipcRenderer.invoke('bt-search', String(keyword || ''), options || {}),
    // BT 边播边下（主进程 WebTorrent + 本地 HTTP 流服务器）
    btStreamPrepare: (magnet) => ipcRenderer.invoke('bt-stream-prepare', String(magnet || '')),
    btStreamOpen: (magnet, filePath) => ipcRenderer.invoke('bt-stream-open', String(magnet || ''), String(filePath || '')),
    btStreamStatus: (magnet) => ipcRenderer.invoke('bt-stream-status', String(magnet || '')),
    btStreamStop: (magnet) => ipcRenderer.invoke('bt-stream-stop', String(magnet || '')),
    btStreamCacheInfo: () => ipcRenderer.invoke('bt-stream-cache-info'),
    btStreamClearCache: () => ipcRenderer.invoke('bt-stream-clear-cache'),
    mediaLibraryAddLocal: () => ipcRenderer.invoke('media-library-add-local'),

    // 可分享的片源包与界面主题包
    sourcePackImportFile: (options) => ipcRenderer.invoke('source-pack-import-file', options),
    sourcePackExportFile: (metadata) => ipcRenderer.invoke('source-pack-export-file', metadata),
    sourcePackList: () => ipcRenderer.invoke('source-pack-list'),
    sourcePackGet: (id) => ipcRenderer.invoke('source-pack-get', id),
    sourcePackRemove: (id) => ipcRenderer.invoke('source-pack-remove', id),
    sourcePackCheckUpdates: () => ipcRenderer.invoke('source-pack-check-updates'),
    sourcePackUpdate: (id) => ipcRenderer.invoke('source-pack-update', id),
    themePackList: () => ipcRenderer.invoke('theme-pack-list'),
    themePackGet: (id) => ipcRenderer.invoke('theme-pack-get', id),
    themePackImportFile: () => ipcRenderer.invoke('theme-pack-import-file'),
    themePackRemove: (id) => ipcRenderer.invoke('theme-pack-remove', id),

    // 版本信息
    getVersions: () => ipcRenderer.invoke('get-versions'),

    // 缓存操作
    clearCache: () => ipcRenderer.invoke('clear-cache'),
    imageCacheGetCover: (url, options) => ipcRenderer.invoke('image-cache-get-cover', url, options),
    imageCacheBatchLookup: (urls, options) => ipcRenderer.invoke('image-cache-batch-lookup', urls, options),
    imageCacheGetAll: () => ipcRenderer.invoke('image-cache-get-all'),

    // 网络配置
    setNetworkConfig: (config) => ipcRenderer.invoke('set-network-config', config),

    // 本地数据库API
    getAnimeList: (page, limit, search) => ipcRenderer.invoke('get-anime-list', page, limit, search),
    getAnimeDetail: (animeId) => ipcRenderer.invoke('get-anime-detail', animeId),
    searchAnime: (keyword, limit) => ipcRenderer.invoke('search-anime', keyword, limit),
    getPopularTypes: () => ipcRenderer.invoke('get-popular-types'),

    // Bangumi (番组计划) 在线数据源API
    bangumiGetCalendar: () => ipcRenderer.invoke('bangumi-get-calendar'),
    bangumiGetAll: () => ipcRenderer.invoke('bangumi-get-all'),
    bangumiGetSeason: (year, season, page) => ipcRenderer.invoke('bangumi-get-season', year, season, page),
    bangumiSearch: (keyword, page) => ipcRenderer.invoke('bangumi-search', keyword, page),
    bangumiGetDetail: (bgmId) => ipcRenderer.invoke('bangumi-get-detail', bgmId),
    bangumiGetCharacters: (bgmId) => ipcRenderer.invoke('bangumi-get-characters', bgmId),
    bangumiGetAiredEpisodeCount: (bgmId) => ipcRenderer.invoke('bangumi-get-aired-episode-count', bgmId),
    bangumiGetStaff: (bgmId) => ipcRenderer.invoke('bangumi-get-staff', bgmId),
    bangumiGetComments: (bgmId, page) => ipcRenderer.invoke('bangumi-get-comments', bgmId, page),
    bangumiTest: () => ipcRenderer.invoke('bangumi-test'),
    bangumiGetSchedule: () => ipcRenderer.invoke('bangumi-get-schedule'),

    // SubjectService（Bangumi 资料主干，Phase 1）
    subjectTrending: (options) => ipcRenderer.invoke('subject-trending', options),
    subjectCalendar: () => ipcRenderer.invoke('subject-calendar'),
    subjectSeason: (year, quarter, page) => ipcRenderer.invoke('subject-season', year, quarter, page),
    subjectSearch: (keyword, page) => ipcRenderer.invoke('subject-search', keyword, page),
    subjectCatalog: (options) => ipcRenderer.invoke('subject-catalog', options),
    subjectBrowse: (options) => ipcRenderer.invoke('subject-browse', options),
    subjectDetail: (bgmId) => ipcRenderer.invoke('subject-detail', bgmId),
    subjectEpisodes: (bgmId, options) => ipcRenderer.invoke('subject-episodes', bgmId, options),

    // SubjectIndexService（P0：本地 Bangumi 索引，本地查询为主）
    subjectIndexQuery: (filters) => ipcRenderer.invoke('subject-index-query', filters),
    subjectIndexGet: (bgmId) => ipcRenderer.invoke('subject-index-get', bgmId),
    subjectIndexWeekday: (weekday) => ipcRenderer.invoke('subject-index-weekday', weekday),
    subjectIndexSyncSeason: (year, season) => ipcRenderer.invoke('subject-index-sync-season', year, season),
    subjectIndexSyncCalendar: () => ipcRenderer.invoke('subject-index-sync-calendar'),
    subjectIndexSyncDetail: (bgmId) => ipcRenderer.invoke('subject-index-sync-detail', bgmId),
    subjectIndexStatus: () => ipcRenderer.invoke('subject-index-status'),

    // 弹幕 (dandanplay + 本地 XML 导入) API
    danmakuSetCredentials: (appId, appSecret) => ipcRenderer.invoke('danmaku-set-credentials', appId, appSecret),
    danmakuIsReady: () => ipcRenderer.invoke('danmaku-is-ready'),
    danmakuSearch: (keyword) => ipcRenderer.invoke('danmaku-search', keyword),
    danmakuGetComments: (episodeId) => ipcRenderer.invoke('danmaku-get-comments', episodeId),
    danmakuParseXml: (filePath) => ipcRenderer.invoke('danmaku-parse-xml', filePath),
    danmakuTest: () => ipcRenderer.invoke('danmaku-test'),

    // Compatibility catalog backed by whichever installed source pack declares fallback-catalog.
    playbackSourceGetCategories: () => ipcRenderer.invoke('playback-source-categories'),
    playbackSourceGetList: (categoryId, page) => ipcRenderer.invoke('playback-source-list', categoryId, page),
    playbackSourceGetDetail: (id) => ipcRenderer.invoke('playback-source-detail', id),
    playbackSourceResolveUrl: (url) => ipcRenderer.invoke('playback-source-resolve-url', url),
    playbackSourceSearch: (keyword, page) => ipcRenderer.invoke('playback-source-search', keyword, page),
    playbackSourceTest: () => ipcRenderer.invoke('playback-source-test'),

    // 通用 CMS API（多源支持）
    cmsMultiGetSources: () => ipcRenderer.invoke('cms-get-sources'),
    cmsMultiReloadSources: () => ipcRenderer.invoke('cms-reload-sources'),
    cmsMultiGetConfigInfo: () => ipcRenderer.invoke('cms-get-config-info'),
    cmsMultiOpenConfigFile: () => ipcRenderer.invoke('cms-open-config-file'),
    cmsMultiSetSource: (sourceId) => ipcRenderer.invoke('cms-set-source', sourceId),
    cmsMultiGetCategories: () => ipcRenderer.invoke('cms-get-categories'),
    cmsMultiGetList: (categoryId, page, options) => ipcRenderer.invoke('cms-get-list', categoryId, page, options),
    cmsMultiGetDetail: (id, options) => ipcRenderer.invoke('cms-get-detail', id, options),
    cmsMultiSearch: (keyword, page) => ipcRenderer.invoke('cms-search', keyword, page),
    cmsMultiSearchAllSources: (keyword) => ipcRenderer.invoke('cms-search-all-sources', keyword),
    cmsMultiSearchAllSourcesWithStatus: (keyword, options) => ipcRenderer.invoke('cms-search-all-sources-with-status', keyword, options),
    cmsMultiSelectBestEpisodeSource: (keyword, target) => ipcRenderer.invoke('cms-select-best-episode-source', keyword, target),
    cmsReportSourcePlayback: (sourceId, result) => ipcRenderer.invoke('cms-report-source-playback', sourceId, result),
    cmsMultiSearchInSource: (sourceId, keyword, page) => ipcRenderer.invoke('cms-search-in-source', sourceId, keyword, page),
    cmsMultiTest: () => ipcRenderer.invoke('cms-test'),
    cmsMultiTestAll: () => ipcRenderer.invoke('cms-test-all'),
    // 清理 CMS 接口缓存，options: { sourceId?, kind?, expiredOnly? }，不传则清空全部
    cmsCacheClear: (options) => ipcRenderer.invoke('cms-cache-clear', options),
    // 数据源规则编辑器：增删改 / 导入 / 导出
    cmsAddSource: (sourceConfig) => ipcRenderer.invoke('cms-add-source', sourceConfig),
    cmsUpdateSource: (sourceId, config) => ipcRenderer.invoke('cms-update-source', sourceId, config),
    cmsRemoveSource: (sourceId) => ipcRenderer.invoke('cms-remove-source', sourceId),
    cmsExportSources: () => ipcRenderer.invoke('cms-export-sources'),
    cmsImportSources: (jsonString, options) => ipcRenderer.invoke('cms-import-sources', jsonString, options),
    cmsSaveSourcesFile: (defaultName) => ipcRenderer.invoke('cms-save-sources-file', defaultName),
    cmsLoadSourcesFile: () => ipcRenderer.invoke('cms-load-sources-file'),

    // 收藏 / 追番 API
    favoriteAdd: (anime) => ipcRenderer.invoke('favorite-add', anime),
    favoriteRemove: (animeId, source) => ipcRenderer.invoke('favorite-remove', animeId, source),
    favoriteList: (page, limit) => ipcRenderer.invoke('favorite-list', page, limit),
    favoriteCheck: (animeId, source) => ipcRenderer.invoke('favorite-check', animeId, source),
    favoriteCheckBatch: (items) => ipcRenderer.invoke('favorite-check-batch', items),

    // 播放历史 / 观看进度 API
    historyUpdate: (data) => ipcRenderer.invoke('history-update', data),
    historyRecent: (limit) => ipcRenderer.invoke('history-recent', limit),
    historyProgress: (animeId, source) => ipcRenderer.invoke('history-progress', animeId, source),
    historyRemove: (animeId, source) => ipcRenderer.invoke('history-remove', animeId, source),
    historyClear: () => ipcRenderer.invoke('history-clear'),

    // 应用更新检查
    updateCheck: () => ipcRenderer.invoke('update-check'),
    updateGetVersion: () => ipcRenderer.invoke('update-get-version'),
    updateGetUrl: () => ipcRenderer.invoke('update-get-url'),
    updateSetUrl: (url) => ipcRenderer.invoke('update-set-url', url),
    updateOpenDownload: (url) => ipcRenderer.invoke('update-open-download', url),
    // 应用内更新：下载安装包（进度经 onUpdateDownloadProgress 推送）→ 运行安装并重启
    updateDownload: (url) => ipcRenderer.invoke('update-download', url),
    updateInstall: (filePath) => ipcRenderer.invoke('update-install', filePath),
    onUpdateDownloadProgress: (callback) => {
        const handler = (_, progress) => callback(progress);
        ipcRenderer.on('update-download-progress', handler);
        return () => ipcRenderer.removeListener('update-download-progress', handler);
    },
    // 监听主进程推送的"发现新版本"事件（启动时静默检查触发）
    onUpdateAvailable: (callback) => {
        const handler = (_, info) => callback(info);
        ipcRenderer.on('update-available', handler);
        return () => ipcRenderer.removeListener('update-available', handler);
    },

    // 以图搜番 (trace.moe)
    // 返回: { success, results: [{ anilistId, filename, episode, from, to, similarity, video, image }], frameCount, error }
    traceMoeSearchFile: (imagePath) => ipcRenderer.invoke('trace-moe-search-file', imagePath),
    traceMoeSearchClipboard: () => ipcRenderer.invoke('trace-moe-search-clipboard'),
    traceMoeSearchUrl: (imageUrl) => ipcRenderer.invoke('trace-moe-search-url', imageUrl),
    traceMoeSearchDataUrl: (dataUrl) => ipcRenderer.invoke('trace-moe-search-data-url', dataUrl),

    // 番剧下载 API
    // payload: { anime, episode, url }
    downloadAdd: (payload) => ipcRenderer.invoke('download-add', payload),
    downloadCancel: (id) => ipcRenderer.invoke('download-cancel', id),
    downloadPause: (id) => ipcRenderer.invoke('download-pause', id),
    downloadResume: (id) => ipcRenderer.invoke('download-resume', id),
    downloadList: () => ipcRenderer.invoke('download-list'),
    downloadRemove: (id) => ipcRenderer.invoke('download-remove', id),
    // 选择下载目录，返回 { canceled, dir }
    downloadSelectDir: () => ipcRenderer.invoke('download-select-dir'),
    // 在系统文件管理器中打开下载目录
    downloadOpenDir: (dirPath) => ipcRenderer.invoke('download-open-dir', dirPath),
    // 在系统文件管理器中定位已下载文件
    downloadOpenFile: (filePath) => ipcRenderer.invoke('download-open-file', filePath),
    // 监听主进程推送的下载进度事件（任务状态变化时触发）
    // 回调收到 task 对象：{ id, status, progress, speed, ... }
    // 返回取消监听的函数
    onDownloadProgress: (callback) => {
        const handler = (_, task) => callback(task);
        ipcRenderer.on('on-download-progress', handler);
        return () => ipcRenderer.removeListener('on-download-progress', handler);
    },

    // 番剧更新提醒 API
    // 手动触发一次检查，返回 { checked, newReminders }
    updateReminderCheck: () => ipcRenderer.invoke('update-reminder-check'),
    // 获取提醒列表与上次检查时间，返回 { reminders, lastCheckTime }
    updateReminderList: () => ipcRenderer.invoke('update-reminder-list'),
    // 标记指定番剧的提醒为已读
    updateReminderMarkRead: (animeId, source) => ipcRenderer.invoke('update-reminder-mark-read', animeId, source),
    // 清空所有提醒
    updateReminderClear: () => ipcRenderer.invoke('update-reminder-clear'),
    // 配置提醒服务（启用/禁用、检查间隔）
    updateReminderConfigure: (options) => ipcRenderer.invoke('update-reminder-configure', options),
    // 监听主进程推送的新提醒事件，回调收到 reminders 数组
    // 返回取消监听的函数
    onUpdateReminder: (callback) => {
        const handler = (_, reminders) => callback(reminders);
        ipcRenderer.on('on-update-reminder', handler);
        return () => ipcRenderer.removeListener('on-update-reminder', handler);
    },
    // 监听系统通知点击后主进程发来的跳转事件
    // 回调收到 { animeId, source, name }，由渲染进程路由到对应番剧
    // 返回取消监听的函数
    onUpdateReminderOpen: (callback) => {
        const handler = (_, info) => callback(info);
        ipcRenderer.on('update-reminder-open', handler);
        return () => ipcRenderer.removeListener('update-reminder-open', handler);
    },

    // 字幕（SRT/VTT/ASS 解析 + OpenSubtitles 搜索）API
    // 选择并解析本地字幕文件，返回 { success, cues, format, filePath, canceled?, error? }
    subtitleParseFile: () => ipcRenderer.invoke('subtitle-parse-file'),
    // 解析字幕内容字符串，返回 { success, cues, format, error? }
    subtitleParseContent: (content, filePath) => ipcRenderer.invoke('subtitle-parse-content', content, filePath),
    // 在线搜索字幕（OpenSubtitles），返回 { success, results, error? }
    subtitleSearch: (keyword, language) => ipcRenderer.invoke('subtitle-search', keyword, language),
    // 下载在线字幕内容，返回 { success, content, error? }
    subtitleDownload: (fileId) => ipcRenderer.invoke('subtitle-download', fileId),
    // 设置 OpenSubtitles API Key
    subtitleSetApiKey: (apiKey) => ipcRenderer.invoke('subtitle-set-api-key', apiKey),

    // DLNA 投屏 API
    // 搜索局域网内的 DLNA 设备，返回 { success, devices: [{ id, name, location, controlUrl }] }
    dlnaDiscover: (options) => ipcRenderer.invoke('dlna-discover', options),
    // 投屏播放，payload: { deviceId, url, title, headers?, mime? }
    dlnaCast: (payload) => ipcRenderer.invoke('dlna-cast', payload),
    // 暂停投屏
    dlnaPause: (deviceId) => ipcRenderer.invoke('dlna-pause', deviceId),
    // 恢复投屏
    dlnaResume: (deviceId) => ipcRenderer.invoke('dlna-resume', deviceId),
    // 停止投屏
    dlnaStop: (deviceId) => ipcRenderer.invoke('dlna-stop', deviceId),
    // 跳转到指定秒数
    dlnaSeek: (deviceId, seconds) => ipcRenderer.invoke('dlna-seek', deviceId, seconds),
    // 获取当前播放位置和总时长，返回 { success, position, duration }
    dlnaGetPosition: (deviceId) => ipcRenderer.invoke('dlna-get-position', deviceId),

    // 一起看（同步播放）API
    // 创建房间（主机模式），payload: { roomName, videoInfo }
    // 返回 { success, roomCode, roomName, port, isHost, memberId, memberCount }
    wtCreateRoom: (payload) => ipcRenderer.invoke('wt-create-room', payload),
    // 加入房间（成员模式），payload: { roomCode, hostAddress }
    // 返回 { success, roomCode, isHost, memberId, hostAddress }
    wtJoinRoom: (payload) => ipcRenderer.invoke('wt-join-room', payload),
    // 离开房间，返回 { success, wasInRoom }
    wtLeaveRoom: () => ipcRenderer.invoke('wt-leave-room'),
    // 广播播放状态（仅主机），state: { isPlaying, currentTime, duration, episodeIndex, episodeTitle, playbackRate }
    // 返回 { success, sent }
    wtBroadcastState: (state) => ipcRenderer.invoke('wt-broadcast-state', state),
    // 发送聊天消息，返回 { success }
    wtSendChat: (text) => ipcRenderer.invoke('wt-send-chat', text),
    // 查询当前房间信息，返回 { success, roomCode, isHost, memberCount, ... }
    wtGetRoomInfo: () => ipcRenderer.invoke('wt-get-room-info'),
    // 监听主进程推送的"一起看"消息事件
    // 回调收到 msg 对象：{ type: 'sync'|'chat'|'joined'|'member-joined'|'member-left'|'room-closed'|'reconnecting'|'disconnected'|'left'|'error', ... }
    // 返回取消监听的函数
    onWtMessage: (callback) => {
        const handler = (_, msg) => callback(msg);
        ipcRenderer.on('on-wt-message', handler);
        return () => ipcRenderer.removeListener('on-wt-message', handler);
    }
});
