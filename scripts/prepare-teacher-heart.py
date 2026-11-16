"""Preparation only: Blender --background --python scripts/prepare-teacher-heart.py -- <half.fbx>.

Read the mobile cutaway without changing the Unity project. Publish a textured,
standalone GLB and its source fingerprint for the catalog builder.
"""
import bpy
import hashlib
import json
import sys
import tempfile
from pathlib import Path

source = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
root = Path(__file__).resolve().parent.parent
scratch = root / "tmp/ar-tools/blender-temp"
scratch.mkdir(parents=True, exist_ok=True)
tempfile.tempdir = str(scratch)
output = root / "tmp/ar-tools/heart-cutaway.glb"
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=str(source), use_anim=True)
meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
print("CUTAWAY_IMPORT", [(obj.name, len(obj.data.polygons)) for obj in meshes])

# Keep the authored interior anatomy while reducing excessive mesh density.
for obj in meshes:
    if len(obj.data.polygons) > 120000:
        bpy.context.view_layer.objects.active = obj
        modifier = obj.modifiers.new("Classroom mesh budget", "DECIMATE")
        modifier.ratio = 120000 / len(obj.data.polygons)
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    for material in obj.data.materials:
        if not material or not material.use_nodes:
            continue
        for node in material.node_tree.nodes:
            if node.type == "TEX_IMAGE" and node.image:
                image = node.image
                if max(image.size) > 2048:
                    scale = 2048 / max(image.size)
                    image.scale(round(image.size[0] * scale), round(image.size[1] * scale))

bpy.ops.export_scene.gltf(filepath=str(output), export_format="GLB",
    export_image_format="JPEG", export_jpeg_quality=88, export_animations=True,
    export_cameras=False, export_lights=False)
data = output.read_bytes()
if len(data) > 25 * 1024 * 1024:
    raise ValueError("Cutaway exceeds the hosting asset limit")
name = "heart-cutaway-" + hashlib.sha256(data).hexdigest()[:16] + ".glb"
published = root / "assets/teacher-ar" / name
published.write_bytes(data)
manifest = {"half.fbx": {"url": "/assets/teacher-ar/" + name,
    "sourceHash": hashlib.sha256(source.read_bytes()).hexdigest()}}
(root / "scripts/teacher-ar-converted-models.json").write_text(json.dumps(manifest, indent=2) + "\n")
print("CUTAWAY_EXPORT", name, len(data))
