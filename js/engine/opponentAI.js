// 상대 감독 AI (계획서 §8) — 규칙 5개가 전부다. 더 똑똑하게 만들지 마라.
// 규칙 5(시간 끌기 가중치)는 sceneSelector가 소유한다.
// 반환: 유저에게 "보여줄" 변경 목록 [{kind:"tactic"|"line", value}] — 정보를 숨기지 않는다.

export function checkBetweenScenes(state, cfg, rng) {
  const ai = cfg.opponentAI;
  const opp = state.opponent;
  const oppDiff = state.score[1] - state.score[0];
  const changes = [];

  // 규칙 1: 지고 있고 70분 이후 → 공격 전환 + 라인 업
  if (oppDiff < 0 && state.minute >= ai.losingPushMinute && opp.tactic !== "attack") {
    opp.tactic = "attack";
    changes.push({ kind: "tactic", value: "attack" });
    if (opp.lineHeight !== "high") {
      opp.lineHeight = "high";
      changes.push({ kind: "line", value: "up" });
    }
    return changes;
  }

  // 규칙 2: 이기고 있고 75분 이후 → 잠금 + 라인 다운
  if (oppDiff > 0 && state.minute >= ai.winningParkMinute && opp.tactic !== "park") {
    opp.tactic = "park";
    changes.push({ kind: "tactic", value: "park" });
    if (opp.lineHeight !== "low") {
      opp.lineHeight = "low";
      changes.push({ kind: "line", value: "down" });
    }
    return changes;
  }

  // 규칙 3: 자기 팀에 퇴장자 발생 → 수비 강화 (1회)
  if (state.manAdvantage > 0 && !state.flags.oppReactedToRed && opp.tactic !== "park") {
    state.flags.oppReactedToRed = true;
    opp.tactic = "park";
    opp.lineHeight = "low";
    changes.push({ kind: "tactic", value: "park" });
    changes.push({ kind: "line", value: "down" });
    return changes;
  }

  return changes;
}

// 규칙 4: 유저가 라인을 올리면 확률적으로 counter 전환
export function onUserLineUp(state, cfg, rng) {
  const opp = state.opponent;
  if (opp.tactic !== "counter" && rng() < cfg.opponentAI.counterSwitchProb) {
    opp.tactic = "counter";
    return [{ kind: "tactic", value: "counter" }];
  }
  return [];
}
