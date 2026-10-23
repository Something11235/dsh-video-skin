/**
 * 主题联动：把浅色主题的用户**一次性**切到深色，因为这条视频皮肤在浅色下会被
 * 白面纱+白蒙版冲得很淡（实测亮色表面要不透明度 0.6 才能保证正文可读，而视频也就
 * 几乎看不见了）。
 *
 * 三条设计约束，都是为了"别变成那种乱改用户设置的插件"：
 *
 * 1. **只做一次**。`~/.dsh/dsh-video-skin.theme.json` 是"已经评估过"的标记；
 *    有了它之后，用户自己再切回浅色也永远不会被我们改回去。
 * 2. **走官方写入口**：内核的 settings 服务（`ctx.settings.update('ui-theme', …)`），
 *    不手改 profile 的 YAML —— 那份文件是用户的，写坏了整个 profile 都起不来。
 * 3. **可撤销**：切完在界面里给一条一次性提示，点「恢复浅色」就按原值写回去
 *    （原来的 `light` / `system` 都记在标记里）。
 *
 * 这个模块只做纯逻辑和文件读写，不碰 ctx —— 好测。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 一次性标记文件（放在 DSH_HOME 根，和 dsh-video-skin.json 并列）。 */
export const THEME_MARKER_FILE = 'dsh-video-skin.theme.json'

/** 主题设置的命名空间 = profile patch 里那条 `- id: ui-theme`。 */
export const THEME_NAMESPACE = 'ui-theme'

/** 合法偏好。 */
export const THEME_PREFERENCES = Object.freeze(['light', 'dark', 'system'])

/**
 * 判断一个值是不是合法的主题偏好。
 * @param {unknown} value 待判断的值。
 * @returns {boolean} 是否合法。
 */
export function isThemePreference(value) {
  return typeof value === 'string' && THEME_PREFERENCES.includes(value)
}

/**
 * 读一次性标记。
 * @param {string} homeDir DSH_HOME。
 * @returns {{ evaluated?: boolean, switched?: boolean, previous?: string, notified?: boolean, appliedAt?: string } | null} 标记或 null。
 */
export function readThemeMarker(homeDir) {
  if (typeof homeDir !== 'string' || homeDir === '') return null
  try {
    const text = fs.readFileSync(path.join(homeDir, THEME_MARKER_FILE), 'utf8')
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 写一次性标记（UTF-8 无 BOM；坏掉不影响插件本体，所以吞掉异常）。
 * @param {string} homeDir DSH_HOME。
 * @param {Record<string, unknown>} data 要写的标记。
 * @returns {boolean} 是否写成功。
 */
export function writeThemeMarker(homeDir, data) {
  if (typeof homeDir !== 'string' || homeDir === '') return false
  try {
    fs.mkdirSync(homeDir, { recursive: true })
    fs.writeFileSync(path.join(homeDir, THEME_MARKER_FILE), `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 决定这次启动要不要把用户切到深色。
 *
 * 规则很简单，但每一条都是必需的：
 *   - 配置关掉了（`theme.autoDark: false`）→ 不动；
 *   - 已经评估过（标记存在）→ 不动 —— 这是"用户后来自己切回浅色"的唯一保护；
 *   - 读不到当前偏好 → 不动（宁可不做，也不要在不知道状态时乱写）；
 *   - 已经是 dark → 不动，但仍然落标记（否则用户下次切浅色又会被改）；
 *   - 其余（light / system）→ 切，并记下原值供撤销。
 *
 * @param {{ autoDark: boolean, marker: unknown, preference: unknown }} input 输入。
 * @returns {{ action: 'skip' | 'mark' | 'switch', previous?: 'light' | 'dark' | 'system', reason: string }} 决定。
 */
export function decideAutoDark(input) {
  const autoDark = input && input.autoDark !== false
  const marker = input === undefined || input === null ? null : input.marker
  const preference = input === undefined || input === null ? undefined : input.preference
  if (autoDark !== true) return { action: 'skip', reason: 'disabled' }
  if (marker !== null && marker !== undefined) return { action: 'skip', reason: 'already-evaluated' }
  if (!isThemePreference(preference)) return { action: 'skip', reason: 'unknown-preference' }
  if (preference === 'dark') return { action: 'mark', reason: 'already-dark' }
  return { action: 'switch', previous: /** @type {'light' | 'dark' | 'system'} */ (preference), reason: 'light-theme' }
}

/**
 * 从 settings 服务的 `describe()` 结果里挑出主题那条。
 * @param {unknown} descriptors describe() 的返回值。
 * @returns {{ preference?: unknown, revision?: number } | null} 主题描述符里我们关心的字段。
 */
export function pickThemeDescriptor(descriptors) {
  if (!Array.isArray(descriptors)) return null
  for (const entry of descriptors) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.ns !== THEME_NAMESPACE) continue
    const value = entry.value !== null && typeof entry.value === 'object' ? entry.value : {}
    return {
      preference: value.preference,
      revision: typeof entry.revision === 'number' ? entry.revision : undefined,
    }
  }
  return null
}

/**
 * 现在是不是浅色（给客户端的提示用）。
 * @param {boolean} hasDarkAttribute body 上有没有 data-ds-dark-theme。
 * @returns {'light' | 'dark'} 解析出的实际外观。
 */
export function resolveAppearance(hasDarkAttribute) {
  return hasDarkAttribute === true ? 'dark' : 'light'
}
