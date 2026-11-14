// 對決中的無線電視窗：對手的頭像（車後投影那個標誌）＋逐字打出的台詞。
// 台詞池在 config/radio.json；這裡只管「什麼時候講哪一類」與畫面。
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** 一般對手依數值分個性：衝動、冷靜、菜鳥 */
function typeOf(def) {
  if (def.tier === 'police') return 'police';
  if ((def.mistake ?? 0) >= 0.3) return 'rookie';
  if ((def.aggression ?? 0) >= 0.8) return 'hot';
  return 'cool';
}

/**
 * opts：{ events, duel, rival, cfg（radio.json）, glyphOf(def) → { glyph, color }, onSpeak() }
 * 回傳 { update(dt), say(kind, force), last }
 */
export function createRadio({ events, duel, rival, cfg, glyphOf, onSpeak }) {
  const root = document.getElementById('radio');
  const elFace = document.getElementById('radioFace'), elName = document.getElementById('radioName'), elText = document.getElementById('radioText');
  const lastLine = {};
  let full = '', shown = 0, typeT = 0, holdT = 0, cool = 0, flags = {};
  const api = { last: null, count: 0 };

  function pick(def, kind) {
    const own = cfg.byId[def.id]?.[kind];
    const list = own && own.length ? own : cfg.types[typeOf(def)]?.[kind];
    if (!list || !list.length) return null;
    const key = `${def.id}:${kind}`;
    let line;
    do line = list[Math.floor(Math.random() * list.length)]; while (list.length > 1 && line === lastLine[key]);
    lastLine[key] = line;
    return line;
  }

  /** force：不管冷卻（開戰、勝負這種一定要講的） */
  api.say = (kind, force = false) => {
    const def = rival.def;
    if (!def || def.tier === 'courier' || (!force && cool > 0)) return false;
    const line = pick(def, kind);
    if (!line) return false;
    const g = glyphOf(def);
    elFace.textContent = g.glyph || '？';
    elFace.style.borderColor = g.color; elFace.style.color = g.color;
    elName.textContent = def.name;
    full = line; shown = 0; typeT = 0; holdT = 2.6 + line.length * 0.09;
    elText.textContent = '';
    root.classList.add('on');
    cool = cfg.minGap ?? 5.5;
    api.last = { kind, line, id: def.id }; api.count++;
    if (onSpeak) onSpeak();
    return true;
  };

  events.on('rivalMarked', () => { flags = {}; setTimeout(() => api.say('intro', true), 900); });
  events.on('bossIntro', () => { flags = {}; });            // Boss 的登場台詞在登場卡上，這裡不重複
  events.on('duelGo', () => api.say('go', true));
  events.on('duelZero', (e) => api.say(e.who === 'player' ? 'lead' : 'passed'));
  events.on('duelEnd', (e) => setTimeout(() => api.say(e.win ? 'lose' : 'win', true), 1300));
  events.on('wallHit', (e) => { if (duel.phase === 'racing' && (e.speedLoss || 0) > 5) api.say('wall'); });
  events.on('carHit', (e) => { if (e.rival && duel.phase === 'racing') api.say('bump'); });

  api.update = (dt) => {
    if (cool > 0) cool -= dt;
    // 分數過七成：各講一次
    if (duel.phase === 'racing') {
      if (!flags.winning && duel.scoreR > duel.target * 0.7) { flags.winning = true; api.say('winning', true); }
      if (!flags.losing && duel.scoreP > duel.target * 0.7) { flags.losing = true; api.say('losing', true); }
    }
    if (!root.classList.contains('on')) return;
    if (shown < full.length) {
      typeT += dt;
      const n = Math.min(full.length, Math.floor(typeT / 0.045));
      if (n !== shown) { shown = n; elText.innerHTML = esc(full.slice(0, shown)); }
    } else {
      holdT -= dt;
      if (holdT <= 0) root.classList.remove('on');
    }
  };
  return api;
}
