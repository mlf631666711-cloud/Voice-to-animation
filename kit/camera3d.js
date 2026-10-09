/**
 * camera3d.js —— 「3D 场景 + 虚拟摄影机」运行时（零依赖，纯函数逐帧驱动）
 *
 * 目标：让单文件 HTML 动效工程拥有 AE 那样的「3D 图层 + 摄影机」能力，
 * 同时保持既有管线的两条铁律：
 *   1. 禁 CSS animation / transition，一切由 window.__frame(t) 纯函数驱动；
 *   2. 每一帧可 seek、可截图、结果确定（同 t 必得同画面）。
 *
 * ---------------------------------------------------------------------------
 * 坐标与约定
 * ---------------------------------------------------------------------------
 * 采用 CSS 3D 原生坐标系（注意 Y 轴向下、Z 轴朝观察者）：
 *     +X 右   +Y 下   +Z 朝屏幕外（靠近观众）
 * 所以「物体离摄影机越远」= z 越小（负得越多）。
 *
 * DOM 结构约定（三层）：
 *   #viewport   透视容器：perspective = 摄影机 Zoom(px)，perspective-origin 50% 50%
 *     #camera   摄影机节点：transform = 摄影机世界变换的逆矩阵
 *       #world  世界节点：所有 3D 图层挂在这里，各自 translate3d(x,y,z) rotateY(...) 等
 *
 * ---------------------------------------------------------------------------
 * 与 AE 的概念映射（重要）
 * ---------------------------------------------------------------------------
 *   AE Zoom (px)            ≡ CSS perspective (px)      —— 数值可直接互换
 *   AE Focal Length (mm)    → focalToZoom(mm, compW, filmW) 换算成 Zoom
 *   AE Point of Interest    ≡ key.px/py/pz，由 lookAt() 解算 yaw/pitch
 *   AE Z Rotation           ≡ key.roll（度）
 *   AE Depth of Field       → dof()：按「摄影机到图层距离」算 CSS blur（假景深）
 *   AE 父子绑定 / null 对象  ≡ DOM 嵌套（父节点 preserve-3d 即 null 对象）
 *   3D 图层开关（立方体图标） ≡ 元素带 translate3d 且父链 preserve-3d
 *
 * ---------------------------------------------------------------------------
 * ⚠ 已知硬约束（flattening / 强制拍平）
 * ---------------------------------------------------------------------------
 * 以下属性一旦出现在某元素上，会把该元素的**子元素**拍平进它自己的平面，
 * 子元素将不再共享 3D 空间：
 *     opacity < 1 | filter | overflow != visible | clip-path | mask |
 *     isolation:isolate | contain:paint | background 不是透明也不影响（安全）
 *
 * 实践规则：
 *   ✅ opacity/filter 只用在「叶子图层」（面板本体）上 —— 面板自身仍会被正确透视投影
 *   ❌ 绝不加在 #viewport / #camera / #world 或任何 3D 容器上
 *   ✅ 需要整组淡出时，淡出「叶子」或用 translateZ 推到极远 + 视锥外
 *
 * ---------------------------------------------------------------------------
 * 关键帧轨道格式
 * ---------------------------------------------------------------------------
 *   TRACK = [
 *     { t: 0,   x, y, z,            // 摄影机世界坐标(px)，缺省继承上一帧
 *       px, py, pz,                 // Point of Interest，缺省继承
 *       zoom,                       // ≡ perspective(px)，缺省继承，初值 1400
 *       roll,                       // 度，绕视轴旋转，缺省继承
 *       ease: 'eio' | 'eo' | 'lin'  // 本段缓动，缺省 eio
 *     }, ...
 *   ]
 * 轨道按 t 升序；t 早于首帧 / 晚于末帧都做端点钳制。
 *
 * 用法：
 *   CAM3D.apply(vp, cam, TRACK, t);                  // 摄影机就位
 *   const d = CAM3D.dist(CAM3D.sample(TRACK,t), P);  // 图层到摄影机距离
 *   CAM3D.dof(el, d, focusDist, 260, 14);            // 假景深
 */

(function (g) {
  'use strict';

  var FX = g.FX || {};

  // --- 基础数学 -------------------------------------------------------------
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function lerp(a, b, k) { return a + (b - a) * k; }
  function ei(k) { return k * k * k; }                                  // ease-in cubic
  function eo(k) { k = 1 - k; return 1 - k * k * k; }                   // ease-out cubic
  function eio(k) { return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; }
  function c1(t, t0, t1) { return clamp01((t - t0) / (t1 - t0 || 1e-6)); }

  // === 惯性缓动族 ===========================================================
  // 只有 eo/ei/eio 三种 cubic 是做不出「惯性」的 —— 那只是加减速。
  // 惯性 = overshoot（冲过头）+ settle（回弹归位），必须靠 back / elastic / snap。
  // 命名：i=in  o=out  io=in-out；前缀 q=quart  x=expo  c=circ  b=back  el=elastic
  function qi(k)  { return k * k * k * k; }                             // quart in
  function qo(k)  { return 1 - Math.pow(1 - k, 4); }                    // quart out
  function qio(k) { return k < 0.5 ? 8*k*k*k*k : 1 - Math.pow(-2*k+2, 4)/2; }

  function xi(k)  { return k <= 0 ? 0 : Math.pow(2, 10*k - 10); }       // expo in（极慢起步→暴冲）
  function xo(k)  { return k >= 1 ? 1 : 1 - Math.pow(2, -10*k); }       // expo out（暴冲→极缓收尾）
  function xio(k) { return k<=0?0:k>=1?1:k<0.5 ? Math.pow(2,20*k-10)/2 : (2-Math.pow(2,-20*k+10))/2; }

  function ci(k)  { return 1 - Math.sqrt(Math.max(0, 1 - k*k)); }       // circ in
  function co(k)  { return Math.sqrt(Math.max(0, 1 - Math.pow(k-1, 2))); }
  function cio(k) { return k < 0.5
      ? (1 - Math.sqrt(Math.max(0,1 - 4*k*k))) / 2
      : (Math.sqrt(Math.max(0,1 - Math.pow(-2*k+2, 2))) + 1) / 2; }

  // back：overshoot 惯性。s=1.70158 是 Penner 原值；inOut 需 ×1.525 才对称
  function bo(k, s)  { s = s == null ? 1.70158 : s; k = k - 1;
                       return k*k*((s+1)*k + s) + 1; }
  function bi(k, s)  { s = s == null ? 1.70158 : s;
                       return k*k*((s+1)*k - s); }
  function bio(k, s) { s = (s == null ? 1.70158 : s) * 1.525; k *= 2;
                       return k < 1 ? 0.5*(k*k*((s+1)*k - s))
                                    : 0.5*((k -= 2)*k*((s+1)*k + s) + 2); }

  // elastic：弹簧。p=周期(默认0.3)，越大抖得越快
  function elo(k, p) { if (k <= 0) return 0; if (k >= 1) return 1;
                       p = p || 0.3;
                       return Math.pow(2, -10*k) * Math.sin((k*10 - 0.75) * (2*Math.PI/p)) + 1; }
  function eli(k, p) { if (k <= 0) return 0; if (k >= 1) return 1;
                       p = p || 0.3;
                       return -Math.pow(2, 10*k-10) * Math.sin((k*10 - 10.75) * (2*Math.PI/p)); }

  // bounce：落地弹跳（四段衰减）
  function bno(k) {
    var n1 = 7.5625, d1 = 2.75;
    if (k < 1/d1)   return n1*k*k;
    if (k < 2/d1)   return n1*(k -= 1.5/d1)*k + 0.75;
    if (k < 2.5/d1) return n1*(k -= 2.25/d1)*k + 0.9375;
    return n1*(k -= 2.625/d1)*k + 0.984375;
  }

  /**
   * snap（★ 商业级 MG 最常用的"冲+修正"）
   * Joey Korenman(School of Motion) 的 snap zoom 技法数字化：
   * 6 帧猛推到位 → 停 2 帧 → 微微回拉一点做"修正"，观众会觉得镜头是"人"端着的。
   * 前 72% 冲到 1+overshoot，后 28% 缓慢回落。
   */
  function snapo(k, ov) {
    ov = ov == null ? 0.06 : ov;
    if (k < 0.72) { var u = k / 0.72; return (1 + ov) * (1 - Math.pow(1 - u, 3)); }
    var v = (k - 0.72) / 0.28;
    return (1 + ov) - ov * eio(v);
  }
  /** snap 的 in-out 版：两端都有微过冲 */
  function snapio(k, ov) {
    ov = ov == null ? 0.05 : ov;
    return k < 0.5 ? snapo(k * 2, ov) * 0.5
                   : (1 - snapo((1 - k) * 2, ov)) * 0.5 + 0.5;
  }

  /**
   * ★ smootherstep 6k⁵−15k⁴+10k³ —— **相机推拉专用**。
   *
   * 为什么不能用 eio（三次 in-out）：三次 in-out 的二阶导 f'' 在中点
   * 从 +12 直接跳到 −12，而 f'' 的跳变 = 加加速度（jerk）脉冲。实测过一次
   * 推近，jerk 峰值 681581 px/s³ 全部集中在中点那一帧上 —— 肉眼看就是
   * 「推拉推到这个位置忽然一顿」。
   *
   * smootherstep 的 f'' = 120k³−180k²+60k 在 k=0 / 0.5 / 1 三处**全为 0**，
   * 即加速、匀速、减速三段之间的过渡是连续的，全程没有 jerk 尖峰。
   *
   * 代价：起步和收尾比 eio 更"肉"（要拖长一点时长才有力）。
   * ⚠️ 结论来自 L10 NEO 版实测（2026-09-13），此前只写在项目文档里，
   *    现在固化进 kit —— 写注释是愿望，写代码才是规格。
   *
   * @param k 0..1
   */
  function sm(k) { return k * k * k * (k * (k * 6 - 15) + 10); }

  /* ★★ 合法缓动名清单 —— `ease()` 分支与 `listEasings()` 的**单一真源**。
     ⚠️ 为什么要显式列出来、并对未知名发警告：`ease()` 的 default 分支**静默回落 eio**。
        2026-09-15 实测踩过：`uvc-seg9/_cam.js` 写了 `ease:'eob'`（注释还标着「eob 过冲」），
        而这里**根本没有 'eob'** → 回落 eio → **设计好的"过冲 punch-in"从来没发生过**，
        而且不报错、不 console、光看代码完全看不出来。
        后来把它当成"运镜名不副实"排查了很久，才发现真凶是缓动名写错。
        → 名字写错必须**变响**（静默假成功是最大敌人）。 */
  var EASE_NAMES = ['lin', 'ei', 'eo', 'eio', 'qi', 'qo', 'qio', 'xi', 'xo', 'xio',
                    'ci', 'co', 'cio', 'bi', 'bo', 'bio', 'eli', 'elo', 'bno',
                    'snapo', 'snapio', 'sm'];
  var _easeWarned = {};

  function ease(name, k) {
    k = k < 0 ? 0 : k > 1 ? 1 : k;
    switch (name) {
      case 'lin':  return k;
      case 'ei':   return ei(k);
      case 'eo':   return eo(k);
      case 'eio':  return eio(k);
      case 'qi':   return qi(k);
      case 'qo':   return qo(k);
      case 'qio':  return qio(k);
      case 'xi':   return xi(k);
      case 'xo':   return xo(k);
      case 'xio':  return xio(k);
      case 'ci':   return ci(k);
      case 'co':   return co(k);
      case 'cio':  return cio(k);
      case 'bi':   return bi(k);
      case 'bo':   return bo(k);
      case 'bio':  return bio(k);
      case 'eli':  return eli(k);
      case 'elo':  return elo(k);
      case 'bno':  return bno(k);
      case 'snapo':  return snapo(k);
      case 'snapio': return snapio(k);
      case 'sm':     return sm(k);            /* ★ smootherstep —— 相机推拉首选，无 jerk 尖峰 */
      default:
        if (name != null && name !== 'eio' && !_easeWarned[name]) {
          _easeWarned[name] = 1;
          console.warn('[camera3d] 未知缓动名 "' + name + '" → 静默回落 eio。'
            + '若这里要的是过冲/惯性，那它**根本没发生**（eio 只是加减速）。'
            + ' 可用：' + EASE_NAMES.join(' '));
        }
        return eio(k);
    }
  }

  // --- 镜头换算 -------------------------------------------------------------
  /**
   * AE 焦距(mm) → Zoom(px)。filmW 为片门宽度，默认 36mm（35mm 全画幅）。
   *   AOV_h = 2 * atan(filmW / (2 * focal))
   *   zoom  = (compW / 2) / tan(AOV_h / 2)
   * 例：focal=50mm, compW=1920 → zoom ≈ 2667px
   */
  function focalToZoom(focalMm, compW, filmW) {
    filmW = filmW || 36;
    var aov = 2 * Math.atan(filmW / (2 * focalMm));
    return (compW / 2) / Math.tan(aov / 2);
  }

  /**
   * 垂直视场角(度) → Zoom(px)。适合直接指定 FOV 的场景。
   */
  function fovToZoom(fovDeg, compH) {
    return (compH / 2) / Math.tan((fovDeg * Math.PI / 180) / 2);
  }

  /**
   * Zoom(px) → 垂直视场角(度)，调试用。
   */
  function zoomToFov(zoom, compH) {
    return 2 * Math.atan((compH / 2) / zoom) * 180 / Math.PI;
  }

  // --- 朝向解算 -------------------------------------------------------------
  /**
   * 由「摄影机位置 → POI」解算 yaw / pitch（度）。
   *
   * 推导（CSS 坐标系，Y 下 / Z 朝观众）：
   *   设 R = Ry(yaw) * Rx(pitch)，相机默认朝向 (0,0,-1)
   *   f = R * (0,0,-1) = (-cos p · sin y,  sin p,  -cos p · cos y)
   *   反解： pitch = asin(f.y)          yaw   = atan2(-f.x, -f.z)
   */
  function lookAt(cx, cy, cz, px, py, pz) {
    var fx = px - cx, fy = py - cy, fz = pz - cz;
    var len = Math.sqrt(fx * fx + fy * fy + fz * fz);
    if (len < 1e-6) return { yaw: 0, pitch: 0 };
    fx /= len; fy /= len; fz /= len;
    var pitch = Math.asin(fy < -1 ? -1 : fy > 1 ? 1 : fy);
    var yaw = Math.atan2(-fx, -fz);
    return { yaw: yaw * 180 / Math.PI, pitch: pitch * 180 / Math.PI };
  }

  // --- 轨道采样 -------------------------------------------------------------
  var DEFAULT = { x: 0, y: 0, z: 1600, px: 0, py: 0, pz: 0, zoom: 1400, roll: 0, ease: 'eio' };

  /**
   * 采样轨道。缺省字段从「上一关键帧」继承（AE 的 hold/继承语义），
   * 首帧缺省字段用 DEFAULT 补齐。
   */
  function sample(track, t) {
    if (!track || !track.length) {
      return { x: 0, y: 0, z: 1600, px: 0, py: 0, pz: 0, zoom: 1400, roll: 0 };
    }
    if (t <= track[0].t) return fill(track[0], null);
    var last = track[track.length - 1];
    if (t >= last.t) return fill(last, track[track.length - 2] || null);

    var i = 0;
    while (i < track.length - 1 && track[i + 1].t <= t) i++;
    var a = track[i], b = track[i + 1];
    var k = ease(a.ease || 'eio', c1(t, a.t, b.t));
    var A = fill(a, track[i - 1] || null);
    var B = fill(b, a);
    return {
      x: lerp(A.x, B.x, k), y: lerp(A.y, B.y, k), z: lerp(A.z, B.z, k),
      px: lerp(A.px, B.px, k), py: lerp(A.py, B.py, k), pz: lerp(A.pz, B.pz, k),
      zoom: lerp(A.zoom, B.zoom, k),
      roll: lerp(A.roll, B.roll, k)
    };
  }

  function fill(kf, prev) {
    var o = {};
    for (var key in DEFAULT) {
      if (kf[key] !== undefined) o[key] = kf[key];
      else if (prev && prev[key] !== undefined) o[key] = prev[key];
      else o[key] = DEFAULT[key];
    }
    return o;
  }

  // --- 速度连续采样（C1 单调三次 Hermite）-----------------------------------
  /**
   * ★★ 速度连续采样 —— 运镜「丝滑」的正解（BUG-2360）。
   *
   * 为什么单靠 sample() 不够：
   *   sample() 是**逐段套缓动**，而相机推拉首选的 `sm`(smootherstep) 恰好
   *   f'(0) = f'(1) = 0 —— 「每段两端速度都归零」⇒ **每一个关键帧，相机都要
   *   刹停再启动**。更狠的是 smootherstep 在 k<0.2 时位移不足 0.8%，所以每段
   *   开头结尾各有 ~0.3s 几乎不动的死区。
   *   实测（video-style-lab/projects/mingong-l10-bt 镜4/S8 · 14 KF / 9.29s）：
   *     · 屏幕速度 <15% 中位的「停滞帧」占 **14.0%（39/279）**
   *     · 停滞簇**全部落在关键帧上**：3.43–3.80 / 4.37 / 4.93–5.03 / 6.00–6.03
   *       / 6.43–6.57 / 7.17–7.33 / 7.83–7.93
   *     · 最大 jerk 也在 KF 上：7.97→76.6 / 7.93→52.2 / 6.10→32.1
   *   观感就是「一顿一顿」。注意 `sm` 的注释写着「f'' 三处为 0 ⇒ 无 jerk 尖峰」——
   *   它买来的是**加速度**连续，代价是**速度**归零；而丝滑要的恰恰是后者。
   *
   * 本函数三条性质（都是刻意选的）：
   *   ① **经过关键帧时速度连续**（C1）：只有「真折返」（斜率变号）与显式
   *      `hold:true` 才减速到 0。
   *   ② **关键帧处的值严格保持** —— 每个 KF 的构图落点一分不改，不必重调构图。
   *   ③ **不过冲**（Fritsch–Carlson 单调限制）：段内插值被 KF 值包住 ⇒ 不会把
   *      元素顶出安全区/字幕净空区（自然三次样条会过冲，安全区判据会跟着红）。
   *
   * 关键帧新增字段：
   *   hold:true   显式声明「这里我要停」（叙事留白）。两侧切线强制 0。
   *               ⚠️ 但**死停 ≠ 高级**：全静止 0.38s 本身就是「卡」。更好的做法是给
   *               一小段 creep（每帧动 ~40% 中位速）——观众读到留白，却看不到静止。
   *
   * 端点切线：首帧 = Δ[0]（一开场就在动，避免片头死区）；末帧 = 0（收尾停稳）。
   */
  var _SPCH = ['x', 'y', 'z', 'px', 'py', 'pz', 'zoom', 'roll'];
  var _splCache = { track: null, K: null };

  function _splineKnots(track) {
    var T = [], V = [], H = [], i, c;
    for (i = 0; i < track.length; i++) {
      var kf = track[i];
      var f = fill(kf, track[i - 1] || null);
      /* 同一个 t 上挂两个 KF（合法用法：前后段用不同缓动）⇒ 必须**合并**，
         否则 dt=0 会让切线除零、整条曲线变 NaN。后写者赢。 */
      if (T.length && kf.t <= T[T.length - 1]) {
        var j = T.length - 1;
        for (c = 0; c < _SPCH.length; c++) V[j][_SPCH[c]] = f[_SPCH[c]];
        H[j] = H[j] || !!kf.hold;
        continue;
      }
      T.push(kf.t);
      var row = {};
      for (c = 0; c < _SPCH.length; c++) row[_SPCH[c]] = f[_SPCH[c]];
      V.push(row); H.push(!!kf.hold);
    }
    return { T: T, V: V, H: H, n: T.length };
  }

  function _splineTan(T, V, H, ch, n) {
    var m = new Array(n), d = new Array(n > 1 ? n - 1 : 1), i;
    if (n === 1) { m[0] = 0; return m; }
    for (i = 0; i < n - 1; i++) d[i] = (V[i + 1][ch] - V[i][ch]) / (T[i + 1] - T[i]);
    /* 一阶：给每个结点一个斜率 */
    m[0] = (H[0] || d[0] === 0) ? 0 : d[0];     /* 开场：有位移就在动（消片头死区） */
    m[n - 1] = 0;                                /* 收尾停稳 */
    for (i = 1; i < n - 1; i++) {
      if (H[i]) { m[i] = 0; continue; }                    /* 显式 hold：刹停 */
      if (d[i - 1] * d[i] <= 0) { m[i] = 0; continue; }    /* 真折返：速度过零是对的 */
      m[i] = (d[i - 1] + d[i]) / 2;
    }
    /* 二阶：**逐段**做 Fritsch–Carlson 单调限制（α² + β² ≤ 9）。
       ⚠️⚠️ 必须**逐段**，不能逐结点。逐结点的写法只约束「这个斜率相对它两侧的割线」，
         段内仍可能冲出端点再拐回来 —— 实测 S8 的 z 走成 1580→1453→1459→1450，
         就是一次可见的「冲完回弹」，而逐结点判据当时是**通过**的。
         迭代 3 遍：缩放 m[i+1] 会牵连下一段，单遍可能留下残余越界。 */
    for (var pass = 0; pass < 3; pass++) {
      var fixed = true;
      for (i = 0; i < n - 1; i++) {
        if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
        var al = m[i] / d[i], be = m[i + 1] / d[i];
        var ss = al * al + be * be;
        if (ss > 9) {
          var tau = 3 / Math.sqrt(ss);
          m[i] *= tau; m[i + 1] *= tau;
          fixed = false;
        }
      }
      if (fixed) break;
    }
    return m;
  }

  function _hermite(v0, v1, m0, m1, h, k) {
    var k2 = k * k, k3 = k2 * k;
    return (2 * k3 - 3 * k2 + 1) * v0 + (k3 - 2 * k2 + k) * h * m0
         + (-2 * k3 + 3 * k2) * v1 + (k3 - k2) * h * m1;
  }

  function sampleSmooth(track, t) {
    if (!track || !track.length) return fill({}, null);
    if (track !== _splCache.track) _splCache = { track: track, K: _splineKnots(track) };
    var K = _splCache.K, n = K.n;
    if (n === 1 || t <= K.T[0]) return _row(K.V[0]);
    if (t >= K.T[n - 1]) return _row(K.V[n - 1]);
    var i = 0;
    while (i < n - 2 && K.T[i + 1] <= t) i++;
    var h = K.T[i + 1] - K.T[i], k = (t - K.T[i]) / h, o = {}, c;
    for (c = 0; c < _SPCH.length; c++) {
      var ch = _SPCH[c], m = _splineTan(K.T, K.V, K.H, ch, n);
      o[ch] = _hermite(K.V[i][ch], K.V[i + 1][ch], m[i], m[i + 1], h, k);
    }
    return o;
  }
  function _row(v) {
    var o = {}, c;
    for (c = 0; c < _SPCH.length; c++) o[_SPCH[c]] = v[_SPCH[c]];
    return o;
  }

  /**
   * 样条自检：**段内单调**（不许内部回弹）。返回违规清单，空数组 = 通过。
   *
   * 为什么判「单调」而不是判「过冲」：
   *   过冲（冲出端点）只是病的一种；更阴的是**段内拐回来**——
   *   实测 z 在 1580→1450 这段走成 1580→1453→1459→1450，两端都在界内、
   *   连「过冲」判据都骗过去了，观众看到的却是「冲完回弹一下」。
   *   所以判据必须是「相对割线方向不得反向」，这才等价于 Fritsch–Carlson 要保的性质。
   */
  function splineMonotone(track) {
    var K = _splineKnots(track), n = K.n, out = [], c, i, j;
    if (n < 2) return out;
    for (c = 0; c < _SPCH.length; c++) {
      var ch = _SPCH[c], m = _splineTan(K.T, K.V, K.H, ch, n);
      for (i = 0; i < n - 1; i++) {
        var v0 = K.V[i][ch], v1 = K.V[i + 1][ch];
        var h = K.T[i + 1] - K.T[i], dir = v1 - v0;
        if (dir === 0) continue;
        var tol = Math.abs(dir) * 1e-3, prev = v0, worst = 0;
        for (j = 1; j <= 24; j++) {
          var v = _hermite(v0, v1, m[i], m[i + 1], h, j / 24);
          var dv = v - prev;
          if (dv * dir < -tol) worst = Math.max(worst, -dv * dir / Math.abs(dir));
          prev = v;
        }
        if (worst) out.push({ ch: ch, seg: i, t0: K.T[i], t1: K.T[i + 1], rev: worst });
      }
    }
    return out;
  }

  // --- 摄影机矩阵 -----------------------------------------------------------
  /**
   * 生成 #camera 的 CSS transform。
   * 摄影机世界变换 Tc = T(C) · Ry(yaw) · Rx(pitch) · Rz(roll)
   * 世界节点渲染变换 = Tc⁻¹ = Rz(-roll) · Rx(-pitch) · Ry(-yaw) · T(-C)
   * CSS transform 列表从左到右即矩阵左乘，故顺序为：
   *   rotateZ(-roll) rotateX(-pitch) rotateY(-yaw) translate3d(-x,-y,-z)
   */
  function matrix(cam) {
    var la = lookAt(cam.x, cam.y, cam.z, cam.px, cam.py, cam.pz);
    return 'rotateZ(' + (-cam.roll).toFixed(4) + 'deg) ' +
           'rotateX(' + (-la.pitch).toFixed(4) + 'deg) ' +
           'rotateY(' + (-la.yaw).toFixed(4) + 'deg) ' +
           'translate3d(' + (-cam.x).toFixed(3) + 'px,' +
                            (-cam.y).toFixed(3) + 'px,' +
                            (-cam.z).toFixed(3) + 'px)';
  }

  /**
   * 把摄影机写进 DOM。
   * @param vp   透视容器（#viewport），被写 perspective
   * @param cam  摄影机节点（#camera），被写 transform
   * @param s    sample() 的结果，或直接传 TRACK + t
   */
  function apply(vp, cam, trackOrState, t) {
    var s = (t === undefined) ? trackOrState : sample(trackOrState, t);
    if (vp) vp.style.perspective = s.zoom.toFixed(2) + 'px';
    if (cam) cam.style.transform = matrix(s);
    return s;
  }

  // --- 距离 / 景深 ----------------------------------------------------------
  /** 摄影机到某个世界点的距离（用于景深、雾、LOD）。 */
  function dist(cam, px, py, pz) {
    var dx = px - cam.x, dy = py - cam.y, dz = pz - cam.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * 假景深：按离焦距离给叶子图层加 CSS blur。
   * @param el         叶子元素（面板本体，不能是 3D 容器）
   * @param camDist    摄影机到该图层的距离
   * @param focusDist  对焦距离（AE Focus Distance）
   * @param aperture   光圈(px)：越小景深越浅（AE Aperture 反比）
   * @param maxBlur    最大模糊 px（AE Blur Level 100% 的等效上限）
   */
  function dof(el, camDist, focusDist, aperture, maxBlur) {
    if (!el) return 0;
    aperture = aperture || 260; maxBlur = maxBlur || 12;
    var b = Math.abs(camDist - focusDist) / aperture * maxBlur;
    if (b > maxBlur) b = maxBlur;
    if (b < 0.35) b = 0;                       // 死区，避免亚像素抖动
    var v = b.toFixed(2);
    if (el.__dofCache !== v) { el.style.filter = b ? 'blur(' + v + 'px)' : 'none'; el.__dofCache = v; }
    return b;
  }

  /**
   * 距离雾：越远越淡（配合 opacity 使用；注意只能用于叶子）。
   * @returns 0..1 的可见度
   */
  function fog(camDist, near, far) {
    return 1 - clamp01((camDist - near) / (far - near || 1e-6));
  }

  // --- 手持抖动 -------------------------------------------------------------
  /** 确定性伪随机（同一 t 必得同值，保证逐帧截图可复现）。 */
  function hash1(n) { var s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); }

  /**
   * 手持/呼吸抖动，返回 {x,y,roll}。amp 像素，freq Hz。
   * 用三角函数叠加而非 Math.random()，确保 seek 任意帧结果一致。
   *
   * ⚠️ 为什么要两层（2026-09-10 调研后修正，原来只有低频一层，缺"人味"）：
   *   真实手持抖动 = 低频姿势漂移 + 高频生理震颤，两个频段缺一不可：
   *     · 姿势漂移（postural drift）0.5~3 Hz  —— 幅度大、方向连续，是观众主要看到的晃动
   *     · 生理震颤（physiological tremor）8~12 Hz —— 幅度只有主层的 12~18%，
   *       但正是它让画面"活"起来。Marshall & Walsh (1956) 测出人手持物时恒有
   *       8-12Hz 的近似正弦震颤；斯坦福 CS178 课件同口径 8-12 cps。
   *   只做低频 = 画面像在"漂"，加了高频才像"人在端着"。
   *
   * @param opts.tremor    高频层振幅比例（默认 0.16；0 = 关掉高频）
   * @param opts.tremorHz  高频层频率（默认 10，落在 8-12 区间）
   */
  function shake(t, amp, freq, opts) {
    amp = amp === undefined ? 6 : amp;
    freq = freq === undefined ? 1.7 : freq;
    opts = opts || {};
    var tHz = opts.tremorHz || 10;
    var tAmp = (opts.tremor == null ? 0.16 : opts.tremor) * amp;

    // 低频漂移层（两个非整数倍频叠加，避免看出周期）
    var a = t * freq * Math.PI * 2;
    var lx = Math.sin(a) * 0.6 + Math.sin(a * 2.31 + 1.7) * 0.4;
    var ly = Math.cos(a * 0.83 + 0.4) * 0.6 + Math.sin(a * 1.94) * 0.4;
    var lr = Math.sin(a * 0.61 + 2.2) * 0.035;

    // 高频震颤层（8-12 Hz，小振幅）
    var b = t * tHz * Math.PI * 2;
    var hx = Math.sin(b) * 0.7 + Math.sin(b * 1.73 + 0.9) * 0.3;
    var hy = Math.cos(b * 1.31 + 2.1) * 0.7 + Math.sin(b * 0.77) * 0.3;

    return {
      x: lx * amp + hx * tAmp,
      y: (ly * amp + hy * tAmp) * 0.7,
      roll: lr * amp + Math.sin(b * 0.9 + 1.1) * tAmp * 0.02
    };
  }

  // --- 轨道生成助手 ---------------------------------------------------------
  /**
   * 环绕机位：绕 POI 水平环绕。
   * @returns 关键帧数组片段
   */
  function orbit(t0, t1, steps, o) {
    o = o || {};
    var cx = o.px || 0, cy = o.py || 0, cz = o.pz || 0;
    var r = o.radius || 1600, h = o.height || 0;
    var a0 = (o.from === undefined ? 0 : o.from) * Math.PI / 180;
    var a1 = (o.to === undefined ? 90 : o.to) * Math.PI / 180;
    var out = [];
    for (var i = 0; i <= steps; i++) {
      var k = i / steps, a = lerp(a0, a1, k);
      out.push({
        t: lerp(t0, t1, k),
        x: cx + Math.sin(a) * r,
        y: cy + h,
        z: cz + Math.cos(a) * r,
        px: cx, py: cy, pz: cz,
        zoom: o.zoom, roll: o.roll,
        ease: i === 0 ? 'eio' : undefined
      });
    }
    return out;
  }

  /**
   * 希区柯克变焦（Dolly Zoom）：机位后退同时加长焦，主体大小不变、背景压缩感剧变。
   * @param d0/d1 起止「摄影机到主体距离」，zoom 会按 zoom = d + k 同步变化
   */
  function dollyZoom(t0, t1, d0, d1, poi) {
    poi = poi || { px: 0, py: 0, pz: 0 };
    var k0 = 1400 - d0;                       // 保持主体投影大小恒定
    return [
      { t: t0, x: poi.px, y: poi.py, z: poi.pz + d0, zoom: d0 + k0, px: poi.px, py: poi.py, pz: poi.pz },
      { t: t1, x: poi.px, y: poi.py, z: poi.pz + d1, zoom: d1 + k0, px: poi.px, py: poi.py, pz: poi.pz }
    ];
  }

  g.CAM3D = {
    clamp01: clamp01, lerp: lerp, ei: ei, eo: eo, eio: eio, c1: c1, ease: ease,
    /* ★ 供工程自检用：`_sceneCheck()` 拿它验证 CAMTRACK 里每个 ease 名都合法。
       没有这条判据的话，"名字写错 → 静默回落 eio"只能靠肉眼比对，必然漏。 */
    listEasings: function () { return EASE_NAMES.slice(); },
    sm: sm, qi: qi, qo: qo, qio: qio, xi: xi, xo: xo, xio: xio,
    ci: ci, co: co, cio: cio,
    bi: bi, bo: bo, bio: bio, eli: eli, elo: elo, bno: bno,
    snapo: snapo, snapio: snapio,
    focalToZoom: focalToZoom, fovToZoom: fovToZoom, zoomToFov: zoomToFov,
    lookAt: lookAt, sample: sample, sampleSmooth: sampleSmooth,
    splineMonotone: splineMonotone, matrix: matrix, apply: apply,
    dist: dist, dof: dof, fog: fog,
    shake: shake, orbit: orbit, dollyZoom: dollyZoom,
    DEFAULT: DEFAULT
  };
})(window);
