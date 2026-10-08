import { distance, clamp } from '../director/state.js';
const lerp=(a,b,t)=>a+(b-a)*t;
export function interpolate(frame,reduced=false) {
  const t=reduced?(frame.t<.6?0:1):clamp(frame.t/(frame.kind==='FLOW'?1:.6),0,1), from=frame.from,to=frame.to;
  const flying=frame.flight||['AERIAL_PASS','CROSS','SHOT','GOAL','SAVE','MISS'].includes(frame.kind);
  return {...(t<1?from:to),matchSeconds:from.matchSeconds,players:to.players.map((p,i)=>({...p,position:{x:lerp(from.players[i].position.x,p.position.x,t),z:lerp(from.players[i].position.z,p.position.z,t)}})),ball:{...to.ball,ownerId:t<1&&frame.kind!=='FLOW'?null:to.ball.ownerId,mode:t<1&&flying?'AERIAL_PASS':to.ball.mode,x:lerp(from.ball.x,to.ball.x,t),z:lerp(from.ball.z,to.ball.z,t),y:lerp(from.ball.y,to.ball.y,t)+(flying?Math.sin(t*Math.PI)*(['GOAL','SAVE','MISS'].includes(frame.kind)?2:5):0)}};
}
export class ScenePlayer {
  constructor(canvas,radar,onFailure=()=>{}){this.canvas=canvas;this.radar=radar;this.images={};this.manifest={assets:{}};this.failed=[];this.onFailure=onFailure;}
  async load() {
    this.manifest=await (await fetch('assets/director/manifest.json')).json();
    const load=([name,a])=>new Promise(resolve=>{const img=new Image(),timer=setTimeout(resolve,3000);img.onload=()=>{clearTimeout(timer);this.images[name]=img;resolve();};img.onerror=()=>{clearTimeout(timer);this.failed.push(name);this.onFailure(name);resolve();};img.src=a.path;});
    const entries=Object.entries(this.manifest.assets).filter(([,a])=>a.kind!=='card'),first=['stadium-empty','striker-ready','defender-ready','keeper-ready'];
    await Promise.all(entries.filter(([name])=>first.includes(name)).map(load));
    for(const entry of entries.filter(([name])=>!first.includes(name)))void load(entry);
  }
  context(canvas) {const box=canvas.getBoundingClientRect(),dpr=Math.min(2,window.devicePixelRatio||1),w=Math.round(box.width*dpr),h=Math.round(box.height*dpr);if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);return {ctx,w:box.width,h:box.height};}
  draw(frame,reduced=false) {
    const s=interpolate(frame,reduced),{ctx,w,h}=this.context(this.canvas);ctx.clearRect(0,0,w,h);
    const shot=['SHOT','GOAL','SAVE','MISS'].includes(frame.kind),bench=['READY','HALFTIME','REVIEW'].includes(frame.kind);
    const bg=this.images[bench?'stadium-bench':shot?'stadium-goal':'stadium-empty']??this.images['stadium-empty'];if(bg)ctx.drawImage(bg,0,0,w,h);else {ctx.fillStyle='#548349';ctx.fillRect(0,0,w,h);}
    const team=frame.from.possessionTeam,dir=(team==='A'?1:-1)*(s.half===1?1:-1);
    let center=lerp(frame.from.ball.x,frame.to.ball.x,0.5),centerZ=lerp(frame.from.ball.z,frame.to.ball.z,.5);
    const lead=frame.from.players.find(p=>p.id===frame.from.ball.ownerId);
    const rival=frame.from.players.find(p=>frame.actorIds?.includes(p.id)&&p.team!==lead?.team);
    const gap=lead&&rival?distance(lead.position,rival.position):Infinity;
    const close=['FLOW','COMMAND'].includes(frame.kind)&&gap>0.1&&gap<18;
    const travel=distance(frame.from.ball,frame.to.ball),actionCamera=!shot&&['PASS','CROSS','AERIAL_PASS','INTERCEPT','CARRY','TACKLE'].includes(frame.kind)&&travel>.5;
    let axis=actionCamera?{x:(frame.to.ball.x-frame.from.ball.x)/travel,z:(frame.to.ball.z-frame.from.ball.z)/travel}:close?{x:(rival.position.x-lead.position.x)/gap,z:(rival.position.z-lead.position.z)/gap}:{x:dir,z:0};
    let span=actionCamera?Math.max(12,travel*2):close?Math.max(15,gap*3):68;
    if(['INTERCEPT','TACKLE'].includes(frame.kind)){
      const a=frame.to.players.find(p=>p.id===frame.from.ball.ownerId),b=frame.to.players.find(p=>p.id===frame.to.ball.ownerId),gap=distance(a.position,b.position);
      if(gap>.5){axis={x:(b.position.x-a.position.x)/gap,z:(b.position.z-a.position.z)/gap};span=Math.max(8,gap*2.5);center=(a.position.x+b.position.x)/2;centerZ=(a.position.z+b.position.z)/2;}
    }
    const project=p=>{
      if(shot){const progress=(p.x*dir-frame.from.ball.x*dir)/Math.max(6,52.5-frame.from.ball.x*dir);return {x:w*clamp(.13+progress*.70+p.z*.014,.04,.96),y:h*(.73-progress*.25)};}
      return {x:w*(.40+((p.x-center)*axis.x+(p.z-centerZ)*axis.z)/span),y:h*(.66+(-(p.x-center)*axis.z+(p.z-centerZ)*axis.x)/160)};
    };
    const pass=['PASS','CROSS','AERIAL_PASS','INTERCEPT'].includes(frame.kind);
    const actors=s.players.filter(p=>(!pass&&frame.actorIds?.includes(p.id))||p.id===frame.from.ball.ownerId||p.id===frame.to.ball.ownerId);
    for(const p of s.players.filter(p=>p.role!=='GK').sort((a,b)=>distance(a.position,s.ball)-distance(b.position,s.ball))) if(actors.length<2&&!actors.some(q=>q.id===p.id))actors.push(p);
    actors.sort((a,b)=>project(a.position).y-project(b.position).y);
    for(const p of bench?[]:actors.slice(0,6)) {
      const pos=project(p.position),scale=clamp(pos.y/h,.45,.88),height=h*(.30+scale*.34);
      const originCarrier=p.id===frame.from.ball.ownerId,moving=distance(frame.from.players.find(q=>q.id===p.id).position,p.position)>.4;
      let key=p.role==='GK'?(p.team==='A'?'keeper-ready':'keeper-green-ready'):p.team==='A'?'striker-ready':'defender-ready';
      if(p.role==='GK'&&shot&&frame.t>.25&&frame.kind!=='MISS')key=p.team==='A'?'keeper-dive-yellow':'keeper-dive-green';
      else if(p.role!=='GK'){
        const prefix=p.team==='A'?'striker':'defender';
        if(originCarrier&&(shot||['PASS','CROSS','AERIAL_PASS','INTERCEPT'].includes(frame.kind)))key=prefix+'-kick';
        else if((frame.eventTypes?.includes('BEATEN')&&p.team!==team&&frame.t>.5)||(frame.kind==='TACKLE'&&originCarrier&&frame.t>.5))key=prefix+'-recover';
        else if(moving&&!reduced)key=prefix+'-run';
      }
      const image=this.images[key]??this.images[p.role==='GK'?'keeper-ready':p.team==='A'?'striker-ready':'defender-ready'];
      if(pos.x<-100||pos.x>w+100)continue;
      ctx.fillStyle='#16382755';ctx.beginPath();ctx.ellipse(pos.x,pos.y,34*height/200,8,0,0,Math.PI*2);ctx.fill();
      let labelX=pos.x,labelTop=pos.y-height*.9;
      if(image){const meta=this.manifest.assets[key],bounds=meta?.contentBounds??[0,0,image.naturalWidth,image.naturalHeight];
        const catchPose=key.includes('dive')&&frame.kind==='SAVE';
        const anchor=(catchPose?meta?.anchors?.gloveContact?.point:null)??meta?.anchors?.ground?.point??meta?.anchors?.groundProjection?.point??[image.naturalWidth/2,image.naturalHeight*.95];
        const dive=key.includes('dive'),factor=dive?height*1.25/(bounds[2]-bounds[0]):height/(bounds[3]-bounds[1]);
        const sourceFacing=meta?.facing??(p.team==='A'&&p.role!=='GK'?'right':'left'),facing=p.team===team?'right':'left';
        const sign=sourceFacing!==facing?-1:1,drawY=pos.y-(catchPose?clamp(h*.024,7,14)+frame.to.ball.y*h*.03:0);
        labelX=pos.x+((bounds[0]+bounds[2])/2-anchor[0])*factor*sign;labelTop=drawY+(bounds[1]-anchor[1])*factor;
        ctx.save();ctx.translate(pos.x,drawY);ctx.scale(sign,1);ctx.drawImage(image,-anchor[0]*factor,-anchor[1]*factor,image.naturalWidth*factor,image.naturalHeight*factor);ctx.restore();}
      else {ctx.fillStyle=p.team==='A'?'#247bea':'#c83c43';ctx.fillRect(pos.x-15,pos.y-height*.7,30,height*.7);}
      const labelY=Math.max(48,labelTop-23);ctx.font='bold 12px system-ui';ctx.textAlign='center';ctx.fillStyle='#101e2bdb';ctx.fillRect(labelX-24,labelY,48,19);ctx.fillStyle='#fff';ctx.fillText(`${p.team==='A'?'청해':'홍림'} ${p.number}`,labelX,labelY+14);
    }
    if(bench||frame.kind==='TACTIC')for(const [i,color] of ['blue','red'].entries()){
      const img=this.images[`coach-${color}-${frame.kind==='TACTIC'?'command':'watch'}`];
      if(img){const height=h*(bench?.44:.22),width=height*img.naturalWidth/img.naturalHeight;ctx.drawImage(img,w*(i?.93:.07)-width/2,h*.88-height,width,height);}
    }
    if(bench){this.drawRadar(s,frame);return s;}
    const b=project(s.ball),radius=clamp(h*.024,7,14);ctx.fillStyle='#162e2a60';ctx.beginPath();ctx.ellipse(b.x,b.y,radius*1.1,radius*.35,0,0,Math.PI*2);ctx.fill();
    ctx.save();ctx.translate(b.x,b.y-radius-s.ball.y*h*.03);ctx.rotate(frame.t*5);ctx.fillStyle='#fffbed';ctx.strokeStyle='#142332';ctx.lineWidth=2;ctx.beginPath();ctx.arc(0,0,radius,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillStyle='#17222e';ctx.beginPath();for(let i=0;i<5;i++){const a=i*Math.PI*2/5;ctx.lineTo(Math.cos(a)*radius*.47,Math.sin(a)*radius*.47);}ctx.closePath();ctx.fill();ctx.restore();
    this.drawRadar(s,frame); return s;
  }
  drawRadar(s,frame) {
    const {ctx,w,h}=this.context(this.radar),pad=12,project=p=>({x:pad+(p.x+52.5)/105*(w-pad*2),y:pad+(p.z+34)/68*(h-pad*2)});
    ctx.fillStyle='#25523e';ctx.fillRect(0,0,w,h);ctx.strokeStyle='#b9d2b788';ctx.lineWidth=1;ctx.strokeRect(pad,pad,w-pad*2,h-pad*2);ctx.beginPath();ctx.moveTo(w/2,pad);ctx.lineTo(w/2,h-pad);ctx.stroke();ctx.beginPath();ctx.ellipse(w/2,h/2,16,12,0,0,Math.PI*2);ctx.stroke();ctx.strokeRect(pad,h*.27,27,h*.46);ctx.strokeRect(w-pad-27,h*.27,27,h*.46);
    for(const p of s.players){const xy=project(p.position);ctx.fillStyle=p.team==='A'?'#69a4ff':'#ff7979';ctx.beginPath();if(p.team==='A')ctx.arc(xy.x,xy.y,3.8,0,Math.PI*2);else{ctx.moveTo(xy.x,xy.y-5);ctx.lineTo(xy.x+5,xy.y);ctx.lineTo(xy.x,xy.y+5);ctx.lineTo(xy.x-5,xy.y);ctx.closePath();}ctx.fill();if(frame.actorIds?.includes(p.id)){ctx.strokeStyle='#fff0b3';ctx.stroke();}}
    const b=project(s.ball);ctx.fillStyle='#fffbdc';ctx.beginPath();ctx.arc(b.x,b.y,2.7,0,Math.PI*2);ctx.fill();
  }
}
