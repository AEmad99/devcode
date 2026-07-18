import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "devcode";

const CAP = 24 * 1024; // head+tail cap for tool output

function spill(text: string, cap = CAP): string {
  if (text.length <= cap) return text;
  const head = Math.floor(cap * 0.6);
  const tail = cap - head;
  return `${text.slice(0, head)}\n\n…[${text.length - cap} bytes omitted]…\n\n${text.slice(-tail)}`;
}

function htmlToText(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[#\w]+;/g, " ");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ");
  return s.trim();
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  // Tests inject offline fixtures via data: URLs or DEVCODE_WEB_FETCH_URL.
  const override = process.env.DEVCODE_WEB_FETCH_URL;
  const target = override && !url.startsWith("data:") ? override : url;
  const res = await fetch(target, {
    signal,
    headers: { "User-Agent": "DevCode/0.1 (web_fetch)" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const ct = res.headers.get("content-type") ?? "";
  const body = await res.text();
  if (ct.includes("html") || /<!DOCTYPE|<html/i.test(body.slice(0, 200))) {
    return htmlToText(body);
  }
  return body;
}

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

function parseDdgHtml(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  // DuckDuckGo HTML lite results: result__a links + result__snippet
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null && hits.length < 8) {
    let href = m[1];
    // DDG wraps redirects: //duckduckgo.com/l/?uddg=<encoded>
    const uddg = /uddg=([^&]+)/.exec(href);
    if (uddg) {
      try {
        href = decodeURIComponent(uddg[1]);
      } catch {
        /* keep */
      }
    }
    const title = htmlToText(m[2]).slice(0, 200);
    // snippet often follows within ~800 chars
    const tail = html.slice(m.index, m.index + 1200);
    const snipM = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)/i.exec(tail);
    const snippet = snipM ? htmlToText(snipM[1]).slice(0, 300) : "";
    if (href.startsWith("http")) hits.push({ title, url: href, snippet });
  }
  // Fallback: plain <a href="http...">title</a> near results
  if (hits.length === 0) {
    const plain = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = plain.exec(html)) !== null && hits.length < 8) {
      const href = m[1];
      if (/duckduckgo\.com|javascript:/i.test(href)) continue;
      hits.push({ title: htmlToText(m[2]).slice(0, 200), url: href, snippet: "" });
    }
  }
  return hits;
}

export default function (api: ExtensionAPI) {
  api.registerTool({
    name: "web_fetch",
    description: "Fetch a URL and return its text content (HTML stripped). Self-capped ~24KB.",
    schema: Type.Object({
      url: Type.String({ description: "HTTP(S) URL to fetch" }),
    }),
    async execute(_id, params, signal) {
      try {
        const url = String(params.url ?? "");
        if (!/^https?:\/\//i.test(url) && !url.startsWith("data:")) {
          return { content: "url must start with http:// or https://", is_error: true };
        }
        const text = await fetchText(url, signal);
        return { content: spill(text) };
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), is_error: true };
      }
    },
  });

  api.registerTool({
    name: "web_search",
    description: "Search the web (DuckDuckGo HTML, no API key). Returns titles, URLs, and snippets.",
    schema: Type.Object({
      query: Type.String({ description: "Search query" }),
    }),
    async execute(_id, params, signal) {
      try {
        const query = String(params.query ?? "").trim();
        if (!query) return { content: "query is required", is_error: true };
        const override = process.env.DEVCODE_WEB_SEARCH_URL;
        const url =
          override ??
          `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const res = await fetch(url, {
          signal,
          headers: {
            "User-Agent": "DevCode/0.1 (web_search)",
            Accept: "text/html",
          },
        });
        if (!res.ok) return { content: `HTTP ${res.status} ${res.statusText}`, is_error: true };
        const html = await res.text();
        const hits = parseDdgHtml(html);
        if (hits.length === 0) return { content: "No results found." };
        const lines = hits.map((h, i) => {
          const snip = h.snippet ? `\n   ${h.snippet}` : "";
          return `${i + 1}. ${h.title}\n   ${h.url}${snip}`;
        });
        return { content: spill(lines.join("\n\n")) };
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), is_error: true };
      }
    },
  });
}
