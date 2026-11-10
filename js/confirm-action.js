let activePanel;

export function confirmAction({ title, message, confirmLabel, destructive = true }) {
  if (activePanel) return Promise.resolve(false);
  const panel = document.createElement("dialog");
  panel.className = "confirm-panel";
  panel.setAttribute("aria-labelledby", "confirmActionTitle");
  panel.setAttribute("aria-describedby", "confirmActionMessage");
  panel.innerHTML = `
    <form method="dialog" class="modal-card">
      <h3 id="confirmActionTitle"></h3>
      <p id="confirmActionMessage"></p>
      <div class="modal-actions">
        <button type="submit" value="cancel" class="ghost-btn" autofocus>Cancel</button>
        <button type="submit" value="confirm" class="primary-btn"></button>
      </div>
    </form>`;
  panel.querySelector("h3").textContent = title;
  panel.querySelector("p").textContent = message;
  const confirm = panel.querySelector('[value="confirm"]');
  confirm.textContent = confirmLabel;
  confirm.classList.toggle("confirm-danger", destructive);
  document.body.append(panel);
  activePanel = panel;
  return new Promise(resolve => {
    panel.addEventListener("close", () => {
      const accepted = panel.returnValue === "confirm";
      panel.remove();
      activePanel = null;
      resolve(accepted);
    }, { once: true });
    panel.showModal();
  });
}
