// 除錯用：印出一場對決的逐秒狀態。node scripts/trace.mjs [rivalIndex] [seed]
import { readFileSync } from 'node:fs';
import { autopilot, createAiMemory } from '../src/vehicle/ai.js';
import { createSession } from '../src/race/session.js';

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const cfg = load('../src/config/cars.json').player;
const zone = load('../src/config/zones.json').default;
const tcfg = load('../src/config/traffic.json');
const dcfg = load('../src/config/duel.json');
const rivals = load('../src/config/rivals.json').list;
const ri = Number(process.argv[2] ?? 0), seed = Number(process.argv[3] ?? 12);
const DT = 1 / 60;

const S = createSession({ seed: seed * 1000 + ri, carCfg: cfg, zone, trafficCfg: tcfg, duelCfg: dcfg, rivals });
S.rivalIndex = ri;
const inp = {}, mem = createAiMemory();
let t = 0, n = 0;
while (t < 420 && S.duel.phase !== 'result') {
  autopilot(S.state, cfg, S.road, { traffic: S.obsForPlayer, mem, dt: DT, line: true, gripUse: 0.85, caution: 0.85, margin: 1.25 }, inp);
  S.step(DT, inp);
  t += DT; n++;
  if (S.duel.phase === 'marked') S.tryChallenge();
  if (n % 60 === 0 && S.rival.active && S.duel.phase !== 'marked') {
    const p = S.state, r = S.rival.st;
    console.log(
      `${t.toFixed(0).padStart(3)}s ${S.duel.phase.padEnd(9)} gap ${S.duel.gap.toFixed(1).padStart(7)}  ` +
      `P ${(p.vf * 3.6).toFixed(0).padStart(3)} km/h d ${p.d.toFixed(1).padStart(5)} thr ${inp.throttle} brk ${inp.brake.toFixed(1)} cap ${(inp.vAllowed * 3.6).toFixed(0).padStart(3)}  |  ` +
      `R ${(r.vf * 3.6).toFixed(0).padStart(3)} km/h d ${r.d.toFixed(1).padStart(5)} cap ${(S.rival.input.vAllowed * 3.6).toFixed(0).padStart(3)}  ` +
      `score ${S.duel.scoreP.toFixed(0)}:${S.duel.scoreR.toFixed(0)}`,
    );
  }
}
console.log(S.duel.result);
