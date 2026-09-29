"""data/event.json aoArea membership for the generators and cycle-check.sh; twin of js/core.js aoContains()."""
import hashlib
import json
import math

MI_PER_DEG = 69.0


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def parse(area):
    """Open ring of (lat, lon) plus bufferMi and bounds, or None; one bad vertex rejects it all."""
    if not isinstance(area, dict):
        return None
    buf, poly = area.get("bufferMi"), area.get("polygon")
    if not _num(buf) or buf < 0 or not isinstance(poly, list):
        return None
    pts = []
    for v in poly:
        if not (isinstance(v, (list, tuple)) and len(v) == 2 and _num(v[0]) and _num(v[1])
                and -90 <= v[0] <= 90 and -180 <= v[1] <= 180):
            return None
        pts.append((float(v[0]), float(v[1])))
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    if len(pts) < 3:
        return None
    lats, lons = [p[0] for p in pts], [p[1] for p in pts]
    return {"polygon": pts, "bufferMi": float(buf),
            "s": min(lats), "n": max(lats), "w": min(lons), "e": max(lons)}


def fingerprint(area):
    """Short stable id, so fetch-snapshot.py can tell an AO re-target from a partial fetch."""
    if area is None:
        return None
    blob = json.dumps([area["polygon"], area["bufferMi"]], separators=(",", ":"))
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:12]


def _inside(pts, lat, lon):
    inside = False
    j = len(pts) - 1
    for i in range(len(pts)):
        yi, xi = pts[i]
        yj, xj = pts[j]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def contains(area, lat, lon):
    """Inside the outline or within bufferMi of it (planar miles, lon scaled by cos(lat)); None = no clip."""
    if area is None:
        return True
    if not _num(lat) or not _num(lon):
        return False
    pts, buf = area["polygon"], area["bufferMi"]
    if _inside(pts, lat, lon):
        return True
    ky = MI_PER_DEG
    kx = math.cos(lat * math.pi / 180) * MI_PER_DEG
    # exact under this metric: every edge lies further than buf along one axis
    if (area["s"] - lat) * ky > buf or (lat - area["n"]) * ky > buf \
            or (area["w"] - lon) * kx > buf or (lon - area["e"]) * kx > buf:
        return False
    lim = buf * buf
    j = len(pts) - 1
    for i in range(len(pts)):
        ax, ay = (pts[j][1] - lon) * kx, (pts[j][0] - lat) * ky
        bx, by = (pts[i][1] - lon) * kx, (pts[i][0] - lat) * ky
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy
        t = 0.0 if l2 == 0 else min(1.0, max(0.0, -(ax * dx + ay * dy) / l2))
        cx, cy = ax + t * dx, ay + t * dy
        if cx * cx + cy * cy <= lim:
            return True
        j = i
    return False


def in_bbox(bbox, lat, lon):
    """bbox is (xmin, ymin, xmax, ymax), fetch-snapshot.py's tuple order."""
    if not _num(lat) or not _num(lon):
        return False
    return bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]


def in_scope(bbox, area, lat, lon):
    return in_bbox(bbox, lat, lon) and contains(area, lat, lon)
