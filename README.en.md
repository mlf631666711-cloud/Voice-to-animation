# Voice-to-animation

[中文](README.md) | **English**

![Voice-to-animation](preview.png)

> A local toolchain that turns **one voice-over + one shot list** into **one motion-graphics video**.
> Plain Node + system Chrome + ffmpeg. **No cloud service, no build step, no framework lock-in.**

---

## What this repository is

This is a production workflow that has shipped dozens of real videos — open-sourced together with every tool it uses and every mistake it made along the way.

It is not "yet another video framework." It is three things:

| Contents | What it is |
|---|---|
| **A method** | A ten-stage pipeline from voice-over in, finished video out. Every stage has a concrete artifact and a pass criterion. |
| **A toolset** | 40+ single-file scripts: project scaffolder, render engine, 8-red-line gate, palette picker, shot-card index, 3D camera, effects library. |
| **A lesson book** | The pitfalls and hard rules in `docs/` all come from real failures. Notably: **8 out of 9 typical defects produced zero errors and passed every automated check while the picture was wrong.** |

> **Who it's for:** editors, indie developers and small teams who want to produce **motion-graphics explainers / product videos** rather than slideshow-style decks.
> **Who it's not for:** anyone looking for a "paste your script, get a video" SaaS. There is a command line here — and **the last stage requires your eyes.**

---

## Three core ideas (they drive every design decision)

### 1. The visual timeline is driven by the **word-level timing of the voice-over**, not by guesswork

Not "split each sentence evenly," but a word-level transcription (faster-whisper) where every element's entrance anchor is bound directly to a specific word's `start` time.

> Consequence: change the pacing or add a pause, and the visuals follow automatically. You never re-cut the audio to fit the picture.

### 2. Motion lives in the **shot list**, as parameters

Every shot must fill six camera fields (`cam` / `cam_amp` / `cam_ease` / `camkeys` / `depth` / `accept`). **Miss one and the scaffolder aborts with an error.**

> Consequence: motion becomes searchable, reusable and hand-off-able — instead of "tweaked until it felt right."

### 3. Two gates before delivery: a **machine gate** and **human eyes**

`trial.js` runs 8 P0 red lines (runtime / pure-function / mask / blank frames / safe area / zero errors / overlap / out-of-bounds) and exits non-zero unless everything passes.

**Then there is a gate no tool can replace:** extract frames from the finished MP4 and compare them pixel-by-pixel against the same frames rendered from the live page, **at the same scale.**

> Why it can't be skipped: in this project's own measurements, **8 of 9 typical defects raised no error at all.** The picture was wrong; the checks were green.

---

## Quick start

```bash
# 1. Get the tools
git clone https://github.com/mlf631666711-cloud/Voice-to-animation.git
cd Voice-to-animation

# 2. Check your environment -- it tells you exactly what's missing, item by item
#    (expect a few red lines on the first run; it even verifies CJK fonts by rendering)
node kit/check_env.js

# 3. Install what it asks for. There is only one Node dependency, so you can do it yourself:
npm i --no-save --no-package-lock puppeteer-core
#    ↑ Don't drop those two flags. This repo deliberately ships **no `package.json`**
#      (zero build step, every tool is a standalone script). Without them npm invents
#      a package.json + lockfile on the spot, and `git status` goes dirty immediately.
#    ★ Or let it install for you -- see the plan first, add --yes to actually run:
#      node kit/check_env.js --install         # prints the exact commands, writes nothing
#      node kit/check_env.js --install --yes   # really installs, then re-checks automatically

# 4. Check again -- all green means you're good to go
node kit/check_env.js

# 5. Scaffold a runnable project from the sample shot list
#    ⚠️ `--force` is required -- `examples/hello-voice` already exists in the repo,
#       and the scaffolder refuses to overwrite existing files without it (exit code 1)
node kit/new_project.js --spec kit/templates/spec.example.json --out examples/hello-voice --force

# 6. Render
cd examples/hello-voice
node _render.js          # → demo.mp4
```

> ⚠️ **`git clone` installs nothing** -- there is no `package.json` in this repo, so `npm install`
> has nothing to run either. The environment is a **one-time manual setup**, and step 2 above is
> the command that tells you what to install.

**Expected output** (step 5):

```
[new_project] ✓ 生成完成
    · fx_demo.html  (58854 bytes)
    · _render.js  (458 bytes)
  镜头数  : 4   时长: 12s @ 30fps   1920x1080
```

> Those two numbers are **byte counts** — they should match what `ls -l` (or Explorer) shows.
> The `fx_demo.html` figure is fixed (it is self-contained, independent of where you run this);
> `_render.js` shifts slightly with wherever you generate the project — it records a relative path
> back to `kit/`.
> If yours come out ~1000 bytes larger, your git client probably converted line endings to CRLF:
> this repo ships a `.gitattributes` declaring `eol=lf` to prevent exactly that, so check it is still there.

> That `1920x1080` is the **design canvas**, not the final output — see below.

**Expected output** (step 6): `demo.mp4`, **3840×2160 · 30 fps · 361 frames · 12.03 s**.

> **Why 4K by default**: the viewport stays at the design size (1920×1080) while `deviceScaleFactor=2`
> makes the browser rasterize everything at **2×**, so the screenshot itself is 3840×2160 and no downscale happens.
> That's real 4K — DOM, text and CSS effects are all genuinely resampled.
> **Want 1080p?** Add `ss: 1` to `_render.js`.
> ⚠️ **Don't "get 4K" by setting `w/h` to 3840** — that wraps a 1080p-designed page in a 4K shell:
> a 4K file with a 1080p picture in the corner, **and the file-size check still passes.**

Open `examples/hello-voice/fx_demo.html` in a browser to scrub the timeline frame by frame.

> ⚠️ **This example is a skeleton, not a finished film** — every shot holds nothing but a `TODO`
> placeholder (the on-screen `SHOT n · Sn · cam=xxx` label). So **`kit/trial.js` will FAIL on it, and
> that is expected**: it reports "no audio track" (the sample ships without voiceover) and
> "longest dead-frame run N.NNs" (each shot is a static placeholder card with no in-shot motion).
> **That is exactly what proves the gate has teeth** — it is not fooled by an empty skeleton.
> To produce a real film, follow [`docs/SOP-故事地图.md`](docs/SOP-故事地图.md) and fill in your own
> copy / voiceover / assets / shot list.

> **Something not working?** Check in order: ① does `ffmpeg -version` print anything
> ② is Chrome installed ③ puppeteer-core unresolvable → set `RENDER_CORE_PUPPETEER=<absolute path to your node_modules/puppeteer-core>`
> ④ text renders as empty boxes → **you haven't installed a CJK font** (see "Requirements" below)

---

## The pipeline: ten stages

Every stage has an **artifact** and a **pass criterion** — not "looks about done."

| # | Stage | What you do | Tool | Artifact |
|---|---|---|---|---|
| ① | Input | Write the script | — | Voice-over copy |
| ② | Transcribe | Voice-over → **word-level** timings | faster-whisper (medium) | `asr.json` |
| ③ | Classify | One of 9 video archetypes | — | Type tag |
| ③.5 | Palette | Pick background tones by type | `kit/palette_pick.cjs` | Palette |
| ④ | Source assets | Product shots / B-roll | — | Asset folder |
| ④.5 | Motion selection | Choose shots & look up terms | `kit/shotcraft/pick.mjs` `term.mjs` | Selection table |
| ⑤ | Shot list | Six camera fields + word anchors | `kit/check_wording.js` | `spec.json` |
| ⑥ | Global config | Duration / aspect / fps | `kit/motion-tokens.js` | Config |
| ⑦ | Read the pitfalls | Check known traps before you build | `docs/` | — |
| ⑧ | Scaffold | Generate the project | `kit/new_project.js` | `fx_*.html` |
| ⑧.5 | Render | Frame-by-frame Chrome + ffmpeg mux | `kit/render-core.js` `kit/export-engine.js` | `*.mp4` |
| ⑨ | Gate | 8 P0 red lines + human A/B | `kit/trial.js` | Exit code 0 |
| ⑩ | Archive | Log pitfalls, clean artifacts | `kit/daily_archive.js` | Doc updates |

> A plain-language walkthrough (why each step is non-negotiable) is in `docs/SOP-故事地图.md` (Chinese).
> **Sound effects** (part of step ④) — where to download them: [`docs/音效获取指南.md`](docs/音效获取指南.md).
> **When you can't find an asset**: you can draw SVG yourself or generate it with AI. There is a local
> "asset crew" set of role cards for that, but it is **optional and not shipped here**
> (**high token cost** + it depends on local asset libraries) —
> see step ④ in [`docs/管线十环节.md`](docs/管线十环节.md).

---

## Repository layout

```
Voice-to-animation/
├── kit/
│   ├── new_project.js          Project scaffolder: shot list → runnable project (2D / 3D)
│   ├── render-core.js          Render core: frame-by-frame puppeteer + ffmpeg mux (4K capable)
│   ├── export-engine.js        Export engine: single source of truth for frame extraction
│   ├── trial.js                The gate: 8 P0 red lines; exit code 0 = shippable
│   ├── palette_pick.cjs        Palette picker (9 archetype-specific directions)
│   ├── layout_check.js         Layout checks (margins / caption clearance / overlap / count)
│   ├── boxchk.js               Safe-area self-check (with coordinate-system self-check)
│   ├── contrast_check.js       Contrast (Otsu + WCAG)
│   ├── check_wording.js        Animation-description linter
│   ├── carry_check.js          Cross-shot continuity check
│   ├── daily_archive.js        Daily archive guard
│   ├── camera3d.js             3D camera · geometry (lookAt / orbit / DOF / shake)
│   ├── camera-lens.js          3D camera · optics (lenses + film emulation + thin-lens CoC)
│   ├── camera-shots.js         3D camera · recipes (chainable camera moves)
│   ├── fx-runtime.js           Effects runtime (element-first contract)
│   ├── fx-components.css       Effects component styles
│   ├── fx-uipack.js / .css     UI effects pack
│   ├── themes.js               Themes / palettes
│   ├── motion-tokens.js        Motion tokens (durations / curves)
│   ├── transitions.js          Transition library
│   ├── templates/              Skeleton templates + sample shot lists
│   └── shotcraft/              157 shot cards + 558 motion terms (with search tools)
├── docs/
│   ├── SOP-故事地图.md          Full-process checklist (Chinese)
│   ├── 管线十环节.md            Per-stage artifacts and pass criteria (Chinese)
│   ├── 出片铁律.md              Hard rules — violate them and you redo the shot
│   ├── 环境与依赖.md            What to install and how to verify
│   └── 坑库.md                  Real failure log (symptom → root cause → fix → evidence)
├── examples/
│   └── hello-voice/            A project you can render right now
└── LICENSE
```

---

## Requirements

| Dependency | Version | Used for | Why this one |
|---|---|---|---|
| **Node.js** | 18+ | All tooling | Everything is a standalone script — **no build, no installing the whole repo** |
| **Python** | 3.11+ | Transcription + image analysis | faster-whisper / numpy / Pillow |
| **Google Chrome** | Any recent | Render engine | Uses **system Chrome + puppeteer-core**; no extra Chromium download |
| **ffmpeg** | 5+ | Muxing / frame extraction | Also used for measurement |
| **CJK font** | — | On-screen text | ⚠️ **Fonts are not bundled** (size + licensing). Install your own. |

```bash
# Node dependency (just this one)
#   --no-save --no-package-lock: the repo ships no package.json, so without these
#   two flags npm would conjure one out of thin air
npm i --no-save --no-package-lock puppeteer-core

# Python dependencies
pip install faster-whisper numpy Pillow

# Verify
node -v && python -V && ffmpeg -version | head -1
```

> **Fonts:** we recommend open, commercially usable faces such as **Source Han Sans** or **Alibaba PuHuiTi**.
> Without one, all on-screen text renders as empty boxes — **and no automated check will complain.**

---

## Hard rules

These are not suggestions. Violate them and you redo the work. Every one comes from a real failure.

| # | Rule | Why |
|---|---|---|
| 1 | **Video length = voice-over length + 1.0 s**, measured delta \|Δ\| ≤ 0.02 s | Leave a beat at the end; guessed lengths never line up |
| 2 | ⛔ **Never use `-shortest` when muxing** | Measured 4 frames short (349 vs 353): **the picture freezes while the voice keeps talking** |
| 3 | Dual versions (with/without SFX): render the picture **once**, then swap audio with `-c:v copy` | Half the time, and both versions stay frame-identical |
| 4 | Caption clearance: elements inside the safe area must end **above 880 px** (at 1080p) | The caption band starts at y=900; overlap destroys legibility |
| 5 | Entrances use `easeOutBack`; positional easing uses `linear`; **nothing else uses linear** | Linear entrances read as stutter |
| 6 | **No freeze at the end** — let the final shot play to the last frame | Freezing collapses the tail into a still |
| 7 | Every check must **have teeth**: deliberately break the thing once and confirm it turns red | A check that can't fail can't be trusted when it's green |
| 8 | Before delivery, **someone who didn't build it** must review it (8 dimensions, ≥90) | You cannot see your own work clearly |

---

## Where to get sound effects

This repo **ships no audio files** (licensing + size). If you want SFX, grab them from these
**free-for-commercial-use** sources — all attribution-free, no signup, safe in commercial work:

| Site | Size | License | Best for |
|---|---|---|---|
| [**Pixabay**](https://pixabay.com/sound-effects/) | 70,000+ | Pixabay Content License | Transitions / whooshes / impacts / UI — download and go |
| [**Mixkit**](https://mixkit.co/free-sound-effects/) | ~2,000+ | Mixkit Free License | Short-form video, clean categories |
| [**Kenney**](https://kenney.nl/assets?q=audio) | 10 audio packs | **CC0** | A coherent set of UI / impact sounds |
| [**Sonniss GDC Bundle**](https://gdc.sonniss.com/) | 7–27 GB per year | Sonniss Royalty-Free | Studio-grade, bulk download |
| [**Freesound**](https://freesound.org/) | 730,000+ | **Per-file** | ★ **Filter to CC0 only** (see below) |

⚠️ **Two traps**:

1. **Freesound is a mixed-license pool** — `CC0` / `CC BY` (credit required) / `CC BY-NC` (**non-commercial**) all live together. Using an NC file in a commercial video is infringement, and it is invisible to the eye. **Filter the license to CC0.**
2. **BBC Sound Effects is not commercially usable** — huge and lovely, but personal / education / research only. And "free to download" ≠ "free to use commercially" — read the **file's own license**, not the site's landing page.

⛔ One more: **don't commit downloaded SFX into the repo** — most sites forbid redistributing raw files as standalone assets. (`.gitignore` already ignores `assets/` and `*.wav`.)

**How to use them**: drop the files into your project's `audio/sfx/`, then write an anchor in the shot sheet — `"sfx": [3.18, "whoosh"]`. You don't tune gain by hand: set the target peak (`peak`) in the cue table and the mixer measures each file and solves for the gain itself.
Full guide (site details · cue-table format · dual-version muxing commands) → **[`docs/音效获取指南.md`](docs/音效获取指南.md)**

---

## FAQ

**Do I have to use the command line?**
The pipeline does (it needs frame-accurate control). But if all you need is a **single-screen parameter card** (a "preset template"), the author also built a **double-click desktop app** (Electron portable). That is a **separate project and is not distributed with this repo** — so it is mentioned here for context only, with no download offered.

**What resolution does it output? How do I change it?**
**3840×2160 (true 4K) by default**, via 2× supersampling. For 1080p, add `ss: 1` to `_render.js`.
Cost note: a 4K PNG frame is 0.2–7.6 MB; for longer videos enable `--pipe` (PNG over stdin, nothing written to disk).

**Why does `w:1920` produce 4K?**
Because `w/h` describe the **design canvas**; 4K comes from `deviceScaleFactor` (supersampling), not from resizing the canvas.
There's a deliberate guard: if you **explicitly** pass a `w` ≥ 2048, the core assumes you literally want that output size and stops stacking supersampling — so `--w 3840` doesn't silently become 7680.

**Why not Remotion or After Effects?**
Because the two requirements here are "**the visual timeline is bound to the voice-over's word timings**" and "**every delivery is machine-checkable and human-inspectable.**" Remotion is better for component-style programmatic rendering; AE can't be machine-reviewed. This is a third path: single-file HTML projects + frame-by-frame driving + a gate system. (AE expressions and Remotion are used in sibling projects of this one — they don't conflict.)

**Do I need to read the pitfall log?**
You can skip most of it. But read at least the first entry: **"boot overlay not hidden ⇒ the whole video comes out white, with zero errors."** It's the single most common failure.

---

## License

[MIT](LICENSE) — free to use, modify and ship commercially.

⚠️ **Note**: this repository contains **no CJK fonts, no product imagery, no commercial B-roll.**
Verify the licensing of any assets you add yourself — especially for commercial use.

### Third-party & credits

The **only** third-party content shipped in this repository is the **shot-card library**,
from **[`Vincentwei1021/video-shotcraft`](https://github.com/Vincentwei1021/video-shotcraft)**
(by **Wei Yihao** · **Apache-2.0** · 10k+ stars):

- Its **157 shot cards** were parsed into [`kit/shotcraft/index.json`](kit/shotcraft/index.json)
  (fields reorganized, Chinese labels and derived flags added)
- **What we changed** (the declaration required by Apache-2.0 §4(b)) → see **[`THIRD-PARTY.md`](THIRD-PARTY.md)**
- License copy → [`licenses/video-shotcraft-LICENSE.txt`](licenses/video-shotcraft-LICENSE.txt)

**Deliberately NOT redistributed**: upstream's original card text, its Remotion code,
its 214 video samples (131 MB) and its audio assets (36 MB, Mixkit-licensed).
This repo ships only the **already-parsed index** (it carries every field the retrieval
and selection layers need). To read the original cards or rebuild the index yourself,
just clone upstream; to watch the motion previews, use upstream's online Gallery:
<https://vincentwei1021.github.io/video-shotcraft/>

Full inventory — including license notes for `puppeteer-core`, FFmpeg, Chrome, Remotion
and Mixkit — is in **[`THIRD-PARTY.md`](THIRD-PARTY.md)**.

---

## About

- Distilled from a real production pipeline, backed by 2,000+ logged defect records
- Every hard rule in these docs traces back to a specific thing that broke

> **In one sentence:** the value here isn't that it produces video — it's that it **admits automated checks lie, and reserves a stage that must be done with eyes.**
