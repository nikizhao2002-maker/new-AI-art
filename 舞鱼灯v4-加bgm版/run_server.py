#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 兼容旧入口：原 run_server.py 曾被存成 UTF-16 导致 Python 无法执行。
# 现统一改用 serve.py（UTF-8 + 关闭缓存 + 绑定 0.0.0.0 + 友好提示）。
# 本文件转交给 serve.py，无论用户运行哪个文件都能正常启动。
import os
import runpy

_here = os.path.dirname(os.path.abspath(__file__))
os.chdir(_here)
runpy.run_path(os.path.join(_here, 'serve.py'), run_name='__main__')
