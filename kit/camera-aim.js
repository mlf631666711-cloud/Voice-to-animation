/**
 * camera-aim.js —— 摄影机「朝向」独立轨道（零依赖，构建期烘焙，运行期纯函数）
 *
 * ===========================================================================
 * 解决什么问题
 * ===========================================================================
 * 原 camera3d.js 里，POI(px,py,pz) 和机位(x,y,z) **共用同一条缓动、同一个时间段**。
 * 后果：「机位飞过去」和「视线转过去」被焊死了 —— 你没法让机位匀速前进、视线在后半段
 * 才猛地甩向新主体。而那恰恰是电影感的主要来源（视线领先/滞后于机位）。
 *
 * 本模块把「朝向」拆成独立通道，新增：
 *   · aim 模式    poi / hold / lead / lag / subject —— 运动中怎么改指向
 *   · aimEase    朝向用自己的缓动，与机位缓动解耦
 *   · yaw/pitch  直接给角度（度），不用反推世界坐标点
 *   · yawOff/pitchOff  在解算结果上叠微调（手动 pan/tilt 手感）
 *
 * ===========================================================================
 * 模式语义（这是本次升级的核心）
 * ===========================================================================
 *   poi     默认。看向关键帧 POI（= 现状行为）
 *   hold    冻结进入本段时的朝向。机位动、视线不动 → 横移跟拍的"平移感"
 *   lead    看向前方（沿运动方向前视 leadDist）→ 飞行/穿越的主观视角
 *   lag     视线滞后于机位，一阶低通跟随 → 甩镜后视线"追上来"，最有电影感
 *   subject 跟随具名/动态主体（每帧解析），主体移动也跟得住
 *
 * ===========================================================================
 * 为什么用「烘焙」而不是运行期滤波
 * ===========================================================================
 * lag 是**因果滤波**（依赖上一帧），会破坏「seek 任意帧结果一致」这条铁律。
 * 解法：在**构建期**按固定步长把整条轨道烘焙成 yaw/pitch 数组，
 * 运行期只做数组插值 —— 同 t 必得同值，且可内联进单文件 HTML。
 *
 * 用法：
 *   const baked = CAMERA_AIM.bake(TRACK, {fps:30});
 *   CAMERA_AIM.apply(vp, cam, TRACK, baked, t);
 *   CAMERA_AIM.audit(TRACK, baked);      // 角速度 / 退化 / 距离守卫
 */
(function (g) {
  'use strict';

  var CAM3D = g.CAM3D;
  function need() {
    if (!CAM3D) CAM3D = g.CAM3D;
    if (!CAM3D) throw new Error('camera-aim.js 依赖 camera3d.js，请先引入');
    return CAM3D;
  }

  function c01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function lerp(a, b, k) { return a + (b - a) * k; }
  function len3(x, y, z) { return Math.sqrt(x * x + y * y + z * z); }

  /** 最短弧插值 —— 359° → 1° 应该走 2°，不是倒回去走 358° */
  function arcLerp(a, b, k) {
    var d = ((b - a + 540) % 360) - 180;
    return a + d * k;
  }
  /** 解缠：把角度序列里 >180° 的跳变补回来 */
  function unwrap(arr) {
    var acc = 0;
    for (var i = 1; i < arr.length; i++) {
      var d = arr[i] - arr[i - 1];
      if (d > 180) acc -= 360; else if (d < -180) acc += 360;
      arr[i] += acc;
    }
    return arr;
  }

  /** 关键帧里「朝向输入」的字段默认值 */
  var AIM_DEFAULT = { aim: 'poi', leadDist: 900, lagTau: 0.28, minAimDist: 200 };

  function aimOf(kf, prev) {
    var o = {};
    for (var k in AIM_DEFAULT) {
      if (kf && kf[k] !== undefined) o[k] = kf[k];
      else if (prev && prev[k] !== undefined) o[k] = prev[k];
      else o[k] = AIM_DEFAULT[k];
    }
    return o;
  }

  /**
   * 段解析 —— 段属性取「起点关键帧」，但**同时接受写在终点关键帧上**。
   *
   * ⚠️ 为什么要双向兜底（本次实测踩到）：
   *   CAM3D 的约定是「段的缓动由起点关键帧的 ease 决定」。但写分镜时人很自然会把
   *   aimEase / aim 写在**目标那一帧**上（"飞到这儿的时候要甩镜头"）。
   *   只认起点 → 写错了**不报错、静默失效**，等到审片才发现视线根本没动。
   *   所以这里两端都认，起点优先。宁可宽容，不可静默。
   */
  function segInfo(track, j) {
    j = Math.max(0, Math.min(j, track.length - 2));   // 起点永不是最后一个关键帧
    var a = track[j], b = track[j + 1], prev = track[j - 1];
    var aim = aimOf(a, prev);
    if (a.aim === undefined && b.aim !== undefined) aim.aim = b.aim;
    if (a.leadDist === undefined && b.leadDist !== undefined) aim.leadDist = b.leadDist;
    if (a.lagTau === undefined && b.lagTau !== undefined) aim.lagTau = b.lagTau;
    if (a.subject === undefined && b.subject !== undefined) aim.subject = b.subject;
    var aimEase = (a.aimEase !== undefined) ? a.aimEase
                : (b.aimEase !== undefined) ? b.aimEase
                : (a.ease || 'eio');
    return { j: j, a: a, b: b, prev: prev, aim: aim, aimEase: aimEase };
  }

  /** 定位 t 所在段。两端都做钳制，杜绝段末一帧跳变。 */
  function segAt(track, t) {
    var j = 0;
    while (j < track.length - 2 && track[j + 1].t <= t) j++;
    return segInfo(track, j);
  }

  /**
   * 烘焙：把整条轨道在固定网格上算出 yaw/pitch。
   * @param track  CAM3D 轨道（关键帧可带 aim / aimEase / yaw / pitch / yawOff / pitchOff / subject）
   * @param opts.fps   采样率（默认 30）
   * @param opts.pad   首尾各多焙几秒，避免端点外推（默认 0）
   * @returns {fps, dt, t0, t1, yaw:[], pitch:[]}
   */
  function bake(track, opts) {
    var C = need();
    opts = opts || {};
    var fps = opts.fps || 30, dt = 1 / fps;
    var t0 = track[0].t, t1 = track[track.length - 1].t;
    var n = Math.max(2, Math.round((t1 - t0) / dt) + 1);

    var yaw = new Array(n), pitch = new Array(n);
    var raw = new Array(n);      // 未滤波的 lookAt 解，供 lag 用

    for (var i = 0; i < n; i++) {
      var t = t0 + i * dt;
      var s = C.sample(track, t);

      // --- 定位所在段，取段内独立进度 ---------------------------------
      var si = segAt(track, t);
      var a = si.a, b = si.b;
      var kPos = c01((t - a.t) / ((b.t - a.t) || 1e-6));
      var kAim = C.ease(si.aimEase, kPos);              // ★ 朝向独立缓动

      var aim = si.aim;
      var ax, ay, az;                    // 本帧要看的点
      var got = false;

      // ① 显式角度：最短弧插值，机位怎么动都不影响朝向
      //    ⚠️ 只要任一端写了 yaw/pitch 就进这条分支，缺的那一端用 POI 解兜底。
      //    要求两端都写 = 写单边静默失效（与 aimEase 同一个坑，实测踩到过）。
      if (a.yaw !== undefined || b.yaw !== undefined ||
          a.pitch !== undefined || b.pitch !== undefined) {
        var ya = C.lookAt(s.x, s.y, s.z, s.px, s.py, s.pz);
        var y0 = a.yaw !== undefined ? a.yaw : ya.yaw;
        var y1 = b.yaw !== undefined ? b.yaw : ya.yaw;
        var p0 = a.pitch !== undefined ? a.pitch : ya.pitch;
        var p1 = b.pitch !== undefined ? b.pitch : ya.pitch;
        yaw[i] = arcLerp(y0, y1, kAim);
        pitch[i] = lerp(p0, p1, kAim);
        got = true;
      } else if (aim.aim === 'hold') {
        // ② 冻结段首朝向：取段首那一帧的解，整段不变
        var s0 = C.sample(track, a.t);
        var h = C.lookAt(s0.x, s0.y, s0.z, s0.px, s0.py, s0.pz);
        yaw[i] = h.yaw; pitch[i] = h.pitch;
        got = true;
      } else if (aim.aim === 'lead') {
        // ③ 前视：沿速度方向推 leadDist
        var v = velocity(track, t, dt, C);
        var L = len3(v.x, v.y, v.z);
        if (L > 1e-3) {
          ax = s.x + v.x / L * aim.leadDist;
          ay = s.y + v.y / L * aim.leadDist;
          az = s.z + v.z / L * aim.leadDist;
        } else { ax = s.px; ay = s.py; az = s.pz; }
      } else if (aim.aim === 'subject') {
        // ④ 动态主体
        var sub = resolve(a.subject, t);
        if (sub) { ax = sub.x; ay = sub.y; az = sub.z; }
        else { ax = s.px; ay = s.py; az = s.pz; }
      } else {
        // ⑤ poi / lag / world —— 都以「按 aimEase 插值的 POI」为原始解
        var A = C.sample(track, a.t), B = C.sample(track, b.t);
        ax = lerp(A.px, B.px, kAim);
        ay = lerp(A.py, B.py, kAim);
        az = lerp(A.pz, B.pz, kAim);
      }

      if (!got) {
        // 距离守卫：机位太贴近注视点 → lookAt 退化、朝向乱抖（沿用铁律 dist > 200）
        var dx = ax - s.x, dy = ay - s.y, dz = az - s.z;
        var d = len3(dx, dy, dz);
        if (d < aim.minAimDist) {
          var q = aim.minAimDist / (d || 1e-6);
          ax = s.x + dx * q; ay = s.y + dy * q; az = s.z + dz * q;
        }
        var la = C.lookAt(s.x, s.y, s.z, ax, ay, az);
        yaw[i] = la.yaw; pitch[i] = la.pitch;
      }

      // 手动微调（yawOff / pitchOff），同样走 aimEase
      var off0 = (a.yawOff || 0), off1 = (b.yawOff || 0);
      var poff0 = (a.pitchOff || 0), poff1 = (b.pitchOff || 0);
      yaw[i] += lerp(off0, off1, kAim);
      pitch[i] += lerp(poff0, poff1, kAim);

      raw[i] = { yaw: yaw[i], pitch: pitch[i] };
    }

    // --- lag：对整段做一阶低通（构建期，确定性强） -------------------------
    // 只要任一段声明了 aim:'lag'，就对该段时间窗内做平滑。
    var anyLag = false;
    for (var q0 = 0; q0 < track.length - 1; q0++) {
      if (segInfo(track, q0).aim.aim === 'lag') { anyLag = true; break; }
    }
    if (anyLag) {
      var tau = AIM_DEFAULT.lagTau;
      for (var m = 0; m < track.length - 1; m++) {
        var sm = segInfo(track, m);
        var seg0 = sm.a, seg1 = sm.b;
        if (sm.aim.aim !== 'lag') continue;
        tau = sm.aim.lagTau || tau;
        var i0 = Math.max(0, Math.round((seg0.t - t0) / dt));
        var i1 = Math.min(n - 1, Math.round((seg1.t - t0) / dt));
        var alpha = 1 - Math.exp(-dt / (tau || 1e-6));
        for (var p = i0 + 1; p <= i1; p++) {
          yaw[p] = yaw[p - 1] + alpha * (raw[p].yaw - yaw[p - 1]);
          pitch[p] = pitch[p - 1] + alpha * (raw[p].pitch - pitch[p - 1]);
        }
      }
    }

    unwrap(yaw); unwrap(pitch);

    return { fps: fps, dt: dt, t0: t0, t1: t1, n: n, yaw: yaw, pitch: pitch };
  }

  /** 位置速度（中心差分，端点用单边） */
  function velocity(track, t, dt, C) {
    var s1 = C.sample(track, t + dt), s0 = C.sample(track, t - dt);
    return { x: (s1.x - s0.x) / (2 * dt), y: (s1.y - s0.y) / (2 * dt), z: (s1.z - s0.z) / (2 * dt) };
  }

  /** 主体解析：字符串查表 / 对象直取 / 函数求值 */
  function resolve(subj, t) {
    if (!subj) return null;
    if (typeof subj === 'function') { var r = subj(t); return r && r.x !== undefined ? r : null; }
    if (typeof subj === 'string') {
      if (g.SUBJECTS && g.SUBJECTS[subj]) {
        var s = g.SUBJECTS[subj];
        return typeof s === 'function' ? s(t) : s;
      }
      var el = g.document && g.document.querySelector(subj);
      if (el) {
        var m = /matrix3d\(([^)]+)\)/.exec(getComputedStyle(el).transform);
        if (m) { var v = m[1].split(',').map(Number); return { x: v[12], y: v[13], z: v[14] }; }
      }
      return null;
    }
    return subj;
  }

  /** 从烘焙结果里取某一帧的 yaw/pitch（线性插值，已解缠） */
  function sampleAim(baked, t) {
    var x = (t - baked.t0) / baked.dt;
    if (x <= 0) return { yaw: baked.yaw[0], pitch: baked.pitch[0] };
    if (x >= baked.n - 1) return { yaw: baked.yaw[baked.n - 1], pitch: baked.pitch[baked.n - 1] };
    var i = Math.floor(x), k = x - i;
    return {
      yaw: lerp(baked.yaw[i], baked.yaw[i + 1], k),
      pitch: lerp(baked.pitch[i], baked.pitch[i + 1], k)
    };
  }

  /** 完整状态：机位 + 朝向 */
  function state(track, baked, t) {
    var s = need().sample(track, t);
    var a = sampleAim(baked, t);
    s.yaw = a.yaw; s.pitch = a.pitch;
    return s;
  }

  /**
   * #camera 的 transform。
   * 与 CAM3D.matrix 的区别：朝向直接来自烘焙角度，不再每帧反解 POI。
   */
  function matrix(s) {
    return 'rotateZ(' + (-s.roll).toFixed(4) + 'deg) ' +
           'rotateX(' + (-s.pitch).toFixed(4) + 'deg) ' +
           'rotateY(' + (-s.yaw).toFixed(4) + 'deg) ' +
           'translate3d(' + (-s.x).toFixed(3) + 'px,' +
                            (-s.y).toFixed(3) + 'px,' +
                            (-s.z).toFixed(3) + 'px)';
  }

  function apply(vp, cam, track, baked, t) {
    var s = state(track, baked, t);
    if (vp) vp.style.perspective = s.zoom.toFixed(2) + 'px';
    if (cam) cam.style.transform = matrix(s);
    return s;
  }

  // ===========================================================================
  // 审计：转向太猛会晕，退化点会让画面抽搐
  // ===========================================================================
  /**
   * ⚠️ 阈值标定（2026-09-12 实测，别拍脑袋改）：
   *   默认 180°/s 意味着 —— **一次 90° 转向至少要 1.7~2.0s 才不触发 FAIL**。
   *   实测表（90° 转向）：
   *     eio 1.2s → 213°/s FAIL    qio 1.2s → 276°/s FAIL    cio 1.2s → 444°/s FAIL
   *     eio 2.0s → 131°/s PASS    qio 2.0s → 171°/s PASS    snapo 2.5s → 156°/s PASS
   *   结论：讲解类动效（本工作区主业）按 180°/s 是对的；
   *        真要甩镜就显式传 maxYawRate，别去改默认值。
   *
   * @param opts.maxYawRate   度/秒上限（默认 180）
   * @param opts.maxPitchRate 度/秒上限（默认 120）
   * @param opts.maxJerk      角加速度上限 度/秒²（默认 900）
   */
  function audit(track, baked, opts) {
    opts = opts || {};
    var maxYaw = opts.maxYawRate || 180, maxPit = opts.maxPitchRate || 120, maxJerk = opts.maxJerk || 900;
    var dt = baked.dt, issues = [];
    var peakY = 0, peakP = 0, peakJ = 0, tY = 0, tP = 0, tJ = 0;
    var py = 0, pp = 0, vy = 0, vp = 0;

    for (var i = 1; i < baked.n; i++) {
      var t = baked.t0 + i * dt;
      var cy = (baked.yaw[i] - baked.yaw[i - 1]) / dt;
      var cp = (baked.pitch[i] - baked.pitch[i - 1]) / dt;
      if (Math.abs(cy) > peakY) { peakY = Math.abs(cy); tY = t; }
      if (Math.abs(cp) > peakP) { peakP = Math.abs(cp); tP = t; }
      var jy = Math.abs((cy - vy) / dt), jp = Math.abs((cp - vp) / dt);
      var jk = Math.max(jy, jp);
      if (jk > peakJ) { peakJ = jk; tJ = t; }
      vy = cy; vp = cp;
    }

    if (peakY > maxYaw) issues.push({ level: 'FAIL', at: +tY.toFixed(2),
      msg: 'yaw 角速度 ' + peakY.toFixed(0) + '°/s > ' + maxYaw + '°/s（转向过猛会晕）' });
    if (peakP > maxPit) issues.push({ level: 'FAIL', at: +tP.toFixed(2),
      msg: 'pitch 角速度 ' + peakP.toFixed(0) + '°/s > ' + maxPit + '°/s' });
    if (peakJ > maxJerk) issues.push({ level: 'WARN', at: +tJ.toFixed(2),
      msg: '角加速度 ' + peakJ.toFixed(0) + '°/s² > ' + maxJerk + '°/s²（朝向有硬折点）' });

    // NaN / 断点
    for (var q = 0; q < baked.n; q++) {
      if (!isFinite(baked.yaw[q]) || !isFinite(baked.pitch[q])) {
        issues.push({ level: 'FAIL', at: +(baked.t0 + q * dt).toFixed(2), msg: '朝向出现 NaN（机位与注视点重合？）' });
        break;
      }
    }

    // ★ hold 兼容性守卫（2026-09-12 明动 V6 实测发现）
    //   hold = 冻结段首朝向。它**只在机位沿视线方向进退时安全**（位移平行视线 → 主体仍在框内）。
    //   一旦段内有大幅横向或升降位移，冻结的朝向会把主体甩出画面 —— 实测 crane 升 560px 时
    //   主体直接出框。所以这里按「横向位移 / 段首视距」的比例判，超 25% 就报。
    for (var m2 = 0; m2 < track.length - 1; m2++) {
      var sg = segInfo(track, m2);
      if (sg.aim.aim !== 'hold') continue;
      var sA = need().sample(track, sg.a.t), sB = need().sample(track, sg.b.t);
      var vx = sB.x - sA.x, vy = sB.y - sA.y, vz = sB.z - sA.z;
      var travel = len3(vx, vy, vz);
      var d0 = len3(sA.px - sA.x, sA.py - sA.y, sA.pz - sA.z);
      // 位移在视线方向上的投影
      var along = d0 > 1e-6 ? Math.abs((vx * (sA.px - sA.x) + vy * (sA.py - sA.y) + vz * (sA.pz - sA.z)) / d0) : 0;
      var lateral = Math.sqrt(Math.max(0, travel * travel - along * along));
      if (d0 > 1e-6 && lateral / d0 > 0.25) {
        issues.push({
          level: 'FAIL', at: +sg.a.t.toFixed(2),
          msg: 'hold 段横向位移 ' + lateral.toFixed(0) + 'px 占视距 ' + (lateral / d0 * 100).toFixed(0) +
               '%（>25%）—— 冻结朝向会让主体出框。hold 只适合沿视线进退，改用 poi 或缩短段'
        });
      }
    }

    return {
      peakYawRate: +peakY.toFixed(1), peakPitchRate: +peakP.toFixed(1), peakJerk: +peakJ.toFixed(1),
      atYaw: +tY.toFixed(2), atPitch: +tP.toFixed(2),
      issues: issues,
      pass: issues.filter(function (x) { return x.level === 'FAIL'; }).length === 0
    };
  }

  g.CAMERA_AIM = {
    bake: bake, sampleAim: sampleAim, state: state, matrix: matrix, apply: apply,
    audit: audit, arcLerp: arcLerp, unwrap: unwrap, AIM_DEFAULT: AIM_DEFAULT
  };
})(window);
