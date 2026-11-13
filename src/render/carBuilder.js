import * as THREE from 'three';

// 程序化車身生成器：由一組比例參數（車長、軸距、車高、車頭與車尾的高度、前後擋的傾角…）
// 生成低多邊形車身。所有車型都是原創設計，參數見 config/models.json；
// 比例參考的是 80–90 年代各類車款的公開尺寸範圍，不描任何特定車款的輪廓。
//
// 車身座標：+z 前、+y 上、+x 左。輸出單一幾何（平面著色、頂點色），
// 烤漆部分頂點色為白色，會乘上材質顏色；玻璃、防撞飾板、輪拱是深色。

const PAINT = [1, 1, 1];
const GLASS = [0.045, 0.055, 0.075];
const DARK = [0.07, 0.07, 0.08];
const TRIM = [0.16, 0.16, 0.18];
const RIM = [0.55, 0.57, 0.6];
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const RAD = Math.PI / 180;

function mesher() {
  const pos = [], col = [];
  const tri = (a, b, c, color) => { pos.push(...a, ...b, ...c); col.push(...color, ...color, ...color); };
  const quad = (a, b, c, d, color) => { tri(a, b, c, color); tri(a, c, d, color); };
  const box = (w, h, d, x, y, z, color) => {
    const x0 = x - w / 2, x1 = x + w / 2, y0 = y - h / 2, y1 = y + h / 2, z0 = z - d / 2, z1 = z + d / 2;
    const p = (X, Y, Z) => [X, Y, Z];
    quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1), color);
    quad(p(x1, y0, z0), p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), color);
    quad(p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0), color);
    quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1), color);
    quad(p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1), color);
    quad(p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0), color);
  };
  /** 圓盤（法線朝 ±x），輪拱與輪圈用 */
  const disc = (x, y, z, r, color, seg = 12) => {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      tri([x, y, z], [x, y + Math.sin(a0) * r, z + Math.cos(a0) * r], [x, y + Math.sin(a1) * r, z + Math.cos(a1) * r], color);
    }
  };
  /** 輪胎（軸向為 x 的圓柱）＋輪圈 */
  const wheel = (x, y, z, r, w, seg = 12) => {
    const xa = x - w / 2, xb = x + w / 2;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const y0 = y + Math.sin(a0) * r, z0 = z + Math.cos(a0) * r, y1 = y + Math.sin(a1) * r, z1 = z + Math.cos(a1) * r;
      quad([xa, y0, z0], [xb, y0, z0], [xb, y1, z1], [xa, y1, z1], DARK);
    }
    disc(xa, y, z, r, DARK, seg); disc(xb, y, z, r, DARK, seg);
    const out = x > 0 ? xb + 0.004 : xa - 0.004;
    disc(out, y, z, r * 0.62, RIM, 10);
  };
  const geometry = () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals(); // 非索引幾何 → 每個面自己的法線，折線分明
    return g;
  };
  return { tri, quad, box, disc, wheel, geometry };
}

/**
 * spec：見 config/models.json。opts.wheels = true 時把輪子也併進幾何（車流用，不會轉）。
 * 回傳 { geometry, wheels:[{x,y,z,r,w,front}], head:[box], tail:[box], dims }
 */
export function buildCar(spec, opts = {}) {
  const m = mesher();
  const L = spec.L, hw = spec.W / 2, H = spec.H;
  const clr = spec.clearance ?? 0.16;
  const R = spec.wheelR ?? 0.31, wheelW = spec.wheelW ?? 0.24;
  const zF = L / 2, zR = -L / 2;
  const frontAxle = zF - spec.fo, rearAxle = frontAxle - spec.wb;
  const cowlZ = frontAxle - spec.cowl;           // 前擋底部
  const rearBaseZ = zR + spec.deck.len;          // 後擋底部
  const tumble = spec.tumble ?? 0.05;
  const crown = spec.crown ?? 0.1;
  const nose = spec.nose, tail = spec.tail;
  const lower = spec.cladding ? TRIM : PAINT;

  // ── 車身：沿車長的幾個斷面，由前到後
  const hoodAt = (z) => lerp(nose.h, spec.cowlH, clamp((zF - 0.1 - z) / (zF - 0.1 - cowlZ), 0, 1) ** (spec.hoodCurve ?? 1));
  const deckAt = (z) => lerp(spec.deck.h, tail.h, clamp((rearBaseZ - z) / Math.max(0.05, rearBaseZ - (zR + 0.1)), 0, 1));
  let st = [
    { z: zF, top: nose.h - nose.drop, w: hw * nose.taper * 0.94, bot: clr + 0.1 },
    { z: zF - 0.1, top: nose.h, w: hw * nose.taper, bot: clr + 0.02 },
    { z: frontAxle + R + 0.12, top: hoodAt(frontAxle + R + 0.12), w: hw, bot: clr },
    { z: frontAxle - R - 0.12, top: hoodAt(frontAxle - R - 0.12), w: hw, bot: clr },
    { z: cowlZ, top: spec.cowlH, w: hw, bot: clr },
    { z: (cowlZ + rearBaseZ) / 2, top: spec.beltH, w: hw, bot: clr },
    { z: rearBaseZ, top: spec.deck.h, w: hw, bot: clr },
    { z: rearAxle - R - 0.12, top: deckAt(rearAxle - R - 0.12), w: hw, bot: clr },
    { z: zR + 0.1, top: tail.h, w: hw * tail.taper, bot: clr + 0.02 },
    { z: zR, top: tail.h - tail.drop, w: hw * tail.taper * 0.94, bot: clr + 0.12 },
  ];
  // 依 z 由前到後排序，太近的斷面拿掉（座艙很靠前或很靠後的車型會擠在一起）
  const first = st[0], last = st[st.length - 1];
  st = st.filter((s) => s.z <= first.z && s.z >= last.z).sort((a, b) => b.z - a.z);
  st = st.filter((s, i) => s === first || s === last || (st[i - 1].z - s.z > 0.06 && s.z - last.z > 0.06 && first.z - s.z > 0.06));
  const topAt = (z) => {
    for (let i = 0; i < st.length - 1; i++) {
      if (z <= st[i].z && z >= st[i + 1].z) return lerp(st[i].top, st[i + 1].top, (st[i].z - z) / (st[i].z - st[i + 1].z));
    }
    return z > st[0].z ? st[0].top : last.top;
  };
  const widthAt = (z) => {
    for (let i = 0; i < st.length - 1; i++) {
      if (z <= st[i].z && z >= st[i + 1].z) return lerp(st[i].w, st[i + 1].w, (st[i].z - z) / (st[i].z - st[i + 1].z));
    }
    return hw;
  };
  // 斷面輪廓（一圈 10 個點）：底 → 門檻 → 肩線 → 上緣 → 中央，再鏡射
  const ring = (s) => {
    const sh = Math.max(s.bot + 0.2, s.top - crown), sill = s.bot + 0.15, wt = s.w * (1 - tumble);
    return [
      [0, s.bot, s.z], [s.w * 0.9, s.bot, s.z], [s.w, sill, s.z], [s.w, sh, s.z], [wt, s.top, s.z],
      [0, s.top + 0.015, s.z],
      [-wt, s.top, s.z], [-s.w, sh, s.z], [-s.w, sill, s.z], [-s.w * 0.9, s.bot, s.z],
    ];
  };
  const rings = st.map(ring);
  const segColor = [DARK, lower, PAINT, PAINT, PAINT, PAINT, PAINT, PAINT, lower, DARK];
  for (let i = 0; i < rings.length - 1; i++) {
    const a = rings[i], b = rings[i + 1];
    for (let j = 0; j < 10; j++) {
      const k = (j + 1) % 10;
      m.quad(a[j], a[k], b[k], b[j], segColor[j]);
    }
  }
  // 車頭、車尾的端面
  for (const [r, bumper] of [[rings[0], spec.bumperDark], [rings[rings.length - 1], spec.bumperDark]]) {
    const c = [0, (r[0][1] + r[5][1]) / 2, r[0][2]];
    for (let j = 0; j < 10; j++) m.tri(c, r[j], r[(j + 1) % 10], bumper ? TRIM : PAINT);
  }

  // ── 座艙：前擋、車頂、後擋、兩側車窗與柱子
  const cab = spec.cabin;
  const roofY = H;
  const baseF = topAt(cowlZ), baseR = topAt(rearBaseZ);
  const zTopF = cowlZ - (roofY - baseF) / Math.tan(cab.wsRake * RAD);
  let zTopR = rearBaseZ + (roofY - baseR) / Math.tan(cab.rearRake * RAD);
  if (zTopR > zTopF - 0.25) zTopR = zTopF - 0.25;
  const bwF = widthAt(cowlZ) * (1 - tumble) - 0.02, bwR = widthAt(rearBaseZ) * (1 - tumble) - 0.02;
  const rw = Math.min(bwF, bwR) - (roofY - Math.max(baseF, baseR)) * (cab.tumble ?? 0.28);
  const P = (x, y, z) => [x, y, z];
  // 前擋與後擋
  m.quad(P(bwF, baseF, cowlZ), P(-bwF, baseF, cowlZ), P(-rw, roofY, zTopF), P(rw, roofY, zTopF), GLASS);
  if (cab.open) {
    // 敞篷：只有前擋與窗框，座艙是一個深色開口，後方兩個頭枕與整流罩
    m.box(rw * 2 + 0.04, 0.035, 0.035, 0, roofY, zTopF, PAINT);
    for (const sx of [1, -1]) m.quad(P(sx * (bwF + 0.004), baseF, cowlZ), P(sx * (rw + 0.004), roofY, zTopF), P(sx * (rw + 0.004), roofY, zTopF - 0.06), P(sx * (bwF + 0.004), baseF, cowlZ - 0.06), PAINT);
    const z0 = cowlZ - 0.3, z1 = rearBaseZ + 0.12, bw = Math.min(bwF, bwR);
    m.box(bw * 1.72, 0.03, z0 - z1, 0, spec.beltH + 0.012, (z0 + z1) / 2, DARK);
    for (const sx of [1, -1]) {
      m.box(0.24, 0.2, 0.09, sx * bw * 0.45, spec.beltH + 0.12, z1 + 0.16, DARK);
      m.box(0.3, 0.1, 0.5, sx * bw * 0.45, baseR + 0.04, z1 - 0.2, PAINT);
    }
  } else {
  m.quad(P(-bwR, baseR, rearBaseZ), P(bwR, baseR, rearBaseZ), P(rw, roofY, zTopR), P(-rw, roofY, zTopR), cab.rearPanel ? PAINT : GLASS);
  // 車頂（中央略高）
  m.quad(P(rw, roofY, zTopF), P(-rw, roofY, zTopF), P(-rw, roofY, zTopR), P(rw, roofY, zTopR), PAINT);
  for (const sx of [1, -1]) {
    // 側窗（一整片玻璃），柱子用略為外凸的烤漆條蓋上去
    m.quad(P(sx * bwF, baseF, cowlZ), P(sx * rw, roofY, zTopF), P(sx * rw, roofY, zTopR), P(sx * bwR, baseR, rearBaseZ), GLASS);
    const o = sx * 0.006;
    const strip = (z0b, z0t, z1b, z1t) => {
      // 四個角：前下、前上、後上、後下（沿側窗平面內插）
      const at = (z, top) => {
        const zb0 = cowlZ, zt0 = zTopF, zb1 = rearBaseZ, zt1 = zTopR;
        const t = top ? (zt0 - z) / (zt0 - zt1) : (zb0 - z) / (zb0 - zb1);
        const x = top ? rw : lerp(bwF, bwR, t);
        const y = top ? roofY : lerp(baseF, baseR, t);
        return P(sx * x + o, y, z);
      };
      m.quad(at(z0b, false), at(z0t, true), at(z1t, true), at(z1b, false), PAINT);
    };
    const aw = cab.aPillar ?? 0.07, cw = cab.cPillar ?? 0.2;
    strip(cowlZ, zTopF, cowlZ - aw, zTopF - aw);                         // A 柱
    strip(rearBaseZ + cw, zTopR + cw * 0.8, rearBaseZ, zTopR);            // C 柱
    if (cab.bPillar !== false) {
      const zb = lerp(cowlZ, rearBaseZ, cab.bPillarAt ?? 0.52), zt = lerp(zTopF, zTopR, cab.bPillarAt ?? 0.52);
      strip(zb + 0.035, zt + 0.035, zb - 0.035, zt - 0.035);              // B 柱
    }
    for (const k of cab.pillars || []) {                                   // 額外的窗柱（旅行車、巴士）
      const zb = lerp(cowlZ, rearBaseZ, k), zt = lerp(zTopF, zTopR, k);
      strip(zb + 0.035, zt + 0.035, zb - 0.035, zt - 0.035);
    }
  }
  }

  // ── 輪拱（車身側面的深色圓）與輪子
  const wheels = [];
  for (const [z, front] of [[frontAxle, true], [rearAxle, false]]) {
    for (const sx of [1, -1]) {
      const wx = widthAt(z);
      m.disc(sx * (wx + 0.005), R + 0.01, z, R + 0.075, DARK, 14);
      const x = sx * (wx - wheelW / 2 + 0.015);
      wheels.push({ x, y: R, z, r: R, w: wheelW, front });
      if (opts.wheels) m.wheel(x, R, z, R, wheelW);
    }
  }

  // ── 配件：尾翼、下巴、進氣口、照後鏡、貨箱…
  const ex = spec.extras || {};
  const tailTop = topAt(zR + 0.25), tw = hw * tail.taper;
  if (ex.spoiler === 'duck') m.box(tw * 1.8, 0.07, 0.32, 0, tailTop + 0.05, zR + 0.2, PAINT);
  if (ex.spoiler === 'wing' || ex.spoiler === 'big') {
    const big = ex.spoiler === 'big';
    const wy = tailTop + (big ? 0.34 : 0.2), wz = zR + (big ? 0.22 : 0.3);
    m.box(tw * (big ? 2.04 : 1.8), 0.04, big ? 0.36 : 0.26, 0, wy, wz, big ? DARK : PAINT);
    for (const sx of [1, -1]) {
      m.box(0.05, wy - tailTop + 0.02, 0.16, sx * tw * 0.62, (wy + tailTop) / 2, wz + 0.02, big ? DARK : PAINT);
      if (big) m.box(0.03, 0.2, 0.42, sx * tw * 1.02, wy - 0.02, wz, DARK); // 端板
    }
  }
  if (ex.spoiler === 'roof') m.box(rw * 1.9, 0.045, 0.24, 0, roofY + 0.01, zTopR - 0.08, PAINT);
  if (ex.lip) m.box(hw * nose.taper * 1.96, 0.05, 0.22, 0, clr + 0.03, zF - 0.02, DARK);
  if (ex.skirts) for (const sx of [1, -1]) m.box(0.06, 0.1, spec.wb - 2 * R - 0.3, sx * (hw + 0.01), clr + 0.07, (frontAxle + rearAxle) / 2, DARK);
  if (ex.scoop) m.box(0.42, 0.07, 0.5, 0, hoodAt(frontAxle - 0.1) + 0.03, frontAxle - 0.1, DARK);
  if (ex.vents) for (const sx of [1, -1]) m.box(0.3, 0.02, 0.5, sx * 0.34, hoodAt(frontAxle) + 0.012, frontAxle, DARK);
  if (ex.intake) for (const sx of [1, -1]) m.box(0.05, 0.22, 0.42, sx * (hw + 0.012), spec.beltH - 0.28, rearAxle + R + 0.5, DARK);
  if (ex.canards) for (const sx of [1, -1]) m.box(0.26, 0.03, 0.22, sx * (hw * nose.taper + 0.06), clr + 0.3, zF - 0.28, DARK);
  if (ex.grille) m.box(hw * nose.taper * (ex.grille === 'wide' ? 1.5 : 0.9), 0.1, 0.03, 0, clr + 0.2, zF + 0.012, DARK);
  if (ex.diffuser) m.box(tw * 1.5, 0.12, 0.05, 0, clr + 0.16, zR - 0.01, DARK);
  if (ex.exhaust) for (const sx of ex.exhaust === 'twin' ? [1, -1] : [1]) m.box(0.1, 0.07, 0.1, sx * tw * 0.55, clr + 0.1, zR - 0.03, RIM);
  if (ex.mirrors !== false) for (const sx of [1, -1]) m.box(0.14, 0.09, 0.07, sx * (bwF + 0.1), baseF + 0.1, cowlZ - 0.18, PAINT);
  if (ex.fenders) for (const [z] of [[frontAxle], [rearAxle]]) for (const sx of [1, -1]) m.box(0.07, 0.1, R * 2 + 0.3, sx * (hw + 0.02), R * 2 + 0.06, z, PAINT); // 寬體葉子板
  if (ex.rack && !cab.open) for (const sx of [1, -1]) m.box(0.035, 0.05, (zTopF - zTopR) * 0.78, sx * rw * 0.82, roofY + 0.03, (zTopF + zTopR) / 2, DARK);
  if (ex.roofLight && !cab.open) m.box(0.34, 0.11, 0.15, 0, roofY + 0.06, lerp(zTopF, zTopR, 0.3), [1.3, 1.3, 1.3]);
  if (ex.louvers && !cab.open) for (const k of [0.2, 0.4, 0.6, 0.8]) m.box(lerp(bwR, rw, k) * 1.8, 0.025, 0.1, 0, lerp(baseR, roofY, k) + 0.02, lerp(rearBaseZ, zTopR, k), DARK);
  if (ex.bed) {
    // 皮卡貨斗：車斗內側的深色開口與後擋板上緣
    const len = rearBaseZ - zR - 0.3;
    m.box(spec.W - 0.22, 0.03, len, 0, spec.deck.h + 0.012, zR + 0.12 + len / 2, DARK);
  }
  if (ex.cargo && ex.cargo.type === "tank") {
    // 油罐：沿車長的十邊形圓筒
    const c = ex.cargo, z0 = zTopR - 0.3, z1 = zR + 0.15, r = Math.min(hw - 0.05, c.h / 2), cy = spec.deck.h + r + 0.12, col = c.color || [0.86, 0.87, 0.9];
    const N = 10, pt = (a, z) => [Math.cos(a) * r, cy + Math.sin(a) * r, z];
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
      m.quad(pt(a0, z0), pt(a1, z0), pt(a1, z1), pt(a0, z1), col);
      m.tri([0, cy, z0 + 0.12], pt(a0, z0), pt(a1, z0), col);
      m.tri([0, cy, z1 - 0.12], pt(a1, z1), pt(a0, z1), col);
    }
    m.box(spec.W - 0.5, 0.3, z0 - z1, 0, spec.deck.h - 0.13, (z0 + z1) / 2, DARK);
    m.box(spec.W - 0.9, 0.14, z0 - z1 - 0.4, 0, spec.deck.h + 0.07, (z0 + z1) / 2, DARK);
  } else if (ex.cargo) {
    // 貨車貨箱：駕駛艙後方到車尾
    const c = ex.cargo, z0 = zTopR - 0.25, len = z0 - zR - 0.05;
    m.box(spec.W - 0.04, c.h, len, 0, spec.deck.h + c.h / 2 + 0.02, z0 - len / 2, c.color || [0.9, 0.9, 0.92]);
    m.box(spec.W - 0.5, 0.3, len, 0, spec.deck.h - 0.13, z0 - len / 2, DARK);
  }

  // ── 車燈（另外用發光材質畫，這裡只給位置與大小）
  const head = [], tailL = [];
  const nw = hw * nose.taper, ny = spec.lights?.headY ?? lerp(clr + 0.1, nose.h - nose.drop, 0.66), hz = zF + 0.012;
  const hl = spec.lights?.head || 'rect';
  if (hl === 'rect') for (const sx of [1, -1]) head.push({ x: sx * nw * 0.62, y: ny, z: hz, w: nw * 0.5, h: 0.11, d: 0.03 });
  else if (hl === 'slim') for (const sx of [1, -1]) head.push({ x: sx * nw * 0.6, y: ny + 0.02, z: hz, w: nw * 0.56, h: 0.06, d: 0.03 });
  else if (hl === 'quad') for (const sx of [1, -1]) for (const k of [0.42, 0.78]) head.push({ x: sx * nw * k, y: ny, z: hz, w: nw * 0.24, h: 0.11, d: 0.03 });
  else if (hl === 'round') for (const sx of [1, -1]) head.push({ x: sx * nw * 0.66, y: ny, z: hz, w: 0.16, h: 0.16, d: 0.03 });
  else if (hl === 'wide') for (const sx of [1, -1]) head.push({ x: sx * nw * 0.56, y: ny + 0.02, z: hz, w: nw * 0.66, h: 0.05, d: 0.03 }); // 左右各一條細長燈，中間留空
  else if (hl === 'popup') for (const sx of [1, -1]) head.push({ x: sx * nw * 0.66, y: clr + 0.2, z: hz, w: nw * 0.34, h: 0.05, d: 0.03 }); // 燈蓋關著，只有保桿上的小燈
  const ty = spec.lights?.tailY ?? lerp(clr + 0.12, tail.h - tail.drop, 0.7), tz = zR - 0.012;
  const tl = spec.lights?.tail || 'rect';
  if (tl === 'rect') for (const sx of [1, -1]) tailL.push({ x: sx * tw * 0.6, y: ty, z: tz, w: tw * 0.58, h: 0.11, d: 0.03 });
  else if (tl === 'wide') for (const sx of [1, -1]) tailL.push({ x: sx * tw * 0.56, y: ty, z: tz, w: tw * 0.68, h: 0.08, d: 0.03 }); // 左右各一條，中間留牌照的位置
  else if (tl === 'quad') for (const sx of [1, -1]) for (const k of [0.4, 0.76]) tailL.push({ x: sx * tw * k, y: ty, z: tz, w: 0.15, h: 0.15, d: 0.03 });
  else if (tl === 'slats') for (const sx of [1, -1]) for (const k of [0.5, 0.66, 0.82]) tailL.push({ x: sx * tw * k, y: ty, z: tz, w: 0.07, h: 0.2, d: 0.03 });
  else if (tl === 'round') for (const sx of [1, -1]) for (const k of [0.46, 0.78]) tailL.push({ x: sx * tw * k, y: ty, z: tz, w: 0.13, h: 0.13, d: 0.03 });
  else if (tl === 'tall') for (const sx of [1, -1]) tailL.push({ x: sx * tw * 0.84, y: ty + 0.1, z: tz, w: 0.12, h: 0.34, d: 0.03 });

  return {
    geometry: m.geometry(), wheels, head, tail: tailL,
    dims: { L, W: spec.W, H, hoodY: hoodAt(frontAxle), cowlY: baseF, cowlZ, tailY: ty, noseY: ny },
  };
}

/** 單獨一顆輪子的幾何（玩家與對手的輪子要會轉，所以不併進車身） */
export function buildWheelGeometry(r, w) {
  const m = mesher();
  m.wheel(0, 0, 0, r, w);
  return m.geometry();
}
