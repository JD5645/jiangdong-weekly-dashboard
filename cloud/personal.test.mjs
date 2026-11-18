import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { after, test } from 'node:test';
import worker from './worker.mjs';

const originalFetch=globalThis.fetch;
after(()=>{globalThis.fetch=originalFetch;});
const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk=publicKey.export({format:'jwk'});jwk.kid='personal-test';
globalThis.fetch=async input=>{
  assert.equal(new URL(input).hostname,'test.cloudflareaccess.com');
  return Response.json({keys:[jwk]});
};
const users=new Map(),reports=new Map(),files=new Map(),chunks=new Map();
const env={
  ACCESS_TEAM_DOMAIN:'https://test.cloudflareaccess.com',ACCESS_AUD:'owner-audience',USER_ACCESS_AUD:'personal-audience',EDITOR_EMAIL:'owner@example.com',
  ASSETS:{fetch:async()=>new Response('dashboard')},
  DB:{async batch(statements){for(const statement of statements)await statement.run();return statements.map(()=>({meta:{changes:1}}));},prepare(sql){let args=[];return {bind(...values){args=values;return this;},async run(){
    if(sql.startsWith('INSERT OR IGNORE INTO users')){if(!users.has(args[1]))users.set(args[1],{id:args[0],email:args[1]});return {meta:{changes:1}};}
    if(sql.startsWith('INSERT OR IGNORE INTO user_reports')){if(reports.has(args[0]))return {meta:{changes:0}};reports.set(args[0],{data:args[1],revision:1});return {meta:{changes:1}};}
    if(sql.startsWith('UPDATE user_reports')){const row=reports.get(args[1]);if(!row||row.revision!==args[2])return {meta:{changes:0}};reports.set(args[1],{data:args[0],revision:row.revision+1});return {meta:{changes:1}};}
    if(sql.startsWith('INSERT INTO user_files')){files.set(`${args[0]}/${args[1]}`,{mime_type:args[2],size:args[3],chunk_count:args[4]});return {meta:{changes:1}};}
    if(sql.startsWith('INSERT INTO user_file_chunks')){const key=`${args[0]}/${args[1]}`;if(!chunks.has(key))chunks.set(key,[]);chunks.get(key).push({part:args[2],data:args[3]});return {meta:{changes:1}};}
    throw new Error(`Unexpected SQL ${sql}`);
  },async first(){
    if(sql.startsWith('SELECT id,email'))return users.get(args[0])||null;
    if(sql.startsWith('SELECT data,revision'))return reports.get(args[0])||null;
    if(sql.startsWith('SELECT file_key'))return files.has(`${args[0]}/${args[1]}`)?{file_key:args[1]}:null;
    if(sql.startsWith('SELECT mime_type'))return files.get(`${args[0]}/${args[1]}`)||null;
    throw new Error(`Unexpected SQL ${sql}`);
  },async all(){if(sql.startsWith('SELECT part,data'))return {results:chunks.get(`${args[0]}/${args[1]}`)||[]};throw new Error(`Unexpected SQL ${sql}`);}};}}
};
function jwt(email,audience=env.USER_ACCESS_AUD){
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const header=encode({alg:'RS256',kid:jwk.kid});
  const payload=encode({iss:env.ACCESS_TEAM_DOMAIN,aud:[audience],email,exp:Math.floor(Date.now()/1000)+600});
  const value=`${header}.${payload}`;
  return `${value}.${sign('RSA-SHA256',Buffer.from(value),privateKey).toString('base64url')}`;
}
const call=(path,{email,method='GET',body,headers={},audience}={})=>worker.fetch(new Request(`https://dashboard.example${path}`,{
  method,body,headers:{...(email?{'Cf-Access-Jwt-Assertion':jwt(email,audience)}:{}),...headers}
}),env);

test('personal login creates isolated accounts while owner edit remains separate',async()=>{
  assert.equal((await call('/app/')).status,403);
  assert.equal((await call('/api/user/state')).status,403);
  assert.equal((await call('/api/user/state',{email:'alice@example.com',audience:env.ACCESS_AUD})).status,403);
  assert.equal((await call('/editor/',{email:'alice@example.com'})).status,403);
  assert.equal((await call('/app/',{email:'alice@example.com'})).status,200);
  const alice=await (await call('/api/user/state',{email:'alice@example.com'})).json();
  assert.deepEqual(alice.reports,{});
  assert.equal(alice.sha,'0');
  const data={'week:2026-11-16':{work:[{title:'Alice report',attachments:[]}]}};
  const save=await call('/api/user/state',{email:'alice@example.com',method:'PUT',body:JSON.stringify({sha:'0',reports:data}),headers:{Origin:'https://dashboard.example','Content-Type':'application/json'}});
  assert.equal(save.status,200,await save.clone().text());
  assert.equal((await save.json()).sha,'1');
  const bob=await (await call('/api/user/state',{email:'bob@example.com'})).json();
  assert.deepEqual(bob.reports,{});
  assert.equal((await (await call('/api/user/state',{email:'alice@example.com'})).json()).reports['week:2026-11-16'].work[0].title,'Alice report');
  const stale=await call('/api/user/state',{email:'alice@example.com',method:'PUT',body:JSON.stringify({sha:'0',reports:data}),headers:{Origin:'https://dashboard.example','Content-Type':'application/json'}});
  assert.equal(stale.status,409);
});

test('attachments remain private and require same-origin writes',async()=>{
  const key='11111111-1111-4111-8111-111111111111.pdf';
  const path=`/api/user/attachments/${key}`;
  const denied=await call(path,{email:'bob@example.com',method:'PUT',body:'secret',headers:{Origin:'https://attacker.example'}});
  assert.equal(denied.status,403);
  const saved=await call(path,{email:'bob@example.com',method:'PUT',body:'%PDF-1.7',headers:{Origin:'https://dashboard.example','Content-Type':'application/pdf'}});
  assert.equal(saved.status,201);
  assert.equal((await call(path,{email:'alice@example.com'})).status,404);
  const own=await call(path,{email:'bob@example.com'});
  assert.equal(own.status,200);
  assert.equal(await own.text(),'%PDF-1.7');
});

test('large attachments survive chunking and duplicate keys are rejected',async()=>{
  const key='22222222-2222-4222-8222-222222222222.xlsx';
  const path=`/api/user/attachments/${key}`;
  const content=Buffer.alloc(900000);for(let index=0;index<content.length;index++)content[index]=index%251;
  const saved=await call(path,{email:'alice@example.com',method:'PUT',body:content,headers:{Origin:'https://dashboard.example','Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}});
  assert.equal(saved.status,201,await saved.clone().text());
  const duplicate=await call(path,{email:'alice@example.com',method:'PUT',body:content,headers:{Origin:'https://dashboard.example'}});
  assert.equal(duplicate.status,409);
  const downloaded=await call(path,{email:'alice@example.com'});
  assert.equal(downloaded.headers.get('Content-Type'),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),content);
  assert.equal((await call(path,{email:'bob@example.com'})).status,404);
});
