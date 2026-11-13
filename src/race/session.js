// 一場遊戲的全部模擬狀態與每步更新順序。純邏輯，不依賴 three.js，
// 瀏覽器（main.js）與無畫面測試（scripts/simtest.mjs）跑的是同一份。
//
// 更新順序：道路串流 → 選路判定 → 玩家車 → 車流 → 對手 → 碰撞 → 對決計分 → 節點流程 → 時鐘
//
// mode：
//   'run'   正式流程：交流道選路 → 節點（對手／強敵／PA）→ 下一個交流道，受天亮時鐘限制
//   'loop'  只有對手一位接一位出現（M3 的行為，測試用）
//   'free'  沒有對手也沒有交流道（測試用）
import { createRng } from '../core/rng.js';
import { createRoad } from '../road/spline.js';
import { createGenerator } from '../road/generator.js';
import { JCT } from '../road/junction.js';
import { createCarState, stepCar } from '../vehicle/physics.js';
import { createTraffic } from '../vehicle/traffic.js';
import { collidePlayerTraffic, collidePair } from '../vehicle/collide.js';
import { createRival, spawnRival, updateRival } from '../vehicle/rival.js';
import { createDuel } from './duel.js';
import { createClock } from './clock.js';
import { NODE_TYPES, EVENT_NAMES, rollOptions, rollEvent } from './nodes.js';
import { createMenus } from './menu.js';
import { createEvents } from '../core/events.js';
import { createUpgrades } from '../upgrades/upgrades.js';
import { drive, createAiMemory } from '../vehicle/ai.js';

// 道路資料往前多生成一段（給建築避讓用），後方留到網格回收之後
export const ROAD_AHEAD = 2800, ROAD_BEHIND = 560;
const NONE = [];

export function createSession({ seed, carCfg, zone, zones, trafficCfg, duelCfg, rivals, runCfg, upgradeCfg, events, mode = 'run' }) {
  const ev = events || createEvents();
  const emit = (name, payload) => ev.emit(name, payload);
  // 道路生成、車流、對手、節點各用獨立的亂數流，互不影響，方便重現
  const road = createRoad(zone.road);
  // 三晚區域：有給 zones 與 nights 才啟用；否則整局都用 zone
  const nights = mode === 'run' && zones && runCfg?.nights ? runCfg.nights : null;
  const zoneOf = (n) => ({ ...zone, ...zones[nights[n - 1].zone] });
  const generator = createGenerator(road, createRng(seed), nights ? zoneOf(1) : zone);
  generator.fill(ROAD_AHEAD);
  const traffic = createTraffic(road, createRng(seed ^ 0x7f4a7c15), trafficCfg);
  const rivalRng = createRng(seed ^ 0x2545f491);
  const flowRng = createRng(seed ^ 0x51ed270b);
  const menuRng = createRng(seed ^ 0x3c6ef372);

  const state = createCarState({ s: 20, d: 0 });
  const rival = createRival(carCfg, rivalRng);
  const duel = createDuel(duelCfg, ev);

  // 成長：carCfg 是基準值（對手也用它），playerCfg 是套用成長後玩家實際用的數值
  const playerCfg = { ...carCfg };
  const duelBase = { threshold: duelCfg.threshold, scoreMul: 1, keepOnOvertaken: 0 };
  const world = { trafficDensityMul: 1 };
  const upgrades = upgradeCfg ? createUpgrades(upgradeCfg, {
    car: { base: carCfg, out: playerCfg },
    duel: { base: duelBase, out: duel.mods },
    world: { base: { trafficDensityMul: 1 }, out: world },
  }) : null;
  const menuAi = { mem: createAiMemory(), input: {}, cap: 40 };
  const clock = runCfg ? createClock(runCfg.clock) : null;
  const playerProxy = { active: true, onAlt: false, s: state.s, d: 0, v: 0, len: 4.4, wid: 1.8, changeT: 0, toD: 0 };
  const obsForRival = [...traffic.cars, playerProxy];
  const obsForPlayer = [...traffic.cars, rival.proxy];
  const racers = [playerProxy, rival.proxy];
  const onlyPlayer = [playerProxy];
  traffic.populate(playerProxy);

  const flow = {
    phase: 'cruise',     // cruise 巡航中、approach 交流道已出現、node 節點進行中
    options: null,       // [左, 右] 節點類型
    forkS: 0, cutS: 0,
    chosen: true,        // 這個交流道選過了沒
    node: null,          // 目前節點類型
    nodeStartS: 0,
    rivalPending: null,  // 等著出場的對手等級
    paAt: 0,
    wantJct: false,
    nodesDone: 0,
    endAt: 0,            // 捷徑的終點
    event: null,         // 事件節點的內容 { kind, name, ... }
  };
  const tierCount = {};

  const S = {
    road, generator, traffic, state, rival, duel, clock, carCfg, playerCfg, upgrades, world, flow, mode,
    menus: null,         // 三選一與 PA 商店
    boostT: 0,           // 短暫加速的剩餘秒數（甩尾加速）
    lastHook: '',        // 最近觸發的成長（除錯用）
    alt: null,           // 交流道的另一條分支（玩家過分歧點一段距離後回收）
    prev: { s: state.s, d: 0, psi: 0 },
    obsForPlayer,
    run: { defeats: 0, losses: 0, skipped: 0, bounty: 0, penaltyMin: 0, topKmh: 0, night: 1, nightDefeats: 0, bossWins: 0, forks: 0, swaps: 0 },
    nights,
    zoneName: nights ? zoneOf(1).name : zone.name,
    zoneDensity: nights ? (zoneOf(1).traffic?.densityMul ?? 1) : 1,
    pendingNight: false, // 擊敗 Boss 後，等選完成長就進入下一晚
    realTime: 0,         // 這一局的現實秒數
    slip: false,
    rivalIndex: 0,
    respawnT: mode === 'loop' ? 1.5 : Infinity,
    leaveT: 0,
    applied: true,
    over: null,          // { reason: 'dawn' }
    time: 0,

    /** 玩家閃燈：在挑戰範圍內就開始倒數 */
    tryChallenge() {
      if (!rival.active || rival.onAlt || rival.intro || !duel.canChallenge(state, rival.st)) return false;
      rival.flash = 0.5; // 對手以閃燈回應
      S.applied = false;
      return duel.challenge();
    },

    /** 在前方插入一個交流道，分歧點大約在 forkAhead 公尺外 */
    placeJunction(forkAhead) {
      const { alt, forkS, cutS } = generator.insertJunction(state.s + forkAhead - JCT.approach);
      // 先抽節點：捷徑那條分支要生成成急彎多的特殊路段。本晚擊敗數達標後，其中一條固定為 Boss
      const bossDue = !!nights && S.run.nightDefeats >= runCfg.boss.afterDefeats;
      const options = rollOptions(flowRng, nights ? nights[S.run.night - 1].weights : runCfg.nodes.weights, bossDue);
      const special = (type) => (type === 'shortcut' && zones ? { ...zones.shortcut, until: forkS + runCfg.shortcut.startAfterFork + runCfg.shortcut.length } : null);
      road.gen.special = special(options[0]);
      alt.gen.special = special(options[1]);
      generator.fill(forkS + runCfg.junction.altLength, alt);
      generator.fill(state.s + ROAD_AHEAD);
      S.alt = alt;
      traffic.alt = alt;
      // 已經在分歧點之後的車：最右車道的歸右分支
      for (const c of traffic.cars) if (c.active && c.s >= forkS) c.onAlt = c.lane === 2;
      if (rival.active && rival.st.s >= forkS) rival.onAlt = rival.st.d > 0;
      flow.phase = 'approach'; flow.chosen = false; flow.wantJct = false;
      flow.forkS = forkS; flow.cutS = cutS;
      flow.options = options;
      emit('jctPlaced', { forkS, cutS, options: flow.options });
    },

    choose(side) {
      const f = road.fork;
      if (side !== f.side) {
        road.swapWith(S.alt);
        traffic.swapBranches(f.s);
        if (rival.active && rival.st.s >= f.s) rival.onAlt = !rival.onAlt;
        S.run.swaps++;
        emit('forkSwap', { forkS: f.s });
      }
      // 對手必須跟玩家同一條：已經在另一條上就移過來（鏡像位置）
      if (rival.active && rival.onAlt) {
        rival.onAlt = false;
        rival.st.d = -rival.st.d;
        rival.prev.d = rival.st.d;
      }
      S.run.forks++;
      flow.chosen = true;
      flow.phase = 'node';
      flow.node = flow.options[side < 0 ? 0 : 1];
      flow.nodeStartS = f.s;
      const def = NODE_TYPES[flow.node];
      flow.event = null;
      if (def.tier) flow.rivalPending = def.tier;
      else if (flow.node === 'pa') flow.paAt = f.s + runCfg.nodes.paAfterFork;
      else if (flow.node === 'shortcut') {
        // 捷徑：車流密、彎道急，沒有對手；開完退回時間
        const sc = runCfg.shortcut;
        flow.endAt = f.s + sc.startAfterFork + sc.length;
        traffic.fillRange(f.s + sc.startAfterFork, flow.endAt, sc.extraCars);
      } else if (flow.node === 'event') S.startEvent(f.s);
      emit('forkChosen', { side, node: flow.node });
    },

    endNode() {
      if (flow.phase !== 'node') return;
      flow.phase = 'cruise'; flow.node = null; flow.rivalPending = null;
      flow.nodesDone++;
      flow.wantJct = true;
      emit('nodeEnd', {});
    },

    step(dt, inp) {
      if (S.over) return;
      const prev = S.prev;
      prev.s = state.s; prev.d = state.d; prev.psi = state.psi;

      // ── 選單開著：車子由自動駕駛保持車道，時鐘變慢但不暫停，期間不會被撞
      const menu = S.menus ? S.menus.current : null;
      if (menu) {
        inp = drive(state, playerCfg, road, { obstacles: obsForPlayer, mem: menuAi.mem, dt, speedCap: menuAi.cap }, menuAi.input);
        S.menus.update(dt);
      }
      if (clock) clock.setChoosing(!!(S.menus && S.menus.current));
      const wasDrifting = state.drifting, driftTime = state.driftTime;
      if (S.boostT > 0) { S.boostT -= dt; if (S.boostT <= 0) state.boostAccel = 0; }
      generator.fill(state.s + ROAD_AHEAD);
      const sTrim = Math.min(state.s, rival.active ? rival.st.s : Infinity) - ROAD_BEHIND;
      road.trim(sTrim);
      if (S.alt) S.alt.trim(sTrim);

      // ── 選路：快到分歧點時，依玩家在左半或右半決定分支（在物理之前決定，護欄才對得上）
      const fork = road.fork;
      if (mode === 'run' && fork && !flow.chosen && state.s < fork.s && state.s + Math.max(3, state.vf * dt * 2) >= fork.s) {
        S.choose(state.d > 0 ? 1 : -1);
      }

      // ── 玩家車（吸尾流：跟在任何車輛正後方時空氣阻力降低）
      S.slip = traffic.slipstream(state, playerCfg.slipstreamRange, playerCfg.slipstreamWidth, rival.proxy);
      state.dragMul = S.slip ? 1 - Math.min(0.9, playerCfg.slipstreamDragCut) : 1;
      stepCar(state, inp, playerCfg, road, dt, ev);
      if (upgrades && wasDrifting && !state.drifting) {
        const fired = upgrades.fire('onDriftEnd', S, { time: driftTime });
        if (fired.length) { S.lastHook = 'onDriftEnd'; emit('hookFired', { hook: 'onDriftEnd', ids: fired }); }
      }
      playerProxy.s = state.s; playerProxy.d = state.d; playerProxy.v = state.vf; playerProxy.toD = state.d;
      if (state.vf * 3.6 > S.run.topKmh) S.run.topKmh = state.vf * 3.6;

      // ── 車流
      traffic.update(dt, playerProxy, rival.active ? racers : onlyPlayer);

      // ── 對手
      if (rival.active) {
        const rs = rival.st;
        const f = road.fork;
        // 對手過分歧點：玩家已選就一定走同一條；玩家還沒選就照它當下那一側
        if (f && !rival.onAlt && rs.s < f.s && rs.s + Math.max(3, rs.vf * dt * 2) >= f.s && (rs.d > 0 ? 1 : -1) !== f.side) {
          if (flow.chosen || !S.alt) rs.d = f.side * Math.max(1.6, Math.abs(rs.d));
          else rival.onAlt = true;
        }
        const onAlt = rival.onAlt && S.alt;
        updateRival(rival, dt, {
          road: onAlt ? S.alt : road,
          obstacles: onAlt || rival.intro ? NONE : obsForRival,
          player: playerProxy, phase: duel.phase, rubber: duelCfg.rubberBand,
          slip: !onAlt && traffic.slipstream(rs, rival.cfg.slipstreamRange, rival.cfg.slipstreamWidth, playerProxy),
          jctSide: f ? (flow.chosen ? f.side : state.d > 0 ? 1 : -1) : 0,
        });
      } else { rival.proxy.active = false; rival.proxy.onAlt = false; }

      // ── 碰撞
      if (!menu) collidePlayerTraffic(state, playerCfg, traffic, trafficCfg, road, dt, ev);
      if (rival.active && !rival.onAlt && !rival.intro) {
        collidePlayerTraffic(rival.st, rival.cfg, traffic, trafficCfg, road, dt, null);
        if (state.pairCool > 0) state.pairCool -= dt;
        if (!menu) collidePair(state, playerCfg, rival.st, rival.cfg, road, ev);
        playerProxy.s = state.s; playerProxy.d = state.d; playerProxy.v = state.vf;
        rival.proxy.s = rival.st.s; rival.proxy.d = rival.st.d; rival.proxy.v = rival.st.vf;
      }

      // ── 對決計分
      if (rival.active) duel.update(dt, playerProxy, rival.proxy);
      if (duel.phase === 'result' && !S.applied) {
        S.applied = true;
        const tier = rival.def.tier || 'normal';
        emit('duelApplied', { win: duel.result.win, def: rival.def });
        if (duel.result.win) {
          S.run.defeats++; S.rivalIndex++;
          if (tier === 'boss') { S.run.bossWins++; S.pendingNight = true; } else S.run.nightDefeats++;
          S.run.bounty += duelCfg.bountyByTier?.[tier] ?? duelCfg.bounty;
          // 獲勝：三選一成長
          if (S.menus) { menuAi.cap = Math.min(45, Math.max(22, state.vf)); menuAi.mem.lane = Math.round(state.d / road.laneWidth + 1); S.menus.openChoice(tier); }
        }
        else {
          const lose = duelCfg.loseMinutesByTier?.[tier] ?? duelCfg.loseMinutes;
          S.run.losses++; S.run.penaltyMin += lose;
          if (clock) clock.spend(lose);
        }
        S.leaveT = 0;
      }

      // ── 對手的進場與退場
      if (!rival.active) {
        if (mode === 'loop') {
          S.respawnT -= dt;
          if (S.respawnT <= 0) S.spawnRival(rivals[S.rivalIndex % rivals.length], state.s + duelCfg.spawnAhead + Math.max(0, state.vf) * 1.5);
        } else if (flow.rivalPending === 'boss') {
          // Boss：過了分歧的變寬段之後，從後方登場
          if (state.s > flow.nodeStartS + runCfg.boss.spawnAfterFork) {
            const def = rivals.find((r) => r.id === nights[S.run.night - 1].boss);
            if (S.spawnBoss(def)) flow.rivalPending = null;
          }
        } else if (flow.rivalPending && state.s > flow.nodeStartS + 40) {
          const pool = rivals.filter((r) => r.tier === flow.rivalPending);
          const n = tierCount[flow.rivalPending] || 0;
          const sAt = Math.max(flow.nodeStartS + runCfg.nodes.rivalSpawnAfterFork, state.s + duelCfg.spawnAhead + Math.max(0, state.vf) * 1.5);
          if (S.spawnRival(pool[n % pool.length], sAt)) { tierCount[flow.rivalPending] = n + 1; flow.rivalPending = null; }
        }
      } else if (duel.phase === 'marked') {
        // 一直不挑戰：超過對手一段距離、或這個節點開太遠，對手離開
        const tooFar = mode === 'run' && state.s - flow.nodeStartS > runCfg.nodes.skipDistance;
        const behind = state.s - rival.st.s;
        if (rival.def.tier === 'boss') {
          // Boss 甩不掉：落後太多（被車流卡住，或玩家不挑戰直接開走）就重新從後方追上來
          if (behind > (rival.intro ? 260 : duelCfg.skipBehind)) {
            const sAt = Math.max(road.sMin + 40, state.s - 120);
            for (let k = 0; k < road.lanes; k++) {
              if (!traffic.laneFree(k, sAt, -25, 35, null) || road.zoneAt(sAt) !== 0) continue;
              rival.st.s = sAt; rival.st.d = road.laneCenterAt(k, sAt); rival.st.psi = 0; rival.st.vl = 0;
              rival.st.vf = Math.max(state.vf + 15, 45);
              rival.prev.s = sAt; rival.prev.d = rival.st.d; rival.mem.lane = k;
              rival.intro = true;
              S.run.bossRejoins = (S.run.bossRejoins || 0) + 1;
              break;
            }
          }
        } else if (behind > duelCfg.skipBehind || tooFar) {
          S.run.skipped++;
          S.despawn();
          emit('rivalSkipped', {});
          S.endNode();
        }
      } else if (duel.phase === 'idle' || duel.phase === 'result') {
        S.leaveT += dt;
        const rel = rival.st.s - state.s;
        if (duel.phase === 'idle') {
          S.endNode(); // 勝負已分，這個節點結束；對手自己慢慢離開
          if (rel < -220 || rel > 700 || S.leaveT > 16) S.despawn();
        }
      }

      // ── 節點流程
      if (mode === 'run') {
        if (flow.phase === 'node' && flow.node === 'pa' && state.s >= flow.paAt) {
          clock.spend(runCfg.nodes.paMinutes);
          emit('pa', { minutes: runCfg.nodes.paMinutes });
          if (S.menus) {
            // PA：開商店，離開後這個節點才結束
            menuAi.cap = Math.min(40, Math.max(22, state.vf)); menuAi.mem.lane = Math.round(state.d / road.laneWidth + 1);
            flow.node = 'shop';
            S.menus.openShop();
          } else S.endNode();
        }
        if (flow.phase === 'node' && flow.node === 'shop' && !S.menus.current) {
          flow.node = 'pa';
          S.endNode();
        }
        if (flow.phase === 'node' && flow.node === 'shortcut' && state.s >= flow.endAt) {
          clock.spend(-runCfg.shortcut.refundMinutes);
          emit('shortcutDone', { minutes: runCfg.shortcut.refundMinutes });
          S.endNode();
        }
        if (flow.phase === 'node' && flow.node === 'event') S.updateEvent();
        // 擊敗 Boss：等橫幅與三選一結束後進入下一晚（第三晚則通關）
        if (S.pendingNight && !(S.menus && S.menus.current) && duel.phase !== 'result') S.nextNight();
        // 另一條分支：玩家過分歧點一段距離後回收
        if (S.alt && flow.chosen && state.s > flow.forkS + runCfg.junction.altKeepAfterFork) {
          traffic.clearAlt();
          S.alt = null;
          emit('altCleared', {});
        }
        if (flow.wantJct && !S.alt) {
          S.placeJunction(flowRng.range(runCfg.junction.forkAheadMin, runCfg.junction.forkAheadMax));
        }
        // ── 時鐘：永遠在走；車流越接近天亮越密
        clock.update(dt);
        const td = runCfg.trafficDensity;
        traffic.density = (td.night + (td.dawn - td.night) * clock.progress) * world.trafficDensityMul * S.zoneDensity;
        if (clock.dawn && !S.over) {
          S.over = { reason: 'dawn' };
          emit('runOver', S.over);
        }
      }
      S.time += dt;
      S.realTime += dt;
    },

    /** Boss 從玩家後方登場 */
    spawnBoss(def) {
      if (rival.active) S.despawn();
      const sAt = Math.max(road.sMin + 40, state.s - runCfg.boss.spawnBehind);
      let lane = -1;
      for (let k = 0; k < road.lanes; k++) {
        const l = (k + 1) % road.lanes;
        if (traffic.laneFree(l, sAt, -30, 40, null) && Math.abs(road.laneCenterAt(l, sAt) - state.d) > 2.5) { lane = l; break; }
      }
      if (lane < 0 || road.zoneAt(sAt) !== 0) return false;
      spawnRival(rival, def, road, sAt, lane);
      rival.st.d = road.laneCenterAt(lane, sAt);
      rival.st.vf = Math.max(state.vf + 15, 45);
      rival.intro = true;
      rival.proxy.active = true; rival.proxy.onAlt = false;
      rival.proxy.s = sAt; rival.proxy.d = rival.st.d; rival.proxy.v = rival.st.vf;
      duel.mark('boss');
      emit('bossIntro', { def });
      return true;
    },

    /** 進入下一晚（第三晚的 Boss 擊敗後則通關）。不切場景：時鐘歸零，前方新生成的路換成下一晚的區域 */
    nextNight() {
      S.pendingNight = false;
      if (S.run.night >= nights.length) {
        S.over = { reason: 'victory' };
        emit('runOver', S.over);
        return;
      }
      S.run.night++;
      S.run.nightDefeats = 0;
      const z = zoneOf(S.run.night);
      generator.setZone(z);
      traffic.typeWeights = z.traffic?.typeWeights || null;
      S.zoneDensity = z.traffic?.densityMul ?? 1;
      S.zoneName = z.name;
      clock.reset();
      emit('nightStart', { night: S.run.night, zone: z });
    },

    // ── 事件節點：塞車、警察盤查、神秘車輛
    startEvent(forkS) {
      const ec = runCfg.events;
      const kind = rollEvent(flowRng, ec.weights);
      const e = { kind, name: EVENT_NAMES[kind] };
      if (kind === 'jam') {
        e.s0 = forkS + ec.jam.startAfterFork; e.s1 = e.s0 + ec.jam.length;
        e.cars = traffic.fillRange(e.s0, e.s1, ec.jam.cars, { kmhMin: ec.jam.kmhMin, kmhMax: ec.jam.kmhMax });
      } else if (kind === 'police') {
        e.checkS = forkS + ec.police.checkAfterFork; e.limit = ec.police.limitKmh;
      } else flow.rivalPending = 'mystery';
      flow.event = e;
      emit('eventStart', e);
    },
    updateEvent() {
      const e = flow.event, ec = runCfg.events;
      if (!e || e.done) return;
      if (e.kind === 'jam' && state.s >= e.s1 + 30) {
        e.done = true;
        S.run.bounty += ec.jam.bounty;
        emit('eventResult', { kind: 'jam', bounty: ec.jam.bounty });
        S.endNode();
      } else if (e.kind === 'police' && state.s >= e.checkS) {
        e.done = true;
        const kmh = state.vf * 3.6;
        const ok = kmh <= ec.police.limitKmh + ec.police.toleranceKmh;
        if (ok) S.run.bounty += ec.police.bounty; else clock.spend(ec.police.fineMinutes);
        emit('eventResult', { kind: 'police', ok, kmh, bounty: ok ? ec.police.bounty : 0, minutes: ok ? 0 : ec.police.fineMinutes });
        S.endNode();
      }
      // 神秘車輛：就是一場對決，結束時由對決流程收尾
    },

    spawnRival(def, sAt) {
      if (rival.active) S.despawn();
      let lane = -1;
      for (let k = 0; k < road.lanes; k++) {
        const l = (k + 1) % road.lanes;
        if (traffic.laneFree(l, sAt, -30, 40, null)) { lane = l; break; }
      }
      if (lane < 0 || sAt > road.sMax - 200 || road.zoneAt(sAt) !== 0) return false;
      spawnRival(rival, def, road, sAt, lane);
      rival.st.d = road.laneCenterAt(lane, sAt);
      rival.proxy.active = true; rival.proxy.onAlt = false;
      rival.proxy.s = sAt; rival.proxy.d = rival.st.d; rival.proxy.v = rival.st.vf;
      duel.mark(def.tier);
      emit('rivalMarked', { def });
      return true;
    },

    despawn() {
      rival.active = false; rival.onAlt = false;
      rival.proxy.active = false; rival.proxy.onAlt = false;
      duel.clear();
      S.respawnT = duelCfg.respawnDelay;
    },
  };

  if (upgrades) {
    S.menus = createMenus({ upgrades, rng: menuRng, run: S.run, emit });
    // 被超車時觸發的成長（例如賭徒：扣時間）
    ev.on('duelZero', (e) => {
      if (e.who !== 'player') return;
      const fired = upgrades.fire('onOvertaken', S, e);
      if (fired.length) { S.lastHook = 'onOvertaken'; emit('hookFired', { hook: 'onOvertaken', ids: fired }); }
    });
  }
  /** 基準值被熱更新後重算生效值 */
  S.recompute = () => { duelBase.threshold = duelCfg.threshold; if (upgrades) upgrades.recompute(); else Object.assign(playerCfg, carCfg); };
  if (mode !== 'run') traffic.density = 1;
  if (nights) traffic.typeWeights = zoneOf(1).traffic?.typeWeights || null;
  if (mode === 'run') S.placeJunction(runCfg.junction.firstForkAt);
  return S;
}
