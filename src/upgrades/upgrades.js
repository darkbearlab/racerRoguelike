// 成長系統：持有清單、生效值重算、三選一與商店的抽選。純邏輯，不依賴 three.js。
import { computeTargets, ACTIONS } from './effects.js';

/**
 * cfg：config/upgrades.json
 * targets：{ car: { base, out }, duel: { base, out }, world: { base, out } }
 *   base 是基準值（可被熱更新），out 是其他模組實際讀取的物件，recompute() 原地改寫。
 */
export function createUpgrades(cfg, targets) {
  const rules = cfg.rules;
  const defs = new Map(cfg.list.map((d) => [d.id, d]));
  const owned = new Map(); // id → count
  const U = {
    rules,
    defs,
    /** 持有清單（依取得順序）：[{ def, count }] */
    list() { return [...owned].map(([id, count]) => ({ def: defs.get(id), count })); },
    count(id) { return owned.get(id) || 0; },
    get total() { let n = 0; for (const c of owned.values()) n += c; return n; },

    canTake(def) {
      const n = owned.get(def.id) || 0;
      return def.stackable ? n < rules.maxStack : n === 0;
    },
    add(id) {
      const def = defs.get(id);
      if (!def || !U.canTake(def)) return false;
      owned.set(id, (owned.get(id) || 0) + 1);
      U.recompute();
      return true;
    },
    remove(id) {
      const n = owned.get(id) || 0;
      if (!n) return false;
      if (n > 1) owned.set(id, n - 1); else owned.delete(id);
      U.recompute();
      return true;
    },
    clear() { owned.clear(); U.recompute(); },

    /** 依基準值與持有的成長重算所有生效值 */
    recompute() {
      const list = U.list();
      for (const root of Object.keys(targets)) computeTargets(root, targets[root].base, list, targets[root].out);
    },

    /** 觸發 hook：回傳實際生效的成長 id */
    fire(hook, S, payload) {
      const fired = [];
      for (const [id, count] of owned) {
        const def = defs.get(id);
        if (def.hook !== hook) continue;
        const act = ACTIONS[def.action];
        if (act && act(S, def.params || {}, count, payload)) fired.push(id);
      }
      return fired;
    },

    price(def) { return rules.prices[def.rarity] ?? rules.prices.common; },

    /**
     * 抽 n 個不重複、目前拿得了的成長。tier：normal / elite / boss / shop，決定稀有度機率。
     * 強敵與 Boss 保證至少一張稀有以上（池子裡有的話）。
     */
    offer(rng, tier, n = 3) {
      const weights = rules.rarityWeights[tier] || rules.rarityWeights.normal;
      const pool = cfg.list.filter((d) => U.canTake(d));
      const out = [];
      const draw = (filter) => {
        const cand = pool.filter((d) => !out.includes(d) && (!filter || filter(d)));
        if (!cand.length) return null;
        let total = 0;
        for (const d of cand) total += weights[d.rarity] || 1;
        let r = rng.next() * total;
        for (const d of cand) { r -= weights[d.rarity] || 1; if (r <= 0) return d; }
        return cand[cand.length - 1];
      };
      if (rules.guaranteeRareFor.includes(tier)) {
        const d = draw((x) => x.rarity !== 'common');
        if (d) out.push(d);
      }
      while (out.length < n) {
        const d = draw();
        if (!d) break;
        out.push(d);
      }
      // 保證的那張不要永遠在第一格
      if (out.length > 1 && rng.next() < 0.66) {
        const k = 1 + Math.floor(rng.next() * (out.length - 1));
        [out[0], out[k]] = [out[k], out[0]];
      }
      return out;
    },
  };
  U.recompute();
  return U;
}
