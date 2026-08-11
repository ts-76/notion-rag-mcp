import type { NotionBlock, NotionDatabase, NotionPage } from "./notion-types";
import { readUnknownRecord } from "./value-readers";

export const notionSearchExclusionPropertyName = "wiki検索対象外";

export function extractChildDatabaseIds(blocks: readonly NotionBlock[]) {
  return blocks
    .filter((block) => block.type === "child_database")
    .map((block) => normalizeNotionId(block.id));
}

export function extractChildPageIds(blocks: readonly NotionBlock[]) {
  return blocks
    .filter((block) => block.type === "child_page")
    .map((block) => normalizeNotionId(block.id));
}

export function extractParentPageId(page: NotionPage) {
  const parent = readUnknownRecord(page.parent);
  if (parent?.type !== "page_id" || typeof parent.page_id !== "string") {
    return null;
  }
  return normalizeNotionId(parent.page_id);
}

export function extractNotionPageTitle(page: NotionPage) {
  for (const property of Object.values(page.properties ?? {})) {
    const record = readUnknownRecord(property);
    if (record?.type !== "title" || !Array.isArray(record.title)) {
      continue;
    }
    const title = record.title
      .map((entry) => readUnknownRecord(entry)?.plain_text)
      .filter((entry): entry is string => typeof entry === "string")
      .join("");
    if (title.trim()) {
      return title;
    }
  }
  return "Untitled Notion page";
}

export function isNotionPageExcludedFromSearch(page: NotionPage) {
  const property = readUnknownRecord(page.properties?.[notionSearchExclusionPropertyName]);
  return property?.type === "checkbox" && property.checkbox === true;
}

export function estimateTokenCount(text: string) {
  return Math.ceil(text.length / 4);
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function normalizeNotionId(value: string) {
  const compact = value.replaceAll("-", "").trim();
  if (compact.length !== 32) {
    return value.trim();
  }
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join("-");
}

export function isNotionBlock(value: unknown): value is NotionBlock {
  return typeof readUnknownRecord(value)?.id === "string";
}

export function isNotionPage(value: unknown): value is NotionPage {
  const record = readUnknownRecord(value);
  return record?.object === "page" && typeof record.id === "string";
}

export function isNotionDatabase(value: unknown): value is NotionDatabase {
  const record = readUnknownRecord(value);
  return record?.object === "database" && typeof record.id === "string";
}
