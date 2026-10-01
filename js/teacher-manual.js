const openChapters = () => {
  document.querySelectorAll(".chapter").forEach((el) => {
    el.open = true;
  });
};

document.getElementById("printManual").onclick = () => {
  openChapters();
  window.print();
};

document.getElementById("downloadPdf").onclick = async (event) => {
  const button = event.currentTarget;
  const manual = document.getElementById("manual");
  if (typeof window.html2pdf !== "function") {
    window.alert("PDF download could not load. Check your internet connection and try again.");
    return;
  }

  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    await window.html2pdf().set({
      filename: "ImARs-Teacher-Manual.pdf",
      margin: 8,
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: {
        scale: 2,
        useCORS: true,
        backgroundColor: "#ffffff",
        ignoreElements: (element) => element.classList?.contains("manual-cover-actions")
      },
      jsPDF: { unit: "mm", format: "a4", orientation: "landscape" },
      pagebreak: { mode: ["css", "legacy"], after: ".manual-sheet:not(:last-child)" }
    }).from(manual).save();
  } catch (error) {
    console.error("Teacher manual PDF download failed:", error);
    window.alert("The PDF could not be created. Please try again.");
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
};

document.getElementById("helpBtn").onclick = () => {
  document.querySelector(".hero").scrollIntoView({ behavior: "smooth" });
};
