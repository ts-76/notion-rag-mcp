import type { IndexedNotionSearchResult, NotionChunkRow, NotionPageRow } from "./types";

const maxD1LikePatternBytes = 50;
const japaneseSegmentationThresholdBytes = 24;
const minimumConfidentSearchScore = 0.65;
const utf8Encoder = new TextEncoder();
const japaneseStopWords = new Set([
  "から",
  "こと",
  "これ",
  "され",
  "して",
  "する",
  "その",
  "ため",
  "です",
  "では",
  "という",
  "とき",
  "ない",
  "など",
  "について",
  "ので",
  "ます",
  "まで",
  "もの",
  "よう",
]);

export function mergeSearchResults(results: readonly IndexedNotionSearchResult[]) {
  const byChunkId = new Map<string, IndexedNotionSearchResult>();
  for (const result of results) {
    const existing = byChunkId.get(result.chunkId);
    if (!existing || result.score > existing.score) {
      byChunkId.set(result.chunkId, result);
    }
  }
  return [...byChunkId.values()].sort((left, right) => right.score - left.score);
}

export function rerankSearchResults(results: readonly IndexedNotionSearchResult[], query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  const terms = extractKeywordTerms(query).map((term) => term.toLowerCase());
  if (!normalizedQuery || terms.length === 0) {
    return [...results];
  }
  return results
    .map((result) => ({
      ...result,
      score: result.score + calculateRerankBoost(result, normalizedQuery, terms),
    }))
    .sort((left, right) => right.score - left.score);
}

export function selectPageGroupedSearchResults(
  results: readonly IndexedNotionSearchResult[],
  limit: number,
) {
  const bestByPageId = new Map<
    string,
    { readonly result: IndexedNotionSearchResult; readonly firstSeenIndex: number }
  >();
  for (const [index, result] of results.entries()) {
    const existing = bestByPageId.get(result.pageId);
    if (!existing) {
      bestByPageId.set(result.pageId, { result, firstSeenIndex: index });
      continue;
    }
    if (result.score > existing.result.score) {
      bestByPageId.set(result.pageId, {
        result,
        firstSeenIndex: existing.firstSeenIndex,
      });
    }
  }
  return [...bestByPageId.values()]
    .sort(
      (left, right) =>
        right.result.score - left.result.score || left.firstSeenIndex - right.firstSeenIndex,
    )
    .slice(0, Math.max(0, limit))
    .map(({ result }) => result);
}

export function selectConfidentSearchResults(results: readonly IndexedNotionSearchResult[]) {
  const bestScore = results[0]?.score ?? 0;
  return bestScore >= minimumConfidentSearchScore ? [...results] : [];
}

function calculateRerankBoost(
  result: IndexedNotionSearchResult,
  normalizedQuery: string,
  terms: readonly string[],
) {
  const title = result.title.toLowerCase();
  const text = result.text.toLowerCase();
  const titleCoverage = terms.filter((term) => title.includes(term)).length / terms.length;
  const textCoverage = terms.filter((term) => text.includes(term)).length / terms.length;
  const exactTitleBoost = title.includes(normalizedQuery) ? 0.2 : 0;
  const exactTextBoost = text.includes(normalizedQuery) ? 0.08 : 0;
  return exactTitleBoost + exactTextBoost + titleCoverage * 0.12 + textCoverage * 0.04;
}

export function mapNotionSearchRow(
  row: NotionChunkRow & NotionPageRow,
  options: { readonly score: number; readonly keywordBoost?: number },
): IndexedNotionSearchResult {
  return {
    chunkId: row.chunk_id,
    pageId: row.page_id,
    sourceId: row.source_id,
    title: row.title,
    url: row.url ?? "",
    text: row.text,
    score: options.score + (options.keywordBoost ?? 0),
    lastEditedTime: row.last_edited_time ?? "",
    indexedAt: row.indexed_at ?? "",
  };
}

export function calculateKeywordBoost(row: NotionChunkRow & NotionPageRow, query: string) {
  const terms = extractKeywordTerms(query);
  const title = row.title.toLowerCase();
  const text = row.text.toLowerCase();
  const titleMatches = terms.filter((term) => title.includes(term.toLowerCase())).length;
  const textMatches = terms.filter((term) => text.includes(term.toLowerCase())).length;
  return 0.4 + titleMatches * 0.25 + textMatches * 0.12;
}

export function extractKeywordTerms(query: string) {
  return [
    ...new Set(
      query
        .split(/[\s　]+/)
        .map((term) => term.trim())
        .filter(Boolean)
        .flatMap(segmentJapaneseSearchTerm),
    ),
  ];
}

export function createFtsMatchQuery(query: string) {
  const terms = [query.trim(), ...extractKeywordTerms(query)].filter(Boolean);
  const quotedTerms = [...new Set(terms)]
    .slice(0, 5)
    .map((term) => `"${term.replaceAll('"', '""')}"`);
  return quotedTerms.length > 0 ? quotedTerms.join(" OR ") : "";
}

export function escapeLikePattern(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export function createD1LikePattern(value: string) {
  let escapedValue = "";
  for (const character of value.trim()) {
    const candidate = escapedValue + escapeLikePattern(character);
    if (utf8ByteLength(`%${candidate}%`) > maxD1LikePatternBytes) {
      break;
    }
    escapedValue = candidate;
  }
  return escapedValue ? `%${escapedValue}%` : null;
}

function segmentJapaneseSearchTerm(term: string) {
  if (!containsJapanese(term) || utf8ByteLength(term) <= japaneseSegmentationThresholdBytes) {
    return [term];
  }
  const segments = [...new Intl.Segmenter("ja", { granularity: "word" }).segment(term)]
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment.trim())
    .filter(isMeaningfulJapaneseSegment)
    .map((segment, index) => ({
      segment,
      index,
      score: countHanCharacters(segment) * 10 + [...segment].length,
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ segment }) => segment);
  return segments.length > 0 ? segments : [term];
}

function isMeaningfulJapaneseSegment(segment: string) {
  if (!segment || japaneseStopWords.has(segment)) {
    return false;
  }
  if (/^[\p{Script=Hiragana}\p{Script=Katakana}ー]$/u.test(segment)) {
    return false;
  }
  return /[\p{L}\p{N}]/u.test(segment);
}

function containsJapanese(value: string) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value);
}

function countHanCharacters(value: string) {
  return [...value].filter((character) => /\p{Script=Han}/u.test(character)).length;
}

function utf8ByteLength(value: string) {
  return utf8Encoder.encode(value).byteLength;
}

export function isFtsSearchUnavailableError(error: unknown) {
  const message = String(error).toLowerCase();
  return (
    (message.includes("notion_chunks_fts") && message.includes("no such table")) ||
    message.includes("fts5") ||
    message.includes("malformed match expression")
  );
}
