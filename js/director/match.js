import { copy, createState, startRestart, visual, hash } from './state.js';
import { command, legal } from './cards.js';
import { prepareEncounter } from './scenario.js';
import { resolveEncounter } from './resolve.js';
export class DirectorMatch {
  constructor(rules,seed=42,profile='wing') {
    this.rules=copy(rules); this.state=createState(seed,rules,profile);this.phase='READY';this.remaining=rules.durations.READY;
    this.pending=command();this.records=[];this.inputLog=[];this.commandEvents=[];this.flow=null;this.resolution=null;this.paused=false;this.speed=1;this.seenCommands=[];this.resolvedIds=[];
  }
  setPhase(phase) {this.phase=phase;this.remaining=this.rules.durations[phase]??0;}
  queue(cmd,id) {
    if(!['FLOW','COMMAND','HALFTIME'].includes(this.phase)) return '현재 지시는 확정됐습니다.';
    if(id&&this.seenCommands.includes(id)) return '이미 접수한 입력입니다.';
    const s=this.flow?.snapshot??this.state, error=legal(s,'A',cmd,this.rules); if(error) return error;
    if(id) this.seenCommands.push(id);
    this.commandEvents.push({type:cmd.id==='hold'?'COMMAND_CANCELED':this.pending.id==='hold'?'COMMAND_QUEUED':'COMMAND_REPLACED',encounterId:s.encounterIndex+1,cardId:cmd.id});
    this.pending=copy(cmd); return null;
  }
  beginFlow() {this.flow=prepareEncounter(this.state,this.rules);this.state=copy(this.flow.initialState);this.resolution=null;this.setPhase('FLOW');}
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
    if(this.phase==='FLOW') return {from:this.flow.from,to:this.flow.to,t:1-this.remaining/this.rules.durations.FLOW,kind:'FLOW',text:this.flow.observation.text,eventIds:[],actorIds:[this.flow.observation.carrierId,this.flow.observation.defenderId]};
    if(this.phase==='PRESENT') {
      const progress=(1-this.remaining/this.rules.durations.PRESENT)*this.resolution.beats.length;
      const idx=Math.min(this.resolution.beats.length-1,Math.floor(progress)), b=this.resolution.beats[idx];
      return {...b,t:progress-idx,index:idx};
    }
    const frame=this.phase==='COMMAND'?this.flow.to:visual(this.state);
    return {from:frame,to:frame,t:1,kind:this.phase,text:this.phase==='COMMAND'?'다음 움직임을 지시하세요.':this.phase==='ADVANCE'?this.resolution.beats.at(-1).text:'',eventIds:[],actorIds:this.phase==='COMMAND'?[this.flow.observation.carrierId,this.flow.observation.defenderId]:[]};
  }
  snapshot() {return JSON.stringify({version:this.rules.version,...copy(this)});}
  static restore(raw,rules) {
    const x=JSON.parse(raw);if(x.version!==rules.version||hash(x.rules)!==hash(rules))throw new Error('경기 규칙이 바뀌었습니다. 새 경기로 시작합니다.');
    const g=new DirectorMatch(rules);Object.assign(g,x);g.rules=copy(rules);g.paused=true;return g;
  }
  resultHash() {return hash(this.state);}
}
