const FILE_KEY = /^(?:thumb-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpe?g|webp|gif|bmp|avif|svg|pdf|xlsx|xls|ods|csv|tsv|docx|doc|pptx|txt|md|json|rtf|zip|mp4|webm|mov|m4v|ogv|bin)$/i;
const MAX_FILE = 20 * 1024 * 1024;
const CHUNK_BYTES = 384 * 1024;
const TYPES = { png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',bmp:'image/bmp',avif:'image/avif',svg:'image/svg+xml',pdf:'application/pdf',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',xls:'application/vnd.ms-excel',ods:'application/vnd.oasis.opendocument.spreadsheet',csv:'text/csv; charset=utf-8',tsv:'text/tab-separated-values; charset=utf-8',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',doc:'application/msword',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',txt:'text/plain; charset=utf-8',md:'text/markdown; charset=utf-8',json:'application/json',rtf:'application/rtf',zip:'application/zip',mp4:'video/mp4',webm:'video/webm',mov:'video/quicktime',m4v:'video/x-m4v',ogv:'video/ogg' };
const reply = (value,status=200) => Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
function encode(bytes) {
  let binary='';
  for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
  return btoa(binary);
}
function decode(value) {
  const binary=atob(value),bytes=new Uint8Array(binary.length);
  for(let index=0;index<binary.length;index++)bytes[index]=binary.charCodeAt(index);
  return bytes;
}

async function userFor(env,email) {
  await env.DB.prepare('INSERT OR IGNORE INTO users (id,email) VALUES (?,?)').bind(crypto.randomUUID(),email).run();
  return env.DB.prepare('SELECT id,email FROM users WHERE email=?').bind(email).first();
}

async function readState(env,user) {
  const row=await env.DB.prepare('SELECT data,revision FROM user_reports WHERE user_id=?').bind(user.id).first();
  return reply({reports:row?JSON.parse(row.data):{},sha:String(row?.revision||0),email:user.email});
}

async function writeState(request,env,user,validateReports) {
  if(request.headers.get('Origin')!==new URL(request.url).origin)return reply({error:'Invalid origin'},403);
  if(!request.headers.get('Content-Type')?.startsWith('application/json'))return reply({error:'Expected JSON'},415);
  if(Number(request.headers.get('Content-Length')||0)>1024*1024)return reply({error:'Report is too large'},413);
  const body=await request.text();
  if(new TextEncoder().encode(body).byteLength>1024*1024)return reply({error:'Report is too large'},413);
  let input;
  try{input=JSON.parse(body);}catch{return reply({error:'Invalid JSON'},400);}
  if(!validateReports(input.reports))return reply({error:'Invalid report data'},400);
  const revision=Number(input.sha);
  if(!Number.isSafeInteger(revision)||revision<0)return reply({error:'Invalid revision'},400);
  const data=JSON.stringify(input.reports);
  let result;
  if(revision===0){
    result=await env.DB.prepare('INSERT OR IGNORE INTO user_reports (user_id,data,revision) VALUES (?,?,1)').bind(user.id,data).run();
  }else{
    result=await env.DB.prepare('UPDATE user_reports SET data=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND revision=?').bind(data,user.id,revision).run();
  }
  if(!result.meta?.changes)return reply({error:'Report changed in another tab',conflict:true},409);
  return reply({sha:String(revision+1)});
}

async function writeAttachment(request,env,user,key) {
  if(request.headers.get('Origin')!==new URL(request.url).origin)return reply({error:'Invalid origin'},403);
  if(!FILE_KEY.test(key))return reply({error:'Invalid attachment name'},400);
  const length=Number(request.headers.get('Content-Length')||0);
  if(length>MAX_FILE)return reply({error:'Attachment exceeds 20 MB'},413);
  const bytes=await request.arrayBuffer();
  if(!bytes.byteLength||bytes.byteLength>MAX_FILE)return reply({error:'Invalid attachment size'},413);
  if(await env.DB.prepare('SELECT file_key FROM user_files WHERE user_id=? AND file_key=?').bind(user.id,key).first())return reply({error:'Attachment already exists',conflict:true},409);
  const type=TYPES[key.split('.').pop().toLowerCase()]||'application/octet-stream';
  const chunks=[];
  for(let offset=0;offset<bytes.byteLength;offset+=CHUNK_BYTES)chunks.push(encode(new Uint8Array(bytes,offset,Math.min(CHUNK_BYTES,bytes.byteLength-offset))));
  const statements=[env.DB.prepare('INSERT INTO user_files (user_id,file_key,mime_type,size,chunk_count) VALUES (?,?,?,?,?)').bind(user.id,key,type,bytes.byteLength,chunks.length)];
  chunks.forEach((chunk,index)=>statements.push(env.DB.prepare('INSERT INTO user_file_chunks (user_id,file_key,part,data) VALUES (?,?,?,?)').bind(user.id,key,index,chunk)));
  await env.DB.batch(statements);
  return reply({path:`data/attachments/${key}`},201);
}

async function readAttachment(env,user,key) {
  if(!FILE_KEY.test(key))return reply({error:'Invalid attachment name'},400);
  const file=await env.DB.prepare('SELECT mime_type,size,chunk_count FROM user_files WHERE user_id=? AND file_key=?').bind(user.id,key).first();
  if(!file)return reply({error:'Attachment not found'},404);
  const rows=await env.DB.prepare('SELECT part,data FROM user_file_chunks WHERE user_id=? AND file_key=? ORDER BY part').bind(user.id,key).all();
  if(rows.results.length!==file.chunk_count)return reply({error:'Attachment is incomplete'},503);
  const bytes=new Uint8Array(file.size);let offset=0;
  for(const row of rows.results){if(row.part!==offset/CHUNK_BYTES)return reply({error:'Attachment is incomplete'},503);const chunk=decode(row.data);bytes.set(chunk,offset);offset+=chunk.length;}
  if(offset!==file.size)return reply({error:'Attachment is incomplete'},503);
  const ext=key.split('.').pop().toLowerCase();
  return new Response(bytes,{headers:{'Content-Type':file.mime_type||TYPES[ext]||'application/octet-stream','Content-Disposition':ext==='svg'?'attachment':'inline','Cache-Control':'private, max-age=60','X-Content-Type-Options':'nosniff'}});
}

export async function personal(request,env,email,validateReports) {
  if(!env.DB)return reply({error:'Personal storage is unavailable'},503);
  const user=await userFor(env,email);
  const path=new URL(request.url).pathname;
  if(path==='/api/user/session'&&request.method==='GET')return reply({canEdit:true,email:user.email});
  if(path==='/api/user/state'&&request.method==='GET')return readState(env,user);
  if(path==='/api/user/state'&&request.method==='PUT')return writeState(request,env,user,validateReports);
  const match=/^\/api\/user\/attachments\/([^/]+)$/.exec(path);
  if(match&&request.method==='GET')return readAttachment(env,user,match[1]);
  if(match&&request.method==='PUT')return writeAttachment(request,env,user,match[1]);
  return reply({error:'Not found'},404);
}
