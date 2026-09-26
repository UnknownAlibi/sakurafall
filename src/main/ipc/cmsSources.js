// 通用 CMS 片源 IPC（从 main/index.js 抽离）
//   - 源列表/切换/分类/列表/详情/搜索（含全源搜索与最佳剧集源选择）
//   - 规则编辑器：增删改 / 导入导出 / 文件读写
//   - 连通性测试与接口缓存清理
// 依赖注入：BrowserWindow/dialog/fs 只用于文件导入导出，均从调用窗口弹窗。

const fs = require('fs');
const { BrowserWindow, dialog, shell } = require('electron');

function registerCmsIpc({ handle, cmsApiService, sourceProviderRegistry }) {
    handle('cms-get-sources', async () => {
        return cmsApiService.getSourceList();
    });

    handle('cms-reload-sources', async () => {
        return cmsApiService.reloadSources();
    });

    handle('cms-get-config-info', async () => {
        return cmsApiService.getSourcesConfigInfo();
    });

    handle('cms-open-config-file', async () => {
        try {
            const userPath = cmsApiService.ensureUserConfigFile();
            const result = await shell.openPath(userPath);
            return { success: !result, error: result || null };
        } catch (error) {
            console.error('[CmsApi] 打开源配置文件失败:', error);
            return { success: false, error: error.message };
        }
    });

    handle('cms-set-source', async (event, sourceId) => {
        return cmsApiService.setSource(sourceId);
    });

    handle('cms-get-categories', async () => {
        try {
            return await cmsApiService.getCategories();
        } catch (error) {
            console.error('[CmsApi] 获取分类失败:', error);
            return [];
        }
    });

    handle('cms-get-list', async (event, categoryId, page = 1, options = {}) => {
        try {
            return await cmsApiService.getList(categoryId, page, options);
        } catch (error) {
            console.error('[CmsApi] 获取列表失败:', error);
            return { data: [], total: 0, page, totalPages: 0, error: error.message };
        }
    });

    handle('cms-get-detail', async (event, id, options = {}) => {
        try {
            return await cmsApiService.getDetail(id, options);
        } catch (error) {
            console.error('[CmsApi] 获取详情失败:', error);
            return { error: error.message };
        }
    });

    handle('cms-search', async (event, keyword, page = 1) => {
        try {
            return await cmsApiService.search(keyword, page);
        } catch (error) {
            console.error('[CmsApi] 搜索失败:', error);
            return { data: [], total: 0, page, totalPages: 0, keyword, error: error.message };
        }
    });

    handle('cms-search-in-source', async (event, sourceId, keyword, page = 1) => {
        try {
            return await cmsApiService.searchInSource(sourceId, keyword, page);
        } catch (error) {
            console.error('[CmsApi] 在指定源搜索失败:', error);
            return { data: [], total: 0, page, totalPages: 0, sourceId, keyword, error: error.message };
        }
    });

    // 在所有源中搜索同名番（用于播放器/追番回退查找）
    handle('cms-search-all-sources', async (event, keyword) => {
        try {
            return await cmsApiService.searchAllSources(keyword);
        } catch (error) {
            console.error('[CmsApi] 全源搜索失败:', error);
            return [];
        }
    });

    // 全源搜索并返回 per-source 状态（Phase 3：SourceSearchStatus[]）
    handle('cms-search-all-sources-with-status', async (event, keyword, options = {}) => {
        try {
            return await cmsApiService.searchAllSourcesWithStatus(keyword, options || {});
        } catch (error) {
            console.error('[CmsApi] 全源搜索(带状态)失败:', error);
            return [];
        }
    });

    // 全源搜索并按集数匹配 + 清晰度探测选择最佳播放源
    handle('cms-select-best-episode-source', async (event, keyword, target = {}) => {
        try {
            return await sourceProviderRegistry.selectBestEpisodeSource(keyword, target);
        } catch (error) {
            console.error('[CmsApi] 选择最佳播放源失败:', error);
            return { best: null, candidates: [], skipped: [], error: error.message };
        }
    });

    handle('cms-test', async () => {
        return await cmsApiService.test();
    });

    handle('cms-test-all', async () => {
        return await cmsApiService.testAll();
    });

    // 数据源规则编辑器：增删改 / 导入 / 导出
    handle('cms-add-source', async (event, sourceConfig) => {
        try {
            return cmsApiService.addSource(sourceConfig);
        } catch (error) {
            console.error('[CmsApi] 添加数据源失败:', error);
            return { success: false, error: error.message };
        }
    });

    handle('cms-update-source', async (event, sourceId, config) => {
        try {
            return cmsApiService.updateSource(sourceId, config);
        } catch (error) {
            console.error('[CmsApi] 更新数据源失败:', error);
            return { success: false, error: error.message };
        }
    });

    handle('cms-remove-source', async (event, sourceId) => {
        try {
            return cmsApiService.removeSource(sourceId);
        } catch (error) {
            console.error('[CmsApi] 删除数据源失败:', error);
            return { success: false, error: error.message };
        }
    });

    handle('cms-export-sources', async () => {
        try {
            return cmsApiService.exportSources();
        } catch (error) {
            console.error('[CmsApi] 导出数据源失败:', error);
            return { success: false, error: error.message, json: '', count: 0 };
        }
    });

    handle('cms-import-sources', async (event, jsonString, options) => {
        try {
            return cmsApiService.importSources(jsonString, options || {});
        } catch (error) {
            console.error('[CmsApi] 导入数据源失败:', error);
            return { success: false, error: error.message, added: 0, overwritten: 0, skipped: 0, errors: [] };
        }
    });

    // 保存导出的数据源 JSON 文件到磁盘
    handle('cms-save-sources-file', async (event, defaultName) => {
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
    handle('cms-load-sources-file', async (event) => {
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
    handle('cms-cache-clear', async (event, options = {}) => {
        try {
            const removed = cmsApiService.clearCache(options);
            console.log(`[Cache] 清理缓存 ${removed} 条`, options);
            return { success: true, removed };
        } catch (error) {
            console.error('[Cache] 清理缓存失败:', error);
            return { success: false, error: error.message };
        }
    });
}

module.exports = { registerCmsIpc };