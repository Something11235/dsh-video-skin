# dsh-video-skin

**DSH 视频皮肤**：一段短片循环铺成整个界面的**聊天背景**（也可以一键换成**一张静态图**；无声、透明度界面里就能调），
另一段做**有声的开机动画**（片尾交叉溶解进界面、**点击画面随时跳过**）。**零依赖**。

## 安装（Install）

**设置 → 插件 → 添加插件**，把下面这一行贴进输入框，点「安装」，然后**完全退出并重新打开 DSH**：

```
github:Something11235/dsh-video-skin#main
```

> 桌面版（Electron）的索引注入表是**宿主启动时收集一次**的快照，所以装完必须**完全重启 DSH**
> 才会生效（刷新页面不够）。卸载：`dsh plugin --profile <你的 profile> remove dsh-video-skin`，
> 或者用仓库里的 `scripts/uninstall.ps1`。

装好之后：右下角会出现一个半透明小圆钮，点开就是**背景面板**（第一行换"视频背景 / 静态图"，
下面是透明度滑块；调完刷新还在，不用重启）；启动时会先播放开机动画，**点一下画面**就跳过。

English: install `github:Something11235/dsh-video-skin#main` from **Settings → Plugins → Add plugin**,
then **fully quit and relaunch DSH**. A small pill appears in the bottom-right corner: its panel switches
the backdrop between the looping clip and a still image, and holds the transparency sliders; click
anywhere during the boot animation to skip it.

---

A **video skin** for DSH: one clip becomes a looping, silent **video backdrop** behind the whole Web UI
(or, with one click, a **still image** becomes the backdrop), and a second clip becomes a **boot
animation** — **played with sound**, **played through to its end**, then fading into the app, and
**skippable with a click**.

- Boot animation: full-window clip **with audio**, a progress bar driven by the kernel's real activation
  progress, and a permanent “click to skip” pill. The clip **finishes first** (`ended`), then the overlay
  fades out over a **fixed** `fadeMs`; the volume fades with it instead of being cut off.
  > Earlier builds cross-dissolved over the clip's tail and used the *actual remaining time* as the fade
  > duration — when the app became ready late that left only 100–200 ms, which read as a **hard cut**.
  > Default is now `exitMode: 'end'`; `exitMode: 'tail'` restores the crossfade (still with a fixed fade).
- Backdrop: silent, `object-fit: cover`, with the app's surface tokens made translucent —
  **the picture is clearly visible** and the text stays readable. The picture is a **looping clip** or a
  **still image**; the same panel switches between them, and both share the scrim, the surface values and
  the contrast readout (see [Static background](#static-background)).
- A **backdrop panel in the UI** (bottom-right pill): the clip/still switch, two sliders, three presets, and
  a live body-text contrast readout; changes apply on refresh with no DSH restart.
- **Zero dependencies.** The host half imports only `node:` builtins; the browser half is one inline
  script. Nothing in the built artifact has an `import` — which is also why a plain `github:` install
  works with **no build step and no `prepare` script**.

> 中文完整说明（安装、调参、控件用法、机制约束、排错、自检）见 [README.zh.md](README.zh.md)。

## Screenshots (captured on this machine by `scripts/verify-browser.mjs`)

| | |
| --- | --- |
| ![boot animation](docs/e2e-1-boot.png) | ![light theme backdrop](docs/e2e-2-app.png) |
| Boot animation: clip fills the window (with sound), real boot progress bar, permanent "click to skip" pill | Light theme: backdrop fills the window, body-text contrast p5 = **7.90** |
| ![dark theme backdrop](docs/e2e-3-dark.png) | |
| Dark theme: video clearly visible, body-text contrast p5 = **6.86**, median 16.06 (AA needs 4.5) | |

## Sound

The desktop shell sets no `webPreferences.autoplayPolicy`, so Electron's default
(`no-user-gesture-required`) applies: an unmuted `play()` succeeds and the boot animation starts with
sound. A plain browser (`dsh web` in Chrome) blocks unmuted autoplay by default; the runtime then
**falls back to muted playback** (never trapping you on a dead screen) and shows a **separate** sound
button in the bottom-left — clicking it turns sound on without skipping, so the two intents never
collide. Set `boot.sound: false` for a silent boot.

## Transparency

`surface` (dark theme) and `surfaceLight` (light theme) are the two knobs that trade picture strength
against readability; `veil` / `veilLight` are the scrims over the video. They are deliberately different
per theme: text is light in dark mode and dark in light mode, and this asset is dark (`YAVG ≈ 0.25`), so
an equally thin *white* surface drops dark text below 3:1. Measured in a real browser:

| `surface` | `surfaceLight` | dark min / p5 / median | light min / p5 / median |
| --- | --- | --- | --- |
| **0.2** | **0.6** | **2.49 / 6.81 / 16.05** | **7.74 / 7.91 / 8.72** |
| 0.2 | 0.4 | 2.52 / 6.85 / 16.06 | 4.34 / 4.52 / 5.37 |
| 0.05 | 0.6 | 1.53 / 4.89 / 15.24 | 7.38 / 7.56 / 8.37 |
| 0 | 0.55 | 1.22 / 4.14 / 14.71 | 5.87 / 6.06 / 6.90 |

p5 (the 95% of frame area) is the meaningful readability number; `--sweep` prints this table live.

## Static background

`background.mode` is `video` (default) or `image`. The panel's first row switches it **live** — no reload,
no restart — and the choice is persisted as `background.mode` next to the four opacity knobs.

- **A still costs nothing to keep on screen.** The clip is a permanent decode loop; a JPEG is decoded once.
  This is the lightest setting that still looks like the same skin.
- **It complements `prefers-reduced-motion`, it does not replace it.** With reduced motion the clip is
  *not played* (unchanged), while the still **still shows** — a picture that does not move is exactly what
  that setting asks for. Switching back to the clip on such a machine is **refused, and the panel says
  why** (the refused choice is not written to disk either).
- **Both pictures share one set of numbers.** The scrim (`veil`), the surfaces (`surface` / `surfaceLight`)
  and the contrast readout mean the same thing for either (“picture → scrim → surface”), so switching
  never means re-tuning. The shipped still is **a frame taken from the shipped clip**
  (`scripts/make-still.mjs`), so its brightness distribution — and the measured table above — still holds.
- **Switching only swaps the element** inside the layer (`<video>` ↔ `<img>`): layer, scrim, translucent
  surfaces and the panel are not rebuilt, so nothing blinks and the panel does not vanish under the cursor.
- **A click is instant.** `delayMs` only delays the **first** fetch after boot (leaving the bandwidth to
  the UI); a switch requested by the user does not wait for it — waiting 1.2 s there just makes the click
  look dead, with nothing but the base colour on screen.

Edge cases, all deliberate: a `mode: "image"` whose file is missing **falls back to the clip** (the host
warns; `imageSrc` stays empty, so the panel does not render a dead switch); the still route is
`/dsh-video-skin/background-image` with **no extension** (`Content-Type` comes from the real file, so png
and webp work too); a still that fails to decode **tears the translucent surfaces down**, exactly like a
broken clip.

## Tuning it in the UI

A small half-transparent pill sits in the bottom-right corner. Clicking it opens a panel: the
**clip / still switch**, two sliders (panel opacity / picture scrim), three presets, a **live body-text
contrast readout** measured from the current picture, and a reset button.

- Switching the picture type applies and persists on the **single click** (it is a discrete choice); the
  sliders apply while dragging and write on release, so a drag does not fire dozens of requests.
- Both go through `POST`/`DELETE /dsh-video-skin/override` into `$DSH_HOME/dsh-video-skin.json`, and
  **only those four knobs plus the picture type** are written; everything else in the file is preserved.
  A **refresh** picks the values up (no DSH restart), and the file stays hand-editable.
- A file rather than `localStorage`: the desktop page is served from the `dsh-app://` scheme, where Web
  Storage availability is not guaranteed.
- If the write fails (read-only home), the panel says so — it does not pretend to have saved.
- **Reset** clears the four knobs **and** the picture type: “reset” means the whole backdrop, not half of it.
- `Esc` or a click outside closes the panel; `Alt+B` toggles it; `background.controls: false` removes it.
- The pill sits at `z-index: 900`, **below** the kernel's `Modal` overlay (1000) on purpose: a modal
  should cover everything, and a wallpaper control must not steal its clicks.

---

## Install

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1     # writes profile package.json + bundles
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1   # removes both again
```

**A full restart of DSH is required.** The desktop (Electron) shell serves a static `index.html` and
collects the index-injection table **once at host startup**, with no refresh path; `tapIndex` never
applies there. So a newly installed plugin's injection rows only reach the page on the next launch.

## Configure

Defaults work as shipped. To tune, write either file (the second wins):

- `<plugin>/video-skin.config.json`
- `%USERPROFILE%\.dsh\dsh-video-skin.json`

Changes apply on page refresh. On the desktop shell the boot-animation fields are baked into the
startup snapshot, so those need a restart.

```json
{
  "boot":       { "enabled": true, "fadeMs": 1000, "exitMode": "end", "skipFadeMs": 320, "holdMs": 18000, "hint": "点击画面跳过" },
  "background": { "enabled": true, "mode": "video", "image": "assets/background.jpg", "veil": 0.14, "surface": 0.2, "delayMs": 1200, "playbackRate": 1 }
}
```

`mode` picks the picture (`video` = the looping clip, `image` = `image` instead of `file`).
`veil` (scrim over the picture) and `surface` (opacity of the app's `--dsw-alias-*` surfaces) are the two
knobs that trade picture strength against text readability.

## How it is wired

```
Host half
  ├─ ctx.on('webserver/index-inject', table => table.push(styleRow, scriptRow))  ← first thing in apply()
  └─ ctx.inject(['webServer'], …) → /dsh-video-skin/{boot.mp4,background.mp4,background-image}
                                    with Range / ETag / 206 / 416 / HEAD
                                  + /dsh-video-skin/config.json (no-store)
                                  + /dsh-video-skin/override    (POST save / DELETE reset)
```

`background-image` carries **no extension** on purpose: the still may be jpg/png/webp, and `Content-Type`
is derived from the file that is actually on disk — a `.jpg` route name would start lying the moment
someone drops in a png, and a `Content-Type` that disagrees with the bytes gets rejected by the browser.

Three constraints that must not be broken (each one was paid for):

1. **Never `kind:'script-src'`.** The desktop interpreter `await`s external script rows and a rejection
   kills `__DSH_BOOT_READY__`, i.e. the whole app fails to start. An inline `kind:'script'` row cannot fail.
2. **Register the injection listener synchronously in `apply()`.** An object-level `inject` delays `apply`
   past the host's one-shot collection, and the row then never lands.
3. **Keep the overlay on `document.body`, never inside `#root`.** The kernel hydrates `#root`'s existing
   boot DOM (`:scope > [data-dsh-boot]`); inserting a node there breaks hydration.

The backdrop is a `position: fixed; z-index: -1` first child of `body`, so nothing in the app needs a
`z-index` and no pointer interaction is blocked. Inside that layer sits a `<video>` or an `<img>`
(depending on `background.mode`); both use the **same** rules — `object-fit: cover` plus a `data-shown`
fade-in — which is why switching the picture type touches **no CSS at all**, and why “don't show a
half-loaded picture” is one guarantee instead of two.

## Verify

```powershell
node scripts/check-syntax.mjs       # ESM evaluates + injected text parses
node --test "tests/**/*.test.mjs"   # 103 cases
node scripts/verify-all.mjs         # the two above + asset / packaging / patch contracts (17 checks)

# the shipped still, regenerated from the shipped clip (no ffmpeg needed):
node scripts/make-still.mjs
```

`tests/runtime.test.mjs` runs the injected script inside a stub DOM with a virtual clock and asserts the
real timing properties (the clip plays to `ended` before the fade; the fade span is always the configured
`fadeMs`, never the remaining time; a click uses
`skipFadeMs`; **unmuted is tried first and muted is the fallback**; the sound button toggles sound
without skipping; the volume fades to 0 with the picture; unknown duration / no first frame / media
error (retried once) / a never-ready kernel each have an upper bound that never truncates the clip).
`tests/host.test.mjs` drives the real `apply()`
against a real HTTP server for the Range, `ETag`, `304`, `416` and cache-header contracts.

Two more suites need a live target:

```powershell
# 75 assertions (Electron-equivalent autoplay) / 65 (plain browser) in a real headless Chromium over CDP:
#   --autoplay allow (Electron-equivalent): unmuted playback, no sound button,
#                                          webkitAudioDecodedByteCount > 0 (the audio track really decodes)
#   --autoplay block (plain browser)      : muted fallback, sound button visible, a real mouse click on it
#                                          does NOT skip and does unmute
# Plus: overlay covers the viewport, a click at the viewport centre really skips, the fade removes the
# node, the backdrop layer is body's first child at z-index:-1, the --dsw-alias-* tokens really
# *resolve* to translucent colours, the backdrop video really decodes, and the app really mounted.
# It also samples the video frame into a canvas and reports measured WCAG contrast for body text
# (this machine: dark p5 6.86 / median 16.06, light p5 7.90 / median 8.70). --sweep prints the full table.
node scripts/make-verify-profile.mjs
node scripts/verify-browser.mjs --url "http://127.0.0.1:19388/?token=..." --shot-dir docs
node scripts/verify-browser.mjs --url "http://127.0.0.1:19388/?token=..." --autoplay block --port 9445

# Composition rehearsal with the kernel's own loadProfileDirectory, which is the first thing that
# can throw on the boot path. Needed because `dsh --profile desktop --dump-config` is refused.
$env:ELECTRON_RUN_AS_NODE='1'
& 'D:\AI\Agent\DSH官方\DeepSeek Harness.exe' scripts\rehearse-profile.mjs desktop
```

## License

MIT — see [LICENSE](LICENSE).
