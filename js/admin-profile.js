const profileDialog = document.getElementById("profileDialog");
const profileForm = document.getElementById("profileForm");

document.getElementById("editProfileButton").addEventListener("click", () => profileDialog.showModal());
document.getElementById("closeProfileDialog").addEventListener("click", () => profileDialog.close());
document.getElementById("cancelProfileEdit").addEventListener("click", () => profileDialog.close());

profileForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const values = new FormData(profileForm);
  const name = String(values.get("name")).trim();
  const email = String(values.get("email")).trim();
  const school = String(values.get("school")).trim();
  const department = String(values.get("department")).trim();
  const phone = String(values.get("phone")).trim();
  const initials = name.split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();

  document.getElementById("profileInitials").textContent = initials;
  document.getElementById("profileName").textContent = name;
  document.getElementById("profileSchool").textContent = school;
  document.getElementById("infoName").textContent = name;
  document.getElementById("infoEmail").textContent = email;
  document.getElementById("infoSchool").textContent = school;
  document.getElementById("infoDepartment").textContent = department;
  document.getElementById("infoPhone").textContent = phone || "Not provided";
  profileDialog.close();
});
