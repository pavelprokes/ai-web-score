/**
 * B3 (docs/meetings/2026-11-13-phases-b-c-team.md): a website finding read against what the assistants it concerns
 * actually do. A blocked agent or an ineligible page is the *likely reason* when its assistant has answered at least
 * MIN_ANSWERS searched, unbranded questions without citing the site once; it is not the reason when that assistant
 * cites the affected pages anyway. Never "the reason": the measurements show a correlation in one domain, not a cause.
 */
import { AI_AGENTS } from "./ai-agents";
import { TRACKING_PARAM } from "../scoring/sources";
import { hostOf } from "../signals/matcher";
import type { AnswerObservation, Finding } from "./diagnostics";

/** Searched, unbranded answers an assistant needs before its silence says anything (team: ≥ 20 in 28 days). */
export const MIN_ANSWERS = 20;
/** Severity of a finding its assistant contradicts by citing the affected pages. */
export const CONTRADICTED_SEVERITY = 0.2;
/** Floor of a finding that is the likely reason (robots findings and confirmed site findings only). */
export const LIKELY_SEVERITY = 0.9;

/**
 * Which assistants (provider ids) a website finding concerns. Robots findings only for agents that fetch for search
 * or grounding: a user-triggered fetcher (ChatGPT-User, Claude-User) does not explain why a site is never cited.
 */
export function providersOf(key: string): string[] {
  if (key.startsWith("robots:")) {
    const a = AI_AGENTS.find((x) => `robots:${x.agent}` === key);
    return a && (a.role === "search" || a.role === "grounding-opt-out") ? a.providers : [];
  }
  if (key.startsWith("eligibility:")) return ["google-ai-mode", "gemini-ui"];
  if (key === "content:js-only") return ["chatgpt-ui", "claude-api", "perplexity-api"];
  return [];
}

/** The pages a website finding is about ("/" means the whole site), from its evidence. */
function pagesOf(f: Finding): string[] {
  const e = f.evidence as { blockedPaths?: string[]; pages?: Record<string, string> | string[] };
  if (e.blockedPaths) return e.blockedPaths;
  if (Array.isArray(e.pages)) return e.pages;
  return e.pages ? Object.keys(e.pages) : [];
}

/** A page as both sides can compare it: path without a trailing slash, query without tracking parameters. */
export function pageKey(urlOrPath: string): string {
  try {
    const u = new URL(urlOrPath, "https://placeholder.invalid");
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
    return (u.pathname.replace(/\/+$/, "") || "/") + u.search;
  } catch {
    return urlOrPath;
  }
}

interface ProviderReading {
  answers: number;
  /** Answers citing any page of the site. */
  citing: number;
  /** Paths of the site's pages it cited. */
  paths: Set<string>;
}

/**
 * Per assistant: searched, unbranded answers, and its citations of the monitored host itself — not of other owned
 * domains or subdomains, because robots.txt and the checked pages belong to that one host.
 */
function readings(answers: AnswerObservation[], hostname: string): Map<string, ProviderReading> {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  const out = new Map<string, ProviderReading>();
  for (const a of answers) {
    if (a.branded) continue;
    if (!(a.signals.searchWasUsed || a.signals.citedUrls.length > 0)) continue;
    const r = out.get(a.providerId) ?? { answers: 0, citing: 0, paths: new Set<string>() };
    r.answers++;
    const cited = a.signals.citedUrls.filter((u) => hostOf(u) === host);
    if (cited.length) r.citing++;
    for (const u of cited) r.paths.add(pageKey(u));
    out.set(a.providerId, r);
  }
  return out;
}

/**
 * Adjusts website findings by what their assistants do: raises a robots finding or a confirmed site finding whose
 * assistant never cites the site to LIKELY_SEVERITY ("Likely reason: …"), lowers a finding to CONTRADICTED_SEVERITY
 * when every assistant it concerns (with enough answers) cites the affected pages anyway. Possible site findings only
 * get the sentence: one sighting is not enough to raise them.
 */
export function joinWithAnswers(
  findings: Finding[],
  answers: AnswerObservation[],
  ctx: { hostname: string; providerLabels?: Record<string, string> },
): Finding[] {
  const byProvider = readings(answers, ctx.hostname);
  const label = (id: string) => ctx.providerLabels?.[id] ?? id;
  return findings.map((f) => {
    const concerned = providersOf(f.key)
      .map((id) => ({ id, r: byProvider.get(id) }))
      .filter((x): x is { id: string; r: ProviderReading } => !!x.r && x.r.answers >= MIN_ANSWERS);
    if (concerned.length === 0) return f;
    const pages = pagesOf(f);
    const wholeSite = pages.includes("/") && f.key.startsWith("robots:");
    const citesAffected = (r: ProviderReading) => (wholeSite ? r.citing > 0 : pages.some((p) => r.paths.has(pageKey(p))));
    const silent = concerned.filter((x) => x.r.citing === 0);
    const contradicting = concerned.filter((x) => citesAffected(x.r));
    const state = (f.evidence as { state?: string }).state;
    // Raised only when the finding can explain silence about the whole site: a whole-site block, or a confirmed site
    // finding. A block of a few pages, or a first sighting, only gets the sentence.
    const canRaise = (f.key.startsWith("robots:") && wholeSite) || state === "confirmed";
    const causal = concerned.map((x) => ({ provider: x.id, answers: x.r.answers, citing: x.r.citing, citesAffectedPages: citesAffected(x.r) }));
    if (contradicting.length === concerned.length) {
      return {
        ...f,
        severity: Math.min(f.severity, CONTRADICTED_SEVERITY),
        detail: `${f.detail} Not what keeps the site out: ${contradicting.map((x) => label(x.id)).join(", ")} cites these pages anyway.`,
        evidence: { ...f.evidence, causal },
      };
    }
    if (silent.length > 0) {
      return {
        ...f,
        severity: canRaise ? Math.max(f.severity, LIKELY_SEVERITY) : f.severity,
        detail: `${f.detail} Likely reason: ${silent.map((x) => `${label(x.id)} has not cited the site in ${x.r.answers} searched answers`).join("; ")}.`,
        evidence: { ...f.evidence, causal },
      };
    }
    return { ...f, evidence: { ...f.evidence, causal } };
  });
}
