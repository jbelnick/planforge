import { Fragment, type ReactNode } from "react";

// A small, dependency-free, SAFE markdown renderer for the PlanForge chat pane.
//
// Why hand-written: the architect's `plan` and `architect_message` fields arrive as raw markdown
// (`## Objective`, `### Change`, `- item`, fenced code). Dumping that into a <p> with white-space:
// pre-wrap renders literal `##` and `\n` and is the readability problem this fixes.
//
// Safety model: this builds a React node tree. It never calls dangerouslySetInnerHTML, so every piece
// of user/architect text is escaped by React by default. The only place a string becomes an
// attribute is an <a href>, and that is sanitized to http/https/mailto only (no javascript:/data:).
//
// Coverage: a pragmatic GFM subset — ATX headings, fenced code blocks, ordered/unordered lists with
// nesting, blockquotes, horizontal rules, paragraphs, and inline bold/italic/code/links. It is not a
// complete CommonMark implementation; it covers what the architect emits and degrades gracefully
// (unknown markdown renders as plain text) on the rest.

const FENCE = /^(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const UNORDERED_LIST_ITEM = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED_LIST_ITEM = /^(\s*)(\d+)\.\s+(.*)$/;
const BLOCKQUOTE = /^>\s?(.*)$/;
const THEMATIC_BREAK = /^(-{3,}|\*{3,}|_{3,})\s*$/;

// Some upstream writers emit a literal backslash-n (`\n`) instead of a real newline inside a string
// field (notably some plan transports). Normalize those to real newlines so the line parser sees the
// intended structure, while a real escaped backslash (`\\n`) is preserved as a literal `\n`.
function normalizeLineBreaks(source: string): string {
  return source.replace(/\\n/g, "\n");
}

// Allow only same-document links (href="#...") and http/https/mailto absolute URLs. Anything else
// (javascript:, data:, file:, vbscript:, ...) is refused — the link text still renders, but the
// href is dropped so it cannot navigate.
function sanitizeHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("#")) {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") {
      return url.href;
    }
    return null;
  } catch {
    return null;
  }
}

type InlineToken =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "bold"; readonly children: readonly InlineToken[] }
  | { readonly kind: "italic"; readonly children: readonly InlineToken[] }
  | { readonly kind: "code"; readonly value: string }
  | { readonly kind: "link"; readonly href: string; readonly children: readonly InlineToken[] }
  | { readonly kind: "linebreak" };

// Parse a single inline "run" (no newlines) into bold/italic/code/link tokens. Each delimiter type
// is matched left-to-right at the earliest opening marker with a matching closer. Bold (`**`) is
// tried before italic (`*`) so `**bold**` is not misread as two italics.
function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let cursor = 0;
  let buffer = "";

  function flushBuffer(): void {
    if (buffer.length > 0) {
      tokens.push({ kind: "text", value: buffer });
      buffer = "";
    }
  }

  while (cursor < text.length) {
    const rest = text.slice(cursor);

    const codeMatch = rest.match(/^`([^`]+)`/);
    if (codeMatch) {
      flushBuffer();
      tokens.push({ kind: "code", value: codeMatch[1] ?? "" });
      cursor += codeMatch[0].length;
      continue;
    }

    const boldMatch = rest.match(/^\*\*([^*]+)\*\*/);
    if (boldMatch) {
      flushBuffer();
      tokens.push({ kind: "bold", children: parseInline(boldMatch[1] ?? "") });
      cursor += boldMatch[0].length;
      continue;
    }

    const italicMatch = rest.match(/^\*([^*]+)\*/);
    if (italicMatch) {
      flushBuffer();
      tokens.push({ kind: "italic", children: parseInline(italicMatch[1] ?? "") });
      cursor += italicMatch[0].length;
      continue;
    }

    const linkMatch = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/);
    if (linkMatch) {
      const href = sanitizeHref(linkMatch[2] ?? "");
      const label = linkMatch[1] ?? "";
      flushBuffer();
      if (href) {
        tokens.push({ kind: "link", href, children: parseInline(label) });
      } else {
        // A dangerous/invalid href is dropped, but the link's label still renders as plain text so
        // no content disappears silently.
        tokens.push(...parseInline(label));
      }
      cursor += linkMatch[0].length;
      continue;
    }

    // Hard line break inside a paragraph: two trailing spaces + newline, or a backslash + newline.
    // normalizeLineBreaks already turned \n into real newlines; a literal backslash-newline is rare
    // here (paragraphs are pre-split), but keep it defensive.
    if (rest.startsWith("\\\n")) {
      flushBuffer();
      tokens.push({ kind: "linebreak" });
      cursor += 2;
      continue;
    }

    buffer += rest[0];
    cursor += 1;
  }

  flushBuffer();
  return tokens;
}

function renderInline(tokens: readonly InlineToken[], keyPrefix: string): ReactNode {
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (token.kind) {
      case "text":
        return <Fragment key={key}>{token.value}</Fragment>;
      case "bold":
        return (
          <strong key={key} className="md-bold">
            {renderInline(token.children, key)}
          </strong>
        );
      case "italic":
        return (
          <em key={key} className="md-italic">
            {renderInline(token.children, key)}
          </em>
        );
      case "code":
        return (
          <code key={key} className="md-code">
            {token.value}
          </code>
        );
      case "link":
        return (
          <a key={key} className="md-link" href={token.href} target="_blank" rel="noopener noreferrer">
            {renderInline(token.children, key)}
          </a>
        );
      case "linebreak":
        return <br key={key} />;
      default: {
        const exhaustive: never = token;
        return exhaustive;
      }
    }
  });
}

type Block =
  | { readonly kind: "heading"; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly inline: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: readonly ListItem[] }
  | { readonly kind: "quote"; readonly blocks: readonly Block[] }
  | { readonly kind: "thematic" }
  | { readonly kind: "paragraph"; readonly inline: string };

type ListItem = {
  readonly inline: string;
  readonly children: readonly ListItem[];
};

// Parse-time list items are mutable so the indented-nesting pass can push children into the last
// item. They are frozen to the readonly ListItem shape once a list block is complete.
type MutableListItem = {
  inline: string;
  children: MutableListItem[];
};

function mutableListItem(text: string): MutableListItem {
  return { inline: text, children: [] };
}

function freezeListItem(item: MutableListItem): ListItem {
  return { inline: item.inline, children: item.children.map(freezeListItem) };
}

function nestListItem(items: MutableListItem[], depth: number, item: MutableListItem): void {
  if (depth === 0) {
    items.push(item);
    return;
  }
  const last = items[items.length - 1];
  if (last) {
    nestListItem(last.children, depth - 1, item);
    return;
  }
  // Indent deeper than any existing item: attach to the root for this level (defensive).
  items.push(item);
}

// Parse normalized markdown source into block nodes. List nesting is inferred from leading-space
// indentation (two-or-more-space steps under GFM). Fenced code blocks swallow everything until the
// matching fence, so their contents are never re-parsed as markdown.
function parseBlocks(source: string): Block[] {
  const lines = source.split("\n");
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) {
      index += 1;
      continue;
    }

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    const fenceMatch = line.match(FENCE);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length) {
        const codeLine = lines[index];
        if (codeLine !== undefined && codeLine.trim() === marker.trim()) {
          index += 1;
          break;
        }
        if (codeLine !== undefined) {
          codeLines.push(codeLine);
        }
        index += 1;
      }
      blocks.push({ kind: "code", text: codeLines.join("\n") });
      continue;
    }

    const headingMatch = line.match(HEADING);
    if (headingMatch) {
      const rawLevel = headingMatch[1]?.length ?? 1;
      const level = (rawLevel >= 1 && rawLevel <= 6 ? rawLevel : 1) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({
        kind: "heading",
        level,
        inline: (headingMatch[2] ?? "").trim()
      });
      index += 1;
      continue;
    }

    if (THEMATIC_BREAK.test(line.trim())) {
      blocks.push({ kind: "thematic" });
      index += 1;
      continue;
    }

    const unorderedMatch = line.match(UNORDERED_LIST_ITEM);
    const orderedMatch = line.match(ORDERED_LIST_ITEM);
    if (unorderedMatch || orderedMatch) {
      const ordered = Boolean(orderedMatch);
      const items: MutableListItem[] = [];
      while (index < lines.length) {
        const itemLine = lines[index];
        if (itemLine === undefined) {
          break;
        }
        const u = itemLine.match(UNORDERED_LIST_ITEM);
        const o = itemLine.match(ORDERED_LIST_ITEM);
        const matched = ordered ? o : u;
        if (!matched) {
          // A blank line ends the list; a non-indented non-list line also ends it.
          if (itemLine.trim().length === 0) {
            break;
          }
          break;
        }
        const indent = matched[1]?.length ?? 0;
        const depth = Math.floor(indent / 2);
        nestListItem(items, depth, mutableListItem((matched[3] ?? "").trim()));
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items: items.map(freezeListItem) });
      continue;
    }

    const quoteMatch = line.match(BLOCKQUOTE);
    if (quoteMatch) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const quoteLine = lines[index];
        const qm = quoteLine?.match(BLOCKQUOTE);
        if (!qm) {
          break;
        }
        quoteLines.push(qm[1] ?? "");
        index += 1;
      }
      blocks.push({ kind: "quote", blocks: parseBlocks(quoteLines.join("\n")) });
      continue;
    }

    // Paragraph: gather consecutive non-blank, non-block lines and render their inlines joined by
    // spaces (a newline in a soft-wrapped paragraph is a space in GFM).
    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const paraLine = lines[index];
      if (
        paraLine === undefined ||
        paraLine.trim().length === 0 ||
        HEADING.test(paraLine) ||
        FENCE.test(paraLine) ||
        THEMATIC_BREAK.test(paraLine.trim()) ||
        UNORDERED_LIST_ITEM.test(paraLine) ||
        ORDERED_LIST_ITEM.test(paraLine) ||
        BLOCKQUOTE.test(paraLine)
      ) {
        break;
      }
      paragraphLines.push(paraLine.trim());
      index += 1;
    }
    blocks.push({ kind: "paragraph", inline: paragraphLines.join(" ") });
  }

  return blocks;
}

function renderListItem(item: ListItem, index: number, keyPrefix: string): ReactNode {
  return (
    <li key={keyPrefix} className="md-list-item" value={index + 1}>
      {renderInline(parseInline(item.inline), `${keyPrefix}-inline`)}
      {item.children.length > 0 ? (
        <ListItems items={item.children} keyPrefix={`${keyPrefix}-children`} startIndex={0} />
      ) : null}
    </li>
  );
}

function ListItems(input: {
  readonly items: readonly ListItem[];
  readonly keyPrefix: string;
  readonly startIndex: number;
}): ReactNode {
  return (
    <ul className="md-list md-list-nested">
      {input.items.map((item, index) => renderListItem(item, input.startIndex + index, `${input.keyPrefix}-${index}`))}
    </ul>
  );
}

function renderBlock(block: Block, index: number): ReactNode {
  const key = `block-${index}`;
  switch (block.kind) {
    case "heading": {
      const Tag = (`h${Math.min(block.level + 3, 6)}` as "h4" | "h5" | "h6");
      return (
        <Tag key={key} className={`md-heading md-heading-${block.level}`}>
          {renderInline(parseInline(block.inline), `${key}-inline`)}
        </Tag>
      );
    }
    case "code":
      return (
        <pre key={key} className="md-pre">
          <code>{block.text}</code>
        </pre>
      );
    case "list": {
      const ListTag = block.ordered ? "ol" : "ul";
      return (
        <ListTag key={key} className={`md-list ${block.ordered ? "md-list-ordered" : "md-list-unordered"}`}>
          {block.items.map((item, itemIndex) => renderListItem(item, itemIndex, `${key}-${itemIndex}`))}
        </ListTag>
      );
    }
    case "quote":
      return (
        <blockquote key={key} className="md-quote">
          {block.blocks.map((child, childIndex) => renderBlock(child, childIndex))}
        </blockquote>
      );
    case "thematic":
      return <hr key={key} className="md-hr" />;
    case "paragraph":
      return (
        <p key={key} className="md-paragraph">
          {renderInline(parseInline(block.inline), `${key}-inline`)}
        </p>
      );
    default: {
      const exhaustive: never = block;
      return exhaustive;
    }
  }
}

export function Markdown(input: { readonly source: string }): ReactNode {
  const source = normalizeLineBreaks(input.source ?? "");
  if (source.trim().length === 0) {
    return null;
  }
  const blocks = parseBlocks(source);
  return <div className="md-root">{blocks.map((block, index) => renderBlock(block, index))}</div>;
}
