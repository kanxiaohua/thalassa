/**
 * js/semantic.js 的单元测试
 * 跑法：node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../js/semantic.js');

const MEMS = [
  { title: '第一次看见银河', text: '我们把车停在国道旁，关掉车灯。星星一颗颗亮起来，银河横过整个天空。', tag: '夜空' },
  { title: '外婆的桂花', text: '院子里那棵桂花树，中秋前后开得最盛。金色的花簌簌落下来。', tag: '家' },
  { title: '凌晨四点的便利店', text: '加班到天亮前，便利店还亮着。关东煮的汤在冒泡。', tag: '城市' },
  { title: '海边的第七个浪', text: '浪一层一层地来，我数到第七个，忽然就不数了。海水凉得刺骨。', tag: '海' },
  { title: '雨天的旧书店', text: '下雨，钻进旧书店。纸页有霉味，老板在打瞌睡。', tag: '城市' }
];

test('分词：中文按二元组切开，丢掉标点与空白', () => {
  const t = S.tokenize('那年夏天，我们去看海。');
  assert.ok(t.length > 0, '应该切出词');
  assert.ok(t.every((w) => w.length >= 1), '没有空词');
  assert.ok(!t.some((w) => /[，。\s]/.test(w)), '不该保留标点空白');
});

test('分词：纯标点/空白返回空数组', () => {
  assert.deepEqual(S.tokenize('，。！？  '), []);
  assert.deepEqual(S.tokenize(''), []);
});

test('建索引：n 与向量数量一致，idf 为正', () => {
  const idx = S.buildIndex(MEMS);
  assert.equal(idx.n, MEMS.length);
  assert.equal(idx.vectors.length, MEMS.length);
  for (const k of Object.keys(idx.idf)) {
    assert.ok(idx.idf[k] > 0, 'idf 必须为正: ' + k);
  }
});

test('检索：查询词对应的记忆排在第一位', () => {
  const idx = S.buildIndex(MEMS);
  const cases = [
    ['桂花', '外婆的桂花'],
    ['便利店', '凌晨四点的便利店'],
    ['浪', '海边的第七个浪'],
    ['星星', '第一次看见银河']
  ];
  for (const [q, want] of cases) {
    const hits = S.search(idx, q, { topK: 3 });
    assert.ok(hits.length > 0, '「' + q + '」应该有命中');
    assert.equal(MEMS[hits[0].index].title, want, '「' + q + '」首位不对');
  }
});

test('检索：分数单调不增，且都在 (0,1] 区间', () => {
  const idx = S.buildIndex(MEMS);
  const hits = S.search(idx, '海 星星', { topK: 5 });
  for (let i = 0; i < hits.length; i++) {
    assert.ok(hits[i].score > 0 && hits[i].score <= 1.0001, '分数越界: ' + hits[i].score);
    if (i) assert.ok(hits[i - 1].score >= hits[i].score, '结果必须按分数降序');
  }
});

test('检索：无关查询在合理阈值下返回空，不硬凑结果', () => {
  const idx = S.buildIndex(MEMS);
  assert.deepEqual(S.search(idx, '量子色动力学规范场', { minScore: 0.05 }), []);
});

test('检索：阈值能切掉噪声尾巴，信号仍然留着', () => {
  const idx = S.buildIndex(MEMS);
  const hits = S.search(idx, '桂花', { minScore: 0.05 });
  assert.equal(hits.length, 1, '只应命中桂花那条');
  assert.equal(MEMS[hits[0].index].title, '外婆的桂花');
});

test('聚类：确定性——同样的输入连跑三次结果一致', () => {
  const sigs = [];
  for (let i = 0; i < 3; i++) {
    const cl = S.cluster(S.buildIndex(MEMS), 2);
    sigs.push(JSON.stringify(cl.assign) + '|' + JSON.stringify(cl.labels));
  }
  assert.equal(sigs[0], sigs[1]);
  assert.equal(sigs[1], sigs[2]);
});

test('聚类：分区的记忆被分到同一簇', () => {
  const idx = S.buildIndex(MEMS);
  const cl = S.cluster(idx, 2);
  const city = [MEMS.findIndex((m) => m.title === '凌晨四点的便利店'),
                MEMS.findIndex((m) => m.title === '雨天的旧书店')];
  assert.equal(cl.assign[city[0]], cl.assign[city[1]], '两条「城市」应同簇');
});

test('聚类标签：不出现纯数字或「第X」这种噪声词', () => {
  const idx = S.buildIndex(MEMS);
  const cl = S.cluster(idx, 3);
  for (const label of cl.labels) {
    assert.ok(!/^[0-9０-９]+$/.test(label), '标签不该是纯数字: ' + label);
    assert.ok(!/^第.$/.test(label), '标签不该是序数词: ' + label);
  }
});

test('投影：每个点都在单位球内，且数量正确', () => {
  const idx = S.buildIndex(MEMS);
  const pr = S.project(idx);
  assert.equal(pr.length, MEMS.length * 3);
  for (let i = 0; i < MEMS.length; i++) {
    const r = Math.hypot(pr[i * 3], pr[i * 3 + 1], pr[i * 3 + 2]);
    assert.ok(r <= 1.0001, '超出单位球: ' + r);
  }
});

test('空输入不炸', () => {
  const idx = S.buildIndex([]);
  assert.equal(idx.n, 0);
  assert.deepEqual(S.search(idx, '海'), []);
  assert.equal(S.project(idx).length, 0);
});
