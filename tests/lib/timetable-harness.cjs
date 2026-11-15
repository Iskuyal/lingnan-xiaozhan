const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const FUNCTION_FILE = path.resolve(__dirname, '../../dist/cloudfunctions/timetable/index.js');

// 只替换云存储、数据库与调用上下文；运行真实的云函数入口、真实解析器与校验逻辑。
function harness(options = {}) {
  const docs = [];
  const collections = new Map([['timetable_courses', docs]]);
  let stagedAdds = 0;
  const storage = new Map();
  const calls = { downloads: [], deletes: [], openid: '' };
  let transactionWrites = 0;
  let inTransaction = false;

  function match(doc, condition) {
    return Object.entries(condition).every(([key, expected]) => {
      if (expected !== null && typeof expected === 'object' && '__neq' in expected) return doc[key] !== expected.__neq;
      if (expected !== null && typeof expected === 'object' && '__lt' in expected) return doc[key] < expected.__lt;
      return doc[key] === expected;
    });
  }

  const db = {
    async runTransaction(callback) {
      const snapshot = JSON.parse(JSON.stringify(docs));
      inTransaction = true;
      transactionWrites = 0;
      let result;
      try { result = await callback(db); }
      catch (error) { docs.splice(0, docs.length, ...snapshot); throw error; }
      finally { inTransaction = false; }
      if (options.loseScopedResponse) { options.loseScopedResponse = false; throw new Error('模拟事务已提交但响应丢失'); }
      return result;
    },
    command: { neq: (value) => ({ __neq: value }), lt: (value) => ({ __lt: value }) },
    collection(name = 'timetable_courses') {
      if (!collections.has(name)) collections.set(name, []);
      const docs = collections.get(name);
      const state = { condition: null, skip: 0, limit: 100 };
      const api = {
        where(condition) { state.condition = condition; return api; },
        skip(value) { state.skip = value; return api; },
        limit(value) { state.limit = value; return api; },
        orderBy() { return api; },
        async get() {
          const rows = docs.filter((doc) => state.condition === null || match(doc, state.condition));
          return { data: rows.slice(state.skip, state.skip + state.limit) };
        },
        async remove() {
          if (options.failOldBatchDelete && state.condition?.staged?.__neq !== undefined) {
            throw new Error('旧批次清理暂时失败');
          }
          if (options.failStagedDelete && typeof state.condition?.batch === 'string') {
            throw new Error('暂存批次清理暂时失败');
          }
          if (options.failCleanupBatch && state.condition?.batch === options.failCleanupBatch) {
            throw new Error('旧批次清理暂时失败');
          }
          const keep = docs.filter((doc) => state.condition === null || !match(doc, state.condition));
          const removed = docs.length - keep.length;
          docs.length = 0;
          docs.push(...keep);
          return { stats: { removed } };
        },
        async update({ data }) {
          let updated = 0;
          for (const doc of docs.filter((item) => state.condition === null || match(item, state.condition))) {
            Object.assign(doc, data);
            updated += 1;
          }
          return { stats: { updated } };
        },
        async add({ data }) {
          if (data.staged === true) {
            stagedAdds += 1;
            if (stagedAdds === options.failStagedAddAt) throw new Error('课程写入暂时失败');
          }
          if (data.name === '并发新增' && options.beforeConcurrentManualAdd) {
            const hook = options.beforeConcurrentManualAdd;
            options.beforeConcurrentManualAdd = null;
            await hook();
          }
          const doc = { _id: `doc-${docs.length + 1}`, ...data };
          docs.push(doc);
          return { _id: doc._id };
        },
        doc(id) {
          return {
            async get() {
              const doc = docs.find((item) => item._id === id);
              if (doc === undefined) throw new Error('document does not exist');
              return { data: doc };
            },
            async set({ data }) {
              // 与实际CloudBase一致：get会返回_id，但set的data禁止携带它。
              if (Object.prototype.hasOwnProperty.call(data, '_id')) throw new Error('document.set:fail -501007 invalid parameters. 不能更新_id的值');
              if (inTransaction && ++transactionWrites === options.failTransactionWriteAt) throw new Error('模拟事务写入失败');
              if (options.failHeadSet && id.startsWith('timetable-head-')) throw new Error('批次提交失败');
              const doc = docs.find((item) => item._id === id);
              if (doc === undefined) docs.push({ _id: id, ...data });
              else Object.assign(doc, data);
              if (id.startsWith('timetable-head-')) await options.afterHeadSet?.(docs, data);
              if (options.failHeadSetAfterWrite && id.startsWith('timetable-head-')) throw new Error('批次提交响应丢失');
              return { stats: { updated: 1 } };
            },
            async update({ data }) {
              if (data.name === '并发修改' && options.beforeConcurrentUpdate) {
                const hook = options.beforeConcurrentUpdate;
                options.beforeConcurrentUpdate = null;
                await hook();
              }
              const doc = docs.find((item) => item._id === id);
              if (doc === undefined) throw new Error('document not exists');
              Object.assign(doc, data);
              return { stats: { updated: 1 } };
            },
            async remove() {
              const index = docs.findIndex((item) => item._id === id);
              if (index < 0) throw new Error('document not exists');
              docs.splice(index, 1);
              return { stats: { removed: 1 } };
            },
          };
        },
      };
      return api;
    },
  };

  const cloud = {
    init() {},
    DYNAMIC_CURRENT_ENV: 'dynamic',
    database: () => db,
    getWXContext: () => ({ OPENID: calls.openid }),
    async downloadFile({ fileID }) {
      calls.downloads.push(fileID);
      if (!storage.has(fileID)) throw new Error('file not found');
      return { fileContent: storage.get(fileID) };
    },
    async deleteFile({ fileList }) {
      calls.deletes.push(...fileList);
      for (const fileID of fileList) {
        if (!storage.has(fileID)) throw new Error('file not found');
        storage.delete(fileID);
      }
      return { fileList: fileList.map((fileID) => ({ fileID, status: 0 })) };
    },
  };

  const realRequire = require('module').createRequire(FUNCTION_FILE);
  const context = {
    exports: {}, Buffer, console, process,
    require(name) {
      if (name === 'wx-server-sdk') return cloud;
      return realRequire(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(FUNCTION_FILE, 'utf8'), context, { filename: FUNCTION_FILE });
  const run = (openid, event) => {
    calls.openid = openid;
    return context.exports.main(event);
  };
  return { run, docs, storage, calls };
}

module.exports = { harness };
