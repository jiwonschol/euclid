import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
import {DirectorMatch} from '../js/director/match.js';
import {CARDS,command,cardButtonReason} from '../js/director/cards.js';
import {stats} from '../js/director/resolve.js';
import {distance,direction} from '../js/director/state.js';
import {interpolate} from '../js/ui/scene-player.js';
import {fixtureGame,FIXTURES,outcomeGame} from '../js/director/fixtures.js';

// Run the real main.js handlers and animation loop with a small DOM adapter.
// The match, card legality, timing, and projection are production modules.
const source=(await readFile(new URL('../js/director/main.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
const rules=JSON.parse(await readFile(new URL('../data/director/rules.json',import.meta.url)));
async function screen(snapshot=null){
 const elements=new Map(),frames=[],storage=new Map(snapshot?[['euclid-director-1',snapshot]]:[]);
 let nextFrame,now=0;
 class Element {
  constructor(){this.children=[];this.dataset={};this.value='wing';this.classList={toggle(){}};}
  replaceChildren(...children){this.children=children;}
  append(child){this.children.push(child);}
  setAttribute(key,value){this[key]=value;}
  querySelector(selector){return selector==='img'&&this.innerHTML?.includes('<img')?new Element():null;}
  click(){this.onclick?.();}
 }
 const document={getElementById(id){if(!elements.has(id))elements.set(id,new Element());return elements.get(id);},createElement(){return new Element();},addEventListener(){}};
 class ScenePlayer {
  constructor(){this.manifest={assets:new Proxy({},{get:()=>({path:'test.webp'})})};}
  async load(){}
  draw(frame,reduced){frames.push({kind:frame.kind,cut:frame.cut,text:frame.text});return interpolate(frame,reduced);}
 }
 await runInNewContext(`(async()=>{${source}\n})()`,{
  DirectorMatch,CARDS,command,cardButtonReason,stats,distance,direction,ScenePlayer,fixtureGame,FIXTURES,outcomeGame,
  document,location:{search:''},URLSearchParams,crypto:webcrypto,console,
  fetch:async()=>({ok:true,json:async()=>rules}),localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},
  performance:{now:()=>now},matchMedia:()=>({matches:false}),requestAnimationFrame:fn=>{nextFrame=fn;}
 });
 return {elements,frames,record:()=>JSON.parse(storage.get('euclid-director-1')),step(ms=10){now+=ms;const fn=nextFrame;nextFrame=null;assert(fn,'animation loop must schedule its next frame');fn(now);}};
}

for(const phase of ['FLOW','COMMAND','HALFTIME']){
 const game=new DirectorMatch(rules,42);
 while(game.phase!==phase)game.advancePhase();
 const ui=await screen(game.snapshot());
 ui.elements.get('pause').click(); // Restored screens start paused.
 ui.step();
 const card=phase==='HALFTIME'?'screen_middle':'support_flank';
 ui.elements.get('cards').children.find(e=>e.dataset.card===card).click();
 assert.equal(ui.record().phase,'PRESENT',`${phase} click must immediately commit`);
 assert.equal(ui.record().inputLog.at(-1).command.id,card);
 const count=ui.record().records.length;
 ui.elements.get('cards').children.find(e=>e.dataset.card===card).click();
 assert.equal(ui.record().records.length,count,'duplicate click must not resolve again');
 ui.frames.length=0;
 for(let i=0;i<400;i++){ui.step();if(ui.frames.at(-1).kind==='FLOW')break;}
 const cuts=ui.frames.map(f=>f.cut).filter((cut,i,a)=>i===0||cut!==a[i-1]);
 assert.deepEqual(cuts,['directive','movement','opponent','ours','ball','result','ADVANCE','run'],`${phase} must execute the full montage and return to running`);
 assert.match(ui.frames[0].text,new RegExp(CARDS[card].name));
 console.log(`PASS main.js ${phase} click → directive → movement → opponent → ours → ball → result → running`);
}
