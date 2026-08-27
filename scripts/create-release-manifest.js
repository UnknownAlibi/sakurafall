const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const workspace = path.resolve(__dirname, '..');
const outputDir = path.join(workspace, 'dist-app');
const packageJson = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'));

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

const artifacts = fs.readdirSync(outputDir)
  .filter(name => /\.(exe|blockmap)$/i.test(name))
  .sort()
  .map(name => {
    const filePath = path.join(outputDir, name);
    return { name, size: fs.statSync(filePath).size, sha256: sha256(filePath) };
  });

if (!artifacts.some(item => /Setup.*\.exe$/i.test(item.name))) {
  console.error('[release] NSIS installer was not produced');
  process.exit(1);
}

const manifest = {
  product: 'SakuraFall',
  version: packageJson.version,
  generatedAt: new Date().toISOString(),
  platform: 'win32-x64',
  signed: false,
  artifacts
};

fs.writeFileSync(path.join(outputDir, 'release-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(`[release] manifest created for ${artifacts.length} artifacts`);
