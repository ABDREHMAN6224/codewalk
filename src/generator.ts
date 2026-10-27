import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Tour, TourFile, config, computeAnchor, newTourUri, resolveStepUri, toWorkspaceRelative, validateTour, writeTour } from './model';

export type Scope =
  | { kind: 'file'; file: string }
  | { kind: 'selection'; file: string; line: number; endLine: number }
  | { kind: 'folder'; folder: string }
  | { kind: 'workspace' }
  | { kind: 'diff'; ref: string; diff: string; files: string[] };

const output = vscode.window.createOutputChannel('CodeWalk');

/** Interactive flow: ask what to walk through, then generate. */
export async function generateInteractive(folder: vscode.WorkspaceFolder, preselected?: vscode.Uri): Promise<TourFile | undefined> {
  const editor = vscode.window.activeTextEditor;
  const items: (vscode.QuickPickItem & { scope?: () => Promise<Scope | undefined> })[] = [];

  if (preselected) {
    const rel = toWorkspaceRelative(preselected);
    if (rel !== undefined) {
      let isDir = false;
      try {
        isDir = (await vscode.workspace.fs.stat(preselected)).type === vscode.FileType.Directory;
      } catch { /* ignore */ }
      items.push({
        label: `$(${isDir ? 'folder' : 'file'}) ${rel || '(workspace root)'}`,
        description: isDir ? 'this folder' : 'this file',
        scope: async () => (isDir ? (rel ? { kind: 'folder', folder: rel } : { kind: 'workspace' }) : { kind: 'file', file: rel })
      });
    }
  }
  if (editor && !editor.selection.isEmpty) {
    const rel = toWorkspaceRelative(editor.document.uri);
    if (rel) {
      const s = editor.selection;
      items.push({
        label: `$(selection) Current selection`,
        description: `${rel}:${s.start.line + 1}-${s.end.line + 1}`,
        scope: async () => ({ kind: 'selection', file: rel, line: s.start.line + 1, endLine: s.end.line + 1 })
      });
    }
  }
  if (editor) {
    const rel = toWorkspaceRelative(editor.document.uri);
    if (rel && !items.some((i) => i.description === 'this file' && i.label.endsWith(rel))) {
      items.push({ label: `$(file) Current file`, description: rel, scope: async () => ({ kind: 'file', file: rel }) });
    }
  }
  items.push({
    label: '$(folder) Choose a folder…',
    scope: async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: folder.uri,
        openLabel: 'Walk through this folder'
      });
      if (!picked?.[0]) return undefined;
      const rel = toWorkspaceRelative(picked[0]);
      if (rel === undefined) {
        void vscode.window.showErrorMessage('Please choose a folder inside the workspace.');
        return undefined;
      }
      return rel ? { kind: 'folder', folder: rel } : { kind: 'workspace' };
    }
  });
  items.push({
    label: '$(root-folder) Whole workspace',
    description: 'Claude explores the repo and picks the important paths',
    scope: async () => ({ kind: 'workspace' })
  });
  items.push({ label: '$(git-compare) Git diff…', scope: async () => pickDiffScope(folder) });

  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'What should the walkthrough cover?' });
  if (!pick?.scope) return undefined;
  const scope = await pick.scope();
  if (!scope) return undefined;

  const focus = await vscode.window.showInputBox({
    prompt: 'Optional: what should the walkthrough focus on, and who is it for?',
    placeHolder: 'e.g. "How a request flows from the API route to the database, for a new backend dev"',
    ignoreFocusOut: true
  });
  if (focus === undefined) return undefined;

  return generate(folder, scope, focus);
}

export async function pickDiffScope(folder: vscode.WorkspaceFolder): Promise<Scope | undefined> {
  const options: (vscode.QuickPickItem & { ref: string })[] = [
    { label: 'Uncommitted changes', description: 'git diff HEAD', ref: 'HEAD' },
    { label: 'Last commit', description: 'git diff HEAD~1 HEAD', ref: 'HEAD~1 HEAD' },
    { label: 'Against main / master', description: 'git diff <base>...HEAD', ref: '__base__' },
    { label: 'Custom ref range…', ref: '__custom__' }
  ];
  const pick = await vscode.window.showQuickPick(options, { placeHolder: 'Which changes should the walkthrough explain?' });
  if (!pick) return undefined;
  let ref = pick.ref;
  if (ref === '__base__') {
    const base = (await git(folder, ['rev-parse', '--verify', '--quiet', 'main'])).ok ? 'main' : 'master';
    ref = `${base}...HEAD`;
  } else if (ref === '__custom__') {
    const v = await vscode.window.showInputBox({ prompt: 'git diff arguments', placeHolder: 'e.g. v1.2.0..HEAD  or  abc123 def456', ignoreFocusOut: true });
    if (!v) return undefined;
    ref = v;
  }
  const args = ['diff', '--no-color', '--no-ext-diff', ...ref.split(/\s+/).filter(Boolean)];
  const res = await git(folder, args);
  if (!res.ok) {
    void vscode.window.showErrorMessage(`git diff failed: ${res.err.trim() || res.out.trim()}`);
    return undefined;
  }
  if (!res.out.trim()) {
    void vscode.window.showInformationMessage('That diff is empty — nothing to walk through.');
    return undefined;
  }
  const files = await git(folder, ['diff', '--name-only', ...ref.split(/\s+/).filter(Boolean)]);
  return { kind: 'diff', ref, diff: res.out, files: files.out.split('\n').map((s) => s.trim()).filter(Boolean) };
}

/** Run Claude Code to produce a tour, save it in the tours folder, and return it. */
export async function generate(folder: vscode.WorkspaceFolder, scope: Scope, focus: string): Promise<TourFile | undefined> {
  const prompt = buildPrompt(scope, focus);
  output.appendLine(`\n=== ${new Date().toISOString()} generate (${scope.kind}) ===`);

  const raw = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'CodeWalk: Claude Code is writing the walkthrough…',
      cancellable: true
    },
    (progress, token) => runClaude(folder, prompt, progress, token)
  );
  if (raw === undefined) return undefined;

  let tour: Tour;
  try {
    tour = validateTour(extractJson(raw));
  } catch (e) {
    output.appendLine('--- could not parse Claude output ---\n' + raw);
    output.show(true);
    void vscode.window.showErrorMessage(`CodeWalk: Claude's output was not a valid walkthrough (${(e as Error).message}). See the CodeWalk output panel.`);
    return undefined;
  }

  tour.$schema = 'https://codewalk.dev/schema/tour-v1.json';
  tour.createdBy = scope.kind === 'diff' ? 'diff' : 'claude';
  tour.createdAt = new Date().toISOString();
  if (scope.kind === 'diff') tour.diffRef = scope.ref;

  const uri = await newTourUri(folder, tour.title);
  // Drop steps pointing at files that don't exist, and record anchors for the rest.
  const kept: typeof tour.steps = [];
  for (const step of tour.steps) {
    const target = resolveStepUri(uri, step);
    try {
      await vscode.workspace.fs.stat(target);
    } catch {
      output.appendLine(`dropping step "${step.title}" – file not found: ${step.file}`);
      continue;
    }
    step.anchor = await computeAnchor(target, step.line);
    kept.push(step);
  }
  if (!kept.length) {
    void vscode.window.showErrorMessage('CodeWalk: none of the generated steps pointed at real files.');
    return undefined;
  }
  tour.steps = kept;
  await writeTour(uri, tour);
  output.appendLine(`saved ${uri.fsPath} (${kept.length} steps)`);
  return { uri, tour };
}

// -----------------------------------------------------------------------------

function buildPrompt(scope: Scope, focus: string): string {
  const detail = config<'overview' | 'detailed' | 'exhaustive'>('detailLevel', 'detailed');
  const stepsHint = { overview: '6–10', detailed: '10–20', exhaustive: '20–40' }[detail];
  const depthHint = {
    overview: 'Cover only the key entry points and the big-picture flow.',
    detailed: 'Cover every important function, type, and decision; explain how the pieces connect.',
    exhaustive: 'Go block by block. Explain nearly every meaningful chunk of logic, every non-obvious line, and every design decision. Err on the side of more steps.'
  }[detail];

  let target: string;
  let exploreHint = '';
  switch (scope.kind) {
    case 'file':
      target = `the file \`${scope.file}\``;
      exploreHint = 'Read that file completely. You may read the files it imports when that helps explain it, and may include steps in those files if they are essential.';
      break;
    case 'selection':
      target = `lines ${scope.line}–${scope.endLine} of \`${scope.file}\``;
      exploreHint = 'Read the whole file for context, but keep the steps inside (or very close to) that range unless a short detour is needed to explain something it calls.';
      break;
    case 'folder':
      target = `the folder \`${scope.folder}\``;
      exploreHint = 'List the folder, read its files, and figure out the logical order a reader should visit them in (entry point first, then follow the flow).';
      break;
    case 'workspace':
      target = 'this repository';
      exploreHint = 'Explore the repo structure first (README, manifests, entry points), then follow the main execution or data flow across files. Skip generated files, vendored code, and tests unless they are the point.';
      break;
    case 'diff':
      target = `the following git diff (\`git diff ${scope.ref}\`)`;
      exploreHint =
        'Explain the CHANGES: what was changed, why it was likely changed, and how the pieces of the change fit together. ' +
        'Line numbers must refer to the CURRENT contents of the files in the working tree (the "+" side of the diff), so open each file to confirm the exact line numbers before writing a step. ' +
        'Files touched: ' + scope.files.join(', ') + '\n\n```diff\n' + truncate(scope.diff, 120_000) + '\n```';
      break;
  }

  return `You are creating an interactive, step-by-step code walkthrough (like a guided product tour, but for code) of ${target}.
${focus ? `\nThe person asking wants the walkthrough to focus on: ${focus}\n` : ''}
${exploreHint}

${depthHint} Aim for ${stepsHint} steps. Order the steps the way a good mentor would explain the code: start with the entry point or the most important concept, then follow the flow. Each step should explain WHY the code is the way it is, not merely restate what it does. Mention gotchas, invariants, and how the step connects to the previous one. Use Markdown in the body (short paragraphs, inline \`code\`, bullet lists where they help). Keep each body between 2 and 8 sentences.

Output format — this is critical. Your final message must contain exactly one fenced JSON block and nothing else that looks like JSON:

\`\`\`json
{
  "title": "Short, specific title for the walkthrough",
  "description": "One or two sentences on what the reader will learn.",
  "steps": [
    {
      "title": "Short step heading",
      "file": "path/relative/to/repo/root.ts",
      "line": 12,
      "endLine": 24,
      "body": "Markdown explanation."
    }
  ]
}
\`\`\`

Rules for steps:
- "file" is relative to the repository root, using forward slashes. Only reference files that actually exist — verify by reading them.
- "line" and "endLine" are 1-based, inclusive, and must be accurate for the file as it is right now. Highlight the smallest range that contains the thing you are explaining (usually 1–30 lines). Double-check line numbers against the file contents.
- Do not include steps for files you did not open.
- Do not modify any files. This is a read-only task.`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + `\n… (truncated ${s.length - max} characters)`;
}

/** Pull the tour JSON out of Claude's final message. */
export function extractJson(text: string): unknown {
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
  let m: RegExpExecArray | null;
  let lastErr: unknown;
  while ((m = fence.exec(text))) {
    try {
      return JSON.parse(m[1]);
    } catch (e) {
      lastErr = e;
    }
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(lastErr ? 'no parseable JSON block' : 'no JSON found');
}

/**
 * Spawns `claude -p` with read-only tools and returns the final text result.
 * Resolves undefined on cancel; rejects with a readable message on failure.
 */
async function runClaude(
  folder: vscode.WorkspaceFolder,
  prompt: string,
  progress: vscode.Progress<{ message?: string }>,
  token: vscode.CancellationToken
): Promise<string | undefined> {
  const exe = config('claudePath', 'claude');
  const model = config('claudeModel', '');
  const extra = config<string[]>('claudeExtraArgs', []);

  // Very long prompts (big diffs) go through a temp file to stay under ARG_MAX.
  let promptArg = prompt;
  let tmp: string | undefined;
  if (Buffer.byteLength(prompt) > 60_000) {
    tmp = path.join(os.tmpdir(), `codewalk-prompt-${Date.now()}.md`);
    fs.writeFileSync(tmp, prompt, 'utf8');
    promptArg = `Read the file "${tmp}" with the Read tool and follow the instructions in it exactly. That file is your task.`;
  }

  const args = ['-p', promptArg, '--output-format', 'json', '--allowedTools', 'Read,Glob,Grep,LS', ...(model ? ['--model', model] : []), ...extra];
  output.appendLine(`$ ${exe} ${args.map((a) => (a.length > 80 ? JSON.stringify(a.slice(0, 77) + '…') : a)).join(' ')}`);

  return new Promise<string | undefined>((resolve, reject) => {
    let child: cp.ChildProcess;
    try {
      child = cp.spawn(exe, args, { cwd: folder.uri.fsPath, env: withExtendedPath(process.env), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(e);
    }
    let stdout = '';
    let stderr = '';
    const started = Date.now();
    const timer = setInterval(() => {
      progress.report({ message: `reading the code… ${Math.round((Date.now() - started) / 1000)}s` });
    }, 1000);
    const cleanup = () => {
      clearInterval(timer);
      if (tmp) fs.rm(tmp, { force: true }, () => undefined);
    };

    token.onCancellationRequested(() => {
      child.kill('SIGTERM');
      cleanup();
      output.appendLine('cancelled by user');
      resolve(undefined);
    });
    child.stdout!.on('data', (d) => (stdout += d.toString()));
    child.stderr!.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      output.append(s);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      cleanup();
      if (err.code === 'ENOENT') {
        reject(new Error(`Could not find the Claude Code CLI ("${exe}"). Install it (npm i -g @anthropic-ai/claude-code) or set "codewalk.claudePath" to its full path.`));
      } else reject(err);
    });
    child.on('close', (code) => {
      cleanup();
      if (token.isCancellationRequested) return;
      if (code !== 0) {
        output.appendLine(stdout);
        output.show(true);
        return reject(new Error(`Claude Code exited with code ${code}. ${firstLine(stderr) || 'See the CodeWalk output panel.'}`));
      }
      resolve(resultText(stdout));
    });
  });
}

/** `--output-format json` wraps the answer; fall back to raw text for older CLIs. */
function resultText(stdout: string): string {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.result === 'string') return parsed.result;
      if (Array.isArray(parsed)) {
        const last = [...parsed].reverse().find((m) => m && typeof m.result === 'string');
        if (last) return last.result;
      }
    }
  } catch {
    /* not JSON – fine */
  }
  return trimmed;
}

function firstLine(s: string): string {
  return s.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
}

/** VS Code's env often lacks the user's shell PATH; add the usual CLI locations. */
function withExtendedPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = os.homedir();
  const extras = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.volta', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ];
  const sep = process.platform === 'win32' ? ';' : ':';
  const current = (env.PATH ?? env.Path ?? '').split(sep);
  const merged = [...current, ...extras.filter((p) => !current.includes(p))].filter(Boolean).join(sep);
  return { ...env, PATH: merged };
}

function git(folder: vscode.WorkspaceFolder, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    cp.execFile('git', args, { cwd: folder.uri.fsPath, maxBuffer: 64 * 1024 * 1024 }, (error, out, err) => {
      resolve({ ok: !error, out: out ?? '', err: err ?? '' });
    });
  });
}
