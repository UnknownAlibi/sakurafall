const { app, BrowserWindow, Menu, ipcMain, dialog, session, shell, nativeImage, protocol, clipboard } = require('electron');
const processStartedAt = Date.now();

// 窗口全屏管理（GPU 合成兼容开关 + 全屏 IPC + 状态同步）抽离至独立模块
const { applyFullscreenCompatFlags, registerWindowFullscreenIpc, bindFullscreenStateSync } = require('./window-fullscreen');
// 窗口状态持久化（尺寸/位置/最大化）抽离至独立模块
const { loadWindowState, applyWindowState, bindWindowStatePersistence } = require('./window-state');
// GPU 合成偏好（设置页开关落盘到 userData）
const { resolveGpuCompositingPreferenceFile } = require('./utils/gpuCompositingPreference');
const { isPathInside, isMpvExecutablePath, isSupportedImagePath } = require('./utils/pathGuards');
const { registerGpuIpc } = require('./ipc/gpu');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

protocol.registerSchemesAsPrivileged([{
    scheme: 'sakurafall-cache',
    privileges: { standard: true, secure: true, corsEnabled: true, supportFetchAPI: true }
}, {
    // stream: true 必须——video/audio 元素直接加载自定义协议媒体（直链 mp4 走
    // video.src）需要流式特权，否则 Chromium 报 "Media load rejected by URL
    // safety check"，播放器误判为源不可用并自动换源（HLS 不受影响：hls.js 走
    // XHR+MSE，不经过 video 元素的 URL 加载管线）。
    scheme: 'sakurafall-media',
    privileges: { standard: true, secure: true, corsEnabled: true, supportFetchAPI: true, stream: true }
}]);

// 防止 Electron 无终端时 console.log 写入断开的管道导致 EPIPE 崩溃
const _origLog = console.log;
const _origWarn = console.warn;
const _origError = console.error;
console.log = function (...args) {
    try { _origLog.apply(console, args); } catch (e) { if (e.code !== 'EPIPE') throw e; }
};
console.warn = function (...args) {
    try { _origWarn.apply(console, args); } catch (e) { if (e.code !== 'EPIPE') throw e; }
};
console.error = function (...args) {
    try { _origError.apply(console, args); } catch (e) { if (e.code !== 'EPIPE') throw e; }
};
const path = require('path');
const fs = require('fs');
const { fileURLToPath } = require('url');
const { SERVICE_BASE_URL } = require('./config/serviceEndpoints');

const smokeUserDataArg = process.argv.find(arg => arg.startsWith('--smoke-user-data='));
if (smokeUserDataArg) {
    app.setPath('userData', path.resolve(smokeUserDataArg.slice('--smoke-user-data='.length)));
}
const isSmokeTest = process.argv.includes('--smoke-test');
const isSmokeOffline = process.argv.includes('--smoke-offline');
if (isSmokeOffline) process.env.SAKURAFALL_OFFLINE_MODE = '1';
const smokeReportArg = process.argv.find(arg => arg.startsWith('--smoke-report='));
const smokeReportPath = smokeReportArg ? path.resolve(smokeReportArg.slice('--smoke-report='.length)) : '';

// GPU 合成偏好（设置页开关）：必须在 app ready 前读取并决定是否禁用 GPU 合成。
// 文件路径只解析一次，保证启动读取与运行时写入指向同一个 userData。
const GPU_COMPOSITING_PREFERENCE_FILE = resolveGpuCompositingPreferenceFile(app.getPath('userData'));
applyFullscreenCompatFlags({ preferenceFile: GPU_COMPOSITING_PREFERENCE_FILE });

// 判断当前是否从 electron.exe 启动（开发模式）
// 某些环境下 app.isPackaged 在 electron . 时也会返回 true，需要辅助判断
const isElectronDev = /electron(?:\.exe)?$/i.test(process.execPath);

// 生产环境禁用普通调试日志，保留错误日志
const isDevMain = process.env.NODE_ENV === 'development' || isElectronDev;
if (!isDevMain && app.isPackaged) {
    console.log = () => {};
}

const AnimeDatabase = require('./services/AnimeDatabase');
const bangumiApi = require('./services/BangumiApi');
const subjectService = require('./services/SubjectService');
const subjectIndexService = require('./services/SubjectIndexService');
const { subjectCoverBackfill } = require('./services/SubjectCoverBackfill');
const cmsApiService = require('./services/CmsApiService');
const danmakuApi = require('./services/DanmakuApi');
const danmakuAlignmentStore = require('./services/DanmakuAlignmentStore');
const imageCacheService = require('./services/ImageCacheService');
imageCacheService.setImageProcessor((buffer, options = {}) => {
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) throw new Error('unsupported image data');
    const resized = image.resize({
        width: Math.min(720, Math.max(160, parseInt(options.width, 10) || 360)),
        quality: 'good'
    });
    return {
        buffer: resized.toJPEG(82),
        contentType: 'image/jpeg',
        ext: '.jpg'
    };
});
const updateChecker = require('./services/UpdateChecker');
const traceMoeApi = require('./services/TraceMoeApi');
const Downloader = require('./services/Downloader');
const UpdateReminder = require('./services/UpdateReminder');
const watchTogetherService = require('./services/WatchTogetherService');
const playbackResolverService = require('./services/PlaybackResolverService');
const networkPolicyService = require('./services/NetworkPolicyService');
const HttpClient = require('./utils/HttpClient');
const { SourceRuleEngine } = require('./services/SourceRuleEngine');
const { SourcePluginManager } = require('./services/SourcePluginManager');
const { SourceProviderRegistry } = require('./services/sources/SourceProviderRegistry');
const { SharePageResolverService } = require('./services/sources/SharePageResolverService');
const { MediaLibraryService } = require('./services/sources/MediaLibraryService');
const { CustomizationPackService } = require('./services/CustomizationPackService');
const { RuntimeDiagnosticsService } = require('./services/RuntimeDiagnosticsService');
const { SettingsSecretStore } = require('./services/SettingsSecretStore');
const { BtSearchService } = require('./services/bt/BtSearchService');
const { registerBtIpc } = require('./ipc/bt');
const { registerCmsIpc } = require('./ipc/cmsSources');
const { registerCustomizationPackIpc } = require('./ipc/customizationPacks');
const { registerDanmakuIpc } = require('./ipc/danmaku');
const { registerLibraryIpc } = require('./ipc/library');
const { registerMetadataIpc } = require('./ipc/metadata');
const { registerNetworkIpc } = require('./ipc/network');
const { registerSettingsSecretsIpc } = require('./ipc/settingsSecrets');
const { registerPlaybackHealthIpc } = require('./ipc/playbackHealth');
const { registerSourceProviderIpc } = require('./ipc/sourceProviders');
const { registerUpdateIpc } = require('./ipc/update');
const playerSvc = require('./services/LazyPlayerServices');
const videoStreamProxy = require('./services/VideoStreamProxyService');

// 创建数据库实例
const animeDb = new AnimeDatabase();

// Phase 4: 插件式源规则引擎（XPath 源）
// 与 CmsApiService 并存：CMS 源走 cms-* 通道，插件源走 plugin-* 通道
const pluginHttpClient = new HttpClient({ timeout: 15000 });
const sourceRuleEngine = new SourceRuleEngine({ httpClient: pluginHttpClient });
const sourcePluginManager = new SourcePluginManager({ ruleEngine: sourceRuleEngine });
const sharePageResolver = new SharePageResolverService();
const mediaLibraryService = new MediaLibraryService();
const sourceProviderRegistry = new SourceProviderRegistry({ cmsApiService, sourcePluginManager, sharePageResolver, mediaLibraryService });
const customizationPackService = new CustomizationPackService({ cmsApiService, sourcePluginManager, sharePageResolver, mediaLibraryService });
const runtimeDiagnostics = new RuntimeDiagnosticsService({ baseDir: path.join(app.getPath('userData'), 'logs'), appVersion: app.getVersion() });
// BT 资源搜索（蜜柑/dmhy 公开索引站），与插件源共用代理策略
const btHttpClient = new HttpClient({ timeout: 12000 });
const btSearchService = new BtSearchService({ httpClient: btHttpClient });
// btStreamService 由 registerBtIpc 在下方 IPC 注册区创建（需要 secureIpcHandle，避免绕过来源校验）
let btStreamService = null;

// ===== GPU 稳定性防线 =====
// 日志实测：部分 Windows 机器上 GPU 进程每 ~5 秒被 kill 一次无限循环，
// Chromium 每次都回退软件渲染重试，导致界面动画（完整演出档）整体卡顿。
// 三层防御：
// 1. 禁用原生窗口遮挡计算（Chromium 在 Windows 上的已知 GPU 误杀 bug）
// 2. 运行时监控：短时间反复崩溃 → 写标记并自动重启，下次启动禁用硬件加速
// 3. 降级标记短期自动过期，避免一次启动抖动让应用长期停留在软件渲染
const GPU_FLAG_FILE = path.join(app.getPath('userData'), 'gpu-disable-flag.json');
const GPU_FLAG_TTL_MS = 30 * 60 * 1000;
const GPU_CRASH_WINDOW_MS = 30 * 1000;
const GPU_CRASH_THRESHOLD = 3;
const GPU_CRASH_MIN_LOOP_MS = 4 * 1000;
const GPU_FATAL_REASONS = new Set(['abnormal-exit', 'crashed', 'killed', 'oom', 'launch-failed', 'integrity-failure']);

function readGpuDisableFlag() {
    try {
        if (!fs.existsSync(GPU_FLAG_FILE)) return null;
        const data = JSON.parse(fs.readFileSync(GPU_FLAG_FILE, 'utf8'));
        if (!data?.disabledAt || Date.now() - data.disabledAt > GPU_FLAG_TTL_MS) {
            fs.rmSync(GPU_FLAG_FILE, { force: true }); // 过期标记自动清除，重试硬件加速
            return null;
        }
        return data;
    } catch (_) {
        return null;
    }
}

const gpuDisableFlag = readGpuDisableFlag();
if (gpuDisableFlag) {
    app.disableHardwareAcceleration();
    console.log('[GpuGuard] 检测到 GPU 循环崩溃标记，本次启动禁用硬件加速（软件渲染）。标记将过期于:',
        new Date(gpuDisableFlag.disabledAt + GPU_FLAG_TTL_MS).toLocaleString());
} else {
    // Windows 上 Chromium 的窗口遮挡计算可能误判 GPU 挂起并反复 kill GPU 进程
    app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

const gpuCrashTimestamps = [];
let gpuGuardRelaunching = false;
function recordGpuCrash(details) {
    if (details?.type !== 'GPU' || !GPU_FATAL_REASONS.has(details.reason)) return;
    const now = Date.now();
    gpuCrashTimestamps.push(now);
    while (gpuCrashTimestamps.length > 0 && gpuCrashTimestamps[0] < now - GPU_CRASH_WINDOW_MS) {
        gpuCrashTimestamps.shift();
    }
    const crashSpanMs = now - gpuCrashTimestamps[0];
    console.warn(`[GpuGuard] GPU 进程异常退出 (reason=${details.reason}), 近 ${GPU_CRASH_WINDOW_MS / 1000}s 内第 ${gpuCrashTimestamps.length} 次，跨度 ${crashSpanMs}ms`);
    // 启动抖动不算循环崩溃；异常持续数秒才降级到 WARP。
    if (gpuCrashTimestamps.length < GPU_CRASH_THRESHOLD
        || crashSpanMs < GPU_CRASH_MIN_LOOP_MS
        || gpuGuardRelaunching) return;

    gpuGuardRelaunching = true;
    try {
        fs.writeFileSync(GPU_FLAG_FILE, JSON.stringify({
            disabledAt: now,
            crashes: gpuCrashTimestamps.length,
            lastReason: details.reason
        }, null, 2), 'utf8');
        console.error('[GpuGuard] GPU 进程循环崩溃，已写入降级标记，即将重启并以软件渲染模式运行');
        runtimeDiagnostics.captureError('gpu-crash-loop-detected', new Error(`GPU killed ${gpuCrashTimestamps.length}x in ${GPU_CRASH_WINDOW_MS / 1000}s, relaunching with software rendering`));
        app.relaunch();
        app.exit(0);
    } catch (e) {
        console.error('[GpuGuard] 写入标记或重启失败:', e);
        gpuGuardRelaunching = false;
    }
}
// ===== GPU 稳定性防线 END =====

process.on('unhandledRejection', (reason) => {
    runtimeDiagnostics.captureError('main-unhandled-rejection', reason);
    console.error('[Runtime] 未处理的 Promise:', reason);
});

process.on('uncaughtException', (error) => {
    runtimeDiagnostics.captureError('main-uncaught-exception', error);
    console.error('[Runtime] 主进程未捕获异常:', error);
    setTimeout(() => app.exit(1), 50).unref?.();
});

// 番剧下载器实例（在 app.whenReady 中初始化，需要 userData 路径）
let downloader = null;

// 番剧更新提醒实例（在 app.whenReady 中初始化，需要 animeDb 和 cmsApiService）
let updateReminder = null;

// 开发环境检测：electron.exe 启动，或未打包，或显式 NODE_ENV=development
const isDev = isElectronDev || !app.isPackaged || process.env.NODE_ENV === 'development';
const devRendererUrl = 'http://localhost:5173/index.html';
// 主窗口/播放窗口使用 defaultSession：默认拒绝 Web 权限，只放行播放器与复制房间号所需项。
const ALLOWED_SESSION_PERMISSIONS = new Set(['clipboard-sanitized-write', 'clipboard-write', 'fullscreen']);
const appIconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '../../build/icon-v4.ico');

function getBundledExtensionDir(kind) {
    if (app.isPackaged) return path.join(process.resourcesPath, 'extensions', kind);
    return path.join(__dirname, '..', '..', 'extensions', 'bundled', kind);
}
const rendererRoot = path.resolve(__dirname, '../../dist/renderer');
const registerIpcHandler = ipcMain.handle.bind(ipcMain);

function isTrustedRendererUrl(rawUrl) {
    if (!rawUrl) return false;
    try {
        const parsed = new URL(rawUrl);
        if (isDev && parsed.origin === new URL(devRendererUrl).origin) return true;
        if (parsed.protocol !== 'file:') return false;
        const filePath = path.resolve(fileURLToPath(parsed));
        return filePath === rendererRoot || filePath.startsWith(`${rendererRoot}${path.sep}`);
    } catch (_error) {
        return false;
    }
}

function isExternalWebUrl(rawUrl) {
    try {
        const protocolName = new URL(rawUrl).protocol;
        return protocolName === 'magnet:' ? /^magnet:\?xt=urn:btih:[a-z0-9]+/i.test(rawUrl) : protocolName === 'https:' || protocolName === 'http:';
    } catch (_error) {
        return false;
    }
}

function openExternalUrl(rawUrl) {
    if (!isExternalWebUrl(rawUrl)) return Promise.reject(new Error('仅允许 HTTP(S)/磁力链接'));
    return shell.openExternal(rawUrl);
}

// 以图搜番：只读取常见位图，且限制单文件大小，避免渲染器传入任意大文件/非图片。
const MAX_TRACE_MOE_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * 增强播放器选项来自渲染器，mpvPath 不允许指向任意可执行文件。
 * 合法值：mpv.exe / mpvnet.exe / mpv-x86_64.exe 等以 mpv 开头的绝对 .exe 路径。
 */
function normalizeEnhancedPlayerOptions(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) return {};
    const mpvPath = String(options.mpvPath || '').trim();
    if (mpvPath && !isMpvExecutablePath(mpvPath)) {
        throw new Error('mpv 路径无效：请选择 mpv.exe、mpvnet.exe 或其变体');
    }
    return { ...options, mpvPath };
}

/**
 * 下载器相关路径只允许当前下载目录或已知任务的路径/父目录，
 * 避免渲染器把任意文件交给 shell.openPath / showItemInFolder。
 */
function isManagedDownloadPath(target) {
    if (!downloader) return false;
    const resolved = path.resolve(String(target || ''));
    const root = String(downloader.downloadDir || '').trim();
    if (root && isPathInside(root, resolved)) return true;
    for (const task of downloader.tasks.values()) {
        if (!task?.filePath) continue;
        const taskPath = path.resolve(task.filePath);
        if (taskPath === resolved || path.dirname(taskPath) === resolved) return true;
    }
    return false;
}

function secureIpcHandle(channel, listener) {
    registerIpcHandler(channel, (event, ...args) => {
        const senderUrl = event.senderFrame?.url || event.sender?.getURL?.() || '';
        if (!isTrustedRendererUrl(senderUrl)) {
            console.warn(`[IPC] 已阻止非可信页面调用 ${channel}:`, senderUrl);
            throw new Error('IPC sender is not trusted');
        }
        return listener(event, ...args);
    });
}

function protectWebContents(webContents) {
    webContents.setWindowOpenHandler(({ url }) => {
        if (isExternalWebUrl(url)) openExternalUrl(url).catch(() => {});
        return { action: 'deny' };
    });
    webContents.on('will-navigate', (event, url) => {
        if (isTrustedRendererUrl(url)) return;
        event.preventDefault();
        if (isExternalWebUrl(url)) openExternalUrl(url).catch(() => {});
    });
}

const rendererCrashState = new WeakMap();

function finishSmokeTest(success, details = {}) {
    if (!isSmokeTest || finishSmokeTest.completed) return;
    finishSmokeTest.completed = true;
    const report = {
        success: !!success,
        timestamp: new Date().toISOString(),
        appVersion: app.getVersion(),
        details: { ...details, startupMs: Date.now() - processStartedAt }
    };
    runtimeDiagnostics.report('packaged-smoke-test', report);
    if (smokeReportPath) {
        try {
            fs.mkdirSync(path.dirname(smokeReportPath), { recursive: true });
            fs.writeFileSync(smokeReportPath, JSON.stringify(report, null, 2), 'utf8');
        } catch (error) {
            console.error('[SmokeTest] 无法写入报告:', error.message);
        }
    }
    setTimeout(() => app.exit(success ? 0 : 1), 50);
}

function attachWindowDiagnostics(win, role) {
    const webContents = win.webContents;
    win.on('unresponsive', () => runtimeDiagnostics.report('window-unresponsive', { role, url: webContents.getURL() }));
    win.on('responsive', () => runtimeDiagnostics.report('window-responsive', { role }));
    // 捕获渲染进程 console（便于定位 UI 报错）
    webContents.on('console-message', d => {
        try {
            if (d.level >= 2) console.log(`[Renderer:${role}:${d.level}] ${d.message} (${d.sourceId}:${d.lineNumber})`);
        } catch (_) { /* ignore */ }
    });
    webContents.on('render-process-gone', (_event, details) => {
        runtimeDiagnostics.report('render-process-gone', { role, ...details, url: webContents.getURL() });
        if (isSmokeTest) {
            finishSmokeTest(false, { phase: 'renderer', role, ...details });
            return;
        }
        if (details.reason === 'clean-exit' || win.isDestroyed()) return;
        const now = Date.now();
        const previous = rendererCrashState.get(webContents) || { count: 0, timestamp: 0 };
        const state = now - previous.timestamp < 60000
            ? { count: previous.count + 1, timestamp: now }
            : { count: 1, timestamp: now };
        rendererCrashState.set(webContents, state);
        if (state.count === 1) {
            setTimeout(() => {
                if (!win.isDestroyed()) webContents.reload();
            }, 350);
            return;
        }
        dialog.showMessageBox(win, {
            type: 'error',
            title: '页面连续异常',
            message: '页面连续两次意外退出，已停止自动重载。',
            detail: '可以重新加载页面；如果问题再次出现，请在设置中打开诊断日志。',
            buttons: ['重新加载', '退出应用'],
            defaultId: 0,
            cancelId: 1
        }).then(result => {
            if (result.response === 0 && !win.isDestroyed()) webContents.reload();
            else if (result.response === 1) app.quit();
        }).catch(() => {});
    });
}

function configureSmokeTest(win) {
    if (!isSmokeTest) return;
    const timeout = setTimeout(() => {
        finishSmokeTest(false, { phase: 'timeout', message: 'renderer did not finish loading within 30 seconds' });
    }, 30000);
    win.webContents.once('did-finish-load', async () => {
        clearTimeout(timeout);
        try {
            const renderer = await win.webContents.executeJavaScript(`(async () => {
                const api = window.electronAPI;
                await api?.runtimeDiagnosticsReport?.('smoke-probe', { route: location.hash });
                const deadline = Date.now() + 5000;
                while (!document.documentElement.hasAttribute('data-theme-pack') && Date.now() < deadline) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
                const [version, providers, themes, defaultTheme, databaseHealth, diagnostics] = await Promise.all([
                    api?.appVersion?.(),
                    api?.sourceProviderList?.({ includeDisabled: true }),
                    api?.themePackList?.(),
                    api?.themePackGet?.('sakurafall-default'),
                    api?.databaseHealth?.(),
                    api?.runtimeDiagnosticsSummary?.()
                ]);
                const rootStyle = document.documentElement.style;
                return {
                    mounted: Boolean(document.querySelector('#app')),
                    hasBridge: Boolean(api && api.appVersion),
                    title: document.title,
                    route: location.hash,
                    version,
                    providerCount: Array.isArray(providers) ? providers.length : 0,
                    themeCount: Array.isArray(themes) ? themes.length : 0,
                    themePackId: document.documentElement.getAttribute('data-theme-pack'),
                    themeAssetCount: Object.keys(defaultTheme?.content?.assets || {}).length,
                    brandAssetApplied: rootStyle.getPropertyValue('--sakurafall-mark-image').includes('data:image/'),
                    loadingAssetApplied: rootStyle.getPropertyValue('--sakura-loading-sprite-image').includes('data:image/'),
                    databaseHealth,
                    diagnosticFileCount: Array.isArray(diagnostics?.files) ? diagnostics.files.length : 0
                };
            })()`, true);
            const database = animeDb.getHealthStatus();
            const success = renderer.mounted && renderer.hasBridge && renderer.providerCount > 0 && renderer.themeCount > 0 &&
                renderer.themePackId === 'sakurafall-default' && renderer.themeAssetCount >= 8 &&
                renderer.brandAssetApplied && renderer.loadingAssetApplied &&
                renderer.diagnosticFileCount > 0 && renderer.databaseHealth?.integrity === 'ok' && database.integrity === 'ok' &&
                database.schemaVersion === database.expectedSchemaVersion;
            finishSmokeTest(success, { phase: 'ready', renderer, database });
        } catch (error) {
            finishSmokeTest(false, { phase: 'inspection', message: error.message });
        }
    });
}

function loadAppIcon() {
    const icon = nativeImage.createFromPath(appIconPath);
    return icon.isEmpty() ? undefined : icon;
}

// 设置 Windows 任务栏应用标识，确保任务栏图标/分组正确
if (process.platform === 'win32') {
    // 开发版使用带视觉版本的 ID，避免 Windows 继续复用旧图标缓存。
    app.setAppUserModelId(isDev
        ? 'com.sakurafall.app.dev.yingyue.v1'
        : 'com.sakurafall.app.yingyue.v1');
}
app.setName('SakuraFall');

// 保持对窗口对象的全局引用
let mainWindow;
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    });
}
app.on('child-process-gone', (_event, details) => {
    runtimeDiagnostics.report('child-process-gone', details);
    recordGpuCrash(details);
});
// 独立播放窗口集合（支持同时打开多个）
const playerWindows = new Set();
const playbackPressure = require('./utils/playbackPressure')(playerWindows, () => mainWindow);
// 待传递给各播放窗口的视频数据，按 webContents.id 隔离（播放窗口加载后通过 IPC 拉取）
const pendingPlayerDataMap = new Map();

// 全局网络/缓存配置
const appConfig = {
    requestTimeout: 15000,
    maxConcurrentConnections: 5,
    cacheSize: 500,
    autoCleanCache: true,
    proxy: '', // Bangumi 专用代理地址，如 'http://127.0.0.1:7890'；空表示不走代理
    bangumiMirror: '', // Empty value uses the SakuraFall service with upstream fallback.
    serviceMode: 'cloud',
    serviceBaseUrl: SERVICE_BASE_URL
};

function normalizeProxyUrl(proxyUrl) {
    const value = String(proxyUrl || '').trim();
    if (!value) return '';
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
}

function proxyUrlToPacResult(proxyUrl) {
    const normalized = normalizeProxyUrl(proxyUrl);
    if (!normalized) return '';

    try {
        const url = new URL(normalized);
        const host = url.hostname;
        const port = url.port || (url.protocol === 'https:' ? '443' : '80');
        if (!host) return '';

        if (url.protocol === 'socks5:' || url.protocol === 'socks:') {
            return `SOCKS5 ${host}:${port}`;
        }
        if (url.protocol === 'socks4:') {
            return `SOCKS4 ${host}:${port}`;
        }
        if (url.protocol === 'https:') {
            return `HTTPS ${host}:${port}`;
        }
        return `PROXY ${host}:${port}`;
    } catch (error) {
        console.error('[Network] 代理地址格式无效:', proxyUrl, error.message);
        return '';
    }
}

function buildBangumiPacScript(proxyUrl, videoPolicy) {
    const pacProxy = proxyUrlToPacResult(proxyUrl);
    if (!pacProxy) return '';

    // 视频流走代理：渲染进程全部流量（含 hls.js 的 m3u8/ts 视频分片）统一经代理转发
    if (videoPolicy === 'proxy') {
        return `function FindProxyForURL(url, host) { return '${pacProxy}'; }`;
    }

    return `
function FindProxyForURL(url, host) {
  host = String(host || '').toLowerCase();
  if (
    host === 'api.bgm.tv' ||
    host === 'bgm.tv' ||
    host === 'bangumi.tv' ||
    host === 'lain.bgm.tv' ||
    dnsDomainIs(host, '.bgm.tv') ||
    dnsDomainIs(host, '.bangumi.tv') ||
    dnsDomainIs(host, '.lain.bgm.tv')
  ) {
    return '${pacProxy}';
  }
  return 'DIRECT';
}`;
}

// 应用网络与缓存配置
async function applyNetworkConfig(config = {}) {
    const requestTimeout = Math.max(3000, parseInt(config.requestTimeout, 10) || appConfig.requestTimeout);
    const cacheSize = Math.max(50, parseInt(config.cacheSize, 10) || appConfig.cacheSize);
    const autoCleanCache = config.autoCleanCache !== undefined ? !!config.autoCleanCache : appConfig.autoCleanCache;

    appConfig.requestTimeout = requestTimeout;
    appConfig.cacheSize = cacheSize;
    appConfig.autoCleanCache = autoCleanCache;
    if (config.maxConcurrentConnections !== undefined) {
        appConfig.maxConcurrentConnections = Math.max(1, parseInt(config.maxConcurrentConnections, 10) || 5);
    }

    bangumiApi.setTimeout(requestTimeout);
    subjectService.setTimeout(requestTimeout);
    cmsApiService.setTimeout(requestTimeout);
    imageCacheService.setTimeout(requestTimeout);
    traceMoeApi.setTimeout(Math.max(10000, requestTimeout));
    playbackResolverService.setTimeout(Math.max(8000, requestTimeout));
    sharePageResolver.setTimeout(Math.max(8000, requestTimeout));

    // 空代理必须严格表示直连，避免 Windows/代理工具残留的 HTTP_PROXY/HTTPS_PROXY
    // 把“不开代理”的启动状态误导到一个不可用的本地代理端口。
    const configuredProxy = config.proxy !== undefined
        ? config.proxy
        : appConfig.proxy;
    const proxy = normalizeProxyUrl(configuredProxy);
    appConfig.proxy = proxy;

    // 应用 Bangumi API 镜像配置。无代理时，官方 API 配置自动降级为“自动模式”
    // （官方优先 + 公共镜像兜底），避免不开代理时首页直接空白。
    const bangumiMirror = config.bangumiMirror !== undefined
        ? String(config.bangumiMirror || '').trim()
        : (appConfig.bangumiMirror || '');
    const serviceMode = config.serviceMode !== undefined
        ? (config.serviceMode === 'local' ? 'local' : 'cloud')
        : appConfig.serviceMode;
    const activeServiceBaseUrl = serviceMode === 'cloud' ? SERVICE_BASE_URL : '';
    const automaticService = !bangumiMirror && activeServiceBaseUrl;
    const effectiveBangumiMirror = automaticService || ((!proxy && bangumiMirror === 'https://api.bgm.tv') ? '' : bangumiMirror);
    appConfig.bangumiMirror = bangumiMirror;
    appConfig.serviceMode = serviceMode;
    appConfig.serviceBaseUrl = activeServiceBaseUrl;
    bangumiApi.setBaseUrl(effectiveBangumiMirror, {
        allowFallback: !!automaticService,
        fastFail: !!automaticService
    });
    bangumiApi.setCoverProxyBase?.(activeServiceBaseUrl);
    subjectIndexService.setSnapshotBaseUrl(activeServiceBaseUrl);
    updateChecker.setServiceBaseUrl?.(activeServiceBaseUrl);
    watchTogetherService.setRelayBaseUrl?.(activeServiceBaseUrl);
    console.log(`[Network] 数据连接方式: ${serviceMode === 'cloud' ? 'SakuraFall 云服务（带本机回退）' : '本机直连'}`);

    if (proxy) {
        console.log(`[Network] Bangumi 使用代理: ${proxy}（视频源与播放流保持直连）`);
    }
    bangumiApi.setProxy?.(proxy);
    subjectService.setProxy?.(proxy);
    cmsApiService.setProxy?.('');
    // 视频解析与播放流保持直连，与片源包请求策略相互独立。
    playbackResolverService.setProxy?.('');
    sharePageResolver.setProxy?.('');
    // 弹幕 API（dandanplay.net）走与 Bangumi 相同的代理
    danmakuApi.setProxy?.(proxy);
    // BT 边播边下 tracker 走此代理发现节点
    btStreamService?.setProxy?.(proxy);
    // 封面缓存仅对 Bangumi 图片走代理，其它资源站封面保持直连
    imageCacheService.setProxy?.(proxy);
    // 以图搜番（trace.moe）走与 Bangumi 相同的代理
    traceMoeApi.setProxy?.(proxy);
    // 在线字幕（OpenSubtitles）与更新源的 GitHub 回退同为境外请求，共用此代理；
    // 国内服务端更新源保持直连（见 UpdateChecker._clientFor）
    playerSvc.applyProxy?.(proxy);
    updateChecker.setProxy?.(proxy);

    // Phase 7: 同步给 NetworkPolicyService（用于诊断与策略查询）
    networkPolicyService.setProxy(proxy);
    // 应用 per-service 策略覆盖（若有）
    if (config.networkPolicies) {
        networkPolicyService.setPolicies(config.networkPolicies);
    }
    // 视频流线路策略：'proxy' 时渲染进程（hls.js 视频分片）也走应用代理；
    // 'direct'/'system' 保持直连（system 与 Bangumi 专用代理无法在同一个 PAC 内混合表达）
    const videoPolicy = networkPolicyService.getPolicy('video');
    // 主进程直链流转发（mp4 / 直链 HLS 经 sakurafall-media://proxy）同样遵循该策略，
    // 否则「走代理」只对渲染进程的 hls.js 分片生效，被墙的直链依旧打不开
    videoStreamProxy.setProxy(videoPolicy === 'proxy' ? proxy : '');
    // 下载走视频线路：m3u8 清单、分片与 ffmpeg 都与播放使用同一代理策略
    downloader?.setProxy(videoPolicy === 'proxy' ? proxy : '');

    // Phase 4: 插件源走与 Bangumi 相同的代理（插件源多为境外站点）
    pluginHttpClient.setProxy(proxy);
    // BT 搜索（蜜柑/dmhy）同样多为境外站点
    btHttpClient.setProxy(proxy);

    // 渲染进程按域名分流：Bangumi 封面走代理，其它请求直连；
    // 视频流线路策略为 proxy 时，全部流量（含视频分片）走代理。
    try {
        const pacScript = buildBangumiPacScript(proxy, videoPolicy);
        await session.defaultSession.setProxy(pacScript ? { pacScript } : { proxyRules: 'direct://' });
        if (videoPolicy === 'proxy' && proxy) {
            console.log('[Network] 视频流走代理（渲染进程全量代理）');
        }
    } catch (e) {
        console.error('设置渲染进程代理分流失败:', e);
    }

    try {
        const ses = session.defaultSession;
        if (autoCleanCache) {
            await ses.clearCache();
        }
        // Electron 无 setCacheSize 公共 API，缓存由 Chromium 自动管理；cacheSize 配置仅作参考
    } catch (e) {
        console.error('应用缓存配置失败:', e);
    }
}

// ===== Phase 9: 窗口状态持久化 → 已抽离至 window-state.js =====

function createWindow() {
    const appIcon = loadAppIcon();

    // 创建浏览器窗口
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        show: false,
        icon: appIcon || appIconPath,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
            webSecurity: true
        },
        titleBarStyle: 'hidden',
        frame: false
    });
    if (appIcon) mainWindow.setIcon(appIcon);
    protectWebContents(mainWindow.webContents);
    attachWindowDiagnostics(mainWindow, 'main');
    bindFullscreenStateSync(mainWindow);
    configureSmokeTest(mainWindow);

    // 加载应用
    if (isDev) {
        // 开发环境：加载 Vite 开发服务器
        mainWindow.loadURL(devRendererUrl);
        // 打开开发者工具（在新窗口中打开，避免被主窗口遮挡）
        if (process.env.SAKURAFALL_OPEN_DEVTOOLS === '1') {
            mainWindow.webContents.openDevTools({ mode: 'detach' });
        }
    } else {
        // 生产环境：加载打包后的文件
        mainWindow.loadFile(path.join(__dirname, '../../dist/renderer/index.html'));
    }

    // Phase 9: 应用持久化的窗口尺寸/位置（覆盖默认值）
    applyWindowState(mainWindow, 'mainWindow', { minWidth: 800, minHeight: 600 });

    // 窗口准备好后显示
    mainWindow.once('ready-to-show', () => {
        if (!isSmokeTest) mainWindow.show();
    });

    // Phase 9: 绑定窗口尺寸/位置/最大化变更持久化
    bindWindowStatePersistence(mainWindow, 'mainWindow');

    // 处理加载失败 - 持续重试直到 Vite 服务器就绪
    let retryCount = 0;
    const maxRetries = 30; // 最多重试 30 次（60秒）
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
        console.error('Failed to load:', validatedURL, errorDescription);
        runtimeDiagnostics.report('window-load-failed', {
            role: 'main', errorCode, errorDescription, validatedURL
        });
        if (isDev && validatedURL && validatedURL.includes('localhost:5173')) {
            if (retryCount < maxRetries) {
                retryCount++;
                console.log(`Development server not ready, retrying in 2 seconds... (${retryCount}/${maxRetries})`);
                setTimeout(() => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.loadURL(devRendererUrl);
                    }
                }, 2000);
            } else {
                console.error('Max retries reached. Please make sure the development server is running.');
            }
        }
    });

    // 当窗口关闭时
    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // 窗口状态变化时通知渲染进程
    mainWindow.on('maximize', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('window-state-changed', true);
        }
    });
    mainWindow.on('unmaximize', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('window-state-changed', false);
        }
    });

    // 设置菜单
    createMenu();
}

/**
 * 播放窗口全部关闭后释放主进程侧的播放期资源：
 * - DLNA SSDP socket 与代理服务器（投屏会话随窗口结束）
 * - 一起看房间（WebSocket 服务端/客户端连接）
 * - 封面缓存 LRU 收缩（减少主进程驻留内存）
 * 仅在没有任何存活的播放窗口时执行，避免误伤多窗口场景
 */
function releasePlayerRuntimeResources() {
    if (playerWindows.size > 0) return;
    try {
        playerSvc.dlna().shutdown();
    } catch (e) { /* 未初始化或已销毁 */ }
    try {
        watchTogetherService.leaveRoom();
    } catch (e) { /* ignore */ }
    try {
        imageCacheService.trim();
    } catch (e) { /* ignore */ }
}

/**
 * 创建独立播放窗口（支持同时打开多个）
 * @param {Object} videoData - 视频信息 { title, url, anime, episode, episodeId, lineId }
 */
function createPlayerWindow(videoData) {
    const appIcon = loadAppIcon();

    const win = new BrowserWindow({
        width: 1000,
        height: 620,
        minWidth: 480,
        minHeight: 360,
        show: false,
        // 播放窗口永远是黑底：窗口尺寸变化（进出全屏、拖动缩放）时，尚未重绘的
        // 区域会直接显示窗口底色，默认白色会闪出一片白（用户看到的"全屏下面
        // 一片空白"就是它）。
        backgroundColor: '#000000',
        icon: appIcon || appIconPath,
        title: videoData?.title || '播放器',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
            // 视频流经主进程 VideoStreamProxyService 代理并补 CORS 头，
            // 无需再关闭 webSecurity（Anime4K 读帧不受跨域污染拦截）
            webSecurity: true
        },
        titleBarStyle: 'hidden',
        frame: false,
        alwaysOnTop: false // 默认不置顶，用户可通过窗口按钮切换
    });
    if (appIcon) win.setIcon(appIcon);
    protectWebContents(win.webContents);
    attachWindowDiagnostics(win, 'player');
    bindFullscreenStateSync(win);

    // 按 webContents.id 缓存视频数据，该窗口加载后通过 IPC 拉取
    // 注意：closed 事件触发时 webContents 已被销毁，所以必须提前缓存 id
    const webContentsId = win.webContents.id;
    pendingPlayerDataMap.set(webContentsId, videoData || null);
    playbackPressure.add(win);

    // Phase 9: 应用持久化的播放窗口尺寸/位置
    applyWindowState(win, 'playerWindow', { minWidth: 480, minHeight: 360 });

    // 加载播放窗口路由（不再通过 URL 传参，改用 IPC 拉取避免数据截断）
    if (isDev) {
        win.loadURL(`${devRendererUrl}#/player-window`);
    } else {
        win.loadFile(path.join(__dirname, '../../dist/renderer/index.html'), {
            hash: '/player-window'
        });
    }

    win.once('ready-to-show', () => {
        if (!win.isDestroyed()) {
            win.show();
            win.focus();
        }
    });

    // Phase 9: 绑定播放窗口尺寸/位置/最大化变更持久化
    bindWindowStatePersistence(win, 'playerWindow');

    // 窗口关闭时清理引用和数据
    // 使用 closed 事件触发前缓存的 webContentsId，避免访问已销毁的 webContents
    win.on('closed', () => {
        pendingPlayerDataMap.delete(webContentsId);
        playerPreMiniBounds.delete(webContentsId);
        playbackPressure.delete(win);
        releasePlayerRuntimeResources();
    });

    // 窗口状态变化通知渲染进程（用于最大化按钮状态）
    // 使用 try/catch，避免窗口正在关闭时发送消息触发 'Object has been destroyed'
    const webContentsRef = win.webContents;
    win.on('maximize', () => {
        try {
            webContentsRef.send('window-state-changed', true);
        } catch (e) { /* ignore destroyed */ }
    });
    win.on('unmaximize', () => {
        try {
            webContentsRef.send('window-state-changed', false);
        } catch (e) { /* ignore destroyed */ }
    });

    return win;
}

function createMenu() {
    const template = [
        {
            label: '文件',
            submenu: [
                {
                    label: '退出',
                    accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
                    click: () => {
                        app.quit();
                    }
                }
            ]
        },
        {
            label: '视图',
            submenu: [
                { role: 'reload', label: '重新加载' },
                { role: 'forceReload', label: '强制重新加载' },
                { role: 'toggleDevTools', label: '开发者工具' },
                { type: 'separator' },
                { role: 'resetZoom', label: '重置缩放' },
                { role: 'zoomIn', label: '放大' },
                { role: 'zoomOut', label: '缩小' },
                { type: 'separator' },
                { role: 'togglefullscreen', label: '全屏' }
            ]
        },
        {
            label: '窗口',
            submenu: [
                { role: 'minimize', label: '最小化' },
                { role: 'close', label: '关闭' }
            ]
        }
    ];

    if (process.platform === 'darwin') {
        template.unshift({
            label: app.getName(),
            submenu: [
                { role: 'about', label: '关于' },
                { type: 'separator' },
                { role: 'services', label: '服务' },
                { type: 'separator' },
                { role: 'hide', label: '隐藏' },
                { role: 'hideothers', label: '隐藏其他' },
                { role: 'unhide', label: '显示全部' },
                { type: 'separator' },
                { role: 'quit', label: '退出' }
            ]
        });
    }

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

// 当 Electron 完成初始化并准备创建浏览器窗口时调用此方法
if (hasSingleInstanceLock) app.whenReady().then(async () => {
    if (isSmokeOffline) {
        session.defaultSession.enableNetworkEmulation({ offline: true });
        session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, callback) => {
            callback({ cancel: !['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname) });
        });
    }
    // 连接数据库
    try {
        imageCacheService.setCacheDir(path.join(app.getPath('userData'), 'image-cache', 'covers'));
        imageCacheService.setPublicUrlResolver((filePath) => (
            `sakurafall-cache://covers/${encodeURIComponent(path.basename(filePath))}`
        ));
        protocol.registerFileProtocol('sakurafall-cache', (request, callback) => {
            try {
                const url = new URL(request.url);
                if (url.hostname !== 'covers') return callback({ error: -6 });
                const fileName = path.basename(decodeURIComponent(url.pathname.replace(/^\//, '')));
                const cacheRoot = path.resolve(imageCacheService.cacheDir);
                const filePath = path.resolve(cacheRoot, fileName);
                if (!fileName || path.dirname(filePath) !== cacheRoot || !fs.existsSync(filePath)) {
                    return callback({ error: -6 });
                }
                callback({ path: filePath });
            } catch (_error) {
                callback({ error: -6 });
            }
        });
        // sakurafall-media 统一由 protocol.handle 接管：
        //   - proxy 分支：远端视频流转发（补 CORS 头，恢复 webSecurity 后 Anime4K 仍可读帧）
        //   - asset 分支：MediaLibraryService 本地文件语义保持不变
        videoStreamProxy.setAssetResolver((url) => mediaLibraryService.resolveMediaPath(url));
        videoStreamProxy.registerVideoStreamProxy();
        cmsApiService.setHealthStorePath(path.join(app.getPath('userData'), 'source-health.json'));
        await animeDb.connect();
        // 数据库版本高于本应用支持的 schema：拒绝启动并明确提示，
        // 不要带着未知 schema 继续跑（旧代码会静默继续，可能写坏数据）。
        const fatalSchemaError = animeDb.getFatalSchemaError?.();
        if (fatalSchemaError) {
            dialog.showErrorBox(
                '数据库版本过新',
                `${fatalSchemaError.message}\n\n建议安装最新版本后再打开。`
            );
            app.quit();
            return;
        }
        // 将数据库实例注入各数据源服务以启用接口缓存（复用同一张 cms_cache 表）
        cmsApiService.setDatabase(animeDb);
        bangumiApi.setDatabase(animeDb);
        subjectService.setDatabase(animeDb);
        // 列表空封面后台补图完成后，把所有窗口里对应卡片就地更新
        subjectCoverBackfill.setNotifier((covers) => {
            for (const win of BrowserWindow.getAllWindows()) {
                if (!win.isDestroyed()) win.webContents.send('subject-covers-updated', covers);
            }
        });
        // P0: 本地 Bangumi 索引服务（本地查询为主，网络同步为辅）
        subjectIndexService.setDatabase(animeDb);
        danmakuApi.setDatabase(animeDb);
        danmakuAlignmentStore.setDatabase(animeDb);
        playbackResolverService.setDatabase(animeDb);
        playbackResolverService.setCmsApiService(cmsApiService);
        playbackResolverService.setSourceProviderRegistry(sourceProviderRegistry);

        // Phase 7: 注入 NetworkPolicyService 各依赖
        networkPolicyService.setBangumiApi(bangumiApi);
        networkPolicyService.setCmsApiService(cmsApiService);
        networkPolicyService.setSourceProviderRegistry(sourceProviderRegistry);
        networkPolicyService.setDanmakuApi(danmakuApi);
        networkPolicyService.setTraceMoeApi(traceMoeApi);
        networkPolicyService.setImageCacheService(imageCacheService);

        // Phase 4: 初始化插件式源规则引擎存储路径
        // 默认规则目录：src/main/config/source-plugins/*.json（仓库内，只读示例）
        // 用户规则文件：userData/plugin-sources.json（运行时写入，覆盖默认规则）
        sourcePluginManager.setStorePaths({
            defaultDir: '',
            userConfigPath: path.join(app.getPath('userData'), 'plugin-sources.json')
        });
        customizationPackService.setThemePaths({
            builtInThemeDir: getBundledExtensionDir('themes'),
            userThemeDir: path.join(app.getPath('userData'), 'theme-packs')
        });
        customizationPackService.setSourcePaths({
            builtInSourceDir: getBundledExtensionDir('sources'),
            userSourceDir: path.join(app.getPath('userData'), 'source-packs')
        });
        // 不主动清理过期缓存：保留过期数据用于网络失败时兜底
        // 过期缓存会在写入新缓存时按容量上限自然淘汰（见 AnimeDatabase.setCache）
    } catch (error) {
        console.error('数据库连接失败:', error);
    }

    // 初始化番剧下载器（下载目录与状态持久化均放在 userData 下）
    try {
        const userDataDir = app.getPath('userData');
        const defaultDownloadDir = path.join(userDataDir, 'downloads');
        const stateFile = path.join(userDataDir, 'downloads.json');
        downloader = new Downloader({
            downloadDir: defaultDownloadDir,
            stateFile,
            maxConcurrent: 2
        });
        // 下载进度推送到所有窗口（主窗口 + 播放窗口都可见）
        downloader.setOnProgress((task) => {
            try {
                const windows = BrowserWindow.getAllWindows();
                for (const win of windows) {
                    if (!win.isDestroyed()) {
                        win.webContents.send('on-download-progress', task);
                    }
                }
            } catch (_) { /* ignore */ }
        });
    } catch (error) {
        console.error('[Downloader] 初始化失败:', error);
    }

    // 初始化番剧更新提醒服务（依赖 animeDb + cmsApiService）
    try {
        updateReminder = new UpdateReminder({
            animeDb,
            cmsApiService,
            iconPath: appIconPath
        });
        // 从 localStorage 同步过来的用户设置由渲染进程通过 IPC 配置
        // 这里仅启动默认定时器（启用 + 1 小时），渲染进程加载后会调用 update-reminder-configure 覆盖
        updateReminder.start();
    } catch (error) {
        console.error('[UpdateReminder] 初始化失败:', error);
    }

    // 应用默认网络/缓存配置
    await applyNetworkConfig();

    // 默认 session 只加载本地渲染页，但仍显式拒绝摄像头/麦克风/通知等 Web 权限。
    // 复制房间号需要 clipboard-sanitized-write，HTML5 全屏回退需要 fullscreen。
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
        callback(ALLOWED_SESSION_PERMISSIONS.has(permission));
    });
    session.defaultSession.setPermissionCheckHandler((_webContents, permission) => (
        ALLOWED_SESSION_PERMISSIONS.has(permission)
    ));

    // 图片防盗链拦截：给各 CDN 请求补上 Referer + UA
    // 放在 whenReady 中而非 createWindow，避免窗口重建时重复注册监听器
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
        const reqUrl = details.url || '';
        // 所有图片请求都补全 UA（部分 CDN 拒绝无 UA 请求）
        const isImageRequest = /image\/|\.jpg|\.jpeg|\.png|\.webp|\.gif|\.avif|\.bmp/i.test(details.resourceType || '') ||
                              details.requestHeaders['Accept']?.includes('image/');
        if (isImageRequest && !details.requestHeaders['User-Agent']) {
            details.requestHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
        }
        // 按域名补 Referer（防盗链）
        try {
            const host = new URL(reqUrl).hostname.toLowerCase();
            // dev 下 Vite dev server 会一次性拉取数百个模块，这些请求不可能命中
            // 片源防盗链规则，却会让每个请求都遍历一遍 provider 列表（主进程 CPU）。
            const isDevServerRequest = isDev && /^http:\/\/(localhost|127\.0\.0\.1):5173\//i.test(reqUrl);
            const sourceHeaders = isDevServerRequest ? {} : sourceProviderRegistry.getRequestHeadersForUrl(reqUrl);
            if (Object.keys(sourceHeaders).length > 0) {
                Object.assign(details.requestHeaders, sourceHeaders);
            } else if (host.includes('bgm.tv') || host.includes('bangumi.tv') || host.includes('lain.bgm')) {
                details.requestHeaders['Referer'] = 'https://bgm.tv/';
            } else if (host.includes('hdslb.com') || host.includes('bilibili.com')) {
                details.requestHeaders['Referer'] = 'https://www.bilibili.com/';
            } else if (host.includes('baidu.com') || host.includes('bdimg.com')) {
                details.requestHeaders['Referer'] = 'https://image.baidu.com/';
            } else if (!details.requestHeaders['Referer'] && isImageRequest) {
                // 其他图片请求补同源 Referer，避免空 Referer 被拒
                details.requestHeaders['Referer'] = `${new URL(reqUrl).origin}/`;
            }
        } catch (e) { /* ignore */ }
        callback({ cancel: false, requestHeaders: details.requestHeaders });
    });

    createWindow();

    // 启动后静默检查更新（打包版生效；SAKURAFALL_UPDATE_CHECK_DEV=1 可在开发模式验证）
    updateIpc.scheduleStartupUpdateCheck({ isDev });
});

// 应用退出时关闭数据库连接
app.on('before-quit', () => {
    cmsApiService.flushSourceHealth();
    imageCacheService.flushIndex?.();
    if (downloader) downloader.shutdown();
    if (updateReminder) updateReminder.stop();
    playerSvc.shutdown();
    try { watchTogetherService.shutdown(); } catch (_) { /* ignore */ }
    animeDb.close();
});

// 当所有窗口都关闭时退出应用
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// IPC 通信处理
secureIpcHandle('app-version', () => {
    return app.getVersion();
});

// GPU 特性状态：渲染层用它判断页面是否在走软件合成。
// disable-gpu-compositing（window-fullscreen.js 的全屏兼容开关）只是把合成切到 CPU，
// WebGL 仍由真实 GPU 提供，渲染层自检发现不了，需要主进程给出权威结论。
secureIpcHandle('gpu-feature-status', () => {
    try {
        const status = app.getGPUFeatureStatus() || {};
        return {
            gpuCompositing: String(status.gpu_compositing || ''),
            webgl: String(status.webgl || ''),
            webgl2: String(status.webgl2 || '')
        };
    } catch (error) {
        return { gpuCompositing: '', webgl: '', webgl2: '', error: error.message };
    }
});

secureIpcHandle('runtime-diagnostics-report', (_event, type, details) => {
    runtimeDiagnostics.report(`renderer-${String(type || 'event')}`, details || {});
    return { success: true };
});

secureIpcHandle('runtime-diagnostics-summary', () => runtimeDiagnostics.getSummary());

secureIpcHandle('runtime-diagnostics-open-folder', async () => {
    fs.mkdirSync(runtimeDiagnostics.baseDir, { recursive: true });
    const error = await shell.openPath(runtimeDiagnostics.baseDir);
    return { success: !error, error };
});

secureIpcHandle('database-health', () => animeDb.getHealthStatus());

secureIpcHandle('open-external-url', async (_event, url) => {
    await openExternalUrl(url);
    return { success: true };
});

// 窗口控制：根据事件发送者操作对应窗口（主窗口或播放窗口）
secureIpcHandle('minimize-window', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.minimize();
});

secureIpcHandle('maximize-window', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
        if (win.isMaximized()) {
            win.unmaximize();
        } else {
            win.maximize();
        }
    }
});

secureIpcHandle('close-window', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.close();
});

secureIpcHandle('is-maximized', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win ? win.isMaximized() : false;
});

// 窗口全屏 IPC（切换/查询）见 window-fullscreen.js
registerWindowFullscreenIpc(secureIpcHandle);

// 独立播放窗口：打开
secureIpcHandle('background-playback-pressure', () => playerWindows.size > 0);

secureIpcHandle('open-player-window', (event, videoData) => {
    try {
        const win = createPlayerWindow(videoData);
        return { success: true, windowId: win.webContents.id };
    } catch (error) {
        console.error('[PlayerWindow] 创建播放窗口失败:', error);
        return { success: false, error: error?.message || String(error) };
    }
});

// 独立播放窗口：拉取待播放数据
// 按窗口的 webContents.id 隔离，支持多窗口同时打开各自拿各自的数据
// 注意：event.sender 本身就是 webContents，不需要再 .webContents
secureIpcHandle('player-get-data', (event) => {
    const id = event.sender.id;
    return pendingPlayerDataMap.get(id);
});

// 独立播放窗口：将后台解析完成的数据推送到已打开的准备窗口
secureIpcHandle('update-player-window', (event, windowId, videoData) => {
    const targetId = Number(windowId);
    const win = Array.from(playerWindows).find(item => (
        !item.isDestroyed() && item.webContents.id === targetId
    ));
    if (!win) return { success: false, error: '播放窗口已关闭' };
    pendingPlayerDataMap.set(targetId, videoData || null);
    if (!win.webContents.isLoading()) {
        win.webContents.send('player-load-new', videoData || null);
    }
    return { success: true };
});

secureIpcHandle('close-player-window', (event, windowId) => {
    const targetId = Number(windowId);
    const win = Array.from(playerWindows).find(item => (
        !item.isDestroyed() && item.webContents.id === targetId
    ));
    if (!win) return false;
    win.close();
    return true;
});

// 独立播放窗口：切换置顶
secureIpcHandle('player-toggle-top', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    const newState = !win.isAlwaysOnTop();
    win.setAlwaysOnTop(newState);
    return newState;
});

// 独立播放窗口：查询当前置顶状态
secureIpcHandle('player-is-top', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win ? win.isAlwaysOnTop() : false;
});

// Phase 9: 迷你模式（缩小窗口 + 置顶 + 跳过任务栏可选）
// 迷你模式：400x225（16:9），始终置顶，不在任务栏显示（仅托盘区）
// 退出迷你模式：恢复为持久化的播放窗口尺寸
const PLAYER_MINI_SIZE = { width: 400, height: 225 };
const playerPreMiniBounds = new Map(); // webContentsId -> 上一次的 bounds

secureIpcHandle('player-toggle-mini', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    const bounds = win.getBounds();
    const isMini = bounds.width <= PLAYER_MINI_SIZE.width + 10;
    console.log(`[MiniMode] toggle-mini 被调用, current bounds=${JSON.stringify(bounds)}, isMini=${isMini}`);
    if (isMini) {
        // 退出迷你模式：恢复持久化尺寸
        const id = event.sender.id;
        const saved = playerPreMiniBounds.get(id);
        console.log(`[MiniMode] 退出迷你模式, saved=${saved ? JSON.stringify(saved) : 'null'}`);
        try {
            // 先恢复最小尺寸限制
            win.setMinimumSize(480, 360);
            if (saved) {
                win.setBounds(saved);
                playerPreMiniBounds.delete(id);
            } else {
                const state = loadWindowState().playerWindow;
                if (state && Number.isFinite(state.width) && Number.isFinite(state.height)) {
                    win.setBounds({
                        width: Math.max(480, state.width),
                        height: Math.max(360, state.height)
                    });
                } else {
                    win.setSize(1000, 620);
                }
            }
            win.setAlwaysOnTop(false);
            win.setSkipTaskbar(false);
            console.log(`[MiniMode] 退出完成, new bounds=${JSON.stringify(win.getBounds())}`);
        } catch (e) {
            console.error(`[MiniMode] 退出失败:`, e);
        }
        return false;
    } else {
        // 进入迷你模式：先保存当前尺寸
        try {
            playerPreMiniBounds.set(event.sender.id, win.getBounds());
            // 取消最小尺寸限制，否则 400x225 会被强制为 480x360，导致退出时判断失败
            win.setMinimumSize(1, 1);
            win.setBounds({
                width: PLAYER_MINI_SIZE.width,
                height: PLAYER_MINI_SIZE.height
            });
            win.setAlwaysOnTop(true);
            win.setSkipTaskbar(false); // 保留任务栏便于用户找回
            console.log(`[MiniMode] 进入完成, new bounds=${JSON.stringify(win.getBounds())}`);
        } catch (e) {
            console.error(`[MiniMode] 进入失败:`, e);
        }
        return true;
    }
});

secureIpcHandle('player-is-mini', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    return win.getBounds().width <= PLAYER_MINI_SIZE.width + 10;
});

// 文件对话框
secureIpcHandle('select-folder', async (event) => {
    try {
        const win = BrowserWindow.fromWebContents(event.sender);
        const result = await dialog.showOpenDialog(win, {
            properties: ['openDirectory', 'createDirectory'],
            title: '选择下载文件夹'
        });
        return result;
    } catch (error) {
        console.error('选择文件夹失败:', error);
        return { canceled: true, error: error.message };
    }
});

secureIpcHandle('select-file', async (event, filters) => {
    try {
        const win = BrowserWindow.fromWebContents(event.sender);
        const result = await dialog.showOpenDialog(win, {
            properties: ['openFile'],
            filters: filters || [
                { name: 'All Files', extensions: ['*'] }
            ]
        });
        return result;
    } catch (error) {
        console.error('选择文件失败:', error);
        return { canceled: true, error: error.message };
    }
});

// ======
// 以图搜番 (trace.moe) IPC 处理
// ======

// 通过本地图片文件搜索
secureIpcHandle('trace-moe-search-file', async (event, imagePath) => {
    try {
        if (!imagePath) {
            return { success: false, error: '图片路径为空' };
        }
        if (!isSupportedImagePath(imagePath)) {
            return { success: false, error: '仅支持 JPG/PNG/WebP/GIF/BMP/AVIF 图片', results: [] };
        }
        const stat = fs.statSync(imagePath);
        if (!stat.isFile()) {
            return { success: false, error: '图片路径不是文件', results: [] };
        }
        if (stat.size > MAX_TRACE_MOE_IMAGE_BYTES) {
            return { success: false, error: '图片文件超过 20MB 限制', results: [] };
        }
        const result = await traceMoeApi.searchByImage(imagePath);
        return { success: true, ...result };
    } catch (error) {
        console.error('[TraceMoe] 文件搜索失败:', error);
        return { success: false, error: error.message, results: [] };
    }
});

// 从剪贴板读取图片搜索
secureIpcHandle('trace-moe-search-clipboard', async () => {
    try {
        // 优先复用主进程的 clipboard，service 内部也会读取
        const img = clipboard.readImage();
        if (img.isEmpty()) {
            return { success: false, error: '剪贴板中没有图片', results: [] };
        }
        const result = await traceMoeApi.searchByClipboard();
        return { success: true, ...result };
    } catch (error) {
        console.error('[TraceMoe] 剪贴板搜索失败:', error);
        return { success: false, error: error.message, results: [] };
    }
});

// 通过图片 URL 搜索
secureIpcHandle('trace-moe-search-url', async (event, imageUrl) => {
    try {
        if (!imageUrl) {
            return { success: false, error: '图片 URL 为空' };
        }
        const result = await traceMoeApi.searchByUrl(imageUrl);
        return { success: true, ...result };
    } catch (error) {
        console.error('[TraceMoe] URL 搜索失败:', error);
        return { success: false, error: error.message, results: [] };
    }
});

// 通过 dataURL 搜索（渲染进程粘贴/拖拽得到的图片直接以 dataURL 传输）
secureIpcHandle('trace-moe-search-data-url', async (event, dataUrl) => {
    try {
        if (!dataUrl || typeof dataUrl !== 'string') {
            return { success: false, error: '图片数据为空', results: [] };
        }
        // 解析 dataURL: data:image/jpeg;base64,xxxxx
        const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) {
            return { success: false, error: 'dataURL 格式无效', results: [] };
        }
        const mime = match[1];
        const buffer = Buffer.from(match[2], 'base64');
        const result = await traceMoeApi.searchByBuffer(buffer, mime);
        return { success: true, ...result };
    } catch (error) {
        console.error('[TraceMoe] dataURL 搜索失败:', error);
        return { success: false, error: error.message, results: [] };
    }
});

// Phase 6: 增强播放（mpv + Anime4K）— 委托给 EnhancedPlayerService
secureIpcHandle('enhanced-player-check', async (event, options = {}) => {
    try {
        return playerSvc.enhanced().check(normalizeEnhancedPlayerOptions(options));
    } catch (error) {
        return { success: false, error: error.message };
    }
});

secureIpcHandle('enhanced-player-open', async (event, options = {}) => {
    try {
        return playerSvc.enhanced().open(normalizeEnhancedPlayerOptions(options));
    } catch (error) {
        return { success: false, error: error.message };
    }
});

secureIpcHandle('enhanced-player-install', async () => {
    return playerSvc.enhanced().install();
});

secureIpcHandle('enhanced-player-presets', async () => {
    return {
        presets: playerSvc.enhanced().getPresets(),
        defaultPresetId: playerSvc.enhanced().defaultPresetId
    };
});

// ===== 设置页 GPU 合成开关（已抽离至 ipc/gpu.js）=====
registerGpuIpc({
    handle: secureIpcHandle,
    app,
    preferenceFile: GPU_COMPOSITING_PREFERENCE_FILE,
    isDev
});

// ===== Phase 7: 网络与 TUN 分流策略（已抽离至 ipc/network.js）=====
registerNetworkIpc({ handle: secureIpcHandle, networkPolicyService });

// 设置页敏感项（代理/第三方 API Key）不再落 localStorage，统一 safeStorage 加密
registerSettingsSecretsIpc({
    handle: secureIpcHandle,
    store: new SettingsSecretStore({
        filePath: path.join(app.getPath('userData'), 'settings-secrets.json')
    })
});

// ===== Phase 4: 插件式源规则系统 IPC（已抽离至 ipc/sourceProviders.js）=====
// 与 cms-* 通道并存：CMS 源走 cms-*，XPath 规则源走 plugin-*
registerSourceProviderIpc({ handle: secureIpcHandle, sourcePluginManager, sourceProviderRegistry });

registerPlaybackHealthIpc({ handle: secureIpcHandle, cmsApiService, sourceProviderRegistry });

// 获取版本信息
secureIpcHandle('get-versions', () => {
    return {
        node: process.versions.node,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        app: app.getVersion()
    };
});

// ======
// Phase 5: 播放解析状态机 IPC
// ======

// 解析 PlayableSource + episode 为最终可播放的 ResolvedVideo
// payload: { sourceId, sourceName, sourceType, sourceAnimeId, episode, anime }
// 返回: { success, url, headers, sourceId, episodeId, qualityHint, ... }
//    或 { success: false, error, reason, category, hint, userMessage, elapsedMs }
secureIpcHandle('playback-resolve', async (event, payload = {}, options = {}) => {
    try {
        // 每次调用都生成新 token，使旧 token 的返回结果被丢弃
        const token = playbackResolverService.nextToken();
        const result = await playbackResolverService.resolve(payload, { ...options, token });
        // 远端 http(s) 直链改走主进程视频代理，恢复 webSecurity 后避免 canvas 跨域污染
        if (result?.success && result.url && /^https?:\/\//i.test(result.url)) {
            result.url = videoStreamProxy.buildProxyUrl(result.url, {
                referer: result.headers?.Referer || result.headers?.referer || ''
            });
        }
        if (!result?.success && result?.category !== 'cancelled') {
            runtimeDiagnostics.report('playback-resolve-failed', {
                sourceId: payload?.sourceId || payload?.source?.sourceId || '',
                providerId: payload?.providerId || payload?.source?.providerId || '',
                episodeId: payload?.episode?.id || payload?.episodeId || '',
                category: result?.category || result?.reason || 'unknown',
                error: result?.error || '',
                elapsedMs: result?.elapsedMs || 0
            });
        }
        return result;
    } catch (error) {
        runtimeDiagnostics.captureError('playback-resolve-crashed', error, {
            sourceId: payload?.sourceId || payload?.source?.sourceId || '',
            providerId: payload?.providerId || payload?.source?.providerId || ''
        });
        console.error('[PlaybackResolver] 解析失败:', error);
        return {
            success: false,
            error: error.message || '播放解析失败',
            reason: 'unknown',
            category: 'unknown',
            hint: '请尝试重试或换源',
            userMessage: error.message || '播放解析失败',
            elapsedMs: 0
        };
    }
});

// 取消所有进行中的解析请求（使所有 token 失效）
secureIpcHandle('playback-cancel-all', async () => {
    playbackResolverService.cancelAll();
    return { success: true };
});

// 视频代理 URL 包装（远端直链 → sakurafall-media://proxy/...）
secureIpcHandle('build-video-proxy-url', async (event, url, referer) => {
    const target = String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) {
        return { success: false, error: 'not a remote http(s) url', url: target };
    }
    const safeReferer = /^https?:\/\//i.test(String(referer || '')) ? String(referer) : '';
    return { success: true, url: videoStreamProxy.buildProxyUrl(target, { referer: safeReferer }) };
});

// 清理解析短期缓存
secureIpcHandle('playback-clear-resolve-cache', async () => {
    playbackResolverService.clearResolveCache();
    return { success: true };
});

// 网络/缓存配置
secureIpcHandle('set-network-config', async (event, config) => {
    try {
        await applyNetworkConfig(config);
        return { success: true, config: appConfig };
    } catch (error) {
        console.error('应用网络配置失败:', error);
        return { success: false, error: error.message };
    }
});

// 清理缓存（仅清 HTTP 缓存；不再连带 clearStorageData，避免误清 localStorage/cookies 等用户数据）
secureIpcHandle('clear-cache', async (event) => {
    try {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win) {
            throw new Error('窗口未就绪');
        }
        const session = win.webContents.session;
        await session.clearCache();
        const imageCache = imageCacheService.clear();
        console.log('Cache cleared successfully');
        return { success: true, imageCache };
    } catch (error) {
        console.error('Failed to clear cache:', error);
        throw error;
    }
});

require('./ipc/imageCache')(secureIpcHandle, imageCacheService);

// 批量预加载已缓存封面到渲染进程内存（毫秒级显示）
secureIpcHandle('image-cache-batch-lookup', async (event, urls, options) => {
    try {
        return imageCacheService.batchLookupCachedUrls(urls, options);
    } catch (error) {
        return {};
    }
});

secureIpcHandle('show-main-route', async (event, route = '/settings') => {
    if (!mainWindow || mainWindow.isDestroyed()) return { success: false };
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('navigate-main-route', String(route || '/settings'));
    return { success: true };
});

// 获取所有已缓存封面（启动时一次性预加载）
secureIpcHandle('image-cache-get-all', async () => {
    try {
        return imageCacheService.getAllCachedUrls();
    } catch (error) {
        return {};
    }
});

// 开发环境热重载（electron-reload 未安装，保留扩展位；如需主进程热重载可安装该包后取消注释）
// if (isDev) {
//     try {
//         require('electron-reload')(__dirname, {
//             electron: path.join(__dirname, '..', '..', 'node_modules', '.bin', 'electron'),
//             hardResetMethod: 'exit'
//         });
//     } catch (err) {
//         console.log('electron-reload not found, continuing without hot reload');
//     }
// }

// ======
// 元数据与目录 IPC（本地库 / Bangumi / SubjectService / 本地索引）
// 处理程序已抽离至 ipc/metadata.js（含 get-anime-*、bangumi-*、subject-*、subject-index-*）
// ======
registerMetadataIpc({ handle: secureIpcHandle, animeDb, bangumiApi, subjectService, subjectIndexService });

// 片源包 / 主题包（导入导出与更新）已抽离至 ipc/customizationPacks.js
registerCustomizationPackIpc({
    handle: secureIpcHandle,
    customizationPackService,
    httpClient: pluginHttpClient
});

// 获取番剧详情（标准化为 SubjectDetail）
require('./ipc/subjectDetail')(secureIpcHandle, subjectService);

registerDanmakuIpc({ handle: secureIpcHandle, danmakuApi, alignmentStore: danmakuAlignmentStore });

// Generic fallback catalog selected by a role declared in an installed source pack.
function getFallbackPlaybackProvider() {
    return sourceProviderRegistry.findProviderByRole('fallback-catalog')
        || sourceProviderRegistry.listProviders().find(provider => provider.type === 'cms' && provider.enabled)
        || null;
}

secureIpcHandle('playback-source-categories', async () => {
    const provider = getFallbackPlaybackProvider();
    return provider ? sourceProviderRegistry.getCategories(provider.providerId) : [];
});

secureIpcHandle('playback-source-list', async (_event, categoryId = '', page = 1) => {
    const provider = getFallbackPlaybackProvider();
    if (!provider) return { data: [], total: 0, page, totalPages: 0, error: '未安装播放源' };
    try {
        return await sourceProviderRegistry.getCatalog(provider.providerId, { categoryId, page });
    } catch (error) {
        return { data: [], total: 0, page, totalPages: 0, error: error.message };
    }
});

secureIpcHandle('playback-source-detail', async (_event, id) => {
    const provider = getFallbackPlaybackProvider();
    if (!provider) return null;
    return sourceProviderRegistry.getDetail(provider.providerId, { id });
});

secureIpcHandle('playback-source-resolve-url', async (_event, url) => {
    const provider = getFallbackPlaybackProvider();
    if (!provider) return null;
    return sourceProviderRegistry.resolveEpisode(provider.providerId, { url });
});

secureIpcHandle('playback-source-search', async (_event, keyword, page = 1) => {
    const provider = getFallbackPlaybackProvider();
    if (!provider) return { data: [], total: 0, page, totalPages: 0, error: '未安装播放源' };
    return sourceProviderRegistry.search(provider.providerId, keyword, { page });
});

secureIpcHandle('playback-source-test', async () => networkPolicyService.testPlaybackSource());

// ======
// 通用 CMS API IPC（多源支持）已抽离至 ipc/cmsSources.js
// ======
registerCmsIpc({ handle: secureIpcHandle, cmsApiService, sourceProviderRegistry });

// ====== 应用更新 ======
// 检查 / 更新源配置 / 两步式应用内更新（下载托管 + 用户确认后安装）
const updateIpc = registerUpdateIpc({
    handle: secureIpcHandle,
    updateChecker,
    shell,
    BrowserWindow
});

// ====== BT 资源搜索 / 边播边下 / 本地媒体库 ======
// 必须在这里注册：secureIpcHandle 依赖下方初始化好的 registerIpcHandler，
// 放到文件顶部会在 TDZ 内调用而抛错。所有通道统一走可信来源校验。
btStreamService = registerBtIpc({
    handle: secureIpcHandle,
    btSearchService,
    customizationPackService,
    dialog,
    BrowserWindow
}).btStreamService;

registerLibraryIpc({ handle: secureIpcHandle, animeDb, dialog, BrowserWindow });

// ======
// 番剧下载 IPC 处理
// ======

// 添加下载任务
// payload: { anime, episode, url }，anime/episode 字段同播放器 videoData
secureIpcHandle('download-add', async (event, payload) => {
    if (!downloader) return { error: '下载器未初始化' };
    try {
        if (!payload || !payload.url) {
            return { error: '下载地址为空' };
        }
        const task = downloader.addTask({
            anime: payload.anime || {},
            episode: payload.episode || {},
            url: payload.url
        });
        return { success: true, task };
    } catch (error) {
        console.error('[Download] 添加下载任务失败:', error);
        return { error: error.message };
    }
});

// 取消下载（停止任务但保留记录）
secureIpcHandle('download-cancel', async (event, id) => {
    if (!downloader) return { error: '下载器未初始化' };
    const task = downloader.cancel(id);
    return { success: !!task, task };
});

// 暂停下载
secureIpcHandle('download-pause', async (event, id) => {
    if (!downloader) return { error: '下载器未初始化' };
    const task = downloader.pause(id);
    return { success: !!task, task };
});

// 恢复下载
secureIpcHandle('download-resume', async (event, id) => {
    if (!downloader) return { error: '下载器未初始化' };
    const task = downloader.resume(id);
    return { success: !!task, task };
});

// 获取下载列表
secureIpcHandle('download-list', async () => {
    if (!downloader) return { tasks: [], downloadDir: '' };
    return {
        tasks: downloader.list(),
        downloadDir: downloader.downloadDir || ''
    };
});

// 删除下载记录和文件
secureIpcHandle('download-remove', async (event, id) => {
    if (!downloader) return { error: '下载器未初始化' };
    const ok = downloader.remove(id);
    return { success: ok };
});

// 选择下载目录
secureIpcHandle('download-select-dir', async (event) => {
    try {
        const win = BrowserWindow.fromWebContents(event.sender);
        const result = await dialog.showOpenDialog(win, {
            properties: ['openDirectory', 'createDirectory'],
            title: '选择下载目录'
        });
        if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
            return { canceled: true };
        }
        const dir = result.filePaths[0];
        if (downloader) downloader.setDownloadDir(dir);
        return { canceled: false, dir };
    } catch (error) {
        console.error('[Download] 选择下载目录失败:', error);
        return { canceled: true, error: error.message };
    }
});

// 在系统文件管理器中打开下载目录（便利操作，复用 shell.openPath）
secureIpcHandle('download-open-dir', async (event, dirPath) => {
    try {
        const target = path.resolve(String(dirPath || (downloader ? downloader.downloadDir : '') || ''));
        if (!target) return { success: false, error: '下载目录未设置' };
        if (!isManagedDownloadPath(target)) {
            return { success: false, error: '只能打开下载目录或已知任务所在目录' };
        }
        if (!fs.statSync(target).isDirectory()) {
            return { success: false, error: '目标不是目录' };
        }
        const errMsg = await shell.openPath(target);
        return { success: !errMsg, error: errMsg || null };
    } catch (error) {
        console.error('[Download] 打开下载目录失败:', error);
        return { success: false, error: error.message };
    }
});

// 在系统文件管理器中定位已下载文件（便利操作）
secureIpcHandle('download-open-file', async (event, filePath) => {
    try {
        if (!filePath) return { success: false, error: '文件路径为空' };
        const target = path.resolve(String(filePath));
        if (!isManagedDownloadPath(target) || !fs.statSync(target).isFile()) {
            return { success: false, error: '只能定位下载目录内已下载的文件' };
        }
        shell.showItemInFolder(target);
        return { success: true };
    } catch (error) {
        console.error('[Download] 定位文件失败:', error);
        return { success: false, error: error.message };
    }
});

// ======
// 番剧更新提醒 IPC 处理
// ======

// 手动触发一次检查
secureIpcHandle('update-reminder-check', async () => {
    if (!updateReminder) return { error: '提醒服务未初始化' };
    try {
        return await updateReminder.checkNow();
    } catch (error) {
        console.error('[UpdateReminder] 手动检查失败:', error);
        return { error: error.message };
    }
});

// 获取提醒列表 + 上次检查时间
secureIpcHandle('update-reminder-list', async () => {
    if (!updateReminder) return { reminders: [], lastCheckTime: 0 };
    return updateReminder.getReminders();
});

// 标记指定番剧的提醒为已读
secureIpcHandle('update-reminder-mark-read', async (event, animeId, source) => {
    if (!updateReminder) return { success: false };
    updateReminder.markAsRead(animeId, source);
    return { success: true };
});

// 清空所有提醒
secureIpcHandle('update-reminder-clear', async () => {
    if (!updateReminder) return { success: false };
    updateReminder.clear();
    return { success: true };
});

// 配置提醒服务（启用/禁用、检查间隔）
secureIpcHandle('update-reminder-configure', async (event, options = {}) => {
    if (!updateReminder) return { success: false };
    updateReminder.configure(options);
    return { success: true };
});

// ======
// 字幕（SRT/VTT/ASS 解析 + OpenSubtitles 搜索）IPC 处理
// ======

/**
 * 选择并解析本地字幕文件
 * 弹出文件选择对话框，读取文件内容并自动检测编码 + 解析为 cue 数组
 * 返回: { success, cues, format, filePath, error? }
 */
secureIpcHandle('subtitle-parse-file', async (event) => {
    try {
        const win = BrowserWindow.fromWebContents(event.sender);
        const result = await dialog.showOpenDialog(win, {
            properties: ['openFile'],
            title: '选择字幕文件',
            filters: [
                { name: '字幕文件', extensions: ['srt', 'vtt', 'ass', 'ssa'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });
        if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
            return { success: false, canceled: true };
        }
        const filePath = result.filePaths[0];
        const parsed = await playerSvc.subtitle().parseFile(filePath);
        return {
            success: true,
            cues: parsed.cues,
            format: parsed.format,
            filePath
        };
    } catch (error) {
        console.error('[Subtitle] 解析字幕文件失败:', error);
        return { success: false, error: error.message };
    }
});

/**
 * 解析字幕内容字符串（用于在线下载后的字幕或直接传入的内容）
 * 参数: (content, [filePath])，filePath 可选用于辅助判断格式
 * 返回: { success, cues, format, error? }
 */
secureIpcHandle('subtitle-parse-content', async (event, content, filePath) => {
    try {
        if (!content) return { success: false, error: '字幕内容为空' };
        const cues = playerSvc.subtitle().parseAuto(content, filePath);
        const ext = filePath ? path.extname(filePath).toLowerCase().replace('.', '') : '';
        let format = ext;
        if (!format) {
            if (/^WEBVTT/i.test(content.trim())) format = 'vtt';
            else if (/\[SCRIPT INFO\]/i.test(content)) format = 'ass';
            else format = 'srt';
        }
        return { success: true, cues, format };
    } catch (error) {
        console.error('[Subtitle] 解析字幕内容失败:', error);
        return { success: false, error: error.message };
    }
});

/**
 * 在线搜索字幕（OpenSubtitles，需要用户配置 API Key）
 * 参数: (keyword, language='zh')
 * 返回: { success, results, error? }
 */
secureIpcHandle('subtitle-search', async (event, keyword, language = 'zh') => {
    try {
        if (!playerSvc.subtitle().isReady()) {
            return {
                success: false,
                error: '未配置 OpenSubtitles API Key，请在设置中填写'
            };
        }
        const results = await playerSvc.subtitle().searchOnline(keyword, language);
        return { success: true, results };
    } catch (error) {
        console.error('[Subtitle] 在线搜索字幕失败:', error);
        return { success: false, error: error.message };
    }
});

/**
 * 下载在线字幕文件内容（通过 file_id）
 * 参数: fileId
 * 返回: { success, content, error? }
 */
secureIpcHandle('subtitle-download', async (event, fileId) => {
    try {
        if (!playerSvc.subtitle().isReady()) {
            return { success: false, error: '未配置 OpenSubtitles API Key' };
        }
        const content = await playerSvc.subtitle().downloadSubtitle(fileId);
        return { success: true, content };
    } catch (error) {
        console.error('[Subtitle] 下载字幕失败:', error);
        return { success: false, error: error.message };
    }
});

/**
 * 设置 OpenSubtitles API Key
 */
secureIpcHandle('subtitle-set-api-key', async (event, apiKey) => {
    try {
        playerSvc.subtitle().setApiKey(apiKey || '');
        return { success: true };
    } catch (error) {
        console.error('[Subtitle] 设置 API Key 失败:', error);
        return { success: false, error: error.message };
    }
});

// ======
// DLNA 投屏 IPC 处理
// ======

// 搜索局域网内的 DLNA 设备
secureIpcHandle('dlna-discover', async (event, options = {}) => {
    try {
        const devices = await playerSvc.dlna().discoverDevices(options);
        return { success: true, devices };
    } catch (error) {
        console.error('[DLNA] 搜索设备失败:', error);
        return { success: false, error: error.message, devices: [] };
    }
});

// 投屏播放：自动启动本地代理服务器并设置代理目标
// payload: { deviceId, url, title, headers?, mime? }
secureIpcHandle('dlna-cast', async (event, payload = {}) => {
    try {
        if (!payload.deviceId) return { success: false, error: '未指定投屏设备' };
        if (!payload.url) return { success: false, error: '视频地址为空' };

        // 启动本地代理服务器（DLNA 设备可能无法直接访问 https / 带 header 的源）
        await playerSvc.dlna().startProxyServer();
        playerSvc.dlna().setProxyTarget({
            url: payload.url,
            headers: payload.headers || null,
            title: payload.title || '',
            mime: payload.mime || ''
        });

        const proxyUrl = playerSvc.dlna().getProxyStreamUrl();
        if (!proxyUrl) {
            return { success: false, error: '本地代理服务器未就绪' };
        }

        await playerSvc.dlna().cast(payload.deviceId, proxyUrl, payload.title || '视频');
        return { success: true };
    } catch (error) {
        console.error('[DLNA] 投屏失败:', error);
        return { success: false, error: error.message };
    }
});

// 暂停投屏
secureIpcHandle('dlna-pause', async (event, deviceId) => {
    try {
        await playerSvc.dlna().pause(deviceId);
        return { success: true };
    } catch (error) {
        console.error('[DLNA] 暂停失败:', error);
        return { success: false, error: error.message };
    }
});

// 恢复投屏
secureIpcHandle('dlna-resume', async (event, deviceId) => {
    try {
        await playerSvc.dlna().resume(deviceId);
        return { success: true };
    } catch (error) {
        console.error('[DLNA] 恢复播放失败:', error);
        return { success: false, error: error.message };
    }
});

// 停止投屏
secureIpcHandle('dlna-stop', async (event, deviceId) => {
    try {
        await playerSvc.dlna().stop(deviceId);
        return { success: true };
    } catch (error) {
        console.error('[DLNA] 停止失败:', error);
        return { success: false, error: error.message };
    }
});

// 跳转到指定秒数
secureIpcHandle('dlna-seek', async (event, deviceId, seconds) => {
    try {
        await playerSvc.dlna().seek(deviceId, seconds);
        return { success: true };
    } catch (error) {
        console.error('[DLNA] 跳转失败:', error);
        return { success: false, error: error.message };
    }
});

// 获取当前播放位置和总时长
secureIpcHandle('dlna-get-position', async (event, deviceId) => {
    try {
        const info = await playerSvc.dlna().getPosition(deviceId);
        return { success: true, ...info };
    } catch (error) {
        console.error('[DLNA] 获取播放位置失败:', error);
        return { success: false, error: error.message, position: 0, duration: 0 };
    }
});

// ======
// 一起看（同步播放）IPC 处理
// ======

// 在主进程注册消息回调，收到消息后向所有窗口的渲染进程推送
// 多窗口场景下：主窗口 + 播放窗口都可能需要接收消息
watchTogetherService.onMessage((msg) => {
    try {
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
                win.webContents.send('on-wt-message', msg);
            }
        }
    } catch (_) { /* ignore */ }
});

// 创建房间（主机模式）
// payload: { roomName, videoInfo }
secureIpcHandle('wt-create-room', async (event, payload = {}) => {
    try {
        const result = await watchTogetherService.createRoom(
            payload.roomName,
            payload.videoInfo
        );
        return result;
    } catch (error) {
        console.error('[WatchTogether] 创建房间失败:', error);
        return { success: false, error: error.message };
    }
});

// 加入房间（成员模式）
// payload: { roomCode }
secureIpcHandle('wt-join-room', async (event, payload = {}) => {
    try {
        if (!payload.roomCode) {
            return { success: false, error: '房间号不能为空' };
        }
        const result = await watchTogetherService.joinRoom(
            payload.roomCode,
            payload.hostAddress,
            { forceLocal: !!payload.forceLocal, port: payload.port }
        );
        return result;
    } catch (error) {
        console.error('[WatchTogether] 加入房间失败:', error);
        return { success: false, error: error.message };
    }
});

// 离开房间
secureIpcHandle('wt-leave-room', async () => {
    try {
        return watchTogetherService.leaveRoom();
    } catch (error) {
        console.error('[WatchTogether] 离开房间失败:', error);
        return { success: false, error: error.message };
    }
});

// 广播播放状态（仅主机）
secureIpcHandle('wt-broadcast-state', async (event, state) => {
    try {
        return watchTogetherService.broadcastState(state);
    } catch (error) {
        console.error('[WatchTogether] 广播状态失败:', error);
        return { success: false, error: error.message };
    }
});

// 发送聊天消息
secureIpcHandle('wt-send-chat', async (event, text) => {
    try {
        return watchTogetherService.sendChat(text);
    } catch (error) {
        console.error('[WatchTogether] 发送消息失败:', error);
        return { success: false, error: error.message };
    }
});

// 成员：发送 RTT 探测（单调时钟时间戳由渲染进程生成并原样回显）
secureIpcHandle('wt-send-ping', async (event, ts) => {
    try {
        return watchTogetherService.sendPing(ts);
    } catch (error) {
        console.error('[WatchTogether] 发送 ping 失败:', error);
        return { success: false, error: error.message };
    }
});

// 查询当前房间信息
secureIpcHandle('wt-get-room-info', async () => {
    try {
        return Object.assign({ success: true }, watchTogetherService.getRoomInfo());
    } catch (error) {
        console.error('[WatchTogether] 获取房间信息失败:', error);
        return { success: false, error: error.message };
    }
});
