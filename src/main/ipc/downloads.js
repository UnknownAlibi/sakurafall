const path = require('path');
const fs = require('fs');
const { isPathInside } = require('../utils/pathGuards');

function registerDownloadsIpc({
    handle,
    getDownloader,
    attachDownloadPlayUrl = task => task,
    dialog,
    shell,
    BrowserWindow
}) {
    function isManagedDownloadPath(target) {
        const downloader = getDownloader();
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

    handle('download-add', async (event, payload) => {
        const downloader = getDownloader();
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
            return { success: true, task: attachDownloadPlayUrl(task) };
        } catch (error) {
            console.error('[Download] 添加下载任务失败:', error);
            return { error: error.message };
        }
    });

    handle('download-cancel', async (event, id) => {
        const downloader = getDownloader();
        if (!downloader) return { error: '下载器未初始化' };
        const task = downloader.cancel(id);
        return { success: !!task, task: attachDownloadPlayUrl(task) };
    });

    handle('download-pause', async (event, id) => {
        const downloader = getDownloader();
        if (!downloader) return { error: '下载器未初始化' };
        const task = downloader.pause(id);
        return { success: !!task, task };
    });

    handle('download-resume', async (event, id) => {
        const downloader = getDownloader();
        if (!downloader) return { error: '下载器未初始化' };
        const task = downloader.resume(id);
        return { success: !!task, task };
    });

    handle('download-list', async () => {
        const downloader = getDownloader();
        if (!downloader) return { tasks: [], downloadDir: '' };
        return {
            tasks: (downloader.list() || []).map(attachDownloadPlayUrl),
            downloadDir: downloader.downloadDir || ''
        };
    });

    handle('download-remove', async (event, id) => {
        const downloader = getDownloader();
        if (!downloader) return { error: '下载器未初始化' };
        const ok = downloader.remove(id);
        return { success: ok };
    });

    handle('download-select-dir', async (event) => {
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
            const downloader = getDownloader();
            if (downloader) downloader.setDownloadDir(dir);
            return { canceled: false, dir };
        } catch (error) {
            console.error('[Download] 选择下载目录失败:', error);
            return { canceled: true, error: error.message };
        }
    });

    handle('download-open-dir', async (event, dirPath) => {
        try {
            const downloader = getDownloader();
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

    handle('download-open-file', async (event, filePath) => {
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
}

module.exports = { registerDownloadsIpc };
