/**
 * 纯逻辑：HTTP 边界的辅助函数。
 *
 * 刻意不 import 任何 DSH 包——这些函数是唯一"值得单测"的部分（Range 解析、内容类型、
 * 路径逃逸防护、数值夹取），脱离宿主也能跑，所以测试不需要任何框架或桩。
 */
import path from 'node:path'

/** 解析后的字节闭区间。 */
/** @typedef {{ start: number, end: number }} ParsedRange */

/**
 * 解析 HTTP `Range` 头。
 *
 * 为什么必须实现：Chromium 的 `<video>` 会发 `Range: bytes=0-` 探路，seek 时发具体区间。
 * 不支持 Range 的服务器仍能播，但 seek/续播会退化；而"把 206 当成完整资源缓存起来"是
 * 一个真实的坑（见 index.js 里对 Cache-Control 的注释）。
 *
 * @param {string | undefined} header `Range` 头原文。
 * @param {number} size 资源总字节数。
 * @returns {ParsedRange | 'unsatisfiable' | null} 闭区间；`null` = 按整份返回；`'unsatisfiable'` = 416。
 */
export function parseRange(header, size) {
  if (header === undefined || header === null || header === '') return null
  if (typeof header !== 'string') return null
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim())
  if (match === null) return null
  const rawStart = match[1] ?? ''
  const rawEnd = match[2] ?? ''
  if (rawStart === '' && rawEnd === '') return null

  let start
  let end
  if (rawStart === '') {
    // 后缀区间：最后 N 字节。
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (!Number.isFinite(size) || size <= 0) return 'unsatisfiable'
  if (start > end || start >= size) return 'unsatisfiable'
  return { start, end: Math.min(end, size - 1) }
}

/** 扩展名 → MIME。 */
const CONTENT_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.json': 'application/json; charset=utf-8',
}

/**
 * 按扩展名给出 Content-Type；未知类型回落 `application/octet-stream`。
 * @param {string} fileName 文件名或路径。
 * @returns {string} MIME 类型。
 */
export function contentTypeFor(fileName) {
  return CONTENT_TYPES[path.extname(String(fileName)).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * 把包内相对路径解析成绝对路径，并**保证它没有逃出包目录**。
 *
 * 为什么必须做：素材文件名来自配置（profile 的 patch 层或用户 JSON）。如果直接
 * `path.join(root, file)`，一份写着 `../../../../.credentials.yaml` 的配置就能让插件
 * 把宿主的凭据文件当视频发出去。配置是可信的部署输入，但一个会读文件的插件不该给
 * 配置留这种口子。
 *
 * @param {string} packageRoot 包根目录的绝对路径。
 * @param {string} relativePath 包内相对路径。
 * @returns {string} 绝对路径。
 * @throws 当目标逃出包根目录时。
 */
export function resolveInsidePackage(packageRoot, relativePath) {
  const root = path.resolve(packageRoot)
  const target = path.resolve(root, String(relativePath))
  const relative = path.relative(root, target)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`asset path escapes the package directory: ${String(relativePath)}`)
  }
  return target
}

/**
 * 把一个可能是任意脏值的数字夹到 `[min, max]`。
 *
 * 语义刻意区分两件事：**不是数**（NaN / 非数字字符串 / undefined）用默认值，
 * 而 `±Infinity` 只是一个"太大/太小"的数，夹到边界即可 —— 用户写
 * `"fadeMs": 1e999` 时想要的是"尽量长"，不是"回到 1500"。
 * @param {unknown} value 候选值。
 * @param {number} fallback 不是数时用的默认值。
 * @param {number} min 下界。
 * @param {number} max 上界。
 * @returns {number} 夹取后的有限数。
 */
export function clampNumber(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value)
  if (Number.isNaN(n)) return fallback
  if (n < min) return min
  if (n > max) return max
  return n
}

/**
 * 将一个字符串安全地嵌进内联 `<script>` 文本的 JSON 字面量里。
 *
 * 两件事：
 *   - `<` 转义成 `\u003c`：否则配置里出现 `</script` 会提前闭合元素
 *     （`IndexInjection` 的 `script` 变体文档把这条写成了硬约束）；
 *   - U+2028 / U+2029 转义：它们在 JS 源码里是行终止符，会打断字面量。
 *
 * @param {unknown} value 任意可 JSON 序列化的值。
 * @returns {string} 可直接写进脚本文本的表达式。
 */
export function toInlineJson(value) {
  return JSON.stringify(value)
    .replace(/</gu, '\\u003c')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029')
}

/**
 * 深合并：只认普通对象，数组与标量整体替换。
 * @param {Record<string, unknown>} base 底稿。
 * @param {unknown} patch 覆盖值。
 * @returns {Record<string, unknown>} 新对象（不修改入参）。
 */
export function mergeDeep(base, patch) {
  if (!isPlainObject(patch)) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key]
    out[key] = isPlainObject(current) && isPlainObject(value) ? mergeDeep(current, value) : value
  }
  return out
}

/**
 * @param {unknown} value 候选值。
 * @returns {boolean} 是不是普通对象。
 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
