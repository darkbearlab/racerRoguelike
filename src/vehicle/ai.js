// 駕駛 AI：對手、自動駕駛（?autopilot=1 與自動化驗收）共用同一套。
// - 目標速度：往前看道路曲率算安全過彎速度，提前煞車
// - 目標橫向位置：彎道走外→內→外的賽車線，直線就近保持車道
// - 避讓車流：選較空的車道，對擋路的車煞車
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function createAiMemory(lane = 1) {
  return { lane, hold: 0 };
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
  let vAllowed = Math.min(vMax, o.speedCap ?? Infinity);
  for (let a = 0; a <= lookDist; a += 10) {
    const k = Math.abs(road.curvature(st.s + a));
    if (k < 1e-5) continue;
    const vSafe = Math.sqrt((cfg.latAccelMax * gripUse) / k);
    const vNow = Math.sqrt(vSafe * vSafe + 2 * decel * a);
    if (vNow < vAllowed) vAllowed = vNow;
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
    // 每條車道前方的淨空距離，選最好的（目前車道有黏性，避免左右亂切）
    const reach = (60 + v * 2.2) * (o.caution ?? 1);
    const zNow = road.zoneAt ? road.zoneAt(st.s) : 0;
    const commit = o.preferD != null && (zNow === 1 || zNow === 2);
    let best = mem.lane, bestScore = -Infinity;
    for (let lane = 0; lane < road.lanes; lane++) {
      const lc = road.laneCenterAt(lane, st.s + 12);
      let free = reach;
      if (obs) {
        for (const c of obs) {
          if (!c.active || c.onAlt) continue;
          const ds = c.s - st.s;
          if (ds < -8 || ds > reach) continue;
          if (c.v > v + 3 && ds > 12) continue; // 比我快的不算擋路
          const near = Math.abs(c.d - lc) < c.wid / 2 + margin || (c.changeT > 0 && Math.abs(c.toD - lc) < 1);
          if (near && ds < free) free = Math.max(0, ds);
        }
      }
      let score = free - Math.abs(lane - mem.lane) * 2;
      if (lane === mem.lane) score += reach * 0.12;
      // 明確指定的位置（交流道選邊、卡位）要壓過「留在原車道」的黏性；賽車線只是偏好
      if (dLine != null) score += reach * (o.preferD != null ? 0.7 : 0.22) * (1 - Math.min(1, Math.abs(lc - dLine) / (W * 2)));
      // 交流道前已經指定要走哪一側：不再為了閃車換到另一側，只選最靠那一側的車道（擋路就煞車）
      if (commit) score = -Math.abs(lc - dLine);
      if (score > bestScore) { bestScore = score; best = lane; }
    }
    mem.hold -= o.dt ?? 1 / 60;
    if (best !== mem.lane && (mem.hold <= 0 || commit)) { mem.lane = best; mem.hold = 0.5 + 0.4 * (o.caution ?? 1); }
    dTarget = road.laneCenterAt(mem.lane, st.s + 12);

    // 對擋在現在位置、或擋在切換路徑上的車煞車（含正在切進來的）
    if (obs) {
      for (const c of obs) {
        if (!c.active || c.onAlt) continue;
        const gap = c.s - st.s - (c.len + 4.4) / 2;
        if (gap < -1 || gap > 160) continue;
        const pad = margin - 0.25 + c.wid / 2;
        const lo = Math.min(st.d, dTarget) - pad, hi = Math.max(st.d, dTarget) + pad;
        const cd = c.changeT > 0 ? c.toD : c.d;
        if ((c.d < lo || c.d > hi) && (cd < lo || cd > hi)) continue;
        const vNow = Math.sqrt(c.v * c.v + 2 * decel * Math.max(0, gap - 6));
        if (vNow < vAllowed) vAllowed = vNow;
      }
    }
  }

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
