// 插件式源规则与统一播放源边界 IPC（从 main/index.js 抽离）
//   - plugin-*：XPath 规则源的增删改查、导入导出、搜索/详情解析/连通性测试
//   - source-provider-*：CMS 与规则源统一的 provider 边界（列表/搜索/详情/分类/目录/测试）
// 与 cms-* 通道并存：CMS 源走 cms-*，XPath 规则源走 plugin-*。

const fs = require('fs');
const path = require('path');
const { app, dialog } = require('electron');

function registerSourceProviderIpc({ handle, sourcePluginManager, sourceProviderRegistry }) {
    // 查询
    handle('plugin-get-list', () => sourcePluginManager.getAllForManagement());
    handle('plugin-get-detail', (_e, id) => sourcePluginManager.getRuleDetail(id));

    // 增删改
    handle('plugin-add', (_e, raw) => sourcePluginManager.addRule(raw));
    handle('plugin-update', (_e, id, raw) => sourcePluginManager.updateRule(id, raw));
    handle('plugin-remove', (_e, id) => sourcePluginManager.removeRule(id));
    handle('plugin-set-enabled', (_e, id, enabled) => sourcePluginManager.setEnabled(id, enabled));

    // 导入导出
    handle('plugin-export', () => sourcePluginManager.exportRules());
    handle('plugin-import', (_e, jsonString, options) => sourcePluginManager.importRules(jsonString, options));

    handle('plugin-import-installed-rules', () => {
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
    handle('plugin-save-file', async (_e, defaultName) => {
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

    handle('plugin-load-file', async () => {
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
    handle('plugin-search', (_e, id, keyword, options) => sourcePluginManager.search(id, keyword, options || {}));
    handle('plugin-search-all', (_e, keyword, options) => sourcePluginManager.searchAll(keyword, options || {}));
    handle('plugin-parse-detail', (_e, id, pageUrl, options) => sourcePluginManager.parseDetail(id, pageUrl, options || {}));
    handle('plugin-test', (_e, id) => sourcePluginManager.test(id));
    handle('plugin-test-all', () => sourcePluginManager.testAll());

    // Unified playback-source boundary for CMS and rule-based providers.
    handle('source-provider-list', (_event, options) => sourceProviderRegistry.listProviders(options || {}));
    handle('source-provider-search', (_event, providerId, keyword, options) => (
        sourceProviderRegistry.search(providerId, keyword, options || {})
    ));
    handle('source-provider-search-all', (_event, keyword, options) => (
        sourceProviderRegistry.searchAll(keyword, options || {})
    ));
    handle('source-provider-detail', (_event, providerId, reference, options) => (
        sourceProviderRegistry.getDetail(providerId, reference, options || {})
    ));
    handle('source-provider-categories', (_event, providerId) => (
        sourceProviderRegistry.getCategories(providerId)
    ));
    handle('source-provider-catalog', (_event, providerId, options) => (
        sourceProviderRegistry.getCatalog(providerId, options || {})
    ));
    handle('source-provider-test', (_event, providerId) => sourceProviderRegistry.test(providerId));
}

module.exports = { registerSourceProviderIpc };