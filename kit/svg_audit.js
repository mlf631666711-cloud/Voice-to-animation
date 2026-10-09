#!/usr/bin/env node
/* svg_audit.js —— SVG 素材验收器（制片用）
 * =====================================================================
 * 验收判据（S1~S6）：
 *   S1 有 viewBox 且无 width/height        S2 颜色全 var(--c-*, fallback) 双写，零裸 hex
 *   S3 无外部引用                          S4 无 id=
 *   S5 无 CSS animation                    S6 用到的变量都在 10 色调色板白名单内
 *
 * 用法：
 *   node kit/svg_audit.js <file.svg>
 *   node kit/svg_audit.js <目录>          # 递归找 *.svg
 *
 * 退出码：0 全 PASS / 1 有 FAIL / 2 参数或环境错
 *
 * ★ 两条自设纪律（审计loop §J）：
 *   - 打印「我验了谁」（路径 + 字节 + md5），不静默吞参数
 *   - 每条判据都要能因真实缺陷变 FAIL —— 别写成恒真
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---- 调色板白名单（与 svg-draw.js 的 C 表一一对应） ---- */
const PALETTE = [
  '--c-ink', '--c-ink-2', '--c-line', '--c-line-2', '--c-a1', '--c-a2',
  '--c-a3', '--c-paper', '--c-paper-ink', '--c-soft',
];

/* ---- 单条判据的返回格式 ---- */
function J(id, name, pass, detail) { return { id, name, pass, detail }; }

function auditOne(src) {
  const out = [];

  /* S1 ---- viewBox 存在，且 <svg> 标签上无 width/height ---- */
  const svgTag = (src.match(/<svg\b[^>]*>/i) || [''])[0];
  const hasVB = /\bviewBox\s*=\s*["'][^"']+["']/.test(svgTag);
  const whM = svgTag.match(/\b(width|height)\s*=\s*["'][^"']*["']/gi) || [];
  out.push(J('S1', 'viewBox 且无 width/height', hasVB && whM.length === 0,
    !svgTag ? '找不到 <svg> 标签'
      : (hasVB ? '' : '缺 viewBox') + (whM.length ? (hasVB ? '；' : '；') + '多写了 ' + whM.join(' ') : '') ||
        'viewBox=' + (svgTag.match(/viewBox\s*=\s*["']([^"']+)/) || [])[1]));

  /* 预处理：剔掉「合法的 var fallback」与「url(#id)」，避免误报 */
  const stripped = src
    .replace(/var\(\s*--[\w-]+\s*,\s*[^)]*\)/g, 'VAR')
    .replace(/url\(#[^)]*\)/g, 'URLID');

  /* S2 ---- 零裸 hex / 零裸颜色函数 ---- */
  const hexes = stripped.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  const fns = stripped.match(/\b(?:rgb|rgba|hsl|hsla)\s*\(/g) || [];
  const bare = hexes.concat(fns);
  out.push(J('S2', '零裸颜色（全 var 双写）', bare.length === 0,
    bare.length ? '裸色 ' + bare.length + ' 处：' + bare.slice(0, 6).join(' ') : '全部走 var(--c-*, fallback)'));

  /* S3 ---- 无外部引用 ---- */
  const ext = [];
  if (/\bxlink:href\s*=/.test(src)) ext.push('xlink:href');
  if (/\bhref\s*=/.test(src) && !/url\(#/.test(src)) ext.push('href');
  if (/<image\b/i.test(src)) ext.push('<image>');
  if (/<script\b/i.test(src)) ext.push('<script>');
  if (/@import\b/.test(src)) ext.push('@import');
  if (/url\(\s*["']?https?:/i.test(src)) ext.push('url(http…)');
  out.push(J('S3', '无外部引用（离线铁律）', ext.length === 0,
    ext.length ? '发现 ' + ext.join(' ') : '自包含'));

  /* S4 ---- 无 id= ---- */
  const ids = src.match(/\bid\s*=\s*["'][^"']*["']/g) || [];
  out.push(J('S4', '无 id=（防内联撞车）', ids.length === 0,
    ids.length ? ids.length + ' 处：' + ids.slice(0, 4).join(' ') : '干净'));

  /* S5 ---- 无 CSS animation ---- */
  const anim = [];
  if (/<animate|<animateTransform|<animateMotion|<set\b/i.test(src)) anim.push('<animate*>');
  if (/@keyframes\b/i.test(src)) anim.push('@keyframes');
  if (/(^|[\s;{])animation(-name|-duration|-delay)?\s*:/i.test(src)) anim.push('animation:');
  if (/\btransition\s*:/i.test(src)) anim.push('transition:');
  out.push(J('S5', '无 CSS animation/transition', anim.length === 0,
    anim.length ? '发现 ' + anim.join(' ') + '（动效必须由 __frame(t) 驱动）' : '纯静态'));

  /* S6 ---- 用到的变量都在白名单内 ---- */
  const used = [...new Set((src.match(/var\(\s*--c-[\w-]+/g) || [])
    .map(s => s.replace(/var\(\s*/, '').trim()))];
  const bad = used.filter(v => PALETTE.indexOf(v) < 0);
  out.push(J('S6', '只用 10 色调色板', bad.length === 0,
    bad.length ? '越界变量 ' + bad.join(' ') : (used.length ? '用到 ' + used.length + ' 个：' + used.join(' ') : '本图未用主题色')));

  return out;
}

/* ---- 收集目标文件 ---- */
function collect(target) {
  const st = fs.statSync(target);
  if (st.isFile()) return [target];
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.svg$/i.test(e.name)) out.push(p);
    }
  })(target);
  return out;
}

/* ---- 主体 ---- */
const args = process.argv.slice(2).filter(a => a !== '--quiet');
const target = args[0];
if (!target) { console.error('用法：node kit/svg_audit.js <file.svg | 目录>'); process.exit(2); }
if (!fs.existsSync(target)) { console.error('!! 目标不存在：' + target); process.exit(2); }

const files = collect(target);
if (!files.length) { console.error('!! 没找到 .svg 文件：' + target); process.exit(2); }

console.log('svg_audit —— 验的对象：' + path.resolve(target) + '（' + files.length + ' 个 .svg）\n');

const byJ = {};      /* 判据 → {pass, fail} 汇总 */
let badFiles = 0;

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const md5 = crypto.createHash('md5').update(src).digest('hex').slice(0, 8);
  const rows = auditOne(src);
  const fails = rows.filter(r => !r.pass);

  const tag = fails.length ? '✗ FAIL' : '✓ PASS';
  console.log('── ' + path.basename(f) + '  [' + tag + ']  ' + src.length + 'B  md5:' + md5);
  for (const r of rows) {
    byJ[r.id] = byJ[r.id] || { pass: 0, fail: 0 };
    byJ[r.id][r.pass ? 'pass' : 'fail']++;
    if (!r.pass) console.log('     ✗ ' + r.id + ' ' + r.name + '  →  ' + r.detail);
  }
  if (!fails.length) console.log('     6 条全过');
  if (fails.length) badFiles++;
}

/* ---- 汇总 ---- */
console.log('\n════ 判据维度汇总 ════');
for (const id of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6']) {
  const v = byJ[id] || { pass: 0, fail: 0 };
  const nm = { S1: 'viewBox 且无 w/h', S2: '零裸颜色', S3: '无外部引用', S4: '无 id', S5: '无 CSS 动效', S6: '调色板白名单' }[id];
  console.log('  ' + id + ' ' + nm.padEnd(18) + ' PASS ' + v.pass + ' / FAIL ' + v.fail);
}

console.log('\n════ 结论：' + files.length + ' 个文件，' + (files.length - badFiles) + ' 过 / ' + badFiles + ' 挂 ════');
console.log('⚠️ 脚本只判「能不能进片子」。构图比例 / 辨识度 / 同批一致性 必须人眼看（验收标准 §一 人眼项）。');
process.exit(badFiles ? 1 : 0);
