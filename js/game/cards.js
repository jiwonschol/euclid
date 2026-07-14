// 감독 카드 도메인 (마스터 계획서 §12): CardTiming 판정 · validateCard(검증 순서) · 전제조건.
// 덱/손패/드로우/플레이(playFromHand)는 S3, 맥락 카드 주입은 S4 에서 이 파일에 확장한다.
// 결정론: 이 파일은 state.rng 를 소비하지 않는다(판정은 상태 함수).

import { dBallOwn } from './shape.js';
import { offsideLineX } from './attack.js';
import { FIELD } from './field.js';

export const deckCardById = (C, id) => (C.deck || []).find((c) => c.id === id);

/** 현재 팀에 유효한 CardTiming 집합. */
export function matchTimings(state, team) {
  const set = new Set(['ANYTIME']);
  const poss = state.possessionTeamId;
  if (poss === team) set.add('IN_POSSESSION');
  else if (poss && poss !== team) set.add('OUT_OF_POSSESSION');
  // 공수 전환(소유 변경 후 ~4초)
  const since = state._possChangedAt != null ? state.clockSeconds - state._possChangedAt : 999;
  if (since <= 4) {
    if (poss === team) set.add('ATTACKING_TRANSITION');
    else if (poss && poss !== team) set.add('DEFENSIVE_TRANSITION');
  }
  // 파이널 서드: 소유 중 공이 상대 진영 최종 1/3
  if (poss === team) {
    const dir = state.attackDirection[team];
    if (dBallOwn(dir, state.ball.position.x) > FIELD.length * 0.66) set.add('FINAL_THIRD');
  }
  // GOALKEEPER_DUEL / SET_PIECE 는 맥락(S4)·재개(후속) 상태에서 추가된다.
  if (state.pendingEncounter && state.pendingEncounter.kind === 'GOALKEEPER_ONE_ON_ONE') set.add('GOALKEEPER_DUEL');
  if (state.restart) set.add('SET_PIECE');
  if (state.phase === 'STOPPAGE' || state.phase === 'HALFTIME') set.add('STOPPAGE');
  return set;
}

const TIMING_KR = {
  IN_POSSESSION: '공격 중', OUT_OF_POSSESSION: '수비 중',
  ATTACKING_TRANSITION: '공격 전환 순간', DEFENSIVE_TRANSITION: '수비 전환 순간',
  FINAL_THIRD: '파이널 서드', GOALKEEPER_DUEL: 'GK 1대1', SET_PIECE: '세트피스', STOPPAGE: '경기 중단',
};
const timingReason = (timing) => `타이밍 안 맞음 (필요: ${timing.map((t) => TIMING_KR[t] || t).join('/')})`;

// 전제조건 평가기 (type → (state,team,cond) → {ok, reason?})
const PRECONDS = {
  onsideRunner(state, team) {
    if (state.possessionTeamId !== team) return { ok: false, reason: '소유 중이 아님' };
    const dir = state.attackDirection[team];
    const olX = offsideLineX(state, team);
    const ballAdv = dBallOwn(dir, state.ball.position.x);
    for (const p of Object.values(state.players)) {
      if (p.teamId !== team || p.role === 'GK' || p.sentOff) continue;
      const adv = dBallOwn(dir, p.position.x);
      const onside = dir > 0 ? p.position.x <= olX + 0.3 : p.position.x >= olX - 0.3;
      if (onside && adv > ballAdv + 4 && adv > FIELD.length * 0.5) return { ok: true };
    }
    return { ok: false, reason: '온사이드 침투자 없음' };
  },
  boxTargets(state, team, cond) {
    const dir = state.attackDirection[team];
    let n = 0;
    for (const p of Object.values(state.players)) {
      if (p.teamId !== team || p.role === 'GK' || p.sentOff) continue;
      if (dBallOwn(dir, p.position.x) > FIELD.length * 0.84 && Math.abs(p.position.z) < 20) n++;
    }
    return n >= (cond.min || 1) ? { ok: true } : { ok: false, reason: `박스 인원 부족 (${n}/${cond.min || 1})` };
  },
};

/** 타겟 유효성. targetType 별로 target(선수 id | 존 문자열)을 검증. */
function validateTarget(state, team, card, target) {
  const tt = card.targetType || 'NONE';
  if (tt === 'NONE') return { ok: true };
  if (tt === 'OWN_PLAYER') {
    const p = target && state.players[target];
    return p && p.teamId === team && !p.sentOff ? { ok: true } : { ok: false, reason: '아군 선수를 지정하세요' };
  }
  if (tt === 'OPPONENT_PLAYER') {
    const p = target && state.players[target];
    return p && p.teamId !== team && !p.sentOff ? { ok: true } : { ok: false, reason: '상대 선수를 지정하세요' };
  }
  if (tt === 'PITCH_ZONE') {
    return target && ['left', 'center', 'right'].includes(target) ? { ok: true } : { ok: false, reason: '지역을 지정하세요' };
  }
  if (tt === 'BALL_CARRIER') {
    return state.ball.carrierId ? { ok: true } : { ok: false, reason: '볼 소유자가 없음' };
  }
  return { ok: true };
}

/**
 * 카드 검증(§12 순서): 1)타이밍 2)CP 3)타겟 4)전제조건 5)쿨다운. 실패 시 정확한 사유.
 * @returns {{ok:boolean, reason?:string}}
 */
export function validateCard(state, team, card, target, opts = {}) {
  if (!card) return { ok: false, reason: '없는 카드' };
  // 1) 타이밍
  const timings = matchTimings(state, team);
  if (card.timing && card.timing.length && !card.timing.some((t) => timings.has(t)))
    return { ok: false, reason: timingReason(card.timing) };
  // 2) CP (오디블 환불분 cpBonus 반영)
  const cp = (state.cp ? state.cp[team] || 0 : 0) + (opts.cpBonus || 0);
  if (cp < card.cost) return { ok: false, reason: `CP 부족 (${Math.floor(cp)}/${card.cost})` };
  // 3) 타겟
  const tv = validateTarget(state, team, card, target);
  if (!tv.ok) return tv;
  // 4) 전제조건
  for (const pc of card.preconditions || []) {
    const ev = PRECONDS[pc.type];
    const r = ev ? ev(state, team, pc) : { ok: true };
    if (!r.ok) return r;
  }
  // 5) 쿨다운(같은 cooldownGroup)
  if (card.cooldownGroup) {
    const cd = state.cardCooldowns && state.cardCooldowns[team];
    const until = cd && cd[card.cooldownGroup];
    if (until != null && state.clockSeconds < until)
      return { ok: false, reason: `재사용 대기 ${Math.ceil(until - state.clockSeconds)}초` };
  }
  return { ok: true };
}
