/**
 * 宿主半边的**真实请求**测试：用真的 `apply()`，把注册出来的路由挂到真的 http
 * 服务器上，打真的 HTTP 请求。
 *
 * 为什么要这么重：桩只能证明插件自洽。Range/ETag/HEAD/404 这些是浏览器与服务器之间
 * 的契约，只有真请求能证明。另外这里还验证两件"出事就是大事"的性质：
 *   ① `apply()` 不抛异常（宿主半边 FAILED 会连累整个组合树）；
 *   ② 贡献的注入行只有两行、顺序固定、且文本里不可能出现 `</script`。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  BACKGROUND_ROUTE,
  BOOT_ROUTE,
  CONFIG_ROUTE,
  MEDIA_ROUTE,
  OVERRIDE_ROUTE,
  THEME_ROUTE,
  VERSION,
  apply,
} from '../index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..')
const BOOT_FILE = path.join(packageRoot, 'assets', 'boot.mp4')

/** 造一个能骗过 `apply()` 的宿主上下文：只实现它真正用到的四个成员。 */
function makeContext() {
  /** @type {Map<string, (req: any, res: any) => void>} */
  const routes = new Map()
  /** @type {Array<(table: Array<Record<string, unknown>>) => void>} */
  const injectListeners = []
  const logs = []
  const disposers = []

  const webServer = {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }

  /** 记录 `ctx.get()` 的调用名（用来断言启动期不读任何服务）。 */
  const getCalls = []
  /** 记录 `ctx.inject()` 的依赖名（用来断言只有一个晚到服务）。 */
  const injectCalls = []

  const ctx = {
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
    },
    on(event, listener) {
      if (event === 'webserver/index-inject') injectListeners.push(listener)
    },
    inject(names, callback) {
      injectCalls.push([...names])
      if (names.includes('webServer')) callback({ webServer, effect: (factory) => disposers.push(factory()) })
    },
    // 只读查询：apply() 期间**不该**被调用（0.1.3 的启动崩溃就是启动期碰了 settings）。
    get(name) {
      getCalls.push(name)
      return undefined
    },
    routes,
    injectListeners,
    getCalls,
    injectCalls,
    logs,
    disposers,
  }
  return ctx
}

/** 把注册出来的 exact 路由挂到一个真服务器上。 */
function serve(routes) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname
    const handler = routes.get(pathname)
    if (handler === undefined) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('no route')
      return
    }
    handler(req, res)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, base: `http://127.0.0.1:${address.port}` })
    })
  })
}

/** 在隔离的 DSH_HOME 下跑一次 apply，返回上下文与两个注入行。 */
function boot(options = {}) {
  const home = options.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-video-skin-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const ctx = makeContext()
    apply(ctx)
    const table = []
    for (const listener of ctx.injectListeners) listener(table)
    return { ctx, table, home }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

test('apply() 不抛异常，并且注册了配置/开机/背景/滑块写回/主题联动/素材六条 exact 路由', () => {
  const { ctx } = boot()
  // injectListeners 记的是 index-inject 的订阅，永远只该有一条。
  assert.equal(ctx.injectListeners.length, 1, '注入订阅必须只有一个')
  assert.deepEqual(
    [...ctx.routes.keys()].sort(),
    [BACKGROUND_ROUTE, BOOT_ROUTE, CONFIG_ROUTE, MEDIA_ROUTE, OVERRIDE_ROUTE, THEME_ROUTE].sort(),
  )
})

test('启动期绝不碰 settings，也不额外等任何服务（0.1.3 桌面版启动崩溃的回归守卫）', () => {
  const { ctx } = boot()
  // 这条是本仓库最重要的一条断言：
  // 0.1.3 在 apply() 里 `ctx.inject(['settings'])` 并在激活期调 `settings.update()`，
  // 而 update() 会改写 profile patch 文档 + 同步 describe()。桌面版启动握手是
  // 「欢迎窗口第一个 RPC（settings.describe）非 2xx 就判启动失败、不重试」，
  // 于是用户一装插件，桌面版就再也起不来。
  // 现在：启动期零 settings 交互，所有读写都推迟到页面主动 GET /theme 之后。
  assert.deepEqual(ctx.getCalls, [], '启动期不该 ctx.get() 任何服务')
  assert.deepEqual(ctx.injectCalls, [['webServer']], '只等 webServer 一个服务')
})
test('注入行：两行、style 在前 script 在后、script 里没有 </script', () => {
  const { table } = boot()
  assert.equal(table.length, 2)
  assert.equal(table[0].kind, 'style')
  assert.equal(table[1].kind, 'script')
  assert.equal(table[1].placement, 'body')
  assert.equal(table[0].text.includes('</style'), false)
  assert.equal(table[1].text.includes('</script'), false)
  assert.ok(table[1].text.includes('dsvs-boot'), '运行时脚本必须真的在行里')
  assert.ok(table[1].text.includes(BOOT_ROUTE))
  assert.ok(table[1].text.includes(BACKGROUND_ROUTE))
})

test('整片请求：200 + video/mp4 + Accept-Ranges + ETag + no-cache', async () => {
  const { ctx } = boot()
  const { server, base } = await serve(ctx.routes)
  try {
    const response = await fetch(`${base}${BOOT_ROUTE}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'video/mp4')
    assert.equal(response.headers.get('accept-ranges'), 'bytes')
    assert.match(response.headers.get('cache-control') ?? '', /no-cache/u)
    assert.ok(response.headers.get('etag'))
    const body = Buffer.from(await response.arrayBuffer())
    assert.equal(body.length, fs.statSync(BOOT_FILE).size)
  } finally {
    server.close()
  }
})

test('切片请求：206 + Content-Range，且 Cache-Control 必须是 no-store', async () => {
  const { ctx } = boot()
  const { server, base } = await serve(ctx.routes)
  try {
    const size = fs.statSync(BOOT_FILE).size
    const response = await fetch(`${base}${BOOT_ROUTE}`, { headers: { Range: 'bytes=0-99' } })
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-range'), `bytes 0-99/${size}`)
    assert.equal(response.headers.get('content-length'), '100')
    // 切片被当成完整资源缓存下来 = 下次普通刷新解一个截断副本 = 黑屏没画面。
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const body = Buffer.from(await response.arrayBuffer())
    assert.equal(body.length, 100)
    assert.deepEqual(body, fs.readFileSync(BOOT_FILE).subarray(0, 100))
  } finally {
    server.close()
  }
})

test('后缀区间与 HEAD 请求', async () => {
  const { ctx } = boot()
  const { server, base } = await serve(ctx.routes)
  try {
    const size = fs.statSync(BOOT_FILE).size
    const suffix = await fetch(`${base}${BOOT_ROUTE}`, { headers: { Range: 'bytes=-50' } })
    assert.equal(suffix.status, 206)
    assert.equal(suffix.headers.get('content-range'), `bytes ${size - 50}-${size - 1}/${size}`)

    const head = await fetch(`${base}${BOOT_ROUTE}`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), String(size))
    assert.equal((await head.arrayBuffer()).byteLength, 0)
  } finally {
    server.close()
  }
})

test('越界区间：416 且带 Content-Range: bytes */size', async () => {
  const { ctx } = boot()
  const { server, base } = await serve(ctx.routes)
  try {
    const size = fs.statSync(BOOT_FILE).size
    const response = await fetch(`${base}${BOOT_ROUTE}`, { headers: { Range: 'bytes=99999999999-' } })
    assert.equal(response.status, 416)
    assert.equal(response.headers.get('content-range'), `bytes */${size}`)
  } finally {
    server.close()
  }
})

test('条件请求：相同 ETag 回 304', async () => {
  const { ctx } = boot()
  const { server, base } = await serve(ctx.routes)
  try {
    const first = await fetch(`${base}${BOOT_ROUTE}`)
    const etag = first.headers.get('etag')
    assert.ok(etag)
    const second = await fetch(`${base}${BOOT_ROUTE}`, { headers: { 'If-None-Match': etag } })
    assert.equal(second.status, 304)
  } finally {
    server.close()
  }
})

test('配置路由：no-store，且带素材地址与版本号', async () => {
  const { ctx } = boot()
  const { server, base } = await serve(ctx.routes)
  try {
    const response = await fetch(`${base}${CONFIG_ROUTE}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const payload = await response.json()
    assert.equal(payload.version, VERSION)
    assert.equal(payload.boot.src, BOOT_ROUTE)
    assert.equal(payload.background.src, BACKGROUND_ROUTE)
    assert.equal(payload.boot.enabled, true)
    assert.equal(payload.background.enabled, true)
    // 用户要求：开机动画要有声音。有声那条必须真的进到载荷里。
    assert.equal(payload.boot.sound, true)
    assert.equal(payload.boot.volume, 1)
    assert.equal(typeof payload.boot.skipLabel, 'string')
    assert.equal(typeof payload.background.surface, 'number')
    assert.ok(payload.background.surface <= 0.35, `表面过实会看不清画面（${payload.background.surface}）`)
    assert.ok(payload.background.veil <= 0.3, `蒙版过重会看不清画面（${payload.background.veil}）`)
    // 绝对文件路径不该出现在给浏览器的载荷里。
    assert.equal(JSON.stringify(payload).includes(packageRoot.replace(/\\/gu, '\\\\')), false)
  } finally {
    server.close()
  }
})

test('用户级配置真的会改变注入行与配置载荷（改 JSON 即生效，无需重启）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-video-skin-home-'))
  fs.writeFileSync(
    path.join(home, 'dsh-video-skin.json'),
    JSON.stringify({ boot: { fadeMs: 900, hint: '快点我' }, background: { surface: 0.25, veil: 0.1 } }),
  )
  const { ctx, table } = boot({ home })
  assert.ok(table[1].text.includes('"fadeMs":900'), '注入行必须反映用户配置')
  assert.ok(table[1].text.includes('快点我'))

  const { server, base } = await serve(ctx.routes)
  try {
    const payload = await (await fetch(`${base}${CONFIG_ROUTE}`)).json()
    assert.equal(payload.boot.fadeMs, 900)
    assert.equal(payload.background.surface, 0.25)
    assert.equal(payload.background.veil, 0.1)
  } finally {
    server.close()
  }
})

test('素材文件被删掉：路由回 404，而不是抛异常', async () => {
  // DSH_HOME 是在 apply() 时解析一次的，所以配置文件必须在 apply 之前就位。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-video-skin-home-'))
  fs.writeFileSync(path.join(home, 'dsh-video-skin.json'), JSON.stringify({ boot: { file: 'assets/gone.mp4' } }))
  const { ctx } = boot({ home })
  const { server, base } = await serve(ctx.routes)
  try {
    const response = await fetch(`${base}${BOOT_ROUTE}`)
    assert.equal(response.status, 404)
    // 另一个功能不受影响。
    assert.equal((await fetch(`${base}${BACKGROUND_ROUTE}`)).status, 200)
  } finally {
    server.close()
  }
})

test('卸载时路由被注销', () => {
  const { ctx } = boot()
  assert.equal(ctx.disposers.length, 1)
  ctx.disposers[0]()
  assert.equal(ctx.routes.size, 0)
})

// ────────────────────── 界面滑块的写回端点 ──────────────────────

test('滑块写回：POST 落到 $DSH_HOME 的用户配置，并立刻被 config.json 反映', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-video-skin-home-'))
  // 用户文件里预先有一条无关设置：写回必须**保留**它，不能整份覆盖。
  fs.writeFileSync(
    path.join(home, 'dsh-video-skin.json'),
    JSON.stringify({ boot: { hint: '别动我' }, background: { delayMs: 300 } }),
  )
  const { ctx } = boot({ home })
  const { server, base } = await serve(ctx.routes)
  try {
    const before = await (await fetch(`${base}${CONFIG_ROUTE}`)).json()
    assert.equal(before.background.surface, 0.2, '起点是默认值')

    const posted = await fetch(`${base}${OVERRIDE_ROUTE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ background: { surface: 0.05, veil: 0 } }),
    })
    assert.equal(posted.status, 200)
    const result = await posted.json()
    assert.equal(result.ok, true)
    assert.equal(result.persisted, true)
    assert.match(result.file, /dsh-video-skin\.json$/u)
    assert.equal(result.config.background.surface, 0.05, '响应里就带回新配置')

    const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'dsh-video-skin.json'), 'utf8'))
    assert.equal(onDisk.background.surface, 0.05)
    assert.equal(onDisk.background.veil, 0)
    assert.equal(onDisk.background.delayMs, 300, '无关的键必须原样保留')
    assert.equal(onDisk.boot.hint, '别动我', '别的段也必须原样保留')

    const after = await (await fetch(`${base}${CONFIG_ROUTE}`)).json()
    assert.equal(after.background.surface, 0.05, 'config.json 立刻反映写回的值')
    // 亮色主题的值按 surface + 0.4 派生，所以滑块一动，两个主题是同步走的。
    assert.equal(after.background.surfaceLight, 0.45)
  } finally {
    server.close()
  }
})

test('滑块恢复默认：DELETE 只摘掉那几项，其他内容不动', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-video-skin-home-'))
  fs.writeFileSync(
    path.join(home, 'dsh-video-skin.json'),
    JSON.stringify({ background: { surface: 0.9, veil: 0.8, surfaceLight: 0.95, delayMs: 500 }, boot: { volume: 0.5 } }),
  )
  const { ctx } = boot({ home })
  const { server, base } = await serve(ctx.routes)
  try {
    assert.equal((await (await fetch(`${base}${CONFIG_ROUTE}`)).json()).background.surface, 0.9)

    const response = await fetch(`${base}${OVERRIDE_ROUTE}`, { method: 'DELETE' })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).ok, true)

    const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'dsh-video-skin.json'), 'utf8'))
    assert.deepEqual(onDisk.background, { delayMs: 500 }, '只摘掉四个旋钮，其余保留')
    assert.deepEqual(onDisk.boot, { volume: 0.5 })

    const after = await (await fetch(`${base}${CONFIG_ROUTE}`)).json()
    assert.equal(after.background.surface, 0.2, '回到默认值')
    assert.equal(after.background.veil, 0.14)
  } finally {
    server.close()
  }
})

test('滑块写回：越界值被夹取，非法输入被拒，超大 body 回 413', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-video-skin-home-'))
  const configFile = path.join(home, 'dsh-video-skin.json')
  const { ctx } = boot({ home })
  const { server, base } = await serve(ctx.routes)
  try {
    // 先打三种"应该被拒"的请求，并且确认它们**一个都没写盘**。
    const bad = await fetch(`${base}${OVERRIDE_ROUTE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json',
    })
    assert.equal(bad.status, 400)

    const noNumbers = await fetch(`${base}${OVERRIDE_ROUTE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ background: { surface: 'nope' } }),
    })
    assert.equal(noNumbers.status, 400)

    const huge = await fetch(`${base}${OVERRIDE_ROUTE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(20000) }),
    })
    assert.equal(huge.status, 413)

    const wrongMethod = await fetch(`${base}${OVERRIDE_ROUTE}`)
    assert.equal(wrongMethod.status, 405)

    assert.equal(fs.existsSync(configFile), false, '被拒的请求一个都不该写盘')

    // 再打一个合法但越界的：夹到区间，并且不认识的键不会被收下。
    const clamped = await (
      await fetch(`${base}${OVERRIDE_ROUTE}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ background: { surface: 9, veil: -5, bounce: 1 } }),
      })
    ).json()
    assert.equal(clamped.config.background.surface, 1, 'surface 夹到 1')
    assert.equal(clamped.config.background.veil, 0, 'veil 夹到 0')
    const onDisk = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    assert.deepEqual(Object.keys(onDisk.background).sort(), ['surface', 'veil'], 'bounce 不该被写进去')
    assert.equal(onDisk.background.surface, 1)
    assert.equal(onDisk.background.veil, 0)
  } finally {
    server.close()
  }
})

test('素材路由：GET 状态 / 开关 / 上传 / 415 / 恢复默认（用户要的"自己换素材"）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-video-skin-media-'))
  // 用户配置里预先放一条无关设置：素材写回必须保留它。
  fs.writeFileSync(
    path.join(home, 'dsh-video-skin.json'),
    JSON.stringify({ background: { veil: 0.3 }, theme: { mode: 'ask' } }),
  )
  const { ctx } = boot({ home })
  const { server, base } = await serve(ctx.routes)
  try {
    // ① 读状态
    let response = await fetch(`${base}${MEDIA_ROUTE}`)
    let body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.boot.enabled, true)
    assert.equal(body.boot.custom, false)
    assert.equal(body.background.custom, false)

    // ② 关掉开机动画（"我只想要背景、不想要开场动画"）
    response = await fetch(`${base}${MEDIA_ROUTE}?slot=boot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    body = await response.json()
    assert.equal(body.ok, true, JSON.stringify(body))
    assert.equal(body.boot.enabled, false)
    const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'dsh-video-skin.json'), 'utf8'))
    assert.equal(onDisk.boot.enabled, false)
    assert.equal(onDisk.background.veil, 0.3, '无关设置必须原样保留')

    // ③ 上传自己的背景
    const bytes = Buffer.from('fake-mp4-bytes-'.repeat(100))
    response = await fetch(`${base}${MEDIA_ROUTE}?slot=background`, {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4', 'X-Dsh-Filename': encodeURIComponent('我的背景.mp4') },
      body: bytes,
    })
    body = await response.json()
    assert.equal(body.ok, true, JSON.stringify(body))
    assert.equal(body.background.custom, true)
    assert.match(body.background.name, /^background-[0-9a-f]{12}\.mp4$/u)
    const saved = path.join(home, 'dsh-video-skin-media', body.background.name)
    assert.deepEqual(fs.readFileSync(saved), bytes, '落盘内容必须和上传的一模一样')
    // 素材路由立刻改吐这个文件
    const served = await fetch(`${base}${BACKGROUND_ROUTE}`)
    assert.equal(served.status, 200)
    assert.equal(served.headers.get('content-type'), 'video/mp4')
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), bytes)

    // ④ 不支持的类型 → 415，且不该往素材目录里写东西
    const before = fs.readdirSync(path.join(home, 'dsh-video-skin-media')).length
    response = await fetch(`${base}${MEDIA_ROUTE}?slot=background`, {
      method: 'POST',
      headers: { 'Content-Type': 'video/x-matroska', 'X-Dsh-Filename': 'a.mkv' },
      body: Buffer.from('whatever'),
    })
    assert.equal(response.status, 415)
    assert.equal(fs.readdirSync(path.join(home, 'dsh-video-skin-media')).length, before, '被拒的上传不能留垃圾')

    // ⑤ 空文件 → 400
    response = await fetch(`${base}${MEDIA_ROUTE}?slot=boot`, {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4', 'X-Dsh-Filename': 'a.mp4' },
      body: Buffer.alloc(0),
    })
    assert.equal(response.status, 400)

    // ⑥ 恢复默认：配置里的 file 被删掉，回到包内素材
    response = await fetch(`${base}${MEDIA_ROUTE}?slot=background`, { method: 'DELETE' })
    body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.background.custom, false)
    assert.equal(body.background.enabled, true)
    const servedDefault = await fetch(`${base}${BACKGROUND_ROUTE}`)
    assert.equal(servedDefault.status, 200)
    assert.ok((await servedDefault.arrayBuffer()).byteLength > 1024 * 1024, '默认背景是包里那个大文件')
  } finally {
    server.close()
  }
})