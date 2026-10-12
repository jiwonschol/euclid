const {chromium}=require('/usr/lib/node_modules/playwright');
const fs=require('node:fs'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const mode=process.argv[2]||'after',widths=process.argv[3]?[Number(process.argv[3])]:[1280,1920,375,740],out='/home/buzz-hyuncheol/.buzz/.scratch/EUCLID_28_LABELS_'+mode+(process.argv[3]?'_'+process.argv[3]:'');
fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true}),report={mode,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:'/home/buzz-hyuncheol/.buzz/REPOS/euclid/.claude/worktrees/buzz-23',encoding:'utf8'}).trim(),frames:[],errors:[],failures:[],summary:[]};
 for(const width of widths)for(const reduced of [false,true])for(const scenario of ['match','support_flank','press_flank','screen_middle','delay_drop','delay_drop_7','run_inside','switch_play','SAVE','CARRY','TACKLE','MISS','PASS','INTERCEPT','GOAL']){
  const outcome=['SAVE','CARRY','TACKLE','MISS','PASS','INTERCEPT','GOAL'].includes(scenario),fixture=['press_flank','screen_middle','delay_drop'].includes(scenario)?'defence':['switch_play','run_inside'].includes(scenario)?'switch':'attack';
  const url=outcome?'director.html?outcome='+scenario:['match','delay_drop_7'].includes(scenario)?'director.html':'director.html?fixture='+fixture;
  const p=await browser.newPage({viewport:{width,height:width===1920?1080:width<=740?812:720}});
  p.on('pageerror',e=>report.errors.push(e.message));
  if(mode==='before')await p.route(/js\/ui\/scene-player\.js/,r=>r.fulfill({contentType:'application/javascript',body:execFileSync('git',['show','bd8096e:js/ui/scene-player.js'],{cwd:'/home/buzz-hyuncheol/.buzz/REPOS/euclid/.claude/worktrees/buzz-23',encoding:'utf8'})}));
  await p.clock.install();await p.clock.pauseAt(new Date(Date.now()+1000));await p.goto('http://localhost:8653/'+url);await p.waitForSelector('.card');await p.clock.runFor(30);
  if(scenario==='delay_drop_7'){
   const snapshot=await p.evaluate(async()=>{
    const {DirectorMatch,presentationCuts}=await import('./js/director/match.js'),{command}=await import('./js/director/cards.js'),rules=await(await fetch('data/director/rules.json')).json(),g=new DirectorMatch(rules,7);
    for(let step=0;step<400;step++){
     if(['COMMAND','FLOW','HALFTIME'].includes(g.phase)&&!g.queue(command('delay_drop','left'))){
      if(g.phase!=='COMMAND')g.advancePhase();if(g.phase==='FLOW')g.advancePhase();
      const before=g.snapshot();g.commit();
      if(presentationCuts(g.resolution).find(c=>c.cut==='movement').actorIds.length===7){const ready=DirectorMatch.restore(before,rules);ready.paused=true;return ready.snapshot();}
     }
     g.advancePhase();
    }throw new Error('seed 7 must reach seven movers');
   });
   await p.addInitScript(raw=>localStorage.setItem('euclid-director-1',raw),snapshot);
   await p.reload();await p.waitForSelector('.card');await p.clock.runFor(30);
  }
  if(reduced)await p.locator('#reduced').check();
  await p.evaluate(async()=>{
   const {ScenePlayer}=await import('./js/ui/scene-player.js'),draw=ScenePlayer.prototype.draw,actor=ScenePlayer.prototype.drawActor;
   window.labels={frames:[],actors:[]};
   ScenePlayer.prototype.drawActor=function(ctx,p,key,x,y,height,silhouette,face,labelWidth){
    const fallback=p.role==='GK'?(p.team==='A'?'keeper-ready':'keeper-green-ready'):p.team==='A'?'striker-ready':'defender-ready';
    if(!this.images[key])key=fallback;
    let box={left:x-height*.16,right:x+height*.16,top:y-height,bottom:y};
    const meta=this.manifest.assets[key];
    if(this.images[key]){
     const b=meta.contentBounds,anchor=meta.anchors?.ground?.point??meta.anchors?.groundProjection?.point??[(b[0]+b[2])/2,b[3]],f=Math.min(height/(b[3]-b[1]),height*1.1/(b[2]-b[0])),flip=meta.facing==='left'?-1:1;
     const xs=[x+(b[0]-anchor[0])*f*flip,x+(b[2]-anchor[0])*f*flip];
     box=face?{left:x-height/2,right:x+height/2,top:y-height,bottom:y}:{left:Math.min(...xs),right:Math.max(...xs),top:y+(b[1]-anchor[1])*f,bottom:y+(b[3]-anchor[1])*f};
    }
    const fill=ctx.fillRect;let label=null;
    ctx.fillRect=function(x,y,w,h){if(String(this.fillStyle).startsWith('rgba(16, 30, 43')&&(h===24||h===36))label={left:x,right:x+w,top:y,bottom:y+h};return fill.call(this,x,y,w,h);};
    const result=actor.call(this,ctx,p,key,x,y,height,silhouette,face,labelWidth);ctx.fillRect=fill;
    window.labels.actors.push({id:p.id,key,box,label,height,silhouette:!!silhouette});return result;
   };
   ScenePlayer.prototype.draw=function(frame,reduced){
    window.labels.actors=[];const result=draw.call(this,frame,reduced),actors=structuredClone(window.labels.actors),canvas=this.canvas;
    queueMicrotask(()=>{
     const c=canvas.getBoundingClientRect(),rect=e=>{const r=e.getBoundingClientRect();return {left:r.left-c.left,right:r.right-c.left,top:r.top-c.top,bottom:r.bottom-c.top};};
     window.labels.frames.push({time:performance.now(),cut:frame.cut,kind:frame.kind,t:frame.t,width:c.width,height:c.height,actors,hud:[...document.querySelectorAll('.stage-top span')].filter(e=>getComputedStyle(e).display!=='none').map(rect),caption:rect(document.getElementById('caption'))});
    });return result;
   };
  });
  if(outcome)await p.clock.runFor(50);
  else if(scenario==='match'){
   await p.locator('#begin').click();
   for(const [ms,cut]of [[1000,'run'],[900,'wide'],[1000,'choose'],[1500,'face'],[1500,'command-wide'],[5300,null]]){await p.clock.runFor(ms);if(!reduced&&cut)await p.screenshot({path:out+`/${width}-${cut}.png`});}
  }
  else{
   await p.locator('#pause').click();await p.locator('[data-card="'+(scenario==='delay_drop_7'?'delay_drop':scenario)+'"]').click();
   if(scenario.startsWith('delay_drop')&&!reduced){await p.clock.runFor(950);await p.screenshot({path:out+`/${width}-${scenario}.png`});await p.clock.runFor(3050);}
   else if(scenario==='support_flank'&&!reduced){for(const [ms,cut]of [[700,'movement'],[850,'opponent'],[500,'ours'],[1100,'result'],[420,'ADVANCE'],[430,null]]){await p.clock.runFor(ms);if(cut)await p.screenshot({path:out+`/${width}-${cut}.png`});}}
   else await p.clock.runFor(4000);
  }
  const frames=await p.evaluate(()=>labels.frames);for(const f of frames){f.scenario=scenario;f.reduced=reduced;f.viewport=width;}
  report.frames.push(...frames);
  if(!reduced&&(outcome||scenario==='screen_middle'))await p.screenshot({path:out+`/${width}-${scenario}.png`});
  await p.close();
 }
 const overlaps=(a,b)=>a.left<b.right-.01&&a.right>b.left+.01&&a.top<b.bottom-.01&&a.bottom>b.top+.01;
 for(const f of report.frames){const labels=f.actors.filter(a=>a.label);
  if(f.cut==='movement')for(const a of f.actors)if(overlaps(a.box,f.caption))report.failures.push({viewport:f.viewport,scenario:f.scenario,reduced:f.reduced,cut:f.cut,t:f.t,id:a.id,problems:['actor-caption']});
  for(const a of labels){const l=a.label,problems=[];
  if(l.left<0||l.top<0||l.right>f.width||l.bottom>f.height)problems.push('canvas');
  if(f.actors.some(b=>overlaps(l,b.box)))problems.push('actor');
  if(f.hud.some(h=>overlaps(l,h)))problems.push('hud');
  if(overlaps(l,f.caption))problems.push('caption');
  if(labels.some(b=>a!==b&&overlaps(l,b.label)))problems.push('label');
  if(problems.length)report.failures.push({viewport:f.viewport,scenario:f.scenario,reduced:f.reduced,cut:f.cut,t:f.t,id:a.id,label:l,problems});
 }}
 for(const width of widths)for(const cut of ['choose','run','wide','face','movement','opponent','ours','result','ADVANCE']){
  const frames=report.frames.filter(f=>f.viewport===width&&f.cut===cut&&f.actors.some(a=>a.label)),failures=report.failures.filter(f=>f.viewport===width&&f.cut===cut);
  report.summary.push({width,cut,frames:frames.length,labels:frames.reduce((n,f)=>n+f.actors.filter(a=>a.label).length,0),maxActors:Math.max(0,...frames.map(f=>f.actors.filter(a=>a.label).length)),failures:failures.length});
 }
 fs.writeFileSync(out+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({mode,summary:report.summary,errors:report.errors,failures:report.failures.slice(0,12)},null,2));
 await browser.close();if(mode==='after'){assert(report.summary.every(s=>s.frames>0));assert(report.summary.filter(s=>s.cut==='movement').every(s=>s.maxActors===7));const run=report.frames.filter(f=>f.viewport===1280&&f.cut==='run'&&!f.reduced).flatMap(f=>f.actors.map(a=>a.height));if(widths.includes(1280))assert(Math.max(...run)-Math.min(...run)<.01,'running height must not bounce');assert.equal(report.errors.length,0);assert.equal(report.failures.length,0);}
})().catch(e=>{console.error(e);process.exit(1)});
