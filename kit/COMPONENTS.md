# COMPONENTS.md —— 语音转动画管线 · 动效组件库清单

配套文件：
- `fx-runtime.js` —— `window.FX` 运行时（缓动 / 入场原语 / 运镜 / 滚数 / 打字 / 扫光）
- `fx-components.css` —— 组件样式，`/* ===== 组件名 ===== */` 分段，段间零耦合，可按段摘取内联
- `_demo/build.js` → `_demo/components_showcase.html` —— 全组件验收 demo（单文件离线可开）
- 渲染验证：`_smoketest/components_showcase.mp4`（1920×1080 / 30fps / 151 帧）

## 全局硬约束（生成器必须遵守）

1. **禁止 CSS animation / transition / @keyframes**。所有动效由 `window.__frame(t)` 按秒驱动，
   同一 t 必须得到完全一致的状态。源工程里的 transition 抽取时已全部剔除。
2. 产物是可内联的纯 JS/CSS 片段，双击可开的单文件 HTML，零外部依赖。
3. 离散状态用 `classList.toggle(...)`；连续状态用 inline style 或 `setProperty('--x', v)`。

## FX 运行时 API（签名是契约，不许改）

```js
FX.clamp01(v) FX.clamp(v,a,b) FX.lerp(a,b,t)
FX.eo(t)                    // easeOutCubic
FX.eob(t)                   // easeOutBack（萌系弹入，含过冲）
FX.eio(t)                   // easeInOut = smoothstep（镜头插值默认）
FX.c1(t,t0,d)               // 线性窗口 [t0,t0+d] → 0..1
FX.seg(t,t0,d)              // 缓动窗口（c1 过一层 eo）
FX.pop(el,t,t0,x,y,from)    // from ∈ 'left'|'right'|'up'|'down'|'scale'；位移 0.5s eob，透明度 0.18s
FX.fade(el,t,t0,d,dy)       // 淡入+上移，dy 默认 18
FX.env(t,tIn,tOut,dIn,dOut) // 双向窗口包络 0→1→0；tIn+dIn ≤ tOut，重叠时峰值打折
FX.fadeOut(el,t,t0,d,dy)    // 淡出+上移（退场），与 fade 对称
FX.fadeInOut(el,t,tIn,tOut,dIn,dOut,dy) // 入场→驻留→退场一条原语走完；tOut 缺省=只入不出
FX.camAt(CAMKEYS,t)         // CAMKEYS=[[t,x,y,z,rot],...] → {x,y,z,rot,cx,cy}
FX.applyParallax(el,cam,rate)// rate: 前景 1.0 / 中景 0.6 / 背景 0.3
FX.roll(el,value,digits,suffix)
FX.typeOn(el,text,p)        // p ∈ [0,1]
FX.sweep(el,t,t0,dur)       // .glass 扫光驱动（注入 --sweep-bg / --sweep-op）
FX.matchOut(t,o)            // ⚠️ 转场·出画（加速冲出）→ §13；**基于已被实测推翻的"速度对冲"口径，沿用前先读 §13 第四轮复核**
FX.matchIn(t,o)             // ⚠️ 转场·入画（减速冲入）→ 同上；原片 3 个切点里一次都没用到它
```

> 💡 **新增函数前先读这里**：API 是契约，改签名 = 破坏所有在用工程。
> `matchOut` / `matchIn` 是 **2026-09-13 新增**（学习知识库 §17），用法见 §13。
> 🔴 **2026-09-14 第四轮警告**：这对函数的**机理表述**（"速度对冲"）已被 30fps 逐帧实测**推翻**——
> 原片 3 个切点两侧的圆**都是静止的**。函数作为**数学工具**仍可用，但选它前必须回答
> 「**这个片子真的需要一个加速出画的元素吗**」；否则退回 §13 的**三技法表**（技法①②③）重新选。
> 旧口径的判据 `kit/_verify_match.js` **同样待重写**。

### 运镜铁律（真 dolly，不是 zoom）

单纯给画面加 `scale()` 是 zoom：所有东西等比放大，没有纵深线索，出来就是 PPT 味。
真 dolly 必须**多层不同速率**位移+缩放（前景 100% / 中景 60% / 背景 30%），
靠层间相对位移差告诉眼睛"这里有深度"。用法：

```html
<div id="stage">
  <div class="fx-layer" id="L-bg">…</div>      <!-- 背景 rate 0.3 -->
  <div class="fx-layer" id="L-mid">…</div>     <!-- 中景 rate 0.6 -->
  <div class="fx-layer" id="L-content">…</div> <!-- 内容 rate 1.0 -->
</div>
```
```js
var cam = FX.camAt(CAMKEYS, t);
FX.applyParallax($('L-bg'), cam, 0.3);
FX.applyParallax($('L-mid'), cam, 0.6);
FX.applyParallax($('L-content'), cam, 1.0);   // 注意：不要再给父级加 transform，会叠两次
```
`.fx-layer` 必须是 1920×1080 满画面、`transform-origin:0 0`（CSS 段已内置）。

---

## 组件清单

| # | 组件 | CSS 段 | 驱动方式 | 来源 |
|---|------|--------|----------|------|
| 1 | `.glass` 玻璃卡 | glass | `--sweep-bg` `--sweep-op`（`FX.sweep`） | ink-screen-seg1/fx_ink.html:71-131 |
| 2 | `.card-title` / `.card-sub` | glass | 静态 | vga-en4/fx_vgaen4.html:67 |
| 3 | `.box/.cap/.lbl/.sub` 参数框 | box | inline opacity + `FX.roll` | vga-signal/fx_vga.html:104-112 |
| 4 | `.bar-row/.bar-track/.bar-fill` | bars | 只写 `.bar-fill` 的 `style.width` | vga-en4/fx_vgaen4.html:128-141 |
| 5 | `.bub` 白底萌系气泡卡 | bub | `FX.pop` | mengmeng/fx_mengmeng.html:52-70 |
| 6 | `.bubble` 深色聊天气泡 | bubble | `FX.pop` + `FX.typeOn` + 三点 opacity | mengmeng/fx_xingjiao_overlay.html:23-38 |
| 7 | `.spark` 星芒 | spark | `opacity = 0.18+0.42*(0.5+0.5*sin(t*s+s'))` | mengmeng/fx_mengmeng.html:34-37 |
| 8 | `.chip` pill 标签 | chip | `classList.toggle('cur'/'on')` | vga-p4-dma/fx_p4dma.html:53-58 |
| 9 | `.sw` 色板图例 | sw | `--sy` `--ss` `--so`（+`--sw-tc` 字色） | ink-en2/fx_inken2.html:121-130 |
| 10 | `.node`/`.arrow` 数据流链 | node | `--no` `--ny` `--nr` `--ns` + `.act` | ink-en2/fx_inken2.html:136-152 |
| 11 | `.board-card` 芯片/SoC | board | 离散 `classList.toggle('on'/'show')` | ink-screen-seg1/fx_ink.html:259-274,385-393 |
| 12 | `.code-line` / `.d-line` 代码行 | code | `--do` `--dx` + `.active` | ink-screen-seg1/fx_ink.html:191 |
| 13 | 后期覆盖层 `.fx-post-*`（**17 个**，见 §12） | post | `--op` | Remotion 同名效果 CSS 等价（已落地，09-13） |

> 契约之外新增的成员：`FX.sweep`（扫光驱动）、`FX.env` / `FX.fadeOut` / `FX.fadeInOut`
> （双向窗口/退场原语，demo 的 sec4 标签实测：0.60s 淡入、4.20s 起 0.60s 淡出，末帧归零）。
> 均为纯新增，契约成员签名未动。
>
> ⚠ **这几个已不是"可选项"，生成器骨架已依赖 `env` 驱动双向窗口，签名冻结。**
> 需要改动时走「新增别名 → 双写过渡 → 再废弃」，并同步两处下游：
> 生成器 `templates/fx-runtime.fallback.js` + 模板/每镜 TODO 注释（负责人：general-purpose-2）。
>
> `env` 两个使用要点：
> 1. 必须 `tIn + dIn ≤ tOut`——退场起点至少比入场结束早 0；重叠时取 min，峰值到不了 1。
>    骨架实测写法：`FX.env(t, t0, t1 - dOut, dIn, dOut)`（退场起点提前 dOut）。
> 2. 峰值 = 元素自身基础 opacity × 1。若元素/父层带基础透明（实测出现过 0.62），
>    要按目标峰值反推，别以为是 env 打折了。

---

## 各组件用法

### 1. `.glass` 玻璃卡

```html
<div class="glass" style="left:80px; top:150px; width:380px; height:250px">
  <div class="card-title">GLASS-01 · BASE COMPONENT</div>
  …内容…
  <div class="card-sub">卡外右侧旁注（确认卡右边有空地再用）</div>
</div>
```
```js
FX.pop(el, t, 0.35, x, y, 'left');
FX.sweep(el, t, 0.35, 1.30);        // 扫光窗口
```
接受的变量：`--sweep-bg`、`--sweep-op`、`--ink`；变体 `.glass--code`（代码卡，关扫光）、`.glass--clip`（裁剪内容）。

⚠ **踩坑（勿改基底色）**：`.glass` 基底必须是深色 `rgba(16,20,44,.28~.42)`。
曾用浅白 `rgba(255,255,255,.12)`，`saturate(180%)` 把背景提亮后纯白字直接糊成一团。
⚠ `.glass` 是 `overflow:visible`——`.card-sub` 挂在卡外（`left:100%`），加了 hidden 会被裁。
⚠ 三层结构别拆：`::before` 渐变描边（`mask-composite:exclude`）是"玻璃与背景分离"的关键，
`::after` 扫光靠 CSS 变量驱动，两个伪元素都别删。

### 2. `.box` / `.cap` / `.lbl` / `.sub` 参数框

```html
<div class="box" style="left:80px; top:520px; width:190px; height:180px; --lbl-ink:#35e0d0">
  <div class="cap">PSRAM</div>
  <div class="lbl fx-num" id="n1" style="--lbl-size:34px; top:54px">0 MB</div>
  <div class="sub" style="--sub-top:104px">外挂堆叠</div>
</div>
```
```js
FX.pop(el, t, 1.20, 80, 520, 'up');
FX.roll($('n1'), 8 * FX.eo(FX.c1(t, 1.30, 0.90)), 0, ' MB');
```
⚠ `.cap` 浮在框外左上（`top:-32px`），框上方必须留 ≥36px 空隙。
变量：`--box-line --box-bg --cap-ink --cap-bg --lbl-size --lbl-ink --sub-top --sub-ink`。

### 3. `.bar-row` 进度条

```html
<div class="bar-row">
  <div class="bar-label">PSRAM 余量</div>
  <div class="bar-track"><div class="bar-fill p4"></div></div>
  <div class="bar-val fx-num">86%</div>
</div>
```
```js
var k = FX.eo(FX.c1(t, 2.30, 1.00));
$('bf').style.width = (86 * k).toFixed(2) + '%';   // 只动 width
FX.roll($('bv'), 86 * k, 0, '%');
```
配色变体：`.bar-fill.p4`（青）/ `.bar-fill.old`（灰）；变量 `--bar-label-w --bar-h --bar-fill-bg`。

### 4. `.bub` 白底萌系气泡卡（浅色场景专用）

```html
<div class="bub" style="left:750px; top:846px; width:470px">
  <div class="head"><div class="ico"><svg …></svg></div><div class="lbl">DUAL-CORE</div></div>
  <div class="val">双核 <em>Xtensa LX7</em></div>
</div>
```
```js
FX.pop(el, t, 3.80, 750, 846, 'right');
```
白底深字（#1B3B5F），只能配明亮场景；深色场景用 `.glass` 或 `.bubble`。

### 5. `.bubble` 深色聊天气泡

```html
<div class="bubble" style="left:80px; top:880px; width:640px">
  <div class="av">AI</div><div class="bname">语音转动画管线</div>
  <div class="btag"></div><div class="tail"></div>
  <div class="dots"><i></i><i></i><i></i></div>
</div>
```
```js
FX.pop(el, t, 3.40, 80, 880, 'left');
FX.typeOn($('.btag'), '正在登记 11 个可复用组件', FX.c1(t, 3.60, 1.00));
// 三点轮转：dots[i].style.opacity = 0.35 + 0.65*Math.max(0, Math.sin(t*6 - i*0.7));
```
尾巴默认指向左侧；要指右改 `.tail` 为 `left:auto;right:-16px + border-left`。
变量：`--bubble-h --bubble-bg --bubble-av-bg`。

### 6. `.spark` 星芒

```js
// 典型呼吸驱动（速度 s、相位 s' 每颗不同才有错落感）
el.style.opacity = 0.18 + 0.42 * (0.5 + 0.5 * Math.sin(t * speed + phase));
```
八角星是 `clip-path`；颜色/大小用 inline `--spark-c` 或直接覆盖 width/height/background。
变体 `.spark.small`。

### 7. `.chip` pill 标签（章节条）

```js
el.classList.toggle('cur', i === act);   // 当前章节：橙框发光
el.classList.toggle('on',  i < act);     // 已走过的章节
```
变量：`--chip-*` 系列（ink/bg/line/on-*/cur-*）。

### 8. `.sw` 色板图例

```html
<div class="sw" style="--sw-c:#2f9e44"><span class="cd">0x2</span><span class="nm">GREEN</span></div>
<div class="sw light" style="--sw-c:#f2c037; --sw-tc:#1c1c1c">…浅色块务必加 light + 深字…</div>
```
```js
var k = FX.c1(t, 3.00 + i * 0.09, 0.45);           // 逐个错峰
el.style.setProperty('--so', FX.eo(k));
el.style.setProperty('--sy', (16 - 16 * FX.eob(k)) + 'px');
el.style.setProperty('--ss', (0.86 + 0.14 * FX.eob(k)).toFixed(3));
```
`.un` = 未启用（42% 透明 + 红斜杠）。⚠ 浅色块（白/黄）白字看不清，实测踩过：
加 `class="sw light"` + `--sw-tc:#1c1c1c`。

### 9. `.node` / `.arrow` 数据流节点链

```html
<div style="display:flex; align-items:center; justify-content:space-between">
  <div class="node"><div class="nb"><div class="ic">帧</div><div class="dim">1920</div></div><div class="lb">FRAME</div></div>
  <div class="arrow">▸</div> …
</div>
```
```js
node.style.setProperty('--no', FX.eo(k));                       // 透明度
node.style.setProperty('--ny', (14 - 14 * FX.eob(k)) + 'px');   // 上移
node.classList.toggle('act', isActive);                          // 当前节点金框
```
变量：`--no --ny --nr --ns`、`--node-w --node-box`。

### 10. `.board-card` 芯片 / SoC 图示

```html
<div class="glass board-card" style="left:1258px; top:150px; width:582px; height:250px">
  <div class="head">SoC · ESP32-S3</div>
  <div class="board">
    <div class="led-row"><i></i><i></i><i></i></div>
    <div class="pins-l"><i></i>×6</div><div class="pins-r"><i></i>×6</div>
    <div class="chip">SoC</div>
    <div class="overlay"><div class="badge">8MB PSRAM</div></div>
  </div>
</div>
```
```js
leds[0].classList.toggle('on', t >= 1.30);       // LED 离散点亮
$('ovl').classList.toggle('show', t >= 4.10);    // 遮罩+徽章离散切换（无补间！）
```
⚠ 内部坐标已从原版写死的 220×380 改为百分比/居中，换卡片尺寸不用重算。
⚠ 原版 `.overlay` 带 `transition:.35s`，已剔除——`show` 是硬切。

### 11. `.code-line` / `.d-line`

```js
line.style.setProperty('--do', FX.eo(k));
line.style.setProperty('--dx', (-14 + 14 * FX.eo(k)) + 'px');
line.classList.toggle('active', done);           // 当前高亮行（左侧金条）
```

### 12. 后期覆盖层 `.fx-post-*`（19 个 + 1 个容器级 `.fx-unify`）

**统一契约**：每个层必须**同时挂 `.fx-post` 基类**，否则 `position:static` → 层高 0 → 静默不可见（09-13 踩过）。

```html
<div class="fx-post fx-post-vignette" style="--op:.55"></div>
```

```css
.fx-post{position:absolute;inset:0;pointer-events:none}
```

**硬约束**：本段**禁出现 CSS `animation` / `transition`**（全 JS `__frame(t)` 纯函数，否则逐帧截图取不到态）。
`--op` 由 JS 逐帧写实现淡入淡出；**全部 `pointer-events:none`**。

| # | 类名 | 效果 | 默认 `--op` | 用途 |
|---|---|---|---|---|
| 1 | `.fx-post-vignette` | 暗角 | **.72**（见表下警告） | 聚焦中心、压边 |
| 2 | `.fx-post-scanlines` | 扫描线 | .55 | CRT / 科技做旧 |
| 3 | `.fx-post-gridlines` | 网格线 | .85 | 坐标纸 / 蓝图底 |
| 4 | `.fx-post-lightleak` | 漏光 | .70 | 胶片感、暖调呼吸 |
| 5 | `.fx-post-noise` | 颗粒噪点 | .45 | 电影质感（2px 亚可分辨） |
| 6 | `.fx-post-paper` | 纸纹 | .42 | 档案 / 手稿质感 |
| 7 | `.fx-post-halftone` | 半调网点 | .40 | 印刷网屏（5px / 26% 点径） |
| 8 | `.fx-post-dotgrid` | 点阵 | .55 | 浅色科技底（1.6px / 22px 间距） |
| 9 | `.fx-post-thermal` | 热成像伪彩 | .55 | 数据 / 温度叙事 |
| 10 | `.fx-post-duotone` | 双色调 | .75 | 强风格化（`::before`+`::after` 双层） |
| 11 | `.fx-post-lightsweep` | 光扫 | **JS 驱动** | 章节切换（一次性斜扫） |
| 12 | `.fx-post-chromafringe` | 色散边缘 | .85 | 镜头色差、轻微做旧 |
| 13 | `.fx-post-rings` | 同心环 | .85 | 雷达 / 信号（52px 间距） |
| 14 | `.fx-post-waves` | 横向波纹 | .85 | 数据 / 声波背景 |
| 15 | `.fx-post-starburst` | 星芒放射 | .62 | 点缀 / 高潮（**慎用**） |
| 16 | `.fx-post-edgeburn` | 边角烧灼 | .62 | 复古照片 / 档案 |
| 17 | `.fx-post-scanbeam` | 扫描条 | **JS 驱动** | 逐行扫描 / 扫过主体 |
| 18 | `.fx-post-grade` | 叠色偏 | .55 | ⚠️ **只叠色偏，不统一色温**（2026-09-14 实测，见下） |
| 19 | `.fx-post-grain` | 胶片颗粒 | **.45**（双层） | 真 `feTurbulence` 分形噪声；**`::before` multiply + `::after` screen 双层** |

> ⚠️ **18/19 与暗角是 2026-09-14 复刻实物时补的，都带实测警告**：
> - **`vignette` 默认 .72 → 实测四角压暗 79.6%**（`.28` 档也有 59.3%）——
>   **两档都过半**，光拧 `--op` 降不下来，要改渐变 stop。见 `学习知识库.md` §16.11。
> - **`grade` 单独用会把色差拉大 12.7%**（soft-light 是空间加色，推不动素材之间的差异）→
>   统一色温必须配 **`.fx-unify`**（见 §12c）。
> - **`grain` 别用 `overlay`** —— overlay 在 a→1 时响应趋近 0，亮部画面等于没开
>   （实测 stddev 3.252 → **2.843**）。双层互补是正解，且平均亮度不变。
>   伪元素没法被 JS 直接改样式 → 闪烁位置走 CSS 变量 `--gx/--gy`，由 `__frame(t)` 写变量。

### 12c. 容器级统一器 `.fx-unify`（2026-09-14 新增 · **不是**覆盖层）

**跟 `.fx-post-*` 的根本区别**：它不是盖在上面的图层，是**挂在内容容器上的 `filter`**，
作用于「容器合成后的结果」→ **所以它能改变"素材之间"的关系，覆盖层做不到**。

```html
<div class="fx-unify" style="--unify-sat:.72">…三个来源的素材都在里面…</div>
```

```css
.fx-unify{filter:saturate(var(--unify-sat,1)) contrast(var(--unify-contrast,1))}
```

- **实测**：三种来源素材（暖 30.2° / 冷 207.7° / 中性 219.0°）的**感知色相距离**（= 圆环色相距离 × min 饱和度）：
  无处理 76.4 → **只叠 soft-light 86.1（+12.7%，更不搭）** → 降饱和 .72 **57.7（−24.4%）**。
- ⚠️ **挂点必须是所有素材的公共父容器**。挂到单个素材上只是各自降饱和，**差异一点没变**。
- ⚠️ `filter` **不能靠 CSS `transition` 平滑**（本项目禁 animation/transition 是铁律）→
  **必须由 `__frame(t)` 逐帧写 `style.filter`**，把插值算在纯函数里。
- ⚠️ 别用「色相离散度」当判据 —— 该指标对调色层**八个档位恒为 120.0°**，是**假指标**。

### 12d. 复刻实物 · `_demo/remotion_stack/`（2026-09-14 新增）

| 文件 | 用途 |
|---|---|
| `remotion-stack-replica.html` | 单文件、双击即播、15.4s / 4 镜（Grade 捏合 → 5 层堆栈 → 暗角 A/B → 弹簧三预设） |
| `_shot.js` | 截帧 + 读数（`__SETTIME(t)` 精准 seek；`NODE_PATH` 指公共 node_modules） |

**探针契约**：`__frame(t)` / `__TOTAL()` / `__SHOTS()` / `__SPRING()` / `__SETTIME(t)` / `__PLAY()` /
`__HUDSTYLE(sel)`（含伪元素）/ `__SETUNIFY(sat,con)` / `__SETGRAIN(op)` / `__UNIFY()`

**重跑**：
```bash
cd 语音转动画总项目/kit/_demo/remotion_stack
NODE_PATH="./node_modules" \
  "node" _shot.js
# 预期：11 张 shot_*.png + JS_ERRORS=0；弹簧实测 over=[4,0,16]；grain blend=multiply/screen；grainPos 每帧变
```
> ⚠️ 截帧前 `viewport` 必须设 1920×1080（`deviceScaleFactor:1`）——
> 这样 `scale(1)`、**截图像素 = 设计像素**，量色才准（见 `_shot.js` 注释）。

**JS 驱动的两个**（`lightsweep` / `scanbeam`）默认 `opacity:0` 或亮带在可视区外，
可见性来自**位置**而非存在，必须由 `__frame(t)` 写 `backgroundPosition` 驱动：

```js
UIP.postSweep(el, t, t0, d)          // 光扫：写 backgroundPosition + 0.55*sin(πp) 的 opacity
UIP.postBeam(el, t, t0, period, on)  // 扫描条：三角波上下往复
```

> ⚠️ **`conic-gradient` 做星芒，周期必须整除 360** —— 否则必出竖缝。
> `starburst` 现在用 `repeating-conic-gradient` + 10deg 周期（36 条芒）+ 2.2deg 楔形。
> 09-13 曾用 `conic-gradient` + 1.6deg/9deg，结果 40 条芒被抽成 2 条竖纹、下半屏差分为 0。

### 12b. 元素级效果（10 个，`UIP.*` 纯函数）

从 Remotion 元素级效果映射而来（约 25 个可映射项中的第一批），全部 `__frame(t)` 纯函数：

```js
UIP.blurBridge(el,t,tFocus,d,tOut,dOut)  // 模糊桥接，最糊 14px
UIP.glowPulse(el,t,t0,color,amp,freq)    // drop-shadow 呼吸
UIP.outlineDraw(el,t,t0,d)               // 描边勾线
UIP.pixelDissolve(el,t,t0,d,dir)         // 4px 块 mask + maskPosition 推前沿
UIP.mirrorSlide(el,t,t0,d)               // 镜像滑入
UIP.translateFx(el,t,t0,d,dx,dy)         // 位移
UIP.scaleFx(el,t,t0,d,s0,s1)             // 缩放
UIP.tearReveal(el,t,t0,d,gap)            // 撕纸揭示：clip-path 上下两片让位
UIP.blindsReveal(el,t,t0,d,stagger)      // 百叶揭示：子条带 scaleY 错峰
UIP.exposureRamp(el,t,t0,d,a,b)          // 曝光爬升（brightness）
UIP.tintRamp(el,t,t0,d,h0,h1)            // 色调偏移（hue-rotate + saturate）
```

**验收工具**（`kit/` 下，两个都必须跑）：

```bash
NODE_PATH="./node_modules" node _postshot.js   # CSS 层 + 截帧
"python" _postdiff.py  # 像素级差分
```

- `_postshot.js` 四条判据：兜底占位 / 没挂上类 / **层高为零**（几何）/ 真没生效（含**伪元素**）
- `_postdiff.py` **on/off 差分**，双判据取「或」：全屏看 `MAE>=1.0`；局部看 `最亮行MAE>=6.0 且 峰值>=40`
- ⚠️ `_postdiff.py` 必须用**受管 venv 的 python**（需 Pillow）
- ⚠️ **判据口径要匹配被测量形状**：窄条效果（`scanBeam`）全图 MAE 仅 0.72，但峰值 111、最亮行 46.16

---

### 13. 无缝转场（match cut）· `FX.matchOut` / `FX.matchIn`（2026-09-13 新增 · 2026-09-14 复核修正）

**公式 = 同一个元素 × 同向运动 × 切点两侧都贴住容器边界**（学习知识库 §17 · 规格锁 §5.16，来源 B 站 `BV1sSKX63Ets`）

> 🔴 **2026-09-14 复核修正（先读这段再看下面的 API）**
> 老板看过复刻实物说「差距很大」→ 把原片逐帧量了一遍，**推翻本节的机理表述**：
>
> | 旧写法 | 实测 |
> |---|---|
> | 元素**冲出画面** | ❌ 元素**从没出过卡片** —— 它在 `overflow:hidden` 的**内面板**里移动，被面板边界裁掉（裁切线恒 `x=538`） |
> | 出画加速 + 入画减速（**速度对冲**） | ❌ 原片 B 段**没做减速冲入**，是**贴着左边缘缓缓漂移**（0.88s 走 18px ≈ 28px/s）；A 段末速 **1410px/s**，**差 50 倍** |
> | 切点藏在**速度峰值**里 | ❌ 切点是**隔 1 帧干净硬切**（t=15.300→15.333） |
>
> ✅ **真正的机制**：切点两侧**同一个元素都紧贴容器边界、都只露一小块** →
> 观众读成「**一个圆从右边缘出去、从左边缘进来**」= **穿越错觉**。动量方向一致只是加分项。
> ⚠️ 旧表述是从**教程口播**推的（ASR 说"由慢到快/由快到慢"），**口播 ≠ 这一版怎么做的**（BUG-2137）。
>
> ⭐ **`FX.matchOut` / `FX.matchIn` 作为一对数学工具仍然有效** —— 它们是「**真做速度对冲**」时的正确写法
> （见 `match_cut_demo.html?v=strong`），但**不是这条原片的解释**。
> 完整依据 → `BUG-总回归库.md` **§6.17（BUG-2132~2138）**。

> ### 🔴🔴 2026-09-14 第四轮复核（30fps 全链逐帧 · **上面一整段也被推翻了，先读这段**）
>
> 老板再否一次：「**你不用专注还原原片长什么样 你应该关注的是复刻原片的转场效果
> 我是说你这个转场效果做的不行**」→ **整条链**（9.2~21.2s / 360 帧 / 1/30 步长）逐帧量
> 「圆左/右缘/宽」+「画面指纹Δ（**挖掉圆之后**的 8×8 灰度）」。依据 → `BUG-总回归库.md §6.17 第四轮（BUG-2139~2145）`。
>
> | 上面那段写的 | 第四轮实测 |
> |---|---|
> | 「真正的机制 = 切点两侧都紧贴容器边界 → 穿越错觉」 | ⚠️ **只覆盖 3 种技法之一**（技法③）。原片有 **3 次硬切**，其中 **2 次圆压根没动 / 不在画面里** |
> | 「B 段首圆贴着左边界（距左界 3px）」 | ✅ 只对了 **15.333** 那一个切点 |
> | 隐含假设「原片 = A/B 两段」 | ❌ 其实是 **A → B → B2 → B3 → A**（画面2 内部还换了 **2 次内容**），**链上有 3 种技法交替** |
>
> **★ 要复刻的是"链"，不是"一刀"** ——
> **同一个橄榄色圆一直留在画面里，画面在它周围换了 3 次内容**。
> **主尖峰只有 3 个**（10.967 Δ≈50 / 15.333 Δ≈32 / 20.133 Δ≈137；阈值 12 会多扫出 `11.033 Δ=12.7` = 切后次帧压缩残差），
> 中间 **16.8 / 18.5 两次是「圆一动不动、只有画面内容换」** —— **这才是"无缝"的来源**。
>
> **★ 三种技法（实测参数）**
>
> | 技法 | 怎么做 | 实测 |
> |---|---|---|
> | **① 缩小/消失 → 切 → 长大弹出** | 圆原地收缩 → 硬切 → 原位带过冲长回来 | 收缩 **0.20s**；出现→冲顶 **0.20s**、总历时 **0.40s**、峰值 **1.30×** |
> | **② 圆锚定换画面** ★最无缝 | 圆**完全不动**，只有内容换 | 跨切点**每帧步进不得跳变**（两侧同取 **1 帧**步进比较）；漂移途中换 / 静止时换都行 |
> | **③ 右出 → 切 → 左侧接着** | 加速冲出右界被裁 → 硬切 → 从左侧接着 | 冲刺 **0.50s / 298px / easeInQuad**；被裁着停 **1.15~1.17s**；可见宽 **54px**；切入侧圆左缘 **0** |
>
> **★ 三条量法铁律（本次踩出来的，比技法本身更重要）**
> ① **必须 30fps 逐帧** —— 切点是单帧瞬态，10fps(步长 0.1s=3 帧) 把 0.50s 冲刺读成 0.35s（BUG-2139）；
> ② **画面指纹必须先挖掉圆** —— 否则「圆在动」被读成「画面在换」（BUG-2144）；
> ③ **面板边界逐列扫亮度、别把白边框算进去** —— 误按含白边的 398px 折算 ⇒ **把本来正确的参数改错 8%**（BUG-2140）。
>   实测面板 = **`x176..538`（362）× `y358..628`（270）**，与我们的 `364×271` **本来就一样大 → 不需要折算**。
>
> **★ `FX.matchOut` / `FX.matchIn` 使用结论更新**：
> **原片 3 个切点里一次都没用到它**（两侧圆都是静止的：15.267 → 15.300 **一个像素未动**）。
> 它是"真做速度对冲"时的正确写法，**但要先回答"这个片子真的需要一个加速出画的元素吗"**；
> 若答案只是"想让过渡好看点"，那是**拿工具当理由** → 退回上面三技法表重新选。

**原理一句话（第四轮修正）**：**让一个元素一直留在画面里当锚点，把画面在它周围换掉。**
切点两侧**不必都贴边**（技法② 圆在飘）、**也不必都在动**（原片切点两侧都静止）。

```js
/* A 段（出画）：元素从画面内加速冲出右侧 */
var mA = FX.matchOut(t, { t0: 9.00, dur: 0.45, from: [420, 540], to: [1900, 540] });
elA.style.transform = 'translate(' + mA.x + 'px,' + mA.y + 'px)';
elA.style.opacity = mA.on ? 1 : 0;       /* 冲出去就收，别留残影（三查会抓） */

/* B 段（入画）：同色同形元素从画面外左侧减速冲入落位 */
var mB = FX.matchIn(t, { t0: 0.00, dur: 0.45, from: [-1900, 540], to: [-60, 540] });
elB.style.transform = 'translate(' + mB.x + 'px,' + mB.y + 'px)';
```

返回 `{k, e, on, x, y, s, r}` —— `k` 原始进度、`e` 缓动后进度、`on` 是否在窗口内、
`x/y` 位移（px）、`s` 缩放（给了 `o.scale` 才有）、`r` 旋转（给了 `o.rot` 才有）。

**o 字段**：`t0` 起点（默认 0）· `dur` 时长（**规格锁限 0.3~0.6s**，默认 0.45）· `from` / `to` 位移端点 `[x,y]` · `scale` / `rot` 可选。

**六条使用纪律**：

1. **必须成对**：A 段 `matchOut` + B 段 `matchIn`，单用一侧等于没有转场。
2. **必须同向**：两侧位移方向符号要一致（都往右冲出 / 都往右冲入）。方向相反 → 切点每帧反向跳 `2×峰值` px（`dur=0.45/Δx=1400` 时是 **622px/帧**），观感是"撞墙弹回"。
3. **必须等距等时**：`|Δx|` 与 `dur` 两侧都要相同 —— 峰值 `3·Δx/dur` 才会相等。
   （这就是「速度对冲」的全部机密：**两条立方曲线峰值天然都等于 3**，不靠调参凑。）
4. **★ 转场元素属「工具」，不是「目标」**：它豁免规格锁 §5.11「进场禁 ease-in」。
   判别问句：「**这个元素是让观众看清的，还是用来把画面推走的？**」
   卡片 / 标题 / 数据 / 产品图 → **目标** → 照旧禁 ease-in；承担推走画面任务的形状 / 色块 → **工具** → 必须 ease-in。
5. **冲出去记得收**：出画元素离开视口后 `opacity` 归 0，否则留在下一段的画外或边缘 = 残影（四查三查会抓）。
6. **与「画面只渲一次 + `-c:v copy`」无冲突**：转场元素在各自段内渲染，段数与渲染次数都不变。

**验证**：`node _verify_match.js` —— 4 条判据（out 单调加速 / in 单调减速 / 切点速度匹配 / 方向一致）
+ 2 条反例对照（出画错用 ease-out、入画方向搞反），**反例区分不出来会判 FAIL**（区分不了 = 判据是死代码）。
2026-09-13 实测 4/4 PASS，两遍 md5 一致。

**★ 复刻实物（2026-09-14 第四轮重做 · 纯 HTML 双击即播 · **5.80s 循环转场链**）**：

| 文件 | 是什么 |
|---|---|
| `_demo/match_cut_demo.html` | **★ 唯一交付物**（纯 HTML / `__designCheck()` **16 条判据全绿** / `_probe.js` 公式 vs DOM 偏差 **全 0.0**） |
| `_demo/_otrace.py` | **原片密集追踪核心工具**（30fps 逐帧量圆位置 + **挖掉圆后**的画面指纹Δ，Δ 尖峰 = 切点） |
| `_demo/_vs.py` | **原片‖复刻同进度并排**（上排原片 / 下排复刻，同列 = 同技法进度；两侧各自裁到自己的面板） |
| `_demo/_strip.js` | 五组序列截图（`chain` 全链 / `cut` 技法③逐帧 / `swap` 技法② / `pop` 技法① / `key` 供对比） |
| `_demo/_grid.py` | **通用接触印/拼图**（`python _grid.py <帧目录> <起始秒> <帧率> <时间点> <输出> [缩放] [列数] [裁剪]`；第六轮把第四轮那个硬编码裁切的拼图脚本通用化，旧的已删） |
| `_demo/_probe.js` | 公式 vs 真实渲染探针（读 `getBoundingClientRect` 对账 `window.__discAt(t)`） |
| `_demo/_geo.js` | 打页面真实几何（`#panel` = `(175,359)-(539,630)`） |

> ⚠️ **旧版三件套（`match_cut_demo_bad.html` / `.strong` / 三个 `.mp4` / `_match_cmp.py` / `_match_frames.py`）已删** ——
> 它们基于"一次转场动作"的旧结构，`bad`/`strong` 两个变体在新链式结构下**已无意义**。
> 交付形态也按老板要求改为 **纯 HTML，不渲 mp4**。
> ⚠️ 该 HTML 的圆参数（`R=62.5` · 面板 364×271）**绑定这个画布**，换规格要重算。

**验证流程（`kit/_demo/` 下，第四轮固化）**：

```bash
PY="python"
NODE="node"
export NODE_PATH="./node_modules"
cd kit/_demo

# ① 片内自检（读 window.__designCheck()，16 条判据；含四查式几何自检）
$NODE _match_shots.js                     # 顺带截 13 帧
# ② 公式 vs 真实渲染 对账（偏差必须全 0.0）
$NODE _probe.js
# ③ 五组连续帧截图 → 与原片同进度并排（复刻类任务**必要**，必须人眼 Read）
$NODE _strip.js
$PY  _vs.py                               # → vs_cut / vs_chain / vs_pop / vs_swap 四张
$PY  _grid.py _tmp/strip_chain 9.2 30 9.2,9.6,10.0,10.4 _out_chain.jpg 1 3   # 接触印（第六轮通用版）
#      ⚠️ 接触印的铁律：**1:1 不缩放**（缩过会被 JPEG 压糊看错，BUG-2145）；
#      且**不能用来判"接缝在第几像素"**（无间隙拼图会把邻格边缘串过来，BUG-2150）
```

原片密集追踪（**改了参数要重跑这条**）：
```bash
$PY _otrace.py     # 需先有 _tmp/otrace/f_%04d.jpg：
                   # ffmpeg -ss 9.20 -t 12.0 -vf fps=30 -q:v 2 _tmp/otrace/f_%04d.jpg
                   # → 输出 _tmp/otrace.txt（360 行：t / 圆左 / 圆右 / 圆宽 / 面积 / 画面指纹Δ）
```

> ⚠️ **`__designCheck()` 全绿 ≠ 像**（BUG-2132）—— 它只问「我的公式实现对不对」，不问「这一帧跟原片同刻像不像」。
> **复刻类任务收尾必须过 ③（并排图）且人眼看过。**

**⚠️ 已知边界**：技法提炼自 **1 条 37s 竖屏短视频**（n=1），只演示了颜色 / 形状 / 线条三类载体；
听觉层无缝（J-cut / L-cut）是另一套东西。详见学习知识库 §17.8。另外四条（2026-09-14 补）：

1. **教程口播 ≠ 这一版怎么做的** —— ASR 的"由慢到快/由快到慢"与画面实测差 50 倍。**以画面为准。**
2. **本条载体是「卡片内部的圆形」**（内面板 362×270 + `overflow:hidden`）。
   换成"元素真的横穿整张画面"时，贴边约束不适用 —— **但仍要先判"是链还是一刀"**（第四轮）。
3. **§17 转场链 ≠ §19 垂直推移**，两条是**不同源**的独立技法（判据完全不同，见知识库 §19.1 修正表）。
4. **★ 链式转场 ≠ 一次转场**（第四轮新增）—— 复刻前**必须先把原片的"元素位置曲线 + 画面指纹Δ"拉出来**，
   确认「有几个切点、每个切点圆在哪、有没有"圆不动"的切点」。**直接照"切一刀"的思路做，必然做成僵硬演示。**

---

### 13b. 场景接力 · `_demo/scene_swap_demo.html`（2026-09-14 第五轮新增 · **已迭代到第六轮** · **这是转场线的交付路线**）

> **⚠️ 与 §13 的关系**：§13（`FX.matchOut/matchIn` / `match_cut_demo.html`）是**原片机制研究标本**，
> 老板第四次打回时判定"**只是把原片演示了一遍，没有真实利用两张卡片做元素切换**"。
> **新活儿一律走本节**；§13 保留作研究留档，**不再作为交付路线**（且 `FX.matchOut/matchIn` 仍基于已被推翻的"速度对冲"口径，沿用前须重写）。
>
> **📌 第六轮（2026-09-14 晚）又迭了一版** —— 老板「**画面动了 你的衔接元素也要动哈 我看到你有几个画面是画面动 球没动 这不对的**」
> ＋「**太刻意了 … 前摇太长了 … 黄线也做一个**」→ 见本节末尾「★ 第六轮追加」。

**跑法**：`kit/_demo/scene_swap_demo.html` 双击即播（**5.60s** 循环 / 720×1280 / **四张真实场景**）。
`?t=1.42` 定帧 · `?cap=1` 显示机制字幕 · `window.__frame(t)` 供探针驱动 · `window.__designCheck()` 15 条自检。

**★ 七条几何规格（全文 → 规格锁 §5.16.7；原理 → 学习知识库 §17.9）**

| # | 规格 | 一句话理由 |
|---|---|---|
| G1 | **场景尺寸 = 视口尺寸**（`720×1280`）| 卡宽 ≠ 视口宽 → 两端露碎片 → 逼出淡入淡出 → **淡入淡出在接缝处咬圆** |
| G2 | **位移恒 = W（水平）/ H（垂直）· 共用缓动 · 禁 scale · 禁透明度** | 四条齐了 ⇒ 在场场景并集**恒等于整幅画面** |
| G3 | **贯穿元素用屏幕坐标 + 每张场景各渲一份副本**（只写 `translate`+`scale`） | 边界扫过：一份被 `overflow:hidden` 裁掉、另一份无缝接任 |
| G4 | **9 条判据**（`__designCheck()`） | 见下 |
| G5 | **元素的"停靠位"要在每张场景里单独留空** | 几何判据**查不出"压住正文"** —— 只能人眼看 |
| G6 | **量法三条**：数连续列数 / 像素分类器 ≥6px 才算一段 / 不许用拼图判接缝 | 三条都是本轮踩出来的 |
| G7 | **撞边后给 0.12s 贴边**（画面已在推，不算静止） | 让"撞住"被看清，但**一帧不许空等** |

**`__designCheck()` 9 条判据**：① 场景签名唯一性 3/3 ② 圆不被咬断（可见列必须一整段，洞 ≤1px；覆盖不透明度 ≥0.98）②b 撞边可见宽 40~70px ③ 并集满幅（两轴洞 ≤0.5px）④ 切换时场景本体位移 ≥2 张 ⑤ 紧接着 ≤2 帧 ⑥ 零静止 ≤80ms ⑦ **同一个元素读 DOM 真值验同心**（圆心 ≤1px、直径 ≤1px）⑧ 循环接缝同态。

**验收工具链（`kit/_demo/`，全部可复跑）**

| 工具 | 作用 | 跑法 |
|---|---|---|
| `_chk2.js` | 设计自检 9 条 | `node _chk2.js [file]` |
| `_shot.js` | 按帧率渲整链 PNG 序列 | `node _shot.js <file> 30 0 6.0` |
| **`_px.py`** | **逐列扫像素**：露底列数 / 圆被咬断 / 圆可见宽 | `python _px.py 600,1000 1` |
| `_one.js` | 原尺寸局部帧（判接缝用，**不许拿拼图判**） | `node _one.js <file> 1.00,1.10 420:500:300:400 tag` |
| `_smoke.js` | 实时 rAF 播放冒烟（自检走的是 `?t=` 定帧路径，得单独验） | `node _smoke.js` |

**⚠️ 需要 `NODE_PATH="./node_modules"`（puppeteer-core）+ Chrome 路径。**

**实测（2026-09-14 第五轮）**：9 条判据全绿；逐列扫像素 30fps × 180 帧 → **露底 = 0 / 圆被咬断 = 0**；撞边可见宽 **右 55 / 左 55px**（原片 54~57）；紧接着 **1.0 帧**；零静止 **13ms**。

---

**★ 第六轮追加（2026-09-14 晚 · 规格锁 v1.18 / 学习知识库 §17.10 / BUG-2152~2158）**

**四条新规格（全文 → 规格锁 §5.16.8）**

| # | 规格 | 一句话理由 |
|---|---|---|
| **G8** | ★★★ **贯穿元素在切换期必须跟着画面一起动**（不许"钉住"） | 判据方向曾反了：我验"元素稳不稳"，观众验"元素跟不跟得上" —— 全绿也拦不住"球冻住" |
| **G9** | ★★ **缓动选型：速度剖面两端归零** → `easeInOutQuad`(峰/均 2.0) / `easeInOutCubic`(3.0) | 旧 `k²` 末端速度最大 = "一头撞上去"；`easeOutCubic` 尾巴长 = "迟迟不落定" → **两条叠加 = "刻意"** |
| **G10** | ★★ **方向一致性**：画面推移方向 = 元素位移方向 | 曾出现"画面往上推、球往下沉"（互相抵消），单看元素读数还是合格的 |
| **G11** | ★ **零静止的根因在"曲线交界"** | 两条曲线在同一处都归零 → 108ms 死帧；至少让一方 `lin` 兜底 |

**判据 ④b（新增，锁住 G8）**：每个切换段比【元素屏幕位移向量】vs【出场卡位移向量】——
① 元素位移 **≥150px** ② 夹角 **≤45°**。
实测：向右 **508px/0°** · 向上 **309px/0°** · 向下 **282px/9°** · 向左 **309px/31°**；**起手差 −0.4 帧**。

**两个新组件（黄线两式，全文 → 规格锁 §5.16.9）**

| 组件 | 形态 | 实测参数（原片 → 复刻） |
|---|---|---|
| **`ruler` 标尺线** | 带刻度横线 + 慢/快/慢标签，**从左向右画出来**；橄榄黄圆**骑在线上方沿它滚**，中段**拉丝** | 厚 **6px** / 长 **600px** / 滚 **552→556px per 0.60→0.54s** / 峰 2027÷均 1026 = **1.98**（原片 2.2）/ 出画**当帧**接下一画面（`Δfp 0.1`，**不是硬切**） |
| **`uline` 生长下划线** | 卡片内 6px 黄线**减速生长**，上方**照片条同曲线左滚**（人像 + 标签） | 厚 **6px** / 起点原片 `x=56` → 复刻 `x=64` / 终长 **375 → 374px** / 速度 **476→13.5px/s** / 前 25% 长 **285px** vs 后 25% 长 **0px** / 耦合偏差 **0.0000** |

> **★ 全片"黄"只有这两处** —— 6fps 全片 + 30fps 精扫确认；`25.5s` / `29.0s` 扫到的"黄"是**橄榄黄圆**（⌀70px）被色判据捎带进来的。
> **分工**：**A 标尺线是"测量型"**（线是尺子，承担整段叙事）→ **独立成一张场景**（新增 `#sr`）；
> **B 生长下划线是"强调型"**（卡片内的一个元素）→ **作为场景内元素**（放进重做后的 `#s3`）。

**★ 第六轮实测（三轨全绿）**：`__designCheck()` **15 条全绿 × 2 遍 / 页面错误 0**；逐列扫像素 **露底 0 · 圆被咬断 0 · 撞边可见宽 55px**（原片 54~57px）；`零静止` 最长 **33ms**。

**工具链变化**：`_px.py` 重写为 **numpy 窗口版**（采样窗口由 `__discAt(t)` 给出，不再"猜它在哪"）；`_shot.js` 的 `times.json` 记 `{x,y,k}`；新增 `_yscan.py`（黄元素结构客观化）· `_grid.py`（**通用接触印**，把硬编码裁切的一次性拼图脚本通用化后保留）。

### 14. 插画"被画出来" · `ILLU.illuGrow`（2026-09-14 新增 · 首单 `MO-2026-09-14-001`）

**问题**：素材底座 **1420 张 / 81%** 的 unDraw 插画是**纯 fill 色块 + 图元自带 `transform`**。
逐笔描线不行（没 stroke），**逐层揭示也不行**（transform 是父级坐标系**累乘**，自己算必然算错）——
剩下只有最平庸的整体位移 / 缩放 / 淡入。

**解法 = 硬边前沿 + 笔尖亮线。只动容器，不动内部 path。**

```
.stage        ← 不裁。笔尖住这一层
  ├─ .illu-clip   ← clip-path 裁这一层。SVG 住里面
  └─ .illu-pen    ← ★ 笔尖是 clip 的「兄弟」，不是子
```

> ★★ **核心判别**：**淡入 = 「出现」；硬边推进 = 「被画出来」。**
> 因果感不同 —— 观众看到的是"这东西自己长出来"，不是"它浮现了"。**不能互换。**

**API（`window.ILLU`，8 个成员）**：

```js
var illu = ILLU.mount(stageEl, { penColor: 'var(--c-a1)' });   /* 自找 .illu-clip，找不到 throw */
/* 逐帧里 */
function __frame(t) {
  ILLU.illuGrow(illu.clip, t, {
    t0: 3.42,            /* ★ 绑 ASR word.start，不绑时钟 */
    dur: 1.8,            /* ★ 叙事级窗口 1.2~2.4s（角色卡铁律 5-b） */
    dir: 'rtl',          /* rtl | ltr | ttb | btt | diag */
    ease: 'eio',         /* 默认 smoothstep */
    slope: 28            /* 仅 diag 用 */
  });
}
```

| 成员 | 作用 |
|---|---|
| `illuCalc(t, o)` | **纯计算，不碰 DOM** → 判据**不开浏览器**就能跑 |
| `illuGrow(clipEl, t, o)` | 写 DOM（`clipPath` + 笔尖 `opacity`/位置） |
| `softGrow(clipEl, t, o)` | **对照件**：淡入 + 上浮 18px（用来证"前沿"不可替代） |
| `mount(stage, opts)` | 建层级 + 塞笔尖；**约束固化在 API 里** |
| `reset` / `clipFor` / `axisOf` | 复位 / 生成 clip 串 / 方向映射轴 |

**返回**：`{k, p, pct, clip, penOp, penX, penY, axis, dir, on, done}`。

**三条硬设计（都是踩出来的）**：

1. **★ 笔尖必须挂 clip 的兄弟层**（真 bug）
   最初 `mount` 写 `host.appendChild(pen)`，而 host 正是**被裁那层** → **笔尖被自己的前沿切掉**。
   → 改挂 `stage`；并让 `mount` **自己去找 `.illu-clip`**，找不到直接 `throw`。
   **约束写进 API，不写进口头约定。**
2. **★ 计算 / DOM 分离** → `illuGrow` 里**不重算**，只用 `illuCalc` 的结果；
   好处是 **27 条纯计算判据秒级跑完，不用开浏览器**。
3. **★ 笔尖位置夹进 `[0, W−pw]`** —— 末帧笔尖在 `x=W` 时右半 2px 出界被裁，PX3 白报 FAIL。

**⚠️ 曲线坑**：`FX.eio` 是 **smoothstep `t²(3−2t)`，不是 cubic in-out**。
按 cubic 反推 `t=1.05` 得 `p=0.335`、**真值 `0.40674`** → 前沿位置会算偏，**白报一轮 FAIL**。
**要值就实测**（渲染时读 `getComputedStyle(el).clipPath`），别用公式反推。

**验收**：三层判据 **71 / 71** —— 纯计算 `_illu_check.js` **27** · 主题包 `_theme_check.js` **25** ·
像素 `_illu_pixels.py` **19**（PX0 调色板落地 / PX1 硬边台阶 / PX2 笔尖存在 / PX3 末帧归零 / **PX4 完成后静止**）。
跨 **3 种极端构图**（宽高比 **1.45 / 2.86 / 0.58**）回归**全部成立**。

| 关键实测 | 值 |
|---|---|
| 纸色 `#282B31` 占像素 | **62%**（修前 **0**） |
| 前沿台阶（正例 vs R2） | **12.2 / 25.1** vs **0.1 / 11.0** |
| 末帧最右窗口峰值（正例灭 vs R4 亮） | **92.4** vs **254.0** |
| PX4 完成后静止 | `MAE = 0.0000 / max = 0`（反例揭示中 MAE = 14.46 → 判据有效） |

**配套：SVG 调色板 10 角色（`THEMES.svg()` / `svgAudit()`）**

`--c-ink` `--c-ink-2` `--c-line` `--c-line-2` `--c-soft` `--c-paper` `--c-paper-ink` + 3 个强调色。
**此前本线零定义**（只用不定义，全靠 `svg_norm.py` 的 fallback 撑着 → **页面正常但主题切换完全无效**）。

> ⚠️ ★ **`--c-paper` 不能直接取 `bg.base`** —— 原图 **12 处 `#fff` 是承托块**，
> 纸 == 背景 → **承托块全隐形**，插画显得空、散。
> 正解 `mix(paper, ink, 0.14)`（掺 9% 时对比只有 **1.146**，卡在阈值上会飘绿飘红）。
> 这条已进自证判据 **S5「纸 vs 背景 ≥ 1.15」**。

**验证命令**（工作目录 = 该批插画的交付目录）：
```bash
node _illu_check.js      # 27 条纯计算
node _theme_check.js     # 25 条主题包
python _illu_pixels.py   # 19 条像素（依赖 _shots/ 截图）
node _illu_cross.js      # 跨素材回归（3 张极端宽高比）
```

**⚠️ 已知短板**（诚实登记，验收报告 §七）：
① **未进过真实成片**（`t0` 由 ASR 词轴驱动只在纸面上成立）；
② 笔尖亮线色固定 `#fff` + `--c-a1`，**浅色主题下未做实测**；
③ 竖幅素材在 16:9 画布上占位偏小 → **版式层问题，非配方锅**。

---

### 15. 抽帧审查 `frame_sheet.py`（contact sheet · 2026-09-14 登记 · 副手交付 / 主 agent 修正定位）

> **它是什么**：把**已经采出来的**帧图拼成 contact sheet（一张图看 12 帧），
> 把肉眼审查的 `Read` 调用**压一个量级**（86 张 → 7 张）。
> **它不是抽帧器，也不采帧。**

**位置**：`kit/frame_sheet.py` · **依赖**：`PIL` + `numpy`（受管 venv 已装）· 纯本地零外部依赖

```bash
PY="python"

# ① 单目录 grid（4×3 = 12 帧/页）
"$PY" kit/frame_sheet.py <帧目录> --auto-sample --cols 4 --rows 3 --out _sheet.png

# ② 多目录 A/B（每目录一列，时间点沿行展开）—— 找跨版本差异的最强形态
"$PY" kit/frame_sheet.py frames_base frames_uim frames_uimfix frames_fix \
      --auto-sample --rows 12 --cell-w 360 --cell-h 202 --out _4up.png

# ③ 索引命名模式（审核员 `f_000.png` 这类不含时间的命名 + 旁边的时间数组）
"$PY" kit/frame_sheet.py frames_new --glob 'f_*.png' --times-json times.json --out _new.png
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--glob` | `t*.jpg` | 文件名模式 |
| `--times-json` | — | 索引命名模式：按**排序后下标**去时间数组取值 |
| `--tolerance` | `0.06` | 就近匹配容差（秒）。建议点没有精确帧时用附近帧顶上 |
| `--auto-sample` | 关 | 按四段密采样给**建议点**（**只筛选已存在的帧**） |
| `--dur` | `9.52` | 总时长；段边界按 `dur/9.52` 比例缩放 |
| `--cols/--rows/--cell-w/--cell-h` | `4/12/480/270` | 网格与单格尺寸 |

**★★★ 定位更正（2026-09-14 · 主 agent 实测后改，别被旧说法带偏）**

原稿写「本工具修复采样漏洞（DG-24/25 根因）」—— **不成立**。`--auto-sample` 的实现是
`suggest_sample_points()` 出建议点 → `[t for t in sug if t in frames_by_t]` **过滤已有帧**。
**它变不出没采的帧**，而"采样漏洞"的本质恰恰是**帧压根没采**。
> **实测**：`frames_uimfix` 28 张 → 建议 **39** 点，命中 **15**、**缺失 24**（工具自己打印）。
> 中间 `0.45~5.15` 空窗**依旧存在**。
> **要真修采样漏洞，必须改抽帧脚本的 `times`**（如 `审核员/_独立脚本/l10_uim_frames.js`）。

**DG-24 / DG-25 归因不同，别混为一谈**：

| 缺陷 | 现场 | 真实归因 | 证据 |
|---|---|---|---|
| **DG-24** 入场末帧模块压标题 | `t≈0.40` | **判据覆盖域**问题，**不是采样漏洞** | `frames_uimfix/t0.40.jpg` 与 `frames_base/t0.40.jpg` **两套都采到了**；是数值判据 B4「全片零压叠」只扫 `HOLD_WINDOWS` 定帧窗口、瞬态在窗口外 |
| **DG-25** 卖点行出场期文字整段旋转 | `t≈5.20~5.30` | **确实是采样漏洞** | `frames_base`（29 张稀疏）与 `_frames/new`（37 点均匀，**步长 0.414s**）**都没有**这 0.10s 窗口内的帧 → **步长 > 窗口宽度 = 必然漏检** |

**本次修正的 4 处工具缺陷**（原版实测踩到）：
1. **`nearest_frame()` 是死代码** —— 定义了但无人调用，`make_sheet` 用精确匹配 →
   建议点与实帧差一点就画成空框、**末页大片纯空白**（实测 p2 只有 3/12 格，视觉上像"渲染失败"）。
   已接上并加 `--tolerance`。
2. **命名契约与审核员产出不通** —— 审核员产出 `f_000.png`（时间在 `times.json`），
   而本工具只认 `t*.jpg` 且 `parse_time()` 要求 `t` 开头 → **对审核员产出完全跑不起来**。
   已加 `--times-json`。
3. **缺失点被静默吞掉** —— 过滤后只打印"剩几个点"，用户会误以为"跑过 auto-sample 就没漏洞了"。
   现在**明确打印缺失点清单 + 一句「本工具不采帧」**。
4. **段边界硬编码 L10 魔数** —— 换工程即失效。已按 `--dur` 比例缩放。

**★ 单人验证记录（2026-09-14 · 主 agent 亲眼看图）**：
`_v2_idx.png`（索引模式 6 帧标签全对）· `_v2_uimfix_p01/p02.png`（12 帧/页）·
`_v2_4up_p01.png`（4 列 ×12 行 A/B）。
**视觉铁证**：4up 图 `t=5.20` 那一行，`base`/`uim` 两列是 `[missing]`、`uimfix`/`fix` 两列有画面 ——
同一时刻两套采样一半有帧一半没有；而 `t=0.40` 四列全有 → **DG-24 确实不是采样漏的**。

**⚠️ 已知边界**：
- **缩略图看不清字**（480×270 下 <10px 的字糊）→ 可疑小字要回读原图
- **不是自动审计** —— contact sheet 只把"看"的成本压低，**不替人看**
- `--auto-sample` 的建议点表是**经验规则**（瞬态高发区），不是全量覆盖

---

### 16. 平滑度三判据 + 端到端探针（2026-09-14 新增 · 老板一句「卡顿」逼出来的）

> **它们是什么**：单文件 HTML 动效工程的**"丝不丝滑"验收三件套**。
> **为什么需要**：一条判据不够 ——「速度连续」「没有低速平台」「加速度连续」是**三个独立失效模式**。
> **实证**：只修"速度突变"时，中途停顿**从 101ms 恶化到 204ms**（BUG-2122）——
> 判据① 当时全绿。**缺一条就放过 bug。**

**目标页面的探针契约**（与管线全局规则「全 JS `__frame(t)` 纯函数」一致）：

| 探针 | 必需性 | 说明 |
|---|---|---|
| `window.__pos(t)` | ★ 必需 | 位移**纯函数**（不碰 DOM）—— 密集采样走这个，别用会写 DOM 的 |
| `window.__vel(t)` | 判据③ 需要 | 速度纯函数 |
| `window.__TOTAL()` / `window.__CFG()` | ★ 必需 | 总时长 / `{HOLD, ANT_D, DUR, ...}`（判据②③ 靠它定位枢轴） |
| `window.__ANALYZE()` | 可选 | 页面内自检 → 用于**交叉校验**（两套实现一致才敢信） |

```bash
NODE="node"
export NODE_PATH="./node_modules"   # puppeteer

# ① 三判据（密集采样纯函数 → 数值微分）
"$NODE" kit/motion_smooth.js <html路径> [标签]
# ② 端到端（真实播放 · 逐帧读 DOM transform 矩阵 → 最小二乘拟合 R²）
"$NODE" kit/motion_fps.js <html路径> [--el '#track'] [--btn '#play']
# ③ 面板逐档位扫描（抓"滑块没生效"这类静默失效）
"$NODE" kit/motion_sweep.js <html路径> --sweep kcurve=0,33,66,100 --sweep kant=0,50,100
```

| 判据 | 抓什么 | 通过线 |
|---|---|---|
| ① **收敛性** | 速度突变 | max\|a\| 随 dt 减半应**收敛**；比值 ≈2 = 有突变 |
| ② **中途停顿** | 低速平台 | \|v\|<5%峰值 且被两次运动夹住的时长；**<60ms 看不出来 / >100ms 明显** |
| ③ **枢轴折角** | 加速度不接 | 速度过零两侧 \|a\| 之差 / max\|a\|；**<2% = 斜着穿零无折角** |
| ④ **端到端 R²** | 上面三条在**真实 DOM** 上成不成立 | 枢轴 ±0.07s 内 v(t) 直线拟合 **R² > 0.99** |

**★★ 四条踩过的坑（改判据前必看）**：

1. ⚠️ **别用「逐帧 max\|a\| / 中位」当端到端判据** —— headless rAF **不锁帧**（dt 7~33ms 抖动），
   同一页面实测在 **1.10 ↔ 1.69** 之间反复，**假 FAIL**。
   **正解：对 v(t) 做最小二乘直线拟合看 R²** → 免疫不规则采样。
   （同理：速度/加速度**必须除以 Δt**，直接看"每帧位移"会把采样抖动误读成运动抖动。）
2. ⚠️ **端到端必须真读 DOM**（`getComputedStyle(el).transform` → `new DOMMatrixReadOnly(...).m42`），
   **不能拿纯函数 `__probe(t)` 冒充** —— 那是数学，不是"画面上真的动了"。
   （本工具第一版就犯了这个错，自称端到端实则读模型。）
3. ⚠️ **首帧不许产出速度样本** —— 它没有前一帧，`dt` 等于绝对时间戳（几十万 ms）→
   速度算成 **5 万 px/s** 的垃圾，还会把 `vmax` 和 5% 阈值一起带歪。
4. ⚠️ **采样必须在页面循环复位之前收口**（`t < TOTAL − 0.04`）—— 复位时位移从 −372 跳回 0，
   同样是一帧垃圾速度。

**★ 反例夹具**：`kit/_demo/vertical_push/_legacy.html`（前摇用 `sin(πk)` 的旧实现）。
**任何判据改动后必须拿它复跑** —— 修好的页面三条全绿、夹具必须**明确 FAIL**
（实测夹具：① 比值 2.00 ✗ / ② 101ms ✗ / ③ 折角 100% ✗ / ④ R² 0.63 ✗）。
**区分不了 = 该判据是死代码。**

**★ demo**：`kit/_demo/vertical_push/vertical-push-transition.html`
（两张卡片 + 一条 S 曲线两半 + **速度时间线可视化** + 停顿读数；参数面板可实时看三判据变化）。
截帧脚本 `_shot.js`（按 `__CFG` 的阶段边界自动选帧，别硬编码时间点）。

---

### 17. 出片与版面三件套（2026-09-15 新增 · uvc-seg8 返工轮沉淀）

> 背景：老板两次点名「**跑项目的时候一定要走我们之前固定好的管线还有参考BUG库 不然就是做得一塌糊涂**」
> +「**怎么没有看你当视频总监 派人去做**」。本轮把这套流程固化成可以直接调的标准件，
> **下次不许再从零手搓**（本轮已经重复造过一次轮子：`_textov.js` vs 既有的 `scan_bottom.js`）。

**17.1 `layout_check.js` —— 版面四类客观检查**（通用化自 `voice-axis-scan/scan_bottom.js`）

```
NODE_PATH=<puppeteer node_modules> node kit/layout_check.js \
  --file projects/<proj>/<page>.html --dur 19.0 [--step 0.1] [--fig boardImg] [--subtitle capInner] \
  [--safeT 80] [--safeL 80] [--safeR 1840] [--safeBottom 880] [--hudTop 36] [--clearTop 900]
```
- 查 ① **安全框越界（四边）** ①b **场景图安全框** ①c **字幕净空区**（①b/①c 均 2026-09-15 新增）② **文字 × 文字**两两重叠 ③ **文字 × 场景图**重叠 ④ 同刻屏上文字元素数
- ①c 口径（**2026-09-15 新增**）：规格锁 §2.1 的 `y[900,1080]` **全宽净空**（给字幕让位）——
  **语义是"这一带本来就该是空的"** → 判据必须查**所有有绘制元素**（`canvas`/`img`/`svg`/有底色或边框者），**不分文字与图形**；
  同样只判**静止态**（元素飞过去不算、停在里面才算）。
  - ⚠️ **`--clearTop`(900) 与 `--safeBottom`(880) 是两条不同的线**：880 = 主元素区下界，900 = 净空区起点，**880~900 是缓冲带**。
  - ⚠️ 两处实现坑：① **不能把 SVG 内部图元**（`path`/`rect`/`circle`）当独立元素 —— 绘制由 `<svg>` 代表，
    且 `e.className` 是 `SVGAnimatedString` **对象**（拼进 key 会炸 `reading 'path.[object SVGAnimatedString]'`）；
    ② **豁免要按祖先判（`closest`）**，只判元素自身 id 的话 `#traces` 豁免了、它的 `<path>` 子元素还照报。
  - 🔎 **本判据当场抓到的真缺陷**：`#waveWrap`（波形 `<canvas>`，`inset:0` 铺满）底 = `868+96 = 964px`，
    **静止态压进净空区 64px**（17.4~19s 共 17 个采样点），而旧版 ①（只查文字）+ ①b（只查场景图）**两条都漏** → 一直 0 报错。
    修法 = `#waveWrap top: 868 → 780`（底 **876**，收回主元素区）。
- 全部读**真实渲染**的 `getBoundingClientRect` + **父链 opacity 累乘**；亮判据用 `offsetWidth`（`scale(0)` 隐藏时 rect 塌成 0）
- ⚠️ **`--subtitle` 必填**：字幕本体就在字幕区里，不豁免则安全框检查每次必报 FAIL（口径错）。**本段不产字幕时可传空串**
  - ⚠️ 但 `arg()` 首版写的是 `process.argv[i+1] ? … : def` —— **空串是 falsy**，`--subtitle ""` 被当成"没传"
    悄悄退回默认 `capInner,cap`。**判据参数被静默改写 = 判据口径 ≠ 调用者意图**（与 `--safeT 70 vs 80` 同族）。
    修法 = 用 `!== undefined` 判"有没有传"。
- ⚠️ ③ 是**矩形相交**，会**假阳性**（宽块元素的边与邻元素边相接、字幕框与场景图外框相接都算重叠）→
  **③ 的 WARN 必须人眼复核**；「压住了好不好读」几何判据永远查不出（规格锁 §5.18 / BUG-2159）

**★★ 安全框判据的三条口径（2026-09-15 加固，全是实测踩出来的 —— 详见 §6.20 / BUG-2171~2175）**

| # | 规则 | 反面教材（uvc-seg8 实测） |
|---|---|---|
| **①** | **只判「静止态」**（有效 opacity ≥ 自身峰值×0.95 **且** 相邻采样帧位移 ≤1.0px）。安全框是**构图**约束 —— 管元素「**停在**」哪儿，不管它「**怎么飞过去**」。运动态越界**降级为 `NOTE`，只报不断罪**（不是删掉不报：真出现"元素飞一半停住了"就靠它抓） | `titleQ` 的 `top=71` 出现在 t=3.20 **opacity 0.63**；`psramNum` 的 `75.8` 出现在 t=14.4 **opacity 0.15**，**静止后 100.7** |
| **②** | **「盒」有三层，判据取最里面那层（墨迹）**：**元素盒** → **行盒** → **墨迹**。有底/有框的元素（药丸）用元素盒；无底无框的宽容器（`width:1920px` 的全宽文字）换算到**字形墨迹** | `titleQ` 100px 字：元素盒 78 / 行盒 **71** / 墨迹 **100**（差 **29px**）→ 按行盒判**必假 FAIL** |
| **③** | **场景图不套静止态过滤，报全程极值** —— 相机一直在动、"静止态"可能不存在；产品图的构图约束本来就要求**全程**成立。可见性同样按**有效 opacity** 判（否则"有尺寸但全透明"的帧会被算进来） | 板图 **4.7~11.9s 每个可见帧都越界**（顶越 72px / 底越 142px，深进字幕净空区 122px），而旧版 ① 只遍历 `TEXT_IDS`、**场景图一个字都没查** |

- ⚠️⚠️ **判据的默认参数必须逐字照抄规格锁**，并在代码注释里**写明出处**。首版 `--safeT` 默认写成 **70**（规格锁 §2.1 是 **`y[80,880]`**）→ **比规格松 10px = 放水式静默假 PASS**（`psramNum` top=76 在 70 口径下判 PASS、真口径下 FAIL）。**判据默认值 ≠ 规格 = 静默假 PASS。**
- ⚠️ **HUD 层 `y[36,140]`** 与主元素区**并存**，但**只对 DOM 上显式声明 `data-hud="1"` 的元素生效** —— **不许**做"看着像 HUD 就算 HUD"的推断，否则这个参数会退化成万能逃生门。
- **求真值只用像素差分**（`_ink.js` 演示）：同刻同页、**只把目标元素 `visibility:hidden`**，两帧逐像素差 → 差异像素集合就是**真实绘制墨迹**（免疫栅格背景/辉光等一切底图）。
  ⚠️ 陷阱：`__frame(t)` 每帧都会重写 opacity → 必须**先 `__frame(t)` 定住画面、再隐藏、之后不许再调 `__frame`**，否则隐藏被覆盖、差分恒为 0（**假 PASS**）。
- **判据落地换算（行盒 → 墨迹）**：
  `baselineY = 行盒top + (行盒高 − (fontBoundingBoxAscent+fontBoundingBoxDescent))/2 + fontBoundingBoxAscent`；
  `inkTop = baselineY − actualBoundingBoxAscent`；`inkBottom = baselineY + actualBoundingBoxDescent`。
  ⚠️ 容器内若有**块级子元素**，`Range.selectNodeContents(e)` 返回的是**子块的盒**（宽 1920）→ 必须用 **TreeWalker 逐个文本节点**量。

**17.2 `contrast_check.js` —— 文字对比度客观检查**（本轮新建）

```
node kit/contrast_check.js --file <page>.html --dur 19.0 [--step 0.25] [--jobs jobs.json]
```
- 口径三条：**底色从帧里实测 + 字色读 CSS 声明值 + 带 alpha 先与底合成**
- **选底规则（关键）**：底色 = 「**远离字色亮度的那一侧**」—— 字亮 → 取暗簇（最暗 40% 均值）；
  字暗（深字压亮药丸）→ 取亮簇。⚠️ **不许"取两口径较小值"**：字框紧、字形占多数时众数色＝字色 →
  会把字色当底色，量出 **1.01** 假 FAIL（BUG-2160 补记）。众数色**降级为交叉校验**（分歧大 → `CHECK` 交人眼）
- 阈值：字号 ≥24px（或 ≥18.66px 粗体）= 大字 → 3.0；否则 → 4.5。`--floor` 默认 **1.10**（余量 <10% 才算贴地板线）
- 取样时刻**由元素自己给出**：不传 `--jobs` 时自动枚举全部含文字元素，扫时间轴取各自**有效 opacity 峰值**
  （BUG-2161：给 `.fps` 填错时刻 → 裁到空图 → 假 FAIL 1.14）
- ⚠️ **对高频花底（板子丝印/走线/照片）会给偏乐观的数** → 压在位图上的文字**必须人眼看观众尺度整幅帧**

**17.3 `_render.js` + `_verify_pair.py` —— 出片与双版本校验**

```
node _render.js                                  # puppeteer 逐帧 ?t=0 + __frame(t) + 双 rAF
ffmpeg -framerate 30 -i _frames/f%05d.png -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p -r 30 _v.mp4
ffmpeg -i _v.mp4 -i voice_p.wav -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 192k ... _nosfx.mp4
ffmpeg -i _v.mp4 -i mix.wav     -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 192k ... _sfx.mp4
python _verify_pair.py                            # 12 条判据 · 必须跑两遍
```
- **输入依赖**（脚本顶部 `need()` 前置检查 · 缺件打印修复命令 + `exit 3`）：
  `mix.wav` · `voice_p.wav` · **`_cues_resolved.json`**（由 `_sfx_mix.py` 生成，是 **`[E]` 双链校验的唯一输入**）
- ⚠️ **清理时别把 `_cues_resolved.json` 当"一次性中间数据"删掉**（BUG-2169）—— 判"能不能删"**只能查引用闭包**：
  `grep -l "<文件名>" *.py *.js`，命中保留脚本的一律留；真要删先确认「生成它的命令还在 **且确定性**」
  （实测 `_sfx_mix.py` 重跑 → `mix.wav` md5 一字不变）
- **双版本铁律**：画面只渲一次 → `-c:v copy` 分发两条音轨 → **framemd5 逐帧差异必须 = 0**
- ⚠️ 逐帧渲染**直接覆盖同名帧**即可（`f%05d.png` 编号连续时不需要删目录；`rm -rf` 会撞批量删除护栏 >1000 文件）
- ⚠️ `-shortest` 会把人声比视频短的版本截帧（19.0s 视频 + 18.4s 人声 → **550/570 帧**）→ 人声 `apad=whole_dur=`
- ⚠️ 人声进混音前必须留余量：`loudnorm=I=-14:TP=-2.8`（**坚持不压音效**，让音效按「人声峰 − 9dB」定位）

**17.4 音效贴点（`_beats.js` + `sfx_cues.json` + `_sfx_mix.py`）** —— 全文工艺见 skill `sfx-cue-placement`
- 三探针量节拍：**可见窗口**（`_beats.js`）· **速度剖面撞击拐点** · **相机世界速度**
- ⚠️ 速度只能在**可见窗口内部**算，窗口首尾各剔 3 帧 —— 否则 `display` 切换的 rect 跳变会被读成 **66236px/s 假速度峰**
- ⚠️ 靠 `scale(0)` 隐藏的元素 rect 塌成 0 → 可见判据用「**父链累乘 opacity × offsetWidth**」
- ⚠️ **`amix weights=1 -1` 在 filter_complex 里空格会被吃掉** → 变成相加 → 双链校验**恒真假 PASS**
  → 用 `aeval='-val(0)|-val(1)'` 反相 + `amix`（ffmpeg 8.1.2 无 `asubtract`），并**补反例判据**（无音效段须 ≤ −40dB）
- ⚠️ `atempo` 作用在 **40ms** 极短素材上输出 **0 帧** → 计数 tick 改为换不同短音原样使用

**17.5 单文件 HTML 组装 `_build.py`** —— `part1.html`(CSS+DOM) + `camera3d.js` + `part2.js` + 板图 base64 + **复用原音频 data URI**
- ⚠️ 校验占位符时注意 **`__B64_AUDIO__` 在 `part2.js` 里，不在 `part1.html`**
- ⚠️ **`var` 提升会静默算错**：常量定义必须在使用之前（本轮 `kdimp` 第 187 行用、第 223 行定义 →
  首帧 `NaN` 被 CSS 静默忽略、之后读上一帧值 → **整个"收尾压暗"设计全程没生效**，BUG-2163）

**17.6 ★★ 「把产品缩进安全框」标准做法**（2026-09-15 新增 · BUG-2175 / 2176）
> 触发场景：老板说「**画面的安全框距离 你这个应该超出了**」/「**把你的产品缩小一点**」/「**文字叠在产品上方看不清**」。
> 三个症状常常**一个根因**：**产品图太大**（板图占 82% 画面高 → 文字只能压板上 → 也没地方放栅格背景）。

**五步，别跳**：
1. **先量**：产品图的 `getBoundingClientRect` 逐 0.05s 扫全程（判可见用**有效 opacity 累乘**，`rect` 塌成 0 的帧要排除）→ 得到 `T min` / `B max` / `L min` / `R max` 与**越界帧占比**。
   ⚠️ 不能只看静止帧就动手 —— 约束上限**往往由"产品特写段"钉死**（uvc-seg8：特写 s≈0.937、静止段 s≈0.843，**静止段只能到特写的九成**）。
2. **认清坐标系是"混的"**：产品图在世界坐标系（`#camera > #world > .l3d`）、标签/名牌/角标在**屏幕坐标系**（`proj()` 或硬编码 `960±…`）。
3. **缩小只做两件事**，缺一出错：
   - 产品图的世界坐标**同步乘缩放**（`CHIP={x:-29·BK, y:82·BK}`）—— 否则 `proj()` 还是旧坐标，**标签与产品分家**；
   - 缩放挂在**层的 transform** 上（`translate3d(…,BOY,0) scale(BK)`）—— 产品与它的接地阴影一起缩，**屏幕层标签不受影响、自动落到产品外的背景上**（正好是老板要的"文字放在背景层上方"）。
   ⚠️ `translate3d` 写在 `scale` **之前** → 位移就是**世界坐标**量，不必换算屏幕 px。
4. **联合寻优**（别手调、别"求可行区间取中点"）：在 `(BK, BOY)` 网格上**直接算真实极值**，取「`T ≥ 安全框上界+8px` 且 `B ≤ 安全框下界−8px`」下的最大 `BK`。
   ⚠️ 取中点是"看起来保守"的假动作，实测会把边界推到**越界 1.3px**；⚠️ **输出量是"相对当前 build 的增量"还是绝对值必须分清**（踩过：把增量当绝对值 → 整体偏移 43px、**底越 20.3px**，预测 88.9 / 实测 132.2）。
5. **复量三件套**：产品图全程极值（越界帧要 **0**）+ `layout_check.js` ①/①b + **人眼看稳态帧**。

**★ 一石三鸟的连带收益**（uvc-seg8 实测）：板图 1450→**1077**（世界尺寸）后
① 接口标签从板上落到深色背景 → 压产品比 **88.2% → 13.9%**；② **栅格背景终于看得见**了；③ 对比度 `MIPI CSI` **10.79** / `摄像头` **17.37**。


---

### 17.7 ★★ 跨工程规格统一（2026-09-15 新增 · 老板「这个要统一」的标准做法）

> 触发：老板说「**XX 是从副手那里做出来的，这个要统一**」/ 多段共用一套视觉基底（配色 / 玻璃 / 底纹 / 网格）。
> 反例（本轮真踩）：我上一版把栅格的 **CSS 规格逐字复用了**，就认为"统一了"。
> 但兄弟段那层栅格**是在极缓漂移的**，我的是静止的 → **规格对齐了、行为没对齐**，
> 两条片子放一起，一条背景是活的、一条是死的。老板要的"统一"包含**行为**，不只是**声明**。

**三步，别跳**：

1. **先定位基准工程 + 它的确切参数**（不是"大概"）——
   把基准的 ① CSS 变量表 ② 关键 DOM 层级 ③ **驱动它的 JS** 三样一起读出来。
   ⚠️ 只读 CSS 会漏掉全部运行时行为（漂移 / 呼吸 / 抖动 / 视差都在 JS 里）。
2. **做并排核对表，分两栏** —— 只写 ✅/❌，**不许"我加了所以统一了"的自我认证**：

   | 项 | 本工程 | 基准 | 声明 | 行为 |
   |---|---|---|---|---|
   | 配色 `:root` | 15 变量逐字同 | 基准 | ✅ | — |
   | 玻璃基底渐变 | 同 | 同 | ✅ | — |
   | 栅格规格 | 64px/1px/`--hair`/`.55`/`inset:-64px` | 同 | ✅ | — |
   | **栅格漂移** | `sin(t*.062)*11` 取半额 | 同 | — | ✅（上一版 ❌） |
   | **栅格层级** | `#screen` 直接子级 | `#stage` 直接子级 | ✅ | — |

   > 「声明」= CSS/结构；「行为」= JS 每帧驱动。**两栏都必须有值才算统一。**
3. **补行为后必须上探针**（不许肉眼看"好像动了"）：

   ```
   NODE_PATH=<puppeteer> node _grid.js
   # ① 页面 0 pageerror  ② 真实渲染位置随 t 变（唯一位置数 >10）
   # ③ 幅度 ≤ 上限      ④ offsetParent 不是 perspective 容器
   # ⑤ 藏掉本层后 #camera 子元素投影逐帧零变化（同心 G3 未被破坏）
   ```

#### ★ 栅格底纹（`#bgGrid`）标准规格 —— 跨段共用，逐字照抄

```css
#bgGrid{position:absolute;inset:-64px;pointer-events:none;will-change:transform;
  background-image:linear-gradient(var(--hair) 1px,transparent 1px),
                   linear-gradient(90deg,var(--hair) 1px,transparent 1px);
  background-size:64px 64px;opacity:.55;}
```
```js
/* __frame(t) 内 · 逐字照抄 */
var gdx=Math.sin(t*0.062)*11, gdy=Math.cos(t*0.047)*8;
el.bgGrid.style.transform='translate('+(gdx*0.5).toFixed(2)+'px,'+(gdy*0.5).toFixed(2)+'px)';
```

**三条硬约束**：

| # | 约束 | 为什么 |
|---|---|---|
| ① | **挂在相机 perspective 容器的"兄弟级"**，不是它的子级 | 父容器每帧 `perspective` 都在变；挂在它底下等于把本层的失效范围交给父层决定。基准工程本来就是兄弟级，**结构对齐比"能跑就行"重要** |
| ② | **3D 子树内的栅格不许加 2D 漂移** | `#innerGrid` / `#traces` 在 `#camera` 里、是 3D 内容的一部分，加屏幕空间漂移会破坏「多副本同心」（规格锁 §5.16.8 G3）。**只有 3D 子树之外的环境层才配漂** |
| ③ | **漂移幅度 ≤ `inset` 的 1/10** | 本处 `inset:-64px` vs 半额漂移 ≤5.5px → 余量 **11.6×**，**绝不露边** |

**★ 为什么"取半额"**：栅格是最背景层，离相机最远 → 视差量必须最小；**全额**留给 mesh 那类中景层
（基准工程 `#bgMesh`/`#bgHot` 用全额 `±11/±8`）。⚠️ 这不是美学偏好，是**深度线索的自洽**：
背景层漂得比中景层多，观众的深度感会崩。

**★ 副作用说明（性能，实测）**：栅格**必须留在 3D 子树之外** —— 留在里面，每帧层 transform 变化都会让它
重新栅格化整屏重复渐变，实测占 4K 渲染总耗时 **27%**（关闭后 1796→1320 ms/帧）。
移到子树外 → 独立合成层、纹理被缓存，自己只用 2D `translate` 漂移，**成本≈0**（这也是基准工程的做法，不是我的发明）。

**★ 为什么这一层值得存在**（不止是"好看"）：
整屏有一处极缓的呼吸，人眼读不到"在动"，但画面不会被大脑判成「静止帧」——
是**防 PPT 感**的一环（规格锁 §5.11：视觉状态每 2-4s 必变）。
周期取 `~101s` / `~134s`，**比整片长 5 倍以上** → 全程单向极缓，看不出往复。

---

### 17.8 ★★ 「转场只做一次」（2026-09-15 新增 · 老板「你弄了两个…你不用做两个」）

> 触发：一段画面里出现**连续两次画面变化**（黑掉→亮起来 / 擦出→擦入 / 推进→拉回）。

**核心判据：一个「转场」用了几个元素 / 几段动作，观众就看到几次切换。**
反例（本轮真踩）：11s 处我用 `#irisGrow`（黑圆 0→1400 吞屏）+ `#irisShrink`（1400→0 揭开）
**两个元素**做了一吞一张，中间还夹 0.35s 全黑，12.30 起又叠了相机 `zoom 9000→13680 + roll:-2`
→ 老板看到的「**你弄了两个**」。

**★ 正解不是把两段做得更平滑，而是让第二段消失。**

#### 手法：把第二段动作藏进第一段的遮挡物里

| 步 | 做什么 | 为什么 |
|---|---|---|
| 1 | 让第一段动作（遮罩 / 黑幕）**扩到盖满屏**再结束 | 盖满之后，下面发生什么都看不见 |
| 2 | **把第二段动作（相机推近 / 图层替换）整段挪进「已盖满」的区间内** | 观众看不见 → 它不再是"可见的转场" |
| 3 | 遮罩**撤除那一刻** = 新画面**已经在位** | 观众直接看到下一画面 |

**⚠️ 关键：第二段必须在「遮挡物盖满」之后才开始。**
覆盖判据：**遮挡半径 > 屏幕对角线半长**（1920×1080 → `√(1920²+1080²)/2 ≈ 1102px`）。
本轮实测：11.55 时圆半径仅 **378px** → 此时推近，观众会在**黑圆四角外**看见板图飞出去 = 又成一个可见动作；
12.00 时半径 **1188px > 1102** → 已全黑 → 才允许推近。
→ 所以 **11.55→12.00 机位刻意保持不动**（TRACK 里写两条**同值**关键帧）。

#### ⚠️ 判据怎么写（两条坑）

1. **不许硬编码「第二段从哪一刻开始」** —— 那是实现的常量，写死等于**复制实现**（§7.1 第 7 条）。
   正解：**逐帧比对「它是否在动」，再拿「在动那一刻的遮挡半径」去判**。
2. **判「在动」必须先定义「动多少才算动」** —— 逐帧差分（`|Δ|>0.5`）对**任何连续运动都返回真**，
   会把段尾的匀速巡航（100ms 内 `cz` 只走 3.6px）误判成"转场推近" → **假 FAIL**。
   正解：**100ms 窗口 + 只盯量级运动**（推近级：100ms 内 zoom 变化 >300）。

#### 落地代码（`projects/uvc-seg8`）

```js
var g=el.irisG;
if(t<T.irisCut){
 g.style.display='block';
 g.style.clipPath='circle('+(1400*eio2(c01(t,T.iris[0],T.iris[1]))).toFixed(1)+'px at 960px 540px)';
}else{g.style.display='none';}
```
配套 TRACK（相机）——**12.00 那条不是"第 11 个机位"，是"推近的起点"**：
```js
{t:11.55,x:-29,y:82,z:380,px:-29,py:82,pz:0,zoom:2050,ease:'lin'},   /* 保持不动 */
{t:12.00,x:-29,y:82,z:380,px:-29,py:82,pz:0,zoom:2050,ease:'eio'},   /* 同值，标记推近起点 */
{t:12.30,x:0,y:0,z:120,px:0,py:0,pz:-600,zoom:13680,roll:0,ease:'eio'}, /* 推近完成 */
```
> 四铁律 ②「相邻集群错峰 ≥0.4s」不受影响：12.00 与 12.30 是**同一次运动**的起止点，且全程被遮 → **不计入集群**。

#### ⚠️ 连带坑：图层切换要选在「遮挡已生效」的时刻

图层切换（旧层 `display:none` / 新层 `display:block`）**必须发生在遮挡盖满之后**。
本轮：切换点从 11.95（吞屏中途）推到 12.30（吞屏结束）后，旧层的**"可见窗口"变长**，
它在 12.00–12.30 的推近中被推出安全框（下缘 **901px**、越字幕净空区 1px）——
**观众看不见**（全黑），**但判据看得见**：`layout_check.js` ①b/①c 只读几何 + `display`，
**不理解「这个元素此刻被上层不透明遮罩盖住了」**。
→ 正解：把切换点**提前到「盖满那一刻」（12.00）**，让被测量在**可见期内**不越界。
→ **不要给判据开"遮挡豁免"** —— 那个口子会把**真的越界**一起放走；**判据放宽不可逆，改画面可验证**。（BUG-2187）

**双证**：`layout_check.js` ①b 回到 **0/112 越界** + `_iris.js` 判据 ⑧ 改为「切层时半径必须 > 1102」。

#### ★ 「遮挡是不是真的盖住了」怎么验（像素级，别靠推理）

我第一版**推**「12.00–12.30 全黑 → 切换不可见 → 成片逐帧不变」，**被实测推翻** —— 重渲后视频流 md5 从 `9f09c3765abb` 变成 `3d88b321921d`。
**实测法**：抽帧统计「与黑幕色（`#080d14`）的偏差 > 12 的像素占比」：

```python
im = np.array(Image.open(frame).convert('RGB')).astype(int)
d  = np.abs(im - np.array([8,13,20])).max(axis=2)
nonbg = (d > 12).sum()          # 非黑幕像素数
```

结果：12.05 / 12.10 / 12.20 三帧非黑幕像素都只有 **≈390px（0.11%）** → **黑幕确实盖满**（那 390px 是中心那个金点）。
**那 md5 为什么会变？** —— 因为**相机轨迹改了**（旧版 11.55→12.30 是 `zoom 2050→9000` 的缓推，新版是 `2050→13680` 的猛推），
而**金点 `#goldDot` 的 DOM 位置在 `#irisGrow` 之上**（所以它不被黑幕遮），它的屏幕坐标随相机走 → **逐帧画面真的不同**。
→ 实测金点位移：12.01→12.25 共 **83px**、平滑无跳变（增量 2.5 / 7.6 / 41.8 / 17.8 / 12.5）→ 观感是"被吞进去时光点还在"，可接受。
**★ 教训：遮挡关系要用像素验，不能用推理定；而"md5 变了"也未必是坏事 —— 要能说清变在哪。**

#### ⚠️⚠️ 写复核探针前：**先复刻渲染脚本的前置步骤**（BUG-2188 · 2026-09-15 第三次中招）

**事故**：全绿验收后抽帧复核，看到「全黑之下切层」的 12.28s **不是全黑**（`--bg0/--bg1` 底 + 栅格 + 金点），
判定「**黑幕在相机推近后失效**」→ 写探针去查 → **结论是错的**。两个假象，全在测量方法上：

| 假象 | 真因 | 修法 |
|---|---|---|
| 「12.28 不是全黑」 | **`-ss` 有 1 帧取整误差**：`-ss 12.28` 实取**帧 369（12.3000）**，而撤幕正好在 369 | 对轴用**帧号**：`-vf "select=eq(n\,N)"` |
| 「实时 HTML 与成片分叉」 | **探针没复刻 `_render.js` 的前置步骤** → **量到的是开始遮罩 `#startOv`**：所有帧都返回 98~99.8% 近黑（连 t=3.33 盘面正常那帧也是 **98.1%**） | 逐字复刻下面五步 |

**`_render.js` 的前置步骤清单（探针必须逐字复用，少一步都不行）**：
1. `goto('file://…/x.html?t=0', {waitUntil:'networkidle0'})` —— **带 `?t=0`**
2. `await sleep(2500)` —— 等字体/资源就绪
3. **`document.getElementById('startOv').style.display='none'`** —— **隐藏开始遮罩**（★ 最容易漏）
4. 每个采样点：`__frame(t)` → **`await 两次 requestAnimationFrame`**（等绘制提交）→ 再截图
5. 截图裁剪 `clip:{x:0,y:0,width:1920,height:1080}`

**★★ 两条元规则**：
- **探针要量的若是"渲染出来的画面"，就必须复用"渲染脚本的驱动方式"** ——
  少一步就会量到**另一个东西**，而且**结果看起来完全合理**（98% 近黑读成"分叉"毫无违和感）。
- **先做零假设检验再下结论**：拿一个**已知正确的帧**（这里是 t=3.33 的盘面）去验**测量链路本身**。
  本轮正是这一步把结论翻了过来 —— **假警报比漏报更贵**（为两个假象写了两份探针、抽了 30+ 帧、绕了 4 轮）。

**修正后的真值（实时 HTML ‖ 成片，10/10 帧一致）**：
帧 100 `4.7%/8.8%` · 300 `9.1%/13.6%` · 364/366/368 两侧均 **99.9%**（盖满）· **369 骤降 `0.1%/0.8%`**（撤幕）· 370/372/500/560 低位。

---

### 18. 内容量扫描 `content_scan.py`（2026-09-15 新增 · 为「简化检测流程」做的核心工具）

**作用**：把「哪一段没内容 / 哪一段最该盯」变成**一条命令给出区间列表 + ASCII 趋势条**，
替代「盲抽 12 帧用肉眼看」—— **人眼 Read 预算只花在它指出的帧上**。
⚠️ **它只做「定位」，不做「判决」**；判决仍必须人眼 Read 指定帧。

```bash
python kit/content_scan.py \
  --video <mp4> [--ref <母版mp4>] [--fps 30] [--width 480] [--json out.json] [--keep-tmp]
# 退出码 0 正常 / 1 缺依赖或输入不存在（fail fast）/ 2 参数错
```

**两条一维信号**（必须同时命中才算谷底）：
- **LAP** = 拉普拉斯方差（边缘锐度能量）—— 柔和渐变/云底低，文字/卡片/产品图高
- **EDGE%** = 强边像素占比（`|∇|>18`）
两量**同时** ≤ 各自 P10 ⇒ 判「谷底」。为什么两个：背景的太阳有硬边、云有软边，单量会被干扰。

**三类谷底**（`deep_gaps()`）：`★显著` = 长度 ≥3 帧 或 `min LAP ≤ 0.5×P10`；其余记 `噪声`。
→ 防「P10 阈值本身切出一堆 1~2 帧、LAP 恰好骑在阈值上的抖动」被当成空窗。

**`--ref` 对照（本工具的关键设计）**：只看自己的谷底 = 会把**继承基线**当新 bug 报，或把新 bug 当老问题放过。
两条片时长常不同 ⇒ **必须 DTW 按信号自身对齐**，自动分「继承基线 / 待核」。
输出的**对齐质量自检**（平均斜率 vs 时长比、路径单调性）要一起看。

**⚠️ 三个已踩的坑（判据口径错，不是算法错 —— 改回去就白干）**

1. **对齐口径**：帧号对齐 ✗（时长不同必然错位）· 归一化时间对齐 ✗（**实测仍错**：en 7.80s → zh 6.60s，真值 6.13s ⇒ 假「本版新引入」）· **DTW ✔**（自动复现人工结论）。
2. **DTW 带宽**：写 `|i−j| ≤ band` ⇒ 时长不等时**终点被排除在带外、整条路径不存在、DTW 直接失败**。
   ⇒ 必须**围绕期望对角线 `j ≈ i·nb/na`** 取带。
3. **判定条件**：用「B 窗内低内容占比 ≥50%」⇒ 垫 ±2 帧 padding 后**真谷底 5/11 = 45.5% 被顶出区间** ⇒ **判据自己制造假「待核」**。
   ⇒ 改成「B 侧**显著谷底**与映射窗相交」，**不设占比阈值**。

**实测参考（en3 vs 中文段3 · 2026-09-15）**：en3 显著谷底 5 条，**4 条继承基线**，唯一「待核」= `t=11.83~11.87`（2 帧）
→ 人眼核 = **交叉溶解中的 2 帧低内容、非空洞** ⇒ 判定 **en3 未引入新空洞**。390 帧全扫 < 1 分钟。

**⚠️ 已知边界（`kit` 级 · 2026-09-15 定 · 别去修它）**
- **生产渲染不逐帧可复现**：同源重渲约 **50%** 帧的 PNG md5 不同（`170/340 · 178/340`），
  但**量级只有 1~2 灰阶 / 有差像素 ≤0.001% / `Δ>2` 像素 = 0**。
  机制 = **跨帧锁存（迟滞）**：像素会带上**前序帧的残留** ⇒ 差异只出现在**后段**（旧版 139 起 / 新版 145 起）。
  并发是**放大因素**、不是唯一来源（串行两遍 `0/24` 不同 · 并发两遍 `2/24` · 串行 vs 并发 `3/24`）。
- ⇒ 证明「画面零改动 / 画面没变」**只能**用 ① 结构级（`driveScene` 逐字节哈希，**必须写口径**）
  ② PNG 截图层 + **同版本抖动基线**。**绝不能用「重渲一遍比像素」或「比 mp4」**（`framemd5` 三方对撞 = 恒假 FAIL）。
  详见 `BUG-总回归库.md` **BUG-2206**。
- ⇒ **不立「两次渲染逐帧一致」这条门，也不改 `kit/render-core.js`** ——
  若真要立，**先得给 `render-core.js` 定「渲染时禁止跨帧锁存」约束**；但本门**没人需要**（正确口径已是结构级），
  而改 `render-core.js` 会影响 **20+ 个在跑工程** ⇒ 风险 > 收益。**记录为已知边界，不动代码。**

---

## 验收记录（2026-09-09）

- `probe()` 实测：`{"width":1920,"height":1080,"fps":30,"numberOfFrames":150}` ✓
- 渲染：`_smoketest/components_showcase.mp4`，ffprobe 实测 h264 / 1920×1080 / 30fps /
  151 帧 / 5.03s / 1.43 MB ✓（渲染命令见任务说明，21~25s 出片）
- 截帧肉眼审判：帧 0 / 30 / 45 / 60 / 90 / 105 / 120 / 150 + 4 张局部放大，逐帧结论见交付报告。
- 审判中修掉的两个问题：
  1. `.sw` 白字压在 WHITE/YELLOW 浅色块上看不清 → 增加 `--sw-tc` 字色变量 + `.sw.light` 变体；
  2. demo 的 `.fx-vignette` `--op:.85` 把画面最右列（ORANGE 色板、DISPLAY 节点）压得发闷 → 降到 .55。

## demo 再生成

```bash
node _demo/build.js    # 读取 ../fx-runtime.js + ../fx-components.css，注入模板落盘
```
demo 永远内联 kit 下的实际交付文件，不会漂移；改了库文件后重跑 build + render 即可回归。

---

## UIP · UI 风 MG 驱动包（2026-09-09 新增）

配套文件：`fx-uipack.js`（window.UIP，**22 成员**）+ `fx-uipack.css`（.ui-* 组件样式 + 17 个 `.fx-post-*` 后期层）。
**来源**：从本机动效配方库（531 条 CSS keyframes 配方）与一份社区教程复刻草稿转译——配方保留、机制换成 `__frame(t)` 纯函数（CSS animation 无法逐帧截图，禁止直接搬）。

```js
UIP.flowBorder(el,t,on,speed)  // conic 流光边框；el=.ui-fb 覆盖层，写 --ang
UIP.drawPath(el,t,t0,d)        // SVG path 描线（stroke-dashoffset，自动缓存总长）
UIP.tick(el,t,t0,d)            // 对勾勾选（drawPath 简装版，d 缺省 .35）
UIP.typing(el,t,on)            // IM「输入中」三点；el 内 3 个 <i>，sin 位移非 opacity 闪
UIP.toast(el,t,tIn,tOut,y)     // 系统通知横幅：下滑+spring 回稳+到点收回
UIP.pkt(t,pts,loop,phase)      // 数据包沿点列 pts=[[x,y],...] 流动 → 返回 {x,y}
UIP.pulse(el,t,t0,period,on)   // 脉冲环扩散；el 子元素逐环 scale+fade
UIP.wave(g,t,opts)             // canvas 频谱条；opts {n,w,h,color,alpha,rainbow}
UIP.breathe(el,t,amp,freq)     // 呼吸（LIVE 红点/徽标微闪）scale+opacity 正弦
```

用法要点：
- `.ui-fb` 流光边框要**套在目标卡内侧**（`<div class="card" style="position:relative;border-radius:20px">` 里放 `<div class="ui-fb"></div>`），on 用 seg/env 窗口驱动显隐。
- `drawPath` 的 `<path>` 最好加 `pathLength="1"`，d 用秒；`t<t0` 整条隐藏（dashoffset=L）。
- `pkt` 只算坐标不碰 DOM：canvas 直接画；DOM 圆点则 `el.style.left/top`。
- 组件样式分段在 `fx-uipack.css`：.ui-fb / .ui-panel(.ui-chrome 三点+.ui-crumb) / .ui-chip / .ui-toast / .ui-dots / .ui-row(cb 对勾行) / .ui-node(hot 橙光) / .ui-avatar / .ui-badge。
- 首个落地工程：`video-style-lab/projects/mingong/fx_mingong_mg.html`（明动 30s UI 风 MG 16:9）。

---

## UIP3D · 3D 骨架 Cluster UI 母题（2026-09-10 新增）

> 3D 模式（`--mode 3d`）用的卡片母题，定义在 **`templates/skeleton3d.html`**（不在 `fx-components.css`）。
> 7 段共享同一套视觉语言，**改一处全局生效**。落地工程：明动 V4 `mingong3d_v4/`。

| 类名 | 用途 | 关键样式 |
|---|---|---|
| `.b-card` | 集群主卡（flex 纵向居中 + 深玻璃底） | 宽度 100% 撑满 layer，内边距 + 圆角 + 边框 |
| `.b-live` | 左上「LIVE」红点徽标 | 小圆点 + 脉冲（配 `UIP.breathe`） |
| `.b-mark` / `.b-logo-mark` | 品牌标识（MDoing） | 大字重 + 品牌色（绿 `#2ed3a7`） |
| `.b-tag` | 顶部小标签（英文大写 + 字距） | 22px / `#B5C2DC` / letter-spacing .08em |
| `.b-tag-bt` / `.b-tag-rf` | 双色对撞标签（蓝牙蓝 / 小无线橙） | 蓝 `#58adea` / 橙 `#ef9c42` |
| `.b-tile` | 并列模块卡（蓝 / 橙两版） | 内含 `.b-icon` / `.b-name` / `.b-eng` |
| `.b-cap-list` / `.b-cap` | 编号能力列表（01/02/03） | `.b-num` 序号 + `.b-name` 名称 |
| `.b-net` | SVG 星型拓扑（主机 + N 设备） | `.b-net-hub` / `.b-net-node` / `.b-net-line` |
| `.b-cust-row` / `.b-bubble` / `.b-avatar` | 客户对话卡（头像 + 气泡） | gold 头像 `#ebcc75` |
| `.b-meta` | 卡片底部副标说明 | **22px `#B5C2DC`**（⚠️ 原 `#8FA0BE` 在深底 CR=1.62 违规） |
| `.g-floor` / `.g-back` / `.g-pool` | 场景装饰（地面 / 背板 / 光池） | `fixed` 图层常驻，不受窗口控制 |

**⚠️ 3D 专属约束（与 2D 组件最大的不同）**

1. **`.b-*` 元素只能出现在叶子节点** —— 3D 链上 opacity/filter 会拍平子树（BUG-2005）
2. **`.b-card` 是 layer 的直接子元素** —— `driveStagger` 会往里钻一层拿它的子元素做错峰
3. **副标/小字禁用中性灰** —— 深玻璃底上 `#8FA0BE` 实测 CR=1.62，一律用 `#B5C2DC`（详见 `版式设计笔记.md` §13）

**元素级动效字段**（写在 `spec.layers[]`，骨架 `baseTransform/driveStagger` 消费）：
`pop` `breathe` `breathHz` `drift` `driftHz` `sway` `swayHz` `stagger` `staggerGap` `staggerRise`
—— 锁死值见 `语音转动画-规格锁.md` §5.10。
