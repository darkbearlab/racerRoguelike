// 路段生成器：依區域權重隨機串接路段。純數學，不依賴 three.js。
// 朝向限制在 ±maxHeading 內，道路永遠大致往 +z 前進，不會自己繞回來交叉。
// 生成狀態存在 road.gen 上，分歧時兩條分支各有一份，交換分支時跟著走。
import { DS } from './spline.js';
import { buildJunction } from './junction.js';

const RAD = 180 / Math.PI;

export function createGenerator(road, rng, zone) {
  const maxHeading = zone.maxHeadingDeg ?? 70;
  let current = zone; // 目前的區域（換晚時由 setZone 切換）
  // 路段權重：分支上有特殊路段（捷徑）時，在那段距離內用它的權重
  const zoneFor = (g, r) => (g.special && r.sMax < g.special.until ? g.special : current);
  const stats = { straight: 0, gentle: 0, sharp: 0, s: 0, tunnel: 0, merge: 0, junction: 0 };
  road.gen = { heading: 0, sinceMerge: 0, sinceTunnel: 0, started: false };

  function pick(g, W) {
    const types = Object.keys(W);
    const total = types.reduce((a, k) => a + W[k], 0);
    for (let tries = 0; tries < 8; tries++) {
      let r = rng.next() * total;
      let t = types[0];
      for (const k of types) { r -= W[k]; if (r <= 0) { t = k; break; } }
      if (t === 'merge' && g.sinceMerge < 700) continue;
      if (t === 'tunnel' && g.sinceTunnel < 900) continue;
      return t;
    }
    return 'straight';
  }

  /** 決定彎道方向與角度，讓朝向留在限制內 */
  function turn(g, angle) {
    let sign = rng.next() < 0.5 ? 1 : -1;
    if (Math.abs(g.heading + sign * angle) > maxHeading) sign = -sign;
    if (Math.abs(g.heading + sign * angle) > maxHeading) angle = Math.max(8, maxHeading - Math.abs(g.heading));
    g.heading += sign * angle;
    return sign * angle;
  }

  const straight = (length, extra) => ({ type: 'straight', length, ...extra });
  const curve = (radius, angle, ramp, extra) => ({ type: 'curve', radius, angle, ramp, ...extra });
  const lengthOf = (p) => (p.type === 'curve' ? (Math.abs(p.angle) / RAD) * p.radius + p.ramp : p.length);

  function gentle(g, extra) {
    const radius = rng.range(300, 600);
    const len = rng.range(150, 400);
    return curve(radius, turn(g, Math.min(55, ((len - 50) / radius) * RAD)), 50, extra);
  }
  function sharp(g, extra) {
    const radius = rng.range(60, 120);
    const len = rng.range(80, 200);
    return curve(radius, turn(g, Math.min(80, Math.max(25, ((len - 30) / radius) * RAD))), 30, extra);
  }

  function next(g, r) {
    if (!g.started) { g.started = true; return [straight(400)]; }
    const z = zoneFor(g, r);
    const sr = z.straightRange || [200, 800];
    const t = pick(g, z.weights);
    stats[t]++;
    let out;
    if (t === 'straight') out = [straight(rng.range(sr[0], sr[1]))];
    else if (t === 'gentle') out = [gentle(g)];
    else if (t === 'sharp') out = [sharp(g)];
    else if (t === 's') {
      const radius = rng.range(140, 220);
      const ang = Math.min(42, ((rng.range(100, 200) - 40) / radius) * RAD);
      const a = turn(g, ang);
      g.heading -= a; // 第二個彎轉回來
      out = [curve(radius, a, 40), curve(radius, -a, 40)];
    } else if (t === 'tunnel') {
      const tn = { tunnel: true };
      out = [straight(rng.range(120, 300), tn)];
      const mid = rng.next();
      if (mid < 0.45) out.push(gentle(g, tn));
      else if (mid < 0.75) out.push(curve(rng.range(120, 200), turn(g, rng.range(30, 60)), 40, tn));
      out.push(straight(rng.range(120, 400), tn));
      g.sinceTunnel = 0;
    } else {
      out = [straight(200, { merge: true })];
      g.sinceMerge = 0;
    }
    for (const p of out) {
      const l = lengthOf(p);
      g.sinceMerge += l;
      if (!p.tunnel) g.sinceTunnel += l;
    }
    return out;
  }

  function fillRoad(r, sTarget) {
    let guard = 0;
    while (r.sMax < sTarget && guard++ < 64) for (const p of next(r.gen, r)) r.appendSegment(p);
  }

  return {
    stats,
    get heading() { return road.gen.heading; },
    get zone() { return current; },
    /** 換區域：之後新生成的路段用新的權重（已生成的不變） */
    setZone(z) { current = z; },
    /** 生成到 sTarget 為止（主線；alt 分支另外給） */
    fill(sTarget, target = road) { fillRoad(target, sTarget); },

    /**
     * 在 sFrom 之後找一個適合的位置把道路砍斷，插入交流道。
     * 回傳 { alt, forkS, cutS }：alt 是另一條分支（右），主線預設接左分支。
     */
    insertJunction(sFrom) {
      // 找切點：直線、非隧道、非匯入、非其他交流道
      let ic = Math.ceil(sFrom / DS);
      const limit = Math.min(road.iMax - 4, ic + 250);
      while (ic < limit && (Math.abs(road.nodeKappa(ic)) > 1e-4 || road.nodeTunnel(ic) || road.nodeZone(ic)
        || road.nodeWl(ic) > road.halfWidth + 0.01 || road.nodeTunnel(ic - 1))) ic++;
      road.truncate(ic);
      const g = road.gen;
      g.heading = road.nodeTheta(road.iMax) * RAD;
      g.started = true;
      // 朝向太偏就先修正，分歧後兩條分支才都留在限制內
      const BR = 24;
      if (Math.abs(g.heading) > maxHeading - BR - 6) {
        const fix = -Math.sign(g.heading) * (Math.abs(g.heading) - (maxHeading - BR - 12));
        road.appendSegment(curve(320, fix, 50));
        g.heading += fix;
      }
      const cutS = ic * DS;
      const alt = buildJunction(road, BR);
      g.heading += BR; g.sinceMerge = 300; g.sinceTunnel = Math.max(g.sinceTunnel, 600);
      alt.gen = { ...g, heading: g.heading - 2 * BR };
      stats.junction++;
      return { alt, forkS: road.fork.s, cutS };
    },
  };
}
