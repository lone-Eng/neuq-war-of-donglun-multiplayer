#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
东秦杀联机中转层 · 协议自测

验证 server.py 的房间/长轮询/路由行为，不涉及游戏逻辑。
只依赖标准库，可以直接跑：

    python -I tools/protocol_test.py
    python -I tools/protocol_test.py http://192.168.1.5:8080   # 测别的地址

前提：先把 server.py 跑起来。
"""

import json
import sys
import threading
import time
import urllib.error
import urllib.request

BASE = sys.argv[1].rstrip('/') if len(sys.argv) > 1 else 'http://127.0.0.1:8080'

PASS, FAIL = [], []


def check(name, cond, detail=None):
    (PASS if cond else FAIL).append(name)
    print(('  [ok]   ' if cond else '  [FAIL] ') + name + (('  <- ' + str(detail)) if (detail and not cond) else ''))


# ---------------------------------------------------------------- HTTP 小客户端

def post(path, payload, timeout=40):
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={'Content-Type': 'application/json'},
                                 method='POST')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode('utf-8'))
        except Exception:
            return e.code, {}


def get_raw(path, timeout=15):
    """返回 (状态码, 响应头, 响应体)。"""
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        return r.status, r.headers, r.read()


class Peer:
    """一个客户端连接。poll 在后台线程里跑，消息进队列。"""

    def __init__(self, info, name=''):
        self.code = info['code']
        self.pid = info['peer']
        self.token = info['token']
        self.name = name
        self.host = info.get('host')
        self.seq = info.get('seq', 0)
        self.inbox = []
        self.lock = threading.Lock()
        self.running = True
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def _loop(self):
        while self.running:
            try:
                st, r = post('/api/poll', {'code': self.code, 'peer': self.pid,
                                           'token': self.token, 'since': self.seq},
                             timeout=40)
            except Exception:
                if self.running:
                    time.sleep(0.2)
                continue
            if r.get('ok'):
                with self.lock:
                    self.inbox.extend(r.get('msgs') or [])
                    self.seq = r.get('seq', self.seq)
            else:
                time.sleep(0.5)

    def send(self, to, data):
        return post('/api/send', {'code': self.code, 'peer': self.pid,
                                  'token': self.token, 'to': to, 'data': data})

    def take(self, pred=None, timeout=6.0):
        """等待并取出一条（或全部符合条件的）消息。"""
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self.lock:
                for i, m in enumerate(self.inbox):
                    if pred is None or pred(m):
                        return self.inbox.pop(i)
            time.sleep(0.02)
        return None

    def take_all(self, pred=None, timeout=3.0):
        deadline = time.time() + timeout
        out = []
        while time.time() < deadline:
            with self.lock:
                keep = []
                for m in self.inbox:
                    (out if (pred is None or pred(m)) else keep).append(m)
                self.inbox = keep
            if out:
                break
            time.sleep(0.02)
        return out

    def drain(self):
        time.sleep(0.35)
        with self.lock:
            self.inbox = []

    def stop(self):
        self.running = False


def create(name='房主'):
    st, r = post('/api/create', {'name': name})
    assert r.get('ok'), r
    return Peer(r, name)


def join(code, name='玩家', spectator=False):
    st, r = post('/api/join', {'code': code, 'name': name, 'spectator': spectator})
    assert r.get('ok'), r
    return Peer(r, name)


# ---------------------------------------------------------------- 测试

def main():
    print('\n测试目标：%s\n' % BASE)

    # --- 0. 静态服务 ---
    print('静态服务')
    try:
        st, hd, body = get_raw('/')
        check('GET / 返回 200', st == 200)
        check('HTML 带 charset=utf-8', 'charset=utf-8' in (hd.get('Content-Type') or ''))
        check('首页是中文的（没有乱码）', '东秦杀' in body.decode('utf-8'))
        check('静态响应带 no-store（手机不会拿旧文件）',
              'no-store' in (hd.get('Cache-Control') or ''))
        check('静态响应带 CORS 头', hd.get('Access-Control-Allow-Origin') == '*')
    except Exception as e:
        check('GET / 能访问', False, repr(e))

    for path, needle in [('/js/data.js', 'GameData'),
                         ('/js/engine.js', 'Engine'),
                         ('/css/style.css', '--'),
                         ('/css/mobile.css', 'max-width')]:
        try:
            st, _hd, body = get_raw(path)
            check('静态文件 %s 可访问且内容正确' % path,
                  st == 200 and needle in body.decode('utf-8'))
        except Exception as e:
            check('静态文件 %s 可访问' % path, False, repr(e))

    # --- 1. 建房 / 加入 ---
    print('\n房间与身份')
    host = create()
    check('建房返回 4 位房间号', len(host.code) == 4 and host.code.isdigit(), host.code)

    st, r = post('/api/join', {'code': '99999x', 'name': 'x'})
    check('加入不存在的房间返回 404', st == 404, st)

    st, r = post('/api/poll', {'code': host.code, 'peer': host.pid,
                               'token': 'wrong-token', 'since': 0})
    check('错误 token 被拒绝（403）', st == 403, st)

    st, r = post('/api/join', {'code': host.code, 'name': '小明'})
    check('加入房间成功', r.get('ok') and r.get('peer') != host.pid)

    # --- 2. 长轮询唤醒 ---
    print('\n长轮询')
    t0 = time.time()
    st, r = post('/api/poll', {'code': host.code, 'peer': host.pid,
                               'token': host.token, 'since': 10 ** 9})
    dt = time.time() - t0
    check('无消息时超时返回空', r.get('ok') and r.get('msgs') == [] and dt > 2, 'dt=%.2f' % dt)

    p1 = join(host.code, '小美')
    host.drain()
    p1.drain()

    # 挂起一个 poll，另一边发消息，测唤醒延迟
    result = {}

    def waiter():
        t = time.time()
        st, r = post('/api/poll', {'code': host.code, 'peer': host.pid,
                                   'token': host.token, 'since': host.seq})
        result['dt'] = time.time() - t
        result['r'] = r

    th = threading.Thread(target=waiter, daemon=True)
    th.start()
    time.sleep(0.6)                       # 确保 poll 已经挂上
    p1.send('host', {'t': 'ping', 'n': 1})
    th.join(timeout=10)
    check('新消息能立刻唤醒挂起的长轮询（<2 秒）',
          result.get('dt', 99) < 2 and len(result.get('r', {}).get('msgs') or []) == 1,
          result.get('dt'))

    # --- 3. 游标语义 ---
    print('\n游标与顺序')
    p2 = join(host.code, '小刚')
    host.drain()
    p2.drain()
    for i in range(5):
        p2.send('host', {'t': 'seq', 'n': i})
    got = []
    deadline = time.time() + 6
    while len(got) < 5 and time.time() < deadline:
        m = host.take(lambda m: m['data'].get('t') == 'seq', timeout=2)
        if m:
            got.append(m['data']['n'])
    check('消息按发送顺序到达，不重不漏', got == [0, 1, 2, 3, 4], got)

    host.drain()
    p2.send('host', {'t': 'dup', 'n': 99})
    host.take(lambda m: m['data'].get('t') == 'dup', timeout=4)
    st, r = post('/api/poll', {'code': host.code, 'peer': host.pid, 'token': host.token,
                               'since': 0, 'timeout': 0})
    seen = [m['data'].get('n') for m in (r.get('msgs') or []) if m['data'].get('t') == 'dup']
    check('用旧游标重放不会丢消息', seen == [99], seen)

    # --- 4. 路由 ---
    print('\n消息路由')
    host.drain()
    p1.drain()
    p2.drain()
    p1.send('all', {'t': 'broadcast'})
    check('to=all 能到达房主', host.take(lambda m: m['data'].get('t') == 'broadcast', 4) is not None)
    check('to=all 能到达其他玩家', p2.take(lambda m: m['data'].get('t') == 'broadcast', 4) is not None)
    check('to=all 不会回声给发送者', p1.take(lambda m: m['data'].get('t') == 'broadcast', 1.5) is None)

    host.drain()
    p1.drain()
    p2.drain()
    p2.send(p1.pid, {'t': 'private'})
    check('to=<peerId> 只有目标收得到', p1.take(lambda m: m['data'].get('t') == 'private', 4) is not None)
    check('to=<peerId> 其他人收不到',
          host.take(lambda m: m['data'].get('t') == 'private', 1.2) is None
          and p2.take(lambda m: m['data'].get('t') == 'private', 1.2) is None)

    host.drain()
    p2.drain()
    p1.send('host', {'t': 'onlyhost'})
    check('to=host 只有房主收得到',
          host.take(lambda m: m['data'].get('t') == 'onlyhost', 4) is not None
          and p2.take(lambda m: m['data'].get('t') == 'onlyhost', 1.2) is None)

    # --- 5. 加入/离开通知 ---
    print('\n成员变动通知')
    host.drain()
    p3 = join(host.code, '小红')
    m = host.take(lambda m: m['data'].get('t') == 'joined', 5)
    check('有人加入时房主收到通知', m is not None and m['data'].get('name') == '小红',
          m and m['data'])

    host.drain()
    post('/api/leave', {'code': host.code, 'peer': p3.pid, 'token': p3.token})
    m = host.take(lambda m: m['data'].get('t') == 'left', 5)
    check('有人离开时房主收到通知', m is not None and m['data'].get('peer') == p3.pid)

    # --- 6. 旁观 ---
    print('\n旁观席')
    spec = join(host.code, '看客', spectator=True)
    m = host.take(lambda m: m['data'].get('t') == 'joined', 5)
    check('旁观者加入时带 spectator 标记', m is not None and m['data'].get('spectator') is True)

    # --- 7. 重连 ---
    print('\n断线重连')
    st, r = post('/api/rejoin', {'code': host.code, 'peer': p1.pid, 'token': p1.token})
    check('用 token 能认领回原身份（peerId 不变）',
          r.get('ok') and r.get('peer') == p1.pid, r)
    st, r = post('/api/rejoin', {'code': host.code, 'peer': p1.pid, 'token': 'bad'})
    check('错误 token 不能认领身份', st == 403, st)

    # --- 8. 并发：挂着一堆 poll 时静态服务仍然正常 ---
    print('\n并发')
    held = []
    for _ in range(8):
        t = threading.Thread(target=lambda: post('/api/poll', {
            'code': host.code, 'peer': host.pid, 'token': host.token,
            'since': 10 ** 9}), daemon=True)
        t.start()
        held.append(t)
    time.sleep(0.4)
    t0 = time.time()
    try:
        st, _hd, _body = get_raw('/js/engine.js')
        dt = time.time() - t0
        check('挂着 8 个长轮询时静态文件仍能正常返回', st == 200 and dt < 3, 'dt=%.2f' % dt)
    except Exception as e:
        check('挂着 8 个长轮询时静态文件仍能正常返回', False, e)

    # --- 收尾 ---
    for p in (host, p1, p2, spec):
        p.stop()
    for t in held:
        t.join(timeout=30)

    print('\n' + '=' * 52)
    print('  通过 %d 项，失败 %d 项' % (len(PASS), len(FAIL)))
    if FAIL:
        print('  失败：' + '、'.join(FAIL))
    print('=' * 52 + '\n')
    return 1 if FAIL else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('\n中断。')
        sys.exit(130)
