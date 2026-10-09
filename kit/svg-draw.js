/**
 * svg-draw.js —— SVG 自绘脚手架（零依赖，可内联单文件 HTML / 可被 node 直接 require）
 *
 * ===========================================================================
 * 为什么要有这个东西
 * ===========================================================================
 * 本工作区做视频常年卡在「缺素材」：要一个水表，要么上网找（版权 + 风格不统一），
 * 要么现画（每次从零写 SVG，画完跟上一版风格对不上）。
 * 这个库把「画一个表/一个芯片/一座基站」变成**调一个函数**，
 * 而且**风格由一套调色板统一管**，画出来天然跟同批素材一致。
 *
 * 参考风格：undraw 系（扁平 + 有限色 + 几何化）+ 本工作区手绘素材库既有风格
 * （400×400 viewBox / 深色 PCB / 接地投影 / 中文注释说明用途）。
 *
 * ===========================================================================
 * 用法
 * ===========================================================================
 *   // 浏览器（内联后）
 *   SVGDRAW.draw('meter-water', {size:400})              → '<svg …>…</svg>'
 *   document.getElementById('x').innerHTML = SVGDRAW.draw('chip');
 *
 *   // node
 *   const D = require('.../kit/svg-draw.js');
 *   fs.writeFileSync('water.svg', D.draw('meter-water'));
 *   node kit/draw_svg.js water --out water.svg
 *
 * ===========================================================================
 * ★★ 配色铁律：var() + fallback 双写
 * ===========================================================================
 * 全部颜色写成 `var(--c-ink, #0A0F1E)` 这种**双写**形式：
 *   · 内联进单文件 HTML → CSS 变量生效，跟主题走，check_theme 门禁不报警
 *   · 单独打开 .svg     → 浏览器不认 var，自动用 fallback，照样能看
 * 这是「素材要能独立预览」和「颜色不许硬编码」两个要求的唯一交集。
 * ⚠️ 别图省事直接写 #xxxxxx —— check_theme.js 会扫出来。
 *
 * ===========================================================================
 * ★★ 结构铁律
 * ===========================================================================
 *   · 一律 viewBox，不写 width/height（尺寸由外层 CSS 控制，才能被 3D transform 缩放）
 *   · 不引用外部字体/图片/脚本 —— 要能直接内联进单文件 HTML（离线铁律）
 *   · 不写 class 名以外的 id —— 内联多份会 id 撞车
 *   · 禁 CSS animation —— 动效一律由 window.__frame(t) 纯函数驱动
 */
(function (root, factory) {
  var lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  root.SVGDRAW = lib;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  // ==========================================================================
  // 调色板（var + fallback 双写）
  // ==========================================================================
  var C = {
    ink:      'var(--c-ink, #0A0F1E)',        // 主体深色（PCB / 设备外壳）
    ink2:     'var(--c-ink-2, #16223A)',      // 次深（层次 / 侧面）
    line:     'var(--c-line, rgba(180,220,255,.18))',   // 描边
    line2:    'var(--c-line-2, rgba(180,220,255,.55))', // 强调描边
    a1:       'var(--c-a1, #00E5D4)',         // 主强调（青绿）
    a2:       'var(--c-a2, #FF7A3C)',         // 次强调（橙）
    a3:       'var(--c-a3, #4DA3FF)',         // 第三色（蓝）
    paper:    'var(--c-paper, #FFFFFF)',      // 亮底（白棚场景用）
    paperInk: 'var(--c-paper-ink, #111827)',  // 亮底上的深字
    soft:     'var(--c-soft, rgba(180,220,255,.08))'    // 极淡填充（投影 / 玻璃）
  };

  // ==========================================================================
  // 基元（全部返回 SVG 片段字符串）
  // ==========================================================================
  function n(v) { return Math.round(v * 100) / 100; }
  function attrs(o) {
    var s = '';
    for (var k in o) if (o[k] != null && o[k] !== '') s += ' ' + k + '="' + o[k] + '"';
    return s;
  }
  function tag(name, o) { return '<' + name + attrs(o) + '/>'; }

  /** 画板包裹。w/h 只进 viewBox，不留 width/height —— 尺寸交给外层 CSS */
  function svg(body, o) {
    o = o || {};
    var s = o.size || 400;
    var w = o.w || s, h = o.h || s;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '"' +
           (o.cls ? ' class="' + o.cls + '"' : '') + '>' + body + '</svg>';
  }

  function rect(x, y, w, h, o) {
    o = o || {};
    return tag('rect', { x: n(x), y: n(y), width: n(w), height: n(h), rx: o.rx,
      fill: o.fill == null ? C.ink : o.fill,
      stroke: o.stroke, 'stroke-width': o.sw,
      opacity: o.op, transform: o.tf });
  }
  function circle(cx, cy, r, o) {
    o = o || {};
    return tag('circle', { cx: n(cx), cy: n(cy), r: n(r),
      fill: o.fill == null ? C.a1 : o.fill, stroke: o.stroke,
      'stroke-width': o.sw, opacity: o.op, transform: o.tf });
  }
  function ellipse(cx, cy, rx, ry, o) {
    o = o || {};
    return tag('ellipse', { cx: n(cx), cy: n(cy), rx: n(rx), ry: n(ry),
      fill: o.fill, stroke: o.stroke, 'stroke-width': o.sw, opacity: o.op });
  }
  /** 胶囊（标签底 / 引脚 / 管道） */
  function capsule(x, y, w, h, o) { return rect(x, y, w, h, Object.assign({ rx: h / 2 }, o || {})); }

  function line(x1, y1, x2, y2, o) {
    o = o || {};
    return tag('line', { x1: n(x1), y1: n(y1), x2: n(x2), y2: n(y2),
      stroke: o.stroke == null ? C.line2 : o.stroke,
      'stroke-width': o.sw == null ? 3 : o.sw,
      'stroke-linecap': o.cap || 'round',
      'stroke-dasharray': o.dash, opacity: o.op });
  }
  function polyline(pts, o) {
    o = o || {};
    return tag('polyline', {
      points: pts.map(function (p) { return n(p[0]) + ',' + n(p[1]); }).join(' '),
      fill: o.fill || 'none',
      stroke: o.stroke == null ? C.line2 : o.stroke,
      'stroke-width': o.sw == null ? 3 : o.sw,
      'stroke-linecap': o.cap || 'round', 'stroke-linejoin': o.join || 'round',
      'stroke-dasharray': o.dash, opacity: o.op });
  }
  function path(d, o) {
    o = o || {};
    return tag('path', { d: d, fill: o.fill || 'none',
      stroke: o.stroke, 'stroke-width': o.sw,
      'stroke-linecap': o.cap || 'round', opacity: o.op });
  }
  /** 极坐标圆弧（圆形进度 / 环形图 / 罗盘 类素材通用）—— 2026-09-13 追加
   *  ★ 角度约定：**12 点方向为 0°，顺时针为正**（跟肉眼直觉一致，不用管 SVG 的 y 向下）
   *    arcPath(200,200,139, 0,144)  → 从正上方顺时针扫 144°（= 40%）
   *  返回**单条** <path>（自带 fill="none"）—— 能被 lineDraw 类生长动效驱动
   *  a1 < a0 时按逆时针画（sweep=0）；跨度 >180° 自动置 large-arc-flag
   *  来源：DS-20260913-01 插画师反馈「基元表缺极坐标圆弧，圆形进度都得手写三角函数」
   */
  function arcPath(cx, cy, r, a0, a1, o) {
    o = o || {};
    var rad = function (deg) { return (deg - 90) * Math.PI / 180; };
    var x0 = cx + r * Math.cos(rad(a0)), y0 = cy + r * Math.sin(rad(a0));
    var x1 = cx + r * Math.cos(rad(a1)), y1 = cy + r * Math.sin(rad(a1));
    var span = Math.abs(a1 - a0);
    var large = span > 180 ? 1 : 0;
    var sweep = a1 >= a0 ? 1 : 0;
    var d = 'M ' + n(x0) + ' ' + n(y0) + ' A ' + n(r) + ' ' + n(r) + ' 0 ' +
            large + ' ' + sweep + ' ' + n(x1) + ' ' + n(y1);
    return path(d, Object.assign({ fill: 'none' }, o));
  }

  /** 箭头：返回一条带箭头的折线（含箭头两笔） */
  function arrow(x1, y1, x2, y2, o) {
    o = o || {};
    var a = Math.atan2(y2 - y1, x2 - x1), HL = o.head || 14, SP = 0.42;
    var s = line(x1, y1, x2, y2, o);
    s += line(x2, y2, x2 - Math.cos(a - SP) * HL, y2 - Math.sin(a - SP) * HL, o);
    s += line(x2, y2, x2 - Math.cos(a + SP) * HL, y2 - Math.sin(a + SP) * HL, o);
    return s;
  }
  /** 接地投影：白棚/深色场景都靠它建立「有地面」的物理感 */
  function shadow(cx, cy, rx, o) {
    o = o || {};
    return ellipse(cx, cy, rx, rx * (o.ry == null ? 0.08 : o.ry),
      { fill: o.fill == null ? C.soft : o.fill });
  }
  /** 芯片引脚：两侧等距排列 */
  function pins(x0, y0, w, h, count, o) {
    o = o || {};
    var pw = o.pw || 20, ph = o.ph || 12, gap = o.gap || 28, out = '';
    var top = y0 + (h - (count - 1) * gap - ph) / 2;
    for (var i = 0; i < count; i++) {
      var y = top + i * gap;
      out += rect(x0 - pw + 2, y, pw, ph, { rx: 2, fill: o.fill || C.line2 });
      out += rect(x0 + w - 2, y, pw, ph, { rx: 2, fill: o.fill || C.line2 });
    }
    return out;
  }
  /** 同心弧（信号波）。白底上禁止发光，靠描边粗细和透明度做层次 */
  function arcs(cx, cy, o) {
    o = o || {};
    var out = '', N = o.n || 4, r0 = o.r0 || 40, step = o.step || 46, ry = o.ry == null ? 0.42 : o.ry;
    for (var i = 0; i < N; i++) {
      out += ellipse(cx, cy, r0 + i * step, (r0 + i * step) * ry,
        { fill: 'none', stroke: o.stroke || C.a1, 'stroke-width': o.sw || 2,
          opacity: n((1 - i / N) * (o.op == null ? 0.55 : o.op)) });
    }
    return out;
  }
  /** 网格（面板/背景纹理） */
  function grid(x, y, w, h, o) {
    o = o || {};
    var s = o.step || 24, out = '';
    for (var gx = x; gx <= x + w; gx += s) out += line(gx, y, gx, y + h, { stroke: C.line, sw: 1 });
    for (var gy = y; gy <= y + h; gy += s) out += line(x, gy, x + w, gy, { stroke: C.line, sw: 1 });
    return out;
  }
  /** 文字。font-family 只给系统字体栈 —— 禁外部字体（离线铁律） */
  function text(x, y, str, o) {
    o = o || {};
    return '<text x="' + n(x) + '" y="' + n(y) + '"' +
      ' font-family="PingFang SC, Microsoft YaHei, system-ui, sans-serif"' +
      ' font-size="' + (o.size || 24) + '"' +
      ' font-weight="' + (o.weight || 600) + '"' +
      ' text-anchor="' + (o.anchor || 'middle') + '"' +
      ' fill="' + (o.fill || C.paperInk) + '"' +
      (o.ls ? ' letter-spacing="' + o.ls + '"' : '') +
      (o.op != null ? ' opacity="' + o.op + '"' : '') + '>' + str + '</text>';
  }

  // ==========================================================================
  // 图案库（recipes）—— 每个返回 {svg, note}
  // 命名：<类别>-<对象>。加新图案只改这里，CLI 和画廊自动收录。
  // ==========================================================================
  var R = {};

  /* ---- 模组 / 芯片 ---------------------------------------------------- */

  /** 通用模组：PCB 基板 + 屏蔽罩 + 引脚 */
  R['chip'] = function (o) {
    o = o || {};
    var b = '';
    b += shadow(200, 330, 150);
    b += pins(40, 110, 320, 180, 7);
    b += rect(40, 110, 320, 180, { rx: 18, fill: C.ink, stroke: C.line, sw: 2 });
    b += rect(72, 138, 256, 124, { rx: 10, fill: C.ink2, stroke: C.line, sw: 2 });
    b += rect(96, 162, 96, 76, { rx: 6, fill: C.a1, op: 0.9 });
    b += rect(208, 162, 96, 76, { rx: 6, fill: C.a2, op: 0.85 });
    b += line(200, 150, 200, 250, { stroke: C.line, sw: 2 });
    return { svg: svg(b, o), note: '通用模组：PCB 基板 + 屏蔽罩 + 双侧引脚' };
  };

  /** 二合一模组：中缝分隔 + 左右双色丝印（蓝牙 / RF） */
  R['chip-merged'] = function (o) {
    o = o || {};
    var b = '';
    b += shadow(200, 326, 152);
    b += pins(30, 96, 340, 208, 7);
    b += rect(30, 96, 340, 208, { rx: 18, fill: C.ink, stroke: C.line, sw: 2 });
    // 左半：蓝牙 rune
    b += path('M 108 150 L 108 250 L 158 200 L 128 200 L 158 250 L 108 300',
      { stroke: C.a1, sw: 7, fill: 'none' });
    // 右半：天线符号
    b += line(292, 300, 292, 236, { stroke: C.a2, sw: 7 });
    b += circle(292, 226, 12, { fill: C.a2 });
    b += path('M 262 208 A 42 42 0 0 1 322 208', { stroke: C.a2, sw: 6 });
    b += path('M 246 190 A 66 66 0 0 1 338 190', { stroke: C.a2, sw: 6, op: 0.55 });
    b += line(200, 110, 200, 290, { stroke: C.line, sw: 2 });
    return { svg: svg(b, o), note: '二合一模组：中缝分隔 + 左蓝牙 rune / 右天线符号' };
  };

  /* ---- 表计 ------------------------------------------------------------ */

  /** 三表通用：表体 + 表盘 + 计数窗 + 管道。kind 决定表盘符号 */
  var METER_CN = { water: '水', power: '电', gas: '气' };
  function meter(kind, o) {
    o = o || {};
    var color = kind === 'water' ? C.a3 : kind === 'power' ? C.a2 : C.a1;
    var b = '';
    b += shadow(200, 372, 118);
    b += rect(182, 298, 36, 58, { rx: 4, fill: C.ink2 });          // 下管道
    b += rect(168, 288, 64, 16, { rx: 4, fill: C.ink });
    b += rect(120, 96, 160, 196, { rx: 22, fill: C.ink, stroke: C.line, sw: 2 });
    b += rect(136, 112, 128, 168, { rx: 14, fill: C.ink2 });
    b += circle(200, 156, 40, { fill: color, op: 0.16 });
    b += circle(200, 156, 40, { fill: 'none', stroke: color, sw: 4 });
    // 表盘符号
    if (kind === 'water') {
      b += path('M 200 132 L 182 164 L 200 164 L 200 180 L 218 148 L 200 148 Z', { fill: color });
    } else if (kind === 'power') {
      b += path('M 206 126 L 178 162 L 198 162 L 190 186 L 222 148 L 200 148 Z', { fill: color });
    } else {
      b += path('M 176 172 C 176 144 224 144 224 168 C 224 186 200 178 200 192',
        { stroke: color, sw: 6, fill: 'none' });
    }
    b += rect(152, 212, 96, 44, { rx: 6, fill: C.ink, stroke: C.line, sw: 2 });   // 计数窗
    for (var i = 0; i < 5; i++) {
      b += rect(160 + i * 18, 222, 12, 24, { rx: 2, fill: C.line2, op: i === 4 ? 0.4 : 0.8 });
    }
    b += rect(182, 76, 36, 26, { rx: 4, fill: C.ink2 });            // 上接口
    return { svg: svg(b, o), note: METER_CN[kind] + '表：表体 + 表盘 + 计数窗 + 管道' };
  }
  R['meter-water'] = function (o) { return meter('water', o); };
  R['meter-power'] = function (o) { return meter('power', o); };
  R['meter-gas']   = function (o) { return meter('gas', o); };

  /* ---- 通信 / 网络 ----------------------------------------------------- */

  /** 基站：桅杆 + 三横担 + 头部 + 三层信号弧 */
  R['station'] = function (o) {
    o = o || {};
    var b = '';
    b += shadow(200, 376, 96);
    b += rect(190, 120, 20, 250, { rx: 6, fill: C.ink });                 // 桅杆
    b += line(120, 170, 280, 170, { stroke: C.ink, sw: 14 });             // 横担
    b += line(140, 224, 260, 224, { stroke: C.ink, sw: 12 });
    b += line(160, 272, 240, 272, { stroke: C.ink, sw: 10 });
    b += rect(176, 96, 48, 40, { rx: 8, fill: C.ink2, stroke: C.line, sw: 2 });
    b += circle(200, 116, 6, { fill: C.a1 });
    b += arcs(200, 116, { n: 3, r0: 46, step: 40, ry: 0.62, stroke: C.a1, sw: 3 });
    return { svg: svg(b, o), note: '基站：桅杆 + 三横担 + 头部 + 信号弧' };
  };

  /** 星型拓扑：中心节点 + N 个卫星节点 + 连线 */
  R['star-topo'] = function (o) {
    o = o || {};
    var N = o.nodes || 6, b = '', cx = 200, cy = 200, Rr = 132;
    for (var i = 0; i < N; i++) {
      var a = -Math.PI / 2 + i * 2 * Math.PI / N;
      var x = cx + Math.cos(a) * Rr, y = cy + Math.sin(a) * Rr;
      b += line(cx, cy, x, y, { stroke: C.line2, sw: 2.5, dash: '6 6' });
      b += circle(x, y, 22, { fill: C.ink2, stroke: C.a1, sw: 3 });
    }
    b += circle(cx, cy, 34, { fill: C.a1 });
    b += circle(cx, cy, 54, { fill: 'none', stroke: C.a1, sw: 3, op: 0.5 });
    return { svg: svg(b, o), note: '星型拓扑：中心节点 + ' + N + ' 个卫星节点' };
  };

  /** 双端测距尺：基线 + 两端刻度 + 双向箭头（L10「最远传输距离」用） */
  R['dim-ruler'] = function (o) {
    o = o || {};
    var b = '';
    b += line(60, 200, 340, 200, { stroke: C.line2, sw: 3 });
    b += line(60, 170, 60, 230, { stroke: C.line2, sw: 4 });
    b += line(340, 170, 340, 230, { stroke: C.line2, sw: 4 });
    b += arrow(76, 200, 130, 200, { stroke: C.a1, sw: 4, head: 16 });
    b += arrow(324, 200, 270, 200, { stroke: C.a1, sw: 4, head: 16 });
    b += circle(200, 200, 12, { fill: C.a1 });
    return { svg: svg(b, o), note: '双端测距尺：基线 + 两端刻度 + 双向箭头' };
  };

  /* ---- 终端 / 概念 ----------------------------------------------------- */

  /** 手机：机身 + 屏幕 + 底部指示条 */
  R['phone'] = function (o) {
    o = o || {};
    var b = '';
    b += shadow(200, 366, 108);
    b += rect(122, 40, 156, 320, { rx: 30, fill: C.ink, stroke: C.line, sw: 2 });
    b += rect(136, 60, 128, 280, { rx: 18, fill: C.ink2 });
    b += rect(176, 48, 48, 8, { rx: 4, fill: C.line2, op: 0.5 });
    b += rect(172, 330, 56, 8, { rx: 4, fill: C.line2, op: 0.6 });
    b += circle(200, 190, 34, { fill: C.a1, op: 0.9 });
    return { svg: svg(b, o), note: '手机：机身 + 屏幕 + 底部指示条' };
  };

  /** 云端：三段圆弧组成的云 */
  R['cloud'] = function (o) {
    o = o || {};
    var b = '';
    b += circle(150, 200, 46, { fill: C.ink2 });
    b += circle(200, 168, 58, { fill: C.ink2 });
    b += circle(258, 202, 44, { fill: C.ink2 });
    b += rect(150, 200, 108, 46, { rx: 6, fill: C.ink2 });
    b += circle(200, 168, 58, { fill: 'none', stroke: C.a1, sw: 3, op: 0.6 });
    return { svg: svg(b, o), note: '云端：三段圆弧 + 底托' };
  };

  /** 波形：折线（配 lineDraw 做描绘动效） */
  R['waveform'] = function (o) {
    o = o || {};
    var b = '', N = o.n || 9;
    for (var i = 0; i < N; i++) {
      var h = 40 + Math.abs(Math.sin(i * 1.3)) * 130;
      b += capsule(40 + i * 36, 200 - h / 2, 14, h, { fill: C.a1, op: 0.35 + (i % 3) * 0.2 });
    }
    b += line(30, 200, 370, 200, { stroke: C.line, sw: 2 });
    return { svg: svg(b, o), note: '波形：' + N + ' 根柱（配 barGrow 做生长动效）' };
  };

  /** 白底产品页用的「引注标签」：胶囊 + 色点（不承载主题，纯结构示例） */
  R['callout-chip'] = function (o) {
    o = o || {};
    var b = '';
    b += capsule(20, 160, 360, 80, { fill: C.paper, stroke: C.soft, sw: 3 });
    b += circle(66, 200, 14, { fill: C.a1 });
    b += text(230, 212, o.label || '引注标签', { size: 34, fill: C.paperInk });
    return { svg: svg(b, o), note: '引注标签：胶囊 + 色点（白底产品页用）' };
  };

  /* ---- 指标 / 数据 ------------------------------------------------------ */

  /**
   * 圆环进度表（性能 / 指标可视化）。
   * 轨道环 + 从 12 点起顺时针 40%（144°）的进度弧 + 环外 12 根刻度；
   * 中心完全留空，百分比数字由片子里用 HTML 叠上去（所以同一个元件能复用在不同数值上）。
   * 进度弧是**单条连续 path**，可被 lineDraw 逐笔描绘动效驱动着长出来。
   */
  R['gauge-ring'] = function (o) {
    o = o || {};
    var cx = 200, cy = 200, R0 = 139, BW = 22, PCT = 0.4, b = '';
    /** 极坐标 → 直角坐标（0° = 12 点方向，顺时针为正） */
    function pt(deg, r) {
      var a = (deg - 90) * Math.PI / 180;
      return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    }
    // ① 轨道：整圈底环（暗色），表示「总量」，外/内半径 = 150 / 128
    b += circle(cx, cy, R0, { fill: 'none', stroke: C.ink2, sw: BW });
    // ② 进度弧：单条连续 path，12 点起顺时针 144°(=40%)；cap=butt 保证起点恰好落在正上方
    var p0 = pt(0, R0), p1 = pt(360 * PCT, R0);
    b += path('M ' + n(p0[0]) + ' ' + n(p0[1]) +
      ' A ' + R0 + ' ' + R0 + ' 0 0 1 ' + n(p1[0]) + ' ' + n(p1[1]),
      { stroke: C.a1, sw: BW, cap: 'butt' });
    // ③ 端帽：弧末端圆头，比弧略粗（r=12 > 半环宽 11）
    //    端帽整体外移 1px：r=12 若居中，内沿会落到 127 < 环内径 128，就侵入"中心完全留空"了
    var capC = pt(360 * PCT, R0 + 1);
    b += circle(capC[0], capC[1], 12, { fill: C.a1 });
    // ④ 刻度：环外 12 根，每 30° 一根；12 点那根略长 + 加粗提亮
    //    径向只能走到 160（外半径 150 + 四周 40px 净空 = 上限 160），所以靠对比度而非长度做辨识
    for (var i = 0; i < 12; i++) {
      var isTop = i === 0;
      var q0 = pt(i * 30, 150), q1 = pt(i * 30, isTop ? 160 : 158);
      b += line(q0[0], q0[1], q1[0], q1[1],
        { stroke: C.line2, sw: isTop ? 4 : 3, cap: 'butt', op: isTop ? 1 : 0.85 });
    }
    return { svg: svg(b, o), note: '圆环进度表：轨道环 + 12 点起 40%(144°) 进度弧 + 12 刻度，中心留空' };
  };

  // ==========================================================================
  // 对外
  // ==========================================================================
  function draw(name, o) {
    var f = R[name];
    if (!f) throw new Error('未知道具图案: ' + name + '（可选：' + Object.keys(R).join(', ') + '）');
    return f(o || {}).svg;
  }
  function note(name) { return R[name] ? R[name]({}).note : ''; }
  function names() { return Object.keys(R); }

  return {
    C: C,
    svg: svg, rect: rect, capsule: capsule, circle: circle, ellipse: ellipse,
    line: line, polyline: polyline, path: path, arcPath: arcPath, arrow: arrow,
    shadow: shadow, pins: pins, arcs: arcs, grid: grid, text: text,
    draw: draw, note: note, names: names, recipes: R
  };
});
