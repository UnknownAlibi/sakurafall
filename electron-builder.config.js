module.exports = {
  appId: 'com.sakurafall.app',
  productName: 'SakuraFall',
  copyright: 'Copyright © 2026 SakuraFall',
  directories: {
    output: 'dist-app',
    buildResources: 'build'
  },
  asar: true,
  asarUnpack: [
    'node_modules/better-sqlite3/**/*'
  ],
  files: [
    'dist/renderer/**/*',
    'src/main/**/*',
    'public/**/*',
    'package.json'
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
