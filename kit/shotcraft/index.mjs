#!/usr/bin/env node
/**
 * kit/shotcraft/index.mjs —— 镜头卡「选型索引」生成器
 *
 * 作用：把上游 video-shotcraft 的 157 张镜头卡，从
 *   gallery/api/library.json（机器索引）+ references/shots/<cat>/*.md（卡片正文）
 * 现场解析成一份**结构化、可检索**的 index.json，供写分镜表时调用。
 *
 * ★★★ 三条设计纪律（别破坏）：
 *   1. **数据驱动、禁手抄**：卡名/时长/参数一律现场解析。
 *      手抄的清单一过上游更新就过期 —— 这是本工具存在的唯一理由。
 *   2. **技法卡必须保留**：有 7 张卡是「寄生型技法」（n/a，本身不占整镜，
 *      寄生在别的落位动作上）。它们解析不出时长 ⇒ **不能当解析失败丢掉**，
 *      要标 kind='technique'。分镜时它们只能挂在别镜身上，不能当独立镜。
 *   3. **解析不出就吼**：任何一张卡字段缺失，报告里列出来并让退出码非 0，
 *      不许静默跳过（同族教训：静默失败最贵）。
 *
 * 用法：
 *   node index.mjs                 # 生成 index.json + index.md + _parse-report.json
 *   node index.mjs --quiet         # 只出 ASCII 摘要
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// kit/shotcraft/ -> 语音转动画总项目/
const TOP = path.resolve(HERE, '..', '..');
const LIB = path.join(TOP, '资产库', 'video-shotcraft');
const OUT = HERE;
const QUIET = process.argv.includes('--quiet');

const log = (...a) => { if (!QUIET) console.log(...a); };

// ───────────────────────── 解析工具 ─────────────────────────

/** 取 frontmatter（157/157 都有） */
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** 按 `## 段名` 切正文，返回 { 段名: 内容 } */
function parseSections(text) {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
  const secs = {};
  const re = /^## (.+)$/gm;
  const hits = [];
  let m;
  while ((m = re.exec(body))) hits.push({ name: m[1].trim(), start: m.index, bodyAt: re.lastIndex });
  hits.forEach((h, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].start : body.length;
    secs[h.name] = body.slice(h.bodyAt, end).trim();
  });
  return secs;
}

/**
 * 时长解析。
 * 上游写法五花八门，实测覆盖率 150/157，剩下 7 张是寄生型技法卡。
 * 返回 { kind, min, max, raw }；kind ∈ 'shot' | 'technique' | 'unknown'
 *
 * ★ 两条判定纪律（都是实测逼出来的）：
 *   ① **只认 `s`（秒），不认裸 `f`**。裸帧数在上游是「动作段占用帧数」
 *      （例：slam-entrance-moves `单式动作段 6–22f + 冲击余波 ~16f + hold ≥45f`），
 *      那是**技法内部**的节拍，不是整镜时长。当成秒数解会得到 0.2s 这种荒谬镜长。
 *      例外：`156f@30fps` 明确带 fps ⇒ 那确实是整镜帧数，可换算。
 *   ② 判「技法卡」优先看**有没有「X式选型」段**（多方案技法卡的本质特征），
 *      而不是靠 `n/a` 字面匹配 —— `slam-entrance-moves` 就没写 n/a。
 */
function parseDuration(raw, hasVariantSection) {
  const s = String(raw || '');
  // ① 上游自己标了 n/a / 寄生 / 技法卡
  const declared = /n\/a/i.test(s) || /寄生/.test(s) || /技法卡/.test(s);
  // ② 收集所有 `~4.3s` / `4–5s` / `约5.2s` 形态（只认秒）
  const spans = [];
  const rangeRe = /([\d.]+)\s*[–~\-—]\s*([\d.]+)\s*s/g;
  const oneRe = /([\d.]+)\s*s/g;
  let m;
  while ((m = rangeRe.exec(s))) spans.push([parseFloat(m[1]), parseFloat(m[2])]);
  let lo = null, hi = null;
  if (spans.length) {
    lo = Math.min(...spans.map(x => x[0]));
    hi = Math.max(...spans.map(x => x[1]));
  } else {
    const ones = [];
    while ((m = oneRe.exec(s))) ones.push(parseFloat(m[1]));
    if (ones.length) { lo = Math.min(...ones); hi = Math.max(...ones); }
  }
  if (lo == null) {
    // ③ 兜底：`156f@30fps` 这种带 fps 的整镜帧数
    const f = s.match(/([\d.]+)\s*f\s*@\s*(\d+)\s*fps/);
    if (f && !declared && !hasVariantSection) return { kind: 'shot', min: parseFloat(f[1]) / parseFloat(f[2]), max: parseFloat(f[1]) / parseFloat(f[2]), raw: s };
  }
  if (lo == null) {
    // 无秒可解：有选型段 ⇒ 多方案技法卡；否则交给人看（unknown）
    return { kind: declared || hasVariantSection ? 'technique' : 'unknown', min: null, max: null, raw: s };
  }
  return { kind: declared ? 'technique' : 'shot', min: lo, max: hi, raw: s };
}

/** 能量档位：原文是自由文本（"中高（信息持续增加…）"），抽出档位 + 保留原文 */
const ENERGY_ORDER = ['由低到高', '由高到低', '中高', '中低', '混合', '低', '中', '高'];
function parseEnergy(raw) {
  const s = String(raw || '');
  const hit = ENERGY_ORDER.find(k => s.includes(k));
  return { energy: hit || null, raw: s };
}

/** 参数表 → [{param, value, feel}]；上游 157/157 都有这一段 */
function parseParamTable(sec) {
  if (!sec) return [];
  const rows = [];
  for (const line of sec.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    if (cells.every(c => /^:?-{2,}:?$/.test(c) || c === '')) continue; // 分隔行
    if (cells[0] === '参数') continue;                                   // 表头
    rows.push({
      param: cells[0] || '',
      value: cells[1] || '',
      feel: cells[2] || '',            // ★ 「调节手感」——卡片最值钱的一列
      extra: cells.slice(3).join(' | ') || undefined,
    });
  }
  return rows;
}

/** 已知坑 → 列表项 */
function parsePitfalls(sec) {
  if (!sec) return [];
  const out = [];
  for (const line of sec.split('\n')) {
    const t = line.trim();
    if (/^[-*]\s+/.test(t)) out.push(t.replace(/^[-*]\s+/, ''));
    else if (t && !t.startsWith('#') && out.length) out[out.length - 1] += ' ' + t; // 续行
  }
  return out;
}

// ───────────────────────── 主流程 ─────────────────────────

const libPath = path.join(LIB, 'gallery', 'api', 'library.json');
if (!fs.existsSync(libPath)) {
  console.error('[FATAL] 找不到 library.json: ' + libPath);
  process.exit(2);
}
const lib = JSON.parse(fs.readFileSync(libPath, 'utf8'));
const cats = lib.categories || {};

const cards = [];
const mdProblems = [];   // 读 md 阶段的问题（文件缺失/无 frontmatter/缺段落）

for (const c of lib.cards) {
  const mdPath = path.join(LIB, c.source);
  if (!fs.existsSync(mdPath)) {
    mdProblems.push({ id: c.name, why: 'library.json 指向的 md 不存在', path: c.source });
    continue;
  }
  const text = fs.readFileSync(mdPath, 'utf8');
  const fm = parseFrontmatter(text);
  const secs = parseSections(text);

  if (!fm) { mdProblems.push({ id: c.name, why: '无 frontmatter' }); continue; }

  // 段名核对：157/157 应有这四个
  for (const need of ['意图', '参数表', '已知坑', '参考实现']) {
    if (!secs[need]) mdProblems.push({ id: c.name, why: `缺段落「${need}」` });
  }

  // 「式选型」段（两式/三式/六式…）：转场类是多方案卡，原文必须保留。
  // ★ 它同时是「技法卡」的本质判据 —— 先算出来，再交给时长解析用。
  const variants = {};
  for (const [k, v] of Object.entries(secs)) {
    if (/式选型/.test(k)) variants[k] = v;
  }
  const hasVariantSection = Object.keys(variants).length > 0;

  const dur = parseDuration(fm['时长'] || c.duration, hasVariantSection);
  const en = parseEnergy(fm['能量'] || c.energy);

  cards.push({
    id: fm.name || c.name,
    cat: c.category,
    catZh: cats[c.category]?.zh || c.category,
    summary: fm['一句话'] || c.summary || '',
    use: fm['适用'] || c.use || '',
    intention: (secs['意图'] || c.intention || '').replace(/\s+/g, ' ').trim(),
    duration: { ...dur },
    /**
     * ★ 短镜友好标记 —— 纯数值判断，不做语义猜测。
     * 由来：实测本线 30 镜，**中位镜长 2.10s / 97% 的镜短于卡片下界中位数 4.00s**
     * （卡片库是为「一镜 4–5s」的宣传片设计的，语音轴是「一镜 2–3s」）。
     * ⇒ 卡片不能整镜照搬，只能拆段取用；筛「下界 ≤3s」的卡能少一半的压缩工作。
     * ⚠️ 口径 = **「这张卡存在 ≤3s 的用法」**（多方案卡取所有变体下界的最小值），
     *    不等于"整卡就是短的"。min>0 是排掉解析到的非时长数字（纯 0 不是有效镜长）。
     */
    shortFriendly: dur.kind === 'shot' && dur.min != null && dur.min > 0 && dur.min <= 3.0,
    energyTier: en.energy,
    energyRaw: en.raw,
    tags: (fm['标签'] || '').split(/[、,，/]/).map(s => s.trim()).filter(Boolean),
    kind: dur.kind,
    params: parseParamTable(secs['参数表']),
    pitfalls: parsePitfalls(secs['已知坑']),
    core: (secs['动效核心'] || '').replace(/\s+/g, ' ').trim() || null,
    variants,
    refImpl: (secs['参考实现'] || '').replace(/\s+/g, ' ').trim(),
    styles: (c.styles || []).map(s => ({ key: s.key, label: s.label })),
    md: c.source,
    media: (c.styles || []).map(s => s.media?.url).filter(Boolean),
  });
}

// ───────────────────────── 自检（判据要能 FAIL）─────────────────────────

/**
 * 库体检。返回 problems[]（空 = 绿）。
 * ★ 抽成函数是为了能被 --selftest 用**合成坏卡**喂进来 ——
 *   "跑绿"不算数，得证明**判据在数据坏掉时真的会报**。
 */
function audit(cards, expectedCount) {
  const out = [];
  const byKind = cards.reduce((a, c) => (a[c.kind] = (a[c.kind] || 0) + 1, a), {});
  if (cards.length !== expectedCount) {
    out.push({ id: '(全局)', why: `产出卡数 ${cards.length} != library.json 卡数 ${expectedCount}` });
  }
  for (const c of cards) {
    if (!c.params.length) out.push({ id: c.id, why: '参数表解析为空' });
    if (!c.pitfalls.length) out.push({ id: c.id, why: '已知坑解析为空' });
    // ★ 技法卡**允许**没有能量档位 —— 上游自己标了「n/a（技法卡，不占能量位）」。
    //   起初把这类当解析失败报出来，是判据写错了，不是数据坏了。
    if (!c.energyTier && c.kind !== 'technique') out.push({ id: c.id, why: '能量档位解析不出' });
    // ★ 我自己第一版漏掉的判据：kind 解析不出（既非 shot 也非 technique）必须报，
    //   否则一张卡会静默地既没时长也不进技法卡池，等于从库里消失。
    if (c.kind === 'unknown') out.push({ id: c.id, why: '时长/类型解析不出（既非镜头卡也非技法卡）' });
    if (c.variants && Object.keys(c.variants).length > 0
      && Object.values(c.variants).every(v => !String(v).trim())) {
      out.push({ id: c.id, why: '选型段解析为空' });
    }
  }
  // 分布守卫：解析规则一旦失效，卡会整体塌进某一类 —— 用分布兜住
  if ((byKind.technique ?? 0) > 15) {
    out.push({ id: '(全局)', why: `technique 卡异常多 =${byKind.technique}，疑似时长解析规则失效` });
  }
  if ((byKind.shot ?? 0) < 140) {
    out.push({ id: '(全局)', why: `shot 卡只有 ${byKind.shot ?? 0} 张，疑似解析规则失效（期望 ≥140）` });
  }
  return out;
}

const problems = [...mdProblems, ...audit(cards, lib.cards.length)];
const byKind = cards.reduce((a, c) => (a[c.kind] = (a[c.kind] || 0) + 1, a), {});
const noParam = cards.filter(c => c.params.length === 0).map(c => c.id);
const noPit = cards.filter(c => c.pitfalls.length === 0).map(c => c.id);
const noEnergy = cards.filter(c => !c.energyTier && c.kind !== 'technique').map(c => c.id);
const unknownKind = cards.filter(c => c.kind === 'unknown').map(c => c.id);
const emptyVariants = cards.filter(c => c.variants && Object.keys(c.variants).length > 0
  && Object.values(c.variants).every(v => !String(v).trim())).map(c => c.id);
const index = {
  generated: new Date().toISOString(),
  upstream: {
    repo: 'https://github.com/Vincentwei1021/video-shotcraft',
    revision: lib.revision,
    generatedAt: lib.generatedAt,
    cards: lib.cards.length,
    styles: lib.stats?.styleCount ?? null,
  },
  stats: {
    cards: cards.length,
    byKind,
    byCat: cards.reduce((a, c) => (a[c.cat] = (a[c.cat] || 0) + 1, a), {}),
    shortFriendly: cards.filter(c => c.shortFriendly).length,
    durMedianMin: (() => {
      const xs = cards.filter(c => c.kind === 'shot' && c.duration.min != null)
        .map(c => c.duration.min).sort((a, b) => a - b);
      return xs.length ? +(xs[Math.floor(xs.length / 2)]).toFixed(2) : null;
    })(),
  },
  categories: cats,
  cards,
};

fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1), 'utf8');

// 人读版速查表（按分类分组，只列一行摘要 —— 给「扫一遍找候选」用）
const lines = [];
lines.push('# 镜头卡选型索引（自动生成，勿手改）');
lines.push('');
lines.push(`> 生成：${index.generated} ｜ 上游 revision \`${lib.revision}\` ｜ ` +
  `${cards.length} 张卡 / ${index.upstream.styles} 个样片`);
lines.push('> 重新生成：`node kit/shotcraft/index.mjs`（上游更新后重跑，本文件与 index.json 一起刷新）');
lines.push('');
lines.push('**时长**列 = 卡片自报的典型时长（秒）；`技法` = 寄生型技法卡，**不占整镜**，只能挂在别的镜头上。');
lines.push('');
for (const [cat, meta] of Object.entries(cats)) {
  const list = cards.filter(c => c.cat === cat);
  if (!list.length) continue;
  lines.push(`## ${cat} · ${meta.zh}（${list.length}）`);
  lines.push('');
  lines.push('| id | 时长 | 能量 | 一句话 |');
  lines.push('|---|---|---|---|');
  for (const c of list.sort((a, b) => a.id.localeCompare(b.id))) {
    const d = c.kind === 'technique' ? '技法'
      : c.duration.min == null ? '?'
        : c.duration.min === c.duration.max ? `${c.duration.min}s`
          : `${c.duration.min}–${c.duration.max}s`;
    lines.push(`| \`${c.id}\` | ${d} | ${c.energyTier || '?'} | ${c.summary.replace(/\|/g, '/')} |`);
  }
  lines.push('');
}
fs.writeFileSync(path.join(OUT, 'index.md'), lines.join('\n'), 'utf8');

const report = {
  ok: problems.length === 0,
  generated: index.generated,
  counts: { cards: cards.length, byKind, noParam: noParam.length, noPitfalls: noPit.length, noEnergy: noEnergy.length },
  problems,
};
fs.writeFileSync(path.join(OUT, '_parse-report.json'), JSON.stringify(report, null, 1), 'utf8');

// ───────────────────────── --selftest：证明判据有牙 ─────────────────────────
// 纪律：判据"跑绿"不等于判据有效。这里把**本轮真踩到的坑**当回归用例喂回去。
if (process.argv.includes('--selftest')) {
  const fails = [];
  const eq = (label, got, want) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g !== w) fails.push(`${label}: got ${g} want ${w}`);
  };
  // ① 裸帧数**不是**秒 —— 这张卡解出 0.2s 就是荒唐的镜长（真坑）
  eq('裸帧数判技法卡', parseDuration('单式动作段 6–22f + 冲击余波 ~16f + hold ≥45f', true).kind, 'technique');
  eq('n/a 判技法卡', parseDuration('n/a（技法卡；各式占用帧数见参数表）', false).kind, 'technique');
  eq('寄生型判技法卡', parseDuration('寄生型——沸腾段随宿主 hold 长度，无自身时长', false).kind, 'technique');
  // ② 秒的三种写法
  const a = parseDuration('约 3.8s（114f@30fps）', false);
  eq('单值秒', [a.kind, a.min, a.max], ['shot', 3.8, 3.8]);
  const b = parseDuration('约 4–5s（120–150f，含 ≥15f 完成态静止）', false);
  eq('区间秒', [b.kind, b.min, b.max], ['shot', 4, 5]);
  const c = parseDuration('A ~4.8s / B ~5.3s', false);
  eq('多方案秒取并集', [c.min, c.max], [4.8, 5.3]);
  // ③ 解不出来必须是 unknown（**绝不能静默当成 shot**）—— 这条是救命判据
  eq('空时长判 unknown', parseDuration('', false).kind, 'unknown');
  eq('纯帧数无 fps 且无选型段 -> unknown', parseDuration('6–22f', false).kind, 'unknown');
  // ④ 带 fps 的整镜帧数可以换算
  eq('Nf@fps 换算', parseDuration('156f@30fps', false).min, 5.2);
  // ⑤ 能量 / 参数表 / 已知坑
  eq('能量 n/a 判 null', parseEnergy('n/a（技法卡，不占能量位）').energy, null);
  eq('能量档序优先', parseEnergy('中高（信息持续增加）').energy, '中高');
  eq('能量 由低到高', parseEnergy('由低到高（前 2/3 是酝酿）').energy, '由低到高');
  const tbl = parseParamTable('| 参数 | 典型值 | 调节手感 |\n|---|---|---|\n| gap | 0.05 | 3–4f 是甜点 |');
  eq('参数表列数', tbl.length, 1);
  eq('参数表三列', [tbl[0].param, tbl[0].value, tbl[0].feel], ['gap', '0.05', '3–4f 是甜点']);
  eq('已知坑续行合并', parsePitfalls('- 第一行\n  续行内容').length, 1);
  // ⑥ 库体检对**坏数据**必须报（负控）
  const bad = [
    { id: 'bad-no-params', kind: 'shot', params: [], pitfalls: ['x'], energyTier: '中', variants: {} },
    { id: 'bad-unknown-kind', kind: 'unknown', params: [1], pitfalls: ['x'], energyTier: '中', variants: {} },
    { id: 'bad-shot-no-energy', kind: 'shot', params: [1], pitfalls: ['x'], energyTier: null, variants: {} },
    { id: 'ok-technique-no-energy', kind: 'technique', params: [1], pitfalls: ['x'], energyTier: null, variants: {} },
  ];
  const probs = audit(bad, 4).map(p => p.id + ':' + p.why);
  const caught = id => probs.some(p => p.startsWith(id + ':'));
  if (!caught('bad-no-params')) fails.push('负控漏网：参数表为空没报');
  if (!caught('bad-unknown-kind')) fails.push('负控漏网：kind=unknown 没报');
  if (!caught('bad-shot-no-energy')) fails.push('负控漏网：镜头卡无能量没报');
  if (caught('ok-technique-no-energy')) fails.push('假 FAIL：技法卡（上游标"不占能量位"）被误报');
  // 4 条 = 3 条卡片级 + 1 条全局分布守卫（合成样本只有 2 张 shot < 140，守卫会响）
  eq('负控应报 4 条（3 卡片级 + 1 全局分布守卫）', probs.length, 4);
  if (!probs.some(p => p.startsWith('(全局)'))) fails.push('负控漏网：全局分布守卫没响');

  console.log('');
  console.log('=== selftest ===');
  if (fails.length) { fails.forEach(f => console.log('  FAIL  ' + f)); console.log('SELFTEST_FAIL (' + fails.length + ')'); }
  else console.log('SELFTEST_OK  (16 checks, incl. 4 negative controls)');
  process.exit(fails.length ? 1 : 0);
}

log('');
log('=== shotcraft index ===');
log('cards         : ' + cards.length + '  (library.json says ' + lib.cards.length + ')');
log('by kind       : ' + JSON.stringify(byKind));
log('by category   : ' + JSON.stringify(index.stats.byCat));
log('no param table: ' + noParam.length + (noParam.length ? ' -> ' + noParam.join(',') : ''));
log('no pitfalls   : ' + noPit.length + (noPit.length ? ' -> ' + noPit.join(',') : ''));
log('no energy     : ' + noEnergy.length + ' (technique cards exempt)' + (noEnergy.length ? ' -> ' + noEnergy.join(',') : ''));
log('unknown kind  : ' + unknownKind.length + (unknownKind.length ? ' -> ' + unknownKind.join(',') : ''));
log('empty variants: ' + emptyVariants.length + (emptyVariants.length ? ' -> ' + emptyVariants.join(',') : ''));
log('problems      : ' + problems.length);
for (const p of problems.slice(0, 20)) log('   ! ' + p.id + ' : ' + p.why);
log('wrote         : index.json / index.md / _parse-report.json');
log(problems.length ? 'INDEX_WARN' : 'INDEX_OK');

process.exit(problems.length ? 1 : 0);
