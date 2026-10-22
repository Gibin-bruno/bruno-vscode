import { spawn, type ChildProcess } from 'child_process';
import * as net from 'net';
import * as path from 'path';

/**
 * The e2e test server (tests/e2e/server/index.ts): HTTP + WS on 8081, gRPC on 8082, and the mTLS
 * servers on 8083/8084. Playwright starts it through `webServer`; the integration runner has no such
 * hook, so start the same command here as a child process — unless it's already running (e.g. a
 * local Playwright server kept alive by `reuseExistingServer`).
 */

export const TEST_SERVER = 'http://127.0.0.1:8081';
// HTTP/WS, gRPC, mTLS HTTPS/WSS, mTLS gRPC — the server is ready once all of them accept connections.
const PORTS = [8081, 8082, 8083, 8084];
const REPO_ROOT = path.resolve(__dirname, '../..');

const allListening = async (): Promise<boolean> =>
  (await Promise.all(PORTS.map(isListening))).every(Boolean);

const isListening = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

let started: Promise<void> | undefined;

/** Start the test server once per run (shared by every suite); it's stopped when VS Code exits. */
export function ensureTestServer(): Promise<void> {
  started ??= (async () => {
    if (await allListening()) {
      return;
    }

    const child: ChildProcess = spawn(
      path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
      ['tests/e2e/server/index.ts'],
      { cwd: REPO_ROOT, stdio: 'inherit' }
    );
    // The extension host exits with VS Code; take the server down with it.
    process.once('exit', () => child.kill());

    for (let attempt = 0; attempt < 100; attempt++) {
      if (await allListening()) {
        return;
      }
      if (child.exitCode !== null) {
        throw new Error(`Test server exited with code ${child.exitCode}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Test server did not start within 10s');
  })();
  return started;
}
