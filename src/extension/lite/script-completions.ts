/**
 * PROTOTYPE (lite request page): Bruno's script API (`req`, `res`, `bru`) as completions in scripts and
 * tests opened in VS Code editors. Same hint list as the classic editor's autocomplete; suggestions
 * are offered one segment at a time, the way that one does (`bru.` → `cookies` → `jar()` → …).
 */
import * as vscode from 'vscode';
import { STATIC_API_HINTS } from '../../utils/script-api-hints';

const ROOTS = Object.keys(STATIC_API_HINTS) as Array<keyof typeof STATIC_API_HINTS>;
const ROOT_DETAIL: Record<string, string> = {
  req: 'Bruno: the request being sent',
  res: 'Bruno: the response received',
  bru: 'Bruno: variables, environment, runner and utilities'
};

/** `req`, `res` or `bru` followed by the member chain typed so far, e.g. `bru.cookies.jar().get`. */
const CHAIN = new RegExp(`(?:^|[^\\w$.])((?:${ROOTS.join('|')})(?:\\.[\\w$]*(?:\\([^)]*\\))?)*)$`);

/** The next segment of `hint` after `base`: up to the following dot that is not inside parentheses. */
function nextSegment(rest: string): string {
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '(') depth++;
    else if (rest[i] === ')') depth--;
    else if (rest[i] === '.' && depth === 0) return rest.slice(0, i);
  }
  return rest;
}

/** `setEnvVar(key, value)` → a snippet with a tab stop per argument; anything unusual is inserted as text. */
function toInsertText(segment: string): string | vscode.SnippetString {
  const call = /^([\w$]+)\(([\w$,\s]*)\)$/.exec(segment);
  if (!call) return segment;
  const args = call[2].split(',').map((a) => a.trim()).filter(Boolean);
  if (!args.length) return segment;
  return new vscode.SnippetString(`${call[1]}(${args.map((arg, i) => `\${${i + 1}:${arg}}`).join(', ')})`);
}

export function registerScriptCompletions(context: vscode.ExtensionContext, scheme: string): void {
  const provider: vscode.CompletionItemProvider = {
    provideCompletionItems(document, position) {
      const before = document.lineAt(position.line).text.slice(0, position.character);
      const chain = CHAIN.exec(before)?.[1];

      if (!chain || !chain.includes('.')) {
        return ROOTS.map((root) => {
          const item = new vscode.CompletionItem(root, vscode.CompletionItemKind.Variable);
          item.detail = ROOT_DETAIL[root];
          return item;
        });
      }

      const root = chain.slice(0, chain.indexOf('.')) as keyof typeof STATIC_API_HINTS;
      const base = chain.slice(0, chain.lastIndexOf('.') + 1);
      const typed = chain.slice(base.length);
      const range = new vscode.Range(position.translate(0, -typed.length), position);

      const items = new Map<string, vscode.CompletionItem>();
      for (const hint of STATIC_API_HINTS[root] || []) {
        if (!hint.startsWith(base) || hint.length === base.length) continue;
        const segment = nextSegment(hint.slice(base.length));
        if (items.has(segment)) continue;

        const isCall = segment.includes('(');
        const item = new vscode.CompletionItem(segment, isCall ? vscode.CompletionItemKind.Method : vscode.CompletionItemKind.Property);
        item.insertText = toInsertText(segment);
        item.filterText = segment;
        item.range = range;
        item.detail = `Bruno: ${base}${segment}`;
        // Ahead of word-based suggestions from the rest of the file.
        item.sortText = `0${segment}`;
        items.set(segment, item);
      }
      return [...items.values()];
    }
  };

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider({ scheme, language: 'javascript' }, provider, '.')
  );
}
