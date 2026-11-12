/**
 * 造一个**独立、可抛弃**的 DSH_HOME + profile，只挂本插件，用来在不碰你正在用的 DSH 的
 * 前提下把效果真跑一遍（配合 `verify-browser.mjs`）。
 *
 * 用法：
 *   node scripts/make-verify-profile.mjs [--home <目录>] [--profile verify]
 *
 * 它会写入 `<home>/profiles/<profile>/package.json`（**UTF-8 无 BOM** —— 有 BOM 时内核的
 * `JSON.parse` 会直接抛 "Unexpected token" 让 DSH 起不来）并把本包 junction 进
 * `node_modules`，然后打印启动命令。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(scriptDir, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))

const args = { home: path.join(packageRoot, '.verify-home'), profile: 'verify' }
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index]
  if (token === '--home') args.home = process.argv[(index += 1)]
  else if (token === '--profile') args.profile = process.argv[(index += 1)]
}

const home = path.resolve(args.home)
const profileDir = path.join(home, 'profiles', args.profile)
const linkPath = path.join(profileDir, 'node_modules', manifest.name)

fs.mkdirSync(path.dirname(linkPath), { recursive: true })

const profileManifest = {
  name: `dsh-profile-${args.profile}`,
  private: true,
  dependencies: { [manifest.name]: `link:${packageRoot.replace(/\\/gu, '/')}` },
  dsh: {
    profile: {
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', manifest.name],
    },
  },
}
// 关键：不能带 BOM。核实用 JSON.parse 读 profile 的 package.json，BOM 会让它直接抛。
fs.writeFileSync(path.join(profileDir, 'package.json'), `${JSON.stringify(profileManifest, null, 2)}\n`, 'utf8')

try {
  const existing = fs.lstatSync(linkPath)
  if (existing.isSymbolicLink()) fs.unlinkSync(linkPath)
} catch {
  /* 不存在 */
}
fs.symlinkSync(packageRoot, linkPath, 'junction')

console.log(`已就绪：${profileDir}`)
console.log('')
console.log('启动（独立 DSH_HOME + 独立端口，不碰正在用的实例）：')
console.log(`  $env:DSH_HOME='${home}'`)
console.log(`  & 'D:\\AI\\Agent\\DSH官方\\resources\\runtime\\cli\\bin\\dsh.cmd' --profile ${args.profile} --no-open --port 19388`)
console.log('')
console.log('然后拿它打印出来的带令牌 URL 跑：')
console.log('  node scripts/verify-browser.mjs --url "http://127.0.0.1:19388/?token=..." --shot-dir docs')
console.log('')
console.log(`用完删掉整个 ${home} 即可（它是可抛弃的）。`)
console.log(`（默认目录：${path.join(packageRoot, '.verify-home')}，别忘了加进 .gitignore）`)
