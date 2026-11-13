import * as THREE from 'three';

const FOG_COLOR = 0x0a1322;

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(FOG_COLOR, 0.0019);
  scene.background = new THREE.Color(FOG_COLOR);

  // 天空：深藍到地平線的城市光害
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(2000, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x02040a) },
        mid: { value: new THREE.Color(FOG_COLOR) },
        glow: { value: new THREE.Color(0x3a2418) },
      },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `
        varying vec3 vDir; uniform vec3 top; uniform vec3 mid; uniform vec3 glow;
        void main(){
          float h = clamp(vDir.y, -1.0, 1.0);
          vec3 c = mix(mid, top, smoothstep(0.0, 0.55, h));
          c += glow * exp(-abs(h) * 9.0) * 0.9;
          gl_FragColor = vec4(c, 1.0);
        }`,
    }),
  );
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  scene.add(sky);

  // 環境光：夜空冷色 + 鈉燈暖色
  scene.add(new THREE.HemisphereLight(0x7f95c0, 0x2a1a0c, 1.1));
  const sodium = new THREE.DirectionalLight(0xffa24a, 1.3);
  sodium.position.set(0.2, 1, 0.1);
  scene.add(sodium);
  const moon = new THREE.DirectionalLight(0x8fb0ff, 0.5);
  moon.position.set(-0.6, 0.7, -0.4);
  scene.add(moon);

  // 天色隨時鐘從深夜漸變到拂曉：最後三成的時間天空與霧逐漸變亮
  const hemi = scene.children.find((o) => o.isHemisphereLight);
  const NIGHT = { top: new THREE.Color(0x02040a), mid: new THREE.Color(FOG_COLOR), glow: new THREE.Color(0x3a2418) };
  const DAWN = { top: new THREE.Color(0x1c2f55), mid: new THREE.Color(0x56607c), glow: new THREE.Color(0xc8663a) };
  let lastP = -1, hemiBase = 1.1;
  /** 真的路燈光源開著時，把全域的環境光壓低，光池之間才會暗下來 */
  function setMood(realLamps) {
    hemiBase = realLamps ? 0.62 : 1.1;
    sodium.intensity = realLamps ? 0.38 : 1.3;
    const p = lastP; lastP = -1;
    hemi.intensity = hemiBase + 1.3 * Math.max(0, p);
  }
  function setDaylight(progress) {
    const p = Math.min(1, Math.max(0, (progress - 0.68) / 0.32));
    const e = p * p * (3 - 2 * p);
    if (Math.abs(e - lastP) < 0.002) return;
    lastP = e;
    const u = sky.material.uniforms;
    u.top.value.copy(NIGHT.top).lerp(DAWN.top, e);
    u.mid.value.copy(NIGHT.mid).lerp(DAWN.mid, e);
    u.glow.value.copy(NIGHT.glow).lerp(DAWN.glow, e);
    scene.fog.color.copy(u.mid.value);
    scene.background.copy(u.mid.value);
    hemi.intensity = hemiBase + 1.3 * e;
    moon.intensity = 0.5 + 1.2 * e;
  }

  function resize(camera) {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  return { renderer, scene, sky, resize, setDaylight, setMood };
}
