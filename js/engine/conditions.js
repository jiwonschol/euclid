// 조건식 평가기. 장면 가중치·캐스터 멘트·내레이션이 공유하는 단일 문법.
// 문법: "momentum<0", "opp.tactic=attack", "score_diff<0&minute>=70" (&는 AND)

const OP_RE = /^([a-zA-Z_.]+)(>=|<=|!=|=|>|<)(.+)$/;

// 상태 → 조건식에서 참조 가능한 평면 뷰
export function derivedView(state) {
  return {
    minute: state.minute,
    half: state.half,
    score_diff: state.score[0] - state.score[1],
    momentum: state.momentum,
    morale: state.morale,
    lineHeight: state.lineHeight,
    tactic: state.tactic,
    manAdvantage: state.manAdvantage,
    "opp.lineHeight": state.opponent.lineHeight,
    "opp.tactic": state.opponent.tactic,
  };
}

export function evalCond(expr, view) {
  return expr.split("&").every((atom) => {
    const m = atom.trim().match(OP_RE);
    if (!m) return false;
    const [, key, op, rawVal] = m;
    const left = view[key];
    if (left === undefined) return false;
    const num = parseFloat(rawVal);
    const right = Number.isNaN(num) ? rawVal : num;
    switch (op) {
      case ">=": return left >= right;
      case "<=": return left <= right;
      case ">": return left > right;
      case "<": return left < right;
      case "=": return left === right || left === String(right) || String(left) === String(right);
      case "!=": return !(left === right || String(left) === String(right));
      default: return false;
    }
  });
}

// weight 객체 {base:10, "momentum<0":1.5, ...} → 최종 가중치
export function evalWeight(weightObj, view) {
  let w = weightObj.base ?? 1;
  for (const [key, mult] of Object.entries(weightObj)) {
    if (key === "base") continue;
    if (evalCond(key, view)) w *= mult;
  }
  return w;
}

// [{text, when?}] 목록에서 상태에 맞는 것 선택.
// when이 충족되는 특화 멘트가 있으면 그것을 우선한다 (재맥락화 §7).
export function pickConditional(entries, view, rng) {
  if (!entries || entries.length === 0) return null;
  const ok = entries.filter((e) => !e.when || evalCond(e.when, view));
  if (ok.length === 0) return entries[0];
  const specific = ok.filter((e) => e.when);
  const pool = specific.length > 0 ? specific : ok;
  return pool[Math.floor((rng ? rng() : Math.random()) * pool.length)];
}
