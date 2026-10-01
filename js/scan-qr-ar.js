const accountBtn = document.getElementById("accountBtn");
    const accountMenu = document.getElementById("accountMenu");
    accountBtn.onclick = (e) => {
      e.stopPropagation();
      accountMenu.hidden = !accountMenu.hidden;
    };
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".account")) accountMenu.hidden = true;
    });

    const hint = document.getElementById("finderHint");
    document.querySelectorAll(".tabs button").forEach((btn) => {
      btn.onclick = () => {
        document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        hint.textContent = btn.dataset.mode === "ar" ? "Point camera at AR marker" : "Point camera at QR code";
      };
    });

    const camBtn = document.getElementById("camBtn");
    const camera = document.getElementById("camera");
    const viewfinder = document.getElementById("viewfinder");
    const status = document.getElementById("camStatus");
    let stream = null;

    const stopCamera = () => {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null;
      viewfinder.classList.remove("live");
      camBtn.textContent = "Place Camera / Open Device Camera";
    };

    camBtn.onclick = async () => {
      if (stream) { stopCamera(); return; }
      status.style.display = "block";
      status.textContent = "Opening camera…";
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        camera.srcObject = stream;
        viewfinder.classList.add("live");
        camBtn.textContent = "Stop Camera";
        status.textContent = "Camera is on. Align the code inside the frame.";
      } catch (err) {
        status.textContent = "Camera access was blocked. Allow camera permission, or use this page on a device with a camera.";
      }
    };
