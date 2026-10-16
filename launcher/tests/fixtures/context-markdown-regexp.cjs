const {app,BrowserWindow}=require('electron');
const {source,flags}=require('./chatgpt-link-regexp.json');
const original=JSON.stringify([{type:'input_text',text:'```a``` '.repeat(12)}]);
const fixed=process.env.CHATGPT_LINK_TEST_INPUT;
(async()=>{
 await app.whenReady();
 const window=new BrowserWindow({show:false,webPreferences:{sandbox:true}});
 const fixtureUrl=(title,input)=>`data:text/html,<title>${title}</title>#${new URLSearchParams({source,flags,input}).toString()}`;
 const run=()=>window.webContents.executeJavaScript(`(()=>{
   const params=new URLSearchParams(location.hash.slice(1));
   const input=params.get('input');
   const t=performance.now();
   new RegExp(params.get('source'),params.get('flags')).exec(input);
   return {elapsed:performance.now()-t,decoded:JSON.parse(input)};
 })()`);
 await window.loadURL(fixtureUrl('isolated-regexp-regression',original));
 const before=await Promise.race([run().then(()=> 'returned',()=> 'rejected'),new Promise(r=>setTimeout(()=>r('timeout'),500))]);
 if(before!=='timeout')throw Error('Original regex did not reproduce the renderer stall');
 window.webContents.forcefullyCrashRenderer();
 await window.loadURL(fixtureUrl('isolated-regexp-regression-fixed',fixed));
 const after=await Promise.race([run(),new Promise((_,j)=>setTimeout(()=>j(Error('fixed regex stalled')),2000))]);
 if(JSON.stringify(after.decoded)!==original)throw Error('Context changed after Unicode decoding');
 console.log('CONTEXT_REGEXP_RESULT '+JSON.stringify({before,afterMs:after.elapsed,roundTrip:true}));
 window.destroy();app.quit();
})().catch(error=>{console.error(error.message);app.exit(1);});
