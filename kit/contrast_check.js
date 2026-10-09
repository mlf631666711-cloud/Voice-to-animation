/**
 * kit/contrast_check.js —— 文字对比度客观检查（标准件 · 通用）
 *
 * 诞生背景：2026-09-15 uvc-seg8 返工轮。老板反馈「**文字嵌在产品图片上 文字根本看不清**」。
 * 第一版判据用 Otsu 双簇，结果**同色同底的两个元素量出 7.32 / 4.32**（`psramNum` vs `psramLbl`）
 * —— 判据自身内部不一致（BUG-2160）。差一点按坏数去改三个本来及格的元素。
 *
 * 本版口径（三条，都是踩出来的）：
 *   ① 底色**从帧里实测**：元素框内**量化众数色**（字覆盖率 <50% 时即底色）
 *      与「**最暗 40% 像素中位数**」**互校**；两者算出的对比度差 > `--tol` 标 CHECK 交人眼。
 *      （底总比字暗，所以两个估计都会落在底色上；分歧大 = 取样区不纯。）
 *   ② 字色**读 CSS 声明值**（`getComputedStyle().color`），不猜。
 *   ③ **带 alpha 的字色必须先与底合成再算** —— 漏这步会高估。
 *      （BUG-2167：字幕基底 `rgba(201,195,184,.38)` 实测只有 2.55，按 RGB 不算 alpha 会读成 10+。）
 *
 * 阈值（WCAG 2.1）：字号 ≥24px（或 ≥18.66px 粗体）= 大字 → 3.0；否则正文 → 4.5。
 * `--floor 1.10` 额外把「贴地板线」标出来 —— **余量 < 10% 才叫贴地板线**。
 * ⚠️ 这个 1.10 是按规格锁 §5.18 的**案例**定的：那里的"贴地板线"是 `3.02` vs 门槛 `3.0`
 *     ＝ **只余 0.7%**（BUG-2119）。**别把系数放大**：设 1.25 时，`waveLbl`（5.45 vs 4.5 ＝ 余量 21%）
 *    会被误报成"贴地板线" —— 判据虚报的代价是人开始忽略告警（§7.1 第 4 条同族）。
 *
 * 取样时刻**由元素自己给出**：不传 `--jobs` 时自动枚举全部含文字的元素，按 `--step`
 * 扫时间轴取**各自有效 opacity 峰值**时刻（BUG-2161：给 `.fps` 填错时刻 → 裁到空图 → 假 FAIL。
 * BUG-2156：采样窗口由被测量自身给出）。
 *
 * ⚠️ 已知局限（判据只能当底线）：对**高频花底**（板子丝印/走线/照片）会给出偏乐观的数 ——
 * 压在位图上的文字**仍必须人眼看观众尺度的整幅帧**（BUG-2159 / 规格锁 §5.18）。
 *
 * 用法:
 *   NODE_PATH=<puppeteer 所在 node_modules> node kit/contrast_check.js \
 *     --file projects/uvc-seg8/uvc_p4_why.html --dur 19.0 [--step 0.1] [--jobs jobs.json]
 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

function arg(name, def) {
  // ★ 2026-09-30（与 layout_check.js 同步）：同时支持 `--name value` 与 `--name=value`。
  //   只认前者 ⇒ `--step=1/30` 被 indexOf 判成"没传" ⇒ **静默退回默认值**（DG-268 同族）。
  const key = '--' + name, eq = key + '=';
  const eqHit = process.argv.find(a => a.startsWith(eq));
  if (eqHit !== undefined) return eqHit.slice(eq.length);
  const i = process.argv.indexOf(key);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

/* ★ 2026-09-30（DG-271，与 layout_check.js 同步）：**数值参数必须能认 `1/30`**。
   `parseFloat('1/30')` 在 `/` 处截断 ⇒ 返回 **1**（不是 0.0333…）⇒ 静默量错步长。 */
function num(raw, def) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return def;
  let v;
  try { v = Function('"use strict";return (' + raw + ')')(); } catch (e) { v = NaN; }
  if (typeof v !== 'number' || !isFinite(v)) {
    console.error('[contrast_check] ✗ 参数值不是合法数值：' + JSON.stringify(raw)
      + '（支持 `0.1` 与 `1/30` 两种写法）');
    process.exit(2);
  }
  return v;
}

const FILE = path.resolve(arg('file', ''));
const DUR = num(arg('dur', '0'), 0);
const STEP = num(arg('step', '0.1'), 0.1);
const JOBS_FILE = arg('jobs', '');
const MINOP = num(arg('minOp', '0.5'), 0.5);
const TOL = num(arg('tol', '1.2'), 1.2);
const FLOOR = num(arg('floor', '1.10'), 1.10);
const CHROME = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');

if (!FILE || !DUR) {
  console.error('用法: node kit/contrast_check.js --file <html> --dur <sec> [--step 0.1] [--jobs jobs.json]');
  process.exit(2);
}

/* ── 在页面里跑的像素测量（避免 node 侧解码 PNG） ── */
const PAGE_FN = `
window.__cc = {};
window.__cc.lin = function (c) { c = c / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
window.__cc.lum = function (p) { return 0.2126 * window.__cc.lin(p[0]) + 0.7152 * window.__cc.lin(p[1]) + 0.0722 * window.__cc.lin(p[2]); };
window.__cc.over = function (fg, a, bg) { return [0,1,2].map(i => fg[i] * a + bg[i] * (1 - a)); };
window.__cc.wcag = function (a, b) { var x = window.__cc.lum(a), y = window.__cc.lum(b); return (Math.max(x,y) + 0.05) / (Math.min(x,y) + 0.05); };
/* 由 data URL 的裁图算出：底的两个估计 + 两口径对比度 */
window.__cc.measure = function (dataUrl, fgRGB, fgA) {
  return new Promise(function (res) {
    var img = new Image();
    img.onload = function () {
      var cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
      var cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
      var d = cx.getImageData(0, 0, img.width, img.height).data;
      var n = img.width * img.height;
      if (n < 40) { res(null); return; }
      var px = new Array(n), hist = {}, i, k, L = new Array(n);
      for (i = 0; i < n; i++) {
        var r = d[i*4], g = d[i*4+1], b = d[i*4+2];
        px[i] = [r, g, b]; L[i] = window.__cc.lum(px[i]);
        k = (r >> 3) * 1024 + (g >> 3) * 32 + (b >> 3);
        hist[k] = (hist[k] || 0) + 1;
      }
      var best = -1, bk = 0;
      for (k in hist) { if (hist[k] > best) { best = hist[k]; bk = +k; } }
      var mode = [((bk / 1024) | 0) * 8 + 4, (((bk / 32) | 0) % 32) * 8 + 4, (bk % 32) * 8 + 4];
      // 亮度中位数（判断"字比框里多数像素亮还是暗"）
      var Ls = L.slice().sort(function (a, b) { return a - b; });
      var med = Ls[Math.floor(n / 2)];
      // 暗簇（最暗 40%）与亮簇（最亮 40%）各自的均值色
      var idx = px.map(function (_, j) { return j; }).sort(function (a, b) { return L[a] - L[b]; });
      var cut = Math.max(1, Math.floor(n * 0.4));
      function avg(from, cnt) { var s = [0, 0, 0]; for (var j = from; j < from + cnt; j++) { var p = px[idx[j]]; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; } return [s[0]/cnt, s[1]/cnt, s[2]/cnt]; }
      var dark = avg(0, cut), bright = avg(n - cut, cut);
      /* ★ 选底规则（本轮实测得出）：**底色 = 远离字色亮度的那一侧**。
         字比框里多数像素亮 → 底色取暗簇；字比多数像素暗（如深字压亮药丸）→ 底色取亮簇。
         ⚠️ 不能"取两口径较小值"：字框紧、字形占多数时「众数色＝字色」，会把字色当底色，
            量出 1.01 这种假 FAIL（steadySeal 的 .big b、.w 词元都中招）。 */
      var fgL = window.__cc.lum(fgRGB);
      var bg = (fgL >= med) ? dark : bright;
      var bgTag = (fgL >= med) ? 'dark40' : 'bright40';
      var f1 = window.__cc.over(fgRGB, fgA, bg);
      return res({
        w: img.width, h: img.height, mode: mode, bg: bg, bgTag: bgTag,
        dark: dark, bright: bright, med: med,
        c: window.__cc.wcag(f1, bg), cMode: window.__cc.wcag(window.__cc.over(fgRGB, fgA, mode), mode)
      });
    };
    img.onerror = function () { res(null); };
    img.src = dataUrl;
  });
};
`;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--allow-file-access-from-files', '--hide-scrollbars',
           '--force-device-scale-factor=1', '--window-size=1920,1080']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.goto('file:///' + FILE.replace(/\\/g, '/') + '?t=0', { waitUntil: 'load' });
  await page.evaluate(() => { const o = document.getElementById('startOv'); if (o) o.style.display = 'none'; });
  await page.evaluate(PAGE_FN);

  // 让页面把元素截图交回页面算像素（裁图走 data URL，不经 node 解码）
  const probe = async (sel, t) => {
    await page.evaluate(x => window.__frame(x), t);
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const info = await page.evaluate(s => {
      const e = document.querySelector(s); if (!e) return null;
      let o = 1, q = e; while (q && q !== document.body) { const c = parseFloat(getComputedStyle(q).opacity); if (!isNaN(c)) o *= c; q = q.parentElement; }
      const r = e.getBoundingClientRect();
      if (e.offsetWidth <= 2 || e.offsetHeight <= 2) o = 0;
      const cs = getComputedStyle(e);
      return { op: o, color: cs.color, size: parseFloat(cs.fontSize),
               weight: parseInt(cs.fontWeight, 10) || 400,
               rect: [r.x, r.y, r.width, r.height] };
    }, sel);
    if (!info || info.op < MINOP) return { skipped: info ? info.op : -1 };
    const el = await page.$(sel);
    let b64;
    try { b64 = await el.screenshot({ encoding: 'base64' }); } catch (e) { return { skipped: 'screenshot:' + e.message }; }
    const m = await page.evaluate((u, c) => {
      const mm = c.match(/rgba?\(([^)]+)\)/);
      const v = mm[1].split(',').map(Number);
      const a = v.length > 3 ? v[3] : 1;
      return window.__cc.measure(u, [v[0], v[1], v[2]], a);
    }, 'data:image/png;base64,' + b64, info.color);
    if (!m) return { skipped: 'decode' };
    return { info, m };
  };

  let JOBS;
  if (JOBS_FILE) {
    JOBS = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'))
      .map(j => ({ t: j[0], sel: j[1], lab: j[2] || j[1] }));
  } else {
    // 自动枚举含文字的元素
    const inv = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('*').forEach(el => {
        const t = Array.from(el.childNodes).filter(n => n.nodeType === 3)
          .map(n => n.textContent.trim()).join('').trim();
        if (!t || !t.replace(/\s/g, '')) return;
        el.setAttribute('data-ccsel', '1');
        out.push({ text: t.slice(0, 24) });
      });
      return out;
    });
    const n = inv.length;
    const best = new Array(n).fill(0), bt = new Array(n).fill(-1);
    for (let t = 0; t <= DUR + 1e-6; t += STEP) {
      const tt = Math.round(t * 100) / 100;
      await page.evaluate(x => window.__frame(x), tt);
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      const ops = await page.evaluate(() => Array.from(document.querySelectorAll('[data-ccsel]')).map(e => {
        let o = 1, q = e; while (q && q !== document.body) { const c = parseFloat(getComputedStyle(q).opacity); if (!isNaN(c)) o *= c; q = q.parentElement; }
        if (e.offsetWidth <= 2 || e.offsetHeight <= 2) o = 0;
        if (o < 0.5) o = 0;
        return o;
      }));
      for (let i = 0; i < n; i++) if (ops[i] > best[i]) { best[i] = ops[i]; bt[i] = tt; }
    }
    JOBS = [];
    for (let i = 0; i < n; i++) {
      if (best[i] < MINOP) continue;
      JOBS.push({ t: bt[i], idx: i, lab: inv[i].text || ('el' + i) });
    }
    // 给每个候选挂唯一 data-ccid（DOM 顺序 ＝ inv 顺序），再按 id 选，避免 nth-of-type 歧义
    const ids = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-ccsel]')).map((e, i) => {
        e.setAttribute('data-ccid', '__ccid' + i);
        return '__ccid' + i;
      }));
    JOBS.forEach(j => { j.sel = '[data-ccid="' + ids[j.idx] + '"]'; });
  }

  const rows = [];
  for (const j of JOBS) {
    const r = await probe(j.sel, j.t);
    if (!r || r.skipped !== undefined) {
      if (r && r.skipped !== -1) console.log('SKIP', j.lab, '(' + r.skipped + ')');
      continue;
    }
    const { info, m } = r;
    /* ★★ 2026-09-15 修：本文件头注释第 16 行早就写了
       「字号 ≥24px（**或 ≥18.66px 粗体**）= 大字 → 3.0」，但这里原先只写了
       `info.size >= 24 ? 3.0 : 4.5` —— **粗体豁免根本没实现**（BUG-1210 同型：
       注释声明 ≠ 代码规格）。后果是**假告警**：`uvc-seg9` 的 `.pc-stale`「旧帧」
       （23px / font-weight:800，WCAG 2.1 明确算大字）被判 4.5 口径，
       4.90 只余 8.9% → 报「⚠贴地板线」；按真口径 3.0 算余量是 **63%**。
       ★ 这是**把判据修回它自己声明的规格**，不是放宽 —— 判据「放宽」指的是把
         门槛从改口径里挪走；这里门槛没动（仍是 WCAG 2.1 的 24px/18.66px），
         动的是"这条文本该套哪个门槛"的实现缺失。 */
    const large = info.size >= 24 || (info.weight >= 700 && info.size >= 18.66);
    const thr = large ? 3.0 : 4.5;
    rows.push({
      lab: j.lab, t: j.t, size: info.size, thr, c: m.c, cMode: m.cMode,
      spread: Math.abs(m.c - m.cMode), bgTag: m.bgTag, bg: m.bg.map(Math.round),
      mode: m.mode.map(Math.round), med: m.med,
      ok: m.c >= thr, floor: m.c >= thr && m.c < thr * FLOOR
    });
  }

  rows.sort((a, b) => a.c - b.c);
  console.log('文件:', FILE, ' 时长:', DUR + 's  步长:', STEP + 's');
  console.log('');
  console.log('元素'.padEnd(26) + '时刻'.padStart(7) + '字号'.padStart(6) + '阈值'.padStart(6) +
              '对比度'.padStart(8) + '底(取自)'.padStart(12) + '众数色'.padStart(18) + '  判定');
  let bad = 0, floorN = 0, check = 0;
  for (const r of rows) {
    let tag = r.ok ? 'PASS' : '**FAIL**';
    if (r.floor) { tag += ' ⚠贴地板线'; floorN++; }
    // 口径分歧大 = 字框紧/字形占多数/底色花 → 标 CHECK 交人眼（不代表不合格）
    if (r.spread > TOL) { tag += ' CHECK'; check++; }
    if (!r.ok) bad++;
    console.log(r.lab.slice(0, 24).padEnd(26) + String(r.t).padStart(7) + String(r.size).padStart(6) +
                String(r.thr).padStart(6) + r.c.toFixed(2).padStart(8) +
                ('[' + r.bg + ']' + r.bgTag.replace('40', '')).padStart(12) +
                ('[' + r.mode + ']').padStart(18) + '  ' + tag);
  }
  console.log('');
  console.log(`不合格 ${bad} 项 · 贴地板线 ${floorN} 项 · 需人眼复核(CHECK) ${check} 项`);
  console.log('⚠️ CHECK = 众数色与选定底分歧大（字框紧/底花），该行数只作参考；**压在位图上的文字判据一律不作放行依据，必须人眼看过观众尺度整幅帧**（BUG-2159）。');
  await browser.close();
  process.exit(bad ? 1 : 0);
})();
