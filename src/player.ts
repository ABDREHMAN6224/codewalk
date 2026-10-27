import * as vscode from 'vscode';
import { Tour, TourFile, TourStep, config, reanchor, resolveStepUri } from './model';

/**
 * Plays a tour: opens each step's file, spotlights the lines, and shows an
 * inline bubble (a VS Code comment thread) with the step text and
 * Prev / Next / Exit buttons.
 */
export class TourPlayer implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private thread: vscode.CommentThread | undefined;
  private highlight: vscode.TextEditorDecorationType;
  private dim: vscode.TextEditorDecorationType;
  private readonly status: vscode.StatusBarItem;
  private current: { file: TourFile; index: number } | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor() {
    this.controller = vscode.comments.createCommentController('codewalk', 'CodeWalk');
    this.controller.options = { placeHolder: '', prompt: '' };
    // The bubble is read-only: nobody can add comments to it.
    this.controller.commentingRangeProvider = { provideCommentingRanges: () => [] };

    this.highlight = this.makeHighlight();
    this.dim = this.makeDim();

    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.status.command = 'codewalk.goToStep';

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('codewalk.highlightColor') || e.affectsConfiguration('codewalk.dimOtherCode')) {
          this.highlight.dispose();
          this.dim.dispose();
          this.highlight = this.makeHighlight();
          this.dim = this.makeDim();
          if (this.current) void this.show();
        }
      }),
      // Re-apply decorations when the step's editor becomes visible again.
      vscode.window.onDidChangeVisibleTextEditors(() => {
        if (this.current) void this.applyDecorations();
      })
    );
  }

  get isActive(): boolean {
    return !!this.current;
  }

  get activeTour(): TourFile | undefined {
    return this.current?.file;
  }

  get stepIndex(): number {
    return this.current?.index ?? -1;
  }

  async start(file: TourFile, index = 0): Promise<void> {
    if (!file.tour.steps.length) {
      void vscode.window.showWarningMessage(`"${file.tour.title}" has no steps yet.`);
      return;
    }
    this.current = { file, index: clamp(index, 0, file.tour.steps.length - 1) };
    await vscode.commands.executeCommand('setContext', 'codewalk.active', true);
    await this.show();
  }

  /** Called when a tour file changed on disk; reloads the current step. */
  async reload(file: TourFile): Promise<void> {
    if (!this.current || this.current.file.uri.toString() !== file.uri.toString()) return;
    if (!file.tour.steps.length) return this.exit();
    this.current = { file, index: clamp(this.current.index, 0, file.tour.steps.length - 1) };
    await this.show();
  }

  async next(): Promise<void> {
    if (!this.current) return;
    const { file, index } = this.current;
    if (index >= file.tour.steps.length - 1) {
      const choice = await vscode.window.showInformationMessage(
        `You've reached the end of "${file.tour.title}".`,
        'Restart',
        'Exit'
      );
      if (choice === 'Restart') return this.goTo(0);
      return this.exit();
    }
    await this.goTo(index + 1);
  }

  async prev(): Promise<void> {
    if (!this.current) return;
    await this.goTo(Math.max(0, this.current.index - 1));
  }

  async goTo(index: number): Promise<void> {
    if (!this.current) return;
    this.current.index = clamp(index, 0, this.current.file.tour.steps.length - 1);
    await this.show();
  }

  async pickStep(): Promise<void> {
    if (!this.current) return;
    const { file, index } = this.current;
    const items = file.tour.steps.map((s, i) => ({
      label: `${i + 1}. ${s.title}`,
      description: `${s.file}:${s.line}`,
      picked: i === index,
      index: i
    }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Jump to step', matchOnDescription: true });
    if (pick) await this.goTo(pick.index);
  }

  async exit(): Promise<void> {
    this.clearDecorations();
    this.thread?.dispose();
    this.thread = undefined;
    this.current = undefined;
    this.status.hide();
    await vscode.commands.executeCommand('setContext', 'codewalk.active', false);
    this._onDidChange.fire();
  }

  // ---------------------------------------------------------------------------

  private async show(): Promise<void> {
    if (!this.current) return;
    const { file, index } = this.current;
    const tour = file.tour;
    const step = tour.steps[index];
    const uri = resolveStepUri(file.uri, step);

    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      const choice = await vscode.window.showErrorMessage(
        `Step ${index + 1}: file not found: ${step.file}`,
        'Skip',
        'Exit'
      );
      if (choice === 'Skip' && index < tour.steps.length - 1) return this.goTo(index + 1);
      return this.exit();
    }

    const startLine = clamp(reanchor(doc, step), 1, doc.lineCount);
    const span = (step.endLine ?? step.line) - step.line;
    const endLine = clamp(startLine + span, startLine, doc.lineCount);
    const range = new vscode.Range(startLine - 1, 0, endLine - 1, doc.lineAt(endLine - 1).text.length);

    const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false, preview: false });
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

    // Rebuild the bubble. Disposing and re-creating is the reliable way to move it.
    this.thread?.dispose();
    const thread = this.controller.createCommentThread(uri, new vscode.Range(endLine - 1, 0, endLine - 1, 0), []);
    thread.label = `${tour.title} · step ${index + 1} of ${tour.steps.length}`;
    thread.canReply = false;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.state = vscode.CommentThreadState.Unresolved;
    thread.comments = [
      {
        author: { name: step.title || `Step ${index + 1}` },
        mode: vscode.CommentMode.Preview,
        body: this.renderBody(step, index, tour),
        label: `${step.file}:${startLine}${endLine !== startLine ? '-' + endLine : ''}`
      }
    ];
    this.thread = thread;

    await this.applyDecorations();

    this.status.text = `$(book) ${index + 1}/${tour.steps.length} · ${step.title}`;
    this.status.tooltip = new vscode.MarkdownString(
      `**${tour.title}**\n\nClick to jump to a step · ⌘⌥→ next · ⌘⌥← back · ⌘⌥Esc exit`
    );
    this.status.show();
    this._onDidChange.fire();
  }

  private renderBody(step: TourStep, index: number, tour: Tour): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.supportHtml = true;
    md.appendMarkdown(step.body.trim() || '_(no description)_');
    md.appendMarkdown('\n\n---\n');
    const parts: string[] = [];
    if (index > 0) parts.push(`[$(arrow-left) Back](command:codewalk.prevStep "Previous step")`);
    parts.push(`**${index + 1} / ${tour.steps.length}**`);
    if (index < tour.steps.length - 1) parts.push(`[Next $(arrow-right)](command:codewalk.nextStep "Next step")`);
    else parts.push(`[Finish $(check)](command:codewalk.exitTour "Finish walkthrough")`);
    md.appendMarkdown(parts.join(' &nbsp;·&nbsp; '));
    return md;
  }

  private async applyDecorations(): Promise<void> {
    if (!this.current || !this.thread) return;
    const step = this.current.file.tour.steps[this.current.index];
    const uri = resolveStepUri(this.current.file.uri, step);
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() !== uri.toString()) {
        editor.setDecorations(this.highlight, []);
        editor.setDecorations(this.dim, []);
        continue;
      }
      const doc = editor.document;
      const start = clamp(reanchor(doc, step), 1, doc.lineCount);
      const end = clamp(start + ((step.endLine ?? step.line) - step.line), start, doc.lineCount);
      const range = new vscode.Range(start - 1, 0, end - 1, doc.lineAt(end - 1).text.length);
      editor.setDecorations(this.highlight, [range]);
      if (config('dimOtherCode', true)) {
        const dimRanges: vscode.Range[] = [];
        if (start > 1) dimRanges.push(new vscode.Range(0, 0, start - 2, doc.lineAt(start - 2).text.length));
        if (end < doc.lineCount) dimRanges.push(new vscode.Range(end, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length));
        editor.setDecorations(this.dim, dimRanges);
      } else {
        editor.setDecorations(this.dim, []);
      }
    }
  }

  private clearDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.highlight, []);
      editor.setDecorations(this.dim, []);
    }
  }

  private makeHighlight(): vscode.TextEditorDecorationType {
    return vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: config('highlightColor', 'rgba(255, 200, 0, 0.18)'),
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: new vscode.ThemeColor('editorInfo.foreground'),
      overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'),
      overviewRulerLane: vscode.OverviewRulerLane.Full,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    });
  }

  private makeDim(): vscode.TextEditorDecorationType {
    return vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      opacity: '0.45'
    });
  }

  dispose(): void {
    void this.exit();
    this.controller.dispose();
    this.highlight.dispose();
    this.dim.dispose();
    this.status.dispose();
    this._onDidChange.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
