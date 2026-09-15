# dsh-plugin-memo

给 DeepSeek Harness 的**项目记忆**：一个跟代码一起提交的 `.memo/` 目录，外加一组让模型自己读写它的工具。
新会话能从代码里读出架构，读不出**进度**——现在做到哪、下一步是什么、哪条路试过不行。本插件就是为这件事存
在的：它自己定义格式、自己写、自己读，不依赖任何外部程序。

## 装到一个 Profile

```sh
dsh plugin --profile web add /path/to/dsh-plugin-memo
# 然后重启 profile —— 工具、/memo 命令、Memo 视图都在这之后才出现
```

`link:` 安装时包内必须有 `node_modules/@deepseek-ai/dsh-tools` 软链，否则整行加载失败。

**别把这一行再往 profile 的 `cordis.patch.yml` 里 insert 一遍。** 本包声明了 `dsh.bundle.patch`，
`dsh plugin add` 已经把它写进 `dsh.profile.bundles`；再来一条同 id 的 patch，loader 会抛
`duplicate loader entry id: memo`，**整个 profile 起不来**。要改配置就写一条**不带 insert 的**定向 patch：

```yaml
- id: memo
  config: { refresh: false, exclude: [generated], tools: { memo_scan: false } }
```

装上了吗：模型工具里有 `memo_status`，或者日志里有 `8/8 tools registered; project memory in …`。

## 模型工具（8 个）

| 工具 | 读写 | 用途 |
|---|---|---|
| `memo_scan` | **写** | 重建代码索引：文件、行数、tokens、开头注释当描述、符号+行范围、按 import 图排名。token 是 DeepSeek V4 分词器**真的**数出来的，还是 `~4 字符一个` 的估算，取决于 `tokenizer` 配置——索引里写着是哪一种 |
| `memo_find` | 只读 | 按符号/路径检索，返回带 token 预算的排序短名单；回答前自动复核索引 |
| `memo_map` | 只读 | 按目录汇总，或聚焦某个主题的文件清单 |
| `memo_status` | 只读 | 四节 STATUS + 最近 journal + bug 数 + 索引状态 |
| `memo_handoff` | **写** | 更新 STATUS.md；**只替换你传的那几节** |
| `memo_note` | **写** | 往 journal 追一行（`note` / `decision` / `todo`） |
| `memo_bug_search` | 只读 | 按症状检索历史修法，重复次数参与排序 |
| `memo_bug_log` | **写** | 记一条修复；同症状累加次数 |

会写盘的工具在描述里都写了 `WRITES`。八个都能单独关掉（见下）——关掉是**真的从工具表里摘掉**，不是藏一行。

```
/memo                 显示当前项目状态，不花模型回合
/memo note <一句话>    往 journal 记一行
```

## `.memo/` 目录

```
<你的项目>/.memo/     ← 提交进 git
  STATUS.md           现在在哪 / 下一步 / 未决问题 / 不要重犯
  journal.jsonl       append-only 动作日志，一行一个 JSON
  bugs.json           症状 → 原因 → 修法，同症状累加次数
  index.json          代码索引（memo_scan 产出）
```

全部纯文本、可 diff；写入一律 tmp + rename，journal 末行写坏了只跳过那一行；写工具自动建目录。项目根 = 显式
`root` → 会话工作目录 → 向上最近的 `.memo/` → 最近的 `.git`（最后一条让首次写入落在仓库根）。

## Memo 视图

会话的视图切换器里多一个 `Memo`（与「对话 / 轨迹 / Context」并列），切过去不花模型回合。它读当前会话的
cwd，显示 STATUS 四节、最近动作、bug 记忆、索引新鲜度，外加两组开关（默认折起，标题上就写着当前状态）：

- **工具开关**：上面 8 个工具，按领域分成「项目记忆 / 代码索引 / 缺陷记忆」三组，每组可整体全开或全关。
- **读取与刷新**：重复读拦截、查询前自动复核索引、精确/估算 token 计数、额外排除的目录。

## 配置

| 键 | 默认 | 作用 |
|---|---|---|
| `dirName` | `.memo` | 记忆目录名 |
| `defaultRoot` | 无 | 会话没有 cwd 时的兜底项目根 |
| `readGuard` | `true` | 重复读拦截；`false` 时**一个监听器都不注册** |
| `readTools` | `["read"]` | 拦截哪些读工具，例如 `["view"]` |
| `exclude` | `[]` | 索引额外排除的目录名，叠加在内置表之上 |
| `refresh` | `true` | 查询前是否自动复核索引 |
| `tokenizer` | `estimated` | token 计数方式：`exact` 用内置的 DeepSeek V4 分词器（128,000 词表，6MB）精确计数，`estimated` 用 ~4 字符一个 token 的估算。**换单位就会重建索引**——两种数不能混在一份 `index.json` 里 |
| `tools` | 全开 | 按名字关工具，例如 `{ memo_scan: false }` |

`readGuard` / `refresh` / `exclude` / `tools` / `tokenizer` 在 Memo 视图里也能改，但**只改宿主进程的内存**：重启回到
composition 的值（面板会用 `localStorage` 在下次打开时重新应用你选过的）。`dirName` / `defaultRoot` /
`readTools` 改不了——把记忆目录从读它的工具脚下挪走，不该是一个页面能做的事。

## 边界与已知限制

- **不读 `.gitignore`**：排除靠内置表（node_modules / dist / build / target / …）+ `exclude`，而且**所有点开头的目录一律跳过**。
- **`refresh` 是同步 `statSync`**：普通项目几毫秒，20,000 文件级约 0.1 秒。嫌贵就 `refresh: false`，代价是索引只在你跑 `memo_scan` 时更新。
- **精确计数是要花钱的**：`exact` 第一次计数要读 6MB 词表（约 150ms，之后常驻内存），编码本身约 1MB/s；20,000 个文件的项目一次全量 `memo_scan` 大概多花十秒。所以默认是 `estimated`，要精确就显式打开。词表在 `lib/tokenizer/deepseek_v4.tokenizer.json`，随包一起装。
- **`tokenizer` 是换单位，不是调精度**：`estimated` 索引里的数不是精确数的舍入近似，中文上可以差一倍有余（实测本 README：约 1356 估算 vs 2581 精确，差 47%）。换单位后第一次扫描/复核会重建整份索引——复用一个旧条目，就等于把另一种单位混进了同一份 `index.json`。`memo_find` 的短名单预算按索引里写明的单位扣，不会拿估算去花精确的预算。
- **`memo_status` 和 `/memo` 不复核索引**（保持零成本、瞬时返回），报的索引状态可能比磁盘旧一点。
- **tree-sitter 是可选的天窗**：`web-tree-sitter` + `tree-sitter-wasms`（约 50MB）覆盖 JS/TS、Python、Go、Rust，不装就只有行内规则（地板永远可用）。**Godot 的两门语言都没有现成 wasm**，插件自带两份：`lib/grammars/tree-sitter-gdscript.wasm`（290KB，tree-sitter-gdscript 6.1.0）和 `lib/grammars/tree-sitter-godot_resource.wasm`（11KB，tree-sitter-godot-resource 0.7.0），都由 `scripts/build-godot-grammars.mjs` 编译。所以 `.gd`、`.tscn`、`.tres` 也会走语法树，前提是 `web-tree-sitter` 在**且文件超过 500 tokens**（这个门槛永远按估算量算——不值得为一颗 6MB 的词表开一次 parse 来决定要不要 parse；低于门槛就按行内规则走，索引里的 `symbolSource` 会如实写 `regex`）。**解析出错的树不算升级**：文件里一旦有 ERROR 节点，整个文件保留行内规则的结果，天窗再坏也踩不塌地板。
- **面板的路由没有鉴权**：本机任何进程都能 `POST`；`/memo/config` 还能关掉工具或拦截——只动内存，重启即恢复。
- **Memo 视图只在带 web carrier 的 profile 里出现**：无头 profile 里 8 个工具和 `/memo` 不受影响。
- **什么时候别用它**：单次小改动、一次性脚本，或你本来就要通读整个仓库——`.memo/` 的价值来自跨会话复用，不会再有第二次的目录里它只是多四份文件。

## 开发

```sh
npm run check            # 语法检查
npm test                 # 88 个测试，0 skip
npm run build:grammars   # 重新生成 lib/grammars/ 下两份 wasm（需要 docker + tar，会自检）
node scripts/count-tokens.mjs README.md   # 用同一颗分词器数一数（--estimate 对比，--ids 出 id）
```

### 分词器

`lib/tokenizer/deepseek_v4.tokenizer.json` 是导入的 DeepSeek V4 词表（byte-level BPE，128,000 词、127,741 条
merge、1283 个 added token，连同 `tokenizer_config.json` 原样保存）。`lib/tokenizer.js` 是**不依赖任何包的纯
Node 编码器**：按文件里的三条 `Isolated` `Split` 规则切分（保留匹配之间的文本，不是只留匹配）、过 GPT-2 的
byte-to-unicode 表、按 merge 排名合并。词表 6MB，所以第一次计数才解析，解析结果挂在模块上，一个进程一次。

`test/tokenizer-vectors.json` 是 60 组 `{文本, id 序列}` 基准，由 HuggingFace `tokenizers` 读**同一份**
`tokenizer.json` 产出（即 zip 里 `deepseek_tokenizer.py` 用的那个库），覆盖中文、emoji、控制字节、行中间的特殊
token、相邻分隔符。测试逐 id 比对而不是只比长度——两个编码器可以长度相同、切法全不一样。要重新生成：

```python
pip install tokenizers
python3 -c "from tokenizers import Tokenizer; import json;
tk = Tokenizer.from_file('lib/tokenizer/deepseek_v4.tokenizer.json');
print(json.dumps([{'s': s, 'ids': tk.encode(s, add_special_tokens=False).ids} for s in texts], ensure_ascii=False))"
```
