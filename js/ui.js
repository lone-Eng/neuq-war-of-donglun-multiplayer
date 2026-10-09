/* =========================================================
 *  东秦杀：点名册  ·  界面层（渲染 + 人类交互）
 * ========================================================= */
(function(){
'use strict';
const D = window.GameData;
const E = window.Engine;
const CARDS = D.CARDS;
const UI = {};
window.UI = UI;

let playMode = null;      // 当前出牌阶段的可交互信息
let resolvePlay = null;   // playPhase 的 Promise 回调

/* =========================================================
 *  点棋盘选目标
 * =========================================================
 *  targetable / selected 这两个类的样式在 style.css 里一直都有
 *  （第 211-212 行），只是从没被接上线 —— 之前所有目标选择都走弹窗。
 *  这里把它接上：出牌阶段点手牌 → 合法目标直接高亮 → 点人选中。
 *  弹窗保留为「列表选择」兜底（8 人局手机上点小面板不方便时用）。
 */
let targeting = null;     // {cands, chosen, min, max, title, extra, onConfirm, onCancel, cb}

/* 正在等待答复的座位（真人读秒 / AI 思考），两个都走这里 */
const thinkingSeats = new Set();
const thinkingUntil = {};   // seat -> 超时时间戳（没有就不显示读秒）

UI.setThinking = function(seat, on, until){
  if (on){
    thinkingSeats.add(seat);
    if (until) thinkingUntil[seat] = until; else delete thinkingUntil[seat];
  } else {
    thinkingSeats.delete(seat);
    delete thinkingUntil[seat];
  }
  const el = document.querySelector('.player-panel[data-seat="' + seat + '"]');
  if (el) el.classList.toggle('thinking', !!on);
};

UI.clearThinking = function(){
  thinkingSeats.clear();
  Object.keys(thinkingUntil).forEach(k => delete thinkingUntil[k]);
};

/**
 * 进入选目标状态。
 *   opts = {cands:[玩家], min, max, title, extra:[{label,onClick}],
 *           onConfirm(chosen), onCancel()}
 */
function beginTargeting(opts){
  targeting = Object.assign({ min:1, max:1, chosen:[] }, opts);
  if (!targeting.cands || !targeting.cands.length){ targeting = null; return false; }
  // 只有一个合法目标且只要 1 个：直接选中，省一次点击
  if (targeting.cands.length === 1 && targeting.min === 1 && targeting.max === 1)
    targeting.chosen = [targeting.cands[0]];
  UI.render();
  return true;
}

function endTargeting(confirm){
  const t = targeting;
  targeting = null;
  UI.render();
  if (!t) return;
  if (confirm && t.chosen.length >= t.min){ if (t.onConfirm) t.onConfirm(t.chosen.slice()); }
  else if (t.onCancel) t.onCancel();
}
UI.endTargeting = endTargeting;
UI.isTargeting = function(){ return !!targeting; };

/* 出手确认：默认开（身份局点错人代价很大），嫌慢可以在顶栏关掉 */
UI.confirmBeforePlay = (function(){
  try { return localStorage.getItem('dqk_confirm') !== '0'; } catch (e){ return true; }
})();
UI.setConfirmBeforePlay = function(v){
  UI.confirmBeforePlay = !!v;
  try { localStorage.setItem('dqk_confirm', v ? '1' : '0'); } catch (e){ /* 忽略 */ }
  return UI.confirmBeforePlay;
};

function toggleTarget(p){
  if (!targeting) return;
  const single = (targeting.max === 1 && targeting.min === 1);
  const i = targeting.chosen.indexOf(p);
  if (i >= 0){
    targeting.chosen.splice(i, 1);          // 再点一次 = 取消选择
  } else if (targeting.chosen.length >= targeting.max){
    if (single) targeting.chosen = [p];     // 单目标：直接换人
    else return;                            // 多目标已满
  } else {
    targeting.chosen.push(p);
  }
  UI.render();
  if (targeting.chosen.length >= targeting.min && !UI.confirmBeforePlay)
    endTargeting(true);
}

/* ---------------- 屏幕切换 ---------------- */
function show(screen){
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + screen);
  if (el) el.classList.add('active');
}
UI.show = show;

/* ---------------- 日志 / 提示 ---------------- */
UI.pushLog = function(text, cls){
  const box = document.getElementById('log');
  if (!box) return;
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = text;
  box.appendChild(div);
  while (box.children.length > 400) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
};
UI.toast = function(text, cls){
  const layer = document.getElementById('toast-layer');
  if (!layer) return;
  const t = document.createElement('div');
  t.className = 'toast ' + (cls || '');
  t.textContent = text;
  layer.appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0';
    setTimeout(() => t.remove(), 320); }, 2200);
};
UI.setPhase = function(name){
  const el = document.getElementById('phase-label');
  if (el) el.textContent = D.PHASE_NAME[name] || name;
};

/* ---------------- 卡牌 DOM ---------------- */
const CARD_TYPE_LABEL = { basic:'基本', equip:'装备', event:'事件', delayed:'延时' };

function cardEl(card, opts){
  opts = opts || {};
  const div = document.createElement('div');
  const meta = CARDS[card.name] || {};
  const red = D.isRedCard(card);
  let cls = 'card ' + (red ? 'red' : 'black');
  if (meta.type === 'equip') cls += ' equip';
  if (meta.type === 'delayed') cls += ' delayed';
  if (meta.type === 'event') cls += ' event';
  if (opts.dim) cls += ' dim';
  if (opts.sel) cls += ' sel';
  if (opts.big) cls += ' big';
  div.className = cls;
  const suit = D.suitOf(card).sym;
  const rl = D.rankLabel(card.rank);
  // 牌面只留「名字 + 花色点数 + 类型角标」。
  // 原来每张牌都印一行"长按看详情"，82px 宽下既挤又吵，
  // 而完整描述本来就在长按详情里。类型角标是新增的：一眼分出基本/装备/事件。
  const typeLabel = CARD_TYPE_LABEL[meta.type] || '';
  div.innerHTML =
    '<div class="c-band"></div>' +
    '<div class="c-corner">' + rl + '<span class="suit">' + suit + '</span></div>' +
    '<div class="c-corner br">' + rl + '<span class="suit">' + suit + '</span></div>' +
    // 红/黑的第二通道：左边缘纹理（红=斜纹，黑=点阵）。
    // 色觉障碍玩家不用辨色也能一眼分清 —— 判定和"学生证免疫黑色点名"都要用这个信息。
    '<div class="c-rb"></div>' +
    (typeLabel ? '<div class="c-type">' + typeLabel + '</div>' : '') +
    '<div class="c-name">' + card.name + '</div>' +
    '<div class="c-desc">' + (meta.desc || '') + '</div>';
  div.addEventListener('click', () => {
    if (div._lpFired){ div._lpFired = false; return; }
    if (opts.onClick) opts.onClick(card, div);
  });
  // 长按 / 右键 → 查看牌面详情
  if (window.FX) FX.bindLongPress(div, () => FX.showCardDetail(card));
  return div;
}
UI.cardEl = cardEl;

/* ---------------- 布局方式：横向队列 / 围坐一圈 ---------------- */
/* 队列是手机上的默认（可横滑），圆桌在宽屏上更能体现"相邻 = 距离 1" */
let uiLayout = null;
function layoutMode(){
  if (!uiLayout){
    try { uiLayout = localStorage.getItem('dqk_layout') || ''; } catch (e){ uiLayout = ''; }
    if (uiLayout !== 'queue' && uiLayout !== 'ring'){
      uiLayout = ((window.innerWidth || 1200) >= 1100) ? 'ring' : 'queue';
    }
  }
  return uiLayout;
}
UI.getLayout = layoutMode;
// 圆桌是按实测尺寸摆的，窗口一变就得重摆
let _rsTimer = null;
window.addEventListener('resize', () => {
  if (layoutMode() !== 'ring') return;
  clearTimeout(_rsTimer);
  _rsTimer = setTimeout(() => UI.render(), 150);
});
UI.toggleLayout = function(){
  uiLayout = (layoutMode() === 'ring') ? 'queue' : 'ring';
  try { localStorage.setItem('dqk_layout', uiLayout); } catch (e){ /* 忽略 */ }
  const b = document.getElementById('btn-layout');
  if (b) b.textContent = '布局：' + (uiLayout === 'ring' ? '座位圈' : '队列');
  UI.render();
  return uiLayout;
};

/* ---------------- 渲染 ---------------- */
UI.render = function(){
  if (!window.G || !G.players || !G.players.length) return;
  renderTopbar();
  renderOpponents();
  renderHand();
  renderActions();
  renderTargetBar();
  renderSpectator();
  tickThinking();
};

/** 选目标时底部那条操作栏 */
function renderTargetBar(){
  const bar = document.getElementById('target-bar');
  if (!bar) return;
  if (!targeting){
    bar.classList.add('hide');
    bar.innerHTML = '';
    return;
  }
  const t = targeting;
  bar.classList.remove('hide');
  const need = (t.max > t.min) ? (t.min + '–' + t.max) : String(t.min);
  let html = '<span class="tb-title">' + t.title + '</span>' +
    '<span class="tb-count">已选 <b class="' + (t.chosen.length >= t.min ? 'ok' : '') + '">' +
      t.chosen.length + '</b>/' + need + '</span>';
  if (t.chosen.length) html += '<span class="tb-names">→ ' + t.chosen.map(p => p.name).join('、') + '</span>';
  if (t.hint) html += '<span class="tb-hint">' + t.hint + '</span>';
  bar.innerHTML = html;

  const acts = document.createElement('div');
  acts.className = 'tb-actions';
  (t.extra || []).forEach(e => {
    const b = document.createElement('button');
    b.className = 'mini';
    b.textContent = e.label;
    b.addEventListener('click', e.onClick);
    acts.appendChild(b);
  });
  if (t.listFallback){
    const lb = document.createElement('button');
    lb.className = 'mini';
    lb.textContent = '列表选择';
    lb.title = '目标太多、面板太小的时候用';
    lb.addEventListener('click', () => { const f = t.listFallback; endTargeting(false); if (f) f(); });
    acts.appendChild(lb);
  }
  const cancel = document.createElement('button');
  cancel.className = 'mini';
  cancel.textContent = '取消 (Esc)';
  cancel.addEventListener('click', () => endTargeting(false));
  acts.appendChild(cancel);

  const ok = document.createElement('button');
  ok.className = 'primary';
  ok.textContent = UI.confirmBeforePlay ? '出手 (Enter)' : '确定';
  ok.disabled = t.chosen.length < t.min;
  ok.addEventListener('click', () => endTargeting(true));
  acts.appendChild(ok);

  bar.appendChild(acts);
}

/** 旁观席：底部换成一条观战信息，而不是空着 */
function renderSpectator(){
  const bar = document.getElementById('spectator-bar');
  if (!bar) return;
  const me = G.players[G.humanSeat];
  if (me){
    bar.classList.add('hide');
    bar.innerHTML = '';
    return;
  }
  bar.classList.remove('hide');
  const cur = G.players[G.turnSeat];
  const alive = G.players.filter(p => p.alive).length;
  bar.innerHTML = '<span class="sp-badge">观战中</span>' +
    '<span class="sp-item">当前回合：<b>' + (cur ? cur.name : '—') + '</b></span>' +
    '<span class="sp-item">第 <b>' + G.round + '</b> 轮</span>' +
    '<span class="sp-item">存活 <b>' + alive + '</b> / ' + G.players.length + '</span>' +
    '<span class="sp-hint">长按任意牌或角色可查看详情</span>';
}

/** 思考中读秒：不依赖快照，本地每秒刷新一次 */
function tickThinking(){
  const list = document.querySelectorAll('.pp-think');
  if (!list.length) return;
  const now = Date.now();
  list.forEach(el => {
    const until = +el.dataset.until;
    if (!until){ el.textContent = '思考中…'; return; }
    const left = Math.max(0, Math.round((until - now) / 1000));
    el.textContent = '思考中 ' + left + 's';
  });
}
setInterval(() => { if (thinkingSeats.size) tickThinking(); }, 1000);

/* 联机时客户端只拿到牌堆**张数**（牌堆顺序是隐藏信息），所以优先读 xCount */
function countOf(single, plural){
  if (typeof G[plural] === 'number') return G[plural];
  return G[single] ? G[single].length : 0;
}

function renderTopbar(){
  document.getElementById('deck-count').textContent = countOf('deck', 'deckCount');
  document.getElementById('discard-count').textContent = countOf('discard', 'discardCount');
  document.getElementById('round-count').textContent = G.round;
  const banner = document.getElementById('my-id-banner');
  if (!banner) return;
  const me = G.players[G.humanSeat];
  if (!me){
    banner.innerHTML = '<span style="color:#8fa0b5">你正在旁观本局</span>';
    return;
  }
  const id = D.IDENTITIES[me.identity];
  if (id){
    banner.innerHTML = '你的身份：<b class="bid ' + id.cls + '">' + id.name + '</b>' +
      '　<span style="color:#8fa0b5">角色：' + (me.char ? me.char.name : '—') + '</span>' +
      '　<span style="color:#7e8ea3;font-size:12px">目标：' + id.win + '</span>';
  } else if (me.char){
    banner.innerHTML = '角色：' + me.char.name;
  }
}

function identityTag(p, isMe){
  const id = D.IDENTITIES[p.identity];
  if (isMe) return '<span class="pp-id ' + (p.identity === 'dean' ? 'dean' : 'revealed-' + p.identity) + '">' + id.name + '（你）</span>';
  if (p.revealed || p.identity === 'dean') return '<span class="pp-id ' + (p.identity==='dean'?'dean':'revealed-' + p.identity) + '">' + id.name + '</span>';
  return '<span class="pp-id hidden">身份未知</span>';
}

function panelEl(p, isMe){
  const div = document.createElement('div');
  div.className = 'player-panel';
  div.dataset.seat = p.seat;
  if (!p.alive) div.classList.add('dead');
  const isTurn = (window.G.turnSeat === p.seat && p.alive);
  if (isTurn) div.classList.add('turn');
  // 点棋盘选目标：合法的加 targetable，已选的加 selected
  // （这两个类的样式在 style.css 里本来就有，只是之前一直没人用）
  if (targeting){
    if (targeting.cands.indexOf(p) >= 0) div.classList.add('targetable');
    if (targeting.chosen.indexOf(p) >= 0) div.classList.add('selected');
  }
  if (thinkingSeats.has(p.seat)) div.classList.add('thinking');
  const idTag = identityTag(p, isMe);
  let hpPips = '';
  for (let i=1;i<=p.maxHp;i++) hpPips += '<span class="hp-pip' + (i <= p.hp ? ' on' : '') + (p.identity==='mole'&&isMe?' mole-hp':'') + '"></span>';
  // 装备与通知栏用 DOM 元素生成，便于长按查看牌面
  const marks = [];
  if (p.marks.buff) marks.push('<span class="pp-tag warn">红牛 ×' + p.marks.buff + '</span>');
  if (p.chained) marks.push('<span class="pp-tag warn">横置</span>');
  if (p.dodgeBan) marks.push('<span class="pp-tag warn">禁代课</span>');
  if (p.marks.pigeon) marks.push('<span class="pp-tag warn">鸽王</span>');
  if (p.marks.net) marks.push('<span class="pp-tag warn">断网</span>');
  if (p.pointBan) marks.push('<span class="pp-tag warn">禁点名</span>');
  const dmgBonus = p.char && E.hasSkill(p,'体能') ? '<span class="pp-tag">手牌上限+1</span>' : '';

  const known = p.revealed || p.identity === 'dean' || isMe;
  const avatarCls = known ? D.IDENTITIES[p.identity].cls : '';
  // 距离信息（相对人类玩家，直观体现"围圈坐"）
  let distTags = '';
  const me = G.players[G.humanSeat];
  if (me && !isMe && p.alive && me.alive && window.Engine){
    const d = E.distance(me, p), rng = E.attackRange(me);
    const inR = d <= rng;
    distTags = '<span class="pp-tag dist">距你 ' + d + '</span>';
    if (G.players[G.turnSeat] === me)
      distTags += '<span class="pp-tag ' + (inR ? 'good' : 'out') + '">' + (inR ? '可点名' : '范围外') + '</span>';
  }
  // 等待真人决策时的读秒（联机时房主把「正在问谁、什么时候超时」放进快照）
  let thinkTag = '';
  if (thinkingSeats.has(p.seat) && !isMe){
    thinkTag = '<span class="pp-think" data-until="' + (thinkingUntil[p.seat] || 0) + '">思考中…</span>';
  }
  div.innerHTML =
    (isTurn ? '<div class="pp-turn-ribbon">▶ 当前回合</div>' : '') +
    '<div class="pp-head">' +
      '<div class="pp-avatar ' + avatarCls + '">' + (p.char ? p.char.name.charAt(0) : '?') + '</div>' +
      '<div style="flex:1;min-width:0"><div class="pp-name">' + p.name + (isMe ? ' <span style="color:#8fb8e8;font-size:12px">（你）</span>' : '') + '</div>' +
    '<div class="pp-title">' + (p.char ? p.char.title : '') + '</div></div>' +
    '<div style="text-align:right">' + idTag + '<div class="pp-seat">' + (p.seat+1) + ' 号位</div></div></div>' +
    '<div class="pp-hp">' + hpPips + '<span class="hp-num">' + Math.max(0,p.hp) + '/' + p.maxHp + '</span></div>' +
    '<div class="pp-row"><span class="pp-tag">手牌 ' + p.hand.length + '</span>' + marks.join('') + dmgBonus + distTags + '</div>' +
    thinkTag;
  // 装备区
  const gbox = document.createElement('div');
  gbox.className = 'pp-gears';
  D.EQUIP_SLOTS.forEach(k => {
    if (!p.equips[k]) return;
    gbox.appendChild(chipWithDetail(p.equips[k].name, p.equips[k], 'gear-chip'));
  });
  if (gbox.children.length) div.appendChild(gbox);
  // 通知栏：延时类事件牌以小卡形式贴在角色面板上
  if (p.judge.length){
    const wrap = document.createElement('div');
    wrap.className = 'pp-judge-wrap';
    const lab = document.createElement('span');
    lab.className = 'pp-judge-label';
    lab.textContent = '通知栏';
    wrap.appendChild(lab);
    const row = document.createElement('div');
    row.className = 'pp-judge-cards';
    const ordered = p.judge.slice().reverse();      // 后进先出：最左侧最先结算
    ordered.forEach((c, i) => {
      const mc = miniCard(c);
      if (i === 0) mc.classList.add('next');
      mc.title = c.name + (i === 0 ? '（下一个结算）' : '');
      row.appendChild(mc);
    });
    wrap.appendChild(row);
    div.appendChild(wrap);
  }
  // 长按查看角色技能详情
  if (window.FX) FX.bindLongPress(div, () => FX.showCharDetail(p));
  return div;
}

/** 通知栏用的小卡（贴在角色面板上，直观显示身上的延时牌） */
function miniCard(card){
  const el = document.createElement('div');
  const red = D.isRedCard(card);
  el.className = 'mini-card ' + (red ? 'red' : 'black');
  el.innerHTML = '<span class="m-rank">' + D.rankLabel(card.rank) + '</span>' +
                 '<span class="m-suit">' + D.suitOf(card).sym + '</span>' +
                 '<span class="m-name">' + card.name + '</span>';
  el.addEventListener('pointerdown', e => e.stopPropagation());
  if (window.FX) FX.bindLongPress(el, () => FX.showCardDetail(card));
  return el;
}

/** 生成带"长按查看牌面"的小标签 */
function chipWithDetail(text, card, cls){
  const chip = document.createElement('span');
  chip.className = cls;
  chip.textContent = text;
  chip.addEventListener('pointerdown', ev => ev.stopPropagation());   // 避免同时触发面板长按
  if (window.FX && card) FX.bindLongPress(chip, () => FX.showCardDetail(card));
  return chip;
}

function renderOpponents(){
  const box = document.getElementById('opponents');
  if (!box) return;
  // 飘字/震动是挂在角色面板上的，而下面要清空重建整个座位区。
  // 不把正在播放的飘字摘出来再挂回去的话，联机时每次状态同步都会把
  // "受伤 -2"这类飘字瞬间抹掉（单机下也偶发，联机下会被放大成"动画全废"）。
  const floats = [];
  box.querySelectorAll('.fx-float, .chat-bubble').forEach(f => { floats.push([f.dataset.seat, f]); });
  box.innerHTML = '';

  const n = G.players.length;
  const meSeat = G.humanSeat;
  const ring = (layoutMode() === 'ring') && n > 1;
  box.classList.toggle('ring', ring);
  // 出牌区也要知道现在是圆桌，好给中间留白（见 style.css 的 #board-main.ring）
  const bm = document.getElementById('board-main');
  if (bm) bm.classList.toggle('ring', ring);
  box.classList.remove('ring-compact', 'ring-mini');
  if (ring){
    // 人一多面板就会互相压住，用 style.css 里原本就备好的两档尺寸收一下
    if (n >= 7) box.classList.add('ring-mini');
    else if (n >= 6) box.classList.add('ring-compact');
  }

  // 圆桌半径按**实测容器尺寸**算，不用百分比：百分比在 4 人局（左右两个面板正好
  // 顶到边缘）会溢出去压到日志栏，底部那个也会顶穿到出牌区上面。
  // 量容器：优先量父节点。这是有意的 —— ring 模式下 #opponents 是 inset:0 的绝对定位，
  // 尺寸来自父容器；而它自己此刻是**空的**（下面才填面板），量它自己会拿到 0 高度，
  // 摆位就会被守卫跳过（页面隐藏时 UI.render 也会遇到同样情形）。
  let ringW = 0, ringH = 0;
  if (ring){
    const host = box.parentElement || box;
    const hr = host.getBoundingClientRect();
    ringW = hr.width || 0;
    ringH = hr.height || 0;
    if (ringW < 80 || ringH < 80){          // 父容器也没尺寸就退回量自己
      const br = box.getBoundingClientRect();
      ringW = br.width || 0;
      ringH = br.height || 0;
    }
  }

  G.players.forEach(p => {
    const el = panelEl(p, p.seat === meSeat);
    el.classList.add('row-seat');
    if (p.seat === meSeat) el.classList.add('is-me');
    if (ring && ringW > 40 && ringH > 40){
      // 以「我」为基准摆圆：我在正下方，出牌顺序沿顺时针推进。
      // 这样"相邻"就是真的挨着，距离感比横向队列直观得多。
      const idx = (((p.seat - meSeat) % n) + n) % n;
      const ang = Math.PI / 2 + (idx / n) * Math.PI * 2;
      const pw = el.offsetWidth || 238;
      const ph = el.offsetHeight || 170;
      const rx = Math.max(0, (ringW - pw) / 2 - 6);
      // 纵向多留 16px：面板顶上有「当前回合」缎带，不留的话顶部那个会被切掉
      const ry = Math.max(0, (ringH - ph) / 2 - 16);
      el.style.left = (ringW / 2 + rx * Math.cos(ang)).toFixed(0) + 'px';
      el.style.top  = (ringH / 2 + ry * Math.sin(ang)).toFixed(0) + 'px';
      el.style.transform = 'translate(-50%,-50%)';
    } else {
      el.style.left = ''; el.style.top = ''; el.style.transform = '';
    }
    el.addEventListener('click', () => onTargetClick(p, el));
    box.appendChild(el);
  });

  // 把还在播的飘字挂回对应座位
  floats.forEach(([seat, el]) => {
    const panel = box.querySelector('.player-panel[data-seat="' + seat + '"]');
    if (panel) panel.appendChild(el);
  });
}

function renderHand(){
  const box = document.getElementById('my-hand');
  if (!box) return;
  const me = G.players[G.humanSeat];
  const hint0 = document.getElementById('hand-hint');
  if (!me){
    // 旁观席：humanSeat 是 -1，没有手牌可渲染
    box.innerHTML = '';
    if (hint0) hint0.textContent = '你正在旁观本局　·　长按任意牌 / 角色可查看详情';
    return;
  }
  box.innerHTML = '';
  const playableNames = new Set();
  if (playMode){
    playMode.playable.forEach(it => playableNames.add(it.card.name));
  }
  sortedHand(me.hand).forEach(c => {
    const isPlayable = playMode && playableNames.has(c.name);
    const el = cardEl(c, {
      dim: playMode && !isPlayable,
      onClick: (card) => { if (playMode && isPlayable) onHandCardClick(card); }
    });
    if (isPlayable) el.classList.add('playable');
    box.appendChild(el);
  });
  const hint = document.getElementById('hand-hint');
  if (hint){
    // 手牌超过上限时**提前**警告：等到弃牌阶段才说就晚了，
    // 出牌阶段本来可以再打几张牌避免弃牌。
    const limit = E.handLimit(me);
    const over = me.hand.length - limit;
    const warn = (over > 0)
      ? '<span class="hand-warn">手牌 ' + me.hand.length + ' / 上限 ' + limit +
        '　出牌阶段结束时需弃 ' + over + ' 张</span>'
      : '';
    hint.innerHTML = (playMode
      ? '点击高亮手牌使用（无目标牌会直接结算），然后<b>点角色面板</b>选目标　·　长按看详情'
      : '等待其他玩家行动……　·　长按任意牌 / 角色可查看详情') + warn;
  }
}

/* 手牌排序：按「基本牌 → 装备 → 事件 → 延时」分组，同名牌相邻，组内点数大的在前。
   只是显示顺序，绝不动 me.hand 本身（引擎靠数组顺序和对象同一性做事）。 */
const CARD_TYPE_ORDER = { basic:0, equip:1, event:2, delayed:3 };
function cardTypeRank(c){
  const meta = CARDS[c.name];
  const t = meta && meta.type;
  return (CARD_TYPE_ORDER[t] === undefined) ? 9 : CARD_TYPE_ORDER[t];
}
function sortedHand(hand){
  return hand.slice().sort((a, b) => {
    const ta = cardTypeRank(a), tb = cardTypeRank(b);
    if (ta !== tb) return ta - tb;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return (b.rank || 0) - (a.rank || 0);
  });
}

function renderActions(){
  const box = document.getElementById('actions');
  if (!box) return;
  box.innerHTML = '';
  const me = G.players[G.humanSeat];
  const isMyPlay = playMode && G.players[G.turnSeat] === me;
  if (isMyPlay){
    playMode.skills.forEach(s => {
      const tg = s.eqSkill ? [me] : E.skillTargets(me, s);
      const btn = document.createElement('button');
      btn.className = 'skill';
      btn.textContent = '【' + s.name + '】';
      btn.title = s.desc || '';
      btn.disabled = tg.length === 0;
      btn.addEventListener('click', () => onSkillClick(s, tg));
      box.appendChild(btn);
    });
    const end = document.createElement('button');
    end.className = 'primary';
    end.textContent = '结束出牌阶段';
    end.addEventListener('click', () => {
      const fn = resolvePlay; playMode = null; resolvePlay = null; targeting = null; UI.render();
      if (fn) fn({ action:{ type:'end' } });
    });
    box.appendChild(end);
  } else {
    const span = document.createElement('span');
    span.style.color = '#8fa0b5';
    span.style.fontSize = '13px';
    span.textContent = G.over ? '游戏已结束' : (G.players[G.turnSeat] ? '当前回合：' + G.players[G.turnSeat].name : '');
    box.appendChild(span);
  }
}

/* ---------------- 弹窗基础 ---------------- */
function closeModal(){
  const layer = document.getElementById('modal-layer');
  layer.classList.remove('show');
  layer.innerHTML = '';
  layer._esc = null;      // 键盘处理用（见文件末尾的 keydown）
}
UI.closeModal = closeModal;

function modal(opts){
  const layer = document.getElementById('modal-layer');
  layer.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'modal';
  const h = document.createElement('h3');
  h.textContent = opts.title || '';
  box.appendChild(h);
  if (opts.desc){
    const d = document.createElement('div');
    d.className = 'm-desc';
    d.innerHTML = opts.desc;
    box.appendChild(d);
  }
  const body = document.createElement('div');
  body.className = 'm-body';
  if (opts.body) body.appendChild(opts.body);
  box.appendChild(body);
  const acts = document.createElement('div');
  acts.className = 'm-actions';
  (opts.actions || []).forEach(a => {
    const b = document.createElement('button');
    b.textContent = a.label;
    if (a.cls) b.className = a.cls;
    if (a.disabled) b.disabled = true;
    b.dataset.key = a.key || '';
    b.addEventListener('click', a.onClick);
    acts.appendChild(b);
  });
  box.appendChild(acts);
  layer.appendChild(box);
  layer.classList.add('show');
  // 只有能安全取消的弹窗才允许按 Esc 关掉（否则引擎会一直等这个答复）
  layer._esc = opts.esc || null;
  return { box, body, actions: acts, setEnabled: (key, on) => {
    const b = acts.querySelector('button[data-key="' + key + '"]');
    if (b) b.disabled = !on;
  }};
}
UI.modal = modal;

/* ---------------- 人类交互入口 ---------------- */

/* 当前挂起的那个询问（用来在游戏结束时取消它）。
   出牌阶段的 resolvePlay（第 13 行）就是这里的 done，所以取消出牌阶段能一起处理。 */
let pendingResolve = null;

UI.askHuman = function(req){
  return new Promise(resolve => {
    const done = r => {
      if (pendingResolve === done) pendingResolve = null;
      resolve(r);
    };
    pendingResolve = done;
    switch (req.kind){
      case 'playPhase':  return askPlayPhase(req, done);
      case 'choice':     return askChoice(req, done);
      case 'selectCards':return askSelectCards(req, done);
      case 'selectTargets': return askTargets(req, done);
      case 'selectOption': return askOption(req, done);
      default: resolve({});
    }
  });
};

/**
 * 取消当前挂起的询问（联机时主机会在游戏结束等情况下发这个消息）。
 * 出牌阶段用 {action:{type:'end'}} 收尾 —— engine.js:1624 的结束判断能正确处理它；
 * 对其他询问返回空对象，engine 里 req 的接收方都有兜底。
 */
UI.cancelAsk = function(){
  closeModal();
  const wasPlay = !!resolvePlay;
  playMode = null; resolvePlay = null;
  targeting = null;
  if (wasPlay && pendingResolve){ const fn = pendingResolve; pendingResolve = null; fn({ action:{ type:'end' } }); }
  else if (pendingResolve){ const fn = pendingResolve; pendingResolve = null; fn({}); }
  UI.render();
};

/* ---- 出牌阶段 ---- */
function askPlayPhase(req, resolve){
  playMode = req;
  resolvePlay = resolve;
  targeting = null;
  UI.render();
}
function canTargetOther(me, target, card, opts){
  // 划水限制
  if (target.marks && target.marks.slideTurn === G.turnId && target.marks.slideFrom === me.seat) return false;
  if (card && CARDS[card.name].tag === 'probe' && E.hasSkill(target, '潜行')) return false;
  if (card && card.name === '课堂辩论' && E.hasSkill(target, '伦理')) return false;
  return true;
}
function onHandCardClick(card){
  const me = G.players[G.humanSeat];
  const meta = CARDS[card.name];
  const kind = meta.kind;

  // 无目标牌
  if (['draw2','harvest','aoeAttack','massHeal','lightning'].includes(kind)){
    const targets = finishAutoTargets(me, card);
    return finishPlay({ type:'card', card, targets });
  }
  if (kind === 'equip') return finishPlay({ type:'card', card, targets: [] });
  if (kind === 'heal' || kind === 'buff') return finishPlay({ type:'card', card, targets: [me] });

  // 需要目标 —— 点棋盘上的角色面板选人（弹窗降级成「列表选择」）
  const cands = E.validTargets(me, card).filter(t => canTargetOther(me, t, card));
  if (!cands.length){ UI.toast('没有合法目标', 'warn'); return; }
  const isHei = (card.name === '上课点名' && me.equips.weapon && me.equips.weapon.name === '黑板擦' && me.hand.length === 1);
  const maxT = isHei ? 3 : (kind === 'chain' ? 2 : 1);
  const fire = tg => finishPlay({ type:'card', card, targets: tg });
  beginTargeting({
    cands, min:1, max:maxT,
    title: '使用【' + card.name + '】',
    hint: kind === 'chain' ? '可横置 / 重置角色' : '',
    extra: kind === 'chain' ? [{
      label: '重铸（弃置并摸一张）',
      onClick: () => { endTargeting(false); finishPlay({ type:'card', card, targets: [], recast:true }); }
    }] : [],
    onConfirm: fire,
    onCancel: () => {},
    listFallback: () => askTargetList('使用 ' + card.name,
      '请选择目标（1' + (maxT > 1 ? '–' + maxT : '') + ' 名）' +
      (kind === 'chain' ? '　可横置/重置角色' : ''), cands, 1, maxT, fire)
  });
}

/** 弹窗列表选目标：点棋盘不方便时的兜底（手机小屏、8 人局等） */
function askTargetList(title, desc, cands, min, max, onOk, onCancel){
  const me = G.players[G.humanSeat];
  const chosen = [];
  const body = document.createElement('div');
  body.className = 'm-targets';
  const m = modal({
    title: title, desc: desc, body,
    actions: [
      { label:'确定', cls:'primary', key:'ok', onClick: () => {
          if (chosen.length < min) return;
          closeModal(); onOk(chosen.slice());
      }},
      { label:'取消', onClick: () => { closeModal(); if (onCancel) onCancel(); } }
    ],
    esc: () => { closeModal(); if (onCancel) onCancel(); }
  });
  cands.forEach(t => {
    const pill = document.createElement('div');
    pill.className = 'target-pill';
    pill.innerHTML = t.name + ' <span style="color:#8fa0b5;font-size:12px">' + t.hp + '/' + t.maxHp +
      (me ? ' · 距离' + E.distance(me, t) : '') + ' · 手牌' + t.hand.length + '</span>';
    pill.addEventListener('click', () => {
      const i = chosen.indexOf(t);
      if (i >= 0){ chosen.splice(i,1); pill.classList.remove('sel'); }
      else {
        if (chosen.length >= max) return;
        chosen.push(t); pill.classList.add('sel');
      }
      m.setEnabled('ok', chosen.length >= min);
    });
    body.appendChild(pill);
  });
  m.setEnabled('ok', chosen.length >= min);
  return m;
}
function finishAutoTargets(me, card){
  const kind = CARDS[card.name].kind;
  if (kind === 'aoeAttack') return E.others(me);
  if (kind === 'massHeal' || kind === 'harvest') return E.alivePlayers();
  if (kind === 'lightning') return [me];
  if (kind === 'draw2') return [me];
  return [];
}
function finishPlay(action){
  const fn = resolvePlay;
  playMode = null; resolvePlay = null;
  targeting = null;          // 出牌流程结束时一定要退出选目标状态
  UI.render();
  if (fn) fn({ action });
}
function onSkillClick(skill, targets){
  const me = G.players[G.humanSeat];
  if (skill.eqSkill) return equipSkillFlow(skill, me);
  if (!skill.needTarget) return finishPlay({ type:'skill', skill, targets: [] });
  const cands = targets.slice();
  if (!cands.length){ UI.toast('没有合法目标', 'warn'); return; }
  const fire = tg => finishPlay({ type:'skill', skill, targets: tg });
  // 主动技同样走「点棋盘选人」，和出牌保持一致的手感
  beginTargeting({
    cands, min:1, max:1,
    title: '发动【' + skill.name + '】',
    hint: skill.desc || '',
    onConfirm: fire,
    onCancel: () => {},
    listFallback: () => askTargetList('发动【' + skill.name + '】', skill.desc, cands, 1, 1, fire)
  });
}

/* ---- 武器转化技：电风扇 / 粉笔 ---- */
async function equipSkillFlow(skill, me){
  let cost = [], asName = '上课点名', dmg = 'normal', suit = 'C', rank = 8;
  if (skill.name === '电风扇·转化'){
    const r = await UI.askHuman({ kind:'selectCards', player:me, from:'self', min:1, max:1,
      prompt:'【电风扇】选择一张"上课点名"当"公开处刑"使用', filter:c => c.name === '上课点名' });
    if (!r.cards || !r.cards.length) return;
    cost = [r.cards[0]]; asName = '公开处刑'; dmg = 'fire';
    suit = r.cards[0].suit; rank = r.cards[0].rank;
  } else {
    const r = await UI.askHuman({ kind:'selectCards', player:me, from:'self', min:2, max:2,
      prompt:'【粉笔】选择两张手牌当作一张"上课点名"' });
    if (!r.cards || r.cards.length < 2) return;
    cost = r.cards.slice(); asName = '上课点名'; dmg = 'normal';
    suit = cost[0].suit; rank = cost[0].rank;
  }
  const cands = E.validTargets(me, { name: asName, kind:'attack' });
  if (!cands.length){ UI.toast('没有合法目标', 'warn'); return; }
  const t = await UI.askHuman({ kind:'selectTargets', player:me, targets:cands, min:1, max:1,
    prompt:'选择目标（' + asName + '）' });
  if (!t.targets || !t.targets.length) return;
  finishPlay({ type:'virtual', cost, asName, dmg, suit, rank, targets:t.targets });
}

/* ---- 选项 ---- */
function askChoice(req, resolve){
  modal({
    title: req.player ? '「' + req.player.name + '」的决策' : '请选择',
    desc: req.prompt,
    actions: (req.options || []).map(o => ({
      label: o.label, cls: o.key === 'yes' || o.key === 'card' ? 'primary' : '',
      onClick: () => { closeModal(); resolve({ option: o.key }); }
    }))
  });
}
/* ---- 选牌 ---- */
function askSelectCards(req, resolve){
  let pool;
  if (req.cards) pool = req.cards.slice();
  else {
    const me = G.players[G.humanSeat];
    if (!me){ resolve({ cards: [] }); return; }     // 旁观席不该被问到，兜底
    if (req.from === 'any'){
      pool = me.hand.concat(D.EQUIP_SLOTS.map(k => me.equips[k]).filter(Boolean));
    } else pool = me.hand.slice();
  }
  if (req.filter) pool = pool.filter(req.filter);
  if (!pool.length){ resolve({ cards: [] }); return; }
  const min = req.min || 0, max = req.max || 1;
  const chosen = [];
  const body = document.createElement('div');
  body.className = 'm-cards';
  const owner = req.owner ? req.owner.name + ' 的' : '你的';
  const m = modal({
    title: (req.player ? '「' + req.player.name + '」· ' : '') + (req.prompt || '选择卡牌'),
    desc: '选择 ' + min + (max > min ? '–' + max : '') + ' 张' + owner + '牌',
    body,
    actions:[
      { label:'确定', cls:'primary', key:'ok', onClick: () => {
          closeModal(); resolve({ cards: chosen.slice() });
      }},
      { label:'取消', onClick: () => { closeModal(); resolve({ cards: [] }); } }
    ],
    esc: () => { closeModal(); resolve({ cards: [] }); }
  });
  pool.forEach(c => {
    const el = cardEl(c, { onClick: (card, div) => {
      const i = chosen.indexOf(card);
      if (i >= 0){ chosen.splice(i,1); div.classList.remove('sel'); }
      else {
        if (chosen.length >= max) return;
        chosen.push(card); div.classList.add('sel');
      }
      m.setEnabled('ok', chosen.length >= min && chosen.length <= max);
    }});
    body.appendChild(el);
  });
  m.setEnabled('ok', min === 0);
}

/* ---- 选目标 ---- */
function askTargets(req, resolve){
  const min = req.min || 1, max = req.max || 1;
  const cands = (req.targets || []).slice();
  const title = (req.player ? '「' + req.player.name + '」· ' : '') + (req.prompt || '选择目标');
  if (!cands.length){ resolve({ targets: [] }); return; }
  const ok = tg => resolve({ targets: tg });
  const cancel = () => resolve({ targets: [] });
  // 引擎发来的选目标请求也走「点棋盘」——这样出牌、主动技、点名接力
  // 全游戏的目标选择手感一致，不再有的点人、有的在弹窗里找名字。
  beginTargeting({
    cands, min, max, title,
    onConfirm: ok,
    onCancel: cancel,
    listFallback: () => askTargetList(
      title, '请选择目标（' + min + (max > min ? '–' + max : '') + ' 名）',
      cands, min, max, ok, cancel)
  });
}

/* ---- 长列表选项（吹牛） ---- */
function askOption(req, resolve){
  const body = document.createElement('div');
  body.className = 'm-cards';
  modal({
    title: (req.player ? '「' + req.player.name + '」· ' : '') + (req.prompt || '请选择'),
    body,
    actions:[{ label:'取消', onClick: () => { closeModal(); resolve({ option: null }); } }],
    esc: () => { closeModal(); resolve({ option: null }); }
  });
  (req.options || []).forEach(o => {
    const b = document.createElement('button');
    b.textContent = o.label;
    b.style.minWidth = '104px';
    b.addEventListener('click', () => { closeModal(); resolve({ option: o.key }); });
    body.appendChild(b);
  });
}

/* ---------------- 查考勤展示 ---------------- */
UI.showJudge = function(card, jc){
  const layer = document.getElementById('modal-layer');
  if (!layer) return;
  layer.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'modal';
  const red = D.isRedCard(jc);
  box.innerHTML = '<h3>查考勤</h3>' +
    '<div class="m-desc">' + card.name + ' → 抽签牌</div>' +
    '<div style="display:flex;gap:14px;align-items:center;justify-content:center;padding:6px 0">' +
    '<div style="font-size:40px;font-weight:bold;color:' + (red ? '#e05a5a' : '#dfe6f0') + '">' +
    D.rankLabel(jc.rank) + D.suitOf(jc).sym + '</div>' +
    '<div style="font-size:15px;color:#9aa8bb">' + jc.name + '</div></div>';
  layer.appendChild(box);
  layer.classList.add('show');
  const wait = 900 * (G.speed || 1);
  setTimeout(() => { if (layer.contains(box)) closeModal(); }, wait);
};

/* ---------------- 结束界面 ---------------- */
UI.showOver = function(winner, reason, humanWin){
  const title = document.getElementById('over-title');
  const body = document.getElementById('over-body');
  title.textContent = humanWin ? '你赢了' : (winner ? '你输了' : '平局');
  title.style.color = humanWin ? '#5ac47e' : '#e05a5a';
  let html = '<div class="ov-line">' + (winner ? D.IDENTITIES[winner].name + '阵营胜利' : '平局') + '　<span style="color:#8fa0b5">（' + reason + '）</span></div>';
  html += '<div class="ov-line" style="margin-top:14px;color:#8fa0b5">身份揭示</div>';
  G.players.forEach(p => {
    const id = D.IDENTITIES[p.identity];
    const me = p.seat === G.humanSeat;
    const win = (winner === 'dean' && (p.identity === 'dean' || p.identity === 'staff')) ||
                (winner === 'student' && p.identity === 'student') ||
                (winner === 'mole' && p.identity === 'mole');
    html += '<div class="ov-line' + (win ? ' ov-win' : '') + '">' +
      (p.seat+1) + ' 号位　' + p.char.name + '（' + p.char.title + '）　' +
      '<b>' + id.name + '</b>　' + (p.alive ? '存活' : '死亡') + (me ? '　← 你' : '') + (win ? '　✔ 胜利' : '') + '</div>';
  });
  body.innerHTML = html;
  UI.show('over');
};

/* ---------------- 房主掉线提示条 ---------------- */
UI.showHostGone = function(who){
  const bar = document.getElementById('host-gone-bar');
  if (!bar) return;
  const t = bar.querySelector('.hg-text');
  if (t) t.textContent = '房主' + (who ? '「' + who + '」' : '') + '掉线了 —— 这局随时会停摆，你可以接手继续';
  bar.classList.remove('hide');
};
UI.hideHostGone = function(){
  const bar = document.getElementById('host-gone-bar');
  if (bar) bar.classList.add('hide');
};
UI.bindHostGone = function(){
  const t = document.getElementById('hg-take');
  if (t) t.addEventListener('click', () => window.Net.takeover());
  const d = document.getElementById('hg-dismiss');
  if (d) d.addEventListener('click', () => UI.hideHostGone());
};

/* ---------------- 复盘回放条 ---------------- */
UI.showReplayBar = function(on){
  const bar = document.getElementById('replay-bar');
  if (!bar) return;
  bar.classList.toggle('hide', !on);
  if (on) UI.updateReplayBar();
};

UI.updateReplayBar = function(){
  const bar = document.getElementById('replay-bar');
  if (!bar || bar.classList.contains('hide')) return;
  const R = window.Net && Net.replay;
  if (!R || !R.data) return;
  const total = R.data.frames.length;
  const pos = Math.min(R.idx, total);
  const fill = document.getElementById('rb-fill');
  if (fill) fill.style.width = (total ? (pos / total * 100) : 0).toFixed(1) + '%';
  const tgl = document.getElementById('rb-toggle');
  if (tgl) tgl.textContent = R.playing ? '⏸ 暂停' : (pos >= total ? '↻ 重播' : '▶ 播放');
  const posEl = document.getElementById('rb-pos');
  if (posEl) posEl.textContent = pos + ' / ' + total + ' 帧';
  [1, 2, 4].forEach(v => {
    const b = document.getElementById('rb-s' + v);
    if (b) b.classList.toggle('on', Math.abs(R.speed - v) < 0.01);
  });
};

UI.bindReplayBar = function(){
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  on('rb-toggle', () => window.Net.toggleReplay());
  on('rb-s1', () => window.Net.setReplaySpeed(1));
  on('rb-s2', () => window.Net.setReplaySpeed(2));
  on('rb-s4', () => window.Net.setReplaySpeed(4));
  on('rb-exit', () => window.Net.stopReplay());
};

/* ---------------- 弃牌堆查看 ---------------- */
/* 弃牌堆是公开信息（每次弃牌都写进了日志），只是以前顶栏只显示一个数字。
   能翻弃牌堆，老手才能数牌 —— 这是牌类游戏最基本的深度来源之一。 */
UI.showDiscard = function(){
  if (window.Net && Net.requestDiscard){ Net.requestDiscard(); return; }   // 联机：向房主要
  renderDiscard((window.G && G.discard) || []);
};

function renderDiscard(cards){
  const body = document.createElement('div');
  body.className = 'discard-box';
  if (!cards.length){
    body.innerHTML = '<p class="hint">弃牌堆还是空的。</p>';
  } else {
    const map = new Map();
    cards.forEach(c => {
      const e = map.get(c.name) || { name: c.name, list: [] };
      e.list.push(c);
      map.set(c.name, e);
    });
    const rows = Array.from(map.values()).sort((a, b) => b.list.length - a.list.length);
    rows.forEach(r => {
      const el = document.createElement('div');
      el.className = 'discard-row';
      const meta = CARDS[r.name] || {};
      el.innerHTML = '<span class="dr-name">' + r.name + '</span>' +
        '<span class="dr-type">' + (CARD_TYPE_LABEL[meta.type] || '') + '</span>' +
        '<span class="dr-n">×' + r.list.length + '</span>' +
        '<span class="dr-cards">' + r.list.map(c =>
          D.rankLabel(c.rank) + D.suitOf(c).sym).join(' ') + '</span>';
      if (window.FX) FX.bindLongPress(el, () => FX.showCardDetail(r.list[0]));
      body.appendChild(el);
    });
  }
  modal({
    title: '弃牌堆（共 ' + cards.length + ' 张）',
    desc: '所有弃掉的牌都是公开信息 —— 数牌能帮你判断还剩多少张点名、多少张代课。',
    body,
    actions: [{ label:'关闭', cls:'primary', onClick: closeModal }],
    esc: closeModal
  });
}
UI.renderDiscard = renderDiscard;

/* ---------------- 新手引导 ---------------- */
const TUTORIAL = [
  { t: '看手牌', d: '屏幕底部是你的手牌。<b>出牌阶段</b>里能用的牌会描一圈金边，点它就使用。<br><br>长按任意一张牌（手机上按住不放，电脑上右键也行）能看到完整说明。' },
  { t: '选目标', d: '需要指定目标的牌，合法目标会在棋盘上<b>描绿边</b>，直接点那个人的面板就行。<br><br>选完底部会出现一条「出手」操作条；点错人可以再点一次取消，或按 Esc。' },
  { t: '看状态', d: '每个角色面板上有体力、手牌数、装备、通知栏和<b>距你几格</b>。<br><br>长按角色面板能看他的技能全文。轮到谁，谁的面板就有金色呼吸光。' },
  { t: '别慌', d: '拿不准的时候，顶栏的「规则」按钮里有速查表。<br><br>单机模式随时可以重开，先随便打两局熟悉一下。' }
];

UI.showTutorial = function(step){
  step = step || 0;
  if (step >= TUTORIAL.length){
    try { localStorage.setItem('dqk_tutorial', '1'); } catch (e){ /* 忽略 */ }
    return;
  }
  const cur = TUTORIAL[step];
  const body = document.createElement('div');
  body.className = 'tut-box';
  body.innerHTML = '<div class="tut-step">第 ' + (step + 1) + ' / ' + TUTORIAL.length + ' 步</div>' +
    '<div class="tut-title">' + cur.t + '</div>' +
    '<div class="tut-text">' + cur.d + '</div>';
  modal({
    title: '', body,
    actions: [
      { label: '跳过', onClick: () => { closeModal(); try { localStorage.setItem('dqk_tutorial','1'); } catch(e){} } },
      { label: step === TUTORIAL.length - 1 ? '开始游戏' : '下一步', cls:'primary', key:'ok',
        onClick: () => { closeModal(); UI.showTutorial(step + 1); } }
    ],
    esc: () => { closeModal(); try { localStorage.setItem('dqk_tutorial','1'); } catch(e){} }
  });
};

/** 第一次玩的人进游戏时自动弹一次引导 */
UI.maybeShowTutorial = function(){
  let done = null;
  try { done = localStorage.getItem('dqk_tutorial'); } catch (e){ done = '1'; }
  if (done) return false;
  UI.showTutorial(0);
  return true;
};

/* ---------------- 快捷语 ---------------- */
/* 联机时人和人之间原本**没有任何交流手段** —— 等人、催人、吐槽全靠线下喊。
   走已有的消息通道，成本极低。单机时按钮直接藏起来。 */
const CHAT_PRESETS = [
  '稍等，我想想', '快点出牌啦', '我先打你一下，别介意', '我是清白的',
  '你肯定是卧底', '谢谢！', '手下留情', '合作愉快？'
];

/* 快捷语历史。**不进战斗日志** —— 以前一句话塞进日志区，
   四五个人聊两句就把"谁打了谁"这种关键信息顶没了。
   气泡负责即时提醒，历史留在快捷语面板里自己翻。 */
UI.chatHistory = [];

UI.pushChat = function(name, text, seat){
  UI.chatHistory.push({ name: name, text: text, seat: seat, at: Date.now() });
  if (UI.chatHistory.length > 60) UI.chatHistory.shift();
  UI.showChatBubble(seat, text);
};

/** 在某个角色的面板上冒一个气泡（4 秒后自己消失） */
UI.showChatBubble = function(seat, text){
  const panel = document.querySelector('.player-panel[data-seat="' + seat + '"]');
  if (!panel) return;
  const b = document.createElement('div');
  b.className = 'chat-bubble';
  b.dataset.seat = seat;         // renderOpponents 重建座位区时靠它挂回来
  b.textContent = text;
  panel.appendChild(b);
  setTimeout(() => b.remove(), 4000);
};

UI.sendChat = function(text){
  text = String(text || '').trim().slice(0, 30);
  if (!text) return;
  if (window.Net && Net.sendChat) Net.sendChat(text);
  else UI.pushLog(text, 'chat');
};

UI.showChat = function(){
  const body = document.createElement('div');
  body.className = 'chat-box';

  // 历史（聊天不进战斗日志，所以这里得能看到刚才谁说了什么）
  const hist = document.createElement('div');
  hist.className = 'chat-hist';
  if (UI.chatHistory.length){
    hist.innerHTML = UI.chatHistory.slice(-12).map(m =>
      '<div class="ch-line"><b>' + esc(m.name) + '</b>：' + esc(m.text) + '</div>').join('');
    setTimeout(() => { hist.scrollTop = hist.scrollHeight; }, 30);
  } else {
    hist.innerHTML = '<div class="ch-empty">还没有人说话</div>';
  }
  body.appendChild(hist);

  const grid = document.createElement('div');
  grid.className = 'chat-presets';
  CHAT_PRESETS.forEach(t => {
    const b = document.createElement('button');
    b.textContent = t;
    b.addEventListener('click', () => { closeModal(); UI.sendChat(t); });
    grid.appendChild(b);
  });
  body.appendChild(grid);

  const row = document.createElement('div');
  row.className = 'chat-free';
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.maxLength = 30;
  inp.placeholder = '说点什么（最多 30 字）';
  const send = document.createElement('button');
  send.className = 'primary';
  send.textContent = '发送';
  const doSend = () => { const v = inp.value; if (!v.trim()) return; closeModal(); UI.sendChat(v); };
  send.addEventListener('click', doSend);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); doSend(); } });
  row.appendChild(inp);
  row.appendChild(send);
  body.appendChild(row);

  modal({ title:'快捷语', desc:'全场可见，请友善使用', body,
          actions:[{ label:'关闭', onClick: closeModal }], esc: closeModal });
  setTimeout(() => { try { inp.focus(); } catch (e){ /* 忽略 */ } }, 60);
};

/* ---------------- 顶部按钮 ---------------- */
UI.bindTopbar = function(){
  const ab = document.getElementById('btn-advance');
  if (ab && window.FX){
    ab.textContent = FX.manualAdvance ? '⏸ 点击清空' : '▶ 自动清空';
    ab.addEventListener('click', () => {
      const m = FX.setAdvance(!FX.manualAdvance);
      ab.textContent = m ? '⏸ 点击清空' : '▶ 自动清空';
      UI.toast(m ? '出牌区：一次连锁结束后等你点击再清空' : '出牌区：一次连锁结束后自动清空', '');
    });
  }
  const sb = document.getElementById('btn-sound');
  if (sb && window.FX){
    sb.textContent = FX.soundOn() ? '🔊 音效' : '🔇 静音';
    sb.addEventListener('click', () => {
      const on = FX.toggleSound();
      sb.textContent = on ? '🔊 音效' : '🔇 静音';
    });
  }
  document.getElementById('btn-log-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('hide');
  });
  document.getElementById('btn-clear-log').addEventListener('click', () => {
    document.getElementById('log').innerHTML = '';
  });
  const sp = document.getElementById('btn-speed');
  const speedLabel = v => v >= 1.9 ? '很慢' : v >= 1.2 ? '标准' : v >= 0.5 ? '快' : '极速';
  sp.textContent = '节奏：' + speedLabel(G.speed);
  sp.addEventListener('click', () => {
    const modes = [{k:1.35,l:'标准'},{k:1.9,l:'很慢'},{k:0.6,l:'快'},{k:0.15,l:'极速'}];
    const i = modes.findIndex(m => Math.abs(m.k - G.speed) < 0.01);
    const next = modes[(i+1) % modes.length];
    if (window.Net && Net.isOnline && Net.isOnline()){
      // 联机时节奏是**全桌共享**的：由房主改，再由快照下发到每一端，
      // 否则各端动画时长会不一致，看起来像卡顿
      Net.setSpeed(next.k);
    } else {
      G.speed = next.k;
    }
    sp.textContent = '节奏：' + next.l;
    UI.toast('节奏：' + next.l + '（数值 ' + next.k + '×）', '');
  });
  document.getElementById('btn-rule-panel').addEventListener('click', showRules);

  const td = document.getElementById('tb-discard');
  if (td) td.addEventListener('click', () => UI.showDiscard());

  // 座位排列：宽屏默认围成圈（更能看出"相邻 = 距离 1"），手机上默认横滑队列
  const bl = document.getElementById('btn-layout');
  if (bl){
    bl.textContent = '布局：' + (layoutMode() === 'ring' ? '座位圈' : '队列');
    bl.addEventListener('click', () => UI.toggleLayout());
  }

  // 快捷语按钮只在联机时出现
  const bc = document.getElementById('btn-chat');
  if (bc){
    bc.addEventListener('click', () => UI.showChat());
    bc.style.display = 'none';
  }

  applyMobileDefaults();
};

/**
 * 手机（≤900px）上默认做的事。
 *
 * 这段以前**只存在于 build-mobile.ps1 注入的补丁里**，也就是说只有单文件版有；
 * 而"手机直接打开服务器地址"走的是 index.html + mobile.css，没有这段 ——
 * 于是日志抽屉默认展开，在手机上一开就是半个屏幕被日志占掉。
 * 现在搬进主代码，两条路都有了（打包补丁再跑一次也是幂等的）。
 */
function applyMobileDefaults(){
  if (!window.matchMedia) return;
  if (!window.matchMedia('(max-width: 900px)').matches) return;
  const sb = document.getElementById('sidebar');
  if (sb) sb.classList.add('hide');
}

/** 联机状态变化时调用：决定哪些按钮该露出来 */
UI.syncOnlineUI = function(online){
  const bc = document.getElementById('btn-chat');
  if (bc) bc.style.display = online ? '' : 'none';
};

function showRules(){
  modal({
    title:'规则速查',
    desc:
      '<b>回合六步：</b>回合开始 → 查考勤 → 摸 2 张 → 出牌 → 弃到体力上限 → 结束<br>' +
      '<b>出牌限制：</b>点名类（上课点名/公开处刑/雷同警告）合计 1 张/回合；延时事件牌 1 张/回合；主动技各 1 次<br>' +
      '<b>距离：</b>相邻为 1；+1 坐骑让别人看你 +1；-1 坐骑让你看别人 -1；最小为 1<br>' +
      '<b>攻击范围：</b>无武器 = 1；由武器牌上的数字决定<br>' +
      '<b>响应链：</b>点名牌 → 代课（抵消）→ 辅导员签字（抵消事件牌）<br>' +
      '<b>判定：</b>翻开牌堆顶作为抽签牌；♥♦ = 红色，♠♣ = 黑色<br>' +
      '<b>濒死：</b>体力 ≤ 0 → 本人先自救 → 从当前回合角色起轮流救援 → 救不回则死亡<br>' +
      '<b>死亡奖惩：</b>杀学生者摸 3 张；院长杀教务 → 院长弃光所有牌<br>' +
      '<b>胜负：</b>学生与卧底全灭且院长存活 = 院方胜；院长死亡 = 学生胜（若仅剩卧底一人则卧底胜）<br>' +
      '<b>手牌上限 = 当前体力</b>（波比【体能】+1）<br>' +
      '<b>操作：</b>点手牌 → 合法目标会在棋盘上描绿边 → 点人选中 → 出手；' +
      'Enter 确认 / Esc 取消 / 数字键按座位号选目标',
    actions:[
      { label: '出手前确认：' + (UI.confirmBeforePlay ? '开' : '关'),
        cls: UI.confirmBeforePlay ? 'on' : '',
        onClick: () => { UI.setConfirmBeforePlay(!UI.confirmBeforePlay); closeModal(); showRules(); } },
      { label:'新手引导', onClick: () => { closeModal(); UI.showTutorial(0); } },
      { label:'运行自检', onClick: () => { closeModal(); if (window.runSelfTest) window.runSelfTest(); } },
      { label:'知道了', cls:'primary', onClick: closeModal }
    ],
    esc: closeModal
  });
}

/* 点角色面板：选目标时用来选人；平时点开角色详情 */
function onTargetClick(p, el){
  if (targeting){
    if (targeting.cands.indexOf(p) >= 0) toggleTarget(p);
    else UI.toast('不是这次能选的目标', 'warn');
    return;
  }
  if (window.FX && FX.showCharDetail) FX.showCharDetail(p);
}

/* ---------------- 键盘操作 ---------------- */
/* 桌面端：Enter 确认 / Esc 取消 / 数字键按座位号选目标。
   出牌区的「点击继续」和详情浮层各有自己的按键处理（见 fx.js），
   这里只在「正在选目标」或「有弹窗」时接管，避免互相打架。

   注意 Esc 只能关**有取消路径**的弹窗：像「是否打出代课」这种必须表态的询问，
   关掉它会让引擎永远等下去。所以能不能 Esc 由 modal({esc}) 显式声明。 */
document.addEventListener('keydown', e => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  if (targeting){
    if (e.key === 'Escape'){ e.preventDefault(); endTargeting(false); return; }
    if (e.key === 'Enter'){
      e.preventDefault();
      if (targeting.chosen.length >= targeting.min) endTargeting(true);
      return;
    }
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= 9){
      const p = G.players.find(x => (x.seat + 1) === n);
      if (p && targeting.cands.indexOf(p) >= 0){ e.preventDefault(); toggleTarget(p); }
    }
    return;
  }

  const layer = document.getElementById('modal-layer');
  if (!layer || !layer.classList.contains('show')) return;
  if (e.key === 'Escape'){
    if (typeof layer._esc === 'function'){ e.preventDefault(); layer._esc(); }
    return;
  }
  if (e.key === 'Enter'){
    const ok = layer.querySelector('button[data-key="ok"]');
    if (ok && !ok.disabled){ e.preventDefault(); ok.click(); }
  }
});

UI.showRules = showRules;

/* 横向座位队列由 CSS flex 自动换行，不需要 JS 摆位 */
})();
