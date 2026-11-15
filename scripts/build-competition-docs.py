"""Build the three editable r4 documents from their checked-in Markdown sources."""
from pathlib import Path
import re
from datetime import datetime, timezone
from docx import Document
from docx.shared import Cm, Pt, RGBColor, Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/competition/submission-2026-11-15'
EVIDENCE = ROOT / 'docs/evidence/lingnan-ui-implementation/integration-2026-11-14'

def font(run, size=11, bold=False, east='SimSun'):
    run.font.name = 'Arial'
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = RGBColor(0, 0, 0)
    run._element.get_or_add_rPr().get_or_add_rFonts().set(qn('w:eastAsia'), east)

def paragraph(doc, text, size=11, bold=False, indent=True):
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(7)
    p.paragraph_format.line_spacing = 1.35
    if indent and not text.startswith(('http', 'docs/', 'npm ', 'git ')):
        p.paragraph_format.first_line_indent = Pt(22)
    font(p.add_run(text), size, bold)
    return p

def heading(doc, text, level=1):
    p = doc.add_paragraph(text, style=f'Heading {level}')
    p.paragraph_format.space_before = Pt(0 if level == 1 else 8)
    p.paragraph_format.space_after = Pt(9)
    for run in p.runs: font(run, 16 if level == 1 else 12.5, True, 'Microsoft YaHei')
    return p

def table(doc, rows):
    if not rows: return
    t = doc.add_table(rows=1, cols=len(rows[0]))
    t.autofit = False
    widths = {2: [4.1, 12.9], 3: [3.0, 7.0, 7.0]}.get(len(rows[0]), [17 / len(rows[0])] * len(rows[0]))
    for i, value in enumerate(rows[0]): t.rows[0].cells[i].text = value
    for row in rows[1:]:
        cells = t.add_row().cells
        for i, value in enumerate(row): cells[i].text = value
    for ri, row in enumerate(t.rows):
        for i, cell in enumerate(row.cells):
            cell.width = Cm(widths[i])
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            tcpr = cell._tc.get_or_add_tcPr()
            borders = OxmlElement('w:tcBorders')
            for edge in ['top', 'left', 'bottom', 'right']:
                e = OxmlElement(f'w:{edge}'); e.set(qn('w:val'), 'single'); e.set(qn('w:sz'), '4'); e.set(qn('w:color'), 'D9D9D9'); borders.append(e)
            tcpr.append(borders)
            margins = OxmlElement('w:tcMar')
            for edge in ['top', 'left', 'bottom', 'right']:
                e = OxmlElement(f'w:{edge}'); e.set(qn('w:w'), '100'); e.set(qn('w:type'), 'dxa'); margins.append(e)
            tcpr.append(margins)
            if ri == 0:
                shade = OxmlElement('w:shd'); shade.set(qn('w:fill'), 'E9EDF2'); tcpr.append(shade)
            for p in cell.paragraphs:
                p.paragraph_format.space_after = Pt(2); p.paragraph_format.line_spacing = 1.15
                for run in p.runs: font(run, 10, ri == 0)
        if ri == 0:
            repeat = OxmlElement('w:tblHeader'); row._tr.get_or_add_trPr().append(repeat)
    doc.add_paragraph().paragraph_format.space_after = Pt(1)

def pictures(doc, paths, caption, width=2.08):
    p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    for i, relative in enumerate(paths):
        if i: p.add_run('    ')
        image = p.add_run().add_picture(str(EVIDENCE / relative), width=Inches(width))
        image._inline.docPr.set('descr', caption)
    p.paragraph_format.space_after = Pt(5)
    c = paragraph(doc, caption, 9, indent=False); c.alignment = WD_ALIGN_PARAGRAPH.CENTER

def base(title):
    doc = Document()
    s = doc.sections[0]
    s.page_width = Cm(21); s.page_height = Cm(29.7)
    s.top_margin = Cm(1.8); s.bottom_margin = Cm(1.8); s.left_margin = Cm(2); s.right_margin = Cm(2)
    s.header_distance = Cm(.8); s.footer_distance = Cm(.8)
    normal = doc.styles['Normal']; normal.font.name = 'Arial'; normal.font.size = Pt(11)
    normal._element.get_or_add_rPr().get_or_add_rFonts().set(qn('w:eastAsia'), 'SimSun')
    for name in ['Title', 'Subtitle', 'Heading 1', 'Heading 2', 'Heading 3']:
        style = doc.styles[name]; style.font.color.rgb = RGBColor(0, 0, 0); style.font.underline = False
    for border in doc.styles.element.xpath('.//w:pBdr'):
        border.getparent().remove(border)
    for update in doc.settings.element.xpath('.//w:updateStyles'):
        update.getparent().remove(update)
    s.different_first_page_header_footer = False
    h = s.header.paragraphs[0]; h.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    header_title = title if title.startswith('岭南小栈') else f'岭南小栈 {title}'
    font(h.add_run(f'{header_title}  r4'), 9)
    f = s.footer.paragraphs[0]; f.alignment = WD_ALIGN_PARAGRAPH.CENTER
    font(f.add_run('Inlux  |  '), 9)
    field = OxmlElement('w:fldSimple'); field.set(qn('w:instr'), 'PAGE'); f._p.append(field)
    doc.core_properties.author = 'Inlux'
    doc.core_properties.title = title
    doc.core_properties.subject = '第九届传智杯AI微信小程序赛道参赛材料'
    doc.core_properties.last_modified_by = 'Inlux'
    doc.core_properties.created = datetime.now(timezone.utc)
    doc.core_properties.modified = datetime.now(timezone.utc)
    doc.core_properties.version = 'r4-20261115'
    return doc

def blocks(doc, text):
    lines = text.strip().splitlines(); i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line: i += 1; continue
        if line.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                values = [s.strip() for s in lines[i].strip().strip('|').split('|')]
                if not all(re.fullmatch(r'[-: ]+', s or '-') for s in values): rows.append(values)
                i += 1
            table(doc, rows); continue
        if line.startswith('```'):
            i += 1
            while i < len(lines) and not lines[i].startswith('```'):
                paragraph(doc, lines[i], 10, indent=False); i += 1
            i += 1; continue
        if line.startswith('### '): heading(doc, line[4:], 2)
        elif line.startswith('## '): heading(doc, line[3:])
        elif ' docs/' in line:
            label, relative = line.split(' docs/', 1)
            paragraph(doc, label, 11, True, indent=False)
            paragraph(doc, 'docs/' + relative, 9.5, indent=False)
        elif not line.startswith('# '): paragraph(doc, line)
        i += 1

def sections(name):
    raw = (OUT / name).read_text(encoding='utf-8')
    chunks = re.split(r'^## (.+)$', raw, flags=re.M)
    return chunks[0], {chunks[i]: chunks[i + 1] for i in range(1, len(chunks), 2)}

def title(doc, name):
    p = doc.add_paragraph(name, style='Title')
    for r in p.runs: font(r, 25, True, 'Microsoft YaHei')
    p.paragraph_format.space_after = Pt(12)

def main_document():
    intro, sec = sections('作品说明.md')
    doc = base('作品说明'); title(doc, '岭南小栈作品说明')
    paragraph(doc, '第九届传智杯 AI微信小程序开发挑战赛', 12, indent=False)
    paragraph(doc, 'Inlux团队  广东岭南职业技术学院  C组三人', 11, indent=False)
    paragraph(doc, '2026年11月15日  r4更新材料', 11, indent=False)
    intro_lines = [x for x in intro.splitlines() if x.startswith(('岭南小栈是一款', '本文覆盖'))]
    for x in intro_lines: paragraph(doc, x, indent=False)
    pictures(doc, ['native/01-home.png', 'native/06-plan-to-week.png'], '原生模拟器示例  今天与对应周课表  虚构数据  非手机真机', 2.05)
    for key in ['a 项目说明', 'b 微信与AI能力说明', 'c 创新点与取舍']:
        doc.add_page_break(); heading(doc, key); blocks(doc, sec[key])
        if key.startswith('a '): pictures(doc, ['b-regression/10-import-review.png'], '导入草稿逐条核对后才确认替换  虚构样例', 1.85)
        if key.startswith('c '): pictures(doc, ['b-regression/05-notice-proposal.png'], '先核对原通知与变更范围  固定AI响应', 1.85)
    doc.add_page_break(); heading(doc, 'd 技术实现')
    d_parts = sec['d 技术实现'].split('本地需要Node.js')
    blocks(doc, d_parts[0])
    doc.add_page_break(); heading(doc, '运行与版本复现')
    blocks(doc, '本地需要Node.js' + d_parts[1])
    blocks(doc, '\n```powershell\nnpm ci --ignore-scripts\nnpm run typecheck\nnpm run build\n```\n')
    table(doc, [['对象', '复现范围'], ['完整仓库', '类型检查、1025项回归及文档检查；资料权限另计'], ['参赛源码子包', '干净安装、类型检查、构建；未附完整tests'], ['云端与模型', '资源、AppID权限、环境变量和真实调用须分别配置与验证']])
    doc.add_page_break(); heading(doc, 'e 成果与验证'); blocks(doc, sec['e 成果与验证'])
    doc.add_page_break(); heading(doc, '调课结果回到对应周')
    paragraph(doc, '以下为本轮原生夹具操作画面：学生核对提案后应用，页面定位到第11周，并在目标课程上标出本次调整。撤销仍需在有效窗口内操作。', indent=False)
    pictures(doc, ['b-regression/06-change-result.png', 'b-regression/07-week-11-changed.png'], '限定周次应用与周课表变化  虚构课程及固定响应')
    paragraph(doc, '这组截图证明界面和夹具闭环，不证明真实数据库事务性能。拍摄多张结果图时的撤销计时处理在验证报告中单列，不能据此认定10秒截止边界通过。', indent=False)
    doc.add_page_break(); heading(doc, '学习约束与已有练习记录')
    pictures(doc, ['c-regression/15-ai-draft.png', 'c-regression/77-practice-record.png'], '原话依据核对与练习记录  固定响应  不代表学习效果')
    paragraph(doc, '约束草稿核对后才进入规则预览，计划与正式课程分开。记录复制只保留当前已有原答和实际返回反馈；没有返回的反馈不补写。', indent=False)
    doc.add_page_break(); heading(doc, 'f 历史与资料来源'); blocks(doc, sec['f 历史与资料来源'])
    table(doc, [['材料', '对应版本'], ['新版文档与原生演示', '本轮main代码；虚构数据、固定响应'], ['历史真实AI视频', '2026年10月30日录制版本；保留原片与记录'], ['r1至r3旧包', '原日期及校验不改写，不作为本轮最新包']])
    doc.add_page_break(); heading(doc, 'g 落地规划'); blocks(doc, sec['g 落地规划'])
    table(doc, [['阶段', '工作与判据'], ['小范围试点准备', '确认告知、权限、接收方与删除途径，再邀请真实学生'], ['使用验证', '观察导入校对、错误恢复和再次使用意愿，保留真实反馈'], ['持续完善', '新题独立评测及成本核对后决定推广与版本方向']])
    doc.add_page_break(); heading(doc, '版本与核查入口'); blocks(doc, sec['版本与核查入口'])
    table(doc, [['版本对象', '说明'], ['业务代码基线', '8dda8d363d88d670bd2d5d0edb432434e47fb35c'], ['main合并记录', '092f6570d436d7f975e55a81a1fec19d11d719aa'], ['完整交付源码与校验', '以source-version.json、manifest及SHA256文件为准']])
    doc.save(OUT / '岭南小栈-作品说明.docx')

def support_document(source, output, title_text):
    intro, sec = sections(source)
    doc = base(title_text); title(doc, title_text)
    blocks(doc, '\n'.join(x for x in intro.splitlines() if not x.startswith('# ')))
    if source == '体验说明.md':
        groups = [['先看哪些材料', '安装与构建'], ['云资源与配置'], ['建议体验路径'], ['失败与数据处理', '版本与提交状态']]
    else: groups = [['七项材料对应', '文件检查'], ['实际提交前']]
    for gi, group in enumerate(groups):
        if gi: doc.add_page_break()
        for key in group: heading(doc, key); blocks(doc, sec[key])
        if source == '体验说明.md' and gi == 1:
            table(doc, [['能力', '实际前提'], ['课表与设置', '本人身份、相应云函数与数据权限'], ['AI功能', '模型与审核配置、限流、预算和有效网络'], ['公开资讯', '来源范围、同步状态及读取权限']])
        if source == '体验说明.md' and gi == 2:
            pictures(doc, ['b-regression/09-import-guide.png'], '从微信聊天选择虚构测试课表  确认保存会整表替换', 1.9)
    if source == '提交核对清单.md':
        for p in doc.paragraphs:
            if p.style.name == 'Normal':
                p.paragraph_format.line_spacing = 1.25
                p.paragraph_format.space_after = Pt(6)
                for run in p.runs: font(run, 10.5)
    doc.save(OUT / output)

if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    main_document()
    support_document('体验说明.md', '岭南小栈-体验与运行说明.docx', '岭南小栈体验与运行说明')
    support_document('提交核对清单.md', '岭南小栈-提交核对清单.docx', '岭南小栈提交核对清单')
    print('Created 3 DOCX documents from checked-in Markdown sources')
