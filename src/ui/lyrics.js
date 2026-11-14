// 直式歌詞字幕：畫面右側，跟著目前播放的那首歌走。
// 歌詞檔是和 mp3 同名的 .lrc（每行 [分:秒.百分秒]歌詞）；有哪些歌有歌詞由 vite.config.js 掃資料夾得知，
// 所以把整理好的 .lrc 丟進 public/audio/bgm 就會自動帶出來，不用改程式。
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const MAX_HOLD = 9;      // 一句最多留幾秒（.lrc 只有開始時間，間奏時要自己收掉）
const LEAD = 0.15;       // 提前一點點出現，眼睛才跟得上

export function parseLrc(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!tags.length) continue;                       // [ti:…] [by:…] 這類檔頭沒有時間，跳過
    const words = raw.replace(/\[[^\]]*\]/g, '').trim();
    if (!words) continue;
    for (const m of tags) out.push({ t: Number(m[1]) * 60 + Number(m[2]), text: words });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** 一句拆成幾直行：日文片語之間的空白換行；英文單字之間的空白留著（英文會整段側躺） */
function columns(text) {
  const parts = [];
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ((ch === ' ' || ch === '　') && cur) {
      const a = text.charCodeAt(i - 1) < 128, b = i + 1 < text.length && text.charCodeAt(i + 1) < 128;
      if (a && b) cur += ' '; else { parts.push(cur); cur = ''; }
    } else if (ch !== ' ' && ch !== '　') cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

/**
 * opts：{ audio（gameAudio）, list（有歌詞的檔名，不含副檔名）, base（歌詞所在的網址前綴）}
 * 回傳 { update(), enabled, offset, stats }
 */
export function createLyrics({ audio, list, base }) {
  const root = document.getElementById('lyrics');
  const has = new Set(list);
  const cache = new Map();   // 檔名 → 解析好的歌詞（或 null = 讀不到）
  let track = '', lines = null, shown = -2;
  const api = { enabled: true, offset: 0, stats: { track: '', lines: 0, index: -1, text: '' } };

  function load(name) {
    if (cache.has(name)) { lines = cache.get(name); return; }
    lines = null;
    cache.set(name, null);
    fetch(`${base}${encodeURI(name)}.lrc`).then((r) => (r.ok ? r.text() : '')).then((txt) => {
      const parsed = txt ? parseLrc(txt) : null;
      cache.set(name, parsed && parsed.length ? parsed : null);
      if (track === name) { lines = cache.get(name); shown = -2; }
    }).catch(() => {});
  }

  function show(i) {
    shown = i;
    api.stats.index = i; api.stats.text = i >= 0 ? lines[i].text : '';
    if (i < 0) { root.classList.remove('on'); return; }
    root.innerHTML = columns(lines[i].text).map((c) => `<span>${esc(c)}</span>`).join('');
    // 重新觸發淡入
    root.classList.remove('on'); void root.offsetWidth; root.classList.add('on');
  }

  api.update = () => {
    const deck = audio.deck;
    const name = deck ? deck.name.replace(/\.[^.]+$/, '') : '';
    if (name !== track) {
      track = name; shown = -2; lines = null;
      api.stats.track = name;
      if (name && has.has(name)) load(name);
    }
    api.stats.lines = lines ? lines.length : 0;
    if (!api.enabled || !lines || !deck) { if (shown !== -1) show(-1); return; }
    const t = deck.el.currentTime + LEAD - api.offset;
    let i = -1;
    for (let k = 0; k < lines.length && lines[k].t <= t; k++) i = k;
    if (i >= 0) {
      const end = Math.min(i + 1 < lines.length ? lines[i + 1].t : Infinity, lines[i].t + MAX_HOLD);
      if (t >= end) i = -1;
    }
    if (i !== shown) show(i);
  };
  return api;
}
