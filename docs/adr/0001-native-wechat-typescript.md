# ADR-0001：微信原生小程序与按需引入云开发

日期：2026-09-17。状态：已选定；原生小程序路线已在 P1 实施，云开发已在 P3-1 引入（2026-09-18）。以下保留决策当时的理由和约束。

实施更新：教务账号接入及 P4-A 已随课表改为导入制取消，见 [开发规格](../product/spec.md)。此范围变更不改变本 ADR 的原生框架与云开发选择；下文 P4-A 的表述仅为决策时的历史背景。

## 决策与理由

采用微信原生小程序框架，使用 TypeScript、WXML、WXSS、原生组件及少量自定义组件。项目仅要求微信端，首批页面为简介、列表和课表；直接面向微信页面和 API，减少编译适配层，便于三人团队在微信开发者工具中定位问题。

使用 npm 和提交到版本库的锁文件管理依赖，官方 `miniprogram-api-typings` 提供微信 API 类型。P1 用 TypeScript 编译到微信可运行的 JavaScript，复制 WXML/WXSS/JSON 到构建目录；开发者工具导入该构建目录。CI 与本地使用同一构建命令，避免两套编译结果。

后端选用微信云开发（CloudBase）云函数和文档数据库，在 P3 资讯阶段引入；小程序通过 `wx.cloud` 调用，云函数运行 Node.js，业务代码使用 TypeScript 编译。P1–P2 的已核实公开内容可随包提供，避免首页被云环境开通阻塞。具体 SDK、Node.js 运行时和基础库版本在对应阶段初始化时核实兼容性并锁定，不在尚无工程时编造版本号。

## 方案比较

| 方案 | 适用价值 | 本项目取舍 |
| --- | --- | --- |
| 原生 + TypeScript | 直接使用微信页面、组件与 API，类型约束有利于 AI 协作 | 选定；需学习 WXML/WXSS 和页面生命周期 |
| Taro + React/Vue | 团队已有相应前端经验或需要跨端复用 | 当前无明确跨端需求，也未确认团队有 React/Vue 积累，暂不引入 |
| 原生 + JavaScript | 初始配置更少 | 多人和 AI 修改数据结构时缺少静态类型校验，不选 |

UI 初期不引入整套第三方组件库、全局状态管理库或跨端路由；各功能数据通过本功能的服务模块读取。Node 云函数中处理官网提取与模型调用，微信前端不保存模型密钥。

## 限制与验证

CloudBase 需要实际可用环境、AppID 关联及预算；P3 前完成验证。教务登录是否适合云函数、是否需要其他承载方式，由 P4-A 的实测决定，不预先承诺。云环境不可用时 P1–P2 仍可验收，P3 线上能力保持未完成。

P1 必须通过命令行类型检查与构建，并在微信开发者工具中导入运行；原生页面验证和微信真机验证分开记录。

## 官方依据

- [微信官方 API 类型定义](https://github.com/wechat-miniprogram/api-typings)：TypeScript 类型与安装方式。
- [CloudBase 云函数调用](https://docs.cloudbase.net/cloud-function/how-use)：微信小程序通过 `wx.cloud.callFunction` 调用云函数。
- [微信小程序云函数接入](https://docs.cloudbase.net/recipes/add-cloud-function-wechat-miniprogram)：AppID 与环境关联要求。
- [Taro 组件说明](https://docs.taro.zone/docs/components-desc)：跨框架组件层的工作方式。

上述页面于本轮核查。微信开发框架主文档本轮读取失败，不据此宣称已核查所有平台配置。
