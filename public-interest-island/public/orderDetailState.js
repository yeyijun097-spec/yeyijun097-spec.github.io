(function (global, factory) {
  const api = factory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  if (global) {
    global.OrderDetailState = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function toggleOrderDetail(state, index) {
    if (state.activeOrderIndex === index) {
      return { activeOrderIndex: index, detailExpanded: !state.detailExpanded };
    }

    return { activeOrderIndex: index, detailExpanded: true };
  }

  function getOrderDetailAccessibility(state, index) {
    return {
      expanded: String(state.activeOrderIndex === index && state.detailExpanded),
      controls: "order-detail-panel"
    };
  }

  return { toggleOrderDetail, getOrderDetailAccessibility };
});
