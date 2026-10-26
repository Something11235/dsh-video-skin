/**
 * dsh-video-skin —— 宿主半边。
 *
 * 两件事，仅此而已：
 *   ① 给 `webserver/index-inject` 贡献两行结构化注入（样式 + 运行时脚本），
 *      它们在页面加载时把 **开机动画覆盖层** 和 **聊天背景层** 挂上去；
 *   ② 用带 Range 的路由把两个素材和一份运行期配置提供给浏览器。
 *
 * 设计取舍（每条都是为了"插件出问题时不能连累 DSH 起来"）：
 *   - `inject` 是空数组，且**不 import 任何 DSH 包**（连 schemastery 都不 import）。
 *     对象级 inject 会把 apply 推迟到服务就绪之后，而桌面壳的注入表是在宿主启动
 *     时收集一次、**没有任何刷新路径**：订阅晚于那次收集，这个插件的注入行就永远
 *     进不了表。所以 apply 必须立刻跑，第一件事就是注册订阅。
 *   - 产物里没有任何 import（只用 node: 内建），所以不存在"依赖解析不到 ⇒ 模块求值
 *     即抛 ⇒ fiber FAILED"这条路径。
 *   - 注入行只推 `kind:'script'`，绝不推 `kind:'script-src'`：后者在桌面壳上失败会
 *     把 `__DSH_BOOT_READY__` 打掉，整个应用起不来。
 *   - 任何一步（读配置、读运行时文件、生成行）出错都只 warn 并跳过，不向上抛。
 *   - 素材文件路径做逃逸防护（`resolveInsidePackage`），配置来自文件也不能读包外。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig, resolveDshHome, clearOverride, writeOverride, OVERRIDE_KEYS } from './lib/config.js'
import { buildInjectionRows } from './lib/injections.js'
import { contentTypeFor, isPlainObject, parseRange } from './lib/route.js'
import {
  decideThemeLink,
  isThemePreference,
  pickThemeDescriptor,
  readThemeMarker,
  writeThemeMarker,
} from './lib/theme.js'

/** Cordis 诊断用的插件名。 */
export const name = 'video-skin'

/** 没有必需服务：`webServer` 用 `ctx.inject` 迟到接入，不阻塞 apply。 */
export const inject = []

/** 所有路由共享的前缀。 */
export const ROUTE_PREFIX = '/dsh-video-skin'
/** 开机动画素材。 */
export const BOOT_ROUTE = `${ROUTE_PREFIX}/boot.mp4`
/** 聊天背景素材。 */
export const BACKGROUND_ROUTE = `${ROUTE_PREFIX}/background.mp4`
/** 运行期配置（允许"改 JSON + 刷新页面"即生效）。 */
export const CONFIG_ROUTE = `${ROUTE_PREFIX}/config.json`
/** 界面滑块写回的位置（POST 保存 / DELETE 恢复默认）。 */
export const OVERRIDE_ROUTE = `${ROUTE_PREFIX}/override`
/** 主题联动：GET 读状态、POST 撤销（一次性的"自动切深色"要能退回去）。 */
export const THEME_ROUTE = `${ROUTE_PREFIX}/theme`

/** 与 package.json 的 version 保持一致。 */
export const VERSION = '0.1.4'

/** 路由表：同时是配置解析的输入。 */
const ROUTES = Object.freeze({
  boot: BOOT_ROUTE,
  background: BACKGROUND_ROUTE,
  config: CONFIG_ROUTE,
  override: OVERRIDE_ROUTE,
  theme: THEME_ROUTE,
})

/** 运行时文本文件所在目录（相对包根）。 */
const RUNTIME_DIR = 'runtime'

/** 滑块写回请求体的上限：只收四个数字，给足余量但绝不无限读。 */
const OVERRIDE_BODY_LIMIT = 4096

/**
 * 取一个安全的错误描述。
 * @param {unknown} error 任意抛出的值。
 * @returns {string} 一行文本。
 */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 造一个"按 mtime+size 缓存"的运行时文件读取器。
 *
 * 缓存的意义不只是省 IO：桌面壳只在宿主启动时收集一次注入表，所以运行时文本是否
 * 新鲜**由那次收集决定**；在 dsh web 的直出形态里每次索引渲染都会重新收集，于是
 * 改完 `runtime/skin.js` 刷新页面即可生效，不必重启、不必重建。
 *
 * @param {string} packageRoot 包根目录。
 * @returns {(file: string) => string} 读取器。
 */
function makeRuntimeReader(packageRoot) {
  const cache = new Map()
  return (file) => {
    const target = path.join(packageRoot, RUNTIME_DIR, file)
    const stat = fs.statSync(target)
    const hit = cache.get(file)
    if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.text
    const text = fs.readFileSync(target, 'utf8')
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, text })
    return text
  }
}

/**
 * 把一个文件按 HTTP 语义发给浏览器：ETag + Range + HEAD。
 *
 * 缓存头分两种，区别很要紧（这是别处踩过的坑）：
 *   - **整片**响应用 `no-cache` + `ETag`：要回源校验一次，没换素材就是 304，秒回；
 *   - **切片（206）**响应用 `no-store`：绝不能允许它被当成完整资源留下来。
 *     播放器替换 `<video>` 元素会中断还在传输的媒体请求，浏览器可能把收到的
 *     一部分当成完整条目缓存；下次普通刷新就会解一个截断副本，表现为"黑屏没画面"，
 *     而硬刷新一切正常 —— 极难查。
 *
 * @param {import('node:http').IncomingMessage} req 入站请求。
 * @param {import('node:http').ServerResponse} res 响应对象。
 * @param {string} filePath 素材的绝对路径。
 */
function serveAsset(req, res, filePath) {
  let stat
  try {
    stat = fs.statSync(filePath)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('asset not found')
    return
  }

  const size = stat.size
  const etag = `"${size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`
  const range = parseRange(req.headers.range, size)

  if (range === 'unsatisfiable') {
    res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' })
    res.end()
    return
  }

  /** @type {Record<string, string | number>} */
  const headers = {
    'Content-Type': contentTypeFor(filePath),
    'Accept-Ranges': 'bytes',
    ETag: etag,
  }

  if (range !== null) {
    headers['Cache-Control'] = 'no-store'
    headers['Content-Length'] = range.end - range.start + 1
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`
    res.writeHead(206, headers)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = fs.createReadStream(filePath, { start: range.start, end: range.end })
    stream.on('error', () => res.destroy())
    stream.pipe(res)
    return
  }

  headers['Cache-Control'] = 'no-cache'
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers)
    res.end()
    return
  }
  headers['Content-Length'] = size
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = fs.createReadStream(filePath)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 */
export function apply(ctx) {
  const packageRoot = fileURLToPath(new URL('.', import.meta.url))
  const homeDir = resolveDshHome(process.env, os.homedir)
  const readRuntime = makeRuntimeReader(packageRoot)

  /**
   * 每次都重新解析配置：注入行在收集时解析，配置路由在每次请求时解析，
   * 所以"改 JSON + 刷新页面"即可生效，不需要重启。
   * @returns {ReturnType<typeof loadConfig>} 解析结果。
   */
  const current = () => loadConfig({ packageRoot, routes: ROUTES, version: VERSION, homeDir })

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`[${name}] ${message}`)
    } catch {
      /* 日志都不该成为失败原因 */
    }
  }
  const info = (message) => {
    try {
      ctx.logger?.info?.(`[${name}] ${message}`)
    } catch {
      /* 同上 */
    }
  }

  /**
   * **按需**取 settings 服务 —— 用 `ctx.get()` 而不是 `ctx.inject()`。
   *
   * `ctx.get()` 只读：服务没就绪就返回 undefined，**不参与激活顺序**。
   * 这是 0.1.4 的关键修复：0.1.3 用 `ctx.inject(['settings'])` 在插件激活期就要服务、
   * 还在激活期里调了 `update()`（= 改写 profile patch 文档 + 同步 describe），
   * 撞上桌面版「欢迎窗口第一个 RPC 失败就判启动失败、不重试」的握手，用户应用起不来。
   * 现在启动期**完全不碰** settings：只有页面加载完、主动 GET /theme 时才用一次。
   * @returns {null | { describe: (options?: { redactSecrets?: boolean }) => unknown, update: (ns: string, patch: object) => Promise<void>, writable?: boolean }} 服务或 null。
   */
  const settingsNow = () => {
    try {
      if (typeof ctx.get !== 'function') return null
      const service = ctx.get('settings')
      return service !== undefined && service !== null ? service : null
    } catch {
      return null
    }
  }

  /**
   * 把主题偏好写回去（**只走内核 settings 服务**，绝不手改用户的 profile YAML）。
   *
   * 只可能在"页面加载后主动来问"这条路径上被调用 —— 启动期不会走到这里。
   * @param {'light' | 'dark' | 'system'} preference 目标偏好。
   * @returns {Promise<boolean>} 是否写成功。
   */
  const writeThemePreference = async (preference) => {
    const service = settingsNow()
    if (service === null || typeof service.update !== 'function') return false
    if (!isThemePreference(preference)) return false
    try {
      await service.update('ui-theme', { preference })
      return true
    } catch (error) {
      warn(`切换主题失败（不影响背景本身）：${describe(error)}`)
      return false
    }
  }

  // ── ① 注入行：必须**同步**注册，且不能等到任何服务就绪 ──
  ctx.on('webserver/index-inject', (table) => {
    if (!Array.isArray(table)) return
    try {
      const { client, warnings } = current()
      for (const warning of warnings) warn(warning)
      const rows = buildInjectionRows({
        clientConfig: client,
        cssText: readRuntime('skin.css'),
        jsText: readRuntime('skin.js'),
      })
      table.push(...rows)
    } catch (error) {
      // 注入行生成失败只是"没有背景/没有开机动画"，绝不能让索引渲染失败。
      warn(`注入行生成失败，页面将回落到原生外观：${describe(error)}`)
    }
  })

  // ── ② 路由：webServer 是可选能力，晚到就晚接，不阻塞 apply ──
  ctx.inject(['webServer'], (child) => {
    child.effect(() => {
      /** @type {Array<() => void>} */
      const disposers = []

      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: CONFIG_ROUTE,
          handler: (req, res) => {
            let payload
            try {
              const { client, warnings } = current()
              payload = JSON.stringify({ ...client, warnings })
            } catch (error) {
              payload = JSON.stringify({ error: describe(error) })
            }
            res.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Content-Length': Buffer.byteLength(payload),
              'Cache-Control': 'no-store',
            })
            res.end(payload)
          },
        }),
      )

      /**
       * 素材路由：每次请求都重新解析配置，所以换素材文件后刷新即可，无需重启。
       * @param {string} route 路由路径。
       * @param {'boot' | 'background'} key 配置里的功能名。
       */
      const registerAsset = (route, key) => {
        disposers.push(
          child.webServer.register({
            kind: 'exact',
            path: route,
            handler: (req, res) => {
              let filePath
              try {
                filePath = current().paths[key]
              } catch (error) {
                warn(`${key} 素材解析失败：${describe(error)}`)
              }
              if (filePath === undefined) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
                res.end(`${key} asset is unavailable`)
                return
              }
              serveAsset(req, res, filePath)
            },
          }),
        )
      }

      registerAsset(BOOT_ROUTE, 'boot')
      registerAsset(BACKGROUND_ROUTE, 'background')

      // 界面滑块的写回端点。
      //
      // 为什么不放 localStorage：桌面壳的页面来自 `dsh-app://` 自定义协议，那里能不能用
      // Web Storage 取决于该 scheme 有没有被注册成 standard/privileged —— 不确定的事不押注。
      // 写进 `$DSH_HOME/dsh-video-skin.json` 在哪个形态下都一样，而且用户能直接打开看/改。
      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: OVERRIDE_ROUTE,
          handler: (req, res) => {
            const method = String(req.method ?? 'GET').toUpperCase()
            /** @param {number} status @param {unknown} body */
            const reply = (status, body) => {
              const text = JSON.stringify(body)
              res.writeHead(status, {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(text),
                'Cache-Control': 'no-store',
              })
              res.end(text)
            }

            /** @param {Record<string, unknown>} patch @param {boolean} cleared */
            const finish = (patch, cleared) => {
              // 先写盘、再读配置：反过来的话响应里带回的是**写之前**的旧值，
              // 面板刚拖完就会显示成没生效。
              let persisted = true
              let file = ''
              try {
                const written =
                  cleared === true
                    ? clearOverride(homeDir ?? '')
                    : writeOverride({ homeDir: homeDir ?? '', patch })
                file = written.file
              } catch (error) {
                // 写不进去（只读 profile / 权限）不该让面板报错崩掉：设置本次会话仍然生效，
                // 只是下次刷新会回到文件里的值 —— 面板会把这件事说出来。
                persisted = false
                warn(`透明度设置写盘失败：${describe(error)}`)
              }
              try {
                const { client, warnings } = current()
                reply(200, { ok: persisted, persisted, file, warnings, config: client })
              } catch (error) {
                reply(500, { ok: false, persisted, file, error: describe(error) })
              }
            }

            if (method === 'DELETE') {
              try {
                finish({}, true)
              } catch (error) {
                reply(500, { ok: false, error: describe(error) })
              }
              return
            }

            if (method !== 'POST') {
              reply(405, { ok: false, error: 'use POST to save or DELETE to reset' })
              return
            }

            /** @type {Buffer[]} */
            const chunks = []
            let size = 0
            let aborted = false
            req.on('data', (chunk) => {
              if (aborted) return
              size += chunk.length
              if (size > OVERRIDE_BODY_LIMIT) {
                aborted = true
                reply(413, { ok: false, error: 'body too large' })
                req.destroy()
                return
              }
              chunks.push(chunk)
            })
            req.on('error', () => {
              if (!aborted) reply(400, { ok: false, error: 'request stream failed' })
            })
            req.on('end', () => {
              if (aborted) return
              let parsed
              try {
                parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              } catch (error) {
                reply(400, { ok: false, error: `invalid JSON: ${describe(error)}` })
                return
              }
              // 只认真实存在的数字，并且夹到合法区间 —— 这里收的是页面来的值，
              // 但一个会写文件的端点不该把校验外包给调用方。
              const source = isPlainObject(parsed?.background) ? parsed.background : parsed
              /** @type {Record<string, number>} */
              const patch = {}
              for (const key of OVERRIDE_KEYS) {
                const value = source?.[key]
                if (typeof value !== 'number' || !Number.isFinite(value)) continue
                patch[key] =
                  key === 'veil' || key === 'veilLight'
                    ? Math.min(0.92, Math.max(0, value))
                    : Math.min(1, Math.max(0, value))
              }
              if (Object.keys(patch).length === 0) {
                reply(400, { ok: false, error: `no numeric ${OVERRIDE_KEYS.join('/')} in body` })
                return
              }
              try {
                finish(patch, false)
              } catch (error) {
                reply(500, { ok: false, error: describe(error) })
              }
            })
          },
        }),
      )

      // 主题联动状态 / 撤销。
      //
      // GET  → { enabled, preference, switched, previous, notified }
      // POST → { action: 'notified' | 'revert' }
      //   notified：用户看过那条提示了，别再提；
      //   revert  ：把主题按标记里记的原值写回去（浅色用户点一下就能变回来）。
      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: THEME_ROUTE,
          handler: (req, res) => {
            /** @param {number} status @param {unknown} body */
            const reply = (status, body) => {
              const text = JSON.stringify(body)
              res.writeHead(status, {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(text),
                'Cache-Control': 'no-store',
              })
              res.end(text)
            }
            /**
             * 当前状态。**这里才读 settings** —— 启动期一次都不碰。
             *
             * `ask` 模式下"要不要问"也在这里判断：只有标记不存在、且当前是浅色时才问，
             * 问过/拒绝/切过之后标记落盘，永远不再问。
             */
            const state = () => {
              const marker = readThemeMarker(homeDir)
              const mode = current().client.theme?.mode ?? 'off'
              const service = settingsNow()
              const themeState =
                service !== null && typeof service.describe === 'function'
                  ? (() => {
                      try {
                        return pickThemeDescriptor(service.describe({ redactSecrets: true }))
                      } catch {
                        return null
                      }
                    })()
                  : null
              const decision = decideThemeLink({ mode, marker, preference: themeState?.preference })
              return {
                mode: mode,
                preference: themeState?.preference ?? null,
                // 只要还没评估过、且是浅色，就把"该问一句"告诉客户端。
                ask: decision.action === 'ask',
                askPrevious: decision.action === 'ask' ? decision.previous : null,
                evaluated: marker !== null,
                switched: marker?.switched === true,
                previous: isThemePreference(marker?.previous) ? marker.previous : null,
                notified: marker?.notified === true,
                writable: service !== null ? service.writable !== false : false,
              }
            }

            const method = String(req.method ?? 'GET').toUpperCase()
            if (method === 'GET') {
              // **`auto` 模式就在这一刻动手**：页面已经加载、主动来问，远在启动握手之后。
              // `ask` 模式只把 ask:true 告诉客户端，点了才写。
              const mode = current().client.theme?.mode ?? 'off'
              const marker = readThemeMarker(homeDir)
              const service = settingsNow()
              let preference
              if (service !== null && typeof service.describe === 'function') {
                try {
                  preference = pickThemeDescriptor(service.describe({ redactSecrets: true }))?.preference
                } catch {
                  preference = undefined
                }
              }
              const decision = decideThemeLink({ mode, marker, preference })
              if (decision.action === 'mark') {
                // 已经是深色：只落标记，免得用户以后切浅色时又被问/被改。
                writeThemeMarker(homeDir, { evaluated: true, switched: false, at: new Date().toISOString() })
                reply(200, { ok: true, ...state() })
                return
              }
              if (decision.action === 'switch') {
                void writeThemePreference('dark').then((ok) => {
                  if (ok) {
                    writeThemeMarker(homeDir, {
                      evaluated: true,
                      switched: true,
                      previous: decision.previous,
                      notified: false,
                      at: new Date().toISOString(),
                    })
                    info(`auto 模式：已把浅色（${decision.previous}）切到深色，让聊天背景看得清`)
                  }
                  reply(200, { ok: true, ...state() })
                })
                return
              }
              reply(200, { ok: true, ...state() })
              return
            }
            if (method !== 'POST') {
              reply(405, { ok: false, error: 'use GET or POST' })
              return
            }

            /** @type {Buffer[]} */
            const chunks = []
            let size = 0
            let aborted = false
            req.on('error', () => {
              aborted = true
              reply(400, { ok: false, error: 'request stream failed' })
            })
            req.on('data', (chunk) => {
              if (aborted) return
              size += chunk.length
              if (size > OVERRIDE_BODY_LIMIT) {
                aborted = true
                reply(413, { ok: false, error: 'body too large' })
                req.destroy()
                return
              }
              chunks.push(chunk)
            })
            req.on('end', () => {
              if (aborted) return
              /** @type {Record<string, unknown>} */
              let body = {}
              if (chunks.length > 0) {
                try {
                  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
                  body = isPlainObject(parsed) ? parsed : {}
                } catch {
                  reply(400, { ok: false, error: 'invalid JSON' })
                  return
                }
              }
              const action = typeof body.action === 'string' ? body.action : ''
              const marker = readThemeMarker(homeDir) ?? {}
              const stamp = new Date().toISOString()

              /** 把决定落盘，然后回报当前状态。 */
              const finish = (patch, notice) => {
                writeThemeMarker(homeDir, { ...marker, ...patch, at: stamp })
                if (typeof notice === 'string') info(notice)
                reply(200, { ok: true, ...state() })
              }

              // 用户点了「切到深色」。
              if (action === 'dark') {
                const previous = isThemePreference(marker.previous) ? marker.previous : 'light'
                void writeThemePreference('dark').then((ok) => {
                  if (!ok) {
                    reply(409, { ok: false, error: 'theme settings are not writable', ...state() })
                    return
                  }
                  finish(
                    { evaluated: true, switched: true, previous, notified: true },
                    `用户同意切到深色（原偏好 ${previous}）`,
                  )
                })
                return
              }

              // 用户点了「保持浅色」：永远不再问。
              if (action === 'keep') {
                finish({ evaluated: true, switched: false, notified: true }, '用户选择保持浅色，不再提示')
                return
              }

              if (action === 'notified') {
                finish({ ...marker, notified: true })
                return
              }

              if (action === 'revert') {
                const previous = isThemePreference(marker.previous) ? marker.previous : 'system'
                void writeThemePreference(previous).then((ok) => {
                  if (!ok) {
                    reply(409, { ok: false, error: 'theme settings are not writable', ...state() })
                    return
                  }
                  finish(
                    { ...marker, switched: false, notified: true, revertedAt: stamp },
                    `用户撤销了主题切换，已恢复为 ${previous}`,
                  )
                })
                return
              }

              reply(400, { ok: false, error: "action must be 'dark' | 'keep' | 'notified' | 'revert'" })
            })
          },
        }),
      )

      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* 已经注销 */
          }
        }
      }
    })
  })

  try {
    const { client, sources, warnings } = current()
    for (const warning of warnings) warn(warning)
    const parts = []
    parts.push(client.boot.enabled ? `开机动画 ${client.boot.src}` : '开机动画 关闭')
    parts.push(client.background.enabled ? `聊天背景 ${client.background.src}` : '聊天背景 关闭')
    info(
      `已就绪：${parts.join(' · ')}（配置来源：${sources.length === 0 ? '默认值' : sources.join(' → ')}）`,
    )
  } catch (error) {
    warn(`配置读取失败，将使用默认值：${describe(error)}`)
  }
}
