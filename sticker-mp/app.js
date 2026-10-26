/* ============================================================
   贴纸进销存 · 微信小程序
   后端：WorkBuddy 云服务（数据库 / 文件存储 / 大模型 / 微信登录）
   ============================================================ */

const { cloud } = require('./utils/cloud');
const db = require('./utils/db');
const { DEFAULT_USD_CNY } = require('./utils/format');
const { describeAuthError } = require('./utils/errors');

const ACTIVE_ORDER_KEY = 'sticker.activeOrder';
const LOGGED_OUT_KEY = 'sticker.loggedOut';
const LOGGED_OUT_MSG = '已退出登录，云端数据需要登录后才能查看';

function wxLogin() {
  return new Promise((resolve, reject) => {
    wx.login({
      success(res) {
        if (res && res.code) resolve(res.code);
        else reject(new Error('微信登录失败：没有取得登录凭证'));
      },
      fail(err) {
        reject(new Error((err && err.errMsg) || '微信登录失败，请重试'));
      },
    });
  });
}

App({
  globalData: {
    cloud,
    rate: DEFAULT_USD_CNY,
    session: null,
    loginError: '',
    /* 用户主动退出后为 true：不再静默微信登录，直到他点「微信一键登录」 */
    loggedOut: false,
    /* 订单页 → 流水页 的「只看该订单」传参 */
    pendingMoveFilter: '',
  },

  onLaunch() {
    /* 退出态要跨进程保留，否则杀掉小程序重开又自动登录了 */
    this.globalData.loggedOut = this.readLoggedOut();
    this.ready = this.startup().catch((err) => {
      this.globalData.loginError = (err && err.message) || '登录失败，请重试';
      throw err;
    });
    /* 页面自己 await 时会拿到 rejection；这里先挂一个处理器，避免控制台报未捕获异常 */
    this.ready.catch(() => {});
  },

  readLoggedOut() {
    try {
      return !!wx.getStorageSync(LOGGED_OUT_KEY);
    } catch (e) {
      return false;
    }
  },

  writeLoggedOut(flag) {
    try {
      if (flag) wx.setStorageSync(LOGGED_OUT_KEY, 1);
      else wx.removeStorageSync(LOGGED_OUT_KEY);
    } catch (e) { /* 存不了只影响下次冷启动，本次仍按内存态处理 */ }
  },

  /* 打开小程序即静默登录：小程序内用微信身份，不需要手机号验证码 */
  async startup() {
    const session = await this.ensureLogin();
    this.globalData.session = session;
    this.globalData.rate = (await db.getRate()) || DEFAULT_USD_CNY;
    this.globalData.loginError = '';
    return true;
  },

  async ensureLogin() {
    /* 用户主动退出过：不静默登录，让各页面停在「已退出登录」门禁上 */
    if (this.globalData.loggedOut) {
      const err = new Error(LOGGED_OUT_MSG);
      err.code = 'LOGGED_OUT';
      throw err;
    }
    if (this._loginPromise) return this._loginPromise;

    this._loginPromise = (async () => {
      const existing = await cloud.auth.getSession();
      if (existing && existing.data) return existing.data;

      const code = await wxLogin();
      const appid = wx.getAccountInfoSync().miniProgram.appId;
      const { data, error } = await cloud.auth.signInWithWechat(code, appid);
      if (error) throw new Error(describeAuthError(error));
      return data;
    })();

    try {
      return await this._loginPromise;
    } catch (err) {
      this._loginPromise = null;   // 允许用户点「重试」再登一次
      throw err;
    }
  },

  waitReady() {
    if (!this.ready) {
      this.ready = this.startup().catch((err) => {
        this.globalData.loginError = (err && err.message) || '登录失败，请重试';
        throw err;
      });
      this.ready.catch(() => {});
    }
    return this.ready;
  },

  retryLogin() {
    /* 页面上的「重试 / 微信一键登录」都是用户主动要登，先解掉退出门禁 */
    this.writeLoggedOut(false);
    this.globalData.loggedOut = false;
    this._loginPromise = null;
    this.globalData.loginError = '';
    this.ready = null;
    return this.waitReady();
  },

  /* 退出登录：清云端会话 + 本地标记 + 残留的出库会话，之后不再自动登录 */
  async logout() {
    let signOutFailed = false;
    try {
      if (cloud.auth && typeof cloud.auth.signOut === 'function') {
        const res = await cloud.auth.signOut();
        if (res && res.error) signOutFailed = true;
      }
    } catch (e) {
      signOutFailed = true;   // 网络不通也要把本地清干净，不然退不出去
    }

    this.writeLoggedOut(true);
    this.globalData.loggedOut = true;
    this.globalData.session = null;
    this.globalData.loginError = LOGGED_OUT_MSG;
    this.globalData.pendingMoveFilter = '';
    this._loginPromise = null;
    this.ready = null;
    /* 「正在为某订单出库」属于上一个人的操作上下文，退出必须清掉 */
    this.setActiveOrder(null);
    return { ok: !signOutFailed };
  },

  setRate(value) {
    this.globalData.rate = Number(value) || DEFAULT_USD_CNY;
  },

  /* 「正在为某订单出库」的会话状态：换页面 / 杀进程都不该丢 */
  getActiveOrder() {
    try {
      const obj = wx.getStorageSync(ACTIVE_ORDER_KEY);
      if (obj && typeof obj.no === 'string' && obj.no.trim()) {
        return {
          no: obj.no.trim(),
          buyerName: typeof obj.buyerName === 'string' ? obj.buyerName.trim() : '',
          startedAt: obj.startedAt || new Date().toISOString(),
          qty: Number(obj.qty) || 0,
          moves: Number(obj.moves) || 0,
          amount: Number(obj.amount) || 0,
        };
      }
    } catch (e) { /* 解析失败按「未在出库中」处理 */ }
    return null;
  },

  setActiveOrder(order) {
    try {
      if (order) wx.setStorageSync(ACTIVE_ORDER_KEY, order);
      else wx.removeStorageSync(ACTIVE_ORDER_KEY);
    } catch (e) { /* 存不了不影响本次使用 */ }
  },
});
