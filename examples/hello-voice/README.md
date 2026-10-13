# hello-voice · 示例工程

这是用仓库里的样例分镜表生成的一个**可以直接跑通**的工程。

```bash
# 从仓库根目录
node kit/new_project.js --spec kit/templates/spec.example.json --out examples/hello-voice --force
cd examples/hello-voice
node _render.js                       # → demo.mp4（3840×2160 · 30fps · 361 帧 · 12.03s）
```

---

## 里面有什么

| 文件 | 说明 |
|---|---|
| `fx_demo.html` | 工程主文件。**自包含**（运行时与样式已内联），双击就能在浏览器里打开、拖时间轴逐帧看 |
| `_render.js` | 渲染配置，调 `kit/render-core.js` |

> 仓库里**故意不放 `demo.mp4`**：它 13.9 MB，而跑一次只要几分钟。
> 与其存盘，不如把「怎么重跑」写清楚。

---

## 这个工程长什么样

它是**脚手架产出的初始状态** —— 每一镜都只有一句 TODO 占位（画面上的 `SHOT n · Sn · cam=xxx` 就是标记），
还没有真实内容。你要做的就是：

1. 打开 `fx_demo.html`
2. 按每镜的 `TODO` 注释填元素
3. 把元素的入场时间绑到词轴（注释里标了 `asr[i]` 的锚点位置）
4. 重新 `node _render.js`

所以这个示例的价值是：**证明你的环境是好的**，以及**让你看到工程该长什么形状**。

---

## 两处和脚手架默认产出的差异

| 差异 | 原因 |
|---|---|
| **没有 `_audit.js`** | 脚手架会多生成一个"回归体检"脚本，它依赖作者内部的另一个工具（跨项目复用），**不随本仓库发布**。需要体检请直接用 `kit/contrast_check.js` / `kit/layout_check.js` / `kit/boxchk.js`，或直接跑 `kit/trial.js` |
| **没有 `frames/`** | 那是渲染中间产物，不进版本库（已写进 `.gitignore`） |

---

## 想看"填好内容"的样子

拿你自己的配音和文案走一遍 `docs/SOP-故事地图.md` 的活动 2 → 活动 6。
或者先随便改改 `fx_demo.html` 里那几段文字，感受一下「改字 → 重渲 → 出片」的节奏。
