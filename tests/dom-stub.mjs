/**
 * 一个够用的桩 DOM + 虚拟时钟，专门用来**真跑** `runtime/skin.js`。
 *
 * 为什么要自己写：这个插件的核心价值全在时序上 —— 片尾交叉溶解是不是正好落在
 * 最后一帧、点击是不是立刻跳过、素材坏了会不会扣住用户。正则和静态扫描都证明不了
 * 这些，只有把脚本放进一个能推时钟的环境里跑一遍才行。装 jsdom 会引入依赖，而这个
 * 插件刻意是零依赖的，所以这里只实现脚本真正用到的那一小部分 DOM。
 */

/** 虚拟时钟：托管 setTimeout / setInterval / requestAnimationFrame。 */
class Clock {
  constructor() {
    this.now = 0
    this.seq = 0
    this.timers = new Map()
    this.errors = []
  }

  /** @returns {number} 定时器 id。 */
  setTimeout(fn, ms) {
    const id = (this.seq += 1)
    this.timers.set(id, { at: this.now + Math.max(0, Number(ms) || 0), fn, every: null, raf: false })
    return id
  }

  /** @returns {number} 定时器 id。 */
  setInterval(fn, ms) {
    const period = Math.max(1, Number(ms) || 1)
    const id = (this.seq += 1)
    this.timers.set(id, { at: this.now + period, fn, every: period, raf: false })
    return id
  }

  clearTimeout(id) {
    this.timers.delete(id)
  }

  clearInterval(id) {
    this.timers.delete(id)
  }

  requestAnimationFrame(fn) {
    const id = (this.seq += 1)
    this.timers.set(id, { at: this.now + 16, fn, every: null, raf: true })
    return id
  }

  cancelAnimationFrame(id) {
    this.timers.delete(id)
  }

  /** 挂起中的定时器数量（含 rAF）。 */
  get pending() {
    return this.timers.size
  }

  /**
   * 把虚拟时间向前推 `ms`，按到期顺序执行回调。
   * @param {number} ms 推进的毫秒数。
   */
  advance(ms) {
    const target = this.now + ms
    for (;;) {
      let pick = null
      for (const [id, timer] of this.timers) {
        if (timer.at > target) continue
        if (pick === null || timer.at < pick.timer.at || (timer.at === pick.timer.at && id < pick.id)) {
          pick = { id, timer }
        }
      }
      if (pick === null) break
      this.now = pick.timer.at
      if (pick.timer.every === null) this.timers.delete(pick.id)
      else pick.timer.at = this.now + pick.timer.every
      try {
        pick.timer.fn()
      } catch (error) {
        this.errors.push(error)
      }
    }
    this.now = target
  }
}

/** 一个极简的 CSSStyleDeclaration 替身。 */
function makeStyle() {
  const props = new Map()
  const base = {
    setProperty(name, value) {
      props.set(String(name), String(value))
    },
    getPropertyValue(name) {
      return props.has(String(name)) ? props.get(String(name)) : ''
    },
    removeProperty(name) {
      props.delete(String(name))
    },
    _props: props,
  }
  return new Proxy(base, {
    set(target, key, value) {
      if (key in target) {
        target[key] = value
        return true
      }
      props.set(String(key), String(value))
      return true
    },
    get(target, key) {
      if (key in target) return target[key]
      const value = props.get(String(key))
      return value === undefined ? '' : value
    },
  })
}

/** 解析一个很窄的选择器子集：`tag` / `#id` / `.class` / `[attr]` / `[attr=value]` 的组合。 */
function compileSelector(selector) {
  const text = String(selector).trim()
  const tests = []
  const pattern = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/gu
  let match
  while ((match = pattern.exec(text)) !== null) {
    if (match[1] !== undefined) {
      const tag = match[1].toUpperCase()
      tests.push((el) => el.tagName === tag)
    } else if (match[2] !== undefined) {
      const id = match[2]
      tests.push((el) => el.id === id)
    } else if (match[3] !== undefined) {
      const cls = match[3]
      tests.push((el) => String(el.className).split(/\s+/u).includes(cls))
    } else if (match[4] !== undefined) {
      const attr = match[4]
      const value = match[5]
      if (value === undefined) tests.push((el) => el.hasAttribute(attr))
      else tests.push((el) => el.getAttribute(attr) === value)
    }
  }
  if (tests.length === 0) return () => false
  return (el) => tests.every((test) => test(el))
}

/** 一个够用的元素。 */
class StubElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase()
    this.ownerDocument = ownerDocument
    this.className = ''
    this.id = ''
    this.style = makeStyle()
    this.dataset = {}
    this.attributes = new Map()
    this.childNodes = []
    this.parentNode = null
    this.text = ''
    this.listeners = new Map()
    this.error = null
    this.ended = false
    this.paused = true
    this.muted = false
    this.defaultMuted = false
    this.loop = false
    this.autoplay = false
    this.preload = ''
    this.playsInline = false
    this.playbackRate = 1
    this.readyState = 0
    this.currentTime = 0
    this.duration = NaN
    this._src = ''
    this.playCalls = 0
    this.pauseCalls = 0
    this.frameCallbacks = []
    /** `'ok'` | `'reject'`（NotAllowedError）| `'pending'`（永不落定）。 */
    this.playBehaviour = 'ok'
    /** 逐次消费的脚本化行为队列（优先于 playBehaviour）。 */
    this.playBehaviours = []
    /** 每次 play() 时元素是不是静音的——用来断言"先试带声音、被拒才退回静音"。 */
    this.mutedAtPlay = []
  }

  get children() {
    return this.childNodes.filter((node) => node instanceof StubElement)
  }

  get firstChild() {
    return this.childNodes.length > 0 ? this.childNodes[0] : null
  }

  get lastChild() {
    return this.childNodes.length > 0 ? this.childNodes[this.childNodes.length - 1] : null
  }

  get textContent() {
    let out = this.text
    for (const child of this.childNodes) out += child.textContent ?? ''
    return out
  }

  set textContent(value) {
    this.text = value === undefined || value === null ? '' : String(value)
    this.childNodes.length = 0
  }

  get src() {
    return this._src
  }

  set src(value) {
    this._src = String(value)
    this.readyState = 0
  }

  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node)
    node.parentNode = this
    this.childNodes.push(node)
    return node
  }

  insertBefore(node, reference) {
    if (node.parentNode) node.parentNode.removeChild(node)
    node.parentNode = this
    const index = reference ? this.childNodes.indexOf(reference) : -1
    if (index < 0) this.childNodes.push(node)
    else this.childNodes.splice(index, 0, node)
    return node
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node)
    if (index >= 0) this.childNodes.splice(index, 1)
    node.parentNode = null
    return node
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node)
  }

  replaceChildren(...nodes) {
    this.childNodes.length = 0
    this.text = ''
    this.append(...nodes)
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value))
    if (name === 'class') this.className = String(value)
    if (name === 'id') this.id = String(value)
  }

  getAttribute(name) {
    return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null
  }

  hasAttribute(name) {
    return this.attributes.has(String(name))
  }

  removeAttribute(name) {
    this.attributes.delete(String(name))
  }

  addEventListener(type, listener, options) {
    const list = this.listeners.get(type) ?? []
    list.push({ listener, once: Boolean(options && options.once) })
    this.listeners.set(type, list)
  }

  removeEventListener(type, listener) {
    const list = this.listeners.get(type)
    if (!list) return
    this.listeners.set(
      type,
      list.filter((entry) => entry.listener !== listener),
    )
  }

  /** 触发一次事件；`key` 与修饰键供键盘事件用。 */
  dispatchEvent(event) {
    const type = event.type
    const list = [...(this.listeners.get(type) ?? [])]
    let defaultPrevented = false
    const payload = {
      type,
      target: this,
      currentTarget: this,
      key: event.key,
      // 修饰键必须透传：`Alt+B` 这类快捷键就是靠它判断的，漏了会让测试假绿。
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      preventDefault() {
        defaultPrevented = true
      },
      stopPropagation() {},
      get defaultPrevented() {
        return defaultPrevented
      },
    }
    for (const entry of list) {
      entry.listener(payload)
      if (entry.once) this.removeEventListener(type, entry.listener)
    }
    return !defaultPrevented
  }

  /**
   * 真实浏览器只在**真的呈现了一帧画面**时才回调，所以这里也绝不自动触发：
   * 自动触发会让"一帧都出不来"这条看门狗在测试里被错误地解除武装。
   * 需要"画面已经出来"的用例请显式调用 {@link presentFrame}。
   */
  requestVideoFrameCallback(callback) {
    this.frameCallbacks.push(callback)
    return 0
  }

  /** 模拟"第一帧已经呈现"：置位 readyState 并唤醒等帧的回调。 */
  presentFrame() {
    this.readyState = 3
    const callbacks = this.frameCallbacks.splice(0, this.frameCallbacks.length)
    for (const callback of callbacks) callback()
  }

  play() {
    this.playCalls += 1
    this.mutedAtPlay.push(this.muted)
    // 逐次消费的脚本化行为：同一个元素会被 play() 多次（先未静音、被拒后静音重试），
    // 所以"第几次是什么结果"必须能分开指定。队列空了就退回 playBehaviour。
    const scripted = this.playBehaviours.length > 0 ? this.playBehaviours.shift() : this.playBehaviour
    if (scripted === 'reject') {
      // 真实浏览器在未静音自动播放被拦下时就是这个形状：NotAllowedError。
      this.paused = true
      const error = new Error('play() failed because the user agent did not allow it')
      error.name = 'NotAllowedError'
      return Promise.reject(error)
    }
    if (scripted === 'pending') {
      // 既不 resolve 也不 reject：加载慢或与别的东西抢媒体时真会这样。
      this.paused = false
      return new Promise(() => {})
    }
    this.paused = false
    return Promise.resolve()
  }

  pause() {
    this.pauseCalls += 1
    this.paused = true
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector) {
    const matches = compileSelector(selector)
    const out = []
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child instanceof StubElement) {
          if (matches(child)) out.push(child)
          walk(child)
        }
      }
    }
    walk(this)
    return out
  }

  closest(selector) {
    const matches = compileSelector(selector)
    let node = this
    while (node instanceof StubElement) {
      if (matches(node)) return node
      node = node.parentNode
    }
    return null
  }
}

/** MutationObserver 替身：只提供脚本需要的形状（轮询兜底会覆盖真正的判定）。 */
class StubMutationObserver {
  constructor(callback) {
    this.callback = callback
    this.targets = []
  }

  observe(target) {
    this.targets.push(target)
  }

  disconnect() {
    this.targets.length = 0
  }

  /** 手动触发一次（测试用）。 */
  trigger() {
    this.callback([])
  }
}

/**
 * 造一套桩环境。
 * @param {{ withBody?: boolean }} [options] 选项。
 * @returns {{ window: object, document: StubElement, clock: Clock, body: StubElement, root: StubElement, run: (text: string, config: object) => object, matchMediaQueries: string[] }} 环境。
 */
export function createHarness(options = {}) {
  const clock = new Clock()
  const documentElement = new StubElement('html', null)
  const head = new StubElement('head', null)
  const body = new StubElement('body', null)
  const root = new StubElement('div', null)
  root.id = 'root'
  documentElement.appendChild(head)
  documentElement.appendChild(body)
  body.appendChild(root)

  const document = {
    documentElement,
    head,
    body: options.withBody === false ? null : body,
    readyState: options.withBody === false ? 'loading' : 'interactive',
    hidden: false,
    /** 新建 `<video>` 时套用的脚本化 play() 行为队列（见 createElement）。 */
    videoPlayBehaviours: options.videoPlayBehaviours,
    listeners: new Map(),
    createElement(tag) {
      const element = new StubElement(tag, document)
      // 让测试能在**元素创建时**就决定它的 play() 会怎么表现 —— 运行时自己建 video 元素，
      // 测试拿不到那个时机。
      if (String(tag).toLowerCase() === 'video' && Array.isArray(document.videoPlayBehaviours)) {
        element.playBehaviours = [...document.videoPlayBehaviours]
      }
      return element
    },
    getElementById(id) {
      return documentElement.querySelector(`#${id}`)
    },
    querySelector(selector) {
      return documentElement.querySelector(selector)
    },
    querySelectorAll(selector) {
      return documentElement.querySelectorAll(selector)
    },
    addEventListener(type, listener, opts) {
      const list = document.listeners.get(type) ?? []
      list.push({ listener, once: Boolean(opts && opts.once) })
      document.listeners.set(type, list)
    },
    removeEventListener(type, listener) {
      const list = document.listeners.get(type) ?? []
      document.listeners.set(
        type,
        list.filter((entry) => entry.listener !== listener),
      )
    },
    dispatchEvent(event) {
      // 修饰键必须和 StubElement 一样透传：document 上挂着窗口级快捷键。
      // `target` 也允许显式指定 —— 捕获阶段的"点外面就收起"靠的就是事件目标。
      for (const entry of [...(document.listeners.get(event.type) ?? [])]) {
        if (entry.once) document.removeEventListener(event.type, entry.listener)
        entry.listener({
          type: event.type,
          target: event.target ?? document,
          key: event.key,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
          preventDefault() {},
          stopPropagation() {},
        })
      }
    },
  }
  documentElement.ownerDocument = document
  head.ownerDocument = document
  body.ownerDocument = document
  root.ownerDocument = document

  const matchMediaQueries = []
  const window = {
    document,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    setInterval: (fn, ms) => clock.setInterval(fn, ms),
    clearInterval: (id) => clock.clearInterval(id),
    requestAnimationFrame: (fn) => clock.requestAnimationFrame(fn),
    cancelAnimationFrame: (id) => clock.cancelAnimationFrame(id),
    addEventListener(type, listener) {
      document.addEventListener(type, listener)
    },
    matchMedia(query) {
      matchMediaQueries.push(query)
      const matches = Boolean(options.reducedMotion) && String(query).includes('reduced-motion')
      return { matches, addEventListener() {}, removeEventListener() {} }
    },
    fetch() {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) })
    },
    console: { log() {}, error() {}, warn() {} },
    location: { search: '' },
    MutationObserver: StubMutationObserver,
    Date,
  }
  document.window = window

  /**
   * 用桩环境执行一次运行时脚本。
   * @param {string} text `runtime/skin.js` 的原文。
   * @param {object} config 页面侧配置。
   * @returns {object} 桩环境里的 globalThis。
   */
  const run = (text, config) => {
    window.__DSH_VIDEO_SKIN__ = config
    // 形参名 globalThis 会遮蔽真正的全局对象，脚本里的 `globalThis` 因此指向桩环境。
    const factory = new Function('globalThis', 'window', 'self', text)
    factory(window, window, window)
    return window
  }

  return { window, document, clock, body, root, head, documentElement, run, matchMediaQueries }
}

/**
 * 把一个元素从父节点摘掉，模拟内核启动页被应用替换。
 * @param {StubElement} parent 父节点。
 * @param {StubElement} child 要移除的子节点。
 */
export function detach(parent, child) {
  parent.removeChild(child)
}

/** 造一个带 `data-dsh-boot` 的启动页元素（内核启动页的替身）。 */
export function makeKernelBootPage(document) {
  const bootEl = document.createElement('div')
  bootEl.setAttribute('data-dsh-boot', '')
  const spinner = document.createElement('div')
  spinner.setAttribute('data-dsh-boot-spinner', '')
  bootEl.appendChild(spinner)
  return bootEl
}
