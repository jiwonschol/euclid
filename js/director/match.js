import { copy, createState, startRestart, visual, hash, distance } from './state.js';
import { CARDS, command, legal } from './cards.js';
import { prepareEncounter } from './scenario.js';
import { resolveEncounter } from './resolve.js';
const name=p=>p?`${p.team==='A'?'청해':'홍림'} ${p.number}번`:'';
// A presentation montage reads an already committed record; it never resolves an action.
export function presentationCuts(r) {
  const first=r.beats[0],action=r.beats.filter(b=>b.kind!=='TACTIC').at(-1)??first;
  const changes=r.appliedChanges.filter(c=>c.team==='A'&&distance(c.from,c.to)>.01);
  const moving=changes.map(c=>c.playerId),players=first.from.players;
  const changed=changes.map(c=>`${name(players.find(p=>p.id===c.playerId))} ${c.reason}`).join(' · ');
  const directive=r.committedCommand.id==='hold'?'지시 없음, 그대로 간다':`${CARDS[r.committedCommand.id].name}! ${changed||'움직인 선수 없음'}`;
  const attacking=action.from.possessionTeam,attacker=action.from.ball.ownerId??action.actorIds.find(id=>players.find(p=>p.id===id)?.team===attacking);
  const defender=action.actorIds.find(id=>players.find(p=>p.id===id)?.team!==attacking);
  const attackName=name(players.find(p=>p.id===attacker)),defendName=name(players.find(p=>p.id===defender));
  const shot=['GOAL','SAVE','MISS'].includes(action.kind),pass=['PASS','CROSS','AERIAL_PASS','INTERCEPT'].includes(action.kind);
  const opposing=attacking==='A'?defender:attacker,ours=attacking==='A'?attacker:defender;
  const call=id=>id===attacker?`${attackName} ${shot?'슛!':pass?'패스!':'돌파!'}`:`${defendName||'수비'} ${shot?'골문을 지킨다':pass?'패스 길을 막는다':'태클!'}`;
  const received=r.events.find(e=>e.type==='RECEIVE'&&moving.includes(e.actorId));
  const effect=received?`이동한 ${name(players.find(p=>p.id===received.actorId))}에게 연결`:changed?`${changed}${r.nextState.possessionTeam!=='A'?' · 이동한 채 홍림 소유':''}`:'추가 지시 이동 없음';
  const resultText=r.beats.filter(b=>b.kind!=='TACTIC').map(b=>b.text).join(' ')+` · ${effect}`;
  const still=b=>({...b,to:b.from});
  return [
    {...still(first),cut:'directive',duration:.6,text:directive,actorIds:[]},
    {...(r.beats.find(b=>b.kind==='TACTIC')??still(first)),cut:'movement',duration:.8,text:changed||'움직인 선수 없음',actorIds:moving},
    {...still(action),cut:'opponent',duration:.5,text:call(opposing),actorIds:opposing?[opposing]:[],attackingActor:opposing===attacker},
    {...still(action),cut:'ours',duration:.55,text:call(ours),actorIds:ours?[ours]:[],attackingActor:ours===attacker},
    {...action,to:{...action.to,score:action.from.score},cut:pass||shot?'ball':'face',duration:.45,text:shot?'골문으로!':pass?'공을 따라간다':`${attackName}, 경합!`,actorIds:attacker?[attacker]:[]},
    {...action,from:action.to,to:action.to,cut:'result',duration:.6,text:resultText}
  ];
}
export class DirectorMatch {
  constructor(rules,seed=42,profile='wing') {
    this.rules=copy(rules); this.state=createState(seed,rules,profile);this.phase='READY';this.remaining=rules.durations.READY;
    this.pending=command();this.records=[];this.inputLog=[];this.replayInputs=null;this.commandEvents=[];this.flow=null;this.halftimeFlow=null;this.resolution=null;this.paused=false;this.speed=1;this.seenCommands=[];this.resolvedIds=[];
  }
  setPhase(phase) {this.phase=phase;this.remaining=this.rules.durations[phase]??0;}
  commandSnapshot() {
    if(this.phase==='HALFTIME') return (this.halftimeFlow??=prepareEncounter(this.state,this.rules)).snapshot;
    return this.flow?.snapshot??this.state;
  }
  queue(cmd,id) {
    if(!['FLOW','COMMAND','HALFTIME'].includes(this.phase)) return '현재 지시는 확정됐습니다.';
    if(id&&this.seenCommands.includes(id)) return '이미 접수한 입력입니다.';
    const s=this.commandSnapshot(), error=legal(s,'A',cmd,this.rules); if(error) return error;
    if(id) this.seenCommands.push(id);
    this.commandEvents.push({type:cmd.id==='hold'?'COMMAND_CANCELED':this.pending.id==='hold'?'COMMAND_QUEUED':'COMMAND_REPLACED',encounterId:s.encounterIndex+1,cardId:cmd.id});
    this.pending=copy(cmd); return null;
  }
  beginFlow() {this.flow=this.halftimeFlow??prepareEncounter(this.state,this.rules);this.halftimeFlow=null;this.state=copy(this.flow.initialState);this.resolution=null;this.setPhase('FLOW');}
  commit() {
    if(this.phase!=='COMMAND') return false;
    const id=this.state.encounterIndex+1;if(this.resolvedIds.includes(id)) return false;
    if(legal(this.state,'A',this.pending,this.rules)) this.pending=command();
    this.commandEvents.push({type:'COMMAND_COMMITTED',encounterId:id,cardId:this.pending.id});
    this.inputLog.push({encounterId:id,command:copy(this.pending)});
    this.resolution=resolveEncounter(this.state,this.pending,this.flow.opponentIntent,this.rules);
    this.records.push(this.resolution);this.state=copy(this.resolution.nextState);this.resolvedIds.push(id);this.pending=command();this.setPhase('PRESENT');return true;
  }
  advancePhase() {
    if(['READY','HALFTIME'].includes(this.phase)) this.beginFlow();
    else if(this.phase==='FLOW') {this.state=copy(this.flow.snapshot);this.state.eventLog.push(...copy(this.flow.events));if(legal(this.state,'A',this.pending,this.rules)){this.commandEvents.push({type:'COMMAND_INVALIDATED',cardId:this.pending.id,reason:legal(this.state,'A',this.pending,this.rules),encounterId:this.flow.id});this.pending=command();}this.setPhase('COMMAND');}
    else if(this.phase==='COMMAND') this.commit();
    else if(this.phase==='PRESENT') this.setPhase('ADVANCE');
    else if(this.phase==='ADVANCE') {
      if(this.state.matchSeconds>=this.rules.halfSeconds*2) {this.state.eventLog.push({id:'fulltime',type:'FULLTIME'});this.setPhase('REVIEW');}
      else if(this.state.matchSeconds>=this.rules.halfSeconds && this.state.half===1) {this.state.eventLog.push({id:'halftime',type:'HALFTIME'});this.state.half=2; startRestart(this.state,'KICKOFF','B',{x:0,z:0});this.flow=null;this.setPhase('HALFTIME');}
      else this.beginFlow();
    }
  }
  tick(seconds) {
    if(this.paused||this.phase==='REVIEW') return;
    let wall=seconds;
    while(wall>0&&this.phase!=='REVIEW') {
      const rate=['FLOW','PRESENT','ADVANCE'].includes(this.phase)?this.speed:1;
      const used=Math.min(wall,this.remaining/rate); this.remaining=Math.max(0,this.remaining-used*rate); wall-=used;
      if(this.remaining<1e-8)this.advancePhase(); else break;
    }
  }
  skip() {if(this.phase==='PRESENT'){this.setPhase('ADVANCE');return true;}return false;}
  projection() {
    const runningSeconds=this.flow?Math.min(this.rules.deltaMin/4,this.rules.halfSeconds*this.flow.snapshot.half-this.flow.snapshot.matchSeconds):0;
    if(this.phase==='FLOW') {const t=1-this.remaining/this.rules.durations.FLOW;return {from:this.flow.from,to:this.flow.to,t,kind:'FLOW',cut:t<.5?'run':'wide',displaySeconds:this.flow.snapshot.matchSeconds+runningSeconds*t,text:this.flow.observation.text,eventIds:[],actorIds:[this.flow.observation.carrierId]};}
    if(this.phase==='PRESENT') {
      const cuts=presentationCuts(this.resolution),elapsed=this.rules.durations.PRESENT-this.remaining;
      let start=0,index=0;for(;index<cuts.length-1;index++){if(elapsed<start+cuts[index].duration)break;start+=cuts[index].duration;}
      return {...cuts[index],t:Math.min(1,(elapsed-start)/cuts[index].duration),index,displaySeconds:this.flow.snapshot.matchSeconds+runningSeconds};
    }
    const frame=this.phase==='COMMAND'?this.flow.to:visual(this.state);
    const elapsed=this.rules.durations.COMMAND-this.remaining;
    return {from:frame,to:frame,t:1,kind:this.phase,cut:this.phase==='COMMAND'?['choose','face','wide'][Math.floor(elapsed/1.5)%3]:this.phase,displaySeconds:this.phase==='COMMAND'?this.flow.snapshot.matchSeconds+runningSeconds:frame.matchSeconds,text:this.phase==='COMMAND'?'카드를 누르면 바로 진행합니다.':this.phase==='ADVANCE'?presentationCuts(this.resolution).at(-1).text:'',eventIds:[],actorIds:this.phase==='COMMAND'?[this.flow.observation.carrierId,this.flow.observation.defenderId]:[]};
  }
  snapshot() {return JSON.stringify({version:this.rules.version,...copy(this)});}
  static restore(raw,rules) {
    const x=JSON.parse(raw);if(x.version!==rules.version||hash(x.rules)!==hash(rules))throw new Error('경기 규칙이 바뀌었습니다. 새 경기로 시작합니다.');
    const g=new DirectorMatch(rules);Object.assign(g,x);g.rules=copy(rules);g.paused=true;return g;
  }
  resultHash() {return hash(this.state);}
}
