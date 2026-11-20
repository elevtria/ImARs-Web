The admin Bug Reports page reads `bugReports` through the authenticated website API.

`ARGraphicsSettingsView.BugReport.cs` is the matching mobile source, also installed in
`C:/Users/Alliona/Imars/Assets/SCRIPTS/ARGraphicsSettingsView.BugReport.cs`. It reuses
`ImarsApiClient` and Firebase sign-in to submit to `/api/bug-reports/submit`.
No Firebase rules change or client database write permission is needed. The server
sets reporter identity, timestamps, and initial status. Repeated delivery attempts
with the same request ID return the existing report.

Build and distribute a new Android app for this connection to reach installed devices.
Older app versions only compose an email; existing email reports are not imported.
Web deployment alone cannot update an installed APK. A copy of the previous local
mobile source was retained in the user's temporary directory before editing.
