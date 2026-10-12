import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DirectorMatch, presentationCuts } from '../js/director/match.js';
import { command,legal,applyCommand,cardButtonReason } from '../js/director/cards.js';
import { copy,hash,isOffside,player,control,createState,distance } from '../js/director/state.js';
import { prepareEncounter } from '../js/director/scenario.js';
import { resolveEncounter,passingOptions,chooseAction,stats } from '../js/director/resolve.js';
import { interpolate } from '../js/ui/scene-player.js';
const rules=JSON.parse(await readFile(new URL('../data/director/rules.json',import.meta.url)));
const mainSource=await readFile(new URL('../js/director/main.js',import.meta.url),'utf8');
let checks=0;
function check(name,fn){fn();checks++;console.log('PASS',name);}
function ready(seed=42){const g=new DirectorMatch(rules,seed);g.advancePhase();g.advancePhase();return g;}
function dropSupportDecision(){
 const g=new DirectorMatch(rules,32,'patient');
 while(!(g.phase==='FLOW'&&g.flow.id===21))g.advancePhase();
 g.advancePhase();
 const cmd=command('support_flank','left'),s=g.commandSnapshot();
 assert.equal(g.flow.opponentIntent.id,'delay_drop');
 assert.ok(legal(s,'A',cmd,rules),'fixture must reject without opponent intent');
 assert.equal(legal(s,'A',cmd,rules,g.flow.opponentIntent),null,'fixture must allow with defensive drop');
 return {g,cmd,s};
}
check('card button uses opponent intent to allow the newly onside support',()=>{
 const {g,cmd,s}=dropSupportDecision(),before=hash(g);
 assert.equal(cardButtonReason(s,cmd,g),null,'button must include opponentIntent');
 assert.equal(hash(g),before,'button argument assembly must be pure');
});
check('reservation uses opponent intent to accept the newly onside support',()=>{
 const {g,cmd}=dropSupportDecision();
 assert.equal(g.queue(cmd),null,'reservation must include opponentIntent');
 assert.deepEqual(g.pending,cmd);
});
check('commit uses opponent intent to retain the newly onside support',()=>{
 const {g,cmd}=dropSupportDecision();
 g.pending=copy(cmd);assert(g.commit());
 assert.deepEqual(g.inputLog.at(-1).command,cmd,'commit must include opponentIntent before recording input');
 assert.equal(g.resolution.committedCommand.id,cmd.id);
});
check('a rejected side change keeps the selection on the reserved side',()=>{
 assert.match(mainSource,/function queue\(id,selectedSide=side\).*return error;/);
 assert.match(mainSource,/function setSide\(value\).*const error=queue\(game\.pending\.id,value\);side=error\?game\.pending\.side:value;/);
});
check('replay keeps side selection aligned with its reservation and locks both controls',()=>{
 assert.ok(mainSource.includes("function setSide(value){if(game.replayInputs)return;"));
 assert.ok(mainSource.includes("game.queue(entry?.command??command());side=game.pending.side;game.commit();"));
 assert.ok(mainSource.includes("$('left').disabled=!!game.replayInputs;$('right').disabled=!!game.replayInputs;"));
});
check('one reservation replaces/cancels and duplicate commit does not score twice',()=>{
 const g=ready();assert.equal(g.queue(command('support_flank'),'first'),null);assert.ok(g.queue(command('support_flank'),'first'));g.queue(command());assert.equal(g.pending.id,'hold');g.queue(command('support_flank'));assert(g.commit());const h=g.resultHash();assert(!g.commit());assert.equal(g.resultHash(),h);assert.equal(g.inputLog.length,1);
});
check('support actually moves a fullback and leaves exposure in the next state',()=>{
 const g=ready();const s=g.state,before=hash(s),base=resolveEncounter(s,command(),command(),rules),support=resolveEncounter(s,command('support_flank'),command(),rules);
 assert.notEqual(base.afterHash,support.afterHash);const c=support.appliedChanges.find(c=>c.team==='A');assert(c);assert.notDeepEqual(c.from,c.to);assert(support.nextState.tacticalExposure.some(e=>e.kind==='flank'&&e.actorIds.includes(c.playerId)));assert.equal(hash(s),before);
});
check('flank support rejects an unreachable opposite fullback and commits only a reachable receiver',()=>{
 const s=ready().state,p=player(s,'A9'),q=player(s,'A5');s.restart=null;p.position={x:20,z:-28};control(s,p);
 player(s,'A2').active=false;q.position={x:-28,z:25};const cmd=command('support_flank','left'),before=hash(s);
 assert.ok(legal(s,'A',cmd,rules),'unreachable opposite fullback must reject');assert.equal(hash(s),before);
 assert.equal(resolveEncounter(s,cmd,command(),rules).committedCommand.id,'hold');
 q.position={x:10,z:-25};assert.equal(legal(s,'A',cmd,rules),null);
 const preview=copy(s),changes=applyCommand(preview,'A',cmd);
 assert(passingOptions(preview,rules).some(q=>q.id===changes[0].playerId));
 const committed=resolveEncounter(s,cmd,command(),rules);assert.equal(committed.committedCommand.id,cmd.id);
 assert.equal(committed.events.find(e=>e.type==='PASS').receiverId,changes[0].playerId);
});
check('defensive drop allows seed 32 encounter 21 support through reservation and commit',()=>{
 const g=new DirectorMatch(rules,32,'patient');
 while(!(g.phase==='FLOW'&&g.flow.id===21))g.advancePhase();
 assert.equal(g.flow.snapshot.half,2);assert.equal(g.flow.opponentIntent.id,'delay_drop');
 assert(g.flow.events.some(e=>e.type==='PREPARE_MOVE'));assert(g.projection().text.includes('골 방향 복귀'));
 const s=g.commandSnapshot(),cmd=command('support_flank','left'),before=hash(s),preview=copy(s);
 const early=applyCommand(preview,'A',cmd),q=player(preview,early[0].playerId);assert(isOffside(preview,player(preview,s.ball.ownerId),q));
 const actual=copy(s);applyCommand(actual,'B',g.flow.opponentIntent);const changes=applyCommand(actual,'A',cmd);
 assert(passingOptions(actual,rules).some(q=>q.id===changes[0].playerId));
 assert.equal(legal(s,'A',cmd,rules,g.flow.opponentIntent),null,'defensive drop must allow newly onside fullback');assert.equal(hash(s),before);
 assert.equal(resolveEncounter(s,cmd,g.flow.opponentIntent,rules).committedCommand.id,cmd.id);
 assert.equal(g.queue(cmd),null);g.advancePhase();assert.equal(g.pending.id,cmd.id);assert(g.commit());
 assert.equal(g.resolution.committedCommand.id,cmd.id);assert.equal(g.inputLog.at(-1).command.id,cmd.id);
 assert.equal(g.resolution.events.find(e=>e.type==='PASS').receiverId,changes[0].playerId);
});
check('defensive screen rejects newly offside support before charging its exposure',()=>{
 const g=ready(),s=g.state,p=player(s,'A9'),cmd=command('support_flank','left'),defence=command('screen_middle');
 s.restart=null;p.position={x:20,z:-10};control(s,p);player(s,'A2').active=false;player(s,'A5').position={x:49,z:28};
 for(const q of s.players.filter(q=>q.team==='B'))q.position={x:10,z:30};
 player(s,'B1').position={x:49,z:0};player(s,'B6').position={x:40,z:0};player(s,'B7').position={x:40,z:0};
 const before=hash(s),early=copy(s),changes=applyCommand(early,'A',cmd);assert(passingOptions(early,rules).some(q=>q.id===changes[0].playerId));
 const actual=copy(s);applyCommand(actual,'B',defence);applyCommand(actual,'A',cmd);assert(!passingOptions(actual,rules).some(q=>q.id===changes[0].playerId));
 assert.ok(legal(s,'A',cmd,rules,defence),'defensive screen must reject newly offside fullback');assert.equal(hash(s),before);
 const r=resolveEncounter(s,cmd,defence,rules);assert.equal(r.committedCommand.id,'hold');assert(!r.appliedChanges.some(c=>c.team==='A'));assert(!r.nextState.tacticalExposure.some(e=>e.team==='A'&&e.kind==='flank'));
 assert.equal(r.afterHash,resolveEncounter(s,command('hold','left'),defence,rules).afterHash);
 g.flow.snapshot=copy(s);g.flow.opponentIntent=defence;assert.ok(g.queue(cmd));
 g.pending=cmd;g.commit();assert.equal(g.resolution.committedCommand.id,'hold');
});
check('inside run prioritizes its moved receiver over an idle central midfielder',()=>{
 const s=ready().state,p=player(s,'A9'),runner=player(s,'A10'),idle=player(s,'A6');s.restart=null;
 p.position={x:0,z:0};runner.position={x:-10,z:0};idle.position={x:10,z:0};control(s,p);
 for(const q of s.players.filter(q=>q.team==='A'&&![p.id,runner.id,idle.id].includes(q.id)))q.position={x:-45,z:30};
 for(const q of s.players.filter(q=>q.team==='B'))q.position={x:40,z:30};
 const cmd=command('run_inside');assert.equal(legal(s,'A',cmd,rules),null);
 const preview=copy(s),changes=applyCommand(preview,'A',cmd),candidates=passingOptions(preview,rules);
 assert.equal(changes[0].playerId,runner.id);assert(candidates.some(q=>q.id===runner.id));assert(candidates.some(q=>q.id===idle.id));
 assert.equal(chooseAction(preview,cmd,rules,changes).receiverId,runner.id);
 const committed=resolveEncounter(s,cmd,command(),rules);assert.equal(committed.committedCommand.id,cmd.id);
 assert.equal(committed.events.find(e=>e.type==='PASS').receiverId,runner.id);
});
check('flank support targets its fullback even when a covered lane loses the score contest',()=>{
 const s=ready().state,p=player(s,'A9');s.restart=null;
 for(const q of s.players)q.position=q.team==='A'?{x:-45,z:30}:{x:40,z:30};
 p.position={x:0,z:-10};player(s,'A2').position={x:5,z:-28};player(s,'A10').position={x:27,z:-10};player(s,'B2').position={x:2.5,z:-19};control(s,p);
 const cmd=command('support_flank'),preview=copy(s);assert.equal(legal(s,'A',cmd,rules),null);
 const changes=applyCommand(preview,'A',cmd);assert.equal(changes[0].playerId,'A2');
 const action=chooseAction(preview,cmd,rules,changes);assert.equal(action.type,'PASS');assert.equal(action.receiverId,'A2','covered support fullback must win receiver ranking');
 assert.equal(resolveEncounter(s,cmd,command(),rules).events.find(e=>e.type==='PASS').receiverId,'A2');
});
check('inside run targets its reachable runner even before it reaches the central lane',()=>{
 const s=ready().state,p=player(s,'A9');s.restart=null;
 for(const q of s.players)q.position=q.team==='A'?{x:-45,z:30}:{x:40,z:30};
 p.position={x:0,z:20};player(s,'A10').position={x:-45,z:32};player(s,'A6').position={x:20,z:20};control(s,p);
 const cmd=command('run_inside'),preview=copy(s);assert.equal(legal(s,'A',cmd,rules),null);
 const changes=applyCommand(preview,'A',cmd);assert.equal(changes[0].playerId,'A10');
 assert(passingOptions(preview,rules).some(q=>q.id==='A10'));
 const action=chooseAction(preview,cmd,rules,changes);assert.equal(action.type,'PASS');assert.equal(action.receiverId,'A10','wide inside runner must win receiver ranking');
 assert.equal(resolveEncounter(s,cmd,command(),rules).events.find(e=>e.type==='PASS').receiverId,'A10');
});
check('pass mode follows the actual inside runner instead of the highest scoring idle receiver',()=>{
 const s=ready().state,p=player(s,'A9');s.restart=null;
 for(const q of s.players)q.position=q.team==='A'?{x:-45,z:30}:{x:45,z:30};
 p.position={x:25,z:25};player(s,'A10').position={x:15,z:0};player(s,'A6').position={x:35,z:25};control(s,p);
 const cmd=command('run_inside'),preview=copy(s);assert.equal(legal(s,'A',cmd,rules),null);
 const changes=applyCommand(preview,'A',cmd);assert.equal(changes[0].playerId,'A10');
 const action=chooseAction(preview,cmd,rules,changes);assert.equal(action.receiverId,'A10');
 assert.equal(action.type,'CROSS','central receiver must determine the pass mode');
 const pass=resolveEncounter(s,cmd,command(),rules).events.find(e=>e.type==='PASS');
 assert.equal(pass.receiverId,'A10');assert.equal(pass.mode,'CROSS');
});
check('inside run rejects an unreachable runner instead of charging for an idle receiver',()=>{
 const g=ready(),s=g.state,p=player(s,'A9');s.restart=null;
 for(const q of s.players)q.position=q.team==='A'?{x:-45,z:30}:{x:45,z:30};
 p.position={x:25,z:25};player(s,'A10').position={x:-45,z:-32};player(s,'A6').position={x:35,z:25};control(s,p);
 const cmd=command('run_inside'),before=hash(s),preview=copy(s),changes=applyCommand(preview,'A',cmd);
 assert.equal(changes[0].playerId,'A10');assert(!passingOptions(preview,rules).some(q=>q.id==='A10'));
 assert(Math.abs(distance(changes[0].from,changes[0].to)-22)<1e-9);
 assert.ok(legal(s,'A',cmd,rules),'unreachable inside runner must reject');assert.equal(hash(s),before);
 const r=resolveEncounter(s,cmd,command(),rules);assert.equal(r.committedCommand.id,'hold');
 assert(!r.appliedChanges.some(c=>c.team==='A'));assert(!r.nextState.tacticalExposure.some(e=>e.team==='A'&&e.kind==='middle'));
 assert.equal(r.afterHash,resolveEncounter(s,command(),command(),rules).afterHash);
 g.flow.snapshot=copy(s);g.flow.opponentIntent=command();assert.ok(g.queue(cmd));
 g.pending=cmd;g.commit();assert.equal(g.resolution.committedCommand.id,'hold');
});
check('inside run rejects when defensive movement removes every pass candidate',()=>{
 const g=ready(),s=g.state,p=player(s,'A9');s.restart=null;
 for(const q of s.players)q.position={x:-45,z:30};
 p.position={x:0,z:20};player(s,'A10').position={x:-51,z:-32};player(s,'A6').position={x:20,z:20};
 player(s,'B1').position={x:49,z:0};player(s,'B6').position={x:20,z:20};control(s,p);
 const cmd=command('run_inside'),defence=command('press_flank','left'),preview=copy(s);
 assert(passingOptions(s,rules).some(q=>q.id==='A6'));
 assert.equal(legal(s,'B',defence,rules),null);applyCommand(preview,'B',defence);
 const changes=applyCommand(preview,'A',cmd);assert.equal(changes[0].playerId,'A10');
 assert.equal(passingOptions(preview,rules).length,0);
 assert.ok(legal(s,'A',cmd,rules,defence),'empty pass candidates must reject inside run');
 const r=resolveEncounter(s,cmd,defence,rules);assert.equal(r.committedCommand.id,'hold');
 assert(!r.appliedChanges.some(c=>c.team==='A'));assert(!r.nextState.tacticalExposure.some(e=>e.team==='A'&&e.kind==='middle'));
 assert.equal(r.afterHash,resolveEncounter(s,command(),defence,rules).afterHash);
 g.flow.snapshot=copy(s);g.flow.opponentIntent=defence;assert.ok(g.queue(cmd));
 g.pending=cmd;g.commit();assert.equal(g.resolution.committedCommand.id,'hold');
});
check('scenario never recommends support closed by the pending defensive screen',()=>{
 const s=createState(2,rules);
 for(const q of s.players)q.position=q.team==='A'?{x:-45,z:30}:{x:10,z:30};
 player(s,'A9').position={x:0,z:-20};player(s,'A2').position={x:40,z:32};player(s,'A5').active=false;
 for(const id of ['B1','B6','B7'])player(s,id).position={x:49,z:0};control(s,player(s,'A9'));
 const flow=prepareEncounter(s,rules),cmd=command('support_flank');assert.equal(flow.opponentIntent.id,'screen_middle');
 assert.equal(legal(flow.snapshot,'A',cmd,rules),null);assert.ok(legal(flow.snapshot,'A',cmd,rules,flow.opponentIntent));
 assert.equal(flow.advice.id,'hold','scenario must not recommend closed support');
 assert.equal(legal(flow.snapshot,'A',flow.advice,rules,flow.opponentIntent),null);
});
check('central screen and dropping create different real defensive positions',()=>{
 const g=ready();control(g.state,player(g.state,'B9'));const a=resolveEncounter(g.state,command('screen_middle'),command(),rules),b=resolveEncounter(g.state,command('delay_drop'),command(),rules);
 assert(a.appliedChanges.some(c=>c.reason==='중앙 길목 커버'));assert(b.appliedChanges.some(c=>c.reason==='골 방향 복귀'));assert.notDeepEqual(a.nextState.players,b.nextState.players);
});
check('opponent intent cannot read a private reservation',()=>{const a=new DirectorMatch(rules,9),b=new DirectorMatch(rules,9);a.advancePhase();b.advancePhase();a.queue(command('support_flank'));assert.deepEqual(a.flow.opponentIntent,b.flow.opponentIntent);});
check('FLOW preserves possession and core is independent of frame step',()=>{
 const a=new DirectorMatch(rules,7),b=new DirectorMatch(rules,7),owner=a.state.ball.ownerId,time=rules.durations.READY+rules.durations.FLOW;a.tick(time);for(let elapsed=0;elapsed<time;elapsed+=.05)b.tick(Math.min(.05,time-elapsed));assert.equal(a.state.ball.ownerId,owner);assert.equal(a.phase,'COMMAND');assert.equal(b.phase,'COMMAND');assert.equal(hash(a.state),hash(b.state));
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
check('restore rejects director-1.0.1 saves after the adjudication version changes',()=>{
 const previous=copy(rules);previous.version='director-1.0.1';
 const g=new DirectorMatch(previous,72);g.advancePhase();g.advancePhase();g.commit();
 assert.throws(()=>DirectorMatch.restore(g.snapshot(),rules),/경기 규칙이 바뀌었습니다/);
 assert.equal(DirectorMatch.restore(g.snapshot(),previous).resultHash(),g.resultHash());
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
check('presentation names only recorded movers and reveals scores on the result cut',()=>{
 const g=ready();g.queue(command('support_flank'));g.commit();const before=hash(g),cuts=presentationCuts(g.resolution),movers=g.resolution.appliedChanges.filter(c=>c.team==='A'&&Math.hypot(c.to.x-c.from.x,c.to.z-c.from.z)>.01).map(c=>c.playerId);
 assert.deepEqual(cuts.find(c=>c.cut==='movement').actorIds,movers);assert.match(cuts[0].text,/측면 지원!/);assert.deepEqual(cuts.map(c=>c.cut),['directive','movement','opponent','ours',cuts[4].cut,'result']);assert(Math.abs(cuts.reduce((n,c)=>n+c.duration,0)-rules.durations.PRESENT)<1e-8);assert(cuts.every(c=>c.duration<=2));assert.equal(hash(g),before);
 for(const cut of cuts.slice(0,-1)){assert.deepEqual(cut.from.score,g.flow.snapshot.score);assert.deepEqual(cut.to.score,g.flow.snapshot.score);}
 const hold=ready();hold.commit();assert.match(presentationCuts(hold.resolution)[0].text,/지시 없음/);assert.equal(presentationCuts(hold.resolution)[1].actorIds.length,0);
 assert.equal(interpolate(cuts.at(-1),false).ball.ownerId,cuts.at(-1).to.ball.ownerId);
 const defence=ready();control(defence.state,player(defence.state,'B9'));const defendingCuts=presentationCuts(resolveEncounter(defence.state,command('screen_middle'),command(),rules));
 assert(defendingCuts.find(c=>c.cut==='opponent').actorIds.every(id=>id.startsWith('B')));assert(defendingCuts.find(c=>c.cut==='ours').actorIds.every(id=>id.startsWith('A')));
});
console.log(`${checks} contract groups passed.`);
await import('./director-ui.mjs');
