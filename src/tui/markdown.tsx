import React, { memo } from "react";
import { Box, Text } from "ink";
import { colorFor, tokenizeLine } from "./syntax.js";
import type { Theme } from "./theme.js";
import { THEMES } from "./theme.js";

// Lightweight markdown → Ink. Soft highlights (no solid background chips).

type Block =
  | { type: "code"; lang: string; lines: string[] }
  | { type: "heading"; level: number; text: string }
  | { type: "quote"; lines: string[] }
  | { type: "bullet"; text: string }
  | { type: "numbered"; n: string; text: string }
  | { type: "para"; text: string }
  | { type: "hr" };

function parseBlocks(md: string): Block[] {
  const cached = BLOCK_PARSE_CACHE.get(md);
  if (cached) return cached;
  const blocks = parseBlocksUncached(md);
  if (BLOCK_PARSE_CACHE.size < BLOCK_PARSE_CACHE_MAX) BLOCK_PARSE_CACHE.set(md, blocks);
  return blocks;
}

// parseBlocks is pure over the input string. During streaming the <StreamingText>
// body changes every tick, so the parse itself can't be skipped — but committed
// <Static> entries re-render on parent updates (tool adds) and would otherwise
// re-parse unchanged markdown each time. Bounded map keeps hot lookups free.
const BLOCK_PARSE_CACHE = new Map<string, Block[]>();
const BLOCK_PARSE_CACHE_MAX = 512;

function parseBlocksUncached(md: string): Block[] {
  const lines = md.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({ type: "code", lang: fence[1], lines: code });
      continue;
    }
    if (/^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", lines: quote });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push({ type: "bullet", text: bullet[1] });
      i++;
      continue;
    }
    const numbered = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (numbered) {
      blocks.push({ type: "numbered", n: numbered[1], text: numbered[2] });
      i++;
      continue;
    }
    if (line.trim().length > 0) blocks.push({ type: "para", text: line });
    i++;
  }
  return blocks;
}

// Bold / italic / code / links only — no prose recoloring.
const INLINE_RE = /(\*\*[^*\n]+\*\*|\*[^*\n]+?\*|`[^`\n]+`|\[[^\]]+\]\([^)]+\))/g;

function renderInline(text: string, theme: Theme): React.ReactNode[] {
  return text.split(INLINE_RE).map((part, i) => {
    if (!part) return null;
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      return (
        <Text key={i} bold color={theme.highlight}>
          {part.slice(2, -2)}
        </Text>
      );
    }
    if (part.length > 2 && part.startsWith("*") && part.endsWith("*") && !part.startsWith("**")) {
      return (
        <Text key={i} italic color={theme.text}>
          {part.slice(1, -1)}
        </Text>
      );
    }
    // Inline code: soft accent only — never solid background chips
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      return (
        <Text key={i} color={theme.accent}>
          {part.slice(1, -1)}
        </Text>
      );
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      return (
        <Text key={i} color={theme.accent} underline>
          {link[1]}
        </Text>
      );
    }
    return (
      <Text key={i} color={theme.text}>
        {part}
      </Text>
    );
  });
}

function CodeBlock({ lang, lines, theme }: { lang: string; lines: string[]; theme: Theme }) {
  const shown = lines.slice(0, 60);
  const more = lines.length - shown.length;
  return (
    <Box flexDirection="column" marginLeft={1} marginY={0}>
      {lang ? (
        <Text color={theme.accentDim}>
          {lang}
        </Text>
      ) : null}
      {shown.map((line, j) => (
        <Text key={j}>
          <Text color={theme.accentDim}>
            {String(j + 1).padStart(3, " ")}{" "}
          </Text>
          {tokenizeLine(line, lang).map((tok, k) => {
            // Only color real tokens — plain stays default text color
            const c = tok.kind === "plain" ? theme.text : colorFor(tok.kind, theme);
            return (
              <Text key={k} color={c}>
                {tok.text}
              </Text>
            );
          })}
        </Text>
      ))}
      {more > 0 ? (
        <Text color={theme.accentDim}>
          … +{more} lines
        </Text>
      ) : null}
    </Box>
  );
}

export const Markdown = memo(function Markdown({ children, theme }: { children: string; theme?: Theme }) {
  const t = theme ?? THEMES.dev;
  return (
    <Box flexDirection="column">
      {parseBlocks(children).map((block, i) => {
        switch (block.type) {
          case "code":
            return <CodeBlock key={i} lang={block.lang} lines={block.lines} theme={t} />;
          case "heading":
            return (
              <Text key={i} bold color={t.accent}>
                {renderInline(block.text, t)}
              </Text>
            );
          case "quote":
            return (
              <Box key={i} flexDirection="column">
                {block.lines.map((line, j) => (
                  <Text key={j} color={t.accentDim}>
                    {"│ "}
                    <Text color={t.text}>{line}</Text>
                  </Text>
                ))}
              </Box>
            );
          case "bullet":
            return (
              <Text key={i}>
                <Text color={t.accent}>{"  • "}</Text>
                {renderInline(block.text, t)}
              </Text>
            );
          case "numbered":
            return (
              <Text key={i}>
                <Text color={t.accent}>{`  ${block.n}. `}</Text>
                {renderInline(block.text, t)}
              </Text>
            );
          case "hr":
            return (
              <Text key={i} color={t.border}>
                {"─".repeat(40)}
              </Text>
            );
          case "para":
            return <Text key={i}>{renderInline(block.text, t)}</Text>;
        }
      })}
    </Box>
  );
});
