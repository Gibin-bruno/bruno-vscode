import { handleInvoke } from './ipc/handlers';
import { stateManager } from './webview/state-manager';

/**
 * API returned from `activate()` only when VS Code runs the extension in test mode
 * (`ExtensionMode.Test`, i.e. under @vscode/test-cli). Users never get it.
 *
 * Integration tests (tests/integration) run in the extension host and use it to talk to the
 * extension the same way the webviews do, without any UI:
 *   - `invoke` calls an IPC handler, like `ipcRenderer.invoke` in a webview.
 *   - `onWebviewMessage` observes every event the extension sends to webviews
 *     (e.g. `main:collection-opened`, `main:run-folder-event`).
 */
export interface BrunoTestApi {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  onWebviewMessage(listener: (channel: string, args: unknown[]) => void): () => void;
}

export function createTestApi(): BrunoTestApi {
  return {
    invoke: <T>(channel: string, ...args: unknown[]) => handleInvoke(channel, args) as Promise<T>,
    onWebviewMessage: (listener) => stateManager.onMessage(listener)
  };
}
