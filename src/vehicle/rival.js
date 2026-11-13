// 對手：與玩家同一套物理，差異只在車輛數值與個性參數。純邏輯，不依賴 three.js。
// 狀態跟著對決階段走：巡航（等待挑戰）→ 倒數 → 對決 → 駛離。
import { createCarState, stepCar } from './physics.js';
import { drive, createAiMemory } from './ai.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function createRival(baseCfg, rng) {
  return {
    def: null,
    baseCfg,
    cfg: { ...baseCfg },
    st: createCarState(),
    prev: { s: 0, d: 0, psi: 0 },
    mem: createAiMemory(),
    input: {},
    rng,
    active: false,
    mode: 'cruise',
    flash: 0,          // 閃燈回應的剩餘秒數
    blockT: 0, blockD: null, blockRoll: 0,
    mistakeT: 0, inCurve: false,
    slowT: 0,          // 低速累計秒數（除錯與測試用）
    onAlt: false,      // 在交流道的另一條分支上（玩家還沒選路時可能發生）
    intro: false,      // Boss 登場：從後方衝上來，超到玩家前方才開始等待挑戰
    nitroT: 0, nitroCool: 0, // Boss「極速怪物」的氮氣
    proxy: { active: false, s: 0, d: 0, v: 0, len: 4.4, wid: 1.8, changeT: 0, toD: 0 },
  };
}

export function spawnRival(r, def, road, s, lane) {
  const st = r.st;
  r.def = def;
  // def.car：這位對手專屬的車輛數值（例如彎道之王的抓地）
  Object.assign(r.cfg, r.baseCfg, { vMaxKmh: def.topSpeedKmh, power: def.power ?? r.baseCfg.power }, def.car || {});
  Object.assign(st, createCarState({ s, d: road.laneCenter(lane), vf: def.cruiseKmh / 3.6 }));
  st.carHits = 0; st.carHitCool = 0; st.pairCool = 0;
  r.prev.s = st.s; r.prev.d = st.d; r.prev.psi = 0;
  r.mem.lane = lane; r.mem.hold = 0;
  r.active = true; r.mode = 'cruise'; r.onAlt = false;
  r.flash = 0; r.blockT = 0; r.blockD = null; r.mistakeT = 0; r.inCurve = false; r.slowT = 0;
  r.intro = false; r.nitroT = 0; r.nitroCool = 3; st.boostAccel = 0;
}

/**
 * ctx: { road（對手所在的分支）, obstacles, player:{s,d,v}, phase(對決階段), rubber, slip, jctSide(玩家選的那一側) }
 */
export function updateRival(r, dt, ctx) {
  if (!r.active) return;
  const { road, player } = ctx;
  const def = r.def, st = r.st;
  r.prev.s = st.s; r.prev.d = st.d; r.prev.psi = st.psi;
  if (r.flash > 0) r.flash -= dt;

  r.mode = ctx.phase === 'racing' ? 'race' : ctx.phase === 'countdown' ? 'grid' : ctx.phase === 'marked' ? 'cruise' : 'leave';
  const ahead = st.s - player.s; // > 0：對手在玩家前方

  const o = {
    obstacles: ctx.obstacles, mem: r.mem, dt,
    caution: 1.25 - 0.55 * def.aggression,
    margin: 1.55 - 0.4 * def.aggression,
    gripUse: 0.62 + 0.36 * def.cornerSkill,
    topSpeedKmh: def.topSpeedKmh,
    line: false, preferD: null, speedCap: undefined,
  };

  if (r.intro) {
    // Boss 登場：開遠光燈從後方高速逼近，超到玩家前方後才進入等待挑戰
    // 登場時不受自己的極速限制，玩家開再快也追得上來
    o.speedCap = Math.max(player.v + 24, 52);
    o.topSpeedKmh = Math.max(def.topSpeedKmh, o.speedCap * 3.6 + 10);
    r.cfg.vMaxKmh = o.topSpeedKmh;
    st.boostAccel = 6;
    // 這段是演出：不管車流（session 也不讓它撞車），速度不夠就直接補上，保證幾秒內超到玩家前方
    if (st.vf < player.v + 14) st.vf = Math.min(player.v + 14, st.vf + 40 * dt);
    // 走玩家旁邊的車道，不要從正後方撞上來
    const W = road.laneCenter(road.lanes - 1);
    o.preferD = clamp(player.d + (player.d > 0 ? -road.laneWidth : road.laneWidth), -W, W);
    o.caution = 0.8;
    r.flash = 0.2;
    if (ahead > 28) { r.intro = false; st.boostAccel = 0; r.cfg.vMaxKmh = def.topSpeedKmh; }
  } else if (r.mode === 'cruise') {
    // 等待挑戰：離玩家太遠就放慢到車流速度，不會自己跑掉
    const wait = clamp((ahead - 120) / 130, 0, 1);
    o.speedCap = (def.cruiseKmh + (78 - def.cruiseKmh) * wait) / 3.6;
    // Boss 會配合玩家的速度待在前方不遠處，不會一下就被超過去
    if (def.tier === 'boss' && ahead < 90) o.speedCap = Math.max(o.speedCap, Math.min(player.v - 3, def.topSpeedKmh / 3.6));
  } else if (r.mode === 'grid') {
    // 行進中起跑：調整到與玩家並行或稍前；玩家若在正後方就只拉近，不擋到被追撞
    const sameLane = Math.abs(player.d - st.d) < 2.4;
    const lead = sameLane ? 9 : 3;
    const want = player.v + (player.s + lead - st.s) * 0.6;
    // 下限取「玩家速度與巡航速度較低者」：不會為了等玩家而一路減速，逼玩家跟著煞車
    const floor = Math.max(12, Math.min(player.v, def.cruiseKmh / 3.6) - 2);
    o.speedCap = clamp(want, floor, Math.max(floor, player.v + 10));
    o.caution = 1.3;
  } else if (r.mode === 'race') {
    o.line = true;
    // 橡皮筋（可關閉）：落後時極速略增、領先時略減
    let top = def.topSpeedKmh;
    if (ctx.rubber?.enabled) top *= ahead < 0 ? ctx.rubber.behind : ctx.rubber.ahead;
    o.topSpeedKmh = top;
    r.cfg.vMaxKmh = top;

    // 卡位：玩家在後方 25 m 內時，有機率切到玩家車道。Boss「終極對手」持續卡位、範圍更遠
    const blocker = def.special === 'blocker';
    r.blockRoll -= dt;
    if (r.blockT > 0) { r.blockT -= dt; if (r.blockT <= 0) r.blockD = null; }
    if (r.blockRoll <= 0) {
      r.blockRoll = blocker ? 0.4 : 1.2;
      if (ahead > 3 && ahead < (blocker ? 38 : 25) && r.rng.next() < def.block) { r.blockD = player.d; r.blockT = blocker ? 0.9 : 1.6; }
    }

    // Boss「極速怪物」：前方夠直就開氮氣
    if (def.special === 'nitro') {
      const nz = def.nitro;
      if (r.nitroT > 0) {
        r.nitroT -= dt;
        o.topSpeedKmh = top * nz.topMul; r.cfg.vMaxKmh = o.topSpeedKmh;
        st.boostAccel = nz.accel;
        if (r.nitroT <= 0) { st.boostAccel = 0; r.nitroCool = nz.cooldown; }
      } else {
        r.nitroCool -= dt;
        if (r.nitroCool <= 0) {
          let straight = true;
          for (let a = 0; a <= nz.straightAhead; a += 20) if (Math.abs(road.curvature(st.s + a)) > 0.0012) { straight = false; break; }
          if (straight) { r.nitroT = nz.seconds; if (ctx.onNitro) ctx.onNitro(); } else r.nitroCool = 0.5;
        }
      }
    }
    if (r.blockD != null) o.preferD = clamp(r.blockD, -road.laneCenter(road.lanes - 1), road.laneCenter(road.lanes - 1));

    // 失誤：偶爾進彎太快，會推頭擦牆
    const sharp = Math.abs(road.curvature(st.s + 90)) > 0.006;
    if (sharp && !r.inCurve && r.rng.next() < def.mistake * 0.6) r.mistakeT = 4;
    r.inCurve = sharp;
    if (r.mistakeT > 0) { r.mistakeT -= dt; o.gripUse *= 1.32; }
  } else {
    // 駛離：減速靠左
    o.speedCap = 60 / 3.6;
    o.preferD = road.laneCenter(0);
  }
  if (r.mode !== 'race' && !r.intro) { r.cfg.vMaxKmh = def.topSpeedKmh; if (r.nitroT > 0 || st.boostAccel) { r.nitroT = 0; st.boostAccel = 0; } }

  // 交流道：跟著玩家走同一側。接近分歧時不走賽車線、不卡位，專心靠到那一側
  if (ctx.jctSide && (road.zoneAt(st.s) === 1 || road.zoneAt(st.s) === 2 || road.zoneAt(st.s + 160) === 1 || road.zoneAt(st.s + 160) === 2)) {
    o.line = false;
    o.preferD = ctx.jctSide * 4.6;
  }

  st.dragMul = ctx.slip ? 1 - r.cfg.slipstreamDragCut : 1;
  drive(st, r.cfg, road, o, r.input);
  stepCar(st, r.input, r.cfg, road, dt, null);
  if (st.vf < 8 && r.mode === 'race') r.slowT += dt;

  const p = r.proxy;
  p.active = true; p.s = st.s; p.d = st.d; p.v = st.vf; p.toD = st.d; p.onAlt = r.onAlt;
}
