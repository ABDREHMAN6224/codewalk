import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import {
  Tour, TourFile, computeAnchor, listTours, newTourUri, readTour, toWorkspaceRelative, validateTour, workspaceRoot, writeTour
} from './model';
import { TourPlayer } from './player';
import { StepItem, TourItem, TourTreeProvider, TreeNode } from './tree';
import { generate, generateInteractive, pickDiffScope } from './generator';
import { tourToMarkdown } from './exporter';

export function activate(context: vscode.ExtensionContext): void {
  const player = new TourPlayer();
  const tree = new TourTreeProvider(player);
  const view = vscode.window.createTreeView('codewalk.tours', { treeDataProvider: tree, showCollapseAll: true });

  // Keep the sidebar and an active tour in sync with edits to .codewalk/*.tour.json.
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.tour.json');
  const onTourFileChanged = async (uri: vscode.Uri) => {
    tree.refresh();
    if (player.activeTour?.uri.toString() === uri.toString()) {
      try {
        await player.reload({ uri, tour: await readTour(uri) });
      } catch {
        /* mid-edit, invalid JSON – ignore */
      }
    }
  };
  watcher.onDidChange(onTourFileChanged);
  watcher.onDidCreate(() => tree.refresh());
  watcher.onDidDelete(async (uri) => {
    tree.refresh();
    if (player.activeTour?.uri.toString() === uri.toString()) await player.exit();
  });

  const reg = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args) => {
        try {
          return await fn(...args);
        } catch (e) {
          void vscode.window.showErrorMessage(`CodeWalk: ${(e as Error).message ?? e}`);
        }
      })
    );

  // --- playback ---------------------------------------------------------------
  reg('codewalk.startTour', async (node?: TreeNode | vscode.Uri) => {
    if (node instanceof StepItem) return player.start(node.file, node.index);
    if (node instanceof TourItem) return player.start(node.file, 0);
    if (node instanceof vscode.Uri) return player.start({ uri: node, tour: await readTour(node) });
    const file = await pickTour(tree, 'Which walkthrough do you want to start?');
    if (file) await player.start(file, 0);
  });
  reg('codewalk.nextStep', () => player.next());
  reg('codewalk.prevStep', () => player.prev());
  reg('codewalk.exitTour', () => player.exit());
  reg('codewalk.goToStep', () => player.pickStep());
  reg('codewalk.refresh', () => tree.refresh());

  // --- generation -------------------------------------------------------------
  reg('codewalk.generate', async (uri?: vscode.Uri) => {
    const folder = needFolder(uri);
    const file = await generateInteractive(folder, uri);
    if (file) await afterGenerate(file, player, tree);
  });
  reg('codewalk.generateFromDiff', async () => {
    const folder = needFolder();
    const scope = await pickDiffScope(folder);
    if (!scope) return;
    const focus = await vscode.window.showInputBox({
      prompt: 'Optional: anything the reviewer should pay attention to?',
      placeHolder: 'e.g. "focus on the migration and the new API contract"',
      ignoreFocusOut: true
    });
    if (focus === undefined) return;
    const file = await generate(folder, scope, focus);
    if (file) await afterGenerate(file, player, tree);
  });

  // --- authoring --------------------------------------------------------------
  reg('codewalk.newTour', async () => {
    const folder = needFolder();
    const title = await vscode.window.showInputBox({ prompt: 'Walkthrough title', placeHolder: 'e.g. How authentication works', ignoreFocusOut: true });
    if (!title) return;
    const description = await vscode.window.showInputBox({ prompt: 'Short description (optional)', ignoreFocusOut: true });
    const tour: Tour = { title, description: description || undefined, createdBy: 'manual', createdAt: new Date().toISOString(), steps: [] };
    const uri = await newTourUri(folder, title);
    await writeTour(uri, tour);
    tree.refresh();
    void vscode.window.showInformationMessage(`Created "${title}". Select some code and run "CodeWalk: Add Step from Selection" (⌘⌥R) to add steps.`);
  });

  reg('codewalk.recordStep', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) throw new Error('Open a file and select the lines the step should highlight.');
    const rel = toWorkspaceRelative(editor.document.uri);
    if (rel === undefined) throw new Error('The file must be inside the workspace.');
    if (editor.document.isDirty) await editor.document.save();

    const target =
      player.activeTour ??
      (await pickTour(tree, 'Add the step to which walkthrough?', [{ label: '$(add) New walkthrough…', create: true }]));
    if (!target) return;

    const sel = editor.selection;
    const line = sel.start.line + 1;
    const endLine = Math.max(line, sel.end.line + (sel.end.character === 0 && !sel.isEmpty ? 0 : 1));
    const defaultTitle = editor.document.lineAt(sel.start.line).text.trim().slice(0, 60);
    const title = await vscode.window.showInputBox({ prompt: `Step ${target.tour.steps.length + 1} title`, value: defaultTitle, ignoreFocusOut: true });
    if (title === undefined) return;
    const body = await vscode.window.showInputBox({ prompt: 'Explanation (Markdown). You can refine it later in the JSON file.', ignoreFocusOut: true });
    if (body === undefined) return;

    const anchor = await computeAnchor(editor.document.uri, line);
    const insertAt = player.activeTour?.uri.toString() === target.uri.toString() ? player.stepIndex + 1 : target.tour.steps.length;
    target.tour.steps.splice(insertAt, 0, { title: title || `Step ${insertAt + 1}`, file: rel, line, endLine, body, anchor });
    await writeTour(target.uri, target.tour);
    tree.refresh();
    if (player.activeTour?.uri.toString() === target.uri.toString()) {
      await player.reload(target);
      await player.goTo(insertAt);
    }
  });

  reg('codewalk.editStep', async (node: StepItem) => {
    const step = node.file.tour.steps[node.index];
    const title = await vscode.window.showInputBox({ prompt: 'Step title', value: step.title, ignoreFocusOut: true });
    if (title === undefined) return;
    const body = await vscode.window.showInputBox({ prompt: 'Explanation (Markdown)', value: step.body, ignoreFocusOut: true });
    if (body === undefined) return;
    step.title = title;
    step.body = body;
    await writeTour(node.file.uri, node.file.tour);
    tree.refresh();
  });

  reg('codewalk.deleteStep', async (node: StepItem) => {
    const step = node.file.tour.steps[node.index];
    const ok = await vscode.window.showWarningMessage(`Delete step "${step.title}"?`, { modal: true }, 'Delete');
    if (ok !== 'Delete') return;
    node.file.tour.steps.splice(node.index, 1);
    await writeTour(node.file.uri, node.file.tour);
    tree.refresh();
  });

  const move = async (node: StepItem, delta: number) => {
    const steps = node.file.tour.steps;
    const j = node.index + delta;
    if (j < 0 || j >= steps.length) return;
    [steps[node.index], steps[j]] = [steps[j], steps[node.index]];
    await writeTour(node.file.uri, node.file.tour);
    tree.refresh();
  };
  reg('codewalk.moveStepUp', (node: StepItem) => move(node, -1));
  reg('codewalk.moveStepDown', (node: StepItem) => move(node, +1));

  reg('codewalk.openTourFile', async (node?: TourItem) => {
    const file = node?.file ?? (await pickTour(tree, 'Open which walkthrough file?'));
    if (file) await vscode.window.showTextDocument(file.uri);
  });

  reg('codewalk.deleteTour', async (node: TourItem) => {
    const ok = await vscode.window.showWarningMessage(`Delete walkthrough "${node.file.tour.title}"?`, { modal: true }, 'Delete');
    if (ok !== 'Delete') return;
    if (player.activeTour?.uri.toString() === node.file.uri.toString()) await player.exit();
    await vscode.workspace.fs.delete(node.file.uri, { useTrash: true });
    tree.refresh();
  });

  // --- sharing ----------------------------------------------------------------
  reg('codewalk.exportMarkdown', async (node?: TourItem) => {
    const file = node?.file ?? player.activeTour ?? (await pickTour(tree, 'Export which walkthrough?'));
    if (!file) return;
    const md = await tourToMarkdown(file);
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(file.uri.fsPath.replace(/\.tour\.json$/, '.md')),
      filters: { Markdown: ['md'] },
      saveLabel: 'Export'
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(md, 'utf8'));
    const open = await vscode.window.showInformationMessage(`Exported to ${vscode.workspace.asRelativePath(target)}`, 'Open');
    if (open) await vscode.window.showTextDocument(target);
  });

  reg('codewalk.importTour', async () => {
    const folder = needFolder();
    const source = await vscode.window.showInputBox({
      prompt: 'Path or URL of a *.tour.json file (leave empty to browse)',
      placeHolder: 'https://…/auth-flow.tour.json',
      ignoreFocusOut: true
    });
    if (source === undefined) return;
    let text: string;
    if (!source.trim()) {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Walkthrough: ['json'] }, openLabel: 'Import' });
      if (!picked?.[0]) return;
      text = Buffer.from(await vscode.workspace.fs.readFile(picked[0])).toString('utf8');
    } else if (/^https?:\/\//i.test(source.trim())) {
      text = await fetchText(source.trim());
    } else {
      text = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(source.trim()))).toString('utf8');
    }
    const tour = validateTour(JSON.parse(text));
    tour.createdBy = tour.createdBy ?? 'import';
    const uri = await newTourUri(folder, tour.title);
    await writeTour(uri, tour);
    tree.refresh();
    const start = await vscode.window.showInformationMessage(`Imported "${tour.title}" (${tour.steps.length} steps).`, 'Start');
    if (start) await player.start({ uri, tour }, 0);
  });

  context.subscriptions.push(player, view, watcher);

  // Offer to start when a workspace has exactly one tour and nothing is playing (first open only).
  void offerFirstRun(context, player);
}

export function deactivate(): void {
  /* disposables handled via context.subscriptions */
}

// -----------------------------------------------------------------------------

async function afterGenerate(file: TourFile, player: TourPlayer, tree: TourTreeProvider): Promise<void> {
  tree.refresh();
  const choice = await vscode.window.showInformationMessage(
    `Walkthrough ready: "${file.tour.title}" (${file.tour.steps.length} steps).`,
    'Start',
    'Open JSON'
  );
  if (choice === 'Start') await player.start(file, 0);
  else if (choice === 'Open JSON') await vscode.window.showTextDocument(file.uri);
}

function needFolder(hint?: vscode.Uri): vscode.WorkspaceFolder {
  const folder = (hint && vscode.workspace.getWorkspaceFolder(hint)) || workspaceRoot();
  if (!folder) throw new Error('Open a folder or workspace first.');
  return folder;
}

async function pickTour(
  tree: TourTreeProvider,
  placeHolder: string,
  extra: (vscode.QuickPickItem & { create?: boolean })[] = []
): Promise<TourFile | undefined> {
  const tours = await tree.tours();
  if (!tours.length && !extra.length) {
    void vscode.window.showInformationMessage('No walkthroughs yet. Generate one with Claude Code or create an empty one.');
    return undefined;
  }
  const items = [
    ...tours.map((f) => ({ label: `$(book) ${f.tour.title}`, description: `${f.tour.steps.length} steps`, detail: f.tour.description, file: f })),
    ...extra
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder, matchOnDetail: true });
  if (!pick) return undefined;
  if ('file' in pick && pick.file) return pick.file;
  if ('create' in pick && pick.create) {
    await vscode.commands.executeCommand('codewalk.newTour');
    const fresh = await listTours();
    tree.refresh();
    return fresh.sort((a, b) => (b.tour.createdAt ?? '').localeCompare(a.tour.createdAt ?? ''))[0];
  }
  return undefined;
}

async function offerFirstRun(context: vscode.ExtensionContext, player: TourPlayer): Promise<void> {
  const key = 'codewalk.offered:' + (vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? '');
  if (context.workspaceState.get(key)) return;
  const tours = await listTours();
  if (tours.length !== 1) return;
  await context.workspaceState.update(key, true);
  const choice = await vscode.window.showInformationMessage(`This repo has a code walkthrough: "${tours[0].tour.title}". Take it?`, 'Start', 'Later');
  if (choice === 'Start') await player.start(tours[0], 0);
}

function fetchText(url: string, redirects = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib
      .get(url, { headers: { 'user-agent': 'codewalk-vscode' } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          return resolve(fetchText(new URL(res.headers.location, url).toString(), redirects - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}
