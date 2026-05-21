const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { spawn } = require('child_process');
const configHelper = require('./config');

/**
 * 校验路径安全性，防止目录穿越和操作下载根目录外部的文件
 */
function isPathSafe(targetPath) {
    if (!targetPath) return false;
    try {
        const downloadDir = path.resolve(configHelper.getEffectiveDownloadDirSync());
        const resolvedPath = path.resolve(targetPath);
        const relative = path.relative(downloadDir, resolvedPath);
        // 不允许为空（即下载根目录本身，以防万一删了下载目录），不允许以 '..' 开头，不允许为绝对路径
        return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    } catch (e) {
        return false;
    }
}

/**
 * 安全地在系统管理器中打开文件
 */
function openFileInExplorer(filePath) {
    return new Promise((resolve, reject) => {
        if (!isPathSafe(filePath)) {
            return reject(new Error('非法路径，禁止越界访问'));
        }

        if (!fsSync.existsSync(filePath)) {
            return reject(new Error('文件不存在'));
        }

        const platform = process.platform;
        let cmd, args;

        if (platform === 'win32') {
            cmd = 'explorer.exe';
            args = [`/select,${filePath}`];
        } else if (platform === 'darwin') {
            cmd = 'open';
            args = ['-R', filePath];
        } else {
            cmd = 'xdg-open';
            args = [path.dirname(filePath)];
        }

        const child = spawn(cmd, args);
        let hasError = false;

        child.on('error', (err) => {
            hasError = true;
            reject(err);
        });

        process.nextTick(() => {
            if (child.pid && !hasError) {
                resolve({ success: true });
            }
        });
    });
}

/**
 * 安全地删除文件或文件夹 (异步)
 */
async function safeDeleteFile(filePath) {
    if (!isPathSafe(filePath)) {
        throw new Error('非法路径，禁止删除');
    }

    try {
        const stats = await fs.stat(filePath);
        if (stats.isDirectory()) {
            await fs.rm(filePath, { recursive: true, force: true });
        } else {
            await fs.unlink(filePath);
        }
        return { success: true };
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new Error('文件已不存在');
        }
        throw err;
    }
}

module.exports = {
    isPathSafe,
    openFileInExplorer,
    safeDeleteFile
};
