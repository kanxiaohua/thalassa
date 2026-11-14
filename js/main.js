/* =====================================================================
 *  识海 · 神经光球版主程序
 * ---------------------------------------------------------------------
 *  依赖：vendor/three.min.js（本地 UMD，双击 index.html 即可运行）
 *        js/audio.js（程序化音景，可选，缺失时静默降级）
 *  数据：data/memories.js
 *
 *  这一版的核心变化：从"散落的星团"变成"一颗由粒子构成的球"。
 *
 *    · 光球：约 3000 颗粒子均匀铺在球壳上，球内有少量粒子透出体积，
 *      球心是一团核光。远看是一颗球，近看每一颗都是独立的粒子。
 *    · 神经纤维：球面上有 26 条随机游走的光丝，丝上串着更亮的粒子，
 *      丝与丝之间用短弧相连 —— 这是"神经"的质感来源。
 *    · 脑区：同 tag 的记忆聚在球面的一块"皮质区"里（球冠），
 *      区内的神经元之间用贴着球面拱起的弧线相连。
 *    · 投射纤维：不同脑区之间有几条穿过球心的长纤维，像白质束。
 *    · 放电：点开一颗神经元时，冲动会沿纤维一路传下去 ——
 *      脉冲抵达的神经元会跟着亮一下，再继续往下传。
 *    · 心跳：整颗球在缓慢地涨缩，每 3.6 秒有一次更明显的搏动。
 *    · 转动：按住拖动可以像转一颗大脑一样转动整颗球。
 * ===================================================================== */

(function () {
  'use strict';

  /* ------------------------------------------------------------------
   * 1. 配置
   * ------------------------------------------------------------------ */
  var CFG = {
    R: 7.6,                 // 光球半径
    maxParticles: 400,

    // 神经云（不可点击，只负责"这是一团由粒子组成的实体"）
    shellCount: 9000,       // 球壳粒子
    innerCount: 7200,       // 球内粒子（实心）
    filamentCount: 44,      // 更密的"丝"，只由粒子串成，不画线
    filamentPoints: 44,

    // 脑区
    regionSpread: 0.58,     // 每块脑区的张角（弧度）

    // 连通关系（只用于脉冲传播，不再画成线）
    maxLinks: 220,
    linkDistance: 6.4,

    // 物理
    homePull: 1.5,
    radialPull: 4.2,
    wanderStrength: 0.30,
    sepRadius: 1.75,
    sepStrength: 2.6,
    damping: 2.6,
    maxSpeed: 1.8,

    // 外观
    particleSize: [0.92, 1.38],
    cameraFov: 52,
    cameraDistance: 24.5,
    cameraMin: 1.6,         // 可以一路推进到球体内部
    cameraMax: 44,

    // 交互
    mouseRadius: 4.8,
    mouseForce: 11,
    hoverPx: 34,

    // 节律：呼吸 / 心跳
    breathPeriod: 6.4,
    beatPeriod: 3.6,

    // 电位波（原潮汐）：一道兴奋从球的一侧扫到另一侧
    tidePeriod: [13, 21],
    tideStrength: 0.9,
    tideWidth: 4.2,

    // 共鸣
    resonanceDist: 2.2,
    resonanceCool: 8.0,
    resonanceMax: 14,

    // 低语
    whisperPeriod: [8, 14],
    whisperLife: 4.4,

    starCount: 1500,
    dustCount: 620,
    maxPixelRatio: 2
  };

  var TAU = Math.PI * 2;
  var clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
  var lerp = function (a, b, t) { return a + (b - a) * t; };
  var damp = function (cur, target, lambda, dt) {
    return lerp(cur, target, 1 - Math.exp(-lambda * dt));
  };

  var params = new URLSearchParams(window.location.search);
  var DEBUG = params.has('debug');

  /* ------------------------------------------------------------------
   * 2. 记忆数据：解析 tag / 时间 / 颜色
   * ------------------------------------------------------------------ */
  var TAG_PALETTE = [
    0x9b7bff, 0x74d8f2, 0xc79bff, 0x6f9dff,
    0x8ff0d4, 0xff9ad5, 0xa9b8ff, 0xd9c4ff
  ];

  var YEAR_MS = 365.25 * 24 * 3600 * 1000;
  var NOW = Date.now();

  function parseTime(str) {
    if (!str) return NOW;
    var t = Date.parse(str);
    if (isNaN(t)) {
      var y = parseInt(str, 10);
      if (!isNaN(y)) return new Date(y, 6, 1).getTime();
      return NOW;
    }
    return t;
  }

  function readMemories() {
    var raw = window.MEMORIES;
    if (!Array.isArray(raw) || raw.length === 0) {
      raw = [{
        title: '空白的识海',
        text: '还没有任何记忆。\n\n打开 data/memories.js，照着示例写下第一条。',
        image: '',
        tag: '未名'
      }];
    }
    return raw.filter(function (m) { return m && typeof m === 'object'; })
      .slice(0, CFG.maxParticles)
      .map(function (m, i) {
        var created = parseTime(m.createdAt || m.date);
        var age = Math.max(0, (NOW - created) / YEAR_MS);
        // 一条记忆可以挂多张照片：images 优先，image 兼容单张的老写法
        var pics = [];
        if (Object.prototype.toString.call(m.images) === '[object Array]') {
          for (var p = 0; p < m.images.length; p++) {
            if (m.images[p]) pics.push(String(m.images[p]));
          }
        }
        if (!pics.length && m.image) pics.push(String(m.image));
        return {
          title: m.title ? String(m.title) : ('第 ' + (i + 1) + ' 段记忆'),
          text: m.text ? String(m.text) : '',
          image: pics[0] || '',
          images: pics,
          date: m.date ? String(m.date) : '',
          tag: m.tag ? String(m.tag) : '未名',
          age: age,
          color: m.color || null,
          size: typeof m.size === 'number' ? clamp(m.size, 0.5, 2.6) : 1
        };
      });
  }

  var MEMORIES = readMemories();
  var COUNT = MEMORIES.length;

  var TAG_NAMES = [];
  var TAG_OF = [];
  var TAG_MEMBERS = [];

  MEMORIES.forEach(function (m, i) {
    var t = TAG_NAMES.indexOf(m.tag);
    if (t === -1) {
      t = TAG_NAMES.length;
      TAG_NAMES.push(m.tag);
      TAG_MEMBERS.push([]);
    }
    TAG_OF[i] = t;
    TAG_MEMBERS[t].push(i);
  });

  var TAG_COLOR = TAG_NAMES.map(function (_, i) { return TAG_PALETTE[i % TAG_PALETTE.length]; });

  /* ------------------------------------------------------------------
   * 2.5 使用痕迹
   *   每次打开一条记忆都记一笔：被反复看过的更亮、更稳；
   *   半年没碰过的会慢慢暗下去。这样球上留下的不是数据，是习惯。
   * ------------------------------------------------------------------ */
  var USAGE_KEY = 'sea.usage.v1';
  var DAY_MS = 86400000;
  var usage = {};

  (function loadUsage() {
    try {
      var raw = window.localStorage.getItem(USAGE_KEY);
      var obj = raw ? JSON.parse(raw) : null;
      if (obj && typeof obj === 'object') usage = obj;
    } catch (e) { usage = {}; }
  })();

  function usageOf(i) {
    var m = MEMORIES[i];
    if (!m) return { n: 0, t: 0 };
    var u = usage[m.title];
    return (u && typeof u.n === 'number') ? u : { n: 0, t: 0 };
  }

  function saveUsage() {
    try { window.localStorage.setItem(USAGE_KEY, JSON.stringify(usage)); } catch (e) { }
  }

  function markOpened(i) {
    var m = MEMORIES[i];
    if (!m) return null;
    var u = usage[m.title] || { n: 0, t: 0 };
    u.n = (u.n || 0) + 1;
    u.t = Date.now();
    usage[m.title] = u;
    saveUsage();
    return u;
  }

  // 0.72 ~ 1.34：没打开过的最暗，反复看过的接近上限
  function usageStrength(i) {
    var u = usageOf(i);
    if (!u.n) return 0.93;                     // 没被打开过：只是"还没亮起来"，不是惩罚
    var visits = Math.min(1, Math.log(1 + u.n) / Math.log(14));
    var fresh = u.t ? clamp(1 - (Date.now() - u.t) / (200 * DAY_MS), 0, 1) : 0;
    return 0.95 + 0.26 * visits + 0.12 * fresh;
  }

  function usageLine(i) {
    var u = usageOf(i);
    if (!u.n) return '';
    var days = Math.max(0, Math.floor((Date.now() - (u.t || 0)) / DAY_MS));
    var when = days <= 0 ? '今天' : (days === 1 ? '昨天' : days + ' 天前');
    if (u.n === 1) return '第一次打开 · ' + when;
    return '第 ' + u.n + ' 次打开 · 上次是 ' + when;
  }

  /* ------------------------------------------------------------------
   * 3. DOM / 错误兜底
   * ------------------------------------------------------------------ */
  var canvas = document.getElementById('scene');
  var bootEl = document.getElementById('boot');
  var bootText = document.getElementById('bootText');
  var panelEl = document.getElementById('panel');
  var panelIndex = document.getElementById('panelIndex');
  var panelDate = document.getElementById('panelDate');
  var panelTag = document.getElementById('panelTag');
  var panelTitle = document.getElementById('panelTitle');
  var panelText = document.getElementById('panelText');
  var panelImage = document.getElementById('panelImage');
  var panelFigure = panelEl.querySelector('.panel-figure');
  var panelVisit = document.getElementById('panelVisit');
  var figPrev = document.getElementById('figPrev');
  var figNext = document.getElementById('figNext');
  var figDots = document.getElementById('figDots');
  var fallbackGlyph = document.getElementById('fallbackGlyph');
  var panelClose = document.getElementById('panelClose');
  var memCount = document.getElementById('memCount');
  var soundBtn = document.getElementById('soundBtn');
  var clusterNavEl = document.getElementById('clusterNav');
  var whisperEl = document.getElementById('whisper');
  var whisperTitleEl = whisperEl ? whisperEl.querySelector('.whisper-title') : null;
  var tipEl = document.getElementById('tip');
  var hintEl = document.getElementById('hint');
  var animatedBits = panelEl.querySelectorAll('.panel-meta, .panel-title, .panel-figure, .panel-text, .panel-foot');

  var diagEl = null;

  function writeDiag(payload) {
    if (!DEBUG) return;
    if (!diagEl) {
      diagEl = document.createElement('div');
      diagEl.id = 'diag';
      diagEl.style.display = 'none';
      document.body.appendChild(diagEl);
    }
    diagEl.textContent = JSON.stringify(payload);
  }

  function fail(msg) {
    if (bootEl) {
      bootEl.classList.remove('is-hidden');
      bootEl.classList.add('is-error');
    }
    if (bootText) bootText.textContent = msg;
    document.title = 'ERR · ' + msg;
    writeDiag({ error: msg });
    if (window.console) console.error('[识海] ' + msg);
  }

  if (!window.THREE) {
    fail('three.js 没有加载成功，请确认 vendor/three.min.js 文件存在。');
    return;
  }

  if (memCount) memCount.textContent = String(COUNT);

  var AUDIO = window.SeaAudio || null;
  var MUSIC = window.SeaMusic || null;   // 背景音乐（曲子在 assets/music/，缺席就静默）

  /* ------------------------------------------------------------------
   * 4. 渲染器 / 场景 / 相机
   * ------------------------------------------------------------------ */
  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas: canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance'
    });
  } catch (e) {
    fail('当前浏览器无法创建 WebGL 上下文，请换用 Chrome / Edge 打开。');
    return;
  }

  var pixelRatio = Math.min(window.devicePixelRatio || 1, CFG.maxPixelRatio);
  renderer.setPixelRatio(pixelRatio);
  renderer.setClearAlpha(0);

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(CFG.cameraFov, 1, 0.1, 700);
  camera.position.set(0, 0, CFG.cameraDistance);

  var field = new THREE.Group();      // 整颗球（会自转）
  scene.add(field);

  var viewW = window.innerWidth;
  var viewH = window.innerHeight;

  function perspectiveScale() {
    return (viewH * pixelRatio * 0.5) / Math.tan((CFG.cameraFov * Math.PI / 180) / 2);
  }

  /* ------------------------------------------------------------------
   * 5. 纹理：光点 / 圆环 / 程序化星云
   * ------------------------------------------------------------------ */
  function makeGlowTexture() {
    var size = 256;
    var cv = document.createElement('canvas');
    cv.width = cv.height = size;
    var ctx = cv.getContext('2d');
    var g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0.0, 'rgba(255,255,255,1)');
    g.addColorStop(0.18, 'rgba(255,255,255,0.62)');
    g.addColorStop(0.38, 'rgba(255,255,255,0.22)');
    g.addColorStop(0.62, 'rgba(255,255,255,0.06)');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    var tex = new THREE.CanvasTexture(cv);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
  }

  function makeRingTexture() {
    var size = 256;
    var cv = document.createElement('canvas');
    cv.width = cv.height = size;
    var ctx = cv.getContext('2d');
    var c = size / 2;
    var g = ctx.createRadialGradient(c, c, size * 0.20, c, c, size * 0.5);
    g.addColorStop(0.0, 'rgba(255,255,255,0)');
    g.addColorStop(0.52, 'rgba(255,255,255,0.02)');
    g.addColorStop(0.74, 'rgba(255,255,255,0.30)');
    g.addColorStop(0.86, 'rgba(255,255,255,0.55)');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    var tex = new THREE.CanvasTexture(cv);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
  }

  // 程序化星云：4 阶 fbm 噪声 + 径向遮罩
  function makeNebulaTexture(size) {
    var cv = document.createElement('canvas');
    cv.width = cv.height = size;
    var ctx = cv.getContext('2d');
    var img = ctx.createImageData(size, size);
    var data = img.data;

    function hash2(x, y) {
      var n = (x * 374761393 + y * 668265263) | 0;
      n = (n ^ (n >> 13)) * 1274126177 | 0;
      return ((n ^ (n >> 16)) >>> 0) / 4294967295;
    }

    function vnoise(x, y) {
      var xi = Math.floor(x), yi = Math.floor(y);
      var xf = x - xi, yf = y - yi;
      var u = xf * xf * (3 - 2 * xf);
      var v = yf * yf * (3 - 2 * yf);
      var a = hash2(xi, yi), b = hash2(xi + 1, yi);
      var c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
      return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
    }

    function fbm(x, y) {
      var s = 0, amp = 0.55, f = 1;
      for (var o = 0; o < 4; o++) {
        s += amp * vnoise(x * f, y * f);
        f *= 2.05;
        amp *= 0.5;
      }
      return s;
    }

    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var nx = x / size - 0.5;
        var ny = y / size - 0.5;
        var r = Math.sqrt(nx * nx + ny * ny) * 2;

        var n1 = fbm(x / size * 3.4 + 11.3, y / size * 3.4 + 4.7);
        var n2 = fbm(x / size * 7.1 - 2.5, y / size * 2.2 + 8.1);
        var dens = n1 * 0.75 + n2 * 0.45;

        var edge = clamp(1 - r, 0, 1);
        var mask = Math.pow(edge, 2.2) * (0.25 + dens * 1.35);
        var alpha = clamp(Math.pow(mask, 1.35), 0, 1);

        var idx = (y * size + x) * 4;
        data[idx] = 255;
        data[idx + 1] = 255;
        data[idx + 2] = 255;
        data[idx + 3] = Math.floor(alpha * 255);
      }
    }

    ctx.putImageData(img, 0, 0);
    var tex = new THREE.CanvasTexture(cv);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
  }

  var glowTexture = makeGlowTexture();
  var ringTexture = makeRingTexture();
  var nebulaTexture = makeNebulaTexture(256);

  /* ------------------------------------------------------------------
   * 6. 星云背景（远、淡，不能抢光球）
   * ------------------------------------------------------------------ */
  var nebulae = [];
  var nebulaDefs = [
    { x: -16, y: 9, z: -34, s: 96, color: 0x5b2bd8, opacity: 0.34, sp: 0.11, rot: 0.4 },
    { x: 17, y: -8, z: -38, s: 110, color: 0x2a4fd0, opacity: 0.22, sp: -0.08, rot: -0.9 },
    { x: 4, y: 13, z: -26, s: 70, color: 0xb03bd8, opacity: 0.16, sp: 0.15, rot: 1.7 },
    { x: 0, y: 0, z: -52, s: 140, color: 0x3a1c8a, opacity: 0.30, sp: 0.04, rot: 0.9 }
  ];

  nebulaDefs.forEach(function (d) {
    var mat = new THREE.SpriteMaterial({
      map: nebulaTexture,
      color: d.color,
      transparent: true,
      opacity: d.opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      rotation: d.rot
    });
    var sp = new THREE.Sprite(mat);
    sp.position.set(d.x, d.y, d.z);
    sp.scale.set(d.s, d.s * 0.86, 1);
    sp.renderOrder = -4;
    scene.add(sp);
    nebulae.push({ sprite: sp, base: d, phase: Math.random() * TAU });
  });

  /* ------------------------------------------------------------------
   * 7. 发光着色器（所有粒子共用）
   * ------------------------------------------------------------------ */
  var VERT = [
    'attribute float aSize;',
    'attribute float aPhase;',
    'attribute float aGlow;',
    'attribute vec3 aColor;',
    'uniform float uTime;',
    'uniform float uDrift;',
    'uniform float uPixelScale;',
    'uniform float uSizeScale;',
    'uniform float uAlpha;',
    'uniform float uBeat;',
    'uniform vec2 uNear;',
    'varying vec3 vColor;',
    'varying float vAlpha;',
    'varying float vDepth;',
    'void main() {',
    '  vec3 p = position;',
    '  float phase = aPhase * 6.2831853;',
    '  if (uDrift > 0.5) {',
    '    p.x += sin(uTime * 0.31 + phase * 3.1) * 0.16;',
    '    p.y += cos(uTime * 0.27 + phase * 2.3) * 0.16;',
    '    p.z += sin(uTime * 0.23 + phase * 4.7) * 0.16;',
    '  }',
    '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
    '  float pulse = 0.80 + 0.20 * sin(uTime * 1.15 + phase);',
    '  float s = aSize * uSizeScale * pulse;',
    '  gl_PointSize = clamp(s * uPixelScale / max(0.001, -mv.z), 1.0, 190.0);',
    '  vColor = aColor;',
    '  vAlpha = uAlpha * (0.78 + 0.22 * pulse) * aGlow * uBeat;',
    '  vDepth = -mv.z;',
    '  vAlpha *= smoothstep(uNear.x, uNear.y, vDepth);',
    '  gl_Position = projectionMatrix * mv;',
    '}'
  ].join('\n');

  var FRAG = [
    'uniform vec3 uFogColor;',
    'uniform vec2 uFogRange;',
    'uniform float uFogAmt;',
    'varying vec3 vColor;',
    'varying float vAlpha;',
    'varying float vDepth;',
    'void main() {',
    '  vec2 uv = gl_PointCoord - vec2(0.5);',
    '  float d = length(uv) * 2.0;',
    '  if (d > 1.0) discard;',
    '  float core = pow(1.0 - d, 2.6);',
    '  float halo = exp(-d * d * 1.9) * 0.72;',
    '  float edge = 1.0 - smoothstep(0.45, 1.0, d);',
    '  float a = (core * 0.85 + halo * 0.75) * vAlpha * edge;',
    '  vec3 col = mix(vColor, vec3(1.0), core * 0.35);',
    '  float fog = smoothstep(uFogRange.x, uFogRange.y, vDepth) * uFogAmt;',
    '  col = mix(col, uFogColor, fog * 0.5);',
    '  a *= (1.0 - fog * 0.55);',
    '  gl_FragColor = vec4(col * a, a);',
    '}'
  ].join('\n');

  var FOG = { color: 0x241048, near: 21, far: 38, amt: 0.85 };

  function makeGlowMaterial(sizeScale, alpha, drift, fog, nearFade) {
    fog = fog || FOG;
    nearFade = nearFade || [0, 0];
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uDrift: { value: drift ? 1 : 0 },
        uPixelScale: { value: perspectiveScale() },
        uSizeScale: { value: sizeScale },
        uAlpha: { value: alpha },
        uBeat: { value: 1 },
        uNear: { value: new THREE.Vector2(nearFade[0], nearFade[1]) },
        uFogColor: { value: new THREE.Color(fog.color) },
        uFogRange: { value: new THREE.Vector2(fog.near, fog.far) },
        uFogAmt: { value: fog.amt }
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending
    });
  }

  var glowMats = [];
  function trackMaterial(m) { glowMats.push(m); return m; }

  /* ------------------------------------------------------------------
   * 8. 背景星尘
   * ------------------------------------------------------------------ */
  var starMat = trackMaterial(makeGlowMaterial(0.42, 0.42, false, { color: 0x1b0e3a, near: 150, far: 340, amt: 0.8 }));
  (function buildStars() {
    var n = CFG.starCount;
    var pos = new Float32Array(n * 3);
    var col = new Float32Array(n * 3);
    var siz = new Float32Array(n);
    var pha = new Float32Array(n);
    var glo = new Float32Array(n);
    var c = new THREE.Color();
    for (var i = 0; i < n; i++) {
      var r = 60 + Math.random() * 130;
      var theta = Math.random() * TAU;
      var phi = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * 0.8;
      pos[i * 3 + 2] = r * Math.cos(phi);

      var t = Math.random();
      if (t < 0.55) c.setHex(0xdfe8ff);
      else if (t < 0.8) c.setHex(0xc7b6ff);
      else if (t < 0.93) c.setHex(0xffd6ef);
      else c.setHex(0xa8ecff);

      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      siz[i] = 0.26 + Math.pow(Math.random(), 2.2) * 0.9;
      pha[i] = Math.random();
      glo[i] = 0.3 + Math.random() * 0.7;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(pha, 1));
    g.setAttribute('aGlow', new THREE.BufferAttribute(glo, 1));
    var pts = new THREE.Points(g, starMat);
    pts.frustumCulled = false;
    pts.renderOrder = -1;
    scene.add(pts);
  })();

  /* ------------------------------------------------------------------
   * 9. 脑区：球面上均匀分布的若干个"皮质区"中心
   * ------------------------------------------------------------------ */
  var REGION_AXES = [];
  (function layoutRegions() {
    var n = TAG_NAMES.length;
    for (var i = 0; i < n; i++) {
      var y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2;
      var rad = Math.sqrt(Math.max(0, 1 - y * y));
      var phi = i * 2.399963;
      REGION_AXES.push(new THREE.Vector3(Math.cos(phi) * rad, y, Math.sin(phi) * rad).normalize());
    }
  })();

  function tangentBasis(a, u, v) {
    var up = Math.abs(a.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    u.copy(up).cross(a).normalize();
    v.copy(a).cross(u).normalize();
  }

  /** 在轴 a 周围、角半径 spread 的球冠内取一个方向 */
  function capDirection(a, u, v, spread, out) {
    var cosMax = Math.cos(spread);
    var cz = 1 - Math.random() * (1 - cosMax);
    var sr = Math.sqrt(Math.max(0, 1 - cz * cz));
    var ang = Math.random() * TAU;
    out.copy(a).multiplyScalar(cz)
      .addScaledVector(u, sr * Math.cos(ang))
      .addScaledVector(v, sr * Math.sin(ang));
    return out.normalize();
  }

  /* ------------------------------------------------------------------
   * 10. 粒子云：球壳 + 球内体积 + 内部纤维
   *     —— 全部只用粒子，一根线条都不画（没有"轨道"）
   * ------------------------------------------------------------------ */
  var scPos = [];
  var scCol = [];
  var scSize = [];
  var scPhase = [];
  var scGlow = [];
  var scRegion = [];        // 每颗粒子归属哪块脑区（-1 = 不属于任何区）
  var scBaseGlow = [];

  var tmpA = new THREE.Vector3();
  var tmpB = new THREE.Vector3();

  function pushScaffold(x, y, z, size, glow, colorHex, region) {
    scPos.push(x, y, z);
    var c = new THREE.Color(colorHex);
    scCol.push(c.r, c.g, c.b);
    scSize.push(size);
    scPhase.push(Math.random());
    scGlow.push(glow);
    scBaseGlow.push(glow);
    scRegion.push(region);
  }

  /** 这颗粒子在哪个脑区的锥体里（球内粒子也算，所以脑区是"从球心到球面"的一束） */
  function regionOfDir(x, y, z) {
    var len = Math.sqrt(x * x + y * y + z * z) || 1;
    var nx = x / len, ny = y / len, nz = z / len;
    var best = -1, bestDot = 0.70;
    for (var i = 0; i < REGION_AXES.length; i++) {
      var a = REGION_AXES[i];
      var d = nx * a.x + ny * a.y + nz * a.z;
      if (d > bestDot) { bestDot = d; best = i; }
    }
    return best;
  }

  (function buildScaffold() {
    var cA = new THREE.Color(0x8b7bff);
    var cB = new THREE.Color(0x74d8f2);
    var cC = new THREE.Color(0xff9ad5);
    var c = new THREE.Color();
    var i, k;

    // —— 球壳：斐波那契均匀铺点，密到能"织"出一层壳
    var N = CFG.shellCount;
    for (i = 0; i < N; i++) {
      var t = (i + 0.5) / N;
      var y = 1 - 2 * t;
      var rad = Math.sqrt(Math.max(0, 1 - y * y));
      var phi = i * 2.39996323;
      var nx = Math.cos(phi) * rad, nz = Math.sin(phi) * rad;
      var rr = CFG.R * (0.972 + Math.random() * 0.055);

      k = Math.random();
      if (k < 0.60) c.copy(cA);
      else if (k < 0.86) c.copy(cB);
      else c.copy(cC);
      c.multiplyScalar(0.58 + Math.random() * 0.55);

      pushScaffold(nx * rr, y * rr, nz * rr,
        0.10 + Math.pow(Math.random(), 1.8) * 0.20,
        0.22 + Math.random() * 0.52, c.getHex(), regionOfDir(nx, y, nz));
    }

    // —— 球内：实心体积。指数 0.46 让靠近球心的地方也不空
    for (i = 0; i < CFG.innerCount; i++) {
      var u = Math.random() * TAU;
      var v = Math.acos(2 * Math.random() - 1);
      var rIn = CFG.R * Math.pow(Math.random(), 0.46) * 0.985;
      var ix = Math.sin(v) * Math.cos(u), iy = Math.cos(v), iz = Math.sin(v) * Math.sin(u);

      k = Math.random();
      if (k < 0.72) c.copy(cA);
      else if (k < 0.92) c.copy(cB);
      else c.copy(cC);
      c.multiplyScalar(0.42 + Math.random() * 0.5);

      pushScaffold(ix * rIn, iy * rIn, iz * rIn,
        0.085 + Math.pow(Math.random(), 2.0) * 0.17,
        0.11 + Math.random() * 0.34, c.getHex(), regionOfDir(ix, iy, iz));
    }

    // —— 内部纤维：两点之间穿过球体的一次"走线"，控制点被拉向球心。
    //    它们比周围粒子更亮，于是看起来像埋在球里的神经束，而不是轨道。
    for (var f = 0; f < CFG.filamentCount; f++) {
      tmpA.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(CFG.R * 0.96);
      tmpB.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(CFG.R * 0.96);
      var dip = 0.05 + Math.random() * 0.62;
      var cx = (tmpA.x + tmpB.x) * 0.5 * dip;
      var cy = (tmpA.y + tmpB.y) * 0.5 * dip;
      var cz = (tmpA.z + tmpB.z) * 0.5 * dip;
      var wob = 0.06 + Math.random() * 0.14;

      for (var s = 0; s < CFG.filamentPoints; s++) {
        var tt = s / (CFG.filamentPoints - 1);
        var it = 1 - tt;
        var px = it * it * tmpA.x + 2 * it * tt * cx + tt * tt * tmpB.x;
        var py = it * it * tmpA.y + 2 * it * tt * cy + tt * tt * tmpB.y;
        var pz = it * it * tmpA.z + 2 * it * tt * cz + tt * tt * tmpB.z;
        px += (Math.random() - 0.5) * wob;
        py += (Math.random() - 0.5) * wob;
        pz += (Math.random() - 0.5) * wob;

        pushScaffold(px, py, pz,
          0.12 + Math.random() * 0.20,
          0.42 + Math.random() * 0.5, 0x9c8cff, regionOfDir(px, py, pz));
      }
    }

    scPos = new Float32Array(scPos);
    scCol = new Float32Array(scCol);
    scSize = new Float32Array(scSize);
    scPhase = new Float32Array(scPhase);
    scGlow = new Float32Array(scGlow);
    scBaseGlow = new Float32Array(scBaseGlow);
    scRegion = new Int16Array(scRegion);
  })();

  var scGeo = new THREE.BufferGeometry();
  scGeo.setAttribute('position', new THREE.BufferAttribute(scPos, 3));
  scGeo.setAttribute('aColor', new THREE.BufferAttribute(scCol, 3));
  scGeo.setAttribute('aSize', new THREE.BufferAttribute(scSize, 1));
  scGeo.setAttribute('aPhase', new THREE.BufferAttribute(scPhase, 1));
  scGeo.setAttribute('aGlow', new THREE.BufferAttribute(scGlow, 1));
  scGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), CFG.R * 1.4);

  var scMat = trackMaterial(makeGlowMaterial(1.0, 0.50, true, FOG, [0.9, 3.4]));
  var scPoints = new THREE.Points(scGeo, scMat);
  scPoints.frustumCulled = false;
  scPoints.renderOrder = 1;
  field.add(scPoints);

  /* ------------------------------------------------------------------
   * 11. 核光 / 边缘辉光：让"球"的轮廓成立
   * ------------------------------------------------------------------ */
  var coreSpriteMat = new THREE.SpriteMaterial({
    map: glowTexture,
    color: 0x5b3cff,
    transparent: true,
    opacity: 0.34,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false
  });
  var coreSprite = new THREE.Sprite(coreSpriteMat);
  coreSprite.scale.set(CFG.R * 2.5, CFG.R * 2.5, 1);
  coreSprite.renderOrder = -2;
  field.add(coreSprite);

  var haloMatOuter = new THREE.SpriteMaterial({
    map: glowTexture,
    color: 0x8e6bff,
    transparent: true,
    opacity: 0.10,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false
  });
  var haloOuter = new THREE.Sprite(haloMatOuter);
  haloOuter.scale.set(CFG.R * 4.4, CFG.R * 4.4, 1);
  haloOuter.renderOrder = -3;
  field.add(haloOuter);

  // 菲涅尔薄壳：只在球的边缘发亮，把轮廓"箍"出来
  var SHELL_VERT = [
    'varying vec3 vN;',
    'varying vec3 vV;',
    'varying float vY;',
    'void main() {',
    '  vN = normalize(normalMatrix * normal);',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  vV = -mv.xyz;',
    '  vY = position.y;',
    '  gl_Position = projectionMatrix * mv;',
    '}'
  ].join('\n');

  var SHELL_FRAG = [
    'uniform vec3 uColorA;',
    'uniform vec3 uColorB;',
    'uniform float uPow;',
    'uniform float uIntensity;',
    'uniform float uBeat;',
    'varying vec3 vN;',
    'varying vec3 vV;',
    'varying float vY;',
    'void main() {',
    '  vec3 n = normalize(vN);',
    '  vec3 v = normalize(vV);',
    '  float fres = pow(1.0 - abs(dot(n, v)), uPow);',
    '  float grad = clamp(vY * 0.5 + 0.5, 0.0, 1.0);',
    '  vec3 col = mix(uColorA, uColorB, grad);',
    '  float a = fres * uIntensity * uBeat;',
    '  gl_FragColor = vec4(col * a, a);',
    '}'
  ].join('\n');

  var shellMat = new THREE.ShaderMaterial({
    uniforms: {
      uColorA: { value: new THREE.Color(0x5b3cff) },
      uColorB: { value: new THREE.Color(0x4fc8ff) },
      uPow: { value: 3.2 },
      uIntensity: { value: 0.20 },
      uBeat: { value: 1 }
    },
    vertexShader: SHELL_VERT,
    fragmentShader: SHELL_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    side: THREE.FrontSide
  });
  var shellMesh = new THREE.Mesh(new THREE.SphereGeometry(CFG.R * 1.004, 64, 44), shellMat);
  shellMesh.renderOrder = 3;
  field.add(shellMesh);

  /* ------------------------------------------------------------------
   * 12. 记忆神经元
   * ------------------------------------------------------------------ */
  var posArr = new Float32Array(COUNT * 3);
  var colArr = new Float32Array(COUNT * 3);
  var sizArr = new Float32Array(COUNT);
  var baseSiz = new Float32Array(COUNT);
  var phaseArr = new Float32Array(COUNT);
  var glowArr = new Float32Array(COUNT);
  var baseGlow = new Float32Array(COUNT);
  var glowMul = new Float32Array(COUNT);
  var usageMul = new Float32Array(COUNT);
  var flashArr = new Float32Array(COUNT);
  var whisperArr = new Float32Array(COUNT);
  var coolArr = new Float32Array(COUNT);
  var spotArr = new Float32Array(COUNT);
  var speedArr = new Float32Array(COUNT);
  var velArr = new Float32Array(COUNT * 3);
  var homeArr = new Float32Array(COUNT * 3);
  var homeR = new Float32Array(COUNT);
  var audioStep = new Int32Array(COUNT);

  var tmpColor = new THREE.Color();
  var i3;
  var density = clamp(Math.sqrt(9 / COUNT), 0.62, 1.12);

  (function placeNeurons() {
    var nReg = TAG_NAMES.length;
    var capAngle = nReg > 1 ? Math.acos(clamp(1 - 2 / nReg, -1, 1)) : Math.PI;
    var spread = Math.min(CFG.regionSpread, capAngle * 0.62);

    var u = new THREE.Vector3();
    var v = new THREE.Vector3();
    var dir = new THREE.Vector3();

    for (var i = 0; i < COUNT; i++) {
      i3 = i * 3;
      var m = MEMORIES[i];
      var tagIdx = TAG_OF[i];
      var axis = REGION_AXES[tagIdx];
      tangentBasis(axis, u, v);
      capDirection(axis, u, v, spread, dir);

      // 记忆散布在球体内部：从浅层一直到球心附近，钻进球里才能看见它们
      var r = CFG.R * (0.30 + Math.pow(Math.random(), 0.72) * 0.68);
      homeR[i] = r;
      homeArr[i3] = dir.x * r;
      homeArr[i3 + 1] = dir.y * r;
      homeArr[i3 + 2] = dir.z * r;

      // 从球心附近"长出来"，第一帧更有生长感
      var r0 = r * (0.5 + Math.random() * 0.25);
      posArr[i3] = dir.x * r0;
      posArr[i3 + 1] = dir.y * r0;
      posArr[i3 + 2] = dir.z * r0;

      velArr[i3] = 0; velArr[i3 + 1] = 0; velArr[i3 + 2] = 0;

      var glow = clamp(1 - m.age * 0.055, 0.42, 1);
      var ust = usageStrength(i);          // 用过的记忆亮一点
      usageMul[i] = ust;
      baseGlow[i] = glow;                  // 只含年龄衰减，使用痕迹在每帧里乘
      glowArr[i] = glow * ust;
      glowMul[i] = 1;
      spotArr[i] = -Math.random() * 40;
      speedArr[i] = 0.55 + glow * 0.45;

      tmpColor.setHex(m.color ? new THREE.Color(m.color).getHex() : TAG_COLOR[tagIdx]);
      colArr[i3] = tmpColor.r; colArr[i3 + 1] = tmpColor.g; colArr[i3 + 2] = tmpColor.b;

      var s = lerp(CFG.particleSize[0], CFG.particleSize[1], Math.random()) * density * (m.size || 1);
      s *= 0.76 + glow * 0.24;
      s *= lerp(0.94, 1.09, clamp((ust - 0.93) / 0.4, 0, 1)); // 常看的记忆，颗粒也大一点
      baseSiz[i] = s;
      sizArr[i] = s;
      phaseArr[i] = Math.random();
      audioStep[i] = i;
    }
  })();

  var geo = new THREE.BufferGeometry();
  var posAttr = new THREE.BufferAttribute(posArr, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('aColor', new THREE.BufferAttribute(colArr, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizArr, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phaseArr, 1));
  geo.setAttribute('aGlow', new THREE.BufferAttribute(glowArr, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), CFG.R * 1.4);

  var haloBaseAlpha = 0.46 * density;
  var haloMat = trackMaterial(makeGlowMaterial(5.0, haloBaseAlpha, false, FOG, [0.7, 2.6]));
  var coreMat = trackMaterial(makeGlowMaterial(1.0, 1.0, false, FOG, [0.5, 2.0]));

  var haloPoints = new THREE.Points(geo, haloMat);
  haloPoints.frustumCulled = false;
  haloPoints.renderOrder = 2;
  field.add(haloPoints);

  var corePoints = new THREE.Points(geo, coreMat);
  corePoints.frustumCulled = false;
  corePoints.renderOrder = 4;
  field.add(corePoints);

  /* ------------------------------------------------------------------
   * 13. 连通关系：不画线，只用来决定"冲动往哪儿传"
   * ------------------------------------------------------------------ */
  var links = [];              // { a, b, bow, base, color(hex) }
  var linksByNode = [];        // 每个神经元发出的纤维
  var linkCount = 0;

  function buildLinkList() {
    links.length = 0;
    var maxD2 = CFG.linkDistance * CFG.linkDistance;

    // 区内：每颗神经元连向同区最近的两颗，贴面拱起
    for (var t = 0; t < TAG_MEMBERS.length; t++) {
      var mem = TAG_MEMBERS[t];
      if (mem.length < 2) continue;
      for (var a = 0; a < mem.length; a++) {
        var ia = mem[a];
        var ao = ia * 3;
        var best1 = -1, b1 = maxD2, best2 = -1, b2 = maxD2;
        for (var b = 0; b < mem.length; b++) {
          var ib = mem[b];
          if (ib === ia) continue;
          var bo = ib * 3;
          var dx = posArr[ao] - posArr[bo];
          var dy = posArr[ao + 1] - posArr[bo + 1];
          var dz = posArr[ao + 2] - posArr[bo + 2];
          var d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < b1) { b2 = b1; best2 = best1; b1 = d2; best1 = ib; }
          else if (d2 < b2) { b2 = d2; best2 = ib; }
        }
        if (best1 >= 0 && !hasLink(ia, best1)) links.push({ a: ia, b: best1, bow: 0.075, base: 0.55, color: TAG_COLOR[t] });
        if (best2 >= 0 && !hasLink(ia, best2)) links.push({ a: ia, b: best2, bow: 0.075, base: 0.55, color: TAG_COLOR[t] });
      }
    }

    // 区间：相邻两块脑区之间拉一条穿过球心的长纤维（像白质束）
    var nReg = TAG_NAMES.length;
    for (var r = 0; r < nReg; r++) {
      var r2 = (r + 1) % nReg;
      if (r2 === r) continue;
      var A = TAG_MEMBERS[r], B = TAG_MEMBERS[r2];
      if (!A.length || !B.length) continue;
      var bestA = A[0], bestB = B[0], bestD = 1e9;
      for (var p = 0; p < A.length; p++) {
        for (var q = 0; q < B.length; q++) {
          var pa = A[p] * 3, qb = B[q] * 3;
          var ddx = posArr[pa] - posArr[qb];
          var ddy = posArr[pa + 1] - posArr[qb + 1];
          var ddz = posArr[pa + 2] - posArr[qb + 2];
          var dd = ddx * ddx + ddy * ddy + ddz * ddz;
          if (dd < bestD) { bestD = dd; bestA = A[p]; bestB = B[q]; }
        }
      }
      if (!hasLink(bestA, bestB)) {
        links.push({ a: bestA, b: bestB, bow: -0.62, base: 0.26, color: 0x7fd0ff });
      }
    }

    linkCount = Math.min(links.length, CFG.maxLinks);
  }

  function hasLink(a, b) {
    for (var i = 0; i < links.length; i++) {
      if ((links[i].a === a && links[i].b === b) || (links[i].a === b && links[i].b === a)) return true;
    }
    return false;
  }

  function bezierPoint(out, ax, ay, az, bx, by, bz, bow, t) {
    var mx = (ax + bx) * 0.5 * (1 + bow);
    var my = (ay + by) * 0.5 * (1 + bow);
    var mz = (az + bz) * 0.5 * (1 + bow);
    var it = 1 - t;
    out.x = it * it * ax + 2 * it * t * mx + t * t * bx;
    out.y = it * it * ay + 2 * it * t * my + t * t * by;
    out.z = it * it * az + 2 * it * t * mz + t * t * bz;
    return out;
  }

  var bezTmp = { x: 0, y: 0, z: 0 };

  function buildAdjacency() {
    linksByNode.length = COUNT;
    for (var i = 0; i < COUNT; i++) linksByNode[i] = [];
    for (var k = 0; k < linkCount; k++) {
      var L = links[k];
      linksByNode[L.a].push(L);
      linksByNode[L.b].push(L);
    }
  }

  /* ------------------------------------------------------------------
   * 14. 放电：沿纤维跑动的光点（这一版的灵魂）
   * ------------------------------------------------------------------ */
  var MAXP = 260;
  var pulsePos = new Float32Array(MAXP * 3);
  var pulseCol = new Float32Array(MAXP * 3);
  var pulseSiz = new Float32Array(MAXP);
  var pulsePha = new Float32Array(MAXP);
  var pulseGlo = new Float32Array(MAXP);

  var pulseGeo = new THREE.BufferGeometry();
  var pulsePosAttr = new THREE.BufferAttribute(pulsePos, 3);
  pulsePosAttr.setUsage(THREE.DynamicDrawUsage);
  var pulseColAttr = new THREE.BufferAttribute(pulseCol, 3);
  pulseColAttr.setUsage(THREE.DynamicDrawUsage);
  var pulseSizAttr = new THREE.BufferAttribute(pulseSiz, 1);
  pulseSizAttr.setUsage(THREE.DynamicDrawUsage);
  var pulseGloAttr = new THREE.BufferAttribute(pulseGlo, 1);
  pulseGloAttr.setUsage(THREE.DynamicDrawUsage);
  pulseGeo.setAttribute('position', pulsePosAttr);
  pulseGeo.setAttribute('aColor', pulseColAttr);
  pulseGeo.setAttribute('aSize', pulseSizAttr);
  pulseGeo.setAttribute('aPhase', new THREE.BufferAttribute(pulsePha, 1));
  pulseGeo.setAttribute('aGlow', pulseGloAttr);
  pulseGeo.setDrawRange(0, 0);
  pulseGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), CFG.R * 2);

  var pulseMat = trackMaterial(makeGlowMaterial(1.0, 1.0, false, FOG));
  var pulsePoints = new THREE.Points(pulseGeo, pulseMat);
  pulsePoints.frustumCulled = false;
  pulsePoints.renderOrder = 5;
  field.add(pulsePoints);

  var pulses = [];        // { a, b, bow, t, life, color, gain, hop }
  var pulseTotal = 0;
  var pulseTimer = 0.6;

  function spawnPulse(a, b, bow, color, life, gain, delay, hop) {
    if (pulses.length >= MAXP) return;
    pulses.push({
      a: a, b: b, bow: bow, color: color,
      t: -(delay || 0), life: life || 1.1,
      gain: gain || 1, hop: hop || 0
    });
    pulseTotal++;
  }

  /** 一颗神经元放电：沿它所有的纤维同时往外传 */
  function fire(node, gain) {
    var ls = linksByNode[node] || [];
    for (var i = 0; i < ls.length; i++) {
      var L = ls[i];
      var other = L.a === node ? L.b : L.a;
      spawnPulse(node, other, L.bow, L.color, 0.85 + Math.random() * 0.45,
        gain || 1, i * 0.07, 0);
    }
    flashArr[node] = Math.max(flashArr[node], 0.9);
  }

  function updatePulses(dt) {
    var n = 0;

    // 自发的小放电：让球一直是"活"的
    pulseTimer -= dt;
    if (pulseTimer <= 0 && linkCount > 0) {
      pulseTimer = 0.35 + Math.random() * 0.7;
      var L = links[Math.floor(Math.random() * linkCount)];
      if (L) {
        if (Math.random() < 0.5) spawnPulse(L.a, L.b, L.bow, L.color, 1.2 + Math.random() * 0.8, 0.55, 0, 0);
        else spawnPulse(L.b, L.a, L.bow, L.color, 1.2 + Math.random() * 0.8, 0.55, 0, 0);
      }
    }

    // 选中的那颗会持续放电
    if (selected >= 0 && Math.random() < dt * 1.6) fire(selected, 0.9);

    for (var k = pulses.length - 1; k >= 0; k--) {
      var p = pulses[k];
      p.t += dt / p.life;

      if (p.t < 0) continue;

      if (p.t >= 1) {
        // 抵达：目标神经元亮一下，并有一定概率继续往下传
        flashArr[p.b] = Math.max(flashArr[p.b], 0.75 * p.gain);
        if (p.hop < 2 && Math.random() < 0.55) {
          var nb = linksByNode[p.b] || [];
          for (var j = 0; j < nb.length; j++) {
            var L2 = nb[j];
            var nxt = L2.a === p.b ? L2.b : L2.a;
            if (nxt === p.a) continue;
            spawnPulse(p.b, nxt, L2.bow, L2.color, 1.0 + Math.random() * 0.4,
              p.gain * 0.7, 0, p.hop + 1);
          }
        }
        pulses.splice(k, 1);
        continue;
      }

      var ao = p.a * 3, bo = p.b * 3;
      bezierPoint(bezTmp, posArr[ao], posArr[ao + 1], posArr[ao + 2],
        posArr[bo], posArr[bo + 1], posArr[bo + 2], p.bow, p.t);

      var o = n * 3;
      pulsePos[o] = bezTmp.x; pulsePos[o + 1] = bezTmp.y; pulsePos[o + 2] = bezTmp.z;

      tmpColor.setHex(p.color);
      var fade = Math.sin(clamp(p.t, 0, 1) * Math.PI) * 0.6 + 0.4;
      var gg = p.gain * fade * 2.2;
      pulseCol[o] = tmpColor.r * gg + 0.25 * fade;
      pulseCol[o + 1] = tmpColor.g * gg + 0.25 * fade;
      pulseCol[o + 2] = tmpColor.b * gg + 0.3 * fade;

      pulseSiz[n] = 0.95 * (0.6 + p.gain * 0.5);
      pulseGlo[n] = 1.6 * fade;
      n++;
      if (n >= MAXP) break;
    }

    pulseGeo.setDrawRange(0, n);
    pulsePosAttr.needsUpdate = true;
    pulseColAttr.needsUpdate = true;
    pulseSizAttr.needsUpdate = true;
    pulseGloAttr.needsUpdate = true;
  }

  /* ------------------------------------------------------------------
   * 15. 事件：电位波 / 共鸣 / 低语
   * ------------------------------------------------------------------ */
  var RMAX = CFG.resonanceMax;
  var resPos = new Float32Array(RMAX * 2 * 3);
  var resCol = new Float32Array(RMAX * 2 * 3);
  var resGeo = new THREE.BufferGeometry();
  var resPosAttr = new THREE.BufferAttribute(resPos, 3);
  resPosAttr.setUsage(THREE.DynamicDrawUsage);
  var resColAttr = new THREE.BufferAttribute(resCol, 3);
  resColAttr.setUsage(THREE.DynamicDrawUsage);
  resGeo.setAttribute('position', resPosAttr);
  resGeo.setAttribute('color', resColAttr);
  resGeo.setDrawRange(0, 0);
  var resMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false
  });
  var resLines = new THREE.LineSegments(resGeo, resMat);
  resLines.frustumCulled = false;
  resLines.renderOrder = 5;
  field.add(resLines);

  var resPairs = [];
  var resTotal = 0;

  var tideCount = 0;
  var whisperCount = 0;
  var tide = {
    phase: -1,
    dur: 4.6,
    dir: new THREE.Vector3(1, 0, 0),
    next: 7.0,
    strength: 0,
    band: 0
  };

  function launchTide() {
    var th = Math.random() * TAU;
    var ph = Math.acos(2 * Math.random() - 1);
    tide.dir.set(Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)).normalize();
    tide.phase = 0;
    tide.strength = CFG.tideStrength * (0.7 + Math.random() * 0.6);
    tideCount++;
    if (AUDIO && AUDIO.isReady()) AUDIO.swell(0.4 + Math.random() * 0.35);
  }

  function updateTide(dt) {
    if (tide.phase < 0) {
      tide.next -= dt;
      if (tide.next <= 0) {
        launchTide();
        tide.next = lerp(CFG.tidePeriod[0], CFG.tidePeriod[1], Math.random());
      }
    } else {
      tide.phase += dt / tide.dur;
      if (tide.phase >= 1) tide.phase = -1;
    }
  }

  /** 波前扫过时，球面上的粒子会被"点亮"一下，也能被推动一点 */
  function tideAt(x, y, z) {
    if (tide.phase < 0) return 0;
    var front = lerp(-CFG.R * 1.3, CFG.R * 1.3, tide.phase);
    var proj = x * tide.dir.x + y * tide.dir.y + z * tide.dir.z;
    var rel = (proj - front) / CFG.tideWidth;
    return Math.exp(-rel * rel) * Math.sin(tide.phase * Math.PI);
  }

  var whisper = { next: 5.0, cur: -1, t: 0 };

  function launchWhisper() {
    if (COUNT === 1) return;
    var total = 0;
    var i;
    for (i = 0; i < COUNT; i++) {
      if (i === selected) continue;
      total += 1 + Math.max(0, nowSeconds - spotArr[i]) * 0.06;
    }
    var pick = Math.random() * total;
    var chosen = -1;
    for (i = 0; i < COUNT; i++) {
      if (i === selected) continue;
      pick -= 1 + Math.max(0, nowSeconds - spotArr[i]) * 0.06;
      if (pick <= 0) { chosen = i; break; }
    }
    if (chosen < 0) chosen = Math.floor(Math.random() * COUNT);

    whisper.cur = chosen;
    whisper.t = CFG.whisperLife;
    whisperCount++;
    if (AUDIO && AUDIO.isReady()) AUDIO.chime(chosen + 1, { gain: 0.035, dur: 3.6, octave: 2 });
    showWhisperLabel(chosen);
  }

  function updateWhisper(dt) {
    if (whisper.cur >= 0) {
      whisper.t -= dt;
      var k = whisper.t > 0 ? Math.sin(clamp(whisper.t / CFG.whisperLife, 0, 1) * Math.PI) : 0;
      whisperArr[whisper.cur] = k * k;
      if (whisper.t <= 0) { whisperArr[whisper.cur] = 0; whisper.cur = -1; }
    }
    whisper.next -= dt;
    if (whisper.next <= 0 && whisper.cur < 0) {
      launchWhisper();
      whisper.next = lerp(CFG.whisperPeriod[0], CFG.whisperPeriod[1], Math.random());
    }
  }

  var resScanAcc = 0;
  var resScanStep = 0.22;

  function scanResonance(dt) {
    for (var c = 0; c < COUNT; c++) if (coolArr[c] > 0) coolArr[c] -= dt;
    if (resPairs.length >= RMAX) return;

    resScanAcc += dt;
    if (resScanAcc < resScanStep) return;
    resScanAcc = 0;

    var lim = CFG.resonanceDist * CFG.resonanceDist;
    for (var t = 0; t < TAG_MEMBERS.length; t++) {
      var mem = TAG_MEMBERS[t];
      if (mem.length < 2) continue;
      for (var a = 0; a < mem.length; a++) {
        var ia = mem[a];
        if (coolArr[ia] > 0) continue;
        var ao = ia * 3;
        for (var b = a + 1; b < mem.length; b++) {
          var ib = mem[b];
          if (coolArr[ib] > 0) continue;
          var bo = ib * 3;
          var dx = posArr[ao] - posArr[bo];
          var dy = posArr[ao + 1] - posArr[bo + 1];
          var dz = posArr[ao + 2] - posArr[bo + 2];
          var d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > lim) continue;

          resPairs.push({ a: ia, b: ib, t: 0, life: 1.5, color: TAG_COLOR[t] });
          resTotal++;
          flashArr[ia] = 1;
          flashArr[ib] = 1;
          coolArr[ia] = CFG.resonanceCool;
          coolArr[ib] = CFG.resonanceCool;
          if (AUDIO && AUDIO.isReady()) {
            AUDIO.chime(ia + 3, { gain: 0.05, dur: 2.2, octave: 2 });
          }
          if (resPairs.length >= RMAX) return;
        }
      }
    }
  }

  function updateResonance(dt) {
    var n = 0;
    for (var k = resPairs.length - 1; k >= 0; k--) {
      var p = resPairs[k];
      p.t += dt;
      if (p.t > p.life) { resPairs.splice(k, 1); }
    }

    for (var j = 0; j < resPairs.length; j++) {
      var q = resPairs[j];
      var pr = clamp(q.t / q.life, 0, 1);
      var fade = Math.sin((1 - pr) * Math.PI * 0.5);
      var ao = q.a * 3, bo = q.b * 3;
      var o = n * 6;
      resPos[o] = posArr[ao]; resPos[o + 1] = posArr[ao + 1]; resPos[o + 2] = posArr[ao + 2];
      resPos[o + 3] = posArr[bo]; resPos[o + 4] = posArr[bo + 1]; resPos[o + 5] = posArr[bo + 2];

      tmpColor.setHex(q.color);
      var g = fade * 1.35;
      resCol[o] = tmpColor.r * g + 0.32 * fade;
      resCol[o + 1] = tmpColor.g * g + 0.28 * fade;
      resCol[o + 2] = tmpColor.b * g + 0.36 * fade;
      resCol[o + 3] = resCol[o]; resCol[o + 4] = resCol[o + 1]; resCol[o + 5] = resCol[o + 2];
      n++;
    }

    resGeo.setDrawRange(0, n * 2);
    resPosAttr.needsUpdate = true;
    resColAttr.needsUpdate = true;
  }

  /* ------------------------------------------------------------------
   * 16. 选中涟漪
   * ------------------------------------------------------------------ */
  var ripples = [];
  (function buildRipples() {
    for (var k = 0; k < 2; k++) {
      var mat = new THREE.SpriteMaterial({
        map: ringTexture,
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false
      });
      var sp = new THREE.Sprite(mat);
      sp.scale.set(1, 1, 1);
      sp.renderOrder = 6;
      sp.visible = false;
      field.add(sp);
      ripples.push({ sprite: sp, t: 1, delay: k * 0.22, active: false });
    }
  })();

  function emitRipple(index) {
    var color = new THREE.Color(MEMORIES[index].color || TAG_COLOR[TAG_OF[index]]);
    for (var k = 0; k < ripples.length; k++) {
      var r = ripples[k];
      r.sprite.position.set(posArr[index * 3], posArr[index * 3 + 1], posArr[index * 3 + 2]);
      r.sprite.material.color.copy(color);
      r.t = -(r.delay);
      r.active = true;
      r.sprite.visible = true;
    }
  }

  function updateRipples(dt) {
    for (var k = 0; k < ripples.length; k++) {
      var r = ripples[k];
      if (!r.active) continue;
      r.t += dt;
      if (r.t < 0) { r.sprite.material.opacity = 0; continue; }
      var p = clamp(r.t / 1.4, 0, 1);
      var scale = lerp(1.2, 7.6, 1 - Math.pow(1 - p, 2.2));
      r.sprite.scale.set(scale, scale, 1);
      r.sprite.material.opacity = 0.55 * Math.pow(1 - p, 1.7);
      if (p >= 1) {
        r.active = false;
        r.sprite.visible = false;
        r.sprite.material.opacity = 0;
      }
    }
  }

  /* ------------------------------------------------------------------
   * 17. 物理：球壳约束 + 切向游动 + 互相避让
   * ------------------------------------------------------------------ */
  var pointerWorld = new THREE.Vector3();
  var pointerActive = false;
  var highlightTag = -1;
  var nowSeconds = 0;

  function simulate(dt, time) {
    var damping = Math.exp(-CFG.damping * dt);
    var mx = pointerWorld.x, my = pointerWorld.y, mz = pointerWorld.z;
    var mr2 = CFG.mouseRadius * CFG.mouseRadius;
    var force = CFG.mouseForce * (down ? 1 : (pointerActive ? 0.4 : 0));

    // 心跳：整颗球在涨缩
    var beatPh = (time % CFG.beatPeriod) / CFG.beatPeriod;
    var beat = Math.exp(-beatPh * 7.5);
    var breathe = 1 + Math.sin(time * 0.62) * 0.013 + beat * 0.022;

    for (var i = 0; i < COUNT; i++) {
      i3 = i * 3;
      var x = posArr[i3], y = posArr[i3 + 1], z = posArr[i3 + 2];
      var ph = phaseArr[i] * TAU;
      var spd = speedArr[i];

      var r = Math.sqrt(x * x + y * y + z * z) || 1e-4;
      var ux = x / r, uy = y / r, uz = z / r;

      var ax = 0, ay = 0, az = 0;

      // 切向游动：贴着球面滑，而不是飞出去
      var wx = (Math.sin(y * 0.42 + time * 0.50 * spd + ph) + Math.cos(z * 0.37 - time * 0.38 * spd)) * CFG.wanderStrength * spd;
      var wy = (Math.sin(z * 0.45 - time * 0.44 * spd + ph) + Math.cos(x * 0.39 + time * 0.52 * spd)) * CFG.wanderStrength * spd;
      var wz = (Math.sin(x * 0.43 + time * 0.47 * spd - ph) + Math.cos(y * 0.40 - time * 0.42 * spd)) * CFG.wanderStrength * spd;
      var dot = wx * ux + wy * uy + wz * uz;
      ax += wx - ux * dot; ay += wy - uy * dot; az += wz - uz * dot;

      // 归位：拉回自己那块脑区
      ax += (homeArr[i3] - x) * CFG.homePull;
      ay += (homeArr[i3 + 1] - y) * CFG.homePull;
      az += (homeArr[i3 + 2] - z) * CFG.homePull;

      // 径向：钉在球壳上
      var targetR = homeR[i] * breathe;
      var dr = (targetR - r) * CFG.radialPull;
      ax += ux * dr; ay += uy * dr; az += uz * dr;

      // 被电位波推一下
      var tw = tideAt(x, y, z);
      if (tw > 0.01) {
        ax += tide.dir.x * tw * 0.55;
        ay += tide.dir.y * tw * 0.55;
        az += tide.dir.z * tw * 0.55;
      }

      // 指针把神经元拨开
      if (pointerActive && force > 0.01) {
        var dx = x - mx, dy = y - my, dz = z - mz;
        var d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < mr2 && d2 > 1e-5) {
          var d = Math.sqrt(d2);
          var f = 1 - d / CFG.mouseRadius;
          f = f * f * force / d;
          ax += dx * f; ay += dy * f; az += dz * f;
        }
      }

      // 积分
      var vx = (velArr[i3] + ax * dt) * damping;
      var vy = (velArr[i3 + 1] + ay * dt) * damping;
      var vz = (velArr[i3 + 2] + az * dt) * damping;
      var sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (sp > CFG.maxSpeed) {
        var kk = CFG.maxSpeed / sp;
        vx *= kk; vy *= kk; vz *= kk;
      }
      velArr[i3] = vx; velArr[i3 + 1] = vy; velArr[i3 + 2] = vz;
      posArr[i3] = x + vx * dt;
      posArr[i3 + 1] = y + vy * dt;
      posArr[i3 + 2] = z + vz * dt;

      // 亮度
      var mul = 1;
      if (highlightTag >= 0) mul = (TAG_OF[i] === highlightTag) ? 1.5 : 0.2;
      glowMul[i] = damp(glowMul[i], mul, 5, dt);

      var w = whisperArr[i];
      var fl = flashArr[i];
      if (fl > 0) { flashArr[i] = Math.max(0, fl - dt * 1.7); fl = flashArr[i]; }

      var boost = 1 + w * 0.7 + fl * 0.5;
      var target = baseSiz[i] * boost;
      if (i === selected) target = baseSiz[i] * 2.1 * boost;
      else if (i === hovered) target = baseSiz[i] * 1.55 * boost;
      sizArr[i] = damp(sizArr[i], target, 9, dt);

      // 使用痕迹：被反复打开的记忆，光会自己稳下来、亮起来
      usageMul[i] = damp(usageMul[i], usageStrength(i), 1.6, dt);

      var gv = baseGlow[i] * usageMul[i] * glowMul[i] * (1 + w * 0.9 + fl * 0.8) * (1 + beat * 0.25);
      glowArr[i] = gv > 2.4 ? 2.4 : gv;
    }

    posAttr.needsUpdate = true;
    geo.attributes.aSize.needsUpdate = true;
    geo.attributes.aGlow.needsUpdate = true;
  }

  /* ------------------------------------------------------------------
   * 18. 相机 / 自转 / 指针
   * ------------------------------------------------------------------ */
  var ndc = { x: 0, y: 0 };
  var camDist = CFG.cameraDistance;
  var camDistTarget = CFG.cameraDistance;
  var camTilt = { x: 0, y: 0 };
  var camTiltTarget = { x: 0, y: 0 };
  var spinX = 0, spinY = 0;
  var velSpinX = 0, velSpinY = 0.052;

  var raycaster = new THREE.Raycaster();
  var plane = new THREE.Plane();
  var camDir = new THREE.Vector3();
  var ORIGIN = new THREE.Vector3(0, 0, 0);
  var tmpV = new THREE.Vector3();
  var tmpV2 = new THREE.Vector3();

  var focusPoint = new THREE.Vector3();     // 相机注视点（世界坐标）
  var focusTarget = new THREE.Vector3();
  var lookPoint = new THREE.Vector3();
  var panelShift = 0;                       // 0 → 1，面板打开时把球推到左边
  var panelShiftTarget = 0;
  var panelLift = 0;                        // 手机抽屉：把球抬到上面去
  var panelLiftTarget = 0;
  var panelLiftDist = 0;                    // 抬起的世界距离
  var insideK = 1;                          // 0 = 在球内，1 = 在球外

  function updateCamera(dt) {
    camDist = damp(camDist, camDistTarget, 3.2, dt);
    camTilt.x = damp(camTilt.x, camTiltTarget.x, 2.6, dt);
    camTilt.y = damp(camTilt.y, camTiltTarget.y, 2.6, dt);
    panelShift = damp(panelShift, panelShiftTarget, 3.4, dt);
    panelLift = damp(panelLift, panelLiftTarget, 3.0, dt);

    // 选中一颗神经元时，镜头会跟过去 —— 于是"走进球体内部"
    if (selected >= 0) {
      var so = selected * 3;
      tmpV.set(posArr[so], posArr[so + 1], posArr[so + 2]).applyMatrix4(field.matrixWorld);
      focusTarget.copy(tmpV);
    } else {
      focusTarget.set(0, 0, 0);
    }
    focusPoint.lerp(focusTarget, 1 - Math.exp(-2.4 * dt));

    camera.position.set(
      focusPoint.x + camTilt.x * (camDist / CFG.cameraDistance),
      focusPoint.y + camTilt.y * (camDist / CFG.cameraDistance),
      focusPoint.z + camDist
    );
    // 面板占了右边：让注视点偏右一点，主体就自然落在左边
    lookPoint.copy(focusPoint);
    lookPoint.x += panelShift * camDist * 0.19;
    // 手机抽屉打开时，注视点往下挪一点，球就升到抽屉上面去了
    lookPoint.y -= panelLift * panelLiftDist;
    camera.lookAt(lookPoint);
    camera.updateMatrixWorld();

    // 进到球里之后，核光和薄壳要让位（否则整屏一团亮）
    var k = (camDist - CFG.R * 0.85) / (CFG.R * 0.55);
    insideK = clamp(k, 0, 1);

    // 雾随距离走：始终只压暗"远处那一半"
    var near = camDist + CFG.R * 0.35;
    var far = camDist + CFG.R * 2.7;
    for (var i = 0; i < glowMats.length; i++) {
      var u = glowMats[i].uniforms.uFogRange;
      if (u) { u.value.x = near; u.value.y = far; }
    }
  }

  function updateSpin(dt) {
    // 松手后回到缓慢自转；拖着时跟手。选中的时候停下，让那颗神经元待在原地
    var autoY = selected >= 0 ? 0 : 0.052;
    if (!down) {
      velSpinY = damp(velSpinY, autoY, selected >= 0 ? 2.4 : 1.1, dt);
      velSpinX = damp(velSpinX, 0, 1.6, dt);
    }
    spinY += velSpinY * dt;
    spinX += velSpinX * dt;
    spinX = clamp(spinX, -0.55, 0.55);
    spinX = damp(spinX, clamp(spinX, -0.55, 0.55), 6, dt);

    field.rotation.y = spinY;
    field.rotation.x = spinX;
    field.updateMatrixWorld();
  }

  function updatePointerWorld() {
    camera.getWorldDirection(camDir);
    plane.setFromNormalAndCoplanarPoint(camDir, ORIGIN);
    raycaster.setFromCamera(ndc, camera);
    var hit = raycaster.ray.intersectPlane(plane, pointerWorld);
    if (!hit) { pointerActive = false; return; }
    field.worldToLocal(pointerWorld);
  }

  /** 把本地坐标投到屏幕（会考虑球的自转） */
  function projectPoint(i, out) {
    var o = i * 3;
    out.set(posArr[o], posArr[o + 1], posArr[o + 2]).applyMatrix4(field.matrixWorld);
    out.project(camera);
    return out;
  }

  /* ------------------------------------------------------------------
   * 19. 拾取
   * ------------------------------------------------------------------ */
  var hovered = -1;
  var selected = -1;

  function pick(px, py) {
    var best = -1;
    var bestD2 = CFG.hoverPx * CFG.hoverPx;
    var halfW = viewW * 0.5, halfH = viewH * 0.5;

    for (var i = 0; i < COUNT; i++) {
      projectPoint(i, tmpV);
      if (tmpV.z > 1) continue;
      var sx = tmpV.x * halfW + halfW;
      var sy = -tmpV.y * halfH + halfH;
      var dx = sx - px, dy = sy - py;
      var d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    }
    return best;
  }

  /* ------------------------------------------------------------------
   * 20. 面板
   * ------------------------------------------------------------------ */
  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function replayAnimations() {
    for (var i = 0; i < animatedBits.length; i++) {
      var el = animatedBits[i];
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
    }
  }

  /* 一条记忆可能挂着好几张照片 */
  var gallery = [];
  var galleryAt = 0;

  function applyFigureRatio() {
    // 照片是自己的，别按 4:3 硬裁：竖着的给它竖着的框，但别长成一条
    var w = panelImage.naturalWidth || 4;
    var h = panelImage.naturalHeight || 3;
    var r = clamp(w / h, 0.74, 1.5);
    panelFigure.style.setProperty('--fig-ratio', r.toFixed(3));
  }

  function renderDots() {
    if (!figDots) return;
    if (gallery.length < 2) {
      figDots.hidden = true;
      figDots.innerHTML = '';
      return;
    }
    var html = '';
    for (var d = 0; d < gallery.length; d++) {
      html += '<i' + (d === galleryAt ? ' class="is-on"' : '') + '></i>';
    }
    figDots.innerHTML = html;
    figDots.hidden = false;
  }

  function showShot(at, keepRatio) {
    if (!gallery.length) return;
    galleryAt = ((at % gallery.length) + gallery.length) % gallery.length;
    panelFigure.classList.remove('is-missing');
    panelImage.classList.remove('is-loaded');
    if (!keepRatio) panelImage.style.opacity = '0';
    panelImage.src = gallery[galleryAt];
    renderDots();
  }

  function stepShot(dir) {
    if (gallery.length < 2) return;
    showShot(galleryAt + dir, false);
    if (AUDIO && selected >= 0) AUDIO.chime(audioStep[selected] + 1, { gain: 0.05, dur: 0.6 });
  }

  function openPanel(index) {
    var m = MEMORIES[index];
    if (!m) return;

    selected = index;
    spotArr[index] = nowSeconds;
    if (whisper.cur === index) whisper.cur = -1;

    panelIndex.textContent = pad2(index + 1) + ' / ' + pad2(COUNT);
    panelDate.textContent = m.date || '';
    if (panelTag) panelTag.textContent = m.tag;
    panelTitle.textContent = m.title;
    panelText.textContent = m.text;
    fallbackGlyph.textContent = m.title.slice(0, 1) || '记';

    gallery = (m.images && m.images.length) ? m.images.slice() : (m.image ? [m.image] : []);
    galleryAt = 0;
    panelFigure.classList.toggle('has-many', gallery.length > 1);
    panelFigure.classList.remove('is-missing');
    panelFigure.style.removeProperty('--fig-ratio');
    panelImage.classList.remove('is-loaded');
    panelImage.removeAttribute('src');

    panelImage.onload = function () {
      panelImage.classList.add('is-loaded');
      applyFigureRatio();
    };
    panelImage.onerror = function () {
      panelFigure.classList.add('is-missing');
      panelImage.classList.remove('is-loaded');
    };
    panelImage.alt = m.title;

    if (gallery.length) showShot(0, true);
    else { panelFigure.classList.add('is-missing'); renderDots(); }

    if (panelVisit) {
      markOpened(index);
      var line = usageLine(index);
      panelVisit.textContent = line;
      panelVisit.classList.toggle('is-on', !!line);
    }

    var sc = panelEl.querySelector('.panel-scroll');
    if (sc) sc.scrollTop = 0;

    panelEl.classList.add('is-open');
    panelEl.setAttribute('aria-hidden', 'false');
    document.body.classList.add('panel-open');
    replayAnimations();

    if (viewW <= 760) {
      // 手机上不钻进球里：球留在上面，抽屉从下面抽出来
      panelShiftTarget = 0;
      panelLiftTarget = 1;

      var rect = panelEl.getBoundingClientRect();
      var sheetH = rect.height || viewH * 0.66;
      var freeH = Math.max(140, viewH - sheetH);
      var tanHalf = Math.tan(CFG.cameraFov * Math.PI / 360);

      // 把球缩到上面那块空地里
      camDistTarget = clamp(CFG.R * viewH / (tanHalf * freeH * 0.92), CFG.cameraDistance, 56);

      // 球心抬到空地的正中
      panelLiftDist = (sheetH / viewH) * tanHalf * camDistTarget;
    } else {
      panelShiftTarget = 1;
      panelLiftTarget = 0;
      // 镜头推近这颗神经元 —— 它在球体内部，于是你会跟着钻进去
      camDistTarget = Math.min(camDistTarget, Math.max(4.2, CFG.R * 0.72));
    }

    emitRipple(index);
    fire(index, 1);                 // 放电：冲动沿纤维传出去
    if (MUSIC) MUSIC.duckTo(0.38);  // 读一条记忆时，音乐让位给铃声
    if (AUDIO) {
      AUDIO.init();
      AUDIO.chime(audioStep[index], { gain: 0.16 });
      AUDIO.chime(audioStep[index] + 2, { gain: 0.06, delay: 0.10, octave: 2, dur: 1.8 });
    }
  }

  function closePanel() {
    if (selected === -1 && !panelEl.classList.contains('is-open')) return;
    selected = -1;
    panelEl.classList.remove('is-open');
    panelEl.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('panel-open');
    panelShiftTarget = 0;
    panelLiftTarget = 0;
    camDistTarget = CFG.cameraDistance;   // 退出球体，回到外面看整颗球
    if (MUSIC) MUSIC.duckTo(1);
    if (AUDIO) AUDIO.close();
  }

  panelClose.addEventListener('click', function (e) {
    e.stopPropagation();
    closePanel();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closePanel();
    if (selected < 0) return;
    if (e.key === 'ArrowLeft') { stepShot(-1); e.preventDefault(); }
    if (e.key === 'ArrowRight') { stepShot(1); e.preventDefault(); }
  });

  if (figPrev) figPrev.addEventListener('click', function (e) { e.stopPropagation(); stepShot(-1); });
  if (figNext) figNext.addEventListener('click', function (e) { e.stopPropagation(); stepShot(1); });

  // 手机上左右滑也能翻照片
  (function swipeShots() {
    var sx = 0, sy = 0, live = false;
    panelFigure.addEventListener('pointerdown', function (e) {
      if (gallery.length < 2) return;
      sx = e.clientX; sy = e.clientY; live = true;
    });
    panelFigure.addEventListener('pointerup', function (e) {
      if (!live) return;
      live = false;
      var dx = e.clientX - sx;
      var dy = e.clientY - sy;
      if (Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy) * 1.4) stepShot(dx < 0 ? 1 : -1);
    });
    panelFigure.addEventListener('pointercancel', function () { live = false; });
  })();

  /* ------------------------------------------------------------------
   * 21. 声音开关
   * ------------------------------------------------------------------ */
  if (soundBtn) {
    soundBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      // 以音乐为准（音景默认关着，只当它真的在响时才跟着走）
      var on;
      if (MUSIC && MUSIC.count() > 0) {
        on = !MUSIC.isEnabled();
        MUSIC.setEnabled(on);
        if (AUDIO && AUDIO.isReady()) AUDIO.setEnabled(on);
      } else if (AUDIO && AUDIO.isReady()) {
        on = AUDIO.toggle();
      } else {
        return;
      }
      soundBtn.classList.toggle('is-muted', !on);
      soundBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on && AUDIO && AUDIO.isReady()) AUDIO.chime(0, { gain: 0.08, dur: 1.6 });
    });
  }

  function wakeAudio() {
    if (AUDIO) {
      AUDIO.init();
      AUDIO.unmuteIfNeeded();
    }
    // 音乐跟着同一次手势起来（浏览器只认手势，不认定时器）
    if (MUSIC) MUSIC.start();
  }

  /* ------------------------------------------------------------------
   * 22. HUD：脑区索引 / 低语标题 / 悬停提示
   * ------------------------------------------------------------------ */
  var lastHighlight = -2;

  function applyHighlight() {
    if (lastHighlight === highlightTag) return;
    lastHighlight = highlightTag;
    var n = scRegion.length;
    for (var i = 0; i < n; i++) {
      var r = scRegion[i];
      scGlow[i] = (highlightTag < 0)
        ? scBaseGlow[i]
        : (r === highlightTag ? scBaseGlow[i] * 2.1 : scBaseGlow[i] * 0.32);
    }
    scGeo.attributes.aGlow.needsUpdate = true;
  }

  (function buildClusterNav() {
    if (!clusterNavEl) return;
    for (var t = 0; t < TAG_NAMES.length; t++) {
      var item = document.createElement('div');
      item.className = 'cluster-item';
      item.style.setProperty('--c', '#' + ('000000' + TAG_COLOR[t].toString(16)).slice(-6));

      var dot = document.createElement('span');
      dot.className = 'c-dot';
      var name = document.createElement('span');
      name.className = 'c-name';
      name.textContent = TAG_NAMES[t];
      var num = document.createElement('span');
      num.className = 'c-num';
      num.textContent = String(TAG_MEMBERS[t].length);

      item.appendChild(dot);
      item.appendChild(name);
      item.appendChild(num);

      (function (idx, el) {
        el.addEventListener('pointerenter', function () {
          highlightTag = idx;
          applyHighlight();
          el.classList.add('is-hot');
        });
        el.addEventListener('pointerleave', function () {
          if (highlightTag === idx) highlightTag = -1;
          applyHighlight();
          el.classList.remove('is-hot');
        });
      })(t, item);

      clusterNavEl.appendChild(item);
    }
  })();

  var whisperLabelIdx = -1;
  var whisperLabelUntil = 0;

  function showWhisperLabel(index) {
    if (!whisperEl || !whisperTitleEl) return;
    if (VIEW_NARROW()) return;
    whisperLabelIdx = index;
    whisperLabelUntil = nowSeconds + 3.4;
    whisperTitleEl.textContent = MEMORIES[index].title;
    whisperEl.classList.add('is-on');
  }

  var VIEW_NARROW = function () { return viewW < 900; };

  function updateWhisperLabel() {
    if (!whisperEl || whisperLabelIdx < 0) return;
    if (nowSeconds > whisperLabelUntil) {
      whisperEl.classList.remove('is-on');
      whisperLabelIdx = -1;
      return;
    }
    projectPoint(whisperLabelIdx, tmpV);
    whisperEl.style.left = ((tmpV.x * 0.5 + 0.5) * viewW).toFixed(1) + 'px';
    whisperEl.style.top = ((-tmpV.y * 0.5 + 0.5) * viewH - 30).toFixed(1) + 'px';
  }

  var lastInBall = false;

  function updateInsideHint() {
    if (!hintEl) return;
    var inBall = camDist < CFG.R * 0.92;
    if (inBall === lastInBall) return;
    lastInBall = inBall;
    hintEl.textContent = inBall
      ? '已在球体内部　·　滚轮向外退出　·　点击附近的神经细胞'
      : '拖动转动这颗球　·　滚轮推拉视角　·　点击神经元读取记忆';
  }

  function updateTip() {
    if (!tipEl) return;
    if (hovered >= 0 && !down && !VIEW_NARROW()) {
      var title = MEMORIES[hovered].title;
      if (tipEl.textContent !== title) tipEl.textContent = title;
      tipEl.style.left = cursorX.toFixed(1) + 'px';
      tipEl.style.top = cursorY.toFixed(1) + 'px';
      tipEl.classList.add('is-on');
    } else {
      tipEl.classList.remove('is-on');
    }
  }

  /* ------------------------------------------------------------------
   * 23. 交互：拖动 = 转动这颗球
   * ------------------------------------------------------------------ */
  var down = false;
  var downX = 0, downY = 0;
  var dragged = false;
  var cursorX = -9999, cursorY = -9999;
  var dragAccum = 0;
  var lastMoveX = 0, lastMoveY = 0;

  function setNdc(clientX, clientY) {
    cursorX = clientX;
    cursorY = clientY;
    ndc.x = (clientX / viewW) * 2 - 1;
    ndc.y = -(clientY / viewH) * 2 + 1;
  }

  canvas.addEventListener('pointerdown', function (e) {
    wakeAudio();
    down = true;
    dragged = false;
    downX = e.clientX; downY = e.clientY;
    lastMoveX = e.clientX; lastMoveY = e.clientY;
    dragAccum = 0;
    setNdc(e.clientX, e.clientY);
    pointerActive = true;
    canvas.classList.add('is-grabbing');
    if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
  });

  window.addEventListener('pointermove', function (e) {
    if (down) {
      var mx = e.movementX;
      var my = e.movementY;
      if (typeof mx !== 'number' || (mx === 0 && my === 0 && e.clientX !== lastMoveX)) {
        mx = e.clientX - lastMoveX;
        my = e.clientY - lastMoveY;
      }
      velSpinY += mx * 0.0016;
      velSpinX += my * 0.0012;
      velSpinY = clamp(velSpinY, -2.2, 2.2);
      velSpinX = clamp(velSpinX, -1.4, 1.4);

      var dx = e.clientX - downX, dy = e.clientY - downY;
      if (dx * dx + dy * dy > 36) dragged = true;
      dragAccum += Math.abs(mx) + Math.abs(my);
      lastMoveX = e.clientX; lastMoveY = e.clientY;
    }
    setNdc(e.clientX, e.clientY);
    pointerActive = true;
  }, { passive: true });

  window.addEventListener('pointerup', function (e) {
    if (!down) return;
    down = false;
    canvas.classList.remove('is-grabbing');
    setNdc(e.clientX, e.clientY);

    if (!dragged) {
      var hit = pick(e.clientX, e.clientY);
      if (hit >= 0) openPanel(hit);
      else closePanel();
    }
  });

  window.addEventListener('pointerleave', function () {
    pointerActive = false;
    hovered = -1;
    canvas.classList.remove('is-hover');
  });

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    camDistTarget = clamp(camDistTarget + e.deltaY * 0.02, CFG.cameraMin, CFG.cameraMax);
  }, { passive: false });

  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  /* ------------------------------------------------------------------
   * 24. 尺寸 / 自适应
   * ------------------------------------------------------------------ */
  function refreshPixelScale() {
    var ps = perspectiveScale();
    for (var i = 0; i < glowMats.length; i++) glowMats[i].uniforms.uPixelScale.value = ps;
  }

  function resize() {
    viewW = window.innerWidth;
    viewH = window.innerHeight;
    camera.aspect = viewW / viewH;
    camera.updateProjectionMatrix();
    renderer.setSize(viewW, viewH, false);
    refreshPixelScale();
    panelShiftTarget = (selected >= 0 && viewW > 760) ? 1 : 0;
    panelLiftTarget = (selected >= 0 && viewW <= 760) ? 1 : 0;
  }

  window.addEventListener('resize', resize);
  resize();

  var frameAcc = 0, frameCount = 0, qualityDrops = 0;
  var lastDtMs = 16;

  function adaptQuality(dt) {
    if (qualityDrops >= 2) return;
    frameAcc += dt;
    frameCount++;
    if (frameCount < 90) return;
    var avg = frameAcc / frameCount;
    frameAcc = 0; frameCount = 0;
    if (avg > 0.024 && pixelRatio > 1) {
      pixelRatio = Math.max(1, pixelRatio - 0.35);
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(viewW, viewH, false);
      refreshPixelScale();
      qualityDrops++;
    }
  }

  /* ------------------------------------------------------------------
   * 25. 主循环
   * ------------------------------------------------------------------ */
  var clock = new THREE.Clock();
  var elapsed = 0;
  var running = true;
  var firstFrame = true;

  // 门锁：锁定期间连渲染都不启动，别人看到的只是一块深色锁屏
  var lockedOverride = null;

  function isLocked() {
    if (lockedOverride === null) {
      lockedOverride = !!(window.SeaLock && window.SeaLock.isLocked());
    }
    return lockedOverride;
  }

  document.addEventListener('sea:lock', function () {
    lockedOverride = true;
    closePanel();
    hovered = -1;
    if (canvas) canvas.classList.remove('is-hover');
    if (AUDIO) AUDIO.close();
  });

  document.addEventListener('sea:unlock', function () {
    lockedOverride = false;
    clock.getDelta();
    camera.updateMatrixWorld();
  });

  document.addEventListener('visibilitychange', function () {
    running = !document.hidden;
    if (running) clock.getDelta();
  });

  function updateSky(time) {
    var tideK = tide.phase >= 0 ? Math.sin(tide.phase * Math.PI) : 0;
    for (var i = 0; i < nebulae.length; i++) {
      var n = nebulae[i];
      var b = n.base;
      n.sprite.position.x = b.x + Math.sin(time * b.sp + n.phase) * 2.8;
      n.sprite.position.y = b.y + Math.cos(time * b.sp * 0.8 + n.phase) * 2.2;
      var breathe = 1 + Math.sin(time * 0.22 + n.phase) * 0.06 + tideK * 0.05;
      n.sprite.scale.set(b.s * breathe, b.s * 0.86 * breathe, 1);
      n.sprite.material.opacity = b.opacity * (1 + tideK * 0.3);
    }

    // 核光随心跳一起亮一下
    var beatPh = (time % CFG.beatPeriod) / CFG.beatPeriod;
    var beat = Math.exp(-beatPh * 7.5);
    coreSpriteMat.opacity = (0.30 + beat * 0.14) * insideK;
    var cs = CFG.R * (2.5 + beat * 0.12);
    coreSprite.scale.set(cs, cs, 1);
    haloMatOuter.opacity = (0.09 + beat * 0.03) * insideK;

    shellMat.uniforms.uBeat.value = 1 + beat * 0.5;
    shellMat.uniforms.uIntensity.value = (0.20 + beat * 0.05) * insideK;

    // 凑近之后神经元的晕圈要收，不然几颗核叠在一起就是一屏白
    haloMat.uniforms.uAlpha.value = haloBaseAlpha * (0.42 + 0.58 * insideK);
  }

  function tick() {
    requestAnimationFrame(tick);
    if (!running) return;
    if (isLocked()) {
      if (firstFrame) { firstFrame = false; bootEl.classList.add('is-hidden'); }
      return;
    }

    var dt = clock.getDelta();
    if (dt > 0.05) dt = 0.05;
    lastDtMs = dt * 1000;
    elapsed += dt;
    var time = elapsed;

    if (pointerActive && !down && cursorX > -9000) {
      var h = pick(cursorX, cursorY);
      if (h !== hovered) {
        hovered = h;
        if (h >= 0) {
          canvas.classList.add('is-hover');
          if (AUDIO && AUDIO.isReady()) AUDIO.hover();
        } else {
          canvas.classList.remove('is-hover');
        }
      }
    }

    if (down && dragAccum > 30) {
      if (AUDIO) AUDIO.brush(clamp(dragAccum / 140, 0, 1));
      dragAccum = 0;
    }

    nowSeconds = time;

    updateCamera(dt);
    updateSpin(dt);
    updatePointerWorld();
    updateInsideHint();

    updateTide(dt);
    updateWhisper(dt);
    scanResonance(dt);

    simulate(dt, time);
    buildLinkList();
    buildAdjacency();
    updatePulses(dt);
    updateResonance(dt);
    updateRipples(dt);
    updateSky(time);
    updateWhisperLabel();
    updateTip();

    for (var i = 0; i < glowMats.length; i++) glowMats[i].uniforms.uTime.value = time;

    renderer.render(scene, camera);
    adaptQuality(dt);

    if (firstFrame) {
      firstFrame = false;
      bootEl.classList.add('is-hidden');
      writeDiag(diagnostics());
    }
  }

  /* ------------------------------------------------------------------
   * 26. 调试出口（?debug=1）
   * ------------------------------------------------------------------ */
  function diagnostics() {
    return {
      ok: true,
      particles: COUNT,
      regions: TAG_NAMES.length,
      scaffold: scRegion.length,
      links: linkCount,
      pulses: pulses.length,
      drawCalls: renderer.info.render.calls,
      pixelRatio: pixelRatio,
      frameMs: +lastDtMs.toFixed(1),
      view: [viewW, viewH],
      panelOpen: panelEl.classList.contains('is-open'),
      selected: selected,
      hovered: hovered,
      audioReady: !!(AUDIO && AUDIO.isReady()),
      elapsed: +elapsed.toFixed(1),
      camDist: +camDist.toFixed(2),
      inside: camDist < CFG.R * 0.92,
      spins: [+spinX.toFixed(2), +spinY.toFixed(2)],
      tidePhase: +tide.phase.toFixed(2),
      tides: tideCount,
      resonances: resTotal,
      whispers: whisperCount,
      pulseTotal: pulseTotal
    };
  }

  if (DEBUG) {
    window.__sea = {
      state: diagnostics,
      select: openPanel,
      close: closePanel,
      memories: MEMORIES,
      regions: TAG_NAMES,
      camera: camera,
      field: field,
      pos: posArr,
      fire: fire
    };
    if (params.has('settle')) {
      for (var si = 0; si < COUNT; si++) {
        posArr[si * 3] = homeArr[si * 3];
        posArr[si * 3 + 1] = homeArr[si * 3 + 1];
        posArr[si * 3 + 2] = homeArr[si * 3 + 2];
      }
      posAttr.needsUpdate = true;
    }
    if (params.has('sel')) {
      var idx = parseInt(params.get('sel'), 10);
      if (!isNaN(idx) && idx >= 0 && idx < COUNT) openPanel(idx);
    }
    var distParam = parseFloat(params.get('dist'));
    if (!isNaN(distParam)) {
      camDistTarget = clamp(distParam, CFG.cameraMin, CFG.cameraMax);
      if (params.has('instant')) camDist = camDistTarget;
    }
    var tideDelay = parseFloat(params.get('tide'));
    if (!isNaN(tideDelay)) setTimeout(function () {
      try { launchTide(); } catch (e) { fail('电位波出错: ' + (e && (e.stack || e.message) || e)); }
    }, tideDelay);
    var whisperDelay = parseFloat(params.get('whisper'));
    if (!isNaN(whisperDelay)) setTimeout(function () {
      try { launchWhisper(); } catch (e) { fail('低语出错: ' + (e && (e.stack || e.message) || e)); }
    }, whisperDelay);
    setTimeout(function () { writeDiag(diagnostics()); }, 1500);
    setTimeout(function () { writeDiag(diagnostics()); }, 8200);
  }

  window.addEventListener('error', function (e) {
    fail('脚本运行出错：' + (e.message || '未知错误'));
  });
  window.addEventListener('unhandledrejection', function (e) {
    fail('异步错误：' + ((e.reason && e.reason.message) || String(e.reason)));
  });

  tick();
})();
