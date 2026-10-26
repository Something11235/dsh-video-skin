/*
 * dsh-video-skin — 注入到 index.html 的浏览器运行时。
 *
 * 这个文件是**脚本文本**，不是模块：宿主把它整个读出来，作为一个
 * `{ kind: 'script', placement: 'body' }` 的结构化注入行塞进 index.html。
 *
 * 为什么是内联文本行而不是 `script-src` 行（这条是硬约束，别改）：
 * 桌面壳（Electron）的 index.html 由安装包静态 dist 直出，`webServer.tapIndex()`
 * 永远不生效，唯一通道是 `webserver/index-inject` 的结构化行，经 IPC 交给页面侧
 * 解释器逐行应用；而那个解释器对两种 script 行的处理不对称——
 *   kind:'script'     → createElement + textContent + append，没有 await，不可能失败
 *   kind:'script-src' → await loadScript(src)，失败即 reject，而那个 reject 会把
 *                        __DSH_BOOT_READY__ 打掉 ⇒ 整个应用起不来
 * 所以：**永远不要在这里改用 script-src**，也不要让本文件在求值时抛异常。
 *
 * 它做的两件事：
 *   ① 开机动画：一屏全窗短片，片尾交叉溶解进界面，点击/按键随时跳过；
 *   ② 聊天背景：短片循环铺满视口，界面表面半透明化（见 skin.css），视频**无声音**。
 *
 * 设计原则（都来自踩过的坑）：
 *   - 这块屏是装饰品，**没有任何一种失败可以合理地扣住用户**：素材请求挂住、片子
 *     一帧都出不来、时长未知、内核一直不就绪、内核启动失败——每一条都有上界，
 *     并且点击/按键在任何阶段都能立刻进入。
 *   - 淡出是一个"整体"：底色、短片、UI 一起淡，淡完把节点从 DOM 移除，不留下
 *     任何盖住界面的东西。
 *   - 片尾交叉溶解按**真实剩余时间**触发（每帧检查），不是提前排一个定时器——
 *     定时器在播放卡顿时会偏，而"正好落在最后一帧"正是这里唯一要买的东西。
 *   - 覆盖层挂在 document.body 上、**不放进 #root**：内核用 hydrateRoot 接管
 *     #root 里已有的启动页 DOM，往里塞节点会造成 hydration 内容不匹配。
 */

;(function (global) {
  'use strict'

  var NS = '__DSH_VIDEO_SKIN__'

  // 已经跑过一次就不再重复（重复挂载/重复注入行都能安全忽略）。
  if (global.__DSH_VIDEO_SKIN_STARTED__ === true) return
  var cfg = global[NS]
  if (cfg === null || typeof cfg !== 'object') return
  if (typeof global.document !== 'object' || global.document === null) return
  global.__DSH_VIDEO_SKIN_STARTED__ = true

  var doc = global.document
  var bootCfg = isObject(cfg.boot) ? cfg.boot : {}
  var configUrl = typeof cfg.config === 'string' ? cfg.config : ''
  var VERSION = typeof cfg.version === 'string' ? cfg.version : 'unknown'

  var api = {
    version: VERSION,
    config: cfg,
    /** 覆盖层的当前状态（诊断用）。 */
    state: {
      phase: 'idle',
      clipDone: false,
      appReady: false,
      entered: false,
      reason: null,
      failures: [],
      lastStallAt: null,
    },
    /** 重新应用一次可运行时变更的项（蒙版/表面不透明度/背景素材）。 */
    applyLive: function (next) {
      if (isObject(next)) {
        liveCfg = mergeConfig(liveCfg, next)
        api.config = liveCfg
      }
      if (backdrop !== null) applyVisuals(liveCfg)
    },
    /** 拆掉背景层并把界面恢复成原生样式。 */
    teardown: teardownBackdrop,
    /**
     * 测试用的内部钩子。只暴露**纯函数**，不暴露 DOM：DOM 那一半由
     * `scripts/verify-browser.mjs` 在真浏览器里跑，这里只让单元测试能把数学钉死。
     */
    __test: {
      contrastStats: function (pixels, veil, surface, label) {
        return contrastStats(pixels, veil, surface, label)
      },
      parseColor: function (css) {
        return parseColor(css)
      },
      currentKnobs: function () {
        return currentKnobs()
      },
    },
  }
  global[NS] = api

  var liveCfg = cfg
  var backdrop = null
  /** 背景层正在等运行期配置，防止 `startBackdrop` 被并发调用建出两层。 */
  var backdropStarting = false
  /**
   * 注入行里那份**部署期快照**的背景段。
   *
   * "恢复默认"在拿不到宿主应答时要用它 —— 那是这台机器上"用户没有覆盖过"的真实起点，
   * 而不是代码里写死的数字。
   */
  var injectedBackground = isObject(cfg.background) ? assign({}, cfg.background) : {}

  // ────────────────────────────── 小工具 ──────────────────────────────

  function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  /** 与宿主侧 `clampNumber` 同语义：NaN 用默认值，±Infinity 夹到边界。 */
  function num(value, fallback, min, max) {
    var n = typeof value === 'number' ? value : Number(value)
    if (n !== n) return fallback
    if (n < min) return min
    if (n > max) return max
    return n
  }

  function mergeConfig(base, patch) {
    var out = {}
    var key
    for (key in base) if (Object.prototype.hasOwnProperty.call(base, key)) out[key] = base[key]
    for (key in patch) if (Object.prototype.hasOwnProperty.call(patch, key)) out[key] = patch[key]
    out.boot = isObject(patch.boot) ? assign(assign({}, base.boot), patch.boot) : base.boot
    out.background = isObject(patch.background)
      ? assign(assign({}, base.background), patch.background)
      : base.background
    return out
  }

  function assign(target, source) {
    for (var key in source) if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key]
    return target
  }

  function el(tag, className, text) {
    var node = doc.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function noop() {}

  function safe(fn, label) {
    return function () {
      try {
        return fn.apply(null, arguments)
      } catch (error) {
        var failures = api.state.failures
        failures.push(label + ':' + ((error && error.message) || String(error)))
        if (global.console && global.console.error) global.console.error('[video-skin] ' + label, error)
        return undefined
      }
    }
  }

  function raf(fn) {
    if (typeof global.requestAnimationFrame === 'function') return global.requestAnimationFrame(fn)
    return global.setTimeout(fn, 50)
  }

  /** 诊断开关：地址加 ?dsvsdiag=1，提示行变成实时读数。 */
  var DIAG = false
  try {
    DIAG = String((global.location && global.location.search) || '').indexOf('dsvsdiag=1') >= 0
  } catch (error) {
    DIAG = false
  }

  // ─────────────────────────── ① 开机动画覆盖层 ───────────────────────────

  var boot = null

  function startBootSurface() {
    if (bootCfg.enabled === false || boot !== null) return null
    var src = typeof bootCfg.src === 'string' ? bootCfg.src : ''
    if (src === '') return null

    var fadeMs = num(bootCfg.fadeMs, 1000, 200, 6000)
    /** `end`（默认，放完再淡）/ `tail`（片尾交叉溶解）。 */
    var exitMode = bootCfg.exitMode === 'tail' ? 'tail' : 'end'
    var skipFadeMs = num(bootCfg.skipFadeMs, 320, 80, 2000)
    var holdMs = num(bootCfg.holdMs, 18000, 4000, 120000)
    var holdGraceMs = num(bootCfg.holdGraceMs, 4000, 0, 30000)
    var noFrameMs = num(bootCfg.noFrameMs, 12000, 1500, 30000)
    var endlessMs = num(bootCfg.endlessMs, 20000, 5000, 60000)
    var hintIdle = typeof bootCfg.hint === 'string' && bootCfg.hint ? bootCfg.hint : '正在启动…'
    var wantSound = bootCfg.sound !== false
    var volume = num(bootCfg.volume, 1, 0, 1)

    var root = el('div', 'dsvs-boot')
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-label', '启动动画')
    root.setAttribute('data-state', 'idle')
    root.style.setProperty('--dsvs-boot-fade', fadeMs + 'ms')

    var veil = el('div', 'dsvs-boot-veil')
    var ui = el('div', 'dsvs-boot-ui')
    var bar = el('div', 'dsvs-boot-bar')
    var fill = el('div', 'dsvs-boot-fill')
    bar.appendChild(fill)
    var hint = el('div', 'dsvs-boot-hint', hintIdle)
    ui.appendChild(bar)
    ui.appendChild(hint)

    var skip = el('div', 'dsvs-boot-skip')
    skip.appendChild(el('span', 'dsvs-boot-skip-glyph', '▶'))
    skip.appendChild(
      el('span', null, typeof bootCfg.skipLabel === 'string' && bootCfg.skipLabel ? bootCfg.skipLabel : '点击画面跳过'),
    )

    // 声音开关是**独立**的命中区：点它只开声音、不跳过。
    // 浏览器把未静音的自动播放拦下来时它才出现，所以默认是隐藏的。
    var soundButton = el('div', 'dsvs-boot-sound')
    soundButton.setAttribute('data-visible', '0')
    soundButton.appendChild(el('span', 'dsvs-boot-sound-glyph', '🔇'))
    soundButton.appendChild(
      el(
        'span',
        null,
        typeof bootCfg.soundLabel === 'string' && bootCfg.soundLabel ? bootCfg.soundLabel : '开启声音',
      ),
    )

    root.appendChild(veil)
    root.appendChild(ui)
    root.appendChild(skip)
    root.appendChild(soundButton)

    var state = {
      video: null,
      leaving: false,
      clipDone: false,
      appReady: false,
      playing: false,
      revealed: false,
      failed: false,
      /** 声音是否被浏览器拦下（null = 没被拦）。 */
      audioBlocked: null,
      /** 当前实际是否静音。 */
      silenced: false,
      timers: [],
      frameTimer: null,
      progressTimer: null,
      failTimer: null,
      readyObserver: null,
    }

    function timer(fn, ms) {
      var id = global.setTimeout(fn, ms)
      state.timers.push(id)
      return id
    }

    function clearTimers() {
      for (var i = 0; i < state.timers.length; i += 1) global.clearTimeout(state.timers[i])
      state.timers.length = 0
      if (state.progressTimer !== null) global.clearInterval(state.progressTimer)
      if (state.readyObserver !== null && typeof state.readyObserver.disconnect === 'function') {
        state.readyObserver.disconnect()
      }
      state.progressTimer = null
      state.readyObserver = null
    }

    function setHint(text) {
      if (DIAG) return
      hint.textContent = text
    }

    function attention(text) {
      root.setAttribute('data-attention', '1')
      setHint(text)
    }

    /**
     * 淡出并交接。
     *
     * 传进来的 `span` **永远是配置里的固定时长**（`fadeMs` 或 `skipFadeMs`），
     * 不是"距离片子结束还剩多久" —— 后者会缩到 100ms 级别，看起来就是硬切。
     * @param {number} span 淡出时长（毫秒）。
     * @param {string} reason 诊断用的原因标签。
     */
    function enter(span, reason) {
      if (state.leaving) return
      state.leaving = true
      api.state.phase = 'leaving'
      api.state.entered = true
      api.state.reason = reason
      var ms = Math.round(num(span, fadeMs, 80, 6000))
      root.style.setProperty('--dsvs-boot-fade', ms + 'ms')
      root.setAttribute('data-state', 'leaving')
      // 有声音时把音量一起淡到 0，而不是让画面淡完、声音被 pause 硬切。
      fadeAudio(ms)
      clearTimers()
      // 留一条能查的痕迹：为什么退场、退场时片子放到哪了。
      // 用户报"动画被切掉"时，这一行就能区分"放完了"和"被超时/出错打断了"。
      try {
        var media = state.video
        if (global.console && global.console.info) {
          global.console.info(
            '[video-skin] boot overlay leaving: reason=' + reason +
              ' fade=' + ms + 'ms' +
              ' t=' + (media && isFinite(media.currentTime) ? media.currentTime.toFixed(2) : '?') +
              ' dur=' + (media && isFinite(media.duration) ? media.duration.toFixed(2) : '?') +
              ' clipDone=' + state.clipDone +
              ' appReady=' + state.appReady,
          )
        }
      } catch (error) {
        /* 只是日志 */
      }
      timer(function () {
        try {
          if (root.parentNode) root.parentNode.removeChild(root)
        } catch (error) {
          /* 已经不在了 */
        }
        // 视频留在覆盖层里一起淡出（交叉溶解要的就是这个）；淡完才真正暂停。
        if (state.video !== null) {
          try {
            state.video.pause()
          } catch (error) {
            /* 没在播的元素不需要 pause */
          }
        }
        api.state.phase = 'gone'
        global[NS + '_BOOT_DONE'] = true
        startBackdrop()
      }, ms + 140)
    }

    /**
     * 把音量在 `ms` 内线性淡到 0。
     *
     * 用"帧数"而不是挂钟时间推进：虚拟时钟下才可测，而且它天然跟着 rAF 的实际节奏走。
     * @param {number} ms 淡出总时长。
     */
    function fadeAudio(ms) {
      var video = state.video
      if (video === null || video.muted === true) return
      var from
      try {
        from = video.volume
      } catch (error) {
        return
      }
      if (!(from > 0)) return
      var frames = Math.max(1, Math.round(ms / 16))
      var done = 0
      var step = function () {
        if (state.video !== video) return
        done += 1
        try {
          video.volume = Math.max(0, from * (1 - done / frames))
        } catch (error) {
          return
        }
        if (done < frames) raf(step)
      }
      raf(step)
    }

    /** 带声音播放被拒时，把那个独立开关显示出来，并把状态文字说清楚。 */
    function markAudioBlocked(reason) {
      state.audioBlocked = reason
      soundButton.setAttribute('data-visible', '1')
      root.setAttribute('data-muted', '1')
      if (!state.failed) setHint('浏览器拦下了自动播放的声音 · 点左下角开声音')
    }

    /** 用户按了声音开关：只开声音，不跳过。 */
    function toggleSound() {
      var video = state.video
      if (video === null || state.leaving) return
      try {
        video.muted = false
        video.volume = volume
      } catch (error) {
        return
      }
      var played = video.play()
      var settle = function (ok) {
        if (!ok) {
          state.audioBlocked = 'retry-refused'
          soundButton.setAttribute('data-visible', '1')
          setHint('系统拒绝了声音播放（检查一下系统/浏览器音量权限）')
          return
        }
        state.audioBlocked = null
        state.silenced = false
        soundButton.setAttribute('data-visible', '0')
        root.removeAttribute('data-muted')
        if (!state.failed) setHint('声音已开 · 点画面跳过')
      }
      if (played && typeof played.then === 'function') played.then(function () { settle(true) }, function () { settle(false) })
      else settle(true)
    }

    /** 两个条件同时成立才交接：片子放完 + 界面真的挂上来了。 */
    function maybeEnter() {
      if (state.leaving || state.failed) return
      if (!state.clipDone) return
      if (!state.appReady) {
        setHint('界面就绪后自动进入')
        return
      }
      enter(fadeMs, 'end')
    }

    /**
     * 片尾交叉溶解（只在 `exitMode: 'tail'` 时启用）。
     *
     * **淡出时长固定用 `fadeMs`，不再用"当时的真实剩余时间"。** 早先按剩余时间淡，
     * 界面就绪得晚时剩余可能只剩 100~200ms，那次退场看起来就是硬切 —— 用户报的
     * "有时候还没放完就切掉了"正是它。固定时长之后，无论什么时候进入这个窗口，
     * 退场都是同样一段渐变。
     *
     * 用每帧检查而不是提前排定时器：定时器在播放卡顿时就会偏。同时挂在 rAF 和
     * timeupdate 上——前者帧级精确但后台标签页会被节流，后者粗糙但那时还有效。
     */
    function tailCheck() {
      var video = state.video
      if (exitMode !== 'tail') return
      if (state.leaving || video === null || !state.playing) return
      if (!state.appReady || state.entered) return
      if (!isFinite(video.duration) || video.duration <= 0) return
      // 片子短于 2×淡出时长：溶解得从片子还没出现时就开始，那是坏效果 —— 改成放完再淡。
      if (video.duration * 1000 < fadeMs * 2) return
      var remaining = (video.duration - video.currentTime) * 1000
      if (remaining > fadeMs || remaining <= 0) return
      enter(fadeMs, 'tail')
    }

    function frameLoop() {
      tailCheck()
      // `end` 模式下没有"片尾窗口"要盯，就别每帧空转。
      if (!state.leaving && exitMode === 'tail') state.frameTimer = raf(frameLoop)
    }

    function markClipDone(reason) {
      if (state.clipDone) return
      state.clipDone = true
      api.state.clipDone = true
      api.state.failures.push('clip-done:' + reason)
      maybeEnter()
    }

    /** 有画面可看 ≠ play() 的 promise resolve。用"已解码到第一帧"的任一证据。 */
    function whenFramePresents(video, done) {
      var fired = false
      var once = function () {
        if (fired) return
        fired = true
        done()
      }
      if (video.readyState >= 2) {
        once()
        return
      }
      video.addEventListener('loadeddata', once, { once: true })
      video.addEventListener('canplay', once, { once: true })
      if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(once)
      video.addEventListener('timeupdate', function () {
        if (video.currentTime > 0) once()
      })
    }

    /**
     * 内核就绪的判据。
     *
     * 页面加载那一刻 #root 是空的（内核启动页还没建），所以"没有 [data-dsh-boot]"
     * 不能当就绪——那会在第一帧就误判。真正的信号是：**内核启动页出现过、然后被
     * 应用替换掉了**（uiRenderer.mount 用 hydrateRoot 接管 #root 里的启动页 DOM，
     * BootHandoff 在 layout effect 之后把它换成真正的应用树）。
     */
    function detectAppReady() {
      var container = doc.getElementById('root')
      if (container === null || container === undefined) return false
      var children = container.children
      if (children === undefined || children.length === 0) return false
      for (var i = 0; i < children.length; i += 1) {
        var child = children[i]
        if (child && typeof child.hasAttribute === 'function' && !child.hasAttribute('data-dsh-boot')) {
          return true
        }
      }
      return false
    }

    function markAppReady(why) {
      if (state.appReady) return
      state.appReady = true
      api.state.appReady = true
      api.state.failures.push('app-ready:' + why)
      if (!state.failed) setHint('正在进入…')
      maybeEnter()
      // 就绪那一刻正好落在片尾窗口里时，推一把，而不是等下一帧被调度到。
      tailCheck()
    }

    function watchAppReady() {
      var ContainerCtor = global.MutationObserver
      if (typeof ContainerCtor === 'function') {
        try {
          state.readyObserver = new ContainerCtor(function () {
            if (detectAppReady()) markAppReady('mutation')
          })
          var container = doc.getElementById('root')
          if (container !== null && container !== undefined) {
            state.readyObserver.observe(container, { childList: true })
          }
        } catch (error) {
          state.readyObserver = null
        }
      }
      var poll = function () {
        if (state.leaving) return
        if (detectAppReady()) {
          markAppReady('poll')
          return
        }
        timer(poll, 120)
      }
      timer(poll, 120)
    }

    /** 内核启动失败：它把启动页的卡片换成失败清单并且永远不挂应用。 */
    function watchFailure() {
      var check = function () {
        if (state.leaving || state.failed) return
        var bootEl = doc.querySelector('[data-dsh-boot]')
        if (bootEl === null || bootEl === undefined) return
        var text = bootEl.textContent || ''
        if (text.indexOf('Failed to load plugins') < 0 && text.indexOf('did not activate') < 0) return
        state.failed = true
        api.state.failures.push('kernel-failed')
        attention('启动失败 · 点击查看')
        // 界面永远不来了，2.6 秒后自动让开，用户才能读到失败原因。
        timer(function () {
          enter(fadeMs, 'failed')
        }, 2600)
      }
      var id = global.setInterval(check, 400)
      state.timers.push(id)
    }

    /** 内核自己写的真实启动进度（启动页 spinner 上的 --dsh-boot-arc：72° 空 → 288° 满）。 */
    function watchProgress() {
      var arcMin = 72
      var arcSpan = 216
      var update = function () {
        if (state.leaving) return
        var spinner = doc.querySelector('[data-dsh-boot-spinner]')
        if (spinner === null || spinner === undefined || !spinner.style) return
        var raw = parseFloat(
          typeof spinner.style.getPropertyValue === 'function'
            ? spinner.style.getPropertyValue('--dsh-boot-arc')
            : '',
        )
        var ratio = isFinite(raw) ? Math.min(Math.max((raw - arcMin) / arcSpan, 0), 1) : 0
        fill.style.width = (ratio * 100).toFixed(1) + '%'
      }
      update()
      state.progressTimer = global.setInterval(update, 200)
    }

    function startDiagnostics() {
      if (!DIAG) return
      global.setInterval(function () {
        if (state.leaving) return
        var video = state.video
        hint.textContent =
          'diag phase=' + api.state.phase +
          ' ready=' + (state.appReady ? 1 : 0) +
          ' done=' + (state.clipDone ? 1 : 0) +
          ' t=' + (video ? (video.currentTime || 0).toFixed(2) : '-') +
          ' dur=' + (video && isFinite(video.duration) ? video.duration.toFixed(2) : '?') +
          ' rs=' + (video ? video.readyState : '-') +
          ' paused=' + (video ? video.paused : '-') +
          ' err=' + (video && video.error ? video.error.code : '-') +
          ' exit=' + exitMode +
          ' why=' + (api.state.reason || '-') +
          ' log=' + api.state.failures.join(',')
      }, 700)
    }

    function mountVideo() {
      var video = doc.createElement('video')
      video.className = 'dsvs-boot-video'
      // 先按配置决定静音状态：桌面版（Electron 默认 no-user-gesture-required）能直接带声播，
      // 普通浏览器会被拒 —— 那条路上自动退回静音并亮出独立的声音开关。
      state.silenced = !wantSound
      video.muted = state.silenced
      video.defaultMuted = state.silenced
      video.volume = volume
      video.loop = false
      video.playsInline = true
      video.autoplay = false
      video.preload = 'auto'
      video.setAttribute('playsinline', '')
      if (state.silenced) video.setAttribute('muted', '')
      video.setAttribute('aria-hidden', 'true')
      state.video = video

      var advance = timer(function () {
        api.state.failures.push('no-frame')
        markClipDone('no-frame')
      }, noFrameMs)

      // 时长未知（MediaRecorder 的 WebM 会报 duration=Infinity）永远不触发 ended，
      // 无限等下去会把用户永久扣在这块屏上，所以只有这一种情况给一个上界。
      var endless = null
      video.addEventListener('loadedmetadata', function () {
        if (isFinite(video.duration)) return
        endless = timer(function () {
          markClipDone('endless')
        }, endlessMs)
      })
      video.addEventListener('ended', function () {
        if (endless !== null) global.clearTimeout(endless)
        markClipDone('ended')
      })
      // 素材出错时**先重试一次**再放弃。
      //
      // 为什么值得重试：宿主刚启动时正忙着激活插件，这条本地素材路由偶尔会应答不上
      // （连接被重置 / 一时 5xx）。早先一次 error 就直接 markClipDone ⇒ 界面一就绪
      // 立刻退场，表现就是"开机动画有时候还没放完就切了"。重试一次能吃掉绝大多数
      // 这种瞬时抖动，而且只重试一次，不会把坏素材拖成长等待。
      var errorRetries = 0
      video.addEventListener('error', function () {
        global.clearTimeout(advance)
        if (endless !== null) global.clearTimeout(endless)
        var code = video.error ? video.error.code : 0
        api.state.failures.push('video-error:' + code)
        if (errorRetries >= 1) {
          markClipDone('error')
          return
        }
        errorRetries += 1
        api.state.failures.push('video-error-retry')
        try {
          video.src = src
          var again = video.play()
          if (again && typeof again.catch === 'function') again.catch(noop)
        } catch (error) {
          markClipDone('error-retry-throw')
        }
        // 重试也给一个新的"一帧都没出"看门狗，否则第一只已经被清掉了。
        advance = timer(function () {
          api.state.failures.push('no-frame-after-retry')
          markClipDone('no-frame-after-retry')
        }, noFrameMs)
      })
      video.addEventListener('stalled', function () {
        api.state.lastStallAt = Date.now()
      })
      video.addEventListener('timeupdate', tailCheck)

      // 有画面之后才显形：留着透明元素等第一帧，避免出现"已经在播但什么都没有"
      // 的状态被当成成功。
      whenFramePresents(video, function () {
        global.clearTimeout(advance)
        state.revealed = true
        video.setAttribute('data-shown', '1')
      })

      root.insertBefore(video, veil)

      // 先给 src 再 play：对一个还没有源的元素调 play() 只会得到一个立即 reject 的
      // promise，那会被当成"素材坏了"从而白白丢掉整段动画。
      video.src = src

      /**
       * 起播。**先试带声音**，被拒才退回静音。
       *
       * 顺序很要紧：先静音再找机会开声音（早期版本的做法）等于在所有机器上都把片子静音了，
       * 包括本来就允许出声的那些（Electron 桌面版就是其中之一）。而未静音的 `play()` 也
       * 可能既不 resolve 也不 reject（加载慢 / 与别的东西抢媒体），所以给一个短窗口兜底，
       * 到点就按"被拒"处理 —— 否则这块屏会停在裸底色上，既没画面也没错误。
       */
      var fallbackToMuted = function (reason) {
        state.audioBlocked = reason
        state.silenced = true
        try {
          video.muted = true
          video.setAttribute('muted', '')
        } catch (error) {
          /* 尽力而为 */
        }
        markAudioBlocked(reason)
        var retry = video.play()
        if (retry && typeof retry.catch === 'function') {
          retry.catch(function () {
            api.state.failures.push('muted-play-refused')
            markClipDone('muted-play-refused')
          })
        }
      }

      if (state.silenced) {
        var muted = video.play()
        if (muted && typeof muted.catch === 'function') {
          muted.catch(function () {
            api.state.failures.push('muted-play-refused')
            markClipDone('muted-play-refused')
          })
        }
      } else {
        var soundWindow = timer(function () {
          fallbackToMuted('timeout')
        }, 1200)
        var settleSound = function (ok) {
          global.clearTimeout(soundWindow)
          state.audioBlocked = ok ? null : 'refused'
          if (!ok) fallbackToMuted('refused')
        }
        var unmuted
        try {
          unmuted = video.play()
        } catch (error) {
          unmuted = undefined
        }
        if (unmuted && typeof unmuted.then === 'function') {
          unmuted.then(function () { settleSound(true) }, function () { settleSound(false) })
        } else if (unmuted === undefined) {
          settleSound(false)
        } else {
          settleSound(true)
        }
      }

      // "已经开始播"是给片尾检查用的乐观标记：真的播不出来时上面的失败分支会把
      // clipDone 打开，交接照样发生，不会卡住。
      state.playing = true
      raf(frameLoop)
    }

    // 立刻占住视口（同步，先于任何网络请求），然后才开始加载素材。
    try {
      doc.body.appendChild(root)
    } catch (error) {
      return null
    }
    api.state.phase = 'surface'
    watchProgress()
    watchAppReady()
    watchFailure()
    startDiagnostics()
    mountVideo()

    // 内核一直不就绪时的上界。
    //
    // 这里**不再当场切掉**：早先是"到点立刻 enter()"，于是超时正好落在动画中间时，
    // 用户看到的就是"还没放完就切了"（慢启动的机器上偶发）。现在分两步：
    //   ① 到点只把状态转成"启动较慢"，并把 appReady 标记为真 —— 如果片子还在放，
    //      它就继续放，放完自然会淡出交接；
    //   ② 再给 `holdGraceMs` 宽限，到点才真的让开。
    // 这块屏是装饰品，但"装饰品被拦腰截断"和"多等 4 秒"相比，后者体面得多。
    timer(function () {
      if (state.leaving || state.appReady) return
      state.failed = false
      attention('启动较慢，正在进入…')
      state.appReady = true
      api.state.appReady = true
      api.state.failures.push('hold-timeout')
      maybeEnter()
      if (state.leaving) return
      timer(function () {
        if (state.leaving) return
        api.state.failures.push('hold-grace-exhausted')
        enter(fadeMs, 'hold-timeout')
      }, holdGraceMs)
    }, holdMs)

    // 点击/触摸/按键：任何阶段都立刻跳过。**只有声音开关例外** —— 它的唯一职责是开声音，
    // 所以它有自己的命中区，点它不会跳过（两个意图不互相踩）。
    root.addEventListener(
      'pointerdown',
      function (event) {
        if (onSoundControl(event)) return
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        if (!state.leaving) enter(skipFadeMs, 'skip')
      },
      true,
    )
    root.addEventListener('click', function (event) {
      if (onSoundControl(event)) return
      if (event && typeof event.preventDefault === 'function') event.preventDefault()
      if (!state.leaving) enter(skipFadeMs, 'skip')
    })

    /**
     * 命中测试：事件有没有落在声音开关上。
     *
     * 覆盖层是在 **capture 阶段**监听 pointerdown 的，所以它的处理器永远早于按钮自己的处理器；
     * 只靠 `stopPropagation` 是拦不住的（按钮根本还没轮到）。判据只能看事件目标本身。
     * @param {any} event 事件。
     * @returns {boolean} 是否属于声音开关。
     */
    function onSoundControl(event) {
      var node = event && event.target
      return !!(node && typeof node.closest === 'function' && node.closest('.dsvs-boot-sound'))
    }

    soundButton.addEventListener('pointerdown', function (event) {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
    })
    soundButton.addEventListener('click', function (event) {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
      if (event && typeof event.preventDefault === 'function') event.preventDefault()
      toggleSound()
    })

    var onKey = function (event) {
      if (!event || state.leaving) return
      if (event.key === 'Escape' || event.key === ' ' || event.key === 'Enter') {
        enter(skipFadeMs, 'skip-key')
      }
    }
    try {
      global.addEventListener('keydown', onKey)
    } catch (error) {
      /* 没有 window 也无所谓 */
    }

    boot = { state: state, enter: enter }
    return boot
  }

  // ─────────────────────────── ② 聊天背景 ───────────────────────────

  function applyVisuals(config) {
    var bg = isObject(config.background) ? config.background : {}
    var surface = num(bg.surface, 0.2, 0, 1)
    var veil = num(bg.veil, 0.14, 0, 0.92)
    // 暗色和亮色的表面**不能共用一个值**，这是实测出来的：
    //   暗主题 = 浅色文字 + 深色表面。表面薄一点，底色还是被深色表面压住，对比度掉得慢。
    //   亮主题 = 深色文字 + 白色表面。视频整体偏暗（这条素材 YAVG≈0.25），白面一薄，
    //            有效底色就变成中灰，深色文字立刻掉到 3:1 以下。
    // 所以亮主题默认更实（surface + 0.4），用一个只压暗主题的旋钮是调不出两边都行的。
    var surfaceLight = num(bg.surfaceLight, Math.min(1, surface + 0.4), 0, 1)
    var veilLight = num(bg.veilLight, veil * 0.7, 0, 0.92)
    var root = doc.documentElement
    if (root && root.style && typeof root.style.setProperty === 'function') {
      // 派生值在这里算好、写成独立变量：颜色函数里不出现 calc()，值本身也可被断言。
      //
      // **只有"画布"和"侧栏"跟着 surface 滑块走**；`layer1/2/3`（对话框、弹层、菜单、
      // 卡片、设置页）由**另一个**旋钮 `panel` 控制，而且**默认 1 = 完全不覆盖**，
      // 保留内核原生不透明色。原因见 skin.css 里那段注释。
      var setSurface = function (prefix, base) {
        root.style.setProperty(prefix + 'surface', String(base))
        root.style.setProperty(prefix + 'sidebar', String(Math.min(1, base + 0.06)))
      }
      setSurface('--dsvs-', surface)
      setSurface('--dsvs-l-', surfaceLight)

      // 抬起来的表面：panel=1 就**不覆盖**（去掉 data-dsvs-panel，CSS 里那两条规则不生效）；
      // panel<1 时才写派生值并挂上属性。用属性开关而不是把值写成 1：
      // 写 1 也等于不透明，但那用的是我们估的颜色，不是内核原生色。
      var panel = num(bg.panel, 1, 0, 1)
      if (panel < 0.999) {
        // 三位小数：0.6 + 0.06 在浮点里是 0.6599999999999999，写进 CSS 难看也不好断言。
        var round3 = function (value) {
          return String(Math.round(Math.min(1, value) * 1000) / 1000)
        }
        root.style.setProperty('--dsvs-panel-1', round3(panel))
        root.style.setProperty('--dsvs-panel-2', round3(panel + 0.06))
        root.style.setProperty('--dsvs-panel-3', round3(panel + 0.1))
        root.setAttribute('data-dsvs-panel', 'on')
      } else {
        root.removeAttribute('data-dsvs-panel')
        root.style.removeProperty('--dsvs-panel-1')
        root.style.removeProperty('--dsvs-panel-2')
        root.style.removeProperty('--dsvs-panel-3')
      }

      root.style.setProperty('--dsvs-veil', String(veil))
      root.style.setProperty('--dsvs-l-veil', String(veilLight))
    }
  }

  function teardownBackdrop() {
    if (backdrop === null) return
    try {
      if (backdrop.video) {
        try {
          backdrop.video.pause()
        } catch (error) {
          /* 已经停了 */
        }
        backdrop.video.removeAttribute('src')
      }
      if (backdrop.layer && backdrop.layer.parentNode) backdrop.layer.parentNode.removeChild(backdrop.layer)
    } catch (error) {
      /* 尽力而为 */
    }
    // 透明度控件也要跟着走：它属于这块背景，背景没了它就没有意义，
    // 留下来会变成一个点了没反应的圆钮。
    try {
      if (knobObserver !== null && typeof knobObserver.disconnect === 'function') knobObserver.disconnect()
      knobObserver = null
      for (var index = 0; index < knobListeners.length; index += 1) {
        var entry = knobListeners[index]
        try {
          entry.target.removeEventListener(entry.type, entry.handler, entry.capture)
        } catch (error) {
          /* 尽力而为 */
        }
      }
      knobListeners.length = 0
      var pill = doc.getElementById('dsvs-knobs-pill')
      if (pill !== null) pill.remove()
      var panel = doc.getElementById('dsvs-knobs')
      if (panel !== null) panel.remove()
      // 主题提示同理：它解释的是"为什么界面变深了"，背景层都没了就别留着。
      themeNotice = null
      if (themeTimer !== null) {
        global.clearTimeout(themeTimer)
        themeTimer = null
      }
      var notice = doc.getElementById('dsvs-theme-notice')
      if (notice !== null) notice.remove()
    } catch (error) {
      /* 尽力而为 */
    }
    backdrop = null
    // 撤掉 data-dsvs ⇒ skin.css 里所有表面半透明规则立刻失效，界面回到原生外观。
    try {
      doc.documentElement.removeAttribute('data-dsvs')
    } catch (error) {
      /* 尽力而为 */
    }
    api.state.phase = 'backdrop-teardown'
  }

  /**
   * 只摘掉视频那一层，**不动面板**。
   *
   * 和 `teardownBackdrop()` 的区别：那个是"背景彻底失败/卸载"，连圆钮面板一起拆；
   * 这个是用户自己在面板里点了"关掉聊天背景"，面板必须留着 —— 否则他就没有入口再打开了。
   */
  function detachBackdropMedia() {
    if (backdrop === null) return
    try {
      if (backdrop.video) {
        try {
          backdrop.video.pause()
        } catch (error) {
          /* 已经停了 */
        }
        backdrop.video.removeAttribute('src')
      }
      if (backdrop.cancel) global.clearTimeout(backdrop.cancel)
      if (typeof backdrop.onVisibility === 'function') {
        doc.removeEventListener('visibilitychange', backdrop.onVisibility)
      }
      if (backdrop.layer && backdrop.layer.parentNode) backdrop.layer.parentNode.removeChild(backdrop.layer)
    } catch (error) {
      api.state.failures.push('backdrop-detach')
    }
    backdrop = null
    // 没有画面就不能再让表面半透明，否则界面会变成"没有背景、字还发灰"。
    try {
      doc.documentElement.removeAttribute('data-dsvs')
    } catch (error) {
      /* 尽力而为 */
    }
  }

  /** 面板里点了"关掉/打开聊天背景"之后，把视频层同步上。 */
  function setBackgroundLive(enabled) {
    if (enabled === false) {
      detachBackdropMedia()
      return
    }
    if (backdrop !== null) {
      reloadBackdropVideo()
      return
    }
    // 旧快照里可能还写着 enabled:false，先扳正，否则 buildBackdrop 会再次提前返回。
    if (isObject(liveCfg.background)) liveCfg.background.enabled = true
    api.config = liveCfg
    startBackdrop()
  }

  /** 换了素材 / 重新打开之后，让视频元素重新拉一次（素材路由是 no-store，URL 不变内容会变）。 */
  function reloadBackdropVideo() {
    if (backdrop === null || !backdrop.video) return
    var bg = isObject(liveCfg.background) ? liveCfg.background : {}
    var src = typeof bg.src === 'string' ? bg.src : ''
    if (src === '') return
    try {
      backdrop.video.src = src
      var played = backdrop.video.play()
      if (played && typeof played.catch === 'function') played.catch(noop)
    } catch (error) {
      api.state.failures.push('backdrop-reload')
    }
  }

  /**
   * 拉一次运行期配置（no-store 的 JSON 路由）。
   *
   * 注入行里带的是**宿主启动时的快照**，所以蒙版/表面不透明度这类"看着调"的值如果只认快照，
   * 每次微调都得重启 DSH。这里在建背景层**之前**先问一次：配了 `dsh-video-skin.json`
   * 就立刻生效，刷新页面即可，失败**完全无害**（退回快照值）。
   * @returns {Promise<Record<string, unknown> | null>} 配置，拿不到就是 null。
   */
  function fetchLiveConfig() {
    if (configUrl === '' || typeof global.fetch !== 'function') return Promise.resolve(null)
    return new Promise(function (resolve) {
      var settled = false
      var finish = function (value) {
        if (settled) return
        settled = true
        resolve(value)
      }
      // 不能挂在这上面：素材路由万一没应答，背景层不该永远不出现。
      global.setTimeout(function () {
        finish(null)
      }, 1500)
      try {
        global
          .fetch(configUrl, { cache: 'no-store' })
          .then(function (response) {
            return response && response.ok ? response.json() : null
          })
          .then(
            function (payload) {
              finish(isObject(payload) ? payload : null)
            },
            function () {
              finish(null)
            },
          )
      } catch (error) {
        finish(null)
      }
    })
  }

  function startBackdrop() {
    if (backdrop !== null || backdropStarting) return
    backdropStarting = true
    fetchLiveConfig()
      .then(function (payload) {
        if (isObject(payload)) {
          liveCfg = mergeConfig(liveCfg, payload)
          api.config = liveCfg
        }
      })
      .then(function () {
        backdropStarting = false
        buildBackdrop()
      }, function () {
        backdropStarting = false
        buildBackdrop()
      })
  }

  function buildBackdrop() {
    if (backdrop !== null) return
    var bg = isObject(liveCfg.background) ? liveCfg.background : {}
    var src = typeof bg.src === 'string' ? bg.src : ''
    if (bg.enabled === false || src === '') {
      // 背景关掉了也**必须**把面板挂出来：否则用户点了"关掉聊天背景"就再也没有入口打开了。
      // 这时候没有视频可量对比度，buildControls 会自己降级（传 null）。
      try {
        buildControls(null)
      } catch (error) {
        api.state.failures.push('controls-fatal')
      }
      return
    }
    // 尊重系统的"减少动态效果"：常驻循环动画是这块设置主要管的东西。
    try {
      if (typeof global.matchMedia === 'function' && global.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return
      }
    } catch (error) {
      /* 拿不到就照常播 */
    }
    if (!doc.body) return

    var layer = el('div', null)
    layer.id = 'dsvs-backdrop'
    var video = doc.createElement('video')
    video.id = 'dsvs-backdrop-video'
    video.muted = true
    video.defaultMuted = true
    video.loop = true
    video.playsInline = true
    video.autoplay = false
    video.preload = 'none'
    video.setAttribute('playsinline', '')
    video.setAttribute('muted', '')
    video.setAttribute('aria-hidden', 'true')
    var veil = el('div', null)
    veil.id = 'dsvs-backdrop-veil'

    layer.appendChild(video)
    layer.appendChild(veil)
    doc.body.insertBefore(layer, doc.body.firstChild)
    doc.documentElement.setAttribute('data-dsvs', 'on')
    // 用**已经合并过运行期配置**的值来算，所以不会先建好再跳一下。
    applyVisuals(liveCfg)

    backdrop = { layer: layer, video: video }

    video.addEventListener('loadeddata', function () {
      video.setAttribute('data-shown', '1')
    })
    video.addEventListener('error', function () {
      // 素材拿不到就必须撤掉半透明表面，否则界面会变成"没有背景、字还发灰"。
      api.state.failures.push('backdrop-error:' + (video.error ? video.error.code : 0))
      teardownBackdrop()
    })

    var delayMs = num(bg.delayMs, 1200, 0, 60000)
    var playbackRate = num(bg.playbackRate, 1, 0.25, 4)

    var load = function () {
      if (backdrop === null || backdrop.video !== video) return
      try {
        video.playbackRate = playbackRate
      } catch (error) {
        /* 有的实现不允许在 metadata 之前设置 */
      }
      video.src = src
      var played = video.play()
      if (played && typeof played.catch === 'function') played.catch(noop)
    }
    // 延后加载：开机阶段把带宽和 CPU 留给界面本身。
    var delayTimer = global.setTimeout(load, delayMs)

    var onVisibility = function () {
      if (backdrop === null) return
      if (doc.hidden === true) {
        try {
          video.pause()
        } catch (error) {
          /* 已经停了 */
        }
      } else {
        var played = video.play()
        if (played && typeof played.catch === 'function') played.catch(noop)
      }
    }
    doc.addEventListener('visibilitychange', onVisibility)

    // 透明度调节控件（右下角小圆钮 → 滑块面板）。
    try {
      buildControls(video)
    } catch (error) {
      api.state.failures.push('controls-fatal')
    }

    // 主题联动的一次性提示（宿主已经把浅色用户切到深色了，这里告诉他 + 给撤销）。
    try {
      maybeShowThemeNotice()
    } catch (error) {
      api.state.failures.push('theme-notice-fatal')
    }

    return { layer: layer, video: video, cancel: delayTimer, onVisibility: onVisibility }
  }

  // ────────────────────── ③ 主题联动提示 ──────────────────────
  //
  // 两种形态，都由宿主的状态决定（**宿主只在页面来问的这一刻才碰 settings**）：
  //   · mode=ask  ：问一句「切到深色更好看？」点了才改（默认，最保守）；
  //   · mode=auto ：宿主已经切好了，这里只负责告诉他 + 给「恢复浅色」。
  // 都是**一次性**的：点任何一个按钮 / 超时都会让宿主落标记，之后不再出现。

  /** 当前还挂着的提示节点（拆背景层时一起摘掉）。 */
  var themeNotice = null
  /** 提示的延时器（拆背景层时清掉）。 */
  var themeTimer = null

  function maybeShowThemeNotice() {
    var themeCfg = isObject(api.config) && isObject(api.config.theme) ? api.config.theme : {}
    var route = typeof themeCfg.route === 'string' ? themeCfg.route : ''
    var mode = typeof themeCfg.mode === 'string' ? themeCfg.mode : 'off'
    if (mode === 'off' || route === '') return
    if (typeof global.fetch !== 'function') return
    if (doc.getElementById('dsvs-theme-notice') !== null) return

    // 延后一点再问：既让页面先安静下来，也远离宿主的启动握手
    //（0.1.3 的启动崩溃就是因为在启动期就去碰 settings，见 lib/theme.js）。
    themeTimer = global.setTimeout(function () {
      themeTimer = null
      if (typeof global.fetch !== 'function') return
      global
        .fetch(route, { method: 'GET', cache: 'no-store' })
        .then(function (response) {
          return response && response.ok ? response.json() : null
        })
        .then(function (state) {
          if (!isObject(state) || state.ok !== true) return
          if (state.ask === true) {
            renderThemeAsk(route, state)
            return
          }
          if (state.switched === true && state.notified !== true) {
            renderThemeSwitched(route, state)
          }
        })
        .then(undefined, noop)
    }, 1500)
  }

  /** 造那条提示的公共外壳：标题 + 正文 + 两个按钮。 */
  function buildThemeNotice(title, bodyText, actions) {
    if (doc.body === null) return null
    var box = el('div', null)
    box.id = 'dsvs-theme-notice'
    box.setAttribute('role', 'status')
    var text = el('div', 'dsvs-theme-text')
    text.appendChild(el('div', 'dsvs-theme-title', title))
    text.appendChild(el('div', 'dsvs-theme-body', bodyText))
    var row = el('div', 'dsvs-theme-actions')
    for (var index = 0; index < actions.length; index += 1) row.appendChild(actions[index].node)
    box.appendChild(text)
    box.appendChild(row)
    doc.body.appendChild(box)
    themeNotice = box
    return box
  }

  /**
   * 收掉提示并把用户的决定告诉宿主。
   * @param {string} route 主题路由。
   * @param {Element} box 提示节点。
   * @param {string} action 要 POST 的动作。
   */
  function dismissThemeNotice(route, box, action) {
    if (themeNotice !== box) return
    themeNotice = null
    try {
      box.remove()
    } catch (error) {
      /* 已经摘掉 */
    }
    var sent = global.fetch(route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: action }),
    })
    if (sent && typeof sent.catch === 'function') sent.catch(noop)
  }

  /** mode=ask：问一句，点了才切。 */
  function renderThemeAsk(route, state) {
    var previous = state.askPrevious === 'light' ? '浅色' : '跟随系统'
    var yes = el('div', 'dsvs-theme-action dsvs-theme-primary', '切到深色')
    var no = el('div', 'dsvs-theme-action', '保持' + previous)
    var box = buildThemeNotice(
      '深色主题下背景更好看',
      '聊天背景是深色短片，在「' + previous + '」下会被冲得很淡。要切到深色吗？只问一次。',
      [
        { node: no, action: 'keep' },
        { node: yes, action: 'dark' },
      ],
    )
    if (box === null) return
    yes.addEventListener('click', function () {
      dismissThemeNotice(route, box, 'dark')
    })
    no.addEventListener('click', function () {
      dismissThemeNotice(route, box, 'keep')
    })
    // 一直不点就自己收起来，记成"拒绝了"，别再烦人。
    global.setTimeout(function () {
      if (themeNotice === box) dismissThemeNotice(route, box, 'keep')
    }, 25000)
  }

  /** mode=auto：宿主已经切好了，告诉他 + 给一条后路。 */
  function renderThemeSwitched(route, state) {
    var previous = state.previous === 'light' ? '浅色' : '跟随系统'
    var revert = el('div', 'dsvs-theme-action dsvs-theme-revert', '恢复' + previous)
    var keep = el('div', 'dsvs-theme-action dsvs-theme-keep', '保持深色')
    var box = buildThemeNotice(
      '已切换到深色主题',
      '聊天背景是深色短片，浅色主题下会被冲得很淡。原来的偏好是「' + previous + '」。',
      [
        { node: revert, action: 'revert' },
        { node: keep, action: 'notified' },
      ],
    )
    if (box === null) return
    revert.addEventListener('click', function () {
      dismissThemeNotice(route, box, 'revert')
    })
    keep.addEventListener('click', function () {
      dismissThemeNotice(route, box, 'notified')
    })
    global.setTimeout(function () {
      if (themeNotice === box) dismissThemeNotice(route, box, 'notified')
    }, 25000)
  }
  // ────────────────────── ③ 透明度调节（界面滑块） ──────────────────────

  /** 一键预设：[surface, veil]，即"面板不透明度 / 视频蒙版"。 */
  var PRESETS = [
    { id: 'native', label: '接近原生', surface: 0.85, veil: 0.5 },
    { id: 'balanced', label: '均衡', surface: 0.2, veil: 0.14 },
    { id: 'clear', label: '视频最清', surface: 0, veil: 0 },
  ]

  /** 控件挂的主题观察者（拆背景层时要一起断掉）。 */
  var knobObserver = null
  /** 控件挂在 window/document 上的监听者（拆背景层时要一起摘掉，否则会越堆越多）。 */
  var knobListeners = []

  /**
   * 把当前的有效旋钮值取出来（面板初始位置要用）。
   * @returns {{ surface: number, surfaceLight: number, veil: number, veilLight: number, panel: number }} 当前值。
   */
  function currentKnobs() {
    var bg = isObject(liveCfg.background) ? liveCfg.background : {}
    var surface = num(bg.surface, 0.2, 0, 1)
    var veil = num(bg.veil, 0.14, 0, 0.92)
    return {
      surface: surface,
      surfaceLight: num(bg.surfaceLight, Math.min(1, surface + 0.4), 0, 1),
      veil: veil,
      veilLight: num(bg.veilLight, veil * 0.7, 0, 0.92),
      // 抬起来的表面：默认 1 = 原生不透明。
      panel: num(bg.panel, 1, 0, 1),
    }
  }

  /**
   * 把滑块的值写回宿主（`$DSH_HOME/dsh-video-skin.json`）。
   *
   * 失败**完全无害**：本次会话的观感已经立刻生效了，只是下次刷新会回到文件里的值 ——
   * 面板会把"没能存住"这件事说出来，而不是假装成功。
   * @param {Record<string, number>} patch 要写的项。
   * @param {boolean} cleared 是否是"恢复默认"。
   * @returns {Promise<{ ok: boolean, config: Record<string, unknown> | null }>} 是否落到盘上，以及宿主返回的新配置。
   */
  function persistKnobs(patch, cleared) {
    if (typeof global.fetch !== 'function' || typeof liveCfg.override !== 'string') {
      return Promise.resolve({ ok: false, config: null })
    }
    var init = cleared
      ? { method: 'DELETE' }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ background: patch }),
        }
    return global
      .fetch(liveCfg.override, init)
      .then(function (response) {
        return response && response.ok ? response.json() : null
      })
      .then(
        function (payload) {
          return {
            ok: !!(payload && payload.persisted === true),
            config: isObject(payload) && isObject(payload.config) ? payload.config : null,
          }
        },
        function () {
          return { ok: false, config: null }
        },
      )
  }

  /**
   * 对比度的纯计算部分：给一批视频像素和"蒙版/表面/文字色"，算 WCAG 对比度的最小值与 5% 分位。
   *
   * 单独抽出来是为了可测：DOM 那一半（取像素、读计算后的颜色）在**真浏览器**里由
   * `scripts/verify-browser.mjs` 覆盖，而这段数学可以在单元测试里用合成像素钉死。
   * @param {Uint8ClampedArray} pixels RGBA 像素。
   * @param {{ r: number, g: number, b: number, a: number }} veil 蒙版色。
   * @param {{ r: number, g: number, b: number, a: number }} surface 表面色。
   * @param {{ r: number, g: number, b: number, a: number }} label 正文色。
   * @returns {{ min: number, p5: number } | null} 结果。
   */
  function contrastStats(pixels, veil, surface, label) {
    if (pixels === undefined || veil === null || surface === null || label === null) return null
    var textLuma = luma(label.r, label.g, label.b)
    var ratios = []
    for (var index = 0; index + 3 < pixels.length; index += 4) {
      // 蒙版压在视频上，表面再压在结果上（和浏览器里的 alpha 合成同序）。
      var r = surface.a * surface.r + (1 - surface.a) * (veil.a * veil.r + (1 - veil.a) * pixels[index])
      var g = surface.a * surface.g + (1 - surface.a) * (veil.a * veil.g + (1 - veil.a) * pixels[index + 1])
      var b = surface.a * surface.b + (1 - surface.a) * (veil.a * veil.b + (1 - veil.a) * pixels[index + 2])
      var background = luma(r, g, b)
      ratios.push((Math.max(textLuma, background) + 0.05) / (Math.min(textLuma, background) + 0.05))
    }
    if (ratios.length === 0) return null
    ratios.sort(function (a, b) {
      return a - b
    })
    return {
      min: Math.round(ratios[0] * 100) / 100,
      p5: Math.round(ratios[Math.floor(ratios.length * 0.05)] * 100) / 100,
    }
  }

  /**
   * 量一次"正文在最坏情况附近的对比度"（画面 5% 分位），用于面板上的实时提示。
   *
   * 和 `scripts/verify-browser.mjs` 用的是同一套算法：把视频帧画进小 canvas 采样，
   * 按"视频 → 蒙版 → 表面"合成，再和正文色算 WCAG 对比度。这样滑块旁边那个数字
   * 就是**这块屏幕上真实的读数**，而不是一句"应该还行"。
   * @param {any} video 背景 video 元素。
   * @returns {{ p5: number, min: number } | null} 对比度，量不了就是 null。
   */
  function measureContrast(video) {
    if (video === null || video.readyState < 2) return null
    try {
      var canvas = doc.createElement('canvas')
      canvas.width = 32
      canvas.height = 18
      var context = canvas.getContext('2d', { willReadFrequently: true })
      if (context === null || typeof context.getImageData !== 'function') return null
      context.drawImage(video, 0, 0, 32, 18)
      var pixels = context.getImageData(0, 0, 32, 18).data
      var veilEl = doc.getElementById('dsvs-backdrop-veil')
      if (veilEl === null) return null
      var veil = parseColor(global.getComputedStyle(veilEl).backgroundColor)
      var probe = doc.createElement('div')
      probe.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px'
      doc.body.appendChild(probe)
      probe.style.backgroundColor = 'var(--dsw-alias-bg-base)'
      var surface = parseColor(global.getComputedStyle(probe).backgroundColor)
      probe.style.color = 'var(--dsw-alias-label-primary)'
      var label = parseColor(global.getComputedStyle(probe).color)
      probe.remove()
      return contrastStats(pixels, veil, surface, label)
    } catch (error) {
      // 画布被污染 / 没有 canvas 都不该让面板挂掉。
      return null
    }
  }

  /** 相对亮度用的 sRGB 线性化。 */
  function toLinear(channel) {
    var c = channel / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }

  /** 一个像素的相对亮度。 */
  function luma(r, g, b) {
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
  }

  /**
   * 解析 `rgb()/rgba()/color(srgb ...)`。刻意不用正则 —— 这段代码要穿过
   * 「模板字面量 → 页面源码」两层转义，正则里的反斜杠极易多转义一层而静默失配。
   * @param {string} css 计算后的颜色。
   * @returns {{ r: number, g: number, b: number, a: number } | null} 分量。
   */
  function parseColor(css) {
    var text = String(css)
    var open = text.indexOf('(')
    var close = text.lastIndexOf(')')
    if (open < 0 || close < 0) return null
    var body = text.slice(open + 1, close)
    // `color(srgb 0.5 0.25 0.75 / 0.5)` 的第一个 token 是色彩空间名，而且通道之间用**空格**
    // 分隔 —— 不处理这两点的话通道会解析成 NaN，函数静默返回 null。
    var isColorFn = text.indexOf('color(') === 0
    if (isColorFn) body = body.replace(/^[a-z-]+\s*/iu, '')
    var parts = body
      .split(/[,/\s]+/u)
      .filter(function (token) {
        return token !== ''
      })
      .map(function (token) {
        return Number(token.replace('%', ''))
      })
    if (parts.length < 3) return null
    for (var index = 0; index < 3; index += 1) if (parts[index] !== parts[index]) return null
    var scale = isColorFn ? 255 : 1
    return {
      r: parts[0] * scale,
      g: parts[1] * scale,
      b: parts[2] * scale,
      a: parts.length > 3 ? parts[3] : 1,
    }
  }

  /**
   * 造透明度调节控件：右下角一个小圆钮 + 一个滑块面板。
   *
   * 三个设计取舍：
   *   1. **不注入到 DSH 的设置页里**。那页是 React 管的，往里塞节点迟早出问题；
   *      面板挂在 document.body 上、和背景层同一层，互不干扰。
   *   2. 圆钮平时**半透明**（opacity .34），鼠标靠近才变实，尽量不碍眼；
   *      不想要就设 `background.controls: false`。
   *   3. 面板里那个"文字对比度"是**真的量出来的**（采样当前视频帧），
   *      所以用户能直接看到"我再调低一点，字还读不读得动"。
   * @param {any} video 背景 video 元素。
   */
  function buildControls(video) {
    var bg = isObject(liveCfg.background) ? liveCfg.background : {}
    if (bg.controls === false) return
    if (doc.getElementById('dsvs-knobs') !== null) return

    var knobs = currentKnobs()

    var pill = el('div', null)
    pill.id = 'dsvs-knobs-pill'
    pill.setAttribute('role', 'button')
    pill.setAttribute('tabindex', '0')
    pill.setAttribute('aria-label', '聊天背景透明度')
    pill.setAttribute('title', '聊天背景透明度（Alt+B）')
    pill.appendChild(el('span', 'dsvs-knobs-glyph', '◨'))

    var panel = el('div', null)
    panel.id = 'dsvs-knobs'
    panel.setAttribute('data-open', '0')

    var head = el('div', 'dsvs-knobs-head')
    head.appendChild(el('span', 'dsvs-knobs-title', '聊天背景'))
    var close = el('div', 'dsvs-knobs-close', '×')
    head.appendChild(close)
    panel.appendChild(head)

    // ── 素材：开关 / 更换 / 恢复默认 ──
    // 这里是"我只想要背景、不想要开场动画"和"换成我自己的视频"的唯一入口。
    var mediaSection = buildMediaSection(panel)

    var presets = el('div', 'dsvs-knobs-presets')
    var presetButtons = PRESETS.map(function (preset) {
      var button = el('div', 'dsvs-knobs-preset', preset.label)
      button.setAttribute('data-preset', preset.id)
      presets.appendChild(button)
      return { preset: preset, node: button }
    })
    panel.appendChild(presets)

    /** 造一行"标签 + 滑块 + 读数"。 */
    function makeRow(key, label, max) {
      var row = el('div', 'dsvs-knobs-row')
      var head2 = el('div', 'dsvs-knobs-label')
      head2.appendChild(el('span', null, label))
      var output = el('span', 'dsvs-knobs-value')
      head2.appendChild(output)
      row.appendChild(head2)
      var input = doc.createElement('input')
      input.type = 'range'
      input.min = '0'
      input.max = String(max)
      input.step = '1'
      input.className = 'dsvs-knobs-range'
      input.setAttribute('aria-label', label)
      row.appendChild(input)
      var note = el('div', 'dsvs-knobs-note')
      row.appendChild(note)
      panel.appendChild(row)
      return { key: key, input: input, output: output, note: note, max: max }
    }

    var rows = [
      // 名字里别写"面板"：这个旋钮只影响**画布和侧栏**，弹层/对话框/设置页由下面第三行管。
      makeRow('surface', '画布不透明度', 100),
      makeRow('veil', '视频蒙版', 92),
      // 抬起来的表面：默认 100% = 原生不透明。想玩磨砂玻璃才往下拖。
      makeRow('panel', '面板不透明度', 100),
    ]

    var badge = el('div', 'dsvs-knobs-badge')
    panel.appendChild(badge)
    var foot = el('div', 'dsvs-knobs-foot')
    var reset = el('div', 'dsvs-knobs-reset', '恢复默认')
    foot.appendChild(reset)
    var status = el('span', 'dsvs-knobs-status', '')
    foot.appendChild(status)
    panel.appendChild(foot)

    /**
     * 造"素材"区：两个槽位各一行（开关 / 更换… / 默认）。
     *
     * 为什么要上传而不是让用户填路径：普通用户不知道"包内相对路径"是什么；
     * 上传后宿主把文件落到 `$DSH_HOME/dsh-video-skin-media/`，配置里写绝对路径，
     * 文件名带内容哈希（换素材时 URL 必变，浏览器不会拿旧视频的缓存）。
     * @param {Element} parent 面板节点。
     * @returns {{ render: (payload: unknown) => void } | null} 控制器（关掉控件时是 null）。
     */
    function buildMediaSection(parent) {
      var mediaCfg = isObject(api.config.media) ? api.config.media : {}
      var mediaRoute = typeof mediaCfg.route === 'string' ? mediaCfg.route : ''
      if (mediaRoute === '') return null
      var limitBytes = num(mediaCfg.limitBytes, 96 * 1024 * 1024, 1024, 1024 * 1024 * 1024)
      var block = el('div', 'dsvs-media')
      /** @type {Record<string, any>} */
      var rows = {}
      var SLOTS = [
        { slot: 'boot', label: '开机动画' },
        { slot: 'background', label: '聊天背景' },
      ]

      /** 用宿主回报的状态刷新两行。 */
      var render = function (payload) {
        for (var index = 0; index < SLOTS.length; index += 1) {
          var spec = SLOTS[index]
          var row = rows[spec.slot]
          if (row === undefined) continue
          var value = isObject(payload) && isObject(payload[spec.slot]) ? payload[spec.slot] : null
          if (value === null) continue
          row.enabled = value.enabled === true
          row.toggle.textContent = row.enabled ? '开' : '关'
          row.toggle.setAttribute('aria-checked', row.enabled ? 'true' : 'false')
          row.row.setAttribute('data-off', row.enabled ? '0' : '1')
          var name = typeof value.name === 'string' && value.name !== '' ? value.name : '默认素材'
          row.note.textContent = (value.custom === true ? '自定义 · ' : '') + name
        }
        var bgOff = rows.background !== undefined && rows.background.enabled === false
        parent.setAttribute('data-media-off', bgOff ? '1' : '0')
      }

      /** 拉一次真实状态（快照里没有"当前用的是哪个文件"）。 */
      var refresh = function () {
        var sent = global.fetch(mediaRoute, { method: 'GET', cache: 'no-store' })
        if (!sent || typeof sent.then !== 'function') return
        sent
          .then(function (response) {
            return response && response.ok ? response.json() : null
          })
          .then(function (payload) {
            if (isObject(payload) && payload.ok === true) render(payload)
          })
          .then(undefined, noop)
      }

      for (var index = 0; index < SLOTS.length; index += 1) {
        (function (spec) {
          var row = el('div', 'dsvs-media-row')
          row.setAttribute('data-slot', spec.slot)
          var top = el('div', 'dsvs-media-top')
          top.appendChild(el('span', 'dsvs-media-name', spec.label))
          var note = el('span', 'dsvs-media-note', '')
          top.appendChild(note)

          var actions = el('div', 'dsvs-media-actions')
          var toggle = el('div', 'dsvs-media-toggle', '开')
          toggle.setAttribute('role', 'switch')
          toggle.setAttribute('tabindex', '0')
          toggle.setAttribute('aria-checked', 'true')
          var pick = el('div', 'dsvs-media-btn', '更换…')
          var reset = el('div', 'dsvs-media-btn dsvs-media-reset', '默认')
          actions.appendChild(toggle)
          actions.appendChild(pick)
          actions.appendChild(reset)
          top.appendChild(actions)
          row.appendChild(top)
          block.appendChild(row)

          var file = doc.createElement('input')
          file.type = 'file'
          file.accept = 'video/mp4,video/webm,video/ogg'
          file.className = 'dsvs-media-input'
          // 挂在行里（虽然 CSS 隐藏），测试和 DOM 结构上它属于这个槽位。
          row.appendChild(file)

          var controller = {
            row: row,
            toggle: toggle,
            note: note,
            enabled: spec.slot === 'boot' ? api.config.boot.enabled === true : api.config.background.enabled === true,
            busy: false,
          }
          rows[spec.slot] = controller

          /** 忙的时候把整行标灰，别让人连点。 */
          var setBusy = function (busy, message) {
            controller.busy = busy
            row.setAttribute('data-busy', busy ? '1' : '0')
            if (typeof message === 'string') note.textContent = message
          }

          /** 收到宿主回包后统一刷新 + 让画面跟上。 */
          var apply = function (payload) {
            if (!isObject(payload) || payload.ok !== true) {
              setBusy(false, isObject(payload) && typeof payload.error === 'string' ? payload.error : '操作失败')
              return
            }
            render(payload)
            if (spec.slot === 'background') setBackgroundLive(payload.background.enabled === true)
            setBusy(false, spec.slot === 'boot' ? '已保存 · 重启 DSH 后生效' : '已保存 · 已生效')
          }

          /** 统一发请求：`init` 决定是上传、开关还是恢复默认。 */
          var send = function (init, failText) {
            setBusy(true, '处理中…')
            var sent = global.fetch(mediaRoute + '?slot=' + spec.slot, init)
            sent
              .then(function (response) {
                return response.json().catch(function () {
                  return null
                })
              })
              .then(apply)
              .then(undefined, function () {
                setBusy(false, failText)
              })
          }

          toggle.addEventListener('click', function () {
            if (controller.busy) return
            var next = !controller.enabled
            setBusy(true, next ? '正在打开…' : '正在关闭…')
            send(
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: next }),
              },
              '保存失败（看一下宿主日志）',
            )
          })
          toggle.addEventListener('keydown', function (event) {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              toggle.click()
            }
          })
          pick.addEventListener('click', function () {
            if (!controller.busy) file.click()
          })
          file.addEventListener('change', function () {
            var chosen = file.files && file.files.length > 0 ? file.files[0] : null
            file.value = ''
            if (chosen === null) return
            if (chosen.size > limitBytes) {
              note.textContent = '文件太大（上限 ' + Math.round(limitBytes / 1024 / 1024) + ' MiB）'
              return
            }
            setBusy(true, '上传中… ' + Math.round(chosen.size / 1024) + ' KiB')
            send(
              {
                method: 'POST',
                headers: {
                  'Content-Type':
                    typeof chosen.type === 'string' && chosen.type !== '' ? chosen.type : 'application/octet-stream',
                  'X-Dsh-Filename': encodeURIComponent(chosen.name || ''),
                },
                body: chosen,
              },
              '上传失败（看一下宿主日志）',
            )
          })
          reset.addEventListener('click', function () {
            if (controller.busy) return
            send({ method: 'DELETE' }, '恢复失败（看一下宿主日志）')
          })
        })(SLOTS[index])
      }

      parent.appendChild(block)
      refresh()
      return { render: render, rows: rows }
    }

    /** 把一组旋钮值同步到滑块位置与读数上。 */
    function syncInputs(values) {
      rows[0].input.value = String(Math.round(values.surface * 100))
      rows[1].input.value = String(Math.round(values.veil * 100))
      rows[2].input.value = String(Math.round(num(values.panel, 1, 0, 1) * 100))
      refreshLabels(values)
    }

    /** 更新三行滑块旁的读数（暗/亮两个主题各是多少）。 */
    function refreshLabels(values) {
      var surfaceLight = num(values.surfaceLight, Math.min(1, values.surface + 0.4), 0, 1)
      var veilLight = num(values.veilLight, values.veil * 0.7, 0, 0.92)
      var panel = num(values.panel, 1, 0, 1)
      rows[0].output.textContent = Math.round(values.surface * 100) + '%'
      rows[0].note.textContent =
        '暗色 ' + Math.round(values.surface * 100) + '% · 亮色 ' + Math.round(surfaceLight * 100) + '%'
      rows[1].output.textContent = Math.round(values.veil * 100) + '%'
      rows[1].note.textContent =
        '暗色 ' + Math.round(values.veil * 100) + '% · 亮色 ' + Math.round(veilLight * 100) + '%'
      rows[2].output.textContent = Math.round(panel * 100) + '%'
      rows[2].note.textContent =
        panel >= 0.999
          ? '原生不透明 · 弹层/设置页读起来最稳'
          : '调低会透出背后的内容 · 弹层可能不好读'
      for (var index = 0; index < presetButtons.length; index += 1) {
        var preset = presetButtons[index].preset
        var active =
          Math.abs(preset.surface - values.surface) < 0.005 && Math.abs(preset.veil - values.veil) < 0.005
        presetButtons[index].node.setAttribute('data-active', active ? '1' : '0')
      }
    }

    /** 重算实时对比度徽章。 */
    function refreshBadge() {
      var measured = measureContrast(video)
      if (measured === null) {
        badge.textContent = '文字对比度：暂时量不到（视频还没出画面）'
        badge.setAttribute('data-level', 'unknown')
        return
      }
      var level = measured.p5 >= 7 ? 'great' : measured.p5 >= 4.5 ? 'ok' : 'low'
      var word = level === 'great' ? '很充裕' : level === 'ok' ? '够用' : '偏低 · 建议调高画布不透明度'
      badge.textContent = '文字对比度 ' + measured.p5.toFixed(1) + '（' + word + '）'
      badge.setAttribute('data-level', level)
    }

    var badgeFrame = null
    function scheduleBadge() {
      if (badgeFrame !== null) return
      badgeFrame = raf(function () {
        badgeFrame = null
        refreshBadge()
      })
    }

    /**
     * 把滑块的值变成"要应用的配置"，并立刻生效。
     *
     * 两个滑块同步写出**四个**键：`surfaceLight` / `veilLight` 按文档里的规则
     * （`+0.4` / `×0.7`）当场算出来一起写。
     *
     * 为什么不能只写 `surface`：宿主解析配置时**总是**会给出一个显式的 `surfaceLight`
     * （默认就是 `surface + 0.4`），而运行时对显式值优先 —— 只写 `surface` 的话，
     * 亮主题的用户拖滑块会"什么都没发生"。这个 bug 是真浏览器验证抓出来的。
     */
    function applyFromInputs(options) {
      var surface = Number(rows[0].input.value) / 100
      var veil = Number(rows[1].input.value) / 100
      var panel = Number(rows[2].input.value) / 100
      var values = {
        surface: surface,
        surfaceLight: Math.min(1, surface + 0.4),
        veil: veil,
        veilLight: veil * 0.7,
        panel: panel,
      }
      liveCfg = mergeConfig(liveCfg, { background: values })
      api.config = liveCfg
      applyVisuals(liveCfg)
      refreshLabels(currentKnobs())
      scheduleBadge()
      if (options && options.persist === true) {
        status.textContent = '保存中…'
        persistKnobs(values, false).then(function (outcome) {
          status.textContent = outcome.ok ? '' : '没能写进配置文件（本次会话仍生效）'
        })
      }
    }

    for (var index = 0; index < rows.length; index += 1) {
      ;(function (row) {
        // input 事件 = 边拖边看，这一步只改内存里的值，所以观感是实时的。
        row.input.addEventListener('input', function () {
          applyFromInputs({ persist: false })
        })
        // change 事件 = 松手了，这时才写盘，避免拖动过程中打出几十个请求。
        row.input.addEventListener('change', function () {
          applyFromInputs({ persist: true })
        })
      })(rows[index])
    }

    for (var p = 0; p < presetButtons.length; p += 1) {
      ;(function (entry) {
        entry.node.addEventListener('click', function () {
          rows[0].input.value = String(Math.round(entry.preset.surface * 100))
          rows[1].input.value = String(Math.round(entry.preset.veil * 100))
          applyFromInputs({ persist: true })
        })
      })(presetButtons[p])
    }

    reset.addEventListener('click', function () {
      status.textContent = '恢复中…'
      persistKnobs({}, true).then(function (outcome) {
        // "默认值"只能来自**宿主**，不能来自 `currentKnobs()` —— 后者读的是已经被滑块改过的
        // 内存值，用它"恢复"等于把当前值又写回去（这个 bug 被测试抓到过）。
        // 优先用 DELETE 响应里带回的新配置；拿不到就退回注入行里那份部署期快照。
        var restored = isObject(outcome.config) && isObject(outcome.config.background)
          ? outcome.config.background
          : injectedBackground
        liveCfg = mergeConfig(liveCfg, { background: restored })
        api.config = liveCfg
        applyVisuals(liveCfg)
        syncInputs(currentKnobs())
        scheduleBadge()
        status.textContent = outcome.ok ? '已恢复默认' : '没能写进配置文件（本次会话仍生效）'
      })
    })

    /** 展开/收起面板。 */
    function setOpen(open) {
      panel.setAttribute('data-open', open ? '1' : '0')
      pill.setAttribute('data-active', open ? '1' : '0')
      if (open) {
        syncInputs(currentKnobs())
        refreshBadge()
      }
    }

    pill.addEventListener('click', function () {
      setOpen(panel.getAttribute('data-open') !== '1')
    })
    close.addEventListener('click', function () {
      setOpen(false)
    })
    // 面板内部的操作绝不能穿透到背景层（虽然背景层是 pointer-events:none，但覆盖层
    // 之外还有别的监听者，把冒泡挡住最省心）。
    panel.addEventListener('pointerdown', function (event) {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
    })

    var onKey = function (event) {
      if (!event) return
      // Esc 先关面板（它比"跳过开机动画"更靠后、更局部）。
      if (event.key === 'Escape' && panel.getAttribute('data-open') === '1') {
        setOpen(false)
        return
      }
      if (event.altKey !== true) return
      var key = String(event.key || '').toLowerCase()
      if (key !== 'b') return
      setOpen(panel.getAttribute('data-open') !== '1')
    }
    try {
      global.addEventListener('keydown', onKey)
      knobListeners.push({ target: global, type: 'keydown', handler: onKey, capture: false })
    } catch (error) {
      /* 没有 window 也无所谓 */
    }

    // 点面板外面就收起：面板会盖住输入框右下角，让它"用完就走"比要求用户去找 × 更顺手。
    // 用 capture 阶段是为了不被应用自己的 handler 抢先 stopPropagation。
    var onOutside = function (event) {
      if (panel.getAttribute('data-open') !== '1') return
      var node = event && event.target
      if (node === null || node === undefined || typeof node.closest !== 'function') return
      if (node.closest('#dsvs-knobs') !== null || node.closest('#dsvs-knobs-pill') !== null) return
      setOpen(false)
    }
    try {
      doc.addEventListener('pointerdown', onOutside, true)
      knobListeners.push({ target: doc, type: 'pointerdown', handler: onOutside, capture: true })
    } catch (error) {
      /* 没有 document 也无所谓 */
    }

    // 背景视频出画面之后徽章才有东西可量。
    video.addEventListener('loadeddata', scheduleBadge)
    video.addEventListener('timeupdate', scheduleBadge)

    doc.body.appendChild(pill)
    doc.body.appendChild(panel)
    syncInputs(knobs)
    scheduleBadge()

    // 主题切换后"暗色 xx% · 亮色 yy%"和对比度都会变，重算一次。
    var ContainerCtor = global.MutationObserver
    if (typeof ContainerCtor === 'function') {
      try {
        var observer = new ContainerCtor(function () {
          refreshLabels(currentKnobs())
          scheduleBadge()
        })
        observer.observe(doc.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
        knobObserver = observer
      } catch (error) {
        /* 观察不了就算了 */
      }
    }
  }

  // ─────────────────────────── 启动 ───────────────────────────

  function begin() {
    var overlay = null
    try {
      overlay = startBootSurface()
    } catch (error) {
      api.state.failures.push('boot-fatal')
      if (global.console && global.console.error) global.console.error('[video-skin] boot overlay', error)
    }
    // 没有开机动画（关掉了 / 没有素材 / 建不出来）时直接上背景。
    if (overlay === null) startBackdrop()
  }

  // head 里的注入行执行时 <body> 还不存在；桌面壳的 IPC 行执行时页面已经解析完了。
  // 两种都要能跑，所以两边都兜。
  if (doc.body) {
    begin()
  } else {
    doc.addEventListener('DOMContentLoaded', begin, { once: true })
  }
})(
  typeof globalThis !== 'undefined'
    ? globalThis
    : typeof window !== 'undefined'
      ? window
      : typeof self !== 'undefined'
        ? self
        : this,
)
