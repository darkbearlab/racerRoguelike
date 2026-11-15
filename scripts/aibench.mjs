// 量對手 AI 在車流裡掉多少速：每位對手獨自跑 10 分鐘對決狀態
import { readFileSync } from 'node:fs';
import { autopilot, createAiMemory } from '../src/vehicle/ai.js';
import { createSession } from '../src/race/session.js';
import { tune } from '../src/vehicle/ai.js';
if (process.env.TUNE) tune(JSON.parse(process.env.TUNE));
const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const cfg = load('../src/config/cars.json').player;
const zone = load('../src/config/zones.json').default;
const tcfg = load('../src/config/traffic.json');
const dcfg = load('../src/config/duel.json');
const rivals = load('../src/config/rivals.json').list.filter((r) => r.tier === 'normal' || r.tier === 'boss');
const DT = 1 / 60;
const WHY = {}; let TOT = 0;
let sumAvg = 0, sumHits = 0, sumBrake = 0, n = 0;
for (const seed of [777, 4242]) for (const def of rivals) {
  const S = createSession({ seed, carCfg: cfg, zone, trafficCfg: tcfg, duelCfg: { ...dcfg, targets: { normal: 1e9, boss: 1e9 }, breakaway: 1e9 }, rivals: [def], mode: 'loop' });
  const inp = {}, mem = createAiMemory();
  let t = 0, race = 0, dist0 = null, brakeStraight = 0, dips = 0, low = false, straightT = 0, vSum = 0;
  while (t < 600) {
    autopilot(S.state, cfg, S.road, { traffic: S.obsForPlayer, mem, dt: DT, speedCap: S.rival.active ? Math.max(20, S.rival.st.vf + (S.rival.st.s - S.state.s - (S.duel.phase === 'racing' ? 80 : 20)) * 0.25) : 45 }, inp);
    S.step(DT, inp);
    t += DT;
    if (S.duel.phase === 'marked') S.tryChallenge();
    if (S.duel.phase === 'racing' && !S.rival.onAlt) {
      const rs = S.rival.st;
      if (dist0 == null) dist0 = rs.dist;
      race += DT;
      let straight = true;
      for (let a = 0; a <= 200; a += 20) if (Math.abs(S.road.curvature(rs.s + a)) > 0.0015) { straight = false; break; }
      if (straight) {
        straightT += DT; vSum += rs.vf * DT;
        if (S.rival.input.brake > 0) brakeStraight += DT;
        if (rs.vf < S.rival.cfg.vMaxKmh / 3.6 * 0.9 && S.rival.input.throttle < 1) { const w = S.rival.input.why; WHY[w] = (WHY[w] || 0) + DT; } TOT += DT;
        const top = S.rival.cfg.vMaxKmh / 3.6;
        if (rs.vf < top * 0.7) { if (!low) { dips++; low = true; } } else if (rs.vf > top * 0.85) low = false;
      }
    }
  }
  const rs = S.rival.st, top = S.rival.def.topSpeedKmh;
  const avg = (rs.dist - dist0) / race * 3.6, sAvg = vSum / straightT * 3.6;
  console.log(`${seed} ${def.name.padEnd(8)} 極速 ${top.toFixed(0)}  全程平均 ${avg.toFixed(0)}  直線平均 ${sAvg.toFixed(0)}（${(sAvg / top * 100).toFixed(0)}%）  直線煞車 ${(brakeStraight / straightT * 100).toFixed(1)}%  直線掉到七成以下 ${dips} 次  撞車 ${rs.carHits || 0}  碰牆 ${rs.wallHits}`);
  sumAvg += sAvg / top; sumHits += rs.carHits || 0; sumBrake += brakeStraight / straightT; n++;
}
console.log(`平均：直線車速 ${(sumAvg / n * 100).toFixed(1)}% 極速，直線煞車 ${(sumBrake / n * 100).toFixed(1)}%，撞車共 ${sumHits}`);

console.log('直線上沒全油門且低於九成極速的時間佔比：', Object.entries(WHY).map(([k, v]) => `${k} ${(v / TOT * 100).toFixed(1)}%`).join('  '));
