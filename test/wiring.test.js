/**
 * index.html 的接线检查
 * 跑法：node --test
 *
 * 纯静态项目最典型的事故不是逻辑写错，是"改了文件名忘了改引用"——
 * 页面双击打开就是一片黑，控制台一行红字，而且没有任何构建步骤会提醒你。
 *
 * 这里只验三件能自动验的事：
 *   1. 引用的本地文件真的存在；
 *   2. 依赖顺序对（layout.js 必须在 main.js 之前，否则 main.js 一开局就取到 undefined）；
 *   3. 加载的脚本没有重复（重复加载会跑两遍初始化）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** 取出页面引用的本地资源（跳过 http(s):// 和 // 开头的外链） */
function localRefs() {
  const refs = [];
  const re = /<(script|link)\b[^>]*?(?:src|href)="([^"]+)"[^>]*>/gi;
  let m;
  while ((m = re.exec(HTML))) {
    const url = m[2];
    if (/^(https?:)?\/\//i.test(url) || url.startsWith('data:')) continue;
    refs.push({ tag: m[1].toLowerCase(), url: url.replace(/^\.\//, '') });
  }
  return refs;
}

const order = (name) => {
  const refs = localRefs();
  for (let i = 0; i < refs.length; i++) {
    if (refs[i].url === name) return i;
  }
  return -1;
};

describe('index.html 引用接线', () => {
  it('引用的本地文件都真实存在（改名后忘了改引用的第一道防线）', () => {
    const missing = localRefs()
      .map((r) => r.url)
      .filter((url) => !fs.existsSync(path.join(ROOT, url)));
    assert.deepEqual(missing, [], `这些文件不存在：${missing.join('、')}`);
  });

  it('layout.js 在 main.js 之前加载', () => {
    const layout = order('js/layout.js');
    const main = order('js/main.js');
    assert.notEqual(layout, -1, '页面根本没引 layout.js');
    assert.notEqual(main, -1, '页面根本没引 main.js');
    assert.ok(layout < main, 'layout.js 必须排在 main.js 前面，否则主程序一开局就取到 undefined');
  });

  it('three.js 在 main.js 之前加载', () => {
    assert.ok(order('vendor/three.min.js') < order('js/main.js'));
  });

  it('repo.js 在 memories.js 之前（boot 要用它）', () => {
    const repo = order('js/repo.js');
    const data = order('data/memories.js');
    if (data === -1) return;                 // 页面没内联数据文件就跳过
    assert.ok(repo < data, 'repo.js 必须排在 data/memories.js 前面');
  });

  it('同一个脚本不会加载两遍', () => {
    const srcs = localRefs().filter((r) => r.tag === 'script').map((r) => r.url);
    const seen = new Set();
    const dup = [];
    for (const s of srcs) {
      if (seen.has(s)) dup.push(s);
      seen.add(s);
    }
    assert.deepEqual(dup, [], `重复加载：${dup.join('、')}`);
  });

  it('页面里的样式表存在且只有一份', () => {
    const css = localRefs().filter((r) => r.tag === 'link' && r.url.endsWith('.css'));
    assert.equal(css.length, 1, '样式表数量不对');
    assert.ok(fs.existsSync(path.join(ROOT, css[0].url)));
  });
});

describe('布局逻辑只有一份实现', () => {
  const mainSrc = fs.readFileSync(path.join(ROOT, 'js/main.js'), 'utf8');

  it('main.js 不再自己算斐波那契转角（应该在 layout.js 里）', () => {
    assert.ok(!mainSrc.includes('Math.PI * (3 - Math.sqrt(5))'),
      'main.js 里又写了一份转角常数，会和 layout.js 分家');
  });

  it('main.js 不再自己算低差异序列常数', () => {
    assert.ok(!mainSrc.includes('0.7548776662466927'),
      'main.js 里又写了一份半径错开常数');
  });

  it('main.js 不直接调用 Math.random 分配记忆位置', () => {
    // 背景星可以用随机，记忆位置不行：位置是用户认得的东西，刷新必须不变
    const placeSection = mainSrc.slice(
      mainSrc.indexOf('function computeHomes'),
      mainSrc.indexOf('computeHomes();')
    );
    assert.ok(placeSection.length > 0, '找不到 computeHomes');
    assert.ok(!placeSection.includes('Math.random()'),
      'computeHomes 里用了随机数，刷新后记忆会跑位');
  });
});
