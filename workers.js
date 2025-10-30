// worker.js
// YouXuan-API — Cloudflare Worker (修正版)

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
        const minSpeed     = parseFloat(form.get("minSpeed")) || 0; // 最小速度过滤

        const quotaV4      = toPosInt(form.get("quotaV4"), 0);
        const quotaV6      = toPosInt(form.get("quotaV6"), 0);
        const quotaPerTop  = toPosInt(form.get("quotaPerTop"), 0); // 每国保留前 N 个
        const quotaTopN    = toPosInt(form.get("quotaTopN"), 0);   // 全局前 N
        const maxLinesReq  = toPosInt(form.get("maxLines"), 0);
        const preferLowLat = (form.get("preferLowLat")==="on");
        const saveMode     = (form.get("saveMode") || "overwrite").toString(); // 保存模式

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
          output_count: 0, skipped_count: 0, skipped_speed: 0, skipped_latency: 0
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
          const spStr = formatSpeedRaw(col(speedIdx), speedMode, digits);
          const speedMB = parseSpeedToMBps(col(speedIdx)); // 获取速度数值用于过滤
          if (spStr) stats.with_speed_count++;

          let lat = Number.POSITIVE_INFINITY;
          if (latIdx>=0) {
            const m = col(latIdx).match(/-?\d+(?:\.\d+)?/); if (m) { const v=parseFloat(m[0]); if (Number.isFinite(v)) lat=v; }
          }

          // 速度过滤
          if (minSpeed > 0 && (!Number.isFinite(speedMB) || speedMB < minSpeed)) {
            stats.skipped_speed++;
            continue;
          }

          // counts
          if (v4) stats.ipv4_count++; else if (v6) stats.ipv6_count++; else stats.domain_count++;

          // build address + remark
          let addrDisp = "";
          if (isDomain) {
            addrDisp = host; // domain never with port
          } else {
            // 对于IP地址，确保格式正确
            if (v4) {
              addrDisp = host + (finalPort ? ":" + finalPort : "");
            } else {
              // IPv6 地址用中括号括起来
              addrDisp = "[" + host + "]" + (finalPort ? ":" + finalPort : "");
            }
          }

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
            host: host,
            port: finalPort,
            line: addrDisp + "#" + remark,
            speedMB // 保存速度数值用于后续处理
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

        return J({ 
          ok:true, 
          lines: preview, 
          count: applied.length, 
          headers, 
          stats, 
          truncated: applied.length > MAX_PREV,
          saveMode
        });
      }

      // publish - 修正版，直接处理纯节点数据
      if (request.method === "POST" && path === "/api/publish") {
        if (!env.KV)    return J({ ok:false, error:"KV not bound" }, 500);
        if (!env.TOKEN) return J({ ok:false, error:"TOKEN not configured" }, 500);

        const q = new URL(request.url).searchParams;
        let token = q.get("token") || request.headers.get("x-token");
        const ct = request.headers.get("content-type") || "";
        let content = "";
        let saveMode = "overwrite";

        // 处理 JSON 格式的请求
        if (ct.includes("application/json")) {
          try { 
            const jsonData = await request.json();
            token = (jsonData.token || token || "").toString();
            content = (jsonData.content || "").toString();
            saveMode = (jsonData.saveMode || "overwrite").toString();
          } catch(e) {
            return J({ ok:false, error:"Invalid JSON format" }, 400);
          }
        }
        // 处理 multipart/form-data 格式的请求
        else if (ct.includes("multipart/form-data")) {
          const formData = await request.formData();
          token = (formData.get("token") || token || "").toString();
          content = (formData.get("content") || "").toString();
          saveMode = (formData.get("saveMode") || "overwrite").toString();
        }
        // 处理纯文本格式的请求
        else {
          content = await request.text();
          // 清理 multipart 格式，提取纯节点数据
          content = cleanMultipartContent(content);
        }

        if (token !== env.TOKEN) return J({ ok:false, error:"Unauthorized (bad token)" }, 401);
        
        // 最终清理内容（确保没有格式边界）
        if (content.includes("------WebKitFormBoundary")) {
          content = cleanMultipartContent(content);
        }
        
        if (!content) return J({ ok:false, error:"content is empty" }, 400);

        const key = env.TOKEN;
        // 确保内容是一行一个，格式正确
        content = content.split("\n")
          .map(line => line.trim())
          .filter(line => line && !line.includes("Content-Disposition") && !line.includes("WebKitFormBoundary"))
          .join("\n");
        
        // 处理保存模式
        if (saveMode === "append") {
          const existing = await env.KV.get("sub:" + key) || "";
          content = existing + (existing ? "\n" : "") + content;
        }

        await env.KV.put("sub:" + key, content);
        const meta = { updated: Date.now(), count: content ? content.split("\n").length : 0, saveMode };
        await env.KV.put("meta:" + key, JSON.stringify(meta));
        return J({ ok:true, key, count: meta.count, updated: meta.updated, saveMode });
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

// IATA -> A2/Sub/CityZH (extended core)
const IATA_TO_A2 = {
  LAX:"US", SJC:"US", SFO:"US", SEA:"US", DEN:"US", EWR:"US", JFK:"US", IAD:"US", DFW:"US", ORD:"US", ATL:"US", MIA:"US", BOS:"US",
  LHR:"GB", MAN:"GB", LGW:"GB", EDI:"GB", BHX:"GB",
  HKG:"HK", MFM:"MO", TPE:"TW", KHH:"TW", TSA:"TW", FOC:"TW", KNH:"TW",
  NRT:"JP", HND:"JP", KIX:"JP", ITM:"JP", FUK:"JP", CTS:"JP", OKA:"JP",
  CDG:"FR", ORY:"FR", FRA:"DE", MUC:"DE", DUS:"DE", TXL:"DE", HAM:"DE",
  YYZ:"CA", YVR:"CA", YUL:"CA", YYC:"CA", YEG:"CA",
  AMS:"NL", BRU:"BE", DUB:"IE", WAW:"PL", OTP:"RO", VIE:"AT", PRG:"CZ",
  SIN:"SG", ICN:"KR", ZZH:"CH", BKK:"TH", DXB:"AE", AUH:"AE", DOH:"QA",
  HEL:"FI", ARN:"SE", OSL:"NO", CPH:"DK", MAD:"ES", BCN:"ES", LIS:"PT",
  SYD:"AU", MEL:"AU", BNE:"AU", PER:"AU", AKL:"NZ", CHC:"NZ",
  BOM:"IN", DEL:"IN", MAA:"IN", BLR:"IN", KUL:"MY", BWN:"BN", MNL:"PH",
  SGN:"VN", HAN:"VN", BKK:"TH", DMK:"TH", CNX:"TH", HKT:"TH"
};

const IATA_TO_SUB = { 
  LAX:"CA", SJC:"CA", SFO:"CA", SEA:"WA", DEN:"CO", EWR:"NJ", JFK:"NY", IAD:"VA", DFW:"TX", 
  ORD:"IL", ATL:"GA", MIA:"FL", BOS:"MA", YYZ:"ON", YVR:"BC", YUL:"QC", YYC:"AB", YEG:"AB"
};

const IATA_TO_CITY_ZH = {
  LAX:"洛杉矶", SJC:"圣何塞", SFO:"旧金山", SEA:"西雅图", DEN:"丹佛", EWR:"新泽西", JFK:"纽约", IAD:"华盛顿", DFW:"达拉斯",
  ORD:"芝加哥", ATL:"亚特兰大", MIA:"迈阿密", BOS:"波士顿",
  LHR:"伦敦", MAN:"曼彻斯特", LGW:"伦敦", EDI:"爱丁堡", BHX:"伯明翰",
  HKG:"香港", MFM:"澳门", TPE:"台北", KHH:"高雄", TSA:"台北", FOC:"福州", KNH:"金门",
  NRT:"东京", HND:"东京", KIX:"大阪", ITM:"大阪", FUK:"福冈", CTS:"札幌", OKA:"冲绳",
  CDG:"巴黎", ORY:"巴黎", FRA:"法兰克福", MUC:"慕尼黑", DUS:"杜塞尔多夫", TXL:"柏林", HAM:"汉堡",
  YYZ:"多伦多", YVR:"温哥华", YUL:"蒙特利尔", YYC:"卡尔加里", YEG:"埃德蒙顿",
  AMS:"阿姆斯特丹", BRU:"布鲁塞尔", DUB:"都柏林", WAW:"华沙", OTP:"布加勒斯特", VIE:"维也纳", PRG:"布拉格",
  SIN:"新加坡", ICN:"首尔", ZZH:"苏黎世", BKK:"曼谷", DXB:"迪拜", AUH:"阿布扎比", DOH:"多哈",
  HEL:"赫尔辛基", ARN:"斯德哥尔摩", OSL:"奥斯陆", CPH:"哥本哈根", MAD:"马德里", BCN:"巴塞罗那", LIS:"里斯本",
  SYD:"悉尼", MEL:"墨尔本", BNE:"布里斯班", PER:"珀斯", AKL:"奥克兰", CHC:"基督城",
  BOM:"孟买", DEL:"德里", MAA:"金奈", BLR:"班加罗尔", KUL:"吉隆坡", BWN:"斯里巴加湾市", MNL:"马尼拉",
  SGN:"胡志明市", HAN:"河内", DMK:"曼谷", CNX:"清迈", HKT:"普吉岛"
};

// 中文国名补充（完整版）
const COUNTRY_ZH = {
  CN:"中国", HK:"香港", MO:"澳门", TW:"台湾",
  US:"美国", GB:"英国", DE:"德国", FR:"法国", NL:"荷兰", BE:"比利时", IE:"爱尔兰", CA:"加拿大", JP:"日本", KR:"韩国", SG:"新加坡",
  IN:"印度", AE:"阿联酋", TR:"土耳其", RU:"俄罗斯", AU:"澳大利亚", ES:"西班牙", IT:"意大利", BR:"巴西", MX:"墨西哥", ZA:"南非",
  CH:"瑞士", TH:"泰国", PL:"波兰", RO:"罗马尼亚", SE:"瑞典", NO:"挪威", DK:"丹麦", FI:"芬兰", PT:"葡萄牙", GR:"希腊",
  AT:"奥地利", CZ:"捷克", HU:"匈牙利", UA:"乌克兰", IL:"以色列", SA:"沙特阿拉伯", EG:"埃及", NG:"尼日利亚", CL:"智利", CO:"哥伦比亚",
  AR:"阿根廷", PE:"秘鲁", NZ:"新西兰", MY:"马来西亚", ID:"印度尼西亚", VN:"越南", PH:"菲律宾", BD:"孟加拉国", PK:"巴基斯坦",
  LK:"斯里兰卡", NP:"尼泊尔", MM:"缅甸", KH:"柬埔寨", LA:"老挝", BN:"文莱", AF:"阿富汗", IQ:"伊拉克", IR:"伊朗", SY:"叙利亚",
  JO:"约旦", LB:"黎巴嫩", OM:"阿曼", YE:"也门", QA:"卡塔尔", KW:"科威特", BH:"巴林", CY:"塞浦路斯", MT:"马耳他",
  IS:"冰岛", EE:"爱沙尼亚", LV:"拉脱维亚", LT:"立陶宛", BY:"白俄罗斯", MD:"摩尔多瓦", GE:"格鲁吉亚", AM:"亚美尼亚", AZ:"阿塞拜疆",
  KZ:"哈萨克斯坦", UZ:"乌兹别克斯坦", TM:"土库曼斯坦", KG:"吉尔吉斯斯坦", TJ:"塔吉克斯坦", MN:"蒙古", KP:"朝鲜", UY:"乌拉圭",
  PY:"巴拉圭", BO:"玻利维亚", EC:"厄瓜多尔", VE:"委内瑞拉", CR:"哥斯达黎加", PA:"巴拿马", CU:"古巴", DO:"多米尼加", JM:"牙买加",
  HT:"海地", BS:"巴哈马", TT:"特立尼达和多巴哥", BB:"巴巴多斯", GD:"格林纳达", LC:"圣卢西亚", VC:"圣文森特", KN:"圣基茨和尼维斯",
  AG:"安提瓜和巴布达", DM:"多米尼克", SR:"苏里南", GF:"法属圭亚那", GY:"圭亚那", FK:"福克兰群岛", GS:"南乔治亚岛",
  GL:"格陵兰", BM:"百慕大", KY:"开曼群岛", TC:"特克斯和凯科斯群岛", VG:"英属维尔京群岛", AI:"安圭拉", MS:"蒙特塞拉特",
  AW:"阿鲁巴", CW:"库拉索", SX:"圣马丁", BQ:"博奈尔", MF:"法属圣马丁", BL:"圣巴泰勒米", GP:"瓜德罗普", MQ:"马提尼克",
  YT:"马约特", RE:"留尼汪", SC:"塞舌尔", MU:"毛里求斯", KM:"科摩罗", MV:"马尔代夫", MG:"马达加斯加", ZW:"津巴布韦",
  ZM:"赞比亚", MW:"马拉维", TZ:"坦桑尼亚", KE:"肯尼亚", UG:"乌干达", RW:"卢旺达", BI:"布隆迪", ET:"埃塞俄比亚",
  ER:"厄立特里亚", DJ:"吉布提", SO:"索马里", SD:"苏丹", SS:"南苏丹", TD:"乍得", CF:"中非", CM:"喀麦隆", GA:"加蓬",
  CG:"刚果", CD:"刚果金", AO:"安哥拉", NA:"纳米比亚", BW:"博茨瓦纳", LS:"莱索托", SZ:"斯威士兰", MZ:"莫桑比克",
  MG:"马达加斯加", KM:"科摩罗", YT:"马约特", RE:"留尼汪", MU:"毛里求斯", SC:"塞舌尔"
};

// A3->A2 (完整版)
const A3_TO_A2 = { 
  HKG:"HK", MAC:"MO", TWN:"TW", CHN:"CN", USA:"US", JPN:"JP", KOR:"KR", SGP:"SG", MYS:"MY", VNM:"VN", THA:"TH", PHL:"PH", IDN:"ID", IND:"IN",
  GBR:"GB", FRA:"FR", DEU:"DE", ITA:"IT", ESP:"ES", RUS:"RU", CAN:"CA", AUS:"AU", NLD:"NL", BRA:"BR", ARG:"AR", MEX:"MX", TUR:"TR",
  ARE:"AE", ISR:"IL", ZAF:"ZA", SWE:"SE", NOR:"NO", DNK:"DK", FIN:"FI", POL:"PL", CZE:"CZ", AUT:"AT", CHE:"CH", BEL:"BE", IRL:"IE",
  PRT:"PT", GRC:"GR", HUN:"HU", ROU:"RO", UKR:"UA", NZL:"NZ", COL:"CO", PER:"PE", CHL:"CL", SAU:"SA", EGY:"EG", NGA:"NG",
  PAK:"PK", BGD:"BD", LKA:"LK", NPL:"NP", MMR:"MM", KHM:"KH", LAO:"LA", BRN:"BN", AFG:"AF", IRQ:"IQ", IRN:"IR", SYR:"SY",
  JOR:"JO", LBN:"LB", OMN:"OM", YEM:"YE", QAT:"QA", KWT:"KW", BHR:"BH", CYP:"CY", MLT:"MT", ISL:"IS", EST:"EE", LVA:"LV",
  LTU:"LT", BLR:"BY", MDA:"MD", GEO:"GE", ARM:"AM", AZE:"AZ", KAZ:"KZ", UZB:"UZ", TKM:"TM", KGZ:"KG", TJK:"TJ", MNG:"MN",
  PRK:"KP", URY:"UY", PRY:"PY", BOL:"BO", ECU:"EC", VEN:"VE", CRI:"CR", PAN:"PA", CUB:"CU", DOM:"DO", JAM:"JM", HTI:"HT",
  BHS:"BS", TTO:"TT", BRB:"BB", GRD:"GD", LCA:"LC", VCT:"VC", KNA:"KN", ATG:"AG", DMA:"DM", SUR:"SR", GUF:"GF", GUY:"GY",
  FLK:"FK", SGS:"GS", GRL:"GL", BMU:"BM", CYM:"KY", TCA:"TC", VGB:"VG", AIA:"AI", MSR:"MS", ABW:"AW", CUW:"CW", SXM:"SX",
  BES:"BQ", MAF:"MF", BLM:"BL", GLP:"GP", MTQ:"MQ", MYT:"YT", REU:"RE", SYC:"SC", MUS:"MU", COM:"KM", MDV:"MV", MDG:"MG",
  ZWE:"ZW", ZMB:"ZM", MWI:"MW", TZA:"TZ", KEN:"KE", UGA:"UG", RWA:"RW", BDI:"BI", ETH:"ET", ERI:"ER", DJI:"DJ", SOM:"SO",
  SDN:"SD", SSD:"SS", TCD:"TD", CAF:"CF", CMR:"CM", GAB:"GA", COG:"CG", COD:"CD", AGO:"AO", NAM:"NA", BWA:"BW", LSO:"LS",
  SWZ:"SZ", MOZ:"MZ"
};

// 英文城市关键词 -> 中文
const CITY_EN_TO_ZH = {
  "TOKYO":"东京","OSAKA":"大阪","SINGAPORE":"新加坡","SEOUL":"首尔","LONDON":"伦敦","FRANKFURT":"法兰克福","PARIS":"巴黎",
  "AMSTERDAM":"阿姆斯特丹","BRUSSELS":"布鲁塞尔","DUBLIN":"都柏林","MANCHESTER":"曼彻斯特","DUBAI":"迪拜","ABUDHABI":"阿布扎比",
  "LOS ANGELES":"洛杉矶","LOSANGELES":"洛杉矶","SEATTLE":"西雅图","SAN FRANCISCO":"旧金山","SANFRANCISCO":"旧金山","SAN JOSE":"圣何塞","SANJOSE":"圣何塞",
  "NEW YORK":"纽约","NEWYORK":"纽约","NEW JERSEY":"新泽西","JERSEY":"新泽西","WASHINGTON":"华盛顿","DALLAS":"达拉斯","CHICAGO":"芝加哥",
  "ATLANTA":"亚特兰大","MIAMI":"迈阿密","BOSTON":"波士顿","HOUSTON":"休斯顿","PHOENIX":"凤凰城","PHILADELPHIA":"费城",
  "TORONTO":"多伦多","VANCOUVER":"温哥华","MONTREAL":"蒙特利尔","CALGARY":"卡尔加里","EDMONTON":"埃德蒙顿",
  "WARSAW":"华沙","BUCHAREST":"布加勒斯特","ZURICH":"苏黎世","BANGKOK":"曼谷","VIENNA":"维也纳","PRAGUE":"布拉格",
  "HONG KONG":"香港","HONGKONG":"香港","BEIJING":"北京","SHANGHAI":"上海","SHENZHEN":"深圳","GUANGZHOU":"广州","TIANJIN":"天津",
  "CHONGQING":"重庆","CHENGDU":"成都","WUHAN":"武汉","NANJING":"南京","HANGZHOU":"杭州","XIAMEN":"厦门","QINGDAO":"青岛",
  "DALIAN":"大连","NINGBO":"宁波","FOSHAN":"佛山","SUZHOU":"苏州","WUXI":"无锡","CHANGZHOU":"常州","ZHUHAI":"珠海",
  "MUMBAI":"孟买","CHENNAI":"金奈","BANGALORE":"班加罗尔","HYDERABAD":"海得拉巴","KOLKATA":"加尔各答","NEW DELHI":"新德里",
  "ASHBURN":"阿什本","HELSINKI":"赫尔辛基","DUSSELDORF":"杜塞尔多夫","DÜSSELDORF":"杜塞尔多夫","FRANKFURT AM MAIN":"法兰克福",
  "STOCKHOLM":"斯德哥尔摩","OSLO":"奥斯陆","COPENHAGEN":"哥本哈根","MADRID":"马德里","BARCELONA":"巴塞罗那","LISBON":"里斯本",
  "ROME":"罗马","MILAN":"米兰","SYDNEY":"悉尼","MELBOURNE":"墨尔本","BRISBANE":"布里斯班","PERTH":"珀斯","AUCKLAND":"奥克兰",
  "WELLINGTON":"惠灵顿","TAIPEI":"台北","KAOHSIUNG":"高雄","TAINAN":"台南","TAICHUNG":"台中","KEELUNG":"基隆"
};

const CITY_ZH_LIST = [
  "东京","大阪","新加坡","首尔","伦敦","法兰克福","巴黎","阿姆斯特丹","布鲁塞尔","都柏林","曼彻斯特","迪拜","阿布扎比",
  "洛杉矶","西雅图","旧金山","圣何塞","纽约","新泽西","华盛顿","达拉斯","芝加哥","亚特兰大","迈阿密","波士顿","休斯顿",
  "凤凰城","费城","苏黎世","曼谷","维也纳","布拉格","香港","北京","上海","深圳","广州","天津","重庆","成都","武汉","南京",
  "杭州","厦门","青岛","大连","宁波","佛山","苏州","无锡","常州","珠海","多伦多","温哥华","蒙特利尔","卡尔加里","埃德蒙顿",
  "华沙","布加勒斯特","孟买","金奈","班加罗尔","海得拉巴","加尔各答","新德里","阿什本","赫尔辛基","杜塞尔多夫","斯德哥尔摩",
  "奥斯陆","哥本哈根","马德里","巴塞罗那","里斯本","罗马","米兰","悉尼","墨尔本","布里斯班","珀斯","奥克兰","惠灵顿",
  "台北","高雄","台南","台中","基隆"
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
    "香港":"HK","澳门":"MO","台北":"TW","高雄":"TW","东京":"JP","大阪":"JP","新加坡":"SG","首尔":"KR","伦敦":"GB","法兰克福":"DE","巴黎":"FR","阿姆斯特丹":"NL","布鲁塞尔":"BE","都柏林":"IE","曼彻斯特":"GB",
    "迪拜":"AE","阿布扎比":"AE","洛杉矶":"US","西雅图":"US","旧金山":"US","圣何塞":"US","纽约":"US","新泽西":"US","华盛顿":"US","达拉斯":"US","芝加哥":"US","亚特兰大":"US","迈阿密":"US","波士顿":"US",
    "苏黎世":"CH","曼谷":"TH","多伦多":"CA","温哥华":"CA","蒙特利尔":"CA","华沙":"PL","布加勒斯特":"RO","孟买":"IN","金奈":"IN","班加罗尔":"IN",
    "北京":"CN","上海":"CN","深圳":"CN","广州":"CN","天津":"CN","重庆":"CN","成都":"CN","武汉":"CN","南京":"CN","杭州":"CN","厦门":"CN","青岛":"CN",
    "阿什本":"US","赫尔辛基":"FI","杜塞尔多夫":"DE","斯德哥尔摩":"SE","奥斯陆":"NO","哥本哈根":"DK","马德里":"ES","巴塞罗那":"ES","里斯本":"PT",
    "罗马":"IT","米兰":"IT","悉尼":"AU","墨尔本":"AU","布里斯班":"AU","珀斯":"AU","奥克兰":"NZ","惠灵顿":"NZ","维也纳":"AT","布拉格":"CZ"
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

// 清理 multipart 内容的辅助函数
function cleanMultipartContent(rawContent) {
  if (!rawContent) return "";
  
  return rawContent
    .split("\n")
    .map(line => line.trim())
    .filter(line => {
      // 过滤掉所有边界行和 Content-Disposition 行
      if (!line) return false;
      if (line.includes("------WebKitFormBoundary")) return false;
      if (line.includes("Content-Disposition")) return false;
      if (line.includes("saveMode")) return false;
      if (line.includes("token")) return false;
      if (line === "overwrite") return false;
      if (line === "yuu") return false;
      if (line === "--") return false;
      // 只保留 IP:端口#地区的格式
      return line.match(/^[\d\.:\[\]]+#/) || line.match(/^[^#]+#\S+$/);
    })
    .join("\n");
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
  --bg:#f8fafc; --card:rgba(255,255,255,0.85); --text:#0f172a; --muted:#64748b; --border:#e2e8f0;
  --primary:#3b82f6; --accent:#8b5cf6; --shadow:0 20px 25px -5px rgba(0,0,0,0.1),0 10px 10px -5px rgba(0,0,0,0.04);
  --pill:#f1f5f9; --link:#2563eb;
  --frosted-bg: rgba(255,255,255,0.8);
}
html[data-theme="dark"]{
  --bg:#0f172a; --card:rgba(30,41,59,0.85); --text:#f1f5f9; --muted:#94a3b8; --border:#334155;
  --primary:#60a5fa; --accent:#a78bfa; --shadow:0 25px 50px -12px rgba(0,0,0,0.5);
  --pill:#1e293b; --link:#93c5fd;
  --frosted-bg: rgba(30,41,59,0.8);
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,PingFang SC,Microsoft YaHei,Helvetica,Arial;position:relative;background-image:linear-gradient(135deg,#667eea 0%,#764ba2 100%);}
#wp{position:fixed;inset:0;background-position:center;background-size:cover;background:var(--frosted-bg);backdrop-filter:blur(20px) saturate(1.8);pointer-events:none;z-index:-1;display:block}
.center{min-height:100dvh;display:grid;place-items:start center;padding:72px 12px 40px}
.container{width:min(1100px,96vw)}
.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}
.brand{display:flex;align-items:center;gap:12px}
.logoWrap{width:52px;height:52px;border-radius:16px;overflow:hidden;box-shadow:0 12px 28px rgba(59,130,246,.35);display:grid;place-items:center;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);}
.logoWrap img{width:100%;height:100%;object-fit:cover;display:block}
.title{font-size:26px;font-weight:900;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}
.header-right{display:flex;align-items:center;gap:10px}
.pill{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--border);background:var(--pill);padding:8px 12px;border-radius:999px;font-weight:700;color:var(--text);text-decoration:none;backdrop-filter:blur(10px);}
.btn{display:inline-flex;align-items:center;gap:10px;background:linear-gradient(90deg,var(--primary),var(--accent));border:none;border-radius:12px;padding:12px 16px;color:#fff;cursor:pointer;font-weight:800;transition:all 0.2s ease;}
.btn:hover{transform:translateY(-2px);box-shadow:0 10px 20px rgba(0,0,0,0.2);}
.btn.secondary{background:transparent;color:var(--text);border:1px solid var(--border)}
.btn:disabled{opacity:0.6;cursor:not-allowed;}
.btn.small{padding:6px 10px;font-size:12px;}
.card{background:var(--card);backdrop-filter:blur(16px) saturate(1.8);border:1px solid rgba(255,255,255,.5);border-radius:20px;box-shadow:var(--shadow)}
html[data-theme="dark"] .card{border-color:rgba(148,163,184,.25)}
.card.pad{padding:24px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:20px}
@media (max-width: 720px){ .row{grid-template-columns:1fr} .title{font-size:22px} .logoWrap{width:44px;height:44px} }
label{display:block;margin:10px 0 8px;font-weight:700}
small.help{display:block;color:var(--muted);margin-top:4px}
textarea,input[type="text"],input[type="number"],select{width:100%;padding:12px 14px;border-radius:12px;border:1px solid var(--border);background:var(--card);color:var(--text);backdrop-filter:blur(10px);}
textarea{min-height:54px}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}
input[type="file"]{display:none}
/* chips */
.filebox{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.uploadBtn{display:inline-flex;align-items:center;gap:8px;background:linear-gradient(90deg,var(--primary),var(--accent));border:none;border-radius:12px;padding:10px 14px;color:#fff;cursor:pointer;font-weight:800;transition:all 0.2s ease;}
.uploadBtn:hover{transform:translateY(-2px);}
.filechips{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px}
.chip{position:relative;display:inline-flex;align-items:center;gap:10px;border:1px solid var(--border);background:var(--card);backdrop-filter:blur(8px);border-radius:12px;padding:8px 12px;box-shadow:0 4px 10px rgba(0,0,0,.05);transition:all 0.2s ease;}
.chip:hover{transform:translateY(-1px);}
html[data-theme="dark"] .chip{background:var(--card)}
.gridIcon{width:28px;height:28px;border-radius:8px;background:#10b981;display:grid;place-items:center;color:#fff;font-weight:900}
.chip .x{position:absolute;top:-6px;right:-6px;width:20px;height:20px;border:none;border-radius:50%;background:#00000022;color:#111;cursor:pointer;transition:all 0.2s ease;}
.chip .x:hover{background:#00000044;}
html[data-theme="dark"] .chip .x{background:#ffffff33;color:#fff}
.chip .eye{border:none;background:transparent;cursor:pointer}
/* drag & drop */
.drop-zone{border:2px dashed var(--border);border-radius:12px;padding:40px 20px;text-align:center;transition:all 0.3s ease;background:var(--card);backdrop-filter:blur(10px);}
.drop-zone.active{border-color:var(--primary);background:rgba(59,130,246,0.1);}
.drop-zone p{margin:0;color:var(--muted);}
/* modal & toast */
.modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.5);padding:18px;z-index:50}
.panel{max-width:900px;width:100%;border-radius:20px;padding:24px;background:var(--card);backdrop-filter:blur(20px) saturate(1.8);border:1px solid rgba(255,255,255,.5);box-shadow:var(--shadow)}
html[data-theme="dark"] .panel{border-color:rgba(148,163,184,.25)}
.panel .title{font-weight:900;margin-bottom:8px}
.actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}
.toast{position:fixed;right:18px;bottom:18px;background:var(--card);border:1px solid var(--border);color:var(--text);padding:12px 16px;border-radius:12px;opacity:0;transform:translateY(10px);transition:all .25s ease;z-index:60;backdrop-filter:blur(10px);}
.toast.show{opacity:1;transform:translateY(0)}
/* save mode */
.save-mode{display:flex;gap:10px;margin:10px 0;}
.save-mode-btn{flex:1;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--card);color:var(--text);cursor:pointer;text-align:center;transition:all 0.2s ease;}
.save-mode-btn.active{background:linear-gradient(90deg,var(--primary),var(--accent));color:#fff;border-color:var(--primary);}
/* latency results */
.latency-results{margin-top:10px;max-height:300px;overflow-y:auto;}
.latency-item{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-radius:8px;margin-bottom:5px;background:var(--pill);}
.latency-success{background:rgba(16,185,129,0.1);border-left:4px solid #10b981;}
.latency-failed{background:rgba(239,68,68,0.1);border-left:4px solid #ef4444;}
.latency-value{font-weight:bold;}
.latency-value.good{color:#10b981;}
.latency-value.medium{color:#f59e0b;}
.latency-value.poor{color:#ef4444;}
.latency-progress{width:100%;height:6px;background:var(--border);border-radius:3px;margin-top:5px;overflow:hidden;}
.latency-progress-bar{height:100%;background:linear-gradient(90deg,var(--primary),var(--accent));transition:width 0.3s ease;}
.testing-info{background:rgba(59,130,246,0.1);border-left:4px solid var(--primary);padding:10px;border-radius:8px;margin:10px 0;}
/* output area with test buttons */
.output-line{display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid var(--border);}
.output-line:last-child{border-bottom:none;}
.output-text{flex:1;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;}
.output-actions{display:flex;gap:5px;margin-left:10px;}
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
            <div class="drop-zone" id="dropZone">
              <p>📂 拖放文件到此处或</p>
              <div class="filebox">
                <label class="uploadBtn" for="files">选择文件</label>
                <input type="file" id="files" name="files" multiple />
                <button class="btn secondary" id="previewAll" type="button">👁 预览全部</button>
              </div>
            </div>
            <div id="chips" class="filechips"></div>
          </div>

          <div>
            <label>或直接粘贴文本</label>
            <textarea id="pasted" rows="4" placeholder="可粘贴优选域名（如：visa.cn）或整段 CSV/TXT。域名不输出端口；IP 未写端口时，请在"高级设置→输出端口"选择。"></textarea>
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
              <button class="btn secondary" id="latencyBtn" type="button">📡 本地延迟测试</button>
              <button class="btn secondary" id="testAllBtn" type="button">🧪 测试全部节点</button>
            </div>
            <div class="save-mode">
              <div class="save-mode-btn active" data-mode="overwrite">覆盖保存</div>
              <div class="save-mode-btn" data-mode="append">追加保存</div>
            </div>
          </div>
        </div>
      </div>

      <div class="card pad" style="margin-top:14px">
        <div class="progress" id="progWrap" style="display:none"><div class="bar" id="bar" style="height:10px;background:linear-gradient(90deg,var(--primary),var(--accent));border-radius:999px;width:0%"></div></div>
        <div id="outputContainer" style="max-height:400px;overflow-y:auto;margin-bottom:10px;">
          <textarea id="out" class="mono" rows="18" placeholder="点击"生成预览"后在此显示结果" style="width:100%;border:none;background:transparent;resize:none;"></textarea>
        </div>
        <div id="miniStats" class="muted" style="margin-top:8px;line-height:1.8"></div>
        <div id="latencyResults" class="latency-results"></div>
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
          <small class="help">自动识别并换算 kb/s、kbps、Mb/s、Mbps、KiB/s 等到 MB/s；选择"0 不显示"则完全不拼接速度。</small>
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
            <input type="text" id="domainRemarkText" placeholder="自定义备注文本（仅当选择"自定义"时）"/>
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
          <label>速度过滤（最小 MB/s）</label>
          <input type="number" id="minSpeed" min="0" step="0.1" placeholder="0 = 不限制"/>
          <small class="help">不显示速度低于此值的节点（单位：MB/s）</small>
        </div>
        <div>
          <!-- 删除延迟过滤设置 -->
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
          <label class="muted"><input type="checkbox" id="preferLowLat" checked/> 若检测到"延迟/latency/ping"等列，则按"国家最小延迟 → 行延迟"升序排序</label>
          <small class="help">延迟列不存在时，不影响原顺序。</small>
        </div>
      </div>

      <div class="actions"><button class="btn secondary" id="closeQuota" type="button">关闭</button></div>
    </div>
  </div>

  <!-- 本地延迟测试 -->
  <div class="modal" id="latencyModal">
    <div class="panel">
      <div class="title">本地延迟测试</div>
      <div class="testing-info">
        <strong>测试说明：</strong> 此功能使用您本地浏览器网络真实连接测试服务器的延迟，反映您当前网络到各服务器的真实连接质量。
      </div>
      <div class="row">
        <div>
          <label>测试服务器</label>
          <textarea id="latencyServers" rows="6" placeholder="输入要测试的服务器，每行一个，格式：IP:端口 或 域名:端口&#10;例如：&#10;183.236.51.220:7005&#10;visa.cn:443&#10;[2606:4700::1]:2053"></textarea>
          <div style="margin-top:10px;">
            <button class="btn secondary small" id="importFromPreview">从预览导入</button>
            <button class="btn secondary small" id="clearLatencyList">清空列表</button>
          </div>
        </div>
        <div>
          <label>测试设置</label>
          <input type="number" id="latencyTimeout" min="100" max="10000" value="400" placeholder="超时时间（毫秒）"/>
          <input type="number" id="latencyThreshold" min="50" max="5000" value="300" placeholder="延迟阈值（毫秒）"/>
          <input type="text" id="testUrl" placeholder="自定义测速地址（可选）" value="/"/>
          <label class="muted"><input type="checkbox" id="latencyAutoFilter" checked/> 自动过滤高延迟节点</label>
          <small class="help">测试完成后，自动过滤延迟高于此值的节点（默认300ms）</small>
        </div>
      </div>
      <div class="actions">
        <button class="btn" id="startLatency" type="button">🚀 开始测试</button>
        <button class="btn secondary" id="testAndUpload" type="button">📡 测试并上传</button>
        <button class="btn secondary" id="closeLatency" type="button">关闭</button>
      </div>
      <div id="latencyResultsModal" class="latency-results" style="margin-top:20px;max-height:300px;"></div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

<script>
(function(){
  function $(id){return document.getElementById(id)}
  function toast(t,k){var x=$('toast');x.textContent=t;x.style.borderColor=(k==='error')?'#ef4444':(k==='success')?'#10b981':'#e5e7eb';x.classList.add('show');setTimeout(function(){x.classList.remove('show')},2200)}
  function openM(m){m.style.display='flex'} function closeM(m){m.style.display='none'}

  // Theme + default bg (frosted glass)
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
  }).catch(()=>{ applyBgFromState(); applyLogo(localStorage.getItem('YX:logo')); });

  const DEFAULT_LOGO = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><defs><linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:%23667eea;stop-opacity:1"/><stop offset="100%" style="stop-color:%23764ba2;stop-opacity:1"/></linearGradient></defs><rect rx="24" ry="24" width="128" height="128" fill="url(%23grad)"/><text x="64" y="80" font-family="Arial" font-size="48" text-anchor="middle" fill="white" font-weight="900" font-style="italic">YX</text></svg>';
  function applyLogo(src){ $('logoImg').src = src || DEFAULT_LOGO; }

  function applyBg(data){ if (data){ $('wp').style.backgroundImage = 'url('+data+')'; $('wp').style.display='block'; } else { $('wp').style.backgroundImage='none'; $('wp').style.display='block'; } }
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

  $('resetBg').onclick=function(){ localStorage.removeItem('YX:bg'); applyBgFromState(); toast('已切回默认背景（随主题）','success'); };
  $('resetLogo').onclick=function(){ localStorage.removeItem('YX:logo'); applyLogo(''); toast('已恢复默认 Logo','success'); };

  // save/clear server defaults
  $('savePrefs').onclick=async function(){
    const t=$('token').value||''; if(!t){ toast('请在上方填写 TOKEN 再保存','error'); return; }
    try{
      const res=await fetch('/api/prefs',{method:'POST',headers:{'content-type':'application/json','x-token':t},body:JSON.stringify({bg:localStorage.getItem('YX:bg')||'', bgOpacity:80, logo:localStorage.getItem('YX:logo')||''})});
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

  // Drag & drop
  const dropZone = $('dropZone');
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, preventDefaults, false);
  });
  function preventDefaults (e) { e.preventDefault(); e.stopPropagation(); }
  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, highlight, false);
  });
  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, unhighlight, false);
  });
  function highlight() { dropZone.classList.add('active'); }
  function unhighlight() { dropZone.classList.remove('active'); }
  dropZone.addEventListener('drop', handleDrop, false);
  function handleDrop(e) {
    const dt = e.dataTransfer;
    const files = dt.files;
    handleFiles(files);
  }
  function handleFiles(files) {
    const arr = Array.from(files||[]); 
    const map = new Set(fileList.map(uniqKey));
    arr.forEach(f=>{ const k=uniqKey(f); if(!map.has(k)){ fileList.push(f); map.add(k);} });
    renderChips();
  }

  // Multi-file append
  let fileList=[];
  function uniqKey(f){ return [f.name,f.size,f.lastModified].join('|'); }
  $('files').addEventListener('change', function(){
    handleFiles(this.files);
    this.value='';
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

  // Save mode
  let currentSaveMode = 'overwrite';
  document.querySelectorAll('.save-mode-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.save-mode-btn').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      currentSaveMode = this.dataset.mode;
      localStorage.setItem('YX:saveMode', currentSaveMode);
    });
  });
  // Load saved mode
  const savedMode = localStorage.getItem('YX:saveMode') || 'overwrite';
  document.querySelector(\`.save-mode-btn[data-mode="\${savedMode}"]\`).click();

  // Persisted settings
  const nodePrefix=$('nodePrefix'), nodeSuffix=$('nodeSuffix'), decorateFlag=$('decorateFlag');
  const digits=$('digits'), speedMode=$('speedMode'), minSpeed=$('minSpeed');
  const quotaV4=$('quotaV4'), quotaV6=$('quotaV6'), maxLines=$('maxLines'), quotaPerTop=$('quotaPerTop'), quotaTopN=$('quotaTopN'), preferLowLat=$('preferLowLat');
  const regionLang=$('regionLang'), regionDetail=$('regionDetail');
  const token=$('token');
  const outPortSel=$('outPortSel'), outPortCus=$('outPortCus');
  const domainRemarkMode=$('domainRemarkMode'), domainRemarkText=$('domainRemarkText');
  const LS='YX:cfg:';
  function load(k,d){ return localStorage.getItem(LS+k) ?? d; }
  function save(k,v){ localStorage.setItem(LS+k, v); }

  nodePrefix.value = load('nodePrefix','');   nodeSuffix.value = load('nodeSuffix','');

  // speedMode & digits & minSpeed
  speedMode.value = load('speedMode','2');
  digits.value = load('digits','2');
  minSpeed.value = load('minSpeed','0');

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
    minSpeed.addEventListener(ev,()=>save('minSpeed',minSpeed.value||'0'));

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
  $('latencyBtn').onclick=function(){ openM($('latencyModal')); };
  $('closePersonal').onclick=function(){ closeM($('personalModal')); };
  $('closeAdv').onclick=function(){ closeM($('advModal')); };
  $('closeQuota').onclick=function(){ closeM($('quotaModal')); };
  $('closeLatency').onclick=function(){ closeM($('latencyModal')); };

  // Local Latency Test functionality
  let latencyTestResults = [];
  let currentPreviewLines = [];
  
  // 从预览导入到延迟测试
  $('importFromPreview').onclick=function(){
    if (currentPreviewLines.length === 0) {
      toast('请先生成预览','error');
      return;
    }
    
    const servers = currentPreviewLines.map(line => {
      // 解析行格式：地址#备注
      const [address, remark] = line.split('#');
      return address;
    }).filter(addr => addr);
    
    $('latencyServers').value = servers.join('\\n');
    toast(\`已导入 \${servers.length} 个服务器到测试列表\`, 'success');
  };
  
  // 清空延迟测试列表
  $('clearLatencyList').onclick=function(){
    $('latencyServers').value = '';
    toast('已清空测试列表','success');
  };
  
  // 本地延迟测试函数 - 放宽条件版本
  async function testLocalLatency(server, timeout = 400, testPath = '/') {
    return new Promise((resolve) => {
      const start = Date.now();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
        resolve({
          ...server,
          latency: timeout,
          status: 'timeout',
          success: false,
          error: '请求超时'
        });
      }, timeout);
      
      const protocol = window.location.protocol === 'https:' ? 'https' : 'http';
      const testUrl = \`\${protocol}://\${server.host}:\${server.port}\${testPath}\`;
      
      fetch(testUrl, {
        method: 'HEAD',
        mode: 'no-cors',
        signal: controller.signal
      })
      .then(() => {
        clearTimeout(timeoutId);
        const latency = Date.now() - start;
        // 放宽条件：只要有响应就认为是成功的
        resolve({
          ...server,
          latency,
          status: 'success',
          success: true,
          error: ''
        });
      })
      .catch(error => {
        clearTimeout(timeoutId);
        const latency = Date.now() - start;
        
        // 放宽条件：只要在超时时间内有响应（即使出错），都认为是可用的
        const success = latency < timeout;
        
        resolve({
          ...server,
          latency,
          status: success ? 'success' : 'failed',
          success: success,
          error: success ? '连接可用（忽略协议错误）' : \`连接失败: \${error.message}\`
        });
      });
    });
  }
  
  // 批量本地延迟测试
  async function batchLocalLatencyTest(servers, timeout = 400, testPath = '/', concurrency = 3) {
    const results = [];
    
    for (let i = 0; i < servers.length; i += concurrency) {
      const batch = servers.slice(i, i + concurrency);
      const batchPromises = batch.map(server => testLocalLatency(server, timeout, testPath));
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
      
      // 更新进度
      const progress = ((i + batch.length) / servers.length * 100).toFixed(1);
      $('latencyResultsModal').innerHTML = \`<div class="testing-info">测试进度: \${progress}% (\${i + batch.length}/\${servers.length})</div>\`;
      
      // 小延迟避免过于频繁
      if (i + concurrency < servers.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    
    return results;
  }
  
  $('startLatency').onclick=async function(){
    const serversText = $('latencyServers').value.trim();
    if (!serversText) {
      toast('请输入要测试的服务器','error');
      return;
    }

    const servers = serversText.split('\\n')
      .map(line => line.trim())
      .filter(line => line)
      .map(line => {
        // 解析服务器格式
        if (line.startsWith('[')) {
          // IPv6 格式: [2606:4700::1]:2053
          const ipv6Match = line.match(/\\[([^\\]]+)\\]:(\\d+)/);
          if (ipv6Match) {
            return { host: ipv6Match[1], port: parseInt(ipv6Match[2]), original: line };
          }
        } else if (line.includes(':')) {
          // IPv4 或域名格式: 127.0.0.1:1234 或 visa.cn:443
          const parts = line.split(':');
          if (parts.length === 2) {
            return { host: parts[0], port: parseInt(parts[1]), original: line };
          }
        } else {
          // 没有端口，使用默认端口
          return { host: line, port: 443, original: line };
        }
        return null;
      })
      .filter(server => server && server.host);

    if (servers.length === 0) {
      toast('没有有效的服务器格式','error');
      return;
    }

    const timeout = parseInt($('latencyTimeout').value) || 400;
    const testPath = $('testUrl').value || '/';

    $('startLatency').disabled = true;
    $('testAndUpload').disabled = true;
    $('startLatency').textContent = '测试中...';
    $('latencyResultsModal').innerHTML = '<div class="testing-info">正在使用本地网络测试 ' + servers.length + ' 个服务器的真实连接延迟...</div>';

    try {
      const results = await batchLocalLatencyTest(servers, timeout, testPath, 3);
      latencyTestResults = results;
      
      // 显示结果
      let html = '';
      let successCount = 0;
      let totalLatency = 0;
      
      results.forEach(server => {
        const latencyClass = server.latency < 200 ? 'good' : server.latency < 500 ? 'medium' : 'poor';
        const statusClass = server.success ? 'latency-success' : 'latency-failed';
        
        if (server.success) {
          successCount++;
          totalLatency += server.latency;
        }
        
        html += \`
          <div class="latency-item \${statusClass}">
            <div>
              <div>\${server.original}</div>
              <div class="latency-progress">
                <div class="latency-progress-bar" style="width: \${Math.min(server.latency / 1000 * 100, 100)}%"></div>
              </div>
            </div>
            <div class="latency-value \${latencyClass}">\${server.latency}ms</div>
            <div>\${server.success ? '✅' : '❌'}</div>
          </div>
        \`;
      });

      const avgLatency = successCount > 0 ? Math.round(totalLatency / successCount) : 0;
      
      html += \`<div style="margin-top:10px;font-weight:bold;text-align:center">成功率: \${successCount}/\${servers.length} (\${((successCount/servers.length)*100).toFixed(1)}%) | 平均延迟: \${avgLatency}ms</div>\`;
      
      $('latencyResultsModal').innerHTML = html;
      
      toast(\`测试完成: \${successCount}/\${servers.length} 个服务器可用，平均延迟 \${avgLatency}ms\`, 'success');
      
    } catch (error) {
      toast('测试失败: ' + error.message, 'error');
      $('latencyResultsModal').innerHTML = '<div style="color:#ef4444">测试失败: ' + error.message + '</div>';
    } finally {
      $('startLatency').disabled = false;
      $('testAndUpload').disabled = false;
      $('startLatency').textContent = '🚀 开始测试';
    }
  };

  // 测试并上传功能 - 生成简洁格式
  $('testAndUpload').onclick=async function(){
    if (latencyTestResults.length === 0) {
      toast('请先进行延迟测试','error');
      return;
    }

    if(!token.value){ 
      toast('请填写验证 Token','error'); 
      $('token').focus(); 
      return; 
    }

    const threshold = parseInt($('latencyThreshold').value) || 300;
    const filteredResults = latencyTestResults.filter(server => 
      server.success && server.latency <= threshold
    );

    if (filteredResults.length === 0) {
      toast('没有符合条件的服务器','error');
      return;
    }

    // 生成简洁格式的订阅内容
    const subscriptionLines = filteredResults.map(server => {
      const address = server.original.split('#')[0].trim();
      return \`\${address}#香港\`; // 可以根据需要修改地区
    });

    const subscriptionContent = subscriptionLines.join('\\n');

    // 使用FormData确保格式正确
    const formData = new FormData();
    formData.append('content', subscriptionContent);
    formData.append('saveMode', currentSaveMode);
    formData.append('token', token.value);

    try {
      const res = await fetch('/api/publish?token=' + encodeURIComponent(token.value), {
        method: 'POST',
        body: formData
      });
      
      const j = await res.json(); 
      if(!j.ok) throw new Error(j.error || '发布失败');
      
      toast('成功上传 ' + filteredResults.length + ' 个节点', 'success');
      closeM($('latencyModal'));
      
    } catch(e) { 
      toast('上传失败: ' + (e && e.message ? e.message : e), 'error'); 
    }
  };

  // 测试全部节点
  $('testAllBtn').onclick=function(){
    if (currentPreviewLines.length === 0) {
      toast('请先生成预览','error');
      return;
    }
    
    const servers = currentPreviewLines.map(line => {
      const [address] = line.split('#');
      return address;
    }).filter(addr => addr);
    
    $('latencyServers').value = servers.join('\\n');
    openM($('latencyModal'));
    toast(\`已导入 \${servers.length} 个节点到测试列表\`, 'success');
  };

  // 更新输出区域显示，添加测试按钮
  function updateOutputWithTestButtons(lines) {
    currentPreviewLines = lines;
    const container = $('outputContainer');
    const textarea = $('out');
    
    // 清空容器
    container.innerHTML = '';
    
    // 创建新的文本区域
    const newTextarea = document.createElement('textarea');
    newTextarea.id = 'out';
    newTextarea.className = 'mono';
    newTextarea.rows = 18;
    newTextarea.placeholder = '点击"生成预览"后在此显示结果';
    newTextarea.style.width = '100%';
    newTextarea.style.border = 'none';
    newTextarea.style.background = 'transparent';
    newTextarea.style.resize = 'none';
    newTextarea.value = lines.join('\\n');
    
    // 创建带按钮的显示区域
    const linesContainer = document.createElement('div');
    linesContainer.style.maxHeight = '400px';
    linesContainer.style.overflowY = 'auto';
    
    lines.forEach((line, index) => {
      const lineDiv = document.createElement('div');
      lineDiv.className = 'output-line';
      
      const textSpan = document.createElement('span');
      textSpan.className = 'output-text';
      textSpan.textContent = line;
      
      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'output-actions';
      
      const testBtn = document.createElement('button');
      testBtn.className = 'btn secondary small';
      testBtn.textContent = '测试';
      testBtn.title = '测试此节点延迟';
      testBtn.onclick = () => {
        $('latencyServers').value = line.split('#')[0];
        openM($('latencyModal'));
        toast('已添加到测试列表', 'success');
      };
      
      actionsDiv.appendChild(testBtn);
      lineDiv.appendChild(textSpan);
      lineDiv.appendChild(actionsDiv);
      linesContainer.appendChild(lineDiv);
    });
    
    // 添加标签页切换
    const tabContainer = document.createElement('div');
    tabContainer.style.display = 'flex';
    tabContainer.style.marginBottom = '10px';
    tabContainer.style.borderBottom = '1px solid var(--border)';
    
    const textTab = document.createElement('button');
    textTab.textContent = '纯文本视图';
    textTab.style.padding = '8px 16px';
    textTab.style.border = 'none';
    textTab.style.background = 'transparent';
    textTab.style.borderBottom = '2px solid var(--primary)';
    textTab.style.cursor = 'pointer';
    
    const buttonTab = document.createElement('button');
    buttonTab.textContent = '带测试按钮视图';
    buttonTab.style.padding = '8px 16px';
    buttonTab.style.border = 'none';
    buttonTab.style.background = 'transparent';
    buttonTab.style.cursor = 'pointer';
    
    let currentView = 'buttons';
    
    textTab.onclick = () => {
      if (currentView === 'buttons') {
        container.innerHTML = '';
        container.appendChild(newTextarea);
        textTab.style.borderBottom = '2px solid var(--primary)';
        buttonTab.style.borderBottom = 'none';
        currentView = 'text';
      }
    };
    
    buttonTab.onclick = () => {
      if (currentView === 'text') {
        container.innerHTML = '';
        container.appendChild(tabContainer);
        container.appendChild(linesContainer);
        textTab.style.borderBottom = 'none';
        buttonTab.style.borderBottom = '2px solid var(--primary)';
        currentView = 'buttons';
      }
    };
    
    tabContainer.appendChild(textTab);
    tabContainer.appendChild(buttonTab);
    
    // 默认显示带按钮的视图
    container.appendChild(tabContainer);
    container.appendChild(linesContainer);
  }

  // progress + actions
  var go=$('go'), upload=$('upload'), copy=$('copy'), statsBtn=$('statsBtn');
  var out=$('out'), progWrap=$('progWrap'), bar=$('bar'), mini=$('miniStats'), latencyResults=$('latencyResults');
  function showProg(){ progWrap.style.display='block'; bar.style.width='0%'; }

  var last=null;
  go.onclick=async function(){
    try{
      go.disabled=true; out.value=''; mini.textContent=''; latencyResults.innerHTML=''; showProg(); await new Promise(r=>setTimeout(r,60));

      var fd=new FormData();
      (fileList||[]).forEach(f=>fd.append('files',f));
      fd.append('pasted',$('pasted').value||'');
      fd.append('saveMode', currentSaveMode);

      // advanced
      fd.append('nodePrefix',nodePrefix.value||''); fd.append('nodeSuffix',nodeSuffix.value||'');
      fd.append('digits',digits.value||'2');
      fd.append('speedMode',speedMode.value||'2');
      fd.append('minSpeed',minSpeed.value||'0');
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
      bar.style.width='100%'; 
      
      // 使用新的带按钮的显示方式
      updateOutputWithTestButtons(j.lines || []);
      last=j;

      const s=j.stats||{};
      let statsText = [
        '输入总行数:'+(s.rows_total??'—'),
        'IPv4:'+(s.ipv4_count??'—'),
        'IPv6:'+(s.ipv6_count??'—'),
        '域名:'+(s.domain_count??'—'),
        '带速度:'+(s.with_speed_count??'—'),
        '速度过滤:'+(s.skipped_speed??'—'),
        '配额后行数:'+(s.total_after_quota??'—'),
        '最终输出行数:'+(s.output_count??(j.count??'—'))
      ];

      mini.textContent = statsText.join('  ·  ');

      toast('处理完成 ✓','success');
    }catch(e){ toast('处理失败：'+(e&&e.message?e.message:e),'error'); }
    finally{ go.disabled=false; setTimeout(()=>{progWrap.style.display='none';bar.style.width='0%';},400); }
  };

  copy.onclick=async function(){
    try{ 
      const outText = $('out').value;
      await navigator.clipboard.writeText(outText); 
      toast('已复制','success'); 
    } catch(_){ 
      try{ 
        $('out').select(); 
        document.execCommand('copy'); 
        toast('已复制','success'); 
      } catch(e){ 
        toast('复制失败','error'); 
      } 
    }
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
      '速度过滤: '+(s.skipped_speed??0),
      '每国 IPv4: '+(s.quota_v4??0),
      '每国 IPv6: '+(s.quota_v6??0),
      '每国前 N: '+(document.getElementById('quotaPerTop').value||0),
      '全局前 N: '+(document.getElementById('quotaTopN').value||0),
      '最小速度: '+(document.getElementById('minSpeed').value||0)+' MB/s',
      '最终前 N: '+(s.limit_maxlines? s.limit_maxlines : '不限制'),
      '因配额跳过: '+(s.skipped_quota??0),
      '配额后行数: '+(s.total_after_quota??'—'),
      '最终返回行数: '+(j.count??'—')+(j.truncated?'（预览截断）':''),
      '保存模式: '+(currentSaveMode==='overwrite'?'覆盖保存':'追加保存')
    ];

    $('previewBox').textContent = box.join('\\n'); openM($('previewModal'));
  };

  upload.onclick=async function(){
    if(!last || !last.lines || !last.lines.length){ toast('请先生成预览','error'); return; }
    if(!token.value){ toast('请填写验证 Token','error'); $('token').focus(); return; }
    try{
      const res=await fetch('/api/publish?token='+encodeURIComponent(token.value),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:last.lines.join('\\n'), saveMode: currentSaveMode})});
      const j=await res.json(); if(!j.ok) throw new Error(j.error||'发布失败');
      toast('已'+(currentSaveMode==='overwrite'?'覆盖':'追加')+'上传','success');
    }catch(e){ toast('上传失败：'+(e&&e.message?e.message:e),'error'); }
  };

})();
</script>
</body>
</html>`;
