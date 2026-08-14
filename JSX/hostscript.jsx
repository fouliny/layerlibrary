// ============================================================
//  Photoshop Layer Library — host script (ExtendScript / ES3)
//  由 CEP 面板通过 __adobe_cep__.evalScript("PSL_xxx(...)") 调用
//  素材目录可由面板设置传入；为空时回落到 ~/Documents/ps-layer-library/assets
//  约定：所有函数返回 "OK:..." 或 "ERR:..." 字符串
// ============================================================

// 探针：面板启动时调用，用于确认 hostscript 是否已被加载
function PSL_Ping() {
    return "OK:PSL_READY";
}

// 回收站文件夹名（素材根目录下的保留文件夹，不参与分类同步）
// 必须与 main.js 的 TRASH_DIR 完全一致
var _PSL_TRASH = "_回收站";
// 磁盘索引缓存文件名（位于素材根目录，随库走；_pslIsAssetName 不认 .json，不会被扫成素材）
// 面板打开/切库时一次桥接读回全量索引 → 秒渲染；磁盘文件仍是唯一真相，后台增量扫描校正
var _PSL_INDEX_NAME = ".mu_index.json";

// 脚本版本号：每次改动 hostscript 后 +1。
// 面板启动时用它检测 PS 内存里是否还是旧版脚本：ExtendScript 全局在 PS 运行期间
// 一直保留，旧函数不会自动更新 —— 不重加载新函数就不存在 → 扫描静默失败（只显分类不显素材）
var PSL_SCRIPT_VERSION = 27;
function PSL_Version() {
    return "OK:" + PSL_SCRIPT_VERSION;
}

// ------------------------------------------------------------
// 自动更新：落盘更新脚本并静默启动
// 面板生成 ps1（下载 zip → 校验 → 解压 → 覆盖插件目录 → 写 result.txt），
// 本函数只负责把 ps1 写到 %TEMP%/MuMuHelper_update/，再用 vbs（隐藏窗口）启动它；
// 面板随后轮询 PSL_ReadUpdateResult 获取结果。
// ps1 内容须为 ASCII（面板侧保证）；路径含非 ASCII 时靠 UTF-8 BOM 兜底。
// ------------------------------------------------------------
function PSL_ApplyUpdate(ps1Text) {
    try {
        var dir = new Folder($.getenv("TEMP") + "/MuMuHelper_update");
        if (!dir.exists) dir.create();
        var ps1 = new File(dir.fsName + "/apply_update.ps1");
        ps1.encoding = "UTF-8";
        ps1.open("w");
        ps1.write("\uFEFF" + ps1Text);   // BOM：PS 5.1 才能按 UTF-8 读，避免路径中文乱码
        ps1.close();
        var vbs = new File(dir.fsName + "/launch_update.vbs");
        vbs.encoding = "UTF-8";
        vbs.open("w");
        // vbs 全 ASCII；用 FSO 取自身所在目录拼 ps1 路径，不硬编码 TEMP
        vbs.write('Set sh = CreateObject("WScript.Shell")\n' +
                  'sh.Run "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"\"" & ' +
                  'CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName) & ' +
                  '"\\apply_update.ps1\"\"", 0, False\n');
        vbs.close();
        vbs.execute();
        return "OK";
    } catch (e) {
        return "ERR:" + e.message;
    }
}

// 读取更新结果：OK:PENDING（还没完成）/ OK:OK / OK:ERR:<阶段码>
function PSL_ReadUpdateResult() {
    try {
        var f = new File($.getenv("TEMP") + "/MuMuHelper_update/result.txt");
        if (!f.exists) return "OK:PENDING";
        f.encoding = "UTF-8";
        f.open("r");
        var t = f.read();
        f.close();
        return "OK:" + (t || "").replace(/[\r\n]+$/, "");
    } catch (e) {
        return "ERR:" + e.message;
    }
}

// 读取更新进度（面板轮询进度条）：OK:NONE / OK:STEP:DOWNLOAD <pct> / OK:STEP:EXTRACT / OK:STEP:INSTALL
function PSL_ReadUpdateProgress() {
    try {
        var f = new File($.getenv("TEMP") + "/MuMuHelper_update/progress.txt");
        if (!f.exists) return "OK:NONE";
        f.encoding = "UTF-8";
        f.open("r");
        var t = f.read();
        f.close();
        return "OK:" + (t || "").replace(/[\r\n]+$/, "");
    } catch (e) {
        return "ERR:" + e.message;
    }
}

// 更新下载目录（面板在进度条下展示，用户可自行找到安装包）
function PSL_GetUpdateDir() {
    try {
        return "OK:" + new Folder($.getenv("TEMP") + "/MuMuHelper_update").fsName;
    } catch (e) {
        return "ERR:" + e.message;
    }
}

// ------------------------------------------------------------
// 路径工具
// ------------------------------------------------------------
function _pslNorm(p) {
    if (!p) return "";
    return String(p).replace(/\\/g, "/").replace(/\/+$/, "");
}

function _pslDefaultDir() {
    return _pslNorm(Folder.myDocuments.fsName) + "/ps-layer-library/assets";
}

// 递归创建目录（Folder.create() 不会自动建父级）
function _pslMkdirs(folder) {
    if (folder.exists) return true;
    var parent = folder.parent;
    if (parent && !parent.exists) {
        if (!_pslMkdirs(parent)) return false;
    }
    return folder.create();
}

// 解析并确保目录存在，返回 Folder 对象；失败返回 null
function _pslDir(dir) {
    var path = _pslNorm(dir);
    if (path === "") path = _pslDefaultDir();
    var f = new Folder(path);
    if (!f.exists && !_pslMkdirs(f)) return null;
    return f;
}

function _pslSafeName(n) {
    if (!n) n = "layer";
    return String(n).replace(/[\\\/:\*\?"<>\|]/g, "_").substring(0, 50);
}

// 分类文件夹名安全化（保留中文，去掉 Windows 非法字符与结尾的点/空格）
function _pslSafeDir(n) {
    var s = String(n === undefined || n === null ? "" : n);
    s = s.replace(/[\\\/:\*\?"<>\|]/g, "_");
    s = s.replace(/^\s+/, "").replace(/\s+$/, "");
    s = s.replace(/[\.\s]+$/, "");
    if (s === "") s = "未命名";
    return s.substring(0, 60);
}

// 生成不重名的目标文件
function _pslUniqueFile(folder, base, ext) {
    var stamp = new Date().getTime();
    var f = new File(folder.fsName + "/" + base + "_" + stamp + ext);
    var n = 1;
    while (f.exists) {
        f = new File(folder.fsName + "/" + base + "_" + stamp + "_" + n + ext);
        n++;
    }
    return f;
}

// ------------------------------------------------------------
// 图层类型判定
// 注意：ExtendScript 的 LayerKind 里没有 ADJUSTMENT 这个统一值，
// 调整层是 LEVELS / CURVES / HUESATURATION 等十几个独立枚举，
// 这里逐个安全比对（某些枚举在低版本可能不存在，故 try 包裹）。
// ------------------------------------------------------------
function _pslIsKind(layer, name) {
    try {
        var k = LayerKind[name];
        if (k === undefined || k === null) return false;
        return layer.kind === k;
    } catch (e) { return false; }
}

function _pslLayerKind(layer) {
    try {
        if (layer.typename === "LayerSet") return "group";
    } catch (eG) {}

    if (_pslIsKind(layer, "TEXT")) return "text";
    if (_pslIsKind(layer, "SMARTOBJECT")) return "smart";

    // 形状 / 填充层
    var fills = ["SOLIDFILL", "GRADIENTFILL", "PATTERNFILL"];
    for (var i = 0; i < fills.length; i++) {
        if (_pslIsKind(layer, fills[i])) return "shape";
    }

    // 调整层的全部枚举
    var adj = [
        "LEVELS", "CURVES", "COLORBALANCE", "BRIGHTNESSCONTRAST",
        "HUESATURATION", "SELECTIVECOLOR", "CHANNELMIXER", "GRADIENTMAP",
        "INVERSION", "THRESHOLD", "POSTERIZE", "PHOTOFILTER",
        "EXPOSURE", "BLACKANDWHITE", "VIBRANCE", "COLORLOOKUP"
    ];
    for (var j = 0; j < adj.length; j++) {
        if (_pslIsKind(layer, adj[j])) return "adjustment";
    }

    return "pixel";
}

// ------------------------------------------------------------
// 返回默认素材目录（面板首次启动时用来初始化设置）
// ------------------------------------------------------------
function PSL_DefaultFolder() {
    return "OK:" + _pslDefaultDir();
}

// ------------------------------------------------------------
// 确保目录存在（设置里保存路径时调用，用于校验路径可写）
// ------------------------------------------------------------
function PSL_EnsureFolder(dir) {
    try {
        var f = _pslDir(dir);
        if (!f) return "ERR:无法创建该目录（路径非法或没有写入权限）";
        // 试写一个探针文件，确认真的可写
        var probe = new File(f.fsName + "/.psl_write_test");
        if (!probe.open("w")) return "ERR:该目录不可写入（请换一个位置或以管理员运行 PS）";
        probe.write("ok");
        probe.close();
        probe.remove();
        return "OK:" + _pslNorm(f.fsName);
    } catch (e) {
        return "ERR:" + e.message;
    }
}

// ------------------------------------------------------------
// 弹出系统目录选择框
// ------------------------------------------------------------
function PSL_PickFolder(initial) {
    try {
        var start = null;
        var p = _pslNorm(initial);
        if (p !== "") {
            var f = new Folder(p);
            if (f.exists) start = f;
        }
        var picked = start ? start.selectDlg("选择 MuMu助手 素材保存位置")
                           : Folder.selectDialog("选择 MuMu助手 素材保存位置");
        if (!picked) return "ERR:CANCEL";
        return "OK:" + _pslNorm(picked.fsName);
    } catch (e) {
        return "ERR:" + e.message;
    }
}

// ------------------------------------------------------------
// 在资源管理器 / 访达中打开素材目录
// ------------------------------------------------------------
function PSL_OpenFolder(dir) {
    try {
        var f = _pslDir(dir);
        if (!f) return "ERR:目录不存在";
        f.execute();
        return "OK:" + _pslNorm(f.fsName);
    } catch (e) {
        return "ERR:" + e.message;
    }
}

// ============================================================
//  分类 ↔ 资源管理器文件夹 一一对应
//  每个分类对应素材根目录下的一个同名子文件夹
// ============================================================

// 新建分类文件夹；已存在则直接复用。返回实际文件夹名
function PSL_MakeCatDir(root, name) {
    try {
        var r = _pslDir(root);
        if (!r) return "ERR:素材根目录不可用，请先在设置里检查保存位置";
        var dn = _pslSafeDir(name);
        var f = new Folder(r.fsName + "/" + dn);
        if (!f.exists && !_pslMkdirs(f)) {
            return "ERR:无法创建分类文件夹「" + dn + "」（没有写入权限？）";
        }
        return "OK:" + dn;
    } catch (e) {
        return "ERR:" + e.message;
    }
}

// 重命名分类文件夹，返回新的文件夹名
function PSL_RenameCatDir(root, oldName, newName) {
    try {
        var r = _pslDir(root);
        if (!r) return "ERR:素材根目录不可用";
        var od = _pslSafeDir(oldName);
        var nd = _pslSafeDir(newName);
        if (od === nd) return "OK:" + nd;

        var src = new Folder(r.fsName + "/" + od);
        var dst = new Folder(r.fsName + "/" + nd);
        if (dst.exists) return "ERR:磁盘上已存在同名文件夹「" + nd + "」，请换个名字";

        if (!src.exists) {
            // 原文件夹丢了（被手动删过），直接建新的
            if (!_pslMkdirs(dst)) return "ERR:无法创建分类文件夹「" + nd + "」";
            return "OK:" + nd;
        }
        if (!src.rename(nd)) {
            return "ERR:重命名文件夹失败（文件夹可能正被资源管理器占用，关掉窗口再试）";
        }
        return "OK:" + nd;
    } catch (e) {
        return "ERR:" + e.message;
    }
}

// 删除分类文件夹；里面还有文件时拒绝删除，返回 ERR:BUSY:<数量>
function PSL_RemoveCatDir(root, name) {
    try {
        var r = _pslDir(root);
        if (!r) return "ERR:素材根目录不可用";
        var dn = _pslSafeDir(name);
        var f = new Folder(r.fsName + "/" + dn);
        if (!f.exists) return "OK:GONE";

        var kids = f.getFiles();
        var n = 0;
        for (var i = 0; i < kids.length; i++) {
            var nm = kids[i].name;
            try { nm = decodeURI(nm); } catch (eD) {}
            if (nm === "." || nm === "..") continue;
            if (nm.charAt(0) === ".") continue;   // 忽略隐藏的探针文件
            n++;
        }
        if (n > 0) return "ERR:BUSY:" + n;

        if (!f.remove()) {
            return "ERR:删除文件夹失败（可能正被资源管理器打开，关掉窗口再试）";
        }
        return "OK:REMOVED";
    } catch (e) {
        return "ERR:" + e.message;
    }
}

// 列出素材根目录下的所有子文件夹，用 | 分隔（面板据此把磁盘上手动建的文件夹同步成分类）
// 回收站是保留文件夹，必须排除，否则会被当成一个普通分类同步进面板
function PSL_ListCatDirs(root) {
    try {
        var r = _pslDir(root);
        if (!r) return "ERR:素材根目录不可用";
        var kids = r.getFiles();
        var out = [];
        for (var i = 0; i < kids.length; i++) {
            if (!(kids[i] instanceof Folder)) continue;
            var nm = kids[i].name;
            try { nm = decodeURI(nm); } catch (eD) {}
            if (nm.charAt(0) === ".") continue;
            if (nm === _PSL_TRASH) continue;      // 跳过回收站
            out.push(nm);
        }
        return "OK:" + out.join("|");
    } catch (e) {
        return "ERR:" + e.message;
    }
}

// ============================================================
//  回收站
//  删除素材 = 把 psd/png 搬进 <素材根目录>/_回收站（走 PSL_MoveAsset）
//  还原     = 再搬回目标分类文件夹（同样走 PSL_MoveAsset）
//  这里只提供「一键清空」：物理删除回收站里的全部文件
// ============================================================

// 确保回收站文件夹存在，返回其完整路径
function PSL_TrashFolder(root) {
    try {
        var r = _pslDir(root);
        if (!r) return "ERR:素材根目录不可用，请先在设置里检查保存位置";
        var f = new Folder(r.fsName + "/" + _PSL_TRASH);
        if (!f.exists && !_pslMkdirs(f)) {
            return "ERR:无法创建回收站文件夹（没有写入权限？）";
        }
        return "OK:" + _pslNorm(f.fsName);
    } catch (e) {
        return "ERR:" + e.message;
    }
}

// 清空回收站：删掉里面所有文件（含子文件夹），返回删除的文件数
function PSL_EmptyTrash(root) {
    try {
        var r = _pslDir(root);
        if (!r) return "ERR:素材根目录不可用";
        var f = new Folder(r.fsName + "/" + _PSL_TRASH);
        if (!f.exists) return "OK:0";
        var n = _pslPurgeInside(f);
        return "OK:" + n;
    } catch (e) {
        return "ERR:" + e.message;
    }
}

// 递归删除文件夹内的全部内容（保留文件夹本身），返回删除的文件数
function _pslPurgeInside(folder) {
    var n = 0;
    var kids = folder.getFiles();
    for (var i = 0; i < kids.length; i++) {
        var k = kids[i];
        var nm = k.name;
        try { nm = decodeURI(nm); } catch (eD) {}
        if (nm === "." || nm === "..") continue;
        try {
            if (k instanceof Folder) {
                n += _pslPurgeInside(k);
                k.remove();
            } else {
                if (k.remove()) n++;
            }
        } catch (eR) { /* 单个删不掉就跳过，不中断整体清空 */ }
    }
    return n;
}

// ------------------------------------------------------------
// 批量检查素材文件是否还存在（用户可能在资源管理器里手动删了）
// spec: "id1::path1|id2::path2|..."（path 用 / 或 \ 均可；id 不含 | 与 ::）
// 返回 "OK:1|0|1|..."，顺序与入参一一对应，1=存在 0=已删除
// 一次性批量检查，避免每个素材各发一次 CEP 调用导致卡顿
// ------------------------------------------------------------
function PSL_CheckFiles(spec) {
    try {
        var segs = String(spec || "").split("|");
        var out = [];
        for (var i = 0; i < segs.length; i++) {
            var seg = segs[i];
            if (!seg) { out.push("0"); continue; }
            var idx = seg.indexOf("::");
            if (idx < 0) { out.push("0"); continue; }
            var p = seg.substring(idx + 2);
            if (!p) { out.push("0"); continue; }
            var f = new File(_pslNorm(p));
            out.push((f && f.exists) ? "1" : "0");
        }
        return "OK:" + out.join("|");
    } catch (e) {
        return "ERR:" + e.message;
    }
}

// ------------------------------------------------------------
// 写入/更新单个素材的 meta.json
// meta: { kind, name, createdAt, star } — 角标 + 显示名 + 创建时间 + 是否置顶加星
// 跟 PSD 同目录同名（base.meta.json），拷贝素材库到任何电脑角标都跟着走
// star 传 1/0 写 "star" 字段；不传则省略（兼容旧数据）
// ------------------------------------------------------------
function _pslWriteMeta(psdPath, kind, name, createdAt, star) {
    try {
        var p = _pslNorm(psdPath);
        var dot = p.lastIndexOf(".");
        if (dot < 0) return;
        var base = p.substring(0, dot);
        var metaPath = base + ".meta.json";
        var f = new File(metaPath);
        f.encoding = "UTF-8";
        f.open("w");
        var k = (kind === undefined || kind === null) ? "" : String(kind).replace(/["\\]/g, "");
        var n = (name === undefined || name === null) ? "" : String(name).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
        var ts = (createdAt === undefined || createdAt === null) ? new Date().getTime() : Number(createdAt);
        var starJson = "";
        if (star !== undefined && star !== null) starJson = ",\"star\":" + (star ? 1 : 0);
        f.write('{"kind":"' + k + '","name":"' + n + '","createdAt":' + ts + starJson + "}");
        f.close();
    } catch (e) { /* meta 写失败不影响主流程 */ }
}

// ------------------------------------------------------------
// 置顶加星/取消置顶：读旧 meta 的 kind/name/createdAt，只改 star 字段写回
// star: 1 = 置顶（星星点亮），0 = 取消置顶
// ------------------------------------------------------------
function PSL_SetStarred(psdPath, star) {
    try {
        var p = _pslNorm(psdPath);
        var dot = p.lastIndexOf(".");
        if (dot < 0) return "ERR:路径无效";
        var base = p.substring(0, dot);
        var metaPath = base + ".meta.json";
        var kind = "", name = "", createdAt = "";
        var f = new File(metaPath);
        if (f.exists) {
            try {
                f.encoding = "UTF-8";
                f.open("r");
                var raw = f.read();
                f.close();
                try {
                    var meta = eval("(" + raw + ")");
                    if (meta && meta.kind !== undefined) kind = String(meta.kind);
                    if (meta && meta.name !== undefined) name = String(meta.name);
                    if (meta && meta.createdAt !== undefined) createdAt = String(meta.createdAt);
                } catch (eEval) {}
            } catch (eMeta) {}
        }
        _pslWriteMeta(p, kind, name, createdAt, (star === "1" || star === 1) ? 1 : 0);
        return "OK:1";
    } catch (e) {
        return "ERR:" + e.message;
    }
}

// ------------------------------------------------------------
// 磁盘索引缓存：读取素材根目录下的 .mu_index.json
// 返回 "OK:" + 索引 JSON 全文；文件不存在/不可用返回 "ERR:NOINDEX"
// 索引只是加速缓存：打开面板/切库时先用它秒渲染，后台增量扫描负责校正磁盘真相
// ------------------------------------------------------------
function PSL_ReadIndex(root) {
    try {
        var r = _pslDir(root);
        if (!r) return "ERR:素材根目录不可用";
        var f = new File(r.fsName + "/" + _PSL_INDEX_NAME);
        if (!f.exists) return "ERR:NOINDEX";
        f.encoding = "UTF-8";
        f.open("r");
        var raw = f.read();
        f.close();
        if (!raw) return "ERR:NOINDEX";
        return "OK:" + raw;
    } catch (e) {
        return "ERR:" + e.message;
    }
}

// ------------------------------------------------------------
// 磁盘索引缓存：把面板维护的索引 JSON 写入素材根目录 .mu_index.json
// 所有素材增删改（保存/删除/还原/移分类/重命名/导入/清空回收站）后由面板节流调用
// ------------------------------------------------------------
function PSL_WriteIndex(root, json) {
    try {
        var r = _pslDir(root);
        if (!r) return "ERR:素材根目录不可用";
        var f = new File(r.fsName + "/" + _PSL_INDEX_NAME);
        f.encoding = "UTF-8";
        f.open("w");
        f.write(String(json === undefined || json === null ? "" : json));
        f.close();
        return "OK:1";
    } catch (e) {
        return "ERR:" + e.message;
    }
}

// ------------------------------------------------------------
// 远程素材库同步（SMB / UNC 共享）
// 单向同步：远程 → 本地。远程素材不存在 → 复制；远程修改时间更新 → 覆盖
// 每个素材连带复制配套缩略图（_t 前缀配对）与 meta.json
// 返回 "OK:added=N,updated=N,failed=N"
// ------------------------------------------------------------
// ⚠ 同步复制用 _pslCopyFile（手动逐块读写）而非 File.copy：
//   ExtendScript 的 File.copy 是异步的，函数返回时复制可能还在后台进行，
//   紧接着的增量扫描会扫不到刚复制的文件 → 素材不进面板（磁盘有、面板无）
function _pslCopyFile(srcFs, dstFs) {
    try {
        var src = new File(srcFs);
        if (!src.exists) return false;
        if (!src.open("r")) return false;
        src.encoding = "BINARY";
        var dst = new File(dstFs);
        if (!dst.open("w")) { src.close(); return false; }
        dst.encoding = "BINARY";
        var chunk = 1048576;
        while (!src.eof) {
            var s = src.read(chunk);
            if (!s || s.length === 0) break;
            dst.write(s);
        }
        dst.close();
        src.close();
        return true;
    } catch (e) {
        return false;
    }
}

function PSL_SyncRemoteSmb(remoteRoot, localRoot) {
    try {
        var rr = _pslNorm(remoteRoot);
        var rem = new Folder(rr);
        if (!rem.exists) return "ERR:无法访问远程路径（网络不可达、共享未连接或没有访问权限）";
        var loc = _pslDir(localRoot);
        if (!loc) return "ERR:本地素材根目录不可用";
        var cats = rem.getFiles();
        var added = 0, updated = 0, failed = 0;
        for (var i = 0; i < cats.length; i++) {
            var c = cats[i];
            if (!(c instanceof Folder)) continue;
            var cname = c.name;
            try { cname = decodeURI(cname); } catch (eD) {}
            if (cname.charAt(0) === ".") continue;
            if (cname === _PSL_TRASH) continue;
            var localCat = new Folder(loc.fsName + "/" + c.name);
            var files = c.getFiles();
            for (var j = 0; j < files.length; j++) {
                var f = files[j];
                if (f instanceof Folder) continue;
                var nm = f.name;
                try { nm = decodeURI(nm); } catch (eD2) {}
                var low = nm.toLowerCase();
                if (!_pslIsAssetName(low)) continue;
                if (_pslIsThumbOfPsd(c.fsName, nm)) continue;   // psd 配套缩略图不是素材
                if (!localCat.exists && !_pslMkdirs(localCat)) { failed++; continue; }
                var dst = new File(localCat.fsName + "/" + f.name);
                var isNew = !dst.exists;
                var needCopy = false;
                if (!dst.exists) {
                    needCopy = true;
                } else {
                    // 远程修改时间比本地新才覆盖
                    try { needCopy = (f.modified.getTime() > dst.modified.getTime()); } catch (eT) { needCopy = true; }
                }
                if (!needCopy) continue;
                var ok = _pslCopyFile(f.fsName, dst.fsName);
                if (!ok) { failed++; continue; }
                // 配套缩略图（前缀配对，保持远程文件名 → 本地规则 A/B 都能配对）
                var dot0 = nm.lastIndexOf(".");
                var base0 = dot0 > 0 ? nm.substring(0, dot0) : nm;
                var th = _pslFindThumb(c.fsName, base0);
                if (th) {
                    try {
                        var thd = new File(localCat.fsName + "/" + th.name);
                        _pslCopyFile(th.fsName, thd.fsName);
                    } catch (eT2) {}
                }
                // 配套 meta.json
                var mf = new File(c.fsName + "/" + base0 + ".meta.json");
                if (mf.exists) {
                    try {
                        var md = new File(localCat.fsName + "/" + base0 + ".meta.json");
                        _pslCopyFile(mf.fsName, md.fsName);
                    } catch (eT3) {}
                }
                if (isNew) added++; else updated++;
            }
        }
        return "OK:added=" + added + ",updated=" + updated + ",failed=" + failed;
    } catch (e) {
        return "ERR:" + e.message;
    }
}

// ------------------------------------------------------------
// 批量获取本地文件大小（不存在返回 0），用于 HTTP 同步时判断是否需要更新
// spec: "path1|path2|..." → "OK:size1|size2|..."
// ------------------------------------------------------------
function PSL_GetSizes(spec) {
    try {
        var segs = String(spec || "").split("|");
        var out = [];
        for (var i = 0; i < segs.length; i++) {
            var p = segs[i];
            if (!p) { out.push("0"); continue; }
            var f = new File(_pslNorm(p));
            out.push((f && f.exists) ? String(f.length || 0) : "0");
        }
        return "OK:" + out.join("|");
    } catch (e) {
        return "ERR:" + e.message;
    }
}

// ------------------------------------------------------------
// 公开写入单个素材的 meta.json（HTTP 同步下载完成后调用）
// ------------------------------------------------------------
function PSL_WriteMeta(psdPath, kind, name, createdAt, star) {
    try {
        _pslWriteMeta(psdPath, kind, name, createdAt, star);
        return "OK:1";
    } catch (e) {
        return "ERR:" + e.message;
    }
}

// ------------------------------------------------------------
// Base64 → 二进制文件（分片写入，供 HTTP 同步下载素材用）
// 流程：PSL_WriteBase64Begin(path) → PSL_WriteBase64Chunk(b64) × N → PSL_WriteBase64End()
// 分片可避免一次性把超大 base64（几十 MB）塞进 CEP 桥导致卡死
// 每个素材都重新 Begin，_PSL_B64F 全局只保留当前正在写的文件
// ------------------------------------------------------------
var _PSL_B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function _pslB64Decode(b64) {
    var s = String(b64 || "");
    var out = [];
    var i = 0, len = s.length;
    var c1, c2, c3, c4, b1, b2, b3;
    while (i < len) {
        c1 = _PSL_B64_CHARS.indexOf(s.charAt(i++));
        c2 = _PSL_B64_CHARS.indexOf(s.charAt(i++));
        c3 = _PSL_B64_CHARS.indexOf(s.charAt(i++));
        c4 = _PSL_B64_CHARS.indexOf(s.charAt(i++));
        if (c1 < 0 || c2 < 0) break;
        b1 = (c1 << 2) | (c2 >> 4);
        out.push(b1 & 255);
        if (c3 >= 0) {
            b2 = ((c2 & 15) << 4) | (c3 >> 2);
            out.push(b2 & 255);
            if (c4 >= 0) {
                b3 = ((c3 & 3) << 6) | c4;
                out.push(b3 & 255);
            }
        }
    }
    return out;
}
var _PSL_B64F = null;
function PSL_WriteBase64Begin(path) {
    try {
        if (_PSL_B64F) { try { _PSL_B64F.close(); } catch (eX) {} }
        var f = new File(_pslNorm(path));
        var dir = f.parent;
        if (!dir.exists && !_pslMkdirs(dir)) return "ERR:无法创建目标目录";
        f.encoding = "BINARY";
        if (!f.open("w")) return "ERR:无法写入文件（目标可能被占用）";
        _PSL_B64F = f;
        return "OK:1";
    } catch (e) {
        return "ERR:" + e.message;
    }
}
function PSL_WriteBase64Chunk(b64) {
    try {
        if (!_PSL_B64F) return "ERR:未初始化（先调用 PSL_WriteBase64Begin）";
        var bytes = _pslB64Decode(b64);
        var sb = [];
        for (var i = 0; i < bytes.length; i++) {
            sb.push(String.fromCharCode(bytes[i]));
            if (sb.length >= 262144) { _PSL_B64F.write(sb.join("")); sb = []; }
        }
        if (sb.length) _PSL_B64F.write(sb.join(""));
        return "OK:" + bytes.length;
    } catch (e) {
        return "ERR:" + e.message;
    }
}
function PSL_WriteBase64End() {
    try {
        if (!_PSL_B64F) return "ERR:未初始化";
        var f = _PSL_B64F;
        _PSL_B64F = null;
        f.close();
        return "OK:1";
    } catch (e) {
        return "ERR:" + e.message;
    }
}

// ------------------------------------------------------------
// 扫描素材根目录（除 _回收站），列出所有「psd + 同名 _t.png + 可选 meta.json」的有效素材
// 返回 "OK:" + 每行 "分类名:::psd绝对路径:::png绝对路径:::kind:::name:::createdAt"
// kind/name/createdAt 从同名 .meta.json 读；缺失则为空，调用方按需兜底
// 这是「磁盘即真相」架构的核心：面板每次启动都从这里拿全部素材
// ------------------------------------------------------------
// ------------------------------------------------------------
// 扫描辅助：把 main.js 传过来的 lastIndex 字符串解析为 { path: fp }
// fp = mtime + ":" + size，构成唯一指纹
// 格式：path\tfp\npath2\tfp2\n...
// ------------------------------------------------------------
function _pslParseIndex(str) {
    var idx = {};
    if (!str) return idx;
    var lines = String(str).split("\n");
    for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        if (!ln) continue;
        var tab = ln.indexOf("\t");
        if (tab < 0) continue;
        var p = ln.substring(0, tab);
        var fp = ln.substring(tab + 1);
        if (p) idx[p] = fp;
    }
    return idx;
}

function _pslFp(f) {
    try {
        var t = f.modified.getTime();
        return t + ":" + (f.length || 0);
    } catch (e) { return "0:0"; }
}

// 判断 png 是否是某个 psd 的配套缩略图。磁盘上的真实命名规律：
//   规则 A（D:\\素材 老命名）：psd = X.psd       ↔ 缩略图 = X_t.png
//   规则 B（新保存命名）：    psd = X_<时间戳>.psd ↔ 缩略图 = X_t_<时间戳>.png
//     ⚠ 规则 B 里 _t 在时间戳前面，且两个时间戳可能差 1~2 毫秒，
//       所以不能拿 png 名去精确拼 psd 名，只能按前缀 X_ + 纯数字 去配对
function _pslIsThumbOfPsd(folderFs, pngName) {
    var lowP = pngName.toLowerCase();
    if (lowP.lastIndexOf(".png") !== lowP.length - 4) return false;
    var stem = pngName.substring(0, pngName.length - 4);   // 去掉 .png
    // 规则 A：X_t.png → 存在 X.psd 即配套
    if (/_t$/.test(stem)) {
        var pA = new File(folderFs + "/" + stem.substring(0, stem.length - 2) + ".psd");
        if (pA.exists) return true;
    }
    // 规则 B：X_t_<数字>.png → 存在 X_<数字>.psd 即配套（时间戳不要求相等）
    var mB = /^(.+)_t_(\d+)$/.exec(stem);
    if (mB) {
        var pre = mB[1] + "_";
        var fold = new Folder(folderFs);
        if (fold.exists) {
            var fs = fold.getFiles();
            for (var k = 0; k < fs.length; k++) {
                var pf = fs[k];
                if (pf instanceof Folder) continue;
                var pn = pf.name;
                try { pn = decodeURI(pn); } catch (eDP) {}
                var plow = pn.toLowerCase();
                if (plow.lastIndexOf(".psd") !== plow.length - 4) continue;
                if (pn.length > pre.length + 4 &&
                    pn.substring(0, pre.length) === pre &&
                    /^\d+$/.test(pn.substring(pre.length, pn.length - 4))) {
                    return true;
                }
            }
        }
    }
    return false;
}

// 给 psd 素材找配套预览缩略图（与 _pslIsThumbOfPsd 配对规则一致）：
//   规则 A：base_t.png ；规则 B：psd = X_<ts>.psd → 找 X_t_<ts>.png（时间戳相同优先，否则任意 X_t_<数字>.png）
// 都没有返回 null（psd 照常入库，面板用占位图）
function _pslFindThumb(folderFs, base) {
    // 规则 A：base_t.png
    var t1 = new File(folderFs + "/" + base + "_t.png");
    if (t1.exists) return t1;
    // 规则 B：base = X_<ts>，缩略图 = X_t_<数字>.png
    var m = /^(.+)_(\d+)$/.exec(base);
    if (!m) return null;
    var pre = m[1] + "_t_";
    var fold = new Folder(folderFs);
    if (!fold.exists) return null;
    var fs = fold.getFiles();
    var fallback = null;
    for (var k = 0; k < fs.length; k++) {
        var tf = fs[k];
        if (tf instanceof Folder) continue;
        var tn = tf.name;
        try { tn = decodeURI(tn); } catch (eDT) {}
        if (tn.length > pre.length + 4 &&
            tn.substring(0, pre.length) === pre &&
            tn.toLowerCase().lastIndexOf(".png") === tn.length - 4 &&
            /^\d+$/.test(tn.substring(pre.length, tn.length - 4))) {
            if (tn.substring(pre.length, tn.length - 4) === m[2]) return tf;   // 时间戳一致：最准
            if (!fallback) fallback = tf;
        }
    }
    return fallback;
}

// 判断文件名是否是可入库的素材（psd 或常见图片格式）
// ⚠ 不能只扫 psd：用户换到其它素材库后，png/jpg 等图片素材也必须能显示
function _pslIsAssetName(low) {
    if (low.lastIndexOf(".psd") === low.length - 4) return true;
    // 图片格式须与 PSL_ImportFile 支持的保持一致
    var exts = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff", ".webp"];
    for (var i = 0; i < exts.length; i++) {
        if (low.lastIndexOf(exts[i]) === low.length - exts[i].length) return true;
    }
    return false;
}

// 判断路径是否位于回收站文件夹内
// 传了 rootPath 时锚定根目录（root/_回收站/...），避免用户素材根目录本身
// 就含"_回收站"字样时误判
function _pslInTrash(p, rootPath) {
    var s = String(p || "");
    if (rootPath) {
        return s.indexOf(_pslNorm(rootPath) + "/" + _PSL_TRASH + "/") === 0;
    }
    return s.indexOf("/" + _PSL_TRASH + "/") >= 0;
}

// ------------------------------------------------------------
// 扫描单个分类目录的内部实现
// 返回 { added:[line], modified:[line], deleted:[path], newIdx:{path:fp} }
// lastIdx 是上次扫描的索引（path→fp），可选
// isTrashScan：true=扫的是回收站。lastIdx 是全库共享索引（普通+回收站都在），
// 删除检测必须只报「属于本次扫描范围」的缺失路径，否则普通扫描会把回收站
// 文件报为已删、回收站扫描会把普通文件报为已删 → 素材两边互相"消失"
// ------------------------------------------------------------
function _pslScanCatImpl(catFolder, catName, lastIdx, isTrashScan, rootPath) {
    var outAdded = [];
    var outMod = [];
    var newIdx = {};
    if (!catFolder || !catFolder.exists) return { added: outAdded, modified: outMod, deleted: [], newIdx: newIdx };
    var files = catFolder.getFiles();
    for (var j = 0; j < files.length; j++) {
        var f = files[j];
        if (f instanceof Folder) continue;
        var nm = f.name;
        try { nm = decodeURI(nm); } catch (eD2) {}
        var low = nm.toLowerCase();
        if (!_pslIsAssetName(low)) continue;
        if (_pslIsThumbOfPsd(catFolder.fsName, nm)) continue;   // psd 配套缩略图不是素材
        var isPsd = (low.lastIndexOf(".psd") === low.length - 4);
        var dot0 = nm.lastIndexOf(".");
        var base0 = dot0 > 0 ? nm.substring(0, dot0) : nm;
        // 缩略图：psd 找配套缩略图（两种命名，没有也照常入库，面板用占位图）；图片素材直接用自己当预览
        var thumbNorm = "";
        if (isPsd) {
            var thumbFile = _pslFindThumb(catFolder.fsName, base0);
            if (thumbFile) thumbNorm = _pslNorm(thumbFile.fsName);
        } else {
            thumbNorm = _pslNorm(f.fsName);
        }
        var normPath = _pslNorm(f.fsName);
        var fp = _pslFp(f);
        newIdx[normPath] = fp;
        // 指纹未变 → 跳过（不读 meta）
        if (lastIdx && lastIdx[normPath] === fp) continue;
        // 变了 → 读 meta
        var kind = "", name = "", createdAt = "", star = "";
        var metaFile = new File(catFolder.fsName + "/" + base0 + ".meta.json");
        if (metaFile.exists) {
            try {
                metaFile.encoding = "UTF-8";
                metaFile.open("r");
                var raw = metaFile.read();
                metaFile.close();
                try {
                    var meta = eval("(" + raw + ")");
                    if (meta && meta.kind !== undefined) kind = String(meta.kind);
                    if (meta && meta.name !== undefined) name = String(meta.name);
                    if (meta && meta.createdAt !== undefined) createdAt = String(meta.createdAt);
                    if (meta && meta.star !== undefined) star = String(meta.star);
                } catch (eEval) {}
            } catch (eMeta) {}
        }
        var line = catName + ":::" + normPath + ":::" + thumbNorm + ":::" +
                   kind + ":::" + name + ":::" + createdAt + ":::" + (f.length || 0) + ":::" + fp + ":::" + star;
        if (lastIdx && lastIdx[normPath]) outMod.push(line);
        else outAdded.push(line);
    }
    // 删除检测：上次有这次没见到的（仅限本扫描范围内的路径）
    var del = [];
    if (lastIdx) {
        for (var p in lastIdx) {
            if (newIdx[p]) continue;                       // 本次还在
            if (_pslInTrash(p, rootPath) !== !!isTrashScan) continue; // 不属于本次范围
            del.push(p);
        }
    }
    return { added: outAdded, modified: outMod, deleted: del, newIdx: newIdx };
}

// ------------------------------------------------------------
// 扫描整个素材根目录的所有分类（增量版）
// lastIndexStr：可选，上次扫描的索引（"path\tfp\n..."）
// 返回 "OK:added_lines|...||modified_lines|...||deleted_paths|..."
// - 三段用 "||" 分隔
// - 段内用 "|" 分隔行
// - added/modified 行格式：cat:::psd:::png:::kind:::name:::createdAt:::size:::fp
// - deleted 段：是上次有过这次不在的 psd 绝对路径（| 分隔）
// lastIndexStr 为空 → 全量输出（全部进 added，deleted 为空）
// ------------------------------------------------------------
function PSL_ScanAssets(root, lastIndexStr) {
    try {
        var r = _pslDir(root);
        if (!r) return "ERR:素材根目录不可用";
        var cats = r.getFiles();
        var lastIdx = _pslParseIndex(lastIndexStr);
        var allAdded = [];
        var allMod = [];
        var allDel = [];
        var seenAny = {};
        for (var i = 0; i < cats.length; i++) {
            var c = cats[i];
            if (!(c instanceof Folder)) continue;
            var cname = c.name;
            try { cname = decodeURI(cname); } catch (eD) {}
            if (cname.charAt(0) === ".") continue;
            if (cname === _PSL_TRASH) continue;
            var r2 = _pslScanCatImpl(c, cname, lastIdx, false, r.fsName);
            if (r2.added.length)   allAdded = allAdded.concat(r2.added);
            if (r2.modified.length) allMod  = allMod.concat(r2.modified);
            if (r2.deleted.length)  allDel  = allDel.concat(r2.deleted);
            for (var k in r2.newIdx) seenAny[k] = r2.newIdx[k];
        }
        // 上次索引里出现在 seenAny 之外的（即整个分类目录都不见了）也算删除
        // ⚠ 跳过回收站里的路径：它们归 PSL_ScanTrash 管，不在本次范围
        if (lastIndexStr) {
            for (var p2 in lastIdx) {
                if (seenAny[p2]) continue;
                if (_pslInTrash(p2, r.fsName)) continue;
                allDel.push(p2);
            }
        }
        return "OK:" + allAdded.join("|") + "||" + allMod.join("|") + "||" + allDel.join("|");
    } catch (e) {
        return "ERR:" + e.message;
    }
}

// ------------------------------------------------------------
// 扫描单个分类目录（按需扫描用，毫秒级返回）
// 返回 "OK:line1|line2|..."  普通格式（不区分 add/mod）
// ------------------------------------------------------------
function PSL_ScanCategory(catDir) {
    try {
        var c = new Folder(_pslNorm(catDir));
        if (!c.exists) return "OK:";
        var cname = c.name;
        try { cname = decodeURI(cname); } catch (eD) {}
        var r = _pslScanCatImpl(c, cname, null, false);
        return "OK:" + r.added.concat(r.modified).join("|");
    } catch (e) {
        return "ERR:" + e.message;
    }
}

// ------------------------------------------------------------
// 扫描回收站（增量版）
// lastIndexStr 同 PSL_ScanAssets
// 返回 "OK:added|...||modified|...||deleted|..."
// 行格式：base:::psd:::png:::kind:::name:::createdAt:::size:::fp
// ------------------------------------------------------------
function PSL_ScanTrash(root, lastIndexStr) {
    try {
        var r = _pslDir(root);
        if (!r) return "ERR:素材根目录不可用";
        var f = new Folder(r.fsName + "/" + _PSL_TRASH);
        if (!f.exists) return "OK:|||";            // 三段都空
        var lastIdx = _pslParseIndex(lastIndexStr);
        var r2 = _pslScanCatImpl(f, "_TRASH_", lastIdx, true, r.fsName);
        return "OK:" + r2.added.join("|") + "||" + r2.modified.join("|") + "||" + r2.deleted.join("|");
    } catch (e) {
        return "ERR:" + e.message;
    }
}

// ------------------------------------------------------------
// 分片增量扫描（Begin + Step 两段式，性能修复核心）
// ExtendScript 运行在 Photoshop 主线程上：一次调用扫全库 + 逐个读 meta.json，
// 素材多时会把 PS 锁死数秒到数十秒（面板"同步中…"卡死 PS 的根因）。
// 拆分方案：
//   Begin —— 一次性解析旧索引、建立扫描游标（状态存在全局 _PSL_Scan 中，
//            ExtendScript 全局变量在多次 evalScript 调用之间会保留）
//   Step  —— 每次最多处理 budget 个文件条目（约几十毫秒），面板在分片之间
//            让出片刻 → PS 有机会响应用户操作，同步全程不卡死
// lastIndexStr 可传 "__REUSE__"：复用上一次的解析结果，避免超大索引串重复过桥
// ------------------------------------------------------------
var _PSL_Scan = null;
var _PSL_LASTIDX = null;

// 读取 psd 同名 .meta.json 的 kind/name/createdAt/star（缺失或出错返回空）
function _pslReadMeta(dirFs, base) {
    var out = { kind: "", name: "", createdAt: "", star: "" };
    var metaFile = new File(dirFs + "/" + base + ".meta.json");
    if (!metaFile.exists) return out;
    try {
        metaFile.encoding = "UTF-8";
        metaFile.open("r");
        var raw = metaFile.read();
        metaFile.close();
        try {
            var meta = eval("(" + raw + ")");
            if (meta && meta.kind !== undefined) out.kind = String(meta.kind);
            if (meta && meta.name !== undefined) out.name = String(meta.name);
            if (meta && meta.createdAt !== undefined) out.createdAt = String(meta.createdAt);
            if (meta && meta.star !== undefined) out.star = String(meta.star);
        } catch (eEval) {}
    } catch (eMeta) {}
    return out;
}

// mode: "assets"=所有分类文件夹（不含回收站）  "trash"=仅回收站
// 返回 "OK:<分类数>"（0 也正常：面板继续调 Step 结算删除项）
function PSL_ScanBegin(root, lastIndexStr, mode) {
    try {
        var r = _pslDir(root);
        if (!r) return "ERR:素材根目录不可用";
        var lastIdx;
        if (lastIndexStr === "__REUSE__" && _PSL_LASTIDX) {
            lastIdx = _PSL_LASTIDX;
        } else {
            lastIdx = _pslParseIndex(lastIndexStr);
            _PSL_LASTIDX = lastIdx;
        }
        var cats = [];
        if (mode === "trash") {
            var f = new Folder(r.fsName + "/" + _PSL_TRASH);
            if (f.exists) cats.push({ folder: f, name: "_TRASH_" });
        } else {
            var kids = r.getFiles();
            for (var i = 0; i < kids.length; i++) {
                if (!(kids[i] instanceof Folder)) continue;
                var cname = kids[i].name;
                try { cname = decodeURI(cname); } catch (eD) {}
                if (cname.charAt(0) === ".") continue;
                if (cname === _PSL_TRASH) continue;
                cats.push({ folder: kids[i], name: cname });
            }
        }
        _PSL_Scan = {
            mode: mode, rootFs: r.fsName, lastIdx: lastIdx,
            cats: cats, ci: 0, files: null, fi: 0,
            added: [], mod: [], seen: {}
        };
        return "OK:" + cats.length;
    } catch (e) {
        _PSL_Scan = null;
        return "ERR:" + e.message;
    }
}

// ============================================================
//  简单枚举通道（无状态、一次调用返回一个分类的全部素材）
//  专供“切库强制重建/启动兜底救回”使用：不依赖 Begin/Step 全局游标，
//  不会与分片扫描互相干扰，任何一步失败也只影响当前分类
//  行格式与 PSL_ScanStep 一致（不带指纹段），面板用同一个 parseScanLine 解析
// ============================================================
function PSL_ListCatAssets(root, catName) {
    try {
        var r = _pslDir(root);
        if (!r) return "ERR:素材根目录不可用";
        var fold = new Folder(r.fsName + "/" + catName);
        if (!fold.exists) return "OK:";
        var files = fold.getFiles();
        var out = [];
        for (var i = 0; i < files.length; i++) {
            var f = files[i];
            if (f instanceof Folder) continue;
            var nm = f.name;
            try { nm = decodeURI(nm); } catch (eDL) {}
            var low = nm.toLowerCase();
            if (!_pslIsAssetName(low)) continue;
            if (_pslIsThumbOfPsd(fold.fsName, nm)) continue;   // psd 配套缩略图不是素材
            var isPsd = (low.lastIndexOf(".psd") === low.length - 4);
            var dot0 = nm.lastIndexOf(".");
            var base0 = dot0 > 0 ? nm.substring(0, dot0) : nm;
            var thumbNorm = "";
            if (isPsd) {
                var thumbFile = _pslFindThumb(fold.fsName, base0);
                if (thumbFile) thumbNorm = _pslNorm(thumbFile.fsName);
            } else {
                thumbNorm = _pslNorm(f.fsName);
            }
            var meta = _pslReadMeta(fold.fsName, base0);
            var fpL = _pslFp(f);   // 带上指纹，重建后 scanIndex 直接就位，增量同步不会重复报 added
            out.push(catName + ":::" + _pslNorm(f.fsName) + ":::" + thumbNorm + ":::" +
                     meta.kind + ":::" + meta.name + ":::" + meta.createdAt + ":::" + (f.length || 0) + ":::" + fpL + ":::" + meta.star);
        }
        return "OK:" + out.join("|");
    } catch (e) {
        return "ERR:" + e.message;
    }
}

// 每次最多处理 budget 个文件条目
// 返回 "OK:added|...||modified|...||deleted|...||MORE" 或 "...||DONE"
// deleted 在 DONE 时结算（只报属于本次扫描范围的缺失路径）
function PSL_ScanStep(budget) {
    try {
        var S = _PSL_Scan;
        if (!S) return "ERR:NO_SCAN";
        var n = Number(budget) || 40;
        var worked = 0;
        var isTrash = (S.mode === "trash");
        while (worked < n && S.ci < S.cats.length) {
            var c = S.cats[S.ci];
            if (!S.files) {
                S.files = c.folder.exists ? c.folder.getFiles() : [];
                S.fi = 0;
            }
            if (S.fi >= S.files.length) { S.ci++; S.files = null; continue; }
            var f = S.files[S.fi++];
            worked++;
            if (f instanceof Folder) continue;
            var nm = f.name;
            try { nm = decodeURI(nm); } catch (eD2) {}
            var low = nm.toLowerCase();
            if (!_pslIsAssetName(low)) continue;
            if (_pslIsThumbOfPsd(c.folder.fsName, nm)) continue;   // psd 配套缩略图不是素材
            var isPsd = (low.lastIndexOf(".psd") === low.length - 4);
            var dot0 = nm.lastIndexOf(".");
            var base0 = dot0 > 0 ? nm.substring(0, dot0) : nm;
            // 缩略图：psd 找配套缩略图（两种命名，没有也照常入库）；图片素材用自己当预览
            var thumbNorm = "";
            if (isPsd) {
                var thumbFile = _pslFindThumb(c.folder.fsName, base0);
                if (thumbFile) thumbNorm = _pslNorm(thumbFile.fsName);
            } else {
                thumbNorm = _pslNorm(f.fsName);
            }
            var normPath = _pslNorm(f.fsName);
            var fp = _pslFp(f);
            S.seen[normPath] = fp;
            // 指纹未变 → 跳过 meta 读取（增量扫描的热路径）
            if (S.lastIdx[normPath] === fp) continue;
            var meta = _pslReadMeta(c.folder.fsName, base0);
            var line = c.name + ":::" + normPath + ":::" + thumbNorm + ":::" +
                       meta.kind + ":::" + meta.name + ":::" + meta.createdAt + ":::" + (f.length || 0) + ":::" + fp + ":::" + meta.star;
            if (S.lastIdx[normPath]) S.mod.push(line);
            else S.added.push(line);
        }
        var outA = S.added.splice(0, S.added.length);
        var outM = S.mod.splice(0, S.mod.length);
        var outD = [];
        if (S.ci >= S.cats.length) {
            // 遍历完毕 → 结算删除（上次有、本次没见到，且属于本扫描范围）
            for (var p in S.lastIdx) {
                if (S.seen[p]) continue;
                if (_pslInTrash(p, S.rootFs) !== isTrash) continue;
                outD.push(p);
            }
            _PSL_Scan = null;
            return "OK:" + outA.join("|") + "||" + outM.join("|") + "||" + outD.join("|") + "||DONE";
        }
        return "OK:" + outA.join("|") + "||" + outM.join("|") + "||" + outD.join("|") + "||MORE";
    } catch (e) {
        _PSL_Scan = null;
        return "ERR:" + e.message;
    }
}

// ------------------------------------------------------------
// 保存当前选中图层为 PNG
// 流程：新建透明临时文档 → 把图层 duplicate 过去 → 删掉底部空层
//       → 按透明像素裁切 → 存 PNG → 关闭临时文档
// ------------------------------------------------------------
function PSL_CaptureLayer(dir) {
    var savedUnits = null, temp = null, srcDoc = null, prevDlg = null;
    try {
        if (app.documents.length === 0) return "ERR:请先在 Photoshop 中打开一个文档";

        var folder = _pslDir(dir);
        if (!folder) return "ERR:素材目录不可用，请在设置里换一个保存位置";

        savedUnits = app.preferences.rulerUnits;
        app.preferences.rulerUnits = Units.PIXELS;
        prevDlg = app.displayDialogs;
        app.displayDialogs = DialogModes.NO;   // 跳过字体缺失/保存确认等弹窗，避免卡死

        srcDoc = app.activeDocument;
        var layer = srcDoc.activeLayer;
        if (!layer) return "ERR:当前没有选中的图层";

        var layerName = layer.name || "图层";
        var base = "L_" + _pslSafeName(layerName);
        var psdFile = _pslUniqueFile(folder, base, ".psd");
        var pngFile = _pslUniqueFile(folder, base + "_t", ".png");

        // 透明临时文档（同源尺寸）
        temp = app.documents.add(
            srcDoc.width, srcDoc.height, srcDoc.resolution,
            "PSL_Temp", NewDocumentMode.RGB, DocumentFill.TRANSPARENT
        );

        // duplicate 前必须让源文档处于激活状态，否则 layer 引用失效
        app.activeDocument = srcDoc;
        var dup = layer.duplicate(temp, ElementPlacement.PLACEATBEGINNING);

        app.activeDocument = temp;

        // 源图层若是隐藏的，复制过去也是隐藏的，强制显示便于裁切
        try { if (dup) dup.visible = true; } catch (eVis) {}

        // 删掉临时文档自带的那个空白底层（复制进来的在最上层）
        try {
            if (temp.layers.length > 1) {
                temp.layers[temp.layers.length - 1].remove();
            }
        } catch (eRm) { /* 删不掉也不影响，只是留一层全透明 */ }

        // 判定图层类型，用于面板角标与插入逻辑
        var kind = _pslLayerKind(layer);

        // 先存 PSD（保真：文字/调整层/组都原样保留，存的是未裁切的原始位置）
        // 注意：ExtendScript 里没有 PSDSaveOptions，保存 PSD 用的是 PhotoshopSaveOptions
        var psdOpts = new PhotoshopSaveOptions();
        psdOpts.layers = true;               // 关键：保留分层，否则文字会被拍平
        psdOpts.embedColorProfile = true;
        psdOpts.alphaChannels = true;
        psdOpts.annotations = false;
        psdOpts.spotColors = false;
        psdOpts.maximizeCompatibility = true;
        // asCopy 用 false：temp 只是临时文档，直接落盘更稳（asCopy+分层在部分版本会异常）
        temp.saveAs(psdFile, psdOpts, false, Extension.LOWERCASE);

        // 生成缩略图（PSD 已存好，这里可以放心裁切/合并临时文档）
        var trimmed = false;
        try { temp.trim(TrimType.TRANSPARENT); trimmed = true; } catch (eTrim) { trimmed = false; }

        if (!trimmed) {
            // 调整层 / 空组没有可见像素，垫一层中性灰再合并，方便看清作用范围
            try {
                var fillL = temp.artLayers.add();
                fillL.name = "PSL_fill";
                var sc = new SolidColor();
                sc.rgb.red = 130; sc.rgb.green = 130; sc.rgb.blue = 130;
                temp.activeLayer = fillL;
                temp.selection.selectAll();
                temp.selection.fill(sc, ColorBlendMode.NORMAL, 100, false);
                temp.selection.deselect();
                fillL.move(temp.layers[temp.layers.length - 1], ElementPlacement.PLACEATEND);
                temp.mergeVisibleLayers();
                try { temp.trim(TrimType.TRANSPARENT); } catch (eT2) {}
            } catch (eGray) {}
        }

        var pngOpts = new PNGSaveOptions();
        pngOpts.compression = 6;
        pngOpts.interlaced = false;
        temp.saveAs(pngFile, pngOpts, true, Extension.LOWERCASE);

        temp.close(SaveOptions.DONOTSAVECHANGES);
        temp = null;
        app.activeDocument = srcDoc;

        // 写入 meta.json（角标 + 显示名 + 创建时间，跟 psd 同目录，拷走素材库就跟着走）
        _pslWriteMeta(psdFile.fsName, kind, layerName, new Date().getTime());

        return "OK:" + psdFile.fsName + ":::" + pngFile.fsName + ":::" + layerName + ":::" + kind;
    } catch (e) {
        try { if (temp !== null) temp.close(SaveOptions.DONOTSAVECHANGES); } catch (e2) {}
        try { if (srcDoc !== null) app.activeDocument = srcDoc; } catch (e3) {}
        return "ERR:" + e.message;
    } finally {
        try { if (savedUnits !== null) app.preferences.rulerUnits = savedUnits; } catch (e4) {}
        try { if (prevDlg !== null) app.displayDialogs = prevDlg; } catch (e5) {}
    }
}

// ------------------------------------------------------------
// 保存当前选中的图层为一份素材（多选合并存，下次插入整组还原）：
//   选 1 个 → 存这 1 个；选 N 个 → N 个图层（含文字/调整层/组）合并存成 1 份素材，
//   保持原有堆叠顺序，插入时这些图层全部回来
// 返回与 PSL_CaptureLayer 一致的单行 "OK:psd:::png:::name:::kind"
// ------------------------------------------------------------

// 自底向上遍历图层树，收集选中的图层引用（保持原文档堆叠顺序）
function _pslCollectSelLayers(layers, ids, out) {
    for (var i = layers.length - 1; i >= 0; i--) {
        var ly = layers[i];
        if (ly.typename === "LayerSet") {
            _pslCollectSelLayers(ly.layers, ids, out);   // 先收组内（更靠下）
        }
        try {
            for (var j = 0; j < ids.length; j++) {
                if (ly.id === ids[j]) { out.push(ly); break; }
            }
        } catch (eC) {}
    }
}

function PSL_CaptureSelected(dir) {
    var savedUnits = null, temp = null, srcDoc = null, prevDlg = null;
    try {
        if (app.documents.length === 0) return "ERR:请先在 Photoshop 中打开一个文档";
        srcDoc = app.activeDocument;

        var ids = _pslSelectedLayerIds(srcDoc);
        // 取不到多选或只选了 1 个 → 走原单层保存流程
        if (ids.length <= 1) return PSL_CaptureLayer(dir);

        var folder = _pslDir(dir);
        if (!folder) return "ERR:素材目录不可用，请在设置里换一个保存位置";

        savedUnits = app.preferences.rulerUnits;
        app.preferences.rulerUnits = Units.PIXELS;
        prevDlg = app.displayDialogs;
        app.displayDialogs = DialogModes.NO;

        // 按文档堆叠顺序收集选中图层；跳过背景层
        var selLayers = [];
        _pslCollectSelLayers(srcDoc.layers, ids, selLayers);
        var kept = [];
        for (var s = 0; s < selLayers.length; s++) {
            try { if (selLayers[s].isBackgroundLayer) continue; } catch (eBg) {}
            kept.push(selLayers[s]);
        }
        if (kept.length === 0) return "ERR:选中的图层无法保存（可能是背景层）";
        if (kept.length === 1) return PSL_CaptureLayer(dir);

        // 文件名用第一个选中图层名；显示名拼接全部选中图层
        var fileName = kept[kept.length - 1].name || "图层";
        var dispNames = [];
        for (var n = 0; n < kept.length; n++) dispNames.push(kept[n].name || "图层");
        var displayName = dispNames.join("、");

        var base = "L_" + _pslSafeName(fileName);
        var psdFile = _pslUniqueFile(folder, base, ".psd");
        var pngFile = _pslUniqueFile(folder, base + "_t", ".png");

        temp = app.documents.add(
            srcDoc.width, srcDoc.height, srcDoc.resolution,
            "PSL_Temp", NewDocumentMode.RGB, DocumentFill.TRANSPARENT
        );

        // 自底向上逐个 duplicate：后复制的落在上面，堆叠顺序与原文档一致
        for (var d = 0; d < kept.length; d++) {
            app.activeDocument = srcDoc;
            var dup = kept[d].duplicate(temp, ElementPlacement.PLACEATBEGINNING);
            try { if (dup) dup.visible = true; } catch (eVis) {}
        }
        app.activeDocument = temp;

        // 删掉临时文档自带的空白底层
        try {
            if (temp.layers.length > 1) {
                temp.layers[temp.layers.length - 1].remove();
            }
        } catch (eRm) {}

        // 多层素材角标用组图标
        var kind = "group";

        // 先存 PSD（保真：文字/调整层/组原样保留）
        var psdOpts = new PhotoshopSaveOptions();
        psdOpts.layers = true;
        psdOpts.embedColorProfile = true;
        psdOpts.alphaChannels = true;
        psdOpts.annotations = false;
        psdOpts.spotColors = false;
        psdOpts.maximizeCompatibility = true;
        temp.saveAs(psdFile, psdOpts, false, Extension.LOWERCASE);

        // 生成缩略图（合并可见图层；全调整层无像素时垫中性灰）
        var trimmed = false;
        try { temp.trim(TrimType.TRANSPARENT); trimmed = true; } catch (eTrim) { trimmed = false; }

        if (!trimmed) {
            try {
                var fillL = temp.artLayers.add();
                fillL.name = "PSL_fill";
                var sc = new SolidColor();
                sc.rgb.red = 130; sc.rgb.green = 130; sc.rgb.blue = 130;
                temp.activeLayer = fillL;
                temp.selection.selectAll();
                temp.selection.fill(sc, ColorBlendMode.NORMAL, 100, false);
                temp.selection.deselect();
                fillL.move(temp.layers[temp.layers.length - 1], ElementPlacement.PLACEATEND);
                temp.mergeVisibleLayers();
                try { temp.trim(TrimType.TRANSPARENT); } catch (eT2) {}
            } catch (eGray) {}
        }

        try { temp.mergeVisibleLayers(); } catch (eMg) {}

        var pngOpts = new PNGSaveOptions();
        pngOpts.compression = 6;
        pngOpts.interlaced = false;
        temp.saveAs(pngFile, pngOpts, true, Extension.LOWERCASE);

        temp.close(SaveOptions.DONOTSAVECHANGES);
        temp = null;
        app.activeDocument = srcDoc;

        _pslWriteMeta(psdFile.fsName, kind, displayName, new Date().getTime());

        return "OK:" + psdFile.fsName + ":::" + pngFile.fsName + ":::" + displayName + ":::" + kind;
    } catch (e) {
        try { if (temp !== null) temp.close(SaveOptions.DONOTSAVECHANGES); } catch (e2) {}
        try { if (srcDoc !== null) app.activeDocument = srcDoc; } catch (e3) {}
        return "ERR:" + e.message;
    } finally {
        try { if (savedUnits !== null) app.preferences.rulerUnits = savedUnits; } catch (e4) {}
        try { if (prevDlg !== null) app.displayDialogs = prevDlg; } catch (e5) {}
    }
}
function _pslSelectedLayerIds(doc) {
    try {
        var ref = new ActionReference();
        ref.putProperty(charIDToTypeID("Prpr"), stringIDToTypeID("targetLayers"));
        ref.putEnumerated(charIDToTypeID("Dcmn"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
        var d = executeActionGet(ref);
        if (!d.hasKey(stringIDToTypeID("targetLayers"))) return [];
        var list = d.getList(stringIDToTypeID("targetLayers"));
        var out = [];
        for (var i = 0; i < list.count; i++) {
            var r = list.getReference(i);
            out.push(r.getIdentifier());
        }
        return out;
    } catch (e) { return []; }
}

// 用图层 id 直接选中该图层（不按名字找，同名图层不会拿错）
function _pslSelectLayerById(id) {
    try {
        var ref = new ActionReference();
        ref.putIdentifier(charIDToTypeID("Lyr "), id);
        var desc = new ActionDescriptor();
        desc.putReference(charIDToTypeID("null"), ref);
        desc.putBoolean(stringIDToTypeID("makeVisible"), false);
        executeAction(charIDToTypeID("slct"), desc, DialogModes.NO);
        return true;
    } catch (e) { return false; }
}


// ------------------------------------------------------------
// 从外部拖入的图片文件导入素材库（复制一份到素材目录）
// ------------------------------------------------------------
function PSL_ImportFile(src, dir) {
    try {
        var s = new File(_pslNorm(src));
        if (!s.exists) return "ERR:文件不存在：" + src;

        var folder = _pslDir(dir);
        if (!folder) return "ERR:素材目录不可用，请在设置里换一个保存位置";

        var full = s.name;
        try { full = decodeURI(full); } catch (eDe) {}
        var dot = full.lastIndexOf(".");
        var base = dot > 0 ? full.substring(0, dot) : full;
        var ext = dot > 0 ? full.substring(dot).toLowerCase() : ".png";

        var ok = (ext === ".png" || ext === ".jpg" || ext === ".jpeg" ||
                  ext === ".gif" || ext === ".bmp" || ext === ".tif" ||
                  ext === ".tiff" || ext === ".webp" || ext === ".psd");
        if (!ok) return "ERR:不支持的文件类型（" + ext + "）";

        var dst = _pslUniqueFile(folder, _pslSafeName(base), ext);
        if (!s.copy(dst)) return "ERR:复制文件失败（目标目录可能不可写）";

        // 导入文件无图层类型信息，kind 留空（无角标）；name 用原文件名
        if (ext === ".psd") _pslWriteMeta(dst.fsName, "", base, new Date().getTime());

        return "OK:" + dst.fsName + ":::" + base;
    } catch (e) {
        return "ERR:" + e.message;
    }
}

// ------------------------------------------------------------
// 把单个素材文件 + 同名 .meta.json 一起搬到目标目录
// 复用：删除到回收站 / 跨分类移动 / 还原 / 孤立素材归位
// 返回 "OK:新路径:::新指纹(mtime:size)"，面板据此同步增量扫描索引
// ------------------------------------------------------------
function PSL_MoveAsset(src, newDir) {
    try {
        var s = new File(_pslNorm(src));
        if (!s.exists) return "ERR:NO_FILE";

        var folder = _pslDir(newDir);
        if (!folder) return "ERR:目标目录不可用";

        // 已经在目标目录里就不动
        if (_pslNorm(s.parent.fsName) === _pslNorm(folder.fsName)) {
            return "OK:" + s.fsName + ":::" + _pslFp(s);
        }

        var dst = new File(folder.fsName + "/" + s.name);
        if (dst.exists) {
            var full = s.name;
            var dot = full.lastIndexOf(".");
            var base = dot > 0 ? full.substring(0, dot) : full;
            var ext = dot > 0 ? full.substring(dot) : ".png";
            dst = _pslUniqueFile(folder, base, ext);
        }

        if (!s.copy(dst)) return "ERR:复制失败";
        // ⚠ 必须删掉原件：删不掉就会在磁盘上留下同一素材的两份
        //    （原分类一份 + 目标/回收站一份，素材重复的根因）。
        //    删不掉时回滚复制并报失败，绝不留下两份。
        var removed = false;
        try { removed = s.remove(); } catch (eRm) { removed = false; }
        if (!removed) {
            try { dst.remove(); } catch (eRb) {}
            return "ERR:原件被占用无法删除，已取消移动以避免重复";
        }

        // meta.json 跟 PSD/PNG 一起搬（同名 base.meta.json）
        try {
            var sp = _pslNorm(s.fsName);
            var dp = _pslNorm(dst.fsName);
            var sDot = sp.lastIndexOf(".");
            var dDot = dp.lastIndexOf(".");
            if (sDot > 0 && dDot > 0) {
                var srcMeta = new File(sp.substring(0, sDot) + ".meta.json");
                if (srcMeta.exists) {
                    var dstMeta = new File(dp.substring(0, dDot) + ".meta.json");
                    if (!dstMeta.exists) srcMeta.copy(dstMeta);
                    try { srcMeta.remove(); } catch (eRmM) {}
                }
            }
        } catch (eMv) { /* meta 跟丢不影响主流程 */ }

        return "OK:" + dst.fsName + ":::" + _pslFp(dst);
    } catch (e) {
        return "ERR:" + e.message;
    }
}

// ------------------------------------------------------------
// 插入素材到当前画布 —— 保持素材原有图层属性（用户明确不要栅格化）：
//   PSD：打开 → 把图层原样复制进当前文档（保留文字/调整层/组的属性）
//   图片：置入嵌入对象（保留矢量属性，可无损缩放）
// 注意：Document 对象没有 place() 方法，必须用 placeEvent 动作描述符
// ------------------------------------------------------------
function PSL_InsertLayer(p) {
    var prevDlg = null, srcDoc = null, savedUnits = null;
    try {
        prevDlg = app.displayDialogs;
        app.displayDialogs = DialogModes.NO;   // 跳过字体缺失/链接确认等弹窗，避免卡死

        if (app.documents.length === 0) return "ERR:请先在 Photoshop 中打开一个文档";
        var f = new File(_pslNorm(p));
        if (!f.exists) return "ERR:素材文件不存在（可能已被移动或删除）";

        var lower = f.name.toLowerCase();
        var isPsd = lower.lastIndexOf(".psd") === (lower.length - 4);

        if (isPsd) {
            savedUnits = app.preferences.rulerUnits;
            app.preferences.rulerUnits = Units.PIXELS;

            // 保真插入：打开 PSD → 把里面的图层（文字/调整层/组）原样复制进当前文档 → 关闭 PSD
            var tgt = app.activeDocument;
            srcDoc = app.open(f);
            app.activeDocument = srcDoc;   // duplicate 跨文档时源必须是激活文档

            var pick = null;
            try { pick = srcDoc.layers[0]; } catch (eAL) {}
            if (!pick) return "ERR:素材文件里没有可用图层";

            // 复制素材里的全部顶层图层（多选合并素材要整组还原），
            // 自底向上 duplicate 保持原有堆叠顺序
            var inserted = [];
            var nLay = srcDoc.layers.length;
            for (var li = nLay - 1; li >= 0; li--) {
                try {
                    var ly = srcDoc.layers[li];
                    try { if (ly.isBackgroundLayer) continue; } catch (eBg2) {}
                    var d2 = ly.duplicate(tgt, ElementPlacement.PLACEATBEGINNING);
                    if (d2) inserted.push(d2);
                } catch (eDup) { /* 单层复制失败不阻断其余层 */ }
            }
            if (inserted.length === 0) return "ERR:素材文件里没有可用图层";

            srcDoc.close(SaveOptions.DONOTSAVECHANGES);
            srcDoc = null;
            app.activeDocument = tgt;

            // 把所有插入图层作为整体居中到画布（保持相互位置不变）；
            // 调整层等无实际边界的图层不计入包围盒，但跟着一起平移
            try {
                var minX = null, minY = null, maxX = null, maxY = null;
                for (var bi = 0; bi < inserted.length; bi++) {
                    try {
                        var bb = inserted[bi].bounds;
                        var b0 = bb[0].value, b1 = bb[1].value, b2 = bb[2].value, b3 = bb[3].value;
                        if (b2 <= b0 || b3 <= b1) continue;   // 无可见边界（调整层等）
                        if (minX === null || b0 < minX) minX = b0;
                        if (minY === null || b1 < minY) minY = b1;
                        if (maxX === null || b2 > maxX) maxX = b2;
                        if (maxY === null || b3 > maxY) maxY = b3;
                    } catch (eBB) {}
                }
                if (minX !== null) {
                    var dcx = tgt.width.value / 2;
                    var dcy = tgt.height.value / 2;
                    var lcx = (minX + maxX) / 2;
                    var lcy = (minY + maxY) / 2;
                    for (var ti = 0; ti < inserted.length; ti++) {
                        try { inserted[ti].translate(dcx - lcx, dcy - lcy); } catch (eTr) {}
                    }
                }
                tgt.activeLayer = inserted[inserted.length - 1];
            } catch (eCenter) {}

            return "OK";
        }

        // 图片：作为嵌入对象置入（保留原有属性，不栅格化），以画布中心为参考点自动居中
        var desc = new ActionDescriptor();
        desc.putPath(charIDToTypeID("null"), f);
        desc.putEnumerated(
            charIDToTypeID("FTcs"),
            charIDToTypeID("QCSt"),
            charIDToTypeID("Qcsa")   // 以画布中心为参考点
        );
        var ofs = new ActionDescriptor();
        ofs.putUnitDouble(charIDToTypeID("Hrzn"), charIDToTypeID("#Pxl"), 0);
        ofs.putUnitDouble(charIDToTypeID("Vrtc"), charIDToTypeID("#Pxl"), 0);
        desc.putObject(charIDToTypeID("Ofst"), charIDToTypeID("Ofst"), ofs);
        desc.putBoolean(charIDToTypeID("Lnkd"), false); // 嵌入而非链接

        executeAction(charIDToTypeID("Plc "), desc, DialogModes.NO);
        return "OK";
    } catch (e) {
        return "ERR:" + e.message;
    } finally {
        // 出错时兜底关闭临时打开的 PSD，避免残留文档堆在 PS 里
        try { if (srcDoc !== null) srcDoc.close(SaveOptions.DONOTSAVECHANGES); } catch (e7) {}
        try { if (savedUnits !== null) app.preferences.rulerUnits = savedUnits; } catch (e8) {}
        try { if (prevDlg !== null) app.displayDialogs = prevDlg; } catch (e6) {}
    }
}

// ------------------------------------------------------------
// 删除素材文件
// ------------------------------------------------------------
function PSL_DeleteAsset(p, thumb) {
    try {
        var f = new File(_pslNorm(p));
        if (f.exists) f.remove();
        if (thumb) {
            var t = new File(_pslNorm(thumb));
            if (t.exists) t.remove();
        }
        // 同步删 meta.json（角标跟随文件走，文件删了角标也没意义）
        try {
            var pp = _pslNorm(p);
            var dot = pp.lastIndexOf(".");
            if (dot > 0) {
                var mf = new File(pp.substring(0, dot) + ".meta.json");
                if (mf.exists) mf.remove();
            }
        } catch (eM) {}
        return "OK";
    } catch (e) {
        return "ERR:" + e.message;
    }
}

// ------------------------------------------------------------
// 备用：读 PNG 返回 base64（file:// 缩略图不可用时的降级方案）
// ------------------------------------------------------------
function PSL_GetAsset(p) {
    try {
        var f = new File(_pslNorm(p));
        if (!f.exists) return "ERR:NO_FILE";
        f.encoding = "BINARY";
        f.open("r");
        var data = f.read();
        f.close();
        return "DATA:" + _pslB64(data);
    } catch (e) {
        return "ERR:" + e.message;
    }
}

var _PSL_B64C = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function _pslB64(input) {
    var out = "", i = 0, len = input.length;
    while (i < len) {
        var c1 = input.charCodeAt(i++) & 0xff;
        if (i === len) {
            out += _PSL_B64C.charAt(c1 >> 2) + _PSL_B64C.charAt((c1 & 0x3) << 4) + "==";
            break;
        }
        var c2 = input.charCodeAt(i++);
        if (i === len) {
            out += _PSL_B64C.charAt(c1 >> 2)
                 + _PSL_B64C.charAt(((c1 & 0x3) << 4) | ((c2 & 0xf0) >> 4))
                 + _PSL_B64C.charAt((c2 & 0xf) << 2) + "=";
            break;
        }
        var c3 = input.charCodeAt(i++);
        out += _PSL_B64C.charAt(c1 >> 2)
             + _PSL_B64C.charAt(((c1 & 0x3) << 4) | ((c2 & 0xf0) >> 4))
             + _PSL_B64C.charAt(((c2 & 0xf) << 2) | ((c3 & 0xc0) >> 6))
             + _PSL_B64C.charAt(c3 & 0x3f);
    }
    return out;
}
