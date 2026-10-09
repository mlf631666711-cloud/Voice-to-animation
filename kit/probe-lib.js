/**
 * probe-lib.js —— 探针公共底座（2026-09-11 建立）
 * =====================================================================
 * 为什么要有它
 * ---------------------------------------------------------------------
 * 盘点数据（2026-09-11 L10 收尾时实测）：
 *   · `video-style-lab/projects/` 下 22 个工程各自带探针，合计 **170+ 支** _*.js/_*.py
 *   · 其中 **165 支**各自手撸 `puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/...' })`
 *   · 每支固定吃掉 ~5 行样板（require / launch / setViewport / goto / pageerror）
 *   · 内联 transform 解析（translate / rotate / scale 正则）在 `_xm.js`、`_rot.js`、
 *     `_modbox.js`、`_map.js` 里各写了一遍
 *
 * 这正好是 BUG-2031（FALL_X1 漏改）与 BUG-2033（R2RX 注释与真值不符）的**同一类土壤**：
 * 同一样板存在 165 份 → 改一处必漏另一处。要治的不是那两处手误，是**份数**。
 *
 * 它给什么
 * ---------------------------------------------------------------------
 *   1. 一份 chrome 路径（复用 render-core 的 resolveChrome，单真源）
 *   2. 一份 transform 解析（translate/rotate/scale）
 *   3. 一份 `__frame(t)` 驱动 + 页面错误捕获
 *   4. 四个高频审计开箱即用：track（帧间位移）/ rot（旋转解缠）/ chain（不透明链路）/ rect
 *   5. 一次写完不需要关页（close 幂等）
 *
 * 用法（新探针脚本可以只有这么长）
 * ---------------------------------------------------------------------
 *   const P = require('../kit/probe-lib');
 *   (async () => {
 *     const p = await P.open('fx_foo.html');
 *     const rows = await p.track('#modBox', 0, 2.6);
 *     console.log(P.fmtTrack(rows));
 *     await p.close();
 *   })();
 *
 * 参数化选元素、选时刻 —— 库本身**零工程耦合**，`grep -c l10` 应为 0。
 * 它的 CLI 外壳见同目录 `probe.js`（多数审计连脚本都不用写）。
 */

'use strict';

const fs = require('fs');
const path = require('path');

/* ★ 2026-10-08 修：原先这一行写死开发机的 node_modules 绝对路径，
 *   别人 clone 本仓库后 require 必崩（"别人拷了就能跑"的直接拦路石）。
 *   现在改成多候选：
 *     ① 环境变量（你显式指定）→ ② 开发机兜底（**放前面，保证本机行为一字不变**）
 *     → ③ 常规 require（别人按 README 第 3 步装完 puppeteer-core 后就走这条）
 *   顺序刻意把开发机兜底放常规之前：本机命中它（行为不变），别人机器上该路径不存在、
 *   require 抛错后自动落到常规 —— 两边都不受伤。 */
const PUPPETEER_CANDIDATES = [
  process.env.PROBE_PUPPETEER,
  'puppeteer-core',
  'puppeteer',
].filter(Boolean);

const puppeteer = (() => {
  const errs = [];
  for (const c of PUPPETEER_CANDIDATES) {
    try { return require(c); } catch (e) { errs.push(`${c}: ${e.code || e.message}`); }
  }
  throw new Error(
    'probe-lib: 无法解析 puppeteer-core。已尝试：\n  - ' + errs.join('\n  - ') +
    '\n在仓库根目录跑：npm i --no-save --no-package-lock puppeteer-core' +
    '\n  （省事版：node kit/check_env.js --install --yes 替你装）' +
    '\n  （已经装在别处：设环境变量 PROBE_PUPPETEER=<绝对路径>）'
  );
})();

/* 单真源：chrome 候选表只在 render-core 里定义一次 */
const { resolveChrome } = require('./render-core');

// ---------------------------------------------------------------------------
// 页面内读取器（字符串形式注入，禁反引号 —— 会被外层模板提前闭合，BUG-2019 同类坑）
// ---------------------------------------------------------------------------

/* 读单个元素的几何 + 内联变换 + 关键计算样式 */
function READ_EL(src) {
  var sel = src.sel, props = src.props || [];
  var el = document.querySelector(sel);
  if (!el) return { sel: sel, missing: true };
  var cs = getComputedStyle(el);
  var r = el.getBoundingClientRect();
  var tr = el.style.transform || '';
  var only = function (re, i) { var m = re.exec(tr); return m ? parseFloat(m[i]) : null; };
  var T = /translate\(\s*(-?[\d.]+)px[,\s]+(-?[\d.]+)px/.exec(tr);
  var R = /rotate\(\s*(-?[\d.]+)deg/.exec(tr);
  var S = /scale\(\s*(-?[\d.]+)(?:[,\s]+(-?[\d.]+))?/.exec(tr);
  var o = {
    sel: sel, missing: false,
    tag: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
      (typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\s+/).join('.') : ''),
    left: +r.left.toFixed(2), top: +r.top.toFixed(2),
    width: +r.width.toFixed(2), height: +r.height.toFixed(2),
    cx: +(r.left + r.width / 2).toFixed(2), cy: +(r.top + r.height / 2).toFixed(2),
    tx: T ? parseFloat(T[1]) : null, ty: T ? parseFloat(T[2]) : null,
    rot: R ? parseFloat(R[1]) : null,
    sx: S ? parseFloat(S[1]) : null,
    sy: S ? (S[2] != null ? parseFloat(S[2]) : parseFloat(S[1])) : null,
    op: parseFloat(cs.opacity),
    filter: cs.filter === 'none' ? '' : cs.filter,
    z: cs.zIndex,
    traceN: el.__traceN,
    /* 掩码层数：mask-composite:add 取并集时，层数 = 当前显影层数，是遮罩类 bug 的自证量 */
    maskN: (function () {
      var mi = cs.maskImage && cs.maskImage !== 'none' ? cs.maskImage
        : (cs.webkitMaskImage && cs.webkitMaskImage !== 'none' ? cs.webkitMaskImage : 'none');
      return mi === 'none' ? 0 : mi.split('),').length;
    })(),
    maskHead: (function () {
      var mi = cs.maskImage && cs.maskImage !== 'none' ? cs.maskImage : (cs.webkitMaskImage || 'none');
      return String(mi).slice(0, 46);
    })(),
  };
  props.forEach(function (pp) { o['css_' + pp] = cs.getPropertyValue(pp); });
  return o;
}

/* 读不透明链路：目标元素一路到 body 的 opacity / filter / mask / __traceN */
function READ_CHAIN(sel) {
  var el = document.querySelector(sel);
  if (!el) return { sel: sel, missing: true, chain: [] };
  var out = [], e = el;
  while (e && e !== document.documentElement) {
    var cs = getComputedStyle(e);
    var mi = cs.maskImage && cs.maskImage !== 'none' ? cs.maskImage
      : (cs.webkitMaskImage && cs.webkitMaskImage !== 'none' ? cs.webkitMaskImage : 'none');
    out.push({
      tag: e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') +
        (typeof e.className === 'string' && e.className.trim()
          ? '.' + e.className.trim().split(/\s+/).join('.') : ''),
      op: parseFloat(cs.opacity),
      filter: cs.filter === 'none' ? '' : cs.filter.slice(0, 40),
      maskN: mi === 'none' ? 0 : mi.split('),').length,
      maskHead: String(mi).slice(0, 40),
      traceN: e.__traceN,
    });
    e = e.parentElement;
  }
  return { sel: sel, missing: false, chain: out };
}

// ---------------------------------------------------------------------------
// 路径解析：文件直用；目录自动挑唯一的 fx_*.html
// ---------------------------------------------------------------------------

function resolveHtml(input) {
  if (!input) throw new Error('probe-lib: 缺少 html 参数');
  const abs = path.resolve(input);
  if (!fs.existsSync(abs)) throw new Error('probe-lib: 路径不存在 ' + abs);
  if (fs.statSync(abs).isFile()) return abs;
  const cands = fs.readdirSync(abs).filter(function (f) { return /^fx_.*\.html$/i.test(f); });
  if (cands.length === 1) return path.join(abs, cands[0]);
  if (!cands.length) throw new Error('probe-lib: 目录内没有 fx_*.html：' + abs);
  throw new Error('probe-lib: 目录内有多个 fx_*.html，请直接指定：\n  ' + cands.join('\n  '));
}

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

/**
 * 打开一个动效页面并接管逐帧驱动。
 * @param {string} html  文件路径，**或工程目录**（目录内只有一个 fx_*.html 时自动挑，
 *                       多个就报错列出候选）—— 治掉「27 支脚本各自硬编码文件名」的漏改。
 * @param {object} [opts]
 *   w,h   视口尺寸，默认 1920×1080
 *   ss    deviceScaleFactor，默认 1（截帧审判建议 0.5，输出 960×540 便于肉眼看）
 *   chrome 显式指定 chrome.exe
 *   settle goto 后额外等待 ms，默认 400（等字体/首帧）
 *   quiet  静默 pageerror
 */
async function open(html, opts) {
  opts = opts || {};
  const abs = resolveHtml(html);
  if (!fs.existsSync(abs)) throw new Error('probe-lib: html 不存在 ' + abs);

  const W = opts.w || 1920, H = opts.h || 1080, SS = opts.ss || 1;
  const browser = await puppeteer.launch({
    executablePath: resolveChrome(opts.chrome),
    headless: 'new',
    args: ['--no-sandbox', '--force-device-scale-factor=1'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: SS });
  const errors = [];
  page.on('pageerror', function (e) {
    errors.push(e.message);
    if (!opts.quiet) console.error('PAGEERROR:', e.message);
  });
  page.on('console', function (m) {
    if (m.type() === 'error') {
      errors.push('console:' + m.text());
      if (!opts.quiet) console.error('CONSOLE:', m.text());
    }
  });
  await page.goto('file:///' + abs.replace(/\\/g, '/'), { waitUntil: 'networkidle0' });
  /* ★ 隐藏起播遮罩（2026-09-20 补 · BUG-2358 同族 / 堵 BUG-2188 的另一半）
     工程里的 fx_*.html 都定义 `window.__hideOv`（把 `#startOv` —— 整屏 rgba(255,255,255,.92)
     的"点击播放"白纱门帘 + 一行工程标识字 —— 设成 display:none）。
     **本库以前没有这一步** ⇒ 用 probe-lib 截的帧会盖上白纱、量到的像素也带白纱，
     而且**不报任何错**（BUG-2358 就是这么把 0.84MB 的白纱成片交出去的）。

     ⚠️ 写法说明（2026-09-20 查清全仓）：**这同一件事全仓有四种写法** ——
       ① 老 `_render.js` 调 `window.__hideOv()` 钩子；
       ② `new_project.js` 模板直设 `getElementById('startOv').style.display='none'`；
       ③ `contrast_check.js` 也是直设 display:none；
       ④ `kit/render-core.js` **原来啥都没做** ⇒ 就是 BUG-2358 的白纱成片。
     ⇒ 病根不是"谁忘了"，是"**四条各写各的**"。这里取**最稳的一种 = 两条都做**：
        先调钩子（钩子未来加别的前置也自动跟上），再直设兜底（页面没定义钩子时也安全）。
     ⚠️ 实测对照（fx_s8.html t=5.0，变量只加在一侧）：
        修后 PNG 398KB / 与成片同帧 YAVG 0.53（= 编码损失量级）；
        遮罩恢复显示 122KB / YAVG 7.56（3.3× 体积差、14.3× 像素差）。 */
  await page.evaluate(function () {
    if (typeof window.__hideOv === 'function') window.__hideOv();
    var s = document.getElementById('startOv');
    if (s) s.style.display = 'none';
  });

  if (opts.settle !== 0) await new Promise(function (r) { setTimeout(r, opts.settle == null ? 400 : opts.settle); });

  let closed = false;
  const api = {
    page: page, browser: browser, html: abs, errors: errors, w: W, h: H,

    /* 逐帧驱动：优先 seekToFrame（帧号，无累积误差），否则 __frame（秒） */
    async frame(t) {
      return page.evaluate(function (tt) {
        if (typeof window.__frame === 'function') { window.__frame(tt); return 'frame'; }
        if (typeof window.seekToFrame === 'function') { window.seekToFrame(Math.round(tt * 30)); return 'seek'; }
        if (typeof window.seek === 'function') { window.seek(tt); return 'seek2'; }
        throw new Error('probe-lib: 页面既无 __frame() 也无 seekToFrame()');
      }, t);
    },

    /* 页面自报信息（有 getInfo 就用） */
    async info() {
      return page.evaluate(function () {
        try { return typeof window.getInfo === 'function' ? window.getInfo() : null; } catch (e) { return null; }
      });
    },

    async rect(sel, props) { return page.evaluate(READ_EL, { sel: sel, props: props || null }); },
    async chain(sel) { return page.evaluate(READ_CHAIN, sel); },

    /* 读页面里的一个常量对象（如 window.L10 的段边界），用于审计时自证口径 */
    async consts(expr) {
      return page.evaluate(function (e) {
        try { return (0, eval)('(typeof ' + e + ' === "object" ? ' + e + ' : ' + e + ')'); } catch (err) { return null; }
      }, expr);
    },

    /**
     * 帧间位移差分 —— 抓「传送门」（瞬移）与「接缝速度不连续」。
     * ★ 世界量 dxw 与屏幕量 dxs 必须分开看（2026-09-11 首跑教训）：
     *   屏幕 cx 位移 = 元素自身运动 ⊕ 相机平移。L10 实测 0.43~0.53s 屏幕上 cx 反复
     *   折返（jerk ±29），一度被误报成「元素速度拐点」；查世界 tx 才发现元素一路单调
     *   减速，折返全是相机 0.30→0.62 反向摇镜造成的。
     *   判据：dxs 跳 → 传送门（不管是元素还是相机）；再看 dxw ——
     *     dxw 同时跳 = 元素自身跳（真 bug，如 BUG-2031）
     *     dxw 平滑   = 相机跳（查 camkeys 连续性）
     * @returns rows: [{t, tx, cx, cy, w, dxw, dxs, jerk, flag}]
     */
    async track(sel, from, to, fps) {
      fps = fps || 30;
      const a = from == null ? 0 : from, b = to == null ? a + 1 : to;
      const raw = await page.evaluate(function (s) {
        var sel = s.sel, fa = Math.round(s.a * s.fps), fb = Math.round(s.b * s.fps), out = [];
        for (var f = fa; f <= fb; f++) {
          var t = f / s.fps;
          if (typeof window.__frame === 'function') window.__frame(t);
          var el = document.querySelector(sel);
          if (!el) { out.push({ t: +t.toFixed(4), missing: 1 }); continue; }
          var r = el.getBoundingClientRect();
          var tr = el.style.transform || '';
          var T = /translate\(\s*(-?[\d.]+)px[,\s]+(-?[\d.]+)px/.exec(tr);
          out.push({
            t: +t.toFixed(4),
            tx: T ? parseFloat(T[1]) : null, ty: T ? parseFloat(T[2]) : null,
            cx: +(r.left + r.width / 2).toFixed(2), cy: +(r.top + r.height / 2).toFixed(2),
            w: +r.width.toFixed(2),
          });
        }
        return out;
      }, { sel: sel, a: a, b: b, fps: fps });
      let pTx = null, pCx = null, pD = null, pDw = null;
      raw.forEach(function (r) {
        if (r.missing) return;
        r.dxw = pTx === null ? 0 : +(r.tx - pTx).toFixed(2);
        r.dxs = pCx === null ? 0 : +(r.cx - pCx).toFixed(2);
        /* 一阶差分跳变 = 瞬移；二阶差分突变 = 速度不连续（卡一下又窜出去） */
        r.jerk = (pD === null) ? 0 : +(r.dxs - pD).toFixed(2);
        r.jerkw = (pDw === null) ? 0 : +(r.dxw - pDw).toFixed(2);
        /* ★ 归类必须用**对应空间的二阶量**：世界速度平滑但屏幕速度折返 = 相机在摇，
           早先按 |dxw| 大小分类，把相机摇镜误标成 kink-elem（2026-09-11 首跑修） */
        if (Math.abs(r.dxs) > 40) r.flag = Math.abs(r.dxw) > 40 ? 'JUMP-ELEM' : 'JUMP-CAM';
        else if (Math.abs(r.jerk) > 18) r.flag = Math.abs(r.jerkw) > 18 ? 'kink-elem' : 'kink-cam';
        else r.flag = '';
        pTx = r.tx; pCx = r.cx; pD = r.dxs; pDw = r.dxw;
      });
      return raw;
    },

    /**
     * 旋转解缠 —— 判定「恰好一圈」与「是否反向」。
     * @returns {rows, unwrapped, reversals:[{t,from,to}], net}
     */
    async rot(sel, from, to, fps) {
      fps = fps || 30;
      const a = from == null ? 0 : from, b = to == null ? a + 1 : to;
      const raws = await page.evaluate(function (s) {
        var sel = s.sel, fa = Math.round(s.a * s.fps), fb = Math.round(s.b * s.fps), out = [];
        for (var f = fa; f <= fb; f++) {
          var t = f / s.fps;
          if (typeof window.__frame === 'function') window.__frame(t);
          var el = document.querySelector(sel);
          if (!el) { out.push([+t.toFixed(4), null]); continue; }
          var m = /rotate\(\s*(-?[\d.]+)deg/.exec(el.style.transform || '');
          out.push([+t.toFixed(4), m ? parseFloat(m[1]) : null]);
        }
        return out;
      }, { sel: sel, a: a, b: b, fps: fps });
      const vals = raws.map(function (r) { return r[1]; });
      let prev = null, un = 0;
      const unwrapped = vals.map(function (v) {
        if (v == null) return null;
        if (prev === null) { prev = v; return (un = v); }
        let d = v - prev;
        while (d > 180) d -= 360;
        while (d < -180) d += 360;
        prev = v; return (un += d);
      });
      const reversals = [];
      for (let i = 2; i < unwrapped.length; i++) {
        if (unwrapped[i] == null || unwrapped[i - 1] == null || unwrapped[i - 2] == null) continue;
        const d0 = unwrapped[i - 1] - unwrapped[i - 2], d1 = unwrapped[i] - unwrapped[i - 1];
        if (d0 * d1 < -0.01 && Math.abs(d0) > 0.05 && Math.abs(d1) > 0.05) {
          reversals.push({ t: raws[i][0], from: +d0.toFixed(2), to: +d1.toFixed(2) });
        }
      }
      const valid = unwrapped.filter(function (v) { return v != null; });
      return {
        rows: raws, unwrapped: unwrapped, reversals: reversals,
        net: valid.length ? +(valid[valid.length - 1] - valid[0]).toFixed(2) : null,
        turns: valid.length ? +((valid[valid.length - 1] - valid[0]) / 360).toFixed(3) : null,
      };
    },

    /* 截帧（可传 clip 裁切）。scale 会作用于整个视口，建议 open 时就用 ss 定好 */
    async shot(file, opt) {
      opt = opt || {};
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      const cfg = { path: path.resolve(file) };
      if (opt.type) cfg.type = opt.type;
      if (opt.quality) cfg.quality = opt.quality;
      if (opt.clip) cfg.clip = opt.clip;
      await page.screenshot(cfg);
      return path.resolve(file);
    },

    /* 批量截帧：times 数组，文件名 t秒 两位小数 */
    async shotMany(times, dir, opt) {
      opt = opt || {};
      fs.mkdirSync(path.resolve(dir), { recursive: true });
      const made = [];
      for (const t of times) {
        await api.frame(t);
        const f = path.join(dir, (opt.prefix || 't') + Number(t).toFixed(2).replace('.', '_') + '.jpg');
        await api.shot(f, { type: 'jpeg', quality: opt.quality || 88, clip: opt.clip });
        made.push({ t: t, file: f });
      }
      return made;
    },

    /* 整页 contact sheet 用：一次性拿多个时刻的 rect */
    async rectsAt(times, sel) {
      const out = [];
      for (const t of times) {
        await api.frame(t);
        const r = await api.rect(sel);
        r.t = t;
        out.push(r);
      }
      return out;
    },

    async close() {
      if (closed) return;
      closed = true;
      await browser.close().catch(function () {});
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// 报表格式化（让 CLI 与手写脚本输出一致，便于比对）
// ---------------------------------------------------------------------------

function fmtTrack(rows, opt) {
  opt = opt || {};
  const head = '   t       世界x    dxw     屏cx     dxs    屏cy    屏w    jerk';
  const lines = [head, '  ' + '-'.repeat(head.length - 2)];
  rows.forEach(function (r) {
    if (r.missing) { lines.push('  ' + String(r.t).padEnd(7) + ' 元素不存在'); return; }
    lines.push('  ' + String(r.t).padEnd(7) +
      String(r.tx == null ? '-' : r.tx).padStart(9) +
      r.dxw.toFixed(1).padStart(7) +
      String(r.cx).padStart(9) + r.dxs.toFixed(1).padStart(7) +
      String(r.cy).padStart(8) + String(r.w).padStart(8) +
      r.jerk.toFixed(1).padStart(7) +
      (r.flag ? '   <<< ' + r.flag : ''));
  });
  const elem = rows.filter(function (r) { return /ELEM|elem/.test(r.flag); }).length;
  const cam = rows.filter(function (r) { return /CAM|cam/.test(r.flag); }).length;
  lines.push('');
  if (!elem && !cam) {
    lines.push('  ✓ 位置与速度均连续（世界量 / 屏幕量都干净）');
  } else {
    if (elem) lines.push('  ✗ 元素自身 ' + elem + ' 处跳变/拐点（世界 dxw 也跳 → 真 bug，查段边界常量）');
    if (cam) lines.push('  ⚠ 相机 ' + cam + ' 处跳变/拐点（世界量平滑 → 查 camkeys 连续性）');
  }
  return lines.join('\n');
}

function fmtRot(res) {
  const lines = [];
  const t = res.turns;
  const verdict = (t != null && Math.abs(Math.abs(t) - 1) < 0.02)
    ? '   ✓ 恰好一圈'
    : '   （窗口含多段时净转本就不该是整数圈，判「一圈」请把 --from/--to 裁到单段，或用 --expect-turns）';
  lines.push('  净转 ' + res.net + '°  = ' + t + ' 圈' + verdict);
  lines.push('  反向点 ' + res.reversals.length + ' 处' +
    (res.reversals.length ? '：' + res.reversals.map(function (r) {
      return 't=' + r.t + '(' + r.from + '→' + r.to + ')';
    }).join(' ') : '   ✓ 单调不反向'));
  return lines.join('\n');
}

function fmtChain(chain) {
  const lines = [];
  chain.chain.forEach(function (c) {
    lines.push('   op=' + String(c.op).padStart(5) +
      (c.filter ? '  filter=' + c.filter : '') +
      '  mask(' + c.maskN + ')=' + c.maskHead +
      (c.traceN != null ? '  __traceN=' + c.traceN : '') +
      '  ' + c.tag);
  });
  return lines.join('\n');
}

module.exports = { open: open, fmtTrack: fmtTrack, fmtRot: fmtRot, fmtChain: fmtChain };
