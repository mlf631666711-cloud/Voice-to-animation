/**
 * camera-shots.js —— 「运镜配方库」：把 AE 里的常见镜头抽象成可组合的 API
 *
 * 定位：camera3d.js（几何）+ camera-lens.js（光学）之上，给「我做视频」用的语义化层。
 * 设计原则：
 *   1. 一句话调用一个镜头 → 自动生成完整 TRACK 关键帧；
 *   2. 围绕「主体」描述（subject 参数），而不是手算机位坐标；
 *   3. 可链式组合（shot.orbit(...).push(...).crane(...)）；
 *   4. 与既有管线 100% 兼容（输出 = CAM3D.sample 接受的 TRACK 数组）。
 *
 * 用法：
 *   const TRACK = [
 *     ...{ t: 0, x:0, y:0, z:900, px:0, py:0, pz:0, zoom:1100, roll:0, focus:1600 },
 *     ...CAMSHOTS.orbit({ subject: {x:0,y:0,z:0}, angleDeg: 90, radius: 1200, dur: 4 }),
 *     ...CAMSHOTS.dolly({ subject: {x:0,y:0,z:0}, dist: -500, dur: 3 })
 *   ];
 *
 *   // 链式：
 *   const TRACK2 = CAMSHOTS.orbit({subject, angleDeg:90, radius:1200, dur:4})
 *                      .then(CAMSHOTS.dolly({subject, dist:-300, dur:2}))
 *                      .track;
 *
 * ---------------------------------------------------------------------------
 * 单位约定（与 camera3d.js 一致）
 * ---------------------------------------------------------------------------
 *   世界坐标 px，1mm = compW / filmW px (1920/36 ≈ 53.3)
 *   时间 s，缓动函数来自 CAM3D.eio / eo / ei / lin
 *   「主体」可以是 {x,y,z} 或字符串（state.layers 里的面板 id，自动解析）
 *   「起点」不指定时 = 当前 state.cam（由调用方传入）或最近一个关键帧
 */

(function (g) {
  'use strict';

  var CAM3D = g.CAM3D || {};
  var FX = CAM3D;
  function lerp(a, b, k) { return a + (b - a) * k; }
  function clamp01(k) { return k < 0 ? 0 : k > 1 ? 1 : k; }
  function ease(name, k) { return (FX.ease || function(n, x){ return n==='lin'?x:n==='ei'?x*x*x:n==='eo'?1-Math.pow(1-x,3):x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2; })(name, k); }
  function vec3(x, y, z) { return { x: x||0, y: y||0, z: z||0 }; }
  function dist3(a, b) { var dx=b.x-a.x, dy=b.y-a.y, dz=b.z-a.z; return Math.sqrt(dx*dx+dy*dy+dz*dz); }
  function norm3(a) { var l = Math.sqrt(a.x*a.x+a.y*a.y+a.z*a.z) || 1; return { x: a.x/l, y: a.y/l, z: a.z/l }; }
  function sub3(a, b) { return { x: a.x-b.x, y: a.y-b.y, z: a.z-b.z }; }
  function add3(a, b) { return { x: a.x+b.x, y: a.y+b.y, z: a.z+b.z }; }
  function scale3(a, s) { return { x: a.x*s, y: a.y*s, z: a.z*s }; }

  /**
   * 主体解析：接受 {x,y,z} 或 字符串面板 id（自动从全局 state.layers 找）
   */
  function resolveSubject(s, state) {
    if (!s) return { x: 0, y: 0, z: 0 };
    if (typeof s === 'string') {
      var layer = (state && state.layers || []).find(function (l) { return l.id === s || l.name === s; });
      if (!layer) {
        // 退化：从窗口全局里找
        try {
          var S = g.state;
          layer = S && S.layers && S.layers.find(function (l) { return l.id === s || l.name === s; });
        } catch (e) {}
      }
      if (layer) return { x: layer.x, y: layer.y, z: layer.z };
      throw new Error('[camera-shots] 找不到主体 "' + s + '"');
    }
    return vec3(s.x, s.y, s.z);
  }

  /**
   * KF = keyframe（除 t 外的字段都可以从 prev / next 插值得到）
   * 主路径：所有 builder 都返回 KF[]，可直接 spread 到用户轨道里。
   */
  function kf(t, cam, poi, zoom, roll, focus, easeName) {
    return {
      t: t,
      x: cam.x, y: cam.y, z: cam.z,
      px: poi.x, py: poi.y, pz: poi.z,
      zoom: zoom, roll: roll || 0,
      focus: focus || 1500,
      ease: easeName || 'eio'
    };
  }

  // -------------------------------------------------------------------------
  // 工具：从「当前 t / 当前 cam」推出起点
  // -------------------------------------------------------------------------
  /**
   * 用法：CAMSHOTS._startFrom(8, state) → { cam, t, focus }
   *   cam = 最近关键帧在 t 时的采样值（或 state.cam）
   */
  function startFrom(opts) {
    opts = opts || {};
    var t0 = opts.currentT || 0;
    var state = opts.state || g.state || {};
    // 起点 cam：优先用 opts.fromCam，其次 sample(state.tracks, t0)，最后 state.cam
    var cam;
    if (opts.fromCam) cam = Object.assign({}, opts.fromCam);
    else if (state.tracks && state.tracks.length) cam = CAM3D.sample(state.tracks, t0);
    else cam = Object.assign({}, state.cam || { x:0, y:0, z:900, px:0, py:0, pz:0, zoom:1100, roll:0, focus:1600 });
    return { cam: cam, t0: t0 };
  }

  // =========================================================================
  // 1. dolly —— 沿「摄影机 → 主体」方向推进/拉远
  // =========================================================================
  /**
   * @param {Object} opts
   *   subject {x,y,z} | 'panel-id'    主体（POI）
   *   dist    number  推进距离（正=推进 / 拉近，负=后退 / 拉远）
   *   dur     number  时长（秒）
   *   ease    'eio'|'eo'|'ei'|'lin'   缓动
   *   fromCam {x,y,z,px,py,pz,...}   起点机位（可选）
   *   currentT number                起始时间（默认 0）
   *   zoom    number                 是否同步加 zoom（希区柯克用法）
   *   easeZoom 'eio'|...             zoom 缓动（默认与 ease 一致）
   * @returns KF[]
   */
  function dolly(opts) {
    opts = opts || {};
    var sub = resolveSubject(opts.subject, opts.state);
    var s = startFrom(opts);
    var dir = norm3(sub3(sub, s.cam));
    var end = add3(s.cam, scale3(dir, opts.dist || 0));
    // ⚠️ zoom 缺省必须继承当前机位，否则末帧 zoom = undefined（整条轨道变 NaN）
    var zoom = (opts.zoom != null && opts.zoom !== '') ? +opts.zoom : s.cam.zoom;
    var endZoom = zoom;
    if (opts.zoom) {
      // dolly-zoom：保持主体在画面中大小恒定；zoom += dist（简化版）
      endZoom = zoom + (opts.dist || 0) * (zoom / Math.max(dist3(s.cam, sub), 1));
    }
    var t1 = s.t0 + (opts.dur || 2);
    return [
      kf(s.t0, s.cam, sub, zoom, s.cam.roll, s.cam.focus, opts.ease || 'eio'),
      kf(t1, end, sub, endZoom, s.cam.roll, s.cam.focus, opts.ease || 'eio')
    ];
  }

  // =========================================================================
  // 2. orbit —— 环绕主体水平旋转
  // =========================================================================
  /**
   * @param {Object} opts
   *   subject {x,y,z}|id     主体
   *   radius  number         环绕半径（默认用当前距离）
   *   angleDeg number        旋转角度（顺时针为正）
   *   dur     number         时长
   *   height  number         摄影机 y 值（默认沿用当前）
   *   roll    number         roll 度数（默认沿用）
   *   ease    string         缓动
   *   fromCam, currentT
   *   keepAltitude boolean   true=始终保持 startY（默认 true）
   * @returns KF[]
   */
  function orbit(opts) {
    opts = opts || {};
    var sub = resolveSubject(opts.subject, opts.state);
    var s = startFrom(opts);
    // ★ 半径口径（2026-09-17 修正）：`camAt()` 里 r 是**水平半径**
    //   （`x = sub.x + sin(a)*r`、`z = sub.z + cos(a)*r`），所以默认值也必须是**水平距离**。
    //   原来取的是 `dist3`（3D 距离，含 y 差）—— 当相机与主体有高度差时 r 偏大，
    //   于是"approach 到位 → orbit 起弧"的接缝上横向被推远一截：
    //   rv1106-seg1 实测 dist=1600/height=−260 ⇒ 3D 1621 vs 水平 1600，差 21 world 单位，
    //   在 1641 距离上换算 ≈ **34px 的瞬时横移**（J10 抓到）。
    //   取水平距离后，orbit 的首帧位置与 approach 的收尾帧**逐位相同**（atan2/hypot 互为逆运算）。
    var startR = Math.hypot(s.cam.x - sub.x, s.cam.z - sub.z);
    var r = opts.radius != null ? opts.radius : startR;
    // 起点方位：水平投影（忽略 y）
    var dx0 = s.cam.x - sub.x, dz0 = s.cam.z - sub.z;
    var a0 = Math.atan2(dx0, dz0);             // 与 atan2(z, x) 略有区别；保持现有 API
    var angle = (opts.angleDeg || 90) * Math.PI / 180;
    var a1 = a0 + angle;
    var startY = opts.height != null ? opts.height : s.cam.y;
    var endY = opts.keepAltitude !== false ? startY : s.cam.y;
    var t1 = s.t0 + (opts.dur || 4);
    function camAt(a) {
      return {
        x: sub.x + Math.sin(a) * r,
        y: lerp(startY, endY, clamp01((a - a0) / (a1 - a0))),
        z: sub.z + Math.cos(a) * r
      };
    }
    // 中间加 1 关键帧（让插值走圆弧而非直线）
    // ★ 子段缓动走 chainEase：2 个子段 = 首 `ei` / 末 `eo`，
    //   合起来**精确等于**调用方要的那条 `eio`（凑不出中途停顿）。
    var mid = (a0 + a1) / 2;
    return [
      kf(s.t0, { x: sub.x + Math.sin(a0)*r, y: startY, z: sub.z + Math.cos(a0)*r }, sub, s.cam.zoom, s.cam.roll, s.cam.focus, chainEase(opts.ease, 0, 2)),
      kf((s.t0 + t1) / 2, camAt(mid), sub, s.cam.zoom, s.cam.roll, s.cam.focus, chainEase(opts.ease, 1, 2)),
      kf(t1, camAt(a1), sub, s.cam.zoom, s.cam.roll, s.cam.focus, 'eo')
    ];
  }

  // =========================================================================
  // 0. 多关键帧运动的「段缓动链」—— 一条连续运动 = 一条速度包线
  // =========================================================================
  /* 为什么必须专门处理：
   *   曲线采样型配方（crane / orbit / approach(lift,swing)）会把**一条**缓动曲线
   *   采样成 N 个子段。原实现给**每个子段都套同一个 `eio`** ⇒ 每个接缝两侧速度都归零
   *   ⇒ 相机**走一节、停一下**。
   *   2026-09-17 实测（rv1106-seg1，J9 接缝速度）：全片 **7 处中途停顿** ——
   *   段内峰值速度 1143~7573 world/s，而接缝处只剩 1~47 world/s；
   *   位移却有 200~700 world 单位 ⇒ 观众看到的是"一顿一顿"，不是"一条运镜"。
   *   而所有既有判据全绿（它们只查缓动名合不合法，不查接缝速度）。
   *
   * 正解：中间子段**只做路径采样插值**（`lin`），位置仍按目标缓动采样 ⇒ **曲线形状一点没丢**；
   *       运动性格只由**首段 `ei`（软起）+ 末段 `eo`（软收）**给。
   *       而 `ei`+`eo` 链在等分情形下**精确等于一条 `eio`**：
   *         eio(u) = 4u³ (u≤½) / 1−4(1−u)³ (u>½) ⇒ eio(u) = ½·ei(2u) (u≤½) 且 = ½+½·eo(2u−1) (u>½)。
   *       所以拆开**不改变曲线**，只去掉"每一小节都停一下"。
   *
   * ⚠️ 单边急缓动（`xo`/`bo`/`qo`/`co`/`xio`/`bio`…）**原理上不可拆**：
   *    它们的"急"就住在起点上，拆成子段必然在接缝处重新加速 ⇒ 突跳。
   *    这类意图必须**一次到位（2 帧）**，所以多帧配方遇到它们**直接抛错**，
   *    绝不静默降级成 eio（静默假成功是最大敌人）。
   */
  var SEG_UNSPLITTABLE = ['xo', 'xio', 'bo', 'bio', 'qo', 'qio', 'co', 'cio',
                          'eli', 'elo', 'snapo', 'snapio', 'bno'];

  /**
   * @param {string} name 调用方声明的整体缓动
   * @param {number} i    第几个子段（0 起）
   * @param {number} n    子段总数（= 关键帧数 − 1）
   * @returns {string}    该子段真正应该播放的缓动名
   */
  function chainEase(name, i, n) {
    name = name || 'eio';
    if (n <= 1) return name;                      /* 只有一段：整体缓动直接生效，没什么可链的 */
    if (SEG_UNSPLITTABLE.indexOf(name) >= 0) {
      throw new Error('缓动 "' + name + '" 是单边急缓动，无法拆成 ' + n + ' 个子段 ——'
        + '它的"急"住在起点上，拆开必然在接缝处重新加速（观众看到的是突跳）。'
        + '要么压成一次到位的 2 帧（去掉 steps / arc / lift / swing），要么换成可拆的 "eio"。');
    }
    if (name === 'lin') return 'lin';
    if (name === 'ei') return i === 0 ? 'ei' : 'lin';       /* 只要软起，末段匀速收 */
    if (name === 'eo') return i === n - 1 ? 'eo' : 'lin';   /* 只要软收，前段匀速起 */
    if (i === 0) return 'ei';                     /* 软起 */
    if (i === n - 1) return 'eo';                 /* 软收 */
    return 'lin';                                 /* 中段：路径采样插值（匀速巡航） */
  }

  // =========================================================================
  // 3. crane —— 摇臂：从 yA 升降到 yB（带水平位移）
  // =========================================================================
  /**
   * @param {Object} opts
   *   fromY, toY      number    摄影机起止高度（不指定 = 沿用当前）
   *   fromPos, toPos {x,z}     摄影机起止水平位置（不指定 = 沿用当前）
   *   subject        {x,y,z}   POI
   *   dur            number
   *   ease           string
   *   steps          number    中间帧数（**只在有 arc 时有意义**，见下）
   *   arc            number    弧线峰值高度（>0 时 y 多项式先上扬再下降，类似摇臂）
   *
   * ⚠️ `steps` 的陷阱（2026-09-17 实测）：没有 `arc` 时，中间帧的位置
   *    `lerp(fromY,toY,ease(k))` **精确落在起点→终点的直线上**，是**纯冗余**；
   *    可它却会强制把一条缓动拆成 N 段、每段重新 `eio` ⇒ 相机中途停顿（见 chainEase 注释）。
   *    ⇒ 所以**无 arc 时一律只发 2 帧**（几何零变化），`steps` 只在有弧线时才起作用。
   */
  function crane(opts) {
    opts = opts || {};
    // 【BUG-2011 守卫】crane 的升降参数叫 fromY/toY（+ fromPos/toPos），
    // 不是 approach 那套 height/dist。写错时它**不会报错**，只会把 fromY=toY=当前y，
    // 结果就是一个「什么都没动、只把视线切到新主体」的空操作 ——
    // 分镜表上写着"从高处俯瞰缓缓下降"，成片里摄影机纹丝不动。
    ['height', 'dist', 'azimuth', 'lift', 'swing'].forEach(function (bad) {
      if (opts[bad] != null) {
        throw new Error('crane 不认 "' + bad + '" 参数（它属于 approach）。'
          + 'crane 的升降用 fromY/toY，平移用 fromPos/toPos（{x,z}），抬头弓形用 arc。'
          + '收到：' + JSON.stringify(opts));
      }
    });
    var sub = resolveSubject(opts.subject, opts.state);
    var s = startFrom(opts);
    var fromY = opts.fromY != null ? opts.fromY : s.cam.y;
    var toY = opts.toY != null ? opts.toY : s.cam.y;
    var fromXZ = opts.fromPos || { x: s.cam.x, z: s.cam.z };
    var toXZ = opts.toPos || { x: s.cam.x, z: s.cam.z };
    var steps = opts.arc ? (opts.steps || 2) : 1;   /* 无 arc ⇒ 只发 2 帧（中间帧是直线上的冗余点） */
    var dur = opts.dur || 4;
    var out = [];
    for (var i = 0; i <= steps; i++) {
      var k = i / steps, e = ease(opts.ease || 'eio', k);
      var y = lerp(fromY, toY, e);
      if (opts.arc) {
        var arc = Math.sin(k * Math.PI) * opts.arc;
        y += arc;
      }
      var cam = {
        x: lerp(fromXZ.x, toXZ.x, e),
        y: y,
        z: lerp(fromXZ.z, toXZ.z, e)
      };
      /* 末帧的 ease 管的是「下一段」（若后续配方在同一时刻起帧，会被同 t 去重吃掉）。
         给它 'eo' = 交给下一段的起势默认是"软起"，别把本段的收势硬塞过去。 */
      var eOut = (i === steps) ? 'eo' : chainEase(opts.ease, i, steps);
      out.push(kf(s.t0 + k * dur, cam, sub, s.cam.zoom, s.cam.roll, s.cam.focus, eOut));
    }
    return out;
  }

  // =========================================================================
  // 4. dollyZoom —— 希区柯克变焦
  // =========================================================================
  /**
   * @param opts (同 dolly) + extra
   *   focalMm  number  焦距（用于精确计算 zoom；不指定则用 dolly 的近似）
   *   filmW    number  默认 36
   *   compW    number  默认 1920
   */
  function dollyZoom(opts) {
    opts = Object.assign({}, opts);
    opts.zoom = opts.zoom || (startFrom(opts).cam.zoom);
    return dolly(opts);
  }

  // =========================================================================
  // 5. parallax —— 多层视差横摇（多平面横移）
  // =========================================================================
  /**
   * @param opts
   *   plane    [{z, speed}]   z = 深度（负数=远），speed = 横向位移系数（1=随摄影机，0=不动）
   *   dur      number
   *   subject  POI
   *   ease     string
   *   panPx    number         总横移像素（默认自动 = 前后景速度差 × dur × 60）
   */
  function parallax(opts) {
    opts = opts || {};
    var sub = resolveSubject(opts.subject, opts.state);
    var s = startFrom(opts);
    var planes = opts.planes || [
      { z: -2000, speed: 0.3 },   // 远景（天空 / 城市天际线）
      { z: -800, speed: 0.7 },     // 中景（背景）
      { z: 0, speed: 1.0 },        // 主体
      { z: 600, speed: 1.4 }       // 近景（前景遮挡物）
    ];
    var panPx = opts.panPx != null ? opts.panPx : 1200;
    var dur = opts.dur || 4;
    var t1 = s.t0 + dur;
    var out = [];
    // 每个平面生成一对 KF（横向位移）
    planes.forEach(function (p) {
      var dx = panPx * (1 - p.speed) * (p.speed >= 0 ? 1 : -1);
      var startCam = { x: s.cam.x, y: s.cam.y, z: s.cam.z + p.z };
      var endCam = { x: s.cam.x + dx, y: s.cam.y, z: s.cam.z + p.z };
      out.push(kf(s.t0, startCam, sub, s.cam.zoom, s.cam.roll, s.cam.focus, opts.ease || 'eio'));
      out.push(kf(t1, endCam, sub, s.cam.zoom, s.cam.roll, s.cam.focus, opts.ease || 'eio'));
    });
    return out;
  }

  // =========================================================================
  // 6. dutchTilt —— 荷兰角（roll 倾斜）
  // =========================================================================
  /**
   * @param opts
   *   rollDeg  number   目标 roll（度）
   *   dur      number   时长
   *   ease     string
   */
  function dutchTilt(opts) {
    opts = opts || {};
    var s = startFrom(opts);
    var t1 = s.t0 + (opts.dur || 1);
    return [
      kf(s.t0, s.cam, { x: s.cam.px, y: s.cam.py, z: s.cam.pz }, s.cam.zoom, s.cam.roll, s.cam.focus, opts.ease || 'eio'),
      kf(t1, s.cam, { x: s.cam.px, y: s.cam.py, z: s.cam.pz }, s.cam.zoom, opts.rollDeg || 15, s.cam.focus, 'eo')
    ];
  }

  // =========================================================================
  // 7. push / pull —— 快速推进/拉远（speed-ramp 风格）
  // =========================================================================
  function push(opts) {
    opts = Object.assign({}, opts, { ease: opts.ease || 'ei' });  // ease-in 默认
    return dolly(opts);
  }
  function pull(opts) {
    opts = Object.assign({}, opts, { dist: -Math.abs(opts.dist || 500), ease: opts.ease || 'eo' });
    return dolly(opts);
  }

  // =========================================================================
  // 8. rackFocus —— 焦点从 subjectA 转到 subjectB
  // =========================================================================
  /**
   * @param opts
   *   from  {x,y,z}|id   对焦起点主体
   *   to    {x,y,z}|id   对焦终点主体
   *   dur   number
   *   ease  string
   */
  function rackFocus(opts) {
    opts = opts || {};
    var a = resolveSubject(opts.from, opts.state);
    var b = resolveSubject(opts.to, opts.state);
    var s = startFrom(opts);
    var f1 = dist3(s.cam, a);
    var f2 = dist3(s.cam, b);
    var t1 = s.t0 + (opts.dur || 1.5);
    return [
      kf(s.t0, s.cam, { x: s.cam.px, y: s.cam.py, z: s.cam.pz }, s.cam.zoom, s.cam.roll, f1, opts.ease || 'eio'),
      kf(t1, s.cam, { x: s.cam.px, y: s.cam.py, z: s.cam.pz }, s.cam.zoom, s.cam.roll, f2, opts.ease || 'eio')
    ];
  }

  // =========================================================================
  // 9b. approach —— 飞到「主体正前方 N 距离」的机位（换集群/转场的主力）
  // =========================================================================
  /**
   * 为什么需要它：flyTo(to:"B") 会把机位摆在 B 身上，机位 == POI → lookAt 退化、
   * 方向乱掉。approach 保证「人站在主体前面 dist 处看着它」，这是最常用的取景。
   *
   * @param opts
   *   subject  {x,y,z}|id   目标主体
   *   dist     number       站多远（默认 1200）
   *   azimuth  number       方位角（度）：0 = 正面(+Z)，90 = 右侧，180 = 背面
   *   height   number       机位相对主体的高度（负 = 抬高，因为 CSS Y 轴向下）
   *   look     {x,y,z}|id   看向哪（缺省 = subject 自己）
   *   dur / ease / zoom / roll
   */
  function approach(opts) {
    opts = opts || {};
    var sub = resolveSubject(opts.subject, opts.state);
    var s = startFrom(opts);
    var dist = opts.dist != null ? opts.dist : 1200;
    var az = (opts.azimuth || 0) * Math.PI / 180;
    var h = opts.height != null ? opts.height : 0;
    var end = {
      x: sub.x + Math.sin(az) * dist,
      y: sub.y + h,
      z: sub.z + Math.cos(az) * dist
    };
    var look = (opts.look != null && opts.look !== opts.subject)
      ? resolveSubject(opts.look, opts.state) : sub;
    var t1 = s.t0 + (opts.dur || 2);
    var startPOI = { x: s.cam.px, y: s.cam.py, z: s.cam.pz };
    var zEnd = opts.zoom || s.cam.zoom;
    var rEnd = opts.roll != null ? opts.roll : s.cam.roll;
    var fEnd = opts.focus || s.cam.focus;

    // Arc 原则（12 原则之一）：直线飞行是机器人的走法。
    // lift / swing 让中途关键帧偏出一条弧线，画面立刻"有肉"。
    if (!opts.lift && !opts.swing) {
      return [
        // 起点 KF 的 POI 沿用当前，避免换主体时视线硬切；终点才看向新主体
        // 末帧的 'eo' 管的是「下一段」（同 t 去重后会由它接手），不是本段 —— 本段只有一段，
        // 缓动由首帧给，所以 opts.ease 在这里**是生效的**。
        kf(s.t0, s.cam, startPOI, s.cam.zoom, s.cam.roll, s.cam.focus, opts.ease || 'eio'),
        kf(t1, end, look, zEnd, rEnd, fEnd, 'eo')
      ];
    }
    var lift = opts.lift || 0, swing = opts.swing || 0;
    var tm = s.t0 + (t1 - s.t0) * 0.5;
    // 水平面内垂直于「起点→终点」的单位向量
    var dx = end.x - s.cam.x, dz = end.z - s.cam.z;
    var len = Math.sqrt(dx * dx + dz * dz) || 1;
    var sx = -dz / len, sz = dx / len;
    var flat = {
      x: (s.cam.x + end.x) / 2,
      y: (s.cam.y + end.y) / 2 - lift,      // CSS Y 向下，lift > 0 = 抬高
      z: (s.cam.z + end.z) / 2
    };
    var midPOI = {
      x: (startPOI.x + look.x) / 2,
      y: (startPOI.y + look.y) / 2,
      z: (startPOI.z + look.z) / 2
    };
    // ★ 安全（BUG-2009）：横向甩动必须挑「远离 POI」的一侧甩。
    //   甩到 POI 那一侧时中间帧会几乎压在观察点上（dist→0），
    //   lookAt 随即退化 → 画面疯狂旋转。
    var pPlus  = { x: flat.x + sx * swing, y: flat.y, z: flat.z + sz * swing };
    var pMinus = { x: flat.x - sx * swing, y: flat.y, z: flat.z - sz * swing };
    var sign = dist3(pPlus, midPOI) >= dist3(pMinus, midPOI) ? 1 : -1;
    var mid = { x: flat.x + sign * sx * swing, y: flat.y, z: flat.z + sign * sz * swing };
    // 兜底：换边后还是太近，就把中间帧沿「POI→cam」方向按比例推出去
    var safe = Math.min(dist3(s.cam, startPOI), dist3(end, look)) * 0.55;
    var dm = dist3(mid, midPOI);
    if (dm < safe && dm > 1e-6) {
      var q = safe / dm;
      mid.x = midPOI.x + (mid.x - midPOI.x) * q;
      mid.y = midPOI.y + (mid.y - midPOI.y) * q;
      mid.z = midPOI.z + (mid.z - midPOI.z) * q;
    }
    return [
      kf(s.t0, s.cam, startPOI, s.cam.zoom, s.cam.roll, s.cam.focus, chainEase(opts.ease, 0, 2)),
      /* ★ 中间帧的缓动**必须参与段链**。原实现把它硬编码成 'eio'：
         结果是"带弧线的逼近"中途必然停一下（rv1106-seg1 实测 7.94s 处
         位移 653/708 world 单位，接缝速度只剩峰值的 0.4%），
         而且 spec 里写的 `xo`(要"冲")被这一帧静默改成了软起 —— 又一处死参数。 */
      kf(tm, mid, midPOI, (s.cam.zoom + zEnd) / 2, (s.cam.roll + rEnd) / 2, fEnd, chainEase(opts.ease, 1, 2)),
      kf(t1, end, look, zEnd, rEnd, fEnd, 'eo')
    ];
  }

  // =========================================================================
  // 8.5 level —— roll 归零（★ 必配 dutchTilt）
  // =========================================================================
  /**
   * dutchTilt 只是把 roll 推到某个角度，不会自己回正。
   * 不显式调 level，歪掉的 roll 会一路带到片尾（BUG-2008）。
   * 用法：tilt 完立刻跟一条 level。
   */
  function level(opts) {
    opts = opts || {};
    var s = startFrom(opts);
    var t1 = s.t0 + (opts.dur || 0.5);
    var poi = { x: s.cam.px, y: s.cam.py, z: s.cam.pz };
    return [
      kf(s.t0, s.cam, poi, s.cam.zoom, s.cam.roll, s.cam.focus, opts.ease || 'eio'),
      kf(t1, s.cam, poi, s.cam.zoom, 0, s.cam.focus, opts.ease || 'eo')
    ];
  }

  // =========================================================================
  // 8.6 snapZoom —— 冲 + 修正（★ 商业级 MG 的招牌手感）
  // =========================================================================
  /**
   * Joey Korenman(School of Motion) snap zoom 的数字化：
   * 猛推到 1+overshoot → 停 → 微微回拉"修正"，观众会觉得镜头是"人"端着的。
   * 三个关键帧：0 → 0.72(冲过) → 1.0(回落)
   *
   * @param opts
   *   dist       number  推进距离（正=推近）
   *   overshoot  number  冲过头比例（默认 0.08 = 8%）
   *   dur        number  总时长（推荐 0.4~0.8，越短越"脆"）
   */
  function snapZoom(opts) {
    opts = opts || {};
    var sub = resolveSubject(opts.subject, opts.state);
    var s = startFrom(opts);
    var dir = norm3(sub3(sub, s.cam));
    var dist = opts.dist != null ? opts.dist : 400;
    var ov = opts.overshoot != null ? opts.overshoot : 0.08;
    // ★ 安全下限：back 类缓动会沿路径过冲，径向推进时过冲 = 冲向主体，
    //   冲过头会一头扎进卡片里（dist < 卡片半宽 → 透视炸裂 / 穿模）。
    //   minDist 默认 220（≥ 卡片半宽 590 的 1/3，仍是很紧的特写）。
    var minDist = opts.minDist != null ? opts.minDist : 220;
    var d0 = dist3(s.cam, sub);
    if (d0 - dist * (1 + ov) < minDist) {
      dist = Math.max(0, (d0 - minDist) / (1 + ov));
    }
    var end = add3(s.cam, scale3(dir, dist));
    var over = add3(s.cam, scale3(dir, dist * (1 + ov)));
    var zoom = (opts.zoom != null && opts.zoom !== '') ? +opts.zoom : s.cam.zoom;
    var dur = opts.dur || 0.6;
    var roll = opts.roll != null ? opts.roll : s.cam.roll;
    /* ⚠️⚠️ 2026-09-17 修：**缓动归属整体晚了一个关键帧**。
     *
     * 本引擎（`camera3d.js` 的 CAMTRACK 采样）里，**一条 KF 上的 `ease` 管的是
     * 「从这条 KF 起、到下一帧」的那一段**，不是到它为止的那一段。
     * 佐证：`level()` 就是按这个约定写的 —— ease 写在**第一条** kf 上（见本文件 level 段），
     * 所以在 rv1106-seg1 里 `level{ease:'eo'}` 落地的确实是 9.06→9.48 那一段。
     *
     * 原来这三行按「ease 管到本帧为止」写 ⇒ 全部错位一格：
     *   · `s.t0` 那帧拿 'eio' ⇒ **暴冲段播成了对称钟形**（两头速度都归零），
     *     读起来是"缓缓加速推过去"，**不是猛推**；
     *   · `over` 那帧拿 'xo' ⇒ **缓回修正段播成了指数急出**：转点（极大值）上
     *     速度本应是 0，却从 0 直接跳到 837 world/s ⇒ 接缝处一个可见的"抽一下"；
     *   · 末帧的 'eo' 永远没有后继段 ⇒ 死代码。
     *
     * 症状在 rv1106-seg1 上实测（`_cam_check.cjs` 的 J9）：
     *   `11.906 eio → xo   v- 23 / v+ 837  ←突跳`。
     * 而 J8b 的"峰/均比 4.55 ✓"抓不到它 —— **对称钟形和暴冲的峰均比都能过线**，
     * 所以当时那个判据口径区分不了，一直没暴露。
     *
     * 修法：ease 归位到"管自己后面那一段"。
     *   暴冲段 = `xo`（指数缓出：前 25% 走完 82%，这才叫"冲"）
     *   缓回段 = `eio`（转点是速度零点，两端必须都归零，否则接缝必突跳）
     * 注意 `opts.ease` 只覆盖**暴冲段**；不要再把同一个名字同时写到三段上
     * （那是 `chainEase` 的活，这里三段是不同量级的运动）。
     */
    return [
      kf(s.t0, s.cam, sub, zoom, s.cam.roll, s.cam.focus, opts.ease || 'xo'),
      kf(s.t0 + dur * 0.72, over, sub, zoom, roll, s.cam.focus, 'eio'),  // 缓回修正
      kf(s.t0 + dur, end, sub, zoom, roll, s.cam.focus, 'eio')
    ];
  }

  // =========================================================================
  // 9. flyTo —— 直接飞到指定机位（无运镜过渡，仅写 KF）
  // =========================================================================
  /**
   * @param opts
   *   to    {x,y,z,px,py,pz,zoom,roll,focus}   目标机位
   *   dur   number
   *   ease  string
   */
  function flyTo(opts) {
    opts = opts || {};
    var s = startFrom(opts);
    var to = opts.to;
    var t1 = s.t0 + (opts.dur || 0.01);
    return [
      kf(s.t0, s.cam, { x: s.cam.px, y: s.cam.py, z: s.cam.pz }, s.cam.zoom, s.cam.roll, s.cam.focus, opts.ease || 'eio'),
      kf(t1,
        { x: to.x, y: to.y, z: to.z },
        { x: to.px, y: to.py, z: to.pz },
        to.zoom || s.cam.zoom, to.roll || 0, to.focus || s.cam.focus,
        /* 末帧 ease 是「交给下一段的手势」。原来是 `opts.ease || 'lin'` ——
           `opts.ease` 没传时它给下一段一个 `lin`，等于**静默把下一段变成匀速运动**
           （同 t 去重后下一段听这一帧的）。改成 'eo'：交给下一段的默认是"软起"。 */
        'eo')
    ];
  }

  // =========================================================================
  // 链式：Shot 包装对象
  // =========================================================================
  /**
   * 把任一 builder 的输出包成链式对象，可 .then() 继续拼接。
   *   CAMSHOTS.orbit({...}).then(CAMSHOTS.dolly({...})).then(CAMSHOTS.crane({...})).track
   */
  function Shot(keyframes) {
    if (!(this instanceof Shot)) return new Shot(keyframes);
    this.kfs = keyframes || [];
    this.lastT = this.kfs.length ? this.kfs[this.kfs.length - 1].t : 0;
  }
  Shot.prototype.then = function (next) {
    // 接受 builder 函数 / Shot 实例 / KF[]
    var more;
    if (typeof next === 'function') {
      var result = next({ currentT: 0 });   // 永远从 0 起，让 .then 接管续接
      more = (result && result.kfs) ? result.kfs : result;  // 兼容 Shot 或 KF[]
    } else if (next instanceof Shot) {
      more = next.kfs;
    } else if (Array.isArray(next)) {
      more = next;
    } else {
      throw new Error('[camera-shots] .then() 需要 builder 函数 / Shot / KF[]');
    }
    if (!Array.isArray(more)) {
      throw new Error('[camera-shots] builder 返回的不是 KF[] / Shot');
    }
    // 续接：新 KF 的 t = 旧 lastT + KF 自己的相对 t
    var offset = this.lastT;
    var shifted = more.map(function (k) { return Object.assign({}, k, { t: offset + k.t }); });
    var out = this.kfs.concat(shifted);
    var s = new Shot(out);
    s.state = this.state;
    return s;
  };

  /**
   * .shot('dolly', {dist:300}) —— 按名字调用配方并续接
   */
  Shot.prototype.shot = function (name, opts) {
    if (!g.CAMSHOTS || !g.CAMSHOTS[name]) throw new Error('[camera-shots] 未知配方：' + name);
    return this.then(g.CAMSHOTS[name].bind(null, opts || {}));
  };
  Shot.prototype.track = function () { return this.kfs; };

  function wrap(builder) {
    return function (opts) {
      var out = builder(opts || {});
      var s = new Shot(out);
      s.state = opts && opts.state;
      return s;
    };
  }

  // =========================================================================
  // 暴露 API
  // =========================================================================
  var CAMSHOTS = {
    dolly: wrap(dolly),
    orbit: wrap(orbit),
    crane: wrap(crane),
    dollyZoom: wrap(dollyZoom),
    parallax: wrap(parallax),
    dutchTilt: wrap(dutchTilt),
    push: wrap(push),
    pull: wrap(pull),
    rackFocus: wrap(rackFocus),
    flyTo: wrap(flyTo),
    approach: wrap(approach),
    level: wrap(level),
    snapZoom: wrap(snapZoom),

    // 低阶 API（直接返回 KF[]，不链式）
    dollyRaw: dolly, orbitRaw: orbit, dollyZoomRaw: dollyZoom,
    parallaxRaw: parallax, craneRaw: crane, dutchTiltRaw: dutchTilt,
    rackFocusRaw: rackFocus, flyToRaw: flyTo, approachRaw: approach,
    levelRaw: level, snapZoomRaw: snapZoom,

    // 工具
    resolveSubject: resolveSubject,
    kf: kf,
    presets: [
      { key: 'orbit', name: '环绕',     build: 'orbit({angleDeg:90, dur:4})' },
      { key: 'dolly-in',  name: '推进',     build: 'dolly({dist:600, dur:3, ease:"ei"})' },
      { key: 'pull',      name: '拉远',     build: 'pull({dist:500, dur:3})' },
      { key: 'dollyZoom', name: '希区柯克', build: 'dollyZoom({dist:300, dur:3})' },
      { key: 'crane-up',  name: '摇臂上升', build: 'crane({fromY:0, toY:-800, dur:4})' },
      { key: 'crane-down',name: '摇臂下降', build: 'crane({fromY:-800, toY:0, dur:4})' },
      { key: 'parallax',  name: '视差横摇', build: 'parallax({dur:4, panPx:1500})' },
      { key: 'dutch',     name: '荷兰角',   build: 'dutchTilt({rollDeg:18, dur:1})' },
      { key: 'rack',      name: '转焦',     build: 'rackFocus({from:"L1", to:"L3", dur:2})' },
      { key: 'snap',      name: '冲+修正',   build: 'snapZoom({dist:400, dur:0.6, overshoot:0.08})' },
      { key: 'level',     name: '水平归零',   build: 'level({dur:0.5})' },
      { key: 'approach',  name: '逼近主体', build: 'approach({subject:"C2", dist:1100, azimuth:18, dur:2.2})' }
    ]
  };

  g.CAMSHOTS = CAMSHOTS;
  // 软挂载：CAM3D 上挂 shots / shot
  if (g.CAM3D) {
    g.CAM3D.shots = CAMSHOTS;
    g.CAM3D.shot = function (name, opts) { return CAMSHOTS[name](opts); };
  }
})(window);