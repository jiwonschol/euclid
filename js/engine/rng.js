// 시드 가능한 RNG. 헤드리스 시뮬 재현성을 위해 Math.random을 직접 쓰지 않는다.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickWeighted(rng, items, weightOf) {
  let total = 0;
  const weights = items.map((it) => {
    const w = Math.max(0, weightOf(it));
    total += w;
    return w;
  });
  if (total <= 0) return items[0] ?? null;
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

export function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

export function randInt(rng, min, max) { // inclusive
  return min + Math.floor(rng() * (max - min + 1));
}
