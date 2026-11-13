// 天亮時鐘：整局唯一的失敗資源。純邏輯。
// 每晚從 00:00 走到 05:00，現實 1 秒 = 遊戲 25 秒；時鐘永遠在走，選成長時只是變慢。
export function createClock(cfg) {
  const c = {
    minute: cfg.startMinute,   // 遊戲內的分鐘數（可帶小數）
    scale: 1,                  // 1 正常、choiceSlowdown 選成長時
    dawn: false,
    penaltyTotal: 0,

    update(dt) {
      if (c.dawn) return;
      c.minute += (dt * cfg.gameSecondsPerRealSecond * c.scale) / 60;
      if (c.minute >= cfg.dawnMinute) { c.minute = cfg.dawnMinute; c.dawn = true; }
    },
    /** 扣時間（落敗、PA）；負值 = 退回時間（捷徑） */
    spend(minutes) {
      c.penaltyTotal += minutes;
      c.minute = Math.max(cfg.startMinute, c.minute + minutes);
      if (c.minute >= cfg.dawnMinute) { c.minute = cfg.dawnMinute; c.dawn = true; }
    },
    setChoosing(on) { c.scale = on ? cfg.choiceSlowdown : 1; },
    /** 進入下一晚：回到 00:00 */
    reset() { c.minute = cfg.startMinute; c.dawn = false; },

    get remaining() { return cfg.dawnMinute - c.minute; },
    /** 0（入夜）→ 1（天亮） */
    get progress() { return (c.minute - cfg.startMinute) / (cfg.dawnMinute - cfg.startMinute); },
    get warning() { return c.remaining <= cfg.warnMinutes; },
    /** "03:42" */
    get text() {
      const m = Math.floor(c.minute);
      return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    },
  };
  return c;
}
