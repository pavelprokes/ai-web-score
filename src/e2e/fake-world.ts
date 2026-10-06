/**
 * Offline "world" for the end-to-end suite: the monitored website, the internal LLM
 * and the AI providers' HTTP APIs. Provider responses follow the real wire formats,
 * so the production adapters (DataForSEO async queue, OpenAI, Perplexity) run unchanged.
 *
 * NOTE: the se-vezmou.cz pages and profile below are a SYNTHETIC stand-in (the CI
 * sandbox has no internet access). Run the suite with E2E_LIVE=1 to use the real site,
 * the real LLM and real provider APIs.
 */

export const SITE = "se-vezmou.cz";
export const BRAND = "Se vezmou";
export const COMPETITORS = [
  { name: "Svatební portál Alfa", domain: "svatby-alfa.example" },
  { name: "Ano Beta", domain: "ano-beta.example" },
  { name: "Wedding Gama", domain: "wedding-gama.example" },
];

const SECTIONS = ["svatebni-fotografove", "svatebni-mista", "svatebni-salony", "planovani-svatby", "inspirace"];

function page(title: string, h1: string, body: string, nav = true) {
  return `<!doctype html><html lang="cs"><head><title>${title}</title>
<meta name="description" content="${body.slice(0, 140)}">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"${BRAND}","url":"https://${SITE}","address":{"addressLocality":"Praha","addressCountry":"CZ"}}</script>
</head><body>${
    nav
      ? `<header><nav>${SECTIONS.map((s) => `<a href="/${s}">${s.replace(/-/g, " ")}</a>`).join("")}<a href="/o-nas">O nás</a><a href="/kontakt">Kontakt</a></nav></header>`
      : ""
  }<main><h1>${h1}</h1><h2>Fotografové</h2><h2>Místa</h2><p>${body}</p></main></body></html>`;
}

export function sitePages(): Record<string, { body: string; type: string }> {
  const html = (b: string) => ({ body: b, type: "text/html; charset=utf-8" });
  const urls = SECTIONS.flatMap((s) => Array.from({ length: 8 }, (_, i) => `https://${SITE}/${s}/polozka-${i}`));
  return {
    [`https://${SITE}/robots.txt`]: { body: `User-agent: *\nAllow: /\nSitemap: https://${SITE}/sitemap.xml`, type: "text/plain" },
    [`https://${SITE}/sitemap.xml`]: {
      body: `<?xml version="1.0"?><urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`,
      type: "application/xml",
    },
    [`https://${SITE}`]: html(page(`${BRAND} – vše pro svatbu`, "Plánujete svatbu?", "Katalog svatebních fotografů, míst a salonů po celé ČR, inspirace a rady pro plánování svatby.")),
    ...Object.fromEntries(
      SECTIONS.map((s) => [`https://${SITE}/${s}`, html(page(`${s} | ${BRAND}`, s.replace(/-/g, " "), `Přehled: ${s.replace(/-/g, " ")} v Praze, Brně a dalších městech.`))]),
    ),
    [`https://${SITE}/o-nas`]: html(page(`O nás | ${BRAND}`, "O nás", "Pomáháme párům najít dodavatele na svatbu od roku 2015.")),
    [`https://${SITE}/kontakt`]: html(page(`Kontakt | ${BRAND}`, "Kontakt", "Napište nám.")),
  };
}

// ── Internal LLM ────────────────────────────────────────────────────────────

const TOPICS = [
  ["Svatební fotografové", "COMMERCIAL_INVESTIGATION", 0.95, 0.9],
  ["Svatební místa a venue", "COMMERCIAL_INVESTIGATION", 0.9, 0.9],
  ["Svatební šaty a salony", "COMMERCIAL_INVESTIGATION", 0.7, 0.8],
  ["Plánování svatby krok za krokem", "INFORMATIONAL", 0.6, 0.3],
  ["Rozpočet svatby", "INFORMATIONAL", 0.5, 0.4],
  ["Svatba v Praze", "LOCAL", 0.8, 0.8],
  ["Svatba v Brně", "LOCAL", 0.6, 0.7],
  ["Inspirace a trendy", "INFORMATIONAL", 0.4, 0.2],
] as const;

export function fakeDiscoveryProfile() {
  return {
    brandName: BRAND,
    brandAliases: ["se-vezmou.cz", "Sevezmou"],
    ownedDomains: [SITE],
    languages: ["cs"],
    markets: [{ country: "CZ", language: "cs", locations: ["Praha", "Brno", "Ostrava"], importance: 1 }],
    industry: "Weddings",
    category: "Wedding services directory and planning portal",
    subcategories: ["Wedding photographers", "Wedding venues", "Bridal salons", "Planning guides"],
    businessModels: ["MARKETPLACE", "PUBLISHER"],
    offerings: SECTIONS.map((s) => ({ name: s, kind: "CATEGORY", url: `https://${SITE}/${s}`, priceHint: "", importance: 0.7 })),
    estimatedProductCount: 0,
    estimatedServiceCount: 400,
    estimatedCategoryCount: SECTIONS.length,
    importantLandingPages: SECTIONS.map((s) => ({ url: `https://${SITE}/${s}`, purpose: s })),
    targetAudiences: ["Engaged couples in Czechia", "Wedding vendors"],
    customerIntents: ["Find a wedding photographer", "Find a venue", "Plan a wedding budget"],
    topics: TOPICS.map(([name, intent, importance, commercialValue]) => ({
      name,
      intent,
      importance,
      commercialValue,
      visibilityPotential: 0.6,
      subtopics: [],
      landingPage: "",
    })),
    localRelevance: 0.6,
    competitors: COMPETITORS.map((c) => ({ name: c.name, aliases: [], domains: [c.domain], overlap: 0.7 })),
    entities: [{ name: "svatba", aliases: [], domains: [] }],
    authorityTopics: ["Wedding vendors in Czechia"],
    factSheet: [
      { claim: "Se vezmou is a directory of wedding vendors in Czechia", category: "IDENTITY" },
      { claim: "Covers photographers, venues and bridal salons", category: "PRODUCT" },
    ],
    competitiveIntensity: 0.7,
    expectedAIVisibilityPotential: 0.6,
  };
}

const TEMPLATES: Array<[string, string]> = [
  ["RECOMMENDATION", "Bereme se příští léto, můžete mi doporučit dobré služby v oblasti {t}?"],
  ["COMPARISON", "Jak porovnat nabídky v oblasti {t} podle ceny a kvality, na co si dát pozor?"],
  ["DISCOVERY", "kde najdu prehled moznosti pro {t} v cesku"],
  ["PROBLEM_SOLUTION", "Mám omezený rozpočet a nevím, jak vyřešit {t}. Co byste mi poradili?"],
  ["LOCAL", "Hledám {t} poblíž Prahy pro svatbu na 80 hostů, co doporučíte?"],
  ["INFORMATIONAL", "Co je dobré vědět o tématu {t} před svatbou?"],
];

/** Generates prompts for the clusters requested in the prompt-generation user message. */
export function fakePromptSet(user: string) {
  const re = /clusterKey="([^"]+)" \| ([^|]+)\| intent (\w+) .*?write (\d+) prompts/g;
  const prompts = [];
  for (const m of user.matchAll(re)) {
    const [, key, name, intent, n] = m;
    for (let i = 0; i < Number(n); i++) {
      const [category, tpl] = TEMPLATES[i % TEMPLATES.length]!;
      prompts.push({
        clusterKey: key!,
        text: tpl.replace("{t}", name!.trim().toLowerCase()) + (i >= TEMPLATES.length ? ` (varianta ${i})` : ""),
        category,
        intent: category === "LOCAL" ? "LOCAL" : intent!,
        language: "cs",
        country: "CZ",
        location: category === "LOCAL" ? "Praha" : "",
        persona: i % 3 === 0 ? "engaged couple" : "",
        paraphraseGroup: `g${Math.floor(i / 2)}`,
        importance: 0.5 + ((i * 7) % 5) / 10,
        commercialValue: intent === "INFORMATIONAL" ? 0.3 : 0.8,
        expectedVolatility: 0.6,
        entities: ["svatba"],
        containsBrand: false,
      });
    }
  }
  return { prompts };
}

export function fakeJudgement(user: string) {
  const answer = user.split("AI answer:")[1] ?? "";
  const mentioned = answer.toLowerCase().includes(BRAND.toLowerCase());
  return {
    brandRecommended: mentioned,
    brandDiscouraged: false,
    sentiment: mentioned ? 0.6 : 0,
    brandDescriptionAccuracy: mentioned ? 0.9 : -1,
    productAccuracy: mentioned ? 0.8 : -1,
    pricingAccuracy: -1,
    answerConfidence: 0.7,
    untrackedBrands: ["Nový Konkurent"],
  };
}

export function fakeLlm({ purpose, user }: { purpose: string; user: string }) {
  if (purpose === "discovery") return fakeDiscoveryProfile();
  if (purpose.startsWith("portfolio.")) return fakePromptSet(user);
  if (purpose === "analysis") return fakeJudgement(user);
  throw new Error(`fake LLM: unexpected purpose ${purpose}`);
}

// ── AI provider APIs ────────────────────────────────────────────────────────

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/** Per-provider base visibility so providers differ like real engines do. */
const BASE: Record<string, number> = { chatgpt: 0.65, aimode: 0.45, openai: 0.55, perplexity: 0.35 };

export function fakeAnswer(provider: string, prompt: string, salt: string) {
  const r = hash(`${provider}|${prompt}|${salt}`);
  const p = BASE[provider]! * (0.6 + 0.8 * hash(prompt));
  const mentioned = r < p;
  const names = COMPETITORS.map((c) => c.name);
  if (mentioned) names.splice(Math.floor(hash(salt + prompt) * 3), 0, BRAND);
  const cited = mentioned && r < p * 0.6;
  const text = `Tady je několik možností:\n\n${names.map((n, i) => `${i + 1}. **${n}** – ověřená volba pro svatby.`).join("\n")}\n\nDoporučuji porovnat recenze.`;
  const citations = [
    ...(cited ? [{ url: `https://www.${SITE}/svatebni-fotografove`, title: BRAND }] : []),
    { url: `https://${COMPETITORS[0]!.domain}/`, title: COMPETITORS[0]!.name },
  ];
  return { text, citations, queries: [`${prompt.slice(0, 40)}`, "wedding photographer czech republic"] };
}

type Route = (url: URL, init: RequestInit | undefined) => Promise<Response | null> | Response | null;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** In-memory DataForSEO task store: first poll → "in queue", second poll → result. */
const dfsTasks = new Map<string, { keyword: string; surface: string; polls: number; tag: string }>();

export function resetFakeWorld() {
  dfsTasks.clear();
}

const dataForSeo: Route = (url, init) => {
  if (url.hostname !== "api.dataforseo.com") return null;
  const surface = url.pathname.includes("/ai_mode/") ? "aimode" : "chatgpt";
  if (url.pathname.endsWith("/task_post")) {
    const tasks = JSON.parse(String(init?.body)) as Array<{ keyword: string; tag: string }>;
    return json({
      status_code: 20000,
      status_message: "Ok.",
      tasks: tasks.map((t) => {
        const id = `dfs-${surface}-${t.tag}`;
        dfsTasks.set(id, { keyword: t.keyword, surface, polls: 0, tag: t.tag });
        return { id, status_code: 20100, status_message: "Task Created.", cost: 0.0012, data: { tag: t.tag }, result: null };
      }),
    });
  }
  const m = url.pathname.match(/task_get\/advanced\/(.+)$/);
  if (m) {
    const task = dfsTasks.get(m[1]!);
    if (!task) return json({ status_code: 20000, status_message: "Ok.", tasks: [{ id: m[1], status_code: 40400, status_message: "Not Found", result: null }] });
    task.polls++;
    if (task.polls === 1) return json({ status_code: 20000, status_message: "Ok.", tasks: [{ id: m[1], status_code: 40602, status_message: "Task In Queue.", result: null }] });
    const a = fakeAnswer(task.surface, task.keyword, task.tag);
    const refs = a.citations.map((c) => ({ url: c.url, title: c.title, domain: new URL(c.url).hostname }));
    const result =
      task.surface === "aimode"
        ? { items: [{ type: "ai_overview", markdown: a.text, references: refs, items: [{ type: "ai_overview_element", markdown: a.text, references: refs }] }] }
        : { model: "gpt-chatgpt-ui", markdown: a.text, sources: refs, search_results: [...refs, { url: "https://other.example/", domain: "other.example" }], fan_out_queries: a.queries, items: [{ type: "chat_gpt_text", sources: refs }] };
    return json({ status_code: 20000, status_message: "Ok.", tasks: [{ id: m[1], status_code: 20000, status_message: "Ok.", cost: 0.0012, data: { tag: task.tag }, result: [result] }] });
  }
  return json({ status_code: 40400, status_message: "unknown endpoint" }, 404);
};

const openAi: Route = async (url, init) => {
  if (url.hostname !== "api.openai.com") return null;
  const body = JSON.parse(String(init?.body)) as { model: string; input: string };
  await new Promise((r) => setTimeout(r, 60)); // realistic latency → lets the test observe parallelism
  const a = fakeAnswer("openai", body.input, body.model + Math.random());
  return json({
    model: body.model,
    status: "completed",
    output: [
      { type: "web_search_call", action: { type: "search", query: a.queries[0], sources: a.citations.map((c) => ({ type: "url", url: c.url })) } },
      { type: "message", content: [{ type: "output_text", text: a.text, annotations: a.citations.map((c) => ({ type: "url_citation", url: c.url, title: c.title, start_index: 0, end_index: 10 })) }] },
    ],
    usage: { input_tokens: 4200, output_tokens: 380, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 120 } },
  });
};

const perplexity: Route = async (url, init) => {
  if (url.hostname !== "api.perplexity.ai") return null;
  if (url.pathname !== "/v1/agent") return new Response(JSON.stringify({ error: { message: "Not found" } }), { status: 404 });
  const body = JSON.parse(String(init?.body)) as { input: string; preset?: string; service_tier?: string };
  if (body.preset && !["fast", "low", "medium", "high", "xhigh"].includes(body.preset)) {
    return new Response(JSON.stringify({ error: { message: `Unknown preset ${body.preset}` } }), { status: 400 });
  }
  await new Promise((r) => setTimeout(r, 60));
  const a = fakeAnswer("perplexity", body.input, String(Math.random()));
  // Like the fast preset: numbered inline citations, no annotation objects.
  const text = `${a.text} ${a.citations.map((_, i) => `[${i + 1}]`).join("")}`;
  const flex = body.service_tier === "flex";
  return json({
    model: "openai/gpt-6-luna",
    status: "completed",
    service_tier: flex ? "flex" : "priority",
    output: [
      { type: "search_results", results: a.citations.map((c, i) => ({ id: i, url: c.url, title: c.title, snippet: "" })), queries: a.queries },
      { type: "message", content: [{ type: "output_text", text, annotations: null }] },
    ],
    usage: {
      input_tokens: 3000,
      output_tokens: 300,
      cost: flex
        ? { currency: "USD", input_cost: 0.00015, output_cost: 0.000075, tool_calls_cost: 0.001, total_cost: 0.001225 }
        : { currency: "USD", input_cost: 0.0006, output_cost: 0.0003, tool_calls_cost: 0.001, total_cost: 0.0019 },
      tool_calls_details: { web_search: { invocation: 1 } },
    },
  });
};

const website: Route = (url) => {
  const host = url.hostname.replace(/^www\./, "");
  if (host !== SITE) return null;
  const key = `https://${SITE}${url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "")}`;
  const page = sitePages()[key];
  return page ? new Response(page.body, { status: 200, headers: { "content-type": page.type } }) : new Response("Not found", { status: 404 });
};

/** fetch replacement: routes to the fake world, everything else is refused. */
export function fakeFetch(realFetch: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    for (const route of [dataForSeo, openAi, perplexity, website]) {
      const res = await route(url, init);
      if (res) return res;
    }
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return realFetch(input, init);
    throw new Error(`fake world: no route for ${url.href}`);
  }) as typeof fetch;
}
