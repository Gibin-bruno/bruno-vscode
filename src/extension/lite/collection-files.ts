/**
 * PROTOTYPE (lite request page): reading a collection's files through the VS Code workspace API,
 * so the lite editor works on any file system VS Code can open, not only the local disk.
 */
import * as vscode from 'vscode';
import { basename, dirname, doesItExist, isSameDir, readText } from '../utils/file';
import { parseCollection } from '../utils/parse';

export interface CollectionRef {
  uri: vscode.Uri;
  /** The key the host stores (selected environment, secrets, security) know this collection by. */
  path: string;
  format: 'bru' | 'yml';
}

const child = (dir: vscode.Uri, ...segments: string[]): vscode.Uri => vscode.Uri.joinPath(dir, ...segments);

/** The collection a file belongs to: the nearest ancestor folder holding a collection config. */
export async function findCollection(file: vscode.Uri): Promise<CollectionRef | null> {
  let dir = dirname(file);
  for (;;) {
    if (await doesItExist(child(dir, 'opencollection.yml'))) return { uri: dir, path: dir.fsPath, format: 'yml' };
    if (await doesItExist(child(dir, 'bruno.json'))) return { uri: dir, path: dir.fsPath, format: 'bru' };

    const parent = dirname(dir);
    if (isSameDir(parent, dir)) return null;
    dir = parent;
  }
}

export async function readOptional(uri: vscode.Uri): Promise<string | null> {
  try {
    return await readText(uri);
  } catch {
    return null;
  }
}

/** Folders between the collection root and the file, outermost first. */
export function foldersBetween(collection: CollectionRef, file: vscode.Uri): vscode.Uri[] {
  const folders: vscode.Uri[] = [];
  let dir = dirname(file);
  while (!isSameDir(dir, collection.uri)) {
    folders.unshift(dir);
    const parent = dirname(dir);
    if (isSameDir(parent, dir)) break;
    dir = parent;
  }
  return folders;
}

export const collectionRootFile = (collection: CollectionRef): vscode.Uri =>
  child(collection.uri, collection.format === 'yml' ? 'opencollection.yml' : 'collection.bru');

export const folderRootFile = (collection: CollectionRef, folder: vscode.Uri): vscode.Uri =>
  child(folder, `folder.${collection.format}`);

export const environmentFile = (collection: CollectionRef, name: string): vscode.Uri =>
  child(collection.uri, 'environments', `${name}.${collection.format}`);

export async function listEnvironmentNames(collection: CollectionRef): Promise<string[]> {
  const ext = `.${collection.format}`;
  try {
    const entries = await vscode.workspace.fs.readDirectory(child(collection.uri, 'environments'));
    return entries
      .filter(([name, type]) => type !== vscode.FileType.Directory && name.endsWith(ext))
      .map(([name]) => name.slice(0, -ext.length))
      .sort();
  } catch {
    return [];
  }
}

/** The collection's config: `bruno.json`, or the config section of `opencollection.yml`. */
export async function readBrunoConfig(collection: CollectionRef): Promise<Record<string, unknown>> {
  if (collection.format === 'yml') {
    const content = await readText(child(collection.uri, 'opencollection.yml'));
    return (await parseCollection(content, { format: 'yml' }))?.brunoConfig ?? {};
  }
  return JSON.parse(await readText(child(collection.uri, 'bruno.json')));
}

export { basename };
