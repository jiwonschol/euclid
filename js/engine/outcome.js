// 결과 판정 + 상태 반영. 순수 함수(상태는 인자로 받아 변형).
import { prdCheck } from "./prd.js";

// 결과 → 3티어 연출 등급 (§9): 1=메시지, 2=배너, 3=풀 컷인
const TIERS = {
  goal: 3, red_home: 3, red_away: 3,
  save: 2, turnover: 2,
  miss: 1, clear: 1, flow_gain: 1, flow_loss: 1, foul: 1, timewaste: 1,
};

// 분포 게이트용 분류: 득점 / 유효슈팅·선방 / 흐름
export function classify(eventType) {
  if (eventType === "goal") return "goal";
  if (eventType === "save" || eventType === "miss" || eventType === "clear") return "chance";
  return "flow";
}

// 홈 사기·적응 페널티·공격수 투입(§8-D)이 홈 측 focal 성공률에 주는 배수
function homeModifiers(state, cfg) {
  let m = 1 + (state.morale - cfg.moraleStart) * cfg.moraleSuccessSlopePerPoint;
  if (state.adaptationLeft > 0) m *= cfg.adaptationPenalty.successMultiplier;
  m *= 1 + cfg.subBoost.fw * (state.subBoosts?.fw ?? 0);
  return m;
}

// 수비수 투입(§8-D)이 상대 측 focal(실점) 확률에 주는 감쇄 배수
function awayFocalModifier(state, cfg) {
  return Math.max(0.4, 1 - cfg.subBoost.df * (state.subBoosts?.df ?? 0));
}

export function resolveOutcome(scene, state, cfg, rng, counterApplied) {
  const table = counterApplied && scene.counter ? scene.counter.table : scene.outcome.table;
  const focal = scene.outcome.focal;
  let debug = null;
  let key;

  const focalEntry = focal ? table.find(([k]) => k === focal) : null;
  if (focalEntry) {
    // focal(대개 goal)은 PRD로 판정, 나머지는 잔여 확률에서 비례 추첨
    let statedP = focalEntry[1];
    if (scene.side === "home") statedP *= homeModifiers(state, cfg);
    else if (scene.side === "away") statedP *= awayFocalModifier(state, cfg);
    const tracker = state.prd[scene.side === "home" ? "home" : "away"];
    const { success, info } = prdCheck(tracker, statedP, cfg.prd, rng);
    debug = { ...info, scene: scene.id, focal, counterApplied };
    if (success) {
      key = focal;
    } else {
      const rest = table.filter(([k]) => k !== focal);
      const total = rest.reduce((a, [, p]) => a + p, 0);
      let r = rng() * total;
      key = rest[rest.length - 1][0];
      for (const [k, p] of rest) { r -= p; if (r <= 0) { key = k; break; } }
    }
  } else {
    let r = rng();
    key = table[table.length - 1][0];
    for (const [k, p] of table) { r -= p; if (r <= 0) { key = k; break; } }
  }

  const event = { type: key, side: scene.side };
  return { event, tier: TIERS[key] ?? 1, classification: classify(key), debug };
}

// 판정 결과를 상태에 반영. 반환값: 파생 정보(퇴장 스톤 등)
export function applyEvent(state, scene, event, cfg) {
  const dir = scene.side === "home" ? 1 : scene.side === "away" ? -1 : 0;
  const clampM = (v) => Math.max(-3, Math.min(3, v));
  const out = {};

  switch (event.type) {
    case "goal":
      if (scene.side === "home") {
        state.score[0] += 1;
        state.morale = Math.min(100, state.morale + cfg.moraleGoalFor);
      } else {
        state.score[1] += 1;
        state.morale = Math.max(0, state.morale + cfg.moraleGoalAgainst);
      }
      state.momentum = clampM(state.momentum + dir * cfg.momentumGoal);
      break;
    case "save":
      state.momentum = clampM(state.momentum + dir * cfg.momentumSave);
      break;
    case "miss":
    case "clear":
      state.momentum = clampM(state.momentum + dir * cfg.momentumMiss);
      break;
    case "flow_gain":
      state.momentum = clampM(state.momentum + dir * cfg.momentumFlow);
      break;
    case "flow_loss":
      state.momentum = clampM(state.momentum - dir * cfg.momentumFlow);
      break;
    case "turnover": // 소유권 반전: 수비측이 이득
      state.momentum = clampM(state.momentum - dir * cfg.momentumFlow);
      break;
    case "red_home": {
      state.manAdvantage -= 1;
      state.morale = Math.max(0, state.morale - 8);
      out.sentOff = firstStoneOfTeam(scene, "h") ?? "h5";
      state.sentOff.push(out.sentOff);
      break;
    }
    case "red_away": {
      state.manAdvantage += 1;
      out.sentOff = firstStoneOfTeam(scene, "a") ?? "a5";
      state.sentOff.push(out.sentOff);
      break;
    }
    default:
      break; // foul, timewaste: 상태 변화 없음 (시간만 흐른다)
  }
  return out;
}

function firstStoneOfTeam(scene, prefix) {
  return Object.keys(scene.waypoints).find((id) => id.startsWith(prefix) && id !== "ball") ?? null;
}
