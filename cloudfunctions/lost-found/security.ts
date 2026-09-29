/**
 * 失物招领安全与隐私辅助（纯函数）。
 *
 * - 联系方式记号检测:公开描述不得出现手机号/微信号/QQ 等(框架第 12 节);
 * - 图片归属:fileID 必须带本人 hash 前缀,防止引用他人上传的图片;
 * - 私密泄漏检测:候选解释不得包含私密核验特征的原文(框架第 11.2 节)。
 */

const CONTACT_PATTERNS: RegExp[] = [
  /\b1[3-9]\d{9}\b/u,
  /\b0\d{2,3}-\d{7,8}\b/u,
  /(?:微信|WeChat|wechat|Weixin|WX|wx)\s*(?:号|号码)?\s*[:：]?\s*[A-Za-z][A-Za-z0-9_-]{5,19}/u,
  /(?:QQ|qq)\s*(?:号|号码)?\s*[:：]?\s*\d{5,12}/u,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u,
];

/** 文本里是否出现联系方式记号(与 departments/qa.ts 同思路,这里按拒绝用途收紧)。 */
export function hasContactToken(text: string): boolean {
  for (const pattern of CONTACT_PATTERNS) {
    const scanner = new RegExp(pattern.source, pattern.flags);
    if (scanner.test(text)) return true;
  }
  return false;
}

/** 图片 fileID 是否属于该 ownerHash 的上传路径。 */
export function isOwnImage(fileId: string, ownerHash: string): boolean {
  const match = /^cloud:\/\/[^/]+\/lost-found\/([^/]+)\/[^/]+\.(png|jpe?g)$/i.exec(fileId);
  return match !== null && match[1] === ownerHash;
}

interface Explanation {
  similarities: string[];
  conflicts: string[];
  uncertainties: string[];
}

/**
 * 候选解释是否泄漏私密核验特征原文。
 *
 * 只做逐条「包含」检查:核验特征以整句形式出现才算泄漏;单个短词(如「蓝色」)
 * 不判泄漏,避免把正常解释全拦掉——完整特征句泄露才是冒领风险所在。
 */
export function explanationsLeakPrivate(explanation: Explanation, traits: string): boolean {
  const trimmed = traits.trim();
  if (trimmed === '') return false;
  const lines = explanation.similarities.concat(explanation.conflicts, explanation.uncertainties);
  return lines.some((line) => line.includes(trimmed));
}

/** ownerOpenId 的图片上传前缀 hash(与小程序端一致的确定性 hash)。 */
export function ownerHashOf(openid: string): string {
  // 云函数运行时无 crypto 依赖可用时的降级:仍要确定性,但这里的调用方(上传)在小程序端完成,
  // 云函数只用于校验 fileID 前缀,因此直接用 openid 的简单摘要即可。
  let hash = 0;
  for (let i = 0; i < openid.length; i += 1) {
    hash = (hash * 31 + openid.charCodeAt(i)) | 0;
  }
  const hex = (hash >>> 0).toString(16).padStart(8, '0');
  return `${hex}${openid.length.toString(16)}`;
}
