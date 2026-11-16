/* =====================================================================
 *  识海 · 照片仓  ——  把照片存进浏览器，而不是存成文件路径
 * ---------------------------------------------------------------------
 *  为什么要有这个：
 *    以前加一张照片，得先打开 录入.html、拖图、选文件夹、导出、
 *    再回主页面刷新。麻烦的根子不在界面，在存储 ——
 *    localStorage 只有 5MB，一张压缩过的照片转 base64 就吃掉 250KB，
 *    存十几张就满，满了还是静默失败。所以照片必须换个地方放。
 *
 *  这里用 IndexedDB：容量按硬盘算，不用任何权限，手机上也能用。
 *  照片在记忆数据里写成一个引用字符串 "idb:<id>"，
 *  image / images 字段照旧是字符串，数据层与导出逻辑都不用改结构。
 *
 *  代价：数据在浏览器里，清缓存就没了。所以「导出到文件夹」不是可选项，
 *  它是唯一的正经备份路径，界面上要说得比现在更明白。
 *
 *  用法：
 *    SeaPhotos.put(file)          → Promise<{ref, w, h, bytes}>   收一张
 *    SeaPhotos.url(ref)           → Promise<string>   "idb:x" → blob URL，普通路径原样返回
 *    SeaPhotos.remove(ref)        → Promise          丢掉（取消编辑时清垃圾）
 *    SeaPhotos.usage()            → Promise<{count, bytes}>       占了多少
 *    SeaPhotos.isRef(v)           是否是我们自己的引用
 *    SeaPhotos.fitSize(w, h, max) 纯函数，等比缩到长边不超过 max
 * ===================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SeaPhotos = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var DB_NAME = 'sea.photos.v1';
  var DB_VER = 1;
  var STORE = 'blobs';
  var PREFIX = 'idb:';

  var MAX_EDGE = 1280;      // 长边上限。再大对观感没帮助，只是白占空间
  var QUALITY = 0.82;       // JPEG 质量。0.82 在手机屏上看不出压缩痕迹
  var SKIP_COMPRESS = /^image\/(gif|svg\+xml)$/i;   // 动图与矢量不该被栅格化

  /* ---------------- 纯函数（node 里也能跑，无 DOM 依赖） ---------------- */

  function isRef(v) {
    return typeof v === 'string' && v.indexOf(PREFIX) === 0;
  }

  function refId(v) {
    return isRef(v) ? v.slice(PREFIX.length) : '';
  }

  function makeRef(id) {
    return PREFIX + String(id);
  }

  /* 等比缩到长边不超过 max。不放大 —— 小图放大只会变糊，还多占空间。 */
  function fitSize(w, h, max) {
    w = Number(w) || 0;
    h = Number(h) || 0;
    var edge = Number(max) || MAX_EDGE;
    if (w <= 0 || h <= 0) return { w: 1, h: 1, scale: 1 };
    var scale = Math.min(1, edge / Math.max(w, h));
    return {
      w: Math.max(1, Math.round(w * scale)),
      h: Math.max(1, Math.round(h * scale)),
      scale: scale
    };
  }

  function humanBytes(n) {
    if (!n) return '0';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function uid() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /* ---------------- IndexedDB ---------------- */

  var dbPromise = null;
  var dbBroken = false;

  function hasIdb() {
    try { return typeof indexedDB !== 'undefined' && !!indexedDB.open; }
    catch (e) { return false; }
  }

  function db() {
    if (dbBroken) return Promise.reject(new Error('这台浏览器不给用 IndexedDB'));
    if (!hasIdb()) { dbBroken = true; return Promise.reject(new Error('这台浏览器不给用 IndexedDB')); }
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VER); }
      catch (e) { dbBroken = true; reject(e); return; }
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () {
        /* file:// 打开的页面里，有些浏览器会拒绝给 storage。
         * 这种情况记下来，别每次调用都重试一遍。 */
        dbBroken = true;
        reject(req.error || new Error('打不开照片仓'));
      };
      req.onblocked = function () { reject(new Error('照片仓被别的标签页占着')); };
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(STORE, mode);
        var store = t.objectStore(STORE);
        var out;
        try { out = fn(store); } catch (e) { reject(e); return; }
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('照片仓事务中断')); };
      });
    });
  }

  function getRecord(id) {
    return tx('readonly', function (store) { return store.get(id); }).then(function (rec) {
      return rec || null;
    });
  }

  /* ---------------- 压缩 ---------------- */

  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var src = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var size = fitSize(img.naturalWidth, img.naturalHeight, MAX_EDGE);
        var cv = document.createElement('canvas');
        cv.width = size.w;
        cv.height = size.h;
        var ctx = cv.getContext('2d');
        // JPEG 没有透明通道：不铺底的话，PNG 的透明区会变成黑块
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size.w, size.h);
        ctx.drawImage(img, 0, 0, size.w, size.h);
        URL.revokeObjectURL(src);
        cv.toBlob(function (blob) {
          if (!blob) { reject(new Error('压缩失败')); return; }
          resolve({ blob: blob, w: size.w, h: size.h });
        }, 'image/jpeg', QUALITY);
      };
      img.onerror = function () {
        URL.revokeObjectURL(src);
        reject(new Error('这张图读不出来'));
      };
      img.src = src;
    });
  }

  function put(file) {
    if (!file || !file.type || file.type.indexOf('image/') !== 0) {
      return Promise.reject(new Error('不是图片'));
    }
    var work = SKIP_COMPRESS.test(file.type)
      ? Promise.resolve({ blob: file, w: 0, h: 0 })
      : shrink(file);

    return work.then(function (r) {
      var id = uid();
      var rec = {
        id: id,
        blob: r.blob,
        name: file.name || '',
        // 记压缩之后的真实类型：原图可能是 PNG，但存下来的是 JPEG，
        // 导出时按这个决定扩展名，记错了会写出一个「叫 .png 的 JPEG」
        type: (r.blob && r.blob.type) || file.type,
        w: r.w,
        h: r.h,
        bytes: r.blob.size,
        at: Date.now()
      };
      return tx('readwrite', function (store) { store.put(rec); }).then(function () {
        return { ref: makeRef(id), w: r.w, h: r.h, bytes: rec.bytes };
      });
    });
  }

  function remove(ref) {
    var id = refId(ref);
    if (!id) return Promise.resolve(false);
    deleteUrl(ref);
    return tx('readwrite', function (store) { store['delete'](id); }).then(function () { return true; });
  }

  /* ---------------- 引用 → 可直接放进 <img src> 的地址 ---------------- */

  var urls = {};

  function deleteUrl(ref) {
    if (urls[ref]) {
      try { URL.revokeObjectURL(urls[ref]); } catch (e) { }
      delete urls[ref];
    }
  }

  /**
   * 普通路径（"assets/a.jpg"）原样返回；"idb:xxx" 从仓里取出 blob 转成
   * object URL，并在本次会话里缓存 —— 同一张图反复打开面板不必反复读盘。
   * 找不到记录时返回空串，调用方走占位图那条路。
   */
  function url(ref) {
    if (!isRef(ref)) return Promise.resolve(ref || '');
    if (urls[ref]) return Promise.resolve(urls[ref]);
    return getRecord(refId(ref)).then(function (rec) {
      if (!rec || !rec.blob) return '';
      var u = URL.createObjectURL(rec.blob);
      urls[ref] = u;
      return u;
    }).catch(function () { return ''; });
  }

  /** 同步版本：只在已经解析过的情况下有用（渲染循环里不能 await）。 */
  function urlNow(ref) {
    if (!isRef(ref)) return ref || '';
    return urls[ref] || '';
  }

  /** 预先解析一批，渲染前调一次，之后全走 urlNow。 */
  function warm(refs) {
    var uniq = [];
    for (var i = 0; i < refs.length; i++) {
      var r = refs[i];
      if (isRef(r) && !urls[r] && uniq.indexOf(r) < 0) uniq.push(r);
    }
    if (!uniq.length) return Promise.resolve(0);
    return Promise.all(uniq.map(url)).then(function () { return uniq.length; });
  }

  /** 直接拿原记录（导出时要写文件，用得上 blob 与 type） */
  function blobOf(ref) {
    var id = refId(ref);
    if (!id) return Promise.resolve(null);
    return getRecord(id).catch(function () { return null; });
  }

  function usage() {
    return tx('readonly', function (store) { return store.getAll(); }).then(function (all) {
      var list = all || [];
      var bytes = 0;
      for (var i = 0; i < list.length; i++) bytes += (list[i].bytes || 0);
      return { count: list.length, bytes: bytes, human: humanBytes(bytes) };
    }).catch(function () { return { count: 0, bytes: 0, human: '0' }; });
  }

  function supported() {
    return hasIdb() && !dbBroken;
  }

  return {
    put: put,
    url: url,
    urlNow: urlNow,
    warm: warm,
    remove: remove,
    blobOf: blobOf,
    usage: usage,
    supported: supported,
    isRef: isRef,
    refId: refId,
    makeRef: makeRef,
    fitSize: fitSize,
    humanBytes: humanBytes,
    _limits: { MAX_EDGE: MAX_EDGE, QUALITY: QUALITY }
  };
});
