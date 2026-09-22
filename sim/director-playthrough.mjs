import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { DirectorMatch } from '../js/director/match.js';
import { CARDS,command,legal } from '../js/director/cards.js';
import { stats } from '../js/director/resolve.js';
const rules=JSON.parse(await readFile(new URL('../data/director/rules.json',import.meta.url)));
export function run(seed,strategy,speed=1,skip=false,restore=false){
 let g=new DirectorMatch(rules,seed,['wing','central','patient'][seed%3]),duration=0;
 for(let guard=0;guard<200 && g.phase!=='REVIEW';guard++){
  if(g.phase==='FLOW'){
   assert.equal(g.flow.from.ball.ownerId,g.flow.to.ball.ownerId);
   assert.equal(g.flow.from.possessionTeam,g.flow.to.possessionTeam);
   assert(g.flow.snapshot.players.some(p=>p.id===g.flow.observation.carrierId));
   for(const e of g.flow.events.filter(e=>e.type==='PREPARE_MOVE'))assert(g.flow.observation.text.includes(e.cue));
  }
  if(g.phase==='COMMAND'){
   const ids=rules.enabledCards.filter(id=>!legal(g.state,'A',command(id),rules));
   let id='hold'; if((strategy===1&&g.state.possessionTeam==='A')||(strategy===2&&g.state.possessionTeam==='B')||strategy===3)id=ids[(g.state.encounterIndex+seed)%ids.length]??'hold';
   g.queue(command(id));
  }
  if(restore && ['COMMAND','PRESENT','ADVANCE'].includes(g.phase)){g=DirectorMatch.restore(g.snapshot(),rules);g.paused=false;}
  g.speed=speed;
  const rate=['FLOW','PRESENT','ADVANCE'].includes(g.phase)?speed:1;
  const time=g.remaining/rate;duration+=time;
  if(skip&&g.phase==='PRESENT'){g.skip();}else g.tick(time+1e-9);
  assert(g.state.ball.ownerId===null||g.state.players.some(p=>p.id===g.state.ball.ownerId));
  if(g.state.ball.mode==='CONTROLLED'){const p=g.state.players.find(p=>p.id===g.state.ball.ownerId);assert.equal(p.team,g.state.possessionTeam);assert.equal(p.position.x,g.state.ball.x);assert.equal(p.position.z,g.state.ball.z);}
  for(const p of g.state.players){assert(Number.isFinite(p.position.x)&&Math.abs(p.position.x)<=52.5);assert(Number.isFinite(p.position.z)&&Math.abs(p.position.z)<=34);}
 }
 assert.equal(g.phase,'REVIEW');assert.equal(g.state.matchSeconds,5400);assert(g.state.encounterIndex>=20&&g.state.encounterIndex<=28);
 assert.equal(g.state.eventLog.filter(e=>e.type==='HALFTIME').length,1);assert.equal(g.state.eventLog.filter(e=>e.type==='FULLTIME').length,1);
 assert.equal(new Set(g.state.eventLog.map(e=>e.id)).size,g.state.eventLog.length);
 const shots=g.state.eventLog.filter(e=>e.type==='SHOT');for(const shot of shots)assert.equal(g.state.eventLog.filter(e=>e.shotId===shot.shotId&&['GOAL','SAVE','MISS'].includes(e.type)).length,1);
 for(const t of ['A','B']){const s=stats(g.state.eventLog,t);assert(s.onTarget<=s.shots);assert.equal(s.goals,g.state.score[t]);}
 for(const r of g.records){assert(r.contests.length<=3);assert(r.beats.length<=4);for(const beat of r.beats)for(const id of beat.eventIds)assert(g.state.eventLog.some(e=>e.id===id));}
 return {game:g,duration};
}
const report={matches:0,replayed:0,durations:[],goals:{A:0,B:0},shots:{A:0,B:0},events:{}};
for(let seed=1;seed<=100;seed++)for(let strategy=0;strategy<4;strategy++){
 const {game,duration}=run(seed,strategy);assert(duration>=500-1e-6&&duration<=692+1e-6);report.matches++;report.durations.push(Math.round(duration));
 for(const t of ['A','B']){report.goals[t]+=game.state.score[t];report.shots[t]+=stats(game.state.eventLog,t).shots;}
 for(const e of game.state.eventLog)report.events[e.type]=(report.events[e.type]??0)+1;
 if(seed<=20){for(const [speed,skip,restore] of [[1,false,false],[2,false,false],[4,true,false],[4,false,true]]){const other=run(seed,strategy,speed,skip,restore).game;assert.equal(other.resultHash(),game.resultHash());report.replayed++;}}
}
report.durations={min:Math.min(...report.durations),max:Math.max(...report.durations)};
console.log(JSON.stringify(report,null,2));
if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n');
