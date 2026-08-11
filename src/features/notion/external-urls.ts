import type { NotionBlock } from "./notion-types";
import { readString, readUnknownRecord } from "./value-readers";

export function extractExternalUrlsFromBlocks(blocks: readonly NotionBlock[]) {
  const urls = new Set<string>();
  for (const block of blocks) {
    const type = block.type;
    const value = typeof type === "string" ? block[type] : undefined;
    for (const url of extractExternalUrlsFromBlockValue(value)) {
      urls.add(url);
    }
  }
  return [...urls];
}

function extractExternalUrlsFromBlockValue(value: unknown) {
  const urls = new Set<string>();
  const record = readUnknownRecord(value);
  if (!record) {
    return [];
  }
  addExternalUrl(urls, record.url);
  addExternalUrl(urls, readUnknownRecord(record.external)?.url);
  for (const captionUrl of extractUrlsFromRichText(record.caption)) {
    urls.add(captionUrl);
  }
  for (const richTextUrl of extractUrlsFromRichText(record.rich_text)) {
    urls.add(richTextUrl);
  }
  return [...urls];
}

function extractUrlsFromRichText(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  const urls = new Set<string>();
  for (const entry of value) {
    const record = readUnknownRecord(entry);
    addExternalUrl(urls, record?.href);
    const textLink = readUnknownRecord(readUnknownRecord(record?.text)?.link);
    addExternalUrl(urls, textLink?.url);
  }
  return [...urls];
}

function addExternalUrl(urls: Set<string>, value: unknown) {
  const url = readString(value);
  if (!url || !isIndexableExternalUrl(url)) {
    return;
  }
  urls.add(url);
}

export function isIndexableExternalUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname.includes(":") ||
    hostname === "localhost" ||
    hostname === "0.0.0.0" ||
    hostname.startsWith("127.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    hostname === "169.254.169.254" ||
    hostname === "100.100.100.200" ||
    hostname.endsWith(".local")
  ) {
    return false;
  }
  const octets = hostname.split(".").map((part) => Number(part));
  if (octets.length === 4 && octets.every((part) => Number.isInteger(part))) {
    const [first = 0, second = 0] = octets;
    if (first === 172 && second >= 16 && second <= 31) {
      return false;
    }
  }
  return true;
}
