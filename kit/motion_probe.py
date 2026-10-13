#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
motion_probe.py —— 视频「真实运动」量测探针（学别人技法时用）

定位：拿到一条别人的成片/转场，想复刻它的运动，**不靠眼睛猜、不靠感觉调**，
      直接把逐帧位移量出来，让数字说话。

三种模式：
  corr   逐帧穷举位移匹配 —— 量「整幅画面的主导运动」（转场速度曲线、前摇、过冲）
  color  颜色掩膜跟踪   —— 量「某个具体色块」的位移（质心 / 上边缘 / 面积）
  kymo   时序条带图     —— 时间×垂直位置的二维图，运动画成斜线，斜率=速度，一眼审判

用法：
  # 1) 整幅画面的垂直运动（转场速度曲线）
  python kit/motion_probe.py v.mp4 --t0 29.7 --t1 33 --mode corr --x 380 580 --y 60 640

  # 2) 跟踪橙红色块的上边缘（量「画面二」上升的真实轨迹）
  python kit/motion_probe.py v.mp4 --t0 29.6 --t1 33 --mode color --color red

  # 3) 条带图（肉眼审判运动形态）
  python kit/motion_probe.py v.mp4 --t0 3.8 --t1 5.3 --mode kymo --kymo out.png

  # 通用：--fps 提高采样密度（默认 30）、--maxs 搜索上限（默认 150px/帧）、--csv 落盘

自检（每次运行都打印，防"沉默的错"）：
  · 帧数校验：期望帧数 vs 实际解出帧数，不等就报错退出
  · 静止基线：整段里 dy==0 的帧占比（静止片段应接近 100%）
  · 饱和度告警：dy 撞到 ±maxs 上限的帧数（撞上限 = 真实位移更大，需调大 --maxs）
  · 置信度：匹配误差 vs 零位移误差，比值越接近 1 越不可信（转场切点处必然如此）

⚠️ 本工具只输出数字，不判断好坏。**FAIL 要分类：形状错 = 缺陷，形状对但弱 = 参数不足。**
"""

import os
import re
import sys
import csv
import glob
import shutil
import argparse
import subprocess

# ---------- fail fast：第三方依赖（缺了给安装命令，不给裸 traceback）----------
#   ★ 2026-10-09：此前缺包抛的是裸 ModuleNotFoundError traceback。
#   PIL 在本文件里是**按需 import**（只在 kymo / 拼图那几条分支里用到），
#   所以这里只探测存在性，不真把它 import 进来；numpy 顶层就要用，真 import。
import importlib.util as _ilu

_MISSING = []
try:
    import numpy as np
except ImportError:
    _MISSING.append("numpy")
if _ilu.find_spec("PIL") is None:
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

# ----------------------------------------------------------------------------- ffmpeg
_FF_CANDIDATES = [
    os.environ.get('FFMPEG_BIN'),
    os.path.expandvars(r'%LOCALAPPDATA%/Microsoft/WinGet/Links'),
    r'C:/ffmpeg/bin',
]

def find_ffmpeg(name):
    p = shutil.which(name)
    if p:
        return p
    for d in _FF_CANDIDATES:
        if not d:
            continue
        for ext in ('.exe', ''):
            c = os.path.join(d, name + ext)
            if os.path.exists(c):
                return c
    raise SystemExit('[fail] 找不到 %s —— 用 FFMPEG_BIN 指定目录' % name)


def probe(path):
    ff = find_ffmpeg('ffprobe')
    out = subprocess.run(
        [ff, '-v', 'error', '-select_streams', 'v:0', '-show_entries',
         'stream=width,height,r_frame_rate,nb_frames,duration', '-of', 'default=nw=1', path],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    txt = out.stdout.decode('utf-8', 'ignore')
    d = {}
    for line in txt.splitlines():
        if '=' in line:
            k, v = line.split('=', 1)
            d[k.strip()] = v.strip()
    w = int(d.get('width', 0)); h = int(d.get('height', 0))
    fr = d.get('r_frame_rate', '30/1')
    try:
        num, den = fr.split('/')
        fps = float(num) / float(den or 1)
    except Exception:
        fps = 30.0
    return w, h, fps


def read_frames(path, t0, t1, fps, w, h, gray=True):
    """用 ffmpeg rawvideo 管道直接读，不落盘。返回 (N,H,W[,C]) 的 uint8 数组。"""
    ff = find_ffmpeg('ffmpeg')
    pix = 'gray' if gray else 'rgb24'
    cmd = [ff, '-hide_banner', '-v', 'error', '-ss', '%.4f' % t0, '-t', '%.4f' % (t1 - t0),
           '-i', path, '-vf', 'fps=%.6f' % fps, '-f', 'rawvideo', '-pix_fmt', pix, '-']
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        sys.stderr.write(p.stderr.decode('utf-8', 'ignore')[:2000] + '\n')
        raise SystemExit('[fail] ffmpeg 解码失败')
    ch = 1 if gray else 3
    fr = w * h * ch
    n = len(p.stdout) // fr
    buf = np.frombuffer(p.stdout[:n * fr], dtype=np.uint8)
    return buf.reshape(n, h, w, ch)


# ----------------------------------------------------------------------------- 模式
def mode_corr(frames, t0, fps, x0, x1, y0, y1, maxs):
    """逐帧穷举位移匹配：找让 mean|a[y] - b[y+s]| 最小的 s。s>0 表示内容向下移动。"""
    prof = frames[:, y0:y1, x0:x1, 0].mean(axis=2).astype(np.float32)   # N x H
    rows, sat, zero = [], 0, 0
    for i in range(1, len(prof)):
        a, b = prof[i - 1], prof[i]
        best = (1e18, 0)
        for s in range(-maxs, maxs + 1):
            if s > 0:
                u, v = a[:len(a) - s], b[s:]
            elif s < 0:
                u, v = a[-s:], b[:len(b) + s]
            else:
                u, v = a, b
            e = float(np.abs(u - v).mean())
            if e < best[0]:
                best = (e, s)
        e0 = float(np.abs(a - b).mean())
        if abs(best[1]) >= maxs:
            sat += 1
        if best[1] == 0:
            zero += 1
        rows.append((round(t0 + i / fps, 4), best[1], round(best[0], 3), round(e0, 3)))
    print('# 模式 corr（整幅画面主导运动）  s>0 = 内容向下移动')
    print('# 自检: 帧数=%d  静止帧占比=%.1f%%  撞上限帧数=%d/%d  搜索上限=±%dpx'
          % (len(prof), 100.0 * zero / max(1, len(prof) - 1), sat, len(prof) - 1, maxs))
    if sat:
        print('# ⚠️ 有 %d 帧撞到 ±%dpx 上限 —— 真实位移可能更大，请调大 --maxs 复跑' % (sat, maxs))
    print('t,dy_px,dy_px_per_s,err,err_zero_shift')
    for t, s, e, e0 in rows:
        print('%.4f,%+d,%+.1f,%.3f,%.3f' % (t, s, s * fps, e, e0))
    return rows


_COLORS = {
    'red':   lambda r, g, b: (r > 190) & (g > 60) & (g < 150) & (b < 120) & (r - g > 70),
    'blue':  lambda r, g, b: (b > 120) & (b - r > 30),
    'green': lambda r, g, b: (g > 140) & (g - r > 40) & (g - b > 30),
    'dark':  lambda r, g, b: (r < 95) & (g < 95) & (b < 95),
    'light': lambda r, g, b: (r > 205) & (g > 205) & (b > 205),
}


def mode_color(frames, t0, fps, color, min_px):
    """颜色掩膜跟踪：质心 y / 上边缘 top / 下边缘 bot / 像素数。"""
    if color not in _COLORS:
        raise SystemExit('[fail] --color 只认 %s' % '/'.join(_COLORS))
    fn = _COLORS[color]
    rows = []
    for i in range(len(frames)):
        a = frames[i]
        r, g, b = a[:, :, 0].astype(np.int16), a[:, :, 1].astype(np.int16), a[:, :, 2].astype(np.int16)
        m = fn(r, g, b)
        ys, xs = np.nonzero(m)
        if len(ys) < min_px:
            rows.append((t0 + i / fps, None, None, None, None, len(ys)))
            continue
        rows.append((t0 + i / fps, float(ys.mean()), int(ys.min()), int(ys.max()), float(xs.mean()), int(len(ys))))
    have = [r for r in rows if r[1] is not None]
    print('# 模式 color(%s)  质心 y / 上边缘 top / 下边缘 bot / 面积 n' % color)
    print('# 自检: 帧数=%d  命中=%d  未命中=%d  (min_px=%d)'
          % (len(rows), len(have), len(rows) - len(have), min_px))
    if len(have) > 1:
        tops = [r[2] for r in have]
        print('# 轨迹跨度: top %.1f → %.1f (Δ%.1f px)' % (tops[0], tops[-1], tops[-1] - tops[0]))
    print('t,cy,top,bot,cx,n')
    prev = None
    for t, cy, top, bot, cx, n in rows:
        d = ''
        if cy is not None and prev is not None:
            d = '%+.1f' % ((cy - prev) * fps)
        prev = cy if cy is not None else prev
        if cy is None:
            print('%.4f,,,,,%d' % (t, n))
        else:
            print('%.4f,%.2f,%d,%d,%.2f,%d,%s' % (t, cy, top, bot, cx, n, d))
    return rows


def mode_kymo(frames, t0, fps, x0, x1, out, scale):
    """时序条带图：横轴=时间，纵轴=画面垂直位置。运动 = 斜线，斜率 = 速度。"""
    from PIL import Image, ImageDraw
    K = frames[:, :, x0:x1, 0].mean(axis=2).T.astype(np.uint8)      # H x N
    H, N = K.shape
    img = Image.fromarray(K).resize((N * scale, H), Image.NEAREST).convert('RGB')
    d = ImageDraw.Draw(img)
    for n in range(0, N + 1):
        if n % 5 == 0:
            d.line([(n * scale, 0), (n * scale, H)], fill=(230, 70, 70), width=1)
    img.save(out)
    print('# 模式 kymo  → %s  (%dx%d, %d帧, 每%d列=1帧, 红线=每5帧)' % (out, img.size[0], img.size[1], N, scale))
    print('# 判读: 斜线斜率=速度; 斜线向上=内容上移; 出现折返=过冲/回弹; 方块跳变=硬切')
    return out


# ----------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description='视频真实运动量测探针')
    ap.add_argument('video')
    ap.add_argument('--t0', type=float, required=True)
    ap.add_argument('--t1', type=float, required=True)
    ap.add_argument('--fps', type=float, default=30.0)
    ap.add_argument('--mode', choices=['corr', 'color', 'kymo'], default='corr')
    ap.add_argument('--x', type=int, nargs=2, default=None, help='取样列范围 x0 x1')
    ap.add_argument('--y', type=int, nargs=2, default=None, help='取样行范围 y0 y1（corr 用）')
    ap.add_argument('--color', default='red')
    ap.add_argument('--min-px', type=int, default=300)
    ap.add_argument('--maxs', type=int, default=150, help='corr 搜索上限 px/帧')
    ap.add_argument('--kymo', default=None, help='同时输出条带图路径')
    ap.add_argument('--csv', default=None)
    ap.add_argument('--scale', type=int, default=10)
    a = ap.parse_args()

    if not os.path.exists(a.video):
        raise SystemExit('[fail] 视频不存在: %s' % a.video)
    W, H, vfps = probe(a.video)
    print('# 视频 %s' % os.path.basename(a.video))
    print('# 分辨率 %dx%d  源fps=%.3f  采样fps=%.1f  区间 %.3f~%.3f (%.2fs)'
          % (W, H, vfps, a.fps, a.t0, a.t1, a.t1 - a.t0))

    x0, x1 = a.x if a.x else (int(W * 0.40), int(W * 0.60))
    y0, y1 = a.y if a.y else (int(H * 0.08), int(H * 0.86))
    gray = (a.mode != 'color')
    frames = read_frames(a.video, a.t0, a.t1, a.fps, W, H, gray=gray)

    exp = int(round((a.t1 - a.t0) * a.fps))
    print('# 帧数校验: 期望=%d  实际=%d  %s' % (exp, len(frames), 'OK' if abs(len(frames) - exp) <= 1 else '⚠️ 不符'))
    if len(frames) < 2:
        raise SystemExit('[fail] 读到的帧太少，检查 --t0/--t1/--fps')

    if a.mode == 'corr':
        rows = mode_corr(frames, a.t0, a.fps, x0, x1, y0, y1, a.maxs)
        if a.csv:
            with open(a.csv, 'w', newline='', encoding='utf-8-sig') as f:
                w = csv.writer(f)
                w.writerow(['t', 'dy_px', 'dy_px_per_s', 'err', 'err_zero_shift'])
                w.writerows(rows)
            print('# CSV → %s' % a.csv)
    elif a.mode == 'color':
        rows = mode_color(frames, a.t0, a.fps, a.color, a.min_px)
        if a.csv:
            with open(a.csv, 'w', newline='', encoding='utf-8-sig') as f:
                w = csv.writer(f)
                w.writerow(['t', 'cy', 'top', 'bot', 'cx', 'n'])
                w.writerows(rows)
            print('# CSV → %s' % a.csv)

    if a.mode == 'kymo' or a.kymo:
        out = a.kymo or (os.path.splitext(a.video)[0] + '_kymo.png')
        mode_kymo(frames, a.t0, a.fps, x0, x1, out, a.scale)


if __name__ == '__main__':
    main()
