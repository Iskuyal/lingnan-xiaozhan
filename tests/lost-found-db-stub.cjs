/**
 * 失物招领云函数测试用内存数据库桩。
 *
 * 数据层模块(cloudfunctions/lost-found/posts.ts 等)按依赖注入接收 db,
 * 不 import wx-server-sdk——本桩模拟云数据库集合的增删改查最小子集,
 * 流程测试直接调用数据层,不经过 vm 沙箱(比入口测试更直接)。
 */
'use strict';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 内存集合:支持 add / doc().get/update/remove / where().get/orderBy().get。 */
function createCollection() {
  const rows = [];
  const collection = {
    rows,
    async add({ data }) {
      const record = clone(data);
      record._id = data._id === undefined ? `auto-${rows.length + 1}` : data._id;
      rows.push(record);
      return { _id: record._id };
    },
    doc(id) {
      return {
        async get() {
          const row = rows.find((item) => item._id === id);
          if (row === undefined) {
            const error = new Error(`document.get:fail document does not exist: ${id}`);
            error.errCode = -1;
            throw error;
          }
          return { data: clone(row) };
        },
        async update({ data }) {
          const row = rows.find((item) => item._id === id);
          if (row === undefined) {
            const error = new Error(`document.update:fail document does not exist: ${id}`);
            error.errCode = -1;
            throw error;
          }
          Object.assign(row, clone(data));
          return { stats: { updated: 1 } };
        },
        async remove() {
          const index = rows.findIndex((item) => item._id === id);
          if (index >= 0) rows.splice(index, 1);
          return { stats: { removed: index >= 0 ? 1 : 0 } };
        },
      };
    },
    where(query) {
      const filtered = () => rows.filter((row) =>
        Object.entries(query).every(([key, value]) => row[key] === value));
      return {
        async get() {
          return { data: clone(filtered()) };
        },
        async count() {
          return { total: filtered().length };
        },
        orderBy() {
          return {
            async get() {
              return { data: clone(filtered()) };
            },
          };
        },
      };
    },
  };
  return collection;
}

/** 内存数据库:按集合名分库,测试可直查 rows 断言写入内容。 */
function createDb() {
  const stores = new Map();
  const db = {
    command: { inc: (n) => ({ __inc: n }) },
    collection(name) {
      if (!stores.has(name)) stores.set(name, createCollection());
      return stores.get(name);
    },
  };
  return { db, stores };
}

/** 常用断言辅助:某集合的全部行。 */
function allRows(stores, name) {
  return (stores.get(name) ?? { rows: [] }).rows;
}

module.exports = { createDb, allRows, clone };
