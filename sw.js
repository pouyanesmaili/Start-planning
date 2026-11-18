const CACHE_NAME='start-planning-v23-pwa3-ghpages';
const BASE_URL=new URL(self.registration.scope);
const CORE_FILES=['','index.html','planeers.css','planners.js','manifest.json','icon.svg','icon-192.png','icon-512.png','apple-touch-icon.png'].map(path=>new URL(path,BASE_URL).href);
const CHART_URL_PREFIX='https://cdn.jsdelivr.net/npm/chart.js';
self.addEventListener('install',event=>{
 event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(CORE_FILES)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
 event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('start-planning-')&&key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',event=>{
 const request=event.request;
 if(request.method!=='GET')return;
 const url=new URL(request.url);
 if(url.href.startsWith(CHART_URL_PREFIX)){
  event.respondWith(caches.open(CACHE_NAME).then(async cache=>{
   const cached=await cache.match(request);
   if(cached)return cached;
   try{const response=await fetch(request);if(response&&response.ok)await cache.put(request,response.clone());return response;}
   catch(error){return cached||Response.error();}
  }));
  return;
 }
 if(url.origin!==self.location.origin||!url.href.startsWith(BASE_URL.href))return;
 event.respondWith((async()=>{
  const cache=await caches.open(CACHE_NAME);
  try{
   const response=await fetch(request);
   if(response&&response.ok)cache.put(request,response.clone());
   return response;
  }catch(error){
   const cached=await cache.match(request);
   if(cached)return cached;
   if(request.mode==='navigate')return (await cache.match(new URL('index.html',BASE_URL).href))||Response.error();
   return Response.error();
  }
 })());
});
