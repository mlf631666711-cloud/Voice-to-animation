# 第三方组件与致谢 · Third-Party Notices & Acknowledgements

> **一句话结论**：**本仓库的代码是自研的（MIT）；只有一样东西来自别人** ——
> `kit/shotcraft/index.json` 里那份**镜头卡索引**，数据来自
> **[`Vincentwei1021/video-shotcraft`](https://github.com/Vincentwei1021/video-shotcraft)**（**Apache-2.0**）。
> 其余全部自研。本文件 = 完整清单 + 许可 + **我们对它做了什么修改**（Apache-2.0 的硬性要求）。
>
> **TL;DR**: The code here is original (MIT). **Exactly one thing is third-party** — the shot-card
> index in `kit/shotcraft/index.json`, whose data comes from
> **[`Vincentwei1021/video-shotcraft`](https://github.com/Vincentwei1021/video-shotcraft)** (**Apache-2.0**).
> Everything else is original work. This file lists every component, its license,
> and **the modifications we made** (mandatory under Apache-2.0 §4(b)).

---

## 一、总表 / Summary table

| 组件 | 来源 / Source | 许可 / License | 随仓库分发？ | 用在哪 |
|---|---|---|---|---|
| **video-shotcraft** 镜头卡数据 | [Vincentwei1021/video-shotcraft](https://github.com/Vincentwei1021/video-shotcraft) · Wei Yihao | **Apache-2.0** | ✅ **是**（**仅**已解析的索引） | `kit/shotcraft/index.json`（157 张卡元数据，**已解析成独立成品**） |
| **动效术语库**「动效设计师」 | 本仓库作者**自有**本地库 | 自有 · 随本仓库 MIT | ✅ 是（索引快照） | `kit/shotcraft/terms-index.json`（618 条术语元数据） |
| `puppeteer-core` | Google / Puppeteer 团队 | Apache-2.0 | ❌ 否 | 渲染：逐帧驱动 Chrome |
| **FFmpeg** | FFmpeg 项目 | LGPL-2.1+ / GPL-2+（取决于编译） | ❌ 否 | 编码合成 MP4 |
| **Google Chrome** | Google | 专有（免费使用） | ❌ 否 | 渲染宿主 |
| **Node.js** / **Python** | OpenJS / PSF | MIT / PSF-2.0 | ❌ 否 | 运行时 |
| **Remotion** | Remotion AG | 专有（个人/小团队免费，公司需付费） | ❌ 否 | **本仓库不使用** —— 仅上游 skill 用（见 §五） |
| **音效素材来源**（Pixabay · Mixkit · Kenney · Sonniss · Freesound） | 各自站点 | 各自许可（**均免费可商用**，多数免署名） | ❌ 否 | **本仓库不含任何音频文件** —— 只在 [`docs/音效获取指南.md`](docs/音效获取指南.md) 里**告诉你去哪下**（见 §五） |

> 「随仓库分发 ✅」= 这个文件的字节就躺在仓库里。**＝否＝你得自己装**（见 §四）。

---

## 二、video-shotcraft —— 唯一随仓库分发的第三方内容

### 2.1 它是什么

一个 **AI agent skill**，用来做电影感的产品宣传片（157 张镜头配方卡 · 214 个动效样片 ·
一套 Remotion 模板）。作者是 **Wei Yihao**（GitHub: [@Vincentwei1021](https://github.com/Vincentwei1021)，
X: [@VincentWei93](https://x.com/VincentWei93)），10k+ stars。

它的卡片是一份**结构化的动效知识库**：每张卡带「一句话 / 适用时长 / 能量 / 参数手感 / 已知坑」。

### 2.2 我们用了什么 / 没用什么

| | |
|---|---|
| ✅ **用了** | 上游 `references/shots/*.md` 里的**卡片知识**，重新解析成一份 JSON 索引（`kit/shotcraft/index.json`） |
| ✅ 用了 | 卡片 id / 分类 / 一句话 / 时长区间 / 能量 / 参数手感 / 已知坑 —— **纯文本字段** |
| ❌ **没用** | 上游的 **Remotion / TSX 源码**（`demos/`、`template/`、`assets/lib/`）—— 一行都没拿 |
| ❌ 没用 | 上游的 **视频样片**（214 个 mp4）、**图片帧**、**截图**、**海报** |
| ❌ 没用 | 上游的 **音频资产**（BGM ×5 / SFX ×149，Mixkit 来源） |
| ❌ 没用 | 上游的**品牌、logo、字体、美术资产** |
| ❌ 没用 | 上游的**卡片原文与方法论文档** —— **不随仓分发**（理由见 2.3）。

**为什么只取数据不取代码**：上游是 **Remotion / React-TSX** 技术栈，
本仓库是 **HTML + 原生 JS 纯函数**技术栈（见 README「核心思路」）。
**两套栈不通用** —— 拿它的代码过来没有意义，但它的**卡片知识**（动效手法、参数手感、已知坑）
是跨栈通用的，所以只把那部分解析进索引。

### 2.3 ⚠️ 我们做的修改（Apache-2.0 §4(b) 要求声明）

Apache-2.0 第 4(b) 条要求：**再分发衍生作品时，必须对改动过的文件作出显著声明**。我们的改动：

| 上游的东西 | 我们的处理 | 性质 |
|---|---|---|
| `references/shots/*.md`（157 个 Markdown 卡） | **解析、抽取、重组**为单文件 `index.json`（字段重排 + 加 `catZh` 中文字段 + 加 `shortFriendly` 派生标记） | **改编（derivative）** |
| 归属/来源标注（上游 `ATTRIBUTION.md`） | **未随索引分发** —— 只在 `index.json` 里保留 `upstream` 指针（仓库 + commit），便于复核溯源 | 省略 |
| `demos/`、`template/`、`assets/` 等一切代码与资产 | **未使用** | 无 |

**修改声明（原文声明，按 §4(b) 要求）**：

> This product includes software developed as part of
> [`Vincentwei1021/video-shotcraft`](https://github.com/Vincentwei1021/video-shotcraft)
> (Copyright 2026 Wei Yihao), licensed under the Apache License, Version 2.0.
>
> **Changes made**: The original shot-card Markdown files were parsed, extracted,
> and restructured into a single JSON index (`kit/shotcraft/index.json`).
> Fields were reorganized, a Chinese category label (`catZh`) was added, and a
> derived `shortFriendly` flag was computed.
> **No source code, video samples, images, fonts, audio, or brand assets were copied.**
>
> **Nothing from the upstream `references/` docs is redistributed either** — nor its
> `demos/`, `template/`, `workbench/` (Remotion stack), `gallery/`
> (214 video samples, 131 MB), or `assets/` (audio, 36 MB).
> **Only the parsed index is redistributed.**
> The retrieval, audit, and planning tools in `kit/shotcraft/*.mjs`
> (`index.mjs` / `pick.mjs` / `term.mjs` / `plan.mjs`) are entirely original work.

### 2.4 许可副本在哪

- 完整的 Apache-2.0 文本：**[`licenses/video-shotcraft-LICENSE.txt`](licenses/video-shotcraft-LICENSE.txt)**
- 上游仓库：<https://github.com/Vincentwei1021/video-shotcraft>
- 在线看 214 个样片（无需下载）：<https://vincentwei1021.github.io/video-shotcraft/>
- 我们解析时的上游版本：**commit `bdd94be16d60fa8f`**（写死在 `kit/shotcraft/index.json` 的 `upstream` 字段里，可复核）
- ⚠️ **上游的卡片原文不随本仓分发** —— 本仓库只带**已解析的索引成品**
  （`index.json` 里检索与选型需要的字段都在）。
  想读卡片原文、或想自己重跑 `index.mjs` 重建索引，直接 clone 上游即可（链接同上）。

### 2.5 上游自己的合规口径（值得抄）

上游在 `references/shots/ATTRIBUTION.md` 里立了一条很有价值的边界，我们**完全认同并沿用**：

> 抽象的动效**手法/技法**（时序结构、缓动思路、编排逻辑）一般属于方法与创意范畴；
> 但**具体表达**（原片的画面、美术、文案、品牌元素、可辨识的整体视听呈现）受版权与商标保护。
> 来源作品"公开发布"**不等于**授予复刻或衍生的许可。

**⇒ 落到本仓库**：`kit/shotcraft/` 只承载**手法知识**（参数、时序、坑），
**不含任何参考片的画面、截图、美术或品牌元素**。你用它做出来的片子，画面是你自己的。

### 2.6 商标

`video-shotcraft` 的名称、作者署名及一切相关商标归 **Wei Yihao** 所有。
本项目与上游**无关联、未获其背书**；引用名称仅为**指明来源**（nominative use）。
None of the upstream author's trademarks are used to imply endorsement.

---

## 三、`动效设计师` 术语库 —— 作者自有，不是第三方

`kit/shotcraft/terms-index.json`（618 条 / 38 类）来自作者**自建的本地知识库**
（原始路径 `<你的术语库>/data`），是每天自动扩库的活库。
**它不是第三方项目**，随本仓库以 MIT 分发。

术语卡里会**提到**一些开源动效引擎（GSAP、Mo.js、anime.js、Lottie 等）——
那是**知识性描述**（"这个效果可以用 X 实现"），**不是分发的代码**。

> ⚠️ **别人 clone 之后注意**：`term.mjs` 默认去那个 D 盘路径找源库，**你机器上不会有**。
> 两个选择：① 用 `--index` 只读仓库里这份**索引快照**（够用，检索/查参数都能跑）；
> ② 设环境变量 `MOTION_TERMS_DIR=<你的路径>` 指向你自己的术语库。
> 详见 `kit/shotcraft/README.md`。

---

## 四、不随仓库分发、但**你需要自备**的运行时依赖

这些是**装在你机器上**的，仓库里没有它们的字节。各自的许可由它们自己负责。

| 依赖 | 装法 | 许可提醒 |
|---|---|---|
| **Node.js ≥ 18** | 官网 | MIT |
| **Python 3.11+** | 官网 | PSF-2.0 |
| **`puppeteer-core`** | `npm i --no-save --no-package-lock puppeteer-core` | Apache-2.0 |
| **Google Chrome** | 官网 | **专有软件**，免费使用；商用前请读其条款 |
| **FFmpeg** | `winget install Gyan.FFmpeg` / 官网 | ⚠️ **LGPL 或 GPL，取决于编译方式** —— 你若**分发**含 FFmpeg 的衍生产品，需自行确认许可义务（Gyan 构建为 GPL） |

---

## 五、只在文档里被"提到"、代码里**没用到**的东西

| 名字 | 为什么会出现 |
|---|---|
| **Remotion** | 上游 `video-shotcraft` 的技术栈。**本仓库不用它** —— 我们是 HTML/JS 纯函数栈。⚠️ Remotion 是**专有许可**（个人/小团队免费，**公司需付费**）；你若改走 Remotion 路线，请自行确认。 |
| **Mixkit / Pixabay / Kenney / Sonniss / Freesound** | 音效素材来源（**均免费可商用**）。**本仓库不含任何音频文件** —— 只在 [`docs/音效获取指南.md`](docs/音效获取指南.md) 里给「去哪下 · 许可口径 · 三个坑」。⚠️ **Freesound 许可逐条不同**：`CC-BY-NC` **禁止商用**。⚠️ **BBC Sound Effects 仅限个人/教育/研究**，商用不能碰。 |
| **unDraw / Iconify** | 素材底座的推荐来源（各自为开源许可）。**未随本仓库分发。** |
| **GSAP / Mo.js / anime.js / Lottie** | 术语卡正文里的**知识性引用**（如"用 Mo.js 做轨迹图形"）。**未分发其代码，也未依赖其运行时。** |
| **迪士尼 12 原理 / Vlambeer 屏幕震动讲座**等 | 术语卡与卡片的知识来源（公开的动画理论）。**属思想与方法的引用。** |

---

## 六、本仓库的原创部分（MIT）

除 §二 那一份卡片索引外，**下列全部为原创**：

- `kit/` 下 **45 个工具**：`render-core.js`（渲染引擎）· `export-engine.js`（取帧）·
  `new_project.js`（脚手架）· `trial.js`（总审判器）· `palette_pick.cjs`（配色研判）·
  `camera3d.js` / `camera-lens.js` / `camera-shots.js`（3D 摄影机）·
  `fx-runtime.js` / `fx-components.css` / `fx-uipack.js`（效果运行时）·
  各门禁（`layout_check` / `boxchk` / `contrast_check` / `carry_check` / `quad_check` / `probe`）等
- `kit/shotcraft/` 的**检索与审计层**：`index.mjs` / `pick.mjs` / `term.mjs` / `plan.mjs`
  （含"两轮检索""对象词降权 −1.50""幻觉卡名校验"等**实测得出**的机制）
- `kit/templates/`（2D/3D 骨架 + 样例分镜表）· `examples/hello-voice/`
- `docs/` 全部文档 · 中英 README · `preview.png`

---

## 七、如果你是权利人 / If you are a rights holder

认为本仓库某处仍越界（遗漏署名、误用、不当复制具体表达），**请开 issue**，
我们会在核实后**及时调整或移除**相应内容与标注。

If you believe any content here infringes your rights, please open an issue —
we will adjust or remove it promptly after verification.

---

*本文件随仓库以 MIT 分发；其中转述的第三方许可条款以各权利人原文为准。*
*This file is distributed under the repository's MIT license; quoted third-party terms are governed by their originals.*
