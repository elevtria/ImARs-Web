const sectionSelect = document.getElementById("sectionSelect");
    const counts = { "Grade 8 – Malinao": 6, "Grade 8 – Sampaguita": 0 };
    sectionSelect.addEventListener("change", () => {
      document.getElementById("sectionName").textContent = sectionSelect.value;
      document.getElementById("existingCount").textContent = `(${counts[sectionSelect.value]} existing students)`;
    });

    const csv = "Student Name,Section,LRN,Email\nAna Cruz,Grade 8 – Malinao,123456789012,ana@school.edu\n";
    const download = (name, type, text) => {
      const blob = new Blob([text], { type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    };
    document.getElementById("dlCsv").onclick = () => download("student-batch-template.csv", "text/csv;charset=utf-8", csv);
    document.getElementById("dlXlsx").onclick = () => {
      const xml = `<?xml version="1.0"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="Students"><Table>
  <Row><Cell><Data ss:Type="String">Student Name</Data></Cell><Cell><Data ss:Type="String">Section</Data></Cell><Cell><Data ss:Type="String">LRN</Data></Cell><Cell><Data ss:Type="String">Email</Data></Cell></Row>
  <Row><Cell><Data ss:Type="String">Ana Cruz</Data></Cell><Cell><Data ss:Type="String">Grade 8 – Malinao</Data></Cell><Cell><Data ss:Type="String">123456789012</Data></Cell><Cell><Data ss:Type="String">ana@school.edu</Data></Cell></Row>
 </Table></Worksheet>
</Workbook>`;
      download("student-batch-template.xls", "application/vnd.ms-excel", xml);
    };

    const fileInput = document.getElementById("fileInput");
    const dropZone = document.getElementById("dropZone");
    const browseBtn = document.getElementById("browseBtn");
    const openPicker = () => fileInput.click();
    browseBtn.onclick = (e) => { e.stopPropagation(); openPicker(); };
    dropZone.onclick = openPicker;
    dropZone.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(); } };

    ["dragenter", "dragover"].forEach((ev) => {
      dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add("drag"); });
    });
    ["dragleave", "drop"].forEach((ev) => {
      dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove("drag"); });
    });
    dropZone.addEventListener("drop", (e) => {
      const file = e.dataTransfer.files[0];
      if (file) showFile(file);
    });
    fileInput.addEventListener("change", () => {
      if (fileInput.files[0]) showFile(fileInput.files[0]);
    });

    function showFile(file) {
      document.getElementById("dropTitle").textContent = file.name;
      document.getElementById("dropHint").textContent = "Ready to import · click Browse File to choose another";
    }
