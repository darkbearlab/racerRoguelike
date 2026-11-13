// 道路 = 一串等距取樣點（每 DS 公尺一點），存在環狀緩衝區裡不斷往前接、往後丟。
// 純數學、不依賴 three.js，物理、AI、車流、測試腳本都用同一份。
//
// 座標約定：
//   theta  世界朝向，forward = (sin θ, ·, cos θ)，θ 增加 = 左轉
//   kappa  曲率 = dθ/ds，正值 = 左彎
//   d      橫向偏移，正值 = 右側
//   s      沿路距離，只增不減（node i 的 s = i × DS）
//
// 交流道分歧：分歧點之後有兩條分支，各自是一個 Road 物件（主線 + alt），
// 兩者共用同一套 s 編號。玩家選了另一條時 swapWith() 交換兩者的內容，
// 所以「主線」這個物件永遠是玩家所在的路，其他模組不必換參考。
export const DS = 2;
const CAP = 2048;
const MASK = CAP - 1;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smooth = (a) => a * a * (3 - 2 * a);
const F64 = ['x', 'y', 'z', 'theta', 'kappa', 'bank', 'wl', 'wr', 'l0', 'l1', 'l2'];

function newBuffer() {
  const b = { iMin: 0, iMax: 0, lastK: 0, merges: [], fork: null, gen: null };
  for (const k of F64) b[k] = new Float64Array(CAP);
  b.tunnel = new Uint8Array(CAP);
  b.zone = new Uint8Array(CAP); // 0 一般、1 分歧前、2 分歧前（黃線）、3 左分支、4 右分支
  return b;
}

export function createRoad(def) {
  const lanes = def.lanes ?? 3;
  const laneWidth = def.laneWidth ?? 3.5;
  const shoulder = def.shoulder ?? 0.75;
  const halfWidth = (lanes * laneWidth) / 2 + shoulder;
  const maxBank = ((def.maxBankDeg ?? 6) * Math.PI) / 180;
  const bankGain = maxBank / 0.01; // 半徑 100 m 時達到最大傾角
  const hills = def.hills || [];
  const baseLane = (lane) => (lane - (lanes - 1) / 2) * laneWidth;

  let B = newBuffer();
  const elev = (s) => {
    let h = 0;
    for (const hl of hills) h += hl.amp * Math.sin((Math.PI * 2 * s) / hl.wavelength + hl.phase);
    return h;
  };
  B.y[0] = elev(0); B.wl[0] = halfWidth; B.wr[0] = halfWidth;
  B.l0[0] = baseLane(0); B.l1[0] = baseLane(1); B.l2[0] = baseLane(2);

  const lerpArr = (arr, f) => {
    const i0 = Math.floor(f), t = f - i0;
    const a = arr[i0 & MASK];
    return a + (arr[(i0 + 1) & MASK] - a) * t;
  };
  const locate = (s) => {
    let f = s / DS;
    if (f < B.iMin) f = B.iMin;
    else if (f > B.iMax - 1e-6) f = B.iMax - 1e-6;
    return f;
  };

  const road = {
    lanes, laneWidth, shoulder, halfWidth,
    length: Infinity,
    get iMin() { return B.iMin; },
    get iMax() { return B.iMax; },
    get sMin() { return B.iMin * DS; },
    get sMax() { return B.iMax * DS; },
    get merges() { return B.merges; },
    /** 分歧資訊 { i, s, side }：side = 這條路在分歧點之後是左分支（−1）還是右分支（+1） */
    get fork() { return B.fork; },
    set fork(v) { B.fork = v; },
    /** 生成器的狀態跟著緩衝區走，交換分支時一併交換 */
    get gen() { return B.gen; },
    set gen(v) { B.gen = v; },

    /**
     * 接上一個區間（node iMax → iMax+1）。o：{ tun, wl, wr, l0, l1, l2, zone }，省略者取預設。
     */
    push(k, o) {
      const a = B.iMax & MASK, b = (B.iMax + 1) & MASK;
      const mid = B.theta[a] + k * DS * 0.5;
      B.x[b] = B.x[a] + Math.sin(mid) * DS;
      B.z[b] = B.z[a] + Math.cos(mid) * DS;
      B.theta[b] = B.theta[a] + k * DS;
      B.y[b] = elev((B.iMax + 1) * DS);
      B.kappa[a] = (B.lastK + k) / 2;
      B.bank[a] = clamp(B.kappa[a] * bankGain, -maxBank, maxBank);
      B.kappa[b] = k; // 暫定值，下一個區間接上時定案
      B.bank[b] = clamp(k * bankGain, -maxBank, maxBank);
      const tun = o && o.tun ? 1 : 0;
      B.tunnel[a] = tun; B.tunnel[b] = tun;
      B.wl[b] = o?.wl ?? halfWidth; B.wr[b] = o?.wr ?? halfWidth;
      B.l0[b] = o?.l0 ?? baseLane(0); B.l1[b] = o?.l1 ?? baseLane(1); B.l2[b] = o?.l2 ?? baseLane(2);
      const zone = o?.zone ?? 0;
      B.zone[a] = zone; B.zone[b] = zone;
      B.lastK = k;
      B.iMax++;
      if (B.iMax - B.iMin > CAP - 4) B.iMin = B.iMax - (CAP - 4);
    },

    /** 接上一個路段：{type:'straight', length} 或 {type:'curve', radius, angle(度,+左), ramp}，可帶 tunnel / merge */
    appendSegment(seg) {
      const o = { tun: !!seg.tunnel, wl: halfWidth };
      const s0 = B.iMax * DS;
      if (seg.type === 'curve') {
        const ang = (seg.angle * Math.PI) / 180;
        const ramp = seg.ramp ?? 40;
        const steps = Math.max(4, Math.round((Math.abs(ang) * seg.radius + ramp) / DS));
        const len = steps * DS;
        const w = [];
        let sum = 0;
        for (let i = 0; i < steps; i++) {
          const t = (i + 0.5) * DS;
          const k = smooth(clamp(Math.min(t / ramp, (len - t) / ramp), 0, 1)); // 緩入緩出，接點切線與曲率連續
          w.push(k);
          sum += k * DS;
        }
        for (const k of w) road.push((k * ang) / sum, o);
      } else {
        const steps = Math.max(1, Math.round(seg.length / DS));
        const len = steps * DS;
        const taper = 40;
        for (let i = 1; i <= steps; i++) {
          o.wl = halfWidth;
          if (seg.merge) {
            const t = i * DS;
            o.wl += laneWidth * smooth(clamp(Math.min(t / taper, (len - t) / taper), 0, 1));
          }
          road.push(0, o);
        }
        if (seg.merge) B.merges.push({ s0, s1: s0 + len, spawned: false });
      }
    },

    /** 丟掉 s 之前的道路 */
    trim(s) {
      const i = Math.floor(s / DS);
      if (i > B.iMin) B.iMin = Math.min(i, B.iMax - 8);
      while (B.merges.length && B.merges[0].s1 < B.iMin * DS) B.merges.shift();
      if (B.fork && B.fork.i < B.iMin) B.fork = null;
    },

    /** 把 node i 之後的道路砍掉重來（動態插入交流道用） */
    truncate(i) {
      if (i >= B.iMax) return;
      B.iMax = Math.max(i, B.iMin + 8);
      B.lastK = B.kappa[B.iMax & MASK];
      const sCut = B.iMax * DS;
      B.merges = B.merges.filter((m) => m.s1 <= sCut);
    },

    /** 複製一條一模一樣的路（分歧時用來長出另一條分支） */
    clone() {
      const r = createRoad(def);
      r._copyFrom(B);
      return r;
    },
    _copyFrom(src) {
      for (const k of F64) B[k].set(src[k]);
      B.tunnel.set(src.tunnel); B.zone.set(src.zone);
      B.iMin = src.iMin; B.iMax = src.iMax; B.lastK = src.lastK;
      B.merges = src.merges.map((m) => ({ ...m }));
      B.fork = src.fork ? { ...src.fork } : null;
      B.gen = src.gen ? { ...src.gen } : null;
    },
    /** 與另一條分支交換全部內容 */
    swapWith(other) {
      const mine = B;
      B = other._buffer();
      other._setBuffer(mine);
    },
    _buffer: () => B,
    _setBuffer(b) { B = b; },

    wrap(s) { return s; },
    delta(s1, s0) { return s1 - s0; },

    /** 車道中心的 d（lane 0 = 最左；lane −1 = 匯入車道）。不考慮交流道的車道變化。 */
    laneCenter(lane) {
      if (lane < 0) return -halfWidth - laneWidth / 2 + 0.25;
      return baseLane(lane);
    },
    /** 車道中心在 s 處的 d：交流道前後車道會橫移 */
    laneCenterAt(lane, s) {
      if (lane < 0) return -halfWidth - laneWidth / 2 + 0.25;
      return lerpArr(lane === 0 ? B.l0 : lane === 1 ? B.l1 : B.l2, locate(s));
    },

    sample(s, out) {
      const f = locate(s);
      const i0 = Math.floor(f);
      const t = f - i0;
      const i = i0 & MASK, j = (i0 + 1) & MASK;
      out.x = B.x[i] + (B.x[j] - B.x[i]) * t;
      out.y = B.y[i] + (B.y[j] - B.y[i]) * t;
      out.z = B.z[i] + (B.z[j] - B.z[i]) * t;
      out.theta = B.theta[i] + (B.theta[j] - B.theta[i]) * t;
      out.kappa = B.kappa[i] + (B.kappa[j] - B.kappa[i]) * t;
      out.bank = B.bank[i] + (B.bank[j] - B.bank[i]) * t;
      out.wl = B.wl[i] + (B.wl[j] - B.wl[i]) * t;
      out.wr = B.wr[i] + (B.wr[j] - B.wr[i]) * t;
      out.l0 = B.l0[i] + (B.l0[j] - B.l0[i]) * t;
      out.l1 = B.l1[i] + (B.l1[j] - B.l1[i]) * t;
      out.l2 = B.l2[i] + (B.l2[j] - B.l2[i]) * t;
      out.slope = (B.y[j] - B.y[i]) / DS;
      out.tunnel = B.tunnel[i];
      out.zone = B.zone[i];
      return out;
    },

    curvature: (s) => lerpArr(B.kappa, locate(s)),
    widthLeft: (s) => lerpArr(B.wl, locate(s)),
    widthRight: (s) => lerpArr(B.wr, locate(s)),
    zoneAt: (s) => B.zone[Math.floor(locate(s)) & MASK],

    /** 分歧點前的中央緩衝（楔形）：回傳半寬，0 表示沒有 */
    gore(s) {
      const f = B.fork;
      if (!f) return 0;
      const back = f.s - s;
      if (back < 0 || back > 50) return 0;
      return 0.5 * (1 - back / 50);
    },

    // 以 node 編號直接取值（建網格、測試用）
    nodeTunnel: (i) => B.tunnel[i & MASK],
    nodeKappa: (i) => B.kappa[i & MASK],
    nodeWl: (i) => B.wl[i & MASK],
    nodeWr: (i) => B.wr[i & MASK],
    nodeZone: (i) => B.zone[i & MASK],
    nodeX: (i) => B.x[i & MASK],
    nodeZ: (i) => B.z[i & MASK],
    nodeTheta: (i) => B.theta[i & MASK],

    /** 世界座標框架：p 位置、t 前進方向、r 右、u 上（皆為長度 3 陣列） */
    frame(s, out) {
      const sm = road.sample(s, _tmp);
      const st = Math.sin(sm.theta);
      const ct = Math.cos(sm.theta);
      const inv = 1 / Math.hypot(1, sm.slope);
      const tx = st * inv, ty = sm.slope * inv, tz = ct * inv;
      const rx = -ct, rz = st; // 無傾角的右向量
      const nx = -rz * ty, ny = rz * tx - rx * tz, nz = rx * ty; // n = rflat × t
      const cb = Math.cos(sm.bank), sb = Math.sin(sm.bank);
      const Rx = rx * cb + nx * sb, Ry = ny * sb, Rz = rz * cb + nz * sb;
      out.p[0] = sm.x; out.p[1] = sm.y; out.p[2] = sm.z;
      out.t[0] = tx; out.t[1] = ty; out.t[2] = tz;
      out.r[0] = Rx; out.r[1] = Ry; out.r[2] = Rz;
      out.u[0] = Ry * tz - Rz * ty; // u = r × t
      out.u[1] = Rz * tx - Rx * tz;
      out.u[2] = Rx * ty - Ry * tx;
      out.theta = sm.theta;
      out.kappa = sm.kappa;
      out.tunnel = sm.tunnel;
      out.wl = sm.wl; out.wr = sm.wr;
      out.l0 = sm.l0; out.l1 = sm.l1; out.l2 = sm.l2;
      out.zone = sm.zone;
      return out;
    },

    /**
     * 取 node i 的框架。branchView = true 時，分歧點那一個 node 以「分支起點」來看：
     * 內側（靠另一條分支那側）寬度為 0，護欄才會從分隔島尖端長出來。
     */
    frameNode(i, out, branchView) {
      road.frame(i * DS, out);
      const f = B.fork;
      if (branchView && f && i === f.i) {
        if (f.side < 0) out.wr = 0; else out.wl = 0;
        out.zone = f.side < 0 ? 3 : 4;
      }
      return out;
    },
  };
  return road;
}

const _tmp = {};

export function makeFrame() {
  return { p: [0, 0, 0], t: [0, 0, 1], r: [-1, 0, 0], u: [0, 1, 0], theta: 0, kappa: 0, tunnel: 0, wl: 0, wr: 0, l0: 0, l1: 0, l2: 0, zone: 0 };
}
