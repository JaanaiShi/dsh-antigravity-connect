/**
 * Web client half of dsh-antigravity-connect: the Settings > Antigravity page.
 *
 * The harness ships out-of-tree plugin client code as-is, so this file is
 * hand-written in the loader's closure-factory format rather than compiled from
 * TSX. It renders the sign-in state, the live quota, and the model picker, and
 * talks to the host half over the same-origin API mounted at
 * `/antigravity-connect/api`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-antigravity-connect',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const API = '/antigravity-connect/api'
    const NS = 'dsh-antigravity-connect'
    const STYLE_ID = 'dsh-antigravity-connect-style'

    /** Interval between status polls while a browser sign-in is outstanding. */
    const LOGIN_POLL_MS = 1500

    const zh = {
      nav: 'Antigravity',
      title: 'Antigravity',
      subtitle: '通过 Google 账号使用 Antigravity / Cloud Code Assist 的模型。',
      account: '当前账号',
      notSignedIn: '未登录',
      notSignedInHint: '点击「登录」后会在浏览器中完成 Google 授权，完成后本页会自动刷新。',
      login: '登录',
      loggingIn: '等待浏览器授权...',
      cancel: '取消',
      logout: '退出登录',
      refresh: '刷新额度',
      refreshing: '刷新中...',
      quota: '额度',
      quotaEmpty: '暂无额度数据，点击「刷新额度」获取。',
      quotaNote: '同一额度池内的模型共享限额，额度按 token 成本扣除。',
      resetAt: '重置：{time}',
      resetUnknown: '重置时间未知',
      resetNow: '即将重置',
      now: '刚刚',
      minutesAgo: '{n} 分钟前',
      hoursAgo: '{n} 小时前',
      models: '模型',
      modelsHint: '勾选的模型会出现在 DSH 的模型选择器里，修改后自动保存。',
      modelsEmpty: '没有可用模型。',
      selectAll: '全选',
      selectNone: '全不选',
      saved: '已保存',
      project: '项目',
      plan: '套餐',
      pending: '正在等待浏览器完成授权……',
      pendingExpires: '还有 {time} 超时，超时后点「登录」可重试',
      pendingStalled: '已超时，点「登录」重试',
      callbackPortHint: '回调地址是本机 http://localhost:51121/oauth-callback。如果浏览器显示 ERR_CONNECTION_REFUSED，说明授权已经超时或 DSH 被重启过，重新点「登录」即可。',
      failure: '操作失败',
      retry: '重试',
      openManually: '浏览器没有自动打开？',
      openLink: '点此手动打开授权页面',
      poolGemini: 'Gemini 额度池',
      poolThirdParty: 'Claude & GPT (3P) 额度池',
    }

    const en = {
      nav: 'Antigravity',
      title: 'Antigravity',
      subtitle: 'Use Antigravity / Cloud Code Assist models through your Google account.',
      account: 'Account',
      notSignedIn: 'Not signed in',
      notSignedInHint: 'Choose Sign in to complete Google authorization in your browser; this page refreshes itself when it finishes.',
      login: 'Sign in',
      loggingIn: 'Waiting for the browser...',
      cancel: 'Cancel',
      logout: 'Sign out',
      refresh: 'Refresh quota',
      refreshing: 'Refreshing...',
      quota: 'Quota',
      quotaEmpty: 'No quota data yet. Choose Refresh quota.',
      quotaNote: 'Models in one pool share its limits; usage is charged in proportion to token cost.',
      resetAt: 'Resets: {time}',
      resetUnknown: 'Reset time unknown',
      resetNow: 'Resetting soon',
      now: 'just now',
      minutesAgo: '{n} min ago',
      hoursAgo: '{n} h ago',
      models: 'Models',
      modelsHint: 'Checked models appear in the DSH model picker. Changes save automatically.',
      modelsEmpty: 'No models available.',
      selectAll: 'Select all',
      selectNone: 'Select none',
      saved: 'Saved',
      project: 'Project',
      plan: 'Plan',
      pending: 'Waiting for the browser to finish authorizing...',
      pendingExpires: 'Times out in {time}; choose Sign in again after that',
      pendingStalled: 'Timed out — choose Sign in to retry',
      callbackPortHint: 'The callback is http://localhost:51121/oauth-callback on this machine. If the browser shows ERR_CONNECTION_REFUSED, the attempt already timed out or DSH was restarted — just choose Sign in again.',
      failure: 'Something went wrong',
      retry: 'Retry',
      openManually: 'Browser did not open?',
      openLink: 'Open the authorization page manually',
      poolGemini: 'Gemini quota pool',
      poolThirdParty: 'Claude & GPT (3P) quota pool',
    }

    /** Inject the page stylesheet once per document. */
    function installStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.dataset.plugin = 'dsh-antigravity-connect'
      tag.textContent = `
.dsac-page { display:flex; flex-direction:column; gap:20px; padding:4px 0 24px; font-size:13px; line-height:1.6 }
.dsac-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px }
.dsac-title { margin:0; font-size:15px; font-weight:600 }
.dsac-sub { margin:2px 0 0; opacity:.6 }
.dsac-actions { display:flex; flex-wrap:wrap; gap:8px; justify-content:flex-end }
.dsac-card { border:1px solid light-dark(#e3e3e6,#33333a); border-radius:10px; padding:14px 16px; display:flex; flex-direction:column; gap:10px }
.dsac-card-head { display:flex; align-items:center; justify-content:space-between; gap:12px }
.dsac-card-title { font-weight:600 }
.dsac-kv { display:grid; grid-template-columns:max-content 1fr; gap:4px 12px }
.dsac-kv dt { opacity:.6 }
.dsac-kv dd { margin:0; word-break:break-all }
.dsac-btn { font:inherit; padding:5px 12px; border-radius:7px; cursor:pointer;
  border:1px solid light-dark(#d0d0d5,#3d3d45); background:light-dark(#fff,#232329); color:inherit }
.dsac-btn:hover:not(:disabled) { background:light-dark(#f4f4f6,#2b2b32) }
.dsac-btn:disabled { opacity:.5; cursor:default }
.dsac-btn-primary { border-color:transparent; background:light-dark(#1a1a1f,#e8e8ea); color:light-dark(#fff,#1a1a1f) }
.dsac-btn-primary:hover:not(:disabled) { background:light-dark(#33333a,#fff) }
.dsac-btn-link { border:none; background:none; padding:0; text-decoration:underline; cursor:pointer; color:inherit; font:inherit }
.dsac-alert { border:1px solid light-dark(#f0c2be,#5c2b28); background:light-dark(#fdf3f2,#2c1c1b);
  border-radius:8px; padding:10px 12px; display:flex; justify-content:space-between; gap:12px; align-items:flex-start }
.dsac-alert-text { white-space:pre-wrap; word-break:break-word }
.dsac-muted { opacity:.6 }
.dsac-group { display:flex; flex-direction:column; gap:8px }
.dsac-group + .dsac-group { margin-top:6px; padding-top:12px; border-top:1px solid light-dark(#ececef,#2e2e35) }
.dsac-group-name { font-weight:600 }
.dsac-group-desc { opacity:.6 }
.dsac-bucket { display:flex; flex-direction:column; gap:5px }
.dsac-bucket-head { display:flex; justify-content:space-between; gap:12px }
.dsac-bar { height:6px; border-radius:3px; overflow:hidden; background:light-dark(#ececef,#2e2e35) }
.dsac-bar-fill { height:100%; border-radius:3px; transition:width .3s ease }
.dsac-models { display:flex; flex-direction:column; gap:2px; max-height:280px; overflow:auto }
.dsac-model { display:flex; align-items:center; gap:10px; padding:6px 8px; border-radius:7px; cursor:pointer }
.dsac-model:hover { background:light-dark(#f4f4f6,#2b2b32) }
.dsac-model-name { flex:1; min-width:0 }
.dsac-model-pool { opacity:.5; white-space:nowrap }
.dsac-row-actions { display:flex; gap:12px; align-items:center }
      `
      document.head.appendChild(tag)
    }

    /**
     * Call one host API route and unwrap the `{ok, value|error}` envelope.
     * @param {string} route - path below the API prefix.
     * @param {object} [init] - fetch options.
     * @returns {Promise<unknown>} the route's value.
     */
    async function call(route, init) {
      const response = await fetch(`${API}/${route}`, {
        headers: { 'content-type': 'application/json' },
        ...init,
      })
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (body === null || typeof body !== 'object' || body.ok !== true) {
        throw new Error(String(body?.error ?? `HTTP ${response.status}`))
      }
      return body.value
    }

    /**
     * Format a reset timestamp as a countdown.
     * @param {string | undefined} value - ISO timestamp from the backend.
     * @param {(key: string, params?: object) => string} t - translator.
     * @returns {string} the localized countdown.
     */
    function formatReset(value, t) {
      if (typeof value !== 'string' || value.length === 0) return t('resetUnknown')
      const at = Date.parse(value)
      if (Number.isNaN(at)) return t('resetUnknown')
      const remaining = at - Date.now()
      if (remaining <= 0) return t('resetNow')
      const minutes = Math.floor(remaining / 60000)
      if (minutes < 60) return `${minutes}m`
      const hours = Math.floor(minutes / 60)
      if (hours < 48) return `${hours}h ${minutes % 60}m`
      return `${Math.floor(hours / 24)}d ${hours % 24}h`
    }

    /**
     * Format a "last updated" timestamp.
     * @param {number | undefined} at - epoch milliseconds.
     * @param {(key: string, params?: object) => string} t - translator.
     * @returns {string} the localized age.
     */
    function formatAge(at, t) {
      if (typeof at !== 'number') return ''
      const minutes = Math.floor((Date.now() - at) / 60000)
      if (minutes < 1) return t('now')
      if (minutes < 60) return t('minutesAgo', { n: minutes })
      return t('hoursAgo', { n: Math.floor(minutes / 60) })
    }

    /**
     * Count down to an instant, so a pending sign-in is visibly finite.
     * @param {number} at - epoch milliseconds the flow gives up at.
     * @param {(key: string, params?: object) => string} t - translator.
     * @returns {string} the remaining time, or a "taking long" hint once past.
     */
    function formatCountdown(at, t) {
      if (typeof at !== 'number') return ''
      const remaining = at - Date.now()
      if (remaining <= 0) return t('pendingStalled')
      const total = Math.ceil(remaining / 1000)
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      return minutes > 0
        ? `${minutes}m ${String(seconds).padStart(2, '0')}s`
        : `${seconds}s`
    }

    /**
     * Remaining-percentage color: green when comfortable, amber when tight, red when nearly spent.
     * @param {number} fraction - remaining fraction in `[0, 1]`.
     * @returns {string} a CSS color.
     */
    function barColor(fraction) {
      if (fraction <= 0.1) return '#d9534f'
      if (fraction <= 0.3) return '#d98324'
      return '#3fa46a'
    }

    /** One quota bucket: label, remaining percentage, reset countdown, and bar. */
    function QuotaBucket(props) {
      const { bucket, t } = props
      const fraction = typeof bucket.remainingFraction === 'number' ? bucket.remainingFraction : 0
      const percent = Math.round(fraction * 100)
      return React.createElement('div', { className: 'dsac-bucket' },
        React.createElement('div', { className: 'dsac-bucket-head' },
          React.createElement('span', null, bucket.displayName),
          React.createElement('span', { className: 'dsac-muted' },
            `${percent}% · ${t('resetAt', { time: formatReset(bucket.resetTime, t) })}`),
        ),
        React.createElement('div', { className: 'dsac-bar' },
          React.createElement('div', {
            className: 'dsac-bar-fill',
            style: { width: `${Math.max(2, percent)}%`, background: barColor(fraction) },
          }),
        ),
      )
    }

    /** One quota pool with every bucket it reports. */
    function QuotaGroup(props) {
      const { group, t } = props
      const buckets = Array.isArray(group.buckets) ? group.buckets : []
      return React.createElement('div', { className: 'dsac-group' },
        React.createElement('div', { className: 'dsac-group-name' }, group.displayName),
        group.description === undefined
          ? null
          : React.createElement('div', { className: 'dsac-group-desc' }, group.description),
        buckets.map((bucket, index) => React.createElement(QuotaBucket, {
          key: `${bucket.bucketId}-${index}`,
          bucket,
          t,
        })),
      )
    }

    /** The live quota card. */
    function QuotaCard(props) {
      const { quota, t } = props
      const groups = Array.isArray(quota?.groups) ? quota.groups : []
      return React.createElement('div', { className: 'dsac-card' },
        React.createElement('div', { className: 'dsac-card-head' },
          React.createElement('div', { className: 'dsac-card-title' }, t('quota')),
          quota?.fetchedAt === undefined
            ? null
            : React.createElement('div', { className: 'dsac-muted' }, formatAge(quota.fetchedAt, t)),
        ),
        groups.length === 0
          ? React.createElement('div', { className: 'dsac-muted' }, t('quotaEmpty'))
          : groups.map((group, index) => React.createElement(QuotaGroup, {
            key: `${group.displayName}-${index}`,
            group,
            t,
          })),
        React.createElement('div', { className: 'dsac-muted' }, t('quotaNote')),
      )
    }

    /** The Settings > Antigravity page. */
    function AntigravitySettings(props) {
      const ctx = props.ctx
      const [revision, setRevision] = useState(0)
      const [status, setStatus] = useState(undefined)
      const [quota, setQuota] = useState(undefined)
      const [error, setError] = useState(undefined)
      const [busy, setBusy] = useState('')
      const [dirty, setDirty] = useState(false)
      const timer = useRef(0)
      const isMounted = useRef(true)

      // 跟踪组件挂载生命周期，防止卸载后异步回调更新状态
      useEffect(() => {
        isMounted.current = true
        return () => { isMounted.current = false }
      }, [])

      // Re-registering on a locale switch is the documented slot contract, but
      // a plain re-render already refreshes every string this page owns.
      useEffect(() => {
        if (ctx === undefined || typeof ctx.on !== 'function') return undefined
        return ctx.on('locale/change', () => setRevision(value => value + 1))
      }, [ctx])

      const t = useCallback((key, params) => {
        try {
          const bound = ctx?.locale?.bind?.(NS)
          if (typeof bound === 'function') {
            const text = bound(key, params)
            if (typeof text === 'string' && text !== key && text !== `${NS}.${key}`) return text
          }
        } catch {
          // A locale namespace that is not registered yet falls through.
        }
        const active = ctx?.locale?.getLocale?.()?.active
        const isZh = typeof active === 'string'
          ? active.startsWith('zh')
          : typeof navigator !== 'undefined' && String(navigator.language ?? '').startsWith('zh')
        const dict = isZh ? zh : en
        let text = dict[key] ?? en[key] ?? key
        if (params !== null && typeof params === 'object') {
          for (const [name, value] of Object.entries(params)) {
            text = text.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value))
          }
        }
        return text
      }, [ctx, revision])

      /** 刷新宿主环境登录状态 */
      const loadStatus = useCallback(async () => {
        try {
          const statusData = await call('status')
          if (isMounted.current) {
            setStatus(statusData)
            setError(undefined)
          }
        } catch (failure) {
          if (isMounted.current) {
            setError(String(failure?.message ?? failure))
          }
        }
      }, [])

      useEffect(() => { void loadStatus() }, [loadStatus])

      const pendingLogin = status?.login?.state === 'pending'

      // Poll only while a browser sign-in is outstanding, and always stop on unmount.
      useEffect(() => {
        if (!pendingLogin) return undefined
        timer.current = setInterval(() => { void loadStatus() }, LOGIN_POLL_MS)
        return () => { clearInterval(timer.current) }
      }, [pendingLogin, loadStatus])

      const refreshQuota = useCallback(async () => {
        setBusy('quota')
        try {
          const quotaData = await call('quota', { method: 'POST' })
          if (isMounted.current) {
            setQuota(quotaData)
            setError(undefined)
          }
        } catch (failure) {
          if (isMounted.current) {
            setError(String(failure?.message ?? failure))
          }
        } finally {
          if (isMounted.current) {
            setBusy('')
          }
        }
      }, [])

      // 登录状态与额度联动：已登录时打开设置页自动刷新额度，未登录时清空额度
      const signedIn = status?.signedIn === true
      useEffect(() => {
        if (!signedIn) {
          setQuota(undefined)
          return
        }
        // 打开设置页且处于已登录状态时，自动触发一次额度获取，无需手动点击
        void refreshQuota()
      }, [signedIn, refreshQuota])

      const signIn = useCallback(async () => {
        setBusy('login')
        try {
          await call('login', { method: 'POST' })
          await loadStatus()
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy('')
        }
      }, [loadStatus])

      const cancelSignIn = useCallback(async () => {
        setBusy('login')
        try {
          await call('login/cancel', { method: 'POST' })
          await loadStatus()
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy('')
        }
      }, [loadStatus])

      const signOut = useCallback(async () => {
        setBusy('logout')
        try {
          setStatus(await call('logout', { method: 'POST' }))
          setQuota(undefined)
          setError(undefined)
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy('')
        }
      }, [])

      /** Persist the model selection and adopt the returned state. */
      const saveModels = useCallback(async (enabledModelIds) => {
        setBusy('models')
        setDirty(true)
        try {
          setStatus(await call('models', {
            method: 'POST',
            body: JSON.stringify({ enabledModelIds }),
          }))
          setError(undefined)
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy('')
        }
      }, [])

      const models = Array.isArray(status?.models) ? status.models : []
      const enabledIds = useMemo(
        () => models.filter(model => model.enabled).map(model => model.id),
        [models],
      )

      const toggleModel = useCallback((id, next) => {
        const set = new Set(enabledIds)
        if (next) set.add(id)
        else set.delete(id)
        // Preserve catalog order so the stored document is stable.
        void saveModels(models.filter(model => set.has(model.id)).map(model => model.id))
      }, [enabledIds, models, saveModels])

      const poolLabelFor = useCallback((pool) => (
        pool === 'third-party' ? t('poolThirdParty') : t('poolGemini')
      ), [t])

      return React.createElement('div', { className: 'dsac-page' },
        React.createElement('div', { className: 'dsac-head' },
          React.createElement('div', null,
            React.createElement('h2', { className: 'dsac-title' }, t('title')),
            React.createElement('p', { className: 'dsac-sub' }, t('subtitle')),
          ),
          React.createElement('div', { className: 'dsac-actions' },
            signedIn
              ? React.createElement('button', {
                type: 'button',
                className: 'dsac-btn',
                disabled: busy !== '',
                onClick: refreshQuota,
              }, busy === 'quota' ? t('refreshing') : t('refresh'))
              : null,
            pendingLogin
              ? React.createElement('button', {
                type: 'button',
                className: 'dsac-btn',
                disabled: busy !== '',
                onClick: cancelSignIn,
              }, t('cancel'))
              : signedIn
                ? React.createElement('button', {
                  type: 'button',
                  className: 'dsac-btn',
                  disabled: busy !== '',
                  onClick: signOut,
                }, t('logout'))
                : React.createElement('button', {
                  type: 'button',
                  className: 'dsac-btn dsac-btn-primary',
                  disabled: busy !== '',
                  onClick: signIn,
                }, busy === 'login' ? t('loggingIn') : t('login')),
          ),
        ),

        error === undefined ? null : React.createElement('div', { className: 'dsac-alert' },
          React.createElement('div', { className: 'dsac-alert-text' }, `${t('failure')}: ${error}`),
          React.createElement('button', {
            type: 'button',
            className: 'dsac-btn-link',
            onClick: () => { void loadStatus() },
          }, t('retry')),
        ),

        pendingLogin ? React.createElement('div', { className: 'dsac-card' },
          React.createElement('div', null, t('pending')),
          status?.login?.expiresAt === undefined
            ? null
            : React.createElement('div', { className: 'dsac-muted' },
              t('pendingExpires', { time: formatCountdown(status.login.expiresAt, t) })),
          status?.login?.authUrl === undefined ? null : React.createElement('div', { className: 'dsac-muted' },
            `${t('openManually')} `,
            React.createElement('a', {
              href: status.login.authUrl,
              target: '_blank',
              rel: 'noreferrer',
              className: 'dsac-btn-link',
            }, t('openLink')),
          ),
          React.createElement('div', { className: 'dsac-muted' }, t('callbackPortHint')),
        ) : null,

        signedIn ? React.createElement('div', { className: 'dsac-card' },
          React.createElement('div', { className: 'dsac-card-head' },
            React.createElement('div', { className: 'dsac-card-title' }, t('account')),
          ),
          React.createElement('dl', { className: 'dsac-kv' },
            React.createElement('dt', null, 'Google'),
            React.createElement('dd', null, status?.email ?? '—'),
            React.createElement('dt', null, t('project')),
            React.createElement('dd', null, status?.projectId ?? quota?.projectId ?? '—'),
            quota?.planLabel === undefined ? null : React.createElement('dt', null, t('plan')),
            quota?.planLabel === undefined ? null : React.createElement('dd', null, quota.planLabel),
          ),
        ) : React.createElement('div', { className: 'dsac-card' },
          React.createElement('div', null, t('notSignedIn')),
          React.createElement('div', { className: 'dsac-muted' }, t('notSignedInHint')),
        ),

        signedIn ? React.createElement(QuotaCard, { quota, t }) : null,

        React.createElement('div', { className: 'dsac-card' },
          React.createElement('div', { className: 'dsac-card-head' },
            React.createElement('div', { className: 'dsac-card-title' }, t('models')),
            React.createElement('div', { className: 'dsac-row-actions' },
              busy === 'models' && dirty
                ? React.createElement('span', { className: 'dsac-muted' }, t('saved'))
                : null,
              React.createElement('button', {
                type: 'button',
                className: 'dsac-btn-link',
                disabled: busy !== '' || models.length === 0,
                onClick: () => { void saveModels(models.map(model => model.id)) },
              }, t('selectAll')),
              React.createElement('button', {
                type: 'button',
                className: 'dsac-btn-link',
                disabled: busy !== '' || models.length === 0,
                onClick: () => { void saveModels([]) },
              }, t('selectNone')),
            ),
          ),
          React.createElement('div', { className: 'dsac-muted' }, t('modelsHint')),
          models.length === 0
            ? React.createElement('div', { className: 'dsac-muted' }, t('modelsEmpty'))
            : React.createElement('div', { className: 'dsac-models' },
              models.map(model => React.createElement('label', {
                key: model.id,
                className: 'dsac-model',
              },
              React.createElement('input', {
                type: 'checkbox',
                checked: model.enabled === true,
                disabled: busy !== '',
                onChange: event => toggleModel(model.id, event.target.checked),
              }),
              React.createElement('span', { className: 'dsac-model-name' }, model.name),
              React.createElement('span', { className: 'dsac-model-pool' }, poolLabelFor(model.pool)),
              )),
            ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        installStyle()
        const t = (key, params) => {
          try {
            const bound = ctx?.locale?.bind?.(NS)
            if (typeof bound === 'function') {
              const text = bound(key, params)
              if (typeof text === 'string' && text !== key && text !== `${NS}.${key}`) return text
            }
          } catch {
            // Falls through to the key so a broken namespace cannot blank the nav.
          }
          return en[key] ?? key
        }
        if (ctx?.locale !== undefined && typeof ctx.locale.register === 'function') {
          ctx.locale.register(NS, { zh, en })
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'antigravity-connect',
          order: 12,
          // Read at render time, so a locale switch relabels the nav row.
          label: () => t('nav'),
        }, props => React.createElement(AntigravitySettings, { ...props, ctx })))
      },
    }
  },
})
