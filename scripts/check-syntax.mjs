/**
 * 语法/装载检查：把宿主半边的每个 ESM 模块真的 import 一遍（证明它们能求值、
 * 顶层没有副作用），并把注入用的脚本文本交给 `new Function` 解析一遍
 * （证明它作为脚本文本语法成立，而且**不执行**）。
 *
 * 这个检查刻意不用子进程：`node --check` 走 spawn，而受限沙箱里 Node 起子进程会
 * `EPERM`。解析这件事在当前进程里就能做完。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** ESM 半边：import 一次 = 解析 + 求值。 */
const MODULES = ['index.js', 'lib/route.js', 'lib/config.js', 'lib/injections.js']
/** 注入进页面的脚本文本：只解析，不执行。 */
const SCRIPTS = ['runtime/skin.js']
/** 注入进页面的样式文本：只检查容器标签不会被提前闭合。 */
const STYLES = ['runtime/skin.css']

for (const file of MODULES) {
  const target = path.join(root, file)
  await import(pathToFileURL(target).href)
  console.log(`ok  import ${file}`)
}

for (const file of SCRIPTS) {
  const text = fs.readFileSync(path.join(root, file), 'utf8')
  assert.equal(text.includes('</script'), false, `${file}: 脚本文本里不允许出现 </script`)
  // eslint-disable-next-line no-new-func
  new Function(text)
  console.log(`ok  parse  ${file} (${text.length} bytes)`)
}

for (const file of STYLES) {
  const text = fs.readFileSync(path.join(root, file), 'utf8')
  assert.equal(text.includes('</style'), false, `${file}: 样式文本里不允许出现 </style`)
  const opens = (text.match(/\{/gu) ?? []).length
  const closes = (text.match(/\}/gu) ?? []).length
  assert.equal(opens, closes, `${file}: 花括号不配对（${opens} 开 / ${closes} 闭）`)
  console.log(`ok  parse  ${file} (${text.length} bytes, ${opens} rules)`)
}

console.log('\ncheck-syntax: 全部通过')
