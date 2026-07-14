// 경기 후 브리핑 (계획서 §11).
// 반사실("그때 ~했다면")은 로그에 counter 카드가 실재했던 순간에만 허용된다.
// 시스템이 검증할 수 없는 조언은 만들지 않는다 — 브리핑의 신뢰가 게임의 신뢰다.

const pct = (p) => Math.round(p * 100);

export function buildBriefing(log, state, advisor, caster) {
  const isEuclid = advisor.id === "euclid";
  const items = [];

  // 1) 적중한 개입 (잘한 것 최소 1개)
  const hits = log.filter((e) => {
    if (!e.counterUsed) return false;
    if (e.side === "away") return e.event !== "goal"; // 위험을 실제로 막았다
    return e.event === "goal" || e.event === "turnover"; // 기회를 실제로 살렸다
  });
  for (const h of hits.slice(0, 1)) {
    let text;
    if (h.focalTables && h.side === "away") {
      text = isEuclid
        ? `${h.minute}분 개입(${h.counterLabel}): 실점 확률 ${pct(h.focalTables.base)}% → ${pct(h.focalTables.counter)}%. 실제로 막아냈습니다. 올바른 독법이었습니다.`
        : `${h.minute}분에 ${h.counterLabel} 지시하신 거요, 그게 경기를 살렸어요. 그대로 뒀으면 위험했습니다.`;
    } else if (h.focalTables) {
      text = isEuclid
        ? `${h.minute}분 개입(${h.counterLabel}): 득점 확률 ${pct(h.focalTables.base)}% → ${pct(h.focalTables.counter)}%. 결과로 이어졌습니다.`
        : `${h.minute}분 그 타이밍의 ${h.counterLabel}, 정확했어요. 애들이 살아났잖아요.`;
    } else {
      text = isEuclid
        ? `${h.minute}분 개입(${h.counterLabel}): 상대의 템포 조절을 끊고 소유권을 회수했습니다.`
        : `${h.minute}분에 흐름 끊은 거, 그게 컸어요.`;
    }
    items.push({ kind: "hit", minute: h.minute, text });
  }

  // 2) 놓친 개입 창 — counter가 데이터에 실재했고, 쓰지 않았고, 나쁜 결과가 났던 순간만
  const misses = log.filter((e) => {
    if (!e.hadCounter || e.counterUsed) return false;
    if (e.side === "away") return e.event === "goal" || e.event === "timewaste";
    return false;
  });
  for (const m of misses.slice(0, 2)) {
    let text;
    if (m.focalTables && m.event === "goal") {
      text = isEuclid
        ? `${m.minute}분 실점 장면. ${m.counterLabel} 개입 시 실점 확률은 ${pct(m.focalTables.base)}%에서 ${pct(m.focalTables.counter)}%까지 내려갔습니다. 신호는 나가 있었습니다.`
        : `${m.minute}분 그 실점이요... 그때 ${m.counterLabel} 했다면 달랐을 겁니다. 제가 소리쳤었잖아요.`;
    } else {
      text = isEuclid
        ? `${m.minute}분, 상대의 템포 조절 구간. ${m.counterLabel} 개입 창이 열려 있었지만 사용되지 않았습니다.`
        : `${m.minute}분에 상대가 경기를 죽일 때, 그냥 두신 게 아쉬워요. ${m.counterLabel} 타이밍이었어요.`;
    }
    items.push({ kind: "miss", minute: m.minute, text });
  }

  // 3) 판단은 옳았던 실패 — 유저의 분노를 운/선수에게 분산 (§9)
  if (items.length < 3) {
    const good = log.find((e) => e.goodCallFailed);
    if (good) {
      items.push({
        kind: "judgment",
        minute: good.minute,
        text: isEuclid
          ? `${good.minute}분 개입은 기대값 기준 최선의 수였습니다. ${caster.judgmentLine}`
          : `${good.minute}분 그 판단은 맞았어요. ${caster.judgmentLine}`,
      });
    }
  }

  const diff = state.score[0] - state.score[1];
  const summary = diff > 0
    ? (isEuclid ? "승리. 다만 결과와 과정은 별개로 검토합니다." : "이겼네요, 감독님! 오늘 벤치 워크 좋았어요.")
    : diff < 0
      ? (isEuclid ? "패배. 원인을 분해해 보겠습니다." : "아쉽지만... 다음 경기에 답을 찾으면 됩니다.")
      : (isEuclid ? "무승부. 개선 여지가 명확한 경기였습니다." : "비겼습니다. 반은 얻고 반은 놓쳤네요.");

  return { summary, items: items.slice(0, 3), score: [...state.score] };
}
