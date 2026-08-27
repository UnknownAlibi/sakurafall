import test from 'node:test';
import assert from 'node:assert/strict';

test('theme runtime keeps high-resolution cursor art and normalizes native cursor fallbacks', async () => {
  const values = new Map();
  const attributes = new Map();
  const styleElement = { id: '', textContent: '' };
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    Image: globalThis.Image,
    CustomEvent: globalThis.CustomEvent
  };

  globalThis.document = {
    documentElement: {
      style: {
        setProperty: (key, value) => values.set(key, value),
        removeProperty: key => values.delete(key)
      },
      setAttribute: (key, value) => attributes.set(key, value),
      removeAttribute: key => attributes.delete(key)
    },
    head: { appendChild: () => {} },
    getElementById: id => id === 'sakurafall-user-theme-css' ? styleElement : null,
    createElement: tag => {
      if (tag === 'style') return styleElement;
      if (tag !== 'canvas') throw new Error(`unexpected element: ${tag}`);
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          imageSmoothingEnabled: false,
          imageSmoothingQuality: 'low',
          clearRect: () => {},
          drawImage: () => {}
        }),
        toDataURL: () => 'data:image/png;base64,normalized-40px'
      };
    }
  };
  globalThis.window = { dispatchEvent: () => {} };
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
  globalThis.Image = class Image {
    set src(value) {
      this.value = value;
      queueMicrotask(() => this.onload?.());
    }
  };

  try {
    const { applyThemeCustomization } = await import('../src/renderer/utils/themeRuntime.js');
    const originalDefault = 'data:image/png;base64,default-128px';
    const originalPointer = 'data:image/png;base64,pointer-128px';
    const mascot = 'data:image/png;base64,mascot';
    const emptyState = 'data:image/png;base64,empty-state';
    applyThemeCustomization({
      metadata: { id: 'cursor-test' },
      content: {
        assets: { cursorDefault: originalDefault, cursorPointer: originalPointer, mascot, emptyState },
        layout: {}
      }
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(values.get('--sakura-cursor-default-image'), `url("${originalDefault}")`);
    assert.equal(values.get('--sakura-cursor-pointer-image'), `url("${originalPointer}")`);
    assert.equal(values.get('--sakurafall-character-image'), `url("${mascot}")`);
    assert.equal(values.get('--sakurafall-empty-state-image'), `url("${emptyState}")`);
    assert.equal(
      values.get('--sakura-cursor-native-default-image'),
      'url("data:image/png;base64,normalized-40px")'
    );
    assert.equal(
      values.get('--sakura-cursor-native-pointer-image'),
      'url("data:image/png;base64,normalized-40px")'
    );
    assert.equal(attributes.get('data-theme-pack'), 'cursor-test');
  } finally {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    globalThis.Image = previous.Image;
    globalThis.CustomEvent = previous.CustomEvent;
  }
});
