// Run with the project's pinned Bun: bun scripts/capture-chatgpt-completion.cjs <output-directory>
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { CompletionCaptureEvents } = require('./completion-capture-events.ts');
const directory = path.resolve(process.argv[2] || '.verify-artifacts/completion-capture');
fs.mkdirSync(directory, { recursive: true });
const run = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const output = path.join(directory, `capture-${run}.jsonl`);
const stopFile = path.join(directory, `stop-${run}`);
const pauseFile = path.join(directory, `paused-${run}`);
const emit = (event, detail = {}) => fs.appendFileSync(output, JSON.stringify({at:new Date().toISOString(),event,...detail})+'\n');
fs.writeFileSync(path.join(directory, 'current.json'), JSON.stringify({output,stopFile,pauseFile}));
(async () => {
  const descriptor = JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE,'.codex-chatgpt-web/runtime/launcher-browser.json'),'utf8'));
  const browser = await chromium.connectOverCDP(descriptor.endpoint);
  const sessions = new Map(); let serial = 0, pausedAt;
  emit('capture_started', {maxMinutes:15,pauseBudgetSeconds:180});
  const deadline = Date.now()+15*60*1000;
  async function attach(page) {
    if(sessions.has(page) || !page.url().startsWith('https://chatgpt.com/')) return;
    const cdp=await page.context().newCDPSession(page);
    const state={id:++serial,cdp,requests:new Map(),streams:new Map(),queued:new Map(),last:''};sessions.set(page,state);
    const id=state.id;
    const classify=url=>{try{const u=new URL(url);return u.hostname==='chatgpt.com'&&u.pathname.includes('/conversation')?u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi,'[conversation]'):null;}catch{return null;}};
    const consume=(request,data,buffered=false)=>{
      let stream=state.streams.get(request);
      if(!stream){stream={decoder:new TextDecoder(),parser:new CompletionCaptureEvents(markers=>emit('stream_markers',{page:id,request,markers}))};state.streams.set(request,stream);}
      stream.parser.push(stream.decoder.decode(Buffer.from(data,'base64'),{stream:true}));
    };
    cdp.on('Network.requestWillBeSent',e=>{const route=classify(e.request.url);if(route){state.requests.set(e.requestId,route);emit('request_started',{page:id,request:e.requestId,route});}});
    cdp.on('Network.responseReceived',async e=>{
      const route=classify(e.response.url);if(!route)return;
      state.requests.set(e.requestId,route);emit('response_headers',{page:id,request:e.requestId,route,status:e.response.status,mime:e.response.mimeType});
      if(route==='/backend-api/f/conversation'&&e.response.mimeType.includes('event-stream'))try{
        state.queued.set(e.requestId,[]);
        const result=await cdp.send('Network.streamResourceContent',{requestId:e.requestId});
        if(result.bufferedData)consume(e.requestId,result.bufferedData,true);
        for(const chunk of state.queued.get(e.requestId)||[])consume(e.requestId,chunk);
        state.queued.delete(e.requestId);
        emit('stream_attached',{page:id,request:e.requestId});
      }catch{state.queued.delete(e.requestId);emit('stream_unavailable',{page:id,request:e.requestId});}
    });
    cdp.on('Network.dataReceived',e=>{if(e.data&&state.requests.get(e.requestId)==='/backend-api/f/conversation'){
      const queued=state.queued.get(e.requestId);if(queued){if(queued.reduce((sum,item)=>sum+item.length,0)+e.data.length<3000000)queued.push(e.data);else emit('stream_queue_limit',{page:id,request:e.requestId});}
      else consume(e.requestId,e.data);
    }});
    cdp.on('Network.loadingFinished',e=>{if(state.requests.has(e.requestId))emit('request_finished',{page:id,request:e.requestId,route:state.requests.get(e.requestId)});});
    cdp.on('Network.loadingFailed',e=>{if(state.requests.has(e.requestId))emit('request_failed',{page:id,request:e.requestId,route:state.requests.get(e.requestId),cancelled:!!e.canceled});});
    await cdp.send('Network.enable');emit('page_attached',{page:id});
  }
  for(const context of browser.contexts()) context.on('page',page=>{page.on('framenavigated',()=>attach(page).catch(()=>{}));attach(page).catch(()=>{});});
  while(Date.now()<deadline&&!fs.existsSync(stopFile)) {
    if(fs.existsSync(pauseFile)&&pausedAt===undefined){pausedAt=Date.now();emit('pause_marked');}
    if(pausedAt!==undefined&&Date.now()-pausedAt>=180000){emit('pause_budget_expired');break;}
    for(const page of browser.contexts().flatMap(c=>c.pages())) {
      if(!page.url().startsWith('https://chatgpt.com/'))continue;
      await attach(page);const state=sessions.get(page);if(!state)continue;
      try{
        let timer;
        const sample=await Promise.race([page.evaluate(async()=>{
          const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
          const root=[...document.querySelectorAll('[data-turn-key]:has([data-conversation-role="assistant"], [data-chatgpt-agent-turn-start]), [data-message-author-role="assistant"]')].at(-1);
          const paragraphs=root?[...root.querySelectorAll('p,pre,li,h1,h2,h3')]:[];
          const last=paragraphs.at(-1)?.textContent||'';
          const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(last));
          const blocks=await Promise.all(paragraphs.slice(-64).map(async(element,index)=>{
            const text=element.textContent||'';
            const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
            return {index:Math.max(0,paragraphs.length-64)+index,tag:element.tagName.toLowerCase(),chars:text.length,textHash:[...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,'0')).join(''),nodeId:globalThis.__CODEX_WEB_GPT_RESPONSE_OBSERVERS__?.nodeIds.get(element)};
          }));
          return {stopVisible:[...document.querySelectorAll('[data-testid="stop-button"],button[aria-label="Stop"]')].filter(visible).length,rootChars:root?.textContent?.length||0,lastBlockChars:last.length,lastBlockHash:[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join(''),blockCount:paragraphs.length,blocks,completionActions:root?[...root.querySelectorAll('button[data-testid="copy-turn-action-button"], [data-turn-key] .turn-action-controls button')].filter(visible).length:0};
        }),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),3000);})]).finally(()=>clearTimeout(timer));
        const key=JSON.stringify(sample);if(key!==state.last){state.last=key;emit('dom_state',{page:state.id,...sample});}
      }catch{emit('dom_unavailable',{page:state.id});}
    }
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  for(const state of sessions.values())await state.cdp.detach().catch(()=>{});
  emit('capture_stopped');process.exit(0);
})().catch(()=>{emit('capture_error');process.exit(1);});
