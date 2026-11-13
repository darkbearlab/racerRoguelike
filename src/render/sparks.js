import * as THREE from 'three';

// 撞牆火花：固定大小的粒子池，一個 draw call。
const N = 96;

export function createSparks(scene) {
  const pos = new Float32Array(N * 3);
  const vel = new Float32Array(N * 3);
  const life = new Float32Array(N);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const dot = document.createElement('canvas');
  dot.width = dot.height = 32;
  const dg = dot.getContext('2d');
  const grad = dg.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.5)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  dg.fillStyle = grad;
  dg.fillRect(0, 0, 32, 32);
  const mat = new THREE.PointsMaterial({
    map: new THREE.CanvasTexture(dot), color: 0xffb060, size: 0.11, sizeAttenuation: true, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  mat.color.multiplyScalar(3);
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  scene.add(points);
  let cursor = 0;
  for (let i = 0; i < N; i++) pos[i * 3 + 1] = -9999;

  return {
    /** origin、dir（前進方向）、out（離牆方向）皆為 Vector3 */
    burst(origin, dir, out, speed, count, rng) {
      // 粒子座標以 points.position 為基準；沒有存活粒子時把基準移到這次的位置（避免遠離原點後抖動）
      let alive = false;
      for (let i = 0; i < N; i++) if (life[i] > 0) { alive = true; break; }
      if (!alive) points.position.copy(origin);
      const bx = origin.x - points.position.x, by = origin.y - points.position.y, bz = origin.z - points.position.z;
      for (let k = 0; k < count; k++) {
        const i = cursor; cursor = (cursor + 1) % N;
        pos[i * 3] = bx; pos[i * 3 + 1] = by + rng.range(0, 0.5); pos[i * 3 + 2] = bz;
        // 火花大致跟著車速往前飛、慢慢落後，不會整團衝向追尾鏡頭
        const f = speed * rng.range(0.78, 1.0), o = rng.range(1, 5), u = rng.range(1, 5);
        vel[i * 3] = dir.x * f + out.x * o;
        vel[i * 3 + 1] = dir.y * f + u;
        vel[i * 3 + 2] = dir.z * f + out.z * o;
        life[i] = rng.range(0.25, 0.6);
      }
    },
    update(dt) {
      for (let i = 0; i < N; i++) {
        if (life[i] <= 0) continue;
        life[i] -= dt;
        if (life[i] <= 0) { pos[i * 3 + 1] = -9999; continue; }
        vel[i * 3 + 1] -= 14 * dt;
        pos[i * 3] += vel[i * 3] * dt;
        pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
        pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      }
      geo.attributes.position.needsUpdate = true;
    },
  };
}
