/**
 * PROTOTYPE (lite request page): the code parts of a request (body, scripts, tests, docs) as
 * writable virtual files, so they open in real VS Code editors with the user's own keybindings,
 * language features and formatters.
 *
 * A part editor edits the request live: each change is applied to the session, which writes it into
 * the request document. Saving a part saves the request file.
 */
import * as vscode from 'vscode';
import xmlFormat from 'xml-formatter';
import { prettifyJsonString } from '../../utils/json';
import { getSession, peekSession, type RequestSession } from './session';
import { companionColumn } from './response-views';
import { PARTS, getAt, partExt, partPath, type PartId } from './model';

export const PART_SCHEME = 'bruno-part';
const LIVE_SYNC_DELAY_MS = 200;

const toUri = (session: RequestSession, part: PartId): vscode.Uri =>
  vscode.Uri.from({
    scheme: PART_SCHEME,
    path: `/${session.name.replace(/[\\/]/g, '-')} (${PARTS[part].label}).${partExt(session.item!, part)}`,
    query: `${part}:${encodeURIComponent(session.filePath)}`
  });

function fromUri(uri: vscode.Uri): { part: PartId; filePath: string } {
  const at = uri.query.indexOf(':');
  return { part: uri.query.slice(0, at) as PartId, filePath: decodeURIComponent(uri.query.slice(at + 1)) };
}

const partText = (session: RequestSession, part: PartId): string => {
  const at = session.item && partPath(session.item, part);
  return at ? String(getAt(session.item, at) ?? '') : '';
};

/** Indents a JSON or XML body the way the classic editor's Prettify does, leaving `{{variables}}` alone. */
export function prettifyBody(mode: string, text: string): string {
  if (mode === 'json') return prettifyJsonString(text);
  if (mode === 'xml') {
    try {
      return xmlFormat(text, { collapseContent: true });
    } catch {
      return text;
    }
  }
  return text;
}

export interface Parts {
  open(session: RequestSession, part: PartId): Promise<void>;
  closeAll(filePath: string): Promise<void>;
}

export function registerParts(context: vscode.ExtensionContext): Parts {
  const fileChanged = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  const mtimes = new Map<string, number>();
  const watched = new WeakSet<RequestSession>();
  const pendingSync = new Map<string, NodeJS.Timeout>();

  const openPartDocuments = (filePath: string): vscode.TextDocument[] =>
    vscode.workspace.textDocuments.filter((d) => d.uri.scheme === PART_SCHEME && fromUri(d.uri).filePath === filePath);

  /** When the request changes anywhere else (the form, undo, the text editor), open part editors reload. */
  const watch = (session: RequestSession): void => {
    if (watched.has(session)) return;
    watched.add(session);
    context.subscriptions.push(session.onDidChange((origin) => {
      if (origin === 'part') return;
      const stale = openPartDocuments(session.filePath)
        .filter((d) => d.getText() !== partText(session, fromUri(d.uri).part));
      for (const document of stale) mtimes.set(document.uri.toString(), Date.now());
      if (stale.length) fileChanged.fire(stale.map((d) => ({ type: vscode.FileChangeType.Changed, uri: d.uri })));
    }));
  };

  const sessionFor = async (uri: vscode.Uri): Promise<{ session: RequestSession; part: PartId }> => {
    const { part, filePath } = fromUri(uri);
    const session = await getSession(vscode.Uri.file(filePath));
    watch(session);
    return { session, part };
  };

  const write = async (session: RequestSession, part: PartId, text: string): Promise<void> => {
    const at = session.item && partPath(session.item, part);
    if (!at || partText(session, part) === text) return;
    await session.apply({ t: 'set', path: at, value: text }, 'part');
  };

  const provider: vscode.FileSystemProvider = {
    onDidChangeFile: fileChanged.event,
    watch: () => new vscode.Disposable(() => undefined),
    async stat(uri) {
      const { session, part } = await sessionFor(uri);
      return {
        type: vscode.FileType.File,
        ctime: 0,
        mtime: mtimes.get(uri.toString()) ?? 0,
        size: Buffer.byteLength(partText(session, part))
      };
    },
    async readFile(uri) {
      const { session, part } = await sessionFor(uri);
      return Buffer.from(partText(session, part));
    },
    async writeFile(uri, content) {
      const { session, part } = await sessionFor(uri);
      clearTimeout(pendingSync.get(uri.toString()));
      await write(session, part, Buffer.from(content).toString('utf8'));
      mtimes.set(uri.toString(), Date.now());
      // Saving a part is saving the request.
      await session.document.save();
    },
    readDirectory: () => [],
    createDirectory: () => { throw vscode.FileSystemError.NoPermissions(); },
    delete: () => { throw vscode.FileSystemError.NoPermissions(); },
    rename: () => { throw vscode.FileSystemError.NoPermissions(); }
  };

  const open = async (session: RequestSession, part: PartId): Promise<void> => {
    if (!session.item || !partPath(session.item, part)) return;
    watch(session);
    await vscode.window.showTextDocument(toUri(session, part), {
      viewColumn: companionColumn(),
      preview: false
    });
  };

  const closeAll = async (filePath: string): Promise<void> => {
    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => {
      const uri = tab.input instanceof vscode.TabInputText ? tab.input.uri : undefined;
      return uri?.scheme === PART_SCHEME && fromUri(uri).filePath === filePath;
    });
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
  };

  context.subscriptions.push(
    fileChanged,
    vscode.workspace.registerFileSystemProvider(PART_SCHEME, provider, { isCaseSensitive: true }),
    // Typing in a part editor updates the request (and so the form) without waiting for a save.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== PART_SCHEME || e.contentChanges.length === 0) return;
      const key = e.document.uri.toString();
      clearTimeout(pendingSync.get(key));
      pendingSync.set(key, setTimeout(() => {
        const { part, filePath } = fromUri(e.document.uri);
        const session = peekSession(filePath);
        if (session && !e.document.isClosed) void write(session, part, e.document.getText());
      }, LIVE_SYNC_DELAY_MS));
    }),
    // Format Document in a JSON body uses Bruno's formatter, which tolerates {{variables}}.
    vscode.languages.registerDocumentFormattingEditProvider({ scheme: PART_SCHEME, language: 'json' }, {
      provideDocumentFormattingEdits(document) {
        const text = document.getText();
        const pretty = prettifyJsonString(text);
        if (pretty === text) return [];
        return [vscode.TextEdit.replace(new vscode.Range(document.positionAt(0), document.positionAt(text.length)), pretty)];
      }
    })
  );

  return { open, closeAll };
}
