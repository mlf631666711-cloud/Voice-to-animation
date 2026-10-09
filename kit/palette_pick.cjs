#!/usr/bin/env node
'use strict';

/**
 * kit/palette_pick.cjs —— 全局配色抓取器（管路 ③.5 的执行件）
 * =====================================================================
 * 来源：老板 2026-09-17 指令
 *   「根据**视频脚本研判视频类型**之后去**配色卡**那里**抓取本次视频制作的
 *     全局配色设置**，注意**颜色通常都会带有视频倾向**，所以**不同的视频类型
 *     适配不同的背景配色**」
 *
 * 它解决什么
 * ---------------------------------------------------------------------
 *   「去色卡那里抓一条好看的」= 无差别选色 ⇒ 老板明令禁止。
 *   本件把「视频类型」变成**约束**，再在约束内抓：
 *
 *     视频类型 ──(TYPE_RULES)──▶ 基底(深/浅) + 饱和取向 + 候选名单
 *                                        │
 *                                        ▼
 *                     色卡库 85 条 ──(抓取 + 角色分配)──▶ 全局配色
 *                                        │
 *                                        ▼
 *                             WCAG 对比度闸门 ──▶ PASS / FAIL
 *
 * 三条硬口径（都是踩出来的，别改回去）
 * ---------------------------------------------------------------------
 *   ① **不许假定色卡数组的排列顺序。**
 *      静态色卡有人工写的，暗→亮和亮→暗**两种都有**实测：
 *        升序 #32 深灰·天蓝点缀（旧名 `L10 碳素科技`） `#0C0C0E … #FAFAFA`
 *        降序 #13 淡中性灰（旧名 `Ins 风`）             `#F8F9FA … #6C757D`
 *      一律先按**相对亮度**重排再分配角色。
 *
 *   ② **对比度用 WCAG 线性化公式，不是裸 sRGB 加权**（BUG-2160 同族）。
 *      与 `kit/contrast_check.js` 同口径：先做 sRGB→线性，再 0.2126R+0.7152G+0.0722B，
 *      比值 = (L_亮+0.05)/(L_暗+0.05)。
 *      ⚠️ 拿裸值算会**系统性高估**，是「判据自己就不对」的典型。
 *      阈值同 contrast_check：大字(≥24px) 3.0 / 正文 4.5。
 *
 *   ③ **来源分级不合并。**
 *      31 条人工整理（有设计语义 tag）与 54 条 XHS 机器取色（k-means 从笔记封面图取）
 *      **不是同一等可信度**。XHS 条目过质量闸才能当候选；闸门不过的**照报不照用**。
 *
 *   ④ **"能当强调色"是一个有前提的属性，不是饱和度高低。**
 *      「余项里饱和度最高」会选出 `#020617`（近乎纯黑，但 `S=(max-min)/max` 在 V→0 时虚高 = 0.91）。
 *      ⇒ 强调色**先过「与底色对比度 ≥ 3.0」的门**（强调的定义就是观众看得见它），再在池里比饱和。
 *
 *   ⑤ **色卡不一定含文字色，缺了要明示"补位"。**
 *      `淡中性灰`（旧名 `Ins 风`，纯灰阶）/`淡琥珀·中饱和·衬橙`（旧名 `奶油`，全浅）这类卡只提供"底 + 辅助色"，最深/最亮色对底色的对比度不足 4.5。
 *      ⇒ 补位本线既有中性对（深底 `#F8F5EE` / 浅底 `#16222E`，与二狗 UVC 线 `--t1/--bg0` 同源），
 *        **输出里必须写「★补位，非本卡自带」** —— 不许悄悄补。
 *        同理，本卡**不含可用强调色**时要明说，不许拿近底色充数。
 *
 * 用法
 * ---------------------------------------------------------------------
 *   node kit/palette_pick.cjs --type product            # 抓一条并出 CSS 变量块
 *   node kit/palette_pick.cjs --type tutorial --alt 2    # 取第 2 候选
 *   node kit/palette_pick.cjs --type ui --brand "#E4B388"  # 带品牌色做占位检查
 *   node kit/palette_pick.cjs --list                     # 列全部类型与候选数
 *   node kit/palette_pick.cjs --scan                     # 全库过闸，报告可用率
 *   node kit/palette_pick.cjs --type story --json        # 机器可读
 *   node kit/palette_pick.cjs --type showcase \
 *        --palette "#FFFFFF,#0A0E1A,#1A6BFF,#BBD3FF,#C9D4E4,#FF9C3D"
 *                                                        # ★ 外部给定色板直通（见下）
 *
 * ⑥ **外部给定色板优先于色卡抓取**（2026-09-17 立，rv1106 白底产品线触发）。
 *    老板/客户点名「跟 XX 一样」时，**底色是人定的，不是色卡算的**。此时抓色器
 *    不得覆写既定底色 —— 它降级为「把手写色板喂进同一套角色分配 + 闸门去验」。
 *    第一次踩到：`--type showcase` 给出 `bg=#D7E3B9`（淡黄绿），而老板要的是纯白
 *    （明动线 spec `--c-bg:#FFFFFF` 白纸黑字写在 `mingong-l10/fx_l10_neo.html`）。
 *    ⇒ 新增 `--palette`：色板直通，**type 决定"取向与闸门"，palette 决定"用哪些色"**。
 *    判据不受影响（走 `assign()` + `audit()` 同一条路径），所以是"多一个入口"而非"多一套逻辑"。
 */

const fs = require('fs');
const path = require('path');

/* 色卡库（`palettes` 数组的真源 HTML）。
 *
 * ★ 2026-10-08 补：**随仓分发的那份**（`kit/../palettes/配色灵感集.html`）。
 *   此前这里只有开发机绝对路径 ⇒ 别人 clone 后跑到管线第 ③.5 步取配色时
 *   `loadPalettes()` 直接 `exit(2)`（「色卡库不存在」），**第 ③.5 步整步跑不通**。
 *   补法与下面 `PAL_RAW_CANDIDATES` 完全同一手法：先按 `__dirname` 找仓内那份，
 *   再退回开发机绝对路径。
 *
 *   ⚠️ 仓内那份是**有意裁剪**过的 —— 删掉了「抓取配色镜像」区块（导航链接 / 区块本体 /
 *      渲染 JS 三块）与 `_img` 字段，因为那些是上游平台抓取原文；
 *      `palettes` 数组本体 **159 条一字未动**，所以本机与 clone 方解析结果完全一致。 */
const PAL_HTML_CANDIDATES = [
  process.env.PAL_HTML,
  path.join(__dirname, '..', 'palettes', '配色灵感集.html'),
].filter(Boolean);
const PAL_HTML = PAL_HTML_CANDIDATES.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } })
  || PAL_HTML_CANDIDATES[0];
/* XHS 条目的 k-means 原始权重（含「最大簇占比」）—— 判定"取到的是色卡图还是照片"的唯一硬信号。
   ⚠️ 它在注入 HTML 时被丢弃了，所以只能回查这个 sidecar；sidecar 一旦被清，闸门即失效。
   ★ 2026-10-02 迁出 `_tmp`（老板拍板「两个都做」）：
       真源 `大狗/_tmp/color/palettes.json` → `语音转动画总项目/palettes/data/palettes.json`
       理由：`_tmp` 会被清，而这文件是总管线第 ③.5 步的**硬依赖**（规格锁 §5.19 已登记此风险）。
       旧址保留为**最后一道 fallback** 并主动打 warn —— 见到那条 warn 就说明还有历史副本没清干净。 */
const PAL_RAW_CANDIDATES = [
  process.env.PAL_RAW,
  /* ★ 2026-10-08 补：**随仓分发的那份**（`kit/../palettes/data/palettes.json`）。
     补它的原因：原先候选只有开发机绝对路径 ⇒ 别人跑到管线第 ③.5 步取配色时三条全空
     （那些路径在别人机器上 `existsSync` = false，会被静默跳过）。
 */
  path.join(__dirname, '..', 'palettes', 'data', 'palettes.json'),
].filter(Boolean);
const PAL_RAW = PAL_RAW_CANDIDATES.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } })
  || PAL_RAW_CANDIDATES[0];
const PAL_RAW_IS_LEGACY = /大狗\/_tmp\/color/.test(PAL_RAW);

/* ─────────────────────────── 色彩基础件 ─────────────────────────── */

function hex2rgb(h) {
  h = String(h).trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/* WCAG 相对亮度（线性化）—— 与 kit/contrast_check.js 同口径 */
function relLum(rgb) {
  const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

/* 感知明度 0~255 —— 只用于「深浅分类」，不用于算对比度 */
function percLum(rgb) {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function sat(rgb) {
  const mx = Math.max(...rgb), mn = Math.min(...rgb);
  return mx ? (mx - mn) / mx : 0;
}

/**
 * 彩度（绝对量，0~255）= max - min
 *
 * ★★ 为什么不能只用 sat() 判"这颜色艳不艳"：
 *   `sat = (max-min)/max` 在 **V→0 时虚高** —— `#0D1117`（R13 G17 B23）算出 S=0.43，
 *   `#020617`（R2 G6 B23）算出 S=0.91，两条在视觉上都是**近黑**，却被判成"高饱和"。
 *   同一个根因在本文件里坑了三次（accent 选中纯黑 / bg 选中不够深的色 / 现在这处）。
 *   ⇒ 判"艳不艳"用 **chroma = max-min**（不吃 V 的影响）：
 *        `#0D1117` → 10（低）· `#020617` → 21（低）· `#480CA8` → 156（高）✓
 */
function chroma(rgb) { return Math.max(...rgb) - Math.min(...rgb); }
const CHROMA_LOUD = 96;   /* ≥ 这个值 = 当底色会"躁"（约等于 38% 色域宽度） */

function contrast(a, b) {
  const la = relLum(a), lb = relLum(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

const hex = rgb => '#' + rgb.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase();

/* ─────────────────────────── 色卡库读取 ─────────────────────────── */

function loadPalettes(file) {
  if (!fs.existsSync(file)) {
    console.error(`[palette_pick] ✗ 色卡库不存在：${file}`);
    console.error('  ★ 写「已抓到色卡」之前先 ls（BUG-2309：凭想象立产物）');
    process.exit(2);
  }
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(/(?:const\s+)?palettes\s*=\s*\[([\s\S]*?)\n\];/);
  if (!m) { console.error('[palette_pick] ✗ 在 HTML 里找不到 palettes 数组'); process.exit(2); }
  const objs = [...m[1].matchAll(/\{[^{}]*\}/g)].map(x => x[0]);
  const out = [];
  objs.forEach((o, i) => {
    let p;
    try { p = Function('return (' + o + ')')(); } catch (e) { p = { __bad: o.slice(0, 80) }; }
    p.__i = i;
    out.push(p);
  });
  return out;
}

/* ── 回查 k-means 原始权重 → 最大簇占比 ──
 *
 * ★★ 2026-09-17 二次修（同一把尺子我量错两次）：
 *    v1 用「平均饱和 < 0.08」判"取到黑白照片"。实测两条：
 *      #34「超舒服的配色灵感」 maxShare = 0.678 / 0.799 / 0.792  ← 真·照片类（大片天空/桌面色域）
 *      #66「大西北色卡」      maxShare = 0.242 / 0.350 / 0.344  ← 真·色卡图（灰阶是设计意图）
 *    两条都被 v1 拦了，**其中一条拦错 ⇒ 命中率 50% ＝ 无判别力**。
 *
 *    有判别力的信号是**最大簇占比**，因为它的机理清楚：
 *      色块拼排的色卡图 → 每块面积相当   → maxShare 低（实测 0.24~0.40）
 *      单张照片         → 有主体/天/地色域 → maxShare 高（实测 0.68~0.80）
 *    ⇒ 用 `maxShare > 0.55` 替换 `S < 0.08`。
 *
 * ⚠️ **回查不到时不许静默放行**：标 `未判定` 并计入统计（判据静默失效比判据错更坏）。
 */
let RAW_MAP = null, RAW_STATE = '未读';
function loadRaw() {
  if (RAW_MAP !== null) return RAW_MAP;
  RAW_MAP = new Map();
  if (!fs.existsSync(PAL_RAW)) { RAW_STATE = 'sidecar 不存在'; return RAW_MAP; }
  if (PAL_RAW_IS_LEGACY) {
    console.warn('[warn] 读到的是迁移前旧副本（`_tmp`）：' + PAL_RAW +
      '\n       真源已迁至 语音转动画总项目/palettes/data/palettes.json —— 请清掉这个旧副本。');
  }
  try {
    const arr = JSON.parse(fs.readFileSync(PAL_RAW, 'utf8'));
    for (const q of arr) {
      if (!q.colors) continue;
      const w = q.weights || [];
      const sum = w.reduce((a, b) => a + b, 0) || 1;
      RAW_MAP.set(q.colors.join(','), { maxShare: Math.max(...w) / sum, n: w.length, img: q.img });
    }
    RAW_STATE = `已读 ${RAW_MAP.size} 条` + (PAL_RAW_IS_LEGACY ? '（⚠️ 旧副本）' : '');
  } catch (e) { RAW_STATE = 'sidecar 解析失败：' + e.message; }
  return RAW_MAP;
}

/* ─────────────────────────── 质量闸（分两套，别混） ───────────────────────────
 *
 * ★★ 2026-09-17 修：v1 是把「机器取色的失真检测」当成了「色卡的通用质量标准」，
 *    结果把 3 条**人工整理**的卡误拦了，逐条看：
 *
 *      #6 樱花  「近同色」→ 那 6 个浅粉是**人工故意做的邻近色**，浅底卡就该邻近
 *      #13 Ins风「饱和 0.057」→ 那是**人工做的纯灰阶 UI 卡**，灰阶是设计意图不是缺陷
 *      #20 蒸汽波「近同色」→ 这条倒是真的：`#B967FF` **完全重复**出现两次，是库里的真缺陷
 *
 *    ⇒ 口径错在：**「近同色」对机器取色是失真信号，对人工卡是设计手法**。
 *      同一把尺子量两种东西 ⇒ 期望值与实测值不同口径（本线验收铁律第 3 条 / BUG-2307 族）。
 *
 *    修法：拆成三档，且**只对机器取色条查机器失真**：
 *      structFail  结构性缺陷 —— 两种来源都查，拦
 *      machineFail 机器取色失真 —— **只查带 `src` 的 XHS 条目**，拦
 *      metaWarn    元数据缺陷 —— 只告警不拦（脏标题是注入脚本的锅，不是色卡的锅）
 */
function gate(p) {
  const cols = p.colors || [];
  const isMachine = !!p.src;
  const warn = [];

  if (p.__bad) return { ok: false, kind: 'struct', why: '解析失败', warn };
  if (cols.length < 4) return { ok: false, kind: 'struct', why: `只有 ${cols.length} 色（<4，不足分配角色）`, warn };
  const rgbs = cols.map(hex2rgb);
  if (rgbs.some(r => !r)) return { ok: false, kind: 'struct', why: '含非法 HEX', warn };

  /* struct：完全重复色 —— 无论谁做的都是缺陷 */
  const seen = new Map();
  for (const r of rgbs) { const k = r.join(','); seen.set(k, (seen.get(k) || 0) + 1); }
  const exactDup = [...seen.entries()].filter(([, n]) => n > 1);
  if (exactDup.length) {
    return { ok: false, kind: 'struct', why: `有 ${exactDup.length} 个色完全重复：${exactDup.map(([k]) => hex(k.split(',').map(Number))).join(' ')}`, warn };
  }

  /* machine：只对 XHS 机器取色查 */
  let maxShare = null;
  if (isMachine) {
    const rec = loadRaw().get(cols.join(','));
    if (rec) maxShare = rec.maxShare;
    else warn.push('未能回查 k-means 权重（sidecar 缺该条）⇒ **取到色卡图还是照片判不了，用前必须人眼核原图**');

    if (maxShare !== null && maxShare > 0.55) {
      return { ok: false, kind: 'machine', why: `最大簇占比 ${maxShare.toFixed(3)} > 0.55 ＝ 取到的是照片（大片天/地/主体色域），不是色卡图`, warn, maxShare };
    }
    /* 贴阈值告警：实测阈值两侧的余量是 —— 色卡图侧最紧 0.500（余 0.050）/ 照片侧最紧 0.5501（余 0.0001）。
       `#47` 靠 0.0001 落进"照片"侧 ⇒ 单条判定余量 0.01% ＝ 贴线，必须明示。 */
    if (maxShare !== null && Math.abs(maxShare - 0.55) < 0.02) {
      warn.push(`maxShare=${maxShare.toFixed(3)} **贴阈值 0.55**（余量 ${(Math.abs(maxShare - 0.55) / 0.55 * 100).toFixed(2)}%）` +
        ` —— 判定几近掷硬币，**用前必须人眼核原图**`);
    }

    const S = rgbs.reduce((a, r) => a + sat(r), 0) / rgbs.length;
    if (S < 0.08) {
      warn.push(`平均饱和 ${S.toFixed(3)} < 0.08 —— ⚠ 此条**不再当缺陷拦**（实测无判别力：灰阶色卡常是设计意图）。` +
        `仅当 maxShare 也高时才可疑；本卡 maxShare=${maxShare === null ? '未判' : maxShare.toFixed(3)}`);
    }

    let near = 0;
    for (let i = 0; i < rgbs.length; i++) for (let j = i + 1; j < rgbs.length; j++) {
      if (Math.hypot(rgbs[i][0] - rgbs[j][0], rgbs[i][1] - rgbs[j][1], rgbs[i][2] - rgbs[j][2]) < 12) near++;
    }
    /* 近同色只在**同一条卡内部**有意义；机器取色若出现，多半是渐变图，不是缺陷 ⇒ 降为告警 */
    if (near > 0) warn.push(`有 ${near} 对近同色（ΔRGB<12）—— 若原图是渐变，这是取色正常现象，不算缺陷`);
  }

  /* meta：只告警 */
  if (/\//.test(p.t || '')) warn.push(`标题未洗净（含 /）：${p.t} —— 注入脚本 _inject.py 的 clean() 只剥了 | 没剥 /，是元数据缺陷不是色卡缺陷`);
  if (!p.tag) warn.push('无 tag');

  return { ok: true, kind: null, warn, maxShare };
}

/* ─────────────────────────── 视频类型 → 配色取向 ─────────────────────────── */

/**
 * base:  'dark' 深底 | 'light' 浅底
 * sat:   'mono' 近中性 | 'muted' 低饱和 | 'vivid' 高饱和
 * pick:  显式候选（按**配色**精确匹配，**不给模糊匹配**，找不到就报错）
 * deny:  该类型明确不要的特征
 *
 * ★★ 2026-10-08 修：pick 从「按色卡 `t` 名字匹配」改成「按 `colors` 配色匹配」。
 *   起因是一个我自己造的回归：老板要求把色卡名从「氛围 / 主题」（`暗黑模式` / `Ins 风` /
 *   `咖啡`…）换成**描述式色系名**（`深森绿·低饱和`）。我只改了 HTML 的 `t`，
 *   **漏了这里的 pick 白名单** —— 它是按 `t` 精确匹配的 ⇒ **九种类型的取色全部
 *   「无可用候选」**（实测 9/9 报废，且静默：`--list` 照样打印、只有真跑 `--type` 才报）。
 *
 *   为什么不改成「跟着改名字」而是换成按配色匹配 —— 三条，缺一条都不够：
 *     ① **`t` 现在是描述式显示名，描述式命名天然重名**（159 条里 30 组重名）
 *        ⇒ 拿它当 ID，重名的两条会**塌成一条**（实测 `ui`/`data`/`product` 各塌 1~2 条）。
 *     ② **名字会变**（这次就变了）⇒ 每次改名都要回来改 9 处 —— 那正是本 bug 的成因。
 *        `colors` 是色卡的**稳定身份**，改名动不到它。
 *     ③ 与本文件既有约定一致：下面的 `RAW_MAP` 本来就是拿 `colors.join(',')` 当键。
 *
 *   写法：`'<hex>,<hex>,...'` —— **一条就是一张完整的色卡**，顺序必须与 HTML 里一致。
 *   匹配时做归一化（去空格、转大写），所以大小写/空格不影响。
 *   向后兼容：若某条不是合法色值清单，退回按 `t` 名字匹配（给外部自备色卡库用）。
 *
 * ── 改名对照（2026-10-08）────────────────────────────────────────────────
 *   本文件其它注释里还按**旧名**引用色卡（那些是当时的实测记录，改掉就失去可追溯性）。
 *   下表让每个旧名都还能解析到当前色卡 —— 看到旧名时对这张表：
 *
 *     | 旧名（氛围 / 主题式）              | 现名（描述式）            |
 *     |---|---|
 *     | `L10 深空蓝`                      | `深青蓝·高饱和`           |
 *     | `L10 电光黑蓝`                    | `深青蓝·高饱和`           |
 *     | `暗黑模式` / `L10 碳素科技`        | `深灰·天蓝点缀`           |
 *     | `L10 黑金展台`                    | `深琥珀·高饱和`           |
 *     | `极致简约 \| 经典高级感配色`        | `深天蓝·高饱和`           |
 *     | `北欧霜`                          | `浅天蓝·低饱和`           |
 *     | `北欧极简`                        | `浅青蓝·中饱和`           |
 *     | `Ins 风`                          | `淡中性灰`（纯灰阶）       |
 *     | `奶油`                            | `淡琥珀·中饱和·衬橙`（全浅）|
 *     | `咖啡`                            | `深橙·中饱和`             |
 *     | `黄昏`                            | `中多彩·中饱和`           |
 *     | `复古胶片`                        | `中橙·中饱和`             |
 *     | `莓果`                            | `中玫红·中饱和`           |
 *     | `蜜桃`                            | `浅正红·高饱和·衬朱红`     |
 *     | `谁懂啊！这组配色高级到骨子里了✨`    | `浅多彩·低饱和`           |
 *     | `高级感莫兰迪色调Part.03丨`         | **（无）** —— 旧名本身是手抄截断的死条目，库里从来没有 |
 *     | `每日色卡Vol.23｜春夏必收的`        | **（无）** —— 同上 |
 *
 *   ⚠️ 两条**重名但不同色卡**的要留意：`L10 深空蓝` 与 `L10 电光黑蓝` 现在都叫
 *      `深青蓝·高饱和`，`暗黑模式` 与 `L10 碳素科技` 现在都叫 `深灰·天蓝点缀`
 *      —— 这正是本文件不能拿 `t` 当 ID 的原因（描述式命名允许重名）。
 *   ⚠️ 注释里几处 `#13` / `#32` 这类**索引**（0 基）不随改名变，仍有效：
 *      `#13` = `淡中性灰`（旧 `Ins 风`）· `#32` = `深灰·天蓝点缀`（旧 `L10 碳素科技`）。
 */
const TYPE_RULES = {
  product: {
    cn: '产品 / 硬实力宣传', base: 'dark', sat: 'muted',
    why: '深底让产品图（多为亮部主体）自然跳出来；低饱和不跟产品抢色。',
    pick: [
      '#020617,#0A1628,#0EA5E9,#38BDF8,#C9A227,#F0F9FF',  // 深青蓝·高饱和
      '#000814,#001D3D,#0077B6,#00B4D8,#FFD60A,#E0F7FA',  // 深青蓝·高饱和（与上条重名但不同色卡）
      '#0D1117,#161B22,#30363D,#8B949E,#58A6FF,#79C0FF',  // 深灰·天蓝点缀
      '#0C0C0E,#18181B,#3B82F6,#52525B,#EAB308,#FAFAFA',  // 深灰·天蓝点缀
    ],
    deny: ['纯灰阶卡（无点睛色，产品会显得没精神）'],
  },
  launch: {
    cn: '发布会 / 秀肌肉', base: 'dark', sat: 'mono',
    why: '黑金＝高价值感的行业共通语汇；金只做点睛，不能满屏。',
    pick: [
      '#07070B,#0F0F14,#1A3A5C,#D4AF37,#F0D878,#F2F0E8',  // 深琥珀·高饱和（黑金）
      '#081324,#062B51,#013E77,#A52424,#FFFBEF',           // 深天蓝·高饱和
      '#0C0C0E,#18181B,#3B82F6,#52525B,#EAB308,#FAFAFA',  // 深灰·天蓝点缀
    ],
    deny: ['高饱和多色（会稀释"贵"的观感）'],
  },
  tutorial: {
    cn: '教程 / Demo 实操', base: 'light', sat: 'mono',
    why: '★ 教程的第一优先级是**看得清操作**。浅底 + 近中性 = 界面截图/录屏不打架。',
    /* ⚠ 原第 4 条（莫兰迪那条）是**历史上手抄截断留下的死条目** —— 在改名前的老库里
       就已经不存在、一直静默跳过。本次按配色重写时一并删掉（**不补位**），
       这样有效候选数与改名前逐类相等。 */
    pick: [
      '#F0F4F8,#D9E2EC,#9FB3C8,#627D98,#486581,#334E68',  // 浅天蓝·低饱和
      '#F8F9FA,#E9ECEF,#DEE2E6,#CED4DA,#ADB5BD,#6C757D',  // 淡中性灰
      '#FFFDD0,#FDF6E3,#F5E6CA,#EADBC8,#D9C2A3,#BFA980',  // 淡琥珀·中饱和·衬橙
    ],
    deny: ['高饱和（抢走对操作区域的注意力）', '纯黑底（叠录屏时界面发灰）'],
  },
  showcase: {
    cn: '项目展示 Showcase', base: 'light', sat: 'muted',
    why: '硬件实拍为主角。浅底暖中性 = 产品页质感；深色会吃掉实物阴影层次。',
    pick: [
      '#F0F4F8,#D9E2EC,#9FB3C8,#627D98,#486581,#334E68',  // 浅天蓝·低饱和
      '#F8F9FA,#E9ECEF,#DEE2E6,#CED4DA,#ADB5BD,#6C757D',  // 淡中性灰
      '#855C57,#6C8397,#B0AC94,#9DBEE2,#F2BDB6,#D7E3B9',  // 浅多彩·低饱和
      '#FFFDD0,#FDF6E3,#F5E6CA,#EADBC8,#D9C2A3,#BFA980',  // 淡琥珀·中饱和·衬橙
    ],
    deny: ['暗调高级（实物拍发闷）'],
  },
  explain: {
    cn: '知识科普 / 口播讲解', base: 'dark', sat: 'muted',
    why: '信息密度高 ⇒ 底必须让文字省力。深底低饱和 + 一点冷色点睛是知识类最稳的解法。',
    /* ⚠ 同 tutorial：原第 3 条（每日色卡那条）是历史死条目，本次删掉不补位。 */
    pick: [
      '#020617,#0A1628,#0EA5E9,#38BDF8,#C9A227,#F0F9FF',  // 深青蓝·高饱和
      '#2E3440,#88C0D0,#81A1C1,#A3BE8C,#EBCB8B,#E5E9F0',  // 浅青蓝·中饱和（Nord）
      '#0C0C0E,#18181B,#3B82F6,#52525B,#EAB308,#FAFAFA',  // 深灰·天蓝点缀
    ],
    deny: ['撞色 / 酸性色（文字会读不动）'],
  },
  story: {
    cn: '情感 / 品牌故事', base: 'dark', sat: 'muted',
    why: '暖调压暗 = 记忆感；这是唯一允许"颜色比信息重要"的类型，但仍要过对比度闸。',
    pick: [
      '#3C2A21,#5B3A29,#7B4B2A,#A47148,#C8A27C,#E3C9A8',  // 深橙·中饱和（咖啡）
      '#2C3E50,#4C5C68,#E8A87C,#C38D9E,#85DCB0,#41B3A3',  // 中多彩·中饱和（黄昏）
      '#E8C39E,#C89F7B,#A3624F,#6B4226,#3B2F2F,#F2E2C4',  // 中橙·中饱和（复古胶片）
      '#4A0E2E,#7B1E3D,#A83255,#C75B7A,#E08AA0,#F2B5C4',  // 中玫红·中饱和（莓果）
      '#FFDAB9,#FFC0A0,#FF9E80,#FF7F6B,#E8654B,#C94C3B',  // 浅正红·高饱和·衬朱红（蜜桃）
    ],
    deny: ['冷灰（情感类会显得冷场）'],
  },
  ui: {
    cn: 'UI / 软件动效演示', base: 'dark', sat: 'muted',
    why: '★ UI 动效的对比度在深底上最高（行业惯例亦然）；浅底演示发光/玻璃/描边会糊。',
    pick: [
      '#0D1117,#161B22,#30363D,#8B949E,#58A6FF,#79C0FF',  // 深灰·天蓝点缀
      '#0C0C0E,#18181B,#3B82F6,#52525B,#EAB308,#FAFAFA',  // 深灰·天蓝点缀
      '#020617,#0A1628,#0EA5E9,#38BDF8,#C9A227,#F0F9FF',  // 深青蓝·高饱和
    ],
    deny: ['浅底（光效/玻璃基底会失去层次）'],
  },
  data: {
    cn: '数据 / 章节卡', base: 'dark', sat: 'muted',
    why: '数据要靠**分色**区分类别 ⇒ 底必须退到最低存在感，把饱和度全留给数据条。',
    pick: [
      '#0D1117,#161B22,#30363D,#8B949E,#58A6FF,#79C0FF',  // 深灰·天蓝点缀
      '#020617,#0A1628,#0EA5E9,#38BDF8,#C9A227,#F0F9FF',  // 深青蓝·高饱和
      '#0C0C0E,#18181B,#3B82F6,#52525B,#EAB308,#FAFAFA',  // 深灰·天蓝点缀
    ],
    deny: ['把点睛色当底色（数据条会没有对比可用）'],
  },
  ink: {
    cn: '墨水屏 / 纸感硬件', base: 'light', sat: 'mono',
    why: '纸感的对手是"屏幕感"。近中性浅底 + 墨色文字才能跟墨水屏实物对上。',
    /* ⚠ 本类**默认就不需要强调色** —— 纸感/墨水屏的美学就是单色。工具报「无强调色」是预期内的，
       不是缺陷；真要一个点睛色时用 --alt 1（`淡中性灰`，旧名 `Ins 风`，有 1 个）。这是**唯一**允许"无强调色收工"的类型。 */
    /* ⚠ 同 tutorial：原第 3 条（莫兰迪那条）是历史死条目，本次删掉不补位。 */
    pick: [
      '#FFFDD0,#FDF6E3,#F5E6CA,#EADBC8,#D9C2A3,#BFA980',  // 淡琥珀·中饱和·衬橙
      '#F8F9FA,#E9ECEF,#DEE2E6,#CED4DA,#ADB5BD,#6C757D',  // 淡中性灰
    ],
    deny: ['高饱和 / 电子光（与墨水屏物理表现矛盾）'],
  },
};

/* ─────────────────────────── 抓取 + 角色分配 ───────────────────────────
 *
 * ★★ 2026-09-17 三次修（跑起来才发现的选法错，**不是阈值问题**）：
 *
 *  错 1 · accent 用「余项里饱和度最高」⇒ `product` 选中 `#020617`（近乎纯黑）当强调色。
 *         根因：`S = (max-min)/max` 在 **V→0 时虚高** —— B=23,R=2 ⇒ S=0.91。
 *         它数学上是"高饱和"，视觉上是"黑"。⇒ **饱和度不能单独当'能当强调色'的证据。**
 *         修法：先过「与 bg 对比度 ≥ 3.0」的门（**"强调"的定义就是观众看得见它**），再在池里比饱和。
 *
 *  错 2 · 有些色卡**物理上不含**可当文字/强调的色 —— 如 `淡中性灰`（旧名 `Ins 风`；纯灰阶，最暗 `#6C757D`
 *         对付 `#F8F9FA` 只有 4.45:1，差 1% 不过）· `淡琥珀·中饱和·衬橙`（旧名 `奶油`；全浅，最深 `#BFA980` 对白底 1.74:1）。
 *         这类卡**不是"不合格"，是"只提供底，不提供字"**。
 *         修法：允许**外部补位**文字色，但**必须明示"补位，非本卡自带"**，
 *              且补位色取本线既有的中性对（深底 `#F8F5EE` / 浅底 `#16222E`，
 *              与二狗 UVC 线 `--t1/--bg0` 同源）—— 不许悄悄补。
 */
const FALLBACK_FG = { dark: '#F8F5EE', light: '#16222E' };  /* 本线既有中性对（UVC 线 --t1 / --bg0） */

function assign(p, base) {
  const rgbs = p.colors.map(hex2rgb).map((r, i) => ({ rgb: r, h: p.colors[i], L: percLum(r), S: sat(r) }));
  /* ① 先重排，不信任原顺序 */
  rgbs.sort((a, b) => a.L - b.L);

  const bgCand = base === 'dark' ? rgbs : [...rgbs].reverse();
  /* ★ bg = **极端端**（深底取最暗那条 / 浅底取最亮那条）—— 机理直白，不绕。
     曾经的写法是"在亮度前 3 里挑 S 最低的"，结果是 `深灰·天蓝点缀`（旧名 `暗黑模式`）把 bg 选成了 `#30363D`（L=53，
     根本不是深底），底↔字掉到 5.x ⇒ `ui`/`data` 两类直接 FAIL。
     根因还是 `sat()` 在低明度虚高（`#0D1117` S=0.43 > `#30363D` S=0.21 ⇒ 挑错）。
     "太艳当底色会躁"这件事改成**告警**（用 chroma 判），不再改选 —— 报出来比悄悄换掉诚实。 */
  const bg = bgCand[0];

  let rest = rgbs.filter(x => x !== bg);

  /* 文字：与 bg 对比度最高的那条。要过 4.5（正文门槛）；
     本卡没有 ⇒ 补位（明示），不是判 FAIL。 */
  const fgRanked = [...rest].sort((a, b) => contrast(b.rgb, bg.rgb) - contrast(a.rgb, bg.rgb));
  let fg = fgRanked[0];
  let fgFallback = false;
  if (!fg || contrast(fg.rgb, bg.rgb) < 4.5) {
    fgFallback = true;
    fg = { rgb: hex2rgb(FALLBACK_FG[base]), h: FALLBACK_FG[base], L: percLum(hex2rgb(FALLBACK_FG[base])), S: sat(hex2rgb(FALLBACK_FG[base])), __fb: true };
  }
  if (!fg.__fb) rest = rest.filter(x => x !== fg);

  /* 强调：★ 必须先过「看得见」的门（对比度 ≥ 3.0），再比饱和 —— 顺序反了就出 "纯黑当强调色" */
  const accentPool = rest.filter(x => contrast(x.rgb, bg.rgb) >= 3.0).sort((a, b) => b.S - a.S);
  const accent = accentPool[0] || null;
  const accent2 = accentPool[1] || null;
  const usedA = new Set([accent, accent2].filter(Boolean));

  /* 次级底（--bg1）与描边（--ln）是**两个不同的角色，各有可用区间** ——
     ★ 曾经的写法是"surface 取最接近 1.35 / line 取最接近 2.5"，区间重叠且都不设上下界，
       结果是 surface 把中间调挑走后，line 只能硬塞一个 `#161B22`（对比度 1.09）——
       那不是描边，那是"更深的底"。⇒ `深灰·天蓝点缀`（旧名 `暗黑模式`）/`深琥珀·高饱和`（旧名 `L10 黑金展台`）两类因此恒 FAIL。
     修法：**surface ⊂ [1.10, 1.60)，line ⊂ [1.60, 4.00]**（两区间不重叠），
          任一区间取不到就**报"本卡无该角色"**，不硬塞 —— 6 色的卡本来就不够分 6 个角色，
          说清楚比凑一个假角色强。 */
  const rest2 = rest.filter(x => !usedA.has(x));
  const surface = rest2.filter(x => { const c = contrast(x.rgb, bg.rgb); return c >= 1.10 && c < 1.60; })
    .sort((a, b) => Math.abs(contrast(a.rgb, bg.rgb) - 1.35) - Math.abs(contrast(b.rgb, bg.rgb) - 1.35))[0] || null;
  const line = rest2.filter(x => x !== surface)
    .filter(x => { const c = contrast(x.rgb, bg.rgb); return c >= 1.60 && c <= 4.00; })
    .sort((a, b) => Math.abs(contrast(a.rgb, bg.rgb) - 2.5) - Math.abs(contrast(b.rgb, bg.rgb) - 2.5))[0] || null;

  return { bg, fg, accent, accent2, surface, line, sorted: rgbs, fgFallback, accentPoolSize: accentPool.length };
}

/** 带 alpha 的前景色先与底合成，再算对比度
 *  ★ BUG-2167 同族：漏这步会**高估**。字幕基底 rgba(201,195,184,.38) 实测只有 2.55，
 *    按不透明 RGB 算会读成 10+。本线规格锁 §5.12 已定「副标不透明度 0.84~0.90 / 小标签 ≥0.76」。 */
function overFg(fgRgb, a, bgRgb) {
  return [0, 1, 2].map(i => fgRgb[i] * a + bgRgb[i] * (1 - a));
}
const SUB_ALPHA = 0.82;   /* 副标不透明度代表值（§5.12 区间 0.84~0.90 的下沿再留一点余） */
const SUB_ALPHA_MAX = 0.90;  /* §5.12 区间上沿 —— 超过它就不能用"提高不透明度"这招了 */

/** 反解：要让对比度 ≥ floor，前景色**最低**要不透明到多少
 *  ★ 本线口径是「**给区间不给单值**」（同族：SFX 峰 = voice_peak − 8~13dB）。
 *    `tutorial/浅天蓝·低饱和`（旧名 `北欧霜`）在卡片面上 @0.82 只有 4.38（差 3%）—— 报一个"FAIL"没用，
 *    真正能用的是"**副标不透明度须 ≥ 0.87**"。 */
function alphaMin(bgRgb, fgRgb, floor) {
  if (contrast(fgRgb, bgRgb) < floor) return null;   /* 全不透明都不过 */
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (contrast(overFg(fgRgb, mid, bgRgb), bgRgb) >= floor) hi = mid; else lo = mid;
  }
  return hi;
}

function audit(a, base) {
  const rows = [];
  rows.push({
    status: contrast(a.fg.rgb, a.bg.rgb) >= 4.5 ? 'PASS' : 'FAIL',
    role: a.fgFallback ? 'bg0↔fg（★补位，非本卡自带）' : 'bg0↔fg（底上正文/标题）',
    cr: contrast(a.fg.rgb, a.bg.rgb), floor: 4.5, hex: a.fg.h,
  });
  /* ★ 卡片面（bg1）上的文字 —— 大卡片布局最常见的形态，**必须单独量**
     （踩过：把文字放在 bg1 面上，却拿 bg0 量对比度 ⇒ sheet 里正文压得看不清而闸门全绿） */
  if (a.surface) {
    const c = contrast(a.fg.rgb, a.surface.rgb);
    rows.push({
      status: c >= 4.5 ? 'PASS' : 'FAIL',
      role: 'bg1↔fg（卡片面上文字）', cr: c, floor: 4.5, hex: `${a.surface.h} 底 / ${a.fg.h} 字`,
    });
  }
  /* ★ 副标降不透明度的**有效**对比度 —— 带 alpha 必须先合成（BUG-2167）
     不过时**不直接判 FAIL**，而是反解「最低不透明度」：落在 §5.12 区间内 ⇒ WARN 可放行 */
  {
    const bgForSub = a.surface || a.bg;
    const cr82 = contrast(overFg(a.fg.rgb, SUB_ALPHA, bgForSub.rgb), bgForSub.rgb);
    if (cr82 >= 4.5) {
      rows.push({ status: 'PASS', role: `bg1↔fg @α=${SUB_ALPHA}（副标有效值）`, cr: cr82, floor: 4.5, hex: hex(overFg(a.fg.rgb, SUB_ALPHA, bgForSub.rgb)) });
    } else {
      const amin = alphaMin(bgForSub.rgb, a.fg.rgb, 4.5);
      if (amin !== null && amin <= SUB_ALPHA_MAX) {
        rows.push({
          status: 'WARN', role: `bg1↔fg @α=${SUB_ALPHA}（副标有效值）`, cr: cr82, floor: 4.5,
          hex: hex(overFg(a.fg.rgb, SUB_ALPHA, bgForSub.rgb)),
          note: `⇒ **副标不透明度须 ≥ ${amin.toFixed(2)}**（§5.12 区间 0.84~0.90 内可满足，不必换卡）`,
        });
      } else {
        rows.push({
          status: 'FAIL', role: `bg1↔fg @α=${SUB_ALPHA}（副标有效值）`, cr: cr82, floor: 4.5,
          hex: hex(overFg(a.fg.rgb, SUB_ALPHA, bgForSub.rgb)),
          note: amin === null
            ? `⇒ **即使不透明也过不了**（${contrast(a.fg.rgb, bgForSub.rgb).toFixed(2)}）⇒ 本卡放不了卡片面副标，换候选`
            : `⇒ 需不透明度 ${amin.toFixed(2)} 已超 §5.12 上沿 ${SUB_ALPHA_MAX} ⇒ 本卡放不了卡片面副标，换候选`,
        });
      }
    }
  }
  if (a.accent) {
    const c = contrast(a.accent.rgb, a.bg.rgb);
    rows.push({ status: c >= 3.0 ? 'PASS' : 'FAIL', role: 'bg0↔accent（强调块）', cr: c, floor: 3.0, hex: a.accent.h });
  }
  if (a.accent2) {
    const c = contrast(a.accent2.rgb, a.bg.rgb);
    rows.push({ status: c >= 3.0 ? 'PASS' : 'FAIL', role: 'bg0↔accent2（次强调）', cr: c, floor: 3.0, hex: a.accent2.h });
  }
  if (a.line) {
    const c = contrast(a.line.rgb, a.bg.rgb);
    rows.push({ status: c >= 1.6 ? 'PASS' : 'FAIL', role: 'bg0↔line（描边/分隔）', cr: c, floor: 1.6, hex: a.line.h });
  }
  return rows;
}

/** 描边太高调也会坏：做发丝线会跳。这是"太高"不是"太低"，与 floor 方向相反 */
function lineTooLoud(a) {
  if (!a.line) return null;
  const c = contrast(a.line.rgb, a.bg.rgb);
  return c > 4.0 ? `⚠ line 对比度 ${c.toFixed(2)} 偏高（>4.0）—— 底色卡余色只剩亮色时会被迫拿它当描边，` +
    `**做发丝线会跳**，建议用 --bg1 叠透明度生成描边，别直接用 ${a.line.h}` : null;
}

/** 底色太艳 = 片子会"躁"。用 chroma 判（不是 sat，见 chroma() 注释） */
function bgTooLoud(a) {
  const c = chroma(a.bg.rgb);
  return c >= CHROMA_LOUD ? `⚠ 底色彩度 ${c}（≥${CHROMA_LOUD}）＝ 底色本身很艳 ⇒ **整片会躁**，` +
    `且强调色会失去对比空间。建议 --alt 换更中性的卡，或本片有意走高饱和路线时在分镜表写明理由` : null;
}

/* ── 描述性规律（来自 28 条真实片子采样，2026-09-17 · 一律 WARN，不当 FAIL）────────
 *
 * 调研出处：`UI动效库/调研-视频类型与配色倾向.md` + `catalog/ADOPT-视频配色采样.md`
 * ★ 采用原则是**它自己 §5.7 那句话**：「WCAG 是本步骤唯一能写死的硬门禁（T2）」——
 *   ⇒ **描述性统计规律只做提示，不得当门禁**（观察到的分布 ≠ 最优选择）。
 */
const LIGHT_SAT_MAX = 0.25;   /* 观测上界 0.19（n=8，8/8 全 ≤0.19）+ 32% 余量 */

function statHints(a, base) {
  const out = [];
  /* 浅底 ⇒ 低饱和：28 条里 L>192 的 8 例 S **全部** ≤0.19（深底组 S 中位 0.529 vs 浅底 0.082，差 6.5 倍）
     ⇒ 这条是**单向 100%** 的，最稳。 */
  if (base === 'light') {
    const s = sat(a.bg.rgb);
    if (s > LIGHT_SAT_MAX) out.push(`⚠ 浅底色饱和度 ${s.toFixed(2)} > ${LIGHT_SAT_MAX}` +
      ` —— 采样 28 条里浅底（L>192）**8/8 全部 ≤0.19**（深底 S 中位 0.529 vs 浅底 0.082）。` +
      `**浅底上高饱和会脏**，建议压到 ≈0.05~0.15，色相只做小偏移（来源：ADOPT-视频配色采样）`);
  }
  /* 反面提醒：深底带不带色相**不是**规则 —— 15 例深底里 3 例 S=0.00（中性纯黑），12 例带色相。
     ⇒ 两种都合规，别因为"深底必须带色相"这种说法去改选。
     ⚠️ 判"是不是中性黑"**必须用 chroma，不能用 sat** —— `#0B0B0D` 视觉纯黑，但 sat 算出 0.154
        （同一个 V→0 虚高根因，本文件第 4 次踩）。chroma 才稳：`#07070B`→4 · `#0D1117`→10 · `#020617`→21。 */
  if (base === 'dark' && chroma(a.bg.rgb) < 24) {
    out.push(`· 深底为中性黑（chroma=${chroma(a.bg.rgb)}）—— **这是合规的**（采样 15 例深底里 3 例如此）。` +
      `深底"中性黑 / 带色相"两种都常见，不受本条约束；需要色彩性格时靠 --a1/--a2 承载`);
  }
  return out;
}

/** 本卡提供的强调色够不够用（不足要明说，别让片子只有底和字） */
function accentVerdict(a) {
  if (a.accentPoolSize === 0) return '★ 本卡**不含可用强调色**（余色全部与底色对比度 < 3.0）⇒ 强调色必须另补，不许硬拿近底色充数';
  if (a.accentPoolSize === 1) return '⚠ 本卡只有 1 个可用强调色（accent2 缺）⇒ 需要第二强调色时另补';
  return null;
}

/* ─────────────────────────── 自检（反例必须参与打分） ───────────────────────────
 *
 * 本线验收铁律：**「这条 PASS 若 bug 存在会变 FAIL 吗？」不会 = 没验。**
 * 所以这里不测"好看的能过"，而是测**"错的会不会红"** —— 每条都配一个反例。
 * 另附一条**口径回归**：色卡数组顺序反转后，分配结果必须完全相同（③ 不信任原顺序）。
 */
function selftest() {
  const P = (t, colors, extra) => Object.assign({ t, tag: 'x', colors, __i: 0 }, extra || {});
  const results = [];
  const T = (name, cond, detail) => results.push({ name, ok: !!cond, detail });

  /* 1 · 反例：整卡色都挤在一起（明度跨度极小）⇒ 本卡**不足以提供文字色**，必须补位
     ⚠️ 本用例 v1 写错：断言的是"必须红"，但**补位机制会把它救活**（实测 14.15 PASS）。
        正确要测的是"**该卡自带色不够，补位必须被触发**" —— 补位是对的行为，
        错的是"没触发补位却硬用本卡色"。⇒ 断言 `fgFallback === true` + 强调池为空。 */
  {
    const p = P('自检-明度跨度极小', ['#F0F0F0', '#E8E8E8', '#E0E0E0', '#D8D8D8', '#D0D0D0', '#C8C8C8'], { src: 'XHS' });
    const a = assign(p, 'light');
    T('反例① 明度跨度极小的卡必须触发补位且无强调色',
      a.fgFallback === true && a.accentPoolSize === 0,
      `fgFallback=${a.fgFallback} accentPool=${a.accentPoolSize} fg=${a.fg.h}(${contrast(a.fg.rgb, a.bg.rgb).toFixed(2)}) 本卡最暗色对底 ${contrast(hex2rgb('#C8C8C8'), a.bg.rgb).toFixed(2)}`);
  }

  /* 2 · 反例：正例不该被误杀 —— 高对比卡必须全绿（防"恒红"） */
  {
    const p = P('自检-高对比', ['#0B1020', '#141C33', '#2A3A66', '#5B7FD4', '#9CC0FF', '#F7FAFF']);
    const a = assign(p, 'dark');
    const rows = audit(a, 'dark');
    T('反例② 高对比卡必须绿（防恒红）', rows.every(r => r.cr >= r.floor),
      rows.map(r => `${r.role}=${r.cr.toFixed(2)}/${r.floor}`).join(' '));
  }

  /* 3 · 反例：完全重复色必须被 struct 拦 */
  {
    const p = P('自检-重复色', ['#111111', '#222222', '#333333', '#333333', '#444444', '#555555']);
    T('反例③ 重复色必须被 struct 拦', gate(p).ok === false && gate(p).kind === 'struct', gate(p).why);
  }

  /* 4 · 反例：色数不足必须被 struct 拦 */
  {
    const p = P('自检-色太少', ['#111111', '#222222', '#333333']);
    T('反例④ 色数<4 必须被 struct 拦', gate(p).ok === false && gate(p).kind === 'struct', gate(p).why);
  }

  /* 5 · 反例：人工整理的灰阶卡**不该**被机器失真规则误杀（错 1 的回归） */
  {
    const p = P('自检-人工灰阶', ['#F8F9FA', '#E9ECEF', '#DEE2E6', '#CED4DA', '#ADB5BD', '#6C757D']);
    T('反例⑤ 人工灰阶卡不该被机器规则拦（错 1 回归）', gate(p).ok === true, gate(p).why || 'ok');
  }

  /* 6 · 反例：机器取色的近同色**也不该**再被拦（已降级为告警）
     ⚠️ 本用例 v1 写错：直接拿了真实 `#34` 的色，而它在 sidecar 里 maxShare=0.678
        ⇒ 被**另一条规则**（照片判定）正确拦下，用例却以为该放行。
        ⇒ 换**合成**卡（sidecar 里查不到，不会触发 maxShare），只考"近同色这一条"是否降级。 */
  {
    const p = P('自检-机器近同色', ['#101010', '#141414', '#6A6A6A', '#8A9AA8', '#C0CCD8', '#EFF4F8'], { src: 'XHS · x' });
    const g = gate(p);
    T('反例⑥ 机器近同色降级为告警（错 2 回归）', g.ok === true,
      `ok=${g.ok} kind=${g.kind || '-'} why=${g.why || '-'} warn=${(g.warn || []).join(' | ') || '无'}`);
  }

  /* 7 · 反例：强调色绝不能是"与底色几乎同亮度"的色（错 3 回归） */
  {
    const p = P('自检-黑被当强调', ['#020617', '#0A1628', '#0EA5E9', '#38BDF8', '#C9A227', '#F0F9FF']);
    const a = assign(p, 'dark');
    T('反例⑦ 纯黑不许被选成强调色（错 3 回归）',
      a.accent && contrast(a.accent.rgb, a.bg.rgb) >= 3.0,
      `accent=${a.accent && a.accent.h} cr=${a.accent ? contrast(a.accent.rgb, a.bg.rgb).toFixed(2) : '-'}`);
  }

  /* 8 · 口径回归：数组顺序反转，分配结果必须逐字段相同（③ 不信任原顺序） */
  {
    const cols = ['#F8F9FA', '#E9ECEF', '#DEE2E6', '#CED4DA', '#ADB5BD', '#6C757D'];
    const a1 = assign(P('a', cols), 'light');
    const a2 = assign(P('b', [...cols].reverse()), 'light');
    const same = ['bg', 'fg', 'surface', 'line', 'accent', 'accent2']
      .every(k => (a1[k] ? a1[k].h : null) === (a2[k] ? a2[k].h : null));
    T('反例⑧ 反转数组顺序结果必须相同（③ 回归）', same,
      `${a1.bg.h}/${a1.fg.h}/${a1.surface && a1.surface.h}/${a1.line && a1.line.h} vs ${a2.bg.h}/${a2.fg.h}`);
  }

  /* 9 · 反例：底色很艳必须被 bgTooLoud 抓到 */
  {
    const p = P('自检-艳底', ['#480CA8', '#560BAD', '#7209B7', '#B5179E', '#F72585', '#4361EE']);
    const a = assign(p, 'dark');
    T('反例⑨ 艳底必须告警（chroma 判据）', !!bgTooLoud(a), `bg=${a.bg.h} chroma=${chroma(a.bg.rgb)}`);
  }

  /* 10 · 描述性规律：浅底高饱和必须提示（采样 8/8 浅底 S≤0.19） */
  {
    const p = P('自检-浅底高饱和', ['#FFEB80', '#FFD633', '#FFB800', '#D98C00', '#9A6200', '#4A2E00']);
    const a = assign(p, 'light');
    const h = statHints(a, 'light');
    T('反例⑩ 浅底高饱和必须提示', h.some(s => /浅底色饱和度/.test(s)), `bg=${a.bg.h} S=${sat(a.bg.rgb).toFixed(2)} → ${h.length} 条提示`);
  }
  /* 11 · 不能误报：中性黑深底是**合规**的，不许被当成问题 */
  {
    const p = P('自检-中性黑深底', ['#0B0B0D', '#1A1A1F', '#2E2E36', '#5A5A66', '#9A9AA6', '#F2F2F5']);
    const a = assign(p, 'dark');
    const h = statHints(a, 'dark');
    T('反例⑪ 中性黑深底不该被当问题（只给"合规"说明）',
      h.length === 1 && /合规/.test(h[0]), h.join(' | ') || '（无提示）');
  }

  /* 12 · 报告里的硬口径：**只有 WCAG 是 FAIL，描述性规律只能是 WARN** */
  {
    const p = P('自检-浅底高饱和2', ['#FFEB80', '#FFD633', '#FFB800', '#D98C00', '#9A6200', '#4A2E00']);
    const a = assign(p, 'light');
    const rows = audit(a, 'light');
    T('反例⑫ 描述性规律不得进 audit 门禁（只有 WCAG 能判 FAIL）',
      rows.every(r => ['PASS', 'WARN', 'FAIL'].includes(r.status)) && statHints(a, 'light').length > 0,
      `audit 行数=${rows.length} 状态=${rows.map(r => r.status).join(',')} 提示数=${statHints(a, 'light').length}`);
  }

  /* 13 · ★★ 回归守卫：**九类的 pick 必须全部能在当前色卡库解析出来**
   *
   *   为什么补这条（2026-10-08，真实翻车）：
   *     老板要求把色卡名从「氛围/主题」改成**描述式色系名**，只改了 HTML 的 `t`，
   *     而 `pick` 当时是按 `t` **精确匹配**的 ⇒ **九类取色全部「无可用候选」**。
   *     而**当时这套自检 12/12 全过** —— 因为它只喂手写色卡、从不碰 `TYPE_RULES`。
   *     ⇒ 判据覆盖不到的地方，坏了也是绿的。这条补的就是那个洞。
   *   ⚠️ 判据要**能 FAIL**：故意把一条 pick 写错，本条必须变红（已负控验过）。 */
  {
    const badTypes = [];
    for (const [k, rule] of Object.entries(TYPE_RULES)) {
      const cs = candidates(rule);
      const good = cs.filter(c => !c.__missing);
      const miss = cs.filter(c => c.__missing);
      if (!good.length || miss.length) {
        badTypes.push(`${k}: 可用 ${good.length} / 缺失 ${miss.length}` +
          (miss.length ? `（${miss.map(m => m.__missing).join(' ')}）` : ''));
      }
    }
    T('守卫⑬ 九类 pick 必须全部可解析（改名/换库后不许静默归零）',
      badTypes.length === 0,
      badTypes.length ? badTypes.join(' | ')
        : Object.entries(TYPE_RULES).map(([k, r]) => `${k}:${r.pick.length}`).join(' '));
  }

  const bad = results.filter(r => !r.ok);
  console.log('palette_pick 自检（反例参与打分）');
  results.forEach(r => console.log(`  ${r.ok ? 'PASS' : '★FAIL'}  ${r.name}\n          ${r.detail}`));
  console.log(`\n${bad.length ? `★ ${bad.length}/${results.length} 条没过 —— 判据本身有问题，先修判据` : `✓ ${results.length}/${results.length} 全过`}`);
  process.exit(bad.length ? 1 : 0);
}

/* ─────────────────────────── 主流程 ─────────────────────────── */

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : (i >= 0 ? true : def);
}

const PALS = loadPalettes(PAL_HTML);
const GATED = PALS.map(p => ({ p, g: gate(p) }));
const USABLE = GATED.filter(x => x.g.ok).map(x => x.p);

/* 色卡身份归一化：去空白、转大写。HTML 里写 `#0D1117`、配置里写 `#0d1117` 都认。 */
function palKey(colors) {
  return String(colors).split(',').map(s => s.trim().toUpperCase()).join(',');
}
/* 一条 pick 是不是「色值清单」（而不是旧的 `t` 名字）——用于向后兼容分支 */
const RE_HEXLIST = /^\s*#[0-9A-Fa-f]{3,8}(\s*,\s*#[0-9A-Fa-f]{3,8})+\s*$/;

function candidates(rule) {
  const out = [];
  for (const entry of rule.pick) {
    /* ★ 默认按**配色**匹配（见 TYPE_RULES 头部说明）；非色值清单则退回按 `t` 名字匹配。 */
    const byColors = RE_HEXLIST.test(entry);
    const want = byColors ? palKey(entry) : String(entry).trim();
    const keyOf = p => byColors ? palKey((p.colors || []).join(',')) : (p.t || '').trim();
    const hit = USABLE.find(p => keyOf(p) === want);
    if (hit) out.push(hit);
    else {
      /* 显式候选找不到 ⇒ 报出来，不静默跳过（BUG-2309 同族） */
      const exists = PALS.find(p => keyOf(p) === want);
      out.push({
        __missing: byColors ? `${want.slice(0, 34)}…` : want,
        __reason: exists ? '被质量闸拦下' : (byColors ? '库中不存在这张色卡' : '库中不存在'),
      });
    }
  }
  return out;
}

function main() {
  if (process.argv.includes('--selftest')) { selftest(); return; }

  /* ── --sheet：把 9 类配色渲成实物卡（★ 闸门全绿 != 好看，必须人眼审判） ── */
  if (process.argv.includes('--sheet')) {
    const out = arg('sheet', 'palette_sheet.html');
    const blocks = [];
    for (const k of Object.keys(TYPE_RULES)) {
      const rule = TYPE_RULES[k];
      const cs = candidates(rule).filter(c => !c.__missing);
      if (!cs.length) continue;
      const c = cs[0];
      const a = assign(c, rule.base);
      const rows = audit(a, rule.base);
      const okAll = rows.every(r => r.status !== 'FAIL');
      const nWarn = rows.filter(r => r.status === 'WARN').length;
      const onCard = a.fg.h;
      /* 卡上文字用本卡 fg；强调块上的文字自动取"在强调色上对比度更高的那个" */
      const onAccent = contrast(a.bg.rgb, a.accent ? a.accent.rgb : a.bg.rgb) >
        contrast(a.fg.rgb, a.accent ? a.accent.rgb : a.bg.rgb) ? a.bg.h : a.fg.h;
      const sub = overFg(a.fg.rgb, SUB_ALPHA, (a.surface || a.bg).rgb);
      const hexSub = hex(sub);
      blocks.push(`
  <section class="blk">
    <div class="hd">
      <b>${rule.cn}</b>
      <code>--type ${k}</code>
      <span class="${okAll ? 'ok' : 'bad'}">${okAll ? (nWarn ? `过闸（${nWarn} 项提示）` : '全部过闸') : '有项未过闸'}</span>
      <em>选中「${c.t}」${c.src ? ' · XHS 机器取色' : ' · 人工整理'}${a.fgFallback ? ' · ★文字色补位' : ''}${a.accent ? '' : ' · 无强调色'}</em>
    </div>
    <div class="card" style="background:${a.bg.h};color:${onCard}">
      <p class="onbg" style="color:${hexSub}">底上副标（α=${SUB_ALPHA} 有效色 ${hexSub}）</p>
      <div class="surf" style="background:${a.surface ? a.surface.h : 'transparent'};border-color:${a.line ? a.line.h : 'transparent'}">
        <h3 style="color:${onCard}">硬件级实测 · 亚毫秒级同步</h3>
        <p style="color:${hexSub}">卡片面上副标（看这句清不清）</p>
        <div class="row">
          <span class="btn" style="background:${a.accent ? a.accent.h : a.bg.h};color:${onAccent}">主强调</span>
          ${a.accent2 ? `<span class="chip" style="border-color:${a.accent2.h};color:${a.accent2.h}">次强调</span>` : ''}
          <span class="data" style="background:${a.accent ? a.accent.h : a.bg.h}"></span>
          <span class="data" style="background:${a.accent ? a.accent.h : a.bg.h};opacity:.55"></span>
          <span class="data" style="background:${a.accent2 ? a.accent2.h : (a.accent ? a.accent.h : a.bg.h)};opacity:.75"></span>
        </div>
      </div>
      <div class="sw">
        ${a.sorted.map(x => `<i style="background:${x.h}" title="${x.h}"></i>`).join('')}
      </div>
    </div>
    <pre class="vars">--bg0:${a.bg.h};  ${a.surface ? `--bg1:${a.surface.h};  ` : ''}--t1:${a.fg.h};${a.fgFallback ? ' /*★补位*/' : ''}
${a.accent ? `--a1:${a.accent.h};  ` : '/*无强调色*/'}${a.accent2 ? `--a2:${a.accent2.h};  ` : ''}${a.line ? `--ln:${a.line.h};` : ''}</pre>
  </section>`);
    }
    fs.writeFileSync(out, `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>全局配色抓取 · 九型对照</title>
<style>
 body{margin:0;padding:24px;background:#EDEEF0;font:14px/1.6 "Microsoft YaHei",system-ui,sans-serif;color:#1A1D21}
 h1{font-size:20px;margin:0 0 4px}.sub{color:#5A6169;margin:0 0 20px;font-size:13px}
 .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
 .blk{background:#fff;border:1px solid #D8DBDF;border-radius:10px;padding:12px}
 .hd{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;margin-bottom:10px}
 .hd b{font-size:14px}.hd code{font-size:11px;background:#F1F3F5;padding:1px 6px;border-radius:4px;color:#4A5158}
 .hd .ok{font-size:11px;color:#116B4A;background:#E3F4EC;padding:1px 6px;border-radius:4px}
 .hd .bad{font-size:11px;color:#9B2226;background:#FBE6E7;padding:1px 6px;border-radius:4px}
 .hd em{font-size:11px;color:#6B7280;font-style:normal;width:100%}
 .card{border-radius:8px;padding:14px;overflow:hidden}
 .surf{border:1px solid;border-radius:6px;padding:12px}
 .surf h3{font-size:15px;margin:0 0 6px;font-weight:600}
 .surf p{font-size:12px;margin:0 0 10px}
 .row{display:flex;align-items:center;gap:8px}
 .btn{font-size:12px;padding:5px 12px;border-radius:5px;font-weight:600}
 .chip{font-size:12px;padding:4px 10px;border:1px solid;border-radius:5px}
 .data{width:26px;height:8px;border-radius:2px}
 .sw{display:flex;gap:3px;margin-top:10px}
 .sw i{flex:1;height:14px;border-radius:3px}
 .vars{font:11px/1.5 Consolas,monospace;background:#F6F7F8;border-radius:6px;padding:8px;margin:10px 0 0;white-space:pre-wrap;color:#374151}
</style></head><body>
<h1>全局配色抓取 · 九型对照（kit/palette_pick.cjs --sheet）</h1>
<p class="sub">每张卡的底色/文字/强调都来自该类型白名单的第 1 候选。★ 闸门全绿不代表好看 —— 这一页就是给人眼看的。</p>
<div class="grid">${blocks.join('')}
</div></body></html>`, 'utf8');
    console.log(`[sheet] ✓ ${Object.keys(TYPE_RULES).length} 类 → ${out}`);
    console.log('[sheet] ★ 必须人眼看一遍：底↔字有没有发糊 / 强调色跳不跳 / 数据条分不分得开');
    return;
  }

  if (process.argv.includes('--scan')) {
    console.log(`色卡库：${PAL_HTML}`);
    console.log(`原始权重 sidecar：${RAW_STATE}  ← ${PAL_RAW}`);
    console.log(`总条目 ${PALS.length} ｜ 过闸可用 ${USABLE.length} ｜ 被拦 ${PALS.length - USABLE.length}`);
    const byKind = { struct: [], machine: [] };
    GATED.filter(x => !x.g.ok).forEach(x => byKind[x.g.kind].push(x));
    const label = { struct: '结构性缺陷（两种来源都查）—— 拦', machine: '机器取色失真（★ 只查 XHS 条目）—— 拦' };
    for (const k of ['struct', 'machine']) {
      if (!byKind[k].length) continue;
      console.log(`\n── ${label[k]}  ${byKind[k].length} 条 ──`);
      byKind[k].forEach(x => console.log(`  #${String(x.p.__i).padStart(2)} 「${(x.p.t || '').slice(0, 24)}」 — ${x.g.why}`));
    }
    /* maxShare 分布：判据自身的健康度 */
    const mach = GATED.filter(x => x.p.src);
    const withMS = mach.filter(x => x.g.maxShare !== null && x.g.maxShare !== undefined);
    const noMS = mach.filter(x => x.g.maxShare === null || x.g.maxShare === undefined);
    console.log(`\n── 机器取色条目 maxShare 判定率  ${withMS.length}/${mach.length} ──`);
    if (withMS.length) {
      const hi = withMS.filter(x => x.g.maxShare > 0.55).sort((a, b) => b.g.maxShare - a.g.maxShare);
      const lo = withMS.filter(x => x.g.maxShare <= 0.55);
      console.log(`  判定为「色卡图」 ${lo.length} 条  maxShare 区间 ${Math.min(...lo.map(x => x.g.maxShare)).toFixed(3)}~${Math.max(...lo.map(x => x.g.maxShare)).toFixed(3)}`);
      console.log(`  判定为「照片」   ${hi.length} 条  ${hi.map(x => `#${x.p.__i}=${x.g.maxShare.toFixed(3)}`).join(' ')}`);
    }
    if (noMS.length) {
      console.log(`  ⚠ **未判定 ${noMS.length} 条** —— 这几条判不了"色卡图还是照片"，用前必须人眼核原图：`);
      console.log(`    ${noMS.map(x => `#${x.p.__i}「${(x.p.t || '').slice(0, 14)}」`).join(' ')}`);
    }
    const warned = GATED.filter(x => x.g.ok && x.g.warn.length);
    console.log(`\n── 告警（★ 只告警不拦）  ${warned.length} 条 ──`);
    warned.forEach(x => x.g.warn.forEach(w => console.log(`  #${String(x.p.__i).padStart(2)} ${w}`)));
    console.log('\n── 各类型候选可用性 ──');
    for (const k of Object.keys(TYPE_RULES)) {
      const cs = candidates(TYPE_RULES[k]);
      const miss = cs.filter(c => c.__missing);
      console.log(`  ${k.padEnd(9)} ${TYPE_RULES[k].cn.padEnd(15)} 可用 ${cs.length - miss.length}/${cs.length}` +
        (miss.length ? `  ⚠ 缺：${miss.map(m => m.__missing + '(' + m.__reason + ')').join(', ')}` : ''));
    }
    return;
  }

  if (process.argv.includes('--list')) {
    for (const k of Object.keys(TYPE_RULES)) {
      const r = TYPE_RULES[k];
      console.log(`${k.padEnd(9)} ${r.cn.padEnd(14)} 基底=${r.base.padEnd(5)} 饱和=${r.sat.padEnd(5)} 候选 ${r.pick.length} 条`);
      console.log(`          ${r.why}`);
    }
    return;
  }

  const type = arg('type', '');
  if (!type || !TYPE_RULES[type]) {
    console.error('用法: node kit/palette_pick.cjs --type <' + Object.keys(TYPE_RULES).join('|') + '>');
    console.error('      --list | --scan | --alt <n> | --brand "#RRGGBB" | --json');
    console.error('      --palette "#RRGGBB,#RRGGBB,..."  外部给定色板直通（品牌色板优先于色卡）');
    process.exit(2);
  }

  const rule = TYPE_RULES[type];
  const cs = candidates(rule);
  const usableCs = cs.filter(c => !c.__missing);
  const alt = parseInt(arg('alt', '0'), 10) || 0;

  if (!usableCs.length) { console.error(`[palette_pick] ✗ 类型 ${type} 无可用候选`); process.exit(1); }

  /* ── 候选对照表：给证据，不替 lead 做决定 ── */
  if (process.argv.includes('--tryall')) {
    console.log(`候选对照 · ${type}（${rule.cn}）  基底=${rule.base}`);
    console.log('  序号 色卡                              来源   强调色  文字色      底↔字   底↔主强调  判定');
    usableCs.forEach((c, i) => {
      const x = assign(c, rule.base);
      const fgCR = contrast(x.fg.rgb, x.bg.rgb);
      const aCR = x.accent ? contrast(x.accent.rgb, x.bg.rgb) : null;
      /* ★ 判定必须把**底↔字也纳入** —— 只看强调色会把「文字不过闸」的卡误标 ok
         （实测 `浅天蓝·低饱和`（旧名 `北欧霜`）当深底用时字色只有 3.93 < 4.5，却曾被标 ok） */
      const bad = [];
      if (fgCR < 4.5) bad.push(`文字${fgCR.toFixed(2)}不过`);
      if (x.accentPoolSize === 0) bad.push('无强调色');
      else if (x.accentPoolSize === 1) bad.push('少1强调色');
      const verdict = bad.length ? bad.join(' / ') : 'ok';
      console.log(`  ${String(i).padStart(3)}  ${(c.t || '').slice(0, 32).padEnd(34)}` +
        `${(c.src ? 'XHS' : '人工').padEnd(6)}` +
        `${String(x.accentPoolSize).padStart(5)}   ` +
        `${(x.fg.h + (x.fgFallback ? '*补' : '   ')).padEnd(11)}` +
        `${fgCR.toFixed(2).padStart(6)}  ` +
        `${(aCR === null ? '   —  ' : aCR.toFixed(2).padStart(6))}   ${verdict}`);
    });
    console.log('\n  *补 ＝ 文字色需外部补位（本卡不含文字色，正常；浅底色卡多如此）');
    console.log('  用 --alt <序号> 选定。**判定列由工具给，选哪条由 lead 定。**');
    const miss = cs.filter(c => c.__missing);
    if (miss.length) console.log(`\n  ⚠ 白名单里被跳过的：${miss.map(m => m.__missing + '(' + m.__reason + ')').join(', ')}`);
    return;
  }

  /* ★ --palette：外部给定色板直通（品牌色板 / 老板指定）。
     用途：老板点名「跟 XX 一样」时，把手写色板原样喂进来验 —— 底色是人定的，不是色卡算的。
     `--type` 决定"取向与闸门"，`--palette` 决定"用哪些色"；角色分配与 audit 走同一条路径，
     所以这是"多一个入口"而不是"多一套逻辑"（判据不复制实现，见 BUG-总回归库 §7.1）。 */
  const extPal = String(arg('palette', '') || '').trim();
  let chosen;
  if (extPal) {
    const cols = extPal.split(/[,\s]+/).filter(Boolean)
      .map(s => (s.startsWith('#') ? s : '#' + s)).map(s => s.toUpperCase());
    const bad = cols.filter(c => !hex2rgb(c));
    if (!cols.length || bad.length) {
      console.error(`[palette_pick] ✗ --palette 含非法 HEX：${bad.join(' ') || '(空)'}`);
      process.exit(2);
    }
    /* 同色板内去重但保序——重复色会让 assign() 的 `x !== bg` 过滤失效（同值不同对象） */
    const seenH = new Set();
    const uniq = cols.filter(c => (seenH.has(c) ? false : (seenH.add(c), true)));
    chosen = {
      t: `外部给定色板 (--palette, ${uniq.length} 色)`,
      tag: 'external', src: null, colors: uniq, __i: -1, __external: true,
    };
  } else {
    chosen = usableCs[Math.min(alt, usableCs.length - 1)];
  }
  const a = assign(chosen, rule.base);
  const rows = audit(a, rule.base);
  /* ★ 外部色板路径下「缺文字色」必须 FAIL，不许补位（2026-09-17 负向对照抓到）。
     `--palette` 的语义是"这是一份**完整**色板"（品牌 spec / 老板指定）—— 这类色板一定含
     文字色；缺了就是给漏了。此时悄悄塞一个本线中性色（#16222E）属于**静默假成功**：
     闸门全绿、产物却用了没人认过的颜色。要"只给几组参考色"请用 `--alt`，别用 `--palette`。
     ⚠ **只在外部路径生效** —— 色卡路径的补位是**设计意图**（色卡本就不保证含文字色）且已明示。 */
  if (chosen.__external && a.fgFallback) {
    const r0 = rows.find(x => /^bg0↔fg/.test(x.role));
    if (r0) {
      r0.status = 'FAIL';
      r0.role = 'bg0↔fg（外部色板缺文字色）';
      /* ★ 不许继续显示**补位色**的对比度 —— 那会挂着一个"看着像 PASS"的大数字却是 FAIL
         （同 §7.1 第 68 条：把"别人家的实测值"摆在自己家的判定旁边，读者必然误读）。
         没有可测的量就写"未测"，这比给一个错口径的数诚实。 */
      r0.cr = null;
      r0.hex = '（色板内无）';
      r0.note = `⇒ 这份色板里**没有任何颜色**对 #${a.bg.h.replace('#', '')} 的对比度 ≥ 4.5。` +
        `**外部色板必须自带文字色**（补位只对色卡开放）⇒ 补一个近黑/近白文字色再跑。`;
    }
  }
  /* 外部色板也要能"判定"，不是只看角色 —— 但**先把取向对齐喊出来**：
     `--palette` 绕过了按 base 选卡的环节，外部色板可能与 type 的深浅取向相反。 */
  if (chosen.__external && !process.argv.includes('--json')) {
    const bgL = percLum(a.bg.rgb);
    const wantDark = rule.base === 'dark';
    const isDark = bgL < 0.20;
    if (wantDark !== isDark) {
      console.log(`  ⚠ 取向不符：--type ${type} 期望${wantDark ? '深' : '浅'}底，` +
        `而 --palette 的 bg=${a.bg.h} 实测相对亮度 ${bgL.toFixed(3)} 是${isDark ? '深' : '浅'}底。`);
      console.log(`     ⇒ 这是**告警不是拦截**（外部色板优先，闸门照跑）。取向是"倾向"不是"硬门禁"，见 §7.1 第 68 条。`);
    }
  }

  const allPass = rows.every(r => r.status !== 'FAIL');
  const brand = arg('brand', '');
  let brandInfo = null;
  if (brand) {
    const brgb = hex2rgb(brand);
    if (!brgb) { console.error(`[palette_pick] ✗ --brand 不是合法 HEX：${brand}`); process.exit(2); }
    brandInfo = {
      hex: hex(brgb),
      vsBg: contrast(brgb, a.bg.rgb),
      vsFg: contrast(brgb, a.fg.rgb),
      isBgLike: contrast(brgb, a.bg.rgb) < 1.25,
      isFgLike: contrast(brgb, a.fg.rgb) < 1.25,
    };
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({
      type, rule, palette: { t: chosen.t, tag: chosen.tag, src: chosen.src || null, i: chosen.__i,
        external: !!chosen.__external },
      roles: {
        bg: a.bg.h, fg: a.fg.h, fgFallback: a.fgFallback,
        surface: a.surface && a.surface.h, accent: a.accent && a.accent.h,
        accent2: a.accent2 && a.accent2.h, line: a.line && a.line.h,
      },
      accentNote: accentVerdict(a),
      sorted: a.sorted.map(x => ({ hex: x.h, L: Math.round(x.L), S: +x.S.toFixed(2) })),
      contrast: rows.map(r => ({ role: r.role, hex: r.hex,
        cr: r.cr === null ? null : +r.cr.toFixed(2), floor: r.floor,
        pass: r.cr === null ? false : r.cr >= r.floor })),
      pass: allPass, brand: brandInfo,
      missing: cs.filter(c => c.__missing).map(c => ({ name: c.__missing, why: c.__reason })),
    }, null, 1));
    process.exit(allPass ? 0 : 1);
  }

  const bar = '─'.repeat(66);
  console.log(bar);
  console.log(`全局配色抓取 · 视频类型 = ${type}（${rule.cn}）`);
  console.log(bar);
  console.log(`取向   基底 ${rule.base === 'dark' ? '深底' : '浅底'} / 饱和 ${rule.sat}`);
  console.log(`为什么 ${rule.why}`);
  console.log(`不要   ${rule.deny.join('；')}`);
  console.log('');
  console.log(`选中   「${chosen.t}」  [${chosen.__external ? '外部给定' : (chosen.src ? 'XHS 机器取色' : '人工整理')}]  tag=${chosen.tag || '-'}` +
    (!chosen.__external && usableCs.length > 1 ? `   （同类型另有 ${usableCs.length - 1} 条备选，--alt 换）` : ''));
  console.log(`原序   ${chosen.colors.join(' ')}   ★ 已按亮度重排，不信任原顺序`);
  console.log('');
  console.log('角色分配（由暗到亮重排后）');
  a.sorted.forEach(x => {
    const role = x === a.bg ? 'bg 底色' : x === a.fg ? 'fg 文字' : x === a.accent ? 'accent 主强调'
      : x === a.accent2 ? 'accent2 次强调' : x === a.surface ? 'surface 次级底' : x === a.line ? 'line 描边' : '（未用）';
    console.log(`  ${role.padEnd(16)} ${x.h}   L=${String(Math.round(x.L)).padStart(3)}  S=${x.S.toFixed(2)}`);
  });
  if (a.fgFallback) {
    console.log(`  ${'fg 文字'.padEnd(15)}  ${a.fg.h}   L=${String(Math.round(a.fg.L)).padStart(3)}  S=${a.fg.S.toFixed(2)}   ★ **补位**`);
    console.log(`    ↳ 本卡自带的最亮/最暗色对底色的对比度不足 4.5 ⇒ **本卡只提供「底 + 辅助色」，不提供文字色**。`);
    console.log(`      补位色取本线既有中性对（${a.fg.h}，与二狗 UVC 线 --t1/--bg0 同源）。**这是补位，不是本卡的颜色。**`);
  }
  const av = accentVerdict(a);
  if (av) console.log(`  ${av}`);
  const bl = bgTooLoud(a);
  if (bl) console.log(`  ${bl}`);
  statHints(a, rule.base).forEach(h => console.log(`  ${h}`));
  const lt = lineTooLoud(a);
  if (lt) console.log(`  ${lt}`);
  if (!a.surface) console.log(`  ⚠ 本卡无 surface 角色（余色里没有对比度落在 1.10~1.60 的）⇒ **--bg1 用 --bg0 叠透明度生成**，别拿别的角色顶替`);
  if (!a.line) console.log(`  ⚠ 本卡无 line 角色（余色里没有对比度落在 1.60~4.00 的）⇒ **描边用 --bg1/--t1 叠透明度生成**，别硬拿近底色当描边`);
  console.log('');
  console.log('WCAG 对比度闸（线性化口径，同 kit/contrast_check.js）');
  rows.forEach(r => {
    const mark = r.status === 'PASS' ? 'PASS ' : r.status === 'WARN' ? 'WARN ' : '★FAIL';
    if (r.cr === null) {
      /* 判定成立但**无被测量**（如"外部色板缺文字色"）—— 不许拿补位色的数糊上去 */
      console.log(`  ${mark} ${r.role.padEnd(24)} ${r.hex}  —— : 未测（本项无被测量）`);
      if (r.note) console.log(`         ${r.note}`);
      return;
    }
    const margin = ((r.cr / r.floor - 1) * 100).toFixed(0);
    console.log(`  ${mark} ${r.role.padEnd(24)} ${r.hex}  ${r.cr.toFixed(2)} : 1   (门槛 ${r.floor}, 余量 ${margin}%)` +
      (r.status === 'PASS' && r.cr / r.floor < 1.10 ? '  ⚠ 贴地板线（余量<10%）' : ''));
    if (r.note) console.log(`         ${r.note}`);
  });
  if (brandInfo) {
    console.log('');
    console.log(`品牌色占位检查 ${brandInfo.hex}`);
    console.log(`  vs 底色 ${brandInfo.vsBg.toFixed(2)} : 1 ${brandInfo.isBgLike ? '⚠ 与底色几乎同亮度＝会被吃掉' : ''}`);
    console.log(`  vs 文字 ${brandInfo.vsFg.toFixed(2)} : 1 ${brandInfo.isFgLike ? '⚠ 与文字几乎同亮度' : ''}`);
  }
  console.log('');
  console.log('可直接粘贴的全局变量块');
  console.log('  :root{');
  console.log(`    --bg0:${a.bg.h};      /* 底 */`);
  if (a.surface) console.log(`    --bg1:${a.surface.h};      /* 次级底/卡片面 */`);
  else console.log(`    /* ⚠ 本卡无 surface 角色 ⇒ --bg1 用 --bg0 叠透明度生成，别拿 --ln 顶替 */`);
  console.log(`    --t1:${a.fg.h};       /* 主文字${a.fgFallback ? '（★补位）' : ''} */`);
  if (a.accent) console.log(`    --a1:${a.accent.h};       /* 主强调 */`);
  else console.log(`    /* ★ 本卡无可用强调色 ⇒ --a1 必须另补 */`);
  if (a.accent2) console.log(`    --a2:${a.accent2.h};       /* 次强调 */`);
  if (a.line) console.log(`    --ln:${a.line.h};       /* 描边/分隔 */`);
  console.log('  }');
  console.log('');
  console.log(bar);
  console.log(allPass ? '结论 PASS —— 配色可用，进 ⑥ 规格锁' : '结论 ★FAIL —— 有角色未过对比度闸，换 --alt 或换类型取向，别硬用');
  console.log(bar + '\n');
  process.exit(allPass ? 0 : 1);
}

main();
