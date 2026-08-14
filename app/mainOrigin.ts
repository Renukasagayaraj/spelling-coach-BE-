const DESCRIPTIVE_ORIGIN =
  /^(?:unknown\b|brand\s*name\b|named\s+after\b|eponyms?\b|proper\s+(?:name|noun)\b|invented\s+by\b|mathematics\b|fictional\b|from\b|modern\s+scientific\b)/i;

const NON_LANGUAGE_LABEL =
  /^(?:abbreviation|acronym|blend|borrowed|brand\s*name|coined|compound|eponyms?|fictional|invented|loanword|misspelling|modern\s+scientific|place[-_\s]?name|proper[-_\s]?(?:name|noun)(?:[-_\s]?origin)?|shortening|unknown(?:\s+origin)?)$/i;

function normalizedWords(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function languageCandidate(label: string): string | null {
  const trimmed = label.trim();
  if (!trimmed || NON_LANGUAGE_LABEL.test(trimmed)) return null;

  const candidate = trimmed
    .replace(/[_-]+/g, " ")
    .replace(/\s+(?:origin|root|suffix)$/i, "")
    .trim();
  return candidate && !NON_LANGUAGE_LABEL.test(candidate) ? candidate : null;
}

/**
 * Finds the first language mentioned in the raw etymology from its labels.
 * Labels such as "loanword" and "abbreviation" are metadata, not origins.
 */
export function deriveMainOrigin(
  origin: string | null | undefined,
  originLabels: readonly string[] | null | undefined,
): string {
  const rawOrigin = origin?.trim();
  if (!rawOrigin || DESCRIPTIVE_ORIGIN.test(rawOrigin)) return "Unknown";

  const normalizedOrigin = normalizedWords(rawOrigin);
  const matches = (originLabels ?? [])
    .map((label, labelIndex) => {
      const candidate = languageCandidate(label);
      if (!candidate) return null;

      const originIndex = normalizedOrigin.indexOf(normalizedWords(candidate));
      return originIndex < 0 ? null : { candidate, originIndex, labelIndex };
    })
    .filter((match): match is NonNullable<typeof match> => match !== null)
    .sort((a, b) => a.originIndex - b.originIndex || a.labelIndex - b.labelIndex);

  if (matches[0]) return matches[0].candidate;

  // A one-part raw origin (for example, "Latin") is already suitable for grouping.
  return /[,+/()]|\b(?:via|from|and)\b/i.test(rawOrigin) ? "Unknown" : rawOrigin;
}
