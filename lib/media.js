/**
 * 素材替换：让用户在界面里换掉/关掉开机动画与聊天背景。
 *
 * 设计取舍：
 *
 * 1. **上传而不是填路径**。普通用户不会知道"包内相对路径"是什么，所以界面给一个选文件的按钮，
 *    文件由宿主接收后落到 `$DSH_HOME/dsh-video-skin-media/`，配置里写成绝对路径。
 *    想用不着上传的人（比如素材就在本地盘上），配置里的 `file` 也支持绝对路径 —— 见 config.js。
 *
 * 2. **文件名带内容哈希**。同一个槽位换素材时，浏览器/宿主都可能缓存旧 URL；用内容哈希做文件名，
 *    URL 天然变化，不会出现"换了文件但画面没变"。
 *
 * 3. **只接受浏览器真的能播的容器**。mp4 / webm / ogv 之外的文件解不出来，接进来只会让用户
 *    面对一块黑屏 —— 宁可当场拒掉并告诉他原因。
 *
 * 这个模块只做纯逻辑（路径、扩展名、状态整理），不碰 ctx、不碰网络 —— 好测。
 */
import path from 'node:path'

/** 上传素材落在 DSH_HOME 下的目录名。 */
export const MEDIA_DIR_NAME = 'dsh-video-skin-media'

/** 两个槽位。 */
export const MEDIA_SLOTS = Object.freeze(['boot', 'background'])

/** 单个文件的上限（字节）。够放 4K 短片，又不至于让一次误选把磁盘写满。 */
export const MEDIA_LIMIT_BYTES = 96 * 1024 * 1024

/** 浏览器能直接播的容器 → 统一扩展名。 */
const EXT_BY_TYPE = Object.freeze({
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/ogg': '.ogv',
  'video/ogv': '.ogv',
})

/** 允许的扩展名（用户可能上传没有 MIME 的文件，靠扩展名兜底）。 */
const ALLOWED_EXT = Object.freeze(['.mp4', '.webm', '.ogv'])

/**
 * 槽位名是否合法。
 * @param {unknown} value 待判断的值。
 * @returns {boolean} 是否合法。
 */
export function isMediaSlot(value) {
  return typeof value === 'string' && MEDIA_SLOTS.includes(value)
}

/**
 * 素材目录。
 * @param {string} homeDir DSH_HOME。
 * @returns {string} 绝对路径（不保证存在）。
 */
export function mediaRoot(homeDir) {
  return path.join(homeDir, MEDIA_DIR_NAME)
}

/**
 * 从文件名 + MIME 推出能用的扩展名。
 *
 * 先看 MIME（浏览器给的最准），再看扩展名兜底（有些系统上 file.type 是空串）。
 * @param {string} filename 原始文件名。
 * @param {string} contentType 请求头里的 Content-Type。
 * @returns {string | undefined} `.mp4` / `.webm` / `.ogv`，都认不出来就是 undefined。
 */
export function pickExtension(filename, contentType) {
  const type = typeof contentType === 'string' ? contentType.split(';')[0].trim().toLowerCase() : ''
  if (EXT_BY_TYPE[type] !== undefined) return EXT_BY_TYPE[type]
  const ext = path.extname(typeof filename === 'string' ? filename : '').toLowerCase()
  return ALLOWED_EXT.includes(ext) ? ext : undefined
}

/**
 * 算上传落盘的目标路径。
 *
 * 文件名里带内容哈希，换素材时 URL 一定变（否则浏览器会拿缓存的旧视频）。
 * @param {{ homeDir: string, slot: 'boot' | 'background', extension: string, digest: string }} input 输入。
 * @returns {string} 绝对路径。
 */
export function mediaTargetPath(input) {
  const digest = String(input.digest).replace(/[^a-f0-9]/giu, '').slice(0, 12) || 'unnamed'
  return path.join(mediaRoot(input.homeDir), `${input.slot}-${digest}${input.extension}`)
}

/**
 * 把"当前生效的素材状态"整理成界面要的样子。
 *
 * @param {{ defaults: Record<string, unknown>, boot: Record<string, unknown>, background: Record<string, unknown> }} input 输入。
 * @returns {{ boot: { enabled: boolean, custom: boolean, name: string }, background: { enabled: boolean, custom: boolean, name: string } }} 状态。
 */
export function describeMedia(input) {
  const section = (raw, defaults) => {
    const declared = typeof raw.file === 'string' && raw.file !== '' ? raw.file : defaults.file
    const isCustom = declared !== defaults.file
    const base = typeof declared === 'string' ? path.basename(declared) : ''
    return {
      enabled: raw.enabled !== false,
      custom: isCustom,
      name: isCustom ? base : '默认素材',
    }
  }
  return {
    boot: section(input.boot ?? {}, input.defaults.boot ?? {}),
    background: section(input.background ?? {}, input.defaults.background ?? {}),
  }
}
