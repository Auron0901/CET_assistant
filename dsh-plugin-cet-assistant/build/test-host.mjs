/**
 * 主机侧自检：不启动 DSH，仅验证 index.js 的导出契约与渲染数据结构。
 *   node build/test-host.mjs
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href)

assert.equal(mod.name, 'dsh-cetwt', 'name 应为 dsh-cetwt')
assert.ok(Array.isArray(mod.inject), 'inject 应为数组')
for (const svc of ['webServer', 'llm']) assert.ok(mod.inject.includes(svc), `inject 缺少 ${svc}`)
assert.equal(typeof mod.apply, 'function', 'apply 应为函数')
console.log('exports ok:', mod.name, '| inject:', mod.inject.join(','))

/* ---- 高级词汇 23 分类（与用户需求逐字一致） ---- */
const REQUIRED_CATS = [
  '文化遗产 & 传承', '传统节日民俗', '传统艺术、技艺', '思想典籍', '名胜古迹',
  '教育 & 校园', '教育基础', '大学生成长', '线上教育',
  '科技 & 网络', '互联网、生活科技', '利弊词',
  '环境 & 生态环保', '环保基础', '污染、灾害', '资源、保护',
  '社会民生 & 发展', '城市化、人口', '社会保障、民生', '社会热点话题',
  '经济 & 贸易', '个人品质、价值观', '观点功能短语',
]
assert.equal(REQUIRED_CATS.length, 23, '需求应有 23 个分类')
assert.deepEqual([...mod.VOCAB_CATEGORIES].sort(), [...REQUIRED_CATS].sort(), '分类名必须与需求逐字一致')
assert.equal(mod.VOCAB_CATEGORIES.length, 23, '分类数应为 23')
assert.equal(mod.VOCAB_GROUPS.flatMap((g) => g.categories).length, 23, '分组展开后应为 23 类')
assert.ok(mod.VOCAB_GROUPS.every((g) => g.name && g.categories.length > 0), '每个分组都要有名称与分类')
console.log('vocab categories: 23 | groups:', mod.VOCAB_GROUPS.map((g) => g.name + '(' + g.categories.length + ')').join(' '))
const dataPath = path.join(ROOT, 'data', 'exams.json')
const exams = JSON.parse(fs.readFileSync(dataPath, 'utf8'))
assert.ok(Array.isArray(exams) && exams.length >= 20, '真题库应至少 20 套')
const withWriting = exams.filter((e) => e.has_writing).length
const withTrans = exams.filter((e) => e.has_translation).length
const withRefTrans = exams.filter((e) => e.has_ref_trans).length
const withRefIdea = exams.filter((e) => e.has_ref_idea).length
console.log(`exams: ${exams.length} | 作文 ${withWriting} | 翻译 ${withTrans} | 官方译文 ${withRefTrans} | 官方范文 ${withRefIdea}`)

for (const e of exams) {
  assert.ok(['CET4', 'CET6'].includes(e.level), `${e.id} level 非法`)
  assert.ok(e.id && e.exam_date && e.topic, `${e.id} 缺少基础字段`)
  if (e.has_translation) assert.ok((e.zh_source ?? '').length > 20, `${e.id} 翻译缺中文原文`)
  if (e.has_writing) assert.ok((e.writing_prompt ?? '').length > 20, `${e.id} 作文缺题干`)
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
assert.equal(pkg.name, 'dsh-cetwt')
assert.ok(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform 应为 web')
assert.ok(pkg.exports['./client'], 'exports 缺少 ./client')
assert.ok(fs.existsSync(path.join(ROOT, 'lib', 'client.js')), 'lib/client.js 不存在')
assert.ok(fs.existsSync(path.join(ROOT, 'cordis.patch.yml')), 'cordis.patch.yml 不存在')
assert.ok(fs.existsSync(path.join(ROOT, 'icon.svg')), 'icon.svg 不存在')

console.log('\n✅ 主机侧自检通过')
