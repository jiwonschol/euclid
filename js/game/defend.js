// 수비 오프-볼 움직임: 마킹 (마스터 §5·§6). 공격 러너가 침투하면 그냥 두지 않는다.
// 자기 진영에 든 상대 위협 선수를 프리 수비수가 골side로 밀착 마크 → 박스 보호·찬스 봉쇄.
// (압박 1인·커버는 별도. 최소 2명은 라인 유지해 형상 붕괴 방지.)

import { dBallOwn } from './shape.js';
import { FIELD } from './field.js';
import { resolvedFor } from './effects.js';

const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * @returns {Record<string,{x:number,z:number}>} 수비수 id → 마크 목표(위협의 골side)
 */
export function assignMarking(state, defTeam, presserId, coverId) {
  const dir = state.attackDirection[defTeam];         // 수비팀 공격 방향(자기 골문=반대)
  const attackTeam = defTeam === 'A' ? 'B' : 'A';
  const ownGoalX = -dir * FIELD.halfLength;

  // 위협: 상대 아웃필더 중 우리 진영(자기 골문 45m 이내), 공 소유자 제외, 골문 가까운 순
  let threats = Object.values(state.players)
    .filter((p) => p.teamId === attackTeam && p.role !== 'GK' && !p.sentOff && !p.hasBall && dBallOwn(dir, p.position.x) < 45)
    .sort((a, b) => Math.abs(a.position.x - ownGoalX) - Math.abs(b.position.x - ownGoalX));

  // 밀착 마크 카드(§12): 지정 상대 선수를 진영 무관 최우선 마크
  const manId = resolvedFor(state, defTeam).manMark;
  if (manId) {
    const t = state.players[manId];
    if (t && t.teamId === attackTeam && !t.sentOff && !t.hasBall) threats = [t, ...threats.filter((p) => p.id !== manId)];
  }

  const free = Object.values(state.players).filter(
    (p) => p.teamId === defTeam && p.role !== 'GK' && !p.sentOff && p.id !== presserId && p.id !== coverId);

  const marks = {};
  const used = new Set();
  const maxMarks = Math.min(threats.length, 3, Math.max(0, free.length - 3));   // 위험한 3명까지·최소 3명 라인 유지
  for (let i = 0; i < maxMarks; i++) {
    const t = threats[i];
    let best = null, bd = Infinity;
    for (const d of free) { if (used.has(d.id)) continue; const dd = dist2(d.position, t.position); if (dd < bd) { bd = dd; best = d; } }
    if (!best) break;
    used.add(best.id);
    const gx = ownGoalX - t.position.x, gz = 0 - t.position.z, gl = Math.hypot(gx, gz) || 1;
    const md = t.id === manId ? 1.6 : 2.2;                                                       // 지정 마크는 더 밀착
    marks[best.id] = { x: t.position.x + (gx / gl) * md, z: t.position.z + (gz / gl) * md };     // 골side 커버(밀착 과다·겹침 방지)
  }
  return marks;
}
