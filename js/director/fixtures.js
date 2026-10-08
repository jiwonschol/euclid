import { DirectorMatch } from './match.js';
import { control,player } from './state.js';
export const FIXTURES={
 attack:{title:'측면 지원 / 기본 유지',options:['support_flank','hold'],team:'A',x:8,z:-22},
 defence:{title:'중앙 차단 / 후퇴 지연',options:['screen_middle','delay_drop'],team:'B',x:-8,z:16},
 switch:{title:'반대쪽 전환 / 중앙 침투',options:['switch_play','run_inside'],team:'A',x:8,z:-25},
 pressure:{title:'측면 압박 / 중앙 차단',options:['press_flank','screen_middle'],team:'B',x:-8,z:-22},
 transition:{title:'지원 뒤 공간 / 유지 뒤 공간',options:['support_flank','hold'],team:'A',x:22,z:-20}
};
export function fixtureGame(rules,key,seed=42) {
 const def=FIXTURES[key];if(!def)throw new Error('없는 비교 장면입니다.');
 const g=new DirectorMatch(rules,seed),p=player(g.state,def.team+'9');p.position={x:def.x,z:def.z};control(g.state,p);g.advancePhase();g.advancePhase();g.paused=true;return g;
}
// QA-only seeded scenes. Search is confined to this explicit inspection route;
// a live match never substitutes an outcome or searches for a desired result.
export function outcomeGame(rules,kind) {
 if(!['PASS','INTERCEPT','CARRY','TACKLE','GOAL','SAVE','MISS'].includes(kind))throw new Error('없는 결과 장면입니다.');
 for(let seed=1;seed<=200;seed++){
  const g=new DirectorMatch(rules,seed),p=player(g.state,'A9');
  if(['GOAL','SAVE','MISS'].includes(kind)){p.position={x:39,z:0};control(g.state,p);}
  if(['CARRY','TACKLE'].includes(kind)){p.position={x:20,z:-25};control(g.state,p);g.state.players.filter(q=>q.team==='A'&&q.id!==p.id).forEach(q=>q.position.x=-35);player(g.state,'B5').position={x:24,z:-25};}
  g.advancePhase();g.advancePhase();if(['PASS','INTERCEPT'].includes(kind))g.queue({id:'support_flank',side:'left'});g.commit();
  const index=g.resolution.beats.findIndex(b=>b.kind===kind&&(kind!=='CARRY'||b.eventTypes.includes('BEATEN')));if(index<0)continue;
  g.remaining=rules.durations.PRESENT*(1-(index+.85)/g.resolution.beats.length);g.paused=true;return g;
 }throw new Error('결과 장면을 찾지 못했습니다.');
}
