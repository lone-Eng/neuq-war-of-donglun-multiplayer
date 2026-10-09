/* =========================================================
 *  东秦杀：点名册  ·  启动与流程编排
 * ========================================================= */
(function(){
'use strict';
const D = window.GameData;
const E = window.Engine;

const cfg = { count:5, mode:'A', deal:3, protect:true, ai:true, fast:false };

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
  document.querySelectorAll('#pick-opt button').forEach(b => {
    b.addEventListener('click', () => {
      b.classList.toggle('on');
      const k = b.dataset.opt;
      cfg[k] = b.classList.contains('on');
    });
  });
  // 电脑强度：立即生效（AI 是全局单档，下一局就用新的）
  document.querySelectorAll('#pick-ai button').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#pick-ai button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      window.Net.setAiLevel(b.dataset.ai);
    });
  });
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

function renderPreview(){
  const conf = D.IDENTITY_CONFIG[cfg.count];
  const box = document.getElementById('identity-preview');
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
    protect: cfg.protect, hotseat: !cfg.ai, networkRule:false
  });
  localSetupStep();
}

/** 本机需要亲自做决定的座位（热座 = 每个座位都要问） */
function localSeats(){
  if (G.opts.hotseat) return G.players.map(p => p.seat);
  return (G.humanSeats || [G.humanSeat]).slice();
}

/**
 * 设置阶段的状态机：模式 B 先身份轮抽，然后所有人选角。
 * 热座模式下会把每个座位一个个问过去。
 */
function localSetupStep(){
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
    const id = D.IDENTITIES[me.identity] || D.IDENTITIES.student;
    idBox.className = 'identity-card ' + id.cls;
    idBox.innerHTML = '<div class="big-word">' + id.name + '</div>' +
      '<div class="sub">阵营：' + id.faction + '　|　胜利条件：' + id.win + '</div>' +
      '<div class="sub">' + id.desc + '</div>';
  }
  const box = document.getElementById('role-options');
  box.innerHTML = '';
  const actualDeal = (window.G && G.dealPer) ? G.dealPer : me.charChoices.length;
  const oldNote = box.parentNode.querySelector('.deal-note');
  if (oldNote) oldNote.remove();
  const tie = document.createElement('div');
  tie.className = 'hint deal-note';
  tie.textContent = (G.opts.hotseat ? '「' + me.name + '」' : '你') +
    '从 ' + actualDeal + ' 名武将中选 1 名；其余 ' + (G.players.length - 1) +
    ' 名对手会从剩下的 ' + (D.CHARACTERS.length - actualDeal) + ' 名里挑选（同一局不会出现重复武将）';
  box.parentNode.insertBefore(tie, box);
  me.charChoices.forEach(c => {
    const el = document.createElement('div');
    el.className = 'role-card';
    el.innerHTML = '<div class="rc-name">' + c.name + '</div>' +
      '<div class="rc-title">' + c.title + '</div>' +
      '<div class="rc-hp">体力上限 ' + c.hp + (me.identity === 'dean' ? '（院长 +1 → ' + (c.hp+1) + '）' : '') + '</div>' +
      c.skills.map(s => '<div class="rc-skill"><b>【' + s.name + '】</b>' + s.type + '：' + s.text + '</div>').join('');
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
  const conf = D.IDENTITY_CONFIG[G.players.length];
  E.logBig('东秦杀：点名册　' + G.players.length + ' 人局');
  E.log('身份配置：院长 ' + conf.dean + '、教务 ' + conf.staff + '、学生 ' + conf.student + '、卧底 ' + conf.mole, 'sys');
  const dean = G.players.find(p => p.identity === 'dean');
  E.log('院长是 ' + (dean.seat+1) + ' 号位 ' + dean.char.name + '（身份公开，体力上限 +1）', 'sys');
  const me = G.players[G.humanSeat];
  E.log('你是 ' + (me.seat+1) + ' 号位 ' + me.char.name + '，身份【' + D.IDENTITIES[me.identity].name + '】', 'big');
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
