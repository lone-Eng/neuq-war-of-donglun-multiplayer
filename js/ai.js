/* =========================================================
 *  东秦杀：点名册  ·  AI 决策
 *  启发式评分 + 简易身份推断（行为记忆）
 * ========================================================= */
(function(){
'use strict';
const D = window.GameData;
const CARDS = D.CARDS;

/* ---------------- 牌力评分（用于弃牌 / 选牌） ---------------- */
function cardValue(c, me){
  const k = CARDS[c.name].kind;
  let v = 50;
  if (k === 'heal') v = 92;
  if (k === 'dodge') v = 82;
  if (k === 'buff') v = 72;
  if (c.name === '辅导员签字') v = 78;
  if (c.name === '上课点名') v = 62;
  if (c.name === '公开处刑' || c.name === '雷同警告') v = 66;
  if (c.type === 'equip'){
    v = 52;
    if (me){
      if (c.slot === 'weapon' && !me.equips.weapon) v = 80;
      else if (c.slot === 'weapon' && CARDS[c.name].range > (CARDS[me.equips.weapon.name].range||1)) v = 74;
      if (c.slot === 'armor' && !me.equips.armor) v = 76;
      // +1 / −1 坐骑是两个独立栏位，各自判空
      if ((c.slot === 'mountUp' || c.slot === 'mountDown') && !me.equips[c.slot]) v = 62;
      if (me.equips.weapon && me.equips.weapon.name === c.name) v = 30;
      else if (me.equips.armor && me.equips.armor.name === c.name) v = 30;
      else if (me.equips[c.slot] && me.equips[c.slot].name === c.name) v = 30;
    }
  }
  if (c.type === 'delayed') v = 46;
  return v;
}

/* ---------------- 电脑强度 ----------------
 * 三档**只调参数，不换决策逻辑**：
 *   noise     评分里的随机项幅度。越大越常做出"次优选择"。
 *   inference 身份推断的权重。0.35 = 只看出个大概，1.7 = 精算。
 *   mistake   出牌阶段"低级错误"的概率：跳过最优解，甚至直接过。
 *   blunder   响应窗口"漏时机"的概率：该打代课/辅导员签字时没打。
 *
 * 注意"不打自己人"**不随难度变化**（见下面的 threat 包装）——
 * 那是基本能力，不是难度；简单档要是会打队友就成了"坏掉"而不是"简单"。
 */
const LEVELS = {
  easy:   { key:'easy',   name:'简单', noise:46, inference:0.35, mistake:0.30, blunder:0.22 },
  normal: { key:'normal', name:'普通', noise:10, inference:1.00, mistake:0.07, blunder:0.05 },
  hard:   { key:'hard',   name:'困难', noise:3,  inference:1.70, mistake:0.00, blunder:0.00 }
};
let aiLevel = 'normal';
function lv(){ return LEVELS[aiLevel] || LEVELS.normal; }
function setLevel(k){ aiLevel = LEVELS[k] ? k : 'normal'; return aiLevel; }
/** 评分用的随机项（幅度由难度决定） */
function J(){ return Math.random() * lv().noise; }

/* ---------------- 简易身份推断 ---------------- */
function aliveCount(id){ return G.players.filter(p => p.alive && p.identity === id).length; }

/** 仇恨度：越高越想打他（-100 = 绝对不打） */
function threatRaw(ai, t){
  if (t === ai || !t.alive) return -100;
  const me = ai.identity, him = t.identity;
  const known = t.revealed || him === 'dean';   // 死亡揭示 / 院长公开
  const harm = (G.harmLog || []).filter(h => h.s === t.seat);

  if (me === 'dean' || me === 'staff'){
    if (him === 'dean') return -100;
    if (known && (him === 'staff')) return -80;
    if (known && (him === 'student' || him === 'mole')) return 100;
    let s = 26;
    // 打过院长 → 更像学生
    const dean = G.players.find(p => p.identity === 'dean');
    harm.forEach(h => {
      const victim = G.players.find(p => p.seat === h.t);
      if (victim && (victim.identity === 'dean' || (victim.revealed && victim.identity === 'staff'))) s += 34;
      else s += 6;
    });
    // 曾救援院长 → 更像教务（救援记录由 engine.js 写进 G.rescueLog）
    // 注：这里原本读的是 ai._memo.rescue，而 _memo 全项目**只读不写**，
    // 所以这个分支从来没生效过。改成读全局的公开记录。
    if (G.rescueLog && G.rescueLog[t.seat]) s -= 40;
    return Math.max(0, Math.min(100, s));
  }
  if (me === 'student'){
    if (him === 'dean') return 100;
    if (known && him === 'student') return -90;
    if (known && him === 'staff') return 74;
    if (known && him === 'mole') return 62;
    let s = 22;
    harm.forEach(h => {
      const victim = G.players.find(p => p.seat === h.t);
      if (victim && victim.identity === 'dean') s += 26;
      if (victim && victim.identity === 'student' && victim.revealed) s -= 10;
    });
    return Math.max(0, Math.min(100, s));
  }
  // 卧底：先维持平衡，再收尾
  const stu = aliveCount('student'), sta = aliveCount('staff') + 1;
  if (him === 'dean'){
    return (stu >= 2) ? 96 : 40;
  }
  if (known && him === 'student') return (stu > sta) ? 70 : -60;
  if (known && him === 'staff') return (sta > stu) ? 70 : -60;
  return 30;
}
/**
 * 对外用的威胁度：按难度缩放"身份推断"的强度。
 * 已知队友（raw <= -60，比如院方对公开的院长、对已揭示的同阵营）**不缩放** ——
 * "不打自己人"是基本能力，不该随难度变化。
 */
function threat(ai, t){
  const raw = threatRaw(ai, t);
  const w = lv().inference;
  if (w === 1 || raw <= -60) return raw;
  return Math.round(raw * w);
}
function isFriend(ai, t){ return threat(ai, t) < -20; }

/* ---------------- 选择目标 ---------------- */
function pickBestTarget(ai, cands){
  let best = null, bestScore = -999;
  for (const t of cands){
    const s = threat(ai, t) + J() * 1.8 - (t.hp <= 1 ? 6 : 0);
    if (s > bestScore){ bestScore = s; best = t; }
  }
  return best;
}

/* ---------------- 出牌阶段决策 ---------------- */
function scoreCard(ai, card, targets){
  const meta = CARDS[card.name];
  const k = meta.kind;
  const t = targets && targets[0];
  const th = t ? threat(ai, t) : 0;
  const best = (list) => list.reduce((m,x)=>Math.max(m, threat(ai,x)), -999);
  switch (k){
    case 'attack': {
      let s = 70 + th * 0.35;
      if (card.name === '上课点名' && ai.marks && ai.marks.buff) s += 18;
      if (card.name === '公开处刑' && t && t.chained) s += 25;
      if (card.name === '雷同警告' && t && t.chained) s += 20;
      if (t && t.hp <= 1) s += 22;
      return s;
    }
    case 'heal':      return ai.hp < ai.maxHp ? (ai.hp <= 1 ? 140 : 86) : -1;
    case 'buff':      return ai.hand.some(c => D.ATTACK_CARDS.includes(c.name)) ? 74 : 34;
    case 'dodge':     return -1;
    case 'draw2':     return 96;
    case 'harvest':   return 92;
    case 'massHeal': {
      let mineWound = 0, foeWound = 0;
      for (const p of G.players){
        if (!p.alive) continue;
        const w = p.maxHp - p.hp;
        if (threat(ai, p) < 0) mineWound += w; else foeWound += w;
      }
      return mineWound > foeWound ? 78 : 20;
    }
    case 'aoeAttack': {
      const others = G.players.filter(p => p.alive && p !== ai);
      const foes = others.filter(p => threat(ai, p) > 45).length;
      return foes >= 2 ? 88 : (foes === 1 ? 46 : 12);
    }
    case 'dismantle': return t ? 62 + (t.hand.length + countEquips(t)) * 5 + th * 0.15 : -1;
    case 'snatch':    return t ? 76 + th * 0.2 : -1;
    case 'duel':      return t ? (t.hand.length <= 1 ? 92 : 54) + th * 0.2 : -1;
    case 'relay':     return t && t.equips.weapon ? 70 + th * 0.2 : -1;
    case 'fireTalk':  return t && ai.hand.some(c => t.hand.length && c.suit) ? 68 + th * 0.15 : 40;
    case 'chain': {
      const foes = (targets || []).filter(p => threat(ai, p) > 45).length;
      const fire = ai.hand.some(c => CARDS[c.name].dmg === 'fire' || c.name === '公开处刑');
      return fire && foes >= 1 ? 66 : 26;
    }
    case 'delayPlay': return t ? 66 + th * 0.3 : -1;
    case 'delayDraw': return t ? 62 + th * 0.3 : -1;
    case 'lightning': return 34;
    case 'equip': {
      const cur = ai.equips[card.slot];
      if (!cur) return card.slot === 'weapon' ? 88 : 74;
      if (card.slot === 'weapon' && CARDS[card.name].range > CARDS[cur.name].range) return 80;
      if (card.name === '点名册') return 86;
      return 18;
    }
    case 'nullify': return -1;
  }
  return 30;
}
function countEquips(p){ return D.EQUIP_SLOTS.filter(k => p.equips[k]).length; }

function scoreSkill(ai, skill, targets){
  const t = targets && targets[0];
  const th = t ? threat(ai, t) : 0;
  const wounded = G.players.filter(p => p.alive && p.hp < p.maxHp && threat(ai, p) < 0).length;
  switch (skill.name){
    case '吹牛':  return ai.hand.length < 6 ? 84 : 46;
    case '挂科':  return 96 + th * 0.2;
    case '系统':  return t ? 80 + t.hand.length * 4 + th * 0.15 : -1;
    case '窃听':  return t ? 80 + t.hand.length * 4 + th * 0.15 : -1;
    case '奉承':  return ai.hand.length >= 2 ? 72 : 30;
    case '施压':  return 98 + th * 0.2;
    case '解密':  return t ? 78 + th * 0.15 : -1;
    case '概率':  return 76;
    case '共情':  return ai.hp < ai.maxHp ? 88 : (wounded ? 52 : -1);
    case '透析':  return (ai.hand.length + countEquips(ai) >= 4 && wounded) ? 60 : -1;
    case '垂钓':  return ai.hand.length >= 2 ? 80 : -1;
    case '冲锋':  return 100 + th * 0.25;
    case '龙吟':  return t ? 66 + th * 0.2 : -1;
    case '氪金':  return (ai.hand.length + countEquips(ai) >= 4) ? (ai.equips.weapon ? 44 : 74) : -1;
    case '划水':  return 20;
    case '查寝':  return t ? 70 : -1;
    case '侃山':  return 58;
    case '撒娇':  return t && t.hand.length ? 40 : -1;
    case '治愈':  return (ai.hp < ai.maxHp - 1 || wounded) ? 70 : -1;
    case '鸽王':  return 52 + th * 0.2;
  }
  return 20;
}

/* ---------------- 主决策入口 ---------------- */
async function decide(req){
  const me = req.player;
  switch (req.kind){
    case 'playPhase': return decidePlay(me, req);
    case 'choice':    return decideChoice(me, req);
    case 'selectCards': return decideSelectCards(me, req);
    case 'selectTargets': {
      const cands = req.targets || [];
      const best = pickBestTarget(me, cands);
      return { targets: [best].filter(Boolean) };
    }
    case 'selectOption': {
      // 【吹牛】宣言：优先选数量最多的牌名
      const opts = req.options || [];
      const pref = ['上课点名', '代课', '请假条', '通报批评', '小组连坐'];
      let chosen = opts[0];
      for (const p of pref){ const o = opts.find(x => x.key === p); if (o){ chosen = o; break; } }
      return { option: chosen ? chosen.key : (opts[0] && opts[0].key) };
    }
  }
  return {};
}

function decidePlay(me, req){
  const acts = [];
  for (const item of req.playable){
    const card = item.card;
    const meta = CARDS[card.name];
    const targets = window.Engine.validTargets(me, card);
    if (!targets.length && !['aoeAttack','massHeal','harvest','draw2'].includes(meta.kind)){
      if (meta.kind !== 'equip') continue;
    }
    let chosen = null;
    if (meta.kind === 'equip' || meta.kind === 'draw2' || meta.kind === 'harvest' || meta.kind === 'massHeal' || meta.kind === 'lightning'){
      chosen = [];
    } else if (meta.kind === 'aoeAttack'){
      chosen = [];
    } else if (meta.kind === 'chain'){
      const foes = targets.filter(t => t !== me && threat(me, t) > 40);
      chosen = foes.slice(0, 2);
    } else if (meta.kind === 'heal' || meta.kind === 'buff'){
      chosen = [me];
    } else {
      const best = pickBestTarget(me, targets.filter(t => threat(me, t) > -20));
      if (!best) continue;
      chosen = [best];
    }
    const lenBonus = card.type === 'delayed' ? -8 : 0;
    acts.push({ action:{ type:'card', card, targets: chosen }, score: scoreCard(me, card, chosen) + lenBonus + J() });
  }
  // 武器转化技：电风扇 / 粉笔
  for (const s of req.skills){
    if (!s.eqSkill) continue;
    let cost = [], asName, dmg = 'normal', suit = 'C', rank = 8;
    if (s.name === '电风扇·转化'){
      const c = me.hand.find(x => x.name === '上课点名');
      if (!c) continue;
      cost = [c]; asName = '公开处刑'; dmg = 'fire'; suit = c.suit; rank = c.rank;
    } else {
      if (me.hand.length < 2) continue;
      const sorted = me.hand.slice().sort((a,b) => cardValue(a, me) - cardValue(b, me));
      cost = [sorted[0], sorted[1]]; asName = '上课点名'; dmg = 'normal'; suit = sorted[0].suit; rank = sorted[0].rank;
    }
    const fake = { name: asName, kind:'attack' };
    const tg = window.Engine.validTargets(me, fake).filter(t => threat(me, t) > -20);
    if (!tg.length) continue;
    const best = pickBestTarget(me, tg);
    acts.push({ action:{ type:'virtual', cost, asName, dmg, suit, rank, targets:[best] },
      score: 72 + threat(me, best) * 0.3 + J() * 0.8 });
  }
  // 普通技能
  for (const s of req.skills){
    if (s.eqSkill) continue;
    const targets = window.Engine.skillTargets(me, s);
    if (!targets.length) continue;
    let chosen = [];
    if (s.needTarget){
      if (s.healOnly || s.includeSelf){
        const worse = targets.filter(t => t.hp < t.maxHp);
        const pool = worse.length ? worse : targets;
        chosen = [pickBestTarget(me, pool.filter(t => threat(me, t) < 60))];
      } else {
        const pool = targets.filter(t => threat(me, t) > -20);
        if (!pool.length) continue;
        chosen = [pickBestTarget(me, pool)];
      }
      chosen = chosen.filter(Boolean);
      if (!chosen.length) continue;
    }
    acts.push({ action:{ type:'skill', skill:s, targets: chosen }, score: scoreSkill(me, s, chosen) + J() * 0.8 });
  }
  if (!acts.length) return { action:{ type:'end' } };
  acts.sort((a,b) => b.score - a.score);

  // 难度：简单档偶尔"低级失误" —— 一半概率干脆结束阶段，一半概率
  // 从前几个候选里随便挑一个（而不是分最高的那个）。
  // 这是新手最典型的两类失误，比"随机乱打"更像真人。
  const L = lv();
  if (L.mistake > 0 && Math.random() < L.mistake){
    if (Math.random() < 0.5) return { action:{ type:'end' } };
    return acts[Math.floor(Math.random() * Math.min(acts.length, 4))];
  }

  const top = acts[0];
  if (top.score < 34) return { action:{ type:'end' } };
  return top;
}

function decideChoice(me, req){
  const opts = (req.options || []).map(o => o.key);
  const ol = (req.options || []);
  const label = ol.map(o => o.label).join('|');
  const prompt = req.prompt || '';
  const txt = prompt + '|' + label;

  // 濒死救援 / 自救
  if (prompt.includes('救援') || prompt.includes('濒死')){
    const isSelfPrompt = prompt.includes('自救');
    const healCount = me.hand.filter(c => CARDS[c.name].kind === 'heal' || CARDS[c.name].kind === 'buff').length;
    if (opts.includes('card')){
      if (isSelfPrompt){
        // 自救：除非手牌极多，否则一定先保命
        if (healCount > 0) return { option:'card' };
        return { option:'no' };
      }
      const dying = parseDyingTarget(prompt);
      const keep = me.hp <= 1 ? 1 : 0;   // 自己血少时留牌自保
      if (dying && isFriend(me, dying) && healCount > keep) return { option:'card' };
      if (dying && dying.identity === me.identity && healCount > 1) return { option:'card' };
      return { option:'no' };
    }
    if (opts.includes('skill1')){
      if (isSelfPrompt) return { option: me.hand.length > 1 ? 'skill1' : 'no' };
      const dying = parseDyingTarget(prompt);
      if (dying && (isFriend(me, dying) || dying.identity === me.identity) && me.hand.length > 2) return { option:'skill1' };
      return { option:'no' };
    }
    return { option:'no' };
  }

  // 难度：简单档会"漏时机" —— 该打代课/辅导员签字/发动触发技的时候没打出来。
  // 放在濒死处理**之后**：跳过自救等于直接送死，那不像"简单"而像"坏掉"。
  const L = lv();
  if (L.blunder > 0 && opts.includes('no') && Math.random() < L.blunder) return { option:'no' };

  // 代课
  if (opts.includes('card') && label.includes('打出代课')) return { option:'card' };
  if (opts.includes('skill_popi')) return { option:'skill_popi' };
  if (opts.includes('skill_card')){
    // 校园卡：血量低时愿意赌
    return { option: Math.random() < (me.hp <= 2 ? 0.9 : 0.6) ? 'skill_card' : 'no' };
  }
  // 辅导员签字
  if (opts.includes('yes') && label.includes('辅导员签字')){
    const caster = parseCasterSeat(prompt);
    const c = caster !== null ? G.players[caster] : null;
    if (!c) return { option: Math.random() < 0.5 ? 'yes' : 'no' };
    return { option: threat(me, c) > 40 ? 'yes' : 'no' };
  }
  // 炫富 / 兄弟 / 贬低 / 人脉 / 设局 等技能触发
  if (opts.includes('yes')){
    if (txt.includes('炫富')) return { option: me.hand.length >= 2 ? 'yes' : 'no' };
    if (txt.includes('兄弟')){
      const who = parseTargetName(prompt);
      const t = G.players.find(x => x.name === who);
      if (t && isFriend(me, t) && me.hand.length >= 2) return { option:'yes' };
      if (t && threat(me, t) > 60) return { option:'no' };
      return { option: me.hand.length >= 3 ? 'yes' : 'no' };
    }
    if (txt.includes('贬低')) return { option:'yes' };
    if (txt.includes('人脉')){
      const who = parseTargetName(prompt);
      const t = G.players.find(x => x.name === who);
      return { option: (t && isFriend(me, t) && me.hand.length >= 3) ? 'yes' : 'no' };
    }
    if (txt.includes('设局')){
      const who = parseTargetName(prompt);
      const t = G.players.find(x => x.name === who);
      return { option: (t && threat(me, t) > 45 && me.hand.length >= 2) ? 'yes' : 'no' };
    }
    if (txt.includes('红笔') || txt.includes('戒尺') || txt.includes('教鞭')
        || txt.includes('监控摄像头') || txt.includes('激光笔')){
      return { option:'yes' };
    }
    if (label.includes('课堂辩论')) return { option: me.hand.filter(c=>c.name==='上课点名').length >= 2 ? 'yes' : 'no' };
    if (label.includes('随堂测验')) return { option: me.hand.some(c=>c.name==='上课点名') ? 'yes' : 'no' };
    if (label.includes('点名接力')){
      // 拒绝会失去武器：手里有点名就执行
      return { option: me.hand.some(c=>c.name==='上课点名') ? 'yes' : 'no' };
    }
    if (label.includes('拼绩点') && opts.includes('no')) return { option:'yes' };
    if (label.includes('追加救援')) return { option:'yes' };
    // 通用默认
    const noIdx = ol.findIndex(o => o.key === 'no');
    if (noIdx >= 0) return { option:'no' };
    return { option:'yes' };
  }
  if (opts.includes('discard') && opts.includes('draw')){
    const t = parseCasterPlayer(prompt);
    // 激光笔：手牌少就让对方摸
    if (me.hand.length <= 1) return { option:'draw' };
    return { option: threat(me, t) > 40 ? 'discard' : 'draw' };
  }
  if (opts.includes('hand') && opts.includes('table')){
    return { option: Math.random() < 0.55 ? 'hand' : 'table' };
  }
  if (opts.includes('table') && opts.includes('hand')) return { option:'hand' };
  if (opts.includes('yes') && opts.includes('no')) return { option:'yes' };
  return { option: opts[0] };
}
function parseTargetName(prompt){
  const m = prompt.match(/^(?:【[^】]+】)?\s*([一-龥]{2,4})\s*(?:刚刚|即将|即将受到|对你|使用了|打出|指定)/);
  if (m) return m[1];
  const m2 = prompt.match(/([一-龥]{2,4})/);
  return m2 ? m2[1] : '';
}
function parseDyingTarget(prompt){
  const m = prompt.match(/([一-龥]{2,4})\s*(?:仍在濒死|处于濒死|进入濒死|是否救援|的体力)/);
  if (m){ const t = G.players.find(p => p.name === m[1]); if (t) return t; }
  for (const p of G.players) if (prompt.includes(p.name)) return p;
  return null;
}
function parseCasterSeat(prompt){
  for (const p of G.players) if (prompt.includes(p.name)) return p.seat;
  return null;
}
function parseCasterPlayer(prompt){
  for (const p of G.players) if (prompt.includes(p.name)) return p;
  return null;
}

function decideSelectCards(me, req){
  let pool = (req.cards || me.hand).slice();
  if (req.filter) pool = pool.filter(req.filter);
  if (!pool.length) return { cards: [] };
  const min = req.min || 0, max = req.max || 1;
  if (min === 0 && Math.random() < 0.15) return { cards: [] };
  const n = Math.min(max, pool.length);
  // 选自己弃牌：弃价值最低的；若是指定别人手牌，弃价值最高的
  const isFromSelf = req.from === 'self' || !req.owner;
  const sorted = pool.slice().sort((a,b) => {
    const va = cardValue(a, me), vb = cardValue(b, me);
    return isFromSelf ? va - vb : vb - va;
  });
  return { cards: sorted.slice(0, Math.max(min, Math.min(n, min || n))) };
}

/* 小组作业选牌：拿价值最高的 */
function pickShown(me, cards){
  let best = 0, bestV = -1;
  cards.forEach((c, i) => { const v = cardValue(c, me); if (v > bestV){ bestV = v; best = i; } });
  return best;
}
function pickTarget(me, cands){ return pickBestTarget(me, cands); }

window.AI = { decide, pickShown, pickTarget, threat, cardValue, isFriend,
  // 电脑强度（'easy' | 'normal' | 'hard'）
  setLevel, getLevel: () => aiLevel, LEVELS,
  // 测试钩子：AI 是靠正则从**中文提示语**里抠玩家名字的，
  // 改了 engine.js 的文案就可能静默失效。暴露出来让自测能钉住这个耦合。
  _parseTargetName: parseTargetName, _parseDyingTarget: parseDyingTarget };
})();
