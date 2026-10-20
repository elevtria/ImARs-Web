import { MAX_QUIZ_TEXT_CHARACTERS } from "./quiz-limits.js";

const MAX_ENTRY_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_XML_BYTES = 24 * 1024 * 1024;
const tooMuchText = () => new Error("This file contains too much readable content. Try a shorter file or split it into parts.");
const invalidZip = () => new Error("This file is not a readable Office document. Save it as DOCX or PPTX and try again.");

async function readExpanded(stream, limit) {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw tooMuchText();
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

// Read ZIP metadata and the selected XML parts only. Embedded pictures and
// videos in a 50 MB presentation are never loaded into extraction buffers.
export async function readOfficeZipEntries(file, acceptedEntry) {
  const tailStart = Math.max(0, file.size - 65557);
  const tail = new Uint8Array(await file.slice(tailStart).arrayBuffer());
  const tailView = new DataView(tail.buffer);
  let end = -1;
  for (let offset = tail.length - 22; offset >= 0; offset--) {
    if (tailView.getUint32(offset, true) === 0x06054b50 && offset + 22 + tailView.getUint16(offset + 20, true) === tail.length) { end = offset; break; }
  }
  if (end < 0 || tailView.getUint16(end + 4, true) !== 0 || tailView.getUint16(end + 6, true) !== 0) throw invalidZip();
  const count = tailView.getUint16(end + 10, true);
  const directorySize = tailView.getUint32(end + 12, true);
  const directoryOffset = tailView.getUint32(end + 16, true);
  if (!count || count > 2000 || directorySize > 2 * 1024 * 1024 || directoryOffset + directorySize > tailStart + end) throw invalidZip();
  const directory = new Uint8Array(await file.slice(directoryOffset, directoryOffset + directorySize).arrayBuffer());
  const view = new DataView(directory.buffer);
  const decoder = new TextDecoder();
  const entries = [];
  let cursor = 0, total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > directory.length || view.getUint32(cursor, true) !== 0x02014b50) throw invalidZip();
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const expandedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const next = cursor + 46 + nameLength + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    if (next > directory.length) throw invalidZip();
    const name = decoder.decode(directory.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor = next;
    if (!acceptedEntry(name)) continue;
    if (flags & 1 || localOffset + 30 > directoryOffset) throw invalidZip();
    if (expandedSize > MAX_ENTRY_BYTES || total + expandedSize > MAX_TOTAL_XML_BYTES) throw tooMuchText();
    const local = new DataView(await file.slice(localOffset, localOffset + 30).arrayBuffer());
    if (local.byteLength !== 30 || local.getUint32(0, true) !== 0x04034b50) throw invalidZip();
    const start = localOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
    if (start + compressedSize > directoryOffset) throw invalidZip();
    let stream = file.slice(start, start + compressedSize).stream();
    if (method === 8 && typeof DecompressionStream !== "undefined") stream = stream.pipeThrough(new DecompressionStream("deflate-raw"));
    else if (method !== 0) throw new Error("This Office file uses a compression format this browser cannot read.");
    const bytes = await readExpanded(stream, Math.min(MAX_ENTRY_BYTES, MAX_TOTAL_XML_BYTES - total));
    if (bytes.byteLength !== expandedSize) throw invalidZip();
    total += bytes.byteLength;
    entries.push({ name, text: decoder.decode(bytes) });
  }
  return entries;
}

export async function extractOfficeText(file) {
  const extension = file.name.split(".").pop().toLowerCase();
  if (extension === "ppt") throw new Error("Older .ppt files are not supported yet. Open the presentation and save a copy as .pptx or PDF.");
  const entries = await readOfficeZipEntries(file, name => extension === "docx" ? name === "word/document.xml" : /^ppt\/slides\/slide\d+\.xml$/.test(name));
  if (!entries.length) throw new Error("No readable text was found in this file.");
  entries.sort((left, right) => Number(left.name.match(/slide(\d+)\.xml$/)?.[1] || 0) - Number(right.name.match(/slide(\d+)\.xml$/)?.[1] || 0));
  const namespace = extension === "docx" ? "http://schemas.openxmlformats.org/wordprocessingml/2006/main" : "http://schemas.openxmlformats.org/drawingml/2006/main";
  const text = entries.map(entry => {
    const xml = new DOMParser().parseFromString(entry.text, "application/xml");
    if (xml.querySelector("parsererror")) throw new Error("Text in this Office file could not be read.");
    return Array.from(xml.getElementsByTagNameNS(namespace, "t"), node => node.textContent || "").join(" ");
  }).join("\n").trim();
  if (!text) throw new Error("No readable text was found in this file.");
  if (text.length > MAX_QUIZ_TEXT_CHARACTERS) throw tooMuchText();
  return text;
}
