import { inflateRawSync } from "node:zlib";

export const maxAttachmentBytes = 5 * 1024 * 1024;

const allowedTypes: Record<string, { contentType: string; kind: string }> = {
  png: { contentType: "image/png", kind: "png" },
  jpg: { contentType: "image/jpeg", kind: "jpeg" },
  gif: { contentType: "image/gif", kind: "gif" },
  webp: { contentType: "image/webp", kind: "webp" },
  pdf: { contentType: "application/pdf", kind: "pdf" },
  txt: { contentType: "text/plain; charset=utf-8", kind: "text" },
  md: { contentType: "text/markdown; charset=utf-8", kind: "text" },
  csv: { contentType: "text/csv; charset=utf-8", kind: "text" },
  json: { contentType: "application/json; charset=utf-8", kind: "json" },
  docx: { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "docx" },
  xlsx: { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "xlsx" },
};

function unsafeText(bytes: Buffer) {
  const prefix = bytes.toString("utf8").replace(/^\uFEFF/, "");
  if (/<\s*svg\b/i.test(prefix)) return "SVG files are not allowed.";
  if (/<!doctype\s+html\b|<\s*(?:html|head|body|script|iframe|object|embed|meta|form|input|textarea|title|style)\b/i.test(prefix)) {
    return "HTML files are not allowed.";
  }
  return null;
}

function executable(bytes: Buffer) {
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) return true;
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return true;
  if (bytes.length >= 4 && ["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca"].includes(bytes.subarray(0, 4).toString("hex"))) return true;
  return bytes.subarray(0, 2).toString("ascii") === "#!";
}

function isPng(bytes: Buffer) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") return false;
  let offset = 8;
  let hasImageData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > bytes.length) return false;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") hasImageData = true;
    if (type === "IEND") return length === 0 && hasImageData && end === bytes.length;
    offset = end;
  }
  return false;
}

function isJpeg(bytes: Buffer) {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9) return true;
    if (marker === 0xda) return bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return false;
    offset += length;
  }
  return false;
}

function isGif(bytes: Buffer) {
  return bytes.length >= 14 && (bytes.toString("ascii", 0, 6) === "GIF87a" || bytes.toString("ascii", 0, 6) === "GIF89a") && bytes.at(-1) === 0x3b;
}

function isWebp(bytes: Buffer) {
  if (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP" || bytes.readUInt32LE(4) !== bytes.length - 8) return false;
  const chunkType = bytes.toString("ascii", 12, 16);
  const chunkLength = bytes.readUInt32LE(16);
  return ["VP8 ", "VP8L", "VP8X"].includes(chunkType) && chunkLength > 0 && 20 + chunkLength + (chunkLength % 2) <= bytes.length;
}

function zipOfficeKind(bytes: Buffer) {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) return null;
  const searchStart = Math.max(0, bytes.length - 65557);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= searchStart; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) { endOffset = offset; break; }
  }
  if (endOffset < 0) return null;
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const directoryOffset = bytes.readUInt32LE(endOffset + 16);
  const directorySize = bytes.readUInt32LE(endOffset + 12);
  if (directoryOffset + directorySize > endOffset) return null;
  const entries = new Map<string, { compressedSize: number; method: number; localOffset: number }>;
  let offset = directoryOffset;
  try {
    for (let index = 0; index < entryCount; index += 1) {
      if (offset + 46 > endOffset || bytes.readUInt32LE(offset) !== 0x02014b50) return null;
      const flags = bytes.readUInt16LE(offset + 8);
      const method = bytes.readUInt16LE(offset + 10);
      const compressedSize = bytes.readUInt32LE(offset + 20);
      const nameLength = bytes.readUInt16LE(offset + 28);
      const extraLength = bytes.readUInt16LE(offset + 30);
      const commentLength = bytes.readUInt16LE(offset + 32);
      const localOffset = bytes.readUInt32LE(offset + 42);
      const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
      if (flags & 1 || nextOffset > endOffset) return null;
      const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
      entries.set(name, { compressedSize, method, localOffset });
      offset = nextOffset;
    }
  } catch {
    return null;
  }
  const contentTypes = entries.get("[Content_Types].xml");
  if (!contentTypes) return null;
  const localOffset = contentTypes.localOffset;
  if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) return null;
  const nameLength = bytes.readUInt16LE(localOffset + 26);
  const extraLength = bytes.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + contentTypes.compressedSize;
  if (dataEnd > bytes.length) return null;
  try {
    const compressed = bytes.subarray(dataStart, dataEnd);
    const xml = contentTypes.method === 0
      ? compressed.toString("utf8")
      : contentTypes.method === 8
        ? inflateRawSync(compressed, { maxOutputLength: 1024 * 1024 }).toString("utf8")
        : "";
    if (entries.has("word/document.xml") && xml.includes("application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml")) return "docx";
    if (entries.has("xl/workbook.xml") && xml.includes("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml")) return "xlsx";
  } catch {
    return null;
  }
  return null;
}

function textIsValid(bytes: Buffer) {
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
    return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value);
  } catch {
    return false;
  }
}

export function validateAttachmentFile(fileName: string, bytes: Buffer) {
  if (!bytes.length) return { error: "The selected file is empty.", status: 400 } as const;
  if (bytes.length > maxAttachmentBytes) return { error: "Files must be 5 MB or smaller.", status: 413 } as const;
  const unsafe = unsafeText(bytes);
  if (unsafe) return { error: unsafe, status: 415 } as const;
  if (executable(bytes)) return { error: "Executable files are not allowed.", status: 415 } as const;
  const extension = fileName.split(".").at(-1)?.toLowerCase() ?? "";
  const allowed = allowedTypes[extension];
  if (!allowed) return { error: "Unsupported file type. Allowed: PNG, JPG, GIF, WEBP, PDF, TXT, MD, CSV, JSON, DOCX, XLSX.", status: 415 } as const;

  let detected: string | null = null;
  if (isPng(bytes)) detected = "png";
  else if (isJpeg(bytes)) detected = "jpeg";
  else if (isGif(bytes)) detected = "gif";
  else if (isWebp(bytes)) detected = "webp";
  else if (bytes.subarray(0, 8).toString("ascii").startsWith("%PDF-") && bytes.toString("latin1", Math.max(0, bytes.length - 2048)).includes("%%EOF")) detected = "pdf";
  else detected = zipOfficeKind(bytes);

  if (allowed.kind === "text" || allowed.kind === "json") {
    if (detected !== null) return { error: `File contents do not match the .${extension} extension or are invalid.`, status: 415 } as const;
    if (!textIsValid(bytes)) return { error: "The file is not valid UTF-8 text.", status: 415 } as const;
    if (allowed.kind === "json") {
      try { JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "")); }
      catch { return { error: "The .json file does not contain valid JSON.", status: 415 } as const; }
    }
    detected = allowed.kind;
  }
  if (detected !== allowed.kind) return { error: `File contents do not match the .${extension} extension or are invalid.`, status: 415 } as const;
  return { contentType: allowed.contentType } as const;
}

export function safeAttachmentName(name: string) {
  const normalized = name.replaceAll("\\", "/").split("/").at(-1)?.normalize("NFC") ?? "";
  if (!normalized || normalized.length > 255 || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}
