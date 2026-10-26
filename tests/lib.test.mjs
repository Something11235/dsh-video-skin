/**
 * 纯逻辑测试：Range 解析、内容类型、路径防护、数值夹取、内联 JSON 转义、
 * 配置合并/解析、注入行组装。
 *
 * 这些是整个插件里唯一"不需要宿主、不需要浏览器"的部分，所以它们必须被钉死。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  clampNumber,
  contentTypeFor,
  isPlainObject,
  mergeDeep,
  parseRange,
  resolveInsidePackage,
  toInlineJson,
} from '../lib/route.js'
import {
  DEFAULT_CONFIG,
  HOME_CONFIG_FILE,
  OVERRIDE_KEYS,
  PACKAGE_CONFIG_FILE,
  clearOverride,
  loadRawConfig,
  readOverride,
  resolveConfig,
  resolveDshHome,
  writeOverride,
} from '../lib/config.js'
import {
  THEME_MARKER_FILE,
  decideThemeLink,
  isThemePreference,
  pickThemeDescriptor,
  readThemeMarker,
  resolveThemeMode,
  writeThemeMarker,
} from '../lib/theme.js'
import { BOOTSTRAP_GLOBAL, buildInjectionRows } from '../lib/injections.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..')
const ROUTES = {
  boot: '/dsh-video-skin/boot.mp4',
  background: '/dsh-video-skin/background.mp4',
  config: '/dsh-video-skin/config.json',
  override: '/dsh-video-skin/override',
}
const resolve = (raw) => resolveConfig(raw, { packageRoot, routes: ROUTES, version: 'test' })

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-video-skin-'))
}

// ────────────────────────────── Range ──────────────────────────────

test('parseRange：闭区间、后缀区间、开区间、非法与 416', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 })
  assert.deepEqual(parseRange('bytes=100-', 1000), { start: 100, end: 999 })
  assert.deepEqual(parseRange('bytes=0-', 1000), { start: 0, end: 999 })
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 })
  assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 }, '后缀比资源还大时从头开始')
  assert.deepEqual(parseRange('bytes=900-2000', 1000), { start: 900, end: 999 }, '尾部越界夹到 size-1')
  assert.equal(parseRange(undefined, 1000), null, '没有 Range 头 = 整份返回')
  assert.equal(parseRange('', 1000), null)
  assert.equal(parseRange('items=0-9', 1000), null, '不认识的单位当作没有 Range')
  assert.equal(parseRange('bytes=abc-def', 1000), null)
  assert.equal(parseRange('bytes=-0', 1000), 'unsatisfiable')
  assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable', '起点越界 = 416')
  assert.equal(parseRange('bytes=5-2', 1000), 'unsatisfiable')
  assert.equal(parseRange('bytes=0-10', 0), 'unsatisfiable', '空资源无法满足任何区间')
})

test('contentTypeFor 按扩展名给类型，未知回落 octet-stream', () => {
  assert.equal(contentTypeFor('a/b/boot.mp4'), 'video/mp4')
  assert.equal(contentTypeFor('x.WEBM'), 'video/webm')
  assert.equal(contentTypeFor('config.json'), 'application/json; charset=utf-8')
  assert.equal(contentTypeFor('weird.bin'), 'application/octet-stream')
})

test('resolveInsidePackage 拒绝逃出包目录', () => {
  const root = path.resolve('/srv/pkg')
  assert.equal(resolveInsidePackage(root, 'assets/boot.mp4'), path.resolve('/srv/pkg/assets/boot.mp4'))
  assert.throws(() => resolveInsidePackage(root, '../../secrets.yaml'), /escapes/u)
  assert.throws(() => resolveInsidePackage(root, 'a/../../../etc/passwd'), /escapes/u)
})

test('clampNumber 把脏值夹到区间，非有限数用默认值', () => {
  assert.equal(clampNumber(3, 1, 0, 10), 3)
  assert.equal(clampNumber(99, 1, 0, 10), 10)
  assert.equal(clampNumber(-5, 1, 0, 10), 0)
  assert.equal(clampNumber('7', 1, 0, 10), 7, '数字字符串也认')
  assert.equal(clampNumber(undefined, 4, 0, 10), 4)
  assert.equal(clampNumber(Number.NaN, 4, 0, 10), 4)
  assert.equal(clampNumber(Number.POSITIVE_INFINITY, 4, 0, 10), 10)
})

test('toInlineJson 转义 </script 与 U+2028/U+2029', () => {
  const out = toInlineJson({ hint: '</script><script>alert(1)</script>', x: '\u2028\u2029' })
  assert.equal(out.includes('</script'), false, '内联脚本里不允许出现结束标签')
  assert.equal(out.includes('\\u003c'), true)
  assert.equal(out.includes('\u2028'), false)
  assert.equal(out.includes('\u2029'), false)
  assert.deepEqual(JSON.parse(out), { hint: '</script><script>alert(1)</script>', x: '\u2028\u2029' })
})

test('mergeDeep 只深合并普通对象，数组与标量整体替换', () => {
  const base = { a: { x: 1, y: 2 }, list: [1, 2], keep: true }
  const out = mergeDeep(base, { a: { y: 3 }, list: [9] })
  assert.deepEqual(out, { a: { x: 1, y: 3 }, list: [9], keep: true })
  assert.deepEqual(base, { a: { x: 1, y: 2 }, list: [1, 2], keep: true }, '不能改到入参')
  assert.equal(isPlainObject([]), false)
  assert.equal(isPlainObject(null), false)
})

// ────────────────────────────── 配置 ──────────────────────────────

test('resolveConfig 默认值：素材解析成路由，可调项取默认', () => {
  const { client, paths, warnings } = resolve({})
  assert.deepEqual(warnings, [])
  assert.equal(client.boot.enabled, true)
  assert.equal(client.boot.src, ROUTES.boot)
  assert.equal(client.boot.fadeMs, DEFAULT_CONFIG.boot.fadeMs)
  assert.equal(client.background.enabled, true)
  assert.equal(client.background.src, ROUTES.background)
  assert.equal(client.background.surface, DEFAULT_CONFIG.background.surface)
  assert.ok(paths.boot.endsWith(path.join('assets', 'boot.mp4')))
  assert.ok(paths.background.endsWith(path.join('assets', 'background.mp4')))
  // 用户要求：开机动画要有声音、聊天背景要看得清画面。
  assert.equal(client.boot.sound, true)
  assert.equal(client.boot.volume, 1)
  assert.equal(client.boot.skipLabel, DEFAULT_CONFIG.boot.skipLabel)
  assert.ok(client.background.surface <= 0.35, '表面默认不能太实，否则看不清视频')
  assert.ok(client.background.veil <= 0.3, '蒙版默认不能太重，否则看不清视频')
})

test('声音相关配置：sound:false 关声音、volume 夹到 0..1', () => {
  assert.equal(resolve({ boot: { sound: false } }).client.boot.sound, false)
  assert.equal(resolve({ boot: { sound: true } }).client.boot.sound, true)
  assert.equal(resolve({ boot: { volume: 5 } }).client.boot.volume, 1)
  assert.equal(resolve({ boot: { volume: -3 } }).client.boot.volume, 0)
  assert.equal(resolve({ boot: { volume: 'nope' } }).client.boot.volume, DEFAULT_CONFIG.boot.volume)
  assert.equal(resolve({ boot: { soundLabel: '开声音' } }).client.boot.soundLabel, '开声音')
})

test('resolveConfig 夹取越界数值', () => {
  const { client } = resolve({
    boot: { fadeMs: 999999, skipFadeMs: -20, holdMs: 1, volume: 9 },
    background: { veil: 5, surface: -2, playbackRate: 99, delayMs: -1 },
  })
  assert.equal(client.boot.fadeMs, 6000)
  assert.equal(client.boot.skipFadeMs, 80)
  assert.equal(client.boot.holdMs, 4000)
  assert.equal(client.boot.volume, 1)
  assert.equal(client.background.veil, 0.92)
  assert.equal(client.background.surface, 0)
  assert.equal(client.background.playbackRate, 4)
  assert.equal(client.background.delayMs, 0)
})

test('resolveConfig 素材不存在：只让那一个功能降级并给出警告', () => {
  const { client, warnings } = resolve({ boot: { file: 'assets/nope.mp4' } })
  assert.equal(client.boot.enabled, false)
  assert.equal(client.boot.src, '')
  assert.equal(client.background.enabled, true, '另一个功能不受影响')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /missing on disk/u)
})

test('resolveConfig 拒绝逃出包的素材路径', () => {
  const { client, warnings } = resolve({ background: { file: '../../../../.credentials.yaml' } })
  assert.equal(client.background.enabled, false)
  assert.match(warnings.join(' '), /escapes/u)
})

test('resolveConfig 尊重 enabled:false', () => {
  const { client } = resolve({ boot: { enabled: false }, background: { enabled: false } })
  assert.equal(client.boot.enabled, false)
  assert.equal(client.background.enabled, false)
})

test('resolveDshHome 优先环境变量，其次 ~/.dsh', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'C:\\x\\.dsh' }, () => 'C:\\other'), path.resolve('C:\\x\\.dsh'))
  assert.equal(resolveDshHome({}, () => path.join('C:', 'Users', 'u')), path.join('C:', 'Users', 'u', '.dsh'))
  assert.equal(resolveDshHome({}, undefined), undefined)
})

test('loadRawConfig：包内文件先、DSH_HOME 后（后者覆盖前者）', () => {
  const pkg = tmpdir()
  const home = tmpdir()
  fs.writeFileSync(
    path.join(pkg, PACKAGE_CONFIG_FILE),
    JSON.stringify({ boot: { fadeMs: 900, hint: 'pkg' }, background: { surface: 0.2 } }),
  )
  fs.writeFileSync(path.join(home, HOME_CONFIG_FILE), JSON.stringify({ boot: { hint: 'home' } }))

  const { config, sources } = loadRawConfig({ packageRoot: pkg, homeDir: home })
  assert.equal(sources.length, 2)
  assert.equal(config.boot.fadeMs, 900, '包内文件的值保留')
  assert.equal(config.boot.hint, 'home', 'DSH_HOME 的值覆盖')
  assert.equal(config.background.surface, 0.2)

  const resolved = resolveConfig(config, { packageRoot, routes: ROUTES, version: 'test' })
  assert.equal(resolved.client.boot.fadeMs, 900)
  assert.equal(resolved.client.boot.hint, 'home')
  assert.equal(resolved.client.background.surface, 0.2)
})

test('loadRawConfig：坏 JSON 与不存在的文件都静默忽略', () => {
  const pkg = tmpdir()
  fs.writeFileSync(path.join(pkg, PACKAGE_CONFIG_FILE), '{ not json')
  const { config, sources } = loadRawConfig({ packageRoot: pkg, homeDir: path.join(pkg, 'nope') })
  assert.deepEqual(config, {})
  assert.deepEqual(sources, [])
})

// ─────────────────── 界面滑块的写回（writeOverride / clearOverride） ───────────────────

test('writeOverride 合并进用户文件，别的键与别的段都不动', () => {
  const home = tmpdir()
  fs.writeFileSync(
    path.join(home, HOME_CONFIG_FILE),
    JSON.stringify({ background: { delayMs: 700, surface: 0.9 }, boot: { volume: 0.3 }, keep: true }),
  )
  const { file, raw } = writeOverride({ homeDir: home, patch: { surface: 0.25, veil: 0.05 } })
  assert.equal(file, path.join(home, HOME_CONFIG_FILE))
  assert.equal(raw.background.delayMs, 700, '不相干的键保留')
  assert.equal(raw.background.surface, 0.25, '同名键被覆盖')
  assert.equal(raw.background.veil, 0.05, '新键被写入')
  assert.equal(raw.boot.volume, 0.3)
  assert.equal(raw.keep, true)
  // 文件确实是 JSON、确实带换行结尾（用户要能直接打开改）。
  const text = fs.readFileSync(file, 'utf8')
  assert.equal(text.endsWith('\n'), true)
  assert.deepEqual(JSON.parse(text), raw)
})

test('writeOverride 在文件不存在时创建它，并只写认识的键', () => {
  const home = tmpdir()
  const { raw } = writeOverride({ homeDir: home, patch: { surface: 0.3, bounce: 1, veil: 'x' } })
  assert.deepEqual(Object.keys(raw.background).sort(), ['surface'])
  assert.equal(raw.background.surface, 0.3)
})

test('clearOverride 只摘掉四个旋钮，其余原样保留', () => {
  const home = tmpdir()
  fs.writeFileSync(
    path.join(home, HOME_CONFIG_FILE),
    JSON.stringify({ background: { surface: 0.9, veil: 0.8, surfaceLight: 0.95, veilLight: 0.7, delayMs: 700 }, boot: { volume: 0.3 } }),
  )
  const { raw } = clearOverride(home)
  assert.deepEqual(raw.background, { delayMs: 700 })
  assert.deepEqual(raw.boot, { volume: 0.3 })
  assert.deepEqual(readOverride(home), {}, '读回来的可写项应该是空的')
})

test('clearOverride 把 background 段清空时连段一起删掉', () => {
  const home = tmpdir()
  fs.writeFileSync(path.join(home, HOME_CONFIG_FILE), JSON.stringify({ background: { surface: 0.9 }, boot: {} }))
  const { raw } = clearOverride(home)
  assert.equal('background' in raw, false)
})

test('readOverride 只认可写的五个键，且只认有限数', () => {
  const home = tmpdir()
  fs.writeFileSync(
    path.join(home, HOME_CONFIG_FILE),
    JSON.stringify({
      background: { surface: 0.4, veil: 'no', surfaceLight: null, delayMs: 5, veilLight: 0.2, panel: 1 },
    }),
  )
  assert.deepEqual(readOverride(home), { surface: 0.4, veilLight: 0.2, panel: 1 })
  assert.deepEqual(readOverride(''), {}, '空 homeDir 直接返回空')
  assert.deepEqual([...OVERRIDE_KEYS].sort(), ['panel', 'surface', 'surfaceLight', 'veil', 'veilLight'])
})

test('panel 默认 1（原生不透明），并且会被夹到 0..1', () => {
  const plain = resolveConfig({}, { packageRoot, routes: ROUTES, version: 'test' })
  assert.equal(plain.client.background.panel, 1, '默认必须是原生不透明 —— 弹层要能读')
  for (const [value, expected] of [[0.55, 0.55], [9, 1], [-3, 0]]) {
    const { client } = resolveConfig({ background: { panel: value } }, { packageRoot, routes: ROUTES, version: 'test' })
    assert.equal(client.background.panel, expected, `panel=${value} 应夹到 ${expected}`)
  }
})

test('写回的值经过 resolveConfig 后真的生效（滑块 → 文件 → 页面）', () => {
  const home = tmpdir()
  writeOverride({ homeDir: home, patch: { surface: 0.42, veil: 0.03 } })
  const { config } = loadRawConfig({ packageRoot, homeDir: home })
  const { client } = resolveConfig(config, { packageRoot, routes: ROUTES, version: 'test' })
  assert.equal(client.background.surface, 0.42)
  assert.equal(client.background.veil, 0.03)
  // 亮色按 surface + 0.4 派生（超过 1 会被夹住，所以这里取一个不会溢出的值）。
  assert.equal(client.background.surfaceLight.toFixed(2), '0.82')
  assert.equal(client.background.veilLight.toFixed(2), '0.02')
  assert.equal(client.override, ROUTES.override, '客户端要拿到写回端点')
})

test('只写 surface 时，亮色主题按 +0.4 派生并夹在 1 以内', () => {
  const home = tmpdir()
  writeOverride({ homeDir: home, patch: { surface: 0.9 } })
  const { config } = loadRawConfig({ packageRoot, homeDir: home })
  const { client } = resolveConfig(config, { packageRoot, routes: ROUTES, version: 'test' })
  assert.equal(client.background.surfaceLight, 1)
  assert.equal(client.background.controls, true, '控件默认开着')
})

// ────────────────────────────── 注入行 ──────────────────────────────

test('注入行：恰好两行、顺序固定、placement 正确、只用 kind:script', () => {
  const { client } = resolve({})
  const rows = buildInjectionRows({ clientConfig: client, cssText: '.a{}', jsText: 'void 0;' })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].kind, 'style', 'style 必须排在 script 之前')
  assert.equal(rows[1].kind, 'script')
  assert.equal(rows[1].placement, 'body')
  assert.equal(rows[1].text.startsWith(`globalThis.${BOOTSTRAP_GLOBAL}=`), true)
  assert.ok(rows[1].text.includes('void 0;'))
  assert.equal(rows.some((row) => row.kind === 'script-src'), false, 'script-src 在桌面壳上失败会拖垮启动')
})

test('注入行：配置里的恶意字符串不会闭合 script 元素', () => {
  const client = { boot: { hint: '</script><script>alert(1)</script>' }, background: {}, config: ROUTES.config }
  const rows = buildInjectionRows({ clientConfig: client, cssText: '', jsText: '' })
  assert.equal(rows[1].text.includes('</script'), false)
  assert.equal(rows[0].text.includes('</style'), false)
})

// ─────────────────── 主题联动（一次性自动切深色） ───────────────────

test('resolveThemeMode：默认是 ask（只问不改），兼容旧的 autoDark 布尔', () => {
  assert.equal(resolveThemeMode(undefined), 'ask')
  assert.equal(resolveThemeMode({}), 'ask')
  assert.equal(resolveThemeMode({ mode: 'auto' }), 'auto')
  assert.equal(resolveThemeMode({ mode: 'off' }), 'off')
  assert.equal(resolveThemeMode({ mode: 'ask' }), 'ask')
  assert.equal(resolveThemeMode({ mode: 'nonsense' }), 'ask', '脏值回默认')
  // 0.1.3 的旧键
  assert.equal(resolveThemeMode({ autoDark: false }), 'off')
  assert.equal(resolveThemeMode({ autoDark: true }), 'auto')
  // mode 优先于旧键
  assert.equal(resolveThemeMode({ mode: 'ask', autoDark: true }), 'ask')
})

test('decideThemeLink：模式 + 标记 + 偏好三者的所有关键组合', () => {
  // off 什么都不做。
  assert.equal(decideThemeLink({ mode: 'off', marker: null, preference: 'light' }).action, 'skip')
  // 已经评估过 → 永远不再打扰（用户自己切回浅色的保护）。
  assert.equal(decideThemeLink({ mode: 'ask', marker: { evaluated: true }, preference: 'light' }).action, 'skip')
  assert.equal(decideThemeLink({ mode: 'auto', marker: { evaluated: true }, preference: 'light' }).action, 'skip')
  // 读不到偏好 → 宁可不做。
  assert.equal(decideThemeLink({ mode: 'auto', marker: null, preference: undefined }).action, 'skip')
  assert.equal(decideThemeLink({ mode: 'auto', marker: null, preference: 'purple' }).action, 'skip')
  // 已经是深色 → 只落标记，不改也不问。
  assert.deepEqual(decideThemeLink({ mode: 'ask', marker: null, preference: 'dark' }), {
    action: 'mark',
    reason: 'already-dark',
  })
  assert.deepEqual(decideThemeLink({ mode: 'auto', marker: null, preference: 'dark' }), {
    action: 'mark',
    reason: 'already-dark',
  })
  // 浅色 / 跟随系统：ask 只问，auto 才切。
  for (const previous of ['light', 'system']) {
    assert.deepEqual(decideThemeLink({ mode: 'ask', marker: null, preference: previous }), {
      action: 'ask',
      previous,
      reason: 'light-theme',
    })
    assert.deepEqual(decideThemeLink({ mode: 'auto', marker: null, preference: previous }), {
      action: 'switch',
      previous,
      reason: 'light-theme',
    })
  }
})
test('主题标记文件：写进去读得出来，没有就是 null', () => {
  const home = tmpdir()
  assert.equal(readThemeMarker(home), null, '没有文件时返回 null')
  assert.equal(readThemeMarker(''), null, '空 homeDir 返回 null')
  assert.equal(writeThemeMarker(home, { evaluated: true, switched: true, previous: 'light', notified: false }), true)
  const marker = readThemeMarker(home)
  assert.equal(marker.switched, true)
  assert.equal(marker.previous, 'light')
  assert.equal(marker.notified, false)
  // 坏 JSON 不该抛，只当没有。
  fs.writeFileSync(path.join(home, THEME_MARKER_FILE), '{ not json')
  assert.equal(readThemeMarker(home), null)
})

test('pickThemeDescriptor 只认 ui-theme 那一条', () => {
  assert.equal(pickThemeDescriptor(null), null)
  assert.equal(pickThemeDescriptor([]), null)
  assert.equal(pickThemeDescriptor([{ ns: 'agent-default-model', value: {} }]), null)
  assert.deepEqual(
    pickThemeDescriptor([
      { ns: 'agent-default-model', value: { provider: 'x' } },
      { ns: 'ui-theme', value: { preference: 'system', fontSize: 14 }, revision: 7 },
    ]),
    { preference: 'system', revision: 7 },
  )
  // 值是脏的也不该抛。
  assert.deepEqual(pickThemeDescriptor([{ ns: 'ui-theme', value: null }]), { preference: undefined, revision: undefined })
})