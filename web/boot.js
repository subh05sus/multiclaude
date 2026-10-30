// Runs before first paint: apply the saved surface style (Clear / Soft / Solid).
// Until chosen, follow the system's Reduce Transparency setting.
(function () {
  var mode = null;
  try { mode = localStorage.getItem('multiclaude:glass'); } catch (e) {}
  if (!mode) mode = matchMedia('(prefers-reduced-transparency: reduce)').matches ? 'frosted' : 'on';
  document.documentElement.setAttribute('data-glass', mode);
})();
