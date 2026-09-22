import { createRng } from '../game/rng.js';
export { createRng };
export const copy = value => structuredClone(value);
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const other = team => team === 'A' ? 'B' : 'A';
export const direction = (s, team) => (team === 'A' ? 1 : -1) * (s.half === 1 ? 1 : -1);
export const distance = (a, b) => Math.hypot(a.x-b.x, a.z-b.z);
export const player = (s, id) => s.players.find(p => p.id === id);
export const carrier = s => player(s, s.ball.ownerId);
export const teamPlayers = (s, team) => s.players.filter(p => p.team === team && p.active);
export function move(p, target, max = Infinity) {
  const d = distance(p.position, target), k = d > 0 ? Math.min(1, max/d) : 0;
  p.position = {x:clamp(p.position.x+(target.x-p.position.x)*k,-51,51), z:clamp(p.position.z+(target.z-p.position.z)*k,-32,32)};
}
export function control(s, p) {
  s.possessionTeam = p.team;
  s.ball = {...p.position, y:p.role==='GK'?1.1:0, ownerId:p.id, mode:'CONTROLLED', lastTouchTeam:p.team};
}
export function nearest(s, team, pos, includeKeeper = false) {
  return teamPlayers(s,team).filter(p=>includeKeeper || p.role!=='GK').sort((a,b)=>distance(a.position,pos)-distance(b.position,pos))[0];
}
export function segmentDistance(p, a, b) {
  const dx=b.x-a.x, dz=b.z-a.z;
  const t=clamp(((p.x-a.x)*dx+(p.z-a.z)*dz)/(dx*dx+dz*dz || 1),0,1);
  return distance(p,{x:a.x+t*dx,z:a.z+t*dz});
}
export function isOffside(s, passer, receiver, restart = s.restart?.type) {
  if (['GOALKICK','CORNER','THROW'].includes(restart)) return false;
  const dir=direction(s,passer.team), x=receiver.position.x*dir;
  const defenders=teamPlayers(s,other(passer.team)).map(p=>p.position.x*dir).sort((a,b)=>b-a);
  return x>0 && x>s.ball.x*dir+0.01 && x>(defenders[1]??52.5)+0.01;
}
export function hash(value) {
  const text=JSON.stringify(value, (key,v)=>['sessionId','commandId'].includes(key)?undefined:v);
  let h=2166136261; for (let i=0;i<text.length;i++) h=Math.imul(h^text.charCodeAt(i),16777619);
  return (h>>>0).toString(16).padStart(8,'0');
}
export function visual(s) {
  return copy({players:s.players,ball:s.ball,score:s.score,half:s.half,possessionTeam:s.possessionTeam,matchSeconds:s.matchSeconds,tacticalExposure:s.tacticalExposure});
}
const roles=['GK','FB','CB','CB','FB','DM','CM','CM','W','ST','W'];
const positions=[[-49,0],[-28,-25],[-32,-9],[-32,9],[-28,25],[-12,0],[-4,-13],[-4,13],[9,-25],[15,0],[9,25]];
export function createState(seed, rules, profile='wing') {
  const s={version:rules.version,seed:seed>>>0,sessionId:'',matchSeconds:0,half:1,score:{A:0,B:0},possessionTeam:'A',players:[],ball:{},tacticalExposure:[],encounterIndex:0,rngStates:{contest:seed>>>0||1,opponent:(seed^0x71983)>>>0||1},eventLog:[],history:[],restart:null,profile};
  for(const team of ['A','B']) roles.forEach((role,i)=>{
    const d=direction(s,team),[x,z]=positions[i];
    s.players.push({id:team+(i+1),team,number:i+1,role,active:true,position:{x:x*d,z:z*d},home:{x,z},pass:64,carry:62,shoot:role==='ST'?72:60,defend:['CB','FB','DM'].includes(role)?70:58,keep:role==='GK'?74:30});
  });
  control(s,player(s,'A9')); return s;
}
export function startRestart(s,type,team,pos) {
  s.restart={type,team,position:{x:clamp(pos.x,-52,52),z:clamp(pos.z,-34,34)}};
  s.ball={...s.restart.position,y:0,ownerId:null,mode:'RESTART',lastTouchTeam:s.ball.lastTouchTeam}; s.possessionTeam=team;
}
