# dsh-plugin-memo

DeepSeek Harness 的项目记忆：仓库里的 `.memo/` 目录记录进度、下一步、未决问题和踩过的坑，模型和人都通过一个 `memo` 命令行读写。

## 安装

```sh
dsh plugin --profile web add Laic7092/dsh-plugin-memo
# 重启 profile 后生效
```

`lib/` 不入库，安装时由 `prepare` 编译。pnpm 默认拦截 git 依赖的构建脚本，首次 `add` 会提示 `dsh-plugin-memo` 的构建被忽略；把 `dsh-plugin-memo: true` 加到 profile 目录（`$DSH_HOME/profiles/web/`）的 `pnpm-workspace.yaml` 的 `allowBuilds` 下，再跑一次安装命令：

```yaml
allowBuilds:
  dsh-plugin-memo: true
```

`tree-sitter-wasm` / `web-tree-sitter` 是 optional，装不上只回退行内规则。装好后模型工具里只有一个 `memo`，人侧是 `/memo <命令行>`，两者共用同一份实现。

不要把这个插件再往 profile 的 `cordis.patch.yml` 里 insert 一遍：本包声明了 `dsh.bundle.patch`，`dsh plugin add` 已经写进 `dsh.profile.bundles`；重复 insert 会因 `duplicate loader entry id: memo` 让整个 profile 起不来。要改配置就写一条不带 insert 的定向 patch：

```yaml
- id: memo
  config: { refresh: false, exclude: [generated], subcommands: { scan: false } }
```

## 命令

模型侧 `memo` 工具的唯一参数是命令行字符串；人侧 `/memo` 用同一套语法。一个工具而不是每个操作一个，是为了只让一份 description 常驻模型上下文。

```
memo status     [--notes N]                        读   四节 STATUS + 最近 journal + bug 数 + 索引状态
memo handoff    [--now|--next|--open|--avoid T]    写   更新 STATUS.md，只替换传入的节
memo note       TEXT [--kind note|decision|todo]   写   向 journal.jsonl 追加一行
memo scan       [--exclude DIR]                    写   重建代码索引（本地 .memo/index.db）
memo find       QUERY [--bodies N] [--full]        读   符号/路径/正文三处一起找；首个命中给正文
memo map        [FOCUS] [--budget N]               读   按目录汇总或聚焦主题
memo bug-search TERM [--limit N]                   读   按症状检索历史修法，重复次数参与排序
memo bug-log    --error T [--cause|--fix|…]        写   记一条修复，同症状累加次数
memo help       [子命令]                            读   语法与全部选项
```

`--flag value` 与 `--flag=value` 等价；每个子命令都接 `--root PATH`，默认按 会话 cwd → 最近的 `.memo/` → 最近的 `.git` 找项目根。

## `.memo/` 目录

```
STATUS.md      现在在哪 / 下一步 / 未决问题 / 不要重犯
journal.jsonl  append-only 动作日志，一行一个 JSON
bugs.json      症状 → 原因 → 修法，同症状累加次数
.gitignore     memo scan 建的：说明下面这份索引是本地缓存
index.db       代码索引（memo scan 产出）——本地 SQLite，不进版本库
```

前三个是**记忆**：纯文本、可 diff、应当提交；写入是 tmp + rename，会写盘的子命令自动建目录。

`index.db` 是**派生缓存**：里面每个字段都能从源码重建，所以它不进版本库——`memo scan` 会顺手写好 `.memo/.gitignore`（含 `index.db` 与 WAL 模式的两个旁文件）。新克隆或换机器后跑一次 `memo scan` 就有（600 文件约 0.6s）；直接 `memo find` 会明确让你先扫一次，而不是给你一份不知道多旧的答案。


## Memo 视图

会话视图切换器里的 `Memo` 页（仅带 web carrier 的 profile），显示 STATUS、最近动作、bug、索引新鲜度，以及子命令开关和读取/刷新开关。页面里改的值只作用于当前宿主进程内存，重启后回到 composition 的值；`dirName` / `defaultRoot` / `readTools` 在页面上不可改。

## 配置

| 键 | 默认 | 作用 |
|---|---|---|
| `dirName` | `.memo` | 记忆目录名 |
| `defaultRoot` | 无 | 会话没有 cwd 时的兜底项目根 |
| `readGuard` | `true` | 重复读拦截；`false` 时不注册任何监听器 |
| `readTools` | `["read"]` | 拦截哪些读工具 |
| `exclude` | `[]` | 索引额外排除的目录名 |
| `refresh` | `true` | 查询前自动复核索引 |
| `tokenizer` | `estimated` | `exact` 用内置 DeepSeek V4 分词器精确计数；换单位会重建索引 |
| `subcommands` | 全开 | 按名字关子命令，例如 `{ scan: false }` |

## 已知限制

- `.gitignore` 只读“一行一个名字”的那部分（`lib/`、`build`、`*.min.js`）：带斜杠的锚定模式、`!` 反选和嵌套 `.gitignore` 不管，点开头的目录一律跳过。
- `memo find` 默认只展开首个命中的正文（约 80 行封顶），预算 2000 tokens；要更多用 `--bodies N` 或 `--full`。
- `refresh` 用同步 `statSync`；大项目嫌贵可设 `refresh: false`。
- `exact` 首次计数要解析 6MB 词表（约 150ms），之后常驻内存；默认 `estimated`，两种单位不能混进同一份索引。
- 索引需要 Node ≥ 22.5 的 `node:sqlite`。没有它的运行时里 `scan` / `find` / `map` 会说明原因，而 `status` / `handoff` / `note` / `bug-*` 照常工作——它们本来就是纯文本。
- 旧的 `.memo/index.json` 不再读写：可以直接删；提交过它的仓库用 `git rm --cached .memo/index.json` 取消跟踪。
- `memo status` 和 `/memo` 不复核索引，报告的索引状态可能比磁盘略旧。
- tree-sitter 是可选的：`web-tree-sitter` ^0.25 + `tree-sitter-wasm` 覆盖 JS/TS、Python、Go、Rust、GDScript 和 Godot `.tscn`/`.tres`。文件超过 500 tokens 才会解析；树里出现 ERROR 节点则整文件回退行内规则。
- `/memo` 的面板路由没有鉴权，本机任何进程都能 `POST`；改动只进内存。
- 语法写错时模型拿到用法说明而非参数校验错误；`memo help` 是语法的唯一出处。


## 开发

```sh
npm install      # node_modules 不入库；tree-sitter 是 optional
npm run build    # src/*.ts -> lib/*.js
npm run check    # tsc --noEmit
npm test         # build 后运行 111 个测试
```

`src/` 是 TypeScript 源码，`lib/` 是 `npm run build` 的产物（不入库），`tokenizer/` 是随包的 DeepSeek V4 词表。

`src/db.ts` 是索引的存储层（本地 SQLite）：`src/indexer.ts` 负责提取与排序、产出内存里的索引，`db.ts` 负责把它落成行、做增量写回和全文检索。`tsconfig.json` 开了 `strict`，但 `noImplicitAny` / `strictNullChecks` 暂关。

`test/tokenizer-vectors.json` 是 60 组逐 id 基准，由 HuggingFace `tokenizers` 读同一份词表生成。重建：

```python
pip install tokenizers
python3 -c "from tokenizers import Tokenizer; import json;
tk = Tokenizer.from_file('tokenizer/deepseek_v4.tokenizer.json');
print(json.dumps([{'s': s, 'ids': tk.encode(s, add_special_tokens=False).ids} for s in texts], ensure_ascii=False))"
```
