/**
 * motion-tokens.js —— 动效 Token 三层体系（零依赖，纯函数，可内联进单文件 HTML）
 *
 * 三层结构（调研来源：Carmen Ansio《Motion Tokens for Design Systems》2026-04）：
 *
 *   ① primitives  原始值 —— 时长刻度 + 缓动词汇，还没组合
 *   ② semantics   语义别名 ——「进入 / 退场 / 反馈」成对，开发只思考意图不思考毫秒
 *   ③ 组件引用     .card { ... MOTION.cardIn }
 *
 * 为什么必须有 exit：
 *   进入要减速到位（它在抵达），离开要加速走人（它在让位）。
 *   同一条缓动同时用在进出 = 观众会觉得退场"恋恋不舍"。
 *   **exit 时长 ≈ enter 的 60%**（Carmen Ansio 口径）。
 *
 * 与规格锁 §5.11 的对齐点：
 *   单元素 150~300ms / 大位移 ≤600ms / staggerGap 30~80ms / 整组 ≤500ms
 *   高频元素(≥3次) 150~250ms / 大小元素时长比 ≥1.5:1
 *   三条强曲线 qo(0.22,1,0.36,1) · xo(0.16,1,0.3,1) · cio(0.65,0,0.35,1)
 *
 * 用法：
 *   MOTION.elemIn.d            // 0.22
 *   MOTION.elemIn.ease(0.5)    // 缓动函数，入 0..1 出 0..1
 *   MOTION.cssVars()           // 导出 CSS 变量串（配合 Theme Pack 用）
 *   MOTION.audit(el.d, 'qo')   // 门禁：返回 {level, msg}
 */
(function (g) {
  'use strict';

  // ==========================================================================
  // ① primitives —— 时长刻度（秒）
  // ==========================================================================
  // 为什么是这 6 档：规格锁 §5.11 给的是「150~300ms 区间」，区间不能当刻度用。
  // 取中位 0.22 作 base，上下各铺两档，覆盖「微反馈 → 英雄级入场」。
  var DUR = {
    micro:     0.10,   // 图标点一下、数值跳动（下限，再短就看不见了）
    fast:      0.15,   // 规格锁下沿；高频元素(≥3次)的专属档
    base:      0.22,   // ★ 默认。区间中位，绝大多数元素用这档
    slow:      0.30,   // 规格锁上沿；大元素、需要被读清的卡
    hero:      0.50,   // 主视觉入场、整组 stagger 的上限
    maxMove:   0.60    // 大位移硬上限，超过就是「拖沓」（规格锁：大位移 ≤600ms）
  };

  // 摄影机是另一套刻度（低频·大尺度，禁止与元素共用 —— 规格锁 §5.10 vs §5.11）
  var DUR_CAM = {
    snap:  0.55,   // snapZoom 冲（School of Motion 6 帧猛推）
    quick: 0.90,
    push:  1.60,   // 标准推镜
    slow:  3.00    // 长距离飞行
  };

  // 错峰：staggerGap 30~80ms（规格锁）
  var GAP = { tight: 0.03, base: 0.06, loose: 0.08 };
  var GROUP_MAX = 0.50;          // 整组 stagger 总时长硬上限
  var SIZE_RATIO_MIN = 1.5;      // 大小元素时长比下限

  // ==========================================================================
  // ① primitives —— 缓动词汇
  // ==========================================================================
  // cubic-bezier 精确解（牛顿迭代 + 二分兜底），保证与 CSS 端数值完全一致。
  function bezier(x1, y1, x2, y2) {
    function cx(t) { return 3*(1-t)*(1-t)*t*x1 + 3*(1-t)*t*t*x2 + t*t*t; }
    function cy(t) { return 3*(1-t)*(1-t)*t*y1 + 3*(1-t)*t*t*y2 + t*t*t; }
    function dx(t) {
      return 3*(1-t)*(1-t)*x1 + 6*(1-t)*t*(x2-x1) + 3*t*t*(1-x2);
    }
    return function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      var t = x, i, d;
      for (i = 0; i < 5; i++) {                 // 牛顿迭代，5 次足够 1e-6
        d = dx(t);
        if (Math.abs(d) < 1e-6) break;
        var e = cx(t) - x;
        if (Math.abs(e) < 1e-7) break;
        t -= e / d;
      }
      if (t < 0 || t > 1) {                     // 兜底二分
        var lo = 0, hi = 1; t = x;
        for (i = 0; i < 20; i++) {
          t = (lo + hi) / 2;
          if (cx(t) < x) lo = t; else hi = t;
        }
      }
      return cy(t);
    };
  }

  // 三条强曲线（规格锁 §5.11 原文数值，不是近似）
  var QO  = bezier(0.22, 1, 0.36, 1);   // 强减速 —— 元素入场主力
  var XO  = bezier(0.16, 1, 0.30, 1);   // 暴冲后极缓收尾 —— 需要"重量感"的入场
  var CIO = bezier(0.65, 0, 0.35, 1);   // 对称 in-out —— 位移、运镜

  // UI 语义曲线（Carmen Ansio 口径，与上面三条并存不冲突）
  var EASE_ENTER = bezier(0.0, 0, 0.2, 1);        // 到达：减速
  var EASE_EXIT  = bezier(0.4, 0, 1, 1);          // 离开：加速
  var EASE_STD   = bezier(0.4, 0, 0.2, 1);        // 通用
  var EASE_SPRING= bezier(0.34, 1.56, 0.64, 1);   // 正反馈专用

  function lin(k) { return k; }
  function ei(k) { return k * k * k; }
  function eo(k) { k = 1 - k; return 1 - k * k * k; }
  function eio(k) { return k < 0.5 ? 4*k*k*k : 1 - Math.pow(-2*k+2, 3)/2; }
  function snapo(k, ov) {
    ov = ov == null ? 0.06 : ov;
    if (k < 0.72) { var u = k / 0.72; return (1 + ov) * (1 - Math.pow(1 - u, 3)); }
    return (1 + ov) - ov * eio((k - 0.72) / 0.28);
  }

  var EASE = {
    lin: lin, ei: ei, eo: eo, eio: eio,
    qo: QO, xo: XO, cio: CIO,
    enter: EASE_ENTER, exit: EASE_EXIT, std: EASE_STD, spring: EASE_SPRING,
    snapo: snapo
  };

  // ==========================================================================
  // ② semantics —— 语义配对（enter / exit 成对，exit = 60% enter）
  // ==========================================================================
  var EXIT_RATIO = 0.6;

  function pair(dIn, easeIn) {
    return {
      d: dIn, ease: easeIn,
      dOut: +(dIn * EXIT_RATIO).toFixed(3), easeOut: EASE_EXIT,
      /** 供 JS 逐帧用：给进度 0..1，返回缓动后的值 */
      at: function (k) { return easeIn(k < 0 ? 0 : k > 1 ? 1 : k); },
      atOut: function (k) { return EASE_EXIT(k < 0 ? 0 : k > 1 ? 1 : k); }
    };
  }

  var MOTION = {
    // 元素级（规格锁 §5.11）
    micro:  pair(DUR.micro, QO),    // 图标/数值，短到几乎看不见
    elem:   pair(DUR.base,  QO),    // ★ 默认元素入场
    elemHi: pair(DUR.fast,  QO),    // 高频元素（≥3 次）—— 必须更短更克制
    card:   pair(DUR.slow,  QO),    // 信息卡，需要被读清
    hero:   pair(DUR.hero,  XO),    // 主视觉，带重量感
    move:   pair(DUR.maxMove, CIO), // 大位移（对称缓动，不用 ease-out）

    // 摄影机级（规格锁 §5.10，与元素严格分开）
    camSnap: pair(DUR_CAM.snap,  snapo),
    camPush: pair(DUR_CAM.push,  CIO),
    camFly:  pair(DUR_CAM.slow,  CIO),

    // 反馈语义（曲线携带意义：spring 只给正反馈）
    ok:      pair(DUR.base, EASE_SPRING),
    err:     pair(DUR.base, EASE_STD),
    sys:     pair(DUR.micro, lin)
  };

  // ==========================================================================
  // 工具
  // ==========================================================================
  /** 一组 n 个元素的 stagger 总时长（自动夹在 GROUP_MAX 内）。 */
  function staggerSpan(n, gap) {
    gap = gap == null ? GAP.base : gap;
    return Math.min((n - 1) * gap, GROUP_MAX);
  }

  /** 第 i 个元素的错峰延迟。gap 自动收紧以满足整组上限。 */
  function staggerDelay(i, n, gap) {
    gap = gap == null ? GAP.base : gap;
    if (n > 1 && (n - 1) * gap > GROUP_MAX) gap = GROUP_MAX / (n - 1);
    return i * gap;
  }

  /**
   * 门禁：对齐规格锁「一票否决 7 条」里能被数值判定的几条。
   * @returns {level:'FAIL'|'WARN'|'OK', msg}
   */
  function audit(d, easeName, opts) {
    opts = opts || {};
    var role = opts.role || 'elem';          // 'elem' | 'cam'
    if (easeName === 'lin' && role === 'elem')
      return { level: 'FAIL', msg: '元素动效禁 lin（廉价感头号来源）' };
    if ((easeName === 'ei' || easeName === 'qi' || easeName === 'xi') && role === 'elem')
      return { level: 'FAIL', msg: '进场禁 ease-in（观众会读到"迟疑"）' };
    var cap = role === 'cam' ? 999 : DUR.maxMove;
    if (d > cap + 1e-6)
      return { level: 'FAIL', msg: '元素动效 ' + d + 's > 上限 ' + cap + 's（>700ms 一票否决）' };
    if (role === 'elem' && d < 0.08)
      return { level: 'WARN', msg: '时长 ' + d + 's 过短，30fps 下不足 3 帧，会看成瞬移' };
    if (opts.dBig && d && opts.dBig / d < SIZE_RATIO_MIN)
      return { level: 'WARN', msg: '大小元素时长比 < ' + SIZE_RATIO_MIN + ':1，层次会糊' };
    return { level: 'OK', msg: '' };
  }

  /** 导出 CSS 变量串（配合 Theme Pack：颜色管主题，这里管节奏）。 */
  function cssVars(prefix) {
    var p = prefix || 'mt';
    var out = [];
    for (var k in DUR) out.push('--' + p + '-dur-' + k + ':' + DUR[k] + 's');
    for (var m in GAP) out.push('--' + p + '-gap-' + m + ':' + GAP[m] + 's');
    out.push('--' + p + '-dur-elem-in:' + MOTION.elem.d + 's');
    out.push('--' + p + '-dur-elem-out:' + MOTION.elem.dOut + 's');
    return out.join(';');
  }

  g.MOTION = {
    DUR: DUR, DUR_CAM: DUR_CAM, GAP: GAP,
    GROUP_MAX: GROUP_MAX, EXIT_RATIO: EXIT_RATIO, SIZE_RATIO_MIN: SIZE_RATIO_MIN,
    EASE: EASE, QO: QO, XO: XO, CIO: CIO, bezier: bezier,
    MOTION: MOTION, pair: pair,
    staggerSpan: staggerSpan, staggerDelay: staggerDelay,
    audit: audit, cssVars: cssVars
  };
})(window);
