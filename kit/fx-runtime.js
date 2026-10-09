/* ==========================================================================
 * fx-runtime.js —— 「语音转动画」管线 · 动效运行时
 * --------------------------------------------------------------------------
 * 三条铁律（违反就是废代码）：
 *   1) 禁止 CSS animation / transition / @keyframes。
 *      所有动效必须由 JS 纯函数 window.__frame(t) 按帧号驱动：
 *      同一个 t 进来，必须得到逐像素完全一致的状态（确定性）。
 *      原因：成片是 puppeteer 逐帧截图 → ffmpeg 合成，CSS 动画的时间轴不可控，
 *      截图那一帧永远对不上你想要的状态。
 *   2) 所有函数必须是「纯」的：只读 t / 入参，禁止 += 累计、禁止 Date.now()、
 *      禁止 Math.random()、禁止读上一帧留下的元素状态做累加。
 *      允许读 el.style.xxx 做「本帧内的修正」，但结果必须只由 t 决定。
 *   3) 零外部依赖。本文件会被整段内联进单文件 HTML 的 script 块里。
 *      ⚠ 本文件（含注释）禁止出现字面 script 结束标签（就是那个"斜杠+script"的收尾尖括号串），
 *      一旦出现会直接截断内联的脚本块。需要示例时写成 "<\/script"。
 *
 * 用法：整段内联后，FX.xxx 直接调用；生成器约定不要把函数名改掉。
 * ========================================================================== */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 0. 数学基元
   * ------------------------------------------------------------------ */
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const lerp = (a, b, t) => a + (b - a) * t;

  /* 缓动三件套：全部入参已 clamp01，越界不会炸 */
  const eo = (t) => { t = clamp01(t); return 1 - Math.pow(1 - t, 3); };            // easeOutCubic：快进慢出，最常用
  const ei = (t) => { t = clamp01(t); return t * t * t; };                         // easeInCubic
  const eio = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };              // easeInOut = smoothstep，镜头插值默认用这个
  // easeOutBack：轻微过冲再回弹（"弹入"手感）。c 值越大弹得越夸张。
  // 1.70158 是标准值，ink/mengmeng 系列工程实测偏软，统一乘 1.2。
  const eob = (t) => { t = clamp01(t); const c = 1.70158 * 1.2, q = t - 1; return 1 + (c + 1) * q * q * q + c * q * q; };

  /* ------------------------------------------------------------------ *
   * 1. 时间窗口
   * ------------------------------------------------------------------ */
  /** 线性窗口：t 落在 [t0, t0+d] 内返回 0→1，t<t0 返回 0，越过返回 1 */
  const c1 = (t, t0, d) => clamp01((t - t0) / (d > 1e-9 ? d : 1e-9));
  /** 缓动窗口：c1 再过一层 easeOutCubic。淡入/位移的一号窗口 */
  const seg = (t, t0, d) => eo(c1(t, t0, d));

  /* ------------------------------------------------------------------ *
   * 2. 入场原语
   * ------------------------------------------------------------------ */

  /**
   * 弹性入场（easeOutBack）。
   * @param {HTMLElement} el
   * @param {number} t     当前秒
   * @param {number} t0    入场起始秒
   * @param {number} [x]   可选：元素基准 left（px）。传有限数则每帧写入（幂等、确定性）
   * @param {number} [y]   可选：元素基准 top（px）
   * @param {'left'|'right'|'up'|'down'|'scale'} [from='scale'] 入场方向
   *
   * 时序（沿用 mengmeng 工程实测值，别乱改）：
   *   位移 0.50s（easeOutBack，含过冲回弹）
   *   透明度 0.18s（easeOutCubic）—— 透明度比位移快，才有"实体先到、光后到"的层次
   */
  function pop(el, t, t0, x, y, from) {
    if (!el) return;
    if (typeof x === 'number' && isFinite(x)) el.style.left = x + 'px';
    if (typeof y === 'number' && isFinite(y)) el.style.top = y + 'px';
    const e = eob(c1(t, t0, 0.50));
    el.style.opacity = seg(t, t0, 0.18);
    switch (from) {
      case 'left':  el.style.transform = `translateX(${(1 - e) * -52}px) scale(${0.9 + 0.1 * e})`; break;
      case 'right': el.style.transform = `translateX(${(1 - e) * 52}px) scale(${0.9 + 0.1 * e})`; break;
      case 'up':    el.style.transform = `translateY(${(1 - e) * 46}px)`; break;
      case 'down':  el.style.transform = `translateY(${(1 - e) * -46}px)`; break;
      case 'scale':
      default:      el.style.transform = `scale(${0.72 + 0.28 * e})`; break;
    }
  }

  /**
   * 淡入 + 上移。比 pop 克制，用于副文本/标题。
   * @param {number} d  淡入时长（秒）
   * @param {number} dy 起始下移距离（px），默认 18
   */
  function fade(el, t, t0, d, dy) {
    if (!el) return;
    const p = seg(t, t0, d);
    el.style.opacity = p;
    el.style.transform = `translateY(${(1 - p) * (dy == null ? 18 : dy)}px)`;
  }

  /**
   * 双向窗口包络：0 → 1 → 0。想拼任何"入场→驻留→退场"的量，用它取系数即可：
   *     const k = FX.env(t, tIn, tOut, dIn, dOut);
   *     el.style.opacity = k;
   * @param {number} tIn  入场起点秒
   * @param {number} tOut 退场起点秒（不传 = 只入不出）
   * @param {number} dIn  入场时长（秒）
   * @param {number} dOut 退场时长（秒）
   * @returns {number} 0..1
   * ⚠ 保证 tIn + dIn ≤ tOut。两个窗口重叠时取 min，峰值会打折（到不了 1）。
   */
  function env(t, tIn, tOut, dIn, dOut) {
    const a = seg(t, tIn, dIn);
    const b = tOut == null ? 1 : 1 - seg(t, tOut, dOut);
    return Math.min(a, b);
  }

  /**
   * 淡出 + 上移（退场用）。t0 起 d 秒内 1 → 0，同时向上位移 dy。
   * 与 fade 对称：fade 从 +dy 回到 0，fadeOut 从 0 走到 -dy。
   */
  function fadeOut(el, t, t0, d, dy) {
    if (!el) return;
    const p = 1 - seg(t, t0, d);
    el.style.opacity = p;
    el.style.transform = `translateY(${(1 - p) * -(dy == null ? 18 : dy)}px)`;
  }

  /**
   * 淡入 → 驻留 → 淡出（一个原语走完整个生命周期，省得外面拿 seg/c1 手工拼双向窗口）。
   * 位移与 fade 同向：入场从 +dy 回到 0，退场再退回 +dy。
   * @param {number} dIn  入场时长（秒）；不传默认 0.45
   * @param {number} dOut 退场时长（秒）；不传默认 0.45
   * 不传 tOut 时等价于 fade（只入不出）。
   */
  function fadeInOut(el, t, tIn, tOut, dIn, dOut, dy) {
    if (!el) return;
    const k = env(t, tIn, tOut, dIn == null ? 0.45 : dIn, dOut == null ? 0.45 : dOut);
    el.style.opacity = k;
    el.style.transform = `translateY(${(1 - k) * (dy == null ? 18 : dy)}px)`;
  }

  /* ------------------------------------------------------------------ *
   * 3. 运镜
   * ------------------------------------------------------------------ */

  /**
   * 关键帧插值。
   * @param {Array<[t,x,y,z,rot]>} CAMKEYS  升序关键帧；每行 = [秒, 焦点x, 焦点y, 缩放, 旋转deg]
   *                                        rot 可省略（记 0）
   * @param {number} t
   * @returns {{x:number,y:number,z:number,rot:number,cx:number,cy:number}}
   *          cx/cy 是 x/y 的别名（老工程里 cam.cx 用惯了），两者恒等。
   *
   * 段内用 easeInOut（smoothstep）—— 关键帧之间是"起步慢→中段快→收尾慢"，
   * 用线性插值会在关键帧处出现明显的折角（俗称"打点感"）。
   * hold 技巧：想把镜头钉住一段时间，就在结束时间点上再插一条同参数的关键帧。
   */
  function camAt(CAMKEYS, t) {
    const K = CAMKEYS || [];
    if (!K.length) return { x: 960, y: 540, z: 1, rot: 0, cx: 960, cy: 540 };
    const norm = (k) => Array.isArray(k)
      ? { t: k[0], x: k[1], y: k[2], z: k[3] == null ? 1 : k[3], rot: k[4] || 0 }
      : { t: k.t, x: k.x, y: k.y, z: k.z == null ? 1 : k.z, rot: k.rot || 0 };
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
   * 多层视差（真 dolly）。
   *
   * ⚠ 重要：单纯给整个画面加 scale() 那叫 zoom，不叫推镜 —— 所有东西等比放大，
   * 没有纵深线索，出来就是 PPT 味的"放大一下"。
   * 真 dolly 必须让多层以**不同速率**位移+缩放，靠层间相对位移差告诉眼睛"这里有深度"：
   *     前景 1.0（跟满） / 中景 0.6 / 背景 0.3（几乎不动）
   *
   * @param {HTMLElement} el    层容器（必须是 1920×1080 满画面、CSS 里写 transform-origin:0 0）
   * @param {object} cam        camAt() 的返回值
   * @param {number} [rate=1]   视差速率 1.0/0.6/0.3
   *
   * 使用约定：**不要再给父级 #camera 加 transform**，否则会叠加两次。
   * 正确姿势是 #stage 下挂三个平级层，各自 applyParallax(el, cam, 1.0 / 0.6 / 0.3)，
   * 内容层用 1.0。
   */
  function applyParallax(el, cam, rate) {
    if (!el || !cam) return;
    const r = rate == null ? 1 : rate;
    const z = 1 + ((cam.z == null ? 1 : cam.z) - 1) * r;      // 缩放按速率衰减：背景几乎不放大
    const tx = (960 - cam.x * cam.z) * r;                     // 平移同理
    const ty = (540 - cam.y * cam.z) * r;
    const rot = (cam.rot || 0) * r;
    el.style.transform =
      `translate(${tx.toFixed(3)}px, ${ty.toFixed(3)}px)` +
      (rot ? ` rotate(${rot.toFixed(3)}deg)` : '') +
      ` scale(${z.toFixed(5)})`;
  }

  /* ------------------------------------------------------------------ *
   * 4. 数值 / 文本
   * ------------------------------------------------------------------ */
  function groupThousands(s) {
    return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /**
   * 数值滚动。注意：本函数只负责「格式化这一帧的数字」，
   * 滚动的速度由调用方用缓动算好再传进来（保持纯函数）：
   *     FX.roll(el, 32 * FX.eo(FX.c1(t, 1.30, 1.10)), 0, ' MB');
   * @param {number} digits 小数位
   * @param {string} suffix 单位后缀，如 ' MB' / '%'
   *
   * ⚠ 字体必须开 font-variant-numeric: tabular-nums（见 CSS 的 .fx-num），
   *   否则 0→1 的变化会让整行左右抖。
   * ⚠ 只在文本真变化时才写 DOM，避免逐帧无谓重排。
   */
  function roll(el, value, digits, suffix) {
    if (!el) return '';
    digits = digits == null ? 0 : digits | 0;
    suffix = suffix == null ? '' : suffix;
    const v = Number(value);
    const n = isFinite(v) ? v : 0;
    let s = Math.abs(n).toFixed(digits);
    if (digits === 0) s = groupThousands(s);
    const txt = (n < 0 ? '-' : '') + s + suffix;
    if (el.textContent !== txt) el.textContent = txt;
    return txt;
  }

  /**
   * 打字机。p ∈ [0,1] → 显示前 ceil(p*len) 个字。
   * 纯切片，不做累积；想加光标就在 CSS 里 ::after 一个竖条，别用 blink 动画。
   */
  function typeOn(el, text, p) {
    if (!el) return '';
    p = clamp01(p);
    const n = Math.round(String(text).length * p);
    const s = String(text).slice(0, n);
    if (el.textContent !== s) el.textContent = s;
    return s;
  }

  /* ------------------------------------------------------------------ *
   * 5. 扫光（附加工具 · 非契约成员，但 .glass 组件依赖它）
   * ------------------------------------------------------------------ */
  /**
   * 玻璃卡/标题块的边缘扫光。窗口外自动归零并清掉变量。
   * 驱动的是 CSS 变量 --sweep-bg（位置 %）与 --sweep-op（开关），
   * 见 fx-components.css 的 .glass::after。
   */
  function sweep(el, t, t0, dur) {
    if (!el) return;
    if (t < t0 || t > t0 + dur) {
      el.style.setProperty('--sweep-op', 0);
      el.style.setProperty('--sweep-bg', '-120% -120%');
      return;
    }
    const pos = -120 + ((t - t0) / (dur > 1e-9 ? dur : 1e-9)) * 240;
    el.style.setProperty('--sweep-bg', `${pos.toFixed(2)}% ${pos.toFixed(2)}%`);
    el.style.setProperty('--sweep-op', 1);
  }

  /* ------------------------------------------------------------------ *
   * 9. 无缝转场（match cut）—— 学习知识库 §17 / 规格锁 §5.16
   * ------------------------------------------------------------------ *
   * 公式：**相同元素 × 同向运动 × 速度对冲**（B 站 BV1sSKX63Ets）
   *   A 段末尾 matchOut：元素用 ease-in **加速冲出**（速度峰值落在段末）
   *   B 段开头 matchIn ：同色同形元素用 ease-out **减速冲入**（速度峰值落在段首）
   *   → 切点两侧速度匹配，切换被藏在速度峰值里，观感连续。
   *
   * ★★★ 2026-09-14 逐帧复核修正（145 帧像素级量完，推翻了上面一半）:
   *   原片**根本没有做速度对冲**。实测：
   *     A 段末速 ≈1410 px/s（0.50s 内加速右冲，圆停在"被内面板右界裁掉 73px"处，
   *                        刻意留 58px 在外，好让眼睛一直有东西可追）
   *     B 段平均 ≈28 px/s（切点后 0.88s 只走 18px —— 是"缓缓漂移"，不是"冲入"）
   *     两者相差 50 倍。
   *   真正让切点"看不见"的是三条，缺一不可：
   *     ① 同一个视觉元素（同色同形）  ② 同方向运动
   *     ③ **切点两侧都被画面边界贴着**（出右边缘 → 切 → 从左边缘进来
   *        = 观众眼睛一路有目标可追的"穿越"错觉）
   *   → matchOut/matchIn 仍是**有用的工具**（真要做对冲就用它们，
   *     kit/_demo/match_cut_demo.html?v=strong 那版即是），
   *     但**不要再拿它当这条片子的解释**。
   *   → B 段那种"缓移"其实该用 smoothstep（本文件的 eio），两端速度都为 0，
   *     不会出现"窜一下再停"。
   *   取证与复刻实物：kit/_demo/match_cut_demo.html（正确 / _bad / ?v=strong 三版）
   *   详见 `BUG-总回归库.md` §6.17 · BUG-2132~2137
   *
   * 🔴🔴 2026-09-14 第四轮再复核（30fps 全链逐帧 360 帧，**上面这段也被推翻了**）:
   *   老板再否一次 → 把**整条链**（9.2~21.2s）逐帧量「圆位置」+「挖掉圆后的画面指纹Δ」：
   *     ① 原片不是"切一次"，是**一条转场链**（A→B→B2→B3→A）——
   *        **同一个圆一直留在画面里，画面在它周围换了 3 次内容**。
   *     ② Δ 尖峰只有 **3 个**（10.967 / 15.333 / 20.133）= 全链 3 次硬切；
   *        中间 **16.8 / 18.5 两次是「圆一动不动、只有画面内容换」** ← **这才是"无缝"的来源**。
   *     ③ **切点两侧圆都是静止的** —— 15.267 → 15.300 圆最左/最右**一个像素未动**，
   *        切前最后两帧位移 `0.00px`。**"速度对冲"在本片里彻底不成立**（连"缓移"都不是，是"停着"）。
   *     ④ 上一段说的"切点两侧都贴边"**只覆盖 3 种技法之一**（技法③）。
   *   三种技法与实测参数 → 规格锁 **§5.16.2**；量法铁律 → §5.16.5；BUG-2139~2145。
   *   ★ **本函数的定位**：一对**通用数学工具**（真要做对冲时用它是对的），
   *     但它**既不是这条原片的解释、也不是转场的默认做法**。
   *     选它之前必须回答：「**这个片子真的需要一个加速出画的元素吗？**」
   *     答案若只是"想让过渡好看点" → **拿工具当理由** → 退回三技法表重新选。
   *   ⚠️ 配套判据 `kit/_verify_match.js` 基于旧口径（验"两侧速度匹配成立"），**待重写**。
   *
   * ★ 与「进场禁 ease-in」的关系（§5.11 一票否决不变）：
   *   转场元素属「**工具**」（任务是把画面推走），不属「**目标**」（给人看清的东西），
   *   所以 out 侧用 ease-in 是**合规**的。
   *   判别问句：「这个元素是让观众看清的，还是用来把画面推走的？」
   *
   * 用法（A 段 / B 段的 transition 元素各调各的）：
   *   const m = FX.matchOut(t, { t0: 9.0, dur: 0.45, from: [-300, 0], to: [1100, 0] });
   *   el.style.transform = 'translate(' + m.x + 'px,' + m.y + 'px) scale(' + m.s + ')';
   */
  function matchHandoff(t, o, mode) {
    o = o || {};
    const t0 = o.t0 || 0;
    const dur = o.dur || 0.45;                 /* 规格锁 §5.16.2：限 0.3~0.6s */
    const k = clamp01((t - t0) / dur);
    const e = mode === 'in' ? eo(k) : ei(k);   /* ★ 速度对冲就发生在这一行 */
    const from = o.from || [0, 0];
    const to = o.to || [0, 0];
    return {
      k: k, e: e,
      on: t >= t0 && t <= t0 + dur,
      x: lerp(from[0], to[0], e),
      y: lerp(from[1], to[1], e),
      s: o.scale ? lerp(o.scale[0], o.scale[1], e) : 1,
      r: o.rot ? lerp(o.rot[0], o.rot[1], e) : 0,
    };
  }

  /* ------------------------------------------------------------------ *
   * 导出
   * ------------------------------------------------------------------ */
  const FX = {
    clamp, clamp01, lerp,
    eo, ei, eio, eob,
    c1, seg,
    pop, fade, fadeOut, fadeInOut, env,
    camAt, applyParallax,
    roll, typeOn,
    sweep,
    /* 无缝转场成对使用：A 段 matchOut + B 段 matchIn */
    matchOut: (t, o) => matchHandoff(t, o, 'out'),
    matchIn: (t, o) => matchHandoff(t, o, 'in'),
  };

  global.FX = FX;
  if (typeof module !== 'undefined' && module.exports) module.exports = FX;
})(typeof window !== 'undefined' ? window : globalThis);
