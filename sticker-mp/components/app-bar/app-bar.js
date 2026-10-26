const db = require('../../utils/db');
const { describeDbError } = require('../../utils/errors');

Component({
  options: {
    styleIsolation: 'isolated',
  },
  properties: {
    title: { type: String, value: '贴纸进销存' },
    subtitle: { type: String, value: '' },
    rate: { type: String, value: '7.20' },
    showLogout: { type: Boolean, value: true },
  },
  data: {
    showRate: false,
    rateInput: '',
    rateError: '',
    saving: false,
  },
  methods: {
    noop() {},

    /* 汇率：整站只有一个，存在云端 app_settings，换设备也一致 */
    openRate() {
      this.setData({ showRate: true, rateInput: this.data.rate, rateError: '' });
    },

    closeRate() {
      if (this.data.saving) return;
      this.setData({ showRate: false });
    },

    onRateInput(e) {
      this.setData({ rateInput: e.detail.value });
    },

    async saveRate() {
      const app = getApp();
      const v = Number(this.data.rateInput);
      if (!Number.isFinite(v) || v <= 0) {
        this.setData({ rateError: '请填写大于 0 的汇率' });
        return;
      }
      this.setData({ saving: true, rateError: '' });
      try {
        const res = await db.saveRate(v);
        if (res.error) {
          this.setData({ rateError: describeDbError(res.error) });
          return;
        }
        app.setRate(v);
        this.setData({ showRate: false });
        this.triggerEvent('ratechange', { rate: v });
        wx.showToast({ title: '汇率已更新', icon: 'success' });
      } catch (err) {
        this.setData({ rateError: (err && err.message) || '保存失败，请重试' });
      } finally {
        this.setData({ saving: false });
      }
    },

    onLogout() {
      const order = getApp().getActiveOrder();
      wx.showModal({
        title: '退出登录',
        content: order
          ? '当前有未完成的出库（订单 ' + order.no + '），退出会结束这个出库会话。退出后需要点「微信一键登录」才能再查看云端数据，确定退出？'
          : '退出后会清掉本机登录状态，需要点「微信一键登录」才能再查看云端数据；云端数据本身不受影响。',
        confirmText: '退出',
        confirmColor: '#dc2626',
        success: (res) => {
          if (!res.confirm) return;
          this.doLogout();
        },
      });
    },

    async doLogout() {
      const app = getApp();
      wx.showLoading({ title: '正在退出…', mask: true });
      try {
        await app.logout();
      } finally {
        wx.hideLoading();
        /* reLaunch 到建档页，让所有页面实例重建，统一落到「已退出登录」门禁；
           个别基础库对 tabBar 页面走 reLaunch 会失败，回退 switchTab */
        wx.reLaunch({
          url: '/pages/create/create',
          fail: () => wx.switchTab({ url: '/pages/create/create' }),
        });
      }
    },
  },
});
