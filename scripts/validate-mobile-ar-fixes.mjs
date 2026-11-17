import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.argv[2]) throw new Error("Pass the source Unity project directory.");
const source = resolve(process.argv[2]);
const project = join(workspace, ".wrangler", "mobile-ar-validation");
for (const folder of ["Assets/Editor", "Assets/Scripts", "Assets/Volcano", "Packages", "ProjectSettings"])
  await mkdir(join(project, folder), { recursive: true });
for (const name of ["ARScanPresentation.cs", "VolcanoCutaway.cs"])
  await copyFile(join(workspace, ".wrangler/mobile-ar-prepared/Assets/SCRIPTS", name), join(project, "Assets/Scripts", name));
for (const name of ["Volcano Interior.anim", "Volcano Interior.anim.meta", "Volcano Interior.controller", "Volcano Interior.controller.meta"])
  await copyFile(join(source, "Assets/ARAnimations/VolcanoReveal", name), join(project, "Assets/Volcano", name));
await writeFile(join(project, "Packages/manifest.json"), JSON.stringify({ dependencies: { "com.unity.modules.animation": "1.0.0" } }));
await copyFile(join(source, "ProjectSettings/ProjectVersion.txt"), join(project, "ProjectSettings/ProjectVersion.txt"));
// Simulated tracking avoids initializing a camera SDK in a headless editor.
// The prepared production scripts and the actual authored volcano clip run in Unity.
await writeFile(join(project, "Assets/Scripts/TrackingTestDoubles.cs"), `using System;
using UnityEngine;
namespace Vuforia {
    public enum Status { NO_POSE, TRACKED, EXTENDED_TRACKED }
    public struct TargetStatus { public Status Status; }
    public class ObserverBehaviour : MonoBehaviour {
        public TargetStatus TargetStatus;
        public event Action<ObserverBehaviour, TargetStatus> OnTargetStatusChanged;
        public void Report(Status status) { TargetStatus = new TargetStatus { Status = status }; OnTargetStatusChanged?.Invoke(this, TargetStatus); }
    }
}
public class TestPartFocus { public void ClearSelection() {} }
public class ARLabelController : MonoBehaviour {
    public class Target { public Transform root; }
    public class Binding { public Target[] targets; }
    public Binding[] bindings = new Binding[0];
    public Transform[] additionalScanModels = new Transform[0];
    public TestPartFocus PartFocus;
}
`);
await writeFile(join(project, "Assets/Editor/ARFixValidation.cs"), `using System;
using System.IO;
using System.Reflection;
using UnityEngine;
using UnityEditor;

public static class ARFixValidation {
    static int checks;
    static readonly BindingFlags Flags = BindingFlags.Instance | BindingFlags.NonPublic;
    static void Check(bool value, string message) { if (!value) throw new Exception(message); checks++; Debug.Log("PASS: " + message); }
    static void Apply(ARScanPresentation p, Camera c, Vector3 v, Quaternion q, float dt) => typeof(ARScanPresentation).GetMethod("ApplyTrackingPose", Flags).Invoke(p, new object[] { c, v, q, dt });
    public static void Run() {
        try {
            PoseChecks(); VolcanoChecks();
            File.WriteAllText("validation.txt", "Passed " + checks + " Unity checks. Simulated tracking; actual volcano animation curves. Device camera tracking was not tested.\\n");
            EditorApplication.Exit(0);
        } catch (Exception e) { Debug.LogException(e); EditorApplication.Exit(1); }
    }
    static void PoseChecks() {
        var camera = new GameObject("Camera").AddComponent<Camera>();
        var pivot = new GameObject("Presentation").AddComponent<ARScanPresentation>();
        var baseline = new Vector3(0, 0, 1);
        Apply(pivot, camera, baseline, Quaternion.identity, 1f/60);
        float rawSquared = 0, filteredSquared = 0;
        for (int i=0; i<240; i++) {
            float jitter = (i%2 == 0 ? .004f : -.004f);
            Apply(pivot, camera, baseline + Vector3.right*jitter, Quaternion.Euler(0, jitter*200, 0), 1f/60);
            if (i>30) { rawSquared += jitter*jitter; filteredSquared += pivot.transform.position.x*pivot.transform.position.x; }
        }
        Check(filteredSquared < rawSquared*.15f, "Resting position jitter reduced by more than 60 percent RMS");
        Check(Quaternion.Angle(pivot.transform.rotation, Quaternion.identity) < .3f, "Resting rotation jitter is damped");
        for (int i=0; i<12; i++) Apply(pivot, camera, baseline+Vector3.right*.2f, Quaternion.Euler(0, 30, 0), 1f/60);
        Check(Mathf.Abs(pivot.transform.position.x-.2f)<.01f, "Deliberate movement follows within 200 milliseconds");
        Check(Quaternion.Angle(pivot.transform.rotation, Quaternion.Euler(0,30,0))<1.5f, "Deliberate rotation follows within 200 milliseconds");
        // First-target world mode can place tracking noise in the camera instead.
        var other = new GameObject("Camera-relative presentation").AddComponent<ARScanPresentation>();
        Apply(other, camera, baseline, Quaternion.identity, 1f/60);
        float squared=0;
        for(int i=0;i<180;i++) {
            camera.transform.position=Vector3.right*(i%2==0?.004f:-.004f);
            Apply(other,camera,baseline,Quaternion.identity,1f/60);
            if(i>30) { float x=camera.transform.InverseTransformPoint(other.transform.position).x; squared+=x*x; }
        }
        Check(squared/(149*.004f*.004f)<.15f, "Camera-origin tracking jitter is also damped");
        typeof(ARScanPresentation).GetField("hasFilteredPose", Flags).SetValue(other,false);
        Apply(other,camera,new Vector3(1,0,1),Quaternion.Euler(0,90,0),1f/60);
        Check(Vector3.Distance(other.transform.position,new Vector3(1,0,1))<.0001f, "Reacquisition starts at the current pose");
        var one = new GameObject("30fps").AddComponent<ARScanPresentation>();
        var two = new GameObject("120fps").AddComponent<ARScanPresentation>();
        camera.transform.position=Vector3.zero;
        Apply(one,camera,baseline,Quaternion.identity,0); Apply(two,camera,baseline,Quaternion.identity,0);
        for(int i=0;i<30;i++) Apply(one,camera,baseline+Vector3.right*.1f,Quaternion.Euler(0,20,0),1f/30);
        for(int i=0;i<120;i++) Apply(two,camera,baseline+Vector3.right*.1f,Quaternion.Euler(0,20,0),1f/120);
        Check(Vector3.Distance(one.transform.position,two.transform.position)<.001f, "30 and 120 fps converge to the same pose");
        UnityEngine.Object.DestroyImmediate(camera.gameObject);
    }
    static void VolcanoChecks() {
        var root=new GameObject("Volcano");
        var whole=new GameObject("Whole").transform; whole.SetParent(root.transform,false);
        var cut=new GameObject("Cutaway").transform; cut.SetParent(root.transform,false);
        var front=new GameObject("Original volcano FRONT half").transform; front.SetParent(cut,false);
        var back=new GameObject("Original volcano BACK half").transform; back.SetParent(cut,false);
        var animator=cut.gameObject.AddComponent<Animator>();
        animator.runtimeAnimatorController=AssetDatabase.LoadAssetAtPath<RuntimeAnimatorController>("Assets/Volcano/Volcano Interior.controller");
        var volcano=root.AddComponent<VolcanoCutaway>(); volcano.wholeModel=whole; volcano.cutawayModel=cut;
        volcano.Reveal();
        Check(!whole.gameObject.activeSelf && cut.gameObject.activeSelf, "Tap activates authored cutaway playback");
        Check(animator.GetCurrentAnimatorStateInfo(0).normalizedTime < .001f, "Reveal starts at the beginning of the original clip");
        Vector3 closed=front.localPosition;
        animator.Update(3.1f);
        Check(Vector3.Distance(front.localPosition,closed)>1, "Original front half visibly separates");
        Check(back.localPosition.magnitude>.1f, "Original back half moves too");
        Check(Quaternion.Angle(front.localRotation,Quaternion.identity)>30, "Original front-half opening rotation plays");
        // The old scripted root rotation must not overwrite the authored split.
        Quaternion authoredRoot=cut.localRotation;
        volcano.AdvanceAnimation(.35f);
        Check(Quaternion.Angle(cut.localRotation,authoredRoot)<.001f, "Reveal preserves the authored root orientation");
        volcano.ResetToWhole();
        Check(whole.gameObject.activeSelf && !cut.gameObject.activeSelf && !volcano.WasClicked, "Reset returns to whole volcano and clears reveal state");
        volcano.Reveal();
        Check(Vector3.Distance(front.localPosition,closed)<.001f && animator.GetCurrentAnimatorStateInfo(0).normalizedTime<.001f, "Repeated tap after reset replays the split from the beginning");
        root.SetActive(false);
        Check(!volcano.WasClicked && !cut.gameObject.activeSelf, "Disabling the model cancels reveal cleanly");
        UnityEngine.Object.DestroyImmediate(root);
    }
}
`);
console.log(`Prepared isolated Unity validation project at ${project}`);
