const menuButton = document.getElementById("adminMenuButton");
const drawer = document.getElementById("adminNavigation");
const closeButton = document.getElementById("adminDrawerClose");

function setDrawerOpen(open) {
  drawer.classList.toggle("open", open);
  drawer.setAttribute("aria-hidden", String(!open));
  menuButton.setAttribute("aria-expanded", String(open));
}

menuButton.addEventListener("click", () => {
  setDrawerOpen(!drawer.classList.contains("open"));
});
closeButton.addEventListener("click", () => setDrawerOpen(false));
drawer.addEventListener("click", (event) => {
  if (event.target === drawer) setDrawerOpen(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setDrawerOpen(false);
});
