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

    [Serializable] private class RequestBody
    {
        public string identifier;
        public string password;
        public string email;
        public string role;
    }
    [Serializable] private class Reply
    {
        public bool enabled;
        public bool approved;
        public bool ok;
        public string email;
        public string profileId;
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
        return reply.email;
    }

    public static async Task<string> PrepareSessionAsync(FirebaseUser user, string schoolId = null)
    {
        if (user == null || !user.IsEmailVerified) throw new GatewayException("Verify your assigned email, then sign in again.", 403);
        string token = await user.TokenAsync(true);
        Reply reply = await Send("claim", new RequestBody { identifier = schoolId }, token);
        if (!reply.ok || string.IsNullOrEmpty(reply.profileId)) throw new GatewayException("Your school account could not be linked. Please contact your teacher or administrator.", 503);
        return reply.profileId;
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

    private static async Task<Reply> Send(string action, RequestBody body, string idToken = null, bool allowLegacy = false)
    {
        using (UnityWebRequest request = new UnityWebRequest(BaseUrl + action, body == null ? "GET" : "POST"))
        {
            request.downloadHandler = new DownloadHandlerBuffer();
            request.timeout = 15;
            if (body != null)
            {
                request.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(JsonUtility.ToJson(body)));
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
