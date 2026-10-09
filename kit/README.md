# kit · 「语音转动画」管线工具箱

```
kit/
├─ check_env.js                ★ 环境自检（**clone 后第一条命令**：缺什么 + 每条安装命令 + 中文字体实渲染检测。
│                                加 `--install` 可让它替你装 —— 先出计划，`--install --yes` 才真动手）
├─ env-paths.js                外部依赖候选路径**唯一真源**（Chrome / ffmpeg / puppeteer-core · 三平台）
├─ render-core.js              渲染核心（puppeteer 逐帧 + ffmpeg 合成）· **4K 默认开启**
├─ export-engine.js            ★ 导出引擎（取帧唯一真源 · 三档 safe/fast/legacy · 尺寸自证）
├─ boxchk.js                   安全框自检（含**坐标系自检**，视口错配时输出 N/A）
├─ layout_check.js             版面检查 ①四边/①b场景图/①c字幕净空/②重叠/④元素数
├─ new_project.js              ★ 脚手架生成器（本页主角，支持 --mode 2d / 3d）
├─ fx-runtime.js               运行时（window.FX，元素优先契约）
├─ fx-components.css           组件样式
├─ camera3d.js                 ★ 3D 摄影机 · 几何层（lookAt / 矩阵 / 轨道采样 / DOF / shake 双层）
├─ camera-lens.js              ★ 3D 摄影机 · 光学层（7 支镜头 + 11 套胶片模拟 + 薄透镜 CoC）
├─ camera-shots.js             ★ 3D 摄影机 · 配方层（14 个可链式运镜配方）
├─ daily_archive.js            ★ 每日归档守卫（防总文档断档，老板 2026-09-10 立）
├─ check_wording.js            ★ 动画描述词校验器（写分镜时用，配套 animation-description skill）
├─ templates/
│  ├─ skeleton.html            HTML 骨架模板（2D，{{TOKEN}} 占位）
│  ├─ skeleton3d.html          ★ 3D 骨架模板（screen→viewport→camera→world + .b-* Cluster UI）
│  ├─ spec.example.json        分镜表样例（2D，可直接跑）
│  ├─ spec.3d.example.json     ★ 分镜表样例（3D，可直接跑）
│  ├─ fx-runtime.fallback.js   DEPRECATED · 与正式版同签名的兜底（别删）
│  └─ fx-components.fallback.css  DEPRECATED · 同上
└─ README.md
```

> **3D 摄影机三件套**（2026-09-10 接入）的完整文档见 `../3D摄影机运镜-学习知识库.md`，本页只讲怎么用。

---

## 一、为什么要有 new_project.js

以前每个工程从第一行 HTML 手敲，重复劳动，还经常漏两件事：

1. **漏运镜字段**（`cam` / `cam_amp` / `cam_ease` / `camkeys` / `depth` / `accept` 六个不许留空）
2. **漏接语音词轴**（元素入场锚点用了段边界均分，而不是 ASR 的 `word.start`）

现在：**给一份分镜表 JSON → 一键生成带运镜、带背景、带每镜 TODO 的工程骨架**，
拿到手就能直接填内容，六个字段缺一个生成器直接报错中止。

---

## 二、怎么用

```bash
node new_project.js --spec <分镜表.json> [--out <工程目录>] [--force]
```

- `--spec` 分镜表 JSON 路径（必填）
- `--out` 工程目录，默认 `<spec 同目录>/<name>`
- `--force` 强制覆盖。**不带 --force 时目标已存在直接报错中止，绝不覆盖**

产出 3 个文件：

| 文件 | 作用 |
|---|---|
| `fx_<name>.html` | 工程主文件，开箱带运镜 + 背景 + 每镜 TODO |
| `_render.js` | 配置 + 调 `renderProject`（改完 dur/voice 直接跑） |
| `_audit.js` | 调 `voice-axis-regression-audit` 做回归体检 |

### 实测跑法

```bash
cd kit
node new_project.js --spec templates/spec.example.json --out _smoketest/demo_proj --force

cd _smoketest/demo_proj
node _render.js     # → demo.mp4
node _audit.js      # → _audit_legacy/demo/ 下的 6 帧 + report.json
```

渲染若报找不到 puppeteer-core，先设：

```bash
export RENDER_CORE_PUPPETEER=./node_modules/puppeteer-core
```

---

## 二·五、3D 模式（`--mode 3d` · 2026-09-10 新增）

```bash
node new_project.js --spec <分镜表.json> --mode 3d [--out <工程目录>] [--force]
```

分镜表里 `"mode": "3d"` 也行（命令行优先级更高）。**核心差异**：运镜配方在**构建期**用 Node `vm` 沙箱预跑三个摄影机模块，展开成关键帧数组内联进 HTML → 运行时零依赖、完全确定性、**配方写错当场 die**。

产出 4 个文件（比 2D 多一个 `_shot.js`）：

| 文件 | 作用 |
|---|---|
| `fx_<name>.html` | 3D 工程主文件（含内联 `CAMTRACK` 关键帧数组） |
| `_render.js` | 渲染配置 |
| `_audit.js` | 回归体检（6 帧 + 对比度 + 缩图） |
| `_shot.js` | **截帧审判**（默认 12 帧，可 `node _shot.js 0,3,6` 自定义时刻） |

### 3D 分镜表额外字段

**顶层**：`mode:"3d"` · `lens`（如 `50-standard`）· `film`（如 `kodak-vision3-250d`）· `filmStrength` · `dof` · `shake:{amp,freq,tremor,tremorHz}`

**`shots[].cam3d[]`** —— 配方序列，游标跨镜连续传递（天然一镜到底）：

```
place / approach / dolly / orbit / crane / dollyZoom / parallax /
dutchTilt / push / pull / rackFocus / flyTo / level / snapZoom
```

**`layers[]` 元素级动效字段**（★ 商业级 vs 僵硬的分水岭）：

```
pop(0.10) breathe(0.006) breathHz(0.35) drift(7) driftHz(0.22)
sway(0.4) swayHz(0.17) stagger(true) staggerGap(0.08) staggerRise(20)
```

### 三条 3D 铁律（生成器会强制）

1. **`dutchTilt` 后必跟 `level`** —— 否则 die：「roll 会一路歪到片尾（BUG-2008）」
2. **换集群用 `approach`（带 `dist`+`azimuth`）** —— `flyTo(to:'主体名')` 会让机位==POI → lookAt 退化（BUG-2001）
3. **关键帧数值逐字段查 NaN** —— 出现非数值直接 die（BUG-2002）

### 出片前必跑（手抄）

```bash
# dist_min ≥ 200（穿模/透视炸裂校验，BUG-2009/2010）
node -e "/* 采样 CAMTRACK 算 min(dist(cam,poi)) */"
# roll 归零（非 dutchTilt 段必须全 0，BUG-2008）
node -e "/* T.forEach(k=>Math.abs(k.roll)>0.01 && console.log(k.t,k.roll)) */"
```

> 完整命令见 `../语音转动画-审计loop.md` §5（3D 摄影机专项门禁）。

---

## 三、分镜表字段（对齐 `motion-video-pipeline/assets/storyboard_template.md`）

### 顶层

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `name` | ○ | spec 文件名 | 工程名，决定 `fx_<name>.html` |
| `title` | ○ | name | HTML title |
| `width` / `height` / `fps` | ○ | 1920 / 1080 / 30 | 规格锁 |
| `dur` | ✅ | — | 总时长（秒）。末尾没有落版帧时，生成器自动补一个 `{t:dur, cx:960, cy:540, z:1}` |
| `bg` | ○ | 深蓝径向渐变 | `#scene` 的 CSS background |
| `glow` | ○ | 青色辉光 | `#bgGlow` 的 CSS background |
| `safe` | ○ | `{x0:52,y0:70,x1:1872,y1:1008}` | 安全框，写进 `CFG.safe` |
| `type` | ○ | `{size:72,color:'#E8F1FF',weight:700}` | 默认字号规范 |
| `voice` | ○ | — | 配音 wav 文件名，填了 `_render.js` 会自动接上 |
| `shots[]` | ✅ | — | 镜头数组 |

### 每个 shot

| 字段 | 必填 | 说明 |
|---|---|---|
| `shot` | ✅ | 镜号 |
| `asr` | ✅ | `[t0, t1]`，**绑死 faster-whisper 词轴**，秒。直接变成 `PHASES[i].t0/t1` 和 TODO 里的入场锚 |
| `narration` | ✅ | 旁白原文 |
| `voice_kw` | ✅ | 关键词，校验画面对不对得上 |
| `subject` | ✅ | 画面主体一句话 |
| `layers` | ✅ | 层级清单，决定放 `#fg` / `#mg` 和视差系数 |
| `enter` / `exit` | ✅ | 入退场方式 |
| **`cam`** | ✅ | `creep` / `pan` / `punchIn` / `rackFocus` / `dollyIn` / `whipPan` / `parallax` / `tilt` |
| **`cam_amp`** | ✅ | 幅度（画幅占比或缩放量） |
| **`cam_ease`** | ✅ | 缓动（creep 只能 `linear`） |
| **`camkeys`** | ✅ | 相机关键帧，见下 |
| **`depth`** | ✅ | 层深 → 视差速度系数 + 模糊量 |
| `safe` | ✅ | `action` / `title` |
| `type` | ✅ | `{size, color, weight}` |
| `sfx` | ○ | `[t, name]` 音效锚点 |
| **`accept`** | ✅ | 验收要点，二审照这条判 |

**六个加粗（cam / cam_amp / cam_ease / camkeys / depth / accept）+ 其余必填字段，缺一个生成器报错中止。**

### camkeys 三种写法

```jsonc
{ "t": 6.34, "cx": 960, "cy": 540, "z": 1.16 }   // 对象式（推荐：写了 cx/cy 才是真运镜）
[0, 1.0]                                          // 短式（storyboard_template 同款）→ cx/cy 取画面中心
[0, 960, 540, 1.0]                                // 数组全式
```

各 shot 的 camkeys 会被合并、按 t 排序、相邻重复帧去重，写进全局 `CAMKEYS`。

---

## 四、生成的骨架长什么样

```
#scene
├─ #bg (.layer)  视差 30%   ← bgGrid / bgGlow
├─ #mg (.layer)  视差 60%   ← 分镜占位块（JS 建）
├─ #fg (.layer)  视差 100%  ← ★ 主体元素建这里
└─ #vignette     暗角（不参与运镜）
```

`window.__frame(t)`（**t 单位 = 秒**）分三层：

1. **算相机 → 三层视差**：`FX.camAt(CAMKEYS, t)` 拿到 `{cx,cy,z}`，再
   `FX.applyParallax(#bg, cam, 0.30)` / `(#mg, cam, 0.60)` / `(#fg, cam, 1.00)`。
   前景 100% / 中景 60% / 背景 30% —— 这就是防 PPT 感的关键。
2. **逐镜头驱动**：每个 shot 一个注释块（镜号 / asr / narration / cam 四件套 / depth / safe / accept / TODO 入场锚）+ 一行 `driveShotPlaceholder(i, t)`。
3. **安全框自检**：扫所有带 `data-safe="1"` 的元素，越界记录进 `window.__oob`（不打断渲染）。

骨架自带**分镜占位块**（每镜一块，按各自 asr 窗口淡入淡出），所以**开箱渲染出来是"空的但有运镜和背景"的画面，不是白屏**，可以直接验证视差和相位接线对不对。

### 填充内容三步

1. 在 `#fg`（次要装饰放 `#mg`）建元素
2. 在对应 shot 的 TODO 区写驱动，**入场锚 = `asr[0]`**（不是段边界均分）
3. 守框的元素加 `data-safe="1"`，填完删掉 `driveShotPlaceholder` 和 `.shot-ph` 样式

---

## 五、跟 render-core / fx-runtime / fx-components 的关系

| 文件 | 谁用 | 关系 |
|---|---|---|
| `render-core.js` | `_render.js` | 渲染核心。`_render.js` 只做「配置 + 调 `renderProject`」。生成的 HTML 通过 `window.__frame(t)` + `window.getInfo()` 满足它的帧驱动契约 |
| `fx-runtime.js` | 生成的 HTML | 生成器**优先注入**它，挂 `window.FX`（元素优先契约）：`clamp, clamp01, lerp, eo, ei, eio, eob, c1, seg, env(t,tIn,tOut,dIn,dOut), pop(el,t,t0,…), fade/fadeOut/fadeInOut(el,…), camAt(keys,t), applyParallax(el,cam,rate), roll(el,…), typeOn(el,text,p), sweep`。骨架的占位块用 `FX.env` 取双向窗口系数（⚠ `tIn+dIn ≤ tOut`，否则峰值打折）文件不存在时自动注入 `templates/fx-runtime.fallback.js`（同签名简化实现，控制台会打印 ⚠ 提示）。**正式版落盘后重跑一次生成器即可切换**。⚠ 生成器会把 spec 的 camkeys 归一化成 `{t,x,y,z,rot,cx,cy}`，两种 key 风格都兼容 |
| `fx-components.css` | 生成的 HTML | 同上，注入到 `{{COMPONENT_CSS}}`；缺失则用 `templates/fx-components.fallback.css`。按 `/* ===== 组件名 ===== */` 分段，可整段摘走 |
| `voice-axis-regression-audit` skill | `_audit.js` | 采样 6 时刻 → Otsu+WCAG 对比度 → 缩 880×495 JPG 供 Read 眼审。`_audit.js` 已参数化好路径，跑不通会打印明确的排查提示 |

### 硬约束（骨架已遵守，改的时候别破）

- 单文件离线，**禁外部依赖 / CDN**
- **禁 CSS `animation` / `transition` / `@keyframes`**，一切由 `__frame(t)` 纯函数驱动

---

## 六、`daily_archive.js` · 每日归档守卫（防总文档断档）

> 老板 2026-09-10 立规矩：「每天开始新对话时跑一遍昨天的项目记忆和更新日志，归档到总文档，总文档不要断档」。
> 起因：星角萌萌段 1 / 透明叠加层**干了活没写日志**、段 3 **重渲后 md5 没跟**（日志 4 处失效值）、明动 V1~V2 **连文件名都没登记**。

**用法**（只读，不改任何文件，只打印报告）

```bash
node kit/daily_archive.js                 # 默认扫「昨天 00:00 至今」
node kit/daily_archive.js --since 48      # 最近 48 小时
node kit/daily_archive.js --date 2026-09-09
node kit/daily_archive.js --all           # 全量体检（不按时间过滤，会查日志断档）
```

**扫描范围（3 根 · 每根递归 ≤4 层 · 跟随 symlink）**

| 扫根 | 是什么 |
|---|---|
| `语音转动画总项目/projects` | 本项目正式工程树（③ 工程孤儿判定**只**在这根做） |
| `语音转动画总项目/大狗/works` | 副手岗工作区 |
| `../video-style-lab/projects` | **旧版 CGI 工程树**（`vga-*` / `ink-*` / `mengmeng` / `mingong*` / `som7608` / `face-overlay` …） |

> ⚠️ 第 3 根是 2026-09-16 补的：`01-VGA中文五段` ~ `06-星角萌萌` 这些交付入口**全是 symlink**，
> 指向 `video-style-lab/projects/<工程>`，而该树本身不在旧扫根里 ⇒ 该树 **59 个成片**从未被扫过，
> 报告却照常输出「扫到成片 19 个 + 无缺口」。这种**自信的假通过**比缺口本身更危险。
> 同一批还修了「`Dirent.isDirectory()` 对 symlink 返回 false ⇒ 整棵 symlink 子树被静默跳过」。
> 扫根可用环境变量覆盖：`DA_ROOTS="E:/a,E:/b"`（逗号分隔）；③ 的判定根用 `DA_ORPHAN_ROOTS` 单独覆盖。

**报告为什么逐根报数**（铁律「**报 0 命中必须先证域非空**」）：每根固定打印
`扫到 N 个 ｜ 盘上成片 M 个 ｜ 经 symlink 目录 L ｜ 跳过环/重复入口 C`。
`M=0`（盘上真没有）标 ⛔ 并出「扫根 0 命中」WARN；`M>0 但 N=0`（全在时间窗外）明确标「非漏扫」。
旧版只报一个总数，某根贡献 0 根本看不出来。

**归档证据源（① 与 ② 共用同一域，不许各扩一半）**

| 源 | 内容 |
|---|---|
| 总档 2 份 | `语音转动画-每日更新日志.md` + `语音转动画-项目记忆.md` |
| 各扫根下全部 `.md` | 旧树自己的归档（`INK-SCREEN-总档.md` / 各项目 `分镜表.md` / `接手指南.md` / `BUG-回归库.md` …）。目录黑名单沿用 `SKIP_DIR`（`node_modules` 天然被挡）；实测各根 8 / 12 / 35 个（随工程推进增长），无「数量异常大」的目录，故**未加新黑名单** |

> ⚠️ **总档 2 份必须留在证据源里 —— 别「严格按只读扫根 .md」再改一遍。**
> 这两份**不在任何扫根内**（在 `语音转动画总项目/` 顶层）。实测：把它们摘掉，**14 个产物会立刻变假 FAIL**
> （`mingong/*`、`mingong-l10/*`、`mengmeng/xingjiao_overlay_*` 等旧树工程当年只在新树总档里登过记，
> 旧树自己目录里没有档）。那就是同一个 bug 的**反向版本**：先因证据源太窄吐假 FAIL，再因削得太狠吐更多假 FAIL。
> 正解是**只加不减** —— 总档 2 份 + 各扫根 .md 并集。

> ⚠️ 为什么要扩（2026-09-16 第二轮）：扫域扩到旧树后，证据源若仍只读新树两份总档，那批**早就归档在自己 `.md` 里**的旧树产物会被报成 24 条**假 FAIL**。假 FAIL 的代价是人开始忽略 FAIL，还会逼出「同一份档案在两个文档集里各写一遍」的 `BUG-2169 同物两名`。
> 判定**不变**：文件名 **或** md5 命中任一处即算已归档（md5 证据覆盖「表格里文件名与 md5 分列」的情形）。
> ⚠️ 证据源扩了 ≠ 判据放宽：阈值 / `SKIP_DIR` / `MAX_DEPTH` / 退出码一律没动。这是**口径跟着扫域同步**，不是放松。

**每根都报证据源自证**：`本根 .md 文档 N 个 ｜ 本根档命中 x/y ｜ 全源命中 x/y ｜ 总档命中 x/y`；根下 `.md=0` 会标 ⛔ 并出 WARN「该根漏记判定不可信」。
**① 必须分栏**：`① 新产物漏记 N 个 ＝ 本项目树 a + 外部旧树 b`。**EXIT=1 只代表「本项目树」这栏待核** —— 否则下一个人看到「漏记 14」会以为新树塌了，而真相是「本项目树 4 条 + 旧树 10 条历史遗留」。分栏只是分层呈现：**判据不动、不加白名单、不豁免**（旧树按「老工程不返修」口径标注，明细照旧逐条列出）。
**① 明细给每条红摆两条独立事实栏 —— 「档/片时序」+「spec.json」，都只摆事实、一律不下结论**：
```
  ← 档/片时序：v2a-intro/分镜表.md @09-16 23:18 < 成片 @09-16 23:25 ✓（档写在片之前）
  ← spec.json：存在 ｜ 【在制品特征】档早于片 + 有 spec.json —— 仅标签、不是豁免（分类 / 数字 / EXIT 全不变）
```

**「档/片时序」是独立于 `spec.json` 的一栏 —— 不管有没有 `spec.json` 都打印**。由来：正常生产顺序是**先写分镜表 → 后出成片** ⇒ 在还没回填的在制品上，「档里有没有这个成片名」这个判据**必然为「没有」**；那是工序先后，不是档案失职。三态：

| 事实形态 | 可能的含义（**只是事实形态，不自动等于结论**） |
|---|---|
| 档 **早于**片 + 没片名 | ① 在制品（还没回填） ② 老工程（写完就再没回头） |
| 档 **晚于**片 + 没片名 | **回填过，但回填时漏写了片名** ← 性质最接近真漏记 |
| **无档**（本工程目录 `.md` 0 份，如旧树 `face-overlay`） | 工程压根没档 —— 无档可命中，先补档再谈漏记 |

> 已裁决例（team-lead，2026-09-16）：`vga-signal` / `vga-seg4` / `vga-r2r-dac` 三份 `分镜表.md` 的 `09-07 11:18` 是那天**批量补录**（本库 §6.9/§6.10）留下的，补的时候没写成片名 ⇒ 归「**旧树历史遗留 · 回填未写片名**」，**不返修、不许去补那三个片名**（越界）。

⚠️ **边界：「档/片时序」只说明「回填过没有」，不说明「归属谁」。** `som7608`（档早于片）是老工程、`v2a-intro`（档早于片）是今天的在制品 —— **形态完全相同、归属完全不同**，归属**必须靠人判**（本次就是靠人读 `narration.txt` 才认出 `v2a` = Voice To Animation，工具代替不了这一步）。**拿「档早于片」去推断归属，必错。**
⚠️ **「在制品特征」是标签不是豁免**：两条俱备才贴；**拿不到就拿不到**（`uvc-en2`/`uvc-en3` 就没有 `spec.json`，实测贴不上）。**为了让每一类都贴得上标签去放宽条件，就正好变成恒绿死代码。** 判据 / 数字 / EXIT 全不变。

**总档覆盖这一列（仅供参考 · 非判据）**：`总档覆盖：46/80`，下面拆 `其余 34 ＝ 20 个「只在工程自带档有记载」+ 4 个「本项目树无记载（待核）」+ 10 个「外部旧树历史遗留」`。
保留它的理由：证据源一扩，① 可能全绿而**总档其实断了档** —— 守卫的本职就是防总档断档，这列是唯一能暴露它的。
⚠️ **它不是判据，不许为了抬高这个数去补档**：补档 = 同一份档案在两个文档集各写一遍 = `BUG-2169 同物两名`。

**参考素材单列**：路径含 `/refs/` 或 `/参考/` 的媒体归入「参考素材」（下载来的教程片/素材包）—— 照常显示、单列成块，但**不计入交付物漏记**，也不计入 ④ 的产出日。静默跳过才是病，所以它们永远看得见。

**报告里的路径一律是完整相对路径**（`rel`）：`face-overlay/refs/【meme教程】….mp4` 不会再显示成 `face-overlay/【meme教程】….mp4`（免得把 refs 里的参考片看成工程根下的交付物）；落在扫根**根层**的文件就显示文件名本身，不再伪造 `<文件名>/<文件名>` 这种假工程名。根层文件不进 ③（③ 只认顶层**目录**）。

**查四类缺口**

| # | 查什么 | 判定 |
|---|---|---|
| ① | 新产物漏记 | 交付物（不含 `refs/` 参考素材）的文件名 + md5 在**证据源**（总档 + 各扫根 `.md`）里都搜不到 → FAIL |
| ② | md5 漂移 | **证据源**里该文件记录的值**全都不对**且正确值也没别处出现 → FAIL；正确值在但留着旧值 → INFO |
| ③ | 工程孤儿 | 有成片（`>100KB`）但项目记忆 §2 查无此工程名 → WARN |
| ④ | 日志断档 | 有产出的日子没有日志条目（仅 `--all`） → WARN |

**退出码**：`0` = 无 FAIL（通过）· `1` = 有 FAIL 待补 · `2` = 参数错

**已知跳过（不是漏记）**：`_vid.mp4`（无声视频流，由 `-c:v copy` 复用同一批帧，非独立交付物）· `_` 开头的过程目录 · `frames*` 帧目录 · `<100KB` 废片
**跳过项不会被静默丢弃**：目录黑名单对 **symlink 的目标目录名**同样生效（跟随链接 ≠ 放行 `_tmp`/`frames`/`node_modules`）；被跳过的 `_` 前缀过程件 / `<100KB` 废片 / 环形链接入口都会在逐根报数里**计数**，便于回查「是不是跳多了」。

**判别「双版本」vs「同物两名」只看一条：音频流是否不同** ——
- 音频流**不同** = `_nosfx` / `_sfx` **双版本** ⇒ **合规**（铁律要求；判据 = 三条**视频流** md5 相同）
- **逐字节完全相同** = **同物两名** ⇒ **冗余**（BUG-2169 同族；需归属方定真源）
⚠️ **工具不去重、不合并、不判真源** —— 把冗余如实摊在报上，判断归人。（① 的查重是 **realpath 去重**，只拦「同一物理文件经 symlink 被数两遍」= 工具自己的重复计数 bug；**故意不用 md5 去重**，否则冗余会被静默折掉、看不见。② 用 md5 池另论：那是 ② 的本职口径，与「口径各扩一半」是两回事。）

### 判据自检（改这个脚本 / 造夹具时必须过）

1. **先证「判据会红」**：造一个真实产物但不写档 ⇒ ① 必须 FAIL、EXIT=1。判据恒绿 = 死代码。
2. **再证「域非空」**：报 0 命中的那一栏（扫根 / 证据源 / 工程目录）必须先证明**非空** —— 这就是逐根报数、`.md` 计数、证据源域行、`档/片时序：本工程目录 .md 0 份（无档）` 这一栏存在的原因。
3. **夹具样本必须两两可区分（血泪教训）**：第一版探针把每个样本都写成「150KB 全 `0x07`」⇒ **md5 全撞** ⇒ 「只靠 md5 命中」那条被别的样本蹭绿，**自己也没立刻看出来**。同族是「假 PASS 靠巧合成立」。
   ⇒ 造夹具时**必须打印「样本数 == 唯一 md5 数」，不等就是夹具坏了**（不是判据通过）。
4. **口径要跟着扫域走，且不许各扩一半**：改扫域就必须同步 ① 的证据源与 ② 的抽取域；两边用**同一个**证据源集合，别一个扩一个不扩。
5. **只加不减**：扩证据源时不许顺手摘掉旧源（见上文「总档 2 份必须留下」的实测代价）。
6. **事实栏 / 标签不许变成豁免，也不许为「贴得上标签」放宽容**：事实栏是加的、判据是不动的 —— 「在制品特征」拿不到就拿不到（`uvc-en2/en3` 没 `spec.json` 就是贴不上），**为了让每一类都贴得上而放宽条件 = 恒绿死代码**。而且事实栏只能说明「回填过没有」这类**局部事实**，**不能**升级成「归属谁」这类**结论**（`som7608` vs `v2a-intro` 形态同、归属异），结论一律交人。

**配套**：已在 automation 里建「语音转动画·每日归档守卫」，**每天 08:30 自动跑**并补档。
**规则全文**：`语音转动画-项目记忆.md` §6 每日归档纪律。

---

## 七、`check_wording.js` · 动画描述词校验器

> 老板 2026-09-10 定：**「我描述动画不完善、或者你开始写分镜的时候，用它完善描述词」**。
> 配套 skill `~/.workbuddy/skills/animation-description/`（决策链 + 词汇表 + 字段模板）。
> 依据：规格锁 §5.11 元素级动效工艺规格 + 学习知识库 §11（emilkowalski/skills 调研）。

**用法**

```bash
node kit/check_wording.js <分镜表.json>
node kit/check_wording.js <工程目录>      # 扫目录下所有 *.json
node kit/check_wording.js <file> --warn   # 把 WARN 也算失败（严格模式）
```

**查七类（只管元素级动效，不管摄像机运镜）**

| # | 查什么 | 级别 |
|---|---|---|
| ① | 缺 `purpose` 或不在六词内 | FAIL |
| ② | 单元素 `dur` > 700ms | FAIL |
| ③ | 用 `lin` / 进场用 ease-in（`ei/qi/xi/ci`） | FAIL |
| ④ | `staggerGap` 不在 30~80ms | FAIL |
| ⑤ | 整组 stagger > 500ms | FAIL / WARN（视是否实算） |
| ⑥ | **静态卡给了过冲** / `settle:false` | FAIL |
| ⑦ | 高频元素（≥3 次）时长 > 250ms | WARN |

**⭐ 过冲判定（最容易误报的一条）**
判定依据**不是「有没有位移」，而是「有没有动量」**：
- `slideUp` / `rise` / `fade` —— 元素**自己走完行程**，没有动量残余 → `pop:0` **正确**，不报警
- `fly` / `swing` / `whip` / `snap` / `throw`，或显式 `fromCamera:true` / `momentum:true` → 过冲成立

**兼容两种写法**：A) `layers[].anim` 新写法（查得细）· B) `layers[].pop/staggerGap` 旧写法（3D 引擎裸字段）
**退出码**：`0` 通过 · `1` 有 FAIL · `2` 参数错
**合格示例**：`~/.workbuddy/skills/animation-description/assets/anim_example.json`（EXIT=0）

**首跑战绩**：拿明动 V4 真分镜表跑 → 抓出 C1/C4/C7 的 `staggerGap` 85~90ms **超上限**（正是 §11.13 改进项第 3 条）。
- 同一帧号状态必须完全一致（确定性渲染）
- 内容不超出安全框 `(52,70)-(1872,1008)`；有字幕条时底边 ≤900

---

## 2026-09-12 新增四件套（资产库第一批 + 运镜朝向升级）

| 模块 | 作用 | 一句话 |
|---|---|---|
| `motion-tokens.js` | 动效 Token 三层 | primitives → semantics（enter/exit 成对，exit=60%）→ 组件引用 |
| `themes.js` | Theme Pack 主题包 | 配色/字体/质感打包成数据，换主题 = 换数据，不碰代码 |
| `check_theme.js` | 裸色值门禁 | 业务代码里出现 `#rrggbb` / `rgb()` → FAIL（治 BUG-1921 复发） |
| `transitions.js` | 转场模板库 | 10 个转场 × 3 档速度，全部 enter/exit 不对称 |
| `camera-aim.js` | 摄影机朝向独立轨道 | **运动中改朝向**：aim 模式 + aimEase 与机位缓动解耦 |

### camera-aim.js 用法速查

```js
// 关键帧新增字段（全部可选）
{ t, x,y,z, px,py,pz, zoom, roll, ease,
  aim:      'poi'|'hold'|'lead'|'lag'|'subject',
  aimEase:  'qo'|'snapo'|...   // 朝向独立缓动，默认跟 ease
  yaw, pitch,                   // 直接给角度（度），最短弧插值
  yawOff, pitchOff,             // 在解算结果上叠微调
  leadDist, lagTau, subject
}

const baked = CAMERA_AIM.bake(TRACK, {fps:30});   // 构建期烘焙
CAMERA_AIM.apply(vp, cam, TRACK, baked, t);       // 运行期纯函数
CAMERA_AIM.audit(TRACK, baked);                   // 角速度门禁
```

**五种 aim 模式**（机位 (0,0,1600)→(1400,0,1600) 实测）

| 模式 | 行为 | 实测 yaw |
|---|---|---|
| `poi` | 看向 POI（现状） | 0° → 41.2° |
| `hold` | 冻结段首朝向，机位动视线不动 | 恒 0° |
| `lead` | 沿速度方向前视 | 恒 -90°（沿 +X） |
| `lag` | 一阶低通跟随，视线追不上 | 最大落后 18.6° |
| `subject` | 跟随动态主体 | 每帧解析 |

**★ 核心能力：机位与视线解耦**
机位 `eio` 匀速推进 + 视线 `snapo` 甩向新主体 → 实测视线先甩到 -24.5° 再随到位回正，而机位全程单调前进。**以前这两件事被焊死在同一条缓动上。**

**⚠️ 两个已修的静默失效坑**（写单边不报错、直接失效）
1. `aimEase` / `aim` 写在**结束关键帧** → 现在两端都认，起点优先
2. 显式 `yaw`/`pitch` 只写一端 → 缺的那端用 POI 解兜底

**⚠️ 角速度门禁标定**：默认 180°/s = **90° 转向至少需 1.7~2.0s**。
（eio 1.2s→213°/s FAIL；eio 2.0s→131°/s PASS；cio 1.2s→444°/s FAIL）
真要甩镜显式传 `maxYawRate`，别改默认值。

### 主题包用法速查

```js
THEMES.apply('dark-tech');        // 写到 :root（运行时）
THEMES.vars('c5-tiny');           // 取变量串（构建期 · 注入用）
node kit/check_theme.js <dir>     // 扫裸色值 + 对比度自检
```

四主题对比度实测全过：`dark-tech` 20.03/11.17/7.86 · `light-product` 17.74/9.92/5.95 ·
`ink-paper` 14.91/8.89/5.41 · `warm-media` 17.28/12.2/8.3（primary/secondary/tertiary）

⚠️ **门禁首跑就抓到真问题**：`kit/templates/skeleton3d.html` 里有 2 处被明令禁止的
`#8FA0BE`（深底小字铁律），已修成 `#B5C2DC`。另有 ~500 处历史骨架模板的硬编码色待迁移 ——
属下一批，不影响新工程（新工程直接引 `themes.js`）。

---

## ★ 单一真源工作流（2026-10-01 立 · 铁律 324~330）

> 起因：C5-TINY-Game 三关背景色不一致（BUG-2616/2617）。**真源一直在仓库里，三条源零引用。**

**两级真源分工**（缺一不可，改动顺序不许颠倒）：

| 级别 | 位置 | 回答的问题 |
|---|---|---|
| **口径真源** | `projects/<P>/<P>-全局视觉方案.md` | 「为什么是这些色、每个色干什么用」 |
| **取值真源** | `kit/themes.js` 的 `T['<id>']` | 「三条片子实际读到的是哪些值」 |

**五步改动流程**：改文档 → 改 `themes.js` → `theme_inject.cjs` 注入页面 →
`check_theme.js` 验收 → 重渲。

### theme_inject.cjs —— 单一真源的唯一写入口

```bash
node kit/theme_inject.cjs --theme c5-tiny --target <file.html>          # 写入/刷新
node kit/theme_inject.cjs --theme c5-tiny --target <file.html> --check  # 只校验（幂等）
node kit/theme_inject.cjs --theme c5-tiny --target <file.html> --dry    # 只打印
```

* **生成块协议**：页面里位于 `/* @theme-begin <id> */ … /* @theme-end */` 之间的色块
  **由真源生成、禁手改**；门禁逐条比对它与 `THEMES.vars(id)`，改了必报 FAIL。
* **首次运行**插到第一个 `:root{` 之后；**再次运行**只刷新既有块。
* **行尾保持**：纯 LF / CRLF 各按各的写回（二进制字节计数判定，不用 `grep -c $'\r$'`——
  本机该判法**恒真**）。
* **rgb 分量双出口**：`--g3:#B77A22` 同时输出 `--g3-rgb:183,122,34`，
  业务侧写 `rgba(var(--g3-rgb),.10)` —— 这是治「hex 手抄成 rgba 分量」这个漂移
  **机械原理**的唯一手段。
* ⚠️ 脚本注释里**不许出现注释终止符**（` */` 会提前终止块注释 ⇒ SyntaxError）。

### check_theme.js 的两个新判据

1. **生成块豁免** —— 生成块内的色值不判裸色值，但必须与真源**逐条同步**（不同步 = FAIL）。
   * 成对标记做**配对断言**，不配对**抛错**（否则正则静默吃到文件尾 ⇒ 门禁全废而零告警）。
   * 豁免范围**只按 `path.basename()` 判**——让目录名参与会让 `_tmp/` 下的负控样本全体豁免。
   * `allow-color` 标记**必须在剥注释之前**记录（标记本身住在注释里）。
2. **正值写法**：`rgb()` 判据只认「数字开头」（`/\brgba?\s*\(\s*[\d.]+\s*,/`）——
   否则 `rgba(var(--g3-rgb),.10)` 这个**正解写法**会被误判成裸色值。

### 跨文件「同名变量取值对账」（系列片必跑一次）

判据全绿 ≠ 三条片子一致。本轮就栽在这：`--g3` 在开场白是 `#E6B84A`、在 L2/L3 是 `#B77A22`，
**差整整一档**，而所有单片判据全绿。做法（`_ab_resolve.py`）：
把两边所有 `var()` **解回 hex** 再逐行比。

### A/B 铁律（铁律 327）

* **基准必须是完整快照**：改的是「数据 + 读数据的人」（如 `_hero.js` 改成运行时读 CSS 变量）时，
  **回退要两边一起退**。只退一半 = 拿一个不存在于任何版本的**嵌合体**当基准。
* **副本落在同目录**：靠相对路径加载 `<script src="...">` 的工程，
  临时副本挪进子目录 ⇒ 依赖静默 404 ⇒ 只在 `__frame` 超时里体现，报错**一个字都不提 404**。

---

## ★ trial.js —— 交付前唯一「必跑」的审判器

> 2026-10-01 由老板指令收敛而成：「系统性整理总项目管线，总和成一个必看的审判脚本 ——
> 你就不用搞这么多门槛，直接一个最关键、最不能忽略的守卫先处理第一版。」

```bash
export NODE_PATH="./node_modules"
node kit/trial.js <工程.html>                       # 标准档
node kit/trial.js <工程.html> --mode fast           # 极速档 ≈50s
node kit/trial.js <成片.mp4>                        # 成片档（ffprobe + signalstats）
node kit/trial.js --self-test                       # 判据自检：8 条红线必须全红
```

**退出码 0 = 可交付；非 0 = 不许交付。**

### 三层判据

| 层 | 内容 | 拦不拦 |
|---|---|---|
| **P0 必看（8 条红线）** | RUNTIME（JS 报错/资源 404）· PURE（render(t) 纯函数）· MASK（起播遮罩）· BLANK（空帧/死帧/发白）· SAFE（越界）· ZERO（有字却零尺寸）· OVL（字压字）· EDGE（保留带小字） | **拦** |
| P1 选看 | 相机逐帧连续性 · 同屏小字密度 · MAD 分布 · 元素复杂度 | 只报 |
| P2 钻研 | 眼审截帧 · 逐帧亮度曲线 | 仅 `--mode deep` |

### 三档模式（口径一致，只改采样密度）

| 档 | DOM 扫描 | 像素抽样 | 耗时 |
|---|---|---|---|
| `fast` | 每 2 帧 | 每 6 帧 | ≈50s |
| `standard`（默认） | 全帧 | 每 3 帧 | ≈1min |
| `deep` | 全帧 | 全帧 + 截帧 | ≈2min+ |

### 常用参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--band 96` | 96 | 上/下保留带（留给标题/字幕）—— 铁律 221 + BUG-1314 |
| `--small 20` | 20 | 「小字」字号上限 px |
| `--ovl 0.12` | 0.12 | 相交面积 / 较小者 |
| `--mad` | 自动 √(P10×P90) | 死帧阈值，**不建议手填** |
| `--allow "a+b"` | — | 放行口，`+` = 多个关键字都要出现 |
| `--json out.json` | — | 机器可读结论 |

### 被它吸收、以后别再单独跑的旧门

`kit/quad_check.js`（遮挡）· `kit/boxchk.js` · `kit/layout_check.js` 的安全区部分 ·
各项目 `_qdom_*.cjs` 里的 OVL / LAB 组。
**项目特化判据（GROW / S4GAP / 六锚 GATES）不进总审判，留在项目自己的 `_q*.cjs`。**

---

## ★ 尾段口径（2026-10-01 立 · 铁律 331~338）

> 老板原话：「帮我看看管线内的**最后一秒设置**是不是自己**自动加了什么定版** …
> 我不需要这个，**你直接就是动画做到最后一秒就直接延长就行了**」

### 铁律 331 · 尾段口径（一句话）

**正片最后一镜的动作与运镜直接演到 `dur`**，末尾**不出现任何总结文字 / 型号定版 / 结论徽章**。
原「落版定格」条款**作废**。**结论由口播承担，画面只做动作。**

管线侧同步（都已落地，别再改回去）：

| 落点 | 改法 |
|---|---|
| `kit/new_project.js` | **删掉**「落版全景兜底」（原 L184~189：末尾没收到中心的运镜帧就自动补 `{t:dur,x:960,y:540,z:1,rot:0}`）—— 这是"每条新片都被自动发一个定版"的**根因** |
| `语音转动画-规格锁.md` §6.2.1 节奏三区 | **删掉**第三区的「落版定格」条目 |
| 三条源 | 删落版面版 / 结论标 + 对应 `driveXxx()` 驱动 |

### 铁律 332 · 「延展」只能用线性

`easeIO` **两端速度 → 0**。把窗口拉长 = 头尾各多一段"几乎不动" ⇒ **"延展"退化成"更长的静帧"**。
⇒ 进度条 / 计数器这类**本来就该匀速走**的元素，延展一律用线性 `span()`。

**受控单变量实验**（材料 `projects/C5-TINY-Game/v2/_make_l3_curve_variants.py`，
测量 `_probe_mad.cjs` —— 只动 S6 进度条的「窗口长度 × 曲线形状」，其余保持改前状态）：

| 变体 | 写法 | 尾窗 `[21.4,23.6]` 内 dead 采样点（阈值 0.75）|
|---|---|---|
| A = 改前 | `easeIO(span(s6burn, s6burn+1.10))` | **14/23（1.4s）** |
| B | `easeIO(span(s6burn, s6done))` ← 只拉长窗口 | **12/23（1.2s）** |
| C | `span(s6burn, s6done)` ← 只换**线性** | **4/23（0.4s）** |

逐点看 B 列：拉长窗口后**两头一起塌** —— 头 22.00 从 1.56 掉到 **0.64**、
尾 22.80 起 0.88 → 0.44 → 0.25 一路掉到阈值下；C 列 22.60~23.20 **全程稳在 0.79~1.13**。
⇒ **"拉长窗口"在 `easeIO` 下不但没救尾巴，还顺手把头部也拖慢了。**

> ⚠️ 本节原引的 `4.25→1.68 / 2.79→1.73` 已**作废**：那是旧探针（另一套浏览器启动参数）量的、
> 且当时的中间版本已不在盘上 ⇒ **不可复测**（铁律 344）。

### 铁律 333 · 自动阈值的判据，跨版本**比数值、不比结论**

`trial.js` 的死帧阈值 = `√(P10×P90)`（下限 0.5），**从本轮自己的像素分布算出来**。
实测（同一台仪器，见下章）：v2 `0.77→0.78` · L2 `0.62→0.62` · L3 `0.75→0.73` ——
**像"尾段延展"这种局部改动，阈值前后只差 ≤0.02**。

⇒ **"判据全绿"不能证明改动生效**；但更该怕的是**下一条**：
**「最长死帧段」是刀锋指标**。`_probe_mad.cjs --sweep` 实测：

| 阈值 | v2 最长段 | v2 dead 合计 | 是否触发 BLANK（≥2.0s）|
|---|---|---|---|
| 0.50 | **1.60s** | 6.30s | **否（PASS）** |
| 0.90 | 3.60s | 7.40s | 是 |

**阈值动 0.4，「最长段」1.60s→3.60s，结论从 PASS 翻成 FAIL**（L2：0.50→2.80s / 1.50→8.50s）。

⇒ 跨版本 A/B **只认** ① **dead 合计（秒）** ② **逐采样点并排（同 t 两边 MAD）**，
并且**报告必须带阈值**（铁律 340）。
参考实现：`projects/C5-TINY-Game/v2/_probe_mad.cjs`（`--mad` 钉阈值 / `--sweep` 灵敏度扫描 /
`_mad_analyze.py` 复算点值）。

### `check_landing_brand.js` 的三个新口径

```bash
# 声明式「无落版层」（铁律 331）：侧车顶层加 "no_landing": true
node kit/check_landing_brand.js <工程目录> --html v2/fx_x.src.html --layers specs/x.layers.json
node kit/check_landing_brand.js <工程目录> --no-sidecar-ok   # 显式声明本工程没有元素侧车
node kit/check_landing_brand.js <工程目录> --selftest        # 负控：注入品牌词看抓不抓得到
```

| 口径 | 说明 |
|---|---|
| `"no_landing": true` | ⚠️ **不是豁免开关**。检查面（shot 最大那组）、判据、严重度**全不变**；只把术语从「落版元素」改称「**尾镜可见文本**」—— 免得输出里暗示"本条片子该有落版层"，后来人顺手补回去 |
| 侧车目录 | `specs/` 与 `spec/` **两种写法都认**（狗子线用单数）|
| 找不到侧车 | **`exit 2` 拒绝给结论**（要放行须显式 `--no-sidecar-ok`）—— 老实现是打「✓ 合规」+ `exit 0`，**"没东西可查"被当成"查过且通过"** |
| **自动挑 HTML**<br>（BUG-2642 · 铁律 349） | ⚠️ 工程内 depth≤2 有 **≥2 份** `fx_*.src.html` ⇒ **`exit 2` 拒绝自动挑**（列出全部候选 + mtime），**必须显式 `--html`**；只有 1 份才自动用。<br>老实现是「先查根目录、命中即返回」——C5-TINY-Game 因此挑中了**根目录那份 v1 遗留** `fx_c5_opener.src.html` 并打 PASS，而那个 PASS **说的不是现版 `v2/fx_c5_v2.src.html`**（本工程 depth≤2 内共 **9 份**）。<br>⇒ **判据不许挑一个不确定的输入然后照常给结论**；「挑个最新的算了」= 把前提藏起来 |
| 无检查面时 | **不许出现"合规"字样**，改打「本条**未做落版定位**」|
| `elemExists()` vs `textOfId()` | **存在性**只看开始标签；`textOfId()` 对 void 元素（`<img id="…">`）返回 `''`（存在但无文本），**不返回 `null`** —— 拿"有闭合标签"当"存在"会把配套侧车误判成"不配套" |

### 尾段改动后的验收清单

1. `node kit/check_landing_brand.js …`（正例 PASS + `--selftest` 负控 + 错配 `exit 2`）；
   ⚠️ **多版本并存的工程（如 C5）必须显式** `--html <相对工程目录的路径> --layers …` ——
   自动模式已改为**拒绝挑**（BUG-2642）；
2. `node kit/check_wording.js specs/x.layers.json`（删元素后**元素数要同步**）；
3. `node kit/trial.js <源 html>` —— 记下 **BLANK 报的段（起点→终点）** 与 **阈值**；
   ⚠️ **先分清失败段在"尾段"还是"hold 段"** —— 尾段改了不等于 BLANK 会绿
   （本轮实测：三条尾段死帧全消除了，BLANK 仍 fail，失败段在 hold 段且**改前改后逐点一字不差**）；
4. 并排（铁律 340）：**钉同一阈值** + 报 **dead 合计** + **逐点 MAD**（`_probe_mad.cjs` / `_mad_analyze.py`）；
5. 4K 重渲三条 → 合轨 `-c:v copy` → 双口径 framemd5。

---

## ★ 判据仪器学（铁律 **339~344**）· 2026-10-01

> 这一章不是"怎么做片子"，是"**怎么量片子**"。起因是一次自我更正：
> 我用探针量出「v2 改后 18.60s 之后再无 DEAD」并据此写了五份文档，
> 傍晚 `trial.js` 复跑却**仍然 fail** —— 追下去发现**两把尺子不是同一把**。

### 铁律 339 · 量同一件事的多个工具，必须共用同一套环境参数

**唯一真源 = `kit/browser_args.js`**（`trial.js` 与所有像素探针一律 `require` 它，不许各写一份）：

```js
const ARGS = require('<相对路径>/kit/browser_args.js');
await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ARGS });
```

| 参数 | 为什么不能少/不能多 |
|---|---|
| `--force-device-scale-factor=1` | 禁系统 DPI 缩放参与取像素 |
| `--disable-lcd-text` | 关亚像素抗锯齿 ⇒ 灰度 AA，跨机器稳定 |
| `--font-render-hinting=none` | 关字体 hinting ⇒ 字形栅格化可复现 |

**实测代价**：探针曾自带 `--disable-gpu`、trial.js 自带 `--disable-lcd-text`
⇒ 同一份 v2 的 MAD 分布 **P90 9.54 vs 10.21 / max 10.92 vs 12.80 / 最长段 3.20s vs 3.60s**。
统一后 L2、L3 **逐字一致**，v2 仅 `max` 差 **0.02**（已知残差，不影响任何结论）。

### 铁律 340 · 跨版本 A/B 不许拿「最长段」当结论

钉同一阈值（`--mad`，或取两侧自动阈值的大者）+ 报 **dead 合计** + **逐点并排**，
**报告必须带阈值**。"最长连续 X"形状的判据，先做一遍 `--sweep` 灵敏度扫描。

### 铁律 341 · 像素 A/B 之前先断言资源全加载

改前副本**不是"拷个文件"，是"重建一个能跑的运行环境"**：

- 三条源都有相对引用（`_hero.js` / `../_refs/product/*.png` / `../../../kit/camera3d.js`），
  副本挪目录 ⇒ **全 404**，而浏览器照渲染、探针照量 ⇒ 拿「**缺图版**」比「**正常版**」。
- **正解**：放到**与源相对深度相同**的目录（`projects/C5-TINY-Game/_before/` 是 `v2/` 的兄弟）
  ⇒ 相对路径解析结果完全一致 ⇒ **HTML 一个字节都不用改**、可逐字节验 md5。
  生成器：`v2/_setup_before_dir.py`（复制 + md5 断言 + **依赖解析自检**）。
- 探针侧加**测量有效性门**：请求 404 或任一 `<img>` 的 `naturalWidth == 0`
  ⇒ 判定**本次测量无效、打印原因、不参与 A/B**。

### 铁律 342 · 给浏览器喂 HTML，扩展名就是类型声明

`file://` 下 Chrome **按扩展名**决定怎么渲染：`x.html.bak_before_extend` 的扩展名是
`.bak_before_extend` ⇒ **不当 HTML** ⇒ `window.__frame` 永远等不到 ⇒ 20s 超时。
⇒ 一律先复制成 **`.html`** 再喂。
**批量探针必须边跑边印**（`try/catch` 跳过 + 打原因）—— "全跑完才打印"等于把已完成的工作押在最后一个文件上。

### 铁律 343 · 同名文件出现在两个目录时，键必须是完整路径（或路径+侧别）

`_mad_analyze.py` 曾用 `basename` 建索引，而 `_before/` 下副本的 basename **与现源完全相同**
⇒ 现源被静默覆盖 ⇒ "逐点复算"退化成"改前 vs 改前"，**每个点都打印"完全相同"**，
看上去像"本次改动对画面零影响"。⇒ 键冲突时**直接拒绝给结论**，不许静默覆盖。

### 铁律 344 · 不可复测的数字不许留在文档里

旧仪器的读数、已不在盘上的中间版本 —— 要么**补实验重测**（本轮 BUG-2627 的做法），
要么**删掉只留机理**。**"当时大概是这个数"是最坏的一种表述。**

### 本仓的判据工具与分工（别重复造）

| 工具 | 干什么 | 口径 |
|---|---|---|
| `kit/trial.js` | **总审判器**（P0 八条红线 → `exit 1`）| 唯一验收出口；启动参数见 `browser_args.js` |
| `kit/browser_args.js` | **浏览器启动参数唯一真源** | 任何像素工具都必须 `require` |
| `v2/_probe_mad.cjs` | 逐采样点 MAD + 死帧段【起点→终点】+ `--sweep` | 复刻 `trial.js` 的 BLANK 口径 |
| `v2/_mad_analyze.py` | 从 JSON 曲线**复算**文档里引用的每个点值 | 单次测量 → 全文档同源 |
| `v2/_mad_window.py` | 指定窗口内多文件逐点并排 | A/B 只看这个 |

## ★ carry_check.js —— 承接判据（跨边界谁活下来了）

> 补**软边界**的盲区：trial.js 8 条红线只判**单帧内的错**，quad_check 四查只判到**硬切那一对帧**。
> 而「像 PPT / 一个一个展示」是 `display:none` 换 DOM、整屏淡出再淡入、元素原地只换 opacity
> 造成的 —— 像素上都是**干净的两帧**，现有判据**一个都看不见**。

```bash
node kit/carry_check.js <工程.html>                 # 判一条
node kit/carry_check.js <工程.html> --json          # 机器读
node kit/carry_check.js <工程.html> --cuts 3.0,6.0  # 手动声明边界（豁免用）
node kit/carry_check.js --self-test                 # ★ 负控自证 8 项（造 fixture 跑）
```

口径（照抄 onetake `probe.py::continuity` 的公开数值，**实现独立重写、代码一行不搬**）：
边界 `dt=0.4s` 内 `Jaccard<0.2` ｜ 载体 `move≥0.02·对角线` 或 `scale≥0.1`
｜ 锚 `big≥0.03`（半分）｜ 裸切 0 分 ｜ 豁免 burst/末1.2s/声明切点
｜ 评分 `(carried+anchored/2)/considered`
｜ ★ **`considered=0` 报「样本不足」，绝不给 1.00** ｜ 采样器读到 0 元素 **exit 2**

**三条独立读数（不许混成一条）**：承接分 / 空画面段 / 内容覆盖率下限。
后两条治的是「渐变到空」—— 逐帧跳变小不代表画面不空。

**自证结果**：`--self-test` **8/8 PASS / exit 0**（五态 + 负控 A/B/C/D）。
fixture 在 `kit/carry_fixture.html`（面积配比按阈值反算，改阈值要同步改它）。
### v2（2026-10-02 夜·续）：并入副手四条 + 两条新铁律

| 能力 | 说明 |
|---|---|
| **承接种分离** | 元素带 `role="carry"` ⇒ 只当承接证据，**不进 Jaccard 分母**。防「一个空心取景框把 score 从 0.08 刷到 0.90」（副手实测：边界 6 → 3 被吞） |
| **内容层第二口径** | 报 `scoreContent`（只计内容元素的承接）与 `onlyCarryRole`（报警「carried 全来自承接种」） |
| **`--selfcheck`** | 构建期 6 项断言（真函数 / 选择器内联 / 未引用闭包 / ground 在 / 纯容器在 / 健康门在） |
| **逐 lag 扫描** | `[0.5·dt, 1.5·dt]` 五档取最小 J ⇒ 换场比 `dt` 短时也能检出（第一版只测固定 dt 是真缺陷） |
| **空画面独立读数** | 空帧段 / 内容覆盖率下限与承接分**分开报** —— 承接差 ≠ 画面黑 |
| **负控 9 项** | 五态 + A/B（opacity≠承接）· C（0 样本不报 PASS）· D（采样器失效 exit 2）· E（空框刷分被识破） |

**三条铁律**（全文 → BUG 库 §6.79）：
**371** 过滤器里「不存在」和「不合格」是两件事 ｜ **372** 时间窗口阈值按「最不利的那一帧」定
｜ **373** 一组 fixture 的价值在「互相把对方的错照出来」

**遗留**：`--space stage` 口径（双口径互验）· `--inject hide/freeze` · 接入 `trial.js`。


### 2026-10-07 成片局部运动测量面

trial.js的MP4档调用motion-local.cjs：64×36灰度图内8×6局部块最大MAD，约100ms帧间窗，静态窗覆盖时间≥1.5s仍拒绝，MAD阈值0.35。HTML档没有改。测量面与旧全画面逐相邻帧平均不同；不作主观动效评分，周期运动/小面积噪声存在盲点。真实编码24/30/60fps十二项正负控与1800帧长动/长静控制已过，输入异常与无可量时间面拒绝。重跑：remake-02/scripts/verify_local_gate.py、verify_sampler_passthrough.py；绑定真源hash的记录在analysis/local-motion-controls/gate-results.json。
