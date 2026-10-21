import { describe, expect, it } from "vitest";
import {
  findRemoteRefs,
  sanitizeForRender,
  stripScriptsAndHandlers,
} from "@/lib/render/sanitize";

describe("stripScriptsAndHandlers", () => {
  it("removes scripts in any case, quoted or slash-separated", () => {
    expect(
      stripScriptsAndHandlers("<SCRIPT>alert(1)</SCRIPT><p>x</p>"),
    ).not.toContain("alert");
    expect(
      stripScriptsAndHandlers("<svg/onload=alert(1)><p>x</p>"),
    ).not.toContain("onload");
    expect(
      stripScriptsAndHandlers('<svg><animate onbegin="alert(1)" /></svg>'),
    ).not.toContain("onbegin");
  });

  it("strips event handlers with spaces, capitals and entities", () => {
    expect(stripScriptsAndHandlers('<div ONCLICK = "go()">x</div>')).toBe(
      "<div>x</div>",
    );
    expect(
      stripScriptsAndHandlers('<img src="x" onerror&#61;alert(1)>'),
    ).not.toContain("onerror");
  });

  it("neutralizes javascript: URLs including encoded and spaced forms", () => {
    expect(
      stripScriptsAndHandlers('<a href="  JaVaScRiPt:alert(1)">x</a>'),
    ).toBe("<a>x</a>");
    expect(
      stripScriptsAndHandlers(
        '<form action="x" formaction="javascript:alert(1)"><button>y</button></form>',
      ),
    ).not.toContain("javascript");
  });

  it("drops remote auto-load references but keeps data: and relative ones", () => {
    const dirty =
      '<img src="https://evil.example/x.png" srcset="https://evil.example/a 1x, local.png 2x">' +
      '<video poster="https://evil.example/p.jpg" src="clip.mp4"></video>' +
      '<object data="https://evil.example/x.swf"></object>' +
      '<img src="data:image/png;base64,AAA" srcset="local.png 1x">';
    const out = stripScriptsAndHandlers(dirty);
    expect(out).not.toContain("evil.example");
    expect(out).toContain("clip.mp4");
    expect(out).toContain("data:image/png;base64,AAA");
    expect(out).toContain("local.png");
  });

  it("removes meta refresh and base href hijacks, keeps plain links", () => {
    expect(
      stripScriptsAndHandlers(
        '<meta http-equiv="refresh" content="0;url=https://evil.example/"><a href="https://example.com/page">x</a><p>y</p>',
      ),
    ).toBe('<a href="https://example.com/page">x</a><p>y</p>');
    const base = stripScriptsAndHandlers(
      '<base href="https://evil.example/"><p>y</p>',
    );
    expect(base).not.toContain("evil.example");
    expect(base).toContain("<p>y</p>");
  });

  it("keeps fragments as fragments and documents as documents", () => {
    expect(stripScriptsAndHandlers("<p>Hi</p>")).toBe("<p>Hi</p>");
    const doc = stripScriptsAndHandlers(
      "<!DOCTYPE html><html><head><title>t</title></head><body><p>Hi</p></body></html>",
    );
    expect(doc).toMatch(/^<!DOCTYPE html>/i);
    expect(doc).toContain("<title>t</title>");
    expect(doc).toContain("<p>Hi</p>");
  });

  it("leaves legitimate template markup alone", () => {
    const html =
      '<div class="a"><h1>{{title}}</h1><img src="data:image/png;base64,AAA"><a href="/local/page">more</a></div>';
    expect(stripScriptsAndHandlers(html)).toBe(html);
  });

  it("returns pure text byte-identical (padded helper output)", () => {
    expect(stripScriptsAndHandlers("   42")).toBe("   42");
    expect(stripScriptsAndHandlers("a < b and c > d")).toBe("a < b and c > d");
  });
});

describe("findRemoteRefs", () => {
  it("sees srcset, poster, object data and other non-src attributes", () => {
    const found = findRemoteRefs(
      '<img srcset="https://evil.example/a 1x, b 2x"><video poster="https://evil.example/p.jpg" src="clip.mp4"></video><object data="https://evil.example/x"></object>',
      "",
    );
    expect(found).not.toBeNull();
    expect(found!.join("\n")).toContain("srcset");
    expect(found!.join("\n")).toContain("poster");
    expect(found!.join("\n")).toContain("data");
  });

  it("sees @import with and without url(), and base href", () => {
    expect(
      findRemoteRefs("", '@import url("//evil.example/x.css");'),
    ).not.toBeNull();
    expect(
      findRemoteRefs("", '@import "https://evil.example/x.css";'),
    ).not.toBeNull();
    expect(
      findRemoteRefs('<base href="https://evil.example/">', ""),
    ).not.toBeNull();
  });

  it("sees javascript: URLs even when entity-encoded", () => {
    expect(
      findRemoteRefs('<a href="&#106;avascript:alert(1)">x</a>', ""),
    ).not.toBeNull();
  });

  it("stays quiet for data: URIs, relative URLs and plain CSS", () => {
    expect(
      findRemoteRefs(
        '<img src="data:image/png;base64,AAA"><a href="/local">x</a>',
        ".a{color:red}",
      ),
    ).toBeNull();
  });
});

describe("sanitizeForRender", () => {
  it("never lets code through, including the tricky spellings", () => {
    const out = sanitizeForRender(
      "<ScRiPt>alert(1)</ScRiPt><svg/onload=alert(2)><img src=x onerror=alert(3)>",
    );
    expect(out).not.toMatch(/script|onload|onerror/i);
    expect(out).toContain("<svg");
    expect(out).toContain("<img");
  });
});
