import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BrunoTestApi } from '../../src/extension/test-api';

const EXTENSION_ID = 'bruno-api-client.bruno';

/**
 * Activate Bruno and return the API it exposes in test mode (see src/extension/test-api.ts).
 * `activate()` resolves to whatever the extension's `activate` returned.
 */
export async function getTestApi(): Promise<BrunoTestApi> {
  const extension = vscode.extensions.getExtension<BrunoTestApi | undefined>(EXTENSION_ID);
  if (!extension) {
    throw new Error(`Extension ${EXTENSION_ID} not found — is extensionDevelopmentPath the repo root?`);
  }
  const api = await extension.activate();
  if (!api) {
    throw new Error('Bruno did not return a test API — is VS Code running the extension in test mode?');
  }
  return api;
}

/**
 * Resolve with the args of the first webview event on `channel` matching `predicate`.
 * Subscribe *before* triggering the action that sends it, or the event can be missed.
 */
export function waitForWebviewMessage(
  api: BrunoTestApi,
  channel: string,
  predicate: (args: unknown[]) => boolean = () => true,
  timeoutMs = 10_000
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for webview message "${channel}"`));
    }, timeoutMs);
    const unsubscribe = api.onWebviewMessage((messageChannel, args) => {
      if (messageChannel === channel && predicate(args)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(args);
      }
    });
  });
}

/**
 * Run `action` and return every webview event the extension sent while it ran,
 * e.g. `main:collection-opened`.
 */
export async function collectWebviewMessages(
  api: BrunoTestApi,
  action: () => Promise<unknown>
): Promise<{ channel: string; args: unknown[] }[]> {
  const messages: { channel: string; args: unknown[] }[] = [];
  const unsubscribe = api.onWebviewMessage((channel, args) => messages.push({ channel, args }));
  try {
    await action();
  } finally {
    unsubscribe();
  }
  return messages;
}

type ScannedFile = {
  meta: { pathname: string; name: string; collectionRoot?: boolean; folderRoot?: boolean };
  data: Record<string, unknown>;
  // The initial scan only parses request metadata; the full request is loaded on demand.
  partial?: boolean;
};

/**
 * A collection in the shape the webview keeps in its Redux store and sends with requests
 * (`send-http-request`, `grpc:start-connection`, `renderer:ws:start-connection`, ...).
 * Only the fields the extension reads are filled in.
 */
export interface LoadedCollection {
  uid: string;
  name: string;
  pathname: string;
  brunoConfig: Record<string, unknown>;
  root: Record<string, unknown>;
  // Requests and folders found by the extension's scan, as a tree like the webview's: folders are
  // `{ type: 'folder', root, items }`, requests are fully loaded.
  items: Record<string, unknown>[];
}

/**
 * Open a collection from disk the way the sidebar does, wait for the extension's initial scan,
 * and assemble what the webview would have built from the events: config, root and request items.
 *
 * Also registers the collection in the extension's own stores (e.g. the bruno config that client
 * certificates and proxy settings are read from), exactly as opening it in the UI does.
 */
export async function loadCollection(api: BrunoTestApi, collectionPath: string): Promise<LoadedCollection> {
  // Listen before opening: the scan can finish while `invoke` is still running.
  const files: ScannedFile[] = [];
  const dirs: { pathname: string; name: string; uid?: string; seq?: number }[] = [];
  const scannedUids = new Set<string>();
  let onScanned: (uid: string) => void = () => {};
  const unsubscribe = api.onWebviewMessage((channel, args) => {
    if (channel === 'main:collection-tree-updated') {
      const [action, payload] = args;
      if (action === 'addFiles') files.push(...(payload as ScannedFile[]));
      if (action === 'addFile') files.push(payload as ScannedFile);
      if (action === 'addDir') dirs.push((payload as { meta: (typeof dirs)[number] }).meta);
    }
    if (channel === 'main:collection-loading-state-updated') {
      const { collectionUid, isLoading } = args[0] as { collectionUid: string; isLoading: boolean };
      if (!isLoading) {
        scannedUids.add(collectionUid);
        onScanned(collectionUid);
      }
    }
  });

  try {
    const opened = waitForWebviewMessage(api, 'main:collection-opened', ([pathname]) => pathname === collectionPath);
    await api.invoke('renderer:open-collection-by-path', [collectionPath]);
    const [, uid, brunoConfig] = await opened;

    if (!scannedUids.has(uid as string)) {
      await new Promise<void>((resolve) => {
        onScanned = (scannedUid) => scannedUid === uid && resolve();
      });
    }

    const rootFile = files.find((file) => file.meta.collectionRoot);
    const folderRootFiles = files.filter((file) => file.meta.folderRoot);
    const requestFiles = files.filter((file) => !file.meta.collectionRoot && !file.meta.folderRoot && typeof file.data?.type === 'string');

    // Load each partially-scanned request in full, as the webview does when it opens or runs one:
    // `renderer:load-request` replies with a `change` event carrying the parsed request.
    for (const file of requestFiles.filter(({ partial }) => partial)) {
      const loaded = waitForWebviewMessage(api, 'main:collection-tree-updated', ([action, payload]) =>
        action === 'change' && (payload as ScannedFile)?.meta?.pathname === file.meta.pathname
      );
      await api.invoke('renderer:load-request', { collectionUid: uid, pathname: file.meta.pathname });
      file.data = ((await loaded)[1] as ScannedFile).data;
    }

    // Build the tree: a folder per directory (with its folder.bru/folder.yml as `root`), and every
    // request inside the folder its file lives in.
    const folders = new Map<string, Record<string, unknown> & { items: Record<string, unknown>[] }>();
    for (const dir of [...dirs].sort((a, b) => a.pathname.length - b.pathname.length)) {
      folders.set(dir.pathname, {
        uid: dir.uid ?? `folder-${dir.pathname}`,
        name: dir.name,
        type: 'folder',
        pathname: dir.pathname,
        seq: dir.seq,
        root: folderRootFiles.find((file) => path.dirname(file.meta.pathname) === dir.pathname)?.data ?? {},
        items: []
      });
    }
    const items: Record<string, unknown>[] = [];
    const addTo = (parentPathname: string, item: Record<string, unknown>) =>
      (folders.get(parentPathname)?.items ?? items).push(item);
    for (const folder of folders.values()) {
      addTo(path.dirname(folder.pathname as string), folder);
    }
    requestFiles.forEach((file, index) => addTo(path.dirname(file.meta.pathname), {
      ...file.data,
      uid: `item-${index}`,
      pathname: file.meta.pathname,
      filename: file.meta.name
    }));

    return {
      uid: uid as string,
      name: (brunoConfig as { name: string }).name,
      pathname: collectionPath,
      brunoConfig: brunoConfig as Record<string, unknown>,
      root: rootFile?.data ?? {},
      items
    };
  } finally {
    unsubscribe();
  }
}

export type WebviewMessage = { channel: string; args: unknown[] };

export type Environment = { uid: string; name: string; variables: Record<string, unknown>[] };

/**
 * An environment as the webview holds it once selected, and passes to `send-http-request`.
 * (The extension only sends environments to a webview when a request editor or the environment
 * panel opens, so tests build the selected one themselves.)
 */
export function environment(name: string, variables: Record<string, string>): Environment {
  return {
    uid: `env-${name}`,
    name,
    variables: Object.entries(variables).map(([variableName, value]) => ({
      uid: `env-${name}-${variableName}`,
      name: variableName,
      value,
      type: 'text',
      enabled: true,
      secret: false
    }))
  };
}

/** Every item in a collection tree (folders and requests), depth first. */
export function flattenItems(items: Record<string, unknown>[]): Record<string, unknown>[] {
  return items.flatMap((item) => [item, ...flattenItems((item.items as Record<string, unknown>[]) ?? [])]);
}

/** Find a request or folder from `loadCollection` by its name, at any depth. */
export function findItem(collection: LoadedCollection, name: string): Record<string, unknown> {
  const item = flattenItems(collection.items).find((candidate) => candidate.name === name);
  if (!item) {
    throw new Error(`No item named "${name}" in ${collection.pathname}`);
  }
  return item;
}

/**
 * Send a request item exactly as the webview does (`send-http-request`), and return the response
 * plus every event the extension emitted while sending — script results
 * (`main:run-request-event`), variable updates (`main:persistent-env-variables-update`), etc.
 * The handler only resolves once scripts have run, so all of those arrive before it returns.
 */
export async function sendRequest(
  api: BrunoTestApi,
  collection: LoadedCollection,
  item: Record<string, unknown>,
  environment: Environment | null = null
): Promise<{ response: Record<string, unknown>; events: WebviewMessage[] }> {
  let response: Record<string, unknown> = {};
  const events = await collectWebviewMessages(api, async () => {
    response = await api.invoke('send-http-request', item, collection, environment, {});
  });
  return { response, events };
}

/** The `<type>-script-execution` report for a send, e.g. 'pre-request' or 'post-response'. */
export function scriptReport(events: WebviewMessage[], scriptType: 'pre-request' | 'post-response' | 'test') {
  const event = events.find(({ channel, args }) =>
    channel === 'main:run-request-event' && (args[0] as { type: string }).type === `${scriptType}-script-execution`
  );
  return event?.args[0] as
    | { errorMessage: string | null; errorContext: { filePath?: string; errorLine?: number; lines?: { content: string; isError?: boolean }[]; stack?: string } | null }
    | undefined;
}

/**
 * Create a .bru collection at `parentDir/name` containing `files` (path relative to the collection
 * → content), then open it like the sidebar does. Returns the loaded collection.
 */
export async function createBruCollection(
  api: BrunoTestApi,
  parentDir: string,
  name: string,
  files: Record<string, string> = {}
): Promise<LoadedCollection> {
  const collectionPath = path.join(parentDir, name);
  fs.mkdirSync(collectionPath);
  fs.writeFileSync(path.join(collectionPath, 'bruno.json'), JSON.stringify({ version: '1', name, type: 'collection' }));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(collectionPath, file)), { recursive: true });
    fs.writeFileSync(path.join(collectionPath, file), content);
  }
  return loadCollection(api, collectionPath);
}
