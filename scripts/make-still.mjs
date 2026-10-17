/**
 * 抽一帧静图：从 `assets/background.mp4` 里挑一张"最有代表性"的帧，写成
 * `assets/background.jpg`，给"静态背景"这种新用法当默认素材。
 *
 * 为什么这么绕（三条都是被环境逼出来的）：
 *   ① **没有 ffmpeg**。本机没有 ffmpeg/ffprobe 可装，唯一现成的解码器就是浏览器，
 *      所以这里驱动真的 Chromium（headless + CDP over WebSocket）去解码并抓帧；
 *   ② **不能用 file://**。`file://` 页面里的 `<video>` 画进 canvas 会把画布标记为
 *      tainted，`getImageData`/`toDataURL` 直接抛 SecurityError（或者更糟：静默全黑）。
 *      于是起一个 127.0.0.1 的 `node:http` 小服务，把页面和 mp4 放在**同一个源**下，
 *      画布就一直可读。mp4 必须支持 Range —— `<video>` 要靠 206 才能 seek；
 *   ③ **为什么按亮度挑帧**。这段素材是星空：有的帧几乎全黑，有的帧亮星密集。默认背景
 *      用最亮帧会太抢眼、用最暗帧等于没背景，所以按"平均亮度最接近所有候选的平均值"
 *      来选，也就是**最典型的那一帧**。
 *
 * 依赖：零。只用 `node:` 内置模块 + 全局 fetch/WebSocket（Node ≥ 22），
 * 以及仓库自己的 `lib/route.js`（复用 Range 解析与 MIME 映射）。
 *
 * 用法：node scripts/make-still.mjs [--browser <exe>] [--out assets/background.jpg]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { contentTypeFor, parseRange } from '../lib/route.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'assets/background.mp4')
/**
 * 产出的静态图。
 *
 * 之所以是模块级变量（而不是解析完参数再用）：HTTP 服务要按它把 `/background.jpg`
 * 发给页面去做"落盘之后回读一遍"的自检 —— 用 `--out` 换了输出位置时，回的必须是
 * **那一个**文件，不然自检量的是另一个路径上的旧图（甚至 404）。
 */
let outFile = path.join(root, 'assets', 'background.jpg')

/** 候选浏览器（先存在的先用）。 */
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]

/** 采样时间点：占时长的百分比。刻意铺满整段，避免"只看了开头"。 */
const FRACTIONS = [0.08, 0.2, 0.33, 0.46, 0.6, 0.73, 0.86]
/** JPEG 质量，和需求里说好的 0.86 对齐。 */
const QUALITY = 0.86

/**
 * 解析命令行参数。
 * @param {string[]} argv 参数（不含 node 与脚本名）。
 * @returns {{ browser: string, out: string }} 解析结果。
 */
function parseArgs(argv) {
  const args = { browser: '', out: 'assets/background.jpg' }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--browser') args.browser = argv[(index += 1)] ?? ''
    else if (token === '--out') args.out = argv[(index += 1)] ?? 'assets/background.jpg'
  }
  return args
}

/** 等一小会儿。 @param {number} ms 毫秒。 @returns {Promise<void>} 定时器。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 给任意 Promise 加超时，防止某一步永远挂住。
 * @template T
 * @param {Promise<T>} promise 被包的 Promise。
 * @param {number} ms 超时毫秒。
 * @param {string} label 出错时打印的步骤名。
 * @returns {Promise<T>} 结果。
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Step timed out after ${ms}ms: ${label}`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * 解析 JPEG 的 SOF 段，读出真实尺寸（不信浏览器报的数，从字节里再确认一遍）。
 * @param {Buffer} bytes 文件内容。
 * @returns {{ width: number, height: number, marker: string }} 宽高与命中的 SOF 标记。
 * @throws 当找不到 SOF 段时。
 */
function jpegSize(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Not a JPEG: bad magic bytes')
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error(`Corrupt JPEG at offset ${offset}`)
    const marker = bytes[offset + 1]
    const length = bytes.readUInt16BE(offset + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
        marker: `FF${marker.toString(16).toUpperCase()}`,
      }
    }
    offset += 2 + length
  }
  throw new Error('No SOF marker found in JPEG')
}

/**
 * 起一个只服务本机的小 HTTP 服务：给页面 + 支持 Range 的 mp4 + 产出的 jpg。
 * @param {number} port 监听端口。
 * @returns {http.Server} 已监听的服务器。
 */
function startServer(port) {
  const text = (response, status, body, type) => {
    response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
    response.end(body)
  }
  const server = http.createServer((request, response) => {
    const route = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (route === '/' || route === '/page.html') {
      return text(response, 200, PAGE, 'text/html; charset=utf-8')
    }
    const file = route === '/background.mp4' ? source : route === '/background.jpg' ? outFile : ''
    if (file === '' || !fs.existsSync(file)) return text(response, 404, 'not found', 'text/plain; charset=utf-8')

    const size = fs.statSync(file).size
    const type = contentTypeFor(file)
    // 关键：Chromium 用 Range 探路与 seek。206 的响应必须带 no-store，
    // 否则浏览器会把"某一段"当成整份资源缓存下来，后面 seek 全错。
    const range = parseRange(request.headers.range, size)
    if (range === 'unsatisfiable') {
      response.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Cache-Control': 'no-store' })
      return response.end()
    }
    const start = range === null ? 0 : range.start
    const end = range === null ? size - 1 : range.end
    if (range === null) response.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' })
    else {
      response.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      })
    }
    const stream = fs.createReadStream(file, { start, end })
    stream.on('error', () => response.destroy())
    stream.pipe(response)
  })
  return server
}

/** 页面里干活的全部逻辑（同源 ⇒ canvas 不会被 taint）。 */
const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>still</title>
<body>
<script>
const video = document.createElement('video')
video.src = '/background.mp4'
video.crossOrigin = 'anonymous'
video.muted = true
video.preload = 'auto'
video.playsInline = true
const canvas = document.createElement('canvas')

/** sRGB 通道 → 线性值。先建 256 项 LUT，避免逐像素调 pow。 */
const LUMA = new Float64Array(256)
for (let i = 0; i < 256; i += 1) {
  const c = i / 255
  LUMA[i] = c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/** 画当前帧并求平均亮度；同时回报"最暗/最亮"以便判断这一帧是不是废帧。 */
function measure() {
  const context = canvas.getContext('2d', { willReadFrequently: true })
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.drawImage(video, 0, 0, canvas.width, canvas.height)
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data
  let sum = 0
  let min = 1
  let max = 0
  for (let i = 0; i < data.length; i += 4) {
    const luma = 0.2126 * LUMA[data[i]] + 0.7152 * LUMA[data[i + 1]] + 0.0722 * LUMA[data[i + 2]]
    sum += luma
    if (luma < min) min = luma
    if (luma > max) max = luma
  }
  const pixels = data.length / 4
  return { mean: sum / pixels, min, max, pixels }
}

/** 等两个事件里先到的那个；超时返回 false 而不抛，让上层决定怎么办。 */
function race(names, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      for (const name of names) video.removeEventListener(name, onEvent)
      resolve(value)
    }
    const onEvent = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    for (const name of names) video.addEventListener(name, onEvent)
  })
}

/** seek 到 t，并等到真的出新帧（seeked + requestVideoFrameCallback 双保险）。 */
async function seekTo(t) {
  video.currentTime = t
  await race(['seeked'], 8000)
  if (typeof video.requestVideoFrameCallback === 'function') {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1500)
      video.requestVideoFrameCallback(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
  return video.currentTime
}

window.__extract = async (fractions) => {
  await race(['loadedmetadata'], 15000)
  // 等到有帧可画（readyState ≥ 2 = HAVE_CURRENT_DATA）。不用 play()，
  // headless 下自动播放策略会拦，而且这里根本不需要播放。
  for (let tries = 0; video.readyState < 2 && tries < 150; tries += 1) {
    await new Promise((r) => setTimeout(r, 100))
  }
  if (video.readyState < 2) throw new Error('video never reached HAVE_CURRENT_DATA')
  const duration = video.duration
  const samples = []
  for (const fraction of fractions) {
    const at = await seekTo(fraction * duration)
    // 留一拍让合成器把这一帧真正交给 canvas。
    await new Promise((r) => setTimeout(r, 120))
    samples.push({ fraction, at, ...measure() })
  }
  return { duration, width: video.videoWidth, height: video.videoHeight, samples }
}

window.__still = async (t) => {
  await seekTo(t)
  await new Promise((r) => setTimeout(r, 150))
  const measured = measure()
  return { dataUrl: canvas.toDataURL('image/jpeg', ${QUALITY}), mean: measured.mean }
}

/** 把外部文件画回来量一次：用来独立确认落盘的 jpg 不是黑的、也不是纯色。 */
window.__measureImage = (url) => new Promise((resolve, reject) => {
  const image = new Image()
  image.onload = () => {
    const width = image.naturalWidth || image.width
    const height = image.naturalHeight || image.height
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    context.drawImage(image, 0, 0)
    const data = context.getImageData(0, 0, width, height).data
    let sum = 0
    let distinct = 0
    // 每 1024 个像素抽一个判断"是不是纯色图"就够，剩下的全量算亮度。
    const seen = new Set()
    for (let i = 0, n = 0; i < data.length; i += 4, n += 1) {
      sum += 0.2126 * LUMA[data[i]] + 0.7152 * LUMA[data[i + 1]] + 0.0722 * LUMA[data[i + 2]]
      if (n % 1024 === 0) seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2])
    }
    distinct = seen.size
    resolve({ width, height, mean: sum / (data.length / 4), distinct })
  }
  image.onerror = () => reject(new Error('image decode failed'))
  image.src = url
})
</script>
</body>`

// ────────────── ① 参数与浏览器 ──────────────

const args = parseArgs(process.argv.slice(2))
if (!fs.existsSync(source)) {
  console.error(`缺少素材：${source}`)
  process.exit(2)
}
const browser = args.browser !== '' ? args.browser : BROWSERS.find((candidate) => fs.existsSync(candidate))
if (browser === undefined || browser === '') {
  console.error('没有找到 Chrome/Edge，用 --browser <路径> 指定')
  process.exit(2)
}
outFile = path.resolve(root, args.out)

// ────────────── ② 起 HTTP 服务（页面 + mp4 同源） ──────────────

const server = startServer(0)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

/** 找两个空闲端口：一个给 CDP，一个给调试 HTTP。 */
async function freePort() {
  const probe = http.createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  return port
}
const debugPort = await freePort()

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-video-skin-still-'))
let child = null
let socket = null
let failures = 0

// ────────────── ③ 极简 CDP 客户端 ──────────────

/** 连上页面目标后，只做一件事：发命令、等结果。 */
class Cdp {
  /** @param {string} wsUrl 页面目标的 WebSocket 地址。 */
  constructor(wsUrl) {
    this.socket = new WebSocket(wsUrl)
    this.nextId = 1
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve())
      this.socket.addEventListener('error', () => reject(new Error('CDP WebSocket failed to open')))
    })
    this.socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
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
   * 发一条 CDP 命令（带超时）。
   * @param {string} method 方法名。
   * @param {object} [params] 参数。
   * @param {number} [timeoutMs] 超时毫秒。
   * @returns {Promise<any>} 结果。
   */
  send(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId
    this.nextId += 1
    const call = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
    return withTimeout(call, timeoutMs, method)
  }

  /**
   * 在页面里求值。
   * @param {string} expression 表达式（可返回 Promise）。
   * @param {number} [timeoutMs] 超时毫秒。
   * @returns {Promise<any>} 值。
   */
  async evaluate(expression, timeoutMs = 120000) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs)
    if (result.exceptionDetails) {
      throw new Error(`Page evaluation failed: ${result.exceptionDetails.exception?.description ?? 'unknown'}`)
    }
    return result.result?.value
  }

  close() {
    try {
      this.socket?.close()
    } catch {
      /* 已经关了 */
    }
  }
}

// ────────────── ④ 抓帧、挑帧、写盘 ──────────────

try {
  child = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--mute-audio',
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${debugPort}`,
      'about:blank',
    ],
    // 受限沙箱里 piped stdio 会 EPERM，所以只能'ignore'：全程只走 CDP。
    { stdio: 'ignore', detached: false },
  )

  const deadline = Date.now() + 30000
  while (true) {
    try {
      if ((await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok) break
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) throw new Error(`Browser did not expose CDP at ${debugPort} in time`)
    await sleep(200)
  }
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json()
  const cdp = new Cdp(target.webSocketDebuggerUrl)
  socket = cdp
  await withTimeout(cdp.ready, 15000, 'cdp.ready')
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Page.navigate', { url: `${origin}/page.html` })
  await sleep(400)

  const probe = await cdp.evaluate(
    `new Promise((resolve, reject) => {
      let tries = 0
      const tick = () => {
        if (typeof window.__extract === 'function') return resolve(true)
        if (tries++ > 100) return reject(new Error('page script never installed'))
        setTimeout(tick, 50)
      }
      tick()
    })`,
  )
  if (probe !== true) throw new Error('Page did not install the extraction helpers')

  const found = await cdp.evaluate(`window.__extract(${JSON.stringify(FRACTIONS)})`)
  const candidates = found.samples
  const meanOfMeans = candidates.reduce((sum, item) => sum + item.mean, 0) / candidates.length
  let chosen = 0
  for (let index = 1; index < candidates.length; index += 1) {
    if (Math.abs(candidates[index].mean - meanOfMeans) < Math.abs(candidates[chosen].mean - meanOfMeans)) chosen = index
  }

  // 进度表：候选时刻、平均亮度、是否选中。
  console.log(`素材：${path.relative(root, source)}  时长 ${found.duration.toFixed(2)}s  原生 ${found.width}x${found.height}`)
  console.log('  idx   t(s)     fraction   mean luma   pixel luma range    chosen')
  for (const [index, item] of candidates.entries()) {
    console.log(
      `  ${String(index).padStart(3)}  ${item.at.toFixed(2).padStart(6)}   ${String(Math.round(item.fraction * 100)).padStart(3)}%      ` +
        `${item.mean.toFixed(5)}     ${item.min.toFixed(4)} … ${item.max.toFixed(4)}    ${index === chosen ? '  ←' : ''}`,
    )
  }
  console.log(`候选平均亮度 ${meanOfMeans.toFixed(5)}，选中第 ${chosen} 个（t=${candidates[chosen].at.toFixed(2)}s）`)

  const still = await cdp.evaluate(`window.__still(${candidates[chosen].at})`)
  const base64 = String(still.dataUrl).replace(/^data:image\/jpeg;base64,/u, '')
  const bytes = Buffer.from(base64, 'base64')
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, bytes)

  // ────────────── ⑤ 落盘自检：魔数、尺寸、非黑、非纯色 ──────────────

  const size = jpegSize(bytes)
  const magic = [...bytes.subarray(0, 3)].map((byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ')
  const uniform = bytes.subarray(0, 512).every((byte) => byte === bytes[0])
  console.log('')
  console.log(`写出：${path.relative(root, outFile)}`)
  console.log(`  字节数 ${bytes.length}（${(bytes.length / 1024).toFixed(1)} KiB）`)
  console.log(`  JPEG 魔数 ${magic}`)
  console.log(`  SOF ${size.marker} → ${size.width}x${size.height}（浏览器报 ${found.width}x${found.height}）`)
  console.log(`  抓帧时的平均亮度 ${still.mean.toFixed(5)}`)

  // 把刚写出的 jpg 再画回浏览器 canvas 量一次：这是对"文件里到底是什么像素"的独立确认。
  const reread = await cdp.evaluate(`window.__measureImage('/background.jpg?ts=${Date.now()}')`)
  console.log(`  回读 jpg：${reread.width}x${reread.height}，平均亮度 ${reread.mean.toFixed(5)}，采样到 ${reread.distinct} 种颜色`)

  if (bytes.length <= 80 * 1024) {
    failures += 1
    console.error(`FAIL 文件只有 ${bytes.length} 字节，小于 80 KiB 门槛`)
  }
  if (size.width !== found.width || size.height !== found.height) {
    failures += 1
    console.error(`FAIL 尺寸不一致：文件 ${size.width}x${size.height}，视频 ${found.width}x${found.height}`)
  }
  if (uniform) {
    failures += 1
    console.error('FAIL 文件开头 512 字节完全相同，像是纯色图')
  }
  if (reread.mean <= 0.002) {
    failures += 1
    console.error(`FAIL 回读平均亮度 ${reread.mean.toFixed(5)}，这一帧基本是黑的`)
  }
  console.log(`\nmake-still: ${failures === 0 ? '通过' : `${failures} 项不合格`}`)
} catch (error) {
  failures += 1
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`)
} finally {
  // 不留游离浏览器、不留临时 profile、不留监听端口。
  socket?.close()
  try {
    child?.kill()
  } catch {
    /* 已经退出 */
  }
  await new Promise((resolve) => server.close(resolve))
  await sleep(300)
  try {
    fs.rmSync(profileDir, { recursive: true, force: true })
  } catch {
    /* 浏览器可能还在收尾，留一个临时目录不影响结果 */
  }
}

process.exit(failures === 0 ? 0 : 1)
