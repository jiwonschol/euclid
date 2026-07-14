// 실시간 중계·시스템 메시지 엔진 (계획서 §0.1: 텍스트가 코어).
// 경기 상태를 읽어 자주·다양하게 한국어 중계를 state.feed 에 쌓고, 판단 근거 스탯을 state.stats 에 누적한다.
// rng 절대 소비 금지(결정론) → 판정 불변. 템플릿은 data/commentary.json, 선택은 키별 카운터 순환(다양성).

import { dBallOwn } from './shape.js';

function ensure(state) {
  if (state.feed) return;
  state.feed = [];
  state.stats = { possTicks: { A: 0, B: 0 }, shots: { A: 0, B: 0 }, onTarget: { A: 0, B: 0 }, momentum: 0 };
  state._comm = { lastIdx: 0, lastBeat: -99, lastStat: -99, counters: {}, lastFlow: '', spellPoss: null, spellStart: 0, prevPoss: null };
}

function pick(state, key, arr) {
  const c = state._comm.counters;
  c[key] = (c[key] || 0) + 1;
  return arr[(c[key] - 1) % arr.length];
}
// 한글 받침 여부(마지막 음절에 종성이 있나)
function hasBatchim(word) {
  const s = String(word); if (!s) return false;
  const c = s.charCodeAt(s.length - 1);
  if (c < 0xAC00 || c > 0xD7A3) return false;
  return (c - 0xAC00) % 28 !== 0;
}
// {T}/{O} 치환 + 조사 마커(#가 #는 #를 #와). 마커는 직전 치환어의 받침으로 이/가·은/는·을/를·와/과 선택.
function fill(tmpl, v) {
  let last = '';
  return tmpl.replace(/\{(\w+)\}|#(가|이|는|은|를|을|와|과)/g, (m, key, j) => {
    if (key !== undefined) { last = v[key] !== undefined ? String(v[key]) : ''; return last; }
    const b = hasBatchim(last);
    return ({ '가': b ? '이' : '가', '이': b ? '이' : '가', '는': b ? '은' : '는', '은': b ? '은' : '는',
      '를': b ? '을' : '를', '을': b ? '을' : '를', '와': b ? '과' : '와', '과': b ? '과' : '와' })[j];
  });
}
function push(state, text, kind) {
  state._comm.seq = (state._comm.seq || 0) + 1;
  state.feed.push({ id: state._comm.seq, t: Math.round(state.clockSeconds), half: state.half, text, kind });
  if (state.feed.length > 240) state.feed.shift();
}
function nearestOppDist(state, team, pos) {
  let d = Infinity;
  for (const p of Object.values(state.players)) {
    if (p.teamId === team || p.role === 'GK' || p.sentOff) continue;
    const dd = Math.hypot(p.position.x - pos.x, p.position.z - pos.z);
    if (dd < d) d = dd;
  }
  return d;
}

/** 매 IN_PLAY 틱 호출. C = data/commentary.json */
export function stepCommentary(state, dt, C) {
  ensure(state);
  const st = state.stats, cm = state._comm, poss = state.possessionTeamId;

  // ── 스탯 누적 ──
  if (poss) st.possTicks[poss]++;
  if (poss) {
    const dir = state.attackDirection[poss];
    const terr = (dBallOwn(dir, state.ball.position.x) - 52.5) / 52.5;         // -1(수비)..+1(공격)
    st.momentum += (poss === 'A' ? 1 : -1) * (0.5 + Math.max(0, terr)) * dt;
  }
  st.momentum = Math.max(-60, Math.min(60, st.momentum * (1 - 0.02 * dt)));

  // ── 점유 전환(역습 감지) ──
  if (poss && poss !== cm.spellPoss) {
    cm.prevPoss = cm.spellPoss; cm.spellPoss = poss; cm.spellStart = state.clockSeconds;
  }

  // ── 이벤트 중계 ──
  for (; cm.lastIdx < state.eventLog.length; cm.lastIdx++) emitEvent(state, C, state.eventLog[cm.lastIdx]);

  // ── 플로우 비트 ──
  if (poss && state.clockSeconds - cm.lastBeat >= C.beatSec) {
    cm.lastBeat = state.clockSeconds;
    emitFlow(state, C);
  }
  // ── 스탯 콜아웃 ──
  if (state.clockSeconds - cm.lastStat >= (C.statSec || 16)) {
    cm.lastStat = state.clockSeconds;
    emitStat(state, C);
  }
}

function emitEvent(state, C, e) {
  const nm = C.teams;
  const T = (t) => nm[t] || t, O = (t) => nm[t === 'A' ? 'B' : 'A'];
  const st = state.stats, E = C.event;
  switch (e.type) {
    case 'SHOT': st.shots[e.team]++; push(state, fill(pick(state, 'shot', E.shot), { T: T(e.team), O: O(e.team) }), 'play'); break;
    case 'SAVE': { const gk = e.by[0]; st.onTarget[gk === 'A' ? 'B' : 'A']++; push(state, fill(pick(state, 'save', E.save), { T: T(gk) }), 'save'); break; }
    case 'GOAL': st.onTarget[e.team]++; push(state, fill(pick(state, 'goal', E.goal), { T: T(e.team), SA: e.score.A, SB: e.score.B }), 'goal'); break;
    case 'TACKLE': push(state, fill(pick(state, 'tackle', E.tackle), { T: T(e.team) }), 'play'); break;
    case 'INTERCEPT': push(state, fill(pick(state, 'intercept', E.intercept), { T: T(e.team) }), 'play'); break;
    case 'BLOCK': push(state, fill(pick(state, 'block', E.block), { T: T(e.team) }), 'play'); break;
    case 'HALFTIME': push(state, `— 전반 종료. ${T('A')} ${e.score.A} : ${e.score.B} ${T('B')} —`, 'sys'); break;
    case 'SECOND_HALF': push(state, `— 후반 시작 —`, 'sys'); break;
    case 'FULLTIME': push(state, `— 경기 종료! 최종 ${T('A')} ${e.score.A} : ${e.score.B} ${T('B')} —`, 'sys'); break;
    case 'DIRECTIVE_PENDING': push(state, fill(C.directive.pending, { NAME: e.name, SEC: e.sec }), 'directive'); break;
    case 'DIRECTIVE_AUDIBLE': push(state, fill(C.directive.audible, { NAME: e.name, FROM: e.from }), 'directive'); break;
    case 'DIRECTIVE_ARRIVED': push(state, fill(C.directive.arrived, { NAME: e.name }), 'directive'); break;
    case 'SUB': push(state, fill(C.sub || '🔁 교체 — {NAME}.', { NAME: e.name }), 'directive'); break;
    case 'SIGNAL': { const sig = C.signal[e.key]; if (sig) push(state, fill(e.telegraph ? sig.tele : sig.done, { O: nm.B }), 'signal'); break; }
    case 'OFFSIDE': push(state, fill(pick(state, 'offside', C.offside), { T: T(e.team) }), 'play'); break;
    case 'RESTART': { const r = C.restart && C.restart[e.kind]; if (r) push(state, fill(r, { T: T(e.team) }), e.kind === 'corner' ? 'save' : 'play'); break; }
    default: break;
  }
}

function emitFlow(state, C) {
  const nm = C.teams, poss = state.possessionTeamId;
  const T = nm[poss], O = nm[poss === 'A' ? 'B' : 'A'];
  const dir = state.attackDirection[poss];
  const d = dBallOwn(dir, state.ball.position.x);                  // 0..105
  const carrier = state.ball.carrierId ? state.players[state.ball.carrierId] : null;
  const pressed = carrier && nearestOppDist(state, poss, carrier.position) < 2.4;
  const spell = state.clockSeconds - state._comm.spellStart;
  const z = state.ball.position.z;

  let key;
  if (spell < 2.5 && state._comm.prevPoss && state._comm.prevPoss !== poss && d > 45) key = 'counter';  // 막 뺏어 전진
  else if (d < 35) key = pressed ? 'buildup_pressed' : 'buildup_deep';
  else if (d < 68) key = 'midfield';
  else key = spell > 8 ? 'sustained' : 'attack_third';
  if (key === 'attack_third' && Math.abs(z) > 20) key = z < 0 ? 'wing_left' : 'wing_right';

  // 드론 방지: 상황이 바뀌면 즉시 중계, 같은 상황이 이어지면 3비트에 1번만(≈7.5s)
  const cm = state._comm;
  if (key === cm.lastFlow) { cm.flowRepeat = (cm.flowRepeat || 0) + 1; if (cm.flowRepeat % 3 !== 0) return; }
  else cm.flowRepeat = 0;
  cm.lastFlow = key;
  push(state, fill(pick(state, 'flow_' + key, C.flow[key] || C.flow.midfield), { T, O }), 'flow');
}

function emitStat(state, C) {
  const nm = C.teams, st = state.stats;
  const tot = st.possTicks.A + st.possTicks.B || 1;
  const pa = Math.round(100 * st.possTicks.A / tot);
  const lead = st.momentum > 8 ? nm.A : st.momentum < -8 ? nm.B : '균형';
  push(state, fill(pick(state, 'stat', C.stat), {
    NA: nm.A, NB: nm.B, PA: pa, PB: 100 - pa, STA: st.onTarget.A, STB: st.onTarget.B, LEAD: lead,
  }), 'stat');
}
