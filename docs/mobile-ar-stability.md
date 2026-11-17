# Prepared Unity AR fixes

Status: prepared and compiled, **not applied to the mobile project**.

Inspected project: `C:/Users/USER/Imars-2026-07-18-19-38-32` (Unity 2022.3.62f3,
Vuforia 11.4.4). This workspace permits writing to ImARs-Web but only reading
that Unity checkout.

## Findings

- `ARScanPresentation.LateUpdate` copies the tracked pose directly into the
  presentation each frame. There is a wait for stability during initial framing,
  but no filtering during ongoing tracking.
- The volcano split has not been deleted. Both `half volcano.glb` and
  `Volcano Interior.anim` contain the original front/back translation and opening
  rotation curves. The halves begin separating at about two seconds and reach
  their open positions at about four seconds in the 14-second clip.
- `VolcanoCutaway` currently uses a 0.7-second root-turn/model-swap transition and
  does not explicitly rewind the cutaway Animator on a new reveal. The exact
  cause of the reported missing animation still requires runtime reproduction.

## Prepared changes

`mobile-ar-stability.patch` changes two existing Unity scripts; it needs no scene
or asset edits.

- Filter the displayed tracking pose in camera coordinates. This handles noise
  whether Vuforia changes the marker pose or the camera pose. Exponential
  smoothing uses elapsed time, a small resting deadband, and faster response to
  larger movement. Reset the filter on reacquisition, camera replacement,
  explicit view reset, and component disable. Run presentation before part-focus
  overlays so selection uses the displayed pose.
- Activate and explicitly restart the existing cutaway Animator when tapped.
  Let the authored split animation control the halves, preserving the root's
  orientation and existing animation pause behavior. Retain the previous
  transition as a fallback when a model has no Animator. Reset still returns to
  the whole volcano; the next reveal starts the original clip again.

## Validation and remaining work

- Compiled the full mobile C# assembly with Unity's Roslyn compiler, the current
  project's compiler response file and references, and both prepared replacements:
  passed without compiler errors.
- JavaScript syntax checks for both preparation scripts: passed.
- `git apply --check` against fresh source copies: passed.
- An isolated Unity harness is prepared for resting marker/camera noise,
  deliberate movement, frame rates, reacquisition, original split curves,
  repeated reveals, and disable/reset behavior. The batch editor exited with
  code 199 after its licensing connection timed out; these runtime assertions
  have **not run**.

The actual mobile project and installed APK remain unchanged. Open the inspected
Unity project as the writable workspace before applying the patch. Recheck its
source against the recorded hashes rather than overwriting newer edits. Then run
Unity validation and test a phone build with stationary markers, intentional
camera movement, loss/reacquisition, lesson changes, volcano taps/reset, and the
teacher animation pause/resume controls. Filter response still needs device tuning.

## Reproduction

From ImARs-Web:

```powershell
node scripts/prepare-mobile-ar-fixes.mjs 'C:\Users\USER\Imars-2026-07-18-19-38-32'
node scripts/validate-mobile-ar-fixes.mjs 'C:\Users\USER\Imars-2026-07-18-19-38-32'
```

The first command reads Unity source and generates candidate scripts, a source
hash manifest in `.wrangler/mobile-ar-prepared`, and the reviewable patch in
`docs`. The second prepares the isolated test project in
`.wrangler/mobile-ar-validation`. Neither command writes into the mobile project.
