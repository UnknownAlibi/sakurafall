const CUSTOM_STYLE_ID = 'sakurafall-user-theme-css';
const MAX_CUSTOM_CSS_LENGTH = 128 * 1024;
const NATIVE_CURSOR_SIZE = 40;
let appliedVariables = [];
let cursorNormalizationToken = 0;
// 深色模式下仍允许主题包穿透的品牌色变量前缀；
// 其余底色系（bg/text/border/brand/scrollbar/titlebar/nav/shadow 等）
// 必须尊重 light/dark 模式——主题包只管品牌配色与装饰，深浅底色由主题模式决定。
const DARK_SAFE_VARIABLE_PREFIXES = ['--primary-', '--accent-', '--tag-'];
const DARK_SAFE_VARIABLE_NAMES = new Set([
  '--player-progress',
  '--player-progress-buffer',
  '--hover-color',
  '--nav-active-bg'
]);
const LAYOUT_ATTRIBUTES = ['density', 'card-style', 'navigation', 'motion'];
const ASSET_VARIABLES = {
  brandMark: ['--sakurafall-mark-image', '--sakura-charm-image'],
  mascot: ['--sakurafall-character-image'],
  loadingMascot: ['--sakura-mascot-image', '--sakura-mascot-static-image'],
  loadingAnimation: ['--sakura-loading-sprite-image'],
  cursorDefault: ['--sakura-cursor-default-image'],
  cursorPointer: ['--sakura-cursor-pointer-image'],
  emptyState: ['--sakurafall-empty-state-image'],
  background: ['--app-ambient-bg']
};
const NATIVE_CURSOR_VARIABLES = {
  cursorDefault: '--sakura-cursor-native-default-image',
  cursorPointer: '--sakura-cursor-native-pointer-image'
};

function normalizeNativeCursor(root, slot, asset, token) {
  const variable = NATIVE_CURSOR_VARIABLES[slot];
  if (!variable || typeof Image === 'undefined') return;

  const image = new Image();
  image.onload = () => {
    if (token !== cursorNormalizationToken) return;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = NATIVE_CURSOR_SIZE;
      canvas.height = NATIVE_CURSOR_SIZE;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.clearRect(0, 0, NATIVE_CURSOR_SIZE, NATIVE_CURSOR_SIZE);
      context.drawImage(image, 0, 0, NATIVE_CURSOR_SIZE, NATIVE_CURSOR_SIZE);
      root.style.setProperty(variable, `url("${canvas.toDataURL('image/png')}")`);
      if (!appliedVariables.includes(variable)) appliedVariables.push(variable);
    } catch (_) {
      // Keep the native OS cursor when a custom asset cannot be normalized.
    }
  };
  image.src = asset;
}

export function sanitizeCustomCss(value) {
  return String(value || '')
    .slice(0, MAX_CUSTOM_CSS_LENGTH)
    .replace(/@import[\s\S]*?;/gi, '')
    .replace(/@font-face\s*\{[\s\S]*?\}/gi, '')
    .replace(/url\s*\([^)]*\)/gi, 'none')
    .replace(/expression\s*\([^)]*\)/gi, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/-webkit-app-region\s*:[^;}]+;?/gi, '');
}

export function applyThemeCustomization(pack, userCss = '') {
  const root = document.documentElement;
  const normalizationToken = ++cursorNormalizationToken;
  for (const key of appliedVariables) root.style.removeProperty(key);
  appliedVariables = [];

  const variables = pack?.content?.variables || {};
  const cssDeclarations = [];
  const darkSafeDeclarations = [];
  for (const [key, value] of Object.entries(variables)) {
    if (!/^--[a-z0-9-]{2,64}$/i.test(key)) continue;
    const safeValue = String(value).slice(0, 200);
    if (/url\s*\(|javascript\s*:|expression\s*\(/i.test(safeValue)) continue;
    cssDeclarations.push(`${key}:${safeValue};`);
    // 深色模式下仅品牌色类可穿透覆盖，避免主题包底色击穿深色模式
    if (DARK_SAFE_VARIABLE_PREFIXES.some(prefix => key.startsWith(prefix))
      || DARK_SAFE_VARIABLE_NAMES.has(key)) {
      darkSafeDeclarations.push(`${key}:${safeValue};`);
    }
  }

  for (const [slot, asset] of Object.entries(pack?.content?.assets || {})) {
    if (!ASSET_VARIABLES[slot] || !/^data:image\//i.test(asset)) continue;
    for (const variable of ASSET_VARIABLES[slot]) {
      root.style.setProperty(variable, `url("${asset}")`);
      appliedVariables.push(variable);
    }
    normalizeNativeCursor(root, slot, asset, normalizationToken);
  }

  for (const attribute of LAYOUT_ATTRIBUTES) root.removeAttribute(`data-theme-${attribute}`);
  const layout = pack?.content?.layout || {};
  if (layout.density) root.setAttribute('data-theme-density', layout.density);
  if (layout.cardStyle) root.setAttribute('data-theme-card-style', layout.cardStyle);
  if (layout.navigation) root.setAttribute('data-theme-navigation', layout.navigation);
  if (layout.motion) root.setAttribute('data-theme-motion', layout.motion);

  let style = document.getElementById(CUSTOM_STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = CUSTOM_STYLE_ID;
    document.head.appendChild(style);
  }
  // 变量通过 <style> 规则下发而非内联样式：
  // - :root:not([data-theme="dark"])（仅浅色匹配，特异性高于 variables.css 的 :root）
  //   → 浅色模式下主题包全部变量生效
  // - :root[data-theme="dark"] → 深色下仅品牌色穿透，底色系尊重深色模式。
  //   注意不能用裸 :root：它与 [data-theme="dark"] 同特异性且加载靠后，
  //   会把深色底色变量也覆盖掉，导致用户自定义包击穿深色模式。
  const variableCss = [
    cssDeclarations.length ? `:root:not([data-theme="dark"]){${cssDeclarations.join('')}}` : '',
    darkSafeDeclarations.length ? `:root[data-theme="dark"]{${darkSafeDeclarations.join('')}}` : ''
  ].filter(Boolean).join('\n');
  style.textContent = `${variableCss}\n${sanitizeCustomCss(`${pack?.content?.customCss || ''}\n${userCss || ''}`)}`;
  root.setAttribute('data-theme-pack', pack?.metadata?.id || 'sakurafall-default');
  window.dispatchEvent(new CustomEvent('sakurafall-theme-change', {
    detail: { id: pack?.metadata?.id || 'sakurafall-default', assets: pack?.content?.assets || {}, layout }
  }));
}

export function clearThemeCustomization() {
  applyThemeCustomization(null, '');
}
