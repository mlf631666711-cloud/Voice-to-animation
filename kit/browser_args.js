/* kit/browser_args.js —— 判据用浏览器的**唯一**启动参数真源
 *
 * ★★★ 为什么要单独抽出来（2026-10-01 傍晚实测）：
 *   `kit/trial.js`（总审判器）与 `projects/C5-TINY-Game/v2/_probe_mad.cjs`（MAD 探针）
 *   各自写了一份 launch args，只有 `--hide-scrollbars` 是重合的：
 *     trial.js : --no-sandbox --force-device-scale-factor=1 --hide-scrollbars
 *                --disable-lcd-text --font-render-hinting=none
 *     probe    : --hide-scrollbars --allow-file-access-from-files --disable-gpu
 *   后果 —— **同一份 HTML、同一个 step，两个工具量出的 MAD 分布系统性不同**：
 *     v2  P90 9.54 vs 10.21 · max 10.92 vs 12.80
 *     L2  P90 1.76 vs 1.75 · max  8.41 vs  8.47（窗口不同，量级同）
 *     L3  P90 1.84 vs 2.12 · max  6.47 vs  6.65
 *   `--disable-lcd-text` / `--font-render-hinting=none` 改的是**字体抗锯齿**，
 *   `--disable-gpu` 换的是**光栅化后端** —— 两者都直接改逐像素差。
 *   ⇒ 这不是"哪个参数更对"，而是**两个判据必须共用同一套参数**，
 *     否则数值不可迁移、两个工具的结论会互相打架（我当时正是拿探针的结论去写了文档）。
 *
 * 用法：
 *   const ARGS = require('../../../kit/browser_args.js');   // 按相对深度调整
 *   await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ARGS });
 *
 * 纪律：**任何判据/探针/渲染脚本要用 Chrome 量像素，一律 require 本文件**。
 *      要加参数就加在这里（一处改、处处生效），不许在各自脚本里另起一份。
 */
'use strict';

module.exports = [
  '--no-sandbox',
  '--force-device-scale-factor=1',   /* 禁掉系统 DPI 缩放参与取像素 */
  '--hide-scrollbars',
  '--disable-lcd-text',              /* 关亚像素抗锯齿 ⇒ 灰度 AA，跨机器稳定 */
  '--font-render-hinting=none',      /* 关字体 hinting ⇒ 字形栅格化可复现 */
];
