#!/usr/bin/env node
'use strict';

/**
 * quad_check.js —— 「合成后四查」探针（2026-09-13 立）
 * =====================================================================
 *       项目作者 2026-09-13 拍板：「合成之后 4 查这个可以有」。
 *
 * 为什么单独一道门
 * ---------------------------------------------------------------------
 *   L1（qc/qc_l1.py）查的是**文件层**（规格 / 响度 / 黑帧 / 闪烁）
 *   §5 F~J 查的是**单层内部**（摄像机轨道 / 元素参数 / 验收脚本自身）
 *   四查查的是**合起来之后才出现的问题** —— 单层各自合格，叠在一起才打架。
 *   这类问题只有看合成结果才发现，没有别的办法。
 *
 * 四查
 * ---------------------------------------------------------------------
 *   一查 看遮挡  文字有没有压住重点 / 字压字
 *   二查 看主次  同屏几组东西同时在动（>2 组 = 抢注意力）
 *   三查 看退场  该退的退干净没（残影 / 复活 / 硬切）
 *   四查 看交接  段间空窗 / 边界双主 / 段内构图跳变
 *
 * ★ 一条关键算法设计（别改回去）
 * ---------------------------------------------------------------------
 *   「看主次」判「元素自身是否在动」时，**必须扣掉相机公共位移**。
 *   相机推近会把所有元素一起放大平移，不扣的话每帧全员「活跃」，
 *   判据立刻变成常数报警 —— 等于没验。
 *   （与 probe-lib.js 里 dxw/dxs 的教训同源：屏幕量 ≠ 元素自身运动量）
 *   这里扣法：Δcx/Δcy 取全元素中位数、Δw 取相对缩放中位数，逐元素减掉。
 *
 * 用法
 * ---------------------------------------------------------------------
 *   node kit/quad_check.js <fx.html|工程目录> [选项]
 *     --dur 11.0                  片长（秒）；不传取 getInfo()/__dur，兜底 10
 *     --step 2                    采样步长（帧），默认 2（30fps → 15 采样/秒）
 *     --segments "0,3.5,7.2,11"   段边界；不给就按元素集合换血自动推断
 *     --json out.json             落盘机器可读报告
 *     --quiet                     只打印结论表
 *
 * 退出码：0 全 PASS（WARN 允许）/ 1 有 FAIL / 2 参数或环境错
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const P = require(path.join(__dirname, 'probe-lib'));

/* ============================== 阈值 ============================== */
/* 只拦离谱值；边界情况只出 NOTE。改阈值请连同 §6 文档一起改。 */
const TH = {
  minArea: 1200,       // px²  小于此面积忽略（噪音叶子）
  maxDepth: 8,         // 距 #stage 的最大层深
  minFont: 11,         // px   文字块最小字号
  bigAreaRatio: 0.08,  // 超视口此比例的元素不算「文字块」（是容器，不是字）
  maxTextH: 0.35,      // 文字块高度上限（视口比）
  textMaxLen: 60,      // 文字块自身文本最长字符数
  bgRatio: 0.85,       // 面积超视口此比例 = 背景层
  nestRatio: 0.90,     // 与更大元素相交超此比例 = 子层，去重丢弃
  areaLike: 0.85,      // 去重的面积前提：面积不到对方此比例的，是祖先而非子层，不吞
  occlRatio: 0.15,     // 相交 / min(面积) 超此值才算遮挡
  occlFail: 0.30,      // 字压字且占比达此值判 FAIL，否则 WARN
  minOcclArea: 4000,   // px²  相交面积下限，低于此不报（角标蹭到字这种）
  stillOp: 0.8,        // 「定住」判据：前后 2 采样帧 op 均需 ≥ 此值
  stillPx: 6,          // 「定住」判据：前后 2 采样帧位移/缩放均需 ≤ 此值
  activeOp: 6,         // 每秒帧内 opacity 变化 ×100 阈值
  activePx: 2,         // 每帧自身位移阈值 px
  activeScale: 0.02,   // 每帧自身缩放（相对）阈值
  activeMax: 2,        // 同屏活跃**事件**数上限，超此值 WARN
  activeFail: 5,       // 达到此值判 FAIL
  clusterPx: 180,      // 活跃元素聚类的中心距阈值：近于此距离视为同一视觉事件
  ownerRatio: 2.5,     // 归属判定：祖先面积 ≥ 自身此倍数时，该元素归入这个「层」
  gapStdRatio: 0.55,   // 空窗判据：画面亮度标准差低于全片均值此比例 = 信息量塌陷
  ghostOpLo: 0.02,     // 残影 opacity 上限
  ghostFrames: 5,      // 残影最少持续采样帧数
  hardCutOp: 0.5,      // 退场瞬间 op 高于此且一帧归零 = 硬切
  reviveNearSeg: 0.6,  // 「复活」豁免半径：离段边界近于此值的复活不报（跨镜复用）
  gapSec: 0.35,        // 空窗时长阈值（秒）
  jumpPx: 120,         // 段内构图质心跳变（px/帧）
  segJaccard: 0.45,    // 自动推断段边界：元素集合相似度低于此 = 边界
};

/* ====================== 页面内扫描（含去重） ======================
 * 传函数给 page.evaluate，puppeteer 序列化源码。禁反引号与可选链。
 * 返回本帧的语义块清单；qid 打在 DOM 上，跨帧稳定。
 */
function SCAN(cfg) {
  var stage = document.querySelector('#stage') || document.body;
  var vw = window.innerWidth, vh = window.innerHeight;
  var seq = window.__qseq || 0;

  function qidOf(el) {
    if (!el.__qid) { el.__qid = 'q' + (++seq); }
    return el.__qid;
  }
  function inter(a, b) {
    var x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    var y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return x * y;
  }
  function nameOf(el) {
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (typeof el.className === 'string' && el.className.trim()) {
      s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    }
    return s;
  }
  function alphaOf(bg) {
    if (!bg || bg === 'transparent') return 0;
    var m = /rgba?\(([^)]+)\)/.exec(bg);
    if (!m) return 1;
    var p = m[1].split(',');
    return p.length > 3 ? parseFloat(p[3]) : 1;
  }
  function hasBg(el) {
    var e = el;
    while (e && e !== document.body) {
      var cs = getComputedStyle(e);
      if (alphaOf(cs.backgroundColor) > 0.05) return true;
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
      e = e.parentElement;
    }
    return false;
  }

  /* ★★★ 2026-10-10 修 BUG-2215（第五例申报口径）：**有效不透明度 = 沿祖先链连乘**。
   *   旧写法只读元素自身 `cs.opacity` ⇒ 祖先 `opacity:0` 的子树照样进判据
   *   ⇒ 一查拿「观众根本看不见的字」去判「字压字」⇒ 幻影 FAIL。
   *   实测（uvc-en1）：当事元素自身 op=1、**祖先链连乘 = 0.000**，对面 0.998/1.000。
   *   ⚠️ 实现必须与 `kit/layout_check.js` L339 的**有效 opacity 链乘同源** ——
   *     两把门对同一元素给出相反结论时，人只会去改画面（假 FAIL 的真实危害）。
   *   ⚠️ 只乘到 `#stage` 为止，别把 `body/html` 的 opacity 也算进来。 */
  function effOp(el) {
    var o = 1, n = el;
    while (n && n.nodeType === 1) {
      o *= parseFloat(getComputedStyle(n).opacity);
      if (!(o > 1e-6)) return 0;              /* 已经不可见，别再往上算 */
      if (n === stage) break;
      n = n.parentElement;
    }
    return o;
  }
  /* rawOp / rawEop = **去重前**两张不透明度表，专供「复活」判据用。
   *   · rawOp  = 自身 op   —— 语义是「元素**自己**想不想显示」。
   *   · rawEop = 有效 op   —— 语义是「观众**看不看得见**」。
   *   三查「复活」必须用 rawOp（元素被父容器当子层吞掉时它明明还在画面上，
   *   只看有效 op 会把它误判成"退场"）；其余全部可见性判据用 rawEop/eop。
   *   ⚠️ 两张表都在 **opacity 门槛之前**记录，挪到 continue 之后就只剩半张表。 */
  var rawOp = {}, rawEop = {};

  var nodes = stage.querySelectorAll('*');
  var out = [];
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var tg = el.tagName;
    if (tg === 'SCRIPT' || tg === 'STYLE') continue;
    /* 先用零成本的 rect 粗筛，再调 getComputedStyle（它很贵） */
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    var area = r.width * r.height;
    if (area < cfg.minArea) continue;
    var d = 0, e2 = el;
    while (e2 && e2 !== stage) { d++; e2 = e2.parentElement; }
    if (d > cfg.maxDepth) continue;
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    var op = parseFloat(cs.opacity);          /* 自身 */
    var eop = effOp(el);                      /* 沿祖先链连乘（BUG-2215 修） */
    if (!el.__qid) { el.__qid = 'q' + (++seq); }
    rawOp[qidOf(el)] = op;
    rawEop[qidOf(el)] = eop;
    if (!(eop > 0.001)) continue;             /* 留一点，给残影判据 */
    /* 只认「自身直接文本节点」，这样同一块文字只落一层（叶子） */
    var own = '';
    for (var k = 0; k < el.childNodes.length; k++) {
      var n = el.childNodes[k];
      if (n.nodeType === 3) own += n.nodeValue;
    }
    own = own.replace(/\s+/g, ' ').trim();
    var fsz = parseFloat(cs.fontSize) || 0;
    var isText = own.length >= 1 && own.length <= cfg.textMaxLen &&
      fsz >= cfg.minFont && area < vw * vh * cfg.bigAreaRatio &&
      r.height < vh * cfg.maxTextH && tg !== 'SVG';
    /* plain = 无任何自身装饰的「壳」（文字容器这类）。
     * 壳必然被自己的文字盖住 —— 那不是遮挡，必须排除，否则每条文字都误报一次。 */
    var txtAll = el.textContent || '';
    var txtH = 0;
    for (var q = 0; q < txtAll.length && q < 80; q++) { txtH = (txtH * 31 + txtAll.charCodeAt(q)) | 0; }
    var plain = alphaOf(cs.backgroundColor) <= 0.05 &&
      (!cs.backgroundImage || cs.backgroundImage === 'none') &&
      (!cs.boxShadow || cs.boxShadow === 'none');
    /* （qid 已在上面的 `rawOp` 记录处赋过，这里不再重复赋 —— 见 BUG-2215 修） */
    var pe = el.parentElement;
    /* 祖先 qid 链：遮挡判据要靠它排除「容器 ∩ 自己的子元素」这种必然相交 */
    var anc = '', e3 = el.parentElement;
    while (e3 && e3 !== stage) { anc += '|' + qidOf(e3); e3 = e3.parentElement; }
    out.push({
      el: el, qid: qidOf(el), name: nameOf(el), depth: d, anc: anc,
      pkey: pe && pe !== stage ? qidOf(pe) : '',
      pname: pe && pe !== stage ? nameOf(pe) : '',
      x: +r.left.toFixed(1), y: +r.top.toFixed(1),
      w: +r.width.toFixed(1), h: +r.height.toFixed(1),
      cx: +(r.left + r.width / 2).toFixed(1), cy: +(r.top + r.height / 2).toFixed(1),
      area: area, op: op, eop: +eop.toFixed(4), isText: isText, own: own.slice(0, 20),
      hasBg: isText ? hasBg(el) : true, plain: plain, txtH: txtH,
      isBg: area >= vw * vh * cfg.bgRatio,
      blur: cs.filter !== 'none' && cs.filter.indexOf('blur(') >= 0,
    });
  }
  window.__qseq = seq;

  /* 非文字块去重：**面积相当且几乎完全重合**才算同一块的不同层。
   * ★ 必须带面积约束 —— 3D 场景容器（如 #cam 2443×1403）几何上包含所有后代，
   *   只按「相交/自身面积 > 0.9」会把全工程吞成一个块（2026-09-13 首跑实测教训）。 */
  var big = [], texts = [];
  out.sort(function (a, b) { return b.area - a.area; });
  for (var j = 0; j < out.length; j++) {
    var c = out[j];
    if (c.isText) { texts.push(c); continue; }
    var swallowed = false;
    for (var m = 0; m < big.length; m++) {
      var K = big[m];
      if (c.area < K.area * cfg.areaLike) continue;
      if (inter(c, K) / c.area > cfg.nestRatio) { swallowed = true; break; }
    }
    if (!swallowed) big.push(c);
  }

  /* 文字叶子归并：同一父元素下 ≥3 个文字叶子 = 逐字动画的单字 span，
   * 合成一个「文字组」（rect 取并集）。否则 40+ 个单字各自算一组，
   * 「二查·看主次」会把一次错峰入场误报成几十组同时抢注意力（首跑实测）。
   * ★ 组的 op 取成员**最大值**而非平均 —— 逐字入场是错峰的，取平均会把
   *   「组正在入场」这个事实抹平成一个缓慢的斜坡，反而判不出来。 */
  var byParent = {}, singles = [], groups = [];
  texts.forEach(function (t) {
    if (t.pkey) { (byParent[t.pkey] = byParent[t.pkey] || []).push(t); }
    else singles.push(t);
  });
  Object.keys(byParent).forEach(function (k) {
    var g = byParent[k];
    if (g.length < 3) { g.forEach(function (t) { singles.push(t); }); return; }
    var x0 = Math.min.apply(null, g.map(function (t) { return t.x; }));
    var y0 = Math.min.apply(null, g.map(function (t) { return t.y; }));
    var x1 = Math.max.apply(null, g.map(function (t) { return t.x + t.w; }));
    var y1 = Math.max.apply(null, g.map(function (t) { return t.y + t.h; }));
    var opMax = Math.max.apply(null, g.map(function (t) { return t.op; }));
    var eopMax = Math.max.apply(null, g.map(function (t) { return t.eop; }));
    var grp = {
      qid: k + '@grp', name: g[0].pname + '[+' + g.length + '字]', depth: g[0].depth,
      anc: g[0].anc,
      x: +x0.toFixed(1), y: +y0.toFixed(1), w: +(x1 - x0).toFixed(1), h: +(y1 - y0).toFixed(1),
      cx: +((x0 + x1) / 2).toFixed(1), cy: +((y0 + y1) / 2).toFixed(1),
      area: (x1 - x0) * (y1 - y0), op: +opMax.toFixed(3), eop: +eopMax.toFixed(3), isText: true,
      own: g.map(function (t) { return t.own; }).join('').slice(0, 20),
      hasBg: g[0].hasBg, isBg: false, blur: false, plain: false,
      txtH: g.reduce(function (a, t) { return (a ^ t.txtH) >>> 0; }, 0),
    };
    groups.push(grp); singles.push(grp);
  });

  /* 纯文字容器顶掉：与某个文字组几乎完全重合的非文字块（如 div#tA.ln 装 5 个 span）
   * 本质是同一块内容，留着会让「主次」重复计数。 */
  big = big.filter(function (b) {
    for (var i = 0; i < groups.length; i++) {
      if (inter(b, groups[i]) / Math.max(b.area, groups[i].area) > 0.85) return false;
    }
    return true;
  });

  /* rawOp / rawEop 已在扫描循环里建好（见文件上方注释）——此处不再重建。
   * 旧实现是 `rawOp[out[oi].qid] = out[oi].op`，只覆盖**过了 opacity 门槛**的元素；
   * 现在门槛用的是 `eop`，若还照旧跑一遍，被祖先链隐藏的元素就没有 rawOp ⇒
   * 「复活」判据会把"一直不可见"读成"退场又亮回"。表必须建在门槛之前。 */

  return { vw: vw, vh: vh, blocks: big.concat(singles), raw: out.length,
           rawOp: rawOp, rawEop: rawEop };
}

/* ================= 像素级空窗分析（抽灰度原始帧，本地算） =================
 * 为什么几何判据不够：模组淡出后画面**还剩半亮的文字**，
 * 「非背景可见元素数 = 0」这条永远不成立 —— 但导演看的是「没有承载物」。
 * 所以这里回到像素：抽 96×54 灰度帧算亮度标准差 YSTD 当「画面信息量」代理量，
 * 信息量塌陷 = 空窗。（灵感来自总监复核的四象限墨量法）
 *
 * ⚠ ffmpeg 的 signalstats **没有 YSTD**（只有 YAVG / YMIN / YMAX / SATAVG 等），
 *   曾经照抄「YSTD」这个名字写，结果 metadata 调了一整轮输出 0 行。
 *   现在直接抽 rawvideo 灰度帧自己算 —— 零依赖、口径可控。
 */
function analyzeVideo(video, th) {
  const { spawnSync } = require('child_process');
  if (!fs.existsSync(video)) throw new Error('视频不存在 ' + video);
  const W = 96, H = 54, FS = W * H, FPS = 15;
  const r = spawnSync('ffmpeg', [
    '-v', 'error', '-i', video,
    '-vf', 'scale=' + W + ':' + H + ',format=gray,fps=' + FPS,
    '-f', 'rawvideo', '-',
  ], { maxBuffer: 128 * 1024 * 1024 });
  if (r.error) throw r.error;
  const buf = r.stdout || Buffer.alloc(0);
  const n = Math.floor(buf.length / FS);
  if (n < 5) throw new Error('抽帧失败（' + buf.length + ' bytes = ' + n + ' 帧）');

  const rows = [];
  for (let i = 0; i < n; i++) {
    let s = 0, s2 = 0;
    const off = i * FS;
    for (let k = 0; k < FS; k++) { const v = buf[off + k]; s += v; s2 += v * v; }
    const mean = s / FS;
    rows.push({
      f: i, t: +(i / FPS).toFixed(3),
      ystd: +Math.sqrt(Math.max(0, s2 / FS - mean * mean)).toFixed(2),
      ymean: +mean.toFixed(1),
    });
  }

  const vals = rows.map(r => r.ystd);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const loThr = mean * th.gapStdRatio;

  const low = [];
  let run = null;
  rows.forEach(r => {
    if (r.ystd < loThr) {
      if (!run) run = { t0: r.t, t1: r.t, min: r.ystd };
      else { run.t1 = r.t; run.min = Math.min(run.min, r.ystd); }
    } else if (run) {
      if (run.t1 - run.t0 >= th.gapSec) low.push(finish(run, mean));
      run = null;
    }
  });
  if (run && run.t1 - run.t0 >= th.gapSec) low.push(finish(run, mean));

  function finish(r, m) {
    return {
      kind: '空窗', level: r.min < m * 0.3 ? 'FAIL' : 'WARN',
      t0: r.t0, t1: r.t1, dur: +(r.t1 - r.t0).toFixed(2),
      note: '画面信息量塌陷 YSTD 最低 ' + r.min.toFixed(1) + '（全片均值 ' + m.toFixed(1) + '）'
        + ' 持续 ' + (r.t1 - r.t0).toFixed(2) + 's —— 该时段几乎没有承载物',
    };
  }
  return { rows: rows, mean: +mean.toFixed(2), loThr: +loThr.toFixed(2), low: low };
}

/* ============================== 工具 ============================== */
function inter(a, b) {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return x * y;
}
function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const h = Math.floor(s.length / 2);
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}
function fmtT(t) { return Number(t).toFixed(2) + 's'; }

/* 并查集聚类：归为同一个「视觉事件」的两条依据（取或）
 *   ① 归属同一个「层」—— 最近的、面积 ≥ 自身 ownerRatio 倍的祖先块
 *      （l10 的 #tA~#tD 四行字都归入 #big，是一次错峰入场，不是四次抢注意力）
 *   ② 位置相交或中心距过近 —— 破碎碎片这一类 DOM 上不共享就近祖先的
 */
function cluster(items, th, blockMap) {
  const n = items.length;
  if (n <= 1) return items.map(x => [x]);
  const par = Array.from({ length: n }, (_, i) => i);
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  const uni = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) par[ra] = rb; };
  const owner = items.map(it => {
    if (!it.anc || !blockMap) return it.qid;
    const ids = it.anc.split('|').filter(Boolean);
    for (let i = 0; i < ids.length; i++) {
      const a = blockMap.get(ids[i]);
      if (a && a.area >= it.area * th.ownerRatio) return ids[i];
    }
    return it.qid;
  });
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const A = items[i], B = items[j];
      if (owner[i] === owner[j]) { uni(i, j); continue; }
      if (inter(A, B) > 0 || Math.hypot(B.cx - A.cx, B.cy - A.cy) < th.clusterPx) uni(i, j);
    }
  }
  const g = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!g.has(r)) g.set(r, []);
    g.get(r).push(items[i]);
  }
  return Array.from(g.values());
}

/* ============================ 一查 · 看遮挡 ============================
 * 两条降噪前提（首跑误报 50 条后加的，别删）：
 *   ① 排除祖先-后代对 —— 容器与自己的文字子元素几何上必然相交，那不是遮挡
 *   ② 只在**双方都定住且全可见**的帧判 —— 动画途中元素交错是正常现象，
 *      遮挡问的是「最终画面上字有没有压住重点」，不是运动过程中的瞬时穿插
 * 定级：字压字且占小者 ≥30% = FAIL（黑榜硬项）；其余 = WARN 交人眼。
 */
function checkOcclusion(frames, th) {
  const series = new Map();
  frames.forEach((f, i) => {
    f.blocks.forEach(b => {
      if (!series.has(b.qid)) series.set(b.qid, { pts: [] });
      series.get(b.qid).pts[i] = b;
    });
  });
  const nF = frames.length;

  function still(qid, i) {
    const s = series.get(qid);
    if (!s) return false;
    const a = s.pts[Math.max(0, i - 2)], b = s.pts[Math.min(nF - 1, i + 2)];
    if (!a || !b) return false;
    if (a.eop < th.stillOp || b.eop < th.stillOp) return false;
    if (Math.hypot(b.cx - a.cx, b.cy - a.cy) > th.stillPx) return false;
    if (Math.abs(b.w - a.w) > th.stillPx) return false;
    return true;
  }
  function isAnc(A, B) {
    if (!A.anc || !B.anc) return false;
    return A.anc.indexOf('|' + B.qid + '|') >= 0 || B.anc.indexOf('|' + A.qid + '|') >= 0;
  }

  const hits = new Map();
  frames.forEach((f, fi) => {
    const bs = f.blocks.filter(b => !b.isBg);
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        const A = bs[i], B = bs[j];
        if (!A.isText && !B.isText) continue;          /* 纯图形互压不管 */
        if (isAnc(A, B)) continue;
        const ia = inter(A, B);
        if (ia < th.minOcclArea) continue;
        /* 几乎完全重合 = 同一块的不同层（容器 vs 其内的字），不算遮挡 */
        if (ia / Math.max(A.area, B.area) > 0.9) continue;
        const ratio = ia / Math.min(A.area, B.area);
        if (ratio < th.occlRatio) continue;
        const stillBoth = still(A.qid, fi) && still(B.qid, fi);
        const both = A.isText && B.isText;
        const textSide = A.isText ? A : B;
        const otherSide = A.isText ? B : A;
        /* 有衬底 = 正常压叠；压的是「无装饰的壳」（文字容器）也不算遮挡 */
        if (!both && (textSide.hasBg || otherSide.plain)) continue;
        /* 定级：只有「字压字」在定住帧且占比够大才 FAIL。
         * 「文字压主体」一律 NOTE —— 自动判据分不清那个「主体」是卡片还是
         * 装饰性背景大字，报死了就是假 FAIL（§J：假 FAIL 会训练人忽略 FAIL）。
         * 这类交人眼扫一遍，B 站原意也是人看。 */
        let level = 'NOTE';
        if (both && stillBoth && ratio >= th.occlFail) level = 'FAIL';
        if (level === 'NOTE' && ratio < th.occlFail) continue;   /* 运动期只留明显的 */
        const key = A.qid + '|' + B.qid + '|' + level;
        const rec = {
          t: f.t, a: A.name, b: B.name, area: Math.round(ia),
          ratio: +ratio.toFixed(3),
          textA: A.isText ? (A.own || A.name) : '',
          textB: B.isText ? (B.own || B.name) : '',
          still: stillBoth, level: level,
          why: both ? '字压字' : '文字压主体（无衬底）',
        };
        const old = hits.get(key);
        if (!old || rec.ratio > old.ratio) hits.set(key, rec);
      }
    }
  });
  return Array.from(hits.values()).sort((a, b) => b.ratio - a.ratio);
}

/* ============================ 二查 · 看主次 ============================
 * ★ 扣相机公共位移后再判「谁在自己动」。见文件头「关键算法设计」。
 */
function checkAttention(frames, th, step) {
  /* qid -> {name, pts[]} */
  const series = new Map();
  frames.forEach((f, i) => {
    f.blocks.forEach(b => {
      if (b.isBg) return;                    /* 全屏容器/背景不进元素级判据 */
      if (!series.has(b.qid)) series.set(b.qid, { name: b.name, isText: b.isText, pts: [] });
      series.get(b.qid).pts[i] = b;
    });
  });

  const blockMap = new Map();
  frames.forEach(f => f.blocks.forEach(b => { if (!blockMap.has(b.qid)) blockMap.set(b.qid, b); }));

  const env = [];   /* 每帧：活跃元素列表 */
  for (let i = 1; i < frames.length; i++) {
    const dxs = [], dys = [], scl = [];
    series.forEach(s => {
      const a = s.pts[i - 1], b = s.pts[i];
      if (!a || !b) return;
      if (a.eop <= 0.05 && b.eop <= 0.05) return;
      dxs.push(b.cx - a.cx); dys.push(b.cy - a.cy); scl.push(b.w / Math.max(a.w, 1));
    });
    if (dxs.length < 3) { env.push(null); continue; }
    const mx = median(dxs), my = median(dys), ms = median(scl);
    const actives = [];
    series.forEach(s => {
      const a = s.pts[i - 1], b = s.pts[i];
      if (!a || !b) return;
      if (a.eop <= 0.05 && b.eop <= 0.05) return;
      const dop = Math.abs(b.eop - a.eop);
      const dxw = (b.cx - a.cx) - mx;
      const dyw = (b.cy - a.cy) - my;
      const dsc = Math.abs(b.w / Math.max(a.w, 1) - ms);
      const E = dop * 100 + Math.abs(dxw) + Math.abs(dyw) + dsc * 100 * 0.5;
      const on = dop * 100 > th.activeOp || Math.abs(dxw) > th.activePx ||
        Math.abs(dyw) > th.activePx || dsc > th.activeScale;
      if (on) actives.push({
        qid: b.qid, anc: b.anc, name: s.name, E: +E.toFixed(1), op: +b.eop.toFixed(2),
        x: b.x, y: b.y, w: b.w, h: b.h, cx: b.cx, cy: b.cy, area: b.area,
      });
    });
    actives.sort((a, b) => b.E - a.E);
    /* ★ 空间聚类：位置相邻/相交的运动元素属于**同一个视觉事件**（如破碎段的一堆碎片），
     * 不该按元素个数算组数 —— 否则凡密集动效必 FAIL，判据就废了。
     * 首跑在破碎段报「15 组同时运动」，实为一次破碎事件。 */
    const cls = cluster(actives, th, blockMap);
    env.push({ t: frames[i].t, n: cls.length, raw: actives.length, cls: cls, who: actives });
  }

  /* 合并连续超标帧成「段」 */
  const segs = [];
  let cur = null;
  env.forEach(row => {
    if (row && row.n > th.activeMax) {
      if (!cur) cur = { t0: row.t, t1: row.t, peak: row.n, raw: row.raw, who: row.who, cls: row.cls };
      else {
        cur.t1 = row.t;
        if (row.n > cur.peak) { cur.peak = row.n; cur.who = row.who; cur.cls = row.cls; }
        cur.raw = Math.max(cur.raw, row.raw);
      }
    } else if (cur) { segs.push(cur); cur = null; }
  });
  if (cur) segs.push(cur);

  return segs.map(s => ({
    t0: s.t0, t1: s.t1, dur: +(s.t1 - s.t0 + step / 30).toFixed(2),
    peak: s.peak, raw: s.raw, who: s.who.slice(0, 4),
    groups: s.cls.map(c => c.map(x => x.name).join('+')),
    level: s.peak >= th.activeFail ? 'FAIL' : 'WARN',
  })).filter(s => s.dur >= 0.1);   /* 单帧抖动不算 */
}

/* ============================ 三查 · 看退场 ============================
 * 残影：op 落在 (0, ghostOpLo] 且持续多帧 —— 该工程的 backdrop-filter op=0.003
 *       就是这样漏过「op>0.01 才算可见」的常规检查的。
 * 复活：退场后又亮起来（除非是设计上的二次入场，故只 WARN）。
 * 硬切：op 高值一帧归零（可能是设计，WARN 让人眼确认）。
 */
function checkExit(frames, th, segBounds) {
  const series = new Map();
  frames.forEach((f, i) => {
    f.blocks.forEach(b => {
      if (b.isBg) return;                    /* 全屏容器/背景不判退场 */
      if (!series.has(b.qid)) series.set(b.qid, { name: b.name, isText: b.isText, pts: [] });
      series.get(b.qid).pts[i] = b;
    });
  });

  const out = [];
  series.forEach((s, qid) => {
    const pts = s.pts;
    const idx = [];
    for (let i = 0; i < pts.length; i++) if (pts[i]) idx.push(i);
    if (idx.length < 4) return;

    /* 残影扫描：连续 op ∈ (0, lo] —— ★ 用**有效** op（观众看得见的那点亮度） */
    let run = 0, runStart = null;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k], op = pts[i].eop;
      if (op > 0 && op <= th.ghostOpLo) {
        if (run === 0) runStart = frames[i].t;
        run++;
      } else {
        if (run >= th.ghostFrames) {
          out.push({ kind: '残影', level: 'WARN', name: s.name,
            t0: runStart, t1: frames[idx[k - 1]].t, op: pts[idx[k - 1]].eop,
            note: 'op=' + pts[idx[k - 1]].eop.toFixed(3) + ' 残影，' + run + ' 采样帧仍 >0' });
        }
        run = 0;
      }
    }
    if (run >= th.ghostFrames) {
      out.push({ kind: '残影', level: 'WARN', name: s.name, t0: runStart,
        t1: frames[idx[idx.length - 1]].t, op: pts[idx[idx.length - 1]].eop,
        note: 'op 尾部残影 ' + run + ' 采样帧 >0' });
    }

    /* 首末可见 + 复活 + 硬切 */
    const vis = idx.filter(i => pts[i].eop > 0.05);
    if (!vis.length) return;
    const first = vis[0], last = vis[vis.length - 1];

    /* ★ 2026-09-14 修（假"复活"）：presence 不能只看"在不在去重后的语义集里"。
     *   元素被父容器当子层吞掉时 pts[i] 是空的，但它**明明还在画面上**。
     *   真实口径 = 去重前存在 且 op > 0.05。
     *   ⚠️ 这一条**刻意用 rawOp（自身 op）**，不是 rawEop：它要判的是
     *     「元素被打包吞掉了没有」，而"祖先把它藏了"是**真退场**、不该被算成"还在画面上"。
     *     两处修 BUG-2215 时最容易顺手改错的就是这一行 —— 改了会新增一批假"复活"。 */
    const vis2 = [];
    for (let i = 0; i < pts.length; i++) {
      if (pts[i] && pts[i].eop > 0.05) { vis2.push(i); continue; }
      const ro = frames[i].rawOp;
      if (ro && ro[qid] > 0.05) vis2.push(i);
    }
    for (let k = 0; k < vis2.length; k++) {
      if (k > 0 && vis2[k] - vis2[k - 1] > 3) {
        const tRev = frames[vis2[k]].t;
        /* 段边界附近的「复活」多为跨镜复用同一 DOM 元素（文字容器换内容），
         * 不是残影 —— 豁免，否则每换一镜必误报一次（首跑 4 条全是这种）。 */
        if ((segBounds || []).some(b => Math.abs(b - tRev) < th.reviveNearSeg)) continue;
        /* 同一段内也可能换内容复用（l10 的 #tA 一行行换字）：文本指纹变了就不是复活 */
        const bA = pts[vis2[k - 1]], bB = pts[vis2[k]];
        if (bA && bB && bA.txtH != null && bB.txtH != null && bA.txtH !== bB.txtH) continue;
        out.push({ kind: '复活', level: 'WARN', name: s.name, t0: frames[vis2[k - 1]].t,
          t1: tRev, note: '退场后又在 ' + fmtT(tRev) + ' 亮回 op=' + ((pts[vis2[k]] && pts[vis2[k]].eop) || 1).toFixed(2) });
      }
    }
    /* 硬切：末次可见 op 高，且紧接着掉到 < 0.05 */
    const opLast = pts[last].eop;
    const nxt = pts[last + 1];
    if (opLast > th.hardCutOp && nxt && nxt.eop <= 0.05 && frames[last].t > 0.3) {
      out.push({ kind: '硬切', level: 'WARN', name: s.name, t0: frames[last].t,
        t1: frames[last + 1] ? frames[last + 1].t : frames[last].t,
        note: 'op ' + opLast.toFixed(2) + ' → ' + nxt.eop.toFixed(2) + '（一帧，无淡出）' });
    }
  });
  return out;
}

/* ============================ 四查 · 看交接 ============================
 * 空窗：非背景可见元素数 = 0 且持续 —— 上轮 t=6.2~7.6 的 1.4s 空窗正是这条。
 * 边界双主：段边界 ±0.25s 内活跃组数超标（复用二查的 env）。
 * 段内跳变：面积加权质心位移超阈（换镜不算，只在段内判）。
 */
function checkHandoff(frames, th, segs, segBounds) {
  const out = [];
  const step = frames.length > 1 ? frames[1].t - frames[0].t : 0.0667;

  /* 空窗 */
  let run = 0, runStart = null;
  frames.forEach(f => {
    const n = f.blocks.filter(b => !b.isBg && b.eop > 0.05).length;
    if (n === 0) { if (run === 0) runStart = f.t; run++; }
    else {
      if (run * step >= th.gapSec) {
        out.push({ kind: '空窗', level: 'FAIL', t0: runStart, t1: f.t - step,
          dur: +(run * step).toFixed(2),
          note: '非背景可见元素数 = 0 连续 ' + (run * step).toFixed(2) + 's' });
      }
      run = 0;
    }
  });
  if (run * step >= th.gapSec) {
    const last = frames[frames.length - 1];
    out.push({ kind: '空窗', level: 'FAIL', t0: runStart, t1: last.t, dur: +(run * step).toFixed(2),
      note: '片尾空窗 ' + (run * step).toFixed(2) + 's' });
  }

  /* 边界双主 */
  segBounds.forEach(b => {
    if (b <= 0.01) return;
    const near = segs.filter(s => Math.abs(s.t0 - b) <= 0.25 || (s.t0 <= b && s.t1 >= b - 0.01));
    if (near.length) {
      const s = near[0];
      out.push({ kind: '边界双主', level: 'WARN', t0: b, t1: s.t1,
        note: '段边界 ' + fmtT(b) + ' 附近有 ' + s.peak + ' 组同时运动（' + s.who.map(w => w.name).join(' / ') + '）' });
    }
  });

  /* 段内构图质心跳变 */
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1], b = frames[i];
    if (segBounds.some(x => Math.abs(x - b.t) < 0.12)) continue;   /* 换镜点跳过 */
    const ca = centroid(a), cb = centroid(b);
    if (!ca || !cb) continue;
    const d = Math.hypot(cb.x - ca.x, cb.y - ca.y);
    if (d > th.jumpPx) {
      out.push({ kind: '构图跳变', level: 'NOTE', t0: a.t, t1: b.t,
        note: '质心位移 ' + d.toFixed(0) + 'px/帧（段内，非换镜点）' });
    }
  }
  return out;
}
function centroid(f) {
  let sx = 0, sy = 0, sw = 0;
  f.blocks.forEach(b => {
    if (b.isBg || b.eop <= 0.05) return;
    sx += b.cx * b.area; sy += b.cy * b.area; sw += b.area;
  });
  return sw ? { x: sx / sw, y: sy / sw } : null;
}

/* ======================= 段边界自动推断 =======================
 * 两路信号取或：元素集合换血（Jaccard 低）+ 构图质心跳变。
 * ⚠ 只对「文本内容变化但 DOM 复用」的工程（如 l10 的破碎段）Jaccard 会失灵，
 *   所以**推荐显式传 --segments**（从分镜表读段边界），推断仅作兜底。
 */
function inferSegments(frames, th) {
  const bounds = [frames[0].t];
  for (let i = 1; i < frames.length; i++) {
    const setA = new Set(frames[i - 1].blocks.filter(b => !b.isBg && b.eop > 0.05).map(b => b.qid));
    const setB = new Set(frames[i].blocks.filter(b => !b.isBg && b.eop > 0.05).map(b => b.qid));
    const uni = new Set([...setA, ...setB]);
    let ov = 0; setA.forEach(q => { if (setB.has(q)) ov++; });
    const jac = uni.size >= 3 ? ov / uni.size : 1;
    const ca = centroid(frames[i - 1]), cb = centroid(frames[i]);
    const jump = (ca && cb) ? Math.hypot(cb.x - ca.x, cb.y - ca.y) : 0;
    if (jac < th.segJaccard || jump > th.jumpPx * 1.6) bounds.push(frames[i].t);
  }
  bounds.push(frames[frames.length - 1].t);
  const out = [];
  bounds.forEach(b => { if (!out.length || b - out[out.length - 1] >= 0.4) out.push(b); });
  return out;
}

/* ═════════════════════ 自检（铁律 303：判据必须有牙） ═════════════════════
 * ★★★ 为什么现在才有：**「可见性必须沿祖先链连乘」这条铁律 2026-09-16 就立了**
 *   （`缺陷库` §7.1 第 65 条 · 防 BUG-2215），而本文件**一直没有自检夹具**
 *   ⇒ 工具 24 天没改、第四次踩到时我甚至没认出它，还写了一条新铁律准备"新开编号"。
 *   没有自检的判据 = 没有牙的判据：它错了没人会知道，直到有人拿它去打回一个**正确的画面**。
 *
 * 夹具设计 —— 两条必须**同时**成立，缺任意一条都是空判据：
 *   ✓ `.vis-a ∩ .vis-b`  真·字压字 ⇒ **必须**被判 FAIL（证判据有牙）
 *   ✗ `.hid-a ∩ .hid-b`  两字真几何重叠，但祖先 `#hidwrap{opacity:0}`
 *                        ⇒ **一个字节都不许报**（证 BUG-2215 已修）
 * 负控反证：把 `#hidwrap` 的 opacity 从 0 改回 1，同一条判据**必须**立刻报出来。
 *   不报 ⇒ 上面那条 ✓ 是碰巧，夹具本身是死的（BUG-2103 的教训：反例自己写错 = 判据是死的）。
 */
const FIXTURE_Q = [
  '<!doctype html><html><head><meta charset="utf-8"><style>',
  'html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden}',
  '#stage{position:fixed;left:0;top:0;width:1920px;height:1080px;background:#111}',
  '.vis-a,.hid-a{position:absolute;left:300px;top:300px;font-size:80px;',
  '  line-height:1.2;color:#fff;white-space:nowrap}',
  '.vis-b,.hid-b{position:absolute;left:380px;top:340px;font-size:80px;',
  '  line-height:1.2;color:#fff;white-space:nowrap}',
  '#hidwrap{position:absolute;left:0;top:0;width:1920px;height:1080px;opacity:0}',
  '</style></head><body><div id="stage">',
  '<div class="vis-a">AAAA</div><div class="vis-b">AAAA</div>',
  '<div id="hidwrap"><div class="hid-a">BBBB</div><div class="hid-b">BBBB</div></div>',
  '</div><script>',
  'window.__dur = 3.0;',
  'window.__frame = function(t){};',   /* 纯函数：本夹具几何恒定 */
  '<\/script></body></html>',
].join('\n');

async function selfTest() {
  const cfg = {
    minArea: TH.minArea, maxDepth: TH.maxDepth, minFont: TH.minFont,
    bigAreaRatio: TH.bigAreaRatio, maxTextH: TH.maxTextH,
    textMaxLen: TH.textMaxLen, bgRatio: TH.bgRatio, nestRatio: TH.nestRatio,
    areaLike: TH.areaLike,
  };
  /* 扫一遍夹具；`hidOpacity` 用来做「负控反证」——把它改回 1，判据必须立刻报出来 */
  const run = async (hidOpacity) => {
    const tmp = path.join(os.tmpdir(), 'quad_fixture_' + hidOpacity + '.html');
    fs.writeFileSync(tmp, FIXTURE_Q.replace(/opacity:0}/, 'opacity:' + hidOpacity + '}'), 'utf8');
    const p = await P.open(tmp, { ss: 1, settle: 300 });
    const frames = [];
    for (let k = 0; k <= 45; k++) {                 /* 3.0s / step 2 */
      const t = +(k * 2 / 30).toFixed(4);
      await p.frame(t);
      const sc = await p.page.evaluate(SCAN, cfg);
      frames.push({ t: t, vw: sc.vw, vh: sc.vh, blocks: sc.blocks, raw: sc.raw,
        rawOp: sc.rawOp, rawEop: sc.rawEop });
    }
    const errs = p.errors.slice();
    await p.close();
    try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ }
    return { o1: checkOcclusion(frames, TH), errs: errs };
  };

  console.log('\n═══ 自检：四查判据真的有牙吗（含 BUG-2215 祖先链负控）═══');
  const A = await run(0);
  const B = await run(1);
  if (A.errs.length) { console.log('  ⚠ 夹具页面错误 ' + A.errs.length + ' 条（数据不可信）'); }

  const txt = (hit) => (hit.a + ' ∩ ' + hit.b + ' ' + (hit.textA || '') + '|' + (hit.textB || ''));
  const visHit = A.o1.filter(h => /vis-a/.test(h.a + h.b) && h.level === 'FAIL');
  const hidHit = A.o1.filter(h => /hid-a|hid-b|hidwrap/.test(h.a + h.b));
  const hidHitB = B.o1.filter(h => /hid-a|hid-b|hidwrap/.test(h.a + h.b) && h.level === 'FAIL');

  const rows = [
    ['一查·真字压字被判 FAIL', visHit.length > 0,
      visHit.length ? txt(visHit[0]) + ' 占小者 ' + (visHit[0].ratio * 100).toFixed(0) + '%'
        : '**没抓到 ⇒ 判据无牙**'],
    ['一查·祖先 opacity:0 子树一字不报（BUG-2215）', hidHit.length === 0,
      hidHit.length ? '**报了 ' + hidHit.length + ' 条幻影**：' + txt(hidHit[0]) : '零幻影'],
    ['负控反证·同一夹具把祖先改回 opacity:1 必须报', hidHitB.length > 0,
      hidHitB.length ? '立刻报出 ' + txt(hidHitB[0]) + ' 占小者 ' + (hidHitB[0].ratio * 100).toFixed(0) + '%'
        : '**反证失败 ⇒ 上一条"零幻影"没有意义（判据本来就是死的）**'],
  ];
  let bad = 0;
  rows.forEach(r => {
    if (!r[1]) bad++;
    console.log('  ' + (r[1] ? '✓' : '✗') + ' ' + r[0].padEnd(46) + '  ' + r[2]);
  });
  /* 有效不透明度链乘的**算术**自检（不依赖页面） */
  const chain = (() => {
    const mk = (arr) => { let o = 1; arr.forEach(v => { o *= v; }); return o; };
    return { e1: mk([1, 1]), e2: mk([1, 0, 1]), e3: mk([0.5, 0.5]) };
  })();
  const chainOk = Math.abs(chain.e1 - 1) < 1e-9 && chain.e2 === 0 && Math.abs(chain.e3 - 0.25) < 1e-9;
  if (!chainOk) bad++;
  console.log('  ' + (chainOk ? '✓' : '✗') + ' ' + '有效不透明度连乘算术'.padEnd(46) +
    '  1×1=1 / 1×0×1=0 / 0.5×0.5=0.25');
  console.log(bad ? '\n自检失败：' + bad + ' 条（判据不可信，先修工具再谈片子）'
    : '\n自检通过：真字压字有牙 + 祖先链负控零幻影 + 负控反证成立。');
  process.exit(bad ? 1 : 0);
}

/* ============================== CLI ============================== */
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--quiet') { a.quiet = true; continue; }
    if (k === '--selftest') { a.selftest = true; continue; }   /* 无值开关，别被下面吃掉 */
    if (k.indexOf('--') === 0) { a[k.slice(2)] = argv[++i]; continue; }
    if (!a._) a._ = k;
  }
  return a;
}

(async () => {
  const a = parseArgs(process.argv.slice(2));
  if (a.selftest) return selfTest();
  if (!a._) {
    console.error('用法: node kit/quad_check.js <fx.html|工程目录> [--dur 11] [--step 2]'
      + ' [--video 成片.mp4] [--segments "0,3.5,7.2"] [--json out.json] [--quiet]'
      + '\n      node kit/quad_check.js --selftest     只跑判据自检（不开你的工程）');
    process.exit(2);
  }

  const step = +(a.step || 2);
  const p = await P.open(a._, { ss: 1, settle: 500 });
  const html = path.basename(p.html);

  /* 时长：参数 > getInfo()/__dur > 兜底 */
  let dur = a.dur ? +a.dur : null;
  if (dur == null) {
    const info = await p.info();
    if (info && info.durationInSeconds) dur = info.durationInSeconds;
    else if (info && info.dur) dur = info.dur;
    else {
      dur = await p.page.evaluate(function () {
        if (typeof window.__dur === 'number') return window.__dur;
        if (typeof DUR !== 'undefined') return DUR;
        return null;
      });
    }
  }
  if (dur == null) {
    console.warn('[quad_check] 页面未自报时长，兜底 10s（建议显式传 --dur）');
    dur = 10;
  }

  /* 逐采样帧扫描 */
  const frames = [];
  const cfg = {
    minArea: TH.minArea, maxDepth: TH.maxDepth, minFont: TH.minFont,
    bigAreaRatio: TH.bigAreaRatio, maxTextH: TH.maxTextH,
    textMaxLen: TH.textMaxLen, bgRatio: TH.bgRatio, nestRatio: TH.nestRatio,
    areaLike: TH.areaLike,
  };
  const nSamples = Math.floor(dur * 30 / step);
  for (let k = 0; k <= nSamples; k++) {
    const t = +(k * step / 30).toFixed(4);
    if (t > dur + 1e-6) break;
    await p.frame(t);
    const sc = await p.page.evaluate(SCAN, cfg);
    frames.push({ t: t, vw: sc.vw, vh: sc.vh, blocks: sc.blocks, raw: sc.raw,
      rawOp: sc.rawOp, rawEop: sc.rawEop });
  }
  await p.close();

  /* 段边界 */
  let segBounds;
  if (a.segments) segBounds = String(a.segments).split(',').map(Number).filter(n => !isNaN(n));
  else segBounds = inferSegments(frames, TH);

  /* 四查 */
  const o1 = checkOcclusion(frames, TH);
  const o2 = checkAttention(frames, TH, step);
  const o3 = checkExit(frames, TH, segBounds);
  const o4 = checkHandoff(frames, TH, o2, segBounds);

  /* 像素级空窗 —— 需 --video 指向成片。几何判据抓不到「有字但没主体」的空窗。 */
  let sig = null;
  if (a.video) {
    try {
      sig = analyzeVideo(path.resolve(a.video), TH);
      o4.push(...sig.low);
      o4.sort((x, y) => x.t0 - y.t0);
    } catch (e) { console.warn('[quad_check] 像素级空窗分析跳过：' + (e && e.message || e)); }
  }

  const lv = (arr) => arr.length ? (arr.some(x => x.level === 'FAIL') ? 'FAIL'
    : arr.some(x => x.level === 'WARN') ? 'WARN' : 'NOTE') : 'PASS';
  const r1 = lv(o1), r2 = lv(o2), r3 = lv(o3), r4 = lv(o4);
  const anyFail = [r1, r2, r3, r4].some(x => x === 'FAIL');

  const blockInfo = new Map();
  frames.forEach(f => f.blocks.forEach(b => {
    if (!blockInfo.has(b.qid)) blockInfo.set(b.qid, b);
  }));

  /* ---------------------------- 输出 ---------------------------- */
  const L = [];
  const bar = '='.repeat(66);
  L.push(bar);
  L.push('  合成后四查 · ' + html);
  L.push('  片长 ' + dur.toFixed(2) + 's / 采样 ' + frames.length + ' 帧'
    + '（step=' + step + '，30fps） / 语义块 ' + blockInfo.size + ' 个'
    + ' / 段边界 ' + segBounds.map(x => x.toFixed(2)).join(' → '));
  if (p.errors.length) L.push('  ⚠ 页面错误 ' + p.errors.length + ' 条（先修错，数据不可信）');
  L.push(bar);

  L.push('');
  L.push('── 一查 · 看遮挡 ' + '─'.repeat(46));
  if (!o1.length) L.push('  PASS  无字压字、无无衬底文字压主体');
  const o1main = o1.filter(x => x.level !== 'NOTE');
  const o1note = o1.filter(x => x.level === 'NOTE');
  o1main.forEach(x => L.push('  ' + x.level.padEnd(5) + fmtT(x.t).padEnd(8)
    + x.why + '  ' + x.a + ' ∩ ' + x.b
    + '  面积 ' + x.area + 'px²（占小者 ' + (x.ratio * 100).toFixed(1) + '%）'
    + ((x.textA || x.textB) ? '  文字侧 "' + (x.textA || x.textB) + '"' : '')));
  if (o1note.length) {
    L.push('  NOTE  另 ' + o1note.length + ' 处重叠发生在**运动过程中**'
      + '（破碎/飞入时的交错，多半是设计，扫一眼确认）：');
    o1note.slice(0, 8).forEach(x => L.push('        ' + fmtT(x.t).padEnd(8)
      + x.a + ' ∩ ' + x.b + '  占小者 ' + (x.ratio * 100).toFixed(0) + '%'));
    if (o1note.length > 8) L.push('        …另有 ' + (o1note.length - 8) + ' 处（详见 --json）');
  }
  L.push('  → ' + r1);

  L.push('');
  L.push('── 二查 · 看主次 ' + '─'.repeat(46));
  L.push('  阈值：同屏 >' + TH.activeMax + ' 个视觉事件 WARN，>=' + TH.activeFail + ' 个 FAIL'
    + '（事件 = 空间上相邻/相交的运动元素聚类，非元素个数）');
  if (!o2.length) L.push('  PASS  无同屏抢注意力时段');
  o2.forEach(s => {
    L.push('  ' + s.level.padEnd(5) + fmtT(s.t0) + '~' + fmtT(s.t1) + '（' + s.dur.toFixed(2) + 's）'
      + '  ' + s.peak + ' 个视觉事件同时运动（运动元素 ' + s.raw + ' 个，已聚类）');
    s.groups.slice(0, 4).forEach(g => L.push('        · ' + g));
  });
  L.push('  → ' + r2);

  L.push('');
  L.push('── 三查 · 看退场 ' + '─'.repeat(46));
  if (!o3.length) L.push('  PASS  无残影 / 无复活 / 无硬切');
  o3.filter(x => x.kind === '残影').forEach(x => L.push('  ' + x.level.padEnd(5) + '残影  '
    + x.name + '  ' + fmtT(x.t0) + '~' + fmtT(x.t1) + '  ' + x.note));
  o3.filter(x => x.kind === '复活').forEach(x => L.push('  ' + x.level.padEnd(5) + '复活  '
    + x.name + '  ' + fmtT(x.t0) + '→' + fmtT(x.t1) + '  ' + x.note));
  o3.filter(x => x.kind === '硬切').forEach(x => L.push('  ' + x.level.padEnd(5) + '硬切  '
    + x.name + '  @' + fmtT(x.t0) + '  ' + x.note));
  L.push('  → ' + r3);

  L.push('');
  L.push('── 四查 · 看交接 ' + '─'.repeat(46));
  if (sig) {
    L.push('  画面信息量：YSTD 逐帧亮度标准差，全片均值 ' + sig.mean
      + '，塌陷阈值 ' + sig.loThr + '，采样 ' + sig.rows.length + ' 帧');
  } else if (!a.video) {
    L.push('  ⚠ 未传 --video → 跳过像素级空窗检查（几何判据抓不到「有字但没主体」）');
  }
  if (!o4.length) L.push('  PASS  无空窗 / 边界无双主 / 段内无构图跳变');
  o4.forEach(x => L.push('  ' + x.level.padEnd(5) + x.kind + '  ' + fmtT(x.t0)
    + (x.t1 != null && x.t1 !== x.t0 ? '~' + fmtT(x.t1) : '') + '  ' + x.note));
  L.push('  → ' + r4);

  L.push('');
  L.push('─'.repeat(66));
  const fails = [['一查', r1], ['二查', r2], ['三查', r3], ['四查', r4]]
    .filter(x => x[1] === 'FAIL').map(x => x[0]);
  const warns = [['一查', r1], ['二查', r2], ['三查', r3], ['四查', r4]]
    .filter(x => x[1] === 'WARN').map(x => x[0]);
  L.push('  总评：' + (anyFail ? 'FAIL（' + fails.join('/') + ' 不合格）→ 打回重修'
    : warns.length ? 'PASS（' + warns.join('/') + ' 有 WARN，人眼确认）'
      : 'PASS（四查全清）'));
  L.push('  → 结论表抄进 分镜表.md 尾部「合成后四查」节，FAIL 项写进修修清单');

  const text = L.join('\n');
  if (!a.quiet) console.log(text);
  else console.log(text.split('\n').filter(l =>
    /^  (PASS|FAIL|WARN|→|总评)/.test(l) || /^──/.test(l)).join('\n'));

  if (a.json) {
    fs.writeFileSync(path.resolve(a.json), JSON.stringify({
      html: html, dur: dur, step: step, samples: frames.length,
      segBounds: segBounds, thresholds: TH, pageErrors: p.errors,
      verdict: { occlusion: r1, attention: r2, exit: r3, handoff: r4, overall: anyFail ? 'FAIL' : 'PASS' },
      occlusion: o1, attention: o2, exit: o3, handoff: o4, signal: sig,
    }, null, 2), 'utf8');
    console.log('  JSON → ' + path.resolve(a.json));
  }

  process.exit(anyFail ? 1 : 0);
})().catch(e => {
  console.error('[quad_check] 崩了：', e && e.message || e);
  process.exit(2);
});
