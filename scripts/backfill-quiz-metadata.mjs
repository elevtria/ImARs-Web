import { FirestoreAdmin } from "../server/firestore-admin.js";
import { normalizeQuizQuestion } from "../js/quiz-limits.js";

// Dry run by default. Uses only server environment credentials; never exports keys.
export async function backfillQuizMetadata(store, { apply = false, after = "", pageSize = 100, maxPages = 1 } = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error("Choose bounded migration limits.");
  let checked = 0, changed = 0, cursor = after, done = false;
  const invalid = [];
  for (let page = 0; page < maxPages; page++) {
    const rows = await store.query("generatedQuizzes", { after: cursor || undefined, order: [{ field: "__name__", direction: "asc" }], limit: pageSize });
    if (!rows.length) { done = true; break; }
    const writes = [];
    for (const row of rows) {
      checked++;
      const q = row.data;
      if (!Array.isArray(q.questions) || q.questions.length < 1 || q.questions.length > 50 || new Set(q.questions.map(item => item?.id)).size !== q.questions.length ||
          q.questions.some(item => !item?.id || !normalizeQuizQuestion(item, q.type))) { invalid.push(row.id); continue; }
      if (q.questionCount !== q.questions.length) writes.push({ operation: "update", path: "generatedQuizzes/" + row.id, updateTime: row.updateTime, data: { questionCount: q.questions.length } });
    }
    if (apply && writes.length) await store.commit(writes);
    changed += writes.length; cursor = rows.at(-1).id;
    if (rows.length < pageSize) { done = true; break; }
  }
  return { dryRun: !apply, checked, changed, invalid, nextCursor: done ? "" : cursor, done };
}

if (process.argv[1] && import.meta.url === new URL("file:///" + process.argv[1].replace(/\\/g, "/")).href) {
  const argument = name => process.argv.find(item => item.startsWith(name + "="))?.slice(name.length + 1);
  const result = await backfillQuizMetadata(new FirestoreAdmin(process.env), { apply: process.argv.includes("--apply"), after: argument("--after") || "", maxPages: Number(argument("--pages") || 1) });
  console.log(JSON.stringify(result, null, 2));
  if (result.invalid.length) process.exitCode = 1;
}
