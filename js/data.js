/* =========================================================
 *  东秦杀：点名册  ·  数据层
 *  严格按规则书 v1.0 的卡牌清单与角色库构建（160 张 / 20 角色）
 * ========================================================= */

/* ---------------- 花色与点数 ---------------- */
const SUITS = {
  S: { sym: '♠', color: 'black', name: '黑桃' },
  H: { sym: '♥', color: 'red',   name: '红桃' },
  C: { sym: '♣', color: 'black', name: '梅花' },
  D: { sym: '♦', color: 'red',   name: '方块' }
};
const RANK_LABEL = { 1:'A', 11:'J', 12:'Q', 13:'K' };
function rankLabel(r){ return RANK_LABEL[r] || String(r); }
function suitOf(card){ return SUITS[card.suit]; }
function isRedCard(card){ return SUITS[card.suit].color === 'red'; }
function isBlackCard(card){ return SUITS[card.suit].color === 'black'; }
function cardPoint(card){ return card.rank; }          // A=1, J=11, Q=12, K=13

/* ---------------- 牌名元数据 ----------------
 * type : basic | event | delayed | equip
 * kind : 用于引擎分派的效果种类
 * range: 装备武器的攻击距离
 * slot : 装备栏位 weapon | armor | mountUp | mountDown
 *        （+1 和 −1 坐骑是**两个独立栏位**，可以同时骑，互不顶替）
 * dmg  : 伤害类型 normal | fire | thunder
 * ------------------------------------------------------------------ */
const CARDS = {
  /* ===== 基本牌 ===== */
  '上课点名': { type:'basic', kind:'attack',   desc:'造成1点普通伤害，可被代课抵消', target:'otherInRange' },
  '公开处刑': { type:'basic', kind:'attack',   desc:'造成1点火焰伤害，可被代课抵消', target:'otherInRange', dmg:'fire' },
  '雷同警告': { type:'basic', kind:'attack',   desc:'造成1点雷电伤害，可被代课抵消', target:'otherInRange', dmg:'thunder' },
  '代课':     { type:'basic', kind:'dodge',    desc:'抵消一张点名类牌', target:'none' },
  '代课·补充': { type:'basic', kind:'dodge',   desc:'抵消一张点名类牌（军争篇）', target:'none' },
  '请假条':   { type:'basic', kind:'heal',     desc:'回复1点体力（出牌阶段/濒死）', target:'self' },
  '请假条·补充':{ type:'basic', kind:'heal',   desc:'回复1点体力（军争篇）', target:'self' },
  '红牛':     { type:'basic', kind:'buff',     desc:'下一张点名牌伤害+1；濒死时回复1点', target:'self' },

  /* ===== 非延时事件牌 ===== */
  '通报批评': { type:'event', kind:'dismantle', desc:'弃置目标区域内一张牌', target:'otherAnyZone' },
  '抄作业':   { type:'event', kind:'snatch',    desc:'获得距离1内目标区域内一张牌', target:'otherIn1', tag:'probe' },
  '借笔记':   { type:'event', kind:'draw2',     desc:'摸两张牌', target:'self' },
  '课堂辩论': { type:'event', kind:'duel',      desc:'轮流打上课点名，先不出者受1点伤害', target:'other' },
  '随堂测验': { type:'event', kind:'aoeAttack', desc:'全体须打上课点名，否则受1点伤害', target:'allOthers', need:'上课点名', dmg:'normal' },
  '突击查寝': { type:'event', kind:'aoeAttack', desc:'全体须打代课，否则受1点伤害', target:'allOthers', need:'代课', dmg:'normal' },
  '辅导员签字':{ type:'event', kind:'nullify',  desc:'在一张牌生效时抵消它', target:'anyCard' },
  '点名接力': { type:'event', kind:'relay',     desc:'令有武器的角色对指定角色上课点名，否则你获得其武器', target:'otherWithWeapon' },
  '小组作业': { type:'event', kind:'harvest',   desc:'亮出X张牌，每人依次选一张', target:'all' },
  '放假通知': { type:'event', kind:'massHeal',  desc:'所有角色回复1点体力', target:'all' },
  '当面约谈': { type:'event', kind:'fireTalk',  desc:'目标亮一张手牌，你弃同花色牌造成1点火焰伤害', target:'otherWithHand' },
  '小组连坐': { type:'event', kind:'chain',     desc:'横置/重置1-2名角色，或重铸', target:'anyPlayers' },

  /* ===== 延时事件牌 ===== */
  '手机没电': { type:'delayed', kind:'delayPlay',  desc:'查考勤非♥则跳过出牌阶段', target:'other', tag:'probe' },
  '饭卡没钱': { type:'delayed', kind:'delayDraw',  desc:'查考勤非♣则跳过摸牌阶段', target:'otherIn1' },
  '论文查重': { type:'delayed', kind:'lightning',  desc:'查考勤♠2-9则受3点雷电伤害，否则移到下家', target:'self' },

  /* ===== 装备 · 武器 ===== */
  '点名册':     { type:'equip', slot:'weapon', range:1, desc:'出牌阶段可使用任意张点名类牌' },
  '激光笔':     { type:'equip', slot:'weapon', range:2, desc:'点名类牌指定异性后，其弃1张牌或你摸1张' },
  '教鞭':       { type:'equip', slot:'weapon', range:2, desc:'点名类牌造成伤害时，可改为弃目标两张牌' },
  '试卷':       { type:'equip', slot:'weapon', range:2, desc:'锁定技：点名类牌无视目标防具' },
  '红笔':       { type:'equip', slot:'weapon', range:3, desc:'点名类牌被代课抵消时，可弃两张牌令伤害照常' },
  '戒尺':       { type:'equip', slot:'weapon', range:3, desc:'点名类牌被代课抵消时，可再对其使用一张上课点名' },
  '粉笔':       { type:'equip', slot:'weapon', range:3, desc:'可将两张手牌当一张上课点名使用或打出' },
  '黑板擦':     { type:'equip', slot:'weapon', range:4, desc:'点名类牌为最后一张手牌时，可额外指定至多两个目标' },
  '监控摄像头': { type:'equip', slot:'weapon', range:5, desc:'点名类牌造成伤害时，可弃置目标一匹坐骑' },
  '红头文件':   { type:'equip', slot:'weapon', range:2, desc:'锁定技：点名类牌对无手牌目标伤害+1' },
  '电风扇':     { type:'equip', slot:'weapon', range:4, desc:'可将一张上课点名当公开处刑使用' },

  /* ===== 装备 · 防具 ===== */
  '校园卡': { type:'equip', slot:'armor', desc:'需要代课时可查考勤，红色则视为打出代课' },
  '学生证': { type:'equip', slot:'armor', desc:'锁定技：黑色点名类牌对你无效' },
  '医保卡': { type:'equip', slot:'armor', desc:'锁定技：受到伤害最多受1点；失去时回复1点体力' },
  '雨衣':   { type:'equip', slot:'armor', desc:'锁定技：上课点名/随堂测验/突击查寝无效；火焰伤害+1' },

  /* ===== 装备 · 坐骑 =====
     +1 和 −1 是**两个独立栏位**：可以同时骑一匹 +1 和一匹 −1，
     装第二匹 +1 只会顶掉第一匹 +1，不会碰你的 −1。 */
  '电动车':   { type:'equip', slot:'mountUp',   mount:'+1', desc:'其他角色计算与你的距离+1' },
  '平衡车':   { type:'equip', slot:'mountUp',   mount:'+1', desc:'其他角色计算与你的距离+1' },
  '共享单车': { type:'equip', slot:'mountUp',   mount:'+1', desc:'其他角色计算与你的距离+1' },
  '滑板':     { type:'equip', slot:'mountUp',   mount:'+1', desc:'其他角色计算与你的距离+1' },
  '电摩':     { type:'equip', slot:'mountDown', mount:'-1', desc:'你计算与其他角色的距离-1' },
  '地铁':     { type:'equip', slot:'mountDown', mount:'-1', desc:'你计算与其他角色的距离-1' },
  '校车':     { type:'equip', slot:'mountDown', mount:'-1', desc:'你计算与其他角色的距离-1' }
};

/* 装备栏位。全项目**只用这一份**，别再各处手写数组 ——
   加栏位时漏掉一处就会出"牌装上了但界面不显示"这类怪 bug。 */
const EQUIP_SLOTS = ['weapon', 'armor', 'mountUp', 'mountDown'];
const SLOT_NAME = { weapon:'武器', armor:'防具', mountUp:'+1 坐骑', mountDown:'-1 坐骑' };

/* 装备牌统一补上 kind:'equip'
 * —— UI 与引擎用 kind 分派效果（meta.kind === 'equip'），若缺失会导致装备牌无法装备 */
Object.keys(CARDS).forEach(n => {
  if (CARDS[n].type === 'equip' && !CARDS[n].kind) CARDS[n].kind = 'equip';
});

/* ---------------- 牌堆清单（严格逐张，共 160 张） ---------------- */
const DECK_SPEC = [
  { name:'上课点名', cards:{ S:[7,8,8,9,9,10,10], H:[10,10,11], C:[2,3,4,5,6,7,8,8,9,9,10,10,11,11], D:[6,7,8,9,10,13] } }, // 30
  { name:'代课',     cards:{ H:[2,2,13], D:[2,2,3,4,5,6,7,8,9,10,11,11] } },                                                      // 15（含勘误E-2补的♦7）
  { name:'请假条',   cards:{ H:[3,4,7,8,9,12,12], D:[12] } },                                                                    // 8
  { name:'公开处刑', cards:{ H:[4,7,10], D:[4,5] } },                                                                            // 5
  { name:'雷同警告', cards:{ S:[4,5,6,7,8], C:[5,6,7,8] } },                                                                     // 9
  { name:'红牛',     cards:{ S:[3,9], C:[3,9], D:[9] } },                                                                        // 5
  { name:'代课·补充', cards:{ H:[8,9,11,12], D:[6,7,8,10,11] } },                                                                // 9
  { name:'请假条·补充',cards:{ H:[5,6,12], D:[2] } },                                                                            // 4

  { name:'通报批评', cards:{ S:[3,4,12], H:[12], C:[3,4] } },                                     // 6
  { name:'抄作业',   cards:{ S:[3,4,11], D:[3,4] } },                                             // 5
  { name:'借笔记',   cards:{ H:[7,8,9,11] } },                                                    // 4
  { name:'课堂辩论', cards:{ S:[1], C:[1], D:[1] } },                                             // 3
  { name:'随堂测验', cards:{ S:[7,13], C:[7] } },                                                 // 3
  { name:'辅导员签字',cards:{ S:[11], C:[12,13,13], H:[1,13] } },                                  // 6（♣K 两张）
  { name:'点名接力', cards:{ C:[12,13] } },                                                       // 2
  { name:'小组作业', cards:{ H:[3,4] } },                                                         // 2
  { name:'突击查寝', cards:{ H:[1] } },                                                           // 1
  { name:'放假通知', cards:{ H:[1] } },                                                           // 1
  { name:'当面约谈', cards:{ H:[2,3], D:[12] } },                                                 // 3
  { name:'小组连坐', cards:{ S:[11,12], C:[10,11,12,13] } },                                      // 6

  { name:'手机没电', cards:{ H:[6], S:[6], C:[6] } },                                             // 3
  { name:'论文查重', cards:{ S:[1,12], H:[12] } },                                                // 3
  { name:'饭卡没钱', cards:{ S:[10], C:[4] } },                                                   // 2

  { name:'点名册',   cards:{ D:[1], C:[1] } },   // 2
  { name:'激光笔',   cards:{ S:[2] } },          // 1
  { name:'教鞭',     cards:{ S:[2] } },          // 1
  { name:'试卷',     cards:{ S:[6] } },          // 1
  { name:'红笔',     cards:{ D:[5] } },          // 1
  { name:'戒尺',     cards:{ S:[5] } },          // 1
  { name:'粉笔',     cards:{ S:[12] } },         // 1
  { name:'黑板擦',   cards:{ D:[12] } },         // 1
  { name:'监控摄像头',cards:{ H:[5] } },          // 1
  { name:'红头文件', cards:{ S:[1] } },          // 1
  { name:'电风扇',   cards:{ D:[1] } },          // 1

  { name:'校园卡', cards:{ S:[2], C:[2] } },     // 2
  { name:'学生证', cards:{ C:[2] } },            // 1
  { name:'医保卡', cards:{ C:[1] } },            // 1
  { name:'雨衣',   cards:{ S:[2], C:[2] } },     // 2

  { name:'电动车',   cards:{ S:[5] } },          // 1
  { name:'平衡车',   cards:{ H:[13] } },         // 1
  { name:'共享单车', cards:{ C:[5] } },          // 1
  { name:'滑板',     cards:{ D:[13] } },         // 1
  { name:'电摩',     cards:{ H:[5] } },          // 1
  { name:'地铁',     cards:{ S:[13] } },         // 1
  { name:'校车',     cards:{ D:[13] } }          // 1
];

let _uid = 0;
function buildDeck(){
  const deck = [];
  for (const spec of DECK_SPEC){
    const meta = CARDS[spec.name];
    for (const s of Object.keys(spec.cards)){
      for (const r of spec.cards[s]){
        deck.push({
          uid: ++_uid,
          name: spec.name,
          suit: s,
          rank: r,
          type: meta.type,
          kind: meta.kind,
          dmg: meta.dmg || 'normal',
          slot: meta.slot || null,
          range: meta.range || 0,
          tag: meta.tag || null,
          need: meta.need || null
        });
      }
    }
  }
  return deck; // 共 160 张
}

/* ---------------- 身份 ---------------- */
const IDENTITIES = {
  dean:    { key:'dean',    name:'院长', faction:'院方', cls:'dean',
             win:'消灭所有学生与卧底', desc:'身份公开，体力上限+1。你的目标是清场。' },
  staff:   { key:'staff',   name:'教务', faction:'院方', cls:'staff',
             win:'保护院长，消灭学生与卧底', desc:'院长死亡则全盘皆输；院长存活清场则共同获胜。' },
  student: { key:'student', name:'学生', faction:'学生', cls:'student',
             win:'击败院长', desc:'院长死亡即达成目标，不要求自己存活。' },
  mole:    { key:'mole',    name:'卧底', faction:'独立', cls:'mole',
             win:'院长死亡时成为唯一存活者', desc:'先让别人杀掉院长，再让自己活到最后。' }
};
const IDENTITY_CONFIG = {
  4: { dean:1, staff:1, student:1, mole:1 },
  5: { dean:1, staff:1, student:2, mole:1 },
  6: { dean:1, staff:1, student:3, mole:1 },
  7: { dean:1, staff:2, student:3, mole:1 },
  8: { dean:1, staff:2, student:4, mole:1 }
};

/* ---------------- 角色库（20 名，不绑定阵营） ---------------- */
const CHARACTERS = [
  { id:'R-01', name:'周志远', title:'政治老师·吹牛真人', hp:4,
    skills:[
      { name:'吹牛', type:'主动技', text:'出牌阶段限一次：宣言一种牌名并摸一张牌；若未宣言中，本回合不能使用点名类牌。' },
      { name:'正义', type:'锁定技', text:'你受到伤害时，若伤害来源手牌数大于你，伤害-1。' }
    ]},
  { id:'R-02', name:'王磊', title:'计算机老师·代码判官', hp:3,
    skills:[
      { name:'贬低', type:'触发技', text:'其他角色使用"代课"时，你可弃一张牌令其无效（每回合限一次）。' },
      { name:'挂科', type:'主动技', text:'出牌阶段限一次：对一名其他角色造成1点伤害，然后其摸一张牌。' }
    ]},
  { id:'R-03', name:'董昌程', title:'系统课老师·幕后黑手', hp:4,
    skills:[
      { name:'设局', type:'触发技', text:'一名角色摸牌后，你可弃两张牌令其跳过出牌阶段（每回合限一次）。' },
      { name:'系统', type:'主动技', text:'出牌阶段限一次：观看一名角色手牌并弃置其中一张。' }
    ]},
  { id:'R-04', name:'李心瑶', title:'辅导员·双面评优', hp:3,
    skills:[
      { name:'奉承', type:'主动技', text:'出牌阶段限一次：交给一名其他角色一张手牌，摸两张牌。' },
      { name:'施压', type:'主动技', text:'出牌阶段限一次：对一名其他角色造成1点伤害，其本回合不能使用"代课"。' }
    ]},
  { id:'R-05', name:'史鉴明', title:'院长·密码宗师', hp:5,
    skills:[
      { name:'加密', type:'锁定技', text:'你的手牌不能被观看或弃置（不能被指定手牌区）。' },
      { name:'解密', type:'主动技', text:'出牌阶段限一次：弃一张牌，获得一名其他角色一张随机手牌。' }
    ]},
  { id:'R-06', name:'数学郭', title:'数学老师·极限求真', hp:3,
    skills:[
      { name:'极限', type:'锁定技', text:'你计算与其他角色的距离时始终视为1。' },
      { name:'概率', type:'主动技', text:'出牌阶段限一次：查考勤，红色摸两张牌，黑色摸一张牌。' }
    ]},
  { id:'R-07', name:'宋美丽', title:'心理老师·美丽心灵', hp:3,
    skills:[
      { name:'共情', type:'主动技', text:'出牌阶段限一次：令一名体力未满的**其他**角色回复1点，你摸一张牌。' },
      { name:'鼓励', type:'触发技', text:'一名角色濒死时，你可弃一张手牌，令其回复1点体力。' }
    ]},
  { id:'R-08', name:'肾小球', title:'生物老师·滤过万物', hp:4,
    skills:[
      { name:'过滤', type:'锁定技', text:'每回合你首次受到的非属性伤害-1。' },
      { name:'透析', type:'主动技', text:'出牌阶段限一次：弃两张牌，令一名体力未满的角色回复1点并摸一张。' }
    ]},
  { id:'R-09', name:'钓鱼老', title:'后勤保安·愿者上钩', hp:4,
    skills:[
      { name:'垂钓', type:'主动技', text:'出牌阶段限一次：将一张手牌置于牌堆顶，摸两张牌。' },
      { name:'摸鱼', type:'锁定技', text:'回合结束若你未造成伤害，摸一张牌。' }
    ]},
  { id:'R-10', name:'夜露', title:'神秘学生·夜露无声', hp:3,
    skills:[
      { name:'潜行', type:'锁定技', text:'你不能成为"探查"类牌（抄作业、手机没电）的目标。' },
      { name:'窃听', type:'主动技', text:'出牌阶段限一次：观看一名角色手牌并弃置其中一张。' }
    ]},
  { id:'R-11', name:'董旭', title:'学生·旭日初升', hp:4,
    skills:[
      { name:'热血', type:'锁定技', text:'出牌阶段第一张点名类牌伤害+1。' },
      { name:'冲锋', type:'主动技', text:'出牌阶段限一次：弃一张牌，视为使用一张"上课点名"。' }
    ]},
  { id:'R-12', name:'董启龙', title:'学生·启龙在天', hp:4,
    skills:[
      { name:'龙吟', type:'主动技', text:'出牌阶段限一次：令一名角色摸一张牌，其本回合不能使用"代课"。' },
      { name:'兄弟', type:'触发技', text:'一名其他角色受伤时，你可弃一张牌令伤害-1（每回合限一次）。' }
    ]},
  { id:'R-13', name:'王三金', title:'学生·三金战甲', hp:4,
    skills:[
      { name:'氪金', type:'主动技', text:'出牌阶段限一次：弃两张牌，亮牌堆直到出现装备牌并获得之。' },
      { name:'炫富', type:'触发技', text:'一名角色对你使用牌时，你可弃一张牌，令其摸一张牌并取消此牌（每轮限一次）。' }
    ]},
  { id:'R-14', name:'方三水', title:'学生·三水归一', hp:3,
    skills:[
      { name:'水课', type:'锁定技', text:'你跳过出牌阶段时，或出牌阶段一张牌都没出就结束时，摸两张牌。' },
      { name:'划水', type:'主动技', text:'出牌阶段限一次：交给一名角色一张手牌，其本回合不能对你使用牌，然后你摸一张牌。' }
    ]},
  { id:'R-15', name:'虎爷', title:'宿管·虎啸宿舍', hp:4,
    skills:[
      { name:'查寝', type:'主动技', text:'出牌阶段限一次：观看一名角色手牌，若其有装备牌，弃置其中一张。' },
      { name:'震慑', type:'锁定技', text:'其他角色计算与你的距离+1。' }
    ]},
  { id:'R-16', name:'京爷', title:'京腔老师·局气侃爷', hp:3,
    skills:[
      { name:'侃山', type:'主动技', text:'出牌阶段限一次：与一名角色拼绩点，赢摸两张牌，输其摸一张牌。' },
      { name:'人脉', type:'触发技', text:'一名角色使用事件牌时，你可弃一张牌，令其额外摸一张牌（每回合限一次）。' }
    ]},
  { id:'R-17', name:'奶扣', title:'学生·奶扣甜甜', hp:3,
    skills:[
      { name:'撒娇', type:'主动技', text:'出牌阶段限一次：令一名角色交给你一张手牌，然后你交给其一张手牌，并摸一张牌。' },
      { name:'治愈', type:'主动技', text:'出牌阶段限一次：弃一张牌，令一名体力未满的角色回复1点体力。' }
    ]},
  { id:'R-18', name:'鸟爷', title:'校园鸽王·观鸟社荣誉社长', hp:4,
    skills:[
      { name:'鸽王', type:'主动技', text:'出牌阶段限一次：弃一张手牌，令一名其他角色跳过其下一个摸牌阶段。' },
      { name:'观鸟', type:'锁定技', text:'你计算与其他角色的距离时始终-1。' }
    ]},
  { id:'R-19', name:'波比', title:'健身达人·波比跳之王', hp:4,
    skills:[
      { name:'波比跳', type:'触发技', text:'你需要使用或打出"代课"时，可弃一张手牌视为打出代课（每回合限一次）。' },
      { name:'体能', type:'锁定技', text:'你的手牌上限+1。' }
    ]},
  { id:'R-20', name:'董伦', title:'轮值学委·伦理课代表', hp:3,
    skills:[
      { name:'轮值', type:'触发技', text:'回合开始时，你可以摸一张牌，然后弃置一张牌。' },
      { name:'伦理', type:'锁定技', text:'你不能成为"课堂辩论"的目标；其他角色使用事件牌指定你为目标时，你摸一张牌。' }
    ]}
];
const CHARACTER_BY_NAME = {};
CHARACTERS.forEach(c => CHARACTER_BY_NAME[c.name] = c);

/* 技能名 → 角色名 反查 */
const SKILL_OWNER = {};
CHARACTERS.forEach(c => c.skills.forEach(s => SKILL_OWNER[s.name] = c.name));

/* ---------------- 卡牌详细说明（长按查看） ----------------
 * effect 效果 / limit 限制 / order 结算顺序 / target 目标 / dist 距离
 * ------------------------------------------------------------ */
const CARD_DETAIL = {
  '上课点名': { target:'攻击范围内一名其他角色', dist:'你的攻击范围', effect:'造成 1 点普通伤害。',
    limit:'每出牌阶段点名类牌（上课点名/公开处刑/雷同警告）合计限用 1 张；装备【点名册】后"上课点名"不限张数。',
    order:'①检查次数与范围 →②指定目标 →③使用后触发窗口 →④目标可打出"代课" →⑤伤害结算（含减伤/濒死）→⑥牌入弃牌堆。' },
  '公开处刑': { target:'攻击范围内一名其他角色', dist:'你的攻击范围', effect:'造成 1 点火焰伤害（属性伤害，会触发横置传导）。',
    limit:'计入点名类牌每回合 1 张的上限；对"雨衣"目标伤害 +1。',
    order:'同上，伤害类型改为火焰。' },
  '雷同警告': { target:'攻击范围内一名其他角色', dist:'你的攻击范围', effect:'造成 1 点雷电伤害（属性伤害，会触发横置传导）。',
    limit:'计入点名类牌上限；注意：它不是"上课点名"，学生证/雨衣都挡不住。',
    order:'同上，伤害类型改为雷电。' },
  '代课': { target:'无（响应自身）', dist:'—', effect:'当你成为点名类牌的目标时打出，抵消该牌。',
    limit:'只能响应，不能主动使用；被王磊【贬低】可令其无效。', order:'①响应窗口声明打出 →②抵消该点名牌 →③入弃牌堆。' },
  '代课·补充': { target:'无（响应自身）', dist:'—', effect:'效果同【代课】。', limit:'同【代课】。', order:'同【代课】。' },
  '请假条': { target:'自己', dist:'—', effect:'回复 1 点体力；濒死时也可使用。',
    limit:'出牌阶段使用时你的体力必须未满；濒死用法不限次数。', order:'①声明 →②校验时机 →③回复 1 点 →④入弃牌堆。' },
  '请假条·补充': { target:'自己', dist:'—', effect:'效果同【请假条】。', limit:'同【请假条】。', order:'同【请假条】。' },
  '红牛': { target:'自己', dist:'—', effect:'获得 1 层增益标记，本回合下一张点名类牌伤害 +1；濒死时可当请假条使用回复 1 点。',
    limit:'每出牌阶段限用 1 张；增益可叠加，每张点名牌消耗 1 层（即使被代课抵消也会消耗）。',
    order:'①声明 →②获得增益层 →③入弃牌堆 →④下一张点名牌伤害 +1。' },
  '通报批评': { target:'区域内（手牌/装备/通知栏）有牌的一名其他角色', dist:'—', effect:'弃置该角色区域内 1 张牌。',
    limit:'指定手牌区时由目标随机给出 1 张，不能指定具体手牌；【加密】使你不能指定其手牌区。', order:'①指定区域 →②响应窗口 →③弃置 1 张 →④入弃牌堆。' },
  '抄作业': { target:'距离 1 以内、区域内有牌的一名其他角色', dist:'≤1', effect:'获得该角色区域内 1 张牌。',
    limit:'【探查类牌】：不能指定夜露；不能取走【加密】角色的手牌区。', order:'①检查距离 →②响应窗口 →③你获得该牌 →④入弃牌堆。' },
  '借笔记': { target:'自己', dist:'—', effect:'摸两张牌。', limit:'无。', order:'①响应窗口 →②摸 2 张 →③入弃牌堆。' },
  '课堂辩论': { target:'一名其他角色', dist:'—', effect:'由目标先开始，双方轮流打出"上课点名"，先不出者受到 1 点伤害。',
    limit:'董伦【伦理】使其不能成为本牌目标；打出的点名不占每回合次数上限。', order:'①指定目标 →②目标先打出 →③交替直到一方不出 →④不出者受 1 点伤害。' },
  '随堂测验': { target:'所有其他角色', dist:'—', effect:'每名目标须打出 1 张"上课点名"，否则受到 1 点伤害。',
    limit:'雨衣可免疫；逐目标结算，可对单个目标使用辅导员签字。', order:'①锁定全体 →②逐个目标询问 →③未打出者受伤 →④入弃牌堆。' },
  '突击查寝': { target:'所有其他角色', dist:'—', effect:'每名目标须打出 1 张"代课"，否则受到 1 点伤害。',
    limit:'雨衣可免疫；逐个结算。', order:'同上，响应牌改为代课。' },
  '辅导员签字': { target:'一张正在生效的牌', dist:'—', effect:'抵消该牌的效果。',
    limit:'**时机**：普通事件牌在使用时问；群体牌（随堂测验 / 突击查寝）对**每个目标分别**问一次，抵消某一个目标不影响其他人；延时牌（手机没电 / 饭卡没钱 / 论文查重）要等到回合开始查考勤、**翻开抽签牌之前**问，放置时不问（跟闪电一样：翻开了就只剩改判窗口）。不能抵消已结算完毕的牌；可被另一张辅导员签字再抵消（对抗链最多 3 层）；基本牌与装备牌本身不能抵消。',
    order:'①在目标牌生效的窗口声明 →②指定被抵消牌 →③若被再抵消则原牌继续结算 →④入弃牌堆。' },
  '点名接力': { target:'一名装备了武器的其他角色', dist:'—', effect:'令其对指定角色使用"上课点名"；若不执行，你获得其武器。',
    limit:'目标无武器时不能指定；手中没有"上课点名"时视为无法执行。', order:'①指定目标与第三者 →②响应窗口 →③执行或拒绝 →④拒绝则武器转移。' },
  '小组作业': { target:'所有存活角色', dist:'—', effect:'亮出牌堆顶 X 张（X=存活人数），从你开始依次选 1 张获得，剩余弃置。',
    limit:'亮出的牌全部明置。', order:'①亮 X 张 →②从你开始按座位顺序选牌 →③剩余入弃牌堆。' },
  '放假通知': { target:'所有角色', dist:'—', effect:'每名角色回复 1 点体力（已满者不回复）。', limit:'对已死亡角色无效。', order:'①响应窗口 →②按顺序逐人回复 1 点。' },
  '当面约谈': { target:'一名有手牌的其他角色', dist:'—', effect:'目标展示 1 张手牌；你可弃 1 张同花色手牌，对其造成 1 点火焰伤害。',
    limit:'【探查类牌】：【加密】角色不能被指定；你不需要展示自己的手牌。', order:'①目标展示 →②你决定是否弃同花色牌 →③若弃则造成火焰伤害。' },
  '小组连坐': { target:'1–2 名角色，或重铸', dist:'—', effect:'横置或重置 1–2 名角色；或重铸（弃置并摸 1 张）。',
    limit:'处于横置的角色受到属性伤害后会解除并向其他横置角色传导。', order:'①选择用法 →②指定目标 →③施加/解除横置 或 重铸。' },
  '手机没电': { target:'一名其他角色', dist:'—', effect:'置于其通知栏；其查考勤阶段翻开抽签牌，若不为 ♥ 则跳过出牌阶段。',
    limit:'【探查类牌】：不能指定夜露；每出牌阶段延时牌合计限 1 张。', order:'①指定目标 →②置于通知栏 →③其查考勤阶段判定 →④本牌与抽签牌入弃牌堆。' },
  '饭卡没钱': { target:'距离 1 以内的一名其他角色', dist:'≤1', effect:'置于其通知栏；查考勤抽签牌若不为 ♣ 则跳过摸牌阶段（机制等同兵粮寸断）。',
    limit:'距离 >1 不能指定。', order:'同【手机没电】。' },
  '论文查重': { target:'自己', dist:'—', effect:'置于自己通知栏；查考勤抽签牌为 ♠2–♠9 时受到 3 点雷电伤害，否则移动到下家通知栏。',
    limit:'命中概率 25/160 = 15.6%；移动不算"使用"，不触发成为目标类技能；被辅导员签字抵消时**不做判定、直接移交下家**（跟闪电一样：它不是"消失"，是"转移"）。',
    order:'①置于自己通知栏 →②查考勤先问辅导员签字 →③没人抵消才翻抽签牌 →④命中受伤，本牌入弃牌堆；否则移交下一位存活角色 →⑤被抵消则不翻牌、不判定，直接移交下一位存活角色。' },
  '点名册': { target:'装备到武器栏', dist:'攻击范围 1', effect:'出牌阶段你可以使用任意张点名类牌。',
    limit:'解除的是整个点名类（上课点名 / 公开处刑 / 雷同警告）的每回合 1 张上限。', order:'装备后持续生效。' },
  '激光笔': { target:'装备到武器栏', dist:'攻击范围 2', effect:'点名类牌指定异性角色为目标后，可令其弃 1 张手牌或让你摸 1 张。',
    limit:'对同性目标不触发；由你选择是否发动。', order:'指定目标后、代课响应前结算。' },
  '教鞭': { target:'装备到武器栏', dist:'攻击范围 2', effect:'上课点名造成伤害时，可防止此伤害，改为弃置目标两张牌。',
    limit:'目标区域内牌不足 2 张时弃光可弃之牌；被代课抵消时不触发。', order:'命中后、伤害结算前选择。' },
  '试卷': { target:'装备到武器栏', dist:'攻击范围 2', effect:'锁定技：你使用点名类牌时无视目标防具。',
    limit:'只无视防具，对坐骑与技能（如潜行）无效。', order:'恒定生效。' },
  '红笔': { target:'装备到武器栏', dist:'攻击范围 3', effect:'点名类牌被"代课"抵消时，可弃两张牌令其依然造成伤害。',
    limit:'必须一次弃满 2 张（可弃装备区）。', order:'目标打出代课后立即询问。' },
  '戒尺': { target:'装备到武器栏', dist:'攻击范围 3', effect:'上课点名被"代课"抵消时，可对同一目标再使用一张"上课点名"。',
    limit:'每回合限触发一次；需要手中有点名。', order:'被抵消后立即结算。' },
  '粉笔': { target:'装备到武器栏', dist:'攻击范围 3', effect:'你可以将两张手牌当一张"上课点名"使用或打出。',
    limit:'计入点名类牌次数上限。', order:'点【粉笔·转化】按钮，选两张牌后进入目标选择。' },
  '黑板擦': { target:'装备到武器栏', dist:'攻击范围 4', effect:'你使用"上课点名"时，若为最后一张手牌，可额外指定至多 2 个目标。',
    limit:'必须是使用瞬间的最后一张手牌。', order:'每个目标独立进行代课响应。' },
  '监控摄像头': { target:'装备到武器栏', dist:'攻击范围 5', effect:'上课点名造成伤害时，可弃置目标的一匹坐骑。',
    limit:'目标没有坐骑时不能发动。', order:'伤害成立后结算。' },
  '红头文件': { target:'装备到武器栏', dist:'攻击范围 2', effect:'锁定技：你使用"上课点名"造成伤害时，若目标没有手牌，伤害 +1。',
    limit:'检查时机为伤害结算开始时。', order:'恒定生效。' },
  '电风扇': { target:'装备到武器栏', dist:'攻击范围 4', effect:'你可以将一张普通"上课点名"当"公开处刑"使用。',
    limit:'转换后伤害类型变为火焰，会被雨衣 +1。', order:'点【电风扇·转化】按钮，选一张点名后进入目标选择。' },
  '校园卡': { target:'装备到防具栏', dist:'—', effect:'需要打出"代课"时可先查考勤：抽签牌为红色（49.4%）则视为打出一张代课。',
    limit:'判定失败后仍可继续用手牌中的代课响应。', order:'代课响应窗口内发动。' },
  '学生证': { target:'装备到防具栏', dist:'—', effect:'锁定技：黑色的点名类牌对你无效。',
    limit:'只挡黑色；公开处刑全红、上课点名红黑都有、雷同警告全黑 —— 所以它挡得住雷同警告，挡不住公开处刑。技能伤害不受影响。', order:'恒定生效。' },
  '医保卡': { target:'装备到防具栏', dist:'—', effect:'锁定技：你每次受到伤害最多只受 1 点；失去本装备时回复 1 点体力。',
    limit:'对 1 点伤害无额外效果。', order:'恒定生效。' },
  '雨衣': { target:'装备到防具栏', dist:'—', effect:'锁定技：普通"上课点名"、"随堂测验"、"突击查寝"对你无效；你受到的火焰伤害 +1。',
    limit:'不能免疫公开处刑与雷同警告（属性点名）。', order:'恒定生效。' },
  '电动车': { target:'装备到 +1 坐骑栏', dist:'—', effect:'其他角色计算与你的距离 +1。', limit:'与 −1 坐骑是**两个独立栏位**，可以同时骑；装第二匹 +1 才会顶掉第一匹。', order:'装备后持续生效。' },
  '平衡车': { target:'装备到 +1 坐骑栏', dist:'—', effect:'其他角色计算与你的距离 +1。', limit:'同上。', order:'同上。' },
  '共享单车': { target:'装备到 +1 坐骑栏', dist:'—', effect:'其他角色计算与你的距离 +1。', limit:'同上。', order:'同上。' },
  '滑板': { target:'装备到 +1 坐骑栏', dist:'—', effect:'其他角色计算与你的距离 +1。', limit:'同上。', order:'同上。' },
  '电摩': { target:'装备到 −1 坐骑栏', dist:'—', effect:'你计算与其他角色的距离 −1。', limit:'最小距离仍为 1；与 +1 坐骑互不冲突。', order:'装备后持续生效。' },
  '地铁': { target:'装备到 −1 坐骑栏', dist:'—', effect:'你计算与其他角色的距离 −1。', limit:'同上。', order:'同上。' },
  '校车': { target:'装备到 −1 坐骑栏', dist:'—', effect:'你计算与其他角色的距离 −1。', limit:'同上。', order:'同上。' }
};

/* ---------------- 常量 ---------------- */
const PHASE_NAME = {
  start:'回合开始', judge:'查考勤', draw:'摸牌', play:'出牌', discard:'弃牌', end:'回合结束'
};
const PROBE_CARDS = ['抄作业','手机没电'];
const ATTACK_CARDS = ['上课点名','公开处刑','雷同警告'];
const EQUIP_NAMES = Object.keys(CARDS).filter(n => CARDS[n].type === 'equip');

/* 导出到全局 */
window.GameData = {
  SUITS, CARDS, CARD_DETAIL, DECK_SPEC, IDENTITIES, IDENTITY_CONFIG, CHARACTERS,
  EQUIP_SLOTS, SLOT_NAME,
  CHARACTER_BY_NAME, SKILL_OWNER, PHASE_NAME, PROBE_CARDS, ATTACK_CARDS, EQUIP_NAMES,
  buildDeck, rankLabel, suitOf, isRedCard, isBlackCard, cardPoint
};
