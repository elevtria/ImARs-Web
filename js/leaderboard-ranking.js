export function rankStudents(students, sectionId = "") {
  const names = new Intl.Collator("en", { sensitivity: "base", numeric: true });
  const rows = students.filter(student => !sectionId || student.classId === sectionId)
    .map(student => ({ ...student }));
  rows.sort((first, second) => second.points - first.points ||
    names.compare(first.name, second.name) || names.compare(first.id, second.id));
  let rank = 0;
  return rows.map((student, index) => {
    if (index === 0 || student.points !== rows[index - 1].points) rank++;
    return { ...student, rank };
  });
}
