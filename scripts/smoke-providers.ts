/**
 * Provider smoke test — one real request per provider whose API keys are set, no database needed.
 * Verifies credentials, request/response formats and market support before a pilot.
 * Costs a few cents (DataForSEO live endpoint ≈ $0.004/answer, Claude/OpenAI/Perplexity ≈ $0.01–0.05).
 *
 *   pnpm smoke                                   # all providers with keys
 *   pnpm smoke chatgpt-ui claude-api             # only these
 *   pnpm smoke --prompt "…" --country CZ --lang cs --location Praha
 *   pnpm smoke --llm                             # also test the internal LLM (structured output)
 */
import { z } from "zod";
import { listProviders, missingEnv } from "@/core/measurement/providers";
import type { ProviderAdapter } from "@/core/measurement/provider";
import { computeCost, selectPrice, type PriceEntry } from "@/core/pricing/cost";
import { generateStructured, INTERNAL_MODEL, ANALYZER_MODEL } from "@/lib/llm";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));

const req = {
  measurementId: `smoke${Date.now()}`,
  promptText: flag("prompt", "Hledám dobrého svatebního fotografa v Praze na svatbu příští léto, koho byste doporučili?"),
  country: flag("country", "CZ"),
  language: flag("lang", "cs"),
  location: flag("location", "Praha"),
};

function priceFor(p: ProviderAdapter, model: string): PriceEntry | null {
  const entries: PriceEntry[] = p.prices.map((x) => ({
    providerId: p.id,
    model: x.model,
    effectiveFrom: new Date(x.effectiveFrom),
    inputPerMTok: x.inputPerMTok ?? 0,
    cachedInputPerMTok: x.cachedInputPerMTok ?? x.inputPerMTok ?? 0,
    outputPerMTok: x.outputPerMTok ?? 0,
    searchPer1k: x.searchPer1k ?? 0,
    requestPer1k: x.requestPer1k ?? 0,
    batchDiscount: x.batchDiscount ?? 0,
  }));
  return selectPrice(entries, p.id, model, new Date()) ?? selectPrice(entries, p.id, "standard", new Date());
}

const selected = listProviders().filter((p) => {
  if (p.kind === "TEST") return false;
  if (positional.length) return positional.includes(p.id);
  return missingEnv(p).length === 0 && p.id !== "gemini-api"; // gemini-api: legal review first
});

if (selected.length === 0) {
  console.log("No provider selected. Set API keys in .env.local (see docs/SETUP.md) or name providers explicitly.");
}
console.log(`Prompt: "${req.promptText}" (${req.country}/${req.language}${req.location ? `, ${req.location}` : ""})\n`);

const rows: Array<Record<string, string | number>> = [];
await Promise.all(
  selected.map(async (p) => {
    const missing = missingEnv(p);
    if (missing.length) {
      rows.push({ provider: p.id, status: `missing env: ${missing.join(", ")}` });
      return;
    }
    if (!p.execute) {
      rows.push({ provider: p.id, status: "no synchronous path" });
      return;
    }
    const config = p.configurations.find((c) => c.role === "STANDARD") ?? p.configurations[0]!;
    const started = Date.now();
    try {
      const r = await p.execute(req, config);
      const cost = computeCost({ answer: r.answer, price: priceFor(p, config.model), reportedCostUsd: r.reportedCostUsd });
      rows.push({
        provider: p.id,
        status: "OK",
        model: r.answer.servedModel,
        seconds: ((Date.now() - started) / 1000).toFixed(1),
        answerChars: r.answer.answerText.length,
        citations: r.answer.citations.length,
        sources: r.answer.sources.length,
        fanOut: r.answer.search.queries.length,
        searched: r.answer.searchWasUsed ? "yes" : "no",
        costUsd: cost.totalCostUsd.toFixed(4),
      });
      console.log(`── ${p.id} ──\n${r.answer.answerText.slice(0, 600)}${r.answer.answerText.length > 600 ? " …" : ""}`);
      if (r.answer.citations.length) console.log(`citations: ${r.answer.citations.slice(0, 5).map((c) => c.url).join(", ")}`);
      if (r.answer.search.queries.length) console.log(`fan-out: ${r.answer.search.queries.slice(0, 5).join(" | ")}`);
      console.log();
    } catch (e) {
      rows.push({ provider: p.id, status: "ERROR", error: (e instanceof Error ? e.message : String(e)).slice(0, 160) });
    }
  }),
);

if (args.includes("--llm")) {
  for (const model of [INTERNAL_MODEL, ANALYZER_MODEL]) {
    const started = Date.now();
    try {
      const out = await generateStructured({
        schema: z.object({ category: z.string(), confidence: z.number() }),
        system: "Classify the website category. Return JSON only.",
        user: "Website: a Czech directory of wedding photographers and venues.",
        purpose: "smoke",
        domainId: null,
        model,
        effort: "low",
        maxTokens: 2000,
        classification: model === ANALYZER_MODEL,
        skipUsage: true,
      });
      rows.push({ provider: `internal-llm:${model}`, status: "OK", seconds: ((Date.now() - started) / 1000).toFixed(1), model, answerChars: JSON.stringify(out).length });
    } catch (e) {
      rows.push({ provider: `internal-llm:${model}`, status: "ERROR", error: (e instanceof Error ? e.message : String(e)).slice(0, 160) });
    }
  }
}

console.table(rows);
