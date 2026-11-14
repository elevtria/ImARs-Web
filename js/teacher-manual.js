const manualDropdowns = Array.from(document.querySelectorAll(".manual-dropdown"));
let beforePrintState;
window.addEventListener("beforeprint", () => {
  if (beforePrintState) return;
  beforePrintState = manualDropdowns.map(dropdown => dropdown.open);
  manualDropdowns.forEach(dropdown => { dropdown.open = true; });
});
window.addEventListener("afterprint", () => {
  if (!beforePrintState) return;
  manualDropdowns.forEach((dropdown, index) => { dropdown.open = beforePrintState[index]; });
  beforePrintState = undefined;
});

// Keep the QR cross-reference and bookmarked headings usable inside collapsed sections.
function revealManualHeading(hash) {
  if (!["#setupHeading", "#prepareHeading", "#syncHeading"].includes(hash)) return;
  const dropdown = document.querySelector(hash)?.closest(".manual-dropdown");
  if (dropdown) dropdown.open = true;
  return dropdown;
}
revealManualHeading(window.location.hash);
window.addEventListener("hashchange", () => revealManualHeading(window.location.hash));
document.querySelectorAll('.manual-link[href^="#"]').forEach(link => {
  link.addEventListener("click", event => {
    const dropdown = revealManualHeading(link.getAttribute("href"));
    if (dropdown) { event.preventDefault(); dropdown.querySelector("summary").focus(); }
  });
});

document.getElementById("printManual").onclick = () => {
  window.print();
};
