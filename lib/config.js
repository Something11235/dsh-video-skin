/**
 * 配置：默认值 → 可选的 JSON 文件覆盖 → 校验/夹取/路径解析。
 *
 * 为什么不走 `Config`（schemastery）那条路：
 *   ① 本插件不需要"设置 → 插件"里的卡片来成立；
 *   ② 0.2.0-rc.2 里 `Config` 必须是**模块命名空间对象上的静态属性**，也就是必须
 *      `import z from '@deepseek-ai/schemastery'`。那个 import 解析不到时**整个模块
 *      都求值不了** —— 宿主半边直接 FAILED。为了一个可选 UI 承担"插件全灭"的风险
 *      不划算，所以这里用零依赖的普通对象 + 显式校验，产物里一个 import 都没有。
 *   ③ 顺手换来的好处：改配置只要写一个 JSON 文件并刷新页面，不必进设置页，
 *      也不必重建产物。
 */
import fs from 'node:fs'
import path from 'node:path'

import { clampNumber, isPlainObject, mergeDeep, resolveInsidePackage } from './route.js'

/** 所有可调项的默认值。默认状态"装上就先无害"。 */
export const DEFAULT_CONFIG = Object.freeze({
  boot: Object.freeze({
    /** 是否显示开机动画。关掉 = 完全不注入那一行覆盖层。 */
    enabled: true,
    /** 片子在包内的相对路径。 */
    file: 'assets/boot.mp4',
    /**
     * 淡出时长（毫秒）。**这是一个固定时长，不是"溶解窗口"** —— 见 `exitMode`。
     *
     * 早先的实现是"从剩余 ≤ fadeMs 开始淡，淡出时长 = 当时的真实剩余时间"，有两个毛病：
     *   ① 界面就绪得晚（比如片子放到 7.9/8.06 秒）时，剩余只有 100~200ms，
     *      那次淡出看起来就是**硬切** —— 用户报的"有时候还没放完就切掉了"就是它；
     *   ② 交叉溶解盖住片子最后 fadeMs，永远看不到真正的片尾。
     * 现在：**片子先完整放完**，再用这个固定时长淡出。
     */
    fadeMs: 1000,
    /**
     * 退场方式：
     *   `end`  —— 片子放完（`ended`）后再淡出。**默认**：动画一定看全。
     *   `tail` —— 片尾交叉溶解：从"剩余 ≤ fadeMs"开始淡；淡出时长仍是固定的 fadeMs，
     *             所以不会退化成硬切，但片子最后 fadeMs 会盖在溶解里。
     */
    exitMode: 'end',
    /** 点击/按键跳过时的淡出时长。要短——用户已经决定不等了。 */
    skipFadeMs: 320,
    /**
     * 内核迟迟不就绪时的上界（毫秒）。到点**不再当场切掉**：只是把状态转成
     * "启动较慢"，并且如果片子还在放就让它放完；真正的硬上界是 `holdMs + holdGraceMs`。
     */
    holdMs: 18000,
    /** `holdMs` 到点之后还给片子的宽限（毫秒）—— 免得超时正好把动画截在中间。 */
    holdGraceMs: 4000,
    /**
     * 片子开始播但一帧都出不来，多久之后判定它坏了（毫秒）。
     * 给得宽一点：宿主刚启动时正忙着激活插件，素材路由偶尔应答得慢。
     */
    noFrameMs: 12000,
    /** 时长未知（duration = Infinity）时的唯一上界，否则永远等不到 ended。 */
    endlessMs: 20000,
    /** 覆盖层底部那行**状态**文字；「点击画面跳过」的提醒是右下角常驻胶囊，不在这里。 */
    hint: '正在启动…',
    /** 右下角常驻胶囊的文案。 */
    skipLabel: '点击画面跳过',
    /**
     * 是否尝试**带声音**播放。
     *
     * 桌面版（Electron）没有设置 `webPreferences.autoplayPolicy`，于是用 Electron 的默认值
     * `no-user-gesture-required` —— 未静音的 `play()` 直接就能成功，开机动画一起就是有声的。
     * 普通浏览器（`dsh web`）默认是 `document-user-activation-required`，未静音会被拒绝；
     * 那时运行时**自动退回静音继续播**（不扣住用户），并多出一个**独立**的声音按钮
     * —— 点它只开声音、不跳过，两个意图不互相踩。
     */
    sound: true,
    /** 音量 0..1。 */
    volume: 1,
    /** 声音被浏览器拦下时，那个独立开关的文案。 */
    soundLabel: '开启声音',
  }),
  background: Object.freeze({
    /** 是否显示聊天背景。 */
    enabled: true,
    /**
     * 背景**类型**：`video` = 循环短片（默认），`image` = 静态图。
     *
     * 两条背景走**同一套**蒙版 + 表面 + 对比度读数，所以切换只是换层里那个元素，
     * 已经调好的数字不用重调 —— 静态图默认就是从那部短片里抽的一帧（见 README §8），
     * 连"整体偏暗（YAVG≈0.25）"这个前提都一样。
     */
    mode: 'video',
    /** 片子在包内的相对路径（`mode: 'video'` 时用它）。 */
    file: 'assets/background.mp4',
    /** 静态图在包内的相对路径（`mode: 'image'` 时用它）。 */
    image: 'assets/background.jpg',
    /** 视频上的蒙版不透明度。越大越易读、画面越弱。 */
    veil: 0.14,
    /**
     * 界面表面（`--dsw-alias-*` 别名层）的不透明度，**暗色主题**用这个。
     * 越大越易读、视频越弱；0 等于表面全透明（画面最强），1 等于原生不透明（看不见视频）。
     */
    surface: 0.2,
    /**
     * 亮色主题的表面不透明度。默认 = `surface + 0.4`。
     *
     * 为什么亮色必须更高：文字在暗主题是浅色、在亮主题是深色，而视频素材整体偏暗
     * （实测 YAVG≈0.25）。同样薄的白色表面放在亮主题上，有效底色会变成中灰，
     * 深色文字的对比度立刻掉到 3:1 以下。用一个值调不出两边都能读。
     */
    surfaceLight: 0.6,
    /**
     * 亮色主题的蒙版不透明度。默认 = `veil × 0.7`（亮主题靠更实的白面兜可读性，
     * 不需要再压一层厚白雾）。
     */
    veilLight: 0.1,
    /**
     * 是否显示右下角的**透明度调节**控件（一个小圆钮，点开是滑块面板）。
     * 关掉之后就只能改 JSON 文件；想留滑块但嫌圆钮碍事，也可以把面板打开后不管它。
     */
    controls: true,
    /** 界面就绪后多久才开始加载背景视频（毫秒）；把开机阶段的带宽留给界面。 */
    delayMs: 1200,
    /** 播放速度倍率。 */
    playbackRate: 1,
  }),
})

/** 用户覆盖文件：包内一份（部署期），DSH_HOME 一份（使用期，优先级更高）。 */
export const PACKAGE_CONFIG_FILE = 'video-skin.config.json'
/** 用户覆盖文件（DSH_HOME 下）。 */
export const HOME_CONFIG_FILE = 'dsh-video-skin.json'

/**
 * 界面上的滑块**允许**写进用户配置文件的键。
 *
 * 只放透明度的四个：`surface` / `surfaceLight` / `veil` / `veilLight`。
 * 开机动画的时长和文案不在里面 —— 它们是启动快照，滑块改不动，写进去只会让人困惑。
 */
export const OVERRIDE_KEYS = Object.freeze(['surface', 'surfaceLight', 'veil', 'veilLight'])

/**
 * 界面上的背景类型开关**允许**写进用户配置文件的键。
 *
 * 它是唯一的**字符串**覆盖项（其余四个都是数字），所以和 `OVERRIDE_KEYS` 分开列：
 * 那个常量同时被 `index.js` 用来做数值夹取，混进一个字符串会让"夹到 0..1"失去意义。
 */
export const OVERRIDE_MODE_KEY = 'mode'

/** 两种背景类型。顺序就是面板上从左到右的顺序。 */
export const BACKGROUND_MODES = Object.freeze(['video', 'image'])

/**
 * 背景类型是否合法。
 *
 * 只认这两个字面量：配置来自文件（用户能随手改），而 `mode` 会决定加哪个元素、
 * 读哪个素材 —— 一个会读文件的插件不该让配置里塞进任意字符串。
 * @param {unknown} value 候选值。
 * @returns {boolean} 是不是合法的背景类型。
 */
export function isBackgroundMode(value) {
  return typeof value === 'string' && BACKGROUND_MODES.includes(value)
}

/**
 * 把脏值归一成背景类型；不认识的一律退回 `video`（装上先按老样子跑）。
 * @param {unknown} value 候选值。
 * @param {'video' | 'image'} [fallback] 不认识时用的值。
 * @returns {'video' | 'image'} 归一后的类型。
 */
export function normalizeMode(value, fallback = 'video') {
  if (isBackgroundMode(value)) return value
  return isBackgroundMode(fallback) ? fallback : 'video'
}

/**
 * 读出用户覆盖文件里"界面控件可写"的那几项（用于把面板的初始状态摆对）。
 * @param {string} homeDir DSH_HOME。
 * @returns {Record<string, number | string>} 已存在的可用项（四个数字 + 可选的 `mode`）。
 */
export function readOverride(homeDir) {
  if (typeof homeDir !== 'string' || homeDir === '') return {}
  const raw = readJsonFile(path.join(homeDir, HOME_CONFIG_FILE))
  const background = isPlainObject(raw?.background) ? raw.background : {}
  /** @type {Record<string, number | string>} */
  const out = {}
  for (const key of OVERRIDE_KEYS) {
    if (typeof background[key] === 'number' && Number.isFinite(background[key])) out[key] = background[key]
  }
  if (isBackgroundMode(background[OVERRIDE_MODE_KEY])) out[OVERRIDE_MODE_KEY] = background[OVERRIDE_MODE_KEY]
  return out
}

/**
 * 把界面控件的值写进用户覆盖文件（**合并**，不动文件里其它键与其它段）。
 *
 * 收两类值：四个透明度数字，以及背景类型那个字符串（见 `OVERRIDE_MODE_KEY`）。
 * 不认识的键一律丢掉 —— 写盘这件事只认白名单，免得面板的将来版本往用户文件里塞东西。
 *
 * 为什么走文件而不是 localStorage：桌面壳的页面来自 `dsh-app://` 自定义协议，存储可用性
 * 依赖那个 scheme 是否被注册成 privileged；而写文件这条路在哪个形态下都一样，而且用户
 * 能直接打开那个 JSON 看/改 —— 一个"看得见的设置"比一个藏在浏览器存储里的值好排查。
 *
 * @param {{ homeDir: string, patch: Record<string, unknown> }} input DSH_HOME 与要写的项。
 * @returns {{ file: string, raw: Record<string, unknown> }} 写入的文件与合并后的原始配置。
 */
export function writeOverride(input) {
  const file = path.join(input.homeDir, HOME_CONFIG_FILE)
  const current = readJsonFile(file) ?? {}
  /** @type {Record<string, unknown>} */
  const background = isPlainObject(current.background) ? { ...current.background } : {}
  for (const key of OVERRIDE_KEYS) {
    const value = input.patch[key]
    if (typeof value === 'number' && Number.isFinite(value)) background[key] = value
  }
  if (isBackgroundMode(input.patch[OVERRIDE_MODE_KEY])) {
    background[OVERRIDE_MODE_KEY] = input.patch[OVERRIDE_MODE_KEY]
  }
  const next = { ...current, background }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return { file, raw: next }
}

/**
 * 清掉用户覆盖文件里"界面控件可写"的那几项（其余内容原样保留），等于恢复默认。
 *
 * 背景类型也在里面：**"恢复默认"要恢复的是整块背景**，只退回透明度、把类型留在
 * 用户选的静态图上，那叫恢复一半。
 * @param {string} homeDir DSH_HOME。
 * @returns {{ file: string, raw: Record<string, unknown> }} 写入的文件与合并后的原始配置。
 */
export function clearOverride(homeDir) {
  const file = path.join(homeDir, HOME_CONFIG_FILE)
  const current = readJsonFile(file) ?? {}
  /** @type {Record<string, unknown>} */
  const background = isPlainObject(current.background) ? { ...current.background } : {}
  for (const key of OVERRIDE_KEYS) delete background[key]
  delete background[OVERRIDE_MODE_KEY]
  const next = { ...current }
  if (Object.keys(background).length === 0) delete next.background
  else next.background = background
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return { file, raw: next }
}

/**
 * DSH_HOME 的位置。宿主进程通常已经带着 `DSH_HOME`，没有时退回 `~/.dsh`。
 * @param {NodeJS.ProcessEnv} [env] 环境变量表。
 * @param {() => string} [homedir] home 目录提供者。
 * @returns {string | undefined} DSH_HOME 的绝对路径。
 */
export function resolveDshHome(env = process.env, homedir) {
  const fromEnv = env && typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '' ? env.DSH_HOME : undefined
  if (fromEnv !== undefined) return path.resolve(fromEnv)
  try {
    const home = typeof homedir === 'function' ? homedir() : undefined
    return home === undefined ? undefined : path.join(home, '.dsh')
  } catch {
    return undefined
  }
}

/**
 * 读一个 JSON 文件；不存在/坏了都返回 `undefined` 而不是抛。
 * @param {string} file 绝对路径。
 * @returns {Record<string, unknown> | undefined} 解析出的对象。
 */
export function readJsonFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(text)
    return isPlainObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 按优先级合并配置文件。
 * @param {{ packageRoot: string, homeDir?: string }} options 位置。
 * @returns {{ config: Record<string, unknown>, sources: string[] }} 原始合并结果与命中的文件。
 */
export function loadRawConfig(options) {
  const sources = []
  let raw = /** @type {Record<string, unknown>} */ ({})
  const candidates = [path.join(options.packageRoot, PACKAGE_CONFIG_FILE)]
  if (typeof options.homeDir === 'string' && options.homeDir !== '') {
    candidates.push(path.join(options.homeDir, HOME_CONFIG_FILE))
  }
  for (const file of candidates) {
    const parsed = readJsonFile(file)
    if (parsed === undefined) continue
    sources.push(file)
    raw = mergeDeep(raw, parsed)
  }
  return { config: raw, sources }
}

/**
 * 把原始配置解析成运行时配置。
 *
 * 这里同时承担三件事：合并默认值、把每个数字夹进合理区间、把素材路径解析成绝对路径
 * 并做逃逸防护。任何一项坏了都只降级那一项（返回 warnings），绝不让宿主半边抛异常。
 *
 * @param {Record<string, unknown> } raw 原始（可能来自 JSON 文件）配置。
 * @param {{ packageRoot: string, routes: { boot: string, background: string, image: string, config: string, override: string }, version: string }} options 运行期位置。
 * @returns {{ client: Record<string, unknown>, paths: { boot?: string, background?: string, image?: string }, warnings: string[] }} 解析结果。
 */
export function resolveConfig(raw, options) {
  const warnings = []
  const bootRaw = isPlainObject(raw.boot) ? raw.boot : {}
  const bgRaw = isPlainObject(raw.background) ? raw.background : {}
  const files = {}

  /**
   * 解析一份素材：路径逃逸/不存在都只让这一个功能降级。
   * @param {'boot' | 'background' | 'image'} storeKey 落地路径在 `paths` 里的键名。
   * @param {string} confPath 配置文件里的路径（只用于警告文案，例如 `background.image`）。
   * @param {string} field 该素材在配置段里的键名（`file` 或 `image`）。
   * @param {Record<string, unknown>} section 该功能的原始配置。
   * @param {Record<string, unknown>} defaults 该功能的默认值。
   * @param {string} route 该素材的路由地址。
   * @returns {string | undefined} 路由地址；素材不可用时是 `undefined`。
   */
  const resolveAsset = (storeKey, confPath, field, section, defaults, route) => {
    const relative = typeof section[field] === 'string' && section[field] !== '' ? section[field] : defaults[field]
    let absolute
    try {
      absolute = resolveInsidePackage(options.packageRoot, relative)
    } catch (error) {
      warnings.push(`${confPath}: ${error.message}`)
      return undefined
    }
    try {
      const stat = fs.statSync(absolute)
      if (!stat.isFile() || stat.size <= 0) {
        warnings.push(`${confPath}: not a non-empty file (${relative})`)
        return undefined
      }
    } catch {
      warnings.push(`${confPath}: missing on disk (${relative})`)
      return undefined
    }
    files[storeKey] = absolute
    return route
  }

  const bootSrc = resolveAsset('boot', 'boot.file', 'file', bootRaw, DEFAULT_CONFIG.boot, options.routes.boot)
  const backgroundSrc = resolveAsset(
    'background',
    'background.file',
    'file',
    bgRaw,
    DEFAULT_CONFIG.background,
    options.routes.background,
  )
  const imageSrc = resolveAsset(
    'image',
    'background.image',
    'image',
    bgRaw,
    DEFAULT_CONFIG.background,
    options.routes.image,
  )

  /**
   * 背景类型只在**素材真的在盘上**时才算数。
   *
   * 配了 `mode: 'image'` 但图不在（换了素材忘了转、路径写错）时退回短片，而不是让用户
   * 看到一块什么都没有的背景 —— "静默降级到能用"比"忠实执行一个坏配置"体面。反过来
   * 不成立：短片没了就是背景整体降级（下面的 `enabled`），不偷偷换成图。
   */
  let mode = normalizeMode(bgRaw.mode, DEFAULT_CONFIG.background.mode)
  if (mode === 'image' && (imageSrc === undefined || imageSrc === '')) {
    warnings.push(`background.mode: image 素材不可用，退回 video（${JSON.stringify(bgRaw.image ?? DEFAULT_CONFIG.background.image)}）`)
    mode = 'video'
  }

  const usedSrc = mode === 'image' ? imageSrc : backgroundSrc
  const bootEnabled = bootRaw.enabled !== false && bootSrc !== undefined
  const backgroundEnabled = bgRaw.enabled !== false && usedSrc !== undefined && usedSrc !== ''

  const client = {
    version: options.version,
    config: options.routes.config,
    override: options.routes.override,
    boot: {
      enabled: bootEnabled,
      src: bootSrc ?? '',
      fadeMs: clampNumber(bootRaw.fadeMs, DEFAULT_CONFIG.boot.fadeMs, 200, 6000),
      exitMode: bootRaw.exitMode === 'tail' ? 'tail' : 'end',
      skipFadeMs: clampNumber(bootRaw.skipFadeMs, DEFAULT_CONFIG.boot.skipFadeMs, 80, 2000),
      holdMs: clampNumber(bootRaw.holdMs, DEFAULT_CONFIG.boot.holdMs, 4000, 120000),
      holdGraceMs: clampNumber(bootRaw.holdGraceMs, DEFAULT_CONFIG.boot.holdGraceMs, 0, 30000),
      noFrameMs: clampNumber(bootRaw.noFrameMs, DEFAULT_CONFIG.boot.noFrameMs, 1500, 30000),
      endlessMs: clampNumber(bootRaw.endlessMs, DEFAULT_CONFIG.boot.endlessMs, 5000, 60000),
      hint: typeof bootRaw.hint === 'string' && bootRaw.hint !== '' ? bootRaw.hint : DEFAULT_CONFIG.boot.hint,
      skipLabel:
        typeof bootRaw.skipLabel === 'string' && bootRaw.skipLabel !== ''
          ? bootRaw.skipLabel
          : DEFAULT_CONFIG.boot.skipLabel,
      sound: bootRaw.sound !== false,
      volume: clampNumber(bootRaw.volume, DEFAULT_CONFIG.boot.volume, 0, 1),
      soundLabel:
        typeof bootRaw.soundLabel === 'string' && bootRaw.soundLabel !== ''
          ? bootRaw.soundLabel
          : DEFAULT_CONFIG.boot.soundLabel,
    },
    background: {
      enabled: backgroundEnabled,
      /** `video` = 循环短片，`image` = 静态图。 */
      mode,
      /** 短片地址（**始终**给出，哪怕当前是静态图：面板要能切回去）。 */
      src: backgroundSrc ?? '',
      /** 静态图地址；不可用时是空串，面板据此不显示切换开关。 */
      imageSrc: imageSrc ?? '',
      veil: clampNumber(bgRaw.veil, DEFAULT_CONFIG.background.veil, 0, 0.92),
      surface: clampNumber(bgRaw.surface, DEFAULT_CONFIG.background.surface, 0, 1),
      surfaceLight: clampNumber(
        bgRaw.surfaceLight,
        Math.min(
          1,
          clampNumber(bgRaw.surface, DEFAULT_CONFIG.background.surface, 0, 1) + 0.4,
        ),
        0,
        1,
      ),
      veilLight: clampNumber(
        bgRaw.veilLight,
        clampNumber(bgRaw.veil, DEFAULT_CONFIG.background.veil, 0, 0.92) * 0.7,
        0,
        0.92,
      ),
      delayMs: clampNumber(bgRaw.delayMs, DEFAULT_CONFIG.background.delayMs, 0, 60000),
      playbackRate: clampNumber(bgRaw.playbackRate, DEFAULT_CONFIG.background.playbackRate, 0.25, 4),
      controls: bgRaw.controls !== false,
    },
  }

  return { client, paths: files, warnings }
}

/**
 * 端到端：读文件 → 合并 → 解析。每次索引渲染/配置请求都会调用（很便宜），
 * 所以改完 JSON 刷新页面即生效。
 * @param {{ packageRoot: string, routes: { boot: string, background: string, image: string, config: string, override: string }, version: string, homeDir?: string }} options 位置。
 * @returns {{ client: Record<string, unknown>, paths: { boot?: string, background?: string, image?: string }, warnings: string[], sources: string[] }} 结果。
 */
export function loadConfig(options) {
  const { config, sources } = loadRawConfig({ packageRoot: options.packageRoot, homeDir: options.homeDir })
  const resolved = resolveConfig(config, options)
  return { client: resolved.client, paths: resolved.paths, warnings: resolved.warnings, sources }
}
