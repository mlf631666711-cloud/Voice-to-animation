#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
qc_l1.py —— 视频动效产线 L1 技术门禁（自动体检）

用法:
    python qc_l1.py <video_path> [--fps 30] [--expect 11.0] [--json out.json]

依赖: 零第三方依赖，只需 ffmpeg / ffprobe 在 PATH 中。
退出码: 0 = 通过（允许 WARN/UNKNOWN）；1 = 存在 FAIL；2 = 用法/输入错误。
"""

import argparse
import json
import os
import re
import subprocess
import sys
import unicodedata

# ---------------------------------------------------------------- 常量与阈值

TIMEOUT = 120                      # 每条 ffmpeg/ffprobe 命令的超时（秒）

TARGET_W, TARGET_H = 1920, 1080    # 目标分辨率
FPS_TOL = 0.01                     # 帧率容差（严格执行 30fps）
DURATION_TOL = 0.3                 # 时长容差（秒）

BLACK_MIN_DUR = 0.5                # 黑帧判定时长（秒）
BLACK_PIX_TH = 0.10                # 黑帧判定亮度阈值
FREEZE_MIN_DUR = 0.5               # 静帧判定时长（秒）
FREEZE_NOISE = 0.001               # 静帧噪声容差
SILENCE_MIN_DUR = 0.5              # 静音报告时长（秒）
SILENCE_NOISE = -30                # 静音判定 dB

LUFS_TARGET = -14.0                # 目标综合响度（YouTube 口径）
LUFS_TOL = 3.0                     # 允许 ±3 LU
TRUE_PEAK_LIMIT = -1.0             # true peak 上限（dBTP）
CLIP_LIMIT = 0.0                   # 削波判定（dBFS）

Y_LEGAL = (16, 235)                # 广播合法亮度范围
UV_LEGAL = (16, 240)               # 广播合法色度范围

FLICKER_STEP = 0.1                 # 亮度采样步长（秒）
FLICKER_DELTA = 0.10 * 255         # "显著亮度变化"阈值 = 相对亮度 10%（8bit）
FLICKER_MAX_FLIPS = 3              # 1 秒窗口内允许的最大闪烁翻转次数

PASS, WARN, FAIL, UNKNOWN, INFO = "PASS", "WARN", "FAIL", "UNKNOWN", "INFO"
SEVERITY = {INFO: 0, PASS: 1, UNKNOWN: 2, WARN: 3, FAIL: 4}


def worse(a, b):
    return a if SEVERITY[a] >= SEVERITY[b] else b


# ---------------------------------------------------------------- 终端输出工具

def disp_width(s):
    """按显示宽度计算字符串宽度（CJK / 全角算 2）。"""
    w = 0
    for ch in s:
        w += 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
    return w


def pad(s, width, align="left"):
    s = "" if s is None else str(s)
    if disp_width(s) > width:                      # 超宽则截断
        out, acc = "", 0
        for ch in s:
            c = 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
            if acc + c > width - 1:
                break
            out += ch
            acc += c
        s = out + "…"
    fill = " " * max(0, width - disp_width(s))
    return (s + fill) if align == "left" else (fill + s)


# ---------------------------------------------------------------- 命令执行

def run_cmd(args, timeout=TIMEOUT):
    """执行 ffmpeg/ffprobe。返回 (stdout, stderr, note)；note 为空表示一切正常。"""
    try:
        p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=timeout)
    except subprocess.TimeoutExpired:
        return "", "", "命令超时（%ds），未取到结果" % timeout
    except FileNotFoundError:
        return "", "", "可执行文件不存在：%s（请确认 ffmpeg/ffprobe 已在 PATH 中）" % args[0]
    except Exception as e:                                    # 绝不因异常崩掉
        return "", "", "执行异常：%s" % e
    out = p.stdout.decode("utf-8", "replace")
    err = p.stderr.decode("utf-8", "replace")
    note = "" if p.returncode == 0 else "命令返回码 %d（输出可能不完整）" % p.returncode
    return out, err, note


def _f(v, digits=3):
    try:
        return ("%." + str(digits) + "f") % float(v)
    except Exception:
        return str(v)


# ---------------------------------------------------------------- 探测元数据

def probe(path):
    out, err, note = run_cmd([
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", path])
    if note and not out:
        return None, note
    try:
        data = json.loads(out)
    except Exception as e:
        return None, "ffprobe 输出解析失败：%s" % e
    vs = next((s for s in data.get("streams", [])
               if s.get("codec_type") == "video"
               and not s.get("disposition", {}).get("attached_pic")), None)
    au = next((s for s in data.get("streams", [])
               if s.get("codec_type") == "audio"), None)
    return {"video": vs, "audio": au, "format": data.get("format", {})}, note


def parse_rate(rate):
    """'30/1' / '30000/1001' / '30' -> float；失败返回 None。"""
    if not rate:
        return None
    if "/" in rate:
        a, _, b = rate.partition("/")
        try:
            a, b = float(a), float(b)
            return a / b if b else None
        except Exception:
            return None
    try:
        return float(rate)
    except Exception:
        return None


# ---------------------------------------------------------------- 各检查项

def check_spec(meta, expect_fps):
    vs = meta.get("video")
    if not vs:
        return {"name": "容器与规格", "status": UNKNOWN, "value": "-",
                "threshold": "1920x1080 / %.2ffps" % expect_fps,
                "detail": "ffprobe 未找到视频流"}
    try:
        w = int(vs.get("width")); h = int(vs.get("height"))
    except Exception:
        return {"name": "容器与规格", "status": UNKNOWN, "value": "-",
                "threshold": "1920x1080 / %.2ffps" % expect_fps,
                "detail": "宽高解析失败"}
    fps = parse_rate(vs.get("r_frame_rate"))
    pix = vs.get("pix_fmt", "?")
    reasons = []
    if (w, h) != (TARGET_W, TARGET_H):
        reasons.append("分辨率 %dx%d ≠ %dx%d" % (w, h, TARGET_W, TARGET_H))
    if fps is None:
        reasons.append("帧率解析失败")
    elif abs(fps - expect_fps) > FPS_TOL:
        reasons.append("帧率 %.3f ≠ %.2f" % (fps, expect_fps))
    value = "%dx%d / %sfps / %s" % (w, h, "?" if fps is None else _f(fps, 2), pix)
    return {"name": "容器与规格", "status": FAIL if reasons else PASS,
            "value": value,
            "threshold": "%dx%d / %.2ffps" % (TARGET_W, TARGET_H, expect_fps),
            "detail": "；".join(reasons) if reasons else "分辨率与帧率符合要求"}


def check_duration(meta, expect):
    dur = None
    try:
        dur = float(meta.get("format", {}).get("duration"))
    except Exception:
        pass
    if dur is None:
        return {"name": "时长", "status": UNKNOWN, "value": "-",
                "threshold": "--expect 未指定", "detail": "ffprobe 未返回 duration"}
    if expect is None:
        return {"name": "时长", "status": INFO, "value": _f(dur) + "s",
                "threshold": "未指定 --expect，仅报告", "detail": "未设期望值，不做判定"}
    diff = abs(dur - expect)
    return {"name": "时长", "status": FAIL if diff > DURATION_TOL else PASS,
            "value": _f(dur) + "s",
            "threshold": "%.3fs ±%.1fs" % (expect, DURATION_TOL),
            "detail": ("与期望相差 %.3fs（>%.1fs）" % (diff, DURATION_TOL)) if diff > DURATION_TOL
                      else ("与期望相差 %.3fs" % diff)}


def parse_segments(text, kind):
    """解析 blackdetect / freezedetect 输出。

    两种输出形态都要兼容：
      单行  -> black_start:0 black_end:1.0 black_duration:1.0
      逐行  -> lavfi.freezedetect.freeze_start: 1.0
               lavfi.freezedetect.freeze_duration: 0.6
               lavfi.freezedetect.freeze_end: 1.6
    返回 [(start, end, duration), ...]，缺失字段为 None。
    """
    segs, cur = [], {}
    pattern = r"%s_(start|end|duration):\s*([0-9.]+)" % kind
    for m in re.finditer(pattern, text):
        key, val = m.group(1), float(m.group(2))
        if key == "start":
            if cur:
                segs.append((cur.get("start"), cur.get("end"), cur.get("duration")))
            cur = {"start": val}
        else:
            cur[key] = val
    if cur:
        segs.append((cur.get("start"), cur.get("end"), cur.get("duration")))
    return [s for s in segs if s[2] is not None]


def fmt_segments(segs):
    return "；".join(["%.2fs~%.2fs（%.2fs）" % (s or 0, e or 0, d) for s, e, d in segs])


def check_black(path, duration):
    out, err, note = run_cmd(["ffmpeg", "-hide_banner", "-i", path,
                              "-vf", "blackdetect=d=%s:pix_th=%s" % (BLACK_MIN_DUR, BLACK_PIX_TH),
                              "-an", "-f", "null", "-"])
    segs = parse_segments(err, "black")
    if not segs:
        return {"name": "黑帧", "status": UNKNOWN if note else PASS, "value": "无",
                "threshold": "无 >%.1fs 黑帧（头尾 1s 除外）" % BLACK_MIN_DUR,
                "detail": ("未检出黑帧。" + note) if note else "未检出黑帧"}
    total = len(segs)
    bad = []
    for s, e, d in segs:
        if d <= BLACK_MIN_DUR:
            continue
        if (e is not None and e <= 1.0) or (duration and s is not None and s >= duration - 1.0):
            continue                                   # 片头/片尾 1s 内豁免
        bad.append((s, e, d))
    desc = fmt_segments(segs)
    if bad:
        bd = fmt_segments(bad)
        return {"name": "黑帧", "status": FAIL, "value": "%d 段" % len(bad),
                "threshold": "无 >%.1fs 黑帧（头尾 1s 除外）" % BLACK_MIN_DUR,
                "detail": "检出 %d 段黑帧，其中 %d 段在正片区间：%s" % (total, len(bad), bd)}
    return {"name": "黑帧", "status": PASS, "value": "共 %d 段（均豁免）" % total,
            "threshold": "无 >%.1fs 黑帧（头尾 1s 除外）" % BLACK_MIN_DUR,
            "detail": "全部位于片头/片尾 1s 内：%s" % desc}


def check_freeze(path):
    out, err, note = run_cmd(["ffmpeg", "-hide_banner", "-i", path,
                              "-vf", "freezedetect=n=%s:d=%s" % (FREEZE_NOISE, FREEZE_MIN_DUR),
                              "-f", "null", "-"])
    segs = parse_segments(err, "freeze")
    if not segs:
        return {"name": "静帧", "status": UNKNOWN if note else PASS, "value": "无",
                "threshold": "无 >%.1fs 静止段" % FREEZE_MIN_DUR,
                "detail": ("未检出静帧。" + note) if note else "未检出静帧（画面持续在动）"}
    desc = fmt_segments(segs)
    return {"name": "静帧", "status": WARN, "value": "%d 段" % len(segs),
            "threshold": "无 >%.1fs 静止段" % FREEZE_MIN_DUR,
            "detail": "疑似「PPT 感」静止段：%s" % desc}


def check_silence(path, has_audio):
    if not has_audio:
        return {"name": "静音段", "status": UNKNOWN, "value": "-",
                "threshold": "仅报告 >%.1fs 静音" % SILENCE_MIN_DUR,
                "detail": "无音轨，跳过"}
    out, err, note = run_cmd(["ffmpeg", "-hide_banner", "-i", path,
                              "-af", "silencedetect=noise=%sdB:d=%s" % (SILENCE_NOISE, SILENCE_MIN_DUR),
                              "-f", "null", "-"])
    starts = [float(x) for x in re.findall(r"silence_start:\s*([0-9.eE+-]+)", err)]
    ends = [(float(a), float(b)) for a, b in
            re.findall(r"silence_end:\s*([0-9.eE+-]+)\s*\|\s*silence_duration:\s*([0-9.eE+-]+)", err)]
    if not starts and not ends:
        return {"name": "静音段", "status": UNKNOWN if note else PASS, "value": "无",
                "threshold": "仅报告 >%.1fs 静音" % SILENCE_MIN_DUR,
                "detail": ("未检出静音段。" + note) if note else "未检出 >%.1fs 静音段" % SILENCE_MIN_DUR}
    segs = []
    for i, (e, d) in enumerate(ends):
        s = starts[i] if i < len(starts) else e - d
        segs.append((s, e, d))
    for s in starts[len(ends):]:                       # 静音一直持续到片尾，无 silence_end
        segs.append((s, None, None))
    desc = fmt_segments([(s, e, d if d is not None else 0) for s, e, d in segs])
    return {"name": "静音段", "status": INFO, "value": "%d 段" % len(segs),
            "threshold": "仅报告 >%.1fs 静音" % SILENCE_MIN_DUR,
            "detail": "静音区间（不判 fail，人工确认是否有意为之）：%s" % desc}


def check_loudness(path, has_audio):
    thr = "I = %.0f±%.0f LUFS；true peak ≤ %.0f dBTP" % (LUFS_TARGET, LUFS_TOL, TRUE_PEAK_LIMIT)
    if not has_audio:
        return {"name": "响度", "status": UNKNOWN, "value": "-", "threshold": thr,
                "detail": "无音轨，跳过"}
    out, err, note = run_cmd(["ffmpeg", "-hide_banner", "-i", path,
                              "-af", "ebur128=peak=true", "-f", "null", "-"])
    idx = err.find("Summary:")
    block = err[idx:] if idx >= 0 else err
    i_m = re.search(r"^\s*I:\s*(-?[0-9.]+)\s*LUFS", block, re.M)
    p_m = re.search(r"^\s*Peak:\s*(-?[0-9.]+)\s*dBFS", block, re.M)
    if not i_m:
        return {"name": "响度", "status": UNKNOWN, "value": "-", "threshold": thr,
                "detail": "未解析到 ebur128 Summary 中的 I: 行" + ("；" + note if note else "")}
    integrated = float(i_m.group(1))
    status, reasons = PASS, []
    if integrated < LUFS_TARGET - LUFS_TOL or integrated > LUFS_TARGET + LUFS_TOL:
        status = FAIL
        reasons.append("综合响度 %.1f LUFS 超出 %.0f±%.0f（差 %.1f LU）"
                       % (integrated, LUFS_TARGET, LUFS_TOL, integrated - LUFS_TARGET))
    peak_txt = "未解析到"
    if p_m:
        peak = float(p_m.group(1))
        peak_txt = "%.1f dBTP" % peak
        if peak > TRUE_PEAK_LIMIT:
            status = worse(status, FAIL)
            reasons.append("true peak %.1f dBTP 高于 %.0f dBTP" % (peak, TRUE_PEAK_LIMIT))
    else:
        status = worse(status, UNKNOWN)
        reasons.append("true peak 未解析到（ebur128 未输出 Peak 行）")
    value = "I = %.1f LUFS, true peak = %s" % (integrated, peak_txt)
    return {"name": "响度", "status": status, "value": value, "threshold": thr,
            "detail": ("；".join(reasons) if reasons else "综合响度与真峰值均合格")
                      + ("；" + note if note else "")}


def check_clip(path, has_audio):
    thr = "Peak level < %.1f dBFS" % CLIP_LIMIT
    if not has_audio:
        return {"name": "削波", "status": UNKNOWN, "value": "-", "threshold": thr,
                "detail": "无音轨，跳过"}
    out, err, note = run_cmd(["ffmpeg", "-hide_banner", "-i", path,
                              "-af", "astats=metadata=1:reset=0", "-f", "null", "-"])
    vals = [float(x) for x in re.findall(r"Peak level dB:\s*(-?[0-9.eE+]+)", err)]
    vals += [float(x) for x in re.findall(r"lavfi\.astats\.Overall\.Peak_level\s*=\s*(-?[0-9.eE+]+)", err)]
    if not vals:
        return {"name": "削波", "status": UNKNOWN, "value": "-", "threshold": thr,
                "detail": "未解析到 astats 的 Peak level" + ("；" + note if note else "")}
    peak = max(vals)
    return {"name": "削波", "status": FAIL if peak >= CLIP_LIMIT else PASS,
            "value": "%.2f dBFS" % peak, "threshold": thr,
            "detail": ("峰值 %.2f dBFS 已达/超过 0 dBFS，存在削波失真" % peak) if peak >= CLIP_LIMIT
                      else ("峰值 %.2f dBFS，距 0 dBFS 还有 %.2f dB 余量" % (peak, -peak))}


def _parse_signalstats(text):
    """解析 metadata=print 输出，返回 (统计字典, [(t, yavg), ...])。"""
    stats = {"YMIN": None, "YMAX": None, "SATMIN": None, "SATMAX": None}
    series, t = [], None
    for line in text.splitlines():
        if line.startswith("frame:"):
            m = re.search(r"pts_time:\s*([0-9.eE+-]+)", line)
            t = float(m.group(1)) if m else None
            continue
        m = re.match(r"lavfi\.signalstats\.([A-Z]+)\s*=\s*(-?[0-9.eE+-]+)", line.strip())
        if not m:
            continue
        key, val = m.group(1), float(m.group(2))
        if key in stats:
            stats[key] = val if stats[key] is None else (
                min(stats[key], val) if key.endswith("MIN") else max(stats[key], val))
        if key == "YAVG" and t is not None:
            series.append((t, val))
    return stats, series


def check_broadcast_and_flicker(path):
    """一次解码同时拿到：广播合法范围（Y/SAT 极值）+ 逐帧 YAVG（供闪烁判定）。"""
    stats, series, note = {}, [], ""
    out, err, n = run_cmd(["ffmpeg", "-hide_banner", "-i", path,
                           "-vf", "signalstats,metadata=print:file=-",
                           "-an", "-f", "null", "-"])
    note = n
    stats, series = _parse_signalstats(out)

    # ---- 广播合法范围
    thr_b = "Y ∈ [%d,%d]，UV(SAT) ∈ [%d,%d]" % (Y_LEGAL[0], Y_LEGAL[1], UV_LEGAL[0], UV_LEGAL[1])
    ymin, ymax = stats.get("YMIN"), stats.get("YMAX")
    smin, smax = stats.get("SATMIN"), stats.get("SATMAX")
    if ymin is None or ymax is None:
        bc = {"name": "广播合法范围", "status": UNKNOWN, "value": "-", "threshold": thr_b,
              "detail": "未解析到 signalstats 的 YMIN/YMAX" + ("；" + note if note else "")}
    else:
        problems = []
        if ymin < Y_LEGAL[0] or ymax > Y_LEGAL[1]:
            problems.append("亮度 Y 实测 %.0f~%.0f，越界" % (ymin, ymax))
        if smin is not None and smax is not None and (smin < UV_LEGAL[0] or smax > UV_LEGAL[1]):
            problems.append("色度 SAT 实测 %.0f~%.0f，越界" % (smin, smax))
        val = "Y %.0f~%.0f" % (ymin, ymax)
        if smin is not None:
            val += "，SAT %.0f~%.0f" % (smin, smax)
        bc = {"name": "广播合法范围", "status": WARN if problems else PASS, "value": val,
              "threshold": thr_b,
              "detail": ("；".join(problems) + "（仅提示：播控/广电平台可能压暗或溢出）"
                         if problems else "亮度与色度均在合法范围内")}

    # ---- 闪烁（PSE 光敏）
    thr_f = "1s 窗口内亮度翻转 ≤ %d 次" % FLICKER_MAX_FLIPS
    if len(series) < 2:
        fl = {"name": "闪烁（PSE）", "status": UNKNOWN, "value": "-", "threshold": thr_f,
              "detail": "未取到逐帧亮度序列，无法判定" + ("；" + note if note else "")}
        return [bc, fl]

    samples = resample(series, FLICKER_STEP)
    deltas = [(samples[i][0], samples[i + 1][1] - samples[i][1])
              for i in range(len(samples) - 1)]
    large = [(t, (d > 0) - (d < 0)) for t, d in deltas if abs(d) >= FLICKER_DELTA]
    flips = []
    for i in range(1, len(deltas)):
        d0, d1 = deltas[i - 1][1], deltas[i][1]
        if abs(d0) >= FLICKER_DELTA and abs(d1) >= FLICKER_DELTA and d0 * d1 < 0:
            flips.append(deltas[i][0])
    worst_n, worst_t = 0, None
    end_t = samples[-1][0]
    k = 0
    while k * FLICKER_STEP <= end_t:
        T = k * FLICKER_STEP
        c = sum(1 for t in flips if T <= t < T + 1.0)
        if c > worst_n:
            worst_n, worst_t = c, T
        k += 1
    max_d = max((abs(d) for _, d in deltas), default=0.0)
    detail = ("采样 %d 点（步长 %.1fs），显著变化 %d 次，最大单次亮度跳变 %.1f/255"
              % (len(samples), FLICKER_STEP, len(large), max_d))
    if worst_t is not None:
        detail += "，最差 1s 窗口起点 %.1fs 内翻转 %d 次" % (worst_t, worst_n)
    status = FAIL if worst_n > FLICKER_MAX_FLIPS else PASS
    if worst_n > FLICKER_MAX_FLIPS:
        detail = "检出光敏风险：" + detail + "（Ofcom：1s 内 >3 次闪烁即不合格）"
    fl = {"name": "闪烁（PSE）", "status": status,
          "value": "最差 1s 窗口翻转 %d 次" % worst_n, "threshold": thr_f, "detail": detail}
    return [bc, fl]


def resample(series, step):
    """把非均匀逐帧序列重采样到 step 秒的均匀网格。"""
    out, i = [], 0
    end = series[-1][0]
    k = 0
    while k * step <= end:
        target = k * step
        while i < len(series) - 1 and series[i][0] < target:
            i += 1
        out.append((target, series[i][1]))
        k += 1
    return out


# ---------------------------------------------------------------- 主流程

def main():
    ap = argparse.ArgumentParser(
        description="视频成片 L1 技术门禁（分辨率/时长/黑帧/静帧/静音/响度/削波/合法范围/闪烁）")
    ap.add_argument("video", help="待体检的视频文件路径")
    ap.add_argument("--fps", type=float, default=30.0, help="期望帧率，默认 30")
    ap.add_argument("--expect", type=float, default=None, help="期望时长（秒），差值 >0.3s 判 FAIL")
    ap.add_argument("--json", dest="json_path", default=None, help="结构化结果输出 JSON 路径")
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    path = args.video
    if not os.path.isfile(path):
        print("[错误] 文件不存在或不是普通文件：%s" % path)
        sys.exit(2)
    path = os.path.abspath(path)

    meta, note = probe(path)
    if meta is None:
        print("[错误] ffprobe 探测失败：%s" % note)
        sys.exit(2)
    vs, au = meta["video"], meta["audio"]
    duration = None
    try:
        duration = float(meta["format"].get("duration"))
    except Exception:
        pass

    print("=" * 84)
    print(" L1 技术门禁  |  %s" % path)
    if vs:
        fps = parse_rate(vs.get("r_frame_rate"))
        print(" 视频：%sx%s / %sfps / %s / %s    音频：%s" % (
            vs.get("width"), vs.get("height"), "?" if fps is None else _f(fps, 2),
            vs.get("pix_fmt"), vs.get("codec_name"),
            ("%s %sHz %sch" % (au.get("codec_name"), au.get("sample_rate"), au.get("channels")))
            if au else "无音轨"))
    print(" 时长：%s    期望帧率：%.2f    期望时长：%s" % (
        ("%.3fs" % duration) if duration else "未知", args.fps,
        ("%.3fs" % args.expect) if args.expect is not None else "未指定"))
    print("=" * 84)

    checks = []
    checks.append(check_spec(meta, args.fps))
    checks.append(check_duration(meta, args.expect))
    checks.append(check_black(path, duration))
    checks.append(check_freeze(path))
    checks.append(check_silence(path, au is not None))
    checks.append(check_loudness(path, au is not None))
    checks.append(check_clip(path, au is not None))
    checks += check_broadcast_and_flicker(path)

    print("%s  %s  %s  %s  %s" % (
        pad("状态", 10), pad("检查项", 16), pad("实测值", 32), pad("阈值", 30), "备注"))
    print("-" * 84)
    for c in checks:
        print("%s  %s  %s  %s  %s" % (
            pad("[%s]" % c["status"], 10), pad(c["name"], 16),
            pad(c["value"], 32), pad(c["threshold"], 30),
            c["detail"].split("；")[0][:50]))
    print("-" * 84)

    fails = [c for c in checks if c["status"] == FAIL]
    warns = [c for c in checks if c["status"] == WARN]
    unknowns = [c for c in checks if c["status"] == UNKNOWN]

    if fails or warns or unknowns:
        print("明细：")
        for c in fails + warns + unknowns:
            print("  [%s] %s：%s" % (c["status"], c["name"], c["detail"]))
        print("-" * 84)

    if fails:
        print("L1 GATE: FAIL (%d 项)" % len(fails))
        for c in fails:
            print("  - %s：%s" % (c["name"], c["detail"]))
    else:
        print("L1 GATE: PASS")
    if warns:
        print("提示：%d 项 WARN（不阻断，建议人工复核）：%s"
              % (len(warns), "、".join(c["name"] for c in warns)))
    if unknowns:
        print("注意：%d 项 UNKNOWN（脚本拿不到值，需人工确认）：%s"
              % (len(unknowns), "、".join(c["name"] for c in unknowns)))
    print("=" * 84)

    if args.json_path:
        result = {"file": path,
                  "meta": {"width": vs.get("width") if vs else None,
                           "height": vs.get("height") if vs else None,
                           "fps": parse_rate(vs.get("r_frame_rate")) if vs else None,
                           "pix_fmt": vs.get("pix_fmt") if vs else None,
                           "duration": duration,
                           "has_audio": au is not None},
                  "checks": checks,
                  "gate": "FAIL" if fails else "PASS",
                  "fail_count": len(fails),
                  "warn_count": len(warns),
                  "unknown_count": len(unknowns)}
        try:
            with open(args.json_path, "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False, indent=2)
            print("JSON 结果已写入：%s" % os.path.abspath(args.json_path))
        except Exception as e:
            print("[错误] 写入 JSON 失败：%s" % e)

    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
