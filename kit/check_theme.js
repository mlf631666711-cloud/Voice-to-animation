#!/usr/bin/env node
/**
 * check_theme.js —— Theme Pack 门禁：扫「裸色值」
 *
 * 为什么要有这个脚本：
 *   BUG-1921 —— 换肤只改 CSS，JS 里写死的 #rrggbb 全变隐形，老板截图「完全看不清」。
 *   BUG-19xx / som7608 回归 —— 浅灰字 on 白卡底对比度 1.07，远低于 WCAG AA。
 *   这两个都是「颜色耦合在代码里」的同一个病。规矩定了没人守等于没定，所以要门禁。
 *
 * 判据：
 *   1. 业务文件（fx_*.html / _patch*.py 生成的 HTML / 组件 js）里出现裸色值 → FAIL
 *   2. 主题定义文件（themes.js / theme*.json / themes.css）→ 豁免
 *   3. 单行豁免：行尾写 /* allow-color *\/ 或 // allow-color
 *   4. 文件级豁免：首行写 /* theme-free *\/
 *   5. 对比度：对每个主题跑 WCAG 自检（正文 ≥4.5 / 三级字 ≥3.0）
 *
 * 用法：
 *   node kit/check_theme.js <path> [<path>...] [--json] [--no-contrast]
 * 退出码：0 全过 / 1 有 FAIL
 */
'use strict';

const fs = require('fs');
const path = require('path');

const COLOR_RE = /#(?:[0-9a-fA-F]{3,4}){1,2}\b/g;
/* ★ 只认「数字开头」的 rgba —— 必须带 `\s*[\d.]+\s*,`。
   旧写法 `/\brgba?\s*\(/g` 只看函数名不看内容，于是
   `rgba(var(--g3-rgb),.10)`（**已经改用真源变量的正确写法**）也被判成裸色值
   ⇒ 门禁在惩罚合规（2026-10-01 收敛 L2/L3 时实际踩到：55 处假阳性）。
   同一类病在本文件里已是第二次（前一次是"审计留痕"被当裸色值）。 */
const RGB_RE = /\brgba?\s*\(\s*[\d.]+\s*,/g;

/* ★ 真源生成块：@theme-begin <id> … @theme-end
 *
 * 背景（2026-10-01 · 铁律 324）：把色板收敛成单一真源 kit/themes.js 的 c5-tiny 之后，
 * HTML 里的 :root 变成**由真源生成的产物**。若不豁免，门禁会把它当裸色值报 FAIL ——
 * 等于门禁在惩罚合规（同下面的"审计留痕"教训，同一类病）。
 *
 * ⚠️ 豁免必须成对：只有 begin 没有 end ⇒ 剥到文件尾 ⇒ 静默放行后面**所有**裸色值，
 *    门禁直接失效且零告警。所以 themeBlocksOf() 里做配对断言，扫描时先抛错。
 */
const THEME_BLOCK_STRIP_RE = /\/\*\s*@theme-begin[\s\S]*?@theme-end\s*\*\//g;
const THEME_BLOCK_FIND_RE = /\/\*\s*@theme-begin\s+([\w-]+)\s*\*\/([\s\S]*?)\/\*\s*@theme-end\s*\*\//g;

/* ⚠️⚠️ 这两条规则**只对 basename 判**（见 run() 里的 path.basename），不许对整条路径判。
   原因（2026-10-01 踩到，代价=负控全失效）：旧写法是
       /(^|[\\/])_.*\.(cjs|html?)$/
   里面的 `^` 会匹配**整条路径**的开头 ⇒ 只要路径以 `_tmp/` 这种目录名开头，
   该目录下**所有** html/cjs 都被判成"下划线前缀文件"而豁免。
   症状：四个负控样本全报「扫描 0 个代码文件」+ PASS —— 门禁静默失效，
   而肉眼看到的是一排绿灯。**判据失效最危险的形式就是它长得像通过。** */
const EXEMPT_FILE = /^(themes?\.(js|css|json)|theme[-_].*\.(js|json|css)|_.*\.(cjs|html?)|配色灵感集\.html|字幕条样式库\.html|字体框样式库\.html)$/i;

/* 历史备份豁免 —— 本工作区备份命名五花八门（`_bak_x.html` / `x.js.bak_日期` /
   `x.before_xxx`），它们保留的是**改造前的旧色值**，扫它们等于拿历史版本判今天。
   不豁免的话，扫项目目录会报出 2400+ 处噪声（本轮实际发生），把真问题埋掉。 */
const BACKUP_FILE = /^(bak|backup)|[_.-](bak|backup)([_.\-]|\d|$)|\.(orig|old)$/i;

const SKIP_DIR = new Set(['node_modules', '.git', 'frames', '_shots', '_tr', 'assets', 'imgs', 'img']);

function walk(p, out) {
  let st;
  try { st = fs.statSync(p); } catch (e) { return out; }
  if (st.isFile()) { out.push(p); return out; }
  let items;
  try { items = fs.readdirSync(p); } catch (e) { return out; }
  for (const name of items) {
    if (name.startsWith('.') && name !== '.') {
      if (name !== '.workbuddy') continue;
    }
    const full = path.join(p, name);
    let s2;
    try { s2 = fs.statSync(full); } catch (e) { continue; }
    if (s2.isDirectory()) { if (!SKIP_DIR.has(name)) walk(full, out); }
    else out.push(full);
  }
  return out;
}

function isCode(f) { return /\.(html?|js|cjs|mjs)$/i.test(f); }

function stripExemptLines(src) {
  // ⚠️ 必须先剥注释再扫色值 —— 否则「原 #XXXXXX 已提亮」这类**审计留痕**会被
  //    当成裸色值报 FAIL，等于门禁在惩罚合规（2026-09-12 视频总监审查 P0-1）。
  //    同一次扫描里，真实色值与被注释引用的旧色值落在同一行 → 会重复计数。
  const blank = m => m.replace(/[^\n]/g, ' '); // 整段换成等长空白，保留换行数便于定位

  /* ★★ 先记录哪些行带 allow-color —— 必须在剥注释**之前**。
     历史 bug（2026-10-01 发现）：原实现在剥完块注释之后才 `test(/allow-color/)`，
     可豁免标记本身就写在 `/* allow-color … *\/` 里，剥完就被换成空格了
     ⇒ **块注释形式的行尾豁免从来没生效过**（只有 `// allow-color` 能生效）。
     症状：明明按规矩标了 allow-color，门禁照样报 FAIL —— 用户会以为"规矩没用"。
     这是"判据与它自己的预处理步骤打架"的一类病，也是第二次在本文件出现。 */
  const allowLine = src.split(/\r?\n/).map(l => /allow-color/i.test(l));

  const s = src
    .replace(THEME_BLOCK_STRIP_RE, blank)     // ★ 真源生成块 —— 必须先于块注释剥（它自带注释标记）
    .replace(/\/\*[\s\S]*?\*\//g, blank)      // CSS / JS 块注释
    .replace(/<!--[\s\S]*?-->/g, blank);      // HTML 注释
  return s.split(/\r?\n/).map((l, i) => {
    if (allowLine[i]) return '';              // ★ 豁免行（按原文件行号对齐）
    // 行尾 // 注释：只认「前面不是冒号」的 //，避免把 https:// 当注释起点
    const i2 = l.search(/(^|[^:])\/\//);
    return i2 >= 0 ? l.slice(0, i2) : l;
  }).join('\n');
}

function scan(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const blocks = themeBlocksOf(raw);   // ★ 配对失败会抛 —— 不许静默剥到文件尾
  if (/^\s*(<!--\s*theme-free\s*-->|\/\*\s*theme-free\s*\*\/)/.test(raw)) {
    return { hits: [], blocks, free: true };
  }
  const src = stripExemptLines(raw);
  const hits = [];
  const lines = src.split(/\r?\n/);
  lines.forEach((line, i) => {
    let m;
    COLOR_RE.lastIndex = 0;
    while ((m = COLOR_RE.exec(line))) hits.push({ file, line: i + 1, kind: 'hex', val: m[0] });
    RGB_RE.lastIndex = 0;
    while ((m = RGB_RE.exec(line))) {
      hits.push({ file, line: i + 1, kind: 'rgb()', val: m[0] + '…' });
    }
  });
  return { hits, blocks, free: false };
}

/**
 * 取出真源生成块并做配对断言。
 * ⚠️ 配对失败**必须抛错**，不能静默 —— 只有 begin 没 end 时正则会一直匹配到文件尾，
 *    把后面所有裸色值一起豁免掉；那时门禁会显示 PASS 而实际上什么都没扫。
 */
function themeBlocksOf(src) {
  const beg = (src.match(/@theme-begin/g) || []).length;
  const end = (src.match(/@theme-end/g) || []).length;
  if (beg !== end) {
    throw new Error('@theme-begin / @theme-end 不配对（begin ' + beg + ' 个 / end ' + end +
      ' 个）—— 不配对会剥到文件尾、静默放行后面所有裸色值，故直接失败');
  }
  const out = [];
  let m;
  THEME_BLOCK_FIND_RE.lastIndex = 0;
  while ((m = THEME_BLOCK_FIND_RE.exec(src))) out.push({ id: m[1], body: m[2] });
  return out;
}

/** 把 `--a:1;--b:2` 这种变量串拆成归一化的条目数组（去注释 / 去空白 / 转小写） */
function normVarList(s) {
  return String(s)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(';')
    .map(x => x.replace(/\s+/g, '').toLowerCase())
    .filter(Boolean);
}

function run(targets, opts) {
  const files = [];
  targets.forEach(t => walk(t, files));
  const code = files.filter(isCode)
    .filter(f => !EXEMPT_FILE.test(path.basename(f)))   // ★ 只对 basename 判，见上方注释
    .filter(f => !BACKUP_FILE.test(path.basename(f)));
  const hits = [];
  const errs = [];
  const blocks = [];
  code.forEach(f => {
    try {
      const r = scan(f);
      r.hits.forEach(h => hits.push(h));
      r.blocks.forEach(b => blocks.push({ file: f, id: b.id, body: b.body }));
    } catch (e) {
      /* ★ 这里原来是 `catch (e) {}` —— 静默吞异常。
         ⇒ 「文件读不了」或「生成块不配对」都会让该文件被判成"0 处裸色值"⇒ 假绿。
         改成收集成 errs 并参与 FAIL 判定。 */
      errs.push({ file: f, msg: String((e && e.message) || e) });
    }
  });

  let contrastReport = null;
  const themeSync = [];
  try {
    global.window = global;
    require(path.join(__dirname, 'themes.js'));
    const TH = global.THEMES;
    if (!opts.noContrast) contrastReport = Object.keys(TH.T).map(id => TH.audit(id));
    /* ★ 真源同步判据：生成块里的**每一条**都必须能在 THEMES.vars(id) 里逐字找到。
       单向即可抓「块过期」——真源把 --g3 改成新值后，块里留着的旧值就不在新真源里 ⇒ FAIL。 */
    blocks.forEach(b => {
      if (!TH.T[b.id]) {
        themeSync.push({ file: b.file, id: b.id, level: 'FAIL',
          msg: '真源里没有主题 "' + b.id + '"（可选：' + Object.keys(TH.T).join(' / ') + '）' });
        return;
      }
      const src = new Set(normVarList(TH.vars(b.id)));
      const mine = normVarList(b.body);
      const bad = mine.filter(p => !src.has(p));
      themeSync.push({
        file: b.file, id: b.id, level: bad.length ? 'FAIL' : 'OK',
        msg: bad.length
          ? bad.length + ' / ' + mine.length + ' 条不在真源里：' + bad.slice(0, 5).join('  ')
          : mine.length + ' 条逐字与真源一致',
      });
    });
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (!opts.noContrast) contrastReport = [{ error: msg }];
    themeSync.push({ file: '—', id: '—', level: 'FAIL', msg: '真源 themes.js 加载失败：' + msg });
  }

  return { scanned: code.length, hits, errs,
           blocks: blocks.map(b => ({ file: b.file, id: b.id })),
           themeSync, contrastReport };
}

// --- CLI -------------------------------------------------------------------
const args = process.argv.slice(2);
const opts = { json: args.includes('--json'), noContrast: args.includes('--no-contrast') };
const targets = args.filter(a => !a.startsWith('--'));
if (!targets.length) targets.push(process.cwd());

const r = run(targets, opts);

if (opts.json) { console.log(JSON.stringify(r, null, 2)); }
else {
  console.log('================================================================================');
  console.log(' Theme Pack 门禁  |  扫描 ' + r.scanned + ' 个代码文件');
  console.log('================================================================================');
  if (!r.hits.length) {
    console.log('[PASS]  裸色值      0 处（业务代码里没有写死的 #rrggbb / rgb()）');
  } else {
    console.log('[FAIL]  裸色值      ' + r.hits.length + ' 处 —— 改用 var(--c-*)，或行尾加 // allow-color');
    console.log('------------------------------------------------------------------------------------');
    r.hits.slice(0, 60).forEach(h => {
      console.log('  ' + h.file + ':' + h.line + '  ' + h.kind + '  ' + h.val);
    });
    if (r.hits.length > 60) console.log('  … 另有 ' + (r.hits.length - 60) + ' 处');
  }
  if (r.errs && r.errs.length) {
    console.log('------------------------------------------------------------------------------------');
    console.log('[FAIL]  扫描异常    ' + r.errs.length + ' 个文件没能扫（原来这里被 catch 静默吞掉）');
    r.errs.forEach(e => console.log('  ' + e.file + '  ' + e.msg));
  }
  if (r.themeSync && r.themeSync.length) {
    console.log('------------------------------------------------------------------------------------');
    console.log(' 真源同步（kit/themes.js 的 vars()   vs   页面 @theme-begin 块）');
    r.themeSync.forEach(s => {
      console.log((s.level === 'FAIL' ? '[FAIL]' : '[PASS]') + '  ' + s.id + '  ' + s.msg);
    });
  }
  if (r.contrastReport) {
    console.log('------------------------------------------------------------------------------------');
    r.contrastReport.forEach(c => {
      if (c.error) { console.log('[WARN]  对比度      ' + c.error); return; }
      const bad = c.items.filter(i => i.level === 'FAIL');
      console.log((bad.length ? '[FAIL]' : '[PASS]') + '  对比度      ' + c.theme +
        '  ' + c.items.map(i => i.role + ' ' + i.ratio + (i.level === 'FAIL' ? '✗' : '✓')).join(' · '));
    });
  }
  console.log('================================================================================');
}

const fail = r.hits.length > 0 ||
  (r.errs || []).length > 0 ||
  (r.themeSync || []).some(s => s.level === 'FAIL') ||
  (r.contrastReport || []).some(c => c.items && c.items.some(i => i.level === 'FAIL'));
console.log(fail ? 'THEME GATE: FAIL' : 'THEME GATE: PASS');
process.exit(fail ? 1 : 0);
