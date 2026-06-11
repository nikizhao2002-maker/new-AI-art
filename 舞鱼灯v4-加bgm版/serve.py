#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
舞鱼灯本地服务器 (替代损坏的 run_server.py)

用法:
    python serve.py            # 默认端口 8081
    python serve.py 9000       # 指定端口

特性:
    - UTF-8 源码 (旧 run_server.py 被存成 UTF-16, Python 无法执行)
    - 关闭缓存 (no-store), 避免开发时浏览器缓存旧 GLB / js
    - 绑定 0.0.0.0, 手机/局域网可通过本机 IP 访问
    - 端口被占用时给出友好提示
    - 正确的 UTF-8 charset 与 .glb MIME, 修复中文文件名乱码
"""

import os
import sys
import socket
import http.server
import socketserver

# 切到脚本所在目录, 双击/任意目录运行都能正确提供本项目文件
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    # 补充/修正 MIME 类型
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".glb": "model/gltf-binary",
        ".gltf": "model/gltf+json",
        ".ply": "application/octet-stream",
        ".wasm": "application/wasm",
        ".task": "application/octet-stream",
        ".mp4": "video/mp4",
    }

    def end_headers(self):
        # 开发期关闭缓存, 模型/脚本改动后刷新即生效
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # 精简日志, 避免中文路径在 GBK 控制台报错
        try:
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))
        except Exception:
            pass


def get_lan_ip():
    """尽量探测本机局域网 IP, 供手机端访问 phone.html"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return None


def main():
    port = 8081
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print(f"端口参数无效: {sys.argv[1]}, 使用默认 8081")

    socketserver.TCPServer.allow_reuse_address = True
    try:
        httpd = socketserver.TCPServer(("0.0.0.0", port), Handler)
    except OSError as e:
        print(f"[错误] 无法在端口 {port} 启动服务器: {e}")
        print(f"      端口可能已被占用。可换端口运行:  python serve.py {port + 1}")
        sys.exit(1)

    lan = get_lan_ip()
    print("=" * 52)
    print("  舞鱼灯本地服务器已启动")
    print(f"  本机访问 : http://localhost:{port}/")
    if lan:
        print(f"  局域网/手机: http://{lan}:{port}/  (需同一 Wi-Fi)")
    print("  按 Ctrl+C 停止")
    print("=" * 52)
    print("  注意: 摄像头(手势识别)只在 localhost 或 HTTPS 下可用;")
    print("       请用本服务器打开, 不要直接双击 index.html (file://)。")
    print("=" * 52)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n服务器已停止。")
        httpd.server_close()


if __name__ == "__main__":
    main()
