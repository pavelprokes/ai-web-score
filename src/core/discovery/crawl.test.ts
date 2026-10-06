import { describe, expect, it } from "vitest";
import { parsePage } from "./crawl";

const HTML = `<!doctype html><html lang="cs"><head>
<title>Kódování pro děti – online kurzy programování</title>
<meta name="description" content="Online kurzy Pythonu a Scratche pro děti 8–15 let.">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
 {"@type":"EducationalOrganization","name":"Kódování pro děti","url":"https://kpd.example","address":{"streetAddress":"Vinohradská 1","addressLocality":"Praha","addressCountry":"CZ"}},
 {"@type":"Course","name":"Python pro děti","offers":{"price":"2490","priceCurrency":"CZK"}}]}</script>
</head><body><header><nav><a href="/kurzy">Kurzy</a><a href="/o-nas">O nás</a></nav></header>
<main><h1>Programování pro děti</h1><h2>Python</h2><h2>Scratch</h2><p>Učíme děti programovat zábavně.</p></main></body></html>`;

describe("crawler page parser", () => {
  it("extracts metadata, navigation and schema.org entities", () => {
    const p = parsePage("https://kpd.example/", HTML);
    expect(p.lang).toBe("cs");
    expect(p.title).toContain("Kódování pro děti");
    expect(p.h2).toEqual(["Python", "Scratch"]);
    expect(p.links.map((l) => l.href)).toEqual(["https://kpd.example/kurzy", "https://kpd.example/o-nas"]);
    expect(p.jsonLdTypes).toEqual(["EducationalOrganization", "Course"]);
    expect(p.text).toContain("Učíme děti programovat");
  });
});
