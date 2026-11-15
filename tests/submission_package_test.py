"""Packaging checks are separate from the application's Node test count."""
from pathlib import Path
import importlib.util, unittest
SPEC = importlib.util.spec_from_file_location('package_builder', Path(__file__).resolve().parents[1] / 'scripts/build-competition-package.py')
builder = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(builder)

class SubmissionPackageTests(unittest.TestCase):
    def test_rejects_escape_and_absolute_members(self):
        for name in ['../outside.txt', '/tmp/key', 'C:/Users/x/key', '源代码/../../outside', '源代码\\file']:
            with self.subTest(name=name): self.assertFalse(builder.safe_member(name))
    def test_rejects_credentials_private_data_and_dependencies(self):
        for name in ['源代码/.env', '源代码/project.private.config.json', '源代码/node_modules/a.js', '源代码/tests/fixtures/real.xls', '源代码/.git/config', '源代码/a.pem', '源代码/dist/app.js']:
            with self.subTest(name=name): self.assertFalse(builder.safe_member(name))
    def test_allows_explicit_synthetic_attachments(self):
        for name in ['附件/评委测试课表/岭南小栈-评委测试课表.xlsx', '源代码/miniprogram/pages/home/index.ts', '岭南小栈-作品说明.docx']:
            with self.subTest(name=name): self.assertTrue(builder.safe_member(name))
    def test_source_scope_excludes_original_student_fixtures(self):
        self.assertFalse(builder.include_source('tests/fixtures/timetable/2026-2027学年第一学期班级课表.xls'))
        self.assertFalse(builder.include_source('docs/competition/submission-2026-10-30/r3/作品说明.md'))
        self.assertTrue(builder.include_source('miniprogram/services/goals/intent.ts'))
        self.assertTrue(builder.include_source('docs/evidence/project-defense-g0/README.md'))

if __name__ == '__main__': unittest.main()
