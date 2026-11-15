/**
 * js/layout.js 的单元测试
 * 跑法：node --test
 *
 * 这个文件存在的理由：这些逻辑原来埋在 main.js 里，只能靠无头浏览器点着看。
 * 改一个球冠系数要跑十分钟截图脚本，而且断言很容易写成假阳性
 * （"球转了"其实是自转、"面板没开"其实是输入没送达）。
 *
 * 搬出来之后，这里验的是**不变量**而不是像素：
 * 轴是不是单位向量、冠内的点是不是真在冠里、500 个点的最近邻会不会塌。
 * 这类断言比截图稳，也比截图早一步发现问题。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../js/layout.js');

const EPS = 1e-9;
const len = (v) => Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, L.dot(a, b) / (len(a) * len(b)))));

/* ==================================================================
 * 球面轴布局
 * ================================================================== */

describe('makeAxes —— 把 n 个区铺到球面上', () => {
  it('n=0 返回空表，不报错', () => {
    assert.deepEqual(L.makeAxes(0), []);
  });

  it('n=1 给出一个单位向量', () => {
    const axes = L.makeAxes(1);
    assert.equal(axes.length, 1);
    assert.ok(Math.abs(len(axes[0]) - 1) < EPS);
  });

  it('n=1 时那根轴指向 +x（y 取 0，绕一圈回到起点）', () => {
    const a = L.makeAxes(1)[0];
    assert.ok(Math.abs(a.y) < EPS);
    assert.ok(Math.abs(Math.hypot(a.x, a.z) - 1) < EPS);
  });

  it('每根轴都是单位向量（n=3 / 9 / 12 / 50）', () => {
    for (const n of [3, 9, 12, 50]) {
      const axes = L.makeAxes(n);
      assert.equal(axes.length, n, `n=${n} 数量不对`);
      axes.forEach((a, i) => {
        assert.ok(Math.abs(len(a) - 1) < EPS, `n=${n} 第 ${i} 根不是单位向量`);
      });
    }
  });

  it('相邻两根轴不会重合', () => {
    const axes = L.makeAxes(12);
    for (let i = 0; i < axes.length; i++) {
      for (let j = i + 1; j < axes.length; j++) {
        assert.ok(angle(axes[i], axes[j]) > 0.2,
          `第 ${i} 根和第 ${j} 根几乎重合`);
      }
    }
  });

  it('九个区时，任意两轴夹角不小于 30 度（够散，球才像球）', () => {
    const axes = L.makeAxes(9);
    let minAngle = Infinity;
    for (let i = 0; i < axes.length; i++) {
      for (let j = i + 1; j < axes.length; j++) {
        minAngle = Math.min(minAngle, angle(axes[i], axes[j]));
      }
    }
    assert.ok(minAngle > Math.PI / 6, `最小夹角只有 ${(minAngle * 180 / Math.PI).toFixed(1)} 度`);
  });

  it('同样的 n 反复调用，结果逐位一致（布局是确定的，刷新不变）', () => {
    const a = L.makeAxes(9);
    const b = L.makeAxes(9);
    for (let i = 0; i < a.length; i++) {
      assert.equal(a[i].x, b[i].x);
      assert.equal(a[i].y, b[i].y);
      assert.equal(a[i].z, b[i].z);
    }
  });

  it('可以复用传入的数组，不会越积越多', () => {
    const box = [];
    L.makeAxes(5, box);
    L.makeAxes(3, box);
    assert.equal(box.length, 3);
  });
});

describe('assignAxes —— 谁用哪根轴', () => {
  const axes = L.makeAxes(6);

  it('返回的下标是一个排列：每个轴用一次，不重不漏', () => {
    const map = L.assignAxes(axes, [10, 5, 3, 1, 1, 1]);
    assert.equal(map.length, 6);
    assert.deepEqual(Array.from(map).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  });

  it('条目最多的区先挑，拿到剩余轴里的"最远端"', () => {
    // 第一次挑时还没有任何已选轴，"离已选轴最远"退化成全部打平，所以拿第一根
    const map = L.assignAxes(axes, [100, 1, 1, 1, 1, 1]);
    assert.equal(map[0], 0);
  });

  it('条目最多的两个区不会共用一根轴', () => {
    const map = L.assignAxes(axes, [50, 40, 1, 1, 1, 1]);
    assert.notEqual(map[0], map[1]);
  });

  it('条目最多的两个区之间夹角够大（这是"不再挤在一个象限"的根因）', () => {
    const map = L.assignAxes(axes, [50, 40, 1, 1, 1, 1]);
    const a = axes[map[0]], b = axes[map[1]];
    const deg = angle(a, b) * 180 / Math.PI;
    assert.ok(deg > 60, `最大的两个区只隔 ${deg.toFixed(1)} 度`);
  });

  it('条目数相同时，依次挑"离已选最远"的那根，结果确定可复现', () => {
    // 不是按 0,1,2,3,4,5 顺序发 —— 那正是要避免的"按出现顺序发轴"。
    // 哪怕条目数全相等，也照样跳到最远的轴上，这才散得开。
    const a = L.assignAxes(axes, [5, 5, 5, 5, 5, 5]);
    const b = L.assignAxes(axes, [5, 5, 5, 5, 5, 5]);
    assert.deepEqual(Array.from(a), Array.from(b), '两次结果不一致');
    assert.deepEqual(Array.from(a).sort((x, y) => x - y), [0, 1, 2, 3, 4, 5], '不是排列');
    assert.notDeepEqual(Array.from(a), [0, 1, 2, 3, 4, 5], '退回了按出现顺序发轴');
  });

  it('反复调用结果一致', () => {
    const a = L.assignAxes(axes, [9, 7, 5, 3, 2, 1]);
    const b = L.assignAxes(axes, [9, 7, 5, 3, 2, 1]);
    assert.deepEqual(Array.from(a), Array.from(b));
  });

  it('某个区一条都没有时也只是分到一根轴，不会漏掉', () => {
    const map = L.assignAxes(axes, [10, 0, 0, 0, 0, 0]);
    assert.equal(map.length, 6);
    assert.ok(Array.from(map).every((v) => v >= 0 && v < 6));
  });
});

describe('capCoses —— 每个区的球冠多大', () => {
  it('条目越多，冠越大（cos 越小）', () => {
    const coses = L.capCoses([10, 5, 1], 1.10);
    assert.ok(coses[0] < coses[1], '10 条的冠应当比 5 条的大');
    assert.ok(coses[1] < coses[2], '5 条的冠应当比 1 条的大');
  });

  it('只有一个区时，系数 1.10 让它盖住大半个球（cos ≈ -0.1）', () => {
    const coses = L.capCoses([5], 1.10);
    assert.ok(Math.abs(coses[0] - (-0.1)) < 1e-6);
  });

  it('所有区都是 0 条时，每个冠都塌成一个点（cos=1）', () => {
    const coses = L.capCoses([0, 0, 0], 1.10);
    Array.from(coses).forEach((c) => assert.equal(c, 1));
  });

  it('cos 永远不会低于 -0.98（否则整颗球会被一个区吃掉）', () => {
    const coses = L.capCoses([1000, 1, 1], 1.10);
    Array.from(coses).forEach((c) => assert.ok(c >= -0.98));
  });

  it('留缝系数越大，冠越小', () => {
    const wide = L.capCoses([10, 10], 0.80);
    const tight = L.capCoses([10, 10], 1.10);
    assert.ok(tight[0] < wide[0], '系数大反而没变小');
  });

  it('结果写进传入的 Float32Array，不另开新的', () => {
    const out = new Float32Array(3);
    const got = L.capCoses([3, 2, 1], 1.10, out);
    assert.equal(got, out);
  });
});

/* ==================================================================
 * 冠内布点
 * ================================================================== */

describe('tangentBasis —— 在轴上建一组切向基', () => {
  const cases = [
    L.vec(0, 1, 0),                                  // 极点
    L.vec(0, -1, 0),                                 // 另一极
    L.vec(1, 0, 0),
    L.vec(0.36, 0.8, 0.48),                          // 一般位置
  ];

  it('u 和 v 都垂直于轴', () => {
    for (const a of cases) {
      const u = L.vec(), v = L.vec();
      L.tangentBasis(a, u, v);
      assert.ok(Math.abs(L.dot(u, a)) < 1e-9, 'u 不垂直');
      assert.ok(Math.abs(L.dot(v, a)) < 1e-9, 'v 不垂直');
    }
  });

  it('u 和 v 互相垂直', () => {
    for (const a of cases) {
      const u = L.vec(), v = L.vec();
      L.tangentBasis(a, u, v);
      assert.ok(Math.abs(L.dot(u, v)) < 1e-9);
    }
  });

  it('u 和 v 都是单位向量（含极点，那里最容易退化）', () => {
    for (const a of cases) {
      const u = L.vec(), v = L.vec();
      L.tangentBasis(a, u, v);
      assert.ok(Math.abs(len(u) - 1) < 1e-9, 'u 不是单位向量');
      assert.ok(Math.abs(len(v) - 1) < 1e-9, 'v 不是单位向量');
    }
  });

  it('轴指向 +y 时 u 落在 z 轴上（参考轴换成 x，避开退化）', () => {
    const u = L.vec(), v = L.vec();
    L.tangentBasis(L.vec(0, 1, 0), u, v);
    assert.ok(Math.abs(u.x) < 1e-9 && Math.abs(u.y) < 1e-9);
    assert.ok(Math.abs(Math.abs(u.z) - 1) < 1e-9);
  });

  it('(u, v, a) 构成右手系', () => {
    for (const a of cases) {
      const u = L.vec(), v = L.vec();
      L.tangentBasis(a, u, v);
      // u × v 应当与 a 同向
      const cx = u.y * v.z - u.z * v.y;
      const cy = u.z * v.x - u.x * v.z;
      const cz = u.x * v.y - u.y * v.x;
      assert.ok(cx * a.x + cy * a.y + cz * a.z > 0.9, '不是右手系');
    }
  });

  it('不传 out 会自己开对象（调用方可以不预先准备）', () => {
    const v = L.tangentBasis(L.vec(0, 1, 0));
    assert.ok(v && typeof v.x === 'number');
  });
});

describe('capPoint —— 冠内的斐波那契螺旋', () => {
  const axis = L.vec(0, 1, 0);
  const u = L.vec(), v = L.vec();
  L.tangentBasis(axis, u, v);

  it('输出是单位向量', () => {
    for (let k = 0; k < 20; k++) {
      const p = L.capPoint(axis, u, v, 0.5, k, 20);
      assert.ok(Math.abs(len(p) - 1) < 1e-9, `第 ${k} 个点不在单位球面上`);
    }
  });

  it('每个点都在冠角以内', () => {
    const cosMax = 0.5;                       // 冠角 60 度
    const limit = Math.acos(cosMax) + 1e-9;
    for (let k = 0; k < 40; k++) {
      const p = L.capPoint(axis, u, v, cosMax, k, 40);
      assert.ok(angle(axis, p) <= limit, `第 ${k} 个点跑到冠外面了`);
    }
  });

  it('cosMax=1 时冠退化成一个点，所有点都落在轴上', () => {
    for (let k = 0; k < 5; k++) {
      const p = L.capPoint(axis, u, v, 1, k, 5);
      assert.ok(angle(axis, p) < 1e-6);
    }
  });

  it('cosMax=-1 时铺满整个球（两极都用到）', () => {
    const n = 200;
    let minY = 1, maxY = -1;
    for (let k = 0; k < n; k++) {
      const p = L.capPoint(axis, u, v, -1, k, n);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    assert.ok(minY < -0.95, `最低只到 y=${minY.toFixed(2)}`);
    assert.ok(maxY > 0.95, `最高只到 y=${maxY.toFixed(2)}`);
  });

  it('同一个冠里的 n 个点互不重合', () => {
    const n = 50;
    const pts = [];
    for (let k = 0; k < n; k++) pts.push(L.capPoint(axis, u, v, 0.3, k, n));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y, pts[i].z - pts[j].z);
        assert.ok(d > 1e-3, `第 ${i} 和第 ${j} 个点几乎重合（d=${d.toExponential(2)}）`);
      }
    }
  });

  it('点数越多间距越小，但不会塌：500 个点的最近邻仍在 0.05 以上', () => {
    // 这是"500 条时两点叠成一颗"那个 bug 的回归测试。
    // 当时用 Math.random() 撒点，实测最近邻掉到 0.13 以下的球面距离；
    // 换成斐波那契后，1000 个点还能保持均匀。
    const n = 500;
    const cosMax = -1;                        // 最坏情况：整个球
    const pts = [];
    for (let k = 0; k < n; k++) pts.push(L.capPoint(axis, u, v, cosMax, k, n));

    let minD = Infinity;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y, pts[i].z - pts[j].z);
        if (d < minD) minD = d;
      }
    }
    // 理想间距 ≈ sqrt(2π/n) ≈ 0.112，留一半余量
    assert.ok(minD > 0.05, `最近邻只有 ${minD.toFixed(4)}，点开始叠了`);
  });

  it('n 变大时最近邻按 1/√n 缩小，是"均匀变密"而不是"局部塌陷"', () => {
    const nearest = (n) => {
      const pts = [];
      for (let k = 0; k < n; k++) pts.push(L.capPoint(axis, u, v, 0.5, k, n));
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y, pts[i].z - pts[j].z);
          if (d < best) best = d;
        }
      }
      return best;
    };
    const d50 = nearest(50), d200 = nearest(200);
    const ratio = d50 / d200;
    const ideal = Math.sqrt(200 / 50);        // 理论上应接近 2
    assert.ok(ratio > ideal * 0.7 && ratio < ideal * 1.4,
      `间距比 ${ratio.toFixed(2)} 偏离理论值 ${ideal.toFixed(2)} 太多`);
  });

  it('反复调用结果一致（位置是确定的，刷新后记忆还在原处）', () => {
    const a = L.capPoint(axis, u, v, 0.4, 7, 20);
    const b = L.capPoint(axis, u, v, 0.4, 7, 20);
    assert.equal(a.x, b.x);
    assert.equal(a.y, b.y);
    assert.equal(a.z, b.z);
  });

  it('写进传入的 out，不另开新对象', () => {
    const out = L.vec();
    const got = L.capPoint(axis, u, v, 0.4, 0, 10, out);
    assert.equal(got, out);
  });
});

describe('radialOf —— 记忆在球里钻多深', () => {
  it('返回值落在 0.30 ~ 0.98 之间', () => {
    for (let k = 0; k < 500; k++) {
      const r = L.radialOf(k);
      assert.ok(r >= 0.30 && r <= 0.98, `第 ${k} 个半径 ${r} 越界`);
    }
  });

  it('48 个值互不相同（不会几条挤在同一个深度）', () => {
    const set = new Set();
    for (let k = 0; k < 48; k++) set.add(L.radialOf(k).toFixed(9));
    assert.equal(set.size, 48);
  });

  it('分成多层，不是全贴在球壳上', () => {
    const rs = [];
    for (let k = 0; k < 100; k++) rs.push(L.radialOf(k));
    const buckets = new Set(rs.map((r) => Math.floor((r - 0.30) / 0.068)));   // 十层
    assert.ok(buckets.size >= 8, `只用到 ${buckets.size} 层`);
  });

  it('中位数落在 0.6 附近（多数记忆在中层，不是全在边上）', () => {
    const rs = [];
    for (let k = 0; k < 999; k++) rs.push(L.radialOf(k));
    rs.sort((a, b) => a - b);
    const med = rs[Math.floor(rs.length / 2)];
    assert.ok(med > 0.5 && med < 0.75, `中位数 ${med.toFixed(3)} 偏了`);
  });

  it('反复调用结果一致', () => {
    assert.equal(L.radialOf(13), L.radialOf(13));
  });
});

describe('nearestRegion —— 这颗粒子属于哪个区', () => {
  const axes = L.makeAxes(9);

  it('方向正对某根轴时返回那根轴', () => {
    for (let i = 0; i < axes.length; i++) {
      const a = axes[i];
      assert.equal(L.nearestRegion(axes, a.x, a.y, a.z, 0.7), i);
    }
  });

  it('任意长度都不影响结果（内部先归一化）', () => {
    const a = axes[3];
    const r1 = L.nearestRegion(axes, a.x, a.y, a.z, 0.7);
    const r2 = L.nearestRegion(axes, a.x * 37, a.y * 37, a.z * 37, 0.7);
    assert.equal(r1, r2);
  });

  it('离所有轴都太远时返回 -1（那是背景星，不属于任何区）', () => {
    // 找一个离所有轴都远的方向
    let found = -1;
    for (let t = 0; t < 200 && found < 0; t++) {
      const th = t * 0.11, ph = t * 0.37;
      const x = Math.cos(th) * Math.sin(ph);
      const y = Math.cos(ph);
      const z = Math.sin(th) * Math.sin(ph);
      if (L.nearestRegion(axes, x, y, z, 0.7) === -1) found = t;
    }
    assert.ok(found >= 0, '九根轴几乎盖满了球，找不出空白方向');
  });

  it('空轴表返回 -1', () => {
    assert.equal(L.nearestRegion([], 1, 0, 0, 0.7), -1);
  });

  it('零向量不崩，返回 -1', () => {
    assert.equal(L.nearestRegion(axes, 0, 0, 0, 0.7), -1);
  });

  it('minDot 调高，归属会变少（锥体收窄）', () => {
    let loose = 0, strict = 0;
    for (let i = 0; i < 500; i++) {
      const th = i * 0.3, ph = i * 0.17;
      const x = Math.cos(th) * Math.sin(ph);
      const y = Math.cos(ph);
      const z = Math.sin(th) * Math.sin(ph);
      if (L.nearestRegion(axes, x, y, z, 0.5) >= 0) loose++;
      if (L.nearestRegion(axes, x, y, z, 0.9) >= 0) strict++;
    }
    assert.ok(strict <= loose, '门限调高反而归属变多了');
    assert.ok(loose > 0, '宽松门限下一个都没归上，测试数据有问题');
  });

  it('不传 minDot 时默认 0.70', () => {
    const a = axes[2];
    assert.equal(L.nearestRegion(axes, a.x, a.y, a.z), 2);
  });
});

/* ==================================================================
 * 时间与访问痕迹
 * ================================================================== */

describe('parseTime —— 把 createdAt 变成毫秒', () => {
  const NOW = new Date('2026-11-15T12:00:00+08:00').getTime();

  it('完整 ISO 日期解析成对应时刻', () => {
    const t = L.parseTime('2025-06-06', NOW);
    assert.equal(t, new Date('2025-06-06').getTime());
  });

  it('只有年份、但带汉字时落在那一年的年中（7 月 1 日）', () => {
    // '2023年' 这种写法 Date.parse 认不出，才轮得到 parseInt 兜底
    const t = L.parseTime('2023年', NOW);
    assert.equal(new Date(t).getFullYear(), 2023);
    assert.equal(new Date(t).getMonth(), 6, '没落在年中');
  });

  it('纯数字年份被 Date.parse 直接接住，落在年初而不是年中', () => {
    // 记一笔现状：V8 / 浏览器都认 "2023" 这种 ISO 简写，返回 1 月 1 日，
    // 走不到 parseInt 那条分支。所以数据里写 "2023" 和写 "2023年"
    // 在时间轴上的位置不一样 —— 相差半年。
    const t = L.parseTime('2023', NOW);
    assert.equal(t, Date.parse('2023'));
    assert.equal(new Date(t).getMonth(), 0, '年初');
  });

  it('空值退回 fallback', () => {
    assert.equal(L.parseTime('', NOW), NOW);
    assert.equal(L.parseTime(null, NOW), NOW);
    assert.equal(L.parseTime(undefined, NOW), NOW);
  });

  it('认不出的字符串退回 fallback，不抛错', () => {
    assert.equal(L.parseTime('某个夏天的下午', NOW), NOW);
    assert.equal(L.parseTime('--', NOW), NOW);
  });

  it('没有 fallback 时用当前时间', () => {
    const before = Date.now();
    const t = L.parseTime('');
    const after = Date.now();
    assert.ok(t >= before && t <= after);
  });

  it('带时间的 ISO 也能解析', () => {
    const t = L.parseTime('2025-06-06T10:30:00+08:00', NOW);
    assert.equal(t, new Date('2025-06-06T10:30:00+08:00').getTime());
  });
});

describe('usageKey —— 访问记录怎么分条', () => {
  it('标题不同，键就不同', () => {
    const a = L.usageKey({ title: '雨天', createdAt: '2025-01-01' });
    const b = L.usageKey({ title: '雪天', createdAt: '2025-01-01' });
    assert.notEqual(a, b);
  });

  it('同名不同日期是两条（这就是"打开一条另一条跟着亮"的修复）', () => {
    const a = L.usageKey({ title: '雨天', createdAt: '2025-01-01' });
    const b = L.usageKey({ title: '雨天', createdAt: '2024-01-01' });
    assert.notEqual(a, b);
  });

  it('没有 createdAt 也是一个稳定的键', () => {
    const a = L.usageKey({ title: '雨天' });
    const b = L.usageKey({ title: '雨天' });
    assert.equal(a, b);
  });

  it('键里不会出现标题和日期的歧义拼接（中间有分隔符）', () => {
    // "a1" + "23" 和 "a" + "123" 必须能区分
    const a = L.usageKey({ title: 'a1', createdAt: '23' });
    const b = L.usageKey({ title: 'a', createdAt: '123' });
    assert.notEqual(a, b);
  });

  it('null 返回空串，不抛错', () => {
    assert.equal(L.usageKey(null), '');
    assert.equal(L.usageKey(undefined), '');
  });
});

describe('usageLine —— 面板上那行"你和这条的关系"', () => {
  const DAY = 86400000;
  const NOW = 1700000000000;

  it('没打开过就没有这行', () => {
    assert.equal(L.usageLine(null, NOW), '');
    assert.equal(L.usageLine({ n: 0 }, NOW), '');
  });

  it('第一次且是今天', () => {
    assert.equal(L.usageLine({ n: 1, t: NOW }, NOW), '你是第一次翻开这条');
  });

  it('第一次且是昨天，文案里不出现"今天"', () => {
    const s = L.usageLine({ n: 1, t: NOW - DAY }, NOW);
    assert.equal(s, '你是第一次翻开这条');
    assert.ok(!s.includes('今天'));
  });

  it('第二次以后说翻过几次', () => {
    const s = L.usageLine({ n: 3, t: NOW }, NOW);
    assert.ok(s.includes('3'), '没写次数');
    assert.ok(s.includes('最近一次'), '没写上次时间');
  });

  it('天数分档：今天 / 昨天 / N 天前', () => {
    assert.ok(L.usageLine({ n: 2, t: NOW }, NOW).includes('今天'));
    assert.ok(L.usageLine({ n: 2, t: NOW - DAY }, NOW).includes('昨天'));
    assert.ok(L.usageLine({ n: 2, t: NOW - 5 * DAY }, NOW).includes('5 天前'));
  });

  it('时间在未来也按今天算，不出现"负数天前"', () => {
    const s = L.usageLine({ n: 2, t: NOW + 3 * DAY }, NOW);
    assert.ok(s.includes('今天'));
    assert.ok(!s.includes('-'));
  });

  it('这句话里不含"打开"二字（旧文案"第一次打开"会被读成记忆的日期）', () => {
    const s = L.usageLine({ n: 1, t: NOW }, NOW);
    assert.ok(!s.includes('打开'));
  });
});

describe('usageStrength —— 看过的记忆更亮', () => {
  const DAY = 86400000;
  const NOW = 1700000000000;

  it('没打开过是 0.93（只是没亮起来，不是惩罚）', () => {
    assert.equal(L.usageStrength(null, NOW), 0.93);
    assert.equal(L.usageStrength({ n: 0 }, NOW), 0.93);
  });

  it('打开过一次会比没打开时亮', () => {
    const s = L.usageStrength({ n: 1, t: NOW }, NOW);
    assert.ok(s > 0.93, `只有 ${s}`);
  });

  it('打开次数越多越亮', () => {
    const a = L.usageStrength({ n: 1, t: NOW }, NOW);
    const b = L.usageStrength({ n: 6, t: NOW }, NOW);
    assert.ok(b > a, '6 次不比 1 次亮');
  });

  it('有上限：反复看到底也不会超过 1.34', () => {
    const s = L.usageStrength({ n: 100000, t: NOW }, NOW);
    assert.ok(s <= 1.34 + 1e-9, `冲到 ${s}`);
  });

  it('刚打开的比很久以前打开的亮（新鲜度有加成）', () => {
    const fresh = L.usageStrength({ n: 3, t: NOW }, NOW);
    const stale = L.usageStrength({ n: 3, t: NOW - 400 * DAY }, NOW);
    assert.ok(fresh > stale, '隔了400天反而更亮');
  });

  it('新鲜度加成会衰减到 0，但次数加成留着', () => {
    const very = L.usageStrength({ n: 3, t: NOW - 5000 * DAY }, NOW);
    const never = L.usageStrength(null, NOW);
    assert.ok(very > never, '看过很多次的记忆沉到比没看过的还暗');
  });

  it('永远不低于未打开时的 0.93', () => {
    for (const n of [1, 2, 5, 20, 999]) {
      const s = L.usageStrength({ n, t: NOW - 900 * DAY }, NOW);
      assert.ok(s >= 0.93, `n=${n} 时只有 ${s}`);
    }
  });
});

/* ==================================================================
 * 连线与视角
 * ================================================================== */

describe('bezierPoint —— 记忆之间那条弯线', () => {
  it('t=0 落在起点', () => {
    const p = L.bezierPoint(L.vec(), 1, 2, 3, 7, 8, 9, 0.2, 0);
    assert.ok(Math.abs(p.x - 1) < EPS && Math.abs(p.y - 2) < EPS && Math.abs(p.z - 3) < EPS);
  });

  it('t=1 落在终点', () => {
    const p = L.bezierPoint(L.vec(), 1, 2, 3, 7, 8, 9, 0.2, 1);
    assert.ok(Math.abs(p.x - 7) < EPS && Math.abs(p.y - 8) < EPS && Math.abs(p.z - 9) < EPS);
  });

  it('bow=0、t=0.5 时落在两点中点（直线）', () => {
    const p = L.bezierPoint(L.vec(), 0, 0, 0, 10, 20, 30, 0, 0.5);
    assert.ok(Math.abs(p.x - 5) < EPS && Math.abs(p.y - 10) < EPS && Math.abs(p.z - 15) < EPS);
  });

  it('bow 越大，弧越往外鼓（离弦越远）', () => {
    const flat = L.bezierPoint(L.vec(), 0, 0, 0, 10, 0, 0, 0, 0.5);
    const bowed = L.bezierPoint(L.vec(), 0, 0, 0, 10, 0, 0, 0.5, 0.5);
    assert.ok(bowed.x > flat.x || Math.hypot(bowed.y, bowed.z) > Math.hypot(flat.y, flat.z));
    assert.ok(Math.hypot(bowed.x - 5, bowed.y, bowed.z) > Math.hypot(flat.x - 5, flat.y, flat.z));
  });

  it('起点终点互换，曲线形状相同（只是方向相反）', () => {
    const a = L.bezierPoint(L.vec(), 1, 2, 3, 7, 8, 9, 0.3, 0.25);
    const b = L.bezierPoint(L.vec(), 7, 8, 9, 1, 2, 3, 0.3, 0.75);
    assert.ok(Math.abs(a.x - b.x) < 1e-9);
    assert.ok(Math.abs(a.y - b.y) < 1e-9);
    assert.ok(Math.abs(a.z - b.z) < 1e-9);
  });

  it('写进传入的 out，不另开新对象', () => {
    const out = L.vec();
    assert.equal(L.bezierPoint(out, 0, 0, 0, 1, 1, 1, 0.1, 0.5), out);
  });
});

describe('camMaxDist —— 相机最远能退到哪', () => {
  it('窄屏收紧到 30：再远球就缩成一颗豆子', () => {
    assert.equal(L.camMaxDist(390, 44, 30), 30);
  });

  it('宽屏用配置值', () => {
    assert.equal(L.camMaxDist(1440, 44, 30), 44);
  });

  it('断点 760 两侧各归各的', () => {
    assert.equal(L.camMaxDist(760, 44, 30), 30, '760 本身算窄屏');
    assert.equal(L.camMaxDist(761, 44, 30), 44, '761 算宽屏');
  });

  it('宽屏的配置值本来就比手机上限小时，取小的那个', () => {
    assert.equal(L.camMaxDist(390, 20, 30), 20);
  });

  it('可以传入自定义断点和上限', () => {
    assert.equal(L.camMaxDist(500, 50, 12, 600, 12), 12);
    assert.equal(L.camMaxDist(900, 50, 12, 600), 50);
  });
});

describe('timelineDim —— 回放时连线该多亮', () => {
  it('时间轴关着时恒为 1（不影响平时）', () => {
    assert.equal(L.timelineDim(false, 0, 0), 1);
    assert.equal(L.timelineDim(false, 0.2, 0.9), 1);
  });

  it('开着的取两端较小值', () => {
    assert.equal(L.timelineDim(true, 0.2, 0.9), 0.2);
    assert.equal(L.timelineDim(true, 0.9, 0.2), 0.2);
  });

  it('一端还没发生（权重 0），整条线就不画（不留悬空线）', () => {
    assert.equal(L.timelineDim(true, 0, 1), 0);
    assert.equal(L.timelineDim(true, 1, 0), 0);
  });

  it('一端权重缺失时按 1 处理，不压暗', () => {
    assert.equal(L.timelineDim(true, null, 0.5), 1);
    assert.equal(L.timelineDim(true, 0.5, undefined), 1);
  });

  it('两端都在，取小的那个而不是平均', () => {
    // 平均会得到 0.5，但正确行为是 0.1 —— 刚淡入的那头该把线一起带出来
    assert.equal(L.timelineDim(true, 0.1, 0.9), 0.1);
    assert.notEqual(L.timelineDim(true, 0.1, 0.9), 0.5);
  });
});
