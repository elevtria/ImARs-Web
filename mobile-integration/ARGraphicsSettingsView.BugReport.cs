using System;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

public sealed partial class ARGraphicsSettingsView
{
    static readonly ImarsApiClient BugReportApi = new ImarsApiClient(ImarsApiClient.BackendOrigin + "/api/bug-reports", 20);
    Button sendReportButton;
    bool sendingReport;
    string pendingReportFingerprint, pendingReportId;
    [Serializable] sealed class BugReportSubmission
    {
        public string requestId, category, issue, description, appVersion, platform, scene;
    }
    [Serializable] sealed class BugReportAcknowledgement { public bool ok; public string id; }
    static readonly string[] BugCategories =
    {
        "Choose an issue", "Sign-in or account", "AR camera or scanning", "Lesson or activity",
        "Quiz, score, or progress", "Sound or display", "Slow, frozen, or crashed",
        "Loading or connection", "Other"
    };
    static int OtherCategory => BugCategories.Length - 1;
    static readonly Vector2 BugPanelSize = new Vector2(880, 980);
    Button bugReportEntry;
    RectTransform bugReportOverlay, bugReportPanel, bugReportForm, bugReportFaq;
    TMP_Dropdown bugCategory;
    TMP_InputField otherIssue, explanation;
    TMP_Text otherLabel, explanationLabel, reportStatus;

    void BuildBugReportEntry(Button template, RectTransform previousRow)
    {
        var clone = Instantiate(template.gameObject, transform);
        clone.name = "Bug Report";
        ((RectTransform)clone.transform).anchoredPosition = previousRow.anchoredPosition + new Vector2(0, -160);
        bugReportEntry = clone.GetComponent<Button>();
        bugReportEntry.onClick = new Button.ButtonClickedEvent();
        bugReportEntry.onClick.AddListener(OpenBugReport);
        foreach (var label in clone.GetComponentsInChildren<TMP_Text>(true))
        {
            label.text = "Bug Report";
            label.fontSize = 40;
        }
        SetEntryColor(bugReportEntry, new Color32(167, 222, 237, 255));
        clone.SetActive(true);
    }

    void OpenBugReport()
    {
        if (bugReportOverlay == null) BuildBugReport();
        ShowBugReportFaq();
        bugReportOverlay.SetAsLastSibling();
        bugReportOverlay.gameObject.SetActive(true);
        UpdateBugReport();
    }

    void CloseBugReport()
    {
        bugCategory.Hide();
        bugReportOverlay.gameObject.SetActive(false);
        bugReportEntry.Select();
    }

    void ShowBugReportFaq()
    {
        bugCategory.Hide();
        bugReportForm.gameObject.SetActive(false);
        bugReportFaq.gameObject.SetActive(true);
    }

    void UpdateBugReport()
    {
        if (bugReportOverlay == null || !bugReportOverlay.gameObject.activeSelf ||
            Screen.width <= 0 || Screen.height <= 0) return;
        var bounds = ((RectTransform)transform).rect.size;
        var safe = Screen.safeArea;
        var safeSize = new Vector2(bounds.x * safe.width / Screen.width, bounds.y * safe.height / Screen.height);
        var scale = Mathf.Min(1, (safeSize.x - 40) / BugPanelSize.x, (safeSize.y - 48) / BugPanelSize.y);
        bugReportPanel.localScale = Vector3.one * Mathf.Max(.01f, scale);
        bugReportPanel.anchoredPosition = new Vector2(
            (safe.center.x / Screen.width - .5f) * bounds.x,
            (safe.center.y / Screen.height - .5f) * bounds.y);
        if (Input.GetKeyDown(KeyCode.Escape) && !bugCategory.IsExpanded &&
            !otherIssue.isFocused && !explanation.isFocused)
        {
            if (bugReportForm.gameObject.activeSelf) ShowBugReportFaq();
            else CloseBugReport();
        }
    }

    void BuildBugReport()
    {
        bugReportOverlay = Rect("Bug report overlay", transform);
        Stretch(bugReportOverlay);
        bugReportOverlay.gameObject.AddComponent<Image>().color = new Color(.04f, .10f, .18f, .6f);
        bugReportPanel = Rect("Bug report form", bugReportOverlay);
        bugReportPanel.sizeDelta = BugPanelSize;
        var paper = bugReportPanel.gameObject.AddComponent<TutorialRoundedBox>();
        paper.radius = 38;
        paper.color = new Color32(237, 247, 253, 255);

        bugReportForm = Rect("Report fields", bugReportPanel);
        Stretch(bugReportForm);
        Label("Heading", bugReportForm, "Report a bug", 52, FontStyles.Bold, 32, 72);
        Label("Help", bugReportForm, "Tell us what went wrong. Leave out passwords and personal information.",
            30, FontStyles.Normal, 106, 76);
        Label("Issue type", bugReportForm, "Issue type", 32, FontStyles.Bold, 190, 42);

        var dropdownObject = TMP_DefaultControls.CreateDropdown(new TMP_DefaultControls.Resources());
        dropdownObject.transform.SetParent(bugReportForm, false);
        Top((RectTransform)dropdownObject.transform, 50, 236, 50, 76);
        bugCategory = dropdownObject.GetComponent<TMP_Dropdown>();
        bugCategory.ClearOptions();
        bugCategory.AddOptions(new System.Collections.Generic.List<string>(BugCategories));
        bugCategory.captionText.fontSize = 32;
        bugCategory.itemText.fontSize = 32;
        bugCategory.captionText.color = bugCategory.itemText.color = Ink;
        bugCategory.captionText.rectTransform.offsetMin = new Vector2(24, 6);
        var arrow = dropdownObject.transform.Find("Arrow").GetComponent<Image>();
        arrow.enabled = false;
        var arrowLabel = Label("Dropdown arrow", dropdownObject.transform, "▼", 28, FontStyles.Normal, 0, 76, 22);
        arrowLabel.alignment = TextAlignmentOptions.MidlineRight;
        var item = (RectTransform)bugCategory.itemText.transform.parent;
        item.sizeDelta = new Vector2(0, 72);
        item.parent.GetComponent<RectTransform>().sizeDelta = new Vector2(0, 80);
        bugCategory.template.sizeDelta = new Vector2(0, 580);
        bugCategory.onValueChanged.AddListener(_ => UpdateBugCategory());

        otherLabel = Label("Other label", bugReportForm, "What kind of issue?", 32, FontStyles.Bold, 328, 44);
        otherIssue = ReportInput("Other issue", "Enter a short name for the issue", 376, 72, 100, false);
        explanationLabel = Label("Explanation label", bugReportForm, "What happened?", 32, FontStyles.Bold, 464, 44);
        explanation = ReportInput("Explanation", "Which screen were you on? What did you do before the bug?", 512, 212, 1000, true);
        ReportButton(bugReportForm, "Back", new Color32(214, 231, 242, 255), 50, 452, ShowBugReportFaq);
        sendReportButton = ReportButton(bugReportForm, "Send Report", new Color32(255, 181, 0, 255), 452, 50, PrepareBugReport);
        reportStatus = Label("Report status", bugReportForm, "", 27, FontStyles.Normal, 729, 110);
        UpdateBugCategory();
        BuildBugReportFaq();
    }

    void BuildBugReportFaq()
    {
        bugReportFaq = Rect("Before you report", bugReportPanel);
        Stretch(bugReportFaq);

        var banner = Rect("Help center banner", bugReportFaq);
        Top(banner, 36, 30, 36, 212);
        var bannerSurface = banner.gameObject.AddComponent<TutorialRoundedBox>();
        bannerSurface.radius = 28;
        bannerSurface.color = new Color32(211, 237, 249, 255);
        bannerSurface.raycastTarget = false;
        var mascot = Resources.Load<Sprite>("ARLoadingRobot");
        if (mascot != null)
        {
            var robot = Rect("ImARs robot", banner);
            Top(robot, 550, -42, 8, 292);
            var image = robot.gameObject.AddComponent<Image>();
            image.sprite = mascot;
            image.preserveAspect = true;
            image.raycastTarget = false;
        }
        Label("Help center", banner, "ImARs Help Center", 24, FontStyles.Normal, 19, 32, 28);
        var heading = Label("Heading", banner, "Before you report", 39, FontStyles.Bold, 53, 62, 28);
        heading.rectTransform.offsetMax += new Vector2(-224, 0);
        var intro = Label("Intro", banner, "Tap a question to see what to try. Still stuck? Continue to report.",
            28, FontStyles.Normal, 118, 70, 28);
        intro.rectTransform.offsetMax += new Vector2(-224, 0);

        var viewport = Rect("FAQ viewport", bugReportFaq);
        Stretch(viewport, 46, 262, 46, 150);
        viewport.gameObject.AddComponent<Image>().color = Color.clear;
        viewport.gameObject.AddComponent<RectMask2D>();
        var content = Rect("FAQ questions", viewport);
        Top(content, 0, 0, 0, 0);
        var layout = content.gameObject.AddComponent<VerticalLayoutGroup>();
        layout.padding = new RectOffset(0, 18, 0, 6);
        layout.spacing = 12;
        layout.childControlWidth = layout.childControlHeight = true;
        layout.childForceExpandWidth = true;
        layout.childForceExpandHeight = false;
        content.gameObject.AddComponent<ContentSizeFitter>().verticalFit = ContentSizeFitter.FitMode.PreferredSize;
        var scroll = viewport.gameObject.AddComponent<ScrollRect>();
        scroll.viewport = viewport;
        scroll.content = content;
        scroll.horizontal = false;
        scroll.movementType = ScrollRect.MovementType.Clamped;
        scroll.scrollSensitivity = 42;
        AppScrollbars.Attach(scroll);

        FaqAnswer(content, "Why can't I sign in?",
            "Check your internet connection and account details. Ask your teacher if your account or class is missing.");
        FaqAnswer(content, "Why won't the AR camera scan?",
            "Allow camera access, move to a well-lit area, and keep the whole marker in view.");
        FaqAnswer(content, "Why won't my lesson or quiz load?",
            "Check your connection and reopen the screen. Ask your teacher if the lesson or quiz has been assigned.");
        FaqAnswer(content, "Why is my score missing?",
            "Check your connection, then reopen the results screen. If your score is still missing, note the activity name.");
        FaqAnswer(content, "Why can't I hear anything?",
            "Check your media volume and make sure Sounds is on in Settings.");
        FaqAnswer(content, "What if the AR model is lagging?",
            "Open Settings, choose AR Graphics, then try Low before opening the AR activity again.");
        FaqAnswer(content, "What if the app freezes?",
            "Close and reopen ImARs. If it keeps freezing, tell us which screen you were on and what you tapped.");
        FaqAnswer(content, "What should I include in my report?",
            "Name the screen or activity, describe what you tapped, and explain what happened. Leave out passwords.");

        ReportButton(bugReportFaq, "Back", new Color32(214, 231, 242, 255), 50, 452, CloseBugReport);
        ReportButton(bugReportFaq, "Continue to report", new Color32(255, 181, 0, 255), 452, 50, () =>
        {
            bugReportFaq.gameObject.SetActive(false);
            bugReportForm.gameObject.SetActive(true);
            bugCategory.Select();
        });
    }

    void FaqAnswer(RectTransform content, string question, string answer)
    {
        const float headerHeight = 86;
        var row = Rect(question, content);
        var size = row.gameObject.AddComponent<LayoutElement>();
        size.preferredHeight = headerHeight;
        var surface = row.gameObject.AddComponent<TutorialRoundedBox>();
        surface.radius = 22;
        surface.color = Color.white;

        var header = Rect("Expand answer", row);
        Top(header, 0, 0, 0, headerHeight);
        var hitArea = header.gameObject.AddComponent<Image>();
        hitArea.color = Color.clear;
        var toggle = header.gameObject.AddComponent<Button>();
        toggle.targetGraphic = hitArea;
        var title = Label("Question", header, question, 32, FontStyles.Bold, 0, headerHeight, 24);
        title.rectTransform.offsetMax += new Vector2(-54, 0);
        var indicator = Label("Expand indicator", header, "+", 42, FontStyles.Bold, 0, headerHeight, 24);
        indicator.alignment = TextAlignmentOptions.MidlineRight;
        indicator.color = Cyan;
        var detail = Label("Answer", row, answer, 30, FontStyles.Normal, headerHeight, 106, 24);
        detail.alignment = TextAlignmentOptions.TopLeft;
        float answerHeight = Mathf.Ceil(detail.GetPreferredValues(answer, 720, 0).y) + 22;
        Top(detail.rectTransform, 24, headerHeight, 24, answerHeight);
        detail.gameObject.SetActive(false);
        toggle.onClick.AddListener(() =>
        {
            bool expanded = !detail.gameObject.activeSelf;
            detail.gameObject.SetActive(expanded);
            size.preferredHeight = headerHeight + (expanded ? answerHeight : 0);
            indicator.text = expanded ? "-" : "+";
            surface.color = expanded ? new Color32(224, 243, 251, 255) : Color.white;
        });
    }

    TMP_InputField ReportInput(string name, string hint, float top, float height, int limit, bool multiline)
    {
        var obj = TMP_DefaultControls.CreateInputField(new TMP_DefaultControls.Resources());
        obj.name = name;
        obj.transform.SetParent(bugReportForm, false);
        Top((RectTransform)obj.transform, 50, top, 50, height);
        var field = obj.GetComponent<TMP_InputField>();
        field.targetGraphic = obj.GetComponent<Image>();
        field.lineType = multiline ? TMP_InputField.LineType.MultiLineNewline : TMP_InputField.LineType.SingleLine;
        field.characterLimit = limit;
        field.richText = false;
        Stretch(field.textViewport, 24, 14, 24, 14);
        var placeholder = (TMP_Text)field.placeholder;
        placeholder.text = hint;
        field.textComponent.fontSize = placeholder.fontSize = 31;
        field.textComponent.color = Ink;
        placeholder.color = new Color32(83, 111, 130, 255);
        field.textComponent.alignment = placeholder.alignment =
            multiline ? TextAlignmentOptions.TopLeft : TextAlignmentOptions.MidlineLeft;
        placeholder.enableWordWrapping = multiline;
        return field;
    }

    Button ReportButton(RectTransform parent, string caption, Color color, float left, float right, UnityEngine.Events.UnityAction action)
    {
        var rect = Rect(caption, parent);
        Top(rect, left, 846, right, 88);
        var surface = rect.gameObject.AddComponent<TutorialRoundedBox>();
        surface.radius = 24;
        surface.color = color;
        var button = rect.gameObject.AddComponent<Button>();
        button.targetGraphic = surface;
        button.onClick.AddListener(action);
        Label(caption, rect, caption, 30, FontStyles.Bold, 0, 88, 12).alignment = TextAlignmentOptions.Center;
        return button;
    }

    void UpdateBugCategory()
    {
        bool isOther = bugCategory.value == OtherCategory;
        otherLabel.gameObject.SetActive(isOther);
        otherIssue.gameObject.SetActive(isOther);
        float top = isOther ? 464 : 328;
        Top(explanationLabel.rectTransform, 50, top, 50, 44);
        Top((RectTransform)explanation.transform, 50, top + 48, 50, 724 - top - 48);
        reportStatus.text = "";
    }

    bool ValidateBugReport()
    {
        string other = otherIssue.text.Trim();
        string details = explanation.text.Trim();
        if (bugCategory.value == 0)
        {
            reportStatus.text = "Choose the type of issue.";
            bugCategory.Select();
            return false;
        }
        if (bugCategory.value == OtherCategory && other.Length == 0)
        {
            reportStatus.text = "Enter a short name for the issue.";
            otherIssue.ActivateInputField();
            return false;
        }
        if (details.Length == 0)
        {
            reportStatus.text = "Add an explanation of what happened.";
            explanation.ActivateInputField();
            return false;
        }
        return true;
    }

    async void PrepareBugReport()
    {
        if (sendingReport || !ValidateBugReport()) return;
        var user = Firebase.Auth.FirebaseAuth.DefaultInstance.CurrentUser;
        if (user == null) { reportStatus.text = "Please sign in before sending your report."; return; }
        string uid = user.UserId;
        var payload = new BugReportSubmission {
            category = BugCategories[bugCategory.value],
            issue = bugCategory.value == OtherCategory ? otherIssue.text.Trim() : BugCategories[bugCategory.value],
            description = explanation.text.Trim(), appVersion = Application.version,
            platform = Application.platform.ToString(), scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene().name
        };
        string fingerprint = uid + ":" + JsonUtility.ToJson(payload);
        if (pendingReportFingerprint != fingerprint) {
            pendingReportFingerprint = fingerprint;
            pendingReportId = Guid.NewGuid().ToString("N");
        }
        payload.requestId = pendingReportId;
        sendingReport = true;
        sendReportButton.interactable = bugCategory.interactable = otherIssue.interactable = explanation.interactable = false;
        reportStatus.text = "Sending report to your school administrator…";
        try {
            var reply = await BugReportApi.SendAuthenticatedAsync("submit", JsonUtility.ToJson(payload), user);
            if (this == null || reportStatus == null || Firebase.Auth.FirebaseAuth.DefaultInstance.CurrentUser?.UserId != uid) return;
            var saved = reply.Succeeded && reply.IsJson && !reply.TooLarge ? JsonUtility.FromJson<BugReportAcknowledgement>(reply.Body) : null;
            if (saved == null || !saved.ok || string.IsNullOrEmpty(saved.id)) throw new InvalidOperationException("Report was not acknowledged.");
            reportStatus.text = "Report sent. Your school administrator can now review it.";
            explanation.text = "";
            otherIssue.text = "";
            pendingReportFingerprint = pendingReportId = null;
        }
        catch (Exception) {
            if (this != null && reportStatus != null && Firebase.Auth.FirebaseAuth.DefaultInstance.CurrentUser?.UserId == uid)
                reportStatus.text = "Could not confirm delivery. Check your connection and tap Send Report to retry. Your text is kept.";
        }
        finally {
            sendingReport = false;
            if (this != null && sendReportButton != null) sendReportButton.interactable = bugCategory.interactable = otherIssue.interactable = explanation.interactable = true;
        }
    }
}
