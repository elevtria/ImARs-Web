document.getElementById("printManual").onclick = () => {
  window.print();
};

document.getElementById("downloadPdf").onclick = async (event) => {
  const button = event.currentTarget;
  const manual = document.getElementById("manual");
  if (typeof window.html2pdf !== "function") {
    window.alert("PDF download could not load. Check your connection, or use Print Guide and choose Save as PDF.");
    return;
  }

  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    await document.fonts.ready;
    const options = {
      filename: "ImARs-Teacher-Manual.pdf",
      margin: 8,
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: {
        scale: 2,
        useCORS: true,
        windowWidth: 1280,
        scrollX: 0,
        scrollY: 0,
        backgroundColor: "#ffffff",
        ignoreElements: (element) => element.classList?.contains("manual-cover-actions")
      },
      jsPDF: { unit: "mm", format: "a4", orientation: "landscape" },
      pagebreak: { mode: [] },
      enableLinks: false
    };

    // Use the bundled PDF writer, then fit each complete guide sheet on one page.
    const blank = document.createElement("canvas");
    blank.width = 2;
    blank.height = 1;
    const pdf = await window.html2pdf().set(options).from(blank).toPdf().get("pdf");
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = options.margin;
    const sheets = Array.from(manual.querySelectorAll(".manual-sheet"));

    for (const [index, sheet] of sheets.entries()) {
      const copy = sheet.cloneNode(true);
      copy.classList.add("manual-export-sheet");
      copy.querySelector(".manual-cover-actions")?.remove();
      const links = [];
      const worker = window.html2pdf().set({
        ...options,
        html2canvas: {
          ...options.html2canvas,
          onclone: (clonedDocument) => {
            const root = clonedDocument.querySelector(".html2pdf__container");
            const bounds = root.getBoundingClientRect();
            root.querySelectorAll("a[href]").forEach((link) => {
              const rect = link.getBoundingClientRect();
              links.push({ href: link.getAttribute("href"), x: (rect.x - bounds.x) / bounds.width, y: (rect.y - bounds.y) / bounds.height, width: rect.width / bounds.width, height: rect.height / bounds.height });
            });
          }
        }
      }).from(copy).toContainer();
      const container = await worker.get("container");
      container.style.width = "1120px";
      // Anchor the capture so scrollbar/viewport changes cannot crop its right edge.
      container.style.margin = "0";
      container.style.left = "0";
      container.style.right = "auto";
      const canvas = await worker.toCanvas().get("canvas");
      const scale = Math.min((pageWidth - margin * 2) / canvas.width, (pageHeight - margin * 2) / canvas.height);
      const width = canvas.width * scale;
      const height = canvas.height * scale;
      const left = (pageWidth - width) / 2;
      if (index > 0) pdf.addPage();
      pdf.addImage(canvas.toDataURL("image/jpeg", options.image.quality), "JPEG", left, margin, width, height);
      links.forEach((link) => {
        const targetPage = link.href.startsWith("#")
          ? sheets.findIndex((candidate) => candidate.querySelector(link.href)) + 1
          : 0;
        const target = targetPage ? { pageNumber: targetPage } : { url: new URL(link.href, document.baseURI).href };
        pdf.link(left + link.x * width, margin + link.y * height, link.width * width, link.height * height, target);
      });
    }

    pdf.save(options.filename);
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
