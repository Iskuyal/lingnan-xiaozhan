/**
 * 云函数发 HTTP 请求的最小实现。
 *
 * 为什么不用 fetch：云函数运行时是 Nodejs16.13（见 docs/cloud-development.md），
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

export function isTimeoutError(error: unknown): boolean {
  return error instanceof HttpTimeoutError;
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
