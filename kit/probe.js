#!/usr/bin/env node
/**
 * probe.js —— 探针 CLI（2026-09-11 建立）
 * =====================================================================
 * 目的：把「22 个工程 × 170+ 支一次性探针」里 90% 的审计动作收敛成**一条命令**，
 *       需要写脚本的只剩真正工程专有的那部分。
 *
 * 首参 = 子命令，第二参 = html。html 可以只给工程目录，自动挑唯一的 fx_*.html
 * （顺手治掉「27 支脚本各自硬编码 fx_mingong_l10_range.html」那种漏改）。
 *
 *   node kit/probe.js shots <html|dir> --at 0,0.3,1.35 [--out _shots] [--ss .5]
 *   node kit/probe.js sheet <html|dir> --n 12 [--dur 9.52] [--out _shots]
 *   node kit/probe.js track <html|dir> --sel "#modBox" --from 0 --to 2.6 [--fps 30]
 *   node kit/probe.js rot   <html|dir> --sel "#modBox" --from 0 --to 3.3
 *   node kit/probe.js chain <html|dir> --sel "#tA" --at 0,0.3,0.6
 *   node kit/probe.js rect  <html|dir> --sel "#s3Chip" --at 3,9.4 [--props transform,opacity]
 *   node kit/probe.js css   <html|dir> --sel "#s3Chip" [--props transform,transform-origin]
 *   node kit/probe.js info  <html|dir>
 *   node kit/probe.js const <html|dir> --expr "window.L10"
 *
 * 退出码：0 全通过；1 抓到硬伤（JUMP / 非一圈 / 元素缺失 / 页面报错）；2 用法错。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const P = require('./probe-lib');

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function parseArgv(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.slice(0, 2) === '--') {
      const k = a.slice(2);
      const eq = k.indexOf('=');
      if (eq >= 0) opt[k.slice(0, eq)] = k.slice(eq + 1);
      else if (i + 1 < argv.length && argv[i + 1].slice(0, 2) !== '--') opt[k] = argv[++i];
      else opt[k] = true;
    } else pos.push(a);
  }
  return { pos: pos, opt: opt };
}

/* html 可以给文件，也可以给工程目录 → 自动挑 fx_*.html（唯一才自动，多个就报错列出来） */
function resolveHtml(input) {
  if (!input) throw new Error('缺少 html 参数');
  const abs = path.resolve(input);
  if (!fs.existsSync(abs)) throw new Error('路径不存在 ' + abs);
  if (fs.statSync(abs).isFile()) return abs;
  const cands = fs.readdirSync(abs).filter(function (f) { return /^fx_.*\.html$/i.test(f); });
  if (cands.length === 1) return path.join(abs, cands[0]);
  if (!cands.length) throw new Error('目录内没有 fx_*.html：' + abs);
  throw new Error('目录内有多个 fx_*.html，请直接指定：\n  ' + cands.join('\n  '));
}

function nums(s, dflt) {
  if (!s || s === true) return dflt;
  return String(s).split(',').map(function (x) { return x.trim(); })
    .filter(function (x) { return x !== ''; }).map(Number)
    .filter(function (n) { return isFinite(n); });
}

// ---------------------------------------------------------------------------
// 主
// ---------------------------------------------------------------------------

(async () => {
  const { pos, opt } = parseArgv(process.argv.slice(2));
  const cmd = pos[0];
  if (!cmd || opt.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').replace(/^ ?\*? ?/gm, ''));
    process.exit(cmd ? 0 : 2);
  }

  const html = resolveHtml(pos[1]);
  const head = '[probe] ' + path.relative(process.cwd(), html).replace(/\\/g, '/');
  const p = await P.open(html, {
    w: +opt.w || 1920, h: +opt.h || 1080,
    ss: opt.ss != null ? +opt.ss : (cmd === 'shots' || cmd === 'sheet' ? 0.5 : 1),
    settle: opt.settle != null ? +opt.settle : 400,
  });
  console.log(head + '  ' + p.w + 'x' + p.h + '@' + (opt.ss != null ? opt.ss : (cmd === 'shots' || cmd === 'sheet' ? 0.5 : 1)));
  let bad = 0;

  try {
    if (cmd === 'info') {
      console.log(JSON.stringify(await p.info(), null, 2));

    } else if (cmd === 'shots') {
      const times = nums(opt.at, null);
      if (!times) { console.error('需要 --at 0,0.3,1.35（或改用 sheet）'); process.exit(2); }
      const out = opt.out || path.join(path.dirname(html), '_shots');
      const made = await p.shotMany(times, out, { quality: opt.quality ? +opt.quality : 88 });
      made.forEach(function (m) {
        console.log('  t=' + String(m.t).padEnd(7) + path.relative(process.cwd(), m.file).replace(/\\/g, '/'));
      });
      console.log('DONE ' + made.length + ' 帧 -> ' + out);

    } else if (cmd === 'sheet') {
      const n = +(opt.n || 12);
      const dur = +(opt.dur || 9.52);
      const times = [];
      for (let i = 0; i < n; i++) times.push(+((i + 0.5) * dur / n).toFixed(2));
      const out = opt.out || path.join(path.dirname(html), '_shots');
      const made = await p.shotMany(times, out, { quality: opt.quality ? +opt.quality : 88 });
      console.log('  等距 ' + n + ' 帧 / dur=' + dur + 's -> ' + out);
      made.forEach(function (m) { console.log('    t=' + m.t); });

    } else if (cmd === 'track') {
      if (!opt.sel) { console.error('需要 --sel "#modBox"'); process.exit(2); }
      const rows = await p.track(opt.sel, +opt.from || 0, +opt.to || 1, +opt.fps || 30);
      console.log(P.fmtTrack(rows));
      /* 屏幕瞬移即判失败（不管来自元素还是相机），速度拐点只提示 */
      bad = rows.filter(function (r) { return /JUMP/.test(r.flag); }).length;

    } else if (cmd === 'rot') {
      if (!opt.sel) { console.error('需要 --sel "#modBox"'); process.exit(2); }
      const r = await p.rot(opt.sel, +opt.from || 0, +opt.to || 1, +opt.fps || 30);
      console.log(P.fmtRot(r));
      if (opt.verbose) {
        r.rows.forEach(function (row, i) {
          console.log('   t=' + String(row[0]).padEnd(7) + 'rot=' + String(row[1]).padStart(9) +
            '  展开=' + (r.unwrapped[i] == null ? '-' : r.unwrapped[i].toFixed(1)));
        });
      }
      /* 只有显式给了 --expect-turns 才拿圈数判成败。
         全时段窗口天然含多段（落体+滚动+弹起+过场），净转本就不该是整数圈；
         要判「恰好一圈」必须把窗口裁到单段（--from/--to 配段边界）。 */
      if (opt['expect-turns'] != null) {
        const want = +opt['expect-turns'];
        if (Math.abs(r.turns - want) > 0.02) {
          console.log('  ✗ 期望 ' + want + ' 圈，实测 ' + r.turns + ' 圈');
          bad = 1;
        } else {
          console.log('  ✓ 恰好 ' + want + ' 圈');
        }
      }
      if (r.reversals.length) bad = bad || 0;

    } else if (cmd === 'chain') {
      if (!opt.sel) { console.error('需要 --sel "#tA"'); process.exit(2); }
      const times = nums(opt.at, [0, 0.3]);
      for (const t of times) {
        await p.frame(t);
        const c = await p.chain(opt.sel);
        if (c.missing) { console.log('=== t=' + t + '  元素不存在 ' + opt.sel); bad = 1; continue; }
        const self = await p.rect(opt.sel);
        console.log('=== t=' + t + '  __traceN=' + self.traceN + '  op=' + self.op +
          '  mask(' + self.maskN + ')=' + self.maskHead);
        console.log(P.fmtChain(c));
      }

    } else if (cmd === 'rect' || cmd === 'css') {
      if (!opt.sel) { console.error('需要 --sel'); process.exit(2); }
      const times = nums(opt.at, [0]);
      const props = opt.props ? String(opt.props).split(',').map(function (s) { return s.trim(); }) : null;
      for (const t of times) {
        await p.frame(t);
        const r = await p.rect(opt.sel, props);
        if (r.missing) { console.log('t=' + t + '  元素不存在 ' + opt.sel); bad = 1; continue; }
        console.log('t=' + String(t).padEnd(7) +
          ' 屏心(' + String(r.cx).padStart(8) + ',' + String(r.cy).padStart(8) + ')' +
          ' 尺寸 ' + r.width + 'x' + r.height +
          ' tx/ty=' + r.tx + '/' + r.ty +
          ' rot=' + (r.rot == null ? '-' : r.rot) + '°' +
          ' scale=' + r.sx + '/' + r.sy +
          ' op=' + r.op + (r.filter ? ' filter=' + r.filter : '') +
          ' mask(' + r.maskN + ')' + (r.traceN != null ? ' __traceN=' + r.traceN : ''));
        if (props) props.forEach(function (k) { console.log('     ' + k + ' = ' + r['css_' + k]); });
      }

    } else if (cmd === 'const') {
      if (!opt.expr) { console.error('需要 --expr "window.L10"'); process.exit(2); }
      console.log(JSON.stringify(await p.consts(opt.expr), null, 2));

    } else {
      console.error('未知子命令 ' + cmd);
      process.exit(2);
    }
  } finally {
    if (p.errors.length) {
      console.log('  ⚠ 页面报错 ' + p.errors.length + ' 条：' + p.errors.slice(0, 3).join(' | '));
      bad = bad || 1;
    }
    await p.close();
  }
  process.exit(bad ? 1 : 0);
})().catch(function (e) { console.error('probe:', e.message); process.exit(1); });
