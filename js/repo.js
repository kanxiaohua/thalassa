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
  var SCHEMA = 1;

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

  function normalize(item) {
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

    return out;
  }

  function normalizeList(arr) {
    var out = [];
    if (!Array.isArray(arr)) return out;
    for (var i = 0; i < arr.length; i++) {
      var n = normalize(arr[i]);
      if (n && (n.title || n.text)) out.push(n);
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

  /** 启动时调用：如果本地存过，就用本地的覆盖 memories.js 的内容 */
  function boot() {
    var local = load();
    if (local && local.length) {
      window.MEMORIES = local;
      window.__SEA_REPO_BACKEND__ = 'local';
    } else {
      // 第一次打开，把 memories.js 的内容当作初始数据
      cache = normalizeList(fallbackList());
      window.__SEA_REPO_BACKEND__ = backend;
      if (backend === 'local' && cache.length) writeLocal(cache);
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
    var n = normalize(item);
    if (!n) return arr;
    if (typeof index === 'number' && index >= 0 && index < arr.length) {
      arr[index] = n;
    } else {
      arr.push(n);
    }
    save(arr);
    return arr;
  }

  function removeAt(index) {
    var arr = list().slice();
    if (index >= 0 && index < arr.length) arr.splice(index, 1);
    save(arr);
    return arr;
  }

  function reset() {
    if (hasLocal) {
      try {
        window.localStorage.removeItem(KEY);
        window.localStorage.removeItem(META_KEY);
      } catch (e) { /* 忽略 */ }
    }
    // 从快照重新洗一份，避免调用方改到快照本身
    cache = normalizeList(fallbackList());
    window.MEMORIES = cache;
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
    get backend() { return backend; },
    get available() { return hasLocal; },
    boot: boot,
    list: list,
    save: save,
    upsert: upsert,
    removeAt: removeAt,
    reset: reset,
    count: count,
    savedAt: savedAt,
    exportJSON: exportJSON,
    importJSON: importJSON,
    exportSealed: exportSealed,
    importSealed: importSealed,
    onChange: onChange,
    normalize: normalize,
    canSeal: !!subtle()
  };
})();
