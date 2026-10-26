Component({
  options: {
    styleIsolation: 'isolated',
  },
  properties: {
    show: { type: Boolean, value: false },
    title: { type: String, value: '' },
    note: { type: String, value: '' },
    error: { type: String, value: '' },
    fields: { type: Array, value: [] },
    submitText: { type: String, value: '确定' },
    cancelText: { type: String, value: '取消' },
    busy: { type: Boolean, value: false },
    /* 传了 dangerText 就在按钮区多一个红色按钮（如「删除商品」），点击触发 danger 事件 */
    dangerText: { type: String, value: '' },
  },
  data: {
    values: {},
  },
  observers: {
    'show, fields': function (show, fields) {
      if (!show) return;
      const values = {};
      (fields || []).forEach((f) => {
        values[f.key] = f.value === null || f.value === undefined ? '' : String(f.value);
      });
      /* 文本输入不逐字 setData（中文输入法会打断候选），值另存在 _values 里 */
      this._values = values;
      this.setData({ values });
    },
  },
  methods: {
    noop() {},

    onInput(e) {
      const key = e.currentTarget.dataset.key;
      if (!this._values) this._values = {};
      this._values[key] = e.detail.value;
    },

    onPicker(e) {
      const key = e.currentTarget.dataset.key;
      const idx = Number(e.detail.value) || 0;
      const field = (this.data.fields || []).filter((f) => f.key === key)[0] || {};
      const val = (field.options || [])[idx] || '';
      if (!this._values) this._values = {};
      this._values[key] = val;
      this.setData({ ['values.' + key]: val });
    },

    onDate(e) {
      const key = e.currentTarget.dataset.key;
      const val = e.detail.value;
      if (!this._values) this._values = {};
      this._values[key] = val;
      this.setData({ ['values.' + key]: val });
    },

    onCancel() {
      if (this.data.busy) return;
      this.triggerEvent('cancel');
    },

    onDanger() {
      if (this.data.busy) return;
      this.triggerEvent('danger');
    },

    onSubmit() {
      if (this.data.busy) return;
      this.triggerEvent('submit', { values: Object.assign({}, this._values || {}) });
    },
  },
});
