#!/bin/bash
cd "$(dirname "$0")"
PORT=8081
URL="http://127.0.0.1:${PORT}/?v=20260601a"

if lsof -ti :$PORT >/dev/null 2>&1; then
  echo "端口 $PORT 已有服务在运行"
else
  echo "正在启动本地服务 (端口 $PORT)…"
  nohup python3 -m http.server $PORT >/tmp/fish-lantern-8081.log 2>&1 &
  sleep 1
fi

open "$URL"
echo "已在浏览器打开: $URL"
echo "若仍卡在加载页，请 Cmd+Shift+R 强制刷新。"
echo "若未自动打开，请复制上面链接到浏览器。"
read -n 1 -s -r -p "按任意键关闭此窗口…"
