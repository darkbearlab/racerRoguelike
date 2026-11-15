// 重播紀錄：把一局裡「會影響模擬的東西」全部記下來，之後可以在沒有畫面的環境逐步重跑出一模一樣的結果
// （玩家、對手、車流、對向車流每一步的位置都相同）。純邏輯，瀏覽器與 Node 共用。
//
// 記的東西：
//   args    建立 session 時的全部設定（開局當下的快照）
//   calls   [步數, 名稱, 參數]：選車後套用的車輛數值、選單操作…（在那一步的物理之前執行）
//   inputs  [步數, 油門, 煞車, 方向, 手煞車, analog, noDrift]：只在輸入改變時記一筆
//   sums    每 60 步一個狀態校驗碼，重跑時逐一比對，不一樣就知道從哪一秒開始分岔
//
// 重跑要用錄製當時的程式版本（meta.commit）：物理或 AI 改過之後，同樣的輸入會跑出不同的結果。
export const REPLAY_VERSION = 1;
const SUM_EVERY = 60;

const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);
const mix = (h, x) => {
  f64[0] = x;
  h = Math.imul(h ^ u32[0], 16777619);
  return Math.imul(h ^ u32[1], 16777619) >>> 0;
};
const mixCar = (h, st) => mix(mix(mix(mix(mix(h, st.s), st.d), st.psi), st.vf), st.vl);

/** 整個模擬狀態的校驗碼：玩家、對手、同場的其他對手、車流、對向車流、對決分數、賞金 */
export function checksum(S) {
  let h = mixCar(2166136261, S.state);
  for (const r of [S.rival, ...(S.pack || [])]) {
    h = mix(h, r.active ? 1 : 0);
    if (r.active) h = mixCar(h, r.st);
  }
  for (const pool of [S.traffic, S.oncoming]) {
    if (!pool) continue;
    for (const c of pool.cars) if (c.active) h = mix(mix(mix(mix(h, c.id), c.s), c.d), c.v);
  }
  h = mix(mix(h, S.duel.scoreP || 0), S.duel.scoreR || 0);
  if (S.run) h = mix(mix(h, S.run.bounty || 0), S.run.defeats || 0);
  return h;
}

const pack = (inp) => [+inp.throttle || 0, +inp.brake || 0, +inp.steer || 0, inp.handbrake ? 1 : 0, inp.analog ? 1 : 0, inp.noDrift ? 1 : 0];

/** args：建立 session 用的設定（會在這裡複製一份快照）；meta：其他想留下來的資訊（程式版本、網址參數…） */
export function createRecorder(args, meta = {}) {
  const data = { v: REPLAY_VERSION, meta, args: structuredClone(args), steps: 0, calls: [], inputs: [], sums: [] };
  let last = null;
  return {
    data,
    /** 模擬以外的操作（選單、套用車輛數值…）：記下來，重跑時在同一步之前執行 */
    call(name, arg) { data.calls.push(arg === undefined ? [data.steps, name] : [data.steps, name, structuredClone(arg)]); },
    /** 取代 session.step：記下這一步的輸入，跑完後每秒記一次校驗碼 */
    step(S, dt, inp) {
      const p = pack(inp);
      if (!last || p.some((v, i) => v !== last[i])) { data.inputs.push([data.steps, ...p]); last = p; }
      S.step(dt, inp);
      data.steps++;
      if (data.steps % SUM_EVERY === 0) data.sums.push(checksum(S));
    },
  };
}

/**
 * 重跑一份紀錄。opts：
 *   createSession  session.js 的 createSession（由呼叫端給，這個檔案不直接依賴它）
 *   events         事件匯流排（想收對決結果之類的事件就給）
 *   onStep(S, n, inp)   每一步跑完後呼叫（分析用）
 *   onReady(S)     session 建好、還沒跑任何一步時呼叫
 *   steps          只跑前幾步
 * 回傳 { S, steps, checked, firstDiff }：firstDiff 是第一個對不上的校驗點所在的步數（−1 = 全部相同）
 */
export function runReplay(data, { createSession, events, onStep, onReady, steps, dt = 1 / 60 } = {}) {
  if (data.v !== REPLAY_VERSION) throw new Error(`重播紀錄版本不符：${data.v}`);
  const args = structuredClone(data.args);
  const S = createSession({ ...args, events });
  if (onReady) onReady(S);
  const total = Math.min(steps ?? data.steps, data.steps);
  const inp = { throttle: 0, brake: 0, steer: 0, handbrake: false, analog: false, noDrift: false };
  let ci = 0, ii = 0, checked = 0, firstDiff = -1;
  const doCalls = (n) => {
    for (; ci < data.calls.length && data.calls[ci][0] <= n; ci++) {
      const [, name, arg] = data.calls[ci];
      if (name === 'carCfg') Object.assign(args.carCfg, arg);
      else if (name === 'menu') S.menus.input(arg);
      else S[name]();
    }
  };
  for (let n = 0; n < total; n++) {
    doCalls(n);
    for (; ii < data.inputs.length && data.inputs[ii][0] <= n; ii++) {
      const r = data.inputs[ii];
      inp.throttle = r[1]; inp.brake = r[2]; inp.steer = r[3]; inp.handbrake = !!r[4]; inp.analog = !!r[5]; inp.noDrift = !!r[6];
    }
    S.step(dt, inp);
    if ((n + 1) % SUM_EVERY === 0) {
      const k = (n + 1) / SUM_EVERY - 1;
      if (k < data.sums.length) { checked++; if (firstDiff < 0 && checksum(S) !== data.sums[k]) firstDiff = n + 1; }
    }
    if (onStep) onStep(S, n, inp);
  }
  return { S, steps: total, checked, firstDiff };
}
