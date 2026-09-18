/**
 * 课表导入：选文件 → 上传 → 云端解析 → 确认页 → 保存。
 *
 * 两个必须写在页面上的前提（见 docs/development-spec.md）：
 * 1. 小程序不能浏览手机本地文件，只能从微信聊天记录选择，因此引导文案要显眼；
 * 2. 解析跑在云函数侧，导入需要联网；**解析阶段不写入任何课表记录**，
 *    放弃导入不会留下任何数据（草稿只存在内存里）。
 */
import { DraftCourse, TimetableDraft } from '../../../services/timetable/types';
import {
  FILE_GUIDE,
  OFFLINE_NOTE,
  checkChosenFile,
  discardUpload,
  importDraft,
  messageOf,
  prepareUpload,
  saveDraft,
  uploadFile,
} from '../../../services/timetable/index';
import { clearDraft, getDraft, removeCourseAt, setDraft } from '../../../services/timetable/draft';
import { blockingReason, sectionLabelOf, semesterLabel, weekLabelOf, weekdayLabel } from '../../../services/timetable/view';

type Step = 'guide' | 'parsing' | 'review' | 'error';

interface ChosenFile {
  path: string;
  name: string;
  size?: number;
}

interface DraftItemView {
  index: number;
  name: string;
  weekdayText: string;
  sectionText: string;
  weekText: string;
  teacherText: string;
  locationText: string;
  noteText: string;
  needsReview: boolean;
  warningText: string;
  rawText: string;
  blocking: string;
}

interface DatasetEvent {
  currentTarget: { dataset: { index?: number } };
}

function textOr(value: string, fallback: string): string {
  return value === '' ? fallback : value;
}

Page({
  data: {
    step: 'guide' as Step,
    fileGuide: FILE_GUIDE,
    offlineNote: OFFLINE_NOTE,
    fileName: '',
    parsingText: '',
    progress: 0,
    errorMessage: '',
    metaTitle: '',
    metaLines: [] as string[],
    problemsText: '',
    items: [] as DraftItemView[],
    semester: '',
    semesterText: '',
    courseCount: 0,
    warningCount: 0,
    blockedCount: 0,
    statsText: '',
    saving: false,
  },
  /** 上传成功后临时文件的路径：解析失败且调用未到达云端时用它清理。 */
  cloudPath: '',
  onLoad() {
    // 每次进入导入页都是全新会话；残留草稿（例如上次未保存就退出）不沿用。
    clearDraft();
  },
  /** 从编辑页返回时刷新确认页展示。 */
  onShow() {
    if (this.data.step === 'review') this.refresh();
  },
  chooseFile() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['xls', 'xlsx'],
      success: (result) => {
        const files = Array.isArray(result.tempFiles) ? result.tempFiles : [];
        if (files.length === 0) return;
        const picked = files[0] as ChosenFile;
        const problem = checkChosenFile({ name: picked.name, size: picked.size });
        if (problem !== '') {
          this.setData({ step: 'error', errorMessage: problem, fileName: picked.name });
          return;
        }
        return this.startImport(picked);
      },
      fail: (error) => {
        // 用户取消不算错误，只有真正的失败才提示。
        const message = messageOf(error);
        if (/cancel/u.test(message)) return;
        this.setData({ step: 'error', errorMessage: `选择文件失败：${message}` });
      },
    });
  },
  startImport(file: ChosenFile) {
    this.cloudPath = '';
    this.setData({
      step: 'parsing',
      fileName: file.name,
      parsingText: '正在上传所选文件…',
      progress: 0,
      errorMessage: '',
    });
    return prepareUpload(file.name)
      .then((prepared) => {
        this.cloudPath = prepared.cloudPath;
        return uploadFile(prepared.cloudPath, file.path, (percent) => this.setData({ progress: percent }));
      })
      .then(() => {
        this.setData({ parsingText: '云端正在解析课表，解析期间不会写入任何课表数据…' });
        return importDraft(this.cloudPath, file.name);
      })
      .then((draft) => {
        this.cloudPath = '';
        setDraft(draft);
        this.setData({ step: 'review' });
        this.refresh();
      })
      .catch((error) => {
        if (this.cloudPath !== '') void discardUpload(this.cloudPath);
        this.cloudPath = '';
        this.setData({ step: 'error', errorMessage: messageOf(error) });
      });
  },
  refresh() {
    const draft = getDraft();
    if (draft === null) {
      this.setData({ step: 'guide', items: [], courseCount: 0 });
      return;
    }
    const items: DraftItemView[] = draft.courses.map((course: DraftCourse, index: number) => ({
      index,
      name: textOr(course.name, '课程名未识别'),
      weekdayText: textOr(weekdayLabel(course.weekday), '星期待核对'),
      sectionText: sectionLabelOf(course),
      weekText: weekLabelOf(course),
      teacherText: textOr(course.teacher, '教师未识别'),
      locationText: textOr(course.location, '地点未识别'),
      noteText: [course.campus, course.siteNumber === '' ? '' : `场地编号 ${course.siteNumber}`, course.note]
        .filter((part) => part !== '')
        .join(' · '),
      needsReview: course.warnings.length > 0,
      warningText: course.warnings.join('；'),
      rawText: course.rawText,
      blocking: blockingReason(course),
    }));
    const blocked = items.filter((item) => item.blocking !== '');
    this.setData({
      items,
      courseCount: draft.courses.length,
      warningCount: items.filter((item) => item.needsReview).length,
      blockedCount: blocked.length,
      semester: draft.meta.semester,
      semesterText: semesterLabel(draft.meta.semester),
      metaTitle: [draft.meta.className, draft.meta.major, draft.meta.grade].filter((part) => part !== '').join(' · '),
      metaLines: [
        draft.meta.school === '' ? '学校名称未识别' : draft.meta.school,
        draft.meta.department === '' ? '院系未识别' : draft.meta.department,
        draft.meta.exportedAt === '' ? '未读到导出时间' : `文件导出时间 ${draft.meta.exportedAt}`,
        `来源文件 ${draft.meta.fileName}`,
      ],
      problemsText: draft.problems.join('；'),
      statsText: `文件里共解析出 ${draft.stats.entries} 条课程条目，按大节去重后 ${draft.stats.courses} 门（合并 ${draft.stats.duplicates} 条）`,
    });
  },
  fixItem(event: DatasetEvent) {
    const index = Number(event.currentTarget.dataset.index);
    if (!Number.isInteger(index)) return;
    wx.navigateTo({ url: `/pages/timetable/edit/index?scope=draft&index=${index}` });
  },
  deleteItem(event: DatasetEvent) {
    const index = Number(event.currentTarget.dataset.index);
    if (!Number.isInteger(index)) return;
    if (removeCourseAt(index)) {
      wx.showToast({ title: '已从草稿中删除', icon: 'none' });
      this.refresh();
    }
  },
  abandon() {
    wx.showModal({
      title: '放弃本次导入',
      content: '放弃后不会写入任何课表数据，已保存的课表不受影响。',
      confirmText: '放弃导入',
      success: (result) => {
        if (!result.confirm) return;
        clearDraft();
        wx.showToast({ title: '未写入任何数据', icon: 'none' });
        if (getCurrentPages().length > 1) wx.navigateBack();
        else this.setData({ step: 'guide', items: [], courseCount: 0, blockedCount: 0, warningCount: 0 });
      },
    });
  },
  confirmSave() {
    const draft = getDraft();
    if (draft === null || this.data.saving) return;
    if (this.data.blockedCount > 0) {
      wx.showModal({
        title: '还有待补全的课程',
        content: `有 ${this.data.blockedCount} 门课程缺少课程名、星期或节次，无法放进周课表。请修正或删除后再保存。`,
        showCancel: false,
      });
      return;
    }
    this.setData({ saving: true });
    return saveDraft(draft.courses, draft.meta.semester)
      .then((result) => {
        clearDraft();
        wx.showToast({ title: `已保存 ${result.saved} 门课程`, icon: 'success' });
        setTimeout(() => {
          if (getCurrentPages().length > 1) wx.navigateBack();
          else this.setData({ step: 'guide', items: [], courseCount: 0, blockedCount: 0, saving: false });
        }, 600);
      })
      .catch((error) => {
        this.setData({ saving: false });
        wx.showModal({ title: '保存失败', content: messageOf(error), showCancel: false });
      });
  },
  retryChoose() {
    this.setData({ step: 'guide', errorMessage: '', fileName: '', progress: 0 });
  },
  goBack() {
    clearDraft();
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/timetable/index' });
  },
});
