/**
 * PROTOTYPE (lite request page): native surfaces for a response.
 *
 *  - The body is a read-only document beside the request (pretty, raw or JSONPath-filtered). A
 *    CodeLens line at its top carries the status, so the document always says which response it is.
 *  - Details live in the "Bruno Response" panel as three focused views (Headers, Tests, Timeline)
 *    instead of one long tree. The lens line links to them; the panel is only opened on its own when
 *    a test fails or a script errors.
 *  - An HTML response opens rendered, in one shared preview panel that takes the place of the
 *    document; "Show source" switches that request back to the document.
 */
import * as vscode from 'vscode';
import xmlFormat from 'xml-formatter';
import { prettifyJsonString } from '../../utils/json';
import { liteStore, isSuccess, summarize, formatSize, type ResponseEntry, type SendResult, type TimelineEntry } from './stores';

// Required rather than imported: importing its types here changes how the classic webview's own
// use of the library type-checks.
const { JSONPath } = require('jsonpath-plus');

export const RESPONSE_SCHEME = 'bruno-response';
const PREVIEW_VIEW_TYPE = 'bruno.responsePreview';
const COMPANION_SCHEMES = new Set([RESPONSE_SCHEME, 'bruno-part']);

/** `preview` is the rendered page; the others are text in the response document. */
type View = { mode: 'pretty' | 'raw' | 'preview' } | { mode: 'filter'; expr: string };
type Kind = 'json' | 'xml' | 'html' | 'markdown' | 'text' | 'media' | 'binary';

const contentTypeOf = (result: SendResult): string => {
  const key = Object.keys(result.headers || {}).find((k) => k.toLowerCase() === 'content-type');
  return key ? String(result.headers![key]).toLowerCase() : '';
};

function kindOf(result: SendResult): Kind {
  const type = contentTypeOf(result);
  if (/^[\w-]+\/([\w-]+\+)?json/.test(type)) return 'json';
  if (type.includes('html')) return 'html';
  if (/^image\/svg/.test(type) || /^[\w-]+\/([\w-]+\+)?xml/.test(type)) return 'xml';
  if (type.includes('markdown')) return 'markdown';
  if (/^(image|audio|video)\//.test(type)) return 'media';
  if (/^application\/(pdf|octet-stream|zip)/.test(type)) return 'binary';
  // No usable content type: a parsed object can only have come from JSON.
  if (!type && result.data !== null && typeof result.data === 'object') return 'json';
  return 'text';
}

const LANGUAGE: Record<Kind, string> = {
  json: 'json', xml: 'xml', html: 'html', markdown: 'markdown', text: 'plaintext', media: 'plaintext', binary: 'plaintext'
};

function rawText(result: SendResult): string {
  if (result.dataBuffer) return Buffer.from(result.dataBuffer, 'base64').toString('utf8');
  if (typeof result.data === 'string') return result.data;
  return result.data === null || result.data === undefined ? '' : JSON.stringify(result.data);
}

/** The text shown for a response. Formatting works on the raw text, so large numbers keep every digit. */
function render(result: SendResult, view: View): string {
  if (!result.status) return result.error || result.statusText || 'The request failed.';

  const kind = kindOf(result);
  if (kind === 'media' || kind === 'binary') {
    return `Binary response (${contentTypeOf(result)}, ${formatSize(result.size)}).\n\nUse "Save Response" in the editor title bar to keep it`
      + (kind === 'media' ? ', or "Preview Response" to open it.' : '.');
  }

  const raw = rawText(result);
  if (view.mode === 'raw') return raw;

  if (view.mode === 'filter') {
    try {
      return JSON.stringify(JSONPath({ path: view.expr, json: JSON.parse(raw) }), null, 2);
    } catch (err) {
      return `Could not apply the filter "${view.expr}": ${(err as Error).message}`;
    }
  }

  if (kind === 'json') return prettifyJsonString(raw);
  if (kind === 'xml' || kind === 'html') {
    try {
      return xmlFormat(raw, { collapseContent: true });
    } catch {
      return raw;
    }
  }
  return raw;
}

function languageOf(result: SendResult, view: View): string {
  if (!result.status) return 'plaintext';
  return view.mode === 'filter' ? 'json' : LANGUAGE[kindOf(result)];
}

const statusIcon = (ok: boolean): vscode.ThemeIcon =>
  ok
    ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'))
    : new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));

function relativeTime(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

function headerRows(headers: Record<string, unknown> | undefined): vscode.TreeItem[] {
  return Object.entries(headers || {}).map(([name, value]) => {
    const row = new vscode.TreeItem(name);
    row.description = Array.isArray(value) ? value.join(', ') : String(value);
    row.tooltip = `${name}: ${row.description}`;
    return row;
  });
}

/** A small tree whose rows are rebuilt from the store whenever the response in focus changes. */
class ListTree implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly children = new Map<vscode.TreeItem, vscode.TreeItem[]>();
  private roots: vscode.TreeItem[] = [];

  set(roots: vscode.TreeItem[]): void {
    this.roots = roots;
    this.changed.fire();
  }

  /** Call before building rows for a new `set`. */
  reset(): void {
    this.children.clear();
  }

  branch(label: string, rows: vscode.TreeItem[], expanded = false): vscode.TreeItem {
    const node = new vscode.TreeItem(
      label,
      expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
    );
    this.children.set(node, rows);
    return node;
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    return element ? this.children.get(element) || [] : this.roots;
  }
}

function testCounts(entry: ResponseEntry): { passed: number; total: number; failed: number } {
  const passed = entry.tests.filter((t) => t.passed).length;
  return { passed, total: entry.tests.length, failed: entry.tests.length - passed + entry.scriptErrors.length };
}

/**
 * The editor column that already holds a response or a part of a request, whether or not that tab is
 * the one in front, so companions of the form share one column instead of each opening another.
 */
export function companionColumn(): vscode.ViewColumn {
  for (const group of vscode.window.tabGroups.all) {
    const holdsCompanion = group.tabs.some((tab) =>
      (tab.input instanceof vscode.TabInputText && COMPANION_SCHEMES.has(tab.input.uri.scheme))
      || (tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(PREVIEW_VIEW_TYPE)));
    if (holdsCompanion) return group.viewColumn;
  }
  return vscode.ViewColumn.Beside;
}

export interface ResponseViews {
  /** Opens (or refreshes) the response document and points the panel views at this request. */
  show(filePath: string): Promise<void>;
  /** Points the panel views at a request without opening anything. */
  follow(filePath: string | undefined): void;
}

export function registerResponseViews(context: vscode.ExtensionContext): ResponseViews {
  const views = new Map<string, View>(); // by request file path
  const contentChanged = new vscode.EventEmitter<vscode.Uri>();
  const lensChanged = new vscode.EventEmitter<void>();
  let followed: string | undefined;
  let previewPanel: vscode.WebviewPanel | undefined;
  let previewed: string | undefined; // the request whose response the preview panel shows

  const headers = new ListTree();
  const tests = new ListTree();
  const timeline = new ListTree();
  const headersView = vscode.window.createTreeView('bruno.response.headers', { treeDataProvider: headers });
  const testsView = vscode.window.createTreeView('bruno.response.tests', { treeDataProvider: tests });
  const timelineView = vscode.window.createTreeView('bruno.response.timeline', { treeDataProvider: timeline });

  /** HTML opens rendered unless another view was chosen for the request; nothing else can be previewed here. */
  const viewOf = (entry: ResponseEntry): View => {
    const previewable = !!entry.result.status && kindOf(entry.result) === 'html';
    const chosen = views.get(entry.filePath);
    if (!chosen) return { mode: previewable ? 'preview' : 'pretty' };
    return chosen.mode === 'preview' && !previewable ? { mode: 'pretty' } : chosen;
  };

  /**
   * One document per request and view. The path carries no extension on purpose: the language is set
   * explicitly, so a response of a different type updates the same tab instead of opening another
   * while the old one stays on screen.
   */
  const uriFor = (entry: ResponseEntry): vscode.Uri => {
    const mode = viewOf(entry).mode;
    const suffix = mode === 'raw' ? 'response, raw' : mode === 'filter' ? 'response, filtered' : 'response';
    return vscode.Uri.from({
      scheme: RESPONSE_SCHEME,
      path: `/${entry.name.replace(/[\\/]/g, '-')} (${suffix})`,
      query: encodeURIComponent(entry.filePath)
    });
  };

  const fileOf = (uri: vscode.Uri | undefined): string | undefined =>
    uri?.scheme === RESPONSE_SCHEME ? decodeURIComponent(uri.query) : undefined;

  /** The request a response command applies to: the response document in front, else the one followed. */
  const targetEntry = (uri?: vscode.Uri): ResponseEntry | undefined => {
    const filePath = fileOf(uri)
      || (previewPanel?.active ? previewed : undefined)
      || fileOf(vscode.window.activeTextEditor?.document.uri)
      || followed;
    return filePath ? liteStore.getResponse(filePath) : undefined;
  };

  const refreshPanel = (): void => {
    const entry = followed ? liteStore.getResponse(followed) : undefined;
    headers.reset();
    tests.reset();
    timeline.reset();

    if (!entry) {
      const hint = 'Send a request to see its response here.';
      headersView.message = testsView.message = timelineView.message = hint;
      headersView.description = testsView.description = timelineView.description = undefined;
      testsView.badge = undefined;
      headers.set([]);
      tests.set([]);
      timeline.set([]);
      return;
    }

    const { result } = entry;

    // Headers: what came back, with what was sent folded away underneath.
    const sent = result.requestSent;
    const requestLine = new vscode.TreeItem(`${String(sent?.method || '').toUpperCase()} ${sent?.url || result.requestUrl || ''}`.trim());
    requestLine.iconPath = new vscode.ThemeIcon('arrow-right');
    const sentHeaders = headerRows(sent?.headers);
    headersView.message = undefined;
    headersView.description = `${entry.name} · ${summarize(result)}`;
    headers.set([
      ...headerRows(result.headers),
      headers.branch(`Request sent (${sentHeaders.length} headers)`, [requestLine, ...sentHeaders])
    ]);

    // Tests: script errors first, then every test and assertion.
    const counts = testCounts(entry);
    const errorRows = entry.scriptErrors.map((message) => {
      const row = new vscode.TreeItem(message);
      row.iconPath = statusIcon(false);
      row.tooltip = message;
      return row;
    });
    const testRows = entry.tests.map((test) => {
      const row = new vscode.TreeItem(test.description || '(unnamed)');
      row.iconPath = statusIcon(test.passed);
      row.description = test.passed ? test.kind : `${test.kind} · ${test.error || 'failed'}`;
      row.tooltip = test.error;
      return row;
    });
    testsView.message = errorRows.length || testRows.length ? undefined : 'No tests or assertions ran for this request.';
    testsView.description = counts.total ? `${counts.passed}/${counts.total} passed` : undefined;
    testsView.badge = counts.failed ? { value: counts.failed, tooltip: `${counts.failed} failed` } : undefined;
    tests.set([...errorRows, ...testRows]);

    // Timeline: every call made for this request, newest first.
    const calls = liteStore.timelineFor(entry.collectionPath, entry.filePath);
    timelineView.message = calls.length ? undefined : 'No calls recorded for this request.';
    timelineView.description = calls.length ? `${calls.length} call${calls.length === 1 ? '' : 's'}` : undefined;
    timeline.set(calls.map((call: TimelineEntry) => {
      const node = timeline.branch(call.status ? `${call.status} ${call.statusText || ''}`.trim() : 'Error', [
        new vscode.TreeItem(`${call.method} ${call.url}`.trim()),
        timeline.branch(`Request headers (${Object.keys(call.requestHeaders).length})`, headerRows(call.requestHeaders)),
        timeline.branch(`Response headers (${Object.keys(call.responseHeaders).length})`, headerRows(call.responseHeaders))
      ]);
      node.description = [
        relativeTime(call.at),
        call.status ? `${call.duration ?? 0} ms · ${formatSize(call.size)}` : call.error
      ].filter(Boolean).join(' · ');
      node.iconPath = statusIcon(!!call.status && call.status < 400);
      node.tooltip = new Date(call.at).toLocaleString();
      return node;
    }));
  };

  const follow = (filePath: string | undefined): void => {
    followed = filePath;
    refreshPanel();
  };

  /** Renders an HTML response in the shared preview panel, in place of the request's response document. */
  const showPreview = async (entry: ResponseEntry): Promise<void> => {
    if (!previewPanel) {
      previewPanel = vscode.window.createWebviewPanel(
        PREVIEW_VIEW_TYPE,
        'Response',
        { viewColumn: companionColumn(), preserveFocus: true },
        { enableScripts: false, enableCommandUris: PREVIEW_COMMANDS }
      );
      previewPanel.onDidDispose(() => {
        previewPanel = undefined;
        previewed = undefined;
      }, null, context.subscriptions);
    }
    previewed = entry.filePath;
    previewPanel.title = `${entry.name} (response)`;
    previewPanel.webview.html = previewHtml(
      entry,
      testCounts(entry),
      liteStore.timelineFor(entry.collectionPath, entry.filePath).length
    );
    previewPanel.reveal(undefined, true);

    const documents = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.input instanceof vscode.TabInputText && fileOf(tab.input.uri) === entry.filePath);
    if (documents.length) await vscode.window.tabGroups.close(documents, true);
  };

  const showDocument = async (entry: ResponseEntry, view: View): Promise<void> => {
    const uri = uriFor(entry);
    contentChanged.fire(uri);

    let document = await vscode.workspace.openTextDocument(uri);
    const language = languageOf(entry.result, view);
    if (document.languageId !== language) {
      document = await vscode.languages.setTextDocumentLanguage(document, language);
    }
    await vscode.window.showTextDocument(document, { viewColumn: companionColumn(), preserveFocus: true, preview: true });

    // The document must never be left showing an earlier response: ask again if it still differs.
    if (document.getText() !== render(entry.result, view)) contentChanged.fire(uri);

    // A preview of this request's earlier response would now be out of date.
    if (previewed === entry.filePath) previewPanel?.dispose();
  };

  const show = async (filePath: string): Promise<void> => {
    const entry = liteStore.getResponse(filePath);
    follow(filePath);
    if (!entry) return;

    const view = viewOf(entry);
    lensChanged.fire();
    if (view.mode === 'preview') await showPreview(entry);
    else await showDocument(entry, view);

    if (testCounts(entry).failed) void vscode.commands.executeCommand('bruno.response.tests.focus', { preserveFocus: true });
  };

  const setView = async (uri: vscode.Uri | undefined, view: View): Promise<void> => {
    const entry = targetEntry(uri);
    if (!entry) return;
    views.set(entry.filePath, view);
    await show(entry.filePath);
  };

  /** Writes the response bytes where VS Code's own viewers can open them. */
  const saveForPreview = async (entry: ResponseEntry): Promise<vscode.Uri> => {
    const dir = vscode.Uri.joinPath(context.globalStorageUri, 'response-previews');
    await vscode.workspace.fs.createDirectory(dir);
    const subtype = (contentTypeOf(entry.result).split(';')[0].split('/')[1] || 'bin').replace(/[^a-z0-9]/g, '') || 'bin';
    const file = vscode.Uri.joinPath(dir, `response-${Date.now()}.${subtype}`);
    await vscode.workspace.fs.writeFile(file, Buffer.from(entry.result.dataBuffer || '', 'base64'));
    return file;
  };

  const preview = async (uri?: vscode.Uri): Promise<void> => {
    const entry = targetEntry(uri);
    if (!entry) return;
    const kind = kindOf(entry.result);

    if (kind === 'markdown') {
      await vscode.commands.executeCommand('markdown.showPreviewToSide', uriFor(entry));
      return;
    }
    if (kind === 'media') {
      await vscode.commands.executeCommand('vscode.open', await saveForPreview(entry), { preview: true });
      return;
    }
    if (kind !== 'html' || !entry.result.status) {
      void vscode.window.showInformationMessage('Preview is available for HTML, Markdown, image, audio and video responses.');
      return;
    }
    await setView(uri, { mode: 'preview' });
  };

  const lenses: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: lensChanged.event,
    provideCodeLenses(document) {
      const filePath = fileOf(document.uri);
      const entry = filePath ? liteStore.getResponse(filePath) : undefined;
      if (!entry) return [];

      const range = new vscode.Range(0, 0, 0, 0);
      const lens = (title: string, command = '', tooltip?: string): vscode.CodeLens =>
        new vscode.CodeLens(range, { title, command, tooltip });
      const counts = testCounts(entry);
      const view = viewOf(entry);
      const calls = liteStore.timelineFor(entry.collectionPath, entry.filePath).length;

      const line = [
        lens(`${isSuccess(entry.result) ? '$(pass)' : '$(error)'} ${summarize(entry.result)}`),
        lens(`Headers (${Object.keys(entry.result.headers || {}).length})`, 'bruno.response.headers.focus', 'Show response and request headers'),
        lens(`Timeline (${calls})`, 'bruno.response.timeline.focus', 'Show earlier calls of this request')
      ];
      if (counts.total || counts.failed) {
        line.splice(1, 0, lens(
          `${counts.failed ? '$(error)' : '$(pass)'} Tests ${counts.passed}/${counts.total}`,
          'bruno.response.tests.focus',
          'Show test and assertion results'
        ));
      }
      if (view.mode === 'raw') line.push(lens('Raw (click for pretty)', 'bruno.lite.response.toggleRaw'));
      if (view.mode === 'filter') line.push(lens(`Filtered: ${view.expr}`, 'bruno.lite.response.filter', 'Change or clear the filter'));
      if (entry.result.status && kindOf(entry.result) === 'html') line.push(lens('Preview', 'bruno.lite.response.preview', 'Show the rendered page'));
      return line;
    }
  };

  refreshPanel();

  context.subscriptions.push(
    contentChanged,
    lensChanged,
    headersView,
    testsView,
    timelineView,
    vscode.workspace.registerTextDocumentContentProvider(RESPONSE_SCHEME, {
      onDidChange: contentChanged.event,
      provideTextDocumentContent: (uri) => {
        const filePath = fileOf(uri);
        const entry = filePath ? liteStore.getResponse(filePath) : undefined;
        return entry ? render(entry.result, viewOf(entry)) : '';
      }
    }),
    vscode.languages.registerCodeLensProvider({ scheme: RESPONSE_SCHEME }, lenses),
    liteStore.onDidChange((filePath) => {
      if (followed === filePath) refreshPanel();
      lensChanged.fire();
    }),
    timelineView.onDidChangeVisibility((e) => {
      // Relative times are computed on render; refresh them when the view comes back.
      if (e.visible) refreshPanel();
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      const filePath = fileOf(editor?.document.uri);
      if (filePath && filePath !== followed) follow(filePath);
    }),
    vscode.commands.registerCommand('bruno.lite.showResponse', (filePath?: string) => {
      const target = filePath || followed;
      return target ? show(target) : undefined;
    }),
    vscode.commands.registerCommand('bruno.lite.response.toggleRaw', (uri?: vscode.Uri) => {
      const entry = targetEntry(uri);
      if (!entry) return;
      return setView(uri, { mode: viewOf(entry).mode === 'raw' ? 'pretty' : 'raw' });
    }),
    vscode.commands.registerCommand('bruno.lite.response.filter', async (uri?: vscode.Uri) => {
      const entry = targetEntry(uri);
      if (!entry) return;
      const current = viewOf(entry);
      const expr = await vscode.window.showInputBox({
        title: 'Filter response',
        prompt: 'JSONPath expression. Leave empty to clear the filter.',
        placeHolder: '$.items[*].name',
        value: current.mode === 'filter' ? current.expr : ''
      });
      if (expr === undefined) return;
      return setView(uri, expr.trim() ? { mode: 'filter', expr: expr.trim() } : { mode: 'pretty' });
    }),
    vscode.commands.registerCommand('bruno.lite.response.preview', preview),
    vscode.commands.registerCommand('bruno.lite.response.showSource', (uri?: vscode.Uri) => setView(uri, { mode: 'pretty' })),
    { dispose: () => previewPanel?.dispose() },
    vscode.commands.registerCommand('bruno.lite.response.save', async (uri?: vscode.Uri) => {
      const entry = targetEntry(uri);
      if (!entry) return;
      const target = await vscode.window.showSaveDialog({ title: 'Save response' });
      if (target) await vscode.workspace.fs.writeFile(target, Buffer.from(entry.result.dataBuffer || '', 'base64'));
    }),
    vscode.commands.registerCommand('bruno.lite.clearTimeline', () => {
      const entry = targetEntry();
      if (entry) liteStore.clearTimeline(entry.collectionPath, entry.filePath);
    })
  );

  return { show, follow };
}

const escapeAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Commands the preview's status line may run; nothing else is reachable from the panel. */
const PREVIEW_COMMANDS = [
  'bruno.response.headers.focus',
  'bruno.response.tests.focus',
  'bruno.response.timeline.focus',
  'bruno.lite.response.showSource'
];

/**
 * A status line (the same one the response document carries) above a frame holding the response
 * as-is. Scripts stay off; relative assets resolve against the request URL.
 */
function previewHtml(entry: ResponseEntry, tests: { passed: number; total: number; failed: number }, calls: number): string {
  const { result } = entry;
  const baseUrl = result.requestUrl || result.requestSent?.url || '';
  const page = baseUrl ? `<base href="${escapeAttribute(baseUrl)}">${rawText(result)}` : rawText(result);
  const link = (label: string, command: string): string => `<a href="command:${command}">${escapeAttribute(label)}</a>`;

  const status = [
    `<span class="${isSuccess(result) ? 'ok' : 'bad'}">${escapeAttribute(summarize(result))}</span>`,
    tests.total || tests.failed ? link(`Tests ${tests.passed}/${tests.total}`, 'bruno.response.tests.focus') : '',
    link(`Headers (${Object.keys(result.headers || {}).length})`, 'bruno.response.headers.focus'),
    link(`Timeline (${calls})`, 'bruno.response.timeline.focus'),
    link('Show source', 'bruno.lite.response.showSource')
  ].filter(Boolean).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data:; style-src https: http: 'unsafe-inline'; font-src https: http: data:; frame-src 'self' about: data:;">
  <style>
    html, body { height: 100%; margin: 0; padding: 0; }
    body { display: flex; flex-direction: column; }
    .status { display: flex; flex-wrap: wrap; gap: 4px 16px; padding: 6px 12px; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
    .status a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    .status a:hover, .status a:focus-visible { text-decoration: underline; }
    .ok { color: var(--vscode-testing-iconPassed); }
    .bad { color: var(--vscode-testing-iconFailed); }
    iframe { flex: 1; width: 100%; border: 0; background: #fff; }
  </style>
</head>
<body>
  <nav class="status" aria-label="Response">${status}</nav>
  <iframe title="Rendered response" sandbox srcdoc="${escapeAttribute(page)}"></iframe>
</body>
</html>`;
}
