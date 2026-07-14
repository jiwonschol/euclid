// PRD 판정 (계획서 §9).
// 명세의 두 요구를 동시에 만족시킨다:
//   (a) 실패마다 실효 확률 +step(9%p) 누적, 성공 시 초기화, 상한 cap(95%)
//   (b) 장기 빈도가 "표기 확률"에 수렴
// 표기 확률에서 그대로 시작해 +9%p를 얹으면 장기 빈도가 표기보다 높아지므로(예: 20%→~33%),
// 시작상수 C를 이진 탐색으로 역산해 C + step*연속실패 가 장기적으로 표기 확률에 수렴하게 한다.

const cCache = new Map();

// 시작상수 c에서의 장기 성공 빈도 = 1 / E[성공까지 시도 횟수]
function longRunRate(c, step, cap) {
  let expectedTrials = 0;
  let survival = 1; // 지금까지 전부 실패했을 확률
  for (let k = 0; k < 400 && survival > 1e-12; k++) {
    const p = Math.min(cap, Math.max(0, c + step * k));
    expectedTrials += survival; // k번째 시도가 일어날 확률
    survival *= 1 - p;
    if (p >= cap) { // 이후는 cap 고정 → 기하급수 꼬리
      expectedTrials += survival / cap;
      survival = 0;
    }
  }
  return 1 / expectedTrials;
}

export function solveBaseC(statedP, step, cap) {
  const key = `${statedP.toFixed(4)}|${step}|${cap}`;
  if (cCache.has(key)) return cCache.get(key);
  // 주의: 고정 +9%p 스텝에서 표기 확률이 낮으면(≲20%) 시작상수가 음수여야 수렴한다.
  // (음수 C = 성공 직후 몇 번은 실효 0%로 클램프됨. 실패가 쌓이며 +9%p씩 회복)
  let lo = -step * 20, hi = Math.min(statedP, cap);
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (longRunRate(mid, step, cap) > statedP) hi = mid; else lo = mid;
  }
  const c = (lo + hi) / 2;
  cCache.set(key, c);
  return c;
}

// tracker = { fails: number } — 팀 단위로 유지, 성공 시 리셋
export function prdCheck(tracker, statedP, cfg, rng) {
  const { step, cap } = cfg;
  const p = Math.min(cap, Math.max(0.01, statedP));
  const baseC = solveBaseC(p, step, cap);
  const effP = Math.min(cap, Math.max(0, baseC + step * tracker.fails));
  const roll = rng();
  const success = roll < effP;
  const info = { statedP: p, baseC, bonus: step * tracker.fails, effP, roll, failsBefore: tracker.fails };
  if (success) tracker.fails = 0; else tracker.fails += 1;
  return { success, info };
}
