// 감독 스탠스 카드 + 빌드업/하이라이트 문법 + 참모 (디자이너 2026-07-15 재정의).
//
// 이 게임의 문법:
//   빌드업(바둑알 끔 · 힌트 중계) → 유저가 '반응'(스탠스 카드) → 하이라이트(바둑알 켬 · 카드 반영된 결과)
// 의미 없는 플레이를 바둑알로 재생하지 않는 게 핵심이다. FM 처럼 그 구간은 글로만 흘리고,
// 그 시간이 곧 유저가 읽고 대응하는 시간이다.
//
// CP·덱·드로우·개입권 없음(복잡도만 증가). 카드 = 상반 개념 그룹, 각 그룹 밸런스 기본 + 상반 2개.
// 효과는 effects.js 의 resolve 키로 매핑되는 데이터(카드별 if문 금지).
// 결정론: 유저 선택은 rng 미소비. 상대 AI·교체 보정만 state.rng 소비.

import { addEffect } from './effects.js';
import { dBallOwn } from './shape.js';

const other = (t) => (t === 'A' ? 'B' : 'A');

function log(state, type, data) {
  state.eventLog.push({ t: Math.round(state.clockSeconds * 100) / 100, half: state.half, type, ...data });
}

export function ensureStance(state, C) {
  if (state.stance) return;
  const base = {};
  for (const g of C.groups) base[g.id] = 'balance';
  state.stance = { A: { ...base }, B: { ...base } };
  state.pending = { A: null };
  state.subs = { A: { left: C.subs.limit, used: [] } };
  state.advice = null;                       // 참모 현재 조언 {id,text,suggest}
  state.seq = { mode: 'BUILDUP', threat: null, since: 0, id: 0 };
  state._st = { oppNext: C.opponentAI.decideEvery, oppTele: null, adviceNext: 6, lastHint: null };
  applyStance(state, 'A', C, true);
  applyStance(state, 'B', C, true);
}

const groupById = (C, id) => C.groups.find((g) => g.id === id);
const optById = (g, id) => g && g.options.find((o) => o.id === id);

/** 팀의 현재 스탠스 전체를 effects 로 재적용(그룹당 REPLACE — 한 그룹은 하나만 활성). */
function applyStance(state, team, C, silent) {
  for (const g of C.groups) {
    const o = optById(g, state.stance[team][g.id]);
    if (!o) continue;
    addEffect(state, team, {
      id: `${g.id}:${o.id}`, group: g.id, mods: o.mods || [],
      until: null, stacking: 'REPLACE',
      meta: { group: g.name, option: o.name, icon: g.icon },
    });
  }
  if (!silent) log(state, 'STANCE_APPLIED', { team });
}

/**
 * 유저(A)가 카드를 낸다 → 전달 중(pending). 이미 전달 중이면 교체(오디블).
 * 같은 그룹의 다른 옵션을 고르면 그 그룹만 바뀐다. rng 미소비.
 */
export function selectStance(state, team, groupId, optionId, C) {
  ensureStance(state, C);
  const g = groupById(C, groupId), o = optById(g, optionId);
  if (!g || !o) return { ok: false, reason: '없는 카드' };
  if (state.stance[team][groupId] === optionId && !state.pending[team]) return { ok: false, reason: '이미 적용 중' };
  const prev = state.pending[team];
  state.pending[team] = {
    group: groupId, option: optionId, groupName: g.name, optionName: o.name, icon: g.icon,
    applyAt: state.clockSeconds + C.delivery.sec,
  };
  if (prev) log(state, 'STANCE_AUDIBLE', { team, name: o.name, group: g.name, from: prev.optionName });
  else log(state, 'STANCE_PENDING', { team, name: o.name, group: g.name, sec: C.delivery.sec });
  return { ok: true, audible: !!prev };
}

/** 참모 조언 그대로 받아들이기 → 그 스탠스를 낸다. */
export function acceptAdvice(state, C) {
  ensureStance(state, C);
  if (!state.advice) return { ok: false, reason: '조언 없음' };
  const s = state.advice.suggest;
  const r = selectStance(state, 'A', s.group, s.option, C);
  if (r.ok) { log(state, 'ADVICE_TAKEN', { text: state.advice.text }); state.advice = null; }
  return r;
}

/** 교체 투입. 역할별로 확률을 올리되 0%가 나올 수도 있다(음수 없음 — 프로토). */
export function playSub(state, role, C) {
  ensureStance(state, C);
  const S = state.subs.A;
  if (S.left <= 0) return { ok: false, reason: '교체 소진' };
  const R = C.subs.roles[role];
  if (!R) return { ok: false, reason: '없는 교체' };
  const boost = state.rng.float() * C.subs.maxBoost;     // 0 ~ maxBoost (0% 가능, 음수 불가)
  S.left -= 1;
  S.used.push(role);
  addEffect(state, 'A', {
    id: `sub:${role}:${S.used.length}`, group: `sub_${role}`,
    mods: [{ key: R.key, operation: 'MULTIPLY', value: 1 + boost }],
    until: null, stacking: 'STACK', meta: { group: '교체', option: R.name },
  });
  // 투입 후 시퀀스 중 '언젠가 한 번' 결과를 알린다(다음 시퀀스로 못 박지 않음)
  state._st.subReport = { role, boost, afterSeq: state.seq.id, fired: false };
  log(state, 'SUB', { role, name: R.name, boost: Math.round(boost * 100) });
  return { ok: true, boost };
}

// ── 빌드업 / 하이라이트 ────────────────────────────────────
// 공이 파이널서드에 들어가고 패스가 이어지면 = 랠리 = 하이라이트(바둑알 켬).
// 그 외 = 빌드업(바둑알 끔, 글로만). 의미 없는 1-2 패스는 아예 화면에 안 나온다.
function stepSeq(state, C) {
  const B = C.buildup, s = state.seq, poss = state.possessionTeamId;
  if (!poss) return;
  const dir = state.attackDirection[poss];
  const d = dBallOwn(dir, state.ball.position.x);
  const passes = state._seqPasses || 0;
  const threat = Math.abs(state.ball.position.z) > 18 ? 'wing' : 'central';
  const elapsed = state.clockSeconds - s.since;

  if (s.mode === 'BUILDUP') {
    s.threat = threat;
    const ready = elapsed >= B.minSec;
    const real = d > B.highlightFinalThird && passes >= B.highlightMinPasses;
    if (ready && real) {
      s.mode = 'HIGHLIGHT'; s.since = state.clockSeconds; s.id++;
      log(state, 'HIGHLIGHT_START', { team: poss, threat, passes });
    }
  } else {
    // 하이라이트 종료: 소유권이 넘어갔거나 공이 파이널서드를 벗어나면
    if (d < B.highlightFinalThird - 10 || elapsed > 25) {
      s.mode = 'BUILDUP'; s.since = state.clockSeconds;
      log(state, 'HIGHLIGHT_END', {});
    }
  }
}

/** 수비 방향 vs 실제 위협 매치업 배수. 맞히면↑ 반대면↓ — 읽고 대응의 핵심. */
export function threatMul(state, defTeam, C) {
  if (!state.seq || !C || !C.matchup) return 1;
  const R = state.resolved && state.resolved[defTeam];
  const dz = (R && R.defendZone) || 'balance';
  if (dz === 'balance') return C.matchup.balance;
  const threat = state.seq.threat || 'central';
  return dz === threat ? C.matchup.hit : C.matchup.miss;
}

// ── 참모 ───────────────────────────────────────────────────
function pickHint(state, C) {
  const O = C.opponentAI, min = state.clockSeconds / 60;
  const diff = state.score.A - state.score.B;
  const oppStance = state.stance.B;
  const poss = state.possessionTeamId;
  const tele = state._st.oppTele;
  const find = (id) => C.advisor.hints.find((h) => h.id === id);

  if (tele && tele.group === 'mentality' && tele.option === 'all_out') return find('opp_sub_fw');
  if (oppStance.press === 'high') return find('opp_press');
  if (oppStance.line === 'down') return find('opp_park');
  if (diff < 0 && min >= O.losingPushMin) return find('losing_late');
  if (diff > 0 && min >= O.winningParkMin) return find('winning_late');
  // 상대가 우리 진영에서 공격 중이면 그 방향을 읽어준다
  if (poss === 'B' && state.seq.threat) return find(state.seq.threat === 'wing' ? 'opp_wing' : 'opp_central');
  if (poss === 'A' && state.stance.A.attack_zone === 'wing') return find('we_wing');
  return null;
}

function stepAdvisor(state, C) {
  const st = state._st;
  if (state.clockSeconds < st.adviceNext) return;
  st.adviceNext = state.clockSeconds + C.advisor.everySec;
  const h = pickHint(state, C);
  if (!h) return;
  // 같은 조언이라도 repeatSec 지나면 다시 말한다. (영구 dedupe 였을 땐 경기당 2번밖에 안 떴다 —
  // 참모는 계속 개입해야 유저가 반응할 거리가 생긴다.)
  if (h.id === st.lastHint && state.clockSeconds - (st.lastHintAt || -99) < (C.advisor.repeatSec || 45)) return;
  st.lastHint = h.id; st.lastHintAt = state.clockSeconds;
  state.advice = { id: h.id, text: h.text, suggest: h.suggest };
  log(state, 'ADVICE', { text: h.text, group: h.suggest.group, option: h.suggest.option });
}

// ── 상대 감독 AI (유저와 같은 스탠스 시스템) ────────────────
function chooseOpp(state, C) {
  const O = C.opponentAI, min = state.clockSeconds / 60;
  const diff = state.score.B - state.score.A;
  if (diff < 0 && min >= O.losingPushMin) return { group: 'mentality', option: 'all_out' };
  if (diff > 0 && min >= O.winningParkMin) return { group: 'line', option: 'down' };
  if (state.rng.chance(0.45)) return { group: 'attack_zone', option: state.rng.chance(0.5) ? 'wing' : 'central' };
  if (state.rng.chance(0.3)) return { group: 'press', option: 'high' };
  return null;
}

function stepOpp(state, C) {
  const st = state._st, O = C.opponentAI;
  if (st.oppTele && state.clockSeconds >= st.oppTele.at) {
    state.stance.B[st.oppTele.group] = st.oppTele.option;
    applyStance(state, 'B', C, true);
    log(state, 'OPP_STANCE', { group: st.oppTele.group, option: st.oppTele.option, name: st.oppTele.name });
    st.oppTele = null;
  }
  if (state.clockSeconds >= st.oppNext && !st.oppTele) {
    st.oppNext = state.clockSeconds + O.decideEvery;
    const t = chooseOpp(state, C);
    if (t && state.stance.B[t.group] !== t.option) {
      const g = groupById(C, t.group), o = optById(g, t.option);
      st.oppTele = { ...t, at: state.clockSeconds + O.telegraphSec, name: o.name };
    }
  }
}

/** 매 틱: 전달 중 도착 · 시퀀스 모드 · 참모 · 상대 AI · 교체 결과 보고 */
export function stepStance(state, dt, C) {
  ensureStance(state, C);
  const p = state.pending.A;
  if (p && state.clockSeconds >= p.applyAt) {
    state.stance.A[p.group] = p.option;
    applyStance(state, 'A', C, true);
    log(state, 'STANCE_ARRIVED', { team: 'A', name: p.optionName, group: p.groupName });
    state.pending.A = null;
  }
  stepSeq(state, C);
  stepAdvisor(state, C);
  stepOpp(state, C);

  // 교체 결과 보고: 투입 '다음' 시퀀스로 못 박지 않고, 이후 시퀀스 중 언젠가 한 번
  const r = state._st.subReport;
  if (r && !r.fired && state.seq.id > r.afterSeq && state.rng.chance(0.35 * dt * 15)) {
    r.fired = true;
    const R = C.subs.roles[r.role];
    const msg = r.boost < 0.06 ? C.subs.failMsg[r.role] : R.msg;
    log(state, 'SUB_REPORT', { role: r.role, boost: Math.round(r.boost * 100), text: msg });
  }
}
