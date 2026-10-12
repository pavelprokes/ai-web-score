const NAMES = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });

let byName: Map<string, string> | undefined;

/** "english" → "en", built once from every two-letter code ICU can name. */
function codeForName(name: string): string | undefined {
  if (!byName) {
    byName = new Map();
    for (let a = 97; a <= 122; a++) {
      for (let b = 97; b <= 122; b++) {
        const code = String.fromCharCode(a, b);
        const label = NAMES.of(code);
        if (label) byName.set(label.toLowerCase(), code);
      }
    }
  }
  return byName.get(name.toLowerCase());
}

/**
 * ISO 639-1 code for a language as LLMs write it: "en-AU", "en_au", "EN", "eng" or "English"
 * all give "en". Undefined when no two-letter code fits.
 */
export function isoLanguage(value: string | undefined | null): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  let code: string | undefined;
  try {
    code = new Intl.Locale(v.replace(/_/g, "-")).language;
  } catch {
    // Not a language tag; may be a name.
  }
  if (code?.length === 2 && NAMES.of(code)) return code;
  return codeForName(v);
}
