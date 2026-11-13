import * as THREE from 'three';

// 自寫的後處理鏈（不用 EffectComposer）：
//   場景 → HDR（半浮點）render target → 逐級縮小再放大的 mip bloom → AgX 色調映射 → 調色、暗角、抖色 → 螢幕
// 低畫質或裝置不支援浮點 render target 時整條關掉，退回直接畫到螢幕（renderer 內建的 ACES）。

const VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

// 縮小：13 個取樣的寬核心；第一級用亮度加權平均壓掉單一像素的極亮點（不然會閃）
const DOWN = `
varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uFirst;
vec3 tap(float x, float y){ return clamp(texture2D(tSrc, vUv + vec2(x, y) * uTexel).rgb, 0.0, 300.0); }
float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float kw(vec3 c){ return 1.0 / (1.0 + lum(c) * 0.1); }
void main(){
  vec3 o0 = tap(-2.0, 2.0), o1 = tap(0.0, 2.0), o2 = tap(2.0, 2.0);
  vec3 o3 = tap(-2.0, 0.0), ce = tap(0.0, 0.0), o4 = tap(2.0, 0.0);
  vec3 o5 = tap(-2.0, -2.0), o6 = tap(0.0, -2.0), o7 = tap(2.0, -2.0);
  vec3 i0 = tap(-1.0, 1.0), i1 = tap(1.0, 1.0), i2 = tap(-1.0, -1.0), i3 = tap(1.0, -1.0);
  vec3 c;
  if (uFirst > 0.5) {
    vec3 q0 = (o0 + o1 + o3 + ce) * 0.25, q1 = (o1 + o2 + ce + o4) * 0.25;
    vec3 q2 = (o3 + ce + o5 + o6) * 0.25, q3 = (ce + o4 + o6 + o7) * 0.25, q4 = (i0 + i1 + i2 + i3) * 0.25;
    float w0 = kw(q0) * 0.125, w1 = kw(q1) * 0.125, w2 = kw(q2) * 0.125, w3 = kw(q3) * 0.125, w4 = kw(q4) * 0.5;
    c = (q0 * w0 + q1 * w1 + q2 * w2 + q3 * w3 + q4 * w4) / (w0 + w1 + w2 + w3 + w4);
  } else {
    c = ce * 0.125 + (o0 + o2 + o5 + o7) * 0.03125 + (o1 + o3 + o4 + o6) * 0.0625 + (i0 + i1 + i2 + i3) * 0.125;
  }
  gl_FragColor = vec4(c, 1.0);
}`;

// 放大：3×3 帳篷濾波放大較小的一級，再和同尺寸的那一級混合
const UP = `
varying vec2 vUv; uniform sampler2D tLow; uniform sampler2D tHigh; uniform vec2 uTexel; uniform float uMix;
void main(){
  vec2 d = uTexel;
  vec3 s = texture2D(tLow, vUv).rgb * 4.0;
  s += (texture2D(tLow, vUv + vec2(d.x, 0.0)).rgb + texture2D(tLow, vUv - vec2(d.x, 0.0)).rgb
      + texture2D(tLow, vUv + vec2(0.0, d.y)).rgb + texture2D(tLow, vUv - vec2(0.0, d.y)).rgb) * 2.0;
  s += texture2D(tLow, vUv + d).rgb + texture2D(tLow, vUv - d).rgb
     + texture2D(tLow, vUv + vec2(d.x, -d.y)).rgb + texture2D(tLow, vUv + vec2(-d.x, d.y)).rgb;
  gl_FragColor = vec4(mix(texture2D(tHigh, vUv).rgb, s / 16.0, uMix), 1.0);
}`;

// 合成：bloom、曝光、AgX、調色（暗部偏青、亮部偏暖）、暗角、抖色、轉 sRGB
const FINAL = `
varying vec2 vUv;
uniform sampler2D tScene; uniform sampler2D tBloom;
uniform float uBloom, uExposure, uVignette, uAspect, uContrast, uSaturation, uGrade, uTime, uSpeed;
uniform vec2 uCenter;
float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// AgX：先壓進較窄的色域、取對數、套 S 曲線，再展開回來；極亮的顏色會自然褪成白色而不是過飽和
const mat3 TO_2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
const mat3 FROM_2020 = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
const mat3 AGX_IN = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995), vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
const mat3 AGX_OUT = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826), vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
vec3 agxCurve(vec3 x){ vec3 x2 = x * x, x4 = x2 * x2; return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232; }
vec3 agx(vec3 c){
  c = AGX_IN * (TO_2020 * c);
  c = clamp((log2(max(c, 1e-10)) + 12.47393) / 16.5, 0.0, 1.0);
  c = agxCurve(c);
  float l = lum(c);
  c = pow(max(c, 0.0), vec3(uContrast));
  c = l + (c - l) * uSaturation;
  c = AGX_OUT * c;
  c = pow(max(c, 0.0), vec3(2.2));
  return clamp(FROM_2020 * c, 0.0, 1.0);
}
vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(max(c, 0.0), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main(){
  vec3 col = texture2D(tScene, vUv).rgb;
  // 速度模糊：從消失點往外拉的徑向模糊，畫面中央（車子所在）不模糊，愈靠邊愈強
  if (uSpeed > 0.001) {
    vec2 dir = vUv - uCenter;
    float rr = length(dir * vec2(uAspect, 1.0));
    float amt = uSpeed * smoothstep(0.16, 0.75, rr) * 0.085;
    if (amt > 0.0005) {
      float j = ign(gl_FragCoord.xy) - 0.5;
      vec3 acc = col; float ws = 1.0;
      for (int i = 1; i <= 7; i++) {
        float t = (float(i) + j) / 7.0;
        acc += texture2D(tScene, vUv - dir * amt * t).rgb * (1.0 - t * 0.5); ws += 1.0 - t * 0.5;
      }
      col = acc / ws;
    }
  }
  vec3 bloom = texture2D(tBloom, vUv).rgb;
  col = mix(col, bloom, uBloom);
  col = agx(col * uExposure);
  float l = lum(col);
  col *= mix(vec3(1.0), mix(vec3(0.86, 1.0, 1.12), vec3(1.06, 1.0, 0.92), smoothstep(0.03, 0.6, l)), uGrade);
  col = mix(col, col * col * (3.0 - 2.0 * col), 0.18 * uGrade);
  vec2 c = (vUv - 0.5) * vec2(uAspect, 1.0);
  float r2 = dot(c, c) / (0.25 * (uAspect * uAspect + 1.0));
  col *= 1.0 - uVignette * smoothstep(0.2, 1.05, r2);
  col = toSRGB(col);
  col += (ign(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5) / 255.0 * 1.5;   // 抖色：夜空的漸層才不會出現色階
  gl_FragColor = vec4(col, 1.0);
}`;

const LEVELS = 6;

export function createPost(renderer) {
  let supported = false;
  try { supported = renderer.capabilities.isWebGL2 !== false && (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float')); } catch { supported = false; }

  const params = { bloom: 0.14, bloomMix: 0.62, exposure: 1.7, vignette: 0.34, contrast: 1.16, saturation: 1.22, grade: 1 };
  const rt = (opts) => new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, ...opts });
  let sceneRT = null;
  const down = [], up = [];
  const quadScene = new THREE.Scene();
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  // 一個蓋滿畫面的大三角形
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const quad = new THREE.Mesh(tri, null);
  quad.frustumCulled = false;
  quadScene.add(quad);
  const mat = (frag, uniforms) => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, toneMapped: false });
  const downMat = mat(DOWN, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 0 } });
  const upMat = mat(UP, { tLow: { value: null }, tHigh: { value: null }, uTexel: { value: new THREE.Vector2() }, uMix: { value: 0.6 } });
  const finalMat = mat(FINAL, {
    tScene: { value: null }, tBloom: { value: null }, uBloom: { value: 0 }, uExposure: { value: 1 }, uVignette: { value: 0 },
    uAspect: { value: 1 }, uContrast: { value: 1 }, uSaturation: { value: 1 }, uGrade: { value: 1 }, uTime: { value: 0 }, uSpeed: { value: 0 }, uCenter: { value: new THREE.Vector2(0.5, 0.56) },
  });

  let W = 0, H = 0, time = 0;
  const size = new THREE.Vector2();
  function ensure() {
    renderer.getDrawingBufferSize(size);
    if (size.x === W && size.y === H && sceneRT) return;
    W = size.x; H = size.y;
    if (!sceneRT) {
      sceneRT = rt({ depthBuffer: true, samples: 4 });
      for (let i = 0; i < LEVELS; i++) down.push(rt());
      for (let i = 0; i < LEVELS - 1; i++) up.push(rt());
    }
    sceneRT.setSize(W, H);
    let w = W, h = H;
    for (let i = 0; i < LEVELS; i++) {
      w = Math.max(2, Math.ceil(w / 2)); h = Math.max(2, Math.ceil(h / 2));
      down[i].setSize(w, h);
      if (i < LEVELS - 1) up[i].setSize(w, h);
    }
  }
  function pass(material, target) {
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(quadScene, quadCam);
  }

  const api = {
    params,
    supported,
    enabled: supported,
    /** 速度模糊：speed 0–1 由外面每幀設定；blur = false 可單獨關掉 */
    speed: 0, blur: true,
    get active() { return api.enabled && supported; },
    /** 目前場景的 HDR 畫面（之後的反射、模糊會用到） */
    get sceneTexture() { return sceneRT ? sceneRT.texture : null; },
    render(scene, camera, dt = 0) {
      if (!api.active) {
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
        return;
      }
      ensure();
      time += dt;
      renderer.setRenderTarget(sceneRT);
      renderer.render(scene, camera);
      // 逐級縮小
      for (let i = 0; i < LEVELS; i++) {
        const src = i === 0 ? sceneRT : down[i - 1];
        downMat.uniforms.tSrc.value = src.texture;
        downMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
        downMat.uniforms.uFirst.value = i === 0 ? 1 : 0;
        pass(downMat, down[i]);
      }
      // 逐級放大並混合
      upMat.uniforms.uMix.value = params.bloomMix;
      for (let i = LEVELS - 2; i >= 0; i--) {
        const low = i === LEVELS - 2 ? down[LEVELS - 1] : up[i + 1];
        upMat.uniforms.tLow.value = low.texture;
        upMat.uniforms.tHigh.value = down[i].texture;
        upMat.uniforms.uTexel.value.set(1 / low.width, 1 / low.height);
        pass(upMat, up[i]);
      }
      const u = finalMat.uniforms;
      u.tScene.value = sceneRT.texture; u.tBloom.value = up[0].texture;
      u.uBloom.value = params.bloom; u.uExposure.value = params.exposure; u.uVignette.value = params.vignette;
      u.uContrast.value = params.contrast; u.uSaturation.value = params.saturation; u.uGrade.value = params.grade;
      u.uAspect.value = W / H; u.uTime.value = time;
      u.uSpeed.value = api.blur ? api.speed : 0;
      pass(finalMat, null);
    },
  };
  return api;
}
