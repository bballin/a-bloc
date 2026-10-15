(() => {
  const STORAGE_KEY = 'strava-helper-distance-unit';

  function getUnit() {
    return localStorage.getItem(STORAGE_KEY) === 'mi' ? 'mi' : 'km';
  }

  function formatDistance(meters, compactMetric) {
    const distance = Number(meters);
    if (!Number.isFinite(distance)) return '';
    if (getUnit() === 'mi') return `${(distance / 1609.344).toFixed(2)} mi`;
    if (compactMetric && distance < 1000) return `${Math.round(distance)} m`;
    return `${(distance / 1000).toFixed(2)} km`;
  }

  function refreshDistances(root = document) {
    if (root.matches && root.matches('[data-distance-meters]')) {
      root.textContent = formatDistance(root.dataset.distanceMeters, root.dataset.compactMetric === 'true');
    }
    root.querySelectorAll?.('[data-distance-meters]').forEach(element => {
      element.textContent = formatDistance(element.dataset.distanceMeters, element.dataset.compactMetric === 'true');
    });
  }

  function updateControls() {
    const unit = getUnit();
    document.querySelectorAll('[data-unit]').forEach(button => {
      button.setAttribute('aria-pressed', button.dataset.unit === unit ? 'true' : 'false');
    });
  }

  document.querySelectorAll('[data-unit]').forEach(button => {
    button.addEventListener('click', () => {
      localStorage.setItem(STORAGE_KEY, button.dataset.unit);
      updateControls();
      refreshDistances();
    });
  });

  window.addEventListener('storage', event => {
    if (event.key === STORAGE_KEY) {
      updateControls();
      refreshDistances();
    }
  });

  updateControls();
  refreshDistances();
  new MutationObserver(records => {
    records.forEach(record => record.addedNodes.forEach(node => {
      if (node.nodeType === Node.ELEMENT_NODE) refreshDistances(node);
    }));
  }).observe(document.body, { childList: true, subtree: true });

  window.distanceUnits = { formatDistance, getUnit };
})();
