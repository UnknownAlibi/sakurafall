// 应用更新相关 IPC：
//   - 检查更新 / 更新源配置
//   - 两步式应用内更新：主进程托管下载（切页不中断）→ 用户确认后安装并重启
// 更新事件统一广播到所有窗口，主窗口与独立播放窗口都能即时反映进度。

function registerUpdateIpc({ handle, updateChecker, shell, BrowserWindow }) {
    // 更新类事件广播到所有窗口：全局更新卡片可能出现在任意窗口，
    // 只发给 mainWindow 会让其它窗口的徽标状态与实际进度不一致。
    function broadcastUpdateEvent(channel, payload) {
        BrowserWindow.getAllWindows().forEach(w => {
            try { w.webContents.send(channel, payload); } catch (e) { /* destroyed */ }
        });
    }

    handle('update-check', async () => updateChecker.checkForUpdates({ silent: false }));
    handle('update-get-version', () => updateChecker.getCurrentVersion());
    handle('update-get-url', () => updateChecker.getUpdateUrl());
    handle('update-set-url', (event, url) => updateChecker.setUpdateUrl(url));

    // 打开下载链接（系统浏览器，作为应用内更新的兜底）
    handle('update-open-download', async (event, url) => {
        if (!url) return { success: false, error: '下载链接为空' };
        try {
            await shell.openExternal(updateChecker.normalizeDownloadUrl(url));
            return { success: true };
        } catch (error) {
            console.error('[Update] 打开下载链接失败:', error);
            return { success: false, error: error.message };
        }
    });

    // 第一步：下载由主进程托管，完成后停在 ready 等用户确认
    handle('update-download', (event, payload) => {
        // 兼容旧调用形式（只传 url 字符串）
        const url = typeof payload === 'string' ? payload : payload?.url;
        const meta = typeof payload === 'string'
            ? {}
            : { latestVersion: payload?.latestVersion, releaseNotes: payload?.releaseNotes };
        return updateChecker.startManagedUpdate(
            url,
            state => broadcastUpdateEvent('update-download-progress', state),
            meta
        );
    });

    // 第二步：用户确认安装；安装接力进程会等本应用退出后覆盖安装并拉起新版
    handle('update-install', () => updateChecker.installManagedUpdate(
        state => broadcastUpdateEvent('update-download-progress', state)
    ));

    handle('update-get-state', () => updateChecker.getUpdateState());

    // 启动后静默检查更新（仅打包生效）。
    // 开发模式默认跳过，避免每次起 dev 都打网络；需要本地验证整条更新链路时
    // 用 SAKURAFALL_UPDATE_CHECK_DEV=1 打开。
    function scheduleStartupUpdateCheck({ isDev, delayMs = 5000 }) {
        if (isDev && process.env.SAKURAFALL_UPDATE_CHECK_DEV !== '1') return;
        setTimeout(async () => {
            try {
                const result = await updateChecker.checkForUpdates({ silent: true });
                if (result.hasUpdate) broadcastUpdateEvent('update-available', result);
            } catch (e) {
                // 静默检查失败不影响使用
            }
        }, delayMs);
    }

    return { broadcastUpdateEvent, scheduleStartupUpdateCheck };
}

module.exports = { registerUpdateIpc };
