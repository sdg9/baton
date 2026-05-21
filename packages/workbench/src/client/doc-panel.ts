export type DocPanelTarget =
  | { type: 'card'; projectId: string; cardId: string }
  | { type: 'archived'; projectId: string; changeId: string }
  | { type: 'draft'; projectId: string; changeId: string };

export function openDocPanelTarget(_current: DocPanelTarget | null, next: DocPanelTarget): DocPanelTarget {
  return next;
}
