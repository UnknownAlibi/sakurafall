# SakuraFall 项目审查报告

审查日期：2026-08-30
审查范围：`src/`（62,170 行）、构建配置、测试套件、依赖与打包产物

---

## 一、总体判断

这是个**治理意识高于平均水平**的项目：有 277 个测试、lint 全绿、有"只减不增"的棘轮预算机制、扩展包解耦干净、三个窗口的 Electron 安全配置无一例外正确。

它的问题不是"代码写得差"，而是**缺少强制的模块边界**。代码在几个入口文件里自然堆积，没有机制阻止堆积。具体表现：

| 指标 | 实测 | 说明 |
|---|---|---|
| 源码总行数 | 62,170 | src/ 下 js + vue + css |
| 最大文件 | AnimeDetail.vue 3,193 行 | 其中 scoped style 1,610 行 |
| 主进程入口 | main/index.js 2,969 行 | 内含 **195 个 IPC handler** |
| 单个函数最大值 | `createMenu()` 1,258 行 | 命名与内容完全不符 |
| 测试 | 277 个 / 276 通过 | 1 个失败：棘轮预算超标 |
| lint | 通过 | 无 error、无 warning |
| CI | **无** | 没有 GitHub Actions |
| 打包产物 | 495 MB | node_modules 688 MB |

**一句话结论**：地基是好的，债集中在 6 个文件里，而且项目自己已经装了报警器（棘轮测试正在响）。修法是拆，不是重写。

---

## 二、严重问题（P0 — 建议本周处理）

### P0-1 `main/index.js` 已经撑爆自己的预算，测试正在失败

```
tests/performance-budget.test.mjs:44
not ok 166 - giant entry files stay within ratchet budgets (shrink-only)
error: 'src/main/index.js exceeded byte budget; remove legacy code or scoped CSS'
```

当前 118,225 字节，预算 116,945 字节，**超出 1,280 字节**。

这个测试是项目自己设的护栏（shrink-only，只减不增），说明膨胀问题此前已被识别。现在它在报警，而且**未提交的改动还在往这个文件里加东西**。

更麻烦的是结构本身：195 个 IPC handler 全在一个文件里，其中 115 个挤在 `createMenu()`（第 861–2118 行，共 1,258 行）内。这个函数名叫"创建菜单"，实际内容是注册 IPC——**命名与实际职责完全脱节**，是后续维护最大的认知负担。

已经拆出去的只有 `ipc/bt.js` 和 `ipc/danmaku.js` 两个模块，拆分比例约 1%。

### P0-2 8 个 IPC 通道绕过了安全校验

`src/main/ipc/bt.js` 直接使用裸 `ipcMain.handle`：

```
bt.js:39   media-library-add-local
bt.js:68   bt-stream-prepare
bt.js:77   bt-stream-cache-info
bt.js:85   bt-stream-clear-cache
bt.js:93   bt-stream-open
bt.js:102  bt-stream-status
bt.js:110  bt-stream-stop
bt.js:122  bt-search
```

对照 `index.js:2116`，弹幕模块拿到的注入是 `{ handle: secureIpcHandle }`，而 BT 模块在 `index.js:109` 拿到的是原始 `{ ipcMain, ... }`。**这是遗漏，不是有意设计。**

暴露的能力不小：`bt-search` 驱动主进程对外发起网络请求，`bt-stream-prepare`/`bt-stream-open` 会拉起 WebTorrent 下载。

缓解因素：`BtStreamService.js:296-297` 要求 filePath 必须命中种子内的文件，不构成任意文件读取。

### P0-3 SQLite 的 WAL 从不 checkpoint

已验证：

```js
// AnimeDatabase.js:126-130  开启 WAL
this.db.pragma('journal_mode = WAL');

// AnimeDatabase.js:277  全项目唯一的 checkpoint
this.db.pragma('wal_checkpoint(TRUNCATE)');

// AnimeDatabase.js:275  但它所在的 _backupBeforeMigration() 第一行就 return
if (currentVersion >= SCHEMA_VERSION || !this.dbPath || !fs.existsSync(this.dbPath)) return;
```

稳态下（已是 v5）这行**永远不会执行**。而崩溃退出时 `close()`（index.js:1089）不会运行，导致 `anime.db-wal` 只增不减，数据库读取性能随时间劣化。

### P0-4 迁移缺少降级保护

迁移本身是数组 + 串行 for（`:286-385`），`if (migration.version <= currentVersion) continue` 的逻辑是正确的——v1→v5 会依次跑 v2..v5，中间步骤不会漏。

但**没有 `currentVersion > SCHEMA_VERSION` 的分支**。老版本程序打开 v5 数据库时，所有迁移被 skip，然后静默按旧 schema 读写新库，且 `_backupBeforeMigration` 直接 return 不备份。这是真实的数据损坏路径。

---

## 三、中等问题（P1）

### P1-1 N+1 查询阻塞主进程

`SubjectService.js:1120` 的 `_toSubjectSummary()` 每次调用都执行一次同步查询：

```js
db.getCacheAny('bangumi:aired-eps:v2:' + bgmId)
```

它被 `.map()` 批量调用（第 95、114、131、168、179、351、598、916 行）。一页 24 条 = 24 次同步查询；`getCalendar`（第 114 行）单次上百次。better-sqlite3 是同步 API，**每次查询都在阻塞主进程**。

`SubjectIndexService` 没有这个问题（第 90-131 行用单事务 + 预编译复用），可以作为改法参考。

### P1-2 9 个服务绕过统一的 HttpClient — 代理配置在部分路径失效

项目有 `HttpClient` 抽象，15 个服务在用它，但这些服务直接用了全局 `fetch`：

| 文件 | 直接 fetch 次数 |
|---|---|
| CmsApiService.js | 9 |
| danmaku/DanmakuProviderRegistry.js | 6 |
| SourceRuleEngine.js | 5 |
| SubtitleService.js | 3 |
| BangumiApi.js | 2 |
| MediaLibraryService.js | 2 |
| DanmakuApi.js / BtSearchService.js / BtStreamService.js | 各 1 |

这是**功能性缺陷，不只是代码整洁问题**：用户在 `NetworkPolicyService` 里配的代理、超时、重试策略，在这些路径上不生效。CmsApiService（片源）和 BangumiApi（主元数据源）都在列表里，影响面很大。

### P1-3 缺索引 + LIKE 前置通配符

已有索引：`:210-211`、`:257-262`、`:312-314`。

缺失：`bangumi_subjects.platform`（SubjectIndexService.js:263-266 用于过滤）、`air_weekday`（`:328`）、`cms_cache.last_used`（AnimeDatabase.js:502 用于排序）。

另外 keyword 搜索用 `LIKE '%kw%'`，前置通配符**必然全表扫描**，且每次分页跑两遍（countSql `:294` + dataSql `:299`）。

### P1-4 播放进度有 2 秒丢失窗口

`AnimeDatabase.js:26-27`、`:919-958`：`updateFavoriteAndHistory`（唯一入口 index.js:2476）把播放进度缓冲最多 2 秒或 50 条。非正常退出时静默丢失。

且 `:89-98` 每个 op 单独 try/catch 后继续，单条失败造成静默的部分提交。

### P1-5 `secureIpcHandle` 只校验来源，不校验入参

`index.js:235-244` 的白名单机制本身是对的——`isTrustedRendererUrl`（`:208-219`）要求 `senderFrame.url` 必须是 `rendererRoot` 下的 `file://`。但放行后不再校验参数，因此渲染器一旦被攻破：

- `index.js:2411` `update-install(filePath)` → `UpdateChecker.js:255-262` 仅校验"文件存在且是 .exe 后缀"就 `spawn()` 执行
- `index.js:2605-2609` `download-open-dir` 把渲染器传入的任意路径交给 `shell.openPath`

### P1-6 打包体积浪费

`electron-builder.config.js` 的 `asarUnpack: ['node_modules/better-sqlite3/**/*']` 把**所有平台**的预编译产物都解包了。实测 dist-app 里包含：

```
10 MB  app.asar.unpacked/.../better-sqlite3/deps/sqlite3/sqlite3.c   ← C 源码
 8 MB  app.asar.unpacked/.../node-datachannel/.../node_datachannel.node  ← webtorrent 依赖
 3 MB  app.asar.unpacked/.../better-sqlite3/prebuilds/linux-x64.node     ← 用不上
 3 MB  app.asar.unpacked/.../better-sqlite3/prebuilds/linuxmusl-x64.node ← 用不上
```

项目只面向 Windows，却带着 Linux 的预编译产物和 C 源码。

### P1-7 渲染器：巨型组件与大数组深层响应式

- **VideoPlayer.vue** 的 2,609 行 script 耦合了 6 个域：弹幕（149 处引用）、字幕（137）、一起看（52）、投屏（48）、Anime4K（28）。方法集中在 `:2458-2870`。
- **AnimeDetail.vue** 的 scoped style 有 1,610 行，比它的 template（499）和 script（1,080）都大。
- **大数组深层响应式**：Vuex 的 `animeList`（store/modules/anime.js:4, 71, 87）是深层代理。全项目 `shallowRef` 零使用，`markRaw` 只用过 1 次（TabNavigation.vue:114）。`UPDATE_ANIME_LIST_BATCH`（:116-119）逐项 splice 会触发全部可见卡片 diff。

---

## 四、轻微问题（P2）

| 问题 | 位置 | 建议 |
|---|---|---|
| 目录缓存只有条数上限（500 条），无字节上限 | AnimeDatabase.js:22, 493-506 | 加 `SUM(LENGTH(content))` 字节上限，参照 ImageCacheService 的 2000 条/300MB 双上限 |
| 图片缓存无 TTL，`getAllCachedUrls` 逐条 `existsSync`（2000 次同步 stat） | ImageCacheService.js:151-165, 529-536 | 加 TTL；existsSync 换成一次 readdir |
| 无 `busy_timeout` pragma | 全项目 | 设 `busy_timeout = 5000`，避免 WAL 下并发写直接 SQLITE_BUSY |
| 明文凭证落 JSON | MediaLibraryService.js:81-83 | password/bearerToken/apiKey 仅做 500 字符截断后明文写盘，仅导出时替换。改用 Electron `safeStorage` |
| 无 CI | 仓库 | 加 GitHub Actions，至少跑 `npm run lint` + `npm test` |
| CSP 的 connect-src / img-src / media-src 放行任意 http/https | index.html:6 | script-src 'self' 配得好，其余可收紧 |
| `trackTimer` 覆盖不全 | VideoPlayer.vue:550 | `progressSaveTimer`(:2305)、`wtHostBroadcastTimer`(:2768) 未纳入统一清理 |

---

## 五、做得对的地方（别改坏了）

这些是实打实的优点，重构时要保住：

- **棘轮预算机制**（shrink-only）—— 有自我约束力，而且真的会报警
- **Electron 安全配置无一例外正确**：三个窗口全部 `nodeIntegration:false` + `contextIsolation:true` + `webSecurity:true`（index.js:673-676、:792-797、WebPageMediaSniffer.js:84-87），webSecurity 从未关闭
- **不可信内容隔离做得对**：`WebPageMediaSniffer.js:174` 要 loadURL 远程不可信页，但用了独立 partition + `sandbox:true` + 无 preload + 权限全拒（:73-76）
- **URL 协议白名单**：`isExternalWebUrl`（index.js:221-228）只放行 http/https/magnet，拒绝 `file://`；所有 `shell.openExternal` 调用点都先过白名单
- **内存泄漏基本没有**：VideoPlayer.vue:2950-3002 清理完整，AnimeZone.vue:1670-1729 清理了全部定时器与滚动/缩放监听
- **虚拟滚动正常工作**：阈值 48、行窗口 3 行 guard + 1 屏缓冲，无一次渲染上千节点
- **迁移数组串行执行正确**，v1→v5 中间步骤不会漏
- **仓库卫生好**：没有误提交 db / tmp / dist / dist-app
- **扩展包机制**（sourcepack / themepack）解耦干净，核心不依赖具体站点

---

## 六、优化路线图

### 阶段一：止血（约 1 周）

目标是让 CI 变绿、堵上已知漏洞。改动小、风险低。

1. **修复棘轮测试** — `main/index.js` 需减掉 1,280 字节。不要调预算（那就失去了护栏的意义），从 `createMenu()` 里挑一个内聚的域（建议先挑 download 或 settings 相关的 handler）拆成 `src/main/ipc/xxx.js`，参照 danmaku.js 的注入方式。
2. **补上 BT 的 IPC 校验** — `index.js:109` 的注入改成传 `{ handle: secureIpcHandle, ... }`，`bt.js` 内 8 处 `ipcMain.handle` 改用它。
3. **启用 WAL 定期 checkpoint** — 在 `AnimeDatabase` 加一个定时（建议每 5 分钟）或写队列 flush 后执行的 `wal_checkpoint(PASSIVE)`。同时在 `app.before-quit` 里补一次 TRUNCATE。
4. **加降级保护** — `_runMigrations()` 开头检测 `currentVersion > SCHEMA_VERSION` 时拒绝启动并提示用户升级，不要静默继续。
5. **给 `update-install` 加入参白名单** — 校验 filePath 位于下载的更新目录内，不能只看 .exe 后缀。

### 阶段二：拆主进程（约 2 周）

195 个 handler 按域拆分，目标每个模块 100–300 行：

```
src/main/ipc/
  catalog.js     目录、搜索、时间表
  playback.js    播放解析、线路
  sources.js     CMS / XPath / 源管理
  library.js     收藏、历史、继续观看
  settings.js    设置、主题、网络策略
  download.js    下载任务
  window.js      窗口控制
  update.js      更新
  bt.js          （已存在，需补校验）
  danmaku.js     （已存在）
```

配套动作：
- 统一注册入口，删掉 `createMenu()` 这个误导性命名
- **顺手统一网络层**：把 9 个绕过 HttpClient 的服务收编进来，优先处理 CmsApiService（9 处）和 BangumiApi（2 处）。这一条能直接修好"配了代理但某些源不走代理"的实际问题。
- 建立 IPC 通道名常量表，避免字符串散落

### 阶段三：拆渲染器（约 3 周）

- **VideoPlayer.vue 按 6 个域拆成 composable**：
  ```
  src/renderer/composables/player/
    useDanmaku.js      弹幕
    useSubtitle.js     字幕
    useCast.js         投屏
    useWatchTogether.js 一起看
    useAnime4K.js      画质增强
    usePlaybackCore.js 播放内核
  ```
  目标：VideoPlayer.vue 降到 600 行以内，只做编排。

- **AnimeDetail.vue 的 1,610 行 scoped style 外迁**到独立 CSS 文件（Settings.vue 已经这么做了：`style src="../styles/settings-theme-cards.css"`，照抄这个模式）。

- **大数组改浅响应**：`animeList` 和剧集列表用 `shallowRef` / `markRaw`，列表数据本身不需要深层响应式。

- **Settings.vue 的性质不同于 VideoPlayer** —— 它 3,025 行里 script 只有 917 行，主体是 915 行 template + 1,191 行 style。它的正确改法是拆成多个设置分区子组件，不是拆 script 逻辑。

### 阶段四：数据层与打包（约 2 周）

1. **消灭 N+1** — `_toSubjectSummary()` 的 aired-eps 查询改成批量预取：`SELECT ... WHERE cache_key IN (...)` 一次取回后传入。参照 `SubjectIndexService` 第 90-131 行的写法。
2. **补索引** — `bangumi_subjects(platform)`、`bangumi_subjects(air_weekday)`、`cms_cache(last_used)`。
3. **keyword 搜索** — 上 FTS5 虚拟表，或至少缓存 count 结果避免每次分页跑两遍全表扫。
4. **事务覆盖** — `:726-765` 的 upsert 与 `:829` 的别名清理包进同一个 `db.transaction()`；`:839-850`、`:867-874` 的循环单条 DELETE 改成 `DELETE ... WHERE id IN (...)`。
5. **播放进度** — flush 间隔从 2 秒降到 200ms，或在 `before-quit` / `window-all-closed` 强制 flush。
6. **打包瘦身** — `asarUnpack` 收窄到 `node_modules/better-sqlite3/build/Release/*.node` + prebuilds 的 win 目录，去掉 C 源码和 Linux 产物。预期 dist-app 能减 20 MB 以上。
7. **补 CI** — GitHub Actions 跑 lint + test，防止棘轮测试再次悄悄失败。

---

## 七、优先级建议

如果你只打算做三件事，做这三个：

1. **补 BT 的 IPC 校验**（P0-2）—— 半小时工作量，堵掉真实的安全缺口
2. **启用 WAL checkpoint + 降级保护**（P0-3、P0-4）—— 防止用户数据随时间劣化或损坏，这是面向用户的可靠性问题
3. **统一网络层**（P1-2）—— 直接修好"配了代理不生效"的功能缺陷，用户可感知

拆分工作（P0-1、阶段二、三）收益很大但耗时长，建议按域渐进推进，每拆一个域跑一次测试，不要一次性大改。
