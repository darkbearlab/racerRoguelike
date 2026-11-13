import * as THREE from 'three';

// 尾燈光軌：每顆尾燈拖一條留在世界座標裡的光帶，愈舊愈淡。
// 全部光帶合成一個幾何、一次 draw call；頂點座標以 anchor（玩家位置）為基準，開得再遠也不抖。
const SEG = 14;          // 每條光帶的節點數
const LIFE = 0.24;       // 光帶留存的秒數
const STEP = LIFE / (SEG - 2);

export function createTrails(scene, max = 84) {
  const N = max * SEG;
  const px = new Float64Array(N), py = new Float64Array(N), pz = new Float64Array(N);
  const wx = new Float32Array(N), wy = new Float32Array(N), wz = new Float32Array(N);
  const born = new Float64Array(N), amp = new Float32Array(N);
  const head = new Int32Array(max), count = new Int32Array(max);
  const lastPush = new Float64Array(max), fed = new Uint8Array(max);

  const pos = new Float32Array(N * 2 * 3), col = new Float32Array(N * 2 * 3);
  const idx = new Uint32Array(max * (SEG - 1) * 6);
  let n = 0;
  for (let t = 0; t < max; t++) for (let k = 0; k < SEG - 1; k++) {
    const a = (t * SEG + k) * 2;
    idx[n++] = a; idx[n++] = a + 1; idx[n++] = a + 2;
    idx[n++] = a + 1; idx[n++] = a + 3; idx[n++] = a + 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  scene.add(mesh);

  const tint = new THREE.Color(0.55, 0.02, 0.008);
  let now = 0;

  return {
    mesh,
    set enabled(v) { mesh.visible = v; },
    get enabled() { return mesh.visible; },
    /** HDR 開著時光帶本身就很亮，交給 bloom 暈開；沒開就用普通亮度 */
    setHdr(on) { tint.setRGB(on ? 0.55 : 0.5, on ? 0.02 : 0.03, on ? 0.008 : 0.015); },
    /** 餵一顆尾燈這一幀的位置：p = 世界座標，w = 光帶半寬的向量，a = 亮度 0–1（0 = 不留新的光） */
    feed(id, x, y, z, hx, hy, hz, a) {
      if (!mesh.visible) return;
      const b = id * SEG;
      let h = head[id];
      if (count[id] > 0) {
        const o = b + h, dx = x - px[o], dy = y - py[o], dz = z - pz[o];
        if (dx * dx + dy * dy + dz * dz > 400) count[id] = 0;   // 車子被回收到別處：整條重來
      }
      if (count[id] === 0 || now - lastPush[id] >= STEP) {
        h = (h + 1) % SEG; head[id] = h;
        if (count[id] < SEG) count[id]++;
        lastPush[id] = now;
        born[b + h] = now;
      }
      const o = b + h;
      px[o] = x; py[o] = y; pz[o] = z; wx[o] = hx; wy[o] = hy; wz[o] = hz; amp[o] = a;
      fed[id] = 1;
    },
    update(anchor, dt) {
      now += dt;
      if (!mesh.visible) return;
      mesh.position.copy(anchor);
      const ax = anchor.x, ay = anchor.y, az = anchor.z;
      for (let t = 0; t < max; t++) {
        const b = t * SEG, c = count[t], h = head[t];
        if (!fed[t] && c > 0 && now - born[b + h] > LIFE) count[t] = 0;
        fed[t] = 0;
        for (let k = 0; k < SEG; k++) {
          const v = (b + k) * 6;
          // 第 k 個節點 = 從最新的往回數；不夠的節點疊在最後一個上、亮度 0
          const kk = Math.min(k, Math.max(0, c - 1));
          const o = b + ((h - kk) % SEG + SEG) % SEG;
          const age = k === 0 ? 0 : now - born[o];
          let f = c > 1 && k < c ? Math.max(0, 1 - age / LIFE) : 0;
          f = f * f * f * amp[o];
          const x = px[o] - ax, y = py[o] - ay, z = pz[o] - az;
          pos[v] = x + wx[o]; pos[v + 1] = y + wy[o]; pos[v + 2] = z + wz[o];
          pos[v + 3] = x - wx[o]; pos[v + 4] = y - wy[o]; pos[v + 5] = z - wz[o];
          col[v] = col[v + 3] = tint.r * f; col[v + 1] = col[v + 4] = tint.g * f; col[v + 2] = col[v + 5] = tint.b * f;
        }
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
    },
  };
}
