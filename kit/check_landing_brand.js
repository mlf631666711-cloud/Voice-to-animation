#!/usr/bin/env node
/* =============================================================================
 * check_landing_brand.js —— 落版品牌署名 / 品牌串味 校验器
 *
 * 依据：
 *   ① 老板 2026-09-30 指令（原话）：
 *      「首先纠正你的视频最后这一帧 也是老毛病了 **最后不用给个品牌定语**
 *        而且**这也不是明动的 这是启明的**」
 *   ② BUG-总回归库 §7 跨工程回归检查清单（本器补「落版零品牌署名」一条）
 *   ③ 启明线实证（6/6）：s31cam / s31-tiny-end / s31-tiny-studio / s31-tiny-struct /
 *      s31-open-source 五个已交付工程 `grep 'id="logo"'` 全 0 命中；
 *      `s31-tiny-end` 尾镜末帧只有 `<div id="title">ESP32-S31 TINY</div>`（纯型号）
 *   ④ `Ai项目文案/启明/项目展示Demo风格/项目展示Demo风格-规格锁.md §五`：
 *      「收尾 CTA：开源获取 + 品牌签名（"启明云端——乐鑫科技一级代理商及方案商"）」
 *      ⚠️ 这是【口播文案】口径，**不是画面落版** —— 两者别混。
 *
 * ★ 本器守的那条规矩（一句话）：
 *      【画面落版 = 产品型号；品牌走口播，不上画面。】
 *
 * 用法：
 *   node kit/check_landing_brand.js <工程目录>                 # 自动找 specs/*.layers.json + *.html
 *                   ⚠️ 若工程内 depth≤2 有 **≥2 份 fx_*.src.html** ⇒ **拒绝自动挑**（exit 2 并列全部候选）
 *                      —— 请显式 `--html`。防的是「自动挑到旧版还打 PASS」（BUG-2642）
 *   node kit/check_landing_brand.js <工程目录> --html v2/fx_c5_v2.src.html --layers specs/v2.layers.json
 *                                                              # ★ 同目录多版片子时必须显式配对
 *   node kit/check_landing_brand.js <工程目录> --shot 7        # 显式指定尾镜 shot 号
 *   node kit/check_landing_brand.js <工程目录> --selftest      # 负控自检（造一个品牌署名看抓不抓得到）
 *   node kit/check_landing_brand.js <工程目录> --json          # 机器可读输出
 *   node kit/check_landing_brand.js <工程目录> --no-sidecar-ok # 显式声明「本工程没有元素侧车」
 *                                                              # （默认找不到侧车会 exit 2，拒绝给结论）
 *
 * ★★ 声明式「无落版层」（铁律 331，2026-10-01）：侧车顶层写 `"no_landing": true`
 *      —— 老板「动画做到最后一秒就直接延长」之后，片尾不再有独立的落版/收尾标元素，
 *      末尾就是正片最后一镜继续演。此时：
 *        · 【尾镜】概念**仍然成立**（= 侧车里 shot 最大那组），检查面、判据、严重度**一律不变**；
 *        · 变的只是**术语与文案** —— 不再把检查面叫"落版元素"（那会暗示本条片子有落版层，
 *          后来人一看输出就"顺手补个落版回去"，正是要根除的老毛病）；
 *        · ⚠️ **这不是豁免开关**：声明之后 2.5 防假绿、品牌词 FAIL 级、品牌定语 FAIL 级
 *          全部照旧生效。「声明一下就免检」的洞不存在。
 *
 * 判据分两级（不同严重度，别混）：
 *   FAIL —— **落版元素**（尾镜 shot 最大那组）的可见文本命中品牌词
 *           ⇒ 画面署品牌，违反主规矩。**任何品牌都不行**（含本片客户自己的品牌）。
 *   INFO —— **非落版元素**命中品牌词
 *           ⇒ 不一定错（口播字幕可能出现），但**列出来供人判断是否品牌串味**（BUG-2522 同族）。
 *
 * 退出码：0 = PASS（无 FAIL）；1 = FAIL；2 = 用法/环境错。
 *
 * ⚠️ 已知边界：
 *   - 只扫**静态文本**。由 JS 运行时写入的 `textContent` 抓不到 ⇒ 动效文字请一并肉眼核。
 *   - 注释（`<!-- -->`）与 `<script>` 内的品牌词**故意忽略** —— 代码注释里写
 *     「本片是启明…之前误写 MDoing」属于**说明性文字**，不是画面内容，报出来纯噪音。
 *   - ★ **void 元素**（`<img id="scr-img">` / `<input>` / `<br>`…）没有闭合标签，
 *     不能用「找得到闭合标签」当"元素存在"的判据 —— 实测：C5 v2 的 `#scr-img` 就是
 *     `<img id="scr-img" alt="">`，老实现返回 null ⇒ 2.5 误报"侧车与 HTML 不配套"
 *     （判据自己出错，比漏检更难发现）。正解见 elemExists() / textOfId()。
 * ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');

/* void 元素（HTML 规范里没有闭合标签、不能有子节点） */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img',
  'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/* ---------------------------------------------------------------- 品牌词库
 * 跨客户线共享。每项 = 一条品牌线；aliases 命中即算。
 * 新增客户线时往这里加，**不要**改判据逻辑。
 * ------------------------------------------------------------------------ */
const BRAND_LINES = [
  { line: '明动科技', aliases: ['MDoing', 'MDOING', 'mdoing', '明动'] },
  { line: '启明云端', aliases: ['启明云端', '启明', 'Qiming', 'QIMING', 'Wireless-Tag', 'WirelessTag', '无线龙'] },
  { line: '乐鑫科技', aliases: ['乐鑫', 'Espressif', 'ESPRESSIF'] },
];

/* 品牌后缀/资质定语（老板说的「品牌定语」本体，如「—乐鑫科技一级代理商及方案商」） */
const BRAND_QUALIFIER_PAT = /一级代理商|方案商|授权代理|官方代理|affiliate|authorized\s+distributor/i;

/* ------------------------------------------------------------------ 工具 */

function die(msg, code) {
  console.error('[check_landing_brand] ' + msg);
  process.exit(code || 2);
}

/** 读文件，返回 utf-8 文本 */
function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); }
  catch (e) { return null; }
}

/** 去掉注释与 script/style，避免代码注释里的品牌词造成噪音 */
function stripCode(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
}

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 该 id 的开始标签（返回 {tag, tagText, index, raw} 或 null） */
function openTagOf(html, id) {
  const re = new RegExp('<([a-zA-Z][\\w-]*)\\b[^>]*\\bid\\s*=\\s*["\']' + esc(id) + '["\'][^>]*>', 'i');
  const m = html.match(re);
  if (!m) return null;
  return { tag: m[1].toLowerCase(), tagText: m[0], index: m.index };
}

/** 该 id 的**开始标签是否为 void / 自闭合**（没有子节点，不存在闭合标签） */
function isVoidId(html, id) {
  const o = openTagOf(html, id);
  if (!o) return false;
  return VOID_TAGS.has(o.tag) || /\/>$/.test(o.tagText);
}

/** ★ 元素**是否存在** —— 判存在性一律用这个，**不要**用 `textOfId(x) !== null`：
 *    void 元素（`<img id="scr-img">`）根本没有闭合标签，textOfId 会返回 null，
 *    拿它管存在性就会把**配套的侧车**误判成"错配"（实测假 FAIL，本轮踩过）。 */
function elemExists(html, id) {
  return openTagOf(html, id) !== null;
}

/** 从 HTML 中取某 id 元素的**可见文本**（去嵌套标签）
 *  返回：null = 元素不存在；'' = 存在但无文本（void 元素 / 空元素 / 闭合标签缺失） */
function textOfId(html, id) {
  const o = openTagOf(html, id);
  if (!o) return null;
  if (VOID_TAGS.has(o.tag) || /\/>$/.test(o.tagText)) return '';   // void ⇒ 存在但无文本
  const rest = html.slice(o.index + o.tagText.length);
  const mc = rest.match(new RegExp('([\\s\\S]*?)</' + o.tag + '\\s*>', 'i'));
  if (!mc) return '';                                              // 无闭合标签 ⇒ 当空文本，别当不存在
  return mc[1]
    .replace(/<[^>]+>/g, ' ')      // 去嵌套标签
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 命中品牌词 → 返回命中的 {line, hit} 列表 */
function matchBrands(text) {
  const out = [];
  if (!text) return out;
  for (const b of BRAND_LINES) {
    for (const a of b.aliases) {
      if (text.indexOf(a) !== -1) { out.push({ line: b.line, alias: a }); break; }
    }
  }
  return out;
}

/** 在整个 HTML 里找所有元素 id + 其文本（粗扫，供 INFO 级用） */
function allIdTexts(html) {
  const out = [];
  const re = /<([a-zA-Z][\w-]*)\b([^>]*\bid\s*=\s*["']([^"']+)["'][^>]*)>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const id = m[3];
    const inner = m[4].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (inner) out.push({ id, text: inner });
  }
  // 去重（同 id 取最长文本）
  const map = new Map();
  for (const it of out) {
    if (!map.has(it.id) || map.get(it.id).text.length < it.text.length) map.set(it.id, it);
  }
  return [...map.values()];
}

/* ------------------------------------------------------------------ 主流程 */

const argv = process.argv.slice(2);
if (!argv.length) die('用法：node kit/check_landing_brand.js <工程目录> [--shot N] [--selftest] [--json]', 2);

const dir = path.resolve(argv[0]);
if (!fs.existsSync(dir)) die('目录不存在：' + dir);
const SELFTEST = argv.includes('--selftest');
const AS_JSON = argv.includes('--json');
/* ★ 显式声明「本工程按设计没有元素侧车」⇒ 允许不给检查面（否则默认拒绝给结论） */
const NO_SIDECAR_OK = argv.includes('--no-sidecar-ok');
let shotArg = null;
const si = argv.indexOf('--shot');
if (si !== -1 && argv[si + 1]) shotArg = Number(argv[si + 1]);

/* ★ 显式配对：同一工程目录下可能并存多版片子（v1 在根、v2 在子目录）。
 *   自动挑「第一份」是最容易产生「审的是别的文件」这类假绿的路径。 */
let htmlArg = null, layersArg = null;
const hi = argv.indexOf('--html');
if (hi !== -1 && argv[hi + 1]) htmlArg = argv[hi + 1];
const li = argv.indexOf('--layers');
if (li !== -1 && argv[li + 1]) layersArg = argv[li + 1];

/* 1) 找 HTML：优先 fx_*.src.html（真源），否则任意 *.html（跳过 frames/ 与 _tools/） */
let htmlPath = null;
/* ★ --html 优先（相对工程目录或绝对路径均可） */
if (htmlArg) {
  const hp = path.isAbsolute(htmlArg) ? htmlArg : path.resolve(dir, htmlArg);
  if (!fs.existsSync(hp)) die('--html 指定的文件不存在：' + hp);
  htmlPath = hp;
}
/* ★★ 2026-10-01 修（BUG-2642）：旧实现是 walk 「先查根目录、命中即返回」——
 *    在**新旧版本并存**的工程里必然挑错，而且**照样打 PASS**。
 *    实测 `projects/C5-TINY-Game`：depth≤2 内共 **9 份** `fx_*.src.html`
 *      （根目录 v1 `fx_c5_opener.src.html` · `v2/` 三条现版 · `_before/` 三条改前副本 ·
 *       `大狗/src/` 两条副手线）；旧实现挑中的是**根目录那份 v1**，
 *    于是输出「✓ 合规 / PASS」—— 而那个 PASS **说的不是现版 `v2/fx_c5_v2.src.html`**。
 *    ⇒ 静默假绿，同族：BUG-2630（没找到侧车却打「✓ 合规」）/ BUG-2557（错配侧车假 PASS）。
 *    ⇒ 改成：**收齐全部候选** → **≥2 份就拒绝自动挑**（显式 `--html` 才给结论），
 *      并把候选连同 mtime 全列出来。1 份才自动用（原行为不变）。
 *    ⇒ 铁律：**判据挑不确定就不给结论**，不许「挑个最新的算了」——
 *      那等于把"审了哪一份"这个前提藏起来。 */
let htmlCands = [];
if (!htmlPath) {
  const collectSrc = (d, depth, acc) => {
    if (depth > 2) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (!e.isFile() || !/^fx_.*\.src\.html$/i.test(e.name)) continue;
      const p = path.join(d, e.name);
      let mt = 0;
      try { mt = fs.statSync(p).mtimeMs; } catch (err) { /* ignore */ }
      acc.push({ p, mt });
    }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      if (/^(frames|_tools|node_modules|_audit_legacy|_src|_refs|audio|assets)$/i.test(e.name)) continue;
      collectSrc(path.join(d, e.name), depth + 1, acc);
    }
  };
  collectSrc(dir, 0, htmlCands);
  if (htmlCands.length === 1) {
    htmlPath = htmlCands[0].p;
  } else if (htmlCands.length > 1) {
    htmlCands.sort((a, b) => b.mt - a.mt);          /* 最新在前，仅用于展示 */
    console.error('[check_landing_brand] ⚠️  本工程 depth≤2 内共 ' + htmlCands.length + ' 份 fx_*.src.html：');
    for (const c of htmlCands) {
      console.error('      ' + path.relative(process.cwd(), c.p).replace(/\\/g, '/') +
                    '   mtime=' + new Date(c.mt).toISOString().slice(0, 19).replace('T', ' '));
    }
    if (!SELFTEST) {
      die('多份 fx_*.src.html 并存 ⇒ **拒绝自动挑**\n' +
          '        （自动挑到旧版 = 审了一份废的还打 PASS，见 BUG-2642）\n' +
          '        请显式指定：--html <相对工程目录的路径>\n' +
          '        例：--html v2/fx_c5_v2.src.html --layers specs/v2.layers.json', 2);
    }
    /* ★ 仅 --selftest：负控只需要「一份能与某份侧车配对的 HTML」。
     *   直接取最新那份是不够的 —— 实测 C5 最新的是 `_before/` 的改前副本，
     *   它配不上任何侧车 ⇒ 侧车步会以「找不到侧车」死掉，
     *   而那是**探针配置问题**，不是判据问题（会把"负控跑不起来"误读成"判据坏了"）。
     *   ⇒ 按 mtime 新→旧试，取第一份能被某份侧车认领的（id 有交集）。 */
    const selftestSidecars = [];
    for (const sub of ['specs', 'spec']) {
      const sd = path.join(dir, sub);
      if (!fs.existsSync(sd)) continue;
      try {
        for (const f of fs.readdirSync(sd)) if (/\.json$/i.test(f)) selftestSidecars.push(path.join(sd, f));
      } catch (e) { /* ignore */ }
    }
    /* ★ 配对判据必须与**侧车步同一把尺子**：比的是「检查面 = shot 最大那组」的 id，
     *   不是「任意 id 有交集」。
     *   实测教训（本修的第一版就踩了）：L3 副本与 `opener.layers.json` 共享
     *   常驻底噪层的 id（`bg0` / `scanline` / `fx-dust` 那类）⇒ 用"任意 id 交集"
     *   会把 `_before/fx_c5_l3.src.html` 判成"配得上"，然后在侧车步又配不上，
     *   最后死在「没配到任何元素侧车」——**两把尺子**。 */
    const faceIdsOf = j => {
      const ids = [];
      const w = o => {
        if (Array.isArray(o)) return o.forEach(w);
        if (o && typeof o === 'object') {
          if (o.id && o.shot != null) ids.push({ id: o.id, shot: Number(o.shot) });
          Object.values(o).forEach(w);
        }
      };
      w(j);
      if (!ids.length) return [];
      const mx = Math.max(...ids.map(x => x.shot));
      return [...new Set(ids.filter(x => x.shot === mx).map(x => x.id))];
    };
    /* 备份 / 中间目录（路径任一段以 `_` 开头，如 `_before/`）排到最后 —— 显式排序，不是隐藏。 */
    const isBackupish = p => path.relative(dir, p).split(path.sep).slice(0, -1)
      .some(seg => seg.startsWith('_'));
    const ordered = [...htmlCands].sort((a, b) =>
      (isBackupish(a.p) - isBackupish(b.p)) || (b.mt - a.mt));
    for (const c of ordered) {
      const txt = stripCode(readText(c.p) || '');
      if (!txt) continue;
      let paired = false;
      for (const sf of selftestSidecars) {
        let j; try { j = JSON.parse(readText(sf)); } catch (e) { continue; }
        if (faceIdsOf(j).some(id => elemExists(txt, id))) { paired = true; break; }
      }
      if (paired) { htmlPath = c.p; break; }
    }
    if (!htmlPath) htmlPath = htmlCands[0].p;   /* 兜底：后续侧车步会自己报错 */
    console.log('[selftest] 多版本并存 ⇒ 自动配对选中 HTML : ' +
                path.relative(process.cwd(), htmlPath).replace(/\\/g, '/'));
  } else {
    /* 退而求其次：根目录任意 html */
    try {
      const c = fs.readdirSync(dir).filter(f => /\.html$/i.test(f));
      if (c.length) htmlPath = path.join(dir, c[0]);
    } catch (e) { /* ignore */ }
  }
}
if (!htmlPath) die('没找到 .html（找过 fx_*.src.html 与根目录 *.html）：' + dir);

let html = readText(htmlPath);
if (html === null) die('HTML 读不出：' + htmlPath);
html = stripCode(html);

/* 2) 找 layers.json → 推断尾镜（shot 最大那组）
 *   ★★ 2026-10-01（铁律 331）：侧车顶层可写 `"no_landing": true` **声明本条片子没有落版层**。
 *      老板「动画做到最后一秒就直接延长」之后，末尾不再有独立的落版/收尾标元素。
 *      ⚠️ 注意：**尾镜仍然存在**（= shot 最大那组），所以检查面不缩、判据不松 ——
 *      本标志只改**术语与文案**，避免输出里出现"落版元素"这个已经不存在的概念。 */
let layersPath = null, landingIds = [], maxShot = null, NO_LANDING = false;
{
  const cands = [];
  /* ★ 目录名两种写法都认：`specs/`（本工程）与 `spec/`（狗子线在用）。
   *   只认一种 ⇒ 侧车存在却"找不到" ⇒ 检查面为空 ⇒ 打出一个"合规"的假 PASS。 */
  for (const sub of ['specs', 'spec']) {
    const d = path.join(dir, sub);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) if (/\.json$/i.test(f)) cands.push(path.join(d, f));
  }
  /* 提取一份侧车里所有 {id, shot} */
  const collect = j => {
    const ids = [];
    const walk = o => {
      if (Array.isArray(o)) return o.forEach(walk);
      if (o && typeof o === 'object') {
        if (o.id && o.shot != null) ids.push({ id: o.id, shot: Number(o.shot) });
        Object.values(o).forEach(walk);
      }
    };
    walk(j);
    return ids;
  };
  /* ★ 从一份侧车解析出「检查面」= shot 最大那组的 id。
   *   有/无 no_landing 走**同一条**解析路径 —— 两条路径分叉是假绿的温床。 */
  const faceOf = j => {
    const ids = collect(j);
    if (!ids.length) return null;
    const mx = shotArg != null ? shotArg : Math.max(...ids.map(x => x.shot));
    const grp = [...new Set(ids.filter(x => x.shot === mx).map(x => x.id))];
    return grp.length ? { mx, grp } : null;
  };

  if (layersArg) {
    const lp = path.isAbsolute(layersArg) ? layersArg : path.resolve(dir, layersArg);
    if (!fs.existsSync(lp)) die('--layers 指定的文件不存在：' + lp);
    let j;
    try { j = JSON.parse(readText(lp)); } catch (e) { die('--layers 不是合法 JSON：' + lp); }
    /* ★ 声明式无落版层（铁律 331）：只是**术语**切换，检查面解析与下面完全一致。 */
    if (j.no_landing === true) NO_LANDING = true;
    const face = faceOf(j);
    if (!face) die('--layers 里没有任何 {id, shot}：' + lp);
    layersPath = lp; maxShot = face.mx; landingIds = face.grp;
  } else {
    for (const c of cands) {
      const t = readText(c);
      if (!t) continue;
      let j; try { j = JSON.parse(t); } catch (e) { continue; }
      const face = faceOf(j);
      if (!face) continue;
      /* ★ 检查面 id 与当前 HTML 一个都不沾 ⇒ 这份侧车审的不是这个片子，换下一份。
       *   少了这一步，同目录并存多版时会挑中「第一份」并一路 skip 到 PASS。
       *   ★ 用 elemExists 而不是 textOfId（img 这类 void 元素没有闭合标签）。 */
      if (!face.grp.some(id => elemExists(html, id))) continue;
      layersPath = c; maxShot = face.mx; landingIds = face.grp;
      if (j.no_landing === true) NO_LANDING = true;
      break;
    }
  }
}

/* 检查面的**称呼**（铁律 331）：声明无落版层之后，叫"尾镜可见文本"才对 ——
 * 继续叫"落版元素"会让后来人以为片子还该有落版层。判据强度两边完全一样。 */
const SCOPE_LABEL = NO_LANDING ? '尾镜可见文本' : '落版元素';

/* 2.4) ★ 一份侧车都没配到 ⇒ 检查面无从谈起。
 *      老实现此时 landingIds=[] 一路走到最后，打印「✓ 落版零品牌署名 —— 合规」+ exit 0。
 *      这是**比 2.5 更隐蔽的一类假绿**：2.5 只在「找到了侧车但 id 全不沾」时报错，
 *      而「压根没找到侧车」以前是直接绿灯 —— 判据什么都没审，却给了合规结论。
 *      实测：狗子线侧车放在 `spec/`（单数），旧实现没扫到 ⇒ 假 PASS。
 *      ⇒ 默认**拒绝给结论**；确实按设计没有侧车的工程用 --no-sidecar-ok 显式声明。 */
if (!layersPath && !NO_SIDECAR_OK) {
  console.error('[check_landing_brand] ❌ 没配到任何元素侧车 —— 检查面为空，拒绝给结论。');
  console.error('  找过  : ' + path.relative(process.cwd(), dir).replace(/\\/g, '/') + '/{specs,spec}/*.json');
  console.error('  HTML  : ' + path.relative(process.cwd(), htmlPath).replace(/\\/g, '/'));
  console.error('  ⇒ 用 --layers 显式指定；本工程按设计没有侧车时加 --no-sidecar-ok（会退化成只做全片 INFO 扫）。');
  process.exit(2);
}

/* 2.5) ★ 防假绿自检：检查面 id 在 HTML 里**一个都找不到** ⇒ 侧车与 HTML 不配套。
 *      原实现此时会一路 skip 到 PASS —— 这是最危险的一类假绿：
 *      判据在审**另一个文件**，退出码却是 0。（BUG-2555 同族：全绿但画面是空）
 *      宁可报错拒绝给结论，也不给一个查不到东西的 PASS。
 *      ★ 声明 no_landing **不豁免**这一步（否则「声明一下就免检」）。 */
if (landingIds.length) {
  const foundIds = landingIds.filter(id => elemExists(html, id));
  const missIds = landingIds.filter(id => !elemExists(html, id));
  if (!foundIds.length) {
    console.error('[check_landing_brand] ❌ ' + SCOPE_LABEL + '一个都没在 HTML 里找到 —— 侧车与 HTML 不配套（拒绝给结论）。');
    console.error('  侧车  : ' + (layersPath ? path.relative(process.cwd(), layersPath).replace(/\\/g, '/') : '(无)'));
    console.error('  HTML  : ' + path.relative(process.cwd(), htmlPath).replace(/\\/g, '/'));
    console.error('  ' + SCOPE_LABEL + ' id = [' + landingIds.join(', ') + ']');
    console.error('  ⇒ 用 --html / --layers 显式指定配套的那一对。');
    process.exit(2);
  }
  if (missIds.length) {
    console.log('[check_landing_brand] ⚠️  有 ' + missIds.length + ' 个检查面 id 在 HTML 里找不到：[' +
                missIds.join(', ') + '] —— 这些 id **未被检查**，别当成已验。');
  }
}

/* 3) ★ 负控自检：临时注入一个品牌署名，看判据会不会 FAIL
 *    —— 自检铁律「这条 PASS 如果 bug 存在，它会变成 FAIL 吗？」
 */
if (SELFTEST) {
  /* ★ probe id 必须挑**非 void** 元素：`<img id="scr-img" alt="">` 注入品牌词会落在
   *   元素外面（img 无子节点），判据当然抓不到 —— 那是负控设计错了，不是判据坏了。 */
  const injectable = landingIds.filter(id => !isVoidId(html, id));
  const probeId = injectable[0] || landingIds[0] || 'model-line';
  if (isVoidId(html, probeId)) die('负控失败：检查面里可选的都是 void 元素，选不出可注入的 id');
  // 用「(品牌署名)」语法匹配 HTML 里该 id 的开始标签
  const reInj = new RegExp('(id\\s*=\\s*["\']' + esc(probeId) + '["\'][^>]*>)', 'i');
  if (!reInj.test(html)) die('负控失败：HTML 里找不到 id=' + probeId);
  const before = runCheck(html).fails.length;
  const injected = html.replace(reInj, '$1MDoing');
  const after = runCheck(injected).fails.length;
  const ok = after > before;
  console.log('[selftest] 注入品牌署名前 FAIL=' + before + ' → 注入后 FAIL=' + after);
  console.log(ok ? '[selftest] ✅ 负控通过（bug 存在时判据确实会 FAIL）'
                 : '[selftest] ❌ 负控失败 —— 这条判据是永远绿的，等于没验');
  process.exit(ok ? 0 : 1);
}

/** 核心检查：给定 html 文本，返回 {fails, infos} */
function runCheck(htmlText) {
  const fails = [], infos = [];

  // 3.1 检查面元素逐个体检（有无 no_landing 一律同等强度）
  for (const id of landingIds) {
    const t = textOfId(htmlText, id);
    if (t === null) continue;
    const hits = matchBrands(t);
    if (hits.length) {
      fails.push({ id, text: t, why: SCOPE_LABEL + '含品牌署名：' + hits.map(h => h.alias + '(' + h.line + ')').join(', ') });
    }
    if (BRAND_QUALIFIER_PAT.test(t)) {
      fails.push({ id, text: t, why: SCOPE_LABEL + '含品牌资质定语（老板点名「不用给品牌定语」）：' + t.match(BRAND_QUALIFIER_PAT)[0] });
    }
  }

  // 3.2 全片扫（INFO 级）—— 排除检查面 id 已单列的
  for (const it of allIdTexts(htmlText)) {
    if (landingIds.includes(it.id)) continue;
    const hits = matchBrands(it.text);
    if (hits.length) {
      infos.push({ id: it.id, text: it.text.slice(0, 120), why: '非落版元素含品牌词：' + hits.map(h => h.alias).join(', ') });
    }
  }
  return { fails, infos };
}

const { fails, infos } = runCheck(html);

/* 4) 输出 */
if (AS_JSON) {
  console.log(JSON.stringify({
    html: path.relative(process.cwd(), htmlPath).replace(/\\/g, '/'),
    layers: layersPath ? path.relative(process.cwd(), layersPath).replace(/\\/g, '/') : null,
    noLanding: NO_LANDING,
    scope: SCOPE_LABEL,
    landingShot: maxShot,
    landingIds,
    fails, infos,
    verdict: fails.length ? 'FAIL' : 'PASS',
  }, null, 2));
  process.exit(fails.length ? 1 : 0);
}

console.log('[check_landing_brand] 工程 : ' + path.relative(process.cwd(), dir).replace(/\\/g, '/'));
console.log('[check_landing_brand] HTML : ' + path.relative(process.cwd(), htmlPath).replace(/\\/g, '/'));
console.log('[check_landing_brand] 侧车 : ' + (layersPath ? path.relative(process.cwd(), layersPath).replace(/\\/g, '/') : '★ 无（--no-sidecar-ok 声明）⇒ 未做落版定位'));
console.log('[check_landing_brand] 口径 : ' + (NO_LANDING
  ? '★ 声明无落版层（铁律 331）⇒ 检查面 = 尾镜可见文本 · **判据不降级**'
  : (landingIds.length ? '按 shot 最大的落版组查' : '无检查面（只做全片 INFO 扫）')));
if (landingIds.length) {
  console.log('[check_landing_brand] 尾镜 shot=' + maxShot + ' · ' + SCOPE_LABEL + ' = [' + landingIds.join(', ') + ']');
}
console.log('');

if (landingIds.length) {
  for (const id of landingIds) {
    const t = textOfId(html, id);
    console.log('  ' + (NO_LANDING ? '尾镜' : '落版') + ' #' + id.padEnd(14) + ' 文本 = ' + (t === null ? '(无静态文本)' : JSON.stringify(t)));
  }
  console.log('');
}

if (infos.length) {
  console.log('  INFO · 非落版元素命中品牌词（供人工判品牌串味，BUG-2522 同族）：');
  for (const i of infos) console.log('    #' + i.id + ' : ' + i.text);
  console.log('');
}

if (fails.length) {
  console.log('  ❌ FAIL —— ' + SCOPE_LABEL + '出现品牌署名/品牌定语：');
  console.log('     规矩：画面落版 = 产品型号，品牌走口播。' +
              (NO_LANDING ? '\n     ★ 本片已声明无落版层（铁律 331）—— 无落版 ≠ 无检查面，末尾那镜照样不许署品牌。' : ''));
  for (const f of fails) console.log('    #' + f.id + ' → ' + f.why);
  console.log('');
  console.log('FAIL（' + fails.length + ' 条）');
  process.exit(1);
}

if (!landingIds.length) {
  /* ★ 无检查面时**不许**说"合规" —— 那会把"没查"说成"查过且通过" */
  console.log('  ⚠️  无检查面：本条**未做落版定位**（--no-sidecar-ok）。');
  console.log('     这条 PASS 只代表"全片静态文本里没扫到品牌词"，**不代表落版已验**。');
} else if (NO_LANDING) {
  console.log('  ✓ 尾镜可见文本零品牌署名 —— 合规（本片无落版层 · 铁律 331）');
} else {
  console.log('  ✓ 落版零品牌署名 —— 合规');
}
console.log(landingIds.length ? 'PASS' : 'PASS（⚠️ 未做落版定位）');
process.exit(0);
