/* =========================================================
 *  东秦杀：点名席  ·  新手教学局
 * =========================================================
 *
 *  规则书第 10 章有一整套教学材料，但 10.6 那份脚本是给"主持人照着念"的 ——
 *  现实是没人会去读 180KB 的规则书。所以这里做一局**能自己教会你**的引导局：
 *
 *    · 4 人局（最短的完整对局）
 *    · 身份固定：你是学生，目标是打倒院长
 *    · 起手牌固定：点名 / 代课 / 请假条 / 借笔记，四张各教一件事
 *    · 电脑强制**简单**档，不会精准集火把你秒了
 *    · 每个关键节点弹一条提示，说到点子上就收
 *
 *  打完这一局，该会的都会了 —— 比任何文档都有效。
 * ========================================================= */
(function(){
'use strict';

const D = window.GameData;
const E = window.Engine;
const T = {};
window.Tutorial = T;

T.active = false;
T.seen = {};
T.prevLevel = null;

/* ---------------- 提示表 ----------------
 * 每条只在**第一次**遇到时弹一次。trigger 由 ui.js 在关键位置调用 notify()。 */
const STEPS = [
  { id:'open',
    text:'你是<b>学生</b>，目标是把<b>院长</b>打倒。别人的身份都是保密的 —— 包括你旁边那位。' },

  { id:'hand',
    when: (t, p) => t === 'ask' && p.req && p.req.kind === 'playPhase',
    text:'这是你的手牌。<b>金色边框</b>的牌现在能用，点它就使用。长按任意一张牌（电脑上右键）能看到完整说明。' },

  { id:'target',
    when: t => t === 'targeting',
    text:'棋盘上<b>描绿边</b>的角色是合法目标 —— 点他。选完底部会出现一条「出手」操作条。' },

  { id:'respond',
    when: (t, p) => t === 'ask' && p.req && p.req.kind === 'choice'
                     && /代课/.test((p.req.prompt || '') + (p.req.options || []).map(o => o.label).join('')),
    text:'有人点名了你！打出<b>【代课】</b>可以躲掉。硬吃伤害要掉 1 点体力 —— 但有时候留着代课更划算。' },

  // 只认弃牌阶段那一条（engine.js 里写的 '弃牌阶段：请弃置 N 张手牌'）。
  // 别再退回 /弃置/ 这种宽匹配：一大堆技能询问（【鸽王】【轮值】…）都带"弃置"，
  // 那样这条"手牌上限"的提示会抢在技能弃牌时弹出来，说的不在点上。
  { id:'discard',
    when: (t, p) => t === 'ask' && p.req && p.req.kind === 'selectCards'
                     && /弃牌阶段|手牌上限/.test(p.req.prompt || ''),
    text:'手牌不能超过<b>你的当前体力</b> —— 血越少，能存的牌越少。所以把自己打残是很危险的。' },

  { id:'dying',
    when: (t, p) => t === 'ask' && p.req && p.req.kind === 'choice'
                     && /濒死|救援|自救/.test(p.req.prompt || ''),
    text:'有人濒死了。救不救是<b>公开表态</b> —— 谁去救人、谁毫不犹豫地放弃，都会成为别人推理你身份的线索。' },

  { id:'skill',
    when: (t, p) => t === 'ask' && p.req && p.req.kind === 'playPhase'
                     && (p.req.skills || []).length > 0,
    text:'底部亮起的按钮是你的<b>角色技能</b>，每个出牌阶段各能用一次。角色只决定体力和技能，跟胜负无关。' },

  { id:'over',
    when: t => t === 'over',
    text:'这就是这个游戏的全部：<b>猜身份、打对手、藏自己</b>。这一局打得怎么样，结算界面会算给你看。' }
];

/* ---------------- 提示卡 ---------------- */
function bar(){ return document.getElementById('tutorial-bar'); }

/**
 * 卡片显隐会改变 #bottom 的高度，而棋盘（圆桌布局）是按**实测尺寸**摆面板的。
 * 窗口 resize 有监听会自动重摆，这里的高度变化没有任何事件 —— 手动补一发。
 * （ui.js 那个监听自己会判断是不是圆桌，不是就直接返回，所以随便发。）
 */
function relayout(){
  try { window.dispatchEvent(new Event('resize')); } catch (e){ /* 忽略 */ }
}

function showHint(text){
  const b = bar();
  if (!b) return;
  const t = b.querySelector('.tut-text');
  if (t) t.innerHTML = text;
  b.classList.remove('hide');
  // 换了一条提示就把入场动画重放一遍 —— 卡片本来就在那儿，
  // 只悄悄换掉几个字的话，正盯着棋盘的人根本不会注意到。
  b.style.animation = 'none';
  void b.offsetWidth;                 // 强制回流，否则浏览器会合并掉这次改动、动画不重放
  b.style.animation = '';
  relayout();
}
function hideHint(){
  const b = bar();
  if (b) b.classList.add('hide');
  relayout();
}

/** ui.js 在关键位置调用这个。每一条只在第一次遇到时弹。 */
T.notify = function(type, payload){
  if (!T.active) return;
  payload = payload || {};
  for (const s of STEPS){
    if (T.seen[s.id]) continue;
    if (s.when && !s.when(type, payload)) continue;
    T.seen[s.id] = true;
    showHint(s.text);
    return;
  }
};

T.bindBar = function(){
  const b = bar();
  if (!b) return;
  const n = document.getElementById('tut-next');
  if (n) n.addEventListener('click', hideHint);
  const x = document.getElementById('tut-exit');
  if (x) x.addEventListener('click', () => { T.stop(); window.UI.show('start'); });
};

/* ---------------- 开局 ---------------- */

/** 把玩家的身份换成学生（和场上原来是学生的人对调，保证人数配置不变） */
function forcePlayerStudent(){
  const me = G.players[G.humanSeat];
  if (!me || me.identity === 'student') return;
  const stu = G.players.filter(p => p !== me && p.identity === 'student')[0];
  if (!stu) return;
  const tmp = me.identity;
  me.identity = stu.identity;
  stu.identity = tmp;
  // 院长的身份是公开的，跟着一起换
  me.revealed = (me.identity === 'dean');
  stu.revealed = (stu.identity === 'dean');
}

/** 起手牌固定成四张，每张教一件事 */
function scriptHand(){
  const me = G.players[G.humanSeat];
  me.hand = [];
  ['上课点名', '代课', '请假条', '借笔记'].forEach(name => {
    const i = G.deck.findIndex(c => c.name === name);
    if (i >= 0) me.hand.push(G.deck.splice(i, 1)[0]);
  });
  // 院长多给点血：教学局不想两轮就结束
  const dean = G.players.filter(p => p.identity === 'dean')[0];
  if (dean){ dean.maxHp = Math.max(dean.maxHp, 6); dean.hp = dean.maxHp; }
}

T.start = function(){
  T.stop(true);                        // 先清掉上一次
  T.active = true;
  T.seen = {};
  T.prevLevel = window.AI.getLevel ? window.AI.getLevel() : 'normal';
  window.AI.setLevel('easy');          // 教学局：电脑温和

  E.initGame({
    count: 4, mode: 'A', deal: 3, hotseat: false,
    humanSeats: [0], protect: true, networkRule: false
  });
  forcePlayerStudent();

  // 跳过选角界面：直接给玩家第一个候选，其余交给电脑
  const me = G.players[G.humanSeat];
  if (me.charChoices && me.charChoices.length) E.assignRole(me.seat, me.charChoices[0]);
  E.finalizeRoles();
  E.finalizeGame();
  E.dealInitialHands();
  scriptHand();

  window.UI.show('game');
  window.UI.render();
  E.logBig('—— 新手教学局 ——');
  E.log('你是学生，把院长打倒就赢。提示会一步步跟到这里。', 'big');
  T.notify('start', {});

  // 返回整局的 Promise：调用方可以等它跑完（测试就是这么用的）。
  return E.gameLoop().then(() => {
    // 打完了：把 AI 强度还原，但提示条留着让玩家看最后一条
    if (T.prevLevel && window.AI.setLevel) window.AI.setLevel(T.prevLevel);
    E.log('教学局结束 —— 想再来一局可以点「再来一局」，或者退回开始界面选正式对局。', 'sys');
  }, () => {});
};

/**
 * 结束教学。silent = true 时不处理界面（供 start() 内部重入用）。
 */
T.stop = function(silent){
  const was = T.active;
  T.active = false;
  hideHint();
  if (T.prevLevel && window.AI.setLevel) window.AI.setLevel(T.prevLevel);
  T.prevLevel = null;
  return was;
};

})();
