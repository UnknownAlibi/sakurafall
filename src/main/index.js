const { app, BrowserWindow, Menu, ipcMain, dialog, session, shell, nativeImage, protocol, clipboard } = require('electron');
const processStartedAt = Date.now();

// Episode selection happens in the catalog window and playback starts in a separate player window.
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
const cmsApiService = require('./services/CmsApiService');
const danmakuApi = require('./services/DanmakuApi');
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
const { CustomizationPackService, MAX_PACK_BYTES, MAX_THEME_PACK_BYTES } = require('./services/CustomizationPackService');
const { RuntimeDiagnosticsService } = require('./services/RuntimeDiagnosticsService');
const { BtSearchService } = require('./services/bt/BtSearchService');
const { registerBtIpc } = require('./ipc/bt');
const { registerDanmakuIpc } = require('./ipc/danmaku');
const { registerLibraryIpc } = require('./ipc/library');
const { registerPlaybackHealthIpc } = require('./ipc/playbackHealth');
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
const { btStreamService } = registerBtIpc({ ipcMain, btSearchService, customizationPackService, dialog, BrowserWindow });

// ===== GPU 稳定性防线 =====
// 日志实测：部分 Windows 机器上 GPU 进程每 ~5 秒被 kill 一次无限循环，
// Chromium 每次都回退软件渲染重试，导致界面动画（完整演出档）整体卡顿。
// 三层防御：
// 1. 禁用原生窗口遮挡计算（Chromium 在 Windows 上的已知 GPU 误杀 bug）
// 2. 运行时监控：短时间反复崩溃 → 写标记并自动重启，下次启动禁用硬件加速
// 3. 标记 7 天自动过期，驱动更新后可自愈恢复硬件加速
const GPU_FLAG_FILE = path.join(app.getPath('userData'), 'gpu-disable-flag.json');
const GPU_FLAG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const GPU_CRASH_WINDOW_MS = 30 * 1000;
const GPU_CRASH_THRESHOLD = 3;

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
    if (details?.type !== 'GPU') return;
    const now = Date.now();
    gpuCrashTimestamps.push(now);
    while (gpuCrashTimestamps.length > 0 && gpuCrashTimestamps[0] < now - GPU_CRASH_WINDOW_MS) {
        gpuCrashTimestamps.shift();
    }
    console.warn(`[GpuGuard] GPU 进程异常退出 (reason=${details.reason}), 近 ${GPU_CRASH_WINDOW_MS / 1000}s 内第 ${gpuCrashTimestamps.length} 次`);
    if (gpuCrashTimestamps.length < GPU_CRASH_THRESHOLD || gpuGuardRelaunching) return;

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
    updateChecker.setServiceBaseUrl?.(activeServiceBaseUrl);
    watchTogetherService.setRelayBaseUrl?.(activeServiceBaseUrl);
    console.log(`[Network] 数据连接方式: ${serviceMode === 'cloud' ? 'SakuraFall 云服务（带本机回退）' : '本机直连'}`);

    if (proxy) {
        console.log(`[Network] Bangumi 使用代理: ${proxy}（视频源与播放流保持直连）`);
    }
    bangumiApi.setProxy?.(proxy);
    // 备用元数据源 AniList 与 Bangumi 走相同代理
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

    // Phase 7: 同步给 NetworkPolicyService（用于诊断与策略查询）
    networkPolicyService.setProxy(proxy);
    // 应用 per-service 策略覆盖（若有）
    if (config.networkPolicies) {
        networkPolicyService.setPolicies(config.networkPolicies);
    }
    // 视频流线路策略：'proxy' 时渲染进程（hls.js 视频分片）也走应用代理；
    // 'direct'/'system' 保持直连（system 与 Bangumi 专用代理无法在同一个 PAC 内混合表达）
    const videoPolicy = networkPolicyService.getPolicy('video');

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

// ===== Phase 9: 窗口状态持久化（尺寸/位置/最大化） =====
const windowStateSaveTimers = new Map();

function getWindowStateFile() {
    return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
    try {
        const file = getWindowStateFile();
        if (fs.existsSync(file)) {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        }
    } catch (e) {
        console.warn('[WindowState] 读取失败:', e.message);
    }
    return {};
}

function saveWindowState(key, win) {
    if (windowStateSaveTimers.has(key)) clearTimeout(windowStateSaveTimers.get(key));
    windowStateSaveTimers.set(key, setTimeout(() => {
        windowStateSaveTimers.delete(key);
        try {
            if (win.isDestroyed()) return;
            const data = loadWindowState();
            const bounds = win.getBounds();
            data[key] = {
                width: bounds.width,
                height: bounds.height,
                x: bounds.x,
                y: bounds.y,
                isMaximized: win.isMaximized()
            };
            fs.writeFileSync(getWindowStateFile(), JSON.stringify(data, null, 2), 'utf8');
        } catch (e) {
            console.warn('[WindowState] 保存失败:', e.message);
        }
    }, 500));
}

/**
 * 应用持久化的窗口状态（尺寸/位置/最大化）
 * @param {BrowserWindow} win
 * @param {string} key - 'mainWindow' | 'playerWindow'
 * @param {object} defaults - { minWidth, minHeight }
 */
function applyWindowState(win, key, defaults = {}) {
    const state = loadWindowState()[key];
    if (!state || !Number.isFinite(state.width) || !Number.isFinite(state.height)) {
        return false;
    }
    const bounds = {
        width: Math.max(defaults.minWidth || 400, state.width),
        height: Math.max(defaults.minHeight || 300, state.height)
    };
    if (Number.isFinite(state.x) && Number.isFinite(state.y)) {
        bounds.x = state.x;
        bounds.y = state.y;
    }
    try {
        win.setBounds(bounds);
    } catch (e) { /* 多显示器场景下 x/y 可能无效，忽略 */ }
    if (state.isMaximized) {
        win.maximize();
    }
    return true;
}

/**
 * 绑定窗口尺寸/位置/最大化变更的持久化（防抖 500ms）
 */
function bindWindowStatePersistence(win, key) {
    const handler = () => {
        if (win.isDestroyed()) return;
        saveWindowState(key, win);
    };
    win.on('resize', handler);
    win.on('move', handler);
    win.on('maximize', handler);
    win.on('unmaximize', handler);
}

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
    // 窗口已销毁，此时触发一次主动 GC 把主进程内存还给系统
    if (typeof global.gc === 'function') global.gc();
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

    // 按 webContents.id 缓存视频数据，该窗口加载后通过 IPC 拉取
    // 注意：closed 事件触发时 webContents 已被销毁，所以必须提前缓存 id
    const webContentsId = win.webContents.id;
    pendingPlayerDataMap.set(webContentsId, videoData || null);
    playerWindows.add(win);

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
        playerWindows.delete(win);
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
        // 将数据库实例注入各数据源服务以启用接口缓存（复用同一张 cms_cache 表）
        cmsApiService.setDatabase(animeDb);
        bangumiApi.setDatabase(animeDb);
        subjectService.setDatabase(animeDb);
        // P0: 本地 Bangumi 索引服务（本地查询为主，网络同步为辅）
        subjectIndexService.setDatabase(animeDb);
        danmakuApi.setDatabase(animeDb);
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
            const sourceHeaders = sourceProviderRegistry.getRequestHeadersForUrl(reqUrl);
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

    // 启动后静默检查更新（仅打包生效，开发模式跳过）
    if (!isDev) {
        setTimeout(async () => {
            try {
                const result = await updateChecker.checkForUpdates({ silent: true });
                if (result.hasUpdate && mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('update-available', result);
                }
            } catch (e) {
                // 静默检查失败不影响使用
            }
        }, 5000);
    }
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

// 独立播放窗口：打开
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
    return playerSvc.enhanced().check(options);
});

secureIpcHandle('enhanced-player-open', async (event, options = {}) => {
    return playerSvc.enhanced().open(options);
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

// ===== Phase 7: 网络与 TUN 分流策略 =====
secureIpcHandle('network-policy-get', async () => {
    return {
        policies: networkPolicyService.policies,
        proxyUrl: networkPolicyService.proxyUrl,
        serviceIds: Object.values(networkPolicyService.constructor.SERVICE_IDS),
        policyModes: Object.values(networkPolicyService.constructor.POLICY_MODES),
        domainSuggestions: networkPolicyService.getDomainSuggestions()
    };
});

secureIpcHandle('network-policy-update', async (event, policies = {}) => {
    networkPolicyService.setPolicies(policies);
    return { success: true, policies: networkPolicyService.policies };
});

secureIpcHandle('network-test-proxy-port', async () => {
    return networkPolicyService.testProxyPort();
});

secureIpcHandle('network-test-bangumi', async () => {
    return networkPolicyService.testBangumi();
});

secureIpcHandle('network-test-playback-source', async () => {
    return networkPolicyService.testPlaybackSource();
});

secureIpcHandle('network-test-danmaku', async () => {
    return networkPolicyService.testDanmaku();
});

secureIpcHandle('network-test-trace-moe', async () => {
    return networkPolicyService.testTraceMoe();
});

secureIpcHandle('network-test-m3u8', async (event, url, referer = '') => {
    return networkPolicyService.testM3u8(url, referer);
});

secureIpcHandle('network-detect-tun', async () => {
    return networkPolicyService.detectTunMode();
});

secureIpcHandle('network-run-diagnostics', async () => {
    return networkPolicyService.runFullDiagnostics();
});

secureIpcHandle('network-domain-suggestions', async () => {
    return networkPolicyService.getDomainSuggestions();
});

// ===== Phase 4: 插件式源规则系统 IPC =====
// 与 cms-* 通道并存：CMS 源走 cms-*，XPath 规则源走 plugin-*

// 查询
secureIpcHandle('plugin-get-list', () => sourcePluginManager.getAllForManagement());
secureIpcHandle('plugin-get-detail', (_e, id) => sourcePluginManager.getRuleDetail(id));

// 增删改
secureIpcHandle('plugin-add', (_e, raw) => sourcePluginManager.addRule(raw));
secureIpcHandle('plugin-update', (_e, id, raw) => sourcePluginManager.updateRule(id, raw));
secureIpcHandle('plugin-remove', (_e, id) => sourcePluginManager.removeRule(id));
secureIpcHandle('plugin-set-enabled', (_e, id, enabled) => sourcePluginManager.setEnabled(id, enabled));

// 导入导出
secureIpcHandle('plugin-export', () => sourcePluginManager.exportRules());
secureIpcHandle('plugin-import', (_e, jsonString, options) => sourcePluginManager.importRules(jsonString, options));
secureIpcHandle('plugin-import-installed-rules', () => {
    const candidates = [
        path.join(app.getPath('userData'), 'extensions', 'plugins', 'plugins.json'),
        path.join(app.getPath('userData'), 'plugins', 'v2', 'plugins.json')
    ];
    const filePath = candidates.find(candidate => fs.existsSync(candidate));
    if (!filePath) {
        return { success: false, error: '未找到本机已安装的开源片源规则，请改用“导入 JSON”选择规则文件' };
    }
    try {
        const result = sourcePluginManager.importRules(fs.readFileSync(filePath, 'utf8'), { overwrite: true });
        return { ...result, filePath };
    } catch (error) {
        return { success: false, error: error.message, filePath };
    }
});

// 文件导入导出（复用 dialog）
secureIpcHandle('plugin-save-file', async (_e, defaultName) => {
    const result = sourcePluginManager.exportRules();
    const { canceled, filePath } = await dialog.showSaveDialog({
        defaultPath: defaultName || 'plugin-sources.json',
        filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePath) return { success: false, canceled: true };
    try {
        fs.writeFileSync(filePath, result.json, 'utf8');
        return { success: true, filePath, count: result.count };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

secureIpcHandle('plugin-load-file', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePaths || filePaths.length === 0) return { success: false, canceled: true };
    try {
        const content = fs.readFileSync(filePaths[0], 'utf8');
        return { success: true, content, filePath: filePaths[0] };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// 执行
secureIpcHandle('plugin-search', (_e, id, keyword, options) => sourcePluginManager.search(id, keyword, options || {}));
secureIpcHandle('plugin-search-all', (_e, keyword, options) => sourcePluginManager.searchAll(keyword, options || {}));
secureIpcHandle('plugin-parse-detail', (_e, id, pageUrl, options) => sourcePluginManager.parseDetail(id, pageUrl, options || {}));
secureIpcHandle('plugin-test', (_e, id) => sourcePluginManager.test(id));
secureIpcHandle('plugin-test-all', () => sourcePluginManager.testAll());

// Unified playback-source boundary for CMS and rule-based providers.
secureIpcHandle('source-provider-list', (_event, options) => sourceProviderRegistry.listProviders(options || {}));
secureIpcHandle('source-provider-search', (_event, providerId, keyword, options) => (
    sourceProviderRegistry.search(providerId, keyword, options || {})
));
secureIpcHandle('source-provider-search-all', (_event, keyword, options) => (
    sourceProviderRegistry.searchAll(keyword, options || {})
));
secureIpcHandle('source-provider-detail', (_event, providerId, reference, options) => (
    sourceProviderRegistry.getDetail(providerId, reference, options || {})
));
secureIpcHandle('source-provider-categories', (_event, providerId) => (
    sourceProviderRegistry.getCategories(providerId)
));
secureIpcHandle('source-provider-catalog', (_event, providerId, options) => (
    sourceProviderRegistry.getCatalog(providerId, options || {})
));
secureIpcHandle('source-provider-test', (_event, providerId) => sourceProviderRegistry.test(providerId));
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

secureIpcHandle('image-cache-get-cover', async (event, url, options) => {
    try {
        return await imageCacheService.getCover(url, options);
    } catch (error) {
        console.error('[ImageCache] 封面缓存失败:', error);
        return { success: false, originalUrl: url || '', error: error.message };
    }
});

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

// 新增数据库相关的 IPC 处理程序
secureIpcHandle('get-anime-list', async (event, page = 1, limit = 20, search = '') => {
    try {
        return await animeDb.getAnimeList(page, limit, search);
    } catch (error) {
        console.error('获取动漫列表失败:', error);
        return { data: [], total: 0, page, limit, totalPages: 0 };
    }
});

secureIpcHandle('get-anime-detail', async (event, animeId) => {
    try {
        return await animeDb.getAnimeDetail(animeId);
    } catch (error) {
        console.error('获取动漫详情失败:', error);
        return null;
    }
});

secureIpcHandle('search-anime', async (event, keyword, limit = 10) => {
    try {
        return await animeDb.searchAnime(keyword, limit);
    } catch (error) {
        console.error('搜索动漫失败:', error);
        return [];
    }
});

secureIpcHandle('get-popular-types', async () => {
    try {
        return await animeDb.getPopularTypes();
    } catch (error) {
        console.error('获取热门分类失败:', error);
        return [];
    }
});

// ======
// Bangumi (番组计划) 在线数据源 IPC 处理
// ======

// 获取 Bangumi 季度番剧列表
secureIpcHandle('bangumi-get-calendar', async () => {
    try {
        return await bangumiApi.getCalendar();
    } catch (error) {
        console.error('[Bangumi] 获取季度番剧失败:', error);
        return { error: error.message };
    }
});

// 获取所有 Bangumi 番剧（扁平列表）
secureIpcHandle('bangumi-get-all', async () => {
    try {
        const animeList = await bangumiApi.getAllAnime();
        return {
            data: animeList,
            total: animeList.length,
            page: 1,
            totalPages: 1
        };
    } catch (error) {
        console.error('[Bangumi] 获取番剧列表失败:', error);
        return { data: [], total: 0, page: 1, totalPages: 0, error: error.message };
    }
});

// 按季度获取 Bangumi 番剧（支持历史季度 + 分页）
secureIpcHandle('bangumi-get-season', async (event, year, season, page = 1) => {
    try {
        return await bangumiApi.getSeasonAnime(year, season, page);
    } catch (error) {
        console.error('[Bangumi] 获取季度番剧失败:', error);
        return { data: [], total: 0, page, totalPages: 0, year, season, error: error.message };
    }
});

// 搜索 Bangumi 番剧
secureIpcHandle('bangumi-search', async (event, keyword, page = 1) => {
    try {
        return await bangumiApi.search(keyword, page);
    } catch (error) {
        console.error('[Bangumi] 搜索失败:', error);
        return { data: [], total: 0, page, totalPages: 0, error: error.message };
    }
});

// 获取 Bangumi 番剧详情
secureIpcHandle('bangumi-get-detail', async (event, bgmId) => {
    try {
        return await bangumiApi.getDetail(bgmId);
    } catch (error) {
        console.error('[Bangumi] 获取详情失败:', error);
        return null;
    }
});

// 获取 Bangumi 番剧角色（含声优）
secureIpcHandle('bangumi-get-characters', async (event, bgmId) => {
    try {
        return await bangumiApi.getCharacters(bgmId);
    } catch (error) {
        console.error('[Bangumi] 获取角色失败:', error);
        return [];
    }
});

// 获取 Bangumi 番剧已更新集数（基于官方 episodes airdate 统计）
secureIpcHandle('bangumi-get-aired-episode-count', async (event, bgmId) => {
    try {
        return await bangumiApi.getAiredEpisodeCount(bgmId);
    } catch (error) {
        console.error('[Bangumi] 获取已更新集数失败:', error);
        return null;
    }
});

// 获取 Bangumi 番剧制作人员
secureIpcHandle('bangumi-get-staff', async (event, bgmId) => {
    try {
        return await bangumiApi.getStaff(bgmId);
    } catch (error) {
        console.error('[Bangumi] 获取制作人员失败:', error);
        return [];
    }
});

// 获取 Bangumi 番剧短评（吐槽）
secureIpcHandle('bangumi-get-comments', async (event, bgmId, page = 1) => {
    try {
        return await bangumiApi.getComments(bgmId, page);
    } catch (error) {
        console.error('[Bangumi] 获取短评失败:', error);
        return { data: [], total: 0, page, totalPages: 0, error: error.message };
    }
});

// 测试 Bangumi API 连通性
secureIpcHandle('bangumi-test', async () => {
    try {
        return await bangumiApi.test();
    } catch (error) {
        console.error('[Bangumi] API 测试失败:', error);
        return { ok: false, msg: error.message };
    }
});

// 获取新番时间表（按星期分组）
secureIpcHandle('bangumi-get-schedule', async () => {
    try {
        return await bangumiApi.getSchedule();
    } catch (error) {
        console.error('[Bangumi] 获取新番时间表失败:', error);
        return [];
    }
});

// ======
// SubjectService IPC（Bangumi 资料主干，Phase 1）
// ======

// 获取热门番剧（Next API 优先，失败回退到 calendar 派生）
secureIpcHandle('subject-trending', async (event, options = {}) => {
    try {
        return await subjectService.getTrendingSubjects(options || {});
    } catch (error) {
        console.error('[Subject] 获取热门番剧失败:', error);
        return [];
    }
});

// 获取新番时间表（标准化为 SubjectSummary）
secureIpcHandle('subject-calendar', async () => {
    try {
        return await subjectService.getCalendar();
    } catch (error) {
        console.error('[Subject] 获取新番时间表失败:', error);
        return [];
    }
});

// 获取季度番剧列表
secureIpcHandle('subject-season', async (event, year, quarter, page = 1) => {
    try {
        return await subjectService.getSeason(year, quarter, page);
    } catch (error) {
        console.error('[Subject] 获取季度番剧失败:', error);
        return { data: [], total: 0, page, totalPages: 0, year, quarter, error: error.message };
    }
});

// 搜索番剧
secureIpcHandle('subject-search', async (event, keyword, page = 1) => {
    try {
        return await subjectService.search(keyword, page);
    } catch (error) {
        console.error('[Subject] 搜索失败:', error);
        return { data: [], total: 0, page, totalPages: 0, error: error.message };
    }
});

// Shareable source packs combine CMS endpoints and XPath rules in one file.
secureIpcHandle('source-pack-import-file', async (event, options = {}) => {
    try {
        const win = BrowserWindow.fromWebContents(event.sender);
        const result = await dialog.showOpenDialog(win, {
            title: '导入片源包',
            properties: ['openFile'],
            filters: [{ name: 'SakuraFall Source Pack', extensions: ['json', 'sourcepack'] }]
        });
        if (result.canceled || !result.filePaths?.length) return { success: false, canceled: true };

        const filePath = result.filePaths[0];
        if (fs.statSync(filePath).size > MAX_PACK_BYTES) return { success: false, error: '源包超过 512KB 限制' };
        const imported = customizationPackService.importSourcePack(fs.readFileSync(filePath, 'utf8'), options);
        return { ...imported, filePath };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

secureIpcHandle('source-pack-export-file', async (event, metadata = {}) => {
    try {
        const win = BrowserWindow.fromWebContents(event.sender);
        const exported = customizationPackService.exportSourcePack(metadata);
        const result = await dialog.showSaveDialog(win, {
            title: '导出片源包',
            defaultPath: `${exported.pack.metadata.id}.sourcepack.json`,
            filters: [{ name: 'SakuraFall Source Pack', extensions: ['json'] }]
        });
        if (result.canceled || !result.filePath) return { success: false, canceled: true };
        fs.writeFileSync(result.filePath, exported.json, 'utf8');
        return { success: true, filePath: result.filePath, count: exported.count };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

secureIpcHandle('source-pack-list', () => customizationPackService.listSourcePacks());
secureIpcHandle('source-pack-get', (_event, id) => customizationPackService.getSourcePack(id));
secureIpcHandle('source-pack-remove', (_event, id) => customizationPackService.removeSourcePack(id));
secureIpcHandle('source-pack-check-updates', async () => {
    const targets = customizationPackService.getSourcePackUpdateTargets();
    return Promise.all(targets.map(async target => {
        try {
            const text = await pluginHttpClient.fetch(target.updateUrl, { charset: 'utf8' });
            const remote = customizationPackService.validateSourcePack(text);
            if (remote.metadata.id !== target.id) throw new Error('远程源包 id 与已安装包不一致');
            return {
                ...target,
                latestVersion: remote.metadata.version,
                updateAvailable: customizationPackService.isNewerVersion(remote.metadata.version, target.version),
                error: ''
            };
        } catch (error) {
            return { ...target, latestVersion: target.version, updateAvailable: false, error: error.message };
        }
    }));
});
secureIpcHandle('source-pack-update', async (_event, id) => {
    const current = customizationPackService.getSourcePack(id);
    if (!current?.metadata?.updateUrl) return { success: false, error: '该源包没有 updateUrl' };
    try {
        const text = await pluginHttpClient.fetch(current.metadata.updateUrl, { charset: 'utf8' });
        const remote = customizationPackService.validateSourcePack(text);
        if (remote.metadata.id !== current.metadata.id) throw new Error('远程源包 id 不一致');
        if (!customizationPackService.isNewerVersion(remote.metadata.version, current.metadata.version)) {
            return { success: true, updated: false, metadata: current.metadata };
        }
        const result = customizationPackService.importSourcePack(JSON.stringify(remote), { overwrite: true, install: true });
        return { ...result, updated: result.success === true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

secureIpcHandle('theme-pack-list', () => customizationPackService.listThemePacks());
secureIpcHandle('theme-pack-get', (_event, id) => customizationPackService.getThemePack(id));
secureIpcHandle('theme-pack-remove', (_event, id) => customizationPackService.removeThemePack(id));
secureIpcHandle('theme-pack-import-file', async (event) => {
    try {
        const win = BrowserWindow.fromWebContents(event.sender);
        const result = await dialog.showOpenDialog(win, {
            title: '安装界面主题包',
            properties: ['openFile'],
            filters: [{ name: 'SakuraFall Theme Pack', extensions: ['json', 'themepack'] }]
        });
        if (result.canceled || !result.filePaths?.length) return { success: false, canceled: true };

        const filePath = result.filePaths[0];
        if (fs.statSync(filePath).size > MAX_THEME_PACK_BYTES) return { success: false, error: '主题包超过 8MB 限制' };
        const installed = customizationPackService.installThemePack(fs.readFileSync(filePath, 'utf8'));
        return { ...installed, filePath };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// 浏览 Bangumi 官方目录（主列表默认入口）
secureIpcHandle('subject-catalog', async (event, options = {}) => {
    try {
        return await subjectService.catalog(options || {});
    } catch (error) {
        console.error('[Subject] 浏览目录失败:', error);
        return { data: [], total: 0, page: options?.page || 1, totalPages: 0, error: error.message };
    }
});

// 按 Bangumi 元标签/排序浏览番剧（首页类型筛选）
secureIpcHandle('subject-browse', async (event, options = {}) => {
    try {
        return await subjectService.browse(options || {});
    } catch (error) {
        console.error('[Subject] 浏览番剧失败:', error);
        return { data: [], total: 0, page: options?.page || 1, totalPages: 0, error: error.message };
    }
});

// 获取番剧详情（标准化为 SubjectDetail）
secureIpcHandle('subject-detail', async (event, bgmId) => {
    try {
        return await subjectService.getDetail(bgmId);
    } catch (error) {
        console.error('[Subject] 获取详情失败:', error);
        return null;
    }
});

// 获取番剧分集列表
secureIpcHandle('subject-episodes', async (event, bgmId, options = {}) => {
    try {
        return await subjectService.getEpisodes(bgmId, options || {});
    } catch (error) {
        console.error('[Subject] 获取分集失败:', error);
        return { data: [], total: 0, error: error.message };
    }
});

// ======
// SubjectIndexService IPC（P0：本地 Bangumi 索引）
// 本地查询为主，网络同步为辅，不阻塞 UI
// ======

// 本地索引查询（keyword/tag/year/month/sort/分页）
secureIpcHandle('subject-index-query', async (event, filters = {}) => {
    try {
        return subjectIndexService.querySubjects(filters || {});
    } catch (error) {
        console.error('[SubjectIndex] 查询失败:', error);
        return { data: [], total: 0, page: 1, pageSize: 24, totalPages: 0, fromIndex: true, error: error.message };
    }
});

// 按 bgm_id 查询单个条目
secureIpcHandle('subject-index-get', async (event, bgmId) => {
    try {
        return subjectIndexService.getSubjectByBgmId(bgmId);
    } catch (error) {
        console.error('[SubjectIndex] 获取单个失败:', error);
        return null;
    }
});

// 按星期查询（新番时间表）
secureIpcHandle('subject-index-weekday', async (event, weekday) => {
    try {
        return subjectIndexService.queryByWeekday(weekday);
    } catch (error) {
        console.error('[SubjectIndex] 按星期查询失败:', error);
        return [];
    }
});

// 后台同步季度番剧
secureIpcHandle('subject-index-sync-season', async (event, year, season) => {
    try {
        return await subjectIndexService.syncSeason(year, season);
    } catch (error) {
        console.error('[SubjectIndex] 同步季度失败:', error);
        return { synced: 0, error: error.message };
    }
});

// 后台同步日历（当前季度）
secureIpcHandle('subject-index-sync-calendar', async () => {
    try {
        return await subjectIndexService.syncCalendar();
    } catch (error) {
        console.error('[SubjectIndex] 同步日历失败:', error);
        return { synced: 0, error: error.message };
    }
});

// 详情过期则同步
secureIpcHandle('subject-index-sync-detail', async (event, bgmId) => {
    try {
        return await subjectIndexService.syncDetailIfStale(bgmId);
    } catch (error) {
        console.error('[SubjectIndex] 同步详情失败:', error);
        return null;
    }
});

// 获取同步状态
secureIpcHandle('subject-index-status', async () => {
    try {
        return subjectIndexService.getSyncStatus();
    } catch (error) {
        console.error('[SubjectIndex] 获取同步状态失败:', error);
        return { indexed: 0, lastSync: {}, error: error.message };
    }
});

registerDanmakuIpc({ handle: secureIpcHandle, danmakuApi });

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
// 通用 CMS API IPC 处理器（多源支持）
// ======

secureIpcHandle('cms-get-sources', async () => {
    return cmsApiService.getSourceList();
});

secureIpcHandle('cms-reload-sources', async () => {
    return cmsApiService.reloadSources();
});

secureIpcHandle('cms-get-config-info', async () => {
    return cmsApiService.getSourcesConfigInfo();
});

secureIpcHandle('cms-open-config-file', async () => {
    try {
        const userPath = cmsApiService.ensureUserConfigFile();
        const result = await shell.openPath(userPath);
        return { success: !result, error: result || null };
    } catch (error) {
        console.error('[CmsApi] 打开源配置文件失败:', error);
        return { success: false, error: error.message };
    }
});

secureIpcHandle('cms-set-source', async (event, sourceId) => {
    return cmsApiService.setSource(sourceId);
});

secureIpcHandle('cms-get-categories', async () => {
    try {
        return await cmsApiService.getCategories();
    } catch (error) {
        console.error('[CmsApi] 获取分类失败:', error);
        return [];
    }
});

secureIpcHandle('cms-get-list', async (event, categoryId, page = 1, options = {}) => {
    try {
        return await cmsApiService.getList(categoryId, page, options);
    } catch (error) {
        console.error('[CmsApi] 获取列表失败:', error);
        return { data: [], total: 0, page, totalPages: 0, error: error.message };
    }
});

secureIpcHandle('cms-get-detail', async (event, id, options = {}) => {
    try {
        return await cmsApiService.getDetail(id, options);
    } catch (error) {
        console.error('[CmsApi] 获取详情失败:', error);
        return { error: error.message };
    }
});

secureIpcHandle('cms-search', async (event, keyword, page = 1) => {
    try {
        return await cmsApiService.search(keyword, page);
    } catch (error) {
        console.error('[CmsApi] 搜索失败:', error);
        return { data: [], total: 0, page, totalPages: 0, keyword, error: error.message };
    }
});

secureIpcHandle('cms-search-in-source', async (event, sourceId, keyword, page = 1) => {
    try {
        return await cmsApiService.searchInSource(sourceId, keyword, page);
    } catch (error) {
        console.error('[CmsApi] 在指定源搜索失败:', error);
        return { data: [], total: 0, page, totalPages: 0, sourceId, keyword, error: error.message };
    }
});

// 在所有源中搜索同名番（用于播放器/追番回退查找）
secureIpcHandle('cms-search-all-sources', async (event, keyword) => {
    try {
        return await cmsApiService.searchAllSources(keyword);
    } catch (error) {
        console.error('[CmsApi] 全源搜索失败:', error);
        return [];
    }
});

// 全源搜索并返回 per-source 状态（Phase 3：SourceSearchStatus[]）
secureIpcHandle('cms-search-all-sources-with-status', async (event, keyword, options = {}) => {
    try {
        return await cmsApiService.searchAllSourcesWithStatus(keyword, options || {});
    } catch (error) {
        console.error('[CmsApi] 全源搜索(带状态)失败:', error);
        return [];
    }
});

// 全源搜索并按集数匹配 + 清晰度探测选择最佳播放源
secureIpcHandle('cms-select-best-episode-source', async (event, keyword, target = {}) => {
    try {
        return await sourceProviderRegistry.selectBestEpisodeSource(keyword, target);
    } catch (error) {
        console.error('[CmsApi] 选择最佳播放源失败:', error);
        return { best: null, candidates: [], skipped: [], error: error.message };
    }
});

secureIpcHandle('cms-test', async () => {
    return await cmsApiService.test();
});

secureIpcHandle('cms-test-all', async () => {
    return await cmsApiService.testAll();
});

// 数据源规则编辑器：增删改 / 导入 / 导出
secureIpcHandle('cms-add-source', async (event, sourceConfig) => {
    try {
        return cmsApiService.addSource(sourceConfig);
    } catch (error) {
        console.error('[CmsApi] 添加数据源失败:', error);
        return { success: false, error: error.message };
    }
});

secureIpcHandle('cms-update-source', async (event, sourceId, config) => {
    try {
        return cmsApiService.updateSource(sourceId, config);
    } catch (error) {
        console.error('[CmsApi] 更新数据源失败:', error);
        return { success: false, error: error.message };
    }
});

secureIpcHandle('cms-remove-source', async (event, sourceId) => {
    try {
        return cmsApiService.removeSource(sourceId);
    } catch (error) {
        console.error('[CmsApi] 删除数据源失败:', error);
        return { success: false, error: error.message };
    }
});

secureIpcHandle('cms-export-sources', async () => {
    try {
        return cmsApiService.exportSources();
    } catch (error) {
        console.error('[CmsApi] 导出数据源失败:', error);
        return { success: false, error: error.message, json: '', count: 0 };
    }
});

secureIpcHandle('cms-import-sources', async (event, jsonString, options) => {
    try {
        return cmsApiService.importSources(jsonString, options || {});
    } catch (error) {
        console.error('[CmsApi] 导入数据源失败:', error);
        return { success: false, error: error.message, added: 0, overwritten: 0, skipped: 0, errors: [] };
    }
});

// 保存导出的数据源 JSON 文件到磁盘
secureIpcHandle('cms-save-sources-file', async (event, defaultName) => {
    try {
        const win = BrowserWindow.fromWebContents(event.sender);
        const exportResult = cmsApiService.exportSources();
        if (!exportResult.success) return exportResult;
        const result = await dialog.showSaveDialog(win, {
            title: '导出数据源配置',
            defaultPath: defaultName || 'sakurafall-sources.json',
            filters: [{ name: 'JSON', extensions: ['json'] }]
        });
        if (result.canceled || !result.filePath) {
            return { success: false, canceled: true };
        }
        fs.writeFileSync(result.filePath, exportResult.json, 'utf8');
        return { success: true, filePath: result.filePath, count: exportResult.count };
    } catch (error) {
        console.error('[CmsApi] 保存数据源文件失败:', error);
        return { success: false, error: error.message };
    }
});

// 从磁盘读取 JSON 文件用于导入
secureIpcHandle('cms-load-sources-file', async (event) => {
    try {
        const win = BrowserWindow.fromWebContents(event.sender);
        const result = await dialog.showOpenDialog(win, {
            title: '导入数据源配置',
            properties: ['openFile'],
            filters: [{ name: 'JSON', extensions: ['json'] }, { name: 'All Files', extensions: ['*'] }]
        });
        if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
            return { success: false, canceled: true };
        }
        const filePath = result.filePaths[0];
        const content = fs.readFileSync(filePath, 'utf8');
        return { success: true, content, filePath };
    } catch (error) {
        console.error('[CmsApi] 读取数据源文件失败:', error);
        return { success: false, error: error.message };
    }
});

// 清理 CMS 接口缓存
// options: { sourceId?, kind?: 'list'|'detail', expiredOnly? }
// 不传 options 则清空全部缓存
secureIpcHandle('cms-cache-clear', async (event, options = {}) => {
    try {
        const removed = cmsApiService.clearCache(options);
        console.log(`[Cache] 清理缓存 ${removed} 条`, options);
        return { success: true, removed };
    } catch (error) {
        console.error('[Cache] 清理缓存失败:', error);
        return { success: false, error: error.message };
    }
});

// ====== 应用更新检查 ======

secureIpcHandle('update-check', async () => updateChecker.checkForUpdates({ silent: false }));
secureIpcHandle('update-get-version', () => updateChecker.getCurrentVersion());
secureIpcHandle('update-get-url', () => updateChecker.getUpdateUrl());
secureIpcHandle('update-set-url', (event, url) => updateChecker.setUpdateUrl(url));

// 打开下载链接（系统浏览器，作为应用内更新的兜底）
secureIpcHandle('update-open-download', async (event, url) => {
    if (!url) return { success: false, error: '下载链接为空' };
    try {
        await shell.openExternal(updateChecker.normalizeDownloadUrl(url));
        return { success: true };
    } catch (error) {
        console.error('[Update] 打开下载链接失败:', error);
        return { success: false, error: error.message };
    }
});

// 应用内下载安装包，进度经 update-download-progress 推送到渲染进程
secureIpcHandle('update-download', (event, url) => updateChecker.downloadInstaller(url, p => {
    try { event.sender.send('update-download-progress', p); } catch (e) { /* sender destroyed */ }
}));

// 启动安装程序并退出应用（覆盖安装，用户数据保留）
secureIpcHandle('update-install', (event, filePath) => updateChecker.runInstaller(filePath));

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
        const target = dirPath || (downloader ? downloader.downloadDir : '');
        if (!target) return { success: false, error: '下载目录未设置' };
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
        shell.showItemInFolder(filePath);
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
