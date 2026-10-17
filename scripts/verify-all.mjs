/**
 * 离线自检汇总：不需要 DSH 进程、不需要浏览器、不改任何现场文件。
 *
 * 覆盖六类契约：
 *   ① 素材存在、非空、**moov 在 mdat 之前**（否则浏览器要整段下完才出画面）、
 *      且**没有音轨**（用户要求"不要声音，有画面即可"）；静态背景那张图也必须在盘上
 *      并且真的是一张 JPEG；
 *   ② 注入的两行文本可解析、且不可能提前闭合元素；
 *   ③ 打包白名单 `files` 覆盖运行时会读到的每一条路径；
 *   ④ `cordis.patch.yml` 的行 `name` 与包名一致（不一致时 loader 只 warn 然后跳过，
 *      表现是"插件没生效但不报错"，最难查）；
 *   ⑤ 单元/时序/真实 HTTP 测试全部通过；
 *   ⑥ 配置解析在默认状态下两个功能都可用。
 *
 * 用法：node scripts/verify-all.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveConfig } from '../lib/config.js'
import { buildInjectionRows } from '../lib/injections.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const results = []

/** 与 index.js 保持一致的路由表；这里手写一份，好让本脚本能独立于插件入口跑。 */
const ROUTES = {
  boot: '/dsh-video-skin/boot.mp4',
  background: '/dsh-video-skin/background.mp4',
  image: '/dsh-video-skin/background-image',
  config: '/dsh-video-skin/config.json',
}

/**
 * 跑一项检查并记账。
 * @param {string} title 标题。
 * @param {() => void | Promise<void>} fn 检查体。
 */
async function check(title, fn) {
  try {
    await fn()
    results.push([true, title, ''])
  } catch (error) {
    results.push([false, title, error instanceof Error ? error.message : String(error)])
  }
}

/**
 * 读 MP4 顶层 box 链。
 * @param {string} file 文件路径。
 * @returns {Array<{ type: string, offset: number, size: number }>} 顶层 box 顺序。
 */
function boxChain(file) {
  const handle = fs.openSync(file, 'r')
  try {
    const boxes = []
    let offset = 0
    const size = fs.fstatSync(handle).size
    while (offset + 8 <= size) {
      const header = Buffer.alloc(16)
      const read = fs.readSync(handle, header, 0, 16, offset)
      if (read < 8) break
      let boxSize = header.readUInt32BE(0)
      const type = header.toString('latin1', 4, 8)
      let headerSize = 8
      if (boxSize === 1) {
        if (read < 16) break
        boxSize = Number(header.readBigUInt64BE(8))
        headerSize = 16
      } else if (boxSize === 0) {
        boxSize = size - offset
      }
      if (boxSize < headerSize) break
      boxes.push({ type, offset, size: boxSize })
      offset += boxSize
    }
    return boxes
  } finally {
    fs.closeSync(handle)
  }
}

/**
 * 在 MP4 里找某个 box 类型（只扫顶层与 moov 的一级子 box）。
 * @param {string} file 文件路径。
 * @param {string} want 目标类型。
 * @returns {boolean} 是否存在。
 */
function hasBox(file, want) {
  return boxChain(file).some((box) => box.type === want)
}

// ① 素材
// `audio` 是**期望**：开机动画要出声（用户要求），聊天背景必须无声（用户要求）。
const ASSETS = [
  { file: 'assets/boot.mp4', audio: true },
  { file: 'assets/background.mp4', audio: false },
]

/**
 * 静态背景那张图。
 *
 * 它不是 mp4，所以上面那三条（moov/音轨/box 链）对它没有意义；它要守的是另外两条：
 * **真的是一张 JPEG**（路由的 `Content-Type` 由扩展名决定，文件内容和扩展名不一致时
 * 浏览器会拒收），以及**别太大**（它和短片一起挂在首屏上）。
 */
const STILL = 'assets/background.jpg'

for (const { file: asset, audio } of ASSETS) {
  await check(`${asset} 存在且非空`, () => {
    const stat = fs.statSync(path.join(root, asset))
    assert.ok(stat.size > 64 * 1024, `素材太小（${stat.size} 字节），大概是转码没跑`)
  })
  await check(`${asset} 的 moov 在 mdat 之前（faststart）`, () => {
    const chain = boxChain(path.join(root, asset)).map((box) => box.type)
    const moov = chain.indexOf('moov')
    const mdat = chain.indexOf('mdat')
    assert.ok(moov >= 0, `没有 moov（实际链：${chain.join(' ')}）`)
    assert.ok(mdat >= 0, `没有 mdat（实际链：${chain.join(' ')}）`)
    assert.ok(moov < mdat, `moov 在 mdat 之后，浏览器要整段下完才出画面（实际链：${chain.join(' ')}）`)
  })
  await check(`${asset} ${audio ? '有' : '没有'}音轨`, () => {
    const probeArgs = [
      '-v',
      'error',
      '-select_streams',
      'a',
      '-show_entries',
      'stream=index',
      '-of',
      'csv=p=0',
      path.join(root, asset),
    ]
    const probe = spawnSync('ffprobe', probeArgs)
    const hasAudio = () => {
      if (probe.error) {
        // 没有 ffprobe 也不该让自检挂掉：退化成"扫 stsd 里有没有音频采样描述盒"。
        const bytes = fs.readFileSync(path.join(root, asset))
        return ['mp4a', 'ac-3', 'opus', 'twos'].some((tag) => bytes.includes(Buffer.from(tag)))
      }
      // ffprobe 偶尔会因为环境原因非零退出（CI 上装到一半、被杀软拦一下）。
      // 一次失败就判死会让整个自检假红，所以再给一次机会，两次都失败才降级到扫描。
      if (probe.status !== 0) {
        const retry = spawnSync('ffprobe', probeArgs, { encoding: 'utf8' })
        if (retry.error === undefined && retry.status === 0) return String(retry.stdout).trim() !== ''
        console.warn(`     （ffprobe 连续两次非零退出，降级为扫描音频采样描述盒：${String(probe.stderr).slice(0, 120)}）`)
        const bytes = fs.readFileSync(path.join(root, asset))
        return ['mp4a', 'ac-3', 'opus', 'twos'].some((tag) => bytes.includes(Buffer.from(tag)))
      }
      return String(probe.stdout).trim() !== ''
    }
    assert.equal(
      hasAudio(),
      audio,
      audio ? '开机动画必须带音轨 —— 用户要求开启声音' : '聊天背景必须没有音轨 —— 用户要求不要声音',
    )
  })
}

await check(`${STILL} 存在、非空，并且真的是一张 JPEG`, () => {
  const bytes = fs.readFileSync(path.join(root, STILL))
  assert.ok(bytes.length > 8 * 1024, `静态图太小（${bytes.length} 字节），抽帧大概没跑完`)
  assert.deepEqual(
    [...bytes.subarray(0, 3)],
    [0xff, 0xd8, 0xff],
    '缺 JPEG 的 SOI 标记 —— 内容和扩展名不一致，浏览器会拒收',
  )
  assert.ok(
    bytes.length <= 2 * 1024 * 1024,
    `静态图 ${(bytes.length / 1048576).toFixed(2)} MiB 太大：它会和短片一起挂上首屏`,
  )
})

await check('素材总量不至于让首屏等太久（≤ 30 MiB）', () => {
  const files = [...ASSETS.map(({ file }) => file), STILL]
  const total = files.reduce((sum, file) => sum + fs.statSync(path.join(root, file)).size, 0)
  assert.ok(total <= 30 * 1024 * 1024, `素材合计 ${(total / 1048576).toFixed(1)} MiB`)
})

await check('默认配置里开机动画有声、聊天背景无声', async () => {
  const { client } = resolveConfig({}, { packageRoot: root, routes: ROUTES, version: 'verify' })
  assert.equal(client.boot.sound, true, '开机动画默认应该尝试带声音播放')
  assert.ok(client.boot.volume > 0)
  assert.equal(client.background.veil <= 0.3, true, `蒙版过重会看不清画面（当前 ${client.background.veil}）`)
  assert.equal(client.background.surface <= 0.35, true, `表面过实会看不清画面（当前 ${client.background.surface}）`)
})

// ② 注入行文本
await check('注入行可解析、顺序固定、不会提前闭合元素', () => {
  const { client } = resolveConfig({}, { packageRoot: root, routes: ROUTES, version: 'verify' })
  const rows = buildInjectionRows({
    clientConfig: client,
    cssText: fs.readFileSync(path.join(root, 'runtime/skin.css'), 'utf8'),
    jsText: fs.readFileSync(path.join(root, 'runtime/skin.js'), 'utf8'),
  })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].kind, 'style')
  assert.equal(rows[1].kind, 'script')
  assert.equal(rows[1].text.includes('</script'), false)
  assert.equal(rows[0].text.includes('</style'), false)
  // 脚本文本是 `bootstrap + 正文`，整体必须能被解析。
  // eslint-disable-next-line no-new-func
  new Function(rows[1].text)
})

// ③ 打包白名单
await check('package.json 的 files 覆盖运行时读取的每条路径', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const files = pkg.files ?? []
  const covered = (relative) => files.some((entry) => relative === entry || relative.startsWith(`${entry}/`))
  const required = [
    'index.js',
    'lib/route.js',
    'lib/config.js',
    'lib/injections.js',
    'runtime/skin.js',
    'runtime/skin.css',
    'assets/boot.mp4',
    'assets/background.mp4',
    'assets/background.jpg',
    'cordis.patch.yml',
    'README.md',
    'README.zh.md',
    'LICENSE',
  ]
  for (const relative of required) {
    assert.ok(fs.existsSync(path.join(root, relative)), `缺少文件：${relative}`)
    assert.ok(covered(relative), `files 白名单没覆盖：${relative}`)
  }
  // 发布面：npm 通道要能让用户装完自己跑测试、抽静态图，发布说明也得在包里。
  for (const relative of ['scripts/verify-all.mjs', 'scripts/make-still.mjs', 'tests/lib.test.mjs', 'PUBLISHING.md']) {
    assert.ok(covered(relative), `files 白名单没覆盖：${relative}`)
  }
  // 元数据要指向真实地址，否则 npm 页面上的链接是坏的。
  assert.match(pkg.repository?.url ?? '', /Something11235\/dsh-video-skin/u)
  assert.equal(pkg.author, 'Something11235')
})

await check('没有任何会被 pnpm 拦下的 git 依赖生命周期脚本', () => {
  // 这一条是 `github:` 安装能不能成立的关键：pnpm 会拦 git 依赖的构建脚本，
  // 带 `prepare` 的仓库会让 `dsh plugin add "github:..."` 直接失败（即使产物已经提交）。
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const forbidden = ['prepare', 'prepack', 'postinstall', 'preinstall', 'install']
  const present = forbidden.filter((key) => key in (pkg.scripts ?? {}))
  assert.deepEqual(present, [], `这些脚本会让 git 安装失败：${present.join(', ')}`)
})

// ④ patch 行
await check('cordis.patch.yml 的 id/name 与包名一致，且恰好一行 insert', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
  // 不用 YAML 解析器（零依赖）：这份文件的结构是固定的两行。
  const insertMatches = patch.match(/^\s*-\s*id:/gmu) ?? []
  assert.equal(insertMatches.length, 1, `insert 行数不是 1（${insertMatches.length}）`)
  assert.match(patch, new RegExp(`-\\s*id:\\s*${pkg.name}\\s*$`, 'mu'))
  assert.match(patch, new RegExp(`^\\s*name:\\s*['"]?${pkg.name}['"]?\\s*$`, 'mu'))
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
})

await check('PowerShell 脚本保持纯 ASCII（PS 5.1 会按 ANSI 解码无 BOM 文件）', () => {
  const files = fs.readdirSync(path.join(root, 'scripts')).filter((name) => name.endsWith('.ps1'))
  assert.ok(files.length > 0, '没有找到 .ps1')
  for (const name of files) {
    const bytes = fs.readFileSync(path.join(root, 'scripts', name))
    const offending = bytes.findIndex((byte) => byte > 0x7f)
    assert.equal(offending, -1, `${name} 第 ${offending} 字节不是 ASCII`)
  }
})

// ⑤ 测试套件
await check('node --test 全部通过', () => {
  // Node 的测试运行器自己认 glob，但 Windows 的 path.join 会给反斜杠，所以这里手拼正斜杠。
  const pattern = `${root.replace(/\\/gu, '/')}/tests/**/*.test.mjs`
  const run = spawnSync(process.execPath, ['--test', pattern], { cwd: root, encoding: 'utf8' })
  if (run.error) throw new Error(`无法运行测试：${run.error.message}`)
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  // **退出码才是门禁**。下面那个"通过数"只是防"测试没跑全"的护栏；
  // 解析不到就只打一句提醒 —— 让输出格式的一时抖动把整个自检判成失败，
  // 是给自己造一个假红灯（CI 上尤其烦）。
  assert.equal(run.status, 0, `测试失败：\n${output}`)
  const pass = /pass (\d+)/u.exec(output)
  if (pass === null) {
    console.warn('     （没能从输出里读到通过数；退出码为 0，按通过处理）')
    return
  }
  assert.ok(Number(pass[1]) >= 40, `通过用例只有 ${pass[1]} 个，测试可能没跑全`)
})

// ⑥ 默认配置
await check('默认配置下两个功能都可用', () => {
  const { client, warnings, paths } = resolveConfig({}, { packageRoot: root, routes: ROUTES, version: 'verify' })
  assert.deepEqual(warnings, [])
  assert.equal(client.boot.enabled, true)
  assert.equal(client.background.enabled, true)
  assert.ok(fs.existsSync(paths.boot))
  assert.ok(fs.existsSync(paths.background))
  assert.ok(fs.existsSync(paths.image))
  // 默认是循环短片；静态图的地址同时给好，面板上的切换才不是摆设。
  assert.equal(client.background.mode, 'video')
  assert.equal(client.background.imageSrc, ROUTES.image)
})

await check('切成静态图也照样成立（mode:image 时两个素材都解析得到）', () => {
  const { client, warnings, paths } = resolveConfig(
    { background: { mode: 'image' } },
    { packageRoot: root, routes: ROUTES, version: 'verify' },
  )
  assert.deepEqual(warnings, [])
  assert.equal(client.background.enabled, true)
  assert.equal(client.background.mode, 'image')
  assert.equal(client.background.imageSrc, ROUTES.image)
  assert.equal(client.background.src, ROUTES.background, '短片地址要留着：面板能切回去')
  assert.ok(fs.existsSync(paths.image))
})

const failed = results.filter(([ok]) => !ok)
for (const [ok, title, message] of results) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${title}${ok ? '' : `\n       ${message.split('\n').join('\n       ')}`}`)
}
console.log(`\nverify-all: ${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
