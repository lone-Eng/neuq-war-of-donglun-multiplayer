/* =========================================================
 *  东秦杀：点名册  ·  启动与流程编排
 * ========================================================= */
(function(){
'use strict';
const D = window.GameData;
const E = window.Engine;

const cfg = { format:'identity', count:5, mode:'A', deal:3, protect:true, ai:true, fast:false, packs:{} };

/* ---------------- 角色拓展包开关 ----------------
 * 默认全关。关着时 D.roster() 返回的就是基础名单，和以前逐字一致。
 * 选择记在本机，下次打开还是上次那套 —— 和 dqk_layout / dqk_sound 一个套路。 */
const PACK_KEY = 'dqk_packs';
function loadPacks(){
  try {
    const o = JSON.parse(localStorage.getItem(PACK_KEY) || '{}');
    return (o && typeof o === 'object') ? o : {};
  } catch (e){ return {}; }
}
function savePacks(p){
  try { localStorage.setItem(PACK_KEY, JSON.stringify(p || {})); } catch (e){ /* 忽略 */ }
}

cfg.packs = loadPacks();

/* ---------------- 设置栏 ----------------
 * 音频、开局选项、角色拓展包 —— 这些不是每局都要动的东西，
 * 摆在开始界面反而把"选玩法"这件事埋住了。每项即时生效并存本机（dqk_* 惯例）。 */
function setting(key, def){
  try { const v = localStorage.getItem(key); return v === null ? def : v; } catch (e){ return def; }
}
function saveSetting(key, v){ try { localStorage.setItem(key, v); } catch (e) {} }

// 从本机读回来的开局选项（默认沿用原来的初值）
cfg.ai      = setting('dqk_ai_others', cfg.ai ? '1' : '0') === '1';
cfg.fast    = setting('dqk_fast', '0') === '1';
cfg.protect = setting('dqk_protect', cfg.protect ? '1' : '0') === '1';

const AI_LEVEL_KEY = 'dqk_ai_level';
const AI_LEVEL_LABEL = { easy:'简单', normal:'普通', hard:'困难' };

function showSettings(){
  const body = document.createElement('div');
  body.className = 'settings-body';

  const sec = t => { const d = document.createElement('div'); d.className = 'set-sec'; d.textContent = t; return d; };
  const row = (label, nodes) => {
    const d = document.createElement('div');
    d.className = 'set-row';
    const l = document.createElement('span');
    l.className = 'set-label';
    l.textContent = label;
    d.appendChild(l);
    (Array.isArray(nodes) ? nodes : [nodes]).forEach(n => d.appendChild(n));
    return d;
  };
  /** 开关按钮：自己维护 on 状态，回调收到目标值 */
  const toggle = (on, onChange) => {
    const b = document.createElement('button');
    b.className = 'toggle' + (on ? ' on' : '');
    b.textContent = on ? '开' : '关';
    b.addEventListener('click', () => {
      const v = !b.classList.contains('on');
      b.classList.toggle('on', v);
      b.textContent = v ? '开' : '关';
      onChange(v);
    });
    return b;
  };
  /** 一组单选按钮 */
  const group = (opts, cur, onPick) => {
    const g = document.createElement('div');
    g.className = 'btn-group';
    opts.forEach(o => {
      const b = document.createElement('button');
      b.className = (o.k === cur ? 'on' : '');
      b.textContent = o.label;
      b.disabled = !!o.disabled;
      b.addEventListener('click', () => {
        g.querySelectorAll('button').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        onPick(o.k);
      });
      g.appendChild(b);
    });
    return g;
  };
  const note = t => { const s = document.createElement('span'); s.className = 'set-note'; s.textContent = t; return s; };

  /* ---- 音频 ---- */
  const FXo = window.FX || {};
  body.appendChild(sec('音频'));

  body.appendChild(row('音效', toggle(!!FXo.soundOn && FXo.soundOn(), v => {
    if (!!FXo.soundOn() !== v) FXo.toggleSound();
  })));

  const bgm = FXo.bgm || { on:false, vol:0.35, ready:false };
  const bgmNote = note(bgm.ready ? '' : '（没找到 audio/bgm/ 下的曲子，见 README）');
  const bgmVol = document.createElement('input');
  bgmVol.type = 'range'; bgmVol.min = '0'; bgmVol.max = '100'; bgmVol.step = '5';
  bgmVol.value = String(Math.round(bgm.vol * 100));
  bgmVol.addEventListener('input', () => { if (FXo.bgm) FXo.bgm.setVol(+bgmVol.value / 100); });
  body.appendChild(row('背景音乐', [
    toggle(!!bgm.on, v => {
      if (!FXo.bgm) return;
      FXo.bgm.setOn(v);
      bgmNote.textContent = (v && !FXo.bgm.ready) ? '（没找到 audio/bgm/ 下的曲子，见 README）' : '';
    }),
    bgmVol, bgmNote
  ]));

  const voice = FXo.voice || {
    on:false, pack:'sys-female', speak(){}, setOn(){}, setPack(){}, list:() => [],
    packList:() => [{ k:'sys-female', label:'系统女声' }, { k:'sys-male', label:'系统男声' }],
    packsReady:() => true
  };
  const tryBtn = document.createElement('button');
  tryBtn.className = 'mini';
  tryBtn.textContent = '试听';
  tryBtn.addEventListener('click', () => { if (FXo.voice) FXo.voice.speak('上课点名', 'card'); });

  // 音色选项 = 系统两个 + 每个音色包一项（14 项会自己换行 —— .btn-group 是 flex-wrap）
  const vlist = voice.packList();
  const packN = Math.max(0, vlist.length - 2);
  const sysN = voice.list().length;
  const voiceNote = note(packN
    ? '音色包 ' + packN + ' 种（开源 TTS 离线生成，逐个试听）' +
      (sysN ? '　另有系统语音 ' + sysN + ' 个' : '')
    : (sysN ? '系统里找到 ' + sysN + ' 个中文语音；想要更多音色就双击 make-voice.bat'
            : '系统里没找到中文语音包，也没有音色包 —— 双击 make-voice.bat 生成（见 README）'));
  body.appendChild(row('语音报牌', [
    toggle(!!voice.on, v => { if (FXo.voice) FXo.voice.setOn(v); }),
    tryBtn, voiceNote
  ]));

  const vgroup = group(vlist, voice.pack, k => { if (FXo.voice) FXo.voice.setPack(k); });
  vgroup.id = 'set-voice';                                   // 测试和冒烟靠它找选择器
  vgroup.querySelectorAll('button').forEach((b, i) => { b.dataset.voice = vlist[i].k; });
  body.appendChild(row('音色', vgroup));

  // 清单还没读完（网慢 / 刚从隧道地址打开）：读完自动重画一次弹窗，
  // 免得选择器里永远只有系统那两个。modal() 会先清空 layer，重画是替换不是叠加。
  if (FXo.voice && FXo.voice.loadPacks && !FXo.voice.packsReady()){
    FXo.voice.loadPacks().then(ok => {
      const g = document.getElementById('set-voice');
      if (ok && g && g.querySelectorAll('button').length < 3) showSettings();
    });
  }

  /* ---- 开局选项 ---- */
  body.appendChild(sec('开局选项'));
  body.appendChild(row('电脑强度', group(
    [{ k:'easy', label:'简单' }, { k:'normal', label:'普通' }, { k:'hard', label:'困难' }],
    setting(AI_LEVEL_KEY, 'normal'),
    k => { saveSetting(AI_LEVEL_KEY, k); window.Net && Net.setAiLevel(k); }
  )));
  body.appendChild(row('快速动画', toggle(cfg.fast, v => { cfg.fast = v; saveSetting('dqk_fast', v ? '1' : '0'); })));
  body.appendChild(row('保护轮', toggle(cfg.protect, v => { cfg.protect = v; saveSetting('dqk_protect', v ? '1' : '0'); })));
  body.appendChild(row('AI 接管其他玩家', toggle(cfg.ai, v => {
    cfg.ai = v; saveSetting('dqk_ai_others', v ? '1' : '0');
  })));

  /* ---- 角色拓展包 ---- */
  body.appendChild(sec('角色拓展包'));
  const packHint = note('');
  const renderHint = () => {
    const on = D.PACK_META.filter(m => cfg.packs[m.key]);
    const extra = D.roster(cfg.packs).length - D.CHARACTERS.length;
    packHint.textContent = !on.length
      ? '全关。关着时名单和以前完全一样。'
      : (extra ? '已启用：' + on.map(m => m.name).join('、') +
                 '　本局可选武将 ' + D.CHARACTERS.length + ' + ' + extra + ' 名'
               : '已启用：' + on.map(m => m.name).join('、') + '（还没有角色）');
  };
  D.PACK_META.forEach(m => {
    const t = toggle(!!cfg.packs[m.key], v => {
      cfg.packs[m.key] = v;
      savePacks(cfg.packs);
      renderHint();
    });
    t.dataset.pack = m.key;            // 测试靠它找到拓展包开关
    body.appendChild(row(m.name, t));
  });
  renderHint();
  body.appendChild(row('', packHint));

  /* ---- 回到主菜单 ---- */
  // 「设置」在牌局里也能开（顶栏有入口），所以这里是**从牌局退出去的唯一出口**。
  // 光切屏是不够的：引擎还在后台跑，AI 会继续出牌、继续响 —— 得先把本局停掉。
  const back = document.createElement('button');
  back.className = 'big';
  back.id = 'set-back';
  back.textContent = '回到主菜单';
  back.addEventListener('click', () => {
    window.UI.closeModal();
    if (window.Tutorial && Tutorial.active) Tutorial.stop();
    if (window.Net && Net.replayMode && Net.stopReplay){ Net.stopReplay(); return; }
    if (window.Net && Net.isOnline && Net.isOnline()){ Net.leave(); return; }   // leave 自己会切屏
    // 直接置 over：gameLoop 的 while 条件会立刻退出，Ask 也会直接返回空。
    // 不走 endGame() —— 那会弹结算界面，而我们是"中途退出"，不该有战绩。
    if (window.G) G.over = true;
    window.UI.show('start');
  });
  body.appendChild(sec('其他'));
  body.appendChild(row('', back));

  window.UI.modal({ title: '设置', body, actions: [
    { label:'知道了', cls:'primary', key:'ok', onClick: () => window.UI.closeModal() }
  ]});
}

/* ---------------- 图鉴（角色 / 卡牌） ----------------
 * 两张只读列表页。数据全部来自 data.js —— 加了新角色、新牌，这里自动就有，
 * 不需要再维护第二份清单（那种清单迟早会过期，`tools/build-guide.ps1` 那份
 * 教程单文件就是这么来的：它也是从 data.js 现场生成的）。 */
function codexSec(title, extra){
  const d = document.createElement('div');
  d.className = 'codex-sec';
  d.textContent = title + (extra ? '　' + extra : '');
  return d;
}

/** 图鉴的小类标题（比大类低一级） */
function codexSub(title, extra){
  const d = document.createElement('div');
  d.className = 'codex-sub';
  d.textContent = title + (extra ? '　' + extra : '');
  return d;
}

function showCharCodex(){
  const box = document.getElementById('chars-body');
  if (!box) return;
  box.innerHTML = '';
  const groups = [{ key:null, name:'基础角色', list: D.CHARACTERS }]
    .concat(D.PACK_META.map(m => ({ key:m.key, name:m.name, list: D.PACKS[m.key] })));
  groups.forEach(g => {
    if (!g.list || !g.list.length) return;
    // 没启用的包也列出来，但标明"本局未启用" —— 否则玩家会奇怪为什么选角时看不到
    const off = g.key && !cfg.packs[g.key];
    box.appendChild(codexSec(g.name, g.list.length + ' 名' +
      (off ? '　·　本局未启用（去「设置」里开）' : '')));
    const grid = document.createElement('div');
    grid.className = 'codex-grid';
    g.list.forEach(c => {
      const el = document.createElement('div');
      el.className = 'codex-card' + (off ? ' off' : '');
      el.innerHTML =
        '<div class="cc-head"><b>' + c.name + '</b>' +
          '<span class="cc-hp">体力上限 ' + c.hp + '</span></div>' +
        '<div class="cc-title">' + c.title + '</div>' +
        c.skills.map(s => '<div class="cc-skill"><em>' + s.type + '</em>' +
          '<b>【' + s.name + '】</b>' + D.md(s.text) + '</div>').join('');
      grid.appendChild(el);
    });
    box.appendChild(grid);
  });
  window.UI.show('chars');
}

function specCount(spec){
  let n = 0;
  Object.keys(spec.cards || {}).forEach(k => { n += (spec.cards[k] || []).length; });
  return n;
}

/* ---------------- 卡牌图鉴的小类 ----------------
 * 大类看牌面 type（基本 / 事件 / 延时事件 / 装备），小类：
 *   · 基本牌、事件牌 → 看 kind
 *   · 装备牌         → 看 slot（用 D.SLOT_NAME，和牌面上那个角标同一份名字）
 * 都是 data.js 里现成的字段，所以新加一张牌只要填对 kind/slot 就自己落进对应的小类。
 * 排在表里没登记过的 kind 也不会从图鉴里消失 —— 会掉进最后的「其他」。
 * 延时事件牌只有 3 种，不再拆小类（拆出来就是三个各 1 张的标题，纯噪音）。
 */
const CARD_SUB = {
  basic: [
    { title:'点名（攻击）', keys:['attack'] },
    { title:'代课（闪避）', keys:['dodge'] },
    { title:'回血',         keys:['heal'] },
    { title:'增益',         keys:['buff'] }
  ],
  event: [
    { title:'伤害',       keys:['aoeAttack', 'duel', 'fireTalk'] },
    { title:'拆牌抢夺',   keys:['dismantle', 'snatch', 'relay'] },
    { title:'摸牌回复',   keys:['draw2', 'harvest', 'massHeal'] },
    { title:'连环与抵消', keys:['chain', 'nullify'] }
  ]
};

/** 小类分组表：装备牌按装备栏，其余按 CARD_SUB；没有小类的类型返回 null */
function cardSubGroups(type){
  if (type === 'equip') return D.EQUIP_SLOTS.map(sl => ({ title: D.SLOT_NAME[sl] || sl, keys: [sl] }));
  return CARD_SUB[type] || null;
}

/** 一张牌的图鉴条目：张数 + 逐张花色点数 + 简述 + 完整裁定 */
function cardCodexCard(spec){
  const meta = D.CARDS[spec.name] || {};
  const det = D.CARD_DETAIL[spec.name] || {};
  // 逐个花色列出**每一张**的点数（重复的照列）—— 打牌时要数牌，这张表就是给数牌用的
  const suits = Object.keys(spec.cards || {}).map(suit => {
    const sym = (D.SUITS[suit] && D.SUITS[suit].sym) || suit;
    const ranks = (spec.cards[suit] || []).map(r => D.rankLabel(r)).join(' ');
    return '<div>' + sym + '　' + ranks + '</div>';
  }).join('');
  const el = document.createElement('div');
  el.className = 'codex-card wide';
  el.innerHTML =
    '<div class="cc-head"><b>' + spec.name + '</b>' +
      '<span class="cc-hp">' + specCount(spec) + ' 张' +
      (meta.slot && D.SLOT_NAME ? '　·　' + D.SLOT_NAME[meta.slot] : '') + '</span></div>' +
    '<div class="cc-suits">' + suits + '</div>' +
    '<div class="cc-skill">' + (meta.desc || '') + '</div>' +
    (det.effect ? '<div class="cc-detail"><b>效果：</b>' + D.md(det.effect) + '</div>' : '') +
    (det.limit  ? '<div class="cc-detail"><b>限制：</b>' + D.md(det.limit) + '</div>' : '') +
    (det.order  ? '<div class="cc-detail"><b>结算顺序：</b>' + D.md(det.order) + '</div>' : '');
  return el;
}

function cardGrid(specs){
  const grid = document.createElement('div');
  grid.className = 'codex-grid';
  specs.forEach(spec => grid.appendChild(cardCodexCard(spec)));
  return grid;
}

function showCardCodex(){
  const box = document.getElementById('cards-body');
  if (!box) return;
  box.innerHTML = '';
  [['basic', '基本牌'], ['event', '事件牌'], ['delayed', '延时事件牌'], ['equip', '装备牌']]
    .forEach(pair => {
      const type = pair[0], label = pair[1];
      const specs = D.DECK_SPEC.filter(s => D.CARDS[s.name] && D.CARDS[s.name].type === type);
      if (!specs.length) return;
      const total = specs.reduce((n, s) => n + specCount(s), 0);
      box.appendChild(codexSec(label, specs.length + ' 种 · ' + total + ' 张'));

      const subs = cardSubGroups(type);
      if (!subs) { box.appendChild(cardGrid(specs)); return; }

      const done = {};
      subs.forEach(sub => {
        const mine = specs.filter(s => {
          const meta = D.CARDS[s.name] || {};
          const key = (type === 'equip') ? (meta.slot || '') : (meta.kind || '');
          // sub.keys 可能漏写（配置表写错字段名就是这种）——别让一个坏条目把整页打成白屏，
          // 那种情况下这一组空掉，牌会落进下面的「其他」，图鉴还是看得见
          return (sub.keys || []).indexOf(key) >= 0;
        });
        if (!mine.length) return;
        mine.forEach(s => { done[s.name] = 1; });
        box.appendChild(codexSub(sub.title,
          mine.length + ' 种 · ' + mine.reduce((n, s) => n + specCount(s), 0) + ' 张'));
        box.appendChild(cardGrid(mine));
      });

      // 没在小类表里登记过的 kind（以后加了新牌型就是这样）：单独兜住，别让它静默消失
      const rest = specs.filter(s => !done[s.name]);
      if (rest.length){
        box.appendChild(codexSub('其他',
          rest.length + ' 种 · ' + rest.reduce((n, s) => n + specCount(s), 0) + ' 张'));
        box.appendChild(cardGrid(rest));
      }
    });
  window.UI.show('cards');
}

/* ---------------- 玩法选择 ----------------
 * 按钮从 E.formats() 现场生成 —— 以后在 engine.js 的 FORMAT 表里加一个玩法，
 * 界面自动就多一个按钮，不用回来改这里。 */
const FORMAT_HINT = {
  identity: '随机身份、互相猜忌的经典玩法。4–8 人都能开，一局 30–40 分钟。',
  team2v2:  '两队各 2 人，队友明置（1、4 号位一队）。没有身份要猜，直接开打 —— 目标 5 分钟一局。',
  landlord: '1 个地主对 2 个农民。叫分定地主，地主多 1 点体力上限，另有【飞扬】【跋扈】两个专属技能。'
};
function bindFormats(){
  const box = document.getElementById('pick-format');
  if (!box) return;
  const list = E.formats();
  if (!list.some(f => f.key === cfg.format)) cfg.format = 'identity';
  box.innerHTML = '';
  list.forEach(f => {
    const b = document.createElement('button');
    b.className = (cfg.format === f.key ? 'on' : '');
    b.dataset.format = f.key;
    b.textContent = f.label;
    b.addEventListener('click', () => {
      cfg.format = f.key;
      // 固定人数的玩法直接定死；切回自由人数的玩法时，如果当前人数不在这排按钮里
      // （典型：斗地主是 3 人，身份局最少 4 人），就回到默认的 5 ——
      // 否则会以 3 人开一局身份局，而开始界面上一个按钮都不亮
      if (f.seats) cfg.count = f.seats;
      else if (freeCounts().indexOf(cfg.count) < 0) cfg.count = 5;
      box.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      syncCountLock();
      renderPreview();
      renderFormatHint();
    });
    box.appendChild(b);
  });
  syncCountLock();
  renderFormatHint();
}
/** 自由人数的玩法可选的人数（直接从开始界面那排按钮上取，免得再写一份清单） */
function freeCounts(){
  const grp = document.getElementById('pick-count');
  if (!grp) return [4, 5, 6, 7, 8];
  return Array.prototype.map.call(grp.querySelectorAll('button'), b => +b.dataset.count);
}

/**
 * 固定人数的玩法（2V2 = 4 人、斗地主 = 3 人）没有人数和身份模式可挑：
 * 整行收起来，别让人以为能改（切玩法时 cfg.count 已经被定死了）。
 * 身份模式（A/B/C）本来就只对身份局有意义，跟着一起收。
 */
function syncCountLock(){
  const f = E.formats().filter(x => x.key === cfg.format)[0] || {};
  const fixed = !!f.seats;
  const grp = document.getElementById('pick-count');
  if (grp){
    const row = grp.closest('.form-row');
    if (row) row.style.display = fixed ? 'none' : '';
    grp.querySelectorAll('button').forEach(b => {
      b.disabled = fixed;
      b.classList.toggle('on', +b.dataset.count === cfg.count);
    });
  }
  const modeGrp = document.getElementById('pick-mode');
  if (modeGrp){
    const row = modeGrp.closest('.form-row');
    if (row) row.style.display = fixed ? 'none' : '';
    modeGrp.querySelectorAll('button').forEach(b => { b.disabled = fixed; });
  }
}
function renderFormatHint(){
  const h = document.getElementById('format-hint');
  if (!h) return;
  const f = E.formats().filter(x => x.key === cfg.format)[0] || {};
  h.textContent = (f.seats ? '固定 ' + f.seats + ' 人。' : '') + (FORMAT_HINT[cfg.format] || '');
}

/* ---------------- 开始界面 ---------------- */
function bindStartScreen(){
  document.querySelectorAll('#pick-count button').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#pick-count button').forEach(x => x.classList.remove('on'));
      b.classList.add('on'); cfg.count = +b.dataset.count; renderPreview();
    });
  });
  document.querySelectorAll('#pick-mode button').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#pick-mode button').forEach(x => x.classList.remove('on'));
      b.classList.add('on'); cfg.mode = b.dataset.mode;
    });
  });
  document.querySelectorAll('#pick-deal button').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#pick-deal button').forEach(x => x.classList.remove('on'));
      b.classList.add('on'); cfg.deal = +b.dataset.deal;
    });
  });
  // 电脑强度 / 快速动画 / 保护轮 / 拓展包 都搬进「设置」了 ——
  // 它们不是每局都要动的东西，摆在开始界面反而把选玩法这件事埋住了
  bindFormats();
  const bs = document.getElementById('btn-settings');
  if (bs) bs.addEventListener('click', showSettings);
  const ts = document.getElementById('btn-settings-top');
  if (ts) ts.addEventListener('click', showSettings);
  // 图鉴：两张全屏只读页
  const bc = document.getElementById('btn-chars');
  if (bc) bc.addEventListener('click', showCharCodex);
  const bcd = document.getElementById('btn-cards');
  if (bcd) bcd.addEventListener('click', showCardCodex);
  const cb = document.getElementById('chars-back');
  if (cb) cb.addEventListener('click', () => window.UI.show('start'));
  const cdb = document.getElementById('cards-back');
  if (cdb) cdb.addEventListener('click', () => window.UI.show('start'));
  document.getElementById('btn-start').addEventListener('click', startSetup);
  const bt = document.getElementById('btn-tutorial');
  if (bt) bt.addEventListener('click', () => {
    if (window.Net && Net.isOnline()) Net.leave();
    window.Tutorial.start();
  });
  const bn = document.getElementById('btn-net');
  if (bn) bn.addEventListener('click', () => {
    if (window.Net && Net.isOnline()) Net.leave();     // 已经在房间里就先退掉
    window.Net.showHome();
    window.UI.show('net');
  });
  document.getElementById('btn-rules').addEventListener('click', () => window.UI.showRules());
  // 看复盘：选一个 .json 复盘文件放出来
  const br = document.getElementById('btn-replay');
  const rf = document.getElementById('replay-file');
  if (br && rf){
    br.addEventListener('click', () => rf.click());
    rf.addEventListener('change', () => {
      const f = rf.files && rf.files[0];
      if (!f) return;
      Net.loadReplayFile(f, m => window.UI.toast(m, 'warn'));
      rf.value = '';                 // 允许连续载入同一个文件
    });
  }
  const bsr = document.getElementById('btn-save-replay');
  if (bsr) bsr.addEventListener('click', () => Net.saveReplay());
  // 分享版：把整局打成一个自带游戏的 .html，对方点开就能放
  const bsh = document.getElementById('btn-share-replay');
  if (bsh) bsh.addEventListener('click', () => {
    bsh.disabled = true;
    Promise.resolve(Net.exportReplayHtml()).then(
      () => { bsh.disabled = false; },
      e => { bsh.disabled = false; window.UI.toast('导出失败：' + ((e && e.message) || e), 'warn'); }
    );
  });
  document.getElementById('btn-again').addEventListener('click', () => {
    window.UI.closeModal();
    // 联机中：退掉房间回到开始界面（Net.leave 自己会切屏）
    if (window.Net && Net.isOnline()){ Net.leave(); return; }
    window.UI.show('start');
  });
  renderPreview();
}

/** 非身份玩法的阵营速览（身份局的走身份配置表） */
const FORMAT_SIDES = {
  team2v2:  '红队 1、4 号位　·　蓝队 2、3 号位（队友明置）',
  landlord: '地主 1 人（+1 体力上限）　·　农民 2 人'
};

function renderPreview(){
  const box = document.getElementById('identity-preview');
  if (!box) return;
  if (cfg.format !== 'identity'){
    const team = FORMAT_SIDES[cfg.format];
    if (team){ box.innerHTML = '<span class="id-chip">' + team + '</span>'; return; }
  }
  const conf = D.IDENTITY_CONFIG[cfg.count];
  // 身份局以外的人数（比如斗地主 3 人）在这张表里没有档位 —— 直接 conf[k] 会抛异常，
  // 表现是"一按那个按钮开始界面就崩"
  if (!conf){
    box.innerHTML = '<span class="id-chip">本局不使用身份配置</span>';
    return;
  }
  let html = '';
  for (const k of ['dean','staff','student','mole']){
    if (!conf[k]) continue;
    const id = D.IDENTITIES[k];
    html += '<span class="id-chip ' + id.cls + '">' + id.name + ' ×' + conf[k] + '　<span style="opacity:.7">' + id.win + '</span></span>';
  }
  box.innerHTML = html;
}

/* ---------------- 开局：发身份 → 选角 ---------------- */
function startSetup(){
  // 清掉上一局可能残留的中央提示层（先触发一次点击，让上一局的等待正常结束）
  const fxLayer = document.getElementById('fx-layer');
  if (fxLayer){
    const blocking = fxLayer.querySelector('.fx-overlay.blocking');
    if (blocking) blocking.click();
    fxLayer.innerHTML = '';
  }
  if (window.Net && Net.isOnline()) Net.leave();   // 别让单机局盖掉联机局
  if (window.Tutorial) Tutorial.stop();            // 从教学局切到正式对局时把提示条收掉
  E.initGame({
    count: cfg.count, mode: cfg.mode, deal: cfg.deal, aiOthers: cfg.ai,
    protect: cfg.protect, hotseat: !cfg.ai, networkRule:false,
    packs: cfg.packs,
    format: cfg.format,
    fast: cfg.fast
  });
  localSetupStep();
}

/** 本机需要亲自做决定的座位（热座 = 每个座位都要问） */
function localSeats(){
  if (G.opts.hotseat) return G.players.map(p => p.seat);
  return (G.humanSeats || [G.humanSeat]).slice();
}

/* ---------------- 斗地主：叫分 ----------------
 * 在选角**之前**跑一段交互：按座位顺序每人叫一次分，定下地主。
 * 地主的候选是 5 张、农民 3 张，所以必须先叫分再发候选（引擎里 redealForLandlord 重发）。 */
function runLandlordBid(){
  const seat = E.bidNext();
  if (seat < 0){ E.bidFinish(); localSetupStep(); return; }
  const p = G.players[seat];
  if (!p.isHuman){ E.bidSubmit(seat, aiBid()); return runLandlordBid(); }
  // 联机时这个座位可能是别人的：交给 Net 去问，问到答案再接着往下走
  if (window.Net && Net.isOnline && Net.isOnline() && seat !== G.humanSeat){
    window.Net.remoteBid(seat, score => { E.bidSubmit(seat, score); runLandlordBid(); });
    return;
  }
  showBidPicker(seat, score => { E.bidSubmit(seat, score); runLandlordBid(); });
}
window.showBidPicker = showBidPicker;      // 客机收到 'bid' 消息时要调它

/* ---------------- 2V2：禁选 ----------------
 * 简化版：四个座位各禁一名武将（1↔2、3↔4 各从对方的角度禁），
 * 禁掉的从本局名单里剔除再发候选。 */
function runTeamBan(){
  const seat = E.banNext();
  if (seat < 0){ E.banFinish(); localSetupStep(); return; }
  const p = G.players[seat];
  if (!p.isHuman){ E.banSubmit(seat, aiBan()); return runTeamBan(); }
  if (window.Net && Net.isOnline && Net.isOnline() && seat !== G.humanSeat){
    window.Net.remoteBan(seat, charId => { E.banSubmit(seat, charId); runTeamBan(); });
    return;
  }
  showBanPicker(seat, charId => { E.banSubmit(seat, charId); runTeamBan(); });
}
window.showBanPicker = showBanPicker;

/** AI 禁谁：禁"评分最高"的那名（和它自己选将用的是同一套打分），但别禁重复的 */
function aiBan(){
  const taken = G.bannedIds || [];
  const pool = D.allCharacters().filter(c => taken.indexOf(c.id) < 0);
  if (!pool.length) return null;
  let best = pool[0], bestScore = -1;
  for (const c of pool){
    const s = c.hp * 12 + Math.random() * 10;
    if (s > bestScore){ bestScore = s; best = c; }
  }
  return best.id;
}

/**
 * 禁选界面：列出全部武将（含拓展包）让你挑一个禁掉。
 * 名单可能有 37 个，所以做成可滚动的小卡片列表。
 */
function showBanPicker(seat, onPick){
  const taken = G.bannedIds || [];
  const body = document.createElement('div');
  body.className = 'ban-body';
  const each = D.allCharacters();
  let html = '<p class="hint">从名单里禁掉一名武将 —— 本局双方都不会拿到他。' +
    (taken.length ? '　已被禁：<b>' + taken.map(id => {
      const c = each.filter(x => x.id === id)[0]; return c ? c.name : id;
    }).join('、') + '</b>' : '') + '</p>';
  html += '<div class="ban-list" id="ban-options">';
  each.forEach(c => {
    const off = taken.indexOf(c.id) >= 0;
    html += '<button class="ban-item' + (off ? ' off' : '') + '" data-id="' + c.id + '"' +
      (off ? ' disabled' : '') + '>' +
      '<b>' + c.name + '</b><span>' + c.hp + ' 血</span>' +
      '<i>' + c.skills.map(s => s.name).join('、') + '</i></button>';
  });
  html += '</div>';
  body.innerHTML = html;
  body.querySelectorAll('.ban-item').forEach(b => {
    b.addEventListener('click', () => {
      window.UI.closeModal();
      onPick(b.dataset.id);
    });
  });
  window.UI.modal({ title: '禁用武将　（' + (seat + 1) + ' 号位）', body, actions: [] });
}

/**
 * AI 叫分。**只能盲叫** —— 叫分发生在发牌之前，AI 手里没有牌。
 * 别去偷看牌堆"让 AI 打得聪明点"：那会通过 G 泄漏给玩家。
 * 难度只影响激进程度。
 */
function aiBid(){
  const best = (G.bid && G.bid.best) || 0;
  if (best >= 3) return 0;
  const lv = window.AI.getLevel ? window.AI.getLevel() : 'normal';
  const appetite = lv === 'hard' ? 0.85 : lv === 'easy' ? 0.35 : 0.6;
  if (Math.random() > appetite) return 0;
  return best + 1 + Math.floor(Math.random() * (3 - best));
}

function showBidPicker(seat, onPick){
  const best = (G.bid && G.bid.best) || 0;
  const body = document.createElement('div');
  body.className = 'bid-body';
  body.innerHTML =
    '<p class="hint">依次叫分，必须高于当前最高分；叫满 <b>3 分</b> 直接当地主。</p>' +
    '<p class="hint">当前最高：<b>' + (best > 0 ? best + ' 分' : '还没人叫') + '</b>' +
      '　·　地主多 1 点体力上限，另有【飞扬】【跋扈】两个专属技能</p>';
  const opts = document.createElement('div');
  opts.className = 'btn-group';
  opts.id = 'bid-options';
  [{ k:0, label:'不叫' }]
    .concat([1,2,3].filter(s => s > best).map(s => ({ k:s, label:s + ' 分' })))
    .forEach(c => {
      const b = document.createElement('button');
      b.className = 'big';
      b.textContent = c.label;
      b.addEventListener('click', () => { window.UI.closeModal(); onPick(c.k); });
      opts.appendChild(b);
    });
  body.appendChild(opts);
  window.UI.modal({ title: '叫分　（' + (seat + 1) + ' 号位）', body, actions: [] });
}

/**
 * 设置阶段的状态机：模式 B 先身份轮抽，然后所有人选角。
 * 热座模式下会把每个座位一个个问过去。
 */
function localSetupStep(){
  // 开局前的两段交互，顺序固定：斗地主先叫分（它决定候选张数），2V2 先禁选
  if (G.format === 'landlord' && !G.bidDone) return runLandlordBid();
  if (G.format === 'team2v2' && !G.banDone) return runTeamBan();
  if (G.mode === 'B'){
    const seat = E.advanceIdentityDraft();
    if (seat >= 0){
      G.humanSeat = seat;
      return showDraftPicker(seat, k => { E.assignIdentity(seat, k); localSetupStep(); });
    }
  }
  const seat = localSeats().find(s => G.players[s] && !G.players[s].char);
  if (seat === undefined) return afterSetupRoles();
  G.humanSeat = seat;
  showRolePicker(seat, c => {
    E.assignRole(seat, c);
    if (G.mode === 'C') return showIdentityReveal(seat, localSetupStep);   // 选完才揭晓
    localSetupStep();
  });
}

function afterSetupRoles(){
  E.finalizeRoles();
  if (G.opts.hotseat) G.players.forEach(p => { p.isHuman = true; });
  E.finalizeGame();
  E.dealInitialHands();
  window.UI.show('game');
  // 模式 C 的身份是在选角之后才揭晓的，进游戏前补一次
  if (G.mode === 'C'){
    const me = G.players[G.humanSeat];
    E.log('你的身份是【' + D.IDENTITIES[me.identity].name + '】', 'big');
  }
  window.UI.render();
  logOpening();
  window.Net && Net.startLocalRec && Net.startLocalRec(G.humanSeat);   // 开录复盘
  window.UI.maybeShowTutorial();      // 第一次玩的人给个四步引导
  gameStart();
}

/**
 * 身份轮抽界面（模式 B 自选阵营）。
 * 身份池是公开的，但选完只有本人知道 —— 所以这里只列还剩什么，不列谁拿了什么。
 */
function showDraftPicker(seat, onPick){
  const box = document.getElementById('draft-options');
  if (!box) return;
  const left = E.identityPoolLeft();
  const note = document.getElementById('draft-note');
  const who = G.players[seat];
  if (note){
    note.textContent = (G.opts.hotseat ? '轮到「' + who.name + '」挑' : '轮到你挑') +
      '　·　还剩 ' + left.length + ' 张身份牌：' + left.map(k => D.IDENTITIES[k].name).join('、');
  }
  box.innerHTML = '';
  left.forEach(k => {
    const id = D.IDENTITIES[k];
    const el = document.createElement('div');
    el.className = 'role-card draft-card ' + id.cls;
    el.innerHTML = '<div class="rc-name">' + id.name + '</div>' +
      '<div class="rc-title">阵营：' + id.faction + '</div>' +
      '<div class="rc-skill">胜利条件：' + id.win + '</div>' +
      '<div class="rc-skill">' + id.desc + '</div>';
    el.addEventListener('click', () => onPick(k));
    box.appendChild(el);
  });
  window.UI.show('draft');
}
window.showDraftPicker = showDraftPicker;

/** 模式 C：选完角色才揭晓身份 —— 这是这个模式的全部乐趣所在 */
function showIdentityReveal(seat, done){
  const p = G.players[seat];
  const id = D.IDENTITIES[p.identity];
  const body = document.createElement('div');
  body.className = 'reveal-body';
  body.innerHTML = '<div class="reveal-card ' + id.cls + '">' +
    '<div class="reveal-label">' + (G.opts.hotseat ? '「' + p.name + '」的身份' : '你的身份') + '</div>' +
    '<div class="reveal-big">' + id.name + '</div>' +
    '<div class="reveal-sub">' + id.faction + '　·　' + id.win + '</div>' +
    '<div class="reveal-desc">' + id.desc + '</div>' +
    '</div>';
  window.UI.modal({
    title: '身份揭晓', body,
    actions: [{ label:'知道了', cls:'primary', key:'ok', onClick: () => { window.UI.closeModal(); done(); } }]
  });
}
window.showIdentityReveal = showIdentityReveal;

/**
 * 选角界面。单机和联机共用：联机时由房主传进来一个"把选择发给房主"的回调。
 *   seat  —— 这是给哪个座位选的（热座下会逐个问）
 *   onPick —— 选中回调；不传就用单机的 pickRole
 */
function showRolePicker(seat, onPick){
  const me = G.players[seat == null ? G.humanSeat : seat];
  const handler = onPick || pickRole;
  const idBox = document.getElementById('my-identity-card');
  // 模式 C：选角色的时候**还不知道**自己是什么身份，这里只显示占位
  if (G.mode === 'C'){
    idBox.className = 'identity-card unknown';
    idBox.innerHTML = '<div class="big-word">身份未知</div>' +
      '<div class="sub">本局是「半随机」模式：先选角色，选定之后再揭晓身份</div>';
  } else {
    // 判断"是不是身份局"不能看 side.key 有没有值 ——
    // 团队玩法下它是 'A'/'landlord'，**也是真值**，于是会去查 D.IDENTITIES['landlord']
    // 拿到 undefined 再读 .cls 直接崩（这一处就是这么炸的）。
    // 正确的判据是"这个 key 在身份表里有没有"。
    const side = E.sideInfo(me);
    const id = D.IDENTITIES[side.key];
    if (!id){
      // 团队玩法：没有身份这回事，显示阵营
      idBox.className = 'identity-card ' + side.cls;
      idBox.innerHTML = '<div class="big-word">' + side.name + '</div>' +
        '<div class="sub">' + E.formatLabel() + '　|　目标：' + side.goal + '</div>' +
        '<div class="sub">看棋盘上的阵营标记就知道谁跟你一队</div>';
    } else {
      idBox.className = 'identity-card ' + id.cls;
      idBox.innerHTML = '<div class="big-word">' + id.name + '</div>' +
        '<div class="sub">阵营：' + id.faction + '　|　胜利条件：' + id.win + '</div>' +
        '<div class="sub">' + id.desc + '</div>';
    }
  }
  const box = document.getElementById('role-options');
  box.innerHTML = '';
  // 优先用候选数本身：G.dealPer 是单值，而斗地主那种"地主 5 张、农民 3 张"的
  // 模式下它对每一座位都会说谎。
  const actualDeal = me.charChoices.length || (window.G && G.dealPer) || 0;
  const rosterSize = ((window.G && G.roster) ? G.roster : D.CHARACTERS).length;
  const oldNote = box.parentNode.querySelector('.deal-note');
  if (oldNote) oldNote.remove();
  const tie = document.createElement('div');
  tie.className = 'hint deal-note';
  tie.textContent = (G.opts.hotseat ? '「' + me.name + '」' : '你') +
    '从 ' + actualDeal + ' 名武将中选 1 名；其余 ' + (G.players.length - 1) +
    ' 名对手会从剩下的 ' + (rosterSize - actualDeal) + ' 名里挑选（同一局不会出现重复武将）';
  box.parentNode.insertBefore(tie, box);
  me.charChoices.forEach(c => {
    const el = document.createElement('div');
    el.className = 'role-card';
    el.innerHTML = '<div class="rc-name">' + c.name + '</div>' +
      '<div class="rc-title">' + c.title + '</div>' +
      '<div class="rc-hp">体力上限 ' + c.hp + (me.identity === 'dean' ? '（院长 +1 → ' + (c.hp+1) + '）' : '') + '</div>' +
      c.skills.map(s => '<div class="rc-skill"><b>【' + s.name + '】</b>' + s.type + '：' + D.md(s.text) + '</div>').join('');
    el.addEventListener('click', () => handler(c));
    box.appendChild(el);
  });
  window.UI.show('role');
}
window.showRolePicker = showRolePicker;

/** 单机路径下的默认选角回调：选完继续走设置状态机 */
function pickRole(c){
  E.assignRole(G.humanSeat, c);
  if (G.mode === 'C') return showIdentityReveal(G.humanSeat, localSetupStep);
  localSetupStep();
}

function logOpening(){
  E.logBig('东秦杀：点名册　' + G.players.length + ' 人局');
  // 身份局才有"身份配置"和"院长"这两句话；团队形式下这两处解引用都会崩
  const conf = D.IDENTITY_CONFIG[G.players.length];
  if (conf){
    E.log('身份配置：院长 ' + conf.dean + '、教务 ' + conf.staff + '、学生 ' + conf.student + '、卧底 ' + conf.mole, 'sys');
  }
  const dean = G.players.find(p => p.identity === 'dean');
  if (dean) E.log('院长是 ' + (dean.seat+1) + ' 号位 ' + dean.char.name + '（身份公开，体力上限 +1）', 'sys');
  const me = G.players[G.humanSeat];
  if (!me) return;
  // 阵营名称走形式表。注意判据是"这个 key 在身份表里有没有"，
  // 不能看 side.key 有没有值 —— 团队玩法下它是 'A'/'landlord'，也是真值
  const side = E.sideInfo(me);
  E.log('你是 ' + (me.seat+1) + ' 号位 ' + me.char.name + '，' +
        (D.IDENTITIES[side.key] ? '身份【' + side.name + '】' : '阵营：' + side.name), 'big');
  if (G.opts.protect) E.log('已启用保护轮：第一圈内无人死亡', 'sys');
}

async function gameStart(){
  // 保护轮由引擎的伤害结算入口统一钳制（见 engine.js damage()）
  await E.gameLoop();
}

/* ---------------- 全局错误提示（便于排查） ---------------- */
function reportError(msg, where){
  try { window.UI.toast('运行错误：' + msg + '（' + where + '）', 'warn'); } catch (_) {}
  try { window.Engine.log('❌ 运行错误：' + msg + ' @ ' + where, 'dmg'); } catch (_) {}
}
window.addEventListener('error', e => {
  const msg = (e && e.message) ? e.message : '未知错误';
  const where = (e && e.filename ? e.filename.split('/').pop() : '') + (e && e.lineno ? ':' + e.lineno : '');
  reportError(msg, where);
});
window.addEventListener('unhandledrejection', e => {
  const r = e && e.reason;
  reportError((r && (r.message || r)) || '未处理的异步错误', 'Promise');
});

document.addEventListener('DOMContentLoaded', () => {
  try {
    // 电脑强度存在本机，开局前恢复一次（AI 档位是内存里的全局值，刷新就丢）
    if (window.Net && Net.setAiLevel) Net.setAiLevel(setting(AI_LEVEL_KEY, 'normal'));
    bindStartScreen();
    window.UI.bindTopbar();
    window.UI.bindReplayBar();
    window.UI.bindHostGone();
    if (window.Tutorial) window.Tutorial.bindBar();
    window.UI.show('start');
    if (window.Net){
      // 点别人的邀请链接进来的（?room=1234）：直接进房间，
      // 优先级高于"刷新页面自动重连"——用户显然是奔着新房间来的
      const invited = Net.autoJoinFromUrl && Net.autoJoinFromUrl();
      if (!invited && Net.tryRejoin){
        // 刷新页面 / 手机切回来之后，自动认领回原来的座位
        const r = Net.tryRejoin();
        if (r && r.then) r.catch(() => {});
      }
    }
  } catch (err){
    document.body.insertAdjacentHTML('beforeend',
      '<div style="position:fixed;left:20px;bottom:20px;z-index:999;color:#f0a0a0;background:#2a1414;' +
      'border:1px solid #8a4a4a;padding:10px 14px;border-radius:8px;font-size:13px">' +
      '初始化失败：' + (err && err.message) + '</div>');
  }
});
})();
