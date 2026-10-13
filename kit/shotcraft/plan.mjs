#!/usr/bin/env node
/**
 * plan.mjs —— 文案 → **动效设计方案**（怎么写 + 怎么说）
 *
 * ┌─ 分工（本线铁律 181：语义判断与检索不许合并）─────────────────────┐
 * │  ① 读文案、切镜、给每镜写「动效意图」  → 人 / AI  做（语义判断）      │
 * │  ② 意图 → 术语库 / 镜头卡 检索、时长对账、同质化检查 → 本工具做      │
 * │  ③ 「这句怎么落地」的取舍             → 人 / AI  做（写进 note）      │
 * └──────────────────────────────────────────────────────────────┘
 *
 * 输入：意图清单 JSON（模板见 `node plan.mjs --template`）
 *   {
 *     "project": "rv1106-seg5",
 *     "source":  "文案文件路径（可选，只作溯源）",
 *     "fps": 30,
 *     "shots": [
 *       { "shot": 1, "dur": 1.90,
 *         "text":   "这一镜的文案原文",
 *         "intent": "逐字显现 大字入场 描线生长",     ← 动效语汇（喂**术语库**），不是内容词
 *         "cardIntent": "大字逐字入场 混排字重",     ← 可选：喂**镜头卡库**（两库语汇不同，会互相打架）
 *         "terms":  ["Kt01"],        ← 可选：AI 已锁定的术语 id（会被校验真伪）
 *         "card":   "type-assembly-moves",  ← 可选：AI 已锁定的镜头卡
 *         "note":   "只取 A 式动作段，56f 正好塞进 1.90s"   ← 可选：AI 的落地建议
 *       }
 *     ]
 *   }
 *
 * 输出：`动效设计方案.md`（每镜 = 怎么说 + 怎么写 + 结构参考 + 落地建议）+ 自检段
 *
 * 用法：
 *   node plan.mjs --template                    # 输出输入模板
 *   node plan.mjs <intents.json>                # 出方案
 *   node plan.mjs <intents.json> --out x.md --term-top 3 --card-top 2
 *   node plan.mjs <intents.json> --check        # 只做校验，不出方案
 *   node plan.mjs --selftest
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadShards, search as termSearch, relWarning as termWarn, sourceRevision } from './term.mjs';
import { CARDS, UPSTREAM, candidates, fitDuration, objectMismatch, relWarning as cardWarn } from './pick.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? (argv[i + 1] ?? true) : d; };
const has = n => argv.includes('--' + n);

const FILE = argv.find(a => !a.startsWith('--') && /\.json$/i.test(a));
const TEMPLATE = has('template');
const CHECK_ONLY = has('check');
const SELFTEST = has('selftest');
const TERM_TOP = parseInt(opt('term-top', '3'), 10);
const CARD_TOP = parseInt(opt('card-top', '2'), 10);
const OUT = opt('out');

// ───────────────────────── 输入校验（★ 先校验再干活）─────────────────────────

/** 清单校验：返回 issues 列表（ERR 会让 exit code = 1） */
function validatePlan(plan, terms) {
  const issues = [];
  const termIds = new Set(terms.map(t => t.id));
  const cardIds = new Set(CARDS.map(c => c.id));

  if (!plan || typeof plan !== 'object') { issues.push({ lv: 'ERR', why: '清单不是 JSON 对象' }); return issues; }
  if (!Array.isArray(plan.shots) || !plan.shots.length) { issues.push({ lv: 'ERR', why: '缺 shots 数组或为空' }); return issues; }

  plan.shots.forEach((s, i) => {
    const tag = `镜${s.shot ?? i + 1}`;
    if (s.dur == null || !(Number(s.dur) > 0)) issues.push({ lv: 'ERR', why: `${tag} 缺 dur（实测镜长秒数）—— 时长对账要靠它` });
    if (!s.intent || String(s.intent).trim().length < 2) issues.push({ lv: 'ERR', why: `${tag} 缺 intent（动效意图语汇）` });
    if (!s.text) issues.push({ lv: 'WARN', why: `${tag} 没写 text（文案原文）—— 只影响溯源，不拦` });

    // ★ 锁定 id 真伪校验（防 AI 幻觉编术语/卡名 —— 与 pick --from-spec 同口径）
    for (const id of (s.terms || [])) {
      if (!termIds.has(id)) issues.push({ lv: 'ERR', why: `${tag} 锁定的术语 id \`${id}\` 在库里不存在（幻觉？）` });
    }
    if (s.card && !cardIds.has(s.card)) {
      issues.push({ lv: 'ERR', why: `${tag} 锁定的镜头卡 \`${s.card}\` 在库里不存在（幻觉？）` });
    }

    // ★ 意图像不像「内容词」：成句 + 没有动效语汇 ⇒ 提醒（铁律 181）
    //   阈值说明：意图语汇是**一串短词**（通常 ≤25 字、无句读）；文案原句**成句**（含，。！？；）
    //   ⚠️ 第一版只判 `length > 40` ⇒ 35 字的旁白原句漏过（负控当场抓到）。
    const it = String(s.intent || '');
    const MOTION_WORDS = /入|出|淡|滚|翻|擦|揭示|遮罩|描|缩放|位移|弹|旋|转场|缓动|错峰|stagger|reveal|mask|fade|slide|zoom|rotate|scale|draw/i;
    const looksLikeSentence = /[，。！？；]/.test(it) || it.length > 28;
    if (looksLikeSentence && !MOTION_WORDS.test(it)) {
      issues.push({ lv: 'WARN', why: `${tag} intent 有 ${it.length} 字且${/[，。！？；]/.test(it) ? '含句读' : '偏长'}、没看到动效语汇 —— 像在拿文案原文直连（铁律 181：实测 rel≈0.05）` });
    }
  });

  return issues;
}

// ───────────────────────── 单镜设计 ─────────────────────────

function designShot(s, terms, { termTop, cardTop }) {
  const dur = s.dur != null ? Number(s.dur) : null;
  const intent = String(s.intent || '');
  // ★ 两个库**语汇不同**（术语库偏"技法/实现"，镜头卡偏"整镜结构/时长"），
  //   同一个意图喂两边会互相打架：实测镜1 为修术语把"描线生长"加进 intent，
  //   术语 top1 从 M07 → Kt01 ✓，但镜头卡 top1 从 `type-assembly-moves` 掉成 `draw-svg-trace` ✗。
  //   ⇒ 允许分开写：`cardIntent` 只喂镜头卡库，缺省才回落到 intent。
  const cardIntent = String(s.cardIntent || intent);

  // ① 术语（怎么说 + 怎么写）
  let termHits;
  let lockedTermsUsed = [];
  if (Array.isArray(s.terms) && s.terms.length) {
    termHits = s.terms
      .map(id => terms.find(t => t.id === id))
      .filter(Boolean)
      .map(t => ({ t, rel: null, locked: true }));
    lockedTermsUsed = termHits.map(x => x.t.id);
  } else {
    termHits = termSearch(intent, terms, { top: termTop });
  }

  // ② 镜头卡（这一镜的整体结构）
  let cardHits;
  if (s.card) {
    const c = CARDS.find(x => x.id === s.card);
    cardHits = c ? [{ card: c, rel: null, locked: true, fit: fitDuration(c, dur), penalty: 0, objPenalty: 0, rank: 0 }] : [];
  } else {
    cardHits = candidates(cardIntent, dur, { top: cardTop, inclTech: false });
  }

  // ③ 判定
  // ★★ 这里**不判"缺"** —— 本线第三次踩同一个坑（BUG-2458/2464/2465）：
  //    「rel < 0.5 ⇒ 库里没有」是**没有出处的阈值**，实测会把**对口但用词不同**的项误判成缺
  //    （例：镜6 的 `B04 描边进度环` 完全对口，rel 却在 0.5 以下）。
  //    ⇒ 只报**读数**与"灰区"标记，是不是真缺**由人判**。
  const tRel = termHits[0]?.rel ?? null;
  const cRank = cardHits[0]?.rank ?? null;
  const tLocked = termHits[0]?.locked === true;
  const cLocked = cardHits[0]?.locked === true;
  const lowTerm = !tLocked && tRel != null && tRel < 1.2;   // 1.2 = 实测标定的"偏低"线，非"缺"线
  const lowCard = !cLocked && cRank != null && cRank < 1.2;
  const bothLow = lowTerm && lowCard;

  return { shot: s, dur, intent, cardIntent, termHits, cardHits, lockedTermsUsed, tRel, cRank, tLocked, cLocked, lowTerm, lowCard, bothLow };
}

// ───────────────────────── 渲染 ─────────────────────────

const fmtRel = v => (v == null ? '—' : v.toFixed(2));

function renderTerm(t, rel, locked) {
  const L = [];
  const idTag = locked ? '★锁定' : `rel ${rel.toFixed(2)}`;
  L.push(`- \`${t.id}\`　**${t.cn}** / ${t.en}　｜${t.cat}｜${idTag}`);
  L.push(`  - **怎么说**：${t.cn}（${t.en}）　标签：${Array.isArray(t.tags) ? t.tags.join(' / ') : t.tags}`);
  L.push(`  - 是什么：${t.desc}`);
  L.push(`  - **参数**：${t.params}`);
  L.push(`  - **怎么写**：${t.how}`);
  L.push(`  - 预览：聚合体搜 \`${t.id}\`（demo \`${t.demo}\`）`);
  return L.join('\n');
}

function renderCardHit(r, dur) {
  const c = r.card;
  const dd = c.duration.min === c.duration.max ? `${c.duration.min}s` : `${c.duration.min}–${c.duration.max}s`;
  const L = [];
  const idTag = r.locked ? '★锁定' : `rel ${r.rel.toFixed(2)} → ${r.rank.toFixed(2)}`;
  L.push(`- \`${c.id}\`　${c.catZh}｜典型 ${dd}｜能量 ${c.energyTier || '—'}｜${idTag}`);
  L.push(`  - 是什么：${c.summary}`);
  if (c.params?.length) {
    L.push(`  - 参数手感（前 2 条）：` + c.params.slice(0, 2).map(p => `\`${p.param}\` ${p.value} —— ${p.feel}`).join(' ｜ '));
  }
  if (c.pitfalls?.length) L.push(`  - 已知坑：${c.pitfalls[0]}`);
  if (!r.locked && dur != null && r.fit?.note) L.push(`  - **时长对账**：${r.fit.note}`);
  return L.join('\n');
}

function renderPlan(plan, designs, rev, termMeta) {
  const L = [];
  const total = designs.reduce((a, d) => a + (d.dur || 0), 0);

  L.push(`# 动效设计方案 · ${plan.project || plan.name || '（未命名）'}`);
  L.push('');
  L.push(`> 镜数 **${designs.length}**｜总时长 **${total.toFixed(2)}s**｜fps ${plan.fps ?? 30}`);
  if (plan.source) L.push(`> 文案来源：\`${plan.source}\``);
  L.push(`> 术语库 revision \`${rev}\`（${termMeta.terms} 条 / ${termMeta.cats} 类）｜镜头卡库 revision \`${UPSTREAM.revision}\`（${CARDS.length} 张）`);
  L.push('>');
  L.push('> **怎么读这份方案**：`怎么说` 列拿去沟通/写文档，`参数` + `怎么写` 列拿去落地实现，');
  L.push('> `结构参考` 是镜头卡给的整镜骨架（含时长对账），`落地建议` 是人对这一镜的取舍。');
  L.push('> ⚠️ 术语/卡都是**候选**，不是命令 —— 低相关度的行要人判（本工具不替你拍板）。');
  L.push('');

  // 总览表
  L.push('## 总览');
  L.push('');
  L.push('| 镜 | 时长 | 怎么说（术语） | 怎么写（关键参数） | 结构卡 | 判定 |');
  L.push('|---|---|---|---|---|---|');
  for (const d of designs) {
    const n = d.shot.shot ?? '?';
    const terms = d.termHits.slice(0, 2).map(x => x.locked ? `\`${x.t.id}\`${x.t.cn}` : `\`${x.t.id}\`${x.t.cn}`).join(' / ') || '—';
    const params = d.termHits[0] ? String(d.termHits[0].t.params).slice(0, 46) + (String(d.termHits[0].t.params).length > 46 ? '…' : '') : '—';
    const card = d.cardHits[0] ? `\`${d.cardHits[0].card.id}\`` : '—';
    let verdict;
    if (d.tLocked || d.cLocked) verdict = '★ 已锁定';
    else if (d.bothLow) verdict = `🟡 两库都低（术语 ${fmtRel(d.tRel)} / 卡 ${fmtRel(d.cRank)}）需人判`;
    else if (d.lowTerm) verdict = `🟡 术语偏低 ${fmtRel(d.tRel)}`;
    else if (d.lowCard) verdict = `🟡 卡偏低 ${fmtRel(d.cRank)}`;
    else verdict = '✅ 命中';
    L.push(`| ${n} | ${d.dur ?? '?'}s | ${terms} | ${params} | ${card} | ${verdict} |`);
  }
  L.push('');

  // 逐镜
  L.push('## 逐镜设计');
  L.push('');
  for (const d of designs) {
    L.push(`### 镜 ${d.shot.shot ?? '?'}　${d.dur ?? '?'}s`);
    L.push('');
    if (d.shot.text) L.push(`- **原文**：${d.shot.text}`);
    L.push(`- **动效意图**（喂术语库）：${d.intent}`);
    if (d.cardIntent !== d.intent) L.push(`- **动效意图**（喂镜头卡库 · 语汇不同所以分开写）：${d.cardIntent}`);
    L.push('');
    L.push('**① 怎么说（术语）**');
    L.push('');
    if (!d.termHits.length) {
      L.push('- （无检索结果）');
    } else {
      for (const h of d.termHits) L.push(renderTerm(h.t, h.rel ?? 0, h.locked));
      if (!d.termHits[0].locked && d.tRel != null && d.tRel < 1.2) {
        L.push(`- ${termWarn(d.tRel)}`);
      }
    }
    L.push('');
    L.push('**② 怎么写（参数 + 实现）**');
    L.push('');
    if (d.termHits.length) {
      L.push(`- 参数：${d.termHits[0].t.params}`);
      L.push(`- 实现：${d.termHits[0].t.how}`);
    } else L.push('- （无）');
    L.push('');
    L.push('**③ 结构参考（镜头卡）**');
    L.push('');
    if (!d.cardHits.length) L.push('- （无检索结果）');
    else {
      for (const h of d.cardHits) L.push(renderCardHit(h, d.dur));
      const om = d.cardHits[0] && objectMismatch(d.cardIntent, d.cardHits[0].card);
      if (om) L.push(`- ${om}`);
      if (!d.cardHits[0].locked && d.cRank != null && d.cRank < 1.2) L.push(`- ${cardWarn(d.cRank)}`);
    }
    L.push('');
    if (d.shot.note) {
      L.push('**④ 落地建议**');
      L.push('');
      L.push(`- ${d.shot.note}`);
      L.push('');
    }
    L.push('---');
    L.push('');
  }

  // 自检
  const tDup = {};
  const cDup = {};
  for (const d of designs) {
    // ★ BUG-FIX 2026-09-23：原来先 `termHits[0] += 1` 再 `slice(0,2)` 又数一遍 top1
    //   ⇒ **每镜 top1 必然计数 ≥2 ⇒ 这条自检恒报「重复」、永久失去判别力**。
    //   （旁证：同段 cDup 无此双计 ⇒ 卡报「无 ✓」而术语恒报 ×2。）
    //   语义：tDup / cDup 数的都是「当**主项**的镜数」—— 一镜只计一次。
    if (d.cardHits[0]) cDup[d.cardHits[0].card.id] = (cDup[d.cardHits[0].card.id] || 0) + 1;
    if (d.termHits[0]) tDup[d.termHits[0].t.id] = (tDup[d.termHits[0].t.id] || 0) + 1;
  }
  const tRepeat = Object.entries(tDup).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
  const cRepeat = Object.entries(cDup).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
  const allShort = designs.length > 1 && designs.every(d => d.cardHits[0]?.fit?.verdict === 'short');
  const lowShots = designs.filter(d => d.lowTerm || d.lowCard)
    .map(d => `镜${d.shot.shot}（术语 ${fmtRel(d.tRel)}${d.lowCard ? ` / 卡 ${fmtRel(d.cRank)}` : ''}）`);

  L.push('## 自检');
  L.push('');
  L.push(`- **术语重复**（同一术语在几镜里当主项 ⇒ 全片同一手法别超 2 次）：` +
    (tRepeat.length ? tRepeat.map(([k, n]) => `\`${k}\`×${n}`).join(' / ') : '无 ✓'));
  L.push(`- **镜头卡重复**（P4 一手法一次主角）：` +
    (cRepeat.length ? cRepeat.map(([k, n]) => `\`${k}\`×${n}`).join(' / ') : '无 ✓'));
  L.push(`- **时长对账**：${allShort ? '⚠️ **全部镜都短于卡片典型时长** ⇒ 全片统一走「拆段取用」（只取动作段，砍 hold）' : '有镜落在卡片典型时长内 ✓'}`);
  L.push(`- **低相关度镜**（rel < 1.2）：${lowShots.length ? lowShots.join(' · ') : '无 ✓'}`);
  L.push('');
  L.push('> ⚠️ **「低相关度」≠「库里没有」** —— 它只说明**用词没对上库里的话术**。');
  L.push('> 修法：**两轮检索** —— 看 top1 的 `cn`/`desc`，把它的词抄进 intent 再跑一次（实测同一语义差 9 倍）。');
  L.push('> 两轮后仍低 ⇒ 才**疑似**库里没这个动效，那时别再换词硬凑，自己写。');
  L.push('>');
  L.push('> ★ 这份方案**不替你拍板**。工具只保证：卡名/术语名真实存在、时长对账口径一致、重复能查出来。');
  L.push('> 「这一镜到底该长什么样」是人的判断 —— 尤其被标 ⚠️ / 🟡 的镜。');

  return L.join('\n');
}

// ───────────────────────── 自检（含负控）─────────────────────────

function selftest() {
  const checks = [];
  const add = (n, ok, d) => checks.push({ n, ok, d });
  const terms = loadShards().terms;

  // 正控：一份好清单必须 0 ERR
  const good = { project: 'T', shots: [
    { shot: 1, dur: 1.9, text: '大字逐字打出', intent: '文字逐字入场 reveal 描线生长', terms: ['Kt01'], card: 'type-assembly-moves', note: '取动作段' },
    { shot: 2, dur: 2.1, text: '两卡并排', intent: '并列卡片 并排入场 stagger 浮现' },
  ] };
  const g = validatePlan(good, terms);
  add('正控：合法清单 0 ERR', !g.some(x => x.lv === 'ERR'), JSON.stringify(g));

  // 负控 1：幻觉术语 id
  const b1 = { shots: [{ shot: 1, dur: 1.9, intent: '文字入场', terms: ['Kt999'] }] };
  add('负控：幻觉术语 id ⇒ ERR', validatePlan(b1, terms).some(x => x.lv === 'ERR' && x.why.includes('Kt999')),
    validatePlan(b1, terms).map(x => x.why).join(' | '));

  // 负控 2：幻觉卡名
  const b2 = { shots: [{ shot: 1, dur: 1.9, intent: '文字入场', card: 'fake-card-2026' }] };
  add('负控：幻觉卡名 ⇒ ERR', validatePlan(b2, terms).some(x => x.lv === 'ERR' && x.why.includes('fake-card-2026')), 'ok');

  // 负控 3：缺 intent
  const b3 = { shots: [{ shot: 1, dur: 1.9, text: 'x' }] };
  add('负控：缺 intent ⇒ ERR', validatePlan(b3, terms).some(x => x.lv === 'ERR' && x.why.includes('intent')), 'ok');

  // 负控 4：缺 dur
  const b4 = { shots: [{ shot: 1, intent: '文字入场' }] };
  add('负控：缺 dur ⇒ ERR', validatePlan(b4, terms).some(x => x.lv === 'ERR' && x.why.includes('dur')), 'ok');

  // 负控 5：把文案原文当意图（长句 + 无动效语汇）
  const b5 = { shots: [{ shot: 1, dur: 2, intent: '这颗芯片把 CPU 内存和显示控制器全塞进了一颗芯片里，成本更低' }] };
  add('负控：长句无动效语汇 ⇒ WARN（像拿文案直连）',
    validatePlan(b5, terms).some(x => x.lv === 'WARN' && x.why.includes('动效语汇')), 'ok');

  // 负控 6：空 shots
  add('负控：空 shots ⇒ ERR', validatePlan({ shots: [] }, terms).some(x => x.lv === 'ERR'), 'ok');

  // 正控：真跑一次完整设计（含两库检索）
  const des = designShot(good.shots[1], terms, { termTop: 3, cardTop: 2 });
  add('正控：完整设计能出术语与卡', des.termHits.length > 0 && des.cardHits.length > 0,
    `terms=${des.termHits.length} cards=${des.cardHits.length} tRel=${(des.tRel ?? 0).toFixed(2)}`);
  add('正控：锁定卡 ⇒ 走锁定分支且 fit 有值', (() => {
    const d2 = designShot(good.shots[0], terms, { termTop: 3, cardTop: 2 });
    return d2.cardHits[0]?.locked === true && !!d2.cardHits[0].fit.verdict;
  })(), 'ok');

  // 正控：渲染不炸且含关键字
  const md = renderPlan(good, [designShot(good.shots[0], terms, { termTop: 3, cardTop: 2 }), des], 'rev', { terms: terms.length, cats: 36 });
  add('正控：方案 md 含四段（怎么说/怎么写/结构参考/自检）',
    md.includes('怎么说（术语）') && md.includes('怎么写（参数 + 实现）') && md.includes('结构参考（镜头卡）') && md.includes('## 自检'),
    `${md.length} 字`);

  // 负控：同质化能被查出来（两镜同卡）
  const dup = [designShot(good.shots[1], terms, { termTop: 3, cardTop: 2 }), designShot(good.shots[1], terms, { termTop: 3, cardTop: 2 })];
  const md2 = renderPlan({ project: 'D' }, dup, 'rev', { terms: terms.length, cats: 36 });
  add('负控：两镜同卡 ⇒ 自检段报重复', /镜头卡重复.*\`/.test(md2), (md2.match(/镜头卡重复[^\n]*/) || [''])[0].slice(0, 60));

  // ★ 双向验收（2026-09-23 补）：上面那条负控只证了「有重复时能报红」，
  //   **没证「无重复时会报绿」** ⇒ 术语双计 bug 就是这样逃逸的（每镜 top1 恒被数两次，
  //   恒报 ×2 而负控照样 PASS）。补两条：术语负控 + 术语正控。
  add('负控：两镜同术语 ⇒ 自检段报重复', /术语重复.*\`/.test(md2), (md2.match(/术语重复[^\n]*/) || [''])[0].slice(0, 60));
  const twoDiff = [designShot(good.shots[0], terms, { termTop: 3, cardTop: 2 }), designShot(good.shots[1], terms, { termTop: 3, cardTop: 2 })];
  const md3 = renderPlan({ project: 'D2' }, twoDiff, 'rev', { terms: terms.length, cats: 36 });
  add('★ 正控：两镜不同术语 ⇒ 自检段须报「无 ✓」',
    /术语重复[^\n]*无 ✓/.test(md3) && /镜头卡重复[^\n]*无 ✓/.test(md3),
    (md3.match(/术语重复[^\n]*/) || [''])[0].slice(0, 60));

  const ok = checks.every(c => c.ok);
  console.log('');
  console.log('=== plan selftest ===');
  for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.n} ｜ ${String(c.d).slice(0, 110)}`);
  console.log(ok ? 'SELFTEST_OK' : 'SELFTEST_FAIL');
  process.exit(ok ? 0 : 1);
}

// ───────────────────────── main ─────────────────────────

if (SELFTEST) selftest();

if (TEMPLATE) {
  const tpl = {
    project: 'rv1106-seg5',
    source: '文案文件路径（可选，只作溯源）',
    fps: 30,
    _说明: 'shots 由人/AI 读文案后切镜并写 intent（动效语汇，不是内容词）。terms/card/note 可选。',
    _cardIntent说明: '★ 术语库与镜头卡库语汇不同 —— 同一个 intent 喂两个库会互相打架。需要时用 cardIntent 单独喂镜头卡库（缺省回落到 intent）。',
    shots: [
      { shot: 1, dur: 1.9, text: '这一镜的文案原文', intent: '逐字显现 大字入场 描线生长 环形进度', cardIntent: '大字逐字入场 混排字重 文字reveal', terms: [], card: '', note: '这一镜的落地取舍（可选）' },
    ],
  };
  const dest = OUT || path.join(HERE, 'plan.template.json');
  fs.writeFileSync(dest, JSON.stringify(tpl, null, 2), 'utf8');
  console.log('模板已写出：' + dest);
  process.exit(0);
}

if (!FILE) {
  console.log(`plan.mjs —— 文案 → 动效设计方案

  node plan.mjs --template                 # 出输入模板
  node plan.mjs <intents.json>             # 出方案（默认 动效设计方案.md）
  node plan.mjs <intents.json> --check     # 只校验
  node plan.mjs --selftest

  --term-top N   每镜给几条术语（默认 3）
  --card-top N   每镜给几张镜头卡（默认 2）
  --out x.md     输出路径`);
  process.exit(0);
}

if (!fs.existsSync(FILE)) { console.error('[FATAL] 找不到清单文件：' + FILE); process.exit(2); }

const bundle = loadShards();
const terms = bundle.terms;
const rev = sourceRevision(bundle.loaded);
const cats = new Set(terms.map(t => t.cat)).size;

let plan;
try {
  plan = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (e) {
  console.error(`[FATAL] 清单不是合法 JSON：${e.name}: ${e.message}`);
  process.exit(2);
}

const issues = validatePlan(plan, terms);
const errs = issues.filter(x => x.lv === 'ERR');

console.log('');
console.log('=== plan ===');
console.log('清单   : ' + FILE);
console.log('镜数   : ' + (plan.shots?.length ?? 0));
console.log('术语库 : rev ' + rev + '（' + terms.length + ' 条 / ' + cats + ' 类）');
console.log('镜头卡 : rev ' + UPSTREAM.revision + '（' + CARDS.length + ' 张）');
console.log('校验   : ' + (issues.length ? `${issues.length} 条（ERR=${errs.length}）` : '0 问题'));
for (const x of issues) console.log(`   ${x.lv}  ${x.why}`);

if (errs.length) {
  console.error('\n[FATAL] 有 ERR，拒绝出方案 —— 先把清单改对（幻觉 id / 缺字段 一律拦）。');
  process.exit(1);
}

if (CHECK_ONLY) { console.log('\nPLAN_CHECK_OK'); process.exit(0); }

const designs = plan.shots.map(s => designShot(s, terms, { termTop: TERM_TOP, cardTop: CARD_TOP }));
const md = renderPlan(plan, designs, rev, { terms: terms.length, cats });
const dest = OUT || path.join(HERE, '动效设计方案.md');
fs.writeFileSync(dest, md, 'utf8');

console.log('方案   : ' + dest + `（${md.length} 字）`);
for (const d of designs) {
  const t = d.termHits[0]; const c = d.cardHits[0];
  console.log(`  镜${String(d.shot.shot ?? '?').padEnd(2)} ${String(d.dur ?? '?').padStart(5)}s  ` +
    `术语 ${t ? t.t.id + ' ' + t.t.cn : '—'}${d.lowTerm ? '(低)' : ''}  ｜ 卡 ${c ? c.card.id : '—'}${d.lowCard ? '(低)' : ''}`);
}
console.log('PLAN_OK');
