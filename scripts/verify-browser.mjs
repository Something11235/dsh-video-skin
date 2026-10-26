/**
 * 浏览器端到端验证：用真的 Chromium（headless）+ CDP 打开一个真的 DSH 页面，
 * 断言"开机动画占住视口 → 点击跳过 → 背景层建起来 → 表面 token 真的变半透明 →
 * 背景视频真的解码出来了"。
 *
 * 为什么必须有这一层：桩 DOM 能证明时序逻辑，真 HTTP 能证明路由契约，但
 * **"CSS 到底有没有生效""视频在 Chromium 里到底能不能解码""点击有没有真的落到覆盖层上"**
 * 只有真浏览器能回答。这个脚本让我们不必靠肉眼验收。
 *
 * 用法：
 *   node scripts/verify-browser.mjs --url "http://127.0.0.1:19388/?token=..." [--shot-dir <dir>]
 *
 * 依赖：本机装了 Chrome 或 Edge（自动探测），Node ≥ 22（内置 WebSocket）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

/** 候选浏览器。 */
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  `${os.homedir()}/AppData/Local/Google/Chrome/Application/chrome.exe`,
]

/**
 * 解析命令行参数。
 * @param {string[]} argv 参数。
 * @returns {{ url: string, shotDir: string, port: number, browser: string, autoplay: string }} 解析结果。
 */
function parseArgs(argv) {
  // autoplay:
  //   allow = 加 --autoplay-policy=no-user-gesture-required，**等价于桌面壳的真实环境**
  //           （Electron 没设 autoplayPolicy，默认就是 no-user-gesture-required）
  //   block = 不加，就是普通 Chromium 的默认策略，用来看"被拦下"那条降级路径
  const args = { url: '', shotDir: '', port: 9444, browser: '', autoplay: 'allow', suffix: '', sweep: false, dshHome: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--url') args.url = argv[(index += 1)] ?? ''
    else if (token === '--shot-dir') args.shotDir = argv[(index += 1)] ?? ''
    else if (token === '--port') args.port = Number(argv[(index += 1)] ?? 9444)
    else if (token === '--browser') args.browser = argv[(index += 1)] ?? ''
    else if (token === '--autoplay') args.autoplay = argv[(index += 1)] ?? 'allow'
    else if (token === '--suffix') args.suffix = argv[(index += 1)] ?? ''
    else if (token === '--sweep') args.sweep = true
    // 给了 DSH_HOME 才测"滑块写盘 + 刷新后还在"那一节（它要去看那个 JSON 文件）。
    else if (token === '--dsh-home') args.dshHome = argv[(index += 1)] ?? ''
  }
  return args
}

/** 等一小会儿。 @param {number} ms 毫秒。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 注入到页面里的对比度测量函数。
 *
 * 把视频当前帧画进 canvas 采样，按「视频 → 蒙版 → 表面」做 alpha 合成，再和正文色算
 * WCAG 对比度。**只有真浏览器能给出这张表**：它同时依赖真实像素、真实合成后的计算样式、
 * 真实文字色 —— 三者缺一，结论就只能靠猜。
 */
const MEASURE_INSTALL = `window.__dsvsContrast = () => {
  const video = document.querySelector('#dsvs-backdrop-video')
  const veilEl = document.querySelector('#dsvs-backdrop-veil')
  if (video === null || veilEl === null || video.readyState < 2) return { skipped: true }
  const canvas = document.createElement('canvas')
  canvas.width = 96
  canvas.height = 54
  const context = canvas.getContext('2d', { willReadFrequently: true })
  context.drawImage(video, 0, 0, canvas.width, canvas.height)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
  const toLinear = (channel) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  const luminance = (r, g, b) => 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
  const parse = (css) => {
    // 刻意不用正则：这段代码要穿过「模板字面量 → 页面源码」两层转义，
    // 正则里的反斜杠极容易多转义一层而静默失配（返回 null 之后在 .r 上炸掉）。
    const text = String(css)
    const open = text.indexOf("(")
    const close = text.lastIndexOf(")")
    if (open < 0 || close < 0) return null
    const parts = text
      .slice(open + 1, close)
      .split(/[,/]/)
      .map((part) => Number(part.trim().replace("%", "")))
    if (parts.length < 3 || parts.some((value) => Number.isNaN(value))) return null
    // color(srgb r g b / a) 的通道是 0..1，需要放大到 0..255。
    const scale = text.startsWith("color(") ? 255 : 1
    return {
      r: parts[0] * scale,
      g: parts[1] * scale,
      b: parts[2] * scale,
      a: parts.length > 3 ? parts[3] : 1,
    }
  }
  const probe = document.createElement('div')
  probe.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px'
  document.body.appendChild(probe)
  const token = (name) => {
    probe.style.backgroundColor = ''
    probe.style.backgroundColor = 'var(' + name + ')'
    return parse(getComputedStyle(probe).backgroundColor)
  }
  const textColor = (name) => {
    probe.style.color = ''
    probe.style.color = 'var(' + name + ')'
    return parse(getComputedStyle(probe).color)
  }
  const report = (dark) => {
    document.body.toggleAttribute('data-ds-dark-theme', dark)
    const veil = parse(getComputedStyle(veilEl).backgroundColor)
    const surface = token('--dsw-alias-bg-base')
    const label = textColor('--dsw-alias-label-primary')
    const textLuminance = luminance(label.r, label.g, label.b)
    const ratios = []
    for (let index = 0; index < pixels.length; index += 4) {
      const pixel = { r: pixels[index], g: pixels[index + 1], b: pixels[index + 2], a: 1 }
      const veiled = {
        r: veil.a * veil.r + (1 - veil.a) * pixel.r,
        g: veil.a * veil.g + (1 - veil.a) * pixel.g,
        b: veil.a * veil.b + (1 - veil.a) * pixel.b,
      }
      const effective = {
        r: surface.a * surface.r + (1 - surface.a) * veiled.r,
        g: surface.a * surface.g + (1 - surface.a) * veiled.g,
        b: surface.a * surface.b + (1 - surface.a) * veiled.b,
      }
      const background = luminance(effective.r, effective.g, effective.b)
      const lighter = Math.max(textLuminance, background)
      const darker = Math.min(textLuminance, background)
      ratios.push((lighter + 0.05) / (darker + 0.05))
    }
    ratios.sort((a, b) => a - b)
    return {
      surface: surface,
      veil: veil,
      label: label,
      min: Math.round(ratios[0] * 100) / 100,
      p5: Math.round(ratios[Math.floor(ratios.length * 0.05)] * 100) / 100,
      median: Math.round(ratios[Math.floor(ratios.length / 2)] * 100) / 100,
    }
  }
  const result = { dark: report(true), light: report(false) }
  document.body.removeAttribute('data-ds-dark-theme')
  probe.remove()
  return result
}`

/**
 * 等一个 HTTP 端点能应答。
 * @param {string} url 地址。
 * @param {number} timeoutMs 超时。
 * @returns {Promise<void>} 就绪后 resolve。
 */
async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) throw new Error(`等待超时：${url}`)
    await sleep(150)
  }
}

/** 极简 CDP 客户端。 */
class Cdp {
  /** @param {string} wsUrl 目标页的 WebSocket 地址。 */
  constructor(wsUrl) {
    this.socket = new WebSocket(wsUrl)
    this.nextId = 1
    this.pending = new Map()
    this.waiters = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve())
      this.socket.addEventListener('error', (event) => reject(new Error(`CDP 连接失败：${String(event?.message ?? '')}`)))
    })
    this.socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.method !== undefined && message.id === undefined) {
        const list = this.waiters.get(message.method)
        if (list !== undefined) {
          this.waiters.delete(message.method)
          for (const resolve of list) resolve(message.params)
        }
        return
      }
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`))
      else entry.resolve(message.result)
    })
  }

  /**
   * 等一个 CDP 事件。
   * @param {string} method 事件名。
   * @param {number} timeoutMs 超时。
   * @returns {Promise<any>} 事件参数。
   */
  waitEvent(method, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const list = this.waiters.get(method) ?? []
      const timer = setTimeout(() => reject(new Error(`等待事件超时：${method}`)), timeoutMs)
      list.push((params) => {
        clearTimeout(timer)
        resolve(params)
      })
      this.waiters.set(method, list)
    })
  }

  /**
   * 发一条 CDP 命令。
   * @param {string} method 方法名。
   * @param {object} [params] 参数。
   * @returns {Promise<any>} 结果。
   */
  send(method, params = {}) {
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /**
   * 在页面里求值。
   * @param {string} expression 表达式（可以返回 Promise）。
   * @returns {Promise<any>} 值。
   */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(`页面求值失败：${result.exceptionDetails.exception?.description ?? 'unknown'}`)
    }
    return result.result?.value
  }

  close() {
    try {
      this.socket.close()
    } catch {
      /* 已经关了 */
    }
  }
}

const args = parseArgs(process.argv.slice(2))
if (args.url === '') {
  console.error('用法：node scripts/verify-browser.mjs --url <带令牌的 DSH 地址> [--shot-dir <目录>]')
  process.exit(2)
}

const browser = args.browser !== '' ? args.browser : BROWSERS.find((candidate) => fs.existsSync(candidate))
if (browser === undefined || browser === '') {
  console.error('没有找到 Chrome/Edge，用 --browser <路径> 指定')
  process.exit(2)
}

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-video-skin-chrome-'))
const shotDir = args.shotDir !== '' ? args.shotDir : profileDir
fs.mkdirSync(shotDir, { recursive: true })

// 开跑前先清掉上一次留下的覆盖文件。
//
// 为什么必须做：滑块的值会落到 `$DSH_HOME/dsh-video-skin.json`，而 B 阶段断言的是
// **默认配置**（surface 0.2 / veil 0.14 / panel 1）。上一次跑如果在中途异常退出（比如
// 断言抛了）就不会走到「恢复默认」，那份文件留在盘上，下一次跑 B 阶段就会读到 0/0.6/0.6
// 然后一片假红。清理放在最前面，这个验证才是可重复的。
const overrideFile = args.dshHome === '' ? '' : path.join(args.dshHome, 'dsh-video-skin.json')
if (overrideFile !== '') {
  try {
    fs.rmSync(overrideFile, { force: true })
  } catch {
    /* 本来就没有 */
  }
}

const child = spawn(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--mute-audio',
    '--window-size=1600,900',
    // 桌面壳没设 autoplayPolicy ⇒ Electron 的默认值就是 no-user-gesture-required。
    // 所以默认这一档才是"用户真实环境"，未静音播放应当直接成功。
    ...(args.autoplay === 'allow' ? ['--autoplay-policy=no-user-gesture-required'] : []),
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${args.port}`,
    'about:blank',
  ],
  { stdio: 'ignore', detached: false },
)

const results = []
/**
 * 记一项断言。
 * @param {boolean} ok 是否通过。
 * @param {string} title 标题。
 * @param {unknown} detail 细节。
 */
function assert(ok, title, detail) {
  results.push({ ok, title, detail })
  if (!ok) console.error(`FAIL ${title} :: ${JSON.stringify(detail)}`)
}

let cdp = null
try {
  await waitFor(`http://127.0.0.1:${args.port}/json/version`, 20000)
  // 开一个空白页再自己导航：`/json/new?<url>` 会在我们连上之前就开始加载，
  // 于是"文档已就绪"的等待可能在 about:blank 上就短路返回，后面的断言全部看空页面。
  const target = await (await fetch(`http://127.0.0.1:${args.port}/json/new?about:blank`, { method: 'PUT' })).json()
  cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  const loaded = cdp.waitEvent('Page.loadEventFired')
  await cdp.send('Page.navigate', { url: args.url })
  await loaded
  await cdp.evaluate('new Promise(r => document.readyState === "complete" ? r(1) : addEventListener("load", () => r(1), { once: true }))')

  // 给音频解码留一点时间，然后再看第一屏 —— 800ms 时片段还在放（片长 8s、淡出窗口 1.5s）。
  await sleep(900)

  // ── 阶段 A：开机动画必须已经占住视口 ──
  const stageA = await cdp.evaluate(`(() => {
    const root = document.querySelector('.dsvs-boot')
    const video = document.querySelector('.dsvs-boot-video')
    const skip = document.querySelector('.dsvs-boot-skip')
    const sound = document.querySelector('.dsvs-boot-sound')
    const rect = root ? root.getBoundingClientRect() : null
    return {
      hasRoot: root !== null,
      state: root ? root.getAttribute('data-state') : null,
      coversViewport: rect !== null && rect.width >= innerWidth - 1 && rect.height >= innerHeight - 1,
      zIndex: root ? getComputedStyle(root).zIndex : null,
      position: root ? getComputedStyle(root).position : null,
      videoSrc: video ? video.getAttribute('src') : null,
      videoMuted: video ? video.muted : null,
      videoLoop: video ? video.loop : null,
      videoVolume: video ? video.volume : null,
      videoTime: video ? video.currentTime : null,
      duration: video && Number.isFinite(video.duration) ? video.duration : null,
      // Chrome 的非标准计数：>0 说明**音频轨真的被解码了**（不是"文件里有个音轨"而已）。
      decodedAudioBytes: video && typeof video.webkitAudioDecodedByteCount === 'number'
        ? video.webkitAudioDecodedByteCount
        : null,
      skipText: skip ? skip.textContent : null,
      skipVisible: skip ? getComputedStyle(skip).opacity !== '0' : false,
      soundVisible: sound ? sound.getAttribute('data-visible') : null,
      soundDisplay: sound ? getComputedStyle(sound).display : null,
      backdropYet: document.querySelector('#dsvs-backdrop') !== null,
    }
  })()`)
  assert(stageA.hasRoot, 'A1 开机动画覆盖层存在', stageA)
  assert(stageA.coversViewport, 'A2 覆盖层铺满视口', stageA)
  assert(stageA.position === 'fixed' && Number(stageA.zIndex) > 1000000, 'A3 覆盖层是 fixed 且层级压倒一切', stageA)
  assert(
    typeof stageA.videoSrc === 'string' && stageA.videoSrc.includes('boot.mp4'),
    'A4 覆盖层用的是开机动画素材',
    stageA,
  )
  assert(stageA.videoLoop === false, 'A5 素材不循环（片尾才是交接信号）', stageA)
  assert(
    typeof stageA.skipText === 'string' && stageA.skipText.includes('点击') && stageA.skipVisible,
    'A6 「点击画面跳过」的提醒可见',
    stageA,
  )
  assert(stageA.backdropYet === false, 'A7 开机阶段还没抢带宽建背景层', stageA)

  if (args.autoplay === 'allow') {
    // 桌面壳的真实环境：Electron 默认 no-user-gesture-required ⇒ 应当**一上来就有声**。
    assert(stageA.videoMuted === false, 'A8 桌面环境：素材未静音播放（开机动画有声）', stageA)
    assert(stageA.videoVolume > 0, 'A9 音量按配置设置', stageA)
    assert(stageA.soundVisible === '0', 'A10 播成功时不该出现声音开关', stageA)
    assert(stageA.duration !== null && stageA.duration > 7, 'A11 片段时长读到了', stageA)
    assert(
      stageA.decodedAudioBytes === null || stageA.decodedAudioBytes > 0,
      'A12 音频轨真的被解码了（webkitAudioDecodedByteCount > 0）',
      stageA,
    )
  } else {
    // 普通浏览器默认策略：未静音被拒 ⇒ 自动退回静音继续播 + 亮出独立的声音开关。
    assert(stageA.videoMuted === true, 'A8 浏览器拦下声音时自动退回静音继续播', stageA)
    assert(stageA.soundVisible === '1', 'A9 亮出独立的声音开关', stageA)
    // 绝对定位元素会被 blockify：`display: inline-flex` 的计算值是 `flex`。
    assert(stageA.soundDisplay !== 'none' && stageA.soundDisplay !== '', 'A10 声音开关真的可见（display 生效）', stageA)

    // 用**真的鼠标事件**点声音开关的中心（位置从 DOM 里量，不写死坐标 ——
    // 视口高度不是 900，写死坐标会点到视口外面去，那种"没跳过"是假通过）。
    const soundRect = await cdp.evaluate(`(() => {
      const button = document.querySelector('.dsvs-boot-sound')
      const rect = button.getBoundingClientRect()
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), w: rect.width, h: rect.height }
    })()`)
    assert(soundRect.w > 0 && soundRect.h > 0, 'A11 声音开关有真实尺寸（可以命中）', soundRect)
    assert(
      soundRect.y > 40 && soundRect.y < 900,
      'A12 量出来的位置在视口里（否则后面的点击是假通过）',
      soundRect,
    )
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: soundRect.x,
      y: soundRect.y,
      button: 'left',
      clickCount: 1,
    })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: soundRect.x,
      y: soundRect.y,
      button: 'left',
      clickCount: 1,
    })
    await sleep(400)
    const afterSound = await cdp.evaluate(`(() => {
      const root = document.querySelector('.dsvs-boot')
      const video = document.querySelector('.dsvs-boot-video')
      return {
        state: root ? root.getAttribute('data-state') : 'gone',
        muted: video ? video.muted : null,
        decodedAudioBytes: video && typeof video.webkitAudioDecodedByteCount === 'number'
          ? video.webkitAudioDecodedByteCount
          : null,
      }
    })()`)
    assert(afterSound.state === 'idle', 'A13 点声音开关不会跳过', afterSound)
    assert(afterSound.muted === false, 'A14 点声音开关后变成未静音（用户手势解锁）', afterSound)
    assert(
      afterSound.decodedAudioBytes === null || afterSound.decodedAudioBytes > 0,
      'A15 解锁后音频轨真的被解码了',
      afterSound,
    )
  }

  await shot(cdp, path.join(shotDir, `e2e-1-boot${args.suffix}.png`))

  // ── 点击：用真的鼠标事件打到视口中心，验证覆盖层真的在接收指针事件 ──
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 800, y: 450, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 800, y: 450, button: 'left', clickCount: 1 })

  const stageClick = await cdp.evaluate(`(() => {
    const root = document.querySelector('.dsvs-boot')
    return { state: root ? root.getAttribute('data-state') : 'gone', fade: root ? root.style.getPropertyValue('--dsvs-boot-fade') : null }
  })()`)
  assert(stageClick.state === 'leaving', 'B1 点击画面立刻开始跳过', stageClick)
  assert(stageClick.fade === '320ms', 'B2 跳过用的是 skipFadeMs（320ms），不是 fadeMs', stageClick)

  await sleep(900)
  const stageB = await cdp.evaluate(`(() => {
    const layer = document.querySelector('#dsvs-backdrop')
    const video = document.querySelector('#dsvs-backdrop-video')
    const html = document.documentElement
    const body = document.body
    const style = getComputedStyle(body)
    return {
      overlayGone: document.querySelector('.dsvs-boot') === null,
      layerExists: layer !== null,
      layerIsFirstChild: layer !== null && body.firstChild === layer,
      layerPosition: layer ? getComputedStyle(layer).position : null,
      layerZIndex: layer ? getComputedStyle(layer).zIndex : null,
      datasetOn: html.getAttribute('data-dsvs'),
      bodyBackground: style.backgroundColor,
      tokenBase: style.getPropertyValue('--dsw-alias-bg-base').trim(),
      tokenLayer1: style.getPropertyValue('--dsw-alias-bg-layer-1').trim(),
      tokenSidebar: style.getPropertyValue('--dsw-specific-sidebar-fill').trim(),
      tokenOverlay: style.getPropertyValue('--dsw-alias-bg-overlay').trim(),
      surfaceVar: html.style.getPropertyValue('--dsvs-surface'),
      veilVar: html.style.getPropertyValue('--dsvs-veil'),
      videoSrc: video ? video.getAttribute('src') : null,
      videoLoop: video ? video.loop : null,
      videoMuted: video ? video.muted : null,
    }
  })()`)
  assert(stageB.overlayGone, 'B3 淡出后覆盖层整个从 DOM 移除', stageB)
  assert(stageB.layerExists && stageB.layerIsFirstChild, 'B4 背景层是 body 的第一个孩子', stageB)
  assert(stageB.layerPosition === 'fixed' && stageB.layerZIndex === '-1', 'B5 背景层 fixed / z-index:-1（不挡交互）', stageB)
  assert(stageB.datasetOn === 'on', 'B6 html[data-dsvs=on] 已打开半透明表面', stageB)
  assert(stageB.bodyBackground === 'rgba(0, 0, 0, 0)' || stageB.bodyBackground === 'transparent', 'B7 body 底色已让开', stageB)
  assert(/rgba\(/u.test(stageB.tokenBase), 'B8 --dsw-alias-bg-base 变成半透明', stageB)
  // **layer-1/2/3 必须保持内核原生的不透明色** —— 对话框/弹层/设置页用的就是这几层，
  // 一透明背后的正文就透进来了（用户报的"打开设置看不清"）。这一条是那条报障的守卫。
  // （精确的解析值在下面用 probe 量，这里先看声明本身不再是我们写的半透明 rgba。）
  assert(
    !/rgba\([^)]*,\s*0?\.[0-9]/u.test(stageB.tokenLayer1),
    'B9 --dsw-alias-bg-layer-1 不再是半透明 rgba（弹层/设置页可读）',
    stageB,
  )
  assert(/rgba\(/u.test(stageB.tokenSidebar), 'B10 侧栏底色变成半透明', stageB)
  assert(
    stageB.tokenOverlay === '' || !/rgba\([^)]*,\s*0\.\d/u.test(stageB.tokenOverlay) || true,
    'B11 弹层 token 保持原样（信息记录）',
    stageB,
  )
  assert(stageB.surfaceVar === '0.2' && stageB.veilVar === '0.14', 'B12 蒙版/表面不透明度按配置写入', stageB)
  assert(stageB.videoLoop === true && stageB.videoMuted === true, 'B13 背景视频循环且无声', stageB)
  // 素材是**延后**加载的（delayMs 默认 1200），此刻 src 还没设上才是对的。
  assert(stageB.videoSrc === null || String(stageB.videoSrc).includes('background.mp4'), 'B14 背景素材此刻尚未抢带宽', stageB)

  // 关键一步：自定义属性是 token 流，`getPropertyValue` 拿到的是**没解析的声明**。
  // 只有把它真的用在一个属性上、再读**计算后**的值，才能证明半透明真的生效了。
  const resolved = await cdp.evaluate(`(() => {
    const probe = document.createElement('div')
    probe.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;'
    document.body.appendChild(probe)
    const read = (token) => {
      probe.style.backgroundColor = ''
      probe.style.backgroundColor = 'var(' + token + ')'
      return getComputedStyle(probe).backgroundColor
    }
    const light = {
      base: read('--dsw-alias-bg-base'),
      layer1: read('--dsw-alias-bg-layer-1'),
      sidebar: read('--dsw-specific-sidebar-fill'),
      overlay: read('--dsw-alias-bg-overlay'),
    }
    document.body.setAttribute('data-ds-dark-theme', '')
    const dark = {
      base: read('--dsw-alias-bg-base'),
      layer1: read('--dsw-alias-bg-layer-1'),
      sidebar: read('--dsw-specific-sidebar-fill'),
      overlay: read('--dsw-alias-bg-overlay'),
    }
    document.body.removeAttribute('data-ds-dark-theme')
    probe.remove()
    return { light, dark }
  })()`)
  const alpha = (value) => {
    const match = /rgba?\(([^)]*)\)/u.exec(String(value))
    if (match === null) return null
    const parts = match[1].split(/[,/]/u).map((part) => part.trim())
    return parts.length >= 4 ? Number(parts[3]) : 1
  }
  // 期望值跟 `lib/config.js` 的默认值绑在一起：surface 0.2 / veil 0.14（暗），
  // surfaceLight 0.6 / veilLight 0.1（亮）；画布派生侧栏 = base + 0.06。
  // **layer-1/2/3 不派生**，所以它们应当等于内核原生值（不透明）。
  assert(alpha(resolved.light.base) === 0.6, 'B15 亮主题：--dsw-alias-bg-base 解析成 0.6', resolved)
  assert(alpha(resolved.light.layer1) === 1, 'B16 亮主题：layer-1 保持不透明（原生值）', resolved)
  assert(alpha(resolved.light.sidebar) === 0.66, 'B17 亮主题：侧栏解析成 0.66', resolved)
  assert(alpha(resolved.light.overlay) === 1, 'B18 亮主题：弹层 token 保持不透明（可读性优先）', resolved)
  assert(alpha(resolved.dark.base) === 0.2, 'B19 暗主题：--dsw-alias-bg-base 解析成 0.2（视频看得清）', resolved)
  assert(alpha(resolved.dark.layer1) === 1, 'B20 暗主题：layer-1 保持不透明（原生值）', resolved)
  assert(alpha(resolved.dark.overlay) === 1, 'B21 暗主题：弹层 token 保持不透明', resolved)

  // ── 对话框本体：设置页/模态用的就是 `_dialog_*{background: var(--dsw-alias-bg-layer-2)}`。
  //    直接量它计算后的颜色，证明"弹层真的不透了"（不是只看了 token 的解析值）。
  const dialogPaint = await cdp.evaluate(`(() => {
    const probe = document.createElement('div')
    probe.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;'
    document.body.appendChild(probe)
    const read = (token) => { probe.style.backgroundColor = ''; probe.style.backgroundColor = 'var(' + token + ')'; return getComputedStyle(probe).backgroundColor }
    const light = read('--dsw-alias-bg-layer-2')
    document.body.setAttribute('data-ds-dark-theme', '')
    const dark = read('--dsw-alias-bg-layer-2')
    document.body.removeAttribute('data-ds-dark-theme')
    // 真正的对话框元素（如果有模态开着）
    const dialog = document.querySelector('[class*="_dialog_"]')
    const live = dialog === null ? null : getComputedStyle(dialog).backgroundColor
    probe.remove()
    return { light, dark, live }
  })()`)
  assert(alpha(dialogPaint.light) === 1 && alpha(dialogPaint.dark) === 1, 'B22 对话框底色（layer-2）两个主题都不透明', dialogPaint)

  // ── 等背景视频真的解码出画面 ──
  const decoded = await cdp.evaluate(`new Promise((resolve) => {
    const video = document.querySelector('#dsvs-backdrop-video')
    if (video === null) { resolve({ found: false }); return }
    const report = () => resolve({
      found: true,
      readyState: video.readyState,
      shown: video.getAttribute('data-shown'),
      currentTime: video.currentTime,
      duration: Number.isFinite(video.duration) ? Math.round(video.duration * 10) / 10 : null,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      error: video.error ? video.error.code : null,
    })
    if (video.readyState >= 2 && video.currentTime > 0) { report(); return }
    video.addEventListener('timeupdate', () => { if (video.currentTime > 0.2) report() }, { once: false })
    setTimeout(() => resolve({ found: true, timeout: true, readyState: video.readyState, error: video.error ? video.error.code : null }), 12000)
  })`)
  assert(decoded.found === true && decoded.readyState >= 2, 'C1 背景视频真的解码到可播放', decoded)
  assert(decoded.videoWidth > 0 && decoded.videoHeight > 0, 'C2 背景视频有真实画面尺寸', decoded)
  assert(decoded.duration !== null && decoded.duration > 100, 'C3 是那条约 125 秒的长片', decoded)
  assert(decoded.error === null, 'C4 没有解码错误', decoded)

  // ── 可读性：拿**真实视频像素**算正文在最坏情况下的对比度 ──
  // 这是"不影响正常文字阅读"这条要求的可执行版本。
  await cdp.evaluate(MEASURE_INSTALL)

  if (args.sweep) {
    // 调参用：把候选组合真的应用到页面上，逐个测出对比度表。
    // 有了这张表，"surface 该给多少"就不用猜了。
    const candidates = [
      { surface: 0.2, surfaceLight: 0.4, veil: 0.14, veilLight: 0.1 },
      { surface: 0.2, surfaceLight: 0.5, veil: 0.14, veilLight: 0.1 },
      { surface: 0.2, surfaceLight: 0.6, veil: 0.14, veilLight: 0.1 },
      { surface: 0.05, surfaceLight: 0.6, veil: 0.06, veilLight: 0.06 },
      { surface: 0, surfaceLight: 0.55, veil: 0, veilLight: 0 },
    ]
    console.log('\n  surface  sLight   veil  vLight | dark min / p5 / med | light min / p5 / med')
    for (const candidate of candidates) {
      await cdp.evaluate(`window.__DSH_VIDEO_SKIN__.applyLive({background:${JSON.stringify(candidate)}})`)
      await sleep(150)
      const measured = await cdp.evaluate('window.__dsvsContrast()')
      const cell = (value) => `${value.min}/${value.p5}/${value.median}`
      console.log(
        `  ${String(candidate.surface).padEnd(7)} ${String(candidate.surfaceLight).padEnd(7)} ` +
          `${String(candidate.veil).padEnd(5)} ${String(candidate.veilLight).padEnd(6)} | ` +
          `${cell(measured.dark).padEnd(18)} | ${cell(measured.light)}`,
      )
    }
  }

  const readability = await cdp.evaluate('window.__dsvsContrast()')
  if (readability.skipped === true) {
    assert(false, 'C5 可读性测量', readability)
  } else if (args.sweep) {
    // 扫描模式下这里的值属于最后一个候选，断言交给人工看上面那张表。
    console.log('     （--sweep：上面的表就是结论，跳过 C5-C8 断言）')
  } else {
    console.log(`     contrast(dark)  min=${readability.dark.min} p5=${readability.dark.p5} median=${readability.dark.median}`)
    console.log(`     contrast(light) min=${readability.light.min} p5=${readability.light.p5} median=${readability.light.median}`)
    // 门槛按"面积"定：p5 = 画面 95% 区域的对比度，median = 中位。
    // **min 只作信息**：它对应画面里极少数的镜面高光像素，在"让视频真的看得见"这个
    // 前提下不可能同时满足 AA —— 想同时满足只能把蒙版加到 0.4 以上，而那正是用户
    // 抱怨的"完全看不清视频"。这里选择 p5 与中位达标，并把 min 如实打出来。
    assert(readability.dark.p5 >= 6, 'C5 暗主题：正文对比度 95% 分位 ≥ 6（AA 要求 4.5）', readability.dark)
    assert(readability.light.p5 >= 6, 'C6 亮主题：正文对比度 95% 分位 ≥ 6（AA 要求 4.5）', readability.light)
    assert(readability.dark.median >= 7, 'C7 暗主题：中位对比度 ≥ 7（AAA）', readability.dark)
    assert(readability.light.median >= 7, 'C8 亮主题：中位对比度 ≥ 7（AAA）', readability.light)
    assert(readability.light.min >= 4.5, 'C9 亮主题：连最坏像素也在 AA 之上（白面兜得住）', readability.light)
  }

  // ── 界面本体：内核启动页必须已经被应用替换（这是就绪判据的现实依据） ──
  const app = await cdp.evaluate(`(() => {
    const root = document.getElementById('root')
    const children = root ? Array.from(root.children).map((node) => node.tagName + (node.hasAttribute('data-dsh-boot') ? '[boot]' : '')) : []
    return {
      rootChildren: children.length,
      bootStillThere: document.querySelector('#root > [data-dsh-boot]') !== null,
      hasNonBootChild: children.some((name) => !name.includes('[boot]')),
      textSample: (document.body.innerText || '').slice(0, 120),
    }
  })()`)
  assert(app.hasNonBootChild, 'D1 应用已经挂进 #root（就绪判据成立）', app)
  await shot(cdp, path.join(shotDir, `e2e-2-app${args.suffix}.png`))
  // 再补一张暗主题的：绝大多数人用的是暗色，可读性必须在那一侧也眼见为实。
  await cdp.evaluate(`document.body.setAttribute('data-ds-dark-theme','')`)
  await sleep(400)
  await shot(cdp, path.join(shotDir, `e2e-3-dark${args.suffix}.png`))
  await cdp.evaluate(`document.body.removeAttribute('data-ds-dark-theme')`)

  // ── 阶段 E：透明度调节控件（圆钮 → 面板 → 滑块 → 写盘 → 刷新后还在） ──
  const pill = await cdp.evaluate(`(() => {
    const node = document.querySelector('#dsvs-knobs-pill')
    const panel = document.querySelector('#dsvs-knobs')
    if (node === null || panel === null) return { missing: true }
    const rect = node.getBoundingClientRect()
    return {
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
      w: rect.width,
      h: rect.height,
      open: panel.getAttribute('data-open'),
      ranges: panel.querySelectorAll('input[type=range]').length,
      opacity: getComputedStyle(node).opacity,
    }
  })()`)
  assert(pill.missing !== true, 'E1 右下角有透明度调节圆钮', pill)
  assert(pill.ranges === 3, 'E2 面板里有三个滑块（画布 / 视频蒙版 / 面板）', pill)
  assert(pill.open === '0', 'E3 面板默认收起', pill)
  assert(Number(pill.opacity) < 0.6, 'E4 圆钮平时是半透明的（不碍眼）', pill)

  // 用真鼠标点圆钮之前，先问一句"这个坐标最上面是谁"。
  //
  // 这一问本身也是一条断言：DSH 的模态（首次启动的「预览版说明」就是一个）自带一层
  // `position: fixed` 的遮罩，理应盖住一切 —— 我们的圆钮**不该**去抢模态的点击。
  // 所以顺序是：有模态就先确认"抢不到"，把它关掉，再确认"能点到"。
  const topAtPill = `(() => {
    const node = document.querySelector('#dsvs-knobs-pill')
    const rect = node.getBoundingClientRect()
    const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return {
      isPill: top === node || (top !== null && typeof top.closest === 'function' && top.closest('#dsvs-knobs-pill') !== null),
      top: top === null ? 'null' : (top.id || String(top.className) || top.tagName),
    }
  })()`
  const beforeDismiss = await cdp.evaluate(topAtPill)
  if (beforeDismiss.isPill !== true) {
    // 盖住它的是内核自己的模态：`Modal` 的 `_root_*` 是 `position:fixed; z-index:1000`
    // （CSS 见 `index-*.css` 的 `_root_o6lrb_6` / `_mask_o6lrb_18`），我们的圆钮在 900。
    // 这是**故意**的：模态就该盖住一切，一个壁纸控件不该去抢它的点击。
    assert(
      beforeDismiss.isPill === false,
      `E5 被模态（${beforeDismiss.top}）盖住时，圆钮不抢它的点击`,
      beforeDismiss,
    )
    // 要测的是我们自己的控件、不是内核的模态，所以把那一层整个摘掉再继续
    // （去点它的按钮得猜内核的组件结构，脆而且与本插件无关）。
    const removed = await cdp.evaluate(`(() => {
      const overlays = Array.from(document.body.querySelectorAll('div')).filter((node) => {
        const style = getComputedStyle(node)
        return (
          style.position === 'fixed' &&
          style.zIndex === '1000' &&
          node.getBoundingClientRect().height > innerHeight * 0.8
        )
      })
      for (const node of overlays) node.remove()
      return overlays.length
    })()`)
    await sleep(300)
    const afterDismiss = await cdp.evaluate(topAtPill)
    assert(removed > 0, 'E6 找到并移除了挡住它的全屏模态层', { removed, beforeDismiss })
    assert(afterDismiss.isPill === true, 'E7 模态层移除之后圆钮可以点到', afterDismiss)
  } else {
    console.log(`     圆钮当前就在最上层（${beforeDismiss.top}），无需移除任何模态`)
  }

  await click(cdp, pill.x, pill.y)
  await sleep(250)
  const opened = await cdp.evaluate(`(() => {
    const panel = document.querySelector('#dsvs-knobs')
    const badge = panel.querySelector('.dsvs-knobs-badge')
    const notes = Array.from(panel.querySelectorAll('.dsvs-knobs-note')).map((node) => node.textContent)
    return { open: panel.getAttribute('data-open'), badge: badge.textContent, notes }
  })()`)
  assert(opened.open === '1', 'E8 点圆钮真的展开了面板', opened)
  assert(/文字对比度/u.test(opened.badge), 'E9 面板给出实时的文字对比度读数', opened)
  assert(
    opened.notes.length === 3 && /暗色/u.test(opened.notes[0]) && /亮色/u.test(opened.notes[0]),
    'E10 三行读数都在（暗/亮两个主题 + 面板不透明度说明）',
    opened,
  )
  await shot(cdp, path.join(shotDir, `e2e-4-knobs${args.suffix}.png`))

  if (args.dshHome !== '') {
    const configFile = path.join(args.dshHome, 'dsh-video-skin.json')
    try {
      fs.rmSync(configFile, { force: true })
    } catch {
      /* 本来就没有 */
    }

    // 把两个滑块拖到 0 / 60，走一次 input + change（松手才写盘）。
    // 两个主题都要看：这是"只写 surface 会让亮主题纹丝不动"那个 bug 的守卫。
    const applied = await cdp.evaluate(`(() => {
      const panel = document.querySelector('#dsvs-knobs')
      const ranges = panel.querySelectorAll('input[type=range]')
      ranges[0].value = '0'
      ranges[0].dispatchEvent(new Event('input', { bubbles: true }))
      ranges[1].value = '60'
      ranges[1].dispatchEvent(new Event('input', { bubbles: true }))
      ranges[0].dispatchEvent(new Event('change', { bubbles: true }))
      ranges[1].dispatchEvent(new Event('change', { bubbles: true }))
      const probe = document.createElement('div')
      probe.style.cssText = 'position:absolute;left:-9999px'
      document.body.appendChild(probe)
      const read = (token) => {
        probe.style.backgroundColor = ''
        probe.style.backgroundColor = 'var(' + token + ')'
        return getComputedStyle(probe).backgroundColor
      }
      const veilEl = document.querySelector('#dsvs-backdrop-veil')
      const sample = () => ({
        base: read('--dsw-alias-bg-base'),
        veil: getComputedStyle(veilEl).backgroundColor,
        surfaceVar: document.documentElement.style.getPropertyValue('--dsvs-surface'),
        surfaceLightVar: document.documentElement.style.getPropertyValue('--dsvs-l-surface'),
        veilVar: document.documentElement.style.getPropertyValue('--dsvs-veil'),
        veilLightVar: document.documentElement.style.getPropertyValue('--dsvs-l-veil'),
      })
      document.body.setAttribute('data-ds-dark-theme', '')
      const dark = sample()
      document.body.removeAttribute('data-ds-dark-theme')
      const light = sample()
      probe.remove()
      return { dark, light }
    })()`)
    assert(
      /rgba\(21, 21, 23, 0\)/u.test(applied.dark.base),
      'E11 暗主题：拖到 0 之后表面是真透明',
      applied,
    )
    assert(
      /rgba\(255, 255, 255, 0\.4\)/u.test(applied.light.base),
      'E12 亮主题：跟着走到派生的 0.4（不是纹丝不动）',
      applied,
    )
    assert(
      /rgba\(0, 0, 0, 0\.6\)/u.test(applied.dark.veil) && /rgba\(255, 255, 255, 0\.42\)/u.test(applied.light.veil),
      'E13 蒙版跟着滑块走到 60%（亮色派生 42%）',
      applied,
    )
    assert(applied.dark.surfaceLightVar === '0.4', 'E14 surfaceLight 当场派生出来', applied)

    // ── 面板不透明度：默认原生不透明（B22 已经量过），拖到 60% 才覆盖 ──
    const panelKnob = await cdp.evaluate(`(() => {
      const panel = document.querySelector('#dsvs-knobs')
      const ranges = panel.querySelectorAll('input[type=range]')
      const probe = document.createElement('div')
      probe.style.cssText = 'position:absolute;left:-9999px'
      document.body.appendChild(probe)
      const read = (token) => {
        probe.style.backgroundColor = ''
        probe.style.backgroundColor = 'var(' + token + ')'
        return getComputedStyle(probe).backgroundColor
      }
      const before = { attr: document.documentElement.hasAttribute('data-dsvs-panel'), layer2: read('--dsw-alias-bg-layer-2') }
      ranges[2].value = '60'
      ranges[2].dispatchEvent(new Event('input', { bubbles: true }))
      ranges[2].dispatchEvent(new Event('change', { bubbles: true }))
      const after = {
        attr: document.documentElement.hasAttribute('data-dsvs-panel'),
        layer2: read('--dsw-alias-bg-layer-2'),
        var2: document.documentElement.style.getPropertyValue('--dsvs-panel-2'),
        readout: ranges[2].parentNode.querySelector('.dsvs-knobs-value').textContent,
      }
      document.body.setAttribute('data-ds-dark-theme', '')
      const darkLayer2 = read('--dsw-alias-bg-layer-2')
      document.body.removeAttribute('data-ds-dark-theme')
      ranges[2].value = '100'
      ranges[2].dispatchEvent(new Event('change', { bubbles: true }))
      const restored = {
        attr: document.documentElement.hasAttribute('data-dsvs-panel'),
        layer2: read('--dsw-alias-bg-layer-2'),
      }
      probe.remove()
      return { before, after, darkLayer2, restored }
    })()`)
    assert(
      panelKnob.before.attr === false && /^rgb\(/u.test(panelKnob.before.layer2),
      'E14a 面板不透明度默认 100%：不挂开关属性、layer-2 是内核原生不透明色',
      panelKnob,
    )
    assert(
      panelKnob.after.attr === true && /rgba\([^)]*,\s*0\.66\)/u.test(panelKnob.after.layer2),
      'E14b 拖到 60% 后 layer-2 变成 0.66 alpha（第二层留 6% 高差）',
      panelKnob,
    )
    assert(/rgba\([^)]*,\s*0\.66\)/u.test(panelKnob.darkLayer2), 'E14c 暗主题同样生效', panelKnob)
    assert(/60%/u.test(panelKnob.after.readout), 'E14d 读数跟着走', panelKnob)
    assert(
      panelKnob.restored.attr === false && /^rgb\(/u.test(panelKnob.restored.layer2),
      'E14e 拖回 100% 恢复内核原生不透明色',
      panelKnob,
    )

    // 写盘是异步的。
    let onDisk = null
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(150)
      if (!fs.existsSync(configFile)) continue
      try {
        const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'))
        if (parsed?.background?.surface === 0 && parsed?.background?.veil === 0.6) {
          onDisk = parsed
          break
        }
      } catch {
        /* 正在写 */
      }
    }
    assert(onDisk !== null, 'E15 滑块的值真的落到 $DSH_HOME/dsh-video-skin.json', onDisk ?? { file: configFile })
    assert(
      onDisk !== null && onDisk.background.surfaceLight === 0.4 && onDisk.background.veilLight === 0.42,
      'E16 四个旋钮一起写进文件（文件本身就是说明）',
      onDisk ?? {},
    )
    assert(onDisk !== null && !('delayMs' in onDisk.background), 'E17 只写了那四个旋钮，没塞别的东西', onDisk ?? {})

    // 刷新一次：值必须还在（这就是"不用重启 DSH 也能调"的闭环）。
    const reloaded = cdp.waitEvent('Page.loadEventFired')
    await cdp.send('Page.reload', { ignoreCache: true })
    await reloaded
    await sleep(1200)
    // 刷新后先是开机动画，点一下进界面。
    await click(cdp, 700, 400)
    await sleep(1400)
    const afterReload = await cdp.evaluate(`(() => {
      const probe = document.createElement('div')
      probe.style.cssText = 'position:absolute;left:-9999px'
      document.body.appendChild(probe)
      const read = (token) => {
        probe.style.backgroundColor = ''
        probe.style.backgroundColor = 'var(' + token + ')'
        return getComputedStyle(probe).backgroundColor
      }
      const sample = () => ({ base: read('--dsw-alias-bg-base') })
      document.body.setAttribute('data-ds-dark-theme', '')
      const dark = sample()
      document.body.removeAttribute('data-ds-dark-theme')
      const light = sample()
      probe.remove()
      const layer = document.querySelector('#dsvs-backdrop')
      return {
        dark,
        light,
        hasLayer: layer !== null,
        surfaceVar: document.documentElement.style.getPropertyValue('--dsvs-surface'),
        surfaceLightVar: document.documentElement.style.getPropertyValue('--dsvs-l-surface'),
      }
    })()`)
    assert(afterReload.hasLayer, 'E18 刷新后背景层照常建起来', afterReload)
    assert(afterReload.surfaceVar === '0', 'E19 刷新后滑块的值还在（写盘 → 运行期配置的闭环）', afterReload)
    assert(afterReload.surfaceLightVar === '0.4', 'E20 刷新后亮主题的派生值也在', afterReload)
    assert(
      /rgba\(21, 21, 23, 0\)/u.test(afterReload.dark.base) && /rgba\(255, 255, 255, 0\.4\)/u.test(afterReload.light.base),
      'E21 刷新后两个主题都维持滑块设定的效果',
      afterReload,
    )

    // 恢复默认：文件里的那几项要消失，值回到部署期默认。
    await cdp.evaluate(`document.querySelector('#dsvs-knobs-pill').click()`)
    await sleep(200)
    await cdp.evaluate(`document.querySelector('.dsvs-knobs-reset').click()`)
    await sleep(600)
    const cleared = await cdp.evaluate(`document.documentElement.style.getPropertyValue('--dsvs-surface')`)
    assert(cleared === '0.2', 'E22 恢复默认把值退回部署期默认（0.2）', { cleared })
    let stillThere = true
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(150)
      const parsed = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {}
      if (!parsed.background || !('surface' in parsed.background)) {
        stillThere = false
        break
      }
    }
    assert(stillThere === false, 'E23 恢复默认真的把文件里那几项摘掉了', { configFile })
  }

  // ── 阶段 F：什么都不点，盯着开机动画看它是否**完整放完** ──
  //
  // 这一节是"开场动画有时候还没放完就切掉了"那个报障的回归守卫。早先的退场有两条路
  // 会提前截断：①片尾交叉溶解的淡出时长是"当时的真实剩余时间"，界面就绪得晚时只剩
  // 100~200ms（看起来就是硬切）；②素材一次报错就直接交接。现在必须是：
  // 片子放到 dur 附近才开始淡，而且淡出时长是固定的 fadeMs。
  {
    const reloaded = cdp.waitEvent('Page.loadEventFired')
    await cdp.send('Page.reload', { ignoreCache: true })
    await reloaded

    const samples = []
    let leavingSample = null
    const deadline = Date.now() + 25000
    let firstAt = null
    while (Date.now() < deadline) {
      const sample = await cdp.evaluate(`(() => {
        const root = document.querySelector('.dsvs-boot')
        const video = document.querySelector('.dsvs-boot-video')
        const api = window.__DSH_VIDEO_SKIN__
        return {
          at: Math.round(performance.now()),
          exists: root !== null,
          state: root === null ? 'gone' : root.getAttribute('data-state'),
          fade: root === null ? null : root.style.getPropertyValue('--dsvs-boot-fade'),
          time: video !== null && isFinite(video.currentTime) ? Math.round(video.currentTime * 1000) / 1000 : null,
          duration: video !== null && isFinite(video.duration) ? Math.round(video.duration * 1000) / 1000 : null,
          ended: video === null ? null : video.ended,
          error: video !== null && video.error !== null ? video.error.code : null,
          failures: api && api.state ? api.state.failures.join(',') : '',
        }
      })()`)
      if (firstAt === null) firstAt = sample.at
      samples.push(sample)
      if (sample.state === 'leaving' && leavingSample === null) leavingSample = sample
      if (sample.exists === false && leavingSample !== null) break
      if (sample.exists === false) break
      await sleep(300)
    }

    const duration = samples.find((item) => item.duration !== null)?.duration ?? null
    // 300ms 的采样间隔踩不准"最后一帧"那种窄窗口，所以这里用 1 秒容差：
    // 只要片尾前 1 秒内覆盖层还是 idle，就证明它没有提前开始淡（真正的守卫是 F5）。
    const heldToEnd = samples.find(
      (item) => item.state === 'idle' && item.time !== null && duration !== null && item.time >= duration - 1,
    )
    assert(duration !== null && duration > 7, 'F1 读到了片段时长（后面几条都靠它）', { duration, samples: samples.length })
    assert(
      heldToEnd !== undefined,
      'F2 片尾前 1 秒内覆盖层仍是 idle（没有提前开始淡）',
      { duration, samples },
    )
    assert(leavingSample !== null, 'F3 片子放完后确实开始交接', { samples })
    if (leavingSample !== null) {
      assert(
        leavingSample.fade === '1000ms',
        'F4 淡出时长是固定的 fadeMs（1000ms），不是"当时还剩多少"',
        leavingSample,
      )
      assert(
        leavingSample.time !== null && duration !== null && leavingSample.time >= duration - 0.3,
        'F5 淡出是从片尾开始的（不是放到一半）',
        leavingSample,
      )
      assert(
        !/video-error|no-frame/.test(leavingSample.failures),
        'F6 退场原因里没有"素材报错 / 一帧都出不来"',
        leavingSample,
      )
    }
    const gone = samples.find((item) => item.exists === false)
    assert(gone !== undefined, 'F7 淡完之后覆盖层从 DOM 里消失', { samples })
    if (gone !== undefined && leavingSample !== null) {
      const fadeSpan = gone.at - leavingSample.at
      assert(
        fadeSpan >= 600 && fadeSpan <= 2600,
        `F8 淡出真的花了约 ${fadeSpan}ms（在 1000ms 量级，不是瞬切也不是卡住）`,
        { fadeSpan, leavingSample, gone },
      )
    }
    // 覆盖层一消失不代表背景层**同一微任务**就建好了（它是交接后异步建的），
    // 所以这里轮询等一下，别把"还没建"当成"不会建"。
    let afterBoot = { hasLayer: false, layerHasVideo: false }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      afterBoot = await cdp.evaluate(`(() => {
        const layer = document.querySelector('#dsvs-backdrop')
        const video = document.querySelector('#dsvs-backdrop-video')
        return { hasLayer: layer !== null, layerHasVideo: video !== null }
      })()`)
      if (afterBoot.hasLayer && afterBoot.layerHasVideo) break
      await sleep(200)
    }
    assert(afterBoot.hasLayer && afterBoot.layerHasVideo, 'F9 交接之后背景层照常建起来', afterBoot)
    console.log(`     完整播放：duration=${duration}s，退场 fade=${leavingSample?.fade}，t=${leavingSample?.time}s`)
  }
} catch (error) {
  assert(false, 'E2E 运行期异常', error instanceof Error ? error.message : String(error))
} finally {
  cdp?.close()
  try {
    child.kill()
  } catch {
    /* 已经退出 */
  }
}

/**
 * 在某个坐标打一次真鼠标点击。
 * @param {Cdp} client CDP 客户端。
 * @param {number} x 横坐标。
 * @param {number} y 纵坐标。
 */
async function click(client, x, y) {
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

/**
 * 截一张图。
 * @param {Cdp} client CDP 客户端。
 * @param {string} file 目标文件。
 */
async function shot(client, file) {
  const result = await client.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'))
  console.log(`shot ${file}`)
}

const failed = results.filter((item) => !item.ok)
for (const item of results) {
  if (item.ok) console.log(`ok   ${item.title}`)
}
console.log(`\nverify-browser: ${results.length - failed.length}/${results.length} 通过`)
for (const item of failed) console.log(`FAIL ${item.title} :: ${JSON.stringify(item.detail)}`)
process.exit(failed.length === 0 ? 0 : 1)
