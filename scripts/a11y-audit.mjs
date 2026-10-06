/**
 * Accessibility audit + screenshots of admin pages (axe-core, WCAG 2.0/2.1/2.2 A+AA),
 * in light and dark colour schemes and at desktop and mobile widths.
 *
 *   pnpm dev   # sign-in is disabled in development
 *   pnpm a11y [baseUrl] [outDir] [path ...]
 */
import { chromium } from "playwright-core";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";

const [base = "http://localhost:3000", out = "a11y-report", ...paths] = process.argv.slice(2);
const targets = paths.length ? paths : ["/"];
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
let violations = 0;
for (const path of targets) {
  for (const scheme of ["light", "dark"]) {
    for (const [label, viewport] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
      const context = await browser.newContext({ viewport, colorScheme: scheme });
      const page = await context.newPage();
      await page.goto(base + path, { waitUntil: "networkidle" });
      const name = `${path.replace(/[^a-z0-9]+/gi, "_") || "root"}-${scheme}-${label}`;
      await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
      const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      for (const v of result.violations) {
        violations++;
        console.log(`✗ ${path} [${scheme}/${label}] ${v.id} (${v.impact}): ${v.help}`);
        for (const n of v.nodes.slice(0, 3)) console.log(`    ${n.target.join(" ")} — ${n.failureSummary?.split("\n")[1]?.trim() ?? ""}`);
      }
      if (result.violations.length === 0) console.log(`✓ ${path} [${scheme}/${label}] no WCAG A/AA violations`);
      await context.close();
    }
  }
}
await browser.close();
process.exit(violations ? 1 : 0);
