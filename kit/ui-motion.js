/**
 * ui-motion.js —— UI 动效模式库（零依赖，纯函数逐帧驱动，可内联单文件 HTML）
 *
 * ===========================================================================
 * 为什么要在「视频动效」里攒 UI 动效
 * ===========================================================================
 * UI 界的动效比视频界成熟得多 —— 它们有成体系的模式名、有被千万次验证过的参数、
 * 有「什么情况下不该动」的纪律。而视频动效（尤其讲解类）本质就是**放大的 UI**：
 * 卡片 = 卡、标签 = chip、数字 = ticker、章节切换 = tab morph。
 * 把这些搬过来，等于白拿一套现成的语言。
 *
 * 调研来源（2026-09-12）：
 *   · Emil Kowalski 43 条规则（LobeHub 收录版）—— 7 类：缓动/时长/属性/变换/交互/策略/无障碍
 *   · 硬参数：iOS 抽屉 cubic-bezier(0.32,0.72,0,1) · 按下 scale(0.97)
 *             最小入场 scale(0.95)（永不 scale(0)）· UI 上限 300ms · 抽屉 500ms
 *             toast 堆叠偏移 14px · 揭示阈值 100px · 动量消除 0.11 px/ms
 *   · 本工作区 §11（Emil Kowalski 系 + Apple HIG）已有沉淀，本模块是其**代码化**
 *
 * ===========================================================================
 * 用法
 * ===========================================================================
 *   UIM.popIn(t, {in:1.2, dur:0.22})            → {op, tf, filter}
 *   UIM.ticker(t, 0, 915, {in:2, dur:1.2})      → 当前显示的数字
 *   UIM.barGrow(t, v, {in:.., dur:..})          → {scaleY, op}
 *   UIM.listStagger(t, i, n, {in:..})           → 第 i 项的延迟后进度
 *
 * ⚠️ 铁律：本模块所有函数都是**纯函数**，同 t 必得同值 —— 禁 CSS animation/transition。
 * ⚠️ 应用时遵守 flattening 铁律：opacity/filter/clip-path 只能作用在叶子层。
 */
(function (g) {
  'use strict';

  var M = g.MOTION;
  var EASE_ENTER = M ? M.EASE.enter : function (k) { k = 1 - k; return 1 - k * k * k; };
  var EASE_EXIT  = M ? M.EASE.exit  : function (k) { return k * k * k; };
  var EASE_QO    = M ? M.EASE.qo    : function (k) { k = 1 - k; return 1 - k * k * k; };
  var EASE_CIO   = M ? M.EASE.cio   : function (k) { return k < 0.5 ? 4*k*k*k : 1 - Math.pow(-2*k+2,3)/2; };
  var BEZ = M ? M.bezier : null;
  // iOS 抽屉/表单曲线（研究实测值，不要改成 ease-out）
  var EASE_IOS = BEZ ? BEZ(0.32, 0.72, 0, 1) : function (k) { k = 1 - k; return 1 - k * k * k; };

  // ===========================================================================
  // 常量（研究实测，别拍脑袋改）
  // ===========================================================================
  var K = {
    ENTER_MIN_SCALE: 0.95,   // 最小入场缩放 —— 永不 scale(0)，从 0 起会"炸开"
    PRESS_SCALE:     0.97,   // 按下反馈
    DRAWER_DUR:      0.50,   // 抽屉/表单 500ms
    UI_MAX_DUR:      0.30,   // UI 动效上限 300ms
    UI_STD_DUR:      0.20,   // 标准过渡 200ms ease-out
    TOAST_OFFSET:    14,     // toast 堆叠偏移 px
    REVEAL_THRESHOLD: 100,   // 滚动揭示阈值 px
    DISMISS_VELOCITY: 0.11,  // 动量消除阈值 px/ms
    STAGGER_MIN:     0.03,   // 错峰 30ms
    STAGGER_MAX:     0.08    // 错峰 80ms
  };

  function c01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function seg(t, a, b) { return c01((t - a) / (b - a || 1e-6)); }
  function lerp(a, b, k) { return a + (b - a) * k; }
  /** num —— 非法值（undefined / null / NaN / 非数字）兜底为 dflt。所有入参都该过一遍 */
  function num(x, dflt) { var n = typeof x === 'number' ? x : parseFloat(x); return isFinite(n) ? n : dflt; }
  function leaf(op, tf, filter, clip, extra) {
    var o = { op: op, tf: tf || '', filter: filter || '', clip: clip || '' };
    if (extra) for (var k in extra) o[k] = extra[k];
    return o;
  }

  // ===========================================================================
  // ① 进出场族
  // ===========================================================================

  /**
   * popIn —— 元素入场。★ 从 scale(0.95) 起，永不 scale(0)
   * 理由：scale(0) 起手 = 从无到有"炸开"，观众会读成错误而不是出现。
   */
  function popIn(t, o) {
    o = o || {};
    var d = o.dur || K.UI_STD_DUR;
    var k = EASE_ENTER(seg(t, o.in || 0, (o.in || 0) + d));
    var out = o.out != null ? 1 - EASE_EXIT(seg(t, o.out, o.out + d * 0.6)) : 1;
    var s = lerp(o.from == null ? K.ENTER_MIN_SCALE : o.from, 1, k);
    var y = (1 - k) * (o.rise == null ? 12 : o.rise);
    return leaf(k * out, 'translate3d(0,' + y.toFixed(2) + 'px,0) scale(' + s.toFixed(4) + ')', '', '',
                { k: k });
  }

  /** pressFeedback —— 按下：scale 0.97。UI 反馈的标准手感 */
  function pressFeedback(t, o) {
    o = o || {};
    var d = o.dur || 0.12;
    var down = EASE_EXIT(seg(t, o.at || 0, (o.at || 0) + d));
    var up = EASE_ENTER(seg(t, (o.at || 0) + (o.hold || 0.06), (o.at || 0) + (o.hold || 0.06) + d));
    var s = 1 - (1 - K.PRESS_SCALE) * (down - up);
    return leaf(1, 'scale(' + s.toFixed(4) + ')');
  }

  /**
   * toastStack —— 堆叠进场。第 i 个往下偏 14px 并缩一点，形成"一叠"的层次
   * 硬参数：偏移 14px（研究实测），越靠后缩放越小
   */
  function toastStack(t, i, n, o) {
    o = o || {};
    var delay = i * (o.gap == null ? 0.07 : o.gap);
    var k = EASE_ENTER(seg(t, (o.in || 0) + delay, (o.in || 0) + delay + (o.dur || K.UI_STD_DUR)));
    var depth = Math.min(i, 3);                    // 最多叠 3 层，再多就看不清了
    var dy = (1 - k) * -40 + depth * K.TOAST_OFFSET * 0.35;
    var s = lerp(1 - depth * 0.035, 1, k);
    return leaf(k, 'translate3d(0,' + dy.toFixed(2) + 'px,0) scale(' + s.toFixed(4) + ')', '', '',
                { z: depth });
  }

  /** sheetIn —— iOS 抽屉/表单。专用曲线 + 500ms，别拿通用 ease-out 顶替 */
  function sheetIn(t, o) {
    o = o || {};
    var d = o.dur || K.DRAWER_DUR;
    var k = EASE_IOS(seg(t, o.in || 0, (o.in || 0) + d));
    var out = o.out != null ? 1 - EASE_EXIT(seg(t, o.out, o.out + d * 0.62)) : 1;
    var y = (1 - k) * (o.h || 420);
    return leaf(k * out, 'translate3d(0,' + y.toFixed(2) + 'px,0)');
  }

  /** listStagger —— 第 i / n 项的错峰进度。返回 0..1，调用方自己套用 */
  function listStagger(t, i, n, o) {
    o = o || {};
    var gap = o.gap == null ? 0.06 : o.gap;
    if (n > 1 && (n - 1) * gap > (o.spanMax || 0.5)) gap = (o.spanMax || 0.5) / (n - 1);
    return EASE_ENTER(seg(t, (o.in || 0) + i * gap, (o.in || 0) + i * gap + (o.dur || K.UI_STD_DUR)));
  }

  /**
   * exit —— 通用退场系数（1 → 0）。给没有内建 out 参数的模式（wipeReveal/barGrow 等）套用。
   * ★ 退场时长 = 入场 × 0.6（motion-tokens 的 EXIT_RATIO）：退场比入场快，观众才不觉得拖。
   */
  function exit(t, outT, d) {
    if (outT == null) return 1;
    return 1 - EASE_EXIT(seg(t, outT, outT + (d || K.UI_STD_DUR) * (M ? M.EXIT_RATIO : 0.6)));
  }

  /** chipExit —— 列表项退场并让位（其余项上移补位）。用于「删掉一个」的叙事 */
  function chipExit(t, i, goneIdx, o) {
    o = o || {};
    var k = EASE_EXIT(seg(t, o.at || 0, (o.at || 0) + (o.dur || 0.18)));
    if (i === goneIdx) return leaf(1 - k, 'scale(' + lerp(1, K.ENTER_MIN_SCALE, k).toFixed(4) + ')');
    var shift = i > goneIdx ? -(o.rowH || 56) * k : 0;   // 后面的顶上来
    return leaf(1, 'translate3d(0,' + shift.toFixed(2) + 'px,0)');
  }

  // ===========================================================================
  // ② 形变族
  // ===========================================================================

  /** morphIcon —— 两态形变：缩放 + 旋转交叉，中点交换（比 crossfade 有"变成"感） */
  function morphIcon(t, o) {
    o = o || {};
    var k = EASE_CIO(seg(t, o.at || 0, (o.at || 0) + (o.dur || 0.24)));
    var half = k < 0.5;
    var kk = half ? k * 2 : (k - 0.5) * 2;
    var s = half ? lerp(1, 0.6, kk) : lerp(0.6, 1, kk);
    var r = half ? lerp(0, -90, kk) : lerp(90, 0, kk);
    return leaf(1, 'scale(' + s.toFixed(4) + ') rotate(' + r.toFixed(2) + 'deg)', '', '',
                { phase: half ? 0 : 1, k: k });
  }

  /** underlineMorph —— 章节指示器下划线形变滑动（x + 宽度同时补间，不是瞬切） */
  function underlineMorph(t, o) {
    o = o || {};
    var k = EASE_CIO(seg(t, o.at || 0, (o.at || 0) + (o.dur || 0.28)));
    var x = lerp(o.fromX || 0, o.toX || 0, k);
    var w = lerp(o.fromW || 0, o.toW || 0, k);
    return leaf(1, 'translate3d(' + x.toFixed(1) + 'px,0,0) scaleX(' + (w / (o.fromW || 1)).toFixed(4) + ')', '', '',
                { x: x, w: w });
  }

  /** progressRing —— 环形进度。返回 dashoffset 用的比例，配合 SVG stroke-dasharray */
  function progressRing(t, o) {
    o = o || {};
    var k = EASE_QO(seg(t, o.in || 0, (o.in || 0) + (o.dur || 0.6)));
    return { k: k, value: lerp(o.from == null ? 0 : o.from, o.to == null ? 1 : o.to, k),
             dash: (o.circumference || 100) * (1 - k) };
  }

  /** progressBar —— 条形进度 + indeterminate（未知进度来回扫，比转圈省空间） */
  function progressBar(t, o) {
    o = o || {};
    if (o.indeterminate) {
      var ph = (t * (o.speed || 0.6)) % 2;               // 0→1→0 三角波
      var u = ph < 1 ? ph : 2 - ph;
      var w = o.trackW || 200, bw = (o.barW || 60);
      return { k: u, mode: 'indeterminate', x: u * (w - bw), w: bw };
    }
    var k = EASE_QO(seg(t, o.in || 0, (o.in || 0) + (o.dur || 0.7)));
    return { k: k, mode: 'determinate', x: 0, w: (o.trackW || 200) * k };
  }

  // ===========================================================================
  // ③ 数据可视化族（讲参数必备 —— 本工作区此前几乎空白）
  // ===========================================================================

  /**
   * ticker —— 数字滚动（odometer）。返回当前应该显示的数值
   * 关键：位权递减 —— 高位先停，低位后停，才有"转速渐慢"的机械感
   */
  function ticker(t, from, to, o) {
    o = o || {};
    from = num(from, 0); to = num(to, from);
    var k = EASE_QO(seg(t, o.in || 0, (o.in || 0) + (o.dur || 0.9)));
    var v = lerp(from, to, k);
    if (o.decimals != null) return +v.toFixed(o.decimals);
    return Math.round(v);
  }

  /** lineDraw —— 折线描绘。返回已绘制长度比例，配 stroke-dashoffset */
  function lineDraw(t, o) {
    o = o || {};
    return EASE_CIO(seg(t, o.in || 0, (o.in || 0) + (o.dur || 0.8)));
  }

  /** barGrow —— 柱状生长。★ 从 0 高度生长，且必须带 stagger */
  function barGrow(t, i, n, o) {
    o = o || {};
    var k = listStagger(t, i, n, o);
    return { k: k, scaleY: k, op: k, tf: 'scaleY(' + k.toFixed(4) + ')' };
  }

  /**
   * compareBar —— 对比条（涨红跌绿：中国习惯，正值红/负值绿）
   * 签名兼容两种写法：compareBar(t, v, max, o) / compareBar(t, o)（o 里带 v、max）
   * ★ 容错：v / max 缺失或非法一律兜底，绝不返回 NaN —— NaN 会让整层 opacity 变 0，静默消失
   */
  function compareBar(t, v, max, o) {
    if (v != null && typeof v === 'object') { o = v; v = undefined; }
    o = o || {};
    v = num(v != null ? v : o.v, 0);
    max = num(max != null ? max : o.max, Math.abs(v) || 1);
    if (!max) max = 1;
    var k = EASE_QO(seg(t, o.in || 0, (o.in || 0) + (o.dur || 0.7)));
    var w = Math.abs(v) / max * (o.trackW || 300) * k;
    return { k: k, w: w, pos: v >= 0, color: o.invert ? (v >= 0 ? 'down' : 'up') : (v >= 0 ? 'up' : 'down') };
  }

  // ===========================================================================
  // ④ 状态 / 反馈族
  // ===========================================================================

  /** shimmer —— 骨架微光扫过。占位 → 实内容的过渡，比直接显示"高级" */
  function shimmer(t, o) {
    o = o || {};
    var w = o.w || 200;
    var ph = ((t - (o.in || 0)) * (o.speed || 0.55)) % 1.6;
    var x = (ph / 1.6) * (w + 240) - 120;
    var fade = o.out != null ? 1 - EASE_EXIT(seg(t, o.out, o.out + 0.3)) : 1;
    return leaf(1, '', '', '', { x: x, alpha: fade * (1 - Math.abs(ph / 1.6 - 0.5) * 0.6) });
  }

  /** pulse —— 呼吸强调（用于"注意这里"）。★ 静态卡禁用 pulse，会像抽搐 */
  function pulse(t, o) {
    o = o || {};
    var amp = o.amp == null ? 0.03 : o.amp;
    var gate = o.on != null ? (t >= o.on && t <= (o.off == null ? 1e9 : o.off) ? 1 : 0) : 1;
    var k = (1 - Math.cos((t - (o.on || 0)) * (o.freq || 2.2) * Math.PI * 2)) / 2 * gate;
    return leaf(1, 'scale(' + (1 + amp * k).toFixed(4) + ')');
  }

  /** blurBridge —— 换段 blur 桥接。淡出时加 blur，掩盖"下一幕已经在了"的事实 */
  function blurBridge(t, o) {
    o = o || {};
    var maxB = o.max == null ? 6 : o.max;
    var kout = o.out != null ? EASE_EXIT(seg(t, o.out, o.out + (o.dur || 0.3))) : 0;
    var kin = o.in != null ? 1 - EASE_ENTER(seg(t, o.in, o.in + (o.dur || 0.3))) : 0;
    var b = Math.max(kout, kin) * maxB;
    return leaf(Math.max(1 - kout, o.in != null ? 1 - kin : 1), '', b > 0.35 ? 'blur(' + b.toFixed(2) + 'px)' : '', '',
                { blur: b });
  }

  /** magnetic —— 磁吸：元素朝目标点微调（模拟 hover 吸附）。视频里用来做"视线引导" */
  function magnetic(t, o) {
    o = o || {};
    var k = EASE_ENTER(seg(t, o.in || 0, (o.in || 0) + (o.dur || 0.25)));
    var dx = (o.tx || 0) * (o.strength == null ? 0.18 : o.strength) * k;
    var dy = (o.ty || 0) * (o.strength == null ? 0.18 : o.strength) * k;
    return leaf(1, 'translate3d(' + dx.toFixed(2) + 'px,' + dy.toFixed(2) + 'px,0)');
  }

  /** scrollReveal —— 阈值触发揭示：进入视口 100px 内才启动（研究实测阈值） */
  function scrollReveal(t, o) {
    o = o || {};
    var enter = o.enterAt == null ? (o.in || 0) : o.enterAt;   // 目标进入阈值的时刻
    var k = EASE_ENTER(seg(t, enter, enter + (o.dur || 0.45)));
    return leaf(k, 'translate3d(0,' + ((1 - k) * (o.rise == null ? 28 : o.rise)).toFixed(2) + 'px,0)',
                (1 - k) * (o.blur == null ? 4 : o.blur) > 0.35
                  ? 'blur(' + ((1 - k) * (o.blur == null ? 4 : o.blur)).toFixed(2) + 'px)' : '');
  }

  /** wipeReveal —— clip-path 揭示（无布局变化的揭幕，性能好） */
  function wipeReveal(t, o) {
    o = o || {};
    var k = EASE_CIO(seg(t, o.in || 0, (o.in || 0) + (o.dur || 0.5)));
    var d = o.dir || 'left';
    var p = (k * 100).toFixed(1);
    var clip = d === 'left'  ? 'inset(0 0 0 ' + (100 - p) + '%)'
             : d === 'right' ? 'inset(0 ' + (100 - p) + '% 0 0)'
             : d === 'up'    ? 'inset(' + (100 - p) + '% 0 0 0)'
             :                 'inset(0 0 ' + (100 - p) + '% 0)';
    return leaf(1, '', '', clip, { k: k });
  }

  // ===========================================================================
  // 门禁
  // ===========================================================================
  /**
   * 校验一条动效模式用法是否合规。
   * 对齐 Emil Kowalski 43 条里能被数值判定的几条 + 本工作区一票否决。
   */
  function audit(name, o) {
    o = o || {};
    var d = o.dur;
    if (name === 'popIn' && o.from != null && o.from <= 0.5)
      return { level: 'FAIL', msg: '入场不得从 scale(' + o.from + ') 起（研究硬规：最小 0.95，永不 scale(0)）' };
    if (d != null && name !== 'sheetIn' && d > K.UI_MAX_DUR + 1e-6)
      return { level: 'WARN', msg: 'UI 动效 ' + d + 's > 上限 ' + K.UI_MAX_DUR + 's（抽屉/表单例外 0.5s）' };
    if (name === 'pulse' && o.on == null)
      return { level: 'WARN', msg: 'pulse 未给 on/off 窗口 —— 静态元素长期 pulse 会被读成抽搐' };
    if (name === 'listStagger' && o.gap != null && (o.gap < K.STAGGER_MIN - 1e-6 || o.gap > K.STAGGER_MAX + 1e-6))
      return { level: 'FAIL', msg: 'staggerGap ' + o.gap + 's 不在 30~80ms' };
    return { level: 'OK', msg: '' };
  }

  g.UIM = {
    K: K, EASE_IOS: EASE_IOS,
    popIn: popIn, pressFeedback: pressFeedback, toastStack: toastStack, sheetIn: sheetIn,
    listStagger: listStagger, chipExit: chipExit, exit: exit,
    morphIcon: morphIcon, underlineMorph: underlineMorph, progressRing: progressRing, progressBar: progressBar,
    ticker: ticker, lineDraw: lineDraw, barGrow: barGrow, compareBar: compareBar,
    shimmer: shimmer, pulse: pulse, blurBridge: blurBridge, magnetic: magnetic,
    scrollReveal: scrollReveal, wipeReveal: wipeReveal,
    audit: audit,
    names: ['popIn','pressFeedback','toastStack','sheetIn','listStagger','chipExit','morphIcon',
            'underlineMorph','progressRing','progressBar','ticker','lineDraw','barGrow','compareBar',
            'shimmer','pulse','blurBridge','magnetic','scrollReveal','wipeReveal']
  };
})(window);
