const path = require('path');

function registerSubtitlesIpc({ handle, playerSvc, dialog, BrowserWindow }) {
    handle('subtitle-parse-file', async (event) => {
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

    handle('subtitle-parse-content', async (event, content, filePath) => {
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

    handle('subtitle-search', async (event, keyword, language = 'zh') => {
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

    handle('subtitle-download', async (event, fileId) => {
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

    handle('subtitle-set-api-key', async (event, apiKey) => {
        try {
            playerSvc.subtitle().setApiKey(apiKey || '');
            return { success: true };
        } catch (error) {
            console.error('[Subtitle] 设置 API Key 失败:', error);
            return { success: false, error: error.message };
        }
    });
}

module.exports = { registerSubtitlesIpc };
