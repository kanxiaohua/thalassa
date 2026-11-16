/**
 * js/lock.js 的单元测试
 * 跑法：node --test
 *
 * 重点守一件事：**同一个短语，在有没有 crypto.subtle 的环境里必须算出同一个哈希**。
 * 手机上经局域网 http:// 打开时不是安全上下文，crypto.subtle 不存在；
 * 而短语多半是在电脑上（file:// 或 127.0.0.1，安全上下文）设的。
 * 两边算式不一致，表现就是"密码明明没错，却一直说短语不对"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto, pbkdf2Sync } from 'node:crypto';

const SRC = fs.readFileSync(new URL('../js/lock.js', import.meta.url), 'utf8');

const iter = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);

/**
 * 造一个最小世界。subtle=false 时模拟手机经 http 打开的局面：
 * window.crypto.getRandomValues 还在，subtle 是 undefined。
 */
function makeWorld({ subtle = true, store = new Map() } = {}) {
  const document = {
    readyState: 'complete',
    body: { classList: { add() { }, remove() { }, contains() { return false; } } },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() { },
    removeEventListener() { },
    dispatchEvent() { }
  };

  const crypto = {
    getRandomValues: (a) => webcrypto.getRandomValues(a)
  };
  if (subtle) crypto.subtle = webcrypto.subtle;

  const window = {
    crypto,
    document,
    location: { reload() { } },
    addEventListener() { },
    removeEventListener() { },
    dispatchEvent() { },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); }
    },
    confirm: () => false
  };
  window.window = window;

  const ctx = vm.createContext({
    window,
    document,
    crypto,
    localStorage: window.localStorage,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Uint32Array,
    DataView,
    Promise,
    Math,
    Date,
    JSON,
    Object,
    Array,
    String,
    Number,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,   // 自动上锁的定时器，测试里不真跑，否则进程不退出
    clearInterval() { },
    console,
    CustomEvent: class { constructor(t) { this.type = t; } }
  });
  vm.runInContext(SRC, ctx, { filename: 'lock.js' });
  return window.SeaLock;
}

const hex = (u8) => Buffer.from(u8).toString('hex');

test('pbkdf2 与 Node 实现结果一致（纯 JS 那条路不能算错）', async () => {
  const lock = makeWorld({ subtle: false });
  const salt = iter(16);
  const got = await lock._derive('识海', salt, 1000, 'pbkdf2');
  const want = pbkdf2Sync(Buffer.from('识海', 'utf8'), Buffer.from(salt), 1000, 32, 'sha256');
  assert.equal(hex(got), want.toString('hex'));
});

test('有 subtle 和没 subtle，pbkdf2 结果必须相同', async () => {
  const salt = iter(16);
  const rich = await makeWorld({ subtle: true })._derive('same pass', salt, 500, 'pbkdf2');
  const poor = await makeWorld({ subtle: false })._derive('same pass', salt, 500, 'pbkdf2');
  assert.equal(hex(poor), hex(rich));
});

test('sha256iter 也不依赖 subtle', async () => {
  const salt = iter(16);
  const rich = await makeWorld({ subtle: true })._derive('same pass', salt, 300, 'sha256iter');
  const poor = await makeWorld({ subtle: false })._derive('same pass', salt, 300, 'sha256iter');
  assert.equal(hex(poor), hex(rich));
});

test('错短语算出来的东西不一样（防止"什么都放行"）', async () => {
  const salt = iter(16);
  const lock = makeWorld({ subtle: false });
  const a = await lock._derive('对的那个', salt, 300, 'pbkdf2');
  const b = await lock._derive('错的那个', salt, 300, 'pbkdf2');
  assert.notEqual(hex(a), hex(b));
});

test('不同盐出不同结果', async () => {
  const lock = makeWorld({ subtle: false });
  const a = await lock._derive('pass', iter(16), 300, 'pbkdf2');
  const salt2 = iter(16);
  salt2[0] ^= 0xff;
  const b = await lock._derive('pass', salt2, 300, 'pbkdf2');
  assert.notEqual(hex(a), hex(b));
});

test('轮数变化会改变结果（轮数存进记录里，不能写死）', async () => {
  const lock = makeWorld({ subtle: false });
  const salt = iter(16);
  const a = await lock._derive('pass', salt, 300, 'pbkdf2');
  const b = await lock._derive('pass', salt, 301, 'pbkdf2');
  assert.notEqual(hex(a), hex(b));
});
