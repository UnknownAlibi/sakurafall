/**
 * 任务作用域管理
 *
 * 从 CmsApiService.js 抽离的任务取消与并发控制逻辑。
 * 通过 AbortController 实现同 scope 新任务取消旧任务，
 * 通过 worker 池实现并发限制。
 */
class TaskScope {
    constructor() {
        this.scopedTasks = new Map();
    }

    abortError(message = 'Task aborted') {
        const error = new Error(message);
        error.name = 'AbortError';
        error.code = 'ABORT_ERR';
        return error;
    }

    isAbortError(error) {
        return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
    }

    throwIfAborted(signal) {
        if (signal?.aborted) throw this.abortError();
    }

    /**
     * 启动作用域任务：同 scope 新任务自动取消旧任务
     */
    startScopedTask(scope) {
        const previous = this.scopedTasks.get(scope);
        if (previous?.controller) {
            previous.controller.abort();
        }

        const controller = new AbortController();
        const task = {
            scope,
            id: Date.now() + Math.random(),
            controller,
            signal: controller.signal
        };
        this.scopedTasks.set(scope, task);
        return task;
    }

    /**
     * 结束作用域任务：仅当 id 一致才删除（避免新任务被旧任务清理）
     */
    finishScopedTask(task) {
        if (!task) return;
        const current = this.scopedTasks.get(task.scope);
        if (current?.id === task.id) {
            this.scopedTasks.delete(task.scope);
        }
    }

    /**
     * 限并发 worker 池：每步检查取消信号
     */
    async mapWithConcurrency(items, limit, mapper, signal) {
        const list = Array.isArray(items) ? items : [];
        if (list.length === 0) return;

        const workerCount = Math.max(1, Math.min(parseInt(limit, 10) || 1, list.length));
        let index = 0;

        const worker = async () => {
            while (index < list.length) {
                this.throwIfAborted(signal);
                const currentIndex = index++;
                await mapper(list[currentIndex], currentIndex);
            }
        };

        await Promise.all(Array.from({ length: workerCount }, worker));
    }
}

module.exports = TaskScope;
