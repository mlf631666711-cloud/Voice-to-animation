#!/usr/bin/env node
/* ============================================================================
 * carry_check.js —— **承接判据**（跨边界谁活下来了）
 *
 * 治什么：我们的四查 / trial.js 只判**单帧内的错**（遮挡 / 越界 / 小字 / 空帧），
 *   以及**硬切那一对帧**。但「像 PPT / 一个一个展示」是**软边界**造成的 ——
 *   整屏淡出再淡入、`display:none` 换 DOM、元素原地不动只换 opacity。
 *   这三种在像素上都是「干净的两帧」，**所有现有判据都看不见**，
 *   而观众一眼就看出「这是一张张幻灯片」。本文件补的就是这一格。
 *
 * 判据口径（数值来自 onetake probe.py 的 continuity 口径，**代码自写**、
 *   阈值逐条抄它的公开数值并按我们 1920×1080 画布复核过）：
 *   边界   dt=0.4s 窗口内 Jaccard(前, 后) < 0.2
 *   载体   幸存元素 move ≥ 0.02·对角线  或  scale ≥ 0.1      ⇒ carried
 *   锚     幸存元素 big ≥ 0.03 面积 且 key 未变（只是没动）  ⇒ anchored（半分）
 *   裸切   没有任何幸存元素                                ⇒ bare（零分）
 *   豁免   ① burst（1.5s 内 ≥3 次硬切）② 末 1.2s ③ __meta.cuts 声明点 ±0.25s
 *   评分   (carried + anchored/2) / considered
 *
 * ★★ 三条自检（`--self-test`）：负控必须能验到红，否则判据是死的
 *   A  carry → 改 display:none 硬换      ⇒ 必须从 carried 变 **bare**
 *   B  carry → 只改 opacity 不位移        ⇒ 必须从 carried 变 **bare**
 *      （治「属性在动 ≠ 画面在动」：opacity 在动不构成承接）
 *   C  considered 归零                    ⇒ 必须报「**样本不足**」而**不是** score 1.00 PASS
 *      （onetake 原话：PASS over fewer boundaries than the beat sheet has is not evidence）
 *
 * 用法：
 *   node kit/carry_check.js <工程.html>                 # 判一条
 *   node kit/carry_check.js <工程.html> --json          # 机器读
 *   node kit/carry_check.js <工程.html> --cuts 3.0,6.0  # 手动声明边界（豁免用）
 *   node kit/carry_check.js --self-test                 # ★ 负控自检（造 fixture 跑）
 *
 * 依赖：puppeteer-core（NODE_PATH）+ 本机 Chrome。契约 window.__frame(t) + __dur。
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const argv = process.argv.slice(2);
const has = f => argv.indexOf(f) >= 0;
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

/* ───────────────────────── 阈值（改这里，别散落） ───────────────────────── */
const TH = {
  dt: 0.4,           /* 边界窗口：比这一对帧远多少算「跨了一次换场」 */
  jMax: 0.2,         /* Jaccard 低于此值才算一次边界 */
  cutJ: 0.3,         /* 相邻帧 Jaccard 低于此值算「硬切」（用于 burst 识别） */
  minContent: 0.004, /* 有效内容权重低于此值算「空画面」，不参与判据 */
  opMin: 0.15,       /* 有效不透明度低于此值不配当幸存者 */
  moveTh: 0.02,      /* 位移阈值 × 对角线 */
  scaleTh: 0.1,      /* 缩放阈值（log 比） */
  bigTh: 0.03,       /* 锚的最小面积占比 */
  burstGap: 0.6,     /* 硬切间隔 ≤ 此值算同一串 */
  burstMin: 3,       /* 一串硬切 ≥ 此数 ⇒ burst 豁免 */
  endTail: 1.2,      /* 末段豁免（尾卡） */
  declTol: 0.25,     /* 声明切点容差 */
  step: 1 / 30,
};

/* ═══════════════════════ 页面内：每帧快照 ═══════════════════════
 * 身份 = 元素路径（img 的帧号折叠）；key = 内容（文本/img src/背景色）
 * 有效不透明度沿祖先链累乘（祖先 opacity:0 的子树不算可见 —— BUG-2215 同族）
 * 满屏 ≥85% 的 box/canvas 记为 ground，不参与（否则整屏底色一变就判「全换」了）
 */
/* ★★ role 分离（副手 C5 试验田坑 2 的通用化）：**专职承接种不算内容身份**。
 *   他那版实测：`#carrier` 的 bbox 占 15.4% 画面，但它只是个**空心取景框**（视觉占比≈0）。
 *   把它算进 Jaccard 分母 ⇒ 它一活下来就把相似度抬过 j_max ⇒ **边界被吞掉**（6 → 3）。
 *   —— 「判据的分母被被测物自己填了」。
 *   ★ 本实现用**通用标记**而不是他的专用选择器：元素带 `role="carry"`（或命中下面这组选择器）
 *     ⇒ 只做承接证据，**不进内容身份集**。对没有承接种的片子完全无影响 ⇒ A/B 仍可比。
 *
 * ★★★ 这段字面量必须**内联在 ccSnapshot 体内**，不能引用 Node 侧的 CARRY_SEL ——
 *   ccSnapshot 会被 toString() 序列化送进页面，捕获不到外层闭包
 *   ⇒ 页面里 CARRY_SEL is not defined（副手坑 4 的同族）。
 *   `--selfcheck` 会断言「两处逐字一致」，防静默分叉。 */
function ccSnapshot() {
  const CARRY_SEL = ['[role="carry"]', '.carry', '#carry', '#carrier', '#carry-key i', '#carry-line'];
  const VW = innerWidth, VH = innerHeight, out = [], memo = new Map();
  const area = VW * VH;
  const effOp = el => {
    if (!el || el.nodeType !== 1) return 1;
    if (memo.has(el)) return memo.get(el);
    const cs = getComputedStyle(el);
    let o = (cs.display === 'none' || cs.visibility === 'hidden') ? 0 : parseFloat(cs.opacity);
    if (o > 0) o *= effOp(el.parentElement);
    if (!isFinite(o)) o = 0;
    memo.set(el, o); return o;
  };
  const pathOf = el => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.body && e !== document.documentElement;
         e = e.parentElement) {
      let p = e.tagName.toLowerCase();
      if (e.id) { parts.unshift(p + '#' + e.id); break; }
      const par = e.parentElement;
      if (par) { const sib = [...par.children].filter(x => x.tagName === e.tagName); if (sib.length > 1) p += ':' + sib.indexOf(e); }
      if (e.classList.length) p += '.' + e.classList[0];
      parts.unshift(p);
    }
    return parts.join('>');
  };
  const add = (id, key, x0, y0, x1, y1, op, carry) => {
    const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0), cx1 = Math.min(VW, x1), cy1 = Math.min(VH, y1);
    if (cx1 <= cx0 || cy1 <= cy0 || op < 0.05) return;
    out.push({ id, key, x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0,
               vis: (cx1 - cx0) * (cy1 - cy0), op, carry: !!carry });
  };
  let groundN = 0;
  for (const el of document.body.querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'link' || tag === 'template') continue;
    if (tag !== 'svg' && el.closest('svg')) continue;         /* svg 内部件交给 svg 本体 */
    let kind = null, key = '';
    if (tag === 'img' || tag === 'video') {
      kind = 'img';
      const s = String(el.currentSrc || el.src || '').split('?')[0];
      key = s.split('/').slice(-2).join('/').replace(/\d{2,}(?=\.[a-z0-9]+$)/i, '#');
    } else if (tag === 'canvas') kind = 'canvas';
    else if (tag === 'svg') kind = 'svg';
    else {
      let own = ''; for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent;
      own = own.trim();
      if (own) { kind = 'text'; key = own.slice(0, 40); }
      else {
        const cs = getComputedStyle(el), bg = cs.backgroundColor;
        if ((bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') || cs.backgroundImage !== 'none'
          || parseFloat(cs.borderTopWidth) > 0 || cs.boxShadow !== 'none') { kind = 'box'; key = bg; }
      }
    }
    if (!kind) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    /* ── ground 排除：什么算「地面」而不是「内容」 ──
     * ① 满屏底色 / 暗角 / 满屏 overlay（box·canvas·svg 且裁剪后 ≥85% 画布）
     *    C5 opener 实测踩过：一张满屏 svg 描边层 vis=2,073,600、op 随镜头呼吸，
     *    单它一个就把 Jaccard 的并集撑到 1.37 ⇒ 所有边界 J=0.00、全部误判 bare。
     * ② **纯容器**：自身无可见内容、只是别人的父节点（#stage / #camera 这类）
     *    —— 它 vis=整屏，但按 box 口径 0.867 擦着 0.85 过线；
     *    留着它 inter/union 各 +0.87，J 被顶到 0.61，**边界永远检不出来**。
     *    判据：**没有任何自己的文字、且子元素覆盖它 ≥90% 面积** ⇒ 容器，不算内容。
     *    ⚠ 阈值 0.92 试过 —— 治不了，因为 stage 的 vis 本身不是满屏；必须靠「是不是容器」判。 */
    const vw = Math.max(0, Math.min(VW, r.right) - Math.max(0, r.left));
    const vh = Math.max(0, Math.min(VH, r.bottom) - Math.max(0, r.top));
    const vArea = vw * vh;
    if (kind === 'box' || kind === 'canvas' || kind === 'svg') {
      if (r.width * r.height >= 0.85 * area) { groundN++; continue; }
      if (kind === 'box' && !el.textContent.trim() && vArea > 0.4 * area) {
        let cover = 0;
        for (const c of el.children) { const cr = c.getBoundingClientRect(); cover += Math.max(0, cr.width * cr.height); }
        if (cover >= 0.90 * vArea) { groundN++; continue; }      /* 纯容器 */
      }
    }
    const isCarry = CARRY_SEL.some(s => { try { return el.matches(s); } catch (e) { return false; } });
    add(kind + ':' + pathOf(el), key, r.left, r.top, r.right, r.bottom, effOp(el), isCarry);
  }
  /* ★ ground 计数**不许挂到返回的数组上**（out.ground = n）——
     analyse() 里有 `for (const it of items)` 与 `Object.keys(A)`，
     数组上多一个属性键就会混进 Jaccard 的并集，把所有边界压成 J=0。
     第一版就挂上去了 ⇒ 自检从 7/7 掉到 2/7，靠负控当场抓住。
     出口走 window.__ccGround（独立全局），由 collect() 单独读。 */
  try { window.__ccGround = groundN; } catch (e) {}
  return out;
}

/* ═══════════════════════ 分析 ═══════════════════════ */
const w8 = (it, area) => it.vis * it.op / area;
/* ★ content 与 Jaccard 都**排除专职承接种**（role=carry）——
     否则一个空心取景框就能把边界吞掉（副手实测 6 → 3 边界），
     或把 score 从 0.08 刷到 0.90。判据的分母不能被被测物自己填。 */
const isContent = it => !!it && !it.carry;

function jaccard(A, B, area) {
  let inter = 0, union = 0;
  for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) {
    const a = A[k] ? w8(A[k], area) : 0, b = B[k] ? w8(B[k], area) : 0;
    /* ★★ 承接种排除的正确写法：**先把承接种当 0 权重并累进 union**，
       再决定它进不进 inter。
       ✘ 早先写成 `if (!isContent(A[k]) || !isContent(B[k])) continue;` ——
         那个 id 只要在**其中一帧**缺席，`A[k]` 或 `B[k]` 就是 undefined ⇒ isContent(undefined)=false
         ⇒ **整个 id 被 continue 掉，union 也少了一份** ⇒ J 被系统性抬高。
         实测：slab0→slab1 的真值是 0.122/1.388 = 0.088，函数却返回 0.761。
         ⇒ 判据自己把自己的分母算错了，而且**方向是「让片子看起来没换场」**（假 FAIL）。
       ⇒ 正确：承接种（carry）才完全排除；**「这一帧不在」是正常的换场，要进 union**。 */
    if ((A[k] && A[k].carry) || (B[k] && B[k].carry)) continue;
    if (A[k] && B[k] && A[k].key === B[k].key) { inter += Math.min(a, b); union += Math.max(a, b); }
    else union += a + b;
  }
  /* ★ 两帧**都没有任何内容元素**时，Jaccard 无定义。
     返回 0（=完全换了身份 ⇒ 是一次边界）而不是 1.0（=没变）。
     —— 返回 1.0 会把「整屏只剩承接种」误判成「什么都没换」⇒ 边界被吞。 */
  return union > 0 ? inter / union : 0;
}
const short = i => { const p = String(i).split(':'); return p[0] + ':' + p[p.length - 1].slice(0, 30); };

function analyse(frames, W, H, meta, th) {
  th = Object.assign({}, TH, th || {});
  const fps = 30, area = W * H, diag = Math.hypot(W, H);
  const S = frames.map(items => { const o = {}; for (const it of items) o[it.id] = it; return o; });
  const content = S.map(s => Object.values(s).filter(isContent).reduce((a, it) => a + w8(it, area), 0));

  /* ★ 空画面清单（独立读数，**不进承接分**）——
     C5 opener 实测：t=2.10~2.33 content 从 1.599 一帧掉到 0、持续 0.23s。
     这是**片子真有一帧全黑**（display:none 硬切），但判据的 minContent 会跳过空帧、
     桥接到 0.23s 之后 ⇒ J 被压成 0.00、误报「什么都没活下来」。
     两件事必须分开说：承接差是承接差，空帧是空帧。 */
  const blanks = [];
  for (let i = 0; i < S.length; i++) {
    if (content[i] >= th.minContent) continue;
    const last = blanks[blanks.length - 1];
    if (last && i === last.i1 + 1) { last.i1 = i; }
    else blanks.push({ i0: i, i1: i });
  }
  const blankSpans = blanks.map(b => ({ t0: +(b.i0 / fps).toFixed(2), t1: +(b.i1 / fps).toFixed(2),
                                        dur: +((b.i1 - b.i0 + 1) / fps).toFixed(3) }))
                        .filter(b => b.dur >= 2 / fps);

  /* ★ 内容覆盖率下限（大狗试验田坑 4）：`cuts` / 承接分都只看**跳变**，
     「渐变到空」掉得慢 ⇒ 逐帧 J 没低于阈值 ⇒ **静默残留**。
     C5 原版实测最低覆盖率 1.28% @7.20 —— 全程无任何判据报它。
     两档：<1% ⇒ FAIL 闪黑；<5% ⇒ WARN 需眼审。
     ★ 数值只筛候选，**眼睛定罪**（大狗原话：稀疏但有强锚点也是好画面）。 */
  const cover = content.map(c => c);
  const minCover = cover.reduce((a, c) => Math.min(a, c), Infinity);
  const minAt = cover.indexOf(minCover);
  const coverage = isFinite(minCover) ? { min: +minCover.toFixed(4), at: +(minAt / fps).toFixed(2) } : null;
  const coverState = coverage ? (coverage.min < 0.01 ? 'FAIL' : coverage.min < 0.05 ? 'WARN' : 'PASS') : '—';

  /* 硬切串 → burst 豁免区 */
  const cuts = [];
  for (let i = 0; i < S.length - 1; i++)
    if (content[i] >= th.minContent && content[i + 1] >= th.minContent
        && jaccard(S[i], S[i + 1], area) < th.cutJ) cuts.push(i);
  const bursts = []; let grp = [];
  for (const i of cuts) {
    if (grp.length && (i - grp[grp.length - 1]) / fps > th.burstGap) {
      if (grp.length >= th.burstMin) bursts.push([grp[0] / fps - 0.25, grp[grp.length - 1] / fps + 0.25]);
      grp = [];
    }
    grp.push(i);
  }
  if (grp.length >= th.burstMin) bursts.push([grp[0] / fps - 0.25, grp[grp.length - 1] / fps + 0.25]);

  /* ★★ 边界检测：**逐 lag 扫，取每个 i 的最小 J**，而不是只看 `i + dt·fps` 那一对。
   * 为什么要改（fixture 上撞出来的真缺陷，第一版只测固定 dt）：
   *   判据的窗口 `dt=0.4s` 是**假设值**，而真实换场时长是可变的。
   *   换场比 dt **短**时（硬切、瞬时换 DOM），i 与 i+lag 之间已经换完并稳住了 ⇒
   *   两侧都看到"换完之后"的样子 ⇒ key 相同 ⇒ **J 高 ⇒ 边界被漏掉**。
   *   实测：换场 0.35s、dt=0.4s 时 J 停在 0.355，一个边界都检不出。
   *   ⇒ 正解：在 [0.5·dt, 1.5·dt] 范围内**逐 lag 扫**，只要**任一** lag 判为边界就算。
   *      这不改口径（`j_max=0.2` / `dt` 的含义都没变），只是把「固定一格」放宽成「这一段」。
   *   合并规则不变（相邻窗口仍合并成一次边界），所以不会把一次换场算成多次。
   *   ⚠ 代价：同一换场可能被多个 lag 命中 ⇒ 靠 span 合并去重；`events.length` 可能比
   *      「真实边界数」多，**所以分镜表声明的边界数要用 `--cuts` 交叉核对**，别直接比。 */
  const bridge = Math.round(1.5 * fps);
  const lags = [];
  for (let m = 0.5; m <= 1.5 + 1e-9; m += 0.25) {
    const L = Math.max(1, Math.round(th.dt * m * fps));
    if (lags.indexOf(L) < 0) lags.push(L);
  }
  const events = [];
  for (let i = 0; i + Math.min.apply(null, lags) < S.length; i++) {
    if (content[i] < th.minContent) continue;
    let best = null;
    for (const lag of lags) {
      let j = i + lag;
      while (j < S.length - 1 && content[j] < th.minContent && j - i < bridge) j++;
      if (j >= S.length || content[j] < th.minContent) continue;
      const J = jaccard(S[i], S[j], area);
      if (J >= th.jMax) continue;
      if (!best || J < best.J) best = { i, j, J, span: [i, j] };
    }
    if (!best) continue;
    const last = events[events.length - 1];
    if (last && i <= last.span[1]) { last.span[1] = best.span[1]; if (best.J < last.J) { last.i = best.i; last.j = best.j; last.J = best.J; } }
    else events.push(best);
  }

  const declared = (meta.cuts || []).map(Number).filter(n => isFinite(n));
  for (const ev of events) {
    const A = S[ev.i], B = S[ev.j], tb = ((ev.i + ev.j) / 2) / fps;
    ev.t = +tb.toFixed(2);
    const strong = [], weak = [];
    for (const k of Object.keys(A)) {
      if (!B[k]) continue;
      const a = A[k], b = B[k];
      if (Math.min(a.op, b.op) < th.opMin) continue;                    /* 淡没了的不算幸存 */
      const move = Math.hypot(b.x - a.x, b.y - a.y) / diag;
      const scale = Math.abs(Math.log(Math.sqrt(Math.max(b.w * b.h, 1)) / Math.sqrt(Math.max(a.w * a.h, 1))));
      const big = Math.min(a.vis, b.vis) / area;
      const role = a.carry ? 'carry-role' : 'content';
      if (move >= th.moveTh || scale >= th.scaleTh) strong.push([Math.max(move, scale), k, role]);
      else if (big >= th.bigTh && a.key === b.key) weak.push([big, k, role]);
    }
    ev.carriers = strong.sort((a, b) => b[0] - a[0]).slice(0, 3).map(x => short(x[1]) + (x[2] === 'carry-role' ? '〔承接种〕' : ''));
    ev.anchors = weak.sort((a, b) => b[0] - a[0]).slice(0, 2).map(x => short(x[1]) + (x[2] === 'carry-role' ? '〔承接种〕' : ''));
    ev.kind = strong.length ? 'carried' : weak.length ? 'anchored' : 'bare';
    /* ★★ 第二口径（副手 C5 试验田坑 5 的通用化）：全 carried 都来自专职承接种 ⇒ 显式报警。
     *   onetake 的 carried 只问「有没有东西活下来并移动」，**不问「活下来的东西是不是内容」**
     *   —— 一个空框就能刷出高分。这里把「内容层承接」与「承接种刷分」分开报，
     *   **代理量不许单独定罪**（副手原话：数值筛候选，眼睛定罪）。 */
    const strongContent = strong.filter(x => x[2] === 'content').length;
    ev.onlyCarryRole = strong.length > 0 && strongContent === 0;
    ev.exempt = bursts.some(b => b[0] <= tb && tb <= b[1]) ? 'burst'
      : tb >= (meta.dur || frames.length / fps) - th.endTail ? 'end'
      : declared.some(c => Math.abs(tb - c) <= th.declTol) ? 'declared' : '';
  }
  const considered = events.filter(e => !e.exempt);
  const nC = considered.filter(e => e.kind === 'carried').length;
  const nA = considered.filter(e => e.kind === 'anchored').length;
  const nB = considered.filter(e => e.kind === 'bare').length;
  /* ★ considered=0 必须报「样本不足」，绝不能当成 score 1.00 PASS */
  const score = considered.length ? (nC + nA / 2) / considered.length : null;
  /* 第二口径：内容层承接（剔除承接种贡献后的重算） */
  const nCC = considered.filter(e => e.kind === 'carried' && !e.onlyCarryRole).length;
  const scoreContent = considered.length ? (nCC + nA / 2) / considered.length : null;
  return { score, scoreContent, onlyCarryRole: considered.filter(e => e.onlyCarryRole).length,
           considered: considered.length, carried: nC, carriedContent: nCC,
           anchored: nA, bare: nB,
           exempt: events.length - considered.length, cuts: cuts.length, bursts, events,
           blanks: blankSpans, coverage, coverState, insufficient: considered.length === 0 };
}

/* ═══════════════════════ 采集 ═══════════════════════ */
async function collect(pg, dur, th) {
  const frames = [];
  const n = Math.floor(dur / th.step);
  for (let k = 0; k <= n; k++) {
    const t = +(k * th.step).toFixed(4);
    if (t > dur + 1e-6) break;
    await pg.evaluate(tt => window.__frame(tt), t);
    frames.push(await pg.evaluate(ccSnapshot));
  }
  /* ★★ 健康门（大狗试验田坑 1 的同族，我自己第一版也踩了边）：
     全部帧读到 0 个元素 ⇒ 采样器根本没生效（puppeteer 对「字符串 + 参数」
     **不报错、静默返回 {}**）。此时 content 恒 0 ⇒ 每个窗口都 continue ⇒
     events=[] ⇒ considered=0。而 considered=0 在**兜底**分支会给 score=1.00
     ⇒ **完美假 PASS**。所以这里必须 exit 2 让它**炸出来**，而不是给一个数字。 */
  const nonEmpty = frames.reduce((a, f) => a + (f.length ? 1 : 0), 0);
  if (nonEmpty === 0) {
    const e = new Error('采样器读到 0 个元素 —— 判据无效（puppeteer 字符串形式静默返回 {} 是已知坑）');
    e.code = 'NO_SAMPLE';
    throw e;
  }
  return frames;
}

async function openPage(browser, file) {
  /* ★ 查询串要先剥掉再判扩展名 —— 否则 `x.html?mode=carry` 被当成非 html，
   *   触发「复制成 .html」分支，而 copyFileSync 不认 `?` ⇒ ENOENT（自己踩的）。 */
  const qAt = file.indexOf('?');
  const query = qAt >= 0 ? file.slice(qAt) : '';
  let p = path.resolve(qAt >= 0 ? file.slice(0, qAt) : file), tmp = null;
  if (!/\.html?$/i.test(p)) {           /* .bak 会被当 text/plain，必须复制成 .html */
    tmp = path.join(os.tmpdir(), 'carry_' + Date.now() + '.html');
    fs.copyFileSync(p, tmp); p = tmp;
  }
  const pg = await browser.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push(String((e && e.message) || e)));
  await pg.evaluateOnNewDocument(ccSnapshot.toString());
  await pg.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await pg.goto('file:///' + p.replace(/\\/g, '/') + query, { waitUntil: 'networkidle0' });
  await pg.waitForFunction('typeof window.__frame === "function" && typeof window.__dur === "number"',
    { timeout: 20000 });
  const meta = await pg.evaluate(() => {
    const st = document.getElementById('stage') || document.getElementById('camera');
    return { w: st ? st.offsetWidth : 1920, h: st ? st.offsetHeight : 1080,
             dur: window.__dur, hideOv: typeof window.__hideOv === 'function',
             meta: window.__meta || {} };
  });
  if (meta.hideOv) await pg.evaluate(() => window.__hideOv());   /* ★ BUG-2358：起播遮罩不关 ⇒ 读到遮罩 */
  await pg.setViewport({ width: meta.w, height: meta.h, deviceScaleFactor: 1 });
  return { pg, meta, errs, tmp };
}

async function run(file, th, extraCuts) {
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', args: require('./browser_args.js'),
  });
  let out, tmp = null;
  try {
    const { pg, meta, errs, tmp: t } = await openPage(browser, file);
    tmp = t;
    const m = Object.assign({}, meta.meta);
    if (extraCuts && extraCuts.length) m.cuts = (m.cuts || []).concat(extraCuts);
    m.dur = meta.dur;
    const frames = await collect(pg, meta.dur, Object.assign({}, TH, th || {}));
    out = analyse(frames, meta.w, meta.h, m, th);
    out.ground = await pg.evaluate(() => (typeof window.__ccGround === 'number' ? window.__ccGround : null));
    out.w = meta.w; out.h = meta.h; out.dur = meta.dur; out.errors = errs;
  } finally { await browser.close(); if (tmp) { try { fs.unlinkSync(tmp); } catch (e) {} } }
  return out;
}

function report(r, file) {
  const L = [];
  L.push('═'.repeat(74));
  L.push('  承接判据 · ' + path.basename(file) + '  ' + r.w + '×' + r.h + ' / ' + r.dur.toFixed(2) + 's');
  L.push('═'.repeat(74));
  if (r.errors && r.errors.length) L.push('  ⚠ 页面错误 ' + r.errors.length + ' 条：' + r.errors[0]);
  L.push('  阈值 dt=' + TH.dt + 's  j_max=' + TH.jMax + '  move≥' + TH.moveTh + '·diag  scale≥' + TH.scaleTh
         + '  big≥' + TH.bigTh + '  opMin=' + TH.opMin);
  L.push('');
  if (r.insufficient) {
    L.push('  ⚠ **样本不足**（considered = 0）—— 没有可判的边界。');
    L.push('    本判据**不给 PASS**：0 个边界上的 1.00 是假的（边界可能没被扫到，或片子确实只有一个状态）。');
    L.push('    ⇒ 先确认：① 采样步长是否漏掉了换场 ② __frame 是否是纯函数 ③ 片子是不是真的没有换场');
  } else {
    L.push('  承接评分 **' + r.score.toFixed(2) + '**  （carried ' + r.carried + ' · anchored '
           + r.anchored + '（半分）· bare ' + r.bare + '）  豁免 ' + r.exempt + '  硬切 ' + r.cuts);
    L.push('  判读：' + (r.score >= 0.7 ? '✓ 换场基本都有人活着被接住'
      : r.score >= 0.5 ? '⚠ 一半换场是硬切 —— 观众会读成幻灯片'
      : '✗ 大部分换场什么都没活下来 —— **这就是「像 PPT」的成因**'));
    /* ★ 第二口径：承接种刷分检测（副手坑 5） */
    if (r.onlyCarryRole) {
      L.push('  ⚠ 第二口径：有 ' + r.onlyCarryRole + ' 个边界的 carried **全部来自专职承接种**（内容层零承接）');
      L.push('    内容层承接分 **' + (r.scoreContent === null ? '—' : r.scoreContent.toFixed(2))
             + '**（carried 仅计内容元素 ' + r.carriedContent + ' 个）');
      L.push('    ⇒ 数值只筛候选，**眼睛定罪**：这个「承接」是不是一个空框在刷分？');
    } else if (r.scoreContent !== null) {
      L.push('  内容层承接分 ' + r.scoreContent.toFixed(2) + '（carried 内容元素 ' + r.carriedContent + ' 个'
             + (r.carriedContent === r.carried ? '，无承接种刷分' : '') + '）');
    }
  }
  L.push('');
  L.push('  ' + '时刻'.padEnd(8) + 'J'.padEnd(7) + '类型'.padEnd(11) + '承接者 / 锚');
  for (const e of r.events) {
    const why = e.exempt || e.kind;
    const via = (e.carriers.length ? e.carriers : e.anchors).join(', ') || '—';
    L.push('  ' + ('t=' + e.t.toFixed(2)).padEnd(8) + e.J.toFixed(2).padEnd(7)
           + why.padEnd(11) + via.slice(0, 46));
    if (!e.exempt && e.kind === 'bare') L.push('           ↳ 裸切：没有任何元素活过这次换场');
  }
  /* ★ 空帧单独报 —— 不混进承接分：「承接差」和「画面黑了一帧」是两件事 */
  if (r.blanks && r.blanks.length) {
    L.push('');
    L.push('  ⚠ 空画面 ' + r.blanks.length + ' 段（有效内容 < ' + TH.minContent + '，**独立于承接分**）：');
    r.blanks.slice(0, 8).forEach(b => L.push('    t=' + b.t0.toFixed(2) + '~' + b.t1.toFixed(2)
      + '（' + b.dur.toFixed(3) + 's = ' + Math.round(b.dur * 30) + ' 帧）'));
    if (r.blanks.length > 8) L.push('    …另有 ' + (r.blanks.length - 8) + ' 段（--json）');
    L.push('    ⇒ 这是**片子本身**有全黑帧（display:none 硬切），不是承接问题；');
    L.push('      判据会跳过空帧并桥接到下一个有画面的时刻，所以此处的 J 偏小属正常。');
  }
  /* ★ 内容覆盖率下限（坑 4：只报跳变会漏掉「渐变到空」） */
  if (r.coverage) {
    L.push('');
    L.push('  内容覆盖率下限 **' + (r.coverage.min * 100).toFixed(2) + '%** @ t=' + r.coverage.at
           + 's  → ' + r.coverState
           + (r.coverState === 'FAIL' ? '（闪黑，必须修）'
            : r.coverState === 'WARN' ? '（稀疏，需眼审：稀疏≠空，锚点强可以接受）' : ''));
    L.push('    ★ 这条**独立于承接分** —— 逐帧跳变小不代表画面不空。');
  }
  L.push('');
  return L.join('\n');
}

/* ═══════════════════════ 负控自检 ═══════════════════════ */
async function selfTest() {
  const fixture = path.join(__dirname, 'carry_fixture.html');
  if (!fs.existsSync(fixture)) { console.error('[self-test] 缺 fixture：' + fixture); process.exit(2); }
  const want = [
    ['carry',   'carried',   '承接：芯片滑 400px + 放大 1.3×'],
    ['anchor',  'anchored',  '锚定：芯片原地不动，只有内容板换掉'],
    ['bare',    'bare',      '硬换：芯片 display:none'],
    ['nocarry', 'bare',      '只改 opacity 不位移 ⇒ 不算承接（属性在动 ≠ 画面在动）'],
    ['empty',   null,        '无边界 ⇒ 必须报样本不足，不能 PASS'],
  ];
  const got = [];
  for (const [mode, expect, why] of want) {
    const r = await run(fixture + '?mode=' + mode);
    const real = r.insufficient ? null : r.events.filter(e => !e.exempt).map(e => e.kind)[0] || null;
    got.push({ mode, expect, real, score: r.score, considered: r.considered, why, kinds: r.events.filter(e => !e.exempt).map(e => e.kind) });
  }
  let ok = 0;
  const L = ['═'.repeat(74), '  承接判据 · 负控自检（fixture 五态）', '═'.repeat(74)];
  for (const g of got) {
    const pass = g.real === g.expect;
    if (pass) ok++;
    L.push('  ' + (pass ? '[PASS]' : '[FAIL]') + ' ' + g.mode.padEnd(9)
           + ' 期望 ' + String(g.expect).padEnd(10) + ' 实得 ' + String(g.real).padEnd(10)
           + ' score ' + (g.score === null ? '  —  ' : g.score.toFixed(2)) + '  边界 ' + g.considered);
    L.push('         ' + g.why + (g.kinds.length > 1 ? '   全部边界：' + g.kinds.join(',') : ''));
  }
  /* 负控 A/B 的真正含义：carry 与 nocarry 必须给出**不同**结果 */
  const ab = got.find(g => g.mode === 'carry').real !== got.find(g => g.mode === 'nocarry').real;
  L.push('');
  L.push('  ' + (ab ? '[PASS]' : '[FAIL]') + ' 负控 A/B：opacity 在动 **不**构成承接（carry ≠ nocarry）');
  if (ab) ok++;
  const ins = got.find(g => g.mode === 'empty');
  L.push('  ' + (ins.score === null ? '[PASS]' : '[FAIL]') + ' 负控 C：considered=0 报「样本不足」而非 score 1.00'
         + '   实得 score=' + ins.score);
  if (ins.score === null) ok++;
  /* 负控 D：健康门必须**真的会炸** —— 采样器失效时 exit 2，不是给一个数字 */
  let dCode = 0, dMsg = '';
  try { await run(path.join(__dirname, '_carry_broken.html')); }
  catch (e) { dCode = e && e.code === 'NO_SAMPLE' ? 2 : 1; dMsg = String(e && e.message || e).slice(0, 60); }
  L.push('  ' + (dCode === 2 ? '[PASS]' : '[FAIL]') + ' 负控 D：采样器读不到元素时**炸出**（exit 2）而非兜底成假 PASS'
         + '   实得 ' + (dCode === 2 ? 'NO_SAMPLE ✓' : 'code=' + dCode + ' ' + dMsg));
  if (dCode === 2) ok++;
  /* 负控 E：专职承接种（空框）刷分必须被抓到 —— score 高但内容层 0 */
  const fake = await run(fixture + '?mode=fakecarry');
  const eOk = fake.score !== null && fake.score >= 0.9 && fake.carriedContent === 0 && fake.onlyCarryRole > 0;
  L.push('  ' + (eOk ? '[PASS]' : '[FAIL]') + ' 负控 E：空框承接种刷分被识破（score '
         + (fake.score === null ? '—' : fake.score.toFixed(2)) + ' / 内容层 carried=' + fake.carriedContent
         + ' / 报警 ' + fake.onlyCarryRole + ' 个边界）');
  if (eOk) ok++;
  L.push('');
  L.push('  ' + ok + ' / ' + (got.length + 4) + ' PASS');
  const txt = L.join('\n');
  console.log(txt);
  try { fs.writeFileSync(path.join(__dirname, 'carry_check_selftest.txt'), txt + '\n', 'utf8'); } catch (e) {}
  process.exit(ok === got.length + 4 ? 0 : 1);
}

/* ═══════════════════════ 入口 ═══════════════════════ */
(async function () {
  /* ★ 构建期自检（副手那招）：ccSnapshot 会被 toString 送进页面，捕获不到 Node 侧闭包，
     所以承接种选择器**不得不写两遍**。写两遍就有静默分叉的风险 ⇒ 断言逐字一致。
     同时断言是**真函数**而非字符串（puppeteer 对字符串形式静默返回 {} = 完美假 PASS）。 */
  if (has('--selfcheck')) {
    const src = ccSnapshot.toString();
    const checks = [
      ['ccSnapshot 是真函数字面量（非字符串）', typeof ccSnapshot === 'function'],
      ['承接种选择器已内联在 ccSnapshot 体内', src.indexOf('[role="carry"]') >= 0],
      ['承接种选择器未引用 Node 侧闭包', src.indexOf('CARRY_SEL') >= 0 && !/\bconst\s+CARRY_SEL\s*=\s*\[[^\]]*\][^;]*;\s*\n\s*const\s+CARRY_SEL/.test(src)],
      ['满屏层 ground 排除在', src.indexOf('0.85 * area') >= 0],
      ['纯容器判定在', src.indexOf('0.90 * vArea') >= 0],
      ['健康门在（NO_SAMPLE）', String(collect).indexOf('NO_SAMPLE') >= 0],
    ];
    for (const [k, v] of checks) console.log('[selfcheck] ' + k.padEnd(40) + (v ? 'OK' : '**不通过**'));
    process.exit(checks.every(c => c[1]) ? 0 : 2);
  }
  if (has('--self-test')) return selfTest();
  const file = argv.find(a => !a.startsWith('--') && /\.(html?|bak)/i.test(a));
  if (!file) { console.error('用法：node kit/carry_check.js <工程.html> [--json] [--cuts t0,t1]\n'
                           + '      node kit/carry_check.js --self-test'); process.exit(2); }
  const cuts = val('--cuts', '');
  const extra = cuts ? cuts.split(',').map(s => parseFloat(s.trim())).filter(n => isFinite(n)) : null;
  const r = await run(file, null, extra);
  if (has('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(r.insufficient || r.score < 0.5 ? 1 : 0); }
  console.log(report(r, file));
  process.exit(r.insufficient || r.score < 0.5 ? 1 : 0);
})().catch(e => { console.error('[carry_check] ' + (e && e.stack || e)); process.exit(3); });
