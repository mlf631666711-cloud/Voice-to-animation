#!/usr/bin/env node
/* =============================================================================
 * check_wording.js —— 动画描述词校验器
 *
 * 配套 skill：`~/.workbuddy/skills/animation-description/`
 * 依据：`语音转动画-规格锁.md` §5.11 元素级动效工艺规格
 *        `语音转动画-学习知识库.md` §11（emilkowalski/skills 调研）
 *
 * 用法：
 *   node kit/check_wording.js <分镜表.json>
 *   node kit/check_wording.js <工程目录>        # 扫目录下所有 *.json
 *   node kit/check_wording.js <file> --warn     # 把 WARN 也算失败
 *
 * 查什么：元素级动效的描述词是否达标（**不管摄像机运镜**，那是 3D 那套）
 *   ① 缺 Purpose（六词之一）        ④ staggerGap 不在 30~80ms
 *   ② 单元素 > 700ms               ⑤ 整组 stagger > 500ms
 *   ③ 用了禁用曲线（lin / 进场 ease-in） ⑥ 静态卡给了过冲 / 无 settle
 *   ⑦ 高频元素（出现≥3次）时长 > 250ms
 *
 * 兼容两种写法：
 *   A) 新写法  layers[].anim = { enter, purpose, freq, dur, ease, pop, stagger, settle }
 *   B) 旧写法  layers[] 直接带 pop / staggerGap / staggerRise（3D 引擎字段）
 *
 * 退出码：0 通过 / 1 有 FAIL / 2 参数或解析错
 * ========================================================================== */

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const STRICT = argv.includes('--warn');
const target = argv.find(a => !a.startsWith('--'));

if (!target) {
  console.error('\n用法：node kit/check_wording.js <分镜表.json | 工程目录> [--warn]\n');
  process.exit(2);
}

/* ---------- 常量（对齐规格锁 §5.11） ---------- */
const PURPOSE = ['Feedback', 'Focus', 'Explanation', 'Hierarchy', 'Delight', 'Continuity'];
const EASE_IN = ['ei', 'qi', 'xi', 'ci', 'easeIn', 'ease-in'];           // 禁用于进场
const BANNED = ['lin', 'linear'];                                        // 除匀速巡航
/* 重力/落体类入场：ease-in 在这里是**物理必需**（物体自静止起加速下落），
 * 与判据要禁的「犹犹豫豫地冲进来」是**相反**语义 —— 一个是迟迟不动，
 * 一个是干脆利落地砸下来。判据曾把二者混为一谈，这条是补那个空白。
 * 放行需**同时**满足：① enter 声明为落体类 ② 写了 _why（为什么必须加速）。
 * 只满足 ① 不满足 ② ⇒ WARN（不静默放过）。 */
const GRAVITY_ENTER = /fall|drop|gravity|slam|land|drip|leak|plunge|descend|tumble/i;
const DUR_MAX = 700;
const DUR_OK = [150, 300];
const GAP_OK = [30, 80];
const GROUP_MAX = 500;
const HF_MAX = 250;          // 高频元素上限

/* ---------- 收集文件 ---------- */
let files = [];
let st;
try { st = fs.statSync(target); } catch (e) {
  console.error('\n❌ 找不到：' + target + '\n'); process.exit(2);
}
if (st.isDirectory()) {
  for (const f of fs.readdirSync(target)) {
    if (/\.json$/i.test(f) && !/^_/.test(f)) {
      const p = path.join(target, f);
      try { if (fs.statSync(p).isFile()) files.push(p); } catch (e) { /* ignore */ }
    }
  }
} else files.push(target);

if (!files.length) { console.error('\n❌ 没找到可分��的 .json\n'); process.exit(2); }

/* ---------- 检查 ---------- */
const issues = [];   // { level, file, id, msg }
const add = (level, file, id, msg) => issues.push({ level, file, id, msg });

// 统计元素出现次数（判断高频）
const freqMap = new Map();

for (const file of files) {
  let spec;
  try { spec = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { add('WARN', path.basename(file), '-', 'JSON 解析失败：' + e.message); continue; }

  const layers = Array.isArray(spec.layers) ? spec.layers : [];
  if (!layers.length) {
    add('WARN', path.basename(file), '-', '没有 layers[]，跳过');
    continue;
  }

  // 先统计出现次数
  for (const L of layers) freqMap.set(String(L.id), (freqMap.get(String(L.id)) || 0) + 1);

  for (const L of layers) {
    const id = String(L.id || '(未命名)');
    const a = L.anim || null;

    /* ==== A) 新写法：有 anim 块 ==== */
    if (a) {
      // ① Purpose
      if (!a.purpose) add('FAIL', path.basename(file), id, '缺 `purpose` —— Purpose 六词说不出来 = 这个动效没必要（六词：' + PURPOSE.join(' / ') + '）');
      else if (!PURPOSE.some(p => String(a.purpose).toLowerCase() === p.toLowerCase()))
        add('FAIL', path.basename(file), id, '`purpose` = "' + a.purpose + '" 不在六词内（' + PURPOSE.join(' / ') + '）');

      // ② 时长
      if (a.dur != null) {
        if (a.dur > DUR_MAX) add('FAIL', path.basename(file), id, '单元素 `dur` = ' + a.dur + 'ms > 700ms（一票否决）');
        else if (a.dur < DUR_OK[0]) add('WARN', path.basename(file), id, '`dur` = ' + a.dur + 'ms < 150ms，可能快到看不清');
        else if (a.dur > DUR_OK[1] && !(a._why || a.reason))
          add('WARN', path.basename(file), id, '`dur` = ' + a.dur + 'ms > 300ms，超 300ms 规则须在 `_why` 里写理由（大位移/戏剧性/需要观众阅读）');
      } else add('WARN', path.basename(file), id, '缺 `dur`（建议 150~300ms）');

      // ③ 曲线
      const ease = a.ease == null ? null : String(a.ease);
      const enterStr = String(a.enter || '').toLowerCase();
      const isGravity = GRAVITY_ENTER.test(enterStr);
      if (ease) {
        if (BANNED.includes(ease)) add('FAIL', path.basename(file), id, '`ease` = ' + ease + ' —— 禁 linear（非匀速巡航场景）');
        if (EASE_IN.some(e => String(ease).toLowerCase() === e.toLowerCase())) {
          if (isGravity && (a._why || a.reason)) {
            /* 落体加速：enter 已声明物理来路 + 写了理由 ⇒ 放行 */
          } else if (isGravity) {
            add('WARN', path.basename(file), id, '`ease` = ' + ease + ' 是 ease-in；enter="' + enterStr + '" 属落体类，但**没写 `_why`** —— 补上「为什么必须加速」即可放行（落体加速是 ease-in 的正当场景，犹犹豫豫冲进来不是）');
          } else {
            add('FAIL', path.basename(file), id, '`ease` = ' + ease + ' 是 ease-in，**禁用于进场**（"犹犹豫豫地冲进来"= 廉价感头号来源）');
          }
        }
      } else add('WARN', path.basename(file), id, '缺 `ease`（建议 qo / xo / cio / bo）');

      // ⑥ 过冲正当性
      //    关键不是「有没有位移」，而是「是不是被外力带出来的」。
      //    slideUp / rise / fade 是元素自己走完行程（自力更生），没有动量残余 → pop:0 正确，不报警
      //    fly / swing / whip / snap / throw 才是被甩的，或显式标了 momentum:true / fromCamera:true
      const enter = enterStr;                       /* 曲线检查段已取过（同一作用域） */
      const INERTIAL = /fly|swing|whip|snap|throw|fling|sling/;
      /* ★ 重力也是「来路」：落体 / 滴漏 / 砸下都是被外力（重力）带出来的，
       *   与 fly / throw 同族。原判据只认「被甩出去的」那几种，不认「被砸下来的」
       *   ⇒ 空投舱带着真过冲落地，反被读成「无动量却弹」。 */
      const hasMomentum = INERTIAL.test(enter) || GRAVITY_ENTER.test(enter) ||
                          a.momentum === true || a.fromCamera === true;
      const isStatic = !hasMomentum;
      const pop = a.pop == null ? 0 : a.pop;

      if (isStatic && pop > 0)
        add('FAIL', path.basename(file), id,
          '静态建立（enter=' + (a.enter || '?') + '，没有来路/非惯性）却给了 `pop`=' + pop +
          ' —— 无动量却弹 = 抽搐，应 `pop:0`（只有 fly/swing/whip/snap 或被镜头冲近才成立）');
      if (hasMomentum && pop === 0)
        add('WARN', path.basename(file), id,
          '惯性入场（enter=' + a.enter + '）但 `pop`=0 —— 带惯性的运动建议 0.10~0.14');

      // settle
      if (a.settle === false) add('FAIL', path.basename(file), id, '`settle:false` —— 结束直接 snap 到终值，无长尾（一票否决）');

      // ④ ⑤ stagger
      if (a.stagger) {
        const g = a.stagger.gap, per = a.stagger.perItem, tot = a.stagger.totalMax;
        if (g != null && (g < GAP_OK[0] * 1 || g > GAP_OK[1]))
          add('FAIL', path.basename(file), id, '`stagger.gap` = ' + g + 'ms 不在 ' + GAP_OK[0] + '~' + GAP_OK[1] + 'ms（默认 60）');
        if (per != null && (per < DUR_OK[0] || per > DUR_OK[1]))
          add('WARN', path.basename(file), id, '`stagger.perItem` = ' + per + 'ms 超出 150~300ms');
        if (tot != null && tot > GROUP_MAX)
          add('FAIL', path.basename(file), id, '`stagger.totalMax` = ' + tot + 'ms > 500ms（整组超时）');
        // 算实际总时长
        const kids = a.stagger.count || L.kids || null;
        if (kids && g != null && per != null) {
          const real = g * (kids - 1) + per;
          if (real > GROUP_MAX)
            add('WARN', path.basename(file), id, '实算整组时长 = ' + real + 'ms（gap ' + g + ' × (n-1=' + (kids - 1) + ') + ' + per + '）> 500ms，建议后半段并行');
        }
      }

      // ⑦ 高频
      const freq = String(a.freq || '');
      const hits = freqMap.get(id) || 1;
      const highFreq = /100\+/.test(freq) || /10~50/.test(freq) || /高频/.test(freq) || hits >= 3 || L.repeat >= 3;
      if (highFreq && a.dur != null && a.dur > HF_MAX)
        add('WARN', path.basename(file), id, '高频元素（freq=' + (a.freq || '出现 ' + hits + ' 次') + '）时长 ' + a.dur + 'ms > ' + HF_MAX + 'ms，应压到 150~250ms');

      continue;
    }

    /* ==== B) 旧写法：3D 引擎裸字段 ==== */
    if (L.pop != null) {
      if (L.pop > 0.16) add('WARN', path.basename(file), id, '`pop` = ' + L.pop + ' > 0.16，过冲偏大（UI 级建议 ≤0.15）');
      if (L.pop > 0 && /fade|appear/i.test(String(L.html || '')) === false && L.enterStatic === true)
        add('FAIL', path.basename(file), id, '标了 `enterStatic` 却给了 `pop`=' + L.pop + '（静态建立不该弹）');
    }
    if (L.staggerGap != null) {
      const ms = L.staggerGap * 1000;
      if (ms < GAP_OK[0] || ms > GAP_OK[1])
        add('FAIL', path.basename(file), id, '`staggerGap` = ' + L.staggerGap + 's (' + ms + 'ms) 不在 ' + GAP_OK[0] + '~' + GAP_OK[1] + 'ms');
    }
    if (L.popIn != null && L.popIn * 1000 > DUR_MAX)
      add('FAIL', path.basename(file), id, '`popIn` = ' + L.popIn + 's > 700ms（一票否决）');
  }
}

/* ---------- 报告 ---------- */
const fails = issues.filter(i => i.level === 'FAIL');
const warns = issues.filter(i => i.level === 'WARN');

const L = [];
L.push('');
L.push('════════════════════════════════════════════════════════');
L.push(' 动画描述词校验 · ' + files.map(f => path.basename(f)).join(', '));
L.push('════════════════════════════════════════════════════════');
L.push(' 依据：规格锁 §5.11 元素级动效工艺规格 / 学习知识库 §11');
L.push(' 元素数：' + (freqMap.size || 0));
L.push('');

if (!issues.length) {
  L.push(' ✅ 描述词全部达标。');
  L.push('');
} else {
  if (fails.length) {
    L.push(' ❌ FAIL ' + fails.length + ' 条（一票否决级）');
    for (const i of fails) L.push(`    [${i.file}] ${i.id}：${i.msg}`);
    L.push('');
  }
  if (warns.length) {
    L.push(' ⚠️  WARN ' + warns.length + ' 条');
    for (const i of warns) L.push(`    [${i.file}] ${i.id}：${i.msg}`);
    L.push('');
  }
}

L.push(' ── 一票否决 7 条 ──');
L.push('   1 用 lin   2 元素>700ms   3 进场 ease-in   4 无错峰');
L.push('   5 说不出 Purpose   6 结束 snap 无 settle   7 静态卡给过冲');
L.push('');
L.push(' ── 决策顺序（写分镜时按这个填）──');
L.push('   频率 → Purpose 六词 → 时长 → 曲线 → 过冲');
L.push('');

console.log(L.join('\n'));

const bad = fails.length || (STRICT && warns.length);
process.exit(bad ? 1 : 0);
