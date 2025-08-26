// FN Leak Bot — dev-only parancsok, fix 60 mp polling, multi-guild
// ÖSSZES forrást átfésül, az összes új itemet küldi (guildevként, duplikáció nélkül)
// Flood védelem: max N/perc/guild (alap: 5)
// GIF-only tiltás; YouTube-nál letöltés helyett link; USE CODE/SAC átírás
// Forráskezelés: /sources, /addsource, /removesource
// Node 18+ ; npm i discord.js
// config.json: { "token": "DISCORD_BOT_TOKEN" }

// ======= IMPORTOK / SETUP =======
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  ChannelType,
  PermissionFlagsBits
} = require('discord.js');

// ======= FEJLESZTŐK =======
const DEVELOPER_IDS = [
  "815097385008758794",
  "987654321098765432"
];

// ======= TOKEN =======
let token;
try {
  token = JSON.parse(fs.readFileSync('config.json','utf8')).token;
  if (!token) throw new Error('Missing token');
} catch {
  console.error('Hiányzó/hibás config.json. Példa: {"token":"DISCORD_BOT_TOKEN"}');
  process.exit(1);
}

// ======= ÁLLAPOT =======
const STATE_FILE = 'state.json';
const DEFAULT_SOURCES = [
  { name: 'iFireMonkey', url: 'https://rss.app/feeds/v1.1/NAmV8tK4imNqZGBm.json' },
  { name: 'Fecooo',      url: 'https://rss.app/feeds/v1.1/XKFP1u7RKuM0OdRD.json' },
  { name: 'ShiinaBR',    url: 'https://rss.app/feeds/v1.1/3zuGm5q66HMXN66P.json' },
  { name: 'Hypex',       url: 'https://rss.app/feeds/v1.1/yAtafRTIVnPMK5TM.json' },
  { name: 'LEZO BOT',    url: 'https://rss.app/feeds/v1.1/OkB6XUoSYo5gAIea.json' },
  { name: 'BOT',         url: 'https://rss.app/feeds/v1.1/OkB6XUoSYo5gAIea.json' } // extra néven is
];

// Per-poll küldési limit guildenként (flood védelem)
const POLL_BATCH_PER_GUILD = 5;

// Állapot
let state = {
  guilds: {},              // { [guildId]: { channelId, mentionRoles:[], posted:{} } }
  sources: DEFAULT_SOURCES,
  lastRunOk: null
};

// ======= Állapot betöltés + források összefésülése =======
function mergeDefaultSources() {
  const have = new Set((state.sources||[]).map(s => `${(s.name||'').trim()}|${(s.url||'').trim()}`));
  for (const s of DEFAULT_SOURCES) {
    const key = `${(s.name||'').trim()}|${(s.url||'').trim()}`;
    if (!have.has(key)) {
      (state.sources ||= []).push({ name: s.name, url: s.url });
      have.add(key);
    }
  }
}

function loadState(){
  try {
    if (fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));
      state = { ...state, ...s };
      if (!Array.isArray(state.sources)) state.sources = [];
    }
    mergeDefaultSources();
    if (!state.guilds || typeof state.guilds !== 'object') state.guilds = {};
  } catch(e){ console.warn('Állapot betöltés hiba:', e.message); }
}
function saveState(){
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state,null,2)); } catch {}
}
function getGuildCfg(guildId){
  if (!state.guilds[guildId]) {
    state.guilds[guildId] = { channelId:null, mentionRoles:[], posted:{} };
    saveState();
  }
  return state.guilds[guildId];
}

// ======= FETCH =======
const fetchAny = global.fetch ? global.fetch.bind(global) : (...a)=>import('node-fetch').then(({default:f})=>f(...a));
async function fetchRaw(url, timeoutMs=25000){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), timeoutMs);
  try {
    const res = await fetchAny(url, { headers:{'User-Agent':'fn-leak-bot/3.3'}, redirect:'follow', signal:ctrl.signal });
    if (!res.ok) throw new Error(`${url} -> ${res.status} ${res.statusText}`);
    const ct = (res.headers.get('content-type')||'').toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    return { ct, buf, headers:res.headers };
  } finally { clearTimeout(t); }
}
async function fetchText(url){
  const { ct, buf } = await fetchRaw(url);
  return { ct, text: buf.toString('utf8') };
}

// ======= FEED PARSOLÁS =======
function parseRSS(xml){
  const out = [];
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const it of items) {
    const title = (/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(it)?.[1]||'').trim();
    const link  = (/<link>([\s\S]*?)<\/link>/i.exec(it)?.[1]||'').trim();
    const guid  = (/<guid[^>]*>([\s\S]*?)<\/guid>/i.exec(it)?.[1]||link).trim();
    const pub   = (/<pubDate>([\s\S]*?)<\/pubDate>/i.exec(it)?.[1]||'').trim();
    let ts = 0; const t = Date.parse(pub); if (Number.isFinite(t)) ts = t;

    const media = [];
    const encs = it.match(/<enclosure[^>]*>/gi) || [];
    for (const e of encs) { const m = /url="([^"]+)"/i.exec(e); if (m) media.push(m[1]); }
    const desc = (/<description>([\s\S]*?)<\/description>/i.exec(it)?.[1]||'').toString();
    const imgMatches = [...desc.matchAll(/<img[^>]+src="([^"]+)"/gi)].map(m=>m[1]);
    media.push(...imgMatches);

    out.push({ title, link, guid, ts, media });
  }
  return out;
}
function parseJSONFeed(jsonText){
  let data;
  try { data = JSON.parse(jsonText); } catch { return []; }
  const arr = Array.isArray(data.items) ? data.items :
              Array.isArray(data.data) ? data.data :
              Array.isArray(data.articles) ? data.articles : [];
  const out = [];
  for (const it of arr) {
    const title = (it.title||'').toString().trim();
    const link  = (it.url || it.link || '').toString().trim();
    const guid  = (it.id || link || title).toString();
    const dateRaw = it.date_published || it.published || it.pubDate || it.date || it.created_at || '';
    const t = Date.parse(dateRaw); const ts = Number.isFinite(t) ? t : 0;

    const media = [];
    if (typeof it.enclosure === 'string') media.push(it.enclosure);
    if (typeof it.image === 'string') media.push(it.image);
    if (Array.isArray(it.attachments)) for (const a of it.attachments) if (a && a.url) media.push(a.url);
    const html = (it.content_html || '').toString();
    const imgMatches = [...html.matchAll(/<img[^>]+src="([^"]+)"/gi)].map(m=>m[1]);
    const vidMatches = [...html.matchAll(/<(?:source|video)[^>]+src="([^"]+?\.(?:mp4|webm))"[^>]*>/gi)].map(m=>m[1]);
    media.push(...imgMatches, ...vidMatches);

    out.push({ title, link, guid, ts, media });
  }
  return out;
}
async function fetchFeed(url){
  try {
    const { ct, text } = await fetchText(url);
    const looksJson = ct.includes('application/json') || url.toLowerCase().endsWith('.json') || text.trim().startsWith('{');
    return looksJson ? parseJSONFeed(text) : parseRSS(text);
  } catch { return []; }
}

// ======= HASZNOS =======
function isGifOnly(itemOrUrls){
  const urls = Array.isArray(itemOrUrls) ? itemOrUrls : (itemOrUrls.media||[]);
  if (!urls.length) return false;
  return urls.every(u=>String(u||'').toLowerCase().endsWith('.gif'));
}
function rewriteUseCodeAndSAC(text){
  if (!text) return '';
  return text
    .replace(/use\s+code\s+[\w-]+/ig, 'USE CODE: GABOROO')
    .replace(/creator\s+code\s+[\w-]+/ig, 'USE CODE: GABOROO')
    .replace(/support\s+(a\s+creator|me\s+with\s+code)\s*[\w-]*/ig, 'USE CODE: GABOROO')
    .replace(/\bmy\s+code\s+[\w-]+/ig, 'USE CODE: GABOROO')
    .replace(/\bS\.?A\.?C\.?\s*[:\-]?\s*[\w-]+/ig, 'SAC:GABOROO')
    .replace(/\bSAC\s*(code)?\s*[:\-]?\s*[\w-]+/ig, 'SAC:GABOROO')
    .replace(/\buse\s+SAC\s*[:\-]?\s*[\w-]+/ig, 'SAC:GABOROO');
}
function looksYouTube(u=''){
  return /(?:^|\/\/)(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(String(u));
}
function cleanFilenameFromUrl(u, fallbackBase='media'){
  try { const url = new URL(u); const base = path.basename(url.pathname) || fallbackBase; return base.split('?')[0].split('#')[0]; }
  catch { return fallbackBase; }
}
function normalizeMediaUrls(urls){
  const out=[]; const seen=new Set();
  for (const u of urls||[]) {
    if (!u || typeof u!=='string') continue;
    const L = u.toLowerCase();
    if (L.endsWith('.gif')) continue;
    if (seen.has(u)) continue;
    seen.add(u); out.push(u);
  }
  return out;
}

// ======= LETÖLTÉS =======
async function downloadAttachments(urls, maxCount=4, perFileMaxBytes=25*1024*1024){
  const atts = [];
  for (const u of urls.slice(0, maxCount)) {
    if (looksYouTube(u)) continue;
    try {
      const { ct, buf } = await fetchRaw(u, 30000);
      if (buf.length === 0) continue;
      if (buf.length > perFileMaxBytes) continue;
      if ((ct||'').includes('gif')) continue;

      let name = cleanFilenameFromUrl(u, 'media');
      if (!/\.\w{2,4}$/.test(name)) {
        if ((ct||'').includes('mp4')) name += '.mp4';
        else if ((ct||'').includes('webm')) name += '.webm';
        else if ((ct||'').includes('png')) name += '.png';
        else if ((ct||'').includes('jpeg')) name += '.jpg';
        else if ((ct||'').includes('jpg')) name += '.jpg';
        else if ((ct||'').includes('webp')) name += '.webp';
        else name += '.bin';
      }
      atts.push({ attachment: buf, name });
    } catch (e) { console.warn('Média letöltés hiba:', u, e.message); }
  }
  return atts;
}

// ======= ÜZENET =======
const REACTIONS = ['🎮','🛡️','🗺️'];
function mentionLine(roles){ return (roles||[]).map(id=>`<@&${id}>`).join(' '); }
function pickYouTubeLink(item, mediaUrls){
  if (looksYouTube(item.link)) return item.link;
  for (const u of mediaUrls||[]) if (looksYouTube(u)) return u;
  return null;
}
async function sendLeakMessage(channel, sourceName, item, guildCfg){
  const title = rewriteUseCodeAndSAC(item.title || '');

  let mediaUrls = normalizeMediaUrls(item.media||[]);
  if (isGifOnly(mediaUrls)) mediaUrls = [];

  const ytLink = pickYouTubeLink(item, mediaUrls);
  const files = await downloadAttachments(mediaUrls);

  const contentParts = [
    mentionLine(guildCfg.mentionRoles) || null,
    `**${sourceName} leak:** ${title}`,
  ];
  if (!files.length && item.link) contentParts.push(`🔗 ${item.link}`);
  if (ytLink) contentParts.push(`▶️ YouTube: ${ytLink}`);

  const content = contentParts.filter(Boolean).join('\n');
  const msg = await channel.send({ content, files: files.length ? files : undefined });
  for (const r of REACTIONS) { try { await msg.react(r); } catch {} }
}

// ======= ÖSSZES ÚJ ITEM BEGYŰJTÉSE MINDEN FORRÁSBÓL =======
function withStableTs(items){
  const now = Date.now();
  return items.map((it, idx) => {
    let t = Number(it.ts)||0;
    if (!t || !Number.isFinite(t)) t = now - (idx * 1000);
    return { ...it, _ts:t };
  });
}
async function fetchAllItemsFromAllSources(){
  const out = [];
  if (!Array.isArray(state.sources) || !state.sources.length) return out;

  console.log(`[SOURCES] Összes forrás: ${state.sources.length}`);
  for (const src of state.sources) {
    const name = (src.name||'').trim() || 'source';
    const url  = (src.url||'').trim();
    if (!url) continue;
    try {
      const items = await fetchFeed(url);
      const stamped = withStableTs(items).map(it => ({ ...it, _srcName: name }));
      out.push(...stamped);
      console.log(` - OK: ${name} (${url}) -> ${items.length} item`);
    } catch(e){
      console.warn(` - HIBA: ${name} (${url}) -> ${e.message}`);
    }
  }
  out.sort((a,b)=>b._ts - a._ts);
  return out;
}

// ======= POLLING: MINDEN GUILDRE, MINDEN ÚJ ITEM =======
const FIX_INTERVAL_MS = 60_000;
async function pollOnceAllGuilds(client){
  try {
    const items = await fetchAllItemsFromAllSources();
    if (!items.length) { state.lastRunOk = false; saveState(); return; }

    for (const [gid, guild] of client.guilds.cache) {
      const cfg = getGuildCfg(gid);
      if (!cfg.channelId) continue;

      const ch = await guild.channels.fetch(cfg.channelId).catch(()=>null);
      if (!ch?.send) continue;

      const me = guild.members.me ?? await guild.members.fetchMe().catch(()=>null);
      if (me) {
        const missing = ch.permissionsFor(me).missing([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles
        ]);
        if (missing.length) { console.warn(`[${gid}] Hiányzó jogok:`, missing.join(', ')); continue; }
      }

      let sent = 0;
      for (const it of items) {
        if (sent >= POLL_BATCH_PER_GUILD) break;
        const guidKey = it.guid || it.link || `${it.title}-${it._ts}`;
        if (cfg.posted[guidKey]) continue;
        if (isGifOnly(it)) continue;
        await sendLeakMessage(ch, it._srcName || 'source', it, cfg);
        cfg.posted[guidKey] = true;
        sent++;
      }

      const keys = Object.keys(cfg.posted);
      if (keys.length > 6000) {
        for (const k of keys.slice(0, keys.length - 3000)) delete cfg.posted[k];
      }
      state.guilds[gid] = cfg; saveState();
    }

    state.lastRunOk = true; saveState();
  } catch(e){
    console.warn('pollOnceAllGuilds hiba:', e.message);
    state.lastRunOk = false; saveState();
  }
}
function startFixedScheduler(client){
  pollOnceAllGuilds(client).catch(()=>{});
  setInterval(()=>pollOnceAllGuilds(client).catch(()=>{}), FIX_INTERVAL_MS);
}

// ======= SAFE REPLY =======
async function safeReply(ix,data){ try{ if(!ix.deferred&&!ix.replied)return await ix.reply(data); else return await ix.followUp(data);}catch(e){ console.warn('safeReply',e.message);} }

// ======= DEV CHECK =======
async function ensureDevOnly(ix){
  if(!DEVELOPER_IDS.includes(ix.user.id)){
    await safeReply(ix,{content:'⛔ Ez a parancs csak fejlesztőknek elérhető.',flags:64});
    return false;
  } return true;
}

// ======= SLASH PARANCSOK =======
// v8 leírás (hogy a kliens biztos frissítse)
const slashDefs=[
  {name:'channel',description:'Cél szoba (dev-only, v8)',options:[{name:'target',description:'Text csatorna',type:7,required:true,channel_types:[ChannelType.GuildText]}]},
  {name:'mention',description:'Rangok jelölése (dev-only, v8)',options:[{name:'roles',description:'@Role1 @Role2 ...',type:3,required:false}]},
  {name:'sources',description:'Források listázása (dev-only, v8)'},
  {name:'addsource',description:'Forrás hozzáadása (dev-only, v8)',options:[
    {name:'name',description:'Forrás neve',type:3,required:true},
    {name:'url',description:'Forrás URL (http/https)',type:3,required:true}
  ]},
  {name:'removesource',description:'Forrás törlése (dev-only, v8)',options:[
    {name:'name_or_index',description:'Név VAGY sorszám a /sources-ból',type:3,required:true}
  ]},
  {name:'leak',description:'Összes aktuális leak kiküldése most (dev-only, v8)'},
  {name:'testleak',description:'Teszt üzenet (dev-only, v8)',options:[{name:'text',description:'Teszt szöveg',type:3,required:true}]},
  {name:'status',description:'Állapot (dev-only, v8)'},
];

// ======= REGISZTRÁCIÓ =======
async function registerSlashForAllGuilds(client){
  const rest=new REST({version:'10'}).setToken(token);
  for(const gid of client.guilds.cache.map(g=>g.id)){
    try{
      await rest.put(Routes.applicationGuildCommands(client.user.id,gid),{body:slashDefs});
      console.log('Slash regisztrálva:', gid);
    }catch(e){ console.error('Slash hiba',gid,e.message); }
  }
}

// ======= DISCORD CLIENT =======
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`Bejelentkezve: ${client.user.tag}`);
  loadState();
  console.log(`[BOOT] Források száma: ${state.sources.length}`);
  await registerSlashForAllGuilds(client);
  startFixedScheduler(client);
});

client.on('guildCreate', async (guild) => {
  getGuildCfg(guild.id);
  const rest = new REST({ version:'10' }).setToken(token);
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: slashDefs });
  } catch (e) {
    console.error('Új guild slash hiba', guild.id, e.message);
  }
});

// ======= COMMAND HANDLER =======
client.on('interactionCreate', async (ix) => {
  if (!ix.isChatInputCommand()) return;
  if (!await ensureDevOnly(ix)) return;

  const gid = ix.guild?.id;
  if (!gid) { await safeReply(ix, { content:'Csak szerveren használható.', flags:64 }); return; }
  const cfg = getGuildCfg(gid);

  try {
    if (ix.commandName==='channel') {
      const ch=ix.options.getChannel('target',false);
      if(!ch) return safeReply(ix,{content:'Használat: /channel target:#szoba',flags:64});
      if(ch.type!==ChannelType.GuildText) return safeReply(ix,{content:'Adj meg szöveges csatornát.',flags:64});
      const me = ch.guild.members.me ?? await ch.guild.members.fetchMe().catch(()=>null);
      const missing = me ? ch.permissionsFor(me).missing([
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles
      ]) : [];
      if (missing.length) return safeReply(ix, { content:'Hiányzó jogok: View/Send/Read History/AttachFiles', flags:64 });
      cfg.channelId=ch.id; state.guilds[gid]=cfg; saveState();
      return safeReply(ix,{content:`OK, ide posztolok: <#${ch.id}>`,flags:64});
    }

    if (ix.commandName==='mention') {
      const raw=ix.options.getString('roles');
      if(!raw){ cfg.mentionRoles=[]; saveState(); return safeReply(ix,{content:'Rang jelölések törölve.',flags:64}); }
      const ids=[...raw.matchAll(/<@&(\d+)>/g)].map(m=>m[1]);
      cfg.mentionRoles=ids; saveState();
      return safeReply(ix,{content:`Mentve: ${ids.map(id=>`<@&${id}>`).join(' ')}`,flags:64});
    }

    if (ix.commandName==='sources') {
      const lines=(state.sources||[]).map((s,i)=>`${i+1}. ${s.name} — ${s.url}`).join('\n')||'Nincs forrás.';
      return safeReply(ix,{content:lines,flags:64});
    }

    if (ix.commandName==='addsource') {
      const name=(ix.options.getString('name')||'').trim();
      const url=(ix.options.getString('url')||'').trim();
      if(!/^https?:\/\//i.test(url)) return safeReply(ix,{content:'Adj meg érvényes http/https URL-t.',flags:64});
      (state.sources ||= []).push({ name, url });
      saveState();
      return safeReply(ix,{content:`Hozzáadva:\n- **${name}** — ${url}\nÖsszes forrás: ${state.sources.length}\nHasználd: /sources a listához.`,flags:64});
    }

    if (ix.commandName==='removesource') {
      const arg=(ix.options.getString('name_or_index')||'').trim();
      let removed=null;
      if (/^\d+$/.test(arg)) {
        const idx = parseInt(arg,10)-1;
        if (idx>=0 && idx<state.sources.length) removed = state.sources.splice(idx,1)[0];
      } else {
        const i = state.sources.findIndex(s=> (s.name||'').toLowerCase()===arg.toLowerCase());
        if (i>=0) removed = state.sources.splice(i,1)[0];
      }
      saveState();
      return safeReply(ix,{content: removed ? `Törölve: **${removed.name}** — ${removed.url}\nÖsszes forrás: ${state.sources.length}` : 'Nem találtam ilyen forrást (név vagy sorszám).',flags:64});
    }

    if (ix.commandName==='leak') {
      await pollOnceAllGuilds(client);
      return safeReply(ix,{content:`Lekértük az összes forrást és kiküldtük az újakat (max ${POLL_BATCH_PER_GUILD}/guild).`,flags:64});
    }

    if (ix.commandName==='testleak') {
      const t=ix.options.getString('text',true);
      const ch=await client.channels.fetch(cfg.channelId).catch(()=>null);
      if(ch) await ch.send({content:`${mentionLine(cfg.mentionRoles)}\n**TEST:** ${rewriteUseCodeAndSAC(t)}`.trim()});
      return safeReply(ix,{content:'Teszt elküldve.',flags:64});
    }

    if (ix.commandName==='status') {
      const roles=(cfg.mentionRoles||[]).map(id=>`<@&${id}>`).join(' ')||'(nincs)';
      return safeReply(ix,{content:
        `Guild: ${ix.guild?.name}\n`+
        `Csatorna: ${cfg.channelId?`<#${cfg.channelId}>`:'(nincs)'}\n`+
        `Források: ${state.sources.length}\n`+
        `Megjelölt rangok: ${roles}\n`+
        `Batch limit/guild: ${POLL_BATCH_PER_GUILD}\n`+
        `Utolsó poll ok: ${state.lastRunOk===null?'-':(state.lastRunOk?'igen':'nem')}`,
        flags:64});
    }

  } catch(e){
    console.error('Parancs hiba:', e);
    await safeReply(ix,{content:'Hiba történt.',flags:64});
  }
});

// ======= LOGIN =======
process.on('unhandledRejection', (r)=>console.error('UNHANDLED', r));
process.on('uncaughtException', (e)=>console.error('UNCAUGHT', e));

client.login(token)
  .then(()=>console.log('Bot indult.'))
  .catch(e=>console.error('Login hiba:', e));
