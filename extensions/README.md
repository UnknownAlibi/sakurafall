# SakuraFall Extension SDK

这个目录保存扩展协议模板和随发行版提供的默认扩展，扩展内容不参与播放器核心业务逻辑。

- `sourcepack.template.json`：CMS、XPath 与分享页 resolver 片源包模板。
- `themepack.template.json`：颜色、布局、Logo、看板娘、加载动画和光标主题模板。
- `bundled/sources/`：开发版随附片源包；打包后复制到 `resources/extensions/sources/`。
- `bundled/themes/`：开发版随附主题及 sidecar 图片；打包后复制到 `resources/extensions/themes/`。

用户安装的包保存在 Electron `userData/source-packs/` 或 `userData/theme-packs/`。移除整个 `bundled/sources` 目录后，核心应用仍能启动、浏览已有 Bangumi 缓存并进入片源管理页。

扩展作者应保持 `metadata.id` 稳定并递增 `metadata.version`。完整字段和安全限制见 [`docs/EXTENSION_PACKS.md`](../docs/EXTENSION_PACKS.md)。
