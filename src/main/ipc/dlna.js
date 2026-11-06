function registerDlnaIpc({ handle, playerSvc, videoStreamProxy }) {
    handle('dlna-discover', async (event, options = {}) => {
        try {
            const devices = await playerSvc.dlna().discoverDevices(options);
            return { success: true, devices };
        } catch (error) {
            console.error('[DLNA] 搜索设备失败:', error);
            return { success: false, error: error.message, devices: [] };
        }
    });

    handle('dlna-cast', async (event, payload = {}) => {
        try {
            if (!payload.deviceId) return { success: false, error: '未指定投屏设备' };
            if (!payload.url) return { success: false, error: '视频地址为空' };

            const target = videoStreamProxy.resolveProxyTarget(payload.url, payload.headers);
            await playerSvc.dlna().startProxyServer();
            playerSvc.dlna().setProxyTarget({
                url: target.url,
                headers: target.headers,
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

    handle('dlna-pause', async (event, deviceId) => {
        try {
            await playerSvc.dlna().pause(deviceId);
            return { success: true };
        } catch (error) {
            console.error('[DLNA] 暂停失败:', error);
            return { success: false, error: error.message };
        }
    });

    handle('dlna-resume', async (event, deviceId) => {
        try {
            await playerSvc.dlna().resume(deviceId);
            return { success: true };
        } catch (error) {
            console.error('[DLNA] 恢复播放失败:', error);
            return { success: false, error: error.message };
        }
    });

    handle('dlna-stop', async (event, deviceId) => {
        try {
            await playerSvc.dlna().stop(deviceId);
            return { success: true };
        } catch (error) {
            console.error('[DLNA] 停止失败:', error);
            return { success: false, error: error.message };
        }
    });

    handle('dlna-seek', async (event, deviceId, seconds) => {
        try {
            await playerSvc.dlna().seek(deviceId, seconds);
            return { success: true };
        } catch (error) {
            console.error('[DLNA] 跳转失败:', error);
            return { success: false, error: error.message };
        }
    });

    handle('dlna-get-position', async (event, deviceId) => {
        try {
            const info = await playerSvc.dlna().getPosition(deviceId);
            return { success: true, ...info };
        } catch (error) {
            console.error('[DLNA] 获取播放位置失败:', error);
            return { success: false, error: error.message, position: 0, duration: 0 };
        }
    });
}

module.exports = { registerDlnaIpc };
