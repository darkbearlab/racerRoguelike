// 對向車道：主線右側隔著中央分隔帶的另一條路（靠左行駛，所以對向在右邊）。純數學。
// 只是景物：有護欄隔開，開不過去，上面的車也不參與碰撞。
//
// 交流道、隧道前後沒有對向車道：那一段它會往下沉到主線橋面底下（像雙層高架），過了之後再升回來。
import { DS } from './spline.js';

export const OPP = { gap: 1.6, ramp: 60, drop: 9, tuck: 3 };   // ramp：升降用掉幾個 node（× DS 公尺）

const smooth = (a) => a * a * (3 - 2 * a);

/** node i 旁邊能不能有對向車道（還沒生成、或已經回收的路段當成可以） */
export function oppOk(rd, i) {
  if (i > rd.iMax || i < rd.iMin) return true;
  return rd.nodeZone(i) === 0 && rd.nodeTunnel(i) === 0 && Math.abs(rd.nodeWr(i) - rd.halfWidth) < 0.02;
}

const _o = { t: 0, off: 0, h: 0 };
/**
 * node i 的對向車道：{ t: 0 平行、1 完全沉下去, off: 路緣離主線右護欄多遠, h: 路面高度差 }；沒有就回傳 null。
 * 不給 out 時回傳共用物件。
 */
export function oppNode(rd, i, out = _o) {
  if (!oppOk(rd, i)) return null;
  let dist = OPP.ramp + 1;
  for (let k = 1; k <= OPP.ramp; k++) if (!oppOk(rd, i - k) || !oppOk(rd, i + k)) { dist = k; break; }
  const t = dist > OPP.ramp ? 0 : 1 - (dist - 1) / OPP.ramp;
  out.t = t;
  out.h = -OPP.drop * smooth(t);
  out.off = OPP.gap - OPP.tuck * smooth(Math.max(0, (t - 0.5) / 0.5));
  return out;
}

const _a = { t: 0, off: 0, h: 0 }, _b = { t: 0, off: 0, h: 0 };
/** 任意 s 的對向車道（node 之間內插），沒有就回傳 null */
export function oppAt(rd, s, out = _o) {
  const f = s / DS, i = Math.floor(f), u = f - i;
  const a = oppNode(rd, i, _a), b = a && oppNode(rd, i + 1, _b);
  if (!b) return null;
  out.t = a.t + (b.t - a.t) * u;
  out.h = a.h + (b.h - a.h) * u;
  out.off = a.off + (b.off - a.off) * u;
  return out;
}
