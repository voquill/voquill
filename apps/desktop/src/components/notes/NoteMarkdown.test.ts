import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NoteMarkdown } from "./NoteMarkdown";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const render = (markdown: string) =>
  renderToStaticMarkup(createElement(NoteMarkdown, { children: markdown }));

describe("NoteMarkdown", () => {
  it("never loads images: they render as their alt text", () => {
    const html = render(
      "Before ![tracking pixel](https://evil.example/p.png) after\n\n![](https://evil.example/q.png)",
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("evil.example");
    expect(html).toContain("tracking pixel");
  });

  it("drops raw HTML", () => {
    const html = render(
      'Hi <img src="https://evil.example/x.png"> <iframe src="https://evil.example"></iframe>\n\n<script>alert(1)</script>\n\n<a href="https://evil.example">raw</a>',
    );
    expect(html).not.toMatch(/<(img|iframe|script)/);
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("alert(1)");
  });

  it("keeps web links clickable and drops other schemes", () => {
    const html = render(
      "[site](https://voquill.com) [bad](javascript:alert(1)) [file](file:///etc/passwd)",
    );
    expect(html).toContain('href="https://voquill.com"');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("file:");
    expect(html).toContain("bad");
  });

  it("still renders GFM task lists and tables", () => {
    const html = render("- [ ] Ship it\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<table");
  });
});
