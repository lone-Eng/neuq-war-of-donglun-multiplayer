/* =========================================================
 *  东秦杀：点名册  ·  联机层
 * =========================================================
 *
 *  架构：房主的浏览器是权威（完整的 engine.js 在它里面跑），
 *        其他人的浏览器是瘦客户端 —— 但它们跑的是**同一套 ui.js / fx.js**，
 *        所以出牌阶段、嵌套提问（电风扇/粉笔）这些复杂交互一行都不用改，
 *        客户端只是把"最终答案"发回房主。
 *
 *  server.py 只做两件事：静态文件服务 + 房间消息中转（长轮询）。
 *  引擎绝不在服务器上跑。
 *
 *  这个文件分六段：
 *    1. codec    —— 跨网络的对象引用编解码（卡牌按 uid、玩家按 seat）
 *    2. project  —— 主机侧：把权威状态投影成"某个接收者能看的样子"
 *    3. wire     —— 表现层事件的录制与回放
 *    4. transport—— 长轮询客户端
 *    5. host     —— 房主侧接线
 *    6. client   —— 瘦客户端接线
 * ========================================================= */
(function(){
'use strict';

const D = window.GameData;
const E = window.Engine;

const Net = {};
window.Net = Net;

/* 武将按 id 建索引：帧里只传 charId，客户端自己解析成 D.CHARACTERS 里的对象 */
const CHAR_BY_ID = {};
D.CHARACTERS.forEach(c => { CHAR_BY_ID[c.id] = c; });
Net.CHAR_BY_ID = CHAR_BY_ID;

/* =========================================================
 *  1. codec —— 跨网络的对象引用
 * =========================================================
 *
 *  引擎靠**对象同一性**校验出牌是否合法（engine.js:1629 的 p.hand.includes(card)、
 *  engine.js:144 的 p.hand.indexOf(c)）。所以卡牌不能简单地复制过去，
 *  必须能在主机侧对回**原来那个对象**。
 *
 *  牌堆里的每张牌都有全局唯一且稳定的 uid（data.js:146 的单调计数器，
 *  牌堆重洗不会重新 buildDeck），所以卡牌用 {__card: uid} 引用。
 *
 *  但引擎里有**临时构造的牌**（engine.js:473/488 的 {name:'代课', suit:null}、
 *  engine.js:1247、engine.js:484），它们没有 uid，必须能内联传输。
 */

/** 牌堆里真实的牌：有 uid */
function isCardObj(o){
  return o && typeof o === 'object' && !Array.isArray(o)
    && typeof o.name === 'string' && typeof o.uid === 'number'
    && 'suit' in o && 'rank' in o;
}

/** 临时构造的牌（代课/上课点名/校园卡 这类只拿来显示或当虚拟牌用的） */
function isTempCardObj(o){
  return o && typeof o === 'object' && !Array.isArray(o)
    && typeof o.name === 'string' && !('uid' in o)
    && ('suit' in o || o.virtual === true);
}

function isPlayerObj(o){
  return o && typeof o === 'object' && !Array.isArray(o)
    && typeof o.seat === 'number' && 'hp' in o && 'hand' in o && 'identity' in o;
}

const CARD_FIELDS = ['name', 'suit', 'rank', 'uid', 'type', 'kind', 'dmg',
                     'slot', 'range', 'tag', 'need', 'virtual'];

/** 把一张牌摊平成纯数据（够客户端渲染 + 参与本地计算即可） */
function inlineCard(c){
  if (!c) return null;
  const o = {};
  for (const k of CARD_FIELDS) if (c[k] !== undefined) o[k] = c[k];
  return o;
}
Net.inlineCard = inlineCard;

const MAX_DEPTH = 16;   // 防循环引用；req 都是浅结构，16 层绰绰有余

/**
 * 打包：把活对象换成可传输的引用。
 * 方向不限 —— 主机发请求给客户端、客户端回答案给主机，都用它。
 */
function pack(v, depth){
  if (v === null || v === undefined) return v;
  const t = typeof v;
  if (t === 'function') return undefined;      // req.filter 这类函数一律丢掉
  if (t !== 'object') return v;
  if (depth > MAX_DEPTH) return null;
  if (Array.isArray(v)) {
    const out = [];
    for (const x of v){
      const px = pack(x, depth + 1);
      if (px !== undefined) out.push(px);
    }
    return out;
  }
  if (isPlayerObj(v)) return { __seat: v.seat };
  if (isCardObj(v)){
    // 保险：凡是被打包过的牌都登记进 uid 索引（先到先得，不覆盖已有的）。
    // 主机万一忘了在 finalizeGame 之后调 indexDeck()，这里能兜住 ——
    // 否则 uid 解析不到就会退化成内联副本，而引擎靠对象同一性校验
    // （p.hand.includes(card)），会静默产生"同一张牌有两个对象"的怪状态。
    if (v.uid > 0 && !uidIndex.has(v.uid)) uidIndex.set(v.uid, v);
    return { __card: v.uid, c: inlineCard(v) };
  }
  if (isTempCardObj(v)) return { __vc: inlineCard(v) };
  const out = {};
  for (const k in v){
    if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
    const pv = pack(v[k], depth + 1);
    if (pv !== undefined) out[k] = pv;
  }
  return out;
}
Net.pack = pack;

/**
 * 拆包：把引用还原成活对象。
 *  - 玩家：按 seat 从 G.players 里取
 *  - 卡牌：先查 uid 索引；查不到就用内联副本兜底（比如【小组作业】亮出的
 *          是别人手里的牌，接收方的快照里根本没有这张牌）
 */
function unpack(v, depth){
  if (v === null || v === undefined) return v;
  if (typeof v !== 'object') return v;
  if (depth > MAX_DEPTH) return null;
  if (Array.isArray(v)) return v.map(x => unpack(x, depth + 1));
  if ('__seat' in v){
    const p = (window.G && G.players) ? G.players[v.__seat] : null;
    return p || null;
  }
  if ('__card' in v) return Net.resolveCard(v.__card, v.c);
  if ('__vc' in v) return Object.assign({}, v.__vc);
  const out = {};
  for (const k in v){
    if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = unpack(v[k], depth + 1);
  }
  return out;
}
Net.unpack = unpack;

/* ---- uid → 卡牌原对象 的索引 ---- */

const uidIndex = new Map();
Net.uidIndex = uidIndex;

/** 主机侧：finalizeGame 之后调用一次，把整副牌都登记进来。
 *  牌堆重洗只是重新排列同一批对象（engine.js:83），uid 不会变，所以登记一次就够。 */
Net.indexDeck = function(){
  if (!window.G || !G.deck) return 0;
  let n = 0;
  for (const c of G.deck) if (c && typeof c.uid === 'number'){ uidIndex.set(c.uid, c); n++; }
  return n;
};

/** 客户端侧：从快照里把自己的手牌和所有公开牌登记进来 */
Net.indexFromSnapshot = function(snap){
  const add = c => { if (c && typeof c.uid === 'number' && c.uid > 0) uidIndex.set(c.uid, c); };
  (snap.players || []).forEach(p => {
    (p.hand || []).forEach(add);
    (p.judge || []).forEach(add);
    D.EQUIP_SLOTS.forEach(k => add(p.equips && p.equips[k]));
  });
};

/** 把当前局面上**所有**的牌都登记进来（接手存档之后必须做一次：
    这时候牌堆已经发出去一部分，光索引 G.deck 会漏掉已经在手里的牌） */
Net.indexAll = function(){
  const G = window.G;
  if (!G) return 0;
  const add = c => { if (c && typeof c.uid === 'number' && c.uid > 0) uidIndex.set(c.uid, c); };
  (G.deck || []).forEach(add);
  (G.discard || []).forEach(add);
  (G.players || []).forEach(p => {
    (p.hand || []).forEach(add);
    (p.judge || []).forEach(add);
    D.EQUIP_SLOTS.forEach(k => add(p.equips && p.equips[k]));
  });
  return uidIndex.size;
};

/** 查 uid 索引；查不到就用内联副本造一个（并登记，保证同一 uid 始终映射同一对象） */
Net.resolveCard = function(uid, inline){
  if (typeof uid === 'number' && uidIndex.has(uid)) return uidIndex.get(uid);
  const c = inline ? Object.assign({}, inline) : { name:'？', suit:'S', rank:1, uid:uid };
  if (typeof uid === 'number') uidIndex.set(uid, c);
  return c;
};

/* =========================================================
 *  2. project —— 主机侧的状态投影
 * ========================================================= */

/*  !!! 不能优化掉的取巧  !!!
 *
 *  别人的手牌用**等长的占位牌数组**，而不是"空数组 + 一个 handCount 字段"。
 *
 *  原因：客户端的 E.validTargets 判断【通报批评/抄作业/当面约谈】能不能指向某人时，
 *  走的是 allZoneCards(t)（engine.js:165-171），逻辑是
 *      z.some(x => x.zone !== 'hand' || canBeHandTargeted(t))
 *  —— 手牌是空数组的话，这些目标会被**静默漏掉**，玩家会发现"明明能打却选不中"。
 *
 *  ui.js / fx.js 读对手手牌**只读 .length**（ui.js:152/403/459、fx.js:469），
 *  所以等长占位牌在渲染上和真牌完全等价。别动它。
 */
function placeholderCard(){
  return { name:'？', suit:'S', rank:1, uid:-1, type:'basic', kind:'none',
           dmg:'normal', slot:null, range:0, tag:null, need:null, hidden:true };
}

/** 打给外部的状态标记白名单 —— 顺便把内部字段（slideTurn 除外）挡在外面 */
function projectMarks(p){
  const m = p.marks || {};
  const out = {};
  if (m.buff) out.buff = m.buff;
  if (m.pigeon) out.pigeon = m.pigeon;
  if (m.net) out.net = m.net;
  // 划水限制：客户端算合法目标时要用（ui.js:352 的 canTargetOther）
  if (m.slideTurn !== undefined) out.slideTurn = m.slideTurn;
  if (m.slideFrom !== undefined) out.slideFrom = m.slideFrom;
  return out;
}

function projectPlayer(p, viewerSeat, revealAll){
  const self = (p.seat === viewerSeat);
  const known = self || revealAll || p.revealed || p.identity === 'dean';
  return {
    seat: p.seat,
    name: p.char ? p.char.name : ('座位 ' + (p.seat + 1)),   // 引擎里 name 是 getter，必须显式带上
    charId: p.char ? p.char.id : null,
    identity: known ? p.identity : null,
    revealed: !!p.revealed,
    hp: p.hp,
    maxHp: p.maxHp,
    alive: !!p.alive,
    isHuman: !!p.isHuman,
    ai: !!p.auto,                     // 掉线托管中
    hand: self ? p.hand.map(inlineCard) : p.hand.map(placeholderCard),
    equips: {
      weapon:    inlineCard(p.equips.weapon),
      armor:     inlineCard(p.equips.armor),
      mountUp:   inlineCard(p.equips.mountUp),
      mountDown: inlineCard(p.equips.mountDown)
    },
    judge: p.judge.map(inlineCard),
    chained: !!p.chained,
    marks: projectMarks(p),
    dodgeBan: !!p.dodgeBan,
    pointBan: !!p.pointBan
  };
}

/**
 * 投影一份发给某人的状态。
 *   viewerSeat >= 0 —— 该玩家的座位
 *   viewerSeat < 0  —— 旁观者（看得到一切公开信息，看不到任何手牌和身份）
 *   revealAll       —— 终局时所有身份公开（UI.showOver 会读所有人的 identity）
 */
Net.project = function(viewerSeat, revealAll){
  const G = window.G;
  if (!G || !G.players) return null;
  const LOG_TAIL = 200;
  const logAll = G.log || [];
  const logStart = Math.max(0, logAll.length - LOG_TAIL);
  const log = [];
  for (let i = logStart; i < logAll.length; i++){
    const e = logAll[i];
    // 带 only 的日志条目（【窃听】【侃山】会打印别人的手牌）按座位脱敏
    if (e.only && !revealAll && viewerSeat >= 0 && e.only.indexOf(viewerSeat) >= 0){
      log.push({ text: e.text, cls: e.cls });
    } else if (e.only){
      log.push({ text: e.redacted || e.text, cls: e.cls });
    } else {
      log.push({ text: e.text, cls: e.cls });
    }
  }
  return {
    rev: Net.rev,
    // 注意：**不发 humanSeat**。客户端自己持有自己的座位，
    // 从快照里抄的话会让每个客户端都去渲染房主的手牌和身份。
    players: G.players.map(p => projectPlayer(p, viewerSeat, revealAll)),
    turnSeat: G.turnSeat,
    round: G.round,
    turnId: G.turnId,                 // 客户端算划水限制要用
    over: !!G.over,
    speed: G.speed,
    deckCount: G.deck ? G.deck.length : 0,
    discardCount: G.discard ? G.discard.length : 0,
    logStart: logStart,
    log: log,
    // 正在等谁做决定（含超时时刻）。全场都该看到"在等谁"，
    // 否则轮到别人时玩家分不清对方是在想、还是掉线了。
    asking: (Net.askingSeat >= 0)
      ? { seat: Net.askingSeat, until: Net.askUntil || 0 }
      : null
  };
};

/* =========================================================
 *  3. wire —— 表现层事件的录制与回放
 * =========================================================
 *
 *  主机把引擎对 FX.* / UI.setPhase 的调用录成事件发给客户端，客户端喂给
 *  本地**真的** FX.* —— 音效、飘字、出牌区、查考勤翻牌全都还在，
 *  而且各端按自己的 G.speed 播放。
 */

/** 要录制的 FX 方法。异步的那几个必须录，否则客户端会丢掉整段演出。 */
const FX_NAMES = [
  'sfx', 'floatText', 'shake', 'flash', 'thinking', 'skillBanner',
  'beginExchange', 'addToExchange', 'cardPlay', 'endExchange',
  'turnBanner', 'judge', 'death', 'gameEnd'
];

/** 回放时如果队列积压超过这个数就不再等动画（快照才是权威，别让旁观端越落越远） */
const REPLAY_BACKLOG = 8;

Net.recording = false;
Net.events = [];

/**
 * 包装一个 FX 方法：本机照常执行，同时把调用录成事件。
 *
 * ！！重入抑制是必须的！！ —— fx.js 内部自己也在调 FX.*：
 *   FX.cardPlay      → FX.addToExchange (fx.js:207)  → FX.sfx (fx.js:201)
 *   FX.judge         → FX.sfx           (fx.js:321)
 *   FX.death         → FX.sfx / FX.flash (fx.js:337-338)
 * 不抑制的话，引擎调一次 cardPlay 会录到「cardPlay」和它内部的「addToExchange」
 * 两条，客户端出牌区会插两张、音效放两遍。
 *
 * 抑制窗口只覆盖**同步执行的那一段**（用 finally 立刻归零，不等 promise）。
 * 这是有意的，而且和 fx.js 的写法精确吻合：上面那些嵌套调用全部发生在
 * 各自的第一个 await 之前（fx.js:207 在 208 之前、321 在 330 之前、
 * 337-338 在 347 之前）。
 *
 * 反例警告：如果改成"等 promise 结束才归零"的全局计数器，那么当一个异步 FX
 * （比如 turnBanner 要 720ms）还没播完时，引擎又发起了下一个 FX 调用，那一条
 * 就会被**静默吃掉**。引擎目前是逐条 await 的所以看不出来，但那是运气，不是保证。
 */
function wrapFx(name){
  const FX = window.FX;
  if (!FX || typeof FX[name] !== 'function' || FX[name].__wrapped) return;
  const orig = FX[name];
  function wrapped(){
    const args = Array.prototype.slice.call(arguments);
    const outer = (wireDepth === 0);
    if (outer && Net.recording){
      const packed = [];
      for (const a of args){
        const p = pack(a, 0);
        packed.push(p === undefined ? null : p);
      }
      Net.events.push({ k: name, a: packed });
    }
    wireDepth++;
    try {
      return orig.apply(FX, args);
    } finally {
      wireDepth--;
    }
  }
  wrapped.__wrapped = true;
  FX[name] = wrapped;
}

let wireDepth = 0;

/** 主机侧：开始把表现层调用录成事件 */
Net.startRecording = function(){
  Net.recording = true;
  FX_NAMES.forEach(wrapFx);

  const UI = window.UI;
  if (UI && !UI.setPhase.__wrapped){
    const orig = UI.setPhase;
    const w = function(name){
      if (Net.recording) Net.events.push({ k: 'phase', a: [name] });
      return orig.apply(UI, arguments);
    };
    w.__wrapped = true;
    UI.setPhase = w;
  }
  // 每次重绘都标脏：主机的帧里因此能带上最新快照，
  // 单机的复盘录制也靠它决定什么时候存一帧状态。
  if (UI && !UI.render.__dirtyWrapped){
    const origRender = UI.render;
    const rw = function(){ Net.dirty = true; return origRender.apply(UI, arguments); };
    rw.__dirtyWrapped = true;
    UI.render = rw;
  }
};

Net.stopRecording = function(){
  Net.recording = false;
  Net.events.length = 0;
};

/** 主机侧：把累积的事件取出来并清空 */
Net.takeEvents = function(){
  if (!Net.events.length) return null;
  const e = Net.events;
  Net.events = [];
  return e;
};

/* ---- 客户端侧：事件回放 ---- */

const replayQueue = [];
let replaying = false;

const REPLAY_FN = {
  sfx:          (FX, a) => FX.sfx(a[0]),
  floatText:    (FX, a) => FX.floatText(a[0], a[1], a[2]),
  shake:        (FX, a) => FX.shake(a[0], a[1]),
  flash:        (FX, a) => FX.flash(a[0]),
  thinking:     (FX, a) => FX.thinking(a[0], a[1]),
  skillBanner:  (FX, a) => FX.skillBanner(a[0], a[1]),
  beginExchange:(FX) => FX.beginExchange(),
  addToExchange:(FX, a) => FX.addToExchange(a[0], a[1], a[2], a[3]),
  cardPlay:     (FX, a) => FX.cardPlay(a[0], a[1], a[2], a[3]),
  endExchange:  (FX) => FX.endExchange(),
  turnBanner:   (FX, a) => FX.turnBanner(a[0]),
  judge:        (FX, a) => FX.judge(a[0], a[1]),
  death:        (FX, a) => FX.death(a[0]),
  gameEnd:      (FX, a) => FX.gameEnd(a[0])
};

Net.enqueueEvents = function(list){
  if (!list || !list.length) return;
  for (const ev of list) replayQueue.push(ev);
  if (!replaying) pumpReplay();
};

function pumpReplay(){
  replaying = true;
  const step = () => {
    if (!replayQueue.length){ replaying = false; return; }
    const backlogged = replayQueue.length > REPLAY_BACKLOG;
    const ev = replayQueue.shift();
    let r = null;
    try {
      if (ev.k === 'phase'){
        window.UI.setPhase(ev.a[0]);
      } else {
        const fn = REPLAY_FN[ev.k];
        if (fn) r = fn(window.FX, (ev.a || []).map(x => unpack(x, 0)));
      }
    } catch (e){
      // 单条演出失败不能拖垮整个回放
      r = null;
    }
    if (r && typeof r.then === 'function' && !backlogged){
      r.then(step, step);
    } else {
      step();       // 积压时不等动画，直接往下走
    }
  };
  step();
}

Net.replayPending = function(){ return replayQueue.length; };

/* =========================================================
 *  4. transport —— 长轮询客户端
 * ========================================================= */

function delay(ms){
  return new Promise(r => setTimeout(r, ms));
}
Net.delay = delay;

/** 服务器地址：从 http(s) 打开时用同源地址（零配置）；否则用存下来的地址 */
Net.serverBase = function(){
  if (location.protocol === 'http:' || location.protocol === 'https:') return location.origin;
  try { return localStorage.getItem('dqk_net_server') || ''; } catch (e){ return ''; }
};

Net.setServerBase = function(url){
  try { localStorage.setItem('dqk_net_server', url || ''); } catch (e){ /* 忽略 */ }
};

function Transport(baseUrl, code, peer, token, handlers){
  this.base = String(baseUrl).replace(/\/+$/, '');
  this.code = code;
  this.peer = peer;
  this.token = token;
  this.seq = 0;
  this.handlers = handlers || {};
  this.running = false;
  this.online = false;
}

Transport.prototype.post = function(path, body, timeoutMs){
  const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs || 45000) : null;
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store'
  };
  if (ctl) init.signal = ctl.signal;
  return fetch(this.base + path, init).then(
    r => r.json().then(j => { if (timer) clearTimeout(timer); return j; }),
    e => { if (timer) clearTimeout(timer); throw e; }
  );
};

Transport.prototype.start = function(){
  if (this.running) return;
  this.running = true;
  this.loop();
};

Transport.prototype.stop = function(){
  this.running = false;
};

Transport.prototype.setOnline = function(v){
  if (this.online === v) return;
  this.online = v;
  const h = this.handlers;
  if (v && h.onUp) h.onUp();
  if (!v && h.onDown) h.onDown();
};

/**
 * 长轮询主循环。
 *
 * 注意：**绝不用 setTimeout 串起来**。浏览器会把后台标签页的定时器节流到
 * 几十秒甚至一分钟一次，那样玩家切走再回来游戏就卡死了。这里靠服务端
 * 25 秒超时返回空响应来自然驱动节奏，客户端拿到响应立刻发下一次请求 ——
 * 整个循环里没有任何定时器，后台标签页也不会变慢。
 */
Transport.prototype.loop = async function(){
  while (this.running){
    let res = null;
    try {
      res = await this.post('/api/poll', {
        code: this.code, peer: this.peer, token: this.token, since: this.seq
      }, 40000);
    } catch (e){
      if (!this.running) break;
      this.setOnline(false);
      await delay(1500);
      continue;
    }
    if (!this.running) break;
    if (!res || !res.ok){
      this.setOnline(false);
      if (this.handlers.onFatal && res && res.err) this.handlers.onFatal(res.err);
      await delay(2500);
      continue;
    }
    this.setOnline(true);
    if (typeof res.seq === 'number') this.seq = res.seq;
    if (res.resync && this.handlers.onResync) this.handlers.onResync();
    const msgs = res.msgs || [];
    for (const m of msgs){
      try { if (this.handlers.onMessage) this.handlers.onMessage(m); }
      catch (e){ /* 单条消息出错不能中断轮询 */ }
    }
  }
};

Transport.prototype.send = function(to, data){
  return this.post('/api/send', {
    code: this.code, peer: this.peer, token: this.token, to: to, data: data
  }, 15000).catch(() => null);
};

/** 加入/创建房间。成功返回 {code, peer, token, host}，失败抛错。 */
Net.connect = function(baseUrl, path, body){
  const base = String(baseUrl).replace(/\/+$/, '');
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store'
  }).then(r => r.json()).then(j => {
    if (!j || !j.ok) throw new Error((j && j.err) || '服务器没有响应');
    return j;
  }, e => {
    throw new Error('连不上服务器（' + base + '）：' + (e && e.message ? e.message : e));
  });
};

Net.Transport = Transport;

/* =========================================================
 *  5. session —— 主机与客户端共用的会话状态
 * ========================================================= */

Net.rev = 0;
Net.session = null;        // {base, code, peer, token, name, isHost}
Net.roster = [];           // [{peer, name, spectator, seat, online, self}]
Net.mySeat = -1;           // 客户端自己坐哪（旁观 = -1）
Net.config = { count: 5, deal: 3, mode: 'A', protect: true, hostPlays: true };
Net.lastResult = null;

Net.isOnline = function(){ return !!(Net.session && Net.transport && Net.transport.running); };

Net.setSpeed = function(v){
  if (!Net.session) return;
  if (Net.session.isHost){
    if (window.G) G.speed = v;
    Net.speed = v;
  } else {
    Net.transport.send('host', { t: 'speed', v: v });
  }
};

function esc(s){
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sendTo(peer, data){
  if (!Net.transport) return;
  Net.transport.send(peer, data);
}

/** 广播给房间里所有人（to='all' 不会回声给发送者，所以本机要自己渲染） */
function broadcast(data){
  if (Net.transport) Net.transport.send('all', data);
}

/* =========================================================
 *  6. lobby —— 建房 / 加入 / 房间等待
 * ========================================================= */

function netBox(){ return document.getElementById('net-box'); }

function renderLobby(html){
  const box = netBox();
  if (!box) return;
  box.innerHTML =
    '<h2>联机对战</h2>' + html +
    '<div class="start-actions"><button id="net-back">返回单机</button></div>';
  const back = document.getElementById('net-back');
  if (back) back.addEventListener('click', Net.leave);
}

function serverHint(){
  const b = Net.serverBase();
  if (b) return '<p class="hint">服务器：<b>' + esc(b) + '</b></p>';
  return '<p class="hint warn-hint">当前是从本地文件打开的，请填写服务器地址（房主启动 server.py 时会打印）</p>';
}

function serverRow(){
  return '<div class="form-row"><label>服务器地址</label>' +
    '<input type="text" id="net-server" placeholder="http://192.168.1.5:8080" value="' +
    esc(Net.serverBase()) + '"></div>';
}

/** 首页：创建房间 / 加入房间 */
Net.showHome = function(){
  const auto = Net.serverBase();
  renderLobby(
    serverHint() +
    (auto ? '' : serverRow()) +
    '<div class="form-row"><label>你的名字</label>' +
      '<input type="text" id="net-name" maxlength="8" placeholder="最多 8 个字" value="' +
      esc(Net.savedName()) + '"></div>' +
    '<div class="form-row"><label>房间人数</label>' +
      '<div class="btn-group" id="net-count">' +
        [4, 5, 6, 7, 8].map(n => '<button data-n="' + n + '"' +
          (n === Net.config.count ? ' class="on"' : '') + '>' + n + ' 人</button>').join('') +
      '</div></div>' +
    '<div class="start-actions">' +
      '<button id="net-create" class="primary big">创建房间</button>' +
      '<button id="net-join" class="big">加入房间</button>' +
    '</div>' +
    '<div id="net-join-row" style="display:none">' +
      '<div class="form-row"><label>房间号</label>' +
        '<input type="text" id="net-code" class="room-code" maxlength="4" inputmode="numeric" placeholder="0000"></div>' +
      '<div class="start-actions">' +
        '<button id="net-join-go" class="primary">进入房间</button>' +
        '<button id="net-spectate-go">旁观</button>' +
      '</div>' +
    '</div>'
  );

  document.querySelectorAll('#net-count button').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#net-count button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      Net.config.count = +b.dataset.n;
    });
  });
  document.getElementById('net-create').addEventListener('click', () => {
    if (!readServer()) return;
    Net.hostStart({ count: Net.config.count });
  });
  document.getElementById('net-join').addEventListener('click', () => {
    const row = document.getElementById('net-join-row');
    row.style.display = '';
    document.getElementById('net-code').focus();
  });
  document.getElementById('net-join-go').addEventListener('click', () => {
    if (!readServer()) return;
    const code = (document.getElementById('net-code').value || '').trim();
    if (!/^\d{4}$/.test(code)){ window.UI.toast('房间号是 4 位数字', 'warn'); return; }
    Net.clientStart({ code: code, spectator: false });
  });
  document.getElementById('net-spectate-go').addEventListener('click', () => {
    if (!readServer()) return;
    const code = (document.getElementById('net-code').value || '').trim();
    if (!/^\d{4}$/.test(code)){ window.UI.toast('房间号是 4 位数字', 'warn'); return; }
    Net.clientStart({ code: code, spectator: true });
  });
};

function readServer(){
  const el = document.getElementById('net-server');
  if (el){
    const v = (el.value || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(v)){ window.UI.toast('服务器地址要以 http:// 开头', 'warn'); return false; }
    Net.setServerBase(v);
  }
  if (!Net.serverBase()){
    window.UI.toast('请先填写服务器地址', 'warn');
    return false;
  }
  return true;
}

/**
 * 邀请链接：房主一条链接发到群里，同学点开就能进房间 ——
 * 不用再让人手抄「服务器地址 + 4 位房间号」两样东西。
 * 只有在从 http(s) 打开时才能生成（能推断出服务器地址）。
 */
Net.inviteLink = function(){
  if (!Net.session || !Net.session.code) return '';
  const base = Net.serverBase();
  if (!base) return '';
  return base.replace(/\/+$/, '') + '/?room=' + Net.session.code;
};

/**
 * 从 URL 的 ?room=1234 自动进入房间。
 * 地址能从网页地址推断出来时（也就是同源打开）直接进房，省掉一次点击；
 * 否则至少把房间号填好、界面切过去，让用户补一下服务器地址。
 * 返回 true 表示"这次启动是被邀请链接驱动的"。
 */
Net.autoJoinFromUrl = function(){
  let room = null;
  try { room = new URLSearchParams(location.search).get('room'); } catch (e){ /* 忽略 */ }
  if (!room || !/^\d{4}$/.test(room)) return false;
  Net.pendingRoom = room;

  Net.showHome();
  window.UI.show('net');
  const joinRow = document.getElementById('net-join-row');
  if (joinRow) joinRow.style.display = '';
  const codeEl = document.getElementById('net-code');
  if (codeEl) codeEl.value = room;

  if (Net.serverBase()){
    // 同源打开：直接进去
    setTimeout(() => { if (!Net.session) Net.clientStart({ code: room, spectator: false }); }, 250);
  } else {
    window.UI.toast('收到房间 ' + room + ' 的邀请，填一下服务器地址就能进', '');
  }
  return true;
};

Net.savedName = function(){
  try { return localStorage.getItem('dqk_net_name') || ''; } catch (e){ return ''; }
};

function readName(){
  const el = document.getElementById('net-name');
  let v = el ? (el.value || '').trim().slice(0, 8) : '';
  if (!v) v = '玩家';
  try { localStorage.setItem('dqk_net_name', v); } catch (e){ /* 忽略 */ }
  return v;
}

/** 座位分配：非旁观者按加入顺序坐 0..count-1，坐满了自动转旁观 */
function assignSeats(){
  let seat = 0;
  Net.roster.forEach(r => {
    if (r.spectator){ r.seat = -1; return; }
    if (seat < Net.config.count) r.seat = seat++;
    else { r.seat = -1; r.spectator = true; }
  });
}

/** 房间等待界面 */
function renderRoom(status){
  const me = Net.session;
  const isHost = me && me.isHost;
  let rows = Net.roster.map(r => {
    const you = r.self ? '　<span style="color:#8fb8e8">（你）</span>' : '';
    const tag = r.spectator
      ? '<span class="lobby-tag">旁观</span>'
      : '<span class="lobby-tag seat">' + (r.seat + 1) + ' 号位</span>';
    const boss = r.host ? '<span class="lobby-tag host">房主</span>' : '';
    const off = r.online ? '' : '<span class="lobby-tag off">掉线</span>';
    return '<div class="lobby-row"><span class="lobby-name">' + esc(r.name) + you + '</span>' +
           tag + boss + off + '</div>';
  }).join('');

  const humans = Net.roster.filter(r => !r.spectator).length;
  const bots = Math.max(0, Net.config.count - humans);

  renderLobby(
    '<div class="room-line">房间号　<span class="room-code-big">' + esc(me.code) + '</span>' +
      '<button class="mini" id="net-copy">复制邀请链接</button></div>' +
    (Net.inviteLink()
      ? '<p class="hint">把这条链接发到群里，同学点开就能直接进房间：<br>' +
        '<span class="invite-link">' + esc(Net.inviteLink()) + '</span></p>'
      : '<p class="hint">' + serverHintText() +
        '把房间号告诉同学，他们在同一地址打开游戏、点「联机对战 → 加入房间」。</p>') +
    '<div class="lobby-list">' + rows + '</div>' +
    '<p class="hint">真人 ' + humans + ' 名' +
      (bots ? '，其余 <b>' + bots + '</b> 个座位由电脑补齐' : '') + '　·　总人数 ' + Net.config.count +
      (isHost ? '（可在下面改）' : '') + '</p>' +
    (isHost
      ? '<div class="form-row"><label>总人数</label><div class="btn-group" id="net-count2">' +
          [4, 5, 6, 7, 8].map(n => '<button data-n="' + n + '"' +
            (n === Net.config.count ? ' class="on"' : '') + '>' + n + ' 人</button>').join('') +
        '</div></div>' +
        '<div class="form-row"><label>身份模式</label><div class="btn-group" id="net-mode">' +
          [['A', 'A 随机身份'], ['B', 'B 自选阵营'], ['C', 'C 半随机']].map(function (m) {
            return '<button data-m="' + m[0] + '"' +
              (Net.config.mode === m[0] ? ' class="on"' : '') + '>' + m[1] + '</button>';
          }).join('') +
        '</div></div>' +
        '<p class="hint" id="net-mode-hint">' + modeHint(Net.config.mode) + '</p>' +
        '<div class="btn-group">' +
          '<button id="net-plays" class="toggle ' + (Net.config.hostPlays ? 'on' : '') + '">房主也参战</button>' +
          '<button id="net-protect" class="toggle ' + (Net.config.protect ? 'on' : '') + '">保护轮</button>' +
        '</div>' +
        '<div class="start-actions"><button id="net-go" class="primary big">开始游戏</button></div>'
      : '<p class="hint">等房主点「开始游戏」…</p>') +
    (status ? '<p class="hint warn-hint">' + esc(status) + '</p>' : '')
  );

  const copy = document.getElementById('net-copy');
  if (copy) copy.addEventListener('click', () => {
    const link = Net.inviteLink();
    const text = link || me.code;
    const tip = link ? '邀请链接已复制，发到群里就行' : ('房间号：' + text);
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(
      () => window.UI.toast(tip, 'good'), () => window.UI.toast(tip, ''));
    else window.UI.toast(tip, '');
  });

  if (!isHost) return;
  document.querySelectorAll('#net-count2 button').forEach(b => {
    b.addEventListener('click', () => {
      Net.config.count = +b.dataset.n;
      assignSeats();
      broadcastLobby();
    });
  });
  document.querySelectorAll('#net-mode button').forEach(b => {
    b.addEventListener('click', () => {
      Net.config.mode = b.dataset.m;
      broadcastLobby();
    });
  });
  document.getElementById('net-plays').addEventListener('click', () => {
    Net.config.hostPlays = !Net.config.hostPlays;
    assignSeats();
    broadcastLobby();
  });
  document.getElementById('net-protect').addEventListener('click', () => {
    Net.config.protect = !Net.config.protect;
    broadcastLobby();
  });
  document.getElementById('net-go').addEventListener('click', hostStartGame);
}

/** 三种身份模式的一句话说明（规则书 9.1） */
function modeHint(mode){
  if (mode === 'B') return '自选阵营：身份池公开，按座位顺序轮流挑，选完只有本人知道（院长公开）。';
  if (mode === 'C') return '半随机：先选角色、再揭晓身份 —— 你会在不知道身份的情况下挑武将。';
  return '随机身份：洗混身份牌，每人一张，竞技性最强。';
}

function serverHintText(){
  const b = Net.serverBase();
  if (!b) return '';
  try {
    const host = location.host;
    if (host && b === location.origin) return '';   // 同源，不用说地址
  } catch (e){ /* 忽略 */ }
  return '服务器地址 <b>' + esc(b) + '</b>　';
}

/** 房主：把大厅状态逐个发给每个人（每个人的「你」不同，所以不能群发） */
function broadcastLobby(){
  if (!Net.session || !Net.session.isHost) return;
  Net.roster.forEach(r => {
    sendTo(r.peer, {
      t: 'lobby',
      code: Net.session.code,
      count: Net.config.count,
      hostPlays: Net.config.hostPlays,
      protect: Net.config.protect,
      roster: Net.roster.map(x => ({
        name: x.name, seat: x.seat, host: !!x.host, online: !!x.online,
        spectator: !!x.spectator, self: x.peer === r.peer
      }))
    });
  });
  renderRoom();
}

/* =========================================================
 *  7. host —— 房主侧接线
 * ========================================================= */

Net.hostStart = function(cfg){
  const base = Net.serverBase();
  const name = readName();
  Net.session = { base: base, name: name, isHost: true };
  Net.config.count = (cfg && cfg.count) || Net.config.count;

  Net.connect(base, '/api/create', { name: name }).then(info => {
    Net.session.code = info.code;
    Net.session.peer = info.peer;
    Net.session.token = info.token;
    Net.roster = [{ peer: info.peer, name: name, spectator: false, seat: 0,
                    online: true, self: true, host: true }];
    if (!Net.config.hostPlays) Net.roster[0].spectator = true;
    assignSeats();
    Net.transport = new Transport(base, info.code, info.peer, info.token, {
      onMessage: hostOnMessage,
      onDown: () => toastIfGame('与中转服务器的连接断了，正在重连…'),
      onUp: () => { hostResync(); }
    });
    Net.transport.start();
    window.UI.syncOnlineUI(true);
    renderRoom();
    window.UI.show('net');
  }).catch(err => {
    window.UI.toast(err.message || '创建房间失败', 'warn');
  });
};

function toastIfGame(msg){
  if (window.G && G.players && G.players.length && !G.over) window.UI.toast(msg, 'warn');
}

function hostOnMessage(m){
  const d = m.data || {};
  switch (d.t){
    case 'joined': {
      if (Net.roster.some(r => r.peer === d.peer)) break;
      Net.roster.push({ peer: d.peer, name: d.name || '玩家', spectator: !!d.spectator,
                        seat: -1, online: true, host: false });
      assignSeats();
      broadcastLobby();
      if (Net.started) hostResync();          // 中途加入的算旁观
      break;
    }
    case 'left': {
      const r = Net.roster.find(x => x.peer === d.peer);
      if (!r) break;
      r.online = false;
      // 游戏进行中：把他的座位交给 AI 托管，否则全桌会一直等一个不在的人
      if (Net.started && r.seat >= 0 && window.G && G.players[r.seat]){
        const p = G.players[r.seat];
        p.auto = true;
        p.isHuman = false;
        E.log('⚠ ' + r.name + ' 掉线，已由电脑托管', 'dmg');
        Net.dirty = true;
      }
      broadcastLobby();
      break;
    }
    case 'rejoined': {
      const r = Net.roster.find(x => x.peer === d.peer);
      if (!r) break;
      r.online = true;
      if (Net.started && r.seat >= 0 && window.G && G.players[r.seat]){
        const p = G.players[r.seat];
        p.auto = false;
        p.isHuman = true;
        E.log('✔ ' + r.name + ' 重新连上了', 'sys');
        Net.dirty = true;
      }
      broadcastLobby();
      hostResync();
      break;
    }
    case 'ans':  hostOnAnswer(m.from, d); break;
    case 'pick': hostOnPick(m.from, d); break;
    case 'idpick': hostOnIdPick(m.from, d); break;
    case 'discard':
      // 弃牌堆是公开信息（每次弃牌都进了日志），按需给一份即可
      sendTo(m.from, { t: 'discard', cards: (G.discard || []).map(inlineCard) });
      break;
    case 'chat': {
      const r = Net.roster.find(x => x.peer === m.from);
      hostChat(r ? r.seat : -1, r ? r.name : '？', d.text);
      break;
    }
    case 'speed': {
      const v = +d.v;
      if (isFinite(v) && v > 0 && window.G){
        G.speed = v;
        Net.speed = v;
        E.log('节奏已改为 ' + v + '×', 'sys');
      }
      break;
    }
    case 'hello': hostResync(); break;
    default: break;
  }
}

/** 有人（重新）连上时，补发它需要的全部状态 */
function hostResync(){
  if (!Net.started){
    broadcastLobby();
    return;
  }
  Net.roster.forEach(r => {
    if (!r.online) return;
    if (r.spectator || r.seat < 0){
      pendingFrames.push({ peer: r.peer, data: { t: 'watch', s: Net.project(-1, false) } });
    } else {
      pendingFrames.push({ peer: r.peer, data: {
        t: 'go', seat: r.seat, s: Net.project(r.seat, false)
      }});
      // 如果有挂在这个座位上的询问，重发一次，不然他会看到卡住不动的桌面
      const ask = Net.pendingAsk;
      if (ask && ask.seat === r.seat){
        pendingFrames.push({ peer: r.peer, data: {
          t: 'ask', id: ask.id, req: ask.packed, s: Net.project(r.seat, false)
        }});
      }
    }
  });
  Net.dirty = true;
}

/* ---- 选角 ---- */

function hostStartGame(){
  if (!Net.session || !Net.session.isHost) return;
  const humans = Net.roster.filter(r => !r.spectator && r.online);
  if (!humans.length){ window.UI.toast('至少要有一个人参战', 'warn'); return; }
  Net.started = true;
  Net.config.count = Math.max(Net.config.count, humans.length);

  const humanSeats = humans.map(r => r.seat).sort((a, b) => a - b);
  Net.rolePick = {};
  humanSeats.forEach(s => { Net.rolePick[s] = null; });

  E.initGame({
    count: Net.config.count, mode: Net.config.mode, deal: Net.config.deal,
    hotseat: false, protect: Net.config.protect, networkRule: false,
    humanSeats: humanSeats
  });
  // 房主如果只是"开房不玩"，就按旁观处理 —— 否则会渲染成某个玩家的视角而看到他的手牌
  if (!Net.config.hostPlays) G.humanSeat = -1;
  Net.humanSeats = humanSeats;

  // 旁观者先安置好
  Net.roster.forEach(r => {
    if (r.spectator || r.seat < 0) sendTo(r.peer, { t: 'watch', s: Net.project(-1, false) });
  });
  broadcastLobby();

  if (G.humanSeat < 0 && !Net.config.hostPlays) window.UI.toast('你是房主，本局旁观', '');
  hostDraftStep();     // 模式 B 先走身份轮抽，其他模式直接进选角
}

/* ---- 设置阶段的状态机（联机版）----
 * 顺序和单机一致：模式 B 先轮抽身份，然后所有人选角。 */

function hostDraftStep(){
  if (G.mode === 'B'){
    const seat = E.advanceIdentityDraft();
    if (seat >= 0){
      if (seat === G.humanSeat){
        window.showDraftPicker(seat, k => { E.assignIdentity(seat, k); hostDraftStep(); });
        return;
      }
      const r = Net.roster.find(x => x.seat === seat);
      if (r){
        sendTo(r.peer, { t: 'draft', seat: seat, mode: G.mode,
                         pool: E.identityPoolLeft(), s: Net.project(seat, false) });
        return;
      }
      // 找不到这个座位的人（掉线了）→ 交给电脑挑，继续往下走
      E.assignIdentity(seat, E.identityPoolLeft()[0]);
      return hostDraftStep();
    }
  }
  // 轮抽结束（或本来就不是 B）→ 选角
  Net.roster.forEach(r => {
    if (r.spectator || r.seat < 0) return;
    const p = G.players[r.seat];
    sendTo(r.peer, {
      t: 'role', seat: r.seat,
      mode: G.mode,
      identity: G.mode === 'C' ? null : p.identity,   // C 模式选角时还不揭晓
      choices: p.charChoices.map(c => c.id),
      dealPer: G.dealPer,
      total: D.CHARACTERS.length,
      // 带上快照：客户端还没建过 G.players，得靠它把玩家对象建起来
      s: Net.project(r.seat, false)
    });
  });
  if (G.humanSeat >= 0) window.showRolePicker(G.humanSeat, c => hostPickRole(G.humanSeat, c));
}

function hostPickRole(seat, char){
  E.assignRole(seat, char);
  Net.rolePick[seat] = char.id;
  const next = () => {
    if (E.pendingRoleSeats().length === 0) hostBeginPlay();
    else window.UI.show('net');
  };
  if (G.mode === 'C' && seat === G.humanSeat) window.showIdentityReveal(seat, next);
  else next();
}

/** 远端玩家挑身份 */
function hostOnIdPick(peer, d){
  const r = Net.roster.find(x => x.peer === peer);
  if (!r || r.seat < 0) return;
  if (!E.assignIdentity(r.seat, d.key)) return;   // 池子里没有 / 已经挑过了
  hostDraftStep();
}

function hostOnPick(peer, d){
  const r = Net.roster.find(x => x.peer === peer);
  if (!r || r.seat < 0) return;
  const p = G.players[r.seat];
  if (!p || p.char) return;
  const char = D.CHARACTERS.find(c => c.id === d.charId);
  if (!char) return;
  if (p.charChoices.length && !p.charChoices.some(c => c.id === d.charId)) return;  // 只能挑自己的候选
  hostPickRole(r.seat, char);
}

/* ---- 开局 ---- */

function hostBeginPlay(){
  E.finalizeRoles();
  E.finalizeGame();
  E.dealInitialHands();
  Net.indexDeck();

  if (Net.speed) G.speed = Net.speed;

  // 联机时**必须**锁死"点击清空"：它会让被 await 的 FX.endExchange / FX.judge
  // 无限等本机点击，从而卡死整条流水线。功能没收，只是转成客户端各自在回放时生效。
  const FX = window.FX;
  if (FX){
    FX.manualAdvance = false;
    FX.setAdvance = function(){ return false; };
    const ab = document.getElementById('btn-advance');
    if (ab){
      ab.textContent = '▶ 自动清空';
      ab.disabled = true;
      ab.title = '联机时出牌区必须自动清空，否则会卡住全桌';
    }
  }

  bindHostAsk();
  Net.rev = 0;
  Net.dirty = true;
  Net.startRecording();
  Net.startRec(G.humanSeat, G.players.length);      // 开录复盘
  Net.frameTimer = setInterval(flushFrame, 120);
  startAutosave();                                   // 定期存盘，房主掉线后别人能接手

  const origEnd = E.endGame;
  E.endGame = function(winner, reason){
    Net.lastResult = { winner: winner, reason: reason };
    return origEnd.apply(E, arguments);
  };

  window.UI.show('game');
  window.UI.render();

  Net.roster.forEach(r => {
    sendTo(r.peer, { t: 'go', seat: r.seat, s: Net.project(r.seat, false) });
  });

  E.gameLoop().then(hostGameOver, hostGameOver);
}

function hostGameOver(){
  window.Net && Net.flushFrameNow && Net.flushFrameNow();
  if (Net.frameTimer){ clearInterval(Net.frameTimer); Net.frameTimer = null; }
  stopAutosave();
  Net.stopRecording();
  Net.setAsking(-1, 0);
  const res = Net.lastResult || { winner: null, reason: '' };
  const identities = G.players.map(p => p.identity);
  const seats = G.players.map(p => p.seat);
  Net.roster.forEach(r => {
    sendTo(r.peer, {
      t: 'over', winner: res.winner, reason: res.reason,
      seats: seats, identities: identities
    });
  });
  Net.started = false;
}

/* ---- 状态与事件的广播 ---- */

let lastFullSnap = 0;
const pendingFrames = [];

function flushFrame(){
  if (!Net.session || !Net.session.isHost) return;
  const events = Net.takeEvents();
  const now = Date.now();
  const needSnap = Net.dirty || (now - lastFullSnap > 1500);
  if (!events && !needSnap) return;
  if (needSnap) lastFullSnap = now;
  Net.dirty = false;
  Net.rev++;

  Net.roster.forEach(r => {
    if (!r.online || r.seat === undefined) return;
    const msg = { t: 'frame', rev: Net.rev };
    if (events) msg.ev = events;
    if (needSnap) msg.s = Net.project(r.seat, false);
    pendingFrames.push({ peer: r.peer, data: msg });
  });
  // 房主自己也录一份（按自己的视角，和客户端录的格式完全一致）
  const mySeat = (typeof G.humanSeat === 'number') ? G.humanSeat : -1;
  recPush({ s: needSnap ? Net.project(mySeat, false) : null, ev: events });
  drainFrames();
}

function drainFrames(){
  while (pendingFrames.length){
    const f = pendingFrames.shift();
    sendTo(f.peer, f.data);
  }
}
Net._flushFrame = flushFrame;        // 暴露给自测
Net.flushFrameNow = flushFrame;      // 对局结束时立刻把最后一帧发出去

/* ---- 询问桥接 ---- */

function bindHostAsk(){
  const UI = window.UI;
  if (UI.__netAskBound) return;
  const orig = UI.askHuman;
  UI.__netAskBound = true;
  UI.askHuman = async function(req){
    const seat = (req && req.player) ? req.player.seat : -1;
    // 房主自己走原生界面（但要让别人看到"房主在思考"）
    if (seat === G.humanSeat){
      Net.setAsking(seat, 0);
      try { return await orig(req); }
      finally { Net.setAsking(-1, 0); }
    }
    // 注意：**按 req.player.seat 分流，不能按 G.humanSeat 分流** ——
    // humanSeat 只在回合开始时更新一次（engine.js:1378 的上下文），
    // 回合外的询问（响应牌、濒死救援）会指向错的座位。
    if (seat < 0 || !G.players[seat] || !G.players[seat].isHuman) return window.AI.decide(req);
    const res = await Net.remoteAsk(seat, req);
    if (res && res.__auto) return await window.AI.decide(req);
    return unpack(res, 0);
  };
}

Net.askSeq = 0;
Net.askingSeat = -1;
Net.askUntil = 0;

/** 记录"正在等谁"，并让下一帧快照把它带给全场 */
Net.setAsking = function(seat, until){
  Net.askingSeat = (typeof seat === 'number' && seat >= 0) ? seat : -1;
  Net.askUntil = until || 0;
  Net.dirty = true;
};

Net.remoteAsk = function(seat, req){
  return new Promise(resolve => {
    const peer = peerForSeat(seat);
    if (!peer){ resolve({ __auto: true }); return; }
    const id = ++Net.askSeq;
    const packed = pack(prepareReq(req), 0);
    const until = Date.now() + Net.askTimeoutMs;
    Net.pendingAsk = { id: id, seat: seat, packed: packed, resolve: resolve };
    Net.setAsking(seat, until);
    // 超时托管：手机锁屏、关标签页、人走开了，都不能让全桌一直等
    Net.pendingAsk.timer = setTimeout(() => {
      if (Net.pendingAsk && Net.pendingAsk.id === id){
        const p = G.players[seat];
        if (p){ p.auto = true; p.isHuman = false; }
        E.log('⏱ ' + (p ? p.name : ('座位 ' + (seat + 1))) + ' 超时未响应，本回合由电脑代打', 'dmg');
        Net.pendingAsk = null;
        Net.setAsking(-1, 0);
        Net.dirty = true;
        resolve({ __auto: true });
      }
    }, Net.askTimeoutMs);
    pendingFrames.push({ peer: peer, data: {
      t: 'ask', id: id, req: packed, s: Net.project(seat, false)
    }});
    drainFrames();
  });
};

Net.askTimeoutMs = 60000;

/* =========================================================
 *  房主掉线 · 存档接手
 * =========================================================
 *  引擎跑在房主浏览器里，所以他关掉页面这局就没了。
 *  无缝续玩做不到（async 长链没法序列化到一半），但**近似续玩**可以：
 *  房主每几秒把整局状态存到中转服务器，他掉线之后任何一个人点一下
 *  「我来接手」，就能用这份存档接着打下去。
 *
 *  代价说清楚：接手是从**当前回合的开头**继续的（不是精确到出牌阶段中间），
 *  所以当前行动的人这一回合会重来一次（会多摸两张牌）。
 *  这比"整局没了"好得多，但确实是失真的。
 */

let saveTimer = null;

/** 把整局状态拍成一份可 JSON 化的存档 */
function serializeGame(){
  const G = window.G;
  return {
    v: 1,
    savedAt: new Date().toISOString(),
    hostSeat: (typeof Net.mySeat === 'number') ? Net.mySeat : G.humanSeat,
    hostName: (Net.roster.find(r => r.seat === Net.mySeat) || {}).name || '房主',
    roster: Net.roster.map(r => ({ peer: r.peer, name: r.name, seat: r.seat,
                                   spectator: !!r.spectator, online: !!r.online })),
    game: {
      mode: G.mode, opts: G.opts, turnSeat: G.turnSeat, round: G.round,
      turnId: G.turnId, speed: G.speed, rescueLog: G.rescueLog || {},
      idPool: G.idPool || [], harmLog: G.harmLog || [], log: G.log || [],
      humanSeats: G.humanSeats || [], dealPer: G.dealPer, firstRound: G.firstRound,
      deck: G.deck || [], discard: G.discard || [],
      players: G.players.map(p => ({
        seat: p.seat, charId: p.char ? p.char.id : null, identity: p.identity,
        revealed: !!p.revealed, hp: p.hp, maxHp: p.maxHp, alive: !!p.alive,
        hand: p.hand, equips: p.equips, judge: p.judge, chained: !!p.chained,
        marks: p.marks, isHuman: !!p.isHuman, auto: !!p.auto,
        skillsUsedThisTurn: p.skillsUsedThisTurn || {},
        usedCardsThisTurn: p.usedCardsThisTurn || [],
        damageDealtThisTurn: p.damageDealtThisTurn || 0,
        usedAttackCardThisPhase: p.usedAttackCardThisPhase || 0,
        usedDelayed: p.usedDelayed || 0, hotUsed: p.hotUsed || 0, shuikeUsed: p.shuikeUsed || 0,
        skip: p.skip || {}, dodgeBan: !!p.dodgeBan, pointBan: !!p.pointBan,
        charChoices: (p.charChoices || []).map(c => c.id)
      }))
    }
  };
}

/** 把存档装回 G。玩家对象要补回 name getter（defineProperty 的东西不进 JSON）。 */
function deserializeGame(save){
  const s = save.game;
  const G = window.G;
  G.mode = s.mode; G.opts = s.opts || {}; G.turnSeat = s.turnSeat; G.round = s.round;
  G.turnId = s.turnId; G.speed = s.speed || 1.35;
  G.rescueLog = s.rescueLog || {}; G.idPool = s.idPool || [];
  G.harmLog = s.harmLog || []; G.log = s.log || [];
  G.humanSeats = s.humanSeats || []; G.dealPer = s.dealPer;
  G.firstRound = !!s.firstRound;
  G.deck = s.deck || []; G.discard = s.discard || [];
  G.over = false;
  G.players = s.players.map(sp => {
    const p = Object.assign({}, sp);
    p.char = sp.charId ? CHAR_BY_ID[sp.charId] : null;
    p.charChoices = (sp.charChoices || []).map(id => CHAR_BY_ID[id]).filter(Boolean);
    p.marks = p.marks || {};
    p.equips = p.equips || { weapon: null, armor: null, mountUp: null, mountDown: null };
    p.judge = p.judge || [];
    p.hand = p.hand || [];
    Object.defineProperty(p, 'name', {
      get(){ return this.char ? this.char.name : ('座位 ' + (this.seat + 1)); },
      enumerable: false, configurable: true
    });
    return p;
  });
  G.gen = (G.gen || 0) + 1;
  window.G = G;
  Net.indexAll();
  return G;
}

Net._serializeGame = serializeGame;       // 暴露给自测
Net._deserializeGame = deserializeGame;

/** 主机侧：把这局存到中转服务器上（服务器不理解内容，只保管） */
function autosave(){
  if (!Net.session || !Net.session.isHost) return;
  if (!window.G || !G.players || !G.players.length) return;
  if (G.over) return;
  let payload;
  try { payload = serializeGame(); } catch (e){ return; }
  Net.connect(Net.session.base, '/api/save', {
    code: Net.session.code, peer: Net.session.peer, token: Net.session.token, save: payload
  }).catch(() => { /* 存盘失败不影响游戏 */ });
}

function startAutosave(){
  stopAutosave();
  autosave();
  saveTimer = setInterval(autosave, 4000);
}
function stopAutosave(){
  if (saveTimer){ clearInterval(saveTimer); saveTimer = null; }
}

/* ---- 接手 ---- */

Net.takeover = function(){
  if (!Net.session) return;
  const s = Net.session;
  Net.connect(s.base, '/api/takeover', { code: s.code, peer: s.peer, token: s.token })
    .then(info => {
      if (!info.save) throw new Error('没有可用的存档');
      // 1. 装回局面
      deserializeGame(info.save);
      // 2. 我变成房主
      Net.session.isHost = true;
      s.isHost = true;
      Net.mySeat = info.save.hostSeat;
      G.humanSeat = Net.mySeat;
      // 3. 重建名单（peerId 没变，客户端那边还是原来的连接）
      if (info.save.roster && info.save.roster.length){
        Net.roster = info.save.roster.filter(r => r.peer).map(r => Object.assign({}, r));
      } else {
        Net.roster = info.peers.map(p => ({ peer: p.peer, name: p.name, seat: -1,
                                            spectator: !!p.spectator, online: true }));
        assignSeats();
      }
      // 原房主那个座位交给人不在的电脑托管
      const old = Net.roster.find(r => r.seat !== Net.mySeat && r.name === info.save.hostName);
      if (old && G.players[old.seat]){ G.players[old.seat].isHuman = false; G.players[old.seat].auto = true; }

      // 4. 把主机那一套管线接上，然后从当前回合继续
      Net.setAsking(-1, 0);
      Net.rev = 0;
      Net.dirty = true;
      Net.startRecording();
      Net.startRec(Net.mySeat, G.players.length);
      bindHostAsk();
      const FX = window.FX;
      if (FX){ FX.manualAdvance = false; FX.setAdvance = function(){ return false; }; }
      const origEnd = E.endGame;
      E.endGame = function(winner, reason){
        Net.lastResult = { winner: winner, reason: reason };
        return origEnd.apply(E, arguments);
      };
      Net.frameTimer = setInterval(flushFrame, 120);
      startAutosave();

      window.UI.hideHostGone();
      window.UI.toast('已接手这局（本回合会从头开始）', 'good');
      E.log('⚠ ' + (info.save.hostName || '原房主') + ' 掉线，由 ' +
            (G.players[Net.mySeat] ? G.players[Net.mySeat].name : '?') +
            ' 接手继续（当前回合会重新开始）', 'dmg');
      Net.dirty = true;
      window.UI.show('game');
      window.UI.render();
      Net.roster.forEach(r => sendTo(r.peer, {
        t: 'go', seat: r.seat, s: Net.project(r.seat, false)
      }));
      E.gameLoop().then(hostGameOver, hostGameOver);
    })
    .catch(err => window.UI.toast(err.message || '接手失败', 'warn'));
};

/* =========================================================
 *  复盘 / 回放
 * =========================================================
 *  录的是**这一端自己看到的东西**（帧 = 快照 + 事件），不是权威全量状态。
 *  两个好处：文件小；而且复盘里天然不含别人的手牌 —— 房主把录像发出去
 *  也不会泄漏任何隐藏信息。
 *
 *  数据结构：{v, seat, seatCount, startedAt, frames:[{t, s?, ev?}]}
 *  t 是相对开始的毫秒数，回放时按它还原节奏。
 */

const REC_LIMIT = 6000;          // 帧数上限，超了就丢最早的（一局通常几百帧）

Net.rec = null;

Net.startRec = function(seat, seatCount){
  Net.rec = {
    v: 1, type: 'dqk-replay',
    seat: (typeof seat === 'number') ? seat : -1,
    seatCount: seatCount || 0,
    startedAt: new Date().toISOString(),
    frames: []
  };
  Net.recT0 = Date.now();
  Net.recLive = true;
};

Net.stopRec = function(){ Net.recLive = false; };

function recPush(o){
  if (!Net.rec || !Net.recLive) return;
  o.t = Date.now() - Net.recT0;
  Net.rec.frames.push(o);
  if (Net.rec.frames.length > REC_LIMIT) Net.rec.frames.shift();
}

/** 单机（没有联机会话）也要能录：走和主机同一套帧结构，只是不发出去 */
Net.startLocalRec = function(seat){
  Net.stopLocalRec();
  const n = (window.G && G.players) ? G.players.length : 5;
  Net.startRec(seat, n);
  Net.startRecording();                        // 录 FX 事件
  Net.dirty = true;
  Net.localRecTimer = setInterval(() => {
    const events = Net.takeEvents();
    const needSnap = Net.dirty;
    Net.dirty = false;
    if (events || needSnap) recPush({ s: needSnap ? Net.project(seat, false) : null, ev: events });
  }, 120);
};

Net.stopLocalRec = function(){
  if (Net.localRecTimer){ clearInterval(Net.localRecTimer); Net.localRecTimer = null; }
};

/* ---- 保存 ---- */

Net.hasReplay = function(){ return !!(Net.rec && Net.rec.frames && Net.rec.frames.length > 30); };

Net.saveReplay = function(){
  if (!Net.hasReplay()){ window.UI.toast('这一局还没录到什么东西', 'warn'); return; }
  const data = JSON.stringify(Net.rec);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  a.href = url;
  a.download = '东秦杀复盘-' + stamp + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  window.UI.toast('复盘已保存（' + Net.rec.frames.length + ' 帧）', 'good');
};

/* ---- 回放 ---- */

const R = {
  data: null, idx: 0, timer: null, speed: 1, playing: false, t0: 0, elapsed: 0
};
Net.replay = R;

Net.loadReplayFile = function(file, onErr){
  const fr = new FileReader();
  fr.onload = () => {
    let data = null;
    try { data = JSON.parse(fr.result); } catch (e){ data = null; }
    if (!data || data.type !== 'dqk-replay' || !Array.isArray(data.frames)){
      if (onErr) onErr('这不是一个有效的复盘文件');
      return;
    }
    Net.startReplay(data);
  };
  fr.onerror = () => { if (onErr) onErr('文件读不出来'); };
  fr.readAsText(file);
};

Net.startReplay = function(data){
  // 回放期间断开任何联机会话，免得后台还在收消息
  if (Net.session){ try { Net.leave(); } catch (e){ /* 忽略 */ } }
  R.data = data;
  R.idx = 0;
  R.speed = 1;
  R.playing = true;
  R.elapsed = 0;
  Net.mySeat = data.seat;
  Net.replayMode = true;
  Net.uidIndex.clear();
  window.UI.setThinking && window.UI.clearThinking();
  window.UI.show('game');
  window.UI.showReplayBar(true);
  replayPump();
};

function applyReplayFrame(f){
  if (f.s) hydrate(f.s);
  if (f.ev && f.ev.length) Net.enqueueEvents(f.ev);
}

function replayPump(){
  clearTimeout(R.timer);
  if (!R.playing || !R.data) return;
  if (R.idx >= R.data.frames.length){ Net.stopReplay(); return; }
  const f = R.data.frames[R.idx++];
  if (R.idx === 1) R.t0 = f.t;                 // 第一帧没有前导等待
  applyReplayFrame(f);
  const next = R.data.frames[R.idx];
  const gap = next ? Math.max(0, next.t - f.t) : 0;
  R.elapsed = f.t - R.t0;
  window.UI.updateReplayBar();
  R.timer = setTimeout(replayPump, Math.min(4000, gap / R.speed));
}

Net.toggleReplay = function(){
  if (!R.data) return;
  if (R.idx >= R.data.frames.length) { R.idx = 0; R.playing = true; replayPump(); return; }
  R.playing = !R.playing;
  if (R.playing) replayPump(); else clearTimeout(R.timer);
  window.UI.updateReplayBar();
};

Net.setReplaySpeed = function(v){
  R.speed = v;
  if (R.playing) replayPump();
  window.UI.updateReplayBar();
};

Net.stopReplay = function(){
  clearTimeout(R.timer);
  R.playing = false;
  R.data = null;
  Net.replayMode = false;
  window.UI.showReplayBar(false);
  window.UI.show('start');
};

/* ---- 弃牌堆查看 ---- */

/** 要一份完整的弃牌堆。单机和房主本地直接给，其他人问房主要。 */
Net.requestDiscard = function(){
  const local = (window.G && G.discard) || [];
  if (!Net.session || Net.session.isHost){
    window.UI.renderDiscard(local);
    return;
  }
  Net.transport.send('host', { t: 'discard' });
};

/* ---- 快捷语 ---- */

/** 房主收到/发出的一句话：本地显示 + 转发给所有人（带座位号，客户端才知道是谁说的） */
function hostChat(seat, name, text){
  const msg = { t: 'chat', seat: seat, name: name, text: String(text || '').slice(0, 40) };
  // 气泡 + 快捷语历史；**不写战斗日志**（写了会把人聊到刷屏）
  window.UI.pushChat(name, msg.text, seat);
  Net.roster.forEach(r => sendTo(r.peer, msg));
}

Net.sendChat = function(text){
  text = String(text || '').trim().slice(0, 30);
  if (!text) return;
  const me = window.G.players[window.G.humanSeat];
  const myName = me ? me.name : '我';
  if (!Net.session){                       // 单机：自己冒个泡就行
    window.UI.pushChat(myName, text, window.G.humanSeat);
    return;
  }
  if (Net.session.isHost){
    hostChat(window.G.humanSeat, Net.session.name || '房主', text);
  } else {
    if (Net.transport) Net.transport.send('host', { t: 'chat', text: text });
    window.UI.pushChat(myName, text, window.G.humanSeat);   // 自己也要看到自己说的话
  }
};

function peerForSeat(seat){
  const r = Net.roster.find(x => x.seat === seat && !x.spectator && x.online);
  return r ? r.peer : null;
}

/**
 * 主机侧预处理 req：把只有服务端才知道的东西先算好。
 *
 *  - selectCards 的 from / filter 是全项目**唯一**的函数字段（filter 是函数，没法序列化）。
 *    这里直接把牌池解析成具体的 cards 列表，客户端就不需要 filter / from 了。
 *  - 同时把可选项收窄，客户端就不可能回传一个主机不认的答案。
 */
function prepareReq(req){
  const out = Object.assign({}, req);
  if (out.kind === 'selectCards'){
    if (!out.cards){
      const p = req.player;
      out.cards = (out.from === 'any')
        ? p.hand.concat(D.EQUIP_SLOTS.map(k => p.equips[k]).filter(Boolean))
        : p.hand.slice();
    }
    if (out.filter) out.cards = out.cards.filter(out.filter);
    delete out.filter;
    delete out.from;
  }
  return out;
}

Net._prepareReq = prepareReq;          // 暴露给自测
Net._hostOnMessage = hostOnMessage;    // 暴露给自测

function hostOnAnswer(peer, d){
  const ask = Net.pendingAsk;
  if (!ask) return;
  if (ask.id !== d.id) return;                     // 陈旧答案（重连/重复点击）直接丢
  const r = Net.roster.find(x => x.peer === peer);
  if (!r || r.seat !== ask.seat) return;           // 冒名顶替
  if (ask.timer) clearTimeout(ask.timer);
  Net.pendingAsk = null;
  Net.setAsking(-1, 0);
  ask.resolve(d.res || {});
}

/* =========================================================
 *  8. client —— 瘦客户端接线
 * ========================================================= */

Net.clientStart = function(cfg){
  const base = Net.serverBase();
  const name = readName();
  const body = { code: cfg.code, name: name, spectator: !!cfg.spectator };
  Net.connect(base, '/api/join', body).then(info => {
    Net.session = { base: base, code: info.code, peer: info.peer, token: info.token,
                    name: name, isHost: false };
    Net.mySeat = -1;
    Net.spectator = !!cfg.spectator;
    saveSession();
    Net.transport = new Transport(base, info.code, info.peer, info.token, {
      onMessage: clientOnMessage,
      onDown: () => { if (Net.started) window.UI.toast('连接断了，正在重连…', 'warn'); },
      onUp: () => { if (!Net.started) sendTo('host', { t: 'hello' }); }
    });
    Net.transport.start();
    window.UI.syncOnlineUI(true);
    renderLobby('<p class="hint">正在进入房间 ' + esc(info.code) + ' …</p>');
    window.UI.show('net');
  }).catch(err => {
    window.UI.toast(err.message || '加入房间失败', 'warn');
    Net.showHome();
  });
};

/**
 * 把房间身份存进 **sessionStorage**（不是 localStorage）。
 *
 * sessionStorage 是**每个标签页独立**的，而 localStorage 是整个浏览器共享的。
 * 用 localStorage 的话，同学在同一台电脑上再开一个标签页想当第二个人，
 * 新标签页会读到前一个标签页的身份、认领**同一个 peerId**，
 * 于是两个人的答案会挤在同一个队列里，房主随机收到其中一个。
 * sessionStorage 正好满足需求：刷新页面还在（能自动重连），另开标签页互不干扰。
 */
function saveSession(){
  try {
    sessionStorage.setItem('dqk_net_last', JSON.stringify({
      base: Net.session.base, code: Net.session.code,
      peer: Net.session.peer, token: Net.session.token, name: Net.session.name
    }));
  } catch (e){ /* 忽略 */ }
}

/** 刷新页面后自动认领回原来的座位 */
Net.tryRejoin = function(){
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem('dqk_net_last') || 'null'); } catch (e){ saved = null; }
  if (!saved || !saved.code || !saved.token) return false;
  if (!Net.serverBase()) return false;
  const base = Net.serverBase();
  renderLobby('<p class="hint">正在重新连回房间 ' + esc(saved.code) + ' …</p>');
  window.UI.show('net');
  return Net.connect(base, '/api/rejoin', {
    code: saved.code, peer: saved.peer, token: saved.token
  }).then(info => {
    Net.session = { base: base, code: info.code, peer: info.peer, token: info.token,
                    name: saved.name, isHost: info.host };
    Net.transport = new Transport(base, info.code, info.peer, info.token, {
      onMessage: clientOnMessage,
      onDown: () => window.UI.toast('连接断了，正在重连…', 'warn')
    });
    Net.transport.start();
    window.UI.syncOnlineUI(true);
    if (!info.host) sendTo('host', { t: 'hello' });
    window.UI.toast('已重新连回房间 ' + info.code, 'good');
    return true;
  }).catch(() => {
    // 房间没了 / 服务器关了：安静地回到开始界面
    Net.session = null;
    try { sessionStorage.removeItem('dqk_net_last'); } catch (e){ /* 忽略 */ }
    window.UI.show('start');
    return false;
  });
};

function clientOnMessage(m){
  const d = m.data || {};
  switch (d.t){
    case 'lobby': clientLobby(d); break;
    case 'draft': clientDraft(d); break;
    case 'role':  clientRole(d); break;
    case 'go':    clientGo(d); break;
    case 'watch': clientWatch(d); break;
    case 'frame': clientFrame(d); break;
    case 'ask':   clientAsk(d); break;
    case 'over':  clientOver(d); break;
    case 'chat':
      window.UI.pushChat(d.name, d.text, d.seat);
      break;
    case 'discard':
      window.UI.renderDiscard(d.cards || []);
      break;
    case 'hostgone':
      // 房主（也就是整局的引擎）掉线了。所有人都会收到。
      window.UI.showHostGone(d.name);
      break;
    case 'takeover':
      window.UI.hideHostGone();
      break;
    default: break;
  }
}

function clientLobby(d){
  if (typeof d.count === 'number') Net.config.count = d.count;
  if (typeof d.protect === 'boolean') Net.config.protect = d.protect;
  Net.roster = (d.roster || []).map(r => Object.assign({}, r, { peer: null }));
  const mine = Net.roster.find(r => r.self);
  if (mine) Net.mySeat = mine.seat;
  if (d.code) Net.session.code = d.code;
  if (!Net.started) renderRoom();
}

function clientRole(d){
  // 只发给本人的候选与身份 —— 广播出去就是泄漏
  Net.started = true;
  Net.mySeat = d.seat;
  G.mode = d.mode || 'A';
  // ！！必须先吃快照！！ 客户端从来没调用过 Engine.initGame，
  // G.players 本来是个空数组；不先 hydrate 的话下面 p 就是 undefined，
  // 整个选角界面会静默失败、游戏开不起来。
  if (d.s) hydrate(d.s);
  const p = G.players[d.seat];
  if (!p) return;
  if (d.identity) p.identity = d.identity;      // 模式 C 时这里是 null，保持快照里的值即可
  p.charChoices = (d.choices || []).map(id => CHAR_BY_ID[id]).filter(Boolean);
  G.humanSeat = d.seat;
  G.dealPer = d.dealPer || p.charChoices.length;
  // 选角界面和单机共用同一套（main.js 里的 showRolePicker）
  window.showRolePicker(d.seat, function(c){
    sendTo('host', { t: 'pick', charId: c.id });
    const after = () => {
      renderLobby('<p class="hint">已选定 ' + esc(c.name) + '，等其他人选角…</p>');
      window.UI.show('net');
    };
    // 模式 C：身份是选完角色才揭晓的（快照里已经带上，直接本地显示）
    if (G.mode === 'C') window.showIdentityReveal(d.seat, after);
    else after();
  });
}

/** 房主发来的身份轮抽请求（模式 B） */
function clientDraft(d){
  Net.started = true;
  Net.mySeat = d.seat;
  G.mode = d.mode || 'B';
  if (d.s) hydrate(d.s);
  window.showDraftPicker(d.seat, function(key){
    sendTo('host', { t: 'idpick', key: key });
    renderLobby('<p class="hint">身份已选定，等其他玩家…</p>');
    window.UI.show('net');
  });
}

function clientGo(d){
  Net.started = true;
  if (typeof d.seat === 'number' && d.seat >= 0) Net.mySeat = d.seat;
  if (d.s) hydrate(d.s);
  if (!Net.rec) Net.startRec(Net.mySeat, (d.s && d.s.players) ? d.s.players.length : 0);
  window.UI.show('game');
  window.UI.render();
  window.UI.maybeShowTutorial();
}

function clientWatch(d){
  Net.spectator = true;
  Net.mySeat = -1;
  Net.started = true;
  if (d.s) hydrate(d.s);
  window.UI.show('game');
  window.UI.render();
}

function clientFrame(d){
  // 顺序很重要：**先**把状态喂进去，**再**播事件 ——
  // 死亡演出要读 player.identity（fx.js:342），事件先到会读到 null 而崩
  if (d.s) hydrate(d.s);
  if (d.ev && d.ev.length) Net.enqueueEvents(d.ev);
  recPush({ s: d.s || null, ev: d.ev || null });     // 顺手录进复盘
}

function hydrate(snap){
  if (typeof snap.rev === 'number' && snap.rev < Net.rev) return;
  Net.rev = snap.rev !== undefined ? snap.rev : Net.rev;

  const players = (snap.players || []).map(hydratePlayer);
  G.players = players;
  G.turnSeat = snap.turnSeat;
  G.round = snap.round;
  G.turnId = snap.turnId;
  G.over = !!snap.over;
  G.speed = snap.speed;
  G.deck = []; G.discard = [];
  G.deckCount = snap.deckCount;
  G.discardCount = snap.discardCount;
  // ！！关键！！ 座位号由客户端自己持有，**永远不从快照里取**。
  // 快照里根本不放 humanSeat；万一以后有人加上了，这里也要覆盖掉 ——
  // 抄了主机的 humanSeat 就会让每个客户端都去渲染房主的手牌和身份。
  G.humanSeat = Net.mySeat;

  // 正在等谁做决定：真人的读秒由快照驱动（AI 的思考状态由 FX 事件驱动，别抢）
  const askingSeat = (snap.asking && typeof snap.asking.seat === 'number') ? snap.asking.seat : -1;
  players.forEach(p => {
    if (!p.isHuman || p.seat === G.humanSeat) return;
    const on = (p.seat === askingSeat);
    window.UI.setThinking(p.seat, on, on ? snap.asking.until : 0);
  });

  Net.indexFromSnapshot(snap);
  hydrateLog(snap);
  window.UI.render();
}

function hydratePlayer(p){
  const o = Object.assign({}, p);
  o.equips = p.equips || { weapon: null, armor: null, mountUp: null, mountDown: null };
  o.judge = p.judge || [];
  o.marks = p.marks || {};
  o.hand = p.hand || [];
  o.char = p.charId ? CHAR_BY_ID[p.charId] : null;
  if (typeof o.name !== 'string' || !o.name){
    o.name = o.char ? o.char.name : ('座位 ' + (p.seat + 1));
  }
  return o;
}

let logBase = -1, logAbsEnd = -1;

function hydrateLog(snap){
  const box = document.getElementById('log');
  if (!box) return;
  const start = snap.logStart || 0;
  if (start !== logBase || logAbsEnd > start + snap.log.length){
    box.innerHTML = '';
    logAbsEnd = start;
    logBase = start;
  }
  for (let i = logAbsEnd - start; i < snap.log.length; i++){
    const e = snap.log[i];
    window.UI.pushLog(e.text, e.cls);
  }
  logAbsEnd = start + snap.log.length;
}

function clientAsk(d){
  // 先把快照吃进去，req 里的玩家/卡牌引用才能换成自己的对象
  if (d.s) hydrate(d.s);
  const req = unpack(d.req, 0);
  if (!req || !req.kind) return;
  // **客户端绝不覆盖 UI.askHuman** —— 它必须保持原生，
  // 因为 equipSkillFlow（ui.js:471）会在本地嵌套调用它两次（电风扇/粉笔），
  // 如果这里也做网络路由，嵌套提问就会被错误地转发回主机。
  window.UI.askHuman(req).then(res => {
    sendTo('host', { t: 'ans', id: d.id, res: pack(res, 0) });
  }, () => {
    sendTo('host', { t: 'ans', id: d.id, res: {} });
  });
}

function clientOver(d){
  if (d.identities && Array.isArray(d.identities)){
    d.identities.forEach((id, i) => { if (G.players[i]) G.players[i].identity = id; });
  }
  const me = G.players[G.humanSeat];
  let win = false;
  if (me){
    if (d.winner === 'dean') win = (me.identity === 'dean' || me.identity === 'staff');
    else if (d.winner === 'student') win = (me.identity === 'student');
    else if (d.winner === 'mole') win = (me.identity === 'mole');
  }
  window.UI.cancelAsk();
  Net.started = false;
  window.UI.showOver(d.winner, d.reason, win);
}

/* ---- 离开 ---- */

Net.leave = function(){
  if (Net.frameTimer){ clearInterval(Net.frameTimer); Net.frameTimer = null; }
  stopAutosave();
  Net.stopLocalRec();
  Net.stopRecording();
  if (Net.session){
    sendTo('host', { t: 'leave' });
    if (Net.session.isHost) sendTo('all', { t: 'hostgone' });
  }
  if (Net.transport){ Net.transport.stop(); Net.transport = null; }
  Net.session = null;
  Net.roster = [];
  Net.mySeat = -1;
  Net.started = false;
  try { sessionStorage.removeItem('dqk_net_last'); } catch (e){ /* 忽略 */ }
  Net.pendingAsk = null;
  Net.setAsking(-1, 0);
  window.UI.setThinking && window.UI.clearThinking();
  window.UI.syncOnlineUI(false);
  window.UI.show('start');
};

/* =========================================================
 *  自检
 * ========================================================= */

Net.selfTest = function(){
  const out = [];
  const ok = (name, cond, detail) => out.push({ name: name, ok: !!cond, detail: detail });

  /* --- 卡牌往返：必须还原成同一个对象（引擎靠同一性校验） --- */
  const deck = D.buildDeck();
  const idx = new Map();
  deck.forEach(c => idx.set(c.uid, c));
  const saveIndex = new Map(uidIndex);
  deck.forEach(c => uidIndex.set(c.uid, c));

  let same = 0, badName = 0;
  for (const c of deck){
    const r = unpack(pack(c, 0), 0);
    if (r === c) same++;
    if (!r || r.name !== c.name || r.suit !== c.suit || r.rank !== c.rank) badName++;
  }
  ok('160 张牌往返后仍是同一个对象', same === deck.length, same + '/' + deck.length);
  ok('往返后名称/花色/点数不变', badName === 0, badName);

  /* --- 关键：回传的牌要能通过引擎的 p.hand.includes() 校验 --- */
  const hand = [deck[0], deck[5], deck[9]];
  const fakeHand = hand.map(c => unpack(pack(c, 0), 0));
  ok('回传的牌能通过 p.hand.includes() 同一性校验',
     fakeHand.every(c => hand.includes(c)), fakeHand.map(c => c && c.name).join(','));

  /* --- 没有 uid 的临时牌（代课/校园卡）必须能内联往返 --- */
  const temp = { name:'代课', suit:null };
  const rt = unpack(pack(temp, 0), 0);
  ok('无 uid 的临时牌能往返', rt && rt.name === '代课' && rt.suit === null, JSON.stringify(rt));

  const virt = { name:'上课点名', kind:'attack', dmg:'fire', type:'basic',
                 suit:'C', rank:8, virtual:true };
  const rt2 = unpack(pack(virt, 0), 0);
  ok('虚拟牌能往返且保留 virtual 标记',
     rt2 && rt2.virtual === true && rt2.dmg === 'fire' && rt2.rank === 8);

  /* --- req.filter 这类函数必须被丢掉（不能序列化） --- */
  const withFn = pack({ kind:'selectCards', min:1, max:1, filter: function(c){ return true; } }, 0);
  ok('req 里的函数字段被丢弃', !('filter' in withFn) && withFn.min === 1);

  /* --- 玩家引用 --- */
  const fakeG = { players: [{ seat: 0, hp: 4, maxHp: 4, identity: 'dean', hand: [], equips:{}, judge:[], marks:{} },
                            { seat: 1, hp: 3, maxHp: 3, identity: 'student', hand: [], equips:{}, judge:[], marks:{} }] };
  const realG = window.G;
  window.G = fakeG;
  const pRef = unpack(pack(fakeG.players[1], 0), 0);
  ok('玩家按 seat 还原成 G.players 里的对象', pRef === fakeG.players[1]);
  window.G = realG;

  /* --- 嵌套结构：playable / targets 混在 req 里 --- */
  const req = { kind:'playPhase', player: fakeG.players[0],
                playable: [{ card: deck[1], count: 2 }, { card: deck[2], count: 1 }],
                skills: [{ name:'吹牛', needTarget:false, desc:'x' }] };
  window.G = fakeG;
  const packed = pack(req, 0);
  ok('req.playable 里的卡牌被引用化',
     packed.playable[0].card.__card === deck[1].uid
     && packed.playable[0].count === 2,
     JSON.stringify(packed.playable[0]).slice(0, 90));
  const un = unpack(packed, 0);
  ok('req 解包后 playable 的牌对回原对象',
     un.playable[0].card === deck[1] && un.playable[1].card === deck[2]);
  ok('req 解包后 player 对回原对象', un.player === fakeG.players[0]);
  ok('req 解包后技能保持纯数据', un.skills[0].name === '吹牛');
  window.G = realG;

  /* --- 占位牌必须等长，且不能被当成真牌 --- */
  const ph = placeholderCard();
  ok('占位牌带 hidden 标记且 uid <= 0', ph.hidden === true && ph.uid <= 0);

  /* --- 投影 --- */
  const snap = Net.project(-1, false);
  if (snap){
    ok('投影里不含 humanSeat 字段', !('humanSeat' in snap));
    ok('投影里不含牌堆内容（只有张数）', !('deck' in snap) && typeof snap.deckCount === 'number');
    const leak = snap.players.some(p => (p.hand || []).some(c => !c.hidden));
    ok('旁观者的投影里没有任何人的真手牌', !leak);
  } else {
    ok('投影可用（需要先开局）', false, '没有正在进行的对局，跳过');
  }

  uidIndex.clear();
  saveIndex.forEach((v, k) => uidIndex.set(k, v));

  const bad = out.filter(o => !o.ok);
  return { total: out.length, bad: bad.length, items: out };
};

})();
