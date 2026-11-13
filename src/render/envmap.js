import * as THREE from 'three';

// 車漆用的夜景環境貼圖：程序生成一個「深夜高架」的天球（暗的天空、地平線的城市光害、
// 一圈零星的窗燈、頭頂兩排鈉燈），再用 PMREM 預先模糊成各種粗糙度可用的環境貼圖。
// 只生成一次；車身上會動的高光來自最近 4 盞真的路燈光源。
export function createNightEnv(renderer) {
  const scene = new THREE.Scene();
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(50, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        varying vec3 vDir;
        float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
        void main(){
          vec3 d = normalize(vDir);
          float h = d.y;
          // 天空與地平線的光害
          vec3 c = mix(vec3(0.020, 0.028, 0.05), vec3(0.004, 0.006, 0.014), smoothstep(0.0, 0.6, h));
          c += vec3(0.5, 0.26, 0.12) * exp(-abs(h) * 7.0) * 0.5;
          // 一圈大樓的窗燈
          float az = atan(d.z, d.x);
          vec2 cell = vec2(floor(az * 60.0), floor(h * 90.0));
          float lit = step(0.72, hash(cell)) * step(0.0, h) * step(h, 0.12 + 0.2 * hash(vec2(floor(az * 9.0), 3.0)));
          c += mix(vec3(1.0, 0.8, 0.5), vec3(0.6, 0.8, 1.0), hash(cell + 9.0)) * lit * 1.6;
          // 頭頂兩排鈉燈：沿前後方向每隔一段一顆
          if (h > 0.25) {
            vec2 p = d.xz / max(d.y, 0.05);
            float row = min(abs(p.x - 0.55), abs(p.x + 0.55));
            float along = abs(fract(p.y * 0.35) - 0.5);
            c += vec3(1.0, 0.56, 0.2) * 26.0 * smoothstep(0.09, 0.03, row) * smoothstep(0.16, 0.08, along);
          }
          // 路面：暗、略帶暖色
          if (h < 0.0) c = mix(vec3(0.05, 0.035, 0.025), vec3(0.012, 0.012, 0.014), smoothstep(0.0, -0.5, h));
          gl_FragColor = vec4(c, 1.0);
        }`,
    }),
  );
  scene.add(sky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0, 0.1, 100);
  pmrem.dispose();
  sky.geometry.dispose(); sky.material.dispose();
  return rt.texture;
}
