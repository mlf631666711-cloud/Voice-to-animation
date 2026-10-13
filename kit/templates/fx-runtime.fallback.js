/* =============================================================================
 * FX runtime · 内联 fallback        【DEPRECATED — 保留勿删】
 * -----------------------------------------------------------------------------
 * 正式版是 kit/fx-runtime.js，new_project.js 优先注入它；本文件只在正式版缺失时兜底。
 * 本文件与正式版**同签名**（元素优先），历史工程重渲时也可能依赖它，别删。
 *
 * TODO(收口)：若正式版改签名，必须同步改这里 + templates/skeleton.html。
 *
 * 契约（与正式版一致）：
 *   - 纯函数：只读 t / 入参；禁 Date.now() / Math.random() / 跨帧累加
 *   - 挂 window.FX；禁 CSS animation / transition
 *   - 元素优先：pop/fade/roll/typeOn/sweep 第一个参数都是 el
 * ========================================================================== */
(function (global) {
  'use strict';

  /* ---------- 0. 数学基元 ---------- */
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const lerp = (a, b, t) => a + (b - a) * t;

  const eo = (t) => { t = clamp01(t); return 1 - Math.pow(1 - t, 3); };   // easeOutCubic
  const ei = (t) => { t = clamp01(t); return t * t * t; };                 // easeInCubic
  const eio = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };      // easeInOut (smoothstep)
  const eob = (t) => {                                                     // easeOutBack 轻过冲
    t = clamp01(t);
    const c = 1.70158 * 1.2, q = t - 1;
    return 1 + (c + 1) * q * q * q + c * q * q;
  };

  /* ---------- 1. 时间窗口 ---------- */
  const c1 = (t, t0, d) => clamp01((t - t0) / (d > 1e-9 ? d : 1e-9));      // 线性窗口
  const seg = (t, t0, d) => eo(c1(t, t0, d));                              // 缓动窗口

  /* ---------- 2. 入场原语（元素优先） ---------- */
  function pop(el, t, t0, x, y, from) {
    if (!el) return;
    if (typeof x === 'number' && isFinite(x)) el.style.left = x + 'px';
    if (typeof y === 'number' && isFinite(y)) el.style.top = y + 'px';
    const e = eob(c1(t, t0, 0.50));
    el.style.opacity = seg(t, t0, 0.18);
    switch (from) {
      case 'left':  el.style.transform = 'translateX(' + ((1 - e) * -52) + 'px) scale(' + (0.9 + 0.1 * e) + ')'; break;
      case 'right': el.style.transform = 'translateX(' + ((1 - e) * 52) + 'px) scale(' + (0.9 + 0.1 * e) + ')'; break;
      case 'up':    el.style.transform = 'translateY(' + ((1 - e) * 46) + 'px)'; break;
      case 'down':  el.style.transform = 'translateY(' + ((1 - e) * -46) + 'px)'; break;
      default:      el.style.transform = 'scale(' + (0.72 + 0.28 * e) + ')'; break;
    }
  }

  function fade(el, t, t0, d, dy) {
    if (!el) return;
    const p = seg(t, t0, d);
    el.style.opacity = p;
    el.style.transform = 'translateY(' + ((1 - p) * (dy == null ? 18 : dy)) + 'px)';
  }

  /**
   * 双向窗口包络：0 → 1 → 0。拼"入场→驻留→退场"取系数用。
   * ⚠ 保证 tIn + dIn ≤ tOut；两窗口重叠时取 min，峰值会打折到不了 1。
   */
  function env(t, tIn, tOut, dIn, dOut) {
    const a = seg(t, tIn, dIn);
    const b = tOut == null ? 1 : 1 - seg(t, tOut, dOut);
    return Math.min(a, b);
  }

  /** 淡出 + 上移，与 fade 对称（fade 从 +dy 回 0，fadeOut 从 0 走到 -dy） */
  function fadeOut(el, t, t0, d, dy) {
    if (!el) return;
    const p = 1 - seg(t, t0, d);
    el.style.opacity = p;
    el.style.transform = 'translateY(' + ((1 - p) * -(dy == null ? 18 : dy)) + 'px)';
  }

  /** 淡入 → 驻留 → 淡出一条原语走完；不传 tOut 等价 fade（只入不出） */
  function fadeInOut(el, t, tIn, tOut, dIn, dOut, dy) {
    if (!el) return;
    const k = env(t, tIn, tOut, dIn == null ? 0.45 : dIn, dOut == null ? 0.45 : dOut);
    el.style.opacity = k;
    el.style.transform = 'translateY(' + ((1 - k) * (dy == null ? 18 : dy)) + 'px)';
  }

  /* ---------- 3. 运镜 ---------- */
  /**
   * 关键帧插值。keys 每项 = [t,x,y,z,rot] 或 {t,x,y,z,rot}（cx/cy 作 x/y 别名兼容）。
   * 返回 {x,y,z,rot,cx,cy}。段内 smoothstep，防关键帧折角。
   */
  function camAt(CAMKEYS, t) {
    const K = CAMKEYS || [];
    if (!K.length) return { x: 960, y: 540, z: 1, rot: 0, cx: 960, cy: 540 };
    const norm = (k) => Array.isArray(k)
      ? { t: k[0], x: k[1], y: k[2], z: k[3] == null ? 1 : k[3], rot: k[4] || 0 }
      : { t: k.t, x: (k.x == null ? k.cx : k.x), y: (k.y == null ? k.cy : k.y),
          z: k.z == null ? 1 : k.z, rot: k.rot || 0 };
    const first = norm(K[0]), last = norm(K[K.length - 1]);
    if (t <= first.t) return pack(first);
    if (t >= last.t) return pack(last);
    for (let i = 0; i < K.length - 1; i++) {
      const a = norm(K[i]), b = norm(K[i + 1]);
      if (t >= a.t && t <= b.t) {
        const k = eio((t - a.t) / Math.max(1e-6, b.t - a.t));
        return pack({
          x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k),
          z: lerp(a.z, b.z, k), rot: lerp(a.rot, b.rot, k),
        });
      }
    }
    return pack(last);
  }
  function pack(c) { return { x: c.x, y: c.y, z: c.z, rot: c.rot, cx: c.x, cy: c.y }; }

  /**
   * 多层视差（真 dolly）。rate：前景 1.0 / 中景 0.6 / 背景 0.3。
   * 前提：层 1920×1080 满画面、transform-origin:0 0；不要给父级再加 transform。
   */
  function applyParallax(el, cam, rate) {
    if (!el || !cam) return;
    const r = rate == null ? 1 : rate;
    const z = 1 + ((cam.z == null ? 1 : cam.z) - 1) * r;
    const tx = (960 - cam.x * cam.z) * r;
    const ty = (540 - cam.y * cam.z) * r;
    const rot = (cam.rot || 0) * r;
    el.style.transform =
      'translate(' + tx.toFixed(3) + 'px,' + ty.toFixed(3) + 'px)' +
      (rot ? ' rotate(' + rot.toFixed(3) + 'deg)' : '') +
      ' scale(' + z.toFixed(5) + ')';
  }

  /* ---------- 4. 数值 / 文本 ---------- */
  function groupThousands(s) { return s.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  /** 数值滚动：FX.roll(el, 32 * FX.eo(FX.c1(t,1.3,1.1)), 0, ' MB') */
  function roll(el, value, digits, suffix) {
    if (!el) return '';
    digits = digits == null ? 0 : digits | 0;
    suffix = suffix == null ? '' : suffix;
    const n = isFinite(Number(value)) ? Number(value) : 0;
    let s = Math.abs(n).toFixed(digits);
    if (digits === 0) s = groupThousands(s);
    const txt = (n < 0 ? '-' : '') + s + suffix;
    if (el.textContent !== txt) el.textContent = txt;
    return txt;
  }

  /** 打字机：p ∈ [0,1] → 前 round(p*len) 个字 */
  function typeOn(el, text, p) {
    if (!el) return '';
    p = clamp01(p);
    const s = String(text).slice(0, Math.round(String(text).length * p));
    if (el.textContent !== s) el.textContent = s;
    return s;
  }

  /* ---------- 5. 扫光（.glass::after 依赖） ---------- */
  function sweep(el, t, t0, dur) {
    if (!el) return;
    if (t < t0 || t > t0 + dur) {
      el.style.setProperty('--sweep-op', 0);
      el.style.setProperty('--sweep-bg', '-120% -120%');
      return;
    }
    const pos = -120 + ((t - t0) / (dur > 1e-9 ? dur : 1e-9)) * 240;
    el.style.setProperty('--sweep-bg', pos.toFixed(2) + '% ' + pos.toFixed(2) + '%');
    el.style.setProperty('--sweep-op', 1);
  }

  global.FX = {
    clamp, clamp01, lerp,
    eo, ei, eio, eob,
    c1, seg,
    pop, fade, fadeOut, fadeInOut, env,
    camAt, applyParallax,
    roll, typeOn,
    sweep,
  };
})(typeof window !== 'undefined' ? window : globalThis);
