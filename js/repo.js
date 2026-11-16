/* =====================================================================
 *  识海 · 数据层（MemoryRepository）
 * ---------------------------------------------------------------------
 *  为什么需要这一层：
 *    以前整个应用直接从 window.MEMORIES 这个全局变量读数据，
 *    于是"新增/编辑/加密/导入/搜索"全都没地方挂。这里把它抽成
 *    一个统一的仓库接口，上层只管调方法，不关心数据存在哪。
 *
 *  三种后端（按能力自动选择，越靠前越优先）：
 *    local  浏览器 localStorage —— 同步、file:// 双击也能用，主存储
 *    file   data/memories.js 直出的全局变量 —— 只读回退，永远可用
 *    （加密包 .sea 是导入导出的载体，不是常驻后端）
 *
 *  用法：
 *    SeaRepo.boot()                 启动时同步把数据注入 window.MEMORIES
 *    SeaRepo.list()                 读全部（内存副本）
 *    SeaRepo.save(list)             全量写回 localStorage
 *    SeaRepo.upsert(item, index)    新增或更新一条
 *    SeaRepo.removeAt(index)        删一条
 *    SeaRepo.link(a, b)             双向连一条（两端都记）
 *    SeaRepo.unlink(a, b)           解开（两端都清）
 *    SeaRepo.exportJSON()           导出明文 JSON（可再次导入）
 *    SeaRepo.importJSON(text)       导入 JSON，返回条数
 *    SeaRepo.exportSealed(pass)     导出 AES-GCM 加密包（ArrayBuffer）
 *    SeaRepo.importSealed(buf,pass) 导入加密包
 *    SeaRepo.reset()                清空本地存储，回到 memories.js
 *
 *  设计取舍：
 *    · 故意不用 IndexedDB —— Chrome 在 file:// 下禁用它，而本项目
 *      的核心承诺就是"双击 index.html 能跑"。localStorage 同步读取，
 *      页面启动时不需要 await，main.js 仍是普通 <script>。
 *    · 记忆正文量很小（一条几百字），5MB 配额够存上万条；照片仍是
 *      外部文件，不进存储。
 * ===================================================================== */
window.SeaRepo = (function () {
  'use strict';

  var KEY = 'sea.memories.v1';
  var META_KEY = 'sea.memories.meta.v1';
  var VER_KEY = 'sea.memories.ver.v1';
  var SCHEMA = 1;

  // 记忆互连：一条记忆最多连出 12 条，下标上限 512（防止恶意/损坏数据指向越界）
  var LINK_MAX = 12;
  var LINK_INDEX_MAX = 512;

  /* ---------- 能力探测 ---------- */

  var hasLocal = (function () {
    try {
      var k = '__sea_probe__';
      window.localStorage.setItem(k, '1');
      window.localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;   // 隐私模式 / 被禁用
    }
  })();

  var backend = hasLocal ? 'local' : 'file';

  /* ---------- 数据版本 ----------
   * 纯静态应用有个坑：localStorage 里的旧数据会一直压着 memories.js，
   * 于是"我改了数据文件、刷新页面"什么都不会变（加了 40 张照片，看到的还是老 8 条）。
   *
   * 这里给文件里的数据算一个指纹，连同本地数据一起存。
   * 指纹对不上，说明数据文件换了内容 —— 那就以文件为准，把旧的那份备份掉。
   * 指纹相同，说明文件没动，本地编辑照旧生效。
   *
   * 不用手写版本号，是因为手写的一定会忘记更新，而且不比这个可靠。
   */
  function fingerprint(list) {
    if (!Array.isArray(list) || !list.length) return '0';
    var h = 5381;
    for (var i = 0; i < list.length; i++) {
      var m = list[i] || {};
      var img = m.image || (Object.prototype.toString.call(m.images) === '[object Array]'
        ? m.images.join(',') : '');
      var s = (m.title || '') + '\u0001' + (m.createdAt || '') + '\u0001' +
        (m.text ? m.text.length : 0) + '\u0001' + img;
      for (var j = 0; j < s.length; j++) {
        h = ((h * 33) ^ s.charCodeAt(j)) >>> 0;
      }
    }
    return list.length + '-' + h.toString(36);
  }

  function readVer() {
    if (!hasLocal) return '';
    try { return window.localStorage.getItem(VER_KEY) || ''; } catch (e) { return ''; }
  }

  function writeVer(v) {
    if (!hasLocal) return;
    try { window.localStorage.setItem(VER_KEY, v); } catch (e) { }
  }

  /* ---------- 内存副本 ---------- */

  var cache = null;

  function readLocal() {
    if (!hasLocal) return null;
    try {
      var raw = window.localStorage.getItem(KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || !Array.isArray(data.items)) return null;
      return data.items;
    } catch (e) {
      return null;
    }
  }

  function writeLocal(list) {
    if (!hasLocal) return false;
    try {
      window.localStorage.setItem(KEY, JSON.stringify({
        schema: SCHEMA,
        savedAt: Date.now(),
        items: list
      }));
      return true;
    } catch (e) {
      // 配额超了：把旧数据留在内存里，但不假装成功
      return false;
    }
  }

  /* ---------- 数据清洗 ----------
   * 外部导入的东西不能直接信，字段类型统一箍一遍，
   * 免得一条脏数据把整个渲染打崩。
   */

  function normalize(item, selfIndex) {
    if (!item || typeof item !== 'object') return null;
    var out = {};

    out.title = item.title ? String(item.title).slice(0, 200) : '';
    out.text = item.text ? String(item.text) : '';

    var pics = [];
    if (Object.prototype.toString.call(item.images) === '[object Array]') {
      for (var i = 0; i < item.images.length && pics.length < 24; i++) {
        if (item.images[i]) pics.push(String(item.images[i]));
      }
    }
    if (!pics.length && item.image) pics.push(String(item.image));
    out.images = pics;
    out.image = pics[0] || '';

    out.tag = item.tag ? String(item.tag).slice(0, 24) : '未名';
    out.date = item.date ? String(item.date) : '';
    out.createdAt = item.createdAt ? String(item.createdAt) : '';

    if (item.color && /^#[0-9a-fA-F]{3,8}$/.test(String(item.color))) {
      out.color = String(item.color);
    }
    if (typeof item.size === 'number' && isFinite(item.size)) {
      out.size = Math.max(0.5, Math.min(2.6, item.size));
    }
    if (typeof item.cluster === 'number') out.cluster = item.cluster;

    /* 记忆互连：links 存的是「对方在这份列表里的下标」。
     * 为什么用下标而不是 id —— 整个应用都以数组下标寻址
     * （openPanel(index) / data-i / homeArr[i*3]），引 id 要动的面太大。
     * 代价是删条目时下标会漂，所以 removeAt() 里必须跟着重映射。 */
    var links = [];
    if (Object.prototype.toString.call(item.links) === '[object Array]') {
      var seen = {};
      for (var j = 0; j < item.links.length && links.length < LINK_MAX; j++) {
        var v = item.links[j];
        if (typeof v !== 'number' || !isFinite(v)) continue;   // 吃掉 "3" / null / NaN
        v = Math.floor(v);
        if (v < 0 || v >= LINK_INDEX_MAX) continue;            // 越界
        if (v === selfIndex) continue;                         // 自指：弧线会退化成 NaN 顶点
        if (seen[v]) continue;                                 // 重复
        seen[v] = 1;
        links.push(v);
      }
      links.sort(function (a, b) { return a - b; });
    }
    out.links = links;

    return out;
  }

  function normalizeList(arr) {
    var out = [];
    if (!Array.isArray(arr)) return out;

    // 旧下标 → 新下标。被丢弃的条目记 -1，指过去的连线要跟着断。
    var remap = [];
    for (var i = 0; i < arr.length; i++) {
      var n = normalize(arr[i], i);
      if (n && (n.title || n.text)) {
        remap[i] = out.length;
        out.push(n);
      } else {
        remap[i] = -1;
      }
    }

    // 重映射连线。不这么做的话，中间丢一条脏数据，后面所有连线都会指错人。
    for (var k = 0; k < out.length; k++) {
      var src = out[k].links;
      if (!src || !src.length) continue;
      var dst = [];
      for (var m = 0; m < src.length; m++) {
        var t = remap[src[m]];
        if (typeof t === 'number' && t >= 0 && t !== k) dst.push(t);
      }
      out[k].links = dst;
    }

    return out;
  }

  /* ---------- 统一接口 ---------- */

  function load() {
    if (cache) return cache;
    var local = readLocal();
    if (local && local.length) {
      cache = normalizeList(local);
      backend = 'local';
    } else {
      cache = null;
    }
    return cache;
  }

  /** memories.js 里的原始数据。第一次读到时存一份快照，
   *  因为 boot()/save() 会把 window.MEMORIES 换成编辑后的版本，
   *  不留快照的话 reset() 就"回不到最初"了。 */
  var seedSnapshot = null;

  function fallbackList() {
    if (seedSnapshot) return seedSnapshot;
    var raw = window.MEMORIES;
    seedSnapshot = Array.isArray(raw) ? raw.slice() : [];
    return seedSnapshot;
  }

  /** 启动时调用：本地存过就用本地的，但数据文件换了内容时以文件为准 */
  function boot() {
    var fileList = Array.isArray(window.MEMORIES) ? window.MEMORIES : [];
    var fileVer = fingerprint(fileList);
    var storedVer = readVer();
    var local = load();

    var useLocal = false;
    if (local && local.length) {
      if (storedVer) {
        // 有版号：一致就用本地的（文件没动过）
        useLocal = (storedVer === fileVer);
      } else {
        // 老版本升级上来的，没有版号。同源（条数、首尾标题都对得上）才认本地，
        // 否则当作"用户刚换过数据文件"，让文件胜出。
        useLocal = local.length === fileList.length &&
          (!fileList.length ||
            ((local[0] && fileList[0] && local[0].title === fileList[0].title) &&
             (local[local.length - 1] && fileList[fileList.length - 1] &&
              local[local.length - 1].title === fileList[fileList.length - 1].title)));
      }
    }

    if (useLocal) {
      window.MEMORIES = local;
      window.__SEA_REPO_BACKEND__ = 'local';
      cache = normalizeList(local);
      writeVer(fileVer);
      return window.MEMORIES;
    }

    // 本地那份和数据文件对不上：先备份，再从文件重建。
    // 直接删掉太狠了 —— 万一里面是用户手写而还没导出的东西。
    if (local && local.length) {
      try {
        var bakKey = KEY + '.bak.' + String(storedVer || 'pre').replace(/[^\w.-]/g, '').slice(0, 24);
        if (!window.localStorage.getItem(bakKey)) {
          window.localStorage.setItem(bakKey, JSON.stringify({
            schema: SCHEMA, savedAt: Date.now(), items: local
          }));
        }
      } catch (e) { }
    }

    cache = normalizeList(fileList);
    window.MEMORIES = cache;
    window.__SEA_REPO_BACKEND__ = backend;
    // 快照要认准"文件里那份"，不能被上面写回的本地数据带偏 ——
    // reset() 的语义是回到 memories.js，不是回到上一次的本地状态。
    seedSnapshot = normalizeList(fileList.slice());
    if (backend === 'local' && cache.length) {
      writeLocal(cache);
      writeVer(fileVer);
    }
    return window.MEMORIES;
  }

  function list() {
    if (!cache) load();
    if (!cache) cache = normalizeList(fallbackList());
    return cache;
  }

  function save(arr) {
    var clean = normalizeList(arr);
    cache = clean;
    window.MEMORIES = clean;
    if (!hasLocal) return false;
    return writeLocal(clean);
  }

  function upsert(item, index) {
    var arr = list().slice();
    var known = (typeof index === 'number' && index >= 0 && index < arr.length) ? index : undefined;

    /* 只提交了正文的调用方（录入页只认识表单字段）不该顺手抹掉连线：
     * 没传 links 就沿用原来那份，传了空数组才算真的要清空。 */
    var src = item;
    if (known !== undefined && item && typeof item === 'object' && item.links === undefined) {
      src = {};
      for (var f in item) {
        if (Object.prototype.hasOwnProperty.call(item, f)) src[f] = item[f];
      }
      src.links = (arr[known] && arr[known].links) || [];
    }

    var n = normalize(src, known);
    if (!n) return arr;
    if (known !== undefined) {
      arr[known] = n;
    } else {
      arr.push(n);
    }
    save(arr);
    return arr;
  }

  function removeAt(index) {
    var arr = list().slice();
    if (index >= 0 && index < arr.length) {
      arr.splice(index, 1);

      /* 下标型存储的代价在这里：删掉一条，后面所有连线都要挪一位。
       * 漏掉这一步，数据不会立刻坏，但会在几天后开始「连错人」——
       * 所以 test/repo.test.js 里有两个用例死守这段。 */
      for (var i = 0; i < arr.length; i++) {
        var ls = arr[i].links;
        if (!ls || !ls.length) continue;
        var keep = [];
        for (var j = 0; j < ls.length; j++) {
          var v = ls[j];
          if (v === index) continue;              // 指向被删的那条 → 断掉
          if (v > index) v -= 1;                  // 后面的整体前移
          if (v !== i) keep.push(v);              // 挪完变成自指的，也断掉
        }
        arr[i].links = keep;
      }
    }
    save(arr);
    return arr;
  }

  /* ---------- 记忆互连 ----------
   * 关系没有方向：A 连 B 等于 B 连 A，两侧都要写。
   * 只写一侧的话，下次从 B 点开就看不到这条线了。
   */

  function addOneWay(arr, from, to) {
    var ls = arr[from].links || [];
    if (ls.indexOf(to) >= 0 || ls.length >= LINK_MAX) return;
    ls.push(to);
    ls.sort(function (x, y) { return x - y; });
    arr[from].links = ls;
  }

  function link(a, b) {
    var arr = list().slice();
    if (a === b) return arr;
    if (a < 0 || b < 0 || a >= arr.length || b >= arr.length) return arr;
    addOneWay(arr, a, b);
    addOneWay(arr, b, a);
    save(arr);
    return arr;
  }

  function unlink(a, b) {
    var arr = list().slice();
    var pairs = [[a, b], [b, a]];
    for (var i = 0; i < 2; i++) {
      var from = pairs[i][0], to = pairs[i][1];
      if (from < 0 || from >= arr.length) continue;
      var ls = arr[from].links || [];
      var at = ls.indexOf(to);
      if (at >= 0) ls.splice(at, 1);
      arr[from].links = ls;
    }
    save(arr);
    return arr;
  }

  function reset() {
    if (hasLocal) {
      try {
        window.localStorage.removeItem(KEY);
        window.localStorage.removeItem(META_KEY);
        window.localStorage.removeItem(VER_KEY);
      } catch (e) { /* 忽略 */ }
    }
    // 从快照重新洗一份，避免调用方改到快照本身
    cache = normalizeList(fallbackList());
    window.MEMORIES = cache;
    if (cache.length) writeVer(fingerprint(cache));
    return cache;
  }

  function count() {
    return list().length;
  }

  function savedAt() {
    if (!hasLocal) return 0;
    try {
      var raw = window.localStorage.getItem(KEY);
      if (!raw) return 0;
      var d = JSON.parse(raw);
      return (d && d.savedAt) || 0;
    } catch (e) {
      return 0;
    }
  }

  /* ---------- 明文导入导出 ---------- */

  function exportJSON() {
    return JSON.stringify({
      app: 'thalassa',
      schema: SCHEMA,
      exportedAt: new Date().toISOString(),
      count: list().length,
      items: list()
    }, null, 2);
  }

  /* ---------- 写成一份能直接双击打开的 memories.js ----------
   *
   * 为什么不用 JSON.stringify 整体转：这份文件是给人改的。
   * 正文挤成一行带 \n 的字符串，看着累，改一个错字得数转义符。
   * 所以正文走模板字符串，保持换行；其余字段照常。
   *
   * 导出之后它既是备份，也是可以直接提交到仓库的那一份 ——
   * 照片路径在这一步由上层替换（idb: 引用 → assets/xxx.jpg）。
   */
  function sourceLiteral(s) {
    return '`' + String(s)
      .replace(/\\/g, '\\\\')
      .replace(/`/g, '\\`')
      .replace(/\$\{/g, '\\${') + '`';
  }

  function itemToSource(m, pad) {
    var p = pad || '    ';
    var out = [];
    out.push(p + 'title: ' + JSON.stringify(m.title || ''));
    out.push(p + 'text: ' + sourceLiteral(m.text || ''));

    var pics = [];
    if (Object.prototype.toString.call(m.images) === '[object Array]' && m.images.length) {
      pics = m.images.slice();
    } else if (m.image) {
      pics = [m.image];
    }
    if (pics.length === 1) out.push(p + 'image: ' + JSON.stringify(pics[0]));
    else if (pics.length > 1) out.push(p + 'images: [' + pics.map(function (x) { return JSON.stringify(x); }).join(', ') + ']');
    else out.push(p + 'image: ""');

    out.push(p + 'tag: ' + JSON.stringify(m.tag || '未名'));
    if (m.createdAt) out.push(p + 'createdAt: ' + JSON.stringify(m.createdAt));
    if (m.date) out.push(p + 'date: ' + JSON.stringify(m.date));
    if (m.color) out.push(p + 'color: ' + JSON.stringify(m.color));
    if (typeof m.size === 'number' && m.size !== 1) out.push(p + 'size: ' + m.size);
    if (m.links && m.links.length) out.push(p + 'links: [' + m.links.join(', ') + ']');

    return '  {\n' + out.join(',\n') + '\n  }';
  }

  function toSource(arr) {
    var items = Array.isArray(arr) ? arr : list();
    var today = new Date().toISOString().slice(0, 10);
    return '/* 由「识海」导出 —— ' + today + ' · 共 ' + items.length + ' 条\n' +
      ' * 这一份可以直接双击 index.html 打开，也可以提交到你自己的仓库。\n' +
      ' * 照片已落进 assets/，路径相对 index.html。 */\n\n' +
      'window.MEMORIES = [\n' +
      items.map(function (m) { return itemToSource(m); }).join(',\n') +
      '\n];\n';
  }

  function importJSON(text) {
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('不是有效的 JSON 文件');
    }
    // 兼容三种：{items:[]} / 裸数组 / 就是 memories.js 里那段数组
    var arr = Array.isArray(data) ? data : (data && data.items);
    if (!Array.isArray(arr)) throw new Error('文件里找不到记忆数组');
    var clean = normalizeList(arr);
    if (!clean.length) throw new Error('文件里没有可用的记忆');
    save(clean);
    return clean.length;
  }

  /* ---------- 加密包（.sea）----------
   * PBKDF2-SHA256 派生 256 位密钥 → AES-GCM 加密整包 JSON。
   * 与只存摘要的门锁不同，这里正文是真的密文，没有短语打不开。
   */

  // 注意：这个值必须是 2 的幂。文件头里只存了一个字节的指数（2^n），
  // 导出/导入两侧靠它还原迭代次数，不是 2 的幂就会算出不同的密钥，
  // 结果是"自己导出的包自己也打不开"。
  var KDF_ITER = 262144;          // 2^18
  var SEAL_MAGIC = 'SEA1';

  function subtle() {
    return (window.crypto && window.crypto.subtle) ? window.crypto.subtle : null;
  }

  function deriveKey(pass, salt, iter) {
    var enc = new TextEncoder();
    return subtle().importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey'])
      .then(function (base) {
        return subtle().deriveKey(
          { name: 'PBKDF2', salt: salt, iterations: iter, hash: 'SHA-256' },
          base,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        );
      });
  }

  function packBuffer(magic, salt, iv, cipher) {
    // 4 字节魔数 + 1 字节迭代指数 + 16 字节盐 + 12 字节 IV + 密文
    var head = new Uint8Array(4 + 1 + 16 + 12);
    for (var i = 0; i < 4; i++) head[i] = magic.charCodeAt(i);
    head[4] = Math.round(Math.log(KDF_ITER) / Math.log(2));
    head.set(salt, 5);
    head.set(iv, 21);
    var out = new Uint8Array(head.length + cipher.byteLength);
    out.set(head, 0);
    out.set(new Uint8Array(cipher), head.length);
    return out.buffer;
  }

  function exportSealed(pass) {
    if (!subtle() || !window.crypto.getRandomValues) {
      return Promise.reject(new Error('当前环境不支持 WebCrypto（需要 https 或 localhost）'));
    }
    if (!pass || String(pass).length < 4) {
      return Promise.reject(new Error('短语至少 4 位'));
    }
    var salt = window.crypto.getRandomValues(new Uint8Array(16));
    var iv = window.crypto.getRandomValues(new Uint8Array(12));
    var plain = new TextEncoder().encode(exportJSON());
    return deriveKey(String(pass), salt, KDF_ITER).then(function (key) {
      return subtle().encrypt({ name: 'AES-GCM', iv: iv }, key, plain);
    }).then(function (cipher) {
      return packBuffer(SEAL_MAGIC, salt, iv, cipher);
    });
  }

  function importSealed(buffer, pass) {
    if (!subtle()) {
      return Promise.reject(new Error('当前环境不支持 WebCrypto（需要 https 或 localhost）'));
    }
    var bytes = new Uint8Array(buffer);
    if (bytes.length < 40) return Promise.reject(new Error('文件太小，不像识海加密包'));
    var magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (magic !== SEAL_MAGIC) return Promise.reject(new Error('不是识海加密包'));
    var iter = Math.pow(2, bytes[4]);
    var salt = bytes.slice(5, 21);
    var iv = bytes.slice(21, 33);
    var cipher = bytes.slice(33);
    return deriveKey(String(pass), salt, iter).then(function (key) {
      return subtle().decrypt({ name: 'AES-GCM', iv: iv }, key, cipher);
    }).then(function (plain) {
      return importJSON(new TextDecoder().decode(plain));
    }).catch(function (e) {
      if (e && e.message && e.message.indexOf('记忆') >= 0) throw e;
      throw new Error('短语不对，或者文件已损坏');
    });
  }

  /* ---------- 订阅：数据变了通知界面 ---------- */

  var listeners = [];

  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](list()); } catch (e) { /* 单个监听器出错不影响别人 */ }
    }
  }

  /* 包一层，任何写法改动都广播 */
  var rawSave = save;
  save = function (arr) {
    var r = rawSave(arr);
    emit();
    return r;
  };

  return {
    KEY: KEY,
    SCHEMA: SCHEMA,
    LINK_MAX: LINK_MAX,
    get backend() { return backend; },
    get available() { return hasLocal; },
    boot: boot,
    list: list,
    save: save,
    upsert: upsert,
    removeAt: removeAt,
    link: link,
    unlink: unlink,
    reset: reset,
    count: count,
    savedAt: savedAt,
    exportJSON: exportJSON,
    toSource: toSource,
    importJSON: importJSON,
    exportSealed: exportSealed,
    importSealed: importSealed,
    onChange: onChange,
    normalize: normalize,
    canSeal: !!subtle()
  };
})();
