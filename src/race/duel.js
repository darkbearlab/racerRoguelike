// 對決規則：只有領先超過門檻距離的一方累積分數，被超車歸零，先到目標分者勝。
// 純邏輯，不依賴 three.js。
//
//   gap = s_玩家 − s_對手（沿道路距離，彎道上也正確）
//   phase: idle → marked（已標示，等挑戰）→ countdown → racing → result → idle
export function createDuel(cfg, events) {
  const emit = (name, payload) => { if (events) events.emit(name, payload); };
  const d = {
    phase: 'idle',
    gap: 0,
    leader: 0,          // +1 玩家領先、−1 對手領先、0 尚未分出
    scoreP: 0, scoreR: 0,
    target: cfg.targets.normal,
    rate: 0,            // 目前每秒得分（給 HUD）
    scoring: 0,         // +1 玩家正在得分、−1 對手正在得分
    timer: 0, count: 0, stopT: 0, time: 0,
    result: null,       // { win, reason }
    // 成長系統可修改的規則參數
    mods: { threshold: cfg.threshold, scoreMul: 1, keepOnOvertaken: 0 },

    /** 標示一位對手 */
    mark(tier = 'normal') {
      d.phase = 'marked';
      d.target = cfg.targets[tier] ?? cfg.targets.normal;
      d.scoreP = 0; d.scoreR = 0; d.leader = 0; d.rate = 0; d.scoring = 0;
      d.stopT = 0; d.time = 0; d.result = null;
    },
    clear() { d.phase = 'idle'; d.result = null; },

    /** 玩家在對手後方挑戰範圍內（並排也算） */
    canChallenge(p, r) {
      const ahead = r.s - p.s;
      return d.phase === 'marked' && ahead > -6 && ahead < cfg.challengeRange;
    },
    challenge() {
      if (d.phase !== 'marked') return false;
      d.phase = 'countdown';
      d.timer = cfg.countdown;
      d.count = Math.ceil(d.timer);
      emit('duelCountdown', { count: d.count });
      return true;
    },

    update(dt, p, r) {
      d.gap = p.s - r.s;
      d.rate = 0; d.scoring = 0;

      if (d.phase === 'countdown') {
        d.timer -= dt;
        const c = Math.ceil(d.timer);
        if (d.timer <= 0) {
          d.phase = 'racing';
          d.leader = 0;
          emit('duelGo', {});
        } else if (c !== d.count) {
          d.count = c;
          emit('duelCountdown', { count: c });
        }
        return;
      }
      if (d.phase === 'result') {
        d.timer -= dt;
        if (d.timer <= 0) d.phase = 'idle';
        return;
      }
      if (d.phase !== 'racing') return;
      d.time += dt;

      // 超車判定：對方領先超過一個車身才算，避免並排時反覆歸零
      const m = cfg.overtakeMargin;
      if (d.gap > m && d.leader !== 1) {
        if (d.leader === -1) { const lost = d.scoreR; d.scoreR = 0; emit('duelZero', { who: 'rival', lost }); }
        d.leader = 1;
      } else if (d.gap < -m && d.leader !== -1) {
        if (d.leader === 1) {
          const lost = d.scoreP * (1 - d.mods.keepOnOvertaken);
          d.scoreP -= lost;
          emit('duelZero', { who: 'player', lost });
        }
        d.leader = -1;
      }

      // 計分：只有領先者、而且差距超過門檻
      const abs = Math.abs(d.gap);
      const thr = d.leader === 1 ? d.mods.threshold : cfg.threshold;
      if (d.leader !== 0 && abs > thr) {
        let rate = Math.min(cfg.rateCap, cfg.rateBase + cfg.ratePerMeter * (abs - thr));
        if (d.leader === 1) { rate *= d.mods.scoreMul; d.scoreP += rate * dt; }
        else d.scoreR += rate * dt;
        d.rate = rate; d.scoring = d.leader;
      }

      // 勝負
      if (d.scoreP >= d.target) return d.finish(true, 'score');
      if (d.scoreR >= d.target) return d.finish(false, 'score');
      if (abs >= cfg.breakaway && d.leader !== 0) return d.finish(d.leader === 1, 'breakaway');
      if (p.v < cfg.stopKmh / 3.6) {
        d.stopT += dt;
        if (d.stopT >= cfg.stopSeconds) return d.finish(false, 'stopped');
      } else d.stopT = 0;
    },

    finish(win, reason) {
      d.phase = 'result';
      d.timer = 4;
      d.result = { win, reason, time: d.time };
      if (win) d.scoreP = Math.max(d.scoreP, reason === 'score' ? d.target : d.scoreP);
      emit('duelEnd', d.result);
    },
  };
  return d;
}
