# -*- coding: utf-8 -*-
"""frame_sheet.py —— 抽帧拼成 contact sheet（一张图看多帧）

为什么做这个
------------------------------------------------------------------
副手 9-14 晚首次「能看图」后，86 张 L10 uim 帧图肉眼审用了 40 次 Read 调用，
太贵。下次同类审查必须把成本压一个量级 —— 一张图里塞 12 帧，Read 调用从 86 降到 8。

★★★ 2026-09-14 主 agent 修正（这段是本工具的**定位**，写错会误导下一个接手的人）
------------------------------------------------------------------
原稿写「本工具修复采样漏洞（DG-24/25 根因）」—— **这个说法不成立，已更正**：

  · **`--auto-sample` 是「选点提示」，不是「采样器」。**
    它只在**已存在的帧**里挑点（`sample = [t for t in suggest if t in frames_by_t]`），
    **不会去采新帧**。而"采样漏洞"的本质是**帧压根没被采出来** ——
    所以这个开关**在原理上就修不了采样漏洞**，只能让已有帧里的关键点优先展示。
    **实测**：`frames_uimfix` 28 张 → 建议点过滤后只剩 **15 个**，中间 4.7s 空窗**依旧存在**。

  · **要真修采样漏洞，必须改「抽帧脚本」的时间点数组**（如 `审核员/_独立脚本/l10_uim_frames.js` 的 `times`），
    让那些帧**先被采出来**；本工具只负责把它们**拼得便宜**。

  · **DG-24 / DG-25 归因不同（别混为一谈）**：
      - **DG-24（入场末帧模块压标题，t≈0.40）** = **判据覆盖域**问题，**不是采样漏洞** ——
        实测 `frames_uimfix/t0.40.jpg` 与 `frames_base/t0.40.jpg` **两套都采到了**，
        是数值判据 B4「全片零压叠」只扫 `HOLD_WINDOWS` 定帧窗口、瞬态在窗口外才漏的。
      - **DG-25（卖点行出场期文字整段旋转，t≈5.20~5.30）** = **确实是采样漏洞** ——
        `frames_base`（29 张稀疏）与 `_frames/new`（37 点均匀，步长 **0.414s**）**都没有**这 0.10s 窗口内的帧。
        根因是 **步长 > 瞬态窗口宽度**（0.414 > 0.10），属**必然漏检**，不是经验不足。

  因此本工具的四段密采样建议**依然有价值**（它告诉你"该采哪里"），
  但**必须先把帧采出来**才有意义（配合 `--tolerance` 用容差就近匹配，避免出现空白格）。

用法
------------------------------------------------------------------
  python kit/frame_sheet.py <帧目录> [更多帧目录...]
      --glob 't*.jpg'         文件名模式（默认 t*.jpg）
      --times-json times.json 索引命名模式：读时间点数组，与**排序后**的文件名下标一一对应
                              （用于 `f_000.png` 这类不含时间的命名；DG-23「不打印我查了谁」的反面）
      --cols 4 --rows 3       每页 4×3=12 帧（默认）
      --cell-w 480            单格宽 px（默认 480）
      --cell-h 270            单格高 px（默认 270，保持 16:9）
      --tolerance 0.06        就近匹配容差（秒）。建议点没有精确帧时，用容差内最近的帧顶上；
                              超出容差才显示 [missing]。
      --out sheet.png         输出前缀（多页自动 +_%02d.png）
      --label-size 16         时间戳字号（默认 16）
      --no-label              关闭时间戳
      --auto-sample           按四段密采样给出「建议时间点」（**仅筛选已存在的帧**，不采帧）
      --dur 9.52              总时长（秒）。auto-sample 的段边界按此推算，默认 9.52 = L10

示例
------------------------------------------------------------------
  # 把 4 套对照（base/uim/uimfix/fix）一次性各出 1 张 12 帧拼图
  python kit/frame_sheet.py 审核员/_独立脚本/frames_uimfix --auto-sample --out _audit_uimfix.png
  python kit/frame_sheet.py 审核员/_独立脚本/frames_uim    --auto-sample --out _audit_uim.png

  # 4 套拼成 4 列 ×12 行的对照图（A/B 比对用）
  python kit/frame_sheet.py 审核员/_独立脚本/frames_base 审核员/_独立脚本/frames_uim 审核员/_独立脚本/frames_uimfix 审核员/_独立脚本/frames_fix --auto-sample --cols 4 --rows 12 --out _audit_4up.png

  # ★ 审核员 `f_000.png` 型产出（配合 l10_uim_frames.js 写出的 times.json）
  python kit/frame_sheet.py 审核员/_独立脚本/_frames/new --glob 'f_*.png' \
         --times-json 审核员/_独立脚本/_frames/times.json --out _audit_new.png

判据 / 约定
------------------------------------------------------------------
  · 单格默认 480×270（16:9）—— 1920×1080 → 缩 4×，人眼能看清主体但文件小
  · 时间戳取自文件名 tN.jpg → 显示 "N" 秒；索引模式取自 times.json
  · 多页自动 _page01/page02...（每页 12 帧封顶，多了分页）
  · 标签字号 16 ~ 32 —— cell-w 越大字号越大（保持视觉比例）
"""
import os
import sys
import json
import glob as _glob
import math

# ---------- fail fast：第三方依赖（缺了给安装命令，不给裸 traceback）----------
#   ★ 2026-10-09：此前这里直接 `import numpy` / `from PIL import ...`，
#     缺包时抛的是**裸 ModuleNotFoundError traceback** —— 用户看不出「该放 venv」
#     也看不出「仓库自带一个能全体检 + 自动装的工具」。
_MISSING = []
try:
    import numpy as np
except ImportError:
    _MISSING.append("numpy")
try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    _MISSING.append("Pillow")

if _MISSING:
    sys.stderr.write(
        "FAIL: 缺依赖 %s\n"
        "  装法（建议放项目 venv，别污染系统 Python）：\n"
        "    python -m venv .venv\n"
        "    .venv\\Scripts\\activate        # macOS / Linux: source .venv/bin/activate\n"
        "    pip install %s\n"
        "  或在仓库根目录跑 `node kit/check_env.js` 看全套环境"
        "（Node / Chrome / ffmpeg / 中文字体 一起体检）\n"
        % (", ".join(_MISSING), " ".join(_MISSING))
    )
    sys.exit(1)


def parse_time(name):
    """t1.23.jpg → 1.23 ; 不匹配 → None"""
    base = os.path.splitext(os.path.basename(name))[0]
    if not base.startswith('t'):
        return None
    try:
        return float(base[1:])
    except ValueError:
        return None


def suggest_sample_points(total_dur=9.52, fps=30):
    """给出「该在哪里密采样」的**建议点**（★ 只提示，不采帧）

    ★ 2026-09-14 更正：本函数**不能修复采样漏洞**。
      它只输出建议点，真正的帧必须由**抽帧脚本**先采出来 ——
      下游 `--auto-sample` 只是在已有帧里过滤（`sample = [t for t in sug if t in frames_by_t]`），
      **变不出没采的帧**。实测 `frames_uimfix` 28 张 → 过滤后仅 15 点，中间 4.7s 空窗依旧。

      要真修采样漏洞，请改抽帧脚本的 `times`（如 `审核员/_独立脚本/l10_uim_frames.js`）。

    四段密采样依据（L10 两个真缺陷的高发区 + 通用瞬态规律）：
      · 入场末帧（t=0.30~0.50）= 位移/旋转落点冲突        → DG-24 现场
      · S2 末段出场（t=5.10~5.40）= 旋转/位移退场失控     → DG-25 现场（步长必须 < 0.10s 才抓得到）
      · S2→S3 过渡（t≈5.36）= 多元素同时淡入的遮挡
      · S3 揭幕（t=5.50~6.00）= 主元素到位 + 装饰入场
    ★ 段边界按 `total_dur / 9.52` 比例缩放，换工程传 `--dur` 即可（不再硬编码 L10 魔数）。
    """
    k = total_dur / 9.52                     # 以 L10 为基准的缩放系数

    def sc(ts):
        return [round(t * k, 3) for t in ts]

    pts = []
    pts += sc([0.00, 0.10, 0.20, 0.30, 0.35, 0.40, 0.45])          # ① 入场末帧
    pts += sc([0.50, 0.90, 1.30, 1.70])                            # ② S1 卖点行
    pts += sc([2.50, 3.00, 3.50, 4.00, 4.50])                      # ③ S2 卖点行
    pts += sc([4.86, 5.00, 5.10, 5.16, 5.20, 5.25, 5.30, 5.35])    # ④ S2 末段出场（DG-25）
    pts += sc([5.36])                                              # ⑤ S2→S3 过渡
    pts += sc([5.40, 5.50, 5.60, 5.80, 5.95])                      # ⑥ S3 揭幕
    pts += sc([6.57, 7.20, 7.44, 7.54, 8.00, 8.33, 9.06, 9.12, 9.45])  # ⑦ S3 稳定
    return sorted(set(t for t in pts if t <= total_dur + 1e-6))


def pick_at(frames_by_t, t, tol=0.06):
    """就近取帧：精确命中优先，否则在 tol 秒内取最近的一帧。

    ★ 2026-09-14 接上 —— 原 `nearest_frame()` 是**死代码**（定义了但无人调用），
      `make_sheet` 用的是精确匹配 `frames_by_t.get(t, [])`。
      后果：auto-sample 的建议点只要和实帧差一点点（建议 5.35 / 实帧 5.30）就画成空框，
      末页还会出现大片纯空白 —— 视觉上很像"渲染失败"，实测 p02 只有 3/12 格有内容。

    返回 `(帧列表, 实际使用的时间点)`；都不匹配则 `(None, None)`。
    """
    if not frames_by_t:
        return None, None
    if t in frames_by_t:
        return frames_by_t[t], t
    best, bd = None, None
    for k in frames_by_t:
        d = abs(k - t)
        if bd is None or d < bd:
            best, bd = k, d
    if best is not None and bd is not None and bd <= tol:
        return frames_by_t[best], best
    return None, None


def collect_frames(dirs, glob_pat='t*.jpg', times_json=None):
    """从多个目录收帧，返回 `{time: [(dir_idx, path), ...]}`

    ★ 2026-09-14 加 `times_json` —— 索引命名模式。
      审核员脚本 `l10_uim_frames.js` 产出的是 `f_000.png`（**文件名不含时间**，
      时间点在旁边的 `_frames/times.json`），而本工具原来只认 `t<数字>.jpg`
      → **两个工具之间的命名契约完全不通，等于跑不起来**。
      传了 `--times-json` 后，文件名按**排序后的下标**去时间数组取值。
    """
    ext_times = None
    if times_json:
        try:
            with open(times_json, encoding='utf-8') as fh:
                ext_times = json.load(fh)
            print(f"[info] times-json: {times_json} → {len(ext_times)} 个时间点")
        except Exception as e:
            print(f"[warn] 读不到 times-json（{e}），回退到文件名解析")
            ext_times = None

    by_t = {}
    for idx, d in enumerate(dirs):
        if not os.path.isdir(d):
            print(f"[warn] {d} is not a directory, skipping")
            continue
        paths = sorted(_glob.glob(os.path.join(d, glob_pat)))
        n_by_name = 0
        for i, p in enumerate(paths):
            t = parse_time(p)
            if t is None and ext_times is not None and i < len(ext_times):
                # 索引模式：文件名不含时间 → 用排序下标查 times.json
                try:
                    t = float(ext_times[i])
                except (TypeError, ValueError):
                    t = None
            if t is None:
                continue
            n_by_name += 1
            by_t.setdefault(t, []).append((idx, p))
        if paths and n_by_name == 0:
            print(f"[warn] {d}: 找到 {len(paths)} 个文件但**一个时间都解析不出** —— "
                  f"glob={glob_pat} 与命名不匹配？试试 --glob 'f_*.png' --times-json <times.json>")
    return by_t


def make_sheet(frames_by_t, dir_labels, sample_times, cols, rows, cell_w, cell_h,
               label_size, with_label, out_path, tol=0.06):
    """拼一页。两种布局：
       · 单目录：cols × rows 网格（cols 用作实际列数，rows 用作行数）= 默认 4×3
       · 多目录：每个目录一列，时间点沿行展开（cols 参数改作行数 = 每页时间点）
    """
    n_dirs = len(dir_labels)
    n_times = len(sample_times)
    is_single = (n_dirs == 1)
    if is_single:
        # 单目录网格：cols × rows
        n_cols = max(cols, 1)
        n_rows_per_page = max(rows, 1)
        cols_per_row = n_cols
        page_w = n_cols * cell_w
        rows_pages = math.ceil(n_times / (n_cols * n_rows_per_page))
        # 实际单页放 n_cols * n_rows_per_page 帧
        cells_per_page = n_cols * n_rows_per_page
    else:
        # 多目录 A/B：每个目录一列，沿时间点排列
        cols_per_row = n_dirs
        n_rows_per_page = max(rows, 1)
        cells_per_page = n_cols_per_page = cols_per_row * n_rows_per_page
        page_w = cols_per_row * cell_w
        rows_pages = math.ceil(n_times / n_rows_per_page)

    written = []
    for pg in range(rows_pages):
        t_slice = sample_times[pg * n_rows_per_page * (1 if is_single else 1) : (pg + 1) * n_rows_per_page * (1 if is_single else 1)]
        if is_single:
            # 单目录：cells_per_page 帧，cols × rows 排
            t_slice = sample_times[pg * cells_per_page : (pg + 1) * cells_per_page]
        else:
            t_slice = sample_times[pg * n_rows_per_page : (pg + 1) * n_rows_per_page]

        page_h = n_rows_per_page * cell_h + 36
        canvas = Image.new('RGB', (page_w, page_h), '#0B1220')
        draw = ImageDraw.Draw(canvas)
        try:
            font_lbl = ImageFont.truetype('arial.ttf', label_size)
            font_hdr = ImageFont.truetype('arialbd.ttf', label_size + 4)
        except Exception:
            font_lbl = ImageFont.load_default()
            font_hdr = font_lbl

        if is_single:
            # 顶部：单目录名（居中）
            draw.text((10, 6), dir_labels[0], fill='#00E5D4', font=font_hdr)
            for idx, t in enumerate(t_slice):
                col = idx % cols_per_row
                row = idx // cols_per_row
                x = col * cell_w
                y = row * cell_h + 36
                draw.rectangle([x + 1, y + 1, x + cell_w - 2, y + cell_h - 2],
                               outline='#1f2e4a', width=1)
                lst, used = pick_at(frames_by_t, t, tol)
                src = lst[0][1] if lst else None
                if src is None:
                    draw.text((x + 14, y + cell_h // 2 - 10),
                              f"[missing t={t:.2f}]", fill='#5C7393', font=font_lbl)
                else:
                    im = Image.open(src).convert('RGB')
                    im.thumbnail((cell_w - 6, cell_h - 6), Image.LANCZOS)
                    iw, ih = im.size
                    canvas.paste(im, (x + (cell_w - iw) // 2, y + (cell_h - ih) // 2))
                if with_label:
                    # ★ 标签显示**实际用到**的时间点（容差匹配后可能与建议点不同）
                    lab = used if used is not None else t
                    draw.text((x + 8, y + cell_h - label_size - 6),
                              f"t={lab:.2f}", fill='#00E5D4', font=font_lbl)
        else:
            # 多目录 A/B：每列一个 dir，每行一个 t
            for ci, name in enumerate(dir_labels):
                draw.text((ci * cell_w + 10, 6), name, fill='#00E5D4', font=font_hdr)
            for ri, t in enumerate(t_slice):
                for ci in range(cols_per_row):
                    x = ci * cell_w
                    y = ri * cell_h + 36
                    draw.rectangle([x + 1, y + 1, x + cell_w - 2, y + cell_h - 2],
                                   outline='#1f2e4a', width=1)
                    lst, used = pick_at(frames_by_t, t, tol)
                    src = None
                    for di, p in (lst or []):
                        if di == ci:
                            src = p; break
                    if src is None:
                        draw.text((x + 14, y + cell_h // 2 - 10),
                                  f"[missing t={t:.2f}]", fill='#5C7393', font=font_lbl)
                    else:
                        im = Image.open(src).convert('RGB')
                        im.thumbnail((cell_w - 6, cell_h - 6), Image.LANCZOS)
                        iw, ih = im.size
                        canvas.paste(im, (x + (cell_w - iw) // 2, y + (cell_h - ih) // 2))
                    if with_label:
                        lab = used if used is not None else t
                        draw.text((x + 8, y + cell_h - label_size - 6),
                                  f"t={lab:.2f}", fill='#00E5D4', font=font_lbl)

        if rows_pages == 1:
            target = out_path
        else:
            base, ext = os.path.splitext(out_path)
            target = f"{base}_p{pg + 1:02d}{ext or '.png'}"
        canvas.save(target, 'PNG')
        written.append(target)
        print(f"[ok] page {pg + 1}/{rows_pages}: {canvas.size[0]}×{canvas.size[1]} → {target}")
    return written


def main():
    args = sys.argv[1:]
    if not args or args[0] in ('-h', '--help'):
        print(__doc__)
        return 0
    dirs = []
    glob_pat = 't*.jpg'
    cols = 4  # 兼容参数（实际列数 = len(dirs)）
    rows = 12
    cell_w = 480
    cell_h = 270
    out = 'sheet.png'
    label_size = 16
    with_label = True
    auto_sample = False
    times_json = None
    tol = 0.06
    dur = 9.52
    i = 0
    while i < len(args):
        a = args[i]
        if a == '--glob':
            glob_pat = args[i + 1]; i += 2
        elif a == '--times-json':
            times_json = args[i + 1]; i += 2
        elif a == '--tolerance':
            tol = float(args[i + 1]); i += 2
        elif a == '--dur':
            dur = float(args[i + 1]); i += 2
        elif a == '--cols':
            cols = int(args[i + 1]); i += 2
        elif a == '--rows':
            rows = int(args[i + 1]); i += 2
        elif a == '--cell-w':
            cell_w = int(args[i + 1]); i += 2
        elif a == '--cell-h':
            cell_h = int(args[i + 1]); i += 2
        elif a == '--out':
            out = args[i + 1]; i += 2
        elif a == '--label-size':
            label_size = int(args[i + 1]); i += 2
        elif a == '--no-label':
            with_label = False; i += 1
        elif a == '--auto-sample':
            auto_sample = True; i += 1
        elif a.startswith('--'):
            print(f"[warn] unknown arg {a}, ignored"); i += 1
        else:
            dirs.append(a); i += 1
    if not dirs:
        print("ERROR: need at least one frames dir"); return 1
    print(f"[info] {len(dirs)} dirs, glob={glob_pat}, rows={rows}, cell={cell_w}×{cell_h}, tol={tol}s")
    frames_by_t = collect_frames(dirs, glob_pat, times_json)
    times = sorted(frames_by_t.keys())
    print(f"[info] collected {sum(len(v) for v in frames_by_t.values())} frames across {len(times)} distinct timestamps")
    if auto_sample:
        sug = suggest_sample_points(dur)
        # ★ 只是在**已有帧**里挑（本工具不采帧）—— 命中 / 缺失都要报出来，
        #   否则用户会以为"跑了 auto-sample 就没漏洞了"（原版就是这样静默吞掉的）。
        hit = [t for t in sug if t in frames_by_t]
        miss = [t for t in sug if t not in frames_by_t]
        print(f"[info] auto-sample 建议 {len(sug)} 点 → 命中 {len(hit)} · 缺失 {len(miss)}"
              f"（容差 {tol}s 内可就近顶替）")
        if miss:
            print(f"[warn] ★ 缺失点（本工具**不采帧**，要补必须回去改抽帧脚本的 times）：")
            print(f"       {miss}")
        sample = hit
        if not sample:
            print("[warn] 建议点一个都没命中 —— 检查 --glob / --times-json 是否匹配你的命名")
    else:
        sample = times
    dir_labels = [os.path.basename(os.path.normpath(d)) for d in dirs]
    written = make_sheet(frames_by_t, dir_labels, sample, cols, rows, cell_w, cell_h,
                         label_size, with_label, out, tol)
    print(f"[done] {len(written)} sheet(s) written")
    return 0


if __name__ == '__main__':
    sys.exit(main())