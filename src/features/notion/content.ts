import type { NotionBlock } from "./notion-types";
import type { NotionSearchProperty } from "./page-properties";
import { readString, readUnknownRecord } from "./value-readers";

export * from "./external-urls";
export * from "./notion-types";
export * from "./page-metadata";
export * from "./page-properties";
export * from "./value-readers";

const maxChunkCharacters = 1800;

type NotionTextSegment = {
  readonly text: string;
  readonly headingPath: readonly string[];
};

export function createNotionPageChunks(
  title: string,
  blocks: readonly NotionBlock[],
  properties: readonly NotionSearchProperty[] = [],
) {
  const pageTitle = title.trim() || "Untitled Notion page";
  const segments = [...propertiesToTextSegments(properties), ...blocksToTextSegments(blocks)];
  if (segments.length === 0) {
    return [formatChunkText(pageTitle, [], [pageTitle])];
  }
  return chunkTextSegments(pageTitle, segments);
}

function propertiesToTextSegments(properties: readonly NotionSearchProperty[]) {
  return properties.map((property) => ({
    headingPath: ["Notion properties"],
    text: `- ${property.name}: ${property.value}`,
  }));
}

export function createExternalMarkdownChunks(title: string, markdown: string) {
  const pageTitle = title.trim() || "Untitled external document";
  const body = markdown.trim();
  if (!body) {
    return [formatChunkText(pageTitle, [], [pageTitle])];
  }
  return chunkTextSegments(pageTitle, [{ headingPath: [], text: body }]);
}

function blockToPlainTextLine(block: NotionBlock) {
  const type = block.type;
  const value = typeof type === "string" ? block[type] : undefined;
  if (type === "child_page") {
    return block.child_page?.title ?? "";
  }
  if (type === "child_database") {
    return block.child_database?.title ?? "";
  }
  if (type === "table_row") {
    return extractTableRowText(value);
  }
  if (type === "equation") {
    return extractEquationText(value);
  }
  return [extractRichText(value), extractCaptionText(value), extractUrlText(value)]
    .filter(Boolean)
    .join("\n");
}

function blocksToTextSegments(blocks: readonly NotionBlock[]) {
  const segments: NotionTextSegment[] = [];
  const headingPath: string[] = [];
  for (const block of blocks) {
    const text = blockToPlainTextLine(block).trim();
    if (!text) {
      continue;
    }

    const headingLevel = getHeadingLevel(block.type);
    if (headingLevel) {
      headingPath.splice(headingLevel - 1, headingPath.length, text);
      segments.push({
        headingPath: headingPath.slice(),
        text: `${"#".repeat(headingLevel)} ${text}`,
      });
      continue;
    }

    segments.push({
      headingPath: headingPath.slice(),
      text: formatBlockText(block, text),
    });
  }
  return segments;
}

function chunkTextSegments(title: string, segments: readonly NotionTextSegment[]) {
  const chunks: string[] = [];
  let currentHeadingPath: readonly string[] = [];
  let currentLines: string[] = [];

  function flush() {
    if (currentLines.length === 0) {
      return;
    }
    chunks.push(formatChunkText(title, currentHeadingPath, currentLines));
    currentLines = [];
  }

  for (const segment of segments) {
    const segmentHeadingKey = segment.headingPath.join("\u0000");
    const currentHeadingKey = currentHeadingPath.join("\u0000");
    if (currentLines.length > 0 && segmentHeadingKey !== currentHeadingKey) {
      flush();
    }
    currentHeadingPath = segment.headingPath;

    for (const piece of splitLongText(
      segment.text,
      maxChunkBodyCharacters(title, currentHeadingPath),
    )) {
      const nextLines = [...currentLines, piece];
      if (
        currentLines.length > 0 &&
        formatChunkText(title, currentHeadingPath, nextLines).length > maxChunkCharacters
      ) {
        flush();
      }
      currentLines.push(piece);
    }
  }

  flush();
  return chunks;
}

function formatChunkText(title: string, headingPath: readonly string[], lines: readonly string[]) {
  return [
    `Page: ${title}`,
    headingPath.length > 0 ? `Section: ${headingPath.join(" > ")}` : "",
    "",
    ...lines,
  ]
    .filter((line, index) => index === 2 || line.length > 0)
    .join("\n")
    .trim();
}

function maxChunkBodyCharacters(title: string, headingPath: readonly string[]) {
  return Math.max(400, maxChunkCharacters - formatChunkText(title, headingPath, []).length - 2);
}

function splitLongText(text: string, maxLength: number) {
  if (text.length <= maxLength) {
    return [text];
  }
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += maxLength) {
    chunks.push(text.slice(offset, offset + maxLength));
  }
  return chunks;
}

function getHeadingLevel(type: string | undefined) {
  if (type === "heading_1") {
    return 1;
  }
  if (type === "heading_2") {
    return 2;
  }
  if (type === "heading_3") {
    return 3;
  }
  return 0;
}

function formatBlockText(block: NotionBlock, text: string) {
  switch (block.type) {
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `1. ${text}`;
    case "to_do": {
      const checked = readUnknownRecord(block.to_do)?.checked === true;
      return `${checked ? "[x]" : "[ ]"} ${text}`;
    }
    case "toggle":
      return `Toggle: ${text}`;
    case "quote":
      return `Quote: ${text}`;
    case "callout":
      return `Callout${formatNotionIcon(block.callout)}: ${text}`;
    case "code":
      return `Code${formatCodeLanguage(block.code)}:\n${text}`;
    case "table_row":
      return `Table row: ${text}`;
    case "child_page":
      return `Child page: ${text}`;
    case "child_database":
      return `Child database: ${text}`;
    case "bookmark":
      return `Bookmark: ${text}`;
    case "link_preview":
      return `Link preview: ${text}`;
    case "embed":
      return `Embed: ${text}`;
    case "image":
      return `Image: ${text}`;
    case "video":
      return `Video: ${text}`;
    case "file":
      return `File: ${text}`;
    case "pdf":
      return `PDF: ${text}`;
    case "equation":
      return `Equation: ${text}`;
    default:
      return text;
  }
}

function extractRichText(value: unknown) {
  const richText = readUnknownRecord(value)?.rich_text;
  if (!Array.isArray(richText)) {
    return "";
  }
  return richText
    .map((entry) => readUnknownRecord(entry)?.plain_text)
    .filter((entry): entry is string => typeof entry === "string")
    .join("");
}

function extractCaptionText(value: unknown) {
  const caption = readUnknownRecord(value)?.caption;
  if (!Array.isArray(caption)) {
    return "";
  }
  const text = richTextArrayToPlainText(caption);
  return text ? `Caption: ${text}` : "";
}

function extractUrlText(value: unknown) {
  const record = readUnknownRecord(value);
  const url = readString(record?.url) ?? readString(readUnknownRecord(record?.external)?.url);
  return url ? `URL: ${url}` : "";
}

function extractTableRowText(value: unknown) {
  const cells = readUnknownRecord(value)?.cells;
  if (!Array.isArray(cells)) {
    return "";
  }
  return cells
    .map((cell) => (Array.isArray(cell) ? richTextArrayToPlainText(cell) : ""))
    .filter(Boolean)
    .join(" | ");
}

function extractEquationText(value: unknown) {
  return readString(readUnknownRecord(value)?.expression) ?? "";
}

function richTextArrayToPlainText(richText: readonly unknown[]) {
  return richText
    .map((entry) => readUnknownRecord(entry)?.plain_text)
    .filter((entry): entry is string => typeof entry === "string")
    .join("");
}

function formatNotionIcon(value: unknown) {
  const icon = readUnknownRecord(value)?.icon;
  const record = readUnknownRecord(icon);
  const emoji = readString(record?.emoji);
  return emoji ? ` ${emoji}` : "";
}

function formatCodeLanguage(value: unknown) {
  const language = readString(readUnknownRecord(value)?.language);
  return language ? ` (${language})` : "";
}
