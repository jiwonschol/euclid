// 정책 신경망 — 관측 벡터 → 그 지점의 점수 (docs/first_principle.md)
//
// 선형 결합은 "골에 가깝다"와 "상대가 멀다"를 각각 따로만 볼 수 있다. 은닉층을 두면
// **특징들 사이의 상호작용**을 스스로 만들어낸다 — "골에 가깝고 **동시에** 상대가 멀 때만 가치가 있다",
// "오프사이드 여유가 없으면 골 근접이 오히려 손해다" 같은 것. 내가 그 조건을 쓰지 않아도 된다.
//
// 의존성 없음. 순수 함수. rng 미소비(결정론).

/** 파라미터 개수. arch=[입력, 은닉…, 1] */
export function paramCount(arch) {
  let n = 0;
  for (let i = 0; i + 1 < arch.length; i++) n += arch[i] * arch[i + 1] + arch[i + 1];
  return n;
}

/** 순전파. 은닉층 tanh, 출력 선형. w 는 평탄 벡터(진화 전략이 흔드는 대상). */
export function forward(x, arch, w) {
  let a = x, o = 0;
  for (let l = 0; l + 1 < arch.length; l++) {
    const nin = arch[l], nout = arch[l + 1];
    const out = new Array(nout);
    for (let j = 0; j < nout; j++) {
      let s = w[o + nin * nout + j];                       // bias
      const base = o + j * nin;
      for (let i = 0; i < nin; i++) s += a[i] * w[base + i];
      out[j] = (l + 2 < arch.length) ? Math.tanh(s) : s;   // 마지막 층만 선형
    }
    o += nin * nout + nout;
    a = out;
  }
  return a[0];
}

/** 시드 고정 초기화. '그럴듯한 값'이 아니라 난수 — 무엇이 좋은지는 자기대국이 찾는다. */
export function initWeights(arch, seed = 20260729) {
  let s = seed >>> 0;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const n = paramCount(arch);
  const scale = Math.sqrt(2 / arch[0]);
  return Array.from({ length: n }, () => +((rand() * 2 - 1) * scale).toFixed(5));
}
