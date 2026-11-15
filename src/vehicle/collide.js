// 車對車碰撞：在道路座標下用方形碰撞盒判定，推開重疊、交換部分速度。
// 從後方追撞一般車輛會大幅減速，是鑽車縫的主要風險。
/**
 * 兩台賽車（玩家與對手）互撞：質量相同，前後向交換部分速度，側向各推開一半。
 * 回傳是否有接觸。
 */
export function collidePair(a, cfgA, b, cfgB, road, events) {
  const ds = b.s - a.s;
  const penS = cfgA.halfLength + cfgB.halfLength - Math.abs(ds);
  if (penS <= 0) return false;
  const dd = b.d - a.d;
  const penD = cfgA.halfWidth + cfgB.halfWidth - Math.abs(dd);
  if (penD <= 0) return false;

  const toRoad = (st) => {
    const c = Math.cos(st.psi), s = Math.sin(st.psi);
    return [st.vf * c + st.vl * s, -st.vf * s + st.vl * c];
  };
  const fromRoad = (st, ut, ud) => {
    const c = Math.cos(st.psi), s = Math.sin(st.psi);
    st.vf = ut * c - ud * s; st.vl = ut * s + ud * c; st.speed = Math.hypot(st.vf, st.vl);
  };
  let [ua, da] = toRoad(a);
  let [ub, db] = toRoad(b);
  const rel = ua - ub; // > 0：a 比 b 快
  const longitudinal = penS < penD * 2.5 && ((ds > 0 && rel > 0) || (ds < 0 && rel < 0));
  let impact;
  if (longitudinal) {
    // 後車減速、前車被推一把
    const push = penS / 2;
    if (ds > 0) { a.s -= push; b.s += push; } else { a.s += push; b.s -= push; }
    ua -= rel * 0.55; ub += rel * 0.4;
    impact = Math.abs(rel) * 0.55;
  } else {
    const side = dd > 0 ? 1 : -1; // b 在 a 的右邊
    a.d -= side * penD / 2; b.d += side * penD / 2;
    const relD = da - db;
    if (relD * side > 0) { da -= relD * 0.6; db += relD * 0.6; }
    da -= side * 0.8; db += side * 0.8;
    ua *= 0.985; ub *= 0.985;
    impact = Math.abs(relD) + 1;
  }
  for (const [st, cfg] of [[a, cfgA], [b, cfgB]]) {
    const maxR = road.widthRight(st.s) - cfg.halfWidth, maxL = road.widthLeft(st.s) - cfg.halfWidth;
    if (st.d > maxR) st.d = maxR; else if (st.d < -maxL) st.d = -maxL;
  }
  fromRoad(a, ua, da);
  fromRoad(b, ub, db);
  if (events && !(a.pairCool > 0)) events.emit('carHit', { speedLoss: impact, side: dd > 0 ? 1 : -1, longitudinal, rival: true });
  a.pairCool = 0.35;
  return true;
}

// 和一般車流的碰撞。三個原則（缺一個都會出現「卡在車縫裡不動、然後瞬間移動」）：
//   1. 追撞只認「這一步才剛碰到車尾」的淺重疊；已經並排卻深度重疊（被擠進去的）一律當側撞，不會把車一次往後搬好幾公尺
//   2. 側撞時對方也會被擠開一點（c.push，之後慢慢回到車道中央），兩台並排的車中間才鑽得過去
//   3. 側撞的速度損失只在剛碰到時扣一次，持續貼著只算摩擦
const NUDGE = 0.55;   // 一般車最多被擠開多少（m）
export function collidePlayerTraffic(st, carCfg, traffic, tcfg, road, dt, events) {
  let hits = 0;
  const hl = carCfg.halfLength, hw = carCfg.halfWidth;
  const fresh = !(st.carHitCool > 0);
  for (const c of traffic.cars) {
    if (!c.active || c.onAlt) continue;
    const ds = c.s - st.s;
    const penS = hl + c.len / 2 - Math.abs(ds);
    if (penS <= 0) continue;
    const dd = c.d - st.d;
    const penD = hw + c.wid / 2 - Math.abs(dd);
    if (penD <= 0) continue;

    const cp = Math.cos(st.psi), sp = Math.sin(st.psi);
    let ut = st.vf * cp + st.vl * sp;
    let ud = -st.vf * sp + st.vl * cp;
    const before = Math.hypot(ut, ud);

    const rel = ut - c.v;
    const closing = (ds > 0 && rel > 0) || (ds < 0 && rel < 0);
    const longitudinal = closing && penS < penD * 2.5 && penS < Math.abs(rel) * dt + 0.5;
    if (longitudinal) {
      if (ds > 0) {
        // 玩家追撞前車
        st.s -= penS;
        const keep = c.v + rel * tcfg.rearEndKeep;
        c.v += rel * tcfg.rearEndPush;
        ut = keep;
      } else {
        // 玩家被後車追撞
        c.s -= penS;
        ut += -rel * 0.3;
        c.v = Math.max(0, c.v + rel * 0.6);
      }
    } else {
      const side = dd > 0 ? -1 : 1; // 把玩家往遠離對方的方向推
      // 對方先讓一點（不超過 NUDGE，也不會被擠出護欄）
      const cdir = -side;
      const lim = (cdir > 0 ? road.widthRight(c.s) : road.widthLeft(c.s)) - c.wid / 2 - 0.15;
      let give = Math.min(penD * 0.5, Math.max(0, NUDGE - (c.push || 0) * cdir), Math.max(0, lim - c.d * cdir));
      if (!(give > 0)) give = 0;
      c.push = (c.push || 0) + cdir * give; c.d += cdir * give;
      st.d += side * (penD - give);
      if (ud * side < 0) ud = -ud * 0.25;
      if (fresh) { ud += side * 1.2; ut *= 1 - tcfg.sideSwipeLoss; }
      else { const scrape = (tcfg.scrapeDecel ?? 5) * dt; ut = Math.abs(ut) <= scrape ? ut : ut - Math.sign(ut) * scrape; }
    }

    // 側推不可把車推出護欄
    const maxR = road.widthRight(st.s) - hw, maxL = road.widthLeft(st.s) - hw;
    if (st.d > maxR) st.d = maxR; else if (st.d < -maxL) st.d = -maxL;

    const cp2 = Math.cos(st.psi), sp2 = Math.sin(st.psi);
    st.vf = ut * cp2 - ud * sp2;
    st.vl = ut * sp2 + ud * cp2;
    st.speed = Math.hypot(st.vf, st.vl);
    hits++;
    // 同一次接觸只計一次、只發一次事件
    if (fresh) {
      st.carHits = (st.carHits || 0) + 1;
      if (events) events.emit('carHit', { speedLoss: Math.max(0, before - Math.hypot(ut, ud)), side: dd > 0 ? 1 : -1, longitudinal });
    }
    st.carHitCool = 0.35;
  }
  // 真的鑽不過去（兩邊都擠到底了還是重疊，例如旁邊的車正在切過來）：不硬擠，放慢到和那台車一樣、慢慢退到它後面
  if (hits > 1) {
    for (const c of traffic.cars) {
      if (!c.active || c.onAlt) continue;
      const ds = c.s - st.s;
      const penS = hl + c.len / 2 - Math.abs(ds);
      if (penS <= 0 || hw + c.wid / 2 - Math.abs(c.d - st.d) <= 0.08) continue;
      if (ds > -1) {
        if (st.vf > c.v) { st.vf = Math.max(c.v, st.vf - 30 * dt); st.speed = Math.hypot(st.vf, st.vl); }
        st.s -= Math.min(penS, 9 * dt);
      }
    }
  }
  if (hits === 0 && st.carHitCool > 0) st.carHitCool -= dt;
  return hits;
}
