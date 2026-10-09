#!/usr/bin/env node
/* svg_geometry.js —— SVG 素材「几何反解器」（制片验收用）
 * =====================================================================
 * 用途：验收标准 §一 的「人眼项」里有几条其实可以算出来 ——
 *   ① 元素是不是同心（歪了就是画歪了）
 *   ② 元素落在哪个半径带（主体够不够大 / 是不是贴边）
 *   ③ **中心真的空吗**（片子里要往中心叠数字，中心被占就是废件）
 *
 * 用法：
 *   node kit/svg_geometry.js <file.svg> [--center 200,200] [--inner 128]
 *   node kit/svg_geometry.js --selftest          # 自检：判据能不能区分好坏
 *
 * 退出码：0 PASS / 1 FAIL / 2 参数或环境错
 *
 * =====================================================================
 * ★★★ 写这个脚本时，同一个判据我连错三次 —— 留档当反面教材
 * =====================================================================
 *   错① 没考虑 `fill="none"`：轨道环是「只描边不填充」的，我却按实心圆算
 *        `dist - r` → 同心环得 -139 → **假报警「有元素侵入中心」**。
 *   错② 公式写歪：改成 `Math.max(dist,r) - r - sw/2` → 同心环得 -11 → 还是假报警。
 *        正解是 `|dist - r| - sw/2`（环带的最近点）。
 *   错③ **正则拼错**：`new RegExp("\\b"+k+"=\"…\"")` 拼出来是 `\bcx"=` 而不是
 *        `\bcx="`（`=` 和 `"` 顺序反了）→ 所有 circle 的 cx/cy 都解析成 0
 *        → 端帽的最近距离算成 270.84（真值 128）。
 *        ⚠️ **最坑的是：最终结论「中心真的空」碰巧是对的**（因为全局最小值
 *        恰好由进度弧给出 = 128）。**判据没干活，结论却对了 —— 这就是
 *        「PASS 不一定是真 PASS」的活案例。**
 *   → 所以本脚本带 `--selftest`：内置一个「端帽侵入中心」的反例，
 *     判据区分不出来就直接 FAIL。**改判据必须重跑 self，这是硬规矩。**
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* =====================================================================
 * 元素抽取：把 svg 里的图元解析成 {type, geo} 列表
 * ===================================================================== */
function g(a, k) {                       /* ← 用字面量正则，别拼 RegExp（错③的教训） */
  const RE = {
    cx: /\bcx="(-?[\d.]+)"/, cy: /\bcy="(-?[\d.]+)"/,
    r: /\br="(-?[\d.]+)"/, rx: /\brx="(-?[\d.]+)"/, ry: /\bry="(-?[\d.]+)"/,
    x: /\bx="(-?[\d.]+)"/, y: /\by="(-?[\d.]+)"/,
    w: /\bwidth="(-?[\d.]+)"/, h: /\bheight="(-?[\d.]+)"/,
    sw: /\bstroke-width="(-?[\d.]+)"/,
    x1: /\bx1="(-?[\d.]+)"/, y1: /\by1="(-?[\d.]+)"/,
    x2: /\bx2="(-?[\d.]+)"/, y2: /\by2="(-?[\d.]+)"/,
  };
  const m = a.match(RE[k]);
  return m ? +m[1] : null;
}
const isHollow = a => /fill\s*=\s*"none"/.test(a);

function parse(src) {
  const els = [];
  /* --- circle --- */
  for (const m of src.matchAll(/<circle\b([^>]*)\/?>/g)) {
    const a = m[1];
    els.push({ type: 'circle', hollow: isHollow(a), sw: g(a, 'sw') || 0,
      cx: g(a, 'cx') ?? 0, cy: g(a, 'cy') ?? 0, r: g(a, 'r') ?? 0 });
  }
  /* --- ellipse --- */
  for (const m of src.matchAll(/<ellipse\b([^>]*)\/?>/g)) {
    const a = m[1];
    els.push({ type: 'ellipse', hollow: isHollow(a), sw: g(a, 'sw') || 0,
      cx: g(a, 'cx') ?? 0, cy: g(a, 'cy') ?? 0, r: Math.max(g(a, 'rx') ?? 0, g(a, 'ry') ?? 0) });
  }
  /* --- 圆弧 path：只认 M x y A r r …（同心弧） --- */
  for (const m of src.matchAll(/<path\b([^>]*)\/?>/g)) {
    const a = m[1];
    const d = (a.match(/\bd="([^"]+)"/) || [, ''])[1];
    const am = d.match(/M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*A\s*(-?[\d.]+)/);
    if (am) els.push({ type: 'arc', hollow: true, sw: g(a, 'sw') || 0,
      cx: +am[1], cy: +am[2], r: +am[3], d });
    else els.push({ type: 'path', hollow: isHollow(a), sw: g(a, 'sw') || 0, raw: d, unknown: true });
  }
  /* --- line --- */
  for (const m of src.matchAll(/<line\b([^>]*)\/?>/g)) {
    const a = m[1];
    els.push({ type: 'line', hollow: true, sw: g(a, 'sw') || 0,
      x1: g(a, 'x1') ?? 0, y1: g(a, 'y1') ?? 0, x2: g(a, 'x2') ?? 0, y2: g(a, 'y2') ?? 0 });
  }
  /* --- rect --- */
  for (const m of src.matchAll(/<rect\b([^>]*)\/?>/g)) {
    const a = m[1];
    els.push({ type: 'rect', hollow: isHollow(a), sw: g(a, 'sw') || 0,
      x: g(a, 'x') ?? 0, y: g(a, 'y') ?? 0, w: g(a, 'w') ?? 0, h: g(a, 'h') ?? 0 });
  }
  return els;
}

/* =====================================================================
 * 到指定点的「最近距离」—— 四种图元四套算法（错①②的教训：别一刀切）
 *   < 0 表示该点被元素覆盖
 * ===================================================================== */
function nearest(el, CX, CY) {
  if (el.type === 'circle' || el.type === 'ellipse') {
    const dist = Math.hypot(el.cx - CX, el.cy - CY);
    if (el.hollow) {
      /* 描边环：占环带 [r-sw/2, r+sw/2] → 到点的最近距离 = |dist - r| - sw/2（夹到 ≥0 之外可为负） */
      return Math.abs(dist - el.r) - el.sw / 2;
    }
    return dist - el.r;                       // 实心：最近点
  }
  if (el.type === 'arc') {
    const R = Math.hypot(el.cx - CX, el.cy - CY);   /* 弧起点到目标点的半径 */
    return R - el.sw / 2;
  }
  if (el.type === 'line') {
    const d1 = Math.hypot(el.x1 - CX, el.y1 - CY), d2 = Math.hypot(el.x2 - CX, el.y2 - CY);
    return Math.min(d1, d2) - el.sw / 2;
  }
  if (el.type === 'rect') {
    const dx = Math.max(el.x - CX, 0, CX - (el.x + el.w));
    const dy = Math.max(el.y - CY, 0, CY - (el.y + el.h));
    return Math.hypot(dx, dy) - (el.hollow ? el.sw / 2 : 0);
  }
  return NaN;                                 /* 未支持的类型：返回 NaN，别假装算过 */
}

/* =====================================================================
 * 分析
 * ===================================================================== */
function analyze(src, CX, CY, INNER) {
  const els = parse(src);
  const rows = els.map(e => ({ type: e.type, hollow: !!e.hollow, r: nearest(e, CX, CY) }));
  const known = rows.filter(r => !Number.isNaN(r.r));
  const unknown = rows.filter(r => Number.isNaN(r.r));
  const min = known.length ? Math.min(...known.map(r => r.r)) : NaN;

  const byT = {};
  for (const r of known) (byT[r.type + (r.hollow ? '(描边)' : '')] = byT[r.type + (r.hollow ? '(描边)' : '')] || []).push(r.r);

  return { els, rows, known, unknown, min, byT };
}

/* =====================================================================
 * 自检：判据能不能区分好件 / 坏件
 * ===================================================================== */
function selftest() {
  const CX = 200, CY = 200, INNER = 128, EPS = 0.5;
  /* 好件：同心轨道环(r139,sw22) + 端帽落在 d=140/r12 → 最近 128（贴边，合法） */
  const good = '<svg viewBox="0 0 400 400">'
    + '<circle cx="200" cy="200" r="139" fill="none" stroke="#000" stroke-width="22"/>'
    + '<path d="M 200 61 A 139 139 0 0 1 281.7 312.45" fill="none" stroke="#000" stroke-width="22"/>'
    + '<circle cx="282.29" cy="313.26" r="12" fill="#000"/></svg>';
  /* 坏件：端帽被挪到 d≈123.5 → 最近 111.5 < 128（侵入中心） */
  const bad = good.replace('cy="313.26"', 'cy="292.14"');

  const rg = analyze(good, CX, CY, INNER), rb = analyze(bad, CX, CY, INNER);
  const okGood = rg.min >= INNER - EPS, okBad = rb.min < INNER - EPS;

  console.log('== svg_geometry --selftest ==\n');
  console.log('好件（端帽贴环内沿，d=140）最近距离 = ' + rg.min.toFixed(2) + '  → ' + (okGood ? '✓ PASS' : '✗ 判据把好件判挂了（浮点边界？）'));
  console.log('坏件（端帽挪进中心，d≈123.5）最近距离 = ' + rb.min.toFixed(2) + '  → ' + (okBad ? '✓ FAIL（抓到了）' : '✗ 判据抓不到坏件 = 死代码'));
  console.log('\n结论：' + (okGood && okBad
    ? 'PASS —— 判据能区分好坏，可以拿去验收'
    : 'FAIL —— 判据无效，先修判据再用'));
  process.exit(okGood && okBad ? 0 : 1);
}

/* =====================================================================
 * CLI
 * ===================================================================== */
const argv = process.argv.slice(2);
if (argv.indexOf('--selftest') > -1) selftest();

const file = argv.find(a => !a.startsWith('--'));
if (!file) { console.error('用法：node kit/svg_geometry.js <file.svg> [--center 200,200] [--inner 128]'); console.error('      node kit/svg_geometry.js --selftest'); process.exit(2); }
if (!fs.existsSync(file)) { console.error('!! 文件不存在：' + file); process.exit(2); }

/* ⚠️ 浮点边界容差（第四次踩同族坑）：
 * 设计要求端帽内沿正好贴 128，算出来是 127.99999999999999 →
 * `min >= 128` 判 false → **把好件判挂**（自检当场抓住）。
 * 同族前科：BUG-2071 `|Δ| >= 1.0` 遇「降 1 个声贝」浮点 0.99999 → 假 FAIL。
 * 规矩：几何量留 0.5px 容差 —— 比浮点误差大得多，比物理意义小得多。 */
const EPS = 0.5;

function opt(name, dflt) { const i = argv.indexOf('--' + name); return i > -1 ? argv[i + 1] : dflt; }
const [CX, CY] = (opt('center', '200,200')).split(',').map(Number);
const INNER = +opt('inner', '128');

const src = fs.readFileSync(file, 'utf8');
const md5 = crypto.createHash('md5').update(src).digest('hex').slice(0, 8);
const A = analyze(src, CX, CY, INNER);

console.log('svg_geometry —— 验的对象：' + path.resolve(file));
console.log('  ' + src.length + 'B  md5:' + md5 + '   参照圆心 (' + CX + ',' + CY + ')  内空半径要求 ≥ ' + INNER + '（容差 ' + EPS + 'px）\n');

if (A.unknown.length) {
  console.log('⚠️ 有 ' + A.unknown.length + ' 个元素几何未解析（path/polyline 等曲线无法自动反解）→ 这部分请人眼看：');
  for (const u of A.unknown) console.log('   ' + u.type + '  d="' + String(u.raw).slice(0, 60) + '…"');
  console.log('');
}

console.log('元素 ' + A.known.length + ' 个（已解析），按类分：');
for (const t in A.byT) {
  const v = A.byT[t];
  console.log('  ' + t.padEnd(14) + '×' + String(v.length).padStart(2) +
    '   离圆心最近 ' + Math.min(...v).toFixed(2) + ' ~ ' + Math.max(...v).toFixed(2));
}

console.log('\n★ 全部元素离圆心最近的距离 = ' + A.min.toFixed(2) + '   （要求 ≥ ' + INNER + '）');
const pass = A.min >= INNER - EPS;
console.log('  ' + (pass ? '✓ 中心真的空，无元素侵入' : '✗ 有元素侵入中心（缺口 ' + (INNER - A.min).toFixed(2) + 'px）'));
console.log('  → 中心可放内容圆直径 ' + (A.min * 2).toFixed(0) + 'px');
if (pass && A.min - (INNER - EPS) < EPS) console.log('  ⚠️ NOTE：贴线通过（差 ' + (A.min - INNER).toFixed(2) + 'px）—— 改比例时留意');
console.log('\n════ 结论：' + (pass ? 'PASS' : 'FAIL') + ' ════');
console.log('⚠️ 本脚本只判「几何自洽 / 中心留空」。构图比例、辨识度、同批一致性仍须人眼看。');
process.exit(pass ? 0 : 1);
