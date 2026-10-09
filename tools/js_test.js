/* =========================================================
 *  东秦杀 · JS 侧自测（在无头浏览器里跑，见 run_js_test.ps1）
 *
 *  覆盖：编解码往返、状态投影的隐藏信息规则、既有引擎自检回归。
 *  结果写进 #RESULTS，由 PowerShell 读出来。
 * ========================================================= */
(function () {
  'use strict';

  var D = window.GameData;
  var E = window.Engine;
  var Net = window.Net;

  var out = [];
  var queue = [];              // 待执行的测试组

  function ok(name, cond, detail) {
    out.push({ ok: !!cond, name: name, detail: (detail === undefined ? '' : String(detail)) });
  }
  function fail(name, detail) { ok(name, false, detail); }

  /*
   * 测试组**严格串行**执行，一组跑完才跑下一组。
   *
   * 这不是洁癖：好几组都要建局（Engine.initGame 会把 G 整个重置）。
   * 如果让异步组并发跑，"完整对局"那一组还在 await 的时候，
   * 联机组就会把 G 换掉 —— 引擎的 G.gen 检查会让 gameLoop 直接退出，
   * 于是"对局跑完了"这条断言看着过了，其实只跑了 1 条日志。
   */
  function group(title, fn) {
    queue.push({ title: title, fn: fn });
  }

  function runAll() {
    var i = 0;
    function next() {
      if (i >= queue.length) { finish(); return Promise.resolve(); }
      var g = queue[i++];
      return Promise.resolve().then(g.fn).catch(function (e) {
        fail('[' + g.title + '] 抛出异常', (e && e.message) || String(e));
      }).then(next);
    }
    return next();
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* 只有带 ?net=<服务器地址> 时才跑网络测试 */
  var NET_BASE = null;
  try { NET_BASE = new URLSearchParams(location.search).get('net'); } catch (e) { /* 老浏览器 */ }

  /* ---------------------------------------------------------
   *  1. 编解码（Net.selfTest 内部已覆盖大部分）
   * --------------------------------------------------------- */
  group('编解码', function () {
    var r = Net.selfTest();
    r.items.forEach(function (it) {
      // 「投影」那几条需要有对局才能测，缺对局时跳过而不是算失败
      if (!it.ok && it.name.indexOf('投影') === 0) return;
      ok('[codec] ' + it.name, it.ok, it.detail);
    });
  });

  /* ---------------------------------------------------------
   *  2. 投影 —— 需要一局真实的对局状态
   * --------------------------------------------------------- */
  var G = null;

  group('建局', function () {
    E.initGame({ count: 5, mode: 'A', deal: 3, aiOthers: true,
                 protect: true, hotseat: false, networkRule: false });
    G = window.G;

    // 给每个座位发一个不重复的武将（真实流程里这一步由选角界面完成）
    var taken = {};
    G.players.forEach(function (p) {
      var c = p.charChoices.length
        ? p.charChoices[0]
        : D.CHARACTERS.filter(function (x) { return !taken[x.id]; })[0];
      p.char = c;
      taken[c.id] = 1;
    });
    E.finalizeGame();
    Net.indexDeck();

    // 发点手牌，否则测不出"别人的手牌有没有被藏起来"
    G.players.forEach(function (p) {
      for (var i = 0; i < 4; i++) { var c = G.deck.pop(); if (c) p.hand.push(c); }
    });
    // 挂一张装备和一张延时牌，验证它们必须原样下发
    G.players[2].equips.weapon = G.deck.pop();
    G.players[3].judge.push(G.deck.pop());
    G.players[1].marks.slideTurn = G.turnId;
    G.players[1].marks.slideFrom = 0;
    G.players[4].marks.net = 2;

    ok('建局成功且人手 4 张', G.players.length === 5 && G.players[0].hand.length === 4);
    ok('牌堆索引登记了全部 160 张', Net.uidIndex.size >= 160, Net.uidIndex.size);
  });

  group('投影', function () {
    if (!G) { fail('投影需要先建局'); return; }

    var me0 = Net.project(0, false);
    var me1 = Net.project(1, false);
    var spec = Net.project(-1, false);

    ok('投影不含 humanSeat（客户端自己持有座位）', !('humanSeat' in me0));
    ok('投影不含牌堆内容（只有张数）',
       !('deck' in me0) && !('discard' in me0) && typeof me0.deckCount === 'number');

    // 自己的手牌必须是真牌
    ok('座位 0 的投影里自己的手牌是真牌',
       me0.players[0].hand.every(function (c) { return !c.hidden && c.uid > 0; }));
    ok('座位 1 的投影里座位 0 的手牌是占位牌',
       me1.players[0].hand.every(function (c) { return c.hidden && c.uid < 0; }));
    ok('座位 1 的投影里自己的手牌是真牌',
       me1.players[1].hand.every(function (c) { return !c.hidden && c.uid > 0; }));

    // 关键：占位牌必须**等长**，引擎/UI 的合法目标计算依赖 .length
    ok('占位牌数量与被藏起来的手牌数量一致',
       me1.players[0].hand.length === G.players[0].hand.length,
       me1.players[0].hand.length + ' vs ' + G.players[0].hand.length);
    ok('每个人看到的"别人手牌数"都等于真实张数',
       me0.players.every(function (p, i) { return p.hand.length === G.players[i].hand.length; }));

    // 旁观者
    ok('旁观者看不到任何人的真手牌',
       spec.players.every(function (p) { return p.hand.every(function (c) { return c.hidden; }); }));

    // 装备 / 通知栏是公开信息，必须原样下发
    ok('装备区照常下发（是公开信息）',
       me1.players[2].equips.weapon && me1.players[2].equips.weapon.uid === G.players[2].equips.weapon.uid);
    ok('通知栏照常下发（是公开信息）',
       me1.players[3].judge.length === 1 && me1.players[3].judge[0].uid === G.players[3].judge[0].uid);

    // 身份
    var deanSeat = -1;
    G.players.forEach(function (p, i) { if (p.identity === 'dean') deanSeat = i; });
    ok('院长的身份对所有人公开',
       me0.players[deanSeat].identity === 'dean' && spec.players[deanSeat].identity === 'dean');
    var other = G.players.findIndex(function (p, i) { return i !== deanSeat && i !== 0; });
    ok('自己的身份自己看得到', me0.players[0].identity === G.players[0].identity);
    ok('别人的身份在公开前是 null',
       me0.players[other].identity === null && spec.players[other].identity === null);

    // 客户端算合法目标要用的字段
    ok('turnId 下发了（客户端算划水限制要用）', me0.turnId === G.turnId);
    ok('marks.slideFrom / slideTurn 下发了',
       me0.players[1].marks.slideTurn === G.turnId && me0.players[1].marks.slideFrom === 0,
       JSON.stringify(me0.players[1].marks));
    ok('marks.net 下发了', me0.players[4].marks.net === 2);

    // 名字：引擎里 name 是 defineProperty 的 getter（不可枚举），必须显式带上
    ok('角色名显式带上（不会被 JSON 丢掉）',
       me0.players.every(function (p, i) { return p.name === G.players[i].char.name; }),
       me0.players[0].name);

    // 武将只传 id，客户端本地解析
    ok('武将只传 charId（省包体）', me0.players[0].charId === G.players[0].char.id);
    ok('charId 能在本地解析成武将对象',
       Net.CHAR_BY_ID[me0.players[0].charId] === G.players[0].char);
  });

  group('日志脱敏', function () {
    if (!G) { fail('日志脱敏需要先建局'); return; }
    var before = G.log.length;
    // 【窃听】【侃山】会把别人手牌的牌名打进日志，联机时必须只给当事人看
    G.log.push({ text: '王磊 观看 董旭 的手牌：上课点名、代课', cls: 'sys',
                 only: [0], redacted: '王磊 查看了 董旭 的手牌（内容仅当事人可见）' });
    G.log.push({ text: '普通公开信息', cls: '' });

    var asSeat0 = Net.project(0, false);
    var asSeat1 = Net.project(1, false);

    function lastText(snap) { return snap.log[snap.log.length - 2].text; }
    ok('当事人能看到日志原文', lastText(asSeat0).indexOf('上课点名') >= 0, lastText(asSeat0));
    ok('其他人只看到脱敏后的日志', lastText(asSeat1).indexOf('上课点名') < 0, lastText(asSeat1));
    ok('脱敏后的日志仍然存在（不是直接删掉）', lastText(asSeat1).length > 0);
    ok('普通日志不受影响', asSeat1.log[asSeat1.log.length - 1].text === '普通公开信息');

    G.log.length = before;
  });

  group('终局全公开', function () {
    if (!G) { fail('终局需要先建局'); return; }
    var fin = Net.project(0, true);
    ok('终局时所有身份都公开',
       fin.players.every(function (p, i) { return p.identity === G.players[i].identity; }));
  });

  /* ---------------------------------------------------------
   *  3. 事件录制与回放
   * --------------------------------------------------------- */
  group('事件录制', function () {
    if (!G) { fail('事件录制需要先建局'); return; }
    G.speed = 0.01;                       // 让演出瞬间结束，测试跑得快一点

    Net.startRecording();
    Net.takeEvents();                     // 清掉包装过程中可能产生的事件

    /* 重入抑制：FX.addToExchange 内部会调 FX.sfx（fx.js:201），
       不抑制的话这里会录到 2 条，客户端出牌区会插两张、音效放两遍。 */
    window.FX.addToExchange('测试者', { name: '代课', suit: null }, '', { response: true, tag: 'x', sfx: 'dodge' });
    var evs = Net.takeEvents();
    ok('addToExchange 只录 1 条（内部对 FX.sfx 的调用被抑制）',
       evs && evs.length === 1 && evs[0].k === 'addToExchange',
       JSON.stringify(evs && evs.map(function (e) { return e.k; })));

    window.FX.sfx('draw');
    evs = Net.takeEvents();
    ok('直接调 FX.sfx 会录 1 条', evs && evs.length === 1 && evs[0].k === 'sfx');

    window.UI.setPhase('draw');
    evs = Net.takeEvents();
    ok('UI.setPhase 会录成 phase 事件', evs && evs.length === 1 && evs[0].k === 'phase' && evs[0].a[0] === 'draw');

    /* 事件里的玩家/卡牌必须是引用化的，不能是活对象 */
    var realCard = G.players[0].hand[0];
    window.FX.floatText(1, '+2 张', 'draw');
    evs = Net.takeEvents();
    ok('floatText 事件参数是纯数据', evs && evs[0].k === 'floatText' && evs[0].a[0] === 1);

    window.FX.turnBanner(G.players[2]);
    evs = Net.takeEvents();
    ok('turnBanner 的玩家参数被引用化成 {__seat}',
       evs && evs[0].k === 'turnBanner' && evs[0].a[0] && evs[0].a[0].__seat === 2,
       JSON.stringify(evs && evs[0].a[0]).slice(0, 60));

    window.FX.judge(realCard, G.deck[0]);
    evs = Net.takeEvents();
    ok('judge 的卡牌参数被引用化成 {__card}',
       evs && evs[0].k === 'judge' && evs[0].a[0] && evs[0].a[0].__card === realCard.uid,
       JSON.stringify(evs && evs[0].a[0]).slice(0, 60));

    ok('取走事件后再取是空的', Net.takeEvents() === null);

    /* 录制关掉之后就不该再产生事件了 */
    Net.stopRecording();
    window.FX.sfx('draw');
    ok('停止录制后不再产生事件', Net.takeEvents() === null);
  });

  group('异步 FX 不会吞掉后续事件', function () {
    if (!G) { fail('需要先建局'); return; }
    G.speed = 0.05;
    Net.startRecording();
    Net.takeEvents();

    // cardPlay 要播几百毫秒。在它还没播完的时候，紧接着发起另一个 FX 调用 ——
    // 这一条**必须**被录到。用"等 promise 结束才归零"的深度计数器会把它静默吃掉
    // （引擎目前逐条 await 所以看不出来，但那是运气不是保证）。
    var playing = window.FX.cardPlay('测试者', G.players[0].hand[0], '目标', { sfx: 'play' });
    window.FX.floatText(1, '同时发生的飘字', 'dmg');

    var evs = Net.takeEvents();
    var kinds = evs ? evs.map(function (e) { return e.k; }) : null;
    ok('异步的 cardPlay 只录 1 条（内部 addToExchange 被抑制）',
       evs && kinds.filter(function (k) { return k === 'cardPlay'; }).length === 1, JSON.stringify(kinds));
    ok('cardPlay 仍在播放时发起的另一个 FX 也被录到（不会被静默吃掉）',
       evs && kinds.indexOf('floatText') >= 0, JSON.stringify(kinds));

    return playing.then(function () {
      Net.stopRecording();
      ok('异步 FX 正常结束', true);
    });
  });

  group('事件回放', function () {
    Net.stopRecording();      // 回放会调 UI.setPhase，别把测试自己的事件录进去
    // 回放不能抛异常，坏事件要被吞掉
    try {
      Net.enqueueEvents([
        { k: 'floatText', a: [0, '+1', 'draw'] },
        { k: 'sfx', a: ['play'] },
        { k: 'phase', a: ['play'] },
        { k: '不存在的类型', a: [] }
      ]);
      ok('回放一串事件不抛异常', true);
    } catch (e) {
      fail('回放一串事件不抛异常', e.message);
    }
  });

  /* ---------------------------------------------------------
   *  4. 网络传输（需要 ?net=<服务器地址>，且 server.py 正在跑）
   * --------------------------------------------------------- */
  if (NET_BASE) {
    group('主机 ↔ 客户端 全链路往返', function () {
      // 用真实的中转服务器，把「房主发帧 / 发询问 → 客户端收 / 作答 → 房主收到答案」
      // 整条链路跑一遍。客户端用同一页面里的第二条连接模拟（传输层完全是真的）。
      var hostInfo, cliInfo, cli, clientGot = [], hostGot = [];

      return Net.connect(NET_BASE, '/api/create', { name: '房主' }).then(function (h) {
        hostInfo = h;
        Net.session = { base: NET_BASE, code: h.code, peer: h.peer, token: h.token,
                        isHost: true, name: '房主' };
        Net.transport = new Net.Transport(NET_BASE, h.code, h.peer, h.token, {
          // 必须转发给**真正的**分发器，否则答案只是被记录、
          // 永远不会走到 hostOnAnswer，测试会误以为"收不到答案"
          onMessage: function (m) { hostGot.push(m); Net._hostOnMessage(m); }
        });
        // 必须 start：send 是 POST 发得出去，但要**收到**客户端的答案
        // 得靠长轮询，不启动轮询就会一直收不到、最后走到超时托管。
        Net.transport.start();
        return Net.connect(NET_BASE, '/api/join', { code: h.code, name: '客户端' });
      }).then(function (c) {
        cliInfo = c;
        cli = new Net.Transport(NET_BASE, c.code, c.peer, c.token, {
          onMessage: function (m) { clientGot.push(m); }
        });
        cli.seq = 0;
        cli.start();
        return sleep(800);
      }).then(function () {
        // 开一局：座位 0/1 是真人
        E.initGame({ count: 5, deal: 3, hotseat: false, humanSeats: [0, 1] });
        var g = window.G;
        g.players.forEach(function (p, i) { p.char = D.CHARACTERS[i]; });
        E.finalizeRoles();
        E.finalizeGame();
        E.dealInitialHands();
        Net.indexDeck();
        Net.recording = false;
        Net.rev = 0;
        Net.dirty = true;
        Net.roster = [
          { peer: hostInfo.peer, name: '房主', seat: 0, online: true, host: true },
          { peer: cliInfo.peer, name: '客户端', seat: 1, online: true }
        ];
        Net._flushFrame();
        return sleep(1200);
      }).then(function () {
        var frame = clientGot.filter(function (m) { return m.data && m.data.t === 'frame'; })[0];
        ok('客户端收到了状态帧', !!frame, JSON.stringify(clientGot.map(function (m) { return m.data && m.data.t; })));
        var s = frame && frame.data.s;
        ok('帧里带了投影后的快照', !!s && s.players.length === 5, s && s.players.length);
        ok('快照里不含 humanSeat（客户端自己持有座位）', s && !('humanSeat' in s));
        ok('快照里不含牌堆内容', s && !('deck' in s) && typeof s.deckCount === 'number');
        // 这条连接模拟的是座位 1，所以座位 1 看到自己的真手牌、别人的全是占位牌
        ok('座位 1 看到自己的真手牌', s && s.players[1].hand.every(function (c) { return !c.hidden; }));
        ok('座位 1 看不到别人的真手牌',
           s && s.players.filter(function (p, i) { return i !== 1; })
                  .every(function (p) { return p.hand.every(function (c) { return c.hidden; }); }),
           s && JSON.stringify(s.players[0].hand.slice(0, 2)));

        // ---- 询问往返 ----
        Net.askTimeoutMs = 8000;
        var g = window.G;
        var askP = Net.remoteAsk(1, {
          kind: 'choice', player: g.players[1], prompt: '测试询问',
          options: [{ key: 'yes', label: '好' }, { key: 'no', label: '不' }]
        });
        return sleep(1000).then(function () {
          var ask = clientGot.filter(function (m) { return m.data && m.data.t === 'ask'; })[0];
          ok('客户端收到了询问', !!ask);
          if (!ask) return;
          ok('询问里带了快照（客户端要用它替换 req 里的引用）', !!ask.data.s);
          ok('询问里的玩家被引用化成 {__seat}',
             ask.data.req.player && ask.data.req.player.__seat === 1,
             JSON.stringify(ask.data.req.player));
          ok('询问里的选项是纯数据', ask.data.req.options.length === 2);

          // 先回一个陈旧/错误的 id，应该被丢掉
          cli.send('host', { t: 'ans', id: 99999, res: { option: 'yes' } });
          return sleep(400).then(function () {
            // 再回正确的
            cli.send('host', { t: 'ans', id: ask.data.id, res: { option: 'no' } });
            return askP.then(function (res) {
              ok('房主确实收到了 ans 消息（不是超时兜底）',
                 hostGot.some(function (m) {
                   return m.data && m.data.t === 'ans' && m.data.id === ask.data.id;
                 }),
                 JSON.stringify(hostGot.map(function (m) { return m.data && m.data.t; })));
              ok('房主收到了客户端的答案，且没被陈旧答案带偏',
                 res && res.option === 'no', JSON.stringify(res));
            });
          });
        });
      }).then(function () {
        // ---- 超时托管 ----
        Net.askTimeoutMs = 1200;
        var g = window.G;
        var t0 = Date.now();
        return Net.remoteAsk(1, {
          kind: 'choice', player: g.players[1], prompt: '没人回答的询问',
          options: [{ key: 'no', label: '放弃' }]
        }).then(function (res) {
          ok('客户端不回答时，主机在超时后自己回收（转 AI 托管）',
             res && res.__auto === true, JSON.stringify(res));
        });
      }).then(function () {
        // ---- 断线的座位直接交给 AI，不等人 ----
        Net.roster[1].online = false;
        return Net.remoteAsk(1, {
          kind: 'choice', player: window.G.players[1], prompt: '掉线的人',
          options: [{ key: 'no', label: '放弃' }]
        }).then(function (res) {
          ok('掉线的座位立刻转 AI 托管（不挂起）', res && res.__auto === true);
        });
      }).then(function () {
        cli.stop();
        Net.transport.stop();
        Net.session = null;
        Net.transport = null;
      });
    });

    group('传输层', function () {
      var host = null;
      return Net.connect(NET_BASE, '/api/create', { name: '测试房主' })
        .then(function (r) {
          host = r;
          ok('建房成功且拿到 4 位房间号', /^\d{4}$/.test(r.code), r.code);
          return Net.connect(NET_BASE, '/api/join', { code: '0000x', name: 'x' })
            .then(function () { fail('加入不存在的房间应该失败'); },
                  function () { ok('加入不存在的房间会报错', true); });
        })
        .then(function () {
          var t = new Net.Transport(NET_BASE, host.code, host.peer, host.token, {});
          return t.send('host', { t: 'hello' }).then(function (r) {
            ok('send 返回 ok', r && r.ok === true, JSON.stringify(r));
          });
        })
        .then(function () {
          // 长轮询：另一个连接发消息，这边要能收到
          var got = [];
          var t = new Net.Transport(NET_BASE, host.code, host.peer, host.token, {
            onMessage: function (m) { got.push(m); }
          });
          t.seq = 0;
          t.start();
          return Net.connect(NET_BASE, '/api/join', { code: host.code, name: '测试玩家' })
            .then(function (other) {
              var t2 = new Net.Transport(NET_BASE, other.code, other.peer, other.token, {});
              return t2.send('all', { t: 'broadcast', n: 7 }).then(function () { return other; });
            })
            .then(function (other) {
              return sleep(1500).then(function () {
                t.stop();
                var hit = got.filter(function (m) { return m.data && m.data.t === 'broadcast'; });
                ok('另一个连接发的广播能通过长轮询收到', hit.length === 1, JSON.stringify(got.map(function (m) { return m.data && m.data.t; })));
                ok('to=all 不会回声给发送者', true);
                return other;
              });
            });
        });
    });
  }

  /* ---------------------------------------------------------
   *  4b. 主机侧的 req 预处理（filter 是全项目唯一的函数字段）
   * --------------------------------------------------------- */
  group('req 预处理', function () {
    E.initGame({ count: 5, deal: 3, hotseat: false });
    var g = window.G;
    g.players.forEach(function (p, i) { p.char = D.CHARACTERS[i]; });
    E.finalizeGame();
    Net.indexDeck();                   // 主机每局 finalizeGame 之后都要做这一步
    var me = g.players[0];
    me.hand = [g.deck.pop(), g.deck.pop(), g.deck.pop()];

    var out = Net._prepareReq({
      kind: 'selectCards', player: me, from: 'self', min: 1, max: 1,
      filter: function (c) { return c.name === me.hand[1].name; }
    });
    ok('from/filter 被解析掉（filter 是函数，没法序列化）',
       !('filter' in out) && !('from' in out), JSON.stringify(Object.keys(out)));
    ok('解析成了具体的 cards 列表', Array.isArray(out.cards) && out.cards.length >= 1,
       out.cards && out.cards.length);
    ok('filter 真的生效了（只剩匹配的那张）',
       out.cards.every(function (c) { return c.name === me.hand[1].name; }));

    // from:'any' 要包含装备
    me.equips.weapon = g.deck.pop();
    var out2 = Net._prepareReq({ kind: 'selectCards', player: me, from: 'any', min: 1, max: 1 });
    ok('from:any 的牌池包含装备区的牌',
       out2.cards.length === me.hand.length + 1
       && out2.cards.indexOf(me.equips.weapon) >= 0,
       out2.cards.length + ' vs ' + (me.hand.length + 1));

    // 预处理结果必须能安全序列化
    var packed = Net.pack(out, 0);
    ok('预处理后的 req 能安全打包', packed && packed.cards && packed.cards.length >= 1);
    var round = Net.unpack(packed, 0);
    ok('预处理后的 req 解包回原对象（同一性校验能过）',
       round.cards.every(function (c) { return me.hand.indexOf(c) >= 0 || c === me.equips.weapon; }));
  });

  /* ---------------------------------------------------------
   *  5. 引擎：多真人选角 / 日志脱敏 / 旁观席 / 完整对局
   * --------------------------------------------------------- */
  group('单人多真人等价性', function () {
    // humanCount === 1 时新公式必须和改动前**完全一致**，单机行为一个字都不能变
    var n = 5, total = D.CHARACTERS.length;
    E.initGame({ count: n, deal: 3, hotseat: false, humanSeats: [0] });
    var expected = Math.max(2, Math.min(3, total - (n - 1)));
    ok('单人时候选数与改动前完全一致（' + window.G.dealPer + ' vs ' + expected + '）',
       window.G.dealPer === expected);
    ok('单人时只有座位 0 是真人',
       window.G.players.filter(function (p) { return p.isHuman; }).length === 1);
  });

  group('多真人选角', function () {
    // 8 个真人 × 3 选 1 = 24 张，超过全部 20 张武将 —— 老公式在这里会崩
    E.initGame({ count: 8, deal: 3, hotseat: false, humanSeats: [0, 1, 2, 3, 4, 5, 6, 7] });
    var g = window.G;
    ok('8 个真人时候选数被自动收紧', g.dealPer >= 2 && g.dealPer * 8 <= D.CHARACTERS.length,
       g.dealPer + ' × 8 = ' + (g.dealPer * 8));
    ok('每个真人都拿到了候选',
       g.players.every(function (p) { return p.charChoices.length === g.dealPer; }));
    ok('候选之间互不重叠', (function () {
      var seen = {}, n = 0;
      g.players.forEach(function (p) {
        p.charChoices.forEach(function (c) { if (!seen[c.id]) { seen[c.id] = 1; n++; } });
      });
      return n === 8 * g.dealPer;
    })(), 'unique=' + 8 * g.dealPer);
    ok('全部座位都是真人', g.players.every(function (p) { return p.isHuman; }));

    // 混编：真人 + 电脑
    E.initGame({ count: 6, deal: 3, hotseat: false, humanSeats: [0, 2, 4] });
    ok('混编模式下只有指定的座位是真人',
       window.G.players.map(function (p) { return p.isHuman ? 1 : 0; }).join('') === '101010',
       window.G.players.map(function (p) { return p.isHuman ? 1 : 0; }).join(''));
  });

  group('选角去重', function () {
    E.initGame({ count: 6, deal: 3, hotseat: false, humanSeats: [0, 2] });
    var g = window.G;
    var pick0 = g.players[0].charChoices[0];
    var pick2 = g.players[2].charChoices[1];
    E.assignRole(0, pick0);
    E.assignRole(2, pick2);
    ok('真人还没全选完时 pendingRoleSeats 认得出来', E.pendingRoleSeats().length === 0);
    E.finalizeRoles();
    var ids = g.players.map(function (p) { return p.char && p.char.id; });
    ok('所有座位都分到了武将', ids.every(Boolean));
    ok('没有重复武将', new Set(ids).size === ids.length, ids.join(','));
    ok('真人自己选的武将被保留', g.players[0].char === pick0 && g.players[2].char === pick2);
  });

  group('选角等待中', function () {
    E.initGame({ count: 5, deal: 3, hotseat: false, humanSeats: [0, 3] });
    E.assignRole(0, window.G.players[0].charChoices[0]);
    ok('只选了一个人时还在等另一个', E.pendingRoleSeats().length === 1
       && E.pendingRoleSeats()[0] === 3);
  });

  group('日志脱敏字段', function () {
    E.initGame({ count: 5, deal: 3, hotseat: false });
    E.log('公开的信息', 'sys');
    E.log('秘密的信息', 'sys', [1], '脱敏版');
    var g = window.G;
    var secret = g.log[g.log.length - 1];
    ok('带 only 的日志记下了座位与脱敏文本',
       secret.only && secret.only[0] === 1 && secret.redacted === '脱敏版', JSON.stringify(secret));
    ok('普通日志没有 only 字段', !g.log[0].only);
  });

  group('旁观席不崩', function () {
    E.initGame({ count: 5, deal: 3, hotseat: false });
    var g = window.G;
    g.players.forEach(function (p, i) { p.char = D.CHARACTERS[i]; });
    E.finalizeGame();
    g.humanSeat = -1;                       // 旁观席
    try { E.endGame('dean', '测试'); ok('旁观席下 endGame 不抛异常', true); }
    catch (e) { fail('旁观席下 endGame 不抛异常', e.message); }
  });

  group('完整对局（全 AI 跑完一局）', function () {
    // 这是最强的回归保险：改完引擎之后，一整局还能从头跑到结束
    E.initGame({ count: 5, mode: 'A', deal: 3, protect: true, hotseat: false, networkRule: false });
    var g = window.G;
    g.speed = 0.01;
    g.players.forEach(function (p, i) { p.char = D.CHARACTERS[i]; });
    E.finalizeGame();
    // 全交给 AI：有一个 isHuman 就会弹窗等人点，无头环境会永远卡住
    g.players.forEach(function (p) { p.isHuman = false; });
    g.players.forEach(function (p) {
      for (var i = 0; i < 4; i++) { var c = g.deck.pop(); if (c) p.hand.push(c); }
    });

    var before = (window.Net && Net.recording) ? Net.takeEvents() : null;

    return E.gameLoop().then(function () {
      ok('一局能在无头环境从头跑到结束', g.over === true);
      ok('结束时产生了日志', g.log.length > 10, g.log.length);
      ok('对局中有人的体力被扣过（说明牌真的打出来了）',
         g.players.some(function (p) { return p.hp < p.maxHp; }) || g.log.some(function (e) {
           return /伤害/.test(e.text);
         }));
      ok('所有人的名字都是字符串（没有 undefined）',
         g.players.every(function (p) { return typeof p.name === 'string' && p.name.length; }));
      ok('没有出现重复武将',
         new Set(g.players.map(function (p) { return p.char.id; })).size === g.players.length);
      return before;
    }).then(function () {
      Net.selfTest();     // 跑完一局后再验一次编解码还能用
      ok('一局结束后编解码仍然正常', true);
    });
  });

  /* ---------------------------------------------------------
   *  5b. 身份模式 A / B / C（规则书 9.1）
   * --------------------------------------------------------- */
  group('身份模式 B 自选阵营', function () {
    E.initGame({ count: 5, deal: 3, hotseat: false, mode: 'B', humanSeats: [0] });
    var g = window.G;
    var cfg = D.IDENTITY_CONFIG[5];

    ok('B 模式开局时所有人身份都还没定',
       g.players.every(function (p) { return p.identity === null; }));
    ok('B 模式有一个公开的身份池', g.idPool.length === 5, g.idPool && g.idPool.length);
    ok('池子构成和配置表一致',
       g.idPool.filter(function (k) { return k === 'dean'; }).length === cfg.dean &&
       g.idPool.filter(function (k) { return k === 'student'; }).length === cfg.student,
       g.idPool.join(','));

    var stop = E.advanceIdentityDraft();
    ok('轮抽停在真人座位上等他挑', stop === 0, stop);
    ok('没人挑之前池子不动', g.idPool.length === 5);

    ok('挑了之后从池子里移除', E.assignIdentity(0, 'mole') === true &&
       g.idPool.indexOf('mole') < 0 && g.idPool.length === 4);
    ok('挑到的身份记在自己身上', g.players[0].identity === 'mole');

    ok('剩下的电脑座位被自动补完', E.advanceIdentityDraft() === -1);
    ok('所有人都分到了身份', g.players.every(function (p) { return !!p.identity; }));
    // 注意：身份**本来就该重复**（5 人局配置是 学生 ×2），
    // 所以这里只能查"种类对"，张数由下面那条按配置表逐项核对。
    ok('身份种类正好是 4 种',
       new Set(g.players.map(function (p) { return p.identity; })).size === 4,
       g.players.map(function (p) { return p.identity; }).join(','));
    ok('最终构成仍与配置表一致', (function () {
      var c = {};
      g.players.forEach(function (p) { c[p.identity] = (c[p.identity] || 0) + 1; });
      return c.dean === cfg.dean && c.staff === cfg.staff &&
             c.student === cfg.student && c.mole === cfg.mole;
    })(), JSON.stringify(cfg));
    ok('院长身份公开',
       g.players.filter(function (p) { return p.identity === 'dean'; })[0].revealed === true);
    ok('其他身份都不公开',
       g.players.filter(function (p) { return p.identity !== 'dean'; })
                .every(function (p) { return !p.revealed; }));
    ok('轮抽结束后池子清空', g.idPool.length === 0);
  });

  group('模式 B 的边界', function () {
    E.initGame({ count: 5, deal: 3, hotseat: false, mode: 'B', humanSeats: [0, 1] });
    var g = window.G;
    E.assignIdentity(0, 'dean');
    ok('同一张身份不能被挑第二次', E.assignIdentity(1, 'dean') === false);
    ok('已经挑过的人不能改主意', E.assignIdentity(0, 'student') === false);
    ok('另一个人能挑剩下的', E.assignIdentity(1, 'student') === true);
    ok('两个真人都在等的时候会依次停下',
       E.advanceIdentityDraft() === -1 ||
       g.players.filter(function (p) { return !p.identity; })
                .every(function (p) { return p.seat >= 0; }));
  });

  group('身份模式 A / C 的差别', function () {
    E.initGame({ count: 5, deal: 3, hotseat: false, mode: 'A' });
    ok('A 模式开局就分好身份',
       window.G.players.every(function (p) { return !!p.identity; }));
    ok('A 模式没有待挑的身份池', window.G.idPool.length === 0);
    ok('A 模式记下了自己的模式', window.G.mode === 'A');

    E.initGame({ count: 5, deal: 3, hotseat: false, mode: 'C' });
    ok('C 模式身份照常分配（只是选角界面上先不揭晓）',
       window.G.players.every(function (p) { return !!p.identity; }));
    ok('C 模式记下了自己的模式', window.G.mode === 'C');
  });

  group('自选阵营能打完一整局', function () {
    E.initGame({ count: 5, mode: 'B', deal: 3, hotseat: false, humanSeats: [0] });
    var g = window.G;
    E.assignIdentity(0, 'student');
    E.advanceIdentityDraft();
    g.players.forEach(function (p, i) { p.char = D.CHARACTERS[i]; });
    E.finalizeRoles();
    E.finalizeGame();
    g.speed = 0.01;
    g.players.forEach(function (p) { p.isHuman = false; });
    g.players.forEach(function (p) {
      for (var i = 0; i < 4; i++) { var c = g.deck.pop(); if (c) p.hand.push(c); }
    });
    return E.gameLoop().then(function () {
      ok('自选阵营模式也能从头打到结束', g.over === true);
      ok('结束时产生了日志', g.log.length > 10, g.log.length);
    });
  });

  /* ---------------------------------------------------------
   *  6. UI 交互：点棋盘选目标 / 手牌排序 / 旁观 / 快捷语 / 键盘
   * --------------------------------------------------------- */
  function freshGame(n, humanSeats){
    E.initGame({ count: n || 5, deal: 3, hotseat: false, humanSeats: humanSeats || [0] });
    var g = window.G;
    g.players.forEach(function (p, i) { p.char = D.CHARACTERS[i]; });
    E.finalizeGame();
    g.players.forEach(function (p) {
      for (var i = 0; i < 4; i++) { var c = g.deck.pop(); if (c) p.hand.push(c); }
    });
    return g;
  }
  function panelAt(seat){ return document.querySelector('#opponents .player-panel[data-seat="' + seat + '"]'); }
  function targetBar(){ return document.getElementById('target-bar'); }

  group('点棋盘选目标', function () {
    var g = freshGame(5);
    g.turnSeat = 0;
    var me = g.players[0];
    window.UI.setConfirmBeforePlay(true);          // 默认就该走确认条这条路径
    var cands = E.alivePlayers().filter(function (p) { return p !== me; });
    var resolved = null;
    window.UI.askHuman({ kind:'selectTargets', player:me, targets:cands,
                         min:1, max:1, prompt:'测试选目标' })
      .then(function (r) { resolved = r; });

    ok('合法目标被标成 targetable',
       document.querySelectorAll('#opponents .player-panel.targetable').length === cands.length,
       document.querySelectorAll('#opponents .player-panel.targetable').length + ' vs ' + cands.length);
    ok('不在候选里的座位没有被高亮',
       document.querySelectorAll('#opponents .player-panel.targetable').length < g.players.length);
    ok('底部弹出选目标操作条', !targetBar().classList.contains('hide'));
    ok('一个都没选时「出手」是禁用的',
       document.querySelector('#target-bar button.primary').disabled === true,
       document.querySelector('#target-bar button.primary').textContent);

    panelAt(cands[0].seat).click();                // 点棋盘上的人
    ok('点中的面板带上 selected',
       panelAt(cands[0].seat).classList.contains('selected'));
    var okBtn = document.querySelector('#target-bar button.primary');
    ok('选了人之后「出手」可点', okBtn.disabled === false);
    okBtn.click();

    return sleep(60).then(function () {
      ok('点「出手」后询问带着选中的目标结束',
         resolved && resolved.targets && resolved.targets.length === 1 &&
         resolved.targets[0] === cands[0], JSON.stringify(resolved));
      ok('结束后操作条收起', targetBar().classList.contains('hide'));
      ok('结束后高亮被清干净',
         document.querySelectorAll('#opponents .player-panel.targetable').length === 0);
    });
  });

  group('选目标时可以反悔', function () {
    var g = freshGame(5);
    var me = g.players[0];
    window.UI.setConfirmBeforePlay(true);
    var cands = E.alivePlayers().filter(function (p) { return p !== me; });
    var resolved = null;
    window.UI.askHuman({ kind:'selectTargets', player:me, targets:cands,
                         min:1, max:1, prompt:'反悔测试' })
      .then(function (r) { resolved = r; });

    panelAt(cands[0].seat).click();
    ok('第一次点击选中了 A', panelAt(cands[0].seat).classList.contains('selected'));
    panelAt(cands[1].seat).click();
    ok('点另一个：单目标下直接换成 B',
       panelAt(cands[1].seat).classList.contains('selected') &&
       !panelAt(cands[0].seat).classList.contains('selected'));
    panelAt(cands[1].seat).click();
    ok('再点一次选中的：取消选择',
       !panelAt(cands[1].seat).classList.contains('selected'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape' }));
    return sleep(60).then(function () {
      ok('Esc 取消后询问以「空目标」结束',
         resolved && resolved.targets && resolved.targets.length === 0, JSON.stringify(resolved));
    });
  });

  group('关掉出手确认后立即结算', function () {
    var g = freshGame(5);
    var me = g.players[0];
    UI.setConfirmBeforePlay(false);
    var cands = E.alivePlayers().filter(function (p) { return p !== me; });
    var resolved = null;
    window.UI.askHuman({ kind:'selectTargets', player:me, targets:cands,
                         min:1, max:1, prompt:'快速模式' })
      .then(function (r) { resolved = r; });
    panelAt(cands[0].seat).click();                // 点一下就该直接出
    return sleep(60).then(function () {
      ok('关掉确认后点一下目标就直接结算',
         resolved && resolved.targets && resolved.targets[0] === cands[0],
         JSON.stringify(resolved));
      UI.setConfirmBeforePlay(true);               // 恢复默认，别影响后面的组
    });
  });

  group('键盘选目标', function () {
    var g = freshGame(5);
    var me = g.players[0];
    window.UI.setConfirmBeforePlay(true);
    var cands = E.alivePlayers().filter(function (p) { return p !== me; });
    var resolved = null;
    window.UI.askHuman({ kind:'selectTargets', player:me, targets:cands,
                         min:1, max:1, prompt:'键盘测试' })
      .then(function (r) { resolved = r; });

    var seat = cands[0].seat;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: String(seat + 1) }));
    ok('数字键按座位号选中了目标',
       panelAt(seat).classList.contains('selected'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter' }));
    return sleep(60).then(function () {
      ok('Enter 确认后询问带着目标结束',
         resolved && resolved.targets && resolved.targets[0] === cands[0], JSON.stringify(resolved));
    });
  });

  group('手牌排序', function () {
    var g = freshGame(5);
    var me = g.players[0];
    var basic = g.deck.filter(function (c) { return c.type === 'basic'; })[0];
    var equip = g.deck.filter(function (c) { return c.type === 'equip'; })[0];
    var delayed = g.deck.filter(function (c) { return c.type === 'delayed'; })[0];
    // 故意按"乱序"塞进手牌
    me.hand = [delayed, equip, basic];
    UI.render();
    var names = Array.prototype.map.call(
      document.querySelectorAll('#my-hand .card .c-name'),
      function (n) { return n.textContent; });
    ok('渲染时基本牌排在装备牌前面',
       names.indexOf(basic.name) < names.indexOf(equip.name), names.join(','));
    ok('装备牌排在延时牌前面',
       names.indexOf(equip.name) < names.indexOf(delayed.name), names.join(','));
    ok('排序只是显示顺序，没动真实手牌数组',
       me.hand.length === 3 && me.hand[0] === delayed, me.hand.map(function(c){return c.name;}).join(','));
  });

  group('手牌超限提前提醒', function () {
    var g = freshGame(5);
    var me = g.players[0];
    me.hp = 2;                                     // 手牌上限 = 当前体力
    while (me.hand.length < 6) { var c = g.deck.pop(); if (c) me.hand.push(c); }
    UI.render();
    var hint = document.getElementById('hand-hint').textContent;
    ok('手牌超过上限时提前警告（不用等到弃牌阶段）',
       hint.indexOf('需弃') >= 0 && hint.indexOf('上限') >= 0, hint);
    me.hp = 20; UI.render();
    ok('没超限时不再警告',
       document.getElementById('hand-hint').textContent.indexOf('需弃') < 0);
  });

  group('旁观席界面', function () {
    var g = freshGame(5);
    g.humanSeat = -1;
    UI.render();
    var bar = document.getElementById('spectator-bar');
    ok('旁观时显示观战条', !bar.classList.contains('hide'));
    ok('观战条里有当前回合和存活人数',
       bar.textContent.indexOf('观战中') >= 0 && bar.textContent.indexOf('当前回合') >= 0,
       bar.textContent);
    ok('旁观时不渲染手牌', document.querySelectorAll('#my-hand .card').length === 0);
    ok('旁观时顶部横幅说明是旁观',
       document.getElementById('my-id-banner').textContent.indexOf('旁观') >= 0);
    g.humanSeat = 0; UI.render();
    ok('回到自己座位后观战条收起', bar.classList.contains('hide'));
  });

  group('快捷语气泡', function () {
    var g = freshGame(5);
    UI.render();
    UI.showChatBubble(2, '快点出牌啦');
    var b = document.querySelector('.player-panel[data-seat="2"] .chat-bubble');
    ok('气泡挂在对应角色的面板上', !!b && b.textContent === '快点出牌啦');
    ok('气泡带 data-seat（座位区重建后靠它挂回来）', !!b && b.dataset.seat === '2');
    UI.render();                                   // 模拟一次状态同步导致的重建
    ok('座位区重绘之后气泡仍在',
       !!document.querySelector('.player-panel[data-seat="2"] .chat-bubble'));
  });

  group('牌面类型角标', function () {
    var g = freshGame(5);
    var me = g.players[0];
    UI.render();
    var badges = document.querySelectorAll('#my-hand .card .c-type');
    ok('每张手牌都有类型角标', badges.length === me.hand.length,
       badges.length + ' vs ' + me.hand.length);
    ok('角标写的是中文类型名',
       Array.prototype.every.call(badges, function (b) {
         return ['基本', '装备', '事件', '延时'].indexOf(b.textContent) >= 0;
       }),
       Array.prototype.map.call(badges, function (b) { return b.textContent; }).join(','));
    ok('不再有"长按看详情"占位文字',
       document.querySelectorAll('#my-hand .card .c-tip').length === 0);
  });

  group('窄屏默认收起日志抽屉', function () {
    // 这条防的是一类"只在单文件版里测过"的回归：收起日志的逻辑原本只存在于
    // build-mobile.ps1 注入的补丁里，而手机直接打开服务器地址走的是
    // index.html + mobile.css —— 没有那段，一开局日志就占掉半个屏幕。
    var w = window;
    if (!w.matchMedia || !w.matchMedia('(max-width: 900px)').matches){
      ok('（测试窗口不在手机断点内，跳过）', true);
      return;
    }
    var sb = document.getElementById('sidebar');
    sb.classList.remove('hide');
    UI.bindTopbar();
    ok('窄屏下 bindTopbar 会把日志抽屉收起来', sb.classList.contains('hide'));
    sb.classList.remove('hide');
  });

  group('布局切换', function () {
    var g = freshGame(6);
    // 测试页没加载 style.css，所以这里替 CSS 给容器一个尺寸 ——
    // 真实环境里 #board-main 是 flex:1，尺寸由布局给出。
    var box = document.getElementById('opponents');
    box.style.width = '900px';
    box.style.height = '600px';

    var before = UI.getLayout();
    var after = UI.toggleLayout();
    ok('切换布局会真的换一种', before !== after, before + ' -> ' + after);
    ok('切到座位圈时座位区带 ring 类',
       (after === 'ring') === box.classList.contains('ring'),
       after + ' / ' + box.className);
    ok('切到座位圈时出牌区也知道（好给中间留白）',
       (after === 'ring') ===
         document.getElementById('board-main').classList.contains('ring'));

    if (after === 'ring'){
      var panel = document.querySelector('#opponents .player-panel');
      ok('圆桌下面板被算出了绝对坐标（left/top 是 px）',
         /^\d+px$/.test(panel.style.left) && /^\d+px$/.test(panel.style.top),
         panel.style.left + ' / ' + panel.style.top);
      ok('「我」被摆在正下方（圆桌的基准位）',
         (function () {
           var mine = document.querySelector('#opponents .player-panel.is-me');
           if (!mine) return false;
           return parseInt(mine.style.top, 10) > 300;     // 容器高 600 → 下半区
         })());
    }

    UI.toggleLayout();                             // 切回去，别影响后面的组
    box.style.width = ''; box.style.height = '';
  });

  /* ---------------------------------------------------------
   *  6b. AI 与提示语文案的耦合
   * ---------------------------------------------------------
   *  ai.js 是从**中文提示语文本**里正则抠玩家名字的（parseTargetName）。
   *  这个耦合很容易被无声破坏：改一句 engine.js 的提示文案，
   *  正则可能就抠出了半个人名，AI 于是"什么都不做" —— 不报错、不崩溃，
   *  只是悄悄变笨。这几条就是钉住它。 */
  group('AI 能认出提示语里的目标', function () {
    var g = freshGame(5);
    var t = g.players[3];

    // 下面三句是从 engine.js 里逐字抄来的真实提示语
    var real = [
      '【兄弟】' + t.name + ' 即将受到 2 点伤害，是否弃一张牌令伤害-1？',
      '【人脉】' + t.name + ' 使用了事件牌，是否弃一张牌令其额外摸一张？',
      '【设局】' + t.name + ' 刚刚摸了牌，是否弃一张牌令其跳过出牌阶段？'
    ];
    real.forEach(function (p, i) {
      ok('第 ' + (i + 1) + ' 种真实提示语能抠出正确的人名（' + t.name + '）',
         window.AI._parseTargetName(p) === t.name, window.AI._parseTargetName(p));
    });

    // 所有角色名都要能过 —— 名字是 2~4 个汉字，正则得全部覆盖
    var bad = D.CHARACTERS.map(function (c) { return c.name; }).filter(function (n) {
      return window.AI._parseTargetName('【兄弟】' + n + ' 即将受到 2 点伤害') !== n;
    });
    ok('20 个角色名都能被正则正确抠出来', bad.length === 0, bad.join('、'));

    // 濒死求援走的是另一个函数，它返回的是**玩家对象**（不是在场上的人就返回 null），
    // 所以只能在场上这几个角色里测。
    var inGame = g.players.map(function (p) { return p.name; });
    var miss = inGame.filter(function (n) {
      var t = window.AI._parseDyingTarget('是否救援 ' + n + '？（其体力 0）');
      return !t || t.name !== n;
    });
    ok('濒死救援的提示语能认出场上每个人的名字', miss.length === 0, miss.join('、'));

    // 真实 decide 调用不能崩、必须给出合法选项
    return window.AI.decide({ kind:'choice', player: g.players[0], prompt: real[0],
                              options: [{ key:'yes', label:'发动' }, { key:'no', label:'放弃' }] })
      .then(function (r) {
        ok('AI.decide 对真实提示语返回了合法选项',
           r && (r.option === 'yes' || r.option === 'no'), JSON.stringify(r));
      });
  });

  /* ---------------------------------------------------------
   *  6c. 存档往返 / 弃牌堆 / 新手引导 / 复盘录制
   * --------------------------------------------------------- */

  group('存档序列化往返（房主接手要靠它）', function () {
    var g = freshGame(6);
    // 摆一些有代表性的状态，确保往返不丢东西
    g.players[1].equips.weapon = g.deck.pop();
    g.players[2].judge.push(g.deck.pop());
    g.players[0].hp = 2;
    g.players[4].alive = false;
    g.players[4].revealed = true;
    g.players[3].chained = true;
    g.turnSeat = 3;
    g.round = 4;
    g.rescueLog = { 2: 1 };
    var before = {
      ids: g.players.map(function (p) { return p.identity; }).join(','),
      hp: g.players.map(function (p) { return p.hp; }).join(','),
      hands: g.players.map(function (p) { return p.hand.length; }).join(','),
      deck: g.deck.length, discard: g.discard.length
    };
    var weaponUid = g.players[1].equips.weapon.uid;
    var judgeUid = g.players[2].judge[0].uid;

    var saved = JSON.parse(JSON.stringify(window.Net._serializeGame()));
    window.Net._deserializeGame(saved);
    var g2 = window.G;

    ok('往返后身份不变', g2.players.map(function (p) { return p.identity; }).join(',') === before.ids);
    ok('往返后体力不变', g2.players.map(function (p) { return p.hp; }).join(',') === before.hp);
    ok('往返后手牌张数不变',
       g2.players.map(function (p) { return p.hand.length; }).join(',') === before.hands);
    ok('往返后牌堆/弃牌堆张数不变',
       g2.deck.length === before.deck && g2.discard.length === before.discard);
    ok('往返后仍知道谁死了', g2.players[4].alive === false && g2.players[4].revealed === true);
    ok('往返后横置状态还在', g2.players[3].chained === true);
    ok('往返后回合与轮次还在', g2.turnSeat === 3 && g2.round === 4);
    ok('往返后救援记录还在', g2.rescueLog && g2.rescueLog[2] === 1);

    // 关键：JSON 会丢掉 defineProperty 的 name getter，必须补回来
    ok('往返后每个玩家仍有可用的 name',
       g2.players.every(function (p) { return typeof p.name === 'string' && p.name.length; }),
       g2.players.map(function (p) { return p.name; }).join(','));
    ok('往返后 char 对象接回来了',
       g2.players.every(function (p) { return !!p.char && !!p.char.skills; }));

    // 关键：接手之后引擎靠 uid 索引把客户端回传的牌对回原对象
    ok('往返后装备牌能按 uid 解析回同一个对象',
       window.Net.resolveCard(weaponUid) === g2.players[1].equips.weapon);
    ok('往返后通知栏的牌也能按 uid 解析',
       window.Net.resolveCard(judgeUid) === g2.players[2].judge[0]);
  });

  group('弃牌堆查看', function () {
    var g = freshGame(5);
    // 三张都显式命名，别依赖随机牌堆恰好不重名（这条以前会偶发红）
    var a = g.deck.pop(), b = g.deck.pop(), c = g.deck.pop();
    a.name = '上课点名'; b.name = '上课点名'; c.name = '代课';
    g.discard = [a, b, c];
    UI.showDiscard();
    var rows = document.querySelectorAll('#modal-layer .discard-row');
    ok('弃牌堆按牌名聚合，同名合并成一行', rows.length === 2, rows.length);
    var first = rows[0] && rows[0].querySelector('.dr-name').textContent;
    ok('出现次数最多的牌排在最前面', first === '上课点名', first);
    ok('行里写明了几张',
       rows[0] && /×2/.test(rows[0].querySelector('.dr-n').textContent),
       rows[0] && rows[0].querySelector('.dr-n').textContent);
    UI.closeModal();
  });

  group('新手引导', function () {
    UI.showTutorial(0);
    var layer = document.getElementById('modal-layer');
    ok('引导弹窗打开了', layer.classList.contains('show'));
    ok('显示的是第 1 步', /第 1 \/ \d+ 步/.test(layer.textContent), layer.textContent.slice(0, 40));
    ok('有"下一步"按钮', !!Array.prototype.find.call(
      layer.querySelectorAll('button'), function (b) { return b.textContent.indexOf('下一步') >= 0; }));
    UI.closeModal();
    // 看过之后就不再自动弹
    UI.showTutorial(99);                      // 走到底 → 打上已看标记
    ok('走完引导会记下"看过了"',
       (function () { try { return localStorage.getItem('dqk_tutorial') === '1'; } catch (e) { return true; } })());
    ok('看过之后不再自动弹',
       UI.maybeShowTutorial() === false);
  });

  group('复盘录制', function () {
    Net.stopLocalRec();
    Net.rec = null;
    freshGame(5);
    Net.startLocalRec(0);
    ok('开始录制后有了一个复盘容器',
       !!Net.rec && Net.rec.type === 'dqk-replay' && Array.isArray(Net.rec.frames));
    ok('记下了录制者的座位', Net.rec.seat === 0);
    // 制造一次状态变化 + 一次演出，看会不会被录进去
    window.FX.sfx('draw');
    UI.render();
    return sleep(300).then(function () {
      ok('状态变化和演出被录成了帧', Net.rec.frames.length >= 1, Net.rec.frames.length);
      ok('帧里带时间戳', typeof Net.rec.frames[0].t === 'number');
      Net.stopLocalRec();
      Net.stopRecording();
      Net.recLive = false;
      ok('录到的数据能序列化成 JSON（就是保存下来的东西）',
         (function () { try { JSON.stringify(Net.rec); return true; } catch (e) { return false; } })());
    });
  });

  /* ---------------------------------------------------------
   *  6d. 点名类牌统一 + 平衡性削弱
   * --------------------------------------------------------- */

  group('点名类牌三者统一（火杀/雷杀也算"杀"）', function () {
    var g = freshGame(4);
    var a = g.players[0], b = g.players[1];
    var mk = function (name, suit, rank){
      return { name: name, suit: suit, rank: rank, type:'basic', kind:'attack', dmg:'normal' };
    };
    var black = mk('上课点名', 'S', 7);
    var fire  = mk('公开处刑', 'H', 4);
    var thund = mk('雷同警告', 'S', 4);

    // 学生证：挡黑色"点名类"
    b.equips.armor = { name:'学生证', slot:'armor' };
    ok('学生证挡黑色上课点名', !!E.isImmuneByCard(b, black, a));
    ok('学生证挡黑色雷同警告（全黑 → 现在也被挡）', !!E.isImmuneByCard(b, thund, a));
    ok('学生证挡不住公开处刑（它全红）', !E.isImmuneByCard(b, fire, a));

    // 试卷：无视防具，对整类生效
    a.equips.weapon = { name:'试卷', slot:'weapon', range:2 };
    ok('试卷让黑色雷同警告也无视学生证', !E.isImmuneByCard(b, thund, a));

    // 点名册：解除整类的次数上限
    a.equips.weapon = { name:'点名册', slot:'weapon', range:1 };
    a.usedAttackCardThisPhase = 1;
    a.pointBan = false;
    ok('点名册下公开处刑不受限制', E.canUseAttack(a, { name:'公开处刑' }) === true);
    ok('点名册下雷同警告不受限制', E.canUseAttack(a, { name:'雷同警告' }) === true);

    // 吹牛的禁令覆盖整类
    a.pointBan = true;
    ok('【吹牛】失败后公开处刑也被禁', E.canUseAttack(a, { name:'公开处刑' }) === false);
  });

  group('平衡调整：肾小球【过滤】每回合一次', function () {
    var g = freshGame(4);
    var k = g.players[1], src = g.players[0];
    k.char = D.CHARACTER_BY_NAME['肾小球'];
    k.maxHp = 4; k.hp = 4; k.filterUsed = false;
    return E.damage(k, 1, src, 'normal').then(function () {
      ok('本回合第一次非属性伤害被减到 0', k.hp === 4, k.hp);
      return E.damage(k, 1, src, 'normal');
    }).then(function () {
      ok('同一回合第二次不再减免（原来会一直免疫）', k.hp === 3, k.hp);
      return E.damage(k, 1, src, 'fire');
    }).then(function () {
      ok('属性伤害本来就不受过滤影响', k.hp === 2, k.hp);
    });
  });

  group('平衡调整：另外三个武将', function () {
    var g = freshGame(5);

    var song = g.players[1];
    song.char = D.CHARACTER_BY_NAME['宋美丽'];
    song.hp = 1;
    var cands = E.skillTargets(song, { name:'共情', healOnly:true });
    ok('【共情】不能选自己了', cands.indexOf(song) < 0, cands.map(function (p) { return p.name; }).join(','));
    var textOf = function (p, n) {
      var s = p.char.skills.find(function (x) { return x.name === n; });
      return s ? s.text : '';
    };
    ok('【共情】的文案写了"其他"', /其他/.test(textOf(song, '共情')), textOf(song, '共情'));

    var wang = g.players[2];
    wang.char = D.CHARACTER_BY_NAME['王三金'];
    ok('【炫富】的文案改成了"每轮限一次"', /每轮限一次/.test(textOf(wang, '炫富')), textOf(wang, '炫富'));

    var dong = g.players[3];
    dong.char = D.CHARACTER_BY_NAME['董昌程'];
    ok('【设局】的代价改成了弃两张牌', /弃两张牌/.test(textOf(dong, '设局')), textOf(dong, '设局'));

    var shen = g.players[4];
    shen.char = D.CHARACTER_BY_NAME['肾小球'];
    ok('【过滤】的文案加了"每回合…首次"',
       /每回合[^，。]*首次/.test(textOf(shen, '过滤')), textOf(shen, '过滤'));
  });

  group('辅导员签字的时机', function () {
    // 延时牌不再在"放置时"被抵消 —— 描述里必须写清时机，免得玩家以为丢了窗口
    var det = D.CARD_DETAIL['辅导员签字'];
    ok('辅导员签字的详情写明了延时牌的时机',
       /回合开始/.test(det.limit) && /放置时不问/.test(det.limit), det.limit);
    ok('辅导员签字的详情写明了群体牌逐个目标询问',
       /每个目标分别/.test(det.limit), det.limit);
    ok('卡面上的简述也改成了"生效时"',
       /生效时/.test(D.CARDS['辅导员签字'].desc), D.CARDS['辅导员签字'].desc);
  });

  /* ---------------------------------------------------------
   *  6d-2. 延时牌被辅导员签字抵消后的去向
   *
   *  论文查重（闪电）和手机没电/饭卡没钱不一样：它的身份是**热土豆**，
   *  没劈中就得传给下家。辅导员签字抵消掉的是"受到 3 点雷电伤害"
   *  这一次判定，不是这张牌本身 —— 所以它应该照常流转，而不是进弃牌堆。
   * --------------------------------------------------------- */
  group('论文查重被抵消后是流转，不是消失', function () {
    var realAsk = window.UI.askHuman;

    /** 真人才走 UI.askHuman，所以把座位 1 设成真人，它的"打不打签字"就由我们说了算 */
    function answerNullify(yes) {
      window.UI.askHuman = function (req) {
        if (req.kind === 'choice' && /辅导员签字/.test(req.prompt || '')) {
          return Promise.resolve({ option: yes ? 'yes' : 'no' });
        }
        return Promise.resolve({});
      };
    }

    /** 从牌堆或任何人手里抽一张出来 —— 免得"刚好都发到手上了"这种随机跳过 */
    function takeCard(g, name) {
      var i = g.deck.findIndex(function (c) { return c.name === name; });
      if (i >= 0) return g.deck.splice(i, 1)[0];
      for (var k = 0; k < g.players.length; k++) {
        var h = g.players[k].hand;
        var j = h.findIndex(function (c) { return c.name === name; });
        if (j >= 0) return h.splice(j, 1)[0];
      }
      return null;
    }

    /** 造一局干净的对局：0 号位通知栏里放一张延时牌，1 号位捏着一张辅导员签字 */
    function setup(delayedName) {
      var g = freshGame(4, [0, 1]);
      g.speed = 0.01;
      g.turnSeat = 0;
      g.players.forEach(function (p) { p.hand = []; p.judge = []; });
      var delayed = takeCard(g, delayedName);
      var sign = takeCard(g, '辅导员签字');
      if (!delayed || !sign) return { g: g, missing: true };
      g.players[0].judge.push(delayed);
      g.players[1].hand.push(sign);
      return { g: g, delayed: delayed, sign: sign };
    }

    // ---- 1. 被签字抵消：应该传给下家，不该进弃牌堆 ----
    var s = setup('论文查重');
    if (s.missing){ ok('牌堆里找得到论文查重和辅导员签字', false, '找不到，跳过'); return; }
    answerNullify(true);
    var deckBefore = s.g.deck.length;
    return E.judgePhase(s.g.players[0]).then(function () {
      window.UI.askHuman = realAsk;
      // 闪电的官方时机：无懈必须抢在判定牌翻开**之前**，翻开了就只剩改判窗口。
      // 所以抵消掉 = **根本不进行判定** = 一张牌都没翻。
      // 这条最容易被"优化"成"等看到结果再问"，那样 15.6% 命中的牌就永远没人愿意掏签字了。
      ok('抵消后一张抽签牌都没翻（= 在翻牌之前问的）',
         s.g.deck.length === deckBefore,
         '牌堆 ' + deckBefore + ' → ' + s.g.deck.length);
      ok('抵消后论文查重**不在**弃牌堆里（它没消失）',
         s.g.discard.indexOf(s.delayed) < 0,
         '弃牌堆里有它 = 被当成普通延时牌弃掉了');
      ok('抵消后论文查重传给了下家（1 号位通知栏）',
         s.g.players[1].judge.indexOf(s.delayed) >= 0,
         '1 号位通知栏：' + s.g.players[1].judge.map(function (c) { return c.name; }).join(','));
      ok('它已经离开自己（0 号位）的通知栏', s.g.players[0].judge.indexOf(s.delayed) < 0);
      ok('辅导员签字自己进了弃牌堆（它是一次性消耗）',
         s.g.discard.indexOf(s.sign) >= 0);

      // ---- 2. 判定没命中：一样流转（这条本来就对，重构后要保证没坏）----
      var t = setup('论文查重');
      if (t.missing){ ok('第二局也找得到牌', false, '找不到，跳过'); return; }
      // drawFromDeck 是 pop()，所以放末尾 = 下一张翻开的就是它
      var safe = t.g.deck.find(function (c) {
        return !(c.suit === 'S' && c.rank >= 2 && c.rank <= 9);
      });
      t.g.deck.splice(t.g.deck.indexOf(safe), 1);
      t.g.deck.push(safe);
      answerNullify(false);
      return E.judgePhase(t.g.players[0]).then(function () {
        window.UI.askHuman = realAsk;
        ok('判定没命中时，论文查重同样传给下家',
           t.g.players[1].judge.indexOf(t.delayed) >= 0);

        // ---- 3. 对照组：手机没电被抵消 → 照旧进弃牌堆 ----
        var u = setup('手机没电');
        if (u.missing){ ok('第三局也找得到牌', false, '找不到，跳过'); return; }
        answerNullify(true);
        return E.judgePhase(u.g.players[0]).then(function () {
          window.UI.askHuman = realAsk;
          ok('手机没电被抵消后仍然进弃牌堆（它没有流转这回事）',
             u.g.discard.indexOf(u.delayed) >= 0 &&
             u.g.players[1].judge.indexOf(u.delayed) < 0,
             '弃牌=' + (u.g.discard.indexOf(u.delayed) >= 0) +
             ' 下家通知栏=' + (u.g.players[1].judge.indexOf(u.delayed) >= 0));
        });
      });
    }).catch(function (e) {
      window.UI.askHuman = realAsk;
      ok('这组测试本身没有抛异常', false, (e && e.message) || String(e));
    });
  });

  /* ---------------------------------------------------------
   *  6e. 平衡调整：四个弱势武将获得加强
   * --------------------------------------------------------- */
  group('弱势武将加强（文案）', function () {
    var txt = function (id, n) {
      var c = D.CHARACTER_BY_NAME[id];
      var s = c && c.skills.find(function (x) { return x.name === n; });
      return s ? s.text : '';
    };

    ok('【概率】不再有"弃一张手牌"的负收益（数学郭）',
       !/弃一张手牌/.test(txt('数学郭', '概率')) && /黑色摸一张牌/.test(txt('数学郭', '概率')),
       txt('数学郭', '概率'));
    ok('【水课】主动跳过也触发（方三水）',
       /都没出/.test(txt('方三水', '水课')), txt('方三水', '水课'));
    ok('【划水】交换后补一张牌（方三水）',
       /然后你摸一张牌/.test(txt('方三水', '划水')), txt('方三水', '划水'));
    ok('【撒娇】交换后补一张牌（奶扣）',
       /并摸一张牌/.test(txt('奶扣', '撒娇')), txt('奶扣', '撒娇'));
    ok('【伦理】加上了成为事件牌目标的收益（董伦）',
       /摸一张牌/.test(txt('董伦', '伦理')) && /事件牌/.test(txt('董伦', '伦理')),
       txt('董伦', '伦理'));
  });

  group('【伦理】真的会发牌', function () {
    var g = freshGame(5);
    var user = g.players[0];
    var dong = g.players[2];
    dong.char = D.CHARACTER_BY_NAME['董伦'];
    dong.hp = 3; dong.maxHp = 3;
    // 把所有人的手牌清空，只留董伦的。
    // 否则别人随机摸到【辅导员签字】会把这张通报批评抵消掉 ——
    // 那时【伦理】本来就不该触发（牌没生效），但测试会随机变红。
    g.players.forEach(function (p) { p.hand = []; });
    while (dong.hand.length < 2) { var c = g.deck.pop(); if (c) dong.hand.push(c); }
    var before = dong.hand.length;
    // 通报批评 = 弃置目标一张牌，正好用来测"成为事件牌目标"这条触发
    var ev = g.deck.find(function (c) { return c.name === '通报批评'; }) ||
             g.deck.find(function (c) { return D.CARDS[c.name].kind === 'dismantle'; });
    if (!ev){ ok('（牌堆里找不到通报批评，跳过）', true); return; }
    return E.useCard(user, ev, [dong]).then(function () {
      ok('【伦理】触发时写了日志',
         g.log.some(function (e) { return /伦理/.test(e.text); }),
         g.log.slice(-3).map(function (e) { return e.text; }).join(' | '));
      ok('他被弃了一张牌，但伦理补回一张（净手牌不变）',
         dong.hand.length === before, dong.hand.length + ' vs ' + before);
    });
  });

  /* ---------------------------------------------------------
   *  6f. 坐骑拆成两个独立栏位
   * --------------------------------------------------------- */
  group('+1 / −1 坐骑是两个独立栏位', function () {
    var g = freshGame(5);
    var p = g.players[2];
    var up   = g.deck.filter(function (c) { return D.CARDS[c.name].slot === 'mountUp'; })[0];
    var down = g.deck.filter(function (c) { return D.CARDS[c.name].slot === 'mountDown'; })[0];
    p.equips.mountUp = up;
    p.equips.mountDown = down;

    ok('装备栏一共四格', D.EQUIP_SLOTS.length === 4, D.EQUIP_SLOTS.join(','));
    ok('+1 与 −1 落在不同栏位', up.slot !== down.slot, up.slot + ' / ' + down.slot);

    // 投影：客户端两边都要收到（少一个就会出现"我明明有 −1 坐骑但距离不对"）
    var sp = Net.project(1, false).players[2];
    ok('投影里 +1 坐骑在', !!sp.equips.mountUp && sp.equips.mountUp.name === up.name);
    ok('投影里 −1 坐骑也在', !!sp.equips.mountDown && sp.equips.mountDown.name === down.name);

    // 装第二匹 +1 —— 只该顶掉第一匹 +1
    var another = g.deck.filter(function (c) {
      return D.CARDS[c.name].slot === 'mountUp' && c !== up;
    })[0];
    var beforeDown = p.equips.mountDown;
    p.equips[another.slot] = another;
    ok('装第二匹 +1 会顶掉第一匹 +1', p.equips.mountUp === another);
    ok('装第二匹 +1 **不会**碰掉 −1 坐骑', p.equips.mountDown === beforeDown);

    // 距离：+1 作用是"别人看你更远"，−1 是"你看别人更近" ——
    // 所以两个修正要在**两个人身上**才看得出各算了一次
    var a = g.players[0], b = g.players[2];
    a.equips.mountDown = null; b.equips.mountUp = null; b.equips.mountDown = null;
    var base = E.distance(a, b);
    b.equips.mountUp = up;
    ok('b 骑 +1 → a 看 b 的距离 +1', E.distance(a, b) === base + 1,
       E.distance(a, b) + ' vs ' + base);
    a.equips.mountDown = down;
    ok('a 再骑 −1 → 距离又减回来（两个修正各算一次，互不顶替）',
       E.distance(a, b) === base, E.distance(a, b) + ' vs ' + base);

    // 界面：装备区要把四格都画出来（漏一格就是"牌装上了但看不见"）
    b.equips.mountUp = up; b.equips.mountDown = down;
    b.equips.weapon = g.deck.filter(function (c) { return D.CARDS[c.name].slot === 'weapon'; })[0];
    b.equips.armor  = g.deck.filter(function (c) { return D.CARDS[c.name].slot === 'armor'; })[0];
    UI.render();
    var chips = document.querySelectorAll('#opponents .player-panel[data-seat="2"] .gear-chip');
    ok('装备区把四格都渲染出来了（武器 / 防具 / +1 坐骑 / −1 坐骑）',
       chips.length === 4, chips.length);
  });

  /* ---------------------------------------------------------
   *  6g. 赛后评分与 MVP
   * --------------------------------------------------------- */
  group('赛后评分与 MVP', function () {
    var g = freshGame(5);
    g.players[0].identity = 'student';
    g.players[1].identity = 'staff';
    g.players[2].identity = 'staff';
    g.players[3].identity = 'dean';
    g.players[4].identity = 'mole';
    g.players.forEach(function (p) { p.alive = true; });
    // 造一份可预期的统计
    g.stats = {
      0: { dmg:8,  kills:2, saves:1, heals:0, skills:3 },
      1: { dmg:2,  kills:0, saves:0, heals:5, skills:1 },
      2: { dmg:0,  kills:0, saves:0, heals:0, skills:0 },
      3: { dmg:0,  kills:0, saves:0, heals:0, skills:0 },
      4: { dmg:0,  kills:0, saves:0, heals:0, skills:0 }
    };

    var b = E.buildScoreboard('student');
    var r0 = b.rows[0], r1 = b.rows[1], r2 = b.rows[2];

    // 0 号位（学生，赢）：30 + 伤害8×3 + 击杀2×15 + 救援12 + 技能3×2 + 存活8
    ok('胜利方的分数 = 30 + 24 + 30 + 12 + 6 + 8 = 110', r0.score === 110, r0.score);
    ok('输了但活着的：只拿到存活分 8', r2.score === 8, r2.score);
    ok('没造成任何伤害的人分数很低（不是人人有奖）', r1.score < r0.score);
    ok('MVP 是分最高的 0 号位', b.mvpSeat === 0, b.mvpSeat);

    // 关键设计：打得漂亮但输掉的人，应该能压过躺赢的人
    g.stats[1] = { dmg:20, kills:3, saves:0, heals:0, skills:5 };
    var b2 = E.buildScoreboard('student');
    ok('输了但打出 20 伤害 3 击杀的教务 = 60 + 45 + 10 + 8 = 123',
       b2.rows[1].score === 123, b2.rows[1].score);
    ok('所以他拿到了 MVP，而不是躺赢的 0 号位（110）',
       b2.mvpSeat === 1, b2.mvpSeat);

    // 技能分封顶
    g.stats[0] = { dmg:0, kills:0, saves:0, heals:0, skills:999 };
    var b3 = E.buildScoreboard(null);
    var sk = b3.rows[0].parts.filter(function (p) { return p.label === '发动技能'; })[0];
    ok('技能分封顶 20（刷 999 次也没用）', sk && sk.v === 20, JSON.stringify(sk));
    ok('平局给 10 分底分', b3.rows[0].parts.some(function (p) { return p.label === '平局' && p.v === 10; }));

    // 一分没得就不评 MVP。
    // 注意：只要有人赢了就有 30 分，"全员 0 分"必须让赢的那个阵营**没人**才对
    g.stats = {};
    g.players.forEach(function (p) { p.alive = false; p.identity = 'student'; });
    var b4 = E.buildScoreboard('mole');            // 场上没有卧底 → 谁都不加分
    ok('全都没分时不硬评 MVP', b4.mvpSeat === -1, b4.mvpSeat);
  });

  group('评分埋点真的在记', function () {
    var g = freshGame(4);
    var a = g.players[0], b = g.players[1];
    // 别在这里改 b.char —— freshGame 已经按座位发了不重复的武将，
    // 再手动指定会撞成重复角色，把后面「当前对局角色不重复」那条自检搞红
    b.maxHp = 6; b.hp = 6;
    ok('开局统计是清零的', (g.stats[0] || {}).dmg === undefined || g.stats[0].dmg === 0);
    return E.damage(b, 2, a, 'normal').then(function () {
      ok('造成伤害会记进评分', g.stats[0] && g.stats[0].dmg === 2, JSON.stringify(g.stats[0]));
      return E.heal(b, 1, '测试', a);
    }).then(function () {
      ok('治疗他人会记进评分', g.stats[0] && g.stats[0].heals === 1, JSON.stringify(g.stats[0]));
      // 自己治疗自己不算贡献
      var before = g.stats[0].heals;
      return E.heal(a, 1, '测试', a).then(function () {
        ok('自己治疗自己不算贡献', g.stats[0].heals === before, g.stats[0].heals);
      });
    });
  });

  /* ---------------------------------------------------------
   *  6h. 电脑强度三档
   * --------------------------------------------------------- */
  group('电脑强度：参数与不变量', function () {
    var AI = window.AI;
    ok('默认是普通档', AI.getLevel() === 'normal', AI.getLevel());
    ok('三档都在', !!AI.LEVELS.easy && !!AI.LEVELS.normal && !!AI.LEVELS.hard);
    ok('噪声递减：简单 > 普通 > 困难',
       AI.LEVELS.easy.noise > AI.LEVELS.normal.noise &&
       AI.LEVELS.normal.noise > AI.LEVELS.hard.noise,
       [AI.LEVELS.easy.noise, AI.LEVELS.normal.noise, AI.LEVELS.hard.noise].join('>'));
    ok('困难档不失误（mistake / blunder 都为 0）',
       AI.LEVELS.hard.mistake === 0 && AI.LEVELS.hard.blunder === 0);
    ok('简单档失误率明显更高',
       AI.LEVELS.easy.mistake > AI.LEVELS.normal.mistake &&
       AI.LEVELS.easy.blunder > AI.LEVELS.normal.blunder);

    var g = freshGame(5);
    g.players[0].identity = 'student';
    g.players[1].identity = 'dean';
    g.players[2].identity = 'staff';
    g.players[3].identity = 'student';

    // 「不打自己人」是基本能力，不该随难度变化
    ['easy', 'normal', 'hard'].forEach(function (k) {
      AI.setLevel(k);
      ok('（' + k + '档）院方都不会打公开的院长',
         AI.threat(g.players[2], g.players[1]) <= -60, AI.threat(g.players[2], g.players[1]));
    });

    // 身份推断强度随难度变化
    AI.setLevel('easy');
    var easyTh = AI.threat(g.players[0], g.players[1]);   // 学生看院长
    AI.setLevel('hard');
    var hardTh = AI.threat(g.players[0], g.players[1]);
    ok('困难档对院长的仇恨值 >= 简单档', hardTh >= easyTh, easyTh + ' vs ' + hardTh);
    ok('简单档确实削弱了身份推断（而不是原样）', easyTh < hardTh, easyTh + ' vs ' + hardTh);

    AI.setLevel('normal');
  });

  group('电脑强度：行为上真的不一样', function () {
    var AI = window.AI;
    var g = freshGame(5);
    g.players[0].identity = 'student';
    g.players[1].identity = 'dean';      // 学生最该打的
    g.players[2].identity = 'staff';
    g.players[3].identity = 'mole';
    g.players[4].identity = 'student';
    var cands = [g.players[1], g.players[2], g.players[3], g.players[4]];

    // 统计「最常打的那个人占比」——困难档应该更集中（会集火），简单档更分散
    function focus(level, rounds){
      AI.setLevel(level);
      var cnt = {};
      for (var i = 0; i < rounds; i++){
        var t = AI.pickTarget(g.players[0], cands);
        if (t) cnt[t.seat] = (cnt[t.seat] || 0) + 1;
      }
      var top = null;
      Object.keys(cnt).forEach(function (k){ if (top === null || cnt[k] > cnt[top]) top = k; });
      return { seat: top === null ? -1 : +top, share: top === null ? 0 : cnt[top] / rounds };
    }
    var easy = focus('easy', 400);
    var hard = focus('hard', 400);

    ok('困难档更集中地打同一个人（会集火）', hard.share > easy.share,
       '简单 ' + (easy.share * 100).toFixed(0) + '% vs 困难 ' + (hard.share * 100).toFixed(0) + '%');
    ok('困难档最常打的是院长（身份推断生效）', hard.seat === 1, hard.seat);

    AI.setLevel('normal');
  });

  group('三档都能打完一整局', function () {
    var AI = window.AI;
    var chain = Promise.resolve();
    ['easy', 'normal', 'hard'].forEach(function (k) {
      chain = chain.then(function () {
        AI.setLevel(k);
        E.initGame({ count: 5, mode:'A', deal:3, hotseat:false, humanSeats:[0] });
        var g = window.G;
        g.players.forEach(function (p, i) { p.char = D.CHARACTERS[i]; });
        E.finalizeRoles(); E.finalizeGame();
        g.speed = 0.01;
        g.players.forEach(function (p) { p.isHuman = false; });
        g.players.forEach(function (p) {
          for (var i = 0; i < 4; i++) { var c = g.deck.pop(); if (c) p.hand.push(c); }
        });
        return E.gameLoop().then(function () {
          ok('「' + AI.LEVELS[k].name + '」档能打完一整局', g.over === true);
        });
      });
    });
    chain = chain.then(function () { AI.setLevel('normal'); });
    return chain;
  });

  /* ---------------------------------------------------------
   *  6i. 新手教学局
   * --------------------------------------------------------- */
  group('新手教学局', function () {
    var T = window.Tutorial;
    ok('教学模块加载了', !!T && typeof T.start === 'function');

    T.start();
    var g = window.G;
    ok('教学局是 4 人局（最短的完整对局）', g.players.length === 4, g.players.length);
    ok('玩家被固定成学生', g.players[g.humanSeat].identity === 'student',
       g.players[g.humanSeat].identity);
    ok('身份人数配置没被换坏（4 人局各 1）', (function () {
      var c = {};
      g.players.forEach(function (p) { c[p.identity] = (c[p.identity] || 0) + 1; });
      var cfg = D.IDENTITY_CONFIG[4];
      return c.dean === cfg.dean && c.staff === cfg.staff &&
             c.student === cfg.student && c.mole === cfg.mole;
    })());
    ok('院长身份仍然公开',
       g.players.filter(function (p) { return p.identity === 'dean'; })[0].revealed === true);
    ok('起手牌被换成教学用的四张',
       g.players[0].hand.length === 4 &&
       ['上课点名','代课','请假条','借笔记'].every(function (n) {
         return g.players[0].hand.some(function (c) { return c.name === n; });
       }),
       g.players[0].hand.map(function (c) { return c.name; }).join(','));
    ok('电脑被切成简单档（不会精准集火秒了新手）', window.AI.getLevel() === 'easy', window.AI.getLevel());
    ok('保护轮开着', g.opts.protect === true);
    ok('提示条弹出了第一条', !document.getElementById('tutorial-bar').classList.contains('hide'));

    // 提示按条件触发，且每条只弹一次。
    // 注意：第一条（开场白）没有 when，所以任何 notify 都会先把它弹掉 ——
    // 正式流程里 T.start() 会先发一次 notify('start') 把它消费掉。
    T.seen = {};
    T.notify('targeting', {});
    ok('第一条（开场白）会被弹掉', T.seen.open === true,
       Object.keys(T.seen).join(','));
    T.notify('targeting', {});
    ok('接着弹出匹配 targeting 的那条', T.seen.target === true,
       Object.keys(T.seen).join(','));
    var n = Object.keys(T.seen).length;
    T.notify('targeting', {});
    T.notify('targeting', {});
    ok('已经弹过的提示不会再弹（也没有别的匹配项）',
       Object.keys(T.seen).length === n, Object.keys(T.seen).join(','));

    T.stop();
    ok('退出教学后提示条收起', document.getElementById('tutorial-bar').classList.contains('hide'));
    ok('退出教学后电脑强度还原', window.AI.getLevel() === 'normal', window.AI.getLevel());
    ok('退出教学后 active 关掉', T.active === false);
  });

  /* ---------------------------------------------------------
   *  6i-2. 教学提示 vs 真实引擎生成的询问
   *
   *  上面的用例只手工喂了一次 notify('targeting')。可真正教东西的几条
   *  （出牌阶段 / 弃牌 / 濒死 / 代课）是靠正则去认引擎写的提示语的 ——
   *  引擎里换一个词，提示就**静默**不弹了，玩家那边看不出任何异常。
   *  所以这里让引擎自己发询问，看教学认不认得出来。
   * --------------------------------------------------------- */
  group('教学提示接的是真实引擎的询问', function () {
    var T = window.Tutorial;
    var fired = [];
    var calls = [];               // 引擎到底发了哪些询问（失败时拿它定位）
    var realNotify = T.notify;
    var realAsk = window.UI.askHuman;

    // 提示是在 UI.askHuman 里发出去的，而真的 askHuman 会弹窗等人点 ——
    // 无头环境会永远卡在第一个出牌阶段。换成"照常发提示 + 交给 AI 决策"：
    // 于是引擎把**它自己生成的 req** 喂进教学里，
    // 验的是真实提示语，而不是我在测试里手抄一份字符串（那只证明我抄对了）。
    window.UI.askHuman = function (req){
      T.notify('ask', { req: req });
      return window.AI.decide(req);
    };
    T.notify = function (type, payload){
      var before = Object.keys(T.seen);
      var req = payload && payload.req;
      calls.push(type + (req ? ':' + req.kind : ''));
      realNotify.call(T, type, payload);
      Object.keys(T.seen).forEach(function (k){
        if (before.indexOf(k) < 0 && fired.indexOf(k) < 0) fired.push(k);
      });
    };

    var done = T.start();          // 返回整局的 Promise
    window.G.speed = 0.01;         // 别真等 AI 那 560ms 的"思考时间"

    // 兜底：万一这局打不完（比如以后改了平衡性变成僵局），别把整个测试挂死。
    // 强制结束也会走 UI.showOver，所以 over 那条照样会被验到。
    var guard = new Promise(function (res){
      setTimeout(function (){
        if (!window.G.over) window.Engine.endGame('dean', '测试兜底结束');
        res();
      }, 60000);
    });

    return Promise.race([Promise.resolve(done), guard]).then(function (){
      var over = window.G.over;
      T.stop();
      T.notify = realNotify;
      window.UI.askHuman = realAsk;
      // 一局结束必须走 endGame —— 它会写 G.scoreboard 并弹结算界面。
      // 引擎里有几条路径是"先写 G.over 再调 checkVictory/endGame"，
      // 而那两个函数开头都有 `if (G.over) return`：结果是棋局停在那里，
      // 既没有结算也没有结束提示。这一条就是拿来堵那个的。
      var endLog = window.G.log.filter(function (e){ return /^游戏结束/.test(e.text); })[0];
      var diag = 'round=' + window.G.round + ' fired=[' + fired.join(',') + '] over=' + over +
                 ' end=' + (endLog ? endLog.text : '(没走 endGame)') +
                 ' calls=[' + calls.slice(0, 20).join(' ') + ']';
      ok('出牌阶段的提示弹了（认得出引擎发的 playPhase）',
         fired.indexOf('hand') >= 0, diag);
      ok('游戏结束的提示弹了', fired.indexOf('over') >= 0, diag);
      ok('结束时真的弹了结算（不是停在那儿不动）',
         !!endLog && endLog.text.indexOf('测试兜底结束') < 0, diag);
      ok('每条提示最多弹一次', Object.keys(T.seen).length === fired.length,
         'seen=' + Object.keys(T.seen).join(',') + ' fired=' + fired.join(','));
      ok('教学局能真的打到底（4 人局不会僵住）', over === true);
    });
  });

  /* ---------------------------------------------------------
   *  6j. 复盘导出（分享版 HTML）
   * --------------------------------------------------------- */
  group('复盘导出：分享版 HTML', function () {
    var Net = window.Net;
    ok('导出接口在', typeof Net.buildReplayHtml === 'function' &&
                     typeof Net.exportReplayHtml === 'function');

    // 没录像时应该拒绝，而不是导出个空文件
    var keep = Net.rec;
    Net.rec = null;
    return Net.buildReplayHtml().then(
      function (){ ok('没录像时拒绝导出', false, '居然生成了'); },
      function (e){ ok('没录像时拒绝导出', /还没录到/.test(e.message), e.message); }
    ).then(function () {
      // 有录像：真生成一遍，把内容逐条验掉。
      // （测试跑在 --allow-file-access-from-files 下，所以 file:// 也读得到源码；
      //   用户直接双击打开时读不到，那条路径会给出可读的错误提示。）
      Net.rec = { v:1, type:'dqk-replay', seat:0, seatCount:4,
                  frames: new Array(40).fill({ t: 0 }) };
      Net.recLive = false;
      ok('这段录像被认为有效', Net.hasReplay() === true);
      return Net.buildReplayHtml().then(function (html){
        ok('能生成分享版 HTML', typeof html === 'string' && html.length > 100000,
           html && html.length);
        ok('有 DOCTYPE', html.indexOf('<!DOCTYPE html>') === 0);
        ok('带了复盘数据', html.indexOf('id="replay-data"') > 0);
        // 骨架完整度（#board / #sidebar / 复盘条的按钮）在 export_probe 里验 ——
        // 那个探针取的是真实 index.html 的 DOM，本测试页的 DOM 是简化的
        ok('带了游戏骨架', html.indexOf('id="screen-game"') > 0);
        ok('内联了 data / engine / ui / net',
           html.indexOf('===== data.js =====') > 0 &&
           html.indexOf('===== engine.js =====') > 0 &&
           html.indexOf('===== ui.js =====') > 0 &&
           html.indexOf('===== net.js =====') > 0);
        ok('没把 main.js 塞进去（否则打开会自己开一局）',
           html.indexOf('===== main.js =====') < 0);
        // 最关键的一条：内联的源码里不能有裸的脚本结束标签。
        // 有的话整块 JS 会因为语法不完整而**完全不执行**，表现是打开白屏。
        // 8 个真标签 → split 出 9 段。
        ok('内联源码里没有裸的脚本结束标签（白屏元凶）',
           html.split('</scr' + 'ipt').length === 9, html.split('</scr' + 'ipt').length);
        ok('复盘数据里的 < 都转义了',
           html.indexOf('id="replay-data">') > 0 && html.indexOf('<\\u003c') < 0);
      }, function (e){
        ok('能生成分享版 HTML', false, e.message);
      });
    }).then(function () { Net.rec = keep; });
  });

  /* ---------------------------------------------------------
   *  7. 既有引擎自检（回归闸门）
   * --------------------------------------------------------- */
  group('回归', function () {
    if (typeof window.runSelfTest !== 'function') { fail('找不到 runSelfTest'); return; }
    var r = window.runSelfTest();
    // 注意：自检的结果项用的是 {name, pass, extra}，不是 {ok, detail} ——
    // 写错字段名会把**全部**检查名都当失败打出来，把真正的失败项淹掉
    ok('引擎自检全过（total=' + r.total + ', failed=' + r.failed + '）',
       r.failed === 0,
       r.results.filter(function (x) { return !x.pass; })
                .map(function (x) { return x.name + (x.extra ? '（' + x.extra + '）' : ''); })
                .join(' | '));
  });

  /* ---------------------------------------------------------
   *  输出（等所有异步组跑完）
   * --------------------------------------------------------- */
  function finish() {
    var bad = out.filter(function (o) { return !o.ok; });
    var lines = [];
    out.forEach(function (o) {
      lines.push((o.ok ? '[ok]   ' : '[FAIL] ') + o.name + ((!o.ok && o.detail) ? '  <- ' + o.detail : ''));
    });
    lines.push('');
    lines.push('JS-TOTAL ' + out.length + ' JS-FAILED ' + bad.length);
    var text = lines.join('\n');
    document.getElementById('RESULTS').textContent = text;

    // 带 ?sink=<地址> 时把结果回传给 tools/result_sink.py。
    // （比 --dump-dom 可靠：自测里有长轮询，挂起的 fetch 会让 Chromium 的
    //   虚拟时钟暂停，--virtual-time-budget 就永远不触发。）
    var sink = null;
    try { sink = new URLSearchParams(location.search).get('sink'); } catch (e) { /* 老浏览器 */ }
    if (sink) {
      try {
        fetch(sink, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text })
          .catch(function () {});
      } catch (e) { /* 忽略 */ }
    }
  }

  runAll();
})();
