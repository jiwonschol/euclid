import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createState,copy,player,control,distance,segmentDistance,startRestart,hash} from '../js/director/state.js';
import {applyCommand,command,legal} from '../js/director/cards.js';
import {passingOptions,chooseAction,resolveEncounter} from '../js/director/resolve.js';
import {prepareEncounter} from '../js/director/scenario.js';
import {DirectorMatch} from '../js/director/match.js';
import {interpolate} from '../js/ui/scene-player.js';
const rules=JSON.parse(await readFile(new URL('../data/director/rules.json',import.meta.url)));
const reports=[];
function fixture(id){const s=createState(42,rules),defence=['press_flank','screen_middle','delay_drop'].includes(id),p=player(s,defence?'B9':'A9');p.position={x:defence?-8:8,z:-22};control(s,p);if(id==='run_inside')player(s,'A10').position={x:4,z:14};return s;}
function test(name,fn){fn();reports.push(name);console.log('PASS',name);}
for(const id of rules.enabledCards){
 const before=fixture(id),after=copy(before),changes=applyCommand(after,'A',command(id));
 const moved=changes.map(c=>({before:player(before,c.playerId),after:player(after,c.playerId)}));
 if(id==='support_flank'){
  test('support benefit: adds an available fullback receiver',()=>{const b=passingOptions(before,rules).map(p=>p.id),a=passingOptions(after,rules).map(p=>p.id);assert(moved.some(p=>!b.includes(p.before.id)&&a.includes(p.after.id)));assert.equal(chooseAction(after,command(id),rules,changes).receiverId,changes[0].playerId);});
  test('support cost: the same fullback can no longer cover the space behind',()=>{const spot={x:-26,z:-26};assert(distance(moved[0].after.position,spot)>distance(moved[0].before.position,spot)+20);});
 }
 if(id==='switch_play'){
  test('switch benefit: reaches opposite wing beyond short-pass range',()=>{const a=chooseAction(after,command(id),rules,changes),q=player(after,a.receiverId);assert.equal(a.type,'AERIAL_PASS');assert(q.position.z*after.ball.z<0);assert(distance(q.position,after.ball)>rules.passReach);});
  test('switch cost: spends 30 extra match seconds with a longer contested pass',()=>{const base=resolveEncounter(before,command(),command(),rules),r=resolveEncounter(before,command(id),command(),rules);assert.equal(r.deltaMatchSeconds-base.deltaMatchSeconds,30);const pass=r.events.find(e=>e.type==='PASS');assert(distance(pass.position,pass.target)>44);});
 }
 if(id==='run_inside'){
  test('inside benefit: moves a striker forward into the central lane',()=>{assert(moved[0].after.position.x>moved[0].before.position.x+8);assert(Math.abs(moved[0].after.position.z)<2);assert.equal(chooseAction(after,command(id),rules,changes).receiverId,moved[0].after.id);});
  test('inside cost: vacates the former support position and retains that gap on turnover',()=>{const r=copy(after),p=moved[0];assert(distance(p.before.position,p.after.position)>15);control(r,player(r,'B7'));const next=prepareEncounter(r,rules).snapshot;assert(distance(player(next,p.after.id).position,p.before.position)>10);});
 }
 if(id==='press_flank'){
  test('press benefit: two defenders arrive in the ball-side duel',()=>{assert(moved.every(p=>distance(p.after.position,after.ball)<7));assert(moved.every(p=>distance(p.after.position,after.ball)<distance(p.before.position,before.ball)));});
  test('press cost: nearest central cover is drawn away from the middle',()=>{const q=moved.find(p=>p.before.role==='CM');assert(q);assert(Math.abs(q.after.position.z)>Math.abs(q.before.position.z)+8);});
 }
 if(id==='screen_middle'){
  test('screen benefit: central receiving lane gains coverage',()=>{const target={x:-24,z:0},coverage=s=>Math.min(...s.players.filter(p=>p.team==='A'&&['DM','CM'].includes(p.role)).map(p=>distance(p.position,target)));assert(coverage(after)<coverage(before)-2);});
  test('screen cost: ball-side midfielder abandons the wing',()=>{const q=moved.find(p=>p.before.id==='A7'),wing={x:-16,z:-24};assert(distance(q.after.position,wing)>distance(q.before.position,wing)+5);});
 }
 if(id==='delay_drop'){
  test('drop benefit: covering midfielders get closer to their own goal',()=>{const goal={x:-52.5,z:0};assert(moved.filter(p=>['DM','CM'].includes(p.before.role)).every(p=>distance(p.after.position,goal)<distance(p.before.position,goal)));});
  test('drop cost: closest midfielder gives the carrier extra room',()=>{const q=moved.find(p=>p.before.id==='A7');assert(distance(q.after.position,after.ball)>distance(q.before.position,before.ball)+2);});
 }
}
test('restart side and taker remain valid for kickoff, throw, goal kick, corner and free kick',()=>{
 for(const type of ['KICKOFF','THROW','GOALKICK','CORNER','FREEKICK'])for(const team of ['A','B']){const s=createState(7,rules);startRestart(s,type,team,{x:type==='KICKOFF'?0:30,z:type==='THROW'?34:0});const f=prepareEncounter(s,rules);assert.equal(f.snapshot.possessionTeam,team);assert.equal(f.events.find(e=>e.type==='RESTART_TAKEN').restartType,type);assert(f.snapshot.ball.ownerId.startsWith(team));}
});
test('penalty only allows hold and records one shot with exactly one outcome',()=>{const s=createState(21,rules);startRestart(s,'PK','A',{x:41.5,z:0});const f=prepareEncounter(s,rules);assert(legal(f.snapshot,'A',command('support_flank'),rules));const r=resolveEncounter(f.snapshot,command(),command(),rules);assert.equal(r.events.filter(e=>e.type==='SHOT'&&e.penalty).length,1);assert.equal(r.events.filter(e=>['GOAL','SAVE','MISS'].includes(e.type)).length,1);});
test('presentation and reduced motion never mutate resolution, RNG, or future state',()=>{const g=new DirectorMatch(rules,42);g.advancePhase();g.advancePhase();g.commit();const before=hash(g);for(const t of [0,.2,.6,1])for(const b of g.resolution.beats)for(const reduced of [false,true]){const frame=interpolate({...b,t},reduced);assert.equal(frame.players.length,22);if(t===0)assert.deepEqual(frame.score,b.from.score);if(t===1)assert.deepEqual(frame.score,b.to.score);}assert.equal(hash(g),before);});
test('three-encounter sample ends on third ADVANCE boundary at default speed',()=>{const g=new DirectorMatch(rules,42),d=rules.durations;g.tick(d.READY+3*(d.FLOW+d.COMMAND+d.PRESENT+d.ADVANCE));assert.equal(g.phase,'FLOW');assert.equal(g.state.encounterIndex,3);});
test('changed rules cannot silently reinterpret a saved match',()=>{const g=new DirectorMatch(rules,42);assert.throws(()=>DirectorMatch.restore(g.snapshot(),{...rules,passReach:99}));});
test('wing carrier cuts inward at the end line instead of running in place',()=>{const s=createState(3,rules);const p=player(s,'A9');p.position={x:47,z:-25};control(s,p);s.players.filter(q=>q.team==='A'&&q.id!==p.id).forEach(q=>q.position={x:-30,z:q.position.z});s.players.filter(q=>q.team==='B'&&q.role!=='GK').forEach(q=>q.position={x:5,z:q.position.z});const r=resolveEncounter(s,command(),command(),rules);assert(r.events.some(e=>e.type==='ADVANCE'));assert(r.events.some(e=>e.type==='SHOT'));});

console.log(`${reports.length} tactical and rule checks passed.`);
