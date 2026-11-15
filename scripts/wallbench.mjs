// 量測：同一個急彎，貼著外側護欄全油門通過 vs 正常煞車過彎。執行：node scripts/wallbench.mjs [mu] [graze]
import { readFileSync } from 'node:fs';
import { createRoad } from '../src/road/spline.js';
import { createCarState, stepCar } from '../src/vehicle/physics.js';
import { drive } from '../src/vehicle/ai.js';

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const base = load('../src/config/cars.json').player;
const zone = load('../src/config/zones.json').default;
const DT = 1 / 60;

export function wallRun(cfg, radius, angle, ride) {
  const road = createRoad(zone.road);
  road.appendSegment({ type: 'straight', length: 400 });
  road.appendSegment({ type: 'curve', radius, angle, ramp: 30 });
  const sExit = road.sMax;
  road.appendSegment({ type: 'straight', length: 700 });
  const st = createCarState({ s: 20, d: 0, vf: cfg.vMaxKmh / 3.6 });
  const inp = {};
  let t = 0, vExit = 0, vMin = Infinity;
  while (st.s < sExit + 300 && t < 60) {
    if (ride) { inp.throttle = 1; inp.brake = 0; inp.steer = 0; inp.analog = true; }
    else drive(st, cfg, road, { dt: DT, line: true, gripUse: 0.8 }, inp);
    stepCar(st, inp, cfg, road, DT, null);
    t += DT;
    if (st.s >= sExit && !vExit) vExit = st.vf;
    if (st.s > 400 && st.s < sExit && st.vf < vMin) vMin = st.vf;
  }
  return { t, vExit: vExit * 3.6, vMin: vMin * 3.6, hits: st.wallHits };
}

if (process.argv[1].endsWith('wallbench.mjs')) {
  const cfg = { ...base };
  if (process.argv[2] != null) cfg.wallRideMu = Number(process.argv[2]);
  if (process.argv[3] != null) cfg.wallLossGraze = Number(process.argv[3]);
  if (process.argv[4] != null) cfg.wallRideFree = Number(process.argv[4]);
  console.log(`mu ${cfg.wallRideMu ?? 0}  graze ${cfg.wallLossGraze}`);
  for (const [r, a] of [[70, 70], [100, 60], [150, 45], [300, 40], [500, 30]]) {
    const A = wallRun(cfg, r, a, true), B = wallRun(cfg, r, a, false);
    console.log(`R${r} ${a}°  貼牆 ${A.t.toFixed(2)}s 出彎 ${A.vExit.toFixed(0)} 最低 ${A.vMin.toFixed(0)}  |  正常 ${B.t.toFixed(2)}s 出彎 ${B.vExit.toFixed(0)} 最低 ${B.vMin.toFixed(0)} 碰牆 ${B.hits}  →  貼牆${A.t < B.t ? '快' : '慢'} ${Math.abs(A.t - B.t).toFixed(2)}s`);
  }
}
