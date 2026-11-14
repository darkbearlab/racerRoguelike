// 完整一局驗收：三晚、Boss、捷徑、事件、通關與天亮。
// 執行：npm run simtest（會一併跑這支），或 node scripts/runtest.mjs
import { readFileSync } from 'node:fs';
import { autopilot, createAiMemory } from '../src/vehicle/ai.js';
import { createEvents } from '../src/core/events.js';
import { createSession } from '../src/race/session.js';
import { NODE_TYPES } from '../src/race/nodes.js';

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const cfg = load('../src/config/cars.json').player;
const zones = load('../src/config/zones.json');
const tcfg = load('../src/config/traffic.json');
const dcfg = load('../src/config/duel.json');
const rivals = load('../src/config/rivals.json').list;
const rcfg = load('../src/config/run.json');
const ucfg = load('../src/config/upgrades.json');
const DT = 1 / 60;
let failed = 0;
const check = (name, ok, info = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`);
};
const section = (t) => console.log(`\n── ${t}`);
const over = (st, road) => Math.max(st.d - (road.widthRight(st.s) - cfg.halfWidth), -st.d - (road.widthLeft(st.s) - cfg.halfWidth));

function make(seed, runOverride, bossRush = false) {
  const ev = createEvents();
  const S = createSession({
    seed, carCfg: { ...cfg }, zone: zones.default, zones, trafficCfg: tcfg, duelCfg: structuredClone(dcfg), rivals,
    runCfg: { ...structuredClone(rcfg), ...(runOverride || {}) }, upgradeCfg: structuredClone(ucfg), events: ev, bossRush,
  });
  return { S, ev };
}

/**
 * 用自動駕駛跑一局。
 *   forceWin(S)   回傳 true 時直接判玩家獲勝（測流程用，不靠駕駛實力）
 *   prefer(opts)  回傳要走的那一側（−1 / +1），不給就優先選還沒走過的節點類型
 */
function play(seed, { forceWin, forceLose, maxSeconds = 3600, runOverride, duelOnly, bossRush } = {}) {
  const { S, ev } = make(seed, runOverride, bossRush);
  const buffs = S.drawBuffs();
  const st = S.state, inp = {}, mem = createAiMemory();
  const log = {
    nodes: {}, events: {}, bossIntro: [], nights: [{ night: 1, zone: S.zoneName, at: 0, defeats: 0 }], shortcut: 0, bossOffered: [], duels: [],
    nightDefeatsAtBoss: [], maxOver: 0, bad: false, slow: 0, nitro: 0, choices: 0, skipped: 0, zoneStats: {},
  };
  ev.on('forkChosen', (e) => { log.nodes[e.node] = (log.nodes[e.node] || 0) + 1; });
  ev.on('eventStart', (e) => { log.events[e.kind] = (log.events[e.kind] || 0) + 1; });
  ev.on('eventResult', (e) => { log.lastEvent = e; });
  ev.on('bossIntro', (e) => { log.bossIntro.push(e.def.name); log.nightDefeatsAtBoss.push(S.run.nightDefeats); });
  ev.on('nightStart', (e) => log.nights.push({ night: e.night, zone: e.zone.name, at: S.realTime }));
  ev.on('shortcutDone', () => log.shortcut++);
  ev.on('jctPlaced', (e) => { if (e.options.includes('boss')) log.bossOffered.push(S.run.nightDefeats); });
  ev.on('duelApplied', (e) => log.duels.push({ name: e.def.name, tier: e.def.tier, win: e.win, night: S.run.night }));
  ev.on('upgradeGained', () => log.choices++);
  let side = 0, duelT = 0, t = 0;
  while (!S.over && t < maxSeconds) {
    const z = S.road.zoneAt(st.s + 150), z0 = S.road.zoneAt(st.s);
    const approaching = !S.flow.chosen && (z === 1 || z === 2 || z0 === 1 || z0 === 2);
    if (approaching && !side && S.flow.options) {
      // Boss 優先；否則選比較少走過的節點類型
      const [a, b] = S.flow.options;
      const duelA = !!NODE_TYPES[a].tier, duelB = !!NODE_TYPES[b].tier;
      side = a === 'boss' ? -1 : b === 'boss' ? 1
        : duelOnly ? (duelA ? -1 : duelB ? 1 : -1)
        : (log.nodes[a] || 0) <= (log.nodes[b] || 0) ? -1 : 1;
    }
    if (!approaching) side = 0;
    autopilot(st, S.playerCfg, S.road, { traffic: S.obsForPlayer, mem, dt: DT, line: !approaching, caution: 0.85, margin: 1.25, preferD: approaching ? side * 4.6 : null }, inp);
    // 選單：三選一拿第一張，PA 直接離開
    const m = S.menus.current;
    if (m && m.lock <= 0) S.menus.input(m.kind === 'choice' && !m.shop ? 'left' : 'down');
    if (S.duel.phase === 'marked') S.tryChallenge();
    if (S.duel.phase === 'racing') {
      duelT += DT;
      if (duelT > 6 && forceWin && forceWin(S)) S.duel.finish(true, 'score');
      else if (duelT > 6 && forceLose && forceLose(S)) S.duel.finish(false, 'score');
    } else duelT = 0;
    if (S.rival.active && S.rival.nitroT > 0 && !log._nz) { log.nitro++; log._nz = true; }
    if (!(S.rival.nitroT > 0)) log._nz = false;
    S.step(DT, inp);
    t += DT;
    if (!Number.isFinite(st.s + st.d + st.psi + st.vf)) log.bad = true;
    log.maxOver = Math.max(log.maxOver, over(st, S.road));
    if (t > 10 && st.vf < 30 / 3.6) log.slow += DT;
  }
  log.buffs = buffs;
  return { S, log, t };
}

section('Boss 連戰模式');
{
  const { S, log, t } = play(4242, { forceWin: () => true, bossRush: true, maxSeconds: 1800 });
  check('開局隨機抽到成長並裝上', log.buffs.length === rcfg.bossRush.buffs && new Set(log.buffs.map((d) => d.id)).size === log.buffs.length, log.buffs.map((d) => d.name).join('、'));
  check('沒有交流道與一般節點', S.run.forks === 0 && Object.keys(log.nodes).length === 0 && log.duels.every((d) => d.tier === 'boss'));
  check('三位 Boss 依序登場（都有登場演出）', log.bossIntro.length === 3 && new Set(log.bossIntro).size === 3, log.bossIntro.join(' → '));
  check('三連勝就通關', S.over?.reason === 'victory' && S.run.bossWins === 3, `現實 ${(t / 60).toFixed(1)} 分鐘，Boss 之間各選一次成長（共 ${log.choices} 次）`);
  const L = play(4243, { forceLose: (s) => s.run.losses < 2, forceWin: (s) => s.run.losses >= 2, bossRush: true, maxSeconds: 1800 });
  check('輸了同一位 Boss 會再來挑戰', L.log.bossIntro.length === 5 && L.log.bossIntro[0] === L.log.bossIntro[2] && L.S.over?.reason === 'victory', L.log.bossIntro.join(' → '));
  {
    // Boss 登場：靠近後玩家被鎖住，Boss 從旁邊超過去，全程車身不重疊
    let minGap = Infinity, locked = 0, intros = 0, moved = 0;
    for (const seed of [21, 22, 23, 24]) {
      const { S } = make(seed, null, true);
      S.drawBuffs();
      const st = S.state, inp = {}, mem = createAiMemory();
      let d0 = null;
      for (let t = 0; t < 40 && S.duel.phase !== 'racing'; t += DT) {
        autopilot(st, S.playerCfg, S.road, { traffic: S.obsForPlayer, mem, dt: DT, line: true, caution: 0.85, margin: 1.25 }, inp);
        // 故意往 Boss 那一側打方向盤：鎖住時不應該有作用
        if (S.introLocked) { inp.steer = S.rival.st.d > st.d ? 1 : -1; if (d0 == null) d0 = st.d; moved = Math.max(moved, Math.abs(st.d - d0)); locked += DT; }
        S.step(DT, inp);
        if (S.rival.active && S.rival.intro) {
          const ds = Math.abs(S.rival.st.s - st.s), dd = Math.abs(S.rival.st.d - st.d);
          if (ds < 4.5) minGap = Math.min(minGap, dd);
        }
      }
      if (S.duel.phase === 'racing' || S.duel.phase === 'countdown' || (S.rival.active && !S.rival.intro)) intros++;
    }
    check('Boss 登場時鎖定玩家操作', locked > 2 && moved < 0.6, `四局共鎖 ${locked.toFixed(1)} 秒，硬打方向盤最多偏 ${moved.toFixed(2)} m`);
    check('Boss 登場不穿過玩家的車', intros === 4 && minGap > 1.9, `並排時橫向最近 ${minGap.toFixed(2)} m（車寬約 1.8 m）`);
  }
  for (const seed of [11, 12, 13]) {
    const R = play(seed, { bossRush: true, maxSeconds: 3600 });
    const d = R.log.duels;
    console.log(`      自動駕駛實打 seed ${seed}：${R.S.over?.reason === 'victory' ? '通關' : `第 ${R.S.run.night} 位 Boss 前天亮`}，現實 ${(R.t / 60).toFixed(1)} 分鐘，${d.filter((x) => x.win).length} 勝 ${d.filter((x) => !x.win).length} 敗`);
  }
}

section('完整一局：三晚打到通關（對決由測試直接判勝，驗證流程）');
{
  // 時鐘放慢成每晚約 37 分鐘：這個測試要把每種節點都走過一遍，重點是流程不是時間
  const { S, log, t } = play(20261113, { forceWin: () => true, maxSeconds: 9000, runOverride: { clock: { ...rcfg.clock, gameSecondsPerRealSecond: 8 } } });
  const need = rcfg.boss.afterDefeats;
  check('通關', S.over?.reason === 'victory', `現實 ${(t / 60).toFixed(1)} 分鐘，擊敗 ${S.run.defeats} 人（含 Boss ${S.run.bossWins}），行駛 ${(S.state.dist / 1000).toFixed(0)} km`);
  check('三晚依序進行、區域不同', log.nights.length === 3 && new Set(log.nights.map((n) => n.zone)).size === 3,
    log.nights.map((n) => `第 ${n.night} 晚 ${n.zone}（${(n.at / 60).toFixed(1)} 分）`).join(' → '));
  check(`本晚擊敗 ${need} 人後才出現 Boss 分支`, log.bossOffered.length >= 3 && log.bossOffered.every((n) => n >= need), `Boss 分支出現時的本晚擊敗數：${log.bossOffered.join('、')}`);
  check('三位 Boss 各自登場', log.bossIntro.length === 3 && new Set(log.bossIntro).size === 3, log.bossIntro.join('、'));
  const types = Object.keys(NODE_TYPES);
  check('六種節點都出現過', types.every((k) => log.nodes[k] > 0), types.map((k) => `${NODE_TYPES[k].icon}${log.nodes[k] || 0}`).join(' '));
  check('事件節點會抽到不同內容（三種各自在下面單獨驗證）', Object.keys(log.events).length >= 2, Object.entries(log.events).map(([k, v]) => `${k} ${v}`).join('、'));
  check('捷徑可完成並退回時間', log.shortcut > 0, `完成 ${log.shortcut} 次`);
  check('數值正常、不穿牆、不卡住', !log.bad && log.maxOver < 0.02 && log.slow < 40, `超出護欄 ${Math.max(0, log.maxOver).toFixed(3)} m，低於 30 km/h 共 ${log.slow.toFixed(0)} 秒`);
  check('獲勝都有拿到成長', log.choices >= S.run.defeats - 3 && S.upgrades.total > 0, `選了 ${log.choices} 次，最後持有 ${S.upgrades.list().map((it) => it.def.name + (it.count > 1 ? '×' + it.count : '')).join('、')}`);
}

section('Boss');
{
  // 第一晚：打到 Boss 出現後故意輸一次，確認扣 30 分鐘、下一個交流道還有 Boss
  let lostOnce = false, minutesBefore = 0, lostMin = 0;
  const { S, log } = play(4242, {
    forceWin: (s) => s.rival.def.tier !== 'boss' || lostOnce,
    forceLose: (s) => {
      if (s.rival.def.tier === 'boss' && !lostOnce) { lostOnce = true; minutesBefore = s.clock.minute; return true; }
      return false;
    },
    maxSeconds: 1500, duelOnly: true,
    runOverride: { nights: [rcfg.nights[0]] },
  });
  const bossDuels = log.duels.filter((d) => d.tier === 'boss');
  check('輸給 Boss 後可再挑戰並通關', bossDuels.length === 2 && !bossDuels[0].win && bossDuels[1].win && S.over?.reason === 'victory',
    bossDuels.map((d) => `${d.name}${d.win ? '勝' : '敗'}`).join(' → '));
  check('輸給 Boss 扣 30 分鐘', S.run.penaltyMin >= 30 && dcfg.loseMinutesByTier.boss === 30, `累計時間懲罰 ${S.run.penaltyMin} 分鐘`);

  // 登場：從後方出現、超到玩家前方後才能挑戰
  const { S: B, ev } = make(77, { boss: { ...rcfg.boss, afterDefeats: 0 } });
  const st = B.state, inp = {}, mem = createAiMemory();
  let intro = null, behindAtSpawn = 0, challengedDuringIntro = false, aheadWhenReady = 0, tReady = -1, t = 0;
  ev.on('bossIntro', (e) => { intro = e.def; behindAtSpawn = st.s - B.rival.st.s; });
  while (t < 240 && tReady < 0) {
    const approaching = !B.flow.chosen;
    const side = B.flow.options[0] === 'boss' ? -1 : 1;
    autopilot(st, B.playerCfg, B.road, { traffic: B.obsForPlayer, mem, dt: DT, speedCap: 55, preferD: approaching ? side * 4.6 : null }, inp);
    B.step(DT, inp);
    t += DT;
    if (intro && B.rival.intro && B.tryChallenge()) challengedDuringIntro = true;
    if (intro && !B.rival.intro && tReady < 0) { tReady = t; aheadWhenReady = B.rival.st.s - st.s; }
  }
  check('Boss 從玩家後方登場', !!intro && behindAtSpawn > 100, intro ? `${intro.name}「${intro.title}」在後方 ${behindAtSpawn.toFixed(0)} m 出現` : '沒有登場');
  check('超到玩家前方後才進入等待挑戰', tReady > 0 && aheadWhenReady > 20 && !challengedDuringIntro, `領先 ${aheadWhenReady.toFixed(0)} m 時就位`);
  check('Boss 目標分數 200', B.duel.target === 200);

  // 特殊行為
  const yasha = rivals.find((r) => r.id === 'yasha'), typhoon = rivals.find((r) => r.id === 'typhoon'), akatsuki = rivals.find((r) => r.id === 'akatsuki');
  // Boss = 玩家可選的起始車（原廠）＋固定 buff ＋隨機 buff，和玩家同一套成長
  const cars = load('../src/config/cars.json');
  const D = make(77).S.dress;
  const dy = D(yasha), dt2 = D(typhoon), da = D(akatsuki);
  const stockOf = (name) => ({ ...cars.player, ...cars.starters.find((s) => s.name === name).car });
  check('Boss 的底盤就是三台起始車的原廠數值', [yasha, typhoon, akatsuki].every((b) => { const s = stockOf(b.chassis); return s.vMaxKmh === b.topSpeedKmh && s.power === b.power && (b.car.latAccelMax ?? cars.player.latAccelMax) === s.latAccelMax; }),
    [yasha, typhoon, akatsuki].map((b) => `${b.name}＝${b.chassis} ${b.topSpeedKmh} km/h`).join('、'));
  const nb = (d) => d.buffList.reduce((a, it) => a + it.count, 0);
  check('Boss 帶著固定 buff 再加隨機抽的', [[yasha, dy], [typhoon, dt2], [akatsuki, da]].every(([b, d]) => nb(d) === b.buffs.length + b.randomBuffs && d.topSpeedKmh > b.topSpeedKmh),
    [dy, dt2, da].map((d) => `${d.name} ${d.stock.topSpeedKmh}→${d.topSpeedKmh} km/h（${d.buffList.map((it) => it.def.name + (it.count > 1 ? '×' + it.count : '')).join('・')}）`).join('\n      '));
  {
    // 隨機抽的池子裡有「不服輸」（單向橡皮筋）：抽夠多次一定會出現
    let got = 0, n = 0;
    for (let k = 0; k < 60; k++) { const d = D(akatsuki); n++; if (d.car.comebackTop > 0) got++; }
    check('Boss 有機會抽到「不服輸」（單向橡皮筋）', got > 0 && got < n, `60 次登場有 ${got} 次帶著`);
    const night3 = D(rivals.find((r) => r.id === 'greywolf'), 4), night1 = D(rivals.find((r) => r.id === 'greywolf'), 0);
    check('一般對手：越後面的夜晚隨機 buff 越多', nb(night1) === 0 && nb(night3) === 4 && rcfg.nights.map((x) => x.rivalBuffs).join() === '0,2,4', `第 1 晚 ${night1.topSpeedKmh} km/h 無 buff；第 3 晚帶 ${night3.buffList.map((it) => it.def.name + (it.count > 1 ? '×' + it.count : '')).join('・')}`);
  }
  check('彎道之王：過彎極限高於玩家', dy.car.latAccelMax > cfg.latAccelMax * 1.2 && yasha.cornerSkill === 1,
    `橫向加速度 ${dy.car.latAccelMax.toFixed(1)} vs 玩家 ${cfg.latAccelMax} m/s²：半徑 100 m 的彎可用 ${(Math.sqrt(dy.car.latAccelMax * 0.98 * 100) * 3.6).toFixed(0)} km/h 過，玩家極限 ${(Math.sqrt(cfg.latAccelMax * 100) * 3.6).toFixed(0)} km/h`);
  check('終極對手：持續卡位', akatsuki.block === 1 && akatsuki.special === 'blocker');
  {
    const fixedTop = (r) => r.topSpeedKmh + (r.buffs || []).reduce((a, id) => a + (id === 'tall_gears' ? 6 : id === 'last_resort' ? 12 : 0), 0);
    check('極速怪物：直線極速最高（原廠＋固定 buff）', fixedTop(typhoon) > Math.max(...rivals.filter((r) => r.id !== 'typhoon').map(fixedTop)), `${fixedTop(typhoon)} km/h`);
  }
}

section('Boss 登場：玩家極速 330 km/h、車流最密的第三晚');
{
  let ready = 0, started = 0, worst = 0;
  const N = 6;
  for (let k = 0; k < N; k++) {
    const { S } = make(300 + k, { nights: [rcfg.nights[2]], boss: { ...rcfg.boss, afterDefeats: 0 } });
    for (const id of ['tall_gears', 'tall_gears', 'tall_gears', 'last_resort', 'turbo', 'turbo', 'turbo']) S.upgrades.add(id);
    const st = S.state, inp = {}, mem = createAiMemory();
    let t = 0, tIntro = -1, tReady = -1, raced = false;
    while (t < 300 && !raced) {
      const approaching = !S.flow.chosen;
      const side = S.flow.options[0] === 'boss' ? -1 : 1;
      autopilot(st, S.playerCfg, S.road, { traffic: S.obsForPlayer, mem, dt: DT, line: !approaching, caution: 0.8, margin: 1.2, preferD: approaching ? side * 4.6 : null }, inp);
      if (S.duel.phase === 'marked') S.tryChallenge();
      S.step(DT, inp);
      t += DT;
      if (S.rival.active && S.rival.intro && tIntro < 0) tIntro = t;
      if (tIntro >= 0 && tReady < 0 && S.rival.active && !S.rival.intro) tReady = t;
      if (S.duel.phase === 'racing') raced = true;
    }
    if (tReady > 0) { ready++; worst = Math.max(worst, tReady - tIntro); }
    if (raced) started++;
  }
  check('Boss 每次都能超到前方就位', ready === N, `${ready} / ${N}，最久 ${worst.toFixed(1)} 秒`);
  check('對決每次都開得成', started === N, `${started} / ${N}`);
}

section('極速怪物的氮氣（第二晚 Boss 對決 90 秒）');
{
  const { S, ev } = make(555, { nights: [rcfg.nights[1]], boss: { ...rcfg.boss, afterDefeats: 0 } });
  S.duel.finish = ((orig) => (...a) => orig(...a))(S.duel.finish);
  const st = S.state, inp = {}, mem = createAiMemory();
  let nitro = 0, was = false, vMaxSeen = 0, raced = 0, t = 0;
  // 目標分數調到打不完，只觀察行為
  while (t < 400 && raced < 90) {
    const approaching = !S.flow.chosen;
    const side = S.flow.options[0] === 'boss' ? -1 : 1;
    autopilot(st, S.playerCfg, S.road, { traffic: S.obsForPlayer, mem, dt: DT, speedCap: 60, preferD: approaching ? side * 4.6 : null }, inp);
    if (S.duel.phase === 'marked') S.tryChallenge();
    S.duel.target = 1e9;
    S.step(DT, inp);
    t += DT;
    if (S.duel.phase === 'racing') {
      raced += DT;
      const on = S.rival.nitroT > 0;
      if (on && !was) nitro++;
      was = on;
      vMaxSeen = Math.max(vMaxSeen, S.rival.st.vf * 3.6);
    }
  }
  check('在直線開啟氮氣', nitro > 0 && S.rival.def.special === 'nitro', `90 秒內開了 ${nitro} 次（車流中實際最高開到 ${vMaxSeen.toFixed(0)} km/h）`);
}

section('事件節點');
{
  // 警察盤查：出現警車、是一場對決（獎懲在 upgradetest 驗證）
  {
    const { S: P } = make(9, { events: { ...rcfg.events, weights: { police: 1 } } });
    P.flow.options = ['event', 'event'];
    P.state.s = P.flow.forkS - 80; P.state.vf = 40; P.prev.s = P.state.s;
    const inpP = {}, memP = createAiMemory();
    for (let i = 0; i < 60 * 40 && !P.rival.active; i++) { autopilot(P.state, P.playerCfg, P.road, { traffic: P.obsForPlayer, mem: memP, dt: DT }, inpP); P.step(DT, inpP); }
    check('警察盤查：出現警車，是一場對決', P.rival.active && P.rival.def.tier === 'police' && P.duel.target === dcfg.targets.police, P.rival.active ? `${P.rival.def.name}，目標 ${P.duel.target} 分` : '');
  }
  // 塞車：真的有一段密集慢車
  const { S, ev } = make(21, { events: { ...rcfg.events, weights: { jam: 1 } } });
  let started = null, result = null;
  ev.on('eventStart', (e) => { started = e; });
  ev.on('eventResult', (e) => { result = e; });
  S.flow.options = ['event', 'event'];
  const st = S.state, fS = S.flow.forkS, inp = {}, mem = createAiMemory();
  st.s = fS - 80; st.vf = 40; S.prev.s = st.s;
  let inJam = 0, n = 0, minV = Infinity, t = 0;
  while (t < 200 && !result) {
    autopilot(st, S.playerCfg, S.road, { traffic: S.obsForPlayer, mem, dt: DT, caution: 0.85, margin: 1.25 }, inp);
    S.step(DT, inp);
    t += DT;
    if (started && st.s > started.s0 && st.s < started.s1) { inJam += st.vf; n++; minV = Math.min(minV, st.vf); }
  }
  check('塞車：一段密集慢車，穿過後拿賞金', !!started && started.cars >= 16 && !!result && result.bounty >= 0 && result.bounty <= rcfg.events.jam.bounty + rcfg.events.jam.fastBonus,
    started ? `${started.cars} 台慢車擠在 ${rcfg.events.jam.length} m 內；通過時平均 ${((inJam / Math.max(1, n)) * 3.6).toFixed(0)} km/h` : '');

  // 神秘車輛：是一場對決
  const { S: M, ev: ev2 } = make(33, { events: { ...rcfg.events, weights: { mystery: 1 } } });
  M.flow.options = ['event', 'event'];
  M.state.s = M.flow.forkS - 80; M.state.vf = 40; M.prev.s = M.state.s;
  const inp2 = {}, mem2 = createAiMemory();
  for (let i = 0; i < 60 * 40 && !M.rival.active; i++) { autopilot(M.state, M.playerCfg, M.road, { traffic: M.obsForPlayer, mem: mem2, dt: DT }, inp2); M.step(DT, inp2); }
  check('神秘車輛：出現一位神秘對手', M.rival.active && M.rival.def.tier === 'mystery' && M.duel.target === dcfg.targets.mystery, M.rival.active ? `${M.rival.def.name}，目標 ${M.duel.target} 分` : '');
}

section('捷徑');
{
  const { S, ev } = make(61);
  let done = false, refund = 0;
  ev.on('shortcutDone', (e) => { done = true; refund = e.minutes; });
  // 重新放一個兩邊都是捷徑的交流道太麻煩：直接找一個有捷徑的種子來量路況
  let found = null;
  for (let seed = 1; seed < 60 && !found; seed++) {
    const m = make(seed);
    if (m.S.flow.options.includes('shortcut')) found = { ...m, side: m.S.flow.options[0] === 'shortcut' ? -1 : 1 };
  }
  if (!found) check('找得到有捷徑的交流道', false);
  else {
    const T = found.S;
    let finished = false, ref = 0, m0 = 0, gained = 0;
    found.ev.on('shortcutDone', (e) => { finished = true; ref = e.minutes; });
    const st = T.state, inp = {}, mem = createAiMemory();
    let t = 0, sharp = 0, total = 0, cars = 0;
    while (t < 300 && !finished) {
      const approaching = !T.flow.chosen;
      autopilot(st, T.playerCfg, T.road, { traffic: T.obsForPlayer, mem, dt: DT, caution: 0.85, margin: 1.25, preferD: approaching ? found.side * 4.6 : null }, inp);
      m0 = T.clock.minute;
      T.step(DT, inp);
      gained = T.clock.minute - m0;
      t += DT;
      if (T.flow.node === 'shortcut' && st.s > T.flow.nodeStartS + rcfg.shortcut.startAfterFork) {
        total++;
        if (Math.abs(T.road.curvature(st.s)) > 0.006) sharp++;
        cars = Math.max(cars, T.traffic.count);
      }
    }
    check('捷徑：開完退回 20 分鐘', finished && ref === rcfg.shortcut.refundMinutes && gained < -19, `時鐘 ${gained.toFixed(1)} 分鐘`);
    check('捷徑：彎道急、車流密', sharp / Math.max(1, total) > 0.2 && cars >= 16, `急彎佔路程 ${((sharp / Math.max(1, total)) * 100).toFixed(0)}%，同時最多 ${cars} 台車`);
  }
}

section('一局的長度（只打對決與 Boss，對決開始 6 秒後直接判勝）');
{
  for (const seed of [5, 6, 7]) {
    const { S, log, t } = play(seed * 100 + 1, { forceWin: () => true, duelOnly: true });
    if (S.over?.reason !== 'victory') console.log('      ', JSON.stringify({ nightDefeats: S.run.nightDefeats, skipped: S.run.skipped, bossIntro: log.bossIntro.length, bossOffered: log.bossOffered, nodes: log.nodes, penalty: S.run.penaltyMin, lastDuels: log.duels.slice(-6).map((d) => d.name + (d.win ? '勝' : '敗')) }));
    console.log(`      seed ${seed}：${S.over?.reason === 'victory' ? '通關' : `第 ${S.run.night} 晚天亮`}，現實 ${(t / 60).toFixed(1)} 分鐘（各晚開始於 ${log.nights.map((n) => (n.at / 60).toFixed(1)).join('、')} 分），擊敗 ${S.run.defeats} 人`);
  }
}

section('一局的長度（自動駕駛實打，不作弊）');
{
  for (const seed of [1, 2, 3]) {
    const { S, log, t } = play(seed * 1000 + 13, {});
    const d = log.duels;
    console.log(`      seed ${seed}：${S.over?.reason === 'victory' ? '通關' : `第 ${S.run.night} 晚天亮`}，現實 ${(t / 60).toFixed(1)} 分鐘，對決 ${d.filter((x) => x.win).length} 勝 ${d.filter((x) => !x.win).length} 敗，本晚擊敗 ${S.run.nightDefeats}/${rcfg.boss.afterDefeats}，Boss 登場 ${log.bossIntro.length} 次`);
  }
  const perNight = (rcfg.clock.dawnMinute - rcfg.clock.startMinute) * 60 / rcfg.clock.gameSecondsPerRealSecond / 60;
  console.log(`      每晚時限 ${perNight.toFixed(0)} 分鐘（現實），三晚打滿 ${(perNight * 3).toFixed(0)} 分鐘`);
}

console.log(failed ? `\n${failed} 項失敗` : '\n完整一局全部通過');
process.exit(failed ? 1 : 0);
