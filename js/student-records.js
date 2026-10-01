const cards = [...document.querySelectorAll(".record")];
    const empty = document.getElementById("emptyState");
    document.getElementById("studentSearch").addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase();
      let shown = 0;
      cards.forEach((card) => {
        const visible = card.dataset.name.includes(q);
        card.classList.toggle("hidden", !visible);
        if (visible) shown += 1;
      });
      empty.style.display = shown ? "none" : "block";
    });
