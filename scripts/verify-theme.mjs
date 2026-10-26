/**
 * 主题联动的端到端验证（需要先准备一个**浅色**主题的独立 profile）。
 *
 * 前置（脚本不替你做，因为改主题要重启实例）：
 *   1. node scripts/make-verify-profile.mjs
 *   2. 在 `.verify-home/profiles/verify/cordis.patch.yml` 里加：
 *        - id: ui-theme
 *          name: "@deepseek-ai/dsh-client-ui-theme"
 *          config: { preference: light }
 *   3. 删掉 `.verify-home/dsh-video-skin.theme.json`（保证是"没问过"的状态）
 *   4. 启动实例，再跑本脚本
 *
 * 断言的是整条链（默认 mode=ask，只问不改）：
 *   宿主路由报告 ask:true → 客户端弹"要切到深色吗" → 点「切到深色」→
 *   内核 settings 真的把 ui-theme.preference 写成 dark → 页面变深 → 标记落盘 →
 *   再 POST revert → 变回浅色 + 标记改成已撤销。
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
const base = args.url.split('/?')[0]
const themeUrl = `${base}/dsh-video-skin/theme`

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

const beforeMarker = readMarker()
check(beforeMarker === null, '开跑前没有标记文件（"没问过"的干净状态）', beforeMarker)

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
  // 客户端刻意延迟 1.5s 才去问宿主（远离启动握手），所以这里等久一点。
  await sleep(3200)

  const hostState = await (await fetch(themeUrl)).json()
  check(hostState.ok === true && hostState.mode === 'ask', '宿主路由报告 mode=ask（默认只问不改）', hostState)
  check(hostState.ask === true, '宿主告诉客户端"该问一句了"', hostState)
  check(hostState.askPrevious === 'light', '并且说清楚原来是浅色', hostState)
  check(hostState.evaluated === false, '还没落标记', hostState)

  const lightNow = await cdp.evaluate(`!document.body.hasAttribute('data-ds-dark-theme')`)
  check(lightNow === true, '页面此刻仍是浅色（**没有被偷偷改掉**）', { lightNow })

  const notice = await cdp.evaluate(`(() => {
    const box = document.querySelector('#dsvs-theme-notice')
    if (box === null) return { found: false }
    const buttons = Array.from(box.querySelectorAll('.dsvs-theme-action')).map((node) => node.textContent)
    return { found: true, text: (box.textContent || '').replace(/\\s+/g, ' ').trim(), buttons }
  })()`)
  check(notice.found === true, '弹出了"要切到深色吗"的提示', notice)
  check(
    Array.isArray(notice.buttons) && notice.buttons.some((label) => /切到深色/.test(label)),
    '提示里有「切到深色」按钮',
    notice,
  )

  if (args.shot !== '') {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(args.shot, Buffer.from(shot.data, 'base64'))
    console.log(`shot -> ${args.shot}`)
  }

  // 点「切到深色」
  const clicked = await cdp.evaluate(`(() => {
    const button = document.querySelector('.dsvs-theme-primary')
    if (button === null) return false
    button.click()
    return true
  })()`)
  check(clicked === true, '点到了「切到深色」', { clicked })
  await sleep(3500)

  const afterSwitch = await cdp.evaluate(`(() => ({
    dark: document.body.hasAttribute('data-ds-dark-theme'),
    noticeGone: document.querySelector('#dsvs-theme-notice') === null,
  }))()`)
  check(afterSwitch.noticeGone === true, '提示点了就消失', afterSwitch)
  check(afterSwitch.dark === true, '内核 settings 生效：页面真的变深色了', afterSwitch)

  const markerAfter = readMarker()
  check(markerAfter !== null && markerAfter.switched === true, '标记记成"已切换"', markerAfter)
  check(markerAfter !== null && markerAfter.previous === 'light', '标记里记下了原偏好 light', markerAfter)

  const stateAfter = await (await fetch(themeUrl)).json()
  check(stateAfter.preference === 'dark', '宿主路由报告当前偏好 dark', stateAfter)

  // 撤销：直接打路由（相当于用户点「恢复浅色」）
  const revert = await (
    await fetch(themeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'revert' }),
    })
  ).json()
  check(revert.ok === true && revert.preference === 'light', '「恢复浅色」把偏好写回了 light', revert)
  await sleep(1800)
  const afterRevert = await cdp.evaluate(`!document.body.hasAttribute('data-ds-dark-theme')`)
  check(afterRevert === true, '页面跟着变回浅色', { afterRevert })

  const markerFinal = readMarker()
  check(markerFinal !== null && markerFinal.switched === false, '标记改成已撤销（以后不再问/不再切）', markerFinal)
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
