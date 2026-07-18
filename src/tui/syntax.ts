// Lightweight token highlighter for fenced code blocks (no deps).
// Covers TS/JS/JSON/Python/Shell/generic well enough for a TUI.

import type { Theme } from "./theme.js";

export type TokenKind =
  | "plain"
  | "keyword"
  | "string"
  | "number"
  | "comment"
  | "type"
  | "fn"
  | "punct"
  | "property";

export interface Token {
  kind: TokenKind;
  text: string;
}

const KW =
  /^(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|class|extends|implements|import|from|export|default|async|await|try|catch|finally|throw|new|typeof|instanceof|in|of|void|null|undefined|true|false|this|super|yield|interface|type|enum|namespace|as|is|keyof|readonly|public|private|protected|static|abstract|override|get|set|with|def|elif|except|raise|pass|lambda|None|True|False|and|or|not|print|match|case|fi|then|esac|done|echo|export|local|return)$/;

const TYPE_RE = /^[A-Z][A-Za-z0-9_]*$/;

function colorFor(kind: TokenKind, theme: Theme): string | undefined {
  // Soft palette for code fences only — never scream over prose.
  switch (kind) {
    case "keyword":
      return theme.accent;
    case "string":
      return theme.success;
    case "number":
      return theme.warn;
    case "comment":
      return theme.accentDim;
    case "type":
      return theme.accent;
    case "fn":
      return theme.highlight;
    case "property":
      return theme.text;
    case "punct":
      return theme.accentDim;
    default:
      return theme.text;
  }
}

/** Tokenize one source line. */
export function tokenizeLine(line: string, lang = ""): Token[] {
  const tokens: Token[] = [];
  const L = lang.toLowerCase();
  let i = 0;

  const push = (kind: TokenKind, text: string) => {
    if (text) tokens.push({ kind, text });
  };

  // full-line comments
  if (/^\s*(\/\/|#|--)/.test(line) || (L === "python" && /^\s*#/.test(line))) {
    return [{ kind: "comment", text: line }];
  }

  while (i < line.length) {
    const ch = line[i];

    // whitespace
    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < line.length && /\s/.test(line[j])) j++;
      push("plain", line.slice(i, j));
      i = j;
      continue;
    }

    // line comment mid-line
    if (line.startsWith("//", i) || (ch === "#" && L !== "csharp")) {
      push("comment", line.slice(i));
      break;
    }

    // strings
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line[j] === q) {
          j++;
          break;
        }
        j++;
      }
      push("string", line.slice(i, j));
      i = j;
      continue;
    }

    // numbers
    if (/\d/.test(ch) || (ch === "." && /\d/.test(line[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < line.length && /[\d._xXa-fA-Fn]/.test(line[j])) j++;
      push("number", line.slice(i, j));
      i = j;
      continue;
    }

    // identifiers / keywords
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < line.length && /[A-Za-z0-9_$]/.test(line[j])) j++;
      const word = line.slice(i, j);
      // function call?
      let k = j;
      while (k < line.length && /\s/.test(line[k])) k++;
      if (line[k] === "(") push("fn", word);
      else if (KW.test(word)) push("keyword", word);
      else if (TYPE_RE.test(word)) push("type", word);
      else push("plain", word);
      i = j;
      continue;
    }

    // punctuation / operators
    let j = i + 1;
    while (j < line.length && /[^\sA-Za-z0-9_$"'`]/.test(line[j]) && line[j] !== "#" && !line.startsWith("//", j)) {
      j++;
    }
    push("punct", line.slice(i, j));
    i = j;
  }

  return tokens.length ? tokens : [{ kind: "plain", text: line || " " }];
}

export { colorFor };
