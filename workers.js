// worker.js
// YouXuan-API — Cloudflare Worker (2025-10-29 r9 + speedMode patch r10)
// - Glass UI, server-side bg/logo prefs (cross-device) via KV /api/prefs
// - Quotas in own modal with help; latency-first sort with country grouping
// - Region naming via Intl.DisplayNames zh-CN (fallback map + A2)
// - Domain remark only for domains; IP needs port (gate)
// - 3 region modes: country | city | country_city
// - Safer IPv6 check (no giant regex)
// - Added: speedMode (0=off,1=number,2=number+MB/s) and robust unit conversion to MB/s

const REPO = "https://github.com/Yanson0219/YouXuan-API";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    try {
      // UI
      if (request.method === "GET" && (path === "" || path === "/")) {
        return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      // status
      if (request.method === "GET" && path === "/api/status") {
        return J({ ok: true, kvBound: !!env.KV, tokenSet: !!env.TOKEN, repo: REPO });
      }

      // prefs (bg/logo) — GET: public read; POST: write via TOKEN
      if (path === "/api/prefs") {
        if (!env.KV) return J({ ok:false, error:"KV not bound" }, 500);

        if (request.method === "GET") {
          const bg  = await env.KV.get("pref:bg");
          const op  = await env.KV.get("pref:bgOpacity");
          const lg  = await env.KV.get("pref:logo");
          return J({ ok:true, prefs: { bg, bgOpacity: op ? parseInt(op,10) : null, logo: lg }});
        }

        if (request.method === "POST") {
          // auth
          const ct = request.headers.get("content-type")||"";
          let token = new URL(request.url).searchParams.get("token") || request.headers.get("x-token") || "";
          let data = {};
          if (ct.includes("application/json")) { try{ data=await request.json(); }catch{} }
          else if (ct.includes("multipart/form-data")) { const f=await request.formData(); data={ bg:f.get("bg"), bgOpacity:f.get("bgOpacity"), logo:f.get("logo"), action:f.get("action"), token:f.get("token")||token }; }
          else { const txt=await request.text(); if (txt) try{ data=JSON.parse(txt) }catch{} }
          token = (data.token||token||"").toString();
          if (!env.TOKEN || token !== env.TOKEN) return J({ ok:false, error:"Unauthorized (bad token)" }, 401);

          const action = (data.action||"").toString();
          if (action === "clear") {
            await env.KV.delete("pref:bg"); await env.KV.delete("pref:bgOpacity"); await env.KV.delete("pref:logo");
            return J({ ok:true, cleared:true });
          }

          if (typeof data.bg === "string")  await env.KV.put("pref:bg", data.bg);
          if (data.bgOpacity!=null)         await env.KV.put("pref:bgOpacity", String(parseInt(data.bgOpacity,10)||0));
          if (typeof data.logo === "string") await env.KV.put("pref:logo", data.logo);
          return J({ ok:true, saved:true });
        }

        return J({ ok:false, error:"Method Not Allowed" }, 405);
      }

      // read subscription
      if (request.method === "GET" && path && path !== "/" && !path.startsWith("/api/")) {
        if (!env.KV) return new Response("KV not bound", { status: 500 });
        const seg = path.slice(1);
        const asJson = seg.endsWith(".json");
        const token = asJson ? seg.slice(0, -5) : seg;
        if (!env.TOKEN || token !== env.TOKEN) return new Response("Not Found", { status: 404 });

        const content = await env.KV.get("sub:" + token);
        if (!content) return new Response("Not Found", { status: 404 });

        if (!asJson) {
          return new Response(content, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=60" } });
        } else {
          const meta = await env.KV.get("meta:" + token, "json");
          return J({ ok: true, key: token, ...meta, lines: content.split("\n") });
        }
      }

      // preview
      if (request.method === "POST" && path === "/api/preview") {
        const form = await safeFormData(request);
        if (!form) return J({ ok:false, error:"Invalid form" }, 400);

        // combine text
        const files = form.getAll("files");
        const pasted = (form.get("pasted") || "").toString();
        let combined = "";
        if (files && files.length) for (const f of files) if (f && typeof f.text === "function") combined += (await f.text()) + "\n";
        if (pasted && pasted.trim()) combined += pasted.trim() + "\n";
        combined = combined.trim();
        if (!combined) return J({ ok:false, error:"没有检测到内容（请上传或粘贴）" });

        // options
        const regionLang   = (form.get("regionLang")   || "zh").toString().trim();        // zh | a2
        const regionDetail = (form.get("regionDetail") || "country").toString().trim();   // country | city | country_city
        const decorateFlg  = form.get("decorateFlag") === "on";
        const nodePrefix   = (form.get("nodePrefix") || "").toString();
        const nodeSuffix   = (form.get("nodeSuffix") || "").toString();
        const digits       = clampInt(toPosInt(form.get("digits"), 2), 0, 6);
        const speedMode    = clampInt(toPosInt(form.get("speedMode"), 2), 0, 2); // 0=off,1=number,2=number+unit

        const quotaV4      = toPosInt(form.get("quotaV4"), 0);
        const quotaV6      = toPosInt(form.get("quotaV6"), 0);
        const quotaPerTop  = toPosInt(form.get("quotaPerTop"), 0); // 每国保留前 N 个
        const quotaTopN    = toPosInt(form.get("quotaTopN"), 0);   // 全局前 N
        const maxLinesReq  = toPosInt(form.get("maxLines"), 0);
        const preferLowLat = (form.get("preferLowLat")==="on");

        const outPortSel   = (form.get("outPortSel") || "").toString().trim();
        const outPortCus   = toPosInt(form.get("outPortCus"), 0);
        const domainRemarkMode = (form.get("domainRemarkMode") || "domain").toString(); // off|domain|custom
        const domainRemarkText = (form.get("domainRemarkText") || "").toString().trim();

        // parse CSV/TXT
        const delimiter = sniffDelimiter(combined);
        const rows = parseCSV(combined, delimiter);
        if (!rows.length) return J({ ok:false, error:"CSV/TXT 内容为空" });

        const hasHeader = looksLikeHeader(rows[0]);
        const headers   = hasHeader ? rows[0] : Array.from({ length: rows[0].length }, (_, i) => "列" + (i + 1));
        const dataRows  = hasHeader ? rows.slice(1) : rows;

        // column autodetect
        const lower = headers.map(h => String(h || "").toLowerCase());
        const pick = (goods,bads=[]) => { for(let i=0;i<lower.length;i++){const h=lower[i]; if(goods.some(g=>h.includes(g)) && !bads.some(b=>h.includes(b))) return i;} return -1; };
        let hostIdx   = pick(["ip","ip地址","address","host","域名","domain"]);
        let regionIdx = pick(["region","region_code","country","code","地区码","国家","城市","city","iata","site","location"]);
        let speedIdx  = pick(["下载速度","下载","mb/s","speed","bandwidth","throughput","down","download","rate","峰值","下行","速度"],["延迟","latency","avg","平均延迟","rtt","ping"]);
        let portIdx   = pick(["port","端口"]);
        let latIdx    = pick(["延迟","latency","avg","平均延迟","rtt","ping"]);

        const uiPort = outPortSel === "custom" ? (outPortCus>0? outPortCus : 0) : (outPortSel ? parseInt(outPortSel,10) : 0);

        const stats = {
          rows_total: dataRows.length, headers_count: headers.length,
          ipv4_count: 0, ipv6_count: 0, domain_count: 0,
          with_speed_count: 0, quota_v4: quotaV4, quota_v6: quotaV6,
          limit_maxlines: maxLinesReq, skipped_quota: 0, total_after_quota: 0,
          output_count: 0, skipped_count: 0
        };

        const STOPWORDS = new Set(["ip地址","ip","地址","host","domain","域名","ip address","hostname","server"]);
        const records = [];
        let needsPortButMissing = false, ipRowExists = false;

        function splitHostPort(s){
          s=String(s||"").trim(); if(!s) return {host:"",port:0};

          // bracketed IPv6: [::1]:8443 or [2001:db8::1]
          if (s.startsWith("[")) {
            const idx = s.indexOf("]");
            if (idx > 0) {
              const host = s.slice(1, idx);
              let port = 0;
              const rest = s.slice(idx+1);
              if (rest.startsWith(":")) port = parseInt(rest.slice(1),10)||0;
              return {host,port};
            }
          }

          // bare IPv6 (no brackets, many colons) -> treat as host only
          if (s.includes(":") && !s.includes(".") && s.indexOf(":") !== s.lastIndexOf(":")) {
            return {host:s, port:0};
          }

          // IPv4 or domain with optional :port
          const c = s.lastIndexOf(":");
          if (c>0 && s.indexOf(":")===c) {
            const host=s.slice(0,c), port=parseInt(s.slice(c+1),10)||0;
            return {host,port};
          }
          return {host:s, port:0};
        }

        for (const row of dataRows) {
          const col = (i) => (i>=0 && i<row.length && row[i]!=null) ? String(row[i]).trim() : "";
          const rawHost = col(hostIdx);
          if (!rawHost) { stats.skipped_count++; continue; }

          const { host, port:portInHost } = splitHostPort(rawHost);
          if (!host || STOPWORDS.has(host.toLowerCase())) { stats.skipped_count++; continue; }

          const v4 = isIPv4(host);
          const v6 = !v4 && isIPv6(host);
          const isDomain = !v4 && !v6;

          // port decision
          let finalPort = 0;
          if (v4 || v6) {
            ipRowExists = true;
            finalPort = portInHost || toPosInt(col(portIdx),0) || uiPort || 0;
            if (!uiPort && !portInHost && !col(portIdx)) needsPortButMissing = true;
          }

          // region parse
          const regRaw = col(regionIdx);
          const parsed = codeCityFromAny(regRaw);
          let { a2, sub, cityZh } = parsed;
          const label = formatRegion3({ a2, sub, cityZh, raw:(regRaw||"") }, regionLang, regionDetail);

          // speed / latency
          const spStr = formatSpeedRaw(col(speedIdx), speedMode, digits); // <<< patched
          if (spStr) stats.with_speed_count++;

          let lat = Number.POSITIVE_INFINITY;
          if (latIdx>=0) {
            const m = col(latIdx).match(/-?\d+(?:\.\d+)?/); if (m) { const v=parseFloat(m[0]); if (Number.isFinite(v)) lat=v; }
          }

          // counts
          if (v4) stats.ipv4_count++; else if (v6) stats.ipv6_count++; else stats.domain_count++;

          // build address + remark
          let addrDisp = isDomain ? host : (v4 ? host : "["+host+"]") + (finalPort? (":" + finalPort) : "");
          if (isDomain) { addrDisp = host; } // domain never with port

          const flag = (decorateFlg && a2) ? flagFromA2(a2) : "";
          let remark = "";
          if (isDomain) {
            if (domainRemarkMode === "domain") remark = host;
            else if (domainRemarkMode === "custom" && domainRemarkText) remark = domainRemarkText;
          } else {
            remark = (nodePrefix||"") + (flag||"") + (label||"") + (spStr||"") + (nodeSuffix||"");
          }
          remark = (remark||"").replace(/\s+/g,"");

          records.push({
            a2: (a2||"").toUpperCase() || "XX",
            v4, v6, isDomain,
            lat,
            addr: addrDisp,
            line: addrDisp + "#" + remark
          });
        }

        if (ipRowExists && needsPortButMissing) {
          return J({ ok:false, error:"检测到包含 IP，但未选择输出端口；请在【高级设置 → 输出端口】中选择或填写后再试。" });
        }

        // === COUNTRY-GROUPED SORT ===
        // 1) group by country (a2)
        const gmap = {};
        for (const r of records) {
          const k = r.a2 || "XX";
          (gmap[k] ||= []).push(r);
        }
        // 2) compute min latency per country
        const garr = Object.entries(gmap).map(([k,arr])=>{
          let mn = Infinity;
          for (const r of arr) mn = Math.min(mn, Number.isFinite(r.lat)?r.lat:Infinity);
          return { a2:k, arr, min: mn };
        });
        // 3) sort countries by min latency
        if (preferLowLat) garr.sort((A,B)=> (A.min - B.min));
        // 4) within each country, sort rows by latency
        const ordered = [];
        for (const G of garr) {
          const arr = G.arr.slice();
          if (preferLowLat) arr.sort((a,b)=>( (Number.isFinite(a.lat)?a.lat:Infinity) - (Number.isFinite(b.lat)?b.lat:Infinity) ));
          ordered.push(...arr);
        }

        // apply quotas
        const cntV4 = Object.create(null), cntV6 = Object.create(null), cntPer = Object.create(null);
        const kept = [];
        for (const r of ordered) {
          const key = r.a2 || "XX";
          if (r.v4 && quotaV4>0)   { const c=cntV4[key]||0; if (c>=quotaV4) { stats.skipped_quota++; continue; } cntV4[key]=c+1; }
          if (r.v6 && quotaV6>0)   { const c=cntV6[key]||0; if (c>=quotaV6) { stats.skipped_quota++; continue; } cntV6[key]=c+1; }
          if (quotaPerTop>0)       { const c=cntPer[key]||0; if (c>=quotaPerTop){ stats.skipped_quota++; continue; } cntPer[key]=c+1; }
          kept.push(r);
        }

        const afterTopN = (quotaTopN>0) ? kept.slice(0, quotaTopN) : kept;
        const applied   = (maxLinesReq>0) ? afterTopN.slice(0, maxLinesReq) : afterTopN;

        stats.total_after_quota = afterTopN.length;
        stats.output_count = applied.length;

        const MAX_PREV = 20000;
        const preview  = applied.slice(0, MAX_PREV).map(r=>r.line);

        return J({ ok:true, lines: preview, count: applied.length, headers, stats, truncated: applied.length > MAX_PREV });
      }

      // publish
      if (request.method === "POST" && path === "/api/publish") {
        if (!env.KV)    return J({ ok:false, error:"KV not bound" }, 500);
        if (!env.TOKEN) return J({ ok:false, error:"TOKEN not configured" }, 500);

        const q = new URL(request.url).searchParams;
        let token = q.get("token") || request.headers.get("x-token");
        const ct = request.headers.get("content-type") || "";
        let content = "";

        if (!token && ct.includes("application/json")) {
          try { const jj=await request.json(); token=(jj.token||"").toString(); content=(jj.content||"").toString(); } catch(_){}
        }
        if (!token && ct.includes("multipart/form-data")) {
          const f=await request.formData(); token=(f.get("token")||"").toString(); content=(f.get("content")||"").toString();
        }
        if (!token) { if (ct && !content) content = await request.text(); }

        if (token !== env.TOKEN) return J({ ok:false, error:"Unauthorized (bad token)" }, 401);
        if (!content) { content = await request.text(); if (!content) return J({ ok:false, error:"content is empty" }, 400); }

        const key = env.TOKEN;
        content = content.split("\n").map(s => (s||"").replace(/\s+/g,"")).join("\n");
        await env.KV.put("sub:" + key, content);
        const meta = { updated: Date.now(), count: content ? content.split("\n").length : 0 };
        await env.KV.put("meta:" + key, JSON.stringify(meta));
        return J({ ok:true, key, count: meta.count, updated: meta.updated });
      }

      return new Response("Not Found", { status: 404 });
    } catch (e) {
      return J({ ok:false, error: e && e.message ? e.message : String(e) }, 500);
    }
  }
};

/* ---------------- helpers ---------------- */
function J(obj, status=200){ return new Response(JSON.stringify(obj), { status, headers:{ "content-type":"application/json; charset=utf-8" } }); }
async function safeFormData(req){ try{ return await req.formData(); }catch(_){ return null; } }
function toPosInt(v, d){ const n=parseInt(String(v??"").trim(),10); return Number.isFinite(n)&&n>=0?n:d; }
function clampInt(n,a,b){ return Math.max(a, Math.min(b,n)); }

/* ---------------- CSV ---------------- */
function sniffDelimiter(sample){
  const head=sample.slice(0,10000);
  const c={ ",":(head.match(/,/g)||[]).length, ";":(head.match(/;/g)||[]).length, "\t":(head.match(/\t/g)||[]).length, "|":(head.match(/\|/g)||[]).length };
  const arr=Object.entries(c).sort((a,b)=>b[1]-a[1]);
  return arr[0] ? arr[0][0] : ",";
}
function looksLikeHeader(row){ if(!row||!row.length) return false; return row.some(v=>/[A-Za-z\u4e00-\u9fa5]/.test(String(v||""))); }
function parseCSV(text, d){
  const rows=[]; let i=0, field='', row=[], inQ=false;
  const pf=()=>{row.push(field); field='';}, pr=()=>{rows.push(row); row=[];}
  while(i<text.length){
    const ch=text[i];
    if(inQ){ if(ch=='"'){ const n=text[i+1]; if(n=='"'){ field+='"'; i+=2; continue; } inQ=false; i++; continue; } field+=ch; i++; continue; }
    if(ch=='"'){ inQ=true; i++; continue; }
    if(ch===d){ pf(); i++; continue; }
    if(ch=='\r'){ i++; continue; }
    if(ch=='\n'){ pf(); pr(); i++; continue; }
    field+=ch; i++;
  }
  pf(); if(row.length>1 || row[0]!=='') pr(); return rows;
}

/* ---------------- region/city code ---------------- */

// IATA -> A2/Sub/CityZH (extended core, add HEL)
const IATA_TO_A2 = {
  LAX:"US", SJC:"US", SFO:"US", SEA:"US", DEN:"US", EWR:"US", JFK:"US", IAD:"US", DFW:"US",
  LHR:"GB", MAN:"GB",
  HKG:"HK",
  NRT:"JP", HND:"JP", KIX:"JP", ITM:"JP",
  CDG:"FR", ORY:"FR", FRA:"DE", MUC:"DE", DUS:"DE",
  YYZ:"CA", YVR:"CA", YUL:"CA",
  AMS:"NL", BRU:"BE", DUB:"IE", WAW:"PL", OTP:"RO",
  SIN:"SG", ICN:"KR", ZRH:"CH", BKK:"TH", DXB:"AE",
  HEL:"FI"
};
const IATA_TO_SUB = { LAX:"CA", SJC:"CA", SFO:"CA", SEA:"WA", DEN:"CO", EWR:"NJ", JFK:"NY", IAD:"VA", DFW:"TX", YYZ:"ON" };
const IATA_TO_CITY_ZH = {
  LAX:"洛杉矶", SJC:"圣何塞", SFO:"旧金山", SEA:"西雅图", DEN:"丹佛", EWR:"新泽西", JFK:"纽约", IAD:"华盛顿", DFW:"达拉斯",
  LHR:"伦敦", MAN:"曼彻斯特", HKG:"香港",
  NRT:"东京", HND:"东京", KIX:"大阪", ITM:"大阪",
  CDG:"巴黎", ORY:"巴黎", FRA:"法兰克福", MUC:"慕尼黑", DUS:"杜塞尔多夫",
  YYZ:"多伦多", YVR:"温哥华", YUL:"蒙特利尔",
  AMS:"阿姆斯特丹", BRU:"布鲁塞尔", DUB:"都柏林", WAW:"华沙", OTP:"布加勒斯特",
  SIN:"新加坡", ICN:"首尔", ZRH:"苏黎世", BKK:"曼谷", DXB:"迪拜",
  HEL:"赫尔辛基"
};

// 中文国名补充（主力），优先使用 Intl.DisplayNames
const COUNTRY_ZH = {
  CN:"中国", HK:"香港", MO:"澳门", TW:"台湾",
  US:"美国", GB:"英国", DE:"德国", FR:"法国", NL:"荷兰", BE:"比利时", IE:"爱尔兰", CA:"加拿大", JP:"日本", KR:"韩国", SG:"新加坡",
  IN:"印度", AE:"阿联酋", TR:"土耳其", RU:"俄罗斯", AU:"澳大利亚", ES:"西班牙", IT:"意大利", BR:"巴西", MX:"墨西哥", ZA:"南非",
  CH:"瑞士", TH:"泰国", PL:"波兰", RO:"罗马尼亚", SE:"瑞典", NO:"挪威", DK:"丹麦", FI:"芬兰", PT:"葡萄牙", GR:"希腊",
  AT:"奥地利", CZ:"捷克", HU:"匈牙利", UA:"乌克兰", IL:"以色列", SA:"沙特阿拉伯", EG:"埃及", NG:"尼日利亚", CL:"智利", CO:"哥伦比亚",
  AR:"阿根廷", PE:"秘鲁", NZ:"新西兰"
};
// A3->A2 (常见)
const A3_TO_A2 = { HKG:"HK", MAC:"MO", TWN:"TW", CHN:"CN", USA:"US", JPN:"JP", KOR:"KR", SGP:"SG", MYS:"MY", VNM:"VN", THA:"TH", PHL:"PH", IDN:"ID", IND:"IN",
  GBR:"GB", FRA:"FR", DEU:"DE", ITA:"IT", ESP:"ES", RUS:"RU", CAN:"CA", AUS:"AU", NLD:"NL", BRA:"BR", ARG:"AR", MEX:"MX", TUR:"TR",
  ARE:"AE", ISR:"IL", ZAF:"ZA", SWE:"SE", NOR:"NO", DNK:"DK", FIN:"FI", POL:"PL", CZE:"CZ", AUT:"AT", CHE:"CH", BEL:"BE", IRL:"IE",
  PRT:"PT", GRC:"GR", HUN:"HU", ROU:"RO", UKR:"UA", NZL:"NZ", COL:"CO", PER:"PE", CHL:"CL", SAU:"SA", EGY:"EG", NGA:"NG" };

// 英文城市关键词 -> 中文
const CITY_EN_TO_ZH = {
  "TOKYO":"东京","OSAKA":"大阪","SINGAPORE":"新加坡","SEOUL":"首尔","LONDON":"伦敦","FRANKFURT":"法兰克福","PARIS":"巴黎",
  "AMSTERDAM":"阿姆斯特丹","BRUSSELS":"布鲁塞尔","DUBLIN":"都柏林","MANCHESTER":"曼彻斯特","DUBAI":"迪拜",
  "LOS ANGELES":"洛杉矶","LOSANGELES":"洛杉矶","SEATTLE":"西雅图","SAN FRANCISCO":"旧金山","SANFRANCISCO":"旧金山","SAN JOSE":"圣何塞","SANJOSE":"圣何塞",
  "NEW YORK":"纽约","NEWYORK":"纽约","NEW JERSEY":"新泽西","JERSEY":"新泽西","WASHINGTON":"华盛顿","DALLAS":"达拉斯",
  "TORONTO":"多伦多","VANCOUVER":"温哥华","MONTREAL":"蒙特利尔","WARSAW":"华沙","BUCHAREST":"布加勒斯特","ZURICH":"苏黎世","BANGKOK":"曼谷",
  "HONG KONG":"香港","HONGKONG":"香港","BEIJING":"北京","SHANGHAI":"上海","SHENZHEN":"深圳","GUANGZHOU":"广州","MUMBAI":"孟买","CHENNAI":"金奈",
  "ASHBURN":"阿什本","HELSINKI":"赫尔辛基","DUSSELDORF":"杜塞尔多夫","DÜSSELDORF":"杜塞尔多夫","FRANKFURT AM MAIN":"法兰克福"
};
const CITY_ZH_LIST = [
  "东京","大阪","新加坡","首尔","伦敦","法兰克福","巴黎","阿姆斯特丹","布鲁塞尔","都柏林","曼彻斯特","迪拜",
  "洛杉矶","西雅图","旧金山","圣何塞","纽约","新泽西","华盛顿","达拉斯","苏黎世","曼谷","香港","北京","上海","深圳","广州",
  "多伦多","温哥华","蒙特利尔","华沙","布加勒斯特","孟买","金奈","阿什本","赫尔辛基","杜塞尔多夫"
];

function codeCityFromAny(raw){
  const s0 = String(raw||"").trim();
  if (!s0) return { a2:"", sub:"", cityZh:"" };
  const sU = s0.toUpperCase();

  // US-CA / CN-GD
  let m = sU.match(/\b([A-Z]{2})[-_ ]([A-Z]{2})\b/);
  if (m) return { a2:m[1], sub:m[2], cityZh:"" };

  // IATA / A3
  m = sU.match(/\b([A-Z]{3})\b/);
  if (m) {
    const i=m[1];
    if (IATA_TO_A2[i]) return { a2:IATA_TO_A2[i], sub:(IATA_TO_SUB[i]||""), cityZh:(IATA_TO_CITY_ZH[i]||"") };
    if (A3_TO_A2[i])   return { a2:A3_TO_A2[i], sub:"", cityZh:"" };
  }

  // A2 anywhere
  m = sU.match(/\b([A-Z]{2})\b/);
  if (m) return { a2:m[1], sub:"", cityZh: cityZhFromText(s0) };

  // by city keywords
  const cityZh = cityZhFromText(s0);
  if (cityZh) return { a2: reverseCityToA2(cityZh) || "", sub:"", cityZh };
  return { a2:"", sub:"", cityZh:"" };
}
function cityZhFromText(s){
  const S = s.toUpperCase();
  const mm = S.match(/\b([A-Z]{3})\b/);
  if (mm && IATA_TO_CITY_ZH[mm[1]]) return IATA_TO_CITY_ZH[mm[1]];
  for (const k in CITY_EN_TO_ZH) if (S.includes(k)) return CITY_EN_TO_ZH[k];
  for (const z of CITY_ZH_LIST) if (s.includes(z)) return z;
  return "";
}
function reverseCityToA2(cityZh){
  for (const k in IATA_TO_CITY_ZH) if (IATA_TO_CITY_ZH[k]===cityZh) return IATA_TO_A2[k]||"";
  const map={
    "香港":"HK","东京":"JP","大阪":"JP","新加坡":"SG","首尔":"KR","伦敦":"GB","法兰克福":"DE","巴黎":"FR","阿姆斯特丹":"NL","布鲁塞尔":"BE","都柏林":"IE","曼彻斯特":"GB",
    "迪拜":"AE","洛杉矶":"US","西雅图":"US","旧金山":"US","圣何塞":"US","纽约":"US","新泽西":"US","华盛顿":"US","达拉斯":"US",
    "苏黎世":"CH","曼谷":"TH","多伦多":"CA","温哥华":"CA","蒙特利尔":"CA","华沙":"PL","布加勒斯特":"RO","孟买":"IN","金奈":"IN",
    "北京":"CN","上海":"CN","深圳":"CN","广州":"CN","阿什本":"US","赫尔辛基":"FI","杜塞尔多夫":"DE"
  };
  return map[cityZh]||"";
}
function zhCountryName(a2){
  const A = String(a2||"").toUpperCase();
  if (COUNTRY_ZH[A]) return COUNTRY_ZH[A];
  try{
    if (Intl && Intl.DisplayNames) {
      const dn = new Intl.DisplayNames(['zh-CN','zh'], { type:'region' });
      const n = dn.of(A);
      if (n && n !== A) return n;
    }
  }catch(_){}
  return A || "";
}
function flagFromA2(a2){
  if (!a2 || a2.length!==2) return "";
  const RI=0x1F1E6, A='A'.codePointAt(0); const up=a2.toUpperCase();
  return String.fromCodePoint(RI+(up.codePointAt(0)-A), RI+(up.codePointAt(1)-A));
}
const CITY_STATE_A2 = new Set(["HK","MO","SG"]);
function formatRegion3({a2, sub, cityZh, raw}, lang, mode){
  const baseName = a2 ? zhCountryName(a2) : (raw || "");
  const baseA2   = a2 || (raw || "");
  if (mode === "city") return cityZh || baseName || baseA2;
  if (mode === "country") return (lang==="a2") ? baseA2 : baseName;
  // country_city
  if (!a2) return cityZh || (raw || "");
  if (!cityZh || CITY_STATE_A2.has(a2)) return (lang==="a2") ? baseA2 : baseName;
  return (lang==="a2") ? (a2 + cityZh) : (baseName + cityZh);
}

/* ---------------- net & speed ---------------- */
function isIPv4(v){ return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(String(v||"")); }

// Safer IPv6 check without giant fragile regex
function isIPv6(v){
  v=String(v||"").trim();
  if (!v) return false;
  if (v.startsWith("[") && v.endsWith("]")) v=v.slice(1,-1);
  if (!v.includes(":")) return false;
  // quick sanity: only hex, colon and optional dots (for v4-mapped)
  if (!/^[0-9a-fA-F:.]+$/.test(v)) return false;
  // at least 2 colons for IPv6 patterns
  const parts = v.split(":");
  if (parts.length < 3) return false;
  return true;
}

// Convert any speed string to MB/s number (decimal MB), or NaN if not parseable
function parseSpeedToMBps(raw){
  if (!raw) return NaN;
  const o = String(raw).trim();
  if (!o) return NaN;
  const numMatch = o.replace(/,/g,'').match(/-?\d+(?:\.\d+)?/);
  if (!numMatch) return NaN;
  const val = parseFloat(numMatch[0]);
  if (!Number.isFinite(val)) return NaN;

  const lc = o.toLowerCase().replace(/\s+/g,'');

  // Binary bytes first (KiB/MiB/GiB/TiB per second)
  if (/tib(?:\/s|ps)?/.test(lc)) return (val * Math.pow(1024,4)) / 1e6;
  if (/gib(?:\/s|ps)?/.test(lc)) return (val * Math.pow(1024,3)) / 1e6;
  if (/mib(?:\/s|ps)?/.test(lc)) return (val * Math.pow(1024,2)) / 1e6;
  if (/kib(?:\/s|ps)?/.test(lc)) return (val * 1024) / 1e6;

  // Decimal BYTES with uppercase B (kB/MB/GB/TB per second)
  if (/tb(?:\/s|ps)?/.test(lc) && /b(?!it)/.test(lc)) return (val * 1e12) / 1e6; // TB/s
  if (/gb(?:\/s|ps)?/.test(lc) && /b(?!it)/.test(lc)) return (val * 1e9) / 1e6;  // GB/s
  if (/mb(?:\/s|ps)?/.test(lc) && /b(?!it)/.test(lc)) return (val * 1e6) / 1e6;  // MB/s
  if (/kb(?:\/s|ps)?/.test(lc) && /b(?!it)/.test(lc)) return (val * 1e3) / 1e6;  // kB/s

  // Decimal BITS (kb/s, kbps, Mb/s, Mbps, Gb/s, Gbps...)
  if (/(?:tbps|tbit\/s|tb\/s)/.test(lc)) return (val * 1e12) / 8 / 1e6;
  if (/(?:gbps|gbit\/s|gb\/s)/.test(lc)) return (val * 1e9) / 8 / 1e6;
  if (/(?:mbps|mbit\/s|mb\/s)/.test(lc)) return (val * 1e6) / 8 / 1e6;
  if (/(?:kbps|kbit\/s|kb\/s)/.test(lc)) return (val * 1e3) / 8 / 1e6;

  // Fallback: treat bare number as already MB/s
  return val;
}

// speedMode: 0=off,1=number,2=number+MB/s
function formatSpeedRaw(raw, speedMode, digits){
  if (speedMode===0) return ""; // off
  raw = String(raw||"").trim();
  if (!raw) return "";
  let valMB = parseSpeedToMBps(raw);
  if (!Number.isFinite(valMB)) return "";

  const body = (digits===0) ? String(Math.round(valMB)) : Number(valMB).toFixed(digits);
  if (speedMode===1) return body;
  return body + "MB/s"; // mode 2
}

/* ---------------- UI (HTML) ---------------- */
const HTML = `<!doctype html>
<html lang="zh" data-theme="light">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>YouXuan-API</title>
<style>
:root{
  --bg:#ffffff; --card:rgba(255,255,255,.6); --text:#0b1220; --muted:#6b7280; --border:#e5e7eb;
  --primary:#3b82f6; --accent:#8b5cf6; --shadow:0 18px 40px rgba(0,0,0,.08);
  --pill:#f3f4f6; --link:#2563eb;
}
html[data-theme="dark"]{
  --bg:#000000; --card:rgba(8,12,24,.6); --text:#e5e7eb; --muted:#9ca3af; --border:#1f2937;
  --primary:#60a5fa; --accent:#a78bfa; --shadow:0 24px 60px rgba(0,0,0,.35);
  --pill:#0b1220; --link:#93c5fd;
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,PingFang SC,Microsoft YaHei,Helvetica,Arial;position:relative}
#wp{position:fixed;inset:0;background-position:center;background-size:cover;opacity:.22;filter:blur(12px) saturate(1.15);pointer-events:none;z-index:-1;display:none}
.center{min-height:100dvh;display:grid;place-items:start center;padding:72px 12px 40px}
.container{width:min(1100px,96vw)}
.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}
.brand{display:flex;align-items:center;gap:12px}
.logoWrap{width:52px;height:52px;border-radius:16px;overflow:hidden;box-shadow:0 12px 28px rgba(59,130,246,.35);display:grid;place-items:center;background:transparent}
.logoWrap img{width:100%;height:100%;object-fit:cover;display:block}
.title{font-size:26px;font-weight:900}
.header-right{display:flex;align-items:center;gap:10px}
.pill{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--border);background:var(--pill);padding:8px 12px;border-radius:999px;font-weight:700;color:var(--text);text-decoration:none}
.btn{display:inline-flex;align-items:center;gap:10px;background:linear-gradient(90deg,var(--primary),var(--accent));border:none;border-radius:12px;padding:12px 16px;color:#fff;cursor:pointer;font-weight:800}
.btn.secondary{background:transparent;color:var(--text);border:1px solid var(--border)}
.card{background:var(--card);backdrop-filter:blur(14px) saturate(1.2);border:1px solid rgba(255,255,255,.35);border-radius:16px;box-shadow:var(--shadow)}
html[data-theme="dark"] .card{border-color:rgba(148,163,184,.18)}
.card.pad{padding:18px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media (max-width: 720px){ .row{grid-template-columns:1fr} .title{font-size:22px} .logoWrap{width:44px;height:44px} }
label{display:block;margin:10px 0 8px;font-weight:700}
small.help{display:block;color:var(--muted);margin-top:4px}
textarea,input[type="text"],input[type="number"],select{width:100%;padding:12px 14px;border-radius:12px;border:1px solid var(--border);background:transparent;color:var(--text)}
textarea{min-height:54px}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}
input[type="file"]{display:none}
/* chips */
.filebox{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.uploadBtn{display:inline-flex;align-items:center;gap:8px;background:linear-gradient(90deg,var(--primary),var(--accent));border:none;border-radius:12px;padding:10px 14px;color:#fff;cursor:pointer;font-weight:800}
.filechips{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px}
.chip{position:relative;display:inline-flex;align-items:center;gap:10px;border:1px solid var(--border);background:rgba(255,255,255,.65);backdrop-filter:blur(8px);border-radius:12px;padding:8px 12px;box-shadow:0 4px 10px rgba(0,0,0,.05)}
html[data-theme="dark"] .chip{background:rgba(8,12,24,.65)}
.gridIcon{width:28px;height:28px;border-radius:8px;background:#10b981;display:grid;place-items:center;color:#fff;font-weight:900}
.chip .x{position:absolute;top:-6px;right:-6px;width:20px;height:20px;border:none;border-radius:50%;background:#00000022;color:#111;cursor:pointer}
html[data-theme="dark"] .chip .x{background:#ffffff33;color:#fff}
.chip .eye{border:none;background:transparent;cursor:pointer}
/* modal & toast */
.modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.35);padding:18px;z-index:50}
.panel{max-width:900px;width:100%;border-radius:16px;padding:18px;background:var(--card);backdrop-filter:blur(14px) saturate(1.2);border:1px solid rgba(255,255,255,.35)}
html[data-theme="dark"] .panel{border-color:rgba(148,163,184,.18)}
.panel .title{font-weight:900;margin-bottom:8px}
.actions{display:flex;justify-content:flex-end;gap:10px;margin-top:10px}
.toast{position:fixed;right:18px;bottom:18px;background:var(--card);border:1px solid var(--border);color:var(--text);padding:12px 16px;border-radius:12px;opacity:0;transform:translateY(10px);transition:all .25s ease;z-index:60}
.toast.show{opacity:1;transform:translateY(0)}
</style>
</head>
<body>
<div id="wp"></div>
  <div class="center">
    <div class="container">
      <div class="header">
        <div class="brand">
          <div class="logoWrap"><img id="logoImg" alt="logo"/></div>
          <div class="title">YouXuan-API</div>
        </div>
        <div class="header-right">
          <div class="pill" id="kvPill"><span id="kvDot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#9ca3af"></span>&nbsp;<span id="kvText">KV 未绑定</span></div>
          <button class="pill" id="themeBtn" type="button">🌙 深色</button>
          <a class="pill" href="${REPO}" target="_blank" style="color:var(--text)">GitHub</a>
        </div>
      </div>

      <div class="card pad">
        <div class="row">
          <div>
            <label>上传文件（可多次追加）</label>
            <div class="filebox">
              <label class="uploadBtn" for="files">📂 选择文件</label>
              <input type="file" id="files" name="files" multiple />
              <button class="btn secondary" id="previewAll" type="button">👁 预览全部</button>
            </div>
            <div id="chips" class="filechips"></div>
          </div>

          <div>
            <label>或直接粘贴文本</label>
            <textarea id="pasted" rows="4" placeholder="可粘贴优选域名（如：visa.cn）或整段 CSV/TXT。域名不输出端口；IP 未写端口时，请在“高级设置→输出端口”选择。"></textarea>
          </div>
        </div>

        <div class="row">
          <div>
            <label>订阅上传 Token</label>
            <input type="text" id="token" placeholder="与服务端 TOKEN 一致（仅上传/保存默认时必填）"/>
            <small class="help">订阅地址不在前端显示；在浏览器访问 <code>/{TOKEN}</code>（服务器 Secret）即可获取。</small>
          </div>
          <div>
            <label>操作</label>
            <div style="display:flex;gap:10px;flex-wrap:wrap">
              <button class="btn" id="go" type="button">🚀 生成预览</button>
              <button class="btn secondary" id="upload" type="button">⬆️ 上传订阅</button>
              <button class="btn secondary" id="statsBtn" type="button">📊 查看统计</button>
              <button class="btn secondary" id="copy" type="button">📋 复制全部</button>
              <button class="btn secondary" id="personalBtn" type="button">🎨 个性化设置</button>
              <button class="btn secondary" id="advBtn" type="button">⚙️ 高级设置</button>
              <button class="btn secondary" id="quotaBtn" type="button">🧮 配额与限制</button>
            </div>
          </div>
        </div>
      </div>

      <div class="card pad" style="margin-top:14px">
        <div class="progress" id="progWrap" style="display:none"><div class="bar" id="bar" style="height:10px;background:linear-gradient(90deg,var(--primary),var(--accent));border-radius:999px;width:0%"></div></div>
        <textarea id="out" class="mono" rows="18" placeholder="点击“生成预览”后在此显示结果"></textarea>
        <div id="miniStats" class="muted" style="margin-top:8px;line-height:1.8"></div>
      </div>
    </div>
  </div>

  <!-- 文件预览 -->
  <div class="modal" id="previewModal">
    <div class="panel">
      <div class="title">预览（前 50 行）</div>
      <pre id="previewBox" class="mono" style="white-space:pre-wrap;max-height:60vh;overflow:auto"></pre>
      <div class="actions"><button class="btn secondary" id="closePreview" type="button">关闭</button></div>
    </div>
  </div>

  <!-- 个性化设置 -->
  <div class="modal" id="personalModal">
    <div class="panel">
      <div class="title">个性化设置</div>
      <div class="row">
        <div>
          <label>上传背景（全站默认）</label>
          <input type="file" id="bgFile" accept="image/*"/>
          <label class="uploadBtn" for="bgFile">🖼️ 选择背景</label>
          <button class="btn secondary" id="resetBg" type="button">↺ 恢复默认（跟随主题黑/白）</button>
          <label style="margin-top:10px">背景透明度</label>
          <input type="range" id="bgOpacity" min="0" max="100" step="1" value="22" />
          <small class="help">自定义背景生效时可调（0%—100%）。默认背景为纯黑/白。</small>
        </div>
        <div>
          <label>上传 Logo（全站默认）</label>
          <input type="file" id="logoFile" accept="image/*"/>
          <label class="uploadBtn" for="logoFile">🎯 选择 Logo</label>
          <button class="btn secondary" id="resetLogo" type="button">↺ 恢复默认 Logo</button>
        </div>
      </div>
      <div class="actions">
        <button class="btn secondary" id="savePrefs" type="button">💾 保存为默认（全站）</button>
        <button class="btn secondary" id="clearPrefs" type="button">🗑 清除服务端默认</button>
        <button class="btn secondary" id="closePersonal" type="button">关闭</button>
      </div>
    </div>
  </div>

  <!-- 高级设置 -->
  <div class="modal" id="advModal">
    <div class="panel">
      <div class="title">高级设置</div>
      <div class="row">
        <div>
          <label>地区显示</label>
          <div class="row">
            <select id="regionLang">
              <option value="zh" selected>中文</option>
              <option value="a2">英文缩写（A2）</option>
            </select>
            <select id="regionDetail">
              <option value="country" selected>仅国家</option>
              <option value="city">仅城市（若识别）</option>
              <option value="country_city">国家+城市（若识别）</option>
            </select>
          </div>
          <label class="muted" style="margin-top:6px"><input type="checkbox" id="decorateFlag" checked/> 备注前加国旗</label>
        </div>
        <div>
          <label>节点前缀 / 后缀</label>
          <div class="row">
            <input type="text" id="nodePrefix" placeholder="前缀（可空）"/>
            <input type="text" id="nodeSuffix" placeholder="后缀（可空）"/>
          </div>
        </div>
      </div>

      <div class="row">
        <div>
          <label>速度显示</label>
          <div class="row">
            <select id="speedMode">
              <option value="0">不显示</option>
              <option value="1">仅数字</option>
              <option value="2" selected>数字+单位（MB/s）</option>
            </select>
            <select id="digits">
              <option value="2" selected>保留 2 位小数</option>
              <option value="0">保留 0 位小数</option>
            </select>
          </div>
          <small class="help">自动识别并换算 kb/s、kbps、Mb/s、Mbps、KiB/s 等到 MB/s；选择“0 不显示”则完全不拼接速度。</small>
        </div>
        <div>
          <label>输出端口（仅对 IP 生效；域名不带端口）</label>
          <div class="row">
            <select id="outPortSel">
              <option value="">请选择</option>
              <option value="443">443</option>
              <option value="8443">8443</option>
              <option value="2053">2053</option>
              <option value="2083">2083</option>
              <option value="2087">2087</option>
              <option value="2096">2096</option>
              <option value="custom">自定义</option>
            </select>
            <input type="number" id="outPortCus" placeholder="自定义端口"/>
          </div>
          <small class="help">若 IP 未自带端口，将使用此处选择的端口；未选择时会提示。</small>
        </div>
      </div>

      <div class="row">
        <div>
          <label>优选域名备注</label>
          <div class="row">
            <select id="domainRemarkMode">
              <option value="off">不自动添加</option>
              <option value="domain" selected>使用域名作为备注</option>
              <option value="custom">自定义文本</option>
            </select>
            <input type="text" id="domainRemarkText" placeholder="自定义备注文本（仅当选择“自定义”时）"/>
          </div>
          <small class="help">仅对优选域名生效（如 visa.cn）；IP 不套此规则。</small>
        </div>
        <div></div>
      </div>

      <div class="actions"><button class="btn secondary" id="closeAdv" type="button">关闭</button></div>
    </div>
  </div>

  <!-- 配额与限制 -->
  <div class="modal" id="quotaModal">
    <div class="panel">
      <div class="title">配额与限制</div>

      <div class="row">
        <div>
          <label>每个国家分别：保留 IPv4 数量</label>
          <input type="number" id="quotaV4" min="0" placeholder="0 = 不限制"/>
          <small class="help">示例：填 3 表示每个国家最多保留 3 个 IPv4。</small>
        </div>
        <div>
          <label>每个国家分别：保留 IPv6 数量</label>
          <input type="number" id="quotaV6" min="0" placeholder="0 = 不限制"/>
          <small class="help">示例：填 2 表示每个国家最多保留 2 个 IPv6。</small>
        </div>
      </div>

      <div class="row">
        <div>
          <label>每个国家分别：保留前多少个 IP</label>
          <input type="number" id="quotaPerTop" min="0" placeholder="0 = 不限制"/>
          <small class="help">同时对 IPv4/IPv6 生效，按排序后的前 N 条截取。</small>
        </div>
        <div>
          <label>不按国家：仅保留前 N 个</label>
          <input type="number" id="quotaTopN" min="0" placeholder="0 = 不限制"/>
          <small class="help">全局前 N；常用于生成小样本订阅。</small>
        </div>
      </div>

      <div class="row">
        <div>
          <label>最终保留前 N 行（全局）</label>
          <input type="number" id="maxLines" min="0" placeholder="0 = 不限制"/>
          <small class="help">应用完上面所有限制后，再整体截取。</small>
        </div>
        <div>
          <label>排序与优先级</label>
          <label class="muted"><input type="checkbox" id="preferLowLat" checked/> 若检测到“延迟/latency/ping”等列，则按“国家最小延迟 → 行延迟”升序排序</label>
          <small class="help">延迟列不存在时，不影响原顺序。</small>
        </div>
      </div>

      <div class="actions"><button class="btn secondary" id="closeQuota" type="button">关闭</button></div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

<script>
(function(){
  function $(id){return document.getElementById(id)}
  function toast(t,k){var x=$('toast');x.textContent=t;x.style.borderColor=(k==='error')?'#ef4444':(k==='success')?'#10b981':'#e5e7eb';x.classList.add('show');setTimeout(function(){x.classList.remove('show')},2200)}
  function openM(m){m.style.display='flex'} function closeM(m){m.style.display='none'}

  // Theme + default bg (white/black)
  var TH='YX:theme', th=localStorage.getItem(TH)||'light';
  applyTheme(th);
  $('themeBtn').onclick=function(){var next=document.documentElement.dataset.theme==='light'?'dark':'light';applyTheme(next);localStorage.setItem(TH,next);applyBgFromState();};
  function applyTheme(t){document.documentElement.dataset.theme=t;$('themeBtn').textContent=(t==='light'?'🌙 深色':'🌞 浅色')}

  // KV status
  fetch('/api/status').then(r=>r.json()).then(s=>{ $('kvText').textContent='KV '+(s.kvBound?'已绑定':'未绑定'); $('kvDot').style.background=s.kvBound?'#10b981':'#9ca3af'; }).catch(()=>{});

  // Try load server-side prefs (cross-device)
  fetch('/api/prefs').then(r=>r.json()).then(p=>{
    if(p&&p.ok&&p.prefs){ if(p.prefs.bg){ localStorage.setItem('YX:bg',p.prefs.bg); }
      if(typeof p.prefs.bgOpacity==='number'){ localStorage.setItem('YX:bgOpacity', String(p.prefs.bgOpacity)); }
      if(p.prefs.logo){ localStorage.setItem('YX:logo',p.prefs.logo); }
    }
    applyBgFromState(); applyLogo(localStorage.getItem('YX:logo'));
    const op = localStorage.getItem('YX:bgOpacity') || 22; $('bgOpacity').value = op; applyBgOpacity(op);
  }).catch(()=>{ applyBgFromState(); applyLogo(localStorage.getItem('YX:logo')); });

  const DEFAULT_LOGO = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect rx="24" ry="24" width="128" height="128" fill="%230b5cff"/><text x="64" y="78" font-family="Arial" font-size="56" text-anchor="middle" fill="white" font-weight="900">YX</text></svg>';
  function applyLogo(src){ $('logoImg').src = src || DEFAULT_LOGO; }

  function applyBg(data){ if (data){ $('wp').style.backgroundImage = 'url('+data+')'; $('wp').style.display='block'; } else { $('wp').style.backgroundImage='none'; $('wp').style.display='none'; } }
  function applyBgOpacity(val){ $('wp').style.opacity = String(Math.max(0,Math.min(100,parseInt(val||'22',10)))/100); }
  function applyBgFromState(){ const data=localStorage.getItem('YX:bg'); if (data){ applyBg(data); } else { applyBg(''); } }

  // bind uploads
  function bindDataFile(inpId, key, okCb){
    const el=$(inpId);
    el.addEventListener('change', function(){
      try{
        const f=el.files&&el.files[0]; if(!f){toast('未选择文件','error');return;}
        const r=new FileReader();
        r.onload=function(){ localStorage.setItem(key, r.result); okCb(r.result); toast('已更新（本地）','success'); };
        r.onerror=function(){ toast('读取失败','error'); };
        r.readAsDataURL(f);
      }catch(e){ toast('上传失败：'+(e&&e.message?e.message:e),'error'); }
      el.value='';
    });
  }
  bindDataFile('bgFile','YX:bg',applyBg);
  bindDataFile('logoFile','YX:logo',applyLogo);

  $('bgOpacity').addEventListener('input', function(){ localStorage.setItem('YX:bgOpacity', this.value); applyBgOpacity(this.value); });
  $('resetBg').onclick=function(){ localStorage.removeItem('YX:bg'); applyBgFromState(); toast('已切回默认背景（随主题）','success'); };
  $('resetLogo').onclick=function(){ localStorage.removeItem('YX:logo'); applyLogo(''); toast('已恢复默认 Logo','success'); };

  // save/clear server defaults
  $('savePrefs').onclick=async function(){
    const t=$('token').value||''; if(!t){ toast('请在上方填写 TOKEN 再保存','error'); return; }
    try{
      const res=await fetch('/api/prefs',{method:'POST',headers:{'content-type':'application/json','x-token':t},body:JSON.stringify({bg:localStorage.getItem('YX:bg')||'', bgOpacity:parseInt(localStorage.getItem('YX:bgOpacity')||'22',10), logo:localStorage.getItem('YX:logo')||''})});
      const j=await res.json(); if(!j.ok) throw new Error(j.error||'保存失败'); toast('已保存为全站默认','success');
    }catch(e){ toast('保存失败：'+(e&&e.message?e.message:e),'error'); }
  };
  $('clearPrefs').onclick=async function(){
    const t=$('token').value||''; if(!t){ toast('请在上方填写 TOKEN 再清除','error'); return; }
    try{
      const res=await fetch('/api/prefs',{method:'POST',headers:{'content-type':'application/json','x-token':t},body:JSON.stringify({action:'clear'})});
      const j=await res.json(); if(!j.ok) throw new Error(j.error||'清除失败'); toast('已清除服务端默认','success');
    }catch(e){ toast('清除失败：'+(e&&e.message?e.message:e),'error'); }
  };

  // Multi-file append
  let fileList=[];
  function uniqKey(f){ return [f.name,f.size,f.lastModified].join('|'); }
  $('files').addEventListener('change', function(){
    const arr=Array.from(this.files||[]); const map=new Set(fileList.map(uniqKey));
    arr.forEach(f=>{ const k=uniqKey(f); if(!map.has(k)){ fileList.push(f); map.add(k);} });
    this.value=''; renderChips();
  });
  const chips=$('chips');
  function renderChips(){
    chips.innerHTML=''; fileList.forEach((f,idx)=>{ const chip=document.createElement('div'); chip.className='chip';
      const icon=document.createElement('div'); icon.className='gridIcon'; icon.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"></rect><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>';
      const name=document.createElement('div'); name.textContent=f.name;
      const eye=document.createElement('button'); eye.className='eye'; eye.textContent='👁'; eye.title='预览此文件';
      eye.onclick=async()=>{ const t=await f.text(); $('previewBox').textContent=t.split('\\n').slice(0,50).join('\\n'); openM($('previewModal')); };
      const x=document.createElement('button'); x.className='x'; x.textContent='×'; x.onclick=()=>{ fileList.splice(idx,1); renderChips(); };
      chip.appendChild(icon); chip.appendChild(name); chip.appendChild(eye); chip.appendChild(x); chips.appendChild(chip);
    });
  }
  $('previewAll').onclick=async function(){ if(!fileList.length){ toast('请先选择文件','error'); return; } let all=''; for(const f of fileList){ all += (await f.text()) + '\\n'; } $('previewBox').textContent=all.trim().split('\\n').slice(0,50).join('\\n'); openM($('previewModal')); };
  $('closePreview').onclick=function(){ closeM($('previewModal')); };

  // Persisted settings
  const nodePrefix=$('nodePrefix'), nodeSuffix=$('nodeSuffix'), decorateFlag=$('decorateFlag');
  const digits=$('digits'), speedMode=$('speedMode');
  const quotaV4=$('quotaV4'), quotaV6=$('quotaV6'), maxLines=$('maxLines'), quotaPerTop=$('quotaPerTop'), quotaTopN=$('quotaTopN'), preferLowLat=$('preferLowLat');
  const regionLang=$('regionLang'), regionDetail=$('regionDetail');
  const token=$('token');
  const outPortSel=$('outPortSel'), outPortCus=$('outPortCus');
  const domainRemarkMode=$('domainRemarkMode'), domainRemarkText=$('domainRemarkText');
  const LS='YX:cfg:';
  function load(k,d){ return localStorage.getItem(LS+k) ?? d; }
  function save(k,v){ localStorage.setItem(LS+k, v); }

  nodePrefix.value = load('nodePrefix','');   nodeSuffix.value = load('nodeSuffix','');

  // speedMode & digits
  speedMode.value = load('speedMode','2');
  digits.value = load('digits','2');

  quotaV4.value = load('quotaV4','0');  quotaV6.value = load('quotaV6','0');
  quotaPerTop.value = load('quotaPerTop','0'); quotaTopN.value = load('quotaTopN','0'); maxLines.value = load('maxLines','0');
  preferLowLat.checked = load('preferLowLat','1')!=='0';

  regionLang.value = load('regionLang','zh'); regionDetail.value = load('regionDetail','country');
  decorateFlag.checked = load('decorateFlag','1')!=='0'; token.value = load('token','');

  outPortSel.value = load('outPortSel',''); outPortCus.value = load('outPortCus','');
  domainRemarkMode.value = load('domainRemarkMode','domain'); domainRemarkText.value = load('domainRemarkText','');

  ['input','change'].forEach(ev=>{
    nodePrefix.addEventListener(ev,()=>save('nodePrefix',nodePrefix.value||''));   nodeSuffix.addEventListener(ev,()=>save('nodeSuffix',nodeSuffix.value||''));
    digits.addEventListener(ev,()=>save('digits',digits.value||'2'));
    speedMode.addEventListener(ev,()=>save('speedMode',speedMode.value||'2'));

    quotaV4.addEventListener(ev,()=>save('quotaV4',quotaV4.value||'0'));  quotaV6.addEventListener(ev,()=>save('quotaV6',quotaV6.value||'0'));
    quotaPerTop.addEventListener(ev,()=>save('quotaPerTop',quotaPerTop.value||'0')); quotaTopN.addEventListener(ev,()=>save('quotaTopN',quotaTopN.value||'0')); maxLines.addEventListener(ev,()=>save('maxLines',maxLines.value||'0'));
    preferLowLat.addEventListener(ev,()=>save('preferLowLat',preferLowLat.checked?'1':'0'));
    regionLang.addEventListener(ev,()=>save('regionLang',regionLang.value||'zh')); regionDetail.addEventListener(ev,()=>save('regionDetail',regionDetail.value||'country'));
    decorateFlag.addEventListener(ev,()=>save('decorateFlag',decorateFlag.checked?'1':'0')); token.addEventListener(ev,()=>save('token',token.value||''));
    outPortSel.addEventListener(ev,()=>save('outPortSel',outPortSel.value||'')); outPortCus.addEventListener(ev,()=>save('outPortCus',outPortCus.value||''));
    domainRemarkMode.addEventListener(ev,()=>save('domainRemarkMode',domainRemarkMode.value||'domain')); domainRemarkText.addEventListener(ev,()=>save('domainRemarkText',domainRemarkText.value||''));
  });

  // open modals
  $('personalBtn').onclick=function(){ openM($('personalModal')); };
  $('advBtn').onclick=function(){ openM($('advModal')); };
  $('quotaBtn').onclick=function(){ openM($('quotaModal')); };
  $('closePersonal').onclick=function(){ closeM($('personalModal')); };
  $('closeAdv').onclick=function(){ closeM($('advModal')); };
  $('closeQuota').onclick=function(){ closeM($('quotaModal')); };

  // progress + actions
  var go=$('go'), upload=$('upload'), copy=$('copy'), statsBtn=$('statsBtn');
  var out=$('out'), progWrap=$('progWrap'), bar=$('bar'), mini=$('miniStats');
  function showProg(){ progWrap.style.display='block'; bar.style.width='0%'; }

  var last=null;
  go.onclick=async function(){
    try{
      go.disabled=true; out.value=''; mini.textContent=''; showProg(); await new Promise(r=>setTimeout(r,60));

      var fd=new FormData();
      (fileList||[]).forEach(f=>fd.append('files',f));
      fd.append('pasted',$('pasted').value||'');

      // advanced
      fd.append('nodePrefix',nodePrefix.value||''); fd.append('nodeSuffix',nodeSuffix.value||'');
      fd.append('digits',digits.value||'2');
      fd.append('speedMode',speedMode.value||'2'); // <<< patched
      fd.append('regionLang',regionLang.value||'zh'); fd.append('regionDetail',regionDetail.value||'country');
      if(decorateFlag.checked) fd.append('decorateFlag','on');
      fd.append('outPortSel',outPortSel.value||''); fd.append('outPortCus',outPortCus.value||'');
      fd.append('domainRemarkMode',domainRemarkMode.value||'domain'); fd.append('domainRemarkText',domainRemarkText.value||'');

      // quotas & sort
      fd.append('quotaV4',quotaV4.value||'0');  fd.append('quotaV6',quotaV6.value||'0');
      fd.append('quotaPerTop',quotaPerTop.value||'0'); fd.append('quotaTopN',quotaTopN.value||'0'); fd.append('maxLines',maxLines.value||'0');
      if(preferLowLat.checked) fd.append('preferLowLat','on');

      const res=await fetch('/api/preview',{method:'POST',body:fd});
      const j=await res.json();
      if(!j.ok) throw new Error(j.error||'未知错误');
      bar.style.width='100%'; out.value=(j.lines||[]).join('\\n'); last=j;

      const s=j.stats||{};
      mini.textContent=[
        '输入总行数:'+(s.rows_total??'—'),
        'IPv4:'+(s.ipv4_count??'—'),
        'IPv6:'+(s.ipv6_count??'—'),
        '域名:'+(s.domain_count??'—'),
        '带速度:'+(s.with_speed_count??'—'),
        '配额后行数:'+(s.total_after_quota??'—'),
        '最终输出行数:'+(s.output_count??(j.count??'—'))
      ].join('  ·  ');

      toast('处理完成 ✓','success');
    }catch(e){ toast('处理失败：'+(e&&e.message?e.message:e),'error'); }
    finally{ go.disabled=false; setTimeout(()=>{progWrap.style.display='none';bar.style.width='0%';},400); }
  };

  copy.onclick=async function(){
    try{ out.select(); document.execCommand('copy'); toast('已复制','success'); }
    catch(e){ try{ await navigator.clipboard.writeText(out.value); toast('已复制','success'); } catch(_){ toast('复制失败','error'); } }
  };

  $('statsBtn').onclick=function(){
    const j=last||{}; const s=j.stats||{};
    const box = [
      '=== 统计明细 ===',
      '表头列数: '+(s.headers_count??'—'),
      '输入总行数: '+(s.rows_total??'—'),
      'IPv4: '+(s.ipv4_count??'—'),
      'IPv6: '+(s.ipv6_count??'—'),
      '域名: '+(s.domain_count??'—'),
      '带速度: '+(s.with_speed_count??'—'),
      '每国 IPv4: '+(s.quota_v4??0),
      '每国 IPv6: '+(s.quota_v6??0),
      '每国前 N: '+(document.getElementById('quotaPerTop').value||0),
      '全局前 N: '+(document.getElementById('quotaTopN').value||0),
      '最终前 N: '+(s.limit_maxlines? s.limit_maxlines : '不限制'),
      '因配额跳过: '+(s.skipped_quota??0),
      '配额后行数: '+(s.total_after_quota??'—'),
      '最终返回行数: '+(j.count??'—')+(j.truncated?'（预览截断）':'')
    ].join('\\n');
    $('previewBox').textContent = box; openM($('previewModal'));
  };

  upload.onclick=async function(){
    if(!last || !last.lines || !last.lines.length){ toast('请先生成预览','error'); return; }
    if(!token.value){ toast('请填写验证 Token','error'); $('token').focus(); return; }
    try{
      const res=await fetch('/api/publish?token='+encodeURIComponent(token.value),{method:'POST',headers:{'content-type':'text/plain; charset=utf-8'},body:last.lines.join('\\n')});
      const j=await res.json(); if(!j.ok) throw new Error(j.error||'发布失败');
      toast('已上传','success');
    }catch(e){ toast('上传失败：'+(e&&e.message?e.message:e),'error'); }
  };

})();
</script>
</body>
</html>`;
