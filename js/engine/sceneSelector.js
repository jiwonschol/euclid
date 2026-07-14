// 장면 선택 (계획서 §7): requires로 하드 필터 → 조건 가중치 → 가중 랜덤.
// 스코어·모멘텀은 하드 분기가 아니라 가중치에만 영향을 준다.
import { derivedView, evalCond, evalWeight } from "./conditions.js";
import { pickWeighted } from "./rng.js";

export function selectScene(scenes, state, cfg, rng) {
  const view = derivedView(state);
  const pool = scenes.filter((s) => {
    if (!s.requires) return true;
    return s.requires.every((r) => evalCond(r, view));
  });
  const { lastN, multiplier } = cfg.repeatSuppression;
  const recent = state.recentScenes.slice(-lastN);
  const ai = cfg.opponentAI;

  return pickWeighted(rng, pool, (s) => {
    let w = evalWeight(s.weight, view);
    if (recent.includes(s.id)) w *= multiplier;
    // 상대 감독 AI 규칙 5: 모멘텀이 임계(-3)에 도달하면 시간 끌기 장면 가중치 상승
    if (state.momentum <= ai.timewasteAtMomentum && s.tags.includes("timewaste")) {
      w *= ai.timewasteWeightMultiplier;
    }
    // 미드필더 투입(§8-D): 중원 장악 — 우리 장면이 더 자주, 상대 장면이 덜 나온다
    const mf = state.subBoosts?.mf ?? 0;
    if (mf > 0) {
      if (s.side === "home") w *= 1 + cfg.subBoost.mfWeight * mf;
      else if (s.side === "away") w *= Math.max(0.4, 1 - cfg.subBoost.mfWeight * mf);
    }
    return w;
  });
}
