// 增强播放服务（Phase 6）
// 把 mpv 启动 / 检测 / Anime4K shader 预设逻辑从 index.js 抽出，统一管理。
//
// 职责：
// 1. 检测 mpv 可执行文件（自动查找 + 手动指定）。
// 2. 构造 mpv 启动参数（含 Referer / User-Agent / 起始进度 / Anime4K shader）。
// 3. 提供 Anime4K 预设：light / balanced / quality。
// 4. 启动 mpv 进程，返回结构化结果（含失败修复建议）。
//
// 不承诺"把 720P 变真 4K"——UI 文案统一叫"Anime4K 增强"。

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEFAULT_REFERER = '';

// Anime4K 预设：影响 mpv 缩放参数 + 推荐 shader 列表
// shader 文件来自 Anime4K 官方 Release 包；用户也可以在设置中覆盖为自定义文件。
const PRESETS = {
  light: {
    id: 'light',
    name: '轻量',
    description: '适合 720p 及以下，优先性能',
    mpvArgs: {
      scale: 'lanczos',
      cscale: 'bilinear',
      'video-sync': 'audio',
      'cache-secs': 45,
      'cache-pause-wait': 2.5,
      'demuxer-max-bytes': '128MiB',
      interpolation: false
    },
    recommendedShaders: [
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Restore_CNN_Soft_S.glsl',
      'Anime4K_Upscale_CNN_x2_S.glsl'
    ]
  },
  balanced: {
    id: 'balanced',
    name: '均衡',
    description: '适合 1080p，画质与性能平衡（推荐）',
    mpvArgs: {
      scale: 'ewa_lanczossharp',
      cscale: 'ewa_lanczossharp',
      'video-sync': 'display-resample',
      'cache-secs': 90,
      'cache-pause-wait': 3,
      'demuxer-max-bytes': '256MiB',
      interpolation: true
    },
    recommendedShaders: [
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Restore_CNN_Soft_M.glsl',
      'Anime4K_Upscale_CNN_x2_M.glsl',
      'Anime4K_AutoDownscalePre_x2.glsl',
      'Anime4K_AutoDownscalePre_x4.glsl'
    ]
  },
  quality: {
    id: 'quality',
    name: '高质量',
    description: '适合 4K / 高分屏，最佳画质（最吃性能）',
    mpvArgs: {
      scale: 'ewa_lanczossharp',
      cscale: 'ewa_lanczossharp',
      'video-sync': 'display-resample',
      'cache-secs': 120,
      'cache-pause-wait': 4,
      'demuxer-max-bytes': '384MiB',
      interpolation: true,
      profile: 'gpu-hq'
    },
    recommendedShaders: [
      'Anime4K_Clamp_Highlights.glsl',
      'Anime4K_Restore_CNN_Soft_L.glsl',
      'Anime4K_Upscale_CNN_x2_L.glsl',
      'Anime4K_AutoDownscalePre_x2.glsl',
      'Anime4K_AutoDownscalePre_x4.glsl',
      'Anime4K_Darken_HQ.glsl',
      'Anime4K_Thin_Fast.glsl'
    ]
  }
};

const DEFAULT_PRESET_ID = 'balanced';

function safeError(...args) {
  try { console.error(...args); } catch (_) { /* ignore EPIPE */ }
}

function normalizePath(value) {
  return String(value || '').trim().replace(/^"|"$/g, '');
}

class EnhancedPlayerService {
  constructor() {
    this.defaultPresetId = DEFAULT_PRESET_ID;
  }

  // ===== 预设 =====

  getPresets() {
    return Object.values(PRESETS);
  }

  getPreset(id) {
    return PRESETS[id] || PRESETS[this.defaultPresetId];
  }

  /**
   * 根据预设返回推荐的 shader 文件名列表
   * 注意：只返回文件名，用户需自行下载 Anime4K 包并配置目录
   */
  getRecommendedShaderNames(presetId) {
    const preset = this.getPreset(presetId);
    return [...preset.recommendedShaders];
  }

  // ===== mpv 检测 =====

  /**
   * 查找 mpv 可执行文件：优先用户配置路径，否则在常见目录中搜索
   */
  findMpvExecutable(preferredPath = '') {
    const configured = normalizePath(preferredPath);
    if (configured && fs.existsSync(configured)) {
      return configured;
    }

    const candidates = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'mpv', 'mpv.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'mpv', 'mpv.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'mpv', 'mpv.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'mpv', 'mpv.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'mpv.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'mpvnet.exe'),
      path.join(process.env.USERPROFILE || '', 'scoop', 'shims', 'mpv.exe'),
      path.join(process.env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin', 'mpv.exe'),
      ...this.findWingetMpvCandidates()
    ].filter(Boolean);

    return candidates.find(candidate => fs.existsSync(candidate)) || 'mpv';
  }

  findWingetMpvCandidates() {
    const packagesRoot = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
    if (!packagesRoot || !fs.existsSync(packagesRoot)) return [];
    try {
      const packageDirs = fs.readdirSync(packagesRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /(?:^|[._-])mpv(?:[._-]|$)/i.test(entry.name))
        .slice(0, 12);
      const results = [];
      const visit = (directory, depth = 0) => {
        if (depth > 3 || results.length >= 12) return;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const entryPath = path.join(directory, entry.name);
          if (entry.isFile() && /^mpv(?:net)?\.exe$/i.test(entry.name)) results.push(entryPath);
          else if (entry.isDirectory()) visit(entryPath, depth + 1);
          if (results.length >= 12) break;
        }
      };
      packageDirs.forEach(entry => visit(path.join(packagesRoot, entry.name)));
      return results;
    } catch (_) {
      return [];
    }
  }

  getBundledShaderDir() {
    const candidates = [
      process.resourcesPath ? path.join(process.resourcesPath, 'anime4k') : '',
      path.resolve(__dirname, '..', '..', '..', 'resources', 'anime4k')
    ].filter(Boolean);
    return candidates.find(candidate => fs.existsSync(candidate)) || '';
  }

  resolveShaderSelection(options = {}) {
    if (!options.enableAnime4K) {
      return { enabled: false, source: 'disabled', paths: [], missing: [] };
    }
    const customPaths = this.splitShaderPaths(options.anime4kShaderPaths);
    if (customPaths.length > 0) {
      return {
        enabled: true,
        source: 'custom',
        paths: customPaths.filter(shaderPath => fs.existsSync(shaderPath)),
        missing: customPaths.filter(shaderPath => !fs.existsSync(shaderPath))
      };
    }
    const shaderDir = this.getBundledShaderDir();
    const names = this.getRecommendedShaderNames(options.presetId || options.anime4kPreset);
    const bundledPaths = names.map(name => path.join(shaderDir, name));
    return {
      enabled: true,
      source: 'bundled',
      paths: bundledPaths.filter(shaderPath => fs.existsSync(shaderPath)),
      missing: bundledPaths.filter(shaderPath => !fs.existsSync(shaderPath))
    };
  }

  /**
   * 获取 mpv 版本信息
   */
  getMpvVersion(command) {
    return new Promise((resolve) => {
      execFile(command, ['--version'], { timeout: 5000 }, (error, stdout) => {
        if (error) {
          resolve('');
          return;
        }
        resolve(String(stdout || '').split(/\r?\n/)[0] || '');
      });
    });
  }

  /**
   * 检测 mpv 是否可用
   */
  async check(options = {}) {
    const command = this.findMpvExecutable(options.mpvPath);
    const version = await this.getMpvVersion(command);
    const shaders = this.resolveShaderSelection(options);
    if (!version) {
      return {
        success: false,
        path: command,
        message: '未检测到 mpv，请安装 mpv 或在设置中选择 mpv.exe',
        repairHint: '可在设置中一键安装，或从 https://mpv.io/installation/ 下载',
        anime4kReady: shaders.paths.length > 0,
        shaderCount: shaders.paths.length
      };
    }

    return {
      success: true,
      path: command,
      version,
      anime4kReady: shaders.enabled && shaders.paths.length > 0,
      shaderCount: shaders.paths.length,
      shaderSource: shaders.source,
      missingShaders: shaders.missing,
      message: shaders.enabled && shaders.paths.length > 0
        ? `检测成功：${version}；Anime4K ${shaders.paths.length} 个 shader 已就绪`
        : `检测成功：${version}；当前使用 mpv 高质量缩放`
    };
  }

  runWingetInstall(args) {
    return new Promise((resolve) => {
      const windowsAppsWinget = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'winget.exe');
      // Windows App Execution Alias may report existsSync=false while remaining executable.
      const command = process.env.LOCALAPPDATA ? windowsAppsWinget : 'winget.exe';
      execFile(command, args, { timeout: 5 * 60 * 1000, windowsHide: true }, (error, stdout, stderr) => {
        resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    });
  }

  async install() {
    if (process.platform !== 'win32') {
      return { success: false, error: '当前仅支持在 Windows 上一键安装 mpv' };
    }
    const existing = await this.check({ enableAnime4K: true, anime4kPreset: this.defaultPresetId });
    if (existing.success) return { ...existing, installed: true, alreadyInstalled: true };

    const commonArgs = [
      'install', '--id', 'mpv-player.mpv-CI.MSVC', '--exact', '--silent',
      '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'
    ];
    let result = await this.runWingetInstall([...commonArgs, '--scope', 'user']);
    if (result.error) {
      // 部分 mpv 包没有 user scope 清单；winget 会直接返回“无适用安装程序”。
      result = await this.runWingetInstall(commonArgs);
    }
    if (result.error) {
      return {
        success: false,
        error: 'mpv 自动安装失败',
        repairHint: String(result.stderr || result.stdout || result.error.message || '').trim().slice(0, 1200)
      };
    }
    const check = await this.check({ enableAnime4K: true, anime4kPreset: this.defaultPresetId });
    return check.success
      ? { ...check, installed: true }
      : {
        success: false,
        error: '安装已完成，但暂未找到 mpv；请重启应用后再检测',
        repairHint: String(result.stdout || '').trim().slice(0, 1200)
      };
  }

  // ===== 参数构造 =====

  splitShaderPaths(value) {
    if (Array.isArray(value)) {
      return value.map(normalizePath).filter(Boolean);
    }
    return String(value || '')
      .split(/\r?\n|;/)
      .map(normalizePath)
      .filter(Boolean);
  }

  /**
   * 构造 mpv 启动参数
   * @param {Object} options
   *   - url: 播放地址
   *   - title: 窗口标题
   *   - referer / userAgent / headers: 来源信息（来自 PlaybackResolverService）
   *   - startPosition: 起始播放秒数（同步进度）
   *   - enableAnime4K: 是否加载 shader
   *   - anime4kShaderPaths: shader 路径列表（\n 或 ; 分隔）
   *   - presetId: 预设 ID（light/balanced/quality）
   */
  buildArgs(options = {}) {
    const url = String(options.url || '').trim();
    if (!/^https?:\/\//i.test(url) && !/^file:\/\//i.test(url)) {
      throw new Error('播放地址无效');
    }

    const title = String(options.title || 'SAKURAFALL').trim();
    const referer = String(options.referer || options.headers?.Referer || DEFAULT_REFERER).trim();
    const userAgent = String(options.userAgent || options.headers?.['User-Agent'] || DEFAULT_UA).trim();
    const preset = this.getPreset(options.presetId || options.anime4kPreset);
    const shaderSelection = options.shaderSelection || this.resolveShaderSelection(options);

    const args = [
      '--force-window=yes',
      `--title=${title}`,
      '--video-sync=' + preset.mpvArgs['video-sync'],
      '--scale=' + preset.mpvArgs.scale,
      '--cscale=' + preset.mpvArgs.cscale,
      '--hwdec=auto-safe',
      '--cache=yes',
      '--cache-secs=' + preset.mpvArgs['cache-secs'],
      '--cache-pause=yes',
      '--cache-pause-wait=' + preset.mpvArgs['cache-pause-wait'],
      '--demuxer-max-bytes=' + preset.mpvArgs['demuxer-max-bytes'],
      '--demuxer-max-back-bytes=64MiB',
      `--user-agent=${userAgent}`
    ];

    if (preset.mpvArgs.interpolation) {
      args.push('--interpolation=yes', '--tscale=oversample');
    }

    if (preset.mpvArgs.profile) {
      args.push('--profile=' + preset.mpvArgs.profile);
    }

    if (referer) {
      args.push(`--referrer=${referer}`);
    }

    // 起始播放进度（同步当前播放位置）
    const startPos = parseFloat(options.startPosition);
    if (Number.isFinite(startPos) && startPos > 0) {
      args.push(`--start=${startPos.toFixed(1)}`);
    }

    // Anime4K shader
    if (shaderSelection.enabled) {
      shaderSelection.paths.forEach(shaderPath => {
        args.push(`--glsl-shader=${shaderPath}`);
      });
    }

    args.push(url);
    return args;
  }

  // ===== 启动 mpv =====

  /**
   * 启动 mpv 播放
   * @returns {Promise<{ success: boolean, path?: string, error?: string, repairHint?: string }>}
   */
  async open(options = {}) {
    try {
      const availability = await this.check(options);
      if (!availability.success) return availability;
      const command = availability.path;
      const shaderSelection = this.resolveShaderSelection(options);
      if (shaderSelection.source === 'custom' && shaderSelection.paths.length === 0 && shaderSelection.missing.length > 0) {
        return {
          success: false,
          path: command,
          error: '配置的 Anime4K shader 文件不存在',
          repairHint: shaderSelection.missing.join('\n')
        };
      }
      const args = this.buildArgs({ ...options, shaderSelection });

      return await new Promise((resolve) => {
        let settled = false;
        let launched = false;
        const child = spawn(command, args, {
          detached: true,
          stdio: 'ignore',
          windowsHide: false
        });

        child.once('error', (error) => {
          if (settled) return;
          settled = true;
          const classified = this._classifyOpenError(error, command, options);
          resolve(classified);
        });

        child.once('spawn', () => {
          launched = true;
          child.unref();
          setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve({
              success: true,
              path: command,
              pid: child.pid,
              presetId: options.presetId || options.anime4kPreset || this.defaultPresetId,
              enhancementMode: shaderSelection.paths.length > 0 ? 'anime4k' : 'mpv-scaling',
              shaderCount: shaderSelection.paths.length,
              warnings: shaderSelection.missing.length > 0
                ? [`${shaderSelection.missing.length} 个 shader 文件未找到`]
                : []
            });
          }, 900);
        });

        child.once('exit', (code) => {
          if (settled || !launched) return;
          settled = true;
          resolve({
            success: false,
            path: command,
            error: `mpv 启动后立即退出（退出码 ${code ?? '未知'}）`,
            repairHint: '请检查视频地址、网络分流以及 mpv 配置'
          });
        });
      });
    } catch (error) {
      safeError('[EnhancedPlayer] 启动失败:', error);
      return this._classifyOpenError(error, this.findMpvExecutable(options.mpvPath), options);
    }
  }

  /**
   * 分类启动失败，给出修复建议
   */
  _classifyOpenError(error, command, options = {}) {
    const code = error?.code || '';
    const message = error?.message || '未知错误';

    if (code === 'ENOENT' || /ENOENT/i.test(message)) {
      return {
        success: false,
        path: command,
        error: '未找到 mpv，请安装 mpv 或在设置中选择 mpv.exe',
        repairHint: '修复步骤：\n1. 从 https://mpv.io/installation/ 下载 mpv\n2. 在「设置 → 增强播放器」点击「选择」指定 mpv.exe 路径\n3. 点击「检测」确认可用'
      };
    }

    if (code === 'EACCES' || /EACCES|permission/i.test(message)) {
      return {
        success: false,
        path: command,
        error: '无法执行 mpv（权限不足）',
        repairHint: '请检查 mpv.exe 是否有可执行权限，或以管理员身份运行本应用'
      };
    }

    // shader 路径无效提示
    if (options.enableAnime4K && options.anime4kShaderPaths) {
      const shaderPaths = this.splitShaderPaths(options.anime4kShaderPaths);
      const missing = shaderPaths.filter(p => !fs.existsSync(p));
      if (missing.length > 0) {
        return {
          success: false,
          path: command,
          error: message,
          repairHint: `部分 shader 文件不存在：\n${missing.join('\n')}\n\n请到「设置 → Shader 文件」修正路径，或关闭 Anime4K 增强。`
        };
      }
    }

    return {
      success: false,
      path: command,
      error: message,
      repairHint: '请检查 mpv 配置或重试'
    };
  }
}

module.exports = new EnhancedPlayerService();
