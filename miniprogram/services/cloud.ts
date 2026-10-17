/**
 * 云调用的公共传输层（Ticket 07 两轴复核抽出）。
 *
 * `wx.cloud.callFunction` 失败时抛出的常是带 `errMsg` 的普通对象而非 Error 实例；
 * 「云函数未部署 / 没有权限 / 超时」这三类技术性失败，各功能服务都要映射成同一口径的
 * 用户文案。此前 `services/ai.ts` 的 `transportMessage` 与 `services/timetable/index.ts`
 * 的 `messageOf` 各自实现了一份（三条正则逐字相同），`requireCloud` 更是在三个服务里重复；
 * 这里只保留一份实现，各服务传入自己的服务名与兜底策略。
 *
 * 这里只放客户端共用代码：**不引用 `cloudfunctions/` 下的任何模块**（构建布局有断言，
 * 小程序包不得出现云函数代码），失败分类等契约以注释说明来源、同步一份常量。
 */

/** 云开发能力不可用时的统一提示；三个服务共用同一句。 */
export function requireCloud(): void {
  if (typeof wx === 'undefined' || wx.cloud === undefined) {
    throw new Error('云开发不可用：请确认基础库版本与 app.ts 中的 wx.cloud.init');
  }
}

/** 从错误对象里取可读文本：优先 `message`，其次 `errMsg`，都没有则为空串。 */
export function rawErrorText(error: unknown): string {
  if (error !== null && error !== undefined && typeof error === 'object') {
    const candidate = error as { message?: unknown; errMsg?: unknown };
    if (typeof candidate.message === 'string' && candidate.message !== '') return candidate.message;
    if (typeof candidate.errMsg === 'string' && candidate.errMsg !== '') return candidate.errMsg;
    return '';
  }
  return error === null || error === undefined ? '' : String(error);
}

/**
 * 三类技术性失败的识别规则（云开发错误码与 errMsg 原文）。
 * 判定只用这些，不猜别的失败原因：其余错误交给调用方的兜底策略。
 */
const NOT_DEPLOYED = /FUNCTION_NOT_FOUND|FunctionName parameter could not be found/u;
const NO_PERMISSION = /permission denied|-501023/u;
const TIMEOUT = /timeout|-504003/u;

/**
 * 网络类失败：请求根本没到云端（或响应没回来），与「云函数/模型出错」是两回事。
 *
 * 为什么必须单独认这一类：网络原文是英文技术描述，学生读不懂，而且带 `cloud.uploadFile`、
 * `ERR_*`、`ECONNRESET` 这类内部字样——2026-10-08 开发者工具实测就把它原样递到了导入页：
 * 「上传失败：cloud.uploadFile:fail undefined . uploadFile:fail Error: Client network socket
 * disconnected before secure TLS connection was established」。
 *
 * 关键词取真实出现过的形态：开发者工具的 `Client network socket disconnected`、
 * `request:fail` 系列 `net::ERR_*`/`errno:`、Node 侧 `socket hang up`/`ECONNRESET`/`ETIMEDOUT`，
 * 以及 `uploadFile:`/`downloadFile:` 的 `:fail`（文件接口失败几乎都是链路问题）。
 * **不含裸 `timeout`**——那句归上面的 TIMEOUT（云函数超时），措辞不同、指向的处理也不同。
 */
const NETWORK = /network socket|socket hang up|net::ERR_|request:fail|errno:|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|uploadFile:|downloadFile:|Client network/iu;

/** 网络类失败的统一文案；三个服务共用同一句，不按服务换措辞。 */
export const NETWORK_MESSAGE = '网络连接不稳定，请检查网络后重试';

export interface TransportCopyOptions {
  /** 服务名，用在「…暂时不可用」「没有权限使用…」「…响应超时」三句里，如 'AI 服务'、'课表服务'。 */
  service: string;
  /** 控制台日志前缀，便于分辨是哪个模块失败的，如 'AI 调用失败'。 */
  logLabel: string;
  /**
   * 归类不了时的处置：给空串表示**原样返回**原始错误文本（课表页要把云函数返回的
   * 业务提示直接展示给用户）；给非空串则一律换成这句兜底文案（AI 页只上屏一句
   * 「暂时不可用」，服务端细节留控制台）。
   */
  fallback: string;
}

/** 把技术性传输失败映射成可读文案；原始错误打到控制台，便于排查。 */
export function transportMessage(error: unknown, options: TransportCopyOptions): string {
  const raw = rawErrorText(error);
  if (NOT_DEPLOYED.test(raw)) return `${options.service}暂时不可用（云函数尚未部署或正在部署），请稍后重试`;
  if (NO_PERMISSION.test(raw)) return `没有权限使用${options.service}，请确认已用微信登录后重试`;
  if (TIMEOUT.test(raw)) return `${options.service}响应超时，请稍后重试`;
  // 网络类失败**不交给调用方的兜底策略**：兜底在课表侧是「原样透出」，会把英文原文递给学生。
  if (NETWORK.test(raw)) {
    console.error(`${options.logLabel}（网络）：`, raw);
    return NETWORK_MESSAGE;
  }
  if (raw === '') return options.fallback === '' ? '未知错误' : options.fallback;
  console.error(`${options.logLabel}：`, raw);
  return options.fallback === '' ? raw : options.fallback;
}
