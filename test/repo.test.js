/**
 * js/repo.js 的单元测试
 * 跑法：node --test
 *
 * repo.js 是给浏览器写的（挂 window.SeaRepo），这里用 vm 造一个最小 window，
 * 把 localStorage 换成内存实现，crypto 用 Node 自带的 webcrypto。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const SRC = fs.readFileSync(new URL('../js/repo.js', import.meta.url), 'utf8');

const SEED = [
  { title: '第一次看见银河', text: '星星一颗颗亮起来。', tag: '夜空', createdAt: '2020-08-01' },
  { title: '外婆的桂花', text: '金色的花簌簌落下来。', tag: '家', createdAt: '2015-09-20' }
];

function makeWorld(seed = SEED) {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); }
  };
  const win = { localStorage, crypto: webcrypto, console, MEMORIES: JSON.parse(JSON.stringify(seed)) };
  win.window = win;

  const ctx = vm.createContext({
    window: win,
    localStorage,
    crypto: webcrypto,
    console,
    TextEncoder,
    TextDecoder
  });
  vm.runInContext(SRC, ctx);
  return { repo: win.SeaRepo, win, store };
}

test('boot：首次打开把 memories.js 当作初始数据并落盘', () => {
  const { repo, win, store } = makeWorld();
  const out = repo.boot();
  assert.equal(out.length, 2);
  assert.equal(repo.count(), 2);
  assert.equal(win.__SEA_REPO_BACKEND__, 'local');
  assert.ok(store.size > 0, '应该写进 localStorage');
});

test('savedAt：写过数据后有保存时间', () => {
  const { repo } = makeWorld();
  repo.boot();
  assert.ok(repo.savedAt() > 0);
});

test('upsert：新增后总数 +1，按索引更新时总数不变', () => {
  const { repo } = makeWorld();
  repo.boot();

  repo.upsert({ title: '新的一条', text: '刚写的' });
  assert.equal(repo.count(), 3);
  assert.equal(repo.list()[2].title, '新的一条');

  repo.upsert({ title: '改过的标题', text: '刚写的' }, 0);
  assert.equal(repo.count(), 3);
  assert.equal(repo.list()[0].title, '改过的标题');
});

test('upsert：脏数据被清洗成安全形状', () => {
  const { repo } = makeWorld();
  repo.boot();
  repo.upsert({ title: 123, text: null, tag: '', images: ['a.jpg', 0, 'b.jpg'], size: 99 });

  const it = repo.list()[repo.count() - 1];
  assert.equal(it.title, '123', '数字标题应转成字符串');
  assert.equal(it.text, '', 'null 正文应变成空串');
  assert.equal(it.tag, '未名', '空 tag 应有兜底');
  assert.deepEqual([...it.images], ['a.jpg', 'b.jpg'], '应过滤掉空图');
  assert.equal(it.image, 'a.jpg', 'image 取第一张');
  assert.ok(it.size <= 2.6, 'size 应被夹到上限');
});

test('upsert：非对象直接被忽略', () => {
  const { repo } = makeWorld();
  repo.boot();
  const before = repo.count();
  repo.upsert(null);
  repo.upsert('字符串');
  assert.equal(repo.count(), before);
});

test('removeAt：删掉指定下标，越界不报错', () => {
  const { repo } = makeWorld();
  repo.boot();
  repo.removeAt(0);
  assert.equal(repo.count(), 1);
  assert.equal(repo.list()[0].title, '外婆的桂花');

  repo.removeAt(99);
  assert.equal(repo.count(), 1, '越界删除不该改变数据');
});

test('导出/导入往返：内容与原数据一致', () => {
  const { repo } = makeWorld();
  repo.boot();
  repo.upsert({ title: '第三条', text: '往返测试', tag: '测试', createdAt: '2024-01-01' });

  const json = repo.exportJSON();
  const parsed = JSON.parse(json);
  assert.equal(parsed.app, 'thalassa');
  assert.equal(parsed.count, 3);
  assert.equal(parsed.items.length, 3);

  // 换一个环境导入，模拟"换设备"
  const other = makeWorld([]);
  other.repo.boot();
  const n = other.repo.importJSON(json);
  assert.equal(n, 3);
  assert.equal(other.repo.count(), 3);
  assert.equal(other.repo.list()[1].title, '外婆的桂花');
  assert.equal(other.repo.list()[2].text, '往返测试');
});

test('导入：裸数组也能吃', () => {
  const { repo } = makeWorld([]);
  repo.boot();
  const n = repo.importJSON(JSON.stringify([{ title: '只有一条', text: '正文' }]));
  assert.equal(n, 1);
  assert.equal(repo.list()[0].title, '只有一条');
});

test('导入：坏 JSON 与空数组都会明确报错', () => {
  const { repo } = makeWorld([]);
  repo.boot();
  assert.throws(() => repo.importJSON('这不是 json'), /JSON/);
  assert.throws(() => repo.importJSON('[]'), /没有可用/);
  assert.throws(() => repo.importJSON('{"foo":1}'), /找不到/);
});

test('加密包往返：短语对了能还原，错了打不开', async () => {
  const { repo } = makeWorld();
  repo.boot();
  repo.upsert({ title: '机密', text: '只有短语能看', tag: '私密' });

  const buf = await repo.exportSealed('my-secret-pass');
  // 跨 vm 边界，instanceof 会失效，按字节长度与魔数判断
  assert.equal(Object.prototype.toString.call(buf), '[object ArrayBuffer]');
  assert.ok(buf.byteLength > 40);

  // 头部魔数
  const head = new TextDecoder().decode(new Uint8Array(buf.slice(0, 4)));
  assert.equal(head, 'SEA1');

  const dst = makeWorld([]);
  dst.repo.boot();
  const n = await dst.repo.importSealed(buf, 'my-secret-pass');
  assert.equal(n, 3);
  assert.equal(dst.repo.list()[2].text, '只有短语能看');

  const wrong = makeWorld([]);
  wrong.repo.boot();
  await assert.rejects(() => wrong.repo.importSealed(buf, '错误短语'), /短语不对|损坏/);
});

test('加密包：短语太短直接拒绝', async () => {
  const { repo } = makeWorld();
  repo.boot();
  await assert.rejects(() => repo.exportSealed('ab'), /至少 4 位/);
});

test('加密包：不是加密包的文件被识别出来', async () => {
  const { repo } = makeWorld([]);
  repo.boot();
  const junk = new Uint8Array(64).fill(7).buffer;
  await assert.rejects(() => repo.importSealed(junk, 'whatever'), /不是识海加密包/);
});

test('reset：清空本地存储，回到 memories.js 的原始内容', () => {
  const { repo, win } = makeWorld();
  repo.boot();
  repo.upsert({ title: '临时', text: '待清' });
  assert.equal(repo.count(), 3);

  const back = repo.reset();
  assert.equal(back.length, 2, '应回到种子数据');
  assert.equal(win.__SEA_REPO_BACKEND__, 'local');
});

test('onChange：数据变化会通知订阅者', () => {
  const { repo } = makeWorld();
  repo.boot();
  let hits = 0;
  repo.onChange(() => { hits++; });
  repo.upsert({ title: '通知测试', text: 'x' });
  repo.removeAt(0);
  assert.ok(hits >= 2, '每次写入都应触发通知');
});

/* =====================================================================
 *  记忆互连（links）
 *  links 存的是对方在列表里的下标，所以这里一半用例在守「下标别错」。
 * ===================================================================== */

test('互连：老数据没有 links 字段，读出来是空数组', () => {
  const { repo } = makeWorld();
  repo.boot();
  assert.deepEqual([...repo.list()[0].links], [], '缺失字段应补成 []，不能是 undefined');
});

test('互连：脏 links 被清洗成合法整数数组', () => {
  const { repo } = makeWorld([]);
  repo.boot();
  repo.importJSON(JSON.stringify([
    { title: 'A', text: 'x', links: ['3', -1, 1.7, 999, null, 2, true] },
    { title: 'B', text: 'y' },
    { title: 'C', text: 'z' }
  ]));
  assert.deepEqual([...repo.list()[0].links], [1, 2], '1.7 取整为 1，其余全部丢掉');
});

test('互连：自指被丢弃', () => {
  const { repo } = makeWorld([]);
  repo.boot();
  repo.importJSON(JSON.stringify([
    { title: 'A', text: 'x', links: [0, 1] },
    { title: 'B', text: 'y' }
  ]));
  assert.deepEqual([...repo.list()[0].links], [1], '自己连自己会让弧线退化，必须丢');
});

test('互连：重复下标去重', () => {
  const { repo } = makeWorld([]);
  repo.boot();
  repo.importJSON(JSON.stringify([
    { title: 'A', text: 'x', links: [1, 1, 1] },
    { title: 'B', text: 'y' }
  ]));
  assert.deepEqual([...repo.list()[0].links], [1]);
});

test('互连：删中间一条，后面的连线整体前移', () => {
  const { repo } = makeWorld([]);
  repo.boot();
  repo.importJSON(JSON.stringify([
    { title: 'A', text: 'a', links: [1, 2, 3] },
    { title: 'B', text: 'b', links: [0] },
    { title: 'C', text: 'c', links: [0] },
    { title: 'D', text: 'd', links: [0] }
  ]));

  repo.removeAt(1);

  const l = repo.list();
  assert.equal(l.length, 3);
  assert.deepEqual([...l[0].links], [1, 2], 'A 原连 1/2/3，删掉 1 后应变成 1/2（C、D）');
  assert.equal(l[1].title, 'C');
  assert.equal(l[2].title, 'D');
  assert.deepEqual([...l[2].links], [0], 'D 的下标 3→2，连线本身不变');
});

test('互连：删掉一端，另一端的反向引用跟着断', () => {
  const { repo } = makeWorld([]);
  repo.boot();
  repo.importJSON(JSON.stringify([
    { title: 'A', text: 'a', links: [2] },
    { title: 'B', text: 'b' },
    { title: 'C', text: 'c', links: [0] }
  ]));

  repo.removeAt(2);
  assert.deepEqual([...repo.list()[0].links], [], 'C 没了，A 指向它的连线应消失');
});

test('互连：一条记忆最多连 12 条', () => {
  const items = [{ title: '0', text: 'x' }];
  const want = [];
  for (let i = 1; i <= 20; i++) {
    items.push({ title: String(i), text: 'x' });
    want.push(i);
  }
  items[0].links = want;

  const { repo } = makeWorld([]);
  repo.boot();
  repo.importJSON(JSON.stringify(items));
  assert.equal(repo.list()[0].links.length, 12, '超出上限的部分应被截断');
});

test('互连：导出再导入，连线不丢', () => {
  const { repo } = makeWorld([]);
  repo.boot();
  repo.importJSON(JSON.stringify([
    { title: 'A', text: 'a' },
    { title: 'B', text: 'b' },
    { title: 'C', text: 'c' }
  ]));
  repo.link(0, 2);

  const json = repo.exportJSON();
  const other = makeWorld([]);
  other.repo.boot();
  other.repo.importJSON(json);

  assert.deepEqual([...other.repo.list()[0].links], [2]);
  assert.deepEqual([...other.repo.list()[2].links], [0], '关系没有方向，两端都要还原');
});

test('互连：link 双向写入，unlink 双向清除', () => {
  const { repo } = makeWorld([]);
  repo.boot();
  repo.importJSON(JSON.stringify([
    { title: 'A', text: 'a' },
    { title: 'B', text: 'b' }
  ]));

  repo.link(0, 1);
  assert.deepEqual([...repo.list()[0].links], [1]);
  assert.deepEqual([...repo.list()[1].links], [0]);

  repo.unlink(0, 1);
  assert.deepEqual([...repo.list()[0].links], []);
  assert.deepEqual([...repo.list()[1].links], []);

  repo.link(0, 0);
  assert.deepEqual([...repo.list()[0].links], [], '连自己应当无效');
});

test('互连：录入页只提交正文时，不会抹掉原来的连线', () => {
  const { repo } = makeWorld([]);
  repo.boot();
  repo.importJSON(JSON.stringify([
    { title: 'A', text: 'a' },
    { title: 'B', text: 'b' }
  ]));
  repo.link(0, 1);

  // 模拟录入页：只认识表单字段，原样提交，不带 links
  repo.upsert({ title: 'A 改过标题', text: 'a', tag: '改过' }, 0);

  assert.equal(repo.list()[0].title, 'A 改过标题');
  assert.deepEqual([...repo.list()[0].links], [1], '连线应原样保留');
  assert.deepEqual([...repo.list()[1].links], [0], '对端也不该断');

  // 显式传空数组才是真的清空
  repo.upsert({ title: 'A 改过标题', text: 'a', links: [] }, 0);
  assert.deepEqual([...repo.list()[0].links], [], '显式清空应当生效');
});
