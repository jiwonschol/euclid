import { other, direction, carrier, teamPlayers, distance, isOffside, move, copy } from './state.js';
export const CARDS = {
  hold:{name:'기본 유지',kind:'any',detail:'선수가 현재 공간에서 판단합니다.',cost:'새로운 전술 이동을 지시하지 않습니다.',tempo:0},
  support_flank:{name:'측면 지원',kind:'attack',detail:'풀백이 올라가 패스 길을 하나 더 만듭니다.',cost:'빼앗기면 올라간 풀백 뒤가 열립니다.',tempo:0,art:'card-support'},
  switch_play:{name:'반대쪽 전환',kind:'attack',detail:'반대편 선수에게 길게 연결합니다.',cost:'전달이 길고 경기시간을 30초 더 씁니다.',tempo:30,art:'card-switch'},
  run_inside:{name:'중앙 침투',kind:'attack',detail:'중앙 선수가 수비 사이로 움직입니다.',cost:'중앙에서 잃으면 역습 통로가 열립니다.',tempo:-15,art:'card-inside'},
  press_flank:{name:'측면 압박',kind:'defence',detail:'두 선수가 측면으로 붙습니다.',cost:'반대쪽과 중앙의 커버가 줄어듭니다.',tempo:0,art:'card-press'},
  screen_middle:{name:'중앙 차단',kind:'defence',detail:'중앙 연결 길을 먼저 막습니다.',cost:'측면에서 상대가 전진할 공간을 줍니다.',tempo:0,art:'card-screen'},
  delay_drop:{name:'후퇴 지연',kind:'defence',detail:'달려들지 않고 골 방향으로 복귀합니다.',cost:'당장 빼앗을 기회와 전진 공간을 내줍니다.',tempo:0,art:'card-drop'}
};
export const command = (id='hold',side='left') => ({id,side});
export function legal(s, team, cmd, rules) {
  const c=CARDS[cmd?.id]; if (!c) return '없는 지시입니다.';
  if(c.kind==='any') return null;
  if(!rules.enabledCards.includes(cmd.id)) return '아직 사용할 수 없는 지시입니다.';
  const attacking=s.possessionTeam===team;
  if((c.kind==='attack')!==attacking) return attacking?'수비할 때 사용할 수 있습니다.':'공격할 때 사용할 수 있습니다.';
  if(!['left','right'].includes(cmd.side)) return '측면을 선택하세요.';
  const p=carrier(s); if(!p) return '재개 준비 뒤 선택할 수 있습니다.';
  if(s.restart?.type==='PK') return '페널티킥은 키커의 슛으로 진행합니다.';
  if(cmd.id==='press_flank'&&(Math.abs(p.position.z)<10 || Math.sign(p.position.z*direction(s,team))!==(cmd.side==='left'?-1:1)))return '공이 있는 측면을 선택하세요.';
  if(cmd.id==='support_flank' && !teamPlayers(s,team).some(q=>q.role==='FB'&&q.id!==p.id)) return '지원할 풀백이 없습니다.';
  if(cmd.id==='support_flank') {
    const preview=copy(s),changes=applyCommand(preview,team,cmd),q=preview.players.find(q=>q.id===changes[0].playerId);
    if(distance(p.position,q.position)>=rules.supportReach || isOffside(preview,carrier(preview),q)) return '이동 뒤 패스를 받을 수 있는 풀백이 없습니다.';
  }
  if(['switch_play','run_inside'].includes(cmd.id)&&!teamPlayers(s,team).some(q=>q.id!==p.id&&q.role!=='GK'&&!isOffside(s,p,q))) return '합법적인 연결 선수가 없습니다.';
  if(cmd.id==='switch_play'&&!teamPlayers(s,team).some(q=>q.id!==p.id&&q.role!=='GK'&&!isOffside(s,p,q)&&q.position.z*p.position.z<0&&Math.abs(q.position.z-p.position.z)>=20&&distance(q.position,p.position)<65))return '반대편에 연결할 선수가 없습니다.';
  return null;
}
export function applyCommand(s,team,cmd) {
  const p=carrier(s), d=direction(s,team), side=cmd.side==='left'?-d:d, changes=[];
  if(!p||cmd.id==='hold') return changes;
  const allies=teamPlayers(s,team).filter(q=>q.role!=='GK');
  const shift=(q,target,reason,max=22)=>{const from=copy(q.position); move(q,target,max); changes.push({playerId:q.id,from,to:copy(q.position),reason,team});};
  const expose=(kind,actors)=>s.tacticalExposure.push({team,kind,actorIds:actors,created:s.encounterIndex,expires:s.encounterIndex+2});
  if(cmd.id==='support_flank') {
    const q=allies.filter(q=>q.role==='FB'&&q.id!==p.id).sort((a,b)=>b.position.z*side-a.position.z*side)[0];
    shift(q,{x:p.position.x+5*d,z:side*28},'지원 합류',35); expose('flank', [q.id]);
  } else if(cmd.id==='screen_middle') {
    const cover=allies.filter(q=>['DM','CM'].includes(q.role)).sort((a,b)=>distance(a.position,p.position)-distance(b.position,p.position)).slice(0,2);
    cover.forEach((q,i)=>shift(q,{x:p.position.x-9*d,z:i?-6:6},'중앙 길목 커버')); expose('wide',cover.map(q=>q.id));
  } else if(cmd.id==='delay_drop') {
    allies.filter(q=>distance(q.position,p.position)<25).forEach(q=>shift(q,{x:q.position.x-10*d,z:q.position.z*0.8},'골 방향 복귀')); expose('territory',[]);
  } else if(cmd.id==='press_flank') {
    const press=allies.sort((a,b)=>distance(a.position,p.position)-distance(b.position,p.position)).slice(0,2);
    press.forEach((q,i)=>shift(q,{x:p.position.x-(2+i*4)*d,z:p.position.z+side*(i?4:1)},'측면 압박')); expose('opposite',press.map(q=>q.id));
  } else if(cmd.id==='run_inside') {
    const q=allies.filter(q=>q.id!==p.id&&!isOffside(s,p,q)).sort((a,b)=>(a.role==='ST'?-50:0)+Math.abs(a.position.z)-((b.role==='ST'?-50:0)+Math.abs(b.position.z)))[0];
    const line=teamPlayers(s,other(team)).map(q=>q.position.x*d).sort((a,b)=>b-a)[1];
    shift(q,{x:Math.min(p.position.x*d+9,Math.max(s.ball.x*d,line)-.5)*d,z:0},'중앙 침투'); expose('middle',[q.id]);
  } else if(cmd.id==='switch_play') {
    const q=allies.filter(q=>q.id!==p.id&&!isOffside(s,p,q)&&q.position.z*p.position.z<0).sort((a,b)=>(b.position.x-a.position.x)*d+(b.role==='W'?20:0)-(a.role==='W'?20:0))[0];
    shift(q,{x:q.position.x+2*d,z:-Math.sign(p.position.z||1)*28},'반대쪽 연결 준비',5);
  }
  return changes;
}
