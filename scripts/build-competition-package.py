"""Build the latest source subset and submission ZIP without private fixtures or credentials."""
from pathlib import Path, PurePosixPath
import argparse, hashlib, json, re, subprocess, zipfile

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / 'docs/competition/submission-latest'
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

def approved_video_bytes(path, approval):
    data = path.read_bytes()
    if approval.get('ownerApproved') is not True or sha(data) != approval.get('sha256'):
        raise ValueError('Video must match the exact owner-approved latest file')
    return data


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
    for filename in ['source-version.json', 'package-validation.json', 'document-validation.json', 'video-validation.json', 'repository-validation.json']:
        items['版本与验证/' + filename] = (DOCS / filename).read_bytes()
    judge = DOCS / 'inputs'
    items['附件/评委测试课表/岭南小栈-评委测试课表.xlsx'] = (judge / '岭南小栈-评委测试课表.xlsx').read_bytes()
    items['附件/评委测试课表/离线校验.json'] = (judge / 'validation.json').read_bytes()
    items['附件/截图识别样例-虚构数据.png'] = (judge / '虚构课表截图.png').read_bytes()
    items['附件/评委测试课表/导入说明.md'] = '13条虚构课程，仅供测试。确认导入会整份替换账号已有课表，含手工新增与修改，请使用空白或专用账号。截图只覆盖部分节次；核对后才能保存。离线解析不证明云端保存或识别准确率。'.encode('utf-8')
    approval = json.loads((DOCS / 'video-validation.json').read_text(encoding='utf-8'))
    items['演示视频/岭南小栈-功能演示.mp4'] = approved_video_bytes(current_video, approval)
    items['README.md'] = '''# 岭南小栈最新提交包 2026年11月17日\n\n先阅读作品说明PDF或Word，再按体验与运行说明操作。演示视频为负责人提供并确认的最新文件，原样收录，未重新审查内容。旧预提交材料不随包。\n\n源代码根目录执行npm ci --ignore-scripts、npm run typecheck、npm run build，再导入dist。子包未附真实学生课表夹具与完整tests，完整仓库回归另见技术记录。\n\n虚构测试Excel含13条记录。确认导入会整份替换账号已有课表，含手工新增及修改，请使用空白或专用账号。\n\n版本与验证以及文件清单绑定实际源码、视频和文档。包准备完成不等于已提交赛事。没有生产密钥、通用账号、体验二维码或提交回执。\n'''.encode('utf-8')
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
