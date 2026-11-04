using System;
using System.Text;
using System.Threading.Tasks;
using Firebase.Auth;
using UnityEngine;
using UnityEngine.Networking;

// This endpoint is disabled by default on the server. Deploy and test it before
// publishing stricter Firestore rules; see the website security/README.md.
public static class ImarsAccountGateway
{
    private const string BaseUrl = "https://imars-web.pages.dev/api/account-access/";
    private static Task<bool> configuration;
    public const string NoticeKey = "ImarsAccountNotice";
    internal const string SessionKey = "ImarsTeacherMobileSession";
    internal const string SessionOwnerKey = "ImarsTeacherMobileSessionOwner";
    private static string pendingSession, pendingOwner;

    [Serializable] private class RequestBody
    {
        public string identifier;
        public string password;
        public string email;
        public string role;
        public string mobileSession;
    }
    [Serializable] private class Reply
    {
        public bool enabled;
        public bool approved;
        public bool ok;
        public string email;
        public string profileId;
        public string role;
        public string uid;
        public string mobileSession;
        public string error;
    }
    public sealed class GatewayException : Exception
    {
        public readonly long Status;
        public GatewayException(string message, long status) : base(message) { Status = status; }
        public bool Temporary => Status == 0 || Status >= 500;
    }

    public static Task<bool> EnabledAsync()
    {
        // Deduplicate an in-flight check, but refresh completed configuration at
        // the next auth action so an app left open can follow a staged cutover.
        if (configuration == null || configuration.IsCompleted) configuration = ReadConfiguration();
        return configuration;
    }

    private static async Task<bool> ReadConfiguration()
    {
        try { return (await Send("config", null, null, true)).enabled; }
        catch { configuration = null; throw; }
    }

    public static async Task<string> LoginEmailAsync(string schoolId, string password)
    {
        Reply reply = await Send("login", new RequestBody { identifier = schoolId, password = password });
        if (string.IsNullOrEmpty(reply.email)) throw new GatewayException("Sign-in could not be verified. Please retry.", 503);
        pendingSession = reply.mobileSession;
        pendingOwner = reply.uid;
        return reply.email;
    }

    public static async Task<string> PrepareSessionAsync(FirebaseUser user, string schoolId = null)
    {
        if (user == null || !user.IsEmailVerified) throw new GatewayException("Verify your assigned email, then sign in again.", 403);
        string token = await user.TokenAsync(true);
        Reply reply = await Send("claim", new RequestBody { identifier = schoolId }, token);
        if (!reply.ok || string.IsNullOrEmpty(reply.profileId)) throw new GatewayException("Your school account could not be linked. Please contact your teacher or administrator.", 503);
        if (reply.role == "teacher")
        {
            string session = pendingOwner == user.UserId ? pendingSession : SavedSession(user.UserId);
            if (string.IsNullOrEmpty(session)) throw new GatewayException("Please enter your ID and password to sign in again.", 401);
            await CheckTeacherSessionAsync(user, session);
            if (FirebaseAuth.DefaultInstance.CurrentUser?.UserId != user.UserId) throw new GatewayException("Please sign in again.", 401);
            PlayerPrefs.SetString(SessionOwnerKey, user.UserId);
            PlayerPrefs.SetString(SessionKey, session);
            PlayerPrefs.Save();
            ImarsTeacherSessionMonitor.Watch();
        }
        pendingSession = pendingOwner = null;
        return reply.profileId;
    }

    internal static string SavedSession(string uid) => PlayerPrefs.GetString(SessionOwnerKey, "") == uid ? PlayerPrefs.GetString(SessionKey, "") : "";

    public static async Task StartTeacherSessionAsync(FirebaseUser user, string password)
    {
        string token = await user.TokenAsync(false);
        Reply reply = await Send("teacher-session-login", new RequestBody { password = password }, token);
        if (!reply.ok || reply.uid != user.UserId || string.IsNullOrEmpty(reply.mobileSession) || FirebaseAuth.DefaultInstance.CurrentUser?.UserId != user.UserId)
            throw new GatewayException("Please sign in again.", 401);
        PlayerPrefs.SetString(SessionOwnerKey, user.UserId);
        PlayerPrefs.SetString(SessionKey, reply.mobileSession);
        PlayerPrefs.Save();
        ImarsTeacherSessionMonitor.Watch();
    }

    internal static void ClearTeacherSession()
    {
        pendingSession = pendingOwner = null;
        PlayerPrefs.DeleteKey(SessionKey);
        PlayerPrefs.DeleteKey(SessionOwnerKey);
        PlayerPrefs.Save();
    }

    internal static async Task CheckTeacherSessionAsync(FirebaseUser user, string session)
    {
        string token = await user.TokenAsync(false);
        if (FirebaseAuth.DefaultInstance.CurrentUser?.UserId != user.UserId) return;
        await Send("mobile-session", new RequestBody { mobileSession = session }, token);
    }

    // --- PURE INVITATION VERIFICATION (Prevents background thread crashes) ---
    public static async Task VerifyInvitationAsync(string schoolId, string assignedEmail, string role)
    {
        Reply invitation = await Send("invitation", new RequestBody { identifier = schoolId, email = assignedEmail, role = role });
        if (!invitation.approved)
        {
            Debug.LogError($"Gateway Invitation Denied for ID '{schoolId}' and Email '{assignedEmail}'. Server Error: {invitation.error}");
            throw new GatewayException("Please check your assigned school ID and email.", 403);
        }
    }

    public static async Task RegisterAsync(FirebaseAuth auth, string schoolId, string assignedEmail, string fullName, string password, string role)
    {
        Reply invitation = await Send("invitation", new RequestBody { identifier = schoolId, email = assignedEmail, role = role });
        if (!invitation.approved) throw new GatewayException("Please check your assigned school ID and email.", 403);
        bool created = false;
        try
        {
            AuthResult result = await auth.CreateUserWithEmailAndPasswordAsync(assignedEmail, password);
            created = true;
            await result.User.UpdateUserProfileAsync(new UserProfile { DisplayName = fullName });
            await result.User.SendEmailVerificationAsync();
            PlayerPrefs.SetString(NoticeKey, "Verification email sent. Open the link, then sign in with your school ID and password.");
            PlayerPrefs.Save();
        }
        finally { if (created) auth.SignOut(); }
        // The server links the verified Auth UID on first sign-in. Registration
        // never writes a role, UID or other person's profile from this client.
    }

    [Serializable] private class ProgressBody { public string termId; public string lessonId; }
    internal static async Task NotifyProgressAsync(FirebaseUser user, string term, string lesson)
    {
        string token = await user.TokenAsync(false);
        if (FirebaseAuth.DefaultInstance.CurrentUser?.UserId != user.UserId) return;
        await Send("progress-synced", null, token, jsonBody: JsonUtility.ToJson(new ProgressBody { termId = term, lessonId = lesson }));
    }

    private static async Task<Reply> Send(string action, RequestBody body, string idToken = null, bool allowLegacy = false, string jsonBody = null)
    {
        using (UnityWebRequest request = new UnityWebRequest(BaseUrl + action, body == null && jsonBody == null ? "GET" : "POST"))
        {
            request.downloadHandler = new DownloadHandlerBuffer();
            request.timeout = 15;
            if (body != null || jsonBody != null)
            {
                request.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(jsonBody ?? JsonUtility.ToJson(body)));
                request.SetRequestHeader("Content-Type", "application/json");
            }
            if (!string.IsNullOrEmpty(idToken)) request.SetRequestHeader("Authorization", "Bearer " + idToken);
            UnityWebRequestAsyncOperation operation = request.SendWebRequest();
            while (!operation.isDone) await Task.Yield();
            long status = request.responseCode;
            string content = request.downloadHandler.text;
            string contentType = request.GetResponseHeader("Content-Type") ?? "";
            // Existing deployments without this Function continue their original
            // flow. An enabled server error never becomes a public-read fallback.
            if (allowLegacy && (status == 404 || (status == 200 && !contentType.Contains("application/json")))) return new Reply { enabled = false };
            if (request.result == UnityWebRequest.Result.ConnectionError || status == 0)
                throw new GatewayException("Cannot connect to account services. Please check your connection and retry.", 0);
            Reply reply;
            try { reply = JsonUtility.FromJson<Reply>(content); }
            catch { throw new GatewayException("Account services are temporarily unavailable. Please retry.", 503); }
            if (reply == null) throw new GatewayException("Account services are temporarily unavailable. Please retry.", 503);
            if (status < 200 || status >= 300)
                throw new GatewayException(string.IsNullOrEmpty(reply.error) ? "Account access could not be verified. Please retry." : reply.error, status);
            return reply;
        }
    }
}

// One account check across scenes; no per-screen listeners or student polling.
public sealed class ImarsTeacherSessionMonitor : MonoBehaviour
{
    private static ImarsTeacherSessionMonitor instance;
    private FirebaseAuth auth;
    private bool checking, initializing, ending, wasOffline;
    private float nextCheck;

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
    private static void ResetStatics() { instance = null; }

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
    private static void Restore()
    {
        if (PlayerPrefs.HasKey(ImarsAccountGateway.SessionKey)) Watch();
    }

    public static void Watch()
    {
        if (instance == null)
        {
            instance = new GameObject("Teacher session").AddComponent<ImarsTeacherSessionMonitor>();
            DontDestroyOnLoad(instance.gameObject);
        }
        instance.nextCheck = 0;
        instance.ending = false;
        instance.Initialize();
    }

    private async void Initialize()
    {
        if (initializing || auth != null) return;
        initializing = true;
        try
        {
            if (await FirebaseInitialization.EnsureReadyAsync() != Firebase.DependencyStatus.Available || this == null) return;
            auth = FirebaseAuth.DefaultInstance;
            auth.StateChanged += AuthChanged;
        }
        catch (Exception) { nextCheck = Time.realtimeSinceStartup + 10f; }
        finally { initializing = false; }
    }

    private void AuthChanged(object sender, EventArgs args)
    {
        if (this == null || ending) return;
        string owner = PlayerPrefs.GetString(ImarsAccountGateway.SessionOwnerKey, "");
        if (auth.CurrentUser == null || (owner.Length > 0 && owner != auth.CurrentUser.UserId)) ImarsAccountGateway.ClearTeacherSession();
        nextCheck = 0;
    }

    private void OnApplicationFocus(bool focused) { if (focused) nextCheck = 0; }
    private void OnApplicationPause(bool paused) { if (!paused) nextCheck = 0; }

    private void Update()
    {
        bool offline = Application.internetReachability == NetworkReachability.NotReachable;
        if (wasOffline && !offline) nextCheck = 0;
        wasOffline = offline;
        if (ending || checking || !Application.isFocused || offline || Time.realtimeSinceStartup < nextCheck) return;
        if (auth == null) { Initialize(); return; }
        var user = auth.CurrentUser;
        string session = user == null ? "" : ImarsAccountGateway.SavedSession(user.UserId);
        if (!string.IsNullOrEmpty(session)) Check(user, session);
    }

    private async void Check(FirebaseUser user, string session)
    {
        checking = true;
        nextCheck = Time.realtimeSinceStartup + 30f;
        try { await ImarsAccountGateway.CheckTeacherSessionAsync(user, session); }
        catch (ImarsAccountGateway.GatewayException error)
        {
            if (this == null || auth.CurrentUser?.UserId != user.UserId || ImarsAccountGateway.SavedSession(user.UserId) != session) return;
            if (error.Status == 401 || error.Status == 403) EndSession();
            else nextCheck = Time.realtimeSinceStartup + 10f;
        }
        catch (Exception) { nextCheck = Time.realtimeSinceStartup + 10f; }
        finally { checking = false; }
    }

    private void EndSession()
    {
        if (ending) return;
        ending = true;
        ImarsAccountGateway.ClearTeacherSession();
        auth.SignOut();
        foreach (string key in new[] { "CurrentStudentID", "LoggedInStudentId", "CachedStudentName", "CachedAvatarId", "CachedClassCode", "CachedAvgPre", "CachedAvgPost", "CachedCompletedCount" }) PlayerPrefs.DeleteKey(key);
        PlayerPrefs.SetString(ImarsAccountGateway.NoticeKey, "Please sign in again.");
        PlayerPrefs.Save();
        GlobalQuizData.CurrentStudentId = "";
        Time.timeScale = 1f;
        UnityEngine.SceneManagement.SceneManager.LoadScene("Student_Login");
    }

    private void OnDestroy()
    {
        if (auth != null) auth.StateChanged -= AuthChanged;
        if (instance == this) instance = null;
    }
}

// Acknowledged lesson changes notify the private dashboard cache. Notifications
// survive app restarts and never delay saving or navigating a lesson.
public sealed class ImarsDashboardSync : MonoBehaviour
{
    private static ImarsDashboardSync instance;
    private bool sending;
    private static string Key(string uid, string term, string lesson) => "ImarsDashboardSync:" + uid + ":" + term + ":" + lesson;

    public static void Notify(string student, string term, string lesson)
    {
        string uid = FirebaseAuth.DefaultInstance.CurrentUser?.UserId;
        if (string.IsNullOrEmpty(uid) || student != StudentTestProgress.StudentId ||
            !System.Text.RegularExpressions.Regex.IsMatch(term ?? "", @"^term_0[1-3]$") ||
            !System.Text.RegularExpressions.Regex.IsMatch(lesson ?? "", @"^lesson_0[1-4]$")) return;
        PlayerPrefs.SetString(Key(uid, term, lesson), Guid.NewGuid().ToString("N"));
        PlayerPrefs.Save();
        EnsureService();
    }

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    private static void EnsureService()
    {
        if (instance != null) return;
        instance = new GameObject("Dashboard sync").AddComponent<ImarsDashboardSync>();
        DontDestroyOnLoad(instance.gameObject);
        instance.InvokeRepeating(nameof(Pump), 5f, 30f);
    }

    private async void Pump()
    {
        if (sending || Application.internetReachability == NetworkReachability.NotReachable) return;
        sending = true;
        try
        {
            if (await FirebaseInitialization.EnsureReadyAsync() != Firebase.DependencyStatus.Available) return;
            var user = FirebaseAuth.DefaultInstance.CurrentUser;
            if (user == null) return;
            for (int t = 1; t <= 3; t++) for (int l = 1; l <= 4; l++)
            {
                if (FirebaseAuth.DefaultInstance.CurrentUser?.UserId != user.UserId) return;
                string term = "term_0" + t, lesson = "lesson_0" + l;
                string key = Key(user.UserId, term, lesson), revision = PlayerPrefs.GetString(key, "");
                if (string.IsNullOrEmpty(revision)) continue;
                await ImarsAccountGateway.NotifyProgressAsync(user, term, lesson);
                if (FirebaseAuth.DefaultInstance.CurrentUser?.UserId != user.UserId) return;
                if (PlayerPrefs.GetString(key, "") == revision) PlayerPrefs.DeleteKey(key);
                PlayerPrefs.Save();
            }
        }
        catch (Exception) { /* The durable marker is retried after reconnect. */ }
        finally { sending = false; }
    }
}
