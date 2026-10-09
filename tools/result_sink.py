#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
测试结果收集器（只在开发时用，不参与游戏）。

浏览器里的自测跑完后，把结果 POST 到这个小服务，它写进文件。
比起 Edge 的 --dump-dom，这条路可靠得多：自测里有**长轮询**，
一个 fetch 会长时间挂起，而 Chromium 的虚拟时钟遇到挂起的网络请求会暂停，
导致 --virtual-time-budget 永远不触发、--dump-dom 永远不返回。

用法：
    python -I tools/result_sink.py 8899 tools/_results.txt
"""

import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
OUT = sys.argv[2] if len(sys.argv) > 2 else 'tools/_results.txt'

# 启动时清掉上一次的结果：调用方靠"文件出现"判断测试跑完了，
# 留着旧文件会让人以为这次也跑完了。
try:
    os.remove(OUT)
except OSError:
    pass


class Handler(BaseHTTPRequestHandler):

    def log_message(self, *a):
        pass

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_POST(self):
        try:
            n = int(self.headers.get('Content-Length') or 0)
            body = self.rfile.read(n).decode('utf-8', 'replace')
        except Exception:
            body = ''
        try:
            with open(OUT, 'w', encoding='utf-8') as f:
                f.write(body)
        except OSError as e:
            sys.stderr.write('cannot write %s: %r\n' % (OUT, e))
        self.send_response(200)
        self._cors()
        self.send_header('Content-Length', '2')
        self.end_headers()
        self.wfile.write(b'ok')


if __name__ == '__main__':
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    srv.daemon_threads = True
    srv.serve_forever()
