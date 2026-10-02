"use strict";
/**
 * 「项目讲解与答辩练习」的服务端契约：**固定纪律提示词 + 材料注入 + 回答格式与出处校验**。
 *
 * 这个落点与升学问答（`advancement.ts`）的差别是「材料给谁」：
 * - 升学问答：材料在服务端语料里，客户端只能给段落 id；
 * - 答辩练习：材料同样在**服务端**——构建时从 G0 **冻结件**生成 `defense-materials.js`，
 *   客户端只给 `materialId`。理由是判定本身：答题要求「回答能回核到当前材料」，
 *   若材料由客户端提供，客户端就能自带一份「方便自己」的材料，引用核对就失去意义。
 *
 * 因此这里守两条线：
 * 1. **纪律由服务端下发**（`DEFENSE_DISCIPLINE`），客户端传来的 `system` 一律被覆盖——
 *    提示词是可评测的契约之一，不能由调用方改写；材料只作为「被引用的资料」拼在纪律之后
 *    （`defenseSystem`），与纪律之间用固定分隔标记隔开，材料正文里的话读起来像指令也越不过这条边界。
 * 2. **回答上屏前逐条核对引用**（`verifyDefenseAnswer`）：四节标题齐不齐、顺序对不对，
 *    以及回答里出现的每个条目编号是否真的在材料里。核不过就**不返回模型答案**
 *    （`citation_unverified`），由调用方降级。
 *
 * 这一层只做**可机检**的部分：编号存在不等于说法正确。把某条事实说反、把「待验证」说成
 * 「已完成」这类语义错误仍须人工按 rubric 判读，本模块不冒充能判。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFENSE_DISCIPLINE = exports.DEFENSE_FEATURE = void 0;
exports.defenseSystem = defenseSystem;
exports.defenseMaterialIds = defenseMaterialIds;
exports.verifyDefenseAnswer = verifyDefenseAnswer;
exports.loadDefenseMaterials = loadDefenseMaterials;
/** 「项目讲解与答辩练习」的 feature 名（客户端同名常量，跨包有意复制）。 */
exports.DEFENSE_FEATURE = 'project-defense';
/**
 * 固定纪律提示词。
 *
 * 逐字取自 `scripts/poc-project-defense.cjs` 的 `DISCIPLINE`（G1 PoC 已验证的措辞），
 * 只改第一句的指代：PoC 在本地装配，材料就在提示词里，所以写「下面的项目材料」；
 * 服务端这条路径的材料是**事件传上来的**，改写成「服务端下发的项目材料」以免读成
 * 「客户端可以自带材料」。
 *
 * 改这里的措辞等于改评测口径：PoC 的 `--plan` 自带提示词卫生检查（纪律里不得出现样例正文），
 * 服务端的纪律串不要再往里加任何样例、事实或编号。
 */
exports.DEFENSE_DISCIPLINE = [
    '你是「项目讲解与答辩练习」的反馈助手。你的唯一职责是依据服务端下发的项目材料，对学生的一次回答给出有依据的反馈与一个追问。',
    '',
    '必须遵守：',
    '1. 只用材料里写着的内容。每条判断都要写出依据的条目编号（如 F2、D7、INV-2）。材料里没有的事实、数字和结论一律不得补。',
    '2. 材料有两份：FC-1 是本项目自有材料；FC-2 是维护者原创的设计情景，没有代码、测试或运行记录，不得把 D1–D8 说成小程序已有功能、已上线或已交付。',
    '3. 材料标为「待验证」「待核实」「未测试」的事项必须保持原状，不得说成已完成、已通过、已上线。材料里「部分已确认、部分待验证」的事项必须分别说明，不得因为其中一部分已确认就写成整体已验证。',
    '4. 反馈必须针对学生实际写出的断言；学生没说过的问题不要当成他说过。材料与学生说法不一致时，指出材料里写的是什么并要求核对，不得判断学生撒谎，也不得作道德评价。',
    '5. 不输出职业能力等级、岗位胜任度、官方成绩、录用或面试保证、教师认可或学校评价；也不评价表达能力、学习效果或学生本人。',
    '6. 不得因为措辞更流畅、更礼貌或篇幅更长就认为依据更充分；只有能回核到条目编号的内容才算依据。',
    '',
    '输出固定用下面四节，标题原样保留，不增删小节、不加评级与鼓励性评语：',
    '【引用核对】逐条列出学生回答里的断言：能回核的写「成立（条目号）」；不能回核或与材料不符的写「不成立（条目号：材料实际写的是……）」。',
    '【是否对应回答】说明反馈针对的是学生写出的哪一句断言；若没有可核对的内容，说明没有可核对的内容。',
    '【待验证保留】材料中与本次回答相关的待验证 / 未测试项，逐条写明是否被学生如实保留。',
    '【追问】只提一个问题，必须指向这次回答尚未覆盖的具体缺口，或要求其为已作的断言补充依据；不要问「能不能再详细说说」这类通用问题。',
].join('\n');
/**
 * 四节标题（顺序即契约）。`verifyDefenseAnswer` 按这个顺序核对，
 * 提示词里的四节只能与它一致——改这里等于改客户端要按什么解析。
 */
const DEFENSE_SECTIONS = ['【引用核对】', '【是否对应回答】', '【待验证保留】', '【追问】'];
/**
 * 回答正文里出现的引用编号（**宽松**）：`INV-1`、`INV-A`、`F2`、`D7` 等，只要模型写出来就计入核对。
 *
 * 与 `scripts/poc-project-defense.cjs` 的 `CITATION_PATTERN` 同形：这里是「回答说了什么」，
 * 宁可抓宽一点——多抓一个不存在的编号就多一次拒绝，漏抓才是放行没有出处的断言。
 */
const ANSWER_CITATION_PATTERN = /\b(INV-[A-Z0-9]+|[A-Z]\d+)\b/gu;
/**
 * 材料里**可引用的条目编号**（**严格**）：只认出现在**行首或表格竖线之后**、
 * 且后面紧跟空白或 `|` 的形态。
 *
 * 事实卡是 Markdown 表格（`| F1 | … |`）与条目行（`INV-1 …`），编号是「表格的一列」；
 * 正文里的英文数字组合（`xlsx@0.20.3`、`wx.chooseMessageFile`）与日期（`9 月 27 日`）都不是编号。
 * 不加位置约束的话，正文里随手写出的字母数字会被当成可引用条目，模型引用它就等于凭空多出依据。
 */
const MATERIAL_ID_PATTERN = /(?:^|\|)[ \t]*(INV-[A-Z0-9]+|[A-Z]\d+)(?=[\s|])/gmu;
/**
 * 按给定模式收集捕获组 1，**去重且保持出现顺序**。
 *
 * 每次都新建一个正则：模块级带 `g` 的正则会带 `lastIndex` 状态，
 * 复用会让「同一份输入两次调用结果不同」。
 */
function collectIds(text, pattern) {
    const found = [];
    const matcher = new RegExp(pattern.source, pattern.flags);
    let match = matcher.exec(text);
    while (match !== null) {
        const id = match[1];
        if (id !== undefined && !found.includes(id))
            found.push(id);
        match = matcher.exec(text);
    }
    return found;
}
/**
 * 系统提示词 = 固定纪律 + 材料。
 *
 * 顺序与分隔标记固定（与 PoC 的 `buildSystem` 逐字一致），保证同输入同输出、可复现。
 */
function defenseSystem(material) {
    return `${exports.DEFENSE_DISCIPLINE}\n\n=== 项目材料开始 ===\n${material}\n=== 项目材料结束 ===`;
}
/**
 * 从材料正文里抽出可引用的条目编号，去重并保持出现顺序。
 *
 * 只认行首或表格竖线后的编号（见 `MATERIAL_ID_PATTERN`）：这是「回答可以引用什么」的**唯一**依据，
 * 因此宁可窄——宽了会把正文里的普通英文数字变成可用依据。
 */
function defenseMaterialIds(material) {
    return collectIds(typeof material === 'string' ? material : '', MATERIAL_ID_PATTERN);
}
/**
 * 回答上屏前的校验：**四节齐不齐、顺序对不对、引用有没有出处**。
 *
 * 返回的 `problems` 只含短代码与节标题（缺哪一节写哪一节），**不含回答正文**——
 * 它会进 `citation_unverified` 的 `detail`，而 detail 是给维护者排查用的字段。
 *
 * 空回答先返回 `empty_answer`：没有正文就谈不上四节与引用，报一堆「缺四节」只会掩盖真实原因。
 */
function verifyDefenseAnswer(text, material) {
    const answer = typeof text === 'string' ? text : '';
    const problems = [];
    if (answer.trim() === '') {
        problems.push('empty_answer');
    }
    else {
        let previous = -1;
        for (const section of DEFENSE_SECTIONS) {
            const at = answer.indexOf(section);
            if (at < 0) {
                problems.push(`missing_section(${section})`);
                continue;
            }
            if (at < previous)
                problems.push(`section_out_of_order(${section})`);
            previous = at;
        }
        const known = new Set(defenseMaterialIds(material));
        for (const id of collectIds(answer, ANSWER_CITATION_PATTERN)) {
            if (!known.has(id))
                problems.push(`unknown_citation(${id})`);
        }
    }
    return { ok: problems.length === 0, problems };
}
/** 构建产物形状校验（与 `loadDepartmentCorpus` / `loadAdvancementCorpus` 同风格）。 */
function isDefenseMaterials(value) {
    if (value === null || typeof value !== 'object')
        return false;
    const materials = value.DEFENSE_MATERIALS;
    if (!Array.isArray(materials) || materials.length === 0)
        return false;
    for (const item of materials) {
        if (item === null || typeof item !== 'object')
            return false;
        const material = item;
        if (typeof material.id !== 'string' || material.id === '')
            return false;
        if (typeof material.name !== 'string' || material.name === '')
            return false;
        if (typeof material.kind !== 'string')
            return false;
        if (typeof material.text !== 'string' || material.text === '')
            return false;
    }
    return true;
}
/**
 * 构建注入的材料表（`scripts/build.mjs` → `dist/cloudfunctions/ai/defense-materials.js`）。
 *
 * 与升学问答语料一样是**前提**：缺失或损坏时返回 null，调用方按 `internal` 拒绝（fail-closed），
 * 不会退化成「客户端说什么是材料就是什么」。
 */
function loadDefenseMaterials() {
    try {
        const loaded = require('./defense-materials');
        return isDefenseMaterials(loaded) ? loaded.DEFENSE_MATERIALS : null;
    }
    catch {
        return null;
    }
}
