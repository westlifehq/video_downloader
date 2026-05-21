const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');

const isPkg = typeof process.pkg !== 'undefined';
const exeDir = isPkg ? path.dirname(process.execPath) : process.cwd();
const CONFIG_PATH = path.join(exeDir, 'config.json');
const SCHEDULE_CONFIG_PATH = path.join(exeDir, 'schedule_config.json');
const SCHEDULE_LOG_PATH = path.join(exeDir, 'schedule_log.json');

/**
 * 读取主要配置 (异步)
 */
async function readConfig() {
    try {
        const data = await fs.readFile(CONFIG_PATH, 'utf-8');
        return JSON.parse(data);
    } catch {
        return { downloadDir: '' };
    }
}

/**
 * 读取主要配置 (同步)
 */
function readConfigSync() {
    try {
        return JSON.parse(fsSync.readFileSync(CONFIG_PATH, 'utf-8'));
    } catch {
        return { downloadDir: '' };
    }
}

/**
 * 写入主要配置 (异步)
 */
async function writeConfig(config) {
    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * 获取当前的有效下载目录 (异步)
 */
async function getEffectiveDownloadDir() {
    const config = await readConfig();
    if (process.env.DOWNLOAD_DIR) {
        return process.env.DOWNLOAD_DIR;
    }
    if (config.downloadDir) {
        return config.downloadDir;
    }
    return path.join(require('os').homedir(), 'Downloads', 'douyin');
}

/**
 * 获取当前的有效下载目录 (同步)
 */
function getEffectiveDownloadDirSync() {
    const config = readConfigSync();
    if (process.env.DOWNLOAD_DIR) {
        return process.env.DOWNLOAD_DIR;
    }
    if (config.downloadDir) {
        return config.downloadDir;
    }
    return path.join(require('os').homedir(), 'Downloads', 'douyin');
}

/**
 * 读取定时同步配置 (异步)
 */
async function readScheduleConfig() {
    try {
        const data = await fs.readFile(SCHEDULE_CONFIG_PATH, 'utf-8');
        return JSON.parse(data);
    } catch {
        return { enabled: false, cronTime: '0 0 * * *', syncMode: 'both', maxCount: 50 };
    }
}

/**
 * 读取定时同步配置 (同步)
 */
function readScheduleConfigSync() {
    try {
        return JSON.parse(fsSync.readFileSync(SCHEDULE_CONFIG_PATH, 'utf-8'));
    } catch {
        return { enabled: false, cronTime: '0 0 * * *', syncMode: 'both', maxCount: 50 };
    }
}

/**
 * 写入定时同步配置 (异步)
 */
async function writeScheduleConfig(cfg) {
    await fs.writeFile(SCHEDULE_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

/**
 * 读取定时同步日志 (异步)
 */
async function readScheduleLog() {
    try {
        const data = await fs.readFile(SCHEDULE_LOG_PATH, 'utf-8');
        return JSON.parse(data);
    } catch {
        return [];
    }
}

/**
 * 写入/追加定时同步日志 (异步)
 */
async function appendScheduleLog(entry) {
    const logs = await readScheduleLog();
    logs.unshift(entry);
    await fs.writeFile(SCHEDULE_LOG_PATH, JSON.stringify(logs.slice(0, 50), null, 2));
}

module.exports = {
    exeDir,
    CONFIG_PATH,
    SCHEDULE_CONFIG_PATH,
    SCHEDULE_LOG_PATH,
    readConfig,
    readConfigSync,
    writeConfig,
    getEffectiveDownloadDir,
    getEffectiveDownloadDirSync,
    readScheduleConfig,
    readScheduleConfigSync,
    writeScheduleConfig,
    readScheduleLog,
    appendScheduleLog
};
