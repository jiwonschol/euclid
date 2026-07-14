// 경기 오케스트레이터. DOM을 모른다 — 브라우저 UI와 헤드리스 시뮬이 같은 코드를 쓴다.
// 한 장면의 수명주기: beginScene() → (카드 발동 가능 구간) → resolveOutcome() → finishScene()
import { mulberry32, randInt, pickOne } from "./rng.js";
import { derivedView, pickConditional } from "./conditions.js";
import { selectScene } from "./sceneSelector.js";
import { resolveOutcome, applyEvent } from "./outcome.js";
import { checkBetweenScenes, onUserLineUp } from "./opponentAI.js";
import { buildBriefing } from "./briefing.js";

const LINE_STEPS = ["low", "mid", "high"];
const FATIGUE_PARTICIPANT = 8;
const FATIGUE_IDLE = 3;

export class Match {
  constructor(data, seed = 1) {
    this.data = data;
    this.cfg = data.config;
    this.rng = mulberry32(seed);
    this.advisor = data.advisors.advisors[0];

    this.state = {
      minute: 0,
      half: 1,
      score: [0, 0],
      momentum: 0,
      lineHeight: "mid",
      tactic: "balanced",
      morale: this.cfg.moraleStart,
      manAdvantage: 0,
      opponent: { lineHeight: "mid", tactic: "balanced" },
      tokens: this.cfg.interventionsPerHalf,
      subsLeft: this.cfg.substitutionLimit,
      encourageUses: 0,
      adaptationLeft: 0,
      prd: { home: { fails: 0 }, away: { fails: 0 } },
      sentOff: [],
      recentScenes: [],
      sceneIndexInHalf: 0,
      scenesThisHalf: 0,
      sceneCounter: 0,        // 경기 전체 장면 통산 번호 (지시 도착 스케줄 기준, §8-B)
      pendingDirectives: [],  // 전달 중인 지시: { cardId, choice, arriveAt } (§8-B)
      subBoosts: { fw: 0, mf: 0, df: 0 }, // 교체 3종 투입 수 (§8-D)
      flags: { oppReactedToRed: false },
      finished: false,
    };
    this.fatigue = {};
    for (const id of Object.keys(data.formations.home)) this.fatigue[id] = 0;

    this.log = [];
    this.usedCutins = new Set();
    this.current = null; // 진행 중인 장면 컨텍스트
    this.queuedScene = null; // 예선택된 다음 장면 (§8-C 예고 시스템)
    this._setupHalf();
  }

  setAdvisor(id) {
    const a = this.data.advisors.advisors.find((x) => x.id === id);
    if (a) this.advisor = a;
  }

  _setupHalf() {
    const { scenesPerHalf, sceneCountJitter } = this.cfg;
    const base = scenesPerHalf[this.state.half - 1];
    this.state.scenesThisHalf = base + randInt(this.rng, -sceneCountJitter, sceneCountJitter);
    this.state.sceneIndexInHalf = 0;
  }

  kickoffLine() {
    return pickConditional(this.data.caster.kickoff, derivedView(this.state), this.rng)?.text ?? "";
  }

  // ── 장면 시작 ──────────────────────────────────────────────
  beginScene() {
    const s = this.state;
    s.sceneCounter += 1;
    // 도착한 지시는 이 장면의 형상·counter 판정에 반영된다. 장면 풀에는 다음 예선택부터
    // 반영 — 예고된 퀴즈는 재추첨되지 않는다(정직한 퀴즈, §8-B·§8-C).
    const arrivals = this._applyArrivals();
    // §8-C: 직전 장면 종료 때 예선택(예고)된 장면을 쓴다. 경기 첫 장면만 여기서 뽑는다.
    const scene = this.queuedScene ?? selectScene(this.data.scenes.scenes, s, this.cfg, this.rng);
    this.queuedScene = null;
    const halfEnd = this.cfg.halfMinutes * s.half;
    const remainingScenes = s.scenesThisHalf - s.sceneIndexInHalf;
    const span = Math.max(2, Math.round((halfEnd - s.minute) / Math.max(1, remainingScenes)) + randInt(this.rng, -1, 1));

    s.recentScenes.push(scene.id);
    const view = derivedView(s);
    const narration = pickConditional(scene.narration, view, this.rng)?.text ?? "";

    let signal = null;
    if (scene.counter && scene.advisor) {
      signal = {
        level: scene.advisor.level,
        text: scene.advisor[this.advisor.hintField],
        delayBeats: this.advisor.signalDelayBeats,
      };
    }

    this.current = {
      scene,
      minuteStart: s.minute,
      minuteEnd: Math.min(halfEnd, s.minute + span),
      counterArmed: false,
      outcomeResolved: false,
      cardsPlayed: [],
      result: null,
    };
    return { scene, narration, signal, arrivals, minuteStart: s.minute, minuteEnd: this.current.minuteEnd, duration: scene.duration };
  }

  // ── 지시 전달 (§8-B): 발동=접수, 도착=상태 반영 ────────────
  // 대기 지시를 순서대로 가상 적용한 예상 팀 상태 — 발동 검증과 HUD가 이것을 본다
  projectedTeam() {
    const s = this.state;
    let lineHeight = s.lineHeight, tactic = s.tactic;
    for (const p of s.pendingDirectives) {
      if (p.cardId === "line_adjust") {
        const next = LINE_STEPS.indexOf(lineHeight) + (p.choice === "up" ? 1 : -1);
        if (next >= 0 && next < LINE_STEPS.length) lineHeight = LINE_STEPS[next];
      } else if (p.cardId === "tactic") {
        tactic = p.choice;
      }
    }
    return { lineHeight, tactic };
  }

  // 도착 시점의 실제 상태 반영. 반환: 상대 벤치 반응(benchChanges)
  _applyDirective(cardId, choice) {
    const s = this.state;
    if (cardId === "line_adjust") {
      const next = LINE_STEPS.indexOf(s.lineHeight) + (choice === "up" ? 1 : -1);
      if (next < 0 || next >= LINE_STEPS.length) return []; // 도착 시점 무효(방어) — 조용히 소멸
      s.lineHeight = LINE_STEPS[next];
      // 상대 AI 규칙 4는 도착 시점에 발화 — 상대는 라인이 실제로 움직이는 것을 보고 반응한다 (§8-B)
      return choice === "up" ? onUserLineUp(s, this.cfg, this.rng) : [];
    }
    if (cardId === "tactic" && s.tactic !== choice) {
      s.tactic = choice;
      s.adaptationLeft = this.cfg.adaptationPenalty.scenes; // 적응 페널티는 도착부터 (§8-B)
    }
    return [];
  }

  _applyArrivals() {
    const s = this.state;
    const due = s.pendingDirectives.filter((p) => p.arriveAt <= s.sceneCounter);
    if (due.length === 0) return [];
    s.pendingDirectives = s.pendingDirectives.filter((p) => p.arriveAt > s.sceneCounter);
    const texts = [];
    for (const p of due) {
      const bench = this._applyDirective(p.cardId, p.choice);
      const line = this.data.caster.directiveArrival?.[`${p.cardId}.${p.choice}`];
      if (line) texts.push(line); // 도착은 보인다 (§8-B)
      for (const b of this._decorateBench(bench)) if (b.line) texts.push(b.line);
    }
    return texts;
  }

  // ── 카드 발동 (장면 재생 중 아무 때나) ─────────────────────
  playCard(cardId, choice = null) {
    const s = this.state;
    if (s.finished) return { ok: false, reason: "경기가 끝났습니다" };
    const card = this.data.cards.cards.find((c) => c.id === cardId);
    if (!card) return { ok: false, reason: "없는 카드" };

    if (card.costsToken && s.tokens <= 0) return { ok: false, reason: "개입권이 없습니다" };

    // 라인·전술은 발동(접수)과 도착(적용)이 분리된다 (§8-B). 검증은 대기 지시 포함 예상 상태 기준.
    const delay = card.delivery?.scenes ?? 0;
    let benchChanges = [];
    switch (cardId) {
      case "line_adjust": {
        const proj = this.projectedTeam();
        const idx = LINE_STEPS.indexOf(proj.lineHeight);
        const next = choice === "up" ? idx + 1 : idx - 1;
        if (next < 0 || next >= LINE_STEPS.length) return { ok: false, reason: "라인이 이미 끝입니다" };
        if (delay > 0) s.pendingDirectives.push({ cardId, choice, arriveAt: s.sceneCounter + delay });
        else benchChanges = this._applyDirective(cardId, choice);
        break;
      }
      case "tactic": {
        if (choice === this.projectedTeam().tactic) return { ok: false, reason: "이미 그 전술입니다" };
        if (delay > 0) s.pendingDirectives.push({ cardId, choice, arriveAt: s.sceneCounter + delay });
        else benchChanges = this._applyDirective(cardId, choice);
        break;
      }
      case "encourage": {
        const gain = s.encourageUses === 0 ? this.cfg.encourageMorale.first : this.cfg.encourageMorale.later;
        s.morale = Math.min(100, s.morale + gain);
        s.encourageUses += 1;
        break;
      }
      case "substitution": {
        if (s.subsLeft <= 0) return { ok: false, reason: "교체 횟수를 다 썼습니다" };
        s.subsLeft -= 1;
        // 포지션 선택 교체 (§8-D): 즉시 반영 — 그 선수가 활약하는 건 다른 이야기
        const pos = choice === "fw" || choice === "df" ? choice : "mf";
        s.subBoosts[pos] += 1;
        const candidates = Object.keys(this.fatigue)
          .filter((id) => id !== "h1" && !s.sentOff.includes(id));
        const tired = candidates.sort((a, b) => this.fatigue[b] - this.fatigue[a])[0];
        this.fatigue[tired] = 0;
        s.morale = Math.min(100, s.morale + this.cfg.substitutionMorale);
        break;
      }
    }
    if (card.costsToken) s.tokens -= 1;

    // 카운터 창: 장면에 정의된 counter와 일치하는 카드가 판정 전에 발동되면 효과 테이블 교체
    let counterArmed = false;
    const cur = this.current;
    if (cur && !cur.outcomeResolved && cur.scene.counter) {
      const c = cur.scene.counter;
      if (c.card === cardId && (!c.choice || c.choice.includes(choice))) {
        cur.counterArmed = true;
        counterArmed = true;
      }
    }
    if (cur) cur.cardsPlayed.push({ cardId, choice });

    const key = choice ? `${cardId}.${choice}` : cardId;
    const cutin = this.data.caster.cardCutin[key] ?? { title: card.name, sub: "" };
    const deliveryScenes = (cardId === "line_adjust" || cardId === "tactic") ? delay : 0;
    return { ok: true, cutin, benchChanges: this._decorateBench(benchChanges), counterArmed, deliveryScenes };
  }

  // ── 결과 판정 (연출 큐 시점에 호출: 정보 선행 §9) ─────────
  resolveScene() {
    const cur = this.current;
    const s = this.state;
    const scene = cur.scene;
    const res = resolveOutcome(scene, s, this.cfg, this.rng, cur.counterArmed);
    cur.outcomeResolved = true;

    const applied = applyEvent(s, scene, res.event, this.cfg);
    const view = derivedView(s); // 결과 반영 후 상태로 멘트 재맥락화

    const lineKey = res.event.side === "neutral" || res.event.type.startsWith("red_") ||
      res.event.type === "foul" || res.event.type === "timewaste"
      ? res.event.type
      : `${res.event.type}.${res.event.side}`;

    const cuePool = this.data.caster.cues[lineKey];
    const cue = cuePool ? pickOne(this.rng, cuePool) : null;
    const line = pickConditional(this.data.caster.outcomeLines[lineKey], view, this.rng)?.text ?? "";

    // 판단/실행 분리 (§9): 기대 성공 60% 이상의 개입이 실패하면 한 줄
    let judgment = null;
    let goodCallFailed = false;
    if (cur.counterArmed && scene.counter && scene.outcome.focal) {
      const counterFocalP = (scene.counter.table.find(([k]) => k === scene.outcome.focal) ?? [null, 0])[1];
      const expectedGood = scene.side === "away" ? 1 - counterFocalP : counterFocalP;
      const badHappened = scene.side === "away"
        ? res.event.type === "goal"
        : res.event.type !== "goal" && res.event.type !== "turnover";
      if (expectedGood >= this.cfg.goodCallThreshold && badHappened) {
        judgment = this.data.caster.judgmentLine;
        goodCallFailed = true;
      }
    }

    const fullCutin = res.tier === 3 ? this._pickFullCutin(lineKey) : null;

    cur.result = { res, goodCallFailed };
    this.log.push({
      sceneId: scene.id,
      minute: cur.minuteStart,
      side: scene.side,
      event: res.event.type,
      classification: res.classification,
      hadCounter: !!scene.counter,
      counterUsed: cur.counterArmed,
      counterLabel: scene.counter?.label ?? null,
      counterCard: scene.counter ? { card: scene.counter.card, choice: scene.counter.choice ?? null } : null,
      signalLevel: scene.advisor?.level ?? 0,
      focalTables: scene.outcome.focal
        ? {
            focal: scene.outcome.focal,
            base: (scene.outcome.table.find(([k]) => k === scene.outcome.focal) ?? [null, 0])[1],
            counter: scene.counter ? (scene.counter.table.find(([k]) => k === scene.outcome.focal) ?? [null, 0])[1] : null,
          }
        : null,
      goodCallFailed,
      cardsPlayed: [...cur.cardsPlayed],
      debug: res.debug,
    });

    return {
      event: res.event, tier: res.tier, classification: res.classification,
      cue, line, judgment, fullCutin, debug: res.debug, sentOff: applied.sentOff ?? null,
    };
  }

  _pickFullCutin(lineKey) {
    const variants = this.data.caster.fullCutin[lineKey];
    if (!variants) return null;
    // 같은 풀 컷인 한 경기 2회 이상 금지 (§9): 미사용 변형 우선
    const unusedIdx = variants.map((_, i) => i).filter((i) => !this.usedCutins.has(`${lineKey}:${i}`));
    const idx = unusedIdx.length > 0 ? pickOne(this.rng, unusedIdx) : randInt(this.rng, 0, variants.length - 1);
    this.usedCutins.add(`${lineKey}:${idx}`);
    return variants[idx];
  }

  // ── 장면 종료 → 다음 단계 ─────────────────────────────────
  finishScene() {
    const s = this.state;
    const cur = this.current;
    s.minute = cur.minuteEnd;
    if (s.adaptationLeft > 0) s.adaptationLeft -= 1;

    const participants = Object.keys(cur.scene.waypoints).filter((k) => k !== "ball");
    for (const id of Object.keys(this.fatigue)) {
      this.fatigue[id] += participants.includes(id) ? FATIGUE_PARTICIPANT : FATIGUE_IDLE;
    }

    s.sceneIndexInHalf += 1;
    this.current = null;

    if (s.sceneIndexInHalf >= s.scenesThisHalf || s.minute >= this.cfg.halfMinutes * s.half) {
      if (s.half === 1) {
        s.half = 2;
        s.minute = this.cfg.halfMinutes;
        // 후반 지급 (+carryOverUnused면 전반 미사용분 이월)
        s.tokens = this.cfg.interventionsPerHalf + (this.cfg.carryOverUnused ? s.tokens : 0);
        this._setupHalf();
        const view = derivedView(s);
        const line = pickConditional(this.data.caster.halftime, view, this.rng)?.text ?? "";
        const fullCutin = this._pickFullCutin("halftime");
        return {
          phase: "halftime",
          line,
          fullCutin,
          benchChanges: [],
          foreshadow: this._queueNext(), // 후반 첫 장면 예고 (§8-C)
        };
      }
      s.finished = true;
      const view = derivedView(s);
      return {
        phase: "fulltime",
        line: pickConditional(this.data.caster.fulltime, view, this.rng)?.text ?? "",
        fullCutin: this._pickFullCutin("fulltime"),
        benchChanges: [],
      };
    }

    const changes = checkBetweenScenes(s, this.cfg, this.rng);
    // §8-C: 다음 장면을 지금(판정 반영된 상태로) 예선택하고 예고를 흘린다 — 컴퓨터의 퀴즈.
    // rng 소비 순서는 기존(beginScene 선택)과 동일하게 checkBetweenScenes 직후다.
    const foreshadow = this._queueNext();
    return { phase: "scene", benchChanges: this._decorateBench(changes), foreshadow };
  }

  // ── 예고 시스템 (§8-C) ─────────────────────────────────────
  _queueNext() {
    this.queuedScene = selectScene(this.data.scenes.scenes, this.state, this.cfg, this.rng);
    return this._foreshadowFor(this.queuedScene);
  }

  // 예고 멘트: 장면 명시(foreshadow 필드) > side.태그 템플릿 > side 템플릿.
  // 변형 선택은 sceneCounter 순환(결정론) — rng를 소비하면 무개입 판정 시퀀스가 바뀐다.
  _foreshadowFor(scene) {
    if (scene.foreshadow) return scene.foreshadow;
    const fs = this.data.caster.foreshadow;
    if (!fs) return null;
    const side = scene.side ?? "neutral";
    let pool = null;
    for (const t of scene.tags ?? []) {
      if (fs[`${side}.${t}`]) { pool = fs[`${side}.${t}`]; break; }
    }
    pool = pool ?? fs[side];
    if (!pool) return null;
    const arr = [].concat(pool);
    return arr.length ? arr[this.state.sceneCounter % arr.length] : null;
  }

  _decorateBench(changes) {
    return changes.map((c) => ({
      ...c,
      line: this.data.caster.bench[c.kind === "tactic" ? `tactic.${c.value}` : `line.${c.value}`] ?? "",
    }));
  }

  briefing() {
    return buildBriefing(this.log, this.state, this.advisor, this.data.caster);
  }
}
