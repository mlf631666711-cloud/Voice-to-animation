# -*- coding: utf-8 -*-
"""pix.py —— 像素级排版审判（2026-09-11 从 mingong-l10/_pix.py 提升进 kit，零工程耦合）

为什么不量 bbox
------------------------------------------------------------------
getBoundingClientRect 量的是**元素框**。文字被遮蔽时实际可见像素远小于框，
模组又是「方框大、实体小」。用框算占用会把视觉上很平衡的帧误判成左满右空
（L10 实测：框比 1.96 / 肉眼平衡）。

所以直接量画面里**真的有多少"墨"**：
  1) 取四条边框 6px 带的中位数当背景色（白底产品页主题，接近 #fff）
  2) 墨 = |亮度 − 背景亮度| > THR 的像素
  3) 统计：墨量 / bbox / 质心偏移 / 左右上下半区比 / 九宫格分布 / 贴边距离

用法
------------------------------------------------------------------
  python kit/pix.py <帧目录> [<帧目录2> ...]
      [--glob 't*.jpg']   帧文件名模式
      [--thr 30]          墨判定阈值（亮度差）
      [--edge 12]         贴边判定像素距离
      [--json out.json]   落盘机读结果
      [--quiet]           只出汇总行

判据（源自规格锁 §5.9 排版平衡）
------------------------------------------------------------------
  |质心偏移| > 12%  → 就该动相机（约等于「画面重心偏了」）
  左右墨量比 > 2.5  → 「一边满一边空」告警
  贴边命中          → 「位置太靠边」告警
  九宫格空格 ≥ 4    → 视觉空档过多，考虑补元素或推近
"""
import os
import sys
import glob
import json

# ---------- fail fast：第三方依赖（缺了给安装命令，不给裸 traceback）----------
#   ★ 2026-10-09：此前缺包抛的是裸 ModuleNotFoundError traceback。
_MISSING = []
try:
    import numpy as np
except ImportError:
    _MISSING.append("numpy")
try:
    from PIL import Image
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


def main():
    args = sys.argv[1:]
    if not args or args[0] in ('-h', '--help'):
        print(__doc__)
        return 0

    dirs, pat, thr, edge, jsonout, quiet = [], 't*.jpg', 30, 12, None, False
    i = 0
    while i < len(args):
        a = args[i]
        if a == '--glob':
            pat = args[i + 1]; i += 2
        elif a == '--thr':
            thr = float(args[i + 1]); i += 2
        elif a == '--edge':
            edge = int(args[i + 1]); i += 2
        elif a == '--json':
            jsonout = args[i + 1]; i += 2
        elif a == '--quiet':
            quiet = True; i += 1
        else:
            dirs.append(a); i += 1
    if not dirs:
        print('需要至少一个帧目录'); return 1

    files = []
    for d in dirs:
        files += sorted(glob.glob(os.path.join(d, pat)))
    if not files:
        print('没有帧（%s / %s）。先用 probe.js shots 或 sheet 截帧。' % (dirs, pat))
        return 1

    def stats(p):
        g = np.asarray(Image.open(p).convert('L'), dtype=np.float32)
        H, W = g.shape
        b = np.concatenate([g[:6].ravel(), g[-6:].ravel(), g[:, :6].ravel(), g[:, -6:].ravel()])
        bg = float(np.median(b))
        ink = np.abs(g - bg) > thr
        n = int(ink.sum())
        if n < 50:
            return dict(name=os.path.basename(p), ink=0, H=H, W=W, bg=bg)
        ys, xs = np.nonzero(ink)
        l, r, t, bo = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
        cx, cy = W // 2, H // 2
        aL, aR = int(ink[:, :cx].sum()), int(ink[:, cx:].sum())
        aT, aB = int(ink[:cy, :].sum()), int(ink[cy:, :].sum())
        grid = [[int(ink[gy * H // 3:(gy + 1) * H // 3, gx * W // 3:(gx + 1) * W // 3].sum())
                 for gx in range(3)] for gy in range(3)]
        return dict(name=os.path.basename(p), ink=n, H=H, W=W, bg=bg,
                    bbox=[l, t, r, bo],
                    margin=dict(L=l, T=t, R=W - 1 - r, B=H - 1 - bo),
                    mass=[float(xs.mean()), float(ys.mean())],
                    side=[aL / n, aR / n, aT / n, aB / n], grid=grid,
                    touch=dict(L=l <= edge, T=t <= edge, R=(W - 1 - r) <= edge, B=(H - 1 - bo) <= edge))

    def rat(a, b):
        hi, lo = max(a, b), max(1e-9, min(a, b))
        return hi / lo

    if not quiet:
        print('%-14s %7s %6s %6s %-20s %-24s %s' %
              ('帧', '墨量%', 'bw', 'bh', '质心(相对中心%)', '左右比 / 上下比', '贴边'))
        print('-' * 116)

    rows, warn = [], []
    for p in files:
        s = stats(p)
        if not s['ink']:
            if not quiet:
                print('%-14s   空帧' % s['name'])
            continue
        W, H = s['W'], s['H']
        l, t, r, bo = s['bbox']
        mx, my = s['mass']
        dx = (mx / W - .5) * 200
        dy = (my / H - .5) * 200
        aL, aR, aT, aB = s['side']
        lr, tb = rat(aL, aR), rat(aT, aB)
        touch = [k for k, v in s['touch'].items() if v]
        g = np.array(s['grid'], dtype=float)
        g = g / g.sum()
        zero = int((g < 0.03).sum())
        rec = dict(file=s['name'], inkPct=round(100.0 * s['ink'] / (W * H), 2),
                   dx=round(dx, 1), dy=round(dy, 1), lr=round(lr, 2), tb=round(tb, 2),
                   bbox=s['bbox'], touch=touch, zeroCells=zero, grid=[round(float(v), 4) for v in g.ravel()])
        rows.append(rec)
        if max(abs(dx), abs(dy)) > 12:
            warn.append('%s 质心偏了 (%+.1f,%+.1f)%%' % (rec['file'], dx, dy))
        if lr > 2.5:
            warn.append('%s 左右墨量比 %.2f（一边满一边空）' % (rec['file'], lr))
        if touch:
            warn.append('%s 贴边 %s' % (rec['file'], ','.join(touch)))
        if zero >= 4:
            warn.append('%s 视觉空档 %d/9 格' % (rec['file'], zero))
        if not quiet:
            print('%-14s %6.1f%% %5d %5d  (%+6.1f, %+6.1f)%%      L/R=%.2f  T/B=%.2f      %s' % (
                rec['file'], rec['inkPct'], r - l, bo - t, dx, dy, lr, tb, ','.join(touch) or '-'))

    if rows and not quiet:
        print()
        print('九宫格墨量分布（左上→右下）与空白率：')
        for rec in rows:
            print('  %-14s  %s   空格=%d/9' % (
                rec['file'], ' '.join('%4.1f' % (v * 100) for v in rec['grid']), rec['zeroCells']))

    if rows:
        worst = max(rows, key=lambda r: max(abs(r['dx']), abs(r['dy'])))
        print()
        print('最大质心偏移: %+.1f%% / %+.1f%%  （%s；|偏移| > 12%% 就该动相机）' % (
            worst['dx'], worst['dy'], worst['file']))
        print('告警 %d 条' % len(warn))
        for w in warn[:20]:
            print('  ! ' + w)

    if jsonout:
        with open(jsonout, 'w', encoding='utf-8') as f:
            json.dump(dict(frames=rows, warnings=warn), f, ensure_ascii=False, indent=2)
        print('JSON -> ' + jsonout)
    return 0


if __name__ == '__main__':
    sys.exit(main())
