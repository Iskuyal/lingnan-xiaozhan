/**
 * 课表导入：两条入口——选文件 → 上传 → 云端解析 → 确认页 → 保存；
 * 拍照/相册选图 → 压缩上传 → AI 识别(vision) → 确认页 → 保存(Ticket 05)。
 *
 * 必须写在页面上的前提（见 docs/product/spec.md）：
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
import { rawErrorText } from '../../../services/cloud';
import {
  GridLayout,
  blockingReason,
  buildGrid,
  sectionLabelOf,
  semesterLabel,
  weekLabelOf,
  weekdayLabel,
} from '../../../services/timetable/view';
import { colorAt, colorIndexFor } from '../../../services/timetable/palette';
import { UNKNOWN_COURSE_NAME, buildDraftGrid } from './draft-grid';
import { presentGrid } from '../../../services/timetable/presentation';
import { callAi, userMessage, visionEvent } from '../../../services/ai';
import {
  MAX_PHOTO_BYTES,
  PHOTO_GUIDE,
  VISION_BANDS,
  VISION_MAX_TOKENS,
  VISION_PROMPT,
  VISION_SYSTEM,
  parseVisionText,
  photoFileName,
  planCompression,
  resolvePhotoFormat,
  toBytes,
  unsupportedFormatLabel,
  CompressionStep,
} from '../../../services/timetable/photo';

type Step = 'guide' | 'parsing' | 'review' | 'error';
type ImportKind = '' | 'file' | 'photo';
/** 确认页的两种读法：列表看细节，课表看落位（设计图 13）。两者是同一份内存草稿。 */
type DraftView = 'list' | 'grid';

interface ChosenFile {
  path: string;
  name: string;
  size?: number;
}

/** 元信息卡的一行：左键右值（设计图 13 的 sheet-row）。 */
interface MetaRow {
  key: string;
  value: string;
}

interface DraftItemView {
  index: number;
  name: string;
  weekdayText: string;
  sectionText: string;
  weekText: string;
  teacherText: string;
  /** 列表卡的第二行：星期 · 节次 · 周次 · 地点（设计图 13 的 card-line）。 */
  cardLine: string;
  /** 列表卡的第三行：教师与校区 / 场地编号 / 备注。 */
  cardNote: string;
  /** 课程色条的实色：草稿卡的颜色按课程名取（services/timetable/palette.ts）。 */
  barSolid: string;
  needsReview: boolean;
  warningText: string;
  rawText: string;
  blocking: string;
}

interface DatasetEvent {
  currentTarget: { dataset: { index?: number; mode?: string } };
}

/** 确认页默认视图：列表（设计图 13 的默认选中项）。 */
const DEFAULT_DRAFT_VIEW: DraftView = 'list';
/** 初始网格：草稿还没来之前也要有个合法形状可渲染。 */
const EMPTY_GRID: GridLayout = buildGrid([], 1);

/** 压缩结果：成功给可用路径；失败要带原因，页面按真实原因措辞（不把一切都归成「超过 1MB」）。 */
type CompressResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'too-large' | 'compress-failed' };

const TOO_LARGE_MESSAGE = '图片压缩后仍然超过 1MB，请换一张更清晰的课表截图，或改为文件导入。';
const COMPRESS_FAILED_MESSAGE = '图片压缩失败或读不到图片大小，请换一张截图重试，或改为文件导入。';
const FORMAT_UNKNOWN_MESSAGE = '无法确认图片格式（文件头和文件名都不是 PNG/JPG），请换一张课表截图，或改为文件导入。';
const REVIEW_EXITS_NOTE = '识别结果可能不全：可以重试识别、改为文件导入，或先保存已识别的课程、再用「手工录入」补上未识别的部分。';

function textOr(value: string, fallback: string): string {
  return value === '' ? fallback : value;
}

/** 「解析结果」行：既给门数，也给「文件里 N 条课条目」这类来龙去脉，别让人觉得门数是凭空来的。 */
function parseResultText(draft: TimetableDraft): string {
  if (draft.meta.origin === 'photo') {
    return `${draft.stats.courses} 门课程（截图里识别出 ${draft.stats.entries} 条课程条目）`;
  }
  return `${draft.stats.courses} 门课程（文件里 ${draft.stats.entries} 条课条目，按大节去重后 ${draft.stats.courses} 门）`;
}

/** 元信息卡最后一行：待核对 / 待补全的条数与「现在能不能保存」写在同一句里（设计图 13 的 head-meta）。 */
function metaLineOf(warningCount: number, blockedCount: number): string {
  const counts = `其中 ${warningCount} 门待核对、${blockedCount} 门需要补全`;
  return blockedCount > 0 ? `${counts}，补全后才能保存` : `${counts}，可以保存`;
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
    draftView: DEFAULT_DRAFT_VIEW as DraftView,
    metaRows: [] as MetaRow[],
    metaLines: [] as string[],
    metaLine: '',
    problemsText: '',
    items: [] as DraftItemView[],
    draftGrid: EMPTY_GRID,
    draftGridUi: presentGrid(EMPTY_GRID, true),
    gridHintWarn: '',
    semester: '',
    semesterText: '',
    courseCount: 0,
    warningCount: 0,
    blockedCount: 0,
    privacyText: FILE_PRIVACY,
    isPhoto: false,
    reviewExitsNote: REVIEW_EXITS_NOTE,
    saving: false,
  },
  /**
   * 上传成功后云存储返回的 fileID（`cloud://…`）：解析、清理与 vision 都用它。
   * 不能用 `prepareUpload` 给的 cloudPath——那不是 fileID，云函数下载时会失败。
   */
  fileID: '',
  onLoad() {
    // 每次进入导入页都是全新会话；残留草稿（例如上次未保存就退出）不沿用。
    clearDraft();
  },
  /** 从编辑页返回时刷新确认页展示。 */
  onShow() {
    if (this.data.step === 'review') this.refresh();
  },
  chooseFile() {
    if (typeof wx.chooseMessageFile !== 'function') {
      wx.showModal({
        title: '暂不支持文件导入',
        content: '当前微信环境不支持从聊天记录选择课表文件。你可以改用课表截图识别，或返回课表后手工录入。',
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }
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
        // 用户取消不算错误：先看原始文本再决定，取消时连诊断日志都不打
        //（否则日志里出现「课表操作失败：… cancel」，看日志的人会以为真的失败了）。
        if (/cancel/u.test(rawErrorText(error))) {
          this.restoreReviewIfDraft();
          return;
        }
        this.setData({ step: 'error', photoError: false, errorMessage: `选择文件失败：${messageOf(error)}` });
      },
    });
  },
  startImport(file: ChosenFile) {
    this.fileID = '';
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
      .then((prepared) => uploadFile(prepared.cloudPath, file.path, (percent) => this.setData({ progress: percent })))
      .then((uploaded) => {
        this.fileID = uploaded.fileID;
        this.setData({ parsingText: '云端正在解析课表，解析期间不会写入任何课表数据…' });
        return importDraft(uploaded.fileID, file.name);
      })
      .then((draft) => {
        this.fileID = '';
        setDraft(draft);
        this.setData({ step: 'review' });
        this.refresh();
      })
      .catch((error) => {
        if (this.fileID !== '') void discardUpload(this.fileID);
        this.fileID = '';
        this.setData({ step: 'error', photoError: false, errorMessage: messageOf(error) });
      });
  },
  /** 从确认页发起的重试被用户取消时回到确认页，别把已有草稿藏起来。 */
  restoreReviewIfDraft() {
    if (getDraft() !== null) {
      this.setData({ step: 'review' });
      this.refresh();
    }
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
        // 与选文件一致：取消不是失败，也不打诊断日志。
        if (/cancel/u.test(rawErrorText(error))) {
          this.restoreReviewIfDraft();
          return;
        }
        this.setData({ step: 'error', photoError: false, errorMessage: `选择图片失败：${messageOf(error)}` });
      },
    });
  },
  async startPhoto(filePath: string, bytes: number) {
    this.fileID = '';
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
      const compressed = await this.compressToLimit(filePath, bytes);
      if (!compressed.ok) {
        this.setData({
          step: 'error',
          photoError: true,
          errorMessage: compressed.reason === 'too-large' ? TOO_LARGE_MESSAGE : COMPRESS_FAILED_MESSAGE,
        });
        return;
      }
      // 压缩产物可能是 JPEG（相机与 wx.compressImage 的常态），因此**压缩之后再定格式**：
      // 文件头优先、路径扩展名兜底，两者都拿不到就拒绝上传，不替用户假定一个格式。
      const header = await this.readHeader(compressed.path);
      const format = resolvePhotoFormat(compressed.path, header);
      if (format === null) {
        const unsupported = unsupportedFormatLabel(header);
        this.setData({
          step: 'error',
          photoError: true,
          errorMessage: unsupported === ''
            ? FORMAT_UNKNOWN_MESSAGE
            : `这张图片是 ${unsupported} 格式，暂不支持；请换一张 PNG 或 JPG 的课表截图，或改为文件导入。`,
        });
        return;
      }
      const prepared = await preparePhotoUpload(photoFileName(format));
      const uploaded = await uploadFile(prepared.cloudPath, compressed.path, (percent) => this.setData({ progress: percent }));
      this.fileID = uploaded.fileID;
      this.setData({ parsingText: 'AI 正在识别截图，识别期间不会写入任何课表数据…' });
      const result = await callAi(visionEvent(
        'timetable-screenshot',
        VISION_SYSTEM,
        VISION_PROMPT,
        { fileID: uploaded.fileID },
        VISION_MAX_TOKENS,
        VISION_BANDS,
      ));
      const fileID = this.fileID;
      this.fileID = '';
      if (fileID !== '') void discardUpload(fileID);
      if (!result.ok) {
        // 上传的是图片：内容被拒时用图片语义的兜底文案（服务端 message 仍优先）。
        this.setData({ step: 'error', photoError: true, errorMessage: userMessage(result, 'image'), capWarning: result.capWarning });
        return;
      }
      setDraft(parseVisionText(result.text));
      this.setData({ step: 'review' });
      this.refresh();
    } catch (error) {
      if (this.fileID !== '') {
        void discardUpload(this.fileID);
        this.fileID = '';
      }
      this.setData({ step: 'error', photoError: true, errorMessage: messageOf(error) });
    }
  },
  /** 读文件头的前 12 字节用于判格式；读不到返回 null（由路径扩展名兜底，不阻断流程）。 */
  readHeader(filePath: string): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      try {
        const manager = wx.getFileSystemManager();
        if (manager === undefined || typeof manager.readFile !== 'function') {
          resolve(null);
          return;
        }
        manager.readFile({
          filePath,
          position: 0,
          length: 12,
          success: (result) => resolve(toBytes(result.data)),
          fail: () => resolve(null),
        });
      } catch {
        resolve(null);
      }
    });
  },
  /** 压缩决策由 photo.ts 的纯函数给出，这里只执行 wx 调用；每一步后重新量大小，失败带上原因。 */
  async compressToLimit(filePath: string, bytes: number): Promise<CompressResult> {
    let current = filePath;
    let size = bytes;
    for (let attempt = 0; ; attempt += 1) {
      const step = planCompression(size, attempt);
      if (step === 'none') return { ok: true, path: current };
      // 阶梯走完仍超限：planCompression 给出可达的终点，页面按「压缩后仍超限」措辞。
      if (step === 'give-up') return { ok: false, reason: 'too-large' };
      const next = await this.applyCompressionStep(step, current);
      if (next === null) return { ok: false, reason: 'compress-failed' };
      current = next.path;
      size = next.size;
    }
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
  /** 按内存草稿刷新确认页：列表卡的字段、元信息卡、以及课表视图要的网格都在这里算好。 */
  refresh() {
    const draft = getDraft();
    if (draft === null) {
      this.setData({ step: 'guide', items: [], courseCount: 0, blockedCount: 0, warningCount: 0, draftGrid: EMPTY_GRID, draftGridUi: presentGrid(EMPTY_GRID, true) });
      return;
    }
    const items: DraftItemView[] = draft.courses.map((course: DraftCourse, index: number) => {
      const name = textOr(course.name, UNKNOWN_COURSE_NAME);
      const weekdayText = textOr(weekdayLabel(course.weekday), '星期待核对');
      const sectionText = sectionLabelOf(course);
      const weekText = weekLabelOf(course);
      const locationText = textOr(course.location, '地点未识别');
      const noteText = [course.campus, course.siteNumber === '' ? '' : `场地编号 ${course.siteNumber}`, course.note]
        .filter((part) => part !== '')
        .join(' · ');
      return {
        index,
        name,
        weekdayText,
        sectionText,
        weekText,
        teacherText: textOr(course.teacher, '教师未识别'),
        // 列表卡按「星期 · 节次 · 周次 · 地点」一行读完（设计图 13 的 card-line），
        // 教师与校区 / 场地编号 / 备注跟在下一行；原文单独一行，永不省略。
        cardLine: [weekdayText, sectionText, weekText, locationText].filter((part) => part !== '').join(' · '),
        cardNote: [`教师：${textOr(course.teacher, '教师未识别')}`, noteText].filter((part) => part !== '').join(' · '),
        barSolid: colorAt(colorIndexFor(course.name)).solid,
        needsReview: course.warnings.length > 0,
        warningText: course.warnings.join('；'),
        rawText: course.rawText,
        blocking: blockingReason(course),
      };
    });
    const blocked = items.filter((item) => item.blocking !== '');
    const warningCount = items.filter((item) => item.needsReview).length;
    const isPhoto = draft.meta.origin === 'photo';
    const placed = buildDraftGrid(draft);
    // 越界（字段齐全、节次落在 1-12 节之外）的条目不在「待补全」口径里，单独说一句，
    // 免得「画不出来」这件事在课表视图里没有任何解释。
    const strayed = placed.unplaced - placed.unplacedBlocked;
    const gridHintWarn = [
      blocked.length > 0 ? `${blocked.length} 条待补全，切到列表可以修正` : '',
      strayed > 0 ? `${strayed} 条节次落在 1-12 节之外，没有画进课表，列表里可以看到原文` : '',
    ].filter((part) => part !== '').join(' ');
    this.setData({
      items,
      isPhoto,
      courseCount: draft.courses.length,
      warningCount,
      blockedCount: blocked.length,
      semester: draft.meta.semester,
      semesterText: semesterLabel(draft.meta.semester),
      metaRows: [
        { key: '学期', value: semesterLabel(draft.meta.semester) },
        { key: '班级', value: textOr(draft.meta.className, '班级未识别') },
        { key: '来源文件', value: textOr(draft.meta.fileName, '未读到文件名') },
        { key: '解析结果', value: parseResultText(draft) },
      ],
      metaLines: isPhoto
        ? [
            '识别来源：课表截图（AI 多模态识别，可能有误，请逐条确认）',
            draft.meta.school === '' ? '学校名称未识别' : draft.meta.school,
          ]
        : [
            draft.meta.school === '' ? '学校名称未识别' : draft.meta.school,
            draft.meta.department === '' ? '院系未识别' : draft.meta.department,
            draft.meta.exportedAt === '' ? '未读到导出时间' : `文件导出时间 ${draft.meta.exportedAt}`,
          ],
      metaLine: metaLineOf(warningCount, blocked.length),
      problemsText: draft.problems.join('；'),
      draftGrid: placed.layout,
      draftGridUi: presentGrid(placed.layout, true),
      gridHintWarn,
      privacyText: isPhoto ? PHOTO_PRIVACY : FILE_PRIVACY,
    });
  },
  /** 列表 / 课表切换：只换渲染，不动草稿，也不写任何数据（与主页 switchView 同一套）。 */
  switchView(event: DatasetEvent) {
    const mode = event.currentTarget.dataset.mode;
    if (mode !== 'grid' && mode !== 'list') return;
    this.setData({ draftView: mode });
  },
  /** 修正 / 补录：打开这条草稿的编辑表单（草稿态），返回时 onShow 会重新刷新。 */
  fixItem(event: DatasetEvent) {
    const index = Number(event.currentTarget.dataset.index);
    if (!Number.isInteger(index)) return;
    wx.navigateTo({ url: `/pages/timetable/edit/index?scope=draft&index=${index}` });
  },
  /**
   * 跳过未识别的行：只从内存草稿里去掉这一行，不写任何数据（放弃导入仍可整批撤销）。
   * 不「先留着、保存时再丢」——它缺课程名 / 星期 / 节次，留着就会一直拦住保存。
   */
  skipItem(event: DatasetEvent) {
    const index = Number(event.currentTarget.dataset.index);
    if (!Number.isInteger(index)) return;
    if (removeCourseAt(index)) {
      wx.showToast({ title: '已跳过这一行', icon: 'none' });
      this.refresh();
    }
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
  /** 改为文件导入：错误态与确认页（部分成功）都走这里；草稿留着，用户取消重选时回到确认页。 */
  retryChoose() {
    this.setData({ step: 'guide', errorMessage: '', fileName: '', progress: 0, photoError: false, capWarning: '', importKind: '' });
  },
  /**
   * 重试识别：回到引导后直接再次拉起选图。
   * 确认页（识别部分成功）与错误态共用；新草稿生成前不删旧草稿，取消选图会回到确认页。
   */
  retryPhoto() {
    this.setData({ step: 'guide', errorMessage: '', fileName: '', progress: 0, photoError: false, capWarning: '', importKind: '' });
    this.choosePhoto();
  },
  /** 降级出口：Ticket 03 的手工录入入口，必须实际可走通（错误态与确认页都提供）。 */
  goManualAdd() {
    wx.navigateTo({ url: '/pages/timetable/edit/index?scope=new' });
  },
  goBack() {
    clearDraft();
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/timetable/index' });
  },
});
