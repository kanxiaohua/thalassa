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
  var TRUNCATED = 0;        // 数据条数超出上限时，被挡掉多少条

  /* 手指还是鼠标 —— 只用来换文案，不改交互。
   * 交互两条路都通（拖动/滚轮都绑着，触摸也有），
   * 但"滚轮推拉视角""按 L 打开索引"这种话，手机上的人做不到，
   * 说了等于没说。
   *
   * 必须放在最前面：读屏描述在下面初始化时就要用它。
   * 早先声明在渲染段落里，那里还没赋值，于是手机上念的仍是键盘版。 */
  var COARSE = (function () {
    try { return window.matchMedia('(pointer: coarse)').matches; }
    catch (e) { return false; }
  })();
  var CFG = {
    R: 7.6,                 // 光球半径
    maxParticles: 800,          // 单库上限。超出的不会画出来，但会明说，不静默吞掉

    // 神经云（不可点击，只负责"这是一团由粒子组成的实体"）
    shellCount: 9000,       // 球壳粒子
    innerCount: 7200,       // 球内粒子（实心）
    filamentCount: 44,      // 更密的"丝"，只由粒子串成，不画线
    filamentPoints: 44,

    // 脑区：张角不写在这里 —— 每个区按条目数分球冠面积，见 sizeRegionCaps()

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

  /* 纯逻辑都在 js/layout.js 里（球面布点、时间解析、访问痕迹）。
   * 那边零依赖，能用 node --test 直接跑；这边只负责画和交互。
   * 它是必需依赖，缺了就该当场报错，而不是悄悄降级成一张空球。
   * 报错也写成人话：纯静态项目没有构建步骤，用户只会看到一个转圈的启动页。 */
  var L = window.SeaLayout;
  if (!L) {
    var bootTip = document.getElementById('bootText');
    if (bootTip) bootTip.textContent = '缺少 js/layout.js —— 请确认它和 js/main.js 在同一个目录下。';
    throw new Error('[识海] 缺少 js/layout.js');
  }

  var clamp = L.clamp;
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

  // 包一层：把 NOW 固定住，页面开着跨天也不会让时间轴右端跟着漂
  function parseTime(str) { return L.parseTime(str, NOW); }

  function readMemories() {
    // 数据层优先：SeaRepo.boot() 会把 localStorage 里的记忆同步注入 window.MEMORIES
    var raw = null;
    if (window.SeaRepo && typeof window.SeaRepo.list === 'function') {
      try { raw = window.SeaRepo.list(); } catch (e) { raw = null; }
    }
    if (!Array.isArray(raw) || raw.length === 0) raw = window.MEMORIES;
    if (!Array.isArray(raw) || raw.length === 0) {
      raw = [{
        title: '空白的识海',
        text: '还没有任何记忆。\n\n打开 data/memories.js，照着示例写下第一条。',
        image: '',
        tag: '未名'
      }];
    }
    var usable = raw.filter(function (m) { return m && typeof m === 'object'; });
    if (usable.length > CFG.maxParticles) {
      TRUNCATED = usable.length - CFG.maxParticles;
    }
    return usable
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
          size: typeof m.size === 'number' ? clamp(m.size, 0.5, 2.6) : 1,
          // 手连的线：这里必须显式带上，否则刷新之后线就"忘了"
          links: Object.prototype.toString.call(m.links) === '[object Array]' ? m.links.slice() : []
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
   * 2.2 语义层：纯前端中文 TF-IDF，不联网、不加载模型
   *   两个用途：① 搜索框随便打几个字都能找到记忆
   *             ② 换一种排布方式——语义相近的记忆在空间里也挨着
   * ------------------------------------------------------------------ */
  var SEM = window.SeaSemantic || null;
  var semIndex = null;
  if (SEM && COUNT > 0) {
    try { semIndex = SEM.buildIndex(MEMORIES); }
    catch (e) { semIndex = null; }
  }

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

  // 访问记录按「标题 + 发生日期」索引 —— 实现在 layout.js
  function usageKey(m) { return L.usageKey(m); }

  function usageOf(i) {
    var m = MEMORIES[i];
    if (!m) return { n: 0, t: 0 };
    var u = usage[usageKey(m)];
    if (!u) {
      // 兼容老格式（纯标题做键）：迁移一次，之后按新键走
      var legacy = usage[m.title];
      if (legacy && typeof legacy.n === 'number') {
        usage[usageKey(m)] = legacy;
        delete usage[m.title];
        saveUsage();
        return legacy;
      }
    }
    return (u && typeof u.n === 'number') ? u : { n: 0, t: 0 };
  }

  function saveUsage() {
    try { window.localStorage.setItem(USAGE_KEY, JSON.stringify(usage)); } catch (e) { }
  }

  function markOpened(i) {
    var m = MEMORIES[i];
    if (!m) return null;
    var k = usageKey(m);
    var u = usage[k] || { n: 0, t: 0 };
    u.n = (u.n || 0) + 1;
    u.t = Date.now();
    usage[k] = u;
    saveUsage();
    return u;
  }

  // 0.72 ~ 1.34：没打开过的最暗，反复看过的接近上限 —— 算法在 layout.js
  function usageStrength(i) {
    return L.usageStrength(usageOf(i), Date.now(), DAY_MS);
  }

  // 这行说的是「你」和这条记忆的关系，不是记忆本身的日期。
  // 以前写成「第一次打开 · 今天」，紧挨着上面那行记忆日期（2025 · 夏），
  // 会让人以为这条记忆是今天才有的。把主语挑明，两个日期就不打架了。
  function usageLine(i) {
    return L.usageLine(usageOf(i), Date.now(), DAY_MS);
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
  var animatedBits = panelEl.querySelectorAll('.panel-meta, .panel-title, .panel-figure, .panel-text, .panel-links, .panel-linkbar, .panel-foot');

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

  if (TRUNCATED > 0) {
    // 超上限不能没声音 —— 否则用户会以为记忆丢了。
    console.warn('[识海] 共 ' + (COUNT + TRUNCATED) + ' 条记忆，超过单库上限 ' +
      CFG.maxParticles + '，有 ' + TRUNCATED + ' 条没有画出来。' +
      '要全画出来，把 js/main.js 里的 CFG.maxParticles 调大。');
    if (hintEl) {
      hintEl.title = '共 ' + (COUNT + TRUNCATED) + ' 条记忆，这里显示了 ' + COUNT + ' 条';
    }
  }

  // 读屏的场景描述里写着条数与脑区数，必须跟着数据走。
  // 写死在 HTML 里，换一份数据集就会念错（私人库 48 条时曾念「9 段」）。
  (function describeScene() {
    var el = document.getElementById('sceneDesc');
    if (!el) return;
    var how = COARSE
      ? '拖动可旋转、双指可缩放、轻点光点可阅读。连点两下空白处，视角回到正面。'
      : '鼠标拖动可旋转、滚动可推拉、点击光点可阅读，按 R 视角回到正面。键盘用户请按 L 打开记忆索引。';
    el.textContent = '一颗由记忆粒子构成的球体。共 ' + COUNT + ' 段记忆，按 ' +
      TAG_NAMES.length + ' 个脑区分组。' + how;
  })();

  var AUDIO = window.SeaAudio || null;
  var MUSIC = window.SeaMusic || null;   // 背景音乐（曲子在 assets/music/，缺席就静默）
  var PHOTOS = window.SeaPhotos || null; // 照片仓（IndexedDB）。缺席时 idb: 引用会退化成占位图

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
   *
   * 三件事（发轴、配轴、分球冠面积）的算法都在 js/layout.js，
   * 这里只负责把它们和当前这份数据接起来。那边能用 node --test 直接验，
   * 不用开浏览器点着看。为什么这么算、踩过哪些坑，注释都在 layout.js 里。
   * ------------------------------------------------------------------ */
  var TAG_COUNTS = TAG_MEMBERS.map(function (m) { return m.length; });

  var REGION_AXES = L.makeAxes(TAG_NAMES.length);

  // 哪个区用哪根轴 —— 按条目数从多到少发轴，每区挑"离已选轴最远"的那根。
  // 按 tag 出现顺序发轴的话，条目最多的两个区常常挨在一起：48 条记忆的时候
  // 「路上」18 条和「房间」11 条的球冠边缘相接，一半节点挤进同一个象限，
  // 球的一边糊成一片、另一边空着。最大的团先站到球的两极，看起来才像球。
  var REGION_AXIS_OF = L.assignAxes(REGION_AXES, TAG_COUNTS);

  /* 每个区的球冠多大 —— 按条目数分面积。
   *
   * 原来所有区一样大，于是 18 条的记忆塞进和 1 条一样小的冠里：这块密得发白，
   * 那块只有一个孤点。球冠面积正比于 2π(1-cosθ)，所以 cosθ 直接按比例给。
   *
   * 系数 1.10 是留缝：球冠是圆的，圆片在球面上铺不满（打包密度够不到 1），
   * 系数给大了相邻冠就会压在一起——实测 0.68 时 200 条有两组跨区节点撞到 0.39。 */
  var TAG_CAP_COS = L.capCoses(TAG_COUNTS, 1.10);
  var tangentBasis = L.tangentBasis;
  var capPoint = L.capPoint;

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
    return L.nearestRegion(REGION_AXES, x, y, z, 0.70);
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

  /* ------------------------------------------------------------------
   * 12.1 布点：两种"排布方式"
   *   tag      —— 按手写的 tag 聚成脑区锥体（原来的样子）
   *   semantic —— 按语义相似度重新落位：内容相近的记忆在空间里也挨着
   *  两种模式只改"家"的位置，位置由弹簧自己荡过去，所以切换是连续动画
   * ------------------------------------------------------------------ */
  var layoutMode = 'tag';

  /** 语义落点：把每条记忆投影进球内，语义越近挨得越紧 */
  function semanticHomes(outHomes, outRadii) {
    if (!SEM || !semIndex) return false;
    var pr;
    try { pr = SEM.project(semIndex); } catch (e) { return false; }
    if (!pr || pr.length < COUNT * 3) return false;

    for (var i = 0; i < COUNT; i++) {
      var i3 = i * 3;
      var px = pr[i3], py = pr[i3 + 1], pz = pr[i3 + 2];
      var len = Math.sqrt(px * px + py * py + pz * pz);
      var dx, dy, dz;

      if (len < 1e-4) {
        // 语义上最"哪类都不属于"的那条，给个随机方向，别卡死在球心
        var ang = Math.random() * TAU;
        var cv = Math.acos(2 * Math.random() - 1);
        dx = Math.sin(cv) * Math.cos(ang);
        dy = Math.cos(cv);
        dz = Math.sin(cv) * Math.sin(ang);
        len = 0;
      } else {
        dx = px / len; dy = py / len; dz = pz / len;
      }

      // 越靠近语义中心，埋得越深——钻进球里才看得见
      var r = CFG.R * (0.30 + clamp(len, 0, 1) * 0.62);

      // 一点点角度抖动：方向完全重合的两条不会叠成一颗
      dx += (Math.random() - 0.5) * 0.17;
      dy += (Math.random() - 0.5) * 0.17;
      dz += (Math.random() - 0.5) * 0.17;
      var l2 = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;

      outRadii[i] = r;
      outHomes[i3] = dx / l2 * r;
      outHomes[i3 + 1] = dy / l2 * r;
      outHomes[i3 + 2] = dz / l2 * r;
    }
    return true;
  }

  /** 按当前 layoutMode 重算所有粒子的目标位置（只改目标，不碰当前速度） */
  function computeHomes() {
    var sem = null;
    if (layoutMode === 'semantic') {
      var buf = new Float32Array(COUNT * 3);
      if (semanticHomes(buf, homeR)) sem = buf;
      else layoutMode = 'tag';     // 语义层不可用时静默退回
    }

    var nReg = TAG_NAMES.length;
    var seen = new Int32Array(nReg);   // 每个区已经放了几颗，用来算斐波那契序号

    var u = new THREE.Vector3();
    var v = new THREE.Vector3();
    var dir = new THREE.Vector3();

    for (var i = 0; i < COUNT; i++) {
      i3 = i * 3;

      if (sem) {
        homeArr[i3] = sem[i3];
        homeArr[i3 + 1] = sem[i3 + 1];
        homeArr[i3 + 2] = sem[i3 + 2];
        continue;
      }

      var t = TAG_OF[i];
      var k = seen[t]++;
      var nIn = TAG_MEMBERS[t].length;
      var axis = REGION_AXES[REGION_AXIS_OF[t]] || REGION_AXES[0];
      tangentBasis(axis, u, v);
      capPoint(axis, u, v, TAG_CAP_COS[t], k, nIn, dir);

      // 记忆散布在球体内部：从浅层一直到球心附近，钻进球里才能看见它们。
      // 半径用低差异序列错开，否则同区的点会齐刷刷贴在一层壳上。
      var r = CFG.R * L.radialOf(k);
      homeR[i] = r;
      homeArr[i3] = dir.x * r;
      homeArr[i3 + 1] = dir.y * r;
      homeArr[i3 + 2] = dir.z * r;
    }
  }

  computeHomes();

  /** 一次性初始化：初始位置、亮度、颜色、大小 */
  (function initNeuronAttrs() {
    for (var i = 0; i < COUNT; i++) {
      i3 = i * 3;
      var m = MEMORIES[i];
      var tagIdx = TAG_OF[i];

      // 从球心附近"长出来"，第一帧更有生长感
      var k0 = 0.5 + Math.random() * 0.25;
      posArr[i3] = homeArr[i3] * k0;
      posArr[i3 + 1] = homeArr[i3 + 1] * k0;
      posArr[i3 + 2] = homeArr[i3 + 2] * k0;

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

  /**
   * 切换排布方式。
   * 只改每颗粒子的"家"，位置由 simulate 里的弹簧自己荡过去——所以是一段连续动画，
   * 而不是瞬间跳变。纤维连接跟着重建，放电会走新的邻接关系。
   */
  function applyLayout(mode) {
    if (mode !== 'semantic' && mode !== 'tag') return;
    if (mode === layoutMode) return;
    layoutMode = mode;
    computeHomes();
    buildLinkList();
    buildAdjacency();
    lastHighlight = -2;         // 让高亮强制重算
    applyHighlight();
  }

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

  /** 二次贝塞尔取点；bow 把控制点往外推，线就弯成一张弓（实现在 layout.js） */
  var bezierPoint = L.bezierPoint;

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
   * 13.5 记忆互连：用户亲手连出来的线
   *   和上面那套 links 不是一回事 ——
   *     links 是"生成时算出来的结构"，看不见，只决定冲动往哪儿传；
   *     这里的 myLinks 是"用户说这两段是一件事"，看得见，且放电优先走它。
   *   刻意不复用同一套对象：一个是氛围，一个是意图，混在一起两边都说不清。
   * ------------------------------------------------------------------ */
  /* 渲染上限。数据层一侧最多 12 条，120 条已经能装下 10 颗都在满连的情况；
   * 内存代价 = 120 × 68 顶点 × 2 个属性 × 3 float × 4B ≈ 200KB，可以忽略。
   * 早先写的是 48，超过就静默不画——用户看不出是自己没连上还是程序没画。
   * 现在超了会记进 myLinksDropped，由面板如实报出来。 */
  var MLINK_MAX = 120;
  var MTUB_STEPS = 16;                      // 每条弧的采样段数
  var MTUB_RADIAL = 4;                      // 截面边数：4 边形就够，半径才 0.013
  var MTUB_VPL = (MTUB_STEPS + 1) * MTUB_RADIAL;

  var myLinks = [];                         // { a, b, cr, cg, cb }
  var myLinksByNode = [];                   // 放电优先用
  var myLinksDropped = 0;                   // 因为超上限没进渲染的条数
  var linkMode = -1;                        // ≥0 表示"正在从这颗开始连线"
  var tmpColor2 = new THREE.Color();

  var mlinkPos = new Float32Array(MLINK_MAX * MTUB_VPL * 3);
  var mlinkCol = new Float32Array(MLINK_MAX * MTUB_VPL * 3);

  var mlinkGeo = new THREE.BufferGeometry();
  var mlinkPosAttr = new THREE.BufferAttribute(mlinkPos, 3);
  mlinkPosAttr.setUsage(THREE.DynamicDrawUsage);
  var mlinkColAttr = new THREE.BufferAttribute(mlinkCol, 3);
  mlinkColAttr.setUsage(THREE.DynamicDrawUsage);
  mlinkGeo.setAttribute('position', mlinkPosAttr);
  mlinkGeo.setAttribute('color', mlinkColAttr);

  // 每条弧的拓扑完全一样，索引只建一次
  (function buildMLinkIndex() {
    var per = MTUB_STEPS * MTUB_RADIAL * 6;
    var idx = new Uint16Array(MLINK_MAX * per);
    var w = 0;
    for (var l = 0; l < MLINK_MAX; l++) {
      var base = l * MTUB_VPL;
      for (var s = 0; s < MTUB_STEPS; s++) {
        for (var k = 0; k < MTUB_RADIAL; k++) {
          var k2 = (k + 1) % MTUB_RADIAL;
          var a0 = base + s * MTUB_RADIAL + k;
          var a1 = base + s * MTUB_RADIAL + k2;
          var b0 = a0 + MTUB_RADIAL;
          var b1 = a1 + MTUB_RADIAL;
          idx[w++] = a0; idx[w++] = b0; idx[w++] = b1;
          idx[w++] = a0; idx[w++] = b1; idx[w++] = a1;
        }
      }
    }
    mlinkGeo.setIndex(new THREE.BufferAttribute(idx, 1));
  })();
  mlinkGeo.setDrawRange(0, 0);

  var mlinkMat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide
  });
  var mlinkMesh = new THREE.Mesh(mlinkGeo, mlinkMat);
  mlinkMesh.frustumCulled = false;
  mlinkMesh.renderOrder = 3;          // 在粒子晕圈之上、脉冲之下
  field.add(mlinkMesh);

  // 常态 / 相关 / 无关：三档亮度，加法混合下亮度就是"透明度"
  var MLINK_BASE = 0.22;
  var MLINK_HOT = 0.72;
  var MLINK_DIM = 0.055;
  var MLINK_PEND = 0.85;              // 拉线时那条橡皮筋

  /** 从 MEMORIES 读出手连的线，双向存储只收一次（a < b） */
  function syncMyLinks() {
    myLinks.length = 0;
    myLinksDropped = 0;
    myLinksByNode.length = COUNT;
    for (var i = 0; i < COUNT; i++) myLinksByNode[i] = [];

    for (var n = 0; n < COUNT; n++) {
      var ls = MEMORIES[n].links;
      if (!ls || !ls.length) continue;
      for (var j = 0; j < ls.length; j++) {
        var b = ls[j];
        if (b <= n || b >= COUNT) continue;
        if (myLinks.length >= MLINK_MAX) { myLinksDropped++; continue; }
        var ca = TAG_COLOR[TAG_OF[n]], cb = TAG_COLOR[TAG_OF[b]];
        tmpColor.setHex(ca).lerp(tmpColor2.setHex(cb), 0.5);
        myLinks.push({ a: n, b: b, cr: tmpColor.r, cg: tmpColor.g, cb: tmpColor.b });
        myLinksByNode[n].push(b);
        myLinksByNode[b].push(n);
      }
    }
  }

  var _tP = new THREE.Vector3(), _tD = new THREE.Vector3();
  var _tN = new THREE.Vector3(), _tBn = new THREE.Vector3(), _tUp = new THREE.Vector3();

  /** 把一条弧写进第 l 个槽位（位置 + 颜色一起写，省一遍遍历） */
  function writeTube(l, ax, ay, az, bx, by, bz, bow, radius, r, g, bl) {
    var mx = (ax + bx) * 0.5 * (1 + bow);
    var my = (ay + by) * 0.5 * (1 + bow);
    var mz = (az + bz) * 0.5 * (1 + bow);
    var po = l * MTUB_VPL * 3;

    for (var s = 0; s <= MTUB_STEPS; s++) {
      var t = s / MTUB_STEPS;
      var it = 1 - t;
      var px = it * it * ax + 2 * it * t * mx + t * t * bx;
      var py = it * it * ay + 2 * it * t * my + t * t * by;
      var pz = it * it * az + 2 * it * t * mz + t * t * bz;

      // 切线（贝塞尔导数），用来定截面朝向
      _tD.set(
        2 * it * (mx - ax) + 2 * t * (bx - mx),
        2 * it * (my - ay) + 2 * t * (by - my),
        2 * it * (mz - az) + 2 * t * (bz - mz)
      );
      if (_tD.lengthSq() < 1e-9) _tD.set(0, 1, 0);
      else _tD.normalize();

      // 随便挑一个不平行于切线的"上"，省掉平行传输那套
      if (Math.abs(_tD.y) < 0.9) _tUp.set(0, 1, 0); else _tUp.set(1, 0, 0);
      _tN.crossVectors(_tD, _tUp).normalize();
      _tBn.crossVectors(_tD, _tN);

      for (var k = 0; k < MTUB_RADIAL; k++) {
        var ang = k / MTUB_RADIAL * TAU;
        var cs = Math.cos(ang), sn = Math.sin(ang);
        mlinkPos[po] = px + (_tN.x * cs + _tBn.x * sn) * radius;
        mlinkPos[po + 1] = py + (_tN.y * cs + _tBn.y * sn) * radius;
        mlinkPos[po + 2] = pz + (_tN.z * cs + _tBn.z * sn) * radius;
        mlinkCol[po] = r;
        mlinkCol[po + 1] = g;
        mlinkCol[po + 2] = bl;
        po += 3;
      }
    }
  }

  /** 每帧重算：端点是会动的（弹簧 + 心跳 + 自转），几何必须跟着走 */
  function updateMyLinks() {
    var pend = null;
    if (linkMode >= 0 && linkMode < COUNT) pend = linkMode;

    if (!myLinks.length && pend === null) {
      if (mlinkGeo.drawRange.count !== 0) mlinkGeo.setDrawRange(0, 0);
      return;
    }

    // 谁被"聚焦"：连线态看起点，否则看选中，再看悬停
    var focusNode = pend !== null ? pend : (selected >= 0 ? selected : hovered);
    var n = 0;

    /* 管径随镜头距离走：世界坐标里固定半径的话，
     * 拉远看整颗球时线只有 1px、几乎看不见，拉近又会粗成一条带子。
     * 这里让屏幕宽度基本恒定（约 2px），两种视角都成立。 */
    var rr = clamp(camDist * 0.0011, 0.008, 0.045);
    var rrPend = rr * 0.82;

    for (var i = 0; i < myLinks.length && n < MLINK_MAX - 1; i++) {
      var L = myLinks[i];
      var k = MLINK_BASE;
      if (focusNode >= 0) k = (L.a === focusNode || L.b === focusNode) ? MLINK_HOT : MLINK_DIM;
      // 时间轴回放时，两端还没发生的线不该亮着——
      // 否则刚起步的年份会浮着几根没有端点的白管，像 bug。
      k *= tlDim(L.a, L.b);
      var ao = L.a * 3, bo = L.b * 3;
      writeTube(n, posArr[ao], posArr[ao + 1], posArr[ao + 2],
        posArr[bo], posArr[bo + 1], posArr[bo + 2],
        0.16, rr, L.cr * k, L.cg * k, L.cb * k);
      n++;
    }

    // 拉线中的橡皮筋：从起点跟到指针，青色，让人知道"现在在连"
    if (pend !== null && n < MLINK_MAX && pointerActive) {
      var so = pend * 3;
      writeTube(n, posArr[so], posArr[so + 1], posArr[so + 2],
        pointerWorld.x, pointerWorld.y, pointerWorld.z,
        0.10, rrPend, 0.42 * MLINK_PEND, 0.86 * MLINK_PEND, 1.0 * MLINK_PEND);
      n++;
    }

    mlinkGeo.setDrawRange(0, n * MTUB_STEPS * MTUB_RADIAL * 6);
    mlinkPosAttr.needsUpdate = true;
    mlinkColAttr.needsUpdate = true;
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

  /** 一颗神经元放电：先走手连的线，再沿结构纤维往外传 */
  function fire(node, gain) {
    // 手连的线优先：那是用户亲口说的"这两段是一件事，冲动必须走这条路"
    var mine = myLinksByNode[node] || [];
    for (var m = 0; m < mine.length; m++) {
      spawnPulse(node, mine[m], 0.16, 0x9f7dff, 1.0, (gain || 1) * 1.3, m * 0.06, 0);
    }

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
      var g = fade * 1.35 * tlDim(q.a, q.b);
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
    // 时间轴在播：推游标、重算权重（tlOn 在下面才声明，靠 var 提升，运行时已赋值）
    if (tlOn && tlPlaying) {
      tlT += dt / TL_SECONDS;
      if (tlT >= 1) { tlT = 1; tlPlaying = false; syncPlayIcon(); }
      updateTimelineWeights();
      renderTimelineUI();
    }

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
      if (linkMode >= 0) mul *= 1.35;         // 连线态：整体抬亮，可点的目标才看得清
      if (searchOn) mul *= searchWeight[i];   // 搜索命中亮、未命中沉下去
      if (tlOn) mul *= tlWeight[i];           // 时间轴：还没发生的压暗，刚发生的淡入
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
  var spinHome = false;        // 双击空白 / 按 R 之后，把球转回正面

  /* 能拉多远。
   * 桌面 44 看着刚好，手机上同样的距离会把球缩成一颗豆子 ——
   * 竖屏本来就窄，视野只能退这么远，再远就是浪费屏幕。 */
  function camMaxDist() {
    return L.camMaxDist(viewW, CFG.cameraMax, 30);
  }

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
    if (spinHome) {
      /* 回正：先把累积角度收进最近的一圈。
       * spinY 是会一直累加的（转十圈就是 62 弧度），直接 damp 到 0
       * 等于当着人的面倒着转回去，像卡带倒带。归约到 [-π, π] 之后
       * 最多转半圈，看着才像"回正"而不是"撤销"。 */
      spinY -= Math.round(spinY / TAU) * TAU;
      spinX = damp(spinX, 0, 5, dt);
      spinY = damp(spinY, 0, 5, dt);
      if (Math.abs(spinX) < 0.004) spinX = 0;
      if (Math.abs(spinY) < 0.004) spinY = 0;
      /* 距离也要到位才算归位结束。相机距离比自转收敛得慢（3.2 对 5），
       * 只看自转会出现「说好了回位，镜头还在往回飘」的半截状态。 */
      if (spinX === 0 && spinY === 0 && Math.abs(camDist - camDistTarget) < 0.05) spinHome = false;
    } else {
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
    }

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
  var panelOpenedAt = 0;      // 刚打开的一小段时间内忽略关闭按钮的点击（回车余波）

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
    setShotSrc(gallery[galleryAt]);
    renderDots();
  }

  /* 照片有两种来源：仓库里的普通路径（assets/x.jpg），和浏览器照片仓里的
   * "idb:xxx" 引用。后者要先取出 blob 转成 object URL，是异步的 ——
   * 而人翻页比取图快，所以带一个令牌，晚到的旧结果直接丢掉。 */
  var shotToken = 0;

  function setShotSrc(ref) {
    var my = ++shotToken;
    if (!PHOTOS || !PHOTOS.isRef(ref)) {
      panelImage.src = ref;
      return;
    }
    PHOTOS.url(ref).then(function (u) {
      if (my !== shotToken) return;
      if (u) panelImage.src = u;
      else panelFigure.classList.add('is-missing');
    });
  }

  function stepShot(dir) {
    if (gallery.length < 2) return;
    showShot(galleryAt + dir, false);
    if (AUDIO && selected >= 0) AUDIO.chime(audioStep[selected] + 1, { gain: 0.05, dur: 0.6 });
  }

  function openPanel(index) {
    var m = MEMORIES[index];
    if (!m) return;

    // 记住焦点从哪儿来，关面板时还回去——键盘用户不会掉到页面开头
    if (!panelEl.contains(document.activeElement)) lastFocusEl = document.activeElement;

    selected = index;
    spotArr[index] = nowSeconds;
    if (whisper.cur === index) whisper.cur = -1;
    setLinkMode(false);          // 换一条记忆，正在拉的线就作废

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

    if (gallery.length && PHOTOS) PHOTOS.warm(gallery);   // 先把 idb: 的取出来，翻页就不用等
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
    panelEl.removeAttribute('inert');
    document.body.classList.add('panel-open');
    replayAnimations();

    // 手机上抽屉和底部面板会打架，开记忆时先收起抽屉
    if (drawerOpen && viewW <= 760) closeDrawer(false);

    /* 焦点送进面板：读屏会先念标题，Tab 也不会跑到看不见的地方。
     * 注意落点是面板容器本身，不是关闭按钮：
     * 用回车打开时（搜索框、记忆索引都走这条路），keydown 到这里刚移完焦点，
     * 紧接着的 keyup 就落在新焦点上。若焦点在 <button> 上，浏览器会把这次
     * keyup 当成一次点击 —— 面板刚开就被自己的关闭按钮关掉。
     * 容器带 tabindex="-1"，既能接住焦点，又不会响应回车。 */
    if (panelEl) panelEl.focus({ preventScroll: true });
    markActiveMem();
    announce('已打开《' + m.title + '》，第 ' + (index + 1) + ' 段，共 ' + COUNT + ' 段');
    panelOpenedAt = Date.now();

    if (viewW <= 760) {
      // 手机上不钻进球里：球留在上面，抽屉从下面抽出来
      panelShiftTarget = 0;
      panelLiftTarget = 1;
      refitPanelCamera();
    } else {
      panelShiftTarget = 1;
      panelLiftTarget = 0;
      // 镜头推近这颗神经元 —— 它在球体内部，于是你会跟着钻进去
      camDistTarget = Math.min(camDistTarget, Math.max(4.2, CFG.R * 0.72));
    }

    emitRipple(index);
    fire(index, 1);                 // 放电：冲动沿纤维传出去
    renderPanelLinks();             // 这条记忆连过谁
    if (MUSIC) MUSIC.duckTo(0.38);  // 读一条记忆时，音乐让位给铃声
    if (AUDIO) {
      AUDIO.init();
      AUDIO.chime(audioStep[index], { gain: 0.16 });
      AUDIO.chime(audioStep[index] + 2, { gain: 0.06, delay: 0.10, octave: 2, dur: 1.8 });
    }
  }

  function closePanel() {
    if (selected === -1 && !panelEl.classList.contains('is-open')) return;
    var hadFocus = panelEl.contains(document.activeElement);
    selected = -1;
    setLinkMode(false);
    panelEl.classList.remove('is-open');
    // 设成 inert 后浏览器会把焦点踢出面板，所以紧接着要把焦点送回原处
    panelEl.setAttribute('aria-hidden', 'true');
    panelEl.setAttribute('inert', '');
    document.body.classList.remove('panel-open');
    panelShiftTarget = 0;
    panelLiftTarget = 0;
    camDistTarget = CFG.cameraDistance;   // 退出球体，回到外面看整颗球
    if (MUSIC) MUSIC.duckTo(1);
    if (AUDIO) AUDIO.close();
    markActiveMem();
    if (hadFocus) {
      var back = (lastFocusEl && document.contains(lastFocusEl) && !panelEl.contains(lastFocusEl))
        ? lastFocusEl
        : (drawerOpen ? memButtons[0] : indexBtnEl);
      if (back && typeof back.focus === 'function') back.focus({ preventScroll: true });
    }
  }

  /* 回到刚打开的样子。
   * 转远了、缩进球里、仰着头看天花板之后，人会想要一个"退回来"的动作。
   * 只复位视角 —— 选中和面板是用户自己挑的，顺手清掉太粗暴；
   * 但选中时相机本来就盯着那颗看，不退出去就谈不上"回正"，所以那种情况先关面板。 */
  function resetView() {
    if (selected >= 0) closePanel();
    camDistTarget = CFG.cameraDistance;
    camTiltTarget.x = 0;
    camTiltTarget.y = 0;
    velSpinX = 0;
    velSpinY = 0.052;
    spinHome = true;
  }

  panelClose.addEventListener('click', function (e) {
    e.stopPropagation();
    // 打开面板的那次回车，keyup 可能落在关闭按钮上被浏览器判成一次点击。
    // 焦点已经改到面板容器了，这里再兜一道，防止别的路径复现同样的问题。
    if (Date.now() - panelOpenedAt < 350) return;
    closePanel();
  });

  document.addEventListener('keydown', function (e) {
    if (lbOpen) {
      /* 照片全屏开着的时候，键都属于那一层。它自己会 stopPropagation，
       * 这里兜住"刚打开、焦点还没落进去"的那几十毫秒。 */
      if (e.key === 'Escape') closeLightbox();
      return;
    }
    if (e.key === 'Escape') {
      /* 一层一层退，先退最上面那个。
       * 录入层压在所有人上面：正在写的东西不能因为按了 Esc 就连带
       * 把底下的面板也关掉 —— 那是两件事。 */
      if (composerOpen()) { closeComposer(true); return; }
      /* 时间轴排在最后：它是"模式"，面板和抽屉是压在上面的浮层，
       * 浮层开着的时候时间轴已经被淡出（见 style.css 的 body.panel-open 规则），
       * 这时候按 Esc 去关一个看不见的东西，人只会以为 Esc 坏了。 */
      if (linkMode >= 0) setLinkMode(false);
      else if (selected >= 0) closePanel();
      else if (drawerOpen) closeDrawer(true);
      else if (tlOn) closeTimeline();
      return;
    }
    if (selected < 0) return;
    if (e.key === 'ArrowLeft') { stepShot(-1); e.preventDefault(); }
    if (e.key === 'ArrowRight') { stepShot(1); e.preventDefault(); }
  });

  // 面板里 Tab 循环，别让焦点跑到被挡住的背景上
  panelEl.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab') return;
    var all = panelEl.querySelectorAll('button:not([disabled]), a[href], input, [tabindex]:not([tabindex="-1"])');
    var list = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var cs = window.getComputedStyle(el);
      // 翻页按钮在只有一张图时是 opacity:0 的，得跳过
      if (el.offsetParent === null || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      list.push(el);
    }
    if (!list.length) return;
    var first = list[0], last = list[list.length - 1];
    if (e.shiftKey && (document.activeElement === first || !panelEl.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !panelEl.contains(document.activeElement))) {
      e.preventDefault();
      first.focus();
    }
  });

  if (figPrev) figPrev.addEventListener('click', function (e) { e.stopPropagation(); stepShot(-1); });
  if (figNext) figNext.addEventListener('click', function (e) { e.stopPropagation(); stepShot(1); });

  // 手机上左右滑也能翻照片；轻点一下把照片铺满屏幕
  (function figureGestures() {
    var sx = 0, sy = 0, live = false;
    panelFigure.addEventListener('pointerdown', function (e) {
      // 图上的按钮（翻页、放大）自己处理点击，别把它当成"在照片上拖了一下"
      var onBtn = e.target && e.target.closest && e.target.closest('button');
      live = !onBtn && gallery.length > 0;
      if (!live) return;
      sx = e.clientX; sy = e.clientY;
    });
    panelFigure.addEventListener('pointerup', function (e) {
      if (!live) return;
      live = false;
      var dx = e.clientX - sx;
      var dy = e.clientY - sy;
      if (Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy) * 1.4) { stepShot(dx < 0 ? 1 : -1); return; }
      /* 轻点照片 = 铺满屏幕。想看清的那一瞬间，人的第一个动作就是戳它一下，
       * 不该还要先找到某个按钮。 */
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) openLightbox(galleryAt);
    });
    panelFigure.addEventListener('pointercancel', function () { live = false; });
  })();

  var figZoomEl = document.getElementById('figZoom');
  if (figZoomEl) {
    figZoomEl.addEventListener('click', function (e) { e.stopPropagation(); openLightbox(galleryAt); });
  }

  /* ------------------------------------------------------------------
   * 20.4 照片全屏
   *
   *   面板里的照片是裁过的封面（object-fit: cover，焦点偏上）：横图被掐掉
   *   两边，竖图被掐掉上下。翻到一张很久以前的照片，想看清那天的天色、
   *   墙上写的字、谁站在第几个，只有放大一途。
   *
   *   这一层不做花哨事：能放大、能拖动、能翻页，Esc 回到原来的位置。
   *   看完照片的人应该回到他离开的地方，而不是被丢回开头。
   * ------------------------------------------------------------------ */
  var lbEl = document.getElementById('lightbox');
  var lbStage = document.getElementById('lbStage');
  var lbImg = document.getElementById('lbImage');
  var lbCloseEl = document.getElementById('lbClose');
  var lbPrevEl = document.getElementById('lbPrev');
  var lbNextEl = document.getElementById('lbNext');
  var lbCountEl = document.getElementById('lbCount');
  var lbCaptionEl = document.getElementById('lbCaption');
  var lbHintEl = document.getElementById('lbHint');

  var LB_MAX = 5;
  var lbOpen = false;
  var lbAt = 0;
  var lbZoom = 1, lbX = 0, lbY = 0;
  var lbAvail = { w: 1, h: 1 };
  var lbSeq = 0;
  var lbBackFocus = null;
  var lbEaseT = 0;
  var lbPtrs = {};
  var lbPtrCount = 0;
  var lbDrag = null;
  var lbPinch = 0;
  var lbMoved = 0;

  /* 可用区域要扣掉内边距：拿整个舞台算的话，放大后能拖到照片边缘露出黑边 */
  function lbMeasure() {
    var cs = window.getComputedStyle(lbStage);
    var padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    var padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    lbAvail.w = Math.max(1, lbStage.clientWidth - padX);
    lbAvail.h = Math.max(1, lbStage.clientHeight - padY);
  }

  function lbPaint() {
    lbImg.style.transform =
      'translate(' + lbX.toFixed(1) + 'px, ' + lbY.toFixed(1) + 'px) scale(' + lbZoom.toFixed(3) + ')';
    lbStage.classList.toggle('is-zoomed', lbZoom > 1.001);
  }

  /* 不许把照片拖到只剩一个角：超出的那部分才是能拖的范围 */
  function lbClampPan() {
    var w = lbImg.clientWidth * lbZoom;
    var h = lbImg.clientHeight * lbZoom;
    lbX = w <= lbAvail.w ? 0 : clamp(lbX, -(w - lbAvail.w) / 2, (w - lbAvail.w) / 2);
    lbY = h <= lbAvail.h ? 0 : clamp(lbY, -(h - lbAvail.h) / 2, (h - lbAvail.h) / 2);
  }

  function lbEase() {
    lbImg.classList.add('is-easing');
    clearTimeout(lbEaseT);
    lbEaseT = setTimeout(function () { lbImg.classList.remove('is-easing'); }, 260);
  }

  /* 以某个屏幕点为中心缩放：手指/光标指着的地方不该跑 */
  function lbSetZoom(z, cx, cy, smooth) {
    var next = clamp(z, 1, LB_MAX);
    var r = lbStage.getBoundingClientRect();
    var px = cx == null ? 0 : cx - (r.left + r.width / 2);
    var py = cy == null ? 0 : cy - (r.top + r.height / 2);
    var k = next / lbZoom;
    lbX = px - (px - lbX) * k;
    lbY = py - (py - lbY) * k;
    lbZoom = next;
    if (lbZoom <= 1.001) { lbZoom = 1; lbX = 0; lbY = 0; }
    lbClampPan();
    if (smooth) lbEase();
    lbPaint();
  }

  function lbReset(smooth) {
    lbZoom = 1; lbX = 0; lbY = 0;
    if (smooth) lbEase();
    lbPaint();
  }

  function lbShow(at) {
    if (!gallery.length) return;
    lbAt = ((at % gallery.length) + gallery.length) % gallery.length;
    var my = ++lbSeq;
    var ref = gallery[lbAt];
    var m = MEMORIES[selected];

    lbImg.classList.remove('is-loaded');
    lbImg.onload = function () {
      if (my !== lbSeq) return;      // 翻得比加载快，晚到的旧图直接丢掉
      lbMeasure();
      lbImg.classList.add('is-loaded');
      lbReset(false);
    };
    lbImg.onerror = function () { if (my === lbSeq) lbImg.classList.remove('is-loaded'); };
    lbImg.alt = (m ? m.title : '') +
      (gallery.length > 1 ? '（' + (lbAt + 1) + ' / ' + gallery.length + '）' : '');

    if (!PHOTOS || !PHOTOS.isRef(ref)) {
      lbImg.src = ref;
    } else {
      lbImg.removeAttribute('src');
      PHOTOS.url(ref).then(function (u) {
        if (my !== lbSeq) return;
        if (u) lbImg.src = u;
      });
    }

    lbCountEl.textContent = gallery.length > 1 ? (lbAt + 1) + ' / ' + gallery.length : '';
    lbPrevEl.hidden = lbNextEl.hidden = gallery.length < 2;
    lbCaptionEl.textContent = m ? m.title + (m.date ? '　·　' + m.date : '') : '';
    lbReset(false);
  }

  function openLightbox(at) {
    if (!lbEl || !gallery.length) return;
    if (lbOpen) { lbShow(at); return; }
    lbOpen = true;
    lbBackFocus = document.activeElement;
    lbEl.removeAttribute('inert');
    lbEl.setAttribute('aria-hidden', 'false');
    lbEl.classList.add('is-open');
    lbMeasure();
    lbShow(at);
    // 焦点送给关闭键：键盘用户能立刻 Esc，读屏也知道换了一层
    setTimeout(function () {
      if (!lbOpen) return;
      try { lbCloseEl.focus({ preventScroll: true }); } catch (e) { }
    }, 60);
  }

  function closeLightbox() {
    if (!lbOpen) return;
    lbOpen = false;
    lbPtrs = {}; lbPtrCount = 0; lbDrag = null; lbPinch = 0;
    lbEl.classList.remove('is-open');
    lbEl.setAttribute('aria-hidden', 'true');
    lbEl.setAttribute('inert', '');
    lbReset(true);
    var back = lbBackFocus;
    lbBackFocus = null;
    /* 用鼠标点开的照片，打开时 activeElement 就是 body —— 把焦点还给 body
     * 等于没还，键盘用户会掉到页首。落到放大键上：下一步想去哪儿就从那儿走。 */
    if (!back || back === document.body || back === document.documentElement || !document.contains(back)) {
      back = figZoomEl;
    }
    if (back && typeof back.focus === 'function') {
      try { back.focus({ preventScroll: true }); } catch (e) { }
    }
  }

  function lbStep(dir) {
    if (gallery.length < 2) return;
    lbShow(lbAt + dir);
    showShot(lbAt, false);      // 面板跟着走：关掉全屏，看见的就是最后这张
    if (AUDIO && selected >= 0) AUDIO.chime(audioStep[selected] + 1, { gain: 0.05, dur: 0.6 });
  }

  if (lbEl) {
    if (lbHintEl) {
      lbHintEl.textContent = COARSE
        ? '双指放大 · 拖动查看 · 双击回到整张'
        : '滚轮或双击放大 · 拖动查看 · Esc 关闭';
    }
    if (lbCountEl) lbCountEl.style.fontVariantNumeric = 'tabular-nums';

    lbCloseEl.addEventListener('click', closeLightbox);
    lbPrevEl.addEventListener('click', function () { lbStep(-1); });
    lbNextEl.addEventListener('click', function () { lbStep(1); });

    // 点照片以外的地方关掉。
    // 两处坑：拖动结束浏览器也会补一个 click；指针捕获之后 click 的目标
    // 还会变成舞台本身（不是照片）。所以不看 target，直接看点击落点
    // 在不在照片的框里 —— 这个判断跟事件从哪儿冒出来无关。
    lbEl.addEventListener('click', function (e) {
      if (lbMoved > 8) return;
      var r = lbImg.getBoundingClientRect();
      var inside = e.clientX >= r.left && e.clientX <= r.right &&
        e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) closeLightbox();
    });

    lbStage.addEventListener('wheel', function (e) {
      e.preventDefault();
      lbSetZoom(lbZoom * Math.exp(-e.deltaY * 0.0018), e.clientX, e.clientY);
    }, { passive: false });

    lbStage.addEventListener('dblclick', function (e) {
      if (e.target && e.target.closest && e.target.closest('button')) return;
      if (lbZoom > 1.05) lbReset(true);
      else lbSetZoom(2.4, e.clientX, e.clientY, true);
    });

    function lbList() {
      var out = [];
      for (var k in lbPtrs) if (Object.prototype.hasOwnProperty.call(lbPtrs, k)) out.push(lbPtrs[k]);
      return out;
    }

    lbStage.addEventListener('pointerdown', function (e) {
      if (e.target && e.target.closest && e.target.closest('button')) return;
      lbMoved = 0;
      lbPtrs[e.pointerId] = { x: e.clientX, y: e.clientY };
      try { lbStage.setPointerCapture(e.pointerId); } catch (err) { }
      var ps = lbList();
      lbPtrCount = ps.length;
      if (lbPtrCount === 1) {
        lbDrag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: 0 };
      } else {
        lbDrag = null;
        lbPinch = ps.length >= 2 ? Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) : 0;
      }
    });

    lbStage.addEventListener('pointermove', function (e) {
      if (!lbPtrs[e.pointerId]) return;
      lbPtrs[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ps = lbList();

      if (ps.length >= 2) {
        var d = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
        if (lbPinch > 0 && d > 0) {
          lbSetZoom(lbZoom * (d / lbPinch), (ps[0].x + ps[1].x) / 2, (ps[0].y + ps[1].y) / 2);
        }
        lbPinch = d;
        return;
      }

      if (!lbDrag) return;
      var dx = e.clientX - lbDrag.x;
      var dy = e.clientY - lbDrag.y;
      lbDrag.moved += Math.abs(dx) + Math.abs(dy);
      lbMoved += Math.abs(dx) + Math.abs(dy);
      lbDrag.x = e.clientX; lbDrag.y = e.clientY;
      if (lbZoom > 1.001) {
        lbStage.classList.add('is-dragging');
        lbX += dx; lbY += dy;
        lbClampPan();
        lbPaint();
      }
    });

    function lbRelease(e) {
      if (!lbPtrs[e.pointerId]) return;
      delete lbPtrs[e.pointerId];
      try { lbStage.releasePointerCapture(e.pointerId); } catch (err) { }
      lbPtrCount = lbList().length;
      lbStage.classList.remove('is-dragging');

      if (lbPtrCount >= 2) return;               // 还有两指在上面，接着捏
      if (lbPtrCount === 1) {                    // 抬起一根，另一根重新算拖动起点
        lbPinch = 0;
        lbDrag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: 0 };
        return;
      }

      lbPinch = 0;
      if (!lbDrag) return;
      var dx = e.clientX - lbDrag.sx;
      var dy = e.clientY - lbDrag.sy;
      var moved = lbDrag.moved;
      lbDrag = null;

      // 停在 1.03 倍这种状态最别扭：要么整张，要么明显放大
      if (lbZoom > 1.001 && lbZoom < 1.06 && moved < 6) { lbReset(true); return; }

      if (lbZoom <= 1.001 && gallery.length > 1 &&
        Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.3) {
        lbStep(dx < 0 ? 1 : -1);
      }
    }
    lbStage.addEventListener('pointerup', lbRelease);
    lbStage.addEventListener('pointercancel', lbRelease);

    lbEl.addEventListener('keydown', function (e) {
      if (!lbOpen) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();          // 别让底下那层顺手把面板也关了
        closeLightbox();
        return;
      }
      if (e.key === 'Tab') {
        var ring = [lbCloseEl, lbPrevEl, lbNextEl].filter(function (b) {
          return b && !b.hidden && b.offsetParent !== null;
        });
        if (!ring.length) return;
        var i = ring.indexOf(document.activeElement);
        if (i < 0) i = e.shiftKey ? 0 : ring.length - 1;
        var next = ring[(i + (e.shiftKey ? -1 : 1) + ring.length) % ring.length];
        e.preventDefault();
        next.focus();
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        var dir = e.key === 'ArrowLeft' ? -1 : 1;
        // 放大之后方向键是平移，否则是翻页
        if (lbZoom > 1.001) { lbX += dir * 60; lbClampPan(); lbEase(); lbPaint(); }
        else lbStep(dir);
        return;
      }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); lbSetZoom(lbZoom * 1.35, null, null, true); return; }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); lbSetZoom(lbZoom / 1.35, null, null, true); return; }
      if (e.key === '0') { e.preventDefault(); lbReset(true); }
    });

    window.addEventListener('resize', function () {
      if (!lbOpen) return;
      lbMeasure();
      lbClampPan();
      lbPaint();
    });
  }

  /* ------------------------------------------------------------------
   * 20.5 记忆互连：面板里的「连一条」
   *   键盘路径不另造选择器：进入连线态后按 L 打开已有的记忆索引，
   *   方向键选、回车"连它"（而不是"打开它"）。复用比新建更不容易开倒车。
   * ------------------------------------------------------------------ */
  var linkBtnEl = document.getElementById('linkBtn');
  var linkBtnLabel = document.getElementById('linkBtnLabel');
  var linkHintEl = document.getElementById('linkHint');
  var panelLinksEl = document.getElementById('panelLinks');
  var panelLinksListEl = document.getElementById('panelLinksList');
  var panelLinksCountEl = document.getElementById('panelLinksCount');
  var panelLinksWarnEl = document.getElementById('panelLinksWarn');

  /** 写回数据层之后，把 MEMORIES 换成新的那份（SeaRepo.save 会整体替换数组） */
  function refreshMemories() {
    if (!window.SeaRepo || typeof window.SeaRepo.list !== 'function') return;
    try {
      var l = window.SeaRepo.list();
      if (l && l.length === COUNT) MEMORIES = l;
    } catch (e) { /* 数据层不可用就继续用内存里那份 */ }
  }

  /* ------------------------------------------------------------------
   * 22.4 写一条 / 改一条
   *
   *   这块以前是独立的 录入.html：拖照片、导出到文件夹、再回主页面刷新。
   *   绕三圈的原因不在界面，在存储 —— localStorage 只有 5MB，
   *   一张压缩过的照片转 base64 就吃掉 250KB，存十几张就满。
   *   所以照片改存在 IndexedDB（js/photos.js），数据里只留 "idb:<id>"。
   *
   *   存下之后为什么要整页重来：
   *   粒子位置、连线几何、脑区分组、检索索引全是启动时按条数一次建好的，
   *   原地插一条要动的地方太多，而重来一次只要一秒 —— 何况
   *   「写完看着星图重新长一遍」本身就是这个项目想要的那个瞬间。
   * ------------------------------------------------------------------ */

  var composerEl = document.getElementById('composer');
  var cmpTitleEl = document.getElementById('cmpTitle');
  var cmpSubEl = document.getElementById('cmpSub');
  var cmpTitleInput = document.getElementById('cmpTitleInput');
  var cmpDateEl = document.getElementById('cmpDate');
  var cmpTagEl = document.getElementById('cmpTag');
  var cmpLineEl = document.getElementById('cmpLine');
  var cmpTextEl = document.getElementById('cmpText');
  var cmpShotsEl = document.getElementById('cmpShots');
  var cmpFileEl = document.getElementById('cmpFile');
  var cmpSaveEl = document.getElementById('cmpSave');
  var cmpCancelEl = document.getElementById('cmpCancel');
  var cmpDeleteEl = document.getElementById('cmpDelete');
  var cmpCloseEl = document.getElementById('cmpClose');
  var cmpPhotoNoteEl = document.getElementById('cmpPhotoNote');
  var cmpTagListEl = document.getElementById('cmpTagList');
  var memAddBtnEl = document.getElementById('memAddBtn');
  var panelEditBtn = document.getElementById('panelEditBtn');

  var editingIndex = -1;      // -1 = 新写一条
  var draftShots = [];        // 表单里现在的照片引用（可能是 idb:，也可能是老路径）
  var draftOriginal = [];     // 进来时的照片，用来算哪些被删掉了
  var composerFocusBack = null;
  var MAX_SHOTS = 24;         // 和数据层 normalize 的上限对齐

  function composerOpen() {
    return !!(composerEl && composerEl.classList.contains('is-open'));
  }

  function noteCmp(text) {
    if (cmpPhotoNoteEl) cmpPhotoNoteEl.textContent = text || '';
  }

  function renderShots() {
    if (!cmpShotsEl) return;
    cmpShotsEl.textContent = '';

    draftShots.forEach(function (ref, i) {
      var box = document.createElement('div');
      box.className = 'cmp-shot';

      var img = document.createElement('img');
      img.alt = '第 ' + (i + 1) + ' 张照片';
      if (PHOTOS && PHOTOS.isRef(ref)) {
        PHOTOS.url(ref).then(function (u) { if (u) img.src = u; });
      } else {
        img.src = ref;
      }

      var del = document.createElement('button');
      del.className = 'cmp-shot-del';
      del.type = 'button';
      del.textContent = '×';
      del.setAttribute('aria-label', '去掉第 ' + (i + 1) + ' 张');
      del.addEventListener('click', function () {
        draftShots.splice(i, 1);
        renderShots();
      });

      box.appendChild(img);
      box.appendChild(del);
      cmpShotsEl.appendChild(box);
    });

    if (draftShots.length < MAX_SHOTS) {
      var add = document.createElement('button');
      add.className = 'cmp-add';
      add.type = 'button';
      add.innerHTML = '＋<i>加一张</i>';
      add.addEventListener('click', function () { if (cmpFileEl) cmpFileEl.click(); });
      cmpShotsEl.appendChild(add);
    }

    if (draftShots.length) noteCmp(draftShots.length + ' 张 · 存在这台浏览器里');
    else noteCmp('');
  }

  function addShots(files) {
    var list = [];
    for (var i = 0; i < files.length; i++) {
      if (files[i] && files[i].type && files[i].type.indexOf('image/') === 0) list.push(files[i]);
    }
    if (!list.length) return;
    if (draftShots.length + list.length > MAX_SHOTS) {
      list = list.slice(0, Math.max(0, MAX_SHOTS - draftShots.length));
      if (!list.length) return;
    }
    if (!PHOTOS || !PHOTOS.supported()) {
      noteCmp('这台浏览器不给存照片，改用「导出到文件夹」吧');
      return;
    }

    if (cmpSaveEl) cmpSaveEl.disabled = true;
    noteCmp('正在收第 ' + list.length + ' 张…');

    var chain = Promise.resolve();
    list.forEach(function (f) {
      chain = chain.then(function () {
        return PHOTOS.put(f).then(function (r) { draftShots.push(r.ref); });
      });
    });
    chain.then(function () {
      if (cmpSaveEl) cmpSaveEl.disabled = false;
      renderShots();
    }).catch(function (err) {
      if (cmpSaveEl) cmpSaveEl.disabled = false;
      noteCmp((err && err.message) || '这张没能存进来');
      renderShots();
    });
  }

  function fillTagList() {
    if (!cmpTagListEl) return;
    var seen = {};
    var html = '';
    for (var i = 0; i < MEMORIES.length; i++) {
      var t = MEMORIES[i].tag;
      if (!t || seen[t]) continue;
      seen[t] = 1;
      html += '<option value="' + t.replace(/"/g, '&quot;') + '"></option>';
    }
    cmpTagListEl.innerHTML = html;
  }

  function openComposer(index) {
    if (!composerEl) return;
    var m = (typeof index === 'number' && index >= 0) ? MEMORIES[index] : null;
    editingIndex = m ? index : -1;
    composerFocusBack = (panelEl && panelEl.contains(document.activeElement)) ? panelEl : document.activeElement;

    fillTagList();
    noteCmp('');

    if (m) {
      cmpTitleEl.textContent = '改一条';
      cmpSubEl.textContent = '第 ' + pad2(index + 1) + ' 段';
      cmpTitleInput.value = m.title || '';
      cmpDateEl.value = (m.createdAt || '').slice(0, 10);
      cmpTagEl.value = m.tag === '未名' ? '' : (m.tag || '');
      cmpLineEl.value = m.date || '';
      cmpTextEl.value = m.text || '';
      draftShots = (m.images && m.images.length ? m.images : (m.image ? [m.image] : [])).slice();
      cmpDeleteEl.hidden = false;
    } else {
      cmpTitleEl.textContent = '写一条';
      cmpSubEl.textContent = '要写的是你自己的记忆';
      cmpTitleInput.value = '';
      cmpDateEl.value = new Date().toISOString().slice(0, 10);
      cmpTagEl.value = '';
      cmpLineEl.value = '';
      cmpTextEl.value = '';
      draftShots = [];
      cmpDeleteEl.hidden = true;
    }
    draftOriginal = draftShots.slice();

    renderShots();
    composerEl.classList.add('is-open');
    composerEl.setAttribute('aria-hidden', 'false');
    composerEl.removeAttribute('inert');
    document.body.classList.add('composer-open');
    if (drawerOpen) closeDrawer(false);

    setTimeout(function () { if (cmpTitleInput) cmpTitleInput.focus(); }, 60);
  }

  function closeComposer(dropUnsaved) {
    if (!composerOpen()) return;

    /* 这次新加、但没被保存的照片要从仓里清掉，
     * 否则每试一次就留几张孤儿图，几个月后占满也不知道是谁的。 */
    if (dropUnsaved !== false && PHOTOS) {
      for (var i = 0; i < draftShots.length; i++) {
        if (PHOTOS.isRef(draftShots[i]) && draftOriginal.indexOf(draftShots[i]) < 0) {
          PHOTOS.remove(draftShots[i]);
        }
      }
    }

    composerEl.classList.remove('is-open');
    composerEl.setAttribute('aria-hidden', 'true');
    composerEl.setAttribute('inert', '');
    document.body.classList.remove('composer-open');
    draftShots = [];
    draftOriginal = [];
    editingIndex = -1;

    if (composerFocusBack && document.contains(composerFocusBack) && typeof composerFocusBack.focus === 'function') {
      try { composerFocusBack.focus({ preventScroll: true }); } catch (e) { }
    }
  }

  /** 存下之后整页重来，但要告诉下一页"刚存的是哪一条" */
  function reloadTo(index) {
    try { sessionStorage.setItem('sea.composer.saved', String(index)); } catch (e) { }
    location.reload();
  }

  function saveComposer() {
    var title = (cmpTitleInput.value || '').trim();
    if (!title) {
      cmpTitleInput.focus();
      cmpTitleInput.classList.add('is-shake');
      setTimeout(function () { cmpTitleInput.classList.remove('is-shake'); }, 600);
      noteCmp('先给它一个标题');
      return;
    }

    var repo = window.SeaRepo;
    if (!repo || typeof repo.upsert !== 'function') {
      noteCmp('数据层没起来，这一条存不下');
      return;
    }

    var item = {
      title: title,
      text: (cmpTextEl.value || '').trim(),
      images: draftShots.slice(),
      image: draftShots[0] || '',
      tag: (cmpTagEl.value || '').trim() || '未名',
      date: (cmpLineEl.value || '').trim(),
      createdAt: cmpDateEl.value || ''
    };

    /* 编辑时把表单管不着的字段带上：颜色、大小、连线。
     * 数据层对 links 有保护（不传就沿用），这里显式带上更稳。 */
    if (editingIndex >= 0 && MEMORIES[editingIndex]) {
      var old = MEMORIES[editingIndex];
      if (old.color) item.color = old.color;
      if (typeof old.size === 'number') item.size = old.size;
      if (old.links) item.links = old.links.slice();
    }

    // 被移出表单的照片，从仓里也删掉（不然只是"看不见"，不是"删了"）
    if (PHOTOS) {
      for (var k = 0; k < draftOriginal.length; k++) {
        var ref = draftOriginal[k];
        if (PHOTOS.isRef(ref) && draftShots.indexOf(ref) < 0) PHOTOS.remove(ref);
      }
    }

    var arr = repo.upsert(item, editingIndex);
    var at = editingIndex >= 0 ? editingIndex : (arr ? arr.length - 1 : 0);

    draftShots = [];          // 已经交出去了，关的时候别再当垃圾清掉
    draftOriginal = [];
    closeComposer(false);
    announce(editingIndex >= 0 ? '改好了，星图正在重排' : '存下了，这颗星正在亮起来');
    reloadTo(at);
  }

  function deleteComposerItem() {
    if (editingIndex < 0) return;
    var m = MEMORIES[editingIndex];
    if (!m) return;
    if (!window.confirm('删掉「' + m.title + '」？这一步收不回来。')) return;

    var refs = (m.images && m.images.length ? m.images : (m.image ? [m.image] : []));
    if (window.SeaRepo && typeof window.SeaRepo.removeAt === 'function') {
      window.SeaRepo.removeAt(editingIndex);
    }
    if (PHOTOS) {
      refs.forEach(function (r) { if (PHOTOS.isRef(r)) PHOTOS.remove(r); });
    }
    draftShots = [];
    draftOriginal = [];
    closeComposer(false);
    reloadTo(-1);
  }

  if (memAddBtnEl) {
    memAddBtnEl.addEventListener('click', function () { openComposer(-1); });
  }
  if (panelEditBtn) {
    panelEditBtn.addEventListener('click', function () {
      if (selected >= 0) openComposer(selected);
    });
  }
  if (cmpSaveEl) cmpSaveEl.addEventListener('click', saveComposer);
  if (cmpCancelEl) cmpCancelEl.addEventListener('click', function () { closeComposer(true); });
  if (cmpCloseEl) cmpCloseEl.addEventListener('click', function () { closeComposer(true); });
  if (cmpDeleteEl) cmpDeleteEl.addEventListener('click', deleteComposerItem);
  if (cmpFileEl) {
    cmpFileEl.addEventListener('change', function () {
      if (cmpFileEl.files && cmpFileEl.files.length) addShots(cmpFileEl.files);
      cmpFileEl.value = '';      // 同一张图选两次也要能触发
    });
  }
  if (composerEl) {
    // 点遮罩空白处关上；点卡片里不关
    composerEl.addEventListener('click', function (e) {
      if (e.target === composerEl) closeComposer(true);
    });
    // Ctrl/⌘ + Enter 存下，写长文时不用去够鼠标
    composerEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        saveComposer();
      }
    });
  }

  /* 存完重来一次之后，把刚写的那条自己打开 —— 
   * 让人看见"它真的在那儿"，而不是回到一颗看不出变化的球。 */
  (function openJustSaved() {
    var v = null;
    try { v = sessionStorage.getItem('sea.composer.saved'); } catch (e) { v = null; }
    if (v === null) return;
    try { sessionStorage.removeItem('sea.composer.saved'); } catch (e) { }
    var idx = parseInt(v, 10);
    if (!isFinite(idx) || idx < 0 || !MEMORIES[idx]) return;
    setTimeout(function () { openPanel(idx); }, 1000);
  })();

  /* ------------------------------------------------------------------
   * 22.5 导出到文件夹
   *
   *   照片存进浏览器之后，"数据只在这台机器上"这句话就从委婉变成了字面意思：
   *   清一次缓存就没了。所以导出不是可选功能，是唯一的正经备份。
   *
   *   导出的两件事：
   *     1. 把 data/memories.js 重写一遍，里面的 "idb:xxx" 换成 assets/photo-xxx.jpg
   *     2. 把仓里的照片真写进 assets/
   *   做完之后，那一份就是可以双击打开、可以推 Git 的完整静态站。
   * ------------------------------------------------------------------ */

  async function ensureDirHandle(parent, name) {
    try { return await parent.getDirectoryHandle(name); }
    catch (e) { return await parent.getDirectoryHandle(name, { create: true }); }
  }

  async function writeFile(dirHandle, name, data) {
    var fh = await dirHandle.getFileHandle(name, { create: true });
    var w = await fh.createWritable();
    try { await w.write(data); } finally { await w.close(); }
  }

  /** 把仓里的照片写成文件，返回 {旧引用: 新路径} */
  async function spillPhotos(list, assetsDir) {
    var map = {};
    var total = 0;
    if (!PHOTOS || !assetsDir) return { map: map, total: 0 };

    for (var i = 0; i < list.length; i++) {
      var pics = list[i].images && list[i].images.length
        ? list[i].images
        : (list[i].image ? [list[i].image] : []);
      for (var j = 0; j < pics.length; j++) {
        var ref = pics[j];
        if (!PHOTOS.isRef(ref) || map[ref]) continue;
        var rec = null;
        try { rec = await PHOTOS.blobOf(ref); } catch (e) { rec = null; }
        if (!rec) continue;
        var ext = /png/i.test((rec.blob && rec.blob.type) || rec.type) ? 'png' : 'jpg';
        var name = 'photo-' + PHOTOS.refId(ref).replace(/[^a-z0-9-]/gi, '') + '.' + ext;
        await writeFile(assetsDir, name, rec);
        map[ref] = 'assets/' + name;
        total++;
      }
    }
    return { map: map, total: total };
  }

  function applyPhotoMap(list, map) {
    return list.map(function (m) {
      var copy = {};
      for (var k in m) if (Object.prototype.hasOwnProperty.call(m, k)) copy[k] = m[k];
      if (copy.images && copy.images.length) {
        copy.images = copy.images.map(function (p) { return map[p] || p; });
        copy.image = copy.images[0] || '';
      } else if (copy.image && map[copy.image]) {
        copy.image = map[copy.image];
      }
      return copy;
    });
  }

  async function exportToFolder() {
    var repo = window.SeaRepo;
    if (!repo || typeof repo.list !== 'function') { announce('数据层没起来，导不了'); return; }
    if (typeof window.showDirectoryPicker !== 'function') {
      announce('这个浏览器不支持写入文件夹，请用 Chrome 或 Edge 打开');
      return;
    }

    var list = repo.list();
    var root = null;
    try {
      root = await window.showDirectoryPicker({ mode: 'readwrite', id: 'shihai' });
    } catch (e) {
      return;   // 用户取消，什么都不必说
    }

    try {
      var assetsDir = await ensureDirHandle(root, 'assets');
      var dataDir = await ensureDirHandle(root, 'data');
      var spilled = await spillPhotos(list, assetsDir);
      var finalList = applyPhotoMap(list, spilled.map);
      await writeFile(dataDir, 'memories.js', repo.toSource(finalList));

      var msg = '导出完成：' + list.length + ' 条记忆';
      if (spilled.total) msg += '，' + spilled.total + ' 张照片写进了 assets/';
      announce(msg);
      setExportNote(msg + '。这个文件夹现在是一份完整、可以双击打开的站点了。');
    } catch (err) {
      setExportNote('导出中断：' + ((err && err.message) || '写不进去'));
    }
  }

  var exportNoteEl = null;

  function setExportNote(text) {
    if (!exportNoteEl) return;
    exportNoteEl.textContent = text;
    exportNoteEl.hidden = !text;
  }

  /* 数据区块写在 index.html 里，不往 privacyBody 塞：
   * 那块内容 lock.js 每次打开都整体重建，动态追加进去会被冲掉（踩过一次）。 */
  var exportBtnEl = document.getElementById('exportBtn');
  var photoUsageEl = document.getElementById('photoUsage');
  exportNoteEl = document.getElementById('exportNote');

  function refreshPhotoUsage() {
    if (!photoUsageEl) return;
    if (!PHOTOS) { photoUsageEl.textContent = '这个浏览器存不了照片'; return; }
    PHOTOS.usage().then(function (u) {
      photoUsageEl.textContent = u.count
        ? '浏览器里存着 ' + u.count + ' 张照片，共 ' + u.human
        : '还没有照片';
    });
  }

  if (exportBtnEl) exportBtnEl.addEventListener('click', exportToFolder);
  refreshPhotoUsage();

  var privacyBtnEl = document.getElementById('privacyBtn');
  if (privacyBtnEl) {
    // 打开面板时重算一次：可能刚写过一条带照片的记忆
    privacyBtnEl.addEventListener('click', function () { setTimeout(refreshPhotoUsage, 0); });
  }

  function setLinkMode(on) {
    if (on) {
      if (selected < 0) return;
      linkMode = selected;
      canvas.classList.add('is-linking');
      if (linkBtnEl) {
        linkBtnEl.classList.add('is-on');
        linkBtnEl.setAttribute('aria-pressed', 'true');
      }
      if (linkBtnLabel) linkBtnLabel.textContent = '取消连线';
      if (linkHintEl) linkHintEl.hidden = false;
      announce('连线中。按 L 打开记忆索引，方向键选择，回车连接；Esc 取消');
      if (AUDIO && AUDIO.isReady()) AUDIO.hover();
    } else {
      if (linkMode < 0) return;
      linkMode = -1;
      canvas.classList.remove('is-linking');
      if (linkBtnEl) {
        linkBtnEl.classList.remove('is-on');
        linkBtnEl.setAttribute('aria-pressed', 'false');
      }
      if (linkBtnLabel) linkBtnLabel.textContent = '连一条';
      if (linkHintEl) linkHintEl.hidden = true;
    }
  }

  /** 在 from 和 target 之间连一条（双向）。返回是否真的连上了 */
  function doLink(target) {
    var from = linkMode;
    if (from < 0) return false;
    if (target === from) { announce('不能连自己'); return false; }
    if (target < 0 || target >= COUNT) return false;

    var existing = MEMORIES[from].links || [];
    if (existing.indexOf(target) >= 0) {
      setLinkMode(false);
      announce('这两段已经连过了');
      return false;
    }

    if (window.SeaRepo && typeof window.SeaRepo.link === 'function') {
      window.SeaRepo.link(from, target);
      refreshMemories();
    } else {
      // 没有数据层（比如直接改了 memories.js）时退回内存操作
      MEMORIES[from].links = (MEMORIES[from].links || []).concat([target]);
      MEMORIES[target].links = (MEMORIES[target].links || []).concat([from]);
    }

    syncMyLinks();
    setLinkMode(false);
    renderPanelLinks();
    fire(from, 1);                      // 连上的瞬间放一次电，给个"通电"的反馈
    if (AUDIO && AUDIO.isReady()) AUDIO.chime(audioStep[from] + 1, { gain: 0.07, dur: 1.2 });
    announce('已连上《' + MEMORIES[target].title + '》');
    return true;
  }

  function doUnlink(a, b) {
    if (a < 0 || a >= COUNT || b < 0 || b >= COUNT) return;
    if (window.SeaRepo && typeof window.SeaRepo.unlink === 'function') {
      window.SeaRepo.unlink(a, b);
      refreshMemories();
    } else {
      var cut = function (arr, v) {
        var i = arr.indexOf(v);
        if (i >= 0) arr.splice(i, 1);
        return arr;
      };
      MEMORIES[a].links = cut(MEMORIES[a].links || [], b);
      MEMORIES[b].links = cut(MEMORIES[b].links || [], a);
    }
    syncMyLinks();
    renderPanelLinks();
    announce('已解除与《' + MEMORIES[b].title + '》的连接');
  }

  /** 面板里的"与它相连"列表 */
  function renderPanelLinks() {
    if (!panelLinksEl || !panelLinksListEl) return;

    var cur = selected;
    if (cur < 0) { panelLinksEl.hidden = true; panelLinksListEl.innerHTML = ''; return; }

    // 线条数超过渲染上限时如实说明，不假装全都画出来了
    if (panelLinksWarnEl) {
      if (myLinksDropped > 0) {
        panelLinksWarnEl.hidden = false;
        panelLinksWarnEl.textContent = '线条太多，还有 ' + myLinksDropped + ' 条超出显示上限未绘制';
      } else {
        panelLinksWarnEl.hidden = true;
        panelLinksWarnEl.textContent = '';
      }
    }

    var ls = (MEMORIES[cur].links || []).slice();
    if (panelLinksCountEl) panelLinksCountEl.textContent = ls.length ? ls.length + ' 条' : '';

    if (!ls.length) {
      panelLinksEl.hidden = true;
      panelLinksListEl.innerHTML = '';
      return;
    }

    panelLinksEl.hidden = false;
    panelLinksListEl.innerHTML = '';

    for (var i = 0; i < ls.length; i++) {
      var idx = ls[i];
      var title = MEMORIES[idx] ? MEMORIES[idx].title : '（已失效）';

      var li = document.createElement('li');
      li.className = 'panel-link-row';

      var go = document.createElement('button');
      go.type = 'button';
      go.className = 'panel-link-go';
      go.setAttribute('data-to', String(idx));
      go.textContent = title;

      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'panel-link-x';
      rm.setAttribute('data-to', String(idx));
      rm.setAttribute('aria-label', '解除与《' + title + '》的连接');
      rm.textContent = '×';

      li.appendChild(go);
      li.appendChild(rm);
      panelLinksListEl.appendChild(li);
    }
  }

  if (panelLinksListEl) {
    panelLinksListEl.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('button[data-to]') : null;
      if (!btn) return;
      var to = parseInt(btn.getAttribute('data-to'), 10);
      if (isNaN(to)) return;
      if (btn.classList.contains('panel-link-x')) doUnlink(selected, to);
      else openPanel(to);
    });
  }

  if (linkBtnEl) {
    linkBtnEl.addEventListener('click', function (e) {
      e.stopPropagation();
      setLinkMode(linkMode < 0);
    });
  }

  syncMyLinks();

  /* ------------------------------------------------------------------
   * 20.6 时间轴回放：把「时间衰减」从静态参数变成可播放的一段
   *   createdAt 本来就在决定每颗神经元的亮度，只是它一直静止在"现在"。
   *   这里把时间点做成一个可以推的游标：早于它的亮起来，晚于它的沉下去，
   *   于是整颗球会按年份从空到满地长出来——这才是记忆该有的样子。
   * ------------------------------------------------------------------ */
  var timelineBtnEl = document.getElementById('timelineBtn');
  var timelineEl = document.getElementById('timeline');
  var tlYearEl = document.getElementById('tlYear');
  var tlPlayEl = document.getElementById('tlPlay');
  var tlRangeEl = document.getElementById('tlRange');
  var tlCountEl = document.getElementById('tlCount');
  var tlCloseEl = document.getElementById('tlClose');

  var tlOn = false;
  var tlPlaying = false;
  var tlT = 0;                              // 0..1 的进度
  var tlMinMs = 0, tlMaxMs = 1;
  var tlSettled = 0;                        // 已经"发生"的条数
  var TL_SECONDS = 9;                       // 全程大约走多久
  var tlWeight = new Float32Array(COUNT);
  var createdMs = new Float64Array(COUNT);
  var tlFillPct = '';                       // 轨道已填宽度，避免每帧重复写同一个值
  var tlYearTxt = '', tlCountTxt = '';      // 同上：内容和上次一样就不碰 DOM

  (function initTimeline() {
    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i < COUNT; i++) {
      // age 是从 NOW 往前算的年数，反推回时间戳
      var c = NOW - (MEMORIES[i].age || 0) * YEAR_MS;
      createdMs[i] = c;
      tlWeight[i] = 1;
      if (c < lo) lo = c;
      if (c > hi) hi = c;
    }
    if (!isFinite(lo)) { lo = NOW - 10 * YEAR_MS; hi = NOW; }
    // 头尾各留一点余量，别让第一条一开场就是满亮
    tlMinMs = lo - 0.55 * YEAR_MS;
    tlMaxMs = Math.max(hi + 0.4 * YEAR_MS, NOW);
  })();

  function tlNowMs() { return tlMinMs + (tlMaxMs - tlMinMs) * tlT; }

  /** 按当前时间点刷新每颗的权重：还没发生的压暗，刚发生的淡入 */
  function updateTimelineWeights() {
    var t = tlNowMs();
    var settled = 0;
    for (var i = 0; i < COUNT; i++) {
      var d = (t - createdMs[i]) / YEAR_MS;    // 正数＝已经发生多久，负数＝还有多久才发生
      var w;
      if (d < 0) {
        // 未来：指数压下去，但不归零——留一点影子，能看出"那里以后会有东西"
        w = Math.exp(d * 4.5) * 0.5;
      } else {
        w = d * 4 < 0.7 ? 0.28 + d * 4 : 1;    // 0.18 年左右的淡入
        settled++;
      }
      tlWeight[i] = w;
    }
    tlSettled = settled;
  }

  /**
   * 时间轴下这条连线该有多亮：取两端的较小值。
   * 一端还没发生，线就不该整根亮着 —— 那会变成"没有端点的悬空线"。
   * 用较小值而不是平均值，是因为刚淡入的那一头本来就该把线一起带出来。
   */
  function tlDim(a, b) {
    return L.timelineDim(tlOn, tlWeight[a], tlWeight[b]);
  }

  function renderTimelineUI() {
    /* 这个函数每帧都被调（播放时），所以每个写操作都先比对一下。
     * 光是"把同一个字符串再赋给 textContent"就会替换掉那个文本节点、
     * 触发一次样式重算——1.8 万粒子的场景不该在这上面浪费帧。 */
    var y = String(new Date(tlNowMs()).getFullYear());
    if (tlYearEl && y !== tlYearTxt) { tlYearTxt = y; tlYearEl.textContent = y; }

    if (tlRangeEl && document.activeElement !== tlRangeEl) {
      tlRangeEl.value = String(Math.round(tlT * 1000));
    }
    // 已播放那一段的宽度。轨道靠这个变量决定渐变填到哪里，
    // 否则整条轨道一色，滑块挪动看不出来。
    if (tlRangeEl) {
      var pct = (Math.round(tlT * 1000) / 10).toFixed(1) + '%';
      if (pct !== tlFillPct) {
        tlFillPct = pct;
        tlRangeEl.style.setProperty('--tl-fill', pct);
      }
    }
    if (tlCountEl) {
      var c = tlSettled + ' / ' + COUNT;
      if (c !== tlCountTxt) { tlCountTxt = c; tlCountEl.textContent = c; }
    }
  }

  function syncPlayIcon() {
    if (!tlPlayEl) return;
    tlPlayEl.classList.toggle('is-paused', !tlPlaying);
    tlPlayEl.setAttribute('aria-label', tlPlaying ? '暂停回放' : '继续回放');
  }

  function openTimeline(autoplay) {
    if (tlOn) { setTimelinePlaying(autoplay !== false); return; }
    if (selected >= 0) closePanel();
    tlOn = true;
    tlT = 0;
    document.body.classList.add('tl-open');
    if (timelineEl) timelineEl.hidden = false;
    if (timelineBtnEl) {
      timelineBtnEl.classList.add('is-on');
      timelineBtnEl.setAttribute('aria-pressed', 'true');
      timelineBtnEl.setAttribute('aria-expanded', 'true');
    }
    updateTimelineWeights();
    renderTimelineUI();
    /* 系统开了「减弱动态效果」就不自动播：
     * 这是一段九秒、全屏球体跟着动的动画，正是那个设置想拦下来的东西。
     * 打开后停在开头，想看得自己按空格。 */
    var still = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    setTimelinePlaying(autoplay !== false && !still);
    announce(still
      ? '时间轴：已按系统「减弱动态效果」停在开头，按空格开始回放，左右方向键微调，Esc 退出'
      : '时间轴回放：从头开始，共 ' + COUNT + ' 段记忆。左右方向键微调，空格暂停，Esc 退出');
  }

  function closeTimeline() {
    if (!tlOn) return;
    tlOn = false;
    tlPlaying = false;
    document.body.classList.remove('tl-open');
    if (timelineEl) timelineEl.hidden = true;
    if (timelineBtnEl) {
      timelineBtnEl.classList.remove('is-on');
      timelineBtnEl.setAttribute('aria-pressed', 'false');
      timelineBtnEl.setAttribute('aria-expanded', 'false');
    }
    // 回到常态：所有神经元重新满亮
    for (var i = 0; i < COUNT; i++) tlWeight[i] = 1;
    announce('退出时间轴，回到现在');
  }

  function setTimelinePlaying(on) {
    tlPlaying = !!on;
    syncPlayIcon();
    if (tlPlaying && tlT >= 0.999) tlT = 0;    // 播完了再点就重来
  }

  function seekTimeline(v) {
    tlT = clamp(v, 0, 1);
    updateTimelineWeights();
    renderTimelineUI();
  }

  if (timelineBtnEl) {
    timelineBtnEl.addEventListener('click', function (e) {
      e.stopPropagation();
      if (tlOn) closeTimeline(); else openTimeline(true);
    });
  }
  if (tlCloseEl) tlCloseEl.addEventListener('click', function (e) { e.stopPropagation(); closeTimeline(); });
  if (tlPlayEl) {
    tlPlayEl.addEventListener('click', function (e) {
      e.stopPropagation();
      setTimelinePlaying(!tlPlaying);
    });
  }
  if (tlRangeEl) {
    tlRangeEl.addEventListener('input', function () {
      setTimelinePlaying(false);
      seekTimeline(parseInt(tlRangeEl.value, 10) / 1000);
    });
  }

  /* ------------------------------------------------------------------
   * 21. 声音开关
   * ------------------------------------------------------------------ */
  if (soundBtn) {
    /* 有没有东西可静音？
     * 音景（SOUND_AMBIENCE）默认关着，开源发行版里也没有配乐文件，
     * 于是这个按钮点下去只会走到 `return` —— 摆一个按了没反应的控件，
     * 比不摆更糟。真没有可发声的东西时直接收起来；
     * 用户自己加了配乐或打开音景，按钮会自动出现。 */
    var soundAvailable = (window.SOUND_AMBIENCE === true) ||
      !!(MUSIC && typeof MUSIC.count === 'function' && MUSIC.count() > 0);
    if (!soundAvailable) {
      soundBtn.hidden = true;
      soundBtn.setAttribute('aria-hidden', 'true');
      soundBtn.tabIndex = -1;
      soundBtn.setAttribute('title', '当前没有可播放的声音');
    }

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
    // 语义布局下脑区锥体已经和 tag 对不上了，就不要再按区染色，免得亮错地方
    var byRegion = highlightTag >= 0 && layoutMode === 'tag';
    for (var i = 0; i < n; i++) {
      var r = scRegion[i];
      scGlow[i] = !byRegion
        ? scBaseGlow[i]
        : (r === highlightTag ? scBaseGlow[i] * 2.1 : scBaseGlow[i] * 0.32);
    }
    scGeo.attributes.aGlow.needsUpdate = true;
  }

  var clusterBtns = [];
  var pinnedTag = -1;

  function setClusterPressed(active) {
    for (var i = 0; i < clusterBtns.length; i++) {
      clusterBtns[i].setAttribute('aria-pressed', i === active ? 'true' : 'false');
    }
  }

  (function buildClusterNav() {
    if (!clusterNavEl) return;
    for (var t = 0; t < TAG_NAMES.length; t++) {
      // 用 button 而不是 div：Tab 能到、回车能按、读屏会念"按钮，已按下"
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'cluster-item';
      item.setAttribute('aria-pressed', 'false');
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
      item.setAttribute('aria-label', '脑区 ' + TAG_NAMES[t] + '，' + TAG_MEMBERS[t].length + ' 段记忆');

      (function (idx, el) {
        el.addEventListener('pointerenter', function () {
          highlightTag = idx;
          applyHighlight();
          el.classList.add('is-hot');
        });
        el.addEventListener('pointerleave', function () {
          if (highlightTag === idx) highlightTag = pinnedTag;
          applyHighlight();
          el.classList.remove('is-hot');
        });
        // 点一下就把这个脑区钉住，其余记忆沉下去；再点取消
        el.addEventListener('click', function () {
          pinnedTag = (pinnedTag === idx) ? -1 : idx;
          highlightTag = pinnedTag;
          applyHighlight();
          setClusterPressed(pinnedTag);
          announce(pinnedTag < 0
            ? '已取消脑区筛选'
            : '只看脑区「' + TAG_NAMES[idx] + '」，' + TAG_MEMBERS[idx].length + ' 段记忆');
        });
      })(t, item);

      clusterBtns.push(item);
      clusterNavEl.appendChild(item);
    }
  })();

  /* ------------------------------------------------------------------
   * 22.1 记忆索引：键盘与读屏用户唯一走得通的内容入口
   *   画布是纯视觉的，读屏读不出任何记忆。这里把全部记忆铺成真正的
   *   按钮：Tab/方向键选、Enter 读、Esc 退回，焦点永远有地方落。
   * ------------------------------------------------------------------ */
  var drawerEl = document.getElementById('memDrawer');
  var memListEl = document.getElementById('memList');
  var indexBtnEl = document.getElementById('indexBtn');
  var drawerCloseEl = document.getElementById('memDrawerClose');
  var drawerMetaEl = document.getElementById('memDrawerMeta');
  var liveEl = document.getElementById('liveRegion');

  var drawerOpen = false;
  var drawerFocusBack = null;
  var lastFocusEl = null;
  var memButtons = [];

  var liveTimer = 0;
  function announce(msg) {
    if (!liveEl) return;
    // 连说两句一样的话，读屏默认不重播；先清空再写
    if (liveTimer) clearTimeout(liveTimer);
    liveEl.textContent = '';
    liveTimer = window.setTimeout(function () {
      liveEl.textContent = msg;
      liveTimer = 0;
    }, 60);
  }

  (function buildMemList() {
    if (!memListEl) return;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < COUNT; i++) {
      var m = MEMORIES[i];
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'mem-item';
      b.setAttribute('data-i', String(i));

      var num = document.createElement('span');
      num.className = 'mem-num';
      num.textContent = pad2(i + 1);

      var body = document.createElement('span');
      body.className = 'mem-body';
      var ti = document.createElement('span');
      ti.className = 'mem-title';
      ti.textContent = m.title;
      var sub = document.createElement('span');
      sub.className = 'mem-sub';
      sub.textContent = m.date ? (m.tag + ' · ' + m.date) : m.tag;
      body.appendChild(ti);
      body.appendChild(sub);

      b.appendChild(num);
      b.appendChild(body);
      b.setAttribute('aria-label',
        '第 ' + (i + 1) + ' 段，' + m.title + '，' + (m.date ? m.tag + '，' + m.date : m.tag));

      li.appendChild(b);
      frag.appendChild(li);
      memButtons.push(b);
    }
    memListEl.appendChild(frag);
    if (drawerMetaEl) drawerMetaEl.textContent = COUNT + ' 段';
  })();

  if (memListEl) {
    memListEl.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.mem-item') : null;
      if (!btn) return;
      var at = parseInt(btn.getAttribute('data-i'), 10);
      // 连线态下，目录里按回车/点击的语义从"打开它"变成"连它"
      if (linkMode >= 0) { doLink(at); return; }
      openPanel(at);
    });

    memListEl.addEventListener('keydown', function (e) {
      var k = e.key;
      if (k !== 'ArrowDown' && k !== 'ArrowUp' && k !== 'Home' && k !== 'End') return;
      var at = memButtons.indexOf(document.activeElement);
      if (at < 0) at = 0;
      var next = at;
      if (k === 'ArrowDown') next = Math.min(memButtons.length - 1, at + 1);
      else if (k === 'ArrowUp') next = Math.max(0, at - 1);
      else if (k === 'Home') next = 0;
      else next = memButtons.length - 1;
      e.preventDefault();
      if (memButtons[next]) memButtons[next].focus();
    });
  }

  function markActiveMem() {
    for (var i = 0; i < memButtons.length; i++) {
      memButtons[i].classList.toggle('is-active', i === selected);
    }
  }

  // 搜索时列表跟着一起明暗，屏幕上看球、键盘上走列表，两边对得上
  function syncMemListFilter(hitIndexes) {
    if (!memButtons.length) return;
    var on = !!hitIndexes;
    var set = {};
    if (on) for (var k = 0; k < hitIndexes.length; k++) set[hitIndexes[k]] = 1;
    for (var i = 0; i < memButtons.length; i++) {
      memButtons[i].classList.toggle('is-hit', on && !!set[i]);
      memButtons[i].classList.toggle('is-dim', on && !set[i]);
    }
  }

  function openDrawer() {
    if (!drawerEl || drawerOpen) return;
    drawerOpen = true;
    drawerFocusBack = document.activeElement;
    drawerEl.removeAttribute('inert');
    drawerEl.setAttribute('aria-hidden', 'false');
    drawerEl.classList.add('is-open');
    document.body.classList.add('drawer-open');
    if (indexBtnEl) indexBtnEl.setAttribute('aria-expanded', 'true');
    markActiveMem();
    var go = memButtons[selected >= 0 ? selected : 0];
    if (go) go.focus({ preventScroll: true });
    announce('记忆索引，共 ' + COUNT + ' 段');
  }

  function closeDrawer(refocus) {
    if (!drawerEl || !drawerOpen) return;
    drawerOpen = false;
    var hadFocus = drawerEl.contains(document.activeElement);
    drawerEl.classList.remove('is-open');
    document.body.classList.remove('drawer-open');
    drawerEl.setAttribute('aria-hidden', 'true');
    drawerEl.setAttribute('inert', '');
    if (indexBtnEl) indexBtnEl.setAttribute('aria-expanded', 'false');
    if (refocus && hadFocus) {
      var back = drawerFocusBack;
      // body 不算"焦点落点"，聚焦它等于什么都没做
      if (!back || back === document.body || !document.contains(back)) back = indexBtnEl;
      if (back && typeof back.focus === 'function') back.focus({ preventScroll: true });
    }
  }

  if (indexBtnEl) {
    indexBtnEl.addEventListener('click', function () {
      if (drawerOpen) closeDrawer(true);
      else openDrawer();
    });
  }

  if (drawerCloseEl) {
    drawerCloseEl.addEventListener('click', function () { closeDrawer(true); });
  }

  // 按 L 直接翻目录（输入框里打字时不抢键）
  window.addEventListener('keydown', function (e) {
    if (e.key !== 'l' && e.key !== 'L') return;
    if (lbOpen) return;                 // 照片全屏在开会把键让给它
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
    e.preventDefault();
    if (drawerOpen) closeDrawer(true);
    else openDrawer();
  });

  // 按 R 回正：转晕了、钻进球里出不来的时候，一个键退回去
  window.addEventListener('keydown', function (e) {
    if (e.key !== 'r' && e.key !== 'R') return;
    if (lbOpen) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
    e.preventDefault();
    resetView();
  });

  // 按 T 开时间轴；开着的时候空格暂停、左右微调（和视频播放器的习惯一致）
  window.addEventListener('keydown', function (e) {
    var a = document.activeElement;
    var typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);

    if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && !lbOpen && (e.key === 't' || e.key === 'T')) {
      e.preventDefault();
      if (tlOn) closeTimeline(); else openTimeline(true);
      return;
    }
    if (!tlOn || typing) return;
    /* 面板或抽屉开着时不接方向键 / 空格：
     * 面板里的 ← → 是翻照片，索引里的 ↑ ↓ 是选条目，
     * 两边都响应的话一次按键会干两件事（这个坑先踩过一次）。 */
    if (selected >= 0 || drawerOpen) return;

    if (e.key === ' ') {
      e.preventDefault();
      setTimelinePlaying(!tlPlaying);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setTimelinePlaying(false);
      seekTimeline(tlT - 0.02);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setTimelinePlaying(false);
      seekTimeline(tlT + 0.02);
    }
  });


  /* ------------------------------------------------------------------
   * 22.2 语义搜索：输几个字，把相关的那几颗点亮，其余的退到背景里
   *   不联网、不加载模型，靠 js/semantic.js 的 TF-IDF 向量
   * ------------------------------------------------------------------ */
  var searchInputEl = document.getElementById('searchInput');
  var searchWrapEl = searchInputEl ? searchInputEl.parentNode : null;
  var layoutBtnEl = document.getElementById('layoutBtn');
  var countLabelEl = document.querySelector('.count i');

  var searchOn = false;
  var searchHits = [];
  var searchWeight = new Float32Array(COUNT);
  (function () { for (var i = 0; i < COUNT; i++) searchWeight[i] = 1; })();

  function setFooterCount(n, label) {
    if (memCount) memCount.textContent = String(n);
    if (countLabelEl) countLabelEl.textContent = label;
  }

  function clearSearch() {
    searchOn = false;
    searchHits = [];
    for (var i = 0; i < COUNT; i++) searchWeight[i] = 1;
    setFooterCount(COUNT, '个神经元正在放电');
    if (searchWrapEl) searchWrapEl.classList.remove('has-query');
    syncMemListFilter(null);
  }

  function runSearch(raw) {
    var q = (raw || '').trim();
    if (!q || !SEM || !semIndex) { clearSearch(); return; }

    var hits;
    try { hits = SEM.search(semIndex, q, { topK: COUNT, minScore: 0.05 }); } catch (e) { hits = []; }

    // 再砍一刀：低于最高分 35% 的都算噪声（二元分词偶尔会因为一个通用字凑上分）
    if (hits.length > 1) {
      var floor = hits[0].score * 0.35;
      hits = hits.filter(function (h) { return h.score >= floor; });
    }

    searchHits = hits;
    searchOn = hits.length > 0;

    var i;
    for (i = 0; i < COUNT; i++) searchWeight[i] = searchOn ? 0.12 : 1;

    if (searchOn) {
      var top = hits[0].score > 0 ? hits[0].score : 1;
      for (i = 0; i < hits.length; i++) {
        // 越靠前越亮，但别让第一名把其余命中全压死
        var rel = clamp(hits[i].score / top, 0, 1);
        searchWeight[hits[i].index] = 1.15 + rel * 0.8;
      }
    }

    if (searchOn) setFooterCount(hits.length, '段记忆命中');
    else setFooterCount(0, '段记忆命中');
    if (searchWrapEl) searchWrapEl.classList.add('has-query');

    // 索引列表跟着一起明暗，读屏也能听见结果数
    var idxs = [];
    for (i = 0; i < hits.length; i++) idxs.push(hits[i].index);
    syncMemListFilter(searchOn ? idxs : null);
    announce(searchOn ? hits.length + ' 段记忆命中' : '没有匹配的记忆');
  }
  if (searchInputEl) {
    var searchTimer = 0;
    searchInputEl.addEventListener('input', function () {
      // 中文输入法还没上屏时不要检索
      if (searchInputEl.isComposing) return;
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        searchTimer = 0;
        runSearch(searchInputEl.value);
      }, 140);
    });

    searchInputEl.addEventListener('compositionend', function () {
      if (searchTimer) clearTimeout(searchTimer);
      runSearch(searchInputEl.value);
    });

    searchInputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        searchInputEl.value = '';
        clearSearch();
        searchInputEl.blur();
      } else if (e.key === 'Enter' && searchHits.length) {
        openPanel(searchHits[0].index);   // 回车直接读最相关的那条
        if (VIEW_NARROW()) searchInputEl.blur();
      }
    });

    // 敲 "/" 就能开始搜（和大多数工具的习惯一致）
    window.addEventListener('keydown', function (e) {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      var a = document.activeElement;
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
      e.preventDefault();
      searchInputEl.focus();
      searchInputEl.select();
    });
  }

  if (layoutBtnEl) {
    if (!SEM || !semIndex) {
      layoutBtnEl.disabled = true;
      layoutBtnEl.title = '语义层未加载';
      layoutBtnEl.style.opacity = '0.35';
    } else {
      layoutBtnEl.addEventListener('click', function () {
        var next = layoutMode === 'tag' ? 'semantic' : 'tag';
        applyLayout(next);
        var sem = layoutMode === 'semantic';
        layoutBtnEl.setAttribute('aria-pressed', sem ? 'true' : 'false');
        layoutBtnEl.classList.toggle('is-on', sem);
        layoutBtnEl.title = sem
          ? '语义布局中：内容相近的记忆挨在一起（再点回到标签布局）'
          : '按语义重新排布星图';
        // 重新排布后整体形状变了，稍微拉远一点才看得全
        camDistTarget = clamp(
          sem ? CFG.cameraDistance * 1.16 : CFG.cameraDistance,
          CFG.cameraMin, CFG.cameraMax
        );
      });
    }
  }

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

  /* 底部那行提示有球外、球内两种说法，每种再分鼠标和手指两版。
   * 这两句原本各自内联在下面，球内那句漏了「按 L」——
   * 进过球再退出来的人，从此就再也看不到唯一的键盘入口了。
   * 收到常量里之后，两条路都带着它。
   *
   * 手机上不能照念：没有滚轮、没有键盘，「滚轮推拉」「按 L」
   * 都是做不到的事。改成双指缩放和"轻点"，索引按钮就在右上角。 */
  var HINT_OUT = COARSE
    ? '拖动转动这颗球　·　双指缩放　·　轻点神经元读取记忆'
    : '拖动转动这颗球　·　滚轮推拉视角　·　点击神经元读取记忆　·　按 L 打开记忆索引';
  var HINT_IN = COARSE
    ? '已在球体内部　·　双指捏合或双击空白退出去　·　轻点附近的神经细胞'
    : '已在球体内部　·　滚轮向外退出，或按 R 回正面　·　点击附近的神经细胞　·　按 L 打开记忆索引';

  function updateInsideHint(force) {
    if (!hintEl) return;
    var inBall = camDist < CFG.R * 0.92;
    if (!force && inBall === lastInBall) return;
    lastInBall = inBall;
    hintEl.textContent = inBall ? HINT_IN : HINT_OUT;
  }

  /* HTML 里写死的是桌面那句。
   * 只在"进出球体"这种状态翻转时才写，所以手机上一辈子都不会被换掉。
   * 开机先强制写一次。 */
  updateInsideHint(true);

  /* ------------------------------------------------------------------
   * 22.9 第一次来访：只说三个最不容易被发现的键
   *   现在有十三项能力，而底部那行字讲的只是鼠标能做的事：
   *   没人知道 `T` 能让这些年重走一遍，也没人知道 `/` 能搜。
   *   所以第一次打开时补一条，只讲三个键，八秒后退场。
   *
   *   不做成常驻浮层，也不做成多步导览：
   *   多一个常驻元素就多一处要跟时间轴、面板、索引抢地方的东西，
   *   而这种提示看第二遍就是噪音。
   * ------------------------------------------------------------------ */
  var COACH_KEY = 'sea.coach.v1';
  var COACH_MS = 8000;
  var coachEl = document.getElementById('coach');
  var coachCloseEl = document.getElementById('coachClose');
  var coachHideTimer = 0;
  var coachCollectTimer = 0;

  /* 手指上没有 T / / / L 这三个键。
   * 这几件事在手机上都有按钮（右上角的时钟、搜索框、列表），
   * 所以把「按键」换成「按哪个位置」——不然这条提示看完也用不上。 */
  (function tuneCoachForTouch() {
    if (!COARSE || !coachEl) return;
    var items = coachEl.querySelectorAll('.coach-item');
    var words = ['点右上角时钟回放这些年', '搜一段记忆', '点 ☰ 翻全部'];
    for (var i = 0; i < items.length && i < words.length; i++) {
      items[i].textContent = words[i];     // 顺带把 <kbd> 一起去掉
    }
  })();

  function coachSeen() {
    try { return window.localStorage.getItem(COACH_KEY) === '1'; }
    catch (e) { return true; }    // 存不住就别打扰，宁可少说一句
  }

  function hideCoach() {
    if (!coachEl) return;
    clearTimeout(coachHideTimer);
    coachEl.classList.remove('is-on');
    // 等淡出走完再真正收起来，否则会"啪"地一下不见
    coachCollectTimer = setTimeout(function () {
      if (!coachEl.classList.contains('is-on')) coachEl.hidden = true;
    }, 480);
  }

  function showCoach(ms) {
    if (!coachEl) return;
    clearTimeout(coachCollectTimer);
    coachEl.hidden = false;
    // 先让 display 生效，下一帧再加类，否则过渡不会触发
    requestAnimationFrame(function () { coachEl.classList.add('is-on'); });
    clearTimeout(coachHideTimer);
    coachHideTimer = setTimeout(hideCoach, ms || COACH_MS);
  }

  function showCoachOnce() {
    if (coachSeen()) return;
    // 显示就算讲过了：八秒内刷新一次不该再来一遍
    try { window.localStorage.setItem(COACH_KEY, '1'); } catch (e) { }
    showCoach();
  }

  /* 什么时候可以讲了：球已经画出来 + 人没被锁在门外。
   * 不能直接挂在 tick 的首帧判断上 —— 开了锁屏的人，首帧会被
   * isLocked() 那个分支消费掉（它要先把启动遮罩收起来），
   * 于是这条提示对设了密码的人永远不会出现。这里改成两个条件各自满足都能触发。 */
  var coachDone = false;

  function armCoach(delay) {
    setTimeout(function () {
      if (coachDone) return;
      if (typeof isLocked === 'function' && isLocked()) return;   // 还锁着，等 unlock 再叫一次
      coachDone = true;
      showCoachOnce();
    }, delay == null ? 700 : delay);
  }

  document.addEventListener('sea:unlock', function () {
    if (!coachDone) armCoach(500);
  });

  if (coachCloseEl) {
    coachCloseEl.addEventListener('click', function (e) {
      e.stopPropagation();
      hideCoach();
    });
  }

  // 设置面板里的「再看一次」走这里（lock.js 不直接碰这套状态）
  window.SeaCoach = {
    replay: function () { showCoach(); },
    hide: hideCoach
  };

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

  /* 触摸和鼠标不是一回事：
   * 手指落点比鼠标抖得多，6px 的"算拖动了"阈值会让轻点经常变成拖动，
   * 于是照片点不开。触摸放宽到 14px，鼠标保持灵敏。
   * 双指时手指会互相抢状态（第二根手指一按，旋转量就跳一下），
   * 所以按下两根以上就关掉单指旋转，改走缩放。 */
  var downPointerId = -1;
  var downIsTouch = false;
  var activePointers = {};     // pointerId -> { x, y }
  var activeCount = 0;
  var pinching = false;
  var pinchStartDist = 0;
  var pinchStartCam = 0;
  /* 双击空白回正。触屏上没有 R 键，双击是手机上唯一腾得出手势；
   * 但双击的第一下还要照常关面板，所以这里只记"上一次空白轻点"的时间和位置。 */
  var lastEmptyTap = { t: 0, x: 0, y: 0 };
  var DOUBLE_TAP_MS = 340;
  var DOUBLE_TAP_SLOP = 44;

  function setNdc(clientX, clientY) {
    cursorX = clientX;
    cursorY = clientY;
    ndc.x = (clientX / viewW) * 2 - 1;
    ndc.y = -(clientY / viewH) * 2 + 1;
  }

  function trackPointer(e) {
    if (!activePointers[e.pointerId]) activeCount++;
    activePointers[e.pointerId] = { x: e.clientX, y: e.clientY };
  }

  function untrackPointer(id) {
    if (activePointers[id]) {
      delete activePointers[id];
      activeCount = Math.max(0, activeCount - 1);
    }
  }

  /* 两端手指中心的距离 —— 缩放只看这个 */
  function pinchDistance() {
    var ids = Object.keys(activePointers);
    if (ids.length < 2) return 0;
    var a = activePointers[ids[0]], b = activePointers[ids[1]];
    var dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function beginPinch() {
    var d = pinchDistance();
    if (d < 8) return;
    pinching = true;
    pinchStartDist = d;
    pinchStartCam = camDistTarget;
    down = false;
    dragged = true;          // 双指之后抬手不算点击
    canvas.classList.remove('is-grabbing');
  }

  canvas.addEventListener('pointerdown', function (e) {
    wakeAudio();
    trackPointer(e);

    if (activeCount >= 2) { beginPinch(); return; }

    down = true;
    dragged = false;
    downPointerId = e.pointerId;
    downIsTouch = e.pointerType === 'touch';
    downX = e.clientX; downY = e.clientY;
    lastMoveX = e.clientX; lastMoveY = e.clientY;
    dragAccum = 0;
    setNdc(e.clientX, e.clientY);
    // 手指没有"悬停"这回事，别让光标光晕跟着指头亮
    pointerActive = !downIsTouch;
    canvas.classList.add('is-grabbing');
    // 某些环境下这个指针已经不可捕获（例如事件是合成出来的），
    // 抛出来会把整个 pointerdown 打断，拖都拖不动。失败就退化成不捕获。
    if (canvas.setPointerCapture) {
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 不捕获也能拖 */ }
    }
  });

  window.addEventListener('pointermove', function (e) {
    if (activePointers[e.pointerId]) trackPointer(e);

    if (pinching) {
      var d = pinchDistance();
      if (d > 8 && pinchStartDist > 8) {
        // 手指张开 = 凑近看：距离变大，相机拉近。
        // 上限取"当前这次捏合的起点"，否则在手机上面板把球推远腾屏，
        // 两指刚落下就会被拉回 30，画面平白跳一下。
        var maxD = Math.max(camMaxDist(), pinchStartCam);
        camDistTarget = clamp(pinchStartCam * (pinchStartDist / d), CFG.cameraMin, maxD);
      }
      return;
    }

    if (down && e.pointerId === downPointerId) {
      // 回正途中又上手了：人的意图变了，立刻交出控制权
      spinHome = false;
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
      var slop = downIsTouch ? 14 : 6;
      if (dx * dx + dy * dy > slop * slop) dragged = true;
      dragAccum += Math.abs(mx) + Math.abs(my);
      lastMoveX = e.clientX; lastMoveY = e.clientY;
    }

    if (!downIsTouch || down) {
      setNdc(e.clientX, e.clientY);
      if (!downIsTouch) pointerActive = true;
    }
  }, { passive: true });

  function endPointer(e, cancelled) {
    untrackPointer(e.pointerId);

    if (pinching) {
      // 松开一根手指，剩下的那根不该接着转动球
      if (activeCount < 2) { pinching = false; down = false; }
      canvas.classList.remove('is-grabbing');
      if (downIsTouch) pointerActive = false;
      return;
    }

    if (!down || e.pointerId !== downPointerId) {
      if (downIsTouch) pointerActive = false;
      return;
    }

    down = false;
    canvas.classList.remove('is-grabbing');
    if (downIsTouch) pointerActive = false;
    else setNdc(e.clientX, e.clientY);

    if (cancelled || dragged) return;

    var hit = pick(e.clientX, e.clientY);
    if (linkMode >= 0) {
      // 连线态：点中谁就连谁；点空白算放弃
      if (hit >= 0) doLink(hit);
      else setLinkMode(false);
      return;
    }
    if (hit >= 0) {
      // 点了节点就不算"连着两下空白"，免得点完这颗再点空白就跳回去
      lastEmptyTap.t = 0;
      openPanel(hit);
    } else {
      var tapMs = (window.performance && performance.now) ? performance.now() : Date.now();
      if (tapMs - lastEmptyTap.t < DOUBLE_TAP_MS &&
          Math.abs(e.clientX - lastEmptyTap.x) < DOUBLE_TAP_SLOP &&
          Math.abs(e.clientY - lastEmptyTap.y) < DOUBLE_TAP_SLOP) {
        lastEmptyTap.t = 0;
        resetView();
        return;
      }
      lastEmptyTap.t = tapMs;
      lastEmptyTap.x = e.clientX;
      lastEmptyTap.y = e.clientY;
      closePanel();
    }
  }

  window.addEventListener('pointerup', function (e) { endPointer(e, false); });
  window.addEventListener('pointercancel', function (e) { endPointer(e, true); });

  window.addEventListener('pointerleave', function () {
    pointerActive = false;
    hovered = -1;
    canvas.classList.remove('is-hover');
  });

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    var maxD = Math.max(camMaxDist(), camDistTarget);
    camDistTarget = clamp(camDistTarget + e.deltaY * 0.02, CFG.cameraMin, maxD);
  }, { passive: false });

  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  /* ------------------------------------------------------------------
   * 23.1 抽屉往下拉就收起来
   *
   *   面板顶上画了一道横杠。画了横杠就是承诺"能拉"，
   *   手指按上去往下拖却纹丝不动，比不画还糟。
   *   这里只认顶部 64px 那条（横杠 + 编号那行），
   *   避开关闭按钮和下面的正文滚动。
   * ------------------------------------------------------------------ */
  var sheetDrag = null;

  panelEl.addEventListener('pointerdown', function (e) {
    if (viewW > 760) return;                      // 桌面是右侧栏，没有"下拉"
    if (e.pointerType !== 'touch') return;
    if (!panelEl.classList.contains('is-open')) return;
    if (e.target && e.target.closest && e.target.closest('button, a, input, label')) return;

    var box = panelEl.getBoundingClientRect();
    if (e.clientY - box.top > 64) return;

    sheetDrag = { id: e.pointerId, y0: e.clientY, dy: 0, t0: Date.now(), h: box.height };
    panelEl.style.transition = 'none';
  });

  window.addEventListener('pointermove', function (e) {
    if (!sheetDrag || e.pointerId !== sheetDrag.id) return;
    var dy = Math.max(0, e.clientY - sheetDrag.y0);
    sheetDrag.dy = dy;
    panelEl.style.transform = 'translate3d(0,' + dy + 'px,0)';
  }, { passive: true });

  /* 光有 pointerdown 不够。
   * 手指在可滚动的列表上垂直拖，浏览器会判定成"滚动"，
   * 先发 pointercancel 把手势收走，再自己滚 —— 于是拉手刚按下就被取消，
   * 面板纹丝不动，看起来像根本没实现。
   * 拉手一旦激活，就由我们把 touchmove 吃掉，滚动不会启动，
   * pointercancel 也就不会来。 */
  panelEl.addEventListener('touchmove', function (e) {
    if (sheetDrag && e.cancelable) e.preventDefault();
  }, { passive: false });

  function releaseSheet(e, cancelled) {
    if (!sheetDrag || (e && e.pointerId !== sheetDrag.id)) return;
    var dy = sheetDrag.dy;
    var elapsed = Math.max(1, Date.now() - sheetDrag.t0);
    var flick = dy / elapsed > 0.6;               // px/ms：快速一甩
    var threshold = Math.min(sheetDrag.h * 0.26, 160);
    sheetDrag = null;

    panelEl.style.transition = '';
    // 甩一下也算关，但至少得真的拉下来一截。
    // 只看速度的话，40px 的小抖动也能算出"极快"，手感上会变得一碰就掉。
    if (!cancelled && (dy > threshold || (flick && dy > 70))) {
      // 先关（类一撤就朝屏幕外 animate），此时 inline transform 还停在手指位置，
      // 动画从当前位置接着走，不会先跳回原位再滑出去。
      closePanel();
      setTimeout(function () { panelEl.style.transform = ''; }, 600);
    } else {
      panelEl.style.transform = '';               // 交给 CSS 过渡自己弹回去
    }
  }

  window.addEventListener('pointerup', function (e) { releaseSheet(e, false); });
  window.addEventListener('pointercancel', function (e) { releaseSheet(e, true); });

  /* ------------------------------------------------------------------
   * 24. 尺寸 / 自适应
   * ------------------------------------------------------------------ */
  function refreshPixelScale() {
    var ps = perspectiveScale();
    for (var i = 0; i < glowMats.length; i++) glowMats[i].uniforms.uPixelScale.value = ps;
  }

  function resize() {
    var prevW = viewW;
    viewW = window.innerWidth;
    viewH = window.innerHeight;
    camera.aspect = viewW / viewH;
    camera.updateProjectionMatrix();
    renderer.setSize(viewW, viewH, false);
    refreshPixelScale();
    panelShiftTarget = (selected >= 0 && viewW > 760) ? 1 : 0;
    panelLiftTarget = (selected >= 0 && viewW <= 760) ? 1 : 0;

    // 横竖屏切换等于换了一台设备：手机上车时被允许的最大距离比桌面近得多，
    // 不夹一下就会卡在"比这个宽度能给的还远"的位置，球缩成一颗豆。
    if (viewW !== prevW) {
      camDistTarget = Math.min(camDistTarget, Math.max(camMaxDist(), camDistTarget));
      if (selected >= 0) refitPanelCamera();
    }
  }

  /* 面板打开时把球塞进上面那块空地 —— 打开时算一次，转屏后要重算。
   * 否则竖屏转横屏，空地高度翻倍，球还按竖屏的距离缩着。 */
  function refitPanelCamera() {
    if (viewW <= 760) {
      var rect = panelEl.getBoundingClientRect();
      var sheetH = rect.height || viewH * 0.66;
      var freeH = Math.max(140, viewH - sheetH);
      var tanHalf = Math.tan(CFG.cameraFov * Math.PI / 360);
      camDistTarget = clamp(CFG.R * viewH / (tanHalf * freeH * 0.92), CFG.cameraDistance, 56);
      panelLiftDist = (sheetH / viewH) * tanHalf * camDistTarget;
    }
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
      // 锁着也要先把启动遮罩收起来。这里同样 arm 一次：
      // 700ms 后发现还锁着会自己退回去，等 unlock 事件再补，
      // 免得"是不是首帧"决定这条提示对设了密码的人存不存在。
      if (firstFrame) { firstFrame = false; bootEl.classList.add('is-hidden'); armCoach(700); }
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
    updateMyLinks();          // 手连的线：端点在动，几何得跟着重算
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
      // 等遮罩淡完再讲，别让提示叠在启动画面上
      armCoach(700);
    }
  }

  /* ------------------------------------------------------------------
   * 26. 调试出口（?debug=1）
   * ------------------------------------------------------------------ */
  function diagnostics() {
    return {
      ok: true,
      particles: COUNT,
      truncated: TRUNCATED,
      regions: TAG_NAMES.length,
      scaffold: scRegion.length,
      links: linkCount,
      myLinks: myLinks.length,
      myLinksDropped: myLinksDropped,
      linking: linkMode,
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
      reset: resetView,
      // 回正有没有走完：测试要确认球真的停了，不是"点了没反应"
      homing: function () { return { on: spinHome, spin: [spinX, spinY] }; },
      // 照片全屏的状态：缩放和位移都藏在 style 里，测试不该去正则拆字符串
      lightbox: function () {
        return {
          open: lbOpen, at: lbAt, zoom: lbZoom, x: lbX, y: lbY,
          count: gallery.length, avail: { w: lbAvail.w, h: lbAvail.h },
          w: lbImg.clientWidth, h: lbImg.clientHeight,
          loaded: lbImg.classList.contains('is-loaded')
        };
      },
      memories: MEMORIES,
      regions: TAG_NAMES,
      camera: camera,
      field: field,
      pos: posArr,
      fire: fire,
      myLinks: function () { return myLinks.slice(); },
      startLink: setLinkMode,
      linkTo: doLink,
      unlink: doUnlink,
      linkMode: function () { return linkMode; },
      mlink: function () {
        return {
          links: myLinks.length,
          range: mlinkGeo.drawRange.count,             // 实际绘制的索引数
          perLink: MTUB_STEPS * MTUB_RADIAL * 6,
          verts: mlinkGeo.attributes.position.count
        };
      },
      mem: function () { return MEMORIES; },
      syncLinks: syncMyLinks,
      // 测试用：目标位置与布局模式。粒子靠弹簧趋近 homeArr，
      // 只看 posArr 会被过渡过程干扰，判断"布局切没切"必须看这里。
      homes: function () { return Array.prototype.slice.call(homeArr); },
      timeline: function () {
        return {
          on: tlOn, playing: tlPlaying, t: tlT, settled: tlSettled,
          weights: Array.prototype.slice.call(tlWeight),
          year: new Date(tlNowMs()).getFullYear()
        };
      },
      openTimeline: openTimeline,
      closeTimeline: closeTimeline,
      seekTimeline: seekTimeline,
      glow: function (i) { return glowArr[i]; },
      // 亮度乘数本身： whisper / flash / 心跳都会改最终亮度，
      // 想判断"时间轴关掉后灯有没有回来"只能看这个，看 glowArr 会被瞬时高光带偏
      glowMul: function (i) { return glowMul[i]; },
      layoutMode: function () { return layoutMode; },
      layout: applyLayout,
      // 相机距离：双指缩放/滚轮都是改 camDistTarget，量的就是它
      cam: function () { return { d: camDistTarget, max: camMaxDist(), min: CFG.cameraMin }; },
      // 手势状态：判断"双指到底有没有被识别"只看这里
      gesture: function () { return { pointers: activeCount, pinching: pinching }; }
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
