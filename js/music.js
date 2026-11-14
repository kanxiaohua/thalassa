/* =====================================================================
 *  识海 · 背景音乐
 * ---------------------------------------------------------------------
 *  曲子本身不随项目分发（版权在人手里），这里只负责"放你放在
 *  assets/music/ 里的那两个文件"：
 *
 *    - 起播：第一次点击 / 按键（浏览器不允许没手势就出声）
 *    - 淡入：默认 5 秒，不要一进来就砸脸
 *    - 轮换：两首之间交叉淡入淡出，不会出现"一首歌循环到吐"
 *    - 让位：打开一条记忆、铃声响的时候，音乐自动退到 38%
 *    - 缺席：文件不存在就安静地退回程序化音景，不报错、不白屏
 *
 *  音量曲线：每个 player 自己有一个 vol，每 60ms 向 target 靠一次，
 *  真正写进 el.volume 的是 vol * 曲子增益 * 让位系数 * 开关。
 * ===================================================================== */

window.SeaMusic = (function () {
  'use strict';

  var cfg = window.MUSIC || {};
  var list = (cfg.tracks || []).filter(function (t) { return t && t.file; });
  var FADE_IN = cfg.fadeIn === undefined ? 5 : cfg.fadeIn;
  var SWITCH_EVERY = (cfg.switchEvery || 0) * 1000;
  var DUCK = cfg.duck === undefined ? 0.38 : cfg.duck;

  var players = [];      // 两个 <audio>，轮流上场，交叉淡入
  var active = 0;        // 当前在场上的那个
  var trackAt = 0;       // 当前曲目下标
  var started = false;
  var enabled = true;
  var duck = 1;
  var buddy = null;      // 定时器
  var trail = [];        // 自检：最近发生了什么

  function note(what) {
    trail.push(what + '@' + (started ? Math.round(performance.now()) : 0));
    if (trail.length > 40) trail.shift();
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function gainOf(t) {
    var g = t && t.gain !== undefined ? t.gain : 0.38;
    return clamp(g, 0, 1);
  }

  function makePlayers() {
    for (var i = 0; i < 2; i++) {
      var el = document.createElement('audio');
      el.preload = 'auto';
      el.loop = false;
      el.volume = 0;                 // 先哑着，等淡入把它推上去
      el.setAttribute('playsinline', '');
      players.push({ el: el, vol: 0, target: 0, ok: null, src: '', track: -1 });
    }
    // 一首放完，接着下一首
    players.forEach(function (p, i) {
      p.el.addEventListener('ended', function () { advance(i); });
      p.el.addEventListener('error', function () { p.ok = false; });
      p.el.addEventListener('canplay', function () { p.ok = true; });
    });
  }

  function writeVolumes() {
    players.forEach(function (p) {
      var t = list[p.track] || {};
      var v = p.vol * gainOf(t) * duck * (enabled ? 1 : 0);
      p.el.volume = clamp(v, 0, 1);
    });
  }

  function tick() {
    players.forEach(function (p) {
      p.vol += (p.target - p.vol) * 0.075;
      if (Math.abs(p.target - p.vol) < 0.002) p.vol = p.target;
    });
    writeVolumes();
  }

  function ensureTimer() {
    if (buddy) return;
    buddy = setInterval(tick, 60);
  }

  /** 把某一首装进某个 player 并从 0 开始播。
   *  成功与否只看 play() 这个 Promise —— 它 resolve 就说明真的出声了；
   *  3 秒还没 resolve（文件不在、格式不认、一直在缓冲）就当失败，换下一首。 */
  function load(p, i, cb) {
    var t = list[i];
    if (!t) { cb && cb(false); return; }
    note('load ' + i + ' → p' + (players[0] === p ? 0 : 1));
    p.track = i;
    if (p.src !== t.file) {
      p.src = t.file;
      p.ok = null;
      p.el.src = t.file;
    }
    try { p.el.currentTime = 0; } catch (e) { }

    var settled = false;
    function finish(good) {
      if (settled) return;
      settled = true;
      p.ok = good;
      cb && cb(good);
    }

    // 冷启动时第一次取数据可能慢，给足 6 秒；真出不了声就换下一首
    var guard = setTimeout(function () {
      if (!p.el.paused && p.el.currentTime > 0.2) finish(true);
      else finish(false);
    }, 6000);

    var pr;
    try { pr = p.el.play(); } catch (e) { clearTimeout(guard); finish(false); return; }
    if (pr && pr.then) {
      pr.then(function () { clearTimeout(guard); finish(true); })
        .catch(function () { clearTimeout(guard); finish(false); });
    } else {
      clearTimeout(guard);
      finish(true);
    }
  }

  function playFrom(i, attempts) {
    attempts = attempts || 0;
    if (attempts >= list.length) return false;
    var p = players[active];
    load(p, i, function (good) {
      if (good) {
        note('play ok ' + i + ' on p' + (players[0] === p ? 0 : 1));
        trackAt = i;
        p.target = 1;
        p.vol = 0;
        ensureTimer();
        scheduleNext();
      } else {
        playFrom((i + 1) % list.length, attempts + 1);
      }
    });
    return true;
  }

  function scheduleNext() {
    if (!SWITCH_EVERY || list.length < 2) return;
    if (nextTimer) clearTimeout(nextTimer);
    nextTimer = setTimeout(function () { crossfadeTo((trackAt + 1) % list.length); }, SWITCH_EVERY);
  }

  var nextTimer = null;

  function crossfadeTo(i) {
    if (!started || players.length < 2) return;
    var from = players[active];
    var to = players[1 - active];
    note('xfade → ' + i + ' into p' + (1 - active));
    load(to, i, function (good) {
      if (!good) { note('xfade FAIL ' + i); scheduleNext(); return; }     // 这首放不出来就等下一轮
      to.vol = 0;
      to.target = 1;
      from.target = 0;
      active = 1 - active;
      trackAt = i;
      ensureTimer();
      scheduleNext();
      // 淡出完了再把旧的停掉，省点 CPU
      setTimeout(function () {
        if (players[1 - active] === from && from.target === 0) {
          try { from.el.pause(); } catch (e) { }
        }
      }, 2600);
    });
  }

  function advance(endedIndex) {
    // 自然放完：接下一首
    if (endedIndex !== active) return;
    if (list.length > 1) crossfadeTo((trackAt + 1) % list.length);
    else { try { players[active].el.currentTime = 0; var rp = players[active].el.play(); if (rp && rp.catch) rp.catch(function () { }); } catch (e) { } }
  }

  function start() {
    if (started || !list.length) return;
    started = true;
    if (!players.length) makePlayers();
    ensureTimer();
    playFrom(trackAt, 0);
    setTimeout(function () { if (players[active]) players[active].vol = 0; }, 0);
    // 淡入由 tick 负责：target 已经是 1，vol 从 0 往上爬
  }

  function setEnabled(v) {
    enabled = !!v;
    players.forEach(function (p) {
      if (!enabled && p.el && !p.el.paused) {
        // 关声音不等于停播：留着播放位置，下次接着往下走
        setTimeout(function () { if (!enabled) { try { p.el.pause(); } catch (e) { } } }, 700);
      } else if (enabled && started && p === players[active] && p.el.paused) {
        try { var rp2 = p.el.play(); if (rp2 && rp2.catch) rp2.catch(function () { }); } catch (e) { }
      }
    });
    writeVolumes();
  }

  function duckTo(k) {
    duck = clamp(k, 0, 1);
    writeVolumes();
  }

  function title() {
    if (!started) return '';
    var p = players[active];
    if (!p || p.ok === false) return '';       // 文件不在：别在面板上说"正在放"
    var t = list[trackAt];
    return t ? (t.title || t.file) : '';
  }

  function next() { if (list.length > 1) crossfadeTo((trackAt + 1) % list.length); }
  function prev() { if (list.length > 1) crossfadeTo((trackAt + list.length - 1) % list.length); }

  return {
    start: start,
    setEnabled: setEnabled,
    duckTo: duckTo,
    next: next,
    prev: prev,
    title: title,
    isStarted: function () { return started; },
    isEnabled: function () { return enabled; },
    count: function () { return list.length; },
    // 自检用：看现在到底在放什么、音量多少
    _state: function () {
      return {
        started: started,
        enabled: enabled,
        duck: duck,
        trackAt: trackAt,
        title: title(),
        active: active,
        trail: trail.slice(),
        players: players.map(function (p) {
          return {
            track: p.track, src: p.src, vol: +p.vol.toFixed(3),
            target: p.target, volume: +p.el.volume.toFixed(3),
            paused: p.el.paused, t: +p.el.currentTime.toFixed(2), ok: p.ok
          };
        })
      };
    }
  };
})();
