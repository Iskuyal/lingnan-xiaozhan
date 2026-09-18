/**
 * 课表导入：两条入口——选文件 → 上传 → 云端解析 → 确认页 → 保存；
 * 拍照/相册选图 → 压缩上传 → AI 识别(vision) → 确认页 → 保存(Ticket 05)。
 *
 * 必须写在页面上的前提（见 docs/development-spec.md）：
 * 1. 小程序不能浏览手机本地文件，只能从微信聊天记录选择，因此引导文案要显眼；
 * 2. 解析跑在云函数侧，导入需要联网；**解析/识别阶段不写入任何课表记录**，
 *    放弃导入不会留下任何数据（草稿只存在内存里，截图在识别后从云存储删除）。
 */
import { DraftCourse, TimetableDraft } from '../../../services/timetable/types';
import {
  FILE_GUIDE,
  OFFLINE_NOTE,
  checkChosenFile,
  discardUpload,
  importDraft,
  messageOf,
  preparePhotoUpload,
  prepareUpload,
  saveDraft,
  uploadFile,
} from '../../../services/timetable/index';
import { clearDraft, getDraft, removeCourseAt, setDraft } from '../../../services/timetable/draft';
import { blockingReason, sectionLabelOf, semesterLabel, weekLabelOf, weekdayLabel } from '../../../services/timetable/view';
import { callAi, userMessage, visionEvent } from '../../../services/ai';
import {
  MAX_PHOTO_BYTES,
  PHOTO_GUIDE,
  VISION_MAX_TOKENS,
  VISION_PROMPT,
  VISION_SYSTEM,
  parseVisionText,
  planCompression,
  CompressionStep,
} from '../../../services/timetable/photo';

type Step = 'guide' | 'parsing' | 'review' | 'error';
type ImportKind = '' | 'file' | 'photo';

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

const FILE_PRIVACY = '保存后才写入数据库，且只写入你自己的课表；临时文件在解析后已从云存储删除。';
const PHOTO_PRIVACY = '保存后才写入数据库，且只写入你自己的课表；截图在识别完成后已从云存储删除。';

Page({
  data: {
    step: 'guide' as Step,
    importKind: '' as ImportKind,
    fileGuide: FILE_GUIDE,
    offlineNote: OFFLINE_NOTE,
    photoGuide: PHOTO_GUIDE,
    fileName: '',
    parsingText: '',
    progress: 0,
    errorMessage: '',
    photoError: false,
    capWarning: '',
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
    privacyText: FILE_PRIVACY,
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
          this.setData({ step: 'error', photoError: false, errorMessage: problem, fileName: picked.name });
          return;
        }
        return this.startImport(picked);
      },
      fail: (error) => {
        // 用户取消不算错误，只有真正的失败才提示。
        const message = messageOf(error);
        if (/cancel/u.test(message)) return;
        this.setData({ step: 'error', photoError: false, errorMessage: `选择文件失败：${message}` });
      },
    });
  },
  startImport(file: ChosenFile) {
    this.cloudPath = '';
    this.setData({
      step: 'parsing',
      importKind: 'file',
      fileName: file.name,
      parsingText: '正在上传所选文件…',
      progress: 0,
      errorMessage: '',
      photoError: false,
      capWarning: '',
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
        this.setData({ step: 'error', photoError: false, errorMessage: messageOf(error) });
      });
  },
  /** 拍照/相册选图（Ticket 05）：选择成功后进入压缩 → 上传 → 识别流程。 */
  choosePhoto() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      success: (result) => {
        const files = Array.isArray(result.tempFiles) ? result.tempFiles : [];
        if (files.length === 0) return;
        const picked = files[0] as { tempFilePath?: unknown; size?: unknown };
        const path = typeof picked.tempFilePath === 'string' ? picked.tempFilePath : '';
        if (path === '') {
          this.setData({ step: 'error', photoError: true, errorMessage: '没有拿到所选图片，请重试' });
          return;
        }
        const size = typeof picked.size === 'number' ? picked.size : MAX_PHOTO_BYTES + 1;
        return this.startPhoto(path, size);
      },
      fail: (error) => {
        // 用户取消不算错误。
        const message = messageOf(error);
        if (/cancel/u.test(message)) return;
        this.setData({ step: 'error', photoError: false, errorMessage: `选择图片失败：${message}` });
      },
    });
  },
  async startPhoto(filePath: string, bytes: number) {
    this.cloudPath = '';
    this.setData({
      step: 'parsing',
      importKind: 'photo',
      fileName: '课表截图',
      parsingText: '正在压缩并上传截图…',
      progress: 0,
      errorMessage: '',
      photoError: false,
      capWarning: '',
    });
    try {
      const readyPath = await this.compressToLimit(filePath, bytes);
      if (readyPath === null) {
        this.setData({
          step: 'error',
          photoError: true,
          errorMessage: '图片压缩后仍然超过 1MB，请换一张更清晰的课表截图，或改为文件导入。',
        });
        return;
      }
      const prepared = await preparePhotoUpload('课表截图.png');
      this.cloudPath = prepared.cloudPath;
      await uploadFile(prepared.cloudPath, readyPath, (percent) => this.setData({ progress: percent }));
      this.setData({ parsingText: 'AI 正在识别截图，识别期间不会写入任何课表数据…' });
      const result = await callAi(visionEvent(
        'timetable-screenshot',
        VISION_SYSTEM,
        VISION_PROMPT,
        { fileID: this.cloudPath },
        VISION_MAX_TOKENS,
      ));
      const cloudPath = this.cloudPath;
      this.cloudPath = '';
      if (cloudPath !== '') void discardUpload(cloudPath);
      if (!result.ok) {
        this.setData({ step: 'error', photoError: true, errorMessage: userMessage(result), capWarning: result.capWarning });
        return;
      }
      setDraft(parseVisionText(result.text));
      this.setData({ step: 'review' });
      this.refresh();
    } catch (error) {
      if (this.cloudPath !== '') {
        void discardUpload(this.cloudPath);
        this.cloudPath = '';
      }
      this.setData({ step: 'error', photoError: true, errorMessage: messageOf(error) });
    }
  },
  /** 压缩决策由 photo.ts 的纯函数给出，这里只执行 wx 调用；每一步后重新量大小。 */
  async compressToLimit(filePath: string, bytes: number): Promise<string | null> {
    let current = filePath;
    let size = bytes;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const step = planCompression(size, attempt);
      if (step === 'none') return current;
      if (step === 'give-up') return null;
      const next = await this.applyCompressionStep(step, current);
      if (next === null) return null;
      current = next.path;
      size = next.size;
    }
    return null;
  },
  applyCompressionStep(
    step: CompressionStep,
    path: string,
  ): Promise<{ path: string; size: number } | null> {
    if (step === 'quality-80' || step === 'quality-60' || step === 'quality-40') {
      const quality = Number(step.slice('quality-'.length));
      return new Promise((resolve) => {
        wx.compressImage({
          src: path,
          quality,
          success: (result) => {
            void this.sizeOf(result.tempFilePath).then((size) => resolve(size === null ? null : { path: result.tempFilePath, size }));
          },
          fail: () => resolve(null),
        });
      });
    }
    const scale = Number(step.slice('canvas-'.length));
    return this.canvasScale(path, scale);
  },
  sizeOf(filePath: string): Promise<number | null> {
    return new Promise((resolve) => {
      try {
        const manager = wx.getFileSystemManager();
        if (manager === undefined || typeof manager.getFileInfo !== 'function') {
          resolve(null);
          return;
        }
        manager.getFileInfo({
          filePath,
          success: (result) => resolve(typeof result.size === 'number' ? result.size : null),
          fail: () => resolve(null),
        });
      } catch {
        resolve(null);
      }
    });
  },
  canvasScale(filePath: string, scale: number): Promise<{ path: string; size: number } | null> {
    return new Promise((resolve) => {
      if (typeof wx.getImageInfo !== 'function') {
        resolve(null);
        return;
      }
      wx.getImageInfo({
        src: filePath,
        success: (info) => {
          try {
            const canvas = wx.createOffscreenCanvas({
              type: '2d',
              width: Math.max(1, Math.floor(info.width * scale)),
              height: Math.max(1, Math.floor(info.height * scale)),
            });
            const context = canvas.getContext('2d');
            const image = canvas.createImage();
            image.onload = () => {
              try {
                context.drawImage(image, 0, 0, canvas.width, canvas.height);
                wx.canvasToTempFilePath({
                  canvas,
                  success: (result) => {
                    void this.sizeOf(result.tempFilePath).then((size) => resolve(size === null ? null : { path: result.tempFilePath, size }));
                  },
                  fail: () => resolve(null),
                });
              } catch {
                resolve(null);
              }
            };
            image.onerror = () => resolve(null);
            image.src = filePath;
          } catch {
            resolve(null);
          }
        },
        fail: () => resolve(null),
      });
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
    const isPhoto = draft.meta.origin === 'photo';
    this.setData({
      items,
      courseCount: draft.courses.length,
      warningCount: items.filter((item) => item.needsReview).length,
      blockedCount: blocked.length,
      semester: draft.meta.semester,
      semesterText: semesterLabel(draft.meta.semester),
      metaTitle: isPhoto ? '课表截图识别草稿' : [draft.meta.className, draft.meta.major, draft.meta.grade].filter((part) => part !== '').join(' · '),
      metaLines: isPhoto
        ? [
            '识别来源：课表截图（AI 多模态识别，可能有误，请逐条确认）',
            draft.meta.school === '' ? '学校名称未识别' : draft.meta.school,
          ]
        : [
            draft.meta.school === '' ? '学校名称未识别' : draft.meta.school,
            draft.meta.department === '' ? '院系未识别' : draft.meta.department,
            draft.meta.exportedAt === '' ? '未读到导出时间' : `文件导出时间 ${draft.meta.exportedAt}`,
            `来源文件 ${draft.meta.fileName}`,
          ],
      problemsText: draft.problems.join('；'),
      statsText: isPhoto
        ? `截图识别出 ${draft.stats.entries} 条课程条目，可入周课表 ${draft.stats.courses} 门`
        : `文件里共解析出 ${draft.stats.entries} 条课程条目，按大节去重后 ${draft.stats.courses} 门（合并 ${draft.stats.duplicates} 条）`,
      privacyText: isPhoto ? PHOTO_PRIVACY : FILE_PRIVACY,
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
    this.setData({ step: 'guide', errorMessage: '', fileName: '', progress: 0, photoError: false, capWarning: '', importKind: '' });
  },
  /** 重试识别：回到引导后直接再次拉起选图。 */
  retryPhoto() {
    this.setData({ step: 'guide', errorMessage: '', fileName: '', progress: 0, photoError: false, capWarning: '', importKind: '' });
    this.choosePhoto();
  },
  /** 降级出口：Ticket 03 的手工录入入口，必须实际可走通。 */
  goManualAdd() {
    wx.navigateTo({ url: '/pages/timetable/edit/index?scope=new' });
  },
  goBack() {
    clearDraft();
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/timetable/index' });
  },
});
