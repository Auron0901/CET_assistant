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
      html += '<div class="sub-h">逐句改写（全篇 ' + sr.length + " 句）</div>" + sr.map(function (s, idx) {
        return '<div class="sent-card">' +
          '<div class="sn">' + (idx + 1) + "</div>" +
          '<div class="orig">' + esc(s.sentence) + "</div>" +
          (s.issue ? '<div><span class="issue">' + esc(s.issue) + "</span></div>" : "") +
          (s.revision ? '<div class="rev">' + esc(s.revision) + "</div>" : "") +
          (s.upgrade ? '<div class="up">升级点：' + esc(s.upgrade) + "</div>" : "") +
          "</div>";
      }).join("");
    }
    var vu = res.vocab_upgrade || [];
    if (vu.length) {
      html += '<div class="sub-h">高级词汇同义替换（' + vu.length + " 组）</div>" + vocabGrouped(vu, { open: true });
    }
    return html;
  }

