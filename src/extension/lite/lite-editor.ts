/**
 * PROTOTYPE (lite request page): the request editor as a native shell around one small webview.
 *
 * The webview is only the form. The tab, dirty state, save and undo are VS Code's (the document is
 * the source of truth); sending, the environment, the response and code editing are native surfaces.
 * Nothing is retained while the tab is hidden: the form re-renders from the host model on return.
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { basename } from '../utils/file';
import { getSession, peekSession, type RequestSession } from './session';
import { registerParts, prettifyBody, PART_SCHEME, type Parts } from './parts-fs';
import { registerResponseViews, RESPONSE_SCHEME, type ResponseViews } from './response-views';
import { registerScriptCompletions } from './script-completions';
import {
  sendRequest, cancelSend, isSending, onDidChangeSending, resolveUrl,
  listEnvironments, getSelectedEnvironment, setSelectedEnvironment, type ResolvedUrl
} from './send';
import { liteStore, isSuccess, summarize } from './stores';
import { getAt, partPath, type FormMessage, type FormMeta, type HostMessage } from './model';

export const LITE_VIEW_TYPE = 'bruno.requestEditor.lite';
const CLASSIC_VIEW_TYPE = 'bruno.requestEditor';
const RESOLVE_DELAY_MS = 250;

/** Opt-in for the prototype: the "Native Components" launch config, or the `bruno.request.editor` setting. */
export const isLiteMode = (): boolean =>
  process.env.NATIVE_COMPONENTS === 'true'
  || vscode.workspace.getConfiguration('bruno').get<string>('request.editor') === 'lite';

/** The editor a request opens in when clicked in the sidebar. Only HTTP requests have a lite form so far. */
export const requestEditorFor = (requestType?: string): string =>
  isLiteMode() && (!requestType || requestType.toUpperCase() === 'HTTP') ? LITE_VIEW_TYPE : CLASSIC_VIEW_TYPE;

const codeEditing = (): 'inline' | 'editor' =>
  vscode.workspace.getConfiguration('bruno').get<string>('request.codeEditing') === 'inline' ? 'inline' : 'editor';

export function registerLiteRequestPage(context: vscode.ExtensionContext): void {
  const parts: Parts = registerParts(context);
  const responses: ResponseViews = registerResponseViews(context);
  registerScriptCompletions(context, PART_SCHEME);

  /** Fires with the collection path whose selected environment changed. */
  const environmentChanged = new vscode.EventEmitter<string>();

  /** The request whose lite editor was last in front; commands and the status bar act on it. */
  let activeFile: string | undefined;
  const panels = new Map<string, vscode.WebviewPanel>();

  const environmentItem = vscode.window.createStatusBarItem('bruno.environment', vscode.StatusBarAlignment.Left, 98);
  environmentItem.name = 'Bruno Environment';
  environmentItem.command = 'bruno.lite.selectEnvironment';

  const updateStatusBar = (): void => {
    const scheme = vscode.window.activeTextEditor?.document.uri.scheme;
    const inFront = (activeFile && panels.get(activeFile)?.active) || scheme === PART_SCHEME || scheme === RESPONSE_SCHEME;
    const collection = activeFile ? peekSession(activeFile)?.collection : undefined;
    if (!inFront || !collection) {
      environmentItem.hide();
      return;
    }
    const name = getSelectedEnvironment(collection);
    environmentItem.text = `$(server-environment) ${name || 'No Environment'}`;
    environmentItem.tooltip = `Bruno environment for ${basename(collection.uri)}. Click to change.`;
    environmentItem.accessibilityInformation = { label: `Bruno environment: ${name || 'none'}`, role: 'button' };
    environmentItem.show();
  };

  const activeSession = async (uri?: vscode.Uri): Promise<RequestSession | undefined> => {
    const filePath = uri?.scheme === 'file' ? uri.fsPath : activeFile;
    return filePath ? getSession(vscode.Uri.file(filePath)) : undefined;
  };

  const send = async (session: RequestSession): Promise<void> => {
    await sendRequest(session);
    if (liteStore.getResponse(session.filePath)) await responses.show(session.filePath);
  };

  const selectEnvironment = async (session: RequestSession): Promise<void> => {
    const { collection } = session;
    if (!collection) return;
    const NONE = 'No Environment';
    const current = getSelectedEnvironment(collection);
    const picked = await vscode.window.showQuickPick(
      [NONE, ...await listEnvironments(collection)].map((label) => ({
        label,
        description: (label === NONE ? !current : label === current) ? 'active' : undefined
      })),
      { title: `Environment for ${basename(collection.uri)}`, placeHolder: 'Select the environment to send with' }
    );
    if (!picked) return;
    setSelectedEnvironment(collection, picked.label === NONE ? null : picked.label);
    environmentChanged.fire(collection.path);
    updateStatusBar();
  };

  const provider: vscode.CustomTextEditorProvider = {
    async resolveCustomTextEditor(document, panel) {
      const { webview } = panel;
      const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-lite');
      webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
      webview.html = formHtml(webview, mediaRoot);

      const session = await getSession(document.uri);
      const { filePath } = session;
      panels.set(filePath, panel);

      let resolved: ResolvedUrl | null = null;
      let resolveTimer: NodeJS.Timeout | undefined;

      const post = (message: HostMessage): void => void webview.postMessage(message);
      const postModel = (): void => post({ type: 'model', item: session.item });
      const postMeta = (): void => {
        const last = liteStore.getResponse(filePath);
        const meta: FormMeta = {
          fileName: basename(document.uri),
          environment: session.collection ? getSelectedEnvironment(session.collection) : null,
          codeEditing: codeEditing(),
          sending: isSending(filePath),
          lastResponse: last ? { ok: isSuccess(last.result), summary: summarize(last.result) } : null,
          resolvedUrl: resolved?.url ?? null,
          unresolved: resolved?.unresolved ?? [],
          error: session.collection ? session.error : 'This file is not inside a Bruno collection.'
        };
        post({ type: 'meta', meta });
      };

      /** Works out the URL as it would be sent, a moment after the request or its variables change. */
      const scheduleResolve = (): void => {
        clearTimeout(resolveTimer);
        resolveTimer = setTimeout(async () => {
          resolved = await resolveUrl(session).catch((): null => null);
          postMeta();
        }, RESOLVE_DELAY_MS);
      };

      const setActive = (): void => {
        if (!panel.active) return updateStatusBar();
        activeFile = filePath;
        responses.follow(filePath);
        updateStatusBar();
      };

      const subscriptions: vscode.Disposable[] = [
        // The form already applied its own edits; everything else (part editors, undo, text edits) is pushed.
        session.onDidChange((origin) => {
          if (origin !== 'form') postModel();
          postMeta();
          scheduleResolve();
        }),
        onDidChangeSending((changed) => changed === filePath && postMeta()),
        liteStore.onDidChange((changed) => {
          if (changed !== filePath) return;
          postMeta();
          // Scripts may have set runtime variables the URL uses.
          scheduleResolve();
        }),
        environmentChanged.event((collectionPath) => {
          if (collectionPath !== session.collection?.path) return;
          postMeta();
          scheduleResolve();
        }),
        vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('bruno.request') && postMeta()),
        panel.onDidChangeViewState(setActive),
        webview.onDidReceiveMessage(async (message: FormMessage) => {
          switch (message.type) {
            case 'ready':
              postModel();
              postMeta();
              scheduleResolve();
              return;
            case 'op':
              return session.apply(message.op, 'form');
            case 'cmd':
              switch (message.id) {
                case 'send': return send(session);
                case 'cancel': return cancelSend(filePath);
                case 'selectEnvironment': return selectEnvironment(session);
                case 'showResponse': return responses.show(filePath);
                case 'openClassic': return vscode.commands.executeCommand('vscode.openWith', document.uri, CLASSIC_VIEW_TYPE);
                case 'openText': return vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
                case 'openPart': return parts.open(session, message.part);
                case 'previewDocs':
                  await parts.open(session, 'docs');
                  return vscode.commands.executeCommand('markdown.showPreviewToSide');
                case 'prettify': {
                  const at = session.item && partPath(session.item, message.part);
                  if (!at) return;
                  const text = String(getAt(session.item, at) ?? '');
                  const pretty = prettifyBody(session.item!.request.body.mode, text);
                  if (pretty !== text) await session.apply({ t: 'set', path: at, value: pretty }, 'host');
                  return;
                }
              }
          }
        })
      ];

      setActive();

      panel.onDidDispose(() => {
        clearTimeout(resolveTimer);
        subscriptions.forEach((s) => s.dispose());
        panels.delete(filePath);
        if (activeFile === filePath) activeFile = undefined;
        updateStatusBar();
        void parts.closeAll(filePath);
      });
    }
  };

  context.subscriptions.push(
    environmentItem,
    environmentChanged,
    vscode.window.registerCustomEditorProvider(LITE_VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: false },
      supportsMultipleEditorsPerDocument: false
    }),
    vscode.window.onDidChangeActiveTextEditor(updateStatusBar),
    vscode.commands.registerCommand('bruno.lite.send', async (uri?: vscode.Uri) => {
      const session = await activeSession(uri);
      if (session) await send(session);
    }),
    vscode.commands.registerCommand('bruno.lite.selectEnvironment', async (uri?: vscode.Uri) => {
      const session = await activeSession(uri);
      if (session) await selectEnvironment(session);
    }),
    vscode.commands.registerCommand('bruno.lite.openClassic', async (uri?: vscode.Uri) => {
      const session = await activeSession(uri);
      if (session) await vscode.commands.executeCommand('vscode.openWith', session.document.uri, CLASSIC_VIEW_TYPE);
    }),
    vscode.commands.registerCommand('bruno.lite.open', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target) await vscode.commands.executeCommand('vscode.openWith', target, LITE_VIEW_TYPE);
    })
  );
}

function formHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.js'));
  const styles = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.css'));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styles}">
  <title>Bruno Request</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
