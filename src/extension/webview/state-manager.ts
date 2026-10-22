import * as vscode from 'vscode';

interface IpcResponse {
  type: 'response' | 'event';
  channel?: string;
  requestId?: string;
  result?: unknown;
  error?: string;
  args?: unknown[];
}

type MessageListener = (channel: string, args: unknown[]) => void;

export class WebviewStateManager {
  private webviews: Set<vscode.Webview> = new Set();
  private _lastActiveEditorWebview: vscode.Webview | null = null;
  // Observers of every event sent to webviews — used by the integration-test API (see test-api.ts).
  private messageListeners: Set<MessageListener> = new Set();

  /** Observe every event sent to webviews. Returns an unsubscribe function. */
  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  private notifyListeners(channel: string, args: unknown[]): void {
    for (const listener of this.messageListeners) {
      listener(channel, args);
    }
  }

  addWebview(webview: vscode.Webview): void {
    this.webviews.add(webview);
  }

  removeWebview(webview: vscode.Webview): void {
    this.webviews.delete(webview);
    if (this._lastActiveEditorWebview === webview) {
      this._lastActiveEditorWebview = null;
    }
  }

  setActiveEditorWebview(webview: vscode.Webview): void {
    this._lastActiveEditorWebview = webview;
  }

  get lastActiveEditorWebview(): vscode.Webview | null {
    return this._lastActiveEditorWebview;
  }

  broadcast(channel: string, ...args: unknown[]): void {
    const message: IpcResponse = {
      type: 'event',
      channel,
      args
    };
    for (const webview of this.webviews) {
      webview.postMessage(message);
    }
    this.notifyListeners(channel, args);
  }

  sendTo(webview: vscode.Webview, channel: string, ...args: unknown[]): void {
    const message: IpcResponse = {
      type: 'event',
      channel,
      args
    };
    webview.postMessage(message);
    this.notifyListeners(channel, args);
  }

  dispose(): void {
    this.webviews.clear();
    this.messageListeners.clear();
  }
}

export const stateManager = new WebviewStateManager();
