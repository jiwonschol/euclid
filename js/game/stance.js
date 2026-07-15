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

/**
 * 하프타임 브리핑: 참모가 전반을 요약해 '질의'하고 선수들이 제안한다.
 * 전반 끝나고 곧장 후반으로 넘기지 않고, 유저가 읽고 고쳐 잡는 시간(§디자이너).
 * 순수 함수 — rng 미소비.
 */
export function halftimeBrief(state, C) {
  const st = state.stats, out = [];
  const tot = st.possTicks.A + st.possTicks.B || 1;
  const poss = Math.round(100 * st.possTicks.A / tot);
  const diff = state.score.A - state.score.B;
  out.push({ who: '요약', text: `전반 ${state.score.A} : ${state.score.B} · 점유 ${poss}% · 유효슈팅 ${st.onTarget.A}-${st.onTarget.B} · xG ${st.xg.A.toFixed(1)}-${st.xg.B.toFixed(1)}` });

  // 참모: 전반에 상대가 어디로 왔는지 → 후반 대비를 '질의'
  const threat = state.seq && state.seq.threat === 'wing' ? 'wing' : 'central';
  out.push({ who: '참모', text: threat === 'wing'
    ? '전반 내내 상대가 측면으로 왔습니다. 후반도 그럴 겁니다 — 측면 수비로 잠글까요?'
    : '상대가 중앙만 노렸습니다. 후반은 중앙을 두껍게 가는 게 맞습니다 — 어떻게 할까요?',
    suggest: { group: 'defend_zone', option: threat } });

  if (diff < 0) out.push({ who: '참모', text: '지고 있습니다. 후반엔 던져야 합니다.', suggest: { group: 'mentality', option: 'all_out' } });
  else if (diff > 0) out.push({ who: '참모', text: '앞서고 있습니다. 라인을 내려 지킬까요?', suggest: { group: 'line', option: 'down' } });

  // 선수 제안 — 상태에서 뽑은 직접적인 요구
  if (poss < 45) out.push({ who: '미드필더', text: '중원에서 볼이 안 옵니다. 템포를 우리가 잡게 해주세요.', suggest: { group: 'mentality', option: 'counter' } });
  if (st.onTarget.A === 0) out.push({ who: '공격수', text: '슛 각이 안 납니다. 측면에서 올려주면 붙어보겠습니다.', suggest: { group: 'attack_zone', option: 'wing' } });
  if (st.xg.B > st.xg.A) out.push({ who: '수비수', text: '뒷공간이 계속 열립니다. 라인을 내려주세요.', suggest: { group: 'line', option: 'down' } });
  return out;
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
    // 하이라이트는 '랠리'다 — 드물고 의미 있어야 한다. 조건이 느슨하면 경기당 205회가 되어
    // 아무것도 특별하지 않게 된다(실측). 파이널서드 + 패스 누적 + 쿨다운을 모두 요구한다.
    const ready = elapsed >= B.minSec;
    const cooled = state.clockSeconds - (s.lastEnd || -999) >= B.cooldownSec;
    const real = d > B.highlightFinalThird && passes >= B.highlightMinPasses;
    if (ready && cooled && real) {
      s.mode = 'HIGHLIGHT'; s.since = state.clockSeconds; s.id++;
      log(state, 'HIGHLIGHT_START', { team: poss, threat, passes });
    }
  } else {
    // 하이라이트 종료: 공이 파이널서드를 확실히 벗어나거나 시간 초과
    if (d < B.highlightFinalThird - 12 || elapsed > B.maxSec) {
      s.mode = 'BUILDUP'; s.since = state.clockSeconds; s.lastEnd = state.clockSeconds;
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

// ── 지시 성공 (이 게임의 재미 = 감독의 선택) ────────────────
// 유저가 고른 카드의 '의도'대로 결과가 나오면 알린다. 골이 아니어도 된다 —
// '측면 수비'를 걸어두고 측면에서 실제로 끊어내면 그게 지시 성공이다.
const SUCCESS = [
  { group: 'defend_zone', when: (s, e, R) => e.type === 'TACKLE' && e.team === 'A' && R.defendZone !== 'balance' && R.defendZone === s.seq.threat,
    text: (o) => `${o} 지시가 통했습니다 — 상대의 공격 방향을 읽고 끊어냈습니다.` },
  { group: 'defend_zone', when: (s, e, R) => e.type === 'INTERCEPT' && e.team === 'A' && R.defendZone !== 'balance' && R.defendZone === s.seq.threat,
    text: (o) => `${o} 지시가 통했습니다 — 예상한 길목에서 가로챘습니다.` },
  { group: 'press', when: (s, e, R) => e.type === 'TACKLE' && e.team === 'A' && R.press === 'high',
    text: () => `높은 압박이 통했습니다 — 높은 위치에서 볼을 뺏어냅니다.` },
  { group: 'attack_zone', when: (s, e, R) => (e.type === 'SHOT' || e.type === 'GOAL') && e.team === 'A' && R.attackZone === 'wing' && s.seq.threat === 'wing',
    text: () => `측면 공격 지시가 통했습니다 — 측면을 열어 슛까지 갔습니다.` },
  { group: 'attack_zone', when: (s, e, R) => (e.type === 'SHOT' || e.type === 'GOAL') && e.team === 'A' && R.attackZone === 'central' && s.seq.threat === 'central',
    text: () => `중앙 공격 지시가 통했습니다 — 중앙을 뚫고 슛까지 갔습니다.` },
  { group: 'mentality', when: (s, e, R) => (e.type === 'SHOT' || e.type === 'GOAL') && e.team === 'A' && R.tactic === 'attack',
    text: () => `전원 공격이 통했습니다 — 쏟아부은 인원이 슛을 만듭니다.` },
  { group: 'mentality', when: (s, e, R) => e.type === 'SHOT' && e.team === 'A' && R.tactic === 'counter',
    text: () => `역습 지시가 통했습니다 — 뺏자마자 단숨에 슛까지.` },
  { group: 'line', when: (s, e, R) => e.type === 'OFFSIDE' && e.team === 'B' && R.lineHeight === 'high',
    text: () => `라인 올리기가 통했습니다 — 상대를 오프사이드로 잡았습니다.` },
];

function stepSuccess(state, C) {
  const st = state._st;
  if (st.sucIdx == null) st.sucIdx = 0;
  const R = state.resolved && state.resolved.A;
  if (!R) { st.sucIdx = state.eventLog.length; return; }
  for (; st.sucIdx < state.eventLog.length; st.sucIdx++) {
    const e = state.eventLog[st.sucIdx];
    if (state.clockSeconds - (st.sucAt || -999) < (C.successCooldownSec || 120)) continue;
    for (const r of SUCCESS) {
      if (state.stance.A[r.group] === 'balance') continue;         // 밸런스는 '선택'이 아니다
      let hit = false;
      try { hit = r.when(state, e, R); } catch { hit = false; }
      if (!hit) continue;
      const g = groupById(C, r.group), o = optById(g, state.stance.A[r.group]);
      st.sucAt = state.clockSeconds;
      log(state, 'DIRECTIVE_SUCCESS', { group: g.name, option: o.name, text: r.text(o.name) });
      return;
    }
  }
}

/** 매 틱: 전달 중 도착 · 시퀀스 모드 · 참모 · 상대 AI · 교체 결과 보고 · 지시 성공 */
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
  stepSuccess(state, C);
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
