/* =====================================================================
 *  识海 · 语义层（SeaSemantic）
 * ---------------------------------------------------------------------
 *  做三件事：
 *    1. 把每条记忆变成向量（中文二元组 + TF-IDF 加权）
 *    2. 按语义相似度检索（"海"能搜到"浪""潮""沙滩"那些句子）
 *    3. 把记忆按语义聚成若干簇，交给 main.js 当成"脑区"来摆放
 *
 *  为什么不用 embedding 模型：
 *    项目承诺"纯静态、零构建、零联网、双击就跑"。一个中文 embedding
 *    模型量化后也有 30–60MB，放进仓库既违背承诺，也让克隆变慢。
 *    TF-IDF 在几十到几百条记忆的规模上足够，且冷启动是毫秒级。
 *    接口留了 pluggable 的口子：以后要换成向量模型，只需替换
 *    buildIndex() 里生成向量的那一步，上层调用不用改。
 *
 *  中文为什么用二元组（bigram）：
 *    不引入词典就没法分词，但"桂花""银河""便利店"这类词的特征信息
 *    几乎都落在相邻两个字上。切 bigram + 去停用字，效果接近粗分词，
 *    代价接近零。
 * ===================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SeaSemantic = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  /* ---------- 停用字：单字层面没有区分度的 ---------- */

  var STOP_CHARS = {};
  ('的了是在我你他她它和与就都而及或被把让给这那有没不一个上下来去说会能要'
    + '为以之其于也还但只很更最又再才吗呢吧啊哦嗯着过地得')
    .split('').forEach(function (c) { STOP_CHARS[c] = 1; });

  var STOP_WORDS = {};
  ('the a an and or of to in on at for with is are was were be been this that '
    + 'it its as by from not but if then than so such can will would could should')
    .split(' ').forEach(function (w) { if (w) STOP_WORDS[w] = 1; });

  /* ---------- 分词 ---------- */

  var CJK = /[\u4e00-\u9fa5]/;
  var LATIN = /[a-z0-9]/i;

  // 二元组会切出"的第""们把"这种跨词边界的噪声。
  // 检索时它们无害（甚至能提高召回），但拿来当簇标签就很难看。
  var NOISE_HEAD = /^[的了是在和把被让给我你他她它这那有就都也很更最又才而及或为以之于还但只着过]/;
  var NOISE_TAIL = /[的了着过们呢吗吧啊哦嗯地得和与]$/;

  function isNoiseToken(t) {
    if (t.length !== 2) return false;
    return NOISE_HEAD.test(t) || NOISE_TAIL.test(t);
  }

  /**
   * 把一段文本切成 token 数组。
   * 中文：连续汉字串 → 二元组（同时保留单字，权重在后面对单字打折）
   * 拉丁：连续字母数字 → 小写整词
   */
  function tokenize(text) {
    var out = [];
    if (!text) return out;

    var s = String(text);
    var buf = '';
    var latin = '';

    function flushCJK() {
      if (!buf) return;
      if (buf.length === 1) {
        if (!STOP_CHARS[buf]) out.push(buf);
      } else {
        for (var i = 0; i < buf.length - 1; i++) {
          var a = buf.charAt(i);
          var b = buf.charAt(i + 1);
          if (STOP_CHARS[a] && STOP_CHARS[b]) continue;
          out.push(a + b);
        }
        // 单字补一份，方便"雪""海"这种单字查询也能命中
        for (var j = 0; j < buf.length; j++) {
          var c = buf.charAt(j);
          if (!STOP_CHARS[c]) out.push(c);
        }
      }
      buf = '';
    }

    function flushLatin() {
      if (!latin) return;
      var w = latin.toLowerCase();
      if (w.length > 1 && !STOP_WORDS[w]) out.push(w);
      latin = '';
    }

    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (CJK.test(ch)) {
        flushLatin();
        buf += ch;
      } else if (LATIN.test(ch)) {
        flushCJK();
        latin += ch;
      } else {
        flushCJK();
        flushLatin();
      }
    }
    flushCJK();
    flushLatin();
    return out;
  }

  /* ---------- 建索引 ---------- */

  function docTextOf(m) {
    if (!m) return '';
    // 标题权重天然更重要：重复三次，等价于放大它的词频
    var t = m.title || '';
    return t + ' ' + t + ' ' + t + ' ' + (m.text || '') + ' ' + (m.tag || '');
  }

  /**
   * 建索引。返回 { docs, vocab, idf, vectors, n }
   * vectors[i] 是 { token: weight } 的稀疏对象
   */
  function buildIndex(memories) {
    var n = memories.length;
    var docs = [];
    var tf = [];
    var df = {};
    var i, j, k;

    for (i = 0; i < n; i++) {
      var toks = tokenize(docTextOf(memories[i]));
      var counts = {};
      for (j = 0; j < toks.length; j++) {
        counts[toks[j]] = (counts[toks[j]] || 0) + 1;
      }
      docs.push(counts);
      var seen = {};
      for (var t in counts) {
        if (!Object.prototype.hasOwnProperty.call(counts, t)) continue;
        if (seen[t]) continue;
        seen[t] = 1;
        df[t] = (df[t] || 0) + 1;
      }
    }

    var idf = {};
    for (var w in df) {
      if (!Object.prototype.hasOwnProperty.call(df, w)) continue;
      idf[w] = Math.log((n + 1) / (df[w] + 1)) + 1;
    }

    var vectors = [];
    for (i = 0; i < n; i++) {
      var vec = {};
      var norm = 0;
      var c = docs[i];
      for (var token in c) {
        if (!Object.prototype.hasOwnProperty.call(c, token)) continue;
        var tfv = 1 + Math.log(c[token]);
        // 单字打折，避免"雪""海"压过"桂花""银河"
        var wgt = tfv * (idf[token] || 1) * (token.length === 1 ? 0.55 : 1);
        vec[token] = wgt;
        norm += wgt * wgt;
      }
      norm = Math.sqrt(norm) || 1;
      for (var key in vec) {
        if (!Object.prototype.hasOwnProperty.call(vec, key)) continue;
        vec[key] = vec[key] / norm;
      }
      vectors.push(vec);
    }

    // 记录每个 token 出现在哪些文档，聚类的簇标签要用
    var postings = {};
    for (i = 0; i < n; i++) {
      for (var tk in vectors[i]) {
        if (!Object.prototype.hasOwnProperty.call(vectors[i], tk)) continue;
        if (!postings[tk]) postings[tk] = [];
        postings[tk].push(i);
      }
    }

    return { docs: docs, idf: idf, vectors: vectors, postings: postings, n: n, items: memories };
  }

  /* ---------- 相似度 ---------- */

  function cosine(a, b) {
    // 遍历较短的那个，天然省一半
    var small = a, big = b;
    var countA = 0, countB = 0;
    for (var x in a) { if (Object.prototype.hasOwnProperty.call(a, x)) countA++; }
    for (var y in b) { if (Object.prototype.hasOwnProperty.call(b, y)) countB++; }
    if (countA > countB) { small = b; big = a; }

    var dot = 0;
    for (var t in small) {
      if (!Object.prototype.hasOwnProperty.call(small, t)) continue;
      if (big[t] !== undefined) dot += small[t] * big[t];
    }
    return dot;   // 两边都已归一化，点积即余弦
  }

  /** 把查询串变成同空间的向量 */
  function queryVector(index, query) {
    var toks = tokenize(query);
    if (!toks.length) return {};
    var counts = {};
    var i;
    for (i = 0; i < toks.length; i++) counts[toks[i]] = (counts[toks[i]] || 0) + 1;

    var vec = {};
    var norm = 0;
    for (var t in counts) {
      if (!Object.prototype.hasOwnProperty.call(counts, t)) continue;
      var tfv = 1 + Math.log(counts[t]);
      var idf = index.idf[t];
      // 查询词没在语料里出现过时，给一个中等 idf，避免完全搜不到
      var wgt = tfv * (idf === undefined ? 1.2 : idf) * (t.length === 1 ? 0.55 : 1);
      vec[t] = wgt;
      norm += wgt * wgt;
    }
    norm = Math.sqrt(norm) || 1;
    for (var k in vec) {
      if (!Object.prototype.hasOwnProperty.call(vec, k)) continue;
      vec[k] = vec[k] / norm;
    }
    return vec;
  }

  /**
   * 检索。返回 [{ index, score }]，按分数降序，只保留 score > minScore
   */
  function search(index, query, opt) {
    opt = opt || {};
    var topK = opt.topK || 20;
    var minScore = opt.minScore === undefined ? 0.02 : opt.minScore;
    var qv = queryVector(index, query);
    if (!Object.keys(qv).length) return [];

    var hits = [];
    for (var i = 0; i < index.vectors.length; i++) {
      var s = cosine(qv, index.vectors[i]);
      if (s > minScore) hits.push({ index: i, score: s });
    }
    hits.sort(function (a, b) { return b.score - a.score; });
    return hits.slice(0, topK);
  }

  /** 某条记忆的语义近邻（"和这段相似的还有哪些"） */
  function related(index, i, topK) {
    topK = topK || 5;
    var out = [];
    var v = index.vectors[i];
    if (!v) return out;
    for (var j = 0; j < index.vectors.length; j++) {
      if (j === i) continue;
      var s = cosine(v, index.vectors[j]);
      if (s > 0.01) out.push({ index: j, score: s });
    }
    out.sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, topK);
  }

  /* ---------- 聚类 ---------- */

  /** 建议簇数：条目越多分得越细，但别超过 8（脑区太多会糊成一片） */
  function suggestK(n) {
    if (n <= 2) return 1;
    // 9 条 → 4 簇，20 条 → 6 簇，50 条 → 8 簇（封顶）
    var k = Math.round(Math.sqrt(n) * 1.35);
    return Math.max(2, Math.min(8, k));
  }

  /**
   * k-means（余弦距离）。确定性种子：取彼此最远的前 k 个文档，
   * 同样的输入每次跑出同样的簇 —— 星图不能每次刷新都换个样子。
   */
  function cluster(index, k) {
    var n = index.n;
    if (n === 0) return { assign: [], k: 0, labels: [] };
    k = Math.max(1, Math.min(k || suggestK(n), n));
    if (k === 1) {
      var only = [];
      for (var z = 0; z < n; z++) only.push(0);
      return { assign: only, k: 1, labels: [labelOf(index, only, 0)] };
    }

    // 最远点初始化
    var centers = [index.vectors[0]];
    var chosen = { 0: 1 };
    while (centers.length < k) {
      var best = -1, bestD = -1, bestS = 2;
      for (var i = 0; i < n; i++) {
        if (chosen[i]) continue;
        var maxSim = -1;
        for (var c = 0; c < centers.length; c++) {
          var s = cosine(index.vectors[i], centers[c]);
          if (s > maxSim) maxSim = s;
        }
        if (-maxSim > bestD) { bestD = -maxSim; best = i; bestS = maxSim; }
      }
      if (best < 0) break;
      chosen[best] = 1;
      centers.push(index.vectors[best]);
    }

    var assign = new Array(n);
    var iter, changed = true;
    for (iter = 0; iter < 24 && changed; iter++) {
      changed = false;
      for (var a = 0; a < n; a++) {
        var bi = 0, bs = -2;
        for (var c2 = 0; c2 < centers.length; c2++) {
          var sim = cosine(index.vectors[a], centers[c2]);
          if (sim > bs) { bs = sim; bi = c2; }
        }
        if (assign[a] !== bi) { assign[a] = bi; changed = true; }
      }
      // 重心：簇内向量求和后归一化
      var sums = [];
      for (var q = 0; q < centers.length; q++) sums.push({});
      for (var d = 0; d < n; d++) {
        var bucket = sums[assign[d]];
        var v = index.vectors[d];
        for (var tk in v) {
          if (!Object.prototype.hasOwnProperty.call(v, tk)) continue;
          bucket[tk] = (bucket[tk] || 0) + v[tk];
        }
      }
      for (var r = 0; r < sums.length; r++) {
        var nv = {};
        var nn = 0;
        for (var t2 in sums[r]) {
          if (!Object.prototype.hasOwnProperty.call(sums[r], t2)) continue;
          nn += sums[r][t2] * sums[r][t2];
        }
        nn = Math.sqrt(nn) || 1;
        for (var t3 in sums[r]) {
          if (!Object.prototype.hasOwnProperty.call(sums[r], t3)) continue;
          nv[t3] = sums[r][t3] / nn;
        }
        if (Object.keys(nv).length) centers[r] = nv;
      }
    }

    // 空簇合并掉，保证 assign 从 0 连续
    var remap = {};
    var labels = [];
    for (var m = 0; m < centers.length; m++) {
      var members = [];
      for (var p = 0; p < n; p++) if (assign[p] === m) members.push(p);
      if (!members.length) continue;
      var newIdx = labels.length;
      remap[m] = newIdx;
      labels.push(labelOf(index, members, newIdx));
    }
    var finalAssign = [];
    for (var f = 0; f < n; f++) {
      var mapped = remap[assign[f]];
      finalAssign.push(mapped === undefined ? 0 : mapped);
    }

    return { assign: finalAssign, k: labels.length, labels: labels };
  }

  /** 给一簇起名：簇内权重和最高、且能代表这一簇的词 */
  function labelOf(index, members, idx) {
    // 只有一条的簇，词频统计没有意义 —— 直接用作者自己写的 tag
    if (members.length === 1 && index.items && index.items[members[0]]) {
      var only = index.items[members[0]];
      if (only.tag && only.tag !== '未名') return String(only.tag);
    }

    var score = {};
    var i, j;
    for (i = 0; i < members.length; i++) {
      var v = index.vectors[members[i]];
      for (var t in v) {
        if (!Object.prototype.hasOwnProperty.call(v, t)) continue;
        score[t] = (score[t] || 0) + v[t];
      }
    }
    // 簇越大，词权重越容易堆高，除以成员数做归一
    var div = Math.sqrt(members.length) || 1;
    var total = index.n || 1;
    var best = '', bestV = 0;

    for (var k in score) {
      if (!Object.prototype.hasOwnProperty.call(score, k)) continue;
      var s = score[k] / div;

      // 纯数字、"第七"这类序数当标签毫无信息量
      if (/^[0-9０-９]+$/.test(k)) continue;
      if (/^第.$/.test(k)) continue;
      // 跨词边界的二元组噪声
      if (isNoiseToken(k)) continue;

      // 单字区分度低，降权
      if (k.length === 1) s *= 0.5;

      var df = index.postings[k] ? index.postings[k].length : 1;
      // 只在一条记忆里出现过 —— 那是细节，不是主题
      if (df <= 1) s *= 0.55;
      // 几乎每条都有 —— 反而没有区分度
      if (df > total * 0.7) s *= 0.5;
      // 刚好覆盖这一簇大部分成员 —— 最理想的主题词
      if (df >= 2 && df <= Math.max(3, members.length)) s *= 1.25;

      if (s > bestV) { bestV = s; best = k; }
    }
    if (!best) return '未名';
    return best;
  }

  /* ---------- 3D 投影（可选，供语义星图使用） ---------- */

  /**
   * 用相似度矩阵做一次简单的 3D 力导向布局。
   * 相似的两点互相吸引，所有点互相排斥 —— 语义近的记忆会真的挨在一起。
   * 返回 Float32Array(n*3)，坐标已归一化到 [-1, 1]。
   */
  function project(index, opt) {
    opt = opt || {};
    var n = index.n;
    var out = new Float32Array(n * 3);
    if (!n) return out;

    var iters = opt.iterations || 120;
    var i, j, d;

    // 确定性初始位置：斐波那契球面，避免随机导致每次形状不同
    for (i = 0; i < n; i++) {
      var t = (i + 0.5) / n;
      var y = 1 - 2 * t;
      var rad = Math.sqrt(Math.max(0, 1 - y * y));
      var phi = i * 2.399963;
      out[i * 3] = Math.cos(phi) * rad;
      out[i * 3 + 1] = y;
      out[i * 3 + 2] = Math.sin(phi) * rad;
    }
    if (n < 3) return out;

    // 预计算相似度（n 小，直接全对比）
    var sim = new Float32Array(n * n);
    for (i = 0; i < n; i++) {
      for (j = i + 1; j < n; j++) {
        var s = cosine(index.vectors[i], index.vectors[j]);
        sim[i * n + j] = s;
        sim[j * n + i] = s;
      }
    }

    var disp = new Float32Array(n * 3);
    for (var it = 0; it < iters; it++) {
      var cool = 1 - it / iters;
      for (i = 0; i < n * 3; i++) disp[i] = 0;

      for (i = 0; i < n; i++) {
        for (j = i + 1; j < n; j++) {
          var dx = out[i * 3] - out[j * 3];
          var dy = out[i * 3 + 1] - out[j * 3 + 1];
          var dz = out[i * 3 + 2] - out[j * 3 + 2];
          var dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001;
          var w = sim[i * n + j];
          // 相似 → 吸引（负力），否则排斥
          var force = w > 0.05 ? -w * 0.9 / dist : 0.06 / (dist * dist);
          var fx = dx * force, fy = dy * force, fz = dz * force;
          disp[i * 3] += fx; disp[i * 3 + 1] += fy; disp[i * 3 + 2] += fz;
          disp[j * 3] -= fx; disp[j * 3 + 1] -= fy; disp[j * 3 + 2] -= fz;
        }
      }

      // 向球心轻微回拉，防止飘散
      for (i = 0; i < n; i++) {
        var k3 = i * 3;
        var len = Math.sqrt(out[k3] * out[k3] + out[k3 + 1] * out[k3 + 1] + out[k3 + 2] * out[k3 + 2]) || 0.001;
        out[k3] += (disp[k3] * 0.5 - out[k3] / len * 0.08) * cool;
        out[k3 + 1] += (disp[k3 + 1] * 0.5 - out[k3 + 1] / len * 0.08) * cool;
        out[k3 + 2] += (disp[k3 + 2] * 0.5 - out[k3 + 2] / len * 0.08) * cool;
      }
    }

    // 归一化：整体映射到单位球内
    var maxLen = 0.001;
    for (i = 0; i < n; i++) {
      var l = Math.sqrt(out[i * 3] * out[i * 3] + out[i * 3 + 1] * out[i * 3 + 1] + out[i * 3 + 2] * out[i * 3 + 2]);
      if (l > maxLen) maxLen = l;
    }
    for (d = 0; d < n * 3; d++) out[d] /= maxLen;

    return out;
  }

  return {
    tokenize: tokenize,
    buildIndex: buildIndex,
    cosine: cosine,
    queryVector: queryVector,
    search: search,
    related: related,
    cluster: cluster,
    suggestK: suggestK,
    project: project,
    labelOf: labelOf
  };
});
