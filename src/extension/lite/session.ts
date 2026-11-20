/**
 * PROTOTYPE (lite request page): the host-side model of one open request.
 *
 * The TextDocument is the source of truth. An edit from the form or a part editor is applied to the
 * parsed request, serialised and written into the document, so dirty state, save, undo and redo are
 * VS Code's own. Any other change to the document (undo, redo, the text editor, a reload from disk)
 * is picked up by re-parsing it.
 */
import * as vscode from 'vscode';
import { parseRequest } from '../utils/parse';
import { stripDirtyMarker } from '../utils/dirty-marker';
import { basename } from '../utils/file';
import { findCollection, type CollectionRef } from './collection-files';
import { applyOp, type Op, type RequestItem } from './model';

const { stringifyRequest } = require('@usebruno/filestore');

/** Who caused a change, so each surface can skip the changes it made itself. */
export type ChangeOrigin = 'form' | 'part' | 'host' | 'external';

export class RequestSession implements vscode.Disposable {
  readonly filePath: string;
  readonly format: 'bru' | 'yml';

  item: RequestItem | null = null;
  error: string | null = null;

  private readonly changed = new vscode.EventEmitter<ChangeOrigin>();
  readonly onDidChange = this.changed.event;

  /** The document text the in-memory request was last parsed from or written as. */
  private modelText: string | null = null;
  private flushing = false;
  private flushAgain = false;
  private readonly subscription: vscode.Disposable;

  /** `collection` is null when the file is not inside a Bruno collection. */
  constructor(readonly document: vscode.TextDocument, readonly collection: CollectionRef | null) {
    this.filePath = document.uri.fsPath;
    this.format = collection?.format ?? (document.uri.path.endsWith('.yml') ? 'yml' : 'bru');

    this.subscription = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document !== document || e.contentChanges.length === 0) return;
      if (this.text() === this.modelText) return;
      void this.reparse('external');
    });
  }

  get name(): string {
    return String(this.item?.name || basename(this.document.uri).replace(/\.[^.]+$/, ''));
  }

  private text(): string {
    return stripDirtyMarker(this.document.getText());
  }

  async reparse(origin: ChangeOrigin = 'external'): Promise<void> {
    const text = this.text();
    try {
      this.item = await parseRequest(text, { format: this.format }) as RequestItem;
      this.error = null;
    } catch (err) {
      // Keep showing the last good request; the form says the file cannot be read as it stands.
      this.error = (err as Error).message || 'This file could not be parsed.';
    }
    this.modelText = text;
    this.changed.fire(origin);
  }

  /** Applies an edit to the request now and writes it into the document shortly after. */
  apply(op: Op, origin: ChangeOrigin): Promise<void> {
    if (!this.item) return Promise.resolve();
    applyOp(this.item, op);
    this.changed.fire(origin);
    return this.flush();
  }

  /** Writes the request into the document. Edits that arrive while writing are folded into one more write. */
  private async flush(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return;
    }
    this.flushing = true;
    try {
      do {
        this.flushAgain = false;
        const next: string = await stringifyRequest(this.item, { format: this.format });
        const current = this.text();
        if (next === current) continue;

        this.modelText = next;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(this.document.uri, changedRange(this.document, current, next), changedText(current, next));
        await vscode.workspace.applyEdit(edit);
      } while (this.flushAgain);
    } catch (err) {
      console.error('[Bruno lite] Could not write the request:', err);
    } finally {
      this.flushing = false;
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}

function commonEdges(a: string, b: string): [prefix: number, suffix: number] {
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)) suffix++;
  return [prefix, suffix];
}

/** The smallest range of `current` that differs from `next`, so undo steps and cursors stay local. */
function changedRange(document: vscode.TextDocument, current: string, next: string): vscode.Range {
  const [prefix, suffix] = commonEdges(current, next);
  return new vscode.Range(document.positionAt(prefix), document.positionAt(current.length - suffix));
}

function changedText(current: string, next: string): string {
  const [prefix, suffix] = commonEdges(current, next);
  return next.slice(prefix, next.length - suffix);
}

const sessions = new Map<string, RequestSession>();
let closeWatcher: vscode.Disposable | undefined;

/** The session for a request file, created (and its document opened) on first use. */
export async function getSession(uri: vscode.Uri): Promise<RequestSession> {
  const key = uri.fsPath;
  const existing = sessions.get(key);
  if (existing && !existing.document.isClosed) return existing;
  existing?.dispose();

  const document = await vscode.workspace.openTextDocument(uri);
  const session = new RequestSession(document, await findCollection(uri));
  await session.reparse('host');
  sessions.set(key, session);

  closeWatcher ??= vscode.workspace.onDidCloseTextDocument((closed) => {
    const open = sessions.get(closed.uri.fsPath);
    if (open?.document === closed) {
      open.dispose();
      sessions.delete(closed.uri.fsPath);
    }
  });

  return session;
}

export const peekSession = (filePath: string): RequestSession | undefined => {
  const session = sessions.get(filePath);
  return session && !session.document.isClosed ? session : undefined;
};
