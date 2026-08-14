# MuMu助手(MuMuHelper)— Photoshop 素材管理面板插件

CEP 架构:前端(main.js / index.html / styles.css)运行在 CEF 渲染进程,ExtendScript(JSX/hostscript.jsx)运行在 Photoshop 主进程,两者通过 `evalScript` 桥接通信。磁盘文件是唯一真相,面板数据是缓存。

## 文件说明

### 运行时必需(部署/打包必须包含)

| 文件/目录 | 作用 |
|---|---|
| `CSXS/manifest.xml` | CEP 扩展清单:扩展 ID、PS 版本范围(`[16.0,99.9]`)、入口 `index.html`、CEF 启动参数(`--enable-nodejs`、`--disable-web-security`、`--allow-file-access` 等,用于跨域访问远程素材)。改 ID/入口/参数都在这。 |
| `index.html` | 面板界面骨架:工具栏、分类下拉、素材网格、设置弹窗、输入弹窗、确认弹窗等全部 DOM。 |
| `styles.css` | 全部样式:深色主题 CSS 变量、卡片网格、悬停显隐(星星/三点菜单)、520px 响应式断点、弹窗样式。 |
| `main.js` | 前端核心逻辑(约 3000 行):启动流程、素材扫描调度(秒开缓存渲染 + 分片增量扫描)、分类管理(增删改/排序/拖拽)、加星置顶、手动排序、远程同步(SMB/HTTP 双通道)、设置持久化(localStorage)、脚本版本检测与自动重载。 |
| `JSX/hostscript.jsx` | ExtendScript(ES3,运行在 PS 主线程):所有磁盘与 PS 操作——扫描素材、保存图层、插入素材、缩略图配对、回收站、远程 SMB 同步复制、base64 分片写盘。版本号 `PSL_SCRIPT_VERSION` 须与 main.js 的 `REQUIRED_SCRIPT_VERSION` 同步(当前 v18),面板启动时据此检测并重载旧脚本。 |
| `images/IconDark.png` | 面板图标(深色界面用)。 |
| `images/IconLight.png` | 面板图标(浅色界面用)。 |

### 部署/维护辅助

| 文件 | 作用 |
|---|---|
| `一键部署MuMu助手.bat` | 一键部署:双击后自动把整个插件文件夹复制到 `%APPDATA%\Adobe\CEP\extensions\com.pslib.layerlibrary`,并写注册表 `CSXS.9~13 PlayerDebugMode=1`(PS 2020~2026 未签名扩展加载)。内容为纯英文,免疫任何编辑器编码损坏。 |

### 本次整理已删除

| 文件 | 说明 |
|---|---|
| `.debug` | CEP 调试端口配置(仅开发调试用,日常运行不需要)。 |
| `mimetype` | ZXP 签名打包(`application/vnd.adobe.air-ucf-package+zip`)专用文件,本地 bat 部署不需要。 |
| `TESTING.md` | 旧版测试记录,已被本文档替代。 |
| `enable_unsigned_extensions.reg` | 手动导入的注册表文件,功能已被部署 bat 完全覆盖(双击 bat 即可),删除避免冗余。 |

## 部署方法

1. 双击 `一键部署MuMu助手.bat`(或手动把整个文件夹拷到 `%APPDATA%\Adobe\CEP\extensions\com.pslib.layerlibrary`)
2. 重启 Photoshop
3. 菜单:窗口 → 扩展 → MuMu助手

## 版本

当前脚本版本 **v18**(`hostscript.jsx` 与 `main.js` 两侧版本号一致)。打开设置面板,底部显示「MuMu助手 v18 · 已连接 PS(脚本 v18)」即部署成功。
