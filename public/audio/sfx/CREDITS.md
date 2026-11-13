# 音效來源（public/audio/sfx/）

全部剪自 **Sonniss GameAudioGDC Bundle**（免版稅，可商用，可放進遊戲成品；**不可把原始音檔當素材庫散布**，所以這個資料夾不要推到公開 repo）。
已轉成 OGG（q5、48 kHz），並剪短、正規化。

| 檔案 | 來源包 |
|---|---|
| crash_light_01–05 | Pole Position Production – Bumper Cars |
| crash_metal_01、wall_scrape_01 | Mechanical Wave – Torturing Metal |
| glass_break_01、glass_break_small_01、crash_debris_01 | BluezoneCorp – Broken Glass |
| crash_heavy_01 | 上面三包疊層混成 |
| shift_paddle_01–03 | Pole Position Production – Audi RS 4 2013 |
| horn_01–03 | Pole Position Production – Dodge Viper GTS V10 Race Engine 2014 |
| engine_start_01 | Pole Position Production – Porsche Carrera GT 2005 |
| amb_motorway_night_loop | InMotionAudio – UK Motorway（已做無縫循環） |
| passby_jdm_a_01–03、passby_jdm_b_01–03 | SoundHolder – Race Track Passes – Japanese Cars |
| passby_gt_01–02 | Sonic Bat – Ambisonics – GT Series Pass-By |

引擎持續聲、渦輪、洩壓、輪胎尖叫、風切、回火爆音都不是錄音，是 `src/audio/carSynth.js` 用 Web Audio 即時合成的（Sonniss 裡沒有好用的胎嘯和可循環引擎聲）。
