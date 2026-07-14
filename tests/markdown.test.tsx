// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/ui/markdown";

describe("Markdown renderer", () => {
  it("renders headings, paragraphs, lists, and code fences as structured nodes", () => {
    render(
      <Markdown
        source={`## Objective\n\nAdd a comment.\n\n## Change\n\n- one\n- two\n- three\n\n\`\`\`\nconst x = 1;\n\`\`\``}
      />
    );

    // Headings: the `##` becomes a heading element with its text, not a literal `##` run.
    expect(screen.getByText("Objective").tagName).toBe("H5");
    expect(screen.getByText("Change").tagName).toBe("H5");
    // Paragraph text is present as flow.
    expect(screen.getByText("Add a comment.")).toBeInTheDocument();
    // Unordered list items render as list items.
    const items = screen.getAllByText(/one|two|three/);
    expect(items.every((node) => node.tagName === "LI")).toBe(true);
    // Fenced code lands in a <pre><code> block, not as inline text.
    const pre = document.querySelector(".md-pre");
    expect(pre?.textContent).toContain("const x = 1;");
  });

  it("renders ordered lists with numeric markers and nests sub-lists under indent", () => {
    render(
      <Markdown
        source={`1. top\n2. nested\n   - child a\n   - child b\n3. back`}
      />
    );

    expect(screen.getByText("top")).toBeInTheDocument();
    expect(screen.getByText("nested")).toBeInTheDocument();
    expect(screen.getByText("back")).toBeInTheDocument();
    // The nested children render as their own list items.
    expect(screen.getByText("child a").tagName).toBe("LI");
    expect(screen.getByText("child b").tagName).toBe("LI");
    // An ordered list marker element exists.
    expect(document.querySelector(".md-list-ordered")).not.toBeNull();
    expect(document.querySelector(".md-list-nested")).not.toBeNull();
  });

  it("renders inline bold, italic, code, and links", () => {
    render(<Markdown source={`This is **bold**, *italic*, \`code\`, and [a link](https://example.com).`} />);

    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("italic").tagName).toBe("EM");
    expect(screen.getByText("code").tagName).toBe("CODE");
    const link = screen.getByRole("link", { name: "a link" });
    expect(link).toHaveAttribute("href", "https://example.com/");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders blockquotes, thematic breaks, and preserves code-block content verbatim", () => {
    const { container } = render(
      <Markdown
        source={`> quoted line\n\n---\n\n\`\`\`\n# not a heading inside code\n- not a list inside code\n\`\`\``}
      />
    );

    expect(container.querySelector(".md-quote")).not.toBeNull();
    expect(container.querySelector(".md-hr")).not.toBeNull();
    // Code-block content is preserved verbatim: the `#` and `-` are NOT re-parsed as markdown.
    expect(container.querySelector(".md-pre")?.textContent).toContain("# not a heading inside code");
    expect(container.querySelector(".md-pre")?.textContent).toContain("- not a list inside code");
  });

  it("normalizes literal backslash-n escapes into real line breaks", () => {
    // A transport that emits a literal `\n` instead of a newline must still parse as two lines.
    render(<Markdown source={`## Objective\\nAdd a comment.`} />);

    expect(screen.getByText("Objective").tagName).toBe("H5");
    expect(screen.getByText("Add a comment.")).toBeInTheDocument();
  });

  it("renders text safely — a script tag in markdown text never becomes HTML", () => {
    const { container } = render(<Markdown source={`Look at this: <script>alert(1)</script>`} />);

    // No <script> element is created; the angle brackets render as escaped text.
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("drops dangerous link hrefs while keeping the link text", () => {
    const { container } = render(<Markdown source={`click [here](javascript:alert(1)) and [safe](https://ok.example)`} />);

    // The javascript: link is downgraded: no element carries a dangerous href.
    expect(container.querySelector('[href="javascript:alert(1)"]')).toBeNull();
    expect(container.querySelectorAll("a")).toHaveLength(1);
    // The label text is still present (the content did not disappear with the dropped href).
    expect(container.textContent).toContain("here");
    // The safe link keeps its href.
    expect(screen.getByRole("link", { name: "safe" })).toHaveAttribute("href", "https://ok.example/");
  });

  it("renders nothing for an empty source and plain text for non-markdown content", () => {
    const { container, rerender } = render(<Markdown source={"   "} />);
    expect(container.querySelector(".md-root")).toBeNull();

    rerender(<Markdown source={"just plain prose with no markdown at all"} />);
    expect(container.querySelector(".md-paragraph")?.textContent).toContain("just plain prose with no markdown at all");
  });
});
