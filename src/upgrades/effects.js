// 成長效果：資料驅動。每個效果是「對某個參數做 add / mul / set」，
// 參數依前綴分屬三個對象：car.（玩家車輛）、duel.（對決規則）、world.（環境）。
// 需要特殊邏輯的成長用 hook 掛到事件上，實際動作在 ACTIONS 裡。純邏輯。

/**
 * 由基準值與持有的成長算出生效值，寫進 out（原地更新，其他模組拿的參考不會失效）。
 * 計算順序：(基準 + 所有 add) × 所有 mul；有 set 時以最後一個 set 為準。
 * owned：[{ def, count }]；root：'car' | 'duel' | 'world'
 */
export function computeTargets(root, base, owned, out) {
  const add = {}, mul = {}, set = {};
  for (const { def, count } of owned) {
    for (const e of def.effects || []) {
      const [r, key] = e.target.split('.');
      if (r !== root) continue;
      for (let n = 0; n < count; n++) {
        if (e.op === 'add') add[key] = (add[key] || 0) + e.value;
        else if (e.op === 'mul') mul[key] = (mul[key] ?? 1) * e.value;
        else if (e.op === 'set') set[key] = e.value;
      }
    }
  }
  for (const key of Object.keys(base)) {
    let v = base[key];
    if (typeof v === 'number') {
      if (key in set) v = set[key];
      else v = (v + (add[key] || 0)) * (mul[key] ?? 1);
    }
    out[key] = v;
  }
  return out;
}

/** hook 觸發時的動作。S = session，p = 成長資料裡的 params，count = 疊加數 */
export const ACTIONS = {
  /** 短暫加速：一段時間內額外的推力 */
  boost(S, p, count, payload) {
    if (payload && p.minDrift && payload.time < p.minDrift) return false;
    S.boostT = p.seconds;
    S.state.boostAccel = p.accel * count;
    return true;
  },
  /** 扣時間 */
  loseTime(S, p, count) {
    if (S.clock) S.clock.spend(p.minutes * count);
    return true;
  },
};
