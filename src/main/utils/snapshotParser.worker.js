const { parentPort, workerData } = require('node:worker_threads');

try {
  const snapshot = JSON.parse(workerData);
  const subjects = snapshot?.subjects;
  if (!Array.isArray(subjects)) {
    parentPort.postMessage({ type: 'complete', value: snapshot });
    parentPort.close();
  } else {
    const { subjects: _subjects, ...header } = snapshot;
    let offset = 0;
    parentPort.on('message', () => {
      if (offset >= subjects.length) {
        parentPort.postMessage({ type: 'done' });
        parentPort.close();
        return;
      }
      const batch = subjects.slice(offset, offset + 200);
      offset += batch.length;
      parentPort.postMessage({ type: 'batch', value: batch });
    });
    parentPort.postMessage({ type: 'header', value: header });
  }
} catch (error) {
  parentPort.postMessage({ type: 'error', message: error.message });
  parentPort.close();
}
