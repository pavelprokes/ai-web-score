/** Display formatting shared by admin pages (en-US, as the UI is in English). */

const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const rtf = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
const dtf = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

export function pct(x: number | null | undefined, digits = 0): string {
  return x === null || x === undefined || Number.isNaN(x) ? "–" : `${(x * 100).toFixed(digits)} %`;
}

export function num(x: number | null | undefined): string {
  return x === null || x === undefined || Number.isNaN(x) ? "–" : nf.format(x);
}

export function usd(x: number | null | undefined): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "–";
  const digits = Math.abs(x) < 1 && x !== 0 ? 3 : 2;
  return `$${x.toFixed(digits)}`;
}

export function absoluteTime(d: Date | string | null | undefined): string {
  return d ? `${dtf.format(new Date(d))} UTC` : "never";
}

export function relativeTime(d: Date | string | null | undefined, now = new Date()): string {
  if (!d) return "never";
  const diffSec = (new Date(d).getTime() - now.getTime()) / 1000;
  const abs = Math.abs(diffSec);
  if (abs < 60) return rtf.format(Math.round(diffSec), "second");
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), "hour");
  return rtf.format(Math.round(diffSec / 86400), "day");
}
