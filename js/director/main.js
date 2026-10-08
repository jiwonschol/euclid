import { DirectorMatch } from './match.js';
import { CARDS,command,legal } from './cards.js';
import { stats } from './resolve.js';
import {distance,direction} from './state.js';
import { ScenePlayer } from '../ui/scene-player.js';
import { fixtureGame,FIXTURES,outcomeGame } from './fixtures.js';
const fixture=new URLSearchParams(location.search).get('fixture');
const $=id=>document.getElementById(id), storageKey='euclid-director-1'+(fixture?'-'+fixture:'');
const phases={READY:'경기 준비',FLOW:'상황 관찰',COMMAND:'지시 선택',PRESENT:'경기 진행',ADVANCE:'다음 전개',HALFTIME:'하프타임',REVIEW:'경기 종료'};
try {
 const response=await fetch('data/director/rules.json');if(!response.ok)throw new Error('경기 규칙을 불러오지 못했습니다.');const rules=await response.json();
 let game=new DirectorMatch(rules,42),side='left',cardKey='',lastPhase='',lastTime=performance.now(),lastSave=0,notice='',assetNotice='',sliceMode=false,incompatibleRecord=null;
 const outcome=new URLSearchParams(location.search).get('outcome');
 const stored=localStorage.getItem(storageKey);if(outcome){game=outcomeGame(rules,outcome);notice='고정 시드의 판정 장면입니다. 재개 또는 결과 스킵으로 계속하세요.';}else if(fixture&&FIXTURES[fixture]){game=fixtureGame(rules,fixture);notice=FIXTURES[fixture].title;}else if(stored){try{game=DirectorMatch.restore(stored,rules);notice='저장된 경기입니다. 재개하면 이어집니다.';}catch(error){notice=error.message;incompatibleRecord=stored;game.paused=true;}}
 function syncSelection(){const s=game.commandSnapshot();side=game.pending.id!=='hold'?game.pending.side:s.ball.z*direction(s,'A')>0?'right':'left';$('profile').value=game.state.profile;}
 syncSelection();
 const scene=new ScenePlayer($('scene'),$('radar'),()=>{assetNotice='일부 그림을 불러오지 못해 기본 표시로 진행합니다.';});await scene.load();
 $('reduced').checked=matchMedia('(prefers-reduced-motion: reduce)').matches;
 if(outcome){$('inspection').hidden=false;for(const [id,name] of Object.entries({PASS:'패스 연결',INTERCEPT:'패스 차단',CARRY:'돌파 성공',TACKLE:'돌파 실패',GOAL:'골',SAVE:'선방',MISS:'빗나감'})){const o=document.createElement('option');o.value=id;o.textContent=name;$('outcome-select').append(o);}$('outcome-select').value=outcome;$('outcome-select').onchange=()=>{game=outcomeGame(rules,$('outcome-select').value);syncSelection();lastPhase='';};}
 function save(){if(outcome||incompatibleRecord)return;try{localStorage.setItem(storageKey,game.snapshot());}catch{notice='이 브라우저에 기록을 저장할 공간이 부족합니다.';}}
 function restart(seed,profile=$('profile').value,replayInputs=null){game=new DirectorMatch(rules,seed,profile);game.replayInputs=replayInputs;syncSelection();cardKey='';lastPhase='';notice='';sliceMode=false;incompatibleRecord=null;save();}
 function queue(id,selectedSide=side){if(game.replayInputs)return;const error=game.queue(command(id,selectedSide),crypto.randomUUID());notice=error??`${CARDS[id].name} 예약. 확정 전까지 바꿀 수 있습니다.`;save();return error;}
 $('pause').onclick=()=>{game.paused=!game.paused;save();};
 $('speed').onclick=()=>{game.speed=game.speed===4?1:game.speed*2;};
 $('skip').onclick=()=>{game.skip();save();};
 $('new').onclick=()=>restart((Date.now()>>>0)||1);
 $('begin').onclick=()=>{incompatibleRecord=null;game.state.profile=$('profile').value;game.paused=false;game.advancePhase();save();};
 $('profile').onchange=()=>{if(game.phase==='READY'){game.state.profile=$('profile').value;save();}};
 $('slice').onclick=()=>{restart(42);sliceMode=true;save();};
 $('confirm').onclick=()=>{game.commit();save();};
 $('hold').onclick=()=>queue('hold');
 $('continue').onclick=()=>{if(game.phase==='HALFTIME'){game.advancePhase();game.paused=false;save();}};
 function setSide(value){if(game.pending.id!=='hold'&&['FLOW','COMMAND','HALFTIME'].includes(game.phase)){const error=queue(game.pending.id,value);side=error?game.pending.side:value;}else side=value;}
 $('left').onclick=()=>setSide('left');$('right').onclick=()=>setSide('right');
 $('retry').onclick=()=>restart(game.state.seed,game.state.profile);
 $('replay').onclick=()=>{const inputs=structuredClone(game.inputLog),seed=game.state.seed,profile=game.state.profile;restart(seed,profile,inputs);game.advancePhase();save();};
 function downloadRecord(raw){const url=URL.createObjectURL(new Blob([raw],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`euclid-${game.state.seed}.json`;a.click();URL.revokeObjectURL(url);}
 $('export').onclick=()=>downloadRecord(game.snapshot());$('export-prior').onclick=()=>downloadRecord(incompatibleRecord);
 document.addEventListener('visibilitychange',()=>{if(document.hidden){game.paused=true;save();}lastTime=performance.now();});
 document.addEventListener('keydown',event=>{
   if(['INPUT','SELECT','TEXTAREA'].includes(event.target.tagName))return;
   if(event.code==='Space'){event.preventDefault();$('pause').click();}
   if(event.key==='Enter'&&game.phase==='COMMAND')$('confirm').click();
   if(event.key==='Escape')queue('hold');
   if(event.key==='ArrowLeft')setSide('left');if(event.key==='ArrowRight')setSide('right');
   const n=Number(event.key);if(n>=1&&n<=3)$('cards').children[n-1]?.click();
 });
 function render() {
   if(lastPhase!==game.phase){
     if(game.phase==='COMMAND'&&game.replayInputs){const entry=game.replayInputs.find(x=>x.encounterId===game.state.encounterIndex+1);game.queue(entry?.command??command());side=game.pending.side;}
     if(game.phase==='FLOW'&&game.pending.id==='hold'){const s=game.commandSnapshot();if(s.ball.z!==0)side=s.ball.z*direction(s,'A')<0?'left':'right';}
   }
   const projection=game.projection(), shown=scene.draw(projection,$('reduced').checked);
   $('game').dataset.phase=game.phase;$('game').dataset.encounter=String(game.state.encounterIndex);$('game').classList.toggle('paused',game.paused);
   $('score').textContent=`${shown.score.A} : ${shown.score.B}`;
   const sec=shown.matchSeconds;$('clock').textContent=`${shown.half===1?'전반':'후반'} ${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`;
   $('phase').textContent=game.paused?'일시정지':phases[game.phase];$('pause').textContent=game.paused?'재개':'일시정지';$('speed').textContent=game.speed+'×';$('skip').disabled=game.phase!=='PRESENT';
   $('possession').textContent=`${shown.possessionTeam==='A'?'청해':'홍림'} 공격`;
   const resultVisible=projection.t>=.6||['FLOW','COMMAND','READY','ADVANCE'].includes(game.phase);
   const owner=shown.players.find(p=>p.id===shown.ball.ownerId),nearest=owner?shown.players.filter(p=>p.team!==owner.team&&p.role!=='GK').sort((a,b)=>distance(a.position,owner.position)-distance(b.position,owner.position))[0]:null;
   const live=owner&&nearest?`${Math.abs(owner.position.z)>14?'측면':'중앙'}에서 ${owner.team==='A'?'청해':'홍림'} ${owner.number}번 소유. 수비수까지 ${Math.round(distance(owner.position,nearest.position))}m.`:'';
   $('caption').textContent=game.phase==='FLOW'?live:resultVisible?projection.text:'선수들이 움직입니다.';
   $('export-prior').hidden=!incompatibleRecord;
   $('welcome').hidden=game.phase!=='READY';$('review').hidden=game.phase!=='REVIEW'&&game.phase!=='HALFTIME';
   $('observation').textContent=game.phase==='FLOW'?live+' 상대의 준비 동작을 살펴보세요.':game.flow?.observation.text??'선수와 공의 위치를 여기에서 함께 확인합니다.';
   $('advice').textContent=game.flow&&['FLOW','COMMAND'].includes(game.phase)?`참모 제안 · ${CARDS[game.flow.advice.id].name}`:'';
   $('turn-label').textContent=game.phase==='COMMAND'?'이번 움직임을 확정하세요':game.phase==='FLOW'?'다음 움직임 예약':'지시 도착과 결과';
   $('timer').textContent=['FLOW','COMMAND'].includes(game.phase)?`${Math.ceil(game.remaining)}초`:'';
   $('left').setAttribute('aria-pressed',side==='left');$('right').setAttribute('aria-pressed',side==='right');
   const displayed=['PRESENT','ADVANCE'].includes(game.phase)?game.resolution.committedCommand:game.pending;
   $('pending').textContent=CARDS[displayed.id].name;$('consequence').textContent=CARDS[displayed.id].cost;$('notice').textContent=[notice,assetNotice].filter(Boolean).join(' ');
   $('confirm').disabled=game.phase!=='COMMAND'||!!game.replayInputs;$('hold').disabled=!['FLOW','COMMAND','HALFTIME'].includes(game.phase)||!!game.replayInputs;
   const snapshot=game.commandSnapshot(),attack=snapshot.possessionTeam==='A',ids=rules.enabledCards.filter(id=>CARDS[id].kind===(attack?'attack':'defence'));
   const key=ids.join(',');if(cardKey!==key){cardKey=key;$('cards').replaceChildren(...ids.map((id,i)=>{const c=CARDS[id],button=document.createElement('button');button.className='card';button.dataset.card=id;button.setAttribute('aria-label',c.name);button.innerHTML=`${c.art?`<img class="art" src="assets/director/${c.art}.png" alt="">`:'<div class="symbol">↗</div>'}<span class="key">${i+1}</span><span class="copy"><strong>${c.name}</strong><small>${c.detail}</small></span>`;button.onclick=()=>queue(id);return button;}));}
   for(const button of $('cards').children){const reason=legal(snapshot,'A',command(button.dataset.card,side),rules);button.disabled=!!reason||!['FLOW','COMMAND','HALFTIME'].includes(game.phase)||!!game.replayInputs;button.title=reason??CARDS[button.dataset.card].cost;button.setAttribute('aria-pressed',displayed.id===button.dataset.card);}
   $('seed-label').textContent=`경기 ${game.state.seed} · ${game.state.encounterIndex}국면`;
   if(lastPhase!==game.phase) {
     lastPhase=game.phase;if(game.phase==='FLOW')notice='';if(game.phase==='PRESENT')notice=`${CARDS[game.resolution.committedCommand.id].name} 전달됨. 결과를 확인하세요.`;save();
     if(['HALFTIME','REVIEW'].includes(game.phase)) {
       const a=stats(game.state.eventLog,'A'),b=stats(game.state.eventLog,'B');$('result-title').textContent=game.phase==='HALFTIME'?'전반을 돌아봅니다.':`경기 종료 · ${game.state.score.A} : ${game.state.score.B}`;
       $('result-stats').textContent=`슛 ${a.shots}–${b.shots} · 유효슈팅 ${a.onTarget}–${b.onTarget} · 선방 ${a.saves}–${b.saves}`;
       $('review-events').replaceChildren(...game.records.slice(-6).map(r=>{const p=document.createElement('p');p.dataset.evidence=r.beats.at(-1).eventIds.join(',');p.textContent=`${r.encounterId}. ${CARDS[r.committedCommand.id].name} · ${r.appliedChanges.filter(c=>c.team==='A').length}명 이동. 관측: ${r.beats.at(-1).text}`;return p;}));
       $('continue').hidden=game.phase!=='HALFTIME';
       for(const id of ['replay','retry','export'])$(id).hidden=game.phase==='HALFTIME';
     }
   }
 }
 function loop(now) {
   const elapsed=Math.min(.1,(now-lastTime)/1000);lastTime=now;game.tick(elapsed);
   if(sliceMode&&game.state.encounterIndex===3&&game.phase==='FLOW'){game.paused=true;sliceMode=false;notice='첫 세 국면이 끝났습니다. 재개하면 한 경기를 계속합니다.';save();}
   render();if(now-lastSave>3000){save();lastSave=now;}requestAnimationFrame(loop);
 }
 requestAnimationFrame(loop);
} catch(error){$('caption').textContent=error.message;$('welcome').hidden=true;console.error(error);}
