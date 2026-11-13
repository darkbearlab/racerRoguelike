// 鍵盤＋手把輸入。held 值給物理用，edge（剛按下）每個渲染幀取一次。
const PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const DEADZONE = 0.14;

function curve(v) {
  const a = Math.abs(v);
  if (a < DEADZONE) return 0;
  const n = (a - DEADZONE) / (1 - DEADZONE);
  return Math.sign(v) * n * n * n * 0.6 + Math.sign(v) * n * 0.4;
}

export function createInput() {
  const keys = new Set();
  const pressed = new Set();
  let padPrev = [];
  let padEdges = new Set();

  addEventListener('keydown', (e) => {
    if (PREVENT.has(e.code)) e.preventDefault();
    if (!e.repeat) pressed.add(e.code);
    keys.add(e.code);
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());

  const held = { throttle: 0, brake: 0, steer: 0, handbrake: false, lookBack: false, analog: false };

  function pollPad() {
    padEdges = new Set();
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = Array.from(pads).find((p) => p && p.connected);
    if (!gp) { padPrev = []; return null; }
    const b = gp.buttons.map((x) => x.value);
    b.forEach((v, i) => { if (v > 0.5 && !(padPrev[i] > 0.5)) padEdges.add(i); });
    padPrev = b;
    return { axes: gp.axes, b };
  }

  return {
    held,
    /** 每個渲染幀呼叫一次，回傳本幀的 edge 事件。 */
    poll() {
      const k = (c) => keys.has(c);
      const pad = pollPad();

      let throttle = k('KeyW') || k('ArrowUp') ? 1 : 0;
      let brake = k('KeyS') || k('ArrowDown') ? 1 : 0;
      let steer = (k('KeyA') || k('ArrowLeft') ? 1 : 0) - (k('KeyD') || k('ArrowRight') ? 1 : 0);
      let handbrake = k('Space');
      let lookBack = k('KeyQ');
      let analog = false;

      if (pad) {
        const ax = curve(pad.axes[0] || 0);
        if (ax !== 0 && steer === 0) { steer = -ax; analog = true; }
        throttle = Math.max(throttle, pad.b[7] || 0);
        brake = Math.max(brake, pad.b[6] || 0);
        handbrake = handbrake || pad.b[0] > 0.5;
        lookBack = lookBack || pad.b[4] > 0.5;
      }

      held.throttle = throttle;
      held.brake = brake;
      held.steer = steer; // +1 = 左
      held.handbrake = handbrake;
      held.lookBack = lookBack;
      held.analog = analog;

      // 選單用的方向（剛按下才算）：三選一與 PA 商店
      const menu = pressed.has('ArrowLeft') || pressed.has('KeyA') || padEdges.has(14) ? 'left'
        : pressed.has('ArrowRight') || pressed.has('KeyD') || padEdges.has(15) ? 'right'
        : pressed.has('ArrowUp') || pressed.has('KeyW') || padEdges.has(12) ? 'up'
        : pressed.has('ArrowDown') || pressed.has('KeyS') || padEdges.has(13) ? 'down' : null;
      const edges = {
        menu,
        view: pressed.has('KeyC') || padEdges.has(11),
        flash: pressed.has('KeyH') || padEdges.has(3),
        pause: pressed.has('Escape') || padEdges.has(9),
      };
      pressed.clear();
      return edges;
    },
  };
}
