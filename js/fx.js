/* =========================================================
 *  东秦杀：点名册  ·  音效 + 特效 + 长按详情
 *  音效全部用 Web Audio 实时合成，无需任何外部音频文件
 * ========================================================= */
(function(){
'use strict';
const D = window.GameData;
const CARDS = D.CARDS;
const FX = {};
window.FX = FX;

/* =========================================================
 *  一、音效
 * ========================================================= */
const Sfx = { on: true, ctx: null, master: null, vol: 0.34 };
try {
  const saved = localStorage.getItem('dqk_sound');
  if (saved === '0') Sfx.on = false;
} catch (e) { /* file:// 下 localStorage 可能不可用 */ }

function ac(){
  if (!Sfx.ctx){
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    Sfx.ctx = new C();
    Sfx.master = Sfx.ctx.createGain();
    Sfx.master.gain.value = Sfx.vol;
    Sfx.master.connect(Sfx.ctx.destination);
  }
  if (Sfx.ctx.state === 'suspended') { try { Sfx.ctx.resume(); } catch (e) {} }
  return Sfx.ctx;
}
function osc(o){
  if (!Sfx.on) return;
  const c = ac(); if (!c) return;
  const t0 = c.currentTime + (o.delay || 0);
  const os = c.createOscillator(), g = c.createGain();
  os.type = o.type || 'sine';
  os.frequency.setValueAtTime(o.freq, t0);
  if (o.slideTo) os.frequency.exponentialRampToValueAtTime(Math.max(20, o.slideTo), t0 + o.dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(o.vol || 0.18, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
  os.connect(g); g.connect(Sfx.master);
  os.start(t0); os.stop(t0 + o.dur + 0.05);
}
function noise(dur, vol, delay, f1, f2){
  if (!Sfx.on) return;
  const c = ac(); if (!c) return;
  const t0 = c.currentTime + (delay || 0);
  const len = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i=0;i<len;i++) data[i] = (Math.random()*2-1) * (1 - i/len);
  const src = c.createBufferSource(); src.buffer = buf;
  const flt = c.createBiquadFilter(); flt.type = 'bandpass';
  flt.frequency.setValueAtTime(f1 || 900, t0);
  if (f2) flt.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
  flt.Q.value = 1.1;
  const g = c.createGain();
  g.gain.setValueAtTime(vol || 0.16, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(flt); flt.connect(g); g.connect(Sfx.master);
  src.start(t0); src.stop(t0 + dur + 0.02);
}

const SOUNDS = {
  ui:      () => osc({ freq: 760, dur: 0.05, type:'square', vol:0.07 }),
  hover:   () => osc({ freq: 1200, dur: 0.03, type:'sine', vol:0.04 }),
  play:    () => { noise(0.13, 0.16, 0, 1600, 700); osc({ freq: 540, dur: 0.1, type:'triangle', vol:0.12, slideTo: 320 }); },
  attack:  () => { osc({ freq: 320, dur: 0.2, type:'sawtooth', vol:0.16, slideTo: 110 }); noise(0.1, 0.12, 0, 2400, 600); },
  damage:  () => { osc({ freq: 140, dur: 0.3, type:'square', vol:0.2, slideTo: 55 }); noise(0.14, 0.2, 0, 420, 120); },
  bigHurt: () => { osc({ freq: 200, dur: 0.5, type:'sawtooth', vol:0.22, slideTo: 45 }); noise(0.3, 0.24, 0, 700, 90); },
  heal:    () => { osc({ freq: 660, dur: 0.14, type:'sine', vol:0.16 }); osc({ freq: 990, dur: 0.22, type:'sine', vol:0.13, delay:0.09 }); },
  dodge:   () => { noise(0.18, 0.18, 0, 700, 3000); osc({ freq: 900, dur: 0.1, type:'sine', vol:0.08, slideTo: 1500 }); },
  judge:   () => { noise(0.1, 0.14, 0, 2600, 1200); osc({ freq: 1320, dur: 0.14, type:'sine', vol:0.12, delay:0.05 }); },
  draw:    () => noise(0.06, 0.1, 0, 1800, 2600),
  equip:   () => { osc({ freq: 1500, dur: 0.09, type:'triangle', vol:0.12 }); osc({ freq: 2100, dur: 0.14, type:'sine', vol:0.09, delay:0.05 }); },
  skill:   () => { osc({ freq: 420, dur: 0.12, type:'triangle', vol:0.15 }); osc({ freq: 700, dur: 0.16, type:'sine', vol:0.12, delay:0.08 }); },
  turn:    () => { osc({ freq: 700, dur: 0.32, type:'sine', vol:0.13 }); osc({ freq: 1050, dur: 0.36, type:'sine', vol:0.08, delay:0.02 }); },
  death:   () => { osc({ freq: 120, dur: 0.9, type:'sawtooth', vol:0.22, slideTo: 38 }); osc({ freq: 84, dur: 1.1, type:'sine', vol:0.18, delay:0.06 }); },
  danger:  () => { osc({ freq: 520, dur: 0.16, type:'square', vol:0.16 }); osc({ freq: 390, dur: 0.22, type:'square', vol:0.14, delay:0.16 }); },
  win:     () => [523,659,784,1047].forEach((f,i) => osc({ freq:f, dur:0.34, type:'triangle', vol:0.15, delay:i*0.11 })),
  lose:    () => [392,330,262,196].forEach((f,i) => osc({ freq:f, dur:0.42, type:'sine', vol:0.15, delay:i*0.13 }))
};
FX.sfx = function(name){ const f = SOUNDS[name]; if (f && Sfx.on) { try { f(); } catch (e) {} } };
FX.toggleSound = function(){
  Sfx.on = !Sfx.on;
  try { localStorage.setItem('dqk_sound', Sfx.on ? '1' : '0'); } catch (e) {}
  if (Sfx.on) FX.sfx('ui');
  return Sfx.on;
};
FX.soundOn = () => Sfx.on;

/* 首次交互时解锁音频上下文 */
['pointerdown','keydown'].forEach(ev =>
  window.addEventListener(ev, function once(){ try { ac(); } catch (e) {} }, { once:true }));

/* =========================================================
 *  二、视觉特效
 * ========================================================= */
function speed(){ return (window.G && G.speed) || 1; }
function sleep(ms){ return new Promise(r => setTimeout(r, Math.max(0, ms * speed()))); }
function panelOf(seat){ return document.querySelector('.player-panel[data-seat="' + seat + '"]'); }
FX.sleep = sleep;

/* 出牌区清空方式：false = 整条连锁结算完自动清空；true = 等你点击后再清空 */
FX.manualAdvance = false;
FX.setAdvance = function(manual){ FX.manualAdvance = !!manual; return FX.manualAdvance; };

/** 等待玩家确认（点击屏幕任意处 / 空格 / 回车 / Esc） */
function advance(el, autoMs){
  return new Promise(resolve => {
    if (!FX.manualAdvance){ setTimeout(resolve, autoMs * speed()); return; }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener('click', finish);
      window.removeEventListener('keydown', onKey);
      resolve();
    };
    const onKey = e => {
      if (e.key === ' ' || e.key === 'Enter' || e.key === 'Escape'){ e.preventDefault(); finish(); }
    };
    el.addEventListener('click', finish);
    window.addEventListener('keydown', onKey);
  });
}
FX.advance = advance;

/** 飘字（伤害/回复/状态） */
FX.floatText = function(seat, text, cls){
  const p = panelOf(seat); if (!p) return;
  const el = document.createElement('div');
  el.className = 'fx-float ' + (cls || '');
  el.dataset.seat = seat;      // 座位区重建时（ui.js renderOpponents）靠它挂回原位
  el.textContent = text;
  p.appendChild(el);
  setTimeout(() => el.remove(), 1200);
};
/** 面板震动 */
FX.shake = function(seat, hard){
  const p = panelOf(seat); if (!p) return;
  p.classList.remove('fx-shake', 'fx-shake-hard');
  void p.offsetWidth;
  p.classList.add(hard ? 'fx-shake-hard' : 'fx-shake');
  setTimeout(() => p.classList.remove('fx-shake', 'fx-shake-hard'), 600);
};
/** 全屏闪光 */
FX.flash = function(cls){
  const el = document.createElement('div');
  el.className = 'fx-flash ' + (cls || '');
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 520 * speed() + 120);
};

/* =========================================================
 *  出牌区（屏幕中央）：一次结算连锁中的牌全部留在这里，
 *  直到"这张牌 + 它的所有后续响应牌"结算完毕才清空
 * ========================================================= */
FX.beginExchange = function(){
  const area = document.getElementById('play-stack');
  if (!area) return;
  area.innerHTML = '';
  area.classList.add('active');
};

FX.addToExchange = function(casterName, card, targetsText, opts){
  opts = opts || {};
  const area = document.getElementById('play-stack');
  if (!area) return;
  const meta = CARDS[card.name] || {};
  const det = (D.CARD_DETAIL && D.CARD_DETAIL[card.name]) || {};
  const hasSuit = !!card.suit;
  const red = hasSuit && D.isRedCard(card);
  const tgt = (targetsText || '').replace(/^→\s*/, '');

  const row = document.createElement('div');
  row.className = 'exch-card' + (opts.response ? ' resp' : '');
  const thumb = document.createElement('div');
  thumb.className = 'exch-thumb ' + (hasSuit ? (red ? 'red' : 'black') : 'gray');
  thumb.innerHTML =
    (hasSuit ? '<span class="t-rank">' + D.rankLabel(card.rank) + '</span>' +
               '<span class="t-suit">' + D.suitOf(card).sym + '</span>' : '') +
    '<span class="t-name">' + card.name + '</span>';

  const body = document.createElement('div');
  body.className = 'exch-body';
  body.innerHTML =
    '<div class="exch-head"><b>' + casterName + '</b> 使用 <span class="exch-name">' + card.name + '</span>' +
      (hasSuit ? '<span class="exch-suit ' + (red ? 'red' : 'black') + '">' +
        D.rankLabel(card.rank) + D.suitOf(card).sym + '</span>' : '') +
      (opts.tag ? '<span class="exch-tag">' + opts.tag + '</span>' : '') +
    '</div>' +
    (opts.response ? '' : '<div class="exch-line">' + (det.effect || meta.desc || '') + '</div>') +
    (!opts.response && tgt ? '<div class="exch-line tgt">作用对象：' + tgt + '</div>' : '');
  row.appendChild(thumb);
  row.appendChild(body);
  area.appendChild(row);
  area.scrollTop = area.scrollHeight;
  FX.sfx(opts.sfx || 'play');
};

/** 出牌：把这张牌放进中央出牌区（不阻塞），并留出阅读时间 */
FX.cardPlay = async function(casterName, card, targetsText, opts){
  opts = opts || {};
  FX.addToExchange(casterName, card, targetsText, opts);
  await sleep(opts.hold || 620);
};

/** 等待任意点击 / 空格 / 回车 / Esc */
function advanceAnywhere(){
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener('click', finish, true);
      window.removeEventListener('keydown', onKey, true);
      resolve();
    };
    const onKey = e => {
      if (e.key === ' ' || e.key === 'Enter' || e.key === 'Escape'){ e.preventDefault(); finish(); }
    };
    // 稍作延迟，避免被"触发本次行动的那一次点击"立刻吃掉
    setTimeout(() => {
      if (done) return;
      window.addEventListener('click', finish, true);
      window.addEventListener('keydown', onKey, true);
    }, 200);
  });
}

/** 一次结算连锁全部结束：清空出牌区，准备下一张牌 */
FX.endExchange = async function(){
  const area = document.getElementById('play-stack');
  if (!area) return;
  if (FX.manualAdvance){
    const hint = document.createElement('div');
    hint.className = 'fx-advance-hint exch-hint';
    hint.textContent = '点击继续（清空出牌区）▸';
    area.appendChild(hint);
    area.scrollTop = area.scrollHeight;
    await advanceAnywhere();
    hint.remove();
  } else {
    await sleep(820);
  }
  area.classList.remove('active');
  area.innerHTML = '';
};

/** 响应牌提示条（代课 / 辅导员签字等"打出"类响应，不遮挡桌面） */
FX.cardFlash = function(casterName, card, note){
  const lay = document.getElementById('fx-layer') || document.body;
  const el = document.createElement('div');
  el.className = 'fx-chip';
  const hasSuit = !!card.suit;
  const red = hasSuit && D.isRedCard(card);
  el.innerHTML = '<b>' + casterName + '</b> 打出' +
    '<span class="fx-chip-card ' + (red ? 'red' : 'black') + '">' +
      (hasSuit ? D.rankLabel(card.rank) + D.suitOf(card).sym + '　' : '') + card.name + '</span>' +
    (note ? '<span class="fx-chip-note">' + note + '</span>' : '');
  lay.appendChild(el);
  FX.sfx('dodge');
  const hold = 950 * speed();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 280); }, hold);
};

/** 电脑玩家"思考中"提示，让玩家知道游戏在等它、而不是卡住了 */
/* 说明：思考中状态除了加 class，还会记进 ui.js 的 thinkingSeats 集合，
   这样座位区被重建（每次状态同步都会）之后它还在。 */
FX.thinking = function(player, on){
  if (!player) return;
  const el = panelOf(player.seat);
  if (!el) return;
  // 记进 ui.js 的状态集合，这样座位区重建之后这个状态还在
  if (window.UI && UI.setThinking) UI.setThinking(player.seat, !!on);
  if (on) el.classList.add('thinking');
  else el.classList.remove('thinking');
};

/** 技能横幅 */
FX.skillBanner = function(name, skillName){
  const p = panelOf(name && window.G ? (G.players.find(x => x.name === name) || {}).seat : -1);
  const el = document.createElement('div');
  el.className = 'fx-skill';
  el.textContent = '【' + skillName + '】';
  if (p) p.appendChild(el); else document.body.appendChild(el);
  FX.sfx('skill');
  setTimeout(() => el.remove(), 1400);
};

/** 回合开始横幅 */
FX.turnBanner = async function(player){
  if (!player) return;
  const el = document.createElement('div');
  el.className = 'fx-turn';
  const me = window.G && player.seat === G.humanSeat;
  el.innerHTML = '<span class="fx-turn-name">' + player.name + '</span> 的回合' +
    (me ? '<span class="fx-turn-you">轮到你行动</span>' : '');
  document.body.appendChild(el);
  FX.sfx('turn');
  await sleep(720);
  el.classList.add('out');
  setTimeout(() => el.remove(), 320);
};

/** 判定展示（查考勤） */
FX.judge = async function(card, jc){
  const lay = document.getElementById('fx-layer') || document.body;
  const el = document.createElement('div');
  el.className = 'fx-overlay fx-judge';
  const red = D.isRedCard(jc);
  el.innerHTML =
    '<div class="fx-judge-box">' +
      '<div class="fx-judge-title">查 考 勤</div>' +
      '<div class="fx-judge-src">' + card.name + '</div>' +
      '<div class="fx-judge-card ' + (red ? 'red' : 'black') + '">' +
        '<span class="r">' + D.rankLabel(jc.rank) + '</span><span class="s">' + D.suitOf(jc).sym + '</span>' +
      '</div>' +
      '<div class="fx-judge-name">' + jc.name + '</div>' +
      // 把"红/黑"写成字：判定的成败判断完全建立在这一个信息上，
      // 不能让色觉障碍玩家去猜颜色（花色字形也在上面，这里是第三重冗余）
      '<div class="fx-judge-color ' + (red ? 'red' : 'black') + '">' + (red ? '红' : '黑') + '</div>' +
    '</div>';
  lay.appendChild(el);
  FX.sfx('judge');
  if (FX.manualAdvance){
    el.classList.add('blocking');
    const hint = document.createElement('div');
    hint.className = 'fx-advance-hint';
    hint.textContent = '点击继续 ▸';
    const box = el.querySelector('.fx-judge-box');
    if (box) box.appendChild(hint);
  }
  await advance(el, 900);
  el.classList.add('out');
  setTimeout(() => el.remove(), 260);
};

/** 阵亡展示 */
FX.death = async function(player){
  FX.sfx('death');
  FX.flash('dark');
  const lay = document.getElementById('fx-layer') || document.body;
  const el = document.createElement('div');
  el.className = 'fx-overlay fx-death';
  const id = D.IDENTITIES[player.identity];
  el.innerHTML = '<div class="fx-death-box"><div class="fx-death-mark">☠</div>' +
    '<div class="fx-death-name">' + player.name + ' 阵亡</div>' +
    '<div class="fx-death-id ' + id.cls + '">身份揭示：' + id.name + '</div></div>';
  lay.appendChild(el);
  await sleep(1100);
  el.classList.add('out');
  await sleep(250);
  el.remove();
};

/** 游戏结束 */
FX.gameEnd = function(humanWin){ FX.sfx(humanWin ? 'win' : 'lose'); };

/* =========================================================
 *  三、长按查看详情
 * ========================================================= */
FX.bindLongPress = function(el, fn){
  let timer = null;
  const start = () => {
    el._lpFired = false;
    clearTimeout(timer);
    timer = setTimeout(() => { el._lpFired = true; FX.sfx('ui'); fn(); }, 420);
  };
  const cancel = () => clearTimeout(timer);
  el.addEventListener('pointerdown', start);
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('contextmenu', e => { e.preventDefault(); el._lpFired = true; fn(); });
};
FX.lpFired = el => !!el._lpFired;

function typeLabel(card){
  const m = CARDS[card.name] || {};
  if (m.type === 'basic') return '基本牌';
  if (m.type === 'delayed') return '事件牌 · 延时类';
  if (m.type === 'event') return '事件牌 · 非延时类';
  if (m.type === 'equip'){
    if (m.slot === 'weapon') return '装备牌 · 武器（攻击距离 ' + m.range + '）';
    if (m.slot === 'armor') return '装备牌 · 防具';
    return '装备牌 · 坐骑' + (m.mount ? '（' + m.mount + '）' : '');
  }
  return '牌';
}

/** 独立信息浮层（不占用弹窗层，避免与"请选择卡牌"等弹窗冲突） */
function infoOverlay(buildContent, title){
  const layer = document.getElementById('fx-layer') || document.body;
  const wrap = document.createElement('div');
  wrap.className = 'fx-info';
  const box = document.createElement('div');
  box.className = 'modal';
  const h = document.createElement('h3');
  h.textContent = title;
  box.appendChild(h);
  const body = document.createElement('div');
  body.className = 'm-body';
  buildContent(body);
  box.appendChild(body);
  const acts = document.createElement('div');
  acts.className = 'm-actions';
  const btn = document.createElement('button');
  btn.className = 'primary';
  btn.textContent = '关闭';
  btn.addEventListener('click', () => wrap.remove());
  acts.appendChild(btn);
  box.appendChild(acts);
  wrap.appendChild(box);
  wrap.addEventListener('click', e => { if (e.target === wrap) wrap.remove(); });
  const esc = e => { if (e.key === 'Escape'){ wrap.remove(); window.removeEventListener('keydown', esc); } };
  window.addEventListener('keydown', esc);
  layer.appendChild(wrap);
  FX.sfx('ui');
  return wrap;
}

/** 卡牌详情浮层 */
FX.showCardDetail = function(card){
  if (!card || !window.UI) return;
  const det = D.CARD_DETAIL[card.name] || {};
  const m = CARDS[card.name] || {};
  const red = D.isRedCard(card);
  const suit = D.suitOf(card);
  const body = document.createElement('div');
  body.innerHTML =
    '<div class="dt-head">' +
      '<div class="dt-card"></div>' +
      '<div class="dt-meta">' +
        '<div class="dt-line"><b>' + card.name + '</b>' +
          '<span class="dt-suit ' + (red ? 'red' : 'black') + '">' + D.rankLabel(card.rank) + suit.sym + '</span></div>' +
        '<div class="dt-line sub">' + typeLabel(card) + '</div>' +
      '</div>' +
    '</div>';
  const box = body.querySelector('.dt-card');
  if (UI.cardEl) box.appendChild(UI.cardEl(card, { big: true }));
  const rows = [
    ['目标', det.target || '—'],
    ['距离', det.dist || '—'],
    ['效果', det.effect || m.desc || '—'],
    ['限制', det.limit || '—'],
    ['结算顺序', det.order || '—']
  ];
  const table = document.createElement('div');
  rows.forEach(r => {
    const div = document.createElement('div');
    div.className = 'dt-row';
    div.innerHTML = '<span class="dt-k">' + r[0] + '</span><span class="dt-v">' + r[1] + '</span>';
    table.appendChild(div);
  });
  infoOverlay(b => { b.appendChild(body); b.appendChild(table); }, '牌面详情');
};

/** 角色详情弹窗（长按玩家面板） */
FX.showCharDetail = function(p){
  if (!p || !p.char) return;
  const c = p.char;
  const known = p.revealed || p.identity === 'dean' || (window.G && p.seat === G.humanSeat);
  const id = D.IDENTITIES[p.identity];
  const body = document.createElement('div');
  let html = '<div class="dt-head">' +
    '<div class="dt-avatar ' + (known ? id.cls : 'unknown') + '">' + (c ? c.name.charAt(0) : '?') + '</div>' +
    '<div class="dt-meta">' +
      '<div class="dt-line"><b>' + (c ? c.name : '未知') + '</b>' +
        '<span class="dt-suit ' + (known ? id.cls : '') + '">' + (known ? id.name : '身份未知') + '</span></div>' +
      '<div class="dt-line sub">' + (c ? c.title : '') + '</div>' +
      '<div class="dt-line sub">体力 ' + Math.max(0, p.hp) + ' / ' + p.maxHp +
        '　手牌 ' + p.hand.length + '　手牌上限 ' + (window.Engine ? Engine.handLimit(p) : p.hp) + '</div>' +
    '</div></div>';
  if (c){
    html += '<div class="dt-sec">技能</div>';
    c.skills.forEach(s => {
      html += '<div class="dt-skill"><div class="dt-skill-name">【' + s.name + '】<span class="dt-type">' + s.type + '</span></div>' +
        '<div class="dt-skill-text">' + s.text + '</div></div>';
    });
  }
  const gears = D.EQUIP_SLOTS.map(k => p.equips[k]).filter(Boolean);
  html += '<div class="dt-sec">当前状态</div>';
  html += '<div class="dt-row"><span class="dt-k">装备</span><span class="dt-v">' +
    (gears.length ? gears.map(g => g.name).join('、') : '无') + '</span></div>';
  html += '<div class="dt-row"><span class="dt-k">通知栏</span><span class="dt-v">' +
    (p.judge.length ? p.judge.map(j => j.name).join('、') : '无') + '</span></div>';
  const marks = [];
  if (p.chained) marks.push('横置');
  if (p.marks.buff) marks.push('红牛 ×' + p.marks.buff);
  if (p.dodgeBan) marks.push('本回合不能使用代课');
  if (p.pointBan) marks.push('本回合不能使用上课点名');
  if (p.marks.pigeon) marks.push('下个摸牌阶段被跳过');
  if (p.marks.net) marks.push('宿舍断网 ×' + p.marks.net);
  html += '<div class="dt-row"><span class="dt-k">状态</span><span class="dt-v">' + (marks.length ? marks.join('、') : '正常') + '</span></div>';
  if (window.Engine && p.alive){
    html += '<div class="dt-row"><span class="dt-k">距离</span><span class="dt-v">你与他：' +
      Engine.distance(G.players[G.humanSeat], p) + '　他的攻击范围：' + Engine.attackRange(p) + '</span></div>';
  }
  body.innerHTML = html;
  infoOverlay(b => { b.innerHTML = html; }, '角色详情');
};

/* 提示：长按手牌/角色可看详情 */
FX.hint = function(){ if (window.UI) UI.toast('长按卡牌看牌面详情 · 长按角色看技能', ''); };
})();
