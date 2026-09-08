const { parentPort, workerData } = require('node:worker_threads');

try {
  const input = workerData?.stream === true ? workerData.text : workerData;
  const text = ArrayBuffer.isView(input)
    ? Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString('utf8')
    : input;
  const snapshot = JSON.parse(text);
  const subjects = snapshot?.subjects;
  if (workerData?.stream === true) {
    if (Number(snapshot?.schemaVersion) !== 1) throw new Error('Unsupported catalog snapshot schema');
    if (!Array.isArray(subjects) || subjects.some(item =>
      !item || !Number.isSafeInteger(Number(item.id)) || Number(item.id) <= 0 ||
      (item.type !== undefined && Number(item.type) !== 2))) {
      throw new Error('Invalid catalog snapshot subjects');
    }
  }
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
      subjects.fill(null, offset, offset + batch.length);
      offset += batch.length;
      parentPort.postMessage({ type: 'batch', value: batch });
    });
    parentPort.postMessage({ type: 'header', value: header, count: subjects.length });
  }
} catch (error) {
  parentPort.postMessage({ type: 'error', name: error.name, message: error.message });
  parentPort.close();
}
