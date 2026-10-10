import { copy, clamp, other, direction, carrier, player, teamPlayers, nearest, distance, move, control, segmentDistance, isOffside, createRng, hash, visual, startRestart } from './state.js';
import { CARDS, command, legal, applyCommand } from './cards.js';
export function passingOptions(s,rules,longPass=false) {
  const p=carrier(s); if(!p) return [];
  return teamPlayers(s,p.team).filter(q=>q.id!==p.id&&q.role!=='GK'&&distance(p.position,q.position)<(longPass?70:q.role==='FB'?rules.supportReach:rules.passReach)&&!isOffside(s,p,q));
}
export function chooseAction(s,cmd,rules,changes=[]) {
  const p=carrier(s), dir=direction(s,p.team), goalDistance=52.5-p.position.x*dir;
  if(s.restart?.type==='PK') return {type:'SHOT',penalty:true};
  if(cmd.id==='hold' && goalDistance<23 && Math.abs(p.position.z)<20) return {type:'SHOT'};
  const receivers=passingOptions(s,rules,cmd.id==='switch_play').filter(q=>cmd.id!=='switch_play'||q.position.z*p.position.z<0&&Math.abs(q.position.z-p.position.z)>=20);
  const score=q=>{
    const clear=Math.min(...teamPlayers(s,other(p.team)).map(d=>segmentDistance(d.position,p.position,q.position)));
    let value=(q.position.x-p.position.x)*dir*0.8+Math.min(10,clear)*1.4-distance(q.position,p.position)*0.2;
    if(cmd.id==='support_flank' && changes.some(c=>c.playerId===q.id)) value+=28;
    if(cmd.id==='switch_play') value+=Math.abs(q.position.z-p.position.z)*1.2;
    if(cmd.id==='run_inside' && changes.some(c=>c.playerId===q.id)) value+=Math.max(0,22-Math.abs(q.position.z))*1.5;
    return value;
  };
  receivers.sort((a,b)=>score(b)-score(a));
  const q=receivers[0];
  if(q && (score(q)>5 || cmd.id!=='hold')) return {type:Math.abs(p.position.z)>19&&goalDistance<32&&Math.abs(q.position.z)<12?'CROSS':cmd.id==='switch_play'?'AERIAL_PASS':'PASS',receiverId:q.id};
  return {type:'CARRY'};
}
export function resolveEncounter(snapshot,userCommand,opponentIntent,rules) {
  const s=copy(snapshot), beforeHash=hash(snapshot), events=[],beats=[],contests=[];
  const rng=createRng(s.rngStates.contest), id=s.encounterIndex+1, beaten=new Set();
  const chosen={A:copy(userCommand),B:copy(opponentIntent)};
  for(const team of ['A','B']) if(legal(s,team,chosen[team],rules)) chosen[team]=command();
  const attackTeam=s.possessionTeam, attackCommand=chosen[attackTeam], appliedChanges=[];
  const name=p=>`${p.team==='A'?'청해':'홍림'} ${p.number}번`;
  function emit(type,data={}) {const e={id:`e${id}-${events.length+1}`,encounterId:id,type,...data}; events.push(e); s.eventLog.push(e); return e;}
  function beat(from,text,kind,actors=[]) {const fresh=events.filter(e=>!beats.some(b=>b.eventIds.includes(e.id)));beats.push({id:`b${id}-${beats.length+1}`,kind,text,actorIds:actors,from,to:visual(s),eventIds:fresh.map(e=>e.id),eventTypes:fresh.map(e=>e.type),flight:fresh.some(e=>e.type==='PASS'&&e.mode!=='PASS')});}
  function contest(kind,a,d,attack,defence,position) {
    const probability=clamp(0.5+(attack-defence)/rules.duelScale,0.1,0.9), draw=rng.float();
    contests.push({kind,actorId:a.id,defenderId:d?.id??null,attackRating:attack,defenceRating:defence,probability,draw,position:copy(position)});
    return draw<probability;
  }
  const setup=visual(s);
  for(const team of [other(attackTeam),attackTeam]) {
    const changes=applyCommand(s,team,chosen[team]); appliedChanges.push(...changes);
    if(chosen[team].id!=='hold') emit('COMMAND_APPLIED',{team,cardId:chosen[team].id,changes});
  }
  if(appliedChanges.length) beat(setup,appliedChanges.map(c=>`${name(player(s,c.playerId))} ${c.reason}`).join(' · '),'TACTIC',appliedChanges.map(c=>c.playerId));
  function shoot(p,penalty=false) {
    const from=visual(s),dir=direction(s,p.team),keeper=teamPlayers(s,other(p.team)).find(q=>q.role==='GK');
    const shotId=`shot-${id}-${events.length}`,origin=copy(p.position),gap=52.5-p.position.x*dir;
    emit('SHOT',{team:p.team,actorId:p.id,shotId,position:origin,penalty});
    const onTarget=contest('AIM',p,null,p.shoot+(penalty?18:0),38+Math.abs(p.position.z)*0.8+gap*0.6,origin);
    s.ball={x:52.5*dir,z:onTarget?(rng.float()*6-3):Math.sign(p.position.z||1)*(5+rng.float()*8),y:1.1,ownerId:null,mode:'SHOT',lastTouchTeam:p.team};
    if(!onTarget) {emit('MISS',{shotId,team:p.team,actorId:p.id}); beat(from,`${name(p)}의 슛이 골문을 벗어났습니다.`,'MISS',[p.id,keeper.id]); startRestart(s,'GOALKICK',keeper.team,{x:47*dir,z:0}); return;}
    const saved=!contest('KEEP',p,keeper,p.shoot+Math.max(0,18-gap),keeper.keep,origin);
    if(saved) {
      move(keeper,{x:49*dir,z:s.ball.z}); control(s,keeper); emit('SAVE',{shotId,team:keeper.team,actorId:keeper.id});
      beat(from,`${keeper.team==='A'?'청해':'홍림'} 골키퍼가 잡았습니다.`,'SAVE',[p.id,keeper.id]);
    } else {
      s.score[p.team]++; emit('GOAL',{shotId,team:p.team,actorId:p.id}); beat(from,`${p.team==='A'?'청해':'홍림'} ${p.number}번, 골!`,'GOAL',[p.id,keeper.id]); startRestart(s,'KICKOFF',keeper.team,{x:0,z:0});
    }
  }
  for(let actionIndex=0;actionIndex<2 && beats.length<4 && contests.length<3;actionIndex++) {
    const p=carrier(s); if(!p || p.team!==attackTeam) break;
    const activeCommand=actionIndex===0?attackCommand:command(), action=chooseAction(s,activeCommand,rules,appliedChanges);
    const dir=direction(s,p.team), from=visual(s), enemy=other(p.team);
    if(action.type==='SHOT') {if(contests.length>1) break; shoot(p,action.penalty); s.restart=s.ball.mode==='CONTROLLED'?null:s.restart; break;}
    if(['PASS','AERIAL_PASS','CROSS'].includes(action.type)) {
      const q=player(s,action.receiverId), atRelease=copy(s);
      if(isOffside(atRelease,p,q)) {emit('OFFSIDE',{actorId:q.id,team:q.team}); startRestart(s,'FREEKICK',enemy,q.position); beat(from,`${q.number}번, 패스 순간 오프사이드.`,'OFFSIDE',[p.id,q.id]); break;}
      const airborne=action.type!=='PASS';
      const coverage=d=>airborne?distance(d.position,q.position):segmentDistance(d.position,p.position,q.position);
      const blockers=teamPlayers(s,enemy).filter(d=>d.role!=='GK'&&!beaten.has(d.id)).sort((a,b)=>coverage(a)-coverage(b));
      const blocker=blockers[0], lane=coverage(blocker), length=distance(p.position,q.position);
      const support=teamPlayers(s,p.team).filter(a=>a.id!==p.id&&distance(a.position,q.position)<12).length;
      const attack=p.pass+clamp(lane*2+support*2-length*0.45,-rules.ratingCap,rules.ratingCap);
      // A remote defender cannot contest an open pass. In open space the
      // opposition is delivery difficulty; lofted balls are contested at landing.
      const defence=lane<=5?blocker.defend+clamp(10-lane*3,-rules.ratingCap,rules.ratingCap):20+length*.45;
      const success=contest(action.type,p,blocker,attack,defence,p.position);
      emit('PASS',{team:p.team,actorId:p.id,receiverId:q.id,position:copy(p.position),target:copy(q.position),mode:action.type,success,releaseHalf:atRelease.half});
      s.restart=null;
      if(success) {control(s,q); emit('RECEIVE',{actorId:q.id,team:q.team,airborne:action.type!=='PASS'}); beat(from,`${name(p)} → ${q.number}번, ${action.type==='CROSS'?'크로스':action.type==='AERIAL_PASS'?'큰 전환':'패스'} 연결.` ,action.type,[p.id,q.id,blocker.id]);}
      else if(lane<=5) {
        const dx=q.position.x-p.position.x,dz=q.position.z-p.position.z,t=clamp(((blocker.position.x-p.position.x)*dx+(blocker.position.z-p.position.z)*dz)/(dx*dx+dz*dz||1),0,1);
        move(blocker,airborne?q.position:{x:p.position.x+t*dx,z:p.position.z+t*dz});control(s,blocker);
        for(const a of [p,q])if(distance(a.position,blocker.position)<3)move(a,{x:a.position.x-dir*3,z:a.position.z+2});
        emit('INTERCEPT',{team:enemy,actorId:blocker.id,airborne});beat(from,`${name(blocker)}이 ${airborne?'낙하지점에서':'패스 길에서'} 끊었습니다. 소유권 전환.`,'INTERCEPT',[p.id,q.id,blocker.id]);break;
      } else {
        s.ball={x:q.position.x+dir*(4+rng.float()*10),z:q.position.z+Math.sign(q.position.z||1)*(3+rng.float()*9),y:0,mode:'LOOSE',ownerId:null,lastTouchTeam:p.team};
        emit('PASS_LOOSE',{team:p.team,actorId:p.id});
        const looseFrame=visual(s);
        if(Math.abs(s.ball.x)>52.5 || Math.abs(s.ball.z)>34) {
          const pos=copy(s.ball);if(Math.abs(pos.x)>52.5){const defending=direction(s,'A')===Math.sign(pos.x)?'B':'A';const corner=p.team===defending;startRestart(s,corner?'CORNER':'GOALKICK',corner?other(defending):defending,{x:Math.sign(pos.x)*(corner?51.5:47),z:corner?Math.sign(pos.z||1)*33:0});}
          else startRestart(s,'THROW',enemy,{x:pos.x,z:Math.sign(pos.z)*34});
          emit('OUT',{team:p.team,lastTouchTeam:p.team,restart:copy(s.restart)});
        }
        const restartNames={THROW:'스로인',GOALKICK:'골킥',CORNER:'코너킥'};
        const restart=s.restart,finalBall=copy(s.ball);s.ball=looseFrame.ball;
        beat(from,`${name(p)}의 패스가 길었습니다. ${restart?restartNames[restart.type]+'으로 재개합니다.':'공을 따라갑니다.'}`,'AERIAL_PASS',[p.id,q.id]);s.ball=finalBall;
        break;
      }
    } else {
      const defender=teamPlayers(s,enemy).filter(d=>d.role!=='GK'&&!beaten.has(d.id)).sort((a,b)=>distance(a.position,p.position)-distance(b.position,p.position))[0], gap=distance(defender.position,p.position);
      const nearGoal=52.5-p.position.x*dir<25;
      const target=nearGoal?{x:Math.min(45,p.position.x*dir+5)*dir,z:Math.sign(p.position.z)*Math.max(0,Math.abs(p.position.z)-12)}:{x:p.position.x+dir*15,z:p.position.z*0.93};
      s.restart=null;
      if(gap>rules.pressureReach) {move(p,target,15); control(s,p); emit('ADVANCE',{team:p.team,actorId:p.id,from:from.ball,to:copy(p.position)}); beat(from,`${name(p)}, 열린 공간으로 전진합니다.`,'CARRY',[p.id,defender.id]);}
      else {
        if(contests.length===0 && rng.float()<rules.foulRate) {
          const penalty=(52.5-p.position.x*dir)<16.5&&Math.abs(p.position.z)<20.16;
          emit('FOUL',{team:enemy,actorId:defender.id,victimId:p.id,penalty});
          if(penalty) {p.position={x:41.5*dir,z:0};control(s,p);emit('PENALTY',{team:p.team});beat(from,'페널티킥이 선언됐습니다.','FOUL',[p.id,defender.id]);shoot(p,true);} else {startRestart(s,'FREEKICK',p.team,p.position);beat(from,'접촉 반칙. 같은 위치에서 프리킥으로 이어집니다.','FOUL',[p.id,defender.id]);} break;
        }
        const success=contest('CARRY',p,defender,p.carry+clamp(gap-3,-rules.ratingCap,rules.ratingCap),defender.defend,p.position);
        if(success) {beaten.add(defender.id);move(p,target,13); move(defender,{x:defender.position.x-dir*3,z:defender.position.z});control(s,p);s.tacticalExposure.push({team:enemy,kind:'beaten',actorIds:[defender.id],created:s.encounterIndex,expires:s.encounterIndex+1});emit('BEATEN',{team:p.team,actorId:p.id,defenderId:defender.id});beat(from,`${name(p)}이 수비수를 지나칩니다. 수비수는 복귀가 늦습니다.`,'CARRY',[p.id,defender.id]);}
        else {move(defender,p.position,8);control(s,defender);move(p,{x:p.position.x-dir*3,z:p.position.z+2});emit('TACKLE_WON',{team:enemy,actorId:defender.id});beat(from,`${name(defender)}이 공을 빼앗았습니다.`,'TACKLE',[p.id,defender.id]);break;}
      }
    }
  }
  if(!beats.length) beat(visual(s),'다음 전개를 준비합니다.','HOLD',[]);
  const delta=Math.min(rules.halfSeconds*s.half-s.matchSeconds,clamp(rules.baseDelta+CARDS[attackCommand.id].tempo,rules.deltaMin,rules.deltaMax));
  s.matchSeconds+=delta; s.encounterIndex++; s.rngStates.contest=rng.state;
  s.history.push({encounterId:id,team:attackTeam,commandA:chosen.A,commandB:chosen.B});
  for(const team of ['A','B']) if(chosen[team].id!=='hold') emit('COMMAND_EXPIRED',{team,cardId:chosen[team].id});
  return {id:`resolution-${id}`,encounterId:id,rulesVersion:rules.version,beforeHash,opponentIntent:chosen.B,committedCommand:chosen.A,appliedChanges,contests,events,beats,nextState:s,afterHash:hash(s),deltaMatchSeconds:delta};
}
export function stats(events,team) {
  const own=events.filter(e=>e.team===team), shots=new Set(own.filter(e=>e.type==='SHOT').map(e=>e.shotId));
  return {shots:shots.size,onTarget:new Set(events.filter(e=>['GOAL','SAVE'].includes(e.type)&&shots.has(e.shotId)).map(e=>e.shotId)).size,goals:own.filter(e=>e.type==='GOAL').length,saves:own.filter(e=>e.type==='SAVE').length};
}
