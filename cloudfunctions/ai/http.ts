/**
 * 云函数发 HTTP 请求的最小实现。
 *
 * 为什么不用 fetch：云函数运行时是 Nodejs16.13（见 docs/development/cloud/ai.md），
 * 没有全局 fetch；项目也不引入额外依赖（函数只依赖 wx-server-sdk），
 * 因此直接基于 https.request 写一个带**硬超时**的 JSON POST。
 *
 * 超时必须是硬的：`timeout` 选项只处理 socket 空闲，一个发不出去或收不完整的请求
 * 仍然可能挂着；这里额外加一个定时器主动 destroy，保证单次调用有明确的时间边界。
 */
import * as http from 'http';
import * as https from 'https';
import { fail } from './errors';

/** 请求超时：调用方据此给出「模型不可用或超时」这一类可识别失败，而不是无限挂起。 */
export class HttpTimeoutError extends Error {
  constructor(readonly timeoutMs: number, readonly target: string) {
    super(`请求超时（${timeoutMs}ms）：${target}`);
    this.name = 'HttpTimeoutError';
  }
}

/**
 * 通用硬超时：给**不经过 HTTP 层**的异步调用（微信云调用、云存储下载）也用同一条边界。
 * 这些调用同样可能一直不返回，而票面要求「单次调用有明确超时边界」覆盖全部外部调用。
 */
export class TimeoutError extends Error {
  constructor(readonly timeoutMs: number, readonly target: string) {
    super(`调用超时（${timeoutMs}ms）：${target}`);
    this.name = 'TimeoutError';
  }
}

/** 给一个 promise 套上硬超时；超时后立刻以 `TimeoutError` 结束，不等原调用返回。 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, target: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(timeoutMs, target)), timeoutMs);
    // 定时器不应阻止进程退出（本地测试里尤其明显）。
    if (typeof timer.unref === 'function') timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export interface HttpResponse {
  status: number;
  body: string;
}

export interface PostJsonOptions {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

/** 响应体上限：正常返回远小于它；超过说明中转返回了异常内容，及时掐断避免撑爆内存。 */
const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * 是否由超时引起。
 * 除了本文件的两种超时错误，还认 `AiFailure` 上的 `timedOut` 标记（鸭子类型判断，
 * 避免 http → errors 的依赖方向反过来）：模型层把超时收敛成分类失败后，
 * 内容安全层仍然要能识别「这是超时」，而不是当成一般调用失败。
 */
export function isTimeoutError(error: unknown): boolean {
  if (error instanceof HttpTimeoutError || error instanceof TimeoutError) return true;
  return typeof error === 'object' && error !== null && (error as { timedOut?: unknown }).timedOut === true;
}

/** 发一次 JSON POST；只做传输，不做状态码分类（分类在 providers.ts）。 */
export function postJson(options: PostJsonOptions): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    let transport: typeof https | typeof http;
    let parsed: URL;
    try {
      parsed = new URL(options.url);
      transport = parsed.protocol === 'http:' ? http : https;
    } catch {
      fail('internal', `接口地址不是合法 URL：${options.url}`);
    }

    const payload = Buffer.from(options.body, 'utf8');
    const request = transport.request(
      parsed,
      {
        method: 'POST',
        headers: { ...options.headers, 'Content-Type': 'application/json', 'Content-Length': payload.byteLength },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let received = 0;
        response.on('data', (chunk: Buffer) => {
          received += chunk.byteLength;
          if (received > MAX_RESPONSE_BYTES) {
            clearTimeout(timer);
            response.destroy();
            settle(() => reject(new Error(`响应体超过 ${MAX_RESPONSE_BYTES} 字节：${options.url}`)));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          clearTimeout(timer);
          settle(() => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        });
        response.on('error', (error: Error) => {
          clearTimeout(timer);
          settle(() => reject(error));
        });
      },
    );

    let settled = false;
    function settle(action: () => void): void {
      if (settled) return;
      settled = true;
      action();
    }

    const timer = setTimeout(() => {
      request.destroy(new HttpTimeoutError(options.timeoutMs, options.url));
    }, options.timeoutMs);
    // 定时器不应阻止进程退出（本地测试里尤其明显）。
    if (typeof timer.unref === 'function') timer.unref();

    request.on('timeout', () => request.destroy(new HttpTimeoutError(options.timeoutMs, options.url)));
    request.on('error', (error: Error) => {
      clearTimeout(timer);
      settle(() => reject(error));
    });
    request.end(payload);
  });
}
