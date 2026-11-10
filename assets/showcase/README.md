# ImARs web showcase

These are web copies of models from the user's ImARs Unity project. The Unity originals are unchanged.

| Web asset | Unity asset under `Assets/3d MODELS` |
| --- | --- |
| heart.glb | CIRCULATORY/Pumping._heart_final (1).glb |
| earth.glb | MOTION OF THE EARTH/Season of the earth/Season of the Earth.glb |
| volcano.glb | VOLCANIC ACTIVITY/VulcanoSure.glb |

Processed with glTF Transform: deduplicate, weld, resample animation, resize textures to a maximum of 1024 pixels, and prune unused data. The heart mesh is additionally simplified. No remote geometry decoders are required. WebP posters are rendered from these same models.

The self-hosted viewer is Google model-viewer 4.1.0, distributed under Apache 2.0. Its license is in `assets/licenses/model-viewer.txt`. The viewer supports interactive camera controls; see https://modelviewer.dev/examples/stagingandcameras/.
