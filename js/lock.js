/* =====================================================================
 *  识海 · 隐私门锁
 * ---------------------------------------------------------------------
 *  给这片海加一道门：打开页面先看到锁屏，输入短语才进得去。
 *
 *  它不是保险箱，是门。
 *    · 短语只以 PBKDF2 / 迭代 SHA-256 的摘要形式存在浏览器本地，不存明文；
 *    · 但记忆正文本身仍是 data/memories.js 里的明文，懂技术的人可以直接看源码。
 *    · 它能拦住的是"随手打开你电脑/手机的人"，不是"一定要看你隐私的人"。
 *
 *  能做到的事：
 *    · 打开就要短语；关掉标签页就重新上锁
 *    · 闲置若干分钟自动上锁（1 / 3 / 10 分钟，或从不）
 *    · 离开标签页超过 30 秒自动上锁
 *    · Esc 连按两次、或 Ctrl/Cmd + Shift + L：立刻锁屏
 *    · 可在设置里改短语、改自动锁定时长
 * ===================================================================== */

(function () {
  'use strict';

  var K_REC = 'sea.lock.v1';
  var K_CFG = 'sea.lock.cfg';
  var K_TRUST = 'sea.lock.trust';
  var K_SESSION = 'sea.unlocked';

  var DEFAULT_CFG = { autoLock: 3, lockOnHide: true };
  var ITER_SUBTLE = 150000;
  var ITER_FALLBACK = 12000;

  /* ------------------------------------------------------------------
   * 0. 存储（localStorage 不可用时退化为内存，只在本次会话里有效）
   * ------------------------------------------------------------------ */
  var memStore = {};

  function rawGet(k) {
    try {
      var v = window.localStorage.getItem(k);
      if (v !== null) return v;
    } catch (e) { /* file:// 或隐私模式下可能不可用 */ }
    return (k in memStore) ? memStore[k] : null;
  }

  function rawSet(k, v) {
    memStore[k] = v;
    try { window.localStorage.setItem(k, v); } catch (e) { /* 忽略 */ }
  }

  function rawDel(k) {
    delete memStore[k];
    try { window.localStorage.removeItem(k); } catch (e) { /* 忽略 */ }
  }

  function readJSON(k, fallback) {
    var s = rawGet(k);
    if (!s) return fallback;
    try { return JSON.parse(s); } catch (e) { return fallback; }
  }

  function writeJSON(k, v) { rawSet(k, JSON.stringify(v)); }

  /* ------------------------------------------------------------------
   * 1. 摘要：优先用 WebCrypto，退化成纯 JS 的迭代 SHA-256
   * ------------------------------------------------------------------ */
  function toB64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return window.btoa(s);
  }

  function fromB64(str) {
    var bin = window.atob(str);
    var u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }

  function randomBytes(n) {
    var u = new Uint8Array(n);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(u);
    } else {
      for (var i = 0; i < n; i++) u[i] = Math.floor(Math.random() * 256);
    }
    return u;
  }

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  var SHA_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function sha256(bytes) {
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var l = bytes.length;
    var total = (((l + 8) >> 6) + 1) << 6;
    var buf = new Uint8Array(total);
    buf.set(bytes);
    buf[l] = 0x80;
    var dv = new DataView(buf.buffer);
    var bits = l * 8;
    dv.setUint32(total - 8, Math.floor(bits / 4294967296));
    dv.setUint32(total - 4, bits >>> 0);

    var w = new Uint32Array(64);
    for (var off = 0; off < total; off += 64) {
      var t;
      for (t = 0; t < 16; t++) w[t] = dv.getUint32(off + t * 4);
      for (t = 16; t < 64; t++) {
        var x = w[t - 15], y = w[t - 2];
        var s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
        var s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + SHA_K[t] + w[t]) >>> 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
      H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
      H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }

    var out = new Uint8Array(32);
    var odv = new DataView(out.buffer);
    for (var i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
    return out;
  }

  function sha256Iter(passBytes, salt, iter) {
    return new Promise(function (resolve) {
      var seed = new Uint8Array(passBytes.length + salt.length);
      seed.set(passBytes, 0);
      seed.set(salt, passBytes.length);
      var h = sha256(seed);
      var buf = new Uint8Array(32 + salt.length);
      for (var i = 1; i < iter; i++) {
        buf.set(h, 0);
        buf.set(salt, 32);
        h = sha256(buf.subarray(0, 32 + salt.length));
      }
      resolve(h);
    });
  }

  function derive(pass, salt, iter, alg) {
    var enc = new TextEncoder();
    var bytes = enc.encode(pass);

    if (alg === 'pbkdf2' && window.crypto && window.crypto.subtle) {
      return window.crypto.subtle
        .importKey('raw', bytes, 'PBKDF2', false, ['deriveBits'])
        .then(function (key) {
          return window.crypto.subtle.deriveBits(
            { name: 'PBKDF2', salt: salt, iterations: iter, hash: 'SHA-256' },
            key, 256
          );
        })
        .then(function (bits) { return new Uint8Array(bits); })
        .catch(function () { return sha256Iter(bytes, salt, ITER_FALLBACK); });
    }

    return sha256Iter(bytes, salt, iter);
  }

  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  /* ------------------------------------------------------------------
   * 2. 状态
   * ------------------------------------------------------------------ */
  var rec = readJSON(K_REC, null);
  var cfg = Object.assign({}, DEFAULT_CFG, readJSON(K_CFG, {}));

  var state = {
    locked: true,
    mode: rec ? 'unlock' : 'setup',
    fails: 0,
    busy: false,
    lastActive: Date.now()
  };

  var els = {};
  var hiddenAt = 0;
  var lastEsc = 0;

  function isTrusted() {
    var t = readJSON(K_TRUST, null);
    return !!(t && t.until && t.until > Date.now());
  }

  function isSessionUnlocked() {
    try { return window.sessionStorage.getItem(K_SESSION) === '1'; } catch (e) { return false; }
  }

  function setSessionUnlocked(v) {
    try {
      if (v) window.sessionStorage.setItem(K_SESSION, '1');
      else window.sessionStorage.removeItem(K_SESSION);
    } catch (e) { /* 忽略 */ }
  }

  /* ------------------------------------------------------------------
   * 3. Lock / Unlock
   * ------------------------------------------------------------------ */
  function lock(silent) {
    if (!rec) return;                       // 还没设过短语，没什么可锁的
    state.locked = true;
    state.mode = 'unlock';
    document.body.classList.add('is-locked');
    setSessionUnlocked(false);
    rawDel(K_TRUST);
    if (els.screen) {
      els.screen.classList.remove('is-hidden');
      els.screen.classList.remove('is-setup');
      buildUnlockUI();
      if (!silent) setTimeout(function () { if (els.input) els.input.focus(); }, 260);
    }
    document.dispatchEvent(new CustomEvent('sea:lock'));
  }

  function unlock() {
    state.locked = false;
    state.mode = 'unlock';
    state.fails = 0;
    setSessionUnlocked(true);
    state.lastActive = Date.now();
    document.body.classList.remove('is-locked');
    if (els.screen) {
      els.screen.classList.add('is-leaving');
      setTimeout(function () {
        els.screen.classList.add('is-hidden');
        els.screen.classList.remove('is-leaving');
      }, 620);
    }
    document.dispatchEvent(new CustomEvent('sea:unlock'));
  }

  /* ------------------------------------------------------------------
   * 4. UI
   * ------------------------------------------------------------------ */
  function buildUnlockUI() {
    if (!els.screen) return;
    els.screen.classList.remove('is-setup');
    els.title.textContent = '这片海，只给你看';
    els.sub.textContent = '输入开锁短语';
    els.submit.textContent = '进入';
    els.input.placeholder = '开锁短语';
    els.input.value = '';
    els.input2.value = '';
    els.input2.classList.add('is-hidden');
    els.hintInput.classList.add('is-hidden');
    els.msg.textContent = '';
    els.msg.classList.remove('is-ok');
    if (rec && rec.hint) {
      els.hintText.textContent = '提示：' + rec.hint;
      els.hintText.classList.add('is-on');
    } else {
      els.hintText.textContent = '';
      els.hintText.classList.remove('is-on');
    }
    els.forget.classList.toggle('is-on', true);
    if (els.cancel) els.cancel.classList.remove('is-on');
    setBusy(false);
  }

  function buildSetupUI() {
    if (!els.screen) return;
    els.screen.classList.add('is-setup');
    els.title.textContent = '先给识海上把锁';
    els.sub.textContent = '设一个只有你知道的短语。忘了就进不去了。';
    els.submit.textContent = '设好这道门';
    els.input.placeholder = '新短语（至少 4 位）';
    els.input.value = '';
    els.input2.value = '';
    els.input2.placeholder = '再输一次';
    els.input2.classList.remove('is-hidden');
    els.hintInput.classList.remove('is-hidden');
    els.msg.textContent = '';
    els.hintText.textContent = '';
    els.hintText.classList.remove('is-on');
    els.forget.classList.remove('is-on');
    if (els.cancel) els.cancel.classList.remove('is-on');
    setBusy(false);
  }

  function setBusy(v) {
    state.busy = v;
    if (!els.submit) return;
    els.submit.disabled = v;
    els.submit.classList.toggle('is-busy', v);
  }

  function flashMsg(text, ok) {
    if (!els.msg) return;
    els.msg.textContent = text;
    els.msg.classList.toggle('is-ok', !!ok);
    if (!ok) {
      els.card.classList.remove('is-shake');
      void els.card.offsetWidth;
      els.card.classList.add('is-shake');
    }
  }

  /* ------------------------------------------------------------------
   * 5. 提交：设短语 / 解锁 / 改短语
   * ------------------------------------------------------------------ */
  function submit() {
    if (state.busy) return;
    var pass = els.input.value;

    if (state.mode === 'setup') {
      if (pass.length < 4) { flashMsg('短语至少 4 位'); return; }
      if (pass !== els.input2.value) { flashMsg('两次输入不一致'); return; }

      setBusy(true);
      var salt = randomBytes(16);
      var alg = (window.crypto && window.crypto.subtle) ? 'pbkdf2' : 'sha256iter';
      var iter = alg === 'pbkdf2' ? ITER_SUBTLE : ITER_FALLBACK;

      derive(pass, salt, iter, alg).then(function (hash) {
        rec = {
          v: 1,
          alg: alg,
          iter: iter,
          salt: toB64(salt),
          hash: toB64(hash),
          hint: els.hintInput.value.trim().slice(0, 40),
          at: Date.now()
        };
        writeJSON(K_REC, rec);
        writeJSON(K_CFG, cfg);
        setBusy(false);
        unlock();
      });
      return;
    }

    if (state.mode === 'unlock') {
      if (!rec) { buildSetupUI(); return; }
      if (!pass) { flashMsg('先输入短语'); return; }

      setBusy(true);
      var salt2 = fromB64(rec.salt);
      derive(pass, salt2, rec.iter, rec.alg).then(function (hash) {
        if (sameBytes(hash, fromB64(rec.hash))) {
          setBusy(false);
          unlock();
          return;
        }
        state.fails++;
        var wait = Math.min(400 * Math.pow(1.9, state.fails - 1), 6000);
        flashMsg('短语不对，' + Math.ceil(wait / 1000) + ' 秒后可再试');
        els.input.value = '';
        setTimeout(function () {
          setBusy(false);
          if (els.input) els.input.focus();
        }, wait);
      });
      return;
    }

    if (state.mode === 'change') {
      if (!rec) { buildSetupUI(); return; }
      if (pass.length < 4) { flashMsg('新短语至少 4 位'); return; }
      if (pass !== els.input2.value) { flashMsg('两次输入不一致'); return; }

      setBusy(true);
      var alg2 = (window.crypto && window.crypto.subtle) ? 'pbkdf2' : 'sha256iter';
      var iter2 = alg2 === 'pbkdf2' ? ITER_SUBTLE : ITER_FALLBACK;
      var salt3 = randomBytes(16);
      derive(pass, salt3, iter2, alg2).then(function (hash) {
        rec = {
          v: 1,
          alg: alg2,
          iter: iter2,
          salt: toB64(salt3),
          hash: toB64(hash),
          hint: (els.hintInput.value.trim() || rec.hint || '').slice(0, 40),
          at: Date.now()
        };
        writeJSON(K_REC, rec);
        setBusy(false);
        closeSettings();
        lock(true);
        flashMsg('短语已更新', true);
      });
    }
  }

  /* ------------------------------------------------------------------
   * 6. 设置面板
   * ------------------------------------------------------------------ */
  function openSettings() {
    if (!els.settings) return;
    renderSettings();
    els.settings.classList.add('is-open');
    els.settings.setAttribute('aria-hidden', 'false');
  }

  function closeSettings() {
    if (!els.settings) return;
    els.settings.classList.remove('is-open');
    els.settings.setAttribute('aria-hidden', 'true');
  }

  // 从设置面板里"上锁"：只盖一张卡，不暂停画面
  function openSetupOverlay() {
    state.mode = 'setup';
    state.locked = false;
    if (!els.screen) return;
    els.screen.classList.remove('is-hidden');
    els.screen.classList.remove('is-leaving');
    buildSetupUI();
    if (els.cancel) els.cancel.classList.add('is-on');
    setTimeout(function () { if (els.input) els.input.focus(); }, 260);
  }

  // 背景音乐那一行（音乐模块不在时不显示）
  function musicRow() {
    var M = window.SeaMusic;
    if (!M) return '';
    var on = window.SeaMusic ? window.SeaMusic.isEnabled() : true;
    var title = M.title();
    return '<div class="set-row">' +
      '<div class="set-label">背景音乐' +
        '<i>' + (title ? '正在放：' + escapeHtml(title) : '还没有曲子：把 mp3 放进 assets/music/') + '</i></div>' +
      (title
        ? '<div class="set-actions">' +
            '<button type="button" class="ghost-btn" data-bgmnext="1">换一首</button>' +
            '<button type="button" class="ghost-btn' + (on ? '' : ' is-strong') + '" data-bgm="1" data-on="' +
              (on ? '1' : '0') + '">' + (on ? '暂停' : '播放') + '</button>' +
          '</div>'
        : '') +
    '</div>';
  }

  function renderSettings() {
    if (!els.settingsBody) return;
    var min = cfg.autoLock;
    var opts = [[0, '不锁'], [1, '1 分钟'], [3, '3 分钟'], [10, '10 分钟']];
    var seg = opts.map(function (o) {
      return '<button type="button" class="seg' + (min === o[0] ? ' is-on' : '') +
        '" data-auto="' + o[0] + '">' + o[1] + '</button>';
    }).join('');

    els.settingsBody.innerHTML =
      '<div class="set-row">' +
        '<div class="set-label">闲置后自动上锁</div>' +
        '<div class="seg-group">' + seg + '</div>' +
      '</div>' +
      '<div class="set-row">' +
        '<div class="set-label">离开标签页 30 秒后上锁' +
          '<i>切到别的窗口，回来时不希望被人看见</i></div>' +
        '<button type="button" class="sw' + (cfg.lockOnHide ? ' is-on' : '') + '" data-hide="1">' +
          '<span></span></button>' +
      '</div>' +
      '<div class="set-row">' +
        '<div class="set-label">' + (rec ? '开锁短语' : '门锁') +
          '<i>' + (rec
            ? (rec.hint ? '提示：' + escapeHtml(rec.hint) : '没有设置提示语')
            : '现在没有上锁，随手打开就能看见') + '</i></div>' +
        '<button type="button" class="ghost-btn' + (rec ? '' : ' is-strong') + '" data-change="1">' +
          (rec ? '更改' : '上锁') + '</button>' +
      '</div>' +
      '<p class="set-note">门锁拦的是随手打开的人。记忆正文仍以明文存在 data/memories.js，' +
        '能打开源码的人照样看得到——要防这一层，得给内容本身加密。</p>' +
      musicRow();

    var bgm = els.settingsBody.querySelector('[data-bgm]');
    if (bgm) {
      bgm.addEventListener('click', function () {
        if (!window.SeaMusic) return;
        var on = bgm.getAttribute('data-on') !== '1';
        window.SeaMusic.setEnabled(on);
        if (window.SeaAudio) window.SeaAudio.setEnabled(on);
        renderSettings();
      });
    }
    var bgmNext = els.settingsBody.querySelector('[data-bgmnext]');
    if (bgmNext) {
      bgmNext.addEventListener('click', function () {
        if (!window.SeaMusic) return;
        window.SeaMusic.next();
        setTimeout(renderSettings, 400);
      });
    }

    var segs = els.settingsBody.querySelectorAll('[data-auto]');
    for (var i = 0; i < segs.length; i++) {
      segs[i].addEventListener('click', function (e) {
        cfg.autoLock = parseInt(e.currentTarget.getAttribute('data-auto'), 10) || 0;
        writeJSON(K_CFG, cfg);
        renderSettings();
      });
    }

    var sw = els.settingsBody.querySelector('[data-hide]');
    if (sw) sw.addEventListener('click', function () {
      cfg.lockOnHide = !cfg.lockOnHide;
      writeJSON(K_CFG, cfg);
      renderSettings();
    });

    var ch = els.settingsBody.querySelector('[data-change]');
    if (ch) ch.addEventListener('click', function () {
      closeSettings();
      if (!rec) { openSetupOverlay(); return; }
      state.mode = 'change';
      if (els.screen) {
        els.screen.classList.remove('is-hidden');
        els.screen.classList.add('is-setup');
        els.title.textContent = '换一个短语';
        els.sub.textContent = '输两遍新短语';
        els.submit.textContent = '更新';
        els.input.value = '';
        els.input.placeholder = '新短语（至少 4 位）';
        els.input2.value = '';
        els.input2.placeholder = '再输一次';
        els.input2.classList.remove('is-hidden');
        els.hintInput.classList.remove('is-hidden');
        els.hintInput.value = (rec && rec.hint) || '';
        els.msg.textContent = '';
        els.hintText.textContent = '';
        els.forget.classList.remove('is-on');
        if (els.cancel) els.cancel.classList.add('is-on');
        setTimeout(function () { els.input.focus(); }, 260);
      }
      document.body.classList.add('is-locked');
      document.dispatchEvent(new CustomEvent('sea:lock'));
      state.locked = true;
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ------------------------------------------------------------------
   * 7. 自动上锁
   * ------------------------------------------------------------------ */
  function markActive() { state.lastActive = Date.now(); }

  ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, markActive, { passive: true });
  });

  setInterval(function () {
    if (state.locked || !rec) return;
    if (cfg.autoLock > 0 && Date.now() - state.lastActive > cfg.autoLock * 60000) lock(true);
  }, 1500);

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      hiddenAt = Date.now();
    } else if (!state.locked && cfg.lockOnHide && hiddenAt && Date.now() - hiddenAt > 30000) {
      lock(true);
    }
  });

  document.addEventListener('keydown', function (e) {
    if (state.locked) return;
    if (e.key === 'Escape') {
      var now = Date.now();
      if (now - lastEsc < 700) lock(true);
      lastEsc = now;
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
      e.preventDefault();
      lock(true);
    }
  });

  /* ------------------------------------------------------------------
   * 8. 初始化
   * ------------------------------------------------------------------ */
  function init() {
    els.screen = document.getElementById('lockScreen');
    els.card = document.querySelector('#lockScreen .lock-card');
    els.title = document.getElementById('lockTitle');
    els.sub = document.getElementById('lockSub');
    els.input = document.getElementById('lockInput');
    els.input2 = document.getElementById('lockInput2');
    els.hintInput = document.getElementById('lockHint');
    els.hintText = document.getElementById('lockHintText');
    els.msg = document.getElementById('lockMsg');
    els.submit = document.getElementById('lockSubmit');
    els.forget = document.getElementById('lockForget');
    els.form = document.getElementById('lockForm');
    els.settings = document.getElementById('privacy');
    els.settingsBody = document.getElementById('privacyBody');
    els.openBtn = document.getElementById('privacyBtn');
    els.closeBtn = document.getElementById('privacyClose');
    els.lockNow = document.getElementById('privacyLockNow');
    els.cancel = document.getElementById('lockCancel');

    if (!els.screen) return;

    if (els.form) {
      els.form.addEventListener('submit', function (e) {
        e.preventDefault();
        submit();
      });
    }

    if (els.forget) {
      els.forget.addEventListener('click', function () {
        var ok = window.confirm(
          '忘记短语无法找回，只能清掉这道门（记忆内容不受影响）。\n\n' +
          '确定要清除门锁吗？'
        );
        if (ok) {
          rawDel(K_REC);
          rawDel(K_CFG);
          rawDel(K_TRUST);
          rec = null;
          cfg = Object.assign({}, DEFAULT_CFG, {});
          buildSetupUI();
          state.mode = 'setup';
          state.locked = true;
          document.body.classList.add('is-locked');
          document.dispatchEvent(new CustomEvent('sea:lock'));
        }
      });
    }

    if (els.cancel) {
      els.cancel.addEventListener('click', function () {
        if (state.mode === 'setup') {
          // "以后再说"：收起卡片，画面从来没停过
          state.locked = false;
          els.screen.classList.add('is-hidden');
          return;
        }
        if (state.mode !== 'change') return;
        state.mode = rec ? 'unlock' : 'setup';
        if (rec) buildUnlockUI();
        else buildSetupUI();
      });
    }

    if (els.openBtn) els.openBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openSettings();
    });
    if (els.closeBtn) els.closeBtn.addEventListener('click', closeSettings);    if (els.lockNow) els.lockNow.addEventListener('click', function () {
      closeSettings();
      lock(false);
    });
    if (els.settings) {
      els.settings.addEventListener('click', function (e) {
        if (e.target === els.settings) closeSettings();
      });
    }

    // 决定初始状态
    // 改：第一次来访不再强制设短语——先把记忆给到人，想上锁再从设置里上锁。
    if (!rec) {
      state.mode = 'setup';
      state.locked = false;
      document.body.classList.remove('is-locked');
      if (els.screen) els.screen.classList.add('is-hidden');
      state.lastActive = Date.now();
    } else if (isTrusted() || isSessionUnlocked()) {
      state.locked = false;
      els.screen.classList.add('is-hidden');
      state.lastActive = Date.now();
    } else {
      state.locked = true;
      document.body.classList.add('is-locked');
      els.screen.classList.remove('is-hidden');
      buildUnlockUI();
      setTimeout(function () { if (els.input) els.input.focus(); }, 400);
      document.dispatchEvent(new CustomEvent('sea:lock'));
    }

    // 主程序的 tick 在本文件 init 之前就把 SeaLock.isLocked() 缓存进了 lockedOverride
    // （初始值是 true），所以凡是"没上锁"的开局都必须补一次 sea:unlock，
    // 否则画面永远不启动——这就是解锁后刷新白屏的元凶。
    if (!state.locked) {
      document.dispatchEvent(new CustomEvent('sea:unlock'));
    }
  }

  window.SeaLock = {
    isLocked: function () { return state.locked; },
    hasPass: function () { return !!rec; },
    lock: function () { lock(false); },
    openSettings: openSettings,
    reset: function () {
      rawDel(K_REC); rawDel(K_CFG); rawDel(K_TRUST); rawDel(K_SESSION);
      window.location.reload();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
