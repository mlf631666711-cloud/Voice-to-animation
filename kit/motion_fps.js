/* 单文件 HTML 动效工程 · 端到端逐帧探针（通用）
   用法: node motion_fps.js <html路径> [--el <选择器>] [--btn <选择器>]

   它和 motion_smooth.js 的分工：
     motion_smooth.js  密集采样**页面暴露的纯函数** → 数学判据
     motion_fps.js     **真实播放**、逐帧读 **DOM 上真实的 transform 矩阵** → 端到端判据
   ★ 两条都要跑。数学全绿 ≠ 交付 —— 实例 BUG-2122：数学说停顿 29ms，
     端到端说 4 帧 / 28ms，**两个口径互证**才敢过。

   ⚠️ 三个坑（都踩过）：
   ① headless 的 rAF **不锁帧**（dt 中位 7ms、偶尔 33ms）→ 速度/加速度**必须除以 Δt**；
      直接看「每帧位移」会把采样抖动误读成运动抖动。
   ② 判据别用「逐帧 max|a| / 中位」—— Δt 一抖它就假 FAIL（实测同一页面 1.10 ↔ 1.69 反复）。
      **改用对 v(t) 做最小二乘直线拟合看 R²**：R² 天然免疫不规则采样。
      匀速加速穿零 ⇒ v(t) 是直线 ⇒ R² ≈ 1；软起步/软收尾 ⇒ 弯 ⇒ R² 明显低。
   ③ 必须真读 DOM（`getComputedStyle(el).transform` → `DOMMatrixReadOnly.m42`），
      **不能拿纯函数 `__probe(t)` 的结果冒充** —— 那是数学，不是"画面上真的动了"。          */
const puppeteer = require('puppeteer');
const { pathToFileURL } = require('url');
const path = require('path');

const FILE = process.argv[2];
if (!FILE) { console.log('用法: node motion_fps.js <html路径> [--el <选择器>] [--btn <选择器>]'); process.exit(1); }
const arg = (name, d) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : d; };
const BTN = arg('--btn', '#play'), EL = arg('--el', '#track');
const URL0 = pathToFileURL(path.resolve(FILE)).href;

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new', args: ['--no-sandbox', '--force-device-scale-factor=1']
  });
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.setViewport({ width: 760, height: 1500, deviceScaleFactor: 1 });
  await p.goto(URL0, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 600));
  const CFG = await p.evaluate(() => (window.__CFG ? window.__CFG() : {}));
  const T2 = (CFG.HOLD != null) ? CFG.HOLD + CFG.ANT_D : null;
  const TOTAL = await p.evaluate(() => (window.__TOTAL ? window.__TOTAL() : 2.4));

  if (!(await p.$(EL))) { console.log('找不到元素 ' + EL + ' —— 用 --el 指定'); await b.close(); return; }

  /* ★ 真读 DOM：每帧取 transform 矩阵的 ty（m42）。
     ⚠️ 采样必须在页面【循环复位之前】收口（复位时 ty 从 -372 跳回 0，
       会被当成一帧 5 万 px/s 的垃圾速度，还会把 vmax / 阈值一起带歪）。 */
  const rec = await p.evaluate((BTN, EL, TSTOP) => new Promise(res => {
    const rows = []; let t0 = 0, n = 0, prevTime = 0, first = true;
    const btn = document.querySelector(BTN), el = document.querySelector(EL);
    if (!btn) return res([]);
    btn.click();
    function tick(now) {
      if (!t0) t0 = now;
      const t = (now - t0) / 1000;
      const ty = new DOMMatrixReadOnly(getComputedStyle(el).transform).m42;
      /* 首帧没有前一帧，dt 会等于绝对时间戳 → 速度算成几万 px/s 的垃圾。首帧只记录不出样本。 */
      if (first) { first = false; prevTime = now; }
      else rows.push({ t: t, dt: now - prevTime, ty: ty });
      prevTime = now;
      if (++n < 320 && t < TSTOP) requestAnimationFrame(tick); else res(rows);
    }
    requestAnimationFrame(tick);
  }), BTN, EL, Math.max(0.5, TOTAL - 0.04));
  if (rec.length < 10) { console.log('没抓到帧 —— 检查 --btn 选择器'); await b.close(); return; }

  const vs = [];
  for (let i = 1; i < rec.length; i++) {
    const dt = rec[i].dt;
    if (dt <= 0) continue;
    vs.push({ t: rec[i].t, dt: dt, v: (rec[i].ty - rec[i - 1].ty) / (dt / 1000) });
  }
  const pct = (arr, k) => { const s = arr.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * k))]; };
  const vmax = Math.max(...vs.map(x => Math.abs(x.v)));
  console.log('\n【端到端 · ' + path.basename(FILE) + '】 真实播放 ' + vs.length + ' 帧  JS_ERRORS=' + errs.length);
  console.log('  探针: 元素 ' + EL + '   ·   数据源 = DOM transform 矩阵（不是纯函数）');
  console.log('  采样帧间隔(ms): 中位=' + pct(vs.map(x => x.dt), .5).toFixed(2) +
              '  p90=' + pct(vs.map(x => x.dt), .9).toFixed(2) +
              '  max=' + Math.max(...vs.map(x => x.dt)).toFixed(2));
  console.log('  速度(px/s): 中位=' + pct(vs.map(x => Math.abs(x.v)), .5).toFixed(0) +
              '  p90=' + pct(vs.map(x => Math.abs(x.v)), .9).toFixed(0) + '  峰值=' + vmax.toFixed(0));

  if (T2 == null) { console.log('  页面未暴露 __CFG()，跳过枢轴专项'); await b.close(); return; }

  const stalls = vs.filter(r => Math.abs(r.t - T2) < 0.25 && Math.abs(r.v) < vmax * 0.05);
  console.log('  ★ 枢轴±0.25s 内 |v|<5%峰值 的帧数 = ' + stalls.length +
              '  ≈ ' + (stalls.length * pct(vs.map(x => x.dt), .5)).toFixed(0) + 'ms');

  /* ★ 最小二乘拟合 v(t)：斜率 = 枢轴加速度，R² = 有多直。
     R² 免疫不规则采样 —— 这是「匀加速穿零」的正确判据形状。 */
  const W = 0.07;
  const near = vs.filter(x => Math.abs(x.t - T2) < W);
  if (near.length >= 5) {
    const ts = near.map(x => x.t), vv = near.map(x => x.v);
    const n = ts.length, mt = ts.reduce((a, c) => a + c, 0) / n, mv = vv.reduce((a, c) => a + c, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { sxy += (ts[i] - mt) * (vv[i] - mv); sxx += (ts[i] - mt) ** 2; syy += (vv[i] - mv) ** 2; }
    const slope = sxy / sxx, r2 = (syy === 0) ? 1 : (sxy * sxy) / (sxx * syy);
    const zeroCross = -mv / slope + mt;   // v=0 的时刻
    console.log('  ★ 枢轴 ±' + W + 's 内 v(t) 最小二乘拟合:');
    console.log('     斜率(=枢轴加速度) = ' + slope.toFixed(0) + ' px/s²   过零时刻 = t2' +
                (zeroCross - T2 >= 0 ? '+' : '−') + Math.abs(zeroCross - T2).toFixed(4) + 's');
    console.log('     R² = ' + r2.toFixed(4) + '   ' +
      (r2 > 0.99 ? '✓ 是直线 → 匀加速穿零，无折角无平台'
                 : r2 > 0.97 ? '△ 略弯（可能只是采样抖动，看下面的逐帧速度）'
                             : '✗ 明显弯 → 有停顿或折角（v 在零点附近被压平/折了一下）'));
    console.log('  枢轴前后逐帧速度（t / v）:');
    console.log('    ' + near.map(x => x.t.toFixed(3) + '/' + x.v.toFixed(0)).join('  '));
  }
  await b.close();
})();
