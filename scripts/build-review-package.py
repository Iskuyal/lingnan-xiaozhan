"""构建源码审查ZIP，排除真实课表样本和私有产物；不冒充完整正式参赛包。"""
from pathlib import Path
import argparse, hashlib, json, subprocess, zipfile

root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--out',default='artifacts/submission/source-review-2026-10-03.zip')
args=parser.parse_args()
out=Path(args.out)
if not out.is_absolute(): out=root/out
if out.exists(): raise SystemExit('输出已存在；请使用新文件名，保留已检查包')
tracked=subprocess.check_output(['git','ls-files','-z'],cwd=root).decode('utf-8').split('\0')
root_files={'package.json','package-lock.json','tsconfig.json','project.config.json','.gitignore'}
required_datasets={
    'docs/evidence/advancement-poc/corpus.json',
    'docs/evidence/advancement-poc/questions.json',
    'docs/evidence/advancement-model/questions.json',
    'docs/evidence/advancement-model/questions-next.json',
    'docs/evidence/department-rag/questions.json',
}
def include(name):
    if name in root_files or name in required_datasets: return True
    if name.startswith(('miniprogram/','cloudfunctions/','scripts/')):
        return not any(part in {'node_modules','artifacts','dist','.git'} for part in Path(name).parts)
    # build 的答辩材料生成器依赖这些自有/原创事实卡，非真实学生样本。
    return name.startswith('docs/evidence/project-defense-g0/')
files=sorted(name for name in tracked if name and include(name))
if not required_datasets.issubset(files): raise SystemExit('缺少构建/评测所需公开语料或冻结题集')
manifest={'sourceCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),
          'snapshot':'working_tree_bytes_with_sha256_manifest',
          'formalSubmission':False,'excluded':['tests/（包括未脱敏课表夹具）','全部旧截图、录屏与私人artifacts','密钥、访问令牌、依赖目录与生成dist'],
          'validationScope':'源码可安装、typecheck/build；未附完整测试、七项最终材料或视频，不是正式参赛包',
          'files':[]}
out.parent.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED) as archive:
    for name in files:
        p=root/name
        if p.is_symlink() or not p.is_file(): raise SystemExit('不能打包链接或缺失文件：'+name)
        data=p.read_bytes()
        manifest['files'].append({'path':name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
        archive.writestr('源代码/'+name,data)
    archive.writestr('源代码/README.md',
        '# 校园工具源码审查包\n\n本包不是正式参赛包。原课表夹具含个人信息，整个tests目录和旧截图均未附。\n'
        'Node.js ≥22：npm ci --ignore-scripts → npm run typecheck → npm run build。微信开发者工具导入dist。\n'
        '完整回归测试与文档检查在交付仓库执行，不在本审查包声称复现；云密钥由服务端环境提供。\n'
        '七项内部说明、v2.1展示材料、真实评测及待办请在交付PR查阅。正式名称、最终视频与人类验收/提交回执仍缺。\n'
        '源码字节由manifest.json逐文件绑定；若snapshot标working_tree，不能误称全部字节来自所列HEAD提交。\n')
    archive.writestr('manifest.json',json.dumps(manifest,ensure_ascii=False,indent=2))
with zipfile.ZipFile(out) as archive:
    if archive.testzip() is not None: raise SystemExit('ZIP CRC不通过')
    names=archive.namelist()
    if any('/tests/' in n or '/node_modules/' in n or '/artifacts/' in n or '.env' in Path(n).name or 'project.private' in n for n in names):
        raise SystemExit('包中存在禁止路径')
report={'file':out.name,'bytes':out.stat().st_size,'sha256':hashlib.sha256(out.read_bytes()).hexdigest(),
        'sourceFiles':len(files),'crcPassed':True,'pathFilterPassed':True,'under300MB':out.stat().st_size<300*1024*1024,
        'formalSubmission':False,'manifestSourceCommit':manifest['sourceCommit'],'validationScope':manifest['validationScope']}
print(json.dumps(report,ensure_ascii=False,indent=2))
out.with_suffix('.check.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
