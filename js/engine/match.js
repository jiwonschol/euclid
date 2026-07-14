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
      flags: { oppReactedToRed: false },
      finished: false,
    };
    this.fatigue = {};
    for (const id of Object.keys(data.formations.home)) this.fatigue[id] = 0;

    this.log = [];
    this.usedCutins = new Set();
    this.current = null; // 진행 중인 장면 컨텍스트
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
    const scene = selectScene(this.data.scenes.scenes, s, this.cfg, this.rng);
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
    return { scene, narration, signal, minuteStart: s.minute, minuteEnd: this.current.minuteEnd, duration: scene.duration };
  }

  // ── 카드 발동 (장면 재생 중 아무 때나) ─────────────────────
  playCard(cardId, choice = null) {
    const s = this.state;
    if (s.finished) return { ok: false, reason: "경기가 끝났습니다" };
    const card = this.data.cards.cards.find((c) => c.id === cardId);
    if (!card) return { ok: false, reason: "없는 카드" };

    if (card.costsToken && s.tokens <= 0) return { ok: false, reason: "개입권이 없습니다" };

    let benchChanges = [];
    switch (cardId) {
      case "line_adjust": {
        const idx = LINE_STEPS.indexOf(s.lineHeight);
        const next = choice === "up" ? idx + 1 : idx - 1;
        if (next < 0 || next >= LINE_STEPS.length) return { ok: false, reason: "라인이 이미 끝입니다" };
        s.lineHeight = LINE_STEPS[next];
        if (choice === "up") benchChanges = onUserLineUp(s, this.cfg, this.rng);
        break;
      }
      case "tactic": {
        if (choice === s.tactic) return { ok: false, reason: "이미 그 전술입니다" };
        s.tactic = choice;
        s.adaptationLeft = this.cfg.adaptationPenalty.scenes;
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
    return { ok: true, cutin, benchChanges: this._decorateBench(benchChanges), counterArmed };
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
        return {
          phase: "halftime",
          line: pickConditional(this.data.caster.halftime, view, this.rng)?.text ?? "",
          fullCutin: this._pickFullCutin("halftime"),
          benchChanges: [],
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
    return { phase: "scene", benchChanges: this._decorateBench(changes) };
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
