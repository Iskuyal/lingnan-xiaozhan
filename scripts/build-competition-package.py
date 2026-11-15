"""Build the r4 source subset and submission ZIP without private fixtures or credentials."""
from pathlib import Path, PurePosixPath
import argparse, hashlib, json, re, subprocess, zipfile

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / 'docs/competition/submission-2026-11-15'
PUBLIC_DATA = {
    'docs/evidence/advancement-poc/corpus.json', 'docs/evidence/advancement-poc/questions.json',
    'docs/evidence/advancement-model/questions.json', 'docs/evidence/advancement-model/questions-next.json',
    'docs/evidence/department-rag/questions.json', 'docs/product/data-usage.md',
}
ROOT_FILES = {'package.json', 'package-lock.json', 'tsconfig.json', 'project.config.json', '.gitignore'}
BLOCKED_PARTS = {'.git', '.scratch', '.worktrees', 'node_modules', 'dist', 'artifacts', 'submission-output', 'tests', '__pycache__'}

def safe_member(name):
    if not name or '\\' in name or ':' in name or name.startswith('/'):
        return False
    parts = PurePosixPath(name).parts
    if '..' in parts or any(p in BLOCKED_PARTS for p in parts): return False
    leaf = parts[-1].lower()
    return not (leaf.startswith('.env') or leaf == 'project.private.config.json' or leaf.endswith(('.pem', '.key', '.p12', '.pfx', '.pyc')))

def include_source(name):
    return safe_member(name) and (name in ROOT_FILES or name in PUBLIC_DATA or name.startswith((
        'miniprogram/', 'cloudfunctions/', 'scripts/', 'docs/evidence/project-defense-g0/',
        'docs/development/cloud/', 'docs/adr/', 'docs/product/sources/',
    )))

def git(*args): return subprocess.check_output(['git', *args], cwd=ROOT)
def sha(data): return hashlib.sha256(data).hexdigest()
def write_json(path, data): path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

def source_readme(commit):
    return f'''# 岭南小栈参赛源码子包

源码提交：{commit}。业务代码基线：8dda8d3，最新代码已合入main。

Node.js 22或以上：npm ci --ignore-scripts → npm run typecheck → npm run build。
在微信开发者工具导入dist；本地构建不会部署云函数。AppID、云资源、数据库权限、模型与审核环境变量由有权限的维护者配置，密钥不随包分发。

真实课表夹具和完整tests被排除。本子包只验证干净安装、类型检查和构建，不承诺npm test或docs:check复现完整仓库结果。完整1025项回归及新界面原生记录见外层验证材料。

README为本子包生成的运行说明，其余清单文件逐字节来自上述Git对象。SOURCE-MANIFEST.json记录来源、文件SHA256和排除范围。
代码仓库：https://github.com/Iskuyal/lingnan-xiaozhan
'''.encode('utf-8')

def build_source(ref, output):
    commit = git('rev-parse', ref).decode().strip()
    tracked = git('ls-tree', '-r', '-z', '--name-only', commit).decode('utf-8').split('\0')
    names = sorted(n for n in tracked if n and include_source(n))
    if not PUBLIC_DATA.issubset(set(names)): raise ValueError('Missing required public build data')
    files = {n: git('show', f'{commit}:{n}') for n in names}
    files['README.md'] = source_readme(commit)
    secret = re.compile(rb'(?:gh[pousr]_[A-Za-z0-9]{25,}|sk-[A-Za-z0-9]{24,})')
    for name, data in files.items():
        if not safe_member('源代码/' + name): raise ValueError('Forbidden source member ' + name)
        if secret.search(data): raise ValueError('Possible credential pattern in ' + name)
    records = [{'path': n, 'bytes': len(d), 'sha256': sha(d), 'origin': 'generated_source_readme' if n == 'README.md' else 'git_commit'} for n, d in sorted(files.items())]
    payload_sha = sha(json.dumps(records, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8'))
    manifest = {'sourceCommit': commit, 'repository': 'https://github.com/Iskuyal/lingnan-xiaozhan', 'snapshot': 'git_commit_with_generated_source_readme', 'sourcePayloadSha256': payload_sha, 'excluded': ['real student timetable fixtures and complete tests', 'credentials and private configuration', 'dependencies caches and generated dist'], 'validationScope': 'install typecheck build; not all repository tests or real model/device acceptance', 'files': records}
    source_zip = output / '岭南小栈-源码子包.zip'
    with zipfile.ZipFile(source_zip, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(files.items()): archive.writestr('源代码/' + name, data)
        archive.writestr('源代码/SOURCE-MANIFEST.json', json.dumps(manifest, ensure_ascii=False, indent=2))
    with zipfile.ZipFile(source_zip) as archive:
        if archive.testzip() is not None: raise ValueError('Source ZIP CRC failure')
    version = {'sourceCommit': commit, 'businessCodeBase': '8dda8d363d88d670bd2d5d0edb432434e47fb35c', 'mainCodeMerge': '092f6570d436d7f975e55a81a1fec19d11d719aa', 'sourcePayloadSha256': payload_sha, 'sourceFiles': len(records), 'sourceZipSha256': sha(source_zip.read_bytes()), 'submitted': False}
    write_json(DOCS / 'source-version.json', version)
    write_json(output / 'source-version.json', version)
    return source_zip, version

def build_package(source_zip, version, output, current_video):
    validation = json.loads((DOCS / 'package-validation.json').read_text(encoding='utf-8'))
    if validation.get('sourceCommit') != version['sourceCommit'] or not validation.get('passed'):
        raise ValueError('Source validation must pass for this exact source commit')
    items = {}
    with zipfile.ZipFile(source_zip) as archive:
        for name in archive.namelist(): items[name] = archive.read(name)
    for filename in ['岭南小栈-作品说明.docx', '岭南小栈-作品说明.pdf', '岭南小栈-体验与运行说明.docx', '岭南小栈-体验与运行说明.pdf', '岭南小栈-提交核对清单.docx', '岭南小栈-提交核对清单.pdf', '作品说明.md', '体验说明.md', '提交核对清单.md']:
        items[filename] = (DOCS / filename).read_bytes()
    for filename in ['source-version.json', 'package-validation.json', 'document-validation.json', 'video-validation.json']:
        items['版本与验证/' + filename] = (DOCS / filename).read_bytes()
    judge = ROOT / 'docs/competition/submission-2026-10-30/judge-timetable'
    items['附件/评委测试课表/岭南小栈-评委测试课表.xlsx'] = (judge / '岭南小栈-评委测试课表.xlsx').read_bytes()
    items['附件/评委测试课表/导入说明.md'] = '''# 虚构评委测试课表

同目录Excel为13条虚构课程记录、12个课程名，不是学生真实课表。先把文件发送到微信聊天，再从小程序的Excel入口选择。
解析后逐条核对星期、节次、周次、教师和地点。确认保存会整份替换该账号全部已有课程，包括手工新增和修改；应使用空白或专用测试账号，不确定时选择放弃。
附件离线校验不证明真实云端整表替换或完整学期图片识别准确率。截图样例只覆盖1至6节，其余节次是否有课无法由该图确认。
'''.encode('utf-8')
    items['附件/评委测试课表/离线校验.json'] = (judge / 'validation.json').read_bytes()
    items['附件/截图识别样例-虚构数据.png'] = (ROOT / 'docs/competition/demo-video-2026-10-30/虚构课表-截图识别样例.png').read_bytes()
    items['演示视频/01-新版原生流程-固定响应.mp4'] = current_video.read_bytes()
    items['演示视频/02-历史真实AI实录-20261030.mp4'] = (ROOT / 'docs/competition/demo-video-2026-10-30/岭南小栈-实际运行完整演示-AI配音.mp4').read_bytes()
    evidence = ROOT / 'docs/evidence/lingnan-ui-implementation/integration-2026-11-14'
    for rel in ['native/01-home.png', 'native/02-home-to-assistant.png', 'native/04-home-course-edit.png', 'native/06-plan-to-week.png', 'native/07-notice-saved.png', 'native/08-notice-undo.png', 'native/09-notice-late-reply.png', 'native/10-notice-input-locked.png', 'c-regression/15-ai-draft.png', 'c-regression/77-practice-record.png', 'a-regression/08-campus.png', 'a-regression/18-news-detail.png']:
        items['附件/新版原生截图/' + rel.replace('/', '_')] = (evidence / rel).read_bytes()
    items['附件/集成审查摘要.md'] = '''# 集成审查摘要

公共基础及A/B/C原生交付保留共同祖先并完成集成，修复通知旧提案及迟到回复、写入锁、规则换排丢约束、已有课程误进新增、常驻tab时钟、无课日误报、导航意图与原答复制等问题。
类型检查及1025项仓库回归通过，A14项、B12项、C31场景、目标日9项与最终跨模块10项原生夹具检查通过。原生结果JSON保留原始字段，截图路径是仓库证据位置；本包另选12张截图统一放在“附件/新版原生截图”。
390逻辑宽度与371像素PNG分别记录。拍图期间暂停夹具撤销计时的轮次不证明10秒截止边界。全部夹具结果不代替真实模型、云端、真机或完整320独立验证。
完整报告位于仓库docs/review/lingnan-ui-integration-2026-11-14.md，来源与未覆盖项按原记录保留。
'''.encode('utf-8')
    items['附件/原生跨模块结果.json'] = (evidence / 'native/report.json').read_bytes()
    items['README.md'] = '''# 岭南小栈r4参赛交付

先阅读作品说明PDF或Word，再按体验与运行说明操作。演示视频01为最新原生界面、虚构课表和固定AI响应，02为2026年10月30日旧界面的真实AI历史记录，不混成同一版本。
源代码根目录执行npm ci --ignore-scripts、npm run typecheck、npm run build，再导入dist。子包未附真实课表夹具和完整tests，不承诺全部1025项回归复现。
评委测试Excel为13条虚构记录。确认导入将整份替换账号原课表，含手工新增及修改，应使用空白或专用账号。
版本与验证目录及文件清单绑定实际源码和材料。未通过的独立AI质量/8秒门槛、320独立复跑及真机等边界仍保留。本包没有生产密钥、通用账号、体验二维码或赛事提交回执。
'''.encode('utf-8')
    for name in items:
        if not safe_member(name): raise ValueError('Forbidden archive path ' + name)
    records = [{'path': n, 'bytes': len(d), 'sha256': sha(d)} for n, d in sorted(items.items())]
    items['文件清单.json'] = json.dumps({'sourceCommit': version['sourceCommit'], 'files': records, 'scope': 'all payload members except this manifest'}, ensure_ascii=False, indent=2).encode('utf-8')
    target = output / '第九届传智杯-AI小程序赛道-岭南小栈.zip'
    if target.exists(): raise FileExistsError('Preserve checked packages; choose a new output directory')
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(items.items()): archive.writestr(name, data)
    with zipfile.ZipFile(target) as archive:
        if archive.testzip() is not None: raise ValueError('Package ZIP CRC failure')
        for record in records:
            if sha(archive.read(record['path'])) != record['sha256']: raise ValueError('Package hash mismatch')
    check = {'file': target.name, 'bytes': target.stat().st_size, 'sha256': sha(target.read_bytes()), 'sourceCommit': version['sourceCommit'], 'sourcePayloadSha256': version['sourcePayloadSha256'], 'sourceFiles': version['sourceFiles'], 'payloadFiles': len(records), 'crcPassed': True, 'allPayloadHashesVerified': True, 'pathFilterPassed': True, 'sourceCredentialPatternScanPassed': True, 'under300MB': target.stat().st_size < 300 * 1024 * 1024, 'packagePrepared': True, 'submitted': False}
    write_json(DOCS / 'package-check.json', check); write_json(output / 'package-check.json', check)
    checksum = f"{check['sha256']}  {target.name}\n"
    (DOCS / 'SHA256.txt').write_text(checksum, encoding='utf-8'); (output / 'SHA256.txt').write_text(checksum, encoding='utf-8')
    print(json.dumps(check, ensure_ascii=False, indent=2))

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source-ref', required=True); p.add_argument('--out-dir', required=True)
    p.add_argument('--source-only', action='store_true'); p.add_argument('--current-video')
    a = p.parse_args(); output = Path(a.out_dir).resolve(); output.mkdir(parents=True, exist_ok=True)
    source_zip, version = build_source(a.source_ref, output)
    if a.source_only: print(json.dumps(version, ensure_ascii=False, indent=2)); return
    if not a.current_video: raise ValueError('--current-video is required for the complete package')
    build_package(source_zip, version, output, Path(a.current_video).resolve())

if __name__ == '__main__': main()
