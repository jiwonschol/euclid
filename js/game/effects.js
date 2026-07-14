// 데이터 기반 감독 카드 효과 엔진 (마스터 계획서 §12 "TacticalModifier").
//
// 설계: 카드별 if문을 decide/ai/viewer 에 흩뿌리지 않는다.
//   · state.tactics[team]  = 기본 스탠스(문자열: tactic/lineHeight/press/attackZone). 지시 카드·상대 AI가 바꾼다.
//   · state.effects[team]  = 활성 카드 효과 [{id,group,mods,until,stacking,meta}]. 지속시간(경기초) 만료.
//   · resolve(state,team)  = 스탠스 + 활성 modifier 합성 → ResolvedTactics. AI가 읽는 유일한 소스.
//
// 결정론: 이 파일은 state.rng 를 소비하지 않는다(재현성 게이트). until 은 clockSeconds 기준.
// 기본값(무효과)은 createMatch 의 tactics 기본과 동일 → 카드 미사용 시 동작 불변(게이트 유지).

/** ResolvedTactics 기본값(무효과). MULTIPLY 대상=1, ADD 대상=0, 플래그=false/null. */
function defaults() {
  return {
    // 스탠스 미러
    tactic: 'balanced', lineHeight: 'mid', press: 'normal', attackZone: 'central',
    // 카드 modifier 대상 키 (registry — docs/card_system_build_plan.md)
    shotBias: 1, dribbleBias: 1, passBias: 1, throughBias: 1, tempo: 1, pressAggression: 1,
    crossEarly: false, overlapSide: null, switchNext: false, transition: null,
    commitForward: 0, manMark: null, gutsThresh: 1, nextAction: null,
  };
}

export function ensureEffects(state) {
  if (!state.effects) state.effects = { A: [], B: [] };
}

/** 활성 효과 만료(지속시간 경과) 제거. rng 미소비. */
export function stepEffects(state) {
  ensureEffects(state);
  const now = state.clockSeconds;
  for (const team of ['A', 'B']) {
    const arr = state.effects[team];
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].until != null && now >= arr[i].until) arr.splice(i, 1);
    }
  }
}

/** modifier 하나를 base 에 적용. op: ADD | MULTIPLY | OVERRIDE. */
function applyMod(base, m) {
  const cur = base[m.key];
  if (m.operation === 'OVERRIDE') base[m.key] = m.value;
  else if (m.operation === 'ADD') base[m.key] = (typeof cur === 'number' ? cur : 0) + m.value;
  else if (m.operation === 'MULTIPLY') base[m.key] = (typeof cur === 'number' ? cur : 1) * m.value;
}

/** 스탠스 + 활성 효과 → ResolvedTactics(새 객체). */
export function resolve(state, team) {
  const base = defaults();
  const stance = state.tactics && state.tactics[team];
  if (stance) {
    if (stance.tactic != null) base.tactic = stance.tactic;
    if (stance.lineHeight != null) base.lineHeight = stance.lineHeight;
    if (stance.press != null) base.press = stance.press;
    if (stance.attackZone != null) base.attackZone = stance.attackZone;
  }
  const arr = state.effects && state.effects[team];
  if (arr && arr.length) {
    for (const e of arr) if (e.mods) for (const m of e.mods) applyMod(base, m);   // 등록 순서(오래된→새것)
  }
  return base;
}

/** 캐시 우선 조회(틱당 1회 stepResolve 계산분). 없으면 즉석 계산(안전 폴백). */
export function resolvedFor(state, team) {
  return (state.resolved && state.resolved[team]) || resolve(state, team);
}

/** 틱당 1회: 양 팀 resolved 캐시. stepEffects 이후에 호출. */
export function stepResolve(state) {
  state.resolved = { A: resolve(state, 'A'), B: resolve(state, 'B') };
}

/**
 * 효과 추가(스택 규칙 적용). 같은 group 이 이미 있으면:
 *   REJECT=거부, REFRESH=시간만 갱신(수치 중복 없음), REPLACE=교체, STACK=중첩.
 * @param {Object} effect {id, group?, mods, until?, stacking?, meta?}
 * @returns {{ok:boolean, reason?:string, refreshed?:boolean}}
 */
export function addEffect(state, team, effect) {
  ensureEffects(state);
  const arr = state.effects[team];
  const stacking = effect.stacking || 'REFRESH';
  const gi = effect.group ? arr.findIndex((e) => e.group === effect.group) : -1;
  if (gi >= 0) {
    if (stacking === 'REJECT') return { ok: false, reason: '이미 활성' };
    if (stacking === 'REFRESH') { arr[gi].until = effect.until; return { ok: true, refreshed: true }; }
    if (stacking === 'REPLACE') arr.splice(gi, 1);
    // STACK: 그대로 추가
  }
  arr.push(effect);
  return { ok: true };
}

/** NEXT_ACTION 스코프 효과 1개 소비(다음 소유 행동 시 호출). key 예: 'switchNext','nextAction'. */
export function consumeNextAction(state, team, key) {
  ensureEffects(state);
  const arr = state.effects[team];
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].scope === 'NEXT_ACTION' && (!key || (arr[i].mods || []).some((m) => m.key === key))) {
      const e = arr[i]; arr.splice(i, 1); return e;
    }
  }
  return null;
}
