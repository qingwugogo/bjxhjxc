Component({
  options: { styleIsolation: 'isolated' },
  properties: {
    card: { type: Object, value: {} },
    showAction: { type: Boolean, value: false },
    actionText: { type: String, value: '录入其他成本' },
  },
  methods: {
    onAction() {
      this.triggerEvent('action', { orderNo: this.data.card.orderNo });
    },
  },
});
