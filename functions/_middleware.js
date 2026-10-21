import { protectWebsite } from "../server/web-auth.js";

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://cdn.tailwindcss.com https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js",
  "script-src-attr 'none'",
  // Existing charts, the Tailwind runtime, and PDF export create inline styles.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com",
  "frame-src 'self'",
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'"
].join("; ");

export async function onRequest(context) {
  const response = await protectWebsite(context);
  const secured = new Response(response.body, response);
  secured.headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  secured.headers.set("X-Content-Type-Options", "nosniff");
  secured.headers.set("X-Frame-Options", "DENY");
  secured.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  secured.headers.set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
  if (secured.headers.get("Content-Type")?.includes("text/html")) secured.headers.set("Cache-Control", "private, no-store");
  return secured;
}
