/**
 * PROTOTYPE (lite request page): the request model and the edits that can be made to it.
 *
 * Shared by the extension host and the lite webview, so it must stay free of `vscode` and Node
 * imports. The webview applies an op optimistically; the host applies the same op, serialises the
 * request and writes it into the TextDocument, which is the source of truth.
 */

export type Path = Array<string | number>;

export interface KeyValueRow {
  name: string;
  value: string;
  enabled: boolean;
  type?: 'query' | 'path';
  [key: string]: unknown;
}

export interface RequestItem {
  type: string;
  name: string;
  request: {
    method: string;
    url: string;
    headers: KeyValueRow[];
    params: KeyValueRow[];
    body: { mode: string; [key: string]: unknown };
    auth: { mode: string; [key: string]: unknown };
    script: { req?: string; res?: string };
    vars: { req?: KeyValueRow[]; res?: KeyValueRow[] };
    assertions: KeyValueRow[];
    tests?: string;
    docs?: string;
  };
  [key: string]: unknown;
}

export type Op =
  | { t: 'set'; path: Path; value: unknown }
  | { t: 'url'; value: string }
  | { t: 'rowSet'; list: Path; index: number; field: string; value: unknown }
  | { t: 'rowAdd'; list: Path; row: Partial<KeyValueRow> }
  | { t: 'rowDel'; list: Path; index: number };

/** The editable code parts of a request, each of which can open as its own VS Code editor. */
export const PARTS = {
  'body': { label: 'Body', path: ['request', 'body'] as Path },
  'pre-request': { label: 'Pre-request script', path: ['request', 'script', 'req'] as Path, ext: 'js' },
  'post-response': { label: 'Post-response script', path: ['request', 'script', 'res'] as Path, ext: 'js' },
  'tests': { label: 'Tests', path: ['request', 'tests'] as Path, ext: 'js' },
  'docs': { label: 'Docs', path: ['request', 'docs'] as Path, ext: 'md' }
} as const;

export type PartId = keyof typeof PARTS;

const BODY_EXT: Record<string, string> = { json: 'json', xml: 'xml', text: 'txt', sparql: 'sparql' };

/** Body modes whose content is a single block of text. */
export const isTextBodyMode = (mode: string): boolean => mode in BODY_EXT;

export function partPath(item: RequestItem, part: PartId): Path | null {
  if (part !== 'body') return PARTS[part].path;
  const mode = item.request?.body?.mode;
  return isTextBodyMode(mode) ? ['request', 'body', mode] : null;
}

export function partExt(item: RequestItem, part: PartId): string {
  if (part !== 'body') return PARTS[part].ext;
  return BODY_EXT[item.request?.body?.mode] || 'txt';
}

export function getAt(root: unknown, path: Path): unknown {
  let node = root as Record<string | number, unknown>;
  for (const key of path) {
    if (node === null || node === undefined) return undefined;
    node = node[key] as Record<string | number, unknown>;
  }
  return node;
}

function setAt(root: unknown, path: Path, value: unknown): void {
  let node = root as Record<string | number, unknown>;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (node[key] === null || typeof node[key] !== 'object') {
      node[key] = typeof path[i + 1] === 'number' ? [] : {};
    }
    node = node[key] as Record<string | number, unknown>;
  }
  node[path[path.length - 1]] = value;
}

const isParams = (list: Path): boolean => list.join('.') === 'request.params';

function splitUrl(url: string): [string, string] {
  const at = url.indexOf('?');
  return at === -1 ? [url, ''] : [url.slice(0, at), url.slice(at + 1)];
}

/** `:name` segments of the path, ignoring the scheme and a `host:port`. */
function pathParamNames(base: string): string[] {
  const afterScheme = base.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const slash = afterScheme.indexOf('/');
  if (slash === -1) return [];
  const names: string[] = [];
  for (const segment of afterScheme.slice(slash + 1).split('/')) {
    const match = /^:([A-Za-z0-9_-]+)$/.exec(segment);
    if (match && !names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/** The URL was edited: rebuild the query and path rows from it, keeping disabled rows and known values. */
function syncParamsFromUrl(item: RequestItem): void {
  const [base, query] = splitUrl(item.request.url || '');
  const existing = item.request.params || [];

  const enabledQuery: KeyValueRow[] = query
    ? query.split('&').filter(Boolean).map((pair) => {
        const eq = pair.indexOf('=');
        return {
          name: eq === -1 ? pair : pair.slice(0, eq),
          value: eq === -1 ? '' : pair.slice(eq + 1),
          enabled: true,
          type: 'query' as const
        };
      })
    : [];
  const disabledQuery = existing.filter((p) => p.type !== 'path' && !p.enabled);
  const pathRows = pathParamNames(base).map((name) => {
    const known = existing.find((p) => p.type === 'path' && p.name === name);
    return known || { name, value: '', enabled: true, type: 'path' as const };
  });

  item.request.params = [...enabledQuery, ...disabledQuery, ...pathRows];
}

/** The params table was edited: rebuild the URL's query string from the enabled query rows. */
function syncUrlFromParams(item: RequestItem): void {
  const [base] = splitUrl(item.request.url || '');
  const query = (item.request.params || [])
    .filter((p) => p.type !== 'path' && p.enabled && p.name)
    .map((p) => (p.value === '' ? p.name : `${p.name}=${p.value}`))
    .join('&');
  item.request.url = query ? `${base}?${query}` : base;
}

/** Applies `op` to `item` in place. The caller clones first when it needs the previous value. */
export function applyOp(item: RequestItem, op: Op): void {
  switch (op.t) {
    case 'set':
      setAt(item, op.path, op.value);
      return;
    case 'url':
      item.request.url = op.value;
      syncParamsFromUrl(item);
      return;
    case 'rowSet': {
      const rows = getAt(item, op.list) as KeyValueRow[] | undefined;
      if (!rows?.[op.index]) return;
      rows[op.index][op.field] = op.value;
      if (isParams(op.list)) syncUrlFromParams(item);
      return;
    }
    case 'rowAdd': {
      let rows = getAt(item, op.list) as KeyValueRow[] | undefined;
      if (!Array.isArray(rows)) {
        rows = [];
        setAt(item, op.list, rows);
      }
      rows.push({ name: '', value: '', enabled: true, ...op.row } as KeyValueRow);
      if (isParams(op.list)) syncUrlFromParams(item);
      return;
    }
    case 'rowDel': {
      const rows = getAt(item, op.list) as KeyValueRow[] | undefined;
      if (!rows) return;
      rows.splice(op.index, 1);
      if (isParams(op.list)) syncUrlFromParams(item);
      return;
    }
  }
}

/** What the host tells the form besides the request itself. */
export interface FormMeta {
  fileName: string;
  environment: string | null;
  codeEditing: 'inline' | 'editor';
  sending: boolean;
  lastResponse: { ok: boolean; summary: string } | null;
  /** The URL with variables and path params filled in; null when there is nothing to fill in. */
  resolvedUrl: string | null;
  /** Variables used in the URL that no scope defines. */
  unresolved: string[];
  error: string | null;
}

export type HostMessage =
  | { type: 'model'; item: RequestItem | null }
  | { type: 'meta'; meta: FormMeta };

export type FormMessage =
  | { type: 'ready' }
  | { type: 'op'; op: Op }
  | { type: 'cmd'; id: 'send' | 'cancel' | 'selectEnvironment' | 'showResponse' | 'openClassic' | 'openText' }
  | { type: 'cmd'; id: 'openPart' | 'prettify' | 'previewDocs'; part: PartId };
