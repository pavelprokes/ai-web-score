import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Every admin page checks the session itself: the layout's check does not stop a page from rendering. */
describe("admin pages", () => {
  const root = join(process.cwd(), "src/app/(admin)");
  const pages = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith("page.tsx"));

  it("finds the pages", () => expect(pages.length).toBeGreaterThanOrEqual(5));

  it("has no page or route outside (admin), login and api", () => {
    const app = join(process.cwd(), "src/app");
    const others = (readdirSync(app, { recursive: true }) as string[])
      .filter((f) => /(^|\/)(page|route)\.\w+$/.test(f))
      .filter((f) => !f.startsWith("(admin)/") && !f.startsWith("api/") && f !== "login/page.tsx");
    expect(others).toEqual([]);
  });

  it.each(pages)("%s calls requireAdminPage first in the page and in generateMetadata", (file) => {
    const src = readFileSync(join(root, file), "utf8");
    // First statement of each entry point: the body opens at the first ") {" or "> {" after the signature starts.
    const entries = [...src.matchAll(/export (default )?async function (\w+)[\s\S]*?[)>] \{\n\s*(.*)\n/g)]
      .filter((m) => m[1] || m[2] === "generateMetadata")
      .map((m) => ["", m[2], m[3]]);
    expect(src).toMatch(/export default async function/);
    expect(entries.length).toBe(src.includes("generateMetadata") ? 2 : 1);
    for (const m of entries) expect(`${m[1]}: ${m[2]}`).toBe(`${m[1]}: await requireAdminPage();`);
  });
});
