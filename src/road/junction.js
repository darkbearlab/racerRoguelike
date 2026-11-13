// 交流道（JCT）的幾何：一段變寬的路，在分歧點分成左右兩條分支。純數學。
//
//   分歧前 300 m：3 車道變寬成 4 車道（左 2、右 2），中間長出分隔線
//   分歧點：     左分支佔 d < 0、右分支佔 d > 0，中央是分隔島尖端
//   分歧後 300 m：兩條分支各自彎開，並從 2 車道補回 3 車道
//
// 兩條分支共用分歧點那個 node（位置與朝向相同），之後曲率相反所以鏡像分開。
import { DS } from './spline.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smooth = (a) => a * a * (3 - 2 * a);

export const JCT = { approach: 300, yellow: 200, branch: 300, wide: 7.75, sign1: 500, sign2: 160 };

/**
 * 在 road 的尾端接上交流道。road 會接上左分支；回傳右分支（alt）。
 * branchDeg：每條分支彎開的角度。
 */
export function buildJunction(road, branchDeg = 24) {
  const hw = road.halfWidth, LW = road.laneWidth;
  const lane = (k) => road.laneCenter(k);
  const outer = JCT.wide - hw; // 兩側各加寬多少

  // ── 分歧前：變寬，車道 0、1 往左移，車道 2 往右移，中間空出一條新車道
  const nA = Math.round(JCT.approach / DS);
  for (let i = 1; i <= nA; i++) {
    const t = i * DS;
    const u = smooth(clamp(t / (JCT.approach - 40), 0, 1));
    road.push(0, {
      wl: hw + outer * u, wr: hw + outer * u,
      l0: lane(0) - LW * 0.5 * u, l1: lane(1) - LW * 0.5 * u, l2: lane(2) + LW * 0.5 * u,
      zone: JCT.approach - t <= JCT.yellow ? 2 : 1,
    });
  }
  const iFork = road.iMax;
  const forkS = iFork * DS;
  const alt = road.clone();
  road.fork = { i: iFork, s: forkS, side: -1 };
  alt.fork = { i: iFork, s: forkS, side: 1 };

  // ── 分歧後：曲率梯形（緩入緩出）彎開 branchDeg 度，之後直線
  const R = 300, ramp = 40;
  const ang = (branchDeg * Math.PI) / 180;
  const curveSteps = Math.round((ang * R + ramp) / DS);
  const curveLen = curveSteps * DS;
  const nB = Math.round(JCT.branch / DS);
  const ks = [];
  let sum = 0;
  for (let i = 0; i < nB; i++) {
    const t = (i + 0.5) * DS;
    const k = t < curveLen ? smooth(clamp(Math.min(t / ramp, (curveLen - t) / ramp), 0, 1)) : 0;
    ks.push(k); sum += k * DS;
  }
  let dTheta = 0, dev = 0; // 分支相對分歧點切線的轉角與橫向偏離
  for (let i = 0; i < nB; i++) {
    const k = (ks[i] * ang) / sum;
    dev += Math.sin(dTheta + k * DS * 0.5) * DS;
    dTheta += k * DS;
    const t = (i + 1) * DS;
    const u = smooth(clamp(t / 200, 0, 1));
    // 內側（靠另一條分支）寬度：隨兩條分支分開的距離長出來，兩邊護欄不會相撞
    const inner = i === nB - 1 ? hw : clamp(Math.min(hw * smooth(clamp((t - 10) / 220, 0, 1)), dev * 0.9 - 0.35), 0, hw);
    const outerW = JCT.wide + (hw - JCT.wide) * u;
    const a0 = lane(0) - LW * 0.5 * (1 - u);          // 外側車道 → 車道 0
    const a1 = lane(1) - LW * 0.5 * (1 - u);          // 內側車道 → 車道 1
    const a2 = Math.min(lane(2), inner - LW * 0.5);   // 新長出來的車道 2
    // 左分支：外側在左
    road.push(k, { wl: outerW, wr: inner, l0: a0, l1: a1, l2: a2, zone: t < 260 ? 3 : 0 });
    // 右分支：鏡像
    alt.push(-k, { wl: inner, wr: outerW, l0: -a2, l1: -a1, l2: -a0, zone: t < 260 ? 4 : 0 });
  }
  return alt;
}
