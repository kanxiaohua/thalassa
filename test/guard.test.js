/**
 * 隐私守卫
 * 跑法：node --test
 *
 * 这个项目开源的是「壳」：代码、布局算法、示例记忆。真实内容——几十张照片、
 * 几十条写给自己看的回忆——永远不进仓库。第一道防线是 .gitignore，
 * 但 .gitignore 只挡它认识的文件名；「把真实数据抄进 data/memories.js」这种
 * 它挡不住，而且提交之前没人会发现。
 *
 * 这里做第二道：把「什么样的仓库算干净」写成可执行的断言。
 *   · 示例数据维持示例的规模
 *   · 素材里不许出现照片和录音
 *   · data/ 下不许冒出第二个数据文件
 *   · 示例引用的图片必须存在（clone 下来不能是空图）
 *
 * 想在自己的克隆里放真实数据，就把 SEA_MAX_DEMO 调大，
 * 但请先确认那份仓库不会被推到公开地址。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_LIMIT = Number(process.env.SEA_MAX_DEMO || 12);

const DATA = path.join(ROOT, 'data', 'memories.js');
const EXAMPLE = path.join(ROOT, 'data', 'memories.example.js');

const read = (p) => fs.readFileSync(p, 'utf8');

/** 抠出某个字段的所有取值。数据文件的写法很固定（"..." / '...' / `...`），够用。 */
function fieldValues(src, field) {
  const out = [];
  // 正文用的是反引号模板字符串，必须一起认，否则 text 一条都抠不出来
  const re = new RegExp(field + '\\s*:\\s*(["\'`])((?:\\\\.|(?!\\1)[\\s\\S])*?)\\1', 'g');
  let m;
  while ((m = re.exec(src))) out.push(m[2]);
  return out;
}

/** 递归列文件（相对 ROOT，统一用 / 分隔） */
function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name);
    if (name.isDirectory()) out.push(...walk(full));
    else out.push(path.relative(ROOT, full).replace(/\\/g, '/'));
  }
  return out;
}

const PHOTO_EXT = /\.(jpe?g|png|webp|gif|heic|heif|avif|bmp|tiff?)$/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|ogg|opus|wma|aiff?)$/i;

/* 导出到文件夹会在 assets/ 下写出 photo-*.jpg。
 * 导到你自己的私人库时这里不会跑到；但如果有人把开源仓库当成私人库用，
 * 这组断言就会一直红 —— 那种情况下把它俩设成 1，
 * 意思就是「我知道我在往仓库里放自己的照片」。
 * 公开仓库请保持关闭，这是最后一道闸。 */
const ALLOW_PHOTOS = process.env.SEA_ALLOW_PHOTOS === '1';

describe('示例数据', () => {
  it('data/memories.js 存在（clone 下来就能打开，不是空球）', () => {
    assert.ok(fs.existsSync(DATA), 'data/memories.js 不存在，新用户打开会是空球');
  });

  it(`条数不超过 ${DEMO_LIMIT} 条（真实库是几十条，超过就说明抄错了文件）`, () => {
    const n = fieldValues(read(DATA), 'title').length;
    assert.ok(n > 0, '一条都没有');
    assert.ok(n <= DEMO_LIMIT, `有 ${n} 条，超过示例规模 ${DEMO_LIMIT}。真要把自己的记忆放进来，先调 SEA_MAX_DEMO`);
  });

  it('数据文件与 example 的字段结构一致（换数据不该悄悄丢字段）', () => {
    const keys = (src) => {
      const set = new Set();
      const re = /^\s{4}([a-zA-Z]+)\s*:/gm;
      let m;
      while ((m = re.exec(src))) set.add(m[1]);
      return [...set].sort();
    };
    const a = keys(read(DATA));
    const b = keys(read(EXAMPLE));
    assert.deepEqual(a, b, `字段对不上：memories.js=[${a}]，example=[${b}]`);
  });

  it('每条都写了 title / text / image / tag', () => {
    const src = read(DATA);
    for (const f of ['title', 'text', 'image', 'tag']) {
      assert.ok(fieldValues(src, f).length > 0, `没有一条带 ${f}`);
    }
  });

  it('示例引用的本地图片真实存在', () => {
    const missing = fieldValues(read(DATA), 'image')
      .filter((src) => !/^(https?:)?\/\//i.test(src) && !src.startsWith('data:'))
      .filter((src) => !fs.existsSync(path.join(ROOT, src)));
    assert.deepEqual(missing, [], `这些图片找不到：${missing.join('、')}`);
  });

  it('数据里没有本机绝对路径（防止把 E:\\ 或 file:// 抄进示例）', () => {
    const bad = [];
    for (const f of ['title', 'text', 'image']) {
      for (const v of fieldValues(read(DATA), f)) {
        if (/[A-Za-z]:[\\/]/.test(v) || /^file:/i.test(v)) bad.push(`${f}: ${v.slice(0, 40)}`);
      }
    }
    assert.deepEqual(bad, [], `示例数据里有本机路径：\n${bad.join('\n')}`);
  });
});

describe('素材', () => {
  const files = walk(path.join(ROOT, 'assets'));

  it('assets/ 里没有照片', { skip: ALLOW_PHOTOS && 'SEA_ALLOW_PHOTOS=1，已知要放自己的照片' }, () => {
    const bad = files.filter((f) => PHOTO_EXT.test(f));
    assert.deepEqual(bad, [], `这些是照片，不该在仓库里：\n${bad.join('\n')}`);
  });

  it('assets/ 里没有录音', () => {
    const bad = files.filter((f) => AUDIO_EXT.test(f));
    assert.deepEqual(bad, [], `这些是音频，不该在仓库里：\n${bad.join('\n')}`);
  });

  it('assets/ 只放 SVG 占位图与说明文字', { skip: ALLOW_PHOTOS && 'SEA_ALLOW_PHOTOS=1' }, () => {
    const bad = files.filter((f) => !/\.(svg|txt|md)$/i.test(f));
    assert.deepEqual(bad, [], `多出来的文件：\n${bad.join('\n')}`);
  });

  it('assets/ 体积没有失控（占位图总共应该只有几十 KB）', { skip: ALLOW_PHOTOS && 'SEA_ALLOW_PHOTOS=1' }, () => {
    const total = files.reduce((sum, f) => sum + fs.statSync(path.join(ROOT, f)).size, 0);
    assert.ok(total < 2 * 1024 * 1024, `assets/ 已经有 ${(total / 1024 / 1024).toFixed(2)} MB，像是把真图放进来画了`);
  });
});

describe('目录边界', () => {
  it('data/ 下只有约定的三个文件', () => {
    const allowed = ['data/memories.js', 'data/memories.example.js', 'data/music.js'];
    const actual = walk(path.join(ROOT, 'data'));
    const extra = actual.filter((f) => !allowed.includes(f));
    assert.deepEqual(extra, [], `data/ 里冒出了别的文件（备份？草稿？）：\n${extra.join('\n')}`);
  });

  it('仓库根没有本地的数据草稿', () => {
    const bad = ['memories.local.js', 'memories.backup.js', 'memories.private.js', 'data.local.js']
      .filter((f) => fs.existsSync(path.join(ROOT, f)));
    assert.deepEqual(bad, [], `根目录有本数据草稿：${bad.join('、')}`);
  });
});

/* 可选的交叉检查：本地同时存在私人库时，两个数据集的标题不许有交集。
 * 用环境变量传路径，公开仓库里不出现任何私人目录名。
 *   Windows: set SEA_PRIVATE_DATA=E:\path\to\private\data\memories.js && node --test
 * 没设就整段跳过，CI 上不受影响。 */
const PRIVATE = process.env.SEA_PRIVATE_DATA;
describe('与私人库的交叉检查', { skip: !PRIVATE || !fs.existsSync(PRIVATE) }, () => {
  it('公开示例的标题不得命中私人库的标题', () => {
    const mine = new Set(fieldValues(read(DATA), 'title').map((s) => s.trim()));
    const theirs = fieldValues(read(PRIVATE), 'title').map((s) => s.trim());
    const hit = theirs.filter((t) => mine.has(t));
    assert.deepEqual(hit, [], `这些标题是真的记忆，出现在了示例里：\n${hit.join('\n')}`);
  });

  it('公开示例的正文不得命中私人库的正文', () => {
    const mine = new Set(fieldValues(read(DATA), 'text').map((s) => s.trim()));
    const theirs = fieldValues(read(PRIVATE), 'text').map((s) => s.trim());
    const hit = theirs.filter((t) => mine.has(t));
    assert.deepEqual(hit, [], `有 ${hit.length} 段真实正文出现在了示例里`);
  });
});
