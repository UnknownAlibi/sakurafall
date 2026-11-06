const PLAYER_MINI_SIZE = { width: 400, height: 225 };

function registerPlayerWindowIpc({
    handle,
    playerWindows,
    pendingPlayerDataMap,
    playerPreMiniBounds = new Map(),
    createPlayerWindow,
    loadWindowState,
    BrowserWindow
}) {
    // 独立播放窗口：打开
    handle('background-playback-pressure', () => playerWindows.size > 0);

    handle('open-player-window', (event, videoData) => {
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
    handle('player-get-data', (event) => {
        const id = event.sender.id;
        return pendingPlayerDataMap.get(id);
    });

    // 独立播放窗口：将后台解析完成的数据推送到已打开的准备窗口
    handle('update-player-window', (event, windowId, videoData) => {
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

    handle('close-player-window', (event, windowId) => {
        const targetId = Number(windowId);
        const win = Array.from(playerWindows).find(item => (
            !item.isDestroyed() && item.webContents.id === targetId
        ));
        if (!win) return false;
        win.close();
        return true;
    });

    // 独立播放窗口：切换置顶
    handle('player-toggle-top', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win) return false;
        const newState = !win.isAlwaysOnTop();
        win.setAlwaysOnTop(newState);
        return newState;
    });

    // 独立播放窗口：查询当前置顶状态
    handle('player-is-top', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        return win ? win.isAlwaysOnTop() : false;
    });

    // Phase 9: 迷你模式（缩小窗口 + 置顶 + 跳过任务栏可选）
    // 迷你模式：400x225（16:9），始终置顶，不在任务栏显示（仅托盘区）
    // 退出迷你模式：恢复为持久化的播放窗口尺寸
    handle('player-toggle-mini', (event) => {
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
                console.error('[MiniMode] 退出失败:', e);
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
                console.error('[MiniMode] 进入失败:', e);
            }
            return true;
        }
    });

    handle('player-is-mini', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win) return false;
        return win.getBounds().width <= PLAYER_MINI_SIZE.width + 10;
    });
}

module.exports = { registerPlayerWindowIpc };
