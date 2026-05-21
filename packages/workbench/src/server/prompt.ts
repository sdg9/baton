import { readFileSync } from 'node:fs';
import type { BoardCard } from './projects/types';

export function buildStartPrompt(templatePath: string, card: BoardCard): string {
  const template = readFileSync(templatePath, 'utf8');
  return template
    .replaceAll('{{projectName}}', card.projectName)
    .replaceAll('{{projectPath}}', card.project.path)
    .replaceAll('{{changeName}}', card.id)
    .replaceAll('{{cardTitle}}', card.title);
}
