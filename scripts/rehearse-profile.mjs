/**
 * 装机预演：用**内核自己的 profile 加载器**把某个 profile 完整组合一遍，然后断言
 * "本插件的 bundle 层解析得到、patch 行正确、没有被 skippedBundles 收走"。
 *
 * 为什么需要它：桌面版（Electron）的 profile 由应用独占，`dsh --profile desktop
 * --dump-config` 会被明确拒绝，所以"装完之后 DSH 还能不能起来"在重启前没法用 CLI 回答。
 * 而 `loadProfileDirectory` 就是启动路径上会跑的那一步（逐层解析 bundle → 读每个包的
 * `dsh.bundle.patch` → 读用户 patch 层），而且**它就是第一个会抛的地方**。在这里预演一遍，
 * 等于把"重启后起不来"这个最坏情况提前到还能一条命令回滚的时候。
 *
 * 用法（必须 Electron-as-node，普通 node 读不了 asar）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'D:\AI\Agent\DSH官方\DeepSeek Harness.exe' scripts/rehearse-profile.mjs [profileName]
 *
 * 退出码：0 = 组合成功且本插件恰好一层、patch 行正确；1 = 组合失败；2 = 组合成功但插件没接上。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const INSTALL = process.env.DSH_INSTALL ?? 'D:/AI/Agent/DSH官方'
const KERNEL = `${INSTALL}/resources/app.asar/dsh/node_modules/@deepseek-ai`
const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const profile = process.argv[2] ?? 'desktop'
const profileDir = path.join(home, 'profiles', profile)

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(fs.readFileSync(path.join(scriptDir, '..', 'package.json'), 'utf8'))
const packageName = manifest.name

/**
 * 装载内核模块。asar 里的路径必须走 `file://` URL（`import('D:/...')` 会报
 * ERR_UNSUPPORTED_ESM_URL_SCHEME），所以统一用 `pathToFileURL`，并留一个 CJS 兜底。
 * @param {string} specifier 绝对路径。
 * @returns {Promise<Record<string, unknown>>} 模块导出。
 */
async function loadModule(specifier) {
  try {
    return await import(pathToFileURL(specifier).href)
  } catch {
    return createRequire(import.meta.url)(specifier)
  }
}

console.log(`kernel  : ${KERNEL}`)
console.log(`profile : ${profileDir}`)

const profileManifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
const bundles = profileManifest.dsh?.profile?.bundles ?? []
console.log(`bundles : ${bundles.length}`)
console.log(`declared: ${profileManifest.dependencies?.[packageName] ?? '(not declared)'}`)
console.log(`listed  : ${bundles.includes(packageName)}`)

const bootModule = await loadModule(`${KERNEL}/dsh/lib/profile-boot.js`)
const appBoot = await loadModule(`${KERNEL}/dsh-app-boot/lib/index.js`)
const installAnchor = bootModule.INSTALL_ANCHOR
if (typeof appBoot.loadProfileDirectory !== 'function') {
  console.error('内核没有导出 loadProfileDirectory，无法预演')
  process.exit(1)
}

let loaded
try {
  loaded = appBoot.loadProfileDirectory('dsh', profileDir, installAnchor, { userLayer: true })
} catch (error) {
  console.error('组合失败：')
  console.error(error instanceof Error ? error.stack : String(error))
  process.exit(1)
}

console.log(`layers  : ${loaded.layers.length}`)
console.log(`user patch layer: ${loaded.patches.length} row(s)`)
if (loaded.skippedBundles.length > 0) {
  console.log('skippedBundles:')
  for (const skipped of loaded.skippedBundles) console.log(`  - ${skipped.packageName}: ${skipped.reason}`)
}

const own = loaded.layers.find((layer) => layer.packageName === packageName)
const skipped = loaded.skippedBundles.find((entry) => entry.packageName === packageName)

if (skipped !== undefined) {
  console.error(`FAIL ${packageName} 被 skippedBundles 收走了：${skipped.reason}`)
  console.error('⇒ 重启后 DSH 不会加载这个插件（或起不来）。请先修掉再重启。')
  process.exit(2)
}
if (own === undefined) {
  console.error(`FAIL 组合结果里没有 ${packageName} 这一层`)
  process.exit(2)
}

console.log(`own layer dir : ${own.packageDir}`)
console.log(`own patch file: ${own.patchPaths.join(', ')}`)
const rows = own.patches.flatMap((patch) => (Array.isArray(patch.insert) ? patch.insert : []))
const ownRow = rows.find((row) => row && row.id === packageName)
const nameMatches = ownRow !== undefined && (ownRow.name === packageName)
console.log(`insert rows   : ${JSON.stringify(rows)}`)
if (typeof ownRow?.name !== 'string' || ownRow.name !== packageName) {
  console.error(`FAIL patch 行的 name 与包名不一致（loader 会只 warn 然后跳过这一行）`)
  process.exit(2)
}

// Host 入口与素材必须在盘上（"声明与产物错配"是另一类会在启动时才炸的错）。
const entry = path.join(own.packageDir, manifest.main ?? 'index.js')
const assets = [
  entry,
  path.join(own.packageDir, 'runtime', 'skin.js'),
  path.join(own.packageDir, 'runtime', 'skin.css'),
  path.join(own.packageDir, 'assets', 'boot.mp4'),
  path.join(own.packageDir, 'assets', 'background.mp4'),
]
for (const file of assets) {
  if (!fs.existsSync(file)) {
    console.error(`FAIL 运行时需要的文件不在盘上：${file}`)
    process.exit(2)
  }
}
console.log(`entry         : ${entry}`)
console.log(`nameMatches   : ${nameMatches}`)

console.log('\nrehearse-profile: OK —— 组合能过，插件恰好一层，patch 行与素材都在')
process.exit(0)
