// 시드 기반 결정적 난수 (마스터 계획서 §3: "모든 난수는 시드 기반 RNG").
// 같은 시드 + 같은 감독 명령 로그 → 같은 경기(§17 안정성 테스트)를 위해
// 연속 시뮬 엔진은 Math.random()을 절대 쓰지 않고 이 RNG만 소비한다.
//
// 알고리즘은 기존 js/engine/rng.js 의 mulberry32 를 그대로 계승한다(검증된 분포).
// 다만 상태 a(32비트 정수 하나)를 노출해 스냅샷/복원이 가능하게 감쌌다 —
// 리플레이(계획서 §4 rngState: SeededRngState)와 중간 저장에 쓴다.

/**
 * @typedef {Object} Rng
 * @property {number} state              직렬화 가능한 32비트 상태(리플레이용)
 * @property {() => number} float        [0,1)
 * @property {(lo:number,hi:number)=>number} range   [lo,hi)
 * @property {(lo:number,hi:number)=>number} int     [lo,hi] 정수(양끝 포함)
 * @property {(p:number)=>boolean} chance            확률 p로 true
 * @property {<T>(arr:T[])=>T} pick                  균등 추출
 * @property {<T>(items:T[], weightOf:(it:T)=>number)=>T} pickWeighted  가중 추출
 */

/**
 * @param {number} seed
 * @returns {Rng}
 */
export function createRng(seed) {
  let a = (seed >>> 0) || 1;

  function float() {
    // mulberry32 (js/engine/rng.js 와 동일 시퀀스)
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  const rng = {
    get state() { return a >>> 0; },
    set state(v) { a = (v >>> 0) || 1; },
    float,
    range(lo, hi) { return lo + (hi - lo) * float(); },
    int(lo, hi) { return lo + Math.floor(float() * (hi - lo + 1)); },
    chance(p) { return float() < p; },
    pick(arr) { return arr[Math.floor(float() * arr.length)]; },
    pickWeighted(items, weightOf) {
      let total = 0;
      const w = items.map((it) => { const x = Math.max(0, weightOf(it)); total += x; return x; });
      if (total <= 0) return items[0] ?? null;
      let r = float() * total;
      for (let i = 0; i < items.length; i++) { r -= w[i]; if (r <= 0) return items[i]; }
      return items[items.length - 1];
    },
  };
  return rng;
}
