/**
 * dsh-cetwt — CET4/CET6 写译训练插件（宿主半区）
 *
 * 职责
 *   GET  /cetwt/api/bootstrap                真题库 + 历史记录 + 成绩走势 + 统计
 *   GET  /cetwt/api/history                  练习记录列表 + 成绩走势（折线图数据）
 *   GET  /cetwt/api/record?id=…              回看单次批改（复原 ui_schema + result）
 *   POST /cetwt/api/ocr                      手写英文 OCR（多模态模型）
 *   POST /cetwt/api/grade                    OCR（可选）→ 评分 → 落库
 *   POST /cetwt/api/save_card                保存错题卡文件
 *   POST /cetwt/api/anki                     导出 Anki 复习条目
 *   POST /cetwt/api/retest                   抽同主题复测真题
 *   POST /cetwt/api/clear                    删除本次记录
 *   GET  /cetwt/app/*                        侧边栏页面静态资源
 *   /cetwt-grade   /cetwt-stats              斜杠命令
 *
 * 只使用 ctx 服务（webServer / llm / attachments / agentDefaultModel / commands），
 * 不 import 任何 @deepseek-ai/* 包。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-cetwt'
export const inject = ['webServer', 'llm', 'attachments', 'agentDefaultModel']

const ROUTE = '/cetwt'
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const APP_DIR = path.join(PLUGIN_DIR, 'app')
const DATA_FILE = path.join(PLUGIN_DIR, 'data', 'exams.json')
const MAX_BODY_BYTES = 16 * 1024 * 1024
const MAX_TEXT_CHARS = 6000
const OCR_TIMEOUT_MS = 120_000
const GRADE_TIMEOUT_MS = 180_000
const MAX_RECORDS = 2000

const TASK_TYPES = new Set(['translation', 'writing'])
const LEVELS = new Set(['CET4', 'CET6'])

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-cache',
}

// 面板顺序 / 标题 / 折叠 —— 与 m00001 ui_schema 固定结构一致
const PANEL_ORDER = [
  'task_header',
  'ocr_panel',
  'user_input_panel',
  'score_overview',
  'error_panel',
  'info_panel',
  'sample_panel',
  'knowledge_panel',
  'suggest_panel',
  'stats_panel',
  'action_bar',
]

const PANEL_CONFIG = {
  task_header: { title: '任务信息', fold: false },
  ocr_panel: { title: '手写图片 & OCR识别', fold: false, hide_when_text: true },
  user_input_panel: { title: '你的作答', fold: false },
  score_overview: { title: '评分概览', fold: false },
  error_panel: { title: '错误明细', fold: false },
  info_panel: { title: '要点/结构评价', fold: false },
  sample_panel: { title: '参考范文', fold: true },
  knowledge_panel: { title: '考点记忆卡', fold: true },
  suggest_panel: { title: '个性化提升建议', fold: false },
  stats_panel: { title: '个人训练统计', fold: true },
  action_bar: { buttons: ['save_card', 'anki', 'review_test', 'ocr_edit', 'clear'] },
}

const RUBRIC = {
  translation: {
    max: 15,
    dims: { faithful: 6, vocab: 4, grammar: 3, fluency: 2 },
    bands: [
      '13-15：原文信息完整准确，表达地道流畅，几乎无词汇语法错误，句式丰富自然',
      '10-12：全部要点覆盖，仅有少量不影响理解的细微错误',
      '7-9：存在信息漏译/错译，错误较多，部分语义理解受阻',
      '4-6：仅译出少量要点，大量错误，语义难懂',
      '0-3：基本无法传递原文意思',
    ],
  },
  writing: {
    max: 15,
    dims: { content: 5, coherence: 3, vocab: 3, grammar: 4 },
    bands: [
      '13-15：紧扣写作任务，结构完整清晰，衔接自然，词汇句式丰富，几乎无语言错误',
      '10-12：切题，结构完整，少量语言错误，不影响理解',
      '7-9：基本切题，局部偏题，语言错误较多',
      '4-6：偏离主题，大量词汇语法错误，可读性差',
      '0-3：难以读懂、字数严重不足、完全跑题',
    ],
  },
}

/* 高级词汇板块：固定 23 个分类，按 6 个大类分组展示（分类名与需求逐字一致，禁止改写） */
export const VOCAB_GROUPS = [
  { name: '文化与传承', categories: ['文化遗产 & 传承', '传统节日民俗', '传统艺术、技艺', '思想典籍', '名胜古迹'] },
  { name: '教育与成长', categories: ['教育 & 校园', '教育基础', '大学生成长', '线上教育'] },
  { name: '科技与网络', categories: ['科技 & 网络', '互联网、生活科技'] },
  { name: '环境与生态', categories: ['环境 & 生态环保', '环保基础', '污染、灾害', '资源、保护'] },
  { name: '社会与民生', categories: ['社会民生 & 发展', '城市化、人口', '社会保障、民生', '社会热点话题'] },
  { name: '经济与表达', categories: ['经济 & 贸易', '个人品质、价值观', '利弊词', '观点功能短语'] },
]

export const VOCAB_CATEGORIES = VOCAB_GROUPS.flatMap((group) => group.categories)

class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

// ---------------------------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------------------------
function combineSignals(signals) {
  const list = signals.filter((s) => s !== undefined && s !== null)
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list)
  const controller = new AbortController()
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

function clamp(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n * 2) / 2))
}

function str(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function strList(value, cap = 12) {
  if (!Array.isArray(value)) return []
  return value
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v !== '')
    .slice(0, cap)
}

/** CSV 单元格转义：含逗号/引号/换行时加引号。 */
function csvCell(value) {
  const text = String(value ?? '')
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 退避等待，用于模型偶发空响应后的重试。 */
function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseJsonLoose(raw) {
  let s = String(raw ?? '').trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s)
  if (fence) s = fence[1].trim()
  if (!s.startsWith('{')) {
    const start = s.indexOf('{')
    const end = s.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('响应中没有 JSON 对象')
    s = s.slice(start, end + 1)
  }
  return JSON.parse(s)
}

function gradeBand(score, taskType = 'writing') {
  const bands = RUBRIC[taskType]?.bands ?? RUBRIC.writing.bands
  if (score >= 13) return bands[0]
  if (score >= 10) return bands[1]
  if (score >= 7) return bands[2]
  if (score >= 4) return bands[3]
  return bands[4]
}

// ---------------------------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------------------------
export function apply(ctx, config = {}) {
  const maxTokens = Number.isInteger(config.maxTokens) ? config.maxTokens : 8000
  const temperature = typeof config.temperature === 'number' ? config.temperature : 0.2

  const homeDir = (() => {
    const fromCtx = ctx.get?.('profileContext')?.home
    if (typeof fromCtx === 'string' && fromCtx !== '') return fromCtx
    if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '') return process.env.DSH_HOME
    return path.join(os.homedir(), '.dsh')
  })()
  const storeDir = path.join(homeDir, 'dsh-cetwt')
  const storeFile = path.join(storeDir, 'records.json')
  const vocabFile = path.join(storeDir, 'vocab-bank.json')

  // ---- 真题库 --------------------------------------------------------------------------------
  function loadExams() {
    try {
      const raw = fs.readFileSync(DATA_FILE, 'utf8')
      const list = JSON.parse(raw)
      return Array.isArray(list) ? list : []
    } catch (error) {
      ctx.logger?.warn?.(`cetwt: 无法读取真题库 ${DATA_FILE}: ${error?.message ?? error}`)
      return []
    }
  }
  let exams = loadExams()
  const examById = new Map(exams.map((e) => [e.id, e]))

  // ---- 记录存储（单文件 + 原子替换）-----------------------------------------------------------
  let records = []
  try {
    if (fs.existsSync(storeFile)) {
      const parsed = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
      if (Array.isArray(parsed)) records = parsed
    }
  } catch (error) {
    ctx.logger?.warn?.(`cetwt: 历史记录读取失败，按空库继续: ${error?.message ?? error}`)
  }

  let writing = Promise.resolve()
  function saveRecords() {
    writing = writing.then(async () => {
      const trimmed = records.slice(-MAX_RECORDS)
      records = trimmed
      await fsp.mkdir(storeDir, { recursive: true })
      const tmp = `${storeFile}.${process.pid}.tmp`
      await fsp.writeFile(tmp, JSON.stringify(trimmed), 'utf8')
      await fsp.rename(tmp, storeFile)
    }).catch((error) => {
      ctx.logger?.warn?.(`cetwt: 记录落盘失败: ${error?.message ?? error}`)
    })
    return writing
  }

  // ---- 高级词汇板块（分类词汇库，持久化 + 每次批改自动归并）------------------------------------
  let vocabItems = []
  try {
    if (fs.existsSync(vocabFile)) {
      const parsed = JSON.parse(fs.readFileSync(vocabFile, 'utf8'))
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : []
      vocabItems = list.filter((v) => v && typeof v.term === 'string' && v.term !== '')
    }
  } catch (error) {
    ctx.logger?.warn?.(`cetwt: 高级词汇库读取失败，按空库继续: ${error?.message ?? error}`)
  }

  let vocabWriting = Promise.resolve()
  function saveVocab() {
    vocabWriting = vocabWriting.then(async () => {
      await fsp.mkdir(storeDir, { recursive: true })
      const payload = {
        updated_at: Date.now(),
        groups: VOCAB_GROUPS,
        items: vocabItems,
      }
      const tmp = `${vocabFile}.${process.pid}.tmp`
      await fsp.writeFile(tmp, JSON.stringify(payload), 'utf8')
      await fsp.rename(tmp, vocabFile)
    }).catch((error) => {
      ctx.logger?.warn?.(`cetwt: 高级词汇库落盘失败: ${error?.message ?? error}`)
    })
    return vocabWriting
  }

  /** 把分类名对齐到 23 个固定分类；对齐不上时按关键词兜底，最后落到「观点功能短语」。 */
  function canonicalCategory(raw) {
    const name = str(raw).trim()
    if (name === '') return '观点功能短语'
    const exact = VOCAB_CATEGORIES.find((c) => c === name)
    if (exact) return exact
    const loose = VOCAB_CATEGORIES.find((c) => c.replace(/[\s&、，,]/g, '') === name.replace(/[\s&、，,]/g, ''))
    if (loose) return loose
    const partial = VOCAB_CATEGORIES.find((c) => name.includes(c) || c.includes(name))
    if (partial) return partial
    const probe = name.toLowerCase()
    const table = [
      [/文化|遗产|传承|heritage|cultural/, '文化遗产 & 传承'],
      [/节日|民俗|festival|folk|custom/, '传统节日民俗'],
      [/艺术|技艺|绘画|书法|art|craft/, '传统艺术、技艺'],
      [/典籍|思想|哲学|孔|philosoph|confuc/, '思想典籍'],
      [/名胜|古迹|景点|旅游|tourism|scenic/, '名胜古迹'],
      [/校园|campus|school|学术|课程/, '教育 & 校园'],
      [/教育基础|基础教育|basi\w* education|literacy/, '教育基础'],
      [/大学生|大学|college|student|graduat/, '大学生成长'],
      [/线上|在线|网络课|online|e-learning|mooc/, '线上教育'],
      [/科技|技术|tech|innovation|ai\b|digital/, '科技 & 网络'],
      [/互联网|app|手机|网络|internet|mobile|smart/, '互联网、生活科技'],
      [/利与弊|利弊|advantage|disadvantage|pros|cons/, '利弊词'],
      [/环保|生态|环境|ecolog|environ/, '环境 & 生态环保'],
      [/污染|灾害|disaster|pollut/, '污染、灾害'],
      [/资源|保护|conserve|renewable|protect/, '资源、保护'],
      [/城市化|人口|urban|population|migrat/, '城市化、人口'],
      [/社会保障|民生|welfare|pension|medical/, '社会保障、民生'],
      [/就业|经济|贸易|econom|trade|business|market/, '经济 & 贸易'],
      [/品质|价值观|virtue|quality|value|honest/, '个人品质、价值观'],
      [/社会|热点|society|social|issue/, '社会民生 & 发展'],
      [/认为|观点|表明|argue|believe|suggest|point out/, '观点功能短语'],
    ]
    for (const [re, category] of table) if (re.test(probe) || re.test(name)) return category
    return '观点功能短语'
  }

  /** 单词归一：小写去标点空格，用于去重。 */
  function vocabKey(term, category) {
    return `${str(term).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()}|${category}`
  }

  /** 一次批改产生的高级词汇并入分类库：重复词累加 hits、保留最新例句与来源。 */
  function mergeVocab(items, record) {
    const now = Date.now()
    let added = 0
    let merged = 0
    for (const item of items) {
      const term = str(item?.advanced).trim()
      if (term === '') continue
      const category = canonicalCategory(item?.category)
      const key = vocabKey(term, category)
      const existed = vocabItems.find((v) => v.key === key)
      if (existed) {
        existed.hits = (existed.hits ?? 1) + 1
        existed.last_at = now
        existed.usage = str(item?.usage) || existed.usage
        existed.cn = str(item?.note) || existed.cn
        existed.example = str(item?.example) || existed.example
        if (record?.id && !(existed.records ?? []).includes(record.id)) {
          existed.records = [...(existed.records ?? []), record.id].slice(-30)
        }
        merged += 1
        continue
      }
      vocabItems.push({
        key,
        term,
        category,
        group: VOCAB_GROUPS.find((g) => g.categories.includes(category))?.name ?? '经济与表达',
        basic: str(item?.basic),
        cn: str(item?.note),
        usage: str(item?.usage),
        example: str(item?.example),
        level: record?.level ?? '',
        hits: 1,
        mastered: false,
        first_at: now,
        last_at: now,
        source: {
          record_id: record?.id ?? '',
          exam_id: record?.exam_id ?? '',
          exam_date: record?.exam_date ?? '',
          set: record?.set ?? null,
          task_type: record?.task_type ?? '',
        },
        records: record?.id ? [record.id] : [],
      })
      added += 1
    }
    return { added, merged }
  }

  /** 分类库概况：总数、掌握数、每分类计数，供前端渲染分组与徽标。 */
  function vocabSummary() {
    const byCategory = Object.fromEntries(VOCAB_CATEGORIES.map((c) => [c, 0]))
    let mastered = 0
    for (const v of vocabItems) {
      const c = VOCAB_CATEGORIES.includes(v.category) ? v.category : canonicalCategory(v.category)
      byCategory[c] = (byCategory[c] ?? 0) + 1
      if (v.mastered) mastered += 1
    }
    return {
      total: vocabItems.length,
      mastered,
      groups: VOCAB_GROUPS.map((g) => ({
        name: g.name,
        total: g.categories.reduce((acc, c) => acc + (byCategory[c] ?? 0), 0),
        categories: g.categories.map((c) => ({ name: c, count: byCategory[c] ?? 0 })),
      })),
      updated_at: vocabItems.reduce((acc, v) => Math.max(acc, v.last_at ?? 0), 0) || null,
    }
  }

  function vocabSorted() {
    return [...vocabItems].sort((a, b) => {
      if (a.mastered !== b.mastered) return a.mastered ? 1 : -1
      if ((b.hits ?? 1) !== (a.hits ?? 1)) return (b.hits ?? 1) - (a.hits ?? 1)
      return (b.last_at ?? 0) - (a.last_at ?? 0)
    })
  }

  // ---- 统计 ----------------------------------------------------------------------------------
  function computeStats(scopeRecords) {
    const scored = scopeRecords.filter((r) => typeof r?.total_score === 'number')
    const count = scopeRecords.length
    const avg = scored.length === 0 ? null : Number((scored.reduce((a, r) => a + r.total_score, 0) / scored.length).toFixed(2))
    const byType = { translation: [], writing: [], 'writing-image': [] }
    for (const r of scored) {
      const key = r.task_type === 'translation' ? 'translation' : r.input_mode === 'image' ? 'writing-image' : 'writing'
      byType[key].push(r.total_score)
    }
    const avgOf = (arr) => (arr.length === 0 ? null : Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)))

    const errorTypes = {}
    for (const r of scopeRecords) {
      for (const err of r.error_types ?? []) errorTypes[err] = (errorTypes[err] ?? 0) + 1
    }

    const themes = {}
    for (const r of scored) {
      const key = r.topic || '综合'
      if (!themes[key]) themes[key] = []
      themes[key].push(r.total_score)
    }
    const avgTheme = Object.keys(themes)
      .map((k) => `${k} ${avgOf(themes[k])}`)
      .join(' · ')

    // 连续训练天数
    const days = new Set(scopeRecords.map((r) => new Date(r.created_at).toISOString().slice(0, 10)))
    let streak = 0
    const cursor = new Date()
    for (;;) {
      const key = cursor.toISOString().slice(0, 10)
      if (days.has(key)) {
        streak += 1
        cursor.setDate(cursor.getDate() - 1)
      } else if (streak === 0 && days.size > 0) {
        // 今天还没练，从昨天开始数
        cursor.setDate(cursor.getDate() - 1)
        if (!days.has(cursor.toISOString().slice(0, 10))) break
      } else {
        break
      }
    }

    const weak = Object.entries(errorTypes)
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k]) => k)

    // 错题遗忘跟踪：复测次数与复测前后得分变化
    const retestedRecords = scopeRecords.filter((r) => r.retested)
    const deltas = scopeRecords.filter((r) => typeof r.retest_delta === 'number').map((r) => r.retest_delta)
    const retestDelta = deltas.length === 0 ? null : Number((deltas.reduce((a, b) => a + b, 0) / deltas.length).toFixed(2))
    const lastRetest = scopeRecords
      .filter((r) => typeof r.retest_delta === 'number')
      .sort((a, b) => b.created_at - a.created_at)[0]

    return {
      count,
      avg_total: avg,
      avg_translation: avgOf(byType.translation),
      avg_writing: avgOf(byType.writing),
      avg_writing_image: avgOf(byType['writing-image']),
      streak,
      error_types: errorTypes,
      weak_tags: weak,
      avg_theme: avgTheme,
      retested: retestedRecords.length,
      retest_avg_delta: retestDelta,
      retest_last_delta: lastRetest?.retest_delta ?? null,
    }
  }

  function recordSummary(r) {
    return {
      id: r.id,
      task_type: r.task_type,
      input_mode: r.input_mode,
      level: r.level,
      exam_id: r.exam_id,
      exam_date: r.exam_date,
      set: r.set,
      topic: r.topic,
      total_score: r.total_score,
      dim_score: r.dim_score,
      created_at: r.created_at,
      error_types: r.error_types,
      retested: Boolean(r.retested),
      retest_delta: typeof r.retest_delta === 'number' ? r.retest_delta : null,
    }
  }

  /** 成绩走势：所有已评分记录按时间升序，供前端折线图使用。 */
  function buildTrend() {
    return records
      .filter((r) => typeof r?.total_score === 'number')
      .sort((a, b) => a.created_at - b.created_at)
      .slice(-200)
      .map((r) => ({
        id: r.id,
        t: r.created_at,
        total: r.total_score,
        task_type: r.task_type,
        mode: r.task_type === 'translation' ? 'translation' : r.input_mode === 'image' ? 'writing-image' : 'writing',
        level: r.level,
        exam_id: r.exam_id,
        exam_date: r.exam_date,
        set: r.set,
        topic: r.topic,
        dim_score: r.dim_score,
      }))
  }

  /** 用落库记录复原一次批改的完整 payload，供「练习记录」回看。 */
  function recordPayload(record) {
    const exam = exams.find((e) => e.id === record.exam_id) || null
    const result = {
      task_type: record.task_type,
      total_score: record.total_score,
      grade_desc: record.grade_desc,
      dim_score: record.dim_score,
      dim_comment: record.dim_comment || {},
      error_list: record.error_list || [],
      revised_full: record.revised_full || '',
      sentence_review: record.sentence_review || [],
      vocab_upgrade: record.vocab_upgrade || [],
      review_points: record.review_points || [],
      personal_suggestion: record.personal_suggestion || '',
    }
    if (record.task_type === 'translation') {
      result.lost_info = record.lost_info || []
      result.learn_version = exam?.ref_trans || ''
    } else {
      result.structure_comment = record.structure_comment || ''
      result.sample_essay = exam?.ref_idea || ''
    }
    result.sample_official = Boolean(record.task_type === 'translation' ? exam?.ref_trans : exam?.ref_idea)
    return {
      payload: {
        ui_schema: uiSchema(record.task_type, record.input_mode === 'image'),
        ocr_meta: record.ocr_meta || null,
        result,
      },
      record: { ...recordSummary(record), text: record.text, ocr_meta: record.ocr_meta || null },
    }
  }

  // ---- 导出报告（PDF / 图片）-------------------------------------------------------------------
  const RPT = {
    ink: '#2b2f36',
    soft: '#5b6472',
    line: '#e3e7ee',
    accent: '#1a73e8',
    err: '#d93025',
    ok: '#0f9b6c',
    card: '#f6f9ff',
  }

  function escH(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function reportModel(record) {
    const { payload } = recordPayload(record)
    const res = payload.result
    const isTrans = res.task_type === 'translation'
    const modeLabel = isTrans ? '翻译' : record.input_mode === 'image' ? '作文（手写）' : '作文（文本）'
    const dims = Object.entries(res.dim_score || {}).map(([k, v]) => ({ key: k, score: v }))
    const official = isTrans ? res.learn_version : res.sample_essay
    return {
      record,
      res,
      isTrans,
      modeLabel,
      dims,
      official: official || '',
      officialLabel: res.sample_official
        ? (isTrans ? '官方参考译文（真题自带）' : '官方参考范文（真题自带）')
        : (isTrans ? '参考译文（模型生成，仅供参考）' : '参考范文（模型生成，仅供参考）'),
    }
  }

  function reportBodyHtml(m) {
    const { record, res, isTrans, modeLabel, dims } = m
    const when = new Date(record.created_at).toLocaleString('zh-CN')
    const box = `border:1px solid ${RPT.line};border-radius:10px;padding:14px 16px;margin:0 0 14px`
    const h2 = `font-size:14px;font-weight:700;color:${RPT.ink};margin:0 0 10px`
    const meta = [
      ['板块', modeLabel],
      ['级别', record.level || ''],
      ['真题', `${record.exam_date || ''} 第${record.set || ''}套`],
      ['主题', record.topic || ''],
      ['作答时间', when],
    ]
      .map(
        ([k, v]) =>
          `<div style="display:flex;gap:8px;font-size:12px;color:${RPT.soft};margin:2px 0"><span style="width:56px;flex:none">${k}</span><span style="color:${RPT.ink}">${escH(v)}</span></div>`,
      )
      .join('')

    const dimRows = dims
      .map(
        (d) =>
          `<tr><td style="padding:5px 8px;border-bottom:1px solid ${RPT.line};font-size:12px;color:${RPT.soft}">${escH(d.key)}</td>` +
          `<td style="padding:5px 8px;border-bottom:1px solid ${RPT.line};font-size:12px;text-align:right;color:${RPT.ink};font-weight:600">${escH(d.score)}</td></tr>`,
      )
      .join('')

    const errs = (res.error_list || [])
      .map(
        (e) =>
          `<div style="border-left:3px solid ${RPT.err};background:#fff;padding:8px 10px;margin:0 0 8px;border-radius:0 8px 8px 0">` +
          `<div style="font-size:11px;color:${RPT.err};font-weight:700;margin-bottom:4px">${escH(e.error_type || '')}</div>` +
          (e.source_fragment ? `<div style="font-size:12px;color:${RPT.soft};margin-bottom:3px">原文：${escH(e.source_fragment)}</div>` : '') +
          `<div style="font-size:13px;color:${RPT.err};text-decoration:line-through;margin-bottom:4px">${escH(e.user_fragment || '')}</div>` +
          `<div style="font-size:13px;color:${RPT.ok};margin-bottom:4px">${escH(e.correct_version || '')}</div>` +
          (e.explanation ? `<div style="font-size:12px;color:${RPT.soft};line-height:1.6">${escH(e.explanation)}</div>` : '') +
          `</div>`,
      )
      .join('')

    const sents = (res.sentence_review || [])
      .map(
        (s, i) =>
          `<div style="border:1px solid ${RPT.line};border-radius:8px;padding:9px 11px;margin:0 0 8px;background:#fff">` +
          `<div style="font-size:11px;color:${RPT.soft};margin-bottom:4px">#${i + 1}</div>` +
          `<div style="font-size:12.5px;color:${RPT.err};text-decoration:line-through;margin-bottom:4px">${escH(s.sentence)}</div>` +
          (s.revision ? `<div style="font-size:12.5px;color:${RPT.ok};margin-bottom:3px">${escH(s.revision)}</div>` : '') +
          (s.upgrade ? `<div style="font-size:11.5px;color:${RPT.soft}">升级点：${escH(s.upgrade)}</div>` : '') +
          `</div>`,
      )
      .join('')

    const paras = (txt) =>
      String(txt || '')
        .split(/\n+/)
        .filter((p) => p.trim())
        .map((p) => `<p style="margin:0 0 8px;font-size:12.5px;line-height:1.75;color:${RPT.ink}">${escH(p.trim())}</p>`)
        .join('')

    const vocabByCat = {}
    for (const v of res.vocab_upgrade || []) (vocabByCat[v.category || '观点功能短语'] = vocabByCat[v.category || '观点功能短语'] || []).push(v)
    const vocabHtml = Object.keys(vocabByCat)
      .map(
        (cat) =>
          `<div style="margin:0 0 10px"><div style="font-size:12px;font-weight:700;color:${RPT.accent};margin-bottom:4px">${escH(cat)}</div>` +
          vocabByCat[cat]
            .map(
              (v) =>
                `<div style="font-size:12.5px;color:${RPT.ink};margin:0 0 3px">` +
                `<b>${escH(v.advanced || v.term)}</b>` +
                (v.basic ? ` <span style="color:${RPT.soft}">← ${escH(v.basic)}</span>` : '') +
                (v.usage ? ` <span style="color:${RPT.accent}">（${escH(v.usage)}）</span>` : '') +
                `</div>`,
            )
            .join('') +
          `</div>`,
      )
      .join('')

    return `
<div style="font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif;color:${RPT.ink};background:#fff">
  <div style="border-bottom:2px solid ${RPT.accent};padding-bottom:10px;margin-bottom:14px">
    <div style="font-size:19px;font-weight:800">四六级写译训练 · 批改报告</div>
    <div style="font-size:12px;color:${RPT.soft};margin-top:4px">${escH(record.exam_id || '')} · ${escH(record.id || '')}</div>
  </div>
  <div style="${box};display:flex;gap:16px;align-items:flex-start">
    <div style="flex:1">${meta}</div>
    <div style="text-align:center;min-width:110px">
      <div style="font-size:34px;font-weight:800;color:${RPT.accent};line-height:1.1">${escH(res.total_score)}</div>
      <div style="font-size:11px;color:${RPT.soft}">/ 15 分</div>
      <div style="font-size:11px;color:${RPT.ink};margin-top:6px">${escH(res.grade_desc || '')}</div>
    </div>
  </div>
  <div style="${box}"><div style="${h2}">分项得分</div>
    <table style="width:100%;border-collapse:collapse">${dimRows}</table></div>
  <div style="${box}"><div style="${h2}">你的作答</div>
    <div style="font-size:12.5px;line-height:1.8;color:${RPT.ink};white-space:pre-wrap">${escH(record.text || '')}</div></div>
  ${errs ? `<div style="${box}"><div style="${h2}">错误明细（${(res.error_list || []).length} 条）</div>${errs}</div>` : ''}
  ${
    sents
      ? `<div style="${box}"><div style="${h2}">逐句改写 ↔ ${escH(m.officialLabel)}</div>
        <table style="width:100%;border-collapse:collapse"><tr>
          <td style="width:50%;vertical-align:top;padding-right:8px">${sents}</td>
          <td style="width:50%;vertical-align:top;padding-left:8px;background:${RPT.card};border-radius:8px;padding:10px">${paras(m.official)}</td>
        </tr></table></div>`
      : ''
  }
  ${
    res.revised_full
      ? `<div style="${box}"><div style="${h2}">全文改写稿</div>
        <div style="font-size:12.5px;line-height:1.8;color:${RPT.ink};border-left:3px solid ${RPT.accent};padding-left:10px;white-space:pre-wrap">${escH(res.revised_full)}</div></div>`
      : ''
  }
  ${vocabHtml ? `<div style="${box}"><div style="${h2}">高级词汇（按分类）</div>${vocabHtml}</div>` : ''}
  ${
    isTrans && (res.lost_info || []).length
      ? `<div style="${box}"><div style="${h2}">遗漏要点</div>${(res.lost_info || []).map((x) => `<div style="font-size:12.5px;color:${RPT.soft}">· ${escH(x)}</div>`).join('')}</div>`
      : ''
  }
  ${
    !isTrans && res.structure_comment
      ? `<div style="${box}"><div style="${h2}">结构评价</div><div style="font-size:12.5px;line-height:1.75">${escH(res.structure_comment)}</div></div>`
      : ''
  }
  ${
    res.personal_suggestion
      ? `<div style="${box};background:${RPT.card};border-color:#cfdcff"><div style="${h2};color:${RPT.accent}">个性化提升建议</div>
        <div style="font-size:12.5px;line-height:1.8">${escH(res.personal_suggestion)}</div></div>`
      : ''
  }
  <div style="font-size:10.5px;color:#9aa3b2;text-align:center;margin-top:10px">由 DeepSeek Harness · dsh-cetwt 生成 · 评分基准为真题自带官方材料</div>
</div>`
  }

  function reportPageHtml(record) {
    const body = reportBodyHtml(reportModel(record))
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>四六级写译批改报告 · ${escH(record.exam_id || record.id)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  html,body { margin:0; padding:0; background:#eef1f6; }
  #sheet { width: 210mm; min-height: 296mm; margin: 0 auto; background:#fff; padding: 6mm 0; box-sizing: border-box; }
  @media print { html,body { background:#fff } #sheet { width:auto; min-height:0; margin:0; padding:0 } #tools { display:none !important } }
  #tools { position:fixed; right:14px; top:12px; display:flex; gap:8px; z-index:9 }
  #tools button { font: 12px/1.6 system-ui,sans-serif; padding:6px 12px; border-radius:8px; border:1px solid #cfd6e4; background:#fff; cursor:pointer }
  #tools button.primary { background:#1a73e8; border-color:#1a73e8; color:#fff }
</style></head>
<body>
<div id="tools"><button class="primary" onclick="window.print()">打印 / 另存为 PDF</button><button onclick="window.close()">关闭</button></div>
<div id="sheet">${body}</div>
<script>window.addEventListener('load', function(){ setTimeout(function(){ try { window.print() } catch (e) {} }, 350) })</script>
</body></html>`
  }


  function bootstrap() {
    const sorted = [...records].sort((a, b) => b.created_at - a.created_at)
    return {
      exams,
      records: sorted.slice(0, 40).map(recordSummary),
      trend: buildTrend(),
      stats: computeStats(records),
      vocab: vocabSummary(),
      dataset: {
        total: exams.length,
        cet4: exams.filter((e) => e.level === 'CET4').length,
        cet6: exams.filter((e) => e.level === 'CET6').length,
      },
    }
  }

  // ---- 模型 ----------------------------------------------------------------------------------
  function selectModel() {
    const sel = ctx.agentDefaultModel?.currentSelection?.()
    if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model }
    throw new AppError('model-unavailable', '当前配置没有可用模型（agentDefaultModel 未设置）', 503)
  }

  async function generate({ system, parts, maxTokens: cap = maxTokens, temperature: temp = temperature, signal }) {
    const sel = selectModel()
    let text = ''
    let finish
    const debugTrace = []
    const options = {
      provider: sel.provider,
      model: sel.model,
      system,
      messages: [{ role: 'user', content: parts }],
      temperature: temp,
      maxTokens: cap,
      signal,
    }
    for await (const chunk of ctx.llm.stream(options)) {
      if (chunk?.type === 'text-delta') text += chunk.text ?? ''
      else if (chunk?.type === 'finish') finish = chunk.reason ?? chunk.finish
      if (debugTrace.length < 40) debugTrace.push(chunk?.type ?? typeof chunk)
    }
    let truncated = false
    if (typeof finish === 'string') {
      if (/length|token|max/i.test(finish)) truncated = true
      if (/abort|cancel/i.test(finish)) throw new AppError('aborted', '生成被取消', 499)
    } else if (finish && typeof finish === 'object') {
      if (finish.kind === 'aborted') throw new AppError('aborted', '生成被取消', 499)
      if (finish.kind === 'error') throw new AppError('llm-error', finish.failure?.message ?? '模型调用失败', 502)
      if (/length|token|max/i.test(String(finish.kind ?? ''))) truncated = true
    }
    if (text.trim() === '') {
      try {
        await fsp.mkdir(storeDir, { recursive: true })
        await fsp.writeFile(
          path.join(storeDir, 'debug-llm.json'),
          JSON.stringify({ chunkTypes: debugTrace, finish, system, cap, temp, model: sel.model }, null, 2),
          'utf8',
        )
      } catch {
        /* ignore */
      }
      throw new AppError('empty-response', '模型没有返回内容', 502)
    }
    return { text, provider: sel.provider, model: sel.model, truncated }
  }

  async function callJson({ system, buildPrompt, signal, cap }) {
    let lastError
    let lastRaw = ''
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const userText =
        attempt === 0
          ? buildPrompt(0)
          : `${buildPrompt(1)}\n\n【上一次回复不合格：${lastError}】请重新输出，严格只给一个合法 JSON 对象，不要解释、不要代码块，字段精简。`
      let out
      try {
        out = await generate({
          system,
          parts: [{ type: 'text', text: userText }],
          signal,
          cap,
        })
      } catch (error) {
        if (error instanceof AppError && (error.status === 499 || signal?.aborted)) throw error
        lastError = error instanceof Error ? error.message : String(error)
        await pause(600 * (attempt + 1))
        continue
      }
      lastRaw = out.text
      try {
        return parseJsonLoose(out.text)
      } catch (error) {
        lastError = (error instanceof Error ? error.message : String(error)) + (out.truncated ? '（输出被 maxTokens 截断）' : '')
      }
    }
    try {
      await fsp.mkdir(storeDir, { recursive: true })
      await fsp.writeFile(path.join(storeDir, 'last-llm-raw.txt'), lastRaw, 'utf8')
    } catch {
      /* 诊断文件写不进去不影响主流程 */
    }
    throw new AppError('invalid-json', `模型没有返回合法 JSON：${lastError}`, 502)
  }

  // ---- 图片 ----------------------------------------------------------------------------------
  function parseDataUrl(dataUrl) {
    if (typeof dataUrl !== 'string') throw new AppError('bad-image', 'image.dataUrl 必须是字符串')
    const match = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl.trim())
    if (!match) throw new AppError('bad-image', '只支持 base64 的 PNG/JPEG/WebP/GIF 图片')
    const mediaType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase()
    return { mediaType, bytes: Buffer.from(match[2], 'base64') }
  }

  async function imageRefFrom(dataUrl, imageName) {
    const store = ctx.attachments ?? ctx.get?.('attachments')
    if (typeof store?.saveImages !== 'function') throw new AppError('no-attachments', '当前组合没有附件服务', 503)
    const { mediaType, bytes } = parseDataUrl(dataUrl)
    const limits = store.imageLimits
    if (limits?.maxImageBytes !== undefined && bytes.length > limits.maxImageBytes) {
      throw new AppError('image-too-large', `图片超过上限 ${limits.maxImageBytes} 字节`)
    }
    const [ref] = await store.saveImages([{ data: bytes, mediaType, name: imageName || 'cetwt-handwriting' }])
    if (!ref) throw new AppError('image-save-failed', '附件服务没有返回图片引用', 500)
    return ref
  }

  // ---- OCR -----------------------------------------------------------------------------------
  const OCR_SYSTEM = [
    '你是一台严格的手写英文 OCR 引擎，专门识别中国大学生四六级作文的手写答题。',
    '只提取英文作答内容：过滤中文、草稿涂鸦、页眉页码、与作答无关的笔迹。',
    '被划掉的句子输出时加上【已划去，不计入作答】标记。',
    '结合四六级作文语境校正手写连笔与字母混淆（l/1、o/0、a/u），但不要改写用词、不要纠正语法、不要润色。',
    '置信度低的片段用 [?] 标注。',
    '只输出一个 JSON 对象：{"ok":boolean,"text":string,"confidence":number,"notes":string[]}',
    '图片空白、没有英文手写文字时 ok=false、text=""、notes 说明原因。',
  ].join('\n')

  async function runOcr({ imageRef, level, writingPrompt, signal }) {
    const parts = [
      {
        type: 'text',
        text: [
          `考生等级：${level}。`,
          writingPrompt ? `本次写作题干：${writingPrompt.slice(0, 600)}` : '',
          '请逐字转写图片中的手写英文作文，按段落分行，只输出 JSON。',
        ]
          .filter(Boolean)
          .join('\n'),
      },
      { type: 'image', attachment: imageRef },
    ]
    const out = await generate({
      system: OCR_SYSTEM,
      parts,
      temperature: 0,
      signal: combineSignals([signal, AbortSignal.timeout(OCR_TIMEOUT_MS)]),
    })
    let parsed
    try {
      parsed = parseJsonLoose(out.text)
    } catch {
      parsed = { ok: true, text: out.text, confidence: 0.5, notes: ['模型未按 JSON 返回，已按纯文本处理'] }
    }
    const text = str(parsed.text)
    const ok = parsed.ok === false ? false : text.length > 0
    return {
      ok,
      ocr_text: text,
      note: strList(parsed.notes, 6).join('；') || (ok ? '识别完成，请核对人名、数字与专有名词' : '未识别到手写英文'),
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
      model: out.model,
    }
  }

  // ---- 评分 ----------------------------------------------------------------------------------
  function rubricText(taskType, level) {
    const r = RUBRIC[taskType]
    const dims = Object.entries(r.dims)
      .map(([k, v]) => `${k}=${v}分`)
      .join('、')
    return [
      `满分 ${r.max} 分，分项满分：${dims}（合计必须等于 ${r.max}）。`,
      '档位划分：',
      ...r.bands.map((b) => `- ${b}`),
      `考生为 ${level}，${level === 'CET4' ? 'CET4 优先使用四级大纲词汇' : 'CET6 可合理使用六级词汇，重视表达地道与句式多样'}。`,
    ].join('\n')
  }

  function buildGradePrompt({ taskType, level, exam, text, wordLimit, needsSample = true, compact = false }) {
    const lines = [
      `任务类型：${taskType === 'translation' ? '汉译英翻译（Part IV Translation）' : '英文写作（Part I Writing）'}；等级：${level}。`,
      `真题信息：${exam?.exam_date ?? '未知'} 第${exam?.set ?? '?'}套；主题：${exam?.topic ?? '综合'}。`,
      '',
      '【评分细则（教育部四六级官方档次）】',
      rubricText(taskType, level),
      '',
    ]
    if (taskType === 'translation') {
      lines.push('【中文原文（评分基准，逐点核对信息是否译出）】', str(exam?.zh_source).slice(0, 1500) || '（未收录）', '')
      if (exam?.ref_trans) lines.push('【官方参考译文（仅供你核对信息点，不要照搬给考生）】', str(exam.ref_trans).slice(0, 1800), '')
    } else {
      lines.push('【写作题干】', str(exam?.writing_prompt).slice(0, 1200) || '（未收录）', '')
      if (wordLimit) lines.push(`字数要求：${wordLimit} 词。`)
      if (exam?.ref_idea) lines.push('【官方高分范文（仅供你核对要点覆盖，不要照抄）】', str(exam.ref_idea).slice(0, 1800), '')
    }
    lines.push('', '【考生作答（逐字原文，禁止脑补）】', '<<<', text.slice(0, MAX_TEXT_CHARS), '>>>', '')
    lines.push(
      '【高级词汇分类（vocab_upgrade.category 只能取下列 23 个之一，逐字照抄，不要自创）】',
      VOCAB_CATEGORIES.join('；'),
      '',
    )
    const sampleField = needsSample ? '"study_sample":string,' : ''
    const sampleRule = needsSample
      ? [
          '5) study_sample 是给考生背诵的学习范文：英文，' +
            (taskType === 'translation' ? '忠实于中文原文的优化译文' : level === 'CET4' ? '120-180 词' : '150-200 词') +
            '，不得偏离题干原意。',
        ]
      : ['5) 不要输出 study_sample 字段（本次已有官方范文/译文作为背诵基准）。']
    lines.push(
      '【输出要求】只输出一个 JSON 对象，字段如下，中间不要任何注释或说明：',
      taskType === 'translation'
        ? `{"total_score":number,"grade_desc":string,"dim_score":{"faithful":n,"vocab":n,"grammar":n,"fluency":n},"dim_comment":{"faithful":string,"vocab":string,"grammar":string,"fluency":string},"error_list":[{"error_type":"错译|漏译|搭配错误|语法错误|中式英语","source_fragment":string,"user_fragment":string,"correct_version":string,"explanation":string}],"lost_info":[string],${sampleField}"revised_full":string,"sentence_review":[{"sentence":string,"issue":string,"revision":string,"upgrade":string}],"vocab_upgrade":[{"basic":string,"advanced":string,"category":string,"usage":string,"note":string,"example":string}],"review_points":[string],"personal_suggestion":string}`
        : `{"total_score":number,"grade_desc":string,"dim_score":{"content":n,"coherence":n,"vocab":n,"grammar":n},"dim_comment":{"content":string,"coherence":string,"vocab":string,"grammar":string},"error_list":[{"error_type":"语法错误|搭配错误|用词不当|中式表达|逻辑断层","user_fragment":string,"correct_version":string,"explanation":string}],"structure_comment":string,${sampleField}"revised_full":string,"sentence_review":[{"sentence":string,"issue":string,"revision":string,"upgrade":string}],"vocab_upgrade":[{"basic":string,"advanced":string,"category":string,"usage":string,"note":string,"example":string}],"review_points":[string],"personal_suggestion":string}`,
      '硬性规则：',
      '1) 只引用考生原文中真实存在的片段，user_fragment 必须逐字摘录；不得虚构错误。',
      `2) error_list 同类错误合并去重，最多 ${compact ? 4 : 6} 条，按严重程度排序。`,
      '3) total_score 与分项分必须自洽（等于各分项之和），保留 0.5 分精度。',
      `4) review_points 每条写成「词/短语/句型｜中文说明」，共 ${compact ? 3 : 4} 条。`,
      ...sampleRule,
      `6) personal_suggestion 用中文，${compact ? '不超过 60 字，' : ''}指出 2-3 个最值得先改的点，具体可执行。`,
      `7) 每个 explanation ${compact ? '不超过 25 字' : '不超过 40 字'}，直接说考点和扣分原因，不要复述原句。`,
      taskType === 'translation'
        ? '8) 分数必须与错误清单自洽：有错译/漏译则总分 ≤12，有语法/搭配/中式英语错误则总分 ≤12.5，错误达 5 条则 ≤11；lost_info 只列真正没译出的信息点，不要与 error_list 重复。'
        : '8) 分数必须与错误清单自洽：错误达 3 条则总分 ≤12.5，达 5 条则 ≤11，跑题或段落逻辑断层则 ≤11；不要一边给 13 分以上一边列出多条语言错误。',
      `9) sentence_review 逐句改写，必须覆盖考生全文：按句切分后**每一句都给一条**（标点导致的碎句可并入相邻句，但不能整句漏掉），最多 40 条；sentence 逐字摘录考生原句（不得改写原句）；issue 用中文点明问题（词汇低级 / 表达不准确 / 句式单调 / 中式表达 / 衔接生硬 / 信息缺失 / 语法错误）；revision 给改写后的完整句子，保持原意且符合${level}水平；upgrade 用中文说明升级点（替换了哪个词、改用了什么句型），${compact ? '不超过 20 字' : '不超过 30 字'}。`,
      `10) revised_full 全文改写稿：把考生整篇作答按第 9 条的改法统一成一篇连贯的终稿（翻译给优化后的英文译文，作文给润色后的全文），保持原意与原段落结构、长度相当，不得新增考生没有的观点或信息点。`,
      `11) vocab_upgrade 同义替换表：${compact ? 4 : 6}-${compact ? 4 : 10} 组，basic 必须是考生原文里真实出现的词或短语，advanced 是${level === 'CET4' ? '四级大纲内更准确、更地道的高级表达' : '六级常用的高分表达'}（不要生僻超纲词）；category 必须从上表 23 个分类中**原样选一个**（不改字、不加字）；usage 用中文标注用法（词性 + 常见搭配/句型/语域，不超过 18 字，例如「v. 及物，常接 that 从句」）；note 用中文说明与 basic 的差别；example 是含 advanced 的英文例句（不超过 20 词）。`,
    )
    return lines.join('\n')
  }

  /** 分数自洽：错误越多越不该落在高分段，给 error_list 反推的硬性上限。 */
  function consistencyCap(taskType, errors) {
    const types = errors.map((e) => e.error_type)
    const has = (re) => types.some((type) => re.test(type))
    if (taskType === 'translation') {
      let cap = 15
      if (has(/错译|漏译/)) cap = Math.min(cap, 12)
      if (has(/语法|搭配|中式/)) cap = Math.min(cap, 12.5)
      if (errors.length >= 5) cap = Math.min(cap, 11)
      return cap
    }
    let cap = 15
    if (errors.length >= 3) cap = Math.min(cap, 12.5)
    if (errors.length >= 5) cap = Math.min(cap, 11)
    if (has(/逻辑断层|跑题/)) cap = Math.min(cap, 11)
    return cap
  }

  /** 把分项分按 0.5 档逐级压到 target 以内，返回压缩后的合计。 */
  function shrinkDims(dimScore, dimsSpec, target) {
    const keys = Object.keys(dimsSpec).sort((a, b) => dimScore[b] - dimScore[a])
    let sum = keys.reduce((acc, key) => acc + dimScore[key], 0)
    let guard = 0
    while (sum - target > 0.0001 && guard < 400) {
      let shrunk = false
      for (const key of keys) {
        if (sum - target <= 0.0001) break
        if (dimScore[key] >= 0.5) {
          dimScore[key] = Math.round((dimScore[key] - 0.5) * 2) / 2
          sum -= 0.5
          shrunk = true
        }
      }
      if (!shrunk) break
      guard += 1
    }
    return sum
  }

  function normalizeGrade(taskType, raw) {
    const dimsSpec = RUBRIC[taskType].dims
    const dimScore = {}
    let sum = 0
    for (const [key, max] of Object.entries(dimsSpec)) {
      const value = clamp(raw?.dim_score?.[key], 0, max, Math.round(max / 2))
      dimScore[key] = value
      sum += value
    }
    const errorList = Array.isArray(raw?.error_list) ? raw.error_list : []
    const errors = errorList
      .map((e) => ({
        error_type: str(e?.error_type, '语法错误') || '语法错误',
        source_fragment: str(e?.source_fragment),
        user_fragment: str(e?.user_fragment),
        correct_version: str(e?.correct_version),
        explanation: str(e?.explanation),
      }))
      .filter((e) => e.user_fragment !== '' || e.correct_version !== '')
      .slice(0, 8)

    const cap = consistencyCap(taskType, errors)
    const modelTotal = Number.isFinite(Number(raw?.total_score)) ? clamp(raw.total_score, 0, 15, sum) : sum
    const target = Math.min(sum, cap, modelTotal)
    const finalSum = target < sum ? shrinkDims(dimScore, dimsSpec, target) : sum
    const total = Math.round(finalSum * 2) / 2

    const result = {
      task_type: taskType,
      total_score: total,
      grade_desc: gradeBand(total, taskType),
      dim_score: dimScore,
      dim_comment: {
        ...Object.fromEntries(Object.keys(dimsSpec).map((k) => [k, str(raw?.dim_comment?.[k])])),
      },
      error_list: errors,
      revised_full: str(raw?.revised_full),
      sentence_review: (Array.isArray(raw?.sentence_review) ? raw.sentence_review : [])
        .map((s) => ({
          sentence: str(s?.sentence),
          issue: str(s?.issue),
          revision: str(s?.revision),
          upgrade: str(s?.upgrade),
        }))
        .filter((s) => s.sentence !== '' && s.revision !== '')
        .slice(0, 40),
      vocab_upgrade: (Array.isArray(raw?.vocab_upgrade) ? raw.vocab_upgrade : [])
        .map((v) => ({
          basic: str(v?.basic),
          advanced: str(v?.advanced),
          category: canonicalCategory(v?.category),
          usage: str(v?.usage),
          note: str(v?.note),
          example: str(v?.example),
        }))
        .filter((v) => v.basic !== '' && v.advanced !== '')
        .slice(0, 12),
      review_points: strList(raw?.review_points, 8),
      personal_suggestion: str(raw?.personal_suggestion),
    }
    if (taskType === 'translation') {
      result.lost_info = strList(raw?.lost_info, 8)
      result.learn_version = str(raw?.study_sample)
    } else {
      result.structure_comment = str(raw?.structure_comment)
      result.sample_essay = str(raw?.study_sample)
    }
    return result
  }

  function uiSchema(taskType, hasImage) {
    const order = taskType === 'translation' || !hasImage
      ? PANEL_ORDER.filter((p) => p !== 'ocr_panel')
      : [...PANEL_ORDER]
    return {
      side: 'left',
      fixed: true,
      panel_order: order,
      panel_config: JSON.parse(JSON.stringify(PANEL_CONFIG)),
    }
  }

  function ensureSample(result, taskType, exam) {
    if (taskType === 'translation') {
      const official = str(exam?.ref_trans)
      if (official) result.learn_version = official
      if (!result.learn_version) result.learn_version = ''
      result.sample_official = Boolean(official)
    } else {
      const official = str(exam?.ref_idea)
      if (official) result.sample_essay = official
      if (!result.sample_essay) result.sample_essay = ''
      result.sample_official = Boolean(official)
    }
    return result
  }

  // ---- 一次批改 ------------------------------------------------------------------------------
  async function gradeOnce(input, signal) {
    const taskType = input.task_type
    const level = input.level
    if (!TASK_TYPES.has(taskType)) throw new AppError('bad-request', 'task_type 必须是 translation 或 writing')
    if (!LEVELS.has(level)) throw new AppError('bad-request', 'level 必须是 CET4 或 CET6')

    const exam = examById.get(input.exam_id) ?? null
    const hasImage = Boolean(input.image && typeof input.image.dataUrl === 'string' && input.image.dataUrl !== '')
    const inputMode = input.mode === 'writing-image' || hasImage ? 'image' : 'text'

    let ocrMeta = null
    let text = str(input.text)
    if (text.length > MAX_TEXT_CHARS) throw new AppError('bad-request', `作答超过 ${MAX_TEXT_CHARS} 字符`)

    let imageRef
    if (hasImage) imageRef = await imageRefFrom(input.image.dataUrl, input.image.name)

    if (imageRef !== undefined && !(inputMode === 'image' && text !== '' && input.ocrVerified === true)) {
      const ocr = await runOcr({
        imageRef,
        level,
        writingPrompt: str(exam?.writing_prompt) || str(input.writing_prompt),
        signal,
      })
      ocrMeta = {
        is_image_input: true,
        ocr_raw_text: ocr.ocr_text,
        confidence_note: ocr.note,
        is_ocr_success: ocr.ok,
      }
      if (!ocr.ok && text === '') {
        const result = emptyResult(taskType, level)
        return { payload: { ui_schema: uiSchema(taskType, true), ocr_meta: ocrMeta, result }, ocr }
      }
      if (ocr.ok && text === '') text = ocr.ocr_text
    }

    if (text.trim() === '') throw new AppError('bad-request', '作答内容为空：请上传手写图片或输入文本')

    const officialSample = taskType === 'translation' ? str(exam?.ref_trans) : str(exam?.ref_idea)
    const needsSample = officialSample === ''
    const wordLimit = str(exam?.word_limit) || str(input.word_limit)
    const raw = await callJson({
      system:
        '你是教育部四六级考试（CET）写译阅卷专家。严格按官方档次评分，只依据考生原文，绝不编造错误、绝不虚构范文观点。输出严格 JSON。',
      buildPrompt: (attempt) =>
        buildGradePrompt({ taskType, level, exam, text, wordLimit, needsSample, compact: attempt > 0 }),
      signal: combineSignals([signal, AbortSignal.timeout(GRADE_TIMEOUT_MS)]),
      cap: maxTokens,
    })

    const result = ensureSample(normalizeGrade(taskType, raw), taskType, exam)
    const payload = { ui_schema: uiSchema(taskType, inputMode === 'image'), ocr_meta: ocrMeta, result }

    const record = {
      id: `cetwt-${Date.now()}-${randomUUID().slice(0, 8)}`,
      created_at: Date.now(),
      task_type: taskType,
      input_mode: inputMode,
      level,
      exam_id: exam?.id ?? str(input.exam_id),
      exam_date: exam?.exam_date ?? str(input.exam_date),
      set: exam?.set ?? input.set ?? null,
      topic: exam?.topic ?? str(input.topic),
      ocr_meta: ocrMeta,
      text: text.slice(0, MAX_TEXT_CHARS),
      total_score: result.total_score,
      dim_score: result.dim_score,
      grade_desc: result.grade_desc,
      error_types: result.error_list.map((e) => e.error_type),
      error_list: result.error_list,
      dim_comment: result.dim_comment,
      revised_full: result.revised_full,
      sentence_review: result.sentence_review,
      vocab_upgrade: result.vocab_upgrade,
      review_points: result.review_points,
      personal_suggestion: result.personal_suggestion,
      lost_info: result.lost_info ?? [],
      structure_comment: result.structure_comment ?? '',
      sample_used: taskType === 'translation' ? 'ref_trans' : 'ref_idea',
      retested: false,
      retest_delta: null,
    }
    records.push(record)
    await saveRecords()

    // 本次批改产出的高级词汇按分类并入词汇库（持久化）
    const vocab = mergeVocab(result.vocab_upgrade, record)
    if (vocab.added + vocab.merged > 0) await saveVocab()
    return { payload, record_id: record.id, ocr: ocrMeta, vocab }
  }

  function emptyResult(taskType, level) {
    const dims = Object.fromEntries(Object.keys(RUBRIC[taskType].dims).map((k) => [k, 0]))
    const result = {
      task_type: taskType,
      total_score: 0,
      grade_desc: 'OCR 识别失败：未从图片中识别到手写英文，总分 0 分',
      dim_score: dims,
      dim_comment: Object.fromEntries(Object.keys(dims).map((k) => [k, '未能识别作答内容'])),
      error_list: [],
      revised_full: '',
      sentence_review: [],
      vocab_upgrade: [],
      review_points: [],
      personal_suggestion: '识别失败。请重新拍摄：纸张平整、光线均匀、字迹清晰、只拍作答区域。',
    }
    if (taskType === 'translation') {
      result.lost_info = []
      result.learn_version = ''
    } else {
      result.structure_comment = '未能识别作答内容，无法评价结构。'
      result.sample_essay = ''
    }
    return result
  }

  // ---- 错题卡 / Anki -------------------------------------------------------------------------
  function findRecord(id) {
    const record = records.find((r) => r.id === id)
    if (!record) throw new AppError('not-found', `没有找到记录 ${id}`, 404)
    return record
  }

  async function saveCard(record) {
    await fsp.mkdir(storeDir, { recursive: true })
    const file = path.join(storeDir, 'mistake-cards.md')
    const lines = []
    lines.push(`## ${record.exam_date} 第${record.set ?? '?'}套 · ${record.topic} · ${record.level} · ${record.task_type === 'translation' ? '翻译' : '写作'}`)
    lines.push('')
    lines.push(`- 得分：${record.total_score}/15（${record.grade_desc}）`)
    lines.push(`- 记录：${record.id}`)
    lines.push('')
    lines.push('**你的作答**')
    lines.push('')
    lines.push('> ' + record.text.replace(/\n+/g, ' ').slice(0, 900))
    lines.push('')
    if (record.error_list.length > 0) {
      lines.push('**错误清单**')
      lines.push('')
      for (const e of record.error_list) {
        lines.push(`- 【${e.error_type}】${e.user_fragment || ''} → ${e.correct_version || ''}${e.explanation ? `（${e.explanation}）` : ''}`)
      }
      lines.push('')
    }
    if (record.review_points.length > 0) {
      lines.push('**考点记忆卡**')
      lines.push('')
      for (const p of record.review_points) lines.push(`- ${p}`)
      lines.push('')
    }
    lines.push('---')
    lines.push('')
    await fsp.appendFile(file, lines.join('\n'), 'utf8')
    return file
  }

  async function appendAnki(record) {
    await fsp.mkdir(storeDir, { recursive: true })
    const file = path.join(storeDir, 'anki-import.tsv')
    const deckTag = `${record.level}_${record.task_type}`
    const rows = []
    for (const e of record.error_list) {
      const front = `${e.user_fragment || record.text.slice(0, 80)}`
      const back = `${e.correct_version || ''}${e.explanation ? `<br>${e.explanation}` : ''}<br><i>${record.exam_date} 第${record.set ?? '?'}套 ${e.error_type}</i>`
      rows.push([deckTag, front, back].map((v) => String(v).replace(/\t/g, ' ').replace(/\r?\n/g, '<br>')).join('\t'))
    }
    for (const p of record.review_points) {
      const [term, note] = p.split(/｜|—/)
      rows.push([`${deckTag}_points`, term ?? p, note ?? ''].map((v) => String(v).replace(/\t/g, ' ')).join('\t'))
    }
    if (rows.length === 0) return null
    await fsp.appendFile(file, rows.join('\n') + '\n', 'utf8')
    return file
  }

  // ---- 高级词汇板块（分类词汇库）--------------------------------------------------------------
  /** 词汇库快照：固定 23 分类 + 分组计数 + 明细，供「高级词汇」页渲染。 */
  function vocabPayload() {
    return {
      ok: true,
      categories: VOCAB_CATEGORIES,
      summary: vocabSummary(),
      items: vocabSorted().map((v) => ({
        key: v.key,
        term: v.term,
        category: v.category,
        group: v.group,
        basic: v.basic,
        cn: v.cn,
        usage: v.usage,
        example: v.example,
        level: v.level,
        hits: v.hits ?? 1,
        mastered: Boolean(v.mastered),
        first_at: v.first_at ?? null,
        last_at: v.last_at ?? null,
        source: v.source ?? null,
      })),
    }
  }

  async function vocabMutation(body) {
    const action = str(body?.action)
    const key = str(body?.key)
    if (key === '') throw new AppError('bad-request', '缺少 key')
    const item = vocabItems.find((v) => v.key === key)
    if (!item) throw new AppError('not-found', `词汇库里没有 ${key}`, 404)
    if (action === 'master') item.mastered = true
    else if (action === 'unmaster') item.mastered = false
    else if (action === 'delete') vocabItems = vocabItems.filter((v) => v.key !== key)
    else if (action === 'hits') item.hits = (item.hits ?? 1) + 1
    else throw new AppError('bad-request', 'action 只支持 master/unmaster/delete')
    await saveVocab()
    return { ok: true, summary: vocabSummary(), item: action === 'delete' ? null : item }
  }

  /** 词汇库导出 CSV（按分类排序，便于打印复习）。 */
  async function exportVocabCsv() {
    const order = (item) => {
      const ci = VOCAB_CATEGORIES.indexOf(item.category)
      return ci === -1 ? 999 : ci
    }
    const list = [...vocabItems].sort((a, b) => order(a) - order(b) || (b.hits ?? 1) - (a.hits ?? 1))
    const rows = [['分类', '高级词汇', '原表达', '中文/差别', '用法', '例句', '出现次数', '已掌握', '来源'].join(',')]
    for (const v of list) {
      rows.push(
        [
          v.category,
          v.term,
          v.basic ?? '',
          v.cn ?? '',
          v.usage ?? '',
          v.example ?? '',
          v.hits ?? 1,
          v.mastered ? '是' : '否',
          `${v.source?.exam_date ?? ''} 第${v.source?.set ?? '?'}套`,
        ]
          .map(csvCell)
          .join(','),
      )
    }
    await fsp.mkdir(storeDir, { recursive: true })
    const file = path.join(storeDir, '高级词汇库.csv')
    await fsp.writeFile(file, '\ufeff' + rows.join('\r\n'), 'utf8')
    return { ok: true, path: file, rows: list.length }
  }

  /** 词汇库导入 Anki（分类作 deck 标签，背面含用法与例句）。 */
  async function exportVocabAnki({ onlyNew = true } = {}) {
    const list = vocabItems.filter((v) => (onlyNew ? !v.mastered : true))
    if (list.length === 0) return { ok: true, path: null, rows: 0 }
    await fsp.mkdir(storeDir, { recursive: true })
    const file = path.join(storeDir, 'anki-vocab.tsv')
    const clean = (v) => String(v ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, '<br>')
    const rows = list.map((v) => {
      const tag = `CET_vocab::${v.category.replace(/[ &、]/g, '_')}`
      const back = [
        v.cn ? clean(v.cn) : '',
        v.usage ? `用法：${clean(v.usage)}` : '',
        v.example ? `<i>${clean(v.example)}</i>` : '',
        v.basic ? `（原表达：${clean(v.basic)}）` : '',
      ].filter(Boolean).join('<br>')
      return [tag, clean(v.term), back].join('\t')
    })
    await fsp.writeFile(file, rows.join('\n') + '\n', 'utf8')
    return { ok: true, path: file, rows: rows.length }
  }

  // ---- HTTP ----------------------------------------------------------------------------------
  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      ...SECURITY_HEADERS,
    })
    res.end(body)
  }

  function sendHtml(res, status, html) {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy':
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
    })
    res.end(html)
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          reject(new AppError('body-too-large', `请求体超过 ${MAX_BODY_BYTES} 字节`, 413))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  function isLoopback(req) {
    const address = req.socket?.remoteAddress ?? ''
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.')
  }

  async function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname.slice(ROUTE.length))
    if (rel === '' || rel === '/') rel = '/app/index.html'
    const abs = path.resolve(path.join(PLUGIN_DIR, rel))
    if (!(abs === APP_DIR || abs.startsWith(APP_DIR + path.sep) || abs.startsWith(path.join(PLUGIN_DIR, 'data') + path.sep))) {
      sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'path outside plugin' } })
      return
    }
    let stat
    try {
      stat = await fsp.stat(abs)
    } catch {
      sendJson(res, 404, { ok: false, error: { code: 'not-found', message: rel } })
      return
    }
    if (!stat.isFile()) {
      sendJson(res, 404, { ok: false, error: { code: 'not-found', message: rel } })
      return
    }
    const type = MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream'
    const body = await fsp.readFile(abs)
    res.writeHead(200, {
      'content-type': type,
      'content-length': body.length,
      'cache-control': 'no-cache',
      ...SECURITY_HEADERS,
      'content-security-policy':
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'",
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  async function handle(req, res, signal) {
    if (!isLoopback(req)) {
      sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'loopback only' } })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith(ROUTE)) {
      sendJson(res, 404, { ok: false, error: { code: 'not-found', message: url.pathname } })
      return
    }
    const rest = url.pathname.slice(ROUTE.length).replace(/^\/+/, '').replace(/\/+$/, '')

    if (rest === 'api/health') {
      sendJson(res, 200, { ok: true, plugin: name, build: 5, exams: exams.length, records: records.length, vocab: vocabItems.length, store: storeFile, vocabStore: vocabFile })
      return
    }

    if (rest === 'api/bootstrap') {
      sendJson(res, 200, bootstrap())
      return
    }

    // 自检：报告前端 bundle 是否已进入 Web GUI 的客户端模块图（dock 能否加载）
    if (rest === 'api/debug') {
      const out = { ok: true, hasRegistry: false }
      let registry
      try {
        registry = typeof ctx.get === 'function' ? ctx.get('clientModules') : undefined
      } catch (error) {
        out.registryError = String(error?.message ?? error)
      }
      if (registry) {
        out.hasRegistry = true
        try {
          const graph = registry.graph()
          out.graphKeys = Object.keys(graph ?? {})
          const rows = Array.isArray(graph?.entries) ? graph.entries : Array.isArray(graph?.rows) ? graph.rows : []
          out.rowCount = rows.length
          out.ids = rows.map((row) => row?.id)
          const mine = rows.find((row) => row?.id === name)
          if (mine) out.mine = { id: mine.id, url: mine.url, rev: mine.rev, immediately: mine.immediately }
          try {
            const bundle = registry.clientPath?.(name)
            out.clientPath = bundle ?? null
            out.clientPathExists = bundle ? fs.existsSync(bundle) : null
            if (bundle && fs.existsSync(bundle)) out.clientBytes = fs.statSync(bundle).size
          } catch (error) {
            out.clientPathError = String(error?.message ?? error)
          }
        } catch (error) {
          out.graphError = String(error?.message ?? error)
        }
      }
      sendJson(res, 200, out)
      return
    }

    // 练习记录：完整成绩走势 + 记录列表（前端折线图用）
    if (rest === 'api/history') {
      const sorted = [...records].sort((a, b) => b.created_at - a.created_at)
      sendJson(res, 200, {
        ok: true,
        trend: buildTrend(),
        records: sorted.slice(0, 200).map(recordSummary),
        stats: computeStats(records),
        dataset: { total: exams.length },
      })
      return
    }

    // 单次记录回看：复原当次批改的完整 payload
    if (rest === 'api/record') {
      const id = str(url.searchParams.get('id'))
      if (!id) {
        sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 id' } })
        return
      }
      const record = records.find((r) => r.id === id)
      if (!record) {
        sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `没有找到记录 ${id}` } })
        return
      }
      sendJson(res, 200, { ok: true, ...recordPayload(record) })
      return
    }

    // 导出报告：整页 HTML（浏览器里 Ctrl+P / 按钮保存为 PDF），或只取报告正文给前端截图
    if (rest === 'api/report') {
      const id = str(url.searchParams.get('id'))
      const record = records.find((r) => r.id === id)
      if (!record) {
        sendHtml(res, 404, '<!doctype html><meta charset="utf-8"><p style="font:14px system-ui;padding:24px">没有找到这条记录。</p>')
        return
      }
      if (url.searchParams.get('format') === 'body') {
        sendJson(res, 200, {
          ok: true,
          html: reportBodyHtml(reportModel(record)),
          title: `${record.exam_id || record.id} 批改报告`,
          filename: `${record.exam_id || 'cetwt'}-${record.id}.png`,
        })
        return
      }
      sendHtml(res, 200, reportPageHtml(record))
      return
    }

    // 高级词汇板块：分类词汇库（固定 23 分类）
    if (rest === 'api/vocab') {
      sendJson(res, 200, vocabPayload())
      return
    }

    if (rest === 'api/vocab_export') {
      sendJson(res, 200, await exportVocabCsv())
      return
    }
    // 导出成绩单（CSV，带 BOM，Excel 直接打开不乱码）
    if (rest === 'api/export') {
      const sorted = [...records].sort((a, b) => a.created_at - b.created_at)
      const rows = [['时间', '板块', '级别', '真题日期', '套号', '主题', '总分', '分项', '错误类型', '是否复测'].join(',')]
      for (const r of sorted) {
        const mode = r.task_type === 'translation' ? '翻译' : r.input_mode === 'image' ? '作文(手写)' : '作文(文本)'
        const dims = Object.entries(r.dim_score || {}).map(([k, v]) => `${k}=${v}`).join(' ')
        rows.push(
          [
            new Date(r.created_at).toLocaleString('zh-CN'),
            mode,
            r.level ?? '',
            r.exam_date ?? '',
            r.set ?? '',
            r.topic ?? '',
            r.total_score ?? '',
            dims,
            (r.error_types ?? []).join(' '),
            r.retested ? '是' : '否',
          ]
            .map(csvCell)
            .join(','),
        )
      }
      await fsp.mkdir(storeDir, { recursive: true })
      const file = path.join(storeDir, '成绩单.csv')
      await fsp.writeFile(file, '\ufeff' + rows.join('\r\n'), 'utf8')
      sendJson(res, 200, { ok: true, path: file, rows: sorted.length })
      return
    }

    if (rest.startsWith('app/') || rest === 'app') {
      await serveStatic(req, res, url)
      return
    }

    if (req.method !== 'POST' && rest.startsWith('api/')) {
      sendJson(res, 405, { ok: false, error: { code: 'method', message: 'POST only' } })
      return
    }

    let body = {}
    if (req.method === 'POST') {
      const raw = await readBody(req)
      if (raw.trim() !== '') {
        try {
          body = JSON.parse(raw)
        } catch {
          sendJson(res, 400, { ok: false, error: { code: 'bad-json', message: '请求体不是合法 JSON' } })
          return
        }
      }
    }

    if (rest === 'api/ocr') {
      if (!body.image?.dataUrl) throw new AppError('bad-request', '缺少 image.dataUrl')
      const exam = examById.get(body.exam_id)
      const imageRef = await imageRefFrom(body.image.dataUrl, body.image.name)
      const ocr = await runOcr({
        imageRef,
        level: LEVELS.has(body.level) ? body.level : 'CET6',
        writingPrompt: str(exam?.writing_prompt) || str(body.writing_prompt),
        signal,
      })
      sendJson(res, 200, { ok: ocr.ok, ocr_text: ocr.ocr_text, note: ocr.note, confidence: ocr.confidence })
      return
    }

    if (rest === 'api/grade') {
      const out = await gradeOnce(body, signal)
      sendJson(res, 200, { ok: true, payload: out.payload, record_id: out.record_id ?? null })
      return
    }

    if (rest === 'api/vocab') {
      sendJson(res, 200, await vocabMutation(body))
      return
    }

    if (rest === 'api/vocab_anki') {
      sendJson(res, 200, await exportVocabAnki({ onlyNew: body.only_new !== false }))
      return
    }
    if (rest === 'api/save_card') {
      const record = findRecord(body.record_id)
      const file = await saveCard(record)
      sendJson(res, 200, { ok: true, path: file })
      return
    }

    if (rest === 'api/anki') {
      const record = findRecord(body.record_id)
      const file = await appendAnki(record)
      sendJson(res, 200, { ok: true, path: file })
      return
    }

    if (rest === 'api/retest') {
      const pool = exams.filter((e) => {
        if (e.level !== body.level) return false
        if (e.id === body.except_id) return false
        if (body.task_type === 'translation') return Boolean(e.has_translation)
        return Boolean(e.has_writing)
      })
      const sameTopic = pool.filter((e) => e.topic === body.theme)
      const picked = (sameTopic.length > 0 ? sameTopic : pool)[0]
      if (!picked) {
        sendJson(res, 200, { ok: true, exam: null })
        return
      }
      const previous = records
        .filter((r) => r.task_type === body.task_type && r.topic === picked.topic)
        .sort((a, b) => b.created_at - a.created_at)[0]
      if (previous) {
        previous.retested = true
        await saveRecords()
      }
      sendJson(res, 200, { ok: true, exam: picked })
      return
    }

    if (rest === 'api/clear') {
      const before = records.length
      records = records.filter((r) => r.id !== body.record_id)
      if (records.length !== before) await saveRecords()
      sendJson(res, 200, bootstrap())
      return
    }

    // 维护：清空派生产物（错题卡 / Anki 队列），scope=all 时连历史记录一起清空
    if (rest === 'api/reset') {
      const removed = []
      for (const file of [path.join(storeDir, 'mistake-cards.md'), path.join(storeDir, 'anki-import.tsv')]) {
        try {
          await fsp.rm(file, { force: true })
          removed.push(file)
        } catch {
          /* 文件不存在或不可删，忽略 */
        }
      }
      if (body?.scope === 'all') {
        records = []
        await saveRecords()
      }
      if (body?.scope === 'vocab') {
        vocabItems = []
        await saveVocab()
        removed.push(vocabFile)
      }
      sendJson(res, 200, { ok: true, removed, ...bootstrap() })
      return
    }

    sendJson(res, 404, { ok: false, error: { code: 'not-found', message: url.pathname } })
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: async (req, res) => {
          const controller = new AbortController()
          const onClose = () => controller.abort()
          res.on('close', onClose)
          try {
            await handle(req, res, controller.signal)
          } catch (error) {
            if (!res.destroyed && !res.writableEnded) {
              const status = error instanceof AppError ? error.status : 500
              sendJson(res, status, {
                ok: false,
                error: { code: error instanceof AppError ? error.code : 'internal', message: error?.message ?? String(error) },
              })
            }
            if (!(error instanceof AppError)) ctx.logger?.warn?.(`cetwt: ${error?.stack ?? error}`)
          } finally {
            res.off('close', onClose)
          }
        },
      }),
    'cetwt: /cetwt 侧边栏页面与批改 API',
  )

  // ---- 斜杠命令（可失败而不影响面板）----------------------------------------------------------
  try {
    ctx.effect(
      () =>
        ctx.commands.register({
          name: 'cetwt-grade',
          description: '批改一段四六级作文/译文（writing:cet6 <正文>）',
          input: { hint: 'writing:cet6 <正文>' },
          recordInput: false,
          handler: async ({ rawInput }) => {
            const source = String(rawInput ?? '').trim()
            const [head, ...body] = source.split(/\s+/)
            const [taskType = 'writing', level = 'CET6'] = (head ?? '').split(':')
            const text = body.join(' ').trim()
            if (text === '') return { kind: 'error', text: '用法：/cetwt-grade writing:cet6 <正文>（图片请在左侧面板上传）' }
            try {
              const exam = exams.find((e) => e.level === level.toUpperCase() && (taskType === 'translation' ? e.has_translation : e.has_writing))
              const out = await gradeOnce({ task_type: taskType, level: level.toUpperCase(), text, exam_id: exam?.id }, undefined)
              const r = out.payload.result
              const dims = Object.entries(r.dim_score).map(([k, v]) => `${k} ${v}`).join(' · ')
              return {
                kind: 'success',
                text: `${taskType}/${level.toUpperCase()} — ${r.total_score}/15\n${dims}\n${r.personal_suggestion.slice(0, 200)}\n记录 ${out.record_id ?? ''}，详细报告见左侧面板。`,
              }
            } catch (error) {
              return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
            }
          },
        }),
      'cetwt: /cetwt-grade',
    )
    ctx.effect(
      () =>
        ctx.commands.register({
          name: 'cetwt-stats',
          description: '查看四六级写译训练统计',
          input: { hint: 'writing:cet6（可留空）' },
          recordInput: false,
          handler: async () => {
            const stats = computeStats(records)
            if (stats.count === 0) return { kind: 'success', text: '还没有批改记录。' }
            return {
              kind: 'success',
              text: `共 ${stats.count} 次，平均 ${stats.avg_total}，连续 ${stats.streak} 天\n主题均分：${stats.avg_theme || '—'}`,
            }
          },
        }),
      'cetwt: /cetwt-stats',
    )
  } catch (error) {
    ctx.logger?.warn?.(`cetwt: 斜杠命令注册失败（不影响面板）: ${error?.message ?? error}`)
  }
}
