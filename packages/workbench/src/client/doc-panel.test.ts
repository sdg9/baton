import { describe, expect, test } from 'vitest';
import { openDocPanelTarget, type DocPanelTarget } from './doc-panel';

describe('openDocPanelTarget', () => {
  test('replaces the active document panel target with the newly opened target', () => {
    const boardTarget: DocPanelTarget = { type: 'card', projectId: 'project-a', cardId: 'change-a' };
    const archivedTarget: DocPanelTarget = { type: 'archived', projectId: 'project-a', changeId: 'change-b' };

    expect(openDocPanelTarget(boardTarget, archivedTarget)).toEqual(archivedTarget);
  });
});
