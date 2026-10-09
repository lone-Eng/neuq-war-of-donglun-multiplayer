/* =========================================================
 *  东秦杀：点名册  ·  规则自检
 *  在浏览器里点"规则 → 运行自检"，或控制台执行 runSelfTest()
 *  会临时构造测试角色，校验装备/距离/免疫/上限等逻辑，跑完自动还原
 * ========================================================= */
(function(){
'use strict';
const D = window.GameData;
const E = window.Engine;

function fakePlayer(seat, opt){
  opt = opt || {};
  const p = {
    seat: seat,
    char: { name: '测试' + seat, title: '自检角色', hp: 4,
            skills: (opt.skills || []).map(n => ({ name: n, type: '锁定技', text: '' })) },
    identity: 'student', hp: opt.hp || 4, maxHp: 4, alive: true,
    hand: opt.hand || [],
    equips: { weapon: null, armor: null, mountUp: null, mountDown: null },
    judge: [], chained: false, marks: {}, isHuman: false, revealed: false,
    skillsUsedThisTurn: {}, usedCardsThisTurn: [], damageDealtThisTurn: 0,
    usedAttackCardThisPhase: opt.used || 0, skip: {},
    dodgeBan: !!opt.dodgeBan, pointBan: !!opt.pointBan
  };
  if (opt.weapon) p.equips.weapon = mkCard(opt.weapon);
  if (opt.armor) p.equips.armor = mkCard(opt.armor);
  // 坐骑按卡片自己的 slot 落到对应栏位（+1 / −1 是两个独立栏位）
  if (opt.mount){ const c = mkCard(opt.mount); p.equips[c.slot] = c; }
  if (opt.mount2){ const c = mkCard(opt.mount2); p.equips[c.slot] = c; }
  return p;
}
function mkCard(name, suit, rank){
  const m = D.CARDS[name] || {};
  return { uid: 0, name, suit: suit || 'S', rank: rank || 7,
           type: m.type, kind: m.kind, dmg: m.dmg || 'normal',
           slot: m.slot || null, range: m.range || 0, mount: m.mount || null,
           tag: m.tag || null, need: m.need || null };
}

function runSelfTest(){
  const results = [];
  const ok = (name, cond, extra) => results.push({ name, pass: !!cond, extra: extra || '' });
  const savedPlayers = G.players, savedSeat = G.turnSeat;
  try {
    /* ---------- 1. 牌堆构成 ---------- */
    const deck = D.buildDeck();
    const byType = { basic:0, event:0, delayed:0, equip:0 };
    deck.forEach(c => byType[c.type]++);
    ok('牌堆总数 = 160', deck.length === 160, '实际 ' + deck.length);
    ok('基本牌 85 张', byType.basic === 85, '实际 ' + byType.basic);
    ok('事件牌 50 张（非延时42 + 延时8）', byType.event === 42 && byType.delayed === 8,
       '实际 ' + byType.event + ' / ' + byType.delayed);
    ok('装备牌 25 张', byType.equip === 25, '实际 ' + byType.equip);
    const eqCount = {};
    deck.filter(c => c.type === 'equip').forEach(c => eqCount[c.name] = (eqCount[c.name] || 0) + 1);
    ok('点名册 2 张', eqCount['点名册'] === 2, '实际 ' + eqCount['点名册']);
    ok('校园卡 2 张 / 雨衣 2 张', eqCount['校园卡'] === 2 && eqCount['雨衣'] === 2);
    ok('坐骑 7 张', ['电动车','平衡车','共享单车','滑板','电摩','地铁','校车']
        .reduce((n,k) => n + (eqCount[k] || 0), 0) === 7);
    // 装备牌必须有 kind='equip'，否则点击使用会提示"没有合法目标"且无法装备
    const badKind = deck.filter(c => c.type === 'equip' && c.kind !== 'equip').map(c => c.name);
    ok('25 张装备牌均可正常装备（kind=equip）', badKind.length === 0, badKind.join('、'));
    ok('装备牌都能读到栏位 slot', deck.filter(c => c.type === 'equip').every(c => !!c.slot));

    /* ---------- 2. 装备元数据 ---------- */
    const weapons = ['点名册','激光笔','教鞭','试卷','红笔','戒尺','粉笔','黑板擦','监控摄像头','红头文件','电风扇'];
    const expectedRange = { '点名册':1,'激光笔':2,'教鞭':2,'试卷':2,'红笔':3,'戒尺':3,'粉笔':3,'黑板擦':4,'监控摄像头':5,'红头文件':2,'电风扇':4 };
    let rangeOK = true, miss = [];
    weapons.forEach(w => {
      const m = D.CARDS[w];
      if (!m || m.slot !== 'weapon' || m.range !== expectedRange[w]){ rangeOK = false; miss.push(w); }
    });
    ok('11 把武器的栏位与攻击距离正确', rangeOK, miss.join('、'));
    const armors = ['校园卡','学生证','医保卡','雨衣'];
    ok('4 件防具均为 armor 栏位', armors.every(a => D.CARDS[a] && D.CARDS[a].slot === 'armor'));
    const m1 = ['电动车','平衡车','共享单车','滑板'], m2 = ['电摩','地铁','校车'];
    ok('4 匹 +1 坐骑（slot = mountUp）',
       m1.every(x => D.CARDS[x].slot === 'mountUp' && D.CARDS[x].mount === '+1'));
    ok('3 匹 -1 坐骑（slot = mountDown）',
       m2.every(x => D.CARDS[x].slot === 'mountDown' && D.CARDS[x].mount === '-1'));
    ok('+1 与 -1 坐骑占用**不同**栏位（互不顶替）',
       m1.every(x => D.CARDS[x].slot !== D.CARDS[m2[0]].slot));
    ok('装备栏位一共 4 个：武器 / 防具 / +1 坐骑 / -1 坐骑',
       D.EQUIP_SLOTS.length === 4 && D.EQUIP_SLOTS.indexOf('mountUp') >= 0 &&
       D.EQUIP_SLOTS.indexOf('mountDown') >= 0,
       D.EQUIP_SLOTS.join(','));

    /* ---------- 3. 当前对局：角色不重复 ---------- */
    const livePlayers = (G.players || []).filter(p => p.char);
    if (livePlayers.length){
      const ids = livePlayers.map(p => p.char.id);
      ok('当前对局角色不重复（' + livePlayers.length + ' 人）',
         new Set(ids).size === ids.length, ids.join('、'));
    }
    ok('角色库 id 唯一（20 个）',
       new Set(D.CHARACTERS.map(c => c.id)).size === D.CHARACTERS.length);

    /* ---------- 4. 数据完整性 ---------- */
    const missing = Object.keys(D.CARDS).filter(n => !D.CARD_DETAIL[n]);
    ok('每张牌都有长按详情数据', missing.length === 0, missing.join('、'));
    const noKind = Object.keys(D.CARDS).filter(n => !D.CARDS[n].kind);
    ok('所有牌名都有 kind 字段（效果分派依据）', noKind.length === 0, noKind.join('、'));

    /* ---------- 4. 距离与坐骑 ---------- */
    G.turnSeat = 0;
    G.players = [fakePlayer(0), fakePlayer(1), fakePlayer(2), fakePlayer(3)];
    ok('基础距离（隔 1 人）= 2', E.distance(G.players[0], G.players[2]) === 2,
       '实际 ' + E.distance(G.players[0], G.players[2]));
    G.players = [fakePlayer(0), fakePlayer(1), fakePlayer(2, { mount:'电动车' }), fakePlayer(3)];
    ok('目标有 +1 坐骑 → 距离 3', E.distance(G.players[0], G.players[2]) === 3,
       '实际 ' + E.distance(G.players[0], G.players[2]));
    G.players = [fakePlayer(0, { mount:'电摩' }), fakePlayer(1), fakePlayer(2), fakePlayer(3)];
    ok('自己骑 -1 坐骑 → 距离 1', E.distance(G.players[0], G.players[2]) === 1,
       '实际 ' + E.distance(G.players[0], G.players[2]));
    // 两个栏位同时生效：目标既骑 +1 又骑 -1
    G.players = [fakePlayer(0, { mount:'电摩' }), fakePlayer(1),
                 fakePlayer(2, { mount:'电动车', mount2:'地铁' }), fakePlayer(3)];
    ok('+1 与 -1 坐骑可以同时装备',
       !!G.players[2].equips.mountUp && !!G.players[2].equips.mountDown);
    ok('两匹同时装备时修正互相抵消（+1 与 -1 各算一次）',
       E.distance(G.players[0], G.players[2]) === 2,
       '实际 ' + E.distance(G.players[0], G.players[2]));

    // 虎爷【震慑】
    G.players = [fakePlayer(0), fakePlayer(1), fakePlayer(2, { skills:['震慑'] }), fakePlayer(3)];
    ok('虎爷【震慑】使他人看其距离 +1（2 → 3）', E.distance(G.players[0], G.players[2]) === 3,
       '实际 ' + E.distance(G.players[0], G.players[2]));
    // 数学郭【极限】
    G.players = [fakePlayer(0, { skills:['极限'] }), fakePlayer(1), fakePlayer(2, { mount:'电动车', skills:['震慑'] }), fakePlayer(3)];
    ok('数学郭【极限】覆盖全部修正，距离恒为 1', E.distance(G.players[0], G.players[2]) === 1,
       '实际 ' + E.distance(G.players[0], G.players[2]));
    // 鸟爷【观鸟】
    G.players = [fakePlayer(0, { skills:['观鸟'] }), fakePlayer(1), fakePlayer(2), fakePlayer(3)];
    ok('鸟爷【观鸟】使距离 -1（2 → 1）', E.distance(G.players[0], G.players[2]) === 1);

    /* ---------- 5. 防具免疫 ---------- */
    const blackPoint = mkCard('上课点名', 'S', 7);
    const redPoint   = mkCard('上课点名', 'H', 8);
    const fire       = mkCard('公开处刑', 'H', 4);
    const aoeDraw    = mkCard('突击查寝', 'H', 1);

    G.players = [fakePlayer(0), fakePlayer(1, { armor:'学生证' }), fakePlayer(2), fakePlayer(3)];
    ok('学生证：黑色上课点名无效', !!E.isImmuneByCard(G.players[1], blackPoint, G.players[0]));
    ok('学生证：红色上课点名照常生效', !E.isImmuneByCard(G.players[1], redPoint, G.players[0]));
    ok('学生证：挡不住公开处刑（它全红）', !E.isImmuneByCard(G.players[1], fire, G.players[0]));
    // 点名类三者统一之后：雷同警告全黑，所以学生证挡得住它
    const thunder = mkCard('雷同警告', 'S', 4);
    ok('学生证：黑色雷同警告也无效（点名类统一）',
       !!E.isImmuneByCard(G.players[1], thunder, G.players[0]));

    G.players = [fakePlayer(0), fakePlayer(1, { armor:'雨衣' }), fakePlayer(2), fakePlayer(3)];
    ok('雨衣：普通上课点名无效', !!E.isImmuneByCard(G.players[1], blackPoint, G.players[0]));
    ok('雨衣：随堂测验/突击查寝无效', !!E.isImmuneByCard(G.players[1], aoeDraw, G.players[0]));
    ok('雨衣：挡不住公开处刑（且受火焰 +1）', !E.isImmuneByCard(G.players[1], fire, G.players[0]));

    /* ---------- 6. 试卷无视防具 ---------- */
    G.players = [fakePlayer(0, { weapon:'试卷' }), fakePlayer(1, { armor:'雨衣' }), fakePlayer(2), fakePlayer(3)];
    ok('试卷：上课点名无视雨衣', !E.isImmuneByCard(G.players[1], blackPoint, G.players[0]));
    ok('试卷不影响属性点名（雨衣本就不挡公开处刑）', !E.isImmuneByCard(G.players[1], fire, G.players[0]));
    // 点名类统一后，试卷对火/雷同样无视防具
    G.players = [fakePlayer(0, { weapon:'试卷' }), fakePlayer(1, { armor:'学生证' }), fakePlayer(2), fakePlayer(3)];
    ok('试卷：黑色雷同警告也无视学生证（点名类统一）',
       !E.isImmuneByCard(G.players[1], thunder, G.players[0]));
    G.players = [fakePlayer(0, { weapon:'试卷' }), fakePlayer(1, { armor:'学生证' }), fakePlayer(2), fakePlayer(3)];
    ok('试卷：上课点名无视学生证', !E.isImmuneByCard(G.players[1], blackPoint, G.players[0]));
    G.players = [fakePlayer(0), fakePlayer(1, { armor:'学生证' }), fakePlayer(2), fakePlayer(3)];
    ok('（对照组）无试卷时学生证仍然生效', !!E.isImmuneByCard(G.players[1], blackPoint, G.players[0]));

    /* ---------- 7. 点名册解除次数上限 ---------- */
    G.players = [fakePlayer(0, { weapon:'点名册', used:1 }), fakePlayer(1), fakePlayer(2), fakePlayer(3)];
    ok('点名册：已用过 1 张点名牌后仍可使用上课点名',
       E.canUseAttack(G.players[0], { name:'上课点名' }) === true);
    // 点名类三者统一之后，点名册解除的是**整个类别**的上限
    ok('点名册：公开处刑也不受次数限制',
       E.canUseAttack(G.players[0], { name:'公开处刑' }) === true);
    ok('点名册：雷同警告同样不受限制',
       E.canUseAttack(G.players[0], { name:'雷同警告' }) === true);
    G.players = [fakePlayer(0, { used:1 }), fakePlayer(1), fakePlayer(2), fakePlayer(3)];
    ok('（对照组）无点名册时点名类牌已用满', E.canUseAttack(G.players[0], { name:'上课点名' }) === false);
    G.players = [fakePlayer(0, { weapon:'点名册', pointBan:true }), fakePlayer(1), fakePlayer(2), fakePlayer(3)];
    ok('点名册：周志远【吹牛】失败后仍被禁点名',
       E.canUseAttack(G.players[0], { name:'上课点名' }) === false);
    ok('【吹牛】的禁令也覆盖整个点名类（公开处刑同样被禁）',
       E.canUseAttack(G.players[0], { name:'公开处刑' }) === false);

    /* ---------- 8. 攻击范围与手牌上限 ---------- */
    G.players = [fakePlayer(0, { weapon:'监控摄像头' }), fakePlayer(1), fakePlayer(2), fakePlayer(3)];
    ok('攻击范围取自武器（监控摄像头 = 5）', E.attackRange(G.players[0]) === 5);
    G.players = [fakePlayer(0), fakePlayer(1), fakePlayer(2), fakePlayer(3)];
    ok('无武器时攻击范围 = 1', E.attackRange(G.players[0]) === 1);
    G.players = [fakePlayer(0, { hp:3 }), fakePlayer(1), fakePlayer(2), fakePlayer(3)];
    ok('手牌上限 = 当前体力（3）', E.handLimit(G.players[0]) === 3);
    G.players = [fakePlayer(0, { hp:3, skills:['体能'] }), fakePlayer(1), fakePlayer(2), fakePlayer(3)];
    ok('波比【体能】手牌上限 +1（3 → 4）', E.handLimit(G.players[0]) === 4);

    /* ---------- 9. 角色库约束 ---------- */
    ok('角色共 20 名', D.CHARACTERS.length === 20, '实际 ' + D.CHARACTERS.length);
    ok('每名角色最多 2 个技能', D.CHARACTERS.every(c => c.skills.length <= 2));
    ok('角色牌不含阵营字段', D.CHARACTERS.every(c => !c.faction && !c.camp));
    const sexMissing = D.CHARACTERS.filter(c => !E.SEX[c.name]).map(c => c.name);
    ok('性别表覆盖全部角色（激光笔需要）', sexMissing.length === 0, sexMissing.join('、'));

  } finally {
    G.players = savedPlayers;
    G.turnSeat = savedSeat;
    if (window.UI && window.UI.render) window.UI.render();
  }

  /* ---------- 输出 ---------- */
  const fail = results.filter(r => !r.pass);
  const lines = results.map(r =>
    (r.pass ? '✅ ' : '❌ ') + r.name + (!r.pass && r.extra ? '　→ ' + r.extra : ''));
  if (window.console) console.log('%c东秦杀 · 自检报告', 'color:#e8c46a;font-weight:bold', '\n' + lines.join('\n'));

  if (window.UI && window.UI.modal){
    const body = document.createElement('div');
    body.innerHTML = '<div style="font-size:13px;line-height:1.9;font-family:ui-monospace,monospace">' +
      lines.map(l => '<div style="color:' + (l.startsWith('✅') ? '#8fe0a8' : '#ff8a8a') + '">' + l + '</div>').join('') +
      '</div>';
    UI.modal({
      title: '规则自检：' + (fail.length ? fail.length + ' 项失败' : '全部通过') + '（' + results.length + ' 项）',
      desc: fail.length ? '❌ 项目说明装备/规则逻辑存在问题，请把红色行发给开发者。'
                        : '装备、距离、免疫、上限等逻辑均按规则书生效。',
      body,
      actions: [{ label:'关闭', cls:'primary', onClick: () => UI.closeModal() }]
    });
  }
  return { total: results.length, failed: fail.length, results };
}

window.runSelfTest = runSelfTest;
})();
