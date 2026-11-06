# 片源包示例

安装包**不自带任何片源**（真实站点端点不随仓库/安装包分发），需要自己导入。
这个目录里的文件可以直接拿去改，也可以作为格式参考。

| 文件 | 内容 |
|---|---|
| `example-cms.sourcepack.json` | 采集站（`api.php/provide/vod/`） |
| `example-xpath.sourcepack.json` | 网页 XPath 规则源 |
| `example-media-library.sourcepack.json` | 本地目录 / Jellyfin / Emby |

## 怎么用

1. 复制一个示例文件，改 `metadata.id`（全局唯一，建议 `作者.名称`）、`metadata.name` 和内容
2. 打开应用 → 设置 → 片源管理 → **安装片源包** → 选中改好的 json
3. 导入后立即生效；同 `metadata.id` 的包会覆盖旧包

示例里的地址都是 `example.com`，不改是跑不起来的。

## 文件结构

```jsonc
{
  "kind": "sakurafall.source-pack",   // 固定
  "apiVersion": 1,                    // 固定，目前只有 1
  "metadata": {
    "id": "author.sources",           // 必填，^[a-z0-9][a-z0-9._-]{1,63}$
    "name": "显示名称",
    "version": "1.0.0",
    "author": "",
    "description": "",
    "homepage": "",
    "updateUrl": "",                  // 填了才能在应用内检查这个包的更新
    "license": "",
    "minAppVersion": "1.0.0",
    "tags": []
  },
  "content": {
    "cmsSources": [],                 // 采集站 API，见 example-cms.sourcepack.json
    "xpathRules": [],                 // 网页规则源，见 example-xpath.sourcepack.json
    "resolvers": [],                  // 分享页 /share/xxx 的解析规则
    "mediaLibraries": []              // 本地目录、Jellyfin、Emby 等
  }
}
```

## 约束

| 项 | 限制 |
|---|---|
| 包体大小 | ≤ 512 KB |
| 每类配置 | ≤ 100 条，且四类合计至少 1 条 |
| 未知字段 | 导入时被丢弃（不会报错，也不会生效） |
| 每类字段名 | 只有 `cmsSources` / `xpathRules` / `resolvers` / `mediaLibraries` 四个 |

更完整的字段说明（含媒体库、解析器）见仓库里的 `extensions/sourcepack.template.json`。

## 四类分别是什么

| 字段 | 运行时形态 | 说明 |
|---|---|---|
| `cmsSources` | 采集站 provider | 标准 `api.php/provide/vod/` 接口，按分类翻页 |
| `xpathRules` | 网页 provider | 用 XPath 从搜索结果页/详情页取链接，播放走 webview 嗅探 |
| `resolvers` | 不产生 provider | 只在解析分享页链接时按 hosts 匹配 |
| `mediaLibraries` | 媒体库 provider | 本地目录或 Jellyfin/Emby，需要账号信息（落盘前会加密） |
