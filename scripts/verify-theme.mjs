/**
 * 主题联动的端到端验证（需要先准备一个**浅色**主题的独立 profile）。
 *
 * 前置（脚本不替你做，因为改主题要重启实例）：
 *   1. node scripts/make-verify-profile.mjs
 *   2. 在 `.verify-home/profiles/verify/cordis.patch.yml` 里加：
 *        - id: ui-theme
 *          name: "@deepseek-ai/dsh-client-ui-theme"
 *          config: { preference: light }
 *   3. 删掉 `.verify-home/dsh-video-skin.theme.json`
 *   4. 启动实例，再跑本脚本
 *
 * 断言的是整条链：宿主自动切深色 → 客户端弹一次性提示 → 点「恢复浅色」→
 * 主题真变回浅色 + 标记记成 reverted（以后不再自动切）。
 *
 * 用法：node scripts/verify-theme.mjs --url "<带令牌地址>" --dsh-home <目录> [--shot 图.png]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const args = { url: '', dshHome: '', shot: '', port: 9456 }
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i]
  if (key === '--url') args.url = process.argv[(i += 1)]
  else if (key === '--dsh-home') args.dshHome = process.argv[(i += 1)]
  else if (key === '--shot') args.shot = process.argv[(i += 1)]
  else if (key === '--port') args.port = Number(process.argv[(i += 1)])
}
if (args.url === '' || args.dshHome === '') {
  console.error('用法：node scripts/verify-theme.mjs --url <带令牌地址> --dsh-home <目录>')
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

const markerFile = path.join(args.dshHome, 'dsh-video-skin.theme.json')
/** 读一次性标记。 */
function readMarker() {
  try {
    return JSON.parse(fs.readFileSync(markerFile, 'utf8'))
  } catch {
    return null
  }
}

const before = readMarker()
check(before !== null && before.switched === true, '宿主已自动切到深色（标记文件写着 switched）', before)
check(before !== null && before.previous === 'light', '标记里记下了原来的偏好（light）', before)
check(before !== null && before.notified !== true, '还没提示过（notified=false）', before)

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-video-skin-theme-chrome-'))
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
  await sleep(1400)
  // 跳过开机动画
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 800, y: 450, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 800, y: 450, button: 'left', clickCount: 1 })
  await sleep(2000)

  const darkNow = await cdp.evaluate(`document.body.hasAttribute('data-ds-dark-theme')`)
  check(darkNow === true, '页面现在确实是深色（body[data-ds-dark-theme]）', { darkNow })

  const notice = await cdp.evaluate(`(() => {
    const box = document.querySelector('#dsvs-theme-notice')
    if (box === null) return { found: false }
    const buttons = Array.from(box.querySelectorAll('.dsvs-theme-action')).map((node) => node.textContent)
    return { found: true, text: (box.textContent || '').replace(/\\s+/g, ' ').trim(), buttons }
  })()`)
  check(notice.found === true, '出现了主题联动的一次性提示', notice)
  check(
    Array.isArray(notice.buttons) && notice.buttons.length === 2 && /恢复/.test(notice.buttons[0]),
    '提示里有两个按钮，第一个是「恢复浅色」',
    notice,
  )

  if (args.shot !== '') {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(args.shot, Buffer.from(shot.data, 'base64'))
    console.log(`shot -> ${args.shot}`)
  }

  // 点「恢复浅色」
  const clicked = await cdp.evaluate(`(() => {
    const button = document.querySelector('.dsvs-theme-revert')
    if (button === null) return false
    button.click()
    return true
  })()`)
  check(clicked === true, '点到了「恢复浅色」', { clicked })
  await sleep(2500)

  const after = await cdp.evaluate(`(() => ({
    dark: document.body.hasAttribute('data-ds-dark-theme'),
    noticeGone: document.querySelector('#dsvs-theme-notice') === null,
  }))()`)
  check(after.noticeGone === true, '提示点了就消失', after)
  check(after.dark === false, '主题真的变回浅色（内核 settings 生效）', after)

  const markerAfter = readMarker()
  check(markerAfter !== null && markerAfter.switched === false, '标记改成"已撤销"，以后不再自动切', markerAfter)
  check(markerAfter !== null && markerAfter.notified === true, '标记记成"提示过了"', markerAfter)

  const again = await (await fetch(`${args.url.split('/?')[0]}/dsh-video-skin/theme`)).json()
  check(again.ok === true && again.preference === 'light', '宿主路由报告当前偏好已回到 light', again)
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
console.log(`\nverify-theme: ${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
