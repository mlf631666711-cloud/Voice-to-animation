/**
 * kit/layout_check.js —— 版面三类客观检查（标准件 · 通用）
 *
 * 通用化自 `voice-axis-scan/scan_bottom.js`（原版把 ROOT / 文件名模式写死，
 * 只能扫 video-style-lab 的 fx_*.html）→ 参数化后任何单文件动效 HTML 都能扫。
 *
 * 查三类（全部读**真实渲染**的 getBoundingClientRect + 有效 opacity 链乘）：
 *   ① 字幕净空区越界   bottom > 880（规格锁 §2.1 字幕净空区 y[900,1080]）
 *   ② 文字 × 文字 两两重叠（BUG-1910 / BUG-1916 同坐标抢位）
 *   ③ 文字 × 场景图（产品图/底板）重叠（BUG-2043 / BUG-2047 压住正文——几何能测，
 *      但「压住了好不好读」仍必须人眼看稳态帧，见规格锁 §5.16.7 G5）
 *
 * 有效 opacity 沿父链累乘 —— 只看自身 opacity 会被父层隐藏骗过（BUG-2120）。
 * 可见判据用 offsetWidth（layout 尺寸）而非 rect —— 只靠 scale(0) 隐藏的元素
 * rect 会塌成 0，用 rect 判会漏掉（本轮实测踩过）。
 *
 * ★ 修订 2026-09-30（DG-267 / DG-268 / DG-271，C5-TINY-Game 硬切改造时暴露）：
 *   ① **①c 静止态判定的邻居改取「全帧序列」**（原来只取「越线样本序列」⇒
 *      元素「进线又出线」被采样步长跨空 ⇒ 邻居缺失 ⇒ **假 FAIL**）。口径与 ① 安全框统一。
 *   ② `arg()` 同时支持 `--name value` 与 `--name=value`（后者原来**静默失效**）。
 *   ③ 新增 `--inject=<mode>` 注入故障自证（`clrrest` 证它会报 · `clrsweep` 证它不报假 FAIL）。
 *   ④ **数值参数走 `num()`**：`parseFloat('1/30')` = **1**（在 `/` 处截断）⇒ 传 `--step 1/30`
 *      的人以为在要「30 帧/秒」，实际拿到「1 秒/步」—— **静默欠采样**（DG-271，DG-268 同族）。
 *      现在 `1/30` ⇒ 0.0333…，且头部会打印**样本数** + 粗步长告警。
 *
 * 用法:
 *   NODE_PATH=<puppeteer 所在 node_modules> node kit/layout_check.js \
 *     --file projects/uvc-seg8/uvc_p4_why.html --dur 19.0 [--step 0.1] [--fig boardImg]
 *
 * ★ 2026-09-30 `--inject=<mode>`：判据**注入故障自证**（元规则「先证它能报错，再信它说没事」）。
 *   一条全绿的判据既可能是"真没问题"，也可能是"这条判据压根不会报"——报告上长得一模一样。
 *   现支持：
 *     --inject=clrrest   在净空区内**停**一个满 opacity 元素 ⇒ ①c **必须** FAIL（证它会报）
 *     --inject=clrsweep  一个元素在净空区内**逐帧进出**（相邻采样帧之间来回跳）⇒ ①c **必须**不报 FAIL
 *                        （证它不再因"越线样本被步长跨空"而报**假 FAIL**；这条是**反注入**）
 */
const puppeteer = require('puppeteer-core');
const path = require('path');

function arg(name, def) {
  const key = '--' + name, eq = key + '=';
  // ⚠️ 判据「有没有传」不能用 truthiness —— **显式传空串是合法意图**。
  //    本工具首版写的是 `process.argv[i+1] ? … : def`，于是 `--subtitle ""`
  //    （本段不产字幕、要空豁免表）被当成"没传"→ 悄悄退回默认 `capInner,cap`。
  //    与 BUG-2171（默认值≠规格）同族：**判据参数被静默改写 = 判据口径 ≠ 调用者意图**。
  // ★ 2026-09-30：同时支持 `--name value` 与 `--name=value` 两种写法
  //    （`--inject=<mode>` 用后者更自然）。⚠️ 首版只认前者 ⇒ `--inject=clrrest`
  //    被 `indexOf('--inject')` 判成"没传" ⇒ 注入**静默失效**、报告与不注入时一字不差
  //    —— 正是「跳过 ≠ 通过」那一族：**注入没生效，看起来却像"判据没报"**。
  //    两种写法对"显式空串"的判定保持一致（`--x=` ⇒ 空串，不是"没传"）。
  const eqHit = process.argv.find(a => a.startsWith(eq));
  if (eqHit !== undefined) return eqHit.slice(eq.length);
  const i = process.argv.indexOf(key);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

/* ★ 2026-09-30（DG-271，与 DG-268 同族）：**数值参数必须能认 `1/30` 这种写法**。
   `parseFloat('1/30')` 在 `/` 处截断 ⇒ 返回 **1**（不是 0.0333…）⇒ 传 `--step 1/30`
   的人以为在要「30 帧/秒」，实际拿到「1 秒/步」—— **静默量错步长**，报告上完全看不出来。
   （同族 DG-268：`--name=value` 被 `indexOf` 判成"没传" ⇒ 注入静默失效。
   一句话：**参数被静默改写 = 我量的不是我说的那个东西**。）
   修法：数值一律走 `num()` —— 先按 JS 表达式求值（`'1/30'` ⇒ 0.0333…），
   非有限数就**报错退出**（不许静默退回默认值）。 */
function num(raw, def) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return def;
  let v;
  try { v = Function('"use strict";return (' + raw + ')')(); } catch (e) { v = NaN; }
  if (typeof v !== 'number' || !isFinite(v)) {
    console.error('[layout_check] ✗ 参数值不是合法数值：' + JSON.stringify(raw)
      + '（支持 `0.1` 与 `1/30` 两种写法）');
    process.exit(2);
  }
  return v;
}

const FILE = path.resolve(arg('file', ''));
const DUR = num(arg('dur', '0'), 0);
const STEP = num(arg('step', '0.1'), 0.1);
const FIG = arg('fig', 'boardImg');        // 场景图 id（可留空）
const CHROME = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const SAFE_BOTTOM = num(arg('safeBottom', '880'), 880);
const SAFE_LEFT   = num(arg('safeL', '80'), 80);
const SAFE_RIGHT  = num(arg('safeR', '1840'), 1840);
const SAFE_TOP    = num(arg('safeT', '80'), 80);
// ⚠️ 上面这个默认值**必须照抄规格锁 §2.1**（`y[80,880]`），不许凭印象填。
//    本工具首版写的是 **70** —— 比规格**松 10px**，等于给越界元素放水：
//    `psramNum` top=76 在 70 口径下判 **PASS**，在真口径 80 下是 **FAIL**。
//    **判据默认值 ≠ 规格 = 静默假 PASS**（§7.1 第 2/4 条：口径必须同量）。
// HUD 层上边界（规格锁 §2.1：`HUD 层（章节条/角标）y[36,140]`）—— 与主元素区**并存**。
//    ⚠️ **只对显式声明 `data-hud="1"` 的元素生效**，其余一律走主元素区 SAFE_TOP。
//    不许做"看着像 HUD 就算 HUD"的推断 —— 同「1008 例外须显式声明」的哲学，
//    否则这个参数会退化成万能逃生门。
const HUD_TOP     = num(arg('hudTop', '36'), 36);
// ★ 2026-09-15 新增：HUD 层**下界**（规格锁 §2.1「HUD 层 y[36,140]」）。
//   原来只有上界 → 下界错用了主元素区的 SAFE_BOTTOM(880) → HUD 元素垂到 880 都不报，判据留洞。
const HUD_BOT     = num(arg('hudBot', '140'), 140);
// ⚠️ 字幕本体就在字幕区里 —— 检查「净空区越界」必须把它排除，
//    否则每次必报 FAIL（口径错：量的是"字幕有没有在字幕区"这种废话）
const SUBTITLE = arg('subtitle', 'capInner,cap').split(',').map(s => s.trim()).filter(Boolean);
// ①c 字幕净空区上界（规格锁 §2.1：`y[900,1080]` **全宽净空**，给字幕让位）。
//    ⚠️ 与 SAFE_BOTTOM(880) 是**两条不同的线**：880 是"主元素区下界"，900 是"净空区起点"，
//       880~900 是缓冲带。① 只查**文字**、①b 只查**场景图** —— 图形/装饰元素两条都漏，
//       于是本段 `#waveWrap`（含 canvas，绘制范围到 948px）静止态压进净空区 48px 却全程 0 报错。
//       **净空区的语义是"这一带本来就该是空的"** → 判据必须查**所有有绘制的可见元素**，不分文字/图形。
const CLR_TOP = num(arg('clearTop', '900'), 900);
// ★ 2026-09-30 `--inject`：注入故障自证（见文件头用法说明）。
const INJECT = arg('inject', '');
// 背景层白名单：它们是"铺满画面的环境层"，本来就该覆盖全屏（字幕压在它们之上）。
// ⚠️ 白名单必须**按 id 显式列**，不许做"看着像背景就算背景"的推断（同 data-hud 的哲学）。
// ★ 2026-09-15 参数化 `--bg`：默认值原本**写死 seg8 的 id** → 换工程（uvc-seg9）时
//   `g-floor` / `g-back` 这类环境层不被豁免，①c 直接吐 2 条假 FAIL（一个下缘 1728px）。
//   与「TEXT_IDS 写死」是**同一个病**（BUG-2171 家族：默认值写死某个工程的常量）。
//   与 `--subtitle` 同款写法：`!== undefined` 判"有没有传"，显式空串是合法意图。
const BG_OK = ['bgGrid', 'vig', 'bgGlow', 'innerBg', 'innerGrid', 'traces',
               'boardShadow', 'irisGrow', 'irisShrink'];
// 选择器写法：`#id` / `.class` 原样用，裸词按 id 处理（与旧口径逐字兼容）。
const BG_EXTRA = (arg('bg', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const BG_ALL = BG_OK.map(s => (s[0] === '#' || s[0] === '.') ? s : '#' + s)
  .concat(BG_EXTRA.map(s => (s[0] === '#' || s[0] === '.') ? s : '#' + s));

if (!FILE || !DUR) {
  console.error('用法: node kit/layout_check.js --file <html> --dur <sec> [--step 0.1] [--fig boardImg]');
  console.error("      [--text \"#id,.cls\"] 文字元素（支持选择器；默认 = seg8 的 id 表）");
  console.error('      [--bg .cls1,#id2] 额外环境层白名单（支持 class 选择器）');
  process.exit(2);
}

// ★ 2026-09-15 参数化 `--text`：这张表原本**写死 seg8 的 16 个 id**，换工程后
//   `querySelectorAll` 一个都找不到 → ④ 报「同刻文字元素数 0 个」，
//   而 ② 文字×文字、③ 文字×场景图 两条**双双 PASS**。
//   ★★ 这是最坏的一种假信号：**PASS 是"没找到东西"，不是"没有重叠"**。
//   自检问题（§7.1）：「这条 PASS 若 bug 存在，它会变成 FAIL 吗？」→ 不会，
//   因为 `vis` 恒为空数组。**空判 = 没验。**
//   修法同 `--subtitle`：显式传参优先，不传才退回 seg8 默认表（向后兼容）。
const TEXT_IDS = (arg('text', '') || '').split(',').map(s => s.trim()).filter(Boolean);
if (!TEXT_IDS.length) TEXT_IDS.push('titleQ', 'capInner', 'chipTag', 'mcuSeal', 'segSeal', 'ioCam', 'ioScr',
  'ioCamName', 'ioScrName', 'vpuTitle', 'vpuDual', 'vpuSub', 'psramLbl', 'psramNum',
  'steadySeal', 'waveLbl');

(async () => {
  const b = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--allow-file-access-from-files', '--force-device-scale-factor=1', '--hide-scrollbars']
  });
  const p = await b.newPage();
  await p.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await p.goto('file:///' + FILE.replace(/\\/g, '/') + '?t=0', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 2000));
  await p.evaluate(() => { const s = document.getElementById('startOv'); if (s) s.style.display = 'none'; });

  /* ★ 2026-09-30 `--inject`：判据**注入故障自证**（元规则「先证它能报错，再信它说没事」）。
     ⚠️ 三条纪律：
        ① 注入物必须落在**被测对象身上**（这里 = `#screen` 内的有绘制元素，正是 ①c 的取样域）；
        ② 只造**一个**故障，别连带惊动其它判据 —— 本 probe 是 `#screen` 子元素，
           但 ①/②/③/④ 只遍历 `TEXT_IDS` 的 `vis`，**看不到** probe ⇒ 只惊动 ①c；
        ③ 注入的**期望结果要写死**（见文件头），跑完对不上就是判据坏了。 */
  if (INJECT) {
    const inj = await p.evaluate((mode, STEP) => {
      const screen = document.getElementById('screen') || document.body;
      const d = document.createElement('div');
      d.id = '__injClr';
      d.style.cssText = 'position:absolute;left:760px;width:400px;height:120px;'
        + 'background:#ff2fb0;z-index:99999;';
      screen.appendChild(d);
      if (mode === 'clrrest') {
        // 净空区内**停住**：top 820 ⇒ 下缘 940 > 900，且全程不动 ⇒ ①c 必须 FAIL
        d.style.top = '820px';
        return 'clrrest：probe 停在 top=820（下缘 940 > 900）不动 ⇒ 期望 ①c 报 FAIL';
      }
      if (mode === 'clrsweep') {
        // 在净空区内**逐帧进出**：按采样序号奇偶在"越线 / 不越线"之间来回跳。
        // ⇒ 每个越线样本的前后邻居都是"不越线" ⇒ 复现老 bug 的取样条件
        //   （越线样本序列里邻居缺失）⇒ 期望新判据**不报 FAIL**（正确判为运动态）。
        const orig = window.__frame;
        window.__frame = function (t) {
          const r = orig ? orig.apply(this, arguments) : undefined;
          d.style.top = (Math.round(t / STEP) % 2 === 0) ? '820px' : '700px';
          return r;
        };
        d.style.top = '820px';
        return 'clrsweep：probe 按采样序号奇偶在 top 820/700 间逐帧跳 ⇒ 期望 ①c **不报** FAIL（运动态）';
      }
      return '未知模式：' + mode;
    }, INJECT, STEP);
    console.log('[layout_check] ⚑ 注入自证模式 → ' + inj);
  }

  /* ★ 坐标系自检（2026-09-21 · 4K 轮）—— 完整说明见 `kit/boxchk.js` 顶部同一段。
     安全框常量（SAFE_LEFT/TOP/RIGHT/BOTTOM/CLR_TOP）全是**设计坐标系**（1920×1080）里的数，
     量的是 `getBoundingClientRect()`，而 rect **永远返回 CSS px**。
     出 4K 的正确姿势是「视口保持设计尺寸 + 抬 devicePixelRatio」⇒ **CSS 坐标系不变**，
     ⇒ 安全框**不许等比例放大**（反证实测 `_tmp/_safearea_ab.cjs`：×2 框在本画面会把
     绝大多数元素判成「左+24」之类 —— 判据方向反了就恒 FAIL，且是「看起来很认真」的那种）。
     本工具把视口钉死在 1920×1080 ⇒ 口径天然一致；但**仍必须显式验一次**，
     否则日后有人把视口改成输出尺寸，判据会静默地在错的坐标系里给一个绿。 */
  const env = await p.evaluate(() => ({
    dpr: window.devicePixelRatio,
    innerW: window.innerWidth, innerH: window.innerHeight,
    bodyW: document.body ? document.body.offsetWidth : 0,
    bodyH: document.body ? document.body.offsetHeight : 0,
    rasterW: window.innerWidth * window.devicePixelRatio,
    rasterH: window.innerHeight * window.devicePixelRatio,
  }));
  console.log('[layout_check] 坐标系：视口 ' + env.innerW + '×' + env.innerH
    + ' · dpr ' + env.dpr + ' · 设计(body) ' + env.bodyW + '×' + env.bodyH
    + ' · 截图栅格 ' + env.rasterW + '×' + env.rasterH);
  if (env.bodyW > 0 && Math.abs(env.bodyW - 1920) > 8) {
    console.log('');
    console.log('[layout_check] ⚠️ N/A —— **本判据不适用**：安全框常量属于 1920×1080 设计坐标系，'
      + '而页面是按 ' + env.bodyW + ' 排的版 (视口 ' + env.innerW + ')。');
    console.log('  ⇒ 要先按 ' + (1920 / env.bodyW).toFixed(2) + '× 换算安全框；'
      + '且先确认渲染姿势不是「大画布 + 小画面」(BUG-2398)。');
    console.log('  ⇒ 结论写 **N/A**，不是 PASS —— 「查不到」不等于「没问题」。');
    await b.close();
    process.exit(2);
  }

  const res = await p.evaluate((TEXT_IDS, DUR, STEP, FIG, SAFE_BOTTOM, SUBTITLE, SAFE_LEFT, SAFE_RIGHT, SAFE_TOP, HUD_TOP, HUD_BOT, CLR_TOP, BG_ALL) => {
    // ⚠️⚠️ 行盒 ≠ 墨迹盒（2026-09-15 uvc-seg8 实测 · 「元素盒≠墨迹盒」家族**第三次复发**）：
    //    `Range.getClientRects()` 返回的是**行盒**（line box），它把行高里的
    //    "半行距 + 字体上下留白"都算进去了，比字形真实绘制的墨迹**高出一大截**。
    //    uvc-seg8 实测（A/B 像素差分求真值，`_ink.js` + `_tmp/_diff.py`）：
    //      titleQ  行盒 top=71 → **墨迹 top=100**（差 **29px**，100px 字号）
    //      psramNum 元素盒 top=75.8 → 墨迹 84（差 8px）
    //    结果：① **把两个本来合规的元素判成 FAIL**（差点照着"改错一个正确的参数"）。
    //    正解 = 用 canvas `measureText` 的 **actualBoundingBox*** 把行盒换算成字形墨迹：
    //      baselineY = 行盒top + (行盒高 − (字体ascent+descent))/2 + 字体ascent
    //      inkTop    = baselineY − actualBoundingBoxAscent
    //      inkBottom = baselineY + actualBoundingBoxDescent
    //    ⚠️ 另有一类**根本不该进判据**的帧：元素**入场/退场飞行**中（低 opacity + 大位移）
    //      必然扫过安全框边界。uvc-seg8 实测：`titleQ` 的 71 出现在 t=3.20 **opacity 0.63**
    //      （正在淡出上飘）；`psramNum` 的 75.8 出现在 t=14.4 **opacity 0.15**（正在入场下移，
    //      静止后是 100.7）。安全框是**构图**约束，只管"元素停在哪儿"，不管"它怎么飞过去"。
    //      → 只对**静止态**（opacity ≥ 峰值×0.95 且相邻帧位移 ≈ 0）判越界；
    //        运动态的越界另计为 `NOTE`，只报不断罪。
    const cvs = document.createElement('canvas');
    const ctx = cvs.getContext('2d');
    const inkBox = (e) => {
      const cs = getComputedStyle(e);
      const opaque = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || cs.backgroundImage !== 'none'
                  || parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderLeftWidth) > 0;
      const r0 = e.getBoundingClientRect();
      if (opaque || r0.width < 1200) return r0;   // 有底/有框 → 元素盒就是视觉盒
      try {
        // ⚠️ 不能用 `selectNodeContents(e)`：容器内若有**块级子元素**（如 `.big`），
        //    它返回的是**子块的盒**（宽 1920）而不是文字墨迹 → `steadySeal` 仍报假 FAIL。
        //    正解：TreeWalker **逐个文本节点**量。
        let l = 1e9, t = 1e9, rr = -1e9, b = -1e9, got = false;
        const walk = document.createTreeWalker(e, NodeFilter.SHOW_TEXT, null);
        let n;
        while ((n = walk.nextNode())) {
          if (!n.nodeValue || !n.nodeValue.trim()) continue;
          const pe = n.parentElement;
          const pcs = getComputedStyle(pe);
          ctx.font = pcs.fontStyle + ' ' + pcs.fontWeight + ' ' + pcs.fontSize + ' ' + pcs.fontFamily;
          const m = ctx.measureText(n.nodeValue);
          const fa = m.fontBoundingBoxAscent, fd = m.fontBoundingBoxDescent;
          const ia = m.actualBoundingBoxAscent, id = m.actualBoundingBoxDescent;
          const rg = document.createRange(); rg.selectNodeContents(n);
          for (const x of rg.getClientRects()) {
            if (x.width < 0.5 && x.height < 0.5) continue;
            let tl = x.top, bl = x.bottom, ll = x.left, rl = x.right;
            if (isFinite(fa) && isFinite(ia) && (fa + fd) > 0) {
              const base = x.top + (x.height - (fa + fd)) / 2 + fa;   // 行盒 → 基线
              tl = base - ia; bl = base + id;
            }
            l = Math.min(l, ll); t = Math.min(t, tl);
            rr = Math.max(rr, rl); b = Math.max(b, bl);
            got = true;
          }
        }
        if (got && rr > l && b > t) return { left: l, top: t, right: rr, bottom: b, width: rr - l, height: b - t };
      } catch (err) {}
      return r0;
    };
    const N = Math.round(DUR / STEP);
    /* ★ 2026-09-15：`--text` 支持**选择器**（`#id` / `.class`）。
       原来是纯 id 表 → `document.getElementById` 只能命中单个元素，而工程里
       "卡片标题 / 副标"这类文字通常只有 class、没有 id，逼得工程去**改 HTML 适配工具**。
       正解是让工具通用：`^[.#]` 走 `querySelectorAll`（可命中多个，用 `键#序号` 保证唯一），
       裸词仍走 `getElementById`（与 seg8 的旧表逐字兼容）。 */
    const TXT = [];
    TEXT_IDS.forEach(spec => {
      if (/^[.#]/.test(spec)) {
        document.querySelectorAll(spec).forEach((e, i) => TXT.push({ k: spec + '#' + i, e: e }));
      } else {
        const e = document.getElementById(spec);
        if (e) TXT.push({ k: spec, e: e });
      }
    });
    const figEl = FIG ? document.getElementById(FIG) : null;
    let figEx = null;
    const rows = [];

    /* ── ①c 准备：挑出「有绘制的可见元素」用于字幕净空区检查 ──
       「有绘制」= 自身画了东西（背景色/背景图/边框 / 是 canvas·img·svg）。
       ⚠️ 两处踩过的坑：
          ① 不能用"所有元素"—— 纯定位容器（`#screen`/`#viewport`/`#uiL`）inset:0 铺满全屏、
             bottom=1080 永远越界，报出来是噪声不是缺陷；
          ② 不能把 SVG **内部图元**（path/rect/circle）当独立元素 —— 它们的绘制由 `<svg>` 代表，
             而且 `e.className` 是 `SVGAnimatedString` **对象**（不是字符串），拼进 key 会炸
             （`Cannot read properties of undefined (reading 'path.[object SVGAnimatedString]')`）。
       ⚠️ 豁免必须按**祖先**判（`closest`），不能只判元素自身 id：
          `#traces` 豁免了，它的 `<path>` 子元素还照报。 */
    /* key → 元素 的映射（① 安全框那一段要读 `data-hud`，按 key 取回元素）。
       ⚠️ 必须保留 `el` 这个名字与 `el[key]` 的取值方式 —— 否则后面那句
       `const e = el[id]` 直接 ReferenceError，**整个 evaluate 挂掉、报告全空**。 */
    const el = {}; TXT.forEach(t => { el[t.k] = t.e; });

    const BG_SEL = BG_ALL.join(',');
    // ⚠️ `closest('')` 会抛 SyntaxError —— 白名单为空时（调用方显式传 `--bg ""`）
    //    必须短路成"没有豁免"，否则整个 evaluate 挂掉、报告全空。
    const bgSkip = (e) => BG_SEL ? (e.closest && e.closest(BG_SEL)) : null;
    const paints = e => {
      const s = getComputedStyle(e);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      const bg = s.backgroundColor || '';
      if (bg && !/^(rgba?\(0,\s*0,\s*0(,\s*0)?\)|transparent)$/.test(bg)) return true;
      if (s.backgroundImage && s.backgroundImage !== 'none') return true;
      if (parseFloat(s.borderTopWidth) > 0 || parseFloat(s.borderBottomWidth) > 0) return true;
      const tg = e.tagName.toLowerCase();
      return tg === 'canvas' || tg === 'img' || tg === 'svg';
    };
    const inkEls = [];
    document.querySelectorAll('#screen *').forEach(e => {
      if (bgSkip(e)) return;          // 环境层 + 其所有后代，豁免
      if (!paints(e)) return;
      const cls = (e.getAttribute && e.getAttribute('class')) || '';
      inkEls.push({ k: e.id || (e.tagName.toLowerCase() + (cls ? '.' + cls.split(' ')[0] : '')), e: e });
    });
    const clrFrames = [];       // 每帧：{k:{b,o,l,t}}

    for (let i = 0; i <= N; i++) {
      const t = i * STEP;
      window.__frame(t);
      const vis = [], box = {}, op = {};
      TXT.forEach(({ k, e }) => {
        let o = 1, n = e;
        while (n && n.nodeType === 1) { o *= parseFloat(getComputedStyle(n).opacity); n = n.parentElement; }
        if (o < 0.5 || e.offsetWidth < 3 || e.offsetHeight < 3) return;
        const r = inkBox(e);
        if (r.width < 2 || r.height < 2) return;
        vis.push(k); box[k] = [r.left, r.top, r.right, r.bottom]; op[k] = o;
      });
      let fb = null;
      if (figEl && figEl.offsetWidth > 2) {
        // ⚠️ 场景图也要按**有效 opacity** 判可见 —— 否则入场前/退场后那些"有尺寸但全透明"
        //    的帧会被算进来，报出观众根本看不到的越界（判据 ≠ 观众眼睛里的东西）。
        let fo = 1, fn = figEl;
        while (fn && fn.nodeType === 1) { fo *= parseFloat(getComputedStyle(fn).opacity); fn = fn.parentElement; }
        if (fo > 0.05) { const r = figEl.getBoundingClientRect(); fb = [r.left, r.top, r.right, r.bottom]; }
      }
      // ①b 场景图（产品图/底板）—— 它通常比任何文字都大，是「画面安全框超出」的头号嫌疑。
      //     ⚠️ 产品图**相机一直在动**，静止态可能根本不存在 → 不套静止态过滤，
      //        改为报**全程极值**（构图约束本来就要求全程成立）。
      if (fb) {
        if (!figEx) figEx = { t0: t, t1: t, T: fb[1], B: fb[3], L: fb[0], R: fb[2], worstB: -1e9, worstT: 1e9, tB: t, tT: t, n: 0, nBad: 0 };
        figEx.t1 = t; figEx.n++;
        figEx.T = Math.min(figEx.T, fb[1]); figEx.B = Math.max(figEx.B, fb[3]);
        figEx.L = Math.min(figEx.L, fb[0]); figEx.R = Math.max(figEx.R, fb[2]);
        if (fb[3] > figEx.worstB) { figEx.worstB = fb[3]; figEx.tB = t; }
        if (fb[1] < figEx.worstT) { figEx.worstT = fb[1]; figEx.tT = t; }
        if (fb[1] < SAFE_TOP || fb[3] > SAFE_BOTTOM || fb[0] < SAFE_LEFT || fb[2] > SAFE_RIGHT) figEx.nBad++;
      }
      /* ①c 采集：两份数据，用途不同，**不能混** ——
         · `boxAll` = 本帧**所有**有绘制元素的位置 [left, top] + 有效 opacity。
           ⚠️ 它的唯一用途是给 ①c 的**静止态判定取邻居**，所以必须**逐帧都记**
              （无论该元素本帧有没有越过净空线）。原因见聚合段那段「假 FAIL」注释。
         · `cm` = 其中下缘**越过净空线上界**的那些（供越界计分）。 */
      const cm = {}, boxAll = {};
      inkEls.forEach(it => {
        const e = it.e;
        let o = 1, n = e;
        while (n && n.nodeType === 1) { o *= parseFloat(getComputedStyle(n).opacity); n = n.parentElement; }
        if (o < 0.5 || e.offsetWidth < 3 || e.offsetHeight < 3) return;
        const r = e.getBoundingClientRect();
        boxAll[it.k] = [r.left, r.top, o];
        if (r.bottom > CLR_TOP) cm[it.k] = { b: +r.bottom.toFixed(1), o: o, l: r.left, t: r.top };
      });
      clrFrames.push(cm);
      rows.push({ t: +t.toFixed(2), vis, box, op, fig: fb, boxAll });
    }
    /* ── 静止态判定（安全框只管"元素停在哪儿"，不管"它怎么飞过去"）──
       rest = 有效 opacity ≥ 自身峰值×0.95 **且** 与相邻采样帧的位移 ≈ 0。
       ⚠️ 峰值取自身而不是绝对值 1：有些元素设计上就是半透明常量。 */
    const peakOp = {};
    rows.forEach(r => r.vis.forEach(id => { peakOp[id] = Math.max(peakOp[id] === undefined ? 0 : peakOp[id], r.op[id]); }));
    const moved = (a, b) => {
      if (!a || !b) return false;
      return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) > 1.0;
    };
    const isRest = (i, id) => {
      const r = rows[i];
      if (r.op[id] < (peakOp[id] || 1) * 0.95) return false;
      const a = i > 0 ? rows[i - 1] : null, c = i < rows.length - 1 ? rows[i + 1] : null;
      return !moved(r.box[id], a && a.box[id]) && !moved(r.box[id], c && c.box[id]);
    };
    const ov = (a, b) => { const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]); return (w > 0 && h > 0) ? w * h : 0; };
    const area = a => (a[2] - a[0]) * (a[3] - a[1]);
    const pair = {}, withFig = {}, safeHits = {}, motionHits = {};
    rows.forEach((r, ri) => {
      // ① 安全框：**只在静止态判**；运动态越界记 motionHits（只报不断罪）
      r.vis.forEach(id => {
        if (SUBTITLE.includes(id)) return;
        const e = el[id];
        /* ★ 2026-09-15：`data-hud` 必须**沿祖先链找**，不能只读元素自身。
           实测踩过：`#pillHud`（容器）声明了 `data-hud="1"`，而违规的是它的子元素 `.wp`
           —— 子元素没有该属性 → 判据退回主元素区上界 80 → **7 条假 FAIL**。
           语义上 HUD 是一条**带**（规格锁 §2.1「HUD 层 y[36,140]」），
           声明在容器上就该覆盖其内容；`closest` 正是「这一层里」的意思。 */
        const hud = !!(e && e.closest && e.closest('[data-hud="1"]'));
        const topBound = hud ? HUD_TOP : SAFE_TOP;
        // ⚠️ 下界同样要分档：HUD 元素的下界是 HUD_BOT(140)，不是主元素区的 SAFE_BOTTOM(880)。
        //    原来一律用 SAFE_BOTTOM → HUD 元素可以一路垂到 880 都不报，**判据留了个洞**。
        const botBound = hud ? HUD_BOT : SAFE_BOTTOM;
        const b = r.box[id];
        const hits = [];
        if (b[3] > botBound) hits.push({ dir: hud ? 'bottom_hud' : 'bottom', val: b[3] });
        if (b[1] < topBound) hits.push({ dir: hud ? 'top_hud' : 'top', val: b[1] });
        if (b[0] < SAFE_LEFT) hits.push({ dir: 'left', val: b[0] });
        if (b[2] > SAFE_RIGHT) hits.push({ dir: 'right', val: b[2] });
        if (!hits.length) return;
        const sink = isRest(ri, id) ? safeHits : motionHits;
        hits.forEach(o => {
          const key = id + ' · ' + o.dir;
          if (!sink[key]) sink[key] = { frames: 0, val: 0, t0: r.t, t1: r.t, dir: o.dir };
          const h = sink[key];
          h.frames++; h.t1 = r.t;
          if (o.dir === 'bottom' || o.dir === 'right') h.val = Math.max(h.val, o.val);
          else h.val = h.frames === 1 ? o.val : Math.min(h.val, o.val);
        });
      });
      const v = r.vis;
      for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) {
        const A = r.box[v[i]], B = r.box[v[j]], o = ov(A, B);
        if (o > 0) {
          const k = v[i] + ' × ' + v[j];
          if (!pair[k]) pair[k] = { frames: 0, maxArea: 0, maxRatio: 0, t0: r.t, t1: r.t };
          pair[k].frames++; pair[k].t1 = r.t;
          pair[k].maxArea = Math.max(pair[k].maxArea, o);
          pair[k].maxRatio = Math.max(pair[k].maxRatio, o / Math.min(area(A), area(B)));
        }
      }
      if (r.fig) v.forEach(id => {
        const o = ov(r.box[id], r.fig);
        if (o > 0) {
          if (!withFig[id]) withFig[id] = { frames: 0, maxRatio: 0, t0: r.t, t1: r.t };
          withFig[id].frames++; withFig[id].t1 = r.t;
          withFig[id].maxRatio = Math.max(withFig[id].maxRatio, o / area(r.box[id]));
        }
      });
    });
    /* ── ①c 聚合：分「静止态 / 运动态」（口径同 ① —— 净空区是"占位"约束，
       元素飞过去不算，停在里面才算）──
       ⚠️⚠️ 2026-09-30 修 · 本条判据的**假 FAIL**（C5-TINY-Game 硬切改造时暴露）：
          静止态的**邻居必须取自全帧序列**（`rows[i±1].boxAll`），
          不能用「越线样本序列」（`clrFrames[i±1]`）。
       踩过的坑：步长 0.1s 时，元素「进线又出线」可以**跨过整段只留 1 个越线样本**
          ⇒ 前后邻居都取不到 ⇒ `shifted(null)` 恒 false ⇒ **误判静止 ⇒ 假 FAIL**。
       实测 `pile-1` 下缘 985px：0.1s 步长报 FAIL、1/30 步长报 PASS ——
          **同一个画面两种结论**（说明错的是口径不是画面；那 4 帧卡堆逐帧位移
          4/21/34px，是**运动态**，本该豁免）。
       现改成与 ① 安全框段 `isRest()` **完全同口径**（都读 `rows[i±1]` 的 box）。
       另：`clrPeak` 一并改成取**全帧**峰值（原来只在越线样本里取 ⇒ 一个"淡出中穿过
          净空区"的元素会按它**穿线时的低 opacity** 当峰值 ⇒ 同样假 FAIL）。 */
    const clrPeak = {};
    rows.forEach(r => { for (const k in r.boxAll) clrPeak[k] = Math.max(clrPeak[k] || 0, r.boxAll[k][2]); });
    const clrHits = {}, clrMotion = {};
    clrFrames.forEach((cm, i) => {
      for (const k in cm) {
        const c = cm[k];
        const p = i > 0 ? rows[i - 1].boxAll[k] : null;
        const nx = i < rows.length - 1 ? rows[i + 1].boxAll[k] : null;
        const shifted = q => !!q && (Math.abs(q[0] - c.l) > 1.0 || Math.abs(q[1] - c.t) > 1.0);
        const rest = c.o >= (clrPeak[k] || 1) * 0.95 && !shifted(p) && !shifted(nx);
        const sink = rest ? clrHits : clrMotion;
        if (!sink[k]) sink[k] = { frames: 0, val: 0, t0: rows[i].t, t1: rows[i].t };
        const h = sink[k];
        h.frames++; h.t1 = rows[i].t; h.val = Math.max(h.val, c.b);
      }
    });
    const cnt = rows.map(r => r.vis.length);
    const peak = rows[cnt.indexOf(Math.max(...cnt))];
    return { pair, withFig, safeHits, motionHits, figEx, clrHits, clrMotion, clrTop: CLR_TOP, nInk: inkEls.length, cntMax: Math.max(...cnt), cntAt: peak ? peak.t : 0, peakVis: peak ? peak.vis : [] };
  }, TEXT_IDS, DUR, STEP, FIG, SAFE_BOTTOM, SUBTITLE, SAFE_LEFT, SAFE_RIGHT, SAFE_TOP, HUD_TOP, HUD_BOT, CLR_TOP, BG_ALL);

  const line = (s) => console.log(s);
  line('文件: ' + FILE);
  const N_SAMP = Math.round(DUR / STEP);
  line('时长: ' + DUR + 's  步长: ' + STEP + 's  **样本 ' + N_SAMP + ' 个**  场景图: ' + (FIG || '—') + '  字幕元素(豁免): ' + SUBTITLE.join(','));
  // ★ 2026-09-30（DG-271）：把**样本数**打到头部 —— 「步长」单看 1s 很像正常值，
  //   但样本数 23 vs 690 一眼就能看出问题。再配一条粗步长告警，防止再次静默欠采样。
  if (N_SAMP < 60) {
    line('⚠️ 警告：样本只有 ' + N_SAMP + ' 个（步长 ' + STEP + 's 偏粗）—— '
      + '**欠采样会把「运动态」漏判成「静止态」**（DG-269 就是这么漏掉 `#s3-glow` 的）。'
      + '要逐帧口径请传 `--step 1/30`。');
  }
  line('安全框: 左 ' + SAFE_LEFT + ' · 上 ' + SAFE_TOP + '（HUD 元素 ' + HUD_TOP + '）· 右 ' + SAFE_RIGHT + ' · 下 ' + SAFE_BOTTOM
    + '　|　字幕净空区 y > ' + res.clrTop);
  line('');
  line('=== ① 安全框越界（四边 · **只判静止态**）===');
  const sk = Object.keys(res.safeHits);
  if (!sk.length) line('PASS | 四边均无越界');
  sk.sort((a, b) => res.safeHits[b].frames - res.safeHits[a].frames).forEach(k => {
    const v = res.safeHits[k];
    line('FAIL | ' + k.padEnd(22) + ' 极值 ' + v.val.toFixed(0) + 'px  持续 ' + (v.frames * STEP).toFixed(1) + 's  ' + v.t0 + '~' + v.t1 + 's');
  });
  const mk = Object.keys(res.motionHits);
  if (mk.length) {
    line('── 以下为**运动态**（入场/退场飞行）越界，只报不断罪 —— 安全框是构图约束，不管元素怎么飞过去 ──');
    mk.sort((a, b) => res.motionHits[b].frames - res.motionHits[a].frames).forEach(k => {
      const v = res.motionHits[k];
      line('NOTE | ' + k.padEnd(22) + ' 极值 ' + v.val.toFixed(0) + 'px  ' + v.t0 + '~' + v.t1 + 's');
    });
  }
  line('');
  line('=== ①b 场景图安全框（全程极值 · 不套静止态过滤）===');
  const fe = res.figEx;
  if (!fe) line('（未指定 --fig 或场景图全程不可见）');
  else {
    const bad = [];
    if (fe.T < SAFE_TOP) bad.push('顶上越 ' + (SAFE_TOP - fe.T).toFixed(1) + 'px');
    if (fe.B > SAFE_BOTTOM) bad.push('底下越 ' + (fe.B - SAFE_BOTTOM).toFixed(1) + 'px');
    if (fe.L < SAFE_LEFT) bad.push('左越 ' + (SAFE_LEFT - fe.L).toFixed(1) + 'px');
    if (fe.R > SAFE_RIGHT) bad.push('右越 ' + (fe.R - SAFE_RIGHT).toFixed(1) + 'px');
    line((bad.length ? 'FAIL' : 'PASS') + ' | ' + FIG + '  可见 ' + fe.t0 + '~' + fe.t1 + 's（' + fe.n + ' 帧）');
    line('      极值 T' + fe.T.toFixed(0) + ' B' + fe.B.toFixed(0) + ' L' + fe.L.toFixed(0) + ' R' + fe.R.toFixed(0)
      + '  越界帧 ' + fe.nBad + '/' + fe.n);
    line(bad.length ? ('      ⚠️ ' + bad.join(' · ') + '（最深一帧 t=' + (fe.B > SAFE_BOTTOM ? fe.tB : fe.tT) + '）')
                    : '      四边均在安全框内');
  }
  line('');
  line('=== ①c 字幕净空区（y > ' + res.clrTop + ' 全宽净空 · 只判静止态 · 查**所有有绘制元素**）===');
  const ch = Object.keys(res.clrHits);
  if (!ch.length) line('PASS | 净空区内无静止元素（本轮查了 ' + res.nInk + ' 个有绘制元素）');
  ch.sort((a, b) => res.clrHits[b].val - res.clrHits[a].val).forEach(k => {
    const v = res.clrHits[k];
    line('FAIL | ' + k.padEnd(20) + ' 下缘 ' + v.val.toFixed(0) + 'px（越 ' + (v.val - res.clrTop).toFixed(0)
      + 'px）  ' + v.t0 + '~' + v.t1 + 's（' + v.frames + ' 样本）');
  });
  const cmk = Object.keys(res.clrMotion);
  if (cmk.length) {
    line('── 以下为**运动态**穿越净空区（入场/退场飞行），只报不断罪 ──');
    cmk.sort((a, b) => res.clrMotion[b].val - res.clrMotion[a].val).forEach(k => {
      const v = res.clrMotion[k];
      line('NOTE | ' + k.padEnd(20) + ' 下缘 ' + v.val.toFixed(0) + 'px  ' + v.t0 + '~' + v.t1 + 's');
    });
  }
  line('');
  line('=== ② 文字 × 文字 重叠 ===');
  const pk = Object.keys(res.pair).sort((a, b) => res.pair[b].maxRatio - res.pair[a].maxRatio);
  if (!pk.length) line('PASS | 无重叠');
  pk.forEach(k => {
    const v = res.pair[k];
    line((v.maxRatio > 0.25 ? 'FAIL' : 'NOTE') + ' | ' + k.padEnd(34) + ' 持续 ' + (v.frames * STEP).toFixed(1) + 's  ' + v.t0 + '~' + v.t1 + 's  最大重叠 ' + v.maxArea.toFixed(0) + 'px²（占较小者 ' + (v.maxRatio * 100).toFixed(1) + '%）');
  });
  line('');
  line('=== ③ 文字 × 场景图 重叠（' + FIG + '）===');
  const fk = Object.keys(res.withFig).sort((a, b) => res.withFig[b].maxRatio - res.withFig[a].maxRatio);
  if (!fk.length) line('（无）');
  fk.forEach(k => {
    const v = res.withFig[k];
    line((v.maxRatio > 0.5 ? 'WARN' : 'NOTE') + ' | ' + k.padEnd(13) + ' 持续 ' + (v.frames * STEP).toFixed(1) + 's  ' + v.t0 + '~' + v.t1 + 's  最大占自身 ' + (v.maxRatio * 100).toFixed(1) + '%');
  });
  line('');
  line('=== ④ 同刻屏上文字元素数 ===');
  line('最大 ' + res.cntMax + ' 个（t=' + res.cntAt + 's）: ' + res.peakVis.join(' '));
  await b.close();
  process.exit(0);
})();
