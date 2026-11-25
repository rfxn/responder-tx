"""Per-gauge stage plausibility for the published crest list and playback (raw stays in git, E6); README "Scripts"."""
import collections
import json
import os

OVER_REFERENCE = 3
SUSTAIN_WINDOW_S = 90 * 60
SUSTAIN_NEAR = 0.9
SUSTAIN_FLOOR = 0.5


def stage_refs(root):
    """lid -> (record_ft, major_ft), either None."""
    def load(name):
        try:
            with open(os.path.join(root, "data", name), encoding="utf-8") as f:
                d = json.load(f)
            return d if isinstance(d, dict) else {}
        except (OSError, ValueError):
            return {}

    def pos(v):
        return v if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 else None

    records, meta = load("records.json").get("records") or {}, load("gauge-meta.json")
    return {lid: (pos((records.get(lid) or {}).get("record_ft")),
                  pos((meta.get(lid) or {}).get("major") if isinstance(meta.get(lid), dict) else None))
            for lid in set(records) | set(meta)}


class Plausibility:
    """Feed each gauge's distinct observations in time order, then ask which readings are no reading."""

    def __init__(self, refs):
        self.refs = refs
        self.recent = collections.defaultdict(collections.deque)
        self.open = collections.defaultdict(list)
        self.waiting = collections.defaultdict(list)
        self.cands = []
        self.keys = set()
        self._dropped = None

    def over_reference(self, lid, stage):
        record, major = self.refs.get(lid, (None, None))
        ref = max([v for v in (record, major) if v] or [0])
        return bool(ref) and stage > OVER_REFERENCE * ref

    def high(self, lid, stage):
        record, major = self.refs.get(lid, (None, None))
        return bool((major and stage >= major) or (record and stage > record))

    def observe(self, lid, t, stage):
        """t is the observation's validTime in epoch seconds; a voided reading is no neighbour either."""
        if t is None or lid not in self.refs or self.over_reference(lid, stage):
            return
        recent = self.recent[lid]
        while recent and t - recent[0][0] > SUSTAIN_WINDOW_S:
            recent.popleft()
        still = []
        for c in self.open[lid]:
            if t - c["t"] <= SUSTAIN_WINDOW_S:
                c["window"].append((t, stage))
                still.append(c)
        self.open[lid] = still
        for c in self.waiting.pop(lid, []):
            c["next"] = (t, stage)
        if self.high(lid, stage):
            c = {"lid": lid, "t": t, "stage": stage, "window": list(recent), "next": None}
            self.cands.append(c)
            self.open[lid].append(c)
            self.waiting[lid].append(c)
            self.keys.add((lid, t))
        recent.append((t, stage))

    def is_candidate(self, lid, t):
        return (lid, t) in self.keys

    def dropped(self):
        """(lid, t) of every unsustained high reading, judged highest first so a dropped reading supports none."""
        if self._dropped is not None:
            return self._dropped
        drop = set()
        for c in sorted(self.cands, key=lambda c: -c["stage"]):
            window = sorted(c["window"])
            x, lid = c["stage"], c["lid"]
            sustained = False
            for t2, s2 in window:
                if s2 < SUSTAIN_NEAR * x or (lid, t2) in drop:
                    continue
                lo, hi = sorted((c["t"], t2))
                if any(lo < t3 < hi and s3 < SUSTAIN_FLOOR * x for t3, s3 in window):
                    continue
                sustained = True
                break
            nxt = c["next"]
            if not sustained and nxt is None:
                sustained = True  # unconfirmed: nothing has reported since, which is no evidence against it
            if not sustained:  # contradicted only when the first later reading, however late, falls under half
                sustained = nxt[1] >= SUSTAIN_FLOOR * x and (lid, nxt[0]) not in drop
            if not sustained:
                drop.add((lid, c["t"]))
        self._dropped = drop
        return drop

    def void(self, lid, t, stage):
        return self.over_reference(lid, stage) or (lid, t) in self.dropped()
