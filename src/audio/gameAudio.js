import { createCarAudio, loadSfx } from './carSynth.js';

// 遊戲音效總管：把合成的引擎聲與錄音音效接到遊戲事件上。
//   引擎／渦輪／胎嘯／風切 → carSynth 即時合成，轉速由車速推算（假 6 檔，含換檔遲滯）
//   撞牆、撞車、擦牆、超車呼嘯、換檔、發動、環境底噪 → public/audio/sfx 的錄音
// AudioContext 要等使用者第一次操作才能出聲，所以 start() 由「開始」按鈕呼叫。
const BASE = `${import.meta.env.BASE_URL}audio/sfx/`;
const LIGHT = ['crash_light_01', 'crash_light_02', 'crash_light_03', 'crash_light_04', 'crash_light_05'];
const SHIFT = ['shift_paddle_01', 'shift_paddle_02', 'shift_paddle_03'];
// 每個呼嘯檔在最響那一秒的音量差很多，這裡先拉平（量出來的 RMS 換算）
const PASS = {
  passby_jdm_a_01: 0.8, passby_jdm_a_02: 1.3, passby_jdm_a_03: 0.35, passby_jdm_b_01: 0.7,
  passby_jdm_b_02: 0.63, passby_jdm_b_03: 0.63, passby_gt_01: 1.6, passby_gt_02: 1.6,
};
const PASS_PEAK = 3.53;   // 八個呼嘯檔最響的位置都在 3.5 秒
const ONE = ['crash_heavy_01', 'crash_metal_01', 'crash_debris_01', 'glass_break_small_01', 'wall_scrape_01', 'engine_start_01', 'amb_motorway_night_loop'];
const GEARS = [0, 60, 105, 150, 195, 235, 300];
// 背景音樂：隨機輪播，快結束時淡出、同時淡入下一首（目前這 12 首是暫用的，換檔案只要改這份清單）
const BGM_BASE = `${import.meta.env.BASE_URL}audio/bgm/`;
const BGM = [
  'eb01_neon_overdrive', 'eb02_bayshore_lightning', 'eb03_redline_heart', 'eb04_midnight_junction',
  'eb05_burning_asphalt', 'eb06_starlight_drift', 'eb07_king_of_the_highway', 'eb08_velocity_dream',
  'eb09_ghost_of_the_tunnel', 'eb10_dawn_breaker', 'eb11_turbo_fantasy', 'eb12_final_lap_emperor',
];
const XFADE = 7;          // 交叉淡化的秒數
const MUSIC_LEVEL = 0.5;  // 音樂音量滑桿拉滿時的實際增益
const ENGINE_LEVEL = 0.34; // 合成器全油門時約 −9 dBFS，會蓋掉所有錄音，所以壓下來
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const pick = (list, last) => { let v; do v = list[Math.floor(Math.random() * list.length)]; while (list.length > 1 && v === last); return v; };

/** 從一段錄音裡切出可以無縫循環的片段：開頭和緊接在結尾之後的那一小段交叉淡化 */
function makeLoop(ctx, buf, t0, t1, xf) {
  const sr = buf.sampleRate, o = Math.floor(t0 * sr), n = Math.floor((t1 - t0) * sr), x = Math.floor(xf * sr);
  const out = ctx.createBuffer(buf.numberOfChannels, n, sr);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c), dst = out.getChannelData(c);
    for (let i = 0; i < n; i++) {
      let v = src[o + i];
      if (i < x) { const k = i / x; v = v * Math.sqrt(k) + src[o + n + i] * Math.sqrt(1 - k); }
      dst[i] = v;
    }
  }
  return out;
}

export function createGameAudio({ events, state, traffic, rival, engine = {} }) {
  let ctx = null, master = null, sfxBus = null, engBus = null, car = null;
  let scrapeG = null, ambG = null;
  const bufs = {};
  const armed = new WeakMap();
  let volume = 0.8, muted = false, suspended = false;
  let gear = 1, shiftCool = 0, hitCool = 0, passCool = 0, lastLight = '', lastPass = '', lastShift = '', rivalSide = 0, over = false;
  const stats = { hits: 0, passes: 0, shifts: 0, rpm: 0, gear: 1, loaded: 0, scrape: 0, track: '', tracks: 0 };

  // ── 背景音樂：用 <audio> 串流播放（不整首解碼進記憶體），各自接一個增益節點做淡入淡出
  let musicVol = 0.6, bgmBus = null, cur = null, order = [], musicCool = 0;
  const decks = new Set();
  function nextName() {
    if (!order.length) {
      order = BGM.slice();
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      if (order[0] === stats.track && order.length > 1) order.push(order.shift());   // 洗牌後不要連播同一首
    }
    return order.shift();
  }
  function fadeOut(deck, sec) {
    const t = ctx.currentTime;
    deck.g.gain.cancelScheduledValues(t);
    deck.g.gain.setValueAtTime(deck.g.gain.value, t);
    deck.g.gain.linearRampToValueAtTime(0, t + sec);
    deck.killAt = t + sec + 0.2;
  }
  function startTrack(fade) {
    const name = nextName();
    const el = new Audio(`${BGM_BASE}${name}.mp3`);
    el.preload = 'auto';
    const src = ctx.createMediaElementSource(el), g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + fade);
    src.connect(g); g.connect(bgmBus);
    const deck = { el, g, src, name, killAt: Infinity, failed: false };
    el.addEventListener('error', () => { deck.failed = true; });
    el.play().catch(() => { deck.failed = true; });
    decks.add(deck); cur = deck;
    stats.track = name; stats.tracks++;
  }
  function tickMusic(dt) {
    if (!bgmBus) return;
    for (const d of decks) if (ctx.currentTime > d.killAt || (d.failed && d !== cur)) { d.el.pause(); d.src.disconnect(); d.el.removeAttribute('src'); decks.delete(d); }
    musicCool -= dt;
    if (!cur || cur.failed) {
      if (musicCool <= 0) { if (cur) { cur.killAt = 0; } musicCool = 2; startTrack(1.5); }   // 檔案壞了就等 2 秒換下一首
      return;
    }
    const el = cur.el;
    if (el.ended || (Number.isFinite(el.duration) && el.duration - el.currentTime < XFADE)) { fadeOut(cur, XFADE); startTrack(XFADE); }
  }

  function play(name, { gain = 1, rate = 1, pan = 0, offset = 0, fadeIn = 0, jitter = 0.05 } = {}) {
    const buf = bufs[name];
    if (!ctx || !buf || suspended) return null;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate * (1 + (Math.random() * 2 - 1) * jitter);
    const g = ctx.createGain(), p = ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    if (fadeIn > 0) { g.gain.setValueAtTime(0, ctx.currentTime); g.gain.linearRampToValueAtTime(gain, ctx.currentTime + fadeIn); } else g.gain.value = gain;
    src.connect(g); g.connect(p); p.connect(sfxBus);
    src.start(0, offset);
    return { src, g };
  }

  function loop(buf, gain) {
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const g = ctx.createGain(); g.gain.value = gain;
    src.connect(g); g.connect(sfxBus); src.start();
    return g;
  }

  async function loadAll() {
    const names = [...LIGHT, ...SHIFT, ...Object.keys(PASS), ...ONE];
    await Promise.all(names.map(async (n) => {
      try { bufs[n] = await loadSfx(ctx, `${BASE}${n}.ogg`); stats.loaded++; } catch { /* 少一個音效不影響遊戲 */ }
      if (n === 'amb_motorway_night_loop' && bufs[n] && !ambG) { ambG = loop(bufs[n], 0); ambG.gain.setTargetAtTime(0.9, ctx.currentTime, 1.2); }
      // 擦牆錄音頭尾有空白、中間有斷點，直接循環會一頓一頓，只取中間連續的 1.3 秒
      if (n === 'wall_scrape_01' && bufs[n] && !scrapeG) scrapeG = loop(makeLoop(ctx, bufs[n], 0.45, 1.75, 0.15), 0);
    }));
  }

  function applyVolume() {
    if (!master) return;
    master.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.05);
    bgmBus.gain.setTargetAtTime(musicVol * MUSIC_LEVEL, ctx.currentTime, 0.05);
  }

  function hit(e, isCar) {
    if (!ctx || hitCool > 0) return;
    hitCool = 0.08; stats.hits++;
    const v = e.speedLoss || 0, pan = (e.longitudinal ? 0 : e.side || 0) * 0.45;
    const g = clamp(0.3 + v / 10, 0.3, 1);
    if (v > (isCar ? 9 : 7)) {
      play('crash_heavy_01', { gain: g, pan });
      if (isCar) play('glass_break_small_01', { gain: 0.3 * g, pan });
    } else {
      lastLight = pick(LIGHT, lastLight);
      play(lastLight, { gain: g, pan });
      if (isCar ? v > 4 : e.sinA > 0.3) play(isCar ? 'crash_debris_01' : 'crash_metal_01', { gain: 0.35 * g, pan });
    }
  }
  events.on('wallHit', (e) => hit(e, false));
  events.on('carHit', (e) => hit(e, true));
  events.on('runOver', () => { over = true; });

  /** 呼嘯聲：rel = 相對速度 m/s，dd = 對方在我右邊幾公尺，lead = 還有幾秒擦身而過 */
  function pass(rel, dd, lead, boost = 1) {
    if (passCool > 0) return;
    passCool = 0.14; stats.passes++;
    lastPass = pick(Object.keys(PASS), lastPass);
    const rate = 0.85 + 0.3 * clamp(rel / 60, 0, 1);
    const gain = PASS[lastPass] * 0.5 * boost * clamp(rel / 40, 0.35, 1) * clamp(1 - Math.abs(dd) / 10, 0.3, 1);
    play(lastPass, { gain, rate, pan: dd / 4.5, offset: Math.max(0, PASS_PEAK - (lead + 0.05) * rate), fadeIn: 0.07 });
  }

  const api = {
    stats,
    get ctx() { return ctx; },
    get volume() { return volume; },
    set volume(v) { volume = clamp(v, 0, 1); applyVolume(); },
    get muted() { return muted; },
    set muted(v) { muted = !!v; applyVolume(); },
    get deck() { return cur; },       // 除錯用：目前這一首
    get decks() { return decks; },
    get musicVolume() { return musicVol; },
    set musicVolume(v) { musicVol = clamp(v, 0, 1); applyVolume(); },
    /** 跳到下一首（一樣交叉淡化，但比較快） */
    nextTrack() { if (bgmBus && cur && !suspended) { fadeOut(cur, 1.5); startTrack(1.5); } },

    /** 一定要在使用者操作（點擊、按鍵）的處理函式裡呼叫 */
    start() {
      if (ctx) { if (ctx.state === 'suspended' && !suspended) ctx.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      // 總音量 → 限幅器（很多聲音同時響時不破音）→ 輸出
      const lim = ctx.createDynamicsCompressor();
      lim.threshold.value = -4; lim.knee.value = 3; lim.ratio.value = 14; lim.attack.value = 0.002; lim.release.value = 0.12;
      master = ctx.createGain(); master.gain.value = muted ? 0 : volume;
      master.connect(lim); lim.connect(ctx.destination);
      api.out = lim; // 除錯用：從這裡接分析器量實際輸出
      sfxBus = ctx.createGain(); sfxBus.connect(master);
      engBus = ctx.createGain(); engBus.gain.value = 0; engBus.connect(master);
      bgmBus = ctx.createGain(); bgmBus.gain.value = musicVol * MUSIC_LEVEL; bgmBus.connect(master);
      car = createCarAudio(ctx, engBus, { cylinders: 6, turbo: true, ...engine, volume: ENGINE_LEVEL });
      loadAll().then(() => {
        // 發動聲播 1 秒多就淡掉，換成合成的引擎聲接手
        // 開局車子已經在路上跑，就不播發動聲，引擎聲直接淡入
        const s = Math.abs(state.vf) < 3 ? play('engine_start_01', { gain: 0.55, jitter: 0 }) : null;
        const t = ctx.currentTime;
        if (s) { s.g.gain.setValueAtTime(0.55, t + 0.9); s.g.gain.linearRampToValueAtTime(0, t + 1.9); s.src.stop(t + 2); }
        engBus.gain.setValueAtTime(0, t + (s ? 0.5 : 0));
        engBus.gain.linearRampToValueAtTime(1, t + (s ? 1.6 : 0.4));
      });
    },

    setPaused(p) {
      suspended = p;
      if (!ctx) return;
      if (p) ctx.suspend(); else ctx.resume();
      for (const d of decks) { if (p) d.el.pause(); else d.el.play().catch(() => {}); }
    },

    /** 每幀呼叫。throttle：玩家這一幀的油門 0–1 */
    update(dt, throttle) {
      if (!ctx || suspended) return;
      hitCool -= dt; passCool -= dt; shiftCool -= dt;
      tickMusic(dt);
      const kmh = Math.abs(state.vf) * 3.6, speed = Math.abs(state.vf);
      const thr = over ? 0 : clamp(throttle || 0, 0, 1);

      // 假 6 檔：升檔看上限，降檔要低於下限 12 km/h 才降，免得在交界來回跳
      if (shiftCool <= 0) {
        let g = gear;
        if (g < 6 && kmh > GEARS[g]) g++; else if (g > 1 && kmh < GEARS[g - 1] - 12) g--;
        if (g !== gear) {
          const up = g > gear;
          gear = g; shiftCool = 0.3; stats.shifts++;
          if (up && thr > 0.3) car.shift();
          lastShift = pick(SHIFT, lastShift);
          play(lastShift, { gain: up ? 0.55 : 0.35 });
        }
      }
      const lo = GEARS[gear - 1], hi = GEARS[gear];
      const t = clamp((kmh - lo) / (hi - lo), -0.15, 1.04);
      const rpm01 = gear === 1 ? Math.max(0, t) : 0.45 + 0.55 * t;
      const rpm = 900 + rpm01 * 6900;
      stats.rpm = rpm; stats.gear = gear;
      // 胎嘯：甩尾時一定有；沒甩尾時橫移超過 2 m/s 才開始出聲
      const vl = Math.abs(state.vl || 0);
      const slip = state.drifting ? clamp(0.4 + vl / 8, 0, 1) : clamp((vl - 2) / 6, 0, 1);
      car.update({ rpm, throttle: thr, speed, slip });

      // 擦牆
      if (scrapeG) {
        const on = state.wallContact > 0 && speed > 3;
        stats.scrape = on ? 1 : 0;
        scrapeG.gain.setTargetAtTime(on ? 0.4 * clamp(speed / 40, 0.2, 1) : 0, ctx.currentTime, on ? 0.03 : 0.08);
      }

      // 超車呼嘯：前面的車先「上膛」，快要擦身而過時觸發一次
      for (const c of traffic.cars) {
        if (!c.active || c.onAlt) continue;
        const ds = c.s - state.s, rel = state.vf - c.v;
        if (ds > 14) armed.set(c, true);
        else if (armed.get(c) && rel > 9 && ds < rel * 0.35 + 1) {
          armed.set(c, false);
          const dd = c.d - state.d;
          if (ds > -4 && Math.abs(dd) < 8) pass(rel, dd, Math.max(0, ds / rel));
        }
      }
      if (rival.active && !rival.onAlt) {
        const ds = rival.st.s - state.s, side = ds > 0 ? 1 : -1;
        if (rivalSide && side !== rivalSide && Math.abs(ds) < 6) {
          const rel = Math.abs(state.vf - rival.st.vf);
          if (rel > 3) pass(rel + 14, rival.st.d - state.d, 0, 1.3);
        }
        rivalSide = side;
      } else rivalSide = 0;
    },
  };
  return api;
}
