import puppeteer from "@cloudflare/puppeteer";
import type { BrowserBinding } from "../../worker/bindings";
import { isIndexableExternalUrl } from "../notion/content";

const maxExternalMarkdownCharacters = 60_000;
const browserNavigationTimeoutMs = 30_000;

export type ExternalMarkdownDocument = {
  readonly title: string;
  readonly markdown: string;
  readonly finalUrl: string;
};

export async function fetchExternalMarkdown(input: {
  readonly browser: BrowserBinding;
  readonly url: string;
  readonly allowedHosts: ReadonlySet<string>;
}): Promise<ExternalMarkdownDocument> {
  if (!isAllowedExternalUrl(input.url, input.allowedHosts)) {
    throw new Error("external_url_not_allowed");
  }
  const browser = await puppeteer.launch(input.browser as Parameters<typeof puppeteer.launch>[0]);
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (isAllowedExternalUrl(request.url(), input.allowedHosts)) {
        void request.continue();
      } else {
        void request.abort("blockedbyclient");
      }
    });
    await page.goto(input.url, {
      timeout: browserNavigationTimeoutMs,
      waitUntil: "networkidle2",
    });
    const extracted = await page.evaluate(extractMarkdownFromDocument);
    const finalUrl = page.url();
    if (!isAllowedExternalUrl(finalUrl, input.allowedHosts)) {
      throw new Error("external_redirect_not_allowed");
    }
    return {
      title: extracted.title || new URL(input.url).hostname,
      markdown: extracted.markdown.slice(0, maxExternalMarkdownCharacters),
      finalUrl,
    };
  } finally {
    await browser.close();
  }
}

function isAllowedExternalUrl(url: string, allowedHosts: ReadonlySet<string>) {
  if (!isIndexableExternalUrl(url)) {
    return false;
  }
  return allowedHosts.has(new URL(url).hostname.toLowerCase());
}

function extractMarkdownFromDocument() {
  type ElementLike = {
    readonly tagName: string;
    readonly textContent: string | null;
    getAttribute(name: string): string | null;
  };
  type DocumentLike = {
    readonly title: string;
    readonly body: { readonly innerText: string };
    querySelector(selector: string): ElementLike | null;
    querySelectorAll(selector: string): ArrayLike<ElementLike>;
  };
  const documentRef = (globalThis as typeof globalThis & { readonly document: DocumentLike })
    .document;
  const locationRef = (globalThis as typeof globalThis & { readonly location: { href: string } })
    .location;
  const normalizeWhitespace = (value: string) => value.replace(/\s+/g, " ").trim();
  const normalizeMarkdown = (value: string) =>
    value
      .split("\n")
      .map((line) => normalizeWhitespace(line))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  const title = documentRef.title.trim();
  const parts: string[] = [];
  for (const element of Array.from(
    documentRef.querySelectorAll(
      "main h1, main h2, main h3, main p, main li, article h1, article h2, article h3, article p, article li",
    ),
  )) {
    const text = normalizeWhitespace(element.textContent ?? "");
    if (!text) {
      continue;
    }
    if (element.tagName === "H1") {
      parts.push(`# ${text}`);
    } else if (element.tagName === "H2") {
      parts.push(`## ${text}`);
    } else if (element.tagName === "H3") {
      parts.push(`### ${text}`);
    } else if (element.tagName === "LI") {
      parts.push(`- ${text}`);
    } else {
      parts.push(text);
    }
  }
  const markdown = parts.length > 0 ? parts.join("\n\n") : documentRef.body.innerText;
  return {
    title,
    finalUrl: locationRef.href,
    markdown: normalizeMarkdown(markdown),
  };
}
