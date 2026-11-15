# dsh-cetwt · 四六级写译训练（工作台 / 浮窗）

DeepSeek Harness（DSH）桌面端插件。左侧栏图标进入工作台，提供 **翻译 / 作文（文本）/ 作文（手写图片 OCR）** 三种训练模式，按教育部四六级官方档次评分，并把每次批改落成可统计的历史记录。

- 插件 id：`dsh-cetwt`（安装后 `plugin_manager` 里的 entryId 为 `include:dsh-cetwt`）
- 形态：与左侧「插件市场」「CET-6 工作台」一致——`sidebar.panellist`（order 43，紧挨 CET-6）里一个描边图标，点开在主区打开工作台面板 `main[key=dsh-cetwt]`；面板里再点「浮窗」可切换成可拖动 / 可缩放的浮窗（`shell.overlay`，位置记在 `localStorage['dsh-cetwt:win']`），边看对话边写译。
- 前端页面：`/cetwt/app/index.html`（纯静态，由宿主 `/cetwt` 路由提供，仅回环地址可访问）
- 真题库：`data/exams.json`，**101 套**真题（2015–2025，四级 50 / 六级 51）：作文题干 99 套、翻译中文原文 86 套、官方参考译文 50 套、官方范文 66 套。数据来自工作区的真题 DOCX 与可复制文本层 PDF，范文/译文只在能与题干对上、且无乱码时收录（同场多套的参考译文按主题词重新配对，配不上就留空，宁可缺不错贴）。

## 使用方式

1. 左侧栏找到「A」字形描边图标，点一下在主区打开「四六级写译」工作台；再点一次或点面板右上「收起」回到对话。若没看到图标，刷新一次页面（客户端 bundle 由 Web GUI 模块图热加载）。
2. 想边写边看对话：面板顶部点「浮窗」，切到可移动浮窗——拖标题栏移动，右下角斜纹手柄改尺寸，`⟲` 复位，`×`/`Esc` 收起。
3. 页面缩放：顶栏 `− / 100% / ＋`（80%–160%，点百分比回到 100%），或按住 `Ctrl` 滚滚轮；比例记在 `localStorage['cetwt:zoom']`。工作台铺满主区时内容列自动限宽 940px 居中，浮窗模式下按窗口宽度自适应。
4. 顶部选择模式、级别、真题；点「开始作答」。
5. 文本模式直接粘贴/输入英文；手写模式拖入或选择照片，先点「识别」，**识别结果可人工修正**后再「提交批改」。
6. 批改后按 `ui_schema.panel_order` 依次渲染 11 个模块：任务信息 → 原图&OCR → 你的作答 → 评分概览 → 错误明细 → 要点/结构评价 → 参考范文 → 考点记忆卡 → 提升建议 → 训练统计 → 操作按钮。
7. 「个性化提升建议」里除总体建议外，还会给出：**全文改写稿**（`revised_full`，保持原意重写整篇，一键复制）、**逐句改写**（覆盖全文每一句：原句 → 问题 → 升级版 → 升级点，右侧**并排对照真题自带的官方参考范文/参考译文**；该套没有官方文本时改为标注「模型生成，仅供参考」）、**高级词汇同义替换**（原文用词 → 推荐表达 + 差别说明 + 例句，按 23 个分类分组）。
8. 操作按钮：保存错题卡、抽取同主题复测、人工修正 OCR、清空本次记录。
9. 顶栏「高级词汇」页：每次批改产生的高级词汇会按 **23 个固定分类**（文化遗产 & 传承、传统节日民俗、传统艺术、技艺、思想典籍、名胜古迹、教育 & 校园、教育基础、大学生成长、线上教育、科技 & 网络、互联网、生活科技、利弊词、环境 & 生态环保、环保基础、污染、灾害、资源、保护、社会民生 & 发展、城市化、人口、社会保障、民生、社会热点话题、经济 & 贸易、个人品质、价值观、观点功能短语）自动归档进 `vocab-bank.json`，同一词多次出现会累计次数；点分类 chip 只看该组，每张卡可「标记已掌握 / 撤回 / 删除」，可导出 CSV 或一键生成 Anki 词表（标签即分类名）。
10. 顶栏「练习记录」页：每次批改自动落库，这里用三张折线图分别画**翻译 / 作文·文本 / 作文·手写**的成绩走势（x = 第 N 次，y = 0–15 分，点悬停看日期与套号），下面是记录列表，点任意一行可回看当次批改的完整面板；`导出成绩单` 会写出 CSV。

## 评分口径

- 翻译 15 分：`faithful 6 / vocab 4 / grammar 3 / fluency 2`
- 写作 15 分：`content 5 / coherence 3 / vocab 3 / grammar 4`
- 档位、维度、错误类型、范文词数均按官方细则写进 prompt（`index.js` 的 `RUBRIC`）。
- 分数自洽：`total_score` 恒等于四个分项之和；并根据 `error_list` 反推硬性上限（有错译/漏译 ≤12，有语法/搭配/中式错误 ≤12.5，错误≥5 条 ≤11；作文错误≥3 条 ≤12.5、≥5 条 ≤11、跑题/逻辑断层 ≤11），避免"高分多错"。
- 参考范文/译文优先使用真题自带官方文本（`ensureSample()` 覆盖模型输出），不编造、不用网络译文。

## OCR

- 走多模态模型（`deepseek-account/deepseek-flash`，声明 `inputModalities` 含 image），图片经 `ctx.attachments.saveImages()` 转成 durable `ImageAttachmentRef` 后随消息送入 `ctx.llm.stream()`。
- 纯白/无笔迹图片：`ocr_meta.is_ocr_success=false`、总分 0、不落库，并提示重拍要点。
- 识别到涂改/划掉内容时标注，不参与评分（prompt 约束）；低置信片段用 `[?]` 标注，前端 OCR 文本框可直接改后重提，生成新记录、旧记录保留。
- 手写体识别质量取决于照片：光线均匀、纸面平整、只拍作答区域、避免强反光。

## 数据落盘（`$DSH_HOME` = `C:\Users\zhiyuan\.dsh`）

| 文件 | 内容 |
| --- | --- |
| `dsh-cetwt/records.json` | 历史训练记录（原子写入 tmp+rename，最多 2000 条） |
| `dsh-cetwt/mistake-cards.md` | 「保存错题卡」追加的 Markdown 错题卡 |
| `dsh-cetwt/anki-import.tsv` | 「加入 Anki 复习队列」追加的 TSV（可直接导入 Anki） |
| `dsh-cetwt/debug-llm.json`、`last-llm-raw.txt` | 模型返回异常时的诊断样本（一般不存在） |
| `dsh-cetwt/vocab-bank.json` | 高级词汇库（按 23 分类归档、含用法/例句/出现次数/掌握标记，原子写入） |
| `dsh-cetwt/高级词汇库.csv` | 「导出 CSV」生成的词汇表（UTF-8 BOM） |
| `dsh-cetwt/anki-vocab.tsv` | 「加入 Anki」生成的词汇卡（`CET_vocab::分类` 标签） |
| `dsh-cetwt/成绩单.csv` | 「导出成绩单」生成的 CSV（UTF-8 BOM，Excel 直接打开） |

统计（`stats_panel`）由 `records.json` 现算：总次数、平均分、连续天数、各错误类型频次、薄弱标签、主题均分、翻译/作文/手写作文分项均分。

## HTTP 接口（仅 127.0.0.1）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/cetwt/api/health` | 健康检查（含 `build` 版本号、真题数、记录数、存储路径） |
| GET | `/cetwt/api/bootstrap` | 真题库 + 历史记录 + 成绩走势（`trend`）+ 统计 |
| GET | `/cetwt/api/history` | 练习记录列表（最近 200 条）+ 成绩走势 + 统计 |
| GET | `/cetwt/api/record?id=…` | 回看单次批改：返回 `{payload:{ui_schema,ocr_meta,result}, record}` |
| GET | `/cetwt/api/export` | 导出成绩单 CSV → `{ok, path, rows}` |
| GET | `/cetwt/api/debug` | 自检：客户端 bundle 是否已进入 Web GUI 模块图（`rev`、路径、字节数） |
| POST | `/cetwt/api/ocr` | `{level, mode, exam_id, image:{dataUrl,name}, writing_prompt}` → `{ok, ocr_text, note}` |
| POST | `/cetwt/api/grade` | 批改 → `{payload:{ui_schema, ocr_meta, result}, record_id}` |
| POST | `/cetwt/api/save_card` | `{record_id}` → 写错题卡 |
| POST | `/cetwt/api/anki` | `{record_id}` → 写 Anki TSV |
| POST | `/cetwt/api/retest` | `{level, task_type, theme, except_id}` → 同主题另一套真题 |
| POST | `/cetwt/api/clear` | `{record_id}` → 删除一条记录并返回新 bootstrap |
| GET | `/cetwt/api/vocab` | 高级词汇库：`{ok, categories, summary, items}` |
| GET | `/cetwt/api/vocab_export` | 导出词汇 CSV → `{ok, path, rows}` |
| POST | `/cetwt/api/vocab` | `{action:"master"\|"unmaster"\|"delete", key}` |
| POST | `/cetwt/api/vocab_anki` | 导出未掌握词汇到 Anki TSV → `{ok, path, rows}` |
| POST | `/cetwt/api/reset` | `{scope:"artifacts"}` 清空派生产物；`{scope:"all"}` 连记录一起清空；`{scope:"vocab"}` 清空词汇库 |

## 开发

```powershell
# 语法与结构自检（不需要启动 DSH）
& 'C:\Users\zhiyuan\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' build\test-host.mjs
& 'C:\Users\zhiyuan\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' build\test-client.mjs
```

**改完 `index.js` 必须重载宿主侧代码**（不会被文件监听热更新）：在 `plugin_manager` 里对 `include:dsh-cetwt` 先 `enabled:false` 再 `enabled:true`，然后用 `/cetwt/api/health` 的 `build` 字段确认新版本已生效。客户端 `lib/client.js` 由 Web GUI 的模块图按 `rev` 热加载，若未生效刷新页面即可。

真题库重新生成：`python tools\extract_docx.py` → `python tools\extract_pdf_text.py` → 解析稿套次抽取 → `python tools\build_exams.py`（合并 + 清洗 + 校验）→ 覆盖 `data/exams.json`。质量自检 `python tools\check_exams.py` 会写出 `tools/out/exams_quality.json`。

## 已知边界

- 真题库覆盖 2015–2025 共 101 套；其中 26 套取自 DOCX（范文/译文最干净），75 套取自 PDF 文本层。31 个扫描版解析 PDF 无文本层，未做视觉 OCR 补录。
- 部分真题 PDF 的字体子集损坏会抽掉字符（如 `2019年6月四级真题第一套` 抽成 "ou are allowed… your y campus…"、`no more than] 80 words`）。构建脚本的处理：词数要求句整句剥掉并按本级官方区间重写（四级 120–180、六级 150–200）；整段题干仍不可辨认的（目前 2 套）直接不提供写作任务，只保留翻译。
- PDF 文本层常有双栏混排（正文与旁批交织），构建脚本会剥掉中文旁批、圈号注标、尾部词表与未完成句；**无法自动判定的内容宁可留空也不收录**，因此部分套次只有题干、暂无官方范文/译文（此时范文由模型按本级词数现场生成，并在面板标注）。
- 少数套次原始资料本身有瑕疵（如 `cet6-201712-3` 官方译文全小写、`cet4-201512-1` 题干保留原始拼写），保留原样，不做"美化"。
- 模型评分为概率性输出，同一篇作文两次批改可能相差 0.5–1 分；写作训练以错误清单与逐条修正为主，分数看趋势。
