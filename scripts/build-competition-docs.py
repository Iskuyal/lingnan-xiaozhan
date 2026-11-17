"""Build the three editable latest documents from their checked-in Markdown sources."""
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
OUT = ROOT / 'docs/competition/submission-latest'

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
    font(h.add_run(f'{header_title}  2026年11月17日'), 9)
    f = s.footer.paragraphs[0]; f.alignment = WD_ALIGN_PARAGRAPH.CENTER
    font(f.add_run('Inlux  |  '), 9)
    field = OxmlElement('w:fldSimple'); field.set(qn('w:instr'), 'PAGE'); f._p.append(field)
    doc.core_properties.author = 'Inlux'
    doc.core_properties.title = title
    doc.core_properties.subject = '第九届传智杯AI微信小程序赛道参赛材料'
    doc.core_properties.last_modified_by = 'Inlux'
    doc.core_properties.created = datetime.now(timezone.utc)
    doc.core_properties.modified = datetime.now(timezone.utc)
    doc.core_properties.version = 'latest-20261117'
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
    paragraph(doc, '2026年11月17日  最新提交材料', 11, indent=False)
    for line in intro.splitlines():
        if line.startswith(('岭南小栈是一款', '本文覆盖')): paragraph(doc, line, indent=False)
    table(doc, [['材料', '阅读用途'], ['作品说明', '项目场景、能力、技术与后续计划'], ['体验与运行说明', '安装构建、云资源和操作路径'], ['功能演示视频', '负责人提供并确认的最新文件'], ['版本与验证', '源码来源、文档渲染和包内哈希']])
    for key, body in sec.items():
        doc.add_page_break(); heading(doc, key); blocks(doc, body)
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
