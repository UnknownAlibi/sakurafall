// IPC 安全边界守卫
// 运行: node --test tests/ipc-security.test.mjs
//
// 背景：主进程所有 IPC 通道都必须经过 secureIpcHandle（校验调用方是否为可信渲染页）。
// 2026-08-30 评审发现 src/main/ipc/bt.js 有 8 个通道直接用裸 ipcMain.handle 注册，
// 绕过了这层校验。这里用静态断言把该约束固化下来，防止以后再漏。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pathGuards from '../src/main/utils/pathGuards.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IPC_DIR = path.join(root, 'src/main/ipc');

test('ipc 模块一律使用注入的 handle，不得直连 ipcMain.handle', () => {
  const files = fs.readdirSync(IPC_DIR).filter(name => name.endsWith('.js'));
  assert.ok(files.length > 0, '至少应存在一个 ipc 模块');
  for (const name of files) {
    const source = fs.readFileSync(path.join(IPC_DIR, name), 'utf8');
    // 允许在注释里提到 ipcMain.handle；只拦截真实的调用（handle 后紧跟左括号）
    const offenders = source
      .split(/\r?\n/)
      .map((line, i) => ({ line, no: i + 1 }))
      .filter(({ line }) => /ipcMain\.handle\(/.test(line) && !/^\s*(\/\/|\*)/.test(line));
    assert.deepStrictEqual(
      offenders.map(o => `${name}:${o.no}`),
      [],
      'ipc 模块出现裸 ipcMain.handle，会绕过可信来源校验；请改为注入的 handle'
    );
  }
});

test('主进程入口同样不得直连 ipcMain.handle（只允许经 secureIpcHandle 绑定）', () => {
  const source = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8');
  const offenders = source
    .split(/\r?\n/)
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => /ipcMain\.handle\(/.test(line) && !/^\s*(\/\/|\*)/.test(line));
  assert.deepStrictEqual(offenders.map(o => `index.js:${o.no}`), []);
  // 唯一的桥接点：把 ipcMain.handle 绑成 registerIpcHandler 交给 secureIpcHandle
  assert.match(source, /ipcMain\.handle\.bind\(ipcMain\)/, 'secureIpcHandle 应基于 registerIpcHandler 实现');
});

test('BT 相关通道注入的是 secureIpcHandle 而非裸 ipcMain', () => {
  const source = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8');
  const call = source.match(/registerBtIpc\(\{[\s\S]*?\}\)/);
  assert.ok(call, '未找到 registerBtIpc 调用');
  assert.match(call[0], /handle:\s*secureIpcHandle/, 'registerBtIpc 必须注入 secureIpcHandle');
  assert.doesNotMatch(call[0], /\bipcMain\b/, '不应再注入裸 ipcMain');
});

test('IPC 通道名唯一：拆分过程中不得重复注册或漏删旧块', () => {
  const files = [
    'src/main/index.js',
    ...fs.readdirSync(IPC_DIR).filter(name => name.endsWith('.js')).map(name => `src/main/ipc/${name}`)
  ];
  const owners = new Map();
  const duplicates = [];
  for (const rel of files) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const match of source.matchAll(/(?:secureIpcHandle|handle)\(\s*'([^']+)'/g)) {
      const channel = match[1];
      if (owners.has(channel)) duplicates.push(`${channel}（${owners.get(channel)} + ${rel}）`);
      else owners.set(channel, rel);
    }
  }
  assert.ok(owners.size >= 150, `识别到的通道数偏少（${owners.size}），拆分时可能漏注册`);
  assert.deepStrictEqual(duplicates, [], '存在重复注册的 IPC 通道');
});

test('默认 session 显式设置权限请求与检查处理器', () => {
  const source = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8');
  assert.match(source, /setPermissionRequestHandler/, '必须显式拒绝未使用的 Web 权限');
  assert.match(source, /setPermissionCheckHandler/, '权限检查路径也必须显式处理');
  assert.match(source, /clipboard-sanitized-write/, '复制到剪贴板是现有功能，需要放行');
});

test('IPC 路径守卫：下载目录、mpv 路径与图片扩展名都有边界', () => {
  const downloadRoot = path.join(root, 'tmp-download-root');
  assert.equal(pathGuards.isPathInside(downloadRoot, downloadRoot), true);
  assert.equal(pathGuards.isPathInside(downloadRoot, path.join(downloadRoot, 'episode.mp4')), true);
  assert.equal(pathGuards.isPathInside(downloadRoot, path.join(downloadRoot, '..', 'evil.exe')), false);
  assert.equal(pathGuards.isPathInside(downloadRoot, `${downloadRoot}2/evil.exe`), false);

  assert.equal(pathGuards.isMpvExecutablePath(path.join(downloadRoot, 'mpv.exe')), true);
  assert.equal(pathGuards.isMpvExecutablePath(path.join(downloadRoot, 'mpvnet.exe')), true);
  assert.equal(pathGuards.isMpvExecutablePath(path.join(downloadRoot, 'mpv-x86_64.exe')), true);
  assert.equal(pathGuards.isMpvExecutablePath(path.join(downloadRoot, 'cmd.exe')), false);
  assert.equal(pathGuards.isMpvExecutablePath('mpv.exe'), false, '相对路径不应被接受');

  assert.equal(pathGuards.isSupportedImagePath(path.join(downloadRoot, 'cover.JPG')), true);
  assert.equal(pathGuards.isSupportedImagePath(path.join(downloadRoot, 'notes.exe')), false);
});
