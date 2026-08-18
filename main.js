/* ============================================================
   MuMu助手 — CEP 版 main.js
   通过 window.__adobe_cep__.evalScript() 调用 JSX/hostscript.jsx 读写 PS 图层
   无 CEP 环境时降级为浏览器演示模式 (mock)
   界面风格：Photoshop 2025 原生暗色面板（无明暗切换）
   ============================================================ */
(function () {
  "use strict";

  /* ---------- 环境探测 ---------- */
  const cep = window.__adobe_cep__ || null;
  const isCEP = !!cep;
  const MOCK = !isCEP;

  const STORE_KEY = "ps_layer_library_v1";
  const SET_KEY = "ps_layer_library_settings_v1";
  const SCAN_INDEX_KEY = "ps_layer_library_scan_index_v1";   // path→fp，跨会话用于增量扫描
  const DEFAULT_CAT_NAME = "未分类";   // 默认分类名恒定，不允许被改
  const TRASH_DIR = "_回收站";         // 素材根目录下的保留文件夹（须与 hostscript 的 _PSL_TRASH 一致）
  const TRASH_VIEW = "__trash__";      // filterCat 取该值时进入回收站视图

  /* ---------- 状态 ---------- */
  let state = { categories: [], items: [], trash: [] };
  let settings = { assetDir: "", clickMode: "single", cardSize: 120, theme: "midgray", sortKey: "manual", sortDir: "desc", lastFilter: "", remotePath: "" };
  // 磁盘扫描索引：{ "C:/.../foo.psd": "1735000000000:12345", ... }  用于增量扫描
  // 只存指纹（mtime+size），不存其它元数据，体积很小（~50 字节/素材）
  let scanIndex = {};
  // 已扫过的分类 id（内存，不持久化；切分类时按需扫）
  // allScanned 标记"全量增量扫描已完成"，完成后所有分类都会进 scannedCats
  const scannedCats = new Set();
  let allScanned = false;

  // 磁盘上已不存在的素材 id（不持久化，每次打开/切换文件夹时重新校验）
  const missingIds = new Set();
  let _verifyToken = 0;   // 防止快速切换文件夹时旧校验结果覆盖新视图

  let filterCat = "";   // 空字符串 = 欢迎界面（首次打开或上次分类丢失）
  let searchTerm = "";
  let dragItemId = null, dragHandled = false, suppressClick = false;
  let ctxItemId = null;
  let hostReady = false;   // hostscript.jsx 是否已成功加载
  let dragDepth = 0;       // 外部文件拖拽的进出计数

  /* ============================================================
     存储层（索引存 localStorage；PNG 存 settings.assetDir）
     ============================================================ */
  function loadState() {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      try { state = JSON.parse(raw); } catch (e) { state = seedDefault(); }
      if (!state || !state.categories) state = seedDefault();
    } else {
      state = MOCK ? seedMock() : seedDefault();
    }
    migrateState();
  }
  function saveState() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  // 分类文件夹名安全化（须与 hostscript.jsx 的 _pslSafeDir 保持一致）
  function safeDirName(n) {
    let s = String(n == null ? "" : n)
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/^\s+/, "").replace(/\s+$/, "")
      .replace(/[.\s]+$/, "");
    if (!s) s = "未命名";
    return s.slice(0, 60);
  }

  // 老数据修正：
  //  1) 默认分类曾被允许改名（比如被改成 "111"），一律强制改回"未分类"
  //  2) 给每个分类补上对应的磁盘文件夹名，并保证互不重名
  function migrateState() {
    if (!state.categories || !state.categories.length) {
      state.categories = seedDefault().categories;
    }
    if (!state.items) state.items = [];
    if (!state.trash) state.trash = [];   // 老数据没有回收站字段
    let def = state.categories.find((c) => c.id === "uncat" || c.def === true);
    if (!def) {
      def = { id: "uncat", name: DEFAULT_CAT_NAME, color: "#9aa3bd", def: true };
      state.categories.unshift(def);
    }
    def.id = "uncat";
    def.def = true;
    def.name = DEFAULT_CAT_NAME;
    def.dir = DEFAULT_CAT_NAME;

    // 默认分类固定排在最前
    state.categories = [def].concat(state.categories.filter((c) => c !== def));

    const used = {};
    used[TRASH_DIR.toLowerCase()] = true;   // 回收站是保留文件夹名，分类不得占用
    state.categories.forEach((c) => {
      let base = c.dir ? safeDirName(c.dir) : safeDirName(c.name);
      let d = base, n = 2;
      while (used[d.toLowerCase()]) { d = base + "_" + n; n++; }
      c.dir = d;
      used[d.toLowerCase()] = true;
    });

    // ⚠ 去重：同一目录名只允许一个分类对象（重复是"面板里分类/素材两份"的根因：
    //    旧状态里同名分类的 dir 曾被加 _2 后缀 → 与磁盘文件夹失配 → 反向同步又建一个）。
    //    保留先出现（通常持有素材）的，重复者的素材/回收站记录全部归并过去
    const byDir = {};
    const mergedIds = {};                  // 被合并掉的 id → 保留者 id
    state.categories = state.categories.filter((c) => {
      const k = String(c.dir || "").toLowerCase();
      if (!byDir[k]) { byDir[k] = c; return true; }
      mergedIds[c.id] = byDir[k].id;
      console.warn("[MuMu助手] 合并重复分类「" + c.name + "」→「" + byDir[k].name + "」");
      return false;
    });
    if (Object.keys(mergedIds).length) {
      state.items.forEach((it) => { if (mergedIds[it.categoryId]) it.categoryId = mergedIds[it.categoryId]; });
      state.trash.forEach((it) => { if (mergedIds[it.fromCatId]) it.fromCatId = mergedIds[it.fromCatId]; });
      if (mergedIds[filterCat]) filterCat = mergedIds[filterCat];
      if (mergedIds[settings.lastFilter]) settings.lastFilter = mergedIds[settings.lastFilter];
    }

    // ⚠ 条目去重：id（=文件路径）相同只保留一条。历史状态里可能存过同一路径两条记录，
    //    增量同步的 upsert 只会更新其中一条，另一条永远留着 → "两份同样素材"直接根因
    const seenItem = {};
    state.items = state.items.filter((it) => {
      const k = String(it.id || "");
      if (seenItem[k]) return false;
      seenItem[k] = 1;
      return true;
    });
    const seenTrash = {};
    state.trash = state.trash.filter((it) => {
      const k = String(it.id || "");
      if (seenTrash[k]) return false;
      seenTrash[k] = 1;
      return true;
    });

    // ⚠ 假条目清理：历史扫描曾把 psd 的配套缩略图当素材入库（每个素材显示两份）。
    //    磁盘真实命名规律（与宿主侧 _pslIsThumbOfPsd 一致）：
    //      规则 A：X_t.png ↔ X.psd（老命名）
    //      规则 B：X_t_<时间戳>.png ↔ X_<任意时间戳>.psd（新命名，_t 在时间戳前面）
    //    加载即清，不等同步，旧缓存里的假卡片立刻消失
    const psdStems = {};
    for (const it of state.items) {
      const p = String(it.file || "").replace(/\\/g, "/");
      if (/\.psd$/i.test(p)) {
        const dir = p.slice(0, p.lastIndexOf("/") + 1).toLowerCase();
        const stem = p.slice(p.lastIndexOf("/") + 1).replace(/\.psd$/i, "").toLowerCase();
        psdStems[dir + stem] = 1;
      }
    }
    const isFakeThumb = (it) => {
      const p = String(it.file || "").replace(/\\/g, "/");
      if (!/\.png$/i.test(p)) return false;
      const name = p.slice(p.lastIndexOf("/") + 1);
      const stemFull = name.replace(/\.png$/i, "");
      const dir = p.slice(0, p.lastIndexOf("/") + 1).toLowerCase();
      // 规则 A：X_t.png → 存在 X.psd 即假条目
      if (/_t$/i.test(stemFull) && psdStems[dir + stemFull.substring(0, stemFull.length - 2).toLowerCase()]) return true;
      // 规则 B：X_t_<数字>.png → 存在 X_<数字>.psd 即假条目
      const m = /^(.+)_t_(\d+)$/i.exec(stemFull);
      if (m) {
        const pre = (dir + m[1] + "_").toLowerCase();
        for (const k in psdStems) {
          if (k.length > pre.length && k.indexOf(pre) === 0 && /^\d+$/.test(k.substring(pre.length))) return true;
        }
      }
      return false;
    };
    state.items = state.items.filter((it) => !isFakeThumb(it));
    state.trash = state.trash.filter((it) => !isFakeThumb(it));

    // 手动排序 order 补充：旧数据没有 → 用创建时间兜底，顺序不乱（仅本地状态字段）
    state.items.forEach((it) => { if (!it.order) it.order = it.createdAt || Date.now(); });
    state.trash.forEach((t) => { if (!t.order) t.order = t.createdAt || Date.now(); });
    saveState();
  }

  /* ---------- 分类 ↔ 文件夹 路径工具 ---------- */
  function assetRoot() {
    return String(settings.assetDir || "").replace(/\\/g, "/").replace(/\/+$/, "");
  }
  function catOf(catId) {
    return state.categories.find((c) => c.id === catId) ||
           state.categories.find(isDefaultCat) || null;
  }
  function catDirOf(catId) {
    const c = catOf(catId);
    return c ? (c.dir || safeDirName(c.name)) : DEFAULT_CAT_NAME;
  }
  // 分类对应的磁盘目录；root 可选（不传则用当前 assetRoot，传则用新根目录）
  function catPath(catId, root) {
    const base = root === undefined ? assetRoot() : String(root).replace(/\\/g, "/").replace(/\/+$/, "");
    return base + "/" + catDirOf(catId);
  }
  // 回收站目录
  function trashPath(root) {
    const base = root === undefined ? assetRoot() : String(root).replace(/\\/g, "/").replace(/\/+$/, "");
    return base + "/" + TRASH_DIR;
  }
  // 分类文件夹改名后，批量改写素材路径前缀
  function repath(p, from, to) {
    const s = String(p || "").replace(/\\/g, "/");
    return s.toLowerCase().indexOf(from.toLowerCase() + "/") === 0 ? to + s.slice(from.length) : p;
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SET_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s && typeof s === "object") settings = Object.assign(settings, s);
      }
    } catch (e) {}
    // 老版本里 lastFilter 可能存的是 "__all__"（已废弃的"全部图层"），统一清空 → 显示欢迎界面
    if (settings.lastFilter === "__all__") settings.lastFilter = "";
    if (MOCK && !settings.assetDir) settings.assetDir = "（演示模式）C:/Users/…/Documents/ps-layer-library/assets";
    applyCardSize();
  }
  function saveSettings() {
    try { localStorage.setItem(SET_KEY, JSON.stringify(settings)); } catch (e) {}
  }
  function applyCardSize() {
    const px = Math.max(80, Math.min(260, Number(settings.cardSize) || 120));
    document.documentElement.style.setProperty("--card-min", px + "px");
  }

  // 缩略图：真实模式直接用 file:// 指向本地 PNG（比 base64 走桥接快且无长度限制）
  function fileUrl(p) {
    if (!p) return null;
    let s = String(p).replace(/\\/g, "/");
    if (s.charAt(0) !== "/") s = "/" + s;      // C:/x → /C:/x
    return "file://" + encodeURI(s).replace(/#/g, "%23").replace(/\?/g, "%3F");
  }
  function thumbFor(item) {
    if (item._thumb) return item._thumb;       // base64 降级方案
    if (item.thumb) return item.thumb;         // mock
    if (item.file) return fileUrl(item.file);  // 真实模式
    return null;
  }

  /* ============================================================
     ExtendScript 桥接
     ============================================================ */
  // 原始调用：永远 resolve，返回原始字符串（含 CEP 自身的 "EvalScript error."）
  // ⚠ 旧版 PS（尤其 PS2020）中 cep.evalScript 偶发不回调 → Promise 永挂 →
  //    init() 卡在 await ensureHost() → "正在扫描素材库" 永不消失。
  //    加 15 秒超时兜底，超时后 resolve("EvalScript timeout.") 让流程继续。
  var _EVAL_TIMEOUT = 15000;
  function rawEval(jsx, timeout) {
    return new Promise((resolve) => {
      var done = false;
      var ms = timeout || _EVAL_TIMEOUT;
      var timer = setTimeout(function () {
        if (!done) { done = true; resolve("EvalScript timeout."); }
      }, ms);
      try {
        cep.evalScript(jsx, function (r) {
          if (!done) { done = true; clearTimeout(timer); resolve(String(r == null ? "" : r)); }
        });
      } catch (e) {
        if (!done) { done = true; clearTimeout(timer); resolve("EvalScript error."); }
      }
    });
  }
  // 业务调用：ERR: / EvalScript error 一律 reject
  // ⚠ timeout 参数：远程同步（SMB 枚举 + 分块复制）可能远超默认 15 秒，
  //   必须显式传长超时（120s），否则会被超时兜底误报“脚本未加载”
  async function evalScript(jsx, timeout) {
    const s = await rawEval(jsx, timeout);
    if (s.indexOf("EvalScript timeout") >= 0)
      throw new Error("宿主脚本执行超时（远程同步较慢或 PS 被对话框阻塞，请重试）");
    if (s.indexOf("EvalScript error") >= 0)
      throw new Error("宿主脚本执行失败（hostscript.jsx 未加载或语法错误）");
    if (s === "undefined" || s === "")
      throw new Error("宿主脚本无返回值（函数可能不存在）");
    if (s.indexOf("ERR:") === 0) throw new Error(s.slice(4));
    return s;
  }
  function esc(s) {
    // ⚠ 必须同时转义换行/回车/制表符：增量扫描索引（serializeScanIndex）含真实的
    //    \n 和 \t，不转义会让生成的 JSX 字符串字面量直接断行 → evalScript 语法错误 →
    //    整个后台同步管道失效（删除/还原后状态无法回推的深层原因之一）
    return String(s == null ? "" : s)
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n")
      .replace(/\t/g, "\\t");
  }
  function payload(res) {              // 去掉 "OK:" 前缀
    return res.indexOf("OK:") === 0 ? res.slice(3) : res;
  }

  // 启动时确认 hostscript 已加载且是最新版；没加载/版本旧就 $.evalFile 重新加载
  // ⚠ 版本检测必要：ExtendScript 全局在 PS 运行期间一直保留，重开面板不会更新旧脚本，
  //    旧版脚本缺新函数 → 扫描静默失败（只显分类不显素材）
  // 内部重试 3 次：CEP 偶发时序问题（CEF 加载完但 ExtendScript 还没编译好 hostscript）
  const REQUIRED_SCRIPT_VERSION = "32.2.6";   // 须与 hostscript.jsx 的 PSL_SCRIPT_VERSION 同步
  let hostScriptVersion = "";                 // 检测到的 hostscript 实际版本（设置面板展示）

  // 语义化版本比较：'32.1.1' > '32.1' > '32'（缺段补 0）；返回 a > b
  function verGt(a, b) {
    const pa = String(a || "").match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    const pb = String(b || "").match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (!pa || !pb) return false;
    for (let i = 1; i <= 3; i++) {
      const x = parseInt(pa[i] || "0", 10), y = parseInt(pb[i] || "0", 10);
      if (x !== y) return x > y;
    }
    return false;
  }
  async function _loadHostJsx() {
    try {
      let ext = "";
      try { ext = String(cep.fs.getSystemPath(cep.fs.EXTENSION)); } catch (eFs) {}
      if (!ext) { try { ext = String(cep.getSystemPath("extension")); } catch (e2) {} }
      if (!ext) return;
      ext = decodeURI(String(ext)).replace(/^file:\/{2,3}/, "").replace(/\\/g, "/");
      const base = ext.replace(/\/+$/, "");
      for (const sep of ["/", "\\"]) {
        const jsxPath = base + sep + "JSX" + sep + "hostscript.jsx";
        try { await rawEval("$.evalFile(new File('" + esc(jsxPath) + "'))", 5000); } catch (eEval) {}
      }
    } catch (e) { console.error("[MuMu助手] 加载 hostscript 异常:", e); }
  }
  async function _probeScriptVersion() {
    const vRaw = await rawEval("typeof PSL_Version === 'function' ? PSL_Version() : 'OK:0'", 5000);
    return payload(vRaw) || "0";
  }
  async function ensureHost() {
    if (!isCEP) return false;
    const probe = "typeof PSL_Ping === 'function' ? PSL_Ping() : 'ERR:NOFUNC'";
    // 探针用 5 秒超时（比业务调用短），确保旧版 PS 不回调时快速失败而非卡死
    const PROBE_TO = 5000;
    let staleReloads = 0;   // 版本过旧且重载失败的次数：超过阈值就硬失败，绝不拿旧脚本硬跑
    for (let i = 0; i < 3; i++) {
      const r = await rawEval(probe, PROBE_TO);
      if (r.indexOf("OK:") === 0) {
        // 已加载：检查版本。旧版（PS 内存里残留的老脚本）→ 强制重加载最新 JSX
        const v = await _probeScriptVersion();
        if (verGt(REQUIRED_SCRIPT_VERSION, v)) {
          console.log("[MuMu助手] hostscript 版本过旧(" + v + "<" + REQUIRED_SCRIPT_VERSION + ")，重新加载最新 JSX");
          await _loadHostJsx();
          const v2 = await _probeScriptVersion();
          if (!verGt(REQUIRED_SCRIPT_VERSION, v2)) { hostScriptVersion = v2; return true; }
          // ⚠ 重载后仍是旧版：记日志并继续重试，但绝不提前硬失败返回 false
          //    （返回 false 会让整个扫描链路不跑，两个库全部空白 —— 比旧脚本跑起来更糟）
          staleReloads++;
          console.error("[MuMu助手] JSX 重载未生效，PS 内存仍是 v" + v2 + "（第 " + staleReloads + " 次）");
          if (staleReloads === 2) toast("脚本更新未生效，若素材不显示请重启 PS", true);
        } else {
          if (i > 0) console.log("[MuMu助手] hostscript 第 " + (i + 1) + " 次探测成功");
          hostScriptVersion = v;
          return true;
        }
      }
      // 未加载：手动补载一次，后续重试只等时序稳定
      if (i === 0) { await _loadHostJsx(); }
      await new Promise((rs) => setTimeout(rs, 300));
    }
    console.error("[MuMu助手] ensureHost 重试 3 次仍失败, probe 末次 =", await rawEval(probe, PROBE_TO));
    return false;
  }

  /* ============================================================
     PS 操作
     ============================================================ */
  // 新素材要落进哪个分类：欢迎界面/回收站视图下一律归入默认分类
  function targetCategory() {
    if (filterCat === "" || filterCat === TRASH_VIEW) return "uncat";
    return state.categories.some((c) => c.id === filterCat) ? filterCat : "uncat";
  }

  async function saveCurrentLayers() {
    const target = targetCategory();

    // 欢迎界面下点保存：先切到目标分类（默认 uncat），否则 grid 是隐藏的，
    // 用户保存完看不到结果，会以为功能失效。
    if (filterCat === "") setFilter(target);

    if (MOCK) {
      const sample = seededNames[state.items.length % seededNames.length];
      state.items.unshift({
        id: uid(), name: sample, categoryId: target,
        thumb: generateMockThumb(sample, pickColor()),
        source: "演示文档.psd", createdAt: Date.now()
      });
      saveState(); renderAll(); toast("已保存（演示模式）");
      return;
    }

    if (!await needHost()) { toast("宿主脚本未加载，无法读取图层", true); return; }

    let res;
    // 多选合并存：选中几个图层就合并存成一份素材（保持堆叠顺序，插入时整组还原）；
    // 只选 1 个时 hostscript 内部自动走单层保存
    try { res = await evalScript("PSL_CaptureSelected('" + esc(catPath(target)) + "')"); }
    catch (e) {
      // 旧版脚本没有 PSL_CaptureSelected → 退回单层保存，功能不断
      try { res = await evalScript("PSL_CaptureLayer('" + esc(catPath(target)) + "')"); }
      catch (e2) { toast("保存失败：" + e2.message, true); return; }
    }

    // ERR 返回（背景层/空组/无文档等）→ 直接提示，不当成功解析
    if (!res || res.indexOf("OK:") !== 0) {
      toast(String(res || "保存失败").replace(/^ERR:/, "") || "保存失败", true);
      return;
    }
  
    // 返回格式两种都认：
    //   新（多选）："OK:n\npsdPath:::pngPath:::name:::kind\n..."（首行是数量）
    //   旧（单层）："OK:psdPath:::pngPath:::name:::kind"
    const lines = String(payload(res)).split("\n").filter((s) => s.length);
    const dataLines = (/^\d+$/.test(lines[0] || "")) ? lines.slice(1) : lines;
  
    // 立即把新素材加入 state.items（不等 runBackgroundSync），让用户马上看到卡片+角标
    // 用文件路径作 id（与 parseScanLine 一致），避免扫描后重复
    let savedCount = 0, lastName = "图层";
    for (const ln of dataLines) {
      const parts = ln.split(":::");
      const psdPath   = parts[0] || "";
      const pngPath   = parts[1] || "";
      const savedName = parts[2] || "图层";
      const kind      = parts[3] || "";
      if (!psdPath) continue;
      const newItem = {
        id: psdPath,
        name: savedName,
        categoryId: target,
        file: psdPath,
        thumb: pngPath || undefined,
        kind: kind || undefined,          // 角标来源：text/adjustment/group/smart/shape
        starred: 0,                       // 新素材默认不加星
        order: Date.now(),                // 手动排序位置（新素材放最前）
        createdAt: Date.now(),
        size: 0
      };
      const idx = state.items.findIndex((it) => it.id === psdPath);
      if (idx >= 0) state.items[idx] = newItem;
      else state.items.unshift(newItem);
      savedCount++;
      lastName = savedName;
    }
    if (savedCount > 0) { saveState(); scheduleIndexWrite(); }
  
    // 后台增量校正（fire-and-forget）：新条目已在本地 state 里，同步只做磁盘对齐，不阻塞提示
    if (!MOCK && hostReady) runBackgroundSync({ silent: true });
    renderAll();
    if (savedCount > 1) toast("已添加入库 " + savedCount + " 个图层");
    else toast("已添加入库「" + lastName + "」");
  }

  // file:// 加载失败时的降级：走 ExtendScript 读 base64
  async function loadThumbFallback(item) {
    if (!item || item._thumb || MOCK || !hostReady) return;
    // 保真素材是 .psd，缩略图应读同目录的 .png；没有 thumb 且是 psd 就跳过
    const src = item.thumb || item.file;
    if (!src) return;
    if (!item.thumb && /\.psd$/i.test(item.file || "")) return;
    try {
      const r = await evalScript("PSL_GetAsset('" + esc(src) + "')");
      if (r.indexOf("DATA:") === 0) {
        item._thumb = "data:image/png;base64," + r.slice(5);
        saveState();
        const img = grid.querySelector('.card[data-id="' + item.id + '"] .card-thumb');
        if (img) { img.dataset.fb = "1"; img.src = item._thumb; }
      }
    } catch (e) { /* 缩略图失败不影响主流程 */ }
  }

  async function insertItem(item) {
    if (!item) return;
    if (MOCK) { toast("演示模式：已模拟插入「" + item.name + "」到画布"); return; }
    if (!await needHost()) { toast("宿主脚本未加载，无法插入", true); return; }
    try {
      await evalScript("PSL_InsertLayer('" + esc(item.file) + "')");
      toast("已插入「" + item.name + "」");
    } catch (e) { toast("插入失败：" + e.message, true); }
  }

  /* ============================================================
     回收站：删除 = 搬进 _回收站 文件夹；还原 = 搬回分类文件夹
     ============================================================ */

  // 删除素材 → 移入回收站（文件不销毁，只换文件夹）
  // ⚠ 本地状态必须立即更新（items → trash），不能只依赖后台增量扫描回推：
  //    扫描是异步的，期间界面状态不对，且扫描失败时素材会"凭空消失"。
  async function deleteItem(itemId) {
    const idx = state.items.findIndex((i) => i.id === itemId);
    if (idx < 0) return;
    const it = state.items[idx];
    const cat = state.categories.find((c) => c.id === it.categoryId);

    // 快照原分类，供还原时定位（分类可能之后被改名或删除）
    const rec = Object.assign({}, it, {
      fromCatId: it.categoryId,
      fromCatName: cat ? cat.name : DEFAULT_CAT_NAME,
      deletedAt: Date.now()
    });

    if (!MOCK && hostReady && it.file) {
      try { await evalScript("PSL_TrashFolder('" + esc(assetRoot()) + "')"); } catch (e) {}
      const ok = await moveItemFiles(rec, trashPath());
      if (!ok) {
        toast("移入回收站失败：文件可能已被手动删除", true);
        // 文件没了也不该让条目卡在库里，记录照样进回收站供后续清理
      }
    }

    // 立即更新本地状态：从当前分类移除 → 出现在回收站
    state.items.splice(idx, 1);
    missingIds.delete(itemId);
    rec.id = rec.file || rec.id;          // 文件搬移后路径变了，id 跟随（moveItemFiles 已更新）
    state.trash.unshift(rec);
    saveState();
    scheduleIndexWrite();
    renderAll();
    toast("已移入回收站（可还原）");

    // 后台增量校正（磁盘即真相），不阻塞界面
    if (!MOCK && hostReady) runBackgroundSync({ silent: true });
  }

  // 还原：原分类 → 同名分类 → 默认分类，三级回退
  async function restoreItem(trashId) {
    const idx = state.trash.findIndex((i) => i.id === trashId);
    if (idx < 0) return;
    const rec = state.trash[idx];

    let cat = state.categories.find((c) => c.id === rec.fromCatId);
    let note = "";
    if (!cat && rec.fromCatName) {
      cat = state.categories.find((c) => c.name === rec.fromCatName);
    }
    if (!cat) {
      cat = state.categories.find(isDefaultCat) || state.categories[0];
      note = "（原分类「" + (rec.fromCatName || "未知") + "」已不存在）";
    }
    const catId = cat ? cat.id : "uncat";
    const catName = cat ? cat.name : DEFAULT_CAT_NAME;

    if (!MOCK && hostReady && rec.file) {
      const ok = await moveItemFiles(rec, catPath(catId));
      if (!ok) { toast("还原失败：文件可能已被手动删除", true); return; }
    }

    // 立即更新本地状态：回收站移除 → 回到目标分类
    state.trash.splice(idx, 1);
    const restored = Object.assign({}, rec);
    restored.id = restored.file || restored.id;
    restored.categoryId = catId;
    delete restored.fromCatId;
    delete restored.fromCatName;
    delete restored.deletedAt;
    state.items = state.items.filter((i) => i.id !== restored.id);  // 防重复
    state.items.unshift(restored);
    saveState();
    scheduleIndexWrite();
    renderAll();
    toast("已还原到「" + catName + "」" + note);

    if (!MOCK && hostReady) runBackgroundSync({ silent: true });
  }

  // 彻底删除单个素材（仅限回收站内执行，带确认弹窗）
  async function purgeItem(trashId) {
    const rec = state.trash.find((i) => i.id === trashId);
    if (!rec) return;
    const ok = await askConfirm("彻底删除",
      "「" + rec.name + "」将从磁盘永久删除，无法恢复。");
    if (!ok) return;

    if (!MOCK && hostReady && rec.file) {
      try {
        await evalScript("PSL_DeleteAsset('" + esc(rec.file) + "','" + esc(rec.thumb || "") + "')");
      } catch (e) {}
    }
    state.trash = state.trash.filter((i) => i.id !== trashId);
    if (rec.file) delete scanIndex[rec.file];   // 同步清理扫描索引，避免下次同步复活
    saveState();
    scheduleIndexWrite();
    renderAll();
    toast("已彻底删除");

    if (!MOCK && hostReady) runBackgroundSync({ silent: true });
  }

  // 文件已在磁盘上被删（资源管理器里手动删），只清理这条库记录
  async function removeMissing(itemId) {
    const idx = state.items.findIndex((i) => i.id === itemId);
    if (idx < 0) return;
    const it = state.items[idx];
    const ok = await askConfirm("移出库",
      "「" + it.name + "」的素材文件已不存在，要从 MuMu助手 记录里移除这条吗？（仅删记录，磁盘文件早已删除）");
    if (!ok) return;
    state.items.splice(idx, 1);
    missingIds.delete(itemId);
    if (it.file) delete scanIndex[it.file];
    saveState();
    scheduleIndexWrite();
    renderAll();
    toast("已移出记录");

    if (!MOCK && hostReady) runBackgroundSync({ silent: true });
  }

  // 一键清空回收站
  async function emptyTrash() {
    const n = state.trash.length;
    if (!n) { toast("回收站是空的"); return; }
    const ok = await askConfirm("清空回收站",
      "回收站里的 " + n + " 个素材将从磁盘永久删除，无法恢复。");
    if (!ok) return;

    let files = 0;
    if (!MOCK && hostReady) {
      try {
        files = Number(payload(await evalScript("PSL_EmptyTrash('" + esc(assetRoot()) + "')"))) || 0;
      } catch (e) { toast("清空失败：" + e.message, true); return; }
    }
    state.trash.forEach((t) => { if (t.file) delete scanIndex[t.file]; });
    state.trash = [];
    saveState();
    scheduleIndexWrite();
    renderAll();
    toast("回收站已清空" + (files ? "（删除 " + files + " 个文件）" : ""));

    if (!MOCK && hostReady) runBackgroundSync({ silent: true });
  }

  /* ============================================================
     外部图片拖入 → 导入素材库
     ============================================================ */
  function isFileDrag(e) {
    const t = e.dataTransfer && e.dataTransfer.types;
    if (!t) return false;
    for (let i = 0; i < t.length; i++) if (t[i] === "Files") return true;
    return false;
  }

  // 从 drop 事件里尽可能提取本地文件绝对路径
  function pathsFromDrop(e) {
    const out = [];
    const files = e.dataTransfer.files;
    if (files && files.length) {
      for (let i = 0; i < files.length; i++) {
        if (files[i].path) out.push(files[i].path);   // CEF 开了 nodejs 才有 .path
      }
    }
    if (!out.length) {
      // 降级：从 uri-list 里解析 file:// 链接
      let uri = "";
      try { uri = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain") || ""; }
      catch (err) {}
      uri.split(/[\r\n]+/).forEach((line) => {
        const s = line.trim();
        if (!s || s.charAt(0) === "#") return;
        if (s.toLowerCase().indexOf("file://") === 0) {
          let p = decodeURI(s.replace(/^file:\/{2,3}/, ""));
          if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);   // /C:/x → C:/x
          out.push(p);
        }
      });
    }
    return out;
  }

  async function importDroppedFiles(e) {
    const target = targetCategory();

    // 欢迎界面下拖入文件：先切到目标分类（默认 uncat），否则导入完看不到结果
    if (filterCat === "") setFilter(target);

    if (MOCK) {
      const files = e.dataTransfer.files;
      if (!files || !files.length) { toast("演示模式：未取到文件", true); return; }
      let n = 0;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (f.type.indexOf("image/") !== 0) continue;
        const dataUrl = await new Promise((res) => {
          const rd = new FileReader();
          rd.onload = () => res(rd.result);
          rd.onerror = () => res(null);
          rd.readAsDataURL(f);
        });
        if (!dataUrl) continue;
        state.items.unshift({
          id: uid(), name: f.name.replace(/\.[^.]+$/, ""), categoryId: target,
          thumb: dataUrl, createdAt: Date.now()
        });
        n++;
      }
      saveState(); renderAll();
      toast(n ? "已导入 " + n + " 个文件（演示模式）" : "没有可导入的图片", !n);
      return;
    }

    if (!await needHost()) { toast("宿主脚本未加载，无法导入", true); return; }

    const paths = pathsFromDrop(e);
    if (!paths.length) { toast("没取到文件路径，请从资源管理器拖入图片", true); return; }

    // 库内文件拖入判断用的路径基准（小写 + 正斜杠，避免 Windows 大小写/分隔符差异）
    const rootL = assetRoot().replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    const destDirL = catPath(target).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    let ok = 0, skipped = 0; const errs = [];
    for (const p of paths) {
      try {
        const normL = String(p).replace(/\\/g, "/").toLowerCase();
        // ⚠ 文件本身就在素材库里：绝不能复制第二份（"素材两份"的另一根因）
        //   - 已在目标分类 → 跳过
        //   - 在其他分类/回收站 → 移动到目标分类（原件会被清掉）
        if (rootL && normL.indexOf(rootL + "/") === 0) {
          const dirL = normL.slice(0, normL.lastIndexOf("/"));
          if (dirL === destDirL) { skipped++; continue; }
          await evalScript(
            "PSL_MoveAsset('" + esc(p) + "','" + esc(catPath(target)) + "')"
          );
          ok++;
          continue;
        }
        await evalScript(
          "PSL_ImportFile('" + esc(p) + "','" + esc(catPath(target)) + "')"
        );
        ok++;
      } catch (err) { errs.push(err.message); }
    }
    // 增量同步
    if (ok && !MOCK && hostReady) { await runBackgroundSync({ silent: true }); }
    renderAll();
    if (ok) toast("已导入 " + ok + " 个素材" + (skipped ? "（" + skipped + " 个已在本分类）" : "") + (errs.length ? "（" + errs.length + " 个失败）" : ""));
    else if (skipped && !errs.length) toast("这些素材已在本分类中");
    else toast("导入失败：" + (errs[0] || "未知原因"), true);
  }

  /* ============================================================
     种子数据（仅 mock 演示用）
     ============================================================ */
  const seededNames = ["主图背景", "促销角标", "图标_箭头", "文字_包邮", "边框装饰", "产品抠图", "渐变光效", "Logo水印"];
  const catPalette = ["#6d5efc", "#ff7a59", "#23c4a7", "#ffb020", "#ff5470", "#4d9bff"];
  function pickColor() { return catPalette[Math.floor(Math.random() * catPalette.length)]; }

  function seedDefault() {
    return {
      categories: [{ id: "uncat", name: DEFAULT_CAT_NAME, dir: DEFAULT_CAT_NAME, color: "#9aa3bd", def: true }],
      items: []
    };
  }
  function seedMock() {
    const cats = [
      { id: "uncat", name: DEFAULT_CAT_NAME, dir: DEFAULT_CAT_NAME, color: "#9aa3bd", def: true },
      { id: "c1", name: "电商素材", dir: "电商素材", color: "#6d5efc" },
      { id: "c2", name: "图标", dir: "图标", color: "#23c4a7" },
      { id: "c3", name: "文字", dir: "文字", color: "#ff7a59" }
    ];
    const items = [];
    const catIds = ["uncat", "c1", "c2", "c3", "c1", "c2"];
    for (let i = 0; i < 6; i++) {
      items.push({
        id: uid(), name: seededNames[i], categoryId: catIds[i],
        thumb: generateMockThumb(seededNames[i], pickColor()),
        source: "示例.psd", createdAt: Date.now() - i * 1000
      });
    }
    return { categories: cats, items };
  }
  function generateMockThumb(name, color) {
    try {
      const c = document.createElement("canvas");
      c.width = 200; c.height = 200;
      const x = c.getContext("2d");
      const g = x.createLinearGradient(0, 0, 200, 200);
      g.addColorStop(0, color); g.addColorStop(1, shade(color, -30));
      x.fillStyle = g; x.fillRect(0, 0, 200, 200);
      x.fillStyle = "rgba(255,255,255,0.92)";
      x.font = "bold 22px sans-serif";
      x.textAlign = "center"; x.textBaseline = "middle";
      const lines = name.split("_");
      lines.forEach((ln, i) => x.fillText(ln, 100, 100 - (lines.length - 1) * 16 + i * 32));
      return c.toDataURL("image/png");
    } catch (e) { return null; }
  }
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) + amt, g = ((n >> 8) & 255) + amt, b = (n & 255) + amt;
    r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b));
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }
  function uid() { return "i" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ============================================================
     DOM 引用
     ============================================================ */
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const grid = $("#grid");
  const content = $("#content");
  const dropzone = $("#dropzone");
  const dzCat = $("#dzCat");
  const emptyState = $("#emptyState");
  const currentCatName = $("#currentCatName");
  const itemCount = $("#itemCount");
  const searchInput = $("#searchInput");
  const catLabel = $("#catLabel");
  const catMenu = $("#catMenu");
  const catMenuList = $("#catMenuList");
  const catCountTrash = $("#catCountTrash");
  const catTrash = $("#catTrash");
  const catDropdown = $("#catDropdown");
  const catTrigger = $("#catTrigger");
  // 宽面板左侧常驻分类列表（窄面板由 CSS 隐藏，逻辑照常维护）
  const catSideList = $("#catSideList");
  const sideCountTrash = $("#sideCountTrash");
  const emptyTitle = $("#emptyTitle");
  const emptyHint = $("#emptyHint");
  const welcomeState = $("#welcomeState");
  const welcomeNewCat = $("#welcomeNewCat");
  const saveBtn = $("#saveBtn");
  const ctxMenu = $("#ctxMenu");
  const ctxMoveSub = $("#ctxMoveSub");
  const app = $("#app");

  function renderAll() { renderDropdown(); renderGrid(); }

  /* ============================================================
     分类下拉
     ============================================================ */
  function isDefaultCat(c) { return !!(c && (c.def === true || c.id === "uncat")); }

  function renderDropdown() {
    const cur = filterCat === TRASH_VIEW ? "回收站"
      : filterCat === "" ? "选择分类"
      : (state.categories.find((c) => c.id === filterCat) || {}).name || "选择分类";
    catLabel.textContent = cur;
    catCountTrash.textContent = state.trash.length;
    catTrash.classList.toggle("active", filterCat === TRASH_VIEW);

    // 一次遍历算出各分类计数（原写法每个分类都全量 filter 一遍，O(C×N) → O(C+N)）
    const counts = {};
    for (const it of state.items) counts[it.categoryId] = (counts[it.categoryId] || 0) + 1;

    if (sideCountTrash) sideCountTrash.textContent = state.trash.length;

    catMenuList.innerHTML = "";
    if (catSideList) catSideList.innerHTML = "";
    state.categories.forEach((c) => {
      const count = counts[c.id] || 0;
      const row = document.createElement("div");
      row.className = "dd-item" + (filterCat === c.id ? " active" : "");
      row.dataset.cat = c.id;
      // 默认分类受保护：只显示，不挂重命名/删除按钮
      const acts = isDefaultCat(c)
        ? ""
        : `<span class="dd-acts">` +
            `<button class="dd-act" data-act="edit" title="重命名（文件夹同步改名）">✎</button>` +
            `<button class="dd-act" data-act="del" title="删除（需先清空分类）">🗑</button>` +
          `</span>`;
      row.title = "素材文件夹：" + (c.dir || safeDirName(c.name));
      row.innerHTML =
        `<span class="dd-name">${escapeHtml(c.name)}</span>` +
        `<span class="dd-count">${count}</span>` + acts;
      bindCatDropTarget(row, c.id);
      catMenuList.appendChild(row);
      // 侧栏同步一份（结构/交互完全一致）；宽面板下分类行可拖拽排序
      // （下拉菜单是临时浮层，拖拽体验差，不支持排序）
      if (catSideList) {
        const srow = row.cloneNode(true);
        bindCatDropTarget(srow, c.id);
        srow.draggable = true;
        srow.addEventListener("dragstart", (e) => {
          catDragId = c.id;
          srow.classList.add("dragging");
          e.dataTransfer.setData("text/plain", c.id);
          e.dataTransfer.effectAllowed = "move";
        });
        srow.addEventListener("dragend", () => {
          srow.classList.remove("dragging");
          catDragId = null;
          if (catDragHover) {
            catDragHover.classList.remove("drop-before", "drop-after");
            catDragHover = null;
          }
        });
        catSideList.appendChild(srow);
      }
    });
  }

  // 让分类行成为「拖卡片进来即归类」的落点；
  // 分类自身拖拽（catDragId）时同一行变成排序落点，上下半区决定插入位置
  function bindCatDropTarget(el, catId) {
    el.addEventListener("dragover", (e) => {
      if (dragItemId) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        el.classList.add("drop-hover");
        return;
      }
      if (catDragId && catDragId !== catId) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const r = el.getBoundingClientRect();
        const before = e.clientY < r.top + r.height / 2;
        if (catDragHover && catDragHover !== el) {
          catDragHover.classList.remove("drop-before", "drop-after");
        }
        catDragHover = el;
        el.classList.remove("drop-before", "drop-after");
        el.classList.add(before ? "drop-before" : "drop-after");
      }
    });
    el.addEventListener("dragleave", (e) => {
      if (e.relatedTarget && el.contains(e.relatedTarget)) return;   // 移入子元素不算离开
      el.classList.remove("drop-hover");
      if (catDragId) el.classList.remove("drop-before", "drop-after");
      if (catDragHover === el) catDragHover = null;
    });
    el.addEventListener("drop", (e) => {
      el.classList.remove("drop-hover");
      if (catDragId) el.classList.remove("drop-before", "drop-after");
      if (dragItemId) {
        e.preventDefault(); e.stopPropagation();
        dragHandled = true;
        moveItemToCategory(dragItemId, catId);
        closeCatMenu();
        return;
      }
      if (catDragId && catDragId !== catId) {
        e.preventDefault(); e.stopPropagation();
        const r = el.getBoundingClientRect();
        reorderCategory(catDragId, catId, e.clientY < r.top + r.height / 2);
      }
    });
  }

  function openCatMenu() { catMenu.hidden = false; }
  function closeCatMenu() { catMenu.hidden = true; }

  catMenuList.addEventListener("click", (e) => {
    const row = e.target.closest(".dd-item");
    if (!row) return;
    const id = row.dataset.cat;
    const actBtn = e.target.closest(".dd-act");
    if (actBtn) {
      e.stopPropagation();
      const act = actBtn.dataset.act;
      closeCatMenu();
      if (act === "edit") renameCategory(id);
      else if (act === "del") deleteCategory(id);
      else if (act === "open") openCategoryFolder(id);
      return;
    }
    setFilter(id); closeCatMenu();
  });

  // 宽面板侧栏：交互与下拉菜单一致（选择/重命名/删除）
  if (catSideList) {
    catSideList.addEventListener("click", (e) => {
      const row = e.target.closest(".dd-item");
      if (!row) return;
      const actBtn = e.target.closest(".dd-act");
      if (actBtn) {
        e.stopPropagation();
        const act = actBtn.dataset.act;
        const id = row.dataset.cat;
        if (act === "edit") renameCategory(id);
        else if (act === "del") deleteCategory(id);
        else if (act === "open") openCategoryFolder(id);
        return;
      }
      setFilter(row.dataset.cat);
    });
  }
  const sideNewCat = $("#sideNewCat");
  if (sideNewCat) sideNewCat.addEventListener("click", (e) => { e.stopPropagation(); newCategory(); });
  const sideTrash = $("#sideTrash");
  if (sideTrash) sideTrash.addEventListener("click", (e) => { e.stopPropagation(); setFilter(TRASH_VIEW); });

  catTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (catMenu.hidden) openCatMenu(); else closeCatMenu();
  });
  $("#catNew").addEventListener("click", (e) => { e.stopPropagation(); closeCatMenu(); newCategory(); });
  // 欢迎界面里的「新建第一个分类」按钮：和下拉里的+新建分类走同一条路径
  if (welcomeNewCat) {
    welcomeNewCat.addEventListener("click", () => { newCategory(); });
  }
  catTrash.addEventListener("click", (e) => {
    e.stopPropagation();
    setFilter(TRASH_VIEW); closeCatMenu();
  });

  // 切分类：先看缓存，缓存命中秒切；未扫过的分类走按需扫描（毫秒级）
  // 异步但不阻塞调用方（fire-and-forget），内部已完成必要 renderAll
  function setFilter(id) {
    filterCat = id;
    settings.lastFilter = id;
    saveSettings();
    // 立即用缓存渲染（已扫过的分类或特殊视图直接命中）
    renderAll();
    // 切到具体未扫过的分类 → 后台按需扫
    if (id !== "" && id !== TRASH_VIEW && id !== "uncat" &&
        !scannedCats.has(id) && !allScanned && hostReady && settings.assetDir) {
      const cat = state.categories.find((c) => c.id === id);
      if (cat) {
        scanOneCategory(id).then((added) => {
          if (added > 0 && filterCat === id) renderAll();
        });
      }
    }
  }  /* ============================================================
     卡片网格
     ============================================================ */
  // 动态重算 grid 列数，让卡片均分填满宽度
  function recalcCols(cardSize) {
    const g = $("#grid");
    if (!g || g.clientWidth <= 0) return;
    const cs = cardSize || Math.max(80, Math.min(260, Number(settings.cardSize) || 120));
    const cols = Math.max(1, Math.floor(g.clientWidth / cs));
    g.style.gridTemplateColumns = "repeat(" + cols + ", 1fr)";
  }
  // 面板尺寸变化时自动重算
  // ⚠ ResizeObserver 在 PS2020（Chromium 61）中不存在，必须做特性检测，
  //    否则此行抛 ReferenceError → 整个 IIFE 崩溃 → init() 不执行 →
  //    "正在扫描素材库" 覆盖层永远不消失（PS2020 下无限加载的根因）。
  if (typeof ResizeObserver !== "undefined") {
    try { (new ResizeObserver(() => recalcCols())).observe($("#grid")); } catch (eRO) {}
  } else {
    // 旧版 CEP 降级：监听 window resize 事件重算列数
    window.addEventListener("resize", () => recalcCols());
    // 首次布局后补算一次列数（无 ResizeObserver 时面板初次显示可能不触发 resize）
    setTimeout(() => recalcCols(), 200);
  }

  // 缩略图懒加载：卡片只存 dataset.src，进视口才真正设 img.src
  // 避免一次渲染 900+ 张卡片时所有图片同时解码导致卡顿
  // ⚠ Observer 全生命周期复用一个（旧写法每次渲染重建，大列表下开销可观），
  //    每次渲染前 disconnect() 清掉旧观察对象即可，不会泄漏
  let lazyObserver = null;
  // 懒加载并发限制：图片素材的预览就是原图（可能几 MB），快速滚动时同时解码
  // 几十张大图会把 CEF 渲染线程打满 → 预览迟迟不出、界面卡顿。
  // 用简单队列：同时最多 THUMB_LOAD_CAP 张在加载，其余排队，避免解码洪峰
  const THUMB_LOAD_CAP = 6;
  const _thumbQueue = [];
  let _thumbLoading = 0;
  function thumbLoadNext() {
    while (_thumbLoading < THUMB_LOAD_CAP && _thumbQueue.length) {
      const job = _thumbQueue.shift();
      _thumbLoading++;
      const img = job.img;
      img.addEventListener("load", () => { _thumbLoading--; thumbLoadNext(); });
      img.addEventListener("error", () => { _thumbLoading--; thumbLoadNext(); });
      img.src = job.src;
    }
  }
  function thumbLoad(img, src) {
    if (img.dataset.srcQueued) return;   // 已在队列（renderGrid 重建后旧 img 不再排队）
    img.dataset.srcQueued = "1";
    _thumbQueue.push({ img: img, src: src });
    thumbLoadNext();
  }
  function getLazyObserver() {
    // 老 CEP（Chromium <51）没 IntersectionObserver，返回 null 让卡片走立即加载分支
    if (typeof IntersectionObserver === "undefined") return null;
    if (!lazyObserver) {
      lazyObserver = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const img = e.target;
          const src = img.dataset.src;
          if (src) thumbLoad(img, src);      // 入队限并发，而不是一次性全部设 src
          lazyObserver.unobserve(img);     // 加载过就不再观察
        }
      }, { root: grid, rootMargin: "400px 0px" });
    }
    return lazyObserver;
  }

  // 磁盘存在性校验防抖：搜索/排序/切分类都会触发 renderGrid，
  // 没防抖时每次渲染都立刻发一轮 PSL_CheckFiles 桥接调用，旧版 PS 上明显卡顿
  let _verifyTimer = null;
  function scheduleVerify() {
    clearTimeout(_verifyTimer);
    _verifyTimer = setTimeout(verifyView, 350);
  }

  // 渲染序号：分批渲染期间若发生了新的完整渲染，旧批次直接丢弃
  let _renderToken = 0;

  // 当前视图的过滤 + 排序（renderGrid 与拖拽重排共用同一份顺序）
  // 排序规则：加星置顶永远在最前；组内按 sortKey（manual=手动顺序 / time / name / size）
  function computeSortedView() {
    const term = searchTerm.trim().toLowerCase();
    const isTrash = filterCat === TRASH_VIEW;
    const isWelcome = filterCat === "";   // 欢迎界面：无上次分类时显示

    // 分类 id→对象 缓存：搜索过滤/卡片渲染里不再反复 find（O(N×C) → O(N)）
    const catById = {};
    for (const c of state.categories) catById[c.id] = c;

    let items = isTrash ? state.trash.slice() : state.items.slice();
    if (!isTrash && !isWelcome) {
      items = items.filter((i) => i.categoryId === filterCat);
    }
    if (term) {
      items = items.filter((i) => {
        const cn = isTrash
          ? (i.fromCatName || "")
          : ((catById[i.categoryId] || {}).name || "");
        return (i.name || "").toLowerCase().indexOf(term) >= 0 ||
               cn.toLowerCase().indexOf(term) >= 0;
      });
    }
    items.sort((a, b) => {
      // 回收站视图：固定按删除时间（不参与手动排序/置顶）
      if (isTrash) {
        const sign = settings.sortDir === "asc" ? 1 : -1;
        return ((a.deletedAt || 0) - (b.deletedAt || 0)) * sign;
      }
      // 加星置顶：星星永远排在最前面
      const sa = a.starred ? 1 : 0, sb = b.starred ? 1 : 0;
      if (sa !== sb) return sb - sa;
      const key = settings.sortKey || "manual";
      const dir = settings.sortDir || "desc";
      const sign = dir === "asc" ? 1 : -1;
      if (key === "manual") {
        // 手动排序：order 大者在前（新建时 order=Date.now()，新素材自动排最前；
        // 拖拽后重写 order 保持视觉顺序）
        return (b.order || 0) - (a.order || 0);
      }
      let cmp = 0;
      if (key === "name") {
        cmp = (a.name || "").localeCompare(b.name || "", "zh-Hans-CN");
      } else if (key === "size") {
        cmp = (a.size || 0) - (b.size || 0);
      } else {                                          // time（默认）
        cmp = (a.createdAt || 0) - (b.createdAt || 0);
      }
      return cmp * sign;
    });
    return { items: items, isTrash: isTrash, isWelcome: isWelcome, catById: catById };
  }

  function renderGrid(keepScroll) {
    const token = ++_renderToken;
    // 拖拽重排/置顶等场景传入 keepScroll：渲染完成后恢复滚动位置，避免视野跳到别处
    const prevScroll = keepScroll ? grid.scrollTop : 0;
    const v = computeSortedView();
    const items = v.items, isTrash = v.isTrash, isWelcome = v.isWelcome, catById = v.catById;

    currentCatName.textContent = isTrash ? "回收站"
      : isWelcome ? "欢迎使用"
      : (catById[filterCat] || {}).name || "图层";
    itemCount.textContent = items.length;

    // 回收站视图：底部按钮变身「清空回收站」（红色）；普通视图：恢复为「添加入库」
    // 只在模式变化时重写 innerHTML（每次渲染都重写会无谓触发 DOM 重建）
    const btnMode = isTrash ? "trash" : "normal";
    if (btnMode !== _saveBtnMode) {
      _saveBtnMode = btnMode;
      if (isTrash) {
        saveBtn.className = "btn-danger block";
        saveBtn.title = "彻底删除回收站里的全部素材，无法恢复";
        saveBtn.innerHTML = "清空回收站";
      } else {
        saveBtn.className = "btn-primary block";
        saveBtn.title = "把 PS 中选中的图层存入当前分类";
        saveBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 3v12m0-12 4 4m-4-4-4 4M5 21h14"/></svg>\n        添加入库';
      }
    }

    grid.innerHTML = "";
    // 大列表关闭入场动画，旧版 CEP 上明显更流畅（小列表保留动效不变）
    grid.classList.toggle("no-anim", items.length > 120);
    if (lazyObserver) { try { lazyObserver.disconnect(); } catch (e) {} }
    const lazy = getLazyObserver();
    // 欢迎界面：隐藏 grid + emptyState，单独显示 welcomeState
    if (isWelcome) {
      emptyState.style.display = "none";
      welcomeState.hidden = false;
      grid.style.display = "none";
    } else {
      welcomeState.hidden = true;
      grid.style.display = "";
      emptyState.style.display = items.length ? "none" : "flex";
    }
    if (isTrash) {
      emptyTitle.textContent = "回收站是空的";
      emptyHint.innerHTML = "删除的素材会先放到这里<br>可以随时还原回原来的分类";
    } else if (!isWelcome) {
      emptyTitle.textContent = "还没有保存的图层";
      emptyHint.innerHTML = "在 PS 中选中图层后点下方按钮收藏<br>也可以直接把图片文件拖进这里";
    }

    const single = settings.clickMode !== "double";
    const o = { isTrash: isTrash, single: single, lazy: lazy, catById: catById };

    // 分批渲染：每批 CHUNK 张卡片后让出主线程，大库（几百张）不卡 UI
    const CHUNK = 80;
    let i = 0;
    const appendChunk = () => {
      if (token !== _renderToken) return;   // 已被更新的渲染取代，丢弃
      const frag = document.createDocumentFragment();
      const end = Math.min(i + CHUNK, items.length);
      for (; i < end; i++) frag.appendChild(buildCard(items[i], o));
      grid.appendChild(frag);
      if (i < items.length) { setTimeout(appendChunk, 0); return; }
      // 全部批次渲染完成后再恢复滚动位置（此时内容高度已定型，位置才准确）
      if (keepScroll && token === _renderToken) grid.scrollTop = prevScroll;
    };
    if (items.length && !isWelcome) appendChunk();
    else if (keepScroll) grid.scrollTop = prevScroll;   // 空视图：无卡片可恢复，直接复位

    // 动态计算列数：让卡片均分填满宽度，不留右侧空白
    recalcCols();

    // 延后校验当前视图素材是否还在磁盘上（防抖，避免频繁渲染时重复发桥接调用）
    scheduleVerify();
  }
  let _saveBtnMode = "";

  // 构建单张卡片（从 renderGrid 拆出，便于分批渲染）
  function buildCard(it, o) {
    const isTrash = o.isTrash, single = o.single, lazy = o.lazy;
    const missing = !isTrash && missingIds.has(it.id);
    const card = document.createElement("div");
    card.className = "card" + (isTrash ? " card-trashed" : "") + (missing ? " card-missing" : "");
    card.draggable = !isTrash && !missing;
    card.dataset.id = it.id;
    card.title = isTrash
      ? "已删除 · 点「还原」放回原分类 · 右键可彻底删除"
      : missing
        ? "素材文件已删除（在资源管理器里删了）· 右键「移出库」清理记录"
        : (single ? "单击插入到画布" : "双击插入到画布") + " · 右键更多操作 · 拖动可归类";
    const thumb = thumbFor(it);
    const bd = BADGES[it.kind];
    const starBtn = (isTrash || missing)
      ? ""
      : '<button class="card-star' + (it.starred ? " on" : "") + '" title="' +
        (it.starred ? "取消置顶" : "点亮后永远置顶") + '">' +
        '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.4l-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9z"/></svg>' +
      '</button>';
    const badge = isTrash
      ? '<button class="card-restore" title="还原到原分类">↩ 还原</button>'
      : missing
        ? '<span class="card-badge b-miss" title="素材文件已被手动删除（在资源管理器里删了）">缺</span>'
        : (bd ? '<span class="card-badge ' + bd[0] + '" title="' + bd[2] + '">' + bd[1] + '</span>' : "");
    const sub = isTrash ? "原属：" + (it.fromCatName || DEFAULT_CAT_NAME) : "";
    const missingOverlay = missing
      ? '<div class="card-missing-ov">⚠ 文件已删除</div>' : "";
    card.innerHTML =
      '<button class="card-menu" title="更多操作">' +
        '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/></svg>' +
      '</button>' +
      starBtn +
      badge +
      '<div class="thumb-wrap"><img class="card-thumb" alt="' + escapeHtml(it.name) + '" draggable="false" /></div>' +
      missingOverlay +
      '<div class="card-meta">' +
        '<div class="card-name" title="' + escapeHtml(it.name) + '">' + escapeHtml(it.name) + '</div>' +
        (isTrash ? '<div class="card-cat" title="' + escapeHtml(sub) + '">' + escapeHtml(sub) + '</div>' : "") +
      '</div>';

    const img = card.querySelector(".card-thumb");
    if (thumb) {
      // file:// 读不到时自动降级到 base64
      img.addEventListener("error", () => {
        if (img.dataset.fb) return;
        img.dataset.fb = "1";
        loadThumbFallback(it);
      });
      // 懒加载：进视口才真正加载图片。老版本 CEP（无 IntersectionObserver）直接加载。
      if (lazy) {
        img.dataset.src = thumb;
        lazy.observe(img);
      } else {
        thumbLoad(img, thumb);   // 老 CEP 也走并发队列，避免一次解码几十张大图
      }
    } else {
      img.style.visibility = "hidden";
    }

    card.querySelector(".card-menu").addEventListener("click", (e) => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      openCtx(r.right, r.bottom, it.id);
    });
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      openCtx(e.clientX, e.clientY, it.id);
    });

    if (isTrash) {
      // 回收站：只能还原 / 彻底删除，不能插入，也不参与拖拽归类
      card.querySelector(".card-restore").addEventListener("click", (e) => {
        e.stopPropagation();
        restoreItem(it.id);
      });
      card.addEventListener("click", (e) => {
        if (e.target.closest(".card-menu") || e.target.closest(".card-restore")) return;
        toast("回收站中的素材需先还原才能插入");
      });
      return card;
    }

    // 文件已删除：不可插入/不可拖拽，引导用户移出库
    if (missing) {
      card.addEventListener("click", (e) => {
        if (e.target.closest(".card-menu")) return;
        toast("素材文件已删除，右键「移出库」可清理这条记录", true);
      });
      return card;
    }

    // 置顶加星（右上角星星）：点亮后永远排最前
    const starEl = card.querySelector(".card-star");
    if (starEl) {
      starEl.addEventListener("click", (e) => {
        e.stopPropagation(); e.preventDefault();
        toggleStar(it);
      });
    }

    if (single) {
      // 单击直插（拖拽刚结束的那一下不算）
      card.addEventListener("click", (e) => {
        if (e.target.closest(".card-menu")) return;
        if (suppressClick) return;
        insertItem(it);
      });
    } else {
      card.addEventListener("dblclick", (e) => {
        if (e.target.closest(".card-menu") || e.target.closest(".card-name")) return;
        insertItem(it);
      });
      card.querySelector(".card-name").addEventListener("dblclick", (e) => {
        e.stopPropagation(); renameItem(it.id);
      });
    }

    card.addEventListener("dragstart", (e) => {
      dragItemId = it.id; dragHandled = false; suppressClick = true;
      card.classList.add("dragging");
      e.dataTransfer.setData("text/plain", it.id);
      e.dataTransfer.effectAllowed = "move";
      openCatMenu();          // 自动展开分类，方便直接拖过去归类
    });
    card.addEventListener("dragend", (e) => {
      card.classList.remove("dragging");
      // 清理拖拽排序的插入指示
      if (_dropHover) {
        const hd = grid.querySelector(".drop-before, .drop-after");
        if (hd) hd.classList.remove("drop-before", "drop-after");
        _dropHover = null;
      }
      if (!dragHandled) {
        const r = app.getBoundingClientRect();
        const outside = e.clientX < r.left || e.clientX > r.right ||
                        e.clientY < r.top || e.clientY > r.bottom;
        if (outside) insertItem(it);   // 拖出面板 = 插入画布
      }
      dragItemId = null;
      closeCatMenu();
      setTimeout(() => { suppressClick = false; }, 60);
    });
    return card;
  }

  /* ============================================================
     置顶加星 + 手动排序（拖拽换位置）
     ============================================================ */
  // 点亮/熄灭星星：立即置顶/取消置顶；持久化到 meta.json（随库走）+ 磁盘索引
  async function toggleStar(item) {
    item.starred = item.starred ? 0 : 1;
    saveState();
    scheduleIndexWrite();
    renderGrid(true);   // 立即重排（置顶立刻生效）；保持滚动视野
    if (MOCK || !hostReady || !item.file) return;
    try {
      await evalScript("PSL_SetStarred('" + esc(item.file) + "'," + (item.starred ? 1 : 0) + ")");
    } catch (e) { toast("加星写入失败：" + e.message, true); }
  }

  // 手动排序：把 itemId 移到 refId 之前/之后（按当前视图顺序），重写 order。
  // 拖拽后自动切到「手动」排序，位置立即生效
  function reorderItem(itemId, refId, before) {
    const v = computeSortedView();
    const view = v.items;
    const si = view.findIndex((x) => x.id === itemId);
    const ri = view.findIndex((x) => x.id === refId);
    if (si < 0 || ri < 0 || si === ri) return;
    const it = state.items.find((x) => x.id === itemId);
    if (!it) return;
    view.splice(si, 1);
    let ni = view.findIndex((x) => x.id === refId);
    if (ni < 0) ni = view.length;
    if (!before) ni += 1;
    view.splice(ni, 0, it);
    view.forEach((x, i) => { x.order = view.length - i; });   // 视觉第 1 位 order 最大
    if (settings.sortKey !== "manual") {
      settings.sortKey = "manual";
      saveSettings();
    }
    saveState();
    scheduleIndexWrite();
    renderGrid(true);   // 保持滚动位置，重排后视野不跳
  }

  // 分类拖拽排序（仅宽面板侧栏）：只调整 state.categories 顺序并持久化，
  // 磁盘文件夹不移动（分类顺序是面板级配置，随库状态一起保存）
  function reorderCategory(catId, refId, before) {
    const ci = state.categories.findIndex((x) => x.id === catId);
    const ri = state.categories.findIndex((x) => x.id === refId);
    if (ci < 0 || ri < 0 || ci === ri) return;
    const c = state.categories.splice(ci, 1)[0];
    let ni = state.categories.findIndex((x) => x.id === refId);
    if (ni < 0) ni = state.categories.length;
    if (!before) ni += 1;
    state.categories.splice(ni, 0, c);
    saveState();
    renderDropdown();
    scheduleIndexWrite();   // 分类顺序写进磁盘索引（随库走的排序真相）
  }

  // 相对素材库根目录的 "分类/文件名"（正斜杠），排序按库可移植匹配用
  function relKeyOf(filePath) {
    // 取路径最后两段（分类目录/文件名）：Windows(D:\库\分类\a.psd) 与 Mac(/库/分类/a.psd)
    // 提取出的 key 完全一致，跨平台/换机拷贝后排序也能对上；不依赖根路径前缀
    const segs = String(filePath || "").replace(/\\/g, "/").split("/").filter(Boolean);
    if (segs.length < 2) return "";
    return (segs[segs.length - 2] + "/" + segs[segs.length - 1]).toLowerCase();
  }

  // 路径是否位于当前素材根目录下（正斜杠+小写比较）：索引里的路径是写索引那台机器的
  // 绝对路径，换机/跨平台后必然失配 → 这类条目不能补全，交由增量扫描按磁盘真相重建
  function isUnderRoot(filePath) {
    const root = String(assetRoot() || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const p = String(filePath || "").replace(/\\/g, "/");
    return !!(root && p.toLowerCase().indexOf(root + "/") === 0);
  }

  // 应用索引 JSON 里的排序：分类顺序（cats）+ 素材手动排序（items[].order，相对路径匹配）。
  // 索引随库走：U盘拷贝/换机/远程同步后打开，排序与源端一致
  function applyOrderFromParsed(idx) {
    if (!idx || !idx.v) return false;
    let changed = false;
    // 分类顺序：文件里有的分类按索引顺序前置，索引外的（本地新建）保持原相对位置在后
    if (Array.isArray(idx.cats) && idx.cats.length) {
      const byDir = {};
      state.categories.forEach((c) => { byDir[(c.dir || safeDirName(c.name)).toLowerCase()] = c; });
      const ordered = [];
      idx.cats.forEach((d) => {
        const c = byDir[String(d).toLowerCase()];
        if (c) { ordered.push(c); delete byDir[String(d).toLowerCase()]; }
      });
      if (ordered.length) {
        const merged = ordered.concat(state.categories.filter((c) => ordered.indexOf(c) < 0));
        if (merged.length !== state.categories.length ||
            merged.some((c, i) => c !== state.categories[i])) {
          state.categories = merged;
          changed = true;
        }
      }
    }
    // 素材手动排序：按相对路径恢复 order（索引里没有的新素材保持 createdAt 兜底）
    if (Array.isArray(idx.items)) {
      const byRel = {};
      for (const e of idx.items) {
        if (!e || !e.file) continue;
        const rel = relKeyOf(e.file);
        if (rel && e.order) byRel[rel] = Number(e.order);
      }
      for (const it of state.items) {
        const rel = relKeyOf(it.file);
        if (!rel) continue;
        const v = byRel[rel];
        if (v !== undefined && v > 0 && it.order !== v) {
          it.order = v;
          changed = true;
        }
      }
    }
    return changed;
  }

  // 读本地磁盘索引并应用排序（本地库/切库/重建后的恢复路径）
  async function applyOrderFromIndex() {
    const idx = await readDiskIndex();
    if (!idx) return;
    if (applyOrderFromParsed(idx)) saveState();
  }

  // 按 file 路径合并一组素材条目（远程同步增量更新用）：已有覆盖字段，没有则新增
  function mergeItems(arr) {
    let changed = 0;
    const byId = new Map();
    for (const it of state.items) byId.set(it.id, it);
    for (const it of arr) {
      if (!it || !it.id) continue;
      const old = byId.get(it.id);
      if (old) {
        old.name = it.name; old.thumb = it.thumb; old.kind = it.kind;
        old.createdAt = it.createdAt; old.size = it.size;
        old.categoryId = it.categoryId; old.starred = it.starred;
        if (it.order) old.order = it.order;
        changed++;
      } else {
        state.items.push(it);
        byId.set(it.id, it);
        changed++;
      }
    }
    return changed;
  }

  // 网格级拖拽排序：卡片拖到另一张卡片上（上下半区）→ 换位置；
  // 拖出面板仍是插入画布（dragend 原逻辑）；搜索/回收站视图不允许手动排序
  let _dropHover = null;   // 当前高亮的插入目标卡片 id
  let catDragId = null;    // 侧栏分类拖拽中的分类 id（卡片拖拽仍走 dragItemId）
  let catDragHover = null; // 分类拖拽时当前高亮的插入目标行
  grid.addEventListener("dragover", (e) => {
    if (!dragItemId || searchTerm.trim()) return;
    const c = e.target && e.target.closest ? e.target.closest(".card") : null;
    if (!c || c.dataset.id === dragItemId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const r = c.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    if (_dropHover !== c.dataset.id) {
      if (_dropHover) {
        const old = grid.querySelector('.card[data-id="' + _dropHover + '"]');
        if (old) old.classList.remove("drop-before", "drop-after");
      }
      _dropHover = c.dataset.id;
    }
    c.classList.remove("drop-before", "drop-after");
    c.classList.add(before ? "drop-before" : "drop-after");
  });
  grid.addEventListener("dragleave", (e) => {
    const c = e.target && e.target.closest ? e.target.closest(".card") : null;
    if (c) c.classList.remove("drop-before", "drop-after");
  });
  grid.addEventListener("drop", (e) => {
    if (!dragItemId) return;
    const c = e.target && e.target.closest ? e.target.closest(".card") : null;
    _dropHover = null;
    if (!c || c.dataset.id === dragItemId) return;   // 没落到其它卡上 → 走原逻辑（拖出面板=插入）
    e.preventDefault(); e.stopPropagation();
    dragHandled = true;                              // 阻止 dragend 触发"拖出=插入画布"
    const r = c.getBoundingClientRect();
    reorderItem(dragItemId, c.dataset.id, e.clientY < r.top + r.height / 2);
  });

  // 图层类型角标定义（提到循环外，避免每张卡片都重建一遍对象）
  const BADGES = {
    text:       ["b-text", "文", "文字图层（插入后仍是可编辑文字）"],
    adjustment: ["b-adj",  "调", "调整图层（插入后仍可改参数）"],
    group:      ["b-grp",  "组", "图层组（含全部子图层）"],
    smart:      ["b-smt",  "智", "智能对象（插入后仍可无损缩放）"],
    shape:      ["b-shp",  "形", "形状／填充图层（插入后仍是矢量）"]
  };

  // 批量校验当前视图素材磁盘存在性；缺失的标灰并提示，可移出库
  async function verifyView() {
    if (MOCK || !hostReady) return;
    if (filterCat === "") return;   // 欢迎界面：无需校验
    const token = ++_verifyToken;
    const isTrash = filterCat === TRASH_VIEW;
    let src = isTrash ? state.trash.slice() : state.items.slice();
    if (!isTrash) {
      src = src.filter((i) => i.categoryId === filterCat);
    }
    const checkable = src.filter((it) => it.file || it.thumb);
    if (!checkable.length) { missingIds.clear(); return; }

    // 分片校验：素材多时一次性传几千个路径，PS 主线程要长时间 stat 全库，
    // 打开面板/切分类会明显卡顿；每批 60 个 + 让出 30ms，PS 与面板都保持可响应
    const flags = new Array(checkable.length).fill("1");
    for (let k = 0; k < checkable.length; k += 60) {
      const chunk = checkable.slice(k, k + 60);
      const spec = chunk.map((it) => it.id + "::" + (it.file || it.thumb)).join("|");
      let res;
      try { res = await evalScript("PSL_CheckFiles('" + esc(spec) + "')"); }
      catch (e) { return; }   // 中途失败放弃本轮，下轮 renderGrid 再校验
      if (token !== _verifyToken) return;   // 视图已切换，丢弃过期结果
      const fl = payload(res).split("|");
      for (let j = 0; j < fl.length && k + j < checkable.length; j++) flags[k + j] = fl[j];
      await new Promise((rs) => setTimeout(rs, 30));
    }
    const newMissing = new Set();
    let changed = false;
    checkable.forEach((it, i) => {
      const ok = flags[i] === "1";
      if (!ok) newMissing.add(it.id);
      if (ok !== !missingIds.has(it.id)) changed = true;  // 状态与上次不同
    });
    missingIds.clear();
    newMissing.forEach((id) => missingIds.add(id));
    if (changed) renderGrid();
  }

  /* ============================================================
     磁盘索引缓存（.mu_index.json，位于素材根目录，随库走）
     图牛式秒开的底气：打开面板/切库时一次桥接读回全量索引直接渲染，
     不用等全量枚举；磁盘文件仍是唯一真相，后台增量扫描持续校正。
     索引随素材库文件夹走，换机/重装/拷库后也能秒恢复。
     ============================================================ */
  let _indexWriteTimer = null;

  function buildIndexPayload() {
    const one = (it) => ({
      id: it.id, file: it.file, thumb: it.thumb, cat: it.categoryId,
      name: it.name, kind: it.kind || "", size: it.size || 0,
      createdAt: it.createdAt || 0, order: it.order || 0,
      star: it.starred ? 1 : 0,
      fp: scanIndex[it.file] || 0    // 指纹（mtime:size）：远程同步/重建索引对比用，相同即跳过
    });
    const tOne = (t) => ({
      id: t.id, file: t.file, thumb: t.thumb, cat: t.fromCatId,
      name: t.name, kind: t.kind || "", size: t.size || 0,
      createdAt: t.createdAt || 0, deletedAt: t.deletedAt || 0,
      order: t.order || 0, star: t.starred ? 1 : 0,
      fp: scanIndex[t.file] || 0
    });
    return JSON.stringify({
      v: 1, ts: Date.now(),
      cats: state.categories.map((c) => c.dir || safeDirName(c.name)),   // 分类顺序（随库走的排序真相）
      items: state.items.map(one),
      trash: state.trash.map(tOne)
    });
  }

  // 节流写盘：所有素材增删改点调用；失败静默（索引只是加速缓存，磁盘才是真相）
  function scheduleIndexWrite() {
    if (MOCK || !hostReady || !settings.assetDir) return;
    clearTimeout(_indexWriteTimer);
    _indexWriteTimer = setTimeout(async () => {
      try {
        const r = await evalScript(
          "PSL_WriteIndex('" + esc(settings.assetDir) + "','" + esc(buildIndexPayload()) + "')"
        );
        if (String(r).indexOf("OK:") !== 0) console.warn("[MuMu助手] 磁盘索引写盘失败:", String(r));
      } catch (e) { /* 索引写失败不影响主流程 */ }
    }, 800);
  }

  // 读回磁盘索引；不存在/损坏返回 null
  async function readDiskIndex() {
    if (MOCK || !hostReady || !settings.assetDir) return null;
    try {
      const r = await evalScript("PSL_ReadIndex('" + esc(settings.assetDir) + "')");
      const s = payload(r);
      if (!s || String(s).indexOf("ERR:") === 0) return null;
      return JSON.parse(s);
    } catch (e) { return null; }
  }

  // 磁盘索引快速对齐：把索引里本地 state 没有的条目补进来（只增不减）。
  // 删除/修改类差异由后台增量扫描结算（磁盘即真相），这里只管"补全"。
  // 返回补入的条数；索引缺失时返回 0（调用方继续走原流程）
  async function alignFromDiskIndex() {
    const idx = await readDiskIndex();
    if (!idx || !Array.isArray(idx.items)) return 0;
    const exist = new Set(state.items.map((it) => it.id));
    const news = [];
    for (const e of idx.items) {
      if (!e || !e.id || exist.has(e.id)) continue;
      // 索引路径是写索引机器的绝对路径：换机/跨平台后必然失配，不能补全（否则出现
      // 点不开的幽灵素材），统一交给增量扫描按磁盘真相重建
      if (!isUnderRoot(e.file)) continue;
      const catOk = state.categories.some((c) => c.id === e.cat);
      news.push({
        id: e.id, name: e.name || "未命名",
        categoryId: catOk ? e.cat : "uncat",
        file: e.file, thumb: e.thumb, kind: e.kind || undefined,
        starred: e.star ? 1 : 0,
        order: e.order || e.createdAt || Date.now(),
        createdAt: e.createdAt || 0, size: e.size || 0
      });
      exist.add(e.id);
    }
    const tExist = new Set(state.trash.map((it) => it.id));
    const tNews = [];
    for (const t of (idx.trash || [])) {
      if (!t || !t.id || tExist.has(t.id)) continue;
      if (!isUnderRoot(t.file)) continue;   // 同 items：换机/跨平台的旧路径条目不补全
      tNews.push({
        id: t.id, name: t.name || "未命名",
        fromCatId: t.fromCatId, fromCatName: "",
        file: t.file, thumb: t.thumb, kind: t.kind || undefined,
        starred: t.star ? 1 : 0,
        order: t.order || t.createdAt || Date.now(),
        createdAt: t.createdAt || 0, size: t.size || 0, deletedAt: t.deletedAt || 0
      });
      tExist.add(t.id);
    }
    const n = news.length + tNews.length;
    if (n > 0) {
      state.items = state.items.concat(news);
      state.trash = state.trash.concat(tNews);
      saveState();
    }
    return n;
  }

  // 切库专用：用新库磁盘索引整体替换 state（旧库状态全部作废原则），秒渲染。
  // 返回替换的素材数；新库没有索引/索引损坏返回 -1（调用方回退全量枚举）
  async function quickAlignNewLibrary() {
    const idx = await readDiskIndex();
    if (!idx || !Array.isArray(idx.items)) return -1;
    const items = [];
    for (const e of idx.items) {
      if (!e || !e.id) continue;
      // 切库后索引里的路径可能来自另一台机器/另一个盘符（如 Windows 写的库拷到 Mac），
      // 路径已失配 → 不补全，交给切库后的后台增量扫描按磁盘真相重建
      if (!isUnderRoot(e.file)) continue;
      // ⚠ 切库后分类 id 是重新生成的（c+时间戳），索引里的旧 cat id 必然失配；
      //   直接落 uncat 会把整个库的素材全变“未分类” → 按文件所在文件夹名反查分类
      //   （文件夹已在 syncCategoryFolders 阶段同步成面板分类）
      let catId = "uncat";
      const catOk = state.categories.some((c) => c.id === e.cat);
      if (catOk) {
        catId = e.cat;
      } else if (e.file) {
        const p = String(e.file).replace(/\\/g, "/");
        const dir = p.slice(0, p.lastIndexOf("/"));
        const dirName = dir.slice(dir.lastIndexOf("/") + 1);
        if (dirName) {
          const cat = state.categories.find((c) => c.dir && c.dir.toLowerCase() === dirName.toLowerCase()) ||
                      state.categories.find((c) => c.name && c.name.toLowerCase() === dirName.toLowerCase());
          if (cat) catId = cat.id;
        }
      }
      items.push({
        id: e.id, name: e.name || "未命名",
        categoryId: catId,
        file: e.file, thumb: e.thumb, kind: e.kind || undefined,
        starred: e.star ? 1 : 0,
        order: e.order || e.createdAt || Date.now(),
        createdAt: e.createdAt || 0, size: e.size || 0
      });
    }
    const trash = [];
    for (const t of (idx.trash || [])) {
      if (!t || !t.id) continue;
      if (!isUnderRoot(t.file)) continue;   // 同 items：跨机器/盘符的旧路径条目不补全
      trash.push({
        id: t.id, name: t.name || "未命名",
        fromCatId: t.fromCatId, fromCatName: "",
        file: t.file, thumb: t.thumb, kind: t.kind || undefined,
        starred: t.star ? 1 : 0,
        order: t.order || t.createdAt || Date.now(),
        createdAt: t.createdAt || 0, size: t.size || 0, deletedAt: t.deletedAt || 0
      });
    }
    state.items = items;
    state.trash = trash;
    allScanned = true;
    scannedCats.clear();
    state.categories.forEach((c) => scannedCats.add(c.id));
    saveState();
    renderAll();
    // 后台静默校正：索引只是加速缓存，磁盘仍是真相（外部增删改都会被修正）
    if (!MOCK && hostReady) runBackgroundSync({ silent: true });
    console.log("[MuMu助手] 切库秒渲染（磁盘索引）: 素材=" + items.length + " 回收站=" + trash.length);
    return items.length;
  }

  /* ============================================================
     外部文件拖放（资源管理器 → 面板）
     ============================================================ */
  function showDropzone() {
    const c = catOf(targetCategory());
    const name = c ? c.name : DEFAULT_CAT_NAME;
    dzCat.textContent = "将加入分类：" + name + "（存入文件夹 " + catDirOf(targetCategory()) + "）";
    dropzone.hidden = false;
  }
  function hideDropzone() { dropzone.hidden = true; dragDepth = 0; }

  content.addEventListener("dragenter", (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth++;
    showDropzone();
  });
  content.addEventListener("dragover", (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  content.addEventListener("dragleave", (e) => {
    if (!isFileDrag(e)) return;
    dragDepth--;
    if (dragDepth <= 0) hideDropzone();
  });
  content.addEventListener("drop", (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); e.stopPropagation();
    hideDropzone();
    importDroppedFiles(e);
  });
  // 兜底：别让文件落到面板其他地方时被 CEF 当成"打开网页"
  ["dragover", "drop"].forEach((t) => {
    document.addEventListener(t, (e) => {
      if (isFileDrag(e) && !content.contains(e.target)) { e.preventDefault(); hideDropzone(); }
    });
  });

  /* ============================================================
     右键菜单（插入 / 重命名 / 移动到 / 删除）
     ============================================================ */
  function openCtx(x, y, itemId) {
    ctxItemId = itemId;
    const isTrash = filterCat === TRASH_VIEW;
    const missing = !isTrash && missingIds.has(itemId);

    // 三组菜单项按状态切换：trash / missing / normal
    ctxMenu.querySelectorAll("[data-grp]").forEach((el) => {
      const g = el.dataset.grp;
      el.hidden = g === "trash" ? !isTrash
                : g === "missing" ? !missing
                : (isTrash || missing);   // normal 组：非回收站且非缺失才显示
    });

    ctxMoveSub.innerHTML = "";
    if (!isTrash) {
      const add = (id, name) => {
        const d = document.createElement("div");
        d.className = "ctx-item"; d.textContent = name; d.dataset.cat = id;
        ctxMoveSub.appendChild(d);
      };
      // 默认分类已固定排在首位，直接按顺序列出
      state.categories.forEach((c) => add(c.id, c.name));
    }

    ctxMenu.hidden = false;
    const w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
    let px = x, py = y;
    if (px + w > window.innerWidth - 8) px = Math.max(4, window.innerWidth - 8 - w);
    if (py + h > window.innerHeight - 8) py = Math.max(4, window.innerHeight - 8 - h);
    ctxMenu.style.left = px + "px";
    ctxMenu.style.top = py + "px";
  }
  function closeCtx() { ctxMenu.hidden = true; ctxItemId = null; }

  ctxMenu.addEventListener("click", (e) => {
    const sub = e.target.closest("#ctxMoveSub .ctx-item");
    if (sub) {
      const id = sub.dataset.cat;
      const target = ctxItemId;
      closeCtx();
      if (target) moveItemToCategory(target, id);
      return;
    }
    const item = e.target.closest(".ctx-item");
    if (!item || item.classList.contains("ctx-sub")) return;
    const act = item.dataset.act;
    const id = ctxItemId;
    closeCtx();
    if (!id) return;
    if (act === "insert") insertItem(state.items.find((i) => i.id === id));
    else if (act === "rename") renameItem(id);
    else if (act === "delete") deleteItem(id);
    else if (act === "restore") restoreItem(id);
    else if (act === "purge") purgeItem(id);
    else if (act === "remove") removeMissing(id);
  });

  /* ============================================================
     业务动作
     ============================================================ */
  // 把素材的 psd 原件 + png 缩略图物理搬到目标文件夹；返回是否成功
  // PSL_MoveAsset 返回 "新路径:::新指纹"：同步更新 scanIndex，
  // 避免后台增量扫描把旧路径报为删除、新路径报为新增（导致条目丢失/重建）
  async function moveItemFiles(it, destDir) {
    if (MOCK || !hostReady || !destDir) return true;
    let ok = true;
    const moveOne = async (p) => {
      const pl = payload(await evalScript(
        "PSL_MoveAsset('" + esc(p) + "','" + esc(destDir) + "')"
      ));
      const seg = String(pl || "").split(":::");
      const np = seg[0];
      if (!np) throw new Error("move failed");
      // 扫描索引只跟踪 .psd 主文件（缩略图不进索引，避免污染增量扫描）
      if (/\.psd$/i.test(p)) {
        delete scanIndex[p];             // 旧路径从索引移除
        if (seg[1]) scanIndex[np] = seg[1];  // 新路径带新指纹，下次同步零变更
      }
      return np;
    };
    if (it.file) {
      try { it.file = await moveOne(it.file); } catch (e) { ok = false; }
    }
    if (it.thumb) {
      try { it.thumb = await moveOne(it.thumb); } catch (e) { /* 缩略图丢了不影响主文件 */ }
    }
    delete it._thumb;
    // id 就是文件路径：搬移后必须跟随，否则同步后旧 id 会被当"已删除"清掉
    if (it.file) it.id = it.file;
    return ok;
  }

  // 换分类 = 文件真的换文件夹
  async function moveItemToCategory(itemId, catId) {
    const it = state.items.find((i) => i.id === itemId);
    if (!it || it.categoryId === catId) return;
    const c = state.categories.find((x) => x.id === catId);

    if (!MOCK && hostReady && it.file) {
      const ok = await moveItemFiles(it, catPath(catId));
      if (!ok) { toast("分类已改，但文件搬运失败（原文件可能已丢失）", true); return; }
    }
    // 立即更新本地分类（meta.json 随文件一起搬，后台同步只做校正）
    it.categoryId = catId;
    missingIds.delete(itemId);
    saveState();
    scheduleIndexWrite();
    renderAll();
    toast("已移动到「" + (c ? c.name : DEFAULT_CAT_NAME) + "」");

    if (!MOCK && hostReady) runBackgroundSync({ silent: true });
  }
  async function renameItem(itemId) {
    const it = state.items.find((i) => i.id === itemId);
    if (!it) return;
    const name = await askText("重命名图层", it.name);
    if (name && name.trim()) {
      it.name = name.trim();
      // 同步 meta.json.name 字段，拷贝素材库后改名也跟着走
      if (!MOCK && hostReady && it.file) {
        try {
          await evalScript("PSL_WriteMeta('" + esc(it.file) + "','" + esc(it.kind || "") + "','" + esc(name.trim()) + "')");
        } catch (e) { console.error("[MuMu助手] 写 meta 失败:", e); }
      }
      scheduleIndexWrite();   // 重命名也刷新磁盘索引（name 变了）
      renderAll();
    }
  }
  // 新建分类 → 同时在素材根目录下创建同名文件夹
  async function newCategory() {
    const name = await askText("新建分类", "");
    const nm = (name || "").trim();
    if (!nm) return;
    if (state.categories.some((c) => c.name === nm)) { toast("已存在同名分类", true); return; }
    if (safeDirName(nm).toLowerCase() === TRASH_DIR.toLowerCase()) {
      toast("「" + TRASH_DIR + "」是回收站的保留名称，请换一个", true); return;
    }

    // 文件夹名冲突时自动加后缀
    const taken = {};
    taken[TRASH_DIR.toLowerCase()] = 1;   // 不能占用回收站文件夹
    state.categories.forEach((c) => { if (c.dir) taken[c.dir.toLowerCase()] = 1; });
    let base = safeDirName(nm), dir = base, n = 2;
    while (taken[dir.toLowerCase()]) { dir = base + "_" + n; n++; }

    if (!MOCK && hostReady) {
      try {
        dir = payload(await evalScript(
          "PSL_MakeCatDir('" + esc(assetRoot()) + "','" + esc(dir) + "')"
        ));
      } catch (e) { toast("新建分类失败：" + e.message, true); return; }
    }

    const newId = "c" + Date.now().toString(36);
    state.categories.push({ id: newId, name: nm, dir: dir, color: pickColor() });
    saveState();
    // 自动切到新建的分类（从欢迎界面进来时尤其重要，否则会停在欢迎界面）
    setFilter(newId);
    toast("已新建分类「" + nm + "」，文件夹已同步创建");
  }

  // 重命名分类 → 文件夹同步改名，并改写该分类下所有素材的路径
  async function renameCategory(catId) {
    const c = state.categories.find((x) => x.id === catId);
    if (!c) return;
    if (isDefaultCat(c)) { toast("默认分类不可重命名", true); return; }

    const name = await askText("重命名分类", c.name);
    const nm = (name || "").trim();
    if (!nm || nm === c.name) return;
    if (state.categories.some((x) => x.id !== catId && x.name === nm)) {
      toast("已存在同名分类", true); return;
    }
    if (safeDirName(nm).toLowerCase() === TRASH_DIR.toLowerCase()) {
      toast("「" + TRASH_DIR + "」是回收站的保留名称，请换一个", true); return;
    }

    const oldDir = c.dir || safeDirName(c.name);
    let newDir = safeDirName(nm);

    if (!MOCK && hostReady) {
      try {
        newDir = payload(await evalScript(
          "PSL_RenameCatDir('" + esc(assetRoot()) + "','" + esc(oldDir) + "','" + esc(newDir) + "')"
        ));
      } catch (e) { toast("重命名失败：" + e.message, true); return; }

      const from = assetRoot() + "/" + oldDir;
      const to = assetRoot() + "/" + newDir;
      state.items.forEach((it) => {
        if (it.file) it.file = repath(it.file, from, to);
        if (it.thumb) it.thumb = repath(it.thumb, from, to);
      });
    }

    c.name = nm; c.dir = newDir;
    saveState(); renderAll();
    toast("已重命名为「" + nm + "」，文件夹同步改名");
  }

  // 删除分类 → 分类下有素材时拒绝；空分类则连同文件夹一起删掉
  async function deleteCategory(catId) {
    const c = state.categories.find((x) => x.id === catId);
    if (!c) return;
    if (isDefaultCat(c)) { toast("默认分类不可删除", true); return; }

    const n = state.items.filter((i) => i.categoryId === catId).length;
    if (n > 0) {
      toast("「" + c.name + "」下还有 " + n + " 个素材，请先移走或删除后再删分类", true);
      return;
    }

    if (!MOCK && hostReady) {
      try {
        await evalScript(
          "PSL_RemoveCatDir('" + esc(assetRoot()) + "','" + esc(c.dir || safeDirName(c.name)) + "')"
        );
      } catch (e) {
        const m = String(e.message || "");
        if (m.indexOf("BUSY:") === 0) {
          toast("文件夹里还有 " + m.slice(5) + " 个文件（面板外放进去的），请先清空文件夹", true);
        } else {
          toast("删除失败：" + m, true);
        }
        return;
      }
    }

    state.categories = state.categories.filter((x) => x.id !== catId);
    // 删的正好是当前分类：切到默认分类（始终存在），避免落到欢迎界面打断操作
    if (filterCat === catId) setFilter("uncat");
    saveState(); renderAll();
    toast("已删除分类「" + c.name + "」及其文件夹");
  }

  /* ---------- 启动时的目录同步 ---------- */

  // 1) 每个分类在磁盘上都得有文件夹（用户可能手动删过）
  // 2) 反向：磁盘上手动新建的文件夹，自动同步成面板里的分类
  async function syncCategoryFolders(ignoreLimit) {
    if (MOCK || !hostReady || !assetRoot()) return;

    for (const c of state.categories) {
      try {
        const d = payload(await evalScript(
          "PSL_MakeCatDir('" + esc(assetRoot()) + "','" + esc(c.dir || safeDirName(c.name)) + "')"
        ));
        if (d) c.dir = d;
      } catch (e) { /* 单个失败不阻断启动 */ }
    }

    try {
      const list = payload(await evalScript("PSL_ListCatDirs('" + esc(assetRoot()) + "')"));
      const known = {};
      // 每个分类都计入已知：目录名缺失时用名字兼容（避免 MakeCatDir 调用失败时
      // 磁盘文件夹被当"陌生文件夹"再建一个同名分类 → 分类重复的根因）
      state.categories.forEach((c) => { known[(c.dir || safeDirName(c.name)).toLowerCase()] = 1; });

      // 回收站是保留文件夹，绝不能被同步成分类（宿主侧已过滤，这里再兜一层）
      const dirs = list.split("|")
        .filter((d) => String(d || "").trim())
        .filter((d) => String(d).trim().toLowerCase() !== TRASH_DIR.toLowerCase());
      const unknown = dirs.filter((d) => !known[String(d).trim().toLowerCase()]);
      // 保护：万一保存位置被指到了一个塞满文件夹的目录，别把它们全变成分类
      // 远程素材库同步时传 ignoreLimit=true：用户主动配置的远程库分类多属正常情况
      if (!ignoreLimit && unknown.length > 40) {
        console.warn("[MuMu助手] 素材根目录下有 " + unknown.length + " 个陌生文件夹，已跳过自动同步");
        saveState(); renderAll();
        return;
      }

      let added = 0;
      dirs.forEach((raw) => {
        const nm = String(raw || "").trim();
        if (!nm || known[nm.toLowerCase()]) return;
        // 名称兜底：已有同名分类（dir 失配的旧数据）就认领该文件夹，不再新建
        const dup = state.categories.find((c) => c.name && c.name.toLowerCase() === nm.toLowerCase());
        if (dup) { dup.dir = nm; known[nm.toLowerCase()] = 1; return; }
        state.categories.push({
          id: "c" + Date.now().toString(36) + added,
          name: nm, dir: nm, color: pickColor()
        });
        known[nm.toLowerCase()] = 1;
        added++;
      });
      if (added) toast("已从素材文件夹同步 " + added + " 个分类");
    } catch (e) { /* 列目录失败就跳过反向同步 */ }

    // 排序随库走：磁盘索引里有排序（cats/items[].order）就按其恢复分类顺序
    try { await applyOrderFromIndex(); } catch (e) { console.warn("[MuMu助手] 应用索引排序失败:", e); }

    saveState(); renderAll();
  }

  // 老版本的素材直接躺在根目录，按所属分类归位到子文件夹（只跑一次）
  async function relocateStrays() {
    if (MOCK || !hostReady || !assetRoot()) return;
    const root = assetRoot().toLowerCase();
    const strays = state.items.filter((it) => {
      const p = String(it.file || "").replace(/\\/g, "/");
      if (!p) return false;
      const dir = p.slice(0, p.lastIndexOf("/")).toLowerCase();
      return dir === root;
    });
    if (!strays.length) return;

    for (const it of strays) await moveItemFiles(it, catPath(it.categoryId));
    saveState(); renderGrid();
    toast("已把 " + strays.length + " 个旧素材归入分类文件夹");
  }

  // 解析一条 scan 输出行（cat:::psd:::png:::kind:::name:::createdAt:::size[:::fp]）为 item 对象
  // 旧版 7 段兼容；新版 8 段末尾是 fp
  function parseScanLine(line, opts) {
    opts = opts || {};
    const p = line.split(":::");
    if (p.length < 3) return null;
    const catName = p[0];
    const file = p[1];
    const thumb = p[2];
    const kind = p[3] || "";
    const name = p[4] || "";
    const createdAt = p[5] ? Number(p[5]) : undefined;
    const size = p[6] ? Number(p[6]) : 0;                // 文件字节数（用于大小排序）
    const fp = p[7] || undefined;                         // mtime:size 指纹（增量扫描用）
    // 优先按目录名归类（扫描行的 catName 就是磁盘文件夹名）；
    // 旧数据兼容才回退按分类显示名匹配，避免把素材挂到同名但不同文件夹的分类上
    let cat = state.categories.find((c) =>
      c.dir && c.dir.toLowerCase() === catName.toLowerCase()
    );
    if (!cat) {
      cat = state.categories.find((c) =>
        c.name && c.name.toLowerCase() === catName.toLowerCase()
      );
    }
    const catId = cat ? cat.id : "uncat";
    // 显示名：trash 用 basename；普通素材优先用 meta.name，否则 basename
    let displayName;
    if (opts.trash) {
      displayName = name || file.split(/[\\\/]/).pop().replace(/\.psd$/i, "");
    } else {
      const base = file.split(/[\\\/]/).pop().replace(/\.psd$/i, "");
      displayName = name || base;
    }
    return {
      id: file,                                          // 用文件路径作 id（唯一、稳定、可移植）
      name: displayName,
      categoryId: catId,
      file: file,
      thumb: thumb || undefined,
      kind: kind || undefined,                           // 空字符串→undefined（无角标）
      starred: (p[8] === "1" ? 1 : 0),                  // 置顶加星（meta.json 的 star 字段）
      createdAt: createdAt || Date.now(),
      size: size,
      _fp: fp                                             // mtime:size 指纹（增量扫描用，不显示）
    };
  }

  /* ============================================================
     增量扫描 / 按需扫描
     - 启动时：秒开（用 localStorage 缓存的 state 立即渲染）→ 后台异步增量
     - 切分类：未扫过的分类走 PSL_ScanCategory 单扫（毫秒级）
     ============================================================ */

  // 把 scanIndex 序列化为 "path\tfp\n..." 字符串，传给 hostscript
  function serializeScanIndex(idx) {
    const lines = [];
    for (const p in idx) lines.push(p + "\t" + idx[p]);
    return lines.join("\n");
  }

  function loadScanIndex() {
    let idx = {};
    try {
      const raw = localStorage.getItem(SCAN_INDEX_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === "object") idx = obj;
      }
    } catch (e) { idx = {}; }
    // ⚠ 脚本版本升级（插件更新/重新部署后）：旧索引可能来自旧版扫描链路
    //   （如异步复制时代留下的缺口、脏指纹），直接清空 → 启动的后台增量扫描
    //   自动退化为全量重建，磁盘上所有素材必然重新入库（upsert 保留加星/手动排序）
    const prevV = Number(localStorage.getItem("psl.lastScriptVersion") || 0);
    if (prevV !== REQUIRED_SCRIPT_VERSION) {
      console.log("[MuMu助手] 脚本版本 " + prevV + " → " + REQUIRED_SCRIPT_VERSION + "，清空索引，启动后自动全量重建");
      idx = {};
      try { localStorage.setItem(SCAN_INDEX_KEY, "{}"); } catch (e) {}
      localStorage.setItem("psl.lastScriptVersion", String(REQUIRED_SCRIPT_VERSION));
    }
    return idx;
  }
  function saveScanIndex() {
    try { localStorage.setItem(SCAN_INDEX_KEY, JSON.stringify(scanIndex)); } catch (e) {}
  }

  // 解析 "OK:added|...||modified|...||deleted|..." 三段
  function parseDelta(raw) {
    const empty = { added: [], modified: [], deleted: [] };
    if (!raw || raw.indexOf("ERR:") === 0 || raw.indexOf("OK:") !== 0) return empty;
    const body = raw.substring(3);
    const parts = body.split("||");
    const splitLines = (s) => (s && s.length) ? s.split("|").filter((x) => x.length) : [];
    return {
      added:    splitLines(parts[0] || ""),
      modified: splitLines(parts[1] || ""),
      deleted:  splitLines(parts[2] || "")
    };
  }

  // 把增量结果应用到 state.items（普通素材）
  // 注意：line 里 catName 还是 "未分类/xxx" 这样的文件夹名，需要按 catName → catId 映射
  function applyItemsDelta(delta) {
    const byId = new Map();
    for (const it of state.items) byId.set(it.id, it);
    let changed = 0;
    // 删
    if (delta.deleted.length) {
      const dels = new Set(delta.deleted);
      const before = state.items.length;
      state.items = state.items.filter((it) => !dels.has(it.id));
      changed += before - state.items.length;
      for (const p of dels) delete scanIndex[p];
    }
    // 改/增（合并到同一逻辑：按 file 路径覆盖/新建）
    const upserts = delta.modified.concat(delta.added);
    for (const line of upserts) {
      const it = parseScanLine(line, { trash: false });
      if (!it) continue;
      scanIndex[it.file] = it._fp;
      delete it._fp;
      if (byId.has(it.id)) {
        // 修改：保留 id，update 字段（手动排序 order/加星 starred 保留本地值）
        const old = byId.get(it.id);
        old.name = it.name; old.thumb = it.thumb; old.kind = it.kind;
        old.createdAt = it.createdAt; old.size = it.size;
        old.categoryId = it.categoryId;
        old.starred = it.starred;                        // 磁盘 meta 是加星真相，同步回填
        if (!old.order) old.order = it.createdAt || Date.now();
        changed++;
      } else {
        state.items.push(it);
        byId.set(it.id, it);
        changed++;
      }
    }
    return changed;
  }

  function applyTrashDelta(delta) {
    const byId = new Map();
    for (const it of state.trash) byId.set(it.id, it);
    let changed = 0;
    if (delta.deleted.length) {
      const dels = new Set(delta.deleted);
      const before = state.trash.length;
      state.trash = state.trash.filter((it) => !dels.has(it.id));
      changed += before - state.trash.length;
      for (const p of dels) delete scanIndex[p];
    }
    // trash 行格式：cat(=="_TRASH_"):::psd:::png:::kind:::name:::createdAt:::size:::fp
    // parseScanLine 会把 p[0] 当 catName（找不到则 fallback uncat），但 id 用 file 绝对路径绝对唯一
    const upserts = delta.modified.concat(delta.added);
    for (const line of upserts) {
      const it = parseScanLine(line, { trash: true });
      if (!it) continue;
      scanIndex[it.file] = it._fp;
      delete it._fp;
      it.deletedAt = it.createdAt;
      it.fromCatName = "";
      if (byId.has(it.id)) {
        const old = byId.get(it.id);
        old.name = it.name; old.thumb = it.thumb; old.kind = it.kind;
        old.size = it.size;
        old.starred = it.starred;
        changed++;
      } else {
        state.trash.push(it);
        byId.set(it.id, it);
        changed++;
      }
    }
    return changed;
  }

  /* ============================================================
     分片增量同步（性能修复核心）
     ExtendScript 跑在 Photoshop 主线程上：一次性扫全库 + 逐个读 meta.json，
     素材多时会把 PS 锁死数十秒（"同步中…"卡死 PS 的根因）。
     现改为 Begin + 多次 Step：每个 Step 只处理一小批文件（约几十毫秒），
     面板在分片之间让出片刻 → 同步期间 PS 与面板都保持可响应。
     ============================================================ */
  const SCAN_BUDGET = 60;   // 每个分片最多处理的文件条目数
  const SCAN_GAP_MS = 30;   // 分片之间的让出时间（毫秒）
  let _syncRunning = false; // 是否有同步在跑
  let _syncPending = null;  // 运行中又收到同步请求 → 结束时补跑一次（合并，避免叠加大扫描）
  let _syncSeq = 0;         // 同步序号：递增即可让在途分片循环作废（可中断）
  let _rescueInFlight = false;  // 简单枚举救回是否在进行中（防叠加）
  let _rebuildRunning = false;  // 全量重建（simpleRebuildAssets）是否进行中：兜底救回需跳过，避免互踩作废
  let _rebuildFailCats = 0;     // 最近一次全量重建中枚举失败的分类数（>0 时同步收尾要提示）
  let _syncPillEl = null;
  function setSyncPill(text) {
    if (!_syncPillEl) _syncPillEl = document.getElementById("syncPill");
    if (!_syncPillEl) return;
    if (text) { _syncPillEl.textContent = text; _syncPillEl.hidden = false; }
    else      { _syncPillEl.hidden = true; }
  }

  // 解析一个分片的返回："added|...||modified|...||deleted|...||MORE/DONE"
  function _parseSliceDelta(body) {
    const parts = String(body || "").split("||");
    const lines = (s) => (s && s.length) ? s.split("|").filter((x) => x.length) : [];
    return {
      delta: { added: lines(parts[0] || ""), modified: lines(parts[1] || ""), deleted: lines(parts[2] || "") },
      done: (parts[3] === "DONE")
    };
  }

  // 跑一轮分片扫描（mode = "assets" | "trash"），合并所有分片 delta 后一次返回
  // idxStr：完整索引串；传 "__REUSE__" 复用宿主侧上次解析结果（免重发超大字符串）
  // seq 不等于当前 _syncSeq 时返回 null（被更新的扫描作废，如切换素材目录）
  async function _runSliceScan(mode, seq, idxStr) {
    const b0 = payload(await evalScript(
      "PSL_ScanBegin('" + esc(settings.assetDir) + "','" + esc(idxStr) + "','" + mode + "')"
    ));
    if (!b0 || String(b0).indexOf("ERR:") === 0) throw new Error(String(b0 || "ScanBegin 失败"));
    if (seq !== _syncSeq) return null;
    const acc = { added: [], modified: [], deleted: [] };
    for (;;) {
      if (seq !== _syncSeq) return null;
      const raw = payload(await evalScript("PSL_ScanStep(" + SCAN_BUDGET + ")"));
      if (seq !== _syncSeq) return null;
      if (!raw || String(raw).indexOf("ERR:") === 0) throw new Error(String(raw || "ScanStep 失败"));
      const r = _parseSliceDelta(raw);
      acc.added = acc.added.concat(r.delta.added);
      acc.modified = acc.modified.concat(r.delta.modified);
      acc.deleted = acc.deleted.concat(r.delta.deleted);
      if (r.done) break;
      await new Promise((rs) => setTimeout(rs, SCAN_GAP_MS));   // 让出：给 PS/UI 喘口气
    }
    return acc;
  }

  // 后台异步同步（分片执行，不卡 PS；运行中重复调用会自动合并为一次补跑）
  async function runBackgroundSync(opts) {
    opts = opts || {};
    if (MOCK || !hostReady || !settings.assetDir) return;
    if (_syncRunning) { _syncPending = opts; return; }   // 合并：结束后再补一轮
    _syncRunning = true;
    const seq = ++_syncSeq;
    if (!opts.silent) setSyncPill("同步中…");
    try {
      const idxStr = serializeScanIndex(scanIndex);
      // 1) 全量素材增量扫描（分片，不锁 PS）
      const d1 = await _runSliceScan("assets", seq, idxStr);
      if (d1 === null) return;                            // 被更新的扫描作废
      // 2) 回收站增量扫描：__REUSE__ 复用宿主侧已解析的索引，
      //    避免把超大索引串再传一遍（桥通信量减半）
      const d2 = await _runSliceScan("trash", seq, "__REUSE__");
      if (d2 === null) return;
      // 3) 应用 diff
      const c1 = applyItemsDelta(d1);
      const c2 = applyTrashDelta(d2);
      // 4) 跨平台/换机兜底：清掉 file 不在当前素材根目录下的残留条目
      //    （旧版本在别台机器/盘符写索引后，换环境打开可能补进“幽灵素材”，增量扫描不会删）
      const g1 = state.items.filter((it) => it.file && !isUnderRoot(it.file));
      if (g1.length) state.items = state.items.filter((it) => !it.file || isUnderRoot(it.file));
      const g2 = state.trash.filter((t) => t.file && !isUnderRoot(t.file));
      if (g2.length) state.trash = state.trash.filter((t) => !t.file || isUnderRoot(t.file));
      if (g1.length || g2.length) {
        console.warn("[MuMu助手] 清理跨环境幽灵条目: 素材=" + g1.length + " 回收站=" + g2.length);
        for (const p of g1.concat(g2)) delete scanIndex[p.id];
      }
      // 5) 标记"全量已扫"——后续切分类无需再按需扫
      allScanned = true;
      state.categories.forEach((c) => scannedCats.add(c.id));
      // 排序随库走：新库首次扫描（U盘拷贝/换机）条目刚入库，从磁盘索引恢复排序
      try { await applyOrderFromIndex(); } catch (e) { console.warn("[MuMu助手] 同步后恢复排序失败:", e); }
      // 6) 持久化
      saveState();
      saveScanIndex();
      // 7) 视图：仅在有变化时刷新（轻量）
      if (c1 + c2 > 0 || g1.length || g2.length || opts.forceRender) {
        renderAll();
      }
      if (!opts.silent) {
        const total = c1 + c2;
        setSyncPill(total > 0 ? "已同步 (" + total + ")" : "已是最新");
        setTimeout(() => { if (!_syncRunning) setSyncPill(null); }, 1500);
      } else {
        setSyncPill(null);
      }
      console.log("[MuMu助手] 后台同步完成(分片): items Δ=" + c1 + " trash Δ=" + c2);
      scheduleIndexWrite();   // 同步完成后重建磁盘索引（覆盖外部增删改）
    } catch (e) {
      console.error("[MuMu助手] 后台同步失败:", e);
      if (!opts.silent) {
        setSyncPill("同步失败");
        setTimeout(() => { if (!_syncRunning) setSyncPill(null); }, 2000);
      }
    } finally {
      _syncRunning = false;
      if (_syncPending) {
        const p = _syncPending; _syncPending = null;
        setTimeout(() => { runBackgroundSync(p); }, 120);  // 合并后补跑一轮
      } else if (!_rescueInFlight && !_rebuildRunning && !state.items.length && hostReady && settings.assetDir && !MOCK) {
        // ⚠ 兜底救回：同步跑完了但素材仍是 0 条（分片扫描链路异常/旧脚本残留等）
        //    → 稍后用无状态的简单枚举通道强制重建一次，确保磁盘上有的素材一定显示得出来
        //    _rebuildRunning 检查：全量重建进行中时跳过（重建完素材自然就有，避免互踩作废）
        _rescueInFlight = true;
        setTimeout(async () => {
          try {
            if (!state.items.length && !_rebuildRunning) {
              console.warn("[MuMu助手] 同步后仍无素材，启用简单枚举救回");
              const n = await simpleRebuildAssets();
              if (n > 0) renderAll();
            }
          } catch (e) { console.error("[MuMu助手] 救回重建失败:", e); }
          finally { _rescueInFlight = false; }
        }, 1500);
      }
    }
  }

  // 单分类按需扫描：毫秒级，扫完把结果并入 state.items
  async function scanOneCategory(catId) {
    if (MOCK || !hostReady || !settings.assetDir) return;
    if (scannedCats.has(catId)) return;
    const dir = catPath(catId);
    try {
      const raw = payload(await evalScript("PSL_ScanCategory('" + esc(dir) + "')"));
      if (!raw || raw.indexOf("ERR:") === 0) { scannedCats.add(catId); return; }
      const body = raw.indexOf("OK:") === 0 ? raw.substring(3) : raw;
      const lines = body.split("|").filter((s) => s.length);
      let added = 0;
      for (const line of lines) {
        const it = parseScanLine(line, { trash: false });
        if (!it) continue;
        // parseScanLine 按 catName 找 catId；如果该 catId 跟当前扫描的对不上就纠正一下
        if (it.categoryId !== catId) it.categoryId = catId;
        if (it._fp) { scanIndex[it.file] = it._fp; delete it._fp; }
        const existed = state.items.findIndex((x) => x.id === it.id);
        if (existed >= 0) state.items[existed] = it;
        else { state.items.push(it); added++; }
      }
      scannedCats.add(catId);
      saveState();
      saveScanIndex();
      console.log("[MuMu助手] 按需扫描分类", catId, "新增", added);
      return added;
    } catch (e) { console.error("[MuMu助手] 按需扫描分类失败:", e); }
  }

  // 旧 API 兼容：force full scan，保留给"重置索引/异常修复"用（现同样走分片，大库不卡）
  async function discoverAssets() {
    if (MOCK || !hostReady || !settings.assetDir) return;
    _syncPending = null;
    const seq = ++_syncSeq;                 // 作废正在进行的后台同步
    try {
      // 全量 = 给个空 lastIndex，让宿主把所有现存文件都报为 added
      const d1 = await _runSliceScan("assets", seq, "");
      if (d1 === null) return;
      // 清空 items + scanIndex 重建
      state.items = [];
      for (const p in scanIndex) delete scanIndex[p];
      const c1 = applyItemsDelta(d1);

      const d2 = await _runSliceScan("trash", seq, "__REUSE__");
      if (d2 === null) return;
      state.trash = [];
      const c2 = applyTrashDelta(d2);

      scannedCats.clear();
      allScanned = true;
      state.categories.forEach((c) => scannedCats.add(c.id));
      saveState();
      saveScanIndex();
      renderAll();
      scheduleIndexWrite();   // 全量扫描后重建磁盘索引
      console.log("[MuMu助手] 全量扫描完成(分片): items=" + c1 + " trash=" + c2);
    } catch (e) { console.error("[MuMu助手] 全量扫描失败:", e); }
  }

  // 旧 API 兼容：单扫回收站（分片）
  async function discoverTrash() {
    if (MOCK || !hostReady || !settings.assetDir) return;
    _syncPending = null;
    const seq = ++_syncSeq;
    try {
      const idxStr = serializeScanIndex(scanIndex);
      const d = await _runSliceScan("trash", seq, idxStr);
      if (d === null) return;
      const c = applyTrashDelta(d);
      if (c > 0) { saveState(); saveScanIndex(); renderAll(); }
    } catch (e) { console.error("[MuMu助手] 扫描回收站失败:", e); }
  }

  /* ============================================================
     简单枚举重建（无状态通道，不依赖分片扫描的全局游标）
     逐分类调 PSL_ListCatAssets，一次性拿全量 → 清空重建 items。
     切库强制重建的首选通道；分片扫描异常时的可靠兜底。
     ============================================================ */
  async function simpleRebuildAssets(onProgress) {
    if (MOCK || !hostReady || !settings.assetDir) return 0;
    _syncPending = null;
    const seq = ++_syncSeq;                 // 作废在途的分片扫描，避免两套通道互踩
    _rebuildRunning = true;                 // 重建进行中：兜底救回跳过，避免 1.5s 后互踩作废本次重建
    let failedCats = 0;
    try {
      // 遍历源以磁盘为准：先列素材根目录的真实文件夹（JSX 侧已排除回收站），
      // 不依赖 state.categories —— 否则 syncCategoryFolders 静默失败时，
      // 同步下载到新文件夹的素材不在 state 分类里 → 重建扫不到 → “磁盘有、面板无”
      let dirs = [];
      try {
        const dl = payload(await evalScript("PSL_ListCatDirs('" + esc(settings.assetDir) + "')"));
        if (dl) dirs = String(dl).split("|").filter((d) => String(d || "").trim());
      } catch (e) { /* 枚举磁盘分类失败 → 回退 state.categories */ }
      const catList = dirs.length ? dirs : state.categories.map((c) => c.dir || safeDirName(c.name));
      // 磁盘文件夹补全进面板分类（保留已有分类的颜色/名称配置，只补新分类）
      if (dirs.length) {
        const known = {};
        state.categories.forEach((c) => { known[(c.dir || safeDirName(c.name)).toLowerCase()] = 1; });
        let added = 0;
        for (const d of dirs) {
          const nm = String(d).trim();
          const key = nm.toLowerCase();
          if (known[key]) continue;
          const dup = state.categories.find((c) => c.name && c.name.toLowerCase() === key);
          if (dup) { dup.dir = nm; known[key] = 1; continue; }
          state.categories.push({ id: "c" + Date.now().toString(36) + added, name: nm, dir: nm, color: pickColor() });
          known[key] = 1;
          added++;
        }
        if (added) toast("已从素材文件夹同步 " + added + " 个分类");
      }
      // 增量重建：分片指纹扫描（与后台同步同通道），指纹相同自动跳过，只处理新增/变化文件，
      // 远快于全量枚举；scanIndex 缺失/损坏时自然退化为全量（全部判新增）
      // compress=true：每次重建索引都检查 psd 配套缩略图，超 120px 就压缩覆盖（图片原图不碰）
      if (onProgress) onProgress(2, "正在增量重建索引（只处理变化文件）…");
      let c1 = 0, c2 = 0;
      try {
        const d1 = await _runSliceScan("assets", seq, serializeScanIndex(scanIndex));
        if (d1 === null) return -1;
        const d2 = await _runSliceScan("trash", seq, "__REUSE__");
        if (d2 === null) return -1;
        c1 = applyItemsDelta(d1);
        c2 = applyTrashDelta(d2);
      } catch (eIncr) {
        // 回退：分片链路异常（旧脚本残留等）→ 用无状态枚举通道逐分类全量重建（原能力保留）
        console.warn("[MuMu助手] 增量重建失败，回退全量枚举:", eIncr);
        const items2 = [];
        for (const dirName of catList) {
          if (seq !== _syncSeq) return -1;
          if (onProgress)
            onProgress(Math.round((catList.indexOf(dirName) + 1) / catList.length * 100), "正在重建索引 " + (catList.indexOf(dirName) + 1) + "/" + catList.length + "：" + dirName);
          try {
            const body = payload(await evalScript(
              "PSL_ListCatAssets('" + esc(settings.assetDir) + "','" + esc(dirName) + "')",
              120000
            ));
            if (seq !== _syncSeq) return -1;
            if (body) {
              for (const ln of String(body).split("|")) {
                if (!ln) continue;
                const it = parseScanLine(ln);
                if (it) {
                  if (it._fp) { scanIndex[it.file] = it._fp; delete it._fp; }
                  items2.push(it);
                }
              }
            }
          } catch (e) {
            console.error("[MuMu助手] 简单枚举分类失败 " + dirName + ":", e);
            failedCats++;
          }
        }
        if (seq !== _syncSeq) return -1;
        state.items = items2;                // 磁盘即真相：整体替换，绝不与旧条目合并
        c1 = items2.length;
      }
      if (seq !== _syncSeq) return -1;
      allScanned = true;
      scannedCats.clear();
      state.categories.forEach((c) => scannedCats.add(c.id));
      _rebuildFailCats = failedCats;
      // 排序随库走：重建会丢失手动排序，从磁盘索引恢复
      try { await applyOrderFromIndex(); } catch (e) { console.warn("[MuMu助手] 重建后恢复排序失败:", e); }
      saveState();
      saveScanIndex();
      scheduleIndexWrite();   // 重建完成后把磁盘真相固化进索引
      console.log("[MuMu助手] 重建完成: 素材=" + state.items.length + " Δ=" + (c1 + c2) + (failedCats ? " 失败分类=" + failedCats : ""));
      return state.items.length;
    } finally {
      _rebuildRunning = false;
    }
  }

  /* ============================================================
     切换素材库：强制全量重建
     原则：旧库的一切状态全部作废，磁盘即唯一真相。
     分类重置为默认分类，由新库磁盘文件夹反向同步生成；
     素材/回收站/扫描索引全部从新库磁盘重扫，不复用任何旧缓存。
     ============================================================ */
  async function rebuildForNewLibrary() {
    // 1) 彻底清空旧库状态（含 missingIds，避免旧路径残留干扰新库显示）
    state.items = [];
    state.trash = [];
    for (const p in scanIndex) delete scanIndex[p];
    missingIds.clear();
    scannedCats.clear();
    allScanned = false;
    filterCat = "";
    settings.lastFilter = "";
    // 2) 分类重置：只留默认分类，绝不把旧分类结构带进新库
    state.categories = [{
      id: "uncat", name: DEFAULT_CAT_NAME, color: "#9aa3bd", def: true, dir: DEFAULT_CAT_NAME
    }];
    saveState();
    saveScanIndex();

    if (!isCEP || !hostReady || !settings.assetDir) {
      renderAll();
      return 0;
    }
    // 3) 以新库磁盘为唯一来源重建：分类 ← 文件夹；素材/回收站 ← 索引文件或全量枚举
    //    新库带 .mu_index.json → 直接读索引秒渲染（后台静默增量校正磁盘真相），
    //    无索引 → 回退全量枚举重建（首选举简单枚举通道，扫出 0 条再用分片扫描补）
    try { await syncCategoryFolders(); } catch (e) { console.error("[MuMu助手] 切库重建 syncCategoryFolders:", e); }
    let n = 0;
    try { n = await quickAlignNewLibrary(); } catch (e) { console.error("[MuMu助手] 切库重建 quickAlignNewLibrary:", e); }
    if (n < 0) {
      try { n = await simpleRebuildAssets(); } catch (e) { console.error("[MuMu助手] 切库重建 simpleRebuildAssets:", e); }
      if (n <= 0) {
        try { await discoverAssets(); } catch (e) { console.error("[MuMu助手] 切库重建 discoverAssets:", e); }
      }
      try { await discoverTrash(); }     catch (e) { console.error("[MuMu助手] 切库重建 discoverTrash:", e); }
    }
    console.log("[MuMu助手] 切库重建完成: 分类=" + state.categories.length +
                " 素材=" + state.items.length + " 回收站=" + state.trash.length);
    return state.items.length;
  }

  // 在资源管理器中打开该分类的文件夹
  async function openCategoryFolder(catId) {
    if (MOCK) { toast("演示模式无法打开本地目录"); return; }
    if (!await needHost()) { toast("宿主脚本未加载，可重开面板刷新", true); return; }
    try { await evalScript("PSL_OpenFolder('" + esc(catPath(catId)) + "')"); }
    catch (e) { toast("打开失败：" + e.message, true); }
  }

  /* ============================================================
     文本输入弹窗
     ============================================================ */
  const modalMask = $("#modalMask");
  const modalTitle = $("#modalTitle");
  let modalInput = $("#modalInput");   // let：每次弹窗重建节点，修复 CEF 输入法上下文问题
  let modalResolve = null;

  // 输入弹窗的键盘处理：组合中（e.isComposing / keyCode 229）不拦截不提交，
  // 否则拼音选字的 Enter/空格被当确定/取消，候选字上不去、弹窗被误关
  function modalKeydown(e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") { e.preventDefault(); finishModal(modalInput.value); }
    else if (e.key === "Escape") { e.preventDefault(); finishModal(null); }
  }

  function askText(title, def) {
    return new Promise((resolve) => {
      // 上一个弹窗若还挂着，先结掉，避免 resolve 泄漏
      if (modalResolve) { const r = modalResolve; modalResolve = null; r(null); }
      modalResolve = resolve;
      modalTitle.textContent = title;
      modalInput.value = def || "";
      modalMask.hidden = false;
      setTimeout(() => {
        // ⚠ 重建全新 input 节点：CEF 老版本对「hidden 反复切换的同一 input」
        //   偶发不建立输入法(TSF)上下文，表现为拼音打不出中文；
        //   新节点强制重新初始化（Vue 等 SPA 的弹窗 input 每次打开都是新节点，所以正常）
        const prevVal = modalInput.value;
        const fresh = modalInput.cloneNode(false);
        fresh.addEventListener("keydown", modalKeydown);
        modalInput.parentNode.replaceChild(fresh, modalInput);
        modalInput = fresh;
        modalInput.value = prevVal;
        modalInput.focus();
        modalInput.select();
      }, 30);
    });
  }
  function finishModal(value) {
    modalMask.hidden = true;
    if (modalResolve) { const r = modalResolve; modalResolve = null; r(value); }
  }
  $("#modalOk").addEventListener("click", () => finishModal(modalInput.value));
  $("#modalCancel").addEventListener("click", () => finishModal(null));
  modalInput.addEventListener("keydown", modalKeydown);
  modalMask.addEventListener("mousedown", (e) => {
    if (e.target === modalMask) finishModal(null);  // 点遮罩空白处关闭
  });

  /* ---------- 确认弹窗（不可逆操作专用） ---------- */
  const confMask = $("#confMask");
  const confTitle = $("#confTitle");
  const confMsg = $("#confMsg");
  let confResolve = null;

  function askConfirm(title, msg) {
    return new Promise((resolve) => {
      if (confResolve) { const r = confResolve; confResolve = null; r(false); }
      confResolve = resolve;
      confTitle.textContent = title;
      confMsg.textContent = msg;
      confMask.hidden = false;
    });
  }
  function finishConfirm(v) {
    confMask.hidden = true;
    if (confResolve) { const r = confResolve; confResolve = null; r(v); }
  }
  $("#confOk").addEventListener("click", () => finishConfirm(true));
  $("#confCancel").addEventListener("click", () => finishConfirm(false));
  confMask.addEventListener("mousedown", (e) => {
    if (e.target === confMask) finishConfirm(false);
  });

  /* ============================================================
     设置弹窗
     ============================================================ */
  const setMask = $("#setMask");
  const setDir = $("#setDir");
  const setClick = $("#setClick");
  const setSize = $("#setSize");
  const setSizeVal = $("#setSizeVal");
  const themeGrid = $("#themeGrid");
  const setRemote = $("#setRemote");
  const remoteCheck = $("#remoteCheck");
  const rebuildIndex = $("#rebuildIndex");
  const remoteStatusEl = $("#remoteStatus");
  const syncProgress = $("#syncProgress");
  const syncFill = $("#syncFill");
  const syncStepText = $("#syncStepText");
  const updateCheck = $("#updateCheck");
  const updateProgress = $("#updateProgress");
  const updFill = $("#updFill");
  const updStepText = $("#updStepText");
  const updDir = $("#updDir");

  function markThemeChips(key) {
    themeGrid.querySelectorAll(".theme-chip").forEach((el) => {
      el.classList.toggle("active", el.dataset.theme === key);
    });
  }

  function openSettings() {
    setDir.value = settings.assetDir || "";
    setClick.value = settings.clickMode === "double" ? "double" : "single";
    setSize.value = settings.cardSize || 120;
    setSizeVal.textContent = setSize.value + " px";
    setRemote.value = settings.remotePath || "";
    setRemoteStatus("");
    const verEl = $("#verText");
    if (verEl) {
      verEl.textContent = "MuMu助手 v" + REQUIRED_SCRIPT_VERSION +
        (hostScriptVersion
          ? " · 已连接 PS（脚本 v" + hostScriptVersion + "）"
          : " · 未连接 PS（脚本未加载）");
    }
    markThemeChips(settings.theme || "midgray");
    setMask.hidden = false;
  }
  function closeSettings() { setMask.hidden = true; }

  $("#settingsBtn").addEventListener("click", openSettings);
  $("#setCancel").addEventListener("click", closeSettings);
  setMask.addEventListener("mousedown", (e) => { if (e.target === setMask) closeSettings(); });

  // 作者 VX：点击复制到剪贴板
  const authorVx = $("#authorVx");
  if (authorVx) {
    authorVx.addEventListener("click", async () => {
      const text = authorVx.textContent.trim();
      try {
        await navigator.clipboard.writeText(text);
        authorVx.classList.add("copied");
        toast("已复制 VX：" + text);
        setTimeout(() => authorVx.classList.remove("copied"), 1400);
      } catch (e) {
        // 兼容旧 CEP/无 clipboard API：用临时 input 兜底
        try {
          const tmp = document.createElement("input");
          tmp.value = text;
          document.body.appendChild(tmp);
          tmp.select();
          document.execCommand("copy");
          document.body.removeChild(tmp);
          authorVx.classList.add("copied");
          toast("已复制 VX：" + text);
          setTimeout(() => authorVx.classList.remove("copied"), 1400);
        } catch (e2) {
          toast("复制失败，请手动复制：" + text, true);
        }
      }
    });
  }

  // 实时预览缩略图大小
  let _sizeApplyTimer = null;
  setSize.addEventListener("input", () => {
    setSizeVal.textContent = setSize.value + " px";
    document.documentElement.style.setProperty("--card-min", setSize.value + "px");
    // 实时重算列数
    recalcCols(Number(setSize.value));
    // 卡片的缩略图高度是内联样式，拖动结束后批量更新已渲染卡片（防抖，避免拖动中频繁写 DOM）
    clearTimeout(_sizeApplyTimer);
    _sizeApplyTimer = setTimeout(() => {
      const wraps = grid.querySelectorAll(".thumb-wrap");
      for (let i = 0; i < wraps.length; i++) wraps[i].style.height = setSize.value + "px";
    }, 180);
  });

  // 主题选择：点选即实时预览，关闭/保存时落地
  themeGrid.querySelectorAll(".theme-chip").forEach((el) => {
    el.addEventListener("click", () => {
      const key = el.dataset.theme;
      settings.theme = key;
      markThemeChips(key);
      applyPresetTheme(key);   // 即时预览
    });
  });

  // 通用工具：需要 hostscript 时自动重试一次（cover 偶发时序问题）
  async function needHost() {
    if (hostReady) return true;
    console.log("[MuMu助手] hostReady=false, 重试 ensureHost…");
    if (await ensureHost()) { hostReady = true; return true; }
    return false;
  }

  $("#setBrowse").addEventListener("click", async () => {
    if (MOCK) { toast("演示模式无法调用系统目录选择框"); return; }
    if (!await needHost()) { toast("宿主脚本未加载，可重开面板刷新", true); return; }
    try {
      const r = await evalScript("PSL_PickFolder('" + esc(setDir.value) + "')");
      setDir.value = payload(r);
    } catch (e) {
      if (e.message !== "CANCEL") toast("选择目录失败：" + e.message, true);
    }
  });

  $("#setOpen").addEventListener("click", async () => {
    if (MOCK) { toast("演示模式无法打开本地目录"); return; }
    if (!await needHost()) { toast("宿主脚本未加载，可重开面板刷新", true); return; }
    try { await evalScript("PSL_OpenFolder('" + esc(setDir.value) + "')"); }
    catch (e) { toast("打开失败：" + e.message, true); }
  });

  $("#setOk").addEventListener("click", async () => {
    const oldDir = String(settings.assetDir || "").replace(/\\/g, "/").replace(/\/+$/, "");
    let newDir = String(setDir.value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");

    // 先落地不涉及文件系统的设置
    settings.clickMode = setClick.value === "double" ? "double" : "single";
    settings.cardSize = Number(setSize.value) || 120;
    settings.theme = settings.theme || "midgray";   // 主题已在选择时写入，这里确保有值
    settings.remotePath = (setRemote.value || "").trim();

    if (!MOCK && hostReady && newDir && newDir !== oldDir) {
      // 校验目录可写
      let real;
      try { real = payload(await evalScript("PSL_EnsureFolder('" + esc(newDir) + "')")); }
      catch (e) { toast("保存位置无效：" + e.message, true); return; }
      newDir = real;

      // ⚠ 换库 = 纯粹切到另一个库：旧库的分类结构绝不带进新库（由 rebuildForNewLibrary 统一处理）
      settings.assetDir = newDir;
    } else if (MOCK) {
      settings.assetDir = newDir;
    }

    saveSettings();
    applyCardSize();

    // 切换素材目录：强制全量重建 —— 丢弃全部旧库缓存，以新库磁盘为唯一来源
    if (newDir !== oldDir) {
      await rebuildForNewLibrary();
      if (isCEP && hostReady) {
        // 自动进入第一个有素材的分类（没有则回欢迎界面/空状态）
        const counts = {};
        for (const it of state.items) counts[it.categoryId] = (counts[it.categoryId] || 0) + 1;
        const first = state.categories.find((c) => counts[c.id] > 0);
        if (first) {
          filterCat = first.id;
          settings.lastFilter = first.id;
          saveSettings();
        }
        // 兜底：重建后仍是 0 条（扫描中途异常/脚本时序问题）→ 静默重试，最多 3 次
        if (!state.items.length) {
          let tries = 0;
          const retryRebuild = async () => {
            if (state.items.length || tries >= 3) return;
            tries++;
            console.warn("[MuMu助手] 切库重建后仍为 0 条，第 " + tries + " 次重试");
            try { await rebuildForNewLibrary(); renderAll(); } catch (e) { console.error("[MuMu助手] 重试重建失败:", e); }
            if (!state.items.length) setTimeout(retryRebuild, 3000);
          };
          setTimeout(retryRebuild, 3000);
        }
        toast("已切换到新素材库");
      } else {
        toast("已切换保存位置（重开面板后重新联动 PS）");
      }
    }

    renderGrid();
    closeSettings();
    if (oldDir === newDir) toast("设置已保存");
  });

  /* ============================================================
     远程路径素材库（SMB / HTTP，仅手动检查时同步，不自动更新）
     ============================================================ */
  function setRemoteStatus(text, ok) {
    if (!remoteStatusEl) return;
    remoteStatusEl.textContent = text || "";
    remoteStatusEl.className = "remote-status" + (ok === undefined ? "" : ok ? " ok" : " err");
  }

  // 操作进度条（「检查素材」「重建索引」共用）：pct 传 null 隐藏，0-100 显示
  function setSyncProgress(pct, text) {
    if (!syncProgress) return;
    if (pct == null) { syncProgress.hidden = true; return; }
    syncProgress.hidden = false;
    syncFill.style.width = (pct < 0 ? 0 : pct > 100 ? 100 : pct) + "%";
    syncStepText.textContent = text || "";
  }

  let _syncPollTimer = null;
  function stopSyncPoll() {
    if (_syncPollTimer) { clearInterval(_syncPollTimer); _syncPollTimer = null; }
  }
  // SMB 同步是单次桥接调用（JSX 端复制文件），期间拿不到返回 → 轮询 JSX 写的进度文件
  function startSyncPoll() {
    stopSyncPoll();
    _syncPollTimer = setInterval(async () => {
      try {
        const m = /^OK:(.*)$/.exec(String(await evalScript("PSL_ReadSyncProgress()") || ""));
        if (!m) return;
        const parts = String(m[1]).split("|");
        if (parts[0] === "STEP:SCAN") {
          const cur = Number(parts[1]), tot = Number(parts[2]);
          if (tot > 0 && cur >= 0) {
            setSyncProgress(Math.min(99, Math.round(cur / tot * 100)), "正在扫描素材 " + cur + "/" + tot + " 个分类");
          } else {
            setSyncProgress(0, "正在对比远程素材…");
          }
        } else if (parts[0] === "STEP:COPY") {
          const cur = Number(parts[1]) || 0, tot = Number(parts[2]) || 1;
          const pct = Math.round(cur / tot * 100);
          setSyncProgress(pct, "正在复制素材 " + cur + "/" + tot + " 个分类" + (parts[3] ? "：" + parts[3] : ""));
        } else if (parts[0] === "STEP:DONE") {
          setSyncProgress(100, "复制完成，正在重建索引…");
        }
      } catch (e) { /* 轮询失败忽略，下次再试 */ }
    }, 500);
  }

  // 解析远程路径：smb:// 、\\ 、// 前缀 → { type, path }（仅支持 SMB，HTTP 已移除）；
  // POSIX 绝对路径（Mac 上 SMB 挂载点 /Volumes/共享名/素材库）原样放行，
  // smb:// 转换出的 //server/share 只对 Windows UNC 有效，Mac 需用挂载后的路径
  function normRemotePath(p) {
    const s = String(p || "").trim();
    if (/^smb:\/\//i.test(s)) return { type: "smb", path: "//" + s.slice(6).replace(/\/+/g, "/") };
    if (/^\\/.test(s)) return { type: "smb", path: s.replace(/\\/g, "/") };
    if (/^\/\//.test(s)) return { type: "smb", path: s };
    if (/^\/[^\/]/.test(s)) return { type: "smb", path: s };   // Mac：/Volumes/…（已挂载）
    return null;
  }

  function pathJoin(a, b) {
    return String(a).replace(/\/+$/, "") + "/" + String(b);
  }

  // GitHub 更新检查用：CEP 的 fetch 可直接查询 API（20s 超时兜底，防网络卡死面板）
  async function fetchRemote(url) {
    const ctrl = window.AbortController ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 20000) : null;
    try {
      return await fetch(url, { cache: "no-store", signal: ctrl ? ctrl.signal : undefined });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // 统一入口：设置面板「检查素材」按钮
  async function syncRemoteAssets() {
    if (MOCK) { toast("演示模式不支持远程同步", true); return; }
    if (!hostReady) { toast("PS 联动未就绪，请重开面板后重试", true); return; }
    if (!settings.assetDir) { toast("请先在设置里确定素材保存位置", true); return; }
    const raw = (setRemote.value || settings.remotePath || "").trim();
    if (!raw) { toast("请先填写远程路径（smb://、\\\\服务器\\共享；Mac 用 /Volumes/…）", true); return; }
    const norm = normRemotePath(raw);
    if (!norm) { toast("无法识别的远程路径格式（支持 smb://、\\\\服务器\\共享；Mac 用 /Volumes/…）", true); return; }
    settings.remotePath = raw;
    saveSettings();
    remoteCheck.disabled = true;
    rebuildIndex.disabled = true;
    try {
      await syncRemoteSmb(norm.path);
    } finally {
      remoteCheck.disabled = false;
      rebuildIndex.disabled = false;
    }
  }

  // SMB / UNC：JSX 端枚举远程分类并复制新增/更新的文件
  async function syncRemoteSmb(remoteRoot) {
    setRemoteStatus("正在连接远程素材库…");
    setSyncProgress(0, "正在连接远程素材库…");
    startSyncPoll();
    try {
      const res = await evalScript(
        "PSL_SyncRemoteSmb('" + esc(remoteRoot) + "','" + esc(settings.assetDir) + "')",
        120000
      );
      const m = /added=(\d+),updated=(\d+),failed=(\d+)/.exec(res);
      if (!m) throw new Error(res);
      const failedN = Number(m[3]);
      // 同步返回里附带了远程分类清单（CATS: 行）与实际复制的素材行：
      // 面板据此增量合并（免全量重建）+ 删除对齐（远程改名/删除的分类本地不保留）
      const allLines = String(res).split("\n").filter((l) => l.trim());
      let catLine = "";
      const lines = allLines.filter((l) => {
        if (l.indexOf("CATS:") === 0) { catLine = l.slice(5); return false; }
        return true;
      });
      const remoteCats = catLine ? catLine.split("\u0001").filter((x) => x) : [];
      setSyncProgress(100, "复制完成，正在更新面板…");
      // 磁盘已变化：先同步分类文件夹（补新分类），再增量合并复制的素材
      try { await syncCategoryFolders(true); } catch (e) { console.error("[MuMu助手] 同步后同步分类失败:", e); }
      if (lines.length) {
        const its = [];
        for (const ln of lines) {
          const it = parseScanLine(ln);
          if (it) { delete it._fp; its.push(it); }
        }
        if (its.length) { mergeItems(its); saveState(); saveScanIndex(); }
      }
      // 删除对齐：远程已改名/删除的分类 → 本地对应文件夹移入回收站（防"改名后两份素材"）
      try { await pruneLocalCats(remoteCats); } catch (e) { console.error("[MuMu助手] 同步后删除对齐失败:", e); }
      // 排序随库走（单向，以远程为准）：读远程 .mu_index.json 的排序应用到本地
      try {
        const ris = await evalScript("PSL_ReadIndex('" + esc(remoteRoot) + "')");
        const rs = payload(ris);
        if (rs && String(rs).indexOf("ERR:") !== 0) {
          if (applyOrderFromParsed(JSON.parse(rs))) saveState();
        }
      } catch (eR) { /* 远程无索引或读取失败：跳过排序同步 */ }
      reclassifyItems();
      renderAll();
      jumpToCategoryWithItems();
      scheduleIndexWrite();
      setSyncProgress(null);
      setRemoteStatus(
        "完成：新增 " + m[1] + " 个，更新 " + m[2] + " 个" +
        (failedN ? "，失败 " + m[3] + " 个" : ""),
        failedN === 0
      );
    } catch (e) {
      setSyncProgress(null);
      setRemoteStatus("检查失败：" + e.message, false);
    } finally {
      stopSyncPoll();
    }
  }

  // 远程同步删除对齐：远程已不存在的本地分类文件夹 → 整体移入回收站（可恢复，不物理删除），
  // 面板同步移除对应分类与素材条目；仅远程清单非空时执行（远程路径填错/空库不误删本地）
  async function pruneLocalCats(remoteCatNames) {
    if (MOCK || !hostReady || !assetRoot()) return 0;
    const remote = new Set((remoteCatNames || []).map((n) => String(n || "").trim().toLowerCase()));
    if (!remote.size) return 0;
    let list;
    try {
      list = payload(await evalScript("PSL_ListCatDirs('" + esc(assetRoot()) + "')"));
    } catch (e) {
      console.error("[MuMu助手] 删除对齐列目录失败:", e);
      return 0;
    }
    const dirs = String(list || "").split("|")
      .map((d) => String(d || "").trim())
      .filter((d) => d && d.toLowerCase() !== TRASH_DIR.toLowerCase());
    const goneDirs = dirs.filter((d) => !remote.has(d.toLowerCase()));
    if (!goneDirs.length) return 0;
    let removed = 0;
    for (const d of goneDirs) {
      try {
        const r = payload(await evalScript("PSL_TrashCatDir('" + esc(assetRoot()) + "','" + esc(d) + "')"));
        if (String(r).indexOf("ERR:") === 0) { console.warn("[MuMu助手] 回收分类失败:", d, r); continue; }
        removed++;
      } catch (e) { console.warn("[MuMu助手] 回收分类失败:", d, e); }
    }
    if (removed) {
      const gone = new Set(goneDirs.map((d) => d.toLowerCase()));
      const beforeC = state.categories.length;
      state.categories = state.categories.filter((c) => !gone.has((c.dir || safeDirName(c.name)).toLowerCase()));
      const beforeI = state.items.length;
      state.items = state.items.filter((it) => {
        const p = String(it.file || "").replace(/\\/g, "/");
        const dir = p.slice(0, p.lastIndexOf("/"));
        const dn = dir.slice(dir.lastIndexOf("/") + 1);
        return !gone.has(dn.toLowerCase());
      });
      const nDel = beforeC - state.categories.length + beforeI - state.items.length;
      if (nDel > 0) {
        saveState();
        saveScanIndex();
        toast("远程已删除 " + removed + " 个分类，本地对应分类已移入回收站");
      }
    }
    return removed;
  }





  // 同步完成后面板仍停在看不到素材的视图时，自动跳到一个有素材的分类：
  // ① 欢迎界面（filterCat 空）：直接跳第一个非空分类；
  // ② 停在具体分类且该分类恰好没有素材（同步的素材进了别的分类）：
  //    ⚠ 也跳——否则用户看到的就是“磁盘有素材、面板没有”
  function jumpToCategoryWithItems() {
    if (filterCat === TRASH_VIEW) return;   // 回收站视图不打扰
    const counts = {};
    for (const it of state.items) counts[it.categoryId] = (counts[it.categoryId] || 0) + 1;
    if (filterCat) {
      if ((counts[filterCat] || 0) > 0) return;   // 当前分类有素材，不打扰
      const first = state.categories.find((c) => counts[c.id] > 0);
      if (first) {
        setFilter(first.id);
        toast("素材已同步到「" + first.name + "」，当前分类无素材，已自动切换");
      }
      return;
    }
    const first = state.categories.find((c) => counts[c.id] > 0);
    if (first) {
      setFilter(first.id);
      toast("素材已同步，自动切到「" + first.name + "」");
    }
  }

  // 纠正存量条目的分类：磁盘文件夹已在（如远程同步的素材），但 state 里被标成
  // 未分类（parseScanLine 找不到分类时的 fallback）→ 按文件所在文件夹重新归类
  function reclassifyItems() {
    const uncatDir = DEFAULT_CAT_NAME.toLowerCase();
    let changed = 0;
    for (const it of state.items) {
      const p = String(it.file || "").replace(/\\/g, "/");
      const dir = p.slice(0, p.lastIndexOf("/"));
      const dirName = dir.slice(dir.lastIndexOf("/") + 1);
      if (!dirName || dirName.toLowerCase() === uncatDir) continue;
      const cat = state.categories.find((c) => c.dir && c.dir.toLowerCase() === dirName.toLowerCase()) ||
                  state.categories.find((c) => c.name && c.name.toLowerCase() === dirName.toLowerCase());
      if (cat && it.categoryId !== cat.id) { it.categoryId = cat.id; changed++; }
    }
    if (changed) {
      console.log("[MuMu助手] 重新归类 " + changed + " 个素材");
      saveState();
      renderGrid();
    }
    return changed;
  }

  // 手动「重建索引」：以磁盘为准强制全量重建（分类 ← 文件夹，素材 ← 枚举），
  // 远程同步后面板仍不显示素材时的手动兜底（用户点设置里的「重建索引」按钮）
  async function rebuildIndexNow() {
    if (MOCK) { toast("演示模式无法重建索引"); return; }
    if (!hostReady) { toast("PS 联动未就绪，请重开面板后重试", true); return; }
    if (!settings.assetDir) { toast("请先在设置里确定素材保存位置", true); return; }
    if (_rebuildRunning) { toast("重建正在进行中，请稍候", true); return; }
    rebuildIndex.disabled = true;
    rebuildIndex.textContent = "重建中…";
    remoteCheck.disabled = true;
    setSyncProgress(0, "正在准备重建索引…");
    startSyncPoll();   // 增量扫描分片进度走轮询（STEP:SCAN|已扫分类|总分类）
    try {
      try { await syncCategoryFolders(true); } catch (e) { console.error("[MuMu助手] 重建索引同步分类失败:", e); }
      const n = await simpleRebuildAssets((p, t) => setSyncProgress(p, t));
      stopSyncPoll();
      reclassifyItems();
      renderAll();
      jumpToCategoryWithItems();
      setSyncProgress(null);
      if (n < 0) toast("重建被并发的同步打断，请稍后重试", true);
      else if (_rebuildFailCats > 0)
        toast("重建完成：共 " + n + " 个素材（有 " + _rebuildFailCats + " 个分类枚举失败，可能缺失）", true);
      else toast("重建完成：共 " + n + " 个素材（增量扫描）");
    } catch (e) {
      stopSyncPoll();
      setSyncProgress(null);
      toast("重建失败：" + e.message, true);
    } finally {
      stopSyncPoll();
      rebuildIndex.disabled = false;
      rebuildIndex.textContent = "重建索引";
      remoteCheck.disabled = false;
    }
  }

  remoteCheck.addEventListener("click", () => syncRemoteAssets());
  rebuildIndex.addEventListener("click", () => rebuildIndexNow());
  
    /* ============================================================
       检查更新：查询 GitHub Releases，有新版本则静默下载并覆盖部署
       链路：fetch API 查最新版本 → 生成 ps1（下载/解压/覆盖/写结果）
         → JSX 落盘 + vbs 隐藏窗口启动 → 轮询 result.txt → toast 结果
       ============================================================ */
    let _updating = false;
  
    // 平台检测（更新脚本按平台生成：Windows → ps1 + VBS；Mac → sh + nohup）
    const IS_MAC = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || "");
  
    // 插件安装目录（与 _loadHostJsx 相同的取法，正斜杠、去尾斜杠）
    function getExtDir() {
      try {
        let ext = "";
        try { ext = String(cep.fs.getSystemPath(cep.fs.EXTENSION)); } catch (eFs) {}
        if (!ext) { try { ext = String(cep.getSystemPath("extension")); } catch (e2) {} }
        if (!ext) return "";
        ext = decodeURI(String(ext)).replace(/^file:\/{2,3}/, "").replace(/\\/g, "/");
        return ext.replace(/\/+$/, "");
      } catch (e) { return ""; }
    }
  
    // 生成更新脚本（全 ASCII；ps1 由 PowerShell 执行，单引号字符串避免转义地狱）
    // 阶段进度写 progress.txt：DOWNLOAD <pct>（流式下载真实百分比）→ EXTRACT → INSTALL
    function buildUpdatePs1(tag, extDir) {
      return [
        "$ErrorActionPreference = 'Stop'",
        "Start-Sleep -Seconds 1",
        "$tmp = Join-Path $env:TEMP 'MuMuHelper_update'",
        "$zip = Join-Path $tmp 'update.zip'",
        "$ex  = Join-Path $tmp 'ex'",
        "$res = Join-Path $tmp 'result.txt'",
        "$prg = Join-Path $tmp 'progress.txt'",
        "$url = 'https://github.com/fouliny/layerlibrary/releases/download/" + tag + "/MuMuHelper-" + tag + ".zip'",
        "$ext = '" + extDir + "'",
        "if (Test-Path $res) { Remove-Item $res -Force }",
        "if (Test-Path $prg) { Remove-Item $prg -Force }",
        "if (-not (Test-Path $tmp)) { New-Item -ItemType Directory -Path $tmp | Out-Null }",
        "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12",
        "$err = ''",
        // ① 流式下载：每 64KB 写一次真实百分比，面板进度条实时反映
        "try {",
        "  'STEP:DOWNLOAD 0' | Out-File $prg -Encoding ascii",
        "  $req = [System.Net.HttpWebRequest]::Create($url)",
        "  $req.Timeout = 180000",
        "  $resp = $req.GetResponse()",
        "  try {",
        "    $total = [int64]$resp.ContentLength",
        "    $stream = $resp.GetResponseStream()",
        "    $fs = [System.IO.File]::Create($zip)",
        "    try {",
        "      $buf = New-Object byte[] 65536",
        "      $done = [int64]0",
        "      while (($n = $stream.Read($buf, 0, $buf.Length)) -gt 0) {",
        "        $fs.Write($buf, 0, $n)",
        "        $done = $done + $n",
        "        if ($total -gt 0) {",
        "          $pct = [int](100 * $done / $total)",
        "          'STEP:DOWNLOAD ' + $pct | Out-File $prg -Encoding ascii",
        "        }",
        "      }",
        "    } finally { $fs.Close() }",
        "  } finally { $resp.Close() }",
        "  if ((Get-Item $zip).Length -lt 10000) { throw 'size' }",
        "} catch { $err = 'DOWNLOAD' }",
        // ② 解压 + 校验
        "if (-not $err) {",
        "  try {",
        "    'STEP:EXTRACT' | Out-File $prg -Encoding ascii",
        "    if (Test-Path $ex) { Remove-Item $ex -Recurse -Force }",
        "    Expand-Archive -Path $zip -DestinationPath $ex -Force",
        "    if (-not (Test-Path (Join-Path $ex 'CSXS/manifest.xml'))) { throw 'manifest' }",
        "  } catch { $err = 'EXTRACT' }",
        "}",
        // ③ 覆盖安装
        "if (-not $err) {",
        "  try {",
        "    'STEP:INSTALL' | Out-File $prg -Encoding ascii",
        "    Copy-Item (Join-Path $ex '*') $ext -Recurse -Force",
        "  } catch { $err = 'COPY' }",
        "}",
        "if ($err) { ('ERR:' + $err) | Out-File $res -Encoding ascii } else { 'OK' | Out-File $res -Encoding ascii }",
        "Remove-Item $zip -Force -ErrorAction SilentlyContinue",
        "Remove-Item $ex -Recurse -Force -ErrorAction SilentlyContinue",
        "Remove-Item $prg -Force -ErrorAction SilentlyContinue"
      ].join("\n");
    }
    
    // 生成 Mac 更新脚本（全 ASCII；/bin/sh 执行，单引号字符串避免转义地狱）
    // 与 ps1 同构：curl 后台下载 + stat 轮询文件大小算真实百分比 → 解压 → 覆盖 → 写 result.txt
    // stat -f%z 是 BSD（macOS）语法；本脚本只在 Mac 上运行
    function buildUpdateSh(tag, extDir) {
      const safeExt = String(extDir).replace(/'/g, "'\\''");
      return [
        "#!/bin/sh",
        "sleep 1",
        "D=\"${TMPDIR:-/tmp}/MuMuHelper_update\"",
        "ZIP=\"$D/update.zip\"",
        "EX=\"$D/ex\"",
        "RES=\"$D/result.txt\"",
        "PRG=\"$D/progress.txt\"",
        "URL='https://github.com/fouliny/layerlibrary/releases/download/" + tag + "/MuMuHelper-" + tag + ".zip'",
        "EXT='" + safeExt + "'",
        "rm -f \"$RES\" \"$PRG\"",
        "mkdir -p \"$D\"",
        "err=''",
        "echo 'STEP:DOWNLOAD 0' > \"$PRG\"",
        "LEN=$(curl -sIL \"$URL\" | awk 'tolower($1)==\"content-length:\"{n=$2} END{gsub(\"\\r\",\"\",n); print n+0}')",
        "curl -sL --fail -o \"$ZIP\" \"$URL\" &",
        "CPID=$!",
        "while kill -0 $CPID 2>/dev/null; do",
        "  if [ -f \"$ZIP\" ]; then DONE=$(stat -f%z \"$ZIP\" 2>/dev/null || echo 0); else DONE=0; fi",
        "  if [ \"$LEN\" -gt 0 ] 2>/dev/null; then",
        "    PCT=$((DONE*100/LEN))",
        "    [ \"$PCT\" -gt 100 ] && PCT=100",
        "    echo \"STEP:DOWNLOAD $PCT\" > \"$PRG\"",
        "  fi",
        "  sleep 1",
        "done",
        "wait $CPID",
        "SZ=$(stat -f%z \"$ZIP\" 2>/dev/null || echo 0)",
        "if [ \"$SZ\" -lt 10000 ]; then err='DOWNLOAD'; fi",
        "if [ -z \"$err\" ]; then",
        "  echo 'STEP:EXTRACT' > \"$PRG\"",
        "  rm -rf \"$EX\"",
        "  if ! unzip -q \"$ZIP\" -d \"$EX\" 2>/dev/null; then err='EXTRACT'; fi",
        "  if [ ! -f \"$EX/CSXS/manifest.xml\" ]; then err='EXTRACT'; fi",
        "fi",
        "if [ -z \"$err\" ]; then",
        "  echo 'STEP:INSTALL' > \"$PRG\"",
        "  if ! cp -R \"$EX\"/. \"$EXT\"/ 2>/dev/null; then err='COPY'; fi",
        "fi",
        "if [ -n \"$err\" ]; then echo \"ERR:$err\" > \"$RES\"; else echo 'OK' > \"$RES\"; fi",
        "rm -f \"$ZIP\"",
        "rm -rf \"$EX\"",
        "rm -f \"$PRG\""
      ].join("\n");
    }
    
    // 更新进度条 UI：DOWNLOAD pct → 百分比；EXTRACT/INSTALL → 阶段文字
    function updateProgressUi(s) {
      if (String(s).indexOf("STEP:DOWNLOAD") === 0) {
        const pct = parseInt(String(s).split(" ")[1], 10);
        const p = isNaN(pct) ? 0 : Math.max(0, Math.min(100, pct));
        updFill.style.width = p + "%";
        updStepText.textContent = "正在下载更新包… " + p + "%";
      } else if (String(s).indexOf("STEP:EXTRACT") === 0) {
        updFill.style.width = "100%";
        updStepText.textContent = "正在解压更新包…";
      } else if (String(s).indexOf("STEP:INSTALL") === 0) {
        updFill.style.width = "100%";
        updStepText.textContent = "正在覆盖安装…";
      }
    }
    
    // 轮询更新：每轮先读进度更新进度条，再读结果；有结果或超时(160s)返回
    function pollUpdate() {
      return new Promise((resolve) => {
        let tries = 0;
        const timer = setInterval(async () => {
          tries++;
          try {
            const p = await evalScript("PSL_ReadUpdateProgress()");
            updateProgressUi(String(p).replace(/^OK:/, ""));
            const r = await evalScript("PSL_ReadUpdateResult()");
            if (r.indexOf("PENDING") >= 0 && tries < 160) return;   // 还在跑，继续等
            clearInterval(timer);
            resolve(r);
          } catch (e) {
            if (tries < 160) return;   // 宿主瞬时忙，再等一轮
            clearInterval(timer);
            resolve("ERR:TIMEOUT");
          }
        }, 1000);
      });
    }
    
    // 静默下载并覆盖部署：进度条实时展示下载/解压/安装阶段；成功 → “升级完成，请重启 PS”
    async function applyUpdate(tag) {
      const extDir = getExtDir();
      if (!extDir) throw new Error("无法定位插件目录");
      if (!hostReady) throw new Error("PS 联动未就绪，请重开面板后重试");
      // 展示进度条 + 下载位置（%TEMP%/MuMuHelper_update，更新完自动清理）
      try {
        const d = await evalScript("PSL_GetUpdateDir()");
        updDir.textContent = "下载位置：" + String(d).replace(/^OK:/, "");
      } catch (e) {}
      updateProgress.hidden = false;
      updFill.style.width = "0%";
      updStepText.textContent = "正在准备更新…";
      const script = IS_MAC ? buildUpdateSh(tag, extDir) : buildUpdatePs1(tag, extDir);
      const r = await evalScript("PSL_ApplyUpdate('" + esc(script) + "')");
      if (String(r).indexOf("ERR:") === 0) {
        updateProgress.hidden = true;
        throw new Error(String(r).slice(4));
      }
      const res = await pollUpdate();
      updateProgress.hidden = true;
      const m = String(res || "").replace(/^OK:/, "");
      if (m === "OK") { toast("升级完成，请重启 PS 生效"); return; }
      if (m === "ERR:DOWNLOAD") throw new Error("下载更新包失败（网络/代理问题），请稍后重试");
      if (m === "ERR:EXTRACT") throw new Error("更新包解压失败，安装包可能损坏，请重新检查");
      if (m === "ERR:COPY") throw new Error("覆盖插件文件失败（文件被占用？），请手动部署");
      if (m === "ERR:TIMEOUT") throw new Error("更新超时，请稍后重试");
      throw new Error("更新失败（" + (m || "未知原因") + "）");
    }
  
    async function checkForUpdate() {
      if (MOCK) { toast("演示模式无法检查更新", true); return; }
      if (_updating) return;
      _updating = true;
      updateCheck.disabled = true;
      updateCheck.textContent = "检查中…";
      try {
        // GitHub API 支持 CORS，CEP 的 fetch 可直接查询（fetchRemote 内部 20s 超时兜底）
        const resp = await fetchRemote("https://api.github.com/repos/fouliny/layerlibrary/releases/latest");
        if (!resp.ok) throw new Error("查询失败（HTTP " + resp.status + "）");
        const data = await resp.json();
        const tag = String(data.tag_name || "");
        // 语义化版本：v32.1.1 → "32.1.1"（兼容老格式 v32 → "32"）
        const latest = String(tag).replace(/^v/i, "");
        if (!/^\d+(\.\d+){0,2}$/.test(latest)) throw new Error("版本号解析失败（" + tag + "）");
        if (!verGt(latest, REQUIRED_SCRIPT_VERSION)) {
          toast("已是最新版本 v" + REQUIRED_SCRIPT_VERSION);
          return;
        }
        toast("发现新版本 v" + latest + "，正在后台下载更新…");
        updateCheck.textContent = "更新中…";
        await applyUpdate(tag);
      } catch (e) {
        const msg = String((e && e.message) || e || "");
        if (e && e.name === "AbortError") {
          toast("访问 GitHub 超时，请检查网络/代理后重试", true);
        } else if (/failed to fetch|networkerror|load failed|net::|dns|resolve/i.test(msg)) {
          // 网络不可达：给用户看得懂的中文提示，而不是原始的英文 fetch 错误
          toast("无法访问 GitHub（网络不可达或需开启代理/VPN），请检查网络后重试", true);
        } else {
          toast("检查更新失败：" + msg, true);
        }
      } finally {
        _updating = false;
        updateCheck.disabled = false;
        updateCheck.textContent = "检查更新";
      }
    }
  
    updateCheck.addEventListener("click", () => checkForUpdate());

  /* ============================================================
     Toast
     ============================================================ */
  const toastEl = $("#toast");
  let toastTimer = null;
  function toast(msg, err) {
    toastEl.textContent = msg;
    toastEl.className = "toast show" + (err ? " err" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.className = "toast"; }, err ? 4000 : 2200);
  }

  /* ============================================================
     全局事件
     ============================================================ */
  $("#saveBtn").addEventListener("click", () => {
    if (filterCat === TRASH_VIEW) emptyTrash();   // 回收站视图：底部按钮即「清空回收站」
    else saveCurrentLayers();                     // 普通视图：保存选中图层（多选多存）
  });
  searchInput.addEventListener("input", (e) => {
    // 防抖：逐字输入时不再每个按键都全量重建卡片，旧版 PS 上尤其明显
    const v = e.target.value;
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => { searchTerm = v; renderGrid(); }, 120);
  });
  let _searchTimer = null;

  // 排序：3 个 key 互斥（点谁亮谁）+ 方向按钮切换 asc/desc
  const sortKeys = $$(".sort-key");
  const sortDirBtn = $("#sortDirBtn");
  function markSort() {
    sortKeys.forEach((b) => b.classList.toggle("active", b.dataset.key === settings.sortKey));
    sortDirBtn.classList.toggle("asc", settings.sortDir === "asc");
    sortDirBtn.title = settings.sortDir === "asc" ? "当前升序，点击切换为降序" : "当前降序，点击切换为升序";
  }
  sortKeys.forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.key;
    if (!k) return;
    settings.sortKey = k;
    saveSettings(); markSort(); renderGrid();
  }));
  sortDirBtn.addEventListener("click", () => {
    settings.sortDir = settings.sortDir === "asc" ? "desc" : "asc";
    saveSettings(); markSort(); renderGrid();
  });
  markSort();

  document.addEventListener("click", (e) => {
    if (!catDropdown.contains(e.target) && !dragItemId) closeCatMenu();
    if (!ctxMenu.contains(e.target)) closeCtx();
  });
  document.addEventListener("contextmenu", (e) => {
    if (!e.target.closest(".card") && !e.target.closest(".ctx-menu")) {
      e.preventDefault();   // 屏蔽 CEF 默认右键菜单
      closeCtx();
    }
  });
  document.addEventListener("keydown", (e) => {
    // 拼音输入法组合中的按键不参与任何全局快捷键处理（Escape 取消拼音会误关弹窗）
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") {
      closeCatMenu(); closeCtx();
      if (!setMask.hidden) closeSettings();
      if (!confMask.hidden) finishConfirm(false);
      // 输入弹窗焦点不在输入框内时，Escape 也应能关闭（原来关不掉）
      if (!modalMask.hidden) finishModal(null);
    }
  });

  /* ============================================================
     主题（配色）方案
     —— 预设 4 档，对应 Photoshop 首选项「界面 → 颜色方案」的 4 种：
        深黑 / 深灰 / 中灰 / 浅灰。在「设置」里手动选择，启动即套用，
        不再运行时去读 PS appSkinInfo（之前每次开面板桥接检测会卡）。
     ============================================================ */
  // 每档只给一个基准背景色，其余颜色由它派生，保证整体系调统一。
  // 数值参考 PS 对应方案的面板背景（中灰=实测 rgb(83,83,83)）。
  var THEMES = {
    black:    { label: "深黑", base: [38 / 255, 38 / 255, 38 / 255] },   // 方案1
    darkgray: { label: "深灰", base: [54 / 255, 54 / 255, 54 / 255] },   // 方案2
    midgray:  { label: "中灰", base: [83 / 255, 83 / 255, 83 / 255] },   // 方案3（实测）
    light:    { label: "浅灰", base: [223 / 255, 223 / 255, 223 / 255] } // 方案4
  };
  var THEME_ORDER = ["black", "darkgray", "midgray", "light"];

  function applyPresetTheme(key) {
    var t = THEMES[key] ? THEMES[key] : THEMES.black;
    var panel = t.base;

    function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
    function toCss(a) {
      return "rgb(" + Math.round(clamp01(a[0]) * 255) + "," +
                      Math.round(clamp01(a[1]) * 255) + "," +
                      Math.round(clamp01(a[2]) * 255) + ")";
    }
    function lum(a) {
      function f(x) { return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }
      return 0.2126 * f(a[0]) + 0.7152 * f(a[1]) + 0.0722 * f(a[2]);
    }
    function mix(a, b, tt) { return [a[0] + (b[0] - a[0]) * tt, a[1] + (b[1] - a[1]) * tt, a[2] + (b[2] - a[2]) * tt]; }
    function darken(a, tt) { return mix(a, [0, 0, 0], tt); }
    function lighten(a, tt) { return mix(a, [1, 1, 1], tt); }

    var L = lum(panel);
    var isLight = L > 0.4;
    var text      = isLight ? [0.13, 0.13, 0.15] : [0.93, 0.93, 0.96];
    var textDim   = isLight ? [0.40, 0.40, 0.45] : [0.62, 0.62, 0.66];
    var textFaint = isLight ? [0.58, 0.58, 0.62] : [0.42, 0.42, 0.46];

    var bg      = panel;
    var bg2     = darken(panel, 0.10);                    // 顶/底栏
    var bg3     = lighten(panel, isLight ? 0.06 : 0.14);  // 悬浮/弹层
    var bgInput = isLight ? lighten(panel, 0.10) : darken(panel, 0.18);

    var border  = isLight ? "rgba(0,0,0,0.16)" : "rgba(255,255,255,0.10)";
    var border2 = isLight ? "rgba(0,0,0,0.28)" : "rgba(255,255,255,0.16)";

    var cardHover = isLight ? "rgba(0,0,0,0.07)" : toCss(lighten(panel, 0.18));
    var thumbBg   = isLight ? "#ffffff" : toCss(lighten(panel, 0.10));
    var checker   = isLight ? "rgba(0,0,0,0.05)" : "rgba(255,255,255,0.06)";
    var scroll    = isLight ? "rgba(0,0,0,0.30)" : toCss(lighten(panel, 0.45));
    var scrollH   = isLight ? "rgba(0,0,0,0.45)" : toCss(lighten(panel, 0.6));

    var s = document.documentElement.style;
    s.setProperty("--bg", toCss(bg));
    s.setProperty("--bg-2", toCss(bg2));
    s.setProperty("--bg-3", toCss(bg3));
    s.setProperty("--bg-input", toCss(bgInput));
    s.setProperty("--border", border);
    s.setProperty("--border-2", border2);
    s.setProperty("--text", toCss(text));
    s.setProperty("--text-dim", toCss(textDim));
    s.setProperty("--text-faint", toCss(textFaint));
    s.setProperty("--card-hover", cardHover);
    s.setProperty("--thumb-bg", thumbBg);
    s.setProperty("--checker", checker);
    s.setProperty("--scroll-thumb", scroll);
    s.setProperty("--scroll-thumb-hover", scrollH);

    document.documentElement.classList.remove("theme-light");
    // 标记当前主题，便于样式/调试区分
    document.documentElement.setAttribute("data-theme", key);
    console.log("[MuMu助手] 套用主题：" + t.label + " (" + key + ") bg=" + toCss(bg));
  }

  /* ============================================================
     启动
     ============================================================ */
  async function init() {
    // 保险：确保所有弹层初始是关闭的（不依赖 HTML 上的 hidden 属性）
    modalMask.hidden = true;
    setMask.hidden = true;
    confMask.hidden = true;
    ctxMenu.hidden = true;
    catMenu.hidden = true;
    dropzone.hidden = true;

    // 启动时显示"扫描中"覆盖层，init 完成后才 renderAll，避免"先全部分类再闪到上次分类"
    const initLoadingEl = $("#initLoading");
    if (initLoadingEl) initLoadingEl.hidden = false;
    // ⚠ 安全兜底：无论 init 流程是否卡住（旧版 PS 的 cep.evalScript 可能不回调），
    //    20 秒后强制隐藏"正在扫描素材库"覆盖层，避免永久卡在加载状态。
    setTimeout(function () { if (initLoadingEl) initLoadingEl.hidden = true; }, 20000);

    loadSettings();
    loadState();
    scanIndex = loadScanIndex();
    // 启动时把全部分类默认标记为"已扫"（因为 state.items 是上次完整结果）
    // runBackgroundSync 完成后会做增量校正（删已不存在的、新增新文件）
    allScanned = true;
    state.categories.forEach((c) => scannedCats.add(c.id));

    // 把 filterCat 提前设成 lastFilter（先做合法性兜底），下面唯一一次 renderAll 用的就是它
    // lastFilter 为空（首次打开）或非法时，filterCat 留空 → 显示欢迎界面
    filterCat = settings.lastFilter || "";

    // 套用设置里选中的主题预设（固定 4 档之一，无需运行时读 PS 配色，开面板不卡）
    applyPresetTheme(settings.theme);

    // ⚠ 立即首帧渲染：直接用 localStorage 缓存的 state 渲染，不等任何 PS 桥调用。
    //    ensureHost / 目录对齐 / 孤儿归位 / 增量同步全部放到后面后台执行，
    //    彻底避免"开面板 = 一串串行 evalScript"导致的卡顿
    renderAll();
    if (initLoadingEl) initLoadingEl.hidden = true;

    if (!isCEP) return;

    hostReady = await ensureHost();
    if (!hostReady) {
      toast("PS 联动初始化中…（可重开面板刷新）", true);
      console.warn("[MuMu助手] hostscript 初次探测失败（不依赖 PS 的功能仍可用）");
      return;
    }
    console.log("[MuMu助手] hostscript 就绪");

    // 首次运行：把默认素材目录写入设置
    if (!settings.assetDir) {
      try {
        settings.assetDir = payload(await evalScript("PSL_DefaultFolder()"));
        saveSettings();
        console.log("[MuMu助手] 素材目录:", settings.assetDir);
      } catch (e) { console.error("[MuMu助手] 取默认目录失败", e); }
    }

    // 以下全部后台化：分类↔文件夹双向对齐 → 孤儿归位 → 增量同步
    // 不再阻塞面板任何操作；同步本身也是分片的，不卡 PS
    setTimeout(async () => {
      try { await syncCategoryFolders(); } catch (e) { console.error("[MuMu助手] syncCategoryFolders:", e); }
      try { await relocateStrays(); }       catch (e) { console.error("[MuMu助手] relocateStrays:", e); }
      // 磁盘对齐后再校验 lastFilter：上次选的分类被外部删掉 → 回欢迎界面
      const last = settings.lastFilter || "";
      const lastValid = last === TRASH_VIEW || last === "uncat" ||
                        state.categories.some((c) => c.id === last);
      if (!lastValid) {
        if (last) console.warn("[MuMu助手] 上次分类已不存在, 进入欢迎界面:", last);
        filterCat = "";
        settings.lastFilter = "";
        saveSettings();
        renderAll();
      }
      if (settings.assetDir) {
        // 磁盘索引快速对齐：一次桥接读回索引（localStorage 丢失/换机后也能秒恢复），
        // 新条目直接补进 state；删除/移动等磁盘真相校正交给随后的增量扫描
        try {
          const aligned = await alignFromDiskIndex();
          if (aligned > 0) { saveState(); renderAll(); }
        } catch (e) { console.error("[MuMu助手] alignFromDiskIndex:", e); }
        runBackgroundSync({ silent: false });
      }
    }, 60);
  }
  try {
    init();
  } catch (e) {
    console.error("[MuMu助手] init 顶层错误（已兜住）:", e);
    toast("面板初始化异常：" + e.message, true);
  }
})();
