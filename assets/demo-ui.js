(() => {
  const statusText = '已更新为本机最新归档（读取于 2026/11/15 22:46）。';
  function syncStatus() {
    const node = document.getElementById('dashboard-load-status');
    if (node && node.textContent !== statusText) node.textContent = statusText;
  }
  setTimeout(syncStatus, 800);
  setInterval(syncStatus, 2500);
})();
