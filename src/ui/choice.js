// 三選一卡片與 PA 商店的畫面。內容只在選單版本變動時重畫，倒數條每幀更新。
const CATEGORY = { part: '零件', skill: '駕駛技能', tradeoff: '取捨', pa: '補給' };
const RARITY = { common: '普通', rare: '稀有', legendary: '傳說' };
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function card(def, { key, price, sold, active, count, cantAfford }) {
  return `<div class="card r-${def.rarity}${active ? ' active' : ''}${sold ? ' sold' : ''}">
    <div class="ckey">${key || ''}</div>
    <div class="cmeta">${CATEGORY[def.category] || ''}・${RARITY[def.rarity] || ''}</div>
    <div class="cname">${esc(def.name)}${count > 1 ? ` ×${count}` : ''}</div>
    <div class="cdesc">${esc(def.desc)}</div>
    ${price != null ? `<div class="cprice${cantAfford ? ' no' : ''}">${sold ? '已售出' : `賞金 ${price}`}</div>` : ''}
  </div>`;
}

export function createChoiceUi() {
  const root = document.getElementById('menu');
  const title = document.getElementById('menuTitle');
  const body = document.getElementById('menuBody');
  const hint = document.getElementById('menuHint');
  const bar = document.getElementById('menuBar');
  const ownedEl = document.getElementById('owned');
  let seen = -1, ownedKey = '';

  return {
    /** menus：session.menus；run：session.run；upgrades：session.upgrades */
    update(menus, run, upgrades) {
      const m = menus.current;
      if (menus.version !== seen) {
        seen = menus.version;
        root.style.display = m ? 'block' : 'none';
        document.body.classList.toggle('menu-open', !!m); // 選單開著時收起時速表與按鍵說明，避免重疊
        if (m && m.kind === 'choice' && m.shop) {
          // PA 休息站：同一個三選一畫面，只是每張都要用賞金買
          title.textContent = `PA 休息站　賞金 ${run.bounty}`;
          const keys = ['←', '↑', '→'];
          body.innerHTML = m.cards.map((d, i) => card(d, { key: keys[i], count: d.time ? 0 : upgrades.count(d.id) + 1, price: m.prices[i], cantAfford: run.bounty < m.prices[i] })).join('');
          hint.textContent = `買一樣就上路　↓ 不買，離開${m.note ? '　｜　' + m.note : ''}`;
        } else if (m && m.kind === 'choice') {
          title.textContent = '選擇一項成長';
          const keys = m.cards.length === 3 ? ['←', '↑', '→'] : m.cards.length === 2 ? ['←', '→'] : ['↑'];
          body.innerHTML = m.cards.map((d, i) => card(d, { key: keys[i], count: upgrades.count(d.id) + 1 })).join('');
          hint.textContent = '↓ 都不要，改拿賞金';
        } else if (m && m.kind === 'shop') {
          if (m.mode === 'remove') {
            title.textContent = '移除哪一個成長？';
            body.innerHTML = upgrades.list().map((it, i) => card(it.def, { active: i === m.rcursor, count: it.count })).join('');
            hint.textContent = '← → 選擇　↑ 移除　↓ 返回';
          } else {
            title.textContent = `PA 休息站　賞金 ${run.bounty}`;
            const n = m.stock.length;
            body.innerHTML = m.stock.map((it, i) => card(it.def, {
              price: it.price, sold: it.sold, active: i === m.cursor, cantAfford: !it.sold && run.bounty < it.price,
            })).join('')
              + `<div class="card action${m.cursor === n ? ' active' : ''}${m.removed ? ' sold' : ''}"><div class="cname">移除一個成長</div><div class="cdesc">${m.removed ? '已使用' : '免費，每次進站一次'}</div></div>`
              + `<div class="card action${m.cursor === n + 1 ? ' active' : ''}"><div class="cname">離開</div><div class="cdesc">回到路上</div></div>`;
            hint.textContent = `← → 選擇　↑ 確認　↓ 離開${m.note ? '　｜　' + m.note : ''}`;
          }
        }
      }
      if (m) bar.style.width = Number.isFinite(m.timer) ? `${Math.max(0, (m.timer / m.total) * 100).toFixed(1)}%` : '0%';

      // 持有的成長（左上）
      const list = upgrades.list();
      const key = list.map((it) => `${it.def.id}${it.count}`).join(',');
      if (key !== ownedKey) {
        ownedKey = key;
        ownedEl.innerHTML = list.map((it) => `<span class="r-${it.def.rarity}" title="${esc(it.def.desc)}">${esc(it.def.name)}${it.count > 1 ? ` ×${it.count}` : ''}</span>`).join('');
      }
    },
  };
}
