#!/usr/bin/env node
/* =============================================================================
 * daily_archive.js —— 每日归档守卫（防总文档断档）
 *
 * 由来：老板 2026-09-10 定规矩 —— 「每天开始新对话时跑一遍昨天的项目记忆和
 *       更新日志，归档到总文档，总文档不要断档」。
 *       起因是星角萌萌段 1 / 透明叠加层干了活没写日志、段 3 md5 漂移没跟，
 *       总文档出现三处缺口。
 *
 * 用法：
 *   node kit/daily_archive.js                 # 默认扫「昨天 00:00 至今」的产物
 *   node kit/daily_archive.js --date 2026-09-09
 *   node kit/daily_archive.js --since 48      # 最近 48 小时
 *   node kit/daily_archive.js --all           # 全量体检（不按时间过滤）
 *
 * 它查四件事（不写任何文件，只报告）：
 *   ① 新产物漏记 —— 昨天产出的 mp4/mov/html，在每日更新日志里有没有被提到
 *   ② md5 漂移   —— 文档里记的 md5 与磁盘实测是否一致（BUG-1919 同类）
 *   ③ 工程孤儿   —— 有产物但项目记忆 §2 工程总表里查无此工程
 *   ④ 日志断档   —— 哪些日历日有产出但日志里没有对应条目
 *
 * 退出码：0 = 无缺口 / 1 = 有缺口需要补
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
// 扫描根：三根 —— 本项目工程树 + 副手岗工作区 + 旧版 CGI 工程树。
//   ⚠️ 2026-09-16 补第 3 根：`语音转动画总项目/01-VGA中文五段` ~ `06-星角萌萌` 这些交付
//      入口 **全是 symlink**，指向 `video-style-lab/projects/<工程>`；而该树本身不在旧扫根里
//      ⇒ 整棵旧工程树（77 个成片）从未被扫过，报告却照常输出「扫到成片 19 个」+ 无缺口，
//      属于**自信的假通过**（比缺口本身更危险）。
const LEGACY_TREE = path.resolve(ROOT, '..', 'video-style-lab', 'projects');
// 可用环境变量 DA_ROOTS 覆盖（逗号分隔）：DA_ROOTS="E:/a,E:/b" node kit/daily_archive.js
const SCAN_ROOTS = (process.env.DA_ROOTS
  ? process.env.DA_ROOTS.split(',').map(s => s.trim())
  : [path.join(ROOT, 'projects'), path.join(ROOT, '大狗', 'works'), LEGACY_TREE]
).map(p => path.resolve(p));
// 工程孤儿判定只在「正式工程树」（projects/）做。大狗/works 是副手工作区，
// 其下成片按老板 2026-09-16 口径不强制进 §2（副手项目归口资产库/output，收集中，先不动）。
const ORPHAN_ROOTS = (process.env.DA_ORPHAN_ROOTS
  ? process.env.DA_ORPHAN_ROOTS.split(',').map(s => s.trim())
  : [path.join(ROOT, 'projects')]
).map(p => path.resolve(p));
const LOG = path.join(ROOT, '语音转动画-每日更新日志.md');
const MEM = path.join(ROOT, '语音转动画-项目记忆.md');

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const ALL = argv.includes('--all');

let sinceMs;
if (arg('date')) {
  const d = new Date(arg('date') + 'T00:00:00');
  if (isNaN(d)) die('--date 格式须为 YYYY-MM-DD，收到：' + arg('date'));
  sinceMs = d.getTime();
} else if (arg('since')) {
  sinceMs = Date.now() - parseFloat(arg('since')) * 3600e3;
} else {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 1);
  sinceMs = d.getTime();
}

/* ---------- 读文档 ---------- */
const logTxt = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
const memTxt = fs.existsSync(MEM) ? fs.readFileSync(MEM, 'utf8') : '';

const issues = [];   // { level, title, detail }
const push = (level, title, detail) => issues.push({ level, title, detail });

const md5 = (f) => {
  try { return crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex'); }
  catch (e) { return null; }
};
const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/* ---------- ① 扫产物（多根 · 递归 · **跟随 symlink** · 跳过程目录） ---------- */
const MEDIA = /\.(mp4|mov|webm|prores)$/i;
const found = [];   // { root, rel, file, abs, mtime, size, md5, refs }

// 跳过过程件媒体文件，两类：
//   (a) 文件名以 `_` 开头（_v.mp4 / _preview.mp4 等静帧预览/过程样片，非独立交付物）
//   (b) 以 `_vid.mp4` 结尾（无声视频流版本，由 -c:v copy 从同一批帧复用，历史上从不单独登记）
const SKIP_FILE = /(?:^_.*|_vid)\.(mp4|mov|webm|prores)$/i;
// 目录名黑名单：下划线前缀（_tmp/_audit/_frames 等）、frames、_v\d、_final、node_modules
// ⚠️ 跟随 symlink 之后，此黑名单对「链接目标目录名」同样生效（见 walkTree）
const SKIP_DIR = /^(?:_|node_modules$|frames$|_v\d+$|_final\d*$)/;
const MAX_DEPTH = 4;

const mkStat = () => ({ hits: 0, seen: 0, tiny: 0, skipName: 0, links: 0, cycles: 0, dups: 0,
                        refs: 0, items: [], docCount: 0, docBytes: 0, docErr: 0,
                        hitOwn: 0, hitAny: 0, hitGlobal: 0 });

/* 递归遍历一个目录（跟随 symlink 目录 + realpath 环检测）
 * 2026-09-16 修：旧版用 `Dirent.isDirectory()` 判目录，而 `readdirSync({withFileTypes})`
 * 对 symlink 一律返回 isDirectory()=false ⇒ 整棵 symlink 子树被**静默**跳过（无计数、无提示）。
 * 现改为 `statSync` 跟随链接，并配套三项保护：
 *   · 环检测：每个扫根一份已访问 realpath 集合，重复即跳过并计入 cycles（防 A→B→A 无限递归爆栈）
 *   · SKIP_DIR 对「条目名」与「链接目标目录名」双重生效（跟随 ≠ 放行 _tmp/frames/node_modules）
 *   · 深度仍卡 MAX_DEPTH，不放宽
 * 返回 true = 被 onFile 要求提前中止（findDiskFile 命中即停用）。
 */
function walkTree(dir, depth, onFile, stat, visited) {
  let real;
  try { real = fs.realpathSync(dir); } catch (e) { stat.cycles++; return false; }  // 断链
  if (visited.has(real)) { stat.cycles++; return false; }                          // 环 / 重复入口
  visited.add(real);

  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return false; }

  for (const e of entries) {
    const abs = path.join(dir, e.name);
    let st;
    try { st = fs.statSync(abs); } catch (err) { continue; }   // statSync 跟随链接；断链抛错 → 跳过
    if (st.isDirectory()) {
      if (SKIP_DIR.test(e.name)) continue;                     // 按条目名跳过程目录
      if (depth >= MAX_DEPTH) continue;
      if (e.isSymbolicLink()) {                                // 走的是链接 → 目标目录名再过一次黑名单
        let tgt;
        try { tgt = path.basename(fs.realpathSync(abs)); } catch (err) { continue; }
        if (SKIP_DIR.test(tgt)) continue;
        stat.links++;
      }
      if (walkTree(abs, depth + 1, onFile, stat, visited)) return true;
    } else if (st.isFile()) {
      if (onFile(abs, e.name, st) === true) return true;       // st 一并传下去（.md 要用 mtime）
    }
  }
  return false;
}

// 全盘递归按文件名定位（用于 ② md5 漂移比对，不限时间窗）
function findDiskFile(fname) {
  for (const root of SCAN_ROOTS) {
    let hit = null;
    walkTree(root, 1, (abs, name) => { if (name === fname) { hit = abs; return true; } }, mkStat(), new Set());
    if (hit) return hit;
  }
  return null;
}

/* ---------- 归档证据源（① 与 ② 共用同一域，口径不许各扩一半） ----------
 * 总档 2 份（**不在任何扫根内**，丢掉它们会反向造出一批假 FAIL）+ 每个扫根下全部 .md。
 * 目录黑名单沿用 SKIP_DIR（node_modules 天然被挡）；实测各根 .md 分别 7 / 11 / 35 个，
 * 无「数量异常大」的目录，故**未加新黑名单**（若将来加了，必须在此报出来）。
 */
const docSrcs = [
  { label: '语音转动画-每日更新日志.md', txt: logTxt, root: null },
  { label: '语音转动画-项目记忆.md', txt: memTxt, root: null },
];

/* ---------- 逐根扫描 ----------
 * ⭐ 每个扫根分别报「扫到 N 个」——落实铁律「**报 0 命中必须先证域非空**」：
 *    某根贡献 0 时必须在报告里看得见。旧版只报一个总数，整棵旧工程树 0 贡献也无任何提示。
 *    seen = 盘上成片（过名字/尺寸过滤、**未**按时间窗过滤）→ 用来证明该根「域非空」。
 * 同一次遍历里顺手收集该根下全部 .md（归档证据源，见 ①），所以每根只走一遍。
 */
const rootStats = [];
const seenReal = new Set();     // 全局：同一物理文件只登记一次（跨根 symlink 入口去重）
for (const root of SCAN_ROOTS) {
  const stat = mkStat();
  const docs = [];
  if (!fs.existsSync(root)) {
    rootStats.push({ root, stat, docs, missing: true });
    push('WARN', '扫描根不存在', root);
    continue;
  }
  walkTree(root, 1, (abs, name, st) => {
    if (/\.md$/i.test(name)) {                 // ← 归档证据源：本根下的 .md 全收（口径跟着扫域扩）
      let txt; try { txt = fs.readFileSync(abs, 'utf8'); } catch (e) { stat.docErr++; return; }
      const rel = path.relative(root, abs).split(path.sep).join('/');
      docs.push({ rel, mtime: st.mtimeMs });
      docSrcs.push({ label: rel, txt, root });
      stat.docCount++; stat.docBytes += Buffer.byteLength(txt);
      return;
    }
    if (!MEDIA.test(name)) return;
    if (SKIP_FILE.test(name)) { stat.skipName++; return; }
    const s = st;                                              // walkTree 已 statSync 过，无需二次
    if (s.size < 100 * 1024) { stat.tiny++; return; }          // <100KB 视为废片
    stat.seen++;
    if (!ALL && s.mtimeMs < sinceMs) return;
    let real = abs; try { real = fs.realpathSync(abs); } catch (e) { /* 用 abs 兜底 */ }
    if (seenReal.has(real)) { stat.dups++; return; }
    seenReal.add(real);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    // 参考素材（下载来的教程片/素材包）：单独归类、照常显示，但不计入交付物漏记
    const it = { root, rel, file: name, abs, mtime: s.mtimeMs, size: s.size,
                 md5: md5(abs), refs: /(^|\/)(refs|参考)(\/|$)/i.test(rel) };
    found.push(it);
    stat.items.push(it);
    stat.hits++;
    if (it.refs) stat.refs++;
  }, stat, new Set());
  rootStats.push({ root, stat, docs });
}
// 扫根配置本身失效（盘上 0 个成片）→ 必须报出来，否则又是「自信的 0 命中」
for (const r of rootStats) {
  if (!r.missing && r.stat.seen === 0) {
    push('WARN', '扫根 0 命中（盘上无任何成片）', r.root + '  —— 该根可能配错/为空树，不可据此判「无缺口」');
  }
}

found.sort((a, b) => a.mtime - b.mtime);

/* ---------- ① 新产物漏记 ----------
 * ⚠️ 2026-09-16（第二轮）：「已归档」的**证据源口径必须跟着扫域一起扩**。
 *    旧版证据源 = 新树两份固定总档（语音转动画-每日更新日志.md / 项目记忆.md）；
 *    而扫域这一轮扩到了旧树 `video-style-lab/projects` ⇒ 那批产物早就归档在**旧树自己的 .md** 里
 *    （`INK-SCREEN-总档.md` / 各项目 `分镜表.md` / `接手指南.md` …），却因证据源没跟着扩，
 *    被报成 24 条**假 FAIL**。假 FAIL 的代价是人开始忽略 FAIL（且会逼出「同一份档案在两个
 *    文档集里各写一遍」的 BUG-2169 同物两名）。故：
 *      证据源 = 总档 2 份（它们**不在任何扫根内**，丢掉它们会反向造出一批假 FAIL）
 *               + 每个扫根下全部 .md（沿用 SKIP_DIR 黑名单，node_modules 天然被挡；
 *                 实测各根 .md 分别 7 / 11 / 35 个，无「数量异常大」的目录，故未加新黑名单）
 *    判定不变：文件名 **或** md5 命中任一处即算已归档。
 * ------------------------------------------------------------------ */
const globalDocs = docSrcs.filter(d => !d.root);
const globalTxt = globalDocs.map(d => d.txt).join('\n');
const docAll = docSrcs.map(d => d.txt).join('\n');
const fmtBytes = (n) => n < 1024 ? n + 'B' : (n / 1024).toFixed(0) + 'KB';
const hitDoc = (it, txt) => txt.includes(it.file) || !!(it.md5 && txt.includes(it.md5));
// 逐根统计「本根档命中 / 全源命中 / 总档命中」，让「为什么绿」看得见
for (const r of rootStats) {
  if (r.missing) continue;
  const own = docSrcs.filter(d => d.root === r.root).map(d => d.txt).join('\n');
  for (const it of r.stat.items) {
    if (hitDoc(it, own)) r.stat.hitOwn++;
    if (hitDoc(it, docAll)) r.stat.hitAny++;
    if (hitDoc(it, globalTxt)) r.stat.hitGlobal++;
  }
}
const docTotal = rootStats.reduce((n, r) => n + r.stat.docCount, 0);
const docTotalBytes = rootStats.reduce((n, r) => n + r.stat.docBytes, 0);
const globalDocsBytes = globalDocs.reduce((n, d) => n + Buffer.byteLength(d.txt), 0);
const unlogged = found.filter(it => !it.refs && !hitDoc(it, docAll));
/* 分栏：本项目树（projects + 大狗/works，在 ROOT 内）vs 外部旧树（../video-style-lab）。
 * 为什么必须分：EXIT=1 要只代表「本项目树有待核」；否则下一个人看到「漏记 14」会以为新树塌了，
 * 而真相是「本项目树 4 条 + 旧树 10 条历史遗留」。**不改判据、不加白名单、不豁免**，只分层呈现。
 */
const inRootTree = (r) => r === ROOT || r.startsWith(ROOT + path.sep);
const unNew = unlogged.filter(i => inRootTree(i.root));
const unOld = unlogged.filter(i => !inRootTree(i.root));
// 「该工程目录下 .md = 0」的红 ≠ 「工程有档但漏记」的红。前者是**无档可命中**，报告必须自己说清。
const projDocsOf = (it) => {
  const seg = it.rel.split('/');
  if (seg.length < 2) return null;                 // 落在扫根根层的文件不属于任何工程
  const r = rootStats.find(x => x.root === it.root);
  if (!r || !r.docs) return null;
  const p = seg[0] + '/';
  return { projAbs: path.join(it.root, seg[0]), md: r.docs.filter(d => d.rel.startsWith(p)) };
};
/* 「档/片时序」——**独立于 `spec.json` 的独立事实栏**（不管有没有 spec.json 都打印）。
 * 由来：正常生产顺序是「先写分镜表 → 后出成片」⇒ 在还没回填的在制品上，
 *       ① 「档里有没有这个成片名」这个判据**必然为「没有」**；那是工序先后，不是档案失职。
 *       要说得清区别，但**不许靠放宽判据**去解决（放宽 = 恒绿死代码）。
 * 三态（**只是事实形态，不自动等于结论**）：
 *   档早于片 + 没片名 → ① 在制品（还没回填） ② 老工程（写完就再没回头）
 *   档晚于片 + 没片名 → 回填过，但回填时漏写了片名（性质最接近真漏记）
 *   无档             → 工程压根没档
 * ⚠️ 边界（必须记住）：时序只说明「**回填过没有**」，不说明「**归属谁**」——
 *    `som7608`（档早于片）是老工程、`v2a-intro`（档早于片）是今天的在制品，
 *    形态完全相同、归属完全不同 ⇒ **归属必须靠人判**，工具代替不了。
 * 本栏只摆事实，一律不下结论。
 * ------------------------------------------------------------------ */
const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${d.toTimeString().slice(0, 5)}`; };
const wipFacts = (it) => {
  const d = projDocsOf(it);
  if (!d) return { wip: false, rows: ['档/片时序：不适用（文件位于扫根根层，不属于任何工程目录）'] };
  let spec = false;
  try { spec = fs.existsSync(path.join(d.projAbs, 'spec.json')); } catch (e) { /* ignore */ }
  const earlier = d.md.filter(m => m.mtime < it.mtime).sort((a, b) => b.mtime - a.mtime)[0];
  const later = d.md.filter(m => m.mtime >= it.mtime).sort((a, b) => a.mtime - b.mtime)[0];
  let seqText;
  if (!d.md.length) seqText = '本工程目录 .md 0 份（无档）—— 无档可命中，先补档再谈漏记';
  else if (earlier) seqText = `${earlier.rel} @${hhmm(earlier.mtime)} < 成片 @${hhmm(it.mtime)} ✓（档写在片之前）`;
  else seqText = `${later.rel} @${hhmm(later.mtime)}（档晚于成片）`;
  const wip = !!(spec && earlier);
  const rows = [
    `档/片时序：${seqText}`,
    `spec.json：${spec ? '存在' : '不存在'}`
      + (wip ? ' ｜ 【在制品特征】档早于片 + 有 spec.json —— 仅标签、不是豁免（分类 / 数字 / EXIT 全不变）' : ''),
  ];
  return { wip, rows };
};
if (unlogged.length) {
  const detail = unlogged.map(i => {
    const f = wipFacts(i);
    return `${fmtDate(i.mtime)}  ${i.rel}  ${(i.size / 1048576).toFixed(1)}MB  md5 ${i.md5}`
      + f.rows.map(r => `\n          ← ${r}`).join('');
  });
  push('FAIL', `① 新产物漏记 ${unlogged.length} 个 ＝ 本项目树 ${unNew.length} + 外部旧树 ${unOld.length}（EXIT=1 只代表「本项目树」这栏待核）`,
    [`├ 本项目树（projects + 大狗/works）${unNew.length}：待核 —— 在制品/归属由人定，工具不豁免、不加白名单`,
     `└ 外部旧树（../video-style-lab）${unOld.length}：老工程不返修口径（老板 2026-09-09 定），明细见下`,
     ...detail,
     `── 证据源域（域空则本判定不可信）：总档 2 份 ${fmtBytes(globalDocsBytes)}`
     + ` + 各扫根 .md ${docTotal} 个 ${fmtBytes(docTotalBytes)}`].join('\n        '));
}
// 某根 .md=0 却从该根报了漏记 → 必须自曝「该根无文档源，漏记判定不可信」（同铁律）
for (const r of rootStats) {
  if (r.missing || r.stat.docCount) continue;
  const n = unlogged.filter(i => i.root === r.root).length;
  if (n) push('WARN', `扫根无文档源却报漏记（本根 .md=0，判定不可信）`, `${r.root}\n        该根报出漏记 ${n} 个，但根下没有任何 .md 可供命中 —— 先核对扫根，别急着补档`);
}
const refsMedia = found.filter(it => it.refs);
// 总档覆盖自证：证据源扩到「任意扫根 .md」之后，总档断档会变得看不见 —— 单独算一列盯住它
const deliverable = found.filter(it => !it.refs);
const inGlobal = deliverable.filter(it => hitDoc(it, globalTxt)).length;
const localOnly = deliverable.filter(it => !hitDoc(it, globalTxt) && hitDoc(it, docAll)).length;

/* ---------- ② md5 漂移 ----------
 * 从**同一份证据源**（总档 + 各扫根 .md）里抓 `xxx.mp4` md5 `HEX` 记录，跟磁盘比对。
 * ⚠️ ② 必须与 ① 同域：若 ① 把旧树 .md 当证据、② 却不读它们，就又变成「口径各扩一半」。
 * 分两级：
 *   FAIL 漂移 —— 文档里该文件记录的值 **全都不对**（正确值根本没写进去）→ 文档说谎，必须补
 *   INFO 残值 —— 文档里 **有正确值**，但同时还留着旧值没清理 → 建议清理，不阻断
 * ------------------------------------------------------------------ */
const docMd5 = new Map();   // fname -> [{src, hex}]
{
  const MD5RE = /`?([\w\-.]+\.(?:mp4|mov))`?\s*(?:md5)?\s*`([0-9a-f]{32})`/gi;
  for (const src of docSrcs) {
    let m; MD5RE.lastIndex = 0;
    while ((m = MD5RE.exec(src.txt))) {
      const [, fname, hex] = m;
      if (!docMd5.has(fname)) docMd5.set(fname, []);
      const list = docMd5.get(fname);
      if (!list.some(x => x.hex === hex)) list.push({ src: src.label, hex });
    }
  }
}

// 全局 hex 池：**证据源**里出现过的所有 32 位 hex（总档 + 各扫根 .md，与 ① 同域）。
// 用途：表格里文件名和 md5 分列时，上面的正则抓不到配对关系，
//       但只要正确值在证据源某处出现过，就算已归档（不阻断）。
const allHex = new Set();
{
  const HEXRE = /\b[0-9a-f]{32}\b/gi;
  let m; HEXRE.lastIndex = 0;
  while ((m = HEXRE.exec(docAll))) allHex.add(m[0].toLowerCase());
}

const drift = [], stale = [];
for (const [fname, list] of docMd5) {
  const hit = findDiskFile(fname);   // 在所有扫描根递归定位
  if (!hit) continue;
  const real = md5(hit);
  if (!real) continue;
  // 已归档 = 配对值里有正确值，或正确值散落在文档别处（表格分列场景）
  if (list.some(x => x.hex === real) || allHex.has(real)) {
    for (const x of list) if (x.hex !== real) stale.push({ fname, doc: x.hex, real, src: x.src });
  } else {
    drift.push({ fname, doc: list.map(x => x.hex).join(' / '), real });
  }
}
if (drift.length) {
  push('FAIL', `② md5 漂移 ${drift.length} 处（文档里的值 **全都不对**，正确值没写进去）`,
    drift.map(d => `${d.fname}\n        文档 ${d.doc}\n        实测 ${d.real}`).join('\n        '));
}
if (stale.length) {
  push('INFO', `②b 历史残值 ${stale.length} 处（正确值已在文档里，旧值建议清理）`,
    stale.map(s => `${s.fname}  旧 ${s.doc}（${s.src}）→ 现 ${s.real}`).join('\n        '));
}

/* ---------- ③ 工程孤儿（正式工程树下有成片但项目记忆查无此工程名） ---------- */
const orphans = [];
for (const root of ORPHAN_ROOTS) {
  if (!fs.existsSync(root)) continue;
  let top; try { top = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { continue; }
  for (const e of top) {
    if (!e.isDirectory() || /^_/.test(e.name) || e.name === 'node_modules') continue;
    const pdir = path.join(root, e.name);
    // 顶层工程目录下有没有成片（一层判定，工程名 = 顶层目录名）
    let hasMedia = false;
    try {
      hasMedia = fs.readdirSync(pdir).some(f => MEDIA.test(f) && fs.statSync(path.join(pdir, f)).size > 100 * 1024);
    } catch (e2) { /* ignore */ }
    if (!hasMedia) continue;
    if (!memTxt.includes(e.name)) orphans.push(`${path.basename(root)}/${e.name}`);
  }
}
if (orphans.length) {
  push('WARN', `③ 工程孤儿 ${orphans.length} 个（有成片但项目记忆 §2 里查无此名）`,
    orphans.join(' / '));
}

/* ---------- ④ 日志断档 ---------- */
const logDays = new Set();
{
  let m; const RE = /^##\s*(\d{4}-\d{2}-\d{2})/gm;
  while ((m = RE.exec(logTxt))) logDays.add(m[1]);
}
const prodDays = new Map();      // day -> [完整相对路径]（参考素材不算产出）
for (const it of deliverable) {
  const d = fmtDate(it.mtime);
  if (!prodDays.has(d)) prodDays.set(d, []);
  prodDays.get(d).push(it.rel);
}
const missingDays = [];
if (ALL) {
  // 全量模式：任何有产出的日子都该有日志条目
  for (const [d, list] of prodDays) {
    if (!logDays.has(d)) missingDays.push(`${d}  →  ${list.slice(0, 4).join(', ')}${list.length > 4 ? ' …' : ''}`);
  }
}
if (missingDays.length) {
  push('WARN', `④ 日志断档 ${missingDays.length} 天（有产出但无日志条目）`, missingDays.join('\n        '));
}

/* ---------- 报告 ---------- */
const L = [];
L.push('');
L.push('════════════════════════════════════════════════════════');
L.push(' 每日归档守卫 · ' + (ALL ? '全量体检' : `扫描 ${fmtDate(sinceMs)} 起`));
L.push('════════════════════════════════════════════════════════');
L.push(` 扫描根（${SCAN_ROOTS.length}）—— 逐根报数（0 命中必须看得见）：`);
for (const r of rootStats) {
  if (r.missing) {
    L.push(`   ⛔ ${r.root}`);
    L.push('       └ 路径不存在');
    continue;
  }
  const s = r.stat;
  const bits = [`扫到 ${s.hits} 个`, `盘上成片 ${s.seen} 个`];
  if (s.links) bits.push(`经 symlink 目录 ${s.links}`);
  if (s.cycles) bits.push(`跳过环/重复入口 ${s.cycles}`);
  if (s.dups) bits.push(`跨根重复未计 ${s.dups}`);
  if (s.tiny) bits.push(`<100KB 废片 ${s.tiny}`);
  if (s.skipName) bits.push(`_ 前缀/_vid 过程件 ${s.skipName}`);
  if (s.refs) bits.push(`参考素材(refs) ${s.refs}`);
  L.push(`   ${s.seen ? '✔' : '⛔'} ${r.root}`);
  L.push(`       └ ${bits.join(' ｜ ')}`);
  // ⭐ 归档证据源自证：本根 .md 几个、命中几个（域为 0 必须看得见）
  L.push(`       └ 本根 .md 文档 ${s.docCount} 个${s.docCount ? `（${fmtBytes(s.docBytes)}）` : ''}`
    + ` ｜ 本根档命中 ${s.hitOwn}/${s.hits} ｜ 全源命中 ${s.hitAny}/${s.hits} ｜ 总档命中 ${s.hitGlobal}/${s.hits}`
    + (s.docErr ? ` ｜ 读取失败 ${s.docErr}` : ''));
  if (!s.docCount) L.push('       └ ⛔ 本根 .md 文档源 0 个：该根「漏记」判定无从命中，不可信');
  if (s.seen && !s.hits) L.push(`       └ 盘上有 ${s.seen} 个，全部早于时间窗（${fmtDate(sinceMs)} 起）—— 非漏扫，加 --all 看全量`);
  if (!s.seen) L.push('       └ ⛔ 该根盘上 0 个成片：扫根配置可能失效，不可据此判「无缺口」');
}
L.push(` 合计成片  ：${found.length} 个（其中参考素材 refs ${refsMedia.length} 个不计入漏记）`);
L.push(` 归档证据源：总档 ${globalDocs.length} 份 ${fmtBytes(globalDocsBytes)} + 各扫根 .md ${docTotal} 个 ${fmtBytes(docTotalBytes)}`);
L.push(` 总档覆盖（仅供参考 · 非判据）：${inGlobal}/${deliverable.length}`);
L.push(`     其余 ${deliverable.length - inGlobal} ＝ ${localOnly} 个「只在工程自带档有记载」`
  + ` + ${unNew.length} 个「本项目树无记载（待核）」 + ${unOld.length} 个「外部旧树历史遗留」`);
L.push('     ⚠️ 本列不是判据，不许为抬高此数补档（补档 = 同一份档案在两个文档集各写一遍 = BUG-2169 同物两名）');
if (found.length) {
  L.push('');
  L.push(' ── 本期产出（完整相对路径）──');
  for (const it of found) {
    L.push(`   ${fmtDate(it.mtime)}  ${it.rel}  ${(it.size / 1048576).toFixed(1)}MB  ${it.md5}`);
  }
}
if (refsMedia.length) {
  L.push('');
  L.push(` ── 参考素材（refs/ 路径，不计入漏记）${refsMedia.length} 个 ──`);
  for (const it of refsMedia) {
    L.push(`   ${fmtDate(it.mtime)}  ${it.rel}  ${(it.size / 1048576).toFixed(1)}MB  ${it.md5}`);
  }
}
L.push('');

if (!issues.length) {
  L.push(' ✅ 无缺口 —— 日志与记忆都已覆盖本期产出。');
} else {
  const ICON = { FAIL: '❌', WARN: '⚠️ ', INFO: 'ℹ️ ' };
  for (const s of issues) {
    L.push(` ${ICON[s.level] || '·'} ${s.title}`);
    L.push(`        ${s.detail}`);
    L.push('');
  }
}

L.push(' ── 补档动作 ──');
L.push('   1. 漏记产物 → 往「语音转动画-每日更新日志.md」补当日条目');
L.push('   2. md5 漂移 → 以磁盘实测为准，改日志/记忆里的旧值');
L.push('   3. 工程孤儿 → 往「语音转动画-项目记忆.md」§2 补工程条目');
L.push('   4. 日志断档 → 补该日条目（可写「补归档」）');
L.push('');

console.log(L.join('\n'));

const fail = issues.filter(i => i.level === 'FAIL').length;
process.exit(fail ? 1 : 0);

function die(msg) { console.error('\n❌ ' + msg + '\n'); process.exit(2); }
