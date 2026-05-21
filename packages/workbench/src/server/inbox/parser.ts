export type InboxEntry = {
  source_file: string;
  section: string;
  size_class: string;
  date: string;
  slug: string;
  title: string;
  status: string;
  size: string;
  source: string;
  gating: string;
  scope: string;
  reason: string;
  notes: string;
  priority: string;
  priority_rank: number;
  line: number;
};

const SIZE_TOKEN = /\b(XXL|XL|XS|M|L|S)\b/;
const ISO_DATE = /\b(20\d{2}-\d{2}-\d{2})\b/;
const PRIORITY_TOKEN = /\b(P[0-3])\b/;
const STANDALONE_PRIORITY = /^\s*\*\*Priority:\*\*\s*(.+?)\s*$/;
const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

function rankForPriority(priority: string): number {
  if (!priority) return 99;
  const m = priority.match(PRIORITY_TOKEN);
  return m ? (PRIORITY_RANK[m[1]] ?? 99) : 50;
}

function emptyEntry(file: string, section: string, line: number): InboxEntry {
  return {
    source_file: file,
    section,
    size_class: "",
    date: "",
    slug: "",
    title: "",
    status: "",
    size: "",
    source: "",
    gating: "",
    scope: "",
    reason: "",
    notes: "",
    priority: "",
    priority_rank: 99,
    line,
  };
}

function splitTitle(title: string): { slug: string; short: string } {
  const colonIdx = title.indexOf(":");
  if (colonIdx > 0 && colonIdx < 80) {
    return {
      slug: title.slice(0, colonIdx).trim(),
      short: title.slice(colonIdx + 1).trim(),
    };
  }
  return { slug: "", short: title };
}

function setField(e: InboxEntry, key: string, val: string): void {
  switch (key) {
    case "source":
      e.source = val;
      break;
    case "scope":
      e.scope = val;
      break;
    case "gating":
    case "gating_event":
    case "when_to_revisit":
      e.gating = val;
      break;
    case "size":
    case "size_hint":
      e.size = val;
      break;
    case "reason":
      e.reason = val;
      break;
    case "original_source":
      if (!e.source) e.source = val;
      break;
    case "status":
      e.status = val;
      break;
    case "priority":
      e.priority = val;
      break;
    case "action":
    case "why_now_matters":
    case "why_deferred":
      e.notes = e.notes ? `${e.notes} | ${val}` : val;
      break;
    default:
      // unrecognized field: fold into notes for visibility
      e.notes = e.notes ? `${e.notes} | ${key}: ${val}` : `${key}: ${val}`;
  }
}

function parseBody(e: InboxEntry, body: string): void {
  const lines = body.split("\n");
  let curField: string | null = null;
  let curVal: string[] = [];

  const flush = (): void => {
    if (curField === null) return;
    const val = curVal.join(" ").replace(/\s+/g, " ").trim();
    const k = curField.toLowerCase().replace(/\s+/g, "_");
    setField(e, k, val);
  };

  for (const line of lines) {
    const standalonePriority = line.match(STANDALONE_PRIORITY);
    if (standalonePriority && !e.priority) {
      flush();
      curField = null;
      e.priority = standalonePriority[1].trim();
      continue;
    }
    const m = line.match(/^- \*\*(.+?):\*\*\s*(.*)$/);
    if (m) {
      flush();
      curField = m[1];
      curVal = [m[2]];
    } else if (curField !== null) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("###") || trimmed.startsWith("##")) continue;
      curVal.push(trimmed);
    }
  }
  flush();

  const sizeMatch = `${e.size} ${e.title}`.match(SIZE_TOKEN);
  if (sizeMatch) e.size_class = sizeMatch[1];

  const allText = `${e.source} ${e.scope} ${e.gating} ${e.reason} ${e.size} ${e.notes}`;
  const dateMatch = allText.match(ISO_DATE);
  if (dateMatch) e.date = dateMatch[1];

  e.priority_rank = rankForPriority(e.priority);
}

export function parseInbox(label: string, contents: string): InboxEntry[] {
  const lines = contents.split("\n");
  const entries: InboxEntry[] = [];
  let currentSection = "";
  let currentEntry: InboxEntry | null = null;
  let currentBody = "";

  const finalize = (): void => {
    if (!currentEntry) return;
    parseBody(currentEntry, currentBody);
    entries.push(currentEntry);
    currentEntry = null;
    currentBody = "";
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("## ")) {
      finalize();
      currentSection = line.slice(3).trim();
      continue;
    }

    if (line.startsWith("### ")) {
      finalize();
      const title = line.slice(4).trim();
      currentEntry = emptyEntry(label, currentSection, i + 1);
      const split = splitTitle(title);
      currentEntry.slug = split.slug;
      currentEntry.title = split.short;
      continue;
    }

    if (currentSection.startsWith("Migrated from ROADMAP")) {
      const rm = line.match(/^- \*\*\[(.)\]\s*(.+?)\*\*\s*[—-]?\s*(.*)$/);
      if (rm) {
        finalize();
        const e = emptyEntry(label, currentSection, i + 1);
        e.status = rm[1];
        const split = splitTitle(rm[2]);
        e.slug = split.slug || rm[2];
        e.title = split.short;
        e.scope = rm[3];
        const sm = e.scope.match(SIZE_TOKEN);
        if (sm) e.size_class = sm[1];
        const dm = e.scope.match(ISO_DATE);
        if (dm) e.date = dm[1];
        entries.push(e);
        continue;
      }
    }

    if (
      label === "BACKLOG" &&
      currentSection === "" &&
      line.startsWith("- ") &&
      !line.startsWith("- **")
    ) {
      const m = line.slice(2).match(/^([A-Za-z0-9_-]+:[A-Za-z0-9_-]+)\s*[-—]\s*(.*)$/);
      if (m) {
        const e = emptyEntry(label, "", i + 1);
        const split = splitTitle(m[1]);
        e.slug = split.slug;
        e.title = split.short;
        e.scope = m[2];
        entries.push(e);
        continue;
      }
    }

    if (currentEntry) {
      currentBody += `${line}\n`;
    }
  }

  finalize();
  return entries;
}
