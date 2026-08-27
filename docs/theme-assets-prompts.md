# SakuraFall 樱月视觉资产与主题世界

> 状态：2026-08-25 启用樱月视觉系统 v3。内置主题由“同一角色换背景”升级为“场景、穿搭、色板、预览成套切换”。

## 身份母版

- 唯一身份参考：`docs/theme-assets/yingyue-canonical-keyart-v1.png`
- 默认透明全身母版：`docs/theme-assets/yingyue-transparent-master-v1.png`
- 主题换装母版：`docs/theme-assets/yingyue-outfit-*-v1.png`
- 品牌图母版：`docs/theme-assets/yingyue-brand-mark-master-v1.png`
- 加载姿态母版：`docs/theme-assets/yingyue-loading-master-v1.png`
- 光标母版：`docs/theme-assets/yingyue-cursor-default-master-v1.png`、`yingyue-cursor-pointer-master-v1.png`

所有角色资产必须保持成年樱月的脸型、珊瑚玫红编发高马尾、月牙玉梳、琥珀色眼睛和成熟身形。服装可以随主题改变，但不能幼态化、学生化或变成另一名角色。

## 主题套装

主题 ID 是兼容标识，不随显示名称改变。品牌图、加载动画和光标由默认主题继承；背景、看板娘换装、色板和布局由每套主题独立提供。

| 主题 ID | 显示名称 | 场景 | 樱月穿搭 | 背景母版 |
| --- | --- | --- | --- | --- |
| `sakurafall-default` | 樱月放映室 | 珊瑚夕照的现代动漫客厅 | 标准放映礼服 | `backgrounds/screening-room-v3.png` |
| `night-stage` | 霓虹夜航 | 城市屋顶霓虹影院 | 透明机能外套与耳机 | `backgrounds/neon-night-flight-v3.png` |
| `manga-ink` | 漫画工坊 | 明亮漫画创作工作室 | 成年编辑装与数位板 | `backgrounds/manga-workshop-v3.png` |
| `forest-fresh` | 森语祭典 | 林间彩灯露天祭典 | 植物系轻礼服 | `backgrounds/forest-festival-v3.png` |
| `summer-splash` | 海盐假日 | 晴空海滩与冲浪小站 | 泳装与透明罩衫 | `backgrounds/sea-salt-holiday-v3.png` |
| `snow-noel` | 雪夜星灯 | 雪后城市节日广场 | 冬装、围巾与热饮 | `backgrounds/snowlight-night-v3.png` |

运行时背景统一为 `1672x941` WebP，主题卡预览为 `480x270` WebP，看板娘画布为 `627x720` 透明 WebP。背景中央和下方保持低细节，识别元素集中在边缘；看板娘只在需要角色的界面出现，不直接烘焙进背景。

## ImageGen 提示词

背景使用内置 ImageGen。六张图共用以下基准，并为每套主题替换场景段落：

```text
Use case: stylized-concept.
Asset type: 16:9 desktop background for a modern anime streaming application.
Style: crisp colorful high-end contemporary TV-anime background art, clean cel-painted surfaces, sharp linework, youthful 2020s design.
Composition: broad uncluttered center and lower area for app content; recognizable details along the far left, far right and upper band.
Palette: combine coral pink, aqua jade, sunny yellow, white, charcoal and one theme-specific color.
Constraints: no character, face, readable text, logo, watermark, traditional palace, antique archive, dark wood luxury hall, gradient, glowing orb, bokeh, fog, grime, grain, blur, heavy bloom, clutter or fake UI.
```

换装必须以 `yingyue-canonical-keyart-v1.png` 为身份参考，并先输出全身绿幕源图。绿幕要求纯 `#00FF00`、无地面、投影、光晕和渐变，再通过 `scripts/chroma-key-alpha.py` 去底。半透明衣料需要在深色与浅色底上共同检查边缘。

## 构建流程

```powershell
npm run assets:yingyue
```

`scripts/build-yingyue-theme-assets.py` 会：

1. 构建默认立绘、品牌图、光标和 32 帧加载精灵。
2. 构建 6 张运行时背景与设置页预览。
3. 为 5 套附加主题构建独立换装看板娘。
4. 生成应用图标、运行时 QA 图和六主题组合 QA 图。
5. 校验尺寸、Alpha、加载动画变化区域和 2MB 上限。

## 自定义主题约定

- 主题包只管理视觉变量、背景、布局和可选换装，不耦合视频源或元数据源。
- 自定义主题不提供 `mascot` 时继承默认樱月；提供换装时必须保持身份特征。
- `emptyState` 可以复用该主题的 `mascot`，无需重复二进制文件。
- 背景不得在中央放人物、标题或高频纹理。
- 设置页预览缺失时回退到 metadata 色板，不影响主题安装。

## 验收

- [x] 6 套内置主题均有独立现代动漫背景和真实预览
- [x] 5 套附加主题均有与场景配套的樱月换装
- [x] 夏日与冬日主题具有明确季节穿搭
- [x] 背景低于 2MB，预览低于 128KB，看板娘保留 Alpha
- [x] 默认主题可在设置页显式选回
- [x] 深浅模式继续由应用遮罩保障可读性
