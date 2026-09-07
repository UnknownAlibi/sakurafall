const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { linearSlope, summarizeByRole } = require('../scripts/audit-process-tree');

test('process audit summaries preserve per-role memory ownership', () => {
  assert.deepEqual(summarizeByRole([
    { role: 'renderer', workingSetMB: 10.125, privateMB: 5, cpuSeconds: 0.25 },
    { role: 'renderer', workingSetMB: 2.125, privateMB: 1.5, cpuSeconds: 0.1 },
    { role: 'gpu', workingSetMB: 20, privateMB: 12, cpuSeconds: 1 }
  ]), {
    renderer: { count: 2, workingSetMB: 12.25, privateMB: 6.5, cpuSeconds: 0.35 },
    gpu: { count: 1, workingSetMB: 20, privateMB: 12, cpuSeconds: 1 }
  });
});

test('memory audit slope distinguishes stable and accumulating tails', () => {
  assert.equal(linearSlope([100, 100, 100, 100, 100]), 0);
  assert.equal(linearSlope([10, 20, 30, 40, 50]), 10);
  assert.equal(linearSlope([50, 40, 30, 20, 10]), -10);
});

test('process audit scopes discovery and termination to its owned launch', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/audit-process-tree.js'), 'utf8');
  assert.match(source, /ProcessId -eq \$rootPid/);
  assert.match(source, /CommandLine\.Contains\(\$marker\)/);
  assert.match(source, /ParentProcessId/);
  assert.doesNotMatch(source, /ExecutablePath -eq \$targetPath \}\s*\|\s*ForEach-Object \{ Stop-Process/);
});
