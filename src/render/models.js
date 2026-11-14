import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { buildCar, buildWheelGeometry } from './carBuilder.js';

// 玩家車與對手車：外觀由 carBuilder 依車型參數生成，內裝用簡單幾何體。
// 車身座標：+z 前、+y 上、+x 左（右駕，駕駛座在 −x）。
const LIGHT_LOW = 110, LIGHT_HIGH = 420;

/** opts: { spec（config/models.json 的一筆）, color, player }。player = false 時不建頭燈光源與內裝（對手車） */
export function createCarModel(opts = {}) {
  const isPlayer = opts.player !== false;
  const group = new THREE.Group();
  const exterior = new THREE.Group();
  const interior = new THREE.Group();
  const hood = new THREE.Group(); // 駕駛艙視角仍看得到的引擎蓋
  group.add(exterior, interior, hood);

  // 烤漆：頂點色（白）乘上這個顏色；玻璃與飾板的頂點色是深色
  // 用 Physical 材質是為了透明漆層（clearcoat）：底漆偏霧、上面一層光滑的漆，夜景倒影在上層
  const paint = new THREE.MeshPhysicalMaterial({
    color: opts.color ?? 0x1d4fd0, vertexColors: true, flatShading: true, roughness: 0.34, metalness: 0.55, side: THREE.DoubleSide,
  });
  const hoodPaint = new THREE.MeshPhysicalMaterial({ color: opts.color ?? 0x1d4fd0, roughness: 0.34, metalness: 0.55 });
  // 塗裝：在片段著色器裡依車身座標畫花樣（條紋、雙色、斜紋…），只畫在烤漆的面上（頂點色是白的那些）
  const liv = { uLivB: { value: new THREE.Color(0xf2f2f0) }, uLivP: { value: 0 }, uLivD: { value: new THREE.Vector3(4.4, 1.8, 1.3) } };
  paint.onBeforeCompile = (sh) => {
    sh.uniforms.uLivB = liv.uLivB; sh.uniforms.uLivP = liv.uLivP; sh.uniforms.uLivD = liv.uLivD;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLivPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLivPos = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vLivPos;
uniform vec3 uLivB; uniform float uLivP; uniform vec3 uLivD;
float livMask(vec3 p) {
  float L = uLivD.x, W = uLivD.y, H = uLivD.z, ax = abs(p.x);
  if (uLivP < 0.5) return 0.0;
  if (uLivP < 1.5) return step(W * 0.045, ax) * step(ax, W * 0.17);                       // 雙條紋
  if (uLivP < 2.5) return step(p.y, H * 0.47);                                            // 上下雙色
  if (uLivP < 3.5) { float t = (p.z + p.y * 1.3) / (L * 0.13); return step(-3.0, t) * step(t, 0.0) * step(fract(t), 0.55); } // 車尾斜紋
  if (uLivP < 4.5) { float v = smoothstep(L * 0.3, -L * 0.38, p.z); return floor(v * 6.0 + 0.5) / 6.0; }                   // 前後漸層（分階）
  if (uLivP < 5.5) return max(step(-W * 0.36, p.x) * step(p.x, -W * 0.2), step(-W * 0.16, p.x) * step(p.x, -W * 0.125));  // 偏置條紋
  float c = mod(floor(p.z / 0.3) + floor(p.y / 0.3), 2.0);                                // 車尾方格
  return c * step(p.z, -L * 0.14);
}`)
      .replace('#include <color_fragment>', `#ifdef USE_COLOR
  { float pm = step(0.9, vColor.r);
    diffuseColor.rgb = mix(diffuseColor.rgb * vColor.rgb, mix(diffuseColor.rgb, uLivB, livMask(vLivPos)), pm); }
#endif`);
  };
  paint.customProgramCacheKey = () => 'livery';
  const wheelMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.75, metalness: 0.2 });
  const headMat = new THREE.MeshBasicMaterial({ color: 0xfff4d8 });
  const tailMat = new THREE.MeshBasicMaterial({ color: 0xff1a12 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.7 });
  const unitBox = new THREE.BoxGeometry(1, 1, 1);

  // ── 外觀（可整組換掉：對手每次出場車型不同）
  const body = new THREE.Mesh(new THREE.BufferGeometry(), paint);
  exterior.add(body);
  const wheels = [];
  const lightMeshes = [];
  let dims = { L: 4.4, W: 1.8, H: 1.3, hoodY: 0.8, cowlZ: 0.6 };
  let wheelR = 0.31;

  // 地面假陰影
  const sc = document.createElement('canvas');
  sc.width = sc.height = 64;
  const sg = sc.getContext('2d');
  const grad = sg.createRadialGradient(32, 32, 6, 32, 32, 32);
  grad.addColorStop(0, 'rgba(0,0,0,0.75)');
  grad.addColorStop(0.6, 'rgba(0,0,0,0.5)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  sg.fillStyle = grad;
  sg.fillRect(0, 0, 64, 64);
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }),
  );
  shadow.renderOrder = 2;
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.03;
  exterior.add(shadow);

  // ── 車底 LED：車身輪廓外一圈發光，打在路面上
  const gc = document.createElement('canvas');
  gc.width = gc.height = 128;
  const gg = gc.getContext('2d');
  gg.fillStyle = '#000'; gg.fillRect(0, 0, 128, 128);
  gg.shadowColor = '#fff'; gg.shadowBlur = 16; gg.strokeStyle = '#fff'; gg.lineWidth = 7;
  for (let k = 0; k < 2; k++) gg.strokeRect(34, 26, 60, 76);
  gg.shadowBlur = 0; gg.fillStyle = 'rgba(255,255,255,0.14)'; gg.fillRect(34, 26, 60, 76);
  const glowMat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(gc), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glowMat);
  glow.renderOrder = 3; glow.rotation.x = -Math.PI / 2; glow.position.y = 0.036; glow.visible = false;
  exterior.add(glow);
  const ledColor = new THREE.Color(0x30c8ff);

  // ── 車後投影：把車手的標誌打在車尾後方的路面上，偶爾換成挑釁的表情符號
  const pc = document.createElement('canvas');
  pc.width = pc.height = 256;
  const pg = pc.getContext('2d');
  const projTex = new THREE.CanvasTexture(pc);
  projTex.colorSpace = THREE.SRGBColorSpace;
  const projMat = new THREE.MeshBasicMaterial({ map: projTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide });
  const proj = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), projMat);
  // 貼圖的上緣朝車頭：從後方看過去字是正的
  proj.renderOrder = 3; proj.rotation.x = Math.PI / 2; proj.position.y = 0.04; proj.visible = false;
  exterior.add(proj);
  const look = { glyph: null, name: '', taunts: [], tint: '#ffffff' };
  let taunting = false, projPulse = 0;
  function drawProj(emoji) {
    pg.globalCompositeOperation = 'source-over';
    pg.fillStyle = '#000'; pg.fillRect(0, 0, 256, 256);
    // 投影燈打出來的光斑
    const g = pg.createRadialGradient(128, 128, 20, 128, 128, 126);
    g.addColorStop(0, 'rgba(255,255,255,0.20)'); g.addColorStop(0.8, 'rgba(255,255,255,0.10)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    pg.fillStyle = g; pg.beginPath(); pg.arc(128, 128, 126, 0, Math.PI * 2); pg.fill();
    pg.textAlign = 'center'; pg.textBaseline = 'middle';
    if (emoji) {
      pg.font = '150px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
      pg.fillText(emoji, 128, 138);
    } else {
      pg.strokeStyle = look.tint; pg.lineWidth = 9;
      pg.beginPath(); pg.arc(128, 128, 104, 0, Math.PI * 2); pg.stroke();
      pg.lineWidth = 3; pg.beginPath(); pg.arc(128, 128, 90, 0, Math.PI * 2); pg.stroke();
      pg.fillStyle = '#fff';
      pg.font = `900 ${look.name ? 112 : 132}px "Microsoft JhengHei", "PingFang TC", "Noto Sans TC", sans-serif`;
      pg.fillText(look.glyph, 128, look.name ? 116 : 134);
      if (look.name) {
        pg.fillStyle = look.tint;
        pg.font = '700 26px "Microsoft JhengHei", "PingFang TC", "Noto Sans TC", sans-serif';
        pg.fillText(look.name, 128, 190);
      }
    }
    projTex.needsUpdate = true;
  }

  function setSpec(spec, color) {
    const built = buildCar(spec);
    body.geometry.dispose();
    body.geometry = built.geometry;
    dims = built.dims;
    if (color != null) { paint.color.set(color); hoodPaint.color.set(color); }
    // 輪子
    for (const w of wheels) { exterior.remove(w.pivot); w.mesh.geometry.dispose(); }
    wheels.length = 0;
    for (const w of built.wheels) {
      const pivot = new THREE.Group();
      pivot.position.set(w.x, w.y, w.z);
      const g = buildWheelGeometry(w.r, w.w);
      // 輪圈永遠朝外：左側的輪子把幾何鏡射過去
      const mesh = new THREE.Mesh(g, wheelMat);
      if (w.x > 0) mesh.rotation.y = Math.PI;
      pivot.add(mesh);
      exterior.add(pivot);
      wheels.push({ pivot, mesh, front: w.front, flip: w.x > 0 });
      wheelR = w.r;
    }
    // 車燈
    for (const m of lightMeshes) exterior.remove(m);
    lightMeshes.length = 0;
    const addLights = (list, mat) => {
      for (const b of list) {
        const m = new THREE.Mesh(unitBox, mat);
        m.scale.set(b.w, b.h, b.d);
        m.position.set(b.x, b.y, b.z);
        exterior.add(m);
        lightMeshes.push(m);
      }
    };
    addLights(built.head, headMat);
    addLights(built.tail, tailMat);
    shadow.scale.set(dims.W + 0.9, dims.L + 1.0, 1);
    liv.uLivD.value.set(dims.L, dims.W, dims.H);
    // 光圈在貼圖裡佔 60×76／128，換算成比車身輪廓略大一圈
    glow.scale.set((dims.W + 0.1) * 128 / 60, (dims.L + 0.1) * 128 / 76, 1);
    const ps = isPlayer ? 1.7 : 3.0, pl = isPlayer ? 1.7 : 4.6;   // 對手的投影大一點，而且沿車長拉長：從後方低角度看才不會扁成一條
    proj.scale.set(-ps, pl, 1);
    proj.position.z = -dims.L / 2 - (isPlayer ? 0.25 : 0.5) - pl / 2;
    marker.position.y = dims.H + 1.4;
    markerBase = dims.H + 1.4;
    // 駕駛艙視角看得到的引擎蓋：高度與長度跟著車型
    hoodMesh.scale.set(dims.W - 0.12, 0.05, Math.max(0.6, dims.L / 2 - dims.cowlZ - 0.05));
    hoodMesh.position.set(0, Math.min(dims.hoodY, 0.86), dims.cowlZ + hoodMesh.scale.z / 2 + 0.3);
  }

  // 頭燈照明
  const spot = new THREE.SpotLight(0xfff0d0, LIGHT_LOW, 170, 0.5, 0.8, 1.25);
  spot.position.set(0, 0.8, 2.0);
  spot.target.position.set(0, -0.2, 60);
  if (isPlayer) group.add(spot, spot.target);

  // 車頂標記（對手用）：標示後到對決結束都看得到
  const marker = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.42, 0),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 0.5, 0.25), fog: false }),
  );
  marker.scale.set(1, 1.5, 1);
  marker.position.set(0, 2.7, 0);
  marker.visible = false;
  group.add(marker);
  let markerBase = 2.7;

  // 引擎蓋（駕駛艙視角用）
  const hoodMesh = new THREE.Mesh(unitBox, hoodPaint);
  hood.add(hoodMesh);

  // ── 內裝（只有玩家車需要）
  const box = (w, h, d, mat, x, y, z, parent, r = 0.08) => {
    const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, r), mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };
  const dashMat = new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 0.85 });
  const wheel = new THREE.Group();
  const gaugeCanvas = document.createElement('canvas');
  gaugeCanvas.width = 256; gaugeCanvas.height = 128;
  const gaugeTex = new THREE.CanvasTexture(gaugeCanvas);
  gaugeTex.colorSpace = THREE.SRGBColorSpace;
  const mirror = new THREE.Mesh(
    new THREE.PlaneGeometry(0.42, 0.105),
    new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, toneMapped: false }),
  );
  if (isPlayer) {
    box(1.5, 0.2, 0.5, dashMat, 0, 0.86, 0.9, interior, 0.05);      // 儀表板
    box(1.5, 0.5, 0.1, dashMat, 0, 0.6, 0.68, interior, 0.03);      // 下方面板
    box(1.56, 0.06, 1.3, dashMat, 0, 1.47, -0.1, interior, 0.02);   // 車頂邊緣
    for (const x of [0.76, -0.76]) {
      const p = box(0.08, 0.62, 0.09, dashMat, x, 1.24, 0.72, interior, 0.02); // A 柱
      p.rotation.x = -0.62;
    }
    box(0.3, 0.2, 0.9, dashMat, 0, 0.6, 0.15, interior, 0.04);      // 中央鞍座

    const wheelMat2 = new THREE.MeshStandardMaterial({ color: 0x3a3f48, roughness: 0.6 });
    wheel.position.set(-0.38, 0.88, 0.6);
    wheel.rotation.x = -0.35;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.018, 8, 24), wheelMat2);
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.03, 0.02), wheelMat2);
    const spoke2 = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.16, 0.02), wheelMat2);
    spoke2.position.y = -0.08;
    wheel.add(rim, spoke, spoke2);
    interior.add(wheel);

    // 儀表（CanvasTexture）
    const gauge = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.17), new THREE.MeshBasicMaterial({ map: gaugeTex, toneMapped: false }));
    gauge.scale.set(0.88, 0.88, 1);
    gauge.position.set(-0.38, 0.99, 0.72);
    gauge.rotation.set(0.2, Math.PI, 0);
    interior.add(gauge);
    box(0.36, 0.03, 0.14, dashMat, -0.38, 1.075, 0.76, interior, 0.012); // 儀表遮罩
    box(0.36, 0.14, 0.05, dashMat, -0.38, 1.0, 0.78, interior, 0.02);    // 儀表座

    // 後視鏡
    mirror.position.set(0, 1.39, 0.5);
    mirror.rotation.y = Math.PI;
    mirror.scale.x = -1;
    interior.add(mirror);
    box(0.46, 0.13, 0.03, dashMat, 0, 1.39, 0.52, interior, 0.01);
  }

  const gctx = gaugeCanvas.getContext('2d');
  function drawGauge(kmh, rpm01) {
    gctx.fillStyle = '#05070a';
    gctx.fillRect(0, 0, 256, 128);
    gctx.lineWidth = 10;
    gctx.strokeStyle = '#1e2630';
    gctx.beginPath(); gctx.arc(64, 78, 44, Math.PI * 0.8, Math.PI * 2.2); gctx.stroke();
    gctx.strokeStyle = rpm01 > 0.9 ? '#ff5a3c' : '#6fd3ff';
    gctx.beginPath(); gctx.arc(64, 78, 44, Math.PI * 0.8, Math.PI * (0.8 + 1.4 * rpm01)); gctx.stroke();
    gctx.fillStyle = '#e8eef8';
    gctx.font = 'bold 64px Consolas, monospace';
    gctx.textAlign = 'right';
    gctx.fillText(String(Math.round(kmh)), 236, 86);
    gctx.font = '18px Consolas, monospace';
    gctx.fillStyle = '#8aa0b8';
    gctx.fillText('km/h', 236, 112);
    gaugeTex.needsUpdate = true;
  }
  if (isPlayer) drawGauge(0, 0.12);

  if (opts.spec) setSpec(opts.spec, opts.color);

  let spin = 0;
  let markT = 0;
  let hdr = false;
  return {
    group, exterior, interior, hood, mirror, spot, marker, paint,
    get dims() { return dims; },
    /** 換車型與顏色（對手每次出場用） */
    setSpec,
    /**
     * 外觀：{ color, color2, pattern（0 = 單色，其餘見著色器）, led（顏色或 null）, glyph（標誌的字或 null）, name, taunts[] }
     */
    setLook(o) {
      if (o.color != null) { paint.color.set(o.color); hoodPaint.color.set(o.color); }
      liv.uLivB.value.set(o.color2 ?? '#f2f2f0');
      liv.uLivP.value = o.pattern || 0;
      glow.visible = !!o.led;
      if (o.led) ledColor.set(o.led);
      look.glyph = o.glyph || null; look.name = o.name || ''; look.taunts = o.taunts || [];
      look.tint = o.led || '#ffffff';
      proj.visible = !!look.glyph;
      taunting = false;
      if (look.glyph) drawProj(null);
    },
    /** 投影換成挑釁的表情符號（on = false 換回標誌）。每次打開隨機挑一個 */
    setTaunt(on) {
      if (!look.glyph || on === taunting || (on && !look.taunts.length)) return;
      taunting = on; projPulse = 1;
      drawProj(on ? look.taunts[Math.floor(Math.random() * look.taunts.length)] : null);
    },
    get taunting() { return taunting; },
    /** HDR 後處理開著時，車燈用遠超過 1 的亮度，交給 bloom 暈開 */
    setHdr(on) { hdr = on; },
    /** env = 夜景環境貼圖（null = 關掉漆面倒影，低畫質用） */
    setGloss(env) {
      for (const m of [paint, hoodPaint]) {
        m.envMap = env; m.envMapIntensity = env ? 1.0 : 0;
        m.clearcoat = env ? 1 : 0; m.clearcoatRoughness = 0.06;
        m.roughness = env ? 0.42 : 0.34; m.metalness = env ? 0.6 : 0.55;
        m.needsUpdate = true;
      }
    },
    setMarker(on, dt) {
      marker.visible = on;
      if (!on) return;
      markT += dt;
      marker.rotation.y = markT * 2.4;
      marker.position.y = markerBase + Math.sin(markT * 3.2) * 0.12;
    },
    setView(mode) {
      exterior.visible = mode === 'chase';
      interior.visible = mode === 'cockpit';
      hood.visible = mode === 'cockpit';
    },
    update(st, dt, flash) {
      spin += (st.vf / wheelR) * dt;
      for (const w of wheels) {
        w.mesh.rotation.x = w.flip ? -spin : spin;
        if (w.front) w.pivot.rotation.y = st.steer * 0.42;
      }
      wheel.rotation.z = -st.steer * 1.6;
      // 車底燈微微呼吸；投影剛換圖時閃一下
      if (glow.visible) { const k = (0.85 + 0.15 * Math.sin(spin * 0.02 + markT * 2 + performance.now() * 0.003)) * (hdr ? 1.5 : 0.8); glowMat.color.copy(ledColor).multiplyScalar(k); }
      if (proj.visible) { projPulse = Math.max(0, projPulse - dt * 2.5); projMat.color.setScalar((hdr ? 1.25 : 0.9) * (1 + projPulse * 0.6)); }
      const tk = (st.braking ? 2.4 : 0.9) * (hdr ? 5.5 : 1);
      tailMat.color.setRGB(tk, tk * 0.035, tk * 0.018);
      spot.intensity = flash > 0 ? LIGHT_HIGH : LIGHT_LOW;
      const hk = (flash > 0 ? 6 : 2.2) * (hdr ? 4.5 : 1);
      headMat.color.setRGB(hk, hk * 0.93, hk * 0.76);
    },
    drawGauge,
  };
}
