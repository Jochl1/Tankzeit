#!/usr/bin/env python3
"""Erzeugt SYNTHETISCHE Preisdaten im Format des Tankerkönig-Daten-Repos – nur zum Testen von
build_profiles.py, solange kein Zugang zu den echten Historiendaten besteht.
Die Ergebnisse sind ausgedacht und dürfen nicht als echte Auswertung verwendet werden.

    python3 tools/make_synthetic_history.py --out /tmp/tk-synth --since 2026-04-01 --days 90
    python3 tools/build_profiles.py --data /tmp/tk-synth --plz 04 --out /tmp/tk-profiles
"""
from __future__ import annotations

import argparse
import json
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
TZ = ZoneInfo("Europe/Berlin")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--since", default="2026-04-01")
    ap.add_argument("--days", type=int, default=90)
    ap.add_argument("--stations", type=int, default=30)
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    rng = np.random.default_rng(a.seed)
    gen = json.loads((ROOT / "app" / "data" / "generic-profile.json").read_text())

    sts = []
    for i in range(a.stations):
        plz = f"04{rng.integers(100, 500):03d}" if i < a.stations - 4 else f"06{rng.integers(100, 999):03d}"
        sts.append({
            "uuid": str(uuid.UUID(int=int(rng.integers(0, 2**63)) << 64 | i)),
            "name": f"Synthetische Tankstelle {i + 1}", "brand": "SYNTH", "street": "Teststraße",
            "house_number": str(i + 1), "post_code": plz, "city": "Testort",
            "latitude": 51.34 + rng.normal(0, 0.03), "longitude": 12.30 + rng.normal(0, 0.05),
            "offset": rng.normal(0, 2.5),              # Preisniveau ggü. Region (ct)
            "amp": rng.uniform(0.7, 1.3),              # Stärke des Tagesmusters
            "breaker": rng.random() < 0.2,             # hält sich nicht an die 12-Uhr-Regel
        })
    dow_eff = np.array([0.6, 0.2, 0.0, -0.2, 0.1, -0.4, -0.3])  # Mo..So, ct (ausgedacht)
    start = date.fromisoformat(a.since)
    level = {"e5": 185.0, "e10": 179.0, "diesel": 172.0}

    for k in range(a.days + 1):
        d = start + timedelta(days=k)
        for f in level:
            level[f] += rng.normal(0, 0.6)
        stdir = a.out / "stations" / f"{d:%Y}" / f"{d:%m}"
        stdir.mkdir(parents=True, exist_ok=True)
        with open(stdir / f"{d:%Y-%m-%d}-stations.csv", "w") as fh:
            fh.write("uuid,name,brand,street,house_number,post_code,city,latitude,longitude,first_active,openingtimes_json\n")
            for s in sts:
                fh.write(f'{s["uuid"]},{s["name"]},{s["brand"]},{s["street"]},{s["house_number"]},'
                         f'{s["post_code"]},{s["city"]},{s["latitude"]:.6f},{s["longitude"]:.6f},'
                         f'1970-01-01 01:00:00+01,{{}}\n')
        rows = []
        for s in sts:
            prev = None
            for slot in range(48):
                minute = slot * 30 + int(rng.integers(0, 25))
                ts = datetime(d.year, d.month, d.day, minute // 60, minute % 60, int(rng.integers(0, 60)), tzinfo=TZ)
                if s["breaker"] and slot in (14, 15) and rng.random() < 0.5:
                    bump = 4.0                          # unerlaubte Erhöhung morgens
                else:
                    bump = 0.0
                vals = {}
                for f in level:
                    g = gen["fuels"][f][slot] * s["amp"]
                    vals[f] = round((level[f] + s["offset"] + g + dow_eff[d.weekday()] + bump
                                     + rng.normal(0, 0.4)) / 100, 3) - 0.001 * (rng.random() < 0.7)
                if prev is None or any(abs(vals[f] - prev[f]) >= 0.005 for f in vals) or slot == 24:
                    rows.append((ts, s["uuid"], vals))
                    prev = vals
        rows.sort(key=lambda r: r[0])
        pdir = a.out / "prices" / f"{d:%Y}" / f"{d:%m}"
        pdir.mkdir(parents=True, exist_ok=True)
        with open(pdir / f"{d:%Y-%m-%d}-prices.csv", "w") as fh:
            fh.write("date,station_uuid,diesel,e5,e10,dieselchange,e5change,e10change\n")
            for ts, sid, v in rows:
                fh.write(f"{ts.isoformat(sep=' ')},{sid},{v['diesel']:.3f},{v['e5']:.3f},{v['e10']:.3f},1,1,1\n")
    print(f"Synthetische Daten: {a.stations} Tankstellen, {a.days + 1} Tage -> {a.out}")


if __name__ == "__main__":
    main()
