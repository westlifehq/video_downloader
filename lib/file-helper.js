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
 * 把不可信的相对名解析到 root 之下，结果若跑出 root（含等于 root 本身）则抛错。
 * 用于下载落盘路径：awemeId / subDir 来自请求体，path.join 会正常解释其中的 ".."。
 */
function resolveWithinRoot(root, untrustedName) {
    const resolvedRoot = path.resolve(root);
    const target = path.resolve(resolvedRoot, untrustedName);
    const relative = path.relative(resolvedRoot, target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('非法下载路径');
    }
    return target;
}

/**
 * 在 isPathSafe（纯字符串判断）之外按真实路径再校验一次：
 * 下载目录内若有指向外部的符号链接，字符串判断会放行而实际操作落到外部。
 * 目标本身是符号链接时直接拒绝。返回真实路径。
 */
function resolveExistingWithinRoot(targetPath) {
    if (!isPathSafe(targetPath)) throw new Error('非法路径，禁止越界访问');
    if (!fsSync.existsSync(targetPath)) throw new Error('文件不存在');
    if (fsSync.lstatSync(targetPath).isSymbolicLink()) throw new Error('禁止操作符号链接');
    const root = fsSync.realpathSync(path.resolve(configHelper.getEffectiveDownloadDirSync()));
    const real = fsSync.realpathSync(targetPath);
    const relative = path.relative(root, real);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('非法路径，禁止越界访问');
    }
    return real;
}

/**
 * 安全地在系统管理器中打开文件
 */
function openFileInExplorer(filePath) {
    return new Promise((resolve, reject) => {
        try {
            filePath = resolveExistingWithinRoot(filePath);
        } catch (err) {
            return reject(err);
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
    try {
        filePath = resolveExistingWithinRoot(filePath);
    } catch (err) {
        if (err.message === '文件不存在') throw new Error('文件已不存在');
        throw err;
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
    resolveWithinRoot,
    resolveExistingWithinRoot,
    openFileInExplorer,
    safeDeleteFile
};
