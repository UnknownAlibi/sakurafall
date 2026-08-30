# 弹幕数据源

SakuraFall 的弹幕渲染与弹幕数据已经解耦。播放器只消费统一结构：

```json
{ "time": 12.5, "color": 16777215, "text": "内容", "type": "scroll", "source": "bilibili" }
```

## 内置来源

| 来源 | 配置 | 匹配方式 |
| --- | --- | --- |
| 哔哩哔哩 | 无 | 搜索番剧、定位分集、解析 `cid`、读取 XML 弹幕 |
| AcFun | 无 | 搜索合集、读取合集分集、定位 `videoId`、分页读取弹幕 |
| 弹弹play | AppID/AppSecret | 使用开放弹幕网络的聚合结果 |
| 本地 XML | 播放时导入 | 与已经加载的在线弹幕合并 |
| 自定义接口 | URL，可选 Bearer Token | GET 占位符或 POST JSON |

多个来源并行解析。某个来源失败、未配置或无结果时，不会中断其它来源。汇总层会按文本、类型和时间窗口去重，并缓存六小时。播放器的弹幕菜单会显示每个来源的状态和数量。

## 自定义接口

设置中填写的 URL 包含 `{name}`、`{episode}` 或 `{bgmId}` 时，应用使用 GET 请求并替换占位符：

```text
https://example.com/danmaku?name={name}&episode={episode}
```

不含占位符时，应用使用 POST JSON，正文包含番剧名称、别名、Bangumi ID 和集数。接口可以返回：

```json
{
  "comments": [
    { "time": 1.2, "color": 16777215, "text": "开场", "type": "scroll" }
  ],
  "match": { "title": "匹配到的标题" }
}
```

也可以直接返回评论数组、弹弹play 的 `{ p, m }` 数组，或 Bilibili XML。

## 适配器契约

主进程适配器位于 `src/main/services/danmaku/`。新适配器至少实现：

```js
{
  id: 'provider-id',
  name: '显示名称',
  async resolve(context) {
    return { comments: [], match: null, candidates: [] };
  }
}
```

通过 `DanmakuProviderRegistry.register(provider)` 注册后，就会复用统一的容错、状态汇总、去重和缓存逻辑。适配器不得把 Cookie、请求对象、Error 或其它不可结构化克隆的对象返回给渲染进程。

## 手动校正

播放器弹幕菜单中的“手动校正匹配”会列出 B 站和 AcFun 的候选番剧。选中的结果按番剧 ID 持久化，同一番剧后续分集继续使用该匹配；“重新匹配当前集”会跳过合并缓存重新请求。
