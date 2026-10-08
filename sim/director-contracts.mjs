import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DirectorMatch } from '../js/director/match.js';
import { command } from '../js/director/cards.js';
import { copy,hash,isOffside,player,control } from '../js/director/state.js';
import { resolveEncounter,passingOptions,stats } from '../js/director/resolve.js';
const rules=JSON.parse(await readFile(new URL('../data/director/rules.json',import.meta.url)));
const mainSource=await readFile(new URL('../js/director/main.js',import.meta.url),'utf8');
let checks=0;
function check(name,fn){fn();checks++;console.log('PASS',name);}
function ready(seed=42){const g=new DirectorMatch(rules,seed);g.advancePhase();g.advancePhase();return g;}
check('a rejected side change keeps the selection on the reserved side',()=>{
 assert.match(mainSource,/function queue\(id,selectedSide=side\).*return error;/);
 assert.match(mainSource,/function setSide\(value\).*const error=queue\(game\.pending\.id,value\);side=error\?game\.pending\.side:value;/);
});
check('replay keeps side selection aligned with its reservation and locks both controls',()=>{
 assert.ok(mainSource.includes("function setSide(value){if(game.replayInputs)return;"));
 assert.ok(mainSource.includes("game.queue(entry?.command??command());side=game.pending.side;"));
 assert.ok(mainSource.includes("$('left').disabled=!!game.replayInputs;$('right').disabled=!!game.replayInputs;"));
});
check('one reservation replaces/cancels and duplicate commit does not score twice',()=>{
 const g=ready();assert.equal(g.queue(command('support_flank'),'first'),null);assert.ok(g.queue(command('support_flank'),'first'));g.queue(command());assert.equal(g.pending.id,'hold');g.queue(command('support_flank'));assert(g.commit());const h=g.resultHash();assert(!g.commit());assert.equal(g.resultHash(),h);assert.equal(g.inputLog.length,1);
});
check('support actually moves a fullback and leaves exposure in the next state',()=>{
 const g=ready();const s=g.state,before=hash(s),base=resolveEncounter(s,command(),command(),rules),support=resolveEncounter(s,command('support_flank'),command(),rules);
 assert.notEqual(base.afterHash,support.afterHash);const c=support.appliedChanges.find(c=>c.team==='A');assert(c);assert.notDeepEqual(c.from,c.to);assert(support.nextState.tacticalExposure.some(e=>e.kind==='flank'&&e.actorIds.includes(c.playerId)));assert.equal(hash(s),before);
});
check('central screen and dropping create different real defensive positions',()=>{
 const g=ready();control(g.state,player(g.state,'B9'));const a=resolveEncounter(g.state,command('screen_middle'),command(),rules),b=resolveEncounter(g.state,command('delay_drop'),command(),rules);
 assert(a.appliedChanges.some(c=>c.reason==='중앙 길목 커버'));assert(b.appliedChanges.some(c=>c.reason==='골 방향 복귀'));assert.notDeepEqual(a.nextState.players,b.nextState.players);
});
check('opponent intent cannot read a private reservation',()=>{const a=new DirectorMatch(rules,9),b=new DirectorMatch(rules,9);a.advancePhase();b.advancePhase();a.queue(command('support_flank'));assert.deepEqual(a.flow.opponentIntent,b.flow.opponentIntent);});
check('FLOW preserves possession and core is independent of frame step',()=>{
 const a=new DirectorMatch(rules,7),b=new DirectorMatch(rules,7),owner=a.state.ball.ownerId;a.tick(22);for(let i=0;i<220;i++)b.tick(.1);assert.equal(a.state.ball.ownerId,owner);assert.equal(a.phase,'COMMAND');assert.equal(b.phase,'COMMAND');assert.equal(hash(a.state),hash(b.state));
});
check('offside uses ball and second-last opponent at release, with restart exemptions',()=>{
 const g=ready(),s=g.state,p=player(s,'A9'),q=player(s,'A10');p.position.x=25;q.position.x=35;control(s,p);s.players.filter(p=>p.team==='B').forEach((p,i)=>p.position.x=i===0?49:30);
 assert(isOffside(s,p,q));s.ball.x=40;assert(!isOffside(s,p,q));s.ball.x=25;for(const type of ['THROW','CORNER','GOALKICK'])assert(!isOffside(s,p,q,type));assert(isOffside(s,p,q,'FREEKICK'));assert(!passingOptions(s,rules).includes(q));
});
check('20 seeds replay identically; score and shot accounting use events',()=>{
 for(let seed=1;seed<=20;seed++){
  const a=ready(seed),b=ready(seed);a.queue(command('support_flank'));b.queue(command('support_flank'));a.commit();b.commit();assert.equal(a.resultHash(),b.resultHash());
  for(const team of ['A','B']) {const x=stats(a.state.eventLog,team);assert(x.onTarget<=x.shots);assert.equal(x.goals,a.state.score[team]);}
 }
});
check('restore before/after decision and during playback never redraws the result',()=>{
 for(const phase of ['COMMAND','PRESENT','ADVANCE']){const a=ready(72);a.queue(command('support_flank'));if(phase!=='COMMAND')a.commit();if(phase==='ADVANCE')a.skip();const b=DirectorMatch.restore(a.snapshot(),rules);b.paused=false;if(phase==='COMMAND'){a.commit();b.commit();}a.tick(6);b.tick(6);assert.equal(a.resultHash(),b.resultHash());assert.equal(a.records.length,b.records.length);}
});
check('halftime reservation uses the upcoming kickoff without mutating the current state',()=>{
 const g=new DirectorMatch(rules,42);while(g.phase!=='HALFTIME')g.advancePhase();
 const before=g.resultHash();assert.equal(g.state.ball.ownerId,null);
 assert.equal(g.queue(command('screen_middle')),null);assert.equal(g.resultHash(),before);
 const restored=DirectorMatch.restore(g.snapshot(),rules);restored.advancePhase();restored.advancePhase();assert(restored.commit());
 assert.equal(restored.records.at(-1).committedCommand.id,'screen_middle');
 const baseline=DirectorMatch.restore(g.snapshot(),rules);baseline.halftimeFlow=null;baseline.advancePhase();baseline.advancePhase();baseline.commit();assert.equal(restored.resultHash(),baseline.resultHash());
});
check('replay source survives snapshots and existing records still restore',()=>{
 const g=ready(72);g.queue(command('support_flank','right'));g.commit();
 g.replayInputs=copy(g.inputLog);const restored=DirectorMatch.restore(g.snapshot(),rules);assert.deepEqual(restored.replayInputs,g.inputLog);
 const old=JSON.parse(g.snapshot());delete old.replayInputs;delete old.halftimeFlow;
 const legacy=DirectorMatch.restore(JSON.stringify(old),rules);assert.equal(legacy.replayInputs,null);assert.equal(legacy.resultHash(),g.resultHash());assert.deepEqual(legacy.records,old.records);
});
console.log(`${checks} contract groups passed.`);
