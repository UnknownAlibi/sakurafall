// IPC 入参路径守卫
//
// secureIpcHandle 只保证调用方是可信渲染页，不代表参数可信：
// 渲染进程被攻破或出现意外调用时，任意路径可能被交给 fs/shell/spawn。
// 这里集中放“无副作用”的纯路径判断，便于单测覆盖。

const path = require('path');

const IMAGE_EXTENSIONS = new Set([
    '.jpg', '.jpeg', '.jfif', '.png', '.webp', '.gif', '.bmp', '.avif'
]);

/**
 * target 是否位于 root 内（或等于 root）。
 * 使用 path.relative 避免字符串前缀误判（例如 C:\downloads2 以 C:\downloads 开头）。
 */
function isPathInside(root, target) {
    const rootPath = String(root || '').trim();
    const targetPath = String(target || '').trim();
    if (!rootPath || !targetPath) return false;
    const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * 用户配置的 mpv 可执行文件：必须是绝对 .exe，且文件名以 mpv 开头。
 * 允许 mpv.exe / mpvnet.exe / mpv-x86_64.exe 等常见变体；
 * 拒绝 cmd.exe、powershell.exe 这类被当作 mpvPath 传入的任意可执行文件。
 */
function isMpvExecutablePath(filePath) {
    const value = String(filePath || '').trim();
    if (!value || !path.isAbsolute(value) || !/\.exe$/i.test(value)) return false;
    return /^mpv(?:net)?(?:[-_.].*)?\.exe$/i.test(path.basename(value));
}

/** 以图搜番只接受常见位图，避免把任意文件读入主进程再上传。 */
function isSupportedImagePath(filePath) {
    const ext = path.extname(String(filePath || '').trim()).toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
}

module.exports = {
    isPathInside,
    isMpvExecutablePath,
    isSupportedImagePath
};
