// Run locally with IMARS_WEB_MAINTENANCE_KEY in your environment, never as a URL
// parameter or command-line argument. This script never prints the key.
const identifier = String(process.argv[2] || "").trim().toUpperCase();
if (!/^[A-Z0-9_-]{1,64}$/.test(identifier) || !process.env.IMARS_WEB_MAINTENANCE_KEY) {
  console.error("Set IMARS_WEB_MAINTENANCE_KEY, then run: node scripts/unlock-web-login.mjs TEACH1000");
  process.exitCode = 1;
} else {
  try {
    const response = await fetch("https://imars-web.pages.dev/api/web-auth/unlock", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.IMARS_WEB_MAINTENANCE_KEY}` },
      body: JSON.stringify({ identifier }), signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error("Unlock was refused. Check the account ID, maintenance key, and deployed configuration.");
    console.log(`Web login restored for ${identifier}. Mobile access is unchanged.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
