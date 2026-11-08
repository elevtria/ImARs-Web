// Completion identities deliberately exclude scores and general activity times:
// grading or navigating a lesson must not create another notification.
export function lessonNotifications(studentId, name, section, termId, lessonId, data) {
  return ["pre", "post"].flatMap(kind => {
    const prefix = kind + "Test";
    if (data["is" + (kind === "pre" ? "Pre" : "Post") + "TestCompleted"] !== true) return [];
    const value = data[prefix + "CompletedAt"] || data.completedAt || data.timestamp;
    const date = value?.toDate ? value.toDate() : new Date(value || 0);
    return [{ id: [studentId, termId, lessonId, kind].join(":"), studentId, name, section, termId, lessonId, kind,
      at: Number.isFinite(date.getTime()) ? date.getTime() : 0 }];
  });
}

export function latestNotifications(items) {
  return [...new Map(items.map(item => [item.id, item])).values()]
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)).slice(0, 50);
}

export function reportNotifications(sections) {
  return latestNotifications(sections.flatMap(({ classDoc, students }) => students.flatMap(student => {
    const profile = student.studentDoc.data();
    if (profile.active === false) return [];
    return student.results.flatMap(result => result.lessonsSnap.docs.flatMap(lesson =>
      lessonNotifications(student.studentDoc.id, profile.displayName || profile.fullName || "Student",
        classDoc.data().SectionName || classDoc.id, result.termId, lesson.id, lesson.data())));
  })));
}
