#!/bin/bash
echo "正在启动抖音视频下载器..."

# 获取当前脚本所在目录
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

# 检查 3000 端口：只结束本项目自己的旧实例（node server.js 且工作目录为本目录），
# 其他程序占用时提示退出，不再无差别 kill -9（会误杀别的服务，也让旧实例来不及保存状态）
PORT=3000
for PID in $(lsof -ti:$PORT -sTCP:LISTEN); do
    CMD=$(ps -o command= -p "$PID")
    CWD=$(lsof -a -p "$PID" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
    if [[ "$CMD" == *"server.js"* && "$CWD" == "$DIR" ]]; then
        echo "结束本项目的旧实例 (PID: $PID)..."
        kill "$PID"
        for i in 1 2 3 4 5; do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
    else
        echo "⚠️  $PORT 端口被其他程序占用 (PID: $PID, $CMD)"
        echo "请先关闭该程序，或用 PORT=其他端口 node server.js 启动。"
        read -n 1 -s -r -p "按任意键退出..."
        exit 1
    fi
done

# 启动 Node 服务并在后台运行
node server.js &
NODE_PID=$!

# 等待 1 秒确保服务启动
sleep 1

# 用默认浏览器打开本地网页
open "http://localhost:$PORT"

echo ""
echo "==============================================="
echo "✅ 服务已运行！你可以直接在这个终端窗口看到下载进度"
echo "⚠️  如果要停止程序，请直接关闭这个终端窗口即可"
echo "==============================================="

# 让脚本等待后台 Node 进程，防止终端闪退
wait $NODE_PID
