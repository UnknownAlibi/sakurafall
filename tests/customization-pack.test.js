const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  CustomizationPackService,
  SOURCE_PACK_KIND,
  THEME_PACK_KIND
} = require('../src/main/services/CustomizationPackService');

function createService() {
  const calls = { cms: null, xpath: null };
  const service = new CustomizationPackService({
    cmsApiService: {
      importSources(json) {
        calls.cms = JSON.parse(json);
        return { success: true, added: 1, overwritten: 0, skipped: 0, errors: [] };
      },
      exportSources() {
        return { success: true, json: JSON.stringify({ sources: [{ id: 'cms', name: 'CMS', api: 'https://example.com' }] }) };
      }
    },
    sourcePluginManager: {
      importRules(json) {
        calls.xpath = JSON.parse(json);
        return { success: true, added: 1, overwritten: 0, skipped: 0, errors: [] };
      },
      exportRules() {
        return { success: true, json: JSON.stringify({ rules: [{ id: 'xpath' }] }) };
      }
    }
  });
  return { service, calls };
}

test('source pack imports CMS sources and XPath rules together', () => {
  const { service, calls } = createService();
  const result = service.importSourcePack(JSON.stringify({
    kind: SOURCE_PACK_KIND,
    apiVersion: 1,
    metadata: { id: 'author.sources', name: 'Sources' },
    content: {
      cmsSources: [{ id: 'cms', name: 'CMS', api: 'https://example.com' }],
      xpathRules: [{ id: 'xpath' }]
    }
  }));

  assert.equal(result.success, true);
  assert.equal(calls.cms.sources[0].id, 'cms');
  assert.equal(calls.xpath.rules[0].id, 'xpath');
});

test('source pack export uses the versioned shareable format', () => {
  const { service } = createService();
  const result = service.exportSourcePack({ id: 'author.backup', name: 'Backup' });
  assert.equal(result.pack.kind, SOURCE_PACK_KIND);
  assert.equal(result.pack.apiVersion, 1);
  assert.equal(result.pack.content.cmsSources.length, 1);
  assert.equal(result.pack.content.xpathRules.length, 1);
});

test('theme pack removes remote and Electron-sensitive CSS', () => {
  const { service } = createService();
  const pack = service.validateThemePack(JSON.stringify({
    kind: THEME_PACK_KIND,
    apiVersion: 1,
    metadata: { id: 'author.theme', name: 'Theme' },
    content: {
      variables: {
        '--primary-color': '#f06',
        '--unsafe-image': 'url(https://tracker.invalid/pixel)'
      },
      customCss: '@import "https://tracker.invalid/a.css"; .x { background:url(a); -webkit-app-region: drag; color:red; }'
    }
  }));

  assert.equal(pack.content.variables['--primary-color'], '#f06');
  assert.equal(pack.content.variables['--unsafe-image'], undefined);
  assert.doesNotMatch(pack.content.customCss, /@import|url\s*\(|-webkit-app-region/i);
  assert.match(pack.content.customCss, /color:red/);
});

test('installed user themes override built-in themes with the same id', () => {
  const { service } = createService();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-theme-'));
  const builtIn = path.join(root, 'built-in');
  const user = path.join(root, 'user');
  fs.mkdirSync(builtIn, { recursive: true });
  service.setThemePaths({ builtInThemeDir: builtIn, userThemeDir: user });

  const makePack = (name) => ({
    kind: THEME_PACK_KIND,
    apiVersion: 1,
    metadata: { id: 'same.theme', name },
    content: { variables: {}, customCss: '' }
  });
  fs.writeFileSync(path.join(builtIn, 'theme.json'), JSON.stringify(makePack('Built in')));
  service.installThemePack(JSON.stringify(makePack('User')));

  assert.equal(service.listThemePacks().find(pack => pack.id === 'same.theme').name, 'User');
  assert.equal(service.getThemePack('same.theme').metadata.name, 'User');
  fs.rmSync(root, { recursive: true, force: true });
});

test('theme packs accept safe branded asset slots and layout presets', () => {
  const { service } = createService();
  const image = `data:image/png;base64,${Buffer.from('theme-image').toString('base64')}`;
  const pack = service.validateThemePack(JSON.stringify({
    kind: THEME_PACK_KIND,
    apiVersion: 1,
    metadata: { id: 'author.brand', name: 'Brand Theme' },
    content: {
      variables: {},
      assets: { brandMark: image, cursorDefault: image, unsupported: image },
      layout: { density: 'compact', cardStyle: 'manga', navigation: 'rail', motion: 'balanced' }
    }
  }));

  assert.equal(pack.content.assets.brandMark, image);
  assert.equal(pack.content.assets.cursorDefault, image);
  assert.equal(pack.content.assets.unsupported, undefined);
  assert.equal(pack.content.layout.density, 'compact');
});

test('imported source packs are installed as independent user artifacts', () => {
  const { service } = createService();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-sources-'));
  const builtIn = path.join(root, 'built-in');
  const user = path.join(root, 'user');
  fs.mkdirSync(builtIn, { recursive: true });
  service.setSourcePaths({ builtInSourceDir: builtIn, userSourceDir: user });

  const pack = {
    kind: SOURCE_PACK_KIND,
    apiVersion: 1,
    metadata: { id: 'author.sources', name: 'Sources', updateUrl: 'https://example.com/sources.json' },
    content: { cmsSources: [{ id: 'cms', name: 'CMS', api: 'https://example.com' }], xpathRules: [] }
  };
  const result = service.importSourcePack(JSON.stringify(pack));
  assert.equal(result.installed, true);
  assert.equal(service.listSourcePacks()[0].id, 'author.sources');
  assert.equal(service.listSourcePacks()[0].updateUrl, pack.metadata.updateUrl);
  fs.rmSync(root, { recursive: true, force: true });
});

test('core starts with no sources and activates external source-pack artifacts', () => {
  const activated = { cms: null, xpath: null, resolvers: null };
  const service = new CustomizationPackService({
    cmsApiService: { setPackSources: sources => { activated.cms = sources; } },
    sourcePluginManager: {
      ruleEngine: { validateRule: raw => ({ valid: true, rule: raw }) },
      setPackRules: rules => { activated.xpath = rules; }
    },
    sharePageResolver: { setResolvers: rules => { activated.resolvers = rules; } }
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-empty-core-'));
  const builtIn = path.join(root, 'bundled');
  const user = path.join(root, 'user');
  fs.mkdirSync(builtIn, { recursive: true });

  const empty = service.setSourcePaths({ builtInSourceDir: builtIn, userSourceDir: user });
  assert.equal(empty.packCount, 0);
  assert.deepEqual(activated.cms, []);
  assert.deepEqual(activated.xpath, []);
  assert.deepEqual(activated.resolvers, []);

  const pack = {
    kind: SOURCE_PACK_KIND,
    apiVersion: 1,
    metadata: { id: 'author.external', name: 'External' },
    content: {
      cmsSources: [{ id: 'cms', name: 'CMS', api: 'https://api.example.com' }],
      xpathRules: [],
      resolvers: [{ id: 'author.share', hosts: ['share.example.com'], pathPrefixes: ['/share/'] }]
    }
  };
  const installed = service.importSourcePack(JSON.stringify(pack));
  assert.equal(installed.success, true);
  assert.equal(activated.cms[0].sourcePackId, 'author.external');
  assert.equal(activated.resolvers[0].sourcePackId, 'author.external');
  fs.rmSync(root, { recursive: true, force: true });
});

test('built-in theme assets are loaded from sidecar files while user packs stay single-file', () => {
  const { service } = createService();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-theme-assets-'));
  const builtIn = path.join(root, 'built-in');
  fs.mkdirSync(path.join(builtIn, 'theme', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(builtIn, 'theme', 'assets', 'mark.png'), Buffer.from('png-bytes'));
  fs.writeFileSync(path.join(builtIn, 'theme.json'), JSON.stringify({
    kind: THEME_PACK_KIND,
    apiVersion: 1,
    metadata: { id: 'sidecar.theme', name: 'Sidecar' },
    content: {
      variables: {},
      assets: {},
      assetFiles: { brandMark: 'theme/assets/mark.png' },
      customCss: ''
    }
  }));
  service.setThemePaths({ builtInThemeDir: builtIn, userThemeDir: path.join(root, 'user') });

  const pack = service.getThemePack('sidecar.theme');
  assert.match(pack.content.assets.brandMark, /^data:image\/png;base64,/);
  assert.equal(pack.content.assetFiles, undefined);
  fs.rmSync(root, { recursive: true, force: true });
});
