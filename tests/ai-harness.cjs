/**
 * AI 云函数的测试夹具：把编译产物装进 vm，替换掉网络、云 SDK 与数据库边界。
 *
 * 做法与 tests/newsSync-flow.test.cjs 一致：**运行真实编译产物与真实入口**，
 * 只替换 https / wx-server-sdk / 数据库，不访问网络、不需要任何密钥。
 */
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const AI_DIST = path.resolve('dist/cloudfunctions/ai');

/** 默认环境变量：测试用的假密钥（不是任何真实凭据）。 */
function defaultEnv() {
  return {
    AI_PROVIDER: 'openai',
    AI_BASE_URL: 'https://relay.example.com/v1',
    AI_API_KEY: 'test-key-000000000000',
    AI_MODEL: 'test-model',
    AI_VISION_MODEL: 'test-vision-model',
    AI_SAFETY_PROVIDER: 'wechat',
    AI_MONTHLY_CAP_YUAN: '50',
  };
}

/**
 * 可脚本化的 https / http 桩。
 * handler(record) 返回：
 * - `{ status, body }`：正常响应；
 * - `{ error }`：请求失败（网络错误）；
 * - `undefined`：永不响应（用于验证超时边界）。
 */
function createHttpStub(handler) {
  const requests = [];
  const emitErrorNextTick = (request, error) => {
    process.nextTick(() => request.emit('error', error));
  };
  const transport = {
    request(url, options, callback) {
      const request = new EventEmitter();
      const record = {
        url: typeof url === 'string' ? url : String(url),
        headers: options && options.headers ? options.headers : {},
        body: '',
        destroyed: false,
        timedOut: false,
      };
      requests.push(record);
      request.destroy = (error) => {
        record.destroyed = true;
        if (error !== undefined) {
          record.timedOut = true;
          emitErrorNextTick(request, error);
        }
      };
      request.end = (payload) => {
        record.body = typeof payload === 'string'
          ? payload
          : Buffer.isBuffer(payload)
            ? payload.toString('utf8')
            : String(payload);
        process.nextTick(() => {
          const outcome = handler(record);
          if (outcome === undefined || outcome === null) return; // 永不响应
          if (outcome.error !== undefined) {
            emitErrorNextTick(request, outcome.error);
            return;
          }
          const response = new EventEmitter();
          response.statusCode = outcome.status;
          response.destroy = () => {};
          callback(response);
          response.emit('data', Buffer.from(outcome.body === undefined ? '' : outcome.body, 'utf8'));
          response.emit('end');
        });
      };
      return request;
    },
  };
  return { transport, requests };
}

/** 原子自增的替身：`{ __inc: n }` 在 update 时累加。 */
function createDbStub(options = {}) {
  const records = [];
  const monthly = options.monthly ? { ...options.monthly } : {};
  class DocumentNotFound extends Error {
    constructor(id) {
      super(`document.get:fail document does not exist: ${id}`);
      this.errCode = -1;
    }
  }
  const applyUpdate = (target, data) => {
    for (const [key, value] of Object.entries(data)) {
      target[key] = value !== null && typeof value === 'object' && typeof value.__inc === 'number'
        ? (typeof target[key] === 'number' ? target[key] : 0) + value.__inc
        : value;
    }
  };
  const db = {
    command: {
      inc(value) {
        return { __inc: value };
      },
    },
    collection(name) {
      if (name === 'ai_usage_records') {
        return {
          async add({ data }) {
            records.push({ _id: `record-${records.length}`, ...data });
          },
        };
      }
      if (name === 'ai_usage_monthly') {
        return {
          doc(id) {
            return {
              async get() {
                // monthlyReadError 用来模拟数据库故障（区别于「文档不存在」）。
                if (options.monthlyReadError !== undefined) throw options.monthlyReadError;
                if (monthly[id] === undefined) throw new DocumentNotFound(id);
                return { data: monthly[id] };
              },
              async set({ data }) {
                monthly[id] = { _id: id, ...data };
              },
              async update({ data }) {
                if (monthly[id] === undefined) throw new DocumentNotFound(id);
                applyUpdate(monthly[id], data);
              },
            };
          },
        };
      }
      throw new Error(`未预期的集合：${name}`);
    },
  };
  return { db, records, monthly };
}

/** wx-server-sdk 桩：只提供 AI 函数用到的部分。 */
function createCloudStub(options = {}) {
  const calls = { msgSecCheck: [], imgSecCheck: [], downloadFile: [] };
  const security = options.security === undefined
    ? undefined
    : {
      msgSecCheck(params) {
        calls.msgSecCheck.push(params);
        return options.security.msgSecCheck(params);
      },
      imgSecCheck(params) {
        calls.imgSecCheck.push(params);
        return options.security.imgSecCheck(params);
      },
    };
  return {
    calls,
    stub: {
      init() {},
      DYNAMIC_CURRENT_ENV: 'dynamic',
      database: () => options.db,
      openapi: security === undefined ? undefined : { security },
      downloadFile: async (params) => {
        calls.downloadFile.push(params);
        if (options.downloadFile === undefined) throw new Error('未提供 downloadFile 桩');
        return options.downloadFile(params);
      },
      getWXContext: () => (options.openid === undefined ? {} : { OPENID: options.openid }),
    },
  };
}

/**
 * 编译产物源码缓存。
 *
 * 为什么要缓存 + 重试：`node --test tests/*.test.cjs` 会并行跑各测试文件，而
 * tests/pages.test.cjs 里有一个测试会调用 scripts/build.mjs 重建 dist（会先清空产物目录）。
 * 那个窗口里读 dist 会拿到 ENOENT——那是「另一个测试正在重建」，不是 AI 函数没有产出。
 * 这里把读到的源码缓存下来，并在目录被清空时等重建完成再读。
 */
const sourceCache = new Map();

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readModuleSource(filename) {
  if (sourceCache.has(filename)) return sourceCache.get(filename);
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const source = fs.readFileSync(filename, 'utf8');
      sourceCache.set(filename, source);
      return source;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      sleepSync(200);
    }
  }
}

/**
 * 把 dist/cloudfunctions/ai 下的模块装进同一个 vm 上下文，
 * 相对引用按文件名解析（编译产物的相对引用都带 ./）。
 */
function createModuleLoader(context) {
  const cache = new Map();
  function load(fileName) {
    const filename = path.join(AI_DIST, fileName);
    if (cache.has(filename)) return cache.get(filename).exports;
    const moduleObject = { exports: {} };
    cache.set(filename, moduleObject);
    const sandbox = {
      module: moduleObject,
      exports: moduleObject.exports,
      Buffer, URL, console, process: context.process,
      setTimeout, clearTimeout,
      require(specifier) {
        if (specifier === 'wx-server-sdk') return context.cloud;
        if (specifier === 'https' || specifier === 'http') return context.http;
        if (specifier.startsWith('./') || specifier.startsWith('../')) {
          const target = specifier.startsWith('./') ? `${specifier.slice(2)}.js` : `${specifier.slice(3)}.js`;
          return load(target);
        }
        throw new Error(`测试桩未覆盖的依赖：${specifier}`);
      },
    };
    vm.runInNewContext(readModuleSource(filename), sandbox, { filename });
    return moduleObject.exports;
  }
  return load;
}

/**
 * 组装一次测试：返回入口与可观察的桩。
 * options.env 覆盖环境变量；options.respond 定制模型/审核接口响应；
 * options.security 定制微信云调用；options.monthly 预置月度用量文档。
 */
function createHarness(options = {}) {
  const env = { ...defaultEnv(), ...(options.env || {}) };
  const processStub = { env };
  const { transport, requests } = createHttpStub(options.respond || (() => ({ status: 200, body: '{}' })));
  const { db, records, monthly } = createDbStub({ monthly: options.monthly, monthlyReadError: options.monthlyReadError });
  const cloudBox = createCloudStub({ db, security: options.security, openid: options.openid, downloadFile: options.downloadFile });
  const load = createModuleLoader({ process: processStub, cloud: cloudBox.stub, http: transport });
  const entry = load('index.js');
  return {
    main: entry.main,
    load,
    env,
    http: requests,
    records,
    monthly,
    cloud: cloudBox.calls,
  };
}

/** 默认的 OpenAI 兼容成功响应。 */
function openAiTextResponse(text, usage) {
  return {
    status: 200,
    body: JSON.stringify({
      choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: usage === undefined
        ? { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
        : usage,
    }),
  };
}

/** 当前东八区月份（与云函数记账口径一致）。 */
function currentMonth() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7);
}

module.exports = {
  AI_DIST,
  createHarness,
  openAiTextResponse,
  currentMonth,
  defaultEnv,
  readTextFile: readModuleSource,
};
