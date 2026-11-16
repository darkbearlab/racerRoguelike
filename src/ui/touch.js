// 觸控操作：左下是方向盤（左右滑，類比），右下是煞車／甩尾（自動油門關掉時多一顆油門），右上是視角與暫停。
// 只負責把手指變成 { steer, gas, brake, drift } 與一次性的按鍵事件；真正的輸入合併在 core/input.js。
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function createTouch({ force = false } = {}) {
  const root = document.createElement('div');
  root.id = 'touch';
  root.innerHTML = `
    <div id="tSteer"><i>◀</i><b id="tKnob"></b><i>▶</i></div>
    <div class="tbn" id="tDrift">甩尾</div>
    <div class="tbn" id="tBrake">煞車</div>
    <div class="tbn" id="tGas">油門</div>
    <div class="tsm" id="tView">視角</div>
    <div class="tsm" id="tPause">Ⅱ</div>`;
  const hudEl = document.getElementById('hud');
  hudEl.insertBefore(root, document.getElementById('title'));
  const pad = root.querySelector('#tSteer'), knob = root.querySelector('#tKnob');
  const edges = new Set();

  const T = {
    enabled: false,
    autoGas: true,
    steer: 0, gas: false, brake: false, drift: false,
    /** 取走這一幀的按鍵事件 */
    take() { if (!edges.size) return null; const e = new Set(edges); edges.clear(); return e; },
    fire(name) { edges.add(name); },
    setAutoGas(on) { T.autoGas = !!on; document.body.classList.toggle('manual-gas', !T.autoGas); },
    enable() {
      if (T.enabled) return;
      T.enabled = true;
      document.body.classList.add('touch');
    },
  };

  // 方向盤：手指在墊子上的左右位置就是方向（中間有一小段空檔），放開回正
  let steerId = null;
  const steerAt = (e) => {
    const r = pad.getBoundingClientRect(), half = r.width * 0.36;
    let n = clamp((e.clientX - (r.left + r.width / 2)) / half, -1, 1);
    knob.style.transform = `translateX(${(n * half).toFixed(1)}px)`;
    const a = Math.abs(n);
    n = a < 0.1 ? 0 : Math.sign(n) * ((a - 0.1) / 0.9) ** 1.25;
    T.steer = -n;   // +1 = 左
  };
  pad.addEventListener('pointerdown', (e) => { e.preventDefault(); steerId = e.pointerId; try { pad.setPointerCapture(e.pointerId); } catch { /* 舊瀏覽器 */ } pad.classList.add('on'); steerAt(e); });
  pad.addEventListener('pointermove', (e) => { if (e.pointerId === steerId) steerAt(e); });
  const steerEnd = (e) => { if (e.pointerId !== steerId) return; steerId = null; T.steer = 0; knob.style.transform = ''; pad.classList.remove('on'); };
  pad.addEventListener('pointerup', steerEnd);
  pad.addEventListener('pointercancel', steerEnd);

  const hold = (id, key) => {
    const el = root.querySelector(id);
    let pid = null;
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); pid = e.pointerId; try { el.setPointerCapture(e.pointerId); } catch { /* 舊瀏覽器 */ } T[key] = true; el.classList.add('on'); });
    const end = (e) => { if (e.pointerId !== pid) return; pid = null; T[key] = false; el.classList.remove('on'); };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  };
  hold('#tGas', 'gas'); hold('#tBrake', 'brake'); hold('#tDrift', 'drift');
  const tap = (id, name) => root.querySelector(id).addEventListener('pointerdown', (e) => { e.preventDefault(); edges.add(name); });
  tap('#tView', 'view'); tap('#tPause', 'pause');

  // 分頁切走或跳出系統手勢時手指事件可能收不到：全部放開
  addEventListener('blur', () => { T.steer = 0; T.gas = T.brake = T.drift = false; steerId = null; knob.style.transform = ''; root.querySelectorAll('.on').forEach((el) => el.classList.remove('on')); });
  // 長按不要跳出選單、不要選取文字
  hudEl.addEventListener('contextmenu', (e) => { if (T.enabled) e.preventDefault(); });

  if (force || matchMedia('(pointer: coarse)').matches) T.enable();
  else addEventListener('touchstart', () => T.enable(), { once: true, passive: true });   // 有觸控螢幕的筆電：第一次碰螢幕才開
  return T;
}
