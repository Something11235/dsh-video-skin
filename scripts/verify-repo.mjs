/**
 * 仓库保险：`.git` 完整性自检、就地修复、bare 镜像备份/恢复。
 *
 * ## 为什么需要它
 *
 * 这个仓库的 `.git` 被清空过两次（2026-10-23、2026-10-26），形态一样：
 * 只剩 `objects/`、`refs/` 和一个 `ORIG_HEAD`，`HEAD` / `config` / `index` 全没了。
 *
 * 根因不是同步盘或清理器 —— 是 **DSH 插件管理器用 pnpm 把 profile 里的 junction
 * 替换成 registry 包**时，pnpm 的"解压到 `_tmp_<pid>_<n>` → 改名覆盖目标"流程撞上
 * 文件占用（`ERR_PNPM_EPERM rename`），中途中断，顺着链接删到了开发目录。
 * 所以规矩是：**link 到 profile 时，绝不在插件界面点"安装/更新"**；
 * 开发调试请用独立的 profile（如 plugindev）。
 *
 * ## 用法
 *
 *   node scripts/verify-repo.mjs             # 自检（退出码 0/1）
 *   node scripts/verify-repo.mjs --repair    # 就地修：重建 HEAD/config/index 骨架
 *   node scripts/verify-repo.mjs --backup    # git clone --bare 到仓库**外面**的镜像
 *   node scripts/verify-repo.mjs --restore   # （骨架/refs 都没了时）从镜像恢复
 *
 * 备份默认放在 `%LOCALAPPDATA%\dsh-video-skin\mirror.git`（Windows）或
 * `$XDG_DATA_HOME/dsh-video-skin/mirror.git`，可用 `--mirror <目录>` 指定。
 * 放在仓库外面是刻意的：仓库被删时它不会跟着没。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const gitDir = path.join(repoRoot, '.git')

const args = { mode: 'verify', mirror: '', remote: '' }
for (let i = 2; i < process.argv.length; i += 1) {
  const flag = process.argv[i]
  if (flag === '--repair') args.mode = 'repair'
  else if (flag === '--backup') args.mode = 'backup'
  else if (flag === '--restore') args.mode = 'restore'
  else if (flag === '--mirror') args.mirror = process.argv[(i += 1)]
  else if (flag === '--remote') args.remote = process.argv[(i += 1)]
}

/** 默认镜像位置：刻意放在仓库外面。 */
function defaultMirror() {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  return path.join(local, 'dsh-video-skin', 'mirror.git')
}

const mirrorPath = args.mirror === '' ? defaultMirror() : path.resolve(args.mirror)

/**
 * 跑 git。
 * @param {string[]} argv 参数。
 * @param {{ cwd?: string, allowFail?: boolean }} [options] 选项。
 * @returns {{ ok: boolean, out: string, code: number }} 结果。
 */
function git(argv, options = {}) {
  const result = spawnSync('git', argv, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  })
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  const ok = result.status === 0
  if (!ok && options.allowFail !== true) {
    // 调用方自己决定要不要打印，这里只把结果带回去。
  }
  return { ok, out, code: result.status ?? -1 }
}

/** 一条检查结果。 */
const findings = []
/**
 * 记一条检查。
 * @param {boolean} ok 是否通过。
 * @param {string} title 标题。
 * @param {string} [detail] 细节。
 */
function check(ok, title, detail) {
  findings.push({ ok, title, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${title}${detail === undefined || detail === '' ? '' : `\n       ${detail}`}`)
}

/**
 * `.git` 骨架检查。
 * @returns {{ wired: boolean, hasRefs: boolean, headCommit: string | null }} 结论。
 */
function inspect() {
  if (!fs.existsSync(gitDir)) {
    check(false, '.git 目录存在', '整个 .git 都不在了 —— 用 --restore 从镜像恢复')
    return { wired: false, hasRefs: false, headCommit: null }
  }
  const has = (relative) => fs.existsSync(path.join(gitDir, relative))
  const head = has('HEAD')
  const config = has('config')
  const index = has('index')
  const refs = has('refs')
  check(head, '.git/HEAD 存在（"当前在哪个分支"）')
  check(config, '.git/config 存在（remote / 身份配置）')
  check(index, '.git/index 存在（暂存区；丢了可用 --repair 重建）')
  check(refs, '.git/refs 存在（分支指向）')

  const headCommit = head ? git(['rev-parse', '--verify', 'HEAD']).out : ''
  const known = headCommit !== '' && git(['cat-file', '-t', headCommit]).out === 'commit'
  check(known, 'HEAD 指向一个真实提交', known ? headCommit.slice(0, 7) : 'HEAD 指向的提交读不出来')

  // 骨架齐不齐（index 可以丢，HEAD/config/refs 丢了就修不了自己）
  const wired = head && config && refs && known
  return { wired, hasRefs: refs, headCommit: known ? headCommit : null }
}

/** 从现有配置里读 origin。 */
function readOrigin() {
  const result = git(['config', '--get', 'remote.origin.url'], { allowFail: true })
  return result.ok ? result.out.trim() : ''
}

/**
 * 就地修复：git init + 指回 main + 补 origin + 重建 index。
 * 前提是 `refs/heads/*` 还在（那里面是唯一的"分支指向"）。
 * @returns {boolean} 是否修好。
 */
function repair() {
  const branch = fs.existsSync(path.join(gitDir, 'refs', 'heads', 'main')) ? 'main' : ''
  if (branch === '') {
    check(false, 'refs/heads/main 还在（修复的前提）', '分支指向也没了 —— 用 --restore 从镜像恢复')
    return false
  }
  const origin = args.remote !== '' ? args.remote : readOrigin() || 'https://github.com/Something11235/dsh-video-skin.git'
  const init = git(['init'])
  check(init.ok, 'git init（补回 HEAD/config/objects 骨架）', init.out.split('\n')[0])
  const symbolic = git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`])
  check(symbolic.ok, 'HEAD 指回 refs/heads/main', symbolic.out)
  const hasOrigin = git(['config', '--get', 'remote.origin.url'], { allowFail: true }).ok
  if (!hasOrigin) {
    const added = git(['remote', 'add', 'origin', origin])
    check(added.ok, `补回 origin（${origin}）`, added.out)
  } else {
    check(true, 'origin 已存在，保留不动')
  }
  const reset = git(['reset', '-q'])
  check(reset.ok, '重建 index（git reset）', reset.out)
  return init.ok && symbolic.ok && reset.ok
}

/**
 * 备份：把仓库克隆成 bare 镜像（放在仓库外面）。
 * @returns {boolean} 是否成功。
 */
function backup() {
  fs.mkdirSync(path.dirname(mirrorPath), { recursive: true })
  if (!fs.existsSync(mirrorPath)) {
    const cloned = git(['clone', '--bare', repoRoot, mirrorPath], { cwd: path.dirname(repoRoot) })
    check(cloned.ok, `建立镜像：${mirrorPath}`, cloned.out.split('\n').slice(-1)[0])
    return cloned.ok
  }
  // 已经有镜像：把本地所有分支推进去（比重新 clone 省事，也保留旧历史）。
  const fetched = git(['fetch', repoRoot, '+refs/heads/*:refs/heads/*', '--prune'], { cwd: mirrorPath })
  check(fetched.ok, `更新镜像：${mirrorPath}`, fetched.out.split('\n').slice(-1)[0])
  const head = git(["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: mirrorPath, allowFail: true })
  return fetched.ok && (head.ok || true)
}

/**
 * 恢复：从镜像把 `.git` 重新长出来，并把工作区对齐。
 * @returns {boolean} 是否成功。
 */
function restore() {
  if (!fs.existsSync(mirrorPath)) {
    check(false, `镜像存在（${mirrorPath}）`, '没有镜像可恢复 —— 先用 --backup 建一个，最好在仓库健康时就建')
    return false
  }
  const origin = args.remote !== '' ? args.remote : readOrigin() || 'https://github.com/Something11235/dsh-video-skin.git'
  // 把坏掉的 .git 挪开（不直接删，留着万一要捞东西）。
  if (fs.existsSync(gitDir)) {
    const parked = `${gitDir}.broken-${Date.now()}`
    fs.renameSync(gitDir, parked)
    check(true, `.git 已挪到 ${path.basename(parked)}（不删，留着捞）`)
  }
  const init = git(['init'])
  check(init.ok, 'git init', init.out.split('\n')[0])
  const addOrigin = git(['remote', 'add', 'origin', origin], { allowFail: true })
  check(addOrigin.ok, `origin = ${origin}`, addOrigin.out)
  const addMirror = git(['remote', 'add', 'mirror', mirrorPath])
  check(addMirror.ok, `临时 remote mirror = ${mirrorPath}`, addMirror.out)
  const fetched = git(['fetch', 'mirror'])
  check(fetched.ok, '从镜像取回对象', fetched.out.split('\n').slice(-1)[0])
  const symbolic = git(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  check(symbolic.ok, 'HEAD 指回 refs/heads/main', symbolic.out)
  const reset = git(['reset', '--hard', 'mirror/main'])
  check(reset.ok, '工作区对齐到镜像的 main', reset.out.split('\n')[0])
  const removed = git(['remote', 'remove', 'mirror'])
  check(removed.ok, '移除临时 remote', removed.out)
  return fetched.ok && symbolic.ok && reset.ok
}

console.log(`repo: ${repoRoot}`)
console.log(`mode: ${args.mode}\n`)

let ok = true
if (args.mode === 'backup') {
  ok = backup()
} else if (args.mode === 'restore') {
  ok = restore()
} else {
  const state = inspect()
  if (args.mode === 'repair') {
    ok = state.wired ? true : repair()
    if (!state.wired && ok) {
      console.log('\n修完后复查：')
      ok = inspect().wired
    }
  } else {
    ok = state.wired
    if (!ok) {
      console.log('\n骨架缺件。可以试：')
      console.log('  node scripts/verify-repo.mjs --repair     # refs 还在时能就地修')
      console.log('  node scripts/verify-repo.mjs --restore    # refs 也没了，从镜像恢复')
    }
  }
  // 镜像是否新鲜（提醒而已，不影响退出码）。
  if (fs.existsSync(mirrorPath)) {
    const mirrorHead = git(['rev-parse', '--verify', 'refs/heads/main'], { cwd: mirrorPath, allowFail: true })
    const localHead = git(['rev-parse', '--verify', 'HEAD'], { allowFail: true })
    if (mirrorHead.ok && localHead.ok && mirrorHead.out.trim() !== localHead.out.trim()) {
      console.log(`\n提示：镜像落后了（${mirrorHead.out.trim().slice(0, 7)} ≠ ${localHead.out.trim().slice(0, 7)}），跑一次 --backup 更新它`)
    }
  } else {
    console.log(`\n提示：还没有镜像备份。仓库健康时跑一次 --backup（${mirrorPath}）`)
  }
}

console.log(`\nverify-repo: ${ok ? '通过' : '有问题'}`)
process.exit(ok ? 0 : 1)
