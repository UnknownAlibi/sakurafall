// 本地视频直开（从 main/index.js 抽离，避免入口文件超体积预算）
//
// 与「本地媒体库」的区别：这里不需要番剧匹配、不需要提前添加目录，
// 选一个文件就直接开播放窗口。播放地址走 mediaLibraryService 的令牌
// （sakurafall-media://asset/<token>），真实路径不暴露给渲染层。
// 弹幕：播放页「弹幕设置 → 导入本地 XML」（B 站格式 <d p="...">）。
const fs = require('fs');
const path = require('path');

const LOCAL_VIDEO_EXTENSIONS = ['mp4', 'mkv', 'webm', 'm4v', 'mov', 'avi', 'ts', 'm2ts'];

/**
 * @param {object} deps
 * @param {Function} deps.handle 安全 IPC 注册函数
 * @param {object} deps.dialog
 * @param {object} deps.BrowserWindow
 * @param {Function} deps.getMainWindow
 * @param {object} deps.mediaLibraryService
 * @param {Function} deps.createPlayerWindow
 */
function registerLocalVideoIpc({ handle, dialog, BrowserWindow, getMainWindow, mediaLibraryService, createPlayerWindow }) {
    async function openLocalVideo(filePath = '') {
        try {
            let target = String(filePath || '').trim();
            if (!target) {
                const win = BrowserWindow.getFocusedWindow()
                    || (typeof getMainWindow === 'function' ? getMainWindow() : null)
                    || BrowserWindow.getAllWindows().find(item => !item.isDestroyed());
                const options = {
                    title: '打开本地视频',
                    properties: ['openFile'],
                    filters: [
                        { name: '视频文件', extensions: LOCAL_VIDEO_EXTENSIONS },
                        { name: '全部文件', extensions: ['*'] }
                    ]
                };
                const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
                if (picked.canceled || !picked.filePaths?.length) return { success: false, canceled: true };
                target = picked.filePaths[0];
            }
            const resolved = path.resolve(target);
            const ext = path.extname(resolved).toLowerCase().replace('.', '');
            if (!fs.existsSync(resolved) || !LOCAL_VIDEO_EXTENSIONS.includes(ext)) {
                return { success: false, error: '不是可播放的视频文件' };
            }
            const url = mediaLibraryService.createMediaUrl('local-single', resolved);
            const title = path.basename(resolved);
            createPlayerWindow({
                title,
                url,
                anime: { name: title, source: 'local', episodes: {}, isLocal: true },
                episode: { title, url, id: resolved },
                episodeId: resolved,
                lineId: 'local-file',
                isLocalDownload: true
            });
            return { success: true };
        } catch (error) {
            console.error('[Player] 打开本地视频失败:', error);
            return { success: false, error: error?.message || String(error) };
        }
    }

    handle('open-local-video', (_event, filePath) => openLocalVideo(filePath || ''));

    return {
        openLocalVideo,
        menuItem: {
            label: '打开本地视频…',
            accelerator: 'CmdOrCtrl+O',
            click: () => { openLocalVideo(); }
        }
    };
}

module.exports = { registerLocalVideoIpc, LOCAL_VIDEO_EXTENSIONS };
