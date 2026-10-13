#!/usr/bin/env node
/* =============================================================================
 * check_spec_lock.js —— 「规格锁」门禁
 *
 * 拿什么判：一份工程目录里该有 `规格锁.md`（由 `kit/new_project.js --scaffold` 铺出来），
 * 它把「定死、不许漂」的参数单独拎出来。本器检查它**还在不在、内容齐不齐、
 * 以及跟同目录的 `spec.json` 对不对得上**。
 *
 * 用法：
 *   node kit/check_spec_lock.js                    # 在当前目录找
 *   node kit/check_spec_lock.js --dir my_proj      # 指定工程目录
 *   node kit/check_spec_lock.js --file 规格锁.md   # 直接指定文件
 *   node kit/check_spec_lock.js --strict           # 占位符未填也算 FAIL
 *   node kit/check_spec_lock.js --json out.json    # 结果落盘
 *   node kit/check_spec_lock.js --self-test        # 判据自检：fixture 必须红/绿分明
 *
 * 退出码：0 = 过 / 1 = 有 FAIL / 2 = 用法或环境错误
 *
 * ── 为什么要单独一条判据 ────────────────────────────────────────────────────
 * 「规格锁」在纸上是一份文档，在机器眼里什么都不是 —— 除非有人量它。
 * 而它要防的那个缺陷**天生不会报错**：参数改了、锁没动，页面照样渲、
 * 判据照样全绿（所有判据都在量产物，没有一条在量「产物该遵守的那份约定」）。
 * 所以本器把它变成可执行的三件事：
 *   ① 在不在        —— 没建就是 FAIL（这是「必须建」这句话唯一有牙的形态）
 *   ② 齐不齐        —— 八个小节 + 一段机器可读块
 *   ③ 对不对得上 ★  —— 机器可读块 vs 同目录 spec.json（画布 / 帧率必须一致）。
 *                        这一条才是它真正的价值：`spec.json` 是会被反复手改的，
 *                        而它是「改之前该先改的那份」。
 * ========================================================================== */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

// ── 机器可读块：`<!-- SPEC-LOCK: {"w":1920,"h":1080,"fps":30,"durMax":60} -->`
//   为什么用注释而不是让脚本去猜正文：正文是可以自由改写的散文，
//   拿正则去正文里抠数字 = 判据跟着散文漂 ⇒ 主创改一句措辞就能把判据搞红/搞绿。
//   定一个显式的、单行的、语法固定的落点，比"聪明的解析"可靠得多。
const LOCK_RE = /<!--\s*SPEC-LOCK:\s*(\{[\s\S]*?\})\s*-->/;

// ── 八个小节。判定口径是**关键词命中**，不是标题精确匹配 ——
//   标题措辞是作者的，判据不该逼人用特定字面；但**要素缺一不可**。
const REQUIRED = [
  { k: '画布尺寸',   p: /画布|canvas|1920/i },
  { k: '帧率',       p: /帧率|fps/i },
  { k: '片长口径',   p: /片长|时长/ },
  { k: '配色 / 主题', p: /主题|色板|配色|palette/i },
  { k: '字体',       p: /字体|font/i },
  { k: '安全区',     p: /安全区|安全框|字幕净空/ },
  { k: '动效节奏',   p: /动效|时长刻度|缓动|ease/i },
  { k: '变更流程',   p: /变更记录|变更流程/ },
];

const LOCK_NAMES = ['规格锁.md', 'spec-lock.md', 'SPEC-LOCK.md', 'spec.lock.md'];

const RED = [], WARN = [], INFO = [];
const ok = (m) => { INFO.push(m); console.log('  ✓ ' + m); };
const bad = (m) => { RED.push(m); console.log('  ✗ ' + m); };
const warn = (m) => { WARN.push(m); console.log('  · ' + m); };

/* 在一个目录里找锁文件。返回 {file, tried} —— 找不到也要把**试过什么**报出来，
   否则读者只看到一句「没找到」，不知道是该建文件还是该改参数。 */
function locate(dir) {
  const tried = LOCK_NAMES.map((n) => path.join(dir, n));
  for (const p of tried) if (fs.existsSync(p)) return { file: p, tried };
  // 再往下找一层（工程目录常按编号前缀分：01-xxx/规格锁.md）
  const tried2 = [];
  let subs = [];
  try { subs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()); }
  catch (e) { /* 目录不可读，交给调用方报 */ }
  for (const e of subs) {
    if (/^[_.]/.test(e.name) || e.name === 'node_modules') continue;
    for (const n of LOCK_NAMES) {
      const p = path.join(dir, e.name, n);
      tried2.push(p);
      if (fs.existsSync(p)) return { file: p, tried: tried.concat(tried2) };
    }
  }
  return { file: null, tried: tried.concat(tried2) };
}

/* 找 spec.json：优先锁文件同目录，其次工程目录本身，最后往下一层找。 */
function locateSpec(dir, lockFile) {
  const cands = [];
  if (lockFile) cands.push(path.join(path.dirname(lockFile), 'spec.json'));
  cands.push(path.join(dir, 'spec.json'));
  for (const c of cands) if (fs.existsSync(c)) return c;
  let subs = [];
  try { subs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()); }
  catch (e) { /* ignore */ }
  for (const e of subs) {
    if (/^[_.]/.test(e.name) || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name, 'spec.json');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 跑一遍全部检查（不 exit）—— 返回 {red, warn, info}，供主流程与 --self-test 共用。 */
function inspect(file) {
  const red = [], wrn = [], inf = [];
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); }
  catch (e) { red.push('读不了：' + file + '（' + e.message + '）'); return { red, wrn, inf }; }

  // ① 非空（空文件也「存在」，但等于没建）
  if (!txt.trim()) { red.push('文件是空的 —— 存在 ≠ 建了'); return { red, wrn, inf }; }
  inf.push('文件 ' + path.basename(file) + '：' + Buffer.byteLength(txt, 'utf8') + ' 字节 / '
    + txt.split('\n').length + ' 行');

  // ② 八个小节
  const missing = REQUIRED.filter((r) => !r.p.test(txt)).map((r) => r.k);
  if (missing.length) red.push('缺 ' + missing.length + ' 个必需要素：' + missing.join(' / ')
    + '（' + (REQUIRED.length - missing.length) + '/' + REQUIRED.length + '）');
  else inf.push('八个小节齐（' + REQUIRED.length + '/' + REQUIRED.length + '）');

  // ③ 机器可读块
  const m = txt.match(LOCK_RE);
  let lock = null;
  if (!m) {
    red.push('找不到机器可读块 —— 需要一行 `<!-- SPEC-LOCK: {"w":1920,"h":1080,"fps":30,"durMax":60} -->`。'
      + ' 没有它就只剩「一份文档」，判据无从与 spec.json 对账');
  } else {
    try {
      lock = JSON.parse(m[1]);
      inf.push('机器可读块：' + JSON.stringify(lock));
    } catch (e) {
      red.push('机器可读块不是合法 JSON：' + e.message + '  ← 原文 ' + m[1].slice(0, 80));
    }
  }

  // ④ 占位符（新铺的骨架本来就带「待填」，所以默认只提示；--strict 下才拦）
  const holes = (txt.match(/待填|TODO|todo|XXX/g) || []).length;
  if (holes) wrn.push('还有 ' + holes + ' 处占位符（`待填` / `TODO`）未填 —— 未填的锁 = 没锁');

  return { red, wrn, inf, lock, txt };
}

/* 与 spec.json 对账。★ 这一条是整条判据的价值所在。 */
function crossCheck(lock, specFile) {
  const red = [], wrn = [], inf = [];
  let spec;
  try { spec = JSON.parse(fs.readFileSync(specFile, 'utf8')); }
  catch (e) { red.push('spec.json 解析失败：' + e.message); return { red, wrn, inf }; }
  if (!lock) { wrn.push('没有机器可读块 ⇒ 跳过与 spec.json 的对账'); return { red, wrn, inf }; }

  const rows = [
    ['画布宽', 'w', spec.width == null ? 1920 : Number(spec.width)],
    ['画布高', 'h', spec.height == null ? 1080 : Number(spec.height)],
    ['帧率', 'fps', spec.fps == null ? 30 : Number(spec.fps)],
  ];
  const mismatch = [];
  for (const [label, key, got] of rows) {
    if (lock[key] == null) { wrn.push('锁里没写 `' + key + '`，无法核对' + label); continue; }
    if (Number(lock[key]) !== got) mismatch.push(label + '：锁 ' + lock[key] + ' ≠ spec.json ' + got);
  }
  if (mismatch.length) {
    red.push('★ 「参数漂了」' + mismatch.length + ' 处 —— 锁与实际工程对不上：\n      '
      + mismatch.join('\n      ')
      + '\n      ⇒ 要么把工程改回锁，要么**先改锁再改工程**（改锁要走变更记录）。');
  } else if (rows.every(([, k]) => lock[k] != null)) {
    inf.push('锁 vs spec.json：画布 / 帧率一致（' + rows.map(([l, k]) => l + ' ' + lock[k]).join(' · ') + '）');
  }

  const dur = Number(spec.dur);
  if (isFinite(dur) && dur > 0 && lock.durMax != null && Number(lock.durMax) > 0) {
    if (dur > Number(lock.durMax)) {
      red.push('★ 实际时长 ' + dur + 's 超过锁里写的上限 ' + lock.durMax + 's');
    } else {
      inf.push('时长 ' + dur + 's ≤ 上限 ' + lock.durMax + 's');
    }
  }
  return { red, wrn, inf };
}

/* ────────────────────────── 主流程 ────────────────────────── */
function run() {
  const strict = has('--strict');
  let file = arg('--file', null);
  const dir = path.resolve(arg('--dir', process.cwd()));
  const lock = arg('--lock', '');

  console.log('\n════════════════════════════════════════════════════════');
  console.log(' 规格锁门禁 · check_spec_lock');
  console.log('════════════════════════════════════════════════════════');

  if (!file) {
    if (!fs.existsSync(dir)) { console.error('  ✗ 目录不存在：' + dir); process.exit(2); }
    const r = locate(dir);
    if (!r.file) {
      console.log('  ✗ 找不到规格锁文件');
      console.log('    试过：');
      r.tried.slice(0, 12).forEach((p) => console.log('      - ' + p));
      console.log('\n  ⇒ 这份工程没有「定死参数」的落点。多个人 / 多个 agent 一起改时，');
      console.log('     保证大家改的是同一份参数的**唯一**手段就是它。');
      console.log('     生成一份：node kit/new_project.js --scaffold --out <工程目录> --force');
      console.log('════════════════════════════════════════════════════════\n');
      process.exit(1);
    }
    file = r.file;
  }
  file = path.resolve(file);
  if (!fs.existsSync(file)) { console.error('  ✗ 文件不存在：' + file); process.exit(2); }
  console.log('  锁文件  ：' + file);

  const r1 = inspect(file);
  r1.inf.forEach(ok); r1.wrn.forEach(warn); r1.red.forEach(bad);

  // ★ 顺序很重要：先量锁本身，再看它跟工程对不对得上。
  //   反过来的话，一份**空锁**会先在对账里报一堆 WARN 把真正的 FAIL 淹掉。
  const specFile = arg('--spec', null) || locateSpec(dir, file);
  if (specFile) {
    console.log('  对照工程：' + specFile);
    const r2 = crossCheck(r1.lock, specFile);
    r2.inf.forEach(ok); r2.wrn.forEach(warn); r2.red.forEach(bad);
  } else {
    warn('没找到 spec.json ⇒ 跳过对账（只能证明「锁在」，不能证明「锁是对的」）');
  }

  if (strict && r1.wrn.some((s) => /占位符/.test(s))) {
    RED.push('--strict：仍有未填的占位符');
  }

  console.log('════════════════════════════════════════════════════════');
  const nFail = RED.length;
  console.log(' 结论：' + (nFail ? 'FAIL  —— ' + nFail + ' 项未过' : 'PASS  —— ' + (INFO.length + WARN.length) + ' 项检查通过')
    + '   （WARN ' + WARN.length + ' · --strict 可把占位符升级为 FAIL）');
  console.log('════════════════════════════════════════════════════════\n');

  if (lock) {
    fs.writeFileSync(path.resolve(lock),
      JSON.stringify({ target: file, spec: specFile, red: RED, warn: WARN, info: INFO }, null, 2), 'utf8');
    console.log('  JSON → ' + path.resolve(lock));
  }
  process.exit(nFail ? 1 : 0);
}

/* ────────────────────────── 自检 ──────────────────────────
 * 「判据必须有牙」：必须同时证明 ① 好输入 ⇒ PASS ② 坏输入 ⇒ FAIL。
 * 只证一半等于没证 —— 一条恒 FAIL 的判据也能"通过故障注入"。
 * 这里造 5 个 fixture，逐个断言它该红还是该绿。 */
function selfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'speclock-'));
  const mk = (name, body) => { const p = path.join(tmp, name); fs.writeFileSync(p, body, 'utf8'); return p; };
  const FULL = [
    '# 规格锁 · demo', '',
    '## 一、冻结项', '| 画布 | 1920×1080 | 冻结 |', '| 帧率 | 30 fps | 冻结 |',
    '| 片长口径 | 配音实测 + 1.0s | 冻结 |', '| 主题 | dark-tech | 冻结 |',
    '| 字体 | 思源黑体 | 冻结 |', '',
    '## 二、安全区', '| 安全框 | x[52,1872] y[70,1008] |', '| 字幕净空带 | y[900,1080] |', '',
    '## 三、动效节奏', '元素入场 220ms，缓动 cubic-bezier(.22,1,.36,1)', '',
    '## 六、变更记录', '| 日期 | 谁 | 改了哪条 |', '|---|---|---|', '| | | |', '',
    '<!-- SPEC-LOCK: {"w":1920,"h":1080,"fps":30,"durMax":60} -->',
  ].join('\n');
  const noHole = FULL;
  const withHole = FULL.replace('dark-tech', '待填');

  const cases = [
    { name: '空文件',                    body: '',                                    expect: 'FAIL' },
    { name: '只有标题',                  body: '# 规格锁\n',                          expect: 'FAIL' },
    { name: '齐但缺机器可读块',          body: noHole.replace(/<!-- SPEC-LOCK[\s\S]*?-->/, ''), expect: 'FAIL' },
    { name: '齐且带块（骨架填好的样子）', body: noHole,                                  expect: 'PASS' },
    { name: '齐但留占位符 + --strict',   body: withHole,                                expect: 'FAIL', strict: true },
  ];
  const specOK = { width: 1920, height: 1080, fps: 30, dur: 12.03 };
  const specBAD = { width: 3840, height: 2160, fps: 30, dur: 12.03 };
  fs.writeFileSync(path.join(tmp, 'spec.json'), JSON.stringify(specOK), 'utf8');

  let fails = 0;
  console.log('\n── check_spec_lock 自检 ──');
  for (const c of cases) {
    const p = mk('lock_' + cases.indexOf(c) + '.md', c.body);
    const r = inspect(p);
    let red = r.red.length;
    if (c.strict) red += r.wrn.some((s) => /占位符/.test(s)) ? 1 : 0;
    const got = red ? 'FAIL' : 'PASS';
    const good = got === c.expect;
    if (!good) fails++;
    console.log('  ' + (good ? '✓' : '✗') + ' ' + c.name.padEnd(24)
      + ' 期望 ' + c.expect + '  实得 ' + got + (good ? '' : '   ← 判据没牙！'));
  }
  // ★ 负控：spec.json 与锁不一致时，**必须**报红（证明对账那一条真的在量）
  {
    const p = mk('lock_neg.md', noHole);
    const r1 = inspect(p);
    fs.writeFileSync(path.join(tmp, 'spec.json'), JSON.stringify(specBAD), 'utf8');
    const r2 = crossCheck(r1.lock, path.join(tmp, 'spec.json'));
    const good = r2.red.length > 0;
    if (!good) fails++;
    console.log('  ' + (good ? '✓' : '✗') + ' ' + '负控：spec.json 画布不符'.padEnd(24)
      + ' 期望 FAIL  实得 ' + (good ? 'FAIL' : 'PASS') + (good ? '' : '   ← 对账那条是死代码！'));
  }
  // ★ 负控 2：spec.json 一致时不许误报（防"恒 FAIL 也算有牙"）
  {
    const p = mk('lock_pos.md', noHole);
    const r1 = inspect(p);
    fs.writeFileSync(path.join(tmp, 'spec.json'), JSON.stringify(specOK), 'utf8');
    const r2 = crossCheck(r1.lock, path.join(tmp, 'spec.json'));
    const good = r2.red.length === 0;
    if (!good) fails++;
    console.log('  ' + (good ? '✓' : '✗') + ' ' + '负控 2：spec.json 一致不误报'.padEnd(24)
      + ' 期望 PASS  实得 ' + (good ? 'PASS' : 'FAIL') + (good ? '' : '   ← 假阳性！'));
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 临时目录，留着也无害 */ }

  console.log('\n' + (fails ? '自检失败：' + fails + ' 个 case 没牙。' : '自检通过：坏输入会红、好输入不误报。') + '\n');
  process.exit(fails ? 1 : 0);
}

if (has('--self-test')) selfTest();
else if (has('--help') || has('-h')) {
  console.log('用法: node kit/check_spec_lock.js [--dir <工程目录>] [--file <锁文件>] [--spec <spec.json>] [--strict] [--json <out>] [--self-test]');
} else run();
