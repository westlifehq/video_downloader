const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const configHelper = require('./config');

const TASKS_HISTORY_PATH = path.join(configHelper.exeDir, 'user_data', 'tasks_history.json');

// 确保 user_data 目录存在
const userDataDir = path.join(configHelper.exeDir, 'user_data');
if (!fsSync.existsSync(userDataDir)) {
    fsSync.mkdirSync(userDataDir, { recursive: true });
}

class TaskManager {
    constructor() {
        this.downloadTasks = new Map();
        this.favSyncTasks = new Map();
        this.likedSyncTasks = new Map();
        this.msgSyncTasks = new Map();
        this.userSyncTasks = new Map();
        this.pendingSavePromise = null;
        this.saveRequestedDuringFlush = false;
        this.saveTasksImpl = null;
        this.loadTasksSync();
    }

    loadTasksSync() {
        try {
            if (fsSync.existsSync(TASKS_HISTORY_PATH)) {
                const data = JSON.parse(fsSync.readFileSync(TASKS_HISTORY_PATH, 'utf-8'));
                
                // 恢复下载任务
                if (data.downloadTasks) {
                    for (const [id, task] of Object.entries(data.downloadTasks)) {
                        // 启动时将之前未完成的下载任务置为失败，防止一直显示 downloading
                        if (task.status === 'downloading') {
                            task.status = 'error';
                            task.error = '服务重启，任务被中断';
                        }
                        this.downloadTasks.set(id, task);
                    }
                }
                
                // 恢复同步任务 (如果处于 fetching 状态则置为中断)
                const restoreSyncTasks = (targetMap, sourceObj) => {
                    if (sourceObj) {
                        for (const [id, task] of Object.entries(sourceObj)) {
                            if (task.status === 'fetching') {
                                task.status = 'error';
                                task.error = '服务重启，任务被中断';
                                task.phase = '任务中断';
                            }
                            targetMap.set(id, task);
                        }
                    }
                };

                restoreSyncTasks(this.favSyncTasks, data.favSyncTasks);
                restoreSyncTasks(this.likedSyncTasks, data.likedSyncTasks);
                restoreSyncTasks(this.msgSyncTasks, data.msgSyncTasks);
                restoreSyncTasks(this.userSyncTasks, data.userSyncTasks);
            }
        } catch (err) {
            console.error('[TaskManager] 无法加载历史任务:', err.message);
        }
    }

    async saveTasks() {
        const saveImpl = this.saveTasksImpl;
        if (saveImpl) {
            await saveImpl();
            return;
        }

        try {
            const data = {
                downloadTasks: Object.fromEntries(this.downloadTasks),
                favSyncTasks: Object.fromEntries(this.favSyncTasks),
                likedSyncTasks: Object.fromEntries(this.likedSyncTasks),
                msgSyncTasks: Object.fromEntries(this.msgSyncTasks),
                userSyncTasks: Object.fromEntries(this.userSyncTasks)
            };
            await fs.writeFile(TASKS_HISTORY_PATH, JSON.stringify(data, null, 2), 'utf-8');
        } catch (err) {
            console.error('[TaskManager] 无法保存任务到磁盘:', err.message);
        }
    }

    queueSave() {
        if (this.pendingSavePromise) {
            this.saveRequestedDuringFlush = true;
            return this.pendingSavePromise;
        }

        this.pendingSavePromise = (async () => {
            try {
                do {
                    this.saveRequestedDuringFlush = false;
                    await this.saveTasks();
                } while (this.saveRequestedDuringFlush);
            } finally {
                this.pendingSavePromise = null;
            }
        })();

        return this.pendingSavePromise;
    }

    __queueSaveForTest() {
        return this.queueSave();
    }

    __setSaveTasksImplForTest(saveImpl) {
        this.saveTasksImpl = saveImpl;
    }

    // 获取对应的 Map
    _getMap(type) {
        switch (type) {
            case 'download': return this.downloadTasks;
            case 'favSync': return this.favSyncTasks;
            case 'likedSync': return this.likedSyncTasks;
            case 'msgSync': return this.msgSyncTasks;
            case 'userSync': return this.userSyncTasks;
            default: return null;
        }
    }

    getTask(type, taskId) {
        const map = this._getMap(type);
        return map ? map.get(taskId) : null;
    }

    getAllTasks(type) {
        const map = this._getMap(type);
        return map ? Array.from(map.values()) : [];
    }

    async createTask(type, taskId, taskData) {
        const map = this._getMap(type);
        if (!map) return;
        map.set(taskId, {
            id: taskId,
            ...taskData,
            startTime: taskData.startTime || Date.now()
        });
        await this.queueSave();
    }

    async updateTask(type, taskId, updates) {
        const map = this._getMap(type);
        if (!map) return;
        const task = map.get(taskId);
        if (!task) return;
        
        const oldStatus = task.status;
        Object.assign(task, updates);
        
        // 只有当状态改变，或者显式指定 saveNow 时才写入磁盘，以减少高频进度更新带来的 IO 开销
        if (oldStatus !== task.status || updates.saveNow) {
            await this.queueSave();
        }
    }

    async deleteTask(type, taskId) {
        const map = this._getMap(type);
        if (map && map.delete(taskId)) {
            await this.queueSave();
        }
    }
}

module.exports = new TaskManager();
