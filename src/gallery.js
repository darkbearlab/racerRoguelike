// 車型展示頁（開發用）：把 config/models.json 的所有車排出來檢查造型。開 /gallery.html
import * as THREE from 'three';
import models from './config/models.json';
import rivals from './config/rivals.json';
import trafficCfg from './config/traffic.json';
import { buildCar } from './render/carBuilder.js';

const view = new URLSearchParams(location.search).get('view') || 'quarter';
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x20242c);
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x30343c, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(-3, 6, 4);
scene.add(sun);

const colorOf = {};
for (const r of rivals.list) colorOf[r.model] = r.color;
colorOf.coupe = '#1d4fd0';
for (const t of Object.values(trafficCfg.types)) if (t.color) colorOf[t.model] = t.color;
const only = new URLSearchParams(location.search).get('only');
const names = Object.keys(models).filter((k) => !k.startsWith('_') && (!only || only.split(',').includes(k)));
const mat = (c) => new THREE.MeshStandardMaterial({ color: c, vertexColors: true, flatShading: true, roughness: 0.4, metalness: 0.4, side: THREE.DoubleSide });
const yaw = { quarter: -0.62, side: -Math.PI / 2, front: 0, rear: Math.PI }[view] ?? -0.62;

// 每台車一格，格子在畫面上排成網格（往下排的是 y，不是 z，才不會互相擋住）
const COLS = innerWidth < innerHeight ? 3 : 6, DX = 6.2, DY = 3.3; // 直式視窗排三欄
const items = [];
names.forEach((name, i) => {
  const spec = models[name];
  const built = buildCar(spec, { wheels: true });
  const g = new THREE.Group();
  g.add(new THREE.Mesh(built.geometry, mat(colorOf[name] || '#9aa2ac')));
  const box = new THREE.BoxGeometry(1, 1, 1);
  for (const [list, c] of [[built.head, 0xfff4d8], [built.tail, 0xff2a18]]) {
    for (const b of list) {
      const m = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ color: c }));
      m.scale.set(b.w, b.h, b.d); m.position.set(b.x, b.y, b.z);
      g.add(m);
    }
  }
  const scale = spec.L > 8 ? 0.5 : 1; // 貨車縮小才排得下
  g.scale.setScalar(scale);
  g.rotation.y = yaw;
  if (view === 'quarter') { const tilt = new THREE.Group(); tilt.rotation.x = 0.32; tilt.add(g); scene.add(tilt); g.userData.holder = tilt; }
  const col = i % COLS, row = Math.floor(i / COLS);
  (g.userData.holder || g).position.set((col - (COLS - 1) / 2) * DX, -row * DY, 0);
  if (!g.userData.holder) scene.add(g);
  items.push({ g, name, spec, row });
});
const rows = Math.ceil(names.length / COLS);


// 正交攝影機，從前上方斜看整個陣列
const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
const center = new THREE.Vector3(0, 0.5 - ((rows - 1) * DY) / 2, 0);
cam.position.copy(center).add(new THREE.Vector3(0, 0, 40));
cam.lookAt(center);

const labels = document.getElementById('labels');
const els = items.map((it) => { const d = document.createElement('div'); labels.appendChild(d); return d; });
const v = new THREE.Vector3();
function layout() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  const needW = (COLS * DX) / 2 + 0.3, needH = (rows * DY) / 2 + 0.5;
  const halfH = Math.max(needH, needW * (h / w));
  cam.left = -halfH * (w / h); cam.right = halfH * (w / h); cam.top = halfH; cam.bottom = -halfH;
  cam.updateProjectionMatrix();
  renderer.render(scene, cam);
  items.forEach((it, i) => {
    v.copy((it.g.userData.holder || it.g).position); v.y -= 0.5; v.project(cam);
    els[i].style.left = `${(v.x * 0.5 + 0.5) * w}px`;
    els[i].style.top = `${(-v.y * 0.5 + 0.5) * h + 2}px`;
    els[i].innerHTML = `<b>${it.spec.label || it.name}</b><br>${it.spec.L} × ${it.spec.W} × ${it.spec.H} m`;
  });
}
addEventListener('resize', layout);
layout();
window.__gallery = { layout, items };
