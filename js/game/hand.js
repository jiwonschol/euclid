// 감독 카드 런타임 (마스터 계획서 §12 하이브리드 + euclid 정체성).
//   · 하스스톤형: 덱에서 뽑는 손패(A=유저), CP 경제, 카드 타입/타겟.
//   · euclid 정체성: 카드를 내면 '전달중'(delivery)을 거쳐 도착 시 효과 발동. 전달 중 교체=오디블.
//   · 상대(B)=컴퓨터: 상황 따라 카드 선택, 김성주가 telegraphSec 먼저 예고(읽고 대응하는 루프).
// S1 효과 엔진(effects.addEffect) + S2 검증(cards.validateCard) 위에 얹는다.
// 카드 무작위(셔플/드로우/상대 판단)는 state.cardRng — 경기 시뮬 rng(state.rng)와 분리(시뮬 재현 불변).

import { createRng } from './rng.js';
import { addEffect } from './effects.js';
import { validateCard, deckCardById } from './cards.js';

const other = (t) => (t === 'A' ? 'B' : 'A');

function log(state, type, data) {
  state.eventLog.push({ t: Math.round(state.clockSeconds * 100) / 100, half: state.half, type, ...data });
}

/** 결정적 Fisher-Yates(cardRng). */
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) { const j = rng.int(0, i); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
  return arr;
}

export function ensureCards(state, C) {
  if (state._card) return;
  state.cardRng = createRng((((state.seed >>> 0) * 2654435761) >>> 0) ^ 0x51ed2c1f);   // 카드 전용 스트림
  const ids = (C.deck || []).map((c) => c.id);
  state.cards = { A: { deck: shuffle(ids.slice(), state.cardRng), hand: [], discard: [] } };  // 손패는 유저(A)만
  state.cp = state.cp && state.cp.A != null ? state.cp : { A: C.cp.start };
  if (state.cp.B == null) state.cp.B = C.cp.start;
  state.cardCooldowns = { A: {}, B: {} };
  state.pending = { A: null };                        // 유저 전달중 카드
  state.subBoost = state.subBoost || { A: { fw: 0, mf: 0, df: 0 }, B: { fw: 0, mf: 0, df: 0 } };
  state.subUsed = { A: 0, B: 0 };
  state.activeDirective = { A: 'balanced' };          // 뷰어 하위호환(마지막 도착 카드명)
  state._card = { cpAcc: { A: 0, B: 0 }, drawAcc: 0, oppNext: C.opponentAI.decideEvery, oppTelegraph: null, lastPoss: null };
  for (let i = 0; i < (C.draw.startHand || 4); i++) drawOne(state, C);
}

/** 유저(A) 덱→손패 1장. 덱 소진 시 버림더미 셔플. 손패 상한이면 무시. */
export function drawOne(state, C) {
  const cc = state.cards.A;
  if (cc.hand.length >= (C.draw.handMax || 6)) return null;
  if (cc.deck.length === 0) {
    if (cc.discard.length === 0) return null;
    cc.deck = shuffle(cc.discard.slice(), state.cardRng); cc.discard = [];
  }
  const id = cc.deck.shift();
  const slot = { id, card: deckCardById(C, id), drawnAt: state.clockSeconds };
  cc.hand.push(slot);
  return slot;
}

/** 카드 effects → ActiveEffect 로 변환해 활성화(effects.addEffect). '$target' 치환. */
export function applyCard(state, team, card, target) {
  const mods = (card.effects || []).map((e) => ({ ...e, value: e.value === '$target' ? target : e.value }));
  const until = card.durationSeconds != null ? state.clockSeconds + card.durationSeconds : null;
  const scope = mods.some((m) => m.scope === 'NEXT_ACTION') ? 'NEXT_ACTION' : 'TEAM';
  addEffect(state, team, {
    id: card.id, group: card.cooldownGroup || card.id, mods, until, scope,
    stacking: card.stacking || 'REFRESH', meta: { name: card.name, target },
  });
}

function setCooldown(state, team, card) {
  if (card.cooldownGroup) state.cardCooldowns[team][card.cooldownGroup] = state.clockSeconds + (card.durationSeconds || 0) * 0.5 + 8;
}

/**
 * 유저(A)가 손패의 카드를 낸다 → 전달중. 전달 중 다른 카드=오디블(이전 카드 손패 복귀 + 비용 재정산).
 * @returns {{ok:boolean, reason?:string, audible?:boolean}}
 */
export function playFromHand(state, team, handIndex, target, C) {
  ensureCards(state, C);
  if (team !== 'A') return { ok: false, reason: '유저 손패는 A만' };
  const cc = state.cards.A;
  const slot = cc.hand[handIndex];
  if (!slot) return { ok: false, reason: '빈 손패 슬롯' };
  const card = slot.card;
  const cur = state.pending.A;
  const refund = cur ? cur.card.cost : 0;
  const v = validateCard(state, 'A', card, target, { cpBonus: refund });
  if (!v.ok) return v;
  if (cur) {                                          // 오디블: 이전 전달중 카드 손패 복귀 + 환불
    cc.hand.push({ id: cur.id, card: cur.card, drawnAt: state.clockSeconds });
    state.cp.A += refund;
  }
  state.cp.A -= card.cost;
  const idx = cc.hand.indexOf(slot);
  if (idx >= 0) cc.hand.splice(idx, 1);
  const delivery = card.delivery != null ? card.delivery : (C.draw.deliverySec || 0);
  state.pending.A = { id: slot.id, card, target, name: card.name, applyAt: state.clockSeconds + delivery };
  if (cur) log(state, 'DIRECTIVE_AUDIBLE', { name: card.name, from: cur.name });
  else log(state, 'DIRECTIVE_PENDING', { name: card.name, sec: delivery });
  return { ok: true, audible: !!cur };
}

/** 즉시 교체(§8-D): subBoost 반영, substitutionLimit 제한. */
export function playSub(state, team, kind, cost, C) {
  ensureCards(state, C);
  if ((state.subUsed[team] || 0) >= (C.substitutionLimit || 3)) return { ok: false, reason: '교체 소진' };
  if (state.cp[team] < cost) return { ok: false, reason: 'CP 부족' };
  state.cp[team] -= cost;
  state.subBoost[team][kind] += 1;
  state.subUsed[team] += 1;
  log(state, 'SUB', { team, sub: kind });
  return { ok: true };
}

/** 전달중(A) 도착 처리. */
function stepPending(state, C) {
  const p = state.pending.A;
  if (p && state.clockSeconds >= p.applyAt) {
    applyCard(state, 'A', p.card, p.target);
    setCooldown(state, 'A', p.card);
    state.cards.A.discard.push(p.id);
    state.activeDirective.A = p.card.id;
    log(state, 'DIRECTIVE_ARRIVED', { name: p.name });
    state.pending.A = null;
  }
}

/** 볼 재획득 시: CP 소량 보너스(양 팀) + 유저 즉시 드로우 1장(§12). */
function handleRegain(state, C) {
  const poss = state.possessionTeamId;
  const d = state._card;
  if (poss && poss !== d.lastPoss) {
    if (d.lastPoss !== null) {                        // 최초 킥오프 제외
      state.cp[poss] = Math.min(C.cp.max, state.cp[poss] + (C.cp.regainBonus || 0));
      if (poss === 'A' && C.draw.regainDraw) drawOne(state, C);
    }
    d.lastPoss = poss;
  }
}

// ── 상대(B) 감독 AI: 상황 판단 → 김성주 예고 → 적용 ──────────────
function chooseOppCard(state, C) {
  const O = C.opponentAI, rng = state.cardRng;
  const minute = state.clockSeconds / 60;
  const diff = state.score.B - state.score.A;                 // B(상대) 관점 점수차
  const mom = state.stats ? state.stats.momentum : 0;         // +A / −B
  if (diff < 0 && minute >= O.losingPushMin) return { cardId: rng.chance(0.5) ? 'all_out' : 'high_press' };
  if (diff > 0 && minute >= O.winningParkMin) return { cardId: rng.chance(0.5) ? 'low_block' : 'slow_tempo' };
  if (mom > 25) return { cardId: 'low_block' };               // A가 몰아붙이면 내려서 막음
  if (mom < -25) return { cardId: rng.chance(0.5) ? 'all_out' : 'flair' };   // B가 흐름 잡으면 공격
  // 평시: 가끔 압박/밀착 마크로 변화
  if (rng.chance(0.35)) return { cardId: 'high_press' };
  if (rng.chance(0.25)) return oppManMark(state);            // A 핵심 선수 마크
  return null;
}

function oppManMark(state) {
  // A의 가장 전진한 아웃필더(상대 골문에 가까운) 지정
  const dir = state.attackDirection.A;
  let best = null, bx = -Infinity;
  for (const p of Object.values(state.players)) {
    if (p.teamId !== 'A' || p.role === 'GK' || p.sentOff) continue;
    const adv = dir * p.position.x;
    if (adv > bx) { bx = adv; best = p; }
  }
  return best ? { cardId: 'man_mark', target: best.id } : null;
}

function stepOpponentCards(state, dt, C) {
  const O = C.opponentAI, d = state._card;
  if (d.oppTelegraph && state.clockSeconds >= d.oppTelegraph.at) {   // 예고 → 실제 적용
    const card = deckCardById(C, d.oppTelegraph.cardId);
    if (card && validateCard(state, 'B', card, d.oppTelegraph.target).ok) {
      state.cp.B -= card.cost;
      applyCard(state, 'B', card, d.oppTelegraph.target);
      setCooldown(state, 'B', card);
      log(state, 'SIGNAL', { key: 'opp_' + card.id, name: card.name, applied: true });
    }
    d.oppTelegraph = null;
  }
  if (state.clockSeconds >= d.oppNext && !d.oppTelegraph) {
    d.oppNext = state.clockSeconds + O.decideEvery;
    const pick = chooseOppCard(state, C);
    if (pick) {
      const card = deckCardById(C, pick.cardId);
      if (card && validateCard(state, 'B', card, pick.target).ok) {
        log(state, 'SIGNAL', { key: 'opp_' + card.id, name: card.name, telegraph: true });   // 김성주 예고
        d.oppTelegraph = { at: state.clockSeconds + O.telegraphSec, cardId: pick.cardId, target: pick.target };
      }
    }
  }
}

/** 매 틱 카드 런타임: CP 회복 + 드로우 + 재획득 보너스 + 전달중 도착 + 상대 AI. */
export function stepCards(state, dt, C) {
  ensureCards(state, C);
  const d = state._card;
  for (const team of ['A', 'B']) {
    d.cpAcc[team] += dt;
    while (d.cpAcc[team] >= C.cp.regenSec) { d.cpAcc[team] -= C.cp.regenSec; state.cp[team] = Math.min(C.cp.max, state.cp[team] + 1); }
  }
  d.drawAcc += dt;
  while (d.drawAcc >= C.draw.drawEverySec) { d.drawAcc -= C.draw.drawEverySec; drawOne(state, C); }
  handleRegain(state, C);
  stepPending(state, C);
  stepOpponentCards(state, dt, C);
}
