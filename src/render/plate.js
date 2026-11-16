import * as THREE from 'three';

// 車牌：虛構的格式（兩個英文字＋四個數字），白底深色字。
// 玩家與對手各自一張貼圖；車流共用一張圖集（COLS × ROWS 張），每台車用其中一格。
export const PLATE_W = 0.46, PLATE_H = 0.19;   // 公尺（比實物略大一點，後方視角才看得清楚）
export const COLS = 4, ROWS = 8;
const CW = 128, CH = 52;
const LETTERS = 'ABCDEFGHJKLMNPRSTUVWXYZ';

export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** 由一個整數決定的車牌號碼 */
export function plateText(n) {
  let x = (n >>> 0) || 1;
  const next = (m) => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return (x >>> 8) % m; };
  return `${LETTERS[next(LETTERS.length)]}${LETTERS[next(LETTERS.length)]}-${String(next(10000)).padStart(4, '0')}`;
}

function draw(g, x, y, text) {
  g.fillStyle = '#e9e9e4'; g.fillRect(x, y, CW, CH);
  g.strokeStyle = '#1b1d22'; g.lineWidth = 3; g.strokeRect(x + 3.5, y + 3.5, CW - 7, CH - 7);
  g.fillStyle = '#14161a';
  g.font = '700 31px "Arial Narrow", "Roboto Condensed", Arial, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, x + CW / 2, y + CH / 2 + 2, CW - 16);
}

/** 單張車牌的貼圖，回傳 { texture, set(text) } */
export function createPlateTexture(text) {
  const c = document.createElement('canvas');
  c.width = CW; c.height = CH;
  const g = c.getContext('2d');
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const set = (t) => { draw(g, 0, 0, t); texture.needsUpdate = true; };
  set(text);
  return { texture, set };
}

/** 車流用的圖集 */
export function createPlateAtlas(seed = 7) {
  const c = document.createElement('canvas');
  c.width = CW * COLS; c.height = CH * ROWS;
  const g = c.getContext('2d');
  for (let i = 0; i < COLS * ROWS; i++) draw(g, (i % COLS) * CW, Math.floor(i / COLS) * CH, plateText(seed * 7919 + i * 104729));
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}
