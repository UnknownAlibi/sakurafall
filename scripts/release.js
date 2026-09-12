#!/usr/bin/env node
/**
 * SakuraFall 一键发版脚本
 *
 * 用法:
 *   npm run release [-- --notes "更新说明" | --notes-file NOTES.md]
 *                   [--min-required 1.0.0] [--skip-build] [--skip-server]
 *
 * 流程:
 *   1. (可选) npm run build 打出安装包 dist-app/SakuraFall-Setup-{version}.exe
 *   2. 在 UnknownAlibi/sakurafall (主仓库) 创建 GitHub Release v{version} 并上传安装包
 *   3. 更新主仓库 main 分支的 latest.json (version/downloadUrl/releaseNotes/...)
 *      → 客户端「设置 → 检查更新」读取该文件提示新版本
 *   4. 同步安装包 + latest.json 到阿里云服务器（客户端更新源优先走服务器，
 *      大陆访问国内节点快且稳；服务器 latest.json 的 downloadUrl 也指向服务器自身）
 *
 * 依赖: gh CLI 已登录 (gh auth status), 远程可访问。
 *       第 4 步需 SSH 别名 sakurafall 可用；失败仅告警不中断（可 --skip-server 跳过）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RELEASES_REPO = 'UnknownAlibi/sakurafall';
const INSTALLER_GLOB_PREFIX = 'SakuraFall-Setup-';
const GITHUB_BASE = 'https://github.com';
// 阿里云更新源（客户端更新源优先走服务器，见 server/OPERATIONS.md）
const SERVER_SSH_ALIAS = 'sakurafall';
const SERVER_RELEASE_DIR = '/var/lib/sakurafall/releases';
const SERVER_PUBLIC_BASE = 'https://47.109.87.3:8443';

// 流式计算安装包 sha256（安装包可达上百 MB，不整体读入内存）
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function parseArgs(argv) {  const args = { notes: '', notesFile: '', minRequired: '', skipBuild: false, skipServer: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--notes': args.notes = argv[++i] || ''; break;
      case '--notes-file': args.notesFile = argv[++i] || ''; break;
      case '--min-required': args.minRequired = argv[++i] || ''; break;
      case '--skip-build': args.skipBuild = true; break;
      case '--skip-server': args.skipServer = true; break;
      default: break;
    }
  }
  return args;
}

function sh(cmd, opts = {}) {
  // 需要实时进度的命令（scp 上传等）传 stdio: 'inherit'，此时 execSync 返回 null
  const result = execSync(cmd, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...opts });
  return result === null ? '' : result.toString().trim();
}

function requireGh() {
  try {
    sh('gh --version');
  } catch (e) {
    console.error('[release] 未找到 gh CLI，请安装: https://cli.github.com/');
    process.exit(1);
  }
  try {
    sh('gh auth status -h github.com');
  } catch (e) {
    console.error('[release] gh 未登录，请先运行: gh auth login');
    process.exit(1);
  }
}

function findInstaller(version) {
  const distDir = path.join(process.cwd(), 'dist-app');
  const exact = path.join(distDir, `${INSTALLER_GLOB_PREFIX}${version}.exe`);
  if (fs.existsSync(exact)) return exact;
  // 兜底：按前缀找最新的 Setup exe
  if (fs.existsSync(distDir)) {
    const candidates = fs.readdirSync(distDir)
      .filter(f => f.startsWith(INSTALLER_GLOB_PREFIX) && f.endsWith('.exe'))
      .map(f => path.join(distDir, f));
    if (candidates.length === 1) {
      console.warn(`[release] 未找到 ${path.basename(exact)}，将使用唯一候选: ${path.basename(candidates[0])}`);
      return candidates[0];
    }
  }
  return null;
}

function releaseExists(tag) {
  try {
    sh(`gh release view "${tag}" --repo ${RELEASES_REPO}`);
    return true;
  } catch (e) {
    return false;
  }
}

function uploadRelease(version, installerPath, notes) {
  const tag = `v${version}`;
  const name = path.basename(installerPath);
  if (releaseExists(tag)) {
    console.log(`[release] Release ${tag} 已存在，覆盖上传资产`);
    sh(`gh release upload "${tag}" "${installerPath}" --clobber --repo ${RELEASES_REPO}`);
  } else {
    const notesArg = notes ? `--notes "${notes.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"` : '--generate-notes';
    sh(`gh release create "${tag}" "${installerPath}" --title "SakuraFall ${tag}" ${notesArg} --repo ${RELEASES_REPO}`);
  }
  return `${GITHUB_BASE}/${RELEASES_REPO}/releases/download/${tag}/${encodeURIComponent(name)}`;
}

function updateLatestJson(version, downloadUrl, notes, releaseDate, minRequired, sha256) {
  const latest = {
    version,
    downloadUrl,
    ...(sha256 ? { sha256 } : {}),
    releaseNotes: notes,
    releaseDate,
    ...(minRequired ? { minRequiredVersion: minRequired } : {})
  };
  const content = Buffer.from(JSON.stringify(latest, null, 2) + '\n', 'utf8').toString('base64');
  const message = `release ${version}`;
  // 已存在则带 sha 更新，否则直接创建
  let sha = '';
  try {
    const info = sh(`gh api "repos/${RELEASES_REPO}/contents/latest.json" --jq .sha`);
    sha = info;
  } catch (e) { /* 不存在，首次创建 */ }
  const shaArg = sha ? `-f sha=${sha}` : '';
  sh(`gh api "repos/${RELEASES_REPO}/contents/latest.json" -X PUT -f message="${message}" -f content="${content}" ${shaArg}`);
  return latest;
}

/**
 * 同步更新产物到阿里云服务器：安装包 + latest.json（downloadUrl 指向服务器自身下载路由）。
 * 服务器是客户端的优先更新源，漏同步会导致客户端检测不到新版本（1.4.0 发布时的实际教训）。
 * 失败仅告警不中断发布——GitHub 更新源仍然可用。
 */
function syncToServer(version, installerPath, notes, releaseDate, minRequired, sha256) {
  const serverLatest = {
    version,
    downloadUrl: `${SERVER_PUBLIC_BASE}/downloads/${path.basename(installerPath)}`,
    ...(sha256 ? { sha256 } : {}),
    releaseNotes: notes,
    releaseDate,
    ...(minRequired ? { minRequiredVersion: minRequired } : {})
  };
  // 写到本地临时文件再 scp，避免 shell 转义破坏 JSON 内容
  const tmpLatest = path.join(path.dirname(installerPath), 'latest.json');
  fs.writeFileSync(tmpLatest, JSON.stringify(serverLatest, null, 2) + '\n', 'utf8');

  const remote = `${SERVER_SSH_ALIAS}:${SERVER_RELEASE_DIR}`;
  console.log(`[release] 同步安装包与 latest.json 到 ${SERVER_SSH_ALIAS} ...`);
  sh(`scp "${installerPath}" "${remote}/${path.basename(installerPath)}"`, { stdio: 'inherit' });
  sh(`scp "${tmpLatest}" "${remote}/latest.json"`, { stdio: 'inherit' });

  // 公网验证：latest.json 版本与安装包 HEAD 请求
  // 注意不能重定向到 /dev/null（Windows 无此路径）；sh() 会捕获 stdout
  const manifest = JSON.parse(
    sh(`curl -fsS --max-time 15 "${SERVER_PUBLIC_BASE}/updates/latest.json?v=${Date.now()}"`)
  );
  if (manifest.version !== version) {
    throw new Error(`服务器 latest.json 版本不符（期望 ${version}，实际 ${manifest.version}），可能被 CDN/缓存延迟`);
  }
  sh(`curl -fsSI --max-time 20 "${serverLatest.downloadUrl}"`);
  return serverLatest;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // npm run 会吞掉 -- 后的部分参数（v7+ 行为不一致），支持环境变量兜底传 notes
  if (!args.notes && process.env.RELEASE_NOTES) args.notes = process.env.RELEASE_NOTES;
  requireGh();

  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  const version = pkg.version;

  if (!args.notes && !args.notesFile) {
    const defaultNotes = path.join(process.cwd(), 'docs', `release-notes-${version}.md`);
    if (fs.existsSync(defaultNotes)) args.notesFile = defaultNotes;
  }

  if (args.notesFile) {
    args.notes = fs.readFileSync(path.resolve(args.notesFile), 'utf8').trim();
  }

  if (!args.skipBuild) {
    console.log(`[release] 1/4 构建版本 ${version} ...`);
    execSync('npm run build', { stdio: 'inherit' });
  } else {
    console.log('[release] 跳过构建 (--skip-build)');
  }

  const installer = findInstaller(version);
  if (!installer) {
    console.error(`[release] 未找到安装包 dist-app/${INSTALLER_GLOB_PREFIX}${version}.exe`);
    console.error('        请先 npm run build，或确认 package.json version 与产物一致');
    process.exit(1);
  }

  console.log(`[release] 2/4 上传 ${path.basename(installer)} 到 ${RELEASES_REPO} ...`);
  const downloadUrl = uploadRelease(version, installer, args.notes);

  // 安装包摘要：写入所有 latest.json（GitHub 源 / 服务器源 / 仓库内回退源），
  // 客户端下载后会强制比对，避免下载链路被篡改或文件损坏被静默安装。
  const sha256 = await sha256File(installer);
  console.log(`[release] 安装包 sha256: ${sha256}`);

  console.log('[release] 3/4 更新 latest.json 更新源 ...');
  const releaseDate = new Date().toISOString().slice(0, 10);
  const latest = updateLatestJson(version, downloadUrl, args.notes, releaseDate, args.minRequired, sha256);
  // 仓库内的 latest.json 是 GitHub 回退更新源（raw.githubusercontent.com/.../main/latest.json），
  // 一并刷新，避免它长期停在旧版本、且缺少 sha256。
  try {
    fs.writeFileSync(path.join(ROOT, 'latest.json'), JSON.stringify(latest, null, 2) + '\n', 'utf8');
    console.log('[release] 已同步仓库内 latest.json（回退更新源）');
  } catch (e) {
    console.warn(`[release] 写入仓库内 latest.json 失败: ${e.message}`);
  }

  let serverLatest = null;
  if (args.skipServer) {
    console.log('[release] 跳过服务器同步 (--skip-server)');
  } else {
    console.log('[release] 4/4 同步阿里云更新源 ...');
    try {
      serverLatest = syncToServer(version, installer, args.notes, releaseDate, args.minRequired, sha256);
    } catch (e) {
      console.warn(`[release] 服务器同步失败（GitHub 更新源仍可用）: ${e.message}`);
      console.warn(`        可稍后手动执行: scp dist-app/${path.basename(installer)} ${SERVER_SSH_ALIAS}:${SERVER_RELEASE_DIR}/`);
    }
  }

  console.log('\n[release] 发布完成 ✓');
  console.log(`  版本:      ${version}`);
  console.log(`  下载直链:  ${downloadUrl}`);
  console.log(`  更新源:    https://raw.githubusercontent.com/${RELEASES_REPO}/main/latest.json`);
  if (serverLatest) {
    console.log(`  服务器源:  ${SERVER_PUBLIC_BASE}/updates/latest.json`);
    console.log(`  服务器包:  ${serverLatest.downloadUrl}`);
  }
  console.log(`  更新内容:  ${latest.releaseNotes || '(未填写)'}`);
}

main().catch(err => {
  console.error('[release] 失败:', err.message);
  process.exit(1);
});
