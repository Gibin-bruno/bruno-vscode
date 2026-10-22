// Config for `@vscode/test-cli` (`npm run test:integration`).
// Integration tests run inside VS Code's extension host, next to the Bruno extension, and drive it
// through the `vscode` API instead of the UI. See tests/integration/.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { defineConfig } from '@vscode/test-cli';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

// Same VS Code build as the e2e suite (tests/e2e/utils/vscode-executable.ts).
const VSCODE_VERSION = '1.136.2';

// @vscode/test-electron still returns `.../MacOS/Electron`, but VS Code 1.131+ renamed the macOS
// binary to `Code` — same workaround as tests/e2e/utils/vscode-executable.ts.
async function resolveVSCode() {
  const exe = await downloadAndUnzipVSCode(VSCODE_VERSION);
  if (fs.existsSync(exe) || process.platform !== 'darwin') {
    return exe;
  }
  return path.join(path.dirname(exe), 'Code');
}

// mTLS test material (gitignored), shared with the e2e suite. Generate it if missing, before VS Code
// starts, because NODE_EXTRA_CA_CERTS is only read at process start.
const MTLS_CERTS = 'tests/e2e/ssl/client-certificate/server/mtls-certs.ts';
const CA_CERT = path.resolve('tests/e2e/ssl/client-certificate/server/certs/ca.crt');
if (!fs.existsSync(CA_CERT)) {
  execFileSync('npx', ['tsx', MTLS_CERTS], { stdio: 'inherit' });
}

// Fresh per run, so no VS Code state (default workspace, last-opened collections, extension storage)
// carries over between runs. Without --user-data-dir, test-electron reuses .vscode-test/user-data.
// An empty workspace, so nothing from the repo (e.g. e2e fixtures) is auto-detected.
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-integration-user-data-'));
const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-integration-workspace-'));
// This process waits for VS Code to exit, so clean both up when it does.
process.once('exit', () => {
  for (const dir of [userDataDir, workspaceDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

export default defineConfig({
  label: 'integration',
  files: 'tests/integration/**/*.test.ts',
  useInstallation: { fromPath: await resolveVSCode() },
  workspaceFolder: workspaceDir,
  launchArgs: [
    `--user-data-dir=${userDataDir}`,
    // Only load the extension under test.
    '--disable-extensions'
  ],
  // Trust the mTLS test server's CA — same as the e2e fixture (tests/e2e/utils/fixtures/index.ts).
  env: { NODE_EXTRA_CA_CERTS: CA_CERT },
  mocha: {
    ui: 'tdd',
    timeout: 20_000,
    // Load the .ts test files directly, without a separate compile step.
    preload: 'tsx/cjs'
  }
});
