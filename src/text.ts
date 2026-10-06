/**
 * Fold Vietnamese text for search: lowercase, strip diacritics, and map đ to d.
 * Unicode decomposition does not split đ, so it needs its own rule; without it
 * "Đường" would never match a search for "duong".
 */
export function foldVietnamese(text: string): string {
  return text.toLowerCase().replace(/đ/g, "d").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Turn free text into a safe FTS5 query: every word becomes a quoted prefix
 * term, so punctuation in user input cannot break the query syntax and
 * "thiet lap" still finds "Thiết lập mã PIN". `all` requires every word;
 * `any` ranks by how many match, for finding similar tickets.
 */
export function toFtsQuery(text: string, mode: "all" | "any" = "all"): string {
  return searchTerms(text)
    .map((term) => `"${term}"*`)
    .join(mode === "all" ? " " : " OR ");
}

/** The folded words of a search, as the index compares them. */
export function searchTerms(text: string): string[] {
  return foldVietnamese(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 0);
}

const REDACTIONS: Array<[RegExp, string]> = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
  [/(https?:\/\/)[^\s:@/]+:[^\s@/]+@/g, "$1[credentials]@"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[jwt]"],
  [/\b(?:sk|ghp|gho|glpat|xox[bpras])[-_][A-Za-z0-9_-]{16,}/g, "[secret]"],
  // Vietnamese phone numbers: 0xxxxxxxxx or +84xxxxxxxxx, optionally spaced.
  [/(?:\+84|\b0)(?:[\s.-]?\d){9}\b/g, "[phone]"],
  // Citizen ID (CCCD, 12 digits) and the older ID card (CMND, 9 digits).
  [/\b\d{12}\b/g, "[id-number]"],
  [/\b\d{9}\b/g, "[id-number]"]
];

/**
 * Remove personal data before anything is stored. This is health software:
 * bug reports and comments can carry a patient's phone number or ID, and the
 * index is read by AI tools. Redaction is deliberately conservative — a long
 * bare number is masked even if it was harmless.
 */
export function redact(text: string): string {
  let result = text;
  for (const [pattern, replacement] of REDACTIONS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Cut text into parts of at most `size` characters, at a line break where
 * one is near, so a long page can be read a part at a time.
 */
export function splitText(text: string, size: number): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > size) {
    const lineEnd = rest.lastIndexOf("\n", size);
    const cut = lineEnd > size / 2 ? lineEnd : size;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  parts.push(rest);
  return parts;
}

/**
 * Lines one text has and the other lacks, compared as trimmed lines and
 * counting repeats. Order within a text is ignored: for a spec, "which rules
 * appeared or went away" is the useful answer, and it stays short when a
 * paragraph merely moved.
 */
export function lineDiff(before: string, after: string): { added: string[]; removed: string[] } {
  const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);
  const counts = (list: string[]) => list.reduce((map, line) => map.set(line, (map.get(line) ?? 0) + 1), new Map<string, number>());
  const unmatched = (list: string[], other: Map<string, number>) =>
    list.filter((line) => {
      const left = other.get(line) ?? 0;
      if (left === 0) return true;
      other.set(line, left - 1);
      return false;
    });
  const old = lines(before);
  const current = lines(after);
  return { added: unmatched(current, counts(old)), removed: unmatched(old, counts(current)) };
}

/** Shorten text for compact AI context, marking the cut. */
export function truncate(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars).trimEnd()} …`;
}
