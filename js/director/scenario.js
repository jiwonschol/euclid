import { copy, carrier, control, teamPlayers, nearest, direction, other, distance, move, createRng, player, visual } from './state.js';
import { command, legal,applyCommand } from './cards.js';
export function prepareEncounter(state,rules) {
  const s=copy(state), events=[];
  s.tacticalExposure=s.tacticalExposure.filter(e=>e.expires>=s.encounterIndex);
  if(s.restart) {
    const {type,team,position}=s.restart;
    if(type==='KICKOFF') for(const q of s.players) {
      const dir=direction(s,q.team); q.position={x:Math.max(-49,Math.min(-1,q.home.x-14))*dir,z:q.home.z*dir};
    }
    const taker=type==='GOALKICK'?teamPlayers(s,team).find(q=>q.role==='GK'):nearest(s,team,position);
    taker.position=copy(position); control(s,taker);
    for(const q of teamPlayers(s,other(team))) if(distance(q.position,position)<(type==='THROW'?2:9.15)) move(q,{x:position.x+direction(s,team)*10,z:position.z+Math.sign(q.position.z-position.z||1)*8});
    events.push({type:'RESTART_TAKEN',restartType:type,team,actorId:taker.id});
  } else if(s.ball.mode==='LOOSE') { const q=s.players.filter(q=>q.role!=='GK').sort((a,b)=>distance(a.position,s.ball)-distance(b.position,s.ball))[0]; move(q,s.ball); control(s,q); events.push({type:'LOOSE_RECOVERY',actorId:q.id,team:q.team}); }
  const from=visual(s),initialState=copy(s);
  const p=carrier(s), d=direction(s,p.team), rng=createRng(s.rngStates.opponent);
  const opponentTeam='B';
  const options=s.possessionTeam==='B'?['support_flank','switch_play','run_inside']:['screen_middle','press_flank','delay_drop'];
  const fav=s.profile==='central'?'run_inside':s.profile==='patient'?'delay_drop':'support_flank';
  const lastA=s.history.at(-1)?.commandA?.id,lastB=s.history.at(-1)?.commandB?.id;
  const ranked=[...options,'hold'].filter(id=>!legal(s,'B',command(id,p.position.z*direction(s,'B')<0?'left':'right'),rules)).map(id=>{
    let value=id==='hold'?1:2;if(id===fav)value+=1.5;if(id===lastB)value-=2;
    if(id==='support_flank')value+=Math.abs(p.position.z)>15?1:-2;
    if(id==='run_inside')value+=Math.abs(p.position.z)<15?1:0;
    if(id==='switch_play'&&lastA==='screen_middle')value+=2;
    if(id==='screen_middle'&&lastA==='run_inside')value+=2;
    if(id==='delay_drop'&&(52.5-Math.abs(p.position.x))<25)value+=1;
    return {id,value:value+rng.float()};
  }).sort((a,b)=>b.value-a.value);
  const preferred=ranked[0].id;
  const opponentIntent=command(preferred, p.position.z*direction(s,'B')<0?'left':'right');
  if(legal(s,opponentTeam,opponentIntent,rules)) opponentIntent.id='hold';
  s.rngStates.opponent=rng.state;
  const near=nearest(s,other(p.team),p.position);
  if(!s.restart) move(p,{x:p.position.x+8*d,z:p.position.z},Math.max(0,Math.min(8,distance(near.position,p.position)-6)));
  for(const q of s.players) {
    if(q.id===p.id||q.role==='GK') continue;
    const qd=direction(s,q.team), recovering=s.tacticalExposure.some(e=>e.actorIds.includes(q.id));
    const target={x: q.team===p.team ? p.position.x+(q.home.x+8)*qd*0.55 : p.position.x-qd*(8+Math.abs(q.home.x)*0.45), z:q.home.z*qd};
    move(q,target,recovering?3:7);
  }
  const preview=copy(s), preparations=applyCommand(preview,'B',opponentIntent);
  for(const change of preparations){const q=player(s,change.playerId),before=copy(q.position);move(q,change.to,3);if(distance(before,q.position)>.2)events.push({type:'PREPARE_MOVE',team:'B',actorId:q.id,from:before,to:copy(q.position),cue:change.reason});}
  control(s,p);
  const threat=nearest(s,other(p.team),p.position), wing=Math.abs(p.position.z)>14;
  events.forEach((e,i)=>{e.id=`f${s.encounterIndex+1}-${i+1}`;e.encounterId=s.encounterIndex+1;});
  const side=p.position.z*direction(s,'A')<0?'left':'right';
  const suggested=p.team==='A'?(wing?'support_flank':'run_inside'):(distance(threat.position,p.position)<7?'delay_drop':'screen_middle');
  const advice=legal(s,'A',command(suggested,side),rules)?command():command(suggested,side);
  return {id:s.encounterIndex+1,from,to:visual(s),initialState,snapshot:s,opponentIntent,events,advice,
    observation:{carrierId:p.id,defenderId:threat.id,space:Math.round(distance(p.position,threat.position)),zone:wing?'측면':'중앙',text:`${wing?'측면':'중앙'}에서 ${p.team==='A'?'청해':'홍림'} ${p.number}번 소유. 수비수까지 ${Math.round(distance(p.position,threat.position))}m.${events.some(e=>e.type==='PREPARE_MOVE')?' 홍림 '+events.filter(e=>e.type==='PREPARE_MOVE').map(e=>player(s,e.actorId).number+'번 '+e.cue).join(' · '):''}`}};
}
