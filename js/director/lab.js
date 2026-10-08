import {FIXTURES,fixtureGame} from './fixtures.js';
import {CARDS,command} from './cards.js';
import {ScenePlayer} from '../ui/scene-player.js';
const $=id=>document.getElementById(id),rules=await(await fetch('data/director/rules.json')).json();
const panels=['first','second'].map(id=>{const el=$(id);return {el,scene:new ScenePlayer(el.querySelector('.stage'),el.querySelector('.radar')),game:null};});
await panels[0].scene.load();panels[1].scene.images=panels[0].scene.images;panels[1].scene.manifest=panels[0].scene.manifest;
for(const [key,f] of Object.entries(FIXTURES)){const o=document.createElement('option');o.value=key;o.textContent=f.title;$('case').append(o);}
let playing=false,last=performance.now();
function reset(){const key=$('case').value,f=FIXTURES[key];playing=false;panels.forEach((p,i)=>{p.game=fixtureGame(rules,key);p.game.queue(command(f.options[i]));p.el.querySelector('h2').textContent=CARDS[f.options[i]].name;p.el.querySelector('.cost').textContent='대가: '+CARDS[f.options[i]].cost;p.el.querySelector('.facts').textContent=p.game.flow.observation.text;});$('question').textContent='상대는 무엇을 준비하고 있나요? 각 선택 후 어느 선수가 움직이고 어디가 비나요?';}
$('case').onchange=reset;$('play').onclick=()=>{reset();for(const p of panels){p.game.commit();p.game.paused=false;}playing=true;};
$('next').onclick=()=>{for(const p of panels){if(p.game.phase==='PRESENT')p.game.skip();if(p.game.phase==='ADVANCE'){p.game.advancePhase();p.game.paused=true;}}playing=false;};
for(const [key,label] of Object.entries({PASS:'패스 연결',INTERCEPT:'차단',CARRY:'돌파 성공',TACKLE:'돌파 실패',GOAL:'골',SAVE:'선방',MISS:'빗나감'})){const a=document.createElement('a');a.href='director.html?outcome='+key;a.textContent=label;$('outcome-links').append(a);}
reset();function loop(now){const dt=Math.min(.1,(now-last)/1000);last=now;for(const p of panels){const g=p.game;if(playing&&g.phase==='PRESENT'){g.tick(Math.min(dt,g.remaining));if(g.phase==='ADVANCE')g.paused=true;}const frame=g.projection();p.scene.draw(frame,$('reduced').checked);p.el.querySelector('.caption').textContent=frame.t>=.6||g.phase!=='PRESENT'?frame.text:'선수들이 움직입니다.';if(g.resolution){const r=g.resolution;p.el.querySelector('.facts').textContent=`관측: ${r.appliedChanges.filter(c=>c.team==='A').map(c=>`${c.playerId.slice(1)}번 ${c.reason}`).join(' · ')||'추가 지시 이동 없음'}. 다음 소유 ${g.state.possessionTeam==='A'?'청해':'홍림'}, 경기시간 +${r.deltaMatchSeconds}초.`;}}requestAnimationFrame(loop);}requestAnimationFrame(loop);
