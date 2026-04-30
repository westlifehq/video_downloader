@echo off
setlocal
cd /d "%~dp0"

echo.
echo ==========================================
echo       抖音视频下载器 - 启动日志
echo ==========================================
echo.
echo 正在尝试启动程序...
echo.

if exist ".\douyin-downloader.exe" (
	echo 检测到 douyin-downloader.exe，使用打包版启动。
	.\douyin-downloader.exe
) else (
	echo 未找到 douyin-downloader.exe，切换为 Node.js 方式启动。
	where node >nul 2>nul
	if errorlevel 1 (
		echo.
		echo 未检测到 Node.js，请先安装 Node.js 16+。
		echo 下载地址: https://nodejs.org/
		echo.
		pause
		exit /b 1
	)

	if not exist ".\node_modules" (
		echo 未检测到依赖，正在安装 npm 依赖...
		call npm install
		if errorlevel 1 (
			echo.
			echo 依赖安装失败，请检查网络或 npm 环境。
			echo.
			pause
			exit /b 1
		)
	)

	if not exist "%LOCALAPPDATA%\ms-playwright\chromium-*" (
		echo 正在安装 Playwright Chromium 浏览器引擎...
		call npx playwright install chromium
	)

	echo 正在启动 Node 后端...
	call npm run dev
)

echo.
echo ==========================================
echo 程序已退出，以上是运行日志。
echo 如果有报错，请截图发给开发者。
echo ==========================================
pause
