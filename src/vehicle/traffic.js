// 一般車流：簡化的車道跟隨者。純邏輯，不依賴 three.js。
// 在玩家前方視線外生成、後方回收，固定大小的物件池（不配置新物件）。
//
// 交流道：分歧點之後有主線與 alt 兩條分支。車過分歧點時依所在的那一側決定走哪條；
// 走 alt 的車（onAlt）只跟同一條分支上的車互動，等 alt 被回收時一起消失。
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smooth = (a) => a * a * (3 - 2 * a);

export function createTraffic(road, rng, cfg) {
  const typeNames = Object.keys(cfg.types);
  const typeTotal = typeNames.reduce((a, k) => a + cfg.types[k].weight, 0);
  const cars = [];
  for (let i = 0; i < cfg.maxCars; i++) {
    cars.push({
      id: i, active: false, onAlt: false, type: 'sedan', len: 4.5, wid: 1.8, height: 1.4,
      s: 0, d: 0, v: 0, cruise: 0, lane: 0, toLane: 0, fromLane: 0, toD: 0,
      changeT: 0,      // > 0：正在變換車道（剩餘秒數）
      blink: 0,        // −1 左、+1 右
      blinkTime: 0,    // 打燈後還要等多久才開始切
      timer: 0, yaw: 0, braking: false, merging: false, mergeEnd: 0, hue: 0,
    });
  }
  const _one = [null];
  const api = { cars, count: 0, density: 1, laneChanges: 0, spawned: 0, recycled: 0, alt: null };
  const roadOf = (c) => (c.onAlt && api.alt ? api.alt : road);

  // 車種比例可由區域覆寫（例如灣岸線大貨車多）
  const typeWeight = (k) => api.typeWeights?.[k] ?? cfg.types[k].weight;
  const pickType = () => {
    let total = 0;
    for (const k of typeNames) total += typeWeight(k);
    let r = rng.next() * total;
    for (const k of typeNames) { r -= typeWeight(k); if (r <= 0) return k; }
    return typeNames[0];
  };

  /** lane 在 [s+back, s+ahead] 範圍內有沒有其他車（含正在切入或切出的）。只看同一條分支。 */
  // 給 self 時會把相對速度算進去：後方來車比較快、或前車比較慢，都要留更長的距離（切過去約需 3 秒）
  function laneFree(lane, s, back, ahead, self, onAlt = false) {
    for (const c of cars) {
      if (!c.active || c === self || c.onAlt !== onAlt) continue;
      if (c.lane !== lane && !((c.changeT > 0 || c.blinkTime > 0) && c.toLane === lane)) continue;
      const ds = c.s - s;
      const rel = self ? c.v - self.v : 0;
      const b = back - Math.max(0, rel) * 3.2, a = ahead + Math.max(0, -rel) * 3.2;
      if (ds > b - c.len / 2 && ds < a + c.len / 2) return false;
    }
    return true;
  }

  function spawn(s, lane, onAlt = false) {
    const c = cars.find((k) => !k.active);
    if (!c) return null;
    const type = pickType();
    const t = cfg.types[type];
    c.active = true; c.onAlt = onAlt; c.type = type; c.len = t.len; c.wid = t.wid; c.height = t.height;
    c.s = s; c.lane = lane; c.toLane = lane; c.fromLane = lane;
    c.d = roadOf(c).laneCenterAt(lane, s); c.toD = c.d;
    c.cruise = rng.range(t.kmhMin, t.kmhMax) / 3.6;
    c.v = c.cruise;
    c.changeT = 0; c.blink = 0; c.blinkTime = 0; c.yaw = 0; c.braking = false;
    c.merging = false; c.yield = false;
    c.timer = rng.range(cfg.laneChangeEveryMin, cfg.laneChangeEveryMax);
    c.hue = rng.next();
    api.spawned++;
    return c;
  }

  function beginChange(c, toLane) {
    c.toLane = toLane;
    c.blink = toLane > c.lane ? 1 : -1;
    c.blinkTime = rng.range(cfg.blinkLeadMin, cfg.blinkLeadMax); // 方向燈至少提前 1.5 秒
  }

  /** s 這個位置能不能放車：交流道範圍內不放 */
  const spawnable = (rd, s) => s > rd.sMin + 20 && s < rd.sMax - 100 && rd.zoneAt(s) === 0 && rd.zoneAt(s + 60) === 0;

  api.laneFree = laneFree;

  /**
   * 在 [s0, s1] 之間額外放 n 台車（捷徑的密集車流、事件的塞車）。
   * opts：{ kmhMin, kmhMax } 指定車速。回傳實際放了幾台。
   */
  api.fillRange = (s0, s1, n, opts = {}) => {
    let placed = 0;
    for (let k = 0; k < n * 6 && placed < n; k++) {
      const lane = rng.int(0, road.lanes - 1);
      const s = rng.range(s0, s1);
      if (!spawnable(road, s) || !laneFree(lane, s, -16, 16, null)) continue;
      const c = spawn(s, lane);
      if (!c) break;
      if (opts.kmhMin) { c.cruise = rng.range(opts.kmhMin, opts.kmhMax) / 3.6; c.v = c.cruise; c.timer = 999; }
      placed++;
    }
    return placed;
  };

  /** 開局時把玩家前方鋪滿 */
  api.populate = (player) => {
    const want = Math.round(cfg.densityPerKm * api.density * 1.0);
    for (let k = 0; k < want * 3; k++) {
      const lane = rng.int(0, road.lanes - 1);
      const s = player.s + rng.range(120, Math.min(cfg.spawnAheadMax, road.sMax - player.s - 100));
      if (spawnable(road, s) && laneFree(lane, s, -cfg.minSpawnGap, cfg.minSpawnGap, null)) spawn(s, lane);
      if (cars.filter((c) => c.active).length >= want) break;
    }
  };

  /** 玩家選了另一條分支：分歧點之後的車換邊 */
  api.swapBranches = (forkS) => {
    for (const c of cars) if (c.active && c.s >= forkS) c.onAlt = !c.onAlt;
  };
  /** alt 分支被回收：上面的車一起消失 */
  api.clearAlt = () => {
    for (const c of cars) if (c.active && c.onAlt) { c.active = false; c.onAlt = false; api.recycled++; }
    api.alt = null;
  };

  // racers：要當成障礙的賽車（玩家、對手），元素為 { s, d, v, onAlt? }；生成與回收只看 player
  api.update = (dt, player, racers) => {
    if (!racers) { _one[0] = player; racers = _one; }
    const fork = road.fork;
    let active = 0;

    // ── 回收
    for (const c of cars) {
      if (!c.active) continue;
      const rel = c.s - player.s;
      const rd = roadOf(c);
      if (rel < -cfg.despawnBehind || rel > cfg.despawnAhead || c.s > rd.sMax - 20 || (c.onAlt && !api.alt)) {
        c.active = false; c.onAlt = false; api.recycled++;
        continue;
      }
      active++;
    }

    // ── 生成（每步最多一台）。分歧點之後、玩家還沒選路時，兩條分支都放
    const span = (cfg.spawnAheadMax + cfg.despawnBehind) / 1000;
    const want = Math.min(cfg.maxCars - 4, Math.round(cfg.densityPerKm * api.density * span));
    if (active < want) {
      const lane = rng.int(0, road.lanes - 1);
      const behind = player.v < 18 && rng.next() < 0.4;
      const s = behind
        ? player.s - rng.range(150, cfg.despawnBehind - 10)
        : player.s + rng.range(cfg.spawnAheadMin, cfg.spawnAheadMax);
      const onAlt = !!(api.alt && fork && s > fork.s && rng.next() < 0.5);
      const rd = onAlt ? api.alt : road;
      if (spawnable(rd, s) && laneFree(lane, s, -cfg.minSpawnGap, cfg.minSpawnGap, null, onAlt)) {
        if (spawn(s, lane, onAlt)) active++;
      }
    }

    // ── 匯入路段：在匯入車道放車，之後併入最左車道
    for (const m of road.merges) {
      if (m.spawned) continue;
      const rel = m.s0 - player.s;
      if (rel < 300) { m.spawned = true; continue; } // 太近，會憑空出現，放棄
      // 等玩家接近才放車，而且從匝道速度起步：玩家抵達時它們正好在併入
      if (rel > cfg.mergeTriggerDist) continue;
      m.spawned = true;
      const n = rng.int(1, 2);
      for (let k = 0; k < n; k++) {
        const c = spawn(m.s0 + 40 + k * 30, -1);
        if (!c) break;
        c.merging = true; c.mergeEnd = m.s1 - 62;
        c.v = cfg.mergeStartKmh / 3.6;
        active++;
      }
    }

    // ── 行為
    for (const c of cars) {
      if (!c.active) continue;
      const rd = roadOf(c);

      // 跟車：找同車道最近的前車（主線上的賽車也算）
      let gap = Infinity, lead = 0;
      for (const o of cars) {
        if (!o.active || o === c || o.onAlt !== c.onAlt) continue;
        const ds = o.s - c.s;
        if (ds <= 0 || ds > 90) continue;
        // 同車道的前車，或正在切進我這條車道的車
        const mine = Math.abs(o.d - c.d) <= (o.wid + c.wid) / 2 + 0.4 || (o.changeT > 0 && Math.abs(o.toD - c.d) <= (o.wid + c.wid) / 2 + 0.4);
        if (!mine) continue;
        const g = ds - (o.len + c.len) / 2;
        if (g < gap) { gap = g; lead = o.v; }
      }
      for (const p of racers) {
        if (!!p.onAlt !== c.onAlt) continue;
        const pds = p.s - c.s;
        if (pds > 0 && pds < 90 && Math.abs(p.d - c.d) < (1.8 + c.wid) / 2 + 0.4) {
          const g = pds - (4.4 + c.len) / 2;
          if (g < gap) { gap = g; lead = Math.max(0, p.v); }
        }
      }
      let desired = c.cruise;
      if (c.merging && c.yield) desired = Math.min(desired, c.s > c.mergeEnd - 30 ? 4 : 12);
      if (gap < 8 + c.v * 1.3) desired = Math.min(desired, gap < 6 ? Math.max(0, lead - 3) : lead);
      const dv = desired - c.v;
      c.braking = dv < -0.5;
      c.v += clamp(dv, -6 * dt, 1.5 * dt);
      if (c.v < 0) c.v = 0;
      const sPrev = c.s;
      c.s += c.v * dt;

      // 過分歧點：在主線分支那一側就留在主線，否則走 alt（alt 已回收就直接消失）
      if (!c.onAlt && fork && sPrev < fork.s && c.s >= fork.s && (c.d > 0 ? 1 : -1) !== fork.side) {
        if (api.alt) c.onAlt = true;
        else { c.active = false; api.recycled++; active--; continue; }
      }

      // 變換車道（車道中心會隨交流道橫移，所以每步重新查）
      const dPrev = c.d;
      const nearJct = rd.zoneAt(c.s) !== 0 || rd.zoneAt(c.s + 220) !== 0;
      if (c.changeT > 0) {
        c.changeT -= dt;
        const t = 1 - Math.max(0, c.changeT) / cfg.laneChangeTime;
        const from = rd.laneCenterAt(c.fromLane, c.s), to = rd.laneCenterAt(c.toLane, c.s);
        c.toD = to;
        c.d = from + (to - from) * smooth(t);
        if (c.changeT <= 0) { c.lane = c.toLane; c.fromLane = c.lane; c.d = to; c.blink = 0; c.merging = false; }
      } else {
        c.d = rd.laneCenterAt(c.lane, c.s);
        c.toD = c.d;
        if (c.blinkTime > 0) {
          c.blinkTime -= dt;
          if (c.blinkTime <= 0) {
            // 賽車就在旁邊時不切
            const toD = rd.laneCenterAt(c.toLane, c.s);
            let beside = false;
            for (const p of racers) if (!!p.onAlt === c.onAlt && Math.abs(p.d - toD) < 2 && Math.abs(p.s - c.s) < 9) beside = true;
            const free = !beside && laneFree(c.toLane, c.s, -14, 22, c, c.onAlt);
            if (free && (c.merging || !nearJct)) {
              c.changeT = cfg.laneChangeTime; c.fromLane = c.lane; c.toD = toD; c.yield = false;
              api.laneChanges++;
            } else if (c.merging) {
              // 併不進去：減速讓主線的車先過，再試一次；真的到匯入車道盡頭還進不去就離開
              c.blinkTime = 0.3; c.yield = true;
              if (c.s > c.mergeEnd + 34) { c.active = false; api.recycled++; active--; continue; }
            }
            else { c.blink = 0; c.toLane = c.lane; }
          }
        } else if (c.merging) {
          if (c.blink === 0) beginChange(c, 0);
        } else {
          c.timer -= dt;
          if (c.timer <= 0) {
            c.timer = rng.range(cfg.laneChangeEveryMin, cfg.laneChangeEveryMax);
            const to = c.lane + (rng.next() < 0.5 ? -1 : 1);
            const inMerge = rd.widthLeft(c.s + 60) > rd.halfWidth + 0.1 || rd.widthLeft(c.s) > rd.halfWidth + 0.1;
            if (!nearJct && to >= 0 && to < rd.lanes && !(inMerge && to === 0) && laneFree(to, c.s, -25, 45, c, c.onAlt)) beginChange(c, to);
          }
        }
      }
      // 車頭略轉向橫移方向（psi 左為正、d 右為正）
      const yawT = c.v > 1 ? clamp(Math.atan2(-(c.d - dPrev) / dt, c.v), -0.2, 0.2) : 0;
      c.yaw += (yawT - c.yaw) * Math.min(1, 10 * dt);
    }
    api.count = active;
  };

  /** 吸尾流：正前方 range 公尺內、橫向 width 公尺內有車 */
  api.slipstream = (player, range, width, other) => {
    for (const c of cars) {
      if (!c.active || c.onAlt) continue;
      const ds = c.s - player.s - (c.len + 4.4) / 2;
      if (ds > -1 && ds < range && Math.abs(c.d - player.d) < width) return true;
    }
    if (other && other.active && !other.onAlt) {
      const ds = other.s - player.s - 4.4;
      if (ds > -1 && ds < range && Math.abs(other.d - player.d) < width) return true;
    }
    return false;
  };

  return api;
}
