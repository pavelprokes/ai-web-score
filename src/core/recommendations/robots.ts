/**
 * robots.txt matching per RFC 9309 and Google's robots.txt specification
 * (developers.google.com/crawling/docs/robots-txt/robots-txt-spec, read 2026-11-13):
 *
 * - A crawler follows the groups whose user-agent product token equals its own (case-insensitive; "googlebot/1.2" and
 *   "googlebot*" both mean "googlebot"); several such groups are merged. Only when none exists does it follow the
 *   merged `*` groups. Specific and `*` groups are never combined.
 * - A rule path matches the start of the URL path (with query); `*` matches any sequence, a trailing `$` anchors the end.
 * - The longest matching rule path wins; on a tie the allow rule wins (Google: "the least restrictive rule").
 *   A rule without a path is ignored. With no matching rule, the path is allowed.
 */

export interface RobotsRule {
  allow: boolean;
  path: string;
}

export interface RobotsGroup {
  /** Product tokens, lowercased. */
  agents: string[];
  rules: RobotsRule[];
}

/** The user-agent product token of a robots.txt value: its leading run of letters, `_` and `-`, lowercased. */
export function productToken(value: string): string {
  const m = /^[A-Za-z_-]+/.exec(value.trim());
  return (m ? m[0] : value.trim()).toLowerCase();
}

export function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of text.replace(/^﻿/, "").split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value === "*" ? "*" : productToken(value));
      lastWasAgent = true;
    } else if (field === "allow" || field === "disallow") {
      lastWasAgent = false;
      if (current && value) current.rules.push({ allow: field === "allow", path: value });
    } else {
      // Sitemap, crawl-delay and unknown fields do not end a group (RFC 9309 §2.2), but they do end a run of user-agent lines.
      lastWasAgent = false;
    }
  }
  return groups;
}

/**
 * The merged rules the agent follows, or null when no group applies to it. `fallback` is the token a crawler borrows
 * when no group names it (Applebot follows Googlebot's rules, support.apple.com/en-us/119829) — tried before `*`.
 */
export function rulesFor(groups: RobotsGroup[], agent: string, fallback?: string): RobotsRule[] | null {
  for (const token of [agent, fallback].filter((t): t is string => !!t).map(productToken)) {
    const own = groups.filter((g) => g.agents.includes(token));
    if (own.length) return own.flatMap((g) => g.rules);
  }
  const star = groups.filter((g) => g.agents.includes("*"));
  return star.length ? star.flatMap((g) => g.rules) : null;
}

function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`).test(path);
}

/** Whether `path` (URL path plus query, starting with "/") may be crawled under `rules`. */
export function isAllowed(rules: RobotsRule[] | null, path: string): boolean {
  if (!rules) return true;
  let best: RobotsRule | null = null;
  for (const rule of rules) {
    if (!patternMatches(rule.path, path)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow && !best.allow)) best = rule;
  }
  return best ? best.allow : true;
}

/** Path plus query of a URL (or of a path), as robots.txt rules see it. */
export function robotsPath(urlOrPath: string): string {
  try {
    const u = new URL(urlOrPath, "https://placeholder.invalid");
    return (u.pathname || "/") + u.search;
  } catch {
    return "/";
  }
}

/** Which of `paths` the agent may not crawl. */
export function blockedPaths(robotsTxt: string, agent: string, paths: string[], fallback?: string): string[] {
  const rules = rulesFor(parseRobots(robotsTxt), agent, fallback);
  return paths.filter((p) => !isAllowed(rules, p));
}
