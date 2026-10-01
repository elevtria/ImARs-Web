const cards = [...document.querySelectorAll(".student-card")];
    const empty = document.getElementById("emptyState");
    const search = document.getElementById("studentSearch");
    const sectionFilter = document.getElementById("sectionFilter");

    const filterStudents = () => {
      const q = search.value.trim().toLowerCase();
      const section = sectionFilter.value;
      let shown = 0;
      cards.forEach((card) => {
        const matchName = card.dataset.name.includes(q);
        const matchSection = section === "all" || card.dataset.section === section;
        const visible = matchName && matchSection;
        card.classList.toggle("hidden", !visible);
        if (visible) shown += 1;
      });
      empty.style.display = shown ? "none" : "block";
    };

    search.addEventListener("input", filterStudents);
    sectionFilter.addEventListener("change", filterStudents);
