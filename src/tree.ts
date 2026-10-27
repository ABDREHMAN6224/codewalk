import * as vscode from 'vscode';
import { TourFile, listTours } from './model';
import { TourPlayer } from './player';

export class TourItem extends vscode.TreeItem {
  constructor(public readonly file: TourFile, playing: boolean) {
    super(file.tour.title, vscode.TreeItemCollapsibleState.Collapsed);
    const n = file.tour.steps.length;
    this.description = `${n} step${n === 1 ? '' : 's'}${playing ? ' · playing' : ''}`;
    this.tooltip = new vscode.MarkdownString(
      `**${file.tour.title}**\n\n${file.tour.description ?? ''}\n\n_${file.tour.createdBy ?? 'manual'}${file.tour.diffRef ? ' · ' + file.tour.diffRef : ''}_`
    );
    this.contextValue = 'tour';
    this.iconPath = new vscode.ThemeIcon(playing ? 'debug-start' : iconFor(file.tour.createdBy));
    this.resourceUri = file.uri;
    this.command = { command: 'codewalk.startTour', title: 'Start Walkthrough', arguments: [this] };
  }
}

export class StepItem extends vscode.TreeItem {
  constructor(public readonly file: TourFile, public readonly index: number, current: boolean) {
    const step = file.tour.steps[index];
    super(`${index + 1}. ${step.title}`, vscode.TreeItemCollapsibleState.None);
    this.description = `${step.file}:${step.line}`;
    this.tooltip = new vscode.MarkdownString(step.body);
    this.contextValue = 'step';
    this.iconPath = new vscode.ThemeIcon(current ? 'circle-filled' : 'circle-outline');
    this.command = { command: 'codewalk.startTour', title: 'Go to step', arguments: [this] };
  }
}

export type TreeNode = TourItem | StepItem;

export class TourTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private cache: TourFile[] | undefined;

  constructor(private readonly player: TourPlayer) {
    player.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this.cache = undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  async tours(): Promise<TourFile[]> {
    if (!this.cache) this.cache = await listTours();
    return this.cache;
  }

  getTreeItem(el: TreeNode): vscode.TreeItem {
    return el;
  }

  async getChildren(el?: TreeNode): Promise<TreeNode[]> {
    const active = this.player.activeTour?.uri.toString();
    if (!el) {
      return (await this.tours()).map((f) => new TourItem(f, f.uri.toString() === active));
    }
    if (el instanceof TourItem) {
      const playing = el.file.uri.toString() === active;
      return el.file.tour.steps.map((_, i) => new StepItem(el.file, i, playing && this.player.stepIndex === i));
    }
    return [];
  }
}

function iconFor(createdBy?: string): string {
  switch (createdBy) {
    case 'claude': return 'sparkle';
    case 'diff': return 'git-compare';
    case 'import': return 'cloud-download';
    default: return 'book';
  }
}
