#!/usr/bin/env node
/**
 * check_runtime.js —— 单文件 HTML 动效工程的「运行时公式」静态门禁
 *
 * 为什么需要它（与 check_wording.js 的分工）：
 *   check_wording.js  查**描述词层**（分镜表 anim 字段：Purpose / 时长 / 曲线 / 错峰 / 过冲）
 *   本脚本            查**实现层**（fx_*.html 里的 JS 公式）—— 描述词写得完美，代码里照样翻车，
 *                     而且**探针不报错、脚本不崩、肉眼却看不到**（L10 第二段 139 帧抓出 3 条）。
 *
 * 四条规则（来源：BUG-2055 / 2056 / 2058）：
 *   R1 FREQ  Math.sin/cos(t*k) 折算 Hz 必须 < fps/2（30fps → <15Hz），否则**混叠**
 *   R2 FREQ  10Hz ≤ f < fps/2 → WARN（贴奈奎斯特，只允许存在 ≤0.15s）
 *   R3 GATE  「振幅 × (1 − progress)^n」形状的公式缺 gate／缺往返 → WARN
 *   R4 INSET clip-path 用**百分比**构建 → WARN（容器 ≠ 内容时有空行程，生长会瞬现）
 *
 * 用法：
 *   node kit/check_runtime.js <fx_*.html | 工程目录>
 *   node kit/check_runtime.js <...> --fps 25 --warn      # --warn 让 WARN 也计入退出码
 *   node kit/check_runtime.js <...> --json
 *
 * 退出码：0 通过 / 1 有 FAIL（--warn 时含 WARN）/ 2 参数或读取错
 */

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const STRICT = argv.includes('--warn');
const AS_JSON = argv.includes('--json');
const argOf = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const FPS = Number(argOf('fps', 30));
const NYQ = FPS / 2;                       // 奈奎斯特
const K_MAX = NYQ * 2 * Math.PI;           // 无 TAU 写法时的 k 上限（30fps → 47.1）
const NEAR = 10;                           // 贴奈奎斯特告警线（Hz）

// ---------- 目标解析 ----------
function resolveTarget(a) {
  if (!a) { console.error('用法：node kit/check_runtime.js <fx_*.html|工程目录> [--fps 30] [--warn] [--json]'); process.exit(2); }
  const p = path.resolve(a);
  if (!fs.existsSync(p)) { console.error('找不到：' + p); process.exit(2); }
  if (fs.statSync(p).isFile()) return p;
  const cand = fs.readdirSync(p).filter(f => /^fx_.*\.html$/i.test(f));
  if (!cand.length) { console.error('目录里没有 fx_*.html：' + p); process.exit(2); }
  if (cand.length > 1) console.error('⚠ 目录里有多个 fx_*.html，取第一个：' + cand[0] + '（共 ' + cand.length + ' 个）');
  return path.join(p, cand[0]);
}

// ---------- 剥注释（保持行号不变：用等长空白替换）----------
// 不剥注释的话，注释里举例的**错误写法**会被当成真代码报出来（全是噪音）。
function stripComments(src) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  let out = src.replace(/<!--[\s\S]*?-->/g, blank);     // HTML 注释
  out = out.replace(/\/\*[\s\S]*?\*\//g, blank);        // /* ... */（含多行）
  out = out.replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)));
  return out;
}

// ---------- 语句切分（用于定位「这一行有没有 gate」）----------
function splitStatements(src) {
  // 按 ; 和换行切，保留原始行号
  const out = [];
  let buf = '', line = 1, startLine = 1;
  for (const ch of src) {
    if (ch === '\n') {
      if (buf.trim()) out.push({ text: buf, line: startLine });
      buf = ''; line++; startLine = line;
    } else if (ch === ';') {
      buf += ch;
      if (buf.trim()) out.push({ text: buf, line: startLine });
      buf = ''; startLine = line;
    } else {
      if (!buf.trim() && ch.trim()) startLine = line;
      buf += ch;
    }
  }
  if (buf.trim()) out.push({ text: buf, line: startLine });
  return out;
}

// ---------- R1/R2：sin/cos 频率 ----------
// Hz = Π(数值因子) × (含 TAU ? 1 : 1/2π)
function hzOfArg(arg) {
  const m = /^t\s*\*\s*([^*+)\-]+(?:\*\s*[^*+)\-]+)*)/.exec(arg.trim());
  if (!m) return null;
  const chain = m[1];
  if (!/(^|\*)\s*t\b/.test('t*' + chain)) { /* noop */ }
  const parts = chain.split('*').map(s => s.trim()).filter(Boolean);
  let prod = 1, hasTAU = false, ok = false;
  for (const p of parts) {
    if (/^TAU$/.test(p)) { hasTAU = true; continue; }
    if (/^[\d.]+$/.test(p)) { prod *= Number(p); ok = true; continue; }
    if (/^(t|t2)$/.test(p)) continue;
    return null;                       // 出现不认识的因子（变量）→ 交给人看，不误报
  }
  if (!ok) return null;
  return hasTAU ? prod : prod / (2 * Math.PI);
}

function checkFreq(stmts, add) {
  const re = /Math\.(sin|cos)\s*\(\s*([^()]*)\)/g;
  for (const st of stmts) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(st.text))) {
      const arg = m[2];
      const hz = hzOfArg(arg);
      if (hz === null) continue;
      const label = arg.trim();
      if (hz >= NYQ) {
        add('FAIL', st.line, 'R1 频率混叠：Math.' + m[1] + '(' + label + ') = ' +
          hz.toFixed(1) + 'Hz ≥ 奈奎斯特 ' + NYQ + 'Hz（' + FPS + 'fps）→ 每帧相位跳 ' +
          (hz / FPS).toFixed(2) + ' 个周期，会混叠成假频率。改成 <' + NYQ + 'Hz，' +
          '或（冲击类）把该抖动限制在 ≤0.15s');
      } else if (hz >= NEAR) {
        add('WARN', st.line, 'R2 贴奈奎斯特：Math.' + m[1] + '(' + label + ') = ' +
          hz.toFixed(1) + 'Hz，距离 ' + NYQ + 'Hz 太近 → 只允许存在 ≤0.15s 的冲击抖动，' +
          '常规底噪请压到 8~10Hz 以下');
      }
    }
  }
}

// ---------- R3：振幅 × (1 − progress)^n 缺 gate / 缺往返 ----------
// ⚠️ 括号里必须是**标识符**（变量），不能是字面常量 —— 否则 `0.70*(1-0.5)` 这种
//    纯算术会被误报成"缺 gate"。
const ID = '[A-Za-z_$][\\w$]*';
const AMP_SHAPES = [
  new RegExp('[\\d.]+\\s*\\*\\s*Math\\.pow\\s*\\(\\s*1\\s*-\\s*' + ID),        // 6.5*Math.pow(1-shk,2)
  new RegExp('[\\d.]+\\s*\\*\\s*\\(\\s*1\\s*-\\s*' + ID),                      // 0.70*(1-k1)
  new RegExp('\\(\\s*1\\s*-\\s*' + ID + '\\s*\\)\\s*\\*\\s*\\(\\s*1\\s*-\\s*' + ID),  // (1-k)*(1-k)
];
const RAMP_SHAPE = new RegExp('=\\s*1\\s*[-+]\\s*[\\d.]+\\s*\\*\\s*' + ID);   // x = 1 - 0.026*chgE
const GATE_KW = /seg\s*\(|\b(?:alive|gate|win|envelope|envOn)\b/;

function checkGate(stmts, add) {
  for (const st of stmts) {
    const t = st.text;
    const ampShape = AMP_SHAPES.some(re => re.test(t));
    const rampShape = RAMP_SHAPE.test(t);
    if (!ampShape && !rampShape) continue;

    const gated = GATE_KW.test(t);
    // 往返 = 该表达式里还有第二个「带符号的 数值*变量」项
    const signedTerms = (t.match(/[-+]\s*[\d.]+\s*\*\s*[A-Za-z_$]/g) || []).length;
    if (gated || signedTerms >= 2) continue;

    if (ampShape) {
      add('WARN', st.line, 'R3 疑似缺 gate：振幅型公式「数值 × (1 − progress)^n」没有显式闸门。' +
        '若该量在区间外应恒为 0，必须乘 `alive = seg(t, t0, t0+ε)`，否则区间外是**满幅**的（BUG-2055）。' +
        '  →  ' + t.trim().slice(0, 110));
    } else {
      add('WARN', st.line, 'R3 疑似单向斜坡：`1 ± 数值 × eased` 只有一个方向、没有往返项。' +
        '区间结束后这个值不会回到 1 → 元素永久偏移（缩放/位移类须走「内收 → 外爆 → 回落 1.0000」，BUG-2056）。' +
        '  →  ' + t.trim().slice(0, 110));
    }
  }
}

// ---------- R4：百分比 clip-path ----------
const INSET_MSG = (txt) =>
  'R4 百分比 inset：`clip-path: inset(...%)` 切的是**容器**不是**内容** —— ' +
  '容器比内容大多少就有多少「空行程」，而 cubic-out 前段速度最快 → 空跑掉最陡的一段，' +
  '生长会在一两帧内完成（肉眼瞬现，BUG-2058）。确认容器 ≈ 内容，否则改用**像素**映射。' +
  '  →  ' + txt.trim().slice(0, 110);

// JS 侧：`.clipPath = 'inset(' + (...) + '% ...)'` —— 字符串拼接的 `%` 不在第一个字面量里，
// 所以必须按**整条语句**判（`inset(` 与 `%` 同现即命中），不能只看一个字符串。
function checkInsetJs(stmts, add) {
  for (const st of stmts) {
    if (!/\.clipPath\s*=/.test(st.text)) continue;
    if (!/inset\s*\(/.test(st.text)) continue;
    if (!/%/.test(st.text)) continue;
    add('WARN', st.line, INSET_MSG(st.text));
  }
}
// CSS 侧：样式块里的 `clip-path: inset(...%)`
function checkInsetCss(src, add) {
  src.split('\n').forEach((ln, i) => {
    if (!/clip-path\s*:\s*inset\s*\([^;{}]*%/.test(ln)) return;
    add('WARN', i + 1, INSET_MSG(ln));
  });
}

// ---------- 主流程 ----------
const target = resolveTarget(argv.find(a => !a.startsWith('--')));
const raw = fs.readFileSync(target, 'utf8');

// 取所有 <script> 块（保留起止行号，便于报准确位置）
const scriptBlocks = [];
{
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(raw))) {
    const before = raw.slice(0, m.index);
    const startLine = before.split('\n').length + (m[0].match(/\n/g) || []).length - (m[1].match(/\n/g) || []).length;
    scriptBlocks.push({ code: m[1], startLine: startLine - 1 });
  }
}
if (!scriptBlocks.length) {
  console.error('⚠ 没找到 <script> 块：' + target);
}

const issues = [];
const add = (level, line, msg) => issues.push({ level, line, msg });

for (const blk of scriptBlocks) {
  const stmts = splitStatements(stripComments(blk.code)).map(s => ({ ...s, line: s.line + blk.startLine }));
  checkFreq(stmts, add);
  checkGate(stmts, add);
  checkInsetJs(stmts, add);
}
checkInsetCss(stripComments(raw), add);

// ---------- 输出 ----------
const fails = issues.filter(i => i.level === 'FAIL');
const warns = issues.filter(i => i.level === 'WARN');

if (AS_JSON) {
  console.log(JSON.stringify({ target, fps: FPS, fails, warns }, null, 2));
} else {
  const L = [];
  L.push('');
  L.push('运行时公式门禁 · ' + path.basename(target) + '   (fps=' + FPS + '  奈奎斯特=' + NYQ + 'Hz  k上限=' + K_MAX.toFixed(1) + ')');
  L.push('='.repeat(72));
  if (!issues.length) {
    L.push(' ✅ 全过 —— 没有频率混叠 / gate 缺失 / 百分比 inset');
  } else {
    const sorted = [...issues].sort((a, b) => a.line - b.line);
    for (const it of sorted) {
      L.push(' ' + (it.level === 'FAIL' ? '❌ FAIL' : '⚠  WARN') + '  L' + it.line + '  ' + it.msg);
    }
  }
  L.push('-'.repeat(72));
  L.push(' 合计 ' + issues.length + ' 条：FAIL ' + fails.length + ' / WARN ' + warns.length);
  if (warns.length && !STRICT) L.push(' （WARN 不计入退出码；要严格加 --warn）');
  console.log(L.join('\n'));
}

process.exit(fails.length || (STRICT && warns.length) ? 1 : 0);
