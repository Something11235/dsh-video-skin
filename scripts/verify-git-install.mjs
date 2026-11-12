/**
 * git 安装预演：把仓库当成"GitHub 上那个远程"完整走一遍**用户那一行安装**。
 *
 * 为什么必须有这一步：`github:owner/repo#ref` 走的是 pnpm 的 git 依赖路径，它和
 * `link:` 本地目录**是两条不同的路**，而且有一条众所周知的坑：
 *
 *   pnpm 会拦下 git 依赖的构建脚本 ⇒ 仓库里带 `prepare` 会让
 *   `dsh plugin add "github:..."` 直接失败（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`），
 *   **即使产物已经提交**。
 *
 * 所以这里做的事是：把当前提交克隆成一个裸仓库当"远端" → 用 `git+file://` 让 pnpm 走
 * 真正的 git 依赖安装 → 断言装出来的副本**自带运行所需的一切**、且**没有任何构建脚本**。
 * 把 `github:` 换成 `git+file://<本地裸仓库>#main`，pnpm 走的是同一段代码。
 *
 * 用法：
 *   node scripts/verify-git-install.mjs [--dsh <dsh.cmd 路径>] [--keep]
 *
 * 退出码：0 = 一行安装成立；1 = 不成立（并把失败原因打出来）。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))

const args = { dshRoot: process.env.DSH_INSTALL ?? 'D:/AI/Agent/DSH官方', keep: false }
for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] === '--dsh-root') args.dshRoot = process.argv[(index += 1)]
  else if (process.argv[index] === '--keep') args.keep = true
}

/**
 * 直接以 "Electron as Node" 跑 CLI 入口，而不是去 spawn `dsh.cmd`。
 *
 * 原因很实在：Windows 上 `spawnSync` 一个 `.cmd` 需要 `shell: true`，而那会把路径交给
 * cmd.exe 重新解析 —— 这个仓库的路径里有 CJK 和非 ASCII 空格风险，能避就避。
 * `.cmd` 里本来就写着它到底跑什么，这里照着来就行：
 *   ELECTRON_RUN_AS_NODE=1 <install>/DeepSeek Harness.exe --expose-internals
 *     <install>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js ...
 */
const cliEntry = path.join(
  args.dshRoot,
  'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js',
)
const cliBinary = path.join(args.dshRoot, 'DeepSeek Harness.exe')

/** 一项检查。 */
const results = []
/**
 * @param {boolean} ok 通过与否。
 * @param {string} title 标题。
 * @param {unknown} [detail] 细节。
 */
function check(ok, title, detail) {
  results.push({ ok, title, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${title}${ok || detail === undefined ? '' : `\n       ${JSON.stringify(detail)}`}`)
}

/** 跑一条命令并返回结果。 */
function run(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, { encoding: 'utf8', ...options })
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-video-skin-git-'))
const remote = path.join(root, 'remote.git')
const home = path.join(root, 'home')
const profileDir = path.join(home, 'profiles', 'verify')
console.log(`package : ${packageRoot}`)
console.log(`临时根  : ${root}`)

try {
  // ① 把**已提交的内容**克隆成裸仓库 —— 这就是 GitHub 上那份，工作区里的未提交改动不算数。
  //
  // 这一条只针对**会影响用户装到什么的**改动：运行时文件、素材、清单、patch 行。
  // docs/scripts/tests/README 改了没提交不影响安装结果 —— 那种情况只提示、不判失败，
  // 否则"边改文档边预演"会造出一个假红灯。
  const dirty = run('git', ['-C', packageRoot, 'status', '--porcelain'])
  const dirtyPaths = dirty.stdout
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((line) => line !== '')
  const shipped = (relative) =>
    /^(?:index\.js|package\.json|cordis\.patch\.yml|lib\/|runtime\/|assets\/)/u.test(relative)
  const dirtyShipped = dirtyPaths.filter(shipped)
  check(
    dirtyShipped.length === 0,
    '① 影响安装内容的改动都已提交（远端 = 本地提交）',
    { dirtyShipped, dirtyAll: dirtyPaths },
  )
  if (dirtyPaths.length > 0 && dirtyShipped.length === 0) {
    console.warn(`     （有未提交的改动，但都不影响安装内容，按通过处理：${dirtyPaths.join(', ')}）`)
  }
  const clone = run('git', ['clone', '--bare', '--quiet', packageRoot, remote])
  check(clone.status === 0, '① 裸仓库克隆成功（等价于 GitHub 上那个仓库）', clone.stderr)

  // ② 干净 profile 骨架：只列 bundles，依赖交给插件管理器自己写。
  fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true })
  fs.writeFileSync(
    path.join(profileDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'dsh-profile-verify',
        private: true,
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', manifest.name] } },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  // ③ 用户那一行安装。把 `github:owner/repo#main` 换成 `git+file://<裸仓库>#main`：
  //    pnpm 的 git 依赖处理是同一段代码，所以 prepare 之类的坑会一模一样地复现。
  const spec = `git+file:///${remote.replace(/\\/gu, '/')}#main`
  console.log(`\n安装：dsh plugin --profile verify add "${spec}"\n`)
  const install = run(cliBinary, ['--expose-internals', cliEntry, 'plugin', '--profile', 'verify', 'add', spec], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, NO_PROXY: 'localhost,127.0.0.1' },
  })
  const output = `${install.stdout ?? ''}${install.stderr ?? ''}`
  console.log(output.trim().split('\n').slice(-8).join('\n'))
  check(install.status === 0, '③ 一行安装成功（git 依赖 + 无构建脚本）', {
    status: install.status,
    error: install.error === undefined ? undefined : String(install.error),
    output: output.slice(-800),
  })

  // ④ 装出来的那一份必须自带运行所需的一切。
  const installed = path.join(profileDir, 'node_modules', manifest.name)
  const installedReal = fs.existsSync(installed) ? fs.realpathSync(installed) : undefined
  check(installedReal !== undefined, '④ 插件出现在 profile 的 node_modules 里', { installed })
  if (installedReal !== undefined) {
    const installedManifest = JSON.parse(fs.readFileSync(path.join(installedReal, 'package.json'), 'utf8'))
    check(installedManifest.dsh?.bundle?.patch === './cordis.patch.yml', '④ 装出来的包带 dsh.bundle.patch', installedManifest.dsh)
    check(installedManifest.name === manifest.name, '④ 包名一致（patch 行的 name 才能解析）', installedManifest.name)

    // 这一条是"白名单没漏"的真验证：pack 之后的副本里，运行时真读的每个文件都还在。
    const required = [
      installedManifest.main ?? 'index.js',
      'cordis.patch.yml',
      'lib/config.js',
      'lib/injections.js',
      'lib/route.js',
      'runtime/skin.js',
      'runtime/skin.css',
      'assets/boot.mp4',
      'assets/background.mp4',
      'video-skin.config.example.json',
      'README.md',
      'README.zh.md',
      'LICENSE',
    ]
    const missing = required.filter((relative) => !fs.existsSync(path.join(installedReal, relative)))
    check(missing.length === 0, '④ 装出来的副本里运行所需的文件一个不少', { missing, required: required.length })

    // 只读文件类型也要落地（mp4 被当过文本处理就会废掉）。
    const bootSize = fs.statSync(path.join(installedReal, 'assets', 'boot.mp4')).size
    check(bootSize > 1024 * 1024, '④ 素材是完整的二进制（不是被行尾转换过的文本）', { bootSize })

    const scripts = installedManifest.scripts ?? {}
    const lifecycle = ['prepare', 'prepack', 'postinstall', 'preinstall', 'install'].filter((key) => key in scripts)
    check(lifecycle.length === 0, '④ **没有**任何会被 pnpm 拦下的生命周期脚本', { lifecycle, scripts: Object.keys(scripts) })
  }

  // ⑤ 依赖声明与 bundle 列表都写对了。
  const profileManifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  check(
    typeof profileManifest.dependencies?.[manifest.name] === 'string' &&
      profileManifest.dependencies[manifest.name].includes('git+file:'),
    '⑤ profile 里记下的是 git 依赖（不是 link:）',
    profileManifest.dependencies,
  )
  check(
    (profileManifest.dsh?.profile?.bundles ?? []).includes(manifest.name),
    '⑤ 插件在 dsh.profile.bundles 里（否则不会成为一层）',
    profileManifest.dsh?.profile?.bundles,
  )

  const failed = results.filter((item) => !item.ok)
  console.log(`\nverify-git-install: ${results.length - failed.length}/${results.length} 通过`)
  if (failed.length === 0) {
    console.log('\n下一步（真跑一遍）：')
    console.log(`  $env:DSH_HOME='${home}'`)
    console.log(`  & '${cliBinary}' --expose-internals '${cliEntry}' --profile verify --no-open --port 19388`)
    console.log('  node scripts/verify-browser.mjs --url "http://127.0.0.1:19388/?token=..." --shot-dir docs')
  }
  if (args.keep !== true && failed.length === 0) {
    // 成功时默认留着目录，方便紧接着真跑一遍；失败时也留着，方便看现场。
    console.log(`\n临时目录保留：${root}（清理：删掉它即可）`)
  }
  process.exit(failed.length === 0 ? 0 : 1)
} catch (error) {
  console.error('预演崩了：', error)
  process.exit(1)
}
