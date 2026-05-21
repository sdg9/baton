import { readFileSync } from "node:fs";

export interface EscalationViolation {
  attempt: unknown;
  model: unknown;
  reason: string;
}

export interface EscalationReport {
  attempts: number;
  implementEvents: number;
  violations: EscalationViolation[];
  passed: boolean;
}

export function verifyEscalation(logPath: string): EscalationReport {
  let raw = "";
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    // File unreadable — treat as empty log
    raw = "";
  }

  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  const violations: EscalationViolation[] = [];
  let implementEvents = 0;
  let maxAttempt = 0;

  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Malformed line — skip
      continue;
    }

    if (event.phase !== "implement") {
      continue;
    }

    implementEvents++;

    const attempt = event.attempt;
    const model = event.model;

    // Track max attempt for the attempts metric
    if (typeof attempt === "number" && attempt > maxAttempt) {
      maxAttempt = attempt;
    }

    // Validate attempt field is a number
    if (typeof attempt !== "number") {
      violations.push({
        attempt,
        model,
        reason: `attempt field not a number (got ${JSON.stringify(attempt)})`,
      });
      continue;
    }

    // Only attempt >= 2 must use opus
    if (attempt >= 2) {
      if (typeof model !== "string" || model !== "opus") {
        const actualModel = typeof model === "string" ? model : "missing model";
        violations.push({
          attempt,
          model,
          reason: `attempt >= 2 requires model "opus" but got "${actualModel}" (attempt ${attempt})`,
        });
      }
    }
  }

  return {
    attempts: maxAttempt,
    implementEvents,
    violations,
    passed: violations.length === 0,
  };
}
