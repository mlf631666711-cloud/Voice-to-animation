#!/usr/bin/env node
/* =============================================================================
 * new_project.js —— 「语音转动画」工程脚手架生成器
 *
 * 用法：
 *   node new_project.js --spec <分镜表.json> [--out <工程目录>] [--force] [--mode 3d]
 *
 * 2D 模式（默认，spec 里是 cam / camkeys 那套六必填运镜字段）：
 *   fx_<name>.html   工程主文件（bg/mg/fg 三层视差 + 每镜 TODO + 安全框自检）
 *   _render.js       配置 + 调 render-core 的 renderProject
 *   _audit.js        调 voice-axis-regression-audit 做回归体检
 *                    ⚠️ **可选件**：那个 skill 不随仓库分发 ⇒ 没有它时本脚本
 *                     **根本不生成 `_audit.js`**（免得给出一个必然报错的"下一步"）
 *
 * 3D 模式（spec.mode = "3d"）：多一个真 3D 摄影机
 *   fx_<name>.html   #screen(胶片) → #viewport(perspective) → #camera(逆矩阵) → #world(图层)
 *   分镜表改用 layers[]（3D 图层）+ shots[].cam3d[]（运镜配方序列）：
 *     "layers": [{"id":"C1","x":0,"y":-60,"z":0,"w":900,"h":520,"html":"<div class='card'>…</div>"}]
 *     "cam3d" : [{"type":"place","at":{"x":0,"y":-40,"z":1500},"look":"C1"},
 *                {"type":"orbit","subject":"C1","angleDeg":35,"dur":2.4},
 *                {"type":"push","subject":"C1","dist":500,"dur":1.2}]
 *   配方在**生成期**展开成关键帧内联进 HTML（运行时零依赖、完全确定性）。
 *   可选步骤：place / dolly / orbit / crane / dollyZoom / parallax /
 *             dutchTilt / push / pull / rackFocus / flyTo
 *
 * 已有文件不覆盖，除非带 --force。
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const KIT = __dirname;
const TPL_DIR = path.join(KIT, 'templates');

/** ★ 生成 `_audit.js` 的前提：本机有没有那个「回归体检」skill。
 *
 *  它**不随本仓库分发** —— 是作者跨项目复用的内部工具。所以对开源用户来说
 *  `existsSync` 恒为 false，而脚手架以前**照样生成 `_audit.js`**、还把它印成
 *  「下一步：node _audit.js」，于是别人 clone 后第一次照做就吃一个 exit 1
 *  （2026-10-08 实测撞出来）。
 *  ⇒ 现在改成：**没这个 skill 就不生成那个文件**，产出物里不留跑不了的脚本。
 *     想接自己的体检工具：`VA_AUDIT_SKILL=<你的 skill 目录>`。 */
const AUDIT_SKILL_DIR = process.env.VA_AUDIT_SKILL
  || '';
const HAS_AUDIT_SKILL = fs.existsSync(AUDIT_SKILL_DIR);

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
function parseArgv(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) { o[k] = true; continue; }
    o[k] = next;
    i++;
  }
  return o;
}

function die(msg) {
  console.error('\n[new_project] ✗ ' + msg + '\n');
  process.exit(1);
}

/** 落盘尺寸，**真字节数**。
 *  ★ 别用 `String.length` 冒充字节数：它数的是 UTF-16 码元 —— 中文一个字算 1，
 *    而它在 UTF-8 文件里占 3 字节。`fx_demo.html` 实测 `length` 48892 / `byteLength` 58854，
 *    差了整整 9962 字节（2026-10-09 撞出来：README 抄着「48892 字节」印了很久）。
 *    凡是在文案里写「字节」的地方，都必须用这个函数。 */
function sizeLabel(s) { return `${Buffer.byteLength(s, 'utf8')} 字节`; }

// ---------------------------------------------------------------------------
// 分镜表校验
// ---------------------------------------------------------------------------
const SHOT_REQUIRED = ['shot', 'asr', 'narration', 'voice_kw', 'subject', 'layers', 'enter', 'exit', 'safe'];
/** 六个"不许留空"的运镜/验收字段（storyboard_template.md 铁律） */
const SHOT_CAM_REQUIRED = ['cam', 'cam_amp', 'cam_ease', 'camkeys', 'depth', 'accept'];

const VALID_CAM = ['creep', 'pan', 'punchIn', 'rackFocus', 'dollyIn', 'whipPan', 'parallax', 'tilt'];

function validate(spec) {
  const errs = [];
  if (!spec || typeof spec !== 'object') die('spec 不是对象');
  if (!Array.isArray(spec.shots) || !spec.shots.length) die('spec.shots 缺失或为空');

  const dur = Number(spec.dur);
  if (!isFinite(dur) || dur <= 0) errs.push('spec.dur 必须是正数');

  spec.shots.forEach((s, i) => {
    const tag = `shots[${i}]` + (s && s.shot != null ? `(shot ${s.shot})` : '');
    if (!s || typeof s !== 'object') { errs.push(`${tag} 不是对象`); return; }

    SHOT_REQUIRED.forEach((f) => {
      if (s[f] === undefined || s[f] === null || s[f] === '') errs.push(`${tag}.${f} 缺失`);
    });
    SHOT_CAM_REQUIRED.forEach((f) => {
      if (s[f] === undefined || s[f] === null || s[f] === '') errs.push(`${tag}.${f} 缺失（六个必填运镜字段之一，不许留空）`);
    });

    if (!Array.isArray(s.asr) || s.asr.length !== 2 || !(s.asr[1] > s.asr[0])) {
      errs.push(`${tag}.asr 必须是 [t0,t1] 且 t1>t0`);
    }
    if (VALID_CAM.indexOf(s.cam) < 0) {
      errs.push(`${tag}.cam = "${s.cam}" 不在枚举里：${VALID_CAM.join(' / ')}`);
    }
    if (!Array.isArray(s.camkeys) || s.camkeys.length < 2) {
      errs.push(`${tag}.camkeys 至少 2 个关键帧`);
    } else {
      try { normalizeCamkeys(s.camkeys, i); }
      catch (e) { errs.push(`${tag}.camkeys 解析失败：${e.message}`); }
    }
    if (s.safe !== 'action' && s.safe !== 'title') {
      errs.push(`${tag}.safe 必须是 action 或 title（当前 "${s.safe}"）`);
    }
  });

  if (errs.length) die('分镜表校验不通过：\n  - ' + errs.join('\n  - '));
}

/**
 * camkeys 归一化 → [{t,x,y,z,rot,cx,cy}]（x/y 为主，cx/cy 是 fx-runtime.camAt 兼容别名）
 * 支持四种写法：
 *   [0, 1.0]                     短式（storyboard_template.md 同款）→ x/y 取画面中心
 *   [0, 960, 540, 1.0]           数组式 [t,x,y,z]
 *   [0, 960, 540, 1.0, -2]       数组全式 [t,x,y,z,rot]
 *   {t:0, x:960, y:540, z:1}     对象式（推荐，可写 x/y 才是真运镜；cx/cy 也认）
 */
function normalizeCamkeys(keys, shotIdx) {
  const cx0 = 960, cy0 = 540;
  const out = keys.map((k, i) => {
    if (Array.isArray(k)) {
      if (k.length === 2) return { t: +k[0], x: cx0, y: cy0, z: +k[1], rot: 0 };
      if (k.length === 4) return { t: +k[0], x: +k[1], y: +k[2], z: +k[3], rot: 0 };
      if (k.length === 5) return { t: +k[0], x: +k[1], y: +k[2], z: +k[3], rot: +k[4] };
      throw new Error(`第 ${i} 项是 ${k.length} 元数组（只支持 [t,z] / [t,x,y,z] / [t,x,y,z,rot]）`);
    }
    if (k && typeof k === 'object') {
      const t = Number(k.t);
      if (!isFinite(t)) throw new Error(`第 ${i} 项缺 t`);
      return {
        t,
        x: +(k.x != null ? k.x : (k.cx != null ? k.cx : cx0)),
        y: +(k.y != null ? k.y : (k.cy != null ? k.cy : cy0)),
        z: k.z != null ? +k.z : 1,
        rot: k.rot != null ? +k.rot : 0,
      };
    }
    throw new Error(`第 ${i} 项类型不支持：${typeof k}`);
  });
  for (const k of out) {
    if ([k.t, k.x, k.y, k.z, k.rot].some((v) => !isFinite(v))) {
      throw new Error('存在非数值字段（shot ' + shotIdx + '）');
    }
    if (k.z <= 0) throw new Error('z 必须 > 0（shot ' + shotIdx + '）');
  }
  return out;
}

// ---------------------------------------------------------------------------
// 构造 PHASES / CAMKEYS
// ---------------------------------------------------------------------------
function buildPhases(spec) {
  return spec.shots.map((s) => ({
    id: 'S' + s.shot,
    shot: s.shot,
    t0: +Number(s.asr[0]).toFixed(3),
    t1: +Number(s.asr[1]).toFixed(3),
    narration: s.narration,
    voice_kw: s.voice_kw,
    subject: s.subject,
    layers: s.layers,
    enter: s.enter,
    exit: s.exit,
    cam: s.cam,
    cam_amp: s.cam_amp,
    cam_ease: s.cam_ease,
    depth: s.depth,
    safe: s.safe,
    accept: s.accept,
  }));
}

function buildCamkeys(spec) {
  const all = [];
  spec.shots.forEach((s, i) => {
    all.push(...normalizeCamkeys(s.camkeys, i));
  });
  all.sort((a, b) => a.t - b.t);
  const keys = [];
  for (const k of all.map((k) => ({
    t: +k.t.toFixed(3), x: +k.x.toFixed(1), y: +k.y.toFixed(1),
    z: +k.z.toFixed(4), rot: +k.rot.toFixed(3),
    cx: +k.x.toFixed(1), cy: +k.y.toFixed(1),   // fx-runtime.camAt 的兼容别名
  }))) {
    // 相邻镜头首尾常写同一个关键帧，去重（t 相同但值不同的留着 = 有意的硬切）
    const p = keys[keys.length - 1];
    if (p && p.t === k.t && p.x === k.x && p.y === k.y && p.z === k.z && p.rot === k.rot) continue;
    keys.push(k);
  }
  /* ★★★ 2026-10-01：「落版全景兜底」已删（铁律 331）。
   *   原逻辑 —— 末尾没有收到中心的帧时补一个 `{t:dur, x:960, y:540, z:1}` ——
   *   会**自动给每条片子加一段拉回全景居中的落版运镜**。老板原话：
   *   「管线内的最后一秒设置是不是自己自动加了什么定版 … 我不需要这个，
   *     你直接就是动画做到最后一秒就直接延长就行了」。
   *   现在：相机的最后一帧由分镜表**显式**写；没写到 dur 就让它保持末值
   *   （样条外插 = 常数，不会瞬移）。尾段要的是「最后一个动作演到片尾」，
   *   不是自动补一个收尾镜头。 */
  return keys;
}

// ---------------------------------------------------------------------------
// 每镜的 TODO 填充区
// ---------------------------------------------------------------------------
function commentSafe(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').replace(/\*\//g, '*\\/').trim();
}

function buildShotDrive(phases) {
  const chunks = [];
  phases.forEach((p, i) => {
    const L = [];
    L.push('  /* =========================================================================');
    L.push(`     Shot ${p.shot} · ${p.id} · [${p.t0.toFixed(2)}s - ${p.t1.toFixed(2)}s]`);
    L.push(`     narration : ${commentSafe(p.narration)}`);
    L.push(`     voice_kw  : ${commentSafe(p.voice_kw)}`);
    L.push(`     subject   : ${commentSafe(p.subject)}`);
    L.push(`     layers    : ${(p.layers || []).join(', ')}      enter=${p.enter}  exit=${p.exit}`);
    L.push(`     cam       : ${p.cam}   amp=${p.cam_amp}   ease=${p.cam_ease}   depth=${p.depth}   safe=${p.safe}`);
    L.push(`     accept    : ${commentSafe(p.accept)}`);
    L.push('     -------------------------------------------------------------------------');
    L.push(`     TODO ▶ 入场锚 = asr[0] = ${p.t0.toFixed(2)}s（ASR 词轴，不是段边界均分）`);
    L.push('             主体建在 #fg（前景 100%），次要/装饰建在 #mg（中景 60%）');
    L.push(`             常用（FX 元素优先，入场锚一律 ${p.t0.toFixed(2)}）：`);
    L.push(`               FX.fadeInOut(el, t, ${p.t0.toFixed(2)}, ${(p.t1 - 0.34).toFixed(2)}, 0.34, 0.34)  入→驻→退一条龙`);
    L.push(`               FX.fade(el, t, ${p.t0.toFixed(2)}, 0.5)                     只淡入+上移`);
    L.push(`               FX.fadeOut(el, t, ${(p.t1 - 0.34).toFixed(2)}, 0.34)                    只淡出+上移`);
    L.push(`               FX.pop(el, t, ${p.t0.toFixed(2)}, x, y, 'up')               弹入（eob 过冲）`);
    L.push(`               FX.typeOn(el, '文字', FX.c1(t, ${p.t0.toFixed(2)}, 1.2))    打字机`);
    L.push(`               自拼系数：k = FX.env(t, ${p.t0.toFixed(2)}, ${(p.t1 - 0.34).toFixed(2)}, 0.34, 0.34)  （⚠ tIn+dIn ≤ tOut）`);
    L.push('             守框的元素加 data-safe="1"（③ 自检会扫）');
    L.push('             填完删掉下面这行 driveShotPlaceholder(i, t) 和 .shot-ph 样式');
    L.push('     ========================================================================= */');
    L.push(`  driveShotPlaceholder(${i}, t);`);
    chunks.push(L.join('\n'));
  });
  return chunks.join('\n\n');
}

// ---------------------------------------------------------------------------
// 3D 模式：在 Node 里预跑摄影机模块，把「运镜配方」展开成 TRACK 关键帧
//
// 为什么预算而不是运行时算：
//   · 运行时零依赖，__frame(t) 只做 sample + apply，渲染快且完全确定性；
//   · 配方出错在生成阶段就 die，不会到渲染 800 帧才发现。
// ---------------------------------------------------------------------------

/** 在 vm 沙箱里加载 camera3d / camera-lens / camera-shots（它们都是 IIFE 挂 window） */
function loadCamModules() {
  const vm = require('vm');
  const win = {};
  const sandbox = {
    window: win, Math: Math, Object: Object, Array: Array, JSON: JSON, console: console,
    isFinite: isFinite, parseFloat: parseFloat, parseInt: parseInt, Error: Error
  };
  vm.createContext(sandbox);
  ['camera3d.js', 'camera-lens.js', 'camera-shots.js'].forEach((f) => {
    const p = path.join(KIT, f);
    if (!fs.existsSync(p)) die('3D 模式缺少模块：' + p);
    vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: f });
  });
  if (!win.CAM3D || !win.CAMSHOTS) die('摄影机模块加载失败（CAM3D / CAMSHOTS 未挂上 window）');
  return { CAM3D: win.CAM3D, CAMLENS: win.CAMLENS, CAMSHOTS: win.CAMSHOTS };
}

/** 3D 分镜表校验（与 2D 模式的六个运镜字段不通用） */
function validate3d(spec) {
  const errs = [];
  const layers = spec.layers || [];
  if (!Array.isArray(layers) || !layers.length) errs.push('spec.layers 缺失或为空（3D 模式至少要有地板 / 背板做参照系）');
  const ids = [];
  layers.forEach((l, i) => {
    if (!l.id) errs.push(`layers[${i}].id 缺失`);
    else if (ids.indexOf(l.id) >= 0) errs.push(`layers[${i}].id = "${l.id}" 重复`);
    else ids.push(l.id);
  });

  (spec.shots || []).forEach((s, i) => {
    const tag = `shots[${i}]` + (s && s.shot != null ? `(shot ${s.shot})` : '');
    if (!s || typeof s !== 'object') { errs.push(`${tag} 不是对象`); return; }
    if (s.t0 == null || s.t1 == null) errs.push(`${tag}.t0 / t1 缺失（3D 模式用 t0/t1，不用 asr）`);
    if (!Array.isArray(s.cam3d) || !s.cam3d.length) {
      errs.push(`${tag}.cam3d 缺失（3D 模式必填，至少 1 个运镜步骤）`);
      return;
    }
    s.cam3d.forEach((st, j) => {
      if (!st || !st.type) { errs.push(`${tag}.cam3d[${j}].type 缺失`); return; }
      ['subject', 'look', 'from', 'to'].forEach((key) => {
        const v = st[key];
        if (typeof v === 'string' && ids.indexOf(v) < 0) errs.push(`${tag}.cam3d[${j}].${key} = "${v}" 不在 layers 里`);
      });
    });
  });

  const dur = Number(spec.dur);
  if (!isFinite(dur) || dur <= 0) errs.push('spec.dur 必须是正数');
  if (errs.length) die('3D 分镜表校验不通过：\n  - ' + errs.join('\n  - '));
}

/** 可用的运镜步骤（place 是生成器自带的「摆机位」伪配方） */
const CAM3D_STEPS = ['place', 'approach', 'dolly', 'orbit', 'crane', 'dollyZoom', 'parallax',
                     'dutchTilt', 'push', 'pull', 'rackFocus', 'flyTo', 'level', 'snapZoom'];

function resolvePOI(v, pos, cur) {
  if (v == null) return { x: cur.px, y: cur.py, z: cur.pz };
  if (typeof v === 'string') {
    const p = pos[v];
    if (!p) die(`找不到主体 "${v}"（spec.layers 里没有这个 id）`);
    return { x: p.x, y: p.y, z: p.z };
  }
  return { x: v.x || 0, y: v.y || 0, z: v.z || 0 };
}

/**
 * 把 spec.shots[].cam3d 的配方序列展开成一条完整 TRACK。
 * 游标 cur 在镜与镜之间连续传递 —— 所以相邻镜天然接得上（一镜到底的前提）。
 */
function buildCamTrack(spec, MOD) {
  const CAM3D = MOD.CAM3D, CAMSHOTS = MOD.CAMSHOTS, CAMLENS = MOD.CAMLENS;

  const pos = {};
  (spec.layers || []).forEach((l) => { pos[l.id] = { x: l.x || 0, y: l.y || 0, z: l.z || 0 }; });

  const LENS = CAMLENS.LENSES[spec.lens] || CAMLENS.LENSES['35-street'];
  const baseZoom = CAM3D.focalToZoom(LENS.focal, spec.width || 1920, spec.filmW || 36);

  let cur = Object.assign(
    { px: 0, py: 0, pz: 0, roll: 0, focus: 1500 },
    { x: 0, y: 0, z: Math.round(baseZoom * 0.85), zoom: Math.round(baseZoom) },
    spec.cam0 || {}
  );

  const kfs = [];
  (spec.shots || []).forEach((s, i) => {
    let t = Number(s.t0);
    (s.cam3d || []).forEach((st) => {
      const type = st.type;

      // --- place：直接摆机位（无运动过程，瞬移或原地取景） ---
      if (type === 'place') {
        const at = st.at || {};
        const look = resolvePOI(st.look != null ? st.look : st.poi, pos, cur);
        const k = {
          t: t,
          x: at.x != null ? at.x : cur.x, y: at.y != null ? at.y : cur.y, z: at.z != null ? at.z : cur.z,
          px: look.x, py: look.y, pz: look.z,
          zoom: st.zoom || cur.zoom, roll: st.roll != null ? st.roll : cur.roll,
          focus: st.focus || cur.focus, ease: st.ease || 'eio'
        };
        kfs.push(k);
        cur = { x: k.x, y: k.y, z: k.z, px: k.px, py: k.py, pz: k.pz, zoom: k.zoom, roll: k.roll, focus: k.focus };
        if (st.hold) { t += st.hold; kfs.push(Object.assign({}, cur, { t: t, ease: 'lin' })); }
        return;
      }

      if (CAM3D_STEPS.indexOf(type) < 0) {
        die(`未知运镜配方 "${type}"（可选：${CAM3D_STEPS.join(' / ')}）`);
      }

      const o = Object.assign({}, st);
      delete o.type;
      ['subject', 'from', 'to', 'look'].forEach((key) => {
        if (typeof o[key] === 'string') o[key] = pos[o[key]] || o[key];
      });

      // flyTo 的 to 需要完整机位（含 POI），单独规范化
      if (type === 'flyTo') {
        const p = resolvePOI(o.to, pos, cur);
        const look = resolvePOI(o.look != null ? o.look : o.poi, pos, cur);
        o.to = { x: p.x, y: p.y, z: p.z, px: look.x, py: look.y, pz: look.z,
                 zoom: o.zoom, roll: o.roll, focus: o.focus };
      }

      o.fromCam = cur;
      o.currentT = t;
      const built = CAMSHOTS[type](o);
      const out = (built && built.kfs) ? built.kfs : built;
      if (!Array.isArray(out) || !out.length) die(`配方 ${type} 返回空关键帧`);
      out.forEach((k) => kfs.push(k));

      const last = out[out.length - 1];
      cur = { x: last.x, y: last.y, z: last.z, px: last.px, py: last.py, pz: last.pz,
              zoom: last.zoom, roll: last.roll, focus: last.focus };
      t = last.t;
    });
  });

  // --- 归一化：排序 → 数值收敛 → 去重 → 首尾补齐到 [0, dur] ---
  const dur = Number(spec.dur);
  kfs.sort((a, b) => a.t - b.t);

  // 【BUG-2008 守卫】dutchTilt 不会自己回正，忘写 level 会让 roll 一路带到片尾
  const shots = spec.shots || [];
  for (let i = 0; i < shots.length; i++) {
    const seq = shots[i].cam3d || [];
    for (let j = 0; j < seq.length; j++) {
      if (seq[j].type !== 'dutchTilt') continue;
      const rest = seq.slice(j + 1);
      const hasLevel = rest.some((s) => s.type === 'level' || (s.roll != null));
      if (!hasLevel) {
        die(`第 ${i + 1} 段（${shots[i].caption || ''}）用了 dutchTilt 但没有 level 归零 —— `
          + `roll 会一路歪到片尾（BUG-2008）。在该配方后加 {"type":"level","dur":0.5}`);
      }
    }
  }

  const out = [];
  for (const k of kfs) {
    const r = {
      t: +Number(k.t).toFixed(3),
      x: +Number(k.x).toFixed(1), y: +Number(k.y).toFixed(1), z: +Number(k.z).toFixed(1),
      px: +Number(k.px).toFixed(1), py: +Number(k.py).toFixed(1), pz: +Number(k.pz).toFixed(1),
      zoom: +Number(k.zoom).toFixed(1), roll: +Number(k.roll).toFixed(3),
      focus: +Number(k.focus || 1500).toFixed(1),
      ease: k.ease || 'eio'
    };
    for (const f of ['t', 'x', 'y', 'z', 'px', 'py', 'pz', 'zoom', 'roll', 'focus']) {
      if (!isFinite(r[f])) die(`CAMTRACK 出现非数值（${f} = ${k[f]}），检查配方 ${JSON.stringify(k)}`);
    }
    const p = out[out.length - 1];
    if (p && p.t === r.t && p.x === r.x && p.y === r.y && p.z === r.z && p.px === r.px && p.py === r.py && p.pz === r.pz && p.zoom === r.zoom && p.roll === r.roll) {
      /* ★ 同 t 同位置：**留后一条**，不是丢掉后一条。
       *   后一条是「接手那一段」的首帧，它的 `ease` 管的是**接下去这一段**；
       *   前一条只是上一段的收尾帧，它的 ease 已经是过去时。
       *   原来这里是 `continue`（丢后一条）⇒ 下一段一直在听上一步的**收尾**缓动，
       *   静默、无报错。rv1106-seg1 实测：approach 收在 5.35（收尾 eo）与 orbit 首帧（ei）同位同 t，
       *   丢掉 orbit 的 `ei` 后环绕从"猛启动"起步，J9 在 6.4 量到接缝速度 0 → 1015（失配）。
       *   位置/光学完全一致，所以"谁留下"只影响缓动归属，不影响画面几何。 */
      out[out.length - 1] = r;
      continue;
    }
    out.push(r);
  }
  if (!out.length) die('CAMTRACK 展开后为空');
  if (out[0].t > 0.001) out.unshift(Object.assign({}, out[0], { t: 0 }));
  const last = out[out.length - 1];
  if (last.t < dur - 0.01) out.push(Object.assign({}, last, { t: +dur.toFixed(3), ease: 'lin' }));
  return out;
}

/** 3D 图层：算 tIn/tOut + 生成 DOM 片段 */
function buildLayers3d(spec) {
  const dur = Number(spec.dur);
  const shotBy = {};
  (spec.shots || []).forEach((s) => {
    shotBy[s.shot] = { t0: Number(s.t0), t1: Number(s.t1), caption: s.caption || s.narration || '' };
  });

  const layers = [], html = [];
  (spec.layers || []).forEach((l) => {
    const st = l.shot != null ? shotBy[l.shot] : null;
    const tIn = l.fixed ? 0 : (st ? st.t0 + (l.in || 0) : 0);
    const tOut = l.fixed ? dur : (st ? st.t1 + (l.out || 0) : dur);
    layers.push({
      id: l.id, x: l.x || 0, y: l.y || 0, z: l.z || 0,
      rx: l.rx || 0, ry: l.ry || 0, rz: l.rz || 0,
      tIn: +Number(tIn).toFixed(3), tOut: +Number(tOut).toFixed(3),
      dIn: l.dIn, dOut: l.dOut, op: l.op, rise: l.rise, popZ: l.popZ,
      /* ★ 元素级动效：pop=入场overshoot / breathe=呼吸 / drift=漂移 / sway=微摆 / stagger=子元素错峰 */
      pop: l.pop, breathe: l.breathe, breathHz: l.breathHz,
      drift: l.drift, driftHz: l.driftHz, sway: l.sway, swayHz: l.swayHz,
      stagger: l.stagger, staggerGap: l.staggerGap, staggerRise: l.staggerRise,
      fixed: !!l.fixed, follow: !!l.follow, noDof: !!l.noDof
    });

    const w = l.w || 900, h = l.h || 520;
    let inner = l.html;
    if (!inner) {
      const cap = (st && st.caption) ? st.caption : (l.text || l.id);
      inner =
        '<div class="ph-card" style="width:100%;height:100%">' +
          '<div class="ph-no">SHOT ' + (l.shot == null ? '—' : l.shot) + ' · ' + l.id + '</div>' +
          '<div class="ph-tx">' + String(cap).replace(/</g, '&lt;') + '</div>' +
        '</div>';
    }
    html.push(
      '          <div class="layer" id="layer-' + l.id + '">\n' +
      '            <div class="card" style="width:' + w + 'px;height:' + h + 'px">' + inner + '</div>\n' +
      '          </div>');
  });
  return { layers, html: html.join('\n') };
}

/** 3D 模式的每镜 TODO 区 */
function buildShotDrive3d(spec) {
  const chunks = [];
  (spec.shots || []).forEach((s, i) => {
    const L = [];
    L.push('  /* =========================================================================');
    L.push(`     Shot ${s.shot} · [${Number(s.t0).toFixed(2)}s - ${Number(s.t1).toFixed(2)}s]   主体 ${s.subject || '—'}`);
    L.push(`     caption : ${commentSafe(s.caption || s.narration)}`);
    L.push(`     cam3d   : ${(s.cam3d || []).map((st) => st.type).join(' → ')}`);
    L.push('     -------------------------------------------------------------------------');
    L.push('     TODO ▶ 图层显隐已由 driveLayers(t) 自动接管（按 layer.shot 的 t0/t1）');
    L.push('             这里只写「卡内动画」：');
    L.push(`               const k = FX.env(t, ${Number(s.t0).toFixed(2)}, ${Number(s.t1).toFixed(2)}, 0.34, 0.30);`);
    L.push(`               FX.typeOn(el, '文字', FX.c1(t, ${Number(s.t0).toFixed(2)}, 1.0))`);
    L.push('             守框的元素加 data-safe="1"；卡内子元素随便用 opacity，.layer 上不行');
    L.push('     ========================================================================= */');
    chunks.push(L.join('\n'));
  });
  return chunks.join('\n\n');
}

// ---------------------------------------------------------------------------
// 载入运行时 / 组件样式（优先 kit 正式版，缺失则回退模板内的等价实现）
// ---------------------------------------------------------------------------
function loadRuntime() {
  const real = path.join(KIT, 'fx-runtime.js');
  const pick = (s) => s.replace(/<\/script>/gi, '<\\/script>');   // 防字面 </script> 截断 HTML
  if (fs.existsSync(real)) {
    let s = fs.readFileSync(real, 'utf8');
    s = s.replace(/^\s*(?:import|export)\s.*$/gm, '');   // 万一写成 ESM，粗暴降级
    return { src: pick(s), from: 'kit/fx-runtime.js', fallback: false };
  }
  const fb = path.join(TPL_DIR, 'fx-runtime.fallback.js');
  if (!fs.existsSync(fb)) die('找不到运行时：kit/fx-runtime.js 与 templates/fx-runtime.fallback.js 都不存在');
  return { src: pick(fs.readFileSync(fb, 'utf8')), from: 'templates/fx-runtime.fallback.js（TODO：正式版落盘后重跑生成器）', fallback: true };
}

function loadComponents() {
  const real = path.join(KIT, 'fx-components.css');
  if (fs.existsSync(real)) {
    return { src: fs.readFileSync(real, 'utf8'), from: 'kit/fx-components.css', fallback: false };
  }
  const fb = path.join(TPL_DIR, 'fx-components.fallback.css');
  if (!fs.existsSync(fb)) return { src: '/* 无组件样式 */', from: '（无）', fallback: true };
  return { src: fs.readFileSync(fb, 'utf8'), from: 'templates/fx-components.fallback.css（TODO：正式版落盘后重跑生成器）', fallback: true };
}

// ---------------------------------------------------------------------------
// 模板渲染
// ---------------------------------------------------------------------------
function render(tpl, map) {
  let s = tpl;
  for (const k of Object.keys(map)) s = s.split('{{' + k + '}}').join(map[k]);
  const left = s.match(/\{\{[A-Z_]+\}\}/g);
  if (left) die('模板还有未替换的占位符：' + left.join(', '));
  return s;
}

function j(v, indent) {
  return JSON.stringify(v, null, indent == null ? 2 : indent);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function main() {
  const a = parseArgv(process.argv.slice(2));
  if (!a.spec) {
    console.error('用法: node new_project.js --spec <分镜表.json> [--out <工程目录>] [--force]');
    process.exit(1);
  }

  const specPath = path.resolve(String(a.spec));
  if (!fs.existsSync(specPath)) die(`分镜表不存在：${specPath}`);
  let spec;
  try { spec = JSON.parse(fs.readFileSync(specPath, 'utf8')); }
  catch (e) { die(`分镜表 JSON 解析失败：${e.message}`); }

  // 3D 摄影机模式：spec.mode = "3d"（或命令行 --mode 3d）
  const mode = String(spec.mode || a.mode || (a['3d'] ? '3d' : '2d')).toLowerCase();
  if (mode === '3d' || mode === 'camera3d') { main3d(spec, specPath, a); return; }

  validate(spec);

  const name = spec.name || path.basename(specPath, '.json');
  const outDir = path.resolve(String(a.out || path.join(path.dirname(specPath), name)));
  const force = !!a.force;

  const w = spec.width || 1920;
  const h = spec.height || 1080;
  const fps = spec.fps || 30;
  const dur = Number(spec.dur);
  const safe = spec.safe || { x0: 52, y0: 70, x1: 1872, y1: 1008 };

  const phases = buildPhases(spec);
  const camkeys = buildCamkeys(spec);
  const rt = loadRuntime();
  const cs = loadComponents();

  const cfg = {
    name, w, h, fps,
    dur: +dur.toFixed(3),
    bg: spec.bg || 'radial-gradient(120% 90% at 50% 0%, #0d1220 0%, #06080c 55%, #04060a 100%)',
    glow: spec.glow || 'radial-gradient(60% 52% at 50% 28%, rgba(53,224,208,.16) 0%, rgba(0,0,0,0) 72%)',
    safe,
    type: spec.type || { size: 72, color: '#E8F1FF', weight: 700 },
  };

  const tpl = fs.readFileSync(path.join(TPL_DIR, 'skeleton.html'), 'utf8');
  const html = render(tpl, {
    TITLE: spec.title || name,
    PROJECT_NAME: name,
    SCENE_BG: cfg.bg,
    GLOW_BG: cfg.glow,
    SAFE_X0: String(safe.x0), SAFE_Y0: String(safe.y0),
    SAFE_X1: String(safe.x1), SAFE_Y1: String(safe.y1),
    COMPONENT_CSS: cs.src,
    RUNTIME_JS: rt.src,
    CONFIG_JSON: j(cfg),
    PHASES_JSON: j(phases),
    CAMKEYS_JSON: j(camkeys),
    SHOT_DRIVE: buildShotDrive(phases),
  });

  // --- 落盘 ---
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  const htmlName = `fx_${name}.html`;
  files.push([htmlName, html]);
  files.push(['_render.js', renderRenderJs({ outDir, htmlName, cfg, spec })]);
  // ★ 没装那个「回归体检」skill 就**不生成** _audit.js —— 产出物里不留跑不了的脚本
  if (HAS_AUDIT_SKILL) files.push(['_audit.js', renderAuditJs({ outDir, htmlName, cfg })]);

  for (const [fn] of files) {
    const p = path.join(outDir, fn);
    if (fs.existsSync(p) && !force) {
      die(`目标已存在，拒绝覆盖：${p}\n  加 --force 强制覆盖，或换 --out 目录`);
    }
  }
  for (const [fn, content] of files) {
    fs.writeFileSync(path.join(outDir, fn), content, 'utf8');
  }

  console.log('\n[new_project] ✓ 生成完成');
  console.log(`  分镜表 : ${specPath}`);
  console.log(`  工程目录: ${outDir}`);
  files.forEach(([fn, c]) => console.log(`    · ${fn}  (${sizeLabel(c)})`));
  console.log(`  镜头数  : ${phases.length}   时长: ${cfg.dur}s @ ${fps}fps   ${w}x${h}`);
  console.log(`  运行时  : ${rt.from}`);
  console.log(`  组件样式: ${cs.from}`);
  if (rt.fallback || cs.fallback) {
    console.log('  ⚠ 用了 fallback 实现，正式版落盘后请重跑一次本生成器');
  }
  console.log('\n下一步：');
  console.log(`  1. 打开 ${htmlName}，按每个 Shot 的 TODO 填充元素（入场锚 = asr[0]）`);
  console.log('  2. node _render.js      渲 mp4');
  if (HAS_AUDIT_SKILL) {
    console.log('  3. node _audit.js       回归体检（对比度 / 安全框 / CSS 动画残留）\n');
  } else {
    console.log('  3. 回归体检：用 node kit/trial.js（在仓库根目录跑，8 条 P0 红线）');
    console.log('     —— 没生成 _audit.js：它依赖的体检工具不随本仓库分发\n');
  }
}

// ---------------------------------------------------------------------------
// 3D 模式主流程
// ---------------------------------------------------------------------------
function main3d(spec, specPath, a) {
  validate3d(spec);

  const name = spec.name || path.basename(specPath, '.json');
  const outDir = path.resolve(String(a.out || path.join(path.dirname(specPath), name)));
  const force = !!a.force;

  const w = spec.width || 1920, h = spec.height || 1080, fps = spec.fps || 30;
  const dur = Number(spec.dur);
  const safe = spec.safe || { x0: 52, y0: 70, x1: 1872, y1: 1008 };

  const MOD = loadCamModules();
  const camtrack = buildCamTrack(spec, MOD);
  const built = buildLayers3d(spec);
  const rt = loadRuntime();
  const cs = loadComponents();

  const pick = (s) => s.replace(/<\/script>/gi, '<\\/script>');   // 防字面 </script> 截断 HTML
  const read = (f) => pick(fs.readFileSync(path.join(KIT, f), 'utf8'));

  const cfg = {
    name, w, h, fps,
    dur: +dur.toFixed(3),
    lens: spec.lens || '35-street',
    film: spec.film || 'digital-clean',
    filmStrength: spec.filmStrength == null ? 1 : spec.filmStrength,
    filmW: spec.filmW || 36,
    /* ★ `lensVignette:false` → skeleton 不建 `.lens-vignette` 层（跨段统一用，见 skeleton3d.html 注释）。
       ⚠️ 这个字段**必须列进这份白名单**才算真生效：cfg 是显式挑字段的，没列进来的 spec 字段
         会被静默丢掉（踩过：spec 写了 `lensVignette:false`、skeleton 代码也改了，但页面里
         `CFG.lensVignette` 是 undefined → `undefined !== false` 成立 → 层照样建，
         而 `_build.py` 只查 spec 文件与 skeleton 字符串，于是**报 PASS**）。 */
    lensVignette: spec.lensVignette !== false,
    aperture: spec.aperture || null,
    maxBlur: spec.maxBlur || null,
    dof: spec.dof !== false,
    shake: spec.shake || null,
    safe,
    type: spec.type || { size: 72, color: '#E8F1FF', weight: 700 },
  };

  const tplPath = path.join(TPL_DIR, 'skeleton3d.html');
  if (!fs.existsSync(tplPath)) die('找不到 3D 骨架模板：' + tplPath);

  /* ★★ 契约守卫：`spec.glow` 必须是**色标列表**，不是完整 gradient。
     模板里写的是 `background: radial-gradient(58% 52% at 50% 50%, {{GLOW_BG}});`
     —— 它只等色标。若传一整个 gradient 进去 → **嵌套 gradient** → 声明非法 →
     浏览器**静默丢弃**（不报错、无 console、`elementsFromPoint` 里那一层照样在）
     → 生成一个"看着在、其实从没画过任何像素"的死层。
     实测踩过：seg9 的 `.g-pool`（3000×1800）从头到尾是空的，`grep g-pool` 到处搜得到，
     只有逐点问浏览器「这一点上是哪些元素、各自什么背景」才看得出来。
     → 宁可生成时**硬失败**，也不要一个静默空层（静默假成功是最大敌人）。 */
  const glowVal = spec.glow || 'rgba(70,150,255,.18) 0%, rgba(0,0,0,0) 70%';
  if (/gradient\s*\(/i.test(glowVal)) {
    die('spec.glow 只能写色标列表（例：rgba(228,179,136,.13) 0%, rgba(0,0,0,0) 72%），'
      + '不能是完整 gradient。\n'
      + '  原因：它会被套进模板的 radial-gradient(58% 52% at 50% 50%, <glow>) 里 → 嵌套 → '
      + '整条声明非法 → 浏览器静默丢弃 → 那一层变死层（无任何报错）。\n'
      + '  当前值：' + glowVal);
  }

  const html = render(fs.readFileSync(tplPath, 'utf8'), {
    TITLE: spec.title || name + ' · 3D',
    PROJECT_NAME: name,
    SCENE_BG: spec.bg || 'radial-gradient(130% 100% at 50% 8%, #101a33 0%, #070b16 52%, #03050a 100%)',
    GLOW_BG: glowVal,
    SAFE_X0: String(safe.x0), SAFE_Y0: String(safe.y0),
    SAFE_X1: String(safe.x1), SAFE_Y1: String(safe.y1),
    COMPONENT_CSS: cs.src,
    CAMERA3D_JS: read('camera3d.js'),
    CAMERA_LENS_JS: read('camera-lens.js'),
    CAMERA_SHOTS_JS: read('camera-shots.js'),
    RUNTIME_JS: rt.src,
    CONFIG_JSON: j(cfg),
    LAYERS_JSON: j(built.layers),
    CAMTRACK_JSON: j(camtrack),
    LAYERS_HTML: built.html,
    SHOT_DRIVE: buildShotDrive3d(spec),
  });

  fs.mkdirSync(outDir, { recursive: true });
  const htmlName = `fx_${name}.html`;
  const files = [
    [htmlName, html],
    ['_render.js', renderRenderJs({ outDir, htmlName, cfg, spec })],
    ['_shot.js', renderShotJs({ htmlName, dur, fps, cfg })],
  ];
  // ★ 同 2D：没有那个 skill 就不生成 _audit.js
  if (HAS_AUDIT_SKILL) files.splice(2, 0, ['_audit.js', renderAuditJs({ outDir, htmlName, cfg })]);
  for (const [fn] of files) {
    const p = path.join(outDir, fn);
    if (fs.existsSync(p) && !force) die(`目标已存在，拒绝覆盖：${p}\n  加 --force 强制覆盖，或换 --out 目录`);
  }
  for (const [fn, content] of files) fs.writeFileSync(path.join(outDir, fn), content, 'utf8');

  const LENS = MOD.CAMLENS.LENSES[cfg.lens] || MOD.CAMLENS.LENSES['35-street'];
  console.log('\n[new_project] ✓ 3D 工程生成完成');
  console.log(`  分镜表 : ${specPath}`);
  console.log(`  工程目录: ${outDir}`);
  files.forEach(([fn, c]) => console.log(`    · ${fn}  (${sizeLabel(c)})`));
  console.log(`  镜头数  : ${(spec.shots || []).length}   图层: ${built.layers.length}   时长: ${cfg.dur}s @ ${fps}fps   ${w}x${h}`);
  console.log(`  镜头    : ${LENS.name}  ${LENS.focal}mm  F${LENS.fstop}  →  zoom ${Math.round(camtrack[0].zoom)}px`);
  console.log(`  胶片    : ${cfg.film}  (强度 ${cfg.filmStrength})   景深: ${cfg.dof ? '开' : '关'}`);
  console.log(`  摄影机轨: ${camtrack.length} 个关键帧，t 0 → ${camtrack[camtrack.length - 1].t}s`);
  console.log('\n下一步：');
  console.log(`  1. 打开 ${htmlName}，按每个 Shot 的 TODO 填卡内动画`);
  console.log('  2. node _render.js      渲 mp4');
  if (HAS_AUDIT_SKILL) {
    console.log('  3. node _audit.js       回归体检\n');
  } else {
    console.log('  3. 回归体检：用 node kit/trial.js（在仓库根目录跑，8 条 P0 红线）');
    console.log('     —— 没生成 _audit.js：它依赖的体检工具不随本仓库分发\n');
  }
}

// ---------------------------------------------------------------------------
// _shot.js —— 截帧审判脚本（用 puppeteer-core + 系统 Chrome）
// ---------------------------------------------------------------------------
function renderShotJs({ htmlName, dur, fps, cfg }) {
  return `/* ${cfg.name} · 3D 截帧审判
 *
 * ⚠️⚠️ 本文件是 **kit/new_project.js 的模板产物**，每次跑 \`_build.py\` 第①步都会被重写。
 *     改它没用 —— 要改就改 kit/new_project.js 的 renderShotJs()。
 *     （实测踩过：改了生成的 _shot.js 被静默覆盖，还误判成"并发编辑竞态"。）
 *
 * 默认按总时长等距截 12 帧，缩 0.5×（输出 960×540 JPG，Read 能肉眼判）。
 * 用法：
 *   node _shot.js                        默认截 12 帧
 *   node _shot.js 0,1.5,3,7.5,28         自定义时刻
 *   node _shot.js 0,3,6 0.25             截 3 帧 + 0.25 缩放比
 */
const path = require('path');
const fs = require('fs');
/* ★ 2026-10-08 修：原先写死开发机的 node_modules 绝对路径 ⇒ 别人跑这个脚本必崩。
   改成多候选：环境变量 → 开发机兜底（放前面，本机行为一字不变）→ 常规 require
   （别人按 README 第 3 步装完 puppeteer-core 后走最后这条）。 */
const puppeteer = (function () {
  var cands = [process.env.PPTR_PATH,
    'puppeteer-core', 'puppeteer'].filter(Boolean);
  var errs = [];
  for (var i = 0; i < cands.length; i++) {
    try { return require(cands[i]); } catch (e) { errs.push(cands[i] + ': ' + (e.code || e.message)); }
  }
  throw new Error('无法解析 puppeteer-core，已试：\\n  - ' + errs.join('\\n  - ') +
    '\\n请在工程目录 npm i --no-save --no-package-lock puppeteer-core，或设环境变量 PPTR_PATH' +
    '\\n（仓库自带的体检 + 自动安装器：在仓库根跑 node kit/check_env.js --install --yes）');
})();

const HTML = 'file:///' + path.join(__dirname, ${JSON.stringify(htmlName)}).replace(/\\\\/g, '/');
const OUT  = path.join(__dirname, '_shots');
const DUR  = ${dur};
const FPS  = ${fps};
/* ★ 2026-09-15 修：SCALE 原先是死的 ${cfg.scale || 0.5}，**压根没读 argv[3]**，
   而文件头注释却写着「node _shot.js 0,3,6 0.25 → 截 3 帧 + 0.25 缩放比」。
   后果是**静默的**：命令行传了 1、以为拿到 1920×1080，实际还是 960×540；
   下游若按全尺寸坐标去采样像素，采到的是完全不同的位置
   （实测把 (959,40) 采成了半图的右上角，读出「左中/上中差 18 灰阶」的**假 FAIL**）。
   → 真读 argv[3]，并把**实际输出尺寸**打出来，让人一眼对得上。 */
const SCALE = (function () {
  var v = Number(process.argv[3]);
  return isFinite(v) && v > 0 ? v : ${cfg.scale || 0.5};
})();

function pickTimes() {
  const n = 12;
  const arr = [];
  for (let i = 0; i < n; i++) arr.push(+((i + 0.5) * DUR / n).toFixed(2));
  return arr;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new',
    args: ['--no-sandbox', '--force-device-scale-factor=1'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: ${cfg.w}, height: ${cfg.h}, deviceScaleFactor: SCALE });
  page.on('pageerror', (e) => console.error('PAGEERROR:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE:', m.text()); });
  await page.goto(HTML + '?t=0', { waitUntil: 'networkidle0' });

  /* ⚠️⚠️ BUG-2188：本脚本必须**逐字复刻** _render.js 的前置步骤，少一步就量到另一个东西 ——
     ① 带 ?t=0 加载  ② 等 2500ms（等字体/首帧稳定）
     ③ 隐藏开始遮罩 #startOv   ← 少了它整帧都是近黑（实测 98~99.8% 像素近黑），
        连 t=3.33 这种明显不该黑的时刻也报 98.1%，会被误判成"画面全黑"。
     ④ 每次 __frame(t) 后等**两次 rAF**（一次不够，样式可能还没上屏）
     且这几条改的是**画面状态**而不是"截帧参数"，所以只在探针里补是不行的 —— 必须补在源头。 */
  await new Promise((r) => setTimeout(r, 2500));
  await page.evaluate(function () { var s = document.getElementById('startOv'); if (s) s.style.display = 'none'; });

  const info = await page.evaluate(() => window.getInfo ? window.getInfo() : null);
  console.log('getInfo:', JSON.stringify(info));
  console.log('输出尺寸: ' + (${cfg.w} * SCALE) + '×' + (${cfg.h} * SCALE) + '  (缩放比 ' + SCALE + ')');

  /* BUG-2019：空字符串 split(',') → [''] → Number('') === 0 → [0]，长度 1
     导致判空失效 —— 不传参数只会截 t=0 一帧且不报错。
     必须先滤空串再转数字。
     ⚠️ 注释里禁止出现反引号：本段处在外层模板字面量内，反引号会提前闭合模板。 */
  let times = (process.argv[2] || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map(Number)
    .filter((n) => isFinite(n));
  if (!times.length) times = pickTimes();

  for (const t of times) {
    await page.evaluate((tt) => window.__frame(tt), t);
    /* 双 rAF：一次不够 —— __frame 只写 style，浏览器可能还没把它合成上屏，
       截到的是**上一帧**。这是 BUG-2188 的第四步前置。 */
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const cam = await page.evaluate(() => {
      const c = document.getElementById('camera');
      const v = document.getElementById('viewport');
      return { perspective: v.style.perspective, transform: c.style.transform };
    });
    await page.screenshot({ path: path.join(OUT, 't' + t.toFixed(2).replace('.', '_') + '.jpg'), quality: 88, type: 'jpeg' });
    console.log('t=' + t + '  ' + cam.perspective + '  ' + cam.transform);
  }
  const oob = await page.evaluate(() => window.__oob || []);
  if (oob.length) console.log('OOB:', JSON.stringify(oob));
  await browser.close();
  console.log('DONE -> ' + OUT);
})().catch((e) => { console.error(e); process.exit(1); });
`;
}

// ---------------------------------------------------------------------------
// _render.js
// ---------------------------------------------------------------------------
function renderRenderJs({ outDir, htmlName, cfg, spec }) {
  const kitRel = path.relative(outDir, path.join(KIT, 'render-core.js')).replace(/\\/g, '/');
  const voiceLine = spec.voice
    ? `  voice: require('path').join(__dirname, ${JSON.stringify(spec.voice)}),\n`
    : `  // voice: require('path').join(__dirname, 'voice.wav'),   // 配音就绪后解开\n`;
  return `/* ${cfg.name} · 渲染 —— 配置 + 调 render-core */
const path = require('path');
const { renderProject } = require('${kitRel}');

renderProject({
  html: path.join(__dirname, ${JSON.stringify(htmlName)}),
  out: path.join(__dirname, ${JSON.stringify(cfg.name + '.mp4')}),
  fps: ${cfg.fps}, dur: ${cfg.dur}, w: ${cfg.w}, h: ${cfg.h},
${voiceLine}}).then((r) => console.log(r)).catch((e) => { console.error(e); process.exit(1); });
`;
}

// ---------------------------------------------------------------------------
// _audit.js —— voice-axis-regression-audit 体检
// ---------------------------------------------------------------------------
function renderAuditJs({ outDir, htmlName, cfg }) {
  const kitRel = path.relative(outDir, path.join(KIT, 'render-core.js')).replace(/\\/g, '/');
  return `/* ${cfg.name} · 回归体检 —— 调 voice-axis-regression-audit skill
 *
 * 流水线（SKILL.md §4 步）：
 *   1) node  audit_contrast.js   → 6 时刻采样 + report.json（OOB / #note / CSS 动画残留）
 *   2) python contrast_analyze.py → Otsu + WCAG 2.1 对比度分级
 *   3) python shrink.py          → 缩到 880×495 JPG 供 Read 肉眼审判
 *
 * 跑不动时先检查两件事：
 *   - SKILL_DIR 是否存在
 *   - NODE_MODULES 里是否有 puppeteer（不是 puppeteer-core）
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

/* ★ 2026-10-08 修：原先两个路径都写死开发机 ⇒ 别人（没有这个 skill）只能手改源码。
   现在都可用环境变量覆盖，**默认值保持原样，本机行为一字不变**：
     VA_AUDIT_SKILL        → 你自己的回归体检 skill 目录
     VA_AUDIT_NODE_MODULES → 你自己工程里装着 puppeteer 的 node_modules */
const SKILL_DIR = process.env.VA_AUDIT_SKILL || ${JSON.stringify(AUDIT_SKILL_DIR)};
const NODE_MODULES = process.env.VA_AUDIT_NODE_MODULES || ${JSON.stringify('')};
const HTML = ${JSON.stringify(htmlName)};
const DUR = ${cfg.dur};

// render-core 能自己解析 puppeteer-core，用它探测一个可用的 node_modules 兜底
function pickNodeModules() {
  // ★ 2026-10-08：补一个「本工程自己的 node_modules」兜底 —— 别人 npm i puppeteer 后就能命中
  const cands = [NODE_MODULES, path.join(__dirname, 'node_modules')];
  for (const c of cands) if (fs.existsSync(path.join(c, 'puppeteer'))) return c;
  return NODE_MODULES;
}

function run(cmd, args, env) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: Object.assign({}, process.env, env || {}), shell: false });
  if (r.error) { console.error('  ✗ 启动失败:', r.error.message); return false; }
  return r.status === 0;
}

if (!fs.existsSync(SKILL_DIR)) {
  console.log('── 跳过回归体检 ─────────────────────────────────────');
  console.log(' 这个 _audit.js 依赖作者内部的「回归体检」skill（voice-axis-regression-audit），');
  console.log(' 它**不随本仓库分发**，所以这个脚本在这儿跑不了 —— 这是预期行为，不是环境坏了。');
  console.log('');
  console.log(' 本仓自带的替代（在**仓库根目录**跑）：');
  console.log('   node kit/trial.js <你的工程目录>/' + HTML + '   # 总审判器：8 条 P0 红线');
  console.log('   node kit/contrast_check.js                  # 对比度');
  console.log('   node kit/layout_check.js                    # 安全框 / 越界');
  console.log('');
  console.log(' 想接自己的体检工具：VA_AUDIT_SKILL=<你的 skill 目录> 再跑一次。');
  process.exit(0);
}

// audit_contrast.js 用 basename(工程目录) 建报告目录，这里必须保持一致
const outDir = path.join(__dirname, '_audit_legacy', path.basename(__dirname));
console.log('== 1/3 采样 ==');
const ok1 = run(process.execPath,
  [path.join(SKILL_DIR, 'scripts', 'audit_contrast.js'), __dirname, HTML, String(DUR)],
  { NODE_PATH: pickNodeModules() });

let py = null;
for (const p of ['python', 'python3', 'py']) {
  if (run(p, ['--version'])) { py = p; break; }
}
if (!py) {
  console.log('\\n== 2/3 跳过对比度分析（没找到 python，SKILL.md 第 2 步可手动跑）==');
} else {
  console.log('\\n== 2/3 对比度分析 ==');
  run(py, [path.join(SKILL_DIR, 'scripts', 'contrast_analyze.py'), outDir]);
}

if (py) {
  console.log('\\n== 3/3 缩图（880×495 JPG，供 Read 肉眼审判）==');
  if (fs.existsSync(outDir)) {
    for (const f of fs.readdirSync(outDir)) {
      if (!f.endsWith('.png')) continue;
      run(py, [path.join(SKILL_DIR, 'scripts', 'shrink.py'),
               path.join(outDir, f), path.join(outDir, f.replace(/\\.png$/, '.jpg')), '880']);
    }
  }
}

console.log('\\n报告: ' + outDir);
console.log('肉眼审判：用 Read 打开上面的 t*.jpg（缩过图的，不会被过滤）。');
process.exit(ok1 ? 0 : 1);
`;
}

main();
