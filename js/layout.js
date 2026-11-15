/**
 * 纯逻辑层：几何布点、时间解析、访问痕迹。
 *
 * 从 main.js 里搬出来的原因只有一个 —— 这些代码原来只能靠无头浏览器点着看，
 * 改一个系数要跑十分钟的截图脚本，而且断言还容易写成假阳性。
 * 它们本身不碰 DOM、不碰 THREE、不碰 window，搬出来就能用 node --test 直接验。
 *
 * 约定：
 *  - 不依赖任何外部库。向量用「有 x / y / z 属性的对象」表示。
 *    THREE.Vector3 天然满足，所以 main.js 里可以直接把它的实例当 out 传进来。
 *  - 所有 out 参数都是可选的；给了就写进去并返回同一个对象，减少每帧的临时分配。
 *  - 这里的常数（尤其轴布局的 2.399963）是从 main.js 逐字搬过来的。
 *    不要"顺手美化"成 GOLDEN_ANGLE —— 两者差 2.3e-7，改了一个像素都看不出来，
 *    但会让全库每一条记忆的位置都挪一点，而位置本身是用户认得的东西。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SeaLayout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------------
   * 1. 小工具
   * ------------------------------------------------------------------ */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function fract(x) { return x - Math.floor(x); }

  function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

  function vec(x, y, z) { return { x: x, y: y, z: z }; }

  var GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));   // ≈ 2.39996，斐波那契螺旋的转角
  var AXIS_PHI = 2.399963;                           // 球面轴布局用的转角（main.js 原值）
  var RADIX2 = 0.7548776662466927;                   // 低差异序列常数，用来错开半径

  /* ------------------------------------------------------------------
   * 2. 脑区轴：球面上尽量均匀的 n 个方向
   * ------------------------------------------------------------------ */

  /**
   * n 个近似均匀分布在单位球面上的轴（斐波那契纬度环）。
   * n 个区就按这个顺序占位，再交给 assignAxes 决定"谁是谁"。
   */
  function makeAxes(n, out) {
    var list = out || [];
    list.length = 0;
    for (var i = 0; i < n; i++) {
      var y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2;
      var rad = Math.sqrt(Math.max(0, 1 - y * y));
      var phi = i * AXIS_PHI;
      // y² + rad² = 1，本身已是单位向量，不用再 normalize
      list.push(vec(Math.cos(phi) * rad, y, Math.sin(phi) * rad));
    }
    return list;
  }

  /**
   * 哪个区用哪根轴 —— 按条目数从多到少发轴，每区挑「离已选轴最远」的那根。
   *
   * 按 tag 出现顺序发轴的话，条目最多的两个区常常挨在一起：48 条记忆的时候
   * 「路上」18 条和「房间」11 条的球冠边缘相接，一半节点挤进同一个象限，
   * 球的一边糊成一片、另一边空着。最大的团先站到球的两极，看起来才像球。
   *
   * @param {Array} axes     makeAxes 的结果
   * @param {Array} counts   每个区的条目数（与 axes 同序）
   * @returns {Int32Array}   counts 下标 → axes 下标
   */
  function assignAxes(axes, counts) {
    var n = axes.length;
    var axisOf = new Int32Array(n);

    var order = [];
    for (var i = 0; i < n; i++) order.push(i);
    // 条目多的先挑。sort 是稳定的，所以同数量时保持原顺序，结果可复现。
    order.sort(function (a, b) { return counts[b] - counts[a]; });

    var free = [];
    for (var j = 0; j < n; j++) free.push(j);
    var taken = [];

    for (var k = 0; k < order.length; k++) {
      var tagIdx = order[k];
      var bestK = 0, bestDot = Infinity;
      for (var f = 0; f < free.length; f++) {
        var worst = 0;                       // 和最近的已选轴有多近
        for (var c = 0; c < taken.length; c++) {
          var d = dot(axes[free[f]], axes[taken[c]]);
          if (d > worst) worst = d;
        }
        if (worst < bestDot) { bestDot = worst; bestK = f; }
      }
      taken.push(free[bestK]);
      free.splice(bestK, 1);
      axisOf[tagIdx] = taken[taken.length - 1];
    }
    return axisOf;
  }

  /**
   * 每个区的球冠多大 —— 按条目数分面积。
   *
   * 原来所有区一样大，于是 18 条的记忆塞进和 1 条一样小的冠里：这块密得发白，
   * 那块只有一个孤点。球冠面积正比于 2π(1-cosθ)，所以 cosθ 直接按比例给。
   *
   * coeff 是留缝系数：球冠是圆片，铺不满球面（打包密度够不到 1），
   * 给大了相邻冠会压在一起 —— 实测 1.10 时 200 条才没有跨区撞点。
   *
   * @returns {Float32Array} 每个区的 cosθ，取值 (-1, 1]
   */
  function capCoses(counts, coeff, out) {
    var n = counts.length;
    var coses = out || new Float32Array(n);
    var total = 0;
    for (var i = 0; i < n; i++) total += counts[i];
    for (var j = 0; j < n; j++) {
      var share = total > 0 ? counts[j] / total : 0;
      coses[j] = clamp(1 - coeff * share, -0.98, 1);
    }
    return coses;
  }

  /* ------------------------------------------------------------------
   * 3. 球冠内布点
   * ------------------------------------------------------------------ */

  /** 在轴 a 处建一组切向基 (u, v)，供球冠内取点用 */
  function tangentBasis(a, u, v) {
    u = u || vec(0, 0, 0);
    v = v || vec(0, 0, 0);

    // 轴几乎贴着 y 轴时，用 x 轴当参考才不会退化
    var ux = Math.abs(a.y) > 0.95 ? 1 : 0;
    var uy = Math.abs(a.y) > 0.95 ? 0 : 1;
    var uz = 0;

    // u = normalize(up × a)
    var cx = uy * a.z - uz * a.y;
    var cy = uz * a.x - ux * a.z;
    var cz = ux * a.y - uy * a.x;
    var cl = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
    u.x = cx / cl; u.y = cy / cl; u.z = cz / cl;

    // v = normalize(a × u)
    var vx = a.y * u.z - a.z * u.y;
    var vy = a.z * u.x - a.x * u.z;
    var vz = a.x * u.y - a.y * u.x;
    var vl = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
    v.x = vx / vl; v.y = vy / vl; v.z = vz / vl;

    return v;
  }

  /**
   * 球冠内第 k 个（共 n 个）方向，用斐波那契螺旋而不是 Math.random()。
   *
   * 随机撒点看着自然，但条目一多必然撞车：500 条实测最近邻间距掉到 0.13，
   * 两颗记忆叠成一颗，点不中、也分不清。更要紧的是每次刷新位置都不同，
   * 用户记不住"那条在球的哪一边"——位置本身就是记忆的一部分。
   *
   * @param {number} cosMax  球冠张角的余弦（1 = 只有一点，-1 = 整个球）
   */
  function capPoint(a, u, v, cosMax, k, n, out) {
    out = out || vec(0, 0, 0);
    var cz = 1 - (1 - cosMax) * ((k + 0.5) / n);
    var sr = Math.sqrt(Math.max(0, 1 - cz * cz));
    var ang = k * GOLDEN_ANGLE;
    var ca = Math.cos(ang) * sr;
    var sa = Math.sin(ang) * sr;

    var x = a.x * cz + u.x * ca + v.x * sa;
    var y = a.y * cz + u.y * ca + v.y * sa;
    var z = a.z * cz + u.z * ca + v.z * sa;
    var len = Math.sqrt(x * x + y * y + z * z) || 1;

    out.x = x / len; out.y = y / len; out.z = z / len;
    return out;
  }

  /** 记忆在球内多深：0.30 ~ 0.98 倍半径，用低差异序列错开，别齐刷刷贴一层壳 */
  function radialOf(k) {
    return 0.30 + Math.pow(fract((k + 0.5) * RADIX2), 0.72) * 0.68;
  }

  /**
   * 这颗粒子在哪个脑区的锥体里（球内粒子也算，所以脑区是"从球心到球面"的一束）。
   * 没有一个轴够近就返回 -1 —— 那些是球壳上的背景星，不属于任何区。
   */
  function nearestRegion(axes, x, y, z, minDot) {
    var len = Math.sqrt(x * x + y * y + z * z) || 1;
    var nx = x / len, ny = y / len, nz = z / len;
    var floor = minDot == null ? 0.70 : minDot;
    var best = -1, bestDot = floor;
    for (var i = 0; i < axes.length; i++) {
      var a = axes[i];
      var d = nx * a.x + ny * a.y + nz * a.z;
      if (d > bestDot) { bestDot = d; best = i; }
    }
    return best;
  }

  /* ------------------------------------------------------------------
   * 4. 时间与访问痕迹
   * ------------------------------------------------------------------ */

  var DAY_MS = 86400000;

  /**
   * 把 createdAt 解析成毫秒。认不出来的按"值得给它一个位置"处理：
   * 只有年份就当日历年中，什么都没有就用 now（落在时间轴最右端）。
   */
  function parseTime(str, now) {
    var fallback = now == null ? Date.now() : now;
    if (!str) return fallback;
    var t = Date.parse(str);
    if (isNaN(t)) {
      var y = parseInt(str, 10);
      if (!isNaN(y)) return new Date(y, 6, 1).getTime();
      return fallback;
    }
    return t;
  }

  /**
   * 访问记录按「标题 + 发生日期」索引。
   * 以前只按标题索引，两条同名记忆（比如都叫「雨天」）会共用一份计数，
   * 打开其中一条，另一条也跟着变亮。带上日期就基本不会撞了。
   */
  function usageKey(m) {
    if (!m) return '';
    return (m.title || '') + '\u0001' + (m.createdAt || '');
  }

  /** 「你」和这条记忆的关系，不是记忆本身的日期 */
  function usageLine(u, now, dayMs) {
    if (!u || !u.n) return '';
    var day = dayMs || DAY_MS;
    var t = now == null ? Date.now() : now;
    var days = Math.max(0, Math.floor((t - (u.t || 0)) / day));
    var when = days <= 0 ? '今天' : (days === 1 ? '昨天' : days + ' 天前');
    if (u.n === 1) return '你是第一次翻开这条';
    return '你翻过 ' + u.n + ' 次 · 最近一次 ' + when;
  }

  /** 0.93 ~ 1.34：没打开过的最暗，反复看过的接近上限 */
  function usageStrength(u, now, dayMs) {
    if (!u || !u.n) return 0.93;          // 没被打开过：只是"还没亮起来"，不是惩罚
    var day = dayMs || DAY_MS;
    var t = now == null ? Date.now() : now;
    var visits = Math.min(1, Math.log(1 + u.n) / Math.log(14));
    var fresh = u.t ? clamp(1 - (t - u.t) / (200 * day), 0, 1) : 0;
    return 0.95 + 0.26 * visits + 0.12 * fresh;
  }

  /* ------------------------------------------------------------------
   * 5. 连线与视角
   * ------------------------------------------------------------------ */

  /** 二次贝塞尔取点；bow 把控制点往外推，线就弯成一张弓 */
  function bezierPoint(out, ax, ay, az, bx, by, bz, bow, t) {
    out = out || vec(0, 0, 0);
    var mx = (ax + bx) * 0.5 * (1 + bow);
    var my = (ay + by) * 0.5 * (1 + bow);
    var mz = (az + bz) * 0.5 * (1 + bow);
    var it = 1 - t;
    out.x = it * it * ax + 2 * it * t * mx + t * t * bx;
    out.y = it * it * ay + 2 * it * t * my + t * t * by;
    out.z = it * it * az + 2 * it * t * mz + t * t * bz;
    return out;
  }

  /**
   * 相机最远能退到哪。
   * 桌面 44 看着刚好，手机上同样的距离会把球缩成一颗豆子 ——
   * 竖屏本来就窄，视野只能退这么远，再远就是浪费屏幕。
   */
  function camMaxDist(viewW, cameraMax, mobileMax, breakW) {
    var b = breakW == null ? 760 : breakW;
    var m = mobileMax == null ? 30 : mobileMax;
    return viewW <= b ? Math.min(cameraMax, m) : cameraMax;
  }

  /**
   * 时间轴下这条连线该有多亮：取两端的较小值。
   * 一端还没发生，线就不该整根亮着 —— 那会变成"没有端点的悬空线"。
   * 用较小值而不是平均值，是因为刚淡入的那一头本来就该把线一起带出来。
   */
  function timelineDim(on, wa, wb) {
    if (!on) return 1;
    if (wa == null || wb == null) return 1;
    return wa < wb ? wa : wb;
  }

  return {
    DAY_MS: DAY_MS,
    GOLDEN_ANGLE: GOLDEN_ANGLE,
    RADIX2: RADIX2,

    clamp: clamp,
    fract: fract,
    dot: dot,
    vec: vec,

    makeAxes: makeAxes,
    assignAxes: assignAxes,
    capCoses: capCoses,
    tangentBasis: tangentBasis,
    capPoint: capPoint,
    radialOf: radialOf,
    nearestRegion: nearestRegion,

    parseTime: parseTime,
    usageKey: usageKey,
    usageLine: usageLine,
    usageStrength: usageStrength,

    bezierPoint: bezierPoint,
    camMaxDist: camMaxDist,
    timelineDim: timelineDim
  };
});
