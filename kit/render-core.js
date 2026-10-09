/**
 * render-core.js —— 「语音转动画」管线公共渲染核心
 *
 * 合并两条来源的成熟做法：
 *   1. 22 个已有工程的 _render_mp4.js 范式：
 *      puppeteer-core + 系统 Chrome，page.evaluate(t => window.__frame(t), i/fps) 逐帧驱动，
 *      PNG 序列落盘，ffmpeg PNG 序列 + voice.wav → mp4（libx264 -crf 20 -preset medium）。
 *   2. motion-engine/tools/html5-animation-video-renderer/render.js 的并行架构：
 *      多 headless Chrome 进程 + 工作池调度 + 页面自报 getInfo()。
 *
 * 与原型 render.js 的差异（为什么不直接用它）：
 *   - 帧驱动契约改为「秒」（__frame(t)），并兼容 seekToFrame(帧号)；
 *   - PNG 必须落盘（截帧审判要用），不走 image2pipe；
 *   - 支持混音轨（voice.wav → aac 192k）；
 *   - 去掉 tkt / mkdirp / express 依赖，只用原生 fs / path / child_process。
 *
 * 用法：
 *   const { renderProject, probe } = require('./render-core');
 *   const r = await renderProject({ html, out, voice, dur: 16.98 });
 *
 * CLI：
 *   node render-core.js --html <fx.html> --out <a.mp4> [--fps 30] [--dur 16.98]
 *                       [--w 1920] [--h 1080] [--voice voice.wav] [--alpha]
 *                       [--framesDir dir] [--no-keepFrames] [--parallel 4] [--quiet]
 *   node render-core.js --probe <fx.html>
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { once } = require('events');
const ENG = require('./export-engine');
/* ★ 依赖候选表（Chrome / ffmpeg / puppeteer-core）抽到 env-paths.js。
   原因：本模块一 require 就会 loadPuppeteer()，装了才活；而「环境自检」
   (`kit/check_env.js`) 必须在**什么都没装**的时候也能跑。所以候选表必须放在
   一个零副作用、两处共用的文件里 —— 免得自检和真渲染各写一份、日后漂移。 */
const ENVP = require('./env-paths');

/* ★ 4K 默认倍率（2026-09-21 老板「4K 档默认开启」）。
   退档：`--ss 1` 回 1080p · `--downscale` 回「SSAA 后降采样到设计尺寸」。 */
const DEFAULT_SS = 2;

// ---------------------------------------------------------------------------
// 依赖解析：puppeteer-core 在 kit 目录下解析不到，需要多候选兜底
// ---------------------------------------------------------------------------

/**
 * 解析 puppeteer-core（或完整版 puppeteer）。
 * 候选顺序见 `env-paths.js` 的 `puppeteerCandidates()` —— 那里是**唯一真源**，
 * `kit/check_env.js` 复用同一份，所以自检报「能找到」= 真渲染也能找到。
 *
 * @returns {{mod: object, from: string}}
 * @throws 全都解析不到时抛错（错误里逐条列出试过哪些路径）
 */
function loadPuppeteer() {
  const list = ENVP.puppeteerCandidates();
  const errs = [];
  for (const c of list) {
    try {
      return { mod: require(c), from: c };
    } catch (e) {
      errs.push(`${c}: ${e.code || e.message}`);
    }
  }
  throw new Error(
    'render-core: 无法解析 puppeteer-core。已尝试：\n  - ' +
      errs.join('\n  - ') +
      /* ★ 2026-10-09：本模块**在顶层就执行 loadPuppeteer()**（下面第 75 行），
         所以任何 `require('./render-core')` 的脚本都会**原样撞到这句** ——
         trial / export-engine / quad_check / layout_check / contrast_check /
         carry_check / motion_fps / motion_smooth / motion_sweep …（共 10 个入口）。
         ⇒ **改这一处 = 10 个入口共用同一份「怎么装」的指引**。
         此前只写「请 npm i puppeteer-core」：命令行是对的，但没告诉用户
         仓库自带一个能一次把 Node/Chrome/ffmpeg/字体全体检 + 自动装的工具。 */
      '\n\n→ 最省事：在**仓库根目录**跑  node kit/check_env.js --install --yes' +
      '\n   （先列计划给你看，确认了才动手；装完自动重跑一遍自检复验）' +
      '\n→ 只补这一个：npm i --no-save --no-package-lock puppeteer-core' +
      '\n   （两个 flag 别省 —— 本仓库刻意不带 package.json，不加就会凭空造一个出来）' +
      '\n   （Chrome / ffmpeg / 中文字体 缺不缺它不管 —— 想一次体检齐就跑 node kit/check_env.js）' +
      '\n→ 已经装在别处：设置环境变量 RENDER_CORE_PUPPETEER=<绝对路径>'
  );
}

const _pptr = loadPuppeteer();
const puppeteer = _pptr.mod;
const PUPPETEER_FROM = _pptr.from;

// ---------------------------------------------------------------------------
// Chrome / ffmpeg 可执行文件定位
//   候选表同样来自 env-paths.js（真源）。两个环境变量的读取也在那边：
//     RENDER_CORE_CHROME / RENDER_CORE_FFMPEG
// ---------------------------------------------------------------------------

function resolveChrome(explicit) {
  const found = ENVP.firstExisting(ENVP.chromeCandidates(explicit));
  if (found) return found;
  // 兜底：puppeteer 自带 / 缓存的浏览器
  try {
    const p = puppeteer.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (_) { /* puppeteer-core 可能没有自带浏览器 */ }
  throw new Error(
    'render-core: 找不到 Chrome。\n' +
      '  找过这些位置：\n    - ' + ENVP.chromeCandidates(explicit).join('\n    - ') +
      '\n  自救：设 RENDER_CORE_CHROME=<可执行文件绝对路径>（Chromium 内核的浏览器同样可用）'
  );
}

/** ffmpeg 定位（真源：env-paths.js）。返回绝对路径，或 `'ffmpeg'` 交给 PATH。 */
const resolveFFmpeg = ENVP.resolveFFmpeg;

// ---------------------------------------------------------------------------
// 页面帧驱动契约：seekToFrame(帧号) > __frame(秒) > __setT(秒) > renderAt(秒) > render(秒)
// ---------------------------------------------------------------------------

function detectContract(page) {
  return page.evaluate(() => ({
    seekToFrame: typeof window.seekToFrame === 'function',
    __frame: typeof window.__frame === 'function',
    __setT: typeof window.__setT === 'function',
    renderAt: typeof window.renderAt === 'function',
    render: typeof window.render === 'function',
    __dur: typeof window.__dur === 'number' ? window.__dur : null,
  }));
}

function pickMode(c) {
  if (c.seekToFrame) return 'seekToFrame';
  if (c.__frame) return '__frame';
  if (c.__setT) return '__setT';
  if (c.renderAt) return 'renderAt';
  if (c.render) return 'render';
  return null;
}

/** 把第 i 帧推到页面上。t 一律由帧号算出：t = i / fps */
function driveFrame(page, mode, i, fps) {
  const t = i / fps;
  switch (mode) {
    case 'seekToFrame':
      return page.evaluate((n) => window.seekToFrame(n), i);
    case '__frame':
      return page.evaluate((tt) => window.__frame(tt), t);
    case '__setT':
      return page.evaluate((tt) => window.__setT(tt), t);
    case 'renderAt':
      return page.evaluate((tt) => window.renderAt(tt), t);
    case 'render':
      return page.evaluate((tt) => window.render(tt), t);
    default:
      throw new Error(`render-core: 页面没有可驱动的帧函数（找过 seekToFrame/__frame/__setT/renderAt/render）`);
  }
}

// ---------------------------------------------------------------------------
// 单个渲染 worker：一个 headless Chrome + 一个 page
// ---------------------------------------------------------------------------

function createWorkerFactory(opts) {
  /* ★ 导出引擎档位（2026-09-21）：真源在 `kit/export-engine.js` 的 PROFILES，这里只取。
     legacy = 旧路径（puppeteer screenshot + 关 GPU）
     safe   = CDP optimizeForSpeed + clip{scale}。**实测与 legacy 逐像素 0 差**，2.25×
     fast   = safe 再开 GPU 光栅化。3.20×，像素最大差 9 灰阶（md5 会变） */
  const prof = ENG.PROFILES[opts.engine] || ENG.PROFILES.safe;
  return function createWorker(id) {
    const promise = (async () => {
      const browser = await puppeteer.launch({
        headless: true,
        executablePath: opts.chrome,
        args: ['--no-sandbox', '--force-color-profile=srgb', ...prof.args, ...(opts.args || [])],
      });
      const page = await browser.newPage();
      if (opts.killRaf) {
        // 与现有 22 个工程一致：干掉页面自己的 rAF 循环，时间完全由我们接管
        await page.evaluateOnNewDocument(() => {
          window.requestAnimationFrame = () => 0;
        });
      }
      /* ★ 超采样（SSAA）：dsf=ss 时 Puppeteer 按 ss 倍光栅化整页
         （DOM/文字/CSS 效果都是真像素放大），截图即得 w*ss × h*ss。
         编码期再用 lanczos 降采样回 w×h —— 细线/小字/彩色边缘的
         抗锯齿质量比直接 1× 渲好一个档次。
         ⚠️ 页面内的 canvas 必须自己把 backing store 也放大（见工程侧
            `cv.width = W * RS`），否则会被浏览器插值拉大反而更糊。 */
      const SS = Math.max(1, Math.min(4, Math.round(opts.ss || 1)));
      await page.setViewport({ width: opts.w, height: opts.h, deviceScaleFactor: SS });
      await page.goto(opts.url, { waitUntil: 'load' });
      try {
        await page.evaluate(() => (document.fonts ? document.fonts.ready : null));
      } catch (_) { /* 字体 API 不可用时忽略 */ }
      await page.setViewport({ width: opts.w, height: opts.h, deviceScaleFactor: SS });
      /* ★ 隐藏起播遮罩：工程里的 fx_*.html 都定义 window.__hideOv（把 #startOv 设成
         display:none）—— 它是「点击播放」的门帘（整屏 rgba(255,255,255,.92) 白纱），
         不该进成片。_render.js 会调它；render-core 以前**漏了这一步** ⇒ 遮罩每帧都
         盖在画面上、成片整体发白，而且**不报任何错**（静默）。
         有定义才调、没定义跳过 —— 向后兼容，且幂等（重复调无害）。
         同坑记录：BUG-2329（那一轮是 html 侧钩子丢了）· fx_s4.html 末尾注释 ·
         2026-09-20 mingong-l10-bt 镜4 S8 真 3D 段复现（3D 内容被白纱盖住，肉眼审判抓出）。 */
      await page.evaluate(() => {
        if (typeof window.__hideOv === 'function') window.__hideOv();
      });
      await new Promise((r) => setTimeout(r, opts.settle));
      /* ★ 建导出引擎：取帧这件事从此只有一个真源（kit/export-engine.js）。
         CDP 会话仅 non-legacy 档需要；legacy 档让 exporter 自己降级到 puppeteer 路径。 */
      let cdp = null;
      if (prof.backend !== 'puppy') {
        try { cdp = await page.createCDPSession(); } catch (_) { cdp = null; }
      }
      const exporter = await ENG.createExporter(page, cdp, {
        w: opts.w, h: opts.h, ss: SS, alpha: !!opts.alpha, backend: prof.backend,
      });
      return { browser, page, exporter };
    })();

    return {
      id,
      ready: promise,
      async contract() {
        const { page } = await promise;
        return detectContract(page);
      },
      async engineMeta() {
        const { exporter } = await promise;
        return exporter.meta();
      },
      /* ★ 版面指纹（2026-09-21）：量「页面自己认为的设计尺寸」。
         实测（_probe_layout.cjs，3 个真实工程 × 视口 1920/3840）：
           · DOM 工程（vga-signal / mingong-l8）→ body.offsetWidth **两个视口下都钉在 1920**
             ⇒ 它就是天然的「设计尺寸指纹」；被放大视口时它会明显小于视口宽。
           · Canvas 工程（MOTION-ATLAS）→ body 宽**跟着视口走**（1920→3840）
             ⇒ 本来就自适应满幅，不该被「铺满度」判据误伤。
         ⚠️ 用 `offsetWidth`（布局宽，免疫 transform）而不是 getBoundingClientRect
            —— 工程里的相机/缩放效果会给元素挂 transform，rect 会被算歪。
         ⚠️ 不要用「body 直接子元素宽度并集」当判据：实测 vga-signal 2040、
            mingong S8 达 10244（溢出/变换元素参与）⇒ 完全不可用。 */
      async layout() {
        const { page } = await promise;
        return page.evaluate(() => {
          const b = document.body;
          const de = document.documentElement;
          /* 直接子元素的最大布局宽：**只做诊断，不当判据**。
             实测反例（2026-09-21）：Canvas 页 MOTION-ATLAS 的 body 跟视口走（自适应、正常），
             但它的 `MAIN.player` 恒为 1460 ⇒ maxChild/vw 在 4K 下只有 0.38
             ⇒ 若拿它当判据会对**完全正常**的自适应页误报。故只记录、不判定。 */
          let maxChildW = 0, childCount = 0;
          if (b) {
            for (const c of b.children) {
              childCount++;
              const cw = c.offsetWidth || 0;
              if (cw > maxChildW) maxChildW = cw;
            }
          }
          return {
            bodyW: b ? (b.offsetWidth || 0) : 0,
            bodyH: b ? (b.offsetHeight || 0) : 0,
            maxChildW,
            childCount,
            htmlW: de ? (de.offsetWidth || 0) : 0,
            vpW: window.innerWidth,
            vpH: window.innerHeight,
            dpr: window.devicePixelRatio,
          };
        });
      },
      async shoot(i, fps, mode) {
        const { page, exporter } = await promise;
        await driveFrame(page, mode, i, fps);
        /* ★ 4K 提速：取帧交给导出引擎（CDP optimizeForSpeed + clip{scale}）。
           首帧会自证像素尺寸，不符直接抛错 —— 不把「快」当「对」（BUG-2402）。 */
        return exporter.grab();
      },
      async end() {
        const { browser } = await promise;
        await browser.close();
      },
    };
  };
}

// ---------------------------------------------------------------------------
// 工作池：最多 max 个 Chrome 进程，惰性启动
// ---------------------------------------------------------------------------

function createPool(max, factory) {
  const all = [];
  const idle = [];
  const waiting = [];
  let created = 0;

  function acquire() {
    if (idle.length) return Promise.resolve(idle.pop());
    if (created < max) {
      const w = factory(++created);
      all.push(w);
      return Promise.resolve(w);
    }
    return new Promise((resolve) => waiting.push(resolve));
  }

  function release(w) {
    const next = waiting.shift();
    if (next) next(w);
    else idle.push(w);
  }

  return {
    async run(fn) {
      const w = await acquire();
      try {
        return await fn(w);
      } finally {
        release(w);
      }
    },
    async end() {
      await Promise.all(all.map((w) => w.end().catch(() => {})));
      all.length = 0;
      idle.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// probe：打开页面拿自报信息，不渲染
// ---------------------------------------------------------------------------

/**
 * 打开页面拿自报信息，不渲染。
 * @param {string} html
 * @param {object} [cfg] 用于兜底：{w, h, fps, dur, chromePath, settle, killRaf}
 * @returns {Promise<{width:number,height:number,fps:number,numberOfFrames:number}>}
 * 页面若没实现 getInfo()，则用 cfg 的 w/h/fps 兜底，numberOfFrames 用 fps*dur 兜底
 */
async function probe(html, cfg) {
  cfg = cfg || {};
  const filePath = path.resolve(html);
  if (!fs.existsSync(filePath)) throw new Error(`render-core: html 不存在 ${filePath}`);

  const w = cfg.w || 1920;
  const h = cfg.h || 1080;
  const fps = cfg.fps || 30;
  const url = 'file:///' + filePath.replace(/\\/g, '/');

  const factory = createWorkerFactory({
    url,
    w,
    h,
    ss: Math.max(1, Math.min(4, Math.round(cfg.ss == null ? DEFAULT_SS : cfg.ss))),
    alpha: false,
    killRaf: cfg.killRaf !== false,
    settle: cfg.settle != null ? cfg.settle : 600,
    chrome: resolveChrome(cfg.chromePath),
    args: cfg.args,
    engine: cfg.engine,
  });
  const worker = factory(0);
  try {
    const { page } = await worker.ready;
    const c = await detectContract(page);

    // 页面自报 getInfo()（原型 render.js 的契约），10s 内轮询等待
    let info = null;
    try {
      info = await page.evaluate(`(async () => {
        let deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          if (typeof getInfo === 'function') break;
          await new Promise(r => setTimeout(r, 100));
        }
        if (typeof getInfo !== 'function') return null;
        return await getInfo();
      })()`);
    } catch (_) {
      info = null;
    }

    // 兜底时长：getInfo().numberOfFrames > window.__dur > cfg.dur > 10s
    let numberOfFrames = null;
    if (info && info.numberOfFrames) numberOfFrames = Math.round(info.numberOfFrames);
    if (numberOfFrames == null && c.__dur) numberOfFrames = Math.round(c.__dur * (info && info.fps ? info.fps : fps));
    if (numberOfFrames == null && cfg.dur) numberOfFrames = Math.round(cfg.dur * fps);
    if (numberOfFrames == null) {
      numberOfFrames = Math.round(10 * fps);
      console.warn(`[render-core] probe: ${path.basename(filePath)} 既无 getInfo() 也无 __dur/cfg.dur，numberOfFrames 兜底为 ${numberOfFrames}（10s）`);
    }

    return {
      width: (info && info.width) || w,
      height: (info && info.height) || h,
      fps: (info && info.fps) || fps,
      numberOfFrames,
    };
  } finally {
    await worker.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 产物核验：ffprobe 读回真实流参数（不看 exit code，不信任「应该没问题」）
// ---------------------------------------------------------------------------

/**
 * 读回成片的视频流参数。失败返回 null（不抛），由调用方决定是否视为致命。
 * @returns {{width:number,height:number,pix_fmt:string,color_range:string,
 *            color_transfer:string,color_primaries:string,color_space:string,
 *            nb_frames:number|null,duration:number|null}|null}
 */
function probeOutput(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const ffmpegPath = resolveFFmpeg();
    const ffprobe = path.join(path.dirname(ffmpegPath), 'ffprobe.exe');
    const bin = fs.existsSync(ffprobe) ? ffprobe : 'ffprobe';
    const r = spawnSync(bin, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,pix_fmt,color_range,color_transfer,color_primaries,color_space,nb_frames,duration',
      '-of', 'json', file,
    ], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) return null;
    const st = (JSON.parse(r.stdout).streams || [])[0];
    if (!st) return null;
    return {
      width: st.width, height: st.height, pix_fmt: st.pix_fmt,
      color_range: st.color_range, color_transfer: st.color_transfer,
      color_primaries: st.color_primaries, color_space: st.color_space,
      nb_frames: st.nb_frames ? Number(st.nb_frames) : null,
      duration: st.duration ? Number(st.duration) : null,
    };
  } catch (_) {
    return null;
  }
}

/**
 * 内容铺满度：解若干帧原始 RGB，用「出现最多的颜色」当背景，量非背景内容的 bbox。
 *
 * ★ 为什么必须单列这条判据（2026-09-21 踩坑）：
 *   给 1920 设计的 DOM 页面直接 `--w 3840`，产物**文件确实是 3840×2160**、
 *   尺寸判据全绿，但**内容只占左上角 1920×1080（50%×46%）** —— 等于交付了一份
 *   「4K 外壳 + 1080p 画面」。同族教训：BUG-2395（只读 PNG 头宽高）。
 *   用「最多颜色」而不是「黑色」当背景，是为了同时兼容黑底与白底工程。
 *
 * ★ 为什么改成「多时刻取最大」（2026-09-21 第二版）：
 *   第一版只在 t=50% 采一帧、绝对阈值 90% ⇒ 对**正确姿势**也报 88%×63%（误报）。
 *   63% 那条是**采样时刻**的错，不是渲染姿势的错 —— 那帧本身就没有满高内容。
 *   ⇒ 改成扫 5 个时刻（10/30/50/70/90%）**取各自方向的最大值**：只有
 *     「整条片子从头到尾都铺不满」才算真的没铺满。
 *
 * ⚠️ 即便如此，绝对阈值对**自适应画布页**依然没有意义（它想画多小就多小）
 *    ⇒ 绝对判据的**硬失败只在「版面指纹也判定是放大视口」时触发**（见 renderProject）。
 *
 * @param {string} file 成片
 * @param {number} w 采样宽（必须 = 解码尺寸，不然 bbox 坐标与帧缓冲对不上）
 * @param {number} h 采样高
 * @param {number|number[]} atSecs 采样时刻（秒）；单值 = 只采一帧（向后兼容）
 * @returns {{ratioW:number, ratioH:number, bbox:number[], bg:string, sampled:number,
 *            bestAt:number, samples:Array}|null}
 */
function probeFill(file, w, h, atSecs) {
  try {
    if (!fs.existsSync(file)) return null;
    const ffmpeg = resolveFFmpeg();
    const times = Array.isArray(atSecs) ? atSecs : [atSecs || 0];
    const samples = [];
    let best = null;
    for (const t of times) {
      const r = spawnSync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error',
        '-ss', String(Math.max(0, t || 0)), '-i', file, '-frames:v', '1',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
      ], { encoding: 'buffer', maxBuffer: w * h * 3 + 1024 * 1024, windowsHide: true });
      if (r.status !== 0 || !r.stdout || r.stdout.length < w * h * 3) continue;
      const b = r.stdout;
      const hist = new Int32Array(4096);
      const idxOf = (p) => ((b[p] >> 4) << 8) | ((b[p + 1] >> 4) << 4) | (b[p + 2] >> 4);
      for (let p = 0; p < b.length; p += 3) hist[idxOf(p)]++;
      let mode = 0;
      for (let i = 1; i < 4096; i++) if (hist[i] > hist[mode]) mode = i;
      const br = ((mode >> 8) & 15) << 4, bgc = ((mode >> 4) & 15) << 4, bb = (mode & 15) << 4;
      let x0 = w, x1 = -1, y0 = h, y1 = -1, n = 0;
      const T = 24;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const p = (y * w + x) * 3;
          if (Math.abs(b[p] - br) > T || Math.abs(b[p + 1] - bgc) > T || Math.abs(b[p + 2] - bb) > T) {
            n++;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
      }
      const s = x1 < 0
        ? { t: +t.toFixed(3), ratioW: 0, ratioH: 0, fillW: 0, fillH: 0, bbox: [0, 0, 0, 0], bg: `rgb(${br},${bgc},${bb})`, sampled: 0 }
        : {
            t: +t.toFixed(3),
            ratioW: +((x1 - x0 + 1) / w).toFixed(4),
            ratioH: +((y1 - y0 + 1) / h).toFixed(4),
            fillW: x1 - x0 + 1, fillH: y1 - y0 + 1, bbox: [x0, y0, x1, y1],
            bg: `rgb(${br},${bgc},${bb})`, sampled: n,
          };
      samples.push(s);
      /* 取「面积占比」最大的那一帧当代表（两个方向同时看，避免只挑宽或只挑高） */
      if (!best || s.ratioW * s.ratioH > best.ratioW * best.ratioH) best = s;
    }
    if (!best) return null;
    return {
      ratioW: best.ratioW, ratioH: best.ratioH,
      bbox: best.bbox, bg: best.bg, sampled: best.sampled,
      bestAt: best.t, samples,
    };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ffmpeg：PNG 序列（+ 可选音轨）→ 成片
// ---------------------------------------------------------------------------

/**
 * 渲染前清掉上一轮遗留的 `frame_*.png`。
 * ★ 为什么必须做（2026-09-21 实测抓到的真 bug）：
 *   framesDir 默认 = `<html 同目录>/frames`，而这里**只 mkdir、从不清理** ⇒
 *   上一次渲剩的 PNG 会被 ffmpeg 当成**本次输入**一起编码。
 *   实测证据链：vga-signal 的 `frames/` 里躺着 **181** 张旧帧，
 *   跑一条「31 帧 / 1 秒」的渲染，产物是 **181 帧**的成片（ffprobe 实数），
 *   而**产物核验 / 铺满度 / 尺寸 / 色彩全绿** —— 没人去数帧数（同族：
 *   BUG-2170 系列「中间产物过期 = 静默假绿」，但这条更狠，它**污染成片本身**）。
 *   控制变量后同一个命令产出 31 帧 ✓，因果闭合。
 * ⚠️ 只删 `frame_\d+\.png`，不 rmSync 整个目录 —— 用户可能把别的东西放在同一目录。
 * @returns {number} 清掉的张数
 */
function cleanStaleFrames(dir) {
  let n = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/^frame_\d+\.png$/.test(f)) {
        try { fs.rmSync(path.join(dir, f), { force: true }); n++; } catch (_) { /* 占用中忽略 */ }
      }
    }
  } catch (_) { /* 目录还不存在 → 后面 mkdirSync 建 */ }
  return n;
}

/* ★ 非管道（落盘）路径的编码超时护栏（2026-09-21 补）：
   落盘路径与 pipe 路径**过的是同一套 x264 preset slow + 同一批并发截图进程**，
   4K 下同样会「永不 finalize」。差别只在于这里用的是 spawnSync ⇒ 不超时就是
   **整个 node 进程同步卡死**（连事件循环都不转），比 pipe 异步挂起更难察觉。
   spawnSync 超时会发生两件事：① libuv 杀子进程 ② r.error = Error{code:'ETIMEDOUT'}。
   若沿用裸 `if (r.error) throw r.error`，调用方只拿到一句 ETIMEDOUT，
   既不知道产物在哪、也不知道「文件在但没 moov atom ⇒ 不可交付」——
   于是很可能被当成「偶发失败，重跑就好」。所以单独拎出来给同一条处方。 */
function runFFmpeg(ffmpeg, args, quiet, timeoutMs) {
  const to = timeoutMs || 0;
  const r = spawnSync(ffmpeg, args, { encoding: 'utf8', windowsHide: true, timeout: to });
  const log = (r.stdout || '') + (r.stderr || '');
  const outPath = args.length ? args[args.length - 1] : '(?)';
  if (r.error && r.error.code === 'ETIMEDOUT') {
    throw new Error(`render-core: ★ ffmpeg 超时被杀（${Math.round(to / 1000)}s 未退出）\n`
      + `  产物 ${outPath} 极可能**不完整**（文件在、但没有 moov atom ⇒ ffprobe 报「moov atom not found」）⇒ **不可交付**。\n`
      + `  已知触发条件之一：4K + --engine fast + --parallel 8 + --pipe（8 个 GPU 光栅进程 + 4K x264 preset slow 互相抢）。\n`
      + `  处置：① 降 --parallel（实测 8~12 会反向变慢）② 换 --preset fast ③ 或去掉 --engine fast。\n`
      + `  ffmpeg 输出尾部：${log.slice(-400) || '(空)'}`);
  }
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`render-core: ffmpeg 失败 (exit ${r.status})\n${log.slice(-3000)}`);
  }
  if (!quiet && log.trim()) process.stderr.write(log);
  return log;
}

function buildFFmpegArgs(o) {
  // 注意：所有 -i 必须连续排完，编码选项只能出现在最后一个 -i 之后，
  // 否则 ffmpeg 会把 -c:v 当成对后一个输入的「解码器选择」（会报 Decoder not found）。
  const args = ['-y'];
  /* ★ pipe 模式（2026-09-21 加）：PNG 从 stdin 走 image2pipe，**不落盘**。
     理由：4K 下每帧 PNG 0.2~7.6MB，落盘的 syscall + 反读在长片上是纯浪费；
     而且「落盘再读」等于把同一份数据写两遍。实测瓶颈虽主要在截图与 PNG 编码，
     但管道模式省掉落盘这一段，且**不产生 1200 个中间文件**（收尾更干净）。
     需要抽帧审判时用 cfg.dumpFrames 指定帧号单独存。 */
  if (o.pipeIn) {
    args.push('-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(o.fps), '-i', 'pipe:0');
  } else {
    args.push('-framerate', String(o.fps), '-i', path.join(o.framesDir, 'frame_%05d.png'));
  }
  const outArgs = [];

  if (o.voice) args.push('-i', o.voice);

  if (o.alpha) {
    // 实测本机 ffmpeg 8.1.2 两者均可；默认 prores_ks 4444（剪辑软件直接可叠）
    if (o.alphaCodec === 'qtrle') {
      outArgs.push('-c:v', 'qtrle');
    } else {
      outArgs.push('-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le');
    }
  } else {
    /* ★ 画质档（2026-09-10 升级）—— 原先是 `-preset medium -crf 20 -pix_fmt yuv420p`：
       在「暗场大面积渐变 + 1.9px 细线 + 青/橙彩字」这类画面上，最吃三点亏：
         · crf 20 暗部块噪 + 渐变 banding
         · 没有 aq-mode，平坦区域码率分配不足，暗场最容易糊
         · 无色彩标签，剪辑软件可能按 bt601 解释（颜色整体偏）
       逐条对症：
         -crf 16           暗部细节够用（配合 SSAA 降采样，实际观感再上一个档）
         -preset slow      用编码时间换压缩效率（渲染瓶颈在 Chrome，编码是小头）
         -aq-mode=3        自动方差 AQ —— 暗场 banding 的标准解法
         -psy-rd 1.0:0.15  保持细节锐度，不被降噪抹掉细线
         -tune 不加        本片是矢量+渐变，不是 anime，animation tune 会过度平滑
         bt709 三件套      明确标注，避免 NLE 误判色域 */
    /* ★★ 色彩链修正（2026-09-21）：原实现只有「-colorspace/-color_primaries/-color_trc」
       这三个**输出选项** —— 它们只写元数据标签，**不改像素**。而 PNG 是 sRGB/全范围，
       隐式 RGB→YUV 转换用的是 swscale 默认，实测结果是：
         · 矩阵与范围**恰好正确**（BT.709 + limited，18% 灰存储 Y=117，理论值 117）
         · 但**传递函数没转**（像素里留的是 sRGB 曲线），且 ffprobe 读回
           `color_transfer=unknown / color_primaries=unknown` ⇒ **标签也没落全**
       后果（受控实测，详见 _tmp/_color_ab.py）：把成片交给「假定 BT.709」的播放器/NLE，
       中间调偏亮约 5~7 个灰阶（18% 灰 118 → 观感约 123；肤色 232,180,145 → 偏 7）。
       ⇒ 现改为 zscale **实转**（sRGB/full → BT.709/limited），与 MG-4K 通道同一口径。
       需要复现历史产物时用 `--color tag-only` 回到旧行为（旧 md5 只对得上那一种）。 */
    const vf = [];
    /* SSAA 降采样：截图是 w*ss × h*ss，这里 lanczos 收敛回目标尺寸。
       lanczos 比默认 bicubic 更能保住细线对比度（锐但不镶边）。
       必须在色彩转换**之前**做：降采样要在 RGB 线性域里完成。
       ★ 但 downscale=false 时**不降采样** —— 那条路是「拿 ss 当 4K 用」：
         视口保持设计尺寸(1920×1080) + dsf=2 ⇒ 截图 3840×2160 直接就是 4K，
         且文字/细线是**真 2× 重栅格化**（不是放大）。见 renderProject 的 outW/outH。 */
    if (o.ss > 1 && o.downscale !== false) vf.push(`scale=${o.w}:${o.h}:flags=lanczos`);
    if (o.color !== 'tag-only') {
      // Decoded reference-video assets already contain BT.709 signal values.
      // Preserve their transfer curve while still converting RGB->YUV using
      // the explicit 709 matrix and limited range, with metadata validation.
      const inputTransfer = o.color === 'preserve-709' ? 'bt709' : 'iec61966-2-1';
      vf.push('format=gbrp,zscale=matrixin=gbr:transferin=' + inputTransfer + ':primariesin=bt709:'
        + 'rangein=full:matrix=bt709:transfer=bt709:primaries=bt709:range=limited,format=yuv420p');
    }
    if (vf.length) outArgs.push('-vf', vf.join(','));

    outArgs.push('-c:v', 'libx264', '-preset', o.preset || 'slow',
                 '-crf', String(o.crf == null ? 16 : o.crf),
                 '-pix_fmt', 'yuv420p',
                 '-x264-params', 'aq-mode=3:aq-strength=1.0:psy-rd=1.0,0.15');
    if (o.color !== 'tag-only') outArgs.push('-color_range', 'tv');
    outArgs.push('-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709');
  }

  /* ★ SSAA 降采样已并入上面的 vf 链（必须在色彩转换之前），此处不再单独 push，
     否则会出现第二个 -vf ⇒ **后一个覆盖前一个**，zscale 静默失效。 */

  if (o.voice) {
    outArgs.push('-c:a', 'aac', '-b:a', '192k');
    outArgs.push('-t', String(o.dur)); // 与现有范式一致：严格限制成片时长（voice 短，末尾静止帧靠 -t 兜住）
  }
  args.push(...outArgs, o.out);
  return args;
}

// ---------------------------------------------------------------------------
// renderProject
// ---------------------------------------------------------------------------

/**
 * 渲染一个动效工程。
 * @param {object} cfg
 * @param {string} cfg.html        fx html 文件绝对路径
 * @param {string} cfg.out         输出文件绝对路径（.mp4；alpha=true 时必须 .mov）
 * @param {number} [cfg.fps]       默认 30
 * @param {number} [cfg.dur]       时长（秒）。不传则取 probe() 的 numberOfFrames/fps
 * @param {number} [cfg.w]         默认 1920
 * @param {number} [cfg.h]         默认 1080
 * @param {string} [cfg.voice]     配音 wav 绝对路径；不传则输出无音轨
 * @param {boolean} [cfg.alpha]    默认 false。true 时 screenshot 加 omitBackground，编码走 qtrle/prores_ks
 * @param {string} [cfg.framesDir] PNG 落盘目录，默认 <html 同目录>/frames
 * @param {boolean} [cfg.keepFrames] 默认 true（审判要用，别删）
 * @param {number} [cfg.parallel]  并行 Chrome 进程数，默认 min(4, os.cpus().length)
 * @param {boolean} [cfg.quiet]    默认 false，true 时 suppress 逐帧日志
 * @param {boolean} [cfg.pipe]     默认 false。true 时 PNG 走 stdin 管道**不落盘**（2026-09-21 加）
 * @param {number[]} [cfg.dumpFrames] pipe 模式下仍要落盘供「肉眼审判」的帧号
 * @param {'convert'|'tag-only'|'preserve-709'} [cfg.color] 默认convert=sRGB→709；preserve-709保留已解码709信号曲线，仍正确转换矩阵/范围；tag-only为历史兼容。
 *                                 tag-only = 旧行为（只打标签、不做传递函数转换，旧 md5 只对得上这一种）
 * @param {string} [cfg.preset]    x264 preset，默认 slow（旧行为）。赶时间可 fast
 * @param {number} [cfg.ss]        SSAA 超采样倍率 1~4，默认 1。
 *   ★ 4K 交付正确姿势 = **视口保持设计尺寸 + ss=2 + downscale=false**（DOM 页面）。
 * @param {boolean} [cfg.requireFill] 默认 false。true 时「版面指纹 body 宽 < 视口 90%」直接硬失败
 *   （不看铺满度 —— 覆盖「这次侥幸铺满、换段内容就露馅」）。
 * @param {number} [cfg.fillMin]   显式给一个绝对铺满度门禁（如 0.85）。
 *   ⚠️ 别默认开：实测 vga-signal 正确姿势下最大也只铺 80%×63%（设计本身带留白）。
 * @returns {Promise<{frames:number, out:string, seconds:number, framesDir:string,
 *                    shotSec:number, pipe:boolean, color:string, outW:number, outH:number,
 *                    ss:number, downscale:boolean, layout:object|null,
 *                    output:object|null, fill:object|null, fillVerdict:object|null}>}
 *          seconds = 本次渲染（含截图+编码）的墙钟耗时秒数
 */
async function renderProject(cfg) {
  if (!cfg || !cfg.html || !cfg.out) throw new Error('render-core: cfg.html 和 cfg.out 必填');

  const html = path.resolve(cfg.html);
  if (!fs.existsSync(html)) throw new Error(`render-core: html 不存在 ${html}`);

  const out = path.resolve(cfg.out);
  const alpha = !!cfg.alpha;
  const quiet = !!cfg.quiet;
  if (alpha && path.extname(out).toLowerCase() !== '.mov') {
    throw new Error(`render-core: alpha=true 时 out 必须是 .mov，当前是 ${path.extname(out)}`);
  }

  const framesDir = path.resolve(cfg.framesDir || path.join(path.dirname(html), 'frames'));
  fs.mkdirSync(framesDir, { recursive: true });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  /* ★ 清掉上一轮遗留帧（不清理 ⇒ 旧帧被当成本次输入，成片帧数被静默撑大，见函数注释）
     ⚠️ RENDER_CORE_KEEP_STALE=1 是**专给回归反例**留的缝：用它跑出「bug 存在」的样子，
        去证明「帧数判据真的会对它 FAIL」。产品链里永远别设这个变量。 */
  const staleFrames = process.env.RENDER_CORE_KEEP_STALE === '1' ? 0 : cleanStaleFrames(framesDir);
  if (staleFrames > 0 && !quiet) {
    console.log(`[render-core] 已清掉 framesDir 里 ${staleFrames} 张上一轮的 frame_*.png（不清会被 ffmpeg 当成本次输入）`);
  }
  if (cfg.pipe && !quiet) {
    console.log('[render-core] pipe 模式：本帧不落盘（仅 --dumpFrames 指定帧会写进 framesDir）');
  }

  if (cfg.voice && !fs.existsSync(cfg.voice)) throw new Error(`render-core: voice 不存在 ${cfg.voice}`);

  const t0 = Date.now();

  // --- 探测 ---
  const info = await probe(html, cfg);
  const fps = cfg.fps || info.fps || 30;
  const w = cfg.w || info.width || 1920;
  const h = cfg.h || info.height || 1080;
  /* 超采样倍率：与页面内 canvas 的 RS 必须一致（工程侧读 window.devicePixelRatio） */
  /* ★★ 4K 默认开启（2026-09-21 老板定）。
     ⚠️ 但有个防爆护栏：若调用方**显式**给了「像输出像素」的 w/h（≥2048），
        说明他要的就是那个尺寸、不是在描述设计画布 —— 此时默认不叠 ss，
        否则 `--w 3840` 会变成 7680 宽，白烧 4 倍时间。 */
  const explicitSS = cfg.ss != null;
  const looksLikeOutputSize = w >= 2048 || h >= 1152;
  const ssDefault = looksLikeOutputSize ? 1 : DEFAULT_SS;
  const ss = Math.max(1, Math.min(4, Math.round(explicitSS ? cfg.ss : ssDefault)));
  /* ★ 目标尺寸：downscale=false 时输出 = 视口 × ss（拿 ss 当 4K 用）。
     这是 DOM 页面出真 4K 的正确姿势：**视口必须保持设计尺寸**，靠 dsf 放大栅格化。
     反例（实测踩过）：给 1920 设计的页面直接 --w 3840，得到的是
     「4K 文件 + 左上角嵌一张 1080p」，而**文件尺寸判据照样 PASS** —— 判据盲区。 */
  const downscale = cfg.downscale === true;
  const outW = ss > 1 && !downscale ? w * ss : w;
  const outH = ss > 1 && !downscale ? h * ss : h;
  const is4k = outW >= 3840 && outH >= 2160;
  if (!explicitSS && looksLikeOutputSize) {
    console.warn(`[render-core] 注意：--w/--h = ${w}×${h} 看起来就是输出像素 ⇒ 本次**不叠 4K 默认倍率**`
      + `（否则会变成 ${w * DEFAULT_SS}×${h * DEFAULT_SS}）。想要 4K 请写「设计尺寸 + --ss 2 --noDownscale」。`);
  }
  const dur = cfg.dur != null ? cfg.dur : info.numberOfFrames / fps;
  const N = Math.floor(dur * fps) + 1; // 与现有 22 个工程一致：含首尾两帧
  /* ★ 引擎档位：声明必须在下面那条日志之前（否则 TDZ —— 踩过） */
  const engine = cfg.engine && ENG.PROFILES[cfg.engine] ? cfg.engine : 'safe';

  if (!quiet) {
    console.log(
      `[render-core] html=${path.basename(html)} ${w}x${h}@${fps} dur=${dur.toFixed(3)}s frames=${N} ` +
        `alpha=${alpha} voice=${cfg.voice ? path.basename(cfg.voice) : 'none'}`
    );
    /* ★ 输出尺寸与引擎档位必须打在最显眼处 —— 4K 默认开启后，
       「这条命令到底出多大」是调用方最需要确认的一件事（BUG-2398 的教训）。 */
    console.log(`[render-core] ★ 输出 ${outW}x${outH}${is4k ? '（4K）' : ''}`
      + ` · ss=${ss}${downscale ? '（SSAA 后降采样）' : ''} · 引擎=${engine}`
      + `（${engine === 'legacy' ? '旧路径=逐像素与历史一致'
        : engine === 'safe' ? 'CDP optimizeForSpeed＝像素与历史一致，约 2.25×'
        : 'GPU 光栅化＝约 3.20×，与历史最大差 9 灰阶，md5 会变'}）`);
    console.log(`[render-core] framesDir=${framesDir}`);
  }

  const chrome = resolveChrome(cfg.chromePath);
  const parallel = Math.max(1, cfg.parallel || Math.min(4, os.cpus().length));
  /* cfg.query：给同一个 HTML 渲染不同变体（如 '?v=strong' 走强化版分支）。
     不传时行为完全不变；传了 'v=strong' 这种不带问号的写法也认。 */
  const url = 'file:///' + html.replace(/\\/g, '/')
    + (cfg.query
        ? (/^[?#]/.test(cfg.query) ? cfg.query : '?' + cfg.query)
        : '');

  const pool = createPool(
    parallel,
    createWorkerFactory({
      url,
      w,
      h,
      ss,
      alpha,
      killRaf: cfg.killRaf !== false,
      settle: cfg.settle != null ? cfg.settle : 600,
      chrome,
      args: cfg.args,
      engine,
    })
  );

  // --- 版面指纹：先量一次「页面自己认为的设计尺寸」，给铺满度判据当参照系 ---
  // 借一个 worker 读一次就还回去（幂等、无副作用）；失败不影响渲染。
  let layout = null;
  try {
    layout = await pool.run((wk) => wk.layout());
    if (layout && !quiet) {
      console.log(`[render-core] 版面指纹 body=${layout.bodyW}x${layout.bodyH} `
        + `html=${layout.htmlW} 视口=${layout.vpW}x${layout.vpH} dpr=${layout.dpr}`);
    }
  } catch (_) { layout = null; }

  /* 引擎自述：把「实际用的哪条取帧路」写进 receipt —— 事后对账时
     「这条成片是 legacy 还是 fast 渲的」必须可查（左右 md5 口径）。 */
  let engineMeta = null;
  try {
    engineMeta = await pool.run((wk) => wk.engineMeta());
    if (engineMeta && !quiet) {
      /* ⚠️⚠️ 这一行**绝对不能出现裸花括号**（2026-09-21 实测踩到）：
         本工具 stdout 的事实契约是「末尾那个花括号块 = receipt」，而调用方普遍用
         `/\{[\s\S]*\}\s*$/` 这类**贪婪**正则从第一个 `{` 一口咬到末尾。
         原先这里打的是 `clip=${JSON.stringify(clip)}` ⇒ 而 clip 只有 cdp 引擎才有，
         于是这个花括号把 receipt 从中间截断，解析必然失败 ⇒ **引擎明明渲成功了却报 FAIL**
         （实测端到端 8 例：legacy 2 例全过、cdp 6 例全挂，分界线精确落在这行）。
         这是「静默假绿」的镜像 —— **静默假红**：把好产物判成坏，比假绿更容易被当成
         「环境抖动、重跑就好」而糊过去。
         ⇒ 改成紧凑文本形式：信息一个不少（尺寸/倍率/原点），但 stdout 里零花括号。 */
      const c = engineMeta.clip;
      console.log(`[render-core] 引擎 ${engineMeta.backend} 输出=${engineMeta.outW}x${engineMeta.outH} `
        + `ss=${engineMeta.ss} 尺寸自证=${engineMeta.verified ? 'PASS' : '待首帧'}`
        + (c ? ` clip=${c.width}x${c.height}@${c.scale} from(${c.x},${c.y})` : ''));
    }
  } catch (_) { engineMeta = null; }

  // --- 分片流水线：每批 parallel*2 帧，批内并发截图，然后按帧号顺序消费 ---
  // 不一次 submit 全部 N 个 promise（500 帧 × 4K PNG 会爆内存），
  // 而是批内并发截图、await 完再按序处理（落盘 或 写管道）、然后提交下一批。
  const batchSize = Math.max(1, parallel * 2);
  let mode = 'seekToFrame';
  let modeLocked = false;
  let modePromise = null;

  const drawFrame = (i) =>
    pool.run(async (worker) => {
      if (!modeLocked) {
        /* 探测只做一次：首批 parallel 个 worker 会同时冲进来（原来各自探测一遍 ⇒
           重复 4 次页面求值 + 日志打 4 行）。用一个共享 promise 收口，
           失败时所有等待者一起 reject（这正是我们要的）。 */
        if (!modePromise) {
          modePromise = worker.contract().then((c) => {
            const m = pickMode(c);
            if (!m) throw new Error(`render-core: ${path.basename(html)} 没有可驱动的帧函数（seekToFrame/__frame/__setT/renderAt/render 都没找到）`);
            mode = m;
            modeLocked = true;
            if (!quiet) console.log(`[render-core] 帧驱动契约 = ${mode}`);
            return m;
          });
        }
        await modePromise;
      }
      return worker.shoot(i, fps, mode);
    });

  /* ★ 管道模式（2026-09-21）：ffmpeg 先起，帧直接写 stdin。
     背压必须等 drain —— 不等的话 4K 大帧会在 Node 侧无上限堆积（MG-4K 通道同款教训）。 */
  const usePipe = !!cfg.pipe;
  const ffmpeg = resolveFFmpeg(cfg.ffmpegPath);
  const dumpSet = new Set((cfg.dumpFrames || []).map(Number));
  let ff = null, ffExit = null, ffErr = '';

  function mkArgs(pipeIn) {
    return buildFFmpegArgs({
      framesDir, fps, out, alpha, voice: cfg.voice, dur,
      alphaCodec: cfg.alphaCodec, w, h, ss, crf: cfg.crf,
      preset: cfg.preset, color: cfg.color, pipeIn, downscale,
    });
  }

  if (usePipe) {
    const args = mkArgs(true);
    if (!quiet) console.log(`[render-core] ffmpeg(pipe) ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);
    /* ★ stderr 落文件 + 退出判据用 `exit` 不用 `close`（2026-09-21 实测踩到：每片白等 302.5s）：
         `close` 要等**所有 stdio 流都关闭**才触发。4K `--pipe` 下实测 ffmpeg 进程**早就退出了**
         （产物 121 帧 + moov 全对、ffprobe 能正常解析），`close` 却始终不来 ⇒ 每次都白等到超时阈值
         （默认 max(300000, N*2500)，121 帧 = 302.5s）—— 端到端 wall 的 91% 是这段白等，不是渲染。
         两道修：① stderr 直写文件、不走管道（同族病：MEMORY「stdout 一律重定向到文件」）；
                 ② 判据换 `ff.on('exit')`（进程退出即判），exit 后留 120ms 让 stderr 落盘再读。
         超时兜底仍保留 —— 真挂死（进程不退出）时依然要靠它拦。 */
    const errPath = path.join(os.tmpdir(), `rc-ff-${process.pid}-${Date.now()}.log`);
    const errFd = fs.openSync(errPath, 'w');
    ff = spawn(ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', errFd] });
    ff.stdin.on('error', () => { /* 编码器提前退出时这里会 EPIPE，下面统一抛具体错误 */ });
    ffExit = new Promise((res, rej) => {
      ff.on('error', rej);
      ff.on('exit', (code) => setTimeout(() => {
        try { fs.closeSync(errFd); } catch (_) {}
        try { ffErr = fs.readFileSync(errPath, 'utf8').slice(-8000); } catch (_) {}
        try { fs.unlinkSync(errPath); } catch (_) {}
        if (code === 0) res();
        else rej(new Error(`render-core: ffmpeg 退出 ${code}\n${ffErr.slice(-3000)}`));
      }, 120));
    });
    ffExit.catch(() => { /* 防止 unhandled rejection */ });
  }

  let shotSec = 0;
  try {
    for (let start = 0; start < N; start += batchSize) {
      const end = Math.min(start + batchSize, N);
      const idx = [];
      for (let i = start; i < end; i++) idx.push(i);

      const buffers = await Promise.all(idx.map((i) => drawFrame(i)));

      // 严格按帧号顺序消费
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k];
        if (usePipe) {
          if (ff.exitCode !== null) {
            throw new Error(`render-core: 编码器提前退出（帧 ${i}/${N}）\n${ffErr.slice(-2000)}`);
          }
          if (!ff.stdin.write(buffers[k])) {
            await Promise.race([
              once(ff.stdin, 'drain'),
              ffExit.then(() => { throw new Error(`render-core: 编码器提前结束（帧 ${i}/${N}）`); }),
            ]);
          }
        } else {
          fs.writeFileSync(path.join(framesDir, `frame_${String(i).padStart(5, '0')}.png`), buffers[k]);
        }
        /* 抽帧审判用：管道模式下不给中间文件，但**必须能抽帧给人眼**，
           所以 dumpFrames 指定的帧照样落盘（放 framesDir，命名带 frame_ 前缀）。 */
        if (usePipe && dumpSet.has(i)) {
          fs.writeFileSync(path.join(framesDir, `frame_${String(i).padStart(5, '0')}.png`), buffers[k]);
        }
      }

      if (!quiet) {
        const el = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`[render-core] 帧 ${end}/${N}  (${((end / N) * 100).toFixed(0)}%)  ${el}s`);
      }
    }
  } finally {
    await pool.end().catch(() => {});
  }

  shotSec = (Date.now() - t0) / 1000;
  if (!quiet) console.log(`[render-core] 截图完成 ${N} 帧，耗时 ${shotSec.toFixed(1)}s → ffmpeg 合成`);

  // --- 合成 ---
  /* ★ 编码超时口径（两条路径共用，2026-09-21 实测踩到）：
     4K `--pipe` 下曾出现编码器**永不 finalize** —— 产物文件在、但没有 moov atom
     （ffprobe 报 `moov atom not found`），进程吃 4.4GB 内存、`await ffExit` 无限等。
     没有超时 = 整条渲染链静默挂死，比报错糟得多（没人知道它是死了还是在干活）。
     ★ 非管道路径**不是免疫**（同一套 x264 + 同一批并发截图进程），所以口径放这里共用。
     超时判定不靠猜：**用产物能不能被 ffprobe 解析当判据**（见下方核验段）。
     默认 = max(5 分钟, 帧数 × 2.5s)；可用 --encodeTimeout <ms> 覆盖。
     ⚠️ 2026-09-21 修正：这条等待曾经**每片白等满阈值**（判据用了 `close`，见下方 spawn 处注释），
     现在退出判据换成 `exit` ⇒ 正常路径应在百毫秒级返回。**若仍逼近阈值，那是真挂死，不是误判。** */
  const encTimeoutMs = cfg.encodeTimeoutMs || Math.max(300000, N * 2500);
  const tEnc = Date.now();
  if (usePipe) {
    if (!quiet) console.log('[render-core] 关 stdin，等编码器收尾…');
    ff.stdin.end();
    /* ★ 超时定时器**必须 clearTimeout**（2026-09-21 实测踩到，每片 4K 白等 299s 的真凶）：
         `Promise.race` **不是 canceller** —— 它只决定「谁先返回」，输的那一侧仍然活着。
         ffmpeg 实测 2.1s 就退出了（①日志），但那个 encTimeoutMs 的 timer 还挂在事件循环上，
         Node「有 pending timer 就不退出」⇒ 主流程早走完、进程却按到超时阈值才退
         （121 帧 ⇒ 302.5s）。指纹：**wall − 真实工作 ≈ 超时阈值，且跨例恒定**。
         ⇒ 换成显式 Promise，**两条路径都 clearTimeout**（正常退出 / 超时触发）。
         超时兜底本身不变：真挂死（进程不退出）时仍靠它拦。 */
    await new Promise((res, rej) => {
      const toTimer = setTimeout(() => {
        try { ff.kill('SIGKILL'); } catch (_) {}
        rej(new Error(`render-core: ★ 编码器收尾超时（${(encTimeoutMs / 1000).toFixed(0)}s 未退出）\n`
          + `  产物 ${out} 极可能**不完整**（无 moov atom，ffprobe 会报「moov atom not found」）⇒ **不可交付**。\n`
          + `  已知触发条件之一：4K + --engine fast + --parallel 8 + --pipe（8 个 GPU 光栅进程 + 4K x264 preset slow 互相抢）。\n`
          + `  处置：① 降 --parallel（实测 8~12 会反向变慢）② 换 --preset fast ③ 或去掉 --engine fast。\n`
          + `  编码器 stderr 尾部：${String(ffErr).slice(-400) || '(空)'}`));
      }, encTimeoutMs);
      ffExit.then(() => { clearTimeout(toTimer); res(); },
                  (e) => { clearTimeout(toTimer); rej(e); });
    });
    /* ★ 耗时分解日志：任何"白等"都能一眼定位到哪一段 */
    if (!quiet) console.log(`[render-core] ①编码器收尾 ${((Date.now() - tEnc) / 1000).toFixed(1)}s`);
  } else {
    let args = mkArgs(false);
    if (!quiet) console.log(`[render-core] ffmpeg ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);

    try {
      // ★ 接线：不传 timeoutMs ⇒ to=0 ⇒ spawnSync 无超时，护栏形同虚设（2026-09-21 补）
      runFFmpeg(ffmpeg, args, quiet, encTimeoutMs);
    } catch (e) {
      // alpha 模式编码失败时，prores_ks ↔ qtrle 互退一次
      if (alpha) {
        const fallback = cfg.alphaCodec === 'qtrle' ? 'prores_ks' : 'qtrle';
        console.warn(`[render-core] alpha 编码失败，回退 ${fallback}：${String(e.message).split('\n')[0]}`);
        args = buildFFmpegArgs({ framesDir, fps, out, alpha, voice: cfg.voice, dur, alphaCodec: fallback, w, h, ss, crf: cfg.crf, preset: cfg.preset, color: cfg.color });
        runFFmpeg(ffmpeg, args, quiet, encTimeoutMs);
      } else {
        throw e;
      }
    }
    if (!quiet) console.log(`[render-core] ①ffmpeg 合成 ${((Date.now() - tEnc) / 1000).toFixed(1)}s`);
  }

  // --- 产物核验（★ 拒错有牙：不合格就抛，不要静默交出去）---
  const tProbe = Date.now();
  const probeOut = probeOutput(out);
  const bad = [];
  if (!quiet) console.log(`[render-core] ②ffprobe 核验 ${((Date.now() - tProbe) / 1000).toFixed(1)}s`);
  if (probeOut) {
    if (probeOut.width !== outW) bad.push(`宽 ${probeOut.width}≠${outW}`);
    if (probeOut.height !== outH) bad.push(`高 ${probeOut.height}≠${outH}`);
    /* ★ 帧数判据（2026-09-21 补）：这条缺口正是「framesDir 旧帧污染成片」溜过去的门。
       实测 ffprobe 头部的 nb_frames 与 -count_frames 实数**完全一致**（181/181、31/31）
       ⇒ 免费拿到，容差 ±1（个别 muxer 会补尾帧）。 */
    if (probeOut.nb_frames != null && Math.abs(probeOut.nb_frames - N) > 1) {
      bad.push(`帧数 ${probeOut.nb_frames} ≠ 期望 ${N}`
        + `（常见病根：framesDir 里混进上一轮的 frame_*.png，旧帧被当成本次输入）`);
    }
    if (!alpha && cfg.color !== 'tag-only') {
      if (probeOut.color_transfer !== 'bt709') bad.push(`color_transfer=${probeOut.color_transfer}（应为 bt709）`);
      if (probeOut.color_primaries !== 'bt709') bad.push(`color_primaries=${probeOut.color_primaries}（应为 bt709）`);
      if (probeOut.color_range !== 'tv') bad.push(`color_range=${probeOut.color_range}（应为 tv）`);
    }
  } else {
    bad.push(`ffprobe 读不回产物：${out}`);
  }

  /* ★ 铺满度判据（见 probeFill 注释）：文件尺寸对了不等于画面对了。
     两级：
       Tier 1（无条件硬失败）—— 「版面指纹说页面按更小尺寸排版」**且**「渲染出来也真没铺满」。
               两个独立信号同时成立才判死，避免误伤靠绝对定位做满幅的页面。
       Tier 2（--requireFill 时硬失败）—— 用户显式要求严格：整条片子最大铺满度仍 < 阈值。
     自适应画布页（body 宽跟着视口走）不做绝对判据 —— 它想画多小就多小，绝对阈值没有意义。 */
  let fill = null;
  let fillVerdict = null;
  if (!alpha && probeOut) {
    const times = [0.1, 0.3, 0.5, 0.7, 0.9].map((p) => +(dur * p).toFixed(3));
    const tFill = Date.now();
    fill = probeFill(out, outW, outH, times);
    if (!quiet) console.log(`[render-core] ③铺满度采样 ${((Date.now() - tFill) / 1000).toFixed(1)}s`);
    if (fill) {
      const pct = `${(fill.ratioW * 100).toFixed(0)}% × ${(fill.ratioH * 100).toFixed(0)}%`;
      const detail = `内容最大铺满 ${pct}（采样 ${fill.samples.length} 帧，最佳 t=${fill.bestAt}s，`
        + `bbox ${fill.bbox[2] - fill.bbox[0] + 1}×${fill.bbox[3] - fill.bbox[1] + 1}，背景 ${fill.bg}）`;
      const thinW = fill.ratioW < 0.9;
      const thin = thinW || fill.ratioH < 0.9;
      /* 版面指纹：body 布局宽明显小于我们给的视口宽 ⇒ 页面是按更小尺寸排的版。
         只用 body 一个信号（实测三工程两视口，见 worker.layout 注释）：
           固定设计尺寸的 DOM 页 → 钉在 1920 ⇒ 放大视口时 0.50，抓得到；
           自适应 Canvas 页     → 跟视口走 ⇒ 恒 1.00，不误伤。 */
      const designW = layout ? layout.bodyW : 0;
      const staleVp = !!layout && designW > 0 && designW < w * 0.9;
      /* 绝对铺满度阈值只在用户显式给了数值时才启用（cfg.fillMin）。
         ★ 为什么不能默认 90%：实测 vga-signal 在**正确姿势**下最大也只铺
           80%×63% —— 那个工程的设计本身就带留白。拿绝对阈值当门禁 = 对正例报错。 */
      const fillMin = typeof cfg.fillMin === 'number' ? cfg.fillMin : null;
      fillVerdict = {
        tier: null, staleVp, designW, viewportW: w, fillMin,
        adaptive: !!layout && !staleVp,
      };
      if (staleVp && (thinW || cfg.requireFill)) {
        fillVerdict.tier = 'T1';
        bad.push(`${detail} —— 版面指纹 body=${designW} 却给了 ${w} 宽的视口：`
          + `页面是按 ${designW} 排的版，被塞进 ${outW} 的画布里 ⇒ 典型「大画布 + 小画面」。`
          + `DOM 页面出真 4K 请用「视口=设计尺寸(--w ${designW}) + --ss ${Math.max(2, Math.round(outW / designW))} --noDownscale」，`
          + `别直接放大 --w/--h`
          + (thinW ? '' : '（⚠️ 这次铺满度侥幸够，但版面已经是小尺寸排的 —— 换段内容就会露馅）'));
      } else if (fillMin != null && (fill.ratioW < fillMin || fill.ratioH < fillMin)) {
        fillVerdict.tier = 'T2';
        bad.push(`${detail} —— 已指定 --requireFill=${fillMin}，低于该铺满度即判死。`
          + '（若这个工程的设计本来就带留白，请别开这个开关）');
      } else if (staleVp && !cfg.requireFill) {
        fillVerdict.tier = 'W1';
        console.warn(`[render-core] ⚠ 版面指纹异常：body=${designW} < 视口 ${w} 的 90%。${detail}`);
        console.warn('              这次宽度侥幸够满，但页面确实是按小尺寸排的版 —— 加 --requireFill 可判死。');
      } else if (thin && !quiet) {
        /* 自适应页/带留白设计：低铺满度不代表有问题 ⇒ 只报信息，不报警告（防告警疲劳）。 */
        fillVerdict.tier = 'I';
        console.log(`[render-core] 铺满度 ${pct}（自适应=${fillVerdict.adaptive}）`
          + ' —— 低于 90% 但版面指纹正常 ⇒ 视为设计留白，不判死');
      } else if (!quiet) {
        console.log(`[render-core] 铺满度 ✓ ${pct}  背景 ${fill.bg}（自适应=${fillVerdict.adaptive}）`);
      }
    }
  }

  if (bad.length) {
    throw new Error(`render-core: 产物核验失败 →\n  - ${bad.join('\n  - ')}\n  ${out}`);
  }
  if (probeOut && !quiet) {
    console.log(`[render-core] 产物核验 ✓ ${probeOut.width}x${probeOut.height} `
      + `${probeOut.pix_fmt} range=${probeOut.color_range || 'n/a'} `
      + `transfer=${probeOut.color_transfer || 'n/a'} primaries=${probeOut.color_primaries || 'n/a'}`);
  }

  if (cfg.keepFrames === false) {
    fs.rmSync(framesDir, { recursive: true, force: true });
  }

  const seconds = (Date.now() - t0) / 1000;
  if (!quiet) console.log(`[render-core] 完成 ${out}  总耗时 ${seconds.toFixed(1)}s`);

  return {
    frames: N, out, seconds, framesDir, shotSec, staleFrames,
    pipe: usePipe, color: cfg.color || 'convert',
    outW, outH, ss, downscale, is4k, engine, engineMeta,
    layout, output: probeOut, fill, fillVerdict,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgv(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    let k = a.slice(2);
    /* 支持 `--key=value` 写法（--requireFill=0.85）：先按 = 拆开，value 走同一套类型推断 */
    let inlineVal;
    const eq = k.indexOf('=');
    if (eq >= 0) { inlineVal = k.slice(eq + 1); k = k.slice(0, eq); }
    if (k === 'no-keepFrames') { o.keepFrames = false; continue; }
    if (inlineVal !== undefined) {
      if (/^-?\d+(\.\d+)?$/.test(inlineVal)) o[k] = Number(inlineVal);
      else if (inlineVal === 'true' || inlineVal === 'false') o[k] = inlineVal === 'true';
      else o[k] = inlineVal;
      continue;
    }
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) { o[k] = true; continue; }
    if (/^-?\d+(\.\d+)?$/.test(next)) o[k] = Number(next);
    else if (next === 'true' || next === 'false') o[k] = next === 'true';
    else o[k] = next;
    i++;
  }
  return o;
}

/* ★ stdout 契约守卫（2026-09-21 加）——「钩子 + 兜底都做」的兜底那一半。
   契约：本工具 stdout 的**末尾那一块花括号 = receipt**，调用方普遍用
   `/\{[\s\S]*\}\s*$/` 这类贪婪正则从**第一个** `{` 一口咬到末尾。
   推论：只要渲染期间任何一条日志里出现裸花括号，receipt 就会被从中间截断，
   调用方解析失败 ⇒ **渲成功也判 FAIL**（静默假红，比假绿更难发现，
   因为它长得像「环境抖动」）。
   光把已知那一条改掉不够 —— 这属于「同一族还会复发」的土壤，所以这里留探针：
   不阻断，只在下一次有人写带花括号的日志时**当场喊话**并指出去哪看写法。
   receipt 本身就是花括号，所以打印前必须 off()，否则守卫会咬自己。 */
function installBraceGuard() {
  const raw = console.log.bind(console);
  const inner = console.error.bind(console);
  let warned = 0;
  let on = true;
  console.log = (...a) => {
    if (on && warned < 3 && a.some((x) => typeof x === 'string' && x.includes('{'))) {
      warned++;
      inner('[render-core] ⚠️ stdout 契约告警：上面这条日志含裸花括号 `{`，'
        + '会把 receipt 从中间截断（调用方贪婪解析失败）⇒ 渲染成功也会被判 FAIL。'
        + '请改成紧凑文本形式，范例见 engineMeta / clip 那行的写法。');
    }
    return raw(...a);
  };
  return { off() { on = false; console.log = raw; } };
}

async function main() {
  const a = parseArgv(process.argv.slice(2));
  if (a.probe) {
    const info = await probe(String(a.probe), { w: a.w, h: a.h, fps: a.fps, dur: a.dur });
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  if (!a.html || !a.out) {
    console.error('用法: node render-core.js --html <fx.html> --out <a.mp4> [--fps 30] [--dur 16.98] [--w 1920] [--h 1080] [--voice v.wav] [--alpha] [--framesDir d] [--no-keepFrames] [--parallel 4] [--quiet]');
    console.error('      node render-core.js --probe <fx.html>');
    console.error('');
    console.error('  4K / 提速相关（2026-09-21 新增）：');
    console.error('    ★★ 4K 现在**默认开启**：不写 --ss 时按 ss=2 出 3840×2160（视口保持设计尺寸）。');
    console.error('       退档 1080p：--ss 1        退档「SSAA 后降采样回设计尺寸」：--downscale');
    console.error('      ⚠️ --w/--h ≥2048 时不叠默认倍率（视为你显式给了输出像素），并会打印提醒。');
    console.error('    ★ DOM 工程出真 4K 的正确姿势（视口=设计尺寸，靠 dsf 放大栅格化）：');
    console.error('        --w 1920 --h 1080 --ss 2 --noDownscale      ⇒ 输出 3840×2160');
    console.error('      ⚠️ 直接 --w 3840 只会得到「4K 外壳 + 左上角 1080p」，文件尺寸判据照样 PASS');
    console.error('    --ss 1 / 2            超采样倍率（默认 2）；配合 --noDownscale 时输出 = 视口×ss');
    console.error('    --noDownscale         不把 w*ss 降回 w（拿 ss 当 4K 用）');
    console.error('    ★ --engine safe|fast|legacy   取帧引擎档位（默认 safe）');
    console.error('        safe   = CDP optimizeForSpeed + clip{scale} · **像素与历史逐位一致** · 约 2.25×');
    console.error('        fast   = 再开 GPU 光栅化 · 约 3.20× · 与历史最大差 9 灰阶（均值 1.03）⇒ md5 会变');
    console.error('        legacy = 旧路径（puppeteer screenshot + 关 GPU）· 只在需要复现历史产物时用');
    console.error('      实测出处：_tmp/_engine_final.cjs + _final_compare.py + _det_compare.py');
    console.error('    --pipe                帧走 stdin 管道，不落盘（省掉上千个中间 PNG）');
    console.error('    --dumpFrames 0,30,60  pipe 模式下仍要落盘给「肉眼审判」的帧号');
    console.error('    --color convert|preserve-709|tag-only  convert(默认)=sRGB→709；preserve-709=参考视频信号保真；tag-only=旧行为');
    console.error('    --preset slow|fast     x264 preset（默认 slow；赶时间用 fast）');
    console.error('    --requireFill          严判「版面指纹」：body 宽 < 视口 90% 即硬失败（不看铺满度）');
    console.error('    --requireFill=0.85     额外把「内容铺满度 <0.85」也当硬失败（⚠️ 设计本身带留白就别开）');
    console.error('    ★ 铺满度判据怎么读：');
    console.error('        T1 = 版面指纹异常(硬失败) · W1 = 版面指纹异常(宽侥幸够) · T2 = 用户指定阈值')
    console.error('        I  = 铺满度低但版面指纹正常 ⇒ 视为设计留白，不判死（防告警疲劳）');
    process.exit(1);
  }
  /* 守卫只在「渲染」这段路上装：--probe 那条路的整份输出本来就是 JSON，装了就误报。 */
  const braceGuard = installBraceGuard();
  const r = await renderProject({
    html: String(a.html),
    out: String(a.out),
    fps: a.fps,
    dur: a.dur,
    w: a.w,
    h: a.h,
    ss: a.ss,
    noDownscale: !!a.noDownscale,
    downscale: a.downscale === true ? true : (a.noDownscale ? false : undefined),
    engine: a.engine ? String(a.engine) : undefined,
    requireFill: !!a.requireFill,
    /* --requireFill=0.85 → 绝对铺满度门禁；裸 --requireFill → 只严判版面指纹 */
    fillMin: typeof a.requireFill === 'number' ? a.requireFill : undefined,
    voice: a.voice ? String(a.voice) : undefined,
    alpha: !!a.alpha,
    pipe: !!a.pipe,
    dumpFrames: a.dumpFrames
      ? String(a.dumpFrames).split(',').map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x))
      : undefined,
    color: a.color ? String(a.color) : undefined,
    preset: a.preset ? String(a.preset) : undefined,
    crf: a.crf,
    framesDir: a.framesDir ? String(a.framesDir) : undefined,
    keepFrames: a.keepFrames,
    parallel: a.parallel,
    quiet: !!a.quiet,
  });
  braceGuard.off(); // receipt 自己就是花括号，守卫必须先摘，否则咬自己
  console.log(JSON.stringify(r, null, 2));
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[render-core] ERR', e && e.stack ? e.stack : e);
    process.exit(1);
  });
}

/* resolveChrome 也导出：probe-lib.js 要复用同一份 chrome 候选表。
   ★ 单真源铁律（2026-09-11）：chrome 路径只允许存在一份。
   此前 22 个工程 / 165 支探针各自硬编码 'C:/Program Files/Google/Chrome/...'，
   属 BUG-2031/2033「一处改动漏同步另一处」的同一类土壤。 */
/* ★ 2026-10-08 追加导出（给 `kit/check_env.js` 环境自检复用，**不是为了让它自己找一套**）：
     loadPuppeteer  —— 自检用它报「puppeteer-core 从哪解析到的」；解析失败即自检的一项 FAIL
     resolveFFmpeg  —— 自检要和真渲染用同一份 ffmpeg 定位逻辑
     PUPPETEER_FROM —— 本进程实际解析到的路径（字符串），自检直接读，省一次 require */
module.exports = {
  renderProject, probe, probeOutput, probeFill, resolveChrome,
  resolveFFmpeg, loadPuppeteer, PUPPETEER_FROM,
};
