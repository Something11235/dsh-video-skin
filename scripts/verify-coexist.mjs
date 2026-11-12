/**
 * 共存集成检查：**同时装上真正的 dsh-plugin-wallpaper-engine** 时，
 * 本插件在"壁纸在台上 / 壁纸撤掉"两种状态下是否都正确。
 *
 * 和 `verify-media.mjs` 里那段模拟检查的区别：
 *   - verify-media 只在页面里伪造 `data-we-wallpaper` 标记 + 假壁纸层；
 *   - 这个脚本要求 profile 里**真的装了壁纸引擎**，于是它的 CSS / JS 一起加载，
 *     能抓出"两边 CSS 互相踩"这类只在真集成下才出现的问题。
 *
 * 前置：
 *   1. node scripts/make-verify-profile.mjs
 *   2. dsh plugin --profile verify add dsh-plugin-wallpaper-engine
 *   3. 启动该实例（--port 19388），再跑本脚本
 *
 * 用法：node scripts/verify-coexist.mjs --url "<带令牌地址>" [--shot-dir docs]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const args = { url: '', shotDir: '', port: 9458 }
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i]
  if (key === '--url') args.url = process.argv[(i += 1)]
  else if (key === '--shot-dir') args.shotDir = process.argv[(i += 1)]
  else if (key === '--port') args.port = Number(process.argv[(i += 1)])
}
if (args.url === '') {
  console.error('用法：node scripts/verify-coexist.mjs --url <带令牌地址> [--shot-dir docs]')
  process.exit(2)
}

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]
const browser = BROWSERS.find((candidate) => fs.existsSync(candidate))
if (browser === undefined) {
  console.error('没找到 Chrome/Edge')
  process.exit(2)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const base = args.url.split('/?')[0]

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url)
    this.nextId = 1
    this.pending = new Map()
    this.events = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve())
      this.socket.addEventListener('error', () => reject(new Error('ws error')))
    })
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id)
        if (entry === undefined) return
        this.pending.delete(message.id)
        if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
        else entry.resolve(message.result)
        return
      }
      for (const listener of [...(this.events.get(message.method) ?? [])]) listener(message.params)
    })
  }
  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  waitEvent(method) {
    return new Promise((resolve) => {
      const list = this.events.get(method) ?? []
      const once = (params) => {
        this.events.set(method, (this.events.get(method) ?? []).filter((x) => x !== once))
        resolve(params)
      }
      list.push(once)
      this.events.set(method, list)
    })
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'eval failed')
    return result.result?.value
  }
}

const results = []
/**
 * 记一条断言。
 * @param {boolean} ok 是否通过。
 * @param {string} title 标题。
 * @param {unknown} [detail] 细节。
 */
function check(ok, title, detail) {
  results.push({ ok, title })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${title}${ok || detail === undefined ? '' : `\n       ${JSON.stringify(detail)}`}`)
}

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-video-skin-coexist-'))
const child = spawn(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--hide-scrollbars',
    '--mute-audio',
    '--window-size=1600,900',
    '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${args.port}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return true
    } catch {
      /* not yet */
    }
    await sleep(200)
  }
  return false
}

/** 存一张截图。 */
async function shot(cdp, name) {
  if (args.shotDir === '') return
  const data = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.mkdirSync(args.shotDir, { recursive: true })
  const file = path.join(args.shotDir, name)
  fs.writeFileSync(file, Buffer.from(data.data, 'base64'))
  console.log(`shot -> ${file}`)
}

const exceptions = []
let cdp = null
try {
  if (!(await waitFor(`http://127.0.0.1:${args.port}/json/version`, 20000))) throw new Error('chrome 没起来')
  const target = await (await fetch(`http://127.0.0.1:${args.port}/json/new?about:blank`, { method: 'PUT' })).json()
  cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  // 收集页面的未捕获异常（两边的插件都可能抛）
  cdp.waitEvent('Runtime.exceptionThrown').then((params) => {
    exceptions.push(params.exceptionDetails?.exception?.description ?? JSON.stringify(params))
  })
  cdp.socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') {
      exceptions.push(message.params?.exceptionDetails?.exception?.description ?? 'exception')
    }
  })

  const loaded = cdp.waitEvent('Page.loadEventFired')
  await cdp.send('Page.navigate', { url: args.url })
  await loaded
  await sleep(1800)
  // 跳过开机动画
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 800, y: 450, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 800, y: 450, button: 'left', clickCount: 1 })
  // 首启的「预览版说明」弹窗自带 backdrop-filter: blur，不关掉截图全是糊的。
  await cdp.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find((node) => /继续|Continue/u.test(node.textContent || ''))
    if (button) button.click()
    return true
  })()`)
  await sleep(1200)
  // 首启还会弹「开始使用 / 登录」弹窗，同样带模糊遮罩 —— 按 Esc 关掉它。
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(2500)

  // ── 状态 A：没有壁纸（壁纸引擎在场但未应用） ──
  const stateA = await cdp.evaluate(`(() => ({
    weLoaded: typeof window.__WE__ !== 'undefined' || document.querySelectorAll('[data-we-adapter]').length >= 0,
    weAttr: document.body.getAttribute('data-we-wallpaper'),
    weLayer: document.querySelectorAll('.we-layer, #we-layer').length,
    backdrop: document.querySelector('#dsvs-backdrop') !== null,
    dsvs: document.documentElement.getAttribute('data-dsvs'),
    marker: document.documentElement.getAttribute('data-dsvs-background'),
    panel: document.querySelector('#dsvs-knobs') !== null,
  }))()`)
  console.log(`\n[状态 A] 壁纸引擎在场、但没选中壁纸  ${JSON.stringify(stateA)}`)
  check(stateA.weAttr === null, '壁纸引擎没有应用壁纸时不该挂 data-we-wallpaper', stateA)
  check(stateA.backdrop === true, '没有壁纸时本插件正常接管背景（视频背景在场）', stateA)
  check(stateA.dsvs === 'on' && stateA.marker === 'on', '接管时 data-dsvs / data-dsvs-background 都是 on', stateA)
  check(stateA.panel === true, '面板在', stateA)
  // 诊断：如果画面被糊住，看看是谁在 blur / 谁盖在上面
  const diag = await cdp.evaluate(`(() => {
    const style = (el, prop) => (el ? getComputedStyle(el)[prop] : null)
    const weNodes = Array.from(document.querySelectorAll('[class*="we-"], [id^="we-"]')).map((node) => ({
      tag: node.tagName.toLowerCase(),
      cls: String(node.className || '').slice(0, 60),
      id: node.id || '',
      z: style(node, 'zIndex'),
      pos: style(node, 'position'),
      filter: style(node, 'filter'),
      backdrop: style(node, 'backdropFilter'),
      op: style(node, 'opacity'),
      area: node.getBoundingClientRect().width * node.getBoundingClientRect().height,
    }))
    const video = document.querySelector('#dsvs-backdrop-video')
    const layer = document.querySelector('#dsvs-backdrop')
    return {
      bodyFilter: style(document.body, 'filter'),
      bodyBackdrop: style(document.body, 'backdropFilter'),
      htmlFilter: style(document.documentElement, 'filter'),
      layerZ: style(layer, 'zIndex'),
      layerOpacity: style(layer, 'opacity'),
      layerArea: layer ? Math.round(layer.getBoundingClientRect().width * layer.getBoundingClientRect().height) : 0,
      videoReady: video ? video.readyState : -1,
      videoSrc: video ? String(video.currentSrc || video.src || '').slice(-40) : '',
      weNodes: weNodes.slice(0, 8),
      weCount: weNodes.length,
    }
  })()`)
  console.log(`[诊断] layer z=${diag.layerZ} 面积=${diag.layerArea} 视频readyState=${diag.videoReady} bodyFilter=${diag.bodyFilter} we节点=${diag.weCount}`)
  await shot(cdp, 'e2e-11-coexist-a-own.png')

  // ── 状态 B：壁纸上台（按对方真实写法：先摘属性，再由我们观察） ──
  const stateB = await cdp.evaluate(`(async () => {
    // 造一个和对方同构的层：.we-layer + z-index:-2，再按他们的写法挂标记
    const layer = document.createElement('div')
    layer.className = 'we-layer'
    layer.setAttribute('style', 'position:fixed;inset:0;z-index:-2;background:linear-gradient(160deg,#2a1b4a,#0b1020)')
    document.body.appendChild(layer)
    document.body.setAttribute('data-we-wallpaper', 'on')
    await new Promise((resolve) => setTimeout(resolve, 800))
    return {
      weAttr: document.body.getAttribute('data-we-wallpaper'),
      backdrop: document.querySelector('#dsvs-backdrop') !== null,
      dsvs: document.documentElement.getAttribute('data-dsvs'),
      marker: document.documentElement.getAttribute('data-dsvs-background'),
      panel: document.querySelector('#dsvs-knobs') !== null,
      status: (document.querySelector('.dsvs-media-mode .dsvs-media-note') || {}).textContent || '',
    }
  })()`)
  console.log(`\n[状态 B] 壁纸在台上  ${JSON.stringify(stateB)}`)
  check(stateB.backdrop === false, '壁纸在台上：本插件让路，不建背景层', stateB)
  check(stateB.dsvs === null, '让路时不挂 data-dsvs（对方的透明化规则不受影响）', stateB)
  check(stateB.marker === null, '让路时对外标记不谎称"我在管背景"', stateB)
  check(stateB.panel === true, '面板仍在（有入口改回"始终接管"）', stateB)
  check(/让路/.test(stateB.status), '面板显示"已让路"', stateB)
  await shot(cdp, 'e2e-12-coexist-b-yield.png')

  // ── 状态 C：壁纸撤掉 ──
  const stateC = await cdp.evaluate(`(async () => {
    document.body.removeAttribute('data-we-wallpaper')
    const layer = document.querySelector('.we-layer')
    if (layer) layer.remove()
    await new Promise((resolve) => setTimeout(resolve, 1200))
    return {
      backdrop: document.querySelector('#dsvs-backdrop') !== null,
      dsvs: document.documentElement.getAttribute('data-dsvs'),
      marker: document.documentElement.getAttribute('data-dsvs-background'),
    }
  })()`)
  console.log(`\n[状态 C] 壁纸撤掉  ${JSON.stringify(stateC)}`)
  check(stateC.backdrop === true, '壁纸撤掉后本插件自动接回背景', stateC)
  check(stateC.dsvs === 'on' && stateC.marker === 'on', '接回后标记恢复', stateC)

  // ── 全局：页面没有未捕获异常 ──
  const ours = exceptions.filter((text) => /video-skin|dsvs/iu.test(String(text)))
  const theirs = exceptions.filter((text) => /wallpaper|we-live|we-/iu.test(String(text)))
  check(ours.length === 0, '本插件的脚本没有抛未捕获异常', ours)
  check(exceptions.length === theirs.length, '页面里没有来源不明的异常', exceptions)
} catch (error) {
  check(false, '运行期异常', error instanceof Error ? error.message : String(error))
} finally {
  try {
    cdp?.socket.close()
  } catch {
    /* ignore */
  }
  try {
    child.kill()
  } catch {
    /* ignore */
  }
}

const failed = results.filter((item) => !item.ok)
console.log(`\nverify-coexist: ${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
