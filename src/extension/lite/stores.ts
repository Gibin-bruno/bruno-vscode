/**
 * PROTOTYPE (lite request page): host-side stores for what a send produces.
 *
 * These replace the response and timeline slices of the webview's Redux store. Native surfaces (the
 * response document, the Response tree, the form's status line) subscribe to `onDidChange`.
 */
import * as vscode from 'vscode';

export interface SendResult {
  status?: number;
  statusText?: string;
  headers?: Record<string, unknown>;
  data?: unknown;
  dataBuffer?: string;
  size?: number;
  duration?: number;
  requestSent?: { url?: string; method?: string; headers?: Record<string, unknown>; data?: unknown };
  requestUrl?: string;
  error?: string;
}

export interface TestRow {
  kind: 'test' | 'assertion' | 'pre-request' | 'post-response';
  description: string;
  passed: boolean;
  error?: string;
}

export interface ResponseEntry {
  filePath: string;
  collectionPath: string;
  name: string;
  at: number;
  result: SendResult;
  tests: TestRow[];
  scriptErrors: string[];
}

export interface TimelineEntry {
  id: number;
  filePath: string;
  at: number;
  method: string;
  url: string;
  requestHeaders: Record<string, unknown>;
  status?: number;
  statusText?: string;
  duration?: number;
  size?: number;
  responseHeaders: Record<string, unknown>;
  error?: string;
}

const MAX_TIMELINE_PER_COLLECTION = 200;

class LiteStore {
  private readonly responses = new Map<string, ResponseEntry>();
  private readonly timelines = new Map<string, TimelineEntry[]>();
  private readonly changed = new vscode.EventEmitter<string>();
  private nextId = 1;

  /** Fires with the request file path whose response or timeline changed. */
  readonly onDidChange = this.changed.event;

  getResponse(filePath: string): ResponseEntry | undefined {
    return this.responses.get(filePath);
  }

  record(entry: ResponseEntry): void {
    this.responses.set(entry.filePath, entry);

    const { result } = entry;
    const timeline = this.timelines.get(entry.collectionPath) || [];
    timeline.push({
      id: this.nextId++,
      filePath: entry.filePath,
      at: entry.at,
      method: String(result.requestSent?.method || '').toUpperCase(),
      url: result.requestSent?.url || result.requestUrl || '',
      requestHeaders: result.requestSent?.headers || {},
      status: result.status || undefined,
      statusText: result.statusText,
      duration: result.duration,
      size: result.size,
      responseHeaders: result.headers || {},
      error: result.status ? undefined : (result.error || result.statusText)
    });
    this.timelines.set(entry.collectionPath, timeline.slice(-MAX_TIMELINE_PER_COLLECTION));

    this.changed.fire(entry.filePath);
  }

  /** Calls made for one request, newest first. */
  timelineFor(collectionPath: string, filePath: string): TimelineEntry[] {
    return (this.timelines.get(collectionPath) || []).filter((e) => e.filePath === filePath).reverse();
  }

  clearTimeline(collectionPath: string, filePath: string): void {
    const timeline = this.timelines.get(collectionPath);
    if (!timeline) return;
    this.timelines.set(collectionPath, timeline.filter((e) => e.filePath !== filePath));
    this.changed.fire(filePath);
  }
}

export const liteStore = new LiteStore();

export const isSuccess = (result: SendResult): boolean => !!result.status && result.status < 400;

export function formatSize(bytes = 0): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const summarize = (result: SendResult): string =>
  result.status
    ? `${result.status} ${result.statusText || ''}`.trim() + ` · ${result.duration ?? 0} ms · ${formatSize(result.size)}`
    : `Error: ${result.error || result.statusText || 'request failed'}`;
