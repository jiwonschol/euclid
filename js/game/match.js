// 연속 경기 시뮬레이션 코어 (마스터 계획서 §3·§4·§16 단계1).
//
// 고정 타임스텝(SIM_HZ)으로 도는 순수 상태 기계. UI/렌더와 완전 분리되어
// 브라우저와 헤드리스(node)가 같은 코드를 돌린다. Math.random 금지 — rng 만 소비.
//
// 이번 단계(Stage 1)는 "골격"이다: 좌표계·22명·공·시계·단계 머신·이벤트 로그·
// 시드 재현성. 실제 선수 AI·공 물리·규칙은 Stage 2~ 에서 tick() 의 IN_PLAY 안에
// 채워 넣는다(TODO 표기). 지금은 그 뼈대가 결정적으로·안전하게 도는지만 보증한다.

import { createRng } from './rng.js';
import { FIELD, FORMATION_433, anchorToWorld } from './field.js';
import { stepPositioning } from './ai.js';
import { stepPlay, placeKickoff } from './decide.js';
import { stepCommentary } from './commentary.js';
import { stepDirectives, stepOpponentAI } from './directives.js';

export const SIM_HZ = 15;               // 시뮬 주파수(계획서 §3 권장 10~20Hz)
export const SIM_DT = 1 / SIM_HZ;       // 한 틱 = 1/15 경기초
export const HALF_SECONDS = 45 * 60;    // 전·후반 각 2700 경기초

/**
 * @typedef {'PRE_KICKOFF'|'KICKOFF'|'IN_PLAY'|'HALFTIME'|'FULLTIME'} MatchPhase
 * @typedef {'CONTROLLED'|'GROUND_PASS'|'AERIAL_PASS'|'SHOT'|'LOOSE'|'OUT_OF_PLAY'|'DEAD_BALL'} BallMode
 * @typedef {'GK'|'CB'|'FB'|'DM'|'CM'|'W'|'ST'} Role
 *
 * @typedef {Object} PlayerState
 * @property {string} id            'A1'..'A11', 'B1'..'B11'
 * @property {'A'|'B'} teamId
 * @property {number} shirtNumber
 * @property {Role} role
 * @property {{x:number,z:number}} position   월드 좌표(미터)
 * @property {{x:number,z:number}} velocity   m/s
 * @property {{ax:number,az:number}} homeAnchor
 * @property {boolean} hasBall
 * @property {boolean} sentOff
 *
 * @typedef {Object} BallState
 * @property {{x:number,y:number,z:number}} position   y=높이
 * @property {{x:number,y:number,z:number}} velocity
 * @property {BallMode} mode
 * @property {string|null} ownerId
 * @property {string|null} lastTouchPlayerId
 * @property {'A'|'B'|null} lastTouchTeamId
 *
 * @typedef {Object} MatchState
 * @property {number} seed
 * @property {MatchPhase} phase
 * @property {1|2} half
 * @property {number} clockSeconds        경기 누적 초(0..5400)
 * @property {{A:number,B:number}} score
 * @property {{A:1|-1,B:1|-1}} attackDirection
 * @property {'A'|'B'} kickoffFirstHalf   전반 킥오프 팀(시드 코인토스)
 * @property {'A'|'B'|null} possessionTeamId
 * @property {Record<string,PlayerState>} players
 * @property {BallState} ball
 * @property {Array<Object>} eventLog
 * @property {import('./rng.js').Rng} rng
 * @property {number} tickCount
 */

/** @param {'A'|'B'} teamId @param {any} spec @param {number} shirt @param {1|-1} attackDir @returns {PlayerState} */
function makePlayer(teamId, spec, shirt, attackDir) {
  const p = anchorToWorld(spec, attackDir);
  return {
    id: `${teamId}${shirt}`,
    teamId, shirtNumber: shirt, role: spec.role,
    position: { x: p.x, z: p.z },
    velocity: { x: 0, z: 0 },
    homeAnchor: { ax: spec.ax, az: spec.az },
    hasBall: false,
    sentOff: false,
  };
}

/**
 * 새 경기 상태 생성. 같은 seed → 같은 초기 상태·킥오프 팀.
 * @param {number} [seed]
 * @param {any} [cfg]  data/engine.json (선수 운동학·형상·압박·GK). 없으면 시계/단계만 도는 골격 모드.
 * @param {any} [commentaryCfg]  data/commentary.json. 주면 실시간 중계(state.feed)·스탯(state.stats) 생성.
 * @param {any} [cardsCfg]  data/cards.json. 주면 지시 카드·CP·상대 AI(김성주 신호) 활성.
 * @returns {MatchState}
 */
export function createMatch(seed = 1, cfg = null, commentaryCfg = null, cardsCfg = null) {
  const rng = createRng(seed);
  const attackDir = { A: /** @type {1} */ (1), B: /** @type {-1} */ (-1) };

  /** @type {Record<string,PlayerState>} */
  const players = {};
  for (const teamId of /** @type {const} */ (['A', 'B'])) {
    FORMATION_433.forEach((spec, i) => {
      const p = makePlayer(teamId, spec, i + 1, attackDir[teamId]);
      players[p.id] = p;
    });
  }

  const kickoffFirstHalf = rng.chance(0.5) ? 'A' : 'B';   // 코인토스(시드 결정적)

  /** @type {MatchState} */
  const state = {
    seed,
    cfg,
    commentaryCfg,
    cardsCfg,
    phase: 'PRE_KICKOFF',
    half: 1,
    clockSeconds: 0,
    score: { A: 0, B: 0 },
    attackDirection: attackDir,
    kickoffFirstHalf,
    // 팀 전술 상태(카드·상대 AI가 바꾼다). tactic: balanced|attack|counter|park, lineHeight: low|mid|high, press: normal|high
    tactics: {
      A: { tactic: 'balanced', lineHeight: 'mid', press: 'normal' },
      B: { tactic: 'balanced', lineHeight: 'mid', press: 'normal' },
    },
    // 교체 누적 효과(§8-D): fw=슛 정확도, mf=볼 지키기, df=실점 감소. 유저팀(A) 위주.
    subBoost: { A: { fw: 0, mf: 0, df: 0 }, B: { fw: 0, mf: 0, df: 0 } },
    possessionTeamId: null,
    players,
    ball: {
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      mode: 'DEAD_BALL',
      ownerId: null, carrierId: null, lastTouchPlayerId: null, lastTouchTeamId: null,
    },
    depthRank: null,
    eventLog: [],
    rng,
    tickCount: 0,
  };
  logEvent(state, 'MATCH_CREATED', { seed, kickoffFirstHalf });
  return state;
}

function logEvent(state, type, data = {}) {
  state.eventLog.push({ t: Math.round(state.clockSeconds * 100) / 100, half: state.half, type, ...data });
}

// ── 단계 머신 도우미 ─────────────────────────────────────────────
function startKickoff(state, kickingTeam) {
  state.phase = 'KICKOFF';
  state.possessionTeamId = kickingTeam;
  state.ball.position = { x: 0, y: 0, z: 0 };
  state.ball.velocity = { x: 0, y: 0, z: 0 };
  state.ball.mode = 'DEAD_BALL';
  state.ball.ownerId = null;
  state.ball.carrierId = null;
  logEvent(state, 'KICKOFF', { team: kickingTeam });
}

function flipDirections(state) {
  state.attackDirection.A = /** @type {1|-1} */ (state.attackDirection.A * -1);
  state.attackDirection.B = /** @type {1|-1} */ (state.attackDirection.B * -1);
}

function resetToFormation(state) {
  for (const p of Object.values(state.players)) {
    const w = anchorToWorld(p.homeAnchor, state.attackDirection[p.teamId]);
    p.position = { x: w.x, z: w.z };
    p.velocity = { x: 0, z: 0 };
    p.hasBall = false;
    p._shape = null;                 // 형상 이징 재초기화(새 진영)
  }
  state._press = null;
  state.possessionTeamId = null;
  state.ball.carrierId = null;
}

// 선수를 피치 경계 안으로 클램프(살짝 안쪽 — 라인 밖에서 공을 차 순간 OOB 되는 것 방지)
function clampPlayers(state) {
  const mx = FIELD.halfLength - 0.5, mz = FIELD.halfWidth - 0.5;
  for (const p of Object.values(state.players)) {
    p.position.x = p.position.x < -mx ? -mx : p.position.x > mx ? mx : p.position.x;
    p.position.z = p.position.z < -mz ? -mz : p.position.z > mz ? mz : p.position.z;
  }
}

function assertFinite(state) {
  const b = state.ball.position;
  if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.z))
    throw new Error(`ball position NaN @tick ${state.tickCount}`);
  for (const p of Object.values(state.players)) {
    if (!Number.isFinite(p.position.x) || !Number.isFinite(p.position.z))
      throw new Error(`player ${p.id} position NaN @tick ${state.tickCount}`);
  }
}

/**
 * 한 고정 틱 전진. 단계별로 분기한다.
 * @param {MatchState} state
 * @returns {MatchState}
 */
export function tick(state) {
  state.tickCount++;
  switch (state.phase) {
    case 'PRE_KICKOFF':
      startKickoff(state, state.half === 1 ? state.kickoffFirstHalf
                                           : (state.kickoffFirstHalf === 'A' ? 'B' : 'A'));
      break;

    case 'KICKOFF':
      state.phase = 'IN_PLAY';
      logEvent(state, 'IN_PLAY');
      if (state.cfg) placeKickoff(state, state.possessionTeamId);   // 킥오프팀에게 공 확정 지급
      else state.ball.mode = 'CONTROLLED';                          // 골격 모드(cfg 없음)
      break;

    case 'IN_PLAY': {
      if (state.cfg) {
        stepPlay(state, SIM_DT);          // 공 물리·소유·utility 의사결정
        stepPositioning(state, SIM_DT);   // 22명 형상·압박·GK 배치
        clampPlayers(state);              // 선수는 피치를 벗어나지 않는다
        if (state.cardsCfg) {             // 지시 도착·CP 회복 + 상대 AI(김성주 신호) — 중계 전에
          stepDirectives(state, SIM_DT, state.cardsCfg);
          stepOpponentAI(state, SIM_DT, state.cardsCfg);
        }
        if (state.commentaryCfg) stepCommentary(state, SIM_DT, state.commentaryCfg);  // 실시간 중계
      }
      state.clockSeconds += SIM_DT;
      const half1End = state.half === 1 && state.clockSeconds >= HALF_SECONDS;
      const half2End = state.half === 2 && state.clockSeconds >= 2 * HALF_SECONDS;
      if (half1End) {
        state.phase = 'HALFTIME';
        logEvent(state, 'HALFTIME', { score: { ...state.score } });
      } else if (half2End) {
        state.phase = 'FULLTIME';
        logEvent(state, 'FULLTIME', { score: { ...state.score } });
      }
      break;
    }

    case 'HALFTIME':
      state.half = 2;
      flipDirections(state);          // 진영·좌우 앵커 반전 (§3/§11)
      resetToFormation(state);
      state.phase = 'PRE_KICKOFF';
      logEvent(state, 'SECOND_HALF');
      break;

    case 'FULLTIME':
      break;                          // 정지 상태 — 더 이상 전진하지 않는다
  }
  assertFinite(state);
  return state;
}

/**
 * FULLTIME 까지 반복. 헤드리스/자동 시뮬용.
 * @param {MatchState} state @param {number} [maxTicks]
 * @returns {MatchState}
 */
export function runToFulltime(state, maxTicks = 200000) {
  let n = 0;
  while (state.phase !== 'FULLTIME' && n < maxTicks) { tick(state); n++; }
  if (state.phase !== 'FULLTIME')
    throw new Error(`match did not reach FULLTIME within ${maxTicks} ticks (phase=${state.phase})`);
  return state;
}

/** 편의: 술어가 참이 될 때까지(또는 상한까지) 틱. 반환 = 도달 여부 */
export function tickUntil(state, pred, maxTicks = 200000) {
  let n = 0;
  while (!pred(state) && state.phase !== 'FULLTIME' && n < maxTicks) { tick(state); n++; }
  return pred(state);
}
