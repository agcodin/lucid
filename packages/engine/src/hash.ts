/**
 * FNV-1a, 32-bit, over UTF-16 code units. Chosen over a cryptographic hash
 * because this runs on every block on every keystroke; collisions only cost a
 * stale lint on one paragraph until its next edit.
 */
export function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    // h *= 16777619, kept in 32-bit range without Math.imul overflow surprises.
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h.toString(36);
}
