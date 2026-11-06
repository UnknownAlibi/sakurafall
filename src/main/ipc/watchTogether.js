function registerWatchTogetherIpc({ handle, watchTogetherService, BrowserWindow }) {
    watchTogetherService.onMessage((msg) => {
        try {
            for (const win of BrowserWindow.getAllWindows()) {
                if (!win.isDestroyed()) {
                    win.webContents.send('on-wt-message', msg);
                }
            }
        } catch (_) { /* ignore */ }
    });

    handle('wt-create-room', async (event, payload = {}) => {
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

    handle('wt-join-room', async (event, payload = {}) => {
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

    handle('wt-leave-room', async () => {
        try {
            return watchTogetherService.leaveRoom();
        } catch (error) {
            console.error('[WatchTogether] 离开房间失败:', error);
            return { success: false, error: error.message };
        }
    });

    handle('wt-broadcast-state', async (event, state) => {
        try {
            return watchTogetherService.broadcastState(state);
        } catch (error) {
            console.error('[WatchTogether] 广播状态失败:', error);
            return { success: false, error: error.message };
        }
    });

    handle('wt-send-chat', async (event, text) => {
        try {
            return watchTogetherService.sendChat(text);
        } catch (error) {
            console.error('[WatchTogether] 发送消息失败:', error);
            return { success: false, error: error.message };
        }
    });

    handle('wt-send-ping', async (event, ts) => {
        try {
            return watchTogetherService.sendPing(ts);
        } catch (error) {
            console.error('[WatchTogether] 发送 ping 失败:', error);
            return { success: false, error: error.message };
        }
    });

    handle('wt-get-room-info', async () => {
        try {
            return Object.assign({ success: true }, watchTogetherService.getRoomInfo());
        } catch (error) {
            console.error('[WatchTogether] 获取房间信息失败:', error);
            return { success: false, error: error.message };
        }
    });
}

module.exports = { registerWatchTogetherIpc };
