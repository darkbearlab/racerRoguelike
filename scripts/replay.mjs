// 重跑一份重播紀錄，逐秒核對狀態校驗碼，並整理出對手的表現。
//   node scripts/replay.mjs                 重跑 replays/ 裡最新的一份
//   node scripts/replay.mjs <檔案>          指定檔案
//   選項： --csv <輸出檔>  每 0.1 秒一列的玩家／對手狀態    --from <秒> --to <秒>  只輸出這段時間
//          --events  列出全部事件
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSession } from '../src/race/session.js';
import { createEvents } from '../src/core/events.js';
import { runReplay } from '../src/core/replay.js';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1] ?? true; };
const flags = new Set(['--csv', '--from', '--to']);
let file = argv.find((a, i) => !a.startsWith('--') && !flags.has(argv[i - 1]));
if (!file) {
  const dir = resolve(import.meta.dirname, '../replays');
  let list = [];
  try { list = readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => resolve(dir, n)); } catch { /* 沒有資料夾 */ }
  if (!list.length) { console.log('replays/ 裡沒有紀錄'); process.exit(1); }
  file = list.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}
const data = JSON.parse(readFileSync(file, 'utf8'));
const DT = 1 / 60;
console.log(`${file}\n錄製 ${data.meta.startedAt}　程式版本 ${data.meta.commit || '?'}　${(data.steps * DT).toFixed(1)} 秒（${data.steps} 步）　輸入 ${data.inputs.length} 筆　操作 ${data.calls.length} 筆`);

const ev = createEvents();
let now = 0;
const log = [];
const NAMES = ['rivalSpawn', 'packSpawn', 'duelCountdown', 'duelGo', 'duelEnd', 'duelZero', 'forkChosen', 'jctPlaced', 'nightStart', 'runOver', 'eventStart', 'eventResult', 'rivalSkipped', 'upgradeGained', 'wrongWay', 'pa'];
for (const name of NAMES) ev.on(name, (e) => {
  if (name === 'duelCountdown' && e.count !== 3) return;
  const brief = {};
  for (const k of ['win', 'reason', 'who', 'lost', 'node', 'night', 'on', 'kind', 'ok']) if (e && e[k] !== undefined) brief[k] = e[k];
  if (e?.def?.name) brief.name = e.def.name;
  log.push([now, name, brief]);
});

// 每場對決：對手的平均車速、在直線上被什麼拖慢、撞了幾次
const duels = [];
let cur = null;
const csv = opt('--csv') ? ['t,ps,pd,pv,ppsi,pthr,pbrk,psteer,ractive,rs,rd,rv,rwhy,rlane,gap,phase,traffic'] : null;
const from = Number(opt('--from') ?? 0), to = Number(opt('--to') ?? Infinity);
const res = runReplay(data, {
  createSession, events: ev,
  onStep(S, n, inp) {
    now = (n + 1) * DT;
    const r = S.rival, racing = S.duel.phase === 'racing' && r.active;
    if (racing && !cur) { cur = { name: r.def.name, top: r.def.topSpeedKmh, t0: now, t: 0, v: 0, straight: 0, vS: 0, why: {}, hits0: r.st.carHits || 0, walls0: r.st.wallHits, pv: 0 }; duels.push(cur); }
    if (!racing && cur) { cur.t1 = now; cur = null; }
    if (cur && !r.onAlt) {
      const rs = r.st;
      cur.t += DT; cur.v += rs.vf * DT; cur.pv += S.state.vf * DT;
      cur.hits = (rs.carHits || 0) - cur.hits0; cur.walls = rs.wallHits - cur.walls0;
      let straight = true;
      for (let a = 0; a <= 200; a += 20) if (Math.abs(S.road.curvature(rs.s + a)) > 0.0015) { straight = false; break; }
      if (straight) {
        cur.straight += DT; cur.vS += rs.vf * DT;
        if (rs.vf < cur.top / 3.6 * 0.9 && r.input.throttle < 1) cur.why[r.input.why] = (cur.why[r.input.why] || 0) + DT;
      }
    }
    if (csv && n % 6 === 0 && now >= from && now <= to) {
      const st = S.state, rs = r.st;
      let near = 0;
      if (r.active) for (const c of S.traffic.cars) if (c.active && !c.onAlt && c.s > rs.s - 10 && c.s < rs.s + 150) near++;
      csv.push([now.toFixed(2), st.s.toFixed(1), st.d.toFixed(2), (st.vf * 3.6).toFixed(1), st.psi.toFixed(3), inp.throttle, inp.brake, inp.steer,
        r.active ? 1 : 0, r.active ? rs.s.toFixed(1) : '', r.active ? rs.d.toFixed(2) : '', r.active ? (rs.vf * 3.6).toFixed(1) : '', r.active ? r.input.why : '', r.active ? r.mem.lane : '',
        r.active ? (rs.s - st.s).toFixed(1) : '', S.duel.phase, near].join(','));
    }
  },
});

console.log(res.firstDiff < 0
  ? `校驗：${res.checked} 個檢查點全部相同（逐步重現成功）`
  : `校驗：第 ${(res.firstDiff * DT).toFixed(0)} 秒開始和錄製時不同（共 ${res.checked} 個檢查點）。程式版本不同、或錄製時改過設定檔，就會這樣`);

if (duels.length) {
  console.log('\n對決（對手的表現）');
  for (const d of duels) {
    const why = Object.entries(d.why).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / Math.max(d.straight, 1e-9) * 100).toFixed(0)}%`).join('  ');
    console.log(`  ${d.t0.toFixed(0).padStart(4)} 秒  ${d.name.padEnd(8)} ${d.t.toFixed(0).padStart(3)} 秒  對手平均 ${(d.v / d.t * 3.6).toFixed(0)} km/h（極速 ${d.top}）  玩家平均 ${(d.pv / d.t * 3.6).toFixed(0)}  直線 ${(d.vS / Math.max(d.straight, 1e-9) * 3.6).toFixed(0)}（${(d.vS / Math.max(d.straight, 1e-9) * 3.6 / d.top * 100).toFixed(0)}%）  撞車 ${d.hits ?? 0}  碰牆 ${d.walls ?? 0}  直線上被拖慢：${why || '無'}`);
  }
}
const shown = opt('--events') ? log : log.filter(([, n]) => n === 'duelEnd' || n === 'runOver' || n === 'nightStart');
if (shown.length) {
  console.log('\n事件');
  for (const [t, name, b] of shown) console.log(`  ${t.toFixed(1).padStart(6)}  ${name}  ${JSON.stringify(b)}`);
}
if (csv) { writeFileSync(opt('--csv'), csv.join('\n')); console.log(`\n已輸出 ${csv.length - 1} 列到 ${opt('--csv')}`); }
