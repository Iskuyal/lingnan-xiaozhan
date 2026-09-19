/**
 * 连接开发者工具自动化端口的公共入口。
 *
 * 三个脚本（`verify-wechat.cjs`、`probe-wechat.cjs`、`smoke-ai.cjs`）都要先连上
 * 由 `cli auto --project <仓库>/dist --auto-port <端口> --trust-project` 打开的模拟器。
 * 连不上时这里给出「该先跑哪条命令」，而不是把 automator 的原始错误直接抛出去——
 * 那句 `check if target project window is opened with automation enabled`
 * 看着像脚本坏了，实际只是前置条件没满足。
 */
const automator = require('miniprogram-automator');

const DEFAULT_PORT = '9420';

/** 前置条件说明：连不上时的可执行指引（端口可被 WECHAT_AUTO_PORT 覆盖）。 */
function automationHint(port) {
  return [
    `连不上开发者工具的自动化端口 ws://127.0.0.1:${port}。`,
    '本脚本要跑在「已开启自动化端口」的开发者工具模拟器上，先在另一个终端执行：',
    `  "<微信开发者工具安装目录>\\cli.bat" auto --project <仓库绝对路径>/dist --auto-port ${port} --trust-project`,
    '  首次会打开开发者工具并加载项目；保持工具窗口开着，再回到仓库根重跑本脚本。',
    `端口不是 ${DEFAULT_PORT} 时用环境变量 WECHAT_AUTO_PORT 指定，两边必须一致。`,
  ].join('\n');
}

/** 连接自动化端口；失败时抛出的错误带上前置条件说明与原始错误。 */
async function connectMini(port = process.env.WECHAT_AUTO_PORT || DEFAULT_PORT) {
  try {
    return await automator.connect({ wsEndpoint: `ws://127.0.0.1:${port}` });
  } catch (error) {
    const original = error !== null && error !== undefined && error.message ? error.message : String(error);
    const wrapped = new Error(`${automationHint(port)}\n\n原始错误：${original}`);
    wrapped.cause = error;
    throw wrapped;
  }
}

module.exports = { connectMini, automationHint, DEFAULT_PORT };
