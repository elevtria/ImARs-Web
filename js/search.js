export function normalizeSearch(value) {
  return String(value ?? "").normalize("NFC").toLowerCase()
    .replace(/[‘’ʼ]/gu, "'").replace(/[‐‑‒–—−]/gu, "-")
    .replace(/\./gu, "").trim().replace(/\s+/gu, " ");
}

export function personSearchText(id, data = {}) {
  return [id, data.schoolId, data.name, data.displayName, data.fullName,
    [data.firstName, data.middleName || data.middleInitial, data.lastName].filter(Boolean).join(" ")]
    .filter(Boolean).join(" ");
}

export function matchesSearch(query, ...fields) {
  const text = normalizeSearch(fields.filter(value => value != null).join(" "));
  return normalizeSearch(query).split(" ").every(term => text.includes(term));
}
