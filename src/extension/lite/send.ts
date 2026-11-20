/**
 * PROTOTYPE (lite request page): sending a request without a webview.
 *
 * Assembles, from the collection's files and the host stores, the `[item, collection, environment]`
 * arguments the existing `send-http-request` handler expects from the classic webview, runs it, and
 * collects the events it reports along the way. The same context resolves the URL preview.
 *
 * Not covered yet: prompt variables (`{{?name}}`), OAuth2 token calls in the timeline, and writing
 * `bru.setEnvVar(..., { persist })` changes back to environment files.
 */
import * as vscode from 'vscode';
import { cloneDeep } from 'lodash';
import { parseValueByDataType } from '@usebruno/common/utils';
import { handleInvoke, onOutboundEvent, broadcastToAllWebviews } from '../ipc/handlers';
import { interpolateString } from '../ipc/network/interpolate-string';
import { transformBrunoConfigAfterRead } from '../utils/transformBrunoConfig';
import { parseCollection, parseFolder, parseEnvironment } from '../utils/parse';
import { hydrateRequestWithUuid, mergeVars, getTreePathFromCollectionToItem, getEnvVars } from '../utils/collection';
import { generateUidBasedOnHash, uuid } from '../utils/common';
import { decryptStringSafe } from '../utils/encryption';
import EnvironmentSecretsStore from '../store/env-secrets';
import CollectionSecurityStore from '../store/collection-security';
import UiStateSnapshotStore from '../store/ui-state-snapshot';
import { globalEnvironmentsStore } from '../store/global-environments';
import { getRuntimeVariables } from '../store/runtime-variables';
import { getProcessEnvVars } from '../store/process-env';
import {
  basename, collectionRootFile, environmentFile, folderRootFile, foldersBetween, listEnvironmentNames,
  readBrunoConfig, readOptional, type CollectionRef
} from './collection-files';
import type { RequestSession } from './session';
import { liteStore, type SendResult, type TestRow } from './stores';

type AnyRecord = Record<string, any>;

const environmentSecretsStore = new EnvironmentSecretsStore();
const collectionSecurityStore = new CollectionSecurityStore();
const uiStateSnapshotStore = new UiStateSnapshotStore();

export const listEnvironments = listEnvironmentNames;

/** The environment the user last selected for this collection, shared with the classic editor. */
export const getSelectedEnvironment = (collection: CollectionRef): string | null =>
  uiStateSnapshotStore.findByPathname(collection.path)?.selectedEnvironment || null;

export function setSelectedEnvironment(collection: CollectionRef, environmentName: string | null): void {
  uiStateSnapshotStore.update({
    type: 'COLLECTION_ENVIRONMENT',
    data: { collectionPath: collection.path, environmentName: environmentName as string }
  });
  // Classic editors of the same collection follow the change.
  broadcastToAllWebviews(
    'main:hydrate-app-with-ui-state-snapshot',
    uiStateSnapshotStore.getCollectionByPathname({ pathname: collection.path })
  );
}

async function loadEnvironment(collection: CollectionRef, name: string | null): Promise<AnyRecord | null> {
  if (!name) return null;
  const content = await readOptional(environmentFile(collection, name));
  if (content === null) return null;

  const environment: AnyRecord = { ...(await parseEnvironment(content, { format: collection.format }) as AnyRecord), name };
  const variables: AnyRecord[] = environment.variables || [];
  if (variables.some((v) => v.secret)) {
    for (const secret of environmentSecretsStore.getEnvSecrets(collection.path, environment) as AnyRecord[]) {
      const variable = variables.find((v) => v.name === secret.name);
      if (variable && secret.value) {
        variable.value = parseValueByDataType(decryptStringSafe(secret.value).value, variable.dataType);
      }
    }
  }
  return environment;
}

function activeGlobalEnvironment(): AnyRecord | undefined {
  const activeUid = globalEnvironmentsStore.getActiveGlobalEnvironmentUid();
  return (globalEnvironmentsStore.getGlobalEnvironments() as AnyRecord[]).find((e) => e.uid === activeUid);
}

function activeGlobalVariables(): AnyRecord {
  const variables: AnyRecord = {};
  for (const v of (activeGlobalEnvironment()?.variables || []) as AnyRecord[]) {
    if (v.name && v.enabled !== false) variables[v.name] = v.value;
  }
  return variables;
}

interface RequestContext {
  item: AnyRecord;
  collection: AnyRecord;
  environment: AnyRecord | null;
}

/**
 * The slice of the collection tree the send pipeline needs: the collection root, each folder between
 * it and the request (so their headers, vars, scripts and auth are inherited), and the request itself
 * as it currently stands in the editor, saved or not.
 */
async function buildContext(session: RequestSession): Promise<RequestContext> {
  const { collection: ref, filePath } = session;
  if (!ref) throw new Error('This file is not inside a Bruno collection.');
  if (!session.item) throw new Error(session.error || 'This request could not be read.');
  const { format } = ref;

  const item = cloneDeep(session.item) as AnyRecord;
  hydrateRequestWithUuid(item as never, filePath);
  item.pathname = filePath;
  item.filename = basename(session.document.uri);
  item.requestUid = uuid();

  let node: AnyRecord = item;
  for (const folder of foldersBetween(ref, session.document.uri).reverse()) {
    const folderContent = await readOptional(folderRootFile(ref, folder));
    node = {
      uid: generateUidBasedOnHash(folder.fsPath),
      type: 'folder',
      name: basename(folder),
      pathname: folder.fsPath,
      root: folderContent ? await parseFolder(folderContent, { format }) : undefined,
      items: [node]
    };
  }

  const rootContent = await readOptional(collectionRootFile(ref));
  let root: AnyRecord = {};
  if (rootContent) {
    const parsed = await parseCollection(rootContent, { format }) as AnyRecord;
    root = format === 'yml' ? (parsed?.collectionRoot ?? {}) : parsed;
  }

  const collection: AnyRecord = {
    uid: generateUidBasedOnHash(ref.path),
    name: basename(ref.uri),
    pathname: ref.path,
    brunoConfig: await transformBrunoConfigAfterRead(await readBrunoConfig(ref) as never, ref.path),
    root,
    items: [node],
    globalEnvironmentVariables: activeGlobalVariables(),
    securityConfig: collectionSecurityStore.getSecurityConfigForCollection(ref.path)
  };

  return { item, collection, environment: await loadEnvironment(ref, getSelectedEnvironment(ref)) };
}

const SECRET_MASK = '•••••';

export interface ResolvedUrl {
  /** The URL with variables and path params filled in, and secret values masked. */
  url: string;
  /** Variables in the URL that nothing defines. */
  unresolved: string[];
}

/**
 * The URL as it would be sent right now: `{{variables}}` from every scope and `:path` params filled
 * in. Values of secret environment variables are masked. Returns null when there is nothing to resolve.
 */
export async function resolveUrl(session: RequestSession): Promise<ResolvedUrl | null> {
  const raw = session.item?.request?.url || '';
  const pathParams: AnyRecord[] = (session.item?.request?.params || []).filter((p) => p.type === 'path' && p.enabled);
  if (!session.collection || (!raw.includes('{{') && !pathParams.length)) return null;

  const { item, collection, environment } = await buildContext(session);
  const request = cloneDeep(item.request) as AnyRecord;
  mergeVars(collection as never, request as never, getTreePathFromCollectionToItem(collection as never, item as never));

  const scopes = {
    globalEnvironmentVariables: collection.globalEnvironmentVariables,
    collectionVariables: request.collectionVariables,
    envVars: getEnvVars(environment as never),
    folderVariables: request.folderVariables,
    requestVariables: request.requestVariables,
    runtimeVariables: getRuntimeVariables(collection.uid),
    processEnvVars: getProcessEnvVars(collection.uid)
  };
  const fill = (text: string): string => {
    try {
      return String(interpolateString(text, scopes) ?? '');
    } catch {
      return text;
    }
  };

  let url = fill(raw);
  for (const param of pathParams) {
    const value = fill(String(param.value ?? ''));
    if (value) url = url.replace(new RegExp(`:${param.name}(?=/|\\?|$)`, 'g'), value);
  }

  const secrets = [...(environment?.variables || []), ...(activeGlobalEnvironment()?.variables || [])]
    .filter((v: AnyRecord) => v.secret && typeof v.value === 'string' && v.value.length > 0)
    .map((v: AnyRecord) => v.value as string);
  for (const secret of secrets) url = url.split(secret).join(SECRET_MASK);

  const unresolved = [...new Set([...url.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1].trim()))];
  return { url, unresolved };
}

const sending = new Map<string, { cancelTokenUid?: string }>();
const sendingChanged = new vscode.EventEmitter<string>();

/** Fires with the request file path when a send starts or ends. */
export const onDidChangeSending = sendingChanged.event;
export const isSending = (filePath: string): boolean => sending.has(filePath);

export async function cancelSend(filePath: string): Promise<void> {
  const cancelTokenUid = sending.get(filePath)?.cancelTokenUid;
  if (cancelTokenUid) await handleInvoke('cancel-http-request', [cancelTokenUid]);
}

const toRows = (kind: TestRow['kind'], results: AnyRecord[] = []): TestRow[] =>
  results.map((r) => ({
    kind,
    description: kind === 'assertion'
      ? `${r.lhsExpr ?? ''} ${r.operator ?? ''} ${r.rhsExpr ?? ''}`.trim()
      : String(r.description ?? ''),
    passed: r.status ? r.status === 'pass' : !!r.passed,
    error: r.error ? String(r.error) : undefined
  }));

const RESULT_CHANNELS: Record<string, TestRow['kind']> = {
  'main:test-results': 'test',
  'main:assertion-results': 'assertion',
  'main:pre-request-test-results': 'pre-request',
  'main:post-response-test-results': 'post-response'
};

/** Sends the request as it stands in the editor and records the outcome in the store. */
export async function sendRequest(session: RequestSession): Promise<void> {
  const { filePath } = session;
  if (sending.has(filePath)) return;

  const state: { cancelTokenUid?: string } = {};
  sending.set(filePath, state);
  sendingChanged.fire(filePath);

  const tests: TestRow[] = [];
  const scriptErrors: string[] = [];
  let tap: vscode.Disposable | undefined;

  try {
    const { item, collection, environment } = await buildContext(session);

    tap = onOutboundEvent((channel, payload) => {
      const event = payload as AnyRecord;
      if (event?.requestUid !== item.requestUid) return;

      if (channel in RESULT_CHANNELS) {
        tests.push(...toRows(RESULT_CHANNELS[channel], event.results));
      } else if (channel === 'main:run-request-event') {
        if (event.cancelTokenUid) state.cancelTokenUid = event.cancelTokenUid;
        if (event.errorMessage) scriptErrors.push(`${String(event.type).replace('-script-execution', '')}: ${event.errorMessage}`);
      }
    });

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Bruno: sending ${session.name}…` },
      () => handleInvoke('send-http-request', [item, collection, environment]) as Promise<SendResult>
    );

    liteStore.record({
      filePath,
      collectionPath: collection.pathname,
      name: session.name,
      at: Date.now(),
      result,
      tests,
      scriptErrors
    });
  } catch (err) {
    void vscode.window.showErrorMessage(`Bruno: ${(err as Error).message}`);
  } finally {
    tap?.dispose();
    sending.delete(filePath);
    sendingChanged.fire(filePath);
  }
}
