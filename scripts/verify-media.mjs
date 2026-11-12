/**
 * 素材管理的端到端验证（真 Chromium）：开关 / 上传替换 / 恢复默认。
 *
 * 断言的全是"用户真的会看到/点到"的东西：
 *   · 面板里有两行（开机动画 / 聊天背景），每行有开关、更换、默认、隐藏的文件框；
 *   · 关掉聊天背景 → 视频层真的消失，但**面板必须还在**（否则用户没有入口再打开）；
 *   · 再打开 → 视频层回来并且能播；
 *   · 上传一份真实 mp4（拿现成的背景素材回传）→ 宿主落盘、配置记成自定义、
 *     回包里带新文件名、素材路由吐的字节和上传的一致；
 *   · 恢复默认 → 回到包内素材，custom 变回 false；
 *   · 关掉开机动画 → 宿主记下 enabled=false（页面重启后生效，界面上有说明）。
 *
 * 用法：node scripts/verify-media.mjs --url "<带令牌地址>" --dsh-home <目录> [--shot 图.png]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const args = { url: '', dshHome: '', shot: '', port: 9457 }
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i]
  if (key === '--url') args.url = process.argv[(i += 1)]
  else if (key === '--dsh-home') args.dshHome = process.argv[(i += 1)]
  else if (key === '--shot') args.shot = process.argv[(i += 1)]
  else if (key === '--port') args.port = Number(process.argv[(i += 1)])
}
if (args.url === '' || args.dshHome === '') {
  console.error('用法：node scripts/verify-media.mjs --url <带令牌地址> --dsh-home <目录>')
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
const mediaUrl = `${base}/dsh-video-skin/media`

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

/** 轮询一个页面断言，给异步操作留时间。 */
async function until(cdp, expression, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await cdp.evaluate(expression)
    if (last === true) return true
    await sleep(200)
  }
  return last
}

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-video-skin-media-chrome-'))
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

let cdp = null
try {
  if (!(await waitFor(`http://127.0.0.1:${args.port}/json/version`, 20000))) throw new Error('chrome 没起来')
  const target = await (await fetch(`http://127.0.0.1:${args.port}/json/new?about:blank`, { method: 'PUT' })).json()
  cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  const loaded = cdp.waitEvent('Page.loadEventFired')
  await cdp.send('Page.navigate', { url: args.url })
  await loaded
  await sleep(1500)
  // 跳过开机动画
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 800, y: 450, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 800, y: 450, button: 'left', clickCount: 1 })
  await until(cdp, `document.querySelector('#dsvs-knobs-pill') !== null`, 12000)

  // 打开面板
  await cdp.evaluate(`(() => { const pill = document.querySelector('#dsvs-knobs-pill'); if (pill) pill.click(); return true })()`)
  await sleep(400)

  const ui = await cdp.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.dsvs-media-row'))
    const assetRows = rows.filter((row) => row.hasAttribute('data-slot'))
    return {
      count: rows.length,
      slots: assetRows.map((row) => row.getAttribute('data-slot')),
      each: assetRows.map((row) => ({
        toggle: row.querySelector('.dsvs-media-toggle') !== null,
        buttons: row.querySelectorAll('.dsvs-media-btn').length,
        input: row.querySelector('.dsvs-media-input') !== null,
      })),
      hasMode: rows.some((row) => row.classList.contains('dsvs-media-mode')),
      labels: Array.from(document.querySelectorAll('.dsvs-media-name')).map((n) => n.textContent),
    }
  })()`)
  check(ui.count === 3, '面板里有素材区：两个槽位 + 一行背景归属', ui)
  check(
    Array.isArray(ui.slots) && ui.slots[0] === 'boot' && ui.slots[1] === 'background',
    '槽位顺序是「开机动画 / 聊天背景」',
    ui,
  )
  check(
    Array.isArray(ui.each) && ui.each.every((row) => row.toggle && row.buttons === 2 && row.input),
    '每个素材行都有开关 + 更换 + 默认 + 隐藏文件框',
    ui,
  )
  check(ui.hasMode === true, '第三行是「背景归属」（自动让路 / 始终接管）', ui)

  if (args.shot !== '') {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(args.shot, Buffer.from(shot.data, 'base64'))
    console.log(`shot -> ${args.shot}`)
  }

  // ① 关掉聊天背景：视频层消失，但面板必须还在
  await cdp.evaluate(`(() => {
    const row = document.querySelector('.dsvs-media-row[data-slot="background"]')
    row.querySelector('.dsvs-media-toggle').click()
    return true
  })()`)
  const offOk = await until(
    cdp,
    `document.querySelector('#dsvs-backdrop') === null && document.querySelector('#dsvs-knobs') !== null`,
    10000,
  )
  check(offOk === true, '关掉聊天背景：视频层消失、面板留着（还能再打开）', { offOk })
  const offState = await (await fetch(mediaUrl)).json()
  check(offState.background.enabled === false, '宿主记下了 background.enabled = false', offState)

  // ② 再打开：视频层回来并且能播
  await cdp.evaluate(`(() => {
    const row = document.querySelector('.dsvs-media-row[data-slot="background"]')
    row.querySelector('.dsvs-media-toggle').click()
    return true
  })()`)
  const onOk = await until(
    cdp,
    `(() => {
      const video = document.querySelector('#dsvs-backdrop-video')
      return video !== null && video.readyState >= 2
    })()`,
    15000,
  )
  check(onOk === true, '再打开：视频层回来并且出画面了', { onOk })
  const onState = await (await fetch(mediaUrl)).json()
  check(onState.background.enabled === true, '宿主记下了 background.enabled = true', onState)

  // ③ 上传：把页面里现成的背景素材回传一份（真 mp4，能播）
  const upload = await cdp.evaluate(`(async () => {
    const blob = await (await fetch('/dsh-video-skin/background.mp4')).blob()
    const response = await fetch('/dsh-video-skin/media?slot=background', {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4', 'X-Dsh-Filename': encodeURIComponent('my-background.mp4') },
      body: blob,
    })
    const payload = await response.json()
    return { status: response.status, ok: payload.ok, name: payload.background && payload.background.name,
             custom: payload.background && payload.background.custom, size: blob.size }
  })()`)
  check(upload !== null && upload.ok === true, '上传接口接受一个真实 mp4', upload)
  check(
    upload !== null && upload.custom === true && /^background-[0-9a-f]{12}\.mp4$/u.test(upload.name ?? ''),
    '回包里带着"自定义素材"和内容哈希文件名',
    upload,
  )
  const savedFile = path.join(args.dshHome, 'dsh-video-skin-media', upload?.name ?? 'missing')
  check(fs.existsSync(savedFile), '文件真的落到 $DSH_HOME/dsh-video-skin-media/ 了', { savedFile })
  const savedSize = fs.existsSync(savedFile) ? fs.statSync(savedFile).size : 0
  check(savedSize === upload?.size, '落盘大小和上传的一致', { savedSize, uploaded: upload?.size })
  const stillPlaying = await until(
    cdp,
    `(() => { const v = document.querySelector('#dsvs-backdrop-video'); return v !== null && v.readyState >= 2 })()`,
    15000,
  )
  check(stillPlaying === true, '换完素材后背景仍能正常播放', { stillPlaying })

  // ④ 恢复默认
  const reset = await (await fetch(`${mediaUrl}?slot=background`, { method: 'DELETE' })).json()
  check(reset.ok === true && reset.background.custom === false, '「默认」按钮把素材恢复成包内那个', reset)

  // ④b) 与 dsh-wallpaper-engine 共存（issue #4）：
  //     模拟它在 body 上挂 data-we-wallpaper="on" + 一层 z-index:-2 的壁纸，
  //     我们应当自动让路：撤掉背景层、不挂 data-dsvs，面板留着。
  const yielded = await cdp.evaluate(`(async () => {
    const wall = document.createElement('div')
    wall.id = 'we-layer-fake'
    wall.setAttribute('style', 'position:fixed;inset:0;z-index:-2;background:linear-gradient(160deg,#3b1d5e,#0b1020)')
    document.body.appendChild(wall)
    document.body.setAttribute('data-we-wallpaper', 'on')
    await new Promise((resolve) => setTimeout(resolve, 600))
    return {
      backdropGone: document.querySelector('#dsvs-backdrop') === null,
      noDsvs: !document.documentElement.hasAttribute('data-dsvs'),
      noMarker: !document.documentElement.hasAttribute('data-dsvs-background'),
      panelAlive: document.querySelector('#dsvs-knobs') !== null,
      wallpaperVisible: getComputedStyle(wall).zIndex === '-2',
      status: (document.querySelector('.dsvs-media-mode .dsvs-media-note') || {}).textContent || '',
    }
  })()`)
  check(yielded.backdropGone === true, '检测到壁纸插件：背景层自动撤掉（让路）', yielded)
  check(yielded.noDsvs === true, '让路时不挂 data-dsvs（壁纸引擎的透明化规则才生效）', yielded)
  check(yielded.noMarker === true, '让路时对外标记也不谎称"我在管背景"', yielded)
  check(yielded.panelAlive === true, '面板仍然在（用户能改成"始终接管"）', yielded)
  check(/让路|壁纸/.test(yielded.status), '面板里说明了当前是"已让路"', yielded)

  if (args.shot !== '') {
    const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(args.shot.replace(/\.png$/u, '-wallpaper.png'), Buffer.from(shot2.data, 'base64'))
    console.log(`shot -> ${args.shot.replace(/\.png$/u, '-wallpaper.png')}`)
  }

  // 壁纸撤掉 → 我们的背景自动接回来
  const restored = await cdp.evaluate(`(async () => {
    document.body.removeAttribute('data-we-wallpaper')
    const wall = document.querySelector('#we-layer-fake')
    if (wall) wall.remove()
    await new Promise((resolve) => setTimeout(resolve, 900))
    return {
      backdrop: document.querySelector('#dsvs-backdrop') !== null,
      dsvs: document.documentElement.getAttribute('data-dsvs'),
      marker: document.documentElement.getAttribute('data-dsvs-background'),
    }
  })()`)
  check(restored.backdrop === true, '壁纸撤掉后背景层自动接回来', restored)
  check(restored.dsvs === 'on' && restored.marker === 'on', '接回来之后 data-dsvs / data-dsvs-background 都恢复', restored)

  // 用户点「始终接管」→ 即使壁纸在台上也接管
  const own = await cdp.evaluate(`(async () => {
    document.body.setAttribute('data-we-wallpaper', 'on')
    await new Promise((resolve) => setTimeout(resolve, 400))
    const buttons = Array.from(document.querySelectorAll('.dsvs-media-mode .dsvs-media-btn'))
    const target = buttons.find((node) => /始终接管/.test(node.textContent || ''))
    if (target) target.click()
    await new Promise((resolve) => setTimeout(resolve, 1200))
    return {
      backdrop: document.querySelector('#dsvs-backdrop') !== null,
      marker: document.documentElement.getAttribute('data-dsvs-background'),
      active: buttons.map((node) => ({ label: node.textContent, active: node.getAttribute('data-active') })),
    }
  })()`)
  check(own.backdrop === true, '点了「始终接管」之后，壁纸在台上也照样接管', own)
  check(own.marker === 'on', '接管时对外标记也要正确', own)
  check(
    Array.isArray(own.active) && own.active.some((item) => /始终接管/.test(item.label || '') && item.active === '1'),
    '按钮高亮切到「始终接管」',
    own,
  )

  // 切回自动让路：壁纸在台上就再次让路
  const backToAuto = await cdp.evaluate(`(async () => {
    const buttons = Array.from(document.querySelectorAll('.dsvs-media-mode .dsvs-media-btn'))
    const target = buttons.find((node) => /自动让路/.test(node.textContent || ''))
    if (target) target.click()
    await new Promise((resolve) => setTimeout(resolve, 1200))
    return {
      backdropGone: document.querySelector('#dsvs-backdrop') === null,
      noDsvs: !document.documentElement.hasAttribute('data-dsvs'),
    }
  })()`)
  check(backToAuto.backdropGone === true && backToAuto.noDsvs === true, '切回「自动让路」后再次让路', backToAuto)

  // 收尾：把模拟的壁纸撤掉，别影响后面的断言
  await cdp.evaluate(`(async () => {
    document.body.removeAttribute('data-we-wallpaper')
    await new Promise((resolve) => setTimeout(resolve, 900))
    return true
  })()`)

  // ⑤ 关掉开机动画（重启后生效）
  const bootOff = await (
    await fetch(`${mediaUrl}?slot=boot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
  ).json()
  check(bootOff.ok === true && bootOff.boot.enabled === false, '开机动画可以单独关掉（重启 DSH 后生效）', bootOff)
  const userConfig = path.join(args.dshHome, 'dsh-video-skin.json')
  const raw = fs.existsSync(userConfig) ? JSON.parse(fs.readFileSync(userConfig, 'utf8')) : null
  check(raw !== null && raw.boot?.enabled === false, '用户配置文件里记下了 boot.enabled = false', raw?.boot)
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
console.log(`\nverify-media: ${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
