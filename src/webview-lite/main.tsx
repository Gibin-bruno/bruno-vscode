/**
 * PROTOTYPE (lite request page): the form.
 *
 * It holds no application state of its own. The host sends the request and some meta; every edit is
 * an op that is applied here straight away (so typing never waits) and sent to the host, which owns
 * the document. Only the selected tab is remembered locally.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  applyOp, getAt, isTextBodyMode,
  type FormMessage, type FormMeta, type HostMessage, type KeyValueRow, type Op, type PartId, type Path, type RequestItem
} from '../extension/lite/model';
import './styles.css';

declare function acquireVsCodeApi(): {
  postMessage(message: FormMessage): void;
  getState(): { tab?: string } | undefined;
  setState(state: { tab?: string }): void;
};

const vscode = acquireVsCodeApi();
const send = (message: FormMessage): void => vscode.postMessage(message);

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'TRACE', 'CONNECT'];
const BODY_MODES: Array<[string, string]> = [
  ['none', 'No body'], ['json', 'JSON'], ['text', 'Text'], ['xml', 'XML'], ['sparql', 'SPARQL'],
  ['formUrlEncoded', 'Form URL encoded'], ['multipartForm', 'Multipart form']
];
const AUTH_MODES: Array<[string, string]> = [
  ['inherit', 'Inherit'], ['none', 'No auth'], ['basic', 'Basic'], ['bearer', 'Bearer token'], ['apikey', 'API key'],
  ['digest', 'Digest'], ['ntlm', 'NTLM'], ['awsv4', 'AWS Sig v4'], ['oauth2', 'OAuth 2.0'], ['wsse', 'WSSE']
];
const AUTH_FIELDS: Record<string, Array<[field: string, label: string]>> = {
  basic: [['username', 'Username'], ['password', 'Password']],
  bearer: [['token', 'Token']],
  apikey: [['key', 'Key'], ['value', 'Value']]
};

type Dispatch = (op: Op) => void;

interface Indexed { row: KeyValueRow; index: number }

function Row({ entry, list, isNew, extra, dispatch, labels }: {
  entry: Indexed; list: Path; isNew: boolean; extra?: Partial<KeyValueRow>; dispatch: Dispatch; labels: [string, string];
}) {
  const { row, index } = entry;
  const edit = (field: string, value: unknown): void =>
    dispatch(isNew ? { t: 'rowAdd', list, row: { ...extra, [field]: value } } : { t: 'rowSet', list, index, field, value });
  const subject = row.name || `row ${index + 1}`;

  return (
    <tr className={row.enabled ? undefined : 'disabled'}>
      <td className="check">
        <input type="checkbox" checked={!!row.enabled} disabled={isNew} aria-label={`Enable ${subject}`}
          onChange={(e) => edit('enabled', e.target.checked)} />
      </td>
      <td>
        <input type="text" value={row.name ?? ''} placeholder={isNew ? labels[0] : ''} spellCheck={false}
          aria-label={`${labels[0]}, ${subject}`} onChange={(e) => edit('name', e.target.value)} />
      </td>
      <td>
        <input type="text" value={String(row.value ?? '')} placeholder={isNew ? labels[1] : ''} spellCheck={false}
          aria-label={`${labels[1]}, ${subject}`} onChange={(e) => edit('value', e.target.value)} />
      </td>
      <td className="actions">
        <button type="button" className="icon" disabled={isNew} aria-label={`Delete ${subject}`} title="Delete"
          onClick={() => dispatch({ t: 'rowDel', list, index })}>×</button>
      </td>
    </tr>
  );
}

/**
 * A key/value table. The last row is always an empty one: typing in it adds the row. It keeps the
 * key the new row will get, so the input being typed in stays the same element and keeps focus.
 */
function KeyValueTable({ item, list, filter, extra, canAdd = true, dispatch, caption, labels = ['Name', 'Value'] }: {
  item: RequestItem; list: Path; filter?: (row: KeyValueRow) => boolean; extra?: Partial<KeyValueRow>;
  canAdd?: boolean; dispatch: Dispatch; caption: string; labels?: [string, string];
}) {
  const all = (getAt(item, list) as KeyValueRow[] | undefined) || [];
  const rows: Indexed[] = all.map((row, index) => ({ row, index })).filter(({ row }) => !filter || filter(row));
  const blank: Indexed = { row: { name: '', value: '', enabled: true }, index: all.length };

  return (
    <table>
      <caption>{caption}</caption>
      <thead>
        <tr><th className="check"><span className="sr-only">Enabled</span></th><th>{labels[0]}</th><th>{labels[1]}</th><th className="actions" /></tr>
      </thead>
      <tbody>
        {rows.map((entry) => <Row key={entry.index} entry={entry} list={list} isNew={false} dispatch={dispatch} labels={labels} />)}
        {canAdd && <Row key={blank.index} entry={blank} list={list} isNew extra={extra} dispatch={dispatch} labels={labels} />}
      </tbody>
    </table>
  );
}

/** A block of code: edited on the page, or shown read-only with a button that opens it in a VS Code editor. */
function CodeField({ label, value, part, inline, onChange, actions }: {
  label: string; value: string; part: PartId; inline: boolean; onChange: (value: string) => void; actions?: ReactNode;
}) {
  const lines = value ? value.split('\n').length : 0;
  return (
    <section className="code-field">
      <div className="code-head">
        <h3>{label}</h3>
        <span className="muted">{lines ? `${lines} line${lines === 1 ? '' : 's'}` : 'Empty'}</span>
        <span className="spacer" />
        {actions}
        <button type="button" onClick={() => send({ type: 'cmd', id: 'openPart', part })}>Open in editor</button>
      </div>
      {inline
        ? <textarea aria-label={label} value={value} spellCheck={false} rows={Math.min(24, Math.max(6, lines + 1))}
            onChange={(e) => onChange(e.target.value)} />
        : <pre className="code-preview" aria-label={`${label}, read only`} tabIndex={0}>{value || 'Nothing here yet. Open it in an editor to add some.'}</pre>}
    </section>
  );
}

function Tabs({ tabs, active, onSelect }: { tabs: Array<[id: string, label: string]>; active: string; onSelect: (id: string) => void }) {
  const onKeyDown = (e: KeyboardEvent): void => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    const at = tabs.findIndex(([id]) => id === active);
    const next = tabs[(at + step + tabs.length) % tabs.length][0];
    onSelect(next);
    document.getElementById(`tab-${next}`)?.focus();
  };
  return (
    <div role="tablist" aria-label="Request sections" className="tabs" onKeyDown={onKeyDown}>
      {tabs.map(([id, label]) => (
        <button key={id} id={`tab-${id}`} type="button" role="tab" aria-selected={id === active} aria-controls="tabpanel"
          tabIndex={id === active ? 0 : -1} onClick={() => onSelect(id)}>{label}</button>
      ))}
    </div>
  );
}

function App() {
  const [item, setItem] = useState<RequestItem | null>(null);
  const [meta, setMeta] = useState<FormMeta | null>(null);
  const [tab, setTab] = useState<string>(vscode.getState()?.tab || 'params');
  const itemRef = useRef<RequestItem | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostMessage>): void => {
      if (event.data.type === 'model') {
        itemRef.current = event.data.item;
        setItem(event.data.item);
      } else if (event.data.type === 'meta') {
        setMeta(event.data.meta);
      }
    };
    window.addEventListener('message', onMessage);
    send({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const dispatch: Dispatch = (op) => {
    if (!itemRef.current) return;
    const next = structuredClone(itemRef.current);
    applyOp(next, op);
    itemRef.current = next;
    setItem(next);
    send({ type: 'op', op });
  };

  const selectTab = (id: string): void => {
    setTab(id);
    vscode.setState({ tab: id });
  };

  if (!meta) return <p className="muted pad">Loading…</p>;

  if (!item || item.type !== 'http-request') {
    return (
      <div className="pad">
        <p role="alert">{meta.error || 'The lite editor handles HTTP requests only for now.'}</p>
        <div className="row">
          <button type="button" onClick={() => send({ type: 'cmd', id: 'openClassic' })}>Open in classic editor</button>
          <button type="button" onClick={() => send({ type: 'cmd', id: 'openText' })}>Open as text</button>
        </div>
      </div>
    );
  }

  const { request } = item;
  const inline = meta.codeEditing === 'inline';
  const set = (path: Path) => (value: unknown): void => dispatch({ t: 'set', path, value });
  const count = (rows?: KeyValueRow[]): string => {
    const enabled = (rows || []).filter((r) => r.enabled).length;
    return enabled ? ` (${enabled})` : '';
  };
  const bodyMode = request.body?.mode || 'none';
  const authMode = request.auth?.mode || 'none';

  const setBodyMode = (mode: string): void => {
    dispatch({ t: 'set', path: ['request', 'body', 'mode'], value: mode });
    if (mode !== 'none' && request.body?.[mode] === undefined) {
      dispatch({ t: 'set', path: ['request', 'body', mode], value: isTextBodyMode(mode) ? '' : [] });
    }
  };
  const setAuthMode = (mode: string): void => {
    dispatch({ t: 'set', path: ['request', 'auth', 'mode'], value: mode });
    if (AUTH_FIELDS[mode] && request.auth?.[mode] === undefined) {
      const empty = Object.fromEntries(AUTH_FIELDS[mode].map(([field]) => [field, '']));
      dispatch({ t: 'set', path: ['request', 'auth', mode], value: mode === 'apikey' ? { ...empty, placement: 'header' } : empty });
    }
  };

  const tabs: Array<[string, string]> = [
    ['params', `Params${count(request.params)}`],
    ['headers', `Headers${count(request.headers)}`],
    ['body', `Body${bodyMode === 'none' ? '' : ' •'}`],
    ['auth', `Auth${authMode === 'none' || authMode === 'inherit' ? '' : ' •'}`],
    ['vars', `Vars${count([...(request.vars?.req || []), ...(request.vars?.res || [])])}`],
    ['script', `Script${request.script?.req || request.script?.res ? ' •' : ''}`],
    ['assert', `Assert${count(request.assertions)}`],
    ['tests', `Tests${request.tests ? ' •' : ''}`],
    ['docs', `Docs${request.docs ? ' •' : ''}`]
  ];

  return (
    <main>
      {meta.error && <p role="alert" className="banner">This file has changed and can no longer be read as a request: {meta.error}</p>}

      <form className="url-bar" onSubmit={(e) => { e.preventDefault(); send({ type: 'cmd', id: meta.sending ? 'cancel' : 'send' }); }}>
        <select aria-label="HTTP method" value={String(request.method || 'GET').toUpperCase()} onChange={(e) => set(['request', 'method'])(e.target.value)}>
          {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <input type="text" className="url" aria-label="Request URL" placeholder="https://api.example.com/users" spellCheck={false}
          value={request.url || ''} onChange={(e) => dispatch({ t: 'url', value: e.target.value })} />
        <button type="submit" className="primary">{meta.sending ? 'Cancel' : 'Send'}</button>
        <button type="button" className="pill" title="Select environment" onClick={() => send({ type: 'cmd', id: 'selectEnvironment' })}>
          {meta.environment || 'No environment'}
        </button>
      </form>

      {(meta.resolvedUrl !== null || meta.unresolved.length > 0) && (
        <div className="resolved" aria-live="polite">
          {meta.resolvedUrl !== null && <>
            <span className="muted">Sends to</span>
            <code title="The URL with variables and path params filled in. Secret values are hidden.">{meta.resolvedUrl}</code>
          </>}
          {meta.unresolved.length > 0 &&
            <span className="warn">Not defined{meta.environment ? ` in ${meta.environment}` : ''}: {meta.unresolved.map((name) => `{{${name}}}`).join(', ')}</span>}
        </div>
      )}

      <Tabs tabs={tabs} active={tab} onSelect={selectTab} />

      <div id="tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="panel">
        {tab === 'params' && <>
          <KeyValueTable item={item} list={['request', 'params']} filter={(r) => r.type !== 'path'} extra={{ type: 'query' }} dispatch={dispatch} caption="Query" />
          {request.params?.some((r) => r.type === 'path') &&
            <KeyValueTable item={item} list={['request', 'params']} filter={(r) => r.type === 'path'} canAdd={false} dispatch={dispatch} caption="Path (from :name segments in the URL)" />}
        </>}

        {tab === 'headers' && <KeyValueTable item={item} list={['request', 'headers']} dispatch={dispatch} caption="Headers" />}

        {tab === 'body' && <>
          <div className="row">
            <label htmlFor="body-mode">Body</label>
            <select id="body-mode" value={bodyMode} onChange={(e) => setBodyMode(e.target.value)}>
              {BODY_MODES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          {isTextBodyMode(bodyMode) && <CodeField label={`${bodyMode.toUpperCase()} body`} part="body" inline={inline}
            value={String(request.body?.[bodyMode] ?? '')} onChange={set(['request', 'body', bodyMode])}
            actions={(bodyMode === 'json' || bodyMode === 'xml') &&
              <button type="button" onClick={() => send({ type: 'cmd', id: 'prettify', part: 'body' })}>Prettify</button>} />}
          {(bodyMode === 'formUrlEncoded' || bodyMode === 'multipartForm') &&
            <KeyValueTable item={item} list={['request', 'body', bodyMode]} extra={bodyMode === 'multipartForm' ? { type: 'text' as never } : undefined}
              dispatch={dispatch} caption={bodyMode === 'multipartForm' ? 'Form fields (file fields: use the classic editor for now)' : 'Form fields'} />}
          {bodyMode === 'none' && <p className="muted">This request has no body.</p>}
        </>}

        {tab === 'auth' && <>
          <div className="row">
            <label htmlFor="auth-mode">Auth</label>
            <select id="auth-mode" value={authMode} onChange={(e) => setAuthMode(e.target.value)}>
              {AUTH_MODES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          {authMode === 'inherit' && <p className="muted">Uses the auth set on the parent folder or collection.</p>}
          {AUTH_FIELDS[authMode] && <div className="fields">
            {AUTH_FIELDS[authMode].map(([field, label]) => (
              <label key={field}>{label}
                <input type="text" spellCheck={false} value={String((request.auth?.[authMode] as Record<string, unknown>)?.[field] ?? '')}
                  onChange={(e) => set(['request', 'auth', authMode, field])(e.target.value)} />
              </label>
            ))}
            {authMode === 'apikey' && <label>Add to
              <select value={String((request.auth?.apikey as Record<string, unknown>)?.placement ?? 'header')}
                onChange={(e) => set(['request', 'auth', 'apikey', 'placement'])(e.target.value)}>
                <option value="header">Header</option>
                <option value="queryparams">Query params</option>
              </select>
            </label>}
          </div>}
          {!AUTH_FIELDS[authMode] && authMode !== 'inherit' && authMode !== 'none' && <div>
            <p className="muted">The lite editor does not have a form for this auth type yet. Its saved settings are kept and used when you send.</p>
            <button type="button" onClick={() => send({ type: 'cmd', id: 'openClassic' })}>Edit in classic editor</button>
          </div>}
        </>}

        {tab === 'vars' && <>
          <KeyValueTable item={item} list={['request', 'vars', 'req']} extra={{ local: false }} dispatch={dispatch} caption="Pre-request variables" />
          <KeyValueTable item={item} list={['request', 'vars', 'res']} extra={{ local: false }} dispatch={dispatch} caption="Post-response variables" labels={['Name', 'Expression']} />
        </>}

        {tab === 'script' && <>
          <CodeField label="Pre-request script" part="pre-request" inline={inline} value={request.script?.req || ''} onChange={set(['request', 'script', 'req'])} />
          <CodeField label="Post-response script" part="post-response" inline={inline} value={request.script?.res || ''} onChange={set(['request', 'script', 'res'])} />
        </>}

        {tab === 'assert' && <KeyValueTable item={item} list={['request', 'assertions']} dispatch={dispatch} caption="Assertions" labels={['Expression', 'Operator and value']} />}

        {tab === 'tests' && <CodeField label="Tests" part="tests" inline={inline} value={request.tests || ''} onChange={set(['request', 'tests'])} />}

        {tab === 'docs' && <CodeField label="Docs" part="docs" inline={inline} value={request.docs || ''} onChange={set(['request', 'docs'])}
          actions={<button type="button" onClick={() => send({ type: 'cmd', id: 'previewDocs', part: 'docs' })}>Preview</button>} />}
      </div>

      <footer aria-live="polite">
        {meta.sending && <span>Sending…</span>}
        {!meta.sending && meta.lastResponse && <>
          <span className={meta.lastResponse.ok ? 'ok' : 'fail'}>{meta.lastResponse.summary}</span>
          <button type="button" className="link" onClick={() => send({ type: 'cmd', id: 'showResponse' })}>Show response</button>
        </>}
        {!meta.sending && !meta.lastResponse && <span className="muted">Not sent yet. Press Send, or Ctrl/Cmd+Enter.</span>}
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />);
