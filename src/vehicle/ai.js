// 駕駛 AI：對手、自動駕駛（?autopilot=1 與自動化驗收）共用同一套。
// - 目標速度：往前看道路曲率算安全過彎速度，提前煞車
// - 目標橫向位置：彎道走外→內→外的賽車線，直線就近保持車道
// - 避讓車流：選較空的車道，對擋路的車煞車
import { dlog } from '../core/dmath.js';
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function createAiMemory(lane = 1) {
  return { lane, hold: 0, pass: null };
}

// ── 車道規劃用的暫存：_iv[車道] = [{ a, b, c }]，a～b 是「我再開這麼遠會和 c 重疊」的範圍
const _iv = [];
function buildLanes(obs, st, v, road, margin, reach) {
  const n = road.lanes;
  for (let L = 0; L < n; L++) (_iv[L] || (_iv[L] = [])).length = 0;
  if (!obs) return;
  for (const c of obs) {
    if (!c.active || c.onAlt) continue;
    const ds = c.s - st.s;
    if (ds < -12 || ds > reach) continue;
    if (c.v > v + 3 && ds > 12) continue; // 比我快的不算擋路
    // 對方也在往前開：追到它要開的距離比現在的車距長
    const k = Math.max(1, v / Math.max(v - c.v, 4));
    const half = (c.len ?? 4.4) / 2 + 2.2;
    const a = (ds - half - 4) * k, b = (ds + half + 2) * k;
    if (b <= 0) continue;
    for (let L = 0; L < n; L++) {
      const lc = road.laneCenterAt(L, st.s + 12);
      if (Math.abs(c.d - lc) < c.wid / 2 + margin || (c.changeT > 0 && Math.abs(c.toD - lc) < 1)) _iv[L].push({ a, b, c });
    }
  }
}
function firstBlock(L, x) {
  let best = null;
  for (const iv of _iv[L]) if (iv.b > x && (!best || iv.a < best.a)) best = iv;
  return best;
}
function clearOver(L, x0, x1) {
  for (const iv of _iv[L]) if (iv.a < x1 && iv.b > x0) return false;
  return true;
}
/**
 * 從車道 L 的 x 出發最遠能開到哪（可以再換 depth 次車道，每換一次扣一點分，免得為了一樣的結果多繞）。
 * minP：最早從哪裡開始才准換（最上層用來問「先不換、等一下再換」能到哪）
 */
const SWITCH_COST = 6;
function reachFrom(L, x, depth, H, Lsw, lanes, minP) {
  const blk = firstBlock(L, x);
  let F = blk ? blk.a : H;
  if (F <= x) return x;
  if (F > H) F = H;
  let best = F;
  if (depth > 0 && blk) {
    const last = F - 0.75 * Lsw;   // 最晚要在這裡開始換，才來得及在追到前車之前離開這條車道
    for (let M = L - 1; M <= L + 1; M += 2) {
      if (M < 0 || M >= lanes) continue;
      // 可以換過去的時機：現在、剛超過那條車道上的某一台之後、或拖到最後一刻
      if (x >= minP && x <= last && clearOver(M, x - 2, x + Lsw)) best = Math.max(best, reachFrom(M, x + Lsw, depth - 1, H, Lsw, lanes, 0) - SWITCH_COST);
      if (last > x && last >= minP && clearOver(M, last - 1, last + Lsw)) best = Math.max(best, reachFrom(M, last + Lsw, depth - 1, H, Lsw, lanes, 0) - SWITCH_COST);
      for (const iv of _iv[M]) {
        const p = iv.b;
        if (p <= x || p < minP || p > last || !clearOver(M, p - 1, p + Lsw)) continue;
        best = Math.max(best, reachFrom(M, p + Lsw, depth - 1, H, Lsw, lanes, 0) - SWITCH_COST);
      }
    }
  }
  return best;
}

/**
 * o: {
 *   obstacles  [{active,s,d,v,len,wid,changeT,toD}]   mem  createAiMemory()   dt
 *   gripUse    過彎時用掉多少抓地極限（0.6–1，> 1 會衝出去）
 *   topSpeedKmh / speedCap(m/s)   line 是否走賽車線   preferD 強制偏好的橫向位置
 *   caution    前視距離倍率（越小越敢鑽）   margin 與車流的橫向安全距離
 * }
 */
export function drive(st, cfg, road, o = {}, out = {}) {
  const v = Math.max(st.vf, 0);
  const vMax = (o.topSpeedKmh ?? cfg.vMaxKmh) / 3.6;
  const gripUse = o.gripUse ?? 0.85;
  const lookDist = o.lookDist ?? 150;
  const decel = cfg.brakeDecel * 0.8;
  const margin = o.margin ?? 1.5;
  const mem = o.mem;
  const obs = o.obstacles;

  // ── 目標速度：前方每個點的安全速度，換算成現在最多能多快
  let vAllowed = Math.min(vMax, o.speedCap ?? Infinity), why = 'top';
  for (let a = 0; a <= lookDist; a += 10) {
    const k = Math.abs(road.curvature(st.s + a));
    if (k < 1e-5) continue;
    const vSafe = Math.sqrt((cfg.latAccelMax * gripUse) / k);
    const vNow = Math.sqrt(vSafe * vSafe + 2 * decel * a);
    if (vNow < vAllowed) { vAllowed = vNow; why = 'curve'; }
  }

  // ── 賽車線：進彎前靠外、彎中切內（左彎的內側是左邊，d 為負）
  const W = road.laneCenter(road.lanes - 1);
  let dLine = null;
  if (o.line) {
    const kNear = road.curvature(st.s + 15 + v * 0.3);
    const kFar = road.curvature(st.s + 60 + v * 1.2);
    if (Math.abs(kNear) > 0.003) dLine = -Math.sign(kNear) * W;
    else if (Math.abs(kFar) > 0.003) dLine = Math.sign(kFar) * W;
  }
  if (o.preferD != null) dLine = o.preferD;

  let dTarget = o.dTarget ?? 0;
  if (mem) {
    // 選車道：把車流換算成每條車道上「還要開多遠會碰到」的區間，往前規劃幾步（超過這台之後鑽回哪個空位），
    // 而不是只挑眼前最空的那一條跟到底
    const reach = (60 + v * 2.2) * (o.caution ?? 1);
    const zNow = road.zoneAt ? road.zoneAt(st.s) : 0;
    const commit = o.preferD != null && (zNow === 1 || zNow === 2);
    const H = reach * 1.6;
    const Lsw = Math.max(14, v * (1.0 + 0.45 * (o.caution ?? 1)));   // 換一條車道要開掉的距離
    buildLanes(obs, st, v, road, margin, reach);
    const cur = mem.lane;
    const blk = firstBlock(cur, 0);
    const F0 = blk ? Math.max(0, blk.a) : H;
    const stayLater = reachFrom(cur, 0, 2, H, Lsw, road.lanes, Math.max(6, v * 0.5));   // 至少再等半秒才換
    let best = cur, bestScore = -Infinity;
    for (let lane = 0; lane < road.lanes; lane++) {
      const lc = road.laneCenterAt(lane, st.s + 12);
      let score;
      if (lane === cur) score = stayLater + reach * 0.04;
      else if (Math.abs(lane - cur) === 1) score = clearOver(lane, -2, Lsw) ? reachFrom(lane, Lsw, 2, H, Lsw, road.lanes, 0) - SWITCH_COST : -1e6;
      else score = -1e6;
      // 明確指定的位置（交流道選邊、卡位）要壓過「留在原車道」的黏性；賽車線只是偏好
      if (dLine != null) score += reach * (o.preferD != null ? 0.7 : 0.22) * (1 - Math.min(1, Math.abs(lc - dLine) / (W * 2)));
      // 交流道前已經指定要走哪一側：不再為了閃車換到另一側，只選最靠那一側的車道（擋路就煞車）
      if (commit) score = -Math.abs(lc - dLine);
      if (score > bestScore) { bestScore = score; best = lane; }
    }
    // 留在這條、等一下再鑽出去：前面那台不用現在就為它煞車
    mem.pass = best === cur && blk && !commit && stayLater > F0 + 8 ? blk.c : null;
    mem.hold -= o.dt ?? 1 / 60;
    if (best !== mem.lane && (mem.hold <= 0 || commit)) { mem.lane = best; mem.hold = 0.5 + 0.4 * (o.caution ?? 1); }
    dTarget = road.laneCenterAt(mem.lane, st.s + 12);

    // 對擋在現在位置、或擋在切換路徑上的車煞車（含正在切進來的）
    if (obs) {
      const hwMe = cfg.halfWidth ?? 0.9;
      for (const c of obs) {
        if (!c.active || c.onAlt) continue;
        const gap = c.s - st.s - (c.len + 4.4) / 2;
        if (gap < -1 || gap > 160) continue;
        if (c === mem.pass) continue;
        const pad = margin - 0.25 + c.wid / 2;
        const lo = Math.min(st.d, dTarget) - pad, hi = Math.max(st.d, dTarget) + pad;
        const cd = c.changeT > 0 ? c.toD : c.d;
        if ((c.d < lo || c.d > hi) && (cd < lo || cd > hi)) continue;
        let vNow = Math.sqrt(c.v * c.v + 2 * decel * Math.max(0, gap - 6));
        // 這台車不在我要去的位置上（我正在切離它那一條）：不用照「跟在它後面」來煞，
        // 只要追到它之前來得及橫向錯開就可以全速過；來不及才把接近速度壓到剛好錯得開
        const clearW = c.wid / 2 + hwMe + 0.3;
        if (Math.abs(c.d - dTarget) > clearW + 0.15 && Math.abs(cd - dTarget) > clearW + 0.15) {
          const need = Math.max(0, clearW - Math.min(Math.abs(c.d - st.d), Math.abs(cd - st.d)));
          const E = Math.abs(dTarget - st.d);
          // 橫向誤差大致照指數收斂（前視點轉向），時間常數隨車速變
          const tau = (8 + 0.5 * v) / Math.max(v, 5) + 0.35;
          const tClear = need <= 0 ? 0 : tau * dlog(E / Math.max(0.15, E - need)) + 0.25;
          const vPass = tClear <= 0 ? Infinity : c.v + Math.max(0, gap - 3) / (tClear * (o.passSafety ?? 1.3));
          if (vPass > vNow) vNow = vPass;
        }
        if (vNow < vAllowed) { vAllowed = vNow; why = Math.abs(c.d - dTarget) > clearW + 0.15 ? 'cross' : 'follow'; }
      }
    }
  }
  out.why = why;

  let throttle = 0, brake = 0;
  if (v < vAllowed - 1) throttle = 1;
  else if (v > vAllowed + 1.5) brake = clamp((v - vAllowed) / 6, 0.2, 1);
  else throttle = 0.4;

  // ── 橫向：前視點 + 曲率前饋
  const look = 8 + 0.5 * v;
  const psiDes = clamp((st.d - dTarget) / look, -0.35, 0.35);
  const kAhead = road.curvature(st.s + look * 0.5);
  const frac = clamp(v / (cfg.vMaxKmh / 3.6), 0, 1);
  const yawAvail = Math.max(
    0.05,
    Math.min((cfg.steerLow + (cfg.steerHigh - cfg.steerLow) * frac) * Math.min(1, v / 4), cfg.latAccelMax / Math.max(v, 6)),
  );
  const steer = clamp((psiDes - st.psi) * 4 + (kAhead * v) / yawAvail, -1, 1);

  out.throttle = throttle;
  out.brake = brake;
  out.steer = steer;
  out.handbrake = false;
  out.analog = true;
  out.noDrift = true; // 煞車加轉向不要誤觸甩尾
  out.vAllowed = vAllowed;
  return out;
}

/** 測試用的玩家替身 */
export function autopilot(st, cfg, road, opts = {}, out = {}) {
  return drive(st, cfg, road, { ...opts, obstacles: opts.traffic ?? opts.obstacles }, out);
}
