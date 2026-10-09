#!/usr/bin/env node
'use strict';
/**
 * check_env.js —— 环境自检（管线的「第 0 步」）
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 为什么需要它
 * ─────────────────────────────────────────────────────────────────────────
 * `git clone` **只复制文件，不装任何东西** —— 而且本仓库**没有 package.json**，
 * 所以连 `npm install` 都没得跑。别人 clone 完直接开工，必然撞上「缺这缺那」，
 * 而报错点散落在渲染中途、长得又各不相同。
 *
 * 这个脚本的作用：**在开工前一次跑完，缺什么、怎么装，一条条告诉你。**
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 用法
 * ─────────────────────────────────────────────────────────────────────────
 *   node kit/check_env.js              # 正常自检
 *   node kit/check_env.js --no-font    # 跳过中文字体实渲染检测（省 ~2 秒）
 *   node kit/check_env.js --json       # 机器可读（给 CI / 其他脚本消费）
 *   node kit/check_env.js --install         # ★ 只**打印安装计划**（dry，一个字节不改系统）
 *   node kit/check_env.js --install --yes   # ★ 真的替你装（装完自动复检）
 *
 * 退出码：0 = 该装的都装了（可选缺项不影响）；1 = 有必装项缺失；2 = 脚本自身出错
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★ `--install` 的安全边界（为什么它默认不动手）
 * ─────────────────────────────────────────────────────────────────────────
 *   1. **默认永不安装** —— 不带 `--install` 时本脚本只读不写，行为与以前完全一样。
 *   2. `--install` 单独用 = **只出计划**，把「要跑哪条命令、为什么」逐条列出来。
 *      真执行必须再加 `--yes` —— 两步走，避免手快。
 *   3. **只走包管理器**（npm / winget / brew / apt），不手搓下载。
 *      每条命令都是**可审计的明文**，先打印再执行。
 *   4. **三样东西不自动装**，只给指引，理由在计划里逐条写：
 *      · Node.js 本体（升级运行时是系统级动作，改坏了你整台机器都受影响）
 *      · 中文字体（有版权，不是所有字体都允许自动分发；而且体积几百 MB）
 *      · 任何需要 `sudo` 的（非交互环境下会卡死在密码提示上）
 *   5. 装完**重跑一遍全部检查**复验，而不是假定成功 ——
 *      毕竟「命令退出码 0」和「东西真能用了」是两件事。
 *   6. ⚠️ 包管理器装完**当前进程的 PATH 不会自动刷新**，新装的东西可能当场仍报 ❌。
 *      看到「装完了还是红的」先**开个新终端再跑一次**，别急着怀疑没装上。

 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★ 判据纪律（这一条决定了本脚本可不可信）
 * ─────────────────────────────────────────────────────────────────────────
 *   · 每一项都**实测**，不靠"文件在不在"猜 —— ffmpeg 要真的跑 `-version` 出结果，
 *     字体要真的渲染出字形，puppeteer 要真的 `require` 成功（用的就是 render-core
 *     那一份解析器，所以「自检说能找到」＝渲染时确实能找到，不会两套判据打架）。
 *   · 字体检查带**负控**：先确认「没字形的字符在本机确实会画成豆腐块」，
 *     再拿汉字跟豆腐块比。负控不成立就报「无法判定」，**不报 PASS**
 *     ——「判据本身失效时不能给绿灯」是这套管线的老账。
 *   · 外部命令一律带超时：Node 内置 fetch / 子进程挂起时可能静默卡死
 *     （Windows 上 `python` 若是商店占位符还会弹窗）。
 *
 * 作者：大狗 🐶（主 Agent）· 2026-10-08
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const KIT = __dirname;
const REPO = path.resolve(KIT, '..');

const ARGV = process.argv.slice(2);
const AS_JSON = ARGV.includes('--json');
const SKIP_FONT = ARGV.includes('--no-font');
const INSTALL = ARGV.includes('--install');
const YES = ARGV.includes('--yes') || ARGV.includes('-y');
const CMD_TIMEOUT = Number(process.env.CHECK_ENV_TIMEOUT_MS || 20000);
// 安装可能要下几十上百 MB（winget 装 Chrome / ffmpeg），给足 10 分钟
const INSTALL_TIMEOUT = Number(process.env.CHECK_ENV_INSTALL_TIMEOUT_MS || 600000);

// ─────────────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────────────

/** 按终端显示宽度补空格（CJK 算 2 列），让输出能对齐 */
function pad(s, w) {
  let n = 0;
  for (const ch of s) {
    n += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  }
  return s + ' '.repeat(Math.max(0, w - n));
}

/** 跑一条外部命令，**带超时**（拿不到结果就返回 ok:false，绝不静默挂起） */
function run(cmd, args) {
  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: CMD_TIMEOUT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return { ok: true, out: String(out) };
  } catch (e) {
    return { ok: false, out: String(e.stdout || '') + String(e.stderr || ''), err: e.message };
  }
}

/** 跑一条命令并取第一行非空输出（ffmpeg / chrome 的版本号都在第一行） */
function firstLine(cmd, args) {
  const r = run(cmd, args);
  const line = r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return line || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 结果收集
// ─────────────────────────────────────────────────────────────────────────────

/** ok: true=通过 / false=失败 / null=跳过（无法判定）
 *  install：可选的**结构化安装动作**（给 `--install` 用；`fix` 是给人看的文本，这个给机器执行）
 *           形如 { how, cmd, args, cwd, label, why, auto:boolean } */
const RESULTS = [];
function rec(id, label, ok, detail, fix, install) {
  RESULTS.push({ id, label, ok, detail: detail || '', fix: fix || null, install: install || null, optional: false });
  return ok;
}

/** 可选依赖（缺了不影响出画面）：不参与退出码，只提示 */
function recOptional(id, label, ok, detail, fix, install) {
  RESULTS.push({ id, label, ok, detail: detail || '', fix: fix || null, install: install || null, optional: true });
  return ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// 安装动作（`--install` 用的那套）
//   · 只描述「怎么装」，不在这里执行 —— 执行统一在 installAll() 里（便于先打印后动手）
//   · auto:false 的动作**不会被自动执行**，但仍会进计划，把「为什么不自动」写清楚
// ─────────────────────────────────────────────────────────────────────────────

const PLAT = process.platform;                       // 'win32' | 'darwin' | 'linux'
const IS_WIN = PLAT === 'win32';
const IS_MAC = PLAT === 'darwin';

/** 命令在不在（用来把「包管理器都没装」的动作降级成 manual，而不是执行时才发现） */
function hasCmd(cmd) {
  const probe = IS_WIN ? 'where' : 'which';
  const r = run(probe, [cmd]);
  if (!r.ok) return false;
  return r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).length > 0;
}

/** 造一条安装动作。默认 = 不自动（要显式 auto:true 才进自动队列） */
function act(o) {
  return Object.assign({ auto: false, how: 'manual', cmd: null, args: [], cwd: null, label: '', why: '' }, o);
}

/** 按平台挑一条包管理器命令；该平台的包管理器不在 ⇒ 自动降级成「人工」并说明原因 */
function byPlat(map, whyManual) {
  const pick = map[PLAT];
  if (!pick) return act({ why: whyManual });
  if (!hasCmd(pick.cmd)) {
    return act({ why: `${pick.cmd} 不在本机 PATH 上 —— 请按上面的「→ 修」手动装` });
  }
  return act(Object.assign({ auto: true }, pick));
}

// ─────────────────────────────────────────────────────────────────────────────
// 检查 ① Node.js
// ─────────────────────────────────────────────────────────────────────────────

const NODE_MIN = 18;
function checkNode() {
  const v = process.versions.node;
  const major = Number(String(v).split('.')[0]);
  rec('node', 'Node.js', major >= NODE_MIN, `v${v}`,
    major >= NODE_MIN ? null
      : `当前 v${v}，需要 ≥ v${NODE_MIN}。\n     winget install OpenJS.NodeJS.LTS   （或 https://nodejs.org 下 LTS）`,
    act({ why: '升级 Node.js 属**系统级动作**（动的是你机器上的运行时）—— 这类改动不替你做，请自己装' }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 检查 ②③④ 依赖解析器准备
//   · env-paths.js 零副作用，**任何情况下都能加载** ⇒ Chrome / ffmpeg 的候选表永远拿得到
//   · render-core.js 一加载就 loadPuppeteer() ⇒ 它的加载成败**本身就等于**「puppeteer 可用吗」
// ─────────────────────────────────────────────────────────────────────────────

let ENVP = null;
let CORE = null;
let CORE_ERR = null;

function loadModules() {
  try {
    ENVP = require(path.join(KIT, 'env-paths.js'));
  } catch (e) {
    console.error('check_env: 连 kit/env-paths.js 都加载不了，仓库可能不完整：', e.message);
    process.exit(2);
  }
  try {
    CORE = require(path.join(KIT, 'render-core.js'));
  } catch (e) {
    CORE_ERR = e; // 绝大多数情况 = puppeteer-core 没装（这正是 ② 要报的事）
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 检查 ② puppeteer-core
// ─────────────────────────────────────────────────────────────────────────────

function checkPuppeteer() {
  if (CORE) {
    const from = CORE.PUPPETEER_FROM || '(未知路径)';
    const isFull = /(^|[\\/])puppeteer$/.test(from) || /puppeteer[\\/]lib/.test(from);
    return rec('puppeteer', 'puppeteer-core', true,
      `已解析 → ${from}${isFull ? '   ⚠️ 这是完整版 puppeteer（自带 Chromium，能用但没必要）' : ''}`);
  }
  const tried = ENVP.puppeteerCandidates().map((c) => `       - ${c}`).join('\n');
  const head = String(CORE_ERR && CORE_ERR.message || CORE_ERR).split('\n').slice(0, 2).join(' ');
  return rec('puppeteer', 'puppeteer-core', false,
    `解析不到，render-core 加载即失败：${head}`,
    `在仓库根目录执行（两个 flag 别省，理由见下）：\n     npm i --no-save --no-package-lock puppeteer-core\n` +
    `     省事的话加 --install --yes，本脚本替你装：\n` +
    `     node kit/check_env.js --install --yes\n` +
    `     已经装过？直接指给它（路径写到 node_modules/puppeteer-core 这一层）：\n` +
    `     RENDER_CORE_PUPPETEER=<绝对路径>\n` +
    `     找过这些地方：\n${tried}`,
    // ★ 仓库唯一的 Node 依赖。用 --no-save --no-package-lock：**不往别人的仓库里塞
    //   package.json / lockfile** —— 本仓库刻意不带 package.json（零构建、全单文件脚本），
    //   不带这两个 flag 会在用户仓库里凭空造一个出来、`git status` 立刻变脏。
    //   ★ 2026-10-09 实测更正：此前这里写「README 那条手动命令照旧，生成也无害」——
    //     错了，它和 README「本仓库没有 package.json」这句承诺直接打架。
    //     现在文档侧（README 中英 / docs 环境与依赖 / SOP 故事地图 / THIRD-PARTY / 各报错文案）
    //     统一用同一条带 flag 的命令。
    act({
      how: 'npm', cmd: IS_WIN ? 'npm.cmd' : 'npm',
      args: ['i', '--no-save', '--no-package-lock', 'puppeteer-core'],
      cwd: REPO, auto: hasCmd(IS_WIN ? 'npm.cmd' : 'npm'),
      label: 'npm i --no-save --no-package-lock puppeteer-core   （在仓库根目录）',
      why: 'npm 不在 PATH 上 —— 先确认 Node.js 装好了（第 ① 项）',
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 检查 ③ Google Chrome
// ─────────────────────────────────────────────────────────────────────────────

function checkChrome() {
  let chrome = null;
  let how = '';
  if (CORE) {
    try {
      chrome = CORE.resolveChrome();
      how = '   ← render-core 解析（与真渲染同一份候选表）';
    } catch (e) { chrome = null; }
  }
  if (!chrome) {
    chrome = ENVP.firstExisting(ENVP.chromeCandidates());
    if (chrome) how = '   ← 候选表命中（puppeteer 未装，少了它的兜底分支）';
  }
  if (!chrome) {
    const tried = ENVP.chromeCandidates().map((c) => `       - ${c}`).join('\n');
    return rec('chrome', 'Google Chrome', false, '找不到可执行文件',
      `装一个（Chromium 内核即可）：\n` +
      `       Windows  winget install Google.Chrome\n` +
      `       macOS    brew install --cask google-chrome\n` +
      `       Linux    https://www.google.com/chrome/ 下 .deb / .rpm\n` +
      `     装好了还认不到（绿色版 / 非标准路径）→ 直接指：\n` +
      `     RENDER_CORE_CHROME=<可执行文件绝对路径>\n` +
      `     找过这些地方：\n${tried}`,
      byPlat({
        win32: { how: 'winget', cmd: 'winget', label: 'winget install --id Google.Chrome -e',
          args: ['install', '--id', 'Google.Chrome', '-e', '--accept-source-agreements', '--accept-package-agreements'] },
        darwin: { how: 'brew', cmd: 'brew', label: 'brew install --cask google-chrome',
          args: ['install', '--cask', 'google-chrome'] },
      }, 'Linux 上装 Chrome 要 root（sudo），非交互环境会卡在密码提示上 —— 请按上面的指引手动装'));
  }
  // ★ 刻意**不跑** `chrome --version`：
  //   Windows 上 Chrome 已经开着时，这条命令会把参数**转发给现有会话**，
  //   返回一句本地化的中文提示（还是 GBK 编码），读进来就是乱码 ——
  //   2026-10-08 实测就是「（乱码）…现有的浏览器会话中打开。」。
  //   而版本号对「能不能渲染」根本不是判据：路径找得到 + ⑦ 实渲染通过就够了。
  //   ⚠️ 通用教训：**Windows 上外部命令的输出不保证是 UTF-8**，别拿它当判据字符串。
  return rec('chrome', 'Google Chrome', true, `${chrome}${how}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 检查 ④ ffmpeg
// ─────────────────────────────────────────────────────────────────────────────

function checkFFmpeg() {
  // ★ 用 env-paths 里的那一份（和真渲染共用）—— 不自己再写一套候选
  const ff = ENVP.resolveFFmpeg();
  const ver = firstLine(ff, ['-version']); // 真跑一次才知道它在不在 PATH、能不能执行
  if (!ver) {
    return rec('ffmpeg', 'ffmpeg', false,
      ff === 'ffmpeg' ? 'PATH 上找不到 ffmpeg（真跑 `ffmpeg -version` 无输出）' : `路径存在但跑不起来：${ff}`,
      `装一个：\n` +
      `       Windows  winget install Gyan.FFmpeg\n` +
      `       macOS    brew install ffmpeg\n` +
      `       Linux    sudo apt install ffmpeg\n` +
      `     装了但不在 PATH → 直接指： RENDER_CORE_FFMPEG=<ffmpeg 绝对路径>`,
      byPlat({
        win32: { how: 'winget', cmd: 'winget', label: 'winget install --id Gyan.FFmpeg -e',
          args: ['install', '--id', 'Gyan.FFmpeg', '-e', '--accept-source-agreements', '--accept-package-agreements'] },
        darwin: { how: 'brew', cmd: 'brew', label: 'brew install ffmpeg',
          args: ['install', 'ffmpeg'] },
      }, 'Linux 上 `apt install ffmpeg` 要 sudo —— 请按上面的指引手动装'));
  }
  const isAbs = /[\\/]/.test(ff);
  return rec('ffmpeg', 'ffmpeg', true,
    `${ver}${isAbs ? `   → ${ff}` : '   （走 PATH：ffmpeg）'}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 检查 ⑤⑥ Python（可选 —— 只做画面、已有配音和字轴的话可以省）
// ─────────────────────────────────────────────────────────────────────────────

/** 找出一个真实可用的 Python；跳过 Microsoft Store 的占位符（它只会弹商店窗口） */
function findPython() {
  const cands = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
  for (const c of cands) {
    const which = run(process.platform === 'win32' ? 'where' : 'which', [c]);
    if (!which.ok) continue;
    const p = which.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (!p) continue;
    if (/WindowsApps/i.test(p)) continue; // Store 占位符，跳过
    const v = firstLine(p, ['-V']) || firstLine(p, ['--version']);
    if (v) return { cmd: p, ver: v };
  }
  return null;
}

const PY_MODULES = [
  ['faster_whisper', '转写（② 配音 → 逐词时间轴）'],
  ['numpy', '音频 / 图像数值计算'],
  ['PIL', 'Pillow · 图像分析（frame_sheet / pix.py）'],
];

/** 把模块名清单拼成 Python 列表字面量 */
function pyList(mods) {
  return '[' + mods.map(([m]) => '"' + m + '"').join(',') + ']';
}

/* 让 Python 自己报「哪些装上了」——比在 JS 里猜目录可靠得多 */
const PY_CHECK_CODE =
  'import importlib.util as u;' +
  'print("|".join(m for m in ' + pyList(PY_MODULES) + ' if u.find_spec(m)))';

function checkPython() {
  const py = findPython();
  if (!py) {
    recOptional('python', 'Python', false, '没找到可用的 Python 解释器（已跳过商店占位符）',
      `需要转写配音时才要装：\n` +
      `       Windows  winget install Python.Python.3.12\n` +
      `       macOS    brew install python@3.12\n` +
      `       Linux    sudo apt install python3 python3-venv\n` +
      `     （⛔ 别用 Microsoft Store 那个版本，它是占位符）`,
      byPlat({
        win32: { how: 'winget', cmd: 'winget', label: 'winget install --id Python.Python.3.12 -e',
          args: ['install', '--id', 'Python.Python.3.12', '-e', '--accept-source-agreements', '--accept-package-agreements'] },
        darwin: { how: 'brew', cmd: 'brew', label: 'brew install python@3.12',
          args: ['install', 'python@3.12'] },
      }, 'Linux 上要 sudo —— 请按上面的指引手动装'));
    recOptional('pymod', 'Python 包', null, '跳过（没有 Python）', null);
    return;
  }
  const major = Number(String(py.ver).replace(/[^\d.]/g, '').split('.')[0]);
  const minor = Number(String(py.ver).replace(/[^\d.]/g, '').split('.')[1] || 0);
  const okVer = major > 3 || (major === 3 && minor >= 11);
  recOptional('python', 'Python', okVer, `${py.ver}   → ${py.cmd}`,
    okVer ? null : '建议 ≥ 3.11（faster-whisper 的 wheel 覆盖更全）');

  const r = run(py.cmd, ['-c', PY_CHECK_CODE]);
  const have = r.ok ? String(r.out).trim().split('|').filter(Boolean) : [];
  const missing = PY_MODULES.filter(([m]) => !have.includes(m)).map(([m]) => m);
  if (missing.length === 0) {
    recOptional('pymod', 'Python 包', true, `faster-whisper · numpy · Pillow 全部可用`);
  } else {
    recOptional('pymod', 'Python 包', false, `缺 ${missing.join(' · ')}`,
      `建议放虚拟环境（别污染系统 Python）：\n` +
      `       ${py.cmd} -m venv .venv\n` +
      `       .venv\\Scripts\\activate      （macOS / Linux: source .venv/bin/activate）\n` +
      `       pip install faster-whisper numpy Pillow\n` +
      `     逐条缺什么装什么： ${missing.map((m) => (m === 'PIL' ? 'Pillow' : m === 'faster_whisper' ? 'faster-whisper' : m)).join(' ')}`,
      act({
        how: 'pip', cmd: py.cmd, cwd: REPO, auto: true,
        args: ['-m', 'pip', 'install',
          ...missing.map((m) => (m === 'PIL' ? 'Pillow' : m === 'faster_whisper' ? 'faster-whisper' : m))],
        label: `${py.cmd} -m pip install ${missing.map((m) => (m === 'PIL' ? 'Pillow' : m === 'faster_whisper' ? 'faster-whisper' : m)).join(' ')}`,
        why: '没找到可用的 Python',
      }));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 检查 ⑦ 中文字体 —— 本管线最经典的「零报错但画面是错的」
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 判定思路（要点在负控）：
 *   canvas 画三个字符，取像素签名
 *     'A'     —— 拉丁字母，**必然**有字形
 *     '国'    —— 被测汉字
 *     '\uE000'—— 私用区码位，**必然**没有字形 ⇒ 渲染成「豆腐块」(tofu)
 *   ① 负控成立吗？`tofu` 必须**画出了东西**且**和 'A' 不一样**。
 *      不成立 ⇒ 本机渲染行为不符合预期，报「无法判定」，**不给 PASS**。
 *   ② 汉字签名 == tofu 签名 ⇒ 汉字被当成了豆腐块 ⇒ **没装中文字体**，FAIL。
 *   ③ 否则 ⇒ 有真字形，PASS。
 *
 * 为什么不能只数黑色像素：豆腐块也是黑的。**必须跟"已知没字形"的那个比。**
 * 双字取样（国 / 语）是为了避开"某些字体恰好只缺这一个字"的误判。
 */
const FONT_PROBE_CHARS = [
  ['\u56FD', '国'],
  ['\u8BED', '语'],
];

async function checkFont() {
  if (!CORE) {
    return rec('font', '中文字体', null,
      '无法判定：需要 puppeteer-core + Chrome 才能实渲染检测',
      '先过 ②③ 两项，再跑一次 node kit/check_env.js');
  }
  let chrome = null;
  try { chrome = CORE.resolveChrome(); } catch (_) { return rec('font', '中文字体', null, '无法判定：Chrome 没找到（先过第 ③ 项）', null); }

  let puppeteer = null;
  try { puppeteer = CORE.loadPuppeteer().mod; } catch (_) { /* 上面已报 */ }
  if (!puppeteer) {
    return rec('font', '中文字体', null, '无法判定：puppeteer-core 解析失败（第 ② 项）', null);
  }

  let browser = null;
  try {
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: 'new',
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setContent('<!doctype html><meta charset="utf-8"><canvas id="c" width="96" height="96"></canvas>');

    const probe = await page.evaluate((chars) => {
      const c = document.getElementById('c');
      const g = c.getContext('2d');
      const snap = (ch) => {
        g.clearRect(0, 0, c.width, c.height);
        g.fillStyle = '#000';
        g.font = '64px sans-serif';
        g.textBaseline = 'top';
        g.fillText(ch, 4, 4);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let ink = 0;
        const sig = [];
        for (let i = 0; i < d.length; i += 4) {
          const a = d[i + 3];
          if (a > 8) ink++;
          sig.push(a);
        }
        return { ink, sig: sig.join(',') };
      };
      const out = { a: snap('A'), tofu: snap('\uE000'), chars: [] };
      for (const [ch, name] of chars) out.chars.push({ name, s: snap(ch) });
      return out;
    }, FONT_PROBE_CHARS);

    // ① 负控
    const tofuDrawable = probe.tofu.ink > 0 && probe.tofu.sig !== probe.a.sig;
    if (!tofuDrawable) {
      return rec('font', '中文字体', null,
        `无法判定：负控不成立（"没字形的码位"没有渲染成豆腐块，ink=${probe.tofu.ink}）`,
        '这台机器的字体渲染行为不符合预期，本项判据在这台机器上不可用 —— 请人工看一眼渲染出来的中文');
    }
    // ② 汉字是不是豆腐块
    const asTofu = probe.chars.filter((c) => c.s.sig === probe.tofu.sig || c.s.ink === 0).map((c) => c.name);
    if (asTofu.length > 0) {
      return rec('font', '中文字体', false,
        `汉字渲染成了豆腐块：${asTofu.join(' · ')}`,
        `装一套开源可商用的中文字体（任选）：\n` +
        `       思源黑体 Source Han Sans   · 覆盖最全，7 个字重\n` +
        `       阿里巴巴普惠体            · 免费商用\n` +
        `       霞鹜文楷 LXGW WenKai      · 楷体风格\n` +
        `     Windows：双击 .ttf/.otf → "为所有用户安装"；装完**重启浏览器**。\n` +
        `     ⚠️ 不装的后果不是报错，是**画面文字全变方块而所有判据照样全绿** —— 只有抽帧肉眼才看得见。`,
        act({ why: '字体有版权（不是每套都允许被自动分发下载），而且一套中文字体几百 MB —— 这两个理由都够不上「替你装」，请按上面的指引手动装' }));
    }
    // ③ 通过
    const extra = probe.chars.length > 1 ? `${probe.chars.map((c) => c.name).join(' / ')} 均为真字形` : '真字形';
    return rec('font', '中文字体', true, `${extra}（不是豆腐块；带负控对照）`);
  } catch (e) {
    return rec('font', '中文字体', null, `无法判定：Chrome 启动/渲染失败 —— ${String(e.message).split('\n')[0]}`,
      '先确认第 ③ 项，并检查有没有僵尸 Chrome 进程占着');
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 输出
// ─────────────────────────────────────────────────────────────────────────────

function icon(ok) {
  if (ok === true) return '✅';
  if (ok === false) return '❌';
  return '⚠️ ';
}

function printReport() {
  const hard = RESULTS.filter((r) => !r.optional);
  const optional = RESULTS.filter((r) => r.optional);
  const hardFail = hard.filter((r) => r.ok === false);
  const hardSkip = hard.filter((r) => r.ok === null);
  const optFail = optional.filter((r) => r.ok === false || r.ok === null);

  const LINE = '─'.repeat(64);
  console.log('');
  console.log('═'.repeat(64));
  console.log('  环境自检 · Voice-to-animation');
  console.log('  git clone 不装任何东西 —— 缺什么，这里告诉你。');
  console.log('═'.repeat(64));
  console.log('');

  const CN = ['①', '②', '③', '④', '⑤', '⑥', '⑦'];
  RESULTS.forEach((r, i) => {
    const tag = CN[i] || ' ';
    console.log(`  ${icon(r.ok)} ${tag} ${pad(r.label, 18)} ${r.detail}`);
    if (r.fix && r.ok !== true) {
      for (const ln of String(r.fix).split('\n')) console.log(`        ${ln}`);
    }
  });

  console.log('');
  console.log(LINE);

  if (hardSkip.length) {
    console.log(`  ⚠️  ${hardSkip.length} 项**无法判定**（不算通过）：${hardSkip.map((r) => r.label).join(' · ')}`);
    console.log('      修掉它依赖的那一项，再跑一次。');
  }
  if (optFail.length) {
    console.log(`  ⚠️  可选依赖未齐：${optFail.filter((r) => r.ok === false).map((r) => r.label).join(' · ') || '——'}`);
    console.log('      只做画面（已有配音 + 字轴）的话可以不管；要转写配音就得装。');
  }

  const hardPass = hard.filter((r) => r.ok === true).length;
  if (hardFail.length === 0 && hardSkip.length === 0) {
    console.log(`  ✅ 必装项 ${hardPass}/${hard.length} 全部通过。环境没问题，开工吧。`);
    console.log('');
    console.log('  下一步：');
    console.log('    node kit/new_project.js --spec kit/templates/spec.example.json \\');
    console.log('                            --out examples/hello-voice --force');
    console.log('    cd examples/hello-voice && node _render.js     # → demo.mp4 (4K)');
    console.log('    出 3840×2160 / 361 帧 / 12.03s 就说明全链路通了。');
    console.log('    详见 docs/环境与依赖.md');
  } else {
    console.log(`  ❌ 必装项 ${hardPass}/${hard.length} 通过${hardFail.length ? `，${hardFail.length} 项缺失` : ''}${hardSkip.length ? `，${hardSkip.length} 项无法判定` : ''}。`);
    console.log('      照上面的「→ 修：」逐条装，装完再跑一次本脚本。');
  }
  console.log(LINE);
  console.log('');

  return hardFail.length === 0 && hardSkip.length === 0 ? 0 : 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// 一轮完整检查（`--install` 装完要复跑，所以提成函数）
// ─────────────────────────────────────────────────────────────────────────────

async function runAllChecks() {
  RESULTS.length = 0;
  // ★ 重跑时能真的重新探测：`require` 失败**不进 Node 的模块缓存**，
  //   所以刚装上的 puppeteer-core 这一轮就解析得到（不用重启进程）。
  loadModules();
  checkNode();
  checkPuppeteer();
  checkChrome();
  checkFFmpeg();
  checkPython();
  if (SKIP_FONT) {
    RESULTS.push({
      id: 'font', label: '中文字体', ok: null,
      detail: '已按 --no-font 跳过（未验证）',
      fix: '去掉 --no-font 可实测（会启动一次 headless Chrome）', optional: false,
    });
  } else {
    await checkFont();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// --install
// ─────────────────────────────────────────────────────────────────────────────

/** Windows 上 spawn（不带 shell）解析不到无扩展名的命令 —— 补 .exe，免得静默「启动失败」 */
function exeName(cmd) {
  if (!IS_WIN) return cmd;
  if (/\.(exe|cmd|bat)$/i.test(cmd)) return cmd;
  return cmd + '.exe';
}

async function installAll() {
  const L = '─'.repeat(64);
  const todo = RESULTS.filter((r) => r.ok === false && r.install);
  // ★ 自动队列**只收必装项**。可选依赖（Python 包那种）不自动装 ——
  //   一是体积（faster-whisper 连模型几百 MB），二是「只做画面」的人根本不需要。
  //   它们仍会列进计划，只是归到「需你处理」那一栏。
  const auto = todo.filter((r) => !r.optional && r.install.auto && r.install.cmd);
  const manual = todo.filter((r) => r.optional || !(r.install.auto && r.install.cmd));
  const INSTALL_SCOPE = '只装「必装项」；可选依赖（Python 包等）只列出、不动手';

  console.log('');
  console.log('═'.repeat(64));
  console.log(`  环境安装计划　${YES ? '【--yes · 开始执行】' : '【dry · 只看不做】'}`);
  console.log('  只走包管理器（npm / winget / brew），每条命令先打印再执行。');
  console.log(`  ${INSTALL_SCOPE}。`);
  console.log('═'.repeat(64));
  console.log('');

  if (todo.length === 0) {
    console.log('  ✅ 没有待安装项 —— 该有的都有了，不用装。');
    console.log('');
    return 0;
  }

  if (auto.length) {
    console.log(`  ① 可自动安装（${auto.length} 项）`);
    for (const r of auto) {
      console.log(`     · ${pad(r.label, 16)} ${r.install.label}`);
      if (r.install.cwd) console.log(`       ${' '.repeat(16)} （工作目录：${r.install.cwd}）`);
    }
    console.log('');
  }
  if (manual.length) {
    console.log(`  ② 需你自己处理（${manual.length} 项）—— 不自动的理由：`);
    for (const r of manual) {
      const why = (r.optional && r.install.auto)
        ? '可选依赖 —— 不自动装（只在你要用那部分功能时才有用）'
        : r.install.why;
      console.log(`     · ${pad(r.label, 16)} ${why}`);
    }
    console.log('');
  }

  if (!YES) {
    console.log(L);
    console.log('  以上只是**计划**，一个字节都没动。');
    console.log('  确认没问题就加 --yes 执行：');
    console.log('    node kit/check_env.js --install --yes');
    console.log(L);
    console.log('');
    return 0;
  }

  if (todo.length && auto.length === 0) {
    console.log(L);
    console.log('  ⚠️  没有任何「可自动安装」的项 —— 上面 ② 列出的事都得你自己来。');
    console.log(L);
    console.log('');
    return 1;
  }

  // ── 真执行 ──
  let okN = 0, badN = 0;
  for (const r of auto) {
    const a = r.install;
    console.log(L);
    console.log(`  ▶ ${r.label}　→　${a.label}`);
    console.log(L);
    const res = spawnSync(exeName(a.cmd), a.args, {
      cwd: a.cwd || REPO,
      stdio: 'inherit',
      timeout: INSTALL_TIMEOUT,
      windowsHide: true,
      // ★ 2026-10-09 实测踩到：Windows 上**不能**直接 spawn `.cmd` / `.bat` ——
      //   Node 自 18.20.2 起（CVE-2024-27980 的修复）一律抛 `EINVAL`，
      //   于是 `npm.cmd` 这条必然失败，而错误信息只说 "spawnSync npm.cmd EINVAL"，
      //   完全看不出是「Node 的安全策略」还是「npm 没装」。
      //   ⇒ Windows 走 shell（由 cmd.exe 按 PATHEXT 解析），其它平台照旧不用 shell。
      //   参数全是脚本里写死的常量、无用户输入 ⇒ 无注入面。
      shell: IS_WIN,
    });
    if (res.error) {
      console.log(`  ✗ 启动失败：${res.error.message}`);
      badN++;
    } else if (res.status === 0) {
      console.log(`  ✓ 退出码 0`);
      okN++;
    } else {
      console.log(`  ✗ 退出码 ${res.status}（可能是网络、权限，或它想让你先同意条款）`);
      badN++;
    }
    console.log('');
  }

  console.log(L);
  console.log(`  安装命令：成功 ${okN} / 失败 ${badN}`);
  console.log(L);

  // ── 复验：重跑整轮检查，而不是假定装好了 ──
  console.log('');
  console.log('  复验中（重跑一遍全部检查）…');
  await runAllChecks();
  const rc = printReport();
  console.log('  ⚠️  包管理器装完**当前进程的 PATH 不会刷新** —— 如果刚装的还报 ❌，');
  console.log('      **开个新终端再跑一次 `node kit/check_env.js`**，那才是它的真实状态。');
  console.log('');
  return rc;
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

(async function main() {
  await runAllChecks();

  if (AS_JSON) {
    const hard = RESULTS.filter((r) => !r.optional);
    const ok = hard.every((r) => r.ok === true);
    console.log(JSON.stringify({ ok, results: RESULTS }, null, 2));
    process.exit(ok ? 0 : 1);
  }

  if (INSTALL) {
    process.exit(await installAll());
  }

  process.exit(printReport());
})().catch((e) => {
  console.error('check_env: 自检脚本本身出错了（这是 bug，不是环境问题）：');
  console.error(e && e.stack || e);
  process.exit(2);
});
