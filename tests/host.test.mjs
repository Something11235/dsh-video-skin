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

import { BACKGROUND_ROUTE, BOOT_ROUTE, CONFIG_ROUTE, IMAGE_ROUTE, OVERRIDE_ROUTE, VERSION, apply } from '../index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..')
const BOOT_FILE = path.join(packageRoot, 'assets', 'boot.mp4')
const IMAGE_FILE = path.join(packageRoot, 'assets', 'background.jpg')

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

  const ctx = {
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
    },
    on(event, listener) {
      if (event === 'webserver/index-inject') injectListeners.push(listener)
    },
    inject(names, callback) {
      if (names.includes('webServer')) callback({ webServer, effect: (factory) => disposers.push(factory()) })
    },
    routes,
    injectListeners,
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

test('apply() 不抛异常，并且注册了配置/开机/背景短片/背景静态图/写回五条 exact 路由', () => {
  const { ctx } = boot()
  assert.equal(ctx.injectListeners.length, 1, '注入订阅必须只有一个')
  assert.deepEqual(
    [...ctx.routes.keys()].sort(),
    [BACKGROUND_ROUTE, BOOT_ROUTE, CONFIG_ROUTE, IMAGE_ROUTE, OVERRIDE_ROUTE].sort(),
  )
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
  assert.ok(table[1].text.includes(IMAGE_ROUTE), '静态图地址也要在行里，否则面板切不过去')
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
    assert.equal(payload.background.mode, 'video', '默认还是循环短片')
    assert.equal(payload.background.imageSrc, IMAGE_ROUTE, '静态图地址要一起给，面板才能切')
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

test('静态图路由：200 + image/jpeg，字节数与原文件一致', async () => {
  const { ctx } = boot()
  const { server, base } = await serve(ctx.routes)
  try {
    const response = await fetch(`${base}${IMAGE_ROUTE}`)
    assert.equal(response.status, 200)
    // 路由名特意不带扩展名：类型来自**真实落地文件**的扩展名（换成 png/webp 也对）。
    assert.equal(response.headers.get('content-type'), 'image/jpeg')
    assert.match(response.headers.get('cache-control') ?? '', /no-cache/u)
    assert.ok(response.headers.get('etag'))
    const body = Buffer.from(await response.arrayBuffer())
    assert.equal(body.length, fs.statSync(IMAGE_FILE).size)
    // 顺手证一下"它真是一张 JPEG"：SOI 标记（FF D8 FF）不会撒谎。
    assert.deepEqual([...body.subarray(0, 3)], [0xff, 0xd8, 0xff])
  } finally {
    server.close()
  }
})

test('静态图不在盘上：那条路由回 404，背景短片不受影响', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-video-skin-home-'))
  fs.writeFileSync(
    path.join(home, 'dsh-video-skin.json'),
    JSON.stringify({ background: { mode: 'image', image: 'assets/gone.jpg' } }),
  )
  const { ctx } = boot({ home })
  const { server, base } = await serve(ctx.routes)
  try {
    assert.equal((await fetch(`${base}${IMAGE_ROUTE}`)).status, 404)
    assert.equal((await fetch(`${base}${BACKGROUND_ROUTE}`)).status, 200)
    // 图不可用时宿主把类型退回短片 —— 页面侧因此不会去点一个不存在的素材。
    const payload = await (await fetch(`${base}${CONFIG_ROUTE}`)).json()
    assert.equal(payload.background.mode, 'video')
    assert.equal(payload.background.imageSrc, '')
  } finally {
    server.close()
  }
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

// ────────────────────── 背景类型开关（短片 / 静态图） ──────────────────────

test('背景类型写回：POST mode 落到用户文件，config.json 立刻反映', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-video-skin-home-'))
  fs.writeFileSync(
    path.join(home, 'dsh-video-skin.json'),
    JSON.stringify({ background: { delayMs: 300 }, boot: { hint: '别动我' } }),
  )
  const { ctx } = boot({ home })
  const { server, base } = await serve(ctx.routes)
  try {
    assert.equal((await (await fetch(`${base}${CONFIG_ROUTE}`)).json()).background.mode, 'video')

    const posted = await fetch(`${base}${OVERRIDE_ROUTE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ background: { mode: 'image' } }),
    })
    assert.equal(posted.status, 200)
    const result = await posted.json()
    assert.equal(result.persisted, true)
    assert.equal(result.config.background.mode, 'image', '响应里就带回新配置')

    const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'dsh-video-skin.json'), 'utf8'))
    assert.equal(onDisk.background.mode, 'image')
    assert.equal(onDisk.background.delayMs, 300, '无关的键原样保留')
    assert.equal(onDisk.boot.hint, '别动我')

    const after = await (await fetch(`${base}${CONFIG_ROUTE}`)).json()
    assert.equal(after.background.mode, 'image')
    // 两个素材地址都在：切回去是个纯客户端的动作，不必再问宿主。
    assert.equal(after.background.imageSrc, IMAGE_ROUTE)
    assert.equal(after.background.src, BACKGROUND_ROUTE)

    // DELETE 也要把类型一起摘掉（恢复默认是恢复整块背景）。
    await fetch(`${base}${OVERRIDE_ROUTE}`, { method: 'DELETE' })
    const cleared = JSON.parse(fs.readFileSync(path.join(home, 'dsh-video-skin.json'), 'utf8'))
    assert.deepEqual(cleared.background, { delayMs: 300 })
    assert.equal((await (await fetch(`${base}${CONFIG_ROUTE}`)).json()).background.mode, 'video')
  } finally {
    server.close()
  }
})

test('背景类型写回：非法字面量被拒，且不会盖掉同一份请求里的数字', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-video-skin-home-'))
  const configFile = path.join(home, 'dsh-video-skin.json')
  const { ctx } = boot({ home })
  const { server, base } = await serve(ctx.routes)
  try {
    // 只有脏值：拒掉，并且一个字节都不写盘（`mode` 是字符串，夹取逻辑不适用）。
    const dirtyOnly = await fetch(`${base}${OVERRIDE_ROUTE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ background: { mode: 'hack' } }),
    })
    assert.equal(dirtyOnly.status, 400)
    assert.equal(fs.existsSync(configFile), false)

    // 脏值 + 合法数字：数字照常写，脏值被丢掉（而不是把整个请求判死）。
    const mixed = await (
      await fetch(`${base}${OVERRIDE_ROUTE}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ background: { mode: 'gif', surface: 0.3 } }),
      })
    ).json()
    assert.equal(mixed.config.background.surface, 0.3)
    assert.equal(mixed.config.background.mode, 'video', '脏值不生效')
    const onDisk = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    assert.deepEqual(Object.keys(onDisk.background).sort(), ['surface'], '脏值不该被写进去')
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
