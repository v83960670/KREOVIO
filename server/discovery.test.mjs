import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool,migrate } from './db.mjs';
import { buildAnalysis } from './analyze.mjs';
import { discoverCandidates,storeObservations,historySeries,enrichHistory } from './discovery.mjs';
import { createCollectionQueue,trackTopic,reserveProviderBudget } from './collection-queue.mjs';
import { allowRequest,assertProductionConfig } from './runtime.mjs';

const now=Date.parse('2026-10-04T12:00:00Z');
const input={query:'Fitness',country:'IN',language:'en',source:'all',timeWindow:'1h',mode:'discover'};
const signal=(source,title,id='1')=>({source,title,topic:title,sourceId:id,timestamp:new Date(now-60000).toISOString(),collectedAt:new Date(now).toISOString(),metric:'score',metricValue:12,publisherId:`${source}:${id}`,reference:`https://example.test/${source}/${id}`});
const source=(id,signals,at=now)=>({id,name:id,status:'CONNECTED',signals,series:[],freshness:{lastSuccessAt:new Date(at).toISOString()}});

test('discovery names are real evidence spans; new niches withhold acceleration and score',()=>{
 const sources=[source('youtube',[signal('youtube','Zone two training for runners','1'),signal('youtube','Zone two training outdoors','2')])];
 const candidates=discoverCandidates(sources,input);
 assert.ok(candidates.some(c=>c.name==='Zone two training'));
 const analysis=buildAnalysis({...input,sourceResults:sources,now});
 assert.equal(analysis.results.length,0);
 assert.ok(analysis.observations.length>0);
 for(const item of analysis.observations){assert.equal(item.acceleration,null);assert.equal(item.score,null);assert.equal(item.historyStatus,'INSUFFICIENT_HISTORY');}
});

test('repeated collections build scoped history; duplicates and gaps do not create acceleration',async()=>{
 const pool=await createPool({memory:true}); await migrate(pool);
 try {
 const targeted={...input,query:'Zone two training',mode:'analyze'};
 for(let i=0;i<5;i++){
   const at=now-(5-i)*3600000;
   const evidence=Array.from({length:12+i*15},(_,j)=>signal('youtube',`Zone two training ${String.fromCharCode(65+j)} ${j*j}`,String(j)));
   await storeObservations(pool,targeted,[source('youtube',evidence,at)],[],at);
 }
 let series=await historySeries(pool,targeted,targeted.query,'youtube',now);
 assert.equal(series[0].points.length,5);
 const enriched=await enrichHistory(pool,targeted,[source('youtube',[])],[],now);
 const assessed=buildAnalysis({...targeted,sourceResults:enriched,now});
 assert.notEqual((assessed.topicAssessment ?? assessed.results[0]).acceleration,null);
 assert.equal((await historySeries(pool,{...targeted,country:'US'},targeted.query,'youtube',now)).length,0);
 assert.equal((await historySeries(pool,{...targeted,query:'Fitness'},targeted.query,'youtube',now)).length,0);
 await pool.query(`DELETE FROM topic_observations WHERE bucket_at=$1`,[new Date(now-3*3600000).toISOString()]);
 const gaps=await enrichHistory(pool,targeted,[source('youtube',[])],[],now);
 const incomplete=buildAnalysis({...targeted,sourceResults:gaps,now});
 assert.equal(incomplete.results.length,0);
 assert.equal(incomplete.topicAssessment?.acceleration ?? null,null);
 } finally {await pool.end();}
});

test('YouTube and Reddit confirm a matching historical cluster; syndicated news remains one family',()=>{
 const points=[20,22,25,30,60,100].map((value,i)=>({t:new Date(now-(6-i)*3600000).toISOString(),value}));
 const news=source('news',Array.from({length:100},(_,i)=>signal('news','Zone two training grows nationwide',String(i))));
 news.series=[{label:'Zone two training',metric:'article_count',unit:'articles',points}];
 const result=buildAnalysis({query:'Zone two training',timeWindow:'1h',now,sourceResults:[news,
 source('youtube',[signal('youtube','Coaches explain Zone two training technique')]),source('reddit',[signal('reddit','Athletes discuss Zone two training recovery')]) ]});
 const item=result.results[0] ?? result.topicAssessment;
 assert.equal(item.independentSources,3);
 assert.equal(item.duplicateCount,99);
 assert.ok(item.sources.includes('youtube'));assert.ok(item.sources.includes('reddit'));
 const unrelated=buildAnalysis({query:'Zone two training',timeWindow:'1h',now,sourceResults:[news,source('reddit',[signal('reddit','Weight lifting contest')])]});
 assert.equal((unrelated.results[0] ?? unrelated.topicAssessment).independentSources,1);
});

test('queue prioritizes saved topics, leases exclude duplicate claims, and budgets and rate limits are shared',async()=>{
 const pool=await createPool({memory:true});await migrate(pool);
 try {
 await trackTopic(pool,{...input,query:'recent'},'recent',30);
 await trackTopic(pool,{...input,query:'saved'},'saved',90);
 const queue=createCollectionQueue(pool);
 const job=await queue.claim(); assert.equal(job.input.query,'saved');
 assert.equal((await queue.claim()).input.query,'recent');assert.equal(await queue.claim(),null);
 await queue.finish(job,'UNAVAILABLE');
 assert.equal(await queue.claim(),null);
 process.env.PROVIDER_DAILY_CALLS_SEARCH='4';
 assert.equal(await reserveProviderBudget(pool,'search'),true);assert.equal(await reserveProviderBudget(pool,'search'),false);
 delete process.env.PROVIDER_DAILY_CALLS_SEARCH;
 assert.equal(await allowRequest(pool,'user',1),true);assert.equal(await allowRequest(pool,'user',1),false);
 assert.throws(()=>assertProductionConfig({NODE_ENV:'production'}),/DATABASE_URL/);
 } finally {await pool.end();}
});

test('all requested windows retain real bucket observations without inventing missing buckets',async()=>{
 const pool=await createPool({memory:true});await migrate(pool);
 try {
  for (const [timeWindow,width] of Object.entries({'1h':3600000,'6h':21600000,'24h':86400000,'3d':259200000,'7d':604800000,'30d':2592000000,'90d':7776000000})) {
    const scoped={...input,query:'Rucking',mode:'analyze',timeWindow};
    for (const offset of [4,3,1]) {
      const at=now-width*offset;
      await storeObservations(pool,scoped,[source('reddit',[signal('reddit','Rucking outdoors')],at)],[],at);
    }
    const series=await historySeries(pool,scoped,'Rucking','reddit',now);
    assert.equal(series[0].points.length,3,timeWindow);
    assert.equal(series[0].bucketMs,width);
    assert.ok(series[0].points.every(p=>p.value===1));
    const assessed=buildAnalysis({...scoped,now,sourceResults:[{...source('reddit',[]),series}]});
    assert.equal(assessed.results.length,0);
  }
 } finally {await pool.end();}
});

test('background targeted provider history can graduate a discovered candidate without borrowing category history',async()=>{
 const pool=await createPool({memory:true});await migrate(pool);
 try {
  const targeted={...input,query:'Rucking',mode:'analyze'};
  const search=source('search',[signal('search','Rucking')]);
  search.series=[{label:'Relative interest',metric:'relative_interest',unit:'relative_index',points:[10,12,15,30,60,95].map((value,i)=>({t:new Date(now-(6-i)*3600000).toISOString(),value}))}];
  await storeObservations(pool,targeted,[search],[],now);
  const candidates=[{key:'en:rucking',name:'Rucking',evidence:[signal('search','Rucking')]}];
  const enriched=await enrichHistory(pool,input,[source('search',[])],candidates,now);
  const report=buildAnalysis({...input,now,candidates,sourceResults:enriched});
  assert.equal(report.results[0].name,'Rucking');
  assert.ok(report.results[0].acceleration>0.5);
  assert.equal(report.results[0].historyProvenance.method,'targeted_provider_response');
  assert.equal(report.results[0].metric,'relative_interest');
 } finally {await pool.end();}
});
