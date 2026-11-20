/**
 * dsh-wolfram-renew — Client half.
 *
 * Puts the plugin's configuration on the Plugins page: the `plugins.bundle.config`
 * slot is mounted through `configForms.whileServed`, and a Settings section
 * offers the same page from the settings navigation. Every field is laid out
 * directly — four rows do not need a disclosure.
 *
 * Copy is bilingual through the Client locale service with an English fallback;
 * the Host locale files carry the bilingual title and description the Plugins
 * list shows.
 */
window.__ModuleLoader__.load({
  id: 'dsh-wolfram-renew',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'wolfram-renew'
    const ROUTE = '/api/dsh-wolfram/config'
    /** This plugin's Loader entry id; the bundle page is keyed by it. */
    const ENTRY = 'wolfram-tool'
    const PACKAGE = 'dsh-wolfram-renew'
    const PAGE_SLOT = 'plugins.bundle.config'

    const DICT = {
      zh: {
        title: 'dsh-wolfram-renew',
        subtitle: '安装目录、超时与运行方式',
        description: '通过本机 Wolfram Engine 或 Mathematica 执行精确的符号与数值计算（工具名 `wolfram`）。',
        directory: '安装目录',
        directoryHint: '留空则自动发现。填包含 wolframscript.exe 或 math.exe 的 Wolfram 安装目录。',
        timeout: '默认超时（毫秒）',
        timeoutHint: '1000–600000。单次求值超过它时，内核会转为后台任务。',
        sandbox: '使用沙箱',
        sandboxHint: '开启后代码在会话沙箱内执行；在 Android 等沙箱无法启动命令的环境请关闭。',
        frontend: '执行前端',
        frontendHint: '不使用沙箱时可选 wolframscript；沙箱开启时只能用 math。',
        frontendLocked: '沙箱开启时固定使用 math',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        failed: '保存失败',
        loading: '读取中…',
        unreadable: '无法读取当前配置',
      },
      en: {
        title: 'dsh-wolfram-renew',
        subtitle: 'Install directory, timeout and execution mode',
        description: 'Exact symbolic and numeric Wolfram Language evaluation through the local Wolfram Engine or Mathematica installation (tool name `wolfram`).',
        directory: 'Install directory',
        directoryHint: 'Leave empty to auto-discover. The Wolfram install directory that holds wolframscript.exe or math.exe.',
        timeout: 'Default timeout (ms)',
        timeoutHint: '1000–600000. An evaluation that outlives it continues as a background job.',
        sandbox: 'Use the sandbox',
        sandboxHint: 'Runs code inside the session sandbox. Turn it off where the runner cannot start commands, such as Android.',
        frontend: 'Front-end',
        frontendHint: 'wolframscript is available only without the sandbox; the sandbox always uses math.',
        frontendLocked: 'The sandbox always uses math',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        failed: 'Save failed',
        loading: 'Loading…',
        unreadable: 'Cannot read the current configuration',
      },
    }

    /** Bound from the locale service in apply; null keeps the bundled dictionary. */
    let translate = null

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '4px' },
      header: { display: 'flex', flexDirection: 'column', gap: '2px', padding: '10px 0 2px' },
      title: { fontSize: '13px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
      subtitle: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
      description: { fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)', marginBottom: '6px' },
      form: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 0 6px' },
      field: { display: 'flex', flexDirection: 'column', gap: '6px' },
      fieldRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '14px' },
      label: { fontSize: '13px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: '12px', lineHeight: 1.45, color: 'var(--dsw-alias-label-tertiary)' },
      input: {
        boxSizing: 'border-box',
        width: '100%',
        padding: '7px 10px',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        lineHeight: 1.4,
      },
      select: {
        boxSizing: 'border-box',
        minWidth: '190px',
        padding: '6px 10px',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
      },
      row: { display: 'flex', alignItems: 'center', gap: '10px' },
      button: {
        padding: '6px 14px',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        cursor: 'pointer',
      },
      status: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
      error: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
    }

    function pickText(t, key, language) {
      if (typeof t === 'function') {
        try {
          const value = t(key)
          if (typeof value === 'string' && value !== '' && value !== key) return value
        } catch {
          // Fall through to the bundled dictionary.
        }
      }
      const dictionary = DICT[language] ?? DICT.en
      return dictionary[key] ?? DICT.en[key] ?? key
    }

    function languageOf() {
      return typeof document === 'object' ? (document.documentElement.lang || 'en').slice(0, 2) : 'en'
    }

    function WolframSettings() {
      const language = languageOf()
      const [state, setState] = React.useState({
        phase: 'loading',
        installDir: '',
        timeoutMs: '',
        useSandbox: true,
        frontend: 'math',
        message: '',
        error: '',
      })

      React.useEffect(() => {
        let alive = true
        fetch(ROUTE, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((body) => {
            if (!alive) return
            if (!body || body.ok !== true) {
              setState((current) => ({ ...current, phase: 'error', error: pickText(translate, 'unreadable', language) }))
              return
            }
            const value = body.value ?? {}
            setState((current) => ({
              ...current,
              phase: 'ready',
              installDir: typeof value.installDir === 'string' ? value.installDir : '',
              timeoutMs: value.timeoutMs === undefined ? '' : String(value.timeoutMs),
              useSandbox: value.useSandbox !== false,
              frontend: value.frontend === 'wolframscript' ? 'wolframscript' : 'math',
            }))
          })
          .catch(() => {
            if (alive) setState((current) => ({ ...current, phase: 'error', error: pickText(translate, 'unreadable', language) }))
          })
        return () => {
          alive = false
        }
      }, [language])

      const update = (key) => (event) => {
        const target = event.target
        const value = target.type === 'checkbox' ? target.checked : target.value
        setState((current) => ({ ...current, [key]: value, message: '', error: '' }))
      }

      const save = async () => {
        setState((current) => ({ ...current, phase: 'saving', message: pickText(translate, 'saving', language), error: '' }))
        const payload = {
          installDir: state.installDir.trim(),
          useSandbox: state.useSandbox,
          // The sandbox forces math, so persist the choice the page shows.
          frontend: state.useSandbox ? 'math' : state.frontend,
        }
        const timeout = Number(state.timeoutMs)
        if (state.timeoutMs.trim() !== '' && Number.isFinite(timeout)) payload.timeoutMs = Math.round(timeout)
        try {
          const response = await fetch(ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(payload),
          })
          const body = await response.json().catch(() => null)
          if (!response.ok || !body || body.ok !== true) {
            const detail = body && body.error ? String(body.error) : ''
            setState((current) => ({
              ...current,
              phase: 'error',
              error: `${pickText(translate, 'failed', language)}${detail ? `: ${detail}` : ''}`,
              message: '',
            }))
            return
          }
          setState((current) => ({ ...current, phase: 'ready', message: pickText(translate, 'saved', language), error: '' }))
        } catch (error) {
          setState((current) => ({
            ...current,
            phase: 'error',
            error: `${pickText(translate, 'failed', language)}: ${error instanceof Error ? error.message : String(error)}`,
            message: '',
          }))
        }
      }

      const disabled = state.phase === 'loading' || state.phase === 'saving'
      return h(
        'div',
        { style: styles.form },
        h(
          'div',
          { style: styles.field },
          h('label', { style: styles.label, htmlFor: 'wolfram-install-dir' }, pickText(translate, 'directory', language)),
          h('input', {
            id: 'wolfram-install-dir',
            type: 'text',
            spellCheck: false,
            style: styles.input,
            value: state.installDir,
            onChange: update('installDir'),
            disabled,
            placeholder: 'D:\\Program Files\\Wolfram Research\\Wolfram Engine\\15.0',
          }),
          h('div', { style: styles.hint }, pickText(translate, 'directoryHint', language)),
        ),
        h(
          'div',
          { style: styles.field },
          h('label', { style: styles.label, htmlFor: 'wolfram-timeout' }, pickText(translate, 'timeout', language)),
          h('input', {
            id: 'wolfram-timeout',
            type: 'number',
            min: 1000,
            max: 600000,
            step: 1000,
            style: styles.input,
            value: state.timeoutMs,
            onChange: update('timeoutMs'),
            disabled,
            placeholder: '120000',
          }),
          h('div', { style: styles.hint }, pickText(translate, 'timeoutHint', language)),
        ),
        h(
          'div',
          { style: styles.field },
          h(
            'div',
            { style: styles.fieldRow },
            h('label', { style: styles.label, htmlFor: 'wolfram-sandbox' }, pickText(translate, 'sandbox', language)),
            h('input', {
              id: 'wolfram-sandbox',
              type: 'checkbox',
              checked: state.useSandbox,
              onChange: update('useSandbox'),
              disabled,
            }),
          ),
          h('div', { style: styles.hint }, pickText(translate, 'sandboxHint', language)),
        ),
        h(
          'div',
          { style: styles.field },
          h(
            'div',
            { style: styles.fieldRow },
            h('label', { style: styles.label, htmlFor: 'wolfram-frontend' }, pickText(translate, 'frontend', language)),
            h(
              'select',
              {
                id: 'wolfram-frontend',
                style: styles.select,
                value: state.useSandbox ? 'math' : state.frontend,
                onChange: update('frontend'),
                disabled: disabled || state.useSandbox,
              },
              h('option', { value: 'math' }, 'math'),
              h('option', { value: 'wolframscript' }, 'wolframscript'),
            ),
          ),
          h('div', { style: styles.hint }, state.useSandbox
            ? pickText(translate, 'frontendLocked', language)
            : pickText(translate, 'frontendHint', language)),
        ),
        h(
          'div',
          { style: styles.row },
          h('button', { type: 'button', style: styles.button, onClick: save, disabled }, pickText(translate, 'save', language)),
          state.error ? h('span', { style: styles.error }, state.error) : null,
          !state.error && state.message ? h('span', { style: styles.status }, state.message) : null,
          state.phase === 'loading' ? h('span', { style: styles.status }, pickText(translate, 'loading', language)) : null,
        ),
      )
    }

    /** The page body: header plus every field, always visible. */
    function WolframCard() {
      const language = languageOf()
      return h(
        'div',
        { style: styles.root },
        h(
          'div',
          { style: styles.header },
          h('span', { style: styles.title }, pickText(translate, 'title', language)),
          h('span', { style: styles.subtitle }, pickText(translate, 'subtitle', language)),
        ),
        h('div', { style: styles.description }, pickText(translate, 'description', language)),
        h(WolframSettings),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, DICT),
          'dsh-wolfram: settings dictionary',
        )
        try {
          translate = ctx.locale.bind(NS)
        } catch {
          translate = null
        }
        // The plugin's own page on the Plugins page: the bundle config slot is
        // served only while the Host exposes this entry's configuration.
        try {
          ctx.inject(['configForms'], (child) => {
            const forms = child.get('configForms')
            if (!forms || typeof forms.get !== 'function' || typeof forms.whileServed !== 'function') return
            child.effect(
              () => forms.whileServed([ENTRY], () => child.slots.inject(PAGE_SLOT, () => {
                // One page, on the bundle itself: keyed by the package name the
                // bundle page looks up, with the dictionary namespace and the
                // props hook a page registration carries.
                const dispose = child.slots.register({
                  name: PAGE_SLOT,
                  key: PACKAGE,
                  locale: NS,
                  inject: () => ({}),
                }, WolframCard)
                return typeof dispose === 'function' ? dispose : undefined
              })),
              'dsh-wolfram: bundle config page',
            )
          })
        } catch (error) {
          console.warn('dsh-wolfram: bundle config slot unavailable', error)
        }
      },
    }
  },
})
