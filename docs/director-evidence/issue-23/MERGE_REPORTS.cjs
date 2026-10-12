const fs=require('node:fs'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const root='/home/buzz-hyuncheol/.buzz',repo=root+'/REPOS/euclid/.claude/worktrees/buzz-23';
const head=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),widths=[1280,1920,375,740];
assert.equal(head,'2be9c1883c69180718ab9d9ef9d2a292bdb8f739');
const reports=widths.map(w=>JSON.parse(fs.readFileSync(root+`/.scratch/EUCLID_28_LABELS_after_${w}/report.json`)));
for(const r of reports){assert.equal(r.sourceCommit,head);assert.equal(r.failures.length,0);assert.equal(r.errors.length,0);assert.equal(r.summary.find(s=>s.cut==='movement').maxActors,7);}
const report={mode:'after',sourceCommit:head,frames:reports.flatMap(r=>r.frames),errors:[],failures:[],summary:reports.flatMap(r=>r.summary)};
const baseline=JSON.parse(fs.readFileSync(root+'/.scratch/EUCLID_28_LABELS_before/report.json'));
let preserved=0;
for(const width of [1280,1920,740])for(const reduced of [false,true])for(const scenario of ['support_flank','press_flank','screen_middle','delay_drop','delay_drop_7','run_inside','switch_play']){
 const pick=r=>r.frames.find(f=>f.viewport===width&&f.reduced===reduced&&f.scenario===scenario&&f.cut==='movement');
 const before=pick(baseline),after=pick(report);assert(before&&after);
 const geometry=f=>f.actors.map(({id,key,box,label,height})=>({id,key,box,label,height}));
 assert.deepEqual(geometry(after),geometry(before),`${width} ${scenario} ${reduced}: preserve actors and labels`);preserved++;
}
const run=report.frames.filter(f=>f.viewport===1280&&f.cut==='run'&&!f.reduced).flatMap(f=>f.actors.map(a=>a.height));
assert(Math.max(...run)-Math.min(...run)<.01);
const summary={head,browserRuns:120,frames:report.frames.length,labels:report.frames.reduce((n,f)=>n+f.actors.filter(a=>a.label).length,0),movement:report.summary.filter(s=>s.cut==='movement'),failures:0,errors:0,preservedMovementCases:preserved,runHeight1280:{min:Math.min(...run),max:Math.max(...run)},summary:report.summary};
fs.writeFileSync(root+'/.scratch/EUCLID_28_LABELS_after/report.json',JSON.stringify(report,null,2));
fs.writeFileSync(root+'/.scratch/EUCLID_28_VALIDATION.json',JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary));
