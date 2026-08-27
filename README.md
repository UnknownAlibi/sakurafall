<p align="center">
  <img src="public/sakurafall-mark-v4.png" width="112" alt="SakuraFall logo">
</p>

<h1 align="center">SakuraFall</h1>

<p align="center">多源番剧元数据聚合、以可替换扩展包提供播放能力的 Windows 动漫桌面客户端。</p>

<p align="center">
  <img alt="Vue 3" src="https://img.shields.io/badge/Vue-3.3-42b883?logo=vuedotjs&logoColor=white">
  <img alt="Electron 25" src="https://img.shields.io/badge/Electron-25-47848f?logo=electron&logoColor=white">
  <img alt="Vite 4" src="https://img.shields.io/badge/Vite-4-646cff?logo=vite&logoColor=white">
  <img alt="License MIT" src="https://img.shields.io/badge/License-MIT-blue">
</p>

## 项目简介

SakuraFall 是一个基于 Electron、Vue 3 和 Vite 的桌面应用。番剧目录、封面、评分、筛选和条目身份由多源元数据服务驱动（Bangumi 主源，AniList 备源自动回退）；CMS、XPath 和兼容网页规则只负责提供可替换的播放候选，不与主列表业务耦合。

项目重点解决桌面端的列表流畅度、离线可用性、多源匹配、剧集准确性、播放恢复和可定制主题体验。

## 核心能力

- 番剧资料目录：多源元数据聚合（Bangumi 主源 + AniList 自动回退），支持最新、评分、类型、年份、搜索、分页、新番时间表和热门条目。
- 多源播放：统一的 `SourceProviderRegistry` 管理 CMS 与 XPath，分享页由片源包 resolver 解析。
- 桌面播放器：HLS 播放、分集/线路切换、进度记忆、字幕、弹幕、画中画和全屏。
- 播放增强：可选 mpv、Anime4K/GLSL shader、DLNA 投屏和播放诊断。
- 本地数据：SQLite 保存收藏、历史、目录缓存和离线数据，并进行版本化迁移。
- 扩展机制：片源包和主题包均为版本化配置，可独立安装、导出和更新。
- 性能治理：虚拟化列表、缩略图缓存、并发限制、长任务监控和显式性能预算。
- 运行恢复：结构化诊断日志、数据库健康检查和渲染进程崩溃保护。

## 技术结构

```text
Multi-source metadata ──> SubjectService / SubjectIndexService ──> Renderer catalog
                                                                    │
Source packs ──────────> SourceProviderRegistry ──> PlaybackResolver ──┘
                                                                    │
SQLite cache <───────── Main process IPC boundary <──── Vue renderer ──┘
```

详细说明见 [架构文档](docs/ARCHITECTURE.md) 和 [扩展包协议](docs/EXTENSION_PACKS.md)。

## 环境要求

- Windows 10 或 Windows 11
- Node.js 18 或更高版本
- npm 或 Yarn

## 本地开发

```powershell
git clone https://github.com/wky199712/sakurafall.git
cd sakurafall
npm install
npm run dev
```

`npm run dev` 会启动 Vite 开发服务和 Electron 桌面窗口。Vite 默认监听 `http://127.0.0.1:5173/`。

## 构建与验证

```powershell
# 代码检查
npm run lint

# 单元和回归测试
npm test

# 渲染器、性能预算和基础校验
npm run verify

# Windows 安装包、在线/离线冒烟、安装与卸载验收
npm run verify:release
```

安装包生成在 `dist-app/`。当前 RC 安装包尚未进行 Windows 代码签名，不建议直接面向大规模用户分发。验收结果见 [RC 状态](docs/RC_STATUS.md)，发布流程见 [发布清单](docs/RELEASE_CHECKLIST.md)。

## 扩展包

片源地址、站点解析规则、主题资源和看板娘素材属于可替换配置，不属于核心业务代码。随附包位于 `extensions/bundled/`，打包后独立放在 ASAR 外；核心在没有片源包时也能启动。新增源应编写 `.sourcepack.json`，新增主题应编写 `.themepack.json`，不要在 Vue 页面或主进程服务中硬编码具体站点。

示例和字段约束位于 [extensions](extensions/) 与 [扩展包协议](docs/EXTENSION_PACKS.md)。

## 数据与隐私

- 用户收藏、播放历史、凭证和缓存只保存在 Electron `userData` 目录及本地 SQLite 中。
- 本地数据库、日志、代理配置和 API 凭证不得提交到仓库。
- 运行诊断会对常见凭证字段进行脱敏，并限制日志文件数量和大小。
- 仓库不托管视频文件，也不提供任何第三方服务的可用性保证。

## 项目边界与免责声明

SakuraFall 是独立的开源客户端，与 Bangumi 及任何第三方内容服务不存在隶属或授权关系。Bangumi 名称和数据归其各自权利人所有。用户安装或编写扩展包时，应确认数据源、内容和素材在所在地的使用及分发符合法律和服务条款。

项目仅提供通用的数据聚合、扩展管理和媒体播放技术，不鼓励或支持侵犯版权、绕过访问控制或传播未经授权内容。

## 参与贡献

提交问题或代码前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按照 [SECURITY.md](SECURITY.md) 私下报告，不要在公开 Issue 中披露漏洞细节或凭证。

## License

SakuraFall 核心代码采用 [MIT License](LICENSE) 发布。第三方数据、品牌、图片和用户安装的扩展包不因本许可证而获得授权。
