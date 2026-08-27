# sakurafall扩展包

## Personal media libraries

`content.mediaLibraries` registers high-quality personal media beside CMS and XPath providers.
Supported types are `local`, `webdav`, `jellyfin`, and `emby`. They participate in detail lookup,
same-episode source selection, playback health scoring, and source switching.

```json
{
  "mediaLibraries": [
    {
      "id": "local-anime",
      "name": "Local Anime",
      "type": "local",
      "preference": 15,
      "roots": ["D:/Anime"]
    },
    {
      "id": "jellyfin-home",
      "name": "Home Jellyfin",
      "type": "jellyfin",
      "preference": 15,
      "baseUrl": "http://127.0.0.1:8096",
      "userId": "USER_ID",
      "apiKey": "${ENV:SAKURAFALL_JELLYFIN_API_KEY}"
    }
  ]
}
```

Remote credentials may use `${ENV:VARIABLE_NAME}` references. Literal credentials are accepted in
local packs but redacted during export. Local playback uses `sakurafall-media://` and resolves only
files indexed under configured roots.

片源地址、站点解析规则和界面主题都属于可替换配置，不属于播放器核心代码。应用内置配置与用户安装配置使用同一版本化协议，第三方作者只需编写 JSON，不需要修改或重新编译应用。

## 片源包

扩展名建议使用 `.sourcepack.json`，结构如下：

```json
{
  "kind": "sakurafall.source-pack",
  "apiVersion": 1,
  "metadata": {
    "id": "author.my-sources",
    "name": "我的片源包",
    "version": "1.0.0",
    "author": "Author",
    "description": "可选说明",
    "homepage": "https://example.com/project",
    "updateUrl": "https://example.com/my-sources.sourcepack.json",
    "license": "MIT",
    "minAppVersion": "1.0.0",
    "tags": ["anime", "cms"]
  },
  "content": {
    "cmsSources": [
      {
        "id": "example-cms",
        "name": "示例 CMS",
        "api": "https://example.com/api.php/provide/vod/",
        "categories": [{ "id": "1", "name": "动漫" }],
        "defaultCategory": "1",
        "roles": ["fallback-catalog"],
        "resolverId": "author.share-page"
      }
    ],
    "xpathRules": [],
    "resolvers": [
      {
        "id": "author.share-page",
        "name": "示例分享页解析器",
        "hosts": ["share.example.com"],
        "pathPrefixes": ["/share/"],
        "requestHeaders": { "Referer": "https://example.com/" },
        "playbackHeaders": { "Referer": "https://example.com/" }
      }
    ]
  }
}
```

`cmsSources` 使用苹果 CMS v10 接口。`xpathRules` 与数据源页面中的 XPath 规则编辑器格式一致。`resolvers` 用来声明分享页域名、路径和允许的请求头，由核心中的通用媒体地址提取器执行，不允许扩展包注入脚本。三者至少提供一种。安装同 id 包时，用户版本覆盖随附版本。

`roles` 中的 `fallback-catalog` 表示该 CMS 可在 Bangumi 与本地缓存均不可用时提供备用目录。`resolverId` 把 CMS 返回的分享页绑定到同包 resolver。resolver 仅接受域名、路径前缀以及 `Referer`、`Origin`、`User-Agent` 三类请求头；页面响应上限为 2MB。

开发版随附片源位于 `extensions/bundled/sources/`；打包时复制到 ASAR 外的 `resources/extensions/sources/`。用户安装的原始源包保存在 Electron `userData/source-packs/`。运行时由 `CustomizationPackService` 合并包并注入 CMS、XPath 和 resolver 管理器，核心服务不读取任何具体站点文件。没有安装任何片源包时，应用仍可启动。

详情页通过统一 `SourceProvider` 协议调用所有源。CMS 与 XPath 均提供命名空间 id（如 `cms:example-cms`、`xpath:example-rule`），统一支持搜索、详情、分集、检测和健康状态。具体站点不再拥有主进程专用服务。

## 主题包

扩展名建议使用 `.themepack.json`：

```json
{
  "kind": "sakurafall.theme-pack",
  "apiVersion": 1,
  "metadata": {
    "id": "author.my-theme",
    "name": "我的主题",
    "version": "1.0.0",
    "author": "Author",
    "description": "可选说明"
  },
  "content": {
    "variables": {
      "--primary-color": "#ff6688",
      "--bg-base": "#fff8fb",
      "--text-primary": "#2d2530"
    },
    "assets": {
      "brandMark": "data:image/png;base64,...",
      "mascot": "data:image/webp;base64,...",
      "loadingMascot": "data:image/webp;base64,...",
      "loadingAnimation": "data:image/webp;base64,...",
      "cursorDefault": "data:image/png;base64,...",
      "cursorPointer": "data:image/png;base64,...",
      "emptyState": "data:image/webp;base64,...",
      "background": "data:image/webp;base64,..."
    },
    "layout": {
      "density": "comfortable",
      "cardStyle": "manga",
      "navigation": "rail",
      "motion": "balanced"
    },
    "customCss": ".anime-card { border-width: 2px; }"
  }
}
```

开发版随附主题位于 `extensions/bundled/themes/`，打包后位于 `resources/extensions/themes/`。随附主题可使用受路径约束的 `assetFiles` sidecar 图片；读取后会转换成与用户主题相同的 Data URL。第三方主题仍以单个 `.themepack.json` 安装到 `userData/theme-packs/`。

主题资源只接受内嵌的 PNG/JPEG/WebP/GIF Data URL，不接受远程资源地址。单个资源上限 2MB，主题包上限 8MB，自定义 CSS 上限 128KB。为避免主题包联网跟踪用户或破坏桌面窗口操作，应用会过滤 `@import`、`@font-face`、`url()`、`expression()`、`javascript:` 和 `-webkit-app-region`。

## 兼容约定

- `kind` 与 `apiVersion` 必须存在；当前版本只接受 `apiVersion: 1`。
- `metadata.id` 只允许字母、数字、点、下划线和短横线，长度 2 到 64。
- 作者升级扩展时保持 id 不变并递增 version。
- 核心代码不应再新增具体片源 URL；新增默认源应修改或新增片源包。
- 核心必须在 `extensions/bundled/sources/` 不存在或为空时正常启动。
- 主题优先使用现有 CSS 变量。只有变量无法表达的细节才写 `customCss`。
