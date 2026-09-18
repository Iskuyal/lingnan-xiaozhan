/**
 * 微信内容安全接口可用性探测（`action: "probe"`）。
 *
 * 为什么需要它：小程序**未做微信认证**（见 CONTEXT.md），官方内容安全云调用在未认证状态下
 * 是否可用没有把握；而内容安全是过审的硬要求，必须先探明再决定用微信官方适配器还是第三方。
 *
 * 探测只做一件事：用**固定良性文本**与**程序生成的 8×8 PNG**调用
 * `security.msgSecCheck` / `security.imgSecCheck`，把 errcode / errmsg 原样记录下来。
 * 结论由维护者粘贴进 docs/cloud-development.md 的探测记录表。
 *
 * 刻意不做的事：**不发违规文本**。刻意不验的事：违规内容会不会被拦——
 * 那属于接口语义，靠官方错误码表（见 safety.ts 的 WECHAT_ERRCODE_NOTES）+ 桩测试覆盖，
 * 用真实违规内容去试既不必要也不合适。
 */
import {
  WechatCall,
  WechatOutcome,
  WechatSecurityApi,
  judgeImgSecCheck,
  judgeMsgSecCheck,
  wechatErrcodeNote,
} from './safety';
import { ProbeCheck, ProbeRecord, ProbeResult } from './types';

/** 探测用良性文本：校园里正常的一句话，不含任何敏感内容。 */
export const PROBE_TEXT = '今天天气不错，图书馆里安静又明亮。';

/**
 * 探测用图片：本项目现场生成的 8×8 纯色 PNG（共 74 字节），
 * 满足 imgSecCheck 的格式与尺寸要求（PNG、≤1MB、≤750×1334）。
 * 它不来自任何外部素材，也不包含任何个人信息。
 */
export const PROBE_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGPwmnATK2IYWhIAWn5swZXi+JcAAAAASUVORK5CYII=';
export const PROBE_IMAGE_MIME = 'image/png';

/** 与云函数目录 `config.json` 的 `permissions.openapi` 保持一致（构图测试会核对）。 */
export const DECLARED_OPENAPI: string[] = ['security.msgSecCheck', 'security.imgSecCheck'];

function noteFor(errCode: number): string {
  if (errCode === 0) return wechatErrcodeNote(0);
  const base = wechatErrcodeNote(errCode);
  if (errCode === 48001 || errCode === 48002) {
    return `${base}；未认证小程序出现该码属预期，此时应切第三方审核适配器（AI_SAFETY_PROVIDER=openai/anthropic）`;
  }
  if (errCode === 61010) {
    return `${base}；改用近期访问过小程序的账号发起调用（或从云函数内部带上 openid）后重试`;
  }
  return base;
}

async function runCheck(
  name: string,
  form: string,
  call: () => Promise<unknown>,
  judge: (value: WechatCall) => WechatOutcome,
): Promise<ProbeCheck> {
  const startedAt = Date.now();
  let callResult: WechatCall;
  try {
    callResult = { ok: true, response: await call() };
  } catch (error) {
    callResult = { ok: false, error };
  }
  const outcome = judge(callResult);
  return {
    api: name,
    form,
    errCode: outcome.errCode,
    errMsg: outcome.errMsg,
    verdict: outcome.verdict,
    note: noteFor(outcome.errCode),
    elapsedMs: Date.now() - startedAt,
  };
}

export interface ProbeOptions {
  wechat?: WechatSecurityApi;
  openid?: string;
  /** 环境标识（非密钥）：控制台里读到的当前环境，便于核对探测发生在哪个环境。 */
  env?: string;
  now?: Date;
}

/**
 * 跑一次探测。**不抛异常**：探测本身就是为了发现「接口不可用」，
 * 每个检查各自捕获错误并记录，函数始终返回可读结论。
 */
export async function runProbe(options: ProbeOptions = {}): Promise<ProbeResult> {
  const startedAt = Date.now();
  const now = options.now ?? new Date();
  const openid = typeof options.openid === 'string' ? options.openid : '';
  const form = openid === '' ? 'v1（无 openid）' : 'v2（带 openid）';
  const checks: ProbeCheck[] = [];

  if (options.wechat === undefined) {
    checks.push({
      api: 'cloud.openapi.security',
      form,
      errCode: -1,
      errMsg: '云函数未拿到 cloud.openapi.security',
      verdict: 'error',
      note: '检查 wx-server-sdk 版本与函数目录 config.json 的 permissions.openapi 声明',
      elapsedMs: 0,
    });
  } else {
    const wechat = options.wechat;
    checks.push(await runCheck('security.msgSecCheck', form, () => wechat.msgSecCheck(
      openid === '' ? { content: PROBE_TEXT } : { content: PROBE_TEXT, version: 2, scene: 1, openid },
    ), judgeMsgSecCheck));
    checks.push(await runCheck('security.imgSecCheck', form, () => wechat.imgSecCheck({
      media: { contentType: PROBE_IMAGE_MIME, value: Buffer.from(PROBE_IMAGE_BASE64, 'base64') },
    }), judgeImgSecCheck));
  }

  const textOk = checks.some((check) => check.api === 'security.msgSecCheck' && check.verdict === 'pass');
  const imageOk = checks.some((check) => check.api === 'security.imgSecCheck' && check.verdict === 'pass');
  const recommendedProvider = textOk && imageOk ? 'wechat' : 'openai';
  const conclusion = textOk && imageOk
    ? '微信官方内容安全接口可调用（文本与图片均返回 errcode 0）：保持 AI_SAFETY_PROVIDER=wechat（默认）。'
    : textOk || imageOk
      ? `微信官方内容安全接口部分可用（文本${textOk ? '可用' : '不可用'}、图片${imageOk ? '可用' : '不可用'}）：`
        + '本轮适配器一次只选一个，建议切第三方（AI_SAFETY_PROVIDER=openai 或 anthropic）覆盖文字与图片两条路径。'
      : '微信官方内容安全接口不可用：切第三方审核适配器（AI_SAFETY_PROVIDER=openai 或 anthropic），'
        + '并确认 AI_SAFETY_BASE_URL / AI_SAFETY_API_KEY / AI_SAFETY_MODEL 已配置。';

  const record: ProbeRecord = {
    probedAt: now.toISOString(),
    timeZone: 'Asia/Shanghai（UTC+8）',
    env: options.env ?? '',
    openidPresent: openid !== '',
    declaredOpenApi: DECLARED_OPENAPI.slice(),
    checks,
    conclusion,
    recommendedProvider,
  };
  return {
    ok: textOk && imageOk,
    record,
    conclusion,
    recommendedProvider,
    pasteLine: JSON.stringify(record),
    elapsedMs: Date.now() - startedAt,
  };
}
