/**
 * dsh-plugin-x-digest —— 浏览器半侧：在「设置」里加一页「X 速览」
 *
 * ⚠️ client bundle 不是 ESM，是自注册脚本（跟 dsh-bili-scroll 同一个约定）：
 *     window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => { ... } })
 *   id 必须等于 package.json 的 name。
 *
 * 设置页和 DSH 页面同源，所以只能调宿主的 /api/x-digest/*（宿主再转发给本地服务）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-x-digest',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const API = '/api/x-digest';

    async function call(path, options) {
      const res = await fetch(API + path, {
        headers: { accept: 'application/json', ...(options?.body ? { 'content-type': 'application/json' } : {}) },
        ...options,
        body: options?.body ? JSON.stringify(options.body) : undefined,
      });
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (!res.ok || body?.ok === false) throw new Error(body?.error ?? `HTTP ${res.status}`);
      return body;
    }

    const S = {
      label: { fontSize: 12, color: 'var(--dsh-text-secondary, #6b7280)', marginBottom: 4, display: 'block' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsh-border, #d1d5db)',
        background: 'var(--dsh-surface, #fff)',
        color: 'inherit',
        fontSize: 13,
      },
      field: { marginBottom: 14 },
      row: { display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' },
      btn: {
        padding: '6px 14px',
        borderRadius: 6,
        border: '1px solid var(--dsh-border, #d1d5db)',
        background: 'var(--dsh-surface, #fff)',
        color: 'inherit',
        fontSize: 13,
        cursor: 'pointer',
      },
      btnPrimary: { background: '#2563eb', borderColor: '#2563eb', color: '#fff' },
      hint: { fontSize: 12, color: 'var(--dsh-text-secondary, #6b7280)', lineHeight: 1.7 },
      card: {
        marginTop: 22,
        paddingTop: 18,
        borderTop: '1px solid var(--dsh-border, #e5e7eb)',
      },
      cardTitle: { fontSize: 14, fontWeight: 600, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 },
      badge: (ok) => ({
        fontSize: 11,
        padding: '2px 8px',
        borderRadius: 999,
        marginLeft: 8,
        background: ok ? '#dcfce7' : '#f3f4f6',
        color: ok ? '#15803d' : '#6b7280',
      }),
      code: {
        fontSize: 12,
        padding: '6px 8px',
        borderRadius: 6,
        background: 'var(--dsh-surface-alt, #f3f4f6)',
        wordBreak: 'break-all',
      },
    };

    // 「刷过的推文」里每种状态的显示名
    const ACTION_LABEL = {
      posted: { label: '已发', color: '#15803d' },
      dry: { label: '干跑', color: '#6b7280' },
      sensitive: { label: '敏感·已跳过', color: '#dc2626' },
      failed: { label: '失败', color: '#dc2626' },
    };

    const dot = (ok) => ({      display: 'inline-block',
      width: 7,
      height: 7,
      borderRadius: '50%',
      background: ok ? '#16a34a' : '#9ca3af',
      marginRight: 6,
    });

    function Tutorial() {
      return h(
        'details',
        { style: { marginBottom: 14 } },
        h('summary', { style: { fontSize: 12, cursor: 'pointer', color: '#2563eb' } }, '怎么拿到这些值？（点开看步骤）'),
        h(
          'div',
          { style: { ...S.hint, marginTop: 8, paddingLeft: 12, borderLeft: '2px solid #e5e7eb' } },
          h('div', { style: { marginBottom: 10 } },
            h('b', null, '① Client ID / Client Secret'),
            h('div', null, 'developer.x.com → Apps → 你的 App → Keys & Tokens → OAuth 2.0 Keys。'),
            h('div', null, '如果看不到，点 Regenerate 生成一对，只显示一次，当场复制。'),
          ),
          h('div', { style: { marginBottom: 10 } },
            h('b', null, '② cookie（auth_token / ct0）'),
            h('div', null, '用【小号】登录 x.com → F12 → Application（应用程序）→ Cookies → https://x.com'),
            h('div', null, '找 auth_token 和 ct0 两行，双击 Value 复制。auth_token 是 HttpOnly，document.cookie 读不到。'),
          ),
          h('div', null,
            h('b', null, '③ 授权'),
            h('div', null, '点下面的「生成授权链接」，确认浏览器里登录的是小号，打开链接点 Authorize。'),
            h('div', null, '跳转失败是正常的，从地址栏复制 code= 后面那串，粘到下面提交。'),
          ),
        ),
      );
    }

    function Panel() {
      const [state, setState] = useState(null);
      const [form, setForm] = useState(null);
      const [creds, setCreds] = useState(null);
      const [credForm, setCredForm] = useState({ clientId: '', clientSecret: '', authToken: '', ct0: '' });
      const [authUrl, setAuthUrl] = useState('');
      const [authCode, setAuthCode] = useState('');
      const [prompt, setPrompt] = useState('');
      const [history, setHistory] = useState(null);
      const [message, setMessage] = useState('');
      const [busy, setBusy] = useState(false);
      const [result, setResult] = useState(null);

      const load = useCallback(async () => {
        setBusy(true);
        setMessage('');
        try {
          const [data, credentials] = await Promise.all([
            call('/state').catch(() => ({ online: false, errors: ['连不上服务'] })),
            call('/credentials').catch(() => null),
          ]);
          setState(data);
          setCreds(credentials);
          const promptRes = await call('/prompt').catch(() => null);
          if (promptRes?.text) setPrompt(promptRes.text);
          const hist = await call('/history?limit=30').catch(() => null);
          if (hist) setHistory(hist);
          if (data.config) {
            setForm({
              watchHandles: data.config.watchHandles ?? '',
              targetHandle: data.config.targetHandle ?? '',
              postMode: data.config.postMode ?? 'off',
              maxPicks: String(data.config.maxPicks ?? 2),
              source: data.config.source ?? 'handles',
              searchQueries: data.config.searchQueries ?? '',
              searchProduct: data.config.searchProduct ?? 'Top',
              searchMinLikes: String(data.config.searchMinLikes ?? 100),
              mentionWatch: Boolean(data.config.mentionWatch),
              mentionPollMinutes: String(data.config.mentionPollMinutes ?? 5),
              mentionWhitelist: data.config.mentionWhitelist ?? '',
            });
          }
        } catch (err) {
          setMessage(`读取失败：${err.message}`);
        } finally {
          setBusy(false);
        }
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      const save = async () => {
        setBusy(true);
        setMessage('');
        try {
          const res = await call('/config', { method: 'POST', body: form });
          setMessage(res?.changed?.length ? `配置已保存：${res.changed.join('、')}` : '配置没有变化');
          await load();
        } catch (err) {
          setMessage(`保存失败：${err.message}`);
        } finally {
          setBusy(false);
        }
      };

      const runOnce = async () => {
        setBusy(true);
        setMessage('');
        setResult(null);
        try {
          const res = await call('/run', { method: 'POST', body: { dry: true } });
          setResult(res?.result ?? null);
        } catch (err) {
          setMessage(`跑一轮失败：${err.message}`);
        } finally {
          setBusy(false);
        }
      };

      const saveCreds = async () => {
        setBusy(true);
        setMessage('');
        try {
          const patch = {};
          if (credForm.clientId.trim()) patch.clientId = credForm.clientId.trim();
          if (credForm.clientSecret.trim()) patch.clientSecret = credForm.clientSecret.trim();
          if (credForm.authToken.trim()) patch.authToken = credForm.authToken.trim();
          if (credForm.ct0.trim()) patch.ct0 = credForm.ct0.trim();
          if (!Object.keys(patch).length) {
            setMessage('没有要保存的内容（四个框都是空的）');
            return;
          }
          const res = await call('/credentials', { method: 'POST', body: patch });
          setCreds(res);
          setCredForm({ clientId: '', clientSecret: '', authToken: '', ct0: '' });
          setMessage(`凭据已保存：${(res.changed ?? []).join('、') || '无变化'}`);
        } catch (err) {
          setMessage(`保存凭据失败：${err.message}`);
        } finally {
          setBusy(false);
        }
      };

      const startAuth = async () => {
        setBusy(true);
        setMessage('');
        try {
          const res = await call('/auth/start', { method: 'POST', body: {} });
          setAuthUrl(res.authorizeUrl ?? '');
        } catch (err) {
          setMessage(`生成授权链接失败：${err.message}`);
        } finally {
          setBusy(false);
        }
      };

      const checkMentions = async () => {
        setBusy(true);
        setMessage('');
        try {
          const res = await call('/mentions/check', { method: 'POST', body: {} });
          setMessage(
            res.matched > 0
              ? `发现 ${res.matched} 条 @，已回复 ${res.replied} 条`
              : '没有新的 @ 提及',
          );
        } catch (err) {
          setMessage(`检查失败：${err.message}`);
        } finally {
          setBusy(false);
        }
      };

      const savePrompt = async () => {
        setBusy(true);
        setMessage('');
        try {
          const res = await call('/prompt', { method: 'POST', body: { text: prompt } });
          setMessage(`提示词已保存（${res?.length ?? prompt.length} 字），下一轮生效`);
        } catch (err) {
          setMessage(`保存提示词失败：${err.message}`);
        } finally {
          setBusy(false);
        }
      };

      const finishAuth = async () => {        setBusy(true);
        setMessage('');
        try {
          const res = await call('/auth/finish', { method: 'POST', body: { code: authCode.trim() } });
          setCreds(res);
          setAuthCode('');
          setAuthUrl('');
          setMessage(res.screenName ? `授权成功：@${res.screenName}` : '授权成功');
        } catch (err) {
          setMessage(`授权失败：${err.message}`);
        } finally {
          setBusy(false);
        }
      };

      const online = Boolean(state?.online);
      const config = state?.config;

      return h(
        'div',
        { style: { maxWidth: 620, padding: '4px 2px' } },

        h(
          'div',
          { style: { ...S.row, marginBottom: 10 } },
          h('span', { style: { fontSize: 13 } }, h('span', { style: dot(online) }), online ? '服务在线' : '服务离线'),
          config
            ? h('span', { style: S.hint }, `在刷：${config.watchHandles || '（没配）'} · 已记录 ${state?.state?.seen ?? 0} 条`)
            : null,
          h('button', { style: S.btn, onClick: load, disabled: busy }, '刷新'),
        ),

        h('div', { style: { ...S.hint, marginBottom: 16 } },
          `服务地址：${state?.baseUrl ?? '(未知)'}　`,
          creds?.canPost ? `发推身份：@${creds.actingAs || '已授权'}` : '发推凭据：未就绪',
        ),

        // ── 配置 ──
        form
          ? h(
              'div',
              null,
              // 内容来源：关注账号 / 关键词搜索
              h(
                'div',
                { style: S.field },
                h('label', { style: S.label }, '内容从哪来'),
                h(
                  'div',
                  { style: { display: 'flex', gap: 18, fontSize: 13 } },
                  h(
                    'label',
                    { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                    h('input', {
                      type: 'radio',
                      name: 'x-digest-source',
                      checked: form.source !== 'search',
                      onChange: () => setForm({ ...form, source: 'handles' }),
                    }),
                    '关注账号的时间线',
                  ),
                  h(
                    'label',
                    { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                    h('input', {
                      type: 'radio',
                      name: 'x-digest-source',
                      checked: form.source === 'search',
                      onChange: () => setForm({ ...form, source: 'search' }),
                    }),
                    '按关键词搜索（相当于分区）',
                  ),
                  h(
                    'label',
                    { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                    h('input', {
                      type: 'radio',
                      name: 'x-digest-source',
                      checked: form.source === 'home',
                      onChange: () => setForm({ ...form, source: 'home' }),
                    }),
                    '首页推荐流（For You）',
                  ),
                ),
              ),

              form.source === 'home'
                ? h(
                    'div',
                    { style: { ...S.hint, marginBottom: 14 } },
                    '⚠️ 推荐流质量取决于这个小号平时刷什么。新号的推荐流可能是身材照和广告，建议先手动刷几天再用。',
                  )
                : null,

              form.source === 'search'
                ? h(
                    'div',
                    null,
                    h(
                      'div',
                      { style: S.field },
                      h('label', { style: S.label }, '关键词（逗号分隔；支持 X 搜索语法，如 "AI agent -filter:replies"）'),
                      h('input', {
                        style: S.input,
                        value: form.searchQueries,
                        placeholder: 'AI agent,DeepSeek,具身智能',
                        onChange: (e) => setForm({ ...form, searchQueries: e.target.value }),
                      }),
                    ),
                    h(
                      'div',
                      { style: { display: 'flex', gap: 18 } },
                      h(
                        'div',
                        { style: { ...S.field, width: 200 } },
                        h('label', { style: S.label }, '排序'),
                        h(
                          'select',
                          {
                            style: S.input,
                            value: form.searchProduct,
                            onChange: (e) => setForm({ ...form, searchProduct: e.target.value }),
                          },
                          h('option', { value: 'Top' }, 'Top — 热门（质量高）'),
                          h('option', { value: 'Latest' }, 'Latest — 最新'),
                        ),
                      ),
                      h(
                        'div',
                        { style: { ...S.field, width: 180 } },
                        h('label', { style: S.label }, '最低赞数'),
                        h('input', {
                          style: S.input,
                          type: 'number',
                          min: 0,
                          value: form.searchMinLikes,
                          onChange: (e) => setForm({ ...form, searchMinLikes: e.target.value }),
                        }),
                      ),
                    ),
                    h(
                      'div',
                      { style: { ...S.hint, marginBottom: 14 } },
                      '最低赞数会自动拼成 min_faves:N。实测 100 能挡掉绝大部分打卡和推广帖；嫌少可以调到 50，嫌杂调到 300。',
                    ),
                  )
                : h(
                    'div',
                    { style: S.field },
                    h('label', { style: S.label }, '关注这些账号（逗号分隔，不带 @）'),
                    h('input', {
                      style: S.input,
                      value: form.watchHandles,
                      placeholder: 'sama,karpathy',
                      onChange: (e) => setForm({ ...form, watchHandles: e.target.value }),
                    }),
                  ),
              h(
                'div',
                { style: S.field },
                h('label', { style: S.label }, '@ 谁（收到摘要的账号）'),
                h('input', {
                  style: S.input,
                  value: form.targetHandle,
                  placeholder: 'your_handle',
                  onChange: (e) => setForm({ ...form, targetHandle: e.target.value }),
                }),
              ),
              h(
                'div',
                { style: { display: 'flex', gap: 18 } },
                h(
                  'div',
                  { style: { ...S.field, flex: 1 } },
                  h('label', { style: S.label }, '发推模式'),
                  h(
                    'select',
                    { style: S.input, value: form.postMode, onChange: (e) => setForm({ ...form, postMode: e.target.value }) },
                    h('option', { value: 'off' }, 'off — 只打印不发送'),
                    h('option', { value: 'reply' }, 'reply — 回复你最近一条推'),
                    h('option', { value: 'mention' }, 'mention — 单独发一条 @ 你'),
                    h('option', { value: 'comment' }, 'comment — 在挑中的推文下 @ 你'),
                  ),
                ),
                h(
                  'div',
                  { style: { ...S.field, width: 140 } },
                  h('label', { style: S.label }, '每次挑几条'),
                  h('input', {
                    style: S.input,
                    type: 'number',
                    min: 1,
                    max: 5,
                    value: form.maxPicks,
                    onChange: (e) => setForm({ ...form, maxPicks: e.target.value }),
                  }),
                ),
              ),
              h(
                'div',
                { style: S.row },
                h('button', { style: { ...S.btn, ...S.btnPrimary }, onClick: save, disabled: busy }, '保存'),
                h('button', { style: S.btn, onClick: runOnce, disabled: busy }, '现在跑一轮（干跑）'),
                busy ? h('span', { style: S.hint }, '处理中…') : null,
              ),
            )
          : h('div', { style: S.hint }, '连不上服务。先确认它在跑，再点刷新。'),

        // ── 监听 @ 回复 ──
        form
          ? h(
              'div',
              { style: S.card },
              h(
                'div',
                { style: S.cardTitle },
                '监听 @ 回复',
                h('span', { style: S.badge(form.mentionWatch) }, form.mentionWatch ? '已开启' : '已关闭'),
              ),
              h(
                'div',
                { style: { ...S.hint, marginBottom: 12 } },
                '有人 @ 它时自动回一句。只回白名单里的账号，其他人一律不理。',
              ),
              h(
                'div',
                { style: { display: 'flex', gap: 18 } },
                h(
                  'div',
                  { style: { ...S.field, flex: 1 } },
                  h('label', { style: S.label }, '开关'),
                  h(
                    'label',
                    { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 } },
                    h('input', {
                      type: 'checkbox',
                      checked: form.mentionWatch,
                      onChange: (e) => setForm({ ...form, mentionWatch: e.target.checked }),
                    }),
                    form.mentionWatch ? '开启（每 ' + form.mentionPollMinutes + ' 分钟查一次）' : '关闭',
                  ),
                ),
                h(
                  'div',
                  { style: { ...S.field, width: 160 } },
                  h('label', { style: S.label }, '检查频率（分钟）'),
                  h('input', {
                    style: S.input,
                    type: 'number',
                    min: 1,
                    max: 60,
                    value: form.mentionPollMinutes,
                    onChange: (e) => setForm({ ...form, mentionPollMinutes: e.target.value }),
                  }),
                ),
              ),
              h(
                'div',
                { style: S.field },
                h('label', { style: S.label }, '只回这些人（逗号分隔；留空 = 只回「@ 谁」那个账号）'),
                h('input', {
                  style: S.input,
                  value: form.mentionWhitelist,
                  placeholder: form.targetHandle || 'your_handle',
                  onChange: (e) => setForm({ ...form, mentionWhitelist: e.target.value }),
                }),
              ),
              h(
                'div',
                { style: { ...S.row, marginBottom: 0 } },
                h('button', { style: { ...S.btn, ...S.btnPrimary }, onClick: save, disabled: busy }, '保存'),
                h('button', { style: S.btn, onClick: checkMentions, disabled: busy }, '立即检查一次'),
              ),
            )
          : null,

        message
          ? h('div', { style: { fontSize: 13, marginTop: 8, color: /失败|连不上/.test(message) ? '#dc2626' : '#16a34a' } }, message)
          : null,

        result
          ? h(
              'div',
              { style: { marginTop: 14, padding: 12, borderRadius: 8, background: 'var(--dsh-surface-alt, #f9fafb)', fontSize: 13 } },
              h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '这一轮的结果（没有发送）'),
              h('div', null, `抓取 ${result.fetched ?? 0} 条 · 新 ${result.candidates ?? 0} 条 · 挑中 ${(result.picks ?? []).length} 条`),
              result.skipped ? h('div', { style: S.hint }, `跳过原因：${result.skipped}`) : null,
              Array.isArray(result.picks) && result.picks.length
                ? h(
                    'ul',
                    { style: { margin: '10px 0 0', paddingLeft: 18 } },
                    result.picks.map((p) =>
                      h(
                        'li',
                        { key: p.id, style: { marginBottom: 6 } },
                        h('a', { href: p.url, target: '_blank', rel: 'noreferrer', style: { color: '#2563eb' } }, `@${p.handle}`),
                        ` — ${p.reason}`,
                      ),
                    ),
                  )
                : null,
            )
          : null,

        // ── 接入凭据 ──
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.cardTitle },
            '接入凭据',
            creds
              ? h('span', { style: S.badge(creds.clientIdSet && creds.clientSecretSet) }, creds.clientIdSet ? `Client ${creds.clientIdTail || '已设'}` : 'Client 未设')
              : null,
            creds ? h('span', { style: S.badge(creds.cookiesSet) }, creds.cookiesSet ? 'cookie 已设' : 'cookie 未设') : null,
            creds ? h('span', { style: S.badge(creds.canPost) }, creds.canPost ? `已授权 @${creds.actingAs || '?'}` : '未授权') : null,
          ),

          Tutorial(),

          h(
            'div',
            { style: { display: 'flex', gap: 12 } },
            h(
              'div',
              { style: { ...S.field, flex: 1 } },
              h('label', { style: S.label }, 'X Client ID'),
              h('input', {
                style: S.input,
                value: credForm.clientId,
                placeholder: creds?.clientIdSet ? '已设置，留空则不修改' : '粘贴 OAuth 2.0 Client ID',
                onChange: (e) => setCredForm({ ...credForm, clientId: e.target.value }),
              }),
            ),
            h(
              'div',
              { style: { ...S.field, flex: 1 } },
              h('label', { style: S.label }, 'X Client Secret'),
              h('input', {
                style: S.input,
                type: 'password',
                value: credForm.clientSecret,
                placeholder: creds?.clientSecretSet ? '已设置，留空则不修改' : '粘贴 Client Secret',
                onChange: (e) => setCredForm({ ...credForm, clientSecret: e.target.value }),
              }),
            ),
          ),

          h(
            'div',
            { style: { display: 'flex', gap: 12 } },
            h(
              'div',
              { style: { ...S.field, flex: 1 } },
              h('label', { style: S.label }, 'cookie · auth_token'),
              h('input', {
                style: S.input,
                value: credForm.authToken,
                placeholder: creds?.cookiesSet ? '已设置，留空则不修改' : '40 位十六进制',
                onChange: (e) => setCredForm({ ...credForm, authToken: e.target.value }),
              }),
            ),
            h(
              'div',
              { style: { ...S.field, flex: 1 } },
              h('label', { style: S.label }, 'cookie · ct0'),
              h('input', {
                style: S.input,
                value: credForm.ct0,
                placeholder: creds?.cookiesSet ? '已设置，留空则不修改' : '一长串十六进制',
                onChange: (e) => setCredForm({ ...credForm, ct0: e.target.value }),
              }),
            ),
          ),

          h(
            'div',
            { style: S.row },
            h('button', { style: { ...S.btn, ...S.btnPrimary }, onClick: saveCreds, disabled: busy }, '保存凭据'),
            h('button', { style: S.btn, onClick: startAuth, disabled: busy }, '生成授权链接'),
          ),

          authUrl
            ? h(
                'div',
                { style: { marginBottom: 14 } },
                h('div', { style: S.label }, '用【小号】登录的浏览器打开这个链接，点 Authorize：'),
                h('a', { href: authUrl, target: '_blank', rel: 'noreferrer', style: { ...S.code, color: '#2563eb', display: 'block' } }, authUrl),
                h('div', { style: { ...S.hint, marginTop: 6 } }, `回调地址：${creds?.redirectUri ?? ''}（跳转失败是正常的）`),
              )
            : null,

          h(
            'div',
            { style: { display: 'flex', gap: 10, alignItems: 'flex-end' } },
            h(
              'div',
              { style: { ...S.field, flex: 1, marginBottom: 0 } },
              h('label', { style: S.label }, '授权码（跳转地址里 code= 后面那串）'),
              h('input', {
                style: S.input,
                value: authCode,
                placeholder: '粘到这里',
                onChange: (e) => setAuthCode(e.target.value),
              }),
            ),
            h('button', { style: { ...S.btn, marginBottom: 14 }, onClick: finishAuth, disabled: busy || !authCode.trim() }, '提交授权'),
          ),
        ),

        // ── 刷过的推文 ──
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.cardTitle },
            '刷过的推文',
            history
              ? Object.entries(history.counts ?? {}).map(([k, v]) =>
                  h('span', { key: k, style: S.badge(k !== 'sensitive' && k !== 'failed') }, `${ACTION_LABEL[k]?.label ?? k} ${v}`),
                )
              : null,
            h('button', { style: { ...S.btn, marginLeft: 'auto' }, onClick: load, disabled: busy }, '刷新'),
          ),
          !history || !history.items?.length
            ? h('div', { style: S.hint }, '还没有记录。跑一轮之后这里会出现挑中的和被过滤掉的推文。')
            : h(
                'ul',
                { style: { margin: 0, padding: 0, listStyle: 'none', maxHeight: 320, overflowY: 'auto' } },
                history.items.map((item) => {
                  const meta = ACTION_LABEL[item.action] ?? { label: item.action, color: '#6b7280' };
                  const mins = Math.round((Date.now() - item.at) / 60000);
                  const ago = mins < 60 ? `${mins} 分钟前` : mins < 1440 ? `${Math.round(mins / 60)} 小时前` : `${Math.round(mins / 1440)} 天前`;
                  return h(
                    'li',
                    { key: `${item.id}-${item.action}`, style: { padding: '8px 0', borderBottom: '1px solid var(--dsh-border, #f3f4f6)' } },
                    h(
                      'div',
                      { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, marginBottom: 3 } },
                      h('span', { style: { color: meta.color, fontWeight: 600 } }, `[${meta.label}]`),
                      h('a', { href: item.url, target: '_blank', rel: 'noreferrer', style: { color: '#2563eb' } }, `@${item.handle}`),
                      h('span', { style: S.hint }, ago),
                    ),
                    h('div', { style: { fontSize: 13 } }, item.reason || item.text || '(无说明)'),
                  );
                }),
              ),
        ),

        // ── 说话风格（提示词）──
        h(
          'div',
          { style: S.card },
          h('div', { style: S.cardTitle }, '说话风格（别人 @ 它时怎么回）'),
          h(
            'div',
            { style: { ...S.hint, marginBottom: 8 } },
            '这里是提示词，改完下一轮生效，不用重启。想更简短、更专业、更贫嘴，都直接改这段文字。',
          ),
          h('textarea', {
            style: { ...S.input, minHeight: 160, fontFamily: 'inherit', lineHeight: 1.6, resize: 'vertical' },
            value: prompt,
            placeholder: '加载中…（如果一直空着，说明服务没连上）',
            onChange: (e) => setPrompt(e.target.value),
          }),
          h(
            'div',
            { style: { ...S.row, marginTop: 10, marginBottom: 0 } },
            h('button', { style: { ...S.btn, ...S.btnPrimary }, onClick: savePrompt, disabled: busy || !prompt.trim() }, '保存提示词'),
            prompt.length ? h('span', { style: S.hint }, `${prompt.length} 字`) : null,
          ),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots;
        if (!slots) return;
        slots.inject('settings.section', () =>
          slots.register(
            { name: 'settings.section', id: 'x-digest', order: 31, label: 'X 速览' },
            () => h(Panel),
          ),
        );
      },
    };
  },
});
