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
