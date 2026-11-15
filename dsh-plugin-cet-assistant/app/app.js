/* CET4/CET6 写译训练 — 侧边栏前端（无构建，原生 JS）
 * 渲染完全由服务端返回的 {ui_schema, ocr_meta, result} 驱动。
 */
(function () {
  "use strict";

  var API = "/cetwt/api/";
  var S = {
    mode: "translation",
    level: "CET6",
    examId: "",
    answer: "",
    image: null,          // { dataUrl, name }
    ocrText: "",
    ocrNote: "",
    busy: "",
    payload: null,        // { ui_schema, ocr_meta, result }
    boot: { exams: [], records: [], stats: null },
    folds: {},
    recordId: null,
    view: "practice",     // practice | records | replay
    history: { trend: [], records: [], stats: null },
    replayId: null,
    vocab: { items: [], summary: null, groups: [] },
    vfilter: ''
  };

  var elScroll = document.getElementById("scroll");
  var elBar = document.getElementById("actionbar");
  var elToast = document.getElementById("toast");
  var elLevel = document.getElementById("sel-level");
  var elExam = document.getElementById("sel-exam");
  var elSeg = document.getElementById("seg-mode");

  /* ---------------- utils ---------------- */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function words(s) {
    var m = String(s || "").trim().match(/[A-Za-z][A-Za-z'’-]*/g);
    return m ? m.length : 0;
  }
  var toastTimer = null;
  function toast(msg) {
    elToast.textContent = msg;
    elToast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { elToast.classList.remove("show"); }, 2600);
  }
  function api(path, body) {
    var opt = { method: body === undefined ? "GET" : "POST", headers: {} };
    if (body !== undefined) {
      opt.headers["content-type"] = "application/json";
      opt.body = JSON.stringify(body);
    }
    return fetch(API + path, opt).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (e) { /* ignore */ }
        if (!r.ok) {
          var msg = (j && (j.error || j.message)) || ("HTTP " + r.status);
          throw new Error(msg);
        }
        if (!j) throw new Error("返回内容不是合法 JSON");
        return j;
      });
    });
  }

  function isWriting() { return S.mode !== "translation"; }
  function isImage() { return S.mode === "writing-image"; }
  function taskType() { return isWriting() ? "writing" : "translation"; }

  function examList() {
    return (S.boot.exams || []).filter(function (e) { return e.level === S.level; });
  }
  function currentExam() {
    var list = examList(), i;
    for (i = 0; i < list.length; i++) if (list[i].id === S.examId) return list[i];
    return null;
  }
  function examSupports(e, kind) {
    if (!e) return false;
    if (kind === "translation") return !!(e.zh_source && e.zh_source.length > 40);
    return !!(e.writing_prompt && e.writing_prompt.length > 20);
  }
  // 默认选中：本级最新一场的第 1 套（当前 = 2025 年 12 月第 1 套）
  function pickDefaultExam(list, level, tt) {
    var pool = (list || []).filter(function (e) { return e.level === level && examSupports(e, tt); });
    if (!pool.length) pool = (list || []).filter(function (e) { return examSupports(e, tt); });
    if (!pool.length) return null;
    var dates = pool.map(function (e) { return e.exam_date || ""; }).sort();
    var newest = dates[dates.length - 1];
    var same = pool.filter(function (e) { return (e.exam_date || "") === newest; });
    same.sort(function (a, b) { return (a.set || 9) - (b.set || 9); });
    return same[0];
  }

  /* ---------------- header / pickers ---------------- */
  function renderModeSeg() {
    Array.prototype.forEach.call(elSeg.querySelectorAll("button"), function (b) {
      b.classList.toggle("on", b.getAttribute("data-mode") === S.mode);
    });
  }

  function renderExams() {
    var list = examList();
    var opts = [];
    if (!list.length) {
      opts.push('<option value="">（暂无可用真题）</option>');
    }
    var byDate = {};
    list.forEach(function (e) {
      (byDate[e.exam_date] = byDate[e.exam_date] || []).push(e);
    });
    Object.keys(byDate).sort().reverse().forEach(function (d) {
      opts.push('<optgroup label="' + esc(d + " · " + S.level) + '">');
      byDate[d].forEach(function (e) {
        var ok = examSupports(e, taskType());
        opts.push('<option value="' + esc(e.id) + '"' + (e.id === S.examId ? " selected" : "") +
          (ok ? "" : " disabled") + '>第' + (e.set || 1) + "套 · " + esc(e.topic || "综合") +
          (ok ? "" : "（无本题型）") + "</option>");
      });
      opts.push("</optgroup>");
    });
    elExam.innerHTML = opts.join("");
    if (!S.examId && list.length) {
      var first = list.filter(function (e) { return examSupports(e, taskType()); })[0];
      if (first) { S.examId = first.id; elExam.value = first.id; }
    }
  }

  /* ---------------- input view ---------------- */
  function panel(title, bodyHtml, opt) {
    opt = opt || {};
    var key = opt.key || title;
    var closed = S.folds[key];
    if (closed === undefined) closed = !!opt.fold;
    return '<section class="panel' + (closed ? " closed" : "") + (opt.cls ? " " + opt.cls : "") +
      '" data-key="' + esc(key) + '">' +
      "<h3>" + esc(title) + (opt.tag ? '<span class="tag">' + esc(opt.tag) + "</span>" : "") +
      '<span class="caret">▾</span></h3><div class="body">' + bodyHtml + "</div></section>";
  }

  function sourceBlock() {
    var e = currentExam();
    if (!e) return '<div class="hint">请选择真题。</div>';
    if (!isWriting()) {
      if (!e.zh_source) return '<div class="hint">该套真题未收录中文原文（扫描件无文字层）。</div>';
      return '<div class="src-box zh">' + esc(e.zh_source) + "</div>";
    }
    var p = e.writing_prompt || "";
    return '<div class="src-box">' + esc(p) + "</div>" +
      (e.word_limit ? '<div class="hint" style="margin-top:6px">字数要求：' + esc(e.word_limit) + " 词</div>" : "");
  }

  function answerBlock() {
    if (isImage()) {
      var thumb = S.image ? '<img class="thumb" src="' + S.image.dataUrl + '" alt="手写作答" />' : "";
      var ocrBox = S.ocrText
        ? '<div class="row between" style="margin-top:10px"><span class="hint">OCR识别结果，可人工校对</span>' +
          '<button class="btn small" data-act="reocr">重新识别</button></div>' +
          '<textarea id="ocr-text" spellcheck="false">' + esc(S.ocrText) + "</textarea>" +
          (S.ocrNote ? '<div class="fold-note" style="margin-top:8px">' + esc(S.ocrNote) + "</div>" : "")
        : "";
      return '<div class="dropzone" id="drop">点击选择 / 拖入手写作文照片<div class="hint" style="margin-top:4px">支持 JPG / PNG / WebP，尽量保证光线均匀、字迹清晰</div></div>' +
        thumb + ocrBox;
    }
    var n = words(S.answer);
    var limit = currentExam() && currentExam().word_limit;
    var over = limit && /^\d+$/.test(limit) && n > parseInt(limit, 10) + 40;
    return '<textarea class="answer" id="answer" spellcheck="false" placeholder="' +
      (isWriting() ? "在此输入你的英文作文…" : "在此输入你的英文译文…") + '">' + esc(S.answer) + "</textarea>" +
      '<div class="row between" style="margin-top:6px"><span class="hint">仅统计英文词数</span>' +
      '<span class="counter' + (over ? " over" : "") + '" id="counter">' + n + " 词</span></div>";
  }

  function renderInput() {
    var e = currentExam();
    var head = [];
    head.push('<div class="score-hero" style="background:#fbfcfe;border-color:var(--line)">' +
      '<div class="total" style="font-size:20px;color:var(--ink)">' + (S.mode === "translation" ? "译" : "写") +
      "</div><div>" +
      '<div style="font-weight:700">' + (isWriting() ? "作文（" + (isImage() ? "手写图片" : "文本") + "）" : "翻译") +
      " · " + esc(S.level) + "</div>" +
      '<div class="grade">' + (e ? esc((e.exam_date || "") + " 第" + (e.set || 1) + "套 · " + (e.topic || "综合")) : "未选择真题") +
      "</div></div></div>");

    var html = head.join("");
    html += panel(isWriting() ? "写作题干" : "中文原文（真题）", sourceBlock(), { key: "src" });
    html += panel("你的作答" + (isImage() ? "（手写图片）" : ""), answerBlock(), { key: "ans" });
    if (!isImage() && S.mode === "writing-text") {
      html += '<div class="hint" style="margin:-4px 0 12px 2px">提示：手写作答请切换到「作文·手写」并上传照片，系统会先做 OCR 再批改。</div>';
    }
    elScroll.innerHTML = html;
    elBar.innerHTML = submitBar();
    wireInput();
  }

  function submitBar() {
    var busy = !!S.busy;
    var can = isImage() ? !!S.image : S.answer.trim().length > 10;
    var label = busy ? (S.busy === "ocr" ? "识别中…" : "批改中…") : (isImage() ? "识别并批改" : "开始批改");
    return '<button class="btn primary" data-act="submit"' + (busy || !can ? " disabled" : "") + ">" + esc(label) + "</button>" +
      (isImage() ? '<button class="btn" data-act="ocr"' + (busy || !S.image ? " disabled" : "") + ">仅识别</button>" : "") +
      '<button class="btn" data-act="reset"' + (busy ? " disabled" : "") + ">清空作答</button>";
  }

  function wireInput() {
    var ta = document.getElementById("answer");
    if (ta) {
      ta.addEventListener("input", function () {
        S.answer = ta.value;
        var c = document.getElementById("counter");
        if (c) { c.textContent = words(ta.value) + " 词"; }
        var b = elBar.querySelector('[data-act="submit"]');
        if (b) b.disabled = !S.answer.trim() || S.answer.trim().length < 10;
      });
    }
    var ot = document.getElementById("ocr-text");
    if (ot) {
      ot.addEventListener("input", function () { S.ocrText = ot.value; });
    }
    var dz = document.getElementById("drop");
    if (dz) {
      dz.addEventListener("click", function () { pickImage(); });
      dz.addEventListener("dragover", function (ev) { ev.preventDefault(); dz.classList.add("hot"); });
      dz.addEventListener("dragleave", function () { dz.classList.remove("hot"); });
      dz.addEventListener("drop", function (ev) {
        ev.preventDefault(); dz.classList.remove("hot");
        if (ev.dataTransfer.files && ev.dataTransfer.files[0]) readImage(ev.dataTransfer.files[0]);
      });
    }
  }

  function pickImage() {
    var inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "image/png,image/jpeg,image/webp";
    inp.addEventListener("change", function () {
      if (inp.files && inp.files[0]) readImage(inp.files[0]);
    });
    inp.click();
  }

  function readImage(file) {
    if (file.size > 8 * 1024 * 1024) { toast("图片过大（>8MB），请压缩后再上传"); return; }
    var fr = new FileReader();
    fr.onload = function () {
      S.image = { dataUrl: String(fr.result), name: file.name };
      S.ocrText = ""; S.ocrNote = "";
      renderInput();
      toast("已载入图片，点击「识别并批改」");
    };
    fr.readAsDataURL(file);
  }

  /* ---------------- result view ---------------- */
  var DIMS = {
    translation: [
      ["faithful", "信息忠实度", 6], ["vocab", "词汇选词", 4],
      ["grammar", "语法句式", 3], ["fluency", "语域流畅度", 2]
    ],
    writing: [
      ["content", "内容扣题", 5], ["coherence", "结构连贯", 3],
      ["vocab", "词汇表达", 3], ["grammar", "语法句式", 4]
    ]
  };

  function panelTitle(schema, id, fallback) {
    var cfg = (schema && schema.panel_config && schema.panel_config[id]) || {};
    return cfg.title || fallback;
  }
  function panelFold(schema, id) {
    var cfg = (schema && schema.panel_config && schema.panel_config[id]) || {};
    return !!cfg.fold;
  }

  function viewTaskHeader(schema, res) {
    var isT = res.task_type === "translation";
    var dims = DIMS[isT ? "translation" : "writing"];
    var bars = dims.map(function (d) {
      var v = Number((res.dim_score || {})[d[0]] || 0);
      var pct = Math.max(0, Math.min(100, (v / d[2]) * 100));
      return '<div class="dim"><span class="name">' + d[1] + '</span><span class="track"><span class="fill" style="width:' +
        pct.toFixed(1) + '%"></span></span><span class="val"><b>' + v + "</b>/" + d[2] + "</span></div>";
    }).join("");
    var e = currentExam();
    return '<div class="score-hero"><div class="total">' + res.total_score + "<small>/15</small></div>" +
      '<div style="flex:1"><div class="grade">' + esc(res.grade_desc || "") + "</div>" +
      '<div class="grade-tag">' + (isT ? "翻译 · " : "作文 · ") + esc(S.level) +
      (e ? " · " + esc((e.exam_date || "") + " 第" + (e.set || 1) + "套") : "") + "</div></div></div>" +
      '<div class="dim-bars">' + bars + "</div>";
  }

  function viewOcr(meta) {
    var img = S.image ? '<img class="thumb" src="' + S.image.dataUrl + '" alt="原图" />' : "";
    var raw = '<div class="hint">OCR识别结果，可人工校对</div><div class="src-box" style="margin-top:6px">' +
      esc(meta.ocr_raw_text || "") + "</div>" + (img ? '<div style="margin-top:8px">' + img + "</div>" : "");
    var note = meta.confidence_note ? '<div class="fold-note" style="margin-top:8px">' + esc(meta.confidence_note) + "</div>" : "";
    var fail = meta.is_ocr_success === false
      ? '<div class="fold-note" style="margin-top:8px;color:var(--err);background:var(--err-soft);border-color:#f3c9c4">识别失败：未能在图片中提取到英文手写内容，请重新上传清晰照片。</div>'
      : "";
    return raw + note + fail;
  }

  function viewInputPanel(res) {
    var txt = S.ocrText || S.answer || "";
    if (!txt) return '<div class="hint">（空）</div>';
    return '<div class="src-box" id="user-text">' + esc(txt) + "</div>";
  }

  function viewScore(schema, res) {
    var isT = res.task_type === "translation";
    var dims = DIMS[isT ? "translation" : "writing"];
    var cmt = res.dim_comment || {};
    var rows = dims.map(function (d) {
      var v = Number((res.dim_score || {})[d[0]] || 0);
      return "<tr><td>" + d[1] + "</td><td class=\"sc\">" + v + "</td><td>" + esc(cmt[d[0]] || "") + "</td></tr>";
    }).join("");
    return '<table class="dims"><thead><tr><th>维度</th><th>得分</th><th>评语</th></tr></thead><tbody>' +
      rows + '</tbody><tfoot><tr><td><b>合计</b></td><td class="sc">' + res.total_score + "</td><td>" +
      esc(res.grade_desc || "") + "</td></tr></tfoot></table>";
  }

  function viewErrors(res) {
    var list = res.error_list || [];
    if (!list.length) return '<div class="hint">本篇未检出错点，保持这个水平！</div>';
    var isT = res.task_type === "translation";
    return list.map(function (it) {
      var src = isT && it.source_fragment
        ? '<div class="line"><span class="k">原文</span><span class="zhq">' + esc(it.source_fragment) + "</span></div>"
        : "";
      var user = it.user_fragment
        ? '<div class="line"><span class="k">你的句子</span><span class="wrong">' + esc(it.user_fragment) + "</span></div>"
        : "";
      var fix = it.correct_version
        ? '<div class="line"><span class="k">修正</span><span class="right">' + esc(it.correct_version) + "</span></div>"
        : "";
      var exp = it.explanation ? '<div class="exp">' + esc(it.explanation) + "</div>" : "";
      return '<div class="err-card"><div class="head"><span class="type-tag">' + esc(it.error_type || "错误") +
        "</span></div>" + src + user + fix + exp + "</div>";
    }).join("");
  }

  function viewInfo(res) {
    if (res.task_type === "translation") {
      var lost = res.lost_info || [];
      if (!lost.length) return '<div class="hint">要点完整，无遗漏信息点。</div>';
      return '<div class="hint" style="margin-bottom:6px">遗漏信息点</div><ul class="bullets">' +
        lost.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>";
    }
    return '<div class="passage">' + esc(res.structure_comment || "（无）") + "</div>";
  }

  function viewSample(res) {
    var text = res.task_type === "translation" ? res.learn_version : res.sample_essay;
    if (!text) return '<div class="hint">本题暂无可背诵的参考答案。</div>';
    return '<div class="hint" style="margin-bottom:6px">参考范文（适配本级），建议整段背诵</div>' +
      '<div class="passage">' + esc(text) + "</div>";
  }

    /* ---------------- 高级词汇（分类整理） ---------------- */
  var VOCAB_GROUPS_FALLBACK = [
    { name: '文化与传承', categories: ['文化遗产 & 传承', '传统节日民俗', '传统艺术、技艺', '思想典籍', '名胜古迹'] },
    { name: '教育与成长', categories: ['教育 & 校园', '教育基础', '大学生成长', '线上教育'] },
    { name: '科技与网络', categories: ['科技 & 网络', '互联网、生活科技'] },
    { name: '环境与生态', categories: ['环境 & 生态环保', '环保基础', '污染、灾害', '资源、保护'] },
    { name: '社会与民生', categories: ['社会民生 & 发展', '城市化、人口', '社会保障、民生', '社会热点话题'] },
    { name: '经济与表达', categories: ['经济 & 贸易', '个人品质、价值观', '利弊词', '观点功能短语'] }
  ];

  function vocabGroups() {
    return (S.vocab && S.vocab.summary && S.vocab.summary.groups) || VOCAB_GROUPS_FALLBACK;
  }

  function vocabByCategory(items) {
    var map = {};
    (items || []).forEach(function (v) {
      var c = v.category || "观点功能短语";
      (map[c] = map[c] || []).push(v);
    });
    return map;
  }

  function vcard(v, opts) {
    var o = opts || {};
    var usage = v.usage ? '<span class="vusage">' + esc(v.usage) + "</span>" : "";
    var hits = v.hits > 1 ? '<span class="vhits">×' + v.hits + "</span>" : "";
    var src = v.source && v.source.exam_date
      ? '<span class="vsrc">' + esc(v.source.exam_date + " 第" + (v.source.set || "?") + "套") + "</span>"
      : "";
    var btns = o.actions === false ? "" :
      '<div class="vacts">' +
      (v.mastered
        ? '<button class="mini" data-act="vocab_unmaster" data-key="' + esc(v.key) + '">已掌握</button>'
        : '<button class="mini" data-act="vocab_master" data-key="' + esc(v.key) + '">标记掌握</button>') +
      '<button class="mini danger" data-act="vocab_delete" data-key="' + esc(v.key) + '">删除</button>' +
      "</div>";
    return '<div class="vcard' + (v.mastered ? " done" : "") + '">' +
      '<div class="vhead"><b class="vterm">' + esc(v.term) + "</b>" + usage + hits + src + "</div>" +
      (v.cn ? '<div class="vcn">' + esc(v.cn) + "</div>" : "") +
      (v.example ? '<div class="veg">' + esc(v.example) + "</div>" : "") +
      (v.basic ? '<div class="vbasic">原表达：' + esc(v.basic) + "</div>" : "") +
      btns +
      "</div>";
  }

  /** 按分类分组的词汇卡片（details/summary 折叠，默认展开有词的分类） */
  function vocabGrouped(items, opts) {
    var o = opts || {};
    var map = vocabByCategory(items);
    var cats = Object.keys(map);
    if (!cats.length) return '<div class="chart-empty">' + (o.empty || "还没有记录到高级词汇。") + "</div>";
    return cats.map(function (cat) {
      var list = map[cat];
      return '<details class="vcat"' + (o.open === false ? "" : " open") + '><summary>' +
        esc(cat) + '<span class="vcount">' + list.length + "</span></summary>" +
        list.map(function (v) { return vcard(v, o); }).join("") + "</details>";
    }).join("");
  }

  function viewKnowledge(res) {
    var pts = res.review_points || [];
    var out = "";
    if (pts.length) {
      out += '<div class="sub-h">考点记忆卡</div>' + pts.map(function (p) {
        var s = String(p), i = s.indexOf("｜");
        if (i < 0) i = s.indexOf("—");
        var term = i > 0 ? s.slice(0, i) : s;
        var note = i > 0 ? s.slice(i + 1) : "";
        return '<div class="kcard"><div class="term">' + esc(term) + "</div>" +
          (note ? '<div class="zh">' + esc(note) + "</div>" : "") + "</div>";
      }).join("");
    }
    var vu = res.vocab_upgrade || [];
    if (vu.length) {
      out += '<div class="sub-h">本篇高级词汇（已按分类记入「高级词汇」板块）</div>' +
        vocabGrouped(vu, { actions: false, open: true });
    }
    return out || '<div class="hint">（无）</div>';
  }

  function viewSuggest(res) {
    var html = '<div class="suggest">' + esc(res.personal_suggestion || "（无）") + "</div>";
    if (res.revised_full) {
      html += '<div class="sub-h">全文改写稿（可直接背诵 / 对照抄写）' +
        '<button class="mini" data-act="copy_revised">复制</button></div>' +
        '<div class="revised" id="revised-text">' + esc(res.revised_full) + "</div>";
    }
    var sr = res.sentence_review || [];
    if (sr.length) {
      var isTrans = res.task_type === "translation";
      var official = isTrans ? (res.learn_version || "") : (res.sample_essay || "");
      var cards = sr.map(function (s, idx) {
        return '<div class="sent-card">' +
          '<div class="sn">' + (idx + 1) + "</div>" +
          '<div class="orig">' + esc(s.sentence) + "</div>" +
          (s.issue ? '<div><span class="issue">' + esc(s.issue) + "</span></div>" : "") +
          (s.revision ? '<div class="rev">' + esc(s.revision) + "</div>" : "") +
          (s.upgrade ? '<div class="up">升级点：' + esc(s.upgrade) + "</div>" : "") +
          "</div>";
      }).join("");
      var refHtml = official
        ? official.split(/\n+/).filter(function (p) { return p.trim(); })
            .map(function (p) { return "<p>" + esc(p.trim()) + "</p>"; }).join("")
        : '<div class="hint">本题暂无真题自带的' + (isTrans ? "参考译文" : "参考范文") + "。</div>";
      var refLabel = res.sample_official
        ? "官方" + (isTrans ? "参考译文" : "参考范文") + "（真题自带，逐句对照）"
        : "参考" + (isTrans ? "译文" : "范文") + "（模型生成，仅供参考，非真题官方文本）";
      html += '<div class="sub-h">逐句改写（全篇 ' + sr.length + " 句）· 右侧对照" +
        (res.sample_official ? "官方" : "") + (isTrans ? "参考译文" : "参考范文") + "</div>" +
        '<div class="cmp">' +
        '<div class="cmp-col"><div class="cmp-h">你的逐句改写</div>' + cards + "</div>" +
        '<div class="cmp-col"><div class="cmp-h">' + refLabel + "</div>" +
        '<div class="passage cmp-text">' + refHtml + "</div></div>" +
        "</div>";
    }
    var vu = res.vocab_upgrade || [];
    if (vu.length) {
      html += '<div class="sub-h">高级词汇同义替换（' + vu.length + " 组）</div>" + vocabGrouped(vu, { open: true });
    }
    return html;
  }

function viewStats(res) {
    var st = S.boot.stats || {};
    var recs = S.boot.records || [];
    var avg = st.avg_total == null ? "—" : Number(st.avg_total).toFixed(1);
    var n = st.count == null ? recs.length : st.count;
    var dist = st.error_types || {};
    var keys = Object.keys(dist).sort(function (a, b) { return dist[b] - dist[a]; }).slice(0, 6);
    var maxv = keys.length ? dist[keys[0]] : 1;
    var bars = keys.map(function (k) {
      var w = Math.max(6, (dist[k] / maxv) * 100);
      return '<div class="bar-row"><span>' + esc(k) + '</span><span class="track"><span class="fill" style="width:' +
        w.toFixed(0) + '%"></span></span><span style="text-align:right;color:var(--ink-soft)">' + dist[k] + "</span></div>";
    }).join("");
    var weak = (st.weak_tags || []).map(function (t) { return '<span class="pill warn">' + esc(t) + "</span>"; }).join("");
    var thisDist = {};
    (res.error_list || []).forEach(function (it) { thisDist[it.error_type] = (thisDist[it.error_type] || 0) + 1; });
    var mine = Object.keys(thisDist).map(function (k) {
      return '<span class="pill">' + esc(k) + " × " + thisDist[k] + "</span>";
    }).join("");
    var retest = st.retested
      ? '<div class="hint" style="margin-top:10px;margin-bottom:4px">错题复测：已复测 ' + st.retested + ' 套' +
        (st.retest_avg_delta == null ? "" : " · 平均变化 " + (st.retest_avg_delta >= 0 ? "+" : "") + Number(st.retest_avg_delta).toFixed(1) + " 分") +
        (st.retest_last_delta == null ? "" : " · 最近一次 " + (st.retest_last_delta >= 0 ? "+" : "") + Number(st.retest_last_delta).toFixed(1) + " 分") +
        "</div>"
      : "";
    return '<div class="stat-grid"><div class="stat"><b>' + n + "</b><span>累计批改</span></div>" +
      '<div class="stat"><b>' + avg + '</b><span>历史平均分</span></div>' +
      '<div class="stat"><b>' + (st.streak || 0) + "</b><span>连续训练(天)</span></div></div>" +
      '<div class="hint" style="margin:2px 0 6px">本次错误类型分布</div><div class="pill-list" style="margin-bottom:10px">' +
      (mine || '<span class="hint">无</span>') + "</div>" +
      (keys.length ? '<div class="hint" style="margin-bottom:6px">历史高频错误</div><div class="bars" style="margin-bottom:10px">' + bars + "</div>" : "") +
      (weak ? '<div class="hint" style="margin-bottom:6px">薄弱标签</div><div class="pill-list">' + weak + "</div>" : "") +
      retest +
      (st.avg_theme ? '<div class="hint" style="margin-top:10px;margin-bottom:4px">主题均分：' + esc(st.avg_theme) + "</div>" : "");
  }

  var MODE_LABEL = { translation: "翻译", writing: "作文·文本", "writing-image": "作文·手写" };
  var MODE_COLOR = { translation: "#1a73e8", writing: "#0f9b6c", "writing-image": "#e08a00" };

  function fmtTime(ts) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "—";
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return (d.getMonth() + 1) + "/" + d.getDate() + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function seriesOf(trend, mode) {
    return (trend || []).filter(function (p) { return p.mode === mode; });
  }

  /* 单板块成绩折线：x = 第 N 次（按时间升序），y = 0–15 分 */
  function chartSvg(points, color) {
    var W = 620, H = 168, padL = 26, padR = 10, padT = 12, padB = 22;
    var x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
    function X(i) { return points.length <= 1 ? (x0 + x1) / 2 : x0 + (i * (x1 - x0)) / (points.length - 1); }
    function Y(v) { return y1 - (Math.max(0, Math.min(15, Number(v) || 0)) / 15) * (y1 - y0); }
    var grid = [0, 5, 10, 15].map(function (v) {
      return '<line x1="' + x0 + '" x2="' + x1 + '" y1="' + Y(v).toFixed(1) + '" y2="' + Y(v).toFixed(1) + '" stroke="#eef1f6" stroke-width="1"/>' +
        '<text x="' + (x0 - 5) + '" y="' + (Y(v) + 3.4).toFixed(1) + '" font-size="9" fill="#9aa3b2" text-anchor="end">' + v + "</text>";
    }).join("");
    var path = points.map(function (p, i) {
      return (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(p.total).toFixed(1);
    }).join(" ");
    var dots = points.map(function (p, i) {
      var tone = p.total >= 13 ? "#0f9b6c" : p.total >= 10 ? color : p.total >= 7 ? "#e08a00" : "#d93025";
      var title = fmtTime(p.t) + " · " + Number(p.total).toFixed(1) + " 分 · " + (p.exam_date || "") + " 第" + (p.set || "?") + "套";
      return '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(p.total).toFixed(1) + '" r="3.4" fill="#fff" stroke="' + tone + '" stroke-width="2">' +
        "<title>" + esc(title) + "</title></circle>";
    }).join("");
    var labels = "";
    if (points.length) {
      labels += '<text x="' + x0 + '" y="' + (H - 6) + '" font-size="9" fill="#9aa3b2">' + esc(fmtTime(points[0].t)) + "</text>";
      if (points.length > 1) {
        labels += '<text x="' + x1 + '" y="' + (H - 6) + '" font-size="9" fill="#9aa3b2" text-anchor="end">' +
          esc(fmtTime(points[points.length - 1].t)) + "</text>";
      }
    }
    return '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="成绩折线图">' + grid +
      (points.length > 1 ? '<path d="' + path + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' : "") +
      dots + labels + "</svg>";
  }

  function renderRecords() {
    var h = S.history || {};
    var st = h.stats || S.boot.stats || {};
    var trend = h.trend || [];
    var list = h.records || S.boot.records || [];
    var totals = trend.map(function (p) { return Number(p.total); }).filter(function (v) { return isFinite(v); });
    var best = totals.length ? Math.max.apply(null, totals) : null;
    var latest = trend.length ? trend[trend.length - 1] : null;

    var hero = '<div class="rec-hero">' +
      '<div class="stat"><b>' + (st.count == null ? totals.length : st.count) + "</b><span>累计批改</span></div>" +
      '<div class="stat"><b>' + (st.avg_total == null ? "—" : Number(st.avg_total).toFixed(1)) + "</b><span>平均分</span></div>" +
      '<div class="stat"><b>' + (best == null ? "—" : best.toFixed(1)) + "</b><span>最高分</span></div>" +
      '<div class="stat"><b>' + (latest ? Number(latest.total).toFixed(1) : "—") + "</b><span>最近一次</span></div>" +
      "</div>";

    var charts = ["translation", "writing", "writing-image"].map(function (mode) {
      var pts = seriesOf(trend, mode);
      var avg = st[mode === "translation" ? "avg_translation" : mode === "writing" ? "avg_writing" : "avg_writing_image"];
      var head = '<div class="chart-title"><b>' + MODE_LABEL[mode] + "（" + pts.length + " 次）</b><span>" +
        (avg == null ? "平均 —" : "平均 " + Number(avg).toFixed(1)) + "</span></div>";
      var body = pts.length
        ? chartSvg(pts, MODE_COLOR[mode])
        : '<div class="chart-empty">还没有「' + MODE_LABEL[mode] + "」的批改记录，练一次这里就会画出折线。</div>";
      return '<div class="chart-box">' + head + body + "</div>";
    }).join("");

    var rows = list.map(function (r) {
      var mode = r.task_type === "translation" ? "translation" : r.input_mode === "image" ? "writing-image" : "writing";
      var sub = (r.topic || "") + " · " + (r.level || "") + (r.retested ? " · 已复测" : "");
      return '<div class="rec-row" data-record="' + esc(r.id) + '" title="点击回看当次批改">' +
        '<span class="when">' + esc(fmtTime(r.created_at)) + "</span>" +
        '<span class="what"><span class="mode-tag ' + mode + '">' + MODE_LABEL[mode] + "</span><b>" +
        esc((r.exam_date || "") + " 第" + (r.set || "?") + "套") + "</b><span>" + esc(sub) + "</span></span>" +
        '<span class="score">' + (r.total_score == null ? "—" : Number(r.total_score).toFixed(1)) + "</span>" +
        '<span class="go">回看 ›</span></div>';
    }).join("");

    elScroll.innerHTML = hero + charts +
      '<div class="hint" style="margin:2px 0 6px">最近记录 · 点一行回看当次批改</div>' +
      (rows ? '<div class="rec-list">' + rows + "</div>" : '<div class="chart-empty">还没有练习记录。</div>');
    elBar.innerHTML = '<button class="btn" data-act="go_practice">返回练习</button>' +
      '<button class="btn" data-act="refresh_history">刷新数据</button>' +
      '<button class="btn" data-act="export_history">导出成绩单</button>';
    elScroll.scrollTop = 0;
  }

  function renderVocab() {
    var v = S.vocab || { items: [], summary: null };
    var st = v.summary || {};
    var groups = vocabGroups();
    var items = v.items || [];
    var mastered = items.filter(function (x) { return x.mastered; }).length;
    var cats = {};
    items.forEach(function (x) { cats[x.category] = (cats[x.category] || 0) + 1; });
    var covered = Object.keys(cats).length;
    var total = st.total == null ? items.length : st.total;

    var hero = '<div class="rec-hero">' +
      '<div class="stat"><b>' + total + "</b><span>高级词汇</span></div>" +
      '<div class="stat"><b>' + (st.mastered == null ? mastered : st.mastered) + "</b><span>已掌握</span></div>" +
      '<div class="stat"><b>' + (total - (st.mastered == null ? mastered : st.mastered)) + "</b><span>待复习</span></div>" +
      '<div class="stat"><b>' + covered + "/23</b><span>分类覆盖</span></div>" +
      "</div>";

    var chips = '<div class="vfilter">' + ["全部"].concat(groups.map(function (g) { return g.name; })).map(function (name) {
      var on = (S.vfilter || "") === (name === "全部" ? "" : name);
      var cnt = name === "全部" ? total : (items.filter(function (x) { return x.group === name; }).length);
      return '<button class="chip' + (on ? " on" : "") + '" data-vfilter="' + esc(name === "全部" ? "" : name) + '">' +
        esc(name) + '<i>' + cnt + "</i></button>";
    }).join("") + "</div>";

    var shown = S.vfilter ? items.filter(function (x) { return x.group === S.vfilter; }) : items;
    var body = vocabGrouped(shown, {
      open: true,
      empty: "还没有收录高级词汇。批改一篇翻译或作文后，系统会把其中的高级表达按分类自动归档到这里。"
    });
    var hint = '<div class="hint" style="margin:8px 0 6px">' + (covered < 23
      ? "23 个分类中已收录 " + covered + " 类，其余分类会在练到对应主题时自动积累。"
      : "23 个分类已全部收录词条。") + "词条按出现次数排序，标为「已掌握」的会沉到底部。</div>";

    elScroll.innerHTML = hero + chips + hint + body;
    elBar.innerHTML =
      '<button class="btn" data-act="go_practice">返回练习</button>' +
      '<button class="btn" data-act="vocab_refresh">刷新</button>' +
      '<button class="btn" data-act="vocab_export">导出 CSV</button>' +
      '<button class="btn" data-act="vocab_anki">加入 Anki</button>' +
      '<button class="btn" data-act="vocab_clear">清空词汇库</button>';
    elScroll.scrollTop = 0;
  }

  function refreshVocab(loud) {
    return api("vocab").then(function (j) {
      S.vocab = { items: j.items || [], summary: j.summary || null };
      if (S.view === "vocab") renderVocab();
      if (loud) toast("词汇库已刷新（共 " + (S.vocab.items.length || 0) + " 条）");
    }).catch(function (err) {
      if (loud) toast("刷新失败：" + err.message);
    });
  }
  function refreshHistory() {
    api("history").then(function (j) {
      S.history = { trend: j.trend || [], records: j.records || [], stats: j.stats || null };
      if (S.view === "records") renderRecords();
    }).catch(function (err) {
      toast("记录加载失败：" + err.message);
      if (S.view === "records") renderRecords();
    });
  }

  function openRecord(id) {
    if (!id || S.busy) return;
    S.busy = "record";
    elScroll.innerHTML = '<div class="loading"><span class="spinner"></span>正在载入当次批改…</div>';
    api("record?id=" + encodeURIComponent(id)).then(function (j) {
      S.busy = "";
      S.replayId = id;
      S.recordId = id;
      S.payload = j.payload;
      S.view = "replay";
      render();
    }).catch(function (err) {
      S.busy = "";
      toast("载入失败：" + err.message);
      S.view = "records";
      render();
    });
  }

  function switchView(view) {
    S.view = view;
    var tabs = document.querySelectorAll("#tabs [data-view]");
    for (var i = 0; i < tabs.length; i++) {
      var target = view === "replay" ? "records" : view;
      tabs[i].classList.toggle("on", tabs[i].getAttribute("data-view") === target);
    }
    if (view === "records") { renderRecords(); refreshHistory(); return; }
    if (view === "vocab") { renderVocab(); refreshVocab(); return; }
    if (view === "practice") {
      // 回看历史后切回练习：丢掉复现的 payload，回到当前作答/最新批改
      if (S.replayId) { S.payload = null; S.recordId = null; S.replayId = null; }
      if (S.payload) renderResult(); else renderInput();
      return;
    }
    renderResult();
  }

  var VIEWS = {
    task_header: viewTaskHeader,
    ocr_panel: function (schema, res, p) { return viewOcr(p.ocr_meta || {}); },
    user_input_panel: function (schema, res) { return viewInputPanel(res); },
    score_overview: viewScore,
    error_panel: function (schema, res) { return viewErrors(res); },
    info_panel: function (schema, res) { return viewInfo(res); },
    sample_panel: function (schema, res) { return viewSample(res); },
    knowledge_panel: function (schema, res) { return viewKnowledge(res); },
    suggest_panel: function (schema, res) { return viewSuggest(res); },
    stats_panel: function (schema, res) { return viewStats(res); }
  };

  var FALLBACK_TITLES = {
    task_header: "任务信息", ocr_panel: "手写图片 & OCR识别", user_input_panel: "你的作答",
    score_overview: "评分概览", error_panel: "错误明细", info_panel: "要点/结构评价",
    sample_panel: "参考范文", knowledge_panel: "考点记忆卡", suggest_panel: "个性化提升建议",
    stats_panel: "个人训练统计"
  };

  function renderResult() {
    var p = S.payload || {};
    var schema = p.ui_schema || {};
    var res = p.result || {};
    var resTask = res.task_type || taskType();
    var order = schema.panel_order || Object.keys(FALLBACK_TITLES);
    var isImageInput = !!(p.ocr_meta && p.ocr_meta.is_image_input);
    var html = "";
    order.forEach(function (id) {
      if (id === "action_bar") return;
      if (id === "ocr_panel" && (resTask === "translation" || !isImageInput)) return;
      var fn = VIEWS[id];
      if (!fn) return;
      var body;
      try { body = fn(schema, res, p); } catch (e) { body = '<div class="hint">渲染出错：' + esc(e.message) + "</div>"; }
      if (body == null) return;
      html += panel(panelTitle(schema, id, FALLBACK_TITLES[id] || id), body, {
        key: id, fold: panelFold(schema, id), tag: id === "ocr_panel" ? "OCR" : ""
      });
    });
    elScroll.innerHTML = html;
    elBar.innerHTML = resultBar();
    elScroll.scrollTop = 0;
  }

  function resultBar() {
    if (S.view === "replay") {
      return '<button class="btn primary" data-act="go_records">返回记录</button>' +
        '<button class="btn" data-act="export_pdf">导出 PDF</button>' +
        '<button class="btn" data-act="export_png">导出图片</button>' +
        '<button class="btn" data-act="go_practice">再练一篇</button>';
    }
    var schema = (S.payload && S.payload.ui_schema) || {};
    var btns = (schema.panel_config && schema.panel_config.action_bar && schema.panel_config.action_bar.buttons) ||
      ["save_card", "review_test", "ocr_edit", "clear"];
    var map = {
      save_card: ["save_card", "保存错题卡"],
      anki: ["anki", "加入Anki复习队列"],
      review_test: ["review_test", "抽取同主题复测题"],
      ocr_edit: ["ocr_edit", "人工修正OCR文本"],
      clear: ["clear", "清空本次记录"],
      export_pdf: ["export_pdf", "导出 PDF"],
      export_png: ["export_png", "导出图片"],
      back: ["back", "再练一篇"]
    };
    return btns.concat(["export_pdf", "export_png", "back"]).map(function (k) {
      var m = map[k] || [k, k];
      return '<button class="btn' + (k === "save_card" ? " primary" : "") + '" data-act="' + m[0] + '">' + esc(m[1]) + "</button>";
    }).join("");
  }

  function render() {
    renderModeSeg();
    renderExams();
    if (S.view === "records") { renderRecords(); return; }
    if (S.view === "vocab") { renderVocab(); return; }
    if (S.view === "replay") { renderResult(); return; }
    if (S.payload) renderResult(); else renderInput();
  }

  /* ---------------- actions ---------------- */
  function doOcr() {
    if (!S.image) { toast("请先选择手写作文照片"); return; }
    S.busy = "ocr"; elBar.innerHTML = submitBar();
    var e = currentExam();
    api("ocr", {
      level: S.level, mode: S.mode, exam_id: S.examId,
      image: { dataUrl: S.image.dataUrl, name: S.image.name },
      writing_prompt: e ? e.writing_prompt : ""
    }).then(function (j) {
      S.busy = "";
      S.ocrText = j.ocr_text || "";
      S.ocrNote = j.note || "";
      renderInput();
      toast(j.ok === false ? "未识别到手写英文，请换一张更清晰的照片" : "识别完成，可校对后批改");
    }).catch(function (err) {
      S.busy = ""; renderInput(); toast("识别失败：" + err.message);
    });
  }

  function doSubmit() {
    if (S.busy) return;
    var e = currentExam();
    if (!e) { toast("请先选择真题"); return; }
    var payload = {
      task_type: taskType(), level: S.level, mode: S.mode, exam_id: e.id,
      exam_date: e.exam_date, set: e.set, topic: e.topic,
      zh_source: e.zh_source || "", writing_prompt: e.writing_prompt || "",
      ref_trans: e.ref_trans || "", ref_idea: e.ref_idea || "",
      text: isImage() ? (S.ocrText || "") : S.answer
    };
    if (isImage()) {
      if (!S.image) { toast("请上传手写作文照片"); return; }
      payload.image = { dataUrl: S.image.dataUrl, name: S.image.name };
    } else if (S.answer.trim().length < 10) {
      toast("作答内容太短（至少 10 个字符）"); return;
    }
    S.busy = "grade"; elBar.innerHTML = submitBar();
    elScroll.insertAdjacentHTML("afterbegin", '<div class="loading" id="ld"><span class="spinner"></span>' +
      (isImage() ? "正在识别手写并进行批改…" : "正在批改，请稍候…") + "</div>");
    api("grade", payload).then(function (j) {
      S.busy = "";
      S.payload = j.payload || j;
      S.recordId = j.record_id || null;
      if (S.payload.ocr_meta && S.payload.ocr_meta.ocr_raw_text) S.ocrText = S.payload.ocr_meta.ocr_raw_text;
      return api("bootstrap").then(function (b) { S.boot = b; });
    }).then(function () {
      render();
      refreshHistory();
      refreshVocab();
      toast("批改完成");
    }).catch(function (err) {
      S.busy = "";
      var ld = document.getElementById("ld");
      if (ld) ld.remove();
      elBar.innerHTML = submitBar();
      toast("批改失败：" + err.message);
    });
  }

  function backToInput() {
    S.payload = null; S.recordId = null; S.replayId = null; S.view = "practice";
    var tabs = document.querySelectorAll("#tabs [data-view]");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle("on", tabs[i].getAttribute("data-view") === "practice");
    }
    renderInput();
  }

  /* ---------------- 导出（PDF / 图片） ---------------- */
  function downloadBlob(blob, name) {
    var a = document.createElement("a");
    var url = URL.createObjectURL(blob);
    a.href = url;
    a.download = name || "cetwt-report.png";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 3000);
  }

  // 把自包含的内联样式 HTML 画成 PNG：HTML → SVG foreignObject → canvas → PNG
  function rasterize(html, filename) {
    return new Promise(function (resolve, reject) {
      var W = 980, SCALE = 2;
      var holder = document.createElement("div");
      holder.style.cssText = "position:fixed;left:-10000px;top:0;width:" + W + "px;background:#fff;padding:0;margin:0";
      holder.innerHTML = html;
      document.body.appendChild(holder);
      var H = Math.max(320, holder.scrollHeight || holder.offsetHeight || 0);
      var inner = holder.innerHTML;
      if (holder.parentNode) holder.parentNode.removeChild(holder);

      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '">' +
        '<foreignObject x="0" y="0" width="' + W + '" height="' + H + '">' +
        '<div xmlns="http://www.w3.org/1999/xhtml" style="width:' + W + 'px;background:#fff;margin:0;padding:0">' +
        inner + "</div></foreignObject></svg>";

      var img = new Image();
      img.onload = function () {
        try {
          var canvas = document.createElement("canvas");
          canvas.width = W * SCALE;
          canvas.height = H * SCALE;
          var ctx = canvas.getContext("2d");
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.scale(SCALE, SCALE);
          ctx.drawImage(img, 0, 0);
          canvas.toBlob(function (blob) {
            if (!blob) { reject(new Error("图片编码失败")); return; }
            downloadBlob(blob, filename);
            resolve(true);
          }, "image/png");
        } catch (e) { reject(e); }
      };
      img.onerror = function () { reject(new Error("图片渲染失败")); };
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    });
  }

  function exportImage() {
    if (!S.recordId) { toast("暂无可导出的记录"); return; }
    toast("正在生成报告图片…");
    api("report?id=" + encodeURIComponent(S.recordId) + "&format=body")
      .then(function (j) {
        if (!j || !j.ok || !j.html) throw new Error("报告生成失败");
        return rasterize(j.html, j.filename);
      })
      .then(function () { toast("图片已保存（浏览器下载目录）"); })
      .catch(function (err) { toast("导出图片失败：" + (err && err.message ? err.message : err)); });
  }

  function onAction(act, btn) {
    var e = currentExam();
    if (act === "submit") { doSubmit(); return; }
    if (act === "go_practice") { backToInput(); return; }
    if (act === "go_records") { switchView("records"); return; }
    if (act === "refresh_history") { refreshHistory(); toast("已刷新练习记录"); return; }
    if (act === "export_history") {
      api("export").then(function (j) {
        toast("成绩单已导出：" + (j.path || "dsh-cetwt/成绩单.csv"));
      }).catch(function (err) { toast("导出失败：" + err.message); });
      return;
    }    if (act === "go_vocab") { switchView("vocab"); return; }
    if (act === "vocab_master" || act === "vocab_unmaster" || act === "vocab_delete") {
      var vkey = btn ? btn.getAttribute("data-key") : "";
      if (!vkey) return;
      var vact = act === "vocab_delete" ? "delete" : (act === "vocab_master" ? "master" : "unmaster");
      api("vocab", { action: vact, key: vkey }).then(function (j) {
        S.vocab.summary = j.summary || S.vocab.summary;
        refreshVocab();
        toast(vact === "delete" ? "已删除该词条" : vact === "master" ? "已标记为掌握" : "已取消掌握");
      }).catch(function (err) { toast("操作失败：" + err.message); });
      return;
    }
    if (act === "vocab_refresh") { refreshVocab(true); return; }
    if (act === "vocab_export") {
      api("vocab_export").then(function (j) {
        toast("高级词汇库已导出：" + (j.path || "dsh-cetwt/高级词汇库.csv") + "（" + (j.rows || 0) + " 行）");
      }).catch(function (err) { toast("导出失败：" + err.message); });
      return;
    }
    if (act === "vocab_anki") {
      api("vocab_anki", {}).then(function (j) {
        toast(j.rows ? "已生成 Anki 词汇包：" + j.path + "（" + j.rows + " 张卡）" : "没有待复习的词条");
      }).catch(function (err) { toast("生成失败：" + err.message); });
      return;
    }
    if (act === "vocab_clear") {
      if (!window.confirm("确定清空整个高级词汇库吗？此操作不可撤销（练习记录不受影响）。")) return;
      api("reset", { scope: "vocab" }).then(function () {
        S.vocab = { items: [], summary: null };
        refreshVocab(true);
        toast("高级词汇库已清空");
      }).catch(function (err) { toast("清空失败：" + err.message); });
      return;
    }
    if (act === "copy_revised") {
      var box = document.getElementById("revised-text");
      var txt = box ? box.textContent : "";
      if (!txt) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () { toast("全文改写稿已复制"); },
          function () { toast("复制失败，请手动选取文本"); });
      } else {
        toast("当前环境不支持自动复制，请手动选取文本");
      }
      return;
    }
    if (act === "ocr" || act === "reocr") { doOcr(); return; }
    if (act === "reset") { S.answer = ""; S.image = null; S.ocrText = ""; S.ocrNote = ""; renderInput(); return; }
    if (act === "back") { backToInput(); return; }
    if (act === "save_card") {
      if (!S.recordId) { toast("暂无可保存的记录"); return; }
      api("save_card", { record_id: S.recordId }).then(function () { toast("已保存错题卡"); })
        .catch(function (err) { toast("保存失败：" + err.message); });
      return;
    }
    if (act === "anki") {
      if (!S.recordId) { toast("暂无可导出的记录"); return; }
      api("anki", { record_id: S.recordId }).then(function (j) {
        if (j.path) toast("已生成 Anki 导入文件：" + j.path); else toast("已加入复习队列");
      }).catch(function (err) { toast("导出失败：" + err.message); });
      return;
    }
    if (act === "export_pdf") {
      if (!S.recordId) { toast("暂无可导出的记录"); return; }
      var w = window.open("/cetwt/report?id=" + encodeURIComponent(S.recordId), "_blank");
      if (!w) toast("浏览器拦截了新窗口，请允许弹出窗口后重试");
      else toast("已打开报告页，在打印对话框里选择「另存为 PDF」");
      return;
    }
    if (act === "export_png") { exportImage(); return; }
    if (act === "review_test") {
      api("retest", { level: S.level, task_type: taskType(), theme: e ? e.topic : "", except_id: S.examId })
        .then(function (j) {
          if (!j.exam) { toast("同主题暂无可复测的真题"); return; }
          S.examId = j.exam.id; S.answer = ""; S.image = null; S.ocrText = ""; S.payload = null;
          renderInput();
          toast("已抽取：" + (j.exam.exam_date || "") + " 第" + (j.exam.set || 1) + "套（" + (j.exam.topic || "") + "），开始复测");
        }).catch(function (err) { toast("抽取失败：" + err.message); });
      return;
    }
    if (act === "ocr_edit") {
      S.payload = null;
      S.answer = S.ocrText || S.answer;
      if (isImage()) { S.mode = "writing-text"; renderModeSeg(); }
      renderInput();
      var ta = document.getElementById("answer");
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      toast("已切换到文本校对模式，修改后重新批改");
      return;
    }
    if (act === "clear") {
      if (!S.recordId) { backToInput(); return; }
      api("clear", { record_id: S.recordId }).then(function (b) {
        S.boot = b || S.boot; backToInput(); toast("已清空本次记录");
      }).catch(function (err) { toast("清空失败：" + err.message); });
      return;
    }
  }

  /* ---------------- events ---------------- */
  elSeg.addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-mode]");
    if (!b) return;
    S.mode = b.getAttribute("data-mode");
    S.payload = null;
    var cur = currentExam();
    if (!examSupports(cur, taskType())) {
      var alt = examList().filter(function (e) { return examSupports(e, taskType()); })[0];
      S.examId = alt ? alt.id : "";
    }
    render();
  });

  elLevel.addEventListener("change", function () {
    S.level = elLevel.value;
    S.examId = "";
    S.payload = null;
    render();
  });

  elExam.addEventListener("change", function () {
    S.examId = elExam.value;
    S.payload = null;
    renderInput();
  });

  document.addEventListener("click", function (ev) {
    var tab = ev.target.closest("#tabs [data-view]");
    if (tab) { switchView(tab.getAttribute("data-view")); return; }
    var row = ev.target.closest("[data-record]");
    if (row) { openRecord(row.getAttribute("data-record")); return; }    var chip = ev.target.closest("[data-vfilter]");
    if (chip) { S.vfilter = chip.getAttribute("data-vfilter") || ""; renderVocab(); return; }
    var h = ev.target.closest("section.panel > h3");
    if (h) {
      var sec = h.parentNode;
      sec.classList.toggle("closed");
      S.folds[sec.getAttribute("data-key")] = sec.classList.contains("closed");
      return;
    }
    var b = ev.target.closest("[data-act]");
    if (b) { onAction(b.getAttribute("data-act"), b); }
  });

  document.getElementById("btn-min").addEventListener("click", function () {
    try {
      window.parent.postMessage({ type: "cetwt:minimize" }, "*");
    } catch (e) { /* ignore */ }
  });

  document.getElementById("btn-float").addEventListener("click", function () {
    try {
      window.parent.postMessage({ type: "cetwt:float" }, "*");
    } catch (e) { /* ignore */ }
    toast("已切换为浮窗，可拖动标题栏移动");
  });

  /* ---------------- zoom ---------------- */
  var ZOOM_MIN = 0.8;
  var ZOOM_MAX = 1.6;
  var ZOOM_STEP = 0.05;
  var zoom = 1;
  (function () {
    var raw = 1;
    try { raw = parseFloat(localStorage.getItem("cetwt:zoom") || "1"); } catch (e) { /* ignore */ }
    if (isFinite(raw) && raw >= ZOOM_MIN && raw <= ZOOM_MAX) zoom = raw;
  })();

  function applyZoom() {
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 20) / 20));
    document.body.style.zoom = String(zoom);
    var v = document.getElementById("zoom-val");
    if (v) v.textContent = Math.round(zoom * 100) + "%";
    try { localStorage.setItem("cetwt:zoom", String(zoom)); } catch (e) { /* ignore */ }
  }

  var elZoom = document.getElementById("zoom-ctl");
  if (elZoom) {
    elZoom.addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-zoom]");
      if (!b) return;
      var dir = b.getAttribute("data-zoom");
      if (dir === "reset") zoom = 1;
      else if (dir === "in") zoom += ZOOM_STEP;
      else zoom -= ZOOM_STEP;
      applyZoom();
    });
  }

  window.addEventListener("wheel", function (ev) {
    if (!ev.ctrlKey) return;
    ev.preventDefault();
    zoom += ev.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
    applyZoom();
  }, { passive: false });

  applyZoom();

  /* ---------------- boot ---------------- */
  api("bootstrap").then(function (b) {
    S.boot = b || { exams: [], records: [] };
    var seen = null;
    try { seen = localStorage.getItem("cetwt:init"); } catch (e) { /* ignore */ }
    if (seen === "2") {
      var saved = null;
      try { saved = localStorage.getItem("cetwt:mode"); } catch (e2) { /* ignore */ }
      if (saved === "translation" || saved === "writing-text" || saved === "writing-image") S.mode = saved;
      S.level = localStorage.getItem("cetwt:level") === "CET4" ? "CET4" : "CET6";
    } else {
      // 初次使用：默认 CET6 · 翻译 · 最新一套（2025 年 12 月第 1 套）
      S.mode = "translation";
      S.level = "CET6";
      try {
        localStorage.setItem("cetwt:init", "2");
        localStorage.setItem("cetwt:mode", "translation");
        localStorage.setItem("cetwt:level", "CET6");
      } catch (e3) { /* ignore */ }
    }
    elLevel.value = S.level;
    var def = pickDefaultExam(examList(), S.level, taskType());
    S.examId = def ? def.id : "";
    if (b.vocab) S.vocab = { items: [], summary: b.vocab };
    S.boot.stats = S.boot.stats || null;
    render();
    refreshVocab();
  }).catch(function (err) {
    elScroll.innerHTML = '<div class="empty"><div class="big">⚠</div><div>无法连接训练服务</div><div class="hint">' +
      esc(err.message) + "</div></div>";
  });

  window.addEventListener("message", function (ev) {
    var d = ev.data || {};
    if (d.type === "cetwt:state") {
      if (d.mode) { S.mode = d.mode; renderModeSeg(); }
      if (d.level) { S.level = d.level; elLevel.value = d.level; }
      S.payload = null;
      render();
    }
  });
})();
