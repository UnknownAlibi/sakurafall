#!/usr/bin/env node
/**
 * SakuraFall 一键发版脚本
 *
 * 用法:
 *   npm run release [-- --notes "更新说明" | --notes-file NOTES.md]
 *                   [--min-required 1.0.0] [--skip-build]
 *
 * 流程:
 *   1. (可选) npm run build 打出安装包 dist-app/SakuraFall-Setup-{version}.exe
 *   2. 在 UnknownAlibi/sakurafall (主仓库) 创建 GitHub Release v{version} 并上传安装包
 *   3. 更新主仓库 main 分支的 latest.json (version/downloadUrl/releaseNotes/...)
 *      → 客户端「设置 → 检查更新」读取该文件提示新版本
 *
 * 依赖: gh CLI 已登录 (gh auth status), 远程可访问。
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RELEASES_REPO = 'UnknownAlibi/sakurafall';
const INSTALLER_GLOB_PREFIX = 'SakuraFall-Setup-';
const GITHUB_BASE = 'https://github.com';

function parseArgs(argv) {
  const args = { notes: '', notesFile: '', minRequired: '', skipBuild: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--notes': args.notes = argv[++i] || ''; break;
      case '--notes-file': args.notesFile = argv[++i] || ''; break;
      case '--min-required': args.minRequired = argv[++i] || ''; break;
      case '--skip-build': args.skipBuild = true; break;
      default: break;
    }
  }
  return args;
}

function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...opts }).toString().trim();
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

function updateLatestJson(version, downloadUrl, notes, releaseDate, minRequired) {
  const latest = {
    version,
    downloadUrl,
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  requireGh();

  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  const version = pkg.version;

  if (args.notesFile) {
    args.notes = fs.readFileSync(path.resolve(args.notesFile), 'utf8').trim();
  }

  if (!args.skipBuild) {
    console.log(`[release] 1/3 构建版本 ${version} ...`);
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

  console.log(`[release] 2/3 上传 ${path.basename(installer)} 到 ${RELEASES_REPO} ...`);
  const downloadUrl = uploadRelease(version, installer, args.notes);

  console.log('[release] 3/3 更新 latest.json 更新源 ...');
  const releaseDate = new Date().toISOString().slice(0, 10);
  const latest = updateLatestJson(version, downloadUrl, args.notes, releaseDate, args.minRequired);

  console.log('\n[release] 发布完成 ✓');
  console.log(`  版本:      ${version}`);
  console.log(`  下载直链:  ${downloadUrl}`);
  console.log(`  更新源:    https://raw.githubusercontent.com/${RELEASES_REPO}/main/latest.json`);
  console.log(`  更新内容:  ${latest.releaseNotes || '(未填写)'}`);
}

main().catch(err => {
  console.error('[release] 失败:', err.message);
  process.exit(1);
});
