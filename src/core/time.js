// 固定步長物理（60 Hz）＋ requestAnimationFrame 渲染，渲染用 alpha 內插。
export const FIXED_DT = 1 / 60;
const MAX_STEPS = 5;

export function createLoop({ step, render }) {
  let last = 0;
  let acc = 0;
  let running = false;
  const stats = { fps: 60, steps: 0, frameMs: 16.7 };

  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.25) dt = 0.25; // 分頁切回來時不要暴衝
    stats.frameMs += (dt * 1000 - stats.frameMs) * 0.05;
    stats.fps = 1000 / stats.frameMs;

    acc += dt;
    let n = 0;
    while (acc >= FIXED_DT && n < MAX_STEPS) {
      step(FIXED_DT);
      acc -= FIXED_DT;
      n++;
    }
    if (n === MAX_STEPS) acc = 0;
    stats.steps = n;
    render(acc / FIXED_DT, dt);
  }

  return {
    stats,
    start() {
      if (running) return;
      running = true;
      last = performance.now();
      requestAnimationFrame(frame);
    },
    stop() { running = false; },
  };
}
