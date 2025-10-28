// YouXuan-API — Cloudflare Worker
// 读取订阅: GET  /{TOKEN}           -> text/plain
// JSON    : GET  /{TOKEN}.json      -> {ok, lines, ...}
// 预览    : POST /api/preview       -> multipart/form-data|text|json
// 发布    : POST /api/publish       -> ?token=TOKEN | Header x-token | JSON/form token
// 状态    : GET  /api/status        -> {ok, kvBound, tokenSet, repo}

// 右上角 GitHub 角标链接
const REPO = "https://github.com/Yanson0219/YouXuan-API";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    // UI
    if (request.method === "GET" && (path === "" || path === "/")) {
      return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    // 状态：只报是否已绑定，不泄露 TOKEN
    if (request.method === "GET" && path === "/api/status") {
      return json({ ok: true, kvBound: !!env.KV, tokenSet: !!env.TOKEN, repo: REPO });
    }

    // 读取订阅 /{TOKEN} 或 /{TOKEN}.json
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
        return json({ ok: true, key: token, ...meta, lines: content.split("\n") });
      }
    }

    // 预览
    if (request.method === "POST" && path === "/api/preview") {
      try {
        const form = await request.formData();
        const file = form.get("csv");
        const pasted = (form.get("pasted") || "").toString().trim();
        const text = file && typeof file.text === "function" ? await file.text() : pasted;
        if (!text) return json({ ok: false, error: "没有检测到内容（请上传或粘贴）" });

        // 设置项
        const regionMode  = (form.get("regionMode") || "country").toString().trim(); // country | country_sub
        const regionLang  = (form.get("regionLang") || "zh").toString().trim();      // zh | en
        const decorateFlg = form.get("decorateFlag") === "on";

        const nodePrefix = (form.get("nodePrefix") || "").toString();
        const nodeSuffix = (form.get("nodeSuffix") || "").toString();

        const maxLinesReq = toPosInt(form.get("maxLines"), 0);
        const quotaV4     = toPosInt(form.get("quotaV4"), 0);
        const quotaV6     = toPosInt(form.get("quotaV6"), 0);

        const appendUnit  = form.get("appendUnit") === "on";         // 追加 "MB/s"
        const digits      = toPosInt(form.get("digits"), 2);         // 0 or 2

        const delimiter   = sniffDelimiter(text);
        const rows        = parseCSV(text, delimiter);
        if (!rows.length) return json({ ok: false, error: "CSV/TXT 内容为空" });

        const hasHeader = looksLikeHeader(rows[0]);
        const headers   = hasHeader ? rows[0] : Array.from({ length: rows[0].length }, (_, i) => "列" + (i + 1));
        const dataRows  = hasHeader ? rows.slice(1) : rows;

        // 自动识别列：IP、地区、速度（排除延迟类列名）
        const lower = headers.map(h => String(h).toLowerCase());
        const findFirst = (goods, bads=[]) => {
          for (let i = 0; i < lower.length; i++) {
            const h = lower[i];
            if (goods.some(g => h.includes(g)) && !bads.some(b => h.includes(b))) return i;
          }
          return -1;
        };
        let ipIdx     = findFirst(["ip","ip地址","address","host"]);
        let regionIdx = findFirst(["region","region_code","country","code","地区码","国家","省份","州","iso","geo","location"]);
        // 速度：优先“下载/速度/MB/s”，排除延迟类关键词
        let speedIdx  = findFirst(
          ["下载速度","下载","mb/s","speed","bandwidth","throughput","down","download","rate","峰值","下行","速度"],
          ["延迟","latency","avg","平均延迟","rtt","ping"]
        );
        let cityIdx   = findFirst(["city","城市"]);

        // 若 IP 未识别，按模式扫列
        if (ipIdx < 0) {
          const ip4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
          outer: for (let c = 0; c < headers.length; c++) {
            let m = 0;
            for (let r = 0; r < Math.min(300, dataRows.length); r++) {
              const v = String(dataRows[r][c] ?? "").trim();
              if (ip4.test(v) || (v.includes(":") && isIPv6(v))) m++;
            }
            if (m >= 6) { ipIdx = c; break outer; }
          }
        }

        const stats = {
          rows_total: dataRows.length, headers_count: headers.length,
          ipv4_count: 0, ipv6_count: 0, recognized_ip_rows: 0,
          with_speed_count: 0, quota_v4: quotaV4, quota_v6: quotaV6,
          limit_maxlines: maxLinesReq, skipped_quota: 0, total_after_quota: 0,
          output_count: 0, skipped_count: 0
        };

        const perV4 = Object.create(null);
        const perV6 = Object.create(null);
        const lines = [];

        for (const r of dataRows) {
          const get = (i) => (i >= 0 && i < r.length && r[i] != null) ? String(r[i]).trim() : "";

          const ipRaw = get(ipIdx);
          if (!ipRaw) { stats.skipped_count++; continue; }

          const v4 = isIPv4(ipRaw);
          const v6 = !v4 && isIPv6(ipRaw);
          if (!v4 && !v6) { stats.skipped_count++; continue; }

          stats.recognized_ip_rows++;
          if (v4) stats.ipv4_count++; else stats.ipv6_count++;

          // 地区：优先地区码；没有则退回城市
          const regionRaw = get(regionIdx);
          let regionName  = translateRegionSmart(regionRaw, regionMode, regionLang);
          if (!regionName) {
            const city = get(cityIdx);
            regionName = translateRegionSmart(city, regionMode, regionLang); // 有些表把城市放这
          }

          // 速度：只做格式化，不换算单位
          const rawSpeed = get(speedIdx);
          const speedStr = formatSpeedRaw(rawSpeed, appendUnit, digits); // '' 或 '52.83MB/s' / '52'
          if (speedStr) stats.with_speed_count++;

          // IPv6 展示
          let ipDisp = ipRaw;
          if (v6 && !/^\[.*\]$/.test(ipRaw)) ipDisp = "[" + ipRaw + "]";

          // 国旗
          const flag = decorateFlg ? (flagFromRegionCode(regionRaw, regionName) || "") : "";

          // 前后缀
          const prefix = nodePrefix || "";
          const suffix = nodeSuffix || "";

          // 组装（去所有空格）
          let line = ipDisp + "#" + prefix + flag + (regionName || "") + (speedStr || "") + suffix;
          line = line.replace(/\s+/g, "");

          // 配额控制
          const countryKey = (regionName || "未知").toString().replace(/\s+/g, "") || "未知";
          if (v4 && quotaV4 > 0) {
            const c = perV4[countryKey] || 0;
            if (c >= quotaV4) { stats.skipped_quota++; continue; }
            perV4[countryKey] = c + 1;
          }
          if (v6 && quotaV6 > 0) {
            const c = perV6[countryKey] || 0;
            if (c >= quotaV6) { stats.skipped_quota++; continue; }
            perV6[countryKey] = c + 1;
          }

          lines.push(line);
        }

        stats.total_after_quota = lines.length;
        const applied = (maxLinesReq > 0) ? lines.slice(0, maxLinesReq) : lines;
        const MAX_PREVIEW = 20000;
        const preview = applied.slice(0, MAX_PREVIEW);
        stats.output_count = applied.length;
        stats.skipped_count = Math.max(stats.skipped_count, stats.rows_total - stats.output_count);

        return json({ ok: true, lines: preview, count: applied.length, headers, stats, truncated: applied.length > MAX_PREVIEW });
      } catch (e) {
        return json({ ok: false, error: e && e.message ? e.message : String(e) }, 500);
      }
    }

    // 发布（需要 token；路径=TOKEN）
    if (request.method === "POST" && path === "/api/publish") {
      try {
        if (!env.KV) return json({ ok:false, error:"KV not bound" }, 500);
        if (!env.TOKEN) return json({ ok:false, error:"TOKEN not configured" }, 500);

        const q = new URL(request.url).searchParams;
        let token = q.get("token") || request.headers.get("x-token");
        const ct = request.headers.get("content-type") || "";
        let content = "";

        if (!token && ct.includes("application/json")) {
          try { const j = await request.json(); token = (j.token || "").toString(); content = (j.content || "").toString(); } catch(_) {}
        }
        if (!token && ct.includes("multipart/form-data")) {
          const f = await request.formData(); token = (f.get("token") || "").toString(); content = (f.get("content") || "").toString();
        }
        if (!token) { if (ct && !content) content = await request.text(); }

        if (token !== env.TOKEN) return json({ ok:false, error:"Unauthorized (bad token)" }, 401);
        if (!content) {
          content = await request.text();
          if (!content) return json({ ok:false, error:"content is empty" }, 400);
        }

        const key = env.TOKEN;
        content = content.split("\n").map(s => (s || "").replace(/\s+/g, "")).join("\n");

        await env.KV.put("sub:" + key, content);
        const meta = { updated: Date.now(), count: content ? content.split("\n").length : 0 };
        await env.KV.put("meta:" + key, JSON.stringify(meta));
        return json({ ok:true, key, count: meta.count, updated: meta.updated });
      } catch (e) {
        return json({ ok:false, error: e && e.message ? e.message : String(e) }, 500);
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};

function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } }); }
function toPosInt(v, def){ const n = parseInt(String(v||"").trim(), 10); return Number.isFinite(n) && n>0 ? n : def; }

/* ---------------- HTML（不嵌套反引号） ---------------- */
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
body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,PingFang SC,Microsoft YaHei,Helvetica,Arial}
.center{min-height:100dvh;display:grid;place-items:start center;padding-top:72px}
.container{width:min(1160px,92vw)}
.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}
.brand{display:flex;align-items:center;gap:12px}
.logoWrap{width:52px;height:52px;border-radius:16px;overflow:hidden;box-shadow:0 12px 28px rgba(59,130,246,.35);background:linear-gradient(135deg,var(--primary),var(--accent));display:grid;place-items:center}
.logoWrap img{width:100%;height:100%;object-fit:cover;display:block}
.title{font-size:26px;font-weight:900}
.header-right{display:flex;align-items:center;gap:12px}
.pill{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--border);background:var(--card);padding:8px 12px;border-radius:999px;font-weight:700}
.dot{width:10px;height:10px;border-radius:50%}
.btn{display:inline-flex;align-items:center;gap:10px;background:linear-gradient(90deg,var(--primary),var(--accent));border:none;border-radius:12px;padding:12px 16px;color:#fff;cursor:pointer;font-weight:800}
.btn.secondary{background:linear-gradient(90deg,#e5e7eb,#f3f4f6);color:#111827;border:1px solid var(--border)}
html[data-theme="dark"] .btn.secondary{background:linear-gradient(90deg,#0b1220,#0f172a);color:#e5e7eb;border:1px solid var(--border)}
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow)}
.card.pad{padding:18px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
label{display:block;margin:10px 0 8px;font-weight:700}
textarea,input[type="text"],input[type="number"],select{width:100%;padding:12px 14px;border-radius:12px;border:1px solid var(--border);background:transparent;color:var(--text)}
textarea{min-height:54px}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}

/* 文件卡片 */
input[type="file"]{display:none}
.filebox{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.uploadBtn{display:inline-flex;align-items:center;gap:8px;background:linear-gradient(90deg,var(--primary),var(--accent));border:none;border-radius:12px;padding:10px 14px;color:#fff;cursor:pointer;font-weight:800}
.filechip{position:relative;display:inline-flex;align-items:center;gap:10px;border:1px solid var(--border);background:#f3f4f6;border-radius:12px;padding:8px 12px}
html[data-theme="dark"] .filechip{background:#111827;color:#e5e7eb}
.fileicon{width:28px;height:28px;border-radius:8px;background:#10b981;display:grid;place-items:center;color:#fff;font-weight:900}
.filemeta{display:flex;flex-direction:column;line-height:1.1}
.filename{font-weight:800}
.filetype{font-size:12px;color:var(--muted)}
.fileclose{position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;border:none;background:#00000020;color:#111;cursor:pointer}
html[data-theme="dark"] .fileclose{background:#ffffff30;color:#fff}
.filepreview{margin-left:6px;border:none;background:transparent;cursor:pointer}

/* 进度条 */
.progress{height:10px;background:transparent;border:1px solid var(--border);border-radius:999px;overflow:hidden;margin-bottom:8px}
.bar{height:100%;width:0%;background:linear-gradient(90deg,var(--primary),var(--accent));transition:width .25s ease}
.indeterminate{position:relative;overflow:hidden}
.indeterminate .bar{position:absolute;width:30%;left:-30%;animation:ind 1.2s infinite}
@keyframes ind{0%{left:-30%}50%{left:50%}100%{left:100%}}

/* Modal / Toast */
.modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.35);padding:18px;z-index:50}
.panel{max-width:760px;width:100%;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:18px}
.panel .title{font-weight:900;margin-bottom:8px}
.actions{display:flex;justify-content:flex-end;gap:10px;margin-top:10px}
.toast{position:fixed;right:18px;bottom:18px;background:var(--card);border:1px solid var(--border);color:var(--text);padding:12px 16px;border-radius:12px;opacity:0;transform:translateY(10px);transition:all .25s ease;z-index:60}
.toast.show{opacity:1;transform:translateY(0)}

/* GitHub 角标 */
.github-corner{position:fixed;right:0;top:0;border:0;z-index:70}
</style>
</head>
<body>
  <a class="github-corner" href="` + REPO + `" target="_blank" aria-label="View source on GitHub">
    <img src="https://img.shields.io/badge/GitHub-YouXuan--API-181717?logo=github" alt="GitHub"/>
  </a>

  <div class="center">
    <div class="container">
      <div class="header">
        <div class="brand">
          <div class="logoWrap"><img id="logoImg" alt="logo"/></div>
          <div class="title">YouXuan-API</div>
        </div>
        <div class="header-right">
          <div class="pill" id="kvPill"><span class="dot" id="kvDot" style="background:#9ca3af"></span><span id="kvText">KV 未绑定</span></div>
          <button class="pill" id="themeBtn" type="button">🌙 深色</button>
        </div>
      </div>

      <div class="card pad">
        <div class="row">
          <div>
            <label>上传文件（CSV/TXT/任意文本）</label>
            <div class="filebox">
              <label class="uploadBtn" for="csv">📂 选择文件</label>
              <input type="file" id="csv" name="csv"/>
              <div id="fileChip" class="filechip" style="display:none">
                <div class="fileicon">▦</div>
                <div class="filemeta">
                  <div class="filename" id="fname">ip.csv</div>
                  <div class="filetype" id="ftype">电子表格</div>
                </div>
                <button class="filepreview" id="chipPreview" title="预览">👁</button>
                <button class="fileclose" id="chipClose" title="清除">×</button>
              </div>
            </div>
          </div>
          <div>
            <label>或直接粘贴文本</label>
            <textarea id="pasted" rows="4" placeholder="粘贴内容或上方选择文件"></textarea>
          </div>
        </div>

        <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn" id="go" type="button">🚀 生成预览</button>
          <button class="btn secondary" id="upload" type="button">⬆️ 上传订阅</button>
          <button class="btn secondary" id="settingsBtn" type="button">⚙️ 设置</button>
          <button class="btn secondary" id="statsBtn" type="button">📊 查看统计</button>
          <button class="btn secondary" id="copy" type="button">📋 复制全部</button>
        </div>
      </div>

      <div class="card pad" style="margin-top:14px">
        <div class="progress" id="progWrap" style="display:none"><div class="bar" id="bar"></div></div>
        <textarea id="out" class="mono" rows="18" placeholder="点击“生成预览”后在此显示结果"></textarea>
        <div id="miniStats" class="filetype" style="margin-top:8px;line-height:1.8"></div>
      </div>
    </div>
  </div>

  <!-- 设置弹窗 -->
  <div class="modal" id="settings">
    <div class="panel">
      <div class="title">⚙️ 设置</div>

      <div class="row">
        <div>
          <label>验证 Token（上传必填）</label>
          <input type="text" id="token" placeholder="与服务端 TOKEN 一致，否则无法上传"/>
        </div>
        <div>
          <label>上传 Logo（图片文件，可选）</label>
          <input type="file" id="logoFile" accept="image/*"/>
          <div class="filetype">本地保存，不会上传至服务器。</div>
        </div>
      </div>

      <div class="row">
        <div>
          <label>节点前缀 / 后缀（默认空）</label>
          <div class="row">
            <input type="text" id="nodePrefix" placeholder="前缀（可空）"/>
            <input type="text" id="nodeSuffix" placeholder="后缀（可空）"/>
          </div>
        </div>
        <div>
          <label>速度显示</label>
          <label class="filetype"><input type="checkbox" id="appendUnit" checked/> 追加单位 "MB/s"</label>
          <label class="filetype">小数位：
            <select id="digits"><option value="2" selected>保留两位</option><option value="0">不保留</option></select>
          </label>
        </div>
      </div>

      <div class="row">
        <div><label>每国 IPv4 个数</label><input type="number" id="quotaV4" min="0" placeholder="0=不限制"/></div>
        <div><label>每国 IPv6 个数</label><input type="number" id="quotaV6" min="0" placeholder="0=不限制"/></div>
      </div>

      <div class="row">
        <div><label>保留前 N 行（全局）</label><input type="number" id="maxLines" min="0" placeholder="0=不限制"/></div>
        <div>
          <label>地区显示</label>
          <select id="regionMode"><option value="country" selected>仅国家/地区</option><option value="country_sub">国家+省州</option></select>
          <select id="regionLang" style="margin-top:6px"><option value="zh" selected>中文</option><option value="en">英文</option></select>
          <label class="filetype"><input type="checkbox" id="decorateFlag" checked/> 在地区前添加国旗</label>
        </div>
      </div>

      <div class="actions">
        <button class="btn secondary" id="settingsClose" type="button">取消</button>
        <button class="btn" id="settingsSave" type="button">保存</button>
      </div>
    </div>
  </div>

  <!-- 文件预览 -->
  <div class="modal" id="previewModal">
    <div class="panel">
      <div class="title">文件预览（前 50 行）</div>
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

  <div class="toast" id="toast"></div>

<script>
(function(){
  function byId(id){return document.getElementById(id)}
  function toast(t,k){var x=byId('toast');x.textContent=t;x.style.borderColor=(k==='error')?'#ef4444':(k==='success')?'#10b981':'#e5e7eb';x.classList.add('show');setTimeout(function(){x.classList.remove('show')},2000)}
  function openModal(m){m.style.display='flex'} function closeModal(m){m.style.display='none'}

  // 主题
  var THEME_KEY='YX:theme', themeBtn=byId('themeBtn'), th=localStorage.getItem(THEME_KEY)||'light';
  applyTheme(th);
  themeBtn.addEventListener('click',function(){var next=document.documentElement.dataset.theme==='light'?'dark':'light';applyTheme(next);localStorage.setItem(THEME_KEY,next)});
  function applyTheme(t){document.documentElement.dataset.theme=t;themeBtn.textContent=(t==='light'?'🌙 深色':'🌞 浅色')}

  // KV 状态
  fetch('/api/status').then(r=>r.json()).then(s=>{
    var kvDot=byId('kvDot'), kvText=byId('kvText');
    kvText.textContent = 'KV ' + (s.kvBound ? '已绑定' : '未绑定');
    kvDot.style.background = s.kvBound ? '#10b981' : '#9ca3af';
  }).catch(()=>{});

  // 默认 LOGO（可被本地上传覆盖）
  (function initLogo(){
    var img=byId('logoImg');
    var data=localStorage.getItem('YX:logoData');
    if (data) img.src=data; else img.src='data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="%233b82f6"/><stop offset="1" stop-color="%238b5cf6"/></linearGradient></defs><rect rx="24" ry="24" width="128" height="128" fill="url(%23g)"/><text x="64" y="78" font-family="Arial" font-size="56" text-anchor="middle" fill="white" font-weight="900">YX</text></svg>';
  })();

  // 文件卡片
  var csv=byId('csv'), fileChip=byId('fileChip'), fname=byId('fname'), ftype=byId('ftype'),
      chipPreview=byId('chipPreview'), chipClose=byId('chipClose'),
      previewModal=byId('previewModal'), previewBox=byId('previewBox'), closePreview=byId('closePreview');
  csv.addEventListener('change',function(){
    if(csv.files && csv.files[0]){
      var f=csv.files[0]; fname.textContent=f.name;
      var ext=f.name.split('.').pop().toLowerCase();
      ftype.textContent=(ext==='csv'||ext==='xls'||ext==='xlsx')?'电子表格':'文本';
      fileChip.style.display='inline-flex';
    }else{ fileChip.style.display='none'; }
  });
  chipClose.addEventListener('click',function(){ csv.value=''; fileChip.style.display='none'; });
  chipPreview.addEventListener('click',async function(){
    if(!(csv.files&&csv.files[0])){toast('请先选择文件');return;}
    var text=await csv.files[0].text(); var lines=text.split('\\n').slice(0,50); previewBox.textContent=lines.join('\\n'); openModal(previewModal);
  });
  closePreview.addEventListener('click',function(){ closeModal(previewModal); });

  // 控件
  var go=byId('go'), upload=byId('upload'), copy=byId('copy'), statsBtn=byId('statsBtn');
  var out=byId('out'), pasted=byId('pasted'), progWrap=byId('progWrap'), bar=byId('bar'), mini=byId('miniStats');

  // 设置弹窗
  var settings=byId('settings'), settingsBtn=byId('settingsBtn'), settingsSave=byId('settingsSave'), settingsClose=byId('settingsClose');
  var token=byId('token'), logoFile=byId('logoFile'),
      nodePrefix=byId('nodePrefix'), nodeSuffix=byId('nodeSuffix'),
      appendUnit=byId('appendUnit'), digits=byId('digits'),
      quotaV4=byId('quotaV4'), quotaV6=byId('quotaV6'), maxLines=byId('maxLines'),
      regionMode=byId('regionMode'), regionLang=byId('regionLang'), decorateFlag=byId('decorateFlag');
  var LS='YX:cfg:';

  // 载入本地设置（默认：追加单位=开，小数位=2）
  nodePrefix.value = localStorage.getItem(LS+'nodePrefix') || '';
  nodeSuffix.value = localStorage.getItem(LS+'nodeSuffix') || '';
  quotaV4.value    = localStorage.getItem(LS+'quotaV4')    || '0';
  quotaV6.value    = localStorage.getItem(LS+'quotaV6')    || '0';
  maxLines.value   = localStorage.getItem(LS+'maxLines')   || '0';
  appendUnit.checked = (localStorage.getItem(LS+'appendUnit')!=='0');
  digits.value     = localStorage.getItem(LS+'digits')     || '2';
  regionMode.value = localStorage.getItem(LS+'regionMode') || 'country';
  regionLang.value = localStorage.getItem(LS+'regionLang') || 'zh';
  decorateFlag.checked = (localStorage.getItem(LS+'decorateFlag')!=='0');
  token.value      = localStorage.getItem(LS+'token') || '';

  // 上传 LOGO -> 存 dataURL
  logoFile.addEventListener('change', function(){
    var f=logoFile.files&&logoFile.files[0]; if(!f) return;
    var r=new FileReader(); r.onload=function(){ localStorage.setItem('YX:logoData', r.result); byId('logoImg').src=r.result; toast('Logo 已更新','success'); }; r.readAsDataURL(f);
  });

  settingsBtn.addEventListener('click',function(){ openModal(settings); });
  settingsClose.addEventListener('click',function(){ closeModal(settings); });
  settingsSave.addEventListener('click',function(){
    localStorage.setItem(LS+'nodePrefix', nodePrefix.value||'');
    localStorage.setItem(LS+'nodeSuffix', nodeSuffix.value||'');
    localStorage.setItem(LS+'quotaV4',    quotaV4.value||'0');
    localStorage.setItem(LS+'quotaV6',    quotaV6.value||'0');
    localStorage.setItem(LS+'maxLines',   maxLines.value||'0');
    localStorage.setItem(LS+'appendUnit', appendUnit.checked?'1':'0');
    localStorage.setItem(LS+'digits',     digits.value||'2');
    localStorage.setItem(LS+'regionMode', regionMode.value||'country');
    localStorage.setItem(LS+'regionLang', regionLang.value||'zh');
    localStorage.setItem(LS+'decorateFlag', decorateFlag.checked?'1':'0');
    localStorage.setItem(LS+'token', token.value||'');
    toast('设置已保存','success'); closeModal(settings);
  });

  // 复制
  copy.addEventListener('click',async function(){
    try{ out.select(); document.execCommand('copy'); toast('已复制','success'); }
    catch(e){ try{ await navigator.clipboard.writeText(out.value); toast('已复制','success'); } catch(_){ toast('复制失败','error'); } }
  });

  // 统计
  var statsModal=byId('statsModal'), statsContent=byId('statsContent'), closeStats=byId('closeStats');
  statsBtn.addEventListener('click',function(){ openModal(statsModal); });
  closeStats.addEventListener('click',function(){ closeModal(statsModal); });

  // 渲染前强制让进度条出现（避免“完成后才闪一下”）
  function beforeFetchProgress(){
    progWrap.style.display='block';
    progWrap.classList.add('indeterminate'); // 动画条
    bar.style.width='0%';
  }

  // 生成预览
  var lastResult=null;
  go.addEventListener('click', async function(){
    try{
      go.disabled=true; out.value=''; mini.textContent='';
      beforeFetchProgress();
      // 让浏览器先渲染一帧
      await new Promise(r => setTimeout(r, 60));

      var fd=new FormData();
      if(csv.files&&csv.files[0]) fd.append('csv',csv.files[0]);
      fd.append('pasted',pasted.value||'');
      fd.append('quotaV4',quotaV4.value||'');
      fd.append('quotaV6',quotaV6.value||'');
      fd.append('maxLines',maxLines.value||'');
      fd.append('nodePrefix',nodePrefix.value||'');
      fd.append('nodeSuffix',nodeSuffix.value||'');
      fd.append('regionMode',regionMode.value||'country');
      fd.append('regionLang',regionLang.value||'zh');
      if(appendUnit.checked) fd.append('appendUnit','on');
      fd.append('digits',digits.value||'2');
      if(decorateFlag.checked) fd.append('decorateFlag','on');

      var res=await fetch('/api/preview',{method:'POST',body:fd});
      var j=await res.json();
      progWrap.classList.remove('indeterminate'); bar.style.width='100%';

      if(!j.ok) throw new Error(j.error||'未知错误');
      out.value=(j.lines||[]).join('\\n'); lastResult=j;

      var s=j.stats||{};
      var info=['输入总行数:'+(s.rows_total??'—'),'识别到IP行:'+(s.recognized_ip_rows??'—'),'IPv4:'+(s.ipv4_count??'—'),'IPv6:'+(s.ipv6_count??'—'),'带速度:'+(s.with_speed_count??'—'),'配额后行数:'+(s.total_after_quota??'—'),'最终输出行数:'+(s.output_count??(j.count??'—'))].join('  ·  ');
      byId('miniStats').textContent=info;

      var detail=['=== 统计明细 ===','表头列数: '+(s.headers_count??'—'),'输入总行数: '+(s.rows_total??'—'),'识别到IP行: '+(s.recognized_ip_rows??'—'),'  - IPv4: '+(s.ipv4_count??'—'),'  - IPv6: '+(s.ipv6_count??'—'),'带速度: '+(s.with_speed_count??'—'),'每国 IPv4 配额: '+(s.quota_v4??0),'每国 IPv6 配额: '+(s.quota_v6??0),'全局保留前 N 行: '+(s.limit_maxlines? s.limit_maxlines : '不限制'),'因配额跳过: '+(s.skipped_quota??0),'配额后行数: '+(s.total_after_quota??'—'),'最终返回行数: '+(j.count??'—')+(j.truncated?'（预览截断）':'')].join('\\n');
      byId('statsContent').textContent=detail;

      toast('处理完成 ✓','success');
    }catch(err){
      toast('处理失败：'+(err&&err.message?err.message:err),'error');
    }finally{
      go.disabled=false;
      setTimeout(function(){progWrap.style.display='none';bar.style.width='0%';},400);
    }
  });

  // 上传（需要 token；不会在前端显示订阅地址）
  upload.addEventListener('click', async function(){
    if(!lastResult || !lastResult.lines || !lastResult.lines.length){ toast('请先生成预览','error'); return; }
    if(!token.value){ openModal(settings); toast('请在设置中填写验证 Token','error'); return; }
    try{
      var content=lastResult.lines.join('\\n');
      var res=await fetch('/api/publish?token='+encodeURIComponent(token.value),{method:'POST',headers:{'content-type':'text/plain; charset=utf-8'},body:content});
      var j=await res.json();
      if(!j.ok) throw new Error(j.error||'发布失败');
      toast('已上传（订阅地址不在页面显示）','success');
    }catch(e){ toast('上传失败：'+(e&&e.message?e.message:e),'error'); }
  });

})();
</script>
</body>
</html>`;

/* ---------------- 解析/辅助（后端） ---------------- */
function sniffDelimiter(sample) {
  const head = sample.slice(0, 10000);
  const c = { ",": (head.match(/,/g)||[]).length, ";": (head.match(/;/g)||[]).length, "\t": (head.match(/\t/g)||[]).length, "|": (head.match(/\|/g)||[]).length };
  const arr = Object.entries(c).sort((a,b)=>b[1]-a[1]);
  return arr[0] ? arr[0][0] : ",";
}
function looksLikeHeader(row){ if(!row||!row.length) return false; return row.some(v => /[A-Za-z\u4e00-\u9fa5]/.test(String(v||""))); }
function parseCSV(text, delimiter){
  const rows=[]; let i=0, field='', row=[], inQ=false;
  function pf(){row.push(field); field='';} function pr(){rows.push(row); row=[];}
  while(i<text.length){ const ch=text[i];
    if(inQ){ if(ch=='"'){ const n=text[i+1]; if(n=='"'){ field+='"'; i+=2; continue;} inQ=false; i++; continue;} field+=ch; i++; continue; }
    if(ch=='"'){ inQ=true; i++; continue; }
    if(ch===delimiter){ pf(); i++; continue; }
    if(ch=='\r'){ i++; continue; }
    if(ch=='\n'){ pf(); pr(); i++; continue; }
    field+=ch; i++; continue;
  }
  pf(); if(row.length>1 || row[0]!=='' ) pr(); return rows;
}

/* ===== 地区翻译：支持 alpha-3 → alpha-2，再输出中文或英文 ===== */
const A3_TO_A2 = {
  HKG:"HK", MAC:"MO", TWN:"TW", CHN:"CN", USA:"US", JPN:"JP", KOR:"KR", SGP:"SG",
  MYS:"MY", VNM:"VN", THA:"TH", PHL:"PH", IDN:"ID", IND:"IN",
  GBR:"GB", FRA:"FR", DEU:"DE", ITA:"IT", ESP:"ES", RUS:"RU", CAN:"CA", AUS:"AU",
  NLD:"NL", BRA:"BR", ARG:"AR", MEX:"MX", TUR:"TR", ARE:"AE", ISR:"IL", ZAF:"ZA",
  SWE:"SE", NOR:"NO", DNK:"DK", FIN:"FI", POL:"PL", CZE:"CZ", AUT:"AT", CHE:"CH",
  BEL:"BE", IRL:"IE", PRT:"PT", GRC:"GR", HUN:"HU", ROU:"RO", UKR:"UA", NZL:"NZ"
};

const COUNTRY_ZH = {"CN":"中国","US":"美国","GB":"英国","DE":"德国","FR":"法国","JP":"日本","KR":"韩国","RU":"俄罗斯","IN":"印度","BR":"巴西","CA":"加拿大","AU":"澳大利亚","IT":"意大利","ES":"西班牙","NL":"荷兰","SE":"瑞典","NO":"挪威","DK":"丹麦","FI":"芬兰","PL":"波兰","CZ":"捷克","AT":"奥地利","CH":"瑞士","BE":"比利时","IE":"爱尔兰","PT":"葡萄牙","GR":"希腊","HU":"匈牙利","RO":"罗马尼亚","UA":"乌克兰","TR":"土耳其","MX":"墨西哥","AR":"阿根廷","CL":"智利","CO":"哥伦比亚","ZA":"南非","EG":"埃及","AE":"阿联酋","SA":"沙特阿拉伯","IL":"以色列","TH":"泰国","VN":"越南","MY":"马来西亚","SG":"新加坡","ID":"印度尼西亚","PH":"菲律宾","NZ":"新西兰","HK":"香港","MO":"澳门","TW":"台湾"};
const COUNTRY_EN = {"CN":"China","US":"United States","GB":"United Kingdom","DE":"Germany","FR":"France","JP":"Japan","KR":"South Korea","RU":"Russia","IN":"India","BR":"Brazil","CA":"Canada","AU":"Australia","IT":"Italy","ES":"Spain","NL":"Netherlands","SE":"Sweden","NO":"Norway","DK":"Denmark","FI":"Finland","PL":"Poland","CZ":"Czechia","AT":"Austria","CH":"Switzerland","BE":"Belgium","IE":"Ireland","PT":"Portugal","GR":"Greece","HU":"Hungary","RO":"Romania","UA":"Ukraine","TR":"Turkey","MX":"Mexico","AR":"Argentina","CL":"Chile","CO":"Colombia","ZA":"South Africa","EG":"Egypt","AE":"UAE","SA":"Saudi Arabia","IL":"Israel","TH":"Thailand","VN":"Vietnam","MY":"Malaysia","SG":"Singapore","ID":"Indonesia","PH":"Philippines","NZ":"New Zealand","HK":"Hong Kong","MO":"Macao","TW":"Taiwan"};

const CN_SUBDIVISION_ZH = {"BJ":"北京","SH":"上海","TJ":"天津","CQ":"重庆","HE":"河北","SX":"山西","NM":"内蒙古","LN":"辽宁","JL":"吉林","HL":"黑龙江","JS":"江苏","ZJ":"浙江","AH":"安徽","FJ":"福建","JX":"江西","SD":"山东","HA":"河南","HB":"湖北","HN":"湖南","GD":"广东","GX":"广西","HI":"海南","SC":"四川","GZ":"贵州","YN":"云南","XZ":"西藏","SN":"陕西","GS":"甘肃","QH":"青海","NX":"宁夏","XJ":"新疆","HK":"香港","MO":"澳门","TW":"台湾"};
const US_STATE_ZH = {"AL":"阿拉巴马州","AK":"阿拉斯加州","AZ":"亚利桑那州","AR":"阿肯色州","CA":"加利福尼亚州","CO":"科罗拉多州","CT":"康涅狄格州","DE":"特拉华州","FL":"佛罗里达州","GA":"乔治亚州","HI":"夏威夷州","ID":"爱达荷州","IL":"伊利诺伊州","IN":"印第安纳州","IA":"爱荷华州","KS":"堪萨斯州","KY":"肯塔基州","LA":"路易斯安那州","ME":"缅因州","MD":"马里兰州","MA":"马萨诸塞州","MI":"密歇根州","MN":"明尼苏达州","MS":"密西西比州","MO":"密苏里州","MT":"蒙大拿州","NE":"内布拉斯加州","NV":"内华达州","NH":"新罕布什尔州","NJ":"新泽西州","NM":"新墨西哥州","NY":"纽约州","NC":"北卡罗来纳州","ND":"北达科他州","OH":"俄亥俄州","OK":"俄克拉荷马州","OR":"俄勒冈州","PA":"宾夕法尼亚州","RI":"罗得岛州","SC":"南卡罗来纳州","SD":"南达科他州","TN":"田纳西州","TX":"得克萨斯州","UT":"犹他州","VT":"佛蒙特州","VA":"弗吉尼亚州","WA":"华盛顿州","WV":"西弗吉尼亚州","WI":"威斯康星州","WY":"怀俄明州"};
const US_STATE_EN = {"AL":"Alabama","AK":"Alaska","AZ":"Arizona","AR":"Arkansas","CA":"California","CO":"Colorado","CT":"Connecticut","DE":"Delaware","FL":"Florida","GA":"Georgia","HI":"Hawaii","ID":"Idaho","IL":"Illinois","IN":"Indiana","IA":"Iowa","KS":"Kansas","KY":"Kentucky","LA":"Louisiana","ME":"Maine","MD":"Maryland","MA":"Massachusetts","MI":"Michigan","MN":"Minnesota","MS":"Mississippi","MO":"Missouri","MT":"Montana","NE":"Nebraska","NV":"Nevada","NH":"New Hampshire","NJ":"New Jersey","NM":"New Mexico","NY":"New York","NC":"North Carolina","ND":"North Dakota","OH":"Ohio","OK":"Oklahoma","OR":"Oregon","PA":"Pennsylvania","RI":"Rhode Island","SC":"South Carolina","SD":"South Dakota","TN":"Tennessee","TX":"Texas","UT":"Utah","VT":"Vermont","VA":"Virginia","WA":"Washington","WV":"West Virginia","WI":"Wisconsin","WY":"Wyoming"};

function normAlpha2FromRaw(raw){
  if(!raw) return "";
  const s = String(raw).trim();
  // 提取 US-CA / CN-GD / HKG / HK / “HKG6.604MB” 等
  const m = s.match(/([A-Za-z]{2,3})(?:[-_ ]([A-Za-z]{2}))?/);
  if (!m) return "";
  let a = m[1].toUpperCase();
  if (a.length === 3 && A3_TO_A2[a]) a = A3_TO_A2[a];
  if (a.length > 2) a = a.slice(0,2);
  return a;
}

function translateRegionSmart(codeOrName, mode, lang){
  const A2 = normAlpha2FromRaw(codeOrName);
  let base = "";
  if (A2) {
    if (lang === "zh") base = COUNTRY_ZH[A2] || A2;
    else base = COUNTRY_EN[A2] || A2;
  } else {
    // 不是标准码，直接返回原文（会被去空格）
    base = String(codeOrName||"");
  }
  if (mode !== "country") {
    // 尝试解析 US-CA / CN-GD
    const s = String(codeOrName||"").toUpperCase();
    const mm = s.match(/([A-Z]{2})[-_ ]([A-Z]{2})/);
    if (mm) {
      const cc = mm[1], sub = mm[2];
      if (cc === "CN") {
        const zh = CN_SUBDIVISION_ZH[sub] || sub;
        return lang === "zh" ? (COUNTRY_ZH.CN + zh) : ("China" + (US_STATE_EN[sub] ? US_STATE_EN[sub] : zh));
      }
      if (cc === "US") {
        const zh = US_STATE_ZH[sub] || sub;
        const en = US_STATE_EN[sub] || sub;
        return lang === "zh" ? (COUNTRY_ZH.US + zh) : ("United States" + en);
      }
    }
  }
  return base;
}

// 国旗
function flagFromRegionCode(regionRaw, regionName){
  let iso2 = normAlpha2FromRaw(regionRaw);
  if (!iso2) {
    // try by name
    const zh = String(regionName||"").trim();
    const map = {"中国":"CN","香港":"HK","澳门":"MO","台湾":"TW","美国":"US","日本":"JP","韩国":"KR","新加坡":"SG","马来西亚":"MY","越南":"VN","泰国":"TH","菲律宾":"PH","印度尼西亚":"ID","印度":"IN","英国":"GB","法国":"FR","德国":"DE","意大利":"IT","西班牙":"ES","俄罗斯":"RU","加拿大":"CA","澳大利亚":"AU","荷兰":"NL","巴西":"BR","阿根廷":"AR","墨西哥":"MX","土耳其":"TR","阿联酋":"AE","以色列":"IL","南非":"ZA","瑞典":"SE","挪威":"NO","丹麦":"DK","芬兰":"FI"};
    for (const k in map) { if (zh.startsWith(k)) { iso2 = map[k]; break; } }
  }
  if (!iso2 || iso2.length !== 2) return "";
  return iso2ToFlag(iso2);
}
function iso2ToFlag(iso2){
  const A = 'A'.codePointAt(0), RI = 0x1F1E6;
  const s = String(iso2||'').toUpperCase();
  if (s.length!==2) return '';
  return String.fromCodePoint(RI + (s.codePointAt(0)-A), RI + (s.codePointAt(1)-A));
}

// IP
function isIPv4(v){ return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(String(v||'')); }
function isIPv6(v){
  v = String(v||'').trim();
  if (!v) return false;
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1,-1);
  if (!v.includes(':')) return false;
  const ipv6Regex = /^((?:[0-9a-fA-F]{1,4}:){1,7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}|(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}|(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}|(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:(?:(?::[0-9a-fA-F]{1,4}){1,6})|:(?:(?::[0-9a-fA-F]{1,4}){1,7}|:)|(?:[0-9a-fA-F]{1,4}:){1,6}(?:\d{1,3}\.){3}\d{1,3}|::(?:[0-9a-fA-F]{1,4}:){0,5}(?:\d{1,3}\.){3}\d{1,3})$/;
  return ipv6Regex.test(v);
}

/* ===== 速度格式化（不换算单位） =====
   raw: 任意字符串
   appendUnit: 仅当 raw 中没有任何字母或 / 才追加 "MB/s"
   digits: 0 或 2
*/
function formatSpeedRaw(raw, appendUnit, digits){
  raw = String(raw||'').trim();
  if (!raw) return '';
  const numM = raw.match(/-?\d+(?:\.\d+)?/);
  if (!numM) return '';

  let val = parseFloat(numM[0]);
  if (!Number.isFinite(val)) return '';

  let body;
  if (digits === 0) body = String(Math.round(val));
  else {
    // 保留两位（按需求可严格两位，不去掉零）
    body = val.toFixed(2);
  }

  const hasUnit = /[a-zA-Z\/]/.test(raw);
  if (hasUnit) {
    // 原样保留单位，若匹配 MB/s 大小写，规范为 MB/s
    return (raw.replace(numM[0], body)).replace(/mb\s*\/\s*s/i,'MB/s');
  } else {
    return appendUnit ? (body + "MB/s") : body;
  }
}
