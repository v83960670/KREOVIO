import test from 'node:test';
import assert from 'node:assert/strict';
import { collectYouTube, collectReddit, collectSearchInterest,healthCheckSource } from './sources/adapters.mjs';
import { publicSource,healthSnapshot } from './source-health.mjs';

function setEnv(t,key,value){const old=process.env[key];process.env[key]=value;t.after(()=>{if(old===undefined)delete process.env[key];else process.env[key]=old;});}
function reply(body,status=200){return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});}

test('configured credentials are UNKNOWN until a successful provider response; errors are truthful',async(t)=>{
 t.mock.method(globalThis,'fetch',async()=>reply({items:[]}));
 for(const key of ['YOUTUBE_API_KEY','REDDIT_CLIENT_ID','REDDIT_CLIENT_SECRET','SERPAPI_API_KEY']) setEnv(t,key,'test-only');
 for(const id of ['youtube','reddit','search']) assert.equal((await healthCheckSource(id)).status,'UNKNOWN');
 const ok=await collectYouTube({query:'fitness'});assert.equal(ok.status,'CONNECTED');assert.ok(ok.freshness.lastSuccessAt);
 assert.notEqual(publicSource(ok).liveStatus,'LIVE'); // valid empty response has no timestamped signal
 globalThis.fetch=async()=>reply({error:'invalid key'},401);
 assert.equal((await collectYouTube({query:'fitness'})).status,'AUTHENTICATION_ERROR');
 globalThis.fetch=async()=>reply({error:{errors:[{reason:'quotaExceeded'}]}},403);
 const limited=await collectYouTube({query:'fitness'});assert.equal(limited.status,'RATE_LIMITED');assert.equal(limited.freshness.lastSuccessAt,null);
 globalThis.fetch=async()=>reply({},429);
 assert.equal((await collectReddit({query:'fitness'})).status,'RATE_LIMITED');
 globalThis.fetch=async()=>reply({unexpected:true});
 assert.equal((await collectYouTube({query:'fitness'})).status,'DEGRADED');
});

test('removed credentials override stored success; stale or unknown collection cannot be LIVE',()=>{
 const at=new Date().toISOString();
 const old=new Date(Date.now()-7*86400000).toISOString();
 assert.equal(healthSnapshot({id:'youtube'},{status:'NOT_CONFIGURED'},{status:'CONNECTED',last_success_at:at,latest_signal_at:at}).status,'NOT_CONFIGURED');
 assert.equal(publicSource({id:'youtube',status:'CONNECTED',freshness:{latestSignalAt:at}}).status,'UNKNOWN');
 assert.equal(publicSource({id:'youtube',status:'CONNECTED',freshness:{latestSignalAt:at,lastSuccessAt:old}}).liveStatus,'STALE');
 assert.equal(publicSource({id:'youtube',status:'CONNECTED',freshness:{latestSignalAt:at,lastSuccessAt:at}}).liveStatus,'LIVE');
});

test('search discovery uses actual related and rising responses and relative geography',async(t)=>{
 setEnv(t,'SERPAPI_API_KEY','test-only');
 t.mock.method(globalThis,'fetch',async(url)=>{
 const type=new URL(url).searchParams.get('data_type');
 if(type==='TIMESERIES')return reply({interest_over_time:{timeline_data:[{timestamp:Math.floor(Date.now()/1000),values:[{extracted_value:23}]}]}});
 if(type==='RELATED_QUERIES')return reply({related_queries:{top:[{query:'zone two training',extracted_value:80}],rising:[{query:'rucking',value:'Breakout'}]}});
 if(type==='RELATED_TOPICS')return reply({related_topics:{rising:[{topic:{title:'Walking pad'},value:'200%'}]}});
 return reply({interest_by_region:[{geo:'IN',location:'India',extracted_value:70}]});
 });
 const result=await collectSearchInterest({query:'Fitness',country:'IN',mode:'discover'});
 assert.equal(result.status,'CONNECTED');assert.equal(result.requests,4);
 assert.deepEqual(result.candidates.map(c=>c.name),['zone two training','rucking','Walking pad']);
 assert.equal(result.geographicSeries[0].points[0].value,70);
 assert.equal(result.series[0].unit,'relative_index');
 assert.equal(result.candidates[1].evidence.metricValue,null);
});

test('credential rotation invalidates previous successful health',()=>{
 const at=new Date().toISOString();
 assert.equal(healthSnapshot({id:'youtube'},{status:'UNKNOWN',configHash:'new'},
   {status:'CONNECTED',config_hash:'old',last_success_at:at,latest_signal_at:at}).status,'UNKNOWN');
});
