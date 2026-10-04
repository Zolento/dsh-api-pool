/**
 * dsh-api-pool — browser half.
 *
 * Contributes one settings page ("API Pool") through the harness's public
 * slots/configForms seams. The page edits this plugin's own volatile settings
 * namespace: add, edit, enable/disable and delete upstream endpoints, and pick
 * the selection strategy and the advertised models.
 *
 * It is deliberately plain JavaScript using only the published loader protocol
 * (`window.__ModuleLoader__.load`) and the `configForms` service, with no
 * cross-plugin value imports.
 */
window.__ModuleLoader__.load({
  id: 'dsh-api-pool',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dshApiPool'

    const COPY = {
      zh: {
        nav: 'API 池',
        title: 'API 池',
        intro: '把多个 OpenAI 兼容端点（多个 key）作为一个容量池使用；失败会按错误类型冷却并自动切换到下一个端点。',
        enabled: '启用 API 池',
        strategy: '选择策略',
        strategyLeastLoaded: 'least_loaded（按 RPM 负载）',
        strategyPriority: 'priority（按优先级）',
        strategyRoundRobin: 'round_robin（轮询）',
        models: '模型（逗号分隔）',
        endpoints: '上游端点',
        empty: '还没有端点。先添加一个（例如 ustc）。',
        name: '名称',
        baseURL: 'Base URL',
        apiKeyEnv: 'Key 引用 / 环境变量',
        model: '模型覆盖（可空）',
        priority: '优先级',
        add: '添加端点',
        addTitle: '添加端点',
        remove: '删除',
        save: '保存',
        cancel: '取消',
        loading: '正在读取配置…',
        unavailableHost: 'Host 未提供 dsh-api-pool 设置命名空间（插件未挂载或已停用）。',
        unavailableMemory: 'DSH 的 Host 设置只能在从 127.0.0.1 / localhost 打开的页面读写。当前页面来自非 loopback 源（例如 frp 域名），所以设置被切到进程内只读模式——聊天和模型选择不受影响。要管理端点：用 SSH 端口转发后访问 http://127.0.0.1:3080，或在宿主上直接编辑 profile 的 dsh-api-pool 配置。',
        readOnly: '当前配置只读。',
        writeFailed: '写入被拒绝，请检查值是否合法。',
        advanced: '高级',
        rpmLimit: 'RPM 上限（可空）',
      },
      en: {
        nav: 'API Pool',
        title: 'API Pool',
        intro: 'Use several OpenAI-compatible endpoints (several keys) as one capacity pool; failures are classified, cooled down, and retried on the next endpoint.',
        enabled: 'Enable API pool',
        strategy: 'Strategy',
        strategyLeastLoaded: 'least_loaded (by RPM load)',
        strategyPriority: 'priority',
        strategyRoundRobin: 'round_robin',
        models: 'Models (comma separated)',
        endpoints: 'Upstream endpoints',
        empty: 'No endpoints yet. Add one (for example ustc).',
        name: 'Name',
        baseURL: 'Base URL',
        apiKeyEnv: 'Key reference / env var',
        model: 'Model override (optional)',
        priority: 'Priority',
        add: 'Add endpoint',
        addTitle: 'Add endpoint',
        remove: 'Remove',
        save: 'Save',
        cancel: 'Cancel',
        loading: 'Loading configuration…',
        unavailableHost: 'The Host does not serve the dsh-api-pool settings namespace (plugin not mounted or disabled).',
        unavailableMemory: 'DeepSeek Harness serves Host settings only to pages opened from 127.0.0.1 / localhost. This page came from a non-loopback origin (for example an frp domain), so settings are process-local and read-only here — chat and model selection are unaffected. To manage endpoints, open http://127.0.0.1:3080 through an SSH port forward, or edit the dsh-api-pool config in the Host profile file.',
        readOnly: 'Configuration is read-only.',
        writeFailed: 'The write was refused; check the values.',
        advanced: 'Advanced',
        rpmLimit: 'RPM limit (optional)',
      },
    }

    const field = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }
    const input = { padding: '4px 6px', fontSize: 13, borderRadius: 4, border: '1px solid var(--dsh-border, #3a3a3a)', background: 'var(--dsh-input-background, transparent)', color: 'inherit' }
    const row = { display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }
    const card = { border: '1px solid var(--dsh-border, #3a3a3a)', borderRadius: 8, padding: 12, marginBottom: 12 }
    const button = { ...input, cursor: 'pointer' }

    function textField(label, value, onChange, options = {}) {
      return h('label', { style: field },
        h('span', null, label),
        h('input', {
          style: input,
          type: 'text',
          value: value ?? '',
          placeholder: options.placeholder ?? '',
          disabled: options.disabled === true,
          onChange: event => onChange(event.target.value),
        }),
      )
    }

    function EndpointRow({ endpoint, index, t, readOnly, onMutate }) {
      const setField = (key, value) => onMutate([{ op: 'set', path: ['endpoints', index, key], value }])
      return h('div', { style: { ...card, background: 'var(--dsh-surface-secondary, transparent)' } },
        h('div', { style: row },
          h('strong', { style: { fontSize: 13 } }, endpoint.name || '?'),
          h('label', { style: { ...field, flexDirection: 'row', gap: 6, alignItems: 'center' } },
            h('input', {
              type: 'checkbox',
              checked: endpoint.enabled !== false,
              disabled: readOnly,
              onChange: event => setField('enabled', event.target.checked),
            }),
            h('span', null, t('enabled')),
          ),
        ),
        h('div', { style: { ...row, marginTop: 8 } },
          textField(t('baseURL'), endpoint.baseURL, value => setField('baseURL', value), { disabled: readOnly }),
          textField(t('apiKeyEnv'), endpoint.apiKeyEnv, value => setField('apiKeyEnv', value), { disabled: readOnly, placeholder: 'USTC_API_KEY' }),
        ),
        h('div', { style: { ...row, marginTop: 8 } },
          textField(t('model'), endpoint.model, value => setField('model', value), { disabled: readOnly, placeholder: 'deepseek-flash' }),
          textField(t('priority'), endpoint.priority, value => setField('priority', Number(value) || 100), { disabled: readOnly }),
          textField(t('rpmLimit'), endpoint.rpmLimit, value => setField('rpmLimit', value === '' ? undefined : Number(value)), { disabled: readOnly }),
        ),
        h('div', { style: { marginTop: 8 } },
          h('button', {
            type: 'button',
            style: { ...button, color: '#e06c75' },
            disabled: readOnly,
            onClick: () => onMutate([{ op: 'unset', path: ['endpoints', index] }]),
          }, t('remove')),
        ),
      )
    }

    function AddEndpoint({ t, readOnly, form }) {
      const [draft, setDraft] = React.useState({ name: '', baseURL: '', apiKeyEnv: '', priority: 100 })
      const update = (key, value) => setDraft(previous => ({ ...previous, [key]: value }))
      const submit = () => {
        const name = draft.name.trim()
        const baseURL = draft.baseURL.trim()
        if (name === '' || baseURL === '') return
        const snapshot = form.getSnapshot()
        const current = Array.isArray(snapshot.value?.endpoints) ? snapshot.value.endpoints : []
        void form.mutate([{
          op: 'set',
          path: ['endpoints'],
          value: [...current, {
            name,
            baseURL,
            ...draft.apiKeyEnv.trim() === '' ? {} : { apiKeyEnv: draft.apiKeyEnv.trim() },
            priority: Number(draft.priority) || 100,
            enabled: true,
          }],
        }])
        setDraft({ name: '', baseURL: '', apiKeyEnv: '', priority: 100 })
      }
      return h('div', { style: card },
        h('h4', { style: { margin: '0 0 8px', fontSize: 13 } }, t('addTitle')),
        h('div', { style: row },
          textField(t('name'), draft.name, value => update('name', value), { disabled: readOnly, placeholder: 'ustc' }),
          textField(t('baseURL'), draft.baseURL, value => update('baseURL', value), { disabled: readOnly, placeholder: 'https://api.llm.ustc.edu.cn/v1' }),
          textField(t('apiKeyEnv'), draft.apiKeyEnv, value => update('apiKeyEnv', value), { disabled: readOnly, placeholder: 'USTC_API_KEY' }),
          textField(t('priority'), draft.priority, value => update('priority', value), { disabled: readOnly }),
        ),
        h('div', { style: { marginTop: 8 } },
          h('button', { type: 'button', style: button, disabled: readOnly, onClick: submit }, t('add')),
        ),
      )
    }

    function ApiPoolSection(props) {
      const { form, t } = props
      const snapshot = React.useSyncExternalStore(
        listener => form.subscribe(listener),
        () => form.getSnapshot(),
      )
      if (snapshot.status === 'loading') return h('p', null, t('loading'))
      if (snapshot.status === 'unavailable') {
        // `memory` mode means DSH refused Host settings for this page origin
        // (non-loopback); `host` mode means the namespace really is absent.
        return h('p', null, t(snapshot.mode === 'memory' ? 'unavailableMemory' : 'unavailableHost'))
      }
      const value = snapshot.value ?? {}
      const endpoints = Array.isArray(value.endpoints) ? value.endpoints : []
      const readOnly = snapshot.writable !== true
      const mutate = ops => { void form.mutate(ops) }

      const strategySelect = h('label', { style: field },
        h('span', null, t('strategy')),
        h('select', {
          style: input,
          value: value.strategy ?? 'least_loaded',
          disabled: readOnly,
          onChange: event => mutate([{ op: 'set', path: ['strategy'], value: event.target.value }]),
        },
        h('option', { value: 'least_loaded' }, t('strategyLeastLoaded')),
        h('option', { value: 'priority' }, t('strategyPriority')),
        h('option', { value: 'round_robin' }, t('strategyRoundRobin')),
        ),
      )

      const modelsField = textField(t('models'), Array.isArray(value.models) ? value.models.join(', ') : '', raw => {
        const models = raw.split(',').map(model => model.trim()).filter(model => model !== '')
        mutate([{ op: 'set', path: ['models'], value: models }])
      }, { disabled: readOnly })

      const toggles = h('div', { style: { ...row, marginBottom: 12 } },
        h('label', { style: { ...field, flexDirection: 'row', gap: 6, alignItems: 'center' } },
          h('input', { type: 'checkbox', checked: value.enabled !== false, disabled: readOnly, onChange: event => mutate([{ op: 'set', path: ['enabled'], value: event.target.checked }]) }),
          h('span', null, t('enabled')),
        ),
      )

      return h('div', { style: { padding: 16, maxWidth: 760 } },
        h('h3', { style: { margin: '0 0 8px' } }, t('title')),
        h('p', { style: { fontSize: 13, opacity: 0.8, marginTop: 0 } }, t('intro')),
        readOnly ? h('p', { role: 'status', style: { fontSize: 12, color: '#d19a66' } }, t('readOnly')) : null,
        toggles,
        h('div', { style: row }, strategySelect, modelsField),
        h('h4', { style: { margin: '16px 0 8px', fontSize: 13 } }, t('endpoints')),
        endpoints.length === 0 ? h('p', { style: { fontSize: 13, opacity: 0.7 } }, t('empty')) : null,
        endpoints.map((endpoint, index) => h(EndpointRow, {
          key: `${endpoint.name ?? index}-${index}`,
          endpoint: endpoint ?? {},
          index,
          t,
          readOnly,
          onMutate: mutate,
        })),
        h(AddEndpoint, { t, readOnly, form }),
      )
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, COPY), 'dsh-api-pool: dictionaries')
        const form = ctx.configForms.get('dsh-api-pool')
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'api-pool',
          order: 35,
          label: () => t('nav'),
          locale: NS,
          inject: () => ({ form, t }),
        }, ApiPoolSection))
      },
    }
  },
})
