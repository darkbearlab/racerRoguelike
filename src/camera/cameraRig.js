import * as THREE from 'three';

// 三種視角共用一個 rig：後方追尾（彈簧跟隨）、車頭、駕駛艙（剛性固定）。
export const VIEWS = ['chase', 'hood', 'cockpit'];
export const VIEW_NAMES = { chase: '後方追尾', hood: '車頭', cockpit: '駕駛艙' };

const WORLD_UP = new THREE.Vector3(0, 1, 0);

export function createCameraRig(cfg) {
  const camera = new THREE.PerspectiveCamera(cfg.chase.fov, 16 / 9, 0.3, 4000);
  const camDir = new THREE.Vector3(0, 0, 1);
  const pos = new THREE.Vector3(), look = new THREE.Vector3(), up = new THREE.Vector3(), tmp = new THREE.Vector3();
  let viewIndex = 0;
  let trauma = 0;
  let t = 0;
  let snap = true;
  let tall = 0;   // 直式畫面的程度（0–1，進出隧道時平滑變化）

  const rig = {
    camera,
    get view() { return VIEWS[viewIndex]; },
    nextView() {
      viewIndex = (viewIndex + 1) % VIEWS.length;
      snap = true; // 直接切，不插值，避免鏡頭穿過車身
      return VIEWS[viewIndex];
    },
    setView(name) { viewIndex = Math.max(0, VIEWS.indexOf(name)); snap = true; },
    /** 標題畫面：鏡頭繞著車子慢慢轉 */
    orbit(pose, time) {
      const a = time * 0.16 + 2.4;
      pos.copy(pose.p).addScaledVector(pose.f, Math.cos(a) * 7.5).addScaledVector(pose.l, Math.sin(a) * 7.5).addScaledVector(pose.u, 1.7 + Math.sin(time * 0.11) * 0.5);
      look.copy(pose.p).addScaledVector(pose.u, 0.8);
      camera.position.copy(pos);
      camera.up.copy(pose.u);
      camera.lookAt(look);
      camera.near = 0.3;
      if (camera.fov !== 48) { camera.fov = 48; }
      camera.updateProjectionMatrix();
      snap = true;
    },
    /** 撞擊震動，強度 0–1 */
    addTrauma(v) { trauma = Math.min(1, trauma + v); },

    /**
     * pose: { p, f, u, l }（THREE.Vector3：位置、前、上、左）
     * info: { kmh, vFrac, steer, lookBack, wall: { r: 道路右向量, d: 車子的橫向位置, wl, wr, roof: 在隧道裡 } }
     */
    update(pose, info, dt) {
      t += dt;
      const view = VIEWS[viewIndex];
      const c = cfg[view];
      const back = info.lookBack ? -1 : 1;

      if (view === 'chase') {
        // 鏡頭朝向落後於車頭：轉彎時略向外甩，甩尾時看得到車身角度
        if (snap) camDir.copy(pose.f);
        else camDir.lerp(pose.f, 1 - Math.exp(-c.follow * dt)).normalize();
        up.copy(WORLD_UP).lerp(pose.u, 0.5).normalize();
        // 速度越快鏡頭略往後拉，車子在畫面中變小、路面流動更明顯
        // 直式畫面：鏡頭拉高、往下看，地平線才會在畫面上方三分之一，下面留給路面與車（不然上半個畫面都是天空）。
        // 隧道裡天花板不夠高，暫時回到原本的高度
        const tallWant = camera.aspect < 1 && !info.wall?.roof ? 1 : 0;
        tall = snap ? tallWant : tall + (tallWant - tall) * (1 - Math.exp(-3 * dt));
        const dist = (c.back + (c.speedBack || 0) * info.vFrac * info.vFrac) * (1 + 0.2 * tall);
        pos.copy(pose.p).addScaledVector(camDir, -dist * back).addScaledVector(up, c.height * (1 + 0.8 * tall));
        // 鏡頭不出護欄：車身打橫時鏡頭在車尾後方，會跑到路外面去。沿道路的右向量把它推回兩側護欄之間
        const w = info.wall;
        if (w) {
          const off = (pos.x - pose.p.x) * w.r[0] + (pos.y - pose.p.y) * w.r[1] + (pos.z - pose.p.z) * w.r[2];
          const dc = w.d + off, lim = Math.min(Math.max(dc, -(w.wl - 0.6)), w.wr - 0.6);
          if (lim !== dc) { pos.x += w.r[0] * (lim - dc); pos.y += w.r[1] * (lim - dc); pos.z += w.r[2] * (lim - dc); }
        }
        look.copy(pose.p).addScaledVector(pose.f, c.lookAhead * (1 - 0.5 * tall) * back).addScaledVector(up, 0.9 - 0.4 * tall);
        camera.near = 0.3;
      } else {
        up.copy(pose.u);
        pos.copy(pose.p).addScaledVector(pose.l, c.x).addScaledVector(pose.u, c.y).addScaledVector(pose.f, c.z);
        // 駕駛艙：視線略微看向彎內
        const lean = view === 'cockpit' ? info.steer * 0.1 : 0;
        tmp.copy(pose.f).multiplyScalar(back).addScaledVector(pose.l, lean * back);
        look.copy(pos).addScaledVector(tmp, 20);
        camera.near = view === 'cockpit' ? 0.05 : 0.3;
      }
      snap = false;

      // 震動：多個正弦疊加，振幅取強度平方；高速時有極輕微路面抖動
      trauma = Math.max(0, trauma - dt * 1.8);
      const amp = trauma * trauma * (view === 'chase' ? 0.35 : 0.12) + info.vFrac ** 3 * 0.014;
      const sx = Math.sin(t * 61.3) * 0.6 + Math.sin(t * 97.1 + 1.3) * 0.4;
      const sy = Math.sin(t * 73.7 + 0.7) * 0.6 + Math.sin(t * 113.9 + 2.1) * 0.4;
      pos.addScaledVector(pose.l, sx * amp).addScaledVector(up, sy * amp);

      camera.position.copy(pos);
      camera.up.copy(up);
      camera.lookAt(look);
      camera.rotateZ(sx * amp * 0.04);

      // 速度感 FOV
      const sf = cfg.speedFov;
      const k = THREE.MathUtils.clamp((info.kmh - sf.fromKmh) / (sf.toKmh - sf.fromKmh), 0, 1);
      let fov = c.fov + sf.add * k;
      // 直式畫面：垂直視角不變的話左右只看得到一條車道。把垂直視角拉大，左右才看得到旁邊的車道
      if (camera.aspect < 1) fov = Math.min(96, 2 * Math.atan(Math.tan(fov * Math.PI / 360) / Math.max(camera.aspect, 0.45) ** 0.65) * 180 / Math.PI);
      if (Math.abs(camera.fov - fov) > 0.01) camera.fov = fov;
      camera.updateProjectionMatrix();
    },
  };
  return rig;
}
