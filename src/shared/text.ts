export const TRUNCATED_MARKER = "\n(truncated)";

export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function normalizeCap(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : Math.max(0, Math.floor(value));
}

// Truncate to at most maxBytes UTF-8 bytes without splitting a code point. O(n): walks code points
// accumulating byte counts, then slices once.
export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  if (byteLength(value) <= maxBytes) {
    return value;
  }
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const characterBytes = byteLength(character);
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    bytes += characterBytes;
    end += character.length;
  }
  return value.slice(0, end);
}

export function truncateWithMarker(value: string, maxBytes: number, marker: string): string {
  if (byteLength(value) <= maxBytes) {
    return value;
  }
  const markerBytes = byteLength(marker);
  if (maxBytes <= markerBytes) {
    return truncateUtf8(marker, maxBytes);
  }
  return `${truncateUtf8(value, maxBytes - markerBytes)}${marker}`;
}
