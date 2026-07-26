
async function init() {  
  const dailyOpsDateEl = qs("#daily-ops-date");
  if (dailyOpsDateEl && !dailyOpsDateEl.value)
    dailyOpsDateEl.value = todayIsoDate();

  await loadZips(0);
  await loadRules();
  await loadStatistics();
  initHelpdeskNotifications();
}