import { createHash } from 'node:crypto';

export type AttentionSignal = {
  kind: 'waiting_for_confirmation' | 'idle_after_output';
  reason: string;
};

const confirmationPatterns = [
  /\bwaiting for confirmation\b/i,
  /\bwait(?:ing)? for (?:your )?(?:confirmation|approval|input|review)\b/i,
  /\bawaiting (?:your )?(?:confirmation|approval|input|review)\b/i,
  /\bplease (?:confirm|approve|review)\b/i
];

export function detectAttentionSignal(output: string, options: {
  lastOutputAt?: string;
  idleNotificationSeconds: number;
  now?: Date;
}): AttentionSignal | undefined {
  if (confirmationPatterns.some((pattern) => pattern.test(output))) {
    return { kind: 'waiting_for_confirmation', reason: 'Terminal is waiting for confirmation' };
  }

  if (!output.trim() || !options.lastOutputAt) return undefined;
  const now = options.now ?? new Date();
  const idleSeconds = Math.floor((now.getTime() - new Date(options.lastOutputAt).getTime()) / 1000);
  if (idleSeconds >= options.idleNotificationSeconds) {
    return { kind: 'idle_after_output', reason: `Terminal has been idle for ${idleSeconds}s after output` };
  }

  return undefined;
}

export function nextOutputActivity(options: {
  output: string;
  previousHash?: string;
  previousLastOutputAt?: string;
  now?: Date;
}): { outputHash: string; lastOutputAt: string; changed: boolean } {
  const outputHash = createHash('sha256').update(options.output).digest('hex');
  const changed = outputHash !== options.previousHash;
  return {
    outputHash,
    lastOutputAt: changed ? (options.now ?? new Date()).toISOString() : options.previousLastOutputAt ?? (options.now ?? new Date()).toISOString(),
    changed
  };
}
