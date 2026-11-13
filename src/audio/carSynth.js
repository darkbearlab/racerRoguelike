/* 賽車程序化音效：引擎、渦輪、輪胎尖叫、風切（Web Audio，無外部檔案）
 *
 * 用法：
 *   import { createCarAudio, loadSfx, playSfx } from './audio/carSynth.js';
 *   const ctx = new AudioContext();             // 要在使用者點擊後建立或 resume
 *   const car = createCarAudio(ctx, ctx.destination, { cylinders: 6 });
 *   // 每幀：
 *   car.update({ rpm, throttle, speed, slip, boost });
 *   //   rpm 轉速；throttle 0..1 油門；speed m/s；slip 0..1 輪胎打滑程度；boost 0..1 渦輪增壓（可省略，會依轉速與油門自動估）
 *   car.shift();     // 換檔瞬間呼叫：短暫斷油＋回火
 *   car.setVolume(0.8); car.dispose();
 *
 *   const hit = await loadSfx(ctx, 'audio/sfx/crash_light_01.ogg');
 *   playSfx(ctx, hit, { gain: 0.8, rate: 0.9 + Math.random() * 0.2, pan: -0.3 });
 *
 * 設計：四行程引擎的點火頻率 = rpm / 60 × 汽缸數 / 2。以點火頻率為基頻疊諧波，
 * 加上半階次的粗糙感（直列六缸 / V8 的差異來自這裡），再經失真與隨油門開合的低通。
 * 收油時加隨機回火爆音；渦輪有增壓哨音與洩壓閥「噗咻」聲。
 */

export function createCarAudio(ctx, destination, opts = {}) {
  const o = Object.assign({
    cylinders: 6,        // 4 / 6 / 8 …
    idleRpm: 900,
    redline: 8000,
    turbo: true,
    volume: 0.8,
  }, opts);

  const out = ctx.createGain(); out.gain.value = o.volume; out.connect(destination);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.knee.value = 8; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.15;
  comp.connect(out);

  // ---------- 引擎 ----------
  const engBus = ctx.createGain(); engBus.gain.value = 0.0;
  const shaper = ctx.createWaveShaper(); shaper.curve = makeDrive(2.6); shaper.oversample = '2x';
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.9;
  const body = ctx.createBiquadFilter(); body.type = 'peaking'; body.frequency.value = 180; body.Q.value = 0.8; body.gain.value = 5;
  engBus.connect(shaper); shaper.connect(lp); lp.connect(body); body.connect(comp);

  // 主要點火諧波（PeriodicWave：前幾階強、後面衰減，模擬排氣脈衝）
  const fire = ctx.createOscillator();
  fire.setPeriodicWave(makeFiringWave(ctx, o.cylinders));
  const fireG = ctx.createGain(); fireG.gain.value = 0.55; fire.connect(fireG); fireG.connect(engBus);
  // 半階次（曲軸一圈的不均勻）——給低沉的「咕嚕」感
  const half = ctx.createOscillator(); half.type = 'triangle';
  const halfG = ctx.createGain(); halfG.gain.value = 0.28; half.connect(halfG); halfG.connect(engBus);
  // 進氣高頻（油門越大越亮）
  const intake = ctx.createOscillator(); intake.type = 'sawtooth';
  const intakeG = ctx.createGain(); intakeG.gain.value = 0.0; intake.connect(intakeG); intakeG.connect(engBus);
  // 燃燒雜訊：帶通雜訊，被點火頻率振幅調變
  const noise = makeNoise(ctx);
  const nBP = ctx.createBiquadFilter(); nBP.type = 'bandpass'; nBP.Q.value = 0.7;
  const nG = ctx.createGain(); nG.gain.value = 0.0;
  const nAM = ctx.createGain(); nAM.gain.value = 0.5;
  const amOsc = ctx.createOscillator(); amOsc.type = 'square';
  const amDepth = ctx.createGain(); amDepth.gain.value = 0.5; amOsc.connect(amDepth); amDepth.connect(nAM.gain);
  noise.connect(nBP); nBP.connect(nAM); nAM.connect(nG); nG.connect(engBus);

  // ---------- 渦輪 ----------
  const whistle = ctx.createOscillator(); whistle.type = 'sine';
  const whistleG = ctx.createGain(); whistleG.gain.value = 0;
  whistle.connect(whistleG); whistleG.connect(comp);
  const bovBP = ctx.createBiquadFilter(); bovBP.type = 'bandpass'; bovBP.Q.value = 1.4;
  const bovG = ctx.createGain(); bovG.gain.value = 0;
  const noise2 = makeNoise(ctx); noise2.connect(bovBP); bovBP.connect(bovG); bovG.connect(comp);

  // ---------- 輪胎尖叫 ----------
  const sq1 = ctx.createOscillator(); sq1.type = 'sawtooth';
  const sq2 = ctx.createOscillator(); sq2.type = 'sawtooth';
  const sqBP = ctx.createBiquadFilter(); sqBP.type = 'bandpass'; sqBP.Q.value = 6;
  const sqNoiseBP = ctx.createBiquadFilter(); sqNoiseBP.type = 'bandpass'; sqNoiseBP.Q.value = 3; sqNoiseBP.frequency.value = 2600;
  const sqG = ctx.createGain(); sqG.gain.value = 0;
  const sqWob = ctx.createOscillator(); sqWob.frequency.value = 7;
  const sqWobG = ctx.createGain(); sqWobG.gain.value = 25; sqWob.connect(sqWobG); sqWobG.connect(sq1.frequency); sqWobG.connect(sq2.frequency);
  sq1.connect(sqBP); sq2.connect(sqBP); sqBP.connect(sqG);
  const noise3 = makeNoise(ctx); const sqNG = ctx.createGain(); sqNG.gain.value = 0.35;
  noise3.connect(sqNoiseBP); sqNoiseBP.connect(sqNG); sqNG.connect(sqG);
  // 胎嘯不進壓縮器：引擎一直把壓縮器壓著，胎嘯接在裡面量起來幾乎聽不到
  sqG.connect(out);

  // ---------- 風切與路噪 ----------
  const noise4 = makeNoise(ctx);
  const windLP = ctx.createBiquadFilter(); windLP.type = 'lowpass'; windLP.frequency.value = 600;
  const windG = ctx.createGain(); windG.gain.value = 0;
  noise4.connect(windLP); windLP.connect(windG); windG.connect(comp);

  const oscs = [fire, half, intake, amOsc, whistle, sq1, sq2, sqWob];
  for (const n of oscs) n.start();
  for (const n of [noise, noise2, noise3, noise4]) n.start();

  const st = { rpm: o.idleRpm, throttle: 0, boost: 0, lastThrottle: 0, cut: 0, crackleT: 0 };
  const T = 0.03; // 參數平滑時間常數（秒）

  function update(p) {
    const now = ctx.currentTime;
    const rpm = clamp(p.rpm ?? st.rpm, o.idleRpm * 0.6, o.redline * 1.05);
    let thr = clamp(p.throttle ?? 0, 0, 1);
    if (st.cut > now) thr = 0;                       // 換檔斷油
    const speed = Math.max(0, p.speed ?? 0);
    const slip = clamp(p.slip ?? 0, 0, 1);
    const r = (rpm - o.idleRpm) / (o.redline - o.idleRpm);

    // 渦輪：增壓追著「轉速 × 油門」慢慢上來，收油時洩壓
    const boostTarget = o.turbo ? (p.boost ?? clamp(r * 1.3 - 0.2, 0, 1) * thr) : 0;
    st.boost += (boostTarget - st.boost) * (boostTarget > st.boost ? 0.04 : 0.25);
    if (o.turbo && st.lastThrottle > 0.6 && thr < 0.2 && st.boost > 0.35) blowOff(st.boost);

    const f = rpm / 60 * o.cylinders / 2;           // 點火頻率
    set(fire.frequency, f, now, T);
    set(half.frequency, f / 2 * 1.003, now, T);
    set(intake.frequency, f * 2.01, now, T);
    set(amOsc.frequency, f, now, T);
    set(nBP.frequency, 400 + f * 3, now, T);

    const load = 0.35 + 0.65 * thr;
    set(engBus.gain, (0.25 + 0.35 * r) * load + 0.08, now, 0.05);
    set(lp.frequency, 500 + 3500 * thr + 2500 * r, now, 0.05);
    set(intakeG.gain, 0.05 + 0.18 * thr * r, now, 0.05);
    set(nG.gain, 0.08 + 0.25 * thr, now, 0.05);
    set(halfG.gain, 0.32 - 0.15 * r, now, 0.05);

    set(whistle.frequency, 1800 + 6500 * st.boost, now, 0.05);
    set(whistleG.gain, 0.035 * st.boost * st.boost, now, 0.05);

    const sqLevel = slip < 0.08 ? 0 : Math.min(1, (slip - 0.08) / 0.5) * Math.min(1, speed / 6);
    const sqF = 650 + 450 * slip + speed * 4;
    set(sq1.frequency, sqF, now, 0.04); set(sq2.frequency, sqF * 1.37, now, 0.04);
    set(sqBP.frequency, sqF * 1.2, now, 0.04);
    set(sqG.gain, 0.6 * sqLevel, now, 0.03);

    set(windG.gain, Math.min(0.5, (speed / 60) ** 2 * 0.5), now, 0.1);
    set(windLP.frequency, 300 + speed * 25, now, 0.1);

    // 收油回火：高轉速突然鬆油門時，隨機幾聲「啪」
    if (thr < 0.1 && rpm > o.redline * 0.45 && now > st.crackleT) {
      if (Math.random() < 0.12) pop(0.25 + Math.random() * 0.35);
      st.crackleT = now + 0.04 + Math.random() * 0.08;
    }
    st.rpm = rpm; st.lastThrottle = thr;
  }

  function blowOff(amount) {
    const now = ctx.currentTime;
    bovBP.frequency.cancelScheduledValues(now);
    bovBP.frequency.setValueAtTime(3800, now);
    bovBP.frequency.exponentialRampToValueAtTime(900, now + 0.35);
    bovG.gain.cancelScheduledValues(now);
    bovG.gain.setValueAtTime(0, now);
    bovG.gain.linearRampToValueAtTime(0.35 * amount, now + 0.015);
    bovG.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
    st.boost *= 0.2;
  }

  function pop(g) {
    const now = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = popBuffer(ctx);
    const bp = ctx.createBiquadFilter(); bp.type = 'lowpass'; bp.frequency.value = 1800 + Math.random() * 1500;
    const gg = ctx.createGain(); gg.gain.value = g;
    src.connect(bp); bp.connect(gg); gg.connect(comp); src.start(now);
  }

  function shift() {
    st.cut = ctx.currentTime + 0.09;
    pop(0.5);
    if (o.turbo && st.boost > 0.3) blowOff(st.boost * 0.7);
  }

  return {
    update, shift,
    setVolume(v) { set(out.gain, v, ctx.currentTime, 0.05); },
    dispose() {
      for (const n of oscs) try { n.stop(); } catch (e) { /* 已停止 */ }
      for (const n of [noise, noise2, noise3, noise4]) try { n.stop(); } catch (e) { /* 已停止 */ }
      out.disconnect();
    },
    get boost() { return st.boost; },
  };
}

// 載入錄音音效（ogg/mp3/wav）
const sfxCache = new Map();
export async function loadSfx(ctx, url) {
  if (sfxCache.has(url)) return sfxCache.get(url);
  const p = fetch(url).then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b));
  sfxCache.set(url, p);
  return p;
}

// 播一次；rate 可做音高隨機化，pan -1..1
export function playSfx(ctx, buffer, { gain = 1, rate = 1, pan = 0, loop = false, destination } = {}) {
  const src = ctx.createBufferSource(); src.buffer = buffer; src.playbackRate.value = rate; src.loop = loop;
  const g = ctx.createGain(); g.gain.value = gain;
  const p = ctx.createStereoPanner(); p.pan.value = pan;
  src.connect(g); g.connect(p); p.connect(destination || ctx.destination);
  src.start();
  return { source: src, gain: g, stop: () => { try { src.stop(); } catch (e) { /* 已停止 */ } } };
}

// ---------- 小工具 ----------
function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }
function set(param, v, now, tc) { param.setTargetAtTime(v, now, tc); }

function makeDrive(k) {
  const n = 2048, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
  return c;
}

function makeFiringWave(ctx, cyl) {
  // 諧波振幅：基頻最強，2、3 階次之；偶數缸的引擎在 1.5 階附近多一點能量，靠 half 振盪器補
  const N = 32, re = new Float32Array(N), im = new Float32Array(N);
  for (let h = 1; h < N; h++) {
    let a = 1 / Math.pow(h, 1.15);
    if (h === 2) a *= 0.8;
    if (h === 3) a *= cyl >= 8 ? 0.9 : 0.6;
    if (h % 4 === 0) a *= 1.3;
    im[h] = a * (h % 2 ? 1 : -1);
  }
  return ctx.createPeriodicWave(re, im, { disableNormalization: false });
}

function makeNoise(ctx) {
  const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
  return src;
}

let _pop = null;
function popBuffer(ctx) {
  if (_pop && _pop.sampleRate === ctx.sampleRate) return _pop;
  const len = Math.floor(ctx.sampleRate * 0.06), b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < len; i++) { const t = i / len; d[i] = (Math.random() * 2 - 1) * Math.exp(-t * 18) + Math.sin(i * 0.05) * Math.exp(-t * 30) * 0.6; }
  return (_pop = b);
}
