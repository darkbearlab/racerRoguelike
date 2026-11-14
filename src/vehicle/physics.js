// 街機車輛物理，在道路座標 (s, d, psi) 下積分。純數學、不依賴 three.js。
//
//   s    沿路距離（m）      d   橫向偏移（m，右為正）
//   psi  車頭相對道路切線的角度（rad，左為正）
//   vf   車身前進方向速度   vl  車身橫向速度（右為正）
//
// 重點：psi 每步扣掉「曲率 × 前進速度」，所以彎道不打方向盤就會衝向外側護欄；
// s 的推進依 d 修正，內線比較短。
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;

export function createCarState(init = {}) {
  return {
    s: init.s ?? 0,
    d: init.d ?? 0,
    psi: 0,
    vf: init.vf ?? 0,
    vl: 0,
    steer: 0,        // 平滑後的方向輸入，+1 = 左
    yawRate: 0,
    drifting: false,
    driftTime: 0,
    wallContact: 0,  // 剛碰牆後的倒數秒數（給特效與除錯用）
    wallSide: 0,     // 最近一次碰到的牆：+1 右、−1 左
    wallHits: 0,
    dist: 0,         // 累積行駛距離
    dragMul: 1,      // 吸尾流時由外部設成 < 1
    speed: 0,
    braking: false,
  };
}

/** 引擎曲線用的參考速度：讓實際極速剛好等於 vMax（扣掉阻力之後）。 */
export function engineRefSpeed(cfg) {
  const vMax = cfg.vMaxKmh / 3.6;
  const resist = (cfg.dragCoef * vMax * vMax + cfg.rollResist) / cfg.power;
  return vMax / Math.sqrt(Math.max(0.05, 1 - resist));
}

export function stepCar(st, input, cfg, road, dt, events) {
  // topMul：暫時的極速倍率（成長「不服輸」：對決中落後時），連引擎曲線一起放大
  const tm = st.topMul || 1;
  const vMax = cfg.vMaxKmh * tm / 3.6;
  const vEng = engineRefSpeed(cfg) * tm;
  const throttle = clamp(input.throttle || 0, 0, 1);
  const brake = clamp(input.brake || 0, 0, 1);
  const handbrake = !!input.handbrake;

  // ── 方向輸入平滑（鍵盤按住時逐漸加到滿轉向）
  const target = clamp(input.steer || 0, -1, 1);
  const growing = Math.abs(target) > Math.abs(st.steer) && target * st.steer >= 0;
  const rate = (growing ? cfg.steerInRate : cfg.steerOutRate) * (input.analog ? 3 : 1);
  const dSteer = target - st.steer;
  st.steer += clamp(dSteer, -rate * dt, rate * dt);

  const vAbs = Math.abs(st.vf);

  // ── 甩尾狀態
  if (!st.drifting) {
    const enter =
      (handbrake && Math.abs(st.steer) > 0.2 && st.vf > 15) ||
      (!input.noDrift && brake > 0.5 && Math.abs(st.steer) > 0.7 && st.vf > 22);
    if (enter) { st.drifting = true; st.driftTime = 0; }
  } else {
    st.driftTime += dt;
    const settle = !handbrake && Math.abs(st.vl) < 1.2 && st.driftTime > 0.3;
    if (settle || st.vf < 8) {
      st.drifting = false;
      if (events) events.emit('driftEnd', { time: st.driftTime });
    }
  }
  const drift = st.drifting;

  // ── 偏航速率：低速靈敏、高速收斂；非甩尾時不超過抓地極限，高速不會一碰就暴衝
  const frac = clamp(vAbs / vMax, 0, 1);
  const dir = st.vf >= -0.1 ? 1 : -1;
  let yawMax = lerp(cfg.steerLow, cfg.steerHigh, frac) * Math.min(1, vAbs / 4);
  if (drift) yawMax *= cfg.driftYawMul;
  const gripCap = ((drift ? cfg.driftYawMul : 1) * cfg.latAccelMax) / Math.max(vAbs, 6);
  let r = st.steer * Math.min(yawMax, gripCap) * dir;
  // 自動回正：車頭轉向速度方向（類似後傾角效應）
  const beta = Math.atan2(st.vl, Math.max(vAbs, 1));
  r -= beta * cfg.alignRate * (drift ? 0.3 : 1) * (1 - 0.6 * Math.abs(st.steer)) * dir;
  // 貼牆時方向盤不能再把車頭往牆裡轉（否則會反覆撞牆被扣到停）
  if (st.wallContact > 0 && r * st.wallSide < 0) r = 0;
  st.yawRate = r;

  // ── 縱向
  let drive = 0;
  if (throttle > 0 && st.vf < vEng) drive += throttle * cfg.power * (1 - (st.vf / vEng) ** 2);
  if (st.boostAccel > 0) drive += st.boostAccel; // 短暫加速（成長：甩尾加速）
  let resist = cfg.dragCoef * st.dragMul * st.vf * st.vf + cfg.rollResist;
  if (throttle === 0) resist += cfg.engineBrake;
  if (brake > 0) {
    if (st.vf > 0.5) resist += brake * cfg.brakeDecel * (drift ? cfg.driftBrakeMul : 1);
    else if (st.vf > -cfg.reverseMaxKmh / 3.6) drive -= brake * 3.5;
  }
  if (handbrake) resist += cfg.handbrakeDecel;
  resist += Math.abs(st.vl) * (drift ? cfg.slideScrubDrift : cfg.slideScrub);
  st.braking = brake > 0 && st.vf > 0.5;

  let vf = st.vf + drive * dt;
  const dv = resist * dt;
  vf = Math.abs(vf) <= dv ? 0 : vf - Math.sign(vf) * dv;

  // ── 橫向：車身轉動後速度向量留在原方向，再由抓地力拉回
  let vl = st.vl + st.vf * r * dt;
  vf -= st.vl * r * dt;
  const grip = drift ? cfg.gripDrift : cfg.grip;
  const latMax = cfg.latAccelMax * (drift ? cfg.driftLatMul : 1);
  const aLat = clamp(-grip * vl, -latMax, latMax);
  const dvl = aLat * dt;
  vl = Math.abs(dvl) > Math.abs(vl) ? 0 : vl + dvl;

  // ── 轉到道路座標並積分
  let psi = st.psi;
  const kappa = road.curvature(st.s);
  let cp = Math.cos(psi), sp = Math.sin(psi);
  let ut = vf * cp + vl * sp;   // 沿切線
  let ud = -vf * sp + vl * cp;  // 沿右向
  const sdot = ut / Math.max(0.3, 1 + kappa * st.d);
  let d = st.d + ud * dt;
  psi += (r - kappa * sdot) * dt;
  if (psi > Math.PI) psi -= Math.PI * 2;
  else if (psi < -Math.PI) psi += Math.PI * 2;

  // ── 護欄：限制 d 的範圍，依撞擊角度扣速度，車頭轉回沿路方向
  //    左右寬度逐點查詢（匯入路段左側會多一個車道）
  const body = cfg.halfWidth + 0.5 * Math.abs(Math.sin(psi));
  const sNext = st.s + sdot * dt;
  const limR = road.widthRight(sNext) - body;
  const limL = road.widthLeft(sNext) - body;
  const wasContact = st.wallContact > 0;
  if (wasContact) st.wallContact -= dt;
  const tol = wasContact ? 0.03 : 0;
  const side = d > limR - tol ? 1 : d < -(limL - tol) ? -1 : 0;
  if (side !== 0) {
    const lim = side > 0 ? limR : limL;
    st.wallSide = side;
    if (d * side > lim) d = side * lim;
    const vout = ud * side;
    const speed = Math.hypot(ut, ud);
    if (vout > 0) {
      // 撞擊只在剛接觸時扣一次；持續貼牆只算摩擦，不會被一路扣到停
      if (vout > 1.0 && !wasContact) {
        const sinA = clamp(vout / Math.max(speed, 1), 0, 1);
        const loss = lerp(cfg.wallLossGraze, cfg.wallLossHeadOn, sinA);
        ut *= 1 - loss;
        st.wallHits++;
        if (events) events.emit('wallHit', { loss, speedLoss: speed * loss, side, sinA });
      }
      ud = -side * Math.min(vout * cfg.wallBounce, 1.5);
    }
    // 貼牆摩擦
    const scrape = cfg.wallScrapeDecel * dt;
    ut = Math.abs(ut) <= scrape ? ut : ut - Math.sign(ut) * scrape;
    // 車頭若朝向牆，轉回沿路方向（逆向時轉回逆向）
    // 貼牆期間，方向盤不能再把車頭往牆裡轉
    if (wasContact && -Math.sin(psi) * side > -Math.sin(st.psi) * side) psi = st.psi;
    const intoWall = -Math.sin(psi) * side > 0;
    if (intoWall) {
      const tgt = Math.abs(psi) > Math.PI / 2 ? Math.sign(psi) * Math.PI : 0;
      psi += (tgt - psi) * Math.min(1, 8 * dt);
    }
    cp = Math.cos(psi); sp = Math.sin(psi);
    vf = ut * cp - ud * sp;
    vl = ut * sp + ud * cp;
    st.wallContact = 0.12;
  }

  // ── 交流道分隔島前的楔形緩衝：把車往兩側推開，只算輕擦，不會卡在中間
  const gore = road.gore(sNext);
  if (gore > 0 && Math.abs(d) < gore + cfg.halfWidth) {
    const gs = d >= 0 ? 1 : -1;
    d = gs * (gore + cfg.halfWidth);
    if (ud * gs < 0) {
      if (!(st.goreCool > 0)) {
        ut *= 1 - cfg.wallLossGraze;
        if (events) events.emit('wallHit', { loss: cfg.wallLossGraze, speedLoss: Math.abs(ut) * cfg.wallLossGraze, side: -gs, sinA: 0.1 });
      }
      ud = gs * 0.8;
      cp = Math.cos(psi); sp = Math.sin(psi);
      vf = ut * cp - ud * sp;
      vl = ut * sp + ud * cp;
    }
    st.goreCool = 0.5;
  } else if (st.goreCool > 0) st.goreCool -= dt;

  if (!Number.isFinite(vf + vl + d + psi + sdot)) {
    // 不該發生；真的發生就停在原地，不讓 NaN 擴散
    vf = 0; vl = 0; d = clamp(st.d, -limL, limR) || 0; psi = 0;
  } else {
    // 後方道路已回收：逆向開到盡頭就停住
    const sNew = st.s + sdot * dt;
    const sFloor = road.sMin + 8;
    if (sNew < sFloor && sdot < 0) { st.s = Math.max(st.s, sFloor); vf *= 0.5; vl = 0; }
    else { st.s = sNew; st.dist += sdot * dt; }
  }
  st.d = d;
  st.psi = psi;
  st.vf = vf;
  st.vl = vl;
  st.speed = Math.hypot(vf, vl);
  return st;
}
