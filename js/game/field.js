// 경기장 좌표계와 상수 (마스터 계획서 §3).
//
// 평면: x = 길이축, z = 폭축.  위: y = 공 높이(선수는 항상 y=0).
// 원점 = 센터 마크.  x ∈ [-52.5, +52.5] (105m),  z ∈ [-34, +34] (68m).
//
// attackDir 로 팀 방향을 통일한다:
//   전반 — A팀 attackDir=+1 (→ +x 로 공격),  B팀 attackDir=-1.
//   후반 — 둘 다 부호 반전(진영·좌우 앵커가 정확히 뒤집힌다, §3/§11).
// 어느 팀이든  자기 골문 x = -attackDir*52.5,  상대 골문 x = +attackDir*52.5.
//
// 렌더러(픽셀) 좌표와 절대 섞지 않는다 — 변환은 UI 레이어가 담당한다(§3).

export const FIELD = {
  length: 105, width: 68,
  halfLength: 52.5, halfWidth: 34,
  goalHalfWidth: 3.66,       // 골문 폭 7.32 의 절반
  goalDepth: 2.0,
  centerRadius: 9.15,
  penaltyBoxLength: 16.5,    // 골라인 → 페널티박스 앞선
  penaltyBoxHalfWidth: 20.16,
  penaltySpot: 11.0,         // 골라인 → 페널티 마크
  goalAreaLength: 5.5,
  goalAreaHalfWidth: 9.16,
  keepOutRadius: 9.15,       // 킥오프/프리킥 시 상대 이격 거리
};

export function ownGoalX(attackDir) { return -attackDir * FIELD.halfLength; }
export function oppGoalX(attackDir) { return attackDir * FIELD.halfLength; }

/** 공이 필드 안인지 (골라인/터치라인 경계 포함) */
export function inBounds(x, z) {
  return x >= -FIELD.halfLength && x <= FIELD.halfLength
      && z >= -FIELD.halfWidth && z <= FIELD.halfWidth;
}

/** 점 p 가 attackDir 기준 어느 팀의 페널티 박스 안인지: 'own' | 'opp' | null */
export function penaltyBoxOf(x, z, attackDir) {
  if (Math.abs(z) > FIELD.penaltyBoxHalfWidth) return null;
  const ownX = ownGoalX(attackDir);
  const oppX = oppGoalX(attackDir);
  // 자기 박스: 자기 골라인에서 penaltyBoxLength 안쪽까지
  if (Math.abs(x - ownX) <= FIELD.penaltyBoxLength) return 'own';
  if (Math.abs(x - oppX) <= FIELD.penaltyBoxLength) return 'opp';
  return null;
}

// ── 포메이션 앵커 (팀 정규화 좌표) ──────────────────────────────
// ax: 0 = 자기 골문,  1 = 상대 골문.   az: 0..1 폭(팀 시점 왼쪽→오른쪽).
// 마스터 계획서 §5 의 4-3-3 앵커. 4-4-2 / 3-5-2 는 Stage 2 에서 데이터로 확장.
export const FORMATION_433 = [
  { role: 'GK', ax: 0.05, az: 0.50 },
  { role: 'FB', ax: 0.22, az: 0.16 },
  { role: 'CB', ax: 0.18, az: 0.39 },
  { role: 'CB', ax: 0.18, az: 0.61 },
  { role: 'FB', ax: 0.22, az: 0.84 },
  { role: 'DM', ax: 0.40, az: 0.50 },
  { role: 'CM', ax: 0.50, az: 0.34 },
  { role: 'CM', ax: 0.50, az: 0.66 },
  { role: 'W',  ax: 0.70, az: 0.16 },
  { role: 'ST', ax: 0.78, az: 0.50 },
  { role: 'W',  ax: 0.70, az: 0.84 },
];

/**
 * 정규화 앵커 → 월드 좌표(미터). attackDir 방향으로 사상(자기골문→상대골문),
 * 폭도 attackDir 로 미러해 팀 시점 좌우 일관성을 유지한다.
 * @param {{ax:number, az:number}} anchor
 * @param {1|-1} attackDir
 * @returns {{x:number, z:number}}
 */
export function anchorToWorld({ ax, az }, attackDir) {
  const x = attackDir * (ax * FIELD.length - FIELD.halfLength);
  const z = attackDir * (az * FIELD.width - FIELD.halfWidth);
  return { x, z };
}
