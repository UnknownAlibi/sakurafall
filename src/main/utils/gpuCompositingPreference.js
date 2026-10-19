// GPU 合成偏好持久化（设置页开关 ↔ 启动期 Chromium 开关）。
//
// disable-gpu-compositing 只能在 app ready 之前决定（见 main/window-fullscreen.js），
// 所以开关值必须落盘成一个小 JSON，下次启动时读取。这里只做文件读写与环境变量判定，
// 不依赖 electron，便于单元测试。
const fs = require('fs');
const path = require('path');

const GPU_COMPOSITING_FILE_NAME = 'gpu-compositing.json';

function resolveGpuCompositingPreferenceFile(userDataDir) {
    return path.join(userDataDir, GPU_COMPOSITING_FILE_NAME);
}

/**
 * 读取偏好。
 * @param {string} filePath
 * @returns {boolean|null} 明确配置过返回 true/false；文件缺失、损坏或取值非法返回 null（调用方使用默认值）
 */
function readGpuCompositingPreference(filePath) {
    if (!filePath) return null;
    try {
        // 外部工具（编辑器/PowerShell Set-Content）可能写成带 BOM 的 UTF-8，
        // JSON.parse 会因此抛错而静默回退到默认值，这里先剥掉 BOM。
        const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
        const data = JSON.parse(raw);
        return typeof data?.enabled === 'boolean' ? data.enabled : null;
    } catch (_error) {
        return null;
    }
}

/**
 * 写入偏好。写坏或目录不存在都不应让设置页崩掉，由调用方 try/catch。
 * @param {string} filePath
 * @param {boolean} enabled
 */
function writeGpuCompositingPreference(filePath, enabled) {
    if (!filePath) throw new Error('GPU 合成偏好路径缺失');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const payload = { enabled: !!enabled, updatedAt: new Date().toISOString() };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return payload;
}

/**
 * 逃生通道：环境变量 / 启动参数强制开启 GPU 合成时，设置页开关不生效。
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} argv
 * @returns {boolean}
 */
function isGpuCompositingForcedByEnv(env = process.env, argv = process.argv) {
    return env?.SAKURAFALL_GPU_COMPOSITING === '1' || (argv || []).includes('--gpu-compositing');
}

module.exports = {
    GPU_COMPOSITING_FILE_NAME,
    resolveGpuCompositingPreferenceFile,
    readGpuCompositingPreference,
    writeGpuCompositingPreference,
    isGpuCompositingForcedByEnv
};
