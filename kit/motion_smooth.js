/* 单文件 HTML 动效工程 · 平滑度三判据自检（通用）
   用法: node motion_smooth.js <html路径> [标签]

   约定（目标页面需暴露的探针，与管线全局规则「全 JS __frame(t) 纯函数」一致）：
     window.__pos(t)   → 位移（纯函数，不碰 DOM）★ 必需，密集采样走这个
     window.__vel(t)   → 速度             （判据③ 用；没有则跳过③）
     window.__TOTAL()  → 总时长
     window.__CFG()    → {HOLD, ANT_D, DUR, ...}  （分段用；判据②③ 靠它定位枢轴）
     window.__ANALYZE()→ 页面内自检结果（可选，用于交叉校验）

   三条判据是【三个独立失效模式】，缺一条都会放过 bug（实例 BUG-2122）：
   ① 收敛性      —— 抓「速度突变」。max|a| 随采样变细应收敛；突变则随 dt 减半而翻倍。
   ② 中途停顿    —— 抓「低速平台」。|v|<5%峰值 且被两次"够快"的运动夹住的时长。
                    ★ 判据① 完全抓不到这个（能全绿），而它才是观众看到的"顿一下"。
   ③ 枢轴折角    —— 抓「加速度不接」。速度过零点两侧 |a| 若不等 → 折角。
                    两侧都≈0（软起步）时比值无意义 → 看②。                          */
const puppeteer = require('puppeteer');
const { pathToFileURL } = require('url');
const path = require('path');

const FILE = process.argv[2];
const LABEL = process.argv[3] || path.basename(FILE || '');
if (!FILE) { console.log('用法: node motion_smooth.js <html路径> [标签]'); process.exit(1); }
const URL0 = pathToFileURL(path.resolve(FILE)).href;

async function sample(p, N, T) {
  return p.evaluate((N, T) => {
    const f = window.__pos || (t => window.__probe(t).disp);
    if (!f) throw new Error('目标页面没有暴露 __pos / __probe —— 无法采样位移');
    const out = [];
    for (let i = 0; i <= N; i++) out.push([i / N * T, f(i / N * T)]);
    return out;
  }, N, T);
}
function accel(data, dt) {
  const v = [];
  for (let i = 1; i < data.length; i++) v.push({ t: data[i][0], v: (data[i][1] - data[i - 1][1]) / dt });
  const a = [];
  for (let i = 1; i < v.length; i++) a.push({ t: v[i].t, a: (v[i].v - v[i - 1].v) / dt, v: v[i].v });
  return { v, a };
}
/* ② 中途停顿：|v|<thr 且被两次「够快」的运动夹住 */
function stall(vs, k) {
  const vmax = Math.max(...vs.map(x => Math.abs(x.v))), thr = vmax * k;
  let first = -1, last = -1;
  for (let i = 0; i < vs.length; i++) if (Math.abs(vs[i].v) >= thr) { if (first < 0) first = i; last = i; }
  if (first < 0 || last <= first) return { vmax, thr, dur: 0, t0: 0, t1: 0, n: 0 };
  let best = 0, bt0 = 0, bt1 = 0, cur = 0, c0 = 0, cnt = 0;
  for (let i = first; i <= last; i++) {
    if (Math.abs(vs[i].v) < thr) { if (cur === 0) c0 = vs[i].t; cur++; }
    else { if (cur > best) { best = cur; bt0 = c0; bt1 = vs[i].t; cnt++; } cur = 0; }
  }
  if (cur > best) { best = cur; bt0 = c0; bt1 = vs[last].t; cnt++; }
  return { vmax, thr, dur: bt1 - bt0, t0: bt0, t1: bt1, n: cnt };
}
function reversals(vs, k) {
  const vmax = Math.max(...vs.map(x => Math.abs(x.v))), thr = vmax * k;
  let s0 = 0, n = 0;
  for (const x of vs) {
    const s = Math.abs(x.v) < thr ? 0 : Math.sign(x.v);
    if (s && s0 && s !== s0) n++;
    if (s) s0 = s;
  }
  return n;
}

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new', args: ['--no-sandbox']
  });
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(URL0, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 450));
  const T = await p.evaluate(() => window.__TOTAL());
  const CFG = await p.evaluate(() => (window.__CFG ? window.__CFG() : {}));
  const N1 = 2300, N2 = 4600;
  const A1 = accel(await sample(p, N1, T), T / N1);
  const A2 = accel(await sample(p, N2, T), T / N2);
  const mx = arr => Math.max(...arr.map(x => Math.abs(x.a)));
  const m1 = mx(A1.a), m2 = mx(A2.a);
  const HOLD = CFG.HOLD, ANTD = CFG.ANT_D, DUR = CFG.DUR;
  const stage = t => (HOLD == null) ? '' :
    (t < HOLD ? '静默' : t < HOLD + ANTD ? '前摇' : t < HOLD + ANTD + DUR ? '主运动' : '落位');
  const worst = A2.a.slice().sort((x, y) => Math.abs(y.a) - Math.abs(x.a)).slice(0, 4);
  const st = stall(A2.v, 0.05);
  const rev = reversals(A2.v, 0.05);

  console.log('\n【' + LABEL + '】 TOTAL=' + T.toFixed(2) + 's   JS_ERRORS=' + errs.length);
  console.log('  判据① 收敛性:');
  console.log('    dt=' + (T / N1 * 1000).toFixed(3) + 'ms → max|a|=' + m1.toFixed(0) +
              '   |   dt=' + (T / N2 * 1000).toFixed(3) + 'ms → max|a|=' + m2.toFixed(0) +
              '   比值=' + (m2 / m1).toFixed(2) + ' ' +
              (m2 / m1 < 1.15 ? '✓ 收敛=平滑' : '✗ 不收敛=有速度突变'));
  console.log('  max|a|=' + m2.toFixed(0) + ' px/s²   最大速度=' + st.vmax.toFixed(0) + ' px/s');
  if (stage('')) console.log('  最大加速度点: ' + worst.map(w =>
    't=' + w.t.toFixed(3) + '(' + stage(w.t) + '=' + Math.round(w.a) + ')').join('  '));
  console.log('  判据② 中途停顿 (<5%峰值=' + st.thr.toFixed(1) + ' px/s): ' +
              (st.dur * 1000).toFixed(0) + 'ms  = ' + (st.dur * 60).toFixed(1) + ' 帧@60fps   ' +
              (st.dur < 0.060 ? '✓ 看不出来' : st.dur < 0.100 ? '△ 临界' : '✗ 观众会看到"顿一下"'));
  console.log('    停顿窗口 t=' + st.t0.toFixed(3) + '~' + st.t1.toFixed(3) + 's   次数=' + st.n);
  console.log('  折返次数(中途换向) = ' + rev + (rev === 1 ? '  ✓ 只有一次' : '  ⚠ 多于一次 = 多给了观众一次"停"'));
  /* ③ 枢轴折角 */
  const kk = await p.evaluate(() => {
    if (!window.__vel || !window.__CFG) return null;
    const c = window.__CFG(), t2 = c.HOLD + c.ANT_D, d = 0.0005;
    if (!c.ANT_D || c.ANT_D <= 0) return null;
    const v0 = window.__vel(t2 - d), v1 = window.__vel(t2), v2 = window.__vel(t2 + d);
    return { am: (v1 - v0) / d, ap: (v2 - v1) / d };
  });
  if (kk) {
    const den = Math.max(Math.abs(kk.am), Math.abs(kk.ap), 1e-9);
    const kink = Math.abs(kk.ap - kk.am) / den;
    console.log('  判据③ 枢轴折角: 前侧 a=' + kk.am.toFixed(0) + '  后侧 a=' + kk.ap.toFixed(0) +
      '  px/s²   折角=' + (kink * 100).toFixed(1) + '%  ' +
      (den < 50 ? '（两侧都≈0 ⇒ 无斜率，必停顿 —— 看判据②）'
                : kink < 0.02 ? '✓ 斜着穿零，无折角' : '✗ 有折角 = 节奏不接'));
  } else {
    console.log('  判据③ 枢轴折角: 跳过（页面未暴露 __vel 或没有前摇段）');
  }
  /* 交叉校验：页面内自检 */
  const inPage = await p.evaluate(() => {
    const r = window.__ANALYZE && window.__ANALYZE();
    return r ? { stall: r.stall } : null;
  });
  if (inPage) {
    const d = Math.abs(inPage.stall - st.dur) * 1000;
    console.log('  交叉校验: 页面内自检读到的停顿 = ' + (inPage.stall * 1000).toFixed(0) + 'ms  ' +
      (d < 5 ? '✓ 两套实现一致' : '⚠ 差 ' + d.toFixed(0) + 'ms —— 有一边口径不同，别急着信'));
  }
  await b.close();
})();
