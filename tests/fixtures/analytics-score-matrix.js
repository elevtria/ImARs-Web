const doc = (id, data) => ({ id, data: () => data });
export const scoreTerms = ["term_01", "term_02", "term_03"];
export const scoreLessons = ["lesson_01", "lesson_02", "lesson_03", "lesson_04"];
const totals = [[3, 4, 5, 8, 10], [6, 7, 6, 11, 12], [11, 12, 8, 14, 15]];

export function analyticsScoreMatrix() {
  const missing = index => index % 13 === 12;
  const lessons = (term, index) => {
    if (missing(index)) return [];
    const [activity, maximum, preMaximum, post, postMaximum] = totals[term];
    return [
      // Reverse document order to expose accidental positional lesson matching.
      doc("lesson_03", { activityScore: 88, activityTotalQuestions: 100, activityRawScore: null, activityRawMaximum: null,
        preTestScore: 0, preTestTotalQuestions: preMaximum, isPreTestCompleted: false,
        postTestScore: 0, postTestTotalQuestions: postMaximum, isPostTestCompleted: false }),
      doc("lesson_02", { activityScore: 0, activityTotalPoints: 9 + term,
        isPreTestCompleted: true, preTestScore: 0, preTestTotalQuestions: 4 + term,
        isPostTestCompleted: true, postTestScore: 0, postTestTotalQuestions: 11 + term }),
      doc("lesson_01", { activityScore: 88, activityTotalQuestions: 100,
        activityRawScore: index % 25 === 0 ? 0 : activity, activityRawMaximum: maximum,
        isPreTestCompleted: true, preTestScore: index % 2, preTestTotalQuestions: preMaximum,
        isPostTestCompleted: true, postTestScore: post, postTestTotalQuestions: postMaximum })
      // lesson_04 deliberately has no result document.
    ];
  };
  const roster = Array.from({ length: 53 }, (_, index) => ({ classId: "A",
    studentDoc: doc("S" + String(index).padStart(3, "0"), { displayName: "Matrix Student " + String(index).padStart(2, "0") }),
    results: [2, 0, 1].map(term => ({ termId: scoreTerms[term], lessonsSnap: { docs: lessons(term, index) } }))
  }));
  return { roster,
    curriculum: termId => ({ docs: scoreLessons.map((id, index) => doc(id, { title: `${termId} Topic ${index + 1}` })) }),
    expected(termId, index, dash = "—") {
      if (missing(index)) return scoreLessons.map(() => [dash, dash, dash]);
      const term = scoreTerms.indexOf(termId), [activity, maximum, preMaximum, post, postMaximum] = totals[term];
      return [
        [`${index % 25 === 0 ? 0 : activity}/${maximum}`, `${index % 2}/${preMaximum}`, `${post}/${postMaximum}`],
        [`0/${9 + term}`, `0/${4 + term}`, `0/${11 + term}`],
        [dash, dash, dash], [dash, dash, dash]
      ];
    }
  };
}
