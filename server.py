#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
东秦杀：点名册 · 联机中转服务器

零依赖，只用 Python 标准库。一个进程同时干两件事：

  1. 静态文件服务 —— 把本目录下的 index.html / js / css 发给浏览器
  2. 房间消息中转   —— 长轮询（long-polling）HTTP，不依赖 WebSocket

设计要点（改代码前请先读）：

  * 引擎**不在**这里跑。房主的浏览器是权威，它跑完整引擎；
    这个进程只负责把消息从一个浏览器搬到另一个浏览器。
  * 用长轮询而不是 WebSocket：Python 标准库没有 WebSocket 实现，
    手搓 RFC6455 帧解析风险大；长轮询是纯 HTTP，穿内网穿透/代理更稳，
    调试时 curl 就能看。回合制卡牌游戏对延迟不敏感。
  * 保持 HTTP/1.0 默认（不做 keep-alive）：这样每个响应都带 Connection: close，
    彻底绕开"Content-Length 写不准导致浏览器一直等"这一整类经典卡死 bug。
    8 个客户端多开几个 TCP 连接完全无所谓。
  * poll 是无状态的：客户端传 since（自己见过的最大 seq），
    服务端返回所有 seq > since 的消息。不需要"消费"消息，天然幂等。

用法：
    python server.py            # 默认 8080，被占用则自动往后找
    python server.py 9000       # 指定端口
"""

import json
import os
import random
import re
import socket
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

# ---------------------------------------------------------------- 配置

ROOT = os.path.dirname(os.path.abspath(__file__))

POLL_TIMEOUT = 25.0     # 单次长轮询最多挂起多少秒（超时返回空，不消费消息）
PEER_TIMEOUT = 35.0     # 超过这么久没来 poll 就判定掉线（必须 > POLL_TIMEOUT）
REAP_INTERVAL = 5.0     # 掉线扫描间隔
LOG_LIMIT = 1000        # 每个房间最多保留多少条历史消息
ROOM_TTL = 6 * 3600     # 房间闲置多久后回收

# 注意：这里**刻意不**调用 sys.stdout.reconfigure(encoding='utf-8')。
# 中文版 Windows 控制台默认是 GBK，Python 默认就会用控制台的编码输出，
# 中文本来就能正常显示；强行改成 UTF-8 反而会让用户看到一屏乱码。
# （start-server.bat 会先 chcp 65001，那时 Python 会自动改用 UTF-8，同样正确。）


# ---------------------------------------------------------------- 房间模型

class Peer:
    __slots__ = ('pid', 'token', 'name', 'spectator', 'host', 'last_seen', 'alive')

    def __init__(self, pid, token, name, spectator, host):
        self.pid = pid
        self.token = token
        self.name = name
        self.spectator = spectator
        self.host = host
        self.last_seen = time.time()
        self.alive = True


class Room:
    """一个房间的全部状态。所有读写都在 self.lock 保护下。"""

    def __init__(self, code, host_token):
        self.code = code
        self.host_token = host_token
        self.lock = threading.Lock()
        self.cond = threading.Condition(self.lock)
        self.msgs = []          # [{seq, from, to, data}]
        self.seq = 0
        self.peers = {}         # pid -> Peer
        self.touched = time.time()
        # 房主定期存盘的整局状态。房主掉线后，任何人都能用它接手这局。
        # 服务器不理解里面的内容，只是原样保管。
        self.save = None
        self.save_at = 0.0

    # ---- 发消息 ----

    def post(self, sender_pid, to, data):
        """to ∈ 'host' | 'all' | <peerId>。返回新消息的 seq。"""
        with self.cond:
            self.seq += 1
            self.msgs.append({'seq': self.seq, 'from': sender_pid, 'to': to, 'data': data})
            self.touched = time.time()
            if len(self.msgs) > LOG_LIMIT:
                del self.msgs[:len(self.msgs) - LOG_LIMIT]
            self.cond.notify_all()
            return self.seq

    # ---- 长轮询 ----

    def wait_for(self, pid, since, timeout):
        """挂起直到有该 peer 可见的新消息，或超时。返回 (msgs, truncated)。"""
        deadline = time.time() + timeout
        with self.cond:
            while True:
                truncated = bool(self.msgs) and since < self.msgs[0]['seq'] - 1
                out = self._visible(pid, since)
                if out:
                    return out, False
                remaining = deadline - time.time()
                if remaining <= 0:
                    # 没有任何新消息；顺带告诉客户端它的游标是不是已经太旧
                    return [], truncated
                self.cond.wait(remaining)

    def _visible(self, pid, since):
        me = self.peers.get(pid)
        am_host = bool(me and me.host)
        out = []
        for m in self.msgs:
            if m['seq'] <= since:
                continue
            to = m['to']
            if to == 'all':
                if m['from'] != pid:
                    out.append(m)
            elif to == 'host':
                if am_host:
                    out.append(m)
            elif to == pid:
                out.append(m)
        return out

    def head(self):
        with self.lock:
            return self.seq


class Registry:
    def __init__(self):
        self.lock = threading.Lock()
        self.rooms = {}

    def new_code(self):
        """生成一个没被占用的 4 位房间号。"""
        with self.lock:
            for _ in range(500):
                code = '%04d' % random.randint(0, 9999)
                if code not in self.rooms:
                    return code
            raise RuntimeError('房间已满')

    def create(self):
        code = self.new_code()
        room = Room(code, new_token())
        with self.lock:
            self.rooms[code] = room
        return room

    def get(self, code):
        with self.lock:
            return self.rooms.get(code)

    def drop(self, code):
        with self.lock:
            self.rooms.pop(code, None)

    def all(self):
        with self.lock:
            return list(self.rooms.values())


REG = Registry()


def new_token():
    return '%016x' % random.getrandbits(64)


# ---------------------------------------------------------------- 掉线扫描

def reaper():
    """后台线程：把掉线的 peer 标记出来并通知房主；回收闲置房间。"""
    while True:
        time.sleep(REAP_INTERVAL)
        now = time.time()
        for room in REG.all():
            gone = []
            with room.lock:
                for p in room.peers.values():
                    if p.alive and now - p.last_seen > PEER_TIMEOUT:
                        p.alive = False
                        gone.append(p)
            for p in gone:
                room.post('system', 'host',
                          {'t': 'left', 'peer': p.pid, 'name': p.name})
                if p.host:
                    # 房主（= 整局的引擎）掉线了。告诉所有人，
                    # 谁都可以点「我来接手」把自己变成新的房主。
                    room.post('system', 'all',
                              {'t': 'hostgone', 'peer': p.pid, 'name': p.name})
            if now - room.touched > ROOM_TTL:
                REG.drop(room.code)


# ---------------------------------------------------------------- HTTP

class Handler(SimpleHTTPRequestHandler):

    server_version = 'DongQinSha'
    sys_version = ''

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # ---- 通用 ----

    def log_message(self, fmt, *args):
        # 长轮询会刷屏（每个客户端每 25 秒一次），只在出错时打日志
        if len(args) > 1 and str(args[1])[:1] in ('4', '5'):
            sys.stderr.write('  ! %s %s\n' % (self.address_string(), fmt % args))

    def guess_type(self, path):
        t = super().guess_type(path)
        # 全站中文：漏了 charset 就是乱码
        if t.startswith('text/') or t in ('application/javascript', 'application/json'):
            if 'charset' not in t:
                t += '; charset=utf-8'
        return t

    def end_headers(self):
        # 不缓存：否则手机会拿住旧的 net.js，改了代码不生效
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            n = 0
        if n <= 0:
            return {}
        raw = self.rfile.read(n)
        try:
            obj = json.loads(raw.decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            return {}
        return obj if isinstance(obj, dict) else {}

    # ---- 路由 ----

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/api/info':
            return self._json({'ok': True, 'ips': lan_ips(), 'port': self.server.server_address[1],
                               'rooms': len(REG.all())})
        if path.startswith('/api/'):
            return self.send_error(404, 'unknown api')
        return super().do_GET()      # 静态文件

    def do_POST(self):
        path = urlparse(self.path).path
        if not path.startswith('/api/'):
            return self.send_error(404)
        body = self._read_json()
        fn = ROUTES.get(path[5:])
        if fn is None:
            return self.send_error(404, 'unknown api')
        try:
            fn(self, body)
        except ApiError as e:
            self._json({'ok': False, 'err': e.msg}, e.code)
        except Exception as e:                                  # noqa: BLE001
            sys.stderr.write('  ! api error %s: %r\n' % (path, e))
            self._json({'ok': False, 'err': '服务器内部错误'}, 500)


class ApiError(Exception):
    def __init__(self, msg, code=400):
        super().__init__(msg)
        self.msg = msg
        self.code = code


def _room_or_404(body):
    code = str(body.get('code') or '')
    room = REG.get(code)
    if room is None:
        raise ApiError('房间不存在或已解散', 404)
    return room


def _auth(room, body):
    pid = str(body.get('peer') or '')
    token = str(body.get('token') or '')
    with room.lock:
        p = room.peers.get(pid)
    if p is None or p.token != token:
        raise ApiError('身份校验失败', 403)
    return p


# ---- 各接口 ----

def api_create(h, body):
    room = REG.create()
    pid = new_token()
    p = Peer(pid, new_token(), str(body.get('name') or '房主')[:12], False, True)
    with room.lock:
        room.peers[pid] = p
    h._json({'ok': True, 'code': room.code, 'peer': pid,
             'token': p.token, 'host': True, 'seq': 0})


def api_join(h, body):
    room = _room_or_404(body)
    spectator = bool(body.get('spectator'))
    with room.lock:
        if len(room.peers) >= 12:
            raise ApiError('房间人数已满')
    pid = new_token()
    p = Peer(pid, new_token(), str(body.get('name') or '玩家')[:12], spectator, False)
    with room.lock:
        room.peers[pid] = p
    # 通知房主有人来了——座位分配由房主（游戏层）决定，中转层不管
    room.post('system', 'host',
              {'t': 'joined', 'peer': pid, 'name': p.name, 'spectator': spectator})
    h._json({'ok': True, 'code': room.code, 'peer': pid, 'token': p.token,
             'host': False, 'seq': 0})


def api_rejoin(h, body):
    """刷新页面后凭 token 认领原身份（peerId 不变，避免座位错乱）。"""
    room = _room_or_404(body)
    p = _auth(room, body)
    with room.lock:
        p.alive = True
        p.last_seen = time.time()
        seq = room.seq
    room.post('system', 'host', {'t': 'rejoined', 'peer': p.pid, 'name': p.name})
    h._json({'ok': True, 'code': room.code, 'peer': p.pid, 'token': p.token,
             'host': p.host, 'seq': seq})


def api_poll(h, body):
    room = _room_or_404(body)
    p = _auth(room, body)
    with room.lock:
        p.last_seen = time.time()
        p.alive = True
    try:
        since = int(body.get('since') or 0)
    except (TypeError, ValueError):
        since = 0
    try:
        timeout = float(body.get('timeout') or POLL_TIMEOUT)
    except (TypeError, ValueError):
        timeout = POLL_TIMEOUT
    timeout = max(0.0, min(timeout, POLL_TIMEOUT))
    msgs, truncated = room.wait_for(p.pid, since, timeout)
    h._json({'ok': True, 'msgs': msgs, 'seq': room.head(),
             'resync': truncated, 'now': time.time()})


def api_send(h, body):
    room = _room_or_404(body)
    p = _auth(room, body)
    with room.lock:
        p.last_seen = time.time()
    to = body.get('to')
    if to not in ('host', 'all') and not isinstance(to, str):
        raise ApiError('收件人无效')
    seq = room.post(p.pid, to, body.get('data'))
    h._json({'ok': True, 'seq': seq})


def api_save(h, body):
    """房主存盘。服务器不理解内容，只是原样保管，等房主掉线后让别人接手。"""
    room = _room_or_404(body)
    p = _auth(room, body)
    if not p.host:
        raise ApiError('只有房主能存盘', 403)
    save = body.get('save')
    if not isinstance(save, dict):
        raise ApiError('存档格式不对')
    with room.lock:
        room.save = save
        room.save_at = time.time()
    h._json({'ok': True})


def api_load(h, body):
    """取这份存档（任何人都能取，用于接手）。"""
    room = _room_or_404(body)
    _auth(room, body)
    with room.lock:
        h._json({'ok': True, 'save': room.save,
                 'hasSave': room.save is not None,
                 'saveAt': room.save_at})


def api_takeover(h, body):
    """把自己变成新的房主：接手存档 + 拿到房间里的其他人。"""
    room = _room_or_404(body)
    p = _auth(room, body)
    with room.lock:
        if room.save is None:
            raise ApiError('这个房间还没有存档，接不了手', 409)
        # 原来那个房主已经掉线了才会走到这里；把房主身份转给调用者
        for q in room.peers.values():
            q.host = False
        p.host = True
        peers = [{'peer': q.pid, 'name': q.name, 'alive': q.alive, 'spectator': q.spectator}
                 for q in room.peers.values()]
        save = room.save
    room.post('system', 'all', {'t': 'takeover', 'peer': p.pid, 'name': p.name})
    h._json({'ok': True, 'save': save, 'peers': peers, 'host': p.pid})


def api_leave(h, body):
    room = _room_or_404(body)
    p = _auth(room, body)
    with room.lock:
        room.peers.pop(p.pid, None)
    room.post('system', 'host', {'t': 'left', 'peer': p.pid, 'name': p.name})
    h._json({'ok': True})


ROUTES = {
    'create': api_create,
    'join': api_join,
    'rejoin': api_rejoin,
    'poll': api_poll,
    'send': api_send,
    'leave': api_leave,
    'save': api_save,
    'load': api_load,
    'takeover': api_takeover,
}


# ---------------------------------------------------------------- 网络地址

def primary_ip():
    """走默认路由的那张网卡的地址。

    这台机器上往往有好几张网卡（WLAN、Windows 移动热点、虚拟网卡……），
    打印出一串地址会让人不知道给同学哪一个。UDP 试探拿到的这个是
    "你平时上网走的那条路"，绝大多数情况下就是别人该用的那个。
    """
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(('10.255.255.255', 1))
            return s.getsockname()[0]
        finally:
            s.close()
    except OSError:
        return ''


def lan_ips():
    """尽量把所有可能让同学连上来的局域网 IPv4 都找出来。

    本机实测有 WLAN 地址和 Windows 移动热点网段（192.168.137.x），
    两个都该打印出来——同学连热点是最省事的联机方式。
    """
    ips = set()

    # 1) 主机名解析（能拿到大部分网卡）
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass

    # 2) 默认路由那张网卡
    p = primary_ip()
    if p:
        ips.add(p)

    # 3) Windows 上补一刀：热点网段常常既解析不到也走不了默认路由，
    #    直接扫 ipconfig 输出里长得像 IPv4 的串（不依赖系统语言）
    if os.name == 'nt':
        try:
            import subprocess
            out = subprocess.run(['ipconfig'], capture_output=True, timeout=8)
            text = out.stdout.decode('gbk', 'replace')
            for m in re.finditer(r'\b(\d{1,3}(?:\.\d{1,3}){3})\b', text):
                ips.add(m.group(1))
        except Exception:
            pass

    def usable(ip):
        return (not ip.startswith('127.')) and (not ip.startswith('169.254.')) \
            and ip != '0.0.0.0' and not ip.startswith('255.')

    # 把常见的局域网网段排在前面
    def rank(ip):
        if ip.startswith('192.168.'):
            return 0
        if ip.startswith('10.'):
            return 1
        if ip.startswith('172.'):
            return 2
        return 3

    return sorted((ip for ip in ips if usable(ip)), key=lambda x: (rank(x), x))


# ---------------------------------------------------------------- 启动

def main():
    port = 8080
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print('端口必须是数字，比如：python server.py 9000')
            return 1

    httpd = None
    for p in range(port, port + 20):
        try:
            httpd = ThreadingHTTPServer(('0.0.0.0', p), Handler)
            port = p
            break
        except OSError:
            continue
    if httpd is None:
        print('端口 %d 起连续 20 个都被占用了，换个起始端口吧。' % port)
        return 1

    httpd.daemon_threads = True
    threading.Thread(target=reaper, daemon=True).start()

    line = '=' * 56
    print()
    print(line)
    print('  东秦杀：点名册  ·  联机服务器已启动')
    print(line)
    print('  房主（这台电脑）请打开：  http://localhost:%d/' % port)
    print()
    print('  其他人用这个地址加入（手机 / 电脑连同一个 WiFi 或热点）：')
    ips = lan_ips()
    primary = primary_ip()
    if primary and primary in ips:
        # 默认路由那张网卡排最前面：这台电脑常常有好几张网卡，
        # 列一串地址会让人不知道报哪一个给同学。
        print('      http://%s:%d/     <<< 一般就是这个' % (primary, port))
        rest = [ip for ip in ips if ip != primary]
        if rest:
            print()
            print('      如果上面那个连不上，再试这些（其他网卡）：')
            for ip in rest:
                print('          http://%s:%d/' % (ip, port))
    elif ips:
        for ip in ips:
            print('      http://%s:%d/' % (ip, port))
    else:
        print('      （没找到局域网地址，用 ipconfig 自己看一下）')
    print()
    print('  · 关掉这个窗口 = 服务器停止，所有人的连接都会断')
    print('  · 第一次运行 Windows 会弹防火墙提示，必须点「允许访问」')
    print(line)
    print()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n服务器已停止。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
