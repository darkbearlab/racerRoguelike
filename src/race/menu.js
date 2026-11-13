// 路上的選單：獲勝後的三選一、PA 商店。純邏輯，不依賴畫面。
// 三選一：世界停住、沒有時間限制。商店：車子由自動駕駛保持車道、時鐘變慢但不暫停。操作只有四個方向。
//
//   三選一：← 左卡、↑ 中卡、→ 右卡；↓ 都不要，改拿賞金
//   商店：  ← → 移動游標、↑ 確認、↓ 離開（移除模式下 ↓ 是返回）
export function createMenus({ upgrades, rng, run, emit, pa, onTime }) {
  const rules = upgrades.rules;
  const M = {
    current: null,   // { kind: 'choice' | 'shop', ... }
    version: 0,      // 內容每變一次就 +1，畫面據此重畫

    openChoice(tier) {
      const cards = upgrades.offer(rng, tier, 3);
      if (!cards.length) {
        // 沒有成長可拿了：直接給賞金
        run.bounty += rules.skipBounty;
        emit('menuSkipped', { bounty: rules.skipBounty, empty: true });
        return false;
      }
      M.current = { kind: 'choice', tier, cards, timer: Infinity, total: Infinity, lock: rules.lockSeconds };
      M.version++;
      emit('menuOpen', { kind: 'choice' });
      return true;
    },

    /** PA 休息站：和三選一同一個畫面，只是要用賞金買。第一張固定是買時間，另外兩張是隨機抽的成長 */
    openPa() {
      const mins = pa?.timeMinutes ?? 20;
      const time = { id: '_time', time: mins, name: '補給休息', category: 'pa', rarity: 'common', desc: `天亮延後 ${mins} 分鐘` };
      const cards = [time, ...upgrades.offer(rng, 'shop', 2)];
      const prices = cards.map((d) => (d.time ? pa?.timePrice ?? 120 : upgrades.price(d)));
      M.current = { kind: 'choice', shop: true, tier: 'shop', cards, prices, timer: Infinity, total: Infinity, lock: rules.lockSeconds, note: '' };
      M.version++;
      emit('menuOpen', { kind: 'pa' });
      return true;
    },

    openShop() {
      const stock = upgrades.offer(rng, 'shop', 3).map((def) => ({ def, price: upgrades.price(def), sold: false }));
      M.current = {
        kind: 'shop', stock, cursor: 0, mode: 'buy', rcursor: 0, removed: false,
        timer: rules.shopSeconds, total: rules.shopSeconds, lock: rules.lockSeconds, note: '',
      };
      M.version++;
      emit('menuOpen', { kind: 'shop' });
      return true;
    },

    close(reason) {
      const m = M.current;
      if (!m) return;
      M.current = null;
      M.version++;
      emit('menuClose', { kind: m.kind, reason });
    },

    /** 商店游標的項目數：商品 + 移除 + 離開 */
    shopEntries(m) { return m.stock.length + 2; },

    /** dir：'left' | 'up' | 'right' | 'down' */
    input(dir) {
      const m = M.current;
      if (!m || m.lock > 0) return false;
      if (m.kind === 'choice') {
        if (m.shop) {
          if (dir === 'down') { M.close('left'); return true; }
          const k = dir === 'left' ? 0 : dir === 'up' ? 1 : dir === 'right' ? 2 : -1;
          if (k < 0 || k >= m.cards.length) return false;
          const d = m.cards[k], price = m.prices[k];
          if (run.bounty < price) { m.note = '賞金不足'; M.version++; return false; }
          run.bounty -= price;
          if (d.time) { if (onTime) onTime(d.time); emit('timeBought', { minutes: d.time, price }); }
          else { upgrades.add(d.id); emit('upgradeGained', { def: d, from: 'shop', price }); }
          M.close('picked');
          return true;
        }
        if (dir === 'down') {
          // 都不要：改拿賞金
          run.bounty += rules.skipBounty;
          emit('menuSkipped', { bounty: rules.skipBounty });
          M.close('skipped');
          return true;
        }
        const i = dir === 'left' ? 0 : dir === 'up' ? 1 : dir === 'right' ? 2 : -1;
        // 只有兩張時 ← →；只有一張時三個方向都選它
        const idx = m.cards.length === 1 ? (i >= 0 ? 0 : -1) : m.cards.length === 2 ? (i === 0 ? 0 : i === 2 ? 1 : -1) : i;
        if (idx < 0 || idx >= m.cards.length) return false;
        const def = m.cards[idx];
        upgrades.add(def.id);
        emit('upgradeGained', { def, from: 'choice' });
        M.close('picked');
        return true;
      }
      // ── 商店
      if (m.mode === 'remove') {
        const list = upgrades.list();
        if (dir === 'left') m.rcursor = (m.rcursor + list.length - 1) % list.length;
        else if (dir === 'right') m.rcursor = (m.rcursor + 1) % list.length;
        else if (dir === 'down') m.mode = 'buy';
        else if (dir === 'up') {
          const it = list[m.rcursor];
          if (it) {
            upgrades.remove(it.def.id);
            m.removed = true; m.mode = 'buy';
            m.note = `已移除：${it.def.name}`;
            emit('upgradeRemoved', { def: it.def });
          }
        }
        M.version++;
        return true;
      }
      const n = M.shopEntries(m);
      if (dir === 'left') m.cursor = (m.cursor + n - 1) % n;
      else if (dir === 'right') m.cursor = (m.cursor + 1) % n;
      else if (dir === 'down') { M.close('left'); return true; }
      else if (dir === 'up') {
        if (m.cursor < m.stock.length) {
          const it = m.stock[m.cursor];
          if (it.sold) m.note = '已售出';
          else if (run.bounty < it.price) m.note = '賞金不足';
          else if (!upgrades.canTake(it.def)) m.note = '已達持有上限';
          else {
            run.bounty -= it.price;
            upgrades.add(it.def.id);
            it.sold = true;
            m.note = `已購買：${it.def.name}`;
            emit('upgradeGained', { def: it.def, from: 'shop', price: it.price });
          }
        } else if (m.cursor === m.stock.length) {
          if (m.removed) m.note = '每次只能移除一個';
          else if (!upgrades.total) m.note = '沒有可移除的成長';
          else { m.mode = 'remove'; m.rcursor = 0; m.note = ''; }
        } else { M.close('left'); return true; }
      }
      M.version++;
      return true;
    },

    /** dt 是現實時間 */
    update(dt) {
      const m = M.current;
      if (!m) return;
      if (m.lock > 0) m.lock -= dt;
      if (m.kind === 'choice') return;   // 三選一沒有時間限制
      m.timer -= dt;
      if (m.timer <= 0) M.close('timeout');
    },
  };
  return M;
}
