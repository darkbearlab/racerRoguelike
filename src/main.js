import * as THREE from 'three';
import carsJson from './config/cars.json';
import zonesJson from './config/zones.json';
import trafficJson from './config/traffic.json';
import cameraJson from './config/camera.json';
import duelJson from './config/duel.json';
import rivalsJson from './config/rivals.json';
import runJson from './config/run.json';
import upgradesJson from './config/upgrades.json';
import modelsJson from './config/models.json';
import { createRng } from './core/rng.js';
import { createEvents } from './core/events.js';
import { createLoop } from './core/time.js';
import { createInput } from './core/input.js';
import { makeFrame } from './road/spline.js';
import { createStreamer } from './road/streamer.js';
import { autopilot, createAiMemory } from './vehicle/ai.js';
import { createSession } from './race/session.js';
import { NODE_TYPES } from './race/nodes.js';
import { createScene } from './render/scene.js';
import { createPost } from './render/post.js';
import { createTrails } from './render/trails.js';
import { createReflection } from './render/reflection.js';
import { createNightEnv } from './render/envmap.js';
import { createCarModel } from './render/models.js';
import { createTrafficMesh } from './render/trafficMesh.js';
import { createSparks } from './render/sparks.js';
import { createCameraRig, VIEW_NAMES } from './camera/cameraRig.js';
import { createHud, virtualRpm } from './ui/hud.js';
import { createChoiceUi } from './ui/choice.js';
import { createGameAudio } from './audio/gameAudio.js';

const params = new URLSearchParams(location.search);
const DEBUG = params.get('debug') === '1';
const AUTOPILOT = params.get('autopilot') === '1';
const seed = Number(params.get('seed')) || 20261112;

// 設定物件原地更新，改 JSON 存檔後由 Vite 熱更新直接生效
const carCfg = { ...carsJson.player };
const camCfg = structuredClone(cameraJson);
const trafficCfg = structuredClone(trafficJson);
const duelCfg = structuredClone(duelJson);
const rivals = structuredClone(rivalsJson.list);
const runCfg = structuredClone(runJson);
const upgradeCfg = structuredClone(upgradesJson);
const zone = zonesJson.default;

const events = createEvents();
const input = createInput();
const hud = createHud(DEBUG);
// 事件要在建立 session 之前掛好：開局就會插入第一個交流道
const boot = [];
events.on('jctPlaced', (e) => boot.push(e));
const session = createSession({ seed, carCfg, zone, zones: zonesJson, trafficCfg, duelCfg, rivals, runCfg, upgradeCfg, events });
const { road, traffic, state, rival, duel, clock, flow, playerCfg, upgrades, menus } = session;
const choiceUi = createChoiceUi();
const audio = createGameAudio({ events, state, traffic, rival });
const prev = session.prev;
const fxRng = createRng(seed ^ 0x1234567);

const canvas = document.getElementById('game');
const { renderer, scene, sky, resize, setDaylight, setMood } = createScene(canvas);
const post = createPost(renderer);
// 畫質：high = HDR 後處理全開；low = 直接畫到螢幕。網址加 ?gfx=low 可強制低畫質
const gfx = { quality: params.get('gfx') === 'low' ? 'low' : 'high', wet: params.get('wet') !== '0', blur: params.get('blur') !== '0' };
const streamer = createStreamer(scene, road, renderer, seed);
let trafficMesh = null, car = null, rivalCar = null, nightEnv = null;
const reflection = createReflection(renderer, streamer.roadMaterial);
const trails = createTrails(scene, trafficCfg.maxCars * 2 + 4);
const TRAIL_PLAYER = trafficCfg.maxCars * 2, TRAIL_RIVAL = TRAIL_PLAYER + 2;
const applyGfx = () => {
  const hi = gfx.quality !== 'low';
  post.enabled = hi;
  streamer.setHdr(post.active); setMood(post.active); trafficMesh?.setHdr(post.active);
  car?.setHdr(post.active); rivalCar?.setHdr(post.active);
  trails.enabled = hi; trails.setHdr(post.active);
  reflection.enabled = post.active && gfx.wet;
  post.blur = gfx.blur;
  // 車漆倒影：第一次開高畫質時才生成環境貼圖
  if (hi && !nightEnv) nightEnv = createNightEnv(renderer);
  const env = hi ? nightEnv : null;
  for (const o of [car, rivalCar, trafficMesh]) if (o && o.glossEnv !== env) { o.glossEnv = env; o.setGloss(env); }
};
/** 一台車的兩顆尾燈各留一條光軌 */
const v3t = new THREE.Vector3();
function feedTrails(id, model, p, l, u, f, kmh, braking, gain = 1) {
  const d = model.dims, a = Math.min(1, Math.max(0, (kmh - 50) / 60)) * (braking ? 1 : 0.6);
  for (let k = 0; k < 2; k++) {
    v3t.copy(p).addScaledVector(l, (k === 0 ? 1 : -1) * d.W * 0.3).addScaledVector(u, d.tailY).addScaledVector(f, -d.L / 2 - 0.03);
    trails.feed(id + k, v3t.x, v3t.y, v3t.z, l.x * 0.07, l.y * 0.07, l.z * 0.07, a * gain);
  }
}
car = createCarModel({ spec: modelsJson[carCfg.model] || modelsJson.coupe });
scene.add(car.group);
rivalCar = createCarModel({ player: false, color: 0x888888, spec: modelsJson.hatch });
rivalCar.setView('chase');
rivalCar.group.visible = false;
rivalCar.group.matrixAutoUpdate = false;
scene.add(rivalCar.group);
trafficMesh = createTrafficMesh(scene, road, traffic, trafficCfg, modelsJson);
trafficMesh.setTrails(trails);
applyGfx();
const sparks = createSparks(scene);
const rig = createCameraRig(camCfg);
car.setView(rig.view);

// 後視鏡：第二台攝影機以低解析度畫到 render target
const mirrorRT = new THREE.WebGLRenderTarget(256, 64);
const mirrorCam = new THREE.PerspectiveCamera(32, 4, 0.5, 900);
car.mirror.material.map = mirrorRT.texture;

addEventListener('resize', () => resize(rig.camera));
resize(rig.camera);

// ── 狀態
const aiInput = {};
const aiMem = createAiMemory();
let paused = false;
let flash = 0;
const placeSigns = (e) => streamer.onJunction(session.alt, e.cutS, e.forkS, NODE_TYPES[e.options[0]], NODE_TYPES[e.options[1]]);
boot.forEach(placeSigns);
events.on('jctPlaced', placeSigns);
events.on('forkSwap', (e) => streamer.onSwap(e.forkS));
events.on('altCleared', () => streamer.onAltCleared());
events.on('forkChosen', (e) => hud.toast(`${NODE_TYPES[e.node].icon} ${NODE_TYPES[e.node].name}`, 2.2));
events.on('pa', (e) => hud.toast(`⛽ PA 休息站　−${e.minutes} 分鐘`, 2.2));
events.on('upgradeGained', (e) => hud.toast(`獲得成長：${e.def.name}`, 2));
events.on('upgradeRemoved', (e) => hud.toast(`移除成長：${e.def.name}`, 2));
events.on('menuSkipped', (e) => hud.toast(e.empty ? `沒有成長可拿了　賞金 +${e.bounty}` : `未選擇　賞金 +${e.bounty}`, 2));
events.on('hookFired', (e) => { if (e.hook === 'onOvertaken') hud.toast('賭徒：被超車 −5 分鐘', 1.8); });
events.on('runOver', (e) => {
  const win = e.reason === 'victory';
  hud.over([
    ['到達', win ? '通關' : `第 ${session.run.night} 晚　${session.zoneName}`],
    ['用時', `${Math.floor(session.realTime / 60)} 分 ${Math.floor(session.realTime % 60)} 秒`],
    ['擊敗', `${session.run.defeats} 人`],
    ['落敗', `${session.run.losses} 次`],
    ['賞金', String(session.run.bounty)],
    ['最高速度', `${Math.round(session.run.topKmh)} km/h`],
    ['行駛距離', `${(state.dist / 1000).toFixed(1)} km`],
    ['持有成長', upgrades.list().map((it) => it.def.name + (it.count > 1 ? ` ×${it.count}` : '')).join('、') || '—'],
  ], win ? '三晚的 Boss 全數擊敗' : 'Boss 尚未擊敗，這一局結束', win ? '通關' : '天亮了');
});
addEventListener('keydown', (e) => { if (e.code === 'KeyR' && session.over) location.reload(); });
streamer.update(state.s, null, true);

const pendingSparks = [];
events.on('wallHit', (e) => {
  rig.addTrauma(Math.min(1, e.speedLoss / 14) + 0.15);
  pendingSparks.push({ side: e.side, n: 10 + Math.round(e.sinA * 26) });
});
events.on('carHit', (e) => {
  rig.addTrauma(Math.min(1, e.speedLoss / 18) + 0.25);
  pendingSparks.push({ side: e.longitudinal ? 0 : e.side, n: 18 });
});
events.on('rivalMarked', (e) => {
  rivalCar.setSpec(modelsJson[e.def.model] || modelsJson.hatch, e.def.color);
  rivalCar.marker.material.color.setRGB(3.2, 0.5, 0.25);
  hud.toast(`對手出現：${e.def.name}`, 2.2);
});
events.on('bossIntro', (e) => {
  rivalCar.setSpec(modelsJson[e.def.model] || modelsJson.gt, e.def.color);
  rivalCar.marker.material.color.setRGB(3.4, 2.4, 0.3); // Boss 的標記是金色
  hud.bossCard(e.def, e.def.radio?.intro);
});
events.on('duelApplied', (e) => {
  if (e.def.tier === 'boss') setTimeout(() => hud.bossCard(e.def, e.win ? e.def.radio?.lose : e.def.radio?.win, 3.5), 2000);
});
events.on('nightStart', (e) => hud.night(e.night, e.zone.name));
events.on('shortcutDone', (e) => hud.toast(`↪ 捷徑完成　退回 ${e.minutes} 分鐘`, 2.4));
events.on('eventStart', (e) => hud.toast(e.kind === 'jam' ? '❓ 前方塞車　穿過去有賞金' : e.kind === 'police' ? `❓ 前方警察盤查　限速 ${e.limit} km/h` : '❓ 有輛來路不明的車…', 3));
events.on('eventResult', (e) => hud.toast(
  e.kind === 'jam' ? `穿過塞車　賞金 +${e.bounty}`
    : e.ok ? `通過盤查　賞金 +${e.bounty}` : `超速 ${Math.round(e.kmh)} km/h　−${e.minutes} 分鐘`, 2.6));
events.on('rivalSkipped', () => hud.toast('對手離開了', 1.8));
let approachMem = 0;
events.on('duelCountdown', (e) => hud.countdown(String(e.count)));
events.on('duelGo', () => hud.countdown('BATTLE'));
events.on('duelZero', (e) => {
  hud.zero(e.who);
  if (e.who === 'player' && e.lost > 1) hud.toast(`被超車　分數歸零 −${Math.round(e.lost)}`, 1.6);
  else if (e.who === 'rival' && e.lost > 1) hud.toast('超車　對手分數歸零', 1.6);
});
events.on('duelEnd', (e) => {
  const tier = rival.def?.tier || 'normal';
  hud.banner(e.win, e.reason, e.win ? `賞金 +${duelCfg.bountyByTier?.[tier] ?? duelCfg.bounty}` : `−${duelCfg.loseMinutesByTier?.[tier] ?? duelCfg.loseMinutes} 分鐘`);
});

// 自動駕駛選路：優先選對決節點
function autoOpts() {
  const z = road.zoneAt(state.s + 150), z0 = road.zoneAt(state.s);
  const approaching = !flow.chosen && (z === 1 || z === 2 || z0 === 1 || z0 === 2);
  let preferD = null;
  if (approaching && flow.options) {
    const duelL = !!NODE_TYPES[flow.options[0]].tier, duelR = !!NODE_TYPES[flow.options[1]].tier;
    if (!approachMem) approachMem = duelL && !duelR ? -1 : duelR && !duelL ? 1 : (session.run.forks % 2 ? -1 : 1);
    preferD = approachMem * 4.6;
  } else approachMem = 0;
  return { traffic: session.obsForPlayer, mem: aiMem, dt: 1 / 60, line: !approaching, caution: 0.85, margin: 1.25, preferD };
}
const playerInput = () => (AUTOPILOT ? autopilot(state, playerCfg, road, autoOpts(), aiInput) : input.held);

// 自動駕駛時也自動操作選單：三選一拿第一張；商店買得起就買，然後離開
function autoMenu() {
  const m = menus.current;
  if (!m || m.lock > 0) return;
  if (m.kind === 'choice') { menus.input('left'); return; }
  const i = m.stock.findIndex((it) => !it.sold && session.run.bounty >= it.price && upgrades.canTake(it.def));
  if (i < 0) { menus.input('down'); return; }
  if (m.cursor !== i) menus.input('right'); else menus.input('up');
}

// ── 標題畫面：按開始之前世界靜止，鏡頭繞著車子轉
let started = AUTOPILOT;
let titleTime = 0;
const btnStart = document.getElementById('btnStart'), btnSettings = document.getElementById('btnSettings'), settingsEl = document.getElementById('settings');
const optMirror = document.getElementById('optMirror'), optRubber = document.getElementById('optRubber'), optGfx = document.getElementById('optGfx'), optWet = document.getElementById('optWet'), optBlur = document.getElementById('optBlur'), optVol = document.getElementById('optVol'), optMusic = document.getElementById('optMusic');
try {
  const saved = JSON.parse(localStorage.getItem('settings') || '{}');
  if (typeof saved.mirror === 'boolean') camCfg.mirror = saved.mirror;
  if (typeof saved.rubber === 'boolean') duelCfg.rubberBand.enabled = saved.rubber;
  if (saved.gfx === 'low' && !params.get('gfx')) gfx.quality = 'low';
  if (saved.wet === false && !params.get('wet')) gfx.wet = false;
  if (saved.blur === false && !params.get('blur')) gfx.blur = false;
  if (typeof saved.vol === 'number') audio.volume = saved.vol;
  if (typeof saved.music === 'number') audio.musicVolume = saved.music;
} catch { /* 讀不到就用預設值 */ }
optMirror.checked = !!camCfg.mirror;
optRubber.checked = !!duelCfg.rubberBand.enabled;
optGfx.checked = gfx.quality !== 'low';
optWet.checked = gfx.wet;
optBlur.checked = gfx.blur;
optVol.value = String(Math.round(audio.volume * 100));
optMusic.value = String(Math.round(audio.musicVolume * 100));
applyGfx();
const saveSettings = () => {
  camCfg.mirror = optMirror.checked;
  duelCfg.rubberBand.enabled = optRubber.checked;
  gfx.quality = optGfx.checked ? 'high' : 'low';
  gfx.wet = optWet.checked;
  gfx.blur = optBlur.checked;
  audio.volume = Number(optVol.value) / 100;
  audio.musicVolume = Number(optMusic.value) / 100;
  applyGfx();
  try { localStorage.setItem('settings', JSON.stringify({ mirror: camCfg.mirror, rubber: duelCfg.rubberBand.enabled, gfx: gfx.quality, wet: gfx.wet, blur: gfx.blur, vol: audio.volume, music: audio.musicVolume })); } catch { /* 存不了就算了 */ }
};
optMirror.addEventListener('change', saveSettings);
optRubber.addEventListener('change', saveSettings);
optGfx.addEventListener('change', saveSettings);
optWet.addEventListener('change', saveSettings);
optBlur.addEventListener('change', saveSettings);
optVol.addEventListener('input', saveSettings);
optMusic.addEventListener('input', saveSettings);
function startRun() {
  if (started) return;
  started = true;
  audio.start();
  hud.title(false);
  rig.setView('chase');
  hud.night(1, session.zoneName, 2.2);
}
btnStart.addEventListener('click', startRun);
btnSettings.addEventListener('click', () => settingsEl.classList.toggle('on'));
addEventListener('keydown', (e) => {
  if (started) return;
  if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); startRun(); }
  else if (e.code === 'Tab') { e.preventDefault(); settingsEl.classList.toggle('on'); }
});
hud.title(!started);

function step(dt) {
  if (paused || !started) return;
  if (AUTOPILOT) autoMenu();
  session.step(dt, playerInput());
}

// ── 姿態：道路座標 → 世界座標
const fr = makeFrame();
const newPose = () => ({ p: new THREE.Vector3(), f: new THREE.Vector3(), u: new THREE.Vector3(), l: new THREE.Vector3() });
const pose = newPose(), rPose = newPose();
const T = new THREE.Vector3(), R = new THREE.Vector3();
const basis = new THREE.Matrix4();
const v3 = new THREE.Vector3(), v3b = new THREE.Vector3();
const lerpAngle = (a, b, t) => {
  let d = b - a;
  if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

function computePose(s, d, psi, out, rd = road) {
  rd.frame(s, fr);
  T.fromArray(fr.t); R.fromArray(fr.r);
  out.u.fromArray(fr.u);
  out.p.fromArray(fr.p).addScaledVector(R, d);
  const c = Math.cos(psi), sn = Math.sin(psi);
  out.f.copy(T).multiplyScalar(c).addScaledVector(R, -sn);
  out.l.copy(R).multiplyScalar(-c).addScaledVector(T, -sn);
}

let gaugeTick = 0;
let debugTick = 0;
const jctInfo = { left: null, right: null, dist: 0, side: 0 };
const tagInfo = { active: false, onScreen: false, x: 0, y: 0, ahead: 0, name: '', canChallenge: false, threshold: 40 };

function render(alpha, dt) {
  const edges = input.poll();
  if (edges.pause) { paused = !paused; hud.setPaused(paused); audio.setPaused(paused || document.hidden); }
  if (edges.view) {
    const v = rig.nextView();
    car.setView(v);
    hud.toast(VIEW_NAMES[v]);
  }
  if (edges.menu && menus.current && !paused) menus.input(edges.menu);
  if (edges.flash) flash = 0.18;   // 閃燈只是燈光效果；對決是靠近對手自動開始
  if (flash > 0) flash -= dt;

  const a = paused ? 1 : alpha;

  // 對手（先算，因為玩家的框架資料 fr / T / R 後面火花還要用）
  if (rival.active) {
    const rs = rival.st, rp = rival.prev;
    computePose(rp.s + (rs.s - rp.s) * a, rp.d + (rs.d - rp.d) * a, lerpAngle(rp.psi, rs.psi, a), rPose, rival.onAlt && session.alt ? session.alt : road);
    basis.makeBasis(rPose.l, rPose.u, rPose.f);
    rivalCar.group.matrix.copy(basis).setPosition(rPose.p);
    rivalCar.group.matrixWorldNeedsUpdate = true;
    rivalCar.group.visible = true;
    if (!paused) rivalCar.update(rs, dt, rival.flash);
    if (!paused) feedTrails(TRAIL_RIVAL, rivalCar, rPose.p, rPose.l, rPose.u, rPose.f, Math.abs(rs.vf) * 3.6, rs.braking);
    rivalCar.setMarker(duel.phase === 'marked' || duel.phase === 'countdown' || duel.phase === 'racing', dt);
  } else rivalCar.group.visible = false;

  computePose(prev.s + (state.s - prev.s) * a, prev.d + (state.d - prev.d) * a, lerpAngle(prev.psi, state.psi, a), pose);
  basis.makeBasis(pose.l, pose.u, pose.f);
  car.group.matrixAutoUpdate = false;
  car.group.matrix.copy(basis).setPosition(pose.p);
  car.group.matrixWorldNeedsUpdate = true;
  if (!paused) car.update(state, dt, flash);
  if (!paused && rig.view === 'chase') feedTrails(TRAIL_PLAYER, car, pose.p, pose.l, pose.u, pose.f, Math.abs(state.vf) * 3.6, state.braking, 0.2);

  for (const e of pendingSparks) {
    v3.copy(pose.p).addScaledVector(pose.l, -e.side * 0.95).addScaledVector(pose.u, 0.35);
    if (e.side === 0) v3.addScaledVector(pose.f, 2.1);
    v3b.copy(R).multiplyScalar(-(e.side || 1));
    sparks.burst(v3, T, v3b, state.speed, e.n, fxRng);
  }
  pendingSparks.length = 0;
  if (!paused) sparks.update(dt);

  const kmh = Math.abs(state.vf) * 3.6;
  if (!started) { titleTime += dt; rig.orbit(pose, titleTime); }
  else rig.update(pose, {
    kmh, vFrac: Math.min(1, kmh / playerCfg.vMaxKmh), steer: state.steer, lookBack: input.held.lookBack,
  }, paused ? 0 : dt);
  sky.position.copy(rig.camera.position);

  streamer.update(state.s, rig.camera);
  trafficMesh.update(pose.p, paused ? 0 : dt);
  trails.update(pose.p, paused ? 0 : dt);

  // 駕駛艙：儀表與後視鏡
  if (rig.view === 'cockpit') {
    if (++gaugeTick % 4 === 0) car.drawGauge(kmh, virtualRpm(kmh).rpm01);
    if (camCfg.mirror) {
      mirrorCam.position.copy(pose.p).addScaledVector(pose.u, 1.25).addScaledVector(pose.f, -1.5);
      mirrorCam.up.copy(pose.u);
      mirrorCam.lookAt(v3.copy(mirrorCam.position).addScaledVector(pose.f, -30));
      car.interior.visible = false; car.hood.visible = false;
      renderer.setRenderTarget(mirrorRT);
      renderer.render(scene, mirrorCam);
      renderer.setRenderTarget(null);
      car.interior.visible = true; car.hood.visible = true;
    }
    car.mirror.visible = !!camCfg.mirror;
  }

  if (started && !paused) audio.update(dt, (AUTOPILOT ? aiInput : input.held).throttle);
  { const k = Math.min(1, Math.max(0, (kmh - 110) / 150)); post.speed = paused || !started ? 0 : k * k * (3 - 2 * k); }
  reflection.render(scene, rig.camera, pose.p, pose.u);
  post.render(scene, rig.camera, dt);

  // ── HUD
  hud.update(state, rig.view, dt);
  tagInfo.active = rival.active;
  tagInfo.threshold = duel.mods.threshold;
  if (rival.active) {
    tagInfo.name = rival.def.name;
    tagInfo.ahead = rival.st.s - state.s;
    tagInfo.canChallenge = false;
    v3.copy(rPose.p).addScaledVector(rPose.u, 3.5).project(rig.camera);
    tagInfo.onScreen = v3.z < 1 && Math.abs(v3.x) < 0.96 && v3.y > -0.9 && v3.y < 0.96 && Math.abs(tagInfo.ahead) < 700;
    tagInfo.x = (v3.x * 0.5 + 0.5) * innerWidth;
    tagInfo.y = (-v3.y * 0.5 + 0.5) * innerHeight;
  } else tagInfo.canChallenge = false;
  hud.duel(duel, tagInfo);
  const nodeDef = flow.phase === 'node' && flow.node ? NODE_TYPES[flow.node === 'shop' ? 'pa' : flow.node] : null;
  let nodeLabel = nodeDef ? `${nodeDef.icon} ${nodeDef.name}` : '';
  if (flow.phase === 'node' && flow.node === 'shortcut') nodeLabel += `　還有 ${Math.max(0, Math.round((flow.endAt - state.s) / 10) * 10)} m`;
  else if (flow.phase === 'node' && flow.node === 'event' && flow.event && !flow.event.done) {
    const ev = flow.event;
    nodeLabel = `❓ ${ev.name}`;
    if (ev.kind === 'police') nodeLabel += `　限速 ${ev.limit} km/h　${Math.max(0, Math.round((ev.checkS - state.s) / 10) * 10)} m`;
    else if (ev.kind === 'jam') nodeLabel += `　還有 ${Math.max(0, Math.round((ev.s1 - state.s) / 10) * 10)} m`;
  }
  hud.run(session.run, nodeLabel, session.nights ? { night: session.run.night, zoneName: session.zoneName, need: runCfg.boss.afterDefeats } : null);
  hud.clock(clock);
  choiceUi.update(menus, session.run, upgrades);
  setDaylight(clock.progress);
  const toFork = flow.forkS - state.s;
  if (!flow.chosen && flow.options && toFork < 650 && toFork > -5) {
    jctInfo.left = NODE_TYPES[flow.options[0]]; jctInfo.right = NODE_TYPES[flow.options[1]];
    jctInfo.dist = toFork; jctInfo.side = state.d > 0 ? 1 : -1;
    hud.junction(jctInfo);
  } else hud.junction(null);

  if (DEBUG && ++debugTick % 6 === 0) {
    const info = renderer.info;
    const heap = performance.memory ? `${(performance.memory.usedJSHeapSize / 1048576).toFixed(0)} MB` : '—';
    const rs = rival.st;
    hud.debug(
      `FPS   ${loop.stats.fps.toFixed(0)}  (${loop.stats.frameMs.toFixed(1)} ms, 物理 ${loop.stats.steps} 步)\n` +
      `速度  ${kmh.toFixed(1)} km/h   橫移 ${state.vl.toFixed(2)} m/s${session.slip ? '   [吸尾流]' : ''}\n` +
      `s     ${state.s.toFixed(0)} m   里程 ${(state.dist / 1000).toFixed(2)} km\n` +
      `d     ${state.d.toFixed(2)} m   psi ${(state.psi * 57.3).toFixed(1)}°\n` +
      `曲率  ${Math.abs(fr.kappa) > 1e-4 ? 'R=' + Math.abs(1 / fr.kappa).toFixed(0) + ' m ' + (fr.kappa > 0 ? '左' : '右') : '直線'}${fr.tunnel ? '  [隧道]' : ''}${fr.wl > road.halfWidth + 0.1 ? '  [匯入]' : ''}\n` +
      `轉向  ${state.steer.toFixed(2)}   偏航 ${state.yawRate.toFixed(2)} rad/s\n` +
      `狀態  ${state.drifting ? '甩尾' : '抓地'}${state.wallContact > 0 ? '  貼牆' : ''}   碰牆 ${state.wallHits}  撞車 ${state.carHits || 0}\n` +
      `車流  ${traffic.count} 台（生成 ${traffic.spawned} / 回收 ${traffic.recycled}）\n` +
      `道路  ${((road.sMax - road.sMin) / 1000).toFixed(1)} km 視窗   chunk ${streamer.stats.active}（已建 ${streamer.stats.built}，最慢 ${streamer.stats.maxBuildMs.toFixed(1)} ms）\n` +
      `對決  ${duel.phase}   差距 ${duel.gap.toFixed(1)} m   ${duel.scoreP.toFixed(1)} : ${duel.scoreR.toFixed(1)} / ${duel.target}   領先 ${duel.leader > 0 ? '玩家' : duel.leader < 0 ? '對手' : '—'}\n` +
      `夜晚  第 ${session.run.night} 晚 ${session.zoneName}  本晚擊敗 ${session.run.nightDefeats}/${runCfg.boss.afterDefeats}  Boss 擊敗 ${session.run.bossWins}${flow.event ? '  事件:' + flow.event.kind : ''}${rival.active && rival.intro ? '  [Boss 登場中]' : ''}${rival.active && rival.nitroT > 0 ? '  [氮氣]' : ''}\n` +
      `時鐘  ${clock.text}（剩 ${clock.remaining.toFixed(1)} 分）  節點 ${flow.phase}${flow.node ? ':' + flow.node : ''}  交流道 ${flow.chosen ? '—' : (flow.forkS - state.s).toFixed(0) + ' m'}${session.alt ? '  [alt]' : ''}  已過 ${session.run.forks}\n` +
      (rival.active
        ? `AI    ${rival.def.name} [${rival.mode}]  ${(rs.vf * 3.6).toFixed(0)} km/h（上限 ${((rival.input.vAllowed || 0) * 3.6).toFixed(0)}）  d ${rs.d.toFixed(1)}  車道 ${rival.mem.lane}${rival.blockD != null ? '  卡位' : ''}${rival.mistakeT > 0 ? '  失誤' : ''}  碰牆 ${rs.wallHits} 撞車 ${rs.carHits || 0}\n`
        : `AI    —（${session.respawnT.toFixed(1)} 秒後出現）\n`) +
      `成長  ${upgrades.list().map((it) => it.def.name + (it.count > 1 ? '×' + it.count : '')).join('、') || '—'}${session.boostT > 0 ? '   [加速中]' : ''}${menus.current ? '   選單:' + menus.current.kind + ' ' + menus.current.timer.toFixed(1) + 's' : ''}\n` +
      `生效  極速 ${playerCfg.vMaxKmh.toFixed(0)}  加速 ${playerCfg.power.toFixed(2)}  抓地 ${playerCfg.latAccelMax.toFixed(1)}  煞車 ${playerCfg.brakeDecel.toFixed(1)}  轉向 ${playerCfg.steerLow.toFixed(2)}/${playerCfg.steerHigh.toFixed(2)}\n` +
      `      尾流 ${playerCfg.slipstreamRange.toFixed(0)} m −${(Math.min(0.9, playerCfg.slipstreamDragCut) * 100).toFixed(0)}%  撞牆 ${(playerCfg.wallLossGraze * 100).toFixed(1)}–${(playerCfg.wallLossHeadOn * 100).toFixed(1)}%  門檻 ${duel.mods.threshold} m  得分 ×${duel.mods.scoreMul.toFixed(2)}  保留 ${(duel.mods.keepOnOvertaken * 100).toFixed(0)}%  車流 ×${session.world.trafficDensityMul.toFixed(2)}\n` +
      `視角  ${VIEW_NAMES[rig.view]}  FOV ${rig.camera.fov.toFixed(1)}°\n` +
      `繪製  ${info.render.calls} calls / ${(info.render.triangles / 1000).toFixed(0)}k tris   幾何 ${info.memory.geometries}  貼圖 ${info.memory.textures}   heap ${heap}\n` +
      `seed  ${seed}${AUTOPILOT ? '   [自動駕駛]' : ''}`,
    );
  }
}

// 自動駕駛沒有「開始」按鈕，等第一次點擊或按鍵才能出聲；分頁切到背景時靜音
if (AUTOPILOT) for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, () => audio.start(), { once: true });
addEventListener('keydown', (e) => { if (e.code === 'KeyM') { audio.muted = !audio.muted; hud.toast(audio.muted ? '靜音' : '聲音開啟', 1.2); } else if (e.code === 'KeyN' && started) audio.nextTrack(); });
document.addEventListener('visibilitychange', () => audio.setPaused(paused || document.hidden));
const loop = createLoop({ step, render });
loop.start();
if (AUTOPILOT) hud.toast('自動駕駛', 2.5);

// 除錯與自動化測試用
window.__game = {
  post, gfx, applyGfx, streamer, scene, trails, reflection, audio,
  models: modelsJson,
  session, state, road, carCfg, playerCfg, upgrades, menus, camCfg, trafficCfg, duelCfg, runCfg, clock, flow, rig, loop, renderer, car, rivalCar, traffic, streamer, duel, rival,
  /** 快轉模擬 sec 秒後畫一幀（分頁在背景、rAF 被節流時用）。會照常串流道路網格。 */
  advance(sec, inp, until) {
    const n = Math.round(sec * 60);
    for (let i = 0; i < n; i++) {
      if (!inp) autoMenu();
      session.step(1 / 60, inp || autopilot(state, playerCfg, road, autoOpts(), aiInput));
      streamer.update(state.s, null);
      if (i % 2 === 0) { computePose(state.s, state.d, state.psi, pose); rig.update(pose, { kmh: state.vf * 3.6, vFrac: 0, steer: state.steer, lookBack: false }, 1 / 30); }
      if (until && until()) break;
    }
    render(1, 1 / 60);
  },
  /** 連續模擬並畫 n 幀、強制 GPU 同步，回傳平均與最慢一幀的毫秒 */
  bench(n = 120) {
    const gl = renderer.getContext();
    const px = new Uint8Array(4);
    let worst = 0;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      const f0 = performance.now();
      autoMenu();
      session.step(1 / 60, autopilot(state, playerCfg, road, autoOpts(), aiInput));
      render(1, 1 / 60);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      worst = Math.max(worst, performance.now() - f0);
    }
    return { avg: (performance.now() - t0) / n, worst };
  },
};

if (import.meta.hot) {
  const merge = (dst, src) => {
    for (const k of Object.keys(src)) {
      if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) && dst[k]) Object.assign(dst[k], src[k]); else dst[k] = src[k];
    }
  };
  import.meta.hot.accept('./config/cars.json', (m) => { Object.assign(carCfg, m.default.player); session.recompute(); hud.toast('車輛參數已更新'); });
  import.meta.hot.accept('./config/upgrades.json', (m) => {
    merge(upgradeCfg.rules, m.default.rules);
    m.default.list.forEach((d) => { const cur = upgradeCfg.list.find((x) => x.id === d.id); if (cur) Object.assign(cur, d); });
    session.recompute();
    hud.toast('成長參數已更新');
  });
  import.meta.hot.accept('./config/run.json', (m) => { merge(runCfg, m.default); hud.toast('流程參數已更新'); });
  import.meta.hot.accept('./config/duel.json', (m) => { merge(duelCfg, m.default); session.recompute(); hud.toast('對決參數已更新'); });
  import.meta.hot.accept('./config/rivals.json', (m) => {
    m.default.list.forEach((d, i) => { if (rivals[i]) Object.assign(rivals[i], d); else rivals.push(d); });
    hud.toast('對手參數已更新（下一位對手生效）');
  });
  import.meta.hot.accept('./config/traffic.json', (m) => {
    const { types, maxCars, ...rest } = m.default; // 車種與池大小要重新載入才生效
    Object.assign(trafficCfg, rest);
    hud.toast('車流參數已更新');
  });
  import.meta.hot.accept('./config/camera.json', (m) => { merge(camCfg, m.default); hud.toast('攝影機參數已更新'); });
}
