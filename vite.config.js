import { defineConfig } from 'vite';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// 背景音樂清單：掃 public/audio/bgm 資料夾，丟進去的 mp3 / ogg 就會進隨機歌單，不用手動維護。
//   資料夾最上層的檔案 → pool（隨機輪播）
//   子資料夾 → folders[資料夾名]（留給之後的專屬 BGM，例如 boss/）
//   同名的 .lrc → lyrics（有歌詞字幕的歌，不含副檔名）
// 開發伺服器執行中新增或刪除檔案會自動重新整理。
function bgmList() {
  const id = 'virtual:bgm-list', rid = '\0' + id;
  const dir = resolve(import.meta.dirname, 'public/audio/bgm');
  const isAudio = (n) => /\.(mp3|ogg|m4a|wav)$/i.test(n);
  const scan = () => {
    const out = { pool: [], folders: {}, lyrics: [] };
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      if (e.isFile() && isAudio(e.name)) out.pool.push(e.name);
      else if (e.isFile() && /\.lrc$/i.test(e.name)) out.lyrics.push(e.name.replace(/\.lrc$/i, ''));
      else if (e.isDirectory()) {
        const list = readdirSync(resolve(dir, e.name)).filter(isAudio).sort().map((n) => `${e.name}/${n}`);
        if (list.length) out.folders[e.name] = list;
      }
    }
    out.pool.sort();
    return out;
  };
  return {
    name: 'bgm-list',
    resolveId(source) { return source === id ? rid : null; },
    load(x) { return x === rid ? `export default ${JSON.stringify(scan())};` : null; },
    configureServer(server) {
      const refresh = (file) => {
        if (!resolve(file).startsWith(dir) || !(isAudio(file) || /\.lrc$/i.test(file))) return;
        const mod = server.moduleGraph.getModuleById(rid);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.on('add', refresh);
      server.watcher.on('unlink', refresh);
    },
  };
}

// base 用相對路徑：建置出來的檔案放在網域根目錄或子路徑（GitHub Pages 的 /racerRoguelike/）都能跑
export default defineConfig({
  base: './',
  plugins: [bgmList()],
});
