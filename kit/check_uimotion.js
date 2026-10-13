#!/usr/bin/env node
/**
 * check_uimotion.js —— UI 动效模式库门禁
 *
 * 查三类东西：
 *   L1 硬门禁  任何时刻返回 NaN / Infinity —— 一票否决。
 *              NaN 进 opacity 会让整层**静默消失**，抽帧时看到"元素不见了"却查不出原因。
 *   L2 端点    入场前 = 0，入场后 = 1（或稳定值）。防止"永远半透明""退场留残渣"。
 *   L3 参数    UIM.audit() 的规则是否真能拦住违规用法。
 *
 * 用法：node kit/check_uimotion.js [--json]
 * 退出码：0 = 全绿；1 = 有 FAIL；2 = 有 WARN 且 --strict
 */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var KIT = __dirname;
var g = {};
g.window = g;
vm.createContext(g);
['motion-tokens.js', 'ui-motion.js'].forEach(function (f) {
  var p = path.join(KIT, f);
  if (!fs.existsSync(p)) { console.error('缺少依赖: ' + f); process.exit(2); }
  vm.runInContext(fs.readFileSync(p, 'utf8'), g, { filename: f });
});
var UIM = g.UIM, K = UIM.K;

// ---------------------------------------------------------------------------
// 采样工具
// ---------------------------------------------------------------------------
function isBad(v) { return typeof v === 'number' && !isFinite(v); }
/** 递归找 NaN —— 返回命中路径数组 */
function scan(o, prefix, out) {
  out = out || [];
  if (o == null) return out;
  if (typeof o === 'number') { if (isBad(o)) out.push(prefix); return out; }
  if (typeof o !== 'object') return out;
  for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) scan(o[k], prefix + '.' + k, out);
  return out;
}
/** 时间轴上采样 N 点，收集 NaN 命中 */
function sweep(fn, t0, t1, n) {
  var bad = [], samples = [];
  for (var i = 0; i < n; i++) {
    var t = t0 + (t1 - t0) * i / (n - 1);
    var r = fn(t);
    var hits = scan(r, 't=' + t.toFixed(2));
    if (hits.length) bad = bad.concat(hits);
    if (i % Math.ceil(n / 4) === 0) samples.push(r);
    if (i === n - 1) samples.push(r);
  }
  return { bad: bad, samples: samples };
}
function keyOf(r) {
  if (r == null) return '-';
  if (typeof r === 'number') return r.toFixed(0);
  var s = [];
  if (r.op != null) s.push('op' + r.op.toFixed(2));
  if (r.k != null) s.push('k' + r.k.toFixed(2));
  if (r.w != null) s.push('w' + r.w.toFixed(0));
  return s.join('/') || '{}';
}

// ---------------------------------------------------------------------------
// 模式用例表：每个用例给出 调用体 + 采样窗口 + 端点断言
//   in/out 语义：expect.start = 期望 t0 时刻 op（或值），expect.end = 期望 t1 时刻
// ---------------------------------------------------------------------------
var CASES = [
  { n: 'popIn',        f: function (t) { return UIM.popIn(t, { in: 0.4, dur: 0.22 }); },
    t0: 0.2, t1: 1.2, startOp: 0, endOp: 1 },
  { n: 'pressFeedback',f: function (t) { return UIM.pressFeedback(t, { at: 0.4, hold: 0.06 }); },
    t0: 0, t1: 1.2, endOp: 1 },
  { n: 'toastStack',   f: function (t) { return UIM.toastStack(t, 2, 4, { in: 0.3 }); },
    t0: 0, t1: 1.2, startOp: 0, endOp: 1 },
  { n: 'sheetIn',      f: function (t) { return UIM.sheetIn(t, { in: 0.3, h: 420, out: 1.2 }); },
    t0: 0, t1: 1.2, startOp: 0, endOp: 1 },
  { n: 'listStagger',  f: function (t) { return UIM.listStagger(t, 3, 5, { in: 0.2 }); },
    t0: 0, t1: 1.2, startOp: 0, endOp: 1 },            // 返回裸进度值 0→1
  { n: 'chipExit',     f: function (t) { return UIM.chipExit(t, 3, 1, { at: 0.4 }); },
    t0: 0, t1: 1.2, endOp: 1 },
  { n: 'morphIcon',    f: function (t) { return UIM.morphIcon(t, { at: 0.3, dur: 0.24 }); },
    t0: 0, t1: 1.0, endOp: 1 },
  { n: 'underlineMorph', f: function (t) { return UIM.underlineMorph(t, { at: 0.3, fromX: 0, toX: 200, fromW: 60, toW: 120 }); },
    t0: 0, t1: 1.0, endOp: 1 },
  { n: 'progressRing', f: function (t) { return UIM.progressRing(t, { in: 0.3, dur: 0.6, circumference: 100 }); },
    t0: 0, t1: 1.2 },
  { n: 'progressBar',  f: function (t) { return UIM.progressBar(t, { in: 0.3, dur: 0.7, trackW: 200 }); },
    t0: 0, t1: 1.2 },
  { n: 'ticker',       f: function (t) { return UIM.ticker(t, 0, 915, { in: 0.3, dur: 1.0 }); },
    t0: 0, t1: 1.6 },
  { n: 'lineDraw',     f: function (t) { return UIM.lineDraw(t, { in: 0.3, dur: 0.8 }); },
    t0: 0, t1: 1.4 },
  { n: 'barGrow',      f: function (t) { return UIM.barGrow(t, 2, 5, { in: 0.3 }); },
    t0: 0, t1: 1.2, startOp: 0, endOp: 1 },
  { n: 'compareBar',   f: function (t) { return UIM.compareBar(t, -38, 100, { in: 0.3, trackW: 300 }); },
    t0: 0, t1: 1.2 },
  { n: 'compareBar/缺参', f: function (t) { return UIM.compareBar(t, { in: 0.3 }); },
    t0: 0, t1: 1.2, note: '容错：不传 v/max 也必须出数，不能 NaN' },
  { n: 'shimmer',      f: function (t) { return UIM.shimmer(t, { in: 0.2, w: 200, out: 1.0 }); },
    t0: 0, t1: 1.6, endOp: 1 },
  { n: 'pulse',        f: function (t) { return UIM.pulse(t, { on: 0.3, off: 1.4, amp: 0.03 }); },
    t0: 0, t1: 1.6, endOp: 1 },
  { n: 'blurBridge',   f: function (t) { return UIM.blurBridge(t, { in: 0.2, out: 0.9, max: 6 }); },
    t0: 0, t1: 1.5, endOp: 1 },
  { n: 'magnetic',     f: function (t) { return UIM.magnetic(t, { in: 0.3, tx: 120, ty: -60 }); },
    t0: 0, t1: 1.0, endOp: 1 },
  { n: 'scrollReveal', f: function (t) { return UIM.scrollReveal(t, { enterAt: 0.4, dur: 0.45 }); },
    t0: 0, t1: 1.2, startOp: 0, endOp: 1 },
  { n: 'wipeReveal',   f: function (t) { return UIM.wipeReveal(t, { in: 0.3, dur: 0.5, dir: 'left' }); },
    t0: 0, t1: 1.0, endOp: 1 }
];

// ---------------------------------------------------------------------------
// L1 + L2
// ---------------------------------------------------------------------------
var fails = [], warns = [];
console.log('=== L1/L2 逐模式扫描（NaN / 端点 / 采样） ===');
CASES.forEach(function (c) {
  var r = sweep(c.f, c.t0, c.t1, 41);
  var tag = ('  ' + c.n).padEnd(22, ' ');
  var line = r.samples.map(keyOf).join(' → ');
  if (r.bad.length) {
    fails.push(c.n + ' 含 NaN/Inf ×' + r.bad.length + ' （例：' + r.bad[0] + '）');
    console.log(tag + 'NaN×' + r.bad.length + ' ❌');
    return;
  }
  // 端点断言
  var s0 = c.f(c.t0), s1 = c.f(c.t1);
  var probs = [];
  function opOf(x) { return x == null ? null : (typeof x === 'number' ? x : x.op); }
  if (c.startOp != null) {
    var v0 = opOf(s0);
    if (v0 != null && Math.abs(v0 - c.startOp) > 0.02) probs.push('起点 op=' + v0.toFixed(3) + ' 期望 ' + c.startOp);
  }
  if (c.endOp != null) {
    var v1 = opOf(s1);
    if (v1 != null && Math.abs(v1 - c.endOp) > 0.02) probs.push('终点 op=' + v1.toFixed(3) + ' 期望 ' + c.endOp);
  }
  if (probs.length) { warns.push(c.n + '：' + probs.join('；')); console.log(tag + line + '  ⚠ ' + probs.join('；')); }
  else console.log(tag + line + '  ✓');
});

// ---------------------------------------------------------------------------
// L3 参数门禁
// ---------------------------------------------------------------------------
console.log('\n=== L3 参数门禁（应拦住违规用法） ===');
var AUDIT = [
  { name: 'popIn', o: { from: 0 },            want: 'FAIL', why: '入场从 scale(0) 起 = 炸开' },
  { name: 'popIn', o: { dur: 0.5 },           want: 'WARN', why: 'UI 动效 0.5s > 300ms 上限' },
  { name: 'sheetIn', o: { dur: 0.5 },         want: 'OK',   why: '抽屉 500ms 是例外，不该报警' },
  { name: 'pulse', o: {},                     want: 'WARN', why: '无窗口的 pulse = 抽搐' },
  { name: 'listStagger', o: { gap: 0.15 },    want: 'FAIL', why: '错峰 150ms > 80ms 上限' },
  { name: 'listStagger', o: { gap: 0.01 },    want: 'FAIL', why: '错峰 10ms < 30ms 下限' },
  { name: 'popIn', o: { from: 0.95, dur: 0.2 }, want: 'OK', why: '标准用法应放行' }
];
AUDIT.forEach(function (a) {
  var r = UIM.audit(a.name, a.o);
  var ok = r.level === a.want;
  console.log('  ' + (a.name + ' ' + JSON.stringify(a.o)).padEnd(42, ' ') +
    '→ ' + r.level.padEnd(4) + ' 期望 ' + a.want + (ok ? '  ✓' : '  ❌') + '   ' + a.why);
  if (!ok) fails.push('audit(' + a.name + ',' + JSON.stringify(a.o) + ') 得 ' + r.level + '，期望 ' + a.want);
});

// ---------------------------------------------------------------------------
// L4 硬参数存活性（研究实测值被误改会静默降级）
// ---------------------------------------------------------------------------
console.log('\n=== L4 硬参数存活性 ===');
var HARD = [
  ['ENTER_MIN_SCALE', K.ENTER_MIN_SCALE, 0.95],
  ['PRESS_SCALE',     K.PRESS_SCALE,     0.97],
  ['DRAWER_DUR',      K.DRAWER_DUR,      0.50],
  ['UI_MAX_DUR',      K.UI_MAX_DUR,      0.30],
  ['TOAST_OFFSET',    K.TOAST_OFFSET,    14],
  ['REVEAL_THRESHOLD',K.REVEAL_THRESHOLD,100],
  ['DISMISS_VELOCITY',K.DISMISS_VELOCITY,0.11],
  ['STAGGER_MIN',     K.STAGGER_MIN,     0.03],
  ['STAGGER_MAX',     K.STAGGER_MAX,     0.08]
];
HARD.forEach(function (h) {
  var ok = Math.abs(h[1] - h[2]) < 1e-9;
  console.log('  ' + h[0].padEnd(18) + String(h[1]).padEnd(8) + (ok ? '✓' : '❌ 期望 ' + h[2]));
  if (!ok) fails.push('硬参数 ' + h[0] + ' = ' + h[1] + '，研究实测值为 ' + h[2]);
});

// popIn 起手 transform 字面校验
var p0 = UIM.popIn(0.4, { in: 0.4, dur: 0.22 });
var scaleOK = /scale\(0\.9500\)/.test(p0.tf);
console.log('  popIn 起手 tf     ' + p0.tf + (scaleOK ? '  ✓' : '  ❌ 应为 scale(0.9500)'));
if (!scaleOK) fails.push('popIn 起手不是 scale(0.95)：' + p0.tf);

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log('\n────────────────────────────────────────');
console.log('用例 ' + CASES.length + ' 条 · 门禁 ' + AUDIT.length + ' 条 · 硬参 ' + HARD.length + ' 项');
if (warns.length) { console.log('WARN ' + warns.length + ':'); warns.forEach(function (w) { console.log('  ⚠ ' + w); }); }
if (fails.length) { console.log('FAIL ' + fails.length + ':'); fails.forEach(function (f) { console.log('  ❌ ' + f); }); console.log('\n❌ 门禁不通过'); process.exit(1); }
console.log(warns.length ? '\n⚠ 通过（有警告）' : '\n✅ 全绿');
process.exit(0);
