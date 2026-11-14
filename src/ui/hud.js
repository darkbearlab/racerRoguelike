// HUD 以 HTML/CSS 疊在 canvas 上，平常只顯示必要資訊，對決時才展開分數條。
const $ = (id) => document.getElementById(id);

// 以速度推算虛擬轉速（假 6 檔），給轉速表與之後的引擎音效用
const GEARS = [0, 60, 105, 150, 195, 235, 300];
export function virtualRpm(kmh) {
  let g = 1;
  while (g < 6 && kmh > GEARS[g]) g++;
  const lo = GEARS[g - 1], hi = GEARS[g];
  const t = Math.min(1, Math.max(0, (kmh - lo) / (hi - lo)));
  return { gear: g, rpm01: g === 1 ? 0.12 + 0.88 * t : 0.45 + 0.55 * t };
}

const REASON = { score: '分數達標', breakaway: '甩開 400 m', stopped: '停車判負' };

export function createHud(debugOn) {
  const speed = $('speed'), rpmFill = $('rpmFill'), drift = $('drift');
  const toast = $('toast'), help = $('help'), debug = $('debug'), pause = $('pause'), speedo = $('speedo');
  const duelEl = $('duel'), barP = $('barP'), barR = $('barR'), fillP = $('fillP'), fillR = $('fillR');
  const scoreP = $('scoreP'), scoreR = $('scoreR'), nameR = $('nameR');
  const gapEl = $('gap'), gapNum = $('gapNum'), gapNote = $('gapNote');
  const tag = $('tag'), tagName = $('tagName'), tagDist = $('tagDist'), edge = $('edge'), prompt = $('prompt');
  const count = $('count'), banner = $('banner');
  const defeats = $('defeats'), bounty = $('bounty'), runNote = $('runNote');
  const clockEl = $('clock'), clockTime = $('clockTime'), clockLeft = $('clockLeft');
  const jct = $('jct'), jctL = $('jctL'), jctR = $('jctR'), jctLName = $('jctLName'), jctRName = $('jctRName'), jctLDist = $('jctLDist'), jctRDist = $('jctRDist');
  let toastTimer = 0;
  let last = {};
  if (debugOn) { debug.style.display = 'block'; document.body.classList.add('debug-on'); }
  setTimeout(() => { help.style.opacity = 0.25; }, 12000);

  // 只在值改變時才碰 DOM
  const set = (key, el, prop, value) => {
    if (last[key] === value) return;
    last[key] = value;
    if (prop === 'text') el.textContent = value; else el.style[prop] = value;
  };
  const retrigger = (el, cls) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };

  return {
    update(st, view, dt) {
      const kmh = Math.abs(st.vf) * 3.6;
      set('speed', speed, 'text', String(Math.round(kmh)));
      rpmFill.style.width = `${virtualRpm(kmh).rpm01 * 100}%`;
      set('drift', drift, 'opacity', st.drifting ? '1' : '0');
      // 駕駛艙視角改由儀表板顯示
      set('speedo', speedo, 'display', view === 'cockpit' ? 'none' : 'block');
      if (toastTimer > 0) {
        toastTimer -= dt;
        if (toastTimer <= 0) toast.style.opacity = 0;
      }
    },

    /** 對決 HUD：分數條、差距、對手標籤、挑戰提示 */
    duel(d, info) {
      const on = d.phase === 'countdown' || d.phase === 'racing' || d.phase === 'result';
      set('duelOn', duelEl, 'display', on ? 'block' : 'none');
      if (on) {
        set('fillP', fillP, 'width', `${Math.min(100, (d.scoreP / d.target) * 100).toFixed(1)}%`);
        set('fillR', fillR, 'width', `${Math.min(100, (d.scoreR / d.target) * 100).toFixed(1)}%`);
        set('scoreP', scoreP, 'text', `${Math.floor(d.scoreP)} / ${d.target}`);
        set('scoreR', scoreR, 'text', `${Math.floor(d.scoreR)} / ${d.target}`);
        set('nameR', nameR, 'text', info.name);
        const g = Math.round(d.gap);
        const txt = `${g > 0 ? '+' : ''}${g}`;
        if (last.gapTxt !== txt) { last.gapTxt = txt; gapNum.innerHTML = `${txt}<small>m</small>`; }
        const cls = `${g >= 0 ? 'lead' : 'trail'}${Math.abs(d.gap) > info.threshold && d.phase === 'racing' ? ' hot' : ''}`;
        if (last.gapCls !== cls) { last.gapCls = cls; gapEl.className = cls; }
        const note = d.phase === 'countdown' ? '倒數中不計分'
          : d.scoring > 0 ? `得分中 +${d.rate.toFixed(0)}/秒`
          : d.scoring < 0 ? `對手得分中 +${d.rate.toFixed(0)}/秒`
          : d.phase === 'racing' ? `領先超過 ${info.threshold} m 才得分` : '';
        set('gapNote', gapNote, 'text', note);
        const sp = d.scoring > 0, sr = d.scoring < 0;
        if (last.sp !== sp) { last.sp = sp; barP.classList.toggle('scoring', sp); }
        if (last.sr !== sr) { last.sr = sr; barR.classList.toggle('scoring', sr); }
      }

      // 對手標籤：在畫面內就貼在車上，不在畫面內就顯示方向與距離
      const showTag = info.active && (d.phase !== 'idle' || info.courier);
      if (showTag && info.onScreen) {
        tag.style.display = 'block';
        tag.style.left = `${info.x.toFixed(0)}px`;
        tag.style.top = `${info.y.toFixed(0)}px`;
        set('tagName', tagName, 'text', info.name);
        set('tagDist', tagDist, 'text', d.phase === 'marked' || info.courier ? `${Math.max(0, Math.round(info.ahead))} m` : '');
        set('edge', edge, 'display', 'none');
      } else {
        tag.style.display = 'none';
        if (showTag && d.phase !== 'result') {
          const front = info.ahead > 0;
          set('edge', edge, 'display', 'block');
          set('edgeTxt', edge, 'text', `${front ? '▲ 前方' : '▼ 後方'} ${info.name} ${Math.abs(Math.round(info.ahead))} m`);
          set('edgePos', edge, 'top', front ? '26%' : 'auto');
          set('edgeBot', edge, 'bottom', front ? 'auto' : '120px');
        } else set('edge', edge, 'display', 'none');
      }
      set('prompt', prompt, 'display', info.canChallenge ? 'block' : 'none');
    },

    /** info：{ night, zoneName, need }（有三晚流程時才給） */
    run(run, nodeLabel, info) {
      if (info) {
        set('nightLine', $('nightLine'), 'text', `第 ${info.night} 晚　${info.zoneName}`);
        if (info.rush) set('defeats', defeats, 'text', `Boss ${run.bossWins} / ${info.total}`);
        else set('defeats', defeats, 'text', run.nightDefeats >= info.need ? `${run.nightDefeats} / ${info.need}　Boss 出現` : `${run.nightDefeats} / ${info.need}`);
      } else set('defeats', defeats, 'text', String(run.defeats));
      set('bounty', bounty, 'text', String(run.bounty));
      set('runNote', runNote, 'text', nodeLabel || '');
    },
    _runOld(run, nodeLabel) {
      set('defeats', defeats, 'text', String(run.defeats));
      set('bounty', bounty, 'text', String(run.bounty));
      set('runNote', runNote, 'text', nodeLabel || '');
    },

    /** 上方中央的時鐘與「距天亮」；剩 30 分鐘時變紅並閃爍 */
    clock(clock) {
      set('clockTime', clockTime, 'text', clock.text);
      const m = Math.max(0, Math.ceil(clock.remaining));
      set('clockLeft', clockLeft, 'text', `距天亮 ${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`);
      if (last.warn !== clock.warning) { last.warn = clock.warning; clockEl.classList.toggle('warn', clock.warning); }
    },

    /** 交流道選路提示：左右各一個節點，玩家目前在哪一側就亮哪一邊 */
    junction(info) {
      set('jctOn', jct, 'display', info ? 'block' : 'none');
      if (!info) return;
      set('jctL', jctLName, 'text', `◀ ${info.left.icon} ${info.left.name}`);
      set('jctR', jctRName, 'text', `${info.right.icon} ${info.right.name} ▶`);
      const dist = `${Math.max(0, Math.round(info.dist / 10) * 10)} m`;
      set('jctDistL', jctLDist, 'text', dist);
      set('jctDistR', jctRDist, 'text', dist);
      if (last.jctSide !== info.side) {
        last.jctSide = info.side;
        jctL.classList.toggle('pick', info.side < 0);
        jctR.classList.toggle('pick', info.side > 0);
      }
    },

    /** Boss 登場字幕：稱號、名字、無線電台詞 */
    bossCard(def, line, sec = 4.5, buffs = '') {
      $('bossBuffs').textContent = buffs;
      $('bossTitle').textContent = `♛ ${def.title || 'BOSS'}`;
      $('bossName').textContent = def.name;
      $('bossLine').textContent = line ? `「${line}」` : '';
      const el = $('bossCard');
      el.classList.add('on');
      clearTimeout(el._t);
      el._t = setTimeout(() => el.classList.remove('on'), sec * 1000);
    },
    /** 換晚：畫面暗一下，顯示第幾晚與區域 */
    night(night, zoneName, sec = 2.6) {
      $('nightNo').textContent = `第 ${night} 晚`;
      $('nightZone').textContent = zoneName;
      const el = $('night');
      el.classList.add('on');
      clearTimeout(el._t);
      el._t = setTimeout(() => el.classList.remove('on'), sec * 1000);
    },
    title(on) { document.body.classList.toggle('title-on', on); },

    /** 結算畫面 */
    over(rows, sub, title = '天亮了') {
      $('overTitle').textContent = title;
      $('overSub').textContent = sub;
      $('overTable').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
      $('over').style.display = 'flex';
    },

    countdown(text) {
      count.textContent = text;
      count.style.fontSize = text.length > 2 ? 'min(120px, 17vw)' : '';
      count.style.whiteSpace = 'nowrap';
      retrigger(count, 'pop');
    },
    zero(who) { retrigger(who === 'player' ? barP : barR, 'zeroed'); },
    banner(win, reason, sub) {
      banner.className = win ? 'win' : 'lose';
      banner.innerHTML = `${win ? '勝利' : '落敗'}<small>${REASON[reason] || ''}${sub ? '　' + sub : ''}</small>`;
      retrigger(banner, 'show');
    },

    toast(text, sec = 1.4) {
      toast.textContent = text;
      toast.style.opacity = 1;
      toastTimer = sec;
    },
    setPaused(p) { pause.style.display = p ? 'flex' : 'none'; },
    debug(text) { if (debugOn) debug.textContent = text; },
  };
}
