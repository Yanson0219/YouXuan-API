# YouXuan-API · Cloudflare Worker

> 把各种测速结果（**CFnat / CloudflareSpeedTest** 等）一键转换为“**优选 IP 订阅 API**”。  
> 纯前端 UI + Cloudflare Worker + KV。**仅支持 Cloudflare Workers（连接 GitHub 实时发布）**，**不支持 Pages**。

- ✅ **Workers 实时部署**：连接 GitHub 后 push 即发布
- ✅ **多文件上传**：可多次追加，每个文件独立卡片 + 单个/合并预览
- ✅ **自动识别列**：IP / 地区码 / 速度（排除延迟列，不做单位换算）
- ✅ **地区显示**：中文或英文缩写 A2；支持 `仅国家 / 国家+城市 / 国家+州省 / 仅城市`；自动去重（不再“香港香港”）
- ✅ **国旗**：可开关（按国家匹配）
- ✅ **速度格式**：保留 `0` 或 `2` 位；无单位时可自动追加 `MB/s`
- ✅ **配额与限制**（独立设置卡片）
  - 每国 IPv4 保留个数
  - 每国 IPv6 保留个数
  - 每国保留前 N 个 IP
  - **全局 Top-N**（不分国家，只保留最上面的 N 行）
- ✅ **个性化外观**：Logo/背景上传（可一键恢复默认）、背景透明度、深色/浅色、**移动端自适配**
- ✅ **安全**：前端不显示订阅地址；仅返回 KV/Token 是否已设置

---

## 0) 只用 Workers，拒用 Pages

> **不要用 Cloudflare Pages**，否则 API 无法即时更新。  
> 使用 **Cloudflare Workers** 并 **连接 GitHub**，才能做到 **push 即生效**。

---

## 1) 快速开始（Workers + GitHub）

1. **Fork** 本仓库（或将 `workers.js` 放入你的仓库）。
2. Cloudflare 控制台 → **Workers & Pages → Create Worker**（先建一个空 Worker）。
3. 打开该 Worker → **Quick edit**  
   - 用本项目 `workers.js` **完整替换**默认代码（ESM：`export default { fetch() {} }`）  
   - **Save and deploy**
4. **连接 GitHub**：Worker → **Deployments → Connect to Git** → 选择你的仓库/分支。之后 push 自动发布。
5. **创建并绑定 KV（名称固定为 `KV`）**  
   - 左侧 **KV** → **Create namespace**（例：`youxuan-api`）  
   - 回到 Worker → **Settings → Bindings → KV Namespace**  
     - Binding name：`KV`（必须是这个名字）  
     - Namespace：选刚创建的
6. **添加变量 `TOKEN`**（仅上传/读取订阅时校验）  
   - Worker → **Settings → Variables** → **Add variable (Secret)**  
   - Name：`TOKEN`，Value：你的强口令
7. （可选）**绑定自定义域名**：Worker → **Custom domains** 添加域名/子域。

> 检查：  
> - 打开 `https://你的域名/api/status` → `{"ok":true,"kvBound":true,"tokenSet":true}`  
> - 打开 `https://你的域名/` → 看到 UI（支持手机/深色）

---

## 2) 支持的测速来源

把导出的 **CSV/TXT** 直接拖进页面或粘贴文本即可，典型来源：

- **CFnat（Windows GUI）**：<https://github.com/cmliu/CFnat-Windows-GUI>
- **CloudflareSpeedTest**：<https://github.com/XIU2/CloudflareSpeedTest>

> 识别规则  
> - **速度**：仅做格式化（保留小数位、追加 `MB/s`），**不做单位换算**；自动避开“延迟/latency/ping/avg/rtt”等列  
> - **地区**：支持 IATA（如 `LAX/HKG/NRT/DEN/DUS/SEA/DFW/CDG/WAW/FRA/OTP/MAN` 等）、A2（`US/JP/HK/...`）、常见中英文国家/城市；**识别不到就原样保留**（不留空）  
> - **展示**：中文国家名或 A2 缩写；`国家+城市` 会输出类似 `US洛杉矶`、`JP东京`；香港/新加坡等**城市国家**自动去重

---

## 3) 使用流程（UI）

1. 访问 `https://你的域名/`  
2. **上传测速文件**（可多次追加）或**粘贴文本**  
3. 在 **地区显示 / 速度显示 / 节点前后缀 / 配额与限制 / 个性化设置** 中按需勾选  
4. 点击 **「🚀 生成预览」** 查看结果（支持统计面板）  
5. 准备发布时，在 **订阅上传 Token** 填写你设置的 `TOKEN`，点击 **「⬆️ 上传订阅」**  
6. 订阅读取：  
   - 文本：`https://你的域名/{TOKEN}`  
   - JSON：`https://你的域名/{TOKEN}.json`

> **安全说明**：前端不会显示订阅地址；`/api/status` 也不会泄露 `TOKEN`。

---

## 4) API 速查

GET / # 内置 UI（桌面/移动/深色）
GET /api/status # { ok, kvBound, tokenSet }
POST /api/preview # multipart: files[] + pasted + options
POST /api/publish # ?token=TOKEN 或 Header: x-token
GET /{TOKEN} # 订阅文本
GET /{TOKEN}.json # 订阅 JSON

**预览示例：**
```bash
curl -X POST https://你的域名/api/preview \
  -F "files=@result1.csv" \
  -F "files=@result2.txt" \
  -F "pasted=104.20.24.12,HKG,44.88" \
  -F "regionLang=zh" \
  -F "regionDetail=country_city" \
  -F "decorateFlag=on" \
  -F "appendUnit=on" \
  -F "digits=2" \
  -F "quotaV4=3" -F "quotaV6=2"

curl -X POST "https://你的域名/api/publish?token=你的TOKEN" \
  -H "content-type: text/plain; charset=utf-8" \
  --data-binary @output.txt
（5) 选项说明

地区显示

语言：中文 / 英文缩写（A2）

细节：仅国家 / 国家+城市 / 国家+州省 / 仅城市

国旗：可开关

速度显示：保留小数位 0 或 2；无单位时自动追加 MB/s

节点前缀 / 后缀：直接拼接到节点名

配额与限制（独立设置卡片）

每国 IPv4 保留个数

每国 IPv6 保留个数

每国保留前 N 个 IP

全局 Top-N：不按国家，只保留最上面的 N 行

个性化设置（独立入口）

上传 背景 / Logo（本地保存，不上传服务器）

恢复默认 按钮

背景透明度 滑块

深色模式在暗底使用更高对比（黑底白字）

（6) 搭配其它项目

edgetunnel：https://github.com/cmliu/edgetunnel

WorkerVless2sub（优选订阅生成器）：https://github.com/cmliu/WorkerVless2sub

epeius：https://github.com/cmliu/epeius

推荐用法：把本项目的订阅地址 https://你的域名/{TOKEN} 作为上游输入，上述工具负责线路包装/转换/分发。

测速来源建议：

CFnat（Windows GUI）：https://github.com/cmliu/CFnat-Windows-GUI

CloudflareSpeedTest：https://github.com/XIU2/CloudflareSpeedTest

（7) 常见问题

为什么坚决不用 Pages？ Pages 的构建与 Functions 延迟导致接口不能“即时更新”。要 push 即生效 → 用 Workers + GitHub。

速度识别错成延迟？ 解析已排除 延迟/latency/ping/avg/rtt 等关键词，速度列识别 download/speed/MB/s/throughput 等。

地区没匹配？ 保留原字段（例如 DUS/OTP/WAW 等 IATA 已补充常用映射，缺失也会原样输出）。

8) 更新要点（2025-10-29）

地区去重与 A2/中文双模式；仅国家 / 国家+城市 / 国家+州省 / 仅城市

多文件上传 + 单个/合并预览

配额与限制：每国 IPv4/IPv6、每国前 N、全局 Top-N

背景/Logo 上传与重置、背景透明度；移动端 UI 与深色高对比

速度小数位与单位追加；延迟列自动排除

订阅地址不在前端显示（仅服务端验证 TOKEN）

（9) 许可

MIT License。使用本项目即表示你将自担使用风险与合规责任。
