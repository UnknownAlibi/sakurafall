# Contributing to SakuraFall

感谢你愿意改进 SakuraFall。请让每个改动保持边界清晰、可验证，并优先沿用现有架构。

## 开发流程

1. 从 `main` 创建功能分支。
2. 使用 Node.js 18 或更高版本安装依赖。
3. 修改代码并添加与风险相匹配的测试。
4. 提交前运行 `npm run lint` 和 `npm run verify`。
5. 涉及安装、数据库迁移、IPC 或播放主流程时，额外运行 `npm run verify:release`。

仓库以 `yarn.lock` 作为依赖锁文件。请不要提交本地数据库、日志、代理配置、API 凭证、构建产物或安装包。

## 架构约束

- Bangumi 元数据与播放源必须保持解耦。
- 新增片源应提交为版本化源包，不应在页面或核心服务中硬编码站点。
- 渲染进程只能通过 preload 暴露的窄 IPC 接口访问主进程能力。
- IPC 数据必须可序列化，不得传递 Electron 对象、函数或循环引用。
- 列表、封面和滚动热路径的改动必须符合 `src/shared/performance-budgets.json`。
- 不得通过删除封面、时间表或核心功能来规避性能问题。

## 扩展贡献

片源包和主题包的格式见 `docs/EXTENSION_PACKS.md`。提交扩展前请确认：

- 不包含账号、Cookie、Token 或其他私密凭证。
- 使用的接口、规则和素材允许公开分发。
- 不包含绕过访问控制、付费限制或安全校验的逻辑。
- 元数据中填写准确的作者、版本、主页和许可证。

## Issue 与 Pull Request

Issue 请包含复现步骤、预期结果、实际结果、系统版本和应用版本。日志应先删除用户名、路径、IP、Cookie、Token 和其他敏感信息。

Pull Request 请说明行为变化、验证命令和已知限制。不要混入无关重构或大规模格式化。

安全漏洞不要提交公开 Issue，请按照 `SECURITY.md` 报告。
