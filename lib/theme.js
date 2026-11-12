/**
 * 主题联动：建议/自动把用户切到深色，因为这条视频皮肤在浅色下会被白面纱冲得很淡。
 *
 * ## 三条硬约束（都是踩过坑之后加的）
 *
 * 1. **启动期绝不动 settings。** 0.1.3 在插件激活过程中调 `ctx.settings.update()`，
 *    而 `update()` 会走 `configEditor.edit()` 改写 profile patch 文档、并在里面同步
 *    `describe()`。桌面版的启动握手是「欢迎窗口发出第一个 RPC（`settings.describe`），
 *    非 2xx 就直接判启动失败、不重试」（`app.asar/lib/main.js` 8903/13018 行），
 *    于是那条写在启动期一抖，用户的应用就再也起不来。
 *    现在**所有** settings 读写都挪到「页面已经加载、主动来问」之后（见 index.js 的路由），
 *    启动期零交互。
 *
 * 2. **默认不自己改**：`mode: 'ask'` —— 只告诉用户"切深色更好看"，点了才写。
 *    `'auto'` 才是自动（同样在页面加载后才动手）；`'off'` 完全关闭。
 *
 * 3. **只打扰一次**：`$DSH_HOME/dsh-video-skin.theme.json` 记"已评估"。用户拒绝、
 *    撤销或自己切回去之后，永远不会再被问/被改。
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

/** 三种联动模式。 */
export const THEME_MODES = Object.freeze(['ask', 'auto', 'off'])

/**
 * 判断一个值是不是合法的主题偏好。
 * @param {unknown} value 待判断的值。
 * @returns {boolean} 是否合法。
 */
export function isThemePreference(value) {
  return typeof value === 'string' && THEME_PREFERENCES.includes(value)
}

/**
 * 把配置里的 `theme` 段归一成一种模式。
 *
 * 兼容 0.1.3 的旧键 `theme.autoDark`（布尔）：`false` → off、`true` → auto。
 * @param {unknown} raw `theme` 段（可能是 undefined / 脏值）。
 * @returns {'ask' | 'auto' | 'off'} 模式。
 */
export function resolveThemeMode(raw) {
  const section = raw !== null && typeof raw === 'object' ? raw : {}
  const mode = section.mode
  if (mode === 'auto' || mode === 'ask' || mode === 'off') return mode
  if (section.autoDark === false) return 'off'
  if (section.autoDark === true) return 'auto'
  // 默认只"问一句"，不自己改 —— 这是 0.1.4 特意选的默认值。
  return 'ask'
}

/**
 * 读一次性标记。
 * @param {string} homeDir DSH_HOME。
 * @returns {{ evaluated?: boolean, switched?: boolean, previous?: string, notified?: boolean, at?: string } | null} 标记或 null。
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
 * 写一次性标记（UTF-8；坏掉不影响插件本体，所以吞掉异常）。
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
 * 决定这次页面加载要做什么（**只在页面主动来问的时候调用**，启动期不调）。
 *
 * @param {{ mode: 'ask' | 'auto' | 'off', marker: unknown, preference: unknown }} input 输入。
 * @returns {{ action: 'skip' | 'mark' | 'ask' | 'switch', previous?: string, reason: string }} 决定。
 */
export function decideThemeLink(input) {
  const mode = input === undefined || input === null ? 'off' : input.mode ?? 'off'
  const marker = input === undefined || input === null ? null : input.marker
  const preference = input === undefined || input === null ? undefined : input.preference
  if (mode === 'off') return { action: 'skip', reason: 'mode-off' }
  // 已经评估过（问过/切过/撤销过）→ 永远不再打扰。这是用户自己切回浅色的保护。
  if (marker !== null && marker !== undefined) return { action: 'skip', reason: 'already-evaluated' }
  // 读不到偏好就什么都不做：宁可不做，也不要在不知道状态时乱写。
  if (!isThemePreference(preference)) return { action: 'skip', reason: 'unknown-preference' }
  // 已经是深色：只落标记，免得用户以后切浅色时又被问/被改。
  if (preference === 'dark') return { action: 'mark', reason: 'already-dark' }
  return { action: mode === 'auto' ? 'switch' : 'ask', previous: String(preference), reason: 'light-theme' }
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
