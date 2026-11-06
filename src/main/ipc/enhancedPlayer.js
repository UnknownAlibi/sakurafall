const { isMpvExecutablePath } = require('../utils/pathGuards');

function registerEnhancedPlayerIpc({ handle, playerSvc, videoStreamProxy }) {
    function normalizeOptions(options = {}) {
        if (!options || typeof options !== 'object' || Array.isArray(options)) return {};
        const mpvPath = String(options.mpvPath || '').trim();
        if (mpvPath && !isMpvExecutablePath(mpvPath)) {
            throw new Error('mpv 路径无效：请选择 mpv.exe、mpvnet.exe 或其变体');
        }
        // 播放器内部地址可能是 sakurafall-media://proxy/...，外部 mpv 无法识别；
        // 统一还原为原始 HTTP(S) 地址，并保留代理 URL 里的 Referer。
        const target = videoStreamProxy.resolveProxyTarget(options.url, options.headers);
        return { ...options, mpvPath, url: target.url, headers: target.headers };
    }

    handle('enhanced-player-check', async (event, options = {}) => {
        try {
            return playerSvc.enhanced().check(normalizeOptions(options));
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    handle('enhanced-player-open', async (event, options = {}) => {
        try {
            return playerSvc.enhanced().open(normalizeOptions(options));
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    handle('enhanced-player-install', async () => {
        return playerSvc.enhanced().install();
    });

    handle('enhanced-player-presets', async () => {
        return {
            presets: playerSvc.enhanced().getPresets(),
            defaultPresetId: playerSvc.enhanced().defaultPresetId
        };
    });
}

module.exports = { registerEnhancedPlayerIpc };
