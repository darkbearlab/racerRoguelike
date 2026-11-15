// 對向車流：在對向車道（road/opposite.js）上迎面開過來的車。純邏輯，不依賴 three.js。
// 只是景物：隔著中央分隔帶，不碰撞、不影響玩法。車的欄位和一般車流相同，畫面共用同一套 trafficMesh。
import { OPP, oppAt } from '../road/opposite.js';

export function createOncoming(road, rng, cfg) {
  const oc = cfg.oncoming || {};
  const N = oc.maxCars ?? 20, AHEAD = oc.ahead ?? 1050, BEHIND = oc.behind ?? 220;
  const typeNames = Object.keys(cfg.types);
  const cars = [];
  for (let i = 0; i < N; i++) {
    cars.push({
      id: i, active: false, hidden: false, onAlt: false, type: 'sedan', len: 4.5, wid: 1.8, height: 1.4,
      s: 0, d: 0, h: 0, ps: 0, pd: 0, v: 0, cruise: 0, lane: 0, yaw: 0, braking: false, blink: 0, changeT: 0, hue: 0,
    });
  }
  const api = { cars, count: 0, density: 1, maxCars: N };

  const pickType = () => {
    let total = 0;
    for (const k of typeNames) total += cfg.types[k].weight;
    let r = rng.next() * total;
    for (const k of typeNames) { r -= cfg.types[k].weight; if (r <= 0) return k; }
    return typeNames[0];
  };
  const laneFree = (lane, s, gap) => {
    for (const c of cars) if (c.active && c.lane === lane && Math.abs(c.s - s) < gap) return false;
    return true;
  };
  /** 把車放到對向車道上的位置；那一段沒有對向車道就先藏起來 */
  function place(c) {
    const o = oppAt(road, c.s);
    c.hidden = !o;
    if (!o) return;
    c.d = road.widthRight(c.s) + o.off + road.shoulder + (c.lane + 0.5) * road.laneWidth;
    c.h = o.h;
  }
  function spawn(s, lane) {
    const c = cars.find((k) => !k.active);
    if (!c) return null;
    const type = pickType(), t = cfg.types[type];
    c.active = true; c.type = type; c.len = t.len; c.wid = t.wid; c.height = t.height;
    c.s = s; c.lane = lane; c.cruise = rng.range(t.kmhMin, t.kmhMax) / 3.6; c.v = c.cruise;
    c.hue = rng.next(); c.braking = false;
    place(c);
    c.ps = c.s; c.pd = c.d;
    return c;
  }
  const want = () => Math.min(N, Math.round((oc.perKm ?? 11) * api.density * ((AHEAD + BEHIND) / 1000)));

  /** 開局先鋪滿 */
  api.populate = (player) => {
    const n = want();
    for (let k = 0; k < n * 4 && api.count < n; k++) {
      const lane = rng.int(0, road.lanes - 1), s = player.s + rng.range(-BEHIND + 20, Math.min(AHEAD, road.sMax - player.s - 60));
      if (laneFree(lane, s, 40) && spawn(s, lane)) api.count++;
    }
  };
  api.snapshot = () => { for (const c of cars) { c.ps = c.s; c.pd = c.d; } };

  api.update = (dt, player) => {
    let active = 0;
    for (const c of cars) {
      if (!c.active) continue;
      const rel = c.s - player.s;
      if (rel < -BEHIND || rel > AHEAD + 300 || c.s < road.sMin + 10) { c.active = false; continue; }
      active++;
    }
    if (active < want()) {
      const lane = rng.int(0, road.lanes - 1), s = player.s + AHEAD + rng.range(0, 120);
      if (s < road.sMax - 60 && laneFree(lane, s, 45) && spawn(s, lane)) active++;
    }
    for (const c of cars) {
      if (!c.active) continue;
      // 跟車：同車道前面（s 比較小）的車太近就不超過它的車速
      let lead = Infinity, gap = Infinity;
      for (const o of cars) {
        if (!o.active || o === c || o.lane !== c.lane) continue;
        const g = c.s - o.s - (c.len + o.len) / 2;
        if (g > 0 && g < gap) { gap = g; lead = o.v; }
      }
      const desired = gap < 10 + c.v ? Math.min(c.cruise, lead) : c.cruise;
      c.braking = desired < c.v - 0.5;
      c.v += Math.max(-5 * dt, Math.min(1.5 * dt, desired - c.v));
      c.s -= c.v * dt;
      place(c);
    }
    api.count = active;
  };
  return api;
}

export { OPP };
