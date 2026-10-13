#!/usr/bin/env node
/**
 * term.mjs —— 动效术语库索引 + 检索（「动效设计师」560 库）
 *
 * 定位：把**术语级**知识库（558 条 / 36 类）
 *       变成管线里可调用的检索层；**读源分片、不复制数据**（源库是每日自动更新的活库）。
 *
 * 与 `pick.mjs`（video-shotcraft 157 张**镜头级**卡）的分工：
 *   · 镜头卡（pick）  = 这一镜**整体是什么结构**（时长 4–5s / 能量弧线 / 参数手感）
 *   · 术语库（term）  = 这一镜**具体怎么写**（params 参数 + how 实现路径）+ **怎么说**（cn/en 术语名）
 *   ⇒ 两者是**不同粒度**，写分镜表时要一起用：先定结构，再定写法与说法。
 *
 * 用法：
 *   node term.mjs                        # 概览
 *   node term.mjs --intent "数字往上滚 指标增长"      # 按意图检索
 *   node term.mjs --intent "..." --cat 缓动 --top 5
 *   node term.mjs --show E01             # 看单条全文
 *   node term.mjs --selftest             # 自检（含负控）
 *   node term.mjs --json                 # 机器可读
 *
 * 纪律（沿用本线铁律）：
 *   · 意图由人/AI 做语义判断，本工具**只做检索**（不许拿文案原文直连，实测 rel≈0.05）
 *   · 检索不到 ⇒ 报低相关度，**不编**
 *   · 源分片变了（mtime）⇒ 提示索引过期，不静默用旧索引
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// ───────────────────────── 配置 ─────────────────────────

const SRC_DIR = process.env.MOTION_TERMS_DIR || '';
// ★ 用 fileURLToPath：路径含中文时 URL.pathname 是 percent-encoded（踩过）
const HERE = path.dirname(fileURLToPath(import.meta.url));
const IDX_FILE = path.join(HERE, 'terms-index.json');

const FIELDS = ['id', 'cat', 'cn', 'en', 'desc', 'params', 'use', 'how', 'demo', 'tags'];

// 检索字段权重：术语名（cn/en）与标签最直接；实现路径（how）权重最低
const W = { cn: 3.0, en: 2.0, tags: 2.0, desc: 1.5, use: 1.2, params: 1.0, how: 0.8, cat: 1.5 };

const TOPN = 6;

// ───────────────────────── 参数 ─────────────────────────

function parseArgv(argv) {
  const o = { intent: null, cat: null, show: null, top: TOPN, json: false, selftest: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const nx = () => argv[++i];
    if (a === '--intent') o.intent = nx();
    else if (a === '--cat') o.cat = nx();
    else if (a === '--show') o.show = nx();
    else if (a === '--top') o.top = Number(nx());
    else if (a === '--out') o.out = nx();
    else if (a === '--json') o.json = true;
    else if (a === '--selftest') o.selftest = true;
  }
  return o;
}

// ───────────────────────── 读源分片 ─────────────────────────

/** 用 vm 跑 `window.TERMS_XX = [...]`（分片是浏览器写法，不能直接 import） */
export function loadShards(dir = SRC_DIR) {
  if (!fs.existsSync(dir)) {
    throw new Error(`术语库目录不存在：${dir}\n（用 MOTION_TERMS_DIR 指向你的术语库目录）`);
  }
  const files = fs.readdirSync(dir).filter(f => /^terms-.*\.js$/.test(f)).sort();
  if (!files.length) throw new Error(`目录里没有 terms-*.js：${dir}`);

  const sandbox = { window: {} };
  vm.createContext(sandbox);
  const loaded = [];
  const failed = [];
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      vm.runInContext(fs.readFileSync(full, 'utf8'), sandbox, { filename: f });
      const st = fs.statSync(full);
      loaded.push({ file: f, mtimeMs: Math.round(st.mtimeMs), size: st.size });
    } catch (e) {
      // 铁律 182：禁止静默吞异常 —— 异常必须带类型与消息出来
      failed.push({ file: f, err: `${e.name}: ${e.message}` });
    }
  }

  const terms = [];
  for (const k of Object.keys(sandbox.window)) {
    const arr = sandbox.window[k];
    if (Array.isArray(arr)) terms.push(...arr.map(t => ({ ...t, _shard: k })));
  }
  return { files, loaded, failed, terms };
}

/** 源分片新鲜度指纹（mtime+size 串起来做 hash）—— 变了说明源库更新了 */
export function sourceRevision(loaded) {
  const s = loaded.map(f => `${f.file}:${f.mtimeMs}:${f.size}`).join('|');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

// ───────────────────────── 判据 ─────────────────────────

/** 抽成函数以便 --selftest 喂合成坏数据（同 index.mjs 的做法） */
export function audit(terms, loaded) {
  const problems = [];
  const missing = {};
  for (const t of terms) {
    for (const f of FIELDS) if (t[f] == null || t[f] === '') missing[f] = (missing[f] || 0) + 1;
  }
  for (const [f, n] of Object.entries(missing)) {
    problems.push(`字段缺失：${f} 有 ${n} 条为空`);
  }

  const seen = new Set();
  const dup = new Set();
  for (const t of terms) {
    if (seen.has(t.id)) dup.add(t.id);
    seen.add(t.id);
  }
  if (dup.size) problems.push(`id 重复：${[...dup].join(',')}`);

  // ★ 全局分布守卫：单条判据挡不住"整批解析失败"
  // ⚠️ 守卫要按【分片】判，不能按【分类】判 —— 实测坑：分类「运动排版」上游 v2.5 那批
  //    本来就只收了 1 条（动态文字），按分类判 n===1 会误报"疑似缺失"（同族 BUG-2456/2458：
  //    判据把上游明确合法的值当失败）。分片才是入库单位，每批 12~54 条。
  const catCount = {};
  for (const t of terms) catCount[t.cat] = (catCount[t.cat] || 0) + 1;
  const cats = Object.keys(catCount);

  const shardCount = {};
  for (const t of terms) shardCount[t._shard || '?'] = (shardCount[t._shard || '?'] || 0) + 1;

  if (terms.length < 500) problems.push(`总条目 ${terms.length} < 500（源库下限 558）—— 疑似整批分片没读到`);
  if (cats.length < 30) problems.push(`分类只有 ${cats.length} 类 < 30（源库 36 类）—— 疑似分类解析偏移`);
  for (const f of loaded) {
    const n = shardCount['TERMS_' + f.file.replace(/^terms-|\.js$/g, '').toUpperCase()] || 0;
    if (n < 10) problems.push(`分片 ${f.file} 只解析出 ${n} 条（每批应 ≥10）—— 疑似该分片解析失败`);
  }

  const badIds = terms.filter(t => !/^[A-Za-z]{1,3}\d{2}$/.test(String(t.id))).map(t => t.id);
  if (badIds.length) problems.push(`id 格式异常（应为 1–3 字母+2 位数字）：${badIds.slice(0, 8).join(',')}`);

  return {
    problems,
    stats: {
      terms: terms.length,
      shards: loaded.length,
      cats: cats.length,
      catCount,
    },
  };
}

// ───────────────────────── 检索 ─────────────────────────

/** 2-gram 集合（去标点/空白；中文与英文都切成 2-gram，与 pick.mjs 口径一致） */
function ngrams(s, n = 2) {
  const clean = String(s).toLowerCase().replace(/[\s\-_/，。、；：！？（）()【】「」"'`]+/g, '');
  const out = new Set();
  for (let i = 0; i + n <= clean.length; i++) out.add(clean.slice(i, i + n));
  if (clean.length && clean.length < n) out.add(clean);
  return out;
}

function fieldBlob(t, f) {
  if (f === 'tags') return Array.isArray(t.tags) ? t.tags.join(' ') : String(t.tags || '');
  return String(t[f] || '');
}

/** 2-gram 重叠 × 字段权重 */
export function score(intent, t) {
  const q = ngrams(intent);
  if (!q.size) return { s: 0, hits: [] };
  const hits = new Map();
  let s = 0;
  for (const [f, w] of Object.entries(W)) {
    const blob = ngrams(fieldBlob(t, f));
    let overlap = 0;
    for (const g of q) if (blob.has(g)) { overlap++; hits.set(g, f); }
    if (overlap) s += (overlap / q.size) * w;
  }
  // 术语名精确包含（用户可能直接报"上移淡入"）
  const cq = String(intent).toLowerCase();
  if (t.cn && cq.includes(String(t.cn).toLowerCase())) s += 4;
  if (t.en && cq.includes(String(t.en).toLowerCase())) s += 3;
  if (cq.includes(String(t.id).toLowerCase())) s += 5;
  return { s, hits: [...hits.keys()] };
}

export function search(intent, terms, { cat = null, top = TOPN } = {}) {
  let pool = terms;
  if (cat) pool = pool.filter(t => t.cat === cat);
  return pool
    .map(t => { const { s } = score(intent, t); return { t, rel: s }; })
    .sort((a, b) => b.rel - a.rel)
    .slice(0, top);
}

/**
 * 低相关度提示（**只是提示，不参与退出码**）
 *
 * ★★ 阈值是【实测标定】出来的，不是拍脑袋 —— 而且**与 pick.mjs 的 rel 量级不可比**：
 *    本库每条 7 个字段（cn/en/desc/params/use/how/tags），2-gram 分母更大 ⇒ rel 整体更低。
 *    实测（2026-09-22 · 558 条）：
 *      对口意图 top1 rel = 0.56 ~ 5.72（中位约 1.1；「逐字显现」能到 5.72，「数字往上滚 指标增长」只有 1.10）
 *      噪声意图 top1 rel = 0.17 ~ 0.64（「zzz不存在」0.17 · 内容词直连 0.64）
 *    ⇒ 0.5 与 1.2 之间是**灰区**，别当硬判据用。
 *    ⚠️ 教训：我第一版直接抄了 pick.mjs 的经验值 1.5 当"命中"门限 ⇒
 *      把**完全对口**的「数字滚动 Ui08（rel 1.10）」判成 FAIL（同族 BUG-2458「拿错尺子量人」）。
 */
export function relWarning(rel) {
  if (rel >= 1.2) return null;
  if (rel >= 0.5) {
    return '相关度偏低（灰区，**不等于没命中**——先看 top1 的 `cn`/`desc` 对不对口）：' +
      '换个说法再搜一次 —— **用术语库自己的词**（把 top1 的 `cn`/`en` 抄进意图）。';
  }
  return '⚠️ 相关度≈噪声：**别拿文案原文/内容词直连检索**（实测旁白直连 rel≈0.05）。' +
    '先写成动效语汇（"逐字显现 / 数字滚动 / 遮罩揭示"这种），再搜。';
}

/**
 * ★ 排序稳定性提示（**可判定，非拍脑袋**）：一镜塞多个并列动效时，2-gram 词袋会把它们各命中一半
 *   ⇒ top1/top2 咬得很近，谁第一全看用词。实测：
 *     意图「大字逐字入场 reveal 曲线描线生长 环形进度」⇒ M07 描线生长 4.43 / D04 场 4.13（咬住）
 *     聚焦成「逐字显现 文字一个一个出来 错峰」⇒ Kt01 逐字显现 5.52 一骑绝尘
 */
export function unstableHint(results, ratio = 0.85) {
  if (!results || results.length < 2 || !(results[0].rel > 0)) return null;
  if (results[1].rel / results[0].rel <= ratio) return null;
  return `提示：top1（\`${results[0].t.id}\` ${results[0].t.cn}）与 top2（\`${results[1].t.id}\` ${results[1].t.cn}）` +
    `相关度接近（${results[0].rel.toFixed(2)} vs ${results[1].rel.toFixed(2)}）⇒ **排序不稳定**。` +
    `多半是意图里并列了多个动效，词袋各命中一半。**建议聚焦一个主术语再搜**（一镜一主动效）。`;
}

// ───────────────────────── 索引读写 ─────────────────────────

function writeIndex(terms, loaded, stats) {
  const idx = {
    source: SRC_DIR,
    revision: sourceRevision(loaded),
    builtAt: new Date().toISOString(),
    stats,
    shards: loaded,
    terms: terms.map(t => ({
      id: t.id, cat: t.cat, cn: t.cn, en: t.en, desc: t.desc,
      params: t.params, use: t.use, how: t.how, demo: t.demo, tags: t.tags, _shard: t._shard,
    })),
  };
  fs.writeFileSync(IDX_FILE, JSON.stringify(idx, null, 0), 'utf8');
  return idx.revision;
}

function freshness(loaded) {
  if (!fs.existsSync(IDX_FILE)) return { state: 'absent' };
  try {
    const idx = JSON.parse(fs.readFileSync(IDX_FILE, 'utf8'));
    const now = sourceRevision(loaded);
    return { state: idx.revision === now ? 'fresh' : 'stale', idxRev: idx.revision, nowRev: now };
  } catch (e) {
    return { state: 'broken', err: `${e.name}: ${e.message}` };
  }
}

// ───────────────────────── 渲染 ─────────────────────────

function renderHit(r, i) {
  const t = r.t;
  const L = [];
  L.push(`### ${i}. \`${t.id}\`　**${t.cn}** / ${t.en}　｜ ${t.cat} ｜ 相关度 ${r.rel.toFixed(2)}`);
  L.push('');
  L.push(`- **怎么说**：${t.cn}（${t.en}）${Array.isArray(t.tags) && t.tags.length ? `　标签：${t.tags.join(' / ')}` : ''}`);
  L.push(`- **是什么**：${t.desc}`);
  L.push(`- **参数**：${t.params}`);
  L.push(`- **何时用**：${t.use}`);
  L.push(`- **怎么写**：${t.how}`);
  L.push(`- **预览**：\`动效设计师-超级聚合体.html\` 搜 \`${t.id}\` 或 \`${t.cn}\`（demo 类名 \`${t.demo}\`）`);
  L.push('');
  return L.join('\n');
}

// ───────────────────────── 自检（含负控）─────────────────────────

function selftest() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  // --- 真数据正控 ---
  const { terms, loaded, failed } = loadShards();
  const a = audit(terms, loaded);
  add('源分片全部解析成功', failed.length === 0, failed.length ? failed.map(f => f.file).join(',') : '23 分片');
  add('条目数 558（源库下限）', terms.length >= 558, `实际 ${terms.length}`);
  add('10 个字段无缺失', !a.problems.some(p => p.startsWith('字段缺失')), a.problems.filter(p => p.startsWith('字段缺失')).join('|') || 'ok');
  add('无 id 重复', !a.problems.some(p => p.startsWith('id 重复')), 'ok');
  add('分类 ≥30', a.stats.cats >= 30, `实际 ${a.stats.cats}`);
  add('id 格式合规', !a.problems.some(p => p.startsWith('id 格式')), 'ok');

  // --- 检索正控（★ 用【可判定】判据，不用拍脑袋的绝对 rel 阈值）---
  const r2 = search('逐字显现 文字一个一个出来', terms, { top: 3 });
  add('正控：术语名精确命中（意图含"逐字显现" ⇒ top1.cn 必须是它）',
    r2[0].t.cn === '逐字显现', `top1=${r2[0].t.id} ${r2[0].t.cn}`);

  const r1 = search('数字往上滚 指标增长', terms, { top: 3 });
  add('正控：语义命中（top3 里必须有 cn 含"数字"的条目）',
    r1.slice(0, 3).some(x => String(x.t.cn).includes('数字')),
    'top3 = ' + r1.map(x => x.t.cn).join(' / '));

  // --- 负控（★ 相对判据：内容词直连必须比对口意图差 —— 不依赖绝对阈值）---
  const r3 = search('视频链路还涉及 PSRAM，这颗芯片', terms, { top: 3 });
  add('负控：内容词直连 ⇒ 必须差于对口意图',
    r3[0].rel < r1[0].rel,
    `内容词 rel=${r3[0].rel.toFixed(2)} < 对口 rel=${r1[0].rel.toFixed(2)}`);

  const r4 = search('', terms, { top: 3 });
  add('负控：空意图 ⇒ 不崩且 rel=0', r4.every(x => x.rel === 0), `rel=${r4[0].rel}`);

  const r5 = search('zzz不存在的概念qqq', terms, { top: 3 });
  add('负控：查无此物 ⇒ 低相关度且不编造', r5[0].rel < 0.5, `top1 rel=${r5[0].rel.toFixed(2)}`);

  // --- 排序稳定性提示（铁律 188：写了机制必须验证它会触发）---
  const ub1 = unstableHint(search('大字逐字入场 reveal 曲线描线生长 环形进度', terms, { top: 3 }));
  add('正控：意图并列多动效 ⇒ 排序不稳定提示要响', !!ub1, ub1 ? 'ok' : '未响');
  const ub2 = unstableHint(search('逐字显现 文字一个一个出来 错峰', terms, { top: 3 }));
  add('负控：意图聚焦 ⇒ 不该报排序不稳定', !ub2, ub2 ? '误报' : 'ok（未响）');

  // --- 合成坏数据（判据必须能 FAIL）---
  const bad = JSON.parse(JSON.stringify(terms.slice(0, 5)));
  bad[0].params = '';
  bad[1].how = null;
  bad[3].id = bad[0].id;                       // 制造重复
  bad[4].id = 'XX';                            // 制造格式异常
  const ab = audit(bad, loaded);
  const hasField = ab.problems.some(p => p.startsWith('字段缺失'));
  const hasDup = ab.problems.some(p => p.startsWith('id 重复'));
  const hasFmt = ab.problems.some(p => p.startsWith('id 格式'));
  const hasDist = ab.problems.some(p => p.includes('总条目'));
  add('负控：合成坏卡 ⇒ 字段缺失判据响', hasField, ab.problems.filter(p => p.startsWith('字段缺失')).join('|') || '未响');
  add('负控：合成坏卡 ⇒ id 重复判据响', hasDup, hasDup ? 'ok' : '未响');
  add('负控：合成坏卡 ⇒ id 格式判据响', hasFmt, hasFmt ? 'ok' : '未响');
  add('负控：只喂 5 条 ⇒ 全局分布守卫响', hasDist, hasDist ? 'ok' : '未响');

  // --- 新鲜度机制（铁律 188：写了机制必须验证它会触发）---
  const fresh = freshness(loaded);
  add('新鲜度：索引存在时能判定 fresh/stale', fresh.state === 'fresh' || fresh.state === 'stale' || fresh.state === 'absent',
    `state=${fresh.state}`);

  const ok = checks.every(c => c.ok);
  console.log('');
  console.log('=== term selftest ===');
  for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name} ｜ ${c.detail}`);
  console.log(ok ? 'SELFTEST_OK' : 'SELFTEST_FAIL');
  process.exit(ok ? 0 : 1);
}

// ───────────────────────── main（仅 CLI 直跑时执行；被 import 时不执行）─────────────────────────

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function main() {

const O = parseArgv(process.argv.slice(2));
if (O.selftest) selftest();

let bundle;
try {
  bundle = loadShards();
} catch (e) {
  console.error('[FATAL] ' + e.message);
  process.exit(2);
}
const { terms, loaded, failed } = bundle;

if (failed.length) {
  // 铁律 182：空 except 禁 —— 分片失败必须吼出来
  console.error(`[WARN] ${failed.length} 个分片解析失败（不静默跳过）：`);
  for (const f of failed) console.error(`   ${f.file}  ${f.err}`);
}

const auditRes = audit(terms, loaded);
const rev = writeIndex(terms, loaded, auditRes.stats);
const fresh = freshness(loaded);
const cats = Object.entries(auditRes.stats.catCount).sort((a, b) => b[1] - a[1]);

if (O.show) {
  const t = terms.find(x => x.id.toLowerCase() === String(O.show).toLowerCase());
  if (!t) {
    console.error(`[FATAL] 库里没有这个 id：${O.show}（id 形如 E01 / Kt07 / Cr12）`);
    process.exit(1);
  }
  console.log(`\n=== ${t.id} · ${t.cn} / ${t.en} ===`);
  for (const f of FIELDS) {
    const v = f === 'tags' ? (Array.isArray(t.tags) ? t.tags.join(' / ') : t.tags) : t[f];
    console.log(`  ${f.padEnd(7)}: ${v}`);
  }
  console.log(`  来源分片: ${t._shard}`);
  process.exit(0);
}

if (!O.intent) {
  console.log(`\n=== term · 动效术语库 ===`);
  console.log(`源        : ${SRC_DIR}`);
  console.log(`分片      : ${loaded.length} 个 terms-*.js（失败 ${failed.length}）`);
  console.log(`条目      : ${terms.length}`);
  console.log(`分类      : ${auditRes.stats.cats} 类`);
  console.log(`revision  : ${rev}　新鲜度 ${fresh.state}`);
  console.log(`索引      : ${IDX_FILE}`);
  if (auditRes.problems.length) {
    console.log(`problems  : ${auditRes.problems.length}`);
    for (const p of auditRes.problems.slice(0, 6)) console.log('   - ' + p);
  } else {
    console.log('problems  : 0  → TERMS_OK');
  }
  console.log('');
  console.log('分类分布（前 12）：');
  for (const [c, n] of cats.slice(0, 12)) console.log(`   ${String(n).padStart(3)}  ${c}`);
  console.log(`
用法：
  node term.mjs --intent "数字往上滚 指标增长"        # 按动效意图检索（先自己写意图，别拿文案原文）
  node term.mjs --intent "..." --cat 缓动 --top 5
  node term.mjs --show E01
  node term.mjs --selftest`);
  process.exit(0);
}

const results = search(O.intent, terms, { cat: O.cat, top: O.top });

if (O.json) {
  console.log(JSON.stringify({
    intent: O.intent, cat: O.cat, revision: rev,
    results: results.map(r => ({ id: r.t.id, cn: r.t.cn, en: r.t.en, cat: r.t.cat, rel: +r.rel.toFixed(3), params: r.t.params, how: r.t.how })),
  }, null, 1));
  process.exit(0);
}

const head = [];
head.push(`# 动效术语检索　意图「${O.intent}」${O.cat ? `　分类 ${O.cat}` : ''}`);
head.push('');
head.push(`> 源库 \`<术语库目录>\`（**${terms.length} 条 / ${auditRes.stats.cats} 类**）· revision \`${rev}\``);
head.push('>');
head.push('> **排序**：2-gram 重叠 × 字段权重（`cn`/`en`/`tags` 最高，`how` 最低）+ 术语名/ID 精确命中加分。');
head.push('> **该怎么用**：`怎么说` 列拿去跟人沟通/写文档；`参数` + `怎么写` 列拿去落地实现。');
head.push('> ⚠️ 意图由人/AI 写（**别拿文案原文直连**，实测 rel≈0.05）；检索不到就报低相关度，不编。');
head.push('');
const body = results.map((r, i) => renderHit(r, i + 1)).join('\n');
const text = head.join('\n') + body;
const dest = O.out || path.join(HERE, 'term-report.md');
fs.writeFileSync(dest, text, 'utf8');

console.log('');
console.log('=== term ===');
console.log('intent : ' + O.intent);
console.log('cat    : ' + (O.cat ?? '(all)'));
console.log('rev    : ' + rev + '  (' + terms.length + ' 条)');
console.log('report : ' + dest);
results.forEach((r, i) => {
  console.log(`  ${i + 1}. ${r.t.id.padEnd(5)} ${String(r.t.cn).padEnd(10)} rel=${r.rel.toFixed(2)}  ${r.t.cat}`);
});
const w = relWarning(results[0]?.rel ?? 0);
if (w) console.log('\n' + w.replace(/\*\*/g, ''));

// ★ 排序稳定性提示（判定逻辑见 unstableHint 的注释）
const uh = unstableHint(results);
if (uh) console.log('\n' + uh.replace(/\*\*/g, ''));
console.log('TERM_OK');

}

if (IS_MAIN) main();
