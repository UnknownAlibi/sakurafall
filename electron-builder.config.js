module.exports = {
  appId: 'com.sakurafall.app',
  productName: 'SakuraFall',
  copyright: 'Copyright © 2026 SakuraFall',
  directories: {
    // SAKURAFALL_BUILD_OUTPUT 用于把产物指到其他目录（如 dist-app-v2），
    // 避免主输出目录被 IDE 索引器等占用时 EBUSY 无法重建。
    output: process.env.SAKURAFALL_BUILD_OUTPUT || 'dist-app',
    buildResources: 'build'
  },
  asar: true,
  // 原生模块必须解包（进程 dlopen 无法从 asar 内加载）。
  // better-sqlite3 v13 的加载顺序（lib/binding.js）：build/Release/*.node → prebuilds/<平台>.node，
  // 当前构建走 prebuilds/win32-x64.node；两条路径都保留，避免换环境重编译后加载失败。
  asarUnpack: [
    'node_modules/better-sqlite3/prebuilds/win32-x64.node',
    'node_modules/better-sqlite3/build/Release/*.node'
  ],
  files: [
    'dist/renderer/**/*',
    'src/main/**/*',
    'public/**/*',
    'package.json',
    // better-sqlite3 只保留运行时需要的 Windows x64 预编译产物：
    // deps/ 是 SQLite 的 C 源码（9.8MB）、src/ 是 C++ 源码，运行时用不到；
    // darwin/linux/win32-arm64 的预编译二进制也不进包（项目只发布 Windows）。
    // 实测这部分此前占了 22MB 打包体积。
    '!node_modules/better-sqlite3/deps/**',
    '!node_modules/better-sqlite3/src/**',
    '!node_modules/better-sqlite3/prebuilds/darwin-*',
    '!node_modules/better-sqlite3/prebuilds/linux*',
    '!node_modules/better-sqlite3/prebuilds/win32-arm64.node'
  ],
  extraResources: [
    {
      from: 'public/favicon-v4.ico',
      to: 'favicon.ico'
    },
    {
      from: 'build/icon-v4.ico',
      to: 'icon.ico'
    },
    {
      from: 'extensions/bundled',
      to: 'extensions'
    },
    {
      from: 'resources/anime4k',
      to: 'anime4k'
    }
  ],
  // 禁用自动发布到 GitHub（仅本地打包）
  publish: null,
  win: {
    target: ['nsis'],
    icon: 'build/icon-v4.ico'
  },
  mac: {
    target: 'dmg',
    icon: 'build/icon-v4.png'
  },
  linux: {
    target: 'AppImage',
    icon: 'build/icon-v4.png'
  },
  nsis: {
    artifactName: '${productName}-Setup-${version}.${ext}',
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'SakuraFall',
    installerIcon: 'build/icon-v4.ico',
    uninstallerIcon: 'build/icon-v4.ico',
    installerHeaderIcon: 'build/icon-v4.ico'
  }
};
