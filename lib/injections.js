/**
 * 结构化索引注入行（`webserver/index-inject` 的贡献）。
 *
 * 契约来自 `@deepseek-ai/dsh-host-webserver` 的 `injections.d.ts`，并由桌面壳的
 * 页面侧解释器（`dsh-web-frontend` 的 `hM`）逐行应用。三条硬事实：
 *
 *   ① 两种渲染器都**按数组顺序**应用行，没有"按 kind 排序"这回事 —— 所以 style 行
 *      必须排在 script 行之前（否则脚本建 DOM 时会有一瞬没有样式），而给脚本读的
 *      `global` 行必须排在读它的脚本之前。
 *   ② `kind:'script-src'` 在桌面壳上是 `await loadScript(src)`，**失败即 reject，
 *      而那个 reject 会把 __DSH_BOOT_READY__ 打掉 ⇒ 应用起不来**。所以这里只用
 *      `kind:'script'`（createElement + textContent + append，没有 await，不可能失败）。
 *   ③ `placement` 只决定 script/html 进 head 还是 body；`style` 永远进 head。
 *
 * 这个插件因此只贡献两行，而且都在一次 `push` 里，保证相邻、顺序确定。
 */
import { toInlineJson } from './route.js'

/** 页面侧读取部署期配置用的全局名。 */
export const BOOTSTRAP_GLOBAL = '__DSH_VIDEO_SKIN__'

/**
 * 生成本插件的注入行。
 *
 * @param {{ clientConfig: Record<string, unknown>, cssText: string, jsText: string, skipLabel?: string }} input
 *   页面侧配置、样式文本、运行时脚本文本。
 * @returns {Array<Record<string, unknown>>} 按应用顺序排列的注入行。
 */
export function buildInjectionRows(input) {
  const bootstrap = `globalThis.${BOOTSTRAP_GLOBAL}=${toInlineJson(input.clientConfig)};`
  return [
    // ① 样式先到：覆盖层的底色/层级、以及聊天背景的表面半透明规则。
    { kind: 'style', text: input.cssText },
    // ② 运行时。placement:'body' —— 在 dsh web 的直出形态里，这一行落在 <body> 开头，
    //    早于 head 里那个 type="module" 的 shell 脚本执行（模块脚本是 defer 语义），
    //    所以覆盖层在原生启动页出现之前就占住了视口；桌面壳只拿它当选 head/body 的
    //    落点，执行时机由 IPC 决定，同样是"应用挂载之前"。
    { kind: 'script', placement: 'body', text: `${bootstrap}\n${input.jsText}` },
  ]
}
