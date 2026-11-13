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

export function collidePlayerTraffic(st, carCfg, traffic, tcfg, road, dt, events) {
  let hits = 0;
  const hl = carCfg.halfLength, hw = carCfg.halfWidth;
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

    // 以穿透較淺的軸分離；前後向要考慮相對速度，避免高速時被判成側撞
    const rel = ut - c.v;
    const longitudinal = penS < penD * 2.5 && ((ds > 0 && rel > 0) || (ds < 0 && rel < 0));
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
      st.d += side * penD;
      if (ud * side < 0) ud = -ud * 0.25;
      ud += side * 1.2;
      ut *= 1 - tcfg.sideSwipeLoss;
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
    if (!(st.carHitCool > 0)) {
      st.carHits = (st.carHits || 0) + 1;
      if (events) events.emit('carHit', { speedLoss: Math.max(0, before - Math.hypot(ut, ud)), side: dd > 0 ? 1 : -1, longitudinal });
    }
    st.carHitCool = 0.35;
  }
  if (hits === 0 && st.carHitCool > 0) st.carHitCool -= dt;
  return hits;
}
