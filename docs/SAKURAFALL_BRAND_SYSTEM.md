# SakuraFall 品牌与看板娘规范

## 核心设定

- 品牌名：SAKURAFALL
- 看板娘：樱月（Yingyue）
- 年龄气质：视觉年龄 27-30 岁，沉静、成熟、从容，禁止幼态化和学生化
- 固定识别特征：珊瑚玫红编发高马尾、月牙玉梳、琥珀色眼睛、成熟脸型与高挑比例
- 可变视觉层：服装、手持物和姿态可以随主题变化；默认礼服不再限制所有季节主题
- 状态符号：腰间三角代表待播放，掌心双竖线代表播放中与暂停操作
- 品牌关系：Logo、加载图、光标和主题换装必须从樱月的脸型、发色、月牙玉梳与播放状态符号中提炼

## 资产规则

- `docs/theme-assets/yingyue-canonical-keyart-v1.png`：樱月唯一身份母版；所有新角色资产必须以此图作为高保真参考
- `docs/theme-assets/yingyue-transparent-master-v1.png`：透明全身立绘母版
- `docs/theme-assets/yingyue-outfit-*-v1.png`：主题换装透明母版，只替换服装和姿态，不替换角色身份
- `docs/theme-assets/yingyue-brand-mark-master-v1.png`：月牙头像品牌图母版
- `docs/theme-assets/yingyue-loading-master-v1.png`：固定人物与双手的加载姿态母版
- `docs/theme-assets/yingyue-cursor-*-master-v1.png`：默认箭头与链接手势光标母版
- `extensions/bundled/themes/sakurafall-default/assets/mascot.webp`：发现页、空状态和大尺寸静态展示，运行时画布 `627x720`
- `extensions/bundled/themes/sakurafall-default/assets/loading-animation.webp`：32 帧透明加载精灵图，每帧 `192x270`，横向排列为 `6144x270`
- `extensions/bundled/themes/sakurafall-default/assets/loading-static.webp`：减少动态效果、滚动和性能压力模式使用的静态首帧
- `extensions/bundled/themes/sakurafall-default/assets/cursor-*.png`：`128x128` 高精度源，由运行时归一到 `40x40`
- `build/icon-v4.*`、`public/favicon-v4.ico`、`public/sakurafall-mark-v4.png`：由同一品牌图母版派生的应用图标
- `src/renderer/assets/generated/yingyue-loading-*.webp`：主题运行时加载前使用的启动期副本，构建时由 Vite 生成相对路径，避免首屏退回通用圆圈

现有 `sakurane-*` 文件名和 AppUserModelID 暂作为运行时兼容标识保留，不代表角色名称。旧版水手服角色与相关主题换装属于待迁移资产，不得再作为新图的身份参考。

樱月的加载动画应从母版单独派生透明背景素材。人物和双手在所有帧中保持固定，只允许掌心播放状态装置或独立机械部件运动；禁止使用 AI 逐帧重画人物，也不要叠加独立旋转的手掌、手指或无意义信号圆环。

运行 `npm run assets:yingyue` 可从版本化透明母版重新构建默认主题、32 帧加载精灵、光标和各尺寸应用图标。构建依赖 Pillow，产物尺寸、透明画布、加载圆心和光标热点均由脚本固定。

不要混用旧版场景截图 Logo、旧看板娘、玻璃质感播放挂件或系统 emoji 作为品牌形象。

Windows 开发版使用 `com.sakurafall.app.dev.sakurane.v4` 作为 AppUserModelID，避免任务栏复用旧图标缓存。应用图标必须通过 `scripts/build-yingyue-theme-assets.py` 与当前品牌图同步，不再分别手工导出。

## 文字规则

- 一级导航固定使用：番剧库、发现、我的追番、下载、数据源、设置
- 加载文案统一使用“樱月正在……”句式
- 页面品牌副标题统一使用 `SAKURAFALL · 中文栏目说明`
- 中文界面使用 `Microsoft YaHei UI / Yu Gothic UI / Meiryo` 字体栈
- 字距固定为 `0`，标题依靠字重与颜色建立层级

## 色彩与动效

- 珊瑚粉：主操作与角色头发
- 深靛色：轮廓、导航选中和文字骨架
- 青色：信号、星芒和辅助状态
- 动画模式使用单张精灵图配合 CSS `steps(32)` 和 `translate3d`，以 32fps 在合成层播放，禁止运行时切换多张图片
- 均衡、性能和减少动态效果模式使用静态首帧
- 滚动或性能压力较高时暂停加载精灵动画，避免与列表合成竞争

## 主题世界

内置显示名称依次为：樱月放映室、霓虹夜航、漫画工坊、森语祭典、海盐假日、雪夜星灯。

- 每套主题同时定义场景背景、换装看板娘、四色板、卡片质感与密度，形成完整视觉套装。
- 樱月的脸、年龄、发色、发型和月牙玉梳保持统一；季节穿搭必须与背景成立，例如海滩配泳装罩衫，雪夜配冬装。
- 品牌图、加载动画和光标是跨主题身份层，默认统一继承，避免系统识别随主题漂移。
- 背景必须是可辨认的现代动漫场景，禁止用单色渐变、模糊光斑或纯装饰纹样代替主题设计。
- 中央与下半区必须留给应用内容，建筑和自然细节集中在边缘；深浅模式通过半透明底色控制可读性。
- 内部 ID `night-stage`、`manga-ink`、`forest-fresh`、`summer-splash`、`snow-noel` 仅为兼容标识。
