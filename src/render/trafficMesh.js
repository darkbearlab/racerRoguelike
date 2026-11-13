import * as THREE from 'three';
import { buildCar } from './carBuilder.js';
import { makeFrame } from '../road/spline.js';

// 車流的畫面：每種車一個 InstancedMesh，加上尾燈、頭燈、方向燈、尾燈光暈。
// 所有矩陣以玩家位置為基準，開得再遠也不抖。
const fr = makeFrame();

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.25)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

const PALETTE = [0xb8bcc2, 0xe8e8e6, 0x23262b, 0x5a6470, 0x7a1f1f, 0x1f3a6a, 0x8a7a5a, 0x3a4a3a];

export function createTrafficMesh(scene, road, traffic, cfg, models) {
  const group = new THREE.Group();
  scene.add(group);
  const N = cfg.maxCars;
  // 車身由 carBuilder 生成（輪子併進幾何）；頂點色乘上每台車的顏色，玻璃與輪胎維持深色
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, flatShading: true, roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide });
  const bodies = {};
  const lightY = {};
  for (const [type, t] of Object.entries(cfg.types)) {
    const built = buildCar(models[t.model], { wheels: true });
    lightY[type] = { tail: built.dims.tailY, head: built.dims.noseY };
    const m = new THREE.InstancedMesh(built.geometry, bodyMat, N);
    m.frustumCulled = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.setColorAt(0, new THREE.Color(1, 1, 1));
    group.add(m);
    bodies[type] = m;
  }
  const unit = new THREE.BoxGeometry(1, 1, 1);
  const lightMesh = (count) => {
    const m = new THREE.InstancedMesh(unit, new THREE.MeshBasicMaterial({ color: 0xffffff }), count);
    m.frustumCulled = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.setColorAt(0, new THREE.Color(1, 1, 1));
    group.add(m);
    return m;
  };
  const tails = lightMesh(N * 2);   // 每台車左右各一顆
  const heads = lightMesh(N * 2);
  const blinks = lightMesh(N * 2);

  const haloGeo = new THREE.BufferGeometry();
  haloGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3).setUsage(THREE.DynamicDrawUsage));
  const halos = new THREE.Points(haloGeo, new THREE.PointsMaterial({
    map: glowTexture(), color: 0xff2a18, size: 3.2, sizeAttenuation: true, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  halos.frustumCulled = false;
  group.add(halos);

  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  const base = new THREE.Matrix4(), local = new THREE.Matrix4(), m4 = new THREE.Matrix4();
  const L = new THREE.Vector3(), U = new THREE.Vector3(), F = new THREE.Vector3(), R = new THREE.Vector3(), T = new THREE.Vector3();
  const col = new THREE.Color();
  const RED = new THREE.Color(), RED_BRAKE = new THREE.Color(), WHITE = new THREE.Color(), AMBER = new THREE.Color();
  const setLightLevel = (k) => {
    RED.setRGB(1.1 * k, 0.05 * k, 0.03 * k); RED_BRAKE.setRGB(2.8 * k, 0.12 * k, 0.07 * k);
    WHITE.setRGB(3 * k, 2.8 * k, 2.3 * k); AMBER.setRGB(5 * k, 2.2 * k, 0.2 * k);
  };
  setLightLevel(1);
  let trails = null;
  let time = 0;

  return {
    group,
    /** HDR 後處理開著時光暈交給 bloom，畫上去的假光暈調淡 */
    setHdr(on) { halos.material.opacity = on ? 0.2 : 1; setLightLevel(on ? 4 : 1); },
    /** 尾燈光軌（render/trails.js）；每台車用 id*2、id*2+1 兩條 */
    setTrails(t) { trails = t; },
    /** 車流的車漆只加環境倒影，不開透明漆層（40 台車，省一點） */
    setGloss(env) { bodyMat.envMap = env; bodyMat.envMapIntensity = env ? 0.8 : 0; bodyMat.roughness = env ? 0.38 : 0.5; bodyMat.metalness = env ? 0.5 : 0.3; bodyMat.needsUpdate = true; },
    /** anchor：THREE.Vector3（玩家世界座標） */
    update(anchor, dt, alpha = 1) {
      time += dt;
      const blinkOn = (time * 1.6) % 1 < 0.55;
      group.position.copy(anchor);
      const hp = haloGeo.attributes.position;
      for (const c of traffic.cars) {
        const i = c.id;
        for (const type in bodies) if (type !== c.type || !c.active) bodies[type].setMatrixAt(i, ZERO);
        if (!c.active) {
          for (let k = 0; k < 2; k++) { tails.setMatrixAt(i * 2 + k, ZERO); heads.setMatrixAt(i * 2 + k, ZERO); }
          blinks.setMatrixAt(i * 2, ZERO); blinks.setMatrixAt(i * 2 + 1, ZERO);
          hp.setXYZ(i, 0, -9999, 0);
          continue;
        }
        // 和玩家一樣在兩個物理步之間內插；剛生成或被搬走的車（差距過大）直接用新位置
        const far = Math.abs(c.s - c.ps) > 5;
        const cS = far ? c.s : c.ps + (c.s - c.ps) * alpha, cD = far ? c.d : c.pd + (c.d - c.pd) * alpha;
        (c.onAlt && traffic.alt ? traffic.alt : road).frame(cS, fr);
        R.fromArray(fr.r); T.fromArray(fr.t); U.fromArray(fr.u);
        const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
        F.copy(T).multiplyScalar(cs).addScaledVector(R, -sn);
        L.copy(R).multiplyScalar(-cs).addScaledVector(T, -sn);
        base.makeBasis(L, U, F);
        base.setPosition(fr.p[0] + R.x * cD - anchor.x, fr.p[1] + R.y * cD - anchor.y, fr.p[2] + R.z * cD - anchor.z);

        const body = bodies[c.type];
        body.setMatrixAt(i, base);
        const ty = cfg.types[c.type];
        if (ty.color) col.set(ty.color);
        else col.setHex(ty.fleet ? (c.hue < 0.5 ? 0xd8dadc : 0x9aa0a8) : PALETTE[Math.floor(c.hue * PALETTE.length) % PALETTE.length]);
        body.setColorAt(i, col);

        const ly = lightY[c.type].tail, hy = lightY[c.type].head;
        for (let k = 0; k < 2; k++) {
          const sx = (k === 0 ? 1 : -1) * c.wid * 0.31;
          local.makeScale(c.wid * 0.24, 0.13, 0.08).setPosition(sx, ly, -c.len / 2 - 0.02);
          tails.setMatrixAt(i * 2 + k, m4.multiplyMatrices(base, local));
          tails.setColorAt(i * 2 + k, c.braking ? RED_BRAKE : RED);
          local.makeScale(c.wid * 0.22, 0.12, 0.08).setPosition(sx, hy, c.len / 2 + 0.02);
          heads.setMatrixAt(i * 2 + k, m4.multiplyMatrices(base, local));
          heads.setColorAt(i * 2 + k, WHITE);
        }

        // 方向燈：blink > 0 = 往右（車身 −x）
        if (c.blink !== 0 && blinkOn) {
          const x = -c.blink * (c.wid / 2 - 0.12);
          local.makeScale(0.22, 0.2, 0.1).setPosition(x, ly + 0.02, -c.len / 2 - 0.04);
          blinks.setMatrixAt(i * 2, m4.multiplyMatrices(base, local));
          local.makeScale(0.22, 0.2, 0.1).setPosition(x, hy + 0.02, c.len / 2 + 0.04);
          blinks.setMatrixAt(i * 2 + 1, m4.multiplyMatrices(base, local));
          blinks.setColorAt(i * 2, AMBER); blinks.setColorAt(i * 2 + 1, AMBER);
        } else {
          blinks.setMatrixAt(i * 2, ZERO); blinks.setMatrixAt(i * 2 + 1, ZERO);
        }

        const e = base.elements;
        if (trails) {
          // 光軌：車速愈快愈明顯，煞車時更亮
          const a = Math.min(1, Math.max(0, (c.v * 3.6 - 50) / 60)) * (c.braking ? 1 : 0.55);
          const hx = L.x * 0.08, hy = L.y * 0.08, hz = L.z * 0.08, off = c.wid * 0.3;
          for (let k = 0; k < 2; k++) {
            const sx = k === 0 ? off : -off;
            trails.feed(i * 2 + k, e[12] + anchor.x + L.x * sx + U.x * ly - F.x * c.len / 2, e[13] + anchor.y + L.y * sx + U.y * ly - F.y * c.len / 2, e[14] + anchor.z + L.z * sx + U.z * ly - F.z * c.len / 2, hx, hy, hz, a);
          }
        }
        hp.setXYZ(i, e[12] + U.x * ly - F.x * c.len / 2, e[13] + U.y * ly - F.y * c.len / 2, e[14] + U.z * ly - F.z * c.len / 2);
      }
      for (const type in bodies) {
        bodies[type].instanceMatrix.needsUpdate = true;
        if (bodies[type].instanceColor) bodies[type].instanceColor.needsUpdate = true;
      }
      for (const m of [tails, heads, blinks]) {
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
      hp.needsUpdate = true;
    },
  };
}
