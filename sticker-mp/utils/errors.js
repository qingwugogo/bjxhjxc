/* ============================================================
   错误文案：把后端/网络错误翻译成用户看得懂的一句话
   ============================================================ */

function describeDbError(error) {
  if (!error) return '未知错误';
  const code = String((error && error.code) || '');
  const raw = String((error && error.message) || '');
  const has = (n) => code.indexOf(n) >= 0 || raw.indexOf(n) >= 0;
  if (has('23505')) return '产品编码已存在，请换一个';
  if (has('42501')) return '没有权限执行该操作，请确认已登录';
  if (has('42P01')) return '数据表不存在，请重新初始化环境';
  if (/not in domain list|域名.*(白名单|合法)|domain\s*list/i.test(raw)) {
    return '请求域名未加入小程序合法域名白名单，请在小程序后台配置 request 域名';
  }
  if (/network|timeout|abort|request:fail/i.test(raw)) return '网络不稳定，请检查网络后重试';
  return raw || '数据库操作失败';
}

/* 存储写失败时给出可判断原因，而不是只丢一句 "request:fail"。
   顺序很重要：先把「域名没白名单」「没授权」「图太大」这些能自助解决的问题挑出来，
   最后才归到笼统的网络异常，否则真机上最常见的域名拦截会被误报成网络问题 */
function describeStorageError(error) {
  const msg = String((error && error.message) || '');
  const code = String((error && error.code) || '');
  const kind = String((error && error.kind) || '');
  const status = Number((error && error.status) || 0);
  const all = code + ' ' + kind + ' ' + msg;
  if (/not in domain list|domain\s*list|域名.*(白名单|合法)/i.test(all)) {
    return '请求域名未加入小程序合法域名白名单，请在小程序后台配置 request 域名';
  }
  if (code === 'MISSING_CREDENTIALS' || code === 'UNAUTHORIZED' || status === 401 || kind === 'unauthenticated') {
    return '登录状态已失效，请重新进入小程序再试';
  }
  if (/access_denied|未授权|not\s*authorized/i.test(all) || status === 403 || kind === 'permission-denied') {
    return '没有上传权限，请先在 WorkBuddy 里完成小程序的发布绑定';
  }
  if (status === 413 || /too\s*large|payload|exceed/i.test(all)) {
    return '照片体积超出限制，请换一张小一点的图';
  }
  if (!msg || /fail|network|timeout/i.test(msg)) {
    return '网络异常，照片没传上去，请重试';
  }
  return msg + (code ? '（' + code + '）' : '');
}

/* 登录 / 鉴权失败：403「未授权」是配置问题而非网络问题，必须单独说清楚，
   否则用户只会看到一句 access_denied，无从下手。
   SDK 的错误形状是 { kind, message, status, code } —— 403 对应 kind=permission-denied */
function describeAuthError(error) {
  if (!error) return '微信登录失败，请重试';
  const code = String((error && error.code) || '');
  const kind = String((error && error.kind) || '');
  const status = Number((error && error.status) || 0);
  const raw = String((error && error.message) || '');
  const all = code + ' ' + kind + ' ' + raw;
  if (/access_denied|未授权|not\s*authorized/i.test(all) || (status === 403 && kind === 'permission-denied')) {
    return '当前小程序 AppID 还未授权给后端服务，需先在 WorkBuddy 里完成小程序的发布绑定';
  }
  if (/not in domain list|域名.*(白名单|合法)|domain\s*list/i.test(all)) {
    return '请求域名未加入小程序合法域名白名单，请在小程序后台配置 request 域名';
  }
  if (/network|timeout|request:fail|abort/i.test(all)) return '网络不稳定，请检查网络后重试';
  if (status === 401 || kind === 'unauthenticated') return '登录状态已失效，请重新进入小程序';
  return raw || '微信登录失败，请重试';
}

function describeLlmError(err) {
  const code = String((err && err.error && err.error.code) || (err && err.code) || '');
  if (code.indexOf('quota_') === 0) return 'AI 额度不足或触发限流，请稍后再试';
  if (code.indexOf('auth_') === 0) return 'AI 服务鉴权失败，请重新进入小程序再试';
  if (code.indexOf('request_') === 0) return '识别请求参数有误，请换一张照片重试';
  if (code.indexOf('gateway_') === 0 || code.indexOf('model_') === 0) return '模型服务暂时不可用，请重试';
  return '识别失败，请稍后重试';
}

module.exports = { describeDbError, describeStorageError, describeLlmError, describeAuthError };
