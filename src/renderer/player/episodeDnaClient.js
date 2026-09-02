// Episode DNA P1：分析 Worker 客户端
// 职责：按需创建 Worker、投递特征数据、返回候选结果、随时可销毁。

let worker = null;
let pendingResolve = null;
let pendingReject = null;

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./episodeDnaWorker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (event) => {
    const { type, candidates, message } = event.data || {};
    if (!pendingResolve || !pendingReject) return;
    if (type === 'result') {
      pendingResolve(candidates || []);
    } else {
      pendingReject(new Error(message || '片头分析失败'));
    }
    pendingResolve = null;
    pendingReject = null;
  };
  worker.onerror = (error) => {
    if (pendingReject) {
      pendingReject(new Error(error?.message || '片头分析 Worker 异常'));
      pendingResolve = null;
      pendingReject = null;
    }
  };
  return worker;
}

/**
 * 分析片头候选（音频能量 + 场景切换）
 * @param {{ windowMs: number, times: number[]|Float32Array, rms: number[]|Float32Array|null, luma: number[]|Float32Array|null }} features
 * @returns {Promise<Array<{start:number,end:number,confidence:number,reason:string}>>}
 */
export function analyzeIntroFeatures(features = {}) {
  const active = ensureWorker();
  if (pendingResolve) {
    return Promise.reject(new Error('已有一次分析正在进行'));
  }
  return new Promise((resolve, reject) => {
    pendingResolve = resolve;
    pendingReject = reject;
    // Float32Array 逐项拷贝为普通数组，结构化克隆在部分环境下对 TypedArray 兼容性更好
    const payload = {
      windowMs: Number(features.windowMs) || 500,
      times: Array.from(features.times || []),
      rms: features.rms ? Array.from(features.rms) : null,
      luma: features.luma ? Array.from(features.luma) : null
    };
    active.postMessage({ type: 'analyze', payload });
  });
}

export function destroyIntroAnalyzer() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  if (pendingReject) {
    pendingReject(new Error('分析已取消'));
    pendingResolve = null;
    pendingReject = null;
  }
}
