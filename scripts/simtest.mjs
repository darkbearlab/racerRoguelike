// 無畫面驗收：無限道路、車流、物理、對決。執行：npm run simtest
import { readFileSync } from 'node:fs';
import { createRoad, DS } from '../src/road/spline.js';
import { createGenerator } from '../src/road/generator.js';
import { createCarState, stepCar } from '../src/vehicle/physics.js';
import { autopilot, createAiMemory } from '../src/vehicle/ai.js';
import { createTraffic } from '../src/vehicle/traffic.js';
import { collidePlayerTraffic } from '../src/vehicle/collide.js';
import { createRng } from '../src/core/rng.js';
import { createEvents } from '../src/core/events.js';
import { createDuel } from '../src/race/duel.js';
import { createSession } from '../src/race/session.js';
import { JCT } from '../src/road/junction.js';

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const cfg = load('../src/config/cars.json').player;
const zone = load('../src/config/zones.json').default;
const tcfg = load('../src/config/traffic.json');
const dcfg = load('../src/config/duel.json');
const allRivals = load('../src/config/rivals.json').list;
const rivals = allRivals.filter((r) => r.tier === 'normal');
const rcfg = load('../src/config/run.json');
const DT = 1 / 60;
const AHEAD = 2800, BEHIND = 520;
let failed = 0;
const check = (name, ok, info = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`);
};
const section = (t) => console.log(`\n── ${t}`);

function world(seed) {
  const rng = createRng(seed);
  const road = createRoad(zone.road);
  const gen = createGenerator(road, rng, zone);
  gen.fill(AHEAD);
  return { rng, road, gen };
}
const advanceRoad = (w, s) => { w.gen.fill(s + AHEAD); w.road.trim(s - BEHIND); };
const over = (st, road) => Math.max(st.d - (road.widthRight(st.s) - cfg.halfWidth), -st.d - (road.widthLeft(st.s) - cfg.halfWidth));

section('道路生成');
{
  const w = world(7);
  let maxKink = 0, maxHead = 0, minSelf = Infinity, prevTheta = 0, seen = 0;
  for (let s = 0; s < 300000; s += 400) {
    advanceRoad(w, s);
    for (let i = Math.max(seen, w.road.iMin + 1); i <= w.road.iMax; i++) {
      const th = w.road.nodeTheta(i);
      maxKink = Math.max(maxKink, Math.abs(th - prevTheta));
      maxHead = Math.max(maxHead, Math.abs(th));
      prevTheta = th;
    }
    seen = w.road.iMax + 1;
    if (s % 4000 === 0) {
      for (let i = w.road.iMin; i < w.road.iMax; i += 10) {
        for (let j = i + 120; j < w.road.iMax; j += 10) {
          const dd = Math.hypot(w.road.nodeX(i) - w.road.nodeX(j), w.road.nodeZ(i) - w.road.nodeZ(j));
          if (dd < minSelf) minSelf = dd;
        }
      }
    }
  }
  const st = w.gen.stats;
  check('生成 300 km：接點無折角', maxKink < 0.07, `相鄰取樣點最大轉角 ${(maxKink * 57.3).toFixed(2)}°（每 ${DS} m）`);
  check('生成 300 km：朝向受限', maxHead < (zone.maxHeadingDeg + 1) / 57.3, `最大偏離 ${(maxHead * 57.3).toFixed(0)}°`);
  check('生成 300 km：視窗內不自我交叉', minSelf > 60, `相隔 240 m 以上的路段最近 ${minSelf.toFixed(0)} m`);
  check('生成 300 km：各類路段都有出現', Object.entries(st).every(([k, n]) => k === 'junction' || n > 0),
    Object.entries(st).map(([k, n]) => `${k} ${n}`).join('、'));
  check('道路緩衝區不成長', w.road.iMax - w.road.iMin < 2048, `視窗 ${(w.road.iMax - w.road.iMin) * DS} m`);
}

section('車流（自動駕駛 20 分鐘，無對手）');
{
  const S = createSession({ seed: 20261112, carCfg: cfg, zone, trafficCfg: tcfg, duelCfg: dcfg, rivals, mode: 'free' });
  const { state: st, traffic, road } = S;
  const inp = {}, mem = createAiMemory();
  let bad = false, maxOver = 0, overlaps = 0, maxCount = 0, slow = 0, vmax = 0, heap0 = 0;
  for (let i = 0; i < 20 * 60 * 60; i++) {
    autopilot(st, cfg, road, { traffic: S.obsForPlayer, mem, dt: DT }, inp);
    S.step(DT, inp);
    if (!Number.isFinite(st.s + st.d + st.psi + st.vf + st.vl)) bad = true;
    maxOver = Math.max(maxOver, over(st, road));
    maxCount = Math.max(maxCount, traffic.count);
    vmax = Math.max(vmax, st.vf);
    if (i > 600 && st.vf < 30 / 3.6) slow += DT;
    if (i % 6 === 0) {
      const cs = traffic.cars;
      for (let a = 0; a < cs.length; a++) {
        if (!cs[a].active) continue;
        for (let b = a + 1; b < cs.length; b++) {
          if (!cs[b].active) continue;
          if (Math.abs(cs[a].s - cs[b].s) < (cs[a].len + cs[b].len) / 2 && Math.abs(cs[a].d - cs[b].d) < (cs[a].wid + cs[b].wid) / 2) overlaps++;
        }
      }
    }
    if (i === 3600) { globalThis.gc?.(); heap0 = process.memoryUsage().heapUsed; }
  }
  globalThis.gc?.();
  const heap1 = process.memoryUsage().heapUsed;
  check('數值正常', !bad);
  check('不穿牆', maxOver < 1e-6, `超出護欄最多 ${Math.max(0, maxOver).toFixed(3)} m`);
  check('不卡住', slow < 20, `低於 30 km/h 共 ${slow.toFixed(1)} 秒`);
  check('車流不重疊', overlaps === 0, `重疊判定 ${overlaps} 次`);
  check('車流數量受限', maxCount <= tcfg.maxCars, `同時最多 ${maxCount} 台（上限 ${tcfg.maxCars}），共生成 ${traffic.spawned}、回收 ${traffic.recycled}、變換車道 ${traffic.laneChanges} 次`);
  check('模擬記憶體不成長', !heap0 || heap1 - heap0 < 4e6,
    globalThis.gc ? `第 1 分鐘 ${(heap0 / 1e6).toFixed(1)} MB → 第 20 分鐘 ${(heap1 / 1e6).toFixed(1)} MB` : '未加 --expose-gc，僅供參考');
  console.log(`      行駛 ${(st.dist / 1000).toFixed(1)} km，極速 ${(vmax * 3.6).toFixed(0)} km/h，平均 ${((st.dist / 1200) * 3.6).toFixed(0)} km/h，碰牆 ${st.wallHits} 次，撞車 ${st.carHits || 0} 次`);
}

section('亂數輸入與碰撞');
{
  const w = world(99);
  const rng = createRng(12345);
  const traffic = createTraffic(w.road, w.rng, tcfg);
  const st = createCarState({ s: 20 });
  const player = { s: st.s, d: 0, v: 0 };
  traffic.populate(player);
  const inp = { throttle: 1, brake: 0, steer: 0, handbrake: false };
  let bad = false, maxOver = 0, odo = 0, prev = st.s;
  for (let i = 0; i < 300 * 60; i++) {
    advanceRoad(w, st.s);
    if (i % 20 === 0) {
      inp.throttle = rng.next() < 0.8 ? 1 : 0;
      inp.brake = rng.next() < 0.15 ? 1 : 0;
      inp.steer = rng.pick([-1, -0.4, 0, 0, 0.4, 1]);
      inp.handbrake = rng.next() < 0.12;
    }
    stepCar(st, inp, cfg, w.road, DT);
    player.s = st.s; player.d = st.d; player.v = st.vf;
    traffic.update(DT, player);
    collidePlayerTraffic(st, cfg, traffic, tcfg, w.road, DT);
    odo += Math.abs(st.s - prev); prev = st.s;
    if (!Number.isFinite(st.s + st.d + st.psi + st.vf + st.vl)) bad = true;
    maxOver = Math.max(maxOver, over(st, w.road));
  }
  check('亂數輸入 5 分鐘：數值正常', !bad);
  check('亂數輸入 5 分鐘：不穿牆', maxOver < 0.02, `超出護欄最多 ${Math.max(0, maxOver).toFixed(3)} m，碰牆 ${st.wallHits} 次，撞車 ${st.carHits || 0} 次`);
  check('亂數輸入 5 分鐘：沒有卡死', odo > 3000, `總里程 ${(odo / 1000).toFixed(1)} km`);

  const w2 = world(5);
  const tr2 = createTraffic(w2.road, w2.rng, tcfg);
  const s2 = createCarState({ s: 100, vf: 250 / 3.6 });
  const c = tr2.cars[0];
  Object.assign(c, { active: true, s: 140, d: 0, v: 25, cruise: 25, lane: 1, toLane: 1 });
  let hit = false;
  for (let i = 0; i < 120 && !hit; i++) {
    stepCar(s2, { throttle: 1, brake: 0, steer: 0 }, cfg, w2.road, DT);
    hit = collidePlayerTraffic(s2, cfg, tr2, tcfg, w2.road, DT) > 0;
  }
  check('追撞大幅減速', hit && s2.vf * 3.6 < 140, `250 → ${(s2.vf * 3.6).toFixed(0)} km/h，前車被推到 ${(c.v * 3.6).toFixed(0)} km/h`);
}

section('對決規則');
{
  // 直接餵位置給計分器，逐條核對規格
  const ev = createEvents();
  const zeros = [];
  ev.on('duelZero', (e) => zeros.push(e.who));
  const d = createDuel(dcfg, ev);
  const p = { s: 0, v: 50 }, r = { s: 20 };
  d.mark('normal');
  check('挑戰範圍 40 m 內才可挑戰', d.canChallenge(p, r) && !d.canChallenge(p, { s: 60 }) && !d.canChallenge(p, { s: -20 }));
  d.challenge();
  p.s = 200; // 倒數期間就算拉開也不計分
  for (let i = 0; i < 179; i++) d.update(DT, p, r);
  check('倒數期間不計分', d.phase === 'countdown' && d.scoreP === 0);
  for (let i = 0; i < 3; i++) d.update(DT, p, r);
  check('倒數 3 秒後開始', d.phase === 'racing');

  const run = (gap, sec) => { p.s = r.s + gap; for (let i = 0; i < sec * 60; i++) d.update(DT, p, r); };
  d.scoreP = 0; d.scoreR = 0; d.leader = 0;
  run(30, 2);
  check('領先 30 m（門檻內）不得分', d.scoreP === 0 && d.leader === 1);
  run(40.001, 1);
  check('領先剛過 40 m：每秒 8 分', Math.abs(d.scoreP - 8) < 0.1, `1 秒得 ${d.scoreP.toFixed(2)} 分`);
  const before = d.scoreP;
  run(140, 1);
  check('領先 140 m：每秒 16 分', Math.abs(d.scoreP - before - 16) < 0.1, `1 秒得 ${(d.scoreP - before).toFixed(2)} 分`);
  const b2 = d.scoreP;
  run(390, 1);
  check('得分速度上限每秒 24 分', Math.abs(d.scoreP - b2 - 24) < 0.1, `1 秒得 ${(d.scoreP - b2).toFixed(2)} 分`);
  const kept = d.scoreP;
  run(-3, 1);
  check('並排（對方只領先 3 m）不歸零', d.scoreP === kept && zeros.length === 0);
  run(-6, 0.1);
  check('被超車（對方領先超過 5 m）分數歸零', d.scoreP === 0 && zeros[0] === 'player');
  run(-100, 2);
  check('對手領先時只有對手得分', d.scoreP === 0 && d.scoreR > 20, `對手 ${d.scoreR.toFixed(1)} 分`);
  run(50, 0.1);
  check('超回去：對手分數歸零', d.scoreR === 0 && zeros[1] === 'rival');
  run(390, 5);
  check('先達 100 分者勝', d.phase === 'result' && d.result.win && d.result.reason === 'score');

  const d2 = createDuel(dcfg);
  d2.mark(); d2.challenge();
  for (let i = 0; i < 181; i++) d2.update(DT, p, r);
  p.s = r.s - 401; d2.update(DT, p, r); d2.update(DT, p, r);
  check('差距達 400 m：領先者直接獲勝', d2.phase === 'result' && !d2.result.win && d2.result.reason === 'breakaway');

  const d3 = createDuel(dcfg);
  d3.mark(); d3.challenge();
  const slowP = { s: 0, v: 5 };
  for (let i = 0; i < 181 + 4.9 * 60; i++) d3.update(DT, slowP, { s: 0 });
  const stillOn = d3.phase === 'racing';
  for (let i = 0; i < 12; i++) d3.update(DT, slowP, { s: 0 });
  check('低於 30 km/h 超過 5 秒判負', stillOn && d3.phase === 'result' && d3.result.reason === 'stopped');

  // 彎道上內線比較短：同速度下內側車的 s 增加較快，差距以 s 計算所以正確
  const w = world(3);
  let sc = 0;
  while (Math.abs(w.road.curvature(sc)) < 0.006 && sc < 20000) { sc += 10; advanceRoad(w, sc); }
  const k = w.road.curvature(sc);
  const inner = createCarState({ s: sc, d: -Math.sign(k) * 3.5, vf: 30 });
  const outer = createCarState({ s: sc, d: Math.sign(k) * 3.5, vf: 30 });
  const hold = (st) => { const s0 = st.s; stepCar(st, { throttle: 0.3, brake: 0, steer: 0 }, cfg, w.road, DT); return st.s - s0; };
  const di = hold(inner), dout = hold(outer);
  const expect = (1 + Math.abs(k) * 3.5) / (1 - Math.abs(k) * 3.5);
  check('彎道差距：內線同速時 s 推進較快', Math.abs(di / dout - expect) < 0.002, `R=${Math.abs(1 / k).toFixed(0)} m，內/外 = ${(di / dout).toFixed(4)}（理論 ${expect.toFixed(4)}）`);
}

section('完整對決（自動駕駛的玩家 vs 每位對手）');
const tally = rivals.map(() => ({ win: 0, lose: 0, time: 0, zeros: 0 }));
for (let ri = 0; ri < rivals.length; ri++) {
  for (const seed of [11, 12, 13, 14, 15, 16, 17, 18]) {
    const ev = createEvents();
    let zeros = 0;
    ev.on('duelZero', () => zeros++);
    const S = createSession({ seed: seed * 1000 + ri, carCfg: cfg, zone, trafficCfg: tcfg, duelCfg: dcfg, rivals, events: ev, mode: 'loop' });
    S.rivalIndex = ri;
    const inp = {}, mem = createAiMemory();
    let t = 0, maxOverR = 0, bad = false, challengedAt = -1, sawGridOk = true, minGap = Infinity, maxGap = -Infinity, slowR = 0;
    while (t < 420 && !(S.duel.phase === 'result')) {
      autopilot(S.state, cfg, S.road, { traffic: S.obsForPlayer, mem, dt: DT, line: true, gripUse: 0.85, caution: 0.85, margin: 1.25 }, inp);
      S.step(DT, inp);
      t += DT;
      if (S.duel.phase === 'marked' && S.tryChallenge()) challengedAt = t;
      if (S.rival.active) {
        const rs = S.rival.st;
        if (!Number.isFinite(rs.s + rs.d + rs.vf + rs.psi)) bad = true;
        maxOverR = Math.max(maxOverR, over(rs, S.road));
        if (S.duel.phase === 'racing') {
          minGap = Math.min(minGap, S.duel.gap); maxGap = Math.max(maxGap, S.duel.gap);
          if (rs.vf < 30 / 3.6) slowR += DT;
        }
        if (S.duel.phase === 'countdown' && (S.duel.scoreP > 0 || S.duel.scoreR > 0)) sawGridOk = false;
      }
    }
    const d = S.duel, name = rivals[ri].name;
    const ok = d.phase === 'result' && challengedAt > 0 && !bad && maxOverR < 0.02 && sawGridOk && slowR < 6;
    if (d.phase === 'result') { const y = tally[ri]; d.result.win ? y.win++ : y.lose++; y.time += d.result.time; y.zeros += zeros; }
    if (!ok || seed <= 12) check(`${name}（seed ${seed}）：可完整打完`, ok,
      d.phase === 'result'
        ? `${d.result.win ? '玩家勝' : '對手勝'}（${d.result.reason}）用時 ${d.result.time.toFixed(0)} 秒，${Math.round(d.scoreP)} : ${Math.round(d.scoreR)}，差距 ${minGap.toFixed(0)}～${maxGap.toFixed(0)} m，歸零 ${zeros} 次，對手碰牆 ${S.rival.st.wallHits}、撞車 ${S.rival.st.carHits || 0}、低速 ${slowR.toFixed(1)} 秒`
        : `7 分鐘內未結束，階段 ${d.phase}，${Math.round(d.scoreP)} : ${Math.round(d.scoreR)}，差距 ${d.gap.toFixed(0)} m`);
  }
}

console.log('      各 8 場統計（玩家由自動駕駛代打，僅供平衡參考）：');
tally.forEach((y, i) => console.log(`      ${rivals[i].name}：玩家 ${y.win} 勝 ${y.lose} 敗，平均 ${(y.time / (y.win + y.lose || 1)).toFixed(0)} 秒，歸零共 ${y.zeros} 次`));

section('對手 AI 不卡牆（三位對手各獨自跑 10 分鐘對決狀態）');
for (const def of rivals) {
  const S = createSession({ seed: 777, carCfg: cfg, zone, trafficCfg: tcfg, duelCfg: { ...dcfg, targets: { normal: 1e9 }, breakaway: 1e9 }, rivals: [def], mode: 'loop' });
  const inp = {}, mem = createAiMemory();
  let t = 0, slow = 0, stuck = 0, maxStuck = 0, maxOverR = 0;
  while (t < 600) {
    // 玩家以定速跟在附近，讓車流與對手都維持在模擬範圍內
    autopilot(S.state, cfg, S.road, { traffic: S.obsForPlayer, mem, dt: DT, speedCap: S.rival.active ? Math.max(20, S.rival.st.vf + (S.rival.st.s - S.state.s - (S.duel.phase === 'racing' ? 80 : 20)) * 0.25) : 45 }, inp);
    S.step(DT, inp);
    t += DT;
    if (S.duel.phase === 'marked') S.tryChallenge();
    if (S.duel.phase === 'racing') {
      const rs = S.rival.st;
      maxOverR = Math.max(maxOverR, over(rs, S.road));
      if (rs.vf < 30 / 3.6) { slow += DT; stuck += DT; maxStuck = Math.max(maxStuck, stuck); } else stuck = 0;
    }
  }
  const rs = S.rival.st;
  check(`${def.name}：不卡住、不穿牆`, maxStuck < 3 && maxOverR < 0.02 && S.duel.time > 500,
    `對決狀態 ${S.duel.time.toFixed(0)} 秒，行駛 ${(rs.dist / 1000).toFixed(1)} km，碰牆 ${rs.wallHits} 次、撞車 ${rs.carHits || 0} 次，低於 30 km/h 共 ${slow.toFixed(1)} 秒（最長連續 ${maxStuck.toFixed(1)} 秒）`);
}

section('交流道幾何（連續生成 60 個）');
{
  const w = world(31);
  let minSep = Infinity, maxKink = 0, shared = true, widthsOk = true, n = 0, minInner = Infinity;
  let s = 0;
  for (let k = 0; k < 60; k++) {
    advanceRoad(w, s);
    const { alt, forkS } = w.gen.insertJunction(s + 900);
    w.gen.fill(forkS + 1600, alt);
    w.gen.fill(forkS + 2800);
    const iF = forkS / DS;
    shared = shared && w.road.nodeX(iF) === alt.nodeX(iF) && w.road.nodeZ(iF) === alt.nodeZ(iF) && w.road.fork.side === -1 && alt.fork.side === 1;
    const fa = { p: [0, 0, 0], t: [0, 0, 0], r: [0, 0, 0], u: [0, 0, 0] }, fb = { p: [0, 0, 0], t: [0, 0, 0], r: [0, 0, 0], u: [0, 0, 0] };
    for (let i = iF + 1; i <= iF + 400; i++) {
      // 左分支的右護欄與右分支的左護欄之間的距離
      w.road.frame(i * DS, fa); alt.frame(i * DS, fb);
      const ax = fa.p[0] + fa.r[0] * fa.wr, az = fa.p[2] + fa.r[2] * fa.wr;
      const bx = fb.p[0] - fb.r[0] * fb.wl, bz = fb.p[2] - fb.r[2] * fb.wl;
      // 以左分支的右向量投影，正值 = 兩道牆沒有交錯
      const sep = (bx - ax) * fa.r[0] + (bz - az) * fa.r[2];
      if (i <= iF + 150) minSep = Math.min(minSep, sep);
      if (fa.wr < 0 || fb.wl < 0 || fa.wl < 4 || fb.wr < 4) widthsOk = false;
      if (i > iF + 2) minInner = Math.min(minInner, fa.wl + fa.wr - 2 * cfg.halfWidth);
      maxKink = Math.max(maxKink, Math.abs(w.road.nodeTheta(i) - w.road.nodeTheta(i - 1)), Math.abs(alt.nodeTheta(i) - alt.nodeTheta(i - 1)));
    }
    // 隨機選一邊繼續
    if (k % 2) w.road.swapWith(alt);
    s = forkS + 700;
    n++;
  }
  check('兩條分支共用分歧點', shared);
  check('兩條分支的內側護欄不交錯', minSep > -0.02, `分歧後 300 m 內最小間距 ${minSep.toFixed(2)} m`);
  check('分支寬度合理', widthsOk && minInner > 2, `可行駛寬度最窄 ${minInner.toFixed(1)} m（扣掉車寬）`);
  check('分支無折角', maxKink < 0.07, `最大轉角 ${(maxKink * 57.3).toFixed(2)}°（每 ${DS} m）`);
  check('連續插入 60 個交流道', n === 60 && w.road.iMax - w.road.iMin < 2048, `朝向最後 ${w.gen.heading.toFixed(0)}°`);
}

section('通過分歧點：各種橫向位置與速度');
{
  let bad = 0, wrongSide = 0, stuck = 0, hitsMid = 0, total = 0, maxOver = 0;
  for (const kmh of [60, 150, 250]) {
    for (let d0 = -6.8; d0 <= 6.81; d0 += 0.2) {
      const S = createSession({ seed: 4242, carCfg: cfg, zone, trafficCfg: { ...tcfg, densityPerKm: 0 }, duelCfg: dcfg, rivals: allRivals, runCfg: rcfg });
      const st = S.state;
      const fS = S.flow.forkS;
      st.s = fS - 120; st.d = d0; st.vf = kmh / 3.6;
      S.prev.s = st.s;
      const inp = { throttle: 0.6, brake: 0, steer: 0, handbrake: false };
      let dAtFork = null, minV = Infinity;
      for (let i = 0; i < 60 * 40 && st.s < fS + 320; i++) {
        const before = st.s;
        S.step(DT, inp);
        if (dAtFork === null && S.flow.chosen) dAtFork = st.d;
        if (before >= fS - 60) minV = Math.min(minV, st.vf);
        if (!Number.isFinite(st.s + st.d + st.vf)) bad++;
        maxOver = Math.max(maxOver, over(st, S.road));
      }
      total++;
      if (st.s < fS + 300) stuck++;
      if (minV < kmh / 3.6 * 0.5) hitsMid++;
      if (dAtFork !== null && Math.sign(dAtFork) !== S.road.fork?.side && S.road.fork) wrongSide++;
    }
  }
  check('不卡在中間', stuck === 0 && bad === 0, `${total} 種組合全部通過分歧點`);
  check('通過後都在護欄內', maxOver < 0.02, `超出護欄最多 ${Math.max(0, maxOver).toFixed(3)} m`);
  check('左半進左分支、右半進右分支', wrongSide === 0);
  check('撞上分隔島不會被扣到停', hitsMid === 0, `速度掉到一半以下的組合 ${hitsMid} 個`);
}

section('完整一晚（自動駕駛跑到天亮）');
{
  const ev = createEvents();
  const log = { placed: 0, chosen: [], nodes: {}, pa: 0, swaps: 0, cleared: 0 };
  ev.on('jctPlaced', () => log.placed++);
  ev.on('forkChosen', (e) => { log.chosen.push(e.side); log.nodes[e.node] = (log.nodes[e.node] || 0) + 1; });
  ev.on('pa', () => log.pa++);
  ev.on('forkSwap', () => log.swaps++);
  ev.on('altCleared', () => log.cleared++);
  const S = createSession({ seed: 20261112, carCfg: cfg, zone, trafficCfg: tcfg, duelCfg: dcfg, rivals: allRivals, runCfg: rcfg, events: ev });
  const st = S.state, inp = {}, mem = createAiMemory();
  let t = 0, bad = false, maxOver = 0, maxOverR = 0, slow = 0, rivalOnAltAfterChoice = 0, overlaps = 0, n = 0;
  let wantSide = 1;
  while (!S.over && t < 1500) {
    // 交流道前靠向要選的那一側（左右輪流，確保兩種都測到）
    const z = S.road.zoneAt(st.s + 150), z0 = S.road.zoneAt(st.s);
    const approaching = !S.flow.chosen && (z === 1 || z === 2 || z0 === 1 || z0 === 2);
    autopilot(st, cfg, S.road, { traffic: S.obsForPlayer, mem, dt: DT, line: !approaching, caution: 0.85, margin: 1.25, preferD: approaching ? wantSide * 4.6 : null }, inp);
    const wasChosen = S.flow.chosen;
    S.step(DT, inp);
    if (!wasChosen && S.flow.chosen) wantSide = -wantSide;
    t += DT; n++;
    if (S.duel.phase === 'marked') S.tryChallenge();
    if (!Number.isFinite(st.s + st.d + st.psi + st.vf)) bad = true;
    maxOver = Math.max(maxOver, over(st, S.road));
    if (t > 10 && st.vf < 30 / 3.6) slow += DT;
    if (S.rival.active) {
      if (S.flow.chosen && S.rival.onAlt) rivalOnAltAfterChoice++;
      if (!S.rival.onAlt) maxOverR = Math.max(maxOverR, over(S.rival.st, S.road));
    }
    if (n % 6 === 0) {
      const cs = S.traffic.cars;
      for (let a = 0; a < cs.length; a++) {
        if (!cs[a].active) continue;
        for (let b = a + 1; b < cs.length; b++) {
          if (!cs[b].active || cs[a].onAlt !== cs[b].onAlt) continue;
          if (Math.abs(cs[a].s - cs[b].s) < (cs[a].len + cs[b].len) / 2 && Math.abs(cs[a].d - cs[b].d) < (cs[a].wid + cs[b].wid) / 2) overlaps++;
        }
      }
    }
  }
  const expect = (300 - S.run.penaltyMin - log.pa * rcfg.nodes.paMinutes) * 60 / rcfg.clock.gameSecondsPerRealSecond;
  check('天亮時這一局結束', S.over?.reason === 'dawn', `現實 ${t.toFixed(0)} 秒（00:00 → 05:00，扣掉懲罰後應為 ${expect.toFixed(0)} 秒）`);
  check('時鐘速度與懲罰正確', Math.abs(t - expect) < 1.5);
  check('數值正常、不穿牆', !bad && maxOver < 0.02 && maxOverR < 0.02, `玩家超出 ${Math.max(0, maxOver).toFixed(3)} m，對手超出 ${Math.max(0, maxOverR).toFixed(3)} m`);
  check('不卡住', slow < 15, `低於 30 km/h 共 ${slow.toFixed(1)} 秒`);
  check('交流道持續出現、左右都選得到', log.placed >= 6 && log.chosen.includes(-1) && log.chosen.includes(1),
    `出現 ${log.placed} 個，選了 ${log.chosen.length} 次（左 ${log.chosen.filter((x) => x < 0).length}、右 ${log.chosen.filter((x) => x > 0).length}），交換分支 ${log.swaps} 次，回收另一條 ${log.cleared} 次`);
  check('節點會開始（種類的涵蓋在 runtest 驗證）', Object.keys(log.nodes).length >= 1 && log.chosen.length >= 4, Object.entries(log.nodes).map(([k, v]) => `${k} ${v}`).join('、'));
  check('選路後對手不會留在另一條分支', rivalOnAltAfterChoice === 0);
  check('車流不重疊（含交流道）', overlaps === 0, `重疊判定 ${overlaps} 次`);
  console.log(`      行駛 ${(st.dist / 1000).toFixed(1)} km，擊敗 ${S.run.defeats}、落敗 ${S.run.losses}、略過 ${S.run.skipped}，PA ${log.pa} 次，時間懲罰共 ${S.clock.penaltyTotal} 分鐘，碰牆 ${st.wallHits}、撞車 ${st.carHits || 0}`);
}

section('對決中遇到分歧：對手會跟上');
{
  let cases = 0, followed = 0, stillDuel = 0, maxOverR = 0, moved = 0, tookLeft = 0, tookRight = 0;
  for (const side of [-1, 1]) {
    for (const lead of [30, -30, 70, -70]) {
      for (const seed of [1, 2, 3]) {
        const S = createSession({ seed: 9000 + seed, carCfg: cfg, zone, trafficCfg: tcfg, duelCfg: { ...dcfg, targets: { normal: 1e9, elite: 1e9 }, breakaway: 1e9 }, rivals: allRivals, runCfg: rcfg });
        const st = S.state, inp = {}, mem = createAiMemory();
        // 直接在交流道前開一場對決：對手在玩家前方或後方 lead 公尺
        const fS = S.flow.forkS;
        S.flow.options = ['pa', 'pa']; // 這個測試只看過分歧，節點內容不重要
        st.s = fS - 700; st.vf = 45; S.prev.s = st.s;
        S.spawnRival(allRivals[seed % 3], st.s + Math.abs(lead) + 20);
        S.rival.st.s = st.s + lead; S.rival.st.vf = 45;
        S.duel.challenge();
        for (let i = 0; i < 200; i++) S.duel.update(DT, st, S.rival.st);
        let wasAlt = false;
        for (let i = 0; i < 60 * 40 && st.s < fS + 300; i++) {
          const approaching = !S.flow.chosen;
          autopilot(st, cfg, S.road, { traffic: S.obsForPlayer, mem, dt: DT, speedCap: 50, preferD: approaching ? side * 4.6 : null }, inp);
          S.step(DT, inp);
          if (S.rival.onAlt) wasAlt = true;
          if (S.rival.active && !S.rival.onAlt) maxOverR = Math.max(maxOverR, over(S.rival.st, S.road));
        }
        cases++;
        if (wasAlt) moved++;
        const rs = S.rival.st;
        if (S.road.fork.side < 0) tookLeft++; else tookRight++;
        // 主線永遠是玩家選的那條；對手必須在主線上、位置合理
        if (S.rival.active && !S.rival.onAlt && S.flow.chosen && Math.abs(rs.s - st.s) < 900) followed++;
        else console.log('      未跟上：', JSON.stringify({ side, lead, seed, active: S.rival.active, onAlt: S.rival.onAlt, forkSide: S.road.fork?.side, ds: +(rs.s - st.s).toFixed(0), rd: +rs.d.toFixed(1), pd: +st.d.toFixed(1), phase: S.duel.phase, chosen: S.flow.chosen, ps: +(st.s - fS).toFixed(0) }));
        if (S.duel.phase === 'racing') stillDuel++;
      }
    }
  }
  check('對手與玩家在同一條分支', followed === cases, `${followed} / ${cases} 種情況（對手領先或落後 30、70 m；玩家走左 ${tookLeft} 次、走右 ${tookRight} 次）；其中 ${moved} 次是先進了另一條、玩家選路時被移過來`);
  check('對決持續進行', stillDuel === cases, `${stillDuel} / ${cases}`);
  check('對手過分歧後在護欄內', maxOverR < 0.02, `超出護欄最多 ${Math.max(0, maxOverR).toFixed(3)} m`);
}

section('性能數字對照規格');
{
  const w = world(1);
  const st = createCarState({ s: 20 });
  let t = 0;
  while (st.vf < 100 / 3.6 && t < 30) { stepCar(st, { throttle: 1, brake: 0, steer: 0 }, cfg, w.road, DT); t += DT; }
  const st2 = createCarState({ s: 20, vf: 100 / 3.6 });
  let tb = 0;
  while (st2.vf > 0.1 && tb < 30) { stepCar(st2, { throttle: 0, brake: 1, steer: 0 }, cfg, w.road, DT); tb += DT; }
  check('0–100 km/h 約 4.5 秒', Math.abs(t - 4.5) < 0.6, `${t.toFixed(2)} 秒`);
  check('100→0 km/h 約 3 秒', Math.abs(tb - 3) < 0.5, `${tb.toFixed(2)} 秒`);
}

console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
