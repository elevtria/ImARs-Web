# Teacher AR Classroom

Open **AR Classroom** from the teacher dashboard, sidebar, or marker-download
page. The page requires the same verified teacher session as the rest of the
teacher portal. Admin and student accounts cannot open it.

## Classroom controls

- **Scan markers** requests camera permission and recognizes any supported lesson
  marker. There are no topic/model selectors or standalone 3D previews. Opening
  the page loads no model; a model stays hidden until its marker is recognized.
- Show another marker to switch models automatically, one at a time, without
  restarting the camera. Only the recognized model's files are loaded. Expand
  **View this model’s marker** to check or download its image.
- Drag to rotate, use the zoom slider or rotation buttons, and **Reset view**.
- Click the heart or volcano to toggle its interior cutaway, or use **Show inside**.
  **Full model** and **Reset view** restore the whole model. Selecting an internal
  heart part opens the interior automatically; the cutaway and whole view share
  the same marker position rather than appearing side by side. Opening and closing
  use a reversible 0.7-second turn/reveal; the model's eruption clips keep playing.
- **Stop camera** hides and releases the model and returns to the scan prompt.
- **Pause animation** / **Resume animation** freezes the model's animation clips.
  Models without clips show **Static model**.
- Select a model part or label to highlight it and start its narration immediately.
  The current mobile narration plays the description followed by the interactive
  question/answer recording. Timed subtitles appear at the bottom of the model view.
  **Pause narration** / **Resume narration** controls playback without restarting it.
  Tapping a label again restarts its complete narration; another label replaces it.
- Teaching indicators bind to actual mesh vertices near their authored part
  coordinates. They follow rotation, zoom, marker pose, mesh motion, morphing and
  skeletal animation. Empty corners of a model's bounding box cannot leave an
  indicator floating beside the geometry. The same anchor drives its arrow tip.
- Small, transparent ripple circles mark narration spots, including in presentation
  mode. **Hide indicators** / **Show indicators** toggles them independently of
  narration and the label list. Internal heart indicators appear only in the cutaway.
  The pulse respects the device's reduced-motion preference.
- **Show labels** opens the part names inside the camera view. Selecting a part
  displays its title and original mobile description in a compact translucent
  card near the opposite edge, with an arrow to its mesh anchor. The camera view
  keeps its full width; presentation mode uses the same in-camera card. Arrows
  follow rotation, zoom and tracking, and disappear when their part is offscreen
  or the marker is lost.
- **Show labels**, **Full model**, narration mute, and graphics quality controls
  support teaching and presentation.
- **Presentation mode** fills the window with the model/camera and hides the other
  controls. **Show controls** or Escape restores them; animation pause stays available.
- **Screenshot** saves the model/camera image as PNG. **Refresh tracking** restarts
  marker recognition. Camera-switch and flashlight controls are omitted.

Camera access is requested only after **Scan markers**. Camera tracks stop on
Stop camera, hidden tabs, navigation and sign-out. Late permission
grants after cancellation are closed as well. Narration stops when leaving or
changing descriptions. Camera images are processed on the device, not uploaded.
The feature does not create student scores, completion records or AR-time records.

## Teaching assets

All 27 image targets from the Unity app's `Assets/SCENEAR.unity` are represented,
including the heart and volcano interior views. The catalog includes 79
original description/narration bindings. Runtime assets are self-hosted.

Models and label bindings belong to their nearest image target in Unity's
hierarchy. The zodiac marker shows its zodiac model; the nested Orion, Dipper,
and Polaris image targets show only when their own markers are recognized.

Narration and timed caption data were refreshed from the local Unity workspace
at changeset 440, verified against Alliona Barcelon's November 16, 2026 check-in.
Both the description clips and the current interactive question/answer recordings
are included, together with the app's exact caption cue times and answer boundaries.

`js/teacher-ar-catalog.js` maps original marker names to their images, compiled
MindAR targets, models and recorded narration. New copied files use content hashes
under `assets/teacher-ar/`; ten previously optimized models reuse the web showcase.
Full-size Unity originals are unchanged. The heart's FBX interior is converted to
a standalone GLB with embedded textures and reduced mesh density. The volcano's
cutaway uses only the interior half of its source comparison scene. Its model-level
comparison animation is omitted while smoke and lava continue animating.
Unity-specific particle/shader effects are not executed by
the browser; GLB animation clips are used.

Each model recognizes its classroom image plus matching versions from the existing
downloadable marker packs. Compilation composites images onto their print background
before feature extraction, retains earlier app references, and deduplicates equivalent
images. A combined target file maps every recognized image variant to its model,
so the same running scanner can recognize markers across all lessons.
The scanner requests an optional 1280×720 camera image and continuous focus /
exposure where supported. Two successful tracked frames confirm recognition, while
the model remains hidden until recognition. Unsupported camera settings are optional
and do not block older laptop webcams.

Only code/styles are in the shared versioned graph. The numerous content-hashed
teaching files use their own stable URLs, avoiding the host's 100 header-rule limit.

## Rebuilding assets

Normal site builds use the checked-in generated files and need no Unity install
or additional dependencies. The following preparation is only needed after
changing the original Unity content. Run from the repository root.

1. In `tmp/ar-tools`, unpack the official npm packages `mind-ar@1.2.5` into
   `mind/package` and `three@0.160.1` into `three/package` using `npm pack` / `tar`.
2. Install these preparation-only dependencies with `npm install --prefix tmp/ar-tools
   --no-save --ignore-scripts`: `@tensorflow/tfjs@4.16.0`, `@msgpack/msgpack@2.8.0`,
   `mathjs@11.12.0`, `ml-matrix@6.10.4`, `svd-js@1.1.1`, `tinyqueue@2.0.3`,
   `canvas@npm:@napi-rs/canvas@0.1.80`, and `three@0.160.1`.
3. Run `node scripts/read-unity-ar-assets.mjs <Unity-project-Assets-directory>`.
   This reads the scene and asset GUIDs into ignored temporary metadata.
4. Bundle `scripts/compile-teacher-ar-targets.mjs` with esbuild using `platform:
   node`, `packages: external`, and `format: esm`, writing
   `tmp/ar-tools/compile-targets-built.mjs`. Run that output with Node. It prepares
   feature descriptors from each original image, using a maximum working dimension
   of 512 pixels, and writes `.mind` targets. The published marker images are unchanged.
5. Run `node scripts/build-teacher-ar-catalog.mjs` and
   `node scripts/build-teacher-ar-runtime.mjs`. Review the title mapping when
   adding or rearranging Unity targets.
6. Run the AR tests and `npm run build`.

When updating `half.fbx`, run Blender in background mode with
`--python scripts/prepare-teacher-heart.py -- <path-to-half.fbx>` before step 5.
This writes the content-hashed GLB and `scripts/teacher-ar-converted-models.json`.
The catalog builder checks the source fingerprint so an outdated conversion cannot
silently replace a newer mobile cutaway.

The runtime contains two small MindAR integration fixes: the resize callback is
retained for cleanup, and asynchronous tracking-start failures reject normally.
The teacher wrapper owns the camera stream and handles cancellation/cleanup.

## Validation

Automated checks cover asset integrity, embedded model resources, original marker
coverage, teacher-only access, presentation controls, narration, camera consent,
late permission grants, hidden tabs and sign-out. The shipped GLBs for all 27
lessons are loaded with the actual engine to check geometry-bound anchors through
animation, rotation and zoom; the volcano's real eruption clips are exercised too.
Texture decoding is mocked for these geometry checks. Browser camera/WebGL support,
marker stability, physical model alignment, scanning speed, and screenshot
appearance still require a real-device test with the printed markers. Never treat
mock camera tests as physical tracking validation.
