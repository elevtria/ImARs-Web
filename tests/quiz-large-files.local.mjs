// LOCAL ONLY: all outbound Firebase/Gemini traffic is routed to a fixture
// Worker. This tests Cloudflare's actual FixedLengthStream with no real keys.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { MAX_QUIZ_FILE_BYTES } from "../js/quiz-limits.js";

const bundle = await build({ bundle: true, format: "esm", platform: "browser", write: false,
  stdin: { resolveDir: process.cwd(), contents: `import {onRequestPost} from './functions/api/generate-quiz.js';
    export default {async fetch(request,env) {const pending=[]; const response=await onRequestPost({request,env,waitUntil:p=>pending.push(p)}); await Promise.all(pending); return response;}};` } });
const provider = `
const files=new Map(), sizes=[], lengths=[]; let generated=0, deleted=0, largest=0;
export default {async fetch(request) {
  const url=new URL(request.url);
  if(url.pathname==='/__stats') return Response.json({sizes,lengths,generated,deleted,largest});
  if(url.hostname==='identitytoolkit.googleapis.com') return Response.json({users:[{localId:'local-teacher-uid'}]});
  if(url.pathname.endsWith('documents:runQuery')) return Response.json([{document:{name:'projects/fixture/documents/users/local-teacher',fields:{role:{stringValue:'teacher'}}}}]);
  if(url.pathname.includes('/documents/classes/')) return Response.json({fields:{teacherId:{stringValue:'local-teacher'}}});
  if(url.pathname==='/upload/v1beta/files' && !url.search) {
    const id='local-'+(files.size+1), size=Number(request.headers.get('X-Goog-Upload-Header-Content-Length'));
    files.set(id,{size,read:0}); return new Response(null,{headers:{'X-Goog-Upload-URL':'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id='+id}});
  }
  if(url.searchParams.has('upload_id')) {
    const id=url.searchParams.get('upload_id'), file=files.get(id);
    if(file.size===20202) return new Response('Fixture rejection',{status:503});
    const reader=request.body.getReader(); let size=0;
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;largest=Math.max(largest,value.byteLength);}
    const length=Number(request.headers.get('Content-Length')); sizes.push(size);lengths.push(length);file.read=size;
    if(size!==file.size || length!==size) return new Response('Length mismatch',{status:400});
    return Response.json({file:{name:'files/'+id,uri:'https://generativelanguage.googleapis.com/v1beta/files/'+id,mimeType:'application/pdf',state:'ACTIVE'}});
  }
  if(request.method==='DELETE' && url.pathname.startsWith('/v1beta/files/')) {deleted++;return new Response(null);}
  if(url.pathname==='/v1beta/interactions') {
    const body=await request.json(); const document=body.input[1];
    if(document.data || !document.uri) return new Response('Expected URI',{status:400});
    generated++;
    return Response.json({output_text:JSON.stringify({questions:[{text:'What does water become when it freezes?',options:['Ice','Sand','Air','Metal'],correctIndex:0}]})});
  }
  throw Error('No external network is permitted in this fixture: '+url.hostname);
}};`;
const runtime = new Miniflare(convertV4MiniflareOptions({ host: "127.0.0.1", port: 0, log: new Log(LogLevel.ERROR), workers: [
  { name: "quiz-app", modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-10-01",
    bindings: { GEMINI_API_KEY: "local-fixture-only-key" }, outboundService: "quiz-provider" },
  { name: "quiz-provider", modules: true, script: provider, compatibilityDate: "2026-10-01" }
] }));
try {
  await runtime.ready;
  for (const size of [16000, MAX_QUIZ_FILE_BYTES, 20202]) {
    let remaining=size;
    const body=new ReadableStream({pull(controller){if(!remaining){controller.close();return;}const length=Math.min(65536,remaining);remaining-=length;controller.enqueue(new Uint8Array(length));}});
    const response=await runtime.dispatchFetch("https://local-fixture.invalid/api/generate-quiz", {
      method:"POST", duplex:"half", body, headers:{"Content-Type":"application/pdf",Authorization:"Bearer local-fixture-token",
        "X-Quiz-Options":encodeURIComponent(JSON.stringify({fileName:"local.pdf",fileSize:size,sectionId:"local-section",firebaseApiKey:"local-public-firebase-key",questionCount:1,difficulty:"Easy",questionType:"multiple-choice"}))}
    });
    const result=await response.json();
    assert.equal(response.status,size===20202?502:200,JSON.stringify(result));
    if(response.ok) assert.equal(result.questions.length,1);
  }
  const fixture=await runtime.getWorker("quiz-provider");
  const stats=await (await fixture.fetch("https://local-fixture.invalid/__stats")).json();
  assert.deepEqual(stats.sizes,[16000,MAX_QUIZ_FILE_BYTES]);
  assert.deepEqual(stats.lengths,stats.sizes);
  assert.equal(stats.generated,2);assert.equal(stats.deleted,2);
  console.log("Cloudflare runtime: 16 KB and 50 MB PDFs streamed with correct Content-Length; generation, cleanup and interrupted-upload handling passed. No external API requests made.");
} finally { await runtime.dispose(); }
