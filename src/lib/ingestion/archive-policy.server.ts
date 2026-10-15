import { permanent } from "./contract";
/** Validate ZIP central-directory sizes before Office parsers decompress data.
 * Declared sizes are not a proof against every malicious decompressor; process
 * memory/CPU limits remain necessary defense in depth. ZIP64/encryption rejected. */
export function validateOfficeArchive(bytes: Uint8Array, requiredEntry: string): void {
  const fail = () => {
    throw permanent(
      "UNSAFE_ARCHIVE",
      "This Office file is corrupt, encrypted, or exceeds safe extraction limits.",
    );
  };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return fail();
  const count = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  const size = view.getUint32(end + 12, true);
  if (
    count > 2000 ||
    cursor + size > end ||
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0
  )
    return fail();
  let total = 0,
    found = false;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) return fail();
    const compressed = view.getUint32(cursor + 20, true);
    const expanded = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extra = view.getUint16(cursor + 30, true),
      comment = view.getUint16(cursor + 32, true);
    if (
      view.getUint16(cursor + 8, true) & 1 ||
      expanded > 8 * 1024 * 1024 ||
      expanded > Math.max(1, compressed) * 200
    )
      return fail();
    const next = cursor + 46 + nameLength + extra + comment;
    if (next > end || next > view.getUint32(end + 16, true) + size) return fail();
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (name.startsWith("/") || name.includes("\\") || name.split("/").includes(".."))
      return fail();
    found ||= name === requiredEntry;
    total += expanded;
    if (total > 32 * 1024 * 1024) return fail();
    cursor = next;
  }
  if (!found) return fail();
}
