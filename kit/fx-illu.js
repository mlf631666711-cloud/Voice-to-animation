/* ==========================================================================
 * fx-illu.js —— 插画生长驱动包（window.ILLU）
 * --------------------------------------------------------------------------
 * 来源：2026-09-14 动效师首单（单号 MO-2026-09-14-001）
 *   需求：库里 1420 张 unDraw 插画（占 81%）是「纯 fill 色块」，
 *         既没有 stroke 不能描线，又 100% 自带 transform 不能逐层揭示
 *         → 只能用最平庸的整体位移。本包为它们造「被画出来」的能力。
 * 来源数据：`tool/矢量素材库/_tools/_probe_undraw_all.json`（1754 张全量扫描）
 *
 * 铁律（与 fx-runtime.js / fx-uipack.js 同源）：
 *   - 全部纯函数：同一 t 进来逐像素一致；禁累计 / Date.now / Math.random
 *   - 零依赖，可整段内联单文件 HTML；本文件禁出现字面 script 结尾标签
 *   - 与 window.FX 配套，本文件不重复造缓动
 *
 * ★ 核心机制：硬边推进 + 笔尖亮线
 *   为什么不用淡入？——「淡入」= 这个东西**出现**了；
 *                    「硬边推进」= 这个东西**被画出来**了。
 *   因果感不同。观众要的是后者。
 *
 * ★ 两级时间窗口（别搞混，否则会被按元素级判 FAIL）
 *   元素级（规格锁 §5.11）：150~300ms —— 一个图标飞入 / 一行字浮现
 *   叙事级（本包）：      1.2~2.4s  —— 整张插画被画出来，**跟旁白句子走**
 *   判别问句：「这东西是"画面里的一个元素"，还是"就是这一段的画面本身"？」
 * ========================================================================== */
(function (global) {
  'use strict';
  const FX = global.FX || {};
  const clamp01 = FX.clamp01 || ((v) => (v < 0 ? 0 : v > 1 ? 1 : v));
  const lerp = FX.lerp || ((a, b, k) => a + (b - a) * k);
  /* 默认 eio —— 起笔慢、中段快、收笔慢。见 §参数表出处的「手绘扫过」节奏。
     注意：不依赖 FX.eio 存在与否也要能跑（兜底 cubic in-out） */
  const eioFallback = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

  /* ------------------------------------------------------------------ *
   * 0. 工具
   * ------------------------------------------------------------------ */

  /* 方向 → 轴：'ltr'/'rtl' 沿 x，'ttb'/'btt' 沿 y，'diag' 用斜切线中点 */
  function axisOf(dir) {
    if (dir === 'ttb' || dir === 'btt') return 'y';
    if (dir === 'diag') return 'b';
    return 'x';
  }

  function clipFor(dir, pct, slope) {
    switch (dir) {
      case 'rtl': return 'inset(0 0 0 ' + (100 - pct).toFixed(3) + '%)';
      case 'ttb': return 'inset(0 0 ' + (100 - pct).toFixed(3) + '% 0)';
      case 'btt': return 'inset(' + (100 - pct).toFixed(3) + '% 0 0 0)';
      case 'diag': {
        /* 斜边从 (pct+slope, 0%) 扫到 (pct, 100%)，斜度 slope 百分比。
           pct 需留出 slope 的余量，否则起笔/收笔时斜边会露出画面外 */
        const s = slope == null ? 28 : slope;
        const x0 = pct - s;                       /* 下沿 x */
        const x1 = pct;                           /* 上沿 x（斜边向右上） */
        return 'polygon(0 0, ' + x1.toFixed(3) + '% 0, ' + x0.toFixed(3) +
               '% 100%, 0 100%)';
      }
      default: return 'inset(0 ' + (100 - pct).toFixed(3) + '% 0 0)';  /* ltr */
    }
  }

  /* ------------------------------------------------------------------ *
   * 1. illuCalc —— ★ 纯计算，不碰 DOM
   *    @param t   当前时刻（秒）
   *    @param o   { t0, dur, dir, slope, penFadeIn, settle, ease }
   *    @returns   { k, p, pct, clip, penOp, penX, penY, axis, on, done }
   *
   *    存在的意义：自动判据（D1 纯函数 / D3 非匀速 / R1 匀速反例）
   *    可以**完全不开浏览器**就跑，测试面比只给 DOM 版大得多。
   * ------------------------------------------------------------------ */
  function illuCalc(t, o) {
    o = o || {};
    const t0 = o.t0 || 0;
    const dur = o.dur == null ? 1.6 : o.dur;
    const dir = o.dir || 'ltr';
    const ease = o.ease || FX.eio || eioFallback;
    const fadeIn = o.penFadeIn == null ? 0.08 : o.penFadeIn;
    const settle = o.settle == null ? 0.25 : o.settle;

    const k = clamp01((t - t0) / (dur > 1e-9 ? dur : 1e-9));   /* 线性进度 */
    const p = clamp01(ease(k));                                /* 缓动后进度 */
    const pct = p * 100;

    /* 笔尖不透明度：起笔淡入 → 保持 → 过终点后 settle 内淡出
       ★ 末帧必须归 0（角色卡陷阱 #3：本意该为零的量不回验末帧） */
    const penIn = clamp01((t - t0) / (fadeIn > 1e-9 ? fadeIn : 1e-9));
    const penOut = 1 - clamp01((t - (t0 + dur)) / (settle > 1e-9 ? settle : 1e-9));
    const penOp = Math.min(penIn, penOut);

    const axis = axisOf(dir);
    /* 笔尖位置（未乘尺寸，归一化 0..1 由调用方乘 W/H；
       diag 取斜边中点 x = (pct + slope/2)/100, y = 0.5） */
    const slope = o.slope == null ? 28 : o.slope;
    let px = 0, py = 0;
    if (axis === 'x') { px = p; py = 0.5; }
    else if (axis === 'y') { px = 0.5; py = p; }
    else { px = (pct + slope / 2) / 100; py = 0.5; }

    return {
      k: k, p: p, pct: pct,
      clip: clipFor(dir, pct, slope),
      penOp: penOp,
      penX: px, penY: py,
      axis: axis, dir: dir,
      on: t >= t0 && t <= t0 + dur,
      done: t >= t0 + dur,
    };
  }

  /* ------------------------------------------------------------------ *
   * 2. mount —— 一次性准备（每场只跑一次，别进 __frame）
   *
   *  ★ 层级设计（本包最容易错的地方，出过一次真 bug）：
   *
   *      .stage   ← 外层，**不裁**。笔尖挂这一层
   *        └ .illu-clip   ← 被 clip-path 裁的那层，SVG 住在这
   *
   *    笔尖必须是 clip 层的**兄弟**，绝不能挂进 clip 层里面 ——
   *    clip-path 会连同子树一起裁，笔尖会被自己推进的前沿切掉，
   *    症状是「亮线根本不出现」（demo 里的反例 R3）。
   *    本函数把这条约束固化成 API：你只能给它 stage，它自己找 clip 层，
   *    所以调用方没有机会把笔尖挂错位置。
   *
   *  @returns { stage, clip, pen }
   * ------------------------------------------------------------------ */
  function mount(stage, opts) {
    if (!stage) return null;
    opts = opts || {};
    const clip = opts.clip || stage.querySelector('.illu-clip');
    if (!clip) throw new Error('ILLU.mount: stage 内找不到 .illu-clip（承载 SVG 的那一层）');

    const cs = global.getComputedStyle ? global.getComputedStyle(stage) : null;
    if (cs && cs.position === 'static') stage.style.position = 'relative';
    /* clip 层铺满 stage —— 保证笔尖坐标与 stage 坐标同源 */
    clip.style.position = 'absolute';
    clip.style.left = '0'; clip.style.top = '0';
    clip.style.width = '100%'; clip.style.height = '100%';
    clip.style.overflow = 'hidden';

    let pen = opts.pen;
    if (pen === undefined) {
      pen = global.document.createElement('i');
      pen.className = 'illu-pen';
      pen.setAttribute('aria-hidden', 'true');
      const w = opts.penW == null ? 2 : opts.penW;
      const glow = opts.penGlow === undefined ? 14 : opts.penGlow;
      const color = opts.penColor || 'var(--c-a1, #6c63ff)';
      pen.style.cssText = [
        'position:absolute', 'left:0', 'top:0', 'height:100%',
        'width:' + w + 'px', 'background:#fff',
        'box-shadow:0 0 ' + glow + 'px ' + (glow / 3).toFixed(1) + 'px ' + color,
        'border-radius:2px', 'pointer-events:none', 'opacity:0',
        'will-change:transform,opacity', 'z-index:9',
      ].join(';');
      stage.appendChild(pen);            /* ★ 挂 stage，不挂 clip */
    }
    return { stage: stage, clip: clip, pen: pen || null };
  }

  /* ------------------------------------------------------------------ *
   * 3. illuGrow —— ★ 主配方：让 fill 色块插画「被画出来」
   *    @param clipEl  被裁的那层（= mount() 返回的 clip；**不碰它内部任何一个 path**）
   *    @param t       当前时刻（秒）
   *    @param o       { t0, dur, dir, slope, pen, W, H, penFadeIn, settle, ease }
   *    @returns       illuCalc 的全部字段（便于外层读 penOp 等）
   *
   *    ⚠️ 为什么只动容器、不动内部路径：
   *       1754 张全量扫描显示 C 档 100% 的图元自带 transform
   *       （`_probe_undraw_all.json`）→ 逐层揭示要自己累乘坐标变换 = 必然算错。
   *       交给浏览器：clip-path 作用在容器上，不受内部 transform 影响。
   * ------------------------------------------------------------------ */
  function illuGrow(clipEl, t, o) {
    if (!clipEl) return null;
    o = o || {};
    const r = illuCalc(t, o);
    /* clip 只在 illuCalc 里算一次 —— 这里直接用，别重算（重算 = 迟早两处不一致） */
    clipEl.style.clipPath = r.clip;
    clipEl.style.webkitClipPath = r.clip;

    const pen = o.pen;
    if (pen) {
      const W = o.W || clipEl.offsetWidth || 0;
      const H = o.H || clipEl.offsetHeight || 0;
      const pw = o.penW == null ? 2 : o.penW;
      /* ★ 笔尖位置必须夹在容器内。
         p=1 时若直接写 x=W，笔尖右半边会溢出容器被外层裁掉 ——
         症状是「末帧笔尖凭空消失」，反例 R4（残留）根本演示不出来。
         这里让**笔尖中心**贴前沿、并把整条线夹进 [0, W-pw]。 */
      const clampX = (v) => Math.min(Math.max(v, 0), Math.max(0, W - pw));
      const clampY = (v) => Math.min(Math.max(v, 0), Math.max(0, H - pw));
      pen.style.opacity = r.penOp.toFixed(3);
      if (r.axis === 'b') {
        /* diag：笔尖贴在斜边中点，随推进沿对角线移动 */
        pen.style.width = pw + 'px';
        pen.style.height = '100%';
        pen.style.transform = 'translate3d(' + clampX(r.penX * W - pw / 2).toFixed(2) +
          'px,0,0) rotate(90deg)';
      } else if (r.axis === 'y') {
        pen.style.width = '100%';
        pen.style.height = pw + 'px';
        pen.style.transform = 'translate3d(0,' + clampY(r.penY * H - pw / 2).toFixed(2) + 'px,0)';
      } else {
        pen.style.width = pw + 'px';
        pen.style.height = '100%';
        pen.style.transform = 'translate3d(' + clampX(r.penX * W - pw / 2).toFixed(2) + 'px,0,0)';
      }
    }
    return r;
  }

  /* ------------------------------------------------------------------ *
   * 4. softGrow —— 对照件：**淡入 + 轻微上浮**
   *    这是"看起来像动效但其实没有因果感"的典型。
   *    demo 里当反例 R2 用（判据应当能把它和 illuGrow 区分开）。
   * ------------------------------------------------------------------ */
  function softGrow(clipEl, t, o) {
    if (!clipEl) return null;
    o = o || {};
    const r = illuCalc(t, o);
    clipEl.style.clipPath = 'none';
    clipEl.style.webkitClipPath = 'none';
    clipEl.style.opacity = r.p.toFixed(3);
    clipEl.style.transform = 'translate3d(0,' + lerp(18, 0, r.p).toFixed(2) + 'px,0)';
    if (o.pen) o.pen.style.opacity = '0';
    return r;
  }

  /* ------------------------------------------------------------------ *
   * 5. reset —— 把 clip / pen 复位（换段、重渲时调一次）
   * ------------------------------------------------------------------ */
  function reset(clipEl, pen) {
    if (clipEl) {
      clipEl.style.clipPath = 'inset(0 100% 0 0)';
      clipEl.style.webkitClipPath = 'inset(0 100% 0 0)';
      clipEl.style.opacity = '1';
      clipEl.style.transform = 'none';
    }
    if (pen) pen.style.opacity = '0';
  }

  const ILLU = { illuCalc, illuGrow, softGrow, mount, reset, clipFor, axisOf };
  global.ILLU = ILLU;
  if (typeof module !== 'undefined' && module.exports) module.exports = ILLU;
})(typeof window !== 'undefined' ? window : globalThis);
