# Shared website school year

The school-year dropdown appears under School settings in Profile & Settings. Selecting
a year prepares the change; Save school year saves it at `webSettings/schoolYear`. Teacher header badges,
the manual's printed year, the admin overview subtitle, and the login label listen
for this shared setting. The default is SY 2026–27 until an admin selects a year.

The first change creates the document automatically:

```text
startYear: 2027
endYear: 2028
updatedBy: the signed-in administrator's Firebase UID
updatedAt: Firestore server timestamp
```

This is a website display setting. It does not archive, filter, or move student
records, change lesson IDs, or change mobile app data. No Firebase rules were
changed. Existing Firestore permissions still govern access to the document;
if those permissions are tightened, include this path in the reviewed rules.

The dropdown stays disabled until the setting and an administrator profile linked
to the current UID have loaded. Each save checks that profile again. A failed
save restores the confirmed selection and displays an error. Background label
updates do not open a page-wide loading overlay.
