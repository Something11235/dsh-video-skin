/**
 * dsh-video-skin —— 客户端那一半（只干一件事：往 **DSH 设置页** 里加一张"视频皮肤"卡片）。
 *
 * 为什么需要它：设置页的左侧列表来自客户端的 `settings.section` 插槽（Token Monitor、
 * 刷B站、侧边卡片那些都是这么进去的）。本插件的主体是宿主插件 + 内联注入的运行时，
 * 那套机制碰不到 React 渲染树，所以这里补一个最小的客户端模块手写注册。
 *
 * 格式：`__ModuleLoader__` 懒 CJS（与 DSH 内置客户端插件产物一致）——**不需要任何构建步骤**，
 * 改完这个文件重启 / 热替换即可。
 *
 * 数据全部走本插件已有的宿主路由（不新增接口）：
 *   GET  /dsh-video-skin/config.json     当前生效配置
 *   POST /dsh-video-skin/override        透明度（surface / veil / panel）
 *   POST /dsh-video-skin/media?slot=..   素材开关、上传、恢复默认、背景归属
 */
window.__ModuleLoader__.load({
  id: 'dsh-video-skin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    // 排查用标记：模块体真的执行过（页面里 `window.__DSH_VIDEO_SKIN_CLIENT__` 应为 'v1'）。
    window.__DSH_VIDEO_SKIN_CLIENT__ = 'v1'

    var CONFIG_URL = '/dsh-video-skin/config.json'
    var OVERRIDE_URL = '/dsh-video-skin/override'
    var MEDIA_URL = '/dsh-video-skin/media'

    /** 设置页里三行滑块的上限（和悬浮面板一致，都是百分比取整）。 */
    var SLIDERS = [
      { key: 'surface', label: '画布不透明度', max: 100, hint: '越低视频越清楚，文字对比度越低' },
      { key: 'veil', label: '视频蒙版', max: 92, hint: '压在视频上的那层暗色/亮色蒙版' },
      { key: 'panel', label: '面板不透明度', max: 100, hint: '弹层/设置页；100% = 原生不透明（最稳）' },
    ]

    /** 读 JSON（失败返回 null，界面自己显示错误）。 */
    function readJson(url, init) {
      return fetch(url, init || { cache: 'no-store' })
        .then(function (response) {
          return response.ok ? response.json() : null
        })
        .catch(function () {
          return null
        })
    }

    /** 主题 token（用 DSH 自己的语义色，亮/暗主题都会自动适配）。 */
    var C = {
      label: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      layer: 'var(--dsw-alias-bg-layer-1)',
      brand: 'var(--dsw-alias-brand-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
    }

    var S = {
      card: {
        border: '1px solid ' + C.border,
        borderRadius: '12px',
        background: C.layer,
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      },
      sectionTitle: { fontSize: '13px', fontWeight: 600, color: C.label },
      row: { display: 'flex', alignItems: 'center', gap: '10px' },
      name: { fontSize: '12.5px', color: C.label, flex: '0 0 auto', minWidth: '92px' },
      note: { fontSize: '11.5px', color: C.dim, flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere' },
      button: {
        fontSize: '12px',
        padding: '4px 10px',
        borderRadius: '7px',
        border: '1px solid ' + C.borderStrong,
        background: 'transparent',
        color: C.label,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      buttonActive: {
        fontSize: '12px',
        padding: '4px 10px',
        borderRadius: '7px',
        border: '1px solid ' + C.brand,
        background: 'color-mix(in srgb, ' + C.brand + ' 18%, transparent)',
        color: C.label,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      range: { flex: '1 1 auto', accentColor: C.brand, minWidth: '120px' },
      badge: { fontSize: '11px', padding: '1px 7px', borderRadius: '999px', border: '1px solid ' + C.borderStrong, color: C.dim },
    }

    /** 一行"标签 + 内容"。 */
    function Row(props) {
      return h('div', { style: S.row }, h('span', { style: S.name }, props.name), props.children)
    }

    /** 设置页组件。 */
    function SettingsPage() {
      var state = React.useState(null)
      var cfg = state[0]
      var setCfg = state[1]
      var errorState = React.useState('')
      var error = errorState[0]
      var setError = errorState[1]
      var busyState = React.useState('')
      var busy = busyState[0]
      var setBusy = busyState[1]
      var wallState = React.useState(false)
      var wallpaper = wallState[0]
      var setWallpaper = wallState[1]

      var load = React.useCallback(function () {
        return readJson(CONFIG_URL).then(function (payload) {
          if (payload === null) {
            setError('读不到插件配置（宿主路由没应答）；背景本身可能仍然正常。')
            return
          }
          setError('')
          setCfg(payload)
        })
      }, [])

      React.useEffect(function () {
        load()
      }, [load])

      // 别的壁纸插件在台上时（body[data-we-wallpaper]），我们自己也会知道 —— 这里只读展示。
      React.useEffect(function () {
        var read = function () {
          try {
            setWallpaper(document.body.getAttribute('data-we-wallpaper') !== null)
          } catch (err) {
            /* body 还没就绪就算了 */
          }
        }
        read()
        var timer = setInterval(read, 800)
        return function () {
          clearInterval(timer)
        }
      }, [])

      /** 统一包一层：置忙 → 请求 → 重新读配置。 */
      var run = function (labelText, work) {
        setBusy(labelText)
        return work()
          .then(function () {
            return load()
          })
          .then(
            function () {
              setBusy('')
            },
            function (err) {
              setBusy('')
              setError('操作失败：' + String((err && err.message) || err))
            },
          )
      }

      var saveSlider = function (key, value) {
        var patch = { background: {} }
        patch.background[key] = value / 100
        return run('保存中…', function () {
          return fetch(OVERRIDE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
          })
        })
      }

      var setToggle = function (slot, enabled) {
        return run('保存中…', function () {
          return fetch(MEDIA_URL + '?slot=' + slot, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: enabled }),
          })
        })
      }

      var setMode = function (mode) {
        return run('保存中…', function () {
          return fetch(MEDIA_URL + '?slot=background', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: mode }),
          })
        })
      }

      var resetSliders = function () {
        return run('恢复中…', function () {
          return fetch(OVERRIDE_URL, { method: 'DELETE' })
        })
      }

      /** 打开悬浮面板（就是右下角圆钮那个，Alt+B）。 */
      var openPanel = function () {
        try {
          document.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', altKey: true, bubbles: true }),
          )
          window.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', altKey: true, bubbles: true }),
          )
        } catch (err) {
          /* 不支持合成事件就退化成提示 */
        }
      }

      if (cfg === null) {
        return h(
          'div',
          { style: { color: C.dim, fontSize: '12.5px' } },
          error === '' ? '正在读取视频皮肤配置…' : error,
        )
      }

      var background = (cfg.background || {})
      var boot = (cfg.boot || {})
      var mode = background.mode === 'own' ? 'own' : 'auto'
      var yielding = mode === 'auto' && wallpaper

      var statusLine = [
        'v' + (cfg.version || '?'),
        boot.enabled === false ? '开机动画 关' : '开机动画 开',
        background.enabled === false ? '聊天背景 关' : yielding ? '聊天背景 让路中' : '聊天背景 开',
      ].join(' · ')

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },

        // ── 状态 ──
        h(
          'div',
          { style: S.card },
          h('div', { style: S.sectionTitle }, '状态'),
          h(
            'div',
            { style: S.row },
            h('span', { style: S.note }, statusLine),
            h('span', { style: { ...S.badge, color: yielding ? C.warn : C.ok } },
              wallpaper ? '检测到其他壁纸插件' : '未检测到其他壁纸插件'),
          ),
          error === '' ? null : h('div', { style: { ...S.note, color: C.warn } }, error),
          busy === '' ? null : h('div', { style: S.note }, busy),
        ),

        // ── 背景归属 ──
        h(
          'div',
          { style: S.card },
          h('div', { style: S.sectionTitle }, '背景归属'),
          h(
            'div',
            { style: S.note },
            mode === 'auto'
              ? '默认：别的壁纸插件在管桌面时自动让路（不建背景层、不抢页面底色），壁纸撤掉后自动接回。开机动画始终保留。'
              : '始终接管：即使别的壁纸插件在台上，也由本插件当背景（对方的壁纸会被盖住）。',
          ),
          h(
            'div',
            { style: S.row },
            h(
              'button',
              {
                style: mode === 'auto' ? S.buttonActive : S.button,
                onClick: function () {
                  setMode('auto')
                },
              },
              '自动让路',
            ),
            h(
              'button',
              {
                style: mode === 'own' ? S.buttonActive : S.button,
                onClick: function () {
                  setMode('own')
                },
              },
              '始终接管',
            ),
          ),
        ),

        // ── 透明度 ──
        h(
          'div',
          { style: S.card },
          h('div', { style: S.sectionTitle }, '透明度'),
          SLIDERS.map(function (item) {
            var raw = background[item.key]
            var value = typeof raw === 'number' ? Math.round(raw * 100) : item.key === 'panel' ? 100 : 0
            return h(
              'div',
              { key: item.key, style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
              h(
                'div',
                { style: S.row },
                h('span', { style: S.name }, item.label),
                h('span', { style: { ...S.note, textAlign: 'right' } }, value + '%'),
              ),
              h('input', {
                type: 'range',
                min: 0,
                max: item.max,
                step: 1,
                value: value,
                style: S.range,
                'aria-label': item.label,
                onChange: function (event) {
                  saveSlider(item.key, Number(event.target.value))
                },
              }),
              h('div', { style: S.note }, item.hint),
            )
          }),
          h(
            'div',
            { style: S.row },
            h(
              'button',
              {
                style: S.button,
                onClick: resetSliders,
              },
              '恢复默认透明度',
            ),
            h(
              'button',
              {
                style: S.button,
                onClick: openPanel,
              },
              '打开悬浮面板（Alt+B）',
            ),
          ),
        ),

        // ── 素材 ──
        h(
          'div',
          { style: S.card },
          h('div', { style: S.sectionTitle }, '素材'),
          h(
            'div',
            { style: S.note },
            '开关只管"显示不显示"；换素材、上传自己的视频请用右下角悬浮面板（更换… / 默认）。',
          ),
          h(
            'div',
            { style: S.row },
            h('span', { style: S.name }, '开机动画'),
            h(
              'button',
              {
                style: boot.enabled === false ? S.button : S.buttonActive,
                onClick: function () {
                  setToggle('boot', boot.enabled === false)
                },
              },
              boot.enabled === false ? '已关闭 · 点此打开' : '已开启 · 点此关闭',
            ),
            h('span', { style: S.badge }, '重启 DSH 后生效'),
          ),
          h(
            'div',
            { style: S.row },
            h('span', { style: S.name }, '聊天背景'),
            h(
              'button',
              {
                style: background.enabled === false ? S.button : S.buttonActive,
                onClick: function () {
                  setToggle('background', background.enabled === false)
                },
              },
              background.enabled === false ? '已关闭 · 点此打开' : '已开启 · 点此关闭',
            ),
          ),
        ),
      )
    }

    /** 注册设置页。`settings.section` 是列表插槽：一条 = 设置左侧的一个入口。 */
    function apply(ctx) {
      // 排查标记：apply 被调用 / 插槽就绪 / 注册成功或失败，页面里都能读到。
      window.__DSH_VIDEO_SKIN_APPLY__ = true
      ctx.slots.inject('settings.section', function () {
        window.__DSH_VIDEO_SKIN_SLOT__ = true
        try {
          return ctx.slots.register(
            {
              name: 'settings.section',
              id: 'video-skin',
              order: 24,
              label: function () {
                return '视频皮肤'
              },
            },
            SettingsPage,
          )
        } catch (error) {
          window.__DSH_VIDEO_SKIN_ERR__ = String((error && error.message) || error)
          throw error
        }
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
