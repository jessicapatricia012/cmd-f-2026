// MediaPipe global bootstrap for solution loader scripts.
// Must run before *_solution_* loader files.
(() => {
  // Re-injection-safe bootstrap (no top-level const redeclarations).
  if (window.__afkMediapipeBootstrapReady) return;

  const runtimeBase = (() => {
    try {
      return chrome.runtime.getURL("");
    } catch {
      return "";
    }
  })();

  // eslint-disable-next-line no-var
  var afkLocateFile = (f) => `${runtimeBase}lib/mediapipe/${f}`;

  // Top-level `var` so later scripts can resolve the identifier directly.
  // eslint-disable-next-line no-var
  var createMediapipeSolutionsPackedAssets =
    (typeof window.createMediapipeSolutionsPackedAssets !== "undefined" &&
     ["object", "function"].includes(typeof window.createMediapipeSolutionsPackedAssets))
      ? window.createMediapipeSolutionsPackedAssets
      : {};

  // eslint-disable-next-line no-var
  var createMediapipeSolutionsWasm =
    (typeof window.createMediapipeSolutionsWasm !== "undefined" &&
     ["object", "function"].includes(typeof window.createMediapipeSolutionsWasm))
      ? window.createMediapipeSolutionsWasm
      : {};

  createMediapipeSolutionsPackedAssets.locateFile = afkLocateFile;
  createMediapipeSolutionsWasm.locateFile = afkLocateFile;
  window.createMediapipeSolutionsPackedAssets = createMediapipeSolutionsPackedAssets;
  window.createMediapipeSolutionsWasm = createMediapipeSolutionsWasm;
  window.__afkMediapipeBootstrapReady = true;
})();
