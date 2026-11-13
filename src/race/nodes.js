// 節點類型與選項抽選。純資料與邏輯。
// 每個交流道的兩條分支各通往一個節點。
export const NODE_TYPES = {
  rival: { icon: '⚔', name: '對手', tier: 'normal' },
  elite: { icon: '☠', name: '強敵', tier: 'elite' },
  pa: { icon: '⛽', name: 'PA 休息站' },
  event: { icon: '❓', name: '事件' },
  shortcut: { icon: '↪', name: '捷徑' },
  boss: { icon: '♛', name: 'Boss', tier: 'boss' },
};

export const EVENT_NAMES = { jam: '塞車', police: '警察盤查', mystery: '神秘車輛', delivery: '代送包裹' };

const isDuel = (t) => t === 'rival' || t === 'elite';

function pickWeighted(rng, weights) {
  const types = Object.keys(weights);
  const total = types.reduce((a, k) => a + weights[k], 0);
  let r = rng.next() * total;
  for (const k of types) { r -= weights[k]; if (r <= 0) return k; }
  return types[0];
}

/**
 * 抽兩個不同的節點（左、右）。至少一邊是對決，避免玩家卡在沒有對手可打。
 * boss = true 時其中一條分支固定為 Boss。
 */
export function rollOptions(rng, weights, boss = false) {
  if (boss) {
    const other = pickWeighted(rng, weights);
    return rng.next() < 0.5 ? ['boss', other] : [other, 'boss'];
  }
  let a = pickWeighted(rng, weights), b = pickWeighted(rng, weights), guard = 0;
  while ((a === b || (!isDuel(a) && !isDuel(b))) && guard++ < 30) b = pickWeighted(rng, weights);
  if (a === b || (!isDuel(a) && !isDuel(b))) b = a === 'rival' ? 'elite' : 'rival';
  return rng.next() < 0.5 ? [a, b] : [b, a];
}

export function rollEvent(rng, weights) {
  return pickWeighted(rng, weights);
}
