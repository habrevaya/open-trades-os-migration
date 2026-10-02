/**
 * WHAT THE TARGET WILL STORE
 *
 * Core's file rules (packages/core files, applied by services/files.ts): the
 * type is decided from the first bytes and never from a name or a claim, the
 * allow list is PNG, JPEG, GIF, WebP, ICO, HEIC and PDF and deliberately no
 * SVG, and nothing over twenty megabytes. Restated so `attachments` can say
 * which files will be refused before sending them, and so the in-memory
 * target refuses the same ones.
 */

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** core files: what a file is, from its first bytes. The allow list has no SVG on purpose. */
export function sniff(bytes: Buffer): string | undefined {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (starts(0x00, 0x00, 0x01, 0x00)) return "image/x-icon";
  if (bytes.subarray(4, 8).toString("latin1") === "ftyp" && /^(heic|heix|mif1|msf1|hevc)/.test(bytes.subarray(8, 12).toString("latin1"))) return "image/heic";
  if (starts(0x25, 0x50, 0x44, 0x46)) return "application/pdf";
  return undefined;
}
