# 发布到 GitHub（让别人一行装）

目标：让别人在 **设置 → 插件 → 添加插件** 里输入

```
github:Something11235/dsh-video-skin#main
```

就能装上这个插件。**仓库本身已经是可发布状态**，剩下的是三步网络操作。

---

## 0. 为什么这个仓库"推上去就能装"（别破坏这三件事）

| 条件 | 本仓库的状态 | 破坏了会怎样 |
| --- | --- | --- |
| **产物已提交**（`index.js` / `lib` / `runtime` / `assets/*.mp4` / `assets/background.jpg`） | ✅ 全在 git 里 | pnpm clone 下来没有可运行的东西 |
| **不能有 `prepare` / `prepack` / `postinstall`** | ✅ 一个都没有 | pnpm 会拦下 git 依赖的构建脚本：`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，**`dsh plugin add` 直接失败**（哪怕产物已提交） |
| **`dsh.bundle.patch` + 包名与 patch 行 `name` 一致** | ✅ `cordis.patch.yml` 一行 `insert` | 插件不会成为一层；或者 loader 只 warn 然后跳过（表现是"装上了但没生效"） |

这三条都有自动化守着：

```powershell
node scripts/verify-all.mjs          # 14 项：素材/打包白名单/patch 契约/单元测试
node scripts/verify-git-install.mjs  # 11 项：把仓库当远程，用真 pnpm git 依赖路径装一遍
```

`verify-git-install.mjs` 是把**当前提交**克隆成裸仓库、再用 `git+file://…#main` 让 pnpm 走
真正的 git 依赖安装（和 `github:` 是同一段代码），然后断言装出来的副本
**自带运行所需的一切、且没有任何生命周期脚本**。改完接线之后跑它，比推上去再试便宜得多。

---

## 1. 建仓库

浏览器方式：<https://github.com/new> → 名字填 **`dsh-video-skin`** → **Public** →
**不要**勾 "Add a README / .gitignore / license"（本地已经有了）→ Create。

命令行方式（需要 `gh`，本机当前**没装**）：

```powershell
winget install --id GitHub.cli
gh auth login          # 或：gh auth login --with-token < token.txt
gh repo create Something11235/dsh-video-skin --public --source . --push
```

## 2. 推上去

```powershell
cd "D:\Projects\DSH工作台\插件制作\dsh-video-skin"
git remote add origin https://github.com/Something11235/dsh-video-skin.git
git push -u origin main
```

> 第一次 push 会弹浏览器让你登录 GitHub（Git Credential Manager）。
> 也可以先用 `git remote set-url origin git@github.com:Something11235/dsh-video-skin.git` 走 SSH。

## 3. 打 topic（市场收录要用）

GitHub 仓库页 → 右上 **⚙ About** → **Topics** 加一个：**`dsh-plugin`**。

（命令行：`gh repo edit --add-topic dsh-plugin`。）

## 4. 验一遍"别人那一行"

> **已经验过了（2026-10-02，针对 `main` 上的 `335c871`）：**
>
> | 步骤 | 结果 |
> | --- | --- |
> | `git ls-remote https://github.com/Something11235/dsh-video-skin.git` | `refs/heads/main` = `335c871…`（公开可读） |
> | `dsh plugin --profile verify add "dsh-video-skin"`（**只写包名**） | ❌ `ERR_PNPM_FETCH_404`：裸名按 **npm 包名**解析，去 registry 找 |
> | `dsh plugin --profile verify add "github:Something11235/dsh-video-skin#main"` | ✅ exit 0，7.1s，`+ dsh-video-skin 0.1.0`；落进 pnpm store 的 `dsh-video-skin@https+++code_121832de…`；运行所需文件齐、`boot.mp4` 2 680 723 字节完整 |
> | 启动那一份装出来的副本 → 真 Chromium + CDP 验收 | ✅ **66/66**（有声开机动画且音频真的被解码、点击跳过、背景层、可读性、透明度滑块 + 刷新后仍在） |
>
> 结论：**用户要输入的是完整的那一行，不是包名。** 想让裸名也能用，只有一条路 —— 发到 npm（见文末）。

在**一个干净 profile** 上装（不要用你日常那个）：

```powershell
$dsh = 'D:\AI\Agent\DSH官方\resources\runtime\cli\bin\dsh.cmd'
$tmp = "$env:TEMP\dsh-verify"
New-Item -ItemType Directory -Force -Path "$tmp\profiles\verify\node_modules" | Out-Null
# 骨架（UTF-8 无 BOM，否则内核 JSON.parse 会抛）
[System.IO.File]::WriteAllText("$tmp\profiles\verify\package.json",
  '{"name":"dsh-profile-verify","private":true,"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-video-skin"]}}}',
  (New-Object System.Text.UTF8Encoding($false)))

$env:DSH_HOME = $tmp
& $dsh plugin --profile verify add "github:Something11235/dsh-video-skin#main"
& $dsh --profile verify --no-open --port 19388
# 用它打印出来的带令牌 URL 真跑一遍浏览器验收：
# node "D:\Projects\DSH工作台\插件制作\dsh-video-skin\scripts\verify-browser.mjs" --url "http://127.0.0.1:19388/?token=..." --shot-dir docs
```

看到 `+ dsh-video-skin 0.1.0`、并且浏览器里出现开机动画与聊天背景，就是成了。

---

## 更新流程（没有构建步骤，所以 push 即发布）

这个插件**没有构建产物**：`index.js` / `lib` / `runtime` 就是运行时读的文件，
`assets/*.mp4` 与 `assets/background.jpg` 是直接提交的素材。所以：

```powershell
# 1) 改代码 / 换素材（换素材见 README §8；换了短片就顺手跑一次 node scripts/make-still.mjs 得到配套静态图）
# 2) 跑一遍自检
node scripts/check-syntax.mjs
node --test "tests/**/*.test.mjs"
node scripts/verify-all.mjs
# 3) 改版本号（可选但推荐）
#    package.json 的 version；同时改 index.js 里的 VERSION 常量（config.json 会带出去）
# 4) 提交并推
git add -A; git commit -m "..."; git push
```

别人那边**更新要重新装**：DSH 的插件管理器目前不支持原地升级 —— 先卸载再装一次
（`dsh plugin --profile <p> remove dsh-video-skin` 然后重新 `add`）。

### 想让"只输入 `dsh-video-skin`"也能装：只能发 npm

插件管理器那个输入框的解析规则是（`@deepseek-ai/dsh-plugin-manager` 的 `install-spec` 模块）：

- 长得像包名的（`dsh-video-skin`）→ 走 **npm registry**（`pnpm view` + 装）；
- `github:` / `git+` / `git@` / `gitlab:` / `bitbucket:` / `https://…` → 走 git。

所以裸名要能用，**除了发到 npm 没有第二条路**；GitHub 上的 `dsh-plugin` topic 是给市场列表
收录用的，不改变这个输入框的解析。

```powershell
npm login
npm publish --access public
# 之后用户也能用包名安装：dsh plugin --profile web add dsh-video-skin
```

npm 通道的 tarball 内容由 `package.json` 的 `files` 白名单决定，用
`pnpm pack --dry-run` 先看一眼（当前 27 个文件，见下表），确认没有源码/测试泄漏或缺失。

---

## 两个坑（都在本仓库里踩过并写进了代码）

1. **`github:` 依赖在 pnpm 下会被拦构建脚本。** 所以这个仓库**故意不写 `prepare`**，
   并把"没有生命周期脚本"做成了一条断言。将来想加构建步骤时，改成"本地构建 + 提交产物"，
   **不要**加 `prepare`。
2. **国内网络直连 github.com 可能很慢或失败。** 装不上时：给 git/pnpm 配代理，或让用户
   fork 到你自己的账号再装 fork 的地址（`github:<对方的账号>/dsh-video-skin#main`）。
   插件管理器里那个"安装源"下拉是给 **npm 包**用的，对 `github:` 规格不生效。
