// YouXuan-API — Cloudflare Worker (2025-10-29)
//
// 本版更新：
// - 独立入口：🎨 个性化设置、🧩 高级设置、🧮 配额与限制（置于主按钮之后）
// - 国家+城市去重（🇭🇰香港，不再“香港香港”）
// - “地区显示”支持：仅国家(country) / 仅国家+城市(country_city) / 仅城市(city_only)
// - 英文缩写模式(A2)保持“JP东京/US洛杉矶”；仅国家模式则“JP/US”
// - 预览/发布后端：多文件追加上传；单位不换算，仅格式化
// - 配额与限制：每国IPv4数、每国IPv6数、每国合计前N条（新增 quotaCountryTop）+ 全局前N条
// - 无法匹配国家时不留空，回退使用原始地区码（如 IATA/WAW 等）
// - 国家/IATA 库补充：LAX/SJC/HKG/DEN/SEA/DFW/CDG/WAW/FRA/OTP/MAN/DUS
// - UI：移动端单列栅格、按钮自适应宽度；深色模式 pill 黑底白字；个性化设置里背景/Logo上传+重置、背景透明度
//
// Endpoints:
//   UI:       GET /
//   Status:   GET /api/status
//   Preview:  POST /api/preview   (multipart: files[] + pasted + options)
//   Publish:  POST /api/publish?token=TOKEN  (或 Header: x-token)
//   Read Sub: GET /{TOKEN} 或 /{TOKEN}.json

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

      // Status
      if (request.method === "GET" && path === "/api/status") {
        return J({ ok: true, kvBound: !!env.KV, tokenSet: !!env.TOKEN, repo: REPO });
      }

      // Read subscription
      if (request.method === "GET" && path && path !== "/" && !path.startsWith("/api/")) {
        if (!env.KV) return new Response("KV not bound", { status: 500 });
        const seg = path.slice(1);
        const asJson = seg.endsWith(".json");
        const token = asJson ? seg.slice(0, -5) : seg;
        if (!env.TOKEN || token !== env.TOKEN) return new Response("Not Found", { status: 404 });

        const content = await env.KV.get("sub:" + token);
        if (!content) return new Response("Not Found", { status: 404 });

        if (!asJson) {
          return new Response(content, {
            headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=60" }
          });
        } else {
          const meta = await env.KV.get("meta:" + token, "json");
          return J({ ok: true, key: token, ...meta, lines: content.split("\n") });
        }
      }

      // Preview (multi-files + pasted)
      if (request.method === "POST" && path === "/api/preview") {
        const form = await safeFormData(request);
        if (!form) return J({ ok: false, error: "Invalid form" }, 400);

        // combine text
        const files = form.getAll("files");
        const pasted = (form.get("pasted") || "").toString();
        let combined = "";
        if (files && files.length) {
          for (const f of files) {
            if (f && typeof f.text === "function") combined += (await f.text()) + "\n";
          }
        }
        if (pasted && pasted.trim()) combined += pasted.trim() + "\n";
        combined = combined.trim();
        if (!combined) return J({ ok: false, error: "没有检测到内容（请上传或粘贴）" });

        // options
        const regionLang   = (form.get("regionLang")   || "zh").toString().trim();       // zh | a2
        const regionDetail = (form.get("regionDetail") || "country").toString().trim();  // country | country_city | city_only
        const decorateFlg  = form.get("decorateFlag") === "on";
        const nodePrefix   = (form.get("nodePrefix") || "").toString();
        const nodeSuffix   = (form.get("nodeSuffix") || "").toString();

        const appendUnit   = form.get("appendUnit") === "on";
        const digits       = clampInt(toPosInt(form.get("digits"), 2), 0, 6);

        // quotas
        const quotaV4      = toPosInt(form.get("quotaV4"), 0);             // 每国 IPv4
        const quotaV6      = toPosInt(form.get("quotaV6"), 0);             // 每国 IPv6
        const quotaCountryTop = toPosInt(form.get("quotaCountryTop"), 0);  // 每国合计前 N 条（新增）
        const maxLinesReq  = toPosInt(form.get("maxLines"), 0);            // 全局前 N 条

        // parse CSV/TXT
        const delimiter = sniffDelimiter(combined);
        const rows = parseCSV(combined, delimiter);
        if (!rows.length) return J({ ok: false, error: "CSV/TXT 内容为空" });

        const hasHeader = looksLikeHeader(rows[0]);
        const headers   = hasHeader ? rows[0] : Array.from({ length: rows[0].length }, (_, i) => "列" + (i + 1));
        const dataRows  = hasHeader ? rows.slice(1) : rows;

        // auto-detect columns
        const lower = headers.map(h => String(h || "").toLowerCase());
        const pick = (goods, bads = []) => {
          for (let i = 0; i < lower.length; i++) {
            const h = lower[i];
            if (goods.some(g => h.includes(g)) && !bads.some(b => h.includes(b))) return i;
          }
          return -1;
        };
        let ipIdx     = pick(["ip", "ip地址", "address", "host"]);
        let regionIdx = pick(["region", "region_code", "country", "code", "地区码", "国家", "城市", "city", "iata", "site", "location"]);
        let speedIdx  = pick(
          ["下载速度", "下载", "mb/s", "speed", "bandwidth", "throughput", "down", "download", "rate", "峰值", "下行", "速度"],
          ["延迟", "latency", "avg", "平均延迟", "rtt", "ping"]
        );

        // fallback for IP
        if (ipIdx < 0) {
          const ip4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
          outer: for (let c = 0; c < headers.length; c++) {
            let hits = 0;
            for (let r = 0; r < Math.min(300, dataRows.length); r++) {
              const v = String(dataRows[r][c] ?? "").trim();
              if (ip4.test(v) || (v.includes(":") && isIPv6(v))) hits++;
            }
            if (hits >= 6) { ipIdx = c; break outer; }
          }
        }

        const stats = {
          rows_total: dataRows.length, headers_count: headers.length,
          ipv4_count: 0, ipv6_count: 0, recognized_ip_rows: 0,
          with_speed_count: 0,
          quota_v4: quotaV4, quota_v6: quotaV6, quota_country_top: quotaCountryTop,
          limit_maxlines: maxLinesReq, skipped_quota: 0, total_after_quota: 0,
          output_count: 0, skipped_count: 0
        };

        const perV4 = Object.create(null), perV6 = Object.create(null), perAny = Object.create(null);
        const lines = [];

        for (const row of dataRows) {
          const col = (i) => (i >= 0 && i < row.length && row[i] != null) ? String(row[i]).trim() : "";

          const ipRaw = col(ipIdx);
          if (!ipRaw) { stats.skipped_count++; continue; }
          const v4 = isIPv4(ipRaw);
          const v6 = !v4 && isIPv6(ipRaw);
          if (!v4 && !v6) { stats.skipped_count++; continue; }

          stats.recognized_ip_rows++;
          if (v4) stats.ipv4_count++; else stats.ipv6_count++;

          // region parse -> {a2, sub, cityZh, raw}
          const regRaw = col(regionIdx);
          const parsed = codeCityFromAny(regRaw);
          const { a2, sub, cityZh, raw } = parsed;

          // label (dedupe; fallback 原地区码)
          const label = formatRegionLabelDedupe({ a2, sub, cityZh, raw }, regionLang, regionDetail);

          // speed
          const spStr = formatSpeedRaw(col(speedIdx), appendUnit, digits);
          if (spStr) stats.with_speed_count++;

          // IPv6 display
          let ipDisp = ipRaw;
          if (v6 && !/^\[.*\]$/.test(ipRaw)) ipDisp = "[" + ipRaw + "]";

          // flag
          const flag = (decorateFlg && a2) ? flagFromA2(a2) : "";

          // assemble (remove spaces)
          let line = ipDisp + "#" + (nodePrefix || "") + (flag || "") + (label || "") + (spStr || "") + (nodeSuffix || "");
          line = line.replace(/\s+/g, "");

          // per-country quotas
          const key = a2 || "__RAW__:" + (raw || "");
          if (quotaCountryTop > 0) {
            const c = perAny[key] || 0;
            if (c >= quotaCountryTop) { stats.skipped_quota++; continue; }
            perAny[key] = c + 1;
          }
          if (v4 && quotaV4 > 0) {
            const c = perV4[key] || 0;
            if (c >= quotaV4) { stats.skipped_quota++; continue; }
            perV4[key] = c + 1;
          }
          if (v6 && quotaV6 > 0) {
            const c = perV6[key] || 0;
            if (c >= quotaV6) { stats.skipped_quota++; continue; }
            perV6[key] = c + 1;
          }

          lines.push(line);
        }

        stats.total_after_quota = lines.length;

        const applied = (maxLinesReq > 0) ? lines.slice(0, maxLinesReq) : lines;
        const MAX_PREV = 20000;
        const preview  = applied.slice(0, MAX_PREV);
        stats.output_count  = applied.length;
        stats.skipped_count = Math.max(stats.skipped_count, stats.rows_total - stats.output_count);

        return J({ ok: true, lines: preview, count: applied.length, headers, stats, truncated: applied.length > MAX_PREV });
      }

      // Publish
      if (request.method === "POST" && path === "/api/publish") {
        if (!env.KV)    return J({ ok: false, error: "KV not bound" }, 500);
        if (!env.TOKEN) return J({ ok: false, error: "TOKEN not configured" }, 500);

        const q = new URL(request.url).searchParams;
        let token = q.get("token") || request.headers.get("x-token");
        const ct = request.headers.get("content-type") || "";
        let content = "";

        if (!token && ct.includes("application/json")) {
          try { const jj = await request.json(); token = (jj.token || "").toString(); content = (jj.content || "").toString(); } catch(_) {}
        }
        if (!token && ct.includes("multipart/form-data")) {
          const f = await request.formData(); token = (f.get("token") || "").toString(); content = (f.get("content") || "").toString();
        }
        if (!token) { if (ct && !content) content = await request.text(); }

        if (token !== env.TOKEN) return J({ ok: false, error: "Unauthorized (bad token)" }, 401);
        if (!content) {
          content = await request.text();
          if (!content) return J({ ok: false, error: "content is empty" }, 400);
        }

        const key = env.TOKEN;
        content = content.split("\n").map(s => (s || "").replace(/\s+/g, "")).join("\n");
        await env.KV.put("sub:" + key, content);
        const meta = { updated: Date.now(), count: content ? content.split("\n").length : 0 };
        await env.KV.put("meta:" + key, JSON.stringify(meta));
        return J({ ok: true, key, count: meta.count, updated: meta.updated });
      }

      return new Response("Not Found", { status: 404 });
    } catch (e) {
      return J({ ok: false, error: e && e.message ? e.message : String(e) }, 500);
    }
  }
};

/* ---------------- helpers ---------------- */
function J(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } }); }
async function safeFormData(req) { try { return await req.formData(); } catch (_) { return null; } }
function toPosInt(v, d) { const n = parseInt(String(v ?? "").trim(), 10); return Number.isFinite(n) && n >= 0 ? n : d; }
function clampInt(n, a, b) { return Math.max(a, Math.min(b, n)); }

// CSV
function sniffDelimiter(sample) {
  const head = sample.slice(0, 10000);
  const c = { ",": (head.match(/,/g) || []).length, ";": (head.match(/;/g) || []).length, "\t": (head.match(/\t/g) || []).length, "|": (head.match(/\|/g) || []).length };
  const arr = Object.entries(c).sort((a, b) => b[1] - a[1]);
  return arr[0] ? arr[0][0] : ",";
}
function looksLikeHeader(row) { if (!row || !row.length) return false; return row.some(v => /[A-Za-z\u4e00-\u9fa5]/.test(String(v || ""))); }
function parseCSV(text, d) {
  const rows = []; let i = 0, field = '', row = [], inQ = false;
  const pf = () => { row.push(field); field = ''; }, pr = () => { rows.push(row); row = []; };
  while (i < text.length) {
    const ch = text[i];
    if (inQ) { if (ch == '"') { const n = text[i + 1]; if (n == '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; } field += ch; i++; continue; }
    if (ch == '"') { inQ = true; i++; continue; }
    if (ch === d) { pf(); i++; continue; }
    if (ch == '\r') { i++; continue; }
    if (ch == '\n') { pf(); pr(); i++; continue; }
    field += ch; i++;
  }
  pf(); if (row.length > 1 || row[0] !== '') pr(); return rows;
}

/* ---------------- region/city code ---------------- */

// IATA -> A2/Sub/CityZH
const IATA_TO_A2 = {
  LAX:"US", SJC:"US", SFO:"US", SEA:"US", DEN:"US", EWR:"US", JFK:"US", DFW:"US",
  LHR:"GB", MAN:"GB",
  HKG:"HK",
  NRT:"JP", HND:"JP",
  CDG:"FR", FRA:"DE", DUS:"DE", WAW:"PL", OTP:"RO",
  SIN:"SG",
  AMS:"NL", BRU:"BE", DUB:"IE",
  MAA:"IN", BOM:"IN",
  ICN:"KR", ZRH:"CH", BKK:"TH"
};
const IATA_TO_SUB = { LAX:"CA", SJC:"CA", SFO:"CA", SEA:"WA", DEN:"CO", EWR:"NJ", JFK:"NY", DFW:"TX" };
const IATA_TO_CITY_ZH = {
  LAX:"洛杉矶", SJC:"圣何塞", SFO:"旧金山", SEA:"西雅图", DEN:"丹佛", EWR:"新泽西", JFK:"纽约", DFW:"达拉斯",
  LHR:"伦敦", MAN:"曼彻斯特", HKG:"香港",
  NRT:"东京", HND:"东京", CDG:"巴黎", FRA:"法兰克福", DUS:"杜塞尔多夫", WAW:"华沙", OTP:"布加勒斯特",
  SIN:"新加坡", AMS:"阿姆斯特丹", BRU:"布鲁塞尔", DUB:"都柏林",
  MAA:"金奈", BOM:"孟买", ICN:"首尔", ZRH:"苏黎世", BKK:"曼谷"
};

// alpha-3 -> alpha-2
const A3_TO_A2 = {
  HKG:"HK", MAC:"MO", TWN:"TW", CHN:"CN", USA:"US", JPN:"JP", KOR:"KR", SGP:"SG",
  MYS:"MY", VNM:"VN", THA:"TH", PHL:"PH", IDN:"ID", IND:"IN",
  GBR:"GB", FRA:"FR", DEU:"DE", ITA:"IT", ESP:"ES", RUS:"RU", CAN:"CA", AUS:"AU",
  NLD:"NL", BRA:"BR", ARG:"AR", MEX:"MX", TUR:"TR", ARE:"AE", ISR:"IL", ZAF:"ZA",
  SWE:"SE", NOR:"NO", DNK:"DK", FIN:"FI", POL:"PL", CZE:"CZ", AUT:"AT", CHE:"CH",
  BEL:"BE", IRL:"IE", PRT:"PT", GRC:"GR", HUN:"HU", ROU:"RO", UKR:"UA", NZL:"NZ"
};

// Chinese country names (fallback to A2)
const COUNTRY_ZH = {
  CN:"中国", HK:"香港", MO:"澳门", TW:"台湾",
  US:"美国", GB:"英国", DE:"德国", FR:"法国", NL:"荷兰", BE:"比利时", IE:"爱尔兰",
  JP:"日本", SG:"新加坡", IN:"印度",
  AE:"阿联酋", TR:"土耳其", RU:"俄罗斯", AU:"澳大利亚", CA:"加拿大",
  ES:"西班牙", IT:"意大利", KR:"韩国", BR:"巴西", MX:"墨西哥", ZA:"南非",
  CH:"瑞士", TH:"泰国", PL:"波兰", RO:"罗马尼亚"
};

// province/state zh (subset)
const CN_SUBDIVISION_ZH = {"BJ":"北京","SH":"上海","GD":"广东","ZJ":"浙江","JS":"江苏","SD":"山东","SC":"四川","HN":"湖南","HB":"湖北","HE":"河北","LN":"辽宁","JL":"吉林","HL":"黑龙江","FJ":"福建","GX":"广西","HA":"河南","JX":"江西","SN":"陕西","SX":"山西","TJ":"天津","CQ":"重庆","YN":"云南","AH":"安徽","HI":"海南","GZ":"贵州","NM":"内蒙古","XZ":"西藏","GS":"甘肃","QH":"青海","NX":"宁夏","XJ":"新疆"};
const US_STATE_ZH      = {"CA":"加利福尼亚","WA":"华盛顿","CO":"科罗拉多","NJ":"新泽西","NY":"纽约","TX":"得克萨斯","FL":"佛罗里达","IL":"伊利诺伊","GA":"佐治亚","PA":"宾夕法尼亚","MA":"马萨诸塞","VA":"弗吉尼亚"};

// English city keywords -> zh
const CITY_EN_TO_ZH = {
  "TOKYO":"东京","OSAKA":"大阪","SINGAPORE":"新加坡","SEOUL":"首尔","LONDON":"伦敦","FRANKFURT":"法兰克福","PARIS":"巴黎",
  "AMSTERDAM":"阿姆斯特丹","BRUSSELS":"布鲁塞尔","DUBLIN":"都柏林","MANCHESTER":"曼彻斯特","DUBAI":"迪拜",
  "LOS ANGELES":"洛杉矶","LOSANGELES":"洛杉矶","SEATTLE":"西雅图","SAN FRANCISCO":"旧金山","SANFRANCISCO":"旧金山","SAN JOSE":"圣何塞","SANJOSE":"圣何塞",
  "NEW YORK":"纽约","NEWYORK":"纽约","NEW JERSEY":"新泽西","JERSEY":"新泽西","DENVER":"丹佛","CHICAGO":"芝加哥","DALLAS":"达拉斯","MIAMI":"迈阿密","WASHINGTON":"华盛顿",
  "MUMBAI":"孟买","BOMBAY":"孟买","CHENNAI":"金奈","ZURICH":"苏黎世","BANGKOK":"曼谷","HONG KONG":"香港","HONGKONG":"香港","SHANGHAI":"上海","BEIJING":"北京","SHENZHEN":"深圳","GUANGZHOU":"广州",
  "WARSAW":"华沙","BUCHAREST":"布加勒斯特","DUSSELDORF":"杜塞尔多夫","DÜSSELDORF":"杜塞尔多夫"
};
const CITY_ZH_LIST = ["东京","大阪","新加坡","首尔","伦敦","法兰克福","巴黎","阿姆斯特丹","布鲁塞尔","都柏林","曼彻斯特","迪拜","洛杉矶","西雅图","旧金山","圣何塞","纽约","新泽西","丹佛","芝加哥","达拉斯","迈阿密","华盛顿","苏黎世","曼谷","香港","上海","北京","深圳","广州","金奈","孟买","华沙","布加勒斯特","杜塞尔多夫"];

// detect a2/sub/cityZh
function codeCityFromAny(rawInput) {
  const s0 = String(rawInput || "").trim();
  if (!s0) return { a2: "", sub: "", cityZh: "", raw: "" };
  const sU = s0.toUpperCase();

  // US-CA / CN-GD
  let m = sU.match(/\b([A-Z]{2})[-_ ]([A-Z]{2})\b/);
  if (m) return { a2: m[1], sub: m[2], cityZh: "", raw: s0 };

  // IATA
  m = sU.match(/\b([A-Z]{3})\b/);
  if (m) {
    const i = m[1];
    if (IATA_TO_A2[i]) {
      return { a2: IATA_TO_A2[i], sub: (IATA_TO_SUB[i] || ""), cityZh: (IATA_TO_CITY_ZH[i] || ""), raw: s0 };
    }
    if (A3_TO_A2[i]) return { a2: A3_TO_A2[i], sub: "", cityZh: "", raw: s0 };
  }

  // A2 anywhere
  m = sU.match(/\b([A-Z]{2})\b/);
  if (m) return { a2: m[1], sub: "", cityZh: cityZhFromText(s0), raw: s0 };

  // by city keywords
  const cityZh = cityZhFromText(s0);
  if (cityZh) return { a2: reverseCityToA2(cityZh) || "", sub: "", cityZh, raw: s0 };

  return { a2: "", sub: "", cityZh: "", raw: s0 };
}
function cityZhFromText(s) {
  const S = s.toUpperCase();
  const mm = S.match(/\b([A-Z]{3})\b/);
  if (mm && IATA_TO_CITY_ZH[mm[1]]) return IATA_TO_CITY_ZH[mm[1]];
  for (const k in CITY_EN_TO_ZH) if (S.includes(k)) return CITY_EN_TO_ZH[k];
  for (const z of CITY_ZH_LIST) if (s.includes(z)) return z;
  return "";
}
function reverseCityToA2(cityZh) {
  for (const k in IATA_TO_CITY_ZH) if (IATA_TO_CITY_ZH[k] === cityZh) return IATA_TO_A2[k] || "";
  const map = { "香港":"HK","东京":"JP","大阪":"JP","新加坡":"SG","首尔":"KR","伦敦":"GB","法兰克福":"DE","巴黎":"FR","阿姆斯特丹":"NL","布鲁塞尔":"BE","都柏林":"IE","曼彻斯特":"GB","迪拜":"AE","洛杉矶":"US","西雅图":"US","旧金山":"US","圣何塞":"US","纽约":"US","新泽西":"US","丹佛":"US","芝加哥":"US","达拉斯":"US","迈阿密":"US","华盛顿":"US","苏黎世":"CH","曼谷":"TH","金奈":"IN","孟买":"IN","上海":"CN","北京":"CN","深圳":"CN","广州":"CN","华沙":"PL","布加勒斯特":"RO","杜塞尔多夫":"DE" };
  return map[cityZh] || "";
}
function zhCountryName(a2) { return COUNTRY_ZH[String(a2 || "").toUpperCase()] || String(a2 || ""); }
function flagFromA2(a2) {
  if (!a2 || a2.length !== 2) return "";
  const RI = 0x1F1E6, A = 'A'.codePointAt(0); const up = a2.toUpperCase();
  return String.fromCodePoint(RI + (up.codePointAt(0) - A), RI + (up.codePointAt(1) - A));
}

// country+city dedupe & formatting
const CITY_STATE_A2 = new Set(["HK", "MO", "SG"]); // 城市国家：不追加城市名
function formatRegionLabelDedupe({ a2, sub, cityZh, raw }, lang, detail) {
  // 无法识别国家：回退原地区码或城市
  if (!a2) {
    if (detail === "city_only" && cityZh) return cityZh;
    return (raw || cityZh || "").toString();
  }

  const baseZH = zhCountryName(a2);
  const baseA2 = a2;
  const base   = (lang === "a2") ? baseA2 : baseZH;

  if (detail === "country") return base;

  if (detail === "country_city") {
    if (!cityZh || cityZh === baseZH || CITY_STATE_A2.has(a2)) return base;
    return base + cityZh; // A2: JP东京；ZH: 日本东京
  }

  if (detail === "city_only") {
    return cityZh || base; // 没识别到城市就退回国家名/缩写
  }

  return base;
}

/* ---------------- net & speed ---------------- */
function isIPv4(v) { return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(String(v || "")); }
function isIPv6(v) {
  v = String(v || "").trim();
  if (!v) return false;
  if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1);
  if (!v.includes(":")) return false;
  const re = /^((?:[0-9a-fA-F]{1,4}:){1,7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}|(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}|(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}|(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:(?:(?::[0-9a-fA-F]{1,4}){1,6})|:(?:(?::[0-9a-fA-F]{1,4}){1,7}|:)|(?:[0-9a-fA-F]{1,4}:){1,6}(?:\d{1,3}\.){3}\d{1,3}|::(?:[0-9a-fA-F]{1,4}:){0,5}(?:\d{1,3}\.){3}\d{1,3})$/;
  return re.test(v);
}
function formatSpeedRaw(raw, appendUnit, digits) {
  raw = String(raw || "").trim();
  if (!raw) return "";
  const m = raw.match(/-?\d+(?:\.\d+)?/);
  if (!m) return "";
  let val = parseFloat(m[0]); if (!Number.isFinite(val)) return "";
  const body = (digits === 0) ? String(Math.round(val)) : Number(val).toFixed(digits);
  const hasUnit = /[a-zA-Z\/]/.test(raw);
  if (hasUnit) return raw.replace(m[0], body).replace(/mb\s*\/\s*s/i, "MB/s");
  return appendUnit ? (body + "MB/s") : body;
}

/* ---------------- UI ---------------- */
const HTML = `<!doctype html>
<html lang="zh" data-theme="light">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>YouXuan-API</title>
<style>
:root{
  --bg:#f6f7fb; --card:#ffffff; --text:#111827; --muted:#6b7280; --border:#e5e7eb;
  --primary:#3b82f6; --accent:#8b5cf6; --shadow:0 18px 40px rgba(0,0,0,.08);
}
html[data-theme="dark"]{
  --bg:#0f172a; --card:#0c1220; --text:#e5e7eb; --muted:#9ca3af; --border:#1f2937;
  --primary:#60a5fa; --accent:#a78bfa; --shadow:0 24px 60px rgba(0,0,0,.35);
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,PingFang SC,Microsoft YaHei,Helvetica,Arial;position:relative}
#wp{position:fixed;inset:0;background-position:center;background-size:cover;opacity:.18;filter:blur(8px);pointer-events:none;z-index:-1}
.center{min-height:100dvh;display:grid;place-items:start center;padding-top:72px}
.container{width:min(1160px,92vw)}
.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;gap:10px}
.brand{display:flex;align-items:center;gap:12px}
.logoWrap{width:52px;height:52px;border-radius:16px;overflow:hidden;box-shadow:0 12px 28px rgba(59,130,246,.35);background:linear-gradient(135deg,var(--primary),var(--accent));display:grid;place-items:center}
.logoWrap img{width:100%;height:100%;object-fit:cover;display:block}
.title{font-size:26px;font-weight:900}
.header-right{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.pill{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--border);background:var(--card);padding:8px 12px;border-radius:999px;font-weight:700}
html[data-theme="dark"] .pill, html[data-theme="dark"] a.pill{background:#0b0f1a;color:#fff;border-color:#1f2937}
a.pill{text-decoration:none;color:inherit}
.btn{display:inline-flex;align-items:center;gap:10px;background:linear-gradient(90deg,var(--primary),var(--accent));border:none;border-radius:12px;padding:12px 16px;color:#fff;cursor:pointer;font-weight:800}
.btn.secondary{background:linear-gradient(90deg,#e5e7eb,#f3f4f6);color:#111827;border:1px solid var(--border)}
html[data-theme="dark"] .btn.secondary{background:linear-gradient(90deg,#0b1220,#0f172a);color:#e5e7eb;border:1px solid var(--border)}
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow)}
.card.pad{padding:18px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
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
.chip{position:relative;display:inline-flex;align-items:center;gap:10px;border:1px solid var(--border);background:#fff;border-radius:12px;padding:8px 12px;box-shadow:0 4px 10px rgba(0,0,0,.05)}
html[data-theme="dark"] .chip{background:#0b1220;color:#e5e7eb}
.gridIcon{width:28px;height:28px;border-radius:8px;background:#10b981;display:grid;place-items:center;color:#fff;font-weight:900}
.chip .x{position:absolute;top:-6px;right:-6px;width:20px;height:20px;border:none;border-radius:50%;background:#00000022;color:#111;cursor:pointer}
html[data-theme="dark"] .chip .x{background:#ffffff33;color:#fff}
.chip .eye{border:none;background:transparent;cursor:pointer}

/* progress */
.progress{height:10px;background:transparent;border:1px solid var(--border);border-radius:999px;overflow:hidden;margin-bottom:8px}
.bar{height:100%;width:0%;background:linear-gradient(90deg,var(--primary),var(--accent));transition:width .25s ease}
.indeterminate{position:relative;overflow:hidden}
.indeterminate .bar{position:absolute;width:30%;left:-30%;animation:ind 1.2s infinite}
@keyframes ind{0%{left:-30%}50%{left:50%}100%{left:100%}}

/* modal & toast */
.modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.35);padding:18px;z-index:50}
.panel{max-width:900px;width:100%;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:18px}
.panel .title{font-weight:900;margin-bottom:8px}
.actions{display:flex;justify-content:flex-end;gap:10px;margin-top:10px}
.toast{position:fixed;right:18px;bottom:18px;background:var(--card);border:1px solid var(--border);color:var(--text);padding:12px 16px;border-radius:12px;opacity:0;transform:translateY(10px);transition:all .25s ease;z-index:60}
.toast.show{opacity:1;transform:translateY(0)}

/* actions bar (mobile full width) */
.actionsbar{display:flex;gap:10px;flex-wrap:wrap}
@media (max-width: 720px){
  .row{grid-template-columns:1fr}
  .actionsbar .btn{width:100%}
  .header{flex-direction:column;align-items:flex-start}
}
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
          <a class="pill" href="${REPO}" target="_blank">GitHub</a>
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
            <textarea id="pasted" rows="4" placeholder="粘贴内容或上方选择文件"></textarea>
          </div>
        </div>

        <div class="row">
          <div>
            <label>订阅上传 Token</label>
            <input type="text" id="token" placeholder="与服务端 TOKEN 一致（仅上传时必填）"/>
            <small class="help">订阅地址不在前端显示；用浏览器访问 <code>/{TOKEN}</code>（服务器 Secret）即可获取。</small>
          </div>
          <div></div>
        </div>

        <div style="margin-top:12px" class="actionsbar">
          <button class="btn" id="go" type="button">🚀 生成预览</button>
          <button class="btn secondary" id="upload" type="button">⬆️ 上传订阅</button>
          <button class="btn secondary" id="statsBtn" type="button">📊 查看统计</button>
          <button class="btn secondary" id="copy" type="button">📋 复制全部</button>
          <button class="btn secondary" id="personalBtn" type="button">🎨 个性化设置</button>
          <button class="btn secondary" id="advancedBtn" type="button">🧩 高级设置</button>
          <button class="btn secondary" id="quotaBtn" type="button">🧮 配额与限制</button>
        </div>
      </div>

      <div class="card pad" style="margin-top:14px">
        <div class="progress" id="progWrap" style="display:none"><div class="bar" id="bar"></div></div>
        <textarea id="out" class="mono" rows="18" placeholder="点击“生成预览”后在此显示结果"></textarea>
        <div id="miniStats" class="muted" style="margin-top:8px;line-height:1.8"></div>
      </div>
    </div>
  </div>

  <!-- 预览 -->
  <div class="modal" id="previewModal">
    <div class="panel">
      <div class="title">预览（前 50 行）</div>
      <pre id="previewBox" class="mono" style="white-space:pre-wrap;max-height:60vh;overflow:auto"></pre>
      <div class="actions"><button class="btn secondary" id="closePreview" type="button">关闭</button></div>
    </div>
  </div>

  <!-- 统计 -->
  <div class="modal" id="statsModal">
    <div class="panel">
      <div class="title">结果统计</div>
      <pre id="statsContent" class="mono" style="white-space:pre-wrap"></pre>
      <div class="actions"><button class="btn secondary" id="closeStats" type="button">关闭</button></div>
    </div>
  </div>

  <!-- 个性化设置 -->
  <div class="modal" id="personalModal">
    <div class="panel">
      <div class="title">🎨 个性化设置</div>
      <div class="row">
        <div>
          <label>上传背景</label>
          <label class="uploadBtn" for="bgFile">🖼️ 选择图片</label>
          <input type="file" id="bgFile" accept="image/*"/>
          <button class="btn secondary" id="resetBg" type="button">↺ 背景恢复默认</button>
          <label style="margin-top:10px">背景透明度</label>
          <input type="range" id="bgOpacity" min="0" max="100" step="1" value="18" />
          <small class="help">0%（不可见）— 100%（不透明）</small>
        </div>
        <div>
          <label>上传 Logo</label>
          <label class="uploadBtn" for="logoFile">🎯 选择图片</label>
          <input type="file" id="logoFile" accept="image/*"/>
          <button class="btn secondary" id="resetLogo" type="button">↺ Logo 恢复默认</button>
        </div>
      </div>
      <div class="actions"><button class="btn secondary" id="closePersonal" type="button">关闭</button></div>
    </div>
  </div>

  <!-- 高级设置 -->
  <div class="modal" id="advancedModal">
    <div class="panel">
      <div class="title">🧩 高级设置</div>
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
              <option value="country_city">仅国家+城市</option>
              <option value="city_only">仅城市</option>
            </select>
          </div>
          <label class="muted" style="margin-top:6px"><input type="checkbox" id="decorateFlag" checked/> 在地区前添加国旗</label>
        </div>
        <div>
          <label>节点前缀 / 后缀</label>
          <div class="row">
            <input type="text" id="nodePrefix" placeholder="前缀（可空）"/>
            <input type="text" id="nodeSuffix" placeholder="后缀（可空）"/>
          </div>
          <label style="margin-top:10px">速度显示</label>
          <label class="muted"><input type="checkbox" id="appendUnit" checked/> 无单位时追加 "MB/s"</label>
          <label class="muted">保留小数位：
            <select id="digits"><option value="2" selected>2</option><option value="0">0</option></select>
          </label>
        </div>
      </div>
      <div class="actions"><button class="btn secondary" id="closeAdvanced" type="button">关闭</button></div>
    </div>
  </div>

  <!-- 配额与限制 -->
  <div class="modal" id="quotaModal">
    <div class="panel">
      <div class="title">🧮 配额与限制</div>
      <div class="row">
        <div>
          <label>每个国家分别：保留 IPv4 数量</label>
          <input type="number" id="quotaV4" min="0" placeholder="0 = 不限制"/>
          <label style="margin-top:10px">每个国家分别：保留 IPv6 数量</label>
          <input type="number" id="quotaV6" min="0" placeholder="0 = 不限制"/>
        </div>
        <div>
          <label>每个国家分别：合计保留前 N 个 IP</label>
          <input type="number" id="quotaCountryTop" min="0" placeholder="0 = 不限制"/>
          <label style="margin-top:10px">不按国家：全局保留前 N 行</label>
          <input type="number" id="maxLines" min="0" placeholder="0 = 不限制"/>
        </div>
      </div>
      <div class="actions"><button class="btn secondary" id="closeQuota" type="button">关闭</button></div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

<script>
(function(){
  function $(id){return document.getElementById(id)}
  function toast(t,k){var x=$('toast');x.textContent=t;x.style.borderColor=(k==='error')?'#ef4444':(k==='success')?'#10b981':'#e5e7eb';x.classList.add('show');setTimeout(function(){x.classList.remove('show')},2000)}
  function openM(m){m.style.display='flex'} function closeM(m){m.style.display='none'}

  // Theme
  var TH='YX:theme', th=localStorage.getItem(TH)||'light';
  applyTheme(th); $('themeBtn').onclick=function(){var next=document.documentElement.dataset.theme==='light'?'dark':'light';applyTheme(next);localStorage.setItem(TH,next)};
  function applyTheme(t){document.documentElement.dataset.theme=t;$('themeBtn').textContent=(t==='light'?'🌙 深色':'🌞 浅色')}

  // KV status
  fetch('/api/status').then(r=>r.json()).then(s=>{ $('kvText').textContent='KV '+(s.kvBound?'已绑定':'未绑定'); $('kvDot').style.background=s.kvBound?'#10b981':'#9ca3af'; }).catch(()=>{});

  // Default logo
  const DEFAULT_LOGO = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="%233b82f6"/><stop offset="1" stop-color="%238b5cf6"/></linearGradient></defs><rect rx="24" ry="24" width="128" height="128" fill="url(%23g)"/><text x="64" y="78" font-family="Arial" font-size="56" text-anchor="middle" fill="white" font-weight="900">YX</text></svg>';
  function applyLogo(src){ $('logoImg').src = src || DEFAULT_LOGO; }
  applyLogo(localStorage.getItem('YX:logo'));

  // Background
  function applyBg(data){ $('wp').style.backgroundImage = data ? 'url('+data+')' : 'none'; }
  function applyBgOpacity(val){ $('wp').style.opacity = String(clamp(parseInt(val||'18',10),0,100)/100); }
  function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }
  applyBg(localStorage.getItem('YX:bg'));
  applyBgOpacity(localStorage.getItem('YX:bgOpacity') || 18);

  // Personalization modal bindings
  $('personalBtn').onclick=function(){ $('bgOpacity').value = localStorage.getItem('YX:bgOpacity') || 18; openM($('personalModal')); };
  $('closePersonal').onclick=function(){ closeM($('personalModal')); };
  $('bgOpacity').addEventListener('input', function(){ localStorage.setItem('YX:bgOpacity', this.value); applyBgOpacity(this.value); });
  bindDataFile('bgFile','YX:bg',applyBg);
  bindDataFile('logoFile','YX:logo',applyLogo);
  $('resetBg').onclick=function(){ localStorage.removeItem('YX:bg'); applyBg(''); toast('已恢复默认','success'); };
  $('resetLogo').onclick=function(){ localStorage.removeItem('YX:logo'); applyLogo(''); toast('已恢复默认','success'); };

  function bindDataFile(inpId, key, okCb){
    const el=$(inpId);
    el.addEventListener('change', function(){
      try{
        const f=el.files && el.files[0]; if(!f){toast('未选择文件','error');return;}
        const r=new FileReader();
        r.onload=function(){ localStorage.setItem(key, r.result); okCb(r.result); toast('已更新','success'); };
        r.onerror=function(){ toast('读取失败','error'); };
        r.readAsDataURL(f);
      }catch(e){ toast('上传失败：'+(e&&e.message?e.message:e),'error'); }
      el.value='';
    });
  }

  // Files (append)
  let fileList=[];
  function uniqKey(f){ return [f.name,f.size,f.lastModified].join('|'); }
  $('files').addEventListener('change', function(){
    const arr=Array.from(this.files||[]);
    const map=new Set(fileList.map(uniqKey));
    arr.forEach(f=>{ const k=uniqKey(f); if(!map.has(k)){ fileList.push(f); map.add(k);} });
    this.value='';
    renderChips();
  });
  const chips=$('chips');
  function renderChips(){
    chips.innerHTML='';
    fileList.forEach((f,idx)=>{
      const chip=document.createElement('div'); chip.className='chip';
      const icon=document.createElement('div'); icon.className='gridIcon'; icon.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"></rect><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>';
      const name=document.createElement('div'); name.textContent=f.name;
      const eye=document.createElement('button'); eye.className='eye'; eye.textContent='👁'; eye.title='预览此文件';
      eye.onclick=async()=>{ const t=await f.text(); $('previewBox').textContent=t.split('\\n').slice(0,50).join('\\n'); openM($('previewModal')); };
      const x=document.createElement('button'); x.className='x'; x.textContent='×'; x.onclick=()=>{ fileList.splice(idx,1); renderChips(); };
      chip.appendChild(icon); chip.appendChild(name); chip.appendChild(eye); chip.appendChild(x);
      chips.appendChild(chip);
    });
  }
  $('previewAll').onclick=async function(){
    if(!fileList.length){ toast('请先选择文件','error'); return; }
    let all=''; for(const f of fileList){ all += (await f.text()) + '\\n'; }
    $('previewBox').textContent=all.trim().split('\\n').slice(0,50).join('\\n'); openM($('previewModal'));
  };
  $('closePreview').onclick=function(){ closeM($('previewModal')); };

  // Advanced modal
  $('advancedBtn').onclick=function(){ openM($('advancedModal')); };
  $('closeAdvanced').onclick=function(){ closeM($('advancedModal')); };

  // Quota modal
  $('quotaBtn').onclick=function(){ openM($('quotaModal')); };
  $('closeQuota').onclick=function(){ closeM($('quotaModal')); };

  // Settings persist
  const nodePrefix=$('nodePrefix'), nodeSuffix=$('nodeSuffix'), decorateFlag=$('decorateFlag');
  const appendUnit=$('appendUnit'), digits=$('digits');
  const quotaV4=$('quotaV4'), quotaV6=$('quotaV6'), quotaCountryTop=$('quotaCountryTop'), maxLines=$('maxLines');
  const regionLang=$('regionLang'), regionDetail=$('regionDetail');
  const token=$('token');
  const LS='YX:cfg:';
  function load(k,d){ return localStorage.getItem(LS+k) ?? d; }
  function save(k,v){ localStorage.setItem(LS+k, v); }

  // default values
  nodePrefix.value = load('nodePrefix','');   nodeSuffix.value = load('nodeSuffix','');
  appendUnit.checked = load('appendUnit','1')!=='0';  digits.value = load('digits','2');
  quotaV4.value = load('quotaV4','0');  quotaV6.value = load('quotaV6','0');  quotaCountryTop.value = load('quotaCountryTop','0'); maxLines.value = load('maxLines','0');
  regionLang.value = load('regionLang','zh'); regionDetail.value = load('regionDetail','country');
  decorateFlag.checked = load('decorateFlag','1')!=='0'; token.value = load('token','');

  ['input','change'].forEach(ev=>{
    nodePrefix.addEventListener(ev,()=>save('nodePrefix',nodePrefix.value||''));   nodeSuffix.addEventListener(ev,()=>save('nodeSuffix',nodeSuffix.value||''));
    appendUnit.addEventListener(ev,()=>save('appendUnit',appendUnit.checked?'1':'0'));  digits.addEventListener(ev,()=>save('digits',digits.value||'2'));
    quotaV4.addEventListener(ev,()=>save('quotaV4',quotaV4.value||'0'));  quotaV6.addEventListener(ev,()=>save('quotaV6',quotaV6.value||'0'));
    quotaCountryTop.addEventListener(ev,()=>save('quotaCountryTop',quotaCountryTop.value||'0'));  maxLines.addEventListener(ev,()=>save('maxLines',maxLines.value||'0'));
    regionLang.addEventListener(ev,()=>save('regionLang',regionLang.value||'zh')); regionDetail.addEventListener(ev,()=>save('regionDetail',regionDetail.value||'country'));
    decorateFlag.addEventListener(ev,()=>save('decorateFlag',decorateFlag.checked?'1':'0')); token.addEventListener(ev,()=>save('token',token.value||''));
  });

  // progress + actions
  var go=$('go'), upload=$('upload'), copy=$('copy'), statsBtn=$('statsBtn');
  var out=$('out'), progWrap=$('progWrap'), bar=$('bar'), mini=$('miniStats');
  function showProg(){ progWrap.style.display='block'; progWrap.classList.add('indeterminate'); bar.style.width='0%'; }

  var last=null;
  go.onclick=async function(){
    try{
      go.disabled=true; out.value=''; mini.textContent=''; showProg(); await new Promise(r=>setTimeout(r,60));

      var fd=new FormData();
      (fileList||[]).forEach(f=>fd.append('files',f));
      fd.append('pasted',$('pasted').value||'');
      fd.append('nodePrefix',nodePrefix.value||''); fd.append('nodeSuffix',nodeSuffix.value||'');
      if(appendUnit.checked) fd.append('appendUnit','on'); fd.append('digits',digits.value||'2');
      fd.append('regionLang',regionLang.value||'zh'); fd.append('regionDetail',regionDetail.value||'country');
      if(decorateFlag.checked) fd.append('decorateFlag','on');
      fd.append('quotaV4',quotaV4.value||'0'); fd.append('quotaV6',quotaV6.value||'0'); fd.append('quotaCountryTop',quotaCountryTop.value||'0'); fd.append('maxLines',maxLines.value||'0');

      const res=await fetch('/api/preview',{method:'POST',body:fd});
      const j=await res.json();
      progWrap.classList.remove('indeterminate'); bar.style.width='100%';
      if(!j.ok) throw new Error(j.error||'未知错误');
      out.value=(j.lines||[]).join('\\n'); last=j;

      const s=j.stats||{};
      mini.textContent=[
        '输入总行数:'+(s.rows_total??'—'),
        '识别到IP行:'+(s.recognized_ip_rows??'—'),
        'IPv4:'+(s.ipv4_count??'—'),
        'IPv6:'+(s.ipv6_count??'—'),
        '带速度:'+(s.with_speed_count??'—'),
        '配额后行数:'+(s.total_after_quota??'—'),
        '最终输出行数:'+(s.output_count??(j.count??'—'))
      ].join('  ·  ');

      $('statsContent').textContent=[
        '=== 统计明细 ===',
        '表头列数: '+(s.headers_count??'—'),
        '输入总行数: '+(s.rows_total??'—'),
        '识别到IP行: '+(s.recognized_ip_rows??'—'),
        '  - IPv4: '+(s.ipv4_count??'—'),
        '  - IPv6: '+(s.ipv6_count??'—'),
        '带速度: '+(s.with_speed_count??'—'),
        '每国 IPv4 保留个数: '+(s.quota_v4??0),
        '每国 IPv6 保留个数: '+(s.quota_v6??0),
        '每国合计前 N 个: '+(s.quota_country_top??0),
        '全局保留前 N 行: '+(s.limit_maxlines? s.limit_maxlines : '不限制'),
        '因配额跳过: '+(s.skipped_quota??0),
        '配额后行数: '+(s.total_after_quota??'—'),
        '最终返回行数: '+(j.count??'—')+(j.truncated?'（预览截断）':'')
      ].join('\\n');

      toast('处理完成 ✓','success');
    }catch(e){ toast('处理失败：'+(e&&e.message?e.message:e),'error'); }
    finally{ go.disabled=false; setTimeout(()=>{progWrap.style.display='none';bar.style.width='0%';},400); }
  };

  copy.onclick=async function(){
    try{ out.select(); document.execCommand('copy'); toast('已复制','success'); }
    catch(e){ try{ await navigator.clipboard.writeText(out.value); toast('已复制','success'); } catch(_){ toast('复制失败','error'); } }
  };

  $('statsBtn').onclick=function(){ openM($('statsModal')); };
  $('closeStats').onclick=function(){ closeM($('statsModal')); };

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
