let sequence = 0;

export function requestSubjectDetail(api, id, { signal } = {}) {
  if (!api?.subjectDetail || signal?.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    const requestId = `detail-${++sequence}`;
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', cancel);
      resolve(value);
    };
    const cancel = () => {
      api.subjectDetailCancel?.(requestId)?.catch(() => {});
      finish(null);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    Promise.resolve().then(() => settled ? null : api.subjectDetail(id, { requestId }))
      .then(finish, () => finish(null));
  });
}
