/**
 * 把一个本地插件目录接进某个 DSH profile —— "路二"（写正式依赖声明）的实现。
 *
 * 只做四件事：
 *   ① 备份该 profile 的 `package.json` / `pnpm-lock.yaml` / `cordis.patch.yml`；
 *   ② 在 `package.json` 里写 `dependencies[<name>] = "link:<插件目录>"`；
 *   ③ 把 `<name>` 追加进 `dsh.profile.bundles`（这一步让插件成为**一个 bundle 层**，
 *      而不是往 profile 的 `cordis.patch.yml` 里插一行 —— 两条路都挂会产出两条同 id
 *      的 entry，已实测）；
 *   ④ 在 `<profile>/node_modules/<name>` 建一个目录链接（junction，不需要管理员）。
 *
 * 为什么不是"改 patch 层"（路一）：路一不写依赖声明，之后任何一次 `pnpm install`
 * 都可能把这个未声明的链接剪掉，而 patch 行还在 —— 那时 DSH 会因为"行解析不到包"起不来。
 *
 * 用法：
 *   node scripts/profile-link.mjs status    [--profile desktop]
 *   node scripts/profile-link.mjs install   [--profile desktop] [--home <DSH_HOME>]
 *   node scripts/profile-link.mjs uninstall [--profile desktop] [--home <DSH_HOME>]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(scriptDir, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
const packageName = manifest.name

/**
 * 解析命令行参数。
 * @param {string[]} argv 参数表。
 * @returns {{ action: string, profile: string, home: string }} 解析结果。
 */
function parseArgs(argv) {
  const args = { action: 'status', profile: 'desktop', home: '' }
  const rest = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--profile') args.profile = argv[(index += 1)] ?? ''
    else if (token === '--home') args.home = argv[(index += 1)] ?? ''
    else rest.push(token)
  }
  if (rest.length > 0) args.action = rest[0]
  return args
}

/**
 * 定位 DSH_HOME。
 * @param {string} override 命令行给的路径。
 * @returns {string} 绝对路径。
 */
function resolveHome(override) {
  if (override !== '') return path.resolve(override)
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '') return path.resolve(process.env.DSH_HOME)
  return path.join(os.homedir(), '.dsh')
}

/**
 * 读并校验 profile 的 package.json。
 * @param {string} profileDir profile 目录。
 * @returns {{ file: string, json: Record<string, any> }} 文件与内容。
 */
function readProfileManifest(profileDir) {
  const file = path.join(profileDir, 'package.json')
  if (!fs.existsSync(file)) throw new Error(`不是 DSH profile（没有 package.json）：${profileDir}`)
  const json = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (typeof json !== 'object' || json === null || json.dsh === undefined) {
    throw new Error(`不是 DSH profile（package.json 里没有 dsh 字段）：${file}`)
  }
  return { file, json }
}

/**
 * 写回 profile 的 package.json，保持两空格缩进与结尾换行。
 * @param {string} file 目标文件。
 * @param {Record<string, unknown>} json 内容。
 */
function writeProfileManifest(file, json) {
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, 'utf8')
}

/**
 * 备份会被改动的文件。
 * @param {string} profileDir profile 目录。
 * @returns {string} 备份目录。
 */
function backup(profileDir) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const target = path.join(profileDir, `.dsh-video-skin-backup-${stamp}`)
  fs.mkdirSync(target, { recursive: true })
  for (const name of ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml']) {
    const source = path.join(profileDir, name)
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(target, name))
  }
  return target
}

/**
 * 链接在 node_modules 里的状态。
 * @param {string} linkPath 链接路径。
 * @returns {{ exists: boolean, kind: 'link' | 'directory' | 'missing' }} 状态。
 */
function linkState(linkPath) {
  let stat
  try {
    stat = fs.lstatSync(linkPath)
  } catch {
    return { exists: false, kind: 'missing' }
  }
  return { exists: true, kind: stat.isSymbolicLink() ? 'link' : 'directory' }
}

/** @param {string} message 提示文本。 */
function note(message) {
  console.log(`[dsh-video-skin] ${message}`)
}

const args = parseArgs(process.argv.slice(2))
const home = resolveHome(args.home)
const profileDir = path.join(home, 'profiles', args.profile)
const linkPath = path.join(profileDir, 'node_modules', packageName)
const linkSpec = `link:${packageRoot.replace(/\\/gu, '/')}`

note(`package: ${packageName} @ ${packageRoot}`)
note(`profile: ${profileDir}`)

if (!fs.existsSync(profileDir)) {
  console.error(`profile 目录不存在：${profileDir}`)
  process.exit(2)
}

if (args.action === 'status') {
  const { json } = readProfileManifest(profileDir)
  const declared = json.dependencies?.[packageName]
  const bundled = (json.dsh?.profile?.bundles ?? []).includes(packageName)
  const state = linkState(linkPath)
  console.log(JSON.stringify({ declared: declared ?? null, bundled, link: state }, null, 2))
  process.exit(0)
}

if (args.action === 'install') {
  const { file, json } = readProfileManifest(profileDir)
  const state = linkState(linkPath)
  if (state.kind === 'directory') {
    console.error(
      `拒绝覆盖：${linkPath} 是一个真实目录（大概是 pnpm 装的正式副本）。\n` +
        '请先让 DSH 自己卸载它，或手工确认后删除。',
    )
    process.exit(3)
  }

  const saved = backup(profileDir)
  note(`已备份到 ${saved}`)

  json.dependencies = json.dependencies ?? {}
  json.dependencies[packageName] = linkSpec
  json.dsh = json.dsh ?? {}
  json.dsh.profile = json.dsh.profile ?? {}
  const bundles = Array.isArray(json.dsh.profile.bundles) ? json.dsh.profile.bundles : []
  if (!bundles.includes(packageName)) bundles.push(packageName)
  json.dsh.profile.bundles = bundles
  writeProfileManifest(file, json)
  note(`package.json 已写入 dependencies["${packageName}"] = "${linkSpec}"，bundles 已包含`)

  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  if (state.exists) fs.unlinkSync(linkPath)
  fs.symlinkSync(packageRoot, linkPath, 'junction')
  note(`已建立目录链接：${linkPath} -> ${packageRoot}`)

  note('')
  note('下一步：**完全退出 DeepSeek Harness 再重新打开**。')
  note('桌面壳的索引注入表是宿主启动时收集一次的，刷新页面不会补上。')
  process.exit(0)
}

if (args.action === 'uninstall') {
  const { file, json } = readProfileManifest(profileDir)
  const saved = backup(profileDir)
  note(`已备份到 ${saved}`)

  if (json.dependencies && Object.prototype.hasOwnProperty.call(json.dependencies, packageName)) {
    delete json.dependencies[packageName]
    note(`已移除 dependencies["${packageName}"]`)
  }
  const bundles = json.dsh?.profile?.bundles
  if (Array.isArray(bundles)) {
    json.dsh.profile.bundles = bundles.filter((entry) => entry !== packageName)
    note('已从 dsh.profile.bundles 移除')
  }
  writeProfileManifest(file, json)

  const state = linkState(linkPath)
  if (state.kind === 'link') {
    fs.unlinkSync(linkPath)
    note(`已删除目录链接：${linkPath}`)
  } else if (state.kind === 'directory') {
    note(`保留 ${linkPath}（真实目录，不是本脚本建的链接，请手工处理）`)
  }
  note('')
  note('下一步：**完全退出 DeepSeek Harness 再重新打开**，注入行才会消失。')
  process.exit(0)
}

console.error(`未知动作：${args.action}（可用：status / install / uninstall）`)
process.exit(1)
