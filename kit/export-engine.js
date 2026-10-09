/* ============================================================================
 * kit/export-engine.js —— 渲染导出引擎（2026-09-21 主线自研 4K 轮）
 *
 * 职责（单一）：**把「页面上当前这一帧」变成一张真实像素的图**，尽量快、且自证。
 * 不管帧驱动（__frame）、不管工作池、不管 ffmpeg 合成 —— 那些仍归 render-core。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 为什么要有它：4K 下 `page.screenshot` 单帧 501.6ms，实测拆解发现三个独立杠杆
 *   （`_tmp/_bench_export3.cjs`，页面 vga-signal，真 4K = 视口 1920×1080 + dsf2）：
 *     ① `--disable-gpu` 硬关 GPU ⇒ 光栅化走软件            501.6 → 374.2  (×1.34)
 *     ② PNG 编码默认走「最小体积」而不是「最快」           374.2 → 196.8  (×1.86)
 *        正解 = CDP `Page.captureScreenshot({optimizeForSpeed:true})`
 *     ③ 打开 GPU 光栅化标志                                 196.8 → 135.7  (×1.45)
 *   合计 **×3.70**（全无损 PNG）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★★ 这个文件里最值钱的东西不是快路径，是**尺寸自证**。
 *
 * 踩过的坑（BUG-2402）：CDP `Page.captureScreenshot` **不给 `clip` 时无视
 * `deviceScaleFactor`**，直接返回 1920×1080。于是「optimizeForSpeed 76.4 ms/帧」
 * 是个 **1080p 的数**，当 4K 报出来就是假的 **6.4× 提速**。
 * 同一个病在本项目已经第三次换皮出现（元素盒≠墨迹盒 / 只查文字漏场景图 / 本例）：
 * **跑得快 ≠ 渲对了**。所以本引擎在第一帧就断言真实像素尺寸，不符**直接抛错**，
 * 绝不把「快」当成「对」交付出去。
 *
 * 另一个坑（BUG-2403）：早前的「4K 基准」把**视口放大**成 3840×2160（dsf=1）——
 * 那正是 BUG-2398 的病态姿势（4K 外壳 + 左上角 1080p），量出来的成本比真 4K 便宜
 * （308KB vs 715KB）。⇒ **测量必须与被测对象同口径**，否则基准自己就是反例。
 * ============================================================================ */

'use strict';

/* ---------------------------------------------------------------------------
 * Chrome 启动参数
 * ⚠️ 老代码硬写 `--disable-gpu`，那是「headless 不稳」年代的保险，
 *    代价是 4K 单帧 +127ms（501.6 → 374.2）。
 * ⚠️ `--force-color-profile=srgb` **不属于**这一组 —— 它是色彩链的前提，
 *    跟 GPU 开关无关，由 render-core 统一加。
 * ------------------------------------------------------------------------- */
const GPU_ARGS = [
  '--enable-gpu-rasterization',
  '--ignore-gpu-blocklist',
  '--enable-zero-copy',
  '--enable-accelerated-2d-canvas',
];

/* 档位（render-core 的 `--engine` 直接引用，保证「真源只有一处」）
 *   legacy —— 旧路径：puppeteer `page.screenshot` + 关 GPU
 *   safe   —— CDP `optimizeForSpeed` + `clip{scale:ss}` + 关 GPU
 *             ★ 实测与 legacy **逐像素完全一致（最大差 0）**，2.25×
 *   fast   —— 同 safe 但开 GPU 光栅化
 *             ★ 3.20×，代价 = 与 legacy 最大 9 灰阶 / 均值 1.03 的差（md5 会变）
 *   数字出处：`_tmp/_engine_final.cjs` + `_tmp/_final_compare.py` + `_tmp/_det_compare.py` */
const PROFILES = {
  legacy: { args: ['--disable-gpu'], backend: 'puppy' },
  safe: { args: ['--disable-gpu'], backend: 'cdp' },
  fast: { args: GPU_ARGS, backend: 'cdp' },
};
const PROFILE_NAMES = Object.keys(PROFILES);

const LAUNCH_ARGS = ['--force-color-profile=srgb', ...GPU_ARGS];

/* ---------------------------------------------------------------------------
 * 图像头部解析（零依赖）：给「尺寸自证」用
 * ------------------------------------------------------------------------- */
function pngSize(b) {
  if (!b || b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}
function jpegSize(b) {
  if (!b || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i < b.length - 8) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}
function imageSize(b) { return pngSize(b) || jpegSize(b); }

/* ---------------------------------------------------------------------------
 * assertDims —— 「跑得快 ≠ 渲对了」的落地点
 *
 * 抽成独立可测函数（不是为了复用，是为了**证明它不是恒真判据**）：
 *   自检问法「这条 PASS 若 bug 存在会变 FAIL 吗？」——
 *   反例验证见 `_tmp/_engine_ab.cjs`：拿一张**真的 1080p 图**去断言 4K，必须抛错。
 * 若这里写成 `imageSize(buf) && ...`（只要解得出来就算过），就会变成恒真判据。
 * ------------------------------------------------------------------------- */
function assertDims(buf, outW, outH, ctx) {
  const d = imageSize(buf);
  if (!d) {
    throw new Error('export-engine: 无法解析取帧图像头（既不是 PNG 也不是 JPEG）'
      + (ctx ? ` —— ${ctx}` : ''));
  }
  if (d[0] !== outW || d[1] !== outH) {
    throw new Error(
      `export-engine: ★ 取帧像素尺寸不符 —— 实际 ${d[0]}×${d[1]}，期望 ${outW}×${outH}`
      + (ctx ? `（${ctx}）` : '') + '。\n'
      + '  常见病根：① CDP 取帧漏了 clip{scale:ss} ⇒ 无视 deviceScaleFactor（BUG-2402）\n'
      + '            ② 视口被设成输出尺寸而不是设计尺寸 ⇒ 4K 外壳 + 左上角小画面（BUG-2398）\n'
      + '  「跑得快」不等于「渲对了」，这里直接判死，不把便宜的数交出去。');
  }
  return d;
}

/* ---------------------------------------------------------------------------
 * 后端选择
 *   cdp   —— CDP `Page.captureScreenshot`（默认；支持 optimizeForSpeed / clip）
 *   puppy —— puppeteer `page.screenshot`（兜底：CDP 不可用时的旧路径）
 * ------------------------------------------------------------------------- */
function pickBackend(opts) {
  if (opts.backend) return opts.backend;
  return opts.cdp ? 'cdp' : 'puppy';
}

/* ---------------------------------------------------------------------------
 * createExporter —— 交给 render-core 的 worker 用
 *
 * @param {object} page  puppeteer Page
 * @param {object} cdp   CDP session（可空；空则自动降级 puppy 后端）
 * @param {object} o
 *   @param {number} o.w      设计宽（CSS px）
 *   @param {number} o.h      设计高（CSS px）
 *   @param {number} o.ss     超采样倍率（输出 = w*ss × h*ss）
 *   @param {boolean} o.alpha 透明背景（alpha 通道成片用）
 *   @param {string} o.backend 'cdp' | 'puppy' | 'cdp-jpeg'
 *   @param {number} [o.jpegQuality]
 *   @param {boolean} [o.optimizeForSpeed=true]
 *   @param {boolean} [o.verifyDims=true]  第一帧是否断言尺寸（默认开，别关）
 * @returns {Promise<{grab:Function, meta:Function, backend:string}>}
 * ------------------------------------------------------------------------- */
async function createExporter(page, cdp, o) {
  const w = Math.round(o.w), h = Math.round(o.h);
  const ss = Math.max(1, Math.min(4, Math.round(o.ss || 1)));
  const outW = w * ss, outH = h * ss;
  const backend = pickBackend(Object.assign({ cdp: !!cdp }, o));
  const verifyDims = o.verifyDims !== false;
  const optimize = o.optimizeForSpeed !== false;

  /* 透明背景：CDP 没有 omitBackground 参数，等价做法是改「默认背景色覆盖」。
     puppeteer 的 omitBackground 内部走的就是这一条。 */
  if (o.alpha && backend !== 'puppy' && page && typeof page._client === 'function') {
    try {
      await page._client().send('Emulation.setDefaultBackgroundColorOverride',
        { color: { r: 0, g: 0, b: 0, a: 0 } });
    } catch (_) { /* 不支持则忽略，由后续尺寸/像素判据兜底 */ }
  } else if (o.alpha && cdp) {
    try {
      await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    } catch (_) { /* 同上 */ }
  }

  /* ★ clip 是「真 4K」的保险丝，不是可选优化：
     不加它，CDP 会无视 deviceScaleFactor 返回设计尺寸大小的图（BUG-2402）。 */
  const clip = { x: 0, y: 0, width: w, height: h, scale: ss };
  let verified = false;

  async function grab() {
    let buf;
    if (backend === 'puppy') {
      buf = await page.screenshot({ omitBackground: !!o.alpha, encoding: 'binary' });
    } else {
      const p = { format: backend === 'cdp-jpeg' ? 'jpeg' : 'png', clip };
      if (backend === 'cdp-jpeg') p.quality = o.jpegQuality == null ? 100 : o.jpegQuality;
      else if (optimize) p.optimizeForSpeed = true;
      const r = await cdp.send('Page.captureScreenshot', p);
      buf = Buffer.from(r.data, 'base64');
    }
    if (!buf || !buf.length) throw new Error('export-engine: 取帧返回空');

    if (verifyDims && !verified) {
      assertDims(buf, outW, outH, `设计 ${w}×${h} × ss${ss}`);
      verified = true;
    }
    return buf;
  }

  return {
    backend,
    outW,
    outH,
    ss,
    async grab() { return grab(); },
    meta() {
      return { backend, outW, outH, ss, alpha: !!o.alpha, optimize, verified,
               clip: backend === 'puppy' ? null : clip };
    },
  };
}

module.exports = {
  LAUNCH_ARGS, GPU_ARGS, PROFILES, PROFILE_NAMES,
  createExporter, assertDims, imageSize, pngSize, jpegSize, pickBackend,
};
