import type { NotionPage } from "./notion-types";
import { notionSearchExclusionPropertyName } from "./page-metadata";
import { readString, readUnknownRecord } from "./value-readers";

export type NotionSearchProperty = {
  readonly name: string;
  readonly value: string;
};

export function extractNotionSearchProperties(page: NotionPage): NotionSearchProperty[] {
  return Object.entries(page.properties ?? {}).flatMap(([name, value]) => {
    if (name === notionSearchExclusionPropertyName) {
      return [];
    }
    const property = readUnknownRecord(value);
    if (!property || property.type === "title") {
      return [];
    }
    const propertyValue = extractPropertyValue(property);
    return propertyValue ? [{ name, value: propertyValue }] : [];
  });
}

function extractPropertyValue(property: Record<string, unknown>): string | null {
  const type = readString(property.type);
  if (!type) {
    return null;
  }
  switch (type) {
    case "rich_text":
      return richTextToPlainText(property.rich_text);
    case "number":
      return readNumber(property.number);
    case "select":
    case "status":
      return readString(readUnknownRecord(property[type])?.name);
    case "multi_select":
      return readNamedValues(property.multi_select);
    case "date":
      return readDate(property.date);
    case "people":
      return readPeople(property.people);
    case "files":
      return readNamedValues(property.files);
    case "checkbox":
      return typeof property.checkbox === "boolean" ? String(property.checkbox) : null;
    case "url":
    case "email":
    case "phone_number":
    case "created_time":
    case "last_edited_time":
      return readString(property[type]);
    case "created_by":
    case "last_edited_by":
      return readPerson(property[type]);
    case "formula":
    case "rollup":
      return readTypedValue(property[type]);
    case "unique_id":
      return readUniqueId(property.unique_id);
    case "verification":
      return readVerification(property.verification);
    case "place":
      return readPlace(property.place);
    default:
      return null;
  }
}

function readTypedValue(value: unknown): string | null {
  const record = readUnknownRecord(value);
  const type = readString(record?.type);
  if (!record || !type) {
    return null;
  }
  switch (type) {
    case "string":
      return readString(record.string);
    case "number":
      return readNumber(record.number);
    case "boolean":
      return typeof record.boolean === "boolean" ? String(record.boolean) : null;
    case "date":
      return readDate(record.date);
    case "array":
      return readTypedValues(record.array);
    default:
      return null;
  }
}

function readTypedValues(value: unknown) {
  if (!Array.isArray(value)) {
    return null;
  }
  return joinValues(
    value.map((entry) => {
      const record = readUnknownRecord(entry);
      return record ? extractPropertyValue(record) : null;
    }),
  );
}

function richTextToPlainText(value: unknown) {
  if (!Array.isArray(value)) {
    return null;
  }
  return readString(
    value.map((entry) => readString(readUnknownRecord(entry)?.plain_text) ?? "").join(""),
  );
}

function readNamedValues(value: unknown) {
  if (!Array.isArray(value)) {
    return null;
  }
  return joinValues(value.map((entry) => readString(readUnknownRecord(entry)?.name)));
}

function readPeople(value: unknown) {
  if (!Array.isArray(value)) {
    return null;
  }
  return joinValues(value.map(readPerson));
}

function readPerson(value: unknown) {
  const person = readUnknownRecord(value);
  return readString(person?.name) ?? readString(readUnknownRecord(person?.person)?.email);
}

function readDate(value: unknown) {
  const date = readUnknownRecord(value);
  const start = readString(date?.start);
  if (!start) {
    return null;
  }
  const end = readString(date?.end);
  return end ? `${start} - ${end}` : start;
}

function readUniqueId(value: unknown) {
  const uniqueId = readUnknownRecord(value);
  const number = readNumber(uniqueId?.number);
  if (!number) {
    return null;
  }
  return `${readString(uniqueId?.prefix) ?? ""}${number}`;
}

function readVerification(value: unknown) {
  const verification = readUnknownRecord(value);
  return readString(verification?.state) ?? readString(verification?.status);
}

function readPlace(value: unknown) {
  const place = readUnknownRecord(value);
  return joinValues([readString(place?.name), readString(place?.address)]);
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

function joinValues(values: readonly (string | null)[]) {
  const populated = values.filter((value): value is string => Boolean(value));
  return populated.length > 0 ? populated.join(", ") : null;
}
