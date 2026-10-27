import * as vscode from 'vscode';
import * as path from 'path';

/** One stop on a walkthrough. Lines are 1-based and inclusive. */
export interface TourStep {
  /** Short heading shown in bold at the top of the bubble. */
  title: string;
  /** Workspace-relative path (forward slashes). */
  file: string;
  line: number;
  endLine?: number;
  /** Markdown body. */
  body: string;
  /**
   * Text of the first highlighted line at authoring time. Used to re-locate the
   * step if the file has been edited and the line numbers drifted.
   */
  anchor?: string;
}

export interface Tour {
  $schema?: string;
  title: string;
  description?: string;
  /** "claude" | "manual" | "diff" | "import" */
  createdBy?: string;
  createdAt?: string;
  /** For diff tours: the git ref range that was walked through. */
  diffRef?: string;
  steps: TourStep[];
}

export interface TourFile {
  uri: vscode.Uri;
  tour: Tour;
}

export const TOUR_SUFFIX = '.tour.json';

export function config<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('codewalk').get<T>(key, fallback);
}

export function workspaceRoot(): vscode.WorkspaceFolder | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    const f = vscode.workspace.getWorkspaceFolder(active);
    if (f) return f;
  }
  return vscode.workspace.workspaceFolders?.[0];
}

export function toursDir(folder: vscode.WorkspaceFolder): vscode.Uri {
  return vscode.Uri.joinPath(folder.uri, config('toursDirectory', '.codewalk'));
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'walkthrough';
}

export function toWorkspaceRelative(uri: vscode.Uri): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return undefined;
  return path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
}

export function resolveStepUri(tourUri: vscode.Uri, step: TourStep): vscode.Uri {
  const folder = vscode.workspace.getWorkspaceFolder(tourUri) ?? vscode.workspace.workspaceFolders?.[0];
  const base = folder ? folder.uri : vscode.Uri.file(path.dirname(tourUri.fsPath));
  return vscode.Uri.joinPath(base, ...step.file.split('/'));
}

/** Minimal structural validation; throws a readable error on failure. */
export function validateTour(data: unknown): Tour {
  if (!data || typeof data !== 'object') throw new Error('Tour must be a JSON object');
  const t = data as Partial<Tour>;
  if (typeof t.title !== 'string' || !t.title.trim()) throw new Error('Tour needs a "title"');
  if (!Array.isArray(t.steps) || t.steps.length === 0) throw new Error('Tour needs a non-empty "steps" array');
  t.steps.forEach((s, i) => {
    const where = `step ${i + 1}`;
    if (!s || typeof s !== 'object') throw new Error(`${where}: not an object`);
    if (typeof s.file !== 'string' || !s.file) throw new Error(`${where}: missing "file"`);
    if (typeof s.line !== 'number' || s.line < 1) throw new Error(`${where}: "line" must be a positive number`);
    if (s.endLine !== undefined && (typeof s.endLine !== 'number' || s.endLine < s.line)) {
      s.endLine = s.line;
    }
    if (typeof s.title !== 'string') s.title = `Step ${i + 1}`;
    if (typeof s.body !== 'string') s.body = '';
    s.file = s.file.replace(/\\/g, '/').replace(/^\.\//, '');
  });
  return t as Tour;
}

export async function listTours(): Promise<TourFile[]> {
  const result: TourFile[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const dir = toursDir(folder);
    let entries: [string, vscode.FileType][] = [];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      continue;
    }
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.endsWith(TOUR_SUFFIX)) continue;
      const uri = vscode.Uri.joinPath(dir, name);
      try {
        result.push({ uri, tour: await readTour(uri) });
      } catch (e) {
        console.warn(`[codewalk] skipping ${uri.fsPath}: ${(e as Error).message}`);
      }
    }
  }
  result.sort((a, b) => a.tour.title.localeCompare(b.tour.title));
  return result;
}

export async function readTour(uri: vscode.Uri): Promise<Tour> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return validateTour(JSON.parse(Buffer.from(bytes).toString('utf8')));
}

export async function writeTour(uri: vscode.Uri, tour: Tour): Promise<void> {
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
  const json = JSON.stringify(tour, null, 2) + '\n';
  await vscode.workspace.fs.writeFile(uri, Buffer.from(json, 'utf8'));
}

/** Pick a non-colliding file URI for a new tour in the given workspace folder. */
export async function newTourUri(folder: vscode.WorkspaceFolder, title: string): Promise<vscode.Uri> {
  const dir = toursDir(folder);
  const base = slugify(title);
  let candidate = vscode.Uri.joinPath(dir, base + TOUR_SUFFIX);
  for (let i = 2; ; i++) {
    try {
      await vscode.workspace.fs.stat(candidate);
      candidate = vscode.Uri.joinPath(dir, `${base}-${i}${TOUR_SUFFIX}`);
    } catch {
      return candidate;
    }
  }
}

/** Capture the first line's text so the step can be re-anchored after edits. */
export async function computeAnchor(uri: vscode.Uri, line: number): Promise<string | undefined> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    if (line - 1 < doc.lineCount) return doc.lineAt(line - 1).text.trim() || undefined;
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * If the line at `step.line` no longer matches `step.anchor`, look for the anchor
 * within ±200 lines and return the corrected 1-based line. Falls back to the
 * original line.
 */
export function reanchor(doc: vscode.TextDocument, step: TourStep): number {
  if (!step.anchor) return step.line;
  const idx = step.line - 1;
  const matches = (i: number) => i >= 0 && i < doc.lineCount && doc.lineAt(i).text.trim() === step.anchor;
  if (matches(idx)) return step.line;
  for (let d = 1; d <= 200; d++) {
    if (matches(idx - d)) return idx - d + 1;
    if (matches(idx + d)) return idx + d + 1;
  }
  return step.line;
}
