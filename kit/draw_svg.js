#!/usr/bin/env node
/**
 * draw_svg.js —— SVG 自绘脚手架 CLI
 *
 * 缺素材时自己画，不用上网找（省版权风险，也保证风格跟同批素材一致）。
 *
 * 用法：
 *   node kit/draw_svg.js list                      # 列出全部可用图案
 *   node kit/draw_svg.js chip --out chip.svg
 *   node kit/draw_svg.js meter-water --size 400 --out water.svg
 *   node kit/draw_svg.js star-topo --opt '{"nodes":8}' --out topo.svg
 *   node kit/draw_svg.js all --out-dir <目录>       # 一次导出全部
 *   node kit/draw_svg.js gallery --out gallery.html # 生成单文件预览画廊
 */
'use strict';
const fs = require('fs');
const path = require('path');
const D = require('./svg-draw.js');

const argv = process.argv.slice(2);
function flag(name, dflt) {
  const i = argv.indexOf('--' + name);
  return i > -1 ? (argv[i + 1] || '') : dflt;
}
const cmd = argv[0] || 'list';

// --- list -------------------------------------------------------------------
if (cmd === 'list') {
  console.log('可用图案 ' + D.names().length + ' 个：\n');
  D.names().forEach(n => console.log('  ' + n.padEnd(16) + D.note(n)));
  console.log('\n用法: node kit/draw_svg.js <name> --out <file.svg> [--size 400] [--opt \'{"k":v}\']');
  process.exit(0);
}

// --- all --------------------------------------------------------------------
if (cmd === 'all') {
  const dir = flag('out-dir', '');
  if (!dir) { console.error('需要 --out-dir <目录>'); process.exit(1); }
  fs.mkdirSync(dir, { recursive: true });
  D.names().forEach(n => {
    fs.writeFileSync(path.join(dir, n + '.svg'), D.draw(n, { size: +flag('size', 400) }), 'utf8');
  });
  console.log('已导出 ' + D.names().length + ' 个到 ' + dir);
  process.exit(0);
}

// --- gallery ----------------------------------------------------------------
if (cmd === 'gallery') {
  const out = flag('out', 'svg-gallery.html');
  const cells = D.names().map(n =>
    '<div class="cell"><div class="cv">' + D.draw(n, { size: 400 }) + '</div>' +
    '<div class="nm">' + n + '</div><div class="nt">' + D.note(n) + '</div></div>').join('\n');
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>SVG 自绘素材画廊</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0B1220;color:#E6EDF7;font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;padding:28px}
h1{font-size:22px;font-weight:600;margin-bottom:4px}
.sub{color:#8FA3BF;font-size:13px;margin-bottom:22px}
.wrap{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:16px}
.cell{background:#131C2E;border:1px solid rgba(180,220,255,.12);border-radius:12px;padding:14px;text-align:center}
.cv{background:#0A0F1E;border-radius:8px;padding:10px;margin-bottom:10px}
.cv svg{display:block;width:100%;height:auto}
.nm{font-size:14px;font-weight:600;color:#00E5D4}
.nt{font-size:11px;color:#8FA3BF;margin-top:5px;line-height:1.5}
</style></head><body>
<h1>SVG 自绘素材画廊</h1>
<div class="sub">共 ${D.names().length} 个图案 · 由 kit/svg-draw.js 生成 · 颜色走 var() 双写，单独打开用 fallback</div>
<div class="wrap">\n${cells}\n</div></body></html>`;
  fs.writeFileSync(out, html, 'utf8');
  console.log('画廊已生成 ' + out + '  (' + D.names().length + ' 个图案)');
  process.exit(0);
}

// --- 单个 --------------------------------------------------------------------
let opts = { size: +flag('size', 400) };
const optRaw = flag('opt', '');
if (optRaw) { try { Object.assign(opts, JSON.parse(optRaw)); } catch (e) { console.error('--opt 必须是合法 JSON'); process.exit(1); } }
if (flag('w', '')) opts.w = +flag('w');
if (flag('h', '')) opts.h = +flag('h');

let out;
try { out = D.draw(cmd, opts); } catch (e) { console.error('❌ ' + e.message); process.exit(1); }

const f = flag('out', '');
if (f) { fs.writeFileSync(f, out, 'utf8'); console.log('已写出 ' + f + '  (' + out.length + ' B) — ' + D.note(cmd)); }
else console.log(out);
