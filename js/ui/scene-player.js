import { distance, clamp } from '../director/state.js';
const lerp=(a,b,t)=>a+(b-a)*t;
export function interpolate(frame,reduced=false) {
  const t=reduced?(frame.t<.6?0:1):clamp(frame.t/(frame.kind==='FLOW'?1:.6),0,1), from=frame.from,to=frame.to;
  const flying=frame.flight||['AERIAL_PASS','CROSS','SHOT','GOAL','SAVE','MISS'].includes(frame.kind);
  const travelling=from!==to;
  return {...(t<1?from:to),matchSeconds:frame.displaySeconds??from.matchSeconds,players:to.players.map((p,i)=>({...p,position:{x:lerp(from.players[i].position.x,p.position.x,t),z:lerp(from.players[i].position.z,p.position.z,t)}})),ball:{...to.ball,ownerId:t<1&&travelling&&frame.kind!=='FLOW'?null:to.ball.ownerId,mode:t<1&&travelling&&flying?'AERIAL_PASS':to.ball.mode,x:lerp(from.ball.x,to.ball.x,t),z:lerp(from.ball.z,to.ball.z,t),y:lerp(from.ball.y,to.ball.y,t)+(travelling&&flying?Math.sin(t*Math.PI)*(['GOAL','SAVE','MISS'].includes(frame.kind)?2:5):0)}};
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
  drawActor(ctx,p,key,x,y,height,silhouette=false,face=false) {
    const fallback=p.role==='GK'?(p.team==='A'?'keeper-ready':'keeper-green-ready'):p.team==='A'?'striker-ready':'defender-ready';
    if(!this.images[key])key=fallback;
    const img=this.images[key],meta=this.manifest.assets[key];let contact=null;
    ctx.save();
    if(img){
      const b=meta.contentBounds,anchor=meta.anchors?.ground?.point??meta.anchors?.groundProjection?.point??[(b[0]+b[2])/2,b[3]];
      if(face){
        const size=Math.min(b[2]-b[0],(b[3]-b[1])*.32);
        ctx.drawImage(img,(b[0]+b[2]-size)/2,b[1],size,size,x-height/2,y-height,height,height);
      }else{
        const factor=Math.min(height/(b[3]-b[1]),height*1.1/(b[2]-b[0]));
        const flip=meta.facing==='left'?-1:1;
        const glove=key.includes('dive')?meta.anchors?.gloveContact?.point:null;
        if(glove)contact={x:x+(glove[0]-anchor[0])*factor*flip,y:y+(glove[1]-anchor[1])*factor};
        ctx.translate(x,y);ctx.scale(flip,1);
        ctx.drawImage(img,-anchor[0]*factor,-anchor[1]*factor,img.naturalWidth*factor,img.naturalHeight*factor);
      }
      if(silhouette){ctx.globalCompositeOperation='source-atop';ctx.fillStyle='#07111cf5';ctx.fillRect(-2000,-2000,4000,4000);}
    }else{
      ctx.fillStyle=silhouette?'#07111c':p.team==='A'?'#247bea':'#c83c43';
      ctx.fillRect(x-height*.16,y-height,height*.32,height);
    }
    ctx.restore();
    if(!silhouette){
      ctx.font='bold 14px system-ui';ctx.textAlign='center';ctx.fillStyle='#101e2be8';ctx.fillRect(x-43,y-34,86,24);
      ctx.fillStyle='#fff';ctx.fillText(`${p.team==='A'?'청해':'홍림'} ${p.number}번`,x,y-17);
    }
    return contact;
  }
  drawBall(ctx,x,y,radius,t) {
    ctx.save();ctx.translate(x,y);ctx.rotate(t*5);ctx.fillStyle='#fffbed';ctx.strokeStyle='#142332';ctx.lineWidth=2;
    ctx.beginPath();ctx.arc(0,0,radius,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillStyle='#17222e';ctx.beginPath();
    for(let i=0;i<5;i++){const a=i*Math.PI*2/5;ctx.lineTo(Math.cos(a)*radius*.47,Math.sin(a)*radius*.47);}
    ctx.closePath();ctx.fill();ctx.restore();
  }
  draw(frame,reduced=false) {
    const s=interpolate(frame,reduced),{ctx,w,h}=this.context(this.canvas),cut=frame.cut??frame.kind;
    ctx.clearRect(0,0,w,h);
    const bench=['READY','HALFTIME','REVIEW'].includes(frame.kind),shot=['GOAL','SAVE','MISS'].includes(frame.kind);
    const bg=this.images[bench?'stadium-bench':shot&&cut==='result'?'stadium-goal':'stadium-empty']??this.images['stadium-empty'];
    const running=frame.kind==='FLOW',offset=running&&!reduced?-frame.t*w*.18:0;
    if(bg){if(cut==='result'&&frame.kind==='GOAL')ctx.drawImage(bg,bg.naturalWidth*.67,bg.naturalHeight*.30,bg.naturalWidth*.33,bg.naturalHeight*.40,0,0,w,h);else ctx.drawImage(bg,offset,0,w,h);if(offset)ctx.drawImage(bg,offset+w,0,w,h);}
    else{ctx.fillStyle='#548349';ctx.fillRect(0,0,w,h);}
    if(cut==='ball'){
      ctx.fillStyle='#437fa8';ctx.fillRect(0,0,w,h);
      ctx.fillStyle='#d5ebeb55';for(let i=0;i<5;i++)ctx.fillRect(((i*.26-(reduced?0:frame.t)*.1+1)%1)*w,h*(.15+i*.09),w*.18,8);
    }
    if(['opponent','ours','movement','face'].includes(cut)&&!reduced){
      ctx.strokeStyle='#fff4c754';ctx.lineWidth=2;
      for(let i=0;i<16;i++){const y=((i/16+frame.t*.22)%1)*h;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y-h*.12);ctx.stroke();}
    }
    const lead=s.players.find(p=>p.id===frame.from.ball.ownerId);
    const ids=frame.actorIds??[],players=ids.map(id=>s.players.find(p=>p.id===id)).filter(Boolean);
    const choose=frame.kind==='COMMAND';
    let actors=bench||cut==='directive'||cut==='ball'?[]:cut==='movement'?players:choose?[lead].filter(Boolean):running?[lead].filter(Boolean):cut==='result'?[s.players.find(p=>p.id===s.ball.ownerId)??players[0]].filter(Boolean):players.slice(0,1);
    if(cut==='result'&&frame.kind==='GOAL')actors=[];
    let catchPoint=null;
    for(const [i,p] of actors.entries()){
      const prefix=p.team==='A'?'striker':'defender',wide=cut==='wide',face=cut==='face';
      let key=p.role==='GK'?(p.team==='A'?'keeper-ready':'keeper-green-ready'):prefix+'-ready';
      if(p.role==='GK'&&cut==='result'&&frame.kind==='SAVE')key=p.team==='A'?'keeper-dive-yellow':'keeper-dive-green';
      else if(p.role!=='GK'){
        if(running||cut==='movement'||cut==='opponent')key=prefix+'-run';
        if(['ours','opponent'].includes(cut))key=prefix+(frame.attackingActor&&['PASS','AERIAL_PASS','CROSS','INTERCEPT','GOAL','SAVE','MISS'].includes(frame.kind)?'-kick':'-run');
      }
      const height=Math.min(h*(wide?.38:face?.52:.68),w/(actors.length>1?actors.length*1.25:1.1)),x=w*(actors.length>1?(i+.5)/actors.length:choose?.40:.5);
      const bounce=running&&!reduced?Math.sin(frame.t*Math.PI*12)*h*.009:0;
      catchPoint=this.drawActor(ctx,p,key,x,h*.81+bounce,height,false,face)??catchPoint;
    }
    if(choose&&players[1]) {
      // Tint only the actor on an isolated canvas; source-atop on the stage would tint the whole background.
      const layer=this.silhouette??=document.createElement('canvas');layer.width=Math.ceil(w);layer.height=Math.ceil(h);
      this.drawActor(layer.getContext('2d'),players[1],players[1].team==='A'?'striker-ready':'defender-ready',w*.72,h*.94,h*.7,true);
      ctx.drawImage(layer,0,0);
    }
    if(cut==='directive'){
      ctx.fillStyle='#0a172bcc';ctx.fillRect(0,h*.23,w,h*.51);
    }
    if(cut==='ball'){const t=reduced?1:frame.t;this.drawBall(ctx,w*(.25+t*.5),h*(.55-Math.sin(t*Math.PI)*.17),h*.14,reduced?0:frame.t);}
    else if(cut==='result'&&frame.kind==='GOAL')this.drawBall(ctx,w*(.46+s.ball.z*.055),h*(.425-s.ball.y*.084),h*.045,0);
    else if(cut==='result'&&frame.kind==='SAVE'&&catchPoint)this.drawBall(ctx,catchPoint.x,catchPoint.y,clamp(h*.024,7,14),0);
    else if(!bench&&cut!=='directive'&&cut!=='movement'&&cut!=='face'){
      const radius=clamp(h*.024,7,14);
      this.drawBall(ctx,w*(choose?.44:.55),h*.8-radius,radius,reduced?0:frame.t);
    }
    if(bench)for(const [i,color] of ['blue','red'].entries()){
      const img=this.images[`coach-${color}-watch`];if(img){const height=h*.44,width=height*img.naturalWidth/img.naturalHeight;ctx.drawImage(img,w*(i?.85:.15)-width/2,h*.9-height,width,height);}
    }
    if(!reduced&&cut==='ours'&&frame.t<.12){ctx.fillStyle='#fff8d82e';ctx.fillRect(0,0,w,h);}
    this.canvas.dataset.cut=cut;
    this.canvas.dataset.actors=actors.map(p=>p.id).join(',');
    this.canvas.dataset.silhouette=choose?(players[1]?.id??''):'';
    this.drawRadar(s,frame);return s;
  }
  drawRadar(s,frame) {
    const {ctx,w,h}=this.context(this.radar),pad=12,project=p=>({x:pad+(p.x+52.5)/105*(w-pad*2),y:pad+(p.z+34)/68*(h-pad*2)});
    ctx.fillStyle='#25523e';ctx.fillRect(0,0,w,h);ctx.strokeStyle='#b9d2b788';ctx.lineWidth=1;ctx.strokeRect(pad,pad,w-pad*2,h-pad*2);ctx.beginPath();ctx.moveTo(w/2,pad);ctx.lineTo(w/2,h-pad);ctx.stroke();ctx.beginPath();ctx.ellipse(w/2,h/2,16,12,0,0,Math.PI*2);ctx.stroke();ctx.strokeRect(pad,h*.27,27,h*.46);ctx.strokeRect(w-pad-27,h*.27,27,h*.46);
    for(const p of s.players){const xy=project(p.position);ctx.fillStyle=p.team==='A'?'#69a4ff':'#ff7979';ctx.beginPath();if(p.team==='A')ctx.arc(xy.x,xy.y,3.8,0,Math.PI*2);else{ctx.moveTo(xy.x,xy.y-5);ctx.lineTo(xy.x+5,xy.y);ctx.lineTo(xy.x,xy.y+5);ctx.lineTo(xy.x-5,xy.y);ctx.closePath();}ctx.fill();if(frame.actorIds?.includes(p.id)){ctx.strokeStyle='#fff0b3';ctx.stroke();}}
    const b=project(s.ball);ctx.fillStyle='#fffbdc';ctx.beginPath();ctx.arc(b.x,b.y,2.7,0,Math.PI*2);ctx.fill();
  }
}
