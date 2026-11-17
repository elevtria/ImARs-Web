// Prepare Unity fixes for review without writing into another workspace.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.argv[2]) throw new Error("Pass the Unity project directory to inspect.");
const mobile = resolve(process.argv[2]);
const output = join(workspace, ".wrangler", "mobile-ar-prepared");
await mkdir(join(output, "Assets", "SCRIPTS"), { recursive: true });
const changes = [];
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Source changed; review anchor: ${before.slice(0, 90)}`);
  return source.replace(before, after);
}

for (const name of ["ARScanPresentation.cs", "VolcanoCutaway.cs"]) {
  const bytes = await readFile(join(mobile, "Assets", "SCRIPTS", name));
  const before = bytes.toString("utf8").replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  let source = before;
  if (name === "ARScanPresentation.cs") {
    source = replaceOnce(source, "public sealed class ARScanPresentation", "[DefaultExecutionOrder(100)]\npublic sealed class ARScanPresentation");
    source = replaceOnce(source, "    private Quaternion markerRotation;", `    private Quaternion markerRotation;
    // Store a pose separately from the hierarchy: Vuforia can move both the
    // marker and camera before LateUpdate, including in first-target world mode.
    private Vector3 filteredPosition;
    private Quaternion filteredRotation;
    private Transform filterCamera;
    private bool hasFilteredPose;`);
    source = replaceOnce(source, "        hasFramed = false;\n        QueueFrame();", "        hasFramed = false;\n        hasFilteredPose = false;\n        QueueFrame();");
    source = replaceOnce(source, "        tracked = visible;", "        if (visible != tracked) hasFilteredPose = false;\n        tracked = visible;");
    source = replaceOnce(source, "        hasFramed = true;", "        hasFramed = true;\n        hasFilteredPose = false;");
    source = replaceOnce(source, `        UpdateCompensation();
        transform.SetPositionAndRotation(position, rotation);
    }

    private float PerspectiveFit`, `        UpdateCompensation();
        ApplyTrackingPose(Camera.main, position, rotation, Time.unscaledDeltaTime);
    }

    internal void ApplyTrackingPose(Camera camera, Vector3 position, Quaternion rotation, float deltaTime)
    {
        if (!camera)
        {
            hasFilteredPose = false;
            transform.SetPositionAndRotation(position, rotation);
            return;
        }
        Transform view = camera.transform;
        Vector3 targetPosition = view.InverseTransformPoint(position);
        Quaternion targetRotation = Quaternion.Inverse(view.rotation) * rotation;
        // Reacquisition starts at the new pose instead of sliding from stale data.
        if (!hasFilteredPose || filterCamera != view)
        {
            filteredPosition = targetPosition;
            filteredRotation = targetRotation;
            filterCamera = view;
            hasFilteredPose = true;
        }
        else
        {
            float distance = Vector3.Distance(filteredPosition, targetPosition);
            float angle = Quaternion.Angle(filteredRotation, targetRotation);
            float dt = Mathf.Max(0, deltaTime);
            // Sub-millimetre/sub-degree noise should not move a resting model.
            // Larger deliberate movement raises response to keep interaction fluid.
            float positionResponse = Mathf.Lerp(10f, 32f, Mathf.Clamp01(distance / .05f));
            float rotationResponse = Mathf.Lerp(10f, 32f, Mathf.Clamp01(angle / 8f));
            if (distance > .00075f)
                filteredPosition = Vector3.Lerp(filteredPosition, targetPosition, 1 - Mathf.Exp(-positionResponse * dt));
            if (angle > .1f)
                filteredRotation = Quaternion.Slerp(filteredRotation, targetRotation, 1 - Mathf.Exp(-rotationResponse * dt));
        }
        transform.SetPositionAndRotation(view.TransformPoint(filteredPosition), view.rotation * filteredRotation);
    }

    private float PerspectiveFit`);
    source = replaceOnce(source, "    private void OnDisable() { if (pending != null) StopCoroutine(pending); pending = null; }", "    private void OnDisable() { hasFilteredPose = false; if (pending != null) StopCoroutine(pending); pending = null; }");
  } else {
    source = replaceOnce(source, "    private bool initialized, revealing;", `    private bool initialized, revealing;
    private bool playingAuthoredReveal;
    private float authoredRevealLength;`);
    source = replaceOnce(source, `        revealing = true;
        elapsed = 0;
    }`, `        revealing = true;
        elapsed = 0;
        // The imported cutaway already animates both halves separating. Replay
        // that clip explicitly; a quick root turn/model swap hides this action.
        var animator = cutawayModel.GetComponent<Animator>();
        playingAuthoredReveal = animator && animator.runtimeAnimatorController;
        if (playingAuthoredReveal)
        {
            wholeModel.gameObject.SetActive(false);
            cutawayModel.gameObject.SetActive(true);
            animator.enabled = true;
            animator.cullingMode = AnimatorCullingMode.AlwaysAnimate;
            animator.Rebind();
            animator.Update(0);
            var state = animator.GetCurrentAnimatorStateInfo(0);
            animator.Play(state.fullPathHash, 0, 0);
            animator.Update(0);
            authoredRevealLength = Mathf.Max(duration, animator.GetCurrentAnimatorStateInfo(0).length);
        }
    }`);
    source = replaceOnce(source, `        elapsed += Mathf.Max(0, deltaTime);
        float t`, `        elapsed += Mathf.Max(0, deltaTime);
        if (playingAuthoredReveal)
        {
            if (elapsed >= authoredRevealLength)
            {
                revealing = false;
                IsRevealed = true;
            }
            return;
        }
        // Retain the existing transition for a model without an Animator.
        float t`);
    source = replaceOnce(source, "        revealing = false;\n        IsRevealed = false;", "        revealing = false;\n        playingAuthoredReveal = false;\n        elapsed = 0;\n        IsRevealed = false;");
  }
  await writeFile(join(output, "Assets", "SCRIPTS", name), source);
  changes.push({ path: `Assets/SCRIPTS/${name}`, sha256: createHash("sha256").update(bytes).digest("hex"), before, after: source });
}
await writeFile(join(output, "source-manifest.json"), JSON.stringify({ source: mobile, files: changes.map(({ path, sha256 }) => ({ path, sha256 })) }, null, 2) + "\n");
// A full-file unified diff keeps the prepared change portable without depending
// on git being initialized in the Unity/Plastic checkout.
const patch = changes.map(({ path, before, after }) => {
  const lines = value => value.replace(/\n$/, "").split("\n");
  const oldLines = lines(before), newLines = lines(after);
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`, ...oldLines.map(line => "-" + line), ...newLines.map(line => "+" + line), ""].join("\n");
}).join("");
await writeFile(join(workspace, "docs", "mobile-ar-stability.patch"), patch);
console.log(`Prepared ${changes.length} Unity scripts in ${output}. Unity source files were not modified.`);
