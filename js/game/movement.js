// 선수 운동학 (마스터 §6 이동 + 계획서 §2.1-B). js/engine/motion.js:seek 를 미터/{x,z} 네이티브로 이식.
// 핵심: "공보다 사람은 느리다" — 목표가 아무리 빨리 움직여도 자기 가감속 상한 안에서만 따라간다.
// 위치·속도는 미터/ m·s⁻¹. rng 소비 금지(결정론) — 완전 겹침 방향만 id 해시로 정한다.

// ── {x,z} 평면 벡터 헬퍼 (전부 미터) ──
const vsub = (a, b) => ({ x: a.x - b.x, z: a.z - b.z });
const vadd = (a, b) => ({ x: a.x + b.x, z: a.z + b.z });
const vscale = (a, s) => ({ x: a.x * s, z: a.z * s });
const vlen = (a) => Math.hypot(a.x, a.z);
const clampLen = (a, max) => { const l = vlen(a); return l > max ? vscale(a, max / l) : a; };
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// id 결정론 해시 → 0..1 (rng 대체 — 완전 겹침 분리 방향, 유휴 위상)
export function hash01(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return (h >>> 0) / 4294967296;
}

// 인간 운동학 저속 폴백 임계 (m/s). 이 미만은 진행방향이 불명확해 등방 accelBase 단일 캡.
const SEEK_LOW_SPEED = 0.5;

/**
 * 목표점 추적(seek+arrival). player.position/velocity({x,z} 미터)를 dt 적분한다.
 * dv를 현재 속도 기준 전진/제동/측면 성분으로 분해해 각각 다른 상한 적용:
 *  - 전진: a(v)=accelBase×max(0,1−‖v‖/maxSpeed) (전속 접근 시 가속→0)
 *  - 제동: brake (편심 수축이라 가속보다 강함)
 *  - 측면: lateralAccel (고속 급회전 불가 → 곡선 주로 자동 생성)
 * 최종 속도변화량을 견인력 예산(brake·dt)으로 재제한 → 측정 가속 ≤ brake (마찰원).
 * 불변식: ‖velocity‖ ≤ maxSpeed 하드 클램프 유지.
 * @param {{position:{x:number,z:number}, velocity:{x:number,z:number}}} player
 * @param {{x:number,z:number}} target
 * @param {number} maxSpeed  @param {any} kin  @param {number} dt  @param {number} arrivalRadius
 */
export function seek(player, target, maxSpeed, kin, dt, arrivalRadius) {
  const pos = player.position, vel = player.velocity;
  const toT = vsub(target, pos);
  const d = vlen(toT);
  const desiredSpeed = d < arrivalRadius ? maxSpeed * (d / arrivalRadius) : maxSpeed;
  const dir = d > 1e-9 ? vscale(toT, 1 / d) : { x: 0, z: 0 };
  const desiredVel = vscale(dir, desiredSpeed);
  const dv = vsub(desiredVel, vel);

  const sp = vlen(vel);
  let applied;
  if (sp < SEEK_LOW_SPEED) {
    applied = clampLen(dv, kin.accelBase * dt);
  } else {
    const vdir = vscale(vel, 1 / sp);
    const fwd = dv.x * vdir.x + dv.z * vdir.z;               // v 방향 성분(+전진/−제동)
    const latVec = vsub(dv, vscale(vdir, fwd));              // v 수직 성분
    const fwdApplied = fwd >= 0
      ? Math.min(fwd, kin.accelBase * Math.max(0, 1 - sp / maxSpeed) * dt)
      : Math.max(fwd, -kin.brake * dt);
    const latApplied = clampLen(latVec, kin.lateralAccel * dt);
    applied = vadd(vscale(vdir, fwdApplied), latApplied);
  }
  const goalV = clampLen(vadd(vel, applied), maxSpeed);       // maxSpeed 하드 클램프
  const nv = vadd(vel, clampLen(vsub(goalV, vel), kin.brake * dt)); // 견인력 예산
  player.velocity = nv;
  player.position = vadd(pos, vscale(nv, dt));
}

/**
 * 겹침 분리(§2.7). 두 선수가 dist 미만이면 서로 반대로 미는 목표 보정(미터)을 반환.
 * 실제 이동은 각자 seek 캡이 지배 → 순간이동 없이 부드럽게 벌어진다. 대칭 분담.
 * @returns {Record<string,{x:number,z:number}>}
 */
export function computeSeparation(players, cfg) {
  const S = cfg.separation;
  const off = {};
  const ids = Object.keys(players);
  for (const id of ids) off[id] = { x: 0, z: 0 };
  if (!S || !(S.strength > 0) || !(S.dist > 0)) return off;
  const { dist, strength } = S;
  for (let i = 0; i < ids.length; i++) {
    const a = ids[i], pa = players[a].position;
    for (let j = i + 1; j < ids.length; j++) {
      const b = ids[j], pb = players[b].position;
      const dx = pa.x - pb.x, dz = pa.z - pb.z;
      const dd = Math.hypot(dx, dz);
      if (dd >= dist) continue;
      const push = strength * (dist - dd) / 2;
      let ux, uz;
      if (dd > 1e-6) { ux = dx / dd; uz = dz / dd; }
      else { const th = hash01(a + b) * 6.283185; ux = Math.cos(th); uz = Math.sin(th); }
      off[a].x += ux * push; off[a].z += uz * push;
      off[b].x -= ux * push; off[b].z -= uz * push;
    }
  }
  return off;
}
