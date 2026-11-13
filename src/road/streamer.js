import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { DS, makeFrame } from './spline.js';
import { JCT } from './junction.js';
import { createRng } from '../core/rng.js';

// 道路網格串流：每 200 m 一個 chunk，固定數量的 slot 重複使用（物件池）。
// 緩衝區與 InstancedMesh 全部預先配置好，重建 chunk 只是覆寫數值，不配置新物件。
// 每個 chunk 的頂點以 chunk 原點為基準，開得再遠也不會有浮點抖動。
//
// 交流道：分歧點之後有主線與 alt 兩條分支，各自佔用 slot（src = 'main' | 'alt'）。
// 玩家選了另一條時兩者只是交換標籤，不必重建（分歧點所在的那一塊除外）。
export const CH = 100;          // 每個 chunk 的區間數（× DS = 200 m）
const NSLOT = 28;
const AHEAD = 2000, BEHIND = 320;
const LAMP_EVERY = 20, PILLAR_EVERY = 30, REFL_EVERY = 5;
const NLAMP = CH / LAMP_EVERY, NPILLAR = Math.ceil(CH / PILLAR_EVERY), NREFL = (CH / REFL_EVERY) * 2;
const NBUILD = 26;
const TH = 5.4;                 // 隧道高度

const fr = makeFrame();

// ── 貼圖 ─────────────────────────────────────────────
function roadTexture(road, renderer) {
  const W = 512, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#34363b';
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 14000; i++) {
    const v = 34 + Math.random() * 44;
    g.fillStyle = `rgb(${v},${v},${v + 3})`;
    g.fillRect(Math.random() * W, Math.random() * H, 2, 2);
  }
  // 縱向輪跡與橫向伸縮縫：近處的速度參照
  const total = road.halfWidth * 2;
  const px = (m) => (m / total) * W;
  g.globalAlpha = 0.16;
  g.fillStyle = '#0c0c0e';
  for (let l = 0; l < road.lanes; l++) {
    const cx = road.shoulder + (l + 0.5) * road.laneWidth;
    g.fillRect(px(cx - 0.95), 0, px(0.5), H);
    g.fillRect(px(cx + 0.45), 0, px(0.5), H);
  }
  g.globalAlpha = 0.55;
  g.fillRect(0, H - 10, W, 5);
  g.globalAlpha = 0.25;
  g.fillStyle = '#9a9a98';
  g.fillRect(0, H - 5, W, 3);
  g.globalAlpha = 1;
  g.fillStyle = '#d8d8d0';
  g.fillRect(px(road.shoulder) - 3, 0, 6, H);
  g.fillRect(px(total - road.shoulder) - 3, 0, 6, H);
  for (let l = 1; l < road.lanes; l++) g.fillRect(px(road.shoulder + l * road.laneWidth) - 3, 0, 6, H / 2);
  const t = new THREE.CanvasTexture(c);
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

function wallTexture(base, seam, renderer) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, 64, 256);
  for (let i = 0; i < 500; i++) {
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.12})`;
    g.fillRect(Math.random() * 64, Math.random() * 256, 3, 8);
  }
  g.fillStyle = seam;
  g.fillRect(0, 0, 64, 6); // 每 4 m 一道接縫
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1, 3);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

/** 路燈在地面的光池：中心亮、往外平滑衰減到 0 的橢圓 */
function poolTexture() {
  const N = 128, c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d'), img = g.createImageData(N, N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = (x + 0.5) / N * 2 - 1, dy = (y + 0.5) / N * 2 - 1, r = Math.hypot(dx, dy);
    const f = Math.max(0, 1 - r * r), a = f * f;
    const o = (y * N + x) * 4;
    img.data[o] = 255; img.data[o + 1] = 255; img.data[o + 2] = 255; img.data[o + 3] = Math.round(a * 255);
  }
  g.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,170,90,0.7)');
  grad.addColorStop(0.5, 'rgba(255,140,60,0.22)');
  grad.addColorStop(1, 'rgba(255,120,40,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function windowTexture(rng) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, 64, 128);
  for (let y = 2; y < 128; y += 4) {
    for (let x = 2; x < 64; x += 4) {
      if (rng.next() < 0.3) {
        g.fillStyle = rng.next() < 0.75 ? '#ffd9a0' : '#a8d4ff';
        g.globalAlpha = 0.4 + rng.next() * 0.6;
        g.fillRect(x, y, 2, 2);
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  return t;
}

// ── 路邊的「似是而非」：假出口／入口、隔音牆、上層高架 ─────────────
// 全部由 node 編號的雜湊決定，同一段路每次都長一樣；只是裝飾，不影響碰撞與玩法。
const hash01 = (n) => { let x = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16; return (x >>> 0) / 4294967296; };
const XBLK = 450, XLEN = 70;      // 每 900 m 一格，格內最多一個假出口，長 140 m
const _exit = { t: 0, sd: 1, k: 0, rev: false };
/** node i 是否在某個假出口的範圍內；回傳 { t: 0–1 沿匝道的進度, sd: 哪一側, k, rev: 是入口 }（共用物件）或 null */
export function exitAt(rd, i) {
  const b = Math.floor(i / XBLK);
  if (b < 1 || hash01(b * 7919 + 11) > 0.72) return null;
  const a = b * XBLK + 40 + Math.floor(hash01(b * 31 + 5) * (XBLK - XLEN - 80));
  const k = i - a;
  if (k < 0 || k > XLEN) return null;
  const sd = hash01(b * 131 + 3) < 0.6 ? -1 : 1;   // 靠左行駛：出口多半在左側
  if (rd.nodeZone(i) !== 0 || rd.nodeTunnel(i) === 1) return null;
  if ((sd < 0 ? rd.nodeWl(i) : rd.nodeWr(i)) > rd.halfWidth + 0.02) return null;
  _exit.rev = hash01(b * 17 + 9) < 0.35;
  _exit.k = k; _exit.sd = sd;
  _exit.t = _exit.rev ? 1 - k / XLEN : k / XLEN;
  return _exit;
}
const exitOff = (t) => 0.3 + 15 * t * t;
const exitDrop = (t) => { const a = Math.min(1, Math.max(0, (t - 0.15) / 0.85)); return -6.5 * a * a * (3 - 2 * a); };
/** 護欄在這裡開口、改成發光的封閉柵欄 */
const exitOpen = (rd, i, sd) => { const e = exitAt(rd, i); return !!e && e.sd === sd && e.t > 0.03 && e.t < 0.36; };
/** 隔音牆路段、上層高架路段 */
const noiseAt = (i, sd) => hash01(Math.floor(i / 160) * 53 + sd * 7) < 0.3;
const upperAt = (rd, i) => hash01(Math.floor(i / 300) * 13 + 1) < 0.2 && rd.nodeZone(i) === 0 && rd.nodeTunnel(i) === 0;
const UPPER_H = 12.5;

// ── 帶狀面定義 ───────────────────────────────────────
// 每條帶狀面：ok(rd, i) 這個區間要不要畫；ends(f, e) 由 node 的框架算出兩端的 [d, h]，回傳 false 表示這個 node 不畫。
// uv：'road' 整幅路面貼圖、'plain' 只取沒有標線的柏油、其餘 0–1
function stripDefs(hw) {
  const open = (rd, i) => rd.nodeTunnel(i) === 0;
  const tunnel = (rd, i) => rd.nodeTunnel(i) === 1;
  const normal = (rd, i) => rd.nodeZone(i) === 0;
  const zoned = (rd, i) => rd.nodeZone(i) !== 0;
  const edge = (side, off) => (f) => side * ((side < 0 ? f.wl : f.wr) + off);
  const seg = (da, ha, db, hb, ok, uv) => ({
    ok, uv,
    ends(f, e) { e.da = typeof da === 'function' ? da(f) : da; e.ha = ha; e.db = typeof db === 'function' ? db(f) : db; e.hb = hb; return true; },
  });
  // 標線：寬 0.16 m 的細帶，貼在路面上方 2 cm
  const line = (pos, ok, dashed) => ({
    ok: dashed ? (rd, i) => ok(rd, i) && Math.floor((i * DS) / 6) % 2 === 0 : ok,
    ends(f, e) {
      const d = pos(f);
      if (!(d > -f.wl + 0.3 && d < f.wr - 0.3)) return false;
      e.da = d - 0.08; e.ha = 0.02; e.db = d + 0.08; e.hb = 0.02;
      return true;
    },
  });
  const z = (...list) => (rd, i) => list.includes(rd.nodeZone(i));

  const defs = { road: [], concrete: [], dark: [], deck: [], tunnelWall: [], tunnelLight: [], tunnelFloor: [], paint: [], paintY: [], lightWall: [] };
  defs.road.push(seg(-hw, 0, hw, 0, normal, 'road'));
  defs.road.push(seg(edge(-1, 0), 0, -hw, 0, (rd, i) => normal(rd, i) && (rd.nodeWl(i) > hw + 0.02 || rd.nodeWl(i + 1) > hw + 0.02), 'plain'));
  defs.road.push(seg(edge(-1, 0), 0, edge(1, 0), 0, zoned, 'plain')); // 交流道：整片素面柏油，標線另外畫
  for (const sd of [-1, 1]) {
    const wall = (rd, i) => open(rd, i) && !exitOpen(rd, i, sd);
    defs.concrete.push(seg(edge(sd, 0), 0, edge(sd, 0), 1.0, wall));
    defs.concrete.push(seg(edge(sd, 0), 1.0, edge(sd, 0.3), 1.0, wall));
    defs.dark.push(seg(edge(sd, 0.3), 1.0, edge(sd, 0.3), 3.4, (rd, i) => wall(rd, i) && normal(rd, i) && (Math.abs(rd.nodeKappa(i)) > 0.0015 || noiseAt(i, sd)) && !exitAt(rd, i)));
    // 假出口：護欄開口處的發光柵欄、往外彎下去的匝道（路面＋兩側護欄）
    defs.lightWall.push(seg(edge(sd, 0), 0.15, edge(sd, 0), 1.15, (rd, i) => exitOpen(rd, i, sd)));
    defs.paintY.push(line(edge(sd, -0.45), (rd, i) => exitOpen(rd, i, sd)));
    const onRamp = (rd, i) => { const e = exitAt(rd, i); return !!e && e.sd === sd; };
    const ramp = (o0, h0, o1, h1) => ({
      ok: onRamp, uv: 'plain',
      ends(f, e) {
        const x = exitAt(f.rd, f.i);
        if (!x || x.sd !== sd) return false;
        const w = sd < 0 ? f.wl : f.wr, off = exitOff(x.t), dz = exitDrop(x.t);
        const d0 = sd * (w + off + o0), d1 = sd * (w + off + o1);
        if (d0 < d1) { e.da = d0; e.ha = dz + h0; e.db = d1; e.hb = dz + h1; } else { e.da = d1; e.ha = dz + h1; e.db = d0; e.hb = dz + h0; }
        return true;
      },
    });
    defs.road.push(ramp(0, 0, 5.2, 0));
    defs.concrete.push(ramp(5.2, 0, 5.2, 1.0));
    defs.concrete.push({ ...ramp(0, 0, 0, 1.0), ok: (rd, i) => onRamp(rd, i) && !exitOpen(rd, i, sd) && exitAt(rd, i).t >= 0.36 });
    defs.deck.push(ramp(0, -1.2, 5.2, -1.2));
    // 上層高架的側面
    defs.deck.push(seg(edge(sd, 1.2), UPPER_H, edge(sd, 1.2), UPPER_H + 1.7, upperAt));
    defs.deck.push(seg(edge(sd, 0.3), 1.0, edge(sd, 0.3), -1.6, open));
    defs.deck.push(seg(edge(sd, 0.6), -1.6, edge(sd, 0.6), TH + 0.8, tunnel));
    defs.tunnelWall.push(seg(edge(sd, 0), 0, edge(sd, 0), TH, tunnel));
    defs.tunnelLight.push(seg(edge(sd, -1.2), TH - 0.05, edge(sd, -1.9), TH - 0.05, tunnel));
    // 交流道的路緣實線
    defs.paint.push(line(edge(sd, -0.75), zoned));
  }
  defs.deck.push(seg(edge(-1, 0.3), -1.6, edge(1, 0.3), -1.6, open));
  defs.deck.push(seg(edge(-1, 1.2), UPPER_H, edge(1, 1.2), UPPER_H, upperAt));   // 上層高架的底面
  defs.deck.push(seg(edge(-1, 0.6), TH + 0.8, edge(1, 0.6), TH + 0.8, tunnel));
  defs.tunnelWall.push(seg(edge(-1, 0), TH, edge(1, 0), TH, tunnel));
  defs.tunnelFloor.push(seg(edge(-1, 0), 0.05, edge(1, 0), 0.05, tunnel));

  // 交流道的車道線。分歧前：左兩車道的分隔線、右兩車道的分隔線、以及把左右分開的中線（最後 200 m 變黃）
  defs.paint.push(line((f) => (f.l0 + f.l1) / 2, z(1, 2, 3), true));
  defs.paint.push(line((f) => f.l2 - 1.75, z(1, 2), true));
  defs.paint.push(line((f) => f.l1 + 1.75, z(1)));
  defs.paintY.push(line((f) => f.l1 + 1.75, z(2)));
  defs.paintY.push(line((f) => f.l1 + 1.45, z(2)));
  // 左分支：補回來的第三車道
  defs.paint.push(line((f) => (f.wr - (f.l1 + 1.75) > 2.6 ? f.l1 + 1.75 : NaN), z(3), true));
  // 右分支：鏡像
  defs.paint.push(line((f) => (f.l1 + f.l2) / 2, z(4), true));
  defs.paint.push(line((f) => (f.wl + (f.l1 - 1.75) > 2.6 ? f.l1 - 1.75 : NaN), z(4), true));
  return defs;
}

/** 封閉柵欄：紅白斜紋的發光板 */
function barrierTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#1a0503'; g.fillRect(0, 0, 64, 256);
  for (let y = -64; y < 256; y += 64) {
    g.fillStyle = '#ff3a1c';
    g.beginPath(); g.moveTo(0, y + 64); g.lineTo(64, y); g.lineTo(64, y + 30); g.lineTo(0, y + 94); g.closePath(); g.fill();
    g.fillStyle = '#ffe9d8';
    g.beginPath(); g.moveTo(0, y + 30); g.lineTo(64, y - 34); g.lineTo(64, y - 22); g.lineTo(0, y + 42); g.closePath(); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** 路上的指示牌（虛構地名）。kind：0–2 門架上的綠牌，3 出口封閉 */
function signTexture(kind) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  const green = '#0b6b3a', white = '#f2f6f0';
  g.fillStyle = kind === 3 ? '#1c1f24' : green; g.fillRect(0, 0, 512, 256);
  g.strokeStyle = white; g.lineWidth = 8; g.strokeRect(10, 10, 492, 236);
  g.fillStyle = white; g.textBaseline = 'middle'; g.textAlign = 'left';
  const big = 'bold 62px "Microsoft JhengHei", "Noto Sans TC", sans-serif', small = 'bold 40px "Microsoft JhengHei", "Noto Sans TC", sans-serif';
  const arrow = (x, y, rot) => { g.save(); g.translate(x, y); g.rotate(rot); g.fillRect(-9, -26, 18, 70); g.beginPath(); g.moveTo(0, -62); g.lineTo(34, -20); g.lineTo(-34, -20); g.closePath(); g.fill(); g.restore(); };
  const rows = [
    [['曉灣', '12 km'], ['霧原', '5 km']],
    [['星見台', '8 km'], ['朝凪橋', '3 km']],
    [['夜潮埠頭', '2 km'], ['燈丘', '出口']],
  ][kind];
  if (rows) {
    rows.forEach(([name, dist], n) => {
      const y = 84 + n * 94;
      arrow(70, y + 4, kind === 2 && n === 1 ? -Math.PI / 4 : 0);
      g.font = big; g.textAlign = 'left'; g.fillText(name, 130, y);
      g.font = small; g.textAlign = 'right'; g.fillText(dist, 484, y + 4);
    });
  } else {
    g.fillStyle = '#ff5a3c'; g.font = 'bold 92px "Microsoft JhengHei", "Noto Sans TC", sans-serif'; g.textAlign = 'center';
    g.fillText('出口封閉', 256, 96);
    g.fillStyle = white; g.font = small; g.fillText('CLOSED　夜間施工', 256, 192);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ── 方向牌 ───────────────────────────────────────────
function createGantry(scene) {
  const group = new THREE.Group();
  group.visible = false;
  group.matrixAutoUpdate = false;
  scene.add(group);
  const steel = new THREE.MeshStandardMaterial({ color: 0x5a6068, roughness: 0.6, metalness: 0.5 });
  const post = (x) => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.4, 9, 0.4), steel); m.position.set(x, 4.5, 0); group.add(m); return m; };
  const posts = [post(-8.6), post(8.6)];
  const beam = new THREE.Mesh(new THREE.BoxGeometry(17.6, 0.5, 0.5), steel);
  beam.position.set(0, 8.9, 0);
  group.add(beam);
  const panels = [];
  for (const sx of [1, -1]) { // 車身座標 +x = 左
    const c = document.createElement('canvas');
    c.width = 512; c.height = 256;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 3.6), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, fog: true }));
    m.position.set(sx * 3.9, 6.9, -0.3);
    m.rotation.y = Math.PI; // 面向來車
    group.add(m);
    panels.push({ c, tex, m });
  }
  function draw(p, left, node) {
    const g = p.c.getContext('2d');
    g.fillStyle = '#0b6b3a';
    g.fillRect(0, 0, 512, 256);
    g.strokeStyle = '#f2f6f0'; g.lineWidth = 8;
    g.strokeRect(10, 10, 492, 236);
    g.fillStyle = '#f2f6f0';
    g.textBaseline = 'middle';
    g.font = '120px "Segoe UI Emoji", "Segoe UI Symbol", sans-serif';
    g.textAlign = 'center';
    g.fillText(node.icon, left ? 370 : 142, 108);
    g.font = 'bold 54px "Microsoft JhengHei", "Noto Sans TC", sans-serif';
    g.fillText(node.name, 256, 204);
    // 箭頭：斜向左上或右上
    g.save();
    g.translate(left ? 130 : 382, 104);
    g.rotate(left ? -Math.PI / 4 : Math.PI / 4);
    g.fillRect(-10, -40, 20, 90);
    g.beginPath(); g.moveTo(0, -78); g.lineTo(38, -30); g.lineTo(-38, -30); g.closePath(); g.fill();
    g.restore();
    p.tex.needsUpdate = true;
  }
  return { group, posts, beam, draw: (optL, optR) => { draw(panels[0], true, optL); draw(panels[1], false, optR); } };
}

export function createStreamer(scene, road, renderer, seed) {
  const hw = road.halfWidth;
  const total = hw * 2;
  const defs = stripDefs(hw);
  const texRng = createRng(seed ^ 0x5bd1e995);

  const concreteTex = wallTexture('#8a8d92', '#55585c', renderer);
  const tunnelTex = wallTexture('#9c9a94', '#6b6862', renderer);
  const paintMat = (color) => new THREE.MeshBasicMaterial({ color, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const mats = {
    road: new THREE.MeshStandardMaterial({ map: roadTexture(road, renderer), roughness: 0.82 }),
    concrete: new THREE.MeshStandardMaterial({ map: concreteTex, roughness: 0.9, side: THREE.DoubleSide }),
    dark: new THREE.MeshStandardMaterial({ color: 0x1b222c, roughness: 0.8, side: THREE.DoubleSide }),
    deck: new THREE.MeshStandardMaterial({ color: 0x33363b, roughness: 0.95, side: THREE.DoubleSide }),
    tunnelWall: new THREE.MeshStandardMaterial({ map: tunnelTex, roughness: 0.6, emissive: 0x57452c, emissiveMap: tunnelTex, emissiveIntensity: 1.1, side: THREE.DoubleSide }),
    tunnelLight: new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffc27a).multiplyScalar(2.2), side: THREE.DoubleSide }),
    tunnelFloor: new THREE.MeshBasicMaterial({ color: 0x6a4420, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    lightWall: new THREE.MeshBasicMaterial({ map: barrierTexture(), side: THREE.DoubleSide }),
    paint: paintMat(0xa8a8a0),
    paintY: paintMat(0xd8a020),
  };
  const glowTex = glowTexture();
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x4a4f57, roughness: 0.6, metalness: 0.4 });
  const headMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffa040).multiplyScalar(3) });
  // 地面光池：不用貼圖，直接在 shader 裡由貼片的局部座標算出橢圓衰減，遠處依霧的濃度淡出
  const glowMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color() }, uFog: { value: 0.0019 } },
    vertexShader: 'varying vec2 vP; varying float vDist; void main(){ vP = vec2((position.x - 3.9) / 10.0, position.z / 19.0); vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0); vDist = -mv.z; gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'varying vec2 vP; varying float vDist; uniform vec3 uColor; uniform float uFog; void main(){ float r2 = dot(vP, vP); float f = max(0.0, 1.0 - r2); f *= f; float fade = exp(-uFog * uFog * vDist * vDist); gl_FragColor = vec4(uColor * f * fade, 1.0); }',
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const haloMat = new THREE.PointsMaterial({ map: glowTex, size: 9, sizeAttenuation: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, color: 0xffc890 });
  const reflMat = new THREE.PointsMaterial({ map: glowTex, size: 0.9, sizeAttenuation: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, color: 0xffd9a8 });
  const buildMat = new THREE.MeshStandardMaterial({ color: 0x0c1118, roughness: 0.9, emissive: 0xffffff, emissiveMap: windowTexture(texRng), emissiveIntensity: 0.9 });

  // 路燈：燈桿＋橫臂合併成一個幾何；燈頭、地面光暈把位移烤進幾何，三者共用同一組 instance 矩陣
  const pole = new THREE.BoxGeometry(0.22, 9, 0.22); pole.translate(0, 5.5, 0);
  const arm = new THREE.BoxGeometry(3.2, 0.16, 0.16); arm.translate(1.5, 9.9, 0);
  const poleGeo = mergeGeometries([pole, arm]);
  const headGeo = new THREE.BoxGeometry(1.5, 0.22, 0.6); headGeo.translate(2.9, 9.8, 0);
  const glowGeo = new THREE.PlaneGeometry(20, 38); glowGeo.rotateX(-Math.PI / 2); glowGeo.translate(3.9, 0.06, 0);
  const pillarGeo = new THREE.BoxGeometry(4, 60, 3); pillarGeo.translate(0, -31.7, 0);
  // 路邊物件：一律用單位方塊的 instance（里程牌、緊急電話、伸縮縫、跨線橋、橋塔、門架…），發光的另外一組
  const NBOX = 56, NGLOW = 28;
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const propMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0.1 });
  const propGlowMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const signGeo = new THREE.PlaneGeometry(1, 1); signGeo.rotateY(Math.PI);
  const signMats = [0, 1, 2, 3].map((k) => new THREE.MeshBasicMaterial({ map: signTexture(k) }));
  const buildGeo = new THREE.BoxGeometry(1, 1, 1); buildGeo.translate(0, 0.5, 0);

  const root = new THREE.Group();
  scene.add(root);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), new THREE.MeshStandardMaterial({ color: 0x06090e, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -45;
  scene.add(ground);

  // 分隔島尖端的防撞桶與兩面方向牌
  const cushion = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 1.1, 12), new THREE.MeshBasicMaterial({ color: 0xd8a020 }));
  cushion.visible = false;
  scene.add(cushion);
  const gantries = [createGantry(scene), createGantry(scene)];

  // ── 預先配置 slot
  const slots = [];
  for (let n = 0; n < NSLOT; n++) {
    const group = new THREE.Group();
    group.visible = false;
    root.add(group);
    const cats = {};
    for (const [name, list] of Object.entries(defs)) {
      const maxV = list.length * (CH + 2) * 2; // +1：分歧點那個 node 會有兩組頂點
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(maxV * 3), nor = new Float32Array(maxV * 3), uv = new Float32Array(maxV * 2);
      const idx = new Uint16Array(list.length * CH * 6);
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2).setUsage(THREE.DynamicDrawUsage));
      geo.setIndex(new THREE.BufferAttribute(idx, 1).setUsage(THREE.DynamicDrawUsage));
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 170);
      const mesh = new THREE.Mesh(geo, mats[name]);
      if (name === 'tunnelFloor') mesh.renderOrder = 1;
      group.add(mesh);
      cats[name] = { geo, pos, nor, uv, idx, mesh };
    }
    const inst = (geo, mat, count, radius) => {
      const m = new THREE.InstancedMesh(geo, mat, count);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius);
      group.add(m);
      return m;
    };
    const points = (mat, count) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 170);
      const p = new THREE.Points(g, mat);
      group.add(p);
      return p;
    };
    const slot = {
      chunk: -1, src: 'main', dirty: false, group, cats,
      poles: inst(poleGeo, poleMat, NLAMP, 170),
      heads: inst(headGeo, headMat, NLAMP, 170),
      glows: inst(glowGeo, glowMat, NLAMP, 170),
      pillars: inst(pillarGeo, mats.deck, NPILLAR, 180),
      builds: inst(buildGeo, buildMat, NBUILD, 520),
      halos: points(haloMat, NLAMP),
      refl: points(reflMat, NREFL),
      boxes: inst(unitBox, propMat, NBOX, 260),
      glowBoxes: inst(unitBox, propGlowMat, NGLOW, 260),
      signs: signMats.map((m) => inst(signGeo, m, 2, 200)),
    };
    slot.boxes.setColorAt(0, new THREE.Color(1, 1, 1)); slot.glowBoxes.setColorAt(0, new THREE.Color(1, 1, 1));
    slot.glows.renderOrder = 1;
    slots.push(slot);
  }

  const m4 = new THREE.Matrix4();
  const propColor = new THREE.Color();
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  const vX = new THREE.Vector3(), vY = new THREE.Vector3(), vZ = new THREE.Vector3();
  const q = new THREE.Quaternion(), sc = new THREE.Vector3(), ps = new THREE.Vector3();
  const stats = { built: 0, lastBuildMs: 0, maxBuildMs: 0, active: 0 };
  const ends = { da: 0, ha: 0, db: 0, hb: 0 };
  const uPlain0 = (road.shoulder + 0.5) / total, uPlain1 = (road.shoulder + 3.0) / total;
  let alt = null; // 另一條分支（由 setAlt 設定）

  function build(slot, c, src) {
    const t0 = performance.now();
    const rd = src === 'alt' ? alt : road;
    const fork = rd.fork;
    // alt 只畫分歧點之後；分歧點之前那段主線已經畫了
    const iFrom = src === 'alt' ? fork.i : -Infinity;
    const i0 = c * CH;
    rd.frame(i0 * DS, fr);
    const ox = fr.p[0], oy = fr.p[1], oz = fr.p[2];
    slot.group.position.set(ox, oy, oz);
    const vBase = (i0 * DS) % 12;

    // 帶狀面
    for (const [name, list] of Object.entries(defs)) {
      const { geo, pos, nor, uv, idx, mesh } = slot.cats[name];
      let nv = 0, ni = 0;
      // 在 node i 放一組頂點（兩端）；branch = 以分支起點的角度看分歧點
      const put = (def, i, k, branch, connect) => {
        rd.frameNode(i, fr, branch);
        fr.i = i; fr.rd = rd;
        if (!def.ends(fr, ends)) return false;
        const { da, ha, db, hb } = ends;
        const ax = fr.p[0] + fr.r[0] * da + fr.u[0] * ha - ox, ay = fr.p[1] + fr.r[1] * da + fr.u[1] * ha - oy, az = fr.p[2] + fr.r[2] * da + fr.u[2] * ha - oz;
        const bx = fr.p[0] + fr.r[0] * db + fr.u[0] * hb - ox, by = fr.p[1] + fr.r[1] * db + fr.u[1] * hb - oy, bz = fr.p[2] + fr.r[2] * db + fr.u[2] * hb - oz;
        // 法線 = (b − a) × 前進方向
        const ex = bx - ax, ey = by - ay, ez = bz - az;
        let nx = ey * fr.t[2] - ez * fr.t[1], ny = ez * fr.t[0] - ex * fr.t[2], nz = ex * fr.t[1] - ey * fr.t[0];
        const inv = 1 / (Math.hypot(nx, ny, nz) || 1);
        nx *= inv; ny *= inv; nz *= inv;
        const p3 = nv * 3, p2 = nv * 2;
        pos[p3] = ax; pos[p3 + 1] = ay; pos[p3 + 2] = az;
        pos[p3 + 3] = bx; pos[p3 + 4] = by; pos[p3 + 5] = bz;
        nor[p3] = nx; nor[p3 + 1] = ny; nor[p3 + 2] = nz;
        nor[p3 + 3] = nx; nor[p3 + 4] = ny; nor[p3 + 5] = nz;
        const v = (vBase + k * DS) / 12;
        uv[p2] = def.uv === 'plain' ? uPlain0 : 0; uv[p2 + 1] = v;
        uv[p2 + 2] = def.uv === 'plain' ? uPlain1 : 1; uv[p2 + 3] = v;
        if (connect) {
          const p = nv - 2;
          idx[ni++] = p; idx[ni++] = p + 1; idx[ni++] = nv;
          idx[ni++] = p + 1; idx[ni++] = nv + 1; idx[ni++] = nv;
        }
        nv += 2;
        return true;
      };
      for (const def of list) {
        let prevOk = false;
        for (let k = 0; k <= CH; k++) {
          const i = i0 + k;
          const ok = k < CH && i >= iFrom && def.ok(rd, i);
          const atFork = fork && i === fork.i;
          // 分歧點：先用「分歧前」的寬度把前一段收尾，再用「分支起點」的寬度重新開始
          if (atFork && prevOk) { put(def, i, k, false, true); prevOk = false; }
          if (ok || prevOk) prevOk = put(def, i, k, atFork, prevOk) && ok;
          else prevOk = false;
        }
      }
      geo.setDrawRange(0, ni);
      geo.attributes.position.needsUpdate = true;
      geo.attributes.normal.needsUpdate = true;
      geo.attributes.uv.needsUpdate = true;
      geo.index.needsUpdate = true;
      mesh.visible = ni > 0;
    }
    rd.frame((i0 + CH / 2) * DS, fr);
    const cx = fr.p[0] - ox, cy = fr.p[1] - oy, cz = fr.p[2] - oz;
    for (const cat of Object.values(slot.cats)) cat.geo.boundingSphere.center.set(cx, cy, cz);
    for (const m of [slot.poles, slot.heads, slot.glows, slot.pillars, slot.builds, slot.boxes, slot.glowBoxes, ...slot.signs]) m.boundingSphere.center.set(cx, cy, cz);
    slot.halos.geometry.boundingSphere.center.set(cx, cy, cz);
    slot.refl.geometry.boundingSphere.center.set(cx, cy, cz);

    // 路燈（隧道內不放）
    const halo = slot.halos.geometry.attributes.position;
    for (let n = 0; n < NLAMP; n++) {
      const i = i0 + n * LAMP_EVERY;
      rd.frameNode(i, fr, i >= iFrom && fork && i === fork.i);
      const lampSide = (i / LAMP_EVERY) % 2 === 0 ? -1 : 1;
      if (fr.tunnel || i < iFrom || exitOpen(rd, i, lampSide)) {
        for (const m of [slot.poles, slot.heads, slot.glows]) m.setMatrixAt(n, ZERO);
        halo.setXYZ(n, 0, -9999, 0);
        continue;
      }
      const side = (i / LAMP_EVERY) % 2 === 0 ? -1 : 1;
      const d = side * ((side < 0 ? fr.wl : fr.wr) + 0.7);
      // 右側的燈：+x 指向左（路內）；左側的燈繞上軸轉 180°
      vX.set(-fr.r[0], -fr.r[1], -fr.r[2]).multiplyScalar(side);
      vY.fromArray(fr.u);
      vZ.fromArray(fr.t).multiplyScalar(side);
      m4.makeBasis(vX, vY, vZ);
      m4.setPosition(fr.p[0] + fr.r[0] * d - ox, fr.p[1] + fr.r[1] * d - oy, fr.p[2] + fr.r[2] * d - oz);
      for (const m of [slot.poles, slot.heads, slot.glows]) m.setMatrixAt(n, m4);
      const hd = d - side * 2.9;
      halo.setXYZ(n, fr.p[0] + fr.r[0] * hd + fr.u[0] * 9.6 - ox, fr.p[1] + fr.r[1] * hd + fr.u[1] * 9.6 - oy, fr.p[2] + fr.r[2] * hd + fr.u[2] * 9.6 - oz);
    }
    halo.needsUpdate = true;
    for (const m of [slot.poles, slot.heads, slot.glows]) m.instanceMatrix.needsUpdate = true;

    // 護欄反光點：每 10 m 一顆，近處最直接的速度參照
    const rp = slot.refl.geometry.attributes.position;
    let rn = 0;
    for (let k = 0; k < CH; k += REFL_EVERY) {
      const i = i0 + k;
      rd.frameNode(i, fr, fork && i === fork.i && i >= iFrom);
      for (const side of [-1, 1]) {
        if (i < iFrom) { rp.setXYZ(rn++, 0, -9999, 0); continue; }
        const d = side * ((side < 0 ? fr.wl : fr.wr) - 0.04);
        rp.setXYZ(rn++, fr.p[0] + fr.r[0] * d + fr.u[0] * 0.8 - ox, fr.p[1] + fr.r[1] * d + fr.u[1] * 0.8 - oy, fr.p[2] + fr.r[2] * d + fr.u[2] * 0.8 - oz);
      }
    }
    rp.needsUpdate = true;

    // ── 路邊物件
    let nb = 0, ng = 0;
    const ns = [0, 0, 0, 0];
    const col = propColor;
    /** 在 node i、橫向 d、底部高度 h 放一個方塊；yaw = 繞上軸轉的角度（0 = 長邊沿著路） */
    const place = (mesh, n, i, d, h, sx, sy, sz, yaw, r, g, b) => {
      rd.frameNode(i, fr, false);
      const cs = Math.cos(yaw), sn = Math.sin(yaw);
      // 左、上、前（右手系）；yaw 讓「左」與「前」在路面上旋轉
      vX.set(-fr.r[0] * cs + fr.t[0] * sn, -fr.r[1] * cs + fr.t[1] * sn, -fr.r[2] * cs + fr.t[2] * sn);
      vY.fromArray(fr.u);
      vZ.set(fr.t[0] * cs + fr.r[0] * sn, fr.t[1] * cs + fr.r[1] * sn, fr.t[2] * cs + fr.r[2] * sn);
      m4.makeBasis(vX, vY, vZ);
      sc.set(sx, sy, sz); m4.scale(sc);
      const hh = h + sy / 2;
      m4.setPosition(fr.p[0] + fr.r[0] * d + fr.u[0] * hh - ox, fr.p[1] + fr.r[1] * d + fr.u[1] * hh - oy, fr.p[2] + fr.r[2] * d + fr.u[2] * hh - oz);
      mesh.setMatrixAt(n, m4);
      if (r !== undefined) mesh.setColorAt(n, col.setRGB(r, g, b));
    };
    const box = (i, d, h, sx, sy, sz, yaw, r, g, b) => { if (nb < NBOX) place(slot.boxes, nb++, i, d, h, sx, sy, sz, yaw, r, g, b); };
    const glow = (i, d, h, s, r, g, b) => { if (ng < NGLOW) place(slot.glowBoxes, ng++, i, d, h, s, s, s, 0, r, g, b); };
    const sign = (kind, i, d, h, w, hgt) => { if (ns[kind] < 2) place(slot.signs[kind], ns[kind]++, i, d, h, w, hgt, 1, 0); };
    const plainAt = (i) => i >= iFrom && i >= rd.iMin && i <= rd.iMax && rd.nodeZone(i) === 0 && rd.nodeTunnel(i) === 0;
    const iMid = i0 + CH / 2, hc = hash01(c * 977 + 5);
    const nearFork = fork && Math.abs(fork.i - iMid) < 420;
    for (let k = 0; k < CH; k++) {
      const i = i0 + k;
      if (i < iFrom) continue;
      const tun = rd.nodeTunnel(i) === 1, zn = rd.nodeZone(i);
      // 伸縮縫：每 50 m 一道橫過路面的深色細縫
      if (i % 25 === 0 && zn === 0 && !tun) box(i, (rd.nodeWr(i) - rd.nodeWl(i)) / 2, 0.006, rd.nodeWl(i) + rd.nodeWr(i) - 0.3, 0.012, 0.3, 0, 0.012, 0.013, 0.015);
      // 里程牌：每 100 m 一塊，立在左側護欄上
      if (i % 50 === 10 && !tun && !exitOpen(rd, i, -1)) box(i, -(rd.nodeWl(i) + 0.15), 1.0, 0.1, 0.42, 0.3, 0, 0.05, 0.32, 0.14);
      // 緊急電話：每 500 m 一座，上面有一顆綠燈
      if (i % 250 === 120 && !tun && !exitOpen(rd, i, 1)) {
        box(i, rd.nodeWr(i) + 0.2, 1.0, 0.36, 0.85, 0.5, 0, 0.75, 0.62, 0.08);
        glow(i, rd.nodeWr(i) + 0.2, 1.9, 0.16, 0.3, 4.5, 1.2);
      }
      // 上層高架的支柱：每 40 m 一對
      if (i % 20 === 0 && upperAt(rd, i) && plainAt(i)) for (const sd of [-1, 1]) box(i, sd * ((sd < 0 ? rd.nodeWl(i) : rd.nodeWr(i)) + 1.8), -1.6, 1.3, UPPER_H + 1.6, 1.3, 0, 0.2, 0.21, 0.23);
      // 假出口：開口上方一排警示燈，起點立一面「出口封閉」的牌子
      const ex = exitAt(rd, i);
      if (ex) {
        const sd = ex.sd, w = sd < 0 ? rd.nodeWl(i) : rd.nodeWr(i);
        if (ex.t > 0.03 && ex.t < 0.36 && i % 3 === 0) glow(i, sd * w, 1.2, 0.2, 7, 2.6, 0.25);
        if (ex.k === (ex.rev ? XLEN - 1 : 1)) {
          box(i, sd * (w + 0.5), 0, 0.2, 4.2, 0.2, 0, 0.3, 0.32, 0.35);
          sign(3, i, sd * (w + 0.5), 4.0, 3.4, 1.7);
        }
      }
    }
    if (plainAt(iMid) && plainAt(iMid - 30) && plainAt(iMid + 30) && !nearFork && !upperAt(rd, iMid)) {
      const wl = rd.nodeWl(iMid), wr = rd.nodeWr(iMid), mid = (wr - wl) / 2;
      if (hc < 0.3) {
        // 跨線橋：另一條高架從頭頂斜斜跨過去
        const yaw = Math.PI / 2 + (hash01(c * 311 + 1) - 0.5) * 0.9, h = 14 + hash01(c * 71 + 2) * 5;
        box(iMid, mid, h, 12, 1.7, 150, yaw, 0.17, 0.18, 0.2);
        box(iMid, mid, h + 1.7, 12.6, 0.9, 150, yaw, 0.3, 0.31, 0.33);
        for (const sd of [-1, 1]) box(iMid + Math.round(sd * 3), sd * (Math.max(wl, wr) + 9), -45, 2.6, 45 + h, 2.6, yaw, 0.2, 0.21, 0.23);
        for (const sd of [-1, 1]) glow(iMid, mid + sd * 14, h + 2.8, 0.5, 6, 3.4, 1.2);
      } else if (hc < 0.42 && Math.abs(rd.nodeKappa(iMid)) < 0.0006 && Math.abs(rd.nodeKappa(iMid - 40)) < 0.0006) {
        // 橋塔：直線段上的門型高塔，塔頂有紅色航空警示燈
        for (const sd of [-1, 1]) {
          const d = sd * ((sd < 0 ? wl : wr) + 3.4);
          box(iMid, d, -30, 3.2, 84, 3.6, 0, 0.4, 0.42, 0.46);
          glow(iMid, d, 54.2, 0.7, 9, 0.5, 0.3);
          glow(iMid, d, 27, 0.5, 9, 0.5, 0.3);
        }
        box(iMid, mid, 20, wl + wr + 10, 2.4, 3.2, 0, 0.4, 0.42, 0.46);
        box(iMid, mid, 48, wl + wr + 10, 3.0, 3.2, 0, 0.4, 0.42, 0.46);
      } else if (hc > 0.5 && hc < 0.82) {
        // 門架指示牌
        const half = Math.max(wl, wr) + 1.0, kind = Math.floor(hash01(c * 53 + 7) * 3);
        for (const sd of [-1, 1]) box(iMid, sd * half, 0, 0.4, 9, 0.4, 0, 0.3, 0.32, 0.35);
        box(iMid, 0, 8.6, half * 2 + 0.4, 0.5, 0.5, 0, 0.3, 0.32, 0.35);
        sign(kind, iMid, -3.7, 5.3, 6.6, 3.2);
        sign((kind + 1) % 3, iMid, 3.7, 5.3, 6.6, 3.2);
      }
    }
    for (let n = nb; n < NBOX; n++) slot.boxes.setMatrixAt(n, ZERO);
    for (let n = ng; n < NGLOW; n++) slot.glowBoxes.setMatrixAt(n, ZERO);
    slot.signs.forEach((m, kind) => { for (let n = ns[kind]; n < 2; n++) m.setMatrixAt(n, ZERO); m.instanceMatrix.needsUpdate = true; });
    for (const m of [slot.boxes, slot.glowBoxes]) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }

    // 橋墩：放在橋面中央（分支的中心線不在路中央）
    for (let n = 0; n < NPILLAR; n++) {
      const i = i0 + n * PILLAR_EVERY;
      if (i >= i0 + CH || i < iFrom) { slot.pillars.setMatrixAt(n, ZERO); continue; }
      rd.frameNode(i, fr, fork && i === fork.i && i >= iFrom);
      const mid = (fr.wr - fr.wl) / 2;
      const st = Math.sin(fr.theta), ct = Math.cos(fr.theta);
      vX.set(ct, 0, -st); vY.set(0, 1, 0); vZ.set(st, 0, ct);
      m4.makeBasis(vX, vY, vZ);
      m4.setPosition(fr.p[0] + fr.r[0] * mid - ox, fr.p[1] - oy, fr.p[2] + fr.r[2] * mid - oz);
      slot.pillars.setMatrixAt(n, m4);
    }
    slot.pillars.instanceMatrix.needsUpdate = true;

    // 遠景建築：以 chunk 編號當種子，同一段路永遠長一樣。要避開主線與另一條分支。
    const rng = createRng((seed ^ Math.imul(c + 1, 0x9e3779b1)) >>> 0);
    const near = (r, bx, bz, clear) => {
      for (let j = r.iMin; j <= r.iMax; j += 8) {
        const ddx = r.nodeX(j) - bx, ddz = r.nodeZ(j) - bz;
        if (ddx * ddx + ddz * ddz < clear * clear) return true;
      }
      return false;
    };
    for (let n = 0; n < NBUILD; n++) {
      const i = i0 + rng.int(0, CH - 1);
      rd.frame(i * DS, fr);
      const side = rng.next() < 0.5 ? -1 : 1;
      const dist = rng.range(46, 330);
      const w = rng.range(18, 46), dp = rng.range(18, 46);
      const bx = fr.p[0] + fr.r[0] * side * dist, bz = fr.p[2] + fr.r[2] * side * dist;
      const tall = rng.next() < 0.15;
      const h = tall ? rng.range(120, 230) : rng.range(35, 110);
      const rot = rng.range(0, Math.PI);
      const clear = 34 + Math.max(w, dp) * 0.75;
      if (src === 'alt' || near(road, bx, bz, clear) || (alt && near(alt, bx, bz, clear))) { slot.builds.setMatrixAt(n, ZERO); continue; }
      ps.set(bx - ox, -45 - oy, bz - oz); sc.set(w, h, dp);
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rot);
      m4.compose(ps, q, sc);
      slot.builds.setMatrixAt(n, m4);
    }
    slot.builds.instanceMatrix.needsUpdate = true;

    slot.chunk = c; slot.src = src; slot.dirty = false;
    slot.group.visible = true;
    stats.built++;
    stats.lastBuildMs = performance.now() - t0;
    if (stats.built > 16) stats.maxBuildMs = Math.max(stats.maxBuildMs, stats.lastBuildMs);
  }

  const find = (c, src) => slots.find((sl) => sl.chunk === c && sl.src === src);
  const sign = { forkS: 0, on: false };

  // HDR 後處理開著時，光暈交給 bloom：燈頭調到很亮、原本畫上去的假光暈調淡
  const HEAD_LDR = new THREE.Color(0xffa040).multiplyScalar(3), HEAD_HDR = new THREE.Color(0xffa040).multiplyScalar(14);
  const POOL_LDR = new THREE.Color(0xffb46a).multiplyScalar(0.3), POOL_HDR = new THREE.Color(0xffb46a).multiplyScalar(0.28);
  // 只有離玩家最近的 4 盞路燈是真的光源（照得到車身和護欄）；其餘的靠燈頭發光＋地面光池貼片
  const LAMP_LIGHTS = 4, LAMP_DS = LAMP_EVERY * DS;
  const lampLights = [];
  for (let n = 0; n < LAMP_LIGHTS; n++) {
    const l = new THREE.PointLight(0xffb070, 0, 36, 2);
    l.visible = false;
    scene.add(l);
    lampLights.push(l);
  }
  const lamp = { real: false, power: 280 };
  function updateLampLights(sPlayer) {
    if (!lamp.real) return;
    const k0 = Math.floor(sPlayer / LAMP_DS);
    for (let j = -1; j <= 2; j++) {
      const k = k0 + j, l = lampLights[((k % LAMP_LIGHTS) + LAMP_LIGHTS) % LAMP_LIGHTS];
      const i = k * LAMP_EVERY;
      if (k < 0 || i < road.iMin || i > road.iMax) { l.intensity = 0; continue; }
      road.frameNode(i, fr, false);
      // 進入與離開這 4 盞的範圍時淡入淡出，換燈才不會跳
      const ds = k * LAMP_DS - sPlayer;
      const fade = ds < 0 ? Math.max(0, 1 + ds / LAMP_DS) : Math.min(1, Math.max(0, (2.6 * LAMP_DS - ds) / LAMP_DS));
      l.intensity = fr.tunnel ? 0 : lamp.power * fade;
      const side = k % 2 === 0 ? -1 : 1;
      const d = side * ((side < 0 ? fr.wl : fr.wr) + 0.7 - 2.9);
      l.position.set(fr.p[0] + fr.r[0] * d + fr.u[0] * 9.5, fr.p[1] + fr.r[1] * d + fr.u[1] * 9.5, fr.p[2] + fr.r[2] * d + fr.u[2] * 9.5);
    }
  }
  /** hdr：後處理是否開著；realLights：是否開最近 4 盞真光源（低畫質關） */
  function setHdr(on, realLights = on) {
    headMat.color.copy(on ? HEAD_HDR : HEAD_LDR);
    glowMat.uniforms.uColor.value.copy(on ? POOL_HDR : POOL_LDR);
    haloMat.opacity = on ? 0.12 : 1;
    mats.tunnelFloor.color.setHex(0x6a4420).multiplyScalar(on ? 0.3 : 1);
    mats.lightWall.color.setScalar(on ? 2.6 : 1);
    for (const m of signMats) m.color.setScalar(on ? 0.75 : 1);
    reflMat.opacity = on ? 0.6 : 1;
    lamp.real = realLights;
    for (const l of lampLights) l.visible = realLights;
  }
  return {
    stats, root, setHdr, lamp, lampLights, glowMat, roadMaterial: mats.road,

    /** 新的交流道插入：切點之後的道路改了，那些 chunk 要重建；同時立起方向牌 */
    onJunction(altRoad, cutS, forkS, optL, optR) {
      alt = altRoad;
      const iCut = Math.floor(cutS / DS) - 120; // 往前多重建一點，建築要避開新長出來的分支
      for (const sl of slots) if (sl.chunk >= 0 && (sl.chunk + 1) * CH > iCut) sl.dirty = true;
      sign.forkS = forkS; sign.on = true;
      [JCT.sign1, JCT.sign2].forEach((back, n) => {
        const g = gantries[n];
        road.frame(forkS - back, fr);
        g.draw(optL, optR);
        const half = Math.max(fr.wl, fr.wr) + 1.0;
        g.posts[0].position.x = half; g.posts[1].position.x = -half;
        g.beam.scale.x = (half * 2 + 0.4) / 17.6;
        vX.set(-fr.r[0], -fr.r[1], -fr.r[2]); vY.fromArray(fr.u); vZ.fromArray(fr.t);
        g.group.matrix.makeBasis(vX, vY, vZ).setPosition(fr.p[0], fr.p[1], fr.p[2]);
        g.group.matrixWorldNeedsUpdate = true;
        g.group.visible = true;
      });
      road.frame(forkS - 1, fr);
      cushion.position.set(fr.p[0] + fr.u[0] * 0.55, fr.p[1] + fr.u[1] * 0.55, fr.p[2] + fr.u[2] * 0.55);
      cushion.visible = true;
    },
    /** 玩家選了另一條分支：分歧點之後的 chunk 交換標籤；分歧點所在的那一塊要重建 */
    onSwap(forkS) {
      const cFork = Math.floor(forkS / DS / CH);
      for (const sl of slots) {
        if (sl.chunk < cFork) continue;
        if (sl.chunk === cFork) sl.dirty = true;
        else sl.src = sl.src === 'main' ? 'alt' : 'main';
      }
    },
    /** 另一條分支回收 */
    onAltCleared() {
      for (const sl of slots) if (sl.src === 'alt' && sl.chunk >= 0) { sl.chunk = -1; sl.group.visible = false; sl.src = 'main'; }
      alt = null;
    },

    /** 每幀呼叫。平常一幀最多建一個 chunk（要重建的可到兩個）；all = true 時一次建滿（開局用） */
    update(sPlayer, camera, all = false) {
      updateLampLights(sPlayer);
      const cMin = Math.max(0, Math.floor((sPlayer - BEHIND) / (CH * DS)));
      const cMax = Math.floor((sPlayer + AHEAD) / (CH * DS));
      const cFork = alt && alt.fork ? Math.floor(alt.fork.i / CH) : Infinity;
      const cAltMax = alt ? Math.min(cMax, Math.floor((alt.iMax - 2) / CH) - 1) : -1;
      const wanted = (sl) => sl.chunk >= cMin && sl.chunk <= cMax && (sl.src === 'main' || (alt && sl.chunk >= cFork && sl.chunk <= cAltMax));
      let active = 0;
      for (const sl of slots) {
        if (sl.chunk >= 0 && !wanted(sl)) { sl.chunk = -1; sl.group.visible = false; sl.src = 'main'; sl.dirty = false; }
        if (sl.chunk >= 0) active++;
      }
      let budget = all ? 999 : 1, dirtyBudget = all ? 999 : 2;
      // 先重建過期的（由近到遠）
      for (let c = cMin; c <= cMax && dirtyBudget > 0; c++) {
        for (const src of ['main', 'alt']) {
          const sl = find(c, src);
          if (!sl || !sl.dirty) continue;
          const rd = src === 'alt' ? alt : road;
          if (!rd || (c + 1) * CH + 2 > rd.iMax) { sl.chunk = -1; sl.group.visible = false; sl.dirty = false; sl.src = 'main'; active--; continue; }
          build(sl, c, src);
          dirtyBudget--;
        }
      }
      // 再補缺的
      for (let c = cMin; c <= cMax && budget > 0; c++) {
        for (const src of ['main', 'alt']) {
          if (src === 'alt' && (!alt || c < cFork || c > cAltMax)) continue;
          if (find(c, src)) continue;
          const rd = src === 'alt' ? alt : road;
          if ((c + 1) * CH + 2 > rd.iMax || c * CH < rd.iMin) continue; // 道路資料還沒生成到這裡
          const free = slots.find((sl) => sl.chunk < 0);
          if (!free) { budget = 0; break; }
          build(free, c, src);
          active++;
          if (--budget <= 0) break;
        }
      }
      stats.active = active;
      if (sign.on && sPlayer > sign.forkS + 60) {
        sign.on = false;
        for (const g of gantries) g.group.visible = false;
        cushion.visible = false;
      }
      if (camera) { ground.position.x = camera.position.x; ground.position.z = camera.position.z; }
    },
  };
}
