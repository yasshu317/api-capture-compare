import { diff, Diff } from 'deep-diff';

export interface DiffSummary {
  hasDiff: boolean;
  totalChanges: number;
  added: DiffEntry[];
  deleted: DiffEntry[];
  edited: DiffEntry[];
  arrayChanges: DiffEntry[];
}

export interface DiffEntry {
  path: string;
  originalValue?: unknown;
  newValue?: unknown;
  kind: string;
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'N': return 'added';
    case 'D': return 'deleted';
    case 'E': return 'edited';
    case 'A': return 'array';
    default:  return kind;
  }
}

function formatPath(change: Diff<unknown>): string {
  if (!change.path || change.path.length === 0) return '(root)';
  return change.path
    .map((p) => (typeof p === 'number' ? `[${p}]` : `.${p}`))
    .join('')
    .replace(/^\./, '');
}

export function compareResponses(original: unknown, updated: unknown): DiffSummary {
  const changes = diff(original, updated);

  if (!changes || changes.length === 0) {
    return { hasDiff: false, totalChanges: 0, added: [], deleted: [], edited: [], arrayChanges: [] };
  }

  const added: DiffEntry[] = [];
  const deleted: DiffEntry[] = [];
  const edited: DiffEntry[] = [];
  const arrayChanges: DiffEntry[] = [];

  for (const change of changes) {
    const pathStr = formatPath(change);
    const label = kindLabel(change.kind);

    const entry: DiffEntry = { path: pathStr, kind: label };

    if (change.kind === 'N') {
      entry.newValue = (change as { rhs: unknown }).rhs;
      added.push(entry);
    } else if (change.kind === 'D') {
      entry.originalValue = (change as { lhs: unknown }).lhs;
      deleted.push(entry);
    } else if (change.kind === 'E') {
      const e = change as { lhs: unknown; rhs: unknown };
      entry.originalValue = e.lhs;
      entry.newValue = e.rhs;
      edited.push(entry);
    } else if (change.kind === 'A') {
      const a = change as { index: number; item: Diff<unknown> };
      const arrayPath = `${pathStr}[${a.index}]`;
      arrayChanges.push({
        path: arrayPath,
        kind: kindLabel(a.item.kind),
        originalValue: a.item.kind === 'D' ? (a.item as { lhs: unknown }).lhs : undefined,
        newValue: a.item.kind === 'N' ? (a.item as { rhs: unknown }).rhs : undefined,
      });
    }
  }

  return {
    hasDiff: true,
    totalChanges: changes.length,
    added,
    deleted,
    edited,
    arrayChanges,
  };
}
