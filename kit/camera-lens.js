/**
 * camera-lens.js —— 摄影机「光学层」：镜头参数 + 胶片模拟 + 镜头效果
 *
 * 与 camera3d.js 的分工：
 *   camera3d.js   —— 几何：机位、朝向、Zoom、透视矩阵（3D 空间怎么摆）
 *   camera-lens.js —— 光学：焦距/光圈/F 值/景深、胶片曲线、颗粒、暗角、光晕（画面看起来像什么）
 *
 * ---------------------------------------------------------------------------
 * ⚠⚠ 头号铁律：滤镜只能加在 2D 包装层，绝不能加进 3D 链
 * ---------------------------------------------------------------------------
 * CSS 的 `filter` 会强制 flattening（把子元素的 3D 空间拍平）。
 * 一旦把 filter 加在 #viewport / #camera / #world 上，整个 3D 场景立刻塌成 2D。
 *
 * 正确结构（把色彩分级放在 3D 链「外面」的 2D 层，等价于 AE 最顶层的调整图层）：
 *
 *   #screen      ← ✅ 胶片 filter / halation / 暗角 / 颗粒 全部加在这里（2D，安全）
 *     #viewport  ← perspective 在这里（3D 起点）
 *       #camera  ← 摄影机逆矩阵
 *         #world ← 3D 图层
 *
 * ---------------------------------------------------------------------------
 * 单位换算（AE 兼容）
 * ---------------------------------------------------------------------------
 *   mm_per_px = filmW_mm / compW_px          （35mm 全画幅：36/1920 = 0.01875）
 *   zoom_px   = focal_mm / mm_per_px         ≡ camera3d.focalToZoom()
 *   例：50mm @ 1920 → 2667px
 *
 * 景深用薄透镜弥散圆（Circle of Confusion）公式，全部可在像素域直接算：
 *   CoC_px = |S2 - S1| / S2 · f_px² / (N · (S1_px − f_px))
 *   f_px = zoom（焦距，像素）  N = F 值  S1 = 对焦距离  S2 = 物距
 *   blur 半径 = CoC_px / 2
 * 注意 S1 必须 > f_px，否则公式发散（物理上也是对焦距离不能小于焦距）。
 *
 * 用法：
 *   CAMLENS.injectSVG();                       // 注入所有胶片 filter 定义
 *   CAMLENS.applyFilm('kodak-portra-400');     // 给 #screen 上滤镜
 *   const b = CAMLENS.blur(dist, {focal:50, fstop:1.8}, 1920, focusPx);
 */

(function (g) {
  'use strict';

  // ⚠️ IDENT / lin 必须在 FILMS 之前定义：digital-clean 的 matrix 直接引用 IDENT，
  //    放在后面会被 var hoisting 成 undefined（SVG 滤镜链当场炸）
  var IDENT = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];

  // ==========================================================================
  // 1. 镜头库
  // ==========================================================================
  /**
   * 每支镜头：焦距(mm) + 最大光圈(F 值) + 性格描述。
   * F 值越小 = 光圈越大 = 景深越浅 = 背景虚化越猛。
   */
  var LENSES = {
    '16-ultrawide': { focal: 16, fstop: 4.0, name: '16mm 超广角', note: '空间夸张、边缘拉伸，适合开场建立镜头' },
    '24-wide':      { focal: 24, fstop: 2.8, name: '24mm 广角',   note: '环境感强，纵深被拉长' },
    '35-street':    { focal: 35, fstop: 1.4, name: '35mm 人文',   note: '叙事主力，透视自然' },
    '50-standard':  { focal: 50, fstop: 1.8, name: '50mm 标准',   note: '视角接近人眼，最万金油' },
    '85-portrait':  { focal: 85, fstop: 1.8, name: '85mm 人像',   note: '背景压缩 + 奶油虚化' },
    '135-tele':     { focal: 135, fstop: 2.0, name: '135mm 长焦', note: '强压缩感，适合主体特写' },
    '40-anamorphic':{ focal: 40, fstop: 2.0, name: '40mm 变形镜头', note: '横向蓝条拉丝光晕 + 椭圆焦外' }
  };

  // ==========================================================================
  // 2. 胶片 / 色彩科学库
  // ==========================================================================
  /**
   * 每套胶片的字段：
   *   curve  —— RGB 响应曲线，9 段 tableValues（0→1），模拟胶片的 S 型特性曲线
   *   matrix —— feColorMatrix 4x5，做通道串色（胶片各层染料互相污染的真实现象）
   *   sat    —— 饱和度
   *   grain  —— 颗粒 { op 强度, freq 频率 }
   *   halation —— 高光红色溢出强度（0 = 关）
   *   vignette —— 暗角强度
   *   tint   —— 白平衡偏移 [R,G,B] 乘数
   *   bloom  —— 柔光强度（高光扩散，Pro-Mist 类）
   */
  var FILMS = {
    'digital-clean': {
      /* ⚠️⚠️ vignette 必须是 **0**。本预设的语义是「原生数字、零染色」——
         grain / halation / bloom 全 0、matrix = IDENT、sat = 1.0、tint = 1,1,1，
         原先残留的 `vignette: 0.10` 是它**唯一一个非零效果**，与自己的名字和 note 自相矛盾。
         代价是实测出来的（2026-09-15，uvc-seg9 跨段基底判据 `_base_check.py`）：
           `buildOverlays` 会据此在 `#overlays` 里建一层 `.lens-vignette`（multiply，四角最高 0.10），
           而前一段 seg8 是**手写页**、它的暗角由 `#vig` 单独提供 ——
           于是 seg9 变成**双重压暗**，四角比 seg8 暗 **4.5 灰阶**（阈值 3.0），跨段接缝肉眼可见。
           ★ 这个数在「渲染帧」口径下是 4.5、「成片」口径是 3.8，两个口径都 FAIL。
         名字里写着 clean，就不该偷偷压暗画面 —— 静默的效果比显式的效果危险得多。 */
      name: 'Digital / 无滤镜', note: '原生数字，零染色（暗角也归 0）',
      curve: lin(), matrix: IDENT, sat: 1.0,
      grain: { op: 0, freq: 0.9 }, halation: 0, vignette: 0, tint: [1, 1, 1], bloom: 0
    },

    // ---- 柯达系 -----------------------------------------------------------
    'kodak-portra-400': {
      name: 'Kodak Portra 400', note: '低对比、奶油高光、肤色最讨喜；绿偏青、阴影带洋红',
      curve: {
        r: [0.00, 0.07, 0.17, 0.30, 0.47, 0.65, 0.81, 0.93, 1.00],
        g: [0.00, 0.06, 0.16, 0.29, 0.46, 0.65, 0.82, 0.94, 1.00],
        b: [0.01, 0.07, 0.18, 0.31, 0.48, 0.66, 0.82, 0.93, 1.00]
      },
      matrix: [
        0.98, 0.03, -0.01, 0, 0.012,
        0.00, 0.97, 0.03, 0, 0.006,
        0.02, 0.01, 0.95, 0, 0.020,
        0, 0, 0, 1, 0
      ],
      sat: 0.94, grain: { op: 0.05, freq: 0.85 }, halation: 0.10,
      vignette: 0.20, tint: [1.02, 1.00, 0.97], bloom: 0.10
    },
    'kodak-gold-200': {
      name: 'Kodak Gold 200', note: '标志性暖黄；高光偏金、绿偏黄绿、蓝浓郁',
      curve: {
        r: [0.00, 0.09, 0.21, 0.35, 0.52, 0.69, 0.84, 0.95, 1.00],
        g: [0.00, 0.07, 0.18, 0.31, 0.48, 0.66, 0.82, 0.94, 1.00],
        b: [0.00, 0.05, 0.13, 0.24, 0.40, 0.58, 0.76, 0.91, 1.00]
      },
      matrix: [
        1.06, 0.02, -0.04, 0, 0.010,
        0.02, 1.00, 0.00, 0, 0.004,
        -0.02, 0.03, 0.96, 0, 0.014,
        0, 0, 0, 1, 0
      ],
      sat: 1.06, grain: { op: 0.07, freq: 0.95 }, halation: 0.14,
      vignette: 0.24, tint: [1.05, 1.01, 0.93], bloom: 0.14
    },
    'kodak-vision3-250d': {
      name: 'Kodak Vision3 250D', note: '电影负片：宽动态、低饱和、青绿阴影 + 暖高光',
      curve: {
        r: [0.00, 0.06, 0.15, 0.28, 0.45, 0.64, 0.81, 0.93, 1.00],
        g: [0.00, 0.06, 0.15, 0.28, 0.45, 0.64, 0.81, 0.94, 1.00],
        b: [0.01, 0.07, 0.16, 0.29, 0.46, 0.65, 0.82, 0.94, 1.00]
      },
      matrix: [
        0.96, 0.04, 0.00, 0, 0.008,
        0.01, 0.98, 0.02, 0, 0.006,
        0.02, 0.04, 0.94, 0, 0.022,
        0, 0, 0, 1, 0
      ],
      sat: 0.88, grain: { op: 0.045, freq: 0.9 }, halation: 0.12,
      vignette: 0.26, tint: [1.01, 1.00, 0.99], bloom: 0.12
    },

    // ---- 富士系 -----------------------------------------------------------
    'fuji-velvia-50': {
      name: 'Fuji Velvia 50', note: '反转片之王：超高饱和、深蓝天空、浓郁绿、暗部扎实',
      curve: {
        r: [0.00, 0.05, 0.13, 0.26, 0.45, 0.67, 0.85, 0.96, 1.00],
        g: [0.00, 0.04, 0.12, 0.26, 0.46, 0.69, 0.87, 0.97, 1.00],
        b: [0.00, 0.04, 0.11, 0.24, 0.44, 0.68, 0.87, 0.97, 1.00]
      },
      matrix: [
        1.10, -0.04, -0.02, 0, 0.000,
        -0.02, 1.10, -0.04, 0, 0.000,
        -0.02, -0.01, 1.12, 0, 0.004,
        0, 0, 0, 1, 0
      ],
      sat: 1.28, grain: { op: 0.03, freq: 1.0 }, halation: 0.06,
      vignette: 0.28, tint: [0.99, 1.01, 1.03], bloom: 0.06
    },
    'fuji-pro-400h': {
      name: 'Fuji Pro 400H', note: '清透冷调、肤色粉嫩、绿偏青、低对比（日系通透感）',
      curve: {
        r: [0.01, 0.08, 0.19, 0.33, 0.50, 0.67, 0.83, 0.94, 1.00],
        g: [0.01, 0.09, 0.20, 0.34, 0.51, 0.68, 0.84, 0.95, 1.00],
        b: [0.01, 0.09, 0.21, 0.35, 0.52, 0.69, 0.84, 0.95, 1.00]
      },
      matrix: [
        0.97, 0.02, 0.01, 0, 0.014,
        0.00, 0.98, 0.03, 0, 0.010,
        0.01, 0.02, 1.00, 0, 0.022,
        0, 0, 0, 1, 0
      ],
      sat: 0.92, grain: { op: 0.04, freq: 0.88 }, halation: 0.08,
      vignette: 0.16, tint: [0.99, 1.00, 1.04], bloom: 0.16
    },
    'fuji-superia-400': {
      name: 'Fuji Superia 400', note: '消费负片：标志性「绿影子」+ 暖高光，颗粒明显',
      curve: {
        r: [0.00, 0.08, 0.19, 0.33, 0.50, 0.68, 0.84, 0.95, 1.00],
        g: [0.00, 0.08, 0.19, 0.33, 0.51, 0.69, 0.85, 0.95, 1.00],
        b: [0.00, 0.06, 0.15, 0.27, 0.44, 0.63, 0.80, 0.93, 1.00]
      },
      matrix: [
        1.02, 0.01, -0.02, 0, 0.008,
        0.02, 1.02, -0.02, 0, 0.012,
        -0.01, 0.05, 0.94, 0, 0.016,
        0, 0, 0, 1, 0
      ],
      sat: 1.08, grain: { op: 0.09, freq: 1.05 }, halation: 0.10,
      vignette: 0.22, tint: [1.01, 1.01, 0.98], bloom: 0.10
    },

    // ---- 特殊 / 电影 ------------------------------------------------------
    'cinestill-800t': {
      name: 'CineStill 800T', note: '钨丝灯电影卷：冷蓝夜调 + 去碳层导致的红色 halation 光晕，颗粒粗',
      curve: {
        r: [0.00, 0.06, 0.16, 0.30, 0.50, 0.70, 0.86, 0.96, 1.00],
        g: [0.00, 0.06, 0.16, 0.30, 0.49, 0.68, 0.84, 0.95, 1.00],
        b: [0.01, 0.09, 0.21, 0.36, 0.55, 0.73, 0.87, 0.96, 1.00]
      },
      matrix: [
        0.98, 0.01, 0.02, 0, 0.004,
        0.01, 0.97, 0.04, 0, 0.006,
        0.03, 0.02, 1.06, 0, 0.018,
        0, 0, 0, 1, 0
      ],
      sat: 1.02, grain: { op: 0.14, freq: 0.75 }, halation: 0.55,
      vignette: 0.34, tint: [0.96, 0.99, 1.08], bloom: 0.22
    },
    'agfa-vista-200': {
      name: 'Agfa Vista 200', note: '德味：浓郁红 + 青绿、中等饱和、层次厚',
      curve: {
        r: [0.00, 0.08, 0.20, 0.35, 0.53, 0.71, 0.86, 0.96, 1.00],
        g: [0.00, 0.07, 0.17, 0.31, 0.49, 0.68, 0.84, 0.95, 1.00],
        b: [0.00, 0.06, 0.15, 0.28, 0.46, 0.65, 0.82, 0.94, 1.00]
      },
      matrix: [
        1.08, -0.02, -0.03, 0, 0.006,
        0.00, 1.02, 0.00, 0, 0.004,
        -0.02, 0.04, 0.99, 0, 0.012,
        0, 0, 0, 1, 0
      ],
      sat: 1.14, grain: { op: 0.08, freq: 0.98 }, halation: 0.12,
      vignette: 0.24, tint: [1.03, 1.00, 0.97], bloom: 0.10
    },
    'ilford-hp5': {
      name: 'Ilford HP5 Plus', note: '经典黑白：中高对比、明显颗粒、红色高敏感',
      curve: {
        r: [0.00, 0.06, 0.16, 0.30, 0.50, 0.71, 0.87, 0.96, 1.00],
        g: [0.00, 0.06, 0.16, 0.30, 0.50, 0.71, 0.87, 0.96, 1.00],
        b: [0.00, 0.06, 0.16, 0.30, 0.50, 0.71, 0.87, 0.96, 1.00]
      },
      // 红敏感通道混合：0.32R + 0.52G + 0.16B（略微提红，接近 HP5 的光谱响应）
      matrix: [
        0.32, 0.52, 0.16, 0, 0,
        0.32, 0.52, 0.16, 0, 0,
        0.32, 0.52, 0.16, 0, 0,
        0, 0, 0, 1, 0
      ],
      sat: 0.0, grain: { op: 0.17, freq: 0.8 }, halation: 0.10,
      vignette: 0.32, tint: [1.02, 1.00, 0.98], bloom: 0.08
    },
    'lomo-cross': {
      name: 'Lomo 交叉冲洗', note: 'E-6 走 C-41：极端高对比、青绿阴影 + 黄绿高光、过饱和',
      curve: {
        r: [0.00, 0.04, 0.12, 0.28, 0.52, 0.76, 0.92, 0.99, 1.00],
        g: [0.00, 0.05, 0.15, 0.32, 0.56, 0.78, 0.93, 0.99, 1.00],
        b: [0.00, 0.03, 0.09, 0.22, 0.45, 0.71, 0.90, 0.98, 1.00]
      },
      matrix: [
        1.04, 0.02, -0.04, 0, 0.012,
        -0.02, 1.06, -0.02, 0, 0.008,
        0.02, 0.04, 1.08, 0, -0.010,
        0, 0, 0, 1, 0
      ],
      sat: 1.35, grain: { op: 0.11, freq: 1.1 }, halation: 0.20,
      vignette: 0.38, tint: [1.00, 1.02, 1.02], bloom: 0.16
    }
  };

  /** 线性响应曲线（9 段），无染色胶片的基准 */
  function lin() {
    var a = [];
    for (var i = 0; i < 9; i++) a.push(i / 8);
    return { r: a.slice(), g: a.slice(), b: a.slice() };
  }

  // ==========================================================================
  // 3. 光学计算
  // ==========================================================================
  var optics = {
    /** 焦距(mm) → zoom(px)，与 camera3d.focalToZoom 同源 */
    focalToZoom: function (focalMm, compW, filmW) {
      filmW = filmW || 36;
      var aov = 2 * Math.atan(filmW / (2 * focalMm));
      return (compW / 2) / Math.tan(aov / 2);
    },
    /** mm_per_px：世界像素与物理尺寸的比例尺 */
    mmPerPx: function (compW, filmW) { return (filmW || 36) / compW; },

    /**
     * 薄透镜弥散圆直径（像素）。
     * @param S2      物距（摄影机到图层的距离，px）
     * @param S1      对焦距离（px），必须 > 焦距
     * @param focalMm 焦距(mm)
     * @param fstop   F 值（1.8 / 2.8 / 5.6 ...，越小景深越浅）
     * @returns CoC 直径(px)；返回值已做上限钳制，避免除零爆炸
     */
    coc: function (S2, S1, focalMm, fstop, compW, filmW) {
      compW = compW || 1920; filmW = filmW || 36;
      var fPx = this.focalToZoom(focalMm, compW, filmW);
      if (S1 <= fPx * 1.02) S1 = fPx * 1.02;          // 物理下限保护
      if (S2 < 1) S2 = 1;
      var c = Math.abs(S2 - S1) / S2 * (fPx * fPx) / (fstop * (S1 - fPx));
      return c > 400 ? 400 : c;
    },

    /**
     * 直接给「CSS blur 半径(px)」—— 日常最常用。
     * @returns { blur, coc } blur = coc/2
     */
    blur: function (S2, S1, focalMm, fstop, compW, filmW) {
      var c = this.coc(S2, S1, focalMm, fstop, compW, filmW);
      return { blur: c / 2, coc: c };
    },

    /** 超焦距（mm→px）：对焦在此处时，从一半超焦距到无穷远都清晰 */
    hyperfocal: function (focalMm, fstop, compW, filmW) {
      var fPx = this.focalToZoom(focalMm, compW || 1920, filmW || 36);
      var cocLimit = 0.03 / this.mmPerPx(compW || 1920, filmW);   // 30µm 容许圈
      return fPx * fPx / (fstop * cocLimit) + fPx;
    },

    /** 景深范围 [近界, 远界]（px） */
    dofRange: function (S1, focalMm, fstop, compW, filmW) {
      var fPx = this.focalToZoom(focalMm, compW || 1920, filmW || 36);
      var c = 0.03 / this.mmPerPx(compW || 1920, filmW);
      var H = fPx * fPx / (fstop * c);
      var near = S1 * (H - fPx) / (H + S1 - 2 * fPx);
      var far = S1 * (H - fPx) / (H - S1);
      return [near, far > 1e7 ? Infinity : far];
    }
  };

  // ==========================================================================
  // 4. SVG 滤镜链生成
  // ==========================================================================
  function filmFilterSVG(key, f, opts) {
    opts = opts || {};
    var lite = !!opts.lite;                       // lite = 去掉 halation 高斯模糊，快很多
    /* ★ BUG-2012：strength 现在真的参与滤镜链构建。
       以前它只用来判 `<= 0`，0.1 和 1.0 生成的是同一条链 —— 参数写了等于没写。
       现在按 strength 把胶片参数往「线性曲线 / 单位矩阵 / 饱和 1 / 无 halation」
       插值：1.0 = 完整胶片性格，0.4 = 只留一点色味，0 = 等价 digital-clean。 */
    var st = opts.strength == null ? 1 : Math.max(0, Math.min(1, opts.strength));
    var L0 = lin();
    var cv = {
      r: f.curve.r.map(function (v, i) { return +(L0.r[i] + (v - L0.r[i]) * st).toFixed(5); }),
      g: f.curve.g.map(function (v, i) { return +(L0.g[i] + (v - L0.g[i]) * st).toFixed(5); }),
      b: f.curve.b.map(function (v, i) { return +(L0.b[i] + (v - L0.b[i]) * st).toFixed(5); })
    };
    var mx = f.matrix.map(function (v, i) { return +(IDENT[i] + (v - IDENT[i]) * st).toFixed(5); });
    var sat = +(1 + (f.sat - 1) * st).toFixed(5);
    var hal = f.halation * st;
    var bl = f.bloom * st;
    var tt = f.tint || [1, 1, 1];
    var t = [1 + (tt[0] - 1) * st, 1 + (tt[1] - 1) * st, 1 + (tt[2] - 1) * st];

    var id = 'film-' + key;
    var s = '<filter id="' + id + '" color-interpolation-filters="sRGB" x="-2%" y="-2%" width="104%" height="104%">';

    // (a) 胶片特性曲线
    s += '<feComponentTransfer result="c1">' +
         '<feFuncR type="table" tableValues="' + cv.r.join(' ') + '"/>' +
         '<feFuncG type="table" tableValues="' + cv.g.join(' ') + '"/>' +
         '<feFuncB type="table" tableValues="' + cv.b.join(' ') + '"/>' +
         '</feComponentTransfer>';

    // (b) 通道串色矩阵
    s += '<feColorMatrix in="c1" type="matrix" values="' + mx.join(' ') + '" result="c2"/>';

    // (c) 饱和度
    if (sat !== 1) s += '<feColorMatrix in="c2" type="saturate" values="' + sat + '" result="c3"/>';
    else s += '<feColorMatrix in="c2" type="matrix" values="' + IDENT.join(' ') + '" result="c3"/>';

    // (d) 白平衡 tint
    if (t[0] !== 1 || t[1] !== 1 || t[2] !== 1) {
      s += '<feColorMatrix in="c3" type="matrix" values="' +
           t[0] + ' 0 0 0 0  0 ' + t[1] + ' 0 0 0  0 0 ' + t[2] + ' 0 0  0 0 0 1 0" result="c4"/>';
    } else {
      s += '<feColorMatrix in="c3" type="matrix" values="' + IDENT.join(' ') + '" result="c4"/>';
    }

    var last = 'c4';

    // (e) Halation：取高光 → 模糊 → 染红 → screen 叠回（CineStill 800T 的灵魂）
    if (hal > 0 && !lite) {
      var thr = 2.6, icept = -(thr - 1) / thr * 1.0;   // 只保留亮度 > ~0.62 的部分
      s += '<feComponentTransfer in="' + last + '" result="h_thr">' +
           '<feFuncR type="linear" slope="' + thr + '" intercept="' + icept.toFixed(3) + '"/>' +
           '<feFuncG type="linear" slope="' + thr + '" intercept="' + icept.toFixed(3) + '"/>' +
           '<feFuncB type="linear" slope="' + thr + '" intercept="' + icept.toFixed(3) + '"/>' +
           '</feComponentTransfer>';
      // 光晕半径随 strength 收敛：满强度 22px，弱强度贴边 ——
      // 否则白字周围会糊一圈脏橙（明动 V5 全片白字发脏的真凶）
      s += '<feGaussianBlur in="h_thr" stdDeviation="' + (8 + 14 * st).toFixed(1) + '" result="h_blur"/>';
      s += '<feColorMatrix in="h_blur" type="matrix" values="' +
           (1.45 * hal) + ' 0 0 0 0  0 ' + (0.30 * hal) + ' 0 0 0  0 0 ' +
           (0.18 * hal) + ' 0 0  0 0 0 1 0" result="h_red"/>';
      s += '<feBlend in="' + last + '" in2="h_red" mode="screen" result="c5"/>';
      last = 'c5';
    }

    // (f) Bloom / Pro-Mist 柔光
    if (bl > 0 && !lite) {
      s += '<feGaussianBlur in="' + last + '" stdDeviation="9" result="b_blur"/>';
      s += '<feComponentTransfer in="b_blur" result="b_hi">' +
           '<feFuncR type="linear" slope="1.8" intercept="-0.62"/>' +
           '<feFuncG type="linear" slope="1.8" intercept="-0.62"/>' +
           '<feFuncB type="linear" slope="1.8" intercept="-0.62"/>' +
           '</feComponentTransfer>';
      s += '<feComposite in="b_hi" in2="b_hi" operator="arithmetic" k1="0" k2="' + bl + '" k3="0" k4="0" result="b_amt"/>';
      s += '<feBlend in="' + last + '" in2="b_amt" mode="screen" result="c6"/>';
      last = 'c6';
    }

    s += '</filter>';
    return s;
  }

  /** 生成并注入全部胶片 filter 的 <svg> 到 document.body */
  function injectSVG(keys, opts) {
    keys = keys || Object.keys(FILMS);
    var svg = '<svg id="camlens-defs" width="0" height="0" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true"><defs>';
    keys.forEach(function (k) { svg += filmFilterSVG(k, FILMS[k], opts); });
    svg += '</defs></svg>';
    var old = document.getElementById('camlens-defs');
    if (old) old.parentNode.removeChild(old);
    var wrap = document.createElement('div');
    wrap.innerHTML = svg;
    document.body.appendChild(wrap.firstChild);
    return true;
  }

  // ==========================================================================
  // 5. 叠加层：颗粒 / 暗角 / 拉丝光晕
  // ==========================================================================
  /**
   * 在 #screen 内建 2D 效果层（不参与 3D）。
   * @param screen 2D 包装层元素
   * @param filmKey 胶片名（取 grain / vignette 参数）
   * @param opts { anamorphic:bool, grainSeed, vignette:bool }
   *        ★ `opts.vignette === false` 可**显式关掉暗角层**（不创建，不是 display:none）。
   *          跨段统一时会用到：前一段若用手写 `#vig` 提供暗角，本段再叠一层就是双重压暗 ——
   *          实测代价 4.5 灰阶（见 FILMS['digital-clean'] 的注记）。
   */
  function buildOverlays(screen, filmKey, opts) {
    opts = opts || {};
    var f = FILMS[filmKey] || FILMS['digital-clean'];
    if (!screen) return null;

    // 暗角
    var vig = null;
    if (opts.vignette !== false) {
      vig = document.createElement('div');
      vig.className = 'lens-vignette';
      vig.style.cssText = 'position:absolute;inset:0;pointer-events:none;' +
        'background:radial-gradient(ellipse 78% 78% at 50% 50%, rgba(0,0,0,0) 42%, rgba(0,0,0,' +
        (f.vignette * 0.55).toFixed(3) + ') 78%, rgba(0,0,0,' + f.vignette.toFixed(3) + ') 100%);' +
        'mix-blend-mode:multiply;';
      screen.appendChild(vig);
    }

    // 颗粒（SVG turbulence 转 data-uri，逐帧靠 backgroundPosition 抖动）
    if (f.grain && f.grain.op > 0) {
      var gr = document.createElement('div');
      gr.className = 'lens-grain';
      gr.style.cssText = 'position:absolute;inset:-40px;pointer-events:none;opacity:' +
        f.grain.op + ';mix-blend-mode:overlay;background-repeat:repeat;background-size:220px 220px;';
      gr.style.backgroundImage = 'url("data:image/svg+xml;utf8,' +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220">' +
          '<filter id="n"><feTurbulence type="fractalNoise" baseFrequency="' + f.grain.freq +
          '" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter>' +
          '<rect width="220" height="220" filter="url(#n)" opacity="0.9"/></svg>'
        ) + '")';
      screen.appendChild(gr);
      screen.__grain = gr;
    }

    // 变形镜头横向蓝条拉丝
    if (opts.anamorphic) {
      var fl = document.createElement('div');
      fl.className = 'lens-anamorphic';
      fl.style.cssText = 'position:absolute;left:0;right:0;top:50%;height:3px;margin-top:-1.5px;' +
        'pointer-events:none;opacity:.55;mix-blend-mode:screen;' +
        'background:linear-gradient(90deg,rgba(60,120,255,0) 0%,rgba(120,180,255,.9) 22%,' +
        'rgba(200,230,255,1) 50%,rgba(120,180,255,.9) 78%,rgba(60,120,255,0) 100%);' +
        'filter:blur(2px);transform:scaleX(1.0);';
      screen.appendChild(fl);
      screen.__flare = fl;
    }
    return { vignette: vig, grain: screen.__grain, flare: screen.__flare };
  }

  /**
   * 逐帧驱动叠加层（在 window.__frame 内调用）。
   * 颗粒做 8 帧循环的位移抖动，模拟真实胶片的颗粒沸腾（grain boil）。
   * 用确定性映射（t → 位移），保证 seek 任意帧结果一致。
   */
  function tickOverlays(screen, t, fps) {
    fps = fps || 30;
    if (!screen) return;
    if (screen.__grain) {
      var i = Math.floor(t * fps) % 8;
      var OX = [0, -37, 19, -61, 44, -12, 71, -48];
      var OY = [0, 23, -55, 31, -19, 67, -34, 8];
      screen.__grain.style.backgroundPosition = OX[i] + 'px ' + OY[i] + 'px';
    }
    if (screen.__flare) {
      // 拉丝强度随镜头运动轻微呼吸
      var b = 0.42 + 0.18 * Math.sin(t * 1.9);
      screen.__flare.style.opacity = b.toFixed(3);
    }
  }

  /**
   * 给 #screen 上胶片滤镜。
   * @param screen  2D 包装层（绝不能是 3D 链上的元素）
   * @param filmKey FILMS 的 key
   * @param strength 0..1，与 digital-clean 做插值（用 opacity 混两层不好做，这里按 halation/bloom 缩放近似）
   */
  function applyFilm(screen, filmKey, strength) {
    if (!screen) return;
    var f = FILMS[filmKey];
    if (!f) { console.warn('[camera-lens] 未知胶片:', filmKey); return; }
    strength = strength === undefined ? 1 : strength;
    if (strength <= 0) {
      screen.style.filter = 'none';
      screen.__film = null; screen.__filmStrength = 0;
      return f;
    }
    /* ★ BUG-2012 修复：strength 以前是死参数，现在按它重建滤镜链。
       代价是每次换强度要重注入一次 SVG defs —— 只在初始化调一次，无所谓。 */
    injectSVG([filmKey, 'digital-clean'], { strength: strength });
    screen.style.filter = 'url(#film-' + filmKey + ')';
    screen.__film = filmKey;
    screen.__filmStrength = strength;
    return f;
  }

  /** 列出所有胶片（给 UI 面板用） */
  function listFilms() {
    return Object.keys(FILMS).map(function (k) {
      return { key: k, name: FILMS[k].name, note: FILMS[k].note };
    });
  }
  function listLenses() {
    return Object.keys(LENSES).map(function (k) {
      return { key: k, name: LENSES[k].name, focal: LENSES[k].focal, fstop: LENSES[k].fstop, note: LENSES[k].note };
    });
  }

  g.CAMLENS = {
    LENSES: LENSES, FILMS: FILMS, IDENT: IDENT,
    optics: optics,
    injectSVG: injectSVG, filmFilterSVG: filmFilterSVG,
    buildOverlays: buildOverlays, tickOverlays: tickOverlays,
    applyFilm: applyFilm, listFilms: listFilms, listLenses: listLenses
  };

  // camera3d 软挂载：有则把光学层挂上去
  if (g.CAM3D) g.CAM3D.lens = g.CAMLENS;
})(window);
