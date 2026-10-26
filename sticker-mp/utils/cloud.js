/* ============================================================
   云服务客户端（微信小程序形态）
   ------------------------------------------------------------
   小程序没有 Origin，网关按 publishableKey + 微信 Referer 路由，
   所以 endpoint 必须是云环境返回的固定网关，不能换成应用自己的域名。
   ============================================================ */

/* SDK 用 libs/ 下的固化副本（已含 ArrayBuffer 补丁），
   不再走 npm 依赖解析——无论「构建 npm」还是云端发布管道
   重新安装依赖，都不会把补丁冲掉。 */
const sdk = require('../libs/workbuddy-cloud-sdk.miniprogram.js');
const { createDiagnosticWx } = require('./workbuddy-cloud-diagnostics');

/* 启动自检：确认加载的 SDK 是打过 ArrayBuffer 补丁的版本。
   若见警告，执行 node scripts/patch-sdk-arraybuffer.js 后重新编译。 */
if (sdk && sdk.__abPatch) {
  console.log('[sticker] SDK ArrayBuffer 补丁生效（__abPatch=' + sdk.__abPatch + '）');
} else {
  console.warn('[sticker] ⚠️ 运行中的 SDK 未打 ArrayBuffer 补丁！照片上传会失败。请执行 node scripts/patch-sdk-arraybuffer.js 后重新编译');
}

const publicConfig = {
  endpoint: 'https://mp-api.app.workbuddy.host',
  publishableKey: 'wbpk_P4LD2DsyVKW2Oga7Wu0xwL_ZvHnjn6IrGUY79AeAJM8PReEcWD7hzGm',
};

const cloud = sdk.createMiniProgramWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  publishableKey: publicConfig.publishableKey,
  wx: createDiagnosticWx(wx),
});

module.exports = { cloud, publicConfig };
