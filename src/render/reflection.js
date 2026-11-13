import * as THREE from 'three';

// 濕路面的平面反射：
//   1. 把攝影機對路面鏡射，用半解析度把場景再畫一次到 HDR render target（有 mipmap，用來模糊）
//   2. 路面材質用「世界座標 → 鏡射攝影機的螢幕座標」去取樣這張圖，乘上菲涅耳係數與濕度遮罩
// 鏡射攝影機的近平面改成斜的、貼著路面，路面以下的東西就不會畫進反射裡。
// 低畫質時整個關掉（不多畫那一次場景）。

const NOISE = `
float rfHash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float rfNoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rfHash(i), rfHash(i + vec2(1.0, 0.0)), f.x), mix(rfHash(i + vec2(0.0, 1.0)), rfHash(i + vec2(1.0, 1.0)), f.x), f.y);
}`;

export function createReflection(renderer, roadMat) {
  const uniforms = {
    tRefl: { value: null },
    uReflMatrix: { value: new THREE.Matrix4() },
    uWet: { value: 0 },
    uReflLod: { value: 1.5 },
  };
  const target = new THREE.WebGLRenderTarget(16, 16, {
    type: THREE.HalfFloatType, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true, depthBuffer: true,
  });
  const dryRoughness = roadMat.roughness;

  roadMat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform mat4 uReflMatrix;\nvarying vec4 vReflUv;\nvarying vec3 vReflWorld;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vec4 rfWorld = modelMatrix * vec4(transformed, 1.0);\n  vReflWorld = rfWorld.xyz;\n  vReflUv = uReflMatrix * rfWorld;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform sampler2D tRefl;\nuniform float uWet, uReflLod;\nvarying vec4 vReflUv;\nvarying vec3 vReflWorld;\n${NOISE}`)
      .replace('#include <opaque_fragment>', `
  if (uWet > 0.001) {
    // 積水遮罩：大尺度的雜訊決定哪裡比較濕，小尺度的雜訊把反射打散
    float wetMask = rfNoise(vReflWorld.xz * 0.11) * 0.65 + rfNoise(vReflWorld.xz * 0.37) * 0.35;
    float wet = uWet * mix(0.3, 1.0, smoothstep(0.35, 0.7, wetMask));
    vec2 jit = vec2(rfNoise(vReflWorld.xz * 2.3), rfNoise(vReflWorld.zx * 2.9 + 7.0)) - 0.5;
    vec2 ruv = vReflUv.xy / max(vReflUv.w, 1e-4) + jit * vec2(0.006, 0.02);
    // 沿畫面上下拉長取樣：濕柏油上的燈光倒影是長條的
    vec3 refl = textureLod(tRefl, ruv, uReflLod).rgb * 0.5;
    refl += textureLod(tRefl, ruv + vec2(0.0, 0.012), uReflLod + 0.5).rgb * 0.18;
    refl += textureLod(tRefl, ruv - vec2(0.0, 0.012), uReflLod + 0.5).rgb * 0.18;
    refl += textureLod(tRefl, ruv + vec2(0.0, 0.03), uReflLod + 1.0).rgb * 0.07;
    refl += textureLod(tRefl, ruv - vec2(0.0, 0.03), uReflLod + 1.0).rgb * 0.07;
    float cosV = clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0);
    float fres = 0.03 + 0.55 * pow(1.0 - cosV, 5.0);
    outgoingLight = outgoingLight * (1.0 - 0.3 * wet) + min(refl, vec3(30.0)) * fres * wet;
  }
  #include <opaque_fragment>`);
  };
  roadMat.customProgramCacheKey = () => 'wet-road-1';
  roadMat.needsUpdate = true;

  const cam = new THREE.PerspectiveCamera();
  cam.matrixAutoUpdate = false;
  const BIAS = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  const camPos = new THREE.Vector3(), tgt = new THREE.Vector3(), up = new THREE.Vector3(), rot = new THREE.Matrix4();
  const plane = new THREE.Plane(), clip = new THREE.Vector4(), q = new THREE.Vector4(), size = new THREE.Vector2(), tmp = new THREE.Vector3();
  const reflectPoint = (v, n, p0) => { const d = tmp.copy(v).sub(p0).dot(n); return v.addScaledVector(n, -2 * d); };
  const reflectDir = (v, n) => v.addScaledVector(n, -2 * v.dot(n));

  const api = {
    target, uniforms,
    enabled: true,
    wetness: 0.7,
    /** p0：路面上的一點（玩家腳下）；n：路面法線 */
    render(scene, camera, p0, n) {
      if (!api.enabled || api.wetness <= 0) {
        uniforms.uWet.value = 0; uniforms.tRefl.value = null; roadMat.roughness = dryRoughness;
        return;
      }
      camPos.setFromMatrixPosition(camera.matrixWorld);
      if (tmp.copy(camPos).sub(p0).dot(n) < 0.05) { uniforms.uWet.value = 0; uniforms.tRefl.value = null; return; }
      renderer.getDrawingBufferSize(size);
      const w = Math.max(64, Math.round(size.x / 2)), h = Math.max(64, Math.round(size.y / 2));
      if (target.width !== w || target.height !== h) target.setSize(w, h);

      // 鏡射攝影機：位置、視線目標、上方向都對路面鏡射
      rot.extractRotation(camera.matrixWorld);
      tgt.set(0, 0, -1).applyMatrix4(rot).add(camPos);
      up.set(0, 1, 0).applyMatrix4(rot);
      reflectPoint(camPos, n, p0); reflectPoint(tgt, n, p0); reflectDir(up, n);
      cam.position.copy(camPos); cam.up.copy(up); cam.lookAt(tgt);
      cam.updateMatrix(); cam.updateMatrixWorld(true);
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
      cam.projectionMatrix.copy(camera.projectionMatrix);
      uniforms.uReflMatrix.value.copy(BIAS).multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);

      // 斜的近平面：貼著路面（往上抬 12 cm，路面上的標線與光池貼片不會畫進去）
      plane.setFromNormalAndCoplanarPoint(n, tmp.copy(p0).addScaledVector(n, 0.12));
      plane.applyMatrix4(cam.matrixWorldInverse);
      clip.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
      const e = cam.projectionMatrix.elements;
      q.set((Math.sign(clip.x) + e[8]) / e[0], (Math.sign(clip.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
      clip.multiplyScalar(2 / clip.dot(q));
      e[2] = clip.x; e[6] = clip.y; e[10] = clip.z + 1; e[14] = clip.w;
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();

      // 畫反射時路面材質不能取樣正在寫入的那張圖
      uniforms.tRefl.value = null; uniforms.uWet.value = 0;
      renderer.setRenderTarget(target);
      renderer.render(scene, cam);
      renderer.setRenderTarget(null);
      uniforms.tRefl.value = target.texture;
      uniforms.uWet.value = api.wetness;
      uniforms.uReflLod.value = Math.max(0, Math.log2(h / 220));
      roadMat.roughness = Math.min(dryRoughness, 0.55);
    },
  };
  return api;
}
