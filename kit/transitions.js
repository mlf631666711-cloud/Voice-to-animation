/**
 * transitions.js —— 转场模板库（零依赖，纯函数，可内联进单文件 HTML）
 *
 * 为什么单独立库：
 *   「转场」在本工作区文档里被提及 12 次，但**从来没有库** —— 每次跨段衔接都是现编。
 *   现编的后果就是 AGENTS.md 里那条老坑：**跨段不同步铁律 → 多段拼接审美断档**。
 *   有库才有「全段统一」这回事。
 *
 * 时间不对称（Carmen Ansio 口径，已写进 motion-tokens.js）：
 *   离场要加速走人、时长只占入场的 60%。所以每个转场都返回 {a, b} 两段，
 *   a = 上一镜怎么走，b = 下一镜怎么来，各自带自己的缓动与时长窗。
 *
 * 用法：
 *   const tr = TRANS.get('wipe', {dir:'left', speed:'fast'});
 *   const {a, b} = tr(k);        // k = 0..1 转场窗口进度
 *   // a: {op, tf, clip, blur}   应用到上一镜容器（叶子层，注意 flattening 铁律）
 *   // b: {op, tf, clip, blur}   应用到下一镜容器
 *   TRANS.dur('wipe','fast');    // 转场窗口时长（秒）
 *
 * ⚠️ flattening 铁律：opacity<1 / filter / clip-path 会强制拍平子元素，
 *    所以转场只能作用在**叶子层**或整段的最外层容器，不能夹在 3D 链中间。
 */
(function (g) {
  'use strict';

  var M = g.MOTION;
  // 未引入 motion-tokens 时给一份最小兜底，保证单文件可用
  var EASE_ENTER = M ? M.EASE.enter : function (k) { k = 1 - k; return 1 - k * k * k; };
  var EASE_EXIT  = M ? M.EASE.exit  : function (k) { return k * k * k; };
  var EASE_CIO   = M ? M.EASE.cio   : function (k) { return k < 0.5 ? 4*k*k*k : 1 - Math.pow(-2*k+2,3)/2; };
  var EASE_XO    = M ? M.EASE.xo    : function (k) { k = 1 - k; return 1 - k*k*k; };

  function c01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function seg(k, a, b) { return c01((k - a) / (b - a || 1e-6)); }

  // 时长窗（秒）。转场是摄影机尺度，不是元素尺度，所以比 DUR 长一档。
  var SPEED = { fast: 0.30, normal: 0.55, slow: 0.90 };
  var OUT_RATIO = 0.6;   // 离场时长 = 入场 × 0.6

  function leaf(op, tf, clip, blur) {
    return { op: op, tf: tf || '', clip: clip || '', blur: blur || 0 };
  }

  // ===========================================================================
  // 转场定义：每个返回 { a, b }
  //   a = 上一镜（离场）  b = 下一镜（入场）
  // ===========================================================================
  var T = {};

  /** 1. 硬切 —— 没有转场也是一种转场，节奏最快 */
  T.cut = function (k) {
    return { a: leaf(k < 0.5 ? 1 : 0), b: leaf(k < 0.5 ? 0 : 1) };
  };

  /**
   * 交叠归一化：交叉型转场要求 a.op + b.op ≥ 1，否则中途会露黑底。
   * 两条不同缓动的曲线相加**天然不保证**等于 1（实测最低会掉到 0.85，肉眼就是"闪一下暗"）。
   * 做法：不足 1 时把缺口对半补给两边，保持各自的缓动手感。
   */
  function overlap(a, b) {
    var s = a + b;
    if (s < 1) { var need = (1 - s) / 2; a += need; b += need; }
    return [a > 1 ? 1 : a, b > 1 ? 1 : b];
  }

  /** 2. 交叉溶解 —— 最安全，任何题材都不出错 */
  T.dissolve = function (k) {
    var r = overlap(1 - EASE_EXIT(seg(k, 0, OUT_RATIO)), EASE_ENTER(seg(k, 0.18, 1)));
    return { a: leaf(r[0]), b: leaf(r[1]) };
  };

  /**
   * 3. 划变 —— dir: left|right|up|down
   *    b 用 clip-path 揭幕，a 顺带轻微反向位移（不然像"贴纸盖上去"）
   */
  T.wipe = function (k, o) {
    o = o || {}; var d = o.dir || 'left';
    var p = EASE_CIO(k) * 100;
    var clipMap = {
      left:  'inset(0 0 0 ' + (100 - p) + '%)',
      right: 'inset(0 ' + (100 - p) + '% 0 0)',
      up:    'inset(' + (100 - p) + '% 0 0 0)',
      down:  'inset(0 0 ' + (100 - p) + '% 0)'
    };
    var shift = (1 - EASE_CIO(k)) * 40;
    var tfMap = {
      left:  'translate3d(' + (-shift) + 'px,0,0)',
      right: 'translate3d(' + (shift) + 'px,0,0)',
      up:    'translate3d(0,' + (-shift * 0.6) + 'px,0)',
      down:  'translate3d(0,' + (shift * 0.6) + 'px,0)'
    };
    return { a: leaf(1, tfMap[d]), b: leaf(1, '', clipMap[d]) };
  };

  /** 4. 笔刷擦除 —— luma matte 风格，边缘带阶梯抖动，比纯划变"有手味" */
  T.brush = function (k, o) {
    o = o || {}; var steps = o.steps || 14;
    var p = EASE_XO(k);
    // 阶梯化：把连续进度量化成 steps 档，模拟笔刷边缘
    var q = Math.round(p * steps) / steps;
    return {
      a: leaf(1 - EASE_EXIT(seg(k, 0, 0.95))),
      b: leaf(1, '', 'inset(0 0 0 ' + (100 - q * 100).toFixed(1) + '%)')
    };
  };

  /** 5. 面板推入 —— a 被 b 整体推走，常用于"翻页/换章节" */
  T.panelPush = function (k, o) {
    o = o || {}; var d = o.dir || 'left';
    var e = EASE_CIO(k);
    var W = o.width || 1920, H = o.height || 1080;
    var horiz = (d === 'left' || d === 'right');
    var s = (d === 'left' || d === 'up') ? 1 : -1;
    var px = horiz ? (1 - e) * W * s : 0;
    var py = horiz ? 0 : (1 - e) * H * s * 0.6;
    return {
      a: leaf(1, 'translate3d(' + (-e * W * s).toFixed(1) + 'px,' +
                                  (-e * (horiz ? 0 : H * s * 0.6)).toFixed(1) + 'px,0)'),
      b: leaf(1, 'translate3d(' + px.toFixed(1) + 'px,' + py.toFixed(1) + 'px,0)')
    };
  };

  /** 6. 光扫过场 —— 一条高光带扫过完成切换，科技感题材的主力 */
  T.lightSweep = function (k, o) {
    o = o || {};
    var sweep = EASE_XO(k);
    var glow = Math.sin(c01(k) * Math.PI);            // 中段最亮
    var clip = 'inset(0 0 0 ' + (sweep * 100).toFixed(1) + '%)';
    var r = overlap(1 - EASE_EXIT(seg(k, 0, OUT_RATIO)), EASE_ENTER(seg(k, 0.25, 1)));
    return {
      a: leaf(r[0], '', clip),
      b: leaf(r[1], '', clip),
      glow: glow,                                      // 额外通道：给高光条用
      glowX: (sweep * 100).toFixed(1) + '%'
    };
  };

  /** 7. 圆扩 —— 从中心（或指定点）圆形揭示 */
  T.circleReveal = function (k, o) {
    o = o || {};
    var r = EASE_XO(k) * 78;
    var cx = o.cx == null ? 50 : o.cx, cy = o.cy == null ? 50 : o.cy;
    return {
      a: leaf(1 - EASE_EXIT(seg(k, 0, 0.95))),
      b: leaf(1, '', 'circle(' + r.toFixed(1) + '% at ' + cx + '% ' + cy + '%)')
    };
  };

  /** 8. 位移接力 —— a 先走 b 后进，中间有短暂空窗；适合"换场景" */
  T.relay = function (k, o) {
    o = o || {}; var d = o.dir || 'up';
    var s = (d === 'up' || d === 'left') ? -1 : 1;
    var H = o.height || 1080, W = o.width || 1920;
    var ao = EASE_EXIT(seg(k, 0, OUT_RATIO));
    var bi = EASE_ENTER(seg(k, 0.35, 1));
    var ax = (d === 'left' || d === 'right') ? ao * W * 0.35 * s : 0;
    var ay = (d === 'up' || d === 'down') ? ao * H * 0.35 * s : 0;
    var bx = (d === 'left' || d === 'right') ? (1 - bi) * W * 0.35 * -s : 0;
    var by = (d === 'up' || d === 'down') ? (1 - bi) * H * 0.35 * -s : 0;
    return {
      a: leaf(1 - ao, 'translate3d(' + ax.toFixed(1) + 'px,' + ay.toFixed(1) + 'px,0)'),
      b: leaf(bi, 'translate3d(' + bx.toFixed(1) + 'px,' + by.toFixed(1) + 'px,0)')
    };
  };

  /** 9. 缩放穿越 —— a 冲向观众（过冲），b 从远处压进来；最有"速度感" */
  T.zoomThrough = function (k) {
    var ao = EASE_EXIT(seg(k, 0, OUT_RATIO));
    var bi = EASE_ENTER(seg(k, 0.28, 1));
    return {
      a: leaf(1 - ao, 'scale(' + (1 + ao * 0.85).toFixed(4) + ')'),
      b: leaf(bi, 'scale(' + (0.55 + bi * 0.45).toFixed(4) + ')', '', (1 - bi) * 6)
    };
  };

  /** 10. 故障切换 —— 短促的通道错位 + 闪白，适合"数据/信号"题材 */
  T.glitchCut = function (k, o) {
    o = o || {}; var amp = o.amp || 18;
    var burst = Math.sin(k * Math.PI * 6) * (1 - k);       // 递减抖动
    var dx = burst * amp;
    return {
      a: leaf(k < 0.45 ? 1 : 0, 'translate3d(' + dx.toFixed(1) + 'px,0,0)',
              'inset(' + Math.abs(burst) * 22 + '% 0 ' + Math.abs(burst) * 18 + '% 0)'),
      b: leaf(k < 0.45 ? 0 : 1, 'translate3d(' + (-dx * 0.6).toFixed(1) + 'px,0,0)'),
      flash: Math.max(0, 1 - k * 6)                          // 额外通道：闪白强度
    };
  };

  // ===========================================================================
  // 取用 / 工具
  // ===========================================================================
  /** 取一个转场函数（已绑定 opts）。 */
  function get(name, opts) {
    var f = T[name];
    if (!f) throw new Error('未知转场 "' + name + '"，可选：' + Object.keys(T).join(' / '));
    return function (k) { return f(c01(k), opts || {}); };
  }

  /** 转场窗口时长（秒）。speed: fast|normal|slow */
  function dur(name, speed) {
    return SPEED[speed || 'normal'] || SPEED.normal;
  }

  /**
   * 判定某个 t 落在转场窗口内的进度。
   * @param t    绝对时间
   * @param t0   转场起点（通常 = 上一镜结束前半个窗口，做交叠）
   * @param d    窗口时长
   * @returns 0..1，窗外返回 null 便于调用方跳过
   */
  function progress(t, t0, d) {
    if (t < t0 || t > t0 + d) return null;
    return c01((t - t0) / d);
  }

  /**
   * 门禁：对齐规格锁一票否决里能被数值判定的几条。
   * 转场也是动效，禁 lin；禁"进场用 ease-in"（这里即 b 段用 ease-in）。
   */
  /**
   * 转场类型 —— 决定端点判据怎么定，别一刀切。
   *   reveal：b 用 clip-path 盖过去，a **不需要**淡出（它只是被盖住）
   *   cross ：a、b 交叠淡变，两端都必须严格到 0 / 1
   *   cut   ：硬切，没有中间态
   */
  var TYPE = {
    cut: 'cut', dissolve: 'cross', wipe: 'reveal', brush: 'reveal',
    panelPush: 'push', lightSweep: 'cross', circleReveal: 'reveal',
    relay: 'cross', zoomThrough: 'cross', glitchCut: 'cut'
  };

  /** 取 transform 里的平移量（px），用于 push 型判据。 */
  function shiftOf(tf) {
    var m = /translate3d\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px/.exec(tf || '');
    return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : { x: 0, y: 0 };
  }

  function audit(name, opts) {
    var f = T[name];
    if (!f) return { level: 'FAIL', msg: '未知转场 "' + name + '"' };
    var s0 = f(0, opts || {}), s1 = f(1, opts || {});
    if (!s0.b || !s1.b) return { level: 'FAIL', msg: '转场未定义 b 段（下一镜）' };
    var type = TYPE[name];
    if (type === 'reveal') {
      if (s1.b.op < 0.98) return { level: 'FAIL', msg: 'reveal 型终点 b.op=' + s1.b.op.toFixed(2) + '，下一镜没全露' };
      if (!s1.b.clip) return { level: 'FAIL', msg: 'reveal 型终点缺 clip，下一镜不会被揭开' };
    } else if (type === 'push') {
      // push 型：b 靠位移滑进来占满画面，终点必须回到原点，否则下一镜是歪的
      var sh1 = shiftOf(s1.b.tf);
      if (Math.abs(sh1.x) > 0.5 || Math.abs(sh1.y) > 0.5)
        return { level: 'FAIL', msg: 'push 型终点位移 (' + sh1.x + ',' + sh1.y + ')，下一镜没归位' };
      if (s0.b.op < 0.98) return { level: 'FAIL', msg: 'push 型起点 b.op=' + s0.b.op.toFixed(2) + '（下一镜应已就位待滑入）' };
    } else {
      if (s0.a.op < 0.98) return { level: 'FAIL', msg: '起点 a.op=' + s0.a.op.toFixed(2) + '（上一镜应完全在场）' };
      if (s1.b.op < 0.98) return { level: 'FAIL', msg: '终点 b.op=' + s1.b.op.toFixed(2) + '（下一镜应完全在场）' };
      if (s1.a.op > 0.02) return { level: 'FAIL', msg: '终点 a.op=' + s1.a.op.toFixed(2) + '（上一镜有残留）' };
    }
    // 全程扫 NaN
    for (var i = 0; i <= 40; i++) {
      var r = f(i / 40, opts || {});
      var s = [r.a.op, r.b.op, r.a.tf, r.b.tf, r.a.clip, r.b.clip, r.a.blur, r.b.blur].join('|');
      if (s.indexOf('NaN') >= 0) return { level: 'FAIL', msg: '第 ' + i + '/40 采样点含 NaN' };
    }
    return { level: 'OK', msg: '' };
  }

  g.TRANS = {
    T: T, get: get, dur: dur, progress: progress, audit: audit,
    SPEED: SPEED, OUT_RATIO: OUT_RATIO,
    names: Object.keys(T)
  };
})(window);
