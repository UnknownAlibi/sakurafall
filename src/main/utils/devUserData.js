const fs = require('fs');
const path = require('path');

// 首次切换时迁移的核心文件（缓存类目录不迁移，重新生成即可）
const CORE_FILES = [
    'anime.db',
    'anime.db-wal',
    'anime.db-shm',
    'settings-secrets.json',
    'source-health.json',
    'plugin-sources.json',
    'window-state.json',
    'downloads.json'
];

/**
 * 开发模式改用独立数据目录。
 *
 * 打包版与 `npm run dev` 都取 package.json 的 name，userData 同为
 * `%APPDATA%/sakurafall`：开发时的数据库写入、更新安装会与正式版互相干扰
 * （实测出现过「点更新后旧版被重新拉起」）。这里把 dev 指到 `sakurafall-dev`，
 * 首次切换时复制核心数据，收藏/历史/设置不会丢。
 *
 * 必须在 app ready 之前调用（任何 session/cache 路径初始化都会锁定 userData）。
 * @param {{ app: import('electron').App }} options
 * @returns {string} 实际使用的 userData 目录（未切换时返回空串）
 */
function isolateDevUserData({ app }) {
    const isDev = /electron(?:\.exe)?$/i.test(process.execPath)
        || !app.isPackaged
        || process.env.NODE_ENV === 'development';
    if (!isDev) return '';

    const sharedDir = app.getPath('userData');
    const devDir = path.join(app.getPath('appData'), 'sakurafall-dev');
    if (path.resolve(sharedDir) === path.resolve(devDir)) return '';

    try {
        if (!fs.existsSync(devDir)) {
            fs.mkdirSync(devDir, { recursive: true });
            for (const name of CORE_FILES) {
                const from = path.join(sharedDir, name);
                if (fs.existsSync(from)) fs.copyFileSync(from, path.join(devDir, name));
            }
        }
        app.setPath('userData', devDir);
        return devDir;
    } catch (error) {
        console.warn('[UserData] 开发目录切换失败，继续使用默认目录:', error.message);
        return '';
    }
}

module.exports = { isolateDevUserData, CORE_FILES };
