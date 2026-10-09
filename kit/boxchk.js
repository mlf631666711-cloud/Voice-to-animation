/* 安全框自检：逐帧遍历全部可见文字元素，报出越出安全框 (52,70)-(1872,1008) 的项。
 * 用法：node kit/boxchk.js [from] [to] [step] [工程目录或 html]
 *   from/to 单位秒（默认 0 ~ 9.52），step 默认 0.1s
 * ★ 有效不透明度必须沿祖先链累乘 —— 本管线显隐按铁律写在 .card 叶子上，
 *   只读元素自身 opacity 会把「父层已隐藏」的元素算成可见（首跑据此误报 48/96 帧）。
 * 2026-09-11 新增 —— 起因：二审报「t=5.28 字幕底边 1013，越安全框 1008」，
 * 而逐个 sel 去量太慢且容易漏（越界的未必是我以为的那个字）。
 *
 * 退出码：0 全部在框内；1 有越界；**2 = 本判据不适用（坐标系不匹配，写 N/A）**。
 * ---------------------------------------------------------------------------
 * ★★ 坐标系自检（2026-09-21 立 · 4K 轮）
 *
 * 安全框常量 (52,70)-(1872,1008) 全部是**设计坐标系**（1920×1080）里的数 ——
 * 它们量的是 `getBoundingClientRect()`，而 rect **永远返回 CSS px**。
 *
 * ⇒ 出 4K 的正确姿势是「视口保持设计尺寸 + 抬 devicePixelRatio」，
 *   **CSS 坐标系统根本没变** ⇒ 安全框**不许等比例放大**。
 *
 * 反证实测（`_tmp/_safearea_ab.cjs`）：正确 4K 姿态（视口 1920 + dsf2、栅格 3840）下，
 *   把框 ×2 成 (160,160)-(3680,1760) 会把画面里几乎每个元素判成「左+24」之类 ——
 *   **判据方向反了就恒 FAIL**，而且是「看起来在认真工作」的那种 FAIL。
 *
 * ⚠️ 真正需要换算的情形**只有一种**：视口被放大（给 1920 设计的页塞 3840 视口）。
 *   那时 `body.offsetWidth` 会明显小于视口宽 ⇒ 坐标系已不匹配 ⇒ 本判据整体**不适用**，
 *   必须写 **N/A**，而不是给一个「查无异常」的绿 —— **「查不到」不等于「没问题」**。
 *   （这就是 BUG-2398 那个病：文件尺寸判据照样 PASS。）
 */
const P = require('./probe-lib');

const SAFE = { l: 52, t: 70, r: 1872, b: 1008 };
const SAFE_STR = '(52,70)-(1872,1008)';

(async () => {
  const from = +(process.argv[2] || 0);
  const to = +(process.argv[3] || 9.52);
  const step = +(process.argv[4] || 0.1);
  const p = await P.open(process.argv[5] || __dirname, { quiet: true });

  const res = await p.page.evaluate((a) => {
    /* ---- 坐标系自检：先确认「页面按哪个尺寸排的版」 ---- */
    const env = {
      dpr: window.devicePixelRatio,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      bodyW: document.body ? document.body.offsetWidth : 0,
      bodyH: document.body ? document.body.offsetHeight : 0,
      rasterW: window.innerWidth * window.devicePixelRatio,
      rasterH: window.innerHeight * window.devicePixelRatio,
      proxyCount: 0,
    };

    const out = [];
    for (let t = a.from; t <= a.to + 1e-6; t += a.step) {
      const tt = +t.toFixed(4);
      window.__frame(tt);
      const bad = [];
      /* ★ 有效不透明度必须**沿祖先链累乘**。本工程的显隐按铁律写在 .card（叶子）上，
         只读元素自身的 opacity 会把「父层已隐藏、自身 opacity 仍为 1」的元素当成可见
         —— 首跑据此误报了 48/96 帧「大标题越上界 +20~44px」，实际它那时的父层 opacity=0。
         判「某个元素有没有越界」之前，先判它「到底看没看见」。 */
      const effOp = function (el) {
        let o = 1, n = el;
        while (n && n !== document.documentElement) {
          o *= +(getComputedStyle(n).opacity || 1);
          if (o < 0.03) return 0;
          n = n.parentElement;
        }
        return o;
      };
      document.querySelectorAll('.l10-tline .ch, .l10-bigtitle span, .dim-text').forEach(function (el) {
        if (effOp(el) < 0.06) return;                   /* 已淡出不计（沿祖先链） */
        const rr = el.getBoundingClientRect();
        if (rr.width < 2 || rr.height < 2) return;      /* 不可见（缩放为 0）不计 */
        const over = [];
        if (rr.left   < a.S.l) over.push('左+' + (a.S.l - rr.left).toFixed(1));
        if (rr.top    < a.S.t) over.push('上+' + (a.S.t - rr.top).toFixed(1));
        if (rr.right  > a.S.r) over.push('右+' + (rr.right - a.S.r).toFixed(1));
        if (rr.bottom > a.S.b) over.push('下+' + (rr.bottom - a.S.b).toFixed(1));
        if (over.length) bad.push((el.textContent || '?') + '[' + over.join(',') + ']');
      });
      out.push({ t: tt, bad: bad });
    }
    return { env: env, rows: out };
  }, { from: from, to: to, step: step, S: SAFE });

  const env = res.env, rows = res.rows;

  /* ---- 打印坐标系：让操作者一眼看到「这条判据是在哪个坐标系里量的」 ---- */
  console.log('  坐标系：视口 ' + env.innerW + '×' + env.innerH
    + ' · dpr ' + env.dpr + ' · 设计(body) ' + env.bodyW + '×' + env.bodyH
    + ' · 截图栅格 ' + env.rasterW + '×' + env.rasterH);

  /* ---- 不适用判定：视口被放大 ⇒ 坐标系不匹配 ⇒ N/A，绝不给绿 ---- */
  if (env.bodyW > 0 && env.bodyW < env.innerW * 0.9) {
    console.log('');
    console.log('  ⚠️ N/A —— **本判据不适用**：安全框是**设计坐标系**里的常量，');
    console.log('      而 body 只有 ' + env.bodyW + ' 宽、被塞进了 ' + env.innerW + ' 宽的视口。');
    console.log('      这是「大画布 + 小画面」的姿势（BUG-2398），CSS 坐标系与判据口径不一致。');
    console.log('      ⇒ 正确做法：视口保持设计尺寸 ' + env.bodyW + '，4K 靠 devicePixelRatio 抬。');
    console.log('      ⇒ 若确实要在这个视口下判，必须先把安全框按 ' + (env.innerW / env.bodyW).toFixed(2)
      + '× 换算（但那时画面本身就是错的，先修渲染姿势）。');
    console.log('  ★ 结论写 **N/A**，不是 PASS —— 「查不到」不等于「没问题」。');
    await p.close();
    process.exit(2);
  }

  let badN = 0;
  rows.forEach(function (r) {
    if (!r.bad.length) return;
    badN++;
    console.log('  t=' + String(r.t).padEnd(7) + '❌  ' + r.bad.join('  '));
  });
  console.log(badN
    ? '  共 ' + badN + '/' + rows.length + ' 帧有元素越出安全框 ' + SAFE_STR
    : '  ✓ ' + rows.length + ' 帧全部元素在安全框内 ' + SAFE_STR);
  await p.close();
  process.exit(badN ? 1 : 0);
})().catch(function (e) { console.error(e.message); process.exit(1); });
