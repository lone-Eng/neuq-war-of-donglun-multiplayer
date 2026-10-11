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
/* =========================================================
 *  一·B、背景音乐（BGM）
 * =========================================================
 * 音频文件放在 audio/bgm/ 下，页面按常见文件名逐个试 ——
 * **找不到就静默停手**（单文件手机版没有 audio/ 目录，这是预期行为，不是错误）。
 *
 * 为什么不把曲子内联进单文件版：一首 3 分钟的曲子 base64 之后约 4 MB，
 * 单文件会从 510 KB 胀到 5 MB 以上，把"一个文件拷到手机就能玩、不联网"
 * 这个最大的好处毁掉。所以那边就是没 BGM，换来的是便携。
 *
 * 拿曲子：跑 tools\get-bgm.ps1（它从公版音乐库拉，CC0、无需署名）。
 */
const BGM_CANDIDATES = ['bgm.mp3', 'bgm.m4a', 'bgm.ogg', 'bgm.wav'];
const Bgm = { el: null, on: true, vol: 0.35, tried: false, ready: false };
try {
  if (localStorage.getItem('dqk_bgm') === '0') Bgm.on = false;
  const v = parseFloat(localStorage.getItem('dqk_bgm_vol'));
  if (!isNaN(v)) Bgm.vol = Math.max(0, Math.min(1, v));
} catch (e) { /* file:// 下 localStorage 可能不可用 */ }

/** 从 <script src> 反推 audio/<子目录>/ 的位置 —— 页面在子目录下也能找对 */
function audioBase(sub){
  const s = document.querySelector('script[src*="fx.js"]');
  const src = s ? (s.getAttribute('src') || '') : 'js/fx.js';
  const i = src.lastIndexOf('/');
  const dir = i >= 0 ? src.slice(0, i + 1) : 'js/';              // 'js/' 或 '../js/'
  return dir.replace(/js\/$/, '') + 'audio/' + sub + '/';        // '' 或 '../'
}
function bgmBase(){ return audioBase('bgm'); }
function voiceBase(){ return audioBase('voice'); }

Bgm.load = function(){
  if (Bgm.tried) return;
  Bgm.tried = true;
  let idx = 0;
  const tryNext = () => {
    if (idx >= BGM_CANDIDATES.length) return;      // 一个都没有：保持安静
    const el = new Audio();
    el.loop = true;
    el.preload = 'auto';
    el.volume = Bgm.on ? Bgm.vol : 0;
    el.addEventListener('canplaythrough', () => {
      Bgm.el = el; Bgm.ready = true;
      if (Bgm.on) Bgm.play();
    }, { once: true });
    el.addEventListener('error', tryNext, { once: true });
    el.src = bgmBase() + BGM_CANDIDATES[idx++];
    el.load();
  };
  tryNext();
};
/** 播放。浏览器不允许无交互自动播放 —— 所以只在用户点过页面之后调才有效 */
Bgm.play = function(){
  if (!Bgm.on || !Bgm.el) return;
  const p = Bgm.el.play();
  if (p && p.catch) p.catch(() => { /* 被自动播放策略拦下：等下一次用户操作 */ });
};
Bgm.pause = function(){ if (Bgm.el){ try { Bgm.el.pause(); } catch (e) {} } };
Bgm.setOn = function(v){
  Bgm.on = !!v;
  try { localStorage.setItem('dqk_bgm', v ? '1' : '0'); } catch (e) {}
  if (Bgm.on){ Bgm.load(); Bgm.play(); } else Bgm.pause();
  return Bgm.on;
};
Bgm.setVol = function(v){
  Bgm.vol = Math.max(0, Math.min(1, v));
  try { localStorage.setItem('dqk_bgm_vol', String(Bgm.vol)); } catch (e) {}
  if (Bgm.el) Bgm.el.volume = Bgm.on ? Bgm.vol : 0;
  return Bgm.vol;
};
FX.bgm = Bgm;

// 浏览器不会让页面自己出声。第一次点/按键时补上（这时候才允许播）。
// 挂四种事件：合成点击（自动化测试、部分辅助工具）**不会**触发 pointerdown，
// 只挂 pointerdown 的话那种情况下 BGM 永远不加载。
(function kickBgm(){
  const EV = ['pointerdown', 'mousedown', 'keydown', 'touchstart'];
  const go = () => {
    EV.forEach(e => document.removeEventListener(e, go));
    Bgm.load();
  };
  EV.forEach(e => document.addEventListener(e, go));
})();

/* =========================================================
 *  一·C、语音报牌与技能台词
 * =========================================================
 * 两条路，优先用第一条：
 *   1. **音色包**：audio/voice/ 下由 tools\make-voice.ps1 预生成的 mp3
 *      （开源模型 Kokoro-82M-v1.1-zh 配音，12 种音色）。设置里能逐个试听、切换。
 *   2. **系统语音**（兜底）：浏览器自带的 speechSynthesis，零文件、完全离线，
 *      音色取决于玩家系统装了哪些中文语音包。
 * 没生成过音色包 / 单文件手机版没有 audio/ 目录 / 某个句子还没配音 ——
 * 全都会静默退回系统语音，功能不残缺（和 BGM 找不到曲子就安静是一个道理）。
 */
const Voice = { on: true, sex: 'female', pack: 'sys-female' };
/** 音色包清单（audio/voice/packs.json）。ready 之前一律走系统语音。 */
const Packs = { list: [], ready: false, tried: false, ext: 'mp3', dir: '', pending: null };
try {
  if (localStorage.getItem('dqk_voice') === '0') Voice.on = false;
  // 老版本只存了男女声：把它当成"选了系统男声/系统女声"，别让选择器高亮和实际发音对不上
  const s = localStorage.getItem('dqk_voice_sex');
  if (s === 'male' || s === 'female'){ Voice.sex = s; Voice.pack = 'sys-' + s; }
  const p = localStorage.getItem('dqk_voice_pack');
  if (p) Voice.pack = p;
  if (Voice.pack === 'sys-male') Voice.sex = 'male';
  else if (Voice.pack === 'sys-female') Voice.sex = 'female';
} catch (e) { /* 忽略 */ }

/** 系统里可用的中文语音（各平台差别很大） */
Voice.list = function(){
  if (!window.speechSynthesis) return [];
  try { return window.speechSynthesis.getVoices().filter(v => /^zh/i.test(v.lang || '')); }
  catch (e){ return []; }
};

/**
 * 系统语音念一句。连着出牌时先 cancel —— 否则会排成一长队，念的永远比出的慢。
 * 男女声主要靠音高区分：系统的中文语音包未必真的分性别。
 */
function sysSpeak(text){
  if (!window.speechSynthesis || !text) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text));
    u.lang = 'zh-CN';
    u.rate = 1.05;
    u.pitch = (Voice.sex === 'male') ? 0.75 : 1.4;
    const vs = Voice.list();
    if (vs.length){
      const want = vs.filter(v => Voice.sex === 'male'
        ? /男|yunxi|kangkang|liang|male/i.test(v.name || '')
        : /女|xiaoxiao|xiaoyi|huihui|female/i.test(v.name || ''));
      u.voice = want[0] || vs[0];
    }
    window.speechSynthesis.speak(u);
  } catch (e) { /* 语音不可用就当没有这个功能 */ }
}

/* ---- 音色包 ----
 * 目录、文件名约定和台词表都由 tools\voicegen.py 生成时定死：
 *    audio/voice/packs.js             清单，游戏读这个（<script> 加载，file:// 也能用）
 *    audio/voice/packs.json           同一份内容，给人看 / 给脚本校验用
 *    audio/voice/<id>/c-<牌名>.mp3     45 张牌
 *    audio/voice/<id>/s-<技能名>.mp3   74 句技能台词
 * 名字里的中文直接当文件名 —— 项目里都是普通中文词，服务器和浏览器都认。
 */
Voice.loadPacks = function(){
  if (Packs.ready) return Promise.resolve(true);
  if (Packs.pending) return Packs.pending;      // 别并发重复请求同一个文件
  Packs.tried = true;
  const base = voiceBase();
  // 用 <script> 而不是 fetch 读清单 —— 这一点很关键：
  // **双击 index.html（file://）时浏览器不允许 fetch 本地文件**，用 fetch 的话
  // 音色列表会只剩「系统女声/系统男声」，生成的 12 个音色一个都点不到。
  // <script> 在 file:// 下照常能加载（index.html 自己就是这么加载 js/*.js 的），
  // js/sources.js 当初也是为同一个原因才存在的。
  // 生成端把清单同时写成 packs.json（给人看/给脚本校验）和 packs.js（给游戏读）。
  Packs.pending = new Promise(resolve => {
    const s = document.createElement('script');
    s.async = true;
    s.src = base + 'packs.js';
    s.onload = () => {
      const j = window.DQK_VOICE_PACKS;
      if (!j || !j.packs) return resolve(false);
      Packs.dir = base;
      Packs.ext = j.ext || 'mp3';
      Packs.list = j.packs.filter(p => p && p.id && p.dir);
      Packs.ready = Packs.list.length > 0;
      // 之前选的音色可能已经不在清单里了（换过音色集、重新生成过）：
      // 自动回到系统女声，免得上一个选中项都没有、看起来像坏了。
      // 注意别把「系统男声」也当成"不在清单里" —— 它本来就不该在清单里。
      if (Packs.ready && Voice.pack !== 'sys-female' && Voice.pack !== 'sys-male' &&
          !Packs.list.some(p => p.id === Voice.pack)) Voice.setPack('sys-female');
      resolve(Packs.ready);
    };
    // 没生成过音色包 / 单文件手机版没有 audio/ 目录：都是预期情况，安静走系统语音
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  }).then(v => { Packs.pending = null; return v; });   // 失败不入缓存：下次（比如开设置）可以重试
  return Packs.pending;
};

/** 清单读进来没有（设置界面靠它决定要不要显示「音色包正在加载」） */
Voice.packsReady = function(){ return Packs.ready; };

/** 测试钩子：忘掉读过的清单，好让测试重新 mock fetch 再读一遍 */
Voice._resetPacks = function(){
  Packs.tried = false; Packs.ready = false; Packs.list = []; Packs.dir = '';
  Packs.ext = 'mp3'; Packs.pending = null;
};

/** 测试钩子：系统语音的出口（项目里没装 speechSynthesis 时它自己会静默） */
Voice._sysSpeak = sysSpeak;

/**
 * 音色包文件放不出来时走这里（文件还没生成 / 名字对不上 / 浏览器不支持这个格式）。
 * 退回系统语音 —— 宁可音色不一致，也不能让战斗忽然变哑。
 */
Voice._onPackError = function(text){
  if (Voice.on && text) Voice._sysSpeak(text);
};

/** 设置界面用：系统两个 + 每个音色包一项 */
Voice.packList = function(){
  const out = [{ k: 'sys-female', label: '系统女声' }, { k: 'sys-male', label: '系统男声' }];
  Packs.list.forEach(p => out.push({ k: p.id, label: p.name || p.id }));
  return out;
};

/** 当前选的是不是音色包（不是那两个系统选项） */
Voice.currentPack = function(){
  if (Voice.pack === 'sys-female' || Voice.pack === 'sys-male') return null;
  return Packs.list.filter(p => p.id === Voice.pack)[0] || null;
};

Voice.setPack = function(k){
  const ok = (k === 'sys-female' || k === 'sys-male') || Packs.list.some(p => p.id === k);
  if (!ok) return Voice.pack;
  Voice.pack = k;
  if (k === 'sys-male' || k === 'sys-female') Voice.sex = (k === 'sys-male') ? 'male' : 'female';
  try {
    localStorage.setItem('dqk_voice_pack', Voice.pack);
    if (k === 'sys-male' || k === 'sys-female') localStorage.setItem('dqk_voice_sex', Voice.sex);
  } catch (e) { /* 忽略 */ }
  return Voice.pack;
};

/** 掐掉正在播的那一句（和 speechSynthesis.cancel 的用意一致） */
Voice.stopAudio = function(){
  if (Voice._el){ try { Voice._el.pause(); } catch (e) {} Voice._el = null; }
};

/** 播一个音色包文件；文件不在（还没配音 / 名字对不上）就退回系统语音，别哑。 */
Voice.playUrl = function(url, fallbackText){
  try {
    Voice.stopAudio();
    // 刚切成音色包时，上一条还排在系统语音队列里的句子也得掐掉，不然两句会叠着响
    if (window.speechSynthesis){ try { window.speechSynthesis.cancel(); } catch (e) {} }
    const el = new Audio();
    el.addEventListener('error', () => Voice._onPackError(fallbackText), { once: true });
    el.src = url;
    Voice._el = el;
    const p = el.play();
    if (p && p.catch) p.catch(() => { /* 自动播放被拦下：等下一次用户操作 */ });
    return true;
  } catch (e){ return false; }
};

/**
 * 台词 -> 音色包里的文件名。
 * 生成端（tools\voicegen.py 的 file_name()）按同一条规则写文件，改这里要两边一起改。
 *   kind: 'card' = 牌名（报牌）／'skill' = 技能台词
 */
Voice.fileName = function(text, kind){
  return (kind === 'skill' ? 's-' : 'c-') + text + '.' + Packs.ext;
};

/** 念一句。选了音色包就用文件，否则（或文件缺失）用系统语音。 */
Voice.speak = function(text, kind){
  if (!Voice.on || !text) return;
  const pack = Voice.currentPack();
  if (pack){
    const url = Packs.dir + pack.dir + '/' + Voice.fileName(text, kind);
    if (Voice.playUrl(url, text)) return;
  }
  sysSpeak(text);
};
/* ---- 技能语音 ----
 * 台词表在 data.js 的 SKILL_LINES。这里只负责"什么时候念"。
 *
 * 为什么在日志里嗅探而不是在技能实现里逐行调用：全项目 70 多个技能散在引擎各处，
 * 而且每个技能生效时**都会留一条带技能名的日志** —— 一个钩子就够，
 * 也不用担心以后新加技能时忘了插语音。
 */
const SKILL_LINES = D.SKILL_LINES || {};
const lastSkillLine = {};
let lastSkillLineAt = 0;

/** 测试钩子：清掉"刚念过技能台词"的节流状态，让报牌那条能独立验证 */
FX._resetVoiceThrottle = function(){
  lastSkillLineAt = 0;
  for (const k in lastSkillLine) delete lastSkillLine[k];
};

FX.saySkillFromLog = function(text){
  if (!Voice.on || !text) return;
  const s = String(text);
  for (const name in SKILL_LINES){
    if (s.indexOf(name) < 0) continue;
    const now = Date.now();
    // 【正义】【过滤】这种每次挨打都会触发，不节流的话会念成一片。
    // 技能名在全局唯一（一个技能只属于一个角色），所以按技能名节流就够。
    if (lastSkillLine[name] && now - lastSkillLine[name] < 4000) return;
    lastSkillLine[name] = now;
    lastSkillLineAt = now;
    Voice.speak(SKILL_LINES[name], 'skill');
    return;
  }
};

Voice.setOn = function(v){
  Voice.on = !!v;
  try { localStorage.setItem('dqk_voice', v ? '1' : '0'); } catch (e) {}
  if (!Voice.on){
    if (window.speechSynthesis){ try { window.speechSynthesis.cancel(); } catch (e) {} }
    Voice.stopAudio();
  }
  return Voice.on;
};
/** 选系统语音的男女声（等价于把音色切到「系统女声／系统男声」） */
Voice.setSex = function(s){
  Voice.setPack(s === 'male' ? 'sys-male' : 'sys-female');
  return Voice.sex;
};
FX.voice = Voice;

// 启动就把音色包清单读进来（几 KB）。找不到就当没有这回事，安静走系统语音。
Voice.loadPacks();

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
    (opts.response ? '' : '<div class="exch-line">' + D.md(det.effect || meta.desc || '') + '</div>') +
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
  // 语音报牌。放在这里而不是引擎里 —— 引擎每出一张牌都会走这里，
  // 而且复盘回放重演 cardPlay 时也会跟着念 ✅
  // 但刚念过技能台词就先别念牌名：那句话是角色的"人设"，被牌名打断等于白说
  // （Voice.speak 内部会 cancel 掉上一句）
  if (card && card.name && Date.now() - lastSkillLineAt > 1500) Voice.speak(card.name, 'card');
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
  // 走 E.sideInfo：团队形式没有身份，直接解引用会在"任何人死亡"时崩
  const side = window.Engine ? window.Engine.sideInfo(player)
                             : { cls:'', name:'—' };
  el.innerHTML = '<div class="fx-death-box"><div class="fx-death-mark">☠</div>' +
    '<div class="fx-death-name">' + player.name + ' 阵亡</div>' +
    '<div class="fx-death-id ' + side.cls + '">身份揭示：' + side.name + '</div></div>';
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
  // 每一条都过 md()：牌面文案里允许写 **粗体**，不过就是字面星号
  const rows = [
    ['目标', det.target || '—'],
    ['距离', det.dist || '—'],
    ['效果', D.md(det.effect || m.desc || '—')],
    ['限制', D.md(det.limit || '—')],
    ['结算顺序', D.md(det.order || '—')]
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
  const side = window.Engine ? window.Engine.sideInfo(p) : { cls:'', name:'—', visible:false };
  // 原判据里有 `p.seat === G.humanSeat`（自己看自己），E.sideInfo 的 visible 不含这一条
  const known = side.visible || !!(window.G && p.seat === G.humanSeat);
  const body = document.createElement('div');
  let html = '<div class="dt-head">' +
    '<div class="dt-avatar ' + (known ? side.cls : 'unknown') + '">' + (c ? c.name.charAt(0) : '?') + '</div>' +
    '<div class="dt-meta">' +
      '<div class="dt-line"><b>' + (c ? c.name : '未知') + '</b>' +
        '<span class="dt-suit ' + (known ? side.cls : '') + '">' + (known ? side.name : '身份未知') + '</span></div>' +
      '<div class="dt-line sub">' + (c ? c.title : '') + '</div>' +
      '<div class="dt-line sub">体力 ' + Math.max(0, p.hp) + ' / ' + p.maxHp +
        '　手牌 ' + p.hand.length + '　手牌上限 ' + (window.Engine ? Engine.handLimit(p) : p.hp) + '</div>' +
    '</div></div>';
  if (c){
    html += '<div class="dt-sec">技能</div>';
    c.skills.forEach(s => {
      html += '<div class="dt-skill"><div class="dt-skill-name">【' + s.name + '】<span class="dt-type">' + s.type + '</span></div>' +
        '<div class="dt-skill-text">' + D.md(s.text) + '</div></div>';
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
