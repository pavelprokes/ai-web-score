import { describe, expect, it } from "vitest";
import { isoLanguage } from "./language";

describe("isoLanguage", () => {
  it("reduces tags, three-letter codes and names to ISO 639-1", () => {
    expect(isoLanguage("en-AU")).toBe("en");
    expect(isoLanguage("en_au")).toBe("en");
    expect(isoLanguage("CS")).toBe("cs");
    expect(isoLanguage("ces")).toBe("cs");
    expect(isoLanguage("zh-Hant-TW")).toBe("zh");
    expect(isoLanguage("English")).toBe("en");
    expect(isoLanguage(" czech ")).toBe("cs");
  });

  it("gives undefined when nothing fits", () => {
    expect(isoLanguage("xx")).toBeUndefined();
    expect(isoLanguage("Klingonish")).toBeUndefined();
    expect(isoLanguage("")).toBeUndefined();
    expect(isoLanguage(undefined)).toBeUndefined();
  });
});
