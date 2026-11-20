// Load the illustration only when requested; opening help never starts the webcam.
const dialog = document.getElementById("arScanGuide");
const trigger = document.getElementById("openARScanGuide");
const image = document.getElementById("arScanGuideImage");
const motionButton = document.getElementById("toggleARScanGuideMotion");
const error = document.getElementById("arScanGuideError");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const animation = "/assets/guides/ImARs-Scan-Tutorial.gif";
const poster = "/assets/guides/ImARs-Scan-Tutorial-Still.png";
let still = reducedMotion.matches, replay = 0;

function showFrame() {
  image.hidden = false;
  error.hidden = true;
  image.src = still ? poster : `${animation}?replay=${++replay}`;
  image.alt = still ? "Illustration of a laptop webcam and printed ImARs flashcard." : "Animated guide to showing an ImARs flashcard to a laptop webcam.";
  motionButton.textContent = still ? "Play animation" : "Show still image";
}
function closeGuide() { if (dialog.open) dialog.close(); }

trigger.addEventListener("click", () => {
  if (dialog.open) return;
  still = reducedMotion.matches;
  showFrame();
  dialog.showModal();
});
document.getElementById("closeARScanGuide").addEventListener("click", closeGuide);
document.getElementById("finishARScanGuide").addEventListener("click", closeGuide);
document.getElementById("replayARScanGuide").addEventListener("click", () => { still = false; showFrame(); });
motionButton.addEventListener("click", () => { still = !still; showFrame(); });
dialog.addEventListener("click", event => { if (event.target === dialog) closeGuide(); });
dialog.addEventListener("keydown", event => { if (event.key === "Escape") event.stopPropagation(); });
dialog.addEventListener("close", () => image.removeAttribute("src"));
image.addEventListener("error", () => { image.hidden = true; error.hidden = false; });
reducedMotion.addEventListener("change", () => { if (dialog.open && reducedMotion.matches) { still = true; showFrame(); } });
window.addEventListener("pagehide", closeGuide);
window.addEventListener("imars-session-ended", closeGuide);
