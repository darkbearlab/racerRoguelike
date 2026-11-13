// 成長系統驗收：規格的 11 個範例成長逐一量測實際效果，加上三選一與商店流程。
// 執行：npm run simtest（會一併跑這支），或 node scripts/upgradetest.mjs
import { readFileSync } from 'node:fs';
import { createCarState, stepCar } from '../src/vehicle/physics.js';
import { createEvents } from '../src/core/events.js';
import { createSession } from '../src/race/session.js';

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const cfg = load('../src/config/cars.json').player;
const zone = load('../src/config/zones.json').default;
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
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// 一條無限長的直路，量車輛性能用
const straight = { curvature: () => 0, widthLeft: () => 6, widthRight: () => 6, gore: () => 0, sMin: -1e9, halfWidth: 6 };

function session(ids = [], opts = {}) {
  const ev = createEvents();
  const S = createSession({
    seed: opts.seed ?? 5, carCfg: { ...cfg }, zone, trafficCfg: opts.traffic ?? { ...tcfg, densityPerKm: 0 },
    duelCfg: structuredClone(dcfg), rivals, runCfg: structuredClone(rcfg), upgradeCfg: structuredClone(ucfg), events: ev, mode: opts.mode ?? 'free',
  });
  for (const id of ids) if (!S.upgrades.add(id)) throw new Error(`無法加入成長 ${id}`);
  S.ev = ev;
  return S;
}
const zeroTo100 = (c) => { const st = createCarState(); let t = 0; while (st.vf < 100 / 3.6 && t < 30) { stepCar(st, { throttle: 1, brake: 0, steer: 0 }, c, straight, DT); t += DT; } return t; };
const topSpeed = (c) => { const st = createCarState({ vf: c.vMaxKmh / 3.6 - 8 }); for (let i = 0; i < 60 * 60; i++) stepCar(st, { throttle: 1, brake: 0, steer: 0 }, c, straight, DT); return st.vf * 3.6; };
const brakeTime = (c) => { const st = createCarState({ vf: 100 / 3.6 }); let t = 0; while (st.vf > 0.1 && t < 30) { stepCar(st, { throttle: 0, brake: 1, steer: 0 }, c, straight, DT); t += DT; } return t; };
// 定速打滿方向時的橫向加速度（= 偏航速率 × 速度）
const latAccel = (c, v) => { const st = createCarState({ vf: v }); let m = 0; for (let i = 0; i < 90; i++) { stepCar(st, { throttle: 0.5, brake: 0, steer: 1 }, c, { ...straight, widthLeft: () => 1e6, widthRight: () => 1e6 }, DT); m = Math.max(m, Math.abs(st.yawRate) * Math.abs(st.vf)); } return m; };
const yawLow = (c) => { const st = createCarState({ vf: 5 }); for (let i = 0; i < 40; i++) stepCar(st, { throttle: 0.2, brake: 0, steer: 1 }, c, { ...straight, widthLeft: () => 1e6, widthRight: () => 1e6 }, DT); return Math.abs(st.yawRate); };
const wallLoss = (c) => {
  const ev = createEvents(); let loss = 0;
  ev.on('wallHit', (e) => { loss = e.loss; });
  const st = createCarState({ d: 4.6, vf: 50 }); st.psi = -0.3;
  for (let i = 0; i < 60 && !loss; i++) stepCar(st, { throttle: 0, brake: 0, steer: 0 }, c, straight, DT, ev);
  return loss;
};
/** 讓對決進入計分階段，回傳一個設定差距並推進時間的函式 */
function racing(S) {
  const p = { s: 1000, v: 50 }, r = { s: 1000 };
  S.duel.mark('normal'); S.duel.challenge();
  for (let i = 0; i < 181; i++) S.duel.update(DT, p, r);
  return (gap, sec) => { p.s = r.s + gap; for (let i = 0; i < Math.round(sec * 60); i++) S.duel.update(DT, p, r); };
}

section('範例成長：零件');
{
  const base = session().playerCfg;
  const a = zeroTo100(base), b = zeroTo100(session(['turbo']).playerCfg);
  check('渦輪增壓器：加速 +12%', near(session(['turbo']).playerCfg.power / base.power, 1.12, 1e-9) && b < a * 0.93, `0–100 km/h ${a.toFixed(2)} → ${b.toFixed(2)} 秒`);
  const t0 = topSpeed(base), t1 = topSpeed(session(['tall_gears']).playerCfg);
  check('高速齒輪比：極速 +15 km/h', near(t1 - t0, 15, 0.6), `實測極速 ${t0.toFixed(1)} → ${t1.toFixed(1)} km/h`);
  const l0 = latAccel(base, 40), l1 = latAccel(session(['semi_slicks']).playerCfg, 40);
  check('半熱熔胎：抓地 +15%', near(l1 / l0, 1.15, 0.01), `144 km/h 時橫向加速度 ${l0.toFixed(1)} → ${l1.toFixed(1)} m/s²`);
  const b0 = brakeTime(base), b1 = brakeTime(session(['big_calipers']).playerCfg);
  check('強化煞車卡鉗：煞車力 +20%', near(session(['big_calipers']).playerCfg.brakeDecel / base.brakeDecel, 1.2, 1e-9) && b1 < b0 * 0.87, `100→0 km/h ${b0.toFixed(2)} → ${b1.toFixed(2)} 秒`);
}

section('範例成長：駕駛技能');
{
  // 吸尾流大師：前車在 40 m 外，原本吃不到、有成長才吃得到
  const slip = (ids) => {
    const S = session(ids);
    const c = S.traffic.cars[0];
    Object.assign(c, { active: true, onAlt: false, lane: 1, toLane: 1, fromLane: 1, s: S.state.s + 40 + (c.len + 4.4) / 2, d: 0, v: 30, cruise: 30, timer: 99 });
    S.state.vf = 30;
    S.step(DT, { throttle: 1, brake: 0, steer: 0 });
    return { on: S.slip, drag: S.state.dragMul, range: S.playerCfg.slipstreamRange };
  };
  const s0 = slip([]), s1 = slip(['slipstream_master']);
  check('吸尾流大師：距離 ×1.5、效果 +50%', !s0.on && s1.on && near(s1.range, 45, 1e-9) && near(1 - s1.drag, 0.525, 1e-9),
    `前車在 40 m：無成長${s0.on ? '有' : '沒有'}尾流，有成長阻力 −${((1 - s1.drag) * 100).toFixed(1)}%（原本 −35%、30 m）`);

  const w0 = wallLoss(session().playerCfg), w1 = wallLoss(session(['soft_scrape']).playerCfg);
  check('柔和擦撞：撞牆減速減半', w0 > 0 && near(w1 / w0, 0.5, 1e-6), `同一角度撞牆扣速 ${(w0 * 100).toFixed(1)}% → ${(w1 * 100).toFixed(1)}%`);

  const keep = (ids) => { const S = session(ids); const go = racing(S); go(140, 3); const before = S.duel.scoreP; go(-10, 0.1); return { before, after: S.duel.scoreP }; };
  const k0 = keep([]), k1 = keep(['unyielding']);
  check('不屈：被超車時保留 40% 分數', k0.after === 0 && near(k1.after / k1.before, 0.4, 1e-9), `${k1.before.toFixed(1)} 分 → ${k1.after.toFixed(1)} 分（無成長歸零）`);

  // 甩尾加速：拉手煞車甩 1.2 秒後放開，比較甩尾結束後 1 秒的速度
  const drift = (ids) => {
    const S = session(ids);
    S.state.vf = 40;
    let ended = -1, vEnd = 0, boosted = false, hook = 0;
    S.ev.on('hookFired', (e) => { if (e.hook === 'onDriftEnd') hook++; });
    for (let i = 0; i < 60 * 8; i++) {
      const t = i * DT;
      S.step(DT, { throttle: 1, brake: 0, steer: t < 1.2 ? 0.6 : 0, handbrake: t > 0.1 && t < 1.2 });
      if (S.boostT > 0) boosted = true;
      if (ended < 0 && t > 1.2 && !S.state.drifting) { ended = i; vEnd = S.state.vf; }
      if (ended >= 0 && i === ended + 60) return { gain: S.state.vf - vEnd, boosted, hook, endT: ended * DT };
    }
    return { gain: 0, boosted, hook, endT: -1 };
  };
  const d0 = drift([]), d1 = drift(['drift_boost']);
  check('甩尾加速：甩尾結束時獲得 1 秒短暫加速', d1.hook === 1 && d1.boosted && !d0.boosted && d1.gain > d0.gain + 4,
    `甩尾結束後 1 秒內速度 +${(d1.gain * 3.6).toFixed(0)} km/h（無成長 +${(d0.gain * 3.6).toFixed(0)}）`);
  const tiny = session(['drift_boost']);
  tiny.upgrades.fire('onDriftEnd', tiny, { time: 0.2 });
  check('甩尾加速：太短的甩尾不觸發', tiny.boostT === 0);
}

section('範例成長：取捨');
{
  const base = session().playerCfg, lr = session(['last_resort']).playerCfg;
  const t0 = topSpeed(base), t1 = topSpeed(lr), y0 = yawLow(base), y1 = yawLow(lr);
  check('窮途末路：極速 +25 km/h，轉向力 −15%', near(t1 - t0, 25, 0.8) && near(y1 / y0, 0.85, 0.01),
    `極速 ${t0.toFixed(1)} → ${t1.toFixed(1)} km/h；低速偏航 ${y0.toFixed(2)} → ${y1.toFixed(2)} rad/s`);

  const rate = (ids) => { const S = session(ids, { mode: 'run' }); const go = racing(S); go(40.001, 1); const r = S.duel.scoreP; const m0 = S.clock.minute; go(-10, 0.1); return { r, lost: S.clock.minute - m0 }; };
  const g0 = rate([]), g1 = rate(['gambler']);
  check('賭徒：得分速度 +30%，被超車時扣 5 分鐘', near(g1.r / g0.r, 1.3, 1e-6) && near(g1.lost, 5, 1e-9) && g0.lost === 0,
    `剛過門檻每秒 ${g0.r.toFixed(1)} → ${g1.r.toFixed(1)} 分；被超車時鐘 +${g1.lost.toFixed(0)} 分鐘（無成長 +${g0.lost}）`);

  const thr = (ids) => { const S = session(ids); const go = racing(S); go(30, 1); return S.duel.scoreP; };
  const nh = session(['nighthawk'], { mode: 'run', traffic: tcfg });
  nh.step(DT, { throttle: 0, brake: 0, steer: 0 });
  const plain = session([], { mode: 'run', traffic: tcfg });
  plain.step(DT, { throttle: 0, brake: 0, steer: 0 });
  check('夜鷹：得分門檻降為 25 m，車流密度 +30%', thr([]) === 0 && thr(['nighthawk']) > 7 && near(nh.traffic.density / plain.traffic.density, 1.3, 1e-9),
    `領先 30 m 一秒得 ${thr(['nighthawk']).toFixed(1)} 分（無成長 0）；車流密度 ×${(nh.traffic.density / plain.traffic.density).toFixed(2)}`);
}

section('效果系統');
{
  const S = session();
  const U = S.upgrades;
  const base = { ...S.playerCfg };
  U.add('turbo'); U.add('turbo'); U.add('turbo');
  check('可疊加的成長：三層相乘', near(S.playerCfg.power / base.power, 1.12 ** 3, 1e-9) && U.count('turbo') === 3, `加速 ×${(S.playerCfg.power / base.power).toFixed(3)}`);
  check('超過疊加上限會被拒絕', U.add('turbo') === false && U.count('turbo') === 3);
  U.add('unyielding');
  check('不可疊加的成長不能拿第二次', U.add('unyielding') === false);
  U.add('tall_gears'); U.add('last_resort');
  check('add 與 mul 混用：先加後乘', near(S.playerCfg.vMaxKmh, base.vMaxKmh + 15 + 25, 1e-9));
  for (const it of U.list()) for (let i = 0; i < it.count; i++) U.remove(it.def.id);
  check('移除後完全回到基準值', U.total === 0 && Object.keys(base).every((k) => S.playerCfg[k] === base[k]) && S.duel.mods.keepOnOvertaken === 0);

  // 對手不受玩家的成長影響
  const S2 = session(['tall_gears', 'turbo', 'semi_slicks'], { mode: 'loop' });
  for (let i = 0; i < 200 && !S2.rival.active; i++) S2.step(DT, { throttle: 1, brake: 0, steer: 0 });
  const rc = S2.rival.cfg, def = S2.rival.def;
  check('對手不受玩家的成長影響', S2.rival.active && rc.vMaxKmh === def.topSpeedKmh && rc.power === def.power && rc.latAccelMax === cfg.latAccelMax,
    `${def.name} 極速 ${rc.vMaxKmh}、抓地 ${rc.latAccelMax}；玩家極速 ${S2.playerCfg.vMaxKmh}、抓地 ${S2.playerCfg.latAccelMax.toFixed(1)}`);

  // 每個成長的每個效果都指到實際存在的參數
  const targets = { car: S.playerCfg, duel: S.duel.mods, world: S.world };
  const bad = [];
  for (const d of ucfg.list) for (const e of d.effects) { const [r, k] = e.target.split('.'); if (!(targets[r] && typeof targets[r][k] === 'number')) bad.push(`${d.id}:${e.target}`); }
  check('所有效果都指到存在的參數', bad.length === 0, bad.join('、') || `${ucfg.list.length} 個成長、${ucfg.list.reduce((a, d) => a + d.effects.length, 0)} 個效果`);
}

section('三選一');
{
  /** 開一場對決並直接判玩家獲勝 */
  const win = (S, tier = 'normal') => {
    const def = rivals.find((r) => r.tier === tier);
    S.state.vf = 40;
    if (!S.spawnRival(def, S.state.s + 60)) throw new Error('對手生成失敗');
    S.duel.challenge(); S.applied = false;
    S.duel.finish(true, 'score');
    // 勝利後世界先慢下來、停住，三選一才出現：記錄這段的時間倍率
    const log = { t: 0, minScale: 1, sawFull: false, s0: S.state.s };
    while (!S.menus.current && log.t < 6) {
      S.step(DT, { throttle: 1, brake: 0, steer: 0 }); log.t += DT;
      if (S.timeScale > 0.99) log.sawFull = true;
      if (S.timeScale > 0) log.minScale = Math.min(log.minScale, S.timeScale);
    }
    return log;
  };
  const S = session([], { mode: 'run' });
  const b0 = S.run.bounty;
  const slow = win(S);
  const m = S.menus.current;
  check('勝利後先慢動作再停住，才出現三選一', !!m && slow.sawFull && slow.minScale < 0.15 && slow.t > 2 && slow.t < 3.5, `${slow.t.toFixed(1)} 秒後出現，最慢到 ${(slow.minScale * 100).toFixed(0)}% 速度`);
  check('獲勝後出現三張不重複的卡', !!m && m.kind === 'choice' && m.cards.length === 3 && new Set(m.cards.map((c) => c.id)).size === 3, m ? m.cards.map((c) => c.name).join('、') : '');
  check('獲勝給賞金', S.run.bounty - b0 === dcfg.bountyByTier.normal, `+${S.run.bounty - b0}`);
  const min0 = S.clock.minute, s0 = S.state.s;
  for (let i = 0; i < 30; i++) S.step(DT, { throttle: 1, brake: 0, steer: 0 });
  check('選擇時世界停住：車不動、時鐘不走', S.state.s === s0 && S.clock.minute === min0 && S.timeScale === 0);
  {
    const L = session([], { mode: 'run' }); win(L);
    check('剛出現的 0.6 秒內不接受輸入（避免誤觸）', L.menus.input('up') === false && !!L.menus.current);
  }
  // 選單期間：車子自動保持車道、不會被撞
  const c = S.traffic.cars[0];
  Object.assign(c, { active: true, onAlt: false, lane: 1, toLane: 1, fromLane: 1, s: S.state.s + 1, d: S.state.d, v: 5, cruise: 5, timer: 99 });
  const hits0 = S.state.carHits || 0;
  const d0 = S.state.d;
  for (let i = 0; i < 45; i++) S.step(DT, { throttle: 0, brake: 0, steer: 1 }); // 玩家亂打方向盤也沒用
  check('選單期間不會被撞、車速保留到選完之後', (S.state.carHits || 0) === hits0 && Math.abs(S.state.d - d0) < 0.01 && S.state.vf > 15,
    `速度 ${(S.state.vf * 3.6).toFixed(0)} km/h，橫移 ${Math.abs(S.state.d - d0).toFixed(1)} m`);
  c.active = false;
  const want = S.menus.current.cards[1];
  check('↑ 選中間那張並立刻生效', S.menus.input('up') && S.upgrades.count(want.id) === 1 && !S.menus.current, want.name);
  let tr = 0; const sR = S.state.s;
  while (S.timeScale < 1 && tr < 3) { S.step(DT, { throttle: 1, brake: 0, steer: 0 }); tr += DT; }
  check('選完後世界很快恢復原速', S.timeScale === 1 && tr < 1 && S.state.s > sR, `${tr.toFixed(2)} 秒`);

  const T = session([], { mode: 'run' });
  win(T);
  const bT = T.run.bounty, mT = T.clock.minute;
  let t = 0;
  while (T.menus.current && t < 60) { T.step(DT, { throttle: 0, brake: 0, steer: 0 }); t += DT; }
  check('沒有時間限制：放著一分鐘也不會自動關掉', !!T.menus.current && T.run.bounty === bT && T.clock.minute === mT, `等了 ${t.toFixed(0)} 秒`);
  check('↓ 都不要：改拿賞金', T.menus.input('down') && !T.menus.current && T.run.bounty - bT === ucfg.rules.skipBounty && T.upgrades.total === 0, `賞金 +${T.run.bounty - bT}`);

  let rareOk = 0, eliteRare = 0, normRare = 0;
  for (let k = 0; k < 200; k++) {
    const E = session([], { seed: 100 + k });
    const off = E.upgrades.offer({ next: (() => { let a = k * 7919 + 1; return () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296); })() }, 'elite', 3);
    if (off.some((d) => d.rarity !== 'common')) rareOk++;
    eliteRare += off.filter((d) => d.rarity !== 'common').length;
    const offN = E.upgrades.offer({ next: (() => { let a = k * 104729 + 3; return () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296); })() }, 'normal', 3);
    normRare += offN.filter((d) => d.rarity !== 'common').length;
  }
  check('強敵獲勝：選項一定含稀有以上', rareOk === 200, `200 次抽選；稀有以上平均張數 強敵 ${(eliteRare / 200).toFixed(2)}、一般 ${(normRare / 200).toFixed(2)}`);
}

section('PA 商店');
{
  const S = session([], { mode: 'run' });
  S.run.bounty = 300;
  S.upgrades.add('turbo');
  S.menus.openShop();
  const m = S.menus.current;
  for (let i = 0; i < 40; i++) S.menus.update(DT);
  check('商店有三件商品與價格', m.kind === 'shop' && m.stock.length === 3 && m.stock.every((it) => it.price === ucfg.rules.prices[it.def.rarity]),
    m.stock.map((it) => `${it.def.name} ${it.price}`).join('、'));
  const it = m.stock[0];
  S.menus.input('up');
  check('用賞金購買：扣款並立刻生效', it.sold && S.run.bounty === 300 - it.price && S.upgrades.count(it.def.id) >= 1, `${it.def.name}，賞金 300 → ${S.run.bounty}`);
  S.menus.input('up');
  check('同一件不能買兩次', S.run.bounty === 300 - it.price && m.note === '已售出');
  S.run.bounty = 10;
  S.menus.input('right'); S.menus.input('up');
  check('賞金不足不能買', S.run.bounty === 10 && !m.stock[1].sold && m.note === '賞金不足');
  S.menus.input('right'); S.menus.input('right'); // 游標到「移除」
  const before = S.upgrades.total;
  S.menus.input('up');
  check('進入移除模式', m.mode === 'remove');
  const victim = S.upgrades.list()[m.rcursor].def;
  S.menus.input('up');
  check('移除一個成長', S.upgrades.total === before - 1 && m.mode === 'buy' && m.removed, `移除 ${victim.name}`);
  S.menus.input('up');
  check('每次進站只能移除一個', m.mode === 'buy' && S.upgrades.total === before - 1);
  S.menus.input('down');
  check('↓ 離開商店', !S.menus.current);

  // 走完整流程：選 PA 分支 → 扣 20 分鐘 → 開商店 → 離開後節點結束、下一個交流道出現
  const R = session([], { mode: 'run' });
  R.flow.options = ['pa', 'pa'];
  const st = R.state, fS = R.flow.forkS;
  st.s = fS - 100; st.vf = 40; R.prev.s = st.s;
  let opened = false, minAtOpen = 0, m0 = 0;
  for (let i = 0; i < 60 * 60 && !opened; i++) {
    m0 = R.clock.minute;
    R.step(DT, { throttle: 0.5, brake: 0, steer: 0 });
    if (R.menus.current) { opened = true; minAtOpen = R.clock.minute - m0; }
  }
  check('進 PA 扣 20 分鐘並開啟商店', opened && R.menus.current.kind === 'shop' && near(minAtOpen, rcfg.nodes.paMinutes, 0.05), `過分歧點後 ${(st.s - fS).toFixed(0)} m`);
  const placed0 = R.flow.forkS;
  for (let i = 0; i < 60; i++) R.step(DT, { throttle: 0, brake: 0, steer: 0 });
  R.menus.input('down');
  for (let i = 0; i < 30; i++) R.step(DT, { throttle: 0.5, brake: 0, steer: 0 });
  check('離開商店後節點結束，下一個交流道出現', R.flow.phase === 'approach' && R.flow.forkS > placed0, `下一個分歧點在 ${(R.flow.forkS - st.s).toFixed(0)} m 外`);
}

console.log(failed ? `\n${failed} 項失敗` : '\n成長系統全部通過');
process.exit(failed ? 1 : 0);
