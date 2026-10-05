"""Render isometric + concept-angle match views + mesh stats for a 3D model (headless Blender).

Usage (Blender 4.x / 5.x):
  <Blender> --background --python render_model_iso.py -- \
      --input assets/models/<name>.glb --out .cursor/evidence/tasks/<T>/art/<name> \
      [--size 1024] [--engine workbench|eevee] [--expect-dims "x,y,z"] [--dims-order gltf|blender] \
      [--tolerance 0.25] [--forward -Z|+Z|-X|+X] [--concepts /path/concepts/<stem>]

  --expect-dims is the manifest row's expect_dims, glTF order by default (x width, y height/up,
  z depth); --dims-order blender takes Blender order (x, y depth, z up) instead.
  --forward is the manifest row's forward (glTF axis the model's front faces, default -Z); the
  front / three-quarter / back cameras are placed from it.
  Workbench shows vertex colours when every mesh has a colour attribute; with a mix it keeps
  material colours and stats.json says to re-render with --engine eevee.

Writes into --out:
  iso-ne.png iso-nw.png iso-sw.png iso-se.png   orthographic isometric (35.264° elev)
  match-front.png match-threequarter.png match-back.png
      concept-aligned orthographic cameras (elev ~8°): front, ~45° three-quarter, back
  contact-sheet.png                              2x2 of the four iso views
  compare-sheet.png                              (with --concepts) rows of concept | model
                                                 for front / threequarter / back
  stats.json                                     mesh stats + auto flags + verdict

Exit code 0 = rendered (look at stats.json "auto_verdict"), 2 = import/usage error.
The script never writes into the model's own folder and never modifies the input file.
"""

import argparse
import json
import math
import os
import sys
import warnings

import bpy
import bmesh
from mathutils import Vector

ISO_ELEVATION = math.degrees(math.atan(1.0 / math.sqrt(2.0)))  # 35.264°
VIEWS = (("ne", 45.0), ("nw", 135.0), ("sw", 225.0), ("se", 315.0))
# Camera azimuth (Blender XY plane, Z up) that sits in front of a model facing each glTF axis.
# glTF -Z = Blender +Y, glTF +Z = Blender -Y; X is shared.
FRONT_AZIMUTH = {"-Z": 90.0, "+Z": 270.0, "+X": 0.0, "-X": 180.0}
CONCEPT_ELEVATION = 8.0  # low, so face/outfit read like illustration sheets


def concept_views(forward):
    """front, front-left three-quarter, back — orbiting from the model's facing side."""
    front = FRONT_AZIMUTH[forward]
    return (
        ("front", front, CONCEPT_ELEVATION),
        ("threequarter", (front - 45.0) % 360.0, CONCEPT_ELEVATION),
        ("back", (front + 180.0) % 360.0, CONCEPT_ELEVATION),
    )

CONCEPT_FILES = {
    "front": "concept-front.png",
    "threequarter": "concept-threequarter.png",
    "back": "concept-back.png",
}


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    # argparse reads "-Z" as an option; glue "--forward -Z" into "--forward=-Z".
    for i, a in enumerate(argv[:-1]):
        if a == "--forward" and argv[i + 1] in FRONT_AZIMUTH:
            argv[i : i + 2] = [f"--forward={argv[i + 1]}"]
            break
    p = argparse.ArgumentParser(prog="render_model_iso.py")
    p.add_argument("--input", required=True, help=".glb/.gltf/.fbx/.obj model path")
    p.add_argument("--out", required=True, help="evidence dir for pngs + stats.json")
    p.add_argument("--size", type=int, default=1024, help="square render size in px")
    p.add_argument("--engine", choices=("workbench", "eevee"), default="workbench")
    p.add_argument(
        "--expect-dims",
        default="",
        help='expected world size "x,y,z" (manifest expect_dims); empty = skip',
    )
    p.add_argument("--dims-order", choices=("gltf", "blender"), default="gltf",
                   help="axis order of --expect-dims: gltf = x, y up, z (manifest); blender = x, y, z up")
    p.add_argument("--forward", choices=tuple(FRONT_AZIMUTH), default="-Z",
                   help="glTF axis the model's front faces (manifest forward)")
    p.add_argument("--tolerance", type=float, default=0.25, help="relative dims tolerance")
    p.add_argument("--inward-ratio", type=float, default=0.0,
                   help="flag if faces of inside-out closed parts exceed this share")
    p.add_argument(
        "--concepts",
        default="",
        help="dir with concept-front/threequarter/back.png → also write compare-sheet.png",
    )
    return p.parse_args(argv)


def fail(msg, code=2):
    print(f"[render_model_iso] ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def import_model(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == ".obj":
        if hasattr(bpy.ops.wm, "obj_import"):
            bpy.ops.wm.obj_import(filepath=path)
        else:
            bpy.ops.import_scene.obj(filepath=path)
    else:
        fail(f"unsupported extension {ext}")


def mesh_objects():
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


def world_bbox(objs):
    lo = Vector((math.inf,) * 3)
    hi = Vector((-math.inf,) * 3)
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
    return lo, hi


def mesh_stats(obj, depsgraph):
    ev = obj.evaluated_get(depsgraph)
    me = ev.to_mesh()
    bm = bmesh.new()
    bm.from_mesh(me)
    raw_verts = len(bm.verts)
    # glTF/FBX exporters split vertices per flat-shaded face / UV seam; weld them back so
    # boundary/manifold counts describe the real surface, not the export encoding.
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.normal_update()
    bm.verts.ensure_lookup_table()
    bm.edges.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    bm.faces.index_update()

    loose_verts = sum(1 for v in bm.verts if not v.link_edges)
    loose_edges = sum(1 for e in bm.edges if not e.link_faces)
    boundary_edges = sum(1 for e in bm.edges if len(e.link_faces) == 1)
    non_manifold_edges = sum(1 for e in bm.edges if not e.is_manifold)
    degenerate_faces = sum(1 for f in bm.faces if f.calc_area() < 1e-9)
    tris = sum(max(len(f.verts) - 2, 0) for f in bm.faces)

    # Inside-out parts: a closed island with negative signed volume has every normal pointing in.
    # (A centroid test flags rings, concave shapes and inner walls that are correct.)
    inward = inverted_islands = 0
    seen = set()
    for start in bm.faces:
        if start.index in seen:
            continue
        island, stack = [], [start]
        seen.add(start.index)
        while stack:
            f = stack.pop()
            island.append(f)
            for e in f.edges:
                for g in e.link_faces:
                    if g.index not in seen:
                        seen.add(g.index)
                        stack.append(g)
        closed = all(len(e.link_faces) == 2 for f in island for e in f.edges)
        if not closed:
            continue  # open shells are already reported as boundary edges
        volume = 0.0
        for f in island:
            v0 = f.verts[0].co
            for i in range(1, len(f.verts) - 1):
                volume += v0.dot(f.verts[i].co.cross(f.verts[i + 1].co)) / 6.0
        if volume < 0:
            inverted_islands += 1
            inward += len(island)
    # A manifold edge whose two faces wind the same way: some faces in that island are flipped.
    flipped_edges = sum(1 for e in bm.edges if e.is_manifold and not e.is_contiguous)

    stats = {
        "object": obj.name,
        "verts_exported": raw_verts,
        "verts": len(bm.verts),
        "edges": len(bm.edges),
        "faces": len(bm.faces),
        "tris": tris,
        "loose_verts": loose_verts,
        "loose_edges": loose_edges,
        "boundary_edges": boundary_edges,
        "non_manifold_edges": non_manifold_edges,
        "degenerate_faces": degenerate_faces,
        "inward_facing_faces": inward,
        "inward_ratio": round(inward / len(bm.faces), 4) if bm.faces else 0.0,
        "inverted_islands": inverted_islands,
        "flipped_normal_edges": flipped_edges,
        "vertex_colors": [a.name for a in me.color_attributes],
        "materials": [m.name for m in obj.data.materials if m] if obj.data else [],
        "uv_layers": len(me.uv_layers),
        "dimensions": [round(v, 4) for v in obj.dimensions],
    }
    bm.free()
    ev.to_mesh_clear()
    return stats


def setup_render(scene, engine, size, vertex_colors=False):
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = False

    if engine == "eevee":
        for name in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
            try:
                scene.render.engine = name
                break
            except TypeError:
                continue
    else:
        scene.render.engine = "BLENDER_WORKBENCH"
        sh = scene.display.shading
        sh.light = "STUDIO"
        sh.color_type = "VERTEX" if vertex_colors else "MATERIAL"
        sh.show_backface_culling = True  # missing faces render as see-through holes
        sh.show_cavity = True
        sh.show_object_outline = True
        sh.show_shadows = False

    world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    scene.world = world
    with warnings.catch_warnings():  # `use_nodes` is deprecated in 5.x, gone in 6.0
        warnings.simplefilter("ignore", DeprecationWarning)
        if hasattr(world, "use_nodes") and not world.use_nodes:
            world.use_nodes = True
    bg = world.node_tree.nodes.get("Background") if world.node_tree else None
    if bg:
        bg.inputs[0].default_value = (0.18, 0.18, 0.20, 1.0)  # neutral gray: holes read clearly
        bg.inputs[1].default_value = 1.0

    if engine == "eevee":
        sun = bpy.data.lights.new("KeySun", type="SUN")
        sun.energy = 3.0
        sun_obj = bpy.data.objects.new("KeySun", sun)
        scene.collection.objects.link(sun_obj)
        sun_obj.rotation_euler = (math.radians(50), math.radians(10), math.radians(35))


def make_camera(scene, center, radius):
    cam = bpy.data.cameras.new("IsoCam")
    cam.type = "ORTHO"
    cam.ortho_scale = radius * 2.2
    cam.clip_start = 0.01
    cam.clip_end = radius * 20 + 10
    cam_obj = bpy.data.objects.new("IsoCam", cam)
    scene.collection.objects.link(cam_obj)
    scene.camera = cam_obj
    return cam_obj


def aim_camera(cam_obj, center, radius, azimuth_deg, elevation_deg=None):
    az = math.radians(azimuth_deg)
    el = math.radians(ISO_ELEVATION if elevation_deg is None else elevation_deg)
    dist = radius * 6.0
    pos = center + Vector(
        (dist * math.cos(el) * math.cos(az), dist * math.cos(el) * math.sin(az), dist * math.sin(el))
    )
    cam_obj.location = pos
    cam_obj.rotation_euler = (center - pos).to_track_quat("-Z", "Y").to_euler()


def render_to(scene, path):
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def _load_rgba(path, size):
    """Load image as float HxWx4, resized/padded to size×size (letterbox on neutral gray)."""
    import numpy as np

    img = bpy.data.images.load(path)
    w, h = img.size[0], img.size[1]
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    bpy.data.images.remove(img)
    # letterbox into size×size
    scale = min(size / w, size / h)
    nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
    # nearest-neighbor resize (no PIL)
    ys = (np.linspace(0, h - 1, nh)).astype(np.int32)
    xs = (np.linspace(0, w - 1, nw)).astype(np.int32)
    resized = px[ys][:, xs]
    canvas = np.full((size, size, 4), 0.18, dtype=np.float32)
    canvas[:, :, 3] = 1.0
    y0 = (size - nh) // 2
    x0 = (size - nw) // 2
    canvas[y0 : y0 + nh, x0 : x0 + nw] = resized
    return canvas


def contact_sheet(paths, out_path, size):
    """2x2 grid via bpy image pixel buffers (no PIL in Blender's python)."""
    try:
        import numpy as np
    except ImportError:
        return False
    sheet = np.zeros((size * 2, size * 2, 4), dtype=np.float32)
    order = [("nw", 0, 0), ("ne", 0, 1), ("sw", 1, 0), ("se", 1, 1)]
    for label, row, col in order:
        img = bpy.data.images.load(paths[label])
        px = np.array(img.pixels[:], dtype=np.float32).reshape(img.size[1], img.size[0], 4)
        if px.shape[0] != size or px.shape[1] != size:
            bpy.data.images.remove(img)
            return False
        r0 = (1 - row) * size
        sheet[r0 : r0 + size, col * size : (col + 1) * size, :] = px
        bpy.data.images.remove(img)
    sheet[size - 2 : size + 2, :, :] = 1.0
    sheet[:, size - 2 : size + 2, :] = 1.0
    out = bpy.data.images.new("contact", width=size * 2, height=size * 2, alpha=True)
    out.pixels = sheet.ravel().tolist()
    out.filepath_raw = out_path
    out.file_format = "PNG"
    out.save()
    bpy.data.images.remove(out)
    return True


def compare_sheet(concept_dir, match_paths, out_path, size):
    """3 rows × 2 cols: concept | model for front, threequarter, back."""
    try:
        import numpy as np
    except ImportError:
        return False
    rows = ("front", "threequarter", "back")
    sheet = np.full((size * 3, size * 2, 4), 0.12, dtype=np.float32)
    sheet[:, :, 3] = 1.0
    for ri, label in enumerate(rows):
        concept_path = os.path.join(concept_dir, CONCEPT_FILES[label])
        if not os.path.isfile(concept_path):
            print(f"[render_model_iso] WARN: missing concept for compare: {concept_path}")
            continue
        if label not in match_paths or not os.path.isfile(match_paths[label]):
            continue
        left = _load_rgba(concept_path, size)
        right_img = bpy.data.images.load(match_paths[label])
        right = np.array(right_img.pixels[:], dtype=np.float32).reshape(
            right_img.size[1], right_img.size[0], 4
        )
        bpy.data.images.remove(right_img)
        if right.shape[0] != size or right.shape[1] != size:
            return False
        # sheet row 0 = top → flip
        r0 = (2 - ri) * size
        sheet[r0 : r0 + size, 0:size, :] = left
        sheet[r0 : r0 + size, size : size * 2, :] = right
    # separators
    for i in range(1, 3):
        y = i * size
        sheet[y - 2 : y + 2, :, :] = 1.0
    sheet[:, size - 2 : size + 2, :] = 1.0
    out = bpy.data.images.new("compare", width=size * 2, height=size * 3, alpha=True)
    out.pixels = sheet.ravel().tolist()
    out.filepath_raw = out_path
    out.file_format = "PNG"
    out.save()
    bpy.data.images.remove(out)
    return True


def main():
    args = parse_args()
    in_path = os.path.abspath(args.input)
    out_dir = os.path.abspath(args.out)
    if not os.path.isfile(in_path):
        fail(f"input not found: {in_path}")
    if os.path.commonpath([out_dir, os.path.dirname(in_path)]) == os.path.dirname(in_path):
        fail("--out must not be inside the model folder (evidence stays out of art_paths)")
    os.makedirs(out_dir, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    import_model(in_path)

    objs = mesh_objects()
    if not objs:
        fail("no mesh objects after import")

    depsgraph = bpy.context.evaluated_depsgraph_get()
    per_obj = [mesh_stats(o, depsgraph) for o in objs]
    lo, hi = world_bbox(objs)
    dims = hi - lo
    center = (lo + hi) * 0.5
    radius = max(dims.length * 0.5, 1e-3)

    colored = [bool(s["vertex_colors"]) for s in per_obj]
    setup_render(scene, args.engine, args.size, vertex_colors=all(colored))
    cam = make_camera(scene, center, radius)
    view_paths = {}
    for label, az in VIEWS:
        aim_camera(cam, center, radius, az)
        path = os.path.join(out_dir, f"iso-{label}.png")
        render_to(scene, path)
        view_paths[label] = path
    sheet_ok = contact_sheet(view_paths, os.path.join(out_dir, "contact-sheet.png"), args.size)

    match_paths = {}
    for label, az, elev in concept_views(args.forward):
        aim_camera(cam, center, radius, az, elevation_deg=elev)
        path = os.path.join(out_dir, f"match-{label}.png")
        render_to(scene, path)
        match_paths[label] = path

    compare_ok = False
    concept_dir = os.path.abspath(args.concepts) if args.concepts else ""
    if concept_dir:
        if not os.path.isdir(concept_dir):
            fail(f"--concepts dir not found: {concept_dir}")
        compare_ok = compare_sheet(
            concept_dir, match_paths, os.path.join(out_dir, "compare-sheet.png"), args.size
        )

    total = {k: sum(s[k] for s in per_obj) for k in ("verts", "faces", "tris", "loose_verts",
             "loose_edges", "boundary_edges", "non_manifold_edges", "degenerate_faces",
             "inward_facing_faces", "inverted_islands", "flipped_normal_edges")}
    flags = []
    if total["faces"] == 0:
        flags.append("no faces at all")
    for s in per_obj:
        if s["faces"] == 0:
            flags.append(f"{s['object']}: empty mesh (0 faces)")
    if total["boundary_edges"]:
        flags.append(f"{total['boundary_edges']} boundary edges → open holes / missing faces")
    if total["loose_verts"]:
        flags.append(f"{total['loose_verts']} loose vertices")
    if total["loose_edges"]:
        flags.append(f"{total['loose_edges']} loose edges")
    if total["degenerate_faces"]:
        flags.append(f"{total['degenerate_faces']} zero-area faces")
    if total["faces"] and total["inward_facing_faces"] / total["faces"] > args.inward_ratio:
        flags.append(
            f"{total['inverted_islands']} closed part(s) inside out ({total['inward_facing_faces']}"
            f"/{total['faces']} faces) → flipped normals"
        )
    if total["flipped_normal_edges"]:
        flags.append(f"{total['flipped_normal_edges']} edges between faces of opposite winding → "
                     "some faces flipped")
    notes = []
    if any(colored) and not all(colored) and args.engine == "workbench":
        notes.append("vertex colours on some meshes only: workbench shows material colours; "
                     "re-render with --engine eevee to judge colour")
    expected = None
    if args.expect_dims:
        try:
            expected = [float(x) for x in args.expect_dims.split(",")]
        except ValueError:
            fail('--expect-dims must be "w,h,d"')
        if len(expected) != 3:
            fail('--expect-dims must be "w,h,d"')
        if args.dims_order == "gltf":  # x, y up, z → Blender x, y (= -glTF z), z up
            expected = [expected[0], expected[2], expected[1]]
        names = "x", ("z" if args.dims_order == "gltf" else "y"), ("y" if args.dims_order == "gltf" else "z")
        for axis, (got, want) in enumerate(zip(dims, expected)):
            if want > 0 and abs(got - want) / want > args.tolerance:
                flags.append(f"dimension {args.dims_order} {names[axis]}={got:.3f} vs expected {want:.3f}")

    stats = {
        "input": in_path,
        "blender": bpy.app.version_string,
        "engine": scene.render.engine,
        "size_px": args.size,
        "views": {k: os.path.relpath(v, out_dir) for k, v in view_paths.items()},
        "match_views": {k: os.path.relpath(v, out_dir) for k, v in match_paths.items()},
        "contact_sheet": "contact-sheet.png" if sheet_ok else None,
        "compare_sheet": "compare-sheet.png" if compare_ok else None,
        "concepts_dir": concept_dir or None,
        "objects": per_obj,
        "totals": total,
        "bbox_min": [round(v, 4) for v in lo],
        "bbox_max": [round(v, 4) for v in hi],
        "dimensions": [round(v, 4) for v in dims],
        "dimensions_gltf": [round(dims[0], 4), round(dims[2], 4), round(dims[1], 4)],
        "expected_dimensions": expected,
        "dims_order": args.dims_order,
        "forward": args.forward,
        "vertex_colors_shown": args.engine == "eevee" or all(colored),
        "auto_flags": flags,
        "auto_verdict": "FLAGGED" if flags else "CLEAN",
        "render_notes": notes,
        "note": "auto_verdict only covers topology + size. Read contact-sheet.png AND "
        "compare-sheet.png (concept | model per angle) before writing VERDICT.",
    }
    with open(os.path.join(out_dir, "stats.json"), "w", encoding="utf-8") as fh:
        json.dump(stats, fh, indent=2)

    print(f"[render_model_iso] {os.path.basename(in_path)}: {stats['auto_verdict']} "
          f"verts={total['verts']} faces={total['faces']} dims={stats['dimensions']}")
    for f in flags:
        print(f"[render_model_iso]   flag: {f}")
    print(f"[render_model_iso] evidence → {out_dir}")


if __name__ == "__main__":
    main()
