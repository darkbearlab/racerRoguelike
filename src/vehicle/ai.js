// 駕駛 AI：對手、自動駕駛（?autopilot=1 與自動化驗收）共用同一套。
// - 目標速度：往前看道路曲率算安全過彎速度，提前煞車
// - 目標橫向位置：彎道走外→內→外的賽車線，直線就近保持車道
// - 避讓車流：選較空的車道，對擋路的車煞車
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function createAiMemory(lane = 1) {
  return { lane, hold: 0, pass: null };
}

// 把別的車算成「佔住」的範圍時，車尾後面與車頭前面各多留幾公尺
let PAD_BACK = 4, PAD_FRONT = 2;
// 換車道時，前面這一段（佔換車道距離的比例）人還在原車道，目標車道這一段有車沒關係（正在超過它）
// 橫向控制：車頭角度的回授增益（1/秒），以及煞住橫移時願意用掉多少偏航能力
let K_PSI = 8, YAW_USE = 0.5;
let ENTER = 0.4;
// 一次斜穿兩條車道：總共要開掉的距離、中間那條車道被我佔住的區段、進入目標車道的時機（都以換一條車道的距離為單位）
let DBL = 1.25, MID0 = 0.35, MID1 = 0.95, TGT0 = 0.7, DBL_ON = 1;
export const tune = (o) => { if (o.back != null) PAD_BACK = o.back; if (o.front != null) PAD_FRONT = o.front; if (o.enter != null) ENTER = o.enter; if (o.kpsi != null) K_PSI = o.kpsi; if (o.yawUse != null) YAW_USE = o.yawUse; if (o.dbl != null) DBL_ON = o.dbl; if (o.mid1 != null) MID1 = o.mid1; };

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
    const a = (ds - half - PAD_BACK) * k, b = (ds + half + PAD_FRONT) * k;
    if (b <= 0) continue;
    for (let L = 0; L < n; L++) {
      const lc = road.laneCenterAt(L, st.s + 12);
      if (Math.abs(c.d - lc) < c.wid / 2 + margin || (c.changeT > 0 && Math.abs(c.toD - lc) < 1) || (c.blinkTime > 0 && c.toLane === L)) _iv[L].push({ a, b, c });
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
/** 從 p 開始能不能一口氣從車道 L 斜穿到 T（隔一條）：中間那條只在經過的那一小段需要淨空 */
function sweepOk(L, T, p, Lsw) {
  const M = (L + T) >> 1;
  return clearOver(M, p - 2 + MID0 * Lsw, p + MID1 * Lsw) && clearOver(T, p - 2 + TGT0 * Lsw, p + DBL * Lsw);
}
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
      if (x >= minP && x <= last && clearOver(M, x - 2 + ENTER * Lsw, x + Lsw)) best = Math.max(best, reachFrom(M, x + Lsw, depth - 1, H, Lsw, lanes, 0) - SWITCH_COST);
      if (last > x && last >= minP && clearOver(M, last - 1 + ENTER * Lsw, last + Lsw)) best = Math.max(best, reachFrom(M, last + Lsw, depth - 1, H, Lsw, lanes, 0) - SWITCH_COST);
      for (const iv of _iv[M]) {
        const p = iv.b;
        if (p <= x || p < minP || p > last || !clearOver(M, p - 1, p + Lsw)) continue;
        best = Math.max(best, reachFrom(M, p + Lsw, depth - 1, H, Lsw, lanes, 0) - SWITCH_COST);
      }
    }
    // 斜穿兩條：離開原車道比較快，所以可以拖得更晚
    if (DBL_ON) for (let T = L - 2; T <= L + 2; T += 4) {
      if (T < 0 || T >= lanes) continue;
      const last2 = F - 0.55 * Lsw, M = (L + T) >> 1;
      const tryAt = (p) => { if (p >= x && p >= minP && p <= last2 && sweepOk(L, T, p, Lsw)) best = Math.max(best, reachFrom(T, p + DBL * Lsw, depth - 1, H, Lsw, lanes, 0) - 2 * SWITCH_COST); };
      tryAt(x); tryAt(last2);
      for (const iv of _iv[M]) tryAt(iv.b - MID0 * Lsw);
      for (const iv of _iv[T]) tryAt(iv.b - TGT0 * Lsw);
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

  // 前視距離：越短橫向反應越快（agility > 1 = 換車道比較俐落）
  const look = (8 + 0.5 * v) / (o.agility ?? 1);
  const agl = Math.sqrt(Math.sqrt(o.agility ?? 1));   // 實測：前視距離縮短到 1/1.5，換車道時間約短一成
  let dTarget = o.dTarget ?? 0;
  if (mem) {
    // 選車道：把車流換算成每條車道上「還要開多遠會碰到」的區間，往前規劃幾步（超過這台之後鑽回哪個空位），
    // 而不是只挑眼前最空的那一條跟到底
    const reach = (60 + v * 2.2) * (o.caution ?? 1);
    const zNow = road.zoneAt ? road.zoneAt(st.s) : 0;
    const commit = o.preferD != null && (zNow === 1 || zNow === 2);
    const H = reach * 1.6;
    const Lsw = Math.max(14, v * (1.15 + 0.3 * (o.caution ?? 1)) / agl);   // 換一條車道要開掉的距離
    buildLanes(obs, st, v, road, margin, reach);
    const cur = mem.lane;
    const blk = firstBlock(cur, 0);
    const F0 = blk ? Math.max(0, blk.a) : H;
    const stayLater = reachFrom(cur, 0, 2, H, Lsw, road.lanes, Math.max(6, v * 0.5));   // 至少再等半秒才換
    let best = cur, bestScore = -Infinity, bestRaw = 0, bestAt = 0;
    const dbg = out.plan || (out.plan = { F0: 0, H: 0, Lsw: 0, cur: 0, sc: [0, 0, 0], clr: [0, 0, 0] });
    dbg.F0 = F0; dbg.H = H; dbg.Lsw = Lsw; dbg.cur = cur;
    for (let lane = 0; lane < road.lanes; lane++) {
      const lc = road.laneCenterAt(lane, st.s + 12);
      let score;
      let raw = -1e6, at = 0;   // raw：照計畫最遠能開到哪；at：到了那條車道時已經開了多遠
      if (lane === cur) { raw = stayLater; score = raw + reach * 0.04; }
      else if (Math.abs(lane - cur) === 1) { if (clearOver(lane, -2 + ENTER * Lsw, Lsw)) { at = Lsw; raw = reachFrom(lane, Lsw, 2, H, Lsw, road.lanes, 0); } score = raw - SWITCH_COST; }
      else if (DBL_ON && Math.abs(lane - cur) === 2 && F0 > 0.55 * Lsw && sweepOk(cur, lane, 0, Lsw)) { at = DBL * Lsw; raw = reachFrom(lane, at, 1, H, Lsw, road.lanes, 0); score = raw - 2 * SWITCH_COST; }
      else score = -1e6;
      // 明確指定的位置（交流道選邊、卡位）要壓過「留在原車道」的黏性；賽車線只是偏好
      if (dLine != null) {
        // 指定位置（卡位）只在那條車道前面夠空時才算數：前面 1–3 秒內就有車的話，為了卡位鑽進去只會被車流擋下來
        let open = 1;
        if (o.preferD != null) { const fb = firstBlock(lane, 0); open = clamp(((fb ? Math.max(0, fb.a) : H) - v * 1.2) / (v * 1.8), 0, 1); }
        score += reach * (o.preferD != null ? 0.7 * open : 0.22) * (1 - Math.min(1, Math.abs(lc - dLine) / (W * 2)));
      }
      // 交流道前已經指定要走哪一側：不再為了閃車換到另一側，只選最靠那一側的車道（擋路就煞車）
      if (commit) score = -Math.abs(lc - dLine);
      dbg.sc[lane] = score; dbg.clr[lane] = score > -1e5 ? 1 : 0;
      if (score > bestScore) { bestScore = score; best = lane; bestRaw = raw; bestAt = at; }
    }
    // 留在這條、等一下再鑽出去：前面那台不用現在就為它煞車
    // 換過去的那條也一樣：計畫是在追到它前面那台之前再鑽出去，就不用一換過去就為那台煞車
    const blkB = best === cur ? blk : firstBlock(best, bestAt);
    mem.pass = blkB && !commit && bestRaw > Math.max(0, blkB.a) + 8 ? blkB.c : null;
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
        const pad = margin - 0.25 + c.wid / 2;
        const lo = Math.min(st.d, dTarget) - pad, hi = Math.max(st.d, dTarget) + pad;
        const cd = c.changeT > 0 ? c.toD : c.d;
        if ((c.d < lo || c.d > hi) && (cd < lo || cd > hi)) continue;
        let vNow = Math.sqrt(c.v * c.v + 2 * decel * Math.max(0, gap - 6));
        // 我正在橫向移動（換車道、斜穿）：這台車佔住的是我路徑上的一段橫向範圍 [uLo, uHi]（以我已經橫移的距離計）。
        // 範圍蓋到終點 → 我最後會在它後面，照跟車煞；否則只要「追到它的時候我不在那段範圍裡」就不用為它減速：
        //   來得及先橫移出去（追到之前已經離開），或是根本還沒進去就已經超過它
        const clearW = c.wid / 2 + hwMe + 0.3;
        const E = Math.abs(dTarget - st.d), dir = dTarget >= st.d ? 1 : -1;
        const u1 = (c.d - st.d) * dir, u2 = (cd - st.d) * dir;
        const uLo = Math.min(u1, u2) - clearW, uHi = Math.max(u1, u2) + clearW;
        let crossing = false;
        if (E > 0.3 && uHi < E - 0.15) {
          crossing = true;
          // 橫移 u 公尺要多久（實測擬合）：先花約 0.4 秒把車頭帶過去，之後每秒約 5 m；已經在橫移中就不用再等那 0.4 秒
          const moving = clamp((-v * st.psi * dir + (st.vl || 0) * dir) / 4, 0, 1);
          const tLat = (u) => (0.4 * (1 - moving) + u / 5) / agl;
          const tOut = uHi <= 0 ? 0 : tLat(uHi) + 0.1;
          const tIn = uLo <= 0 ? 0 : tLat(uLo);
          const rel = v - c.v;
          if (tOut <= 0 || (rel > 1 && (gap + c.len + 4.4 + 3) / rel < tIn * 0.8)) vNow = Infinity;
          else {
            const vPass = c.v + Math.max(0, gap - 3) / (tOut * (o.passSafety ?? 1.2));
            if (vPass > vNow) vNow = vPass;
          }
        }
        // 打算在追到前車之前就離開這條車道：它、以及排在它後面更遠的車，都不用現在為它們煞車
        if (!crossing && mem.pass && c.s >= mem.pass.s) continue;
        if (vNow < vAllowed) { vAllowed = vNow; why = crossing ? 'cross' : 'follow'; }
      }
    }
  }
  out.why = why;

  let throttle = 0, brake = 0;
  if (v < vAllowed - 1) throttle = 1;
  else if (v > vAllowed + 1.5) brake = clamp((v - vAllowed) / 6, 0.2, 1);
  else throttle = 0.4;

  // ── 橫向：前視點 + 曲率前饋
  const kAhead = road.curvature(st.s + look * 0.5);
  const frac = clamp(v / (cfg.vMaxKmh / 3.6), 0, 1);
  const yawAvail = Math.max(
    0.05,
    Math.min((cfg.steerLow + (cfg.steerHigh - cfg.steerLow) * frac) * Math.min(1, v / 4), cfg.latAccelMax / Math.max(v, 6)),
  );
  // 想要的車頭角度：和橫向誤差成正比，但不超過「來得及在到位之前把車頭轉回來」的角度
  // （高速時車頭轉得慢：偏航速率上限 = 抓地力 ÷ 車速，角度給太大就會衝過頭壓到隔壁車道）
  const err = st.d - dTarget, ea = Math.abs(err);
  const psiCap = Math.min(0.35, Math.sqrt((2 * YAW_USE * yawAvail * ea) / Math.max(v, 5)));
  const psiDes = clamp(err / look, -psiCap, psiCap);
  // 車頭角度的修正量除以「現在轉得動多快」：高速時方向盤要打得更積極，否則車頭跟不上
  const steer = clamp(((psiDes - st.psi) * K_PSI + kAhead * v) / yawAvail, -1, 1);

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
