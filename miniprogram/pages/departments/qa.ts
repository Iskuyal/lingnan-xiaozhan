/**
 * 部门 AI 问答的纯逻辑（页面只绑定数据，规则在这里，便于用 node:test 直接验证）。
 *
 * 答案只能建立在 services/departments.ts 的已核实语料上：语料组装进系统提示词，
 * 模型被要求「资料里没有的信息一律回答官网未公布，绝不编造联系方式/负责人/所属校区」，
 * 回答可注明「来源：学校官网学生组织页面」——全项目「不编造」纪律的直接落点
 * （docs/development-spec.md「AI 功能」与 Ticket 07）。
 */
import { Department, departments, departmentsSource } from '../../services/departments';

/** AI 主动询问的欢迎语；措辞与 Ticket 07 验收第一条一致。 */
export const WELCOME_TEXT = '你想了解什么部门？可以点下面的选项进入对应页面，也可以直接打字问我。';

/** 对话底部固定展示的来源说明：回答可追溯到学校官网已核实资料。 */
export const QA_SOURCE_NOTE = '回答依据：学校官网已核实的学生组织资料（核查于 '
  + departmentsSource.verifiedAt
  + '）；资料没有的内容会回答「官网未公布」。';

/** 多轮历史最多带多少条（与 ai 云函数 MAX_MESSAGES=20 对齐）。 */
export const MAX_HISTORY = 20;

export interface QaOption {
  id: string;
  name: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** 单个组织的语料段落：缺失字段如实标注「官网未公布」，不写任何推测值。 */
function corpusSection(department: Department): string {
  const lines: string[] = [
    '【' + department.name + '】',
    department.campus === null ? '所属校区：官网未标注所属校区' : '所属校区：' + department.campus,
    '简介：' + department.introduction,
    '下设部门：' + department.units.join('、'),
  ];
  if (department.contacts.length === 0) {
    lines.push('联系方式：官网未公布联系方式');
  } else {
    lines.push('联系方式：' + department.contacts.map((contact) => contact.label + '：' + contact.value).join('；'));
  }
  if (department.activities.length === 0) {
    lines.push('活动动态：官网暂未收录该组织的活动动态');
  } else {
    lines.push('活动动态：' + department.activities
      .map((activity) => activity.title + '（' + activity.publishedAt + '）')
      .join('；'));
  }
  return lines.join('\n');
}

/** 已核实语料全文：来源链接与核查日期在前，五个组织的事实按统一结构列出。 */
export function buildCorpusText(): string {
  const head = '以下是从学校官网核实的学生组织资料（来源：' + departmentsSource.label + ' '
    + departmentsSource.sourceUrl + '，核查日期 ' + departmentsSource.verifiedAt + '）。';
  return [head].concat(departments.map(corpusSection)).join('\n\n');
}

/** 系统提示词：角色约束 + 「不编造」纪律 + 完整语料。语料约两千字，每次追问都带全量。 */
export function buildSystemPrompt(): string {
  return [
    '你是校园学生部门问答助手，只能依据下面「已核实资料」回答。',
    '必须遵守：',
    '1. 资料里有的内容，按资料回答，必要时注明「来源：学校官网学生组织页面」；',
    '2. 资料里没有的信息（例如联系方式、负责人、所属校区、招新时间等），一律回答「官网未公布」，绝不编造；',
    '3. 不要添加资料之外的任何信息，不要推测，不要替学校承诺任何事项。',
    '',
    buildCorpusText(),
  ].join('\n');
}

/** 打开对话时的欢迎消息与可点选项（选项来自已核实名录，点击进对应详情页）。 */
export function buildWelcome(): { text: string; options: QaOption[] } {
  return {
    text: WELCOME_TEXT,
    options: departments.map((department) => ({ id: department.id, name: department.name })),
  };
}

/** 把页面上的多轮历史映射成 ai 云函数的消息数组，只保留最近 MAX_HISTORY 条。 */
export function chatMessages(history: ChatTurn[]): { role: 'user' | 'assistant'; text: string }[] {
  return history.slice(-MAX_HISTORY).map((turn) => ({ role: turn.role, text: turn.text }));
}
