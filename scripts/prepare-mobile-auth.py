"""Prepare the reviewed mobile auth patch without touching the Unity checkout.

Run with the explicitly provided mobile source directory. Resulting files go to
the ignored .wrangler directory; the reviewable diff goes to security/mobile.
Applying those exact prepared files is a separate, explicit local file action.
"""
from pathlib import Path
import difflib
import hashlib
import json
import sys

workspace = Path(__file__).resolve().parents[1]
mobile = Path(sys.argv[1]).resolve()
source_dir = mobile / "Assets" / "SCRIPTS"
output = workspace / ".wrangler" / "mobile-auth-prepared"
output.mkdir(parents=True, exist_ok=True)
patches = []
manifest = {}
backup = workspace / ".wrangler" / "mobile-auth-before"
backup.mkdir(parents=True, exist_ok=True)

def replace_once(source, old, new):
    if source.count(old) != 1:
        raise RuntimeError(f"Expected exactly one source anchor: {old[:90]!r}")
    return source.replace(old, new, 1)

for filename in ("LogIn.cs", "Student_CreAcc.cs", "Admin_CreAccount.cs"):
    original_bytes = (source_dir / filename).read_bytes()
    manifest[filename] = hashlib.sha256(original_bytes).hexdigest()
    if not (backup / filename).exists():
        (backup / filename).write_bytes(original_bytes)
    original = (source_dir / filename).read_text(encoding="utf-8-sig")
    source = original
    if filename == "LogIn.cs":
        source = replace_once(source, '        if (errorText != null) errorText.text = "";\n\n        if (loginUI', '''        if (errorText != null) errorText.text = PlayerPrefs.GetString(ImarsAccountGateway.NoticeKey, "");
        PlayerPrefs.DeleteKey(ImarsAccountGateway.NoticeKey);

        if (loginUI''')
        source = replace_once(source, "    void OnSignInClicked()", "    async void OnSignInClicked()")
        anchor = '        db.Collection("users").Document(studentId).GetSnapshotAsync().ContinueWithOnMainThread(task =>'
        source = replace_once(source, anchor, '''        try
        {
            if (await ImarsAccountGateway.EnabledAsync())
            {
                string email = await ImarsAccountGateway.LoginEmailAsync(studentId, password);
                AuthResult result = await auth.SignInWithEmailAndPasswordAsync(email, password);
                FirebaseUser signedIn = result.User;
                await signedIn.ReloadAsync();
                if (!signedIn.IsEmailVerified)
                {
                    try { await signedIn.SendEmailVerificationAsync(); } catch { }
                    auth.SignOut();
                    if (errorText != null) errorText.text = "Please verify your assigned email before signing in. Check your inbox for the verification link.";
                    ResetLoginButton();
                    return;
                }
                string linkedId = await ImarsAccountGateway.PrepareSessionAsync(signedIn, studentId);
                if (saveAccountToggle != null && saveAccountToggle.isOn) PlayerPrefs.SetString("SavedStudentID", rawId);
                else PlayerPrefs.DeleteKey("SavedStudentID");
                PlayerPrefs.SetString("CurrentStudentID", linkedId);
                PlayerPrefs.Save();
                RouteUser(linkedId);
                return;
            }
        }
        catch (ImarsAccountGateway.GatewayException exception)
        {
            auth.SignOut();
            if (errorText != null) errorText.text = exception.Message;
            ResetLoginButton();
            return;
        }
        catch (System.Exception)
        {
            auth.SignOut();
            if (errorText != null) errorText.text = "Sign-in could not be completed. Check your ID, password and connection, then retry.";
            ResetLoginButton();
            return;
        }

''' + anchor)
        source = replace_once(source, "    void RouteAutoLoggedInUser(string uid)", "    async void RouteAutoLoggedInUser(string uid, bool useOfflineCache = false)")
        # Offline and failed-reload branches already support cached sessions.
        old = "RouteAutoLoggedInUser(auth.CurrentUser.UserId);"
        if source.count(old) != 3:
            raise RuntimeError("Unexpected auto-login branches")
        source = source.replace(old, "RouteAutoLoggedInUser(auth.CurrentUser.UserId, true);", 2)
        start = source.index("    async void RouteAutoLoggedInUser")
        anchor = "        Source fetchSource = (Application.internetReachability == NetworkReachability.NotReachable) ? Source.Cache : Source.Default;"
        head, tail = source[:start], source[start:]
        tail = tail.replace(anchor, '''        if (!useOfflineCache && Application.internetReachability != NetworkReachability.NotReachable)
        {
            try
            {
                if (await ImarsAccountGateway.EnabledAsync())
                {
                    string linkedId = await ImarsAccountGateway.PrepareSessionAsync(auth.CurrentUser);
                    PlayerPrefs.SetString("CurrentStudentID", linkedId);
                    PlayerPrefs.Save();
                }
            }
            catch (ImarsAccountGateway.GatewayException exception)
            {
                if (exception.Temporary) useOfflineCache = true;
                else { ForceSignOutAndReset(exception.Message); return; }
            }
            catch (System.Exception) { useOfflineCache = true; }
        }
        Source fetchSource = (useOfflineCache || Application.internetReachability == NetworkReachability.NotReachable) ? Source.Cache : Source.Default;''', 1)
        source = head + tail
    else:
        source = replace_once(source, "    void OnSignUpClicked()", "    async void OnSignUpClicked()")
        is_student = filename == "Student_CreAcc.cs"
        role, id_variable = ("student", "studentId") if is_student else ("teacher", "teacherId")
        anchor = '        if (errorText != null) errorText.text = "Verifying School ID...";' if is_student else '        if (errorText != null) errorText.text = "Validating invitation...";'
        branch = '''        try
        {
            if (signUpButton != null) signUpButton.interactable = false;
            if (await ImarsAccountGateway.EnabledAsync())
            {
                if (errorText != null) errorText.text = "Checking your invitation and sending verification...";
                await ImarsAccountGateway.RegisterAsync(auth, SCHOOL_ID, email, fullName, password, "ROLE");
                SceneManager.LoadScene(loginScene);
                return;
            }
        }
        catch (ImarsAccountGateway.GatewayException exception)
        {
            if (errorText != null) errorText.text = exception.Message;
            return;
        }
        catch (System.Exception)
        {
            if (errorText != null) errorText.text = "Registration did not complete. If the email already has an account, sign in to resend verification; otherwise retry or contact your teacher.";
            return;
        }
        finally { if (signUpButton != null) signUpButton.interactable = true; }

'''.replace("SCHOOL_ID", id_variable).replace("ROLE", role)
        source = replace_once(source, anchor, branch + anchor)
        if is_student:
            source = replace_once(source, "    void OnStudentIDEntered(string inputId)", "    async void OnStudentIDEntered(string inputId)")
            anchor = '        if (errorText != null) errorText.text = "Checking ID...";'
            source = replace_once(source, anchor, '''        try
        {
            if (await ImarsAccountGateway.EnabledAsync())
            {
                // The assigned address is entered by its owner; a public ID
                // lookup no longer discloses a student's full profile or email.
                if (emailField != null) { emailField.text = ""; emailField.interactable = true; }
                if (errorText != null) errorText.text = "Enter the email assigned by your teacher. You will need to verify it before account activation.";
                return;
            }
        }
        catch (System.Exception)
        {
            if (errorText != null) errorText.text = "Cannot check account services. Please reconnect and retry.";
            return;
        }

''' + anchor)
    (output / filename).write_text(source, encoding="utf-8", newline="\n")
    patches.extend(difflib.unified_diff(original.splitlines(True), source.splitlines(True), fromfile="a/Assets/SCRIPTS/" + filename, tofile="b/Assets/SCRIPTS/" + filename))

helper = workspace / "security" / "mobile" / "ImarsAccountGateway.cs"
(output / helper.name).write_bytes(helper.read_bytes())
patches.extend(difflib.unified_diff([], helper.read_text(encoding="utf-8").splitlines(True), fromfile="/dev/null", tofile="b/Assets/SCRIPTS/" + helper.name))
(workspace / "security" / "mobile" / "compatible-login.patch").write_text("".join(patches), encoding="utf-8")
(output / "original-hashes.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
print("Prepared three mobile auth edits and one helper; original Unity files are unchanged.")
