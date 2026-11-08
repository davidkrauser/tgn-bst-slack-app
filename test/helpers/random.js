// Seeded random helpers for property tests. Every test seeds its own generator
// with a fixed number, so a failing case can be replayed from the seed alone.

export function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick(rand, array) {
  return array[Math.floor(rand() * array.length)];
}

// A whole number from lo to hi, both included.
export function int(rand, lo, hi) {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

// Fragments joined until the text is at least as long as a length drawn from
// minLength..maxLength, then cut to exactly that length.
export function randomText(rand, fragments, maxLength, minLength = 0) {
  const length = int(rand, minLength, maxLength);
  let text = "";
  while (text.length < length) text += pick(rand, fragments);
  return text.slice(0, length);
}
