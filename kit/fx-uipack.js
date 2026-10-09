/* ==========================================================================
 * fx-uipack.js —— UI 风 MG 动效驱动包（window.UIP）
 * --------------------------------------------------------------------------
 * 来源：2026-09-09 从两处转译沉淀——
 *   1) 本机动效配方库 `demos-*.css`（531 个 CSS keyframes 配方）
 *      → 按 __frame(t) 纯函数契约重写（CSS animation 不可逐帧截图，配方保留、机制替换）
 *   2) （本机草稿，未随仓库分发）
 *      → setBorder 流光边框 / 频谱波形 / spring 缓动直接搬
 * 铁律（与 fx-runtime.js 同源）：
 *   - 全部纯函数：同一 t 进来逐像素一致；禁累计 / Date.now / Math.random
 *   - 零依赖，可整段内联单文件 HTML；本文件禁出现字面 script 结尾标签
 *   - 与 window.FX（fx-runtime.js）配套使用，本文件不重复造缓动
 * ========================================================================== */
(function (global) {
  'use strict';
  const FX = global.FX || {};
  const clamp01 = FX.clamp01 || ((v) => (v < 0 ? 0 : v > 1 ? 1 : v));
  const seg = FX.seg || ((t, t0, d) => { const x = clamp01((t - t0) / (d > 1e-9 ? d : 1e-9)); return 1 - Math.pow(1 - x, 3); });
  const c1 = FX.c1 || ((t, t0, d) => clamp01((t - t0) / (d > 1e-9 ? d : 1e-9)));
  const lerp = FX.lerp || ((a, b, k) => a + (b - a) * k);
  const sin = Math.sin;

  /* ------------------------------------------------------------------ *
   * 1. flowBorder —— conic 流光渐变边框（转译自 yourmotion setBorder）
   *    HTML 结构：<div class="ui-fb"><i class="ui-fb-i"></i></div>
   *    CSS 见 fx-uipack.css 的 .ui-fb 段（mask-composite 挖空成 2px 环）
   *    @param speed  转速 deg/s（默认 240）；on: 0..1 显隐系数
   * ------------------------------------------------------------------ */
  function flowBorder(el, t, on, speed) {
    if (!el) return;
    const sp = speed == null ? 240 : speed;
    el.style.setProperty('--ang', ((t * sp) % 360).toFixed(2) + 'deg');
    el.style.opacity = clamp01(on);
  }

  /* ------------------------------------------------------------------ *
   * 2. drawPath —— SVG 路径描线（转译自 动效设计师 k-ebzDraw/k-ceDraw 配方）
   *    el 为 <path>（可带 pathLength="1" 归一化）；首次调用会缓存总长
   *    @param d 描线时长；t<t0 为 0（整条隐藏），t≥t0+d 画满
   * ------------------------------------------------------------------ */
  const _plen = new Map();
  function drawPath(el, t, t0, d) {
    if (!el) return;
    let L = _plen.get(el);
    if (L == null) {
      L = (typeof el.getTotalLength === 'function') ? el.getTotalLength() : 100;
      _plen.set(el, L);
      el.style.strokeDasharray = L;
    }
    const p = seg(t, t0, d);
    el.style.strokeDashoffset = L * (1 - p);
    return p;
  }

  /* ------------------------------------------------------------------ *
   * 3. tick —— 对勾勾选（SVG polyline 专用 drawPath 简装版）
   *    配合 .ui-row：行高亮由调用方用 seg 写 background/border
   * ------------------------------------------------------------------ */
  function tick(el, t, t0, d) { return drawPath(el, t, t0, d == null ? 0.35 : d); }

  /* ------------------------------------------------------------------ *
   * 4. typing —— IM「输入中」三点弹跳（转译自 k-... 打字点配方）
   *    el 容器内须有 3 个 <i>；纯 sin 位移，非 opacity 闪烁（截帧友好）
   * ------------------------------------------------------------------ */
  function typing(el, t, on) {
    if (!el) return;
    const dots = el.children;
    el.style.opacity = clamp01(on);
    for (let i = 0; i < dots.length; i++) {
      const ph = (t * 5.2 + i * 0.55) % (Math.PI * 2);
      dots[i].style.transform = 'translateY(' + (-4 * Math.max(0, sin(ph))).toFixed(2) + 'px)';
      dots[i].style.opacity = (0.45 + 0.55 * clamp01(0.5 + 0.5 * sin(ph))).toFixed(3);
    }
  }

  /* ------------------------------------------------------------------ *
   * 5. toast —— 系统通知横幅（macOS 通知手感：下滑 + spring 回稳 + 到点收回）
   *    @param y 顶部落点 px；tOut 不传 = 只入不出
   * ------------------------------------------------------------------ */
  function toast(el, t, tIn, tOut, y) {
    if (!el) return;
    const Y = y == null ? 28 : y;
    const tin = seg(t, tIn, 0.55);
    const tout = tOut == null ? 1 : 1 - seg(t, tOut, 0.45);
    const k = Math.min(tin, tout);
    // spring 过冲（阻尼余弦，与 yourmotion spring 同款）
    const q = clamp01((t - tIn) / 0.55);
    const spring = 1.04 - 0.04 * Math.cos(q * Math.PI * 2.2) * Math.exp(-q * 5);
    el.style.opacity = k;
    el.style.transform = 'translateY(' + ((1 - k) * -70).toFixed(2) + 'px) scale(' + spring.toFixed(4) + ')';
  }

  /* ------------------------------------------------------------------ *
   * 6. pkt —— 数据包沿折线/点列流动（星型组网抄读这类）
   *    @param pts [[x,y],...] 路径点列；@param phase 0..1 起点；@param loop 循环秒
   *    返回当前 {x,y}；配 canvas 画或驱动绝对定位小圆点
   * ------------------------------------------------------------------ */
  function pkt(t, pts, loop, phase) {
    if (!pts || pts.length < 2) return { x: 0, y: 0 };
    let segs = 0;
    for (let i = 1; i < pts.length; i++) segs += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    let dist = ((t / (loop > 1e-9 ? loop : 1)) % 1 + (phase || 0)) % 1 * segs;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
      const L = Math.hypot(dx, dy);
      if (dist <= L || i === pts.length - 1) {
        const k = L > 1e-9 ? clamp01(dist / L) : 0;
        return { x: lerp(pts[i - 1][0], pts[i][0], k), y: lerp(pts[i - 1][1], pts[i][1], k) };
      }
      dist -= L;
    }
    const last = pts[pts.length - 1];
    return { x: last[0], y: last[1] };
  }

  /* ------------------------------------------------------------------ *
   * 7. pulse —— 脉冲环扩散（中心节点向外一圈圈，转译自 k-corePulse 系）
   *    el 为绝对定位圆环容器；rings 内部子元素逐环 scale+fade
   * ------------------------------------------------------------------ */
  function pulse(el, t, t0, period, on) {
    if (!el) return;
    const P = period == null ? 1.6 : period;
    const kids = el.children;
    el.style.opacity = clamp01(on == null ? 1 : on);
    for (let i = 0; i < kids.length; i++) {
      const ph = ((t - t0) / P + i / kids.length) % 1;
      const k = clamp01(ph);
      kids[i].style.transform = 'scale(' + (0.25 + 0.75 * k).toFixed(4) + ')';
      kids[i].style.opacity = (0.55 * (1 - k)).toFixed(3);
    }
  }

  /* ------------------------------------------------------------------ *
   * 8. wave —— canvas 频谱条（转译自 yourmotion shot3 频谱 + demos 光带）
   *    @param g canvas 2d context；opts {n, w, h, color, alpha}
   * ------------------------------------------------------------------ */
  function wave(g, t, opts) {
    if (!g) return;
    const o = opts || {};
    const n = o.n || 48, W = o.w || g.canvas.width, H = o.h || g.canvas.height;
    const color = o.color || '#3DA9FF', alpha = o.alpha == null ? 0.8 : o.alpha;
    g.clearRect(0, 0, W, H);
    const bw = W / n;
    for (let i = 0; i < n; i++) {
      const h = (0.18 + 0.82 * Math.abs(sin(t * 2.6 + i * 0.55) * 0.6 + sin(t * 4.1 + i * 0.23) * 0.4)) * H;
      g.globalAlpha = alpha;
      g.fillStyle = o.rainbow ? 'hsl(' + ((i * 360 / n + t * 60) % 360) + ',90%,58%)' : color;
      g.fillRect(i * bw + 1.5, H - h, bw - 3, h);
    }
    g.globalAlpha = 1;
  }

  /* ------------------------------------------------------------------ *
   * 9. breathe —— 呼吸（红点 LIVE / 徽标微闪）：scale+opacity 正弦，纯函数
   * ------------------------------------------------------------------ */
  function breathe(el, t, amp, freq) {
    if (!el) return;
    const A = amp == null ? 0.12 : amp, F = freq == null ? 2.2 : freq;
    const k = 1 - A / 2 + (A / 2) * sin(t * F * Math.PI * 2);
    el.style.opacity = (0.55 + 0.45 * k).toFixed(3);
    el.style.transform = 'scale(' + k.toFixed(4) + ')';
  }

  /* ==================================================================== *
   * 后期层驱动（fx-post-*）
   * --------------------------------------------------------------------
   * 静态纹理全在 fx-uipack.css 的 .fx-post-* 段；这里只驱动「需要随 t 变」的两个。
   * 其余 15 个静态层直接用 style.opacity = 常数 × __frame(t) 的系数即可，不需要函数。
   * ==================================================================== */

  /* ------------------------------------------------------------------ *
   * 10. postSweep —— 后期层·光扫（一次性斜向扫过整屏，章节切换用）
   *    el 为 .fx-post-lightsweep；只写 background-position（不动 opacity）
   *    @param d 扫过时长；@param t 当前秒
   * ------------------------------------------------------------------ */
  function postSweep(el, t, t0, d) {
    if (!el) return 0;
    const dur = d == null ? 0.7 : d;
    const p = c1(t, t0, dur);
    el.style.backgroundPosition = (100 - p * 200).toFixed(2) + '% 0';
    el.style.opacity = (p <= 0 || p >= 1) ? 0 : (0.55 * Math.sin(p * Math.PI)).toFixed(3);
    return p;
  }

  /* ------------------------------------------------------------------ *
   * 11. postBeam —— 后期层·扫描条（全息取景器，上下往复）
   *    el 为 .fx-post-scanbeam；写 background-position-y
   * ------------------------------------------------------------------ */
  function postBeam(el, t, t0, period, on) {
    if (!el) return;
    const P = period == null ? 2.4 : period;
    const ph = ((t - t0) / P) % 1;
    // 三角波上下来回，两端减速（避免撞顶撞底的机械感）
    const tri = ph < 0.5 ? ph * 2 : (1 - ph) * 2;
    el.style.backgroundPosition = '0 ' + (tri * 100).toFixed(2) + '%';
    el.style.opacity = (clamp01(on == null ? 1 : on) * 0.85).toFixed(3);
  }

  /* ==================================================================== *
   * 元素级效果（转译自 Remotion 官方同名效果的设计意图）
   * --------------------------------------------------------------------
   * ⚠️ @remotion/effects = UNLICENSED → 只抄「效果语义」，实现全部自写。
   * 全部 __frame(t) 纯函数；写的是元素自身 style 或追加子节点属性。
   * ==================================================================== */

  /* ------------------------------------------------------------------ *
   * 12. blurBridge —— 模糊桥接（进场/退场两端糊、中段清）
   *    转译自 Remotion `blur`；对齐学习知识库 §11.9。
   *    比「淡入淡出」更"物理"：像镜头对焦到位。
   *    @param focus 清晰时刻；@param d 单侧过渡时长
   * ------------------------------------------------------------------ */
  function blurBridge(el, t, tFocus, d, tOut, dOut) {
    if (!el) return 1;
    const dur = d == null ? 0.45 : d;
    const inK = seg(t, tFocus - dur, dur);            // 进场：糊 → 清
    const outK = tOut == null ? 1 : 1 - seg(t, tOut, dOut == null ? dur : dOut);
    const k = Math.min(inK, outK);
    const blur = (1 - k) * 14;                        // 最糊 14px
    el.style.filter = blur < 0.05 ? 'none' : 'blur(' + blur.toFixed(2) + 'px)';
    el.style.opacity = k.toFixed(3);
    return k;
  }

  /* ------------------------------------------------------------------ *
   * 13. glowPulse —— 描边发光（呼吸式，用于"通电/激活"的元件）
   *    转译自 Remotion `glow` + `outline`；用 drop-shadow 而非 box-shadow
   *    （drop-shadow 跟随元素轮廓，圆/异形都不会露出方角）
   * ------------------------------------------------------------------ */
  function glowPulse(el, t, t0, color, amp, freq) {
    if (!el) return;
    const C = color || 'rgba(53,224,208,.85)';
    const A = amp == null ? 26 : amp, F = freq == null ? 0.55 : freq;
    const k = 0.5 + 0.5 * sin((t - t0) * F * Math.PI * 2);
    const px = (2 + A * k).toFixed(1);
    el.style.filter = 'drop-shadow(0 0 ' + px + 'px ' + C + ')';
  }

  /* ------------------------------------------------------------------ *
   * 14. outlineDraw —— 描边显现（用 SVG stroke 走一圈，非 border）
   *    转译自 Remotion `outline`；el 为 <rect>/<path>（须 pathLength="1"）
   * ------------------------------------------------------------------ */
  function outlineDraw(el, t, t0, d) { return drawPath(el, t, t0, d == null ? 0.6 : d); }

  /* ------------------------------------------------------------------ *
   * 15. pixelDissolve —— 像素溶解（4px 块，从左上向右下推进）
   *    转译自 Remotion `pixelDissolve`；用 CSS mask 的 repeating-conic 造块
   *    + mask-position 推前沿。比"方块逐个 pop"更连续、不啰嗦。
   *    @param dir 'tl'|'tr'|'bl'|'br'（默认 tl）
   * ------------------------------------------------------------------ */
  function pixelDissolve(el, t, t0, d, dir) {
    if (!el) return 0;
    const p = seg(t, t0, d == null ? 0.8 : d);
    if (p <= 0) { el.style.opacity = 0; return 0; }
    if (p >= 1) {
      el.style.webkitMaskImage = el.style.maskImage = 'none';
      el.style.opacity = 1; return 1;
    }
    // 4px 块状遮罩：conic 每 50% 交替实/虚，再靠 size 切块
    const mask = 'repeating-conic-gradient(#000 0% 25%, transparent 25% 50%)';
    const gx = dir === 'tr' || dir === 'br' ? (1 - p) * 100 : p * 100 - 100;
    const gy = dir === 'bl' || dir === 'br' ? p * 100 - 100 : p * 100 - 100;
    el.style.webkitMaskImage = el.style.maskImage = mask;
    el.style.webkitMaskSize = el.style.maskSize = '4px 4px';
    el.style.webkitMaskPosition = el.style.maskPosition = gx.toFixed(2) + '% ' + gy.toFixed(2) + '%';
    el.style.opacity = 1;
    return p;
  }

  /* ------------------------------------------------------------------ *
   * 16. mirrorSlide —— 镜像滑入（左右对称推入，转场/对比用）
   *    转译自 Remotion `mirror`；右侧元素取负向
   * ------------------------------------------------------------------ */
  function mirrorSlide(el, t, t0, d, side) {
    if (!el) return 0;
    const s = side === 'right' ? -1 : 1;
    const k = seg(t, t0, d == null ? 0.6 : d);
    const w = el.offsetWidth || 400;
    el.style.transform = 'translateX(' + (s * (1 - k) * w * 0.6).toFixed(1) + 'px)';
    el.style.opacity = k.toFixed(3);
    el.style.transform += ' scaleX(' + (side === 'right' ? -1 : 1) + ')';
    return k;
  }

  /* ------------------------------------------------------------------ *
   * 17. translateFx —— 位移（Remotion `xyTranslate` 纯函数版）
   *    写 transform，与已有 transform 冲突时由调用方自己合成
   * ------------------------------------------------------------------ */
  function translateFx(el, t, x0, y0, x1, y1, t0, d) {
    if (!el) return 0;
    const k = seg(t, t0, d == null ? 1 : d);
    el.style.transform = 'translate(' + lerp(x0, x1, k).toFixed(1) + 'px,' + lerp(y0, y1, k).toFixed(1) + 'px)';
    return k;
  }

  /* ------------------------------------------------------------------ *
   * 18. scaleFx —— 缩放（Remotion `scale`）；纯 scale，无位移
   * ------------------------------------------------------------------ */
  function scaleFx(el, t, s0, s1, t0, d) {
    if (!el) return 0;
    const k = seg(t, t0, d == null ? 1 : d);
    el.style.transform = 'scale(' + lerp(s0, s1, k).toFixed(4) + ')';
    return k;
  }

  /* ------------------------------------------------------------------ *
   * 19. tearReveal —— 撕裂揭示（水平裂缝从中间撕开）
   *    转译自 Remotion `tear`；用 clip-path 上下两片反向让位
   *    @param W 参考宽；@param H 参考高（默认读 offsetHeight）
   * ------------------------------------------------------------------ */
  function tearReveal(el, t, t0, d, gap) {
    if (!el) return 0;
    const k = seg(t, t0, d == null ? 0.75 : d);
    const G = gap == null ? 26 : gap;
    const half = 50 + (k * (G / 2));
    el.style.clipPath = 'polygon(0 0, 100% 0, 100% ' + (half - 1).toFixed(2) + '%, 0 ' +
      (half + 1).toFixed(2) + '%)';
    el.style.opacity = k > 0 ? 1 : 0;
    return k;
  }

  /* ------------------------------------------------------------------ *
   * 20. blindsReveal —— 百叶窗揭示（多条横带依次展开）
   *    转译自 Remotion `venetianBlinds`；el 容器内须有 n 个条带子元素
   * ------------------------------------------------------------------ */
  function blindsReveal(el, t, t0, d, stagger) {
    if (!el) return 0;
    const kids = el.children;
    const n = kids.length || 1;
    const sg = stagger == null ? 0.05 : stagger;
    const dur = d == null ? 0.4 : d;
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const k = seg(t, t0 + i * sg, dur);
      kids[i].style.transform = 'scaleY(' + k.toFixed(4) + ')';
      kids[i].style.opacity = k.toFixed(3);
      if (k > 0.5) acc++;
    }
    return acc / n;
  }

  /* ------------------------------------------------------------------ *
   * 21. exposureRamp —— 曝光渐变（Remotion `exposure` / `brightness` 合成）
   *    与 blurBridge 的区别：只动亮度不动模糊，适合"灯亮起来"
   * ------------------------------------------------------------------ */
  function exposureRamp(el, t, t0, d, from, to) {
    if (!el) return 0;
    const k = seg(t, t0, d == null ? 0.5 : d);
    const v = lerp(from == null ? 0.35 : from, to == null ? 1.75 : to, k);
    el.style.filter = 'brightness(' + v.toFixed(3) + ')';
    return k;
  }

  /* ------------------------------------------------------------------ *
   * 22. tintRamp —— 色调偏移（Remotion `tint` / `duotone` 元素级版）
   *    用 hue-rotate + saturate 组合，不碰元素结构
   * ------------------------------------------------------------------ */
  function tintRamp(el, t, t0, d, hue0, hue1, sat) {
    if (!el) return 0;
    const k = seg(t, t0, d == null ? 0.6 : d);
    const S = sat == null ? 1.35 : sat;
    el.style.filter = 'hue-rotate(' + lerp(hue0 == null ? 0 : hue0, hue1 == null ? 40 : hue1, k).toFixed(1) +
      'deg) saturate(' + S.toFixed(2) + ')';
    return k;
  }

  const UIP = { flowBorder, drawPath, tick, typing, toast, pkt, pulse, wave, breathe,
    postSweep, postBeam,
    blurBridge, glowPulse, outlineDraw, pixelDissolve, mirrorSlide,
    translateFx, scaleFx, tearReveal, blindsReveal, exposureRamp, tintRamp };
  global.UIP = UIP;
  if (typeof module !== 'undefined' && module.exports) module.exports = UIP;
})(typeof window !== 'undefined' ? window : globalThis);
