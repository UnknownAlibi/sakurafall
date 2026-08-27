/**
 * 全局 UI 组件单测：确认弹窗服务 + 通知堆叠上限/去重 + 全局挂载守卫
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

import confirmState, { openConfirm, settleConfirm } from '../src/renderer/services/confirmService.js';
import notificationModule from '../src/renderer/store/modules/notification.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('confirmService: 确认/取消正确 resolve，重复打开时旧的自动取消', async () => {
  // 上一次会话若残留，先清掉
  if (confirmState.visible) settleConfirm(false);

  // 确认路径
  const p1 = openConfirm({ title: '删除', message: '确认删除？', danger: true });
  assert.equal(confirmState.visible, true);
  assert.equal(confirmState.title, '删除');
  assert.equal(confirmState.danger, true);
  settleConfirm(true);
  assert.equal(await p1, true);
  assert.equal(confirmState.visible, false);

  // 取消路径（ESC / 遮罩点击同样走 settleConfirm(false)）
  const p2 = openConfirm({ title: '取消测试' });
  settleConfirm(false);
  assert.equal(await p2, false);

  // 未关闭时再次打开：旧 Promise 必须以 false 收场，不能悬挂
  const p3 = openConfirm({ title: '第一个' });
  const p4 = openConfirm({ title: '第二个' });
  assert.equal(confirmState.title, '第二个');
  assert.equal(await p3, false);
  settleConfirm(true);
  assert.equal(await p4, true);
});

test('effect presets keep the document root visible', () => {
  const mainCss = fs.readFileSync(path.join(root, 'src/renderer/assets/styles/main.css'), 'utf8');

  assert.match(mainCss, /html\[data-ui-effects\]\s*\{[\s\S]*?display:\s*block\s*!important;/);
});

test('notification: 同屏最多 5 条，超出移除最旧的', () => {
  const state = { notifications: [] };
  const add = notificationModule.mutations.ADD_NOTIFICATION;
  for (let i = 0; i < 8; i++) {
    add(state, { id: `n${i}`, title: `t${i}`, type: 'info' });
  }
  assert.equal(state.notifications.length, 5);
  // 保留的是最新的 5 条（n3..n7）
  assert.deepEqual(state.notifications.map(n => n.id), ['n3', 'n4', 'n5', 'n6', 'n7']);
});

test('notification: 短时间内完全相同的通知去重，不同内容不去重', () => {
  const state = { notifications: [] };
  const context = {
    state,
    commit(type, payload) {
      notificationModule.mutations[type](state, payload);
    }
  };
  const show = notificationModule.actions.showNotification;

  const first = show(context, { type: 'error', title: '网络错误', message: '请求超时' });
  assert.ok(first, '第一条应正常入列');
  const dup = show(context, { type: 'error', title: '网络错误', message: '请求超时' });
  assert.equal(dup, null, '重复通知应被去重');
  assert.equal(state.notifications.length, 1);

  const other = show(context, { type: 'error', title: '网络错误', message: '另一个接口超时' });
  assert.ok(other, '不同内容不去重');
  assert.equal(state.notifications.length, 2);
});

test('notification: duration <= 0 仍入列（常驻通知）', () => {
  const state = { notifications: [] };
  const context = {
    state,
    commit(type, payload) {
      notificationModule.mutations[type](state, payload);
    }
  };
  const id = notificationModule.actions.showNotification(context, {
    type: 'warning', title: '常驻', message: '不会自动关闭', duration: 0
  });
  assert.ok(id, '常驻通知应有 id');
  assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].duration, 0);
});

test('全局挂载守卫：App.vue 挂载了通知/确认/命令面板/引导组件', () => {
  const app = fs.readFileSync(path.join(root, 'src/renderer/App.vue'), 'utf8');
  assert.match(app, /<GlobalNotification \/>/, '全局通知必须在 App 挂载');
  assert.match(app, /<ConfirmDialog \/>/, '确认弹窗必须在 App 挂载');
  assert.match(app, /<CommandPalette v-if="!isPlayerWindow" \/>/, '命令面板仅主窗口挂载');
  assert.match(app, /<WelcomeOverlay v-if="!isPlayerWindow" \/>/, '首启引导仅主窗口挂载');
});

test('可达性守卫：通知容器含 aria-live，原生 confirm 已全部移除', () => {
  const gn = fs.readFileSync(path.join(root, 'src/renderer/components/Common/GlobalNotification.vue'), 'utf8');
  assert.match(gn, /aria-live="polite"/, '通知容器需 aria-live 供屏幕阅读器播报');

  // 全 renderer 不允许再出现原生 confirm（window.confirm 阻塞且不跟随主题）
  const views = ['views/Downloads.vue', 'views/SourceManager.vue'];
  for (const rel of views) {
    const src = fs.readFileSync(path.join(root, 'src/renderer', rel), 'utf8');
    // 注意排除 $confirm（主题化确认服务）：$ 不是单词字符，需显式排除避免误报
    assert.ok(!/window\.confirm|[^.\w$]confirm\(/.test(src), `${rel} 不应再使用原生 confirm`);
  }
});

test('动效档位守卫：标准演出保留完整动效，但只完整演出启用自定义鼠标', () => {
  const settings = fs.readFileSync(path.join(root, 'src/renderer/views/Settings.vue'), 'utf8');
  const mainCss = fs.readFileSync(path.join(root, 'src/renderer/assets/styles/main.css'), 'utf8');
  const kawaiiCss = fs.readFileSync(path.join(root, 'src/renderer/assets/styles/kawaii.css'), 'utf8');
  const variablesCss = fs.readFileSync(path.join(root, 'src/renderer/assets/styles/variables.css'), 'utf8');
  const cursor = fs.readFileSync(path.join(root, 'src/renderer/components/Common/AnimeCursor.vue'), 'utf8');

  assert.match(settings, /value: 'balanced', label: '标准演出'/, '中档名称应明确为标准演出');
  assert.match(settings, /保留完整界面动效，使用系统鼠标与原生手势/, '中档描述应准确说明差异');
  assert.match(mainCss, /:is\(\[data-ui-effects="anime"\], \[data-ui-effects="balanced"\]\) :where\(\s*\.anime-loading-mascot/, '加载逐帧动画应覆盖两种演出档');
  assert.match(kawaiiCss, /:is\(\[data-ui-effects="anime"\], \[data-ui-effects="balanced"\]\) \.tab-navigation::before/, '氛围动画应覆盖两种演出档');
  assert.doesNotMatch(variablesCss, /\[data-ui-effects="balanced"\][^{]*\{[^}]*--sakura-mascot-image/, '标准演出不能强制使用静态看板娘');
  assert.match(cursor, /this\.enabled = effectsMode === 'anime'/, '自定义鼠标必须只在完整演出启用');
});

test('纯净模式守卫：禁用路由过渡但不能用全局选择器隐藏应用内容', () => {
  const app = fs.readFileSync(path.join(root, 'src/renderer/App.vue'), 'utf8');
  const mainCss = fs.readFileSync(path.join(root, 'src/renderer/assets/styles/main.css'), 'utf8');

  assert.match(app, /this\.uiEffectsMode !== 'performance'/, '纯净模式应从 Vue 层关闭路由过渡');
  assert.match(app, /page-forward-enter-from[\s\S]*?opacity: 1 !important;[\s\S]*?transform: none !important;/, '切档时应清理残留的透明过渡状态');
  assert.doesNotMatch(mainCss, /\[data-ui-effects="performance"\]\s+\*[,{]/, '纯净模式不能覆盖全部组件的过渡生命周期');
});
