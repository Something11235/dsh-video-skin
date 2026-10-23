/**
 * `runtime/skin.js` 的时序测试 —— 把脚本放进桩 DOM + 虚拟时钟里**真跑**。
 *
 * 覆盖的都是"正则证明不了、只有跑起来才知道"的性质：
 *   - 片尾交叉溶解是不是正好从"剩余时间 ≤ fadeMs"开始，并且用的是**真实剩余时间**；
 *   - 片子短于 2×fadeMs 时会不会退化（不能从片子还没出现就开始淡）；
 *   - 点击 / Esc 是不是**立刻**跳过，用的是 skipFadeMs；
 *   - 内核不就绪时会不会硬等，以及上界到点会不会让开；
 *   - 一帧都出不来 / 时长未知 / 素材报错 三条异常路径会不会扣住用户；
 *   - 覆盖层淡完是不是整个从 DOM 移除，背景层是不是在那之后才建；
 *   - 背景素材坏了会不会把半透明表面撤掉（否则界面会变成"没背景、字还发灰"）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createHarness, makeKernelBootPage } from './dom-stub.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME = fs.readFileSync(path.join(here, '..', 'runtime', 'skin.js'), 'utf8')

/** 每个用例都拿一份全新的配置，避免用例之间互相污染。 */
function config(patch = {}) {
  const base = {
    version: 'test',
    config: '/dsh-video-skin/config.json',
    boot: {
      enabled: true,
      src: '/dsh-video-skin/boot.mp4',
      fadeMs: 1000,
      // 默认 `end`：片子放完再淡。要测片尾交叉溶解的用例自己改成 'tail'。
      exitMode: 'end',
      skipFadeMs: 320,
      holdMs: 18000,
      holdGraceMs: 4000,
      noFrameMs: 12000,
      endlessMs: 20000,
      hint: '正在启动…',
      skipLabel: '点击画面跳过',
      sound: true,
      volume: 1,
      soundLabel: '开启声音',
    },
    background: {
      enabled: true,
      src: '/dsh-video-skin/background.mp4',
      veil: 0.14,
      surface: 0.2,
      delayMs: 1200,
      playbackRate: 1,
    },
  }
  return {
    ...base,
    ...patch,
    boot: { ...base.boot, ...(patch.boot ?? {}) },
    background: { ...base.background, ...(patch.background ?? {}) },
  }
}

const overlay = (h) => h.body.querySelector('.dsvs-boot')
const backdrop = (h) => h.body.querySelector('#dsvs-backdrop')
const bootVideo = (h) => h.body.querySelector('.dsvs-boot-video')
const backdropVideo = (h) => h.body.querySelector('#dsvs-backdrop-video')
const soundButton = (h) => h.body.querySelector('.dsvs-boot-sound')

/**
 * 把微任务队列排空。
 *
 * 背景层现在会**先问一次运行期配置**（`fetch` → Promise），所以建层是异步的；
 * 桩 fetch 立刻 resolve，但 `.then` 链要等微任务。同步 advance 完时钟之后必须排一次，
 * 否则断言会在背景层还没建好时就看过去。
 * @returns {Promise<void>} 排空后 resolve。
 */
const flush = () => new Promise((resolve) => setImmediate(resolve))

/** 模拟"片子的第一帧已经出来了"—— 这才会解除"一帧都出不来"那条看门狗。 */
function revealClip(video) {
  video.presentFrame()
  video.dispatchEvent({ type: 'loadeddata' })
}

/** 模拟"内核启动页被真正的应用替换掉"：这是运行时唯一的就绪判据。 */
function reachAppReady(h) {
  const bootEl = h.root.querySelector('[data-dsh-boot]')
  if (bootEl !== null) h.root.removeChild(bootEl)
  const app = h.document.createElement('div')
  app.className = 'app-shell'
  h.root.appendChild(app)
  h.clock.advance(200)
}

test('覆盖层同步占住视口，视频无声、不循环，并且带「点击画面跳过」提醒', () => {
  const h = createHarness()
  h.run(RUNTIME, config())

  const el = overlay(h)
  assert.ok(el, '覆盖层应该已经挂上')
  assert.equal(el.getAttribute('data-state'), 'idle')
  assert.equal(el.getAttribute('role'), 'dialog')

  const skip = el.querySelector('.dsvs-boot-skip')
  assert.ok(skip, '必须有常驻的跳过提醒')
  assert.match(skip.textContent, /点击画面跳过/u)

  const video = bootVideo(h)
  assert.ok(video)
  assert.equal(video.src, '/dsh-video-skin/boot.mp4')
  assert.equal(video.loop, false, '不循环——片尾才是交接信号')
  assert.equal(video.playCalls, 1)
})

test('默认**先试带声音**播放：桌面壳（Electron）就是这条路，未静音能直接成功', () => {
  const h = createHarness()
  h.run(RUNTIME, config({ boot: { sound: true, volume: 0.8 } }))
  const video = bootVideo(h)
  assert.equal(video.muted, false, '默认不是静音的——先按有声播')
  assert.equal(video.mutedAtPlay[0], false, '第一次 play() 必须是未静音的那次')
  assert.equal(soundButton(h).getAttribute('data-visible'), '0', '播成功就不需要声音开关')
})

test('config 关掉声音时一开始就静音，且不出现声音开关', () => {
  const h = createHarness()
  h.run(RUNTIME, config({ boot: { sound: false } }))
  const video = bootVideo(h)
  assert.equal(video.muted, true)
  assert.equal(video.mutedAtPlay[0], true)
  assert.equal(soundButton(h).getAttribute('data-visible'), '0')
})

test('未静音被浏览器拒绝：自动退回静音继续播，并亮出**独立**的声音开关', async () => {
  // 第一个 play()（未静音）拒绝，第二个（静音重试）成功 —— 这就是真实浏览器的形状。
  const h = createHarness({ videoPlayBehaviours: ['reject', 'ok'] })
  h.run(RUNTIME, config())
  await flush()

  const video = bootVideo(h)
  assert.equal(video.muted, true, '被拒之后必须退回静音，而不是不出画面')
  assert.equal(video.mutedAtPlay[0], false, '第一次尝试仍然是未静音的')
  assert.equal(video.mutedAtPlay[1], true, '第二次是静音重试')
  assert.equal(soundButton(h).getAttribute('data-visible'), '1', '亮出独立的声音开关')
  assert.match(overlay(h).querySelector('.dsvs-boot-hint').textContent, /声音/u)
})

test('未静音 play() 既不 resolve 也不 reject：有超时窗口，到点退回静音', () => {
  const h = createHarness({ videoPlayBehaviours: ['pending', 'ok'] })
  h.run(RUNTIME, config())
  h.clock.advance(1300)
  assert.equal(bootVideo(h).muted, true, '超时窗口到点必须退回静音，不能停在裸底色上')
  assert.equal(soundButton(h).getAttribute('data-visible'), '1')
})

test('声音开关是独立命中区：点它只开声音、不跳过；点画面才跳过', async () => {
  const h = createHarness({ videoPlayBehaviours: ['pending', 'ok'] })
  h.run(RUNTIME, config())
  h.clock.advance(1300)
  const button = soundButton(h)
  assert.equal(button.getAttribute('data-visible'), '1')

  button.dispatchEvent({ type: 'pointerdown' })
  button.dispatchEvent({ type: 'click' })
  await flush()
  assert.equal(overlay(h).getAttribute('data-state'), 'idle', '点声音开关绝不能跳过')
  assert.equal(bootVideo(h).muted, false, '按用户手势重试未静音播放')
  assert.equal(soundButton(h).getAttribute('data-visible'), '0', '开成功就收起开关')

  // 点画面：跳过
  overlay(h).dispatchEvent({ type: 'pointerdown' })
  assert.equal(overlay(h).getAttribute('data-state'), 'leaving')
})

test('有声音时淡出会连音量一起淡到 0，不是淡完硬切', () => {
  const h = createHarness()
  h.run(RUNTIME, config({ boot: { volume: 1 } }))
  const video = bootVideo(h)
  assert.equal(video.muted, false)
  revealClip(video)

  overlay(h).dispatchEvent({ type: 'pointerdown' }) // 320ms 淡出
  assert.ok(video.volume > 0, '刚开始淡时音量还没见底')
  h.clock.advance(1000)
  assert.equal(video.volume, 0, '淡出结束时音量必须是 0')
})

test('默认 end 模式：片子放完才淡，界面早就绪也绝不提前截断', async () => {
  const h = createHarness()
  h.root.appendChild(makeKernelBootPage(h.document))
  h.run(RUNTIME, config())
  const video = bootVideo(h)
  video.duration = 8
  video.currentTime = 1
  revealClip(video)
  reachAppReady(h)

  h.clock.advance(32)
  assert.equal(overlay(h).getAttribute('data-state'), 'idle', '离片尾还远时不能开始淡')

  // 一路逼近片尾：`end` 模式下任何时刻都不该动。
  for (const t of [6.4, 7.0, 7.5, 7.99]) {
    video.currentTime = t
    h.clock.advance(32)
    assert.equal(
      overlay(h).getAttribute('data-state'),
      'idle',
      `片子还有 ${(8 - t).toFixed(2)}s，end 模式不该开始淡（t=${t}）`,
    )
  }

  video.ended = true
  video.dispatchEvent({ type: 'ended' })
  h.clock.advance(32)
  const el = overlay(h)
  assert.equal(el.getAttribute('data-state'), 'leaving', '放完了才开始淡')
  assert.equal(el.style.getPropertyValue('--dsvs-boot-fade'), '1000ms', '用固定的 fadeMs')

  h.clock.advance(1200)
  assert.equal(overlay(h), null, '淡出后不能留下任何盖住界面的节点')
  await flush()
  assert.ok(backdrop(h), '交接完成之后才建背景层')
})

test('end 模式：片子放完但界面还没就绪 → 等就绪再淡，不提前放行', () => {
  const h = createHarness()
  h.root.appendChild(makeKernelBootPage(h.document))
  h.run(RUNTIME, config())
  const video = bootVideo(h)
  video.duration = 8
  revealClip(video)
  h.clock.advance(32)

  video.ended = true
  video.dispatchEvent({ type: 'ended' })
  h.clock.advance(32)
  assert.equal(overlay(h).getAttribute('data-state'), 'idle', '界面没就绪就交接会露出空白')

  reachAppReady(h)
  h.clock.advance(32)
  assert.equal(overlay(h).getAttribute('data-state'), 'leaving')
})

test('tail 模式：窗口内开始交叉溶解，且淡出时长是固定的 fadeMs 而不是剩余时间', async () => {
  const h = createHarness()
  h.root.appendChild(makeKernelBootPage(h.document))
  h.run(RUNTIME, config({ boot: { exitMode: 'tail' } }))
  const video = bootVideo(h)
  video.duration = 8
  video.currentTime = 1
  revealClip(video)
  reachAppReady(h)

  h.clock.advance(32)
  video.currentTime = 8 - 1.6 // 剩余 1600ms > fadeMs 1000
  h.clock.advance(32)
  assert.equal(overlay(h).getAttribute('data-state'), 'idle', '窗口外一帧都不能提前淡')

  video.currentTime = 8 - 0.2 // 剩余只有 200ms
  h.clock.advance(32)
  const el = overlay(h)
  assert.equal(el.getAttribute('data-state'), 'leaving', '进入窗口立刻开始交叉溶解')
  // **这一条就是用户报的 bug 的守卫**：早先这里写的是 "200ms"（真实剩余时间），
  // 于是界面就绪得晚时，那次退场短到看起来就是硬切。
  assert.equal(
    el.style.getPropertyValue('--dsvs-boot-fade'),
    '1000ms',
    '淡出时长必须是配置里的固定值，不能缩成"当时还剩多少"',
  )

  h.clock.advance(1200)
  assert.equal(overlay(h), null, '淡出后不能留下任何盖住界面的节点')
  await flush()
  assert.ok(backdrop(h), '交接完成之后才建背景层')
})

test('片子短于 2×fadeMs 时不做尾部溶解，改成放完再淡', () => {
  const h = createHarness()
  h.run(RUNTIME, config({ boot: { exitMode: 'tail' } }))
  const video = bootVideo(h)
  video.duration = 1.5 // 1500 < 2 * 1000
  video.currentTime = 1.4 // 剩余只有 100ms
  revealClip(video)
  reachAppReady(h)
  h.clock.advance(64)
  assert.equal(overlay(h).getAttribute('data-state'), 'idle', '太短的片子不该被尾部窗口截断')

  video.ended = true
  video.dispatchEvent({ type: 'ended' })
  h.clock.advance(32)
  const el = overlay(h)
  assert.equal(el.getAttribute('data-state'), 'leaving')
  assert.equal(el.style.getPropertyValue('--dsvs-boot-fade'), '1000ms')
})

test('点击画面立刻跳过，用 skipFadeMs 而不是 fadeMs', () => {
  const h = createHarness()
  h.run(RUNTIME, config())
  const el = overlay(h)
  el.dispatchEvent({ type: 'pointerdown' })
  assert.equal(el.getAttribute('data-state'), 'leaving')
  assert.equal(el.style.getPropertyValue('--dsvs-boot-fade'), '320ms')
  h.clock.advance(600)
  assert.equal(overlay(h), null)
})

test('Esc / 空格 / 回车都能跳过', () => {
  for (const key of ['Escape', ' ', 'Enter']) {
    const h = createHarness()
    h.run(RUNTIME, config())
    h.document.dispatchEvent({ type: 'keydown', key })
    assert.equal(overlay(h).getAttribute('data-state'), 'leaving', `${key} 应该能跳过`)
  }
})

test('内核一直不就绪：不会硬等，上界到点带淡出让开', () => {
  const h = createHarness()
  h.root.appendChild(makeKernelBootPage(h.document))
  h.run(RUNTIME, config({ boot: { holdMs: 5000 } }))
  const video = bootVideo(h)
  video.duration = 1.5
  revealClip(video)
  video.ended = true
  video.dispatchEvent({ type: 'ended' })
  h.clock.advance(64)
  assert.equal(overlay(h).getAttribute('data-state'), 'idle', '界面没就绪就不能交接')
  assert.match(overlay(h).querySelector('.dsvs-boot-hint').textContent, /就绪/u)

  h.clock.advance(5000)
  const el = overlay(h)
  assert.equal(el.getAttribute('data-state'), 'leaving', '上界到了必须让开')
  assert.match(el.querySelector('.dsvs-boot-hint').textContent, /启动较慢/u)
})

test('片子开始播但一帧都出不来：有上界，且到点照样交接', () => {
  const h = createHarness()
  h.run(RUNTIME, config({ boot: { noFrameMs: 3000 } }))
  reachAppReady(h)
  h.clock.advance(3100)
  assert.equal(overlay(h).getAttribute('data-state'), 'leaving')
})

test('时长未知（duration = Infinity）：靠唯一的上界放开，不会永久卡住', () => {
  const h = createHarness()
  h.run(RUNTIME, config())
  const video = bootVideo(h)
  video.duration = Infinity
  revealClip(video)
  video.dispatchEvent({ type: 'loadedmetadata' })
  reachAppReady(h)
  h.clock.advance(1000)
  assert.equal(overlay(h).getAttribute('data-state'), 'idle')
  // 走到 endlessMs（1000 已过，再补 19000）。断言"开始淡出"而不是"覆盖层还在"，
  // 免得把断言的成败绑在 fadeMs 的大小上。
  h.clock.advance(19000)
  assert.equal(overlay(h).getAttribute('data-state'), 'leaving')
})

test('素材报错：先重试一次；两次都失败才让开（吃掉启动瞬间的瞬时抖动）', () => {
  const h = createHarness()
  h.run(RUNTIME, config())
  reachAppReady(h)
  const video = bootVideo(h)
  const firstSrc = video.src

  video.dispatchEvent({ type: 'error' })
  h.clock.advance(32)
  // 一次 error ≠ 素材坏了。早先这里直接 markClipDone，界面一就绪就退场，
  // 表现就是"开机动画有时候还没放完就切了"（宿主刚启动时路由偶尔应答不上）。
  assert.equal(overlay(h).getAttribute('data-state'), 'idle', '第一次报错要重试，不能当场退场')
  assert.equal(video.src, firstSrc, '重试就是重新挂同一个 src')
  assert.ok(
    h.window.__DSH_VIDEO_SKIN__.state.failures.includes('video-error-retry'),
    '诊断里要留下重试痕迹',
  )

  video.dispatchEvent({ type: 'error' })
  h.clock.advance(32)
  assert.equal(overlay(h).getAttribute('data-state'), 'leaving', '第二次才认输')
})

test('重试之后一帧都出不来：新的看门狗仍然把用户放开', () => {
  const h = createHarness()
  h.run(RUNTIME, config({ boot: { noFrameMs: 3000 } }))
  reachAppReady(h)
  const video = bootVideo(h)
  video.dispatchEvent({ type: 'error' })
  h.clock.advance(3100)
  assert.equal(overlay(h).getAttribute('data-state'), 'leaving')
})

test('内核超时不截断动画：片子还在放就让它放完，宽限用完才硬让开', () => {
  const h = createHarness()
  h.run(RUNTIME, config({ boot: { holdMs: 5000, holdGraceMs: 2000 } }))
  const video = bootVideo(h)
  video.duration = 20
  video.currentTime = 4
  revealClip(video)

  // 到 holdMs 时片子还剩 16 秒 —— 不能当场切掉。
  h.clock.advance(5100)
  assert.equal(overlay(h).getAttribute('data-state'), 'idle', '超时不该把动画截在中间')
  assert.match(overlay(h).querySelector('.dsvs-boot-hint').textContent, /启动较慢/u)

  // 宽限期内片子放完 → 走正常交接。
  video.currentTime = 20
  video.ended = true
  video.dispatchEvent({ type: 'ended' })
  h.clock.advance(32)
  assert.equal(overlay(h).getAttribute('data-state'), 'leaving')

  // 另一条路：片子一直没放完，宽限用完必须让开（这块屏是装饰品）。
  const h2 = createHarness()
  h2.run(RUNTIME, config({ boot: { holdMs: 5000, holdGraceMs: 2000 } }))
  const video2 = bootVideo(h2)
  video2.duration = 600
  video2.currentTime = 1
  revealClip(video2)
  h2.clock.advance(5100)
  assert.equal(overlay(h2).getAttribute('data-state'), 'idle')
  h2.clock.advance(2100)
  assert.equal(overlay(h2).getAttribute('data-state'), 'leaving', '宽限用完还是得让开')
})

test('内核启动失败：提示转琥珀色，并自动让开让用户看到失败原因', () => {
  const h = createHarness()
  const bootEl = makeKernelBootPage(h.document)
  bootEl.textContent = 'Failed to load plugins'
  h.root.appendChild(bootEl)
  h.run(RUNTIME, config())
  h.clock.advance(500)
  const el = overlay(h)
  assert.equal(el.getAttribute('data-attention'), '1')
  assert.match(el.querySelector('.dsvs-boot-hint').textContent, /启动失败/u)
  h.clock.advance(2700)
  assert.equal(el.getAttribute('data-state'), 'leaving')
})

test('背景层：挂在 body 最前面、data-dsvs 打开半透明表面、素材延后加载', async () => {
  const h = createHarness()
  h.run(RUNTIME, config())
  overlay(h).dispatchEvent({ type: 'pointerdown' })
  h.clock.advance(600)
  await flush()

  const layer = backdrop(h)
  assert.ok(layer)
  assert.equal(h.body.firstChild, layer, '背景层要是 body 的第一个孩子，落在所有内容之下')
  assert.equal(h.documentElement.getAttribute('data-dsvs'), 'on')
  assert.equal(h.documentElement.style.getPropertyValue('--dsvs-surface'), '0.2')
  assert.equal(h.documentElement.style.getPropertyValue('--dsvs-veil'), '0.14')
  assert.equal(h.documentElement.style.getPropertyValue('--dsvs-sidebar'), '0.26')
  // **弹层/对话框/卡片那几层（layer1/2/3）故意不派生**：它们必须保持内核原生不透明色，
  // 否则背后的正文会透进对话框里（用户报的"设置页看不清"就是这个）。
  for (const key of ['--dsvs-layer1', '--dsvs-layer2', '--dsvs-layer3', '--dsvs-l-layer1', '--dsvs-l-layer2', '--dsvs-l-layer3']) {
    assert.equal(h.documentElement.style.getPropertyValue(key), '', `${key} 不该由插件派生`)
  }

  const video = backdropVideo(h)
  assert.equal(video.loop, true, '背景循环播放')
  assert.equal(video.muted, true, '背景无声')
  assert.equal(video.playCalls, 0, '界面就绪后先不抢带宽')
  h.clock.advance(1200)
  assert.equal(video.src, '/dsh-video-skin/background.mp4')
  assert.equal(video.playCalls, 1)
})

test('背景层用运行期配置路由里的值建起来（改 JSON 刷新即生效，不必重启）', async () => {
  const h = createHarness()
  // 模拟 /dsh-video-skin/config.json 回了一份覆盖：surface 0.05 / veil 0
  h.window.fetch = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          background: { surface: 0.05, veil: 0, src: '/dsh-video-skin/background.mp4', enabled: true, delayMs: 0 },
        }),
    })
  h.run(RUNTIME, config())
  overlay(h).dispatchEvent({ type: 'pointerdown' })
  h.clock.advance(600)
  await flush()

  assert.equal(h.documentElement.style.getPropertyValue('--dsvs-surface'), '0.05')
  assert.equal(h.documentElement.style.getPropertyValue('--dsvs-veil'), '0')
})

test('背景素材报错：撤掉半透明表面，界面回到原生外观', async () => {
  const h = createHarness()
  h.run(RUNTIME, config())
  overlay(h).dispatchEvent({ type: 'pointerdown' })
  h.clock.advance(600)
  await flush()
  backdropVideo(h).dispatchEvent({ type: 'error' })
  assert.equal(backdrop(h), null)
  assert.equal(h.documentElement.hasAttribute('data-dsvs'), false)
})

test('窗口不可见时暂停背景播放，回来时续播', async () => {
  const h = createHarness()
  h.run(RUNTIME, config())
  overlay(h).dispatchEvent({ type: 'pointerdown' })
  h.clock.advance(2000)
  await flush()
  const video = backdropVideo(h)
  h.document.hidden = true
  h.document.dispatchEvent({ type: 'visibilitychange' })
  assert.equal(video.paused, true)
  h.document.hidden = false
  h.document.dispatchEvent({ type: 'visibilitychange' })
  assert.equal(video.paused, false)
})

test('关掉开机动画：没有覆盖层，背景直接上', async () => {
  const h = createHarness()
  h.run(RUNTIME, config({ boot: { enabled: false } }))
  assert.equal(overlay(h), null)
  await flush()
  assert.ok(backdrop(h))
})

test('两个都关掉：什么也不注入', async () => {
  const h = createHarness()
  h.run(RUNTIME, config({ boot: { enabled: false }, background: { enabled: false } }))
  assert.equal(overlay(h), null)
  await flush()
  assert.equal(backdrop(h), null)
  assert.equal(h.documentElement.hasAttribute('data-dsvs'), false)
})

test('系统要求减少动态效果：不播常驻循环的背景视频', async () => {
  const h = createHarness({ reducedMotion: true })
  h.run(RUNTIME, config())
  overlay(h).dispatchEvent({ type: 'pointerdown' })
  h.clock.advance(2000)
  await flush()
  assert.equal(backdrop(h), null)
})

test('重复注入（重复的注入行）只生效一次', () => {
  const h = createHarness()
  h.run(RUNTIME, config())
  h.run(RUNTIME, config())
  assert.equal(h.body.querySelectorAll('.dsvs-boot').length, 1)
})

test('<body> 还不存在时不抛，等到 DOMContentLoaded 再挂', () => {
  const h = createHarness({ withBody: false })
  h.run(RUNTIME, config())
  assert.equal(overlay(h), null)
  h.document.body = h.body
  h.document.dispatchEvent({ type: 'DOMContentLoaded' })
  assert.ok(overlay(h))
})

test('没有 document / 没有配置时静默返回，绝不抛异常', () => {
  const noDoc = { __DSH_VIDEO_SKIN__: config() }
  assert.doesNotThrow(() => {
    new Function('globalThis', 'window', 'self', RUNTIME)(noDoc, noDoc, noDoc)
  })
  const noConfig = createHarness()
  assert.doesNotThrow(() => {
    new Function('globalThis', 'window', 'self', RUNTIME)(noConfig.window, noConfig.window, noConfig.window)
  })
  assert.equal(noConfig.body.querySelector('.dsvs-boot'), null)
})

test('非法配置被夹取：fadeMs 不能是 0，surface 不能超出 0..1', async () => {
  const h = createHarness()
  h.run(RUNTIME, config({ boot: { fadeMs: 0, skipFadeMs: -5 }, background: { surface: 9, veil: 5 } }))
  const el = overlay(h)
  el.dispatchEvent({ type: 'pointerdown' })
  // fadeMs=0 → 夹到 200；skipFadeMs=-5 → 夹到 80。
  assert.equal(el.style.getPropertyValue('--dsvs-boot-fade'), '80ms')
  h.clock.advance(400)
  await flush()
  assert.equal(h.documentElement.style.getPropertyValue('--dsvs-surface'), '1')
  assert.equal(h.documentElement.style.getPropertyValue('--dsvs-veil'), '0.92')
})

// ────────────────────── 透明度调节控件（界面滑块） ──────────────────────

const pill = (h) => h.body.querySelector('#dsvs-knobs-pill')
const panel = (h) => h.body.querySelector('#dsvs-knobs')
const ranges = (h) => panel(h).querySelectorAll('.dsvs-knobs-range')

/** 起一份配置：带 override 路由地址，读回可用。 */
function knobConfig(patch = {}) {
  const base = config(patch)
  return { ...base, override: '/dsh-video-skin/override' }
}

/** 把覆盖层跳掉、等背景层（控件是在那一步建的）。 */
async function reachBackdrop(h) {
  const el = overlay(h)
  if (el !== null) el.dispatchEvent({ type: 'pointerdown' })
  h.clock.advance(600)
  await flush()
}

/** 装一个会记账的 fetch，用来断言"什么时候写回、写了什么"。 */
function spyFetch(h, result = { ok: true, persisted: true }) {
  const calls = []
  h.window.fetch = (url, init) => {
    calls.push({ url, method: (init && init.method) || 'GET', body: init && init.body })
    // 配置路由（GET /config.json）也在同一个 fetch 上走，所以调用方要自己筛。
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(
          url === '/dsh-video-skin/override' ? result : { background: {}, boot: {}, version: 't' },
        ),
    })
  }
  return calls
}

/** 只留下打到写回端点的那几次调用。 */
const writes = (calls) => calls.filter((call) => call.url === '/dsh-video-skin/override')

test('透明度控件：背景层建好后出现圆钮，面板默认收起', async () => {
  const h = createHarness()
  h.run(RUNTIME, knobConfig())
  await reachBackdrop(h)

  assert.ok(backdrop(h), '背景层在')
  assert.ok(pill(h), '圆钮在')
  assert.ok(panel(h), '面板在（但收着）')
  assert.equal(panel(h).getAttribute('data-open'), '0')
  assert.equal(pill(h).getAttribute('aria-label'), '聊天背景透明度')
  assert.equal(ranges(h).length, 3, '三个滑块：画布不透明度 / 视频蒙版 / 面板不透明度')
  // 初始位置要对上当前配置（surface 0.2 / veil 0.14 / panel 1）。
  assert.equal(ranges(h)[0].value, '20')
  assert.equal(ranges(h)[1].value, '14')
  assert.equal(ranges(h)[2].value, '100', '面板不透明度默认 100%（原生不透明）')
  // 默认不覆盖 layer token、也不挂开关属性。
  assert.equal(h.documentElement.hasAttribute('data-dsvs-panel'), false)
})

test('background.controls:false 时完全不注入控件', async () => {
  const h = createHarness()
  h.run(RUNTIME, knobConfig({ background: { controls: false } }))
  await reachBackdrop(h)
  assert.ok(backdrop(h), '背景层照旧')
  assert.equal(pill(h), null)
  assert.equal(panel(h), null)
})

test('点圆钮展开、点关闭收起、Alt+B 也能切换', async () => {
  const h = createHarness()
  h.run(RUNTIME, knobConfig())
  await reachBackdrop(h)

  pill(h).dispatchEvent({ type: 'click' })
  assert.equal(panel(h).getAttribute('data-open'), '1')
  panel(h).querySelector('.dsvs-knobs-close').dispatchEvent({ type: 'click' })
  assert.equal(panel(h).getAttribute('data-open'), '0')

  h.document.dispatchEvent({ type: 'keydown', key: 'b', altKey: true })
  assert.equal(panel(h).getAttribute('data-open'), '1')
})

test('Esc 收起面板；点面板外面也收起（面板会盖住输入框右下角）', async () => {
  const h = createHarness()
  h.run(RUNTIME, knobConfig())
  await reachBackdrop(h)

  pill(h).dispatchEvent({ type: 'click' })
  assert.equal(panel(h).getAttribute('data-open'), '1')
  h.document.dispatchEvent({ type: 'keydown', key: 'Escape' })
  assert.equal(panel(h).getAttribute('data-open'), '0', 'Esc 先关面板')

  pill(h).dispatchEvent({ type: 'click' })
  assert.equal(panel(h).getAttribute('data-open'), '1')
  // 点面板**里面**不收起。
  h.document.dispatchEvent({ type: 'pointerdown', target: ranges(h)[0] })
  assert.equal(panel(h).getAttribute('data-open'), '1')
  // 点外面收起。
  h.document.dispatchEvent({ type: 'pointerdown', target: h.root })
  assert.equal(panel(h).getAttribute('data-open'), '0')
})

test('拖滑块立刻改表面不透明度，松手才写回宿主', async () => {
  const h = createHarness()
  const calls = spyFetch(h)
  h.run(RUNTIME, knobConfig())
  await reachBackdrop(h)

  const surface = ranges(h)[0]
  surface.value = '80'
  surface.dispatchEvent({ type: 'input' })
  assert.equal(h.documentElement.style.getPropertyValue('--dsvs-surface'), '0.8', '拖动即时生效')
  assert.equal(writes(calls).length, 0, '拖动过程中不该打写回请求')

  surface.dispatchEvent({ type: 'change' })
  await flush()
  const sent = writes(calls)
  assert.equal(sent.length, 1, '松手才写一次')
  assert.equal(sent[0].method, 'POST')
  assert.deepEqual(JSON.parse(sent[0].body), {
    // 五个键一起写：只写 surface 的话，亮主题那边有显式的 surfaceLight 压着，拖了等于没拖。
    // panel 也一起写，否则"面板不透明度"调完刷新就丢。
    background: { surface: 0.8, surfaceLight: 1, veil: 0.14, veilLight: 0.098, panel: 1 },
  })
})

test('面板不透明度：默认 100% 不覆盖内核 token，调低才挂 data-dsvs-panel', async () => {
  const h = createHarness()
  const calls = spyFetch(h)
  h.run(RUNTIME, knobConfig())
  await reachBackdrop(h)

  const root = h.documentElement
  // 默认：不挂属性、不写 layer 变量 —— 内核原生不透明色原样保留。
  assert.equal(root.hasAttribute('data-dsvs-panel'), false)
  assert.equal(root.style.getPropertyValue('--dsvs-panel-2'), '')

  const panelInput = ranges(h)[2]
  panelInput.value = '60'
  panelInput.dispatchEvent({ type: 'input' })
  assert.equal(root.getAttribute('data-dsvs-panel'), 'on', '调低后开关属性挂上，CSS 规则才生效')
  assert.equal(root.style.getPropertyValue('--dsvs-panel-1'), '0.6')
  assert.equal(root.style.getPropertyValue('--dsvs-panel-2'), '0.66', '每层留一点高差，保持层次感')
  assert.equal(root.style.getPropertyValue('--dsvs-panel-3'), '0.7')

  panelInput.dispatchEvent({ type: 'change' })
  await flush()
  const sent = writes(calls)
  assert.equal(sent.length, 1)
  assert.equal(JSON.parse(sent[0].body).background.panel, 0.6, '面板不透明度也要写回')

  // 拖回 100% → 属性摘掉、变量清掉，回到"完全不覆盖"。
  panelInput.value = '100'
  panelInput.dispatchEvent({ type: 'change' })
  await flush()
  assert.equal(root.hasAttribute('data-dsvs-panel'), false, '回到 100% 就该恢复内核原生色')
  assert.equal(root.style.getPropertyValue('--dsvs-panel-2'), '')
  assert.equal(JSON.parse(writes(calls)[1].body).background.panel, 1)
})

test('预设按钮一键切换，并且会写回', async () => {
  const h = createHarness()
  const calls = spyFetch(h)
  h.run(RUNTIME, knobConfig())
  await reachBackdrop(h)

  const presets = panel(h).querySelectorAll('.dsvs-knobs-preset')
  assert.equal(presets.length, 3)
  // 第三个是「视频最清」：surface 0 / veil 0。
  presets[2].dispatchEvent({ type: 'click' })
  await flush()
  assert.equal(h.documentElement.style.getPropertyValue('--dsvs-surface'), '0')
  assert.equal(h.documentElement.style.getPropertyValue('--dsvs-l-surface'), '0.4', '亮主题跟着走（0 + 0.4）')
  assert.equal(h.documentElement.style.getPropertyValue('--dsvs-veil'), '0')
  assert.equal(h.documentElement.style.getPropertyValue('--dsvs-l-veil'), '0')
  const sent = writes(calls)
  assert.equal(sent.length, 1)
  assert.deepEqual(JSON.parse(sent[0].body), {
    background: { surface: 0, surfaceLight: 0.4, veil: 0, veilLight: 0, panel: 1 },
  })
})

test('恢复默认发 DELETE，并把滑块退回宿主给的值', async () => {
  const h = createHarness()
  const calls = spyFetch(h)
  h.run(RUNTIME, knobConfig({ background: { surface: 0.5, veil: 0.3 } }))
  await reachBackdrop(h)

  ranges(h)[0].value = '5'
  ranges(h)[0].dispatchEvent({ type: 'input' })
  assert.equal(h.documentElement.style.getPropertyValue('--dsvs-surface'), '0.05')

  panel(h).querySelector('.dsvs-knobs-reset').dispatchEvent({ type: 'click' })
  await flush()
  const sent = writes(calls)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].method, 'DELETE')
  assert.equal(ranges(h)[0].value, '50', '滑块退回宿主给的值')
  assert.equal(h.documentElement.style.getPropertyValue('--dsvs-surface'), '0.5')
})

test('写回失败时如实说出来，不假装成功', async () => {
  const h = createHarness()
  spyFetch(h, { ok: false, persisted: false })
  h.run(RUNTIME, knobConfig())
  await reachBackdrop(h)

  ranges(h)[0].value = '40'
  ranges(h)[0].dispatchEvent({ type: 'input' })
  ranges(h)[0].dispatchEvent({ type: 'change' })
  await flush()
  assert.match(panel(h).querySelector('.dsvs-knobs-status').textContent, /没能写进/u)
  assert.equal(h.documentElement.style.getPropertyValue('--dsvs-surface'), '0.4', '本次会话仍然生效')
})

test('拆掉背景层时透明度控件一起消失', async () => {
  const h = createHarness()
  h.run(RUNTIME, knobConfig())
  await reachBackdrop(h)
  assert.ok(pill(h))

  h.window.__DSH_VIDEO_SKIN__.teardown()
  assert.equal(pill(h), null, '圆钮不能留成一个点了没反应的孤儿')
  assert.equal(panel(h), null)
})

test('面板里的读数把暗/亮两个主题都写出来（滑块只调一个值，两边按规则联动）', async () => {
  const h = createHarness()
  h.run(RUNTIME, knobConfig())
  await reachBackdrop(h)
  const notes = panel(h).querySelectorAll('.dsvs-knobs-note')
  // surface 0.2 → 亮色 0.6；veil 0.14 → 亮色 0.1（四舍五入到百分比）。
  assert.match(notes[0].textContent, /暗色 20% · 亮色 60%/u)
  assert.match(notes[1].textContent, /暗色 14% · 亮色 10%/u)
})

test('contrastStats：合成顺序与对比度都对得上（纯函数部分）', () => {
  const api = createHarness()
  api.run(RUNTIME, knobConfig())
  const internals = api.window.__DSH_VIDEO_SKIN__.__test
  const black = new Uint8ClampedArray([0, 0, 0, 255])
  const white = new Uint8ClampedArray([255, 255, 255, 255])
  const opaqueWhite = { r: 255, g: 255, b: 255, a: 1 }
  const pureWhiteText = { r: 255, g: 255, b: 255, a: 1 }
  const transparent = { r: 0, g: 0, b: 0, a: 0 }

  // 不透明白面 → 背景就是白的，白字对比度 = 1。
  assert.equal(internals.contrastStats(black, transparent, opaqueWhite, pureWhiteText).min, 1)
  // 完全透明且没有蒙版 → 黑画面上的白字是最高对比度（21:1）。
  const high = internals.contrastStats(black, transparent, transparent, pureWhiteText)
  assert.ok(high.min > 20.9 && high.min <= 21, `黑底白字应接近 21，实际 ${high.min}`)
  // 白画面 + 白字 → 1:1，读不了。
  assert.equal(internals.contrastStats(white, transparent, transparent, pureWhiteText).min, 1)
  // 面板越实，深色文字在**暗画面**上的对比度越高（单调性）。
  // 注意要用暗像素：白像素配白面无论多实都是白底，测不出单调性。
  const darkText = { r: 15, g: 17, b: 21, a: 1 }
  const darkPixel = new Uint8ClampedArray([40, 42, 48, 255])
  const thinner = internals.contrastStats(darkPixel, transparent, { r: 255, g: 255, b: 255, a: 0.3 }, darkText).min
  const heavier = internals.contrastStats(darkPixel, transparent, { r: 255, g: 255, b: 255, a: 0.9 }, darkText).min
  assert.ok(heavier > thinner, `白面越实，暗底上的深色文字越清楚（${heavier} 应 > ${thinner}）`)
})

test('parseColor 认 rgb / rgba / color(srgb)', () => {
  const h = createHarness()
  h.run(RUNTIME, knobConfig())
  const parse = h.window.__DSH_VIDEO_SKIN__.__test.parseColor
  assert.deepEqual(parse('rgb(233, 236, 242)'), { r: 233, g: 236, b: 242, a: 1 })
  assert.deepEqual(parse('rgba(255, 255, 255, 0.6)'), { r: 255, g: 255, b: 255, a: 0.6 })
  assert.deepEqual(parse('color(srgb 0.5 0.25 0.75 / 0.5)'), { r: 127.5, g: 63.75, b: 191.25, a: 0.5 })
  assert.equal(parse('transparent'), null)
  assert.equal(parse(''), null)
})
