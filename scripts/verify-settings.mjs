/**
 * 设置页卡片的端到端验证：**DSH 设置 → 视频皮肤** 这张页面真的出现、能读状态、能改东西。
 *
 * ⚠️ 前置：这个 profile **必须已登录**。全新/未登录的 profile 里，侧栏根本没有「设置」入口
 *    （它挂在账号菜单后面），脚本会明确报 SKIP 而不是假装通过。
 *
 * 走的是真实 UI 路径（点侧栏「设置」→ 点「视频皮肤」），所以断言的是用户看到的东西；
 * 客户端那一半（client.js）在这里第一次被真正跑起来。
 *
 * 用法：node scripts/verify-settings.mjs --url "<带令牌地址>" [--shot 图.png]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const args = { url: '', shot: '', port: 9459 }
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i]
  if (key === '--url') args.url = process.argv[(i += 1)]
  else if (key === '--shot') args.shot = process.argv[(i += 1)]
  else if (key === '--port') args.port = Number(process.argv[(i += 1)])
}
if (args.url === '') {
  console.error('用法：node scripts/verify-settings.mjs --url <带令牌地址> [--shot 图.png]')
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
  async key(key, code, keyCode) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode })
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

/** 点"可见文字匹配"的元素（取文字最短的那个，避免点到包住整页的容器）。 */
const clickByText = (text, exact = false) => `(() => {
  const wanted = ${JSON.stringify(text)}
  const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, [tabindex], span, div'))
    .filter((node) => {
      const rect = node.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return false
      const own = (node.innerText || '').trim()
      return ${exact ? 'own === wanted' : 'own.includes(wanted)'}
    })
    .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)
  const hit = nodes[0]
  if (!hit) return false
  hit.click()
  return true
})()`

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-video-skin-settings-'))
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
let skipped = false
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
  await sleep(1800)
  // 跳过开机动画
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 800, y: 450, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 800, y: 450, button: 'left', clickCount: 1 })
  await sleep(2000)

  // 首启弹窗（「预览版说明」/「开始使用」）带模糊遮罩，会挡住侧栏 —— 循环关掉。
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const state = await cdp.evaluate(`(() => {
      const text = document.body.innerText || ''
      const onboarding = /预览版说明|开始使用|登录 DeepSeek|添加 API Key/.test(text)
      const buttons = Array.from(document.querySelectorAll('button'))
      const cont = buttons.find((node) => /^(继续|知道了|跳过|稍后|关闭)$/u.test((node.textContent || '').trim()))
      if (cont) cont.click()
      return { onboarding, clicked: Boolean(cont) }
    })()`)
    if (!state.onboarding && !state.clicked) break
    await cdp.key('Escape', 'Escape', 27)
    await sleep(600)
  }

  // 客户端模块有没有跑起来（client.js 里的标记）
  const clientState = await cdp.evaluate(`(() => ({
    loaded: window.__DSH_VIDEO_SKIN_CLIENT__ === 'v1',
    applied: window.__DSH_VIDEO_SKIN_APPLY__ === true,
    slotReady: window.__DSH_VIDEO_SKIN_SLOT__ === true,
    error: window.__DSH_VIDEO_SKIN_ERR__ || '',
  }))()`)
  check(clientState.loaded === true, '客户端模块执行了（client.js 被加载）', clientState)
  check(clientState.applied === true, 'apply() 被调用了', clientState)
  check(clientState.slotReady === true && clientState.error === '', 'settings.section 插槽就绪且注册没抛异常', clientState)

  // 设置入口：只有已登录的 profile 才有
  const hasEntry = await cdp.evaluate(`(() => {
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, [tabindex]'))
    return nodes.some((node) => (node.innerText || '').trim() === '设置' || /设置/u.test(node.getAttribute('aria-label') || ''))
  })()`)
  if (!hasEntry) {
    skipped = true
    console.log('\nSKIP 这个 profile 没有「设置」入口（全新/未登录 profile 就是这样）。')
    console.log('     要验设置页卡片，请换一个已登录的 profile 再跑；客户端模块层面已由上面三条覆盖。')
  } else {
    const opened = await cdp.evaluate(clickByText('设置', true))
    await sleep(1400)
    const settingsOpen = await cdp.evaluate(`/账号与余额|通用设置/.test(document.body.innerText || '')`)
    check(opened === true && settingsOpen === true, '设置面板打开了（能看到它自己的分组）', { opened, settingsOpen })

    const hasSection = await cdp.evaluate(`/视频皮肤/.test(document.body.innerText || '')`)
    check(hasSection === true, '设置左侧出现了「视频皮肤」这一项')

    await cdp.evaluate(clickByText('视频皮肤'))
    await sleep(1200)
    if (args.shot !== '') {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(args.shot, Buffer.from(shot.data, 'base64'))
      console.log(`shot -> ${args.shot}`)
    }

    const page = await cdp.evaluate(`(() => {
      const text = document.body.innerText || ''
      return {
        status: /状态/.test(text),
        owner: /背景归属/.test(text),
        opacity: /透明度/.test(text),
        media: /素材/.test(text),
        version: /0\\.1\\.\\d+/.test(text),
        auto: /自动让路/.test(text),
        own: /始终接管/.test(text),
      }
    })()`)
    check(page.status && page.owner && page.opacity && page.media, '卡片四块（状态/背景归属/透明度/素材）都在', page)
    check(page.version === true, '显示了插件版本号', page)
    check(page.auto && page.own, '背景归属的两个按钮在', page)

    // 真的能改：点「始终接管」→ 宿主配置变化
    const before = await (await fetch(`${base}/dsh-video-skin/media`)).json()
    await cdp.evaluate(clickByText('始终接管', true))
    await sleep(1400)
    const after = await (await fetch(`${base}/dsh-video-skin/media`)).json()
    check(after.background.mode === 'own', '在设置页点「始终接管」，宿主配置真的变了', {
      before: before.background.mode,
      after: after.background.mode,
    })

    // 收尾：切回自动让路
    await cdp.evaluate(clickByText('自动让路', true))
    await sleep(1200)
    const restored = await (await fetch(`${base}/dsh-video-skin/media`)).json()
    check(restored.background.mode === 'auto', '切回「自动让路」（收尾无残留）', restored.background.mode)
  }
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
const summary = `${results.length - failed.length}/${results.length} 通过${skipped ? '（设置页部分 SKIP）' : ''}`
console.log(`\nverify-settings: ${summary}`)
process.exit(failed.length === 0 ? 0 : 1)
