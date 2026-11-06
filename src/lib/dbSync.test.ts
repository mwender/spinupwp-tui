import { describe, expect, test } from "bun:test"
import { parseRemoteHome, rewriteSources } from "./dbSync.ts"

describe("rewriteSources", () => {
  test("a www home URL is rewritten first, and the bare domain too (#95)", () => {
    expect(rewriteSources("https://example.com", "https://www.example.com")).toEqual({
      origins: ["https://www.example.com", "https://example.com"],
      host: "www.example.com",
    })
  })
  test("a home URL matching the domain rewrites it once", () => {
    expect(rewriteSources("https://example.com", "https://example.com")).toEqual({ origins: ["https://example.com"], host: "example.com" })
  })
  test("a home URL with a trailing slash or a path still matches by origin", () => {
    expect(rewriteSources("https://example.com", "https://example.com/").origins).toEqual(["https://example.com"])
    expect(rewriteSources("https://example.com", "https://www.example.com/blog").origins).toEqual(["https://www.example.com", "https://example.com"])
  })
  test("an http home on an https site keeps its own scheme", () => {
    expect(rewriteSources("https://example.com", "http://example.com").origins).toEqual(["http://example.com", "https://example.com"])
  })
  test("no home URL, or junk, falls back to the domain", () => {
    for (const home of [null, "", "Error: not installed", "ftp://example.com"]) {
      expect(rewriteSources("https://example.com", home)).toEqual({ origins: ["https://example.com"], host: "example.com" })
    }
  })
})

describe("parseRemoteHome", () => {
  test("reads the marked line from the export's output", () => {
    expect(parseRemoteHome("some noise\nSPINUP_HOME=https://www.example.com\n")).toBe("https://www.example.com")
  })
  test("an empty or missing line is null", () => {
    expect(parseRemoteHome("SPINUP_HOME=\n")).toBeNull()
    expect(parseRemoteHome("")).toBeNull()
  })
})
