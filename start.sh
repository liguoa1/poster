#!/bin/bash
cd "$(dirname "$0")"

PORT=8899

# 关闭占用端口的旧进程
OLD_PIDS=$(lsof -ti tcp:$PORT 2>/dev/null)
if [ -n "$OLD_PIDS" ]; then
  echo "停止旧服务 (PID: $(echo $OLD_PIDS | tr '\n' ' '))..."
  echo "$OLD_PIDS" | xargs kill 2>/dev/null
  sleep 1
fi

echo "启动 HTTP Debugger -> http://localhost:$PORT"
python main.py
