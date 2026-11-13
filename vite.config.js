import { defineConfig } from 'vite';

// base 用相對路徑：建置出來的檔案放在網域根目錄或子路徑（GitHub Pages 的 /racerRoguelike/）都能跑
export default defineConfig({
  base: './',
});
