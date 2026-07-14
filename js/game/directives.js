// 감독 지시 카드 + 오디블 + CP + 상대 AI(김성주 신호) (계획서 §0.1).
// 유저팀=A. 지시는 '전달 중'을 거쳐 도착 시 state.tactics.A 에 반영. 전달 중 교체=오디블(비용 1회).
// 상대(B)=컴퓨터: 상황 따라 전술 전환, 김성주가 telegraphSec 먼저 신호(읽고 대응하는 루프).
// 이벤트를 eventLog 에 넣고 commentary.js 가 텍스트로 렌더. rng는 상대 AI 판단에만 소비(유저 지시는 미소비).

function ensure(state, C) {
  if (state.cp) return;
  state.cp = { A: C.cp.start };
  state.pending = { A: null };
  state.activeDirective = { A: 'balanced' };
  state._dir = { oppNext: C.opponentAI.decideEvery, oppTelegraph: null, cpAcc: 0 };
  state.subUsed = 0;
}
const cardById = (C, id) => C.cards.find((c) => c.id === id);
function log(state, type, data) {
  state.eventLog.push({ t: Math.round(state.clockSeconds * 100) / 100, half: state.half, type, ...data });
}

/** 유저(A)가 카드를 낸다. 전달 중이면 오디블(교체, 이전 비용 환불 → 최종 카드 비용만). @returns {ok, reason?, audible?} */
export function playDirective(state, cardId, C) {
  ensure(state, C);
  const card = cardById(C, cardId);
  if (!card) return { ok: false, reason: '없는 카드' };
  // 교체(즉시, 한도): 전달 없이 subBoost 즉시 반영
  if (card.sub) {
    if ((state.subUsed || 0) >= (C.substitutionLimit || 3)) return { ok: false, reason: '교체 소진' };
    if (state.cp.A < card.cost) return { ok: false, reason: 'CP 부족' };
    state.cp.A -= card.cost;
    state.subBoost.A[card.sub] += 1;
    state.subUsed = (state.subUsed || 0) + 1;
    log(state, 'SUB', { name: card.name, sub: card.sub });
    return { ok: true };
  }
  const cur = state.pending.A;
  const refund = cur ? cardById(C, cur.cardId).cost : 0;
  if (state.cp.A + refund < card.cost) return { ok: false, reason: 'CP 부족' };
  state.cp.A = Math.min(C.cp.max, state.cp.A + refund - card.cost);
  state.pending.A = { cardId, applyAt: state.clockSeconds + card.delivery, name: card.name, set: card.set };
  if (cur) log(state, 'DIRECTIVE_AUDIBLE', { name: card.name, from: cardById(C, cur.cardId).name });
  else log(state, 'DIRECTIVE_PENDING', { name: card.name, sec: card.delivery });
  return { ok: true, audible: !!cur };
}

/** 매 틱: CP 회복 + 전달 중 지시 도착 반영 */
export function stepDirectives(state, dt, C) {
  ensure(state, C);
  state._dir.cpAcc += dt;
  while (state._dir.cpAcc >= C.cp.regenSec) { state._dir.cpAcc -= C.cp.regenSec; state.cp.A = Math.min(C.cp.max, state.cp.A + 1); }
  const p = state.pending.A;
  if (p && state.clockSeconds >= p.applyAt) {
    Object.assign(state.tactics.A, p.set);
    state.activeDirective.A = p.cardId;
    log(state, 'DIRECTIVE_ARRIVED', { name: p.name });
    state.pending.A = null;
  }
}

/** 상대(B) 감독 AI + 김성주 신호 (읽고 대응하는 루프의 컴퓨터 측) */
export function stepOpponentAI(state, dt, C) {
  ensure(state, C);
  const O = C.opponentAI, d = state._dir;
  // 예고된 전환 실제 반영
  if (d.oppTelegraph && state.clockSeconds >= d.oppTelegraph.at) {
    Object.assign(state.tactics.B, d.oppTelegraph.set);
    log(state, 'SIGNAL', { key: 'opp_' + d.oppTelegraph.key, applied: true });
    d.oppTelegraph = null;
  }
  // 결정 주기
  if (state.clockSeconds >= d.oppNext && !d.oppTelegraph) {
    d.oppNext = state.clockSeconds + O.decideEvery;
    const target = chooseOppTactic(state, O);
    if (target && target.key !== currentOppKey(state)) {
      log(state, 'SIGNAL', { key: 'opp_' + target.key, telegraph: true });     // 김성주 예고
      d.oppTelegraph = { at: state.clockSeconds + O.telegraphSec, set: target.set, key: target.key };
    }
  }
}

function currentOppKey(state) {
  const t = state.tactics.B;
  if (t.tactic === 'attack') return 'attack';
  if (t.tactic === 'counter') return 'counter';
  if (t.tactic === 'park') return 'park';
  if (t.press === 'high') return 'press';
  return 'balanced';
}
function chooseOppTactic(state, O) {
  const minute = state.clockSeconds / 60;
  const diff = state.score.B - state.score.A;               // B(상대) 관점 점수차
  const mom = state.stats ? state.stats.momentum : 0;       // +A / -B
  if (diff < 0 && minute >= O.losingPushMin) {
    return state.rng.chance(0.5) ? { key: 'attack', set: { tactic: 'attack', lineHeight: 'high' } } : { key: 'press', set: { press: 'high' } };
  }
  if (diff > 0 && minute >= O.winningParkMin) return { key: 'park', set: { tactic: 'park', lineHeight: 'low' } };
  if (mom > 25) return { key: 'counter', set: { tactic: 'counter' } };          // A가 몰아붙이면 역습 노림
  if (mom < -25) return { key: 'attack', set: { tactic: 'attack' } };           // B가 흐름 잡으면 공격
  return state.rng.chance(0.4) ? { key: 'balanced', set: { tactic: 'balanced', lineHeight: 'mid', press: 'normal' } } : null;
}
