// 从 resources/anime4k 生成 src/renderer/player/anime4kShaders.js
// 用法：node scripts/generate-anime4k-shaders.js
// 重新生成前请勿手写编辑目标文件。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'resources', 'anime4k');
const OUT_FILE = path.join(ROOT, 'src', 'renderer', 'player', 'anime4kShaders.js');

// 仅嵌入 WebGL 播放器管线需要的 shader（mpv 专用 AutoDownscale 不移植）
const WANTED = [
  'Anime4K_Clamp_Highlights.glsl',
  'Anime4K_Restore_CNN_Soft_S.glsl',
  'Anime4K_Restore_CNN_Soft_M.glsl',
  'Anime4K_Restore_CNN_Soft_L.glsl',
  'Anime4K_Upscale_CNN_x2_S.glsl',
  'Anime4K_Upscale_CNN_x2_M.glsl',
  'Anime4K_Upscale_CNN_x2_L.glsl'
];

const banner = `// 本文件由 scripts/generate-anime4k-shaders.js 自动生成，请勿手写编辑。
// 内容来自 Anime4K 官方 Release（resources/anime4k，MIT License, bloc97）。
// 通过动态 import 懒加载，避免拖慢首屏。

`;

const parts = [banner];
parts.push('export const ANIME4K_SHADERS = {\n');
for (const name of WANTED) {
  const text = fs.readFileSync(path.join(SRC_DIR, name), 'utf8');
  if (text.includes('`') || text.includes('${')) {
    throw new Error(`${name} 含有反引号或模板插值，需改用其他嵌入方式`);
  }
  parts.push(`  ${JSON.stringify(name)}: ${JSON.stringify(text)},\n`);
}
parts.push('};\n\n');
parts.push('export const ANIME4K_PRESETS = {\n  light: [\'Anime4K_Restore_CNN_Soft_S.glsl\', \'Anime4K_Upscale_CNN_x2_S.glsl\'],\n  balanced: [\'Anime4K_Restore_CNN_Soft_M.glsl\', \'Anime4K_Upscale_CNN_x2_M.glsl\'],\n  quality: [\'Anime4K_Clamp_Highlights.glsl\', \'Anime4K_Restore_CNN_Soft_L.glsl\', \'Anime4K_Upscale_CNN_x2_L.glsl\']\n};\n');

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, parts.join(''));
console.log('generated:', OUT_FILE, (fs.statSync(OUT_FILE).size / 1024).toFixed(1) + 'KB');
