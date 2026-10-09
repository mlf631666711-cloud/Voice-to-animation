'use strict';
/**
 * env-paths.js —— 外部依赖（Chrome / ffmpeg / puppeteer-core）的候选路径与查找器
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 为什么单独抽一个文件（而不是留在 render-core.js 里）
 * ─────────────────────────────────────────────────────────────────────────
 * `render-core.js` 一被 require 就会执行 `loadPuppeteer()`，puppeteer-core 没装时
 * **直接抛错、整个模块加载失败**。而「环境自检」（`kit/check_env.js`）的职责恰恰是
 * 「在什么都还没装的时候跑起来，告诉你缺什么」—— 它不能依赖 render-core 能加载。
 * 所以候选表必须落在这里：**两边共用一份，避免自检与真渲染各写一套、日后漂移**。
 *
 * 本文件**零副作用**：只定义数据与纯查找函数。不 require 任何第三方包、不抛错、
 * 不读磁盘以外的外部状态（磁盘读失败一律吞掉，当"没找到"处理）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 三个环境变量（都是「实在找不到时的最后一根救命绳」）
 * ─────────────────────────────────────────────────────────────────────────
 *   RENDER_CORE_PUPPETEER   puppeteer-core 的**绝对路径**（可指向 node_modules/puppeteer-core）
 *   RENDER_CORE_CHROME      chrome.exe / Google Chrome 可执行文件的**绝对路径**
 *   RENDER_CORE_FFMPEG      ffmpeg 可执行文件的**绝对路径**
 *
 *   ⚠️ 2026-10-08 修的坑：`docs/环境与依赖.md` 一直写着可以设 `RENDER_CORE_CHROME`，
 *      但 `resolveChrome()` **根本没读这个变量** —— 文档承诺的功能不存在。
 *      现在两个变量都真的会读了。
 *
 * 作者：大狗 🐶（主 Agent）· 2026-10-08
 */

const fs = require('fs');
const path = require('path');

/** 第一个真实存在的路径；都没有返回 null */
function firstExisting(list) {
  for (const p of list) {
    if (!p) continue;
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) { /* 权限之类的怪问题：当没找到 */ }
  }
  return null;
}

/** 去重后追加（保持优先级顺序，空值忽略） */
function push(list, p) {
  if (p && !list.includes(p)) list.push(p);
  return list;
}

// ─────────────────────────────────────────────────────────────────────────────
// 一、puppeteer-core
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 候选顺序 = 优先级：
 *   ① 环境变量指定（你说什么就是什么）
 *   ② `'puppeteer-core'` —— 从本文件所在目录（kit/）逐级向上找 node_modules，
 *      命中「仓库根 / kit 旁边」装的那份。**开源用户按 README 第 3 步装完 puppeteer-core 走的就是这条**
 *   ③ 当前工作目录下的 node_modules —— 有人习惯在自己的片子目录里装依赖
 *   ④ 本仓库作者本机的几处 node_modules（别人机器上不存在；require 会失败并自动跳过。
 *      留着是为了不打断本机工作流：本机这些工程里已经装过 puppeteer-core）
 *   ⑤ 最后才认完整版 `puppeteer`（自带 Chromium，体积大但能用）
 */
function puppeteerCandidates() {
  const c = [];
  push(c, process.env.RENDER_CORE_PUPPETEER);
  push(c, 'puppeteer-core');
  push(c, path.join(process.cwd(), 'node_modules', 'puppeteer-core'));
  push(c, 'puppeteer');
  return c;
}

// ─────────────────────────────────────────────────────────────────────────────
// 二、Chrome / Chromium 可执行文件
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ 2026-10-08 修的坑：这里**原来只有 Windows 路径**。
 *    而 `docs/环境与依赖.md` 明确写了 macOS（brew）和 Linux（apt）的装法 ——
 *    结果 mac / Linux 用户照着文档把 Chrome 装好了，`resolveChrome()` 依旧抛
 *    「找不到 Chrome」。**文档说支持、代码不支持**。现已补齐三平台。
 *    （Chromium 内核的 Edge / Brave 同样可用，但要用 RENDER_CORE_CHROME 自己指 —— 
 *      不放进默认候选，免得不同浏览器版本的行为差异变成了新的排查变量。）
 */
function chromeCandidates(explicit) {
  const c = [];
  push(c, explicit);
  push(c, process.env.RENDER_CORE_CHROME);

  if (process.platform === 'win32') {
    push(c, 'C:/Program Files/Google/Chrome/Application/chrome.exe');
    push(c, 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe');
    push(c, path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'));
    push(c, path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'));
  } else if (process.platform === 'darwin') {
    push(c, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    push(c, path.join(process.env.HOME || '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
    push(c, '/Applications/Chromium.app/Contents/MacOS/Chromium');
    push(c, '/opt/homebrew/bin/chromium');
  } else {
    push(c, '/usr/bin/google-chrome');
    push(c, '/usr/bin/google-chrome-stable');
    push(c, '/usr/bin/chromium');
    push(c, '/usr/bin/chromium-browser');
    push(c, '/snap/bin/chromium');
  }
  return c;
}

// ─────────────────────────────────────────────────────────────────────────────
// 三、ffmpeg
// ─────────────────────────────────────────────────────────────────────────────

/** WinGet 装 ffmpeg 的包目录名（版本号在**下一层**，所以要扫） */
function wingetFFmpegPackages() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  let names = [];
  try {
    names = fs.readdirSync(base);
  } catch (_) {
    return { base, pkgs: [] };
  }
  return { base, pkgs: names.filter((n) => /^Gyan\.FFmpeg/i.test(n)).sort() };
}

/**
 * ⚠️ 2026-10-08 修的坑：原来硬编码了一条
 *    `…/Gyan.FFmpeg_…_8wekyb3d8bbwe/ffmpeg-8.1.2-full_build/bin/ffmpeg.exe`
 *    —— 路径里带了**具体版本号**。别人 WinGet 装的是 7.x / 9.x 就命中不了，
 *    只能退回 PATH 兜底。现在改成**扫目录**，装什么版本都能认出来。
 */
function ffmpegCandidates(explicit) {
  const c = [];
  push(c, explicit);
  push(c, process.env.RENDER_CORE_FFMPEG);

  if (process.platform === 'win32') {
    const { base, pkgs } = wingetFFmpegPackages();
    for (const pkg of pkgs) {
      const dir = path.join(base, pkg);
      let subs = [];
      try { subs = fs.readdirSync(dir); } catch (_) { subs = []; }
      subs.sort().reverse(); // 新版本优先（字符串序，8.1.2 > 8.0.1 成立）
      for (const s of subs) push(c, path.join(dir, s, 'bin', 'ffmpeg.exe'));
    }
    push(c, 'C:/ffmpeg/bin/ffmpeg.exe');
    push(c, 'C:/Program Files/ffmpeg/bin/ffmpeg.exe');
  } else {
    push(c, '/usr/bin/ffmpeg');
    push(c, '/usr/local/bin/ffmpeg');
    push(c, '/opt/homebrew/bin/ffmpeg');
  }
  return c;
}

/**
 * 定位 ffmpeg：找到绝对路径就返回它；都没有则返回 `'ffmpeg'` 交给 PATH。
 * （**不抛错** —— 装没装、在不在 PATH，交给调用方去实测 `ffmpeg -version` 判定。）
 */
function resolveFFmpeg(explicit) {
  return firstExisting(ffmpegCandidates(explicit)) || 'ffmpeg';
}

module.exports = {
  firstExisting,
  puppeteerCandidates,
  chromeCandidates,
  ffmpegCandidates,
  resolveFFmpeg,
};
