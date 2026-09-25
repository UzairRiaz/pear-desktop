type Tables = { cos: Float32Array; sin: Float32Array; reversed: Uint32Array };

const tableCache = new Map<number, Tables>();

const getTables = (size: number): Tables => {
  const cached = tableCache.get(size);
  if (cached) return cached;

  const cos = new Float32Array(size / 2);
  const sin = new Float32Array(size / 2);
  for (let i = 0; i < size / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / size);
    sin[i] = Math.sin((2 * Math.PI * i) / size);
  }

  const bits = Math.log2(size);
  const reversed = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    reversed[i] = r;
  }

  const tables = { cos, sin, reversed };
  tableCache.set(size, tables);
  return tables;
};

/**
 * Magnitude spectrum of a real frame (length a power of two), written to
 * `out` (length size / 2 + 1). `re` and `im` are scratch buffers of the
 * frame's length.
 */
export const magnitudeSpectrum = (
  frame: Float32Array,
  re: Float32Array,
  im: Float32Array,
  out: Float32Array,
) => {
  const size = frame.length;
  const { cos, sin, reversed } = getTables(size);

  for (let i = 0; i < size; i++) {
    re[reversed[i]] = frame[i];
    im[reversed[i]] = 0;
  }

  for (let span = 2; span <= size; span *= 2) {
    const half = span / 2;
    const step = size / span;
    for (let start = 0; start < size; start += span) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = -sin[k * step];
        const a = start + k;
        const b = a + half;
        const tr = (re[b] * wr) - (im[b] * wi);
        const ti = (re[b] * wi) + (im[b] * wr);
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }

  for (let i = 0; i <= size / 2; i++) out[i] = Math.hypot(re[i], im[i]);
};
