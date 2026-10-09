#!/usr/bin/env node
/**
 * theme_inject.cjs —— 把 kit/themes.js 的真源色板注入到页面
 *
 * 这是「单一真源」的**落地器**：真源改了 → 跑一次它 → 页面里的生成块刷新。
 * 它存在的理由（铁律 324）：
 *   把色板收敛成一处之后，还需要一个**唯一的写入口**。否则改真源之后，
 *   页面里那份副本靠人手动同步 —— 那就是换个地方继续漂。
 *
 * 页面侧约定（生成块必须有成对标记，check_theme.js 会校验）：
 *
 *     :root{
 *     /* @theme-begin c5-tiny *​/
 *       --bg0:#050507; --bg0-rgb:5,5,7; …
 *     /* @theme-end *​/
 *     }
 *
 * 用法：
 *   node kit/theme_inject.cjs --theme c5-tiny --target <file.html>        # 注入/刷新
 *   node kit/theme_inject.cjs --theme c5-tiny --target <file.html> --check # 只查是否最新
 *   node kit/theme_inject.cjs --theme c5-tiny --target <file.html> --dry   # 只打印不写
 *
 * 退出码：0 成功 / 1 失败（--check 时"不是最新"也算失败）
 *
 * ⚠️ 行尾：按目标文件原有行尾写回（CRLF 保持 CRLF、LF 保持 LF）——
 *    本工作区踩过「纯 LF 文档被静默转 CRLF」的坑，且 `grep -c $'\r$'` 在本机判行尾恒真，
 *    所以这里一律走**二进制字节计数**。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const KIT = __dirname;

// ---- 参数 ----
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? (process.argv[i + 1] || true) : def;
}
const THEME = arg('theme', 'c5-tiny');
const TARGET = arg('target', null);
const CHECK = process.argv.includes('--check');
const DRY = process.argv.includes('--dry');

if (!TARGET) {
  console.error('用法: node kit/theme_inject.cjs --theme c5-tiny --target <file.html> [--check|--dry]');
  process.exit(1);
}

// ---- 载入真源 ----
global.window = global;
require(path.join(KIT, 'themes.js'));
const TH = global.THEMES;
if (!TH.T[THEME]) {
  console.error('!! 真源里没有主题 "' + THEME + '"，可选：' + Object.keys(TH.T).join(' / '));
  process.exit(1);
}

/**
 * 把 `--a:1;--b:2` 格式化成便于阅读的分组多行块。
 * 分组是为了让 diff 好看：改了金色只会动金色的那几行。
 * ⚠️ 分隔符一律用 `; ` —— 与 check_theme.js 的 normVarList 约定一致（按 `;` 拆分再归一）。
 */
function format(varsStr) {
  const pairs = varsStr.split(';').map(s => s.trim()).filter(Boolean);
  const groups = [
    ['背景 3 档（中性黑）', /^--bg\d/],
    ['金属金 6 阶 + 派生渐变', /^--(g\d|gold-)/],
    ['文字 2 档', /^--t\d/],
    ['状态色（失败 / 成功）', /^--(warn|ok)/],
    ['像素风灰阶 4 档', /^--px-(k|b|d|s)$/],
    ['角色专用 5 色', /^--h-/],
    ['字体 / 形状', /^--(han|mono|px-font|cut)$/],
  ];
  const used = new Set();
  const lines = [];
  groups.forEach(([label, re]) => {
    const hit = pairs.filter(p => re.test(p.split(':')[0]));
    if (!hit.length) return;
    hit.forEach(p => used.add(p));
    lines.push('  /* ' + label + ' */');
    lines.push('  ' + hit.join('; ') + ';');
  });
  const rest = pairs.filter(p => !used.has(p));
  if (rest.length) {
    lines.push('  /* 其他 */');
    lines.push('  ' + rest.join('; ') + ';');
  }
  return lines.join('\n');
}

const BODY = format(TH.vars(THEME));
const BEGIN = '/* @theme-begin ' + THEME + ' */';
const END = '/* @theme-end */';
const BLOCK =
  '/* @theme-begin ' + THEME + ' —— 由 kit/theme_inject.cjs 从 kit/themes.js 生成，禁手改 */\n' +
  BODY + '\n' +
  END;

// ---- 读目标（二进制，自行处理行尾） ----
const raw = fs.readFileSync(TARGET);
const crlf = (raw.toString('binary').match(/\r\n/g) || []).length;
const nl = (raw.toString('binary').match(/\n/g) || []).length;
const keepCRLF = crlf > 0 && crlf === nl;
let txt = raw.toString('utf8');

const RE = /\/\*\s*@theme-begin\s+([\w-]+)[\s\S]*?@theme-end\s*\*\//g;
const found = [...txt.matchAll(RE)];

let next, how;
if (found.length === 1 && found[0][1] === THEME) {
  next = txt.replace(RE, BLOCK);
  how = '刷新既有生成块';
} else if (found.length === 0) {
  // 首次：插到第一个 `:root{` 之后
  const i = txt.indexOf(':root{');
  if (i < 0) {
    console.error('!! 目标里既没有 @theme-begin 标记，也没有 `:root{` —— 无法定位插入点');
    process.exit(1);
  }
  const at = i + ':root{'.length;
  next = txt.slice(0, at) + '\n' + BLOCK + txt.slice(at);
  how = '首次插入（在第一个 :root{ 之后）';
} else {
  console.error('!! 目标里已有 ' + found.length + ' 个生成块（id: ' +
    found.map(m => m[1]).join(',') + '），或 id 与 --theme 不符 —— 拒绝自动改，请先人工确认');
  process.exit(1);
}

// ---- --check / --dry ----
if (CHECK) {
  /* ⚠️ 比较前必须把行尾归一 —— BLOCK 内部用 `\n`，而 CRLF 文件读出来是 `\r\n`，
     直接 `next === txt` 对 CRLF 文件**永远为假** ⇒ 刚注入完也会报"不是最新"（假 FAIL）。
     本轮踩过：L2(LF) PASS、L3(CRLF) FAIL，同一个生成块。 */
  const norm = s => s.replace(/\r\n/g, '\n');
  const same = norm(next) === norm(txt);
  console.log((same ? '[PASS]' : '[FAIL]') + ' ' + TARGET + '  ' +
    (same ? '生成块与真源一致' : '生成块**不是**最新 —— 跑一次不带 --check 的注入'));
  process.exit(same ? 0 : 1);
}
if (DRY) {
  console.log('---- ' + how + ' · ' + THEME + ' ----');
  console.log(BLOCK);
  process.exit(0);
}

// ---- 写回（保持原行尾） ----
let out = next;
if (!keepCRLF) out = out.replace(/\r\n/g, '\n');
else out = out.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
const buf = Buffer.from(out, 'utf8');
fs.writeFileSync(TARGET, buf);

// ---- 回读断言 ----
const back = fs.readFileSync(TARGET, 'utf8');
if (back !== out) { console.error('!! 回读与写入不一致'); process.exit(1); }
const bcrlf = (back.match(/\r\n/g) || []).length;
const bnl = (back.match(/\n/g) || []).length;
const okEol = keepCRLF ? (bcrlf === bnl) : (bcrlf === 0);
if (!okEol) { console.error('!! 行尾被污染：期望 ' + (keepCRLF ? 'CRLF' : 'LF') +
  '，实得 CRLF=' + bcrlf + ' LF=' + bnl); process.exit(1); }
// ⚠️ 断言只认「标记本身」，不要拿精确串去 includes ——
//    块首行实际是「@theme-begin <id> + 破折号 + 生成说明 + 注释收尾」，
//    精确串永远匹配不上，会变成"写成功了却报失败"（本轮踩过：文件已正确写入，进程却 exit 1）。
if (!new RegExp('@theme-begin\\s+' + THEME).test(back) || !back.includes('@theme-end')) {
  console.error('!! 回读缺标记'); process.exit(1);
}

console.log('[OK] ' + how + '  theme=' + THEME);
console.log('     ' + TARGET);
console.log('     ' + raw.length + ' B -> ' + buf.length + ' B   行尾=' + (keepCRLF ? 'CRLF' : 'LF') +
            '   变量 ' + TH.vars(THEME).split(';').filter(Boolean).length + ' 条');
