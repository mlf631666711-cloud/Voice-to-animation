#!/usr/bin/env node
/**
 * kit/shotcraft/pick.mjs —— 镜头卡「选型器」
 *
 * 定位：**写分镜表时调用的那个入口**。
 * 输入「这一镜要表达什么 + 这一镜实测多长」，输出「候选卡 + 时长对账 + 参数手感 + 已知坑」。
 *
 * ★★★ 与上游最大的不同：**上游是估时长的，我们是量时长的。**
 *   上游流水线阶段 3 要「预留 hold/rest 帧预算」，靠段位占比估算；
 *   我们这条线（voice-axis）已经有 `spec.json` 的 `asr:[t0,t1]` —— 每镜真实时长是**量出来的**。
 *   所以本工具把「时长适配」做成一等公民：卡片典型时长 vs 实测镜长，直接对账并给处理建议。
 *
 * 用法：
 *   # ① 单次选型
 *   node pick.mjs --intent "并列参数 文字 reveal 专业但不抢戏" --dur 2.9
 *   node pick.mjs --intent "..." --dur 4.2 --cat typography --energy 中 --top 5
 *
 *   # ② 批量：直接吃 spec.json（每个 shot 用它的 narration + asr 实测时长）
 *   node pick.mjs --from-spec projects/xxx/spec.json
 *
 *   # ③ 看某张卡全文参数（选定后要看细节）
 *   node pick.mjs --show blur-slide
 *
 * 选项：--cat 分类过滤 · --energy 能量过滤 · --top N · --json 出机器可读
 *      · --include-technique 把寄生型技法卡也纳入（默认排除，它们不占整镜）
 *      · --out <file> 把详细报告（含中文参数表/坑）写成 UTF-8 文件
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOP = path.resolve(HERE, '..', '..');
const IDX = path.join(HERE, 'index.json');
const LIB = path.join(TOP, '资产库', 'video-shotcraft');

if (!fs.existsSync(IDX)) {
  console.error('[FATAL] 缺 index.json —— 先跑: node kit/shotcraft/index.mjs');
  process.exit(2);
}
const idx = JSON.parse(fs.readFileSync(IDX, 'utf8'));
export const CARDS = idx.cards;
export const UPSTREAM = idx.upstream;
export const STATS = idx.stats;

// ★ 参数解析移进 main()（见下方「CLI」段）—— 本文件可被 plan.mjs `import` 复用**同一套打分口径**，
//   避免两处各写一份 score/fitDuration 导致口径漂移（本线铁律：口径不一致 = 静默误判）。
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// ───────────────────────── 检索 ─────────────────────────
/**
 * 中文无分词的实用检索：**2-gram 重叠 + 长词加权子串命中**。
 * 踩过的坑：直接用 `intent.includes(cardField)` 反向匹配会全灭（意图是一句话，
 * 卡里是一段话，永远不是子串关系）⇒ 必须走 n-gram 度量，不能走包含关系。
 */
function ngrams(s, n = 2) {
  const t = String(s).replace(/[\s，。、；：（）()「」【】,.;:!?—\-/]+/g, '');
  const out = new Set();
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n));
  return out;
}
function score(intent, card) {
  const q = ngrams(intent);
  if (!q.size) return { s: 0, hits: [] };
  // 卡的「可检索面」加权：summary/use/intention 权重高，坑与参数次之
  const fields = [
    [card.summary, 3.0], [card.use, 2.5], [card.intention, 1.5],
    [String(card.energyRaw || ''), 0.8],
    [card.pitfalls.join(' '), 0.6],
    [card.params.map(p => p.param + ' ' + p.value + ' ' + p.feel).join(' '), 0.6],
    [(card.tags || []).join(' '), 1.2],
  ];
  let s = 0;
  const hitAll = new Map();
  for (const [text, w] of fields) {
    if (!text) continue;
    const g = ngrams(text);
    let overlap = 0;
    for (const x of q) if (g.has(x)) overlap++;
    s += (overlap / q.size) * w;
    for (const x of q) if (g.has(x)) hitAll.set(x, (hitAll.get(x) || 0) + w);
  }
  // 长词加权：意图里被标点/空格切出来的 ≥2 字词，若原样出现在卡里，额外加分
  const words = String(intent).split(/[\s，。、；：,.;:!?]+/).filter(w => w.length >= 2);
  for (const w of words) {
    const blob = [card.summary, card.use, card.intention, card.id].join(' ');
    if (blob.includes(w)) s += 0.8;
  }
  // 卡 id 直接命中（用户可能直接报卡名）
  if (String(intent).toLowerCase().includes(card.id.toLowerCase())) s += 5;
  return { s, hits: [...hitAll.keys()] };
}

/** 时长对账：这是我们的独有优势（实测镜长 vs 卡片典型时长） */
export function fitDuration(card, dur) {
  if (dur == null) return { verdict: 'na', note: '' };
  if (card.kind === 'technique') return { verdict: 'technique', note: '寄生型技法卡，不占整镜时长' };
  const { min, max } = card.duration;
  if (min == null) return { verdict: 'na', note: '卡片未标典型时长' };
  const tol = 0.4; // 秒。卡片时长是"典型值"，留 ~12 帧余量
  if (dur < min - tol) {
    return {
      verdict: 'short', gap: +(min - dur).toFixed(2),
      note: `镜长 ${dur}s 比卡片典型 ${min}–${max}s 短 ${(min - dur).toFixed(2)}s` +
            `（≈${Math.round((min - dur) * 30)} 帧）⇒ **不能整卡照搬，要拆段取用**：` +
            `① 只取卡片的一个阶段（入场段/落定段），把后续 hold 砍掉；` +
            `② 按上方「参数手感」列往下压，但**每个参数都有下限**（手感列里写了"<N 会怎样"）；` +
            `③ 文案词数直接决定 stagger 总长，**减词比压参数安全**；` +
            `④ 实在压不下 ⇒ 让这个动效**跨两镜完成**（前一镜起手、后一镜落定）。` +
            `⚠️ 别拉伸曲线来"用满"镜长（R3：放慢可以，拖长会散）。`,
    };
  }
  if (dur > max + tol) {
    return {
      verdict: 'long', gap: +(dur - max).toFixed(2),
      note: `镜长 ${dur}s 比卡片典型 ${min}–${max}s 长 ${(dur - max).toFixed(2)}s ⇒ ` +
            `动作完成后补 hold（R1 品牌字标落定 ≥1s），或用双段变体；` +
            `**别拉伸动效**（R3：放慢可以，拖长会散）`,
    };
  }
  return { verdict: 'ok', note: `镜长 ${dur}s 落在卡片典型 ${min}–${max}s 内 ✓` };
}

/**
 * ★ 对象类型错配（2026-09-22 真实工程实测引入 · rv1106-seg5 7 镜里 2 镜中招）
 *
 * 现场：意图写「三卡并列 横排 stagger 入场」「双卡并排入场」，
 *       top1 都是 `type-assembly-moves`（**文字系卡**，四式全是字符级动画）。
 *       换成英文近义词 `three cards side by side entrance` **照样中招**
 *       ⇒ **不是中文分词问题，是检索里缺「对象类型」这一维**。
 *
 * 根因：`type-*` 系列卡的一句话/正文里塞满了「入场 / reveal / stagger / 合拢 / 逐字」
 *       这类**通用运动词**，2-gram 重叠会把它们全部吸到 —— 它们是**吸铁石卡**。
 *
 * 纪律（与 README「尺子①」配套）：**意图语汇必须写「对象词 + 运动词」两段** ——
 *       **对象词决定对错，运动词决定排序。** 只写运动词 ⇒ 吸到文字卡。
 *
 * 处置：① 排序降权（不剔除 —— 降权后仍可能被选走，因为卡库里可能就它有对口手法）
 *       ② stdout 打印一条可判定的警告（只报事实，不猜语义）
 */
const TEXT_OBJ_RE = /文字|字卡|标题|大字|字符|字距|字形|字幕|letter|text|type|word|title|char/i;
// 对象词表：含裸「卡」，但**排除「卡点」**（那是节奏术语，不是对象）。
// ★ 2026-09-22 补：第一版只有「卡片」，于是「**三卡**并列」漏判（镜5 因此没降权）。
const THING_OBJ_RE = /卡片|卡排|卡(?!点)|面板|网格|阵列|图标|图卡|照片|图片|商标|logo|icon|card|panel|grid|photo|tile/i;
const OBJ_MISMATCH_PENALTY = 1.5;

/** 这张卡是不是「文字系」（按分类或卡名前缀，纯结构性判定，不做语义猜测） */
function isTypeCard(card) {
  return card.cat === 'typography' || /^(type|split-|text-|typing-|letter)/i.test(card.id);
}

/** 返回错配说明字符串；不算错配则返回 null */
export function objectMismatch(intent, card) {
  if (!isTypeCard(card)) return null;
  const q = String(intent || '');
  if (TEXT_OBJ_RE.test(q)) return null;      // 意图里本来就点了文字 ⇒ 正当命中
  const m = q.match(THING_OBJ_RE);
  if (!m) return null;                        // 意图里没有明确的其他对象 ⇒ 不妄断
  return `⚠️ **对象类型可能错配**：意图里的对象是「${m[0]}」，` +
    `但候选 \`${card.id}\` 是**文字系卡**（${card.catZh}）。` +
    `通用运动词（入场 / stagger / reveal / 合拢 / 逐字）在文字系卡正文里高频出现 ⇒ 会把它们吸上来。` +
    `⇒ 修法：意图里补上**对象词**（对象词决定对错、运动词决定排序），例：「${m[0]} 三卡并列 横排 入场」。`;
}

/** 相关度过低的警告 —— 防"看起来在跑其实在算命"（实测：旁白直连 rel≈0.05） */
export function relWarning(rel) {
  // ★ 两轮检索提示：同一语义、只用词不同，实测 rel 0.67 → 6.03（**差 9 倍**）。
  //   依据：rv1106-seg5 镜3，「卡片堆叠成摞 扇形散开 延迟错落」→ 0.67（top1 不对口）；
  //   抄 top1 的「一句话」用词改成「卡片 spring 弹入叠成一摞 展成扇面 3D」→ **6.03**，top1 = `card-stack`（完全对口）。
  //   ⇒ 卡片库是**自洽的一套语汇**；近义改写不算数，**要往卡片的话术靠**。
  const ROUND2 = '**两轮检索**：把 top1 的「一句话」里的动效词**抄进**意图再搜一次 —— ' +
    '实测同一镜、同一语义，只用词不同 ⇒ rel **0.67 → 6.03（差 9 倍）**，top1 从不对口变成完全对口。';
  if (rel >= 1.2) return null;
  if (rel >= 0.5) {
    return '相关度偏低：两种可能 ——（a）意图里缺**动效语汇**（"滚动/淡入/发牌/擦除"这类运动词）；' +
      '（b）**用词没对上卡片的话术**。' + ROUND2 +
      ' 若两轮后仍 <1.2，多半是**卡片库真没有这个动效**（见 README「低 rel = 库存缺口」），别再硬凑。';
  }
  return '⚠️ 相关度≈噪声：这个查询几乎没检索到东西。**十有八九是拿"内容词"在搜**（如旁白原句）' +
    '—— 卡片库描述的是**运动语法**，不是内容。请改写成动效语汇再搜（例：把「视频链路还涉及 PSRAM」' +
    '改写成「数字滚动 指标增长 内存占用上升」）。' + ROUND2;
}

export function candidates(intent, dur, { cat, energy, top = 6, inclTech = false } = {}) {
  let pool = CARDS.filter(c => inclTech || c.kind === 'shot');
  if (cat) pool = pool.filter(c => c.cat === cat);
  if (energy) pool = pool.filter(c => c.energyTier === energy);
  return pool
    .map(c => {
      const { s } = score(intent || '', c);
      const fit = fitDuration(c, dur);
      // 时长不合的候选降权，但不剔除 —— 它可能是"压参数后仍最优解"
      const penalty = fit.verdict === 'short' ? 0.35 : fit.verdict === 'long' ? 0.5 : 0;
      // ★ 对象类型错配也降权（不剔除）。依据见 objectMismatch 上方注释。
      const objPenalty = objectMismatch(intent, c) ? OBJ_MISMATCH_PENALTY : 0;
      return { card: c, rel: s, fit, penalty, objPenalty, rank: s - penalty - objPenalty };
    })
    .sort((a, b) => b.rank - a.rank || (b.rel - a.rel))
    .slice(0, top);
}

/** 人类可读的候选块（中文，写文件用） */
export function renderCard(r, i, dur, intent) {
  const c = r.card;
  const L = [];
  const dd = c.kind === 'technique' ? '技法卡（不占整镜）'
    : c.duration.min === c.duration.max ? `${c.duration.min}s`
      : `${c.duration.min}–${c.duration.max}s`;
  L.push(`### ${i}. \`${c.id}\`　${c.catZh}｜典型时长 ${dd}｜能量 ${c.energyTier || '—'}｜` +
    `相关度 ${r.rel.toFixed(2)}${(() => {
      const dims = [];
      if (r.penalty) dims.push(`时长不合降权 −${r.penalty}`);
      if (r.objPenalty) dims.push(`对象类型错配 −${r.objPenalty}`);
      return dims.length ? ` → ${dims.join(' · ')} → 排序分 ${r.rank.toFixed(2)}` : '';
    })()}`);
  L.push('');
  L.push(`- **一句话**：${c.summary}`);
  L.push(`- **何时用**：${c.use}`);
  // ★ 检索质量提示（★ 2026-09-22 修：relWarning 原先**定义了却从没被调用**——死代码 ⇒ 完全没接线）
  const rw = relWarning(r.rel);
  if (rw) L.push(`- **⚠️ 检索质量**：${rw}`);
  const om = objectMismatch(intent, c);
  if (om) L.push(`- ${om}`);
  L.push(`- **时长对账**：${r.fit.note || '（未给实测镜长，跳过对账）'}`);
  if (c.params.length) {
    L.push(`- **参数手感**（卡片原文，取前 4 条）：`);
    for (const p of c.params.slice(0, 4)) L.push(`    - \`${p.param}\` 典型 ${p.value} —— ${p.feel}`);
  }
  if (c.pitfalls.length) {
    L.push(`- **已知坑**（前 3 条）：`);
    for (const p of c.pitfalls.slice(0, 3)) L.push(`    - ${p}`);
  }
  if (Object.keys(c.variants || {}).length) {
    for (const [k, v] of Object.entries(c.variants)) {
      L.push(`- **${k}**（多方案，原文）：${v.replace(/\n+/g, ' ').slice(0, 300)}`);
    }
  }
  L.push(`- **卡片全文**：\`资产库/video-shotcraft/${c.md}\``);
  if (c.media.length) L.push(`- **样片**：\`资产库/video-shotcraft/已下载样片\`·悬停试听见 \`分镜预览.html\` 搜 \`${c.id}\``);
  L.push('');
  return L.join('\n');
}

// ───────────────────────── CLI（仅直跑时执行；被 import 时不执行）─────────────────────────

function main() {

// ───────────────────────── 参数 ─────────────────────────
const argv = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] ?? true) : dflt;
};
const has = name => argv.includes('--' + name);
const INTENT = opt('intent');
const DUR = opt('dur') != null ? parseFloat(opt('dur')) : null;
const CAT = opt('cat');
const ENERGY = opt('energy');
const TOPN = parseInt(opt('top', '6'), 10);
const FROM_SPEC = opt('from-spec');
const SHOW = opt('show');
const OUT = opt('out');
const INCL_TECH = has('include-technique');
const AS_JSON = has('json');

// ───────────────────────── 三种模式 ─────────────────────────

// ③ --show：看某张卡全文（选定后的深读）
if (SHOW) {
  const c = CARDS.find(x => x.id === SHOW);
  if (!c) {
    console.error('[FATAL] 库里没有这张卡：' + SHOW + '  （卡名必须与 index.json 完全一致）');
    process.exit(2);
  }
  const md = fs.readFileSync(path.join(LIB, c.md), 'utf8');
  console.log(md);
  process.exit(0);
}

// ② --from-spec：**分镜选型审计**（不是"自动出候选"）
//
// ★★★ 为什么不自动出候选（本轮实测教训，别退回去）：
//   第一版是"读每镜旁白 → 直接当检索词 → 出候选"。跑通了，但质量是假的：
//     · 旁白「视频链路还涉及 PSRAM」→ top1 `cube-navigation`，**相关度 0.05**（纯噪声）
//     · 改成写对的动效意图「数字滚动 指标增长 内存占用上升」→ top1 `odometer-digit-roll`，
//       **相关度 2.35**（46 倍）
//   问题在于：**旁白说的是"内容"，卡片写的是"运动语法"** —— 两个语义域。
//   更糟的是它**照常输出一份漂亮排名**，看起来在工作，实际在算命。
//   ⇒ 正确分工：**旁白 → 动效意图 = 语义判断（由 AI 做，用 --intent）；**
//      **动效意图 → 候选卡 = 检索（由工具做）。** 工具不许假装能做前者。
//
// 所以本模式只做**能确定的事**：卡名真实性 / 时长对账 / 手法同质化 / 未选型镜清单。
if (FROM_SPEC) {
  // 路径宽容：先按 cwd 解，不行再按**工程根**解（实测相对 cwd 会解到 kit/projects/... 去）
  const resolveSpec = p => {
    if (fs.existsSync(p)) return p;
    const alt = path.join(TOP, p);
    if (fs.existsSync(alt)) return alt;
    console.error('[FATAL] 找不到 spec：' + p + '（也试过 ' + alt + '）');
    process.exit(2);
  };
  const specPath = resolveSpec(FROM_SPEC);
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const shots = spec.shots || [];
  if (!shots.length) {
    console.error('[FATAL] spec 里没有 shots[]：' + specPath);
    process.exit(2);
  }
  const byId = new Map(CARDS.map(c => [c.id, c]));

  const shotTime = sh => {
    const t0 = sh.t0 ?? (Array.isArray(sh.asr) ? sh.asr[0] : null);
    const t1 = sh.t1 ?? (Array.isArray(sh.asr) ? sh.asr[1] : null);
    return (t0 != null && t1 != null) ? { t0, t1, dur: +(t1 - t0).toFixed(2) } : { t0: null, t1: null, dur: null };
  };
  const shotLabel = sh => sh.narration || sh.caption || sh.subject || '(无文案)';
  // spec 里的选型字段：兼容 `card` 对象 / `card` 字符串 / `card.shot` + `card.cam`
  const cardRefs = sh => {
    const c = sh.card;
    if (!c) return [];
    if (typeof c === 'string') return [{ role: 'shot', id: c }];
    const out = [];
    for (const role of ['shot', 'cam', 'fx']) if (c[role]) out.push({ role, id: c[role], variant: c.variants?.[role] });
    return out;
  };

  const rows = shots.map(sh => {
    const t = shotTime(sh);
    const refs = cardRefs(sh).map(r => {
      const card = byId.get(r.id);
      return {
        ...r, card,
        exists: !!card,
        isTech: card ? card.kind === 'technique' : null,
        fit: card ? fitDuration(card, t.dur) : null,
        shrinkable: card?.shortFriendly ?? null,
      };
    });
    return { sh, ...t, refs };
  });

  // ① 结构差预警：**从数据算**，不手填
  const durs = rows.map(r => r.dur).filter(x => x != null).sort((x, y) => x - y);
  const med = durs.length ? durs[Math.floor(durs.length / 2)] : null;
  const cardMed = idx.stats.durMedianMin;
  const shortCount = cardMed != null ? durs.filter(x => x < cardMed).length : 0;

  // ② 问题清单
  const issues = [];
  for (const r of rows) {
    if (!r.refs.length) { issues.push({ lv: 'TODO', shot: r.sh.shot, why: '未选型（没写 card 字段）' }); continue; }
    for (const f of r.refs) {
      if (!f.exists) issues.push({ lv: 'ERR', shot: r.sh.shot, why: `卡名不存在：\`${f.id}\`（**幻觉卡名，必须改**）` });
      else if (f.isTech && f.role === 'shot') issues.push({ lv: 'ERR', shot: r.sh.shot, why: `\`${f.id}\` 是寄生型技法卡，不能当镜头主卡（只能挂 \`card.fx\`）` });
      else if (f.fit?.verdict === 'short') issues.push({ lv: 'WARN', shot: r.sh.shot, why: `\`${f.id}\` 时长超预算 ${f.fit.gap}s，需拆段取用` });
      else if (f.fit?.verdict === 'long') issues.push({ lv: 'INFO', shot: r.sh.shot, why: `\`${f.id}\` 撑不满，补 hold 或换卡` });
    }
  }
  // ③ 手法同质化（P4：一种动效手法全片只当一次主角）
  const useCount = new Map();
  for (const r of rows) for (const f of r.refs) if (f.role === 'shot') useCount.set(f.id, (useCount.get(f.id) || 0) + 1);
  for (const [id, n] of useCount) {
    if (n > 1) issues.push({ lv: 'WARN', shot: '—', why: `\`${id}\` 全片用了 ${n} 次 ⇒ 违 P4「一手法一次主角」（重复镜头/信息应先删）` });
  }

  // ④ 报告
  const L2 = [];
  L2.push(`# 分镜选型审计 · ${spec.title || spec.name || path.basename(specPath)}`);
  L2.push('');
  L2.push(`> \`kit/shotcraft/pick.mjs --from-spec\` ｜ ${shots.length} 镜 ｜ ` +
    `卡片库 revision \`${idx.upstream.revision}\`（${idx.stats.cards} 张 / 短镜友好 ${idx.stats.shortFriendly} 张）`);
  L2.push('>');
  L2.push('> 本模式**只做确定性检查**（卡名真实性 / 时长对账 / 手法同质化），**不猜动效意图** ——');
  L2.push('> 实测拿旁白直连检索只有 0.05 相关度（噪声级），却会照常输出排名。');
  L2.push('> 要挑卡，请先由人/AI 把这一镜的**动效意图**写出来，再跑：');
  L2.push('> `node pick.mjs --intent "<动效语汇>" --dur <实测秒>`');
  L2.push('');
  L2.push('## 一、结构差预警（自动从数据算，非手填）');
  L2.push('');
  L2.push(`- 本片镜长：中位 **${med ?? '?'}s** / 最长 **${durs.length ? durs[durs.length - 1] : '?'}s**（${durs.length} 镜有 t0/t1）`);
  L2.push(`- 卡片库：镜头卡典型时长**下界中位 ${cardMed ?? '?'}s**`);
  if (med != null && cardMed != null) {
    L2.push(`- ⇒ **${shortCount}/${durs.length} 镜（${Math.round(100 * shortCount / durs.length)}%）短于卡片下界中位**，` +
      `典型差 **${(cardMed - med).toFixed(2)}s ≈ ${Math.round((cardMed - med) * 30)} 帧**`);
    L2.push('- ⇒ **卡片不能整镜照搬**：只取其中一个阶段（入场段/落定段），砍掉后续 hold；');
    L2.push('  或按各卡「参数手感」列往下压（**每个参数都有下限**）；或让动效**跨两镜完成**。');
    L2.push(`- 省力入口：卡片库里有 **${idx.stats.shortFriendly} 张「短镜友好」卡**（存在 ≤3s 的用法），优先从这里挑。`);
  }
  L2.push('');
  L2.push('## 二、逐镜状态');
  L2.push('');
  L2.push('| 镜 | 实测 | 文案 | 选的卡 | 卡名 | 时长对账 |');
  L2.push('|---|---|---|---|---|---|');
  for (const r of rows) {
    const refs = r.refs.length
      ? r.refs.map(f => `\`${f.id}\`${f.variant ? `(${f.variant})` : ''}${f.role !== 'shot' ? `·${f.role}` : ''}`).join(' + ')
      : '**（未选）**';
    const ok = r.refs.length ? r.refs.map(f => f.exists ? '✓' : '**✗**').join(' ') : '—';
    const ft = r.refs.length
      ? r.refs.map(f => !f.fit ? '—' : ({
        ok: '✓ 合', short: `**短 ${f.fit.gap}s**`, long: `长 +${f.fit.gap}s`,
        technique: '技法', na: '—',
      })[f.fit.verdict]).join(' ')
      : '—';
    L2.push(`| ${r.sh.shot} | ${r.dur ?? '?'}s | ${String(shotLabel(r.sh)).slice(0, 24)} | ${refs} | ${ok} | ${ft} |`);
  }
  L2.push('');
  L2.push('## 三、问题清单');
  L2.push('');
  if (!issues.length) L2.push('（无）');
  else {
    for (const lv of ['ERR', 'WARN', 'TODO', 'INFO']) {
      const g = issues.filter(x => x.lv === lv);
      if (!g.length) continue;
      L2.push(`**${lv}**（${g.length}）`);
      L2.push('');
      for (const x of g) L2.push(`- [镜 ${x.shot}] ${x.why}`);
      L2.push('');
    }
  }
  L2.push('## 四、未选型的镜该往哪找（按分类导航，不猜意图）');
  L2.push('');
  const todo = rows.filter(r => !r.refs.length);
  if (!todo.length) L2.push('（全部已选型）');
  else {
    L2.push(`${todo.length} 镜待选。下面按**实测时长能容纳**过滤出候选池（每类列 3 张），`);
    L2.push('具体挑哪张取决于这一镜要表达什么 —— **先写出动效意图，再 `--intent` 精查**。');
    L2.push('');
    for (const r of todo) {
      L2.push(`### 镜 ${r.sh.shot}　「${String(shotLabel(r.sh)).slice(0, 40)}」　实测 ${r.dur}s`);
      L2.push('');
      const pool = CARDS.filter(c => c.kind === 'shot' && c.shortFriendly);
      const byCat = {};
      for (const c of pool) (byCat[c.catZh] = byCat[c.catZh] || []).push(c);
      for (const [cat, list] of Object.entries(byCat)) {
        L2.push(`- **${cat}**：` + list.slice(0, 3).map(c => `\`${c.id}\``).join(' / '));
      }
      L2.push('');
    }
  }

  const text = L2.join('\n');
  const dest = OUT || path.join(HERE, 'pick-audit.md');
  fs.writeFileSync(dest, text, 'utf8');
  console.log('');
  console.log('=== pick --from-spec (audit) ===');
  console.log('spec    : ' + specPath);
  console.log('shots   : ' + shots.length + '   selected: ' + rows.filter(r => r.refs.length).length +
    '   todo: ' + rows.filter(r => !r.refs.length).length);
  if (med != null && cardMed != null) {
    console.log('len     : median ' + med + 's  vs card floor median ' + cardMed + 's  ->  ' +
      shortCount + '/' + durs.length + ' shots shorter');
  }
  console.log('issues  : ' + issues.length + '   (' +
    ['ERR', 'WARN', 'TODO', 'INFO'].map(l => l + '=' + issues.filter(x => x.lv === l).length).join(' ') + ')');
  for (const x of issues.filter(x => x.lv === 'ERR').slice(0, 8)) console.log('   ERR  ' + x.why);
  console.log('report  : ' + dest);
  console.log('PICK_AUDIT_DONE');
  process.exit(issues.some(x => x.lv === 'ERR') ? 1 : 0);
}

// ① 单次选型
if (!INTENT) {
  console.log(`shotcraft pick —— 镜头卡选型器

  node pick.mjs --intent "<这一镜要表达什么>" --dur <实测秒> [--cat 分类] [--energy 能量] [--top N]
  node pick.mjs --from-spec <spec.json>        # 批量：按每镜 narration + asr 时长出候选
  node pick.mjs --show <card-id>               # 看某张卡全文

  --include-technique   连寄生型技法卡一起搜（默认排除：它们不占整镜）
  --out <file>          详细报告落盘（默认 pick-report.md）
  --json                出机器可读

  分类(${Object.keys(idx.categories).join(' / ')})
  能量(低 / 中 / 中高 / 高 / 混合)`);
  process.exit(0);
}

const results = candidates(INTENT, DUR, { cat: CAT, energy: ENERGY, inclTech: INCL_TECH, top: TOPN });

if (AS_JSON) {
  console.log(JSON.stringify({
    intent: INTENT, dur: DUR, cat: CAT, energy: ENERGY,
    results: results.map(r => ({
      id: r.card.id, cat: r.card.cat, catZh: r.card.catZh, rel: +r.rel.toFixed(3),
      duration: r.card.duration, energy: r.card.energyTier, kind: r.card.kind,
      fit: r.fit, md: r.card.md,
      params: r.card.params.slice(0, 4), pitfalls: r.card.pitfalls.slice(0, 3),
    })),
  }, null, 1));
  process.exit(0);
}

const head = [];
head.push(`# 选型候选　意图「${INTENT}」${DUR != null ? `　实测镜长 ${DUR}s` : ''}`);
head.push('');
head.push(`> \`kit/shotcraft/pick.mjs\` ｜ 卡片库 revision \`${idx.upstream.revision}\`（${idx.stats.cards} 张）`);
head.push('>');
head.push('> **排序规则**：`相关度` = 2-gram 重叠 × 字段权重（一句话/何时用/意图 权重最高）。');
head.push('> 给了实测镜长时，**时长不合的候选会被降权**（偏短 −0.35 / 偏长 −0.50）——');
head.push('> 所以会出现「相关度高但排在后面」的情况，那是**时长不匹配**，不是算错。');
head.push('> 意图里出现**卡片/面板/网格/图标**这类对象词、而候选是**文字系卡**时，再降权 **−1.50**：');
head.push('> `type-*` 系列是**吸铁石卡**（正文塞满"入场 / stagger / reveal / 合拢"这类通用运动词），');
head.push('> 2026-09-22 实测：`三卡并列 横排 stagger 入场` 的 top1 曾被它吸走（英文近义词同样中招）。');
head.push('> ⇒ **意图语汇要写「对象词 + 运动词」两段：对象词决定对错，运动词决定排序。**');
head.push('> 时长不合 ≠ 淘汰：压 stagger / 补 hold 后它仍可能是最优解，看每条下面的「时长对账」。');
head.push('>');
head.push('> **定案后**：把卡 id 写进 spec 的 `card.id`，然后跑 `verify.mjs` 校验（卡名真实存在 / 时长一致 / 手法不重复）。');
head.push('');
const body = results.map((r, i) => renderCard(r, i + 1, DUR, INTENT)).join('\n');
const text = head.join('\n') + body;
const dest = OUT || path.join(HERE, 'pick-report.md');
fs.writeFileSync(dest, text, 'utf8');

console.log('');
console.log('=== pick ===');
console.log('intent : ' + INTENT);
console.log('dur    : ' + (DUR ?? '(none)'));
console.log('report : ' + dest);
results.forEach((r, i) => {
  const f = r.fit.verdict === 'ok' ? 'OK ' : r.fit.verdict === 'short' ? 'SHORT' : r.fit.verdict === 'long' ? 'LONG ' : '--  ';
  const dims = [];
  if (r.penalty) dims.push(`${r.penalty}`);
  if (r.objPenalty) dims.push(`${r.objPenalty}`);
  console.log(`  ${i + 1}. [${f}] ${r.card.id.padEnd(34)} rel=${r.rel.toFixed(2)}` +
    (dims.length ? ` −${dims.join(' −')} → ${r.rank.toFixed(2)}` : '        ') + `  ${r.card.catZh}`);
});
// ★ 检索质量提示（输出到终端，别只写在报告里 —— 报告不一定有人看）
const top1 = results[0];
if (top1) {
  const rw = relWarning(top1.rel);
  if (rw) console.log('\n' + rw.replace(/\*\*/g, ''));
  const om = objectMismatch(INTENT, top1.card);
  if (om) console.log('\n' + om.replace(/\*\*/g, ''));
}
console.log('PICK_OK');

}

if (IS_MAIN) main();
