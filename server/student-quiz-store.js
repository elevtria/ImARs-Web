import { FirestoreAdmin, decodeFields } from "./firestore-admin.js";

// This projection is performed by Firestore, before documents reach the API.
export const SUMMARY_FIELDS = ["id", "title", "sectionId", "assignmentScope", "teacherProfileId", "teacherUid", "type",
  "gradingMode", "availability", "availableAt", "createdAt", "schemaVersion", "questionCount"];
export class StudentQuizStore extends FirestoreAdmin {
  async quizPage(context, { limit = 21, after, upper, ids } = {}) {
    const field = (name, op, value) => ({ fieldFilter: { field: { fieldPath: name }, op, value } });
    const filters = ["teacherProfileId", "teacherUid"].map(name => field(name, "EQUAL", { stringValue: context[name] }));
    if (!ids) filters.push(field("sectionId", "IN", { arrayValue: { values: [context.sectionId, ""].map(stringValue => ({ stringValue })) } }));
    if (ids && !ids.length) return [];
    filters.push(ids ? field("__name__", "IN", { arrayValue: { values: ids.map(id => ({ referenceValue: this.name("generatedQuizzes/" + id) })) } })
      : field("availability", "IN", { arrayValue: { values: ["now", "scheduled"].map(stringValue => ({ stringValue })) } }));
    const tuple = value => [{ stringValue: value[0] }, { referenceValue: this.name("generatedQuizzes/" + value[1]) }];
    const rows = await this.request("documents:runQuery", { method: "POST", body: JSON.stringify({
      ...(this.transaction ? { transaction: this.transaction } : {}), structuredQuery: {
        select: { fields: SUMMARY_FIELDS.map(fieldPath => ({ fieldPath })) }, from: [{ collectionId: "generatedQuizzes" }],
        where: { compositeFilter: { op: "AND", filters } },
        orderBy: (ids ? ["__name__"] : ["createdAt", "__name__"]).map(fieldPath => ({ field: { fieldPath }, direction: "DESCENDING" })),
        ...(!ids && (after || upper) ? { startAt: { values: tuple(after || upper), before: !after } } : {}),
        limit: ids ? ids.length : limit
      }
    }) });
    return rows.filter(row => row.document).map(({ document }) => ({ id: document.name.split("/").at(-1),
      data: decodeFields(document.fields), updateTime: document.updateTime }));
  }
}
