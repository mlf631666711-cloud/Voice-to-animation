#!/usr/bin/env node
/* ============================================================================
 * trial.js —— 语音转动画总项目 · 总审判器（**一个就够**）
 *
 * 为什么有这个文件：
 *   以前是「kit/ 40+ 个脚本 + 每个项目各自的 _q*.cjs」＝ 门槛一大堆，
 *   全靠我记得去跑哪一个 ⇒ 2026-09-30 老板拿第三关截帧指出「文字叠起来」
 *   +「一堆没必要的小字」，而 kit/quad_check.js 明明一直在、退出码 1、能抓，
 *   **我一次都没跑**。规矩写在文档里没用，得写在**代码路径**上。
 *   于是：所有门禁收敛成这一个脚本，跑一次就知道「这条片子能不能交付」。
 *
 * 三档模式（口径待老板定版，初版默认值如下）：
 *   --mode fast     极速   DOM 每 2 帧扫一次 · 像素每 6 帧抽一次   ≈ 30s
 *   --mode standard 标准   DOM 全帧 · 像素每 3 帧抽一次             ≈ 60s  【默认】
 *   --mode deep     钻研   全帧全量 + 眼审截帧 + 逐帧亮度曲线        ≈ 2min+
 * 差别只在**采样密度**，判据口径三档完全一致 —— 不存在「换个模式结论就变」。
 *
 * 判据分三层：
 *   【P0 必看】8 条红线 —— 任一 FAIL ⇒ exit 1 ⇒ **不许交付**。跨项目通用，
 *                        不依赖任何分镜表，只要是「window.__frame(t) + __dur」
 *                        契约的 HTML（或任意 mp4）就能跑。
 *   【P1 选看】报出来但不拦 —— 有空再收拾：相机连续性 / 小字密度 / 静帧段 / 复杂度。
 *   【P2 钻研】仅在 deep 模式：眼审截帧 + 逐帧亮度曲线。
 *
 * ★ 被本脚本吸收、以后**不要再单独跑**的旧门：
 *     kit/quad_check.js「一查·看遮挡」 → P0-OVL / P0-EDGE / P0-SAFE
 *     kit/boxchk.js / kit/layout_check.js → P0-SAFE（屏幕坐标版）
 *     _qdom_l3.cjs 的 OVL / LAB 两组   → P0-OVL / P0-EDGE（口径升级，见下）
 *   项目特化判据（GROW / S4GAP / 六锚 GATES …）**留在本项目自己的 _q*.cjs**，
 *   那是「选看」级别的，不进总审判。
 *
 * ★ 相对 _qdom_l3.cjs 的两处口径升级（都是踩过的坑）：
 *   ① **旋转元素必须用 OBB + 多边形裁剪算真实交面积**，不许拿 AABB 定罪 ——
 *      L3 的 `#s3rej` 是 rotate(-11deg) + border 6px + padding，AABB 被撑到
 *      899×366，把框外的「45 %」判成压字（假阳性）。这里用 offsetWidth/Height
 *      × 累计 scale 反解本地尺寸 + 累计旋转角 ⇒ 四个角点 ⇒ Sutherland–Hodgman
 *      精确裁剪。**近似判据不算判据**。
 *   ② **边带判定用屏幕坐标** —— 相机 scale>1 时会把元素推出设计画布：
 *      L3 的 S1 页脚世界坐标 y=942，相机 scale 1.05 + ty 30 ⇒ 屏幕 y=992，
 *      直接掉进底部 96px 字幕保留带。只看世界坐标会漏。
 *
 * 用法：
 *   node kit/trial.js <工程.html>                     # 标准档
 *   node kit/trial.js <工程.html> --mode fast
 *   node kit/trial.js <成片.mp4>                      # 成片档（ffprobe + signalstats）
 *   node kit/trial.js --self-test                     # ★ 自检：8 条红线必须全红
 *
 * 依赖：puppeteer-core（NODE_PATH）+ 本机 Chrome；mp4 档额外要 ffmpeg/ffprobe。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/* ─────────────────────────── CLI / 常量 ─────────────────────────── */
const argv = process.argv.slice(2);
const MODE = (() => {
  const i = argv.indexOf('--mode');
  const m = i >= 0 ? argv[i + 1] : 'standard';
  return ['fast', 'standard', 'deep'].includes(m) ? m : 'standard';
})();
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

const TARGET = argv.find(a => !a.startsWith('-') && !['fast', 'standard', 'deep'].includes(a));
const BAND   = Number(arg('--band', 96));      // 上/下保留带（字幕/标题）—— 铁律 221 + BUG-1314
const SMALL  = Number(arg('--small', 20));     // 「小字」字号上限（px）
const OVL_R  = Number(arg('--ovl', 0.12));     // 相交面积 / 较小者 —— 低于此不判
const OVL_F  = Number(arg('--ovlf', 2));       // 持续采样数 —— 低于此算转场穿插，只报不判
const JSON_OUT = arg('--json', '');

/* ★ 放行口：总审判器是**通用**的，它不知道「这一镜本来就要演两块压在一起」。
   这种「故意的压叠」用 --allow 放行，**理由写进命令行**（可追溯、能审计），
   不许靠「我记得这是对的」在脑子里放行。匹配方式 = 子串。
   例：--allow "bootloader∩分区表" */
const ALLOW = (arg('--allow', '') || '').split(',').map(s => s.trim()).filter(Boolean);

/* 死帧阈值：64×36 缩略图的**逐像素平均绝对差**，低于此 ⇒ 相邻抽样帧几乎一样。
   ★ 三版迭代的教训（阈值必须是实测的，不许拍脑袋）：
     v1  32×18 + 均值/标准差差 0.35  ⇒ 对缓慢平移完全无感，把镜头在动的段判成死帧
     v2  MAD 但手填 0.8             ⇒ 太高，把「只有小元素在动」的段也判成死帧
     v3  **自动定标**：MAD 分布是双峰（静止段 ≈P10，运动段 ≈P90），
         阈值取两峰的几何均值 √(P10×P90)，下限 0.5 兜底（防整片都静时阈值塌到 0）。
   想手动压就传 --mad <数>。 */
const FREEZE_MAD_OPT = arg('--mad', null);

/* ★ 系列一致性基准：传进同系列的「全局底色」样板（一般是先做的那条），
   审判器会把两条片子的**背景区块实际像素**并排量一遍。
   为什么要有这条：2026-10-01 老板发现「后面做的两条跟全局背景色不一样了」——
   而 L2/L3 各自内部完全自洽（冷蓝一致地铺满背景，单看挺好看），
   **所有判据都在问"这条片子内部有没有问题"，没有一条在问"它跟同系列其他片子是不是同一个底色"**
   ⇒ 跨片漂移 = 判据的结构性盲区。这条就是来补这个洞的。
   例：--series-ref ../v2/fx_c5_v2.src.html */
const SERIES_REF = arg('--series-ref', '');
const SERIES_TOL = Number(arg('--series-tol', 3));    // 色度 U/V 差的上限（默认 3）
function freezeSec(lum, thr) {
  let run = 0, worst = 0, at = 0;
  for (const o of lum) {
    if (o.mad >= 0 && o.mad < thr) { run++; if (run > worst) { worst = run; at = o.t; } }
    else run = 0;
  }
  return { n: worst, at: at, sec: worst * STEP.px / 30 };
}

const STEP = { fast: { dom: 2, px: 6 }, standard: { dom: 1, px: 3 }, deep: { dom: 1, px: 1 } }[MODE];

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
/* 发布件：ffmpeg 路径改接仓库自带的统一解析器 `kit/env-paths.js`
   （与 render-core.js 同一份候选表：扫 WinGet 目录、不写死版本号；都没有则交给 PATH）。
   可用 FFMPEG_BIN / FFPROBE_BIN 直接指定可执行文件覆盖。 */
const _envpaths = require('./env-paths');
const FFMPEG = process.env.FFMPEG_BIN || _envpaths.resolveFFmpeg();
const FFPROBE = process.env.FFPROBE_BIN || FFMPEG.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');

/* 判据容器 */
const RED = [], INFO = [], WARN = [];
const ok   = (tag, msg) => { INFO.push(tag + ' ' + msg); console.log('  \u2713 ' + tag.padEnd(9) + msg); };
const bad  = (tag, msg) => {
  /* ★ 放行串要「空白归一化」再比 —— 输出里是 `  ∩  `（两端带空格），
     用户手写的多半是 `∩`，直接 includes 会静默不匹配（放行看着像失效）。 */
  const flat = msg.replace(/\s+/g, '');
  /* ★ allow 支持 `+` 连接多个关键字（**全部出现**才放行），因为一条 OVL 消息里
     两个元素名中间夹着 `]  ∩  b.[` 这种分隔符，写连续子串永远匹配不上。
     例：--allow "bootloader+分区表" */
  const w = ALLOW.find(a => a.split('+').map(s => s.trim()).filter(Boolean)
    .every(k => flat.includes(k.replace(/\s+/g, ''))));
  if (w) { WARN.push(tag + ' ' + msg); console.log('  \u21ba ' + tag.padEnd(9) + msg + '   \u3010\u5df2\u653e\u884c\uff1a' + w + '\u3011'); return; }
  RED.push(tag + ' ' + msg); console.log('  \u2717 ' + tag.padEnd(9) + msg);
};
const note = (tag, msg) => { WARN.push(tag + ' ' + msg); console.log('  \u00b7 ' + tag.padEnd(9) + msg); };
const head = (s) => console.log('\n\u2500\u2500\u2500 ' + s + ' \u2500\u2500\u2500');

/* ═══════════════════ 浏览器侧工具（会被序列化进页面，禁止闭包外部变量） ═══════════════════ */

/** 一元：收集本帧「有墨迹的可见元素」清单 */
function tjCollect() {
  const root = document.getElementById('camera') || document.getElementById('stage') || document.body;
  const out = [];
  const all = root.querySelectorAll('*');
  for (let i = 0; i < all.length; i++) {
    const e = all[i];
    /* ① 只收「自己直接有字」的元素 —— 容器壳不算，否则父∩子必然相交（满屏假阳性） */
    let own = '';
    for (const n of e.childNodes) if (n.nodeType === 3) own += n.textContent;
    own = own.replace(/\s+/g, ' ').trim();

    const cs = getComputedStyle(e);
    const isMedia = /^(IMG|SVG|CANVAS|VIDEO)$/.test(e.tagName);
    const painted = !!own || isMedia ||
      cs.backgroundImage !== 'none' ||
      (cs.borderTopWidth !== '0px' || cs.borderLeftWidth !== '0px') ||
      (cs.boxShadow && cs.boxShadow !== 'none');
    if (!painted) continue;

    /* ② 有效不透明度 = 祖先连乘 */
    let op = 1, p = e;
    while (p && p !== document.body) { op *= Number(getComputedStyle(p).opacity || 1); p = p.parentElement; }
    if (op <= 0.05) continue;
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;

    const r = e.getBoundingClientRect();

    /* ③ 累计变换：本地尺寸 × 累计 scale，累计旋转角 —— 用于 OBB（旋转元素不许拿 AABB 定罪） */
    let ang = 0, sc = 1, q = e;
    while (q && q !== document.body) {
      const m = new DOMMatrixReadOnly(getComputedStyle(q).transform);
      if (m.a !== 1 || m.b !== 0 || m.c !== 0 || m.d !== 1) {
        ang += Math.atan2(m.b, m.a);
        sc *= Math.hypot(m.a, m.b) || 1;
      }
      q = q.parentElement;
    }
    const lw = (e.offsetWidth || r.width) * sc;
    const lh = (e.offsetHeight || r.height) * sc;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const c = Math.cos(ang), s = Math.sin(ang);
    const hw = lw / 2, hh = lh / 2;
    /* 四角按「y 向下」的顺时序 —— Sutherland–Hodgman 要求内部在边左侧 */
    const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
      .map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);

    out.push({
      el: e, tag: e.tagName.toLowerCase(), cls: (e.className || '').toString(),
      txt: own.slice(0, 26), op: op,
      x: r.left, y: r.top, w: r.width, h: r.height,
      fs: parseFloat(cs.fontSize) || 0, fw: Number(cs.fontWeight) || 400,
      lw: lw, lh: lh, ang: ang, corners: corners,
      area: Math.max(1, lw * lh)
    });
  }
  return out;
}

function tjIsAnc(a, b) { let p = b; while (p) { if (p === a) return true; p = p.parentElement; } return false; }

function tjPolyArea(P) {
  let s = 0;
  for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return Math.abs(s) / 2;
}
/* 半平面裁剪：保留边 (ax,ay)->(bx,by) 的左侧 */
function tjClipHalf(P, ax, ay, bx, by) {
  const ex = bx - ax, ey = by - ay, out = [];
  for (let i = 0; i < P.length; i++) {
    const c = P[i], d = P[(i + 1) % P.length];
    const sc = ex * (c[1] - ay) - ey * (c[0] - ax);
    const sd = ex * (d[1] - ay) - ey * (d[0] - ax);
    if (sc >= 0) out.push(c);
    if ((sc > 0 && sd < 0) || (sc < 0 && sd > 0)) {
      const t = sc / (sc - sd);
      out.push([c[0] + (d[0] - c[0]) * t, c[1] + (d[1] - c[1]) * t]);
    }
  }
  return out;
}
/** 两个凸多边形（旋转矩形）的**精确**交面积 */
function tjInterArea(A, B) {
  let P = B;
  for (let i = 0; i < A.length; i++) {
    const a = A[i], b = A[(i + 1) % A.length];
    P = tjClipHalf(P, a[0], a[1], b[0], b[1]);
    if (P.length < 3) return 0;
  }
  return tjPolyArea(P);
}

/* ───────── 系列基准底色采样：对任意 html 抽若干时刻的区块平均 RGB ─────────
   ★ 为什么单独写一份而不复用主流程：基准是**另一个文件**（不同时长、不同构图），
     只能另开一页。用**中位数**而不是逐时刻配对 —— 两条片子时长不一样、构图也不一样，
     配对没有意义；中位数能避开「某一时刻角上正好有内容」的偶然值。 */
async function sampleRefBlocks(browser, file) {
  let p = path.resolve(file), tmp = null;
  if (!/\.html$/i.test(p)) {   /* .bak 之类会被当 text/plain ⇒ 必须复制成 .html 才渲染得出来 */
    tmp = path.join(os.tmpdir(), 'trial_ref_' + Date.now() + '.html');
    fs.copyFileSync(p, tmp); p = tmp;
  }
  const pg = await browser.newPage();
  await pg.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await pg.goto('file:///' + p.replace(/\\/g, '/'), { waitUntil: 'networkidle0' });
  await pg.waitForFunction('typeof window.__frame === "function" && typeof window.__dur === "number"',
    { timeout: 20000 });
  const meta = await pg.evaluate(() => {
    const st = document.getElementById('stage') || document.getElementById('camera');
    return { w: st ? st.offsetWidth : 1920, h: st ? st.offsetHeight : 1080, dur: window.__dur,
             hideOv: typeof window.__hideOv === 'function' };
  });
  if (meta.hideOv) await pg.evaluate(() => window.__hideOv());
  await pg.setViewport({ width: meta.w, height: meta.h, deviceScaleFactor: 1 });
  await pg.exposeFunction('__tjShotR', async () => await pg.screenshot({ encoding: 'base64', type: 'png' }));
  const out = await pg.evaluate(async (dur) => {
    const GW = 64, GH = 36;
    const grab = async () => {
      const b64 = await window.__tjShotR();
      return await new Promise(res => {
        const im = new Image();
        im.onload = () => {
          const cv = document.createElement('canvas'); cv.width = GW; cv.height = GH;
          const g = cv.getContext('2d', { willReadFrequently: true });
          g.drawImage(im, 0, 0, GW, GH);
          const d = g.getImageData(0, 0, GW, GH).data;
          const N = GW * GH;
          let su = 0, sv = 0;
          for (let i = 0; i < d.length; i += 4) {
            su += -0.14713 * d[i] - 0.28886 * d[i + 1] + 0.436 * d[i + 2] + 128;
            sv += 0.615 * d[i] - 0.51499 * d[i + 1] - 0.10001 * d[i + 2] + 128;
          }
          res({ uv: [su / N, sv / N] });
        };
        im.onerror = () => res(null);
        im.src = 'data:image/png;base64,' + b64;
      });
    };
    const res = [];
    for (let k = 1; k <= 8; k++) { window.__frame(dur * k / 9); const b = await grab(); if (b) res.push(b); }
    return res;
  }, meta.dur);
  await pg.close();
  if (tmp) { try { fs.unlinkSync(tmp); } catch (e) {} }
  return out;
}
function medRGB(list) {   /* list = [[r,g,b], ...] → 各通道取中位数 */
  return [0, 1, 2].map(c => {
    const v = list.map(o => o[c]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  });
}
const rgbHex = (a) => '#' + a.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');

/* ══════════════════════════ HTML 档：主流程 ══════════════════════════ */
async function trialHtml(file) {
  let puppeteer;
  try { puppeteer = require('puppeteer-core'); }
  catch (e) { console.error('\n[trial] 找不到 puppeteer-core。请先设置 NODE_PATH：');
    console.error('  export NODE_PATH="<你装 puppeteer-core 的 node_modules>"');
    process.exit(2); }

  const HTML = 'file:///' + path.resolve(file).replace(/\\/g, '/');
  /* ★ 启动参数走**单一真源** `kit/browser_args.js` —— 见该文件头的实测记录：
     探针与本审判器各写一份 args ⇒ 同一份 HTML 量出的 MAD 分布系统性不同。
     要动参数请改那个文件，不许在这里另起一份。 */
  const b = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: require('./browser_args.js'),
  });
  const pg = await b.newPage();

  const jsErr = [], reqFail = [];
  pg.on('pageerror', e => jsErr.push(String((e && e.message) || e)));
  pg.on('requestfailed', r => reqFail.push(r.url().split('/').pop() + ' :: ' + ((r.failure() || {}).errorText)));

  /* ★ 浏览器侧工具函数**必须先注进页面**才能被后面的 evaluate 调用 ——
     puppeteer 只序列化「你传进去的那个函数」，它内部引用的外层函数**不会跟着去**。
     （第一次跑自检就栽在这：tjCollect is not defined。） */
  const TJ_HELPERS = [tjCollect, tjIsAnc, tjPolyArea, tjClipHalf, tjInterArea]
    .map(f => f.toString()).join('\n\n');
  await pg.evaluateOnNewDocument(TJ_HELPERS);

  /* 先用默认视口加载，探出设计尺寸后再 setViewport —— 免得写死 1920×1080 */
  await pg.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await pg.goto(HTML, { waitUntil: 'networkidle0' });
  await pg.waitForFunction(
    'typeof window.__frame === "function" && typeof window.__dur === "number" && window.__dur > 0',
    { timeout: 20000 });

  const meta = await pg.evaluate(() => {
    const st = document.getElementById('stage') || document.getElementById('camera');
    return { w: st ? st.offsetWidth : document.body.scrollWidth,
             h: st ? st.offsetHeight : document.body.scrollHeight,
             dur: window.__dur, hideOv: typeof window.__hideOv === 'function' };
  });
  await pg.setViewport({ width: meta.w || 1920, height: meta.h || 1080, deviceScaleFactor: 1 });
  const VW = meta.w || 1920, VH = meta.h || 1080;
  const DUR = meta.dur;

  /* ★ 起播遮罩：不隐藏 ⇒ 整片发白而零报错（BUG-2358/2365，历史上最贵的一条） */
  if (meta.hideOv) await pg.evaluate(() => window.__hideOv());
  console.log('\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  console.log(' \u603b\u5ba1\u5224  ' + path.basename(file) + '   \u00b7  ' + VW + '\u00d7' + VH +
              '  \u00b7  ' + DUR.toFixed(3) + 's  \u00b7  ' + MODE + ' \u6863');
  console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');

  /* ───────────── P0-1 RUNTIME ───────────── */
  head('P0-1  RUNTIME  运行时（JS 报错 / 资源加载失败）');
  if (jsErr.length) bad('RUNTIME', 'JS 报错 ' + jsErr.length + ' 条：' + jsErr.slice(0, 3).join(' | '));
  else ok('RUNTIME', 'JS 报错 0 条');
  if (reqFail.length) bad('RUNTIME', '资源加载失败 ' + reqFail.length + ' 条：' + reqFail.slice(0, 3).join(' | '));
  else ok('RUNTIME', '资源加载失败 0 条');

  /* ───────────── P0-2 PURE（这是「逐帧渲染」这件事本身成立的前提） ───────────── */
  head('P0-2  PURE  render(t) 纯函数（同 t 两次求值必须一致 —— 不一致 ⇒ 逐帧渲染整个是假的）');
  const pure = await pg.evaluate(() => {
    const snap = () => {
      const o = [];
      document.querySelectorAll('#stage *, #camera *').forEach(e => {
        const cs = getComputedStyle(e);
        o.push(e.tagName + '#' + (e.id || '') + '|' + cs.opacity + '|' + cs.transform + '|' +
               e.style.width + '|' + e.style.left + '|' + (e.textContent || '').slice(0, 20));
      });
      return o.join('\n');
    };
    const n = Math.round(window.__dur * 30);
    const ts = [0, 0.25, 0.5, 0.75].map(k => (n - 1) * k / 30).concat([window.__dur - 0.1]);
    const diff = [];
    for (const t of ts) {
      window.__frame(t); const a = snap();
      window.__frame(0); window.__frame(t); const c = snap();
      if (a !== c) diff.push(+t.toFixed(2));
    }
    return { n: document.querySelectorAll('#stage *, #camera *').length, diff };
  });
  if (pure.diff.length) bad('PURE', '这些 t 两次求值不一致：' + pure.diff.join(', ') + ' ⇒ 有一次性闩/状态泄漏');
  else ok('PURE', '同 t 两次求值一致（' + pure.n + ' 元素 · ' + 5 + ' 采样点）');

  /* ───────────── P0-3 MASK（起播遮罩 / 全屏不透明覆盖层） ───────────── */
  head('P0-3  MASK  起播遮罩 / 全屏不透明覆盖层（BUG-2358：不隐藏 ⇒ 零报错发白）');
  const mask = await pg.evaluate((VW, VH) => {
    window.__frame(0);
    const hits = [];
    document.querySelectorAll('body *').forEach(e => {
      const cs = getComputedStyle(e);
      let op = 1, p = e;
      while (p && p !== document.body) { op *= Number(getComputedStyle(p).opacity || 1); p = p.parentElement; }
      if (op < 0.5 || cs.visibility === 'hidden' || cs.display === 'none') return;
      const r = e.getBoundingClientRect();
      const cov = (Math.min(r.right, VW) - Math.max(r.left, 0)) * (Math.min(r.bottom, VH) - Math.max(r.top, 0));
      if (cov < 0.88 * VW * VH) return;
      /* ★ ① 背景层不算遮罩：DOM 顺序排在 #camera（或第一个 .sc）**之前**的，
             是画在最底下的氛围层（#bgfar / #mesh），它铺满是设计使然。
             遮罩一定盖在内容之上 ⇒ DOM 序必然靠后。 */
      const cam = document.getElementById('camera') || document.querySelector('.sc');
      if (cam && (e.compareDocumentPosition(cam) & Node.DOCUMENT_POSITION_FOLLOWING)) return;
      /* ★ ② 纯渐变/透明底的铺满层也不算（#vig 暗角、radial-gradient 氛围） */
      const bg = cs.backgroundColor || '';
      const m = bg.match(/rgba?\(([^)]+)\)/);
      let alpha = 1;
      if (m) { const v = m[1].split(',').map(s => parseFloat(s)); alpha = v.length > 3 ? v[3] : 1; }
      const isGrad = cs.backgroundImage !== 'none' && /gradient/i.test(cs.backgroundImage);
      if (alpha < 0.5 && (isGrad || bg === 'rgba(0, 0, 0, 0)')) return;
      if (!(alpha > 0.5 && bg !== 'rgba(0, 0, 0, 0)') && !isGrad) return;
      /* ★ 别把「舞台本身」当遮罩：#stage / #camera 天然铺满画布而且是实心的。
         判法 = 它是**容器**还是**盖子**：有 ≥3 个带墨迹的后代 ⇒ 它是容器，不算遮罩。 */
      let inkDesc = 0;
      const ds = e.querySelectorAll('*');
      for (let k = 0; k < ds.length && inkDesc < 3; k++) {
        const d = ds[k];
        let t = '';
        for (const n of d.childNodes) if (n.nodeType === 3) t += n.textContent;
        if (t.trim() || /^(IMG|SVG|CANVAS|VIDEO)$/.test(d.tagName) ||
            getComputedStyle(d).backgroundImage !== 'none') inkDesc++;
      }
      if (inkDesc >= 3) return;
      hits.push((e.id ? '#' + e.id : e.tagName.toLowerCase() +
        (e.className ? '.' + String(e.className).split(' ')[0] : '')) +
        ' [bg ' + bg + ' · op ' + op.toFixed(2) + ' · 带墨迹后代 ' + inkDesc + ']');
    });
    return hits;
  }, VW, VH);
  const maskReal = mask.filter(s => !/vig|vignette/i.test(s));   /* 暗角是设计的一部分，不算遮罩 */
  if (maskReal.length) bad('MASK', '疑似起播遮罩未隐藏：' + maskReal.slice(0, 4).join(' | '));
  else ok('MASK', '无全屏不透明覆盖层' + (meta.hideOv ? '（已调 window.__hideOv()）' : '（工程未定义 __hideOv）'));

  /* ───────── 一次遍历：DOM 全量指标 + 像素抽样 ─────────  */
  /* ★ 效率关键：**一趟循环**把 OVL/EDGE/SAFE/ZERO/密度/亮度 全算了，
     不是每条判据各自扫一遍全片（旧做法 = N 个脚本 × N 次全片遍历）。 */
  head('扫描（一趟遍历出全部指标 · DOM ' + (STEP.dom === 1 ? '全帧' : '每 ' + STEP.dom + ' 帧') +
       ' · 像素每 ' + STEP.px + ' 帧）');
  const scan = await pg.evaluate(async (CFG) => {
    const { VW, VH, DUR, FPS, BAND, SMALL, OVL_R, stepDom, stepPx } = CFG;
    const pairs = {}, edge = {}, zero = {}, oob = {};
    let smallMax = 0, smallAt = 0, inkMax = 0, inkMin = Infinity;
    const inkSeries = [];          /* 每采样帧的墨迹总面积 —— 用来找「整屏几乎没东西」的连续段 */
    const lum = [];              /* 抽样帧亮度（缩到 32×18 后算） */
    const redup = {};            /* 重复帧（死帧）候选 */
    let prevLum = null, freezeRun = 0, freezeWorst = 0, freezeAt = 0;

    const n = Math.round(DUR * FPS);
    const shot = async () => {
      /* 不落盘：截图 → base64 → 塞回页面让浏览器自己解码成 32×18 取像素 */
      const b64 = await window.__tjShot();
      return await new Promise(res => {
        const im = new Image();
        im.onload = () => {
          const cv = document.createElement('canvas');
          cv.width = 32; cv.height = 18;
          const g = cv.getContext('2d', { willReadFrequently: true });
          g.drawImage(im, 0, 0, 32, 18);
          const d = g.getImageData(0, 0, 32, 18).data;
          let s = 0, s2 = 0, mn = 255, mx = 0;
          for (let i = 0; i < d.length; i += 4) {
            const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            s += y; s2 += y * y; if (y < mn) mn = y; if (y > mx) mx = y;
          }
          const N = d.length / 4, mean = s / N;
          res({ mean: mean, sd: Math.sqrt(Math.max(0, s2 / N - mean * mean)), mn: mn, mx: mx });
        };
        im.onerror = () => res(null);
        im.src = 'data:image/png;base64,' + b64;
      });
    };

    for (let f = 0; f <= n; f++) {
      const t = f / FPS;
      window.__frame(t);

      if (f % stepDom === 0) {
        const L = tjCollect();
        let ink = 0, small = 0;
        for (const o of L) {
          ink += o.area * o.op;
          /* SAFE：屏幕坐标越界（**只管有字的元素** —— 满幅底纹/进度条/标尺在
             相机 scale>1 下天然溢出 2~3px，那是设计使然；「字跑出画面」才是事故） */
          const l = Math.min.apply(null, o.corners.map(c => c[0]));
          const rr = Math.max.apply(null, o.corners.map(c => c[0]));
          const tp = Math.min.apply(null, o.corners.map(c => c[1]));
          const bt = Math.max.apply(null, o.corners.map(c => c[1]));
          if (o.txt && rr - l > 4 && bt - tp > 4 && (l < -2 || tp < -2 || rr > VW + 2 || bt > VH + 2)) {
            const k = (o.id ? '#' + o.id : o.tag + '.' + o.cls) + '[' + o.txt + ']';
            const r = (oob[k] = oob[k] || { n: 0, t0: t, t1: t, at: t, box: '' });
            r.n++; r.t1 = t; r.at = t;
            r.box = '[' + l.toFixed(0) + ',' + tp.toFixed(0) + ' ' + (rr - l).toFixed(0) + '\u00d7' + (bt - tp).toFixed(0) + ']';
          }
          /* ZERO：有字/有底却宽或高接近 0 ⇒ 观众根本看不见（BUG-2598 通用化） */
          if (o.txt && (o.w < 1 || o.h < 1)) {
            const k = (o.id ? '#' + o.id : o.tag + '.' + o.cls) + '[' + o.txt + ']';
            const r = (zero[k] = zero[k] || { n: 0, t0: t, t1: t, wh: o.w.toFixed(1) + '\u00d7' + o.h.toFixed(1) });
            r.n++; r.t1 = t;
          }
          if (o.txt && o.fs > 0 && o.fs <= SMALL) {
            small++;
            /* EDGE：上/下保留带内的小字（铁律 221 + BUG-1314） */
            if (o.y < BAND || (o.y + o.h) > VH - BAND) {
              const k = o.cls + '|' + o.txt;
              const r = (edge[k] = edge[k] || { n: 0, t0: t, t1: t, y: Math.round(o.y), fs: Math.round(o.fs), txt: o.txt });
              r.n++; r.t1 = t;
            }
          }
        }
        if (small > smallMax) { smallMax = small; smallAt = t; }
        inkSeries.push(ink);
        if (ink > inkMax) inkMax = ink;
        if (ink < inkMin) inkMin = ink;

        /* OVL：字压字（OBB 精确交面积） */
        for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
          const a = L[i], b = L[j];
          if (!a.txt || !b.txt) continue;                       /* 图形压图形不管，只管字 */
          if (tjIsAnc(a.el, b.el) || tjIsAnc(b.el, a.el)) continue;
          /* ★ 零尺寸元素不许进 OVL：它的 area 被兜底成 1 ⇒ 任何交面积 / 1 = 天文数字
             （自检第一跑就吐出「占小者 99734.964」）。它归 ZERO 管，这里直接跳过。 */
          if (a.lw < 1 || a.lh < 1 || b.lw < 1 || b.lh < 1) continue;
          const ia = tjInterArea(a.corners, b.corners);
          if (ia <= 0) continue;
          const ratio = ia / Math.min(a.area, b.area);
          if (ratio < OVL_R) continue;
          const k = a.tag + '.' + a.cls + '[' + a.txt + ']  \u2229  ' + b.tag + '.' + b.cls + '[' + b.txt + ']';
          const r = (pairs[k] = pairs[k] || { n: 0, max: 0, t0: t, t1: t, at: t, k: k });
          r.n++; r.t1 = t; if (ratio > r.max) { r.max = ratio; r.at = t; }
        }
      }

      /* 像素抽样：抓「零报错发白/全黑」+「死帧」 */
      if (f % stepPx === 0 && typeof window.__tjShot === 'function') {
        const L = await shot();
        if (L) {
          lum.push({ t: t, mean: +L.mean.toFixed(2), sd: +L.sd.toFixed(2) });
          if (prevLum) {
            const d = Math.abs(L.mean - prevLum.mean) + Math.abs(L.sd - prevLum.sd);
            if (d < 0.35) { freezeRun++; if (freezeRun > freezeWorst) { freezeWorst = freezeRun; freezeAt = t; } }
            else freezeRun = 0;
          }
          prevLum = L;
        }
      }
    }
    /* 空屏：连续 ink < 峰值 2% 的时长（★ 单帧不算 —— 片尾最后一帧必然全空，
       那 0.03s 观众根本看不见；只有「连续 ≥0.25s 整屏没东西」才是事故） */
    let emptyRun = 0, emptyWorst = 0, emptyAt = 0;
    const thr = inkMax * 0.02;
    inkSeries.forEach((v, i) => {
      if (v < thr) { emptyRun++; if (emptyRun > emptyWorst) { emptyWorst = emptyRun; emptyAt = i * stepDom / FPS; } }
      else emptyRun = 0;
    });
    return { pairs, edge, zero, oob, smallMax, smallAt, inkMax, inkMin, lum,
             emptyWorst: emptyWorst * stepDom / FPS, emptyAt: emptyAt,
             freezeWorst: freezeWorst, freezeAt: freezeAt, frames: n + 1 };
  }, { VW: VW, VH: VH, DUR: DUR, FPS: 30, BAND: BAND, SMALL: SMALL, OVL_R: OVL_R,
       stepDom: STEP.dom, stepPx: STEP.px });

  /* 像素抽样需要 Node 侧配合（把截图塞回页面）。上面第一次跑时 __tjShot 还不存在，
     所以像素是空的 —— 这里补一次：挂上 __tjShot 再跑一遍纯像素抽样。 */
  const needPx = STEP.px > 0;
  let px = { lum: [], freezeWorst: 0, freezeAt: 0, white: 0, black: 0, freezeSegs: 0,
             madP10: 0, madP50: 0, madP90: 0, madMax: 0 };
  if (needPx) {
    await pg.exposeFunction('__tjShot', async () => {
      const buf = await pg.screenshot({ encoding: 'base64', type: 'png' });
      return buf;
    });
    px = await pg.evaluate(async (CFG) => {
      const { DUR, FPS, stepPx, FREEZE_MAD } = CFG;
      const lum = []; let prevG = null, run = 0, worst = 0, at = 0, segs = 0, white = 0, black = 0;
      /* ★ 死帧判定用 **64×36 逐像素平均绝对差（MAD）**，不是「均值/标准差的差」——
         后者对**缓慢平移**几乎无感：相机 44px / 5.5s 的漂移肉眼明明在动，
         32×18 的均值变化却 < 0.35 ⇒ 被误判成「2.8s 画面不动」（假阳性）。
         MAD 逐像素比，平移/缩放/扫光全都抓得到。 */
      /* ★ 分辨率必须是 256×144，不是 64×36：缩略得越狠梯度被平滑得越狠，
         「整体缓慢缩放/平移」这种**观众明明看得见**的运动会被测成 MAD≈0.2
         ⇒ 把镜头在推近的段误判成「4.8s 画面不动」（实测踩过）。 */
      const GW = 256, GH = 144;
      const grab = async () => {
        const b64 = await window.__tjShot();
        return await new Promise(res => {
          const im = new Image();
          im.onload = () => {
            const cv = document.createElement('canvas'); cv.width = GW; cv.height = GH;
            const g = cv.getContext('2d', { willReadFrequently: true });
            g.drawImage(im, 0, 0, GW, GH);
            const d = g.getImageData(0, 0, GW, GH).data;
            const N = GW * GH;
            const gray = new Float32Array(N);
            let s = 0, s2 = 0;
            for (let i = 0, k = 0; i < d.length; i += 4, k++) {
              const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
              gray[k] = y; s += y; s2 += y * y;
            }
            const mean = s / N;
            /* ★★★ 底色口径 = **整帧平均色度 U/V**（不是 RGB，也不是「最暗 25%」）。
               两版踩过的坑，都记在这：
                 v1 四角区块 RGB ⇒ 区块里混进内容（L3 右下是面板 #1d1915），
                    且**改前改后 Δ 几乎不变**（32.5→30.2）⇒ 测的是构图差异，不是底色。
                 v2 每帧最暗 25% 像素 ⇒ 最暗的全是**暗角压黑**的边缘，两条片子都≈纯黑
                    ⇒ Δ 只有 2.6，**负控都过不了**（判据没牙）。
               正解是色度：暗角是**中性黑**（U=V=128），压得再狠也不改色度；
               而「加了冷蓝」体现在 U 上（U>128 偏蓝）。⇒ 用 U/V 才测得到底色偏没偏。 */
            let su = 0, sv = 0;
            for (let i = 0; i < d.length; i += 4) {
              su += -0.14713 * d[i] - 0.28886 * d[i + 1] + 0.436 * d[i + 2] + 128;
              sv += 0.615 * d[i] - 0.51499 * d[i + 1] - 0.10001 * d[i + 2] + 128;
            }
            const uv = [su / N, sv / N];
            res({ mean: mean, sd: Math.sqrt(Math.max(0, s2 / N - mean * mean)), gray: gray, uv: uv });
          };
          im.onerror = () => res(null);
          im.src = 'data:image/png;base64,' + b64;
        });
      };
      const n = Math.round(DUR * FPS);
      for (let f = 0; f <= n; f += stepPx) {
        window.__frame(f / FPS);
        const L = await grab();
        if (!L) continue;
        if (L.mean > 246) white++;
        if (L.mean < 6 && L.sd < 4) black++;
        /* ★ 死帧的「连续段」判定放 Node 侧做（阈值要等 MAD 分布出来才定得下来），
             页面里只负责把每帧的 mad 算出来。 */
        let mad = -1;
        if (prevG) {
          mad = 0;
          for (let i = 0; i < L.gray.length; i++) mad += Math.abs(L.gray[i] - prevG[i]);
          mad /= L.gray.length;
        }
        prevG = L.gray;
        lum.push({ t: +(f / FPS).toFixed(2), mean: +L.mean.toFixed(2), sd: +L.sd.toFixed(2),
                   mad: +mad.toFixed(2), uv: L.uv });
      }
      /* MAD 分布统计 —— 死帧阈值必须是**实测**出来的，不许拍脑袋（铁律：判据阈值不许自设） */
      const mads = lum.map(o => o.mad).filter(v => v >= 0).sort((a, b) => a - b);
      const q = (p) => mads.length ? mads[Math.min(mads.length - 1, Math.floor(mads.length * p))] : 0;
      return { lum: lum, white: white, black: black,
               madP10: q(0.10), madP50: q(0.50), madP90: q(0.90), madMax: mads.length ? mads[mads.length - 1] : 0 };
    }, { DUR: DUR, FPS: 30, stepPx: STEP.px });
  }
  console.log('  \u2713 SCAN    DOM ' + scan.frames + ' 帧 · 像素抽样 ' + px.lum.length + ' 帧 · 边带 \u00b1' + BAND + 'px');

  /* ───────────── P0-4 BLANK（空帧 / 死帧 / 发白） ───────────── */
  head('P0-4  BLANK  空帧 / 死帧 / 发白（历史上最贵的坑：零报错，画面却是白的）');
  const MAD_THR = FREEZE_MAD_OPT != null ? Number(FREEZE_MAD_OPT)
    : Math.max(0.5, Math.sqrt(Math.max(0.05, px.madP10) * Math.max(0.5, px.madP90)));
  const fz = freezeSec(px.lum, MAD_THR);
  /* ★ 阈值 2.0s（不是 1.5s）：转场留白 1~1.5s 是正常的，连续 2 秒不动才是事故 */
  if (fz.sec >= 2.0) bad('BLANK', '最长死帧段 ' + fz.sec.toFixed(2) + 's @ t=' + fz.at.toFixed(2) +
                                  '（连续 ' + fz.n + ' 个抽样帧画面不动 ⇒ 观众看到静止画面）');
  else note('BLANK', '最长静帧段 ' + fz.sec.toFixed(2) + 's @ t=' + fz.at.toFixed(2) + '（< 2.0s，正常）');
  if (scan.emptyWorst >= 0.25)
    bad('BLANK', '最长空屏段 ' + scan.emptyWorst.toFixed(2) + 's @ t=' + scan.emptyAt.toFixed(2) +
                 '（连续这么久画面里几乎没有可见元素 ⇒ 转场塌了 / 段首尾留白）');
  else ok('BLANK', '无空屏段（墨迹最空 ' + Math.round(scan.inkMin) + ' / 峰值 ' + Math.round(scan.inkMax) + '）');

  /* ───────────── P0-5 SAFE（越界） ───────────── */
  head('P0-5  SAFE  越界（屏幕坐标 —— 相机 scale>1 会把元素推出设计画布）');
  const oobArr = Object.entries(scan.oob).sort((a, b) => b[1].n - a[1].n);
  if (!oobArr.length) ok('SAFE', '全片无元素越出画布');
  else oobArr.slice(0, 8).forEach(([k, r]) => bad('SAFE', k + ' ' + r.box +
        '  越界 ' + r.n + ' 帧（' + r.t0.toFixed(2) + '~' + r.t1.toFixed(2) + 's）'));

  /* ───────────── P0-6 ZERO（属性在动，画面没动） ───────────── */
  head('P0-6  ZERO  画不出来的元素（有字却宽/高为 0 —— BUG-2598 通用化）');
  const zArr = Object.entries(scan.zero).sort((a, b) => b[1].n - a[1].n);
  if (!zArr.length) ok('ZERO', '无「有字却零尺寸」的元素');
  else zArr.slice(0, 8).forEach(([k, r]) => bad('ZERO', k + '  ' + r.wh +
        '  持续 ' + r.n + ' 帧 ⇒ 文字一个像素都没画出来'));

  /* ───────────── P0-7 OVL（字压字） ───────────── */
  head('P0-7  OVL  字压字（OBB 精确交面积 \u2265 ' + Math.round(OVL_R * 100) + '% · 持续 \u2265 ' +
       OVL_F + ' 采样）');
  const ovArr = Object.values(scan.pairs).filter(r => r.n >= OVL_F).sort((a, b) => b.max - a.max);
  if (!ovArr.length) ok('OVL', '全片无「字压字」');
  else ovArr.slice(0, 10).forEach(r => bad('OVL', 't=' + r.at.toFixed(2) + '  ' + r.k +
        '   占小者 ' + r.max.toFixed(3) + ' · 持续 ' + r.n + ' 采样（' + r.t0.toFixed(2) + '~' + r.t1.toFixed(2) + 's）'));
  const softOv = Object.values(scan.pairs).filter(r => r.n < OVL_F);
  if (softOv.length) note('OVL', '瞬交 ' + softOv.length + ' 处（只出现 1 个采样，多半是转场穿插，只报不判）');

  /* ───────────── P0-8 EDGE（保留带小字） ───────────── */
  head('P0-8  EDGE  保留带小字（上/下 ' + BAND + 'px 是留给标题/字幕的 —— 铁律 221 + BUG-1314）');
  const eArr = Object.values(scan.edge).sort((a, b) => b.n - a.n);
  if (!eArr.length) ok('EDGE', '上/下 ' + BAND + 'px 带内无 \u2264 ' + SMALL + 'px 小字');
  else eArr.slice(0, 10).forEach(r => bad('EDGE', r.fs + 'px 小字贴边 @y' + r.y + '  "' + r.txt +
        '"  ' + r.n + ' 采样（' + r.t0.toFixed(2) + '~' + r.t1.toFixed(2) + 's）'));

  /* ───────────── P1 选看 ───────────── */
  head('P1  选看（报出来，不拦交付 —— 有空再收拾）');
  const cam = await pg.evaluate(() => {
    const cam = document.getElementById('camera');
    if (!cam) return null;
    let prev = null, mx = 0, at = 0;
    const n = Math.round(window.__dur * 30);
    for (let f = 0; f <= n; f++) {
      window.__frame(f / 30);
      const m = new DOMMatrixReadOnly(getComputedStyle(cam).transform);
      if (prev) { const d = Math.hypot(m.e - prev[0], m.f - prev[1]); if (d > mx) { mx = d; at = f / 30; } }
      prev = [m.e, m.f];
    }
    return { mx: mx, at: at };
  });
  if (cam) {
    if (cam.mx < 8) note('CAM', '相机逐帧位移峰值 ' + cam.mx.toFixed(2) + ' px/帧 @ t=' + cam.at.toFixed(2) + '（< 8，无切镜瞬移）');
    else bad('CAM', '相机逐帧位移峰值 ' + cam.mx.toFixed(2) + ' px/帧 @ t=' + cam.at.toFixed(2) + '（P1 但通常=切镜瞬移，建议修）');
  }
  note('MAD', '逐像素平均绝对差 P10=' + px.madP10.toFixed(2) + ' P50=' + px.madP50.toFixed(2) +
              ' P90=' + px.madP90.toFixed(2) + ' max=' + px.madMax.toFixed(2) +
              '  ·  死帧阈值自动定=' + MAD_THR.toFixed(2) + '（√(P10×P90)，下限 0.5；可用 --mad 手压）');
  note('DENSITY', '同屏 \u2264' + SMALL + 'px 小字峰值 ' + scan.smallMax + ' 个 @t=' + scan.smallAt.toFixed(2) + 's');
  note('COMPLEX', '同屏可见元素峰值（墨迹面积 ' + Math.round(scan.inkMax) + '）');

  /* ───────────── P2 钻研 ───────────── */
  if (MODE === 'deep') {
    head('P2  钻研（眼审截帧 + 逐帧亮度曲线）');
    const dir = path.join(path.dirname(path.resolve(file)), '_trial_eye');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    const N = 12;
    for (let i = 0; i < N; i++) {
      const t = DUR * (i + 0.5) / N;
      await pg.evaluate(t => window.__frame(t), t);
      await pg.screenshot({ path: path.join(dir, String(i + 1).padStart(2, '0') + '_t' + t.toFixed(2) + '.png') });
    }
    console.log('  \u00b7 EYE    ' + N + ' 张眼审截帧 \u2192 ' + dir);
    const spark = px.lum.filter((_, i) => i % Math.max(1, Math.floor(px.lum.length / 60)) === 0)
      .map(l => '\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588'[Math.min(7, Math.floor(l.mean / 32))]).join('');
    console.log('  \u00b7 LUM    ' + spark);
  }

  /* ───────────── SERIES（跨片底色一致性 —— 诊断项，⚠️ 不拦交付） ─────────────
     ★★ 为什么是诊断项而不是红线：**三个口径的负控都没过**，自动判定在
        「两条片子构图不同」的前提下做不稳。失败史全记在这，别再试第四遍：
          v1 四角区块 RGB → 区块里混进内容（L3 右下是面板 #1d1915），
             且**改前改后 Δ 几乎不变**（32.5→30.2）⇒ 测的是构图差异
          v2 每帧最暗 25% → 最暗的全是**暗角压黑**的边缘，两边都≈纯黑 ⇒ Δ 只有 2.6，负控不过
          v3 整帧平均色度 U/V → 冷蓝被大量金色内容稀释 ⇒ ΔU 0.0，负控还是不过
        局部 ⇒ 受构图影响；全局 ⇒ 被稀释；暗部 ⇒ 被暗角抹平。三个方向都堵死。
     ★ 真正能治「跨片漂移」的不是判据，是**上游单一真源**：系列色板只在一处定义，
       所有分镜引用 var()，不许硬编码 ⇒ 「擅自加一个色」在源头就不可能。 */
  if (SERIES_REF && fs.existsSync(path.resolve(SERIES_REF))) {
    head('SERIES  系列底色一致性【诊断项 · 不拦交付 · 自动判定不可靠，供人判读】');
    try {
      const refL = await sampleRefBlocks(b, SERIES_REF);
      const tgtL = px.lum.filter(o => o.uv).map(o => o.uv);
      if (!refL.length || !tgtL.length) bad('SERIES', '基准或本片没采到像素');
      else {
        const a = medRGB(refL.map(o => o.uv)), c = medRGB(tgtL);
        const dU = Math.abs(a[0] - c[0]), dV = Math.abs(a[1] - c[1]);
        const d = Math.max(dU, dV);
        console.log('        底色口径 = 整帧平均色度 U/V（暗角是中性黑，压再狠也不改色度；U>128 偏蓝）');
        console.log('        基准 U' + a[0].toFixed(1) + ' V' + a[1].toFixed(1) +
                    '   本片 U' + c[0].toFixed(1) + ' V' + c[1].toFixed(1) +
                    '   ΔU' + dU.toFixed(1) + ' ΔV' + dV.toFixed(1));
        console.log('        ⚠ 自动判定不可靠（见代码里三个口径的失败史）；要下结论请用 '
          + '`_probe_bg.cjs` 出多时刻多区块表 + 人眼判读');
        if (d <= SERIES_TOL) note('SERIES', '看起来一致（ΔU' + dU.toFixed(1) +
          ' ΔV' + dV.toFixed(1) + ' ≤ ' + SERIES_TOL + '）');
        else note('SERIES', '⚠ 底色可能偏了：ΔU' + dU.toFixed(1) + ' ΔV' + dV.toFixed(1) +
          ' > ' + SERIES_TOL + ' ⇒ 建议人眼复核（多半是后做的那条自己加了色）');
      }
    } catch (e) { bad('SERIES', '基准采样失败：' + (e && e.message || e)); }
  }

  await b.close();
  return { red: RED.length, info: INFO.length };
}

/* ══════════════════════════ MP4 档 ══════════════════════════ */
function sh(cmd, args, options = {}) {
  const r = require('child_process').spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...options });
  return { code: r.status == null ? -1 : r.status, out: (r.stdout || '') + (r.stderr || '') };
}
async function trialMp4(file) {
  console.log('\n\u2550\u2550\u2550  \u603b\u5ba1\u5224\uff08\u6210\u7247\u6863\uff09  ' + path.basename(file) + '  \u00b7  ' + MODE + ' \u6863  \u2550\u2550\u2550');

  const pr = sh(FFPROBE, ['-v', 'error', '-show_entries',
    'format=duration,size:stream=index,codec_type,codec_name,width,height,r_frame_rate,nb_frames,channels,sample_rate',
    '-of', 'default=noprint_wrappers=1', file]);
  if (pr.code !== 0) { console.error('[trial] ffprobe 失败：' + pr.out.slice(0, 300)); process.exit(2); }
  const g = (re) => { const m = pr.out.match(re); return m ? m[1] : null; };
  const W = g(/width=(\d+)/), H = g(/height=(\d+)/), dur = parseFloat(g(/duration=([\d.]+)/) || '0');
  const hasAud = /codec_type=audio/.test(pr.out);
  const vrate = g(/r_frame_rate=([\d/]+)/);
  const fps = vrate ? eval(vrate.replace('/', '/')) : 30;

  head('P0-1  RUNTIME  容器规格');
  console.log('  \u00b7 \u89c4\u683c    ' + W + '\u00d7' + H + '  ' + fps.toFixed(3) + ' fps  ' + dur.toFixed(3) + 's  ' +
              (hasAud ? '有音轨' : '\u26a0 \u65e0\u97f3\u8f68'));
  (W && H && dur > 0) ? ok('RUNTIME', '分辨率/时长可读') : bad('RUNTIME', '分辨率或时长缺失');
  hasAud ? ok('RUNTIME', '音轨存在') : bad('RUNTIME', '成片没有音轨');

  head('P0-4  BLANK  黑帧 / 白帧 / 死帧（signalstats 全量逐帧）');
  const st = sh(FFMPEG, ['-v', 'error', '-i', file, '-vf',
    'signalstats,metadata=print:file=-', '-f', 'null', '-'], {
      maxBuffer: Math.max(16 * 1024 * 1024, Math.ceil((dur * fps + 10) * 2048))
    });
  const yavg = [...st.out.matchAll(/lavfi\.signalstats\.YAVG=([-\d.]+)/g)].map(m => parseFloat(m[1]));
  const ymin = [...st.out.matchAll(/lavfi\.signalstats\.YMIN=(\d+)/g)].map(m => parseFloat(m[1]));
  const ymax = [...st.out.matchAll(/lavfi\.signalstats\.YMAX=(\d+)/g)].map(m => parseFloat(m[1]));
  if (st.code !== 0 || !yavg.length) bad('BLANK', 'signalstats 解码失败或输出不完整（不以部分采样放行）' + st.out.slice(-200));
  else {
    const white = yavg.filter(v => v > 246).length;
    const black = yavg.filter(v => v < 6).length;
    // MP4 must also measure spatial movement. A mean-brightness difference
    // labels a moving object with constant area/color as a frozen frame.
    // Retain the existing 0.35 threshold and 1.5s limit; fix the measured value.
    const raw = require('child_process').spawnSync(FFMPEG, ['-v', 'error', '-i', file,
      '-map', '0:v:0', '-vf', 'scale=64:36:flags=area,format=gray',
      // Analyze decoded frames, never let output CFR duplicate/drop them.
      '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'], { windowsHide: true,
      maxBuffer: Math.max(8 * 1024 * 1024, Math.ceil((dur * fps + 10) * 2304 * 1.2)) });
    const pixels = raw.stdout;
    let run = 0, worst = 0, at = 0;
    if (raw.error || raw.status !== 0 || !pixels || !pixels.length || pixels.length % 2304) {
      bad('BLANK', '逐像素运动采样失败（不以空样本放行）');
    } else {
      const count = pixels.length / 2304;
      if (count !== yavg.length) bad('BLANK', '逐像素采样帧数与signalstats不一致');
      try {
        const motion = require('./motion-local.cjs').measureMotion(pixels, fps);
        worst = motion.worstFrames; at = motion.at;
        note('BLANK', '运动测量面：64×36内8×6局部块最大MAD，约100ms时间窗；阈值0.35，静态窗覆盖≥1.5s仍拒绝');
      } catch (e) { bad('BLANK', '局部运动无可量时间面：' + e.message); }
    }
    white ? bad('BLANK', '近全白帧 ' + white + '/' + yavg.length + ' 帧') : ok('BLANK', '无发白帧');
    (black > yavg.length * 0.25) ? bad('BLANK', '近全黑帧 ' + black + '/' + yavg.length + ' 帧 \uFF08> 25%\uFF09')
                                 : ok('BLANK', '近全黑帧 ' + black + '/' + yavg.length + ' 帧');
    const fz = worst / fps;
    (fz >= 1.5) ? bad('BLANK', '最长死帧段 ' + fz.toFixed(2) + 's @ t=' + at.toFixed(2))
                : note('BLANK', '最长静帧段 ' + fz.toFixed(2) + 's @ t=' + at.toFixed(2));
  }
  return { red: RED.length, info: INFO.length };
}

/* ══════════════════════════ 自检（铁律 303：判据必须有牙） ══════════════════════════ */
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden}
#stage{position:fixed;left:0;top:0;width:1920px;height:1080px;background:#111}
#camera{position:absolute;left:0;top:0;width:1920px;height:1080px}
#startOv{position:fixed;left:0;top:0;width:1920px;height:1080px;background:#fff;z-index:99}
.sc{position:absolute;left:0;top:0;width:1920px;height:1080px}
h2{position:absolute;left:140px;top:133px;margin:0;font-size:64px;line-height:1.5;color:#fff}
.sub{position:absolute;left:142px;top:216px;font-size:21px;color:#aaa}
.tiny{position:absolute;left:140px;top:1000px;font-size:14px;color:#888}
.zero{position:absolute;left:900px;top:400px;width:0;height:0;font-size:20px;color:#fff}
.oob{position:absolute;left:1880px;top:400px;font-size:40px;color:#fff;white-space:nowrap}
.rot{position:absolute;right:170px;top:560px;font-size:96px;color:#f55;
  border:6px solid #f55;padding:16px 34px;transform:rotate(-11deg)}
/* \u8d1f\u63a7\u5143\u7d20\uff1a\u590d\u523b L3 \u771f\u5b9e\u60c5\u51b5\u7684\u300c45 %\u300d\u4f4d\u7f6e \u2014\u2014 AABB \u4e0e .rot \u76f8\u4ea4\uff0c
   \u4f46\u58a8\u8ff9\u843d\u5728\u65cb\u8f6c\u6846\u5916\u3002OBB \u82e5\u5199\u5bf9\u4e86\uff0c\u5b83\u5c31\u4e0d\u8be5\u88ab OVL \u62a5\uff1b
   \u62a5\u4e86 \u2192 \u8bf4\u660e\u5224\u636e\u8fd8\u5728\u62ff AABB \u5b9a\u7f6a\uff08\u5047\u9633\u6027\uff09\u3002\u81ea\u68c0\u4f1a\u786c\u65ad\u8a00\u8fd9\u4e00\u70b9\u3002 */
.far{position:absolute;left:1700px;top:700px;font-size:19px;color:#fff}
</style></head><body>
<div id="stage"><div id="camera">
  <section class="sc">
    <h2>\u5206\u533a\u8868\u6574\u4f53\u540e\u79fb</h2>
    <div class="sub">\u8ba9\u51fa\u5f15\u5bfc\u7a0b\u5e8f\u7684\u5730\u76d8</div>
    <div class="tiny">\u8fd9\u662f\u4e00\u884c\u4e0d\u8be5\u5b58\u5728\u7684\u5e95\u90e8\u5c0f\u5b57</div>
    <div class="zero">\u753b\u4e0d\u51fa\u6765\u7684\u5b57</div>
    <div class="oob">\u8d8a\u754c</div>
    <div class="rot">REJECTED</div>
    <div class="far">45 %</div>
    <img src="__trial_missing_asset.png" alt="">
  </section>
</div></div>
<div id="startOv"></div>
<script>
window.__dur = 3.0;
var leak = 0;
window.__frame = function(t){
  /* \u6545\u610f\u5199\u574f\u7eaf\u51fd\u6570\uff1a\u7b2c\u4e8c\u6b21\u8c03\u7528\u5c31\u4e0d\u4e00\u6837 */
  leak++;
  document.querySelector('h2').style.left = (140 + (leak % 7)) + 'px';
  document.getElementById('startOv').style.opacity = 1;
};
/* \u6545\u610f\u4e0d\u5b9a\u4e49 window.__hideOv \u2014\u2014 \u8fd9\u624d\u662f\u73b0\u5b9e\u91cc\u6700\u5e38\u89c1\u7684\u7ffb\u8f66\u65b9\u5f0f\uff1a
   \u5de5\u7a0b\u6839\u672c\u6ca1\u7ed9\u5ba1\u5224\u5668\u7559\u9690\u85cf\u5165\u53e3\uff0c\u906e\u7f69\u5c31\u6bcf\u5e27\u90fd\u5728 */
window.__frame(0);
<\/script></body></html>`;

async function selfTest() {
  const tmp = path.join(os.tmpdir(), 'trial_fixture.html');
  fs.writeFileSync(tmp, FIXTURE, 'utf8');
  console.log('\n\u2550\u2550\u2550  \u81ea\u68c0\uff1a\u7528\u4e00\u4e2a\u6545\u610f\u505a\u9519\u7684 fixture\uff0c\u9a8c\u8bc1\u7ea2\u7ebf\u5224\u636e\u771f\u7684\u4f1a\u54ac\u4eba  \u2550\u2550\u2550');
  console.log('  fixture \u5185\u542b\u7684\u6545\u969c\uff1a\u8d77\u64ad\u906e\u7f69\u672a\u9690\u85cf / \u7eaf\u51fd\u6570\u88ab\u5199\u574f / \u6807\u9898\u4e0e\u526f\u6807\u91cd\u53e0 / ' +
              '\u5e95\u90e8\u5c0f\u5b57 / \u96f6\u5c3a\u5bf8\u6587\u5b57 / \u5143\u7d20\u8d8a\u754c');
  const r = await trialHtml(tmp);
  const want = ['RUNTIME', 'PURE', 'MASK', 'BLANK', 'SAFE', 'ZERO', 'OVL', 'EDGE'];
  const got = new Set(RED.map(s => s.split(' ')[0]));
  console.log('\n\u2500\u2500\u2500  \u81ea\u68c0\u7ed3\u679c  \u2500\u2500\u2500');
  let miss = 0;
  want.forEach(w => {
    const hit = got.has(w);
    console.log('  ' + (hit ? '\u2713' : '\u2717') + ' ' + w.padEnd(9) + (hit ? '\u88ab\u54ac\u4e86' : '\u6ca1\u54ac\u5230 \u2190 \u5224\u636e\u65e0\u7259\uff01'));
    if (!hit) miss++;
  });
  try { fs.unlinkSync(tmp); } catch (e) {}
  /* ★ 负控：.far 是「AABB 相交但墨迹不相交」的旋转框陷阱元件。
     它出现在 OVL 里 ⇒ 判据还在拿 AABB 定罪（假阳性），必须算自检失败。 */
  const farFalse = RED.some(s => /\[45 %\]/.test(s));
  console.log('  ' + (farFalse ? '\u2717' : '\u2713') + ' NEGTL    \u65cb\u8f6c\u6846\u8d1f\u63a7\u5143\u7d20 \u201c45 %\u201d ' +
    (farFalse ? '\u88ab\u8bef\u5224\u6210\u538b\u5b57 \u2190 OBB \u5199\u9519\uff0c\u5047\u9633\u6027\uff01' : '\u672a\u88ab\u8bef\u5224\uff08OBB \u751f\u6548\uff09'));
  if (miss || farFalse) { console.log('\n\u81ea\u68c0\u5931\u8d25\uff1a' + (miss ? miss + ' \u6761\u7ea2\u7ebf\u6ca1\u6709\u7259\u3002' : '') +
    (farFalse ? ' \u65cb\u8f6c\u6846\u5047\u9633\u6027\u672a\u6392\u9664\u3002' : '')); process.exit(1); }
  console.log('\n\u81ea\u68c0\u901a\u8fc7\uff1a8 \u6761\u7ea2\u7ebf\u5168\u90e8\u6709\u7259\uff0c\u4e14\u65cb\u8f6c\u6846\u4e0d\u4f1a\u5047\u9633\u6027\u3002'); process.exit(0);
}

/* ══════════════════════════ main ══════════════════════════ */
(async () => {
  if (has('--self-test') || !TARGET) { if (!TARGET) { console.log('[trial] \u7528\u6cd5\uff1a node kit/trial.js <\u5de5\u7a0b.html|\u6210\u7247.mp4> [--mode fast|standard|deep] [--self-test]'); } await selfTest(); return; }
  const abs = path.resolve(TARGET);
  if (!fs.existsSync(abs)) { console.error('[trial] \u627e\u4e0d\u5230\uff1a' + abs); process.exit(2); }
  const isMp4 = /\.mp4$/i.test(abs);
  try {
    if (isMp4) await trialMp4(abs); else await trialHtml(abs);
  } catch (e) { console.error('\n[trial] \u5ba1\u5224\u5668\u81ea\u5df1\u8dd1\u6302\u4e86\uff1a' + (e && e.stack || e)); process.exit(2); }

  console.log('\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  if (!RED.length) console.log(' \u7ed3\u8bba\uff1a PASS  \u2014\u2014 ' + (INFO.length + WARN.length) + ' \u9879\u5168\u7eff\uff0c0 \u6761\u7ea2\u7ebf\u3002\u53ef\u4ea4\u4ed8\u3002');
  else console.log(' \u7ed3\u8bba\uff1a FAIL  \u2014\u2014 ' + RED.length + ' \u6761\u7ea2\u7ebf\u672a\u8fc7\uff1a\n   ' + RED.slice(0, 8).map(s => '\u00b7 ' + s).join('\n   '));
  console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n');
  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ mode: MODE, target: abs, red: RED, info: INFO, warn: WARN }, null, 2), 'utf8');
    console.log('  JSON \u2192 ' + JSON_OUT);
  }
  process.exit(RED.length ? 1 : 0);
})();
