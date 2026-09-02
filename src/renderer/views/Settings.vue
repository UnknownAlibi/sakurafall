<template>
  <div class="settings">
    <div class="settings-header">
      <div class="settings-title-lockup">
        <span class="settings-issue">SAKURAFALL CONTROL ROOM</span>
        <h1>放映设置</h1>
        <p class="subtitle">把SAKURAFALL调成最顺手的样子</p>
      </div>
    </div>

    <div class="settings-content">
      <!-- 外观设置 -->
      <div class="setting-section">
        <h2 class="section-title">
          <span class="section-icon">01</span>
          外观设置
        </h2>
        
        <div class="setting-item">
          <div class="setting-label">
            <label>主题模式</label>
            <p class="setting-desc">控制界面深浅底色，与下方主题包自由组合</p>
          </div>
          <div class="setting-control">
            <select v-model="localSettings.theme" @change="updateTheme" class="setting-select">
              <option value="light">浅色主题</option>
              <option value="dark">深色主题</option>
              <option value="auto">跟随系统</option>
            </select>
          </div>
        </div>

        <div class="setting-item theme-pack-item">
          <div class="setting-label">
            <label>界面主题包</label>
            <p class="setting-desc">点选卡片更换品牌配色与看板娘穿搭，自动适配上方深浅模式</p>
          </div>
          <div class="setting-control theme-pack-control">
            <div class="theme-card-grid">
              <button
                v-for="pack in themePacks"
                :key="pack.id"
                type="button"
                class="theme-card"
                :class="{ active: localSettings.themePackId === pack.id }"
                @click="selectThemePack(pack.id)"
              >
                <span class="theme-card-preview" :style="themePreviewStyle(pack)">
                  <span class="theme-card-preview-shade"></span>
                  <span class="theme-card-swatches">
                    <i
                      v-for="(color, ci) in themeSwatches(pack)"
                      :key="ci"
                      :style="{ background: color }"
                    ></i>
                  </span>
                  <span class="theme-card-flag">{{ themePackFlag(pack) }}</span>
                </span>
                <span class="theme-card-heading">
                  <span class="theme-card-name">{{ pack.name }}</span>
                  <span v-if="localSettings.themePackId === pack.id" class="theme-card-check">使用中</span>
                </span>
                <span class="theme-card-desc">{{ pack.description || '自定义主题' }}</span>
              </button>
              <!-- 补位引导卡片：占满网格角落，点击安装更多主题 -->
              <button
                type="button"
                class="theme-card theme-card-import"
                :disabled="importingTheme"
                @click="importThemePack"
              >
                <span class="theme-card-add-icon">＋</span>
                <span class="theme-card-name">{{ importingTheme ? '安装中...' : '安装主题包' }}</span>
                <span class="theme-card-desc">导入本地主题 JSON 文件</span>
              </button>
            </div>
            <div class="theme-pack-actions">
              <button
                v-if="activeThemePack && !activeThemePack.builtIn"
                class="setting-action-btn subtle"
                @click="removeActiveThemePack"
              >移除当前主题</button>
            </div>
          </div>
        </div>

        <div class="setting-item custom-css-item">
          <div class="setting-label">
            <label>自定义样式</label>
            <p class="setting-desc">可覆盖界面细节；远程资源、脚本表达式与窗口拖拽属性会被过滤</p>
          </div>
          <div class="setting-control custom-css-control">
            <textarea
              v-model="localSettings.customCss"
              class="custom-css-editor"
              spellcheck="false"
              maxlength="131072"
              placeholder=":root { --primary-color: #ff6b8e; }"
            ></textarea>
            <div class="custom-css-actions">
              <button class="setting-action-btn" @click="applyCustomCss">应用样式</button>
              <button class="setting-action-btn subtle" :disabled="!localSettings.customCss" @click="resetCustomCss">清空</button>
            </div>
          </div>
        </div>

        <div class="setting-item effect-mode-item">
          <div class="setting-label">
            <label>动效强度</label>
            <p class="setting-desc">控制看板娘、鼠标、背景和滚动条的二次元装饰强度</p>
          </div>
          <div class="setting-control effect-mode-control">
            <label
              v-for="mode in effectModes"
              :key="mode.value"
              class="effect-mode-card"
              :class="{ active: localSettings.uiEffectsMode === mode.value }"
            >
              <input
                type="radio"
                name="ui-effects-mode"
                :value="mode.value"
                v-model="localSettings.uiEffectsMode"
                @change="updateUiEffectsMode"
              />
              <span class="effect-mode-name">{{ mode.label }}</span>
              <span class="effect-mode-desc">{{ mode.desc }}</span>
            </label>
          </div>
        </div>

      </div>

      <!-- 播放设置 -->
      <div class="setting-section">
        <h2 class="section-title">
          <span class="section-icon">02</span>
          播放设置
        </h2>
        
        <div class="setting-item">
          <div class="setting-label">
            <label>默认视频质量</label>
            <p class="setting-desc">设置视频播放的默认清晰度</p>
          </div>
          <div class="setting-control">
            <select v-model="localSettings.videoQuality" @change="updateVideoQuality" class="setting-select">
              <option value="auto">自动选择</option>
              <option value="high">高清 (1080p)</option>
              <option value="medium">标清 (720p)</option>
              <option value="low">流畅 (480p)</option>
            </select>
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <label>智能选线偏好</label>
            <p class="setting-desc">SakuraRoute 挑选候选线路时的倾向，默认稳定优先</p>
          </div>
          <div class="setting-control">
            <select v-model="localSettings.routePreference" @change="updateRoutePreference" class="setting-select">
              <option value="stability">稳定优先</option>
              <option value="quality">清晰优先</option>
              <option value="latency">低延迟优先</option>
            </select>
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <label>自动播放</label>
            <p class="setting-desc">选择视频后是否自动开始播放</p>
          </div>
          <div class="setting-control">
            <label class="switch">
              <input 
                type="checkbox" 
                v-model="localSettings.autoPlay" 
                @change="updateAutoPlay"
              />
              <span class="slider"></span>
            </label>
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <label>播放速度记忆</label>
            <p class="setting-desc">记住上次设置的播放速度</p>
          </div>
          <div class="setting-control">
            <label class="switch">
              <input 
                type="checkbox" 
                v-model="localSettings.rememberPlaybackRate" 
                @change="updateRememberPlaybackRate"
              />
              <span class="slider"></span>
            </label>
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <label>快进 / 快退步长</label>
            <p class="setting-desc">播放器按钮和左右方向键每次跳转的时间</p>
          </div>
          <div class="setting-control">
            <select v-model.number="localSettings.seekStepSeconds" @change="updateSeekStepSeconds" class="setting-select">
              <option :value="5">5 秒</option>
              <option :value="10">10 秒</option>
              <option :value="15">15 秒</option>
              <option :value="30">30 秒</option>
            </select>
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <label>增强播放器</label>
            <p class="setting-desc">选择 mpv.exe；留空时自动查找系统中的 mpv</p>
          </div>
          <div class="setting-control path-control">
            <input
              v-model="localSettings.mpvPath"
              type="text"
              class="setting-input path-input"
              placeholder="mpv.exe 路径"
              @change="updateMpvPath"
            />
            <button class="action-btn secondary" @click="chooseMpvPath">选择</button>
            <button class="action-btn primary" :disabled="checkingMpv" @click="checkMpvPlayer">
              {{ checkingMpv ? '检测中...' : '检测' }}
            </button>
            <button
              v-if="mpvCheckResult && !mpvCheckResult.success"
              class="action-btn primary"
              :disabled="installingMpv"
              @click="installMpvPlayer"
            >
              {{ installingMpv ? '安装中...' : '一键安装 mpv' }}
            </button>
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <label>Anime4K 增强</label>
            <p class="setting-desc">启动 mpv 时加载 Anime4K / GLSL shader；改善边缘与线条观感，不等于源本身变高清</p>
          </div>
          <div class="setting-control">
            <label class="switch">
              <input
                type="checkbox"
                v-model="localSettings.enableAnime4K"
                @change="updateEnableAnime4K"
              />
              <span class="slider"></span>
            </label>
          </div>
        </div>

        <div class="setting-item" v-if="localSettings.enableAnime4K">
          <div class="setting-label">
            <label>预设方案</label>
            <p class="setting-desc">选择画质预设，影响 mpv 缩放算法与推荐 shader 列表</p>
          </div>
          <div class="setting-control preset-control">
            <select
              v-model="localSettings.anime4kPreset"
              class="setting-input preset-select"
              @change="updateAnime4kPreset"
            >
              <option v-for="preset in anime4kPresets" :key="preset.id" :value="preset.id">
                {{ preset.name }} — {{ preset.description }}
              </option>
            </select>
            <button class="action-btn secondary" :disabled="fillingShaders" @click="fillRecommendedShaders">
              {{ fillingShaders ? '恢复中...' : '使用内置 Shader' }}
            </button>
          </div>
        </div>

        <div class="setting-item shader-setting" v-if="localSettings.enableAnime4K">
          <div class="setting-label">
            <label>Shader 文件</label>
            <p class="setting-desc">留空时自动使用随应用提供的官方 Anime4K；这里仅用于覆盖为自定义 shader</p>
          </div>
          <div class="setting-control shader-control">
            <textarea
              v-model="localSettings.anime4kShaderPaths"
              class="shader-textarea"
              rows="4"
              placeholder="留空使用内置 Anime4K；也可每行填写一个自定义 .glsl 路径"
              @change="updateAnime4KShaderPaths"
            ></textarea>
          </div>
        </div>

        <p v-if="mpvCheckResult" class="setting-hint" :class="{ success: mpvCheckResult.success, error: !mpvCheckResult.success }">
          {{ mpvCheckResult.message }}
        </p>
      </div>

      <!-- 弹幕设置 -->
      <div class="setting-section">
        <h2 class="section-title">
          <span class="section-icon">03</span>
          弹幕设置
        </h2>

        <!-- 弹幕开关 -->
        <div class="setting-item">
          <div class="setting-label">
            <label>启用弹幕</label>
            <p class="setting-desc">播放时自动匹配 B 站、AcFun、弹弹play、自定义接口或本地 XML</p>
          </div>
          <div class="setting-control">
            <label class="switch">
              <input type="checkbox" v-model="localSettings.enableDanmaku" @change="updateEnableDanmaku" />
              <span class="slider"></span>
            </label>
          </div>
        </div>

        <!-- 字号 -->
        <div class="setting-item">
          <div class="setting-label">
            <label>弹幕字号</label>
            <p class="setting-desc">{{ localSettings.danmakuFontSize }}px（12-36）</p>
          </div>
          <div class="setting-control">
            <input
              type="range"
              min="12"
              max="36"
              step="1"
              v-model.number="localSettings.danmakuFontSize"
              @change="updateDanmakuFontSize"
              class="setting-range"
            />
          </div>
        </div>

        <!-- 透明度 -->
        <div class="setting-item">
          <div class="setting-label">
            <label>弹幕透明度</label>
            <p class="setting-desc">{{ Math.round(localSettings.danmakuOpacity * 100) }}%（10-100）</p>
          </div>
          <div class="setting-control">
            <input
              type="range"
              min="0.1"
              max="1"
              step="0.05"
              v-model.number="localSettings.danmakuOpacity"
              @change="updateDanmakuOpacity"
              class="setting-range"
            />
          </div>
        </div>

        <!-- 速度 -->
        <div class="setting-item">
          <div class="setting-label">
            <label>弹幕速度</label>
            <p class="setting-desc">{{ localSettings.danmakuSpeed }}x（0.5=慢，2=快）</p>
          </div>
          <div class="setting-control">
            <input
              type="range"
              min="0.5"
              max="2"
              step="0.25"
              v-model.number="localSettings.danmakuSpeed"
              @change="updateDanmakuSpeed"
              class="setting-range"
            />
          </div>
        </div>

        <!-- 显示区域 -->
        <div class="setting-item">
          <div class="setting-label">
            <label>显示区域</label>
            <p class="setting-desc">{{ Math.round(localSettings.danmakuDisplayArea * 100) }}% 屏幕高度（25-100）</p>
          </div>
          <div class="setting-control">
            <input
              type="range"
              min="0.25"
              max="1"
              step="0.05"
              v-model.number="localSettings.danmakuDisplayArea"
              @change="updateDanmakuDisplayArea"
              class="setting-range"
            />
          </div>
        </div>

        <div class="setting-item danmaku-source-item">
          <div class="setting-label">
            <label>在线弹幕源</label>
            <p class="setting-desc">自动并行匹配并合并结果，单个平台不可用时会继续使用其它来源</p>
          </div>
          <div class="setting-control danmaku-provider-grid">
            <label v-for="source in danmakuProviderOptions" :key="source.id" class="danmaku-provider-option">
              <input
                type="checkbox"
                v-model="localSettings.danmakuProviders[source.id]"
                @change="updateDanmakuProviderConfig"
              />
              <span>
                <strong>{{ source.name }}</strong>
                <small>{{ source.desc }}</small>
              </span>
            </label>
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <label>自定义弹幕接口</label>
            <p class="setting-desc">支持返回 JSON/XML 的自建服务，也支持 {name}、{episode}、{bgmId} 占位符</p>
          </div>
          <div class="setting-control danmaku-custom-control">
            <input
              type="url"
              v-model.trim="localSettings.danmakuCustomEndpoint"
              @change="updateDanmakuProviderConfig"
              class="setting-input"
              placeholder="https://example.com/danmaku?name={name}&episode={episode}"
            />
            <input
              type="password"
              v-model="localSettings.danmakuCustomToken"
              @change="updateDanmakuProviderConfig"
              class="setting-input"
              placeholder="Bearer Token（可选）"
            />
          </div>
        </div>

        <!-- dandanplay AppID -->
        <div class="setting-item">
          <div class="setting-label">
            <label>弹弹play AppID</label>
            <p class="setting-desc">可选；配置后增加弹弹play 聚合池，不影响 B 站、AcFun 和本地 XML</p>
          </div>
          <div class="setting-control">
            <input
              type="text"
              v-model="localSettings.dandanplayAppId"
              @change="updateDandanplayAppId"
              class="setting-input"
              placeholder="可选，留空则用本地导入"
            />
          </div>
        </div>

        <!-- dandanplay AppSecret -->
        <div class="setting-item">
          <div class="setting-label">
            <label>弹弹play AppSecret</label>
            <p class="setting-desc">弹弹play API 认证密钥</p>
          </div>
          <div class="setting-control">
            <input
              type="password"
              v-model="localSettings.dandanplayAppSecret"
              @change="updateDandanplayAppSecret"
              class="setting-input"
              placeholder="可选"
            />
          </div>
        </div>

        <p class="setting-hint">
          B 站和 AcFun 默认免配置；弹弹play 凭证可在 <a href="https://dev.dandanplay.com" target="_blank" rel="noopener">开发者中心</a> 申请。播放器仍支持随时导入本地 XML。
        </p>
      </div>

      <!-- 字幕设置 -->
      <div class="setting-section">
        <h2 class="section-title">
          <span class="section-icon">04</span>
          字幕设置
        </h2>

        <!-- 字幕开关 -->
        <div class="setting-item">
          <div class="setting-label">
            <label>启用字幕</label>
            <p class="setting-desc">播放视频时显示字幕（需在播放器中加载本地字幕或在线搜索）</p>
          </div>
          <div class="setting-control">
            <label class="switch">
              <input type="checkbox" v-model="localSettings.enableSubtitle" @change="updateEnableSubtitle" />
              <span class="slider"></span>
            </label>
          </div>
        </div>

        <!-- 字号 -->
        <div class="setting-item">
          <div class="setting-label">
            <label>字幕字号</label>
            <p class="setting-desc">{{ localSettings.subtitleFontSize }}px（12-48）</p>
          </div>
          <div class="setting-control">
            <input
              type="range"
              min="12"
              max="48"
              step="1"
              v-model.number="localSettings.subtitleFontSize"
              @change="updateSubtitleFontSize"
              class="setting-range"
            />
          </div>
        </div>

        <!-- 透明度 -->
        <div class="setting-item">
          <div class="setting-label">
            <label>字幕透明度</label>
            <p class="setting-desc">{{ Math.round(localSettings.subtitleOpacity * 100) }}%（10-100）</p>
          </div>
          <div class="setting-control">
            <input
              type="range"
              min="0.1"
              max="1"
              step="0.05"
              v-model.number="localSettings.subtitleOpacity"
              @change="updateSubtitleOpacity"
              class="setting-range"
            />
          </div>
        </div>

        <!-- 底部偏移 -->
        <div class="setting-item">
          <div class="setting-label">
            <label>字幕底部偏移</label>
            <p class="setting-desc">{{ localSettings.subtitleBottomOffset }}px（0-300，距离视频底部的距离）</p>
          </div>
          <div class="setting-control">
            <input
              type="range"
              min="0"
              max="300"
              step="5"
              v-model.number="localSettings.subtitleBottomOffset"
              @change="updateSubtitleBottomOffset"
              class="setting-range"
            />
          </div>
        </div>

        <!-- OpenSubtitles API Key -->
        <div class="setting-item">
          <div class="setting-label">
            <label>OpenSubtitles API Key</label>
            <p class="setting-desc">在线搜索字幕所需的 API Key（不填则仅支持本地字幕加载）</p>
          </div>
          <div class="setting-control">
            <input
              type="password"
              v-model="localSettings.openSubtitlesApiKey"
              @change="updateOpenSubtitlesApiKey"
              class="setting-input"
              placeholder="可选，留空则仅支持本地字幕"
            />
          </div>
        </div>

        <p class="setting-hint">
          提示：OpenSubtitles API Key 可在 <a href="https://www.opensubtitles.com/consumers" target="_blank" rel="noopener">opensubtitles.com</a> 注册申请；不配置时仍可在播放器中加载本地 SRT/VTT/ASS 字幕文件。支持自动检测 UTF-8/GBK 编码。
        </p>
      </div>

      <!-- 番剧更新提醒设置 -->
      <div class="setting-section">
        <h2 class="section-title">
          <span class="section-icon">05</span>
          更新提醒
        </h2>

        <!-- 启用开关 -->
        <div class="setting-item">
          <div class="setting-label">
            <label>启用更新提醒</label>
            <p class="setting-desc">定时检查收藏番剧是否有新集数，发现更新时弹出系统通知</p>
          </div>
          <div class="setting-control">
            <label class="switch">
              <input type="checkbox" v-model="localSettings.enableUpdateReminder" @change="updateEnableUpdateReminder" />
              <span class="slider"></span>
            </label>
          </div>
        </div>

        <!-- 检查间隔 -->
        <div class="setting-item">
          <div class="setting-label">
            <label>检查间隔</label>
            <p class="setting-desc">{{ localSettings.updateReminderInterval }} 分钟（最小 10，默认 60）</p>
          </div>
          <div class="setting-control">
            <input
              type="range"
              min="10"
              max="240"
              step="5"
              v-model.number="localSettings.updateReminderInterval"
              @change="updateUpdateReminderInterval"
              class="setting-range"
            />
          </div>
        </div>

        <p class="setting-hint">
          提示：首次启用时会建立基线（不发送通知），之后每次检查发现新集数才会通知。也可在"我的追番"页面点击"检查更新"按钮手动触发。
        </p>
      </div>

      <!-- 网络设置 -->
      <div class="setting-section">
        <h2 class="section-title">
          <span class="section-icon">06</span>
          网络设置
        </h2>

        <div class="setting-item effect-mode-item">
          <div class="setting-label">
            <label>数据连接方式</label>
            <p class="setting-desc">可随时切换；本机直连不会访问 SakuraFall 云服务。</p>
          </div>
          <div class="setting-control service-mode-control">
            <label
              v-for="mode in serviceModes"
              :key="mode.value"
              class="effect-mode-card service-mode-card"
              :class="{ active: localSettings.serviceMode === mode.value }"
            >
              <input
                v-model="localSettings.serviceMode"
                type="radio"
                :value="mode.value"
                @change="updateServiceMode"
              />
              <span class="effect-mode-name">{{ mode.label }}</span>
              <span class="effect-mode-desc">{{ mode.desc }}</span>
            </label>
          </div>
        </div>
        
        <div class="setting-item">
          <div class="setting-label">
            <label>请求超时时间</label>
            <p class="setting-desc">网络请求的超时时间（秒）</p>
          </div>
          <div class="setting-control">
            <input 
              type="number" 
              v-model.number="localSettings.requestTimeout" 
              @change="updateRequestTimeout"
              min="5" 
              max="60" 
              class="setting-input"
            />
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <label>并发连接数</label>
            <p class="setting-desc">同时进行的网络连接数量</p>
          </div>
          <div class="setting-control">
            <input 
              type="number" 
              v-model.number="localSettings.maxConcurrentConnections" 
              @change="updateMaxConcurrentConnections"
              min="1" 
              max="10" 
              class="setting-input"
            />
          </div>
        </div>

      </div>

      <!-- 缓存设置 -->
      <div class="setting-section">
        <h2 class="section-title">
          <span class="section-icon">07</span>
          缓存设置
        </h2>
        
        <div class="setting-item">
          <div class="setting-label">
            <label>缓存大小限制</label>
            <p class="setting-desc">应用缓存的最大大小（MB）</p>
          </div>
          <div class="setting-control">
            <input 
              type="number" 
              v-model.number="localSettings.cacheSize" 
              @change="updateCacheSize"
              min="100" 
              max="5000" 
              step="100"
              class="setting-input"
            />
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <label>自动清理缓存</label>
            <p class="setting-desc">定期自动清理过期的缓存文件</p>
          </div>
          <div class="setting-control">
            <label class="switch">
              <input
                type="checkbox"
                v-model="localSettings.autoCleanCache"
                @change="updateAutoCleanCache"
              />
              <span class="slider"></span>
            </label>
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <label>代理地址</label>
            <p class="setting-desc">
              番组计划接口和封面默认走此代理；BT 边播边下的节点发现也走此代理；视频流线路由下方开关单独控制。<br/>
              填代理地址如 http://127.0.0.1:7890，留空则直连。<br/>
              <strong>注意：v2rayN TUN 模式会接管所有流量，本设置对 TUN 模式无效。</strong>
              若开 TUN 后视频无法播放，请关闭 TUN，保留本地代理端口即可。
            </p>
          </div>
          <div class="setting-control proxy-control">
            <input
              type="text"
              v-model.trim="localSettings.proxy"
              placeholder="http://127.0.0.1:7890"
              class="proxy-input"
              @change="updateProxy"
            />
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <label>视频流线路</label>
            <p class="setting-desc">
              播放数据（m3u8 / ts 分片）的出口线路。<br/>
              源能打开但播放卡顿时，切到「走代理」试试（需先填上面的代理地址）。<br/>
              修改后对之后发起的播放生效，正在播放的视频重新打开一次即可。
            </p>
          </div>
          <div class="setting-control">
            <select class="setting-select" v-model="videoRouteMode">
              <option value="direct">直连（默认）</option>
              <option value="proxy">走代理（用上面的代理地址）</option>
            </select>
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <label>元数据服务镜像</label>
            <p class="setting-desc">
              切换番剧元数据服务地址。<br/>
              <strong>自动模式：先走官方源，失败后自动尝试公开镜像，适合不开代理时使用。</strong><br/>
              官方源：只使用默认 API，网络不可达时依赖缓存。<br/>
              自定义镜像：填入自建反代地址（如 Cloudflare Worker）。
            </p>
          </div>
          <div class="setting-control mirror-control">
            <select
              class="setting-select mirror-select"
              v-model="mirrorMode"
              @change="onMirrorPresetChange"
            >
              <option value="main">自动模式 — 推荐</option>
              <option value="official">官方源 (api.bgm.tv)</option>
              <option value="custom">自定义镜像…</option>
            </select>
            <input
              v-if="mirrorMode === 'custom'"
              type="text"
              v-model.trim="localSettings.bangumiMirror"
              placeholder="https://your-worker.example.com"
              class="proxy-input mirror-input"
              @change="updateBangumiMirror"
            />
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <label>清理缓存</label>
            <p class="setting-desc">立即清理所有缓存文件</p>
          </div>
          <div class="setting-control">
            <button @click="clearCache" class="clear-cache-btn" :disabled="clearing">
              {{ clearing ? '清理中...' : '清理缓存' }}
            </button>
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <label>运行诊断</label>
            <p class="setting-desc">检查本地数据库完整性，或打开运行日志目录用于排查崩溃和页面异常。</p>
          </div>
          <div class="setting-control diagnostics-actions">
            <button class="action-btn" @click="checkRuntimeHealth">健康检查</button>
            <button class="action-btn" @click="openDiagnosticsFolder">打开日志</button>
          </div>
        </div>

        <!-- Phase 7: 网络诊断面板 -->
        <div class="setting-item network-diagnostics-item">
          <div class="setting-label">
            <label>网络诊断</label>
            <p class="setting-desc">
              一键检测各服务连通性、代理端口可达性、TUN 模式推断。<br/>
              解决"不开 VPN 访问不到元数据服务，开 VPN 视频源播放不了"的问题。
            </p>
          </div>
          <div class="setting-control">
            <button
              class="action-btn primary"
              :disabled="runningDiagnostics"
              @click="runNetworkDiagnostics"
            >
              {{ runningDiagnostics ? '诊断中...' : '一键网络诊断' }}
            </button>
          </div>
        </div>

        <!-- 诊断结果 -->
        <div v-if="networkDiagnostics" class="network-diagnostics-report">
          <div class="diagnostic-summary" :class="networkDiagnosticsSummary.level">
            <span class="diagnostic-dot"></span>
            <span>{{ networkDiagnosticsSummary.text }}</span>
            <span class="diagnostic-elapsed">耗时 {{ networkDiagnostics.elapsedMs }}ms</span>
          </div>

          <div class="diagnostic-grid">
            <div class="diagnostic-cell" v-for="item in networkDiagnosticsItems" :key="item.key">
              <div class="cell-header">
                <span class="cell-dot" :class="item.status"></span>
                <span class="cell-name">{{ item.name }}</span>
                <span v-if="item.elapsedMs" class="cell-time">{{ item.elapsedMs }}ms</span>
              </div>
              <p class="cell-message">{{ item.message }}</p>
            </div>
          </div>

          <!-- TUN 检测结果 -->
          <div v-if="networkDiagnostics.results.tunDetection" class="tun-detection">
            <div class="tun-header" :class="{ suspected: networkDiagnostics.results.tunDetection.tunSuspected }">
              <span class="tun-icon">{{ networkDiagnostics.results.tunDetection.tunSuspected ? '⚠' : '✓' }}</span>
              <span>TUN 模式检测：{{ networkDiagnostics.results.tunDetection.tunSuspected ? '疑似 TUN 接管' : '正常' }}</span>
            </div>
            <p class="tun-suggestion">{{ networkDiagnostics.results.tunDetection.suggestion }}</p>
            <div class="tun-ips" v-if="networkDiagnostics.results.tunDetection.direct?.ip || networkDiagnostics.results.tunDetection.proxied?.ip">
              <span v-if="networkDiagnostics.results.tunDetection.direct?.ip">直连出口：{{ networkDiagnostics.results.tunDetection.direct.ip }}</span>
              <span v-if="networkDiagnostics.results.tunDetection.proxied?.ip">代理出口：{{ networkDiagnostics.results.tunDetection.proxied.ip }}</span>
            </div>
          </div>
        </div>

        <!-- 域名分流建议 -->
        <div class="setting-item domain-suggestion-item">
          <div class="setting-label">
            <label>域名分流建议</label>
            <p class="setting-desc">复制以下域名到代理软件配置规则（元数据服务走代理，视频源走直连）</p>
          </div>
          <div class="setting-control domain-suggestions">
            <div v-for="group in domainSuggestions" :key="group.group" class="domain-group">
              <p class="domain-group-title">{{ group.group }}</p>
              <div class="domain-list">
                <code v-for="domain in group.domains" :key="domain">{{ domain }}</code>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 关于信息 -->
      <div class="setting-section">
        <h2 class="section-title">
          <span class="section-icon">08</span>
          关于应用
        </h2>
        
        <div class="about-info">
          <div class="app-info">
            <h3>SAKURAFALL</h3>
            <p class="version">版本 {{ appVersion }}</p>
            <p class="description">
              基于 Vue + Electron 开发的动漫资源浏览和播放应用
            </p>
          </div>
          
          <div class="info-grid">
            <div class="info-item">
              <span class="info-label">开发框架：</span>
              <span class="info-value">Vue 3 + Electron</span>
            </div>
            <div class="info-item">
              <span class="info-label">Node.js 版本：</span>
              <span class="info-value">{{ nodeVersion }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">Electron 版本：</span>
              <span class="info-value">{{ electronVersion }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">运行平台：</span>
              <span class="info-value">{{ platform }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">开发环境：</span>
              <span class="info-value">{{ isDev ? '是' : '否' }}</span>
            </div>
          </div>
        </div>

        <!-- 应用更新（检查更新/应用内下载安装/更新源配置） -->
        <UpdateSettings />
      </div>
    </div>

    <!-- 保存提示 -->
    <div v-if="showSaveNotification" class="save-notification">
      <span class="save-icon">✅</span>
      设置已保存
    </div>
  </div>
</template>

<script>
import { mapGetters, mapActions } from 'vuex';
import UpdateSettings from '../components/Settings/UpdateSettings.vue';
import previewMoonwheel from '../assets/generated/theme-preview-sakurafall-default.webp';
import previewNightStage from '../assets/generated/theme-preview-night-stage.webp';
import previewMangaInk from '../assets/generated/theme-preview-manga-ink.webp';
import previewBamboo from '../assets/generated/theme-preview-forest-fresh.webp';
import previewTideglow from '../assets/generated/theme-preview-summer-splash.webp';
import previewFrostmoon from '../assets/generated/theme-preview-snow-noel.webp';

const THEME_PREVIEWS = Object.freeze({
  'sakurafall-default': previewMoonwheel,
  'night-stage': previewNightStage,
  'manga-ink': previewMangaInk,
  'forest-fresh': previewBamboo,
  'summer-splash': previewTideglow,
  'snow-noel': previewFrostmoon
});

export default {
  name: 'Settings',
  components: {
    UpdateSettings
  },
  data() {
    return {
      localSettings: {
        theme: 'light',
        themePackId: 'sakurafall-default',
        customCss: '',
        uiEffectsMode: 'balanced',
        videoQuality: 'high',
        routePreference: 'stability',
        autoPlay: true,
        rememberPlaybackRate: true,
        seekStepSeconds: 10,
        requestTimeout: 30,
        maxConcurrentConnections: 5,
        cacheSize: 1000,
        autoCleanCache: true,
        serviceMode: 'cloud',
        proxy: '',
        bangumiMirror: '',
        networkPolicies: null,
        mpvPath: '',
        enableAnime4K: true,
        anime4kShaderPaths: '',
        anime4kPreset: 'balanced',
        enableDanmaku: false,
        danmakuFontSize: 20,
        danmakuOpacity: 1,
        danmakuSpeed: 1,
        danmakuDisplayArea: 0.75,
        danmakuProviders: { bilibili: true, acfun: true, dandanplay: true, custom: true },
        danmakuCustomEndpoint: '',
        danmakuCustomToken: '',
        dandanplayAppId: '',
        dandanplayAppSecret: '',
        // 字幕设置
        enableSubtitle: false,
        subtitleFontSize: 24,
        subtitleOpacity: 1.0,
        subtitleBottomOffset: 80,
        openSubtitlesApiKey: '',
        // 番剧更新提醒设置
        enableUpdateReminder: true,
        updateReminderInterval: 60
      },
      clearing: false,
      showSaveNotification: false,
      checkingMpv: false,
      installingMpv: false,
      mpvCheckResult: null,
      // Phase 6: Anime4K 预设列表（从主进程加载）
      anime4kPresets: [],
      fillingShaders: false,
      // Phase 7: 网络诊断
      runningDiagnostics: false,
      networkDiagnostics: null,
      domainSuggestions: [],
      appVersion: '',
      // 通过 electronAPI 获取版本信息，避免直接访问 process
      nodeVersion: 'Unknown',
      electronVersion: 'Unknown',
      platform: 'Unknown',
      isDev: false,

      themePacks: [],
      importingTheme: false,
      // Bangumi 镜像选择模式：main(自动) | official | custom
      mirrorMode: 'main',
      effectModes: [
        { value: 'anime', label: '完整演出', desc: '全部角色、背景与交互动效，使用樱月自定义鼠标' },
        { value: 'balanced', label: '标准演出', desc: '保留完整界面动效，使用系统鼠标与原生手势' },
        { value: 'performance', label: '纯净模式', desc: '关闭装饰动画与贴纸阴影，优先性能与简洁' }
      ],
      serviceModes: [
        { value: 'cloud', label: '使用服务器', desc: '使用云端索引与封面缓存；服务异常时自动回退本机请求' },
        { value: 'local', label: '不使用服务器', desc: '沿用原有程序逻辑，直接访问官方接口与公开镜像' }
      ],
      danmakuProviderOptions: [
        { id: 'bilibili', name: '哔哩哔哩', desc: '免配置，直接匹配番剧分集弹幕' },
        { id: 'acfun', name: 'AcFun', desc: '免配置，直接读取番剧弹幕' },
        { id: 'dandanplay', name: '弹弹play 聚合', desc: '配置凭证后启用多站聚合池' },
        { id: 'custom', name: '自定义接口', desc: '使用下面配置的自建或兼容服务' }
      ]
    };
  },
  computed: {
    ...mapGetters('settings', [
      'theme',
      'themePackId',
      'customCss',
      'uiEffectsMode',
      'videoQuality',
      'autoPlay',
      'rememberPlaybackRate',
      'seekStepSeconds',
      'requestTimeout',
      'maxConcurrentConnections',
      'cacheSize',
      'autoCleanCache',
      'serviceMode',
      'proxy',
      'bangumiMirror',
      'networkPolicies',
      'mpvPath',
      'enableAnime4K',
      'anime4kShaderPaths',
      'anime4kPreset',
      // 弹幕
      'enableDanmaku',
      'danmakuFontSize',
      'danmakuOpacity',
      'danmakuSpeed',
      'danmakuDisplayArea',
      'danmakuProviders',
      'danmakuCustomEndpoint',
      'danmakuCustomToken',
      'dandanplayAppId',
      'dandanplayAppSecret',
      // 字幕
      'enableSubtitle',
      'subtitleFontSize',
      'subtitleOpacity',
      'subtitleBottomOffset',
      'openSubtitlesApiKey',
      // 番剧更新提醒
      'enableUpdateReminder',
      'updateReminderInterval'
    ]),

    activeThemePack() {
      return this.themePacks.find(pack => pack.id === this.localSettings.themePackId) || null;
    },

    // 视频流线路：direct 直连 / proxy 走应用代理（读取持久化策略，空值兜底 direct）
    videoRouteMode: {
      get() {
        const policies = this.localSettings.networkPolicies || this.networkPolicies || {};
        return policies.video === 'proxy' ? 'proxy' : 'direct';
      },
      set(value) {
        this.updateVideoRouteMode(value);
      }
    },

    // Phase 7: 网络诊断汇总
    networkDiagnosticsSummary() {
      const report = this.networkDiagnostics;
      if (!report) return { level: 'unknown', text: '尚未诊断' };
      const r = report.results || {};
      const failures = [];
      if (r.proxyPort && !r.proxyPort.reachable && report.proxyUrl) failures.push('代理端口');
      if (r.bangumi && !r.bangumi.ok) failures.push('元数据服务');
      if (r.playbackSource && !r.playbackSource.success) failures.push('播放源');
      if (r.danmaku && !r.danmaku.ok) failures.push('弹幕');
      if (r.tunDetection?.tunSuspected) failures.push('TUN 疑似');

      if (failures.length === 0) return { level: 'good', text: '所有服务连通正常' };
      if (failures.length <= 2) return { level: 'warn', text: `${failures.length} 项异常：${failures.join('、')}` };
      return { level: 'bad', text: `${failures.length} 项异常：${failures.join('、')}` };
    },
    networkDiagnosticsItems() {
      const r = this.networkDiagnostics?.results || {};
      const items = [];
      if (r.proxyPort) {
        items.push({
          key: 'proxyPort',
          name: '代理端口',
          status: r.proxyPort.reachable ? 'ok' : 'error',
          elapsedMs: r.proxyPort.elapsedMs,
          message: r.proxyPort.reachable
            ? `可达（${r.proxyPort.host}:${r.proxyPort.port}）`
            : (r.proxyPort.error || '不可达')
        });
      }
      if (r.bangumi) {
        items.push({
          key: 'bangumi',
          name: '元数据服务',
          status: r.bangumi.ok ? 'ok' : 'error',
          elapsedMs: r.bangumi.elapsedMs,
          message: r.bangumi.ok ? `正常（${r.bangumi.total} 条番剧）` : (r.bangumi.msg || '不可达')
        });
      }
      if (r.playbackSource) {
        items.push({
          key: 'playbackSource',
          name: r.playbackSource.providerName || '播放源',
          status: r.playbackSource.success ? 'ok' : 'error',
          elapsedMs: r.playbackSource.time,
          message: r.playbackSource.message || (r.playbackSource.success ? '正常' : '不可达')
        });
      }
      if (r.danmaku) {
        items.push({
          key: 'danmaku',
          name: '弹幕服务',
          status: r.danmaku.ok ? 'ok' : 'error',
          message: r.danmaku.ok ? '正常' : (r.danmaku.msg || '不可达')
        });
      }
      if (r.traceMoe) {
        items.push({
          key: 'traceMoe',
          name: '以图搜番',
          status: r.traceMoe.ok ? 'ok' : 'error',
          message: r.traceMoe.ok ? '正常' : (r.traceMoe.msg || '不可达')
        });
      }
      if (Array.isArray(r.cmsSources)) {
        const okCount = r.cmsSources.filter(s => s.success).length;
        items.push({
          key: 'cmsSources',
          name: 'CMS 数据源',
          status: okCount > 0 ? 'ok' : 'error',
          message: `${okCount}/${r.cmsSources.length} 个源可用`
        });
      }
      return items;
    }
  },
  methods: {
    ...mapActions('settings', [
      'updateTheme',
      'updateUiEffectsMode',
      'updateVideoQuality',
      'updateAutoPlay',
      'updateRememberPlaybackRate',
      'updateRequestTimeout',
      'updateMaxConcurrentConnections',
      'updateCacheSize',
      'updateAutoCleanCache',
      'updateProxy',
      'updateMpvPath',
      'updateEnableAnime4K',
      'updateAnime4KShaderPaths',
      'updateAnime4kPreset',
      // 弹幕
      'updateEnableDanmaku',
      'updateDanmakuFontSize',
      'updateDanmakuOpacity',
      'updateDanmakuSpeed',
      'updateDanmakuDisplayArea',
      'updateDanmakuProviders',
      'updateDanmakuCustomEndpoint',
      'updateDanmakuCustomToken',
      'updateDandanplayAppId',
      'updateDandanplayAppSecret',
      // 字幕
      'updateEnableSubtitle',
      'updateSubtitleFontSize',
      'updateSubtitleOpacity',
      'updateSubtitleBottomOffset',
      'updateOpenSubtitlesApiKey',
      // 番剧更新提醒
      'updateEnableUpdateReminder',
      'updateUpdateReminderInterval',
      'saveSettings'
    ]),

    async updateTheme() {
      try {
        await this.$store.dispatch('settings/updateTheme', this.localSettings.theme);
        this.showSaveSuccess();
        this.applyTheme(this.localSettings.theme);
      } catch (error) {
        console.error('更新主题失败:', error);
      }
    },

    async updateUiEffectsMode() {
      const allowedModes = new Set(['anime', 'balanced', 'performance']);
      if (!allowedModes.has(this.localSettings.uiEffectsMode)) {
        this.localSettings.uiEffectsMode = 'balanced';
      }
      localStorage.setItem('ui-effects-balanced-migration-v1', '1');
      await this.$store.dispatch('settings/updateUiEffectsMode', this.localSettings.uiEffectsMode);
      this.applyUiEffectsMode(this.localSettings.uiEffectsMode);
      this.showSaveSuccess();
    },

    async updateVideoQuality() {
      try {
        await this.$store.dispatch('settings/updateVideoQuality', this.localSettings.videoQuality);
        this.showSaveSuccess();
      } catch (error) {
        console.error('更新视频质量失败:', error);
      }
    },

    async updateRoutePreference() {
      try {
        await this.$store.dispatch('settings/updateRoutePreference', this.localSettings.routePreference);
        this.showSaveSuccess();
      } catch (error) {
        console.error('更新智能选线偏好失败:', error);
      }
    },

    async updateAutoPlay() {
      try {
        await this.$store.dispatch('settings/updateAutoPlay', this.localSettings.autoPlay);
        this.showSaveSuccess();
      } catch (error) {
        console.error('更新自动播放失败:', error);
      }
    },

    async updateRememberPlaybackRate() {
      await this.$store.dispatch('settings/updateRememberPlaybackRate', this.localSettings.rememberPlaybackRate);
      this.showSaveSuccess();
    },

    async updateSeekStepSeconds() {
      await this.$store.dispatch('settings/updateSeekStepSeconds', this.localSettings.seekStepSeconds);
      this.localSettings.seekStepSeconds = this.$store.getters['settings/seekStepSeconds'];
      this.showSaveSuccess();
    },

    async updateRequestTimeout() {
      await this.$store.dispatch('settings/updateRequestTimeout', this.localSettings.requestTimeout);
      await this.applyNetworkConfig();
      this.showSaveSuccess();
    },

    async updateMaxConcurrentConnections() {
      await this.$store.dispatch('settings/updateMaxConcurrentConnections', this.localSettings.maxConcurrentConnections);
      await this.applyNetworkConfig();
      this.showSaveSuccess();
    },

    async updateCacheSize() {
      await this.$store.dispatch('settings/updateCacheSize', this.localSettings.cacheSize);
      await this.applyNetworkConfig();
      this.showSaveSuccess();
    },

    async updateAutoCleanCache() {
      await this.$store.dispatch('settings/updateAutoCleanCache', this.localSettings.autoCleanCache);
      await this.applyNetworkConfig();
      this.showSaveSuccess();
    },

    async updateServiceMode() {
      await this.$store.dispatch('settings/updateServiceMode', this.localSettings.serviceMode);
      await this.applyNetworkConfig();
      sessionStorage.setItem('sakurafall:catalog-network-mode-refresh', '1');
      this.showSaveSuccess();
    },

    async updateProxy() {
      await this.$store.dispatch('settings/updateProxy', this.localSettings.proxy || '');
      await this.applyNetworkConfig();
      this.showSaveSuccess();
    },

    async updateVideoRouteMode(value) {
      const mode = value === 'proxy' ? 'proxy' : 'direct';
      if (mode === 'proxy' && !String(this.localSettings.proxy || '').trim()) {
        this.$notify?.warning('视频流走代理', '请先在上面填写代理地址');
      }
      // 合并已有策略再写入，避免覆盖其它服务的线路设置
      const merged = {
        ...(this.localSettings.networkPolicies || this.networkPolicies || {}),
        video: mode
      };
      this.localSettings.networkPolicies = merged;
      await this.$store.dispatch('settings/updateNetworkPolicies', merged);
      await this.applyNetworkConfig();
      this.showSaveSuccess();
    },

    async updateBangumiMirror() {
      await this.$store.dispatch('settings/updateBangumiMirror', this.localSettings.bangumiMirror || '');
      await this.applyNetworkConfig();
      this.showSaveSuccess();
    },

    // 镜像预设下拉切换：main(自动) / official / custom
    async onMirrorPresetChange() {
      // v-model 已更新 mirrorMode，这里根据模式设置 mirror 值
      if (this.mirrorMode === 'main') {
        this.localSettings.bangumiMirror = '';
        await this.updateBangumiMirror();
      } else if (this.mirrorMode === 'official') {
        this.localSettings.bangumiMirror = 'https://api.bgm.tv';
        await this.updateBangumiMirror();
      }
      // custom 模式：不自动填值，等用户在 input 中输入后 @change 触发保存
    },

    async updateMpvPath() {
      await this.$store.dispatch('settings/updateMpvPath', this.localSettings.mpvPath);
      this.mpvCheckResult = null;
      this.showSaveSuccess();
    },

    async updateEnableAnime4K() {
      await this.$store.dispatch('settings/updateEnableAnime4K', this.localSettings.enableAnime4K);
      this.showSaveSuccess();
    },

    async updateAnime4KShaderPaths() {
      await this.$store.dispatch('settings/updateAnime4KShaderPaths', this.localSettings.anime4kShaderPaths);
      this.showSaveSuccess();
    },

    async updateAnime4kPreset() {
      await this.$store.dispatch('settings/updateAnime4kPreset', this.localSettings.anime4kPreset);
      this.showSaveSuccess();
    },

    async fillRecommendedShaders() {
      this.fillingShaders = true;
      try {
        this.localSettings.anime4kShaderPaths = '';
        await this.updateAnime4KShaderPaths();
        this.$notify?.success('Anime4K', '已恢复使用应用内置的官方 Anime4K shader');
      } catch (error) {
        console.error('填充推荐 shader 失败:', error);
        this.$notify?.error('Anime4K', '填充推荐 shader 失败: ' + error.message);
      } finally {
        this.fillingShaders = false;
      }
    },

    async loadAnime4kPresets() {
      try {
        const result = await window.electronAPI?.enhancedPlayerPresets?.();
        if (result?.presets) {
          this.anime4kPresets = result.presets;
          if (!this.localSettings.anime4kPreset && result.defaultPresetId) {
            this.localSettings.anime4kPreset = result.defaultPresetId;
          }
        }
      } catch (error) {
        console.error('加载 Anime4K 预设失败:', error);
      }
    },

    // Phase 7: 一键网络诊断
    async runNetworkDiagnostics() {
      if (this.runningDiagnostics) return;
      this.runningDiagnostics = true;
      try {
        const report = await window.electronAPI?.networkRunDiagnostics?.();
        if (report) {
          this.networkDiagnostics = report;
          const level = this.networkDiagnosticsSummary.level;
          const text = this.networkDiagnosticsSummary.text;
          this.$notify?.[level === 'good' ? 'success' : level === 'warn' ? 'warning' : 'error'](
            '网络诊断',
            `${text}（耗时 ${report.elapsedMs}ms）`
          );
        } else {
          this.$notify?.warning('网络诊断', '当前版本不支持网络诊断');
        }
      } catch (error) {
        console.error('网络诊断失败:', error);
        this.$notify?.error('网络诊断', '诊断失败: ' + error.message);
      } finally {
        this.runningDiagnostics = false;
      }
    },

    async loadDomainSuggestions() {
      try {
        const suggestions = await window.electronAPI?.networkDomainSuggestions?.();
        if (Array.isArray(suggestions)) {
          this.domainSuggestions = suggestions;
        }
      } catch (error) {
        console.error('加载域名建议失败:', error);
      }
    },

    // ===== 弹幕设置方法 =====
    async updateEnableDanmaku() {
      await this.$store.dispatch('settings/updateEnableDanmaku', this.localSettings.enableDanmaku);
      this.showSaveSuccess();
    },
    async updateDanmakuFontSize() {
      await this.$store.dispatch('settings/updateDanmakuFontSize', this.localSettings.danmakuFontSize);
      this.showSaveSuccess();
    },
    async updateDanmakuOpacity() {
      await this.$store.dispatch('settings/updateDanmakuOpacity', this.localSettings.danmakuOpacity);
      this.showSaveSuccess();
    },
    async updateDanmakuSpeed() {
      await this.$store.dispatch('settings/updateDanmakuSpeed', this.localSettings.danmakuSpeed);
      this.showSaveSuccess();
    },
    async updateDanmakuDisplayArea() {
      await this.$store.dispatch('settings/updateDanmakuDisplayArea', this.localSettings.danmakuDisplayArea);
      this.showSaveSuccess();
    },
    async updateDanmakuProviderConfig() {
      await Promise.all([
        this.$store.dispatch('settings/updateDanmakuProviders', this.localSettings.danmakuProviders || {}),
        this.$store.dispatch('settings/updateDanmakuCustomEndpoint', this.localSettings.danmakuCustomEndpoint || ''),
        this.$store.dispatch('settings/updateDanmakuCustomToken', this.localSettings.danmakuCustomToken || '')
      ]);
      const result = await window.electronAPI?.danmakuConfigureProviders?.({
        providers: this.localSettings.danmakuProviders || {},
        customEndpoint: this.localSettings.danmakuCustomEndpoint || '',
        customToken: this.localSettings.danmakuCustomToken || ''
      });
      if (result?.ok === false) {
        this.$notify?.error('弹幕源配置失败', result.msg || '配置未生效');
      } else {
        this.showSaveSuccess();
      }
    },
    async updateDandanplayAppId() {
      await this.$store.dispatch('settings/updateDandanplayAppId', this.localSettings.dandanplayAppId);
      await this.syncDanmakuCredentials();
      this.showSaveSuccess();
    },
    async updateDandanplayAppSecret() {
      await this.$store.dispatch('settings/updateDandanplayAppSecret', this.localSettings.dandanplayAppSecret);
      await this.syncDanmakuCredentials();
      this.showSaveSuccess();
    },
    async syncDanmakuCredentials() {
      if (!window.electronAPI?.danmakuSetCredentials) return;
      const result = await window.electronAPI.danmakuSetCredentials(
        this.localSettings.dandanplayAppId || '',
        this.localSettings.dandanplayAppSecret || ''
      );
      if (result && result.ok === false) {
        this.$notify?.error('弹幕配置失败', result.msg || '无法保存弹弹play凭证');
      }
    },

    // ===== 字幕设置方法 =====
    async updateEnableSubtitle() {
      await this.$store.dispatch('settings/updateEnableSubtitle', this.localSettings.enableSubtitle);
      this.showSaveSuccess();
    },
    async updateSubtitleFontSize() {
      await this.$store.dispatch('settings/updateSubtitleFontSize', this.localSettings.subtitleFontSize);
      this.showSaveSuccess();
    },
    async updateSubtitleOpacity() {
      await this.$store.dispatch('settings/updateSubtitleOpacity', this.localSettings.subtitleOpacity);
      this.showSaveSuccess();
    },
    async updateSubtitleBottomOffset() {
      await this.$store.dispatch('settings/updateSubtitleBottomOffset', this.localSettings.subtitleBottomOffset);
      this.showSaveSuccess();
    },
    async updateOpenSubtitlesApiKey() {
      await this.$store.dispatch('settings/updateOpenSubtitlesApiKey', this.localSettings.openSubtitlesApiKey);
      this.showSaveSuccess();
    },

    // ===== 番剧更新提醒设置方法 =====
    async updateEnableUpdateReminder() {
      await this.$store.dispatch('settings/updateEnableUpdateReminder', this.localSettings.enableUpdateReminder);
      this.showSaveSuccess();
    },
    async updateUpdateReminderInterval() {
      // 保证最小 10 分钟
      const v = Math.max(10, Math.floor(Number(this.localSettings.updateReminderInterval) || 60));
      this.localSettings.updateReminderInterval = v;
      await this.$store.dispatch('settings/updateUpdateReminderInterval', v);
      this.showSaveSuccess();
    },

    async chooseMpvPath() {
      try {
        const result = await window.electronAPI?.selectFile?.([
          { name: 'mpv', extensions: ['exe'] },
          { name: 'All Files', extensions: ['*'] }
        ]);
        const filePath = result?.filePaths?.[0];
        if (!filePath) return;
        this.localSettings.mpvPath = filePath;
        await this.updateMpvPath();
        await this.checkMpvPlayer();
      } catch (error) {
        console.error('选择 mpv 失败:', error);
        this.$notify?.error('错误', '选择 mpv 失败: ' + error.message);
      }
    },

    async checkMpvPlayer() {
      this.checkingMpv = true;
      try {
        const result = await window.electronAPI?.enhancedPlayerCheck?.({
          mpvPath: this.localSettings.mpvPath,
          enableAnime4K: this.localSettings.enableAnime4K,
          anime4kPreset: this.localSettings.anime4kPreset,
          anime4kShaderPaths: this.localSettings.anime4kShaderPaths
        });
        this.mpvCheckResult = result || { success: false, message: '当前版本不支持增强播放器检测' };
        if (this.mpvCheckResult.success && this.mpvCheckResult.path && !this.localSettings.mpvPath && this.mpvCheckResult.path !== 'mpv') {
          this.localSettings.mpvPath = this.mpvCheckResult.path;
          await this.updateMpvPath();
        }
        this.$notify?.[this.mpvCheckResult.success ? 'success' : 'warning']('增强播放器', this.mpvCheckResult.message);
      } catch (error) {
        console.error('检测 mpv 失败:', error);
        this.mpvCheckResult = { success: false, message: error.message };
        this.$notify?.error('错误', '检测 mpv 失败: ' + error.message);
      } finally {
        this.checkingMpv = false;
      }
    },

    async installMpvPlayer() {
      if (this.installingMpv) return;
      this.installingMpv = true;
      this.mpvCheckResult = { success: false, message: '正在通过 Windows 程序包管理器安装 mpv，请稍候...' };
      try {
        const result = await window.electronAPI?.enhancedPlayerInstall?.();
        this.mpvCheckResult = result
          ? { ...result, message: result.message || result.error || 'mpv 安装失败' }
          : { success: false, message: '当前版本不支持自动安装' };
        if (result?.success) {
          if (result.path && result.path !== 'mpv') {
            this.localSettings.mpvPath = result.path;
            await this.updateMpvPath();
          }
          this.$notify?.success('增强播放器', 'mpv 安装完成，Anime4K 增强已经可以使用');
        } else {
          this.$notify?.error('安装失败', result?.repairHint || result?.error || result?.message || '请手动安装 mpv');
        }
      } catch (error) {
        this.mpvCheckResult = { success: false, message: error.message };
        this.$notify?.error('安装失败', error.message);
      } finally {
        this.installingMpv = false;
      }
    },

    buildNetworkConfigPayload() {
      const rawPolicies = this.localSettings.networkPolicies || this.networkPolicies || null;
      let networkPolicies = null;
      if (rawPolicies && typeof rawPolicies === 'object') {
        const allowedKeys = ['bangumi', 'cms', 'video', 'danmaku', 'trace-moe', 'image'];
        networkPolicies = {};
        for (const key of allowedKeys) {
          const value = rawPolicies[key];
          if (value !== undefined && value !== null) {
            networkPolicies[key] = String(value);
          }
        }
        if (Object.keys(networkPolicies).length === 0) {
          networkPolicies = null;
        }
      }

      return {
        requestTimeout: Math.max(3000, Math.round((Number(this.localSettings.requestTimeout) || 30) * 1000)),
        maxConcurrentConnections: Math.max(1, Math.round(Number(this.localSettings.maxConcurrentConnections) || 5)),
        cacheSize: Math.max(50, Math.round(Number(this.localSettings.cacheSize) || 1000)),
        autoCleanCache: !!this.localSettings.autoCleanCache,
        serviceMode: this.localSettings.serviceMode === 'local' ? 'local' : 'cloud',
        proxy: String(this.localSettings.proxy || '').trim(),
        bangumiMirror: String(this.localSettings.bangumiMirror || '').trim(),
        networkPolicies
      };
    },

    async loadThemePacks() {
      try {
        const packs = await window.electronAPI?.themePackList?.() || [];
        this.themePacks = packs;
        if (!this.themePacks.some(pack => pack.id === this.localSettings.themePackId)) {
          this.localSettings.themePackId = 'sakurafall-default';
          await this.$store.dispatch('settings/updateThemePackId', this.localSettings.themePackId);
        }
      } catch (error) {
        console.error('加载主题包失败:', error);
      }
    },

    async updateThemePack() {
      await this.$store.dispatch('settings/updateThemePackId', this.localSettings.themePackId);
      this.showSaveSuccess();
    },

    // 主题卡片点选：与下拉同一存储路径，立即生效
    async selectThemePack(id) {
      if (!id || this.localSettings.themePackId === id) return;
      this.localSettings.themePackId = id;
      await this.updateThemePack();
    },

    // 主题色板：取 metadata.tags 里的十六进制色作为预览圆点
    themeSwatches(pack) {
      const hexes = (pack?.tags || []).filter(tag => /^#[0-9a-f]{3,8}$/i.test(tag));
      if (hexes.length >= 2) return hexes.slice(0, 4);
      return ['var(--primary-color)', 'var(--accent-cyan)', 'var(--accent-gold)'];
    },

    themePreviewStyle(pack) {
      const preview = THEME_PREVIEWS[pack?.id];
      if (preview) return { backgroundImage: `url("${preview}")` };
      return { backgroundColor: this.themeSwatches(pack)[0] };
    },

    themePackFlag(pack) {
      if (pack?.id === 'sakurafall-default') return '默认';
      return pack?.builtIn ? '内置' : '已安装';
    },

    async importThemePack() {
      this.importingTheme = true;
      try {
        const result = await window.electronAPI?.themePackImportFile?.();
        if (!result || result.canceled) return;
        if (!result.success) throw new Error(result.error || '安装失败');
        await this.loadThemePacks();
        this.localSettings.themePackId = result.metadata.id;
        await this.updateThemePack();
        this.$notify?.success('主题已安装', result.metadata.name);
      } catch (error) {
        this.$notify?.error('安装失败', error.message);
      } finally {
        this.importingTheme = false;
      }
    },

    async removeActiveThemePack() {
      const pack = this.activeThemePack;
      if (!pack || pack.builtIn) return;
      const result = await window.electronAPI?.themePackRemove?.(pack.id);
      if (!result?.success) {
        this.$notify?.error('移除失败', result?.error || '未知错误');
        return;
      }
      this.localSettings.themePackId = 'sakurafall-default';
      await this.$store.dispatch('settings/updateThemePackId', this.localSettings.themePackId);
      await this.loadThemePacks();
    },

    async applyCustomCss() {
      await this.$store.dispatch('settings/updateCustomCss', this.localSettings.customCss || '');
      this.showSaveSuccess();
    },

    async resetCustomCss() {
      this.localSettings.customCss = '';
      await this.applyCustomCss();
    },

    async applyNetworkConfig() {
      try {
        if (window.electronAPI && window.electronAPI.setNetworkConfig) {
          await window.electronAPI.setNetworkConfig(this.buildNetworkConfigPayload());
        }
      } catch (error) {
        console.error('应用网络配置失败:', error);
      }
    },

    async clearCache() {
      this.clearing = true;
      try {
        // 调用 Electron 主进程的缓存清理方法
        if (window.electronAPI && window.electronAPI.clearCache) {
          await window.electronAPI.clearCache();
        }
        
        if (this.$notify) {
          this.$notify.success('成功', '缓存清理完成');
        }
      } catch (error) {
        console.error('清理缓存失败:', error);
        if (this.$notify) {
          this.$notify.error('错误', '缓存清理失败: ' + error.message);
        }
      } finally {
        this.clearing = false;
      }
    },

    async checkRuntimeHealth() {
      try {
        const health = await window.electronAPI?.databaseHealth?.();
        if (!health?.connected) throw new Error('数据库未连接');
        if (health.integrity !== 'ok' || health.schemaVersion !== health.expectedSchemaVersion) {
          throw new Error(`完整性 ${health.integrity}，schema v${health.schemaVersion}/${health.expectedSchemaVersion}`);
        }
        this.$notify?.success('运行状态正常', `数据库完整，schema v${health.schemaVersion}`);
      } catch (error) {
        this.$notify?.error('健康检查异常', error.message);
      }
    },

    async openDiagnosticsFolder() {
      try {
        const result = await window.electronAPI?.runtimeDiagnosticsOpenFolder?.();
        if (!result?.success) throw new Error(result?.error || '无法打开日志目录');
      } catch (error) {
        this.$notify?.error('打开失败', error.message);
      }
    },

    showSaveSuccess() {
      this.showSaveNotification = true;
      setTimeout(() => {
        this.showSaveNotification = false;
      }, 2000);
    },

    applyTheme(theme) {
      const root = document.documentElement;
      root.setAttribute('data-theme', theme);
      
      if (theme === 'auto') {
        const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        root.setAttribute('data-theme', systemTheme);
      }
    },

    applyUiEffectsMode(mode) {
      const allowedModes = new Set(['anime', 'balanced', 'performance']);
      const nextMode = allowedModes.has(mode) ? mode : 'balanced';
      document.documentElement.setAttribute('data-ui-effects', nextMode);
    },

    loadLocalSettings() {
      try {
        const saved = JSON.parse(localStorage.getItem('app-settings') || '{}');
        const migratedKey = 'ui-effects-balanced-migration-v1';
        if (!localStorage.getItem(migratedKey)) {
          if (!saved.uiEffectsMode || saved.uiEffectsMode === 'anime') {
            saved.uiEffectsMode = 'balanced';
          }
          localStorage.setItem(migratedKey, '1');
          localStorage.setItem('app-settings', JSON.stringify({ ...this.localSettings, ...saved }));
        }
        this.localSettings = { ...this.localSettings, ...saved };
        // 根据已保存的镜像地址推断选择模式（空值 = 自动模式）
        const m = (this.localSettings.bangumiMirror || '').trim();
        if (!m) {
          this.mirrorMode = 'main';
        } else if (m === 'https://api.bgm.tv') {
          this.mirrorMode = 'official';
        } else {
          this.mirrorMode = 'custom';
        }
        if (!['anime', 'balanced', 'performance'].includes(this.localSettings.uiEffectsMode)) {
          this.localSettings.uiEffectsMode = 'balanced';
        }
      } catch (error) {
        console.error('加载本地设置失败:', error);
      }
    },

    async loadSystemInfo() {
      try {
        // 通过 electronAPI 获取系统信息
        if (window.electronAPI) {
          this.platform = window.electronAPI.platform || 'Unknown';
          this.isDev = window.electronAPI.isDev || false;

          // 获取版本信息
          if (window.electronAPI.getVersions) {
            const versions = await window.electronAPI.getVersions();
            this.nodeVersion = versions.node || 'Unknown';
            this.electronVersion = versions.electron || 'Unknown';
            this.appVersion = versions.app || '';
          }
        }
      } catch (error) {
        console.error('获取系统信息失败:', error);
      }
    },

    formatTime(timestamp) {
      if (!timestamp) return '';
      return new Date(timestamp).toLocaleTimeString('zh-CN', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    },

  },

  async mounted() {
    const lifecycleToken = Symbol('settings-lifecycle');
    this._settingsLifecycleToken = lifecycleToken;
    const isActive = () => this._settingsLifecycleToken === lifecycleToken;
    try {
      // 加载本地设置
      this.loadLocalSettings();

      // These are independent local reads. Running them together shortens route
      // entry and bounds how long a rapidly closed Settings instance is retained.
      await Promise.allSettled([
        this.loadSystemInfo(),
        this.loadThemePacks(),
        this.loadAnime4kPresets(),
        this.loadDomainSuggestions()
      ]);
      if (!isActive()) return;

      // 应用当前主题
      this.applyTheme(this.localSettings.theme);
      this.applyUiEffectsMode(this.localSettings.uiEffectsMode);

    } catch (error) {
      console.error('初始化设置页面失败:', error);
    }
  },

  beforeUnmount() {
    this._settingsLifecycleToken = null;
  }
};
</script>

<style scoped>
.diagnostics-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.settings {
  padding: 20px;
  max-width: 1180px;
  margin: 0 auto;
  position: relative;
  background: var(--bg-base);
  color: var(--text-primary);
}

.settings-header {
  min-height: 136px;
  display: flex;
  align-items: center;
  text-align: left;
  margin: -20px -20px 24px;
  padding: 26px 190px 26px 34px;
  overflow: hidden;
  position: relative;
  background: var(--bg-surface);
  border-bottom: 2px solid var(--primary-color);
  color: var(--text-primary);
}

.settings-header::after {
  content: '';
  position: absolute;
  right: 24px;
  bottom: -26px;
  width: 150px;
  height: 170px;
  background: var(--sakurafall-character-image) center top / contain no-repeat;
  pointer-events: none;
}

.settings-title-lockup {
  position: relative;
  z-index: 1;
}

.settings-issue {
  display: block;
  margin-bottom: 7px;
  color: var(--brand-cyan-deep);
  font-family: 'Segoe UI', sans-serif;
  font-size: 10px;
  font-weight: 800;
}

.settings-header h1 {
  font-size: 28px;
  margin: 0 0 7px;
  font-weight: bold;
}

.subtitle {
  font-size: 14px;
  margin: 0;
  opacity: 0.9;
}

.settings-content {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.setting-section {
  background: var(--bg-surface);
  border-radius: 8px;
  padding: 22px;
  box-shadow: var(--shadow-sm);
  border: 1px solid var(--border-color);
  border-left: 3px solid rgba(66, 199, 238, 0.52);
  transition: background-color 0.3s var(--ease-smooth), border-color 0.3s var(--ease-smooth);
}

.section-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 18px;
  font-size: 18px;
  font-weight: bold;
  color: var(--text-primary);
  padding-bottom: 12px;
  border-bottom: 2px solid var(--divider-color);
}

.section-icon {
  width: 28px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 28px;
  border: 1px solid var(--brand-ink);
  border-radius: 4px;
  background: var(--brand-ink);
  color: #fff;
  font-family: 'Segoe UI', sans-serif;
  font-size: 10px;
  font-weight: 800;
}

.setting-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 0;
  border-bottom: 1px solid var(--divider-color);
}

.setting-item:last-child {
  border-bottom: none;
}

.setting-label {
  flex: 1;
}

.setting-label label {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  display: block;
  margin-bottom: 5px;
}

.setting-desc {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.4;
}

.setting-control {
  min-width: 200px;
  display: flex;
  justify-content: flex-end;
}

.effect-mode-item {
  align-items: flex-start;
}

.effect-mode-control {
  display: grid;
  grid-template-columns: repeat(3, minmax(112px, 1fr));
  gap: 8px;
  min-width: min(520px, 52vw);
}

.service-mode-control {
  display: grid;
  grid-template-columns: repeat(2, minmax(170px, 1fr));
  gap: 8px;
  min-width: min(520px, 52vw);
}

.service-mode-card {
  min-height: 72px;
}

.effect-mode-card {
  position: relative;
  min-height: 76px;
  padding: 10px 12px;
  border: 1px solid rgba(var(--primary-rgb), 0.14);
  border-radius: 8px;
  background: var(--bg-card-glass);
  cursor: pointer;
  transition: background-color 0.2s var(--ease-smooth), border-color 0.2s var(--ease-smooth), box-shadow 0.2s var(--ease-smooth), transform 0.2s var(--ease-smooth);
}

.effect-mode-card:hover {
  border-color: rgba(var(--primary-rgb), 0.34);
  transform: translateY(-1px);
}

.effect-mode-card.active {
  border-color: var(--primary-color);
  background: linear-gradient(135deg, var(--primary-light), rgba(66, 199, 238, 0.08));
  box-shadow: 0 10px 24px rgba(160, 74, 118, 0.1);
}

.effect-mode-card input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.effect-mode-name,
.effect-mode-desc {
  display: block;
}

.effect-mode-name {
  margin-bottom: 5px;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 700;
}

.effect-mode-desc {
  color: var(--text-tertiary);
  font-size: 11px;
  line-height: 1.45;
}

.setting-select,
.setting-input {
  padding: 10px 15px;
  border: 2px solid var(--border-color-strong);
  border-radius: 8px;
  font-size: 14px;
  background: var(--bg-input);
  color: var(--text-primary);
  transition: background-color 0.3s var(--ease-smooth), border-color 0.3s var(--ease-smooth), color 0.3s var(--ease-smooth);
  min-width: 150px;
}

.setting-range {
  width: 200px;
  height: 6px;
  -webkit-appearance: none;
  appearance: none;
  background: var(--border-color);
  border-radius: 3px;
  outline: none;
  cursor: pointer;
}

.setting-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--primary-color);
  cursor: pointer;
  transition: transform 0.15s;
}

.setting-range::-webkit-slider-thumb:hover {
  transform: scale(1.15);
}

.setting-select:focus,
.setting-input:focus {
  outline: none;
  border-color: var(--primary-color);
  box-shadow: 0 0 0 3px var(--primary-light);
}

.path-control {
  gap: 8px;
  min-width: 380px;
}

.path-input {
  flex: 1;
  min-width: 180px;
}

.shader-setting {
  align-items: flex-start;
}

.shader-control {
  min-width: 380px;
}

.shader-textarea {
  width: 100%;
  min-height: 86px;
  padding: 10px 12px;
  border: 2px solid var(--border-color-strong);
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-primary);
  background: var(--bg-input);
  resize: vertical;
  font-family: 'Consolas', 'Monaco', monospace;
}

.shader-textarea:focus {
  outline: none;
  border-color: var(--primary-color);
  box-shadow: 0 0 0 3px var(--primary-light);
}

/* Phase 6: Anime4K 预设选择 */
.preset-control {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.preset-select {
  flex: 1;
  min-width: 240px;
  max-width: 420px;
  padding: 8px 12px;
  border: 2px solid var(--border-color-strong);
  border-radius: 8px;
  font-size: 13px;
  color: var(--text-primary);
  background: var(--bg-input);
  cursor: pointer;
}

.preset-select:focus {
  outline: none;
  border-color: var(--primary-color);
  box-shadow: 0 0 0 3px var(--primary-light);
}

/* Phase 7: 网络诊断面板 */
.network-diagnostics-item .setting-control {
  align-self: center;
}

.network-diagnostics-report {
  width: 100%;
  margin: 8px 0 16px;
  padding: 12px 16px;
  border: 2px solid var(--border-color-strong);
  border-radius: 10px;
  background: var(--bg-card);
}

.diagnostic-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-color);
  font-weight: 600;
  font-size: 14px;
}

.diagnostic-summary.good { color: #22c55e; }
.diagnostic-summary.warn { color: #f59e0b; }
.diagnostic-summary.bad { color: #ef4444; }

.diagnostic-summary .diagnostic-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: currentColor;
}

.diagnostic-elapsed {
  margin-left: auto;
  font-weight: 400;
  font-size: 12px;
  color: var(--text-secondary);
}

.diagnostic-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}

.diagnostic-cell {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--bg-input);
  border: 1px solid var(--border-color);
}

.cell-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  font-size: 13px;
  font-weight: 600;
}

.cell-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.cell-dot.ok { background: #22c55e; }
.cell-dot.error { background: #ef4444; }
.cell-dot.warn { background: #f59e0b; }

.cell-time {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-secondary);
  font-weight: 400;
}

.cell-message {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.4;
}

.tun-detection {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--bg-input);
  border: 1px solid var(--border-color);
}

.tun-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 13px;
  color: #22c55e;
}

.tun-header.suspected {
  color: #f59e0b;
}

.tun-icon {
  font-size: 16px;
}

.tun-suggestion {
  margin: 6px 0 4px;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.tun-ips {
  display: flex;
  gap: 12px;
  font-size: 11px;
  color: var(--text-secondary);
  font-family: 'Consolas', 'Monaco', monospace;
}

/* 域名分流建议 */
.domain-suggestion-item {
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
}

.domain-suggestions {
  flex-direction: column;
  align-items: stretch;
  width: 100%;
}

.domain-group {
  margin-bottom: 10px;
}

.domain-group-title {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}

.domain-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.domain-list code {
  padding: 3px 8px;
  border-radius: 4px;
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  font-size: 12px;
  color: var(--text-primary);
  cursor: pointer;
  transition: border-color 0.2s;
}

.domain-list code:hover {
  border-color: var(--primary-color);
}

.switch {
  position: relative;
  display: inline-block;
  width: 50px;
  height: 24px;
}

.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: var(--border-color-strong);
  transition: 0.3s;
  border-radius: 24px;
}

.slider:before {
  position: absolute;
  content: "";
  height: 18px;
  width: 18px;
  left: 3px;
  bottom: 3px;
  background-color: var(--bg-surface);
  transition: 0.3s;
  border-radius: 50%;
}

input:checked + .slider {
  background-color: var(--primary-color);
}

input:checked + .slider:before {
  transform: translateX(26px);
}

.clear-cache-btn {
  padding: 10px 20px;
  background: var(--error-color);
  color: var(--text-inverse);
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
  transition: opacity 0.3s var(--ease-smooth), transform 0.3s var(--ease-smooth), background-color 0.3s var(--ease-smooth);
}

.clear-cache-btn:hover:not(:disabled) {
  opacity: 0.85;
  transform: translateY(-2px);
}

.clear-cache-btn:disabled {
  background: var(--text-tertiary);
  cursor: not-allowed;
  transform: none;
}

/* 代理输入框 */
.proxy-control {
  min-width: 220px;
}

.proxy-input {
  width: 100%;
  padding: 8px 12px;
  background: var(--bg-surface);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  font-size: 13px;
  font-family: 'Consolas', 'Monaco', monospace;
  outline: none;
  transition: border-color 0.2s;
}

.proxy-input::placeholder {
  color: var(--text-tertiary);
}

.proxy-input:focus {
  border-color: var(--primary-color);
}

/* Bangumi 镜像选择 */
.mirror-control {
  min-width: 260px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mirror-select {
  width: 100%;
}

.mirror-input {
  width: 100%;
}

.about-info {
  text-align: center;
}

.app-info h3 {
  font-size: 24px;
  color: var(--text-primary);
  margin: 0 0 10px 0;
}

.version {
  font-size: 16px;
  color: var(--primary-color);
  font-weight: bold;
  margin: 0 0 15px 0;
}

.description {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0 0 25px 0;
  line-height: 1.6;
}

.info-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 15px;
  text-align: left;
}

.info-item {
  display: flex;
  justify-content: space-between;
  padding: 10px 15px;
  background: var(--primary-lighter);
  border-radius: 8px;
}

.info-label {
  font-weight: 600;
  color: var(--text-primary);
}

.info-value {
  color: var(--text-secondary);
  font-family: 'Consolas', 'Monaco', monospace;
}

.save-notification {
  position: fixed;
  bottom: 30px;
  right: 30px;
  background: var(--success-color);
  color: var(--text-inverse);
  padding: 15px 20px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  box-shadow: var(--shadow-md);
  animation: slideIn 0.3s var(--ease-smooth);
  z-index: 1000;
}

.save-icon {
  font-size: 16px;
}

@keyframes slideIn {
  from {
    transform: translateX(100%);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

@media (max-width: 768px) {
  .settings {
    padding: 10px;
  }
  
  .settings-header {
    margin: -10px -10px 30px -10px;
    min-height: 112px;
    padding: 20px 112px 20px 18px;
  }

  .settings-header::after {
    right: 4px;
    width: 106px;
    height: 126px;
  }
  
  .settings-header h1 {
    font-size: 24px;
  }
  
  .setting-item {
    flex-direction: column;
    align-items: flex-start;
    gap: 15px;
  }
  
  .setting-control {
    min-width: auto;
    width: 100%;
    justify-content: flex-start;
  }

  .effect-mode-control {
    grid-template-columns: 1fr;
    min-width: auto;
    width: 100%;
  }

  .service-mode-control {
    grid-template-columns: 1fr;
    min-width: auto;
    width: 100%;
  }
  
  .setting-select,
  .setting-input {
    min-width: auto;
    width: 100%;
  }

  .path-control,
  .shader-control {
    min-width: auto;
  }

  .path-control {
    flex-wrap: wrap;
  }
  
  .info-grid {
    grid-template-columns: 1fr;
  }
}

/* ── 数据源管理 ── */
.source-diagnostic-panel {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) minmax(260px, auto) auto;
  align-items: center;
  gap: 16px;
  padding: 14px 16px;
  margin-bottom: 14px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-elevated);
}

.source-diagnostic-panel.good {
  border-color: rgba(45, 211, 111, 0.35);
}

.source-diagnostic-panel.warn,
.source-diagnostic-panel.testing {
  border-color: rgba(255, 193, 7, 0.35);
}

.source-diagnostic-panel.bad {
  border-color: rgba(255, 107, 107, 0.35);
}

.diagnostic-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.diagnostic-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: var(--text-tertiary);
}

.source-diagnostic-panel.good .diagnostic-dot {
  background: var(--success-color);
}

.source-diagnostic-panel.warn .diagnostic-dot,
.source-diagnostic-panel.testing .diagnostic-dot {
  background: #f4bf45;
}

.source-diagnostic-panel.bad .diagnostic-dot {
  background: var(--error-color);
}

.diagnostic-heading strong {
  display: block;
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.3;
}

.diagnostic-heading p {
  margin: 3px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.4;
}

.diagnostic-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(52px, 1fr));
  gap: 8px;
}

.diagnostic-metric {
  min-width: 52px;
  padding: 7px 8px;
  border-radius: 6px;
  background: var(--bg-input);
  text-align: center;
}

.metric-value {
  display: block;
  color: var(--text-primary);
  font-size: 15px;
  font-weight: 700;
  line-height: 1.2;
}

.metric-label {
  display: block;
  margin-top: 2px;
  color: var(--text-tertiary);
  font-size: 11px;
}

.diagnostic-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}

.diagnostic-time {
  color: var(--text-tertiary);
  font-size: 12px;
  white-space: nowrap;
}

.source-item .setting-label {
  flex: 1;
}

.source-id {
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 4px;
}

.source-real-name {
  margin-top: 3px;
}

.source-test-message {
  margin-top: 4px;
}

.source-test-message.error {
  color: var(--error-color);
}

.source-status {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}

.source-health-badge,
.cooldown-badge {
  padding: 4px 10px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}

.source-health-badge.health-good {
  background: rgba(45, 211, 111, 0.18);
  color: #41d87d;
}

.source-health-badge.health-warn {
  background: rgba(255, 193, 7, 0.18);
  color: #f4bf45;
}

.source-health-badge.health-bad,
.cooldown-badge {
  background: rgba(255, 107, 107, 0.18);
  color: #ff8a8a;
}

.status-badge {
  padding: 4px 10px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
  background: var(--border-color);
  color: var(--text-secondary);
}

.status-badge.available {
  background: var(--success-color);
  color: var(--text-inverse);
}

.status-badge.unavailable {
  background: var(--error-color);
  color: var(--text-inverse);
}

.status-badge.unknown {
  background: var(--border-color-strong);
  color: var(--text-tertiary);
}

.test-source-btn,
.action-btn {
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.3s var(--ease-smooth), color 0.3s var(--ease-smooth), transform 0.3s var(--ease-smooth);
  border: none;
}

.test-source-btn {
  background: var(--primary-lighter);
  color: var(--primary-color);
}

.test-source-btn:hover:not(:disabled) {
  background: var(--primary-light);
}

.test-source-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.source-actions {
  display: flex;
  gap: 12px;
  margin-top: 20px;
  padding-top: 20px;
  border-top: 1px solid var(--divider-color);
}

.action-btn.secondary {
  background: var(--bg-input);
  color: var(--text-primary);
  border: 1px solid var(--border-color-strong);
}

.action-btn.secondary:hover:not(:disabled) {
  background: var(--border-color);
}

.action-btn.primary {
  background: var(--primary-color);
  color: var(--text-inverse);
}

.action-btn.primary:hover:not(:disabled) {
  background: var(--primary-hover);
}

.action-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

@media (max-width: 960px) {
  .source-diagnostic-panel {
    grid-template-columns: 1fr;
    align-items: stretch;
  }

  .diagnostic-actions {
    justify-content: space-between;
  }
}

@media (max-width: 520px) {
  .diagnostic-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .diagnostic-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .diagnostic-actions .action-btn {
    width: 100%;
  }
}

.setting-hint {
  font-size: 13px;
  color: var(--text-tertiary);
  margin: 15px 0 0 0;
  line-height: 1.5;
}

.setting-hint.success {
  color: var(--success-color);
}

.setting-hint.error {
  color: var(--error-color);
}

.danmaku-source-item {
  align-items: flex-start;
}

.danmaku-provider-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(170px, 1fr));
  gap: 8px;
  width: min(560px, 64%);
}

.danmaku-provider-option {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  min-height: 54px;
  padding: 9px 10px;
  border: 1px solid var(--border-color-strong);
  border-radius: 6px;
  background: var(--bg-input);
  cursor: pointer;
  transition: border-color 160ms var(--ease-smooth), background-color 160ms var(--ease-smooth);
}

.danmaku-provider-option:has(input:checked) {
  border-color: var(--primary-color);
  background: rgba(var(--primary-rgb), 0.08);
}

.danmaku-provider-option input {
  margin-top: 3px;
  accent-color: var(--primary-color);
}

.danmaku-provider-option span,
.danmaku-custom-control {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.danmaku-provider-option strong {
  color: var(--text-primary);
  font-size: 13px;
}

.danmaku-provider-option small {
  color: var(--text-tertiary);
  font-size: 11px;
  line-height: 1.35;
}

.danmaku-custom-control {
  width: min(560px, 64%);
}

/* 主题包设置项：卡片墙较宽，改纵向布局让标题在上、卡片墙占满整行，避免左右挤压留白 */
.theme-pack-item {
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  gap: 4px;
}

.theme-pack-item .setting-label {
  flex: none;
}

.theme-pack-item .setting-control {
  min-width: 0;
  justify-content: stretch;
}

.theme-pack-control {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
}

.theme-pack-actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}

.setting-action-btn {
  min-height: 34px;
  padding: 0 12px;
  border: 1px solid var(--primary-color);
  border-radius: 6px;
  background: var(--primary-color);
  color: #fff;
  cursor: pointer;
  transition: transform 160ms var(--ease-smooth), background-color 160ms var(--ease-smooth), border-color 160ms var(--ease-smooth);
}

.setting-action-btn:hover:not(:disabled) {
  transform: translateY(-1px);
  background: var(--primary-hover);
  border-color: var(--primary-hover);
}

.setting-action-btn.subtle {
  background: transparent;
  color: var(--text-secondary);
  border-color: var(--border-color-strong);
}

.setting-action-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.custom-css-item {
  align-items: flex-start;
}

.custom-css-control {
  width: min(520px, 62%);
}

.custom-css-editor {
  width: 100%;
  min-height: 112px;
  resize: vertical;
  padding: 10px 12px;
  border: 1px solid var(--border-color-strong);
  border-radius: 6px;
  outline: none;
  background: var(--bg-base);
  color: var(--text-primary);
  font: 12px/1.6 Consolas, monospace;
}

.custom-css-editor:focus {
  border-color: var(--primary-color);
  box-shadow: 0 0 0 3px rgba(var(--primary-rgb), 0.12);
}

.custom-css-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}

@media (max-width: 760px) {
  .custom-css-control {
    width: 100%;
  }

  .danmaku-provider-grid,
  .danmaku-custom-control {
    width: 100%;
  }

  .danmaku-provider-grid {
    grid-template-columns: 1fr;
  }

}
</style>

<style scoped src="../styles/settings-theme-cards.css"></style>
