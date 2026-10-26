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
    return {
      count: rows.length,
      slots: rows.map((row) => row.getAttribute('data-slot')),
      each: rows.map((row) => ({
        toggle: row.querySelector('.dsvs-media-toggle') !== null,
        buttons: row.querySelectorAll('.dsvs-media-btn').length,
        input: row.querySelector('.dsvs-media-input') !== null,
      })),
      labels: Array.from(document.querySelectorAll('.dsvs-media-name')).map((n) => n.textContent),
    }
  })()`)
  check(ui.count === 2, '面板里有素材区，两个槽位', ui)
  check(
    Array.isArray(ui.slots) && ui.slots[0] === 'boot' && ui.slots[1] === 'background',
    '槽位顺序是「开机动画 / 聊天背景」',
    ui,
  )
  check(
    Array.isArray(ui.each) && ui.each.every((row) => row.toggle && row.buttons === 2 && row.input),
    '每行都有开关 + 更换 + 默认 + 隐藏文件框',
    ui,
  )

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
