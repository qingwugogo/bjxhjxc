/* ============================================================
   SDK 补丁：让 createMiniProgramFetch 支持 ArrayBuffer body
   ------------------------------------------------------------
   背景：@tencent-ai/workbuddy-cloud-sdk 的 miniprogram 适配层
   只接受字符串 body，照片上传传 ArrayBuffer 会被它直接抛错
   「暂不支持非字符串 body（ArrayBuffer/FormData 待补）」。
   微信 wx.request 本身支持 ArrayBuffer，这里放行即可。

   同时打两处：
   1. node_modules/.../miniprogram_dist/miniprogram.js —— 构建源，
      打上后「构建 npm」产出的新产物自动带补丁；
   2. miniprogram_npm/.../miniprogram.js —— 构建产物，运行时实际加载。

   并在导出对象上附加 __abPatch 版本标记，
   utils/cloud.js 启动时会自检并打印补丁是否生效。

   用法：安装/更新依赖或「构建 npm」后重跑一次
     node scripts/patch-sdk-arraybuffer.js
   ============================================================ */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'node_modules', '@tencent-ai', 'workbuddy-cloud-sdk', 'miniprogram_dist', 'miniprogram.js'),
  path.join(ROOT, 'miniprogram_npm', '@tencent-ai', 'workbuddy-cloud-sdk', 'miniprogram.js'),
  /* utils/cloud.js 实际引用的固化副本（ immune to 构建 npm / 云端发布重建依赖）。
     升级 SDK 时：先重新构建 npm，再从 miniprogram_npm 拷贝覆盖本文件，然后重跑本脚本。 */
  path.join(ROOT, 'libs', 'workbuddy-cloud-sdk.miniprogram.js'),
];

const OLD_SEG = 'else if((n==null?void 0:n.body)!==void 0&&(n==null?void 0:n.body)!==null)throw new Error("createMiniProgramFetch: \\u6682\\u4E0D\\u652F\\u6301\\u975E\\u5B57\\u7B26\\u4E32 body\\uFF08ArrayBuffer/FormData \\u5F85\\u8865\\uFF09\\u3002");';

const NEW_SEG = 'else if(n!=null&&n.body!=null&&(n.body instanceof ArrayBuffer||ArrayBuffer.isView(n.body)))l=n.body;' + OLD_SEG;

const MARKER = 'v2';
const MARKER_SEG = 'try{module.exports.__abPatch="' + MARKER + '"}catch(e){}';

let touched = 0;
let failed = false;

for (const TARGET of TARGETS) {
  if (!fs.existsSync(TARGET)) {
    console.log('[跳过] 未找到（可能尚未构建 npm）：' + TARGET);
    continue;
  }
  let src = fs.readFileSync(TARGET, 'utf8');
  let changed = false;

  /* 1) body 分支补丁 */
  if (src.indexOf(NEW_SEG) < 0) {
    const count = src.split(OLD_SEG).length - 1;
    if (count !== 1) {
      console.error('[失败] SDK 源码与预期不一致（匹配到 ' + count + ' 处），请人工核对新版本后更新本脚本：' + TARGET);
      failed = true;
      continue;
    }
    src = src.replace(OLD_SEG, NEW_SEG);
    changed = true;
  }

  /* 2) 运行时标记（导出对象附 __abPatch） */
  if (src.indexOf(MARKER_SEG) < 0) {
    src = src.replace(/\s*$/, '') + '\n' + MARKER_SEG + '\n';
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(TARGET, src);
    console.log('[补丁完成] ' + path.relative(ROOT, TARGET));
  } else {
    console.log('[已是补丁版] ' + path.relative(ROOT, TARGET));
  }
  touched++;
}

if (touched > 0 && !failed) {
  console.log('createMiniProgramFetch 已支持 ArrayBuffer body（共处理 ' + touched + '/' + TARGETS.length + ' 个文件，标记 __abPatch=' + MARKER + '）');
}
