# -*- coding: utf-8 -*-
"""全片「内容量」一维扫描 —— 用两条一维信号替代「盲抽 12 帧肉眼看」。

作用：把「哪一段没内容 / 哪一段最该盯」变成一条命令给出的区间列表 + ASCII 趋势条。
不做判决，只做**定位**；定位到具体帧之后才人眼 Read 那几帧（把 Read 预算花在刀刃上）。

两个独立量（互为交叉验证）：
  ① LAP  拉普拉斯方差 = 边缘锐度能量（柔和渐变/云底；文字/卡片/产品图高）
  ② EDGE 强边像素占比（|∇|>18）
为什么必须两个：背景的太阳有硬边、云有软边，单量会被干扰；**两量同时**掉到各自 P10 才算谷底。

★ 关键设计：`--ref` 对照件。只有把本版谷底与参考件谷底逐项对上，才能区分
  「继承基线（参考件也有）」与「本版新引入（参考件没有）」。
  不看对照件就看谷底 = 会把老问题当新 bug 报，或把新 bug 当老问题放过。

用法：
  python content_scan.py --video <mp4> [--ref <mp4>] [--fps 30] [--json out.json] [--keep-tmp]

退出码：0 正常 / 1 缺依赖或输入不存在（fail fast）/ 2 参数错
"""
import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile

# ---------- fail fast：输入依赖写在最前面 ----------
MISSING = []
try:
    import numpy as np
except ImportError:
    MISSING.append("numpy")
try:
    from PIL import Image
except ImportError:
    MISSING.append("Pillow")


def which_ffmpeg():
    for cand in ("ffmpeg", "ffmpeg.exe"):
        p = shutil.which(cand)
        if p:
            return p
    for root in (r"C:\Program Files\WinGet\Packages", os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Packages")):
        for hit in glob.glob(os.path.join(root, "Gyan.FFmpeg*", "**", "bin", "ffmpeg.exe"), recursive=True):
            return hit
    return None


def die(msg, code=1):
    sys.stderr.write("FAIL: %s\n" % msg)
    sys.exit(code)


def percentile_row(name, arr, fmt):
    q = np.percentile(arr, [0, 5, 10, 50, 90, 100])
    return "  %-4s P0 %s  P5 %s  P10 %s  P50 %s  P90 %s  P100 %s" % (
        name, *(fmt % v for v in q))


def runs_of(mask):
    out, s = [], None
    for i, v in enumerate(mask):
        if v and s is None:
            s = i
        if not v and s is not None:
            out.append((s, i - 1))
            s = None
    if s is not None:
        out.append((s, len(mask) - 1))
    return out


def deep_gaps(laps, edges, min_frames=3):
    """「有意义」的谷底：长度 ≥ min_frames 帧，或够深（min LAP ≤ 0.5×P10）。

    为什么要这道过滤：P10 阈值本身会切出一堆 1~2 帧、LAP 恰好骑在阈值上的**噪声 run**
    （实测 en3 有 3 条 0.03~0.07s、LAP 41~50 而阈值正好 50.5）—— 它们不是空窗，
    拿它们做对照只会产出假「待核」。过滤后剩下的才是「这一段真没内容」。
    两侧必须用同一函数，否则又是「期望值与实测值不同口径」。
    """
    th_l, th_e = np.percentile(laps, 10), np.percentile(edges, 10)
    low = (laps <= th_l) & (edges <= th_e)
    out = []
    for a, b in runs_of(low):
        if (b - a + 1) >= min_frames or laps[a:b + 1].min() <= 0.5 * th_l:
            out.append((a, b))
    return out, low, th_l, th_e


SPARK = " .:-=+*#%@"


def sparkline(arr, cols=78):
    """把一维序列压成 cols 格的 ASCII 趋势条（低=空，高=满）。"""
    if len(arr) == 0:
        return ""
    n = len(arr)
    out = []
    for c in range(cols):
        a = int(c * n / cols)
        b = max(a + 1, int((c + 1) * n / cols))
        seg = arr[a:b]
        out.append(SPARK[min(len(SPARK) - 1, int(np.percentile(seg, 90) / 100.0 * (len(SPARK) - 1) + 0.5))])
    return "".join(out)


def extract(video, outdir, width, fps_hint):
    if not os.path.exists(video):
        die("视频不存在: %s" % video)
    os.makedirs(outdir, exist_ok=True)
    cmd = [FFMPEG, "-v", "error", "-y", "-i", video,
           "-vf", "scale=%d:-1" % width, "-q:v", "3", "-vsync", "0",
           os.path.join(outdir, "f%05d.jpg")]
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if r.returncode != 0:
        die("抽帧失败: %s" % r.stderr.decode("utf-8", "ignore")[:300])
    fs = sorted(glob.glob(os.path.join(outdir, "*.jpg")))
    if not fs:
        die("抽帧产出 0 帧: %s" % video)
    return fs


def scan(fs):
    lap = np.zeros(len(fs))
    edge = np.zeros(len(fs))
    for i, f in enumerate(fs):
        a = np.asarray(Image.open(f).convert("L"), dtype=np.float32)
        L = (a[:-2, 1:-1] + a[2:, 1:-1] + a[1:-1, :-2] + a[1:-1, 2:] - 4 * a[1:-1, 1:-1])
        lap[i] = L.var()
        gx = np.abs(np.diff(a, axis=1))
        gy = np.abs(np.diff(a, axis=0))
        edge[i] = float((np.maximum(gx[:-1, :], gy[:, :-1]) > 18).mean())
    return lap, edge


def report(tag, laps, edges, fps):
    print("=== %s · 帧数 %d · fps %.2f · 时长 %.3fs ===" % (tag, len(laps), fps, len(laps) / fps))
    print(percentile_row("LAP", laps, "%8.2f"))
    print(percentile_row("EDGE", edges * 100, "%7.3f%%"))
    print("  LAP 趋势（低=空 → 高=满）")
    print("  |" + sparkline(laps) + "|")
    print("  |%-78s|" % ("0s" + " " * 68 + "%.1fs" % (len(laps) / fps)))
    th_l, th_e = np.percentile(laps, 10), np.percentile(edges, 10)
    low = (laps <= th_l) & (edges <= th_e)
    gaps = runs_of(low)
    print("  === 谷底区间（LAP<=%.2f 且 EDGE<=%.3f%% · 两量同时命中）===" % (th_l, th_e * 100))
    deep, _, _, _ = deep_gaps(laps, edges)
    gaps = runs_of(low)
    if not gaps:
        print("    （无）")
    for a, b in gaps:
        mark = "★显著" if (a, b) in deep else "  噪声"
        print("  %s 帧 %3d~%3d  t=%6.2f~%6.2f (%4.2fs)  LAPmin %7.2f  EDGEmin %5.2f%%"
              % (mark, a, b, a / fps, b / fps, (b - a + 1) / fps,
                 laps[a:b + 1].min(), edges[a:b + 1].min() * 100))
    print("    ★显著 = 长度≥3 帧 或 min LAP ≤ 0.5×P10（真没内容）；噪声 = 骑在 P10 上的 1~2 帧抖动。")
    print("  === 全片最低 12 帧 ===")
    for i in sorted(np.argsort(laps)[:12]):
        print("    帧 %3d  t=%6.2f  LAP %7.2f  EDGE %5.2f%%" % (i, i / fps, laps[i], edges[i] * 100))
    return gaps, th_l, th_e


def dtw_path(sa, sb, band_frac=0.12):
    """动态时间规整（DTW）：用信号本身把两条片子对齐，不假设任何时间关系。

    sa/sb: (N,) 或 (N,K) 特征序列（本工具用 LAP + EDGE 两列，各自 z 标准化后逐列比较）。
    返回 path = [(i, j), ...]，单调不减。
    为什么必须 DTW：翻译版时长不同（en 13.0s / zh 11.0s），且**镜头时机不是等比缩放**
    —— 帧号对齐、归一化时间对齐**都试过、都错**（会把老空窗错位读成新引入 = 假阳性）。
    band_frac: Sakoe-Chiba 带宽，限制局部翘曲，防止「随便扭到哪都算对齐」。
    """
    a = np.asarray(sa, dtype=np.float64)
    b = np.asarray(sb, dtype=np.float64)
    if a.ndim == 1:
        a = a[:, None]
    if b.ndim == 1:
        b = b[:, None]
    a = (a - a.mean(0)) / (a.std(0) + 1e-9)
    b = (b - b.mean(0)) / (b.std(0) + 1e-9)
    na, nb = len(a), len(b)
    band = max(4, int(max(na, nb) * band_frac))
    ratio = float(nb) / na
    INF = float("inf")
    D = np.full((na, nb), INF)
    for i in range(na):
        # ⚠️ 带宽必须**围绕期望对角线 j≈i·nb/na**，不能写成 |i-j|<=band：
        #    两片时长不等时（390 vs 330），后者会把终点 (na-1, nb-1) 也排除在带外
        #    ⇒ 整条路径不存在、DTW 直接失败（首版就栽在这）。
        c = int(round(i * ratio))
        j_lo = max(0, c - band)
        j_hi = min(nb, c + band + 1)
        for j in range(j_lo, j_hi):
            cost = float(np.abs(a[i] - b[j]).sum())
            if i == 0 and j == 0:
                D[i, j] = cost
                continue
            prev = INF
            if i > 0:
                prev = min(prev, D[i - 1, j])
            if j > 0:
                prev = min(prev, D[i, j - 1])
            if i > 0 and j > 0:
                prev = min(prev, D[i - 1, j - 1])
            D[i, j] = cost + prev
    i, j = na - 1, nb - 1
    if D[i, j] == INF:
        return None
    path = [(i, j)]
    while i > 0 or j > 0:
        cands = []
        if i > 0 and j > 0:
            cands.append((D[i - 1, j - 1], i - 1, j - 1))
        if i > 0:
            cands.append((D[i - 1, j], i - 1, j))
        if j > 0:
            cands.append((D[i, j - 1], i, j - 1))
        _, i, j = min(cands)
        path.append((i, j))
    path.reverse()
    return path


def compare(tag_a, laps_a, edges_a, tag_b, laps_b, edges_b, fps_a, fps_b):
    """把 A 的谷底分成「B 也有（继承基线）」与「B 没有（待核）」两组。

    ⚠️ 对齐口径（本函数的命根子，同一坑踩过两次）：
      ① 帧号对齐 —— 时长不同时必然错位；
      ② 归一化时间对齐 —— 时长不同时**同样错位**（实测：en 234 帧 = 7.80s，归一化后
         映射到 zh 6.60s，而 zh 真值在 6.13s ⇒ 判成「本版新引入」，纯假阳性）。
    ⇒ 所以改用 **DTW 按信号自身对齐**，并把对齐质量（斜率 vs 时长比、单调性、带宽）打出来。
    判定：只在**显著谷底**（`deep_gaps`）之间比 —— A 的显著谷底经 DTW 映射到 B 的帧窗，
    若 B 侧的显著谷底列表里有任一条与该窗相交 ⇒ 继承基线；否则待核。
    （不用「B 窗内低内容占比≥50%」：窗宽可变，同一个真谷底会因垫了几个 padding 帧
      从 62.5% 掉到 45.5% ⇒ 判据自己制造假「待核」。）
    """
    fa = np.stack([laps_a, edges_a * 1000.0], 1)
    fb = np.stack([laps_b, edges_b * 1000.0], 1)
    path = dtw_path(fa, fb)
    gaps_a, low_a, _, _ = deep_gaps(laps_a, edges_a)
    gaps_b, _, _, _ = deep_gaps(laps_b, edges_b)
    if path is None:
        print("\n⚠️ DTW 对齐失败（带宽内无可行路径），跳过对照；只看 A 自己的谷底。")
        return [], gaps_a
    pi = np.array([p[0] for p in path])
    pj = np.array([p[1] for p in path])
    slope = float(pj[-1] - pj[0]) / max(1, int(pi[-1] - pi[0]))
    ratio = (len(laps_b) / fps_b) / (len(laps_a) / fps_a)
    mono = bool(np.all(np.diff(pj) >= 0) and np.all(np.diff(pi) >= 0))
    band = max(4, int(max(len(laps_a), len(laps_b)) * 0.12))
    print("\n=== 对照（对齐口径：**DTW 按信号自身对齐**）: %s vs %s ===" % (tag_a, tag_b))
    print("  对齐质量自检：平均斜率 %.4f ／ 时长比 %.4f（差 %.1f%%）· 路径单调 %s · 带宽 %d 帧"
          % (slope, ratio, abs(slope - ratio) / ratio * 100.0, "是" if mono else "否", band))
    print("  → 斜率与时长比差 >10% 时局部翘曲大，本节结论只能当线索。")
    gaps_b = gaps_b
    inherited, novel = [], []
    print("  %-24s %-26s %-22s %s" % ("A 区间", "→ B 映射窗", "B 侧对应谷底", "判定"))
    for a, b in gaps_a:
        ia = int(np.clip(np.searchsorted(pi, a, "left"), 0, len(pi) - 1))
        ib = int(np.clip(np.searchsorted(pi, b, "right"), 0, len(pi) - 1))
        ma, mb = int(pj[ia]), int(pj[ib])
        ma, mb = min(ma, mb), max(ma, mb)
        # 判据：B 自己的谷底列表里有没有一条与映射窗相交。**不加 padding、不设占比阈值**
        # —— 占比阈值会因为窗宽不同而误判（首版垫 ±2 帧后真谷底 5/11=45.5% 被顶出区间 ⇒ 假「待核」）。
        hit = [g for g in gaps_b if not (g[1] < ma or g[0] > mb)]
        verdict = "继承基线" if hit else "待核"
        (inherited if hit else novel).append((a, b))
        show = ("帧%4d~%4d" % (hit[0][0], hit[0][1])) if hit else "—"
        print("  帧%4d~%-4d t=%5.2f~%5.2f  帧%4d~%-4d t=%5.2f~%5.2f  %-22s %s"
              % (a, b, a / fps_a, b / fps_a, ma, mb, ma / fps_b, mb / fps_b, show, verdict))
    print("\n  [继承基线] 参考件同位置也空 ⇒ 不要当新 bug 报：")
    print("    " + (", ".join("t=%.2f~%.2f" % (a / fps_a, b / fps_a) for a, b in inherited) or "（无）"))
    print("  [待核] 参考件同位置不空 ⇒ 要么本版新引入，要么对齐仍有残差：")
    for a, b in novel:
        print("    t=%5.2f~%5.2f (%4.2fs)  LAPmin %7.2f  EDGEmin %5.2f%%  → 抽这几帧人眼看"
              % (a / fps_a, b / fps_a, (b - a + 1) / fps_a,
                 laps_a[a:b + 1].min(), edges_a[a:b + 1].min() * 100.0))
    if not novel:
        print("    （无 ⇒ 本版未引入任何新的低内容窗口）")
    return inherited, novel


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--ref", default=None)
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--width", type=int, default=480)
    ap.add_argument("--json", default=None)
    ap.add_argument("--keep-tmp", action="store_true")
    ap.add_argument("--tmp", default=None)
    args = ap.parse_args()

    if MISSING:
        # ★ 2026-10-09：原来只写「请装到项目 venv」—— 没给命令，等于把下一步留给用户猜。
        die("缺依赖 %s\n"
            "  装法（建议放项目 venv，别污染系统 Python）：\n"
            "    python -m venv .venv\n"
            "    .venv\\Scripts\\activate        # macOS / Linux: source .venv/bin/activate\n"
            "    pip install %s\n"
            "  或在仓库根目录跑 `node kit/check_env.js` 看全套环境"
            "（Node / Chrome / ffmpeg / 中文字体 一起体检）"
            % (", ".join(MISSING), " ".join(MISSING)))
    global FFMPEG
    FFMPEG = which_ffmpeg()
    if not FFMPEG:
        die("找不到 ffmpeg（PATH 与 WinGet 目录都没有）")

    tmp = args.tmp or tempfile.mkdtemp(prefix="content_scan_")
    tag_a = os.path.splitext(os.path.basename(args.video))[0]
    res = {"video": args.video, "ref": args.ref, "fps": args.fps, "width": args.width}
    try:
        fa = extract(args.video, os.path.join(tmp, "a"), args.width, args.fps)
        la, ea = scan(fa)
        ga, tla, tea = report(tag_a, la, ea, args.fps)
        res["a"] = {"n": len(la), "gaps": [[a, b] for a, b in ga],
                    "lap_p10": float(tla), "edge_p10": float(tea * 100)}
        if args.ref:
            tag_b = os.path.splitext(os.path.basename(args.ref))[0]
            fb = extract(args.ref, os.path.join(tmp, "b"), args.width, args.fps)
            lb, eb = scan(fb)
            report(tag_b, lb, eb, args.fps)
            inh, nov = compare(tag_a, la, ea, tag_b, lb, eb, args.fps, args.fps)
            res["inherited_gaps"] = [[a, b] for a, b in inh]
            res["novel_gaps"] = [[a, b] for a, b in nov]
        if args.json:
            with open(args.json, "w", encoding="utf-8") as f:
                json.dump(res, f, ensure_ascii=False, indent=1)
            print("\nWROTE %s" % args.json)
    finally:
        if not args.keep_tmp and not args.tmp:
            shutil.rmtree(tmp, ignore_errors=True)
        elif not args.keep_tmp:
            print("（--tmp 指定，未自动清理：%s）" % tmp)
    print("\n判据口径：LAP/EDGE 读的是 **480 宽 JPEG 中间帧**，与成片像素不完全同量；"
          "本工具只做「定位」，判决仍要人眼 Read 指定帧。")
    sys.exit(0)


if __name__ == "__main__":
    main()
