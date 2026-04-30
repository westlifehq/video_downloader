@echo off
setlocal
cd /d "%~dp0"

if exist ".\douyin-downloader.exe" (
	.\douyin-downloader.exe
	pause
	exit /b %errorlevel%
)

where node >nul 2>nul
if errorlevel 1 (
	echo 未检测到 Node.js。
	echo 请先安装 Node.js 16+，然后重新双击本文件。
	pause
	exit /b 1
)

if not exist ".\node_modules" (
	echo 未检测到依赖，正在安装 npm 依赖...
	call npm install
	if errorlevel 1 (
		echo 依赖安装失败，请检查网络或 npm 环境。
		pause
		exit /b 1
	)
)

if not exist "%LOCALAPPDATA%\ms-playwright\chromium-*" (
	echo 正在安装 Playwright Chromium 浏览器引擎（首次运行需要）...
	call npx playwright install chromium
	if errorlevel 1 (
		echo Playwright Chromium 安装失败，同步功能可能不可用。
		echo 你仍然可以使用链接解析和下载功能。
	)
)

echo 正在启动后端服务...
call npm run dev
pause
