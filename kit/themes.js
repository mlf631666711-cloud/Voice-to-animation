/**
 * themes.js —— Theme Pack 主题包（零依赖，可内联进单文件 HTML）
 *
 * 为什么要有它：
 *   BUG-1921 血泪 —— 换肤只改 CSS，JS 里写死的 #rrggbb 全变隐形，老板截图「完全看不清」。
 *   根因是「颜色耦合在代码里」。Theme Pack 的规矩只有两条：
 *     ① 颜色只准从 CSS 变量来（--c-*），代码里**不许出现裸 #rrggbb**
 *     ② 主题是一份数据，换主题 = 换一份数据，不碰代码
 *
 * 与 Motion Token 的分工：
 *   themes.js 管「长什么样」（颜色 / 字体 / 质感 / 描边 / 阴影）
 *   motion-tokens.js 管「怎么动」（时长 / 缓动 / 错峰）
 *   两者拼起来才是一个完整 skin。
 *
 * 用法：
 *   THEMES.apply('dark-tech');                 // 写到 :root 的 CSS 变量
 *   THEMES.current();                          // 取当前主题对象
 *   THEMES.vars('ink-paper');                  // 只生成 CSS 变量串，不落地
 *
 * ⚠️ 铁律（本工作区审计沉淀，别改坏）：
 *   · 玻璃卡基底必须深 rgba(16,20,44,.28~.42)，禁浅白 —— 浅白 + saturate(180%) 会让白字糊掉
 *   · 深底小字禁用中性灰 #8FA0BE（对比度 ≈1.18），最低 #B5C2DC
 *   · 白/浅卡上的字必须压到 #333~#444，浅灰字（[244,242,243] on [254,254,254]）≈1.07 是事故
 */
(function (g) {
  'use strict';

  var T = {};

  // ---------------------------------------------------------------------------
  // 1. 深底科技 —— 主力（VGA 系列 / 明动 3D / 星角萌萌 都在用这一族）
  // ---------------------------------------------------------------------------
  T['dark-tech'] = {
    id: 'dark-tech',
    name: '深底科技',
    bg: { base: '#050810', from: '#070C1A', to: '#04060E' },
    surface: {
      glass: 'rgba(16,20,44,0.34)',
      glassStrong: 'rgba(16,20,44,0.62)',
      stroke: 'rgba(255,255,255,0.14)',
      radius: 16,
      shadow: '0 18px 50px rgba(0,0,0,0.45)',
      blur: 18
    },
    text: { primary: '#FFFFFF', secondary: '#B5C2DC', tertiary: '#94A3BE', onAccent: '#04121A' },
    accent: { a1: '#35E0D0', a2: '#FF7A3C', a3: '#39FF88', warn: '#FFC24B', danger: '#FF6B6B' },
    font: { family: '"PingFang SC","Microsoft YaHei",system-ui,sans-serif',
            mono: '"JetBrains Mono","SF Mono",Consolas,monospace',
            weightTitle: 600, weightBody: 400, tracking: '0.02em' },
    noise: 0.045,
    onDark: true
  };

  // ---------------------------------------------------------------------------
  // 2. 白底产品页 —— L10 拉距测试那种「纯白世界 + 唯一实物主角」
  // ---------------------------------------------------------------------------
  T['light-product'] = {
    id: 'light-product',
    name: '白底产品页',
    bg: { base: '#FFFFFF', from: '#FFFFFF', to: '#F4F5F7' },
    surface: {
      glass: 'rgba(255,255,255,0.72)',
      glassStrong: 'rgba(255,255,255,0.92)',
      stroke: 'rgba(15,23,42,0.10)',
      radius: 14,
      shadow: '0 16px 44px rgba(15,23,42,0.10)',
      blur: 14
    },
    // ⚠️ 白底上的字必须压深，浅灰 = 事故（som7608 老工程回归实测 1.07）
    text: { primary: '#111827', secondary: '#3A4356', tertiary: '#5A6478', onAccent: '#FFFFFF' },
    accent: { a1: '#2563EB', a2: '#F97316', a3: '#10B981', warn: '#D97706', danger: '#DC2626' },
    font: { family: '"PingFang SC","Microsoft YaHei",system-ui,sans-serif',
            mono: '"JetBrains Mono","SF Mono",Consolas,monospace',
            weightTitle: 700, weightBody: 400, tracking: '0.01em' },
    noise: 0.012,
    onDark: false
  };

  // ---------------------------------------------------------------------------
  // 3. 墨水屏 —— 浅底纸感，低饱和，禁大面积高饱和色块
  // ---------------------------------------------------------------------------
  T['ink-paper'] = {
    id: 'ink-paper',
    name: '墨水屏纸感',
    bg: { base: '#F2F1EC', from: '#F6F5F1', to: '#E9E7E0' },
    surface: {
      glass: 'rgba(255,255,255,0.58)',
      glassStrong: 'rgba(255,255,255,0.86)',
      stroke: 'rgba(28,32,40,0.16)',
      radius: 10,
      shadow: '0 10px 26px rgba(28,32,40,0.12)',
      blur: 8
    },
    text: { primary: '#1A1D24', secondary: '#3D424E', tertiary: '#5C626F', onAccent: '#FFFFFF' },
    accent: { a1: '#1F6FEB', a2: '#C2410C', a3: '#15803D', warn: '#B45309', danger: '#B91C1C' },
    font: { family: '"PingFang SC","Source Han Serif SC","Microsoft YaHei",serif',
            mono: '"JetBrains Mono",Consolas,monospace',
            weightTitle: 600, weightBody: 400, tracking: '0.03em' },
    noise: 0.055,
    onDark: false
  };

  // ---------------------------------------------------------------------------
  // 4. 暖色新媒体 —— 口播 / 种草 / 小红书风，暖底高对比
  // ---------------------------------------------------------------------------
  T['warm-media'] = {
    id: 'warm-media',
    name: '暖色新媒体',
    bg: { base: '#1A1210', from: '#241713', to: '#140E0C' },
    surface: {
      glass: 'rgba(48,28,22,0.38)',
      glassStrong: 'rgba(48,28,22,0.66)',
      stroke: 'rgba(255,220,190,0.16)',
      radius: 18,
      shadow: '0 18px 46px rgba(60,20,10,0.42)',
      blur: 16
    },
    text: { primary: '#FFF6EE', secondary: '#E8CDBB', tertiary: '#C7A892', onAccent: '#2A1206' },
    accent: { a1: '#FF8A3D', a2: '#FFD166', a3: '#FF5D73', warn: '#FFC24B', danger: '#FF4D4F' },
    font: { family: '"PingFang SC","Microsoft YaHei",system-ui,sans-serif',
            mono: '"JetBrains Mono",Consolas,monospace',
            weightTitle: 700, weightBody: 400, tracking: '0.01em' },
    noise: 0.05,
    onDark: true
  };

  // ---------------------------------------------------------------------------
  // 5. C5 TINY 黑金游戏风 —— 近纯黑底 + 金属金 6 阶 + 像素风灰阶
  //
  // 为什么单列而不是复用 dark-tech：
  //   本线是 launch（发布会 / 秀肌肉）类型，基底**近纯黑 + 单色相金**；
  //   dark-tech 是「青绿强调 + 玻璃卡」的通用科技族，色相与质感都不同。
  //   口径见 projects/C5-TINY-Game/C5-TINY-Game-全局视觉方案.md §二（视觉唯一真源）。
  //
  // ★ 为什么这个主题字段比别的多：
  //   本线是「像素风 + 3D 角色 + 三关演示」，需求比通用主题复杂：
  //     gold  6 阶 —— 金属渐变要够档位（图形 6 档 / 文字 3 档，见 §2.2）
  //     px    4 阶 —— 像素风灰阶（硬边、无渐变、色数受限）
  //     hero  5 色 —— 角色专用（sprite 引擎 _hero.js）。这几个是**刻意的设计**，
  //                   不是"跑偏的颜色"—— `_hero.js` 里每色都带设计理由的注释
  //     state 5 色 —— 「三关」讲的失败→修好，需要失败/成功两组状态色
  //
  // ⚠️ 2026-10-01 立此真源的直接动因（漂移实证 · 别删）：
  //   此前同系列三条片子是**三套色板各自为政**——
  //     ① fx_c5_v2.src.html :root   像素调色板，金只 4 阶
  //     ② _hero.js                  硬编码 12 色，与 ① 已差 1 个色阶（#08080C vs #08080D）
  //     ③ fx_c5_l2/l3.src.html      金 6 阶，但 rgba 分量全是手抄
  //   而且 **同名变量 --g3 在 ① 里是 #E6B84A、在 ③ 里是 #B77A22 —— 差整整一档**。
  //   老板肉眼投诉「后面做出来的两条跟全局背景色不一样」，机械原因就是这个。
  //   ⇒ 铁律 324：系列视觉属性必须有单一真源，分镜只许引用、不许重配。
  // ---------------------------------------------------------------------------
  T['c5-tiny'] = {
    id: 'c5-tiny',
    name: 'C5 TINY 黑金游戏风',
    /* 底色：三级全中性。
       ★ 不设 --bg-cold —— 全局方案 §2.1 曾写 #0B1120（偏蓝），但实测开场白
         signalstats U=127.7 / V=128.9 完全中性，该值**从没在任何一条片子里落地过**
         （纯纸面值）⇒ 已删。老板 2026-10-01 定：「定版的是黑金风格，不要冷蓝」。 */
    bg: { base: '#050507', from: '#0C0D12', to: '#12141C' },
    /* 金属金 6 阶 —— 取自参考图位置参数 0-18-38-62-82-100（§2.2） */
    gold: {
      g1: '#3B2105', g2: '#7A4A10', g3: '#B77A22',
      g4: '#E6B84A', g5: '#FFE58A', g6: '#8A520E',
      /* 文字金 = 3 档（模拟正打光）；图形金 = 6 档（模拟斜射光，高光压 62~82%） */
      textGrad: 'linear-gradient(100deg,#B77A22 0%,#E6B84A 45%,#B77A22 100%)',
      shapeGrad: 'linear-gradient(100deg,#3B2105 0%,#7A4A10 18%,#B77A22 38%,#E6B84A 62%,#FFE58A 82%,#8A520E 100%)'
    },
    /* ⚠️ 不设三级文字灰 —— §2.3 实测 #5A564E 只有 2.79（不达 WCAG 4.5）。
       想更弱就用 opacity，别再加一档灰。audit() 已同步支持"角色缺失即跳过"。 */
    text: { primary: '#F2F0E8', secondary: '#9C978C', onAccent: '#050507' },
    state: {
      warn: '#E24B4A',
      ok: '#4FAE6B', okDeep: '#1E5A38', okMid: '#2E8654', okLight: '#8FE0AA'
    },
    /* 像素风灰阶 —— 开场白像素调色板的 4 档明暗，与 3D 场景的 bg 体系并行 */
    px: { k: '#070709', b: '#15151B', d: '#22222B', s: '#363642' },
    /* 角色专用 5 色（sprite 引擎 _hero.js）——
       K=外轮廓 / far=远侧肢体 / near=近侧肢体 / suit=躯干内衬 / S=手套领口 */
    hero: { K: '#08080C', far: '#463A28', near: '#8A5716', suit: '#2E2E3E', S: '#D9CCA6' },
    /* accent 是给通用机制（svgPalette / audit / contrast）用的映射：
       本线是**单色相金**，a1/a2/a3 = 金的三个明度档，不是三个不同色相。
       ⚠️ SVG 素材实际走 _inline.py 内联成 data URI，拿不到宿主 CSS 变量
          ⇒ 只有各自的 fallback 生效（_inline.py 已打 note）。 */
    accent: { a1: '#B77A22', a2: '#E6B84A', a3: '#FFE58A', warn: '#E24B4A', danger: '#E24B4A' },
    font: {
      family: '"Noto Sans SC","Microsoft YaHei",sans-serif',
      mono: '"Cascadia Code","JetBrains Mono",Consolas,monospace',
      px: "'Zpix',\"Microsoft YaHei\",system-ui,sans-serif",
      weightTitle: 900, weightBody: 700, tracking: '0.01em'
    },
    /* 形状语言（§四）：用 polygon 斜切角替 border-radius */
    shape: { cut: 14, radius: 0 },
    noise: 0.0,
    onDark: true
  };

  /** 两个 #rrggbb 线性混色。k=0 → a，k=1 → b。用于派生 SVG 调色板的中间档。 */
  function mix(a, b, k) {
    function p(x) {
      x = String(x).replace('#', '');
      if (x.length === 3) x = x[0] + x[0] + x[1] + x[1] + x[2] + x[2];
      return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
    }
    var A = p(a), B = p(b), o = '#';
    for (var i = 0; i < 3; i++) {
      var v = Math.round(A[i] + (B[i] - A[i]) * k);
      o += ('0' + Math.max(0, Math.min(255, v)).toString(16)).slice(-2);
    }
    return o.toUpperCase();
  }


  /**
   * c5-tiny 专用变量出口 —— C5 线用的是**无 --c- 前缀**的短命名
   * （--bg0 / --g3 / --t1 / --warn…），三条片子的源码已经这么写了，沿用即可。
   *
   * ★ 本函数最值钱的一段是 **rgb 分量双出口**：
   *   漂移的机械原因是「把 hex 手抄成 rgba 分量」——
   *   `rgba(183,122,34,.10)` 里的 183,122,34 是从 #B77A22 手抄来的，
   *   改一个色值要全文搜 4 种写法（#B77A22 / 183,122,34 / 大小写 / 简写），
   *   漏一处就漂移（L2/L3 的 #bgfar 就是这么漂的）。
   *   有了 `--g3-rgb:183,122,34`，业务侧只写 `rgba(var(--g3-rgb),.10)`
   *   ⇒ 单点改、漂不了。
   */
  function c5Vars(t) {
    var o = [];
    function rgb(hex) {
      var h = String(hex).replace('#', '');
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16),
              parseInt(h.slice(4, 6), 16)].join(',');
    }
    function pair(name, hex) {
      o.push('--' + name + ':' + hex);
      o.push('--' + name + '-rgb:' + rgb(hex));
    }
    /* 背景 3 档 */
    pair('bg0', t.bg.base); pair('bg1', t.bg.from); pair('bg2', t.bg.to);
    /* 金属金 6 阶 */
    ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'].forEach(function (k) { pair(k, t.gold[k]); });
    o.push('--gold-text:' + t.gold.textGrad);
    o.push('--gold-shape:' + t.gold.shapeGrad);
    /* 文字 2 档（本线不设三级） */
    pair('t1', t.text.primary); pair('t2', t.text.secondary);
    /* 状态 5 色 */
    pair('warn', t.state.warn); pair('ok', t.state.ok);
    pair('ok-deep', t.state.okDeep); pair('ok-mid', t.state.okMid);
    pair('ok-light', t.state.okLight);
    /* 像素灰 4 档 */
    ['k', 'b', 'd', 's'].forEach(function (k) { pair('px-' + k, t.px[k]); });
    /* 角色 5 色 */
    pair('h-k', t.hero.K); pair('h-far', t.hero.far); pair('h-near', t.hero.near);
    pair('h-suit', t.hero.suit); pair('h-s', t.hero.S);
    /* 字体 */
    o.push('--han:' + t.font.family);
    o.push('--mono:' + t.font.mono);
    o.push('--px-font:' + t.font.px);
    o.push('--cut:' + t.shape.cut + 'px');
    return o;
  }

  /**
   * SVG 角色调色板 —— 给「外来矢量」（unDraw / Iconify / svg-draw 产物）用的 10 个角色。
   *
   * 为什么单列一套：外来 SVG 用的是**角色语义**（墨 / 纸 / 线 / 强调），
   * 不是「文字 / 背景 / 面板」。而且它天生需要**明度反转** ——
   *   unDraw 是「浅底深物」，我们生产主题多是「深底浅物」，
   *   直接贴上去 = 深色主体糊在深色背景里。
   *   解法是**角色名不许动，靠主题值反转来对调**：
   *     深色主题下  --c-ink 取亮色 → 原图的深墨变亮，主体浮出来
   *                --c-paper 取暗色 → 原图的白纸变暗，底沉下去
   *
 * ⚠️ 2026-09-14 补记：此前这 10 个变量在**本线（语音转动画总项目）零定义**
 *    （在本线 grep 定义 = 0 命中，却有一堆文件在用；全工作区 `*.css` 亦未见定义。
 *      工作区其余目录的 `*.js` 未逐个排查 —— 措辞只保证到「本线零定义」这一档），
 *    全靠 svg_norm.py 写的
   *    `var(--c-ink, #090814)` 里的 fallback 撑着 ——
   *    页面看着正常、**主题切换完全无效**。fallback 把缺口掩盖了。
   *    这正是「声明判据证明不了真的画到画面上」的活例。
   */
  function svgPalette(idOrTheme) {
    var t = (typeof idOrTheme === 'string') ? T[idOrTheme]
          : (idOrTheme || current());
    if (!t) throw new Error('未知主题 "' + idOrTheme + '"');
    var ink = t.text.primary, ink2 = t.text.secondary, line = t.text.tertiary;
    var paper = t.bg.base;
    return {
      /* 墨 —— 主体。深色主题取最亮，故原图的深色主体反过来浮在暗底上 */
      '--c-ink': ink,
      '--c-ink-2': ink2,
      /* 线 —— 描边 / 次级结构 */
      '--c-line': line,
      '--c-line-2': mix(line, paper, 0.45),
      /* 柔 —— 介于线与纸之间，作次底 / 阴影块 */
      '--c-soft': mix(line, paper, 0.72),
      /* 纸 —— 图内的承托底。
         ⚠️ 不能直接取 bg.base：那样「纸」与背景同色 = 整个消失。
            2026-09-14 首单肉眼审判抓出：直接映射 bg.base 后，
            原图 12 个 #fff 承托块全隐形，插画显得空、散、缺承托。
            正确做法是往「墨」的方向挪 14% —— 纸沉下去但仍能与背景区分。
            （14% 是四个主题实测的最稳值：9% 时 ink-paper 只有 1.146，卡在阈值上） */
      '--c-paper': mix(paper, ink, 0.14),
      '--c-paper-ink': mix(ink, paper, 0.35),
      /* 强调 —— 与主题 accent 直通 */
      '--c-a1': t.accent.a1,
      '--c-a2': t.accent.a2,
      '--c-a3': t.accent.a3
    };
  }

  /** SVG 调色板里的 7 个「非 accent」角色（a1/a2/a3 已在 vars() 里） */
  var SVG_EXTRA = ['--c-ink', '--c-ink-2', '--c-line', '--c-line-2',
                   '--c-soft', '--c-paper', '--c-paper-ink'];

  // ===========================================================================
  // 落地 / 工具
  // ===========================================================================
  function vars(id) {
    var t = T[id];
    if (!t) throw new Error('未知主题 "' + id + '"，可选：' + Object.keys(T).join(' / '));
    /* ★ c5-tiny 走专用出口：它需要 gold 6 阶 / px 灰阶 / hero 角色色 / rgb 分量，
       与通用 --c-* 体系的字段不同（见 c5Vars）。 */
    if (t.gold) return c5Vars(t).join(';');
    var base = [
      '--c-bg:' + t.bg.base,
      '--c-bg-from:' + t.bg.from,
      '--c-bg-to:' + t.bg.to,
      '--c-glass:' + t.surface.glass,
      '--c-glass-strong:' + t.surface.glassStrong,
      '--c-stroke:' + t.surface.stroke,
      '--c-radius:' + t.surface.radius + 'px',
      '--c-shadow:' + t.surface.shadow,
      '--c-blur:' + t.surface.blur + 'px',
      '--c-text:' + t.text.primary,
      '--c-text-2:' + t.text.secondary,
      '--c-text-3:' + t.text.tertiary,
      '--c-text-on-accent:' + t.text.onAccent,
      '--c-a1:' + t.accent.a1,
      '--c-a2:' + t.accent.a2,
      '--c-a3:' + t.accent.a3,
      '--c-warn:' + t.accent.warn,
      '--c-danger:' + t.accent.danger,
      '--c-font:' + t.font.family,
      '--c-font-mono:' + t.font.mono,
      '--c-w-title:' + t.font.weightTitle,
      '--c-w-body:' + t.font.weightBody,
      '--c-tracking:' + t.font.tracking,
      '--c-noise:' + t.noise
    ];
    /* 追加 SVG 角色 7 个 —— a1/a2/a3 上面已有，不重复写（值同源） */
    var sp = svgPalette(t);
    SVG_EXTRA.forEach(function (k) { base.push(k + ':' + sp[k]); });
    return base.join(';');
  }

  /** 把主题写到 :root（默认）或指定元素的 CSS 变量上。 */
  function apply(id, el) {
    var node = el || (g.document && g.document.documentElement);
    if (!node) return null;
    var t = T[id];
    if (!t) throw new Error('未知主题 "' + id + '"');
    var s = vars(id);
    s.split(';').forEach(function (pair) {
      var i = pair.indexOf(':');
      if (i > 0) node.style.setProperty(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    });
    node.setAttribute('data-theme', id);
    _current = id;
    return t;
  }

  var _current = 'dark-tech';
  function current() { return T[_current]; }
  function list() { return Object.keys(T).map(function (k) { return { id: k, name: T[k].name }; }); }

  /** 相对亮度（WCAG），用于对比度自检。 */
  function lum(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    var r = parseInt(hex.slice(0,2),16)/255, gg = parseInt(hex.slice(2,4),16)/255, b = parseInt(hex.slice(4,6),16)/255;
    function f(c) { return c <= 0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); }
    return 0.2126*f(r) + 0.7152*f(gg) + 0.0722*f(b);
  }
  function contrast(hexA, hexB) {
    var a = lum(hexA), b = lum(hexB);
    return (Math.max(a,b) + 0.05) / (Math.min(a,b) + 0.05);
  }

  /**
   * 主题自检：文字对比度是否达标。
   * 正文 ≥4.5（AA），大字/副标 ≥3.0（AA Large）。深底小字的死穴在 tertiary。
   */
  function audit(id, floor) {
    floor = floor || { primary: 4.5, secondary: 4.5, tertiary: 3.0 };
    var t = T[id];
    if (!t) throw new Error('未知主题 "' + id + '"');
    var bg = t.onDark ? t.bg.base : t.bg.base;
    var out = [];
    ['primary', 'secondary', 'tertiary'].forEach(function (k) {
      var hex = t.text[k];
      /* ★ 角色缺失就跳过 —— c5-tiny 按全局方案 §2.3 明确「不设三级文字灰」；
         老代码会对 undefined 跑 contrast() ⇒ NaN ⇒ 加个主题就把整条门禁弄崩。
         （这是"加了新主题才暴露出来的硬编码假设"：audit 假设三个角色都在。） */
      if (!hex || !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(hex).trim())) return;
      var c = contrast(hex, bg);
      out.push({
        role: k, color: hex, ratio: +c.toFixed(2),
        floor: floor[k], level: c >= floor[k] ? 'OK' : 'FAIL'
      });
    });
    return { theme: id, items: out,
             pass: out.every(function (o) { return o.level === 'OK'; }) };
  }

  /**
   * SVG 调色板自检 —— ★ 判据必须自证有效（规格锁 §5.17.4）
   *
   * 每条判据都要能对「旧状态」判 FAIL，否则它就是在打空拳：
   *   S1 角色齐不齐   → 缺口修复前必然 FAIL（7 个键 undefined），这就是自证
   *   S2 墨/纸对比    → 反转有没有真发生（主体必须与底拉得开，否则糊）
   *   S4 墨/纸亮度差  → 否定「既没反转也没对比」的中间态
   * 用法：THEMES.svgAudit('dark-tech')
   */
  function svgAudit(id) {
    var t = T[id];
    if (!t) throw new Error('未知主题 "' + id + '"');
    var sp = svgPalette(t);
    var out = [];

    var missing = Object.keys(sp).filter(function (k) {
      var v = sp[k];
      return !v || !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(v).trim());
    });
    out.push({ id: 'S1', what: '10 个角色全部有合法色值',
               got: missing.length ? '缺/非法: ' + missing.join(',') : '10/10',
               level: missing.length ? 'FAIL' : 'OK' });

    var c2 = contrast(sp['--c-ink'], sp['--c-paper']);
    out.push({ id: 'S2', what: '墨 vs 纸 对比度 >= 4.5',
               got: (+c2).toFixed(2), level: c2 >= 4.5 ? 'OK' : 'FAIL' });

    var c3 = contrast(sp['--c-a1'], sp['--c-paper']);
    out.push({ id: 'S3', what: '强调 a1 vs 纸 对比度 >= 2.0',
               got: (+c3).toFixed(2), level: c3 >= 2.0 ? 'OK' : 'FAIL' });

    var dl = Math.abs(lum(sp['--c-ink']) - lum(sp['--c-paper']));
    out.push({ id: 'S4', what: '墨/纸 亮度差 >= 0.20（确实拉开）',
               got: dl.toFixed(3), level: dl >= 0.20 ? 'OK' : 'FAIL' });

    /* ★ S5 纸 vs 背景 —— 2026-09-14 首单肉眼审判补出来的判据。
       原判据只验「墨 vs 纸」，漏了「纸 vs 背景」；
       而正是这一条决定原图的承托块看不看得见。
       旧值（--c-paper = bg.base）在此必然 FAIL，故本条自带自证。 */
    var c5 = contrast(sp['--c-paper'], t.bg.base);
    out.push({ id: 'S5', what: '★ 纸 vs 背景 对比度 >= 1.15（承托块不能隐形）',
               got: (+c5).toFixed(3), level: c5 >= 1.15 ? 'OK' : 'FAIL' });

    out.push({ id: 'info', what: '反转方向',
               got: lum(sp['--c-ink']) > lum(sp['--c-paper'])
                    ? '深底浅物（墨亮于纸）' : '浅底深物（墨暗于纸）',
               level: 'OK' });

    return { theme: id, palette: sp, items: out,
             pass: out.every(function (o) { return o.level === 'OK'; }) };
  }

  g.THEMES = {
    T: T, vars: vars, apply: apply, current: current, list: list,
    lum: lum, contrast: contrast, audit: audit,
    /* SVG 角色调色板（2026-09-14 补：此前全项目零定义） */
    svg: svgPalette, svgAudit: svgAudit, mix: mix, SVG_EXTRA: SVG_EXTRA,
    c5Vars: c5Vars
  };
})(window);
