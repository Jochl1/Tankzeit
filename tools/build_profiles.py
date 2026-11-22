#!/usr/bin/env python3
"""Berechnet Preisprofile pro Tankstelle aus der Tankerkönig-Historie und schreibt sie als
regionale Kacheln nach app/data/profiles/.

Voraussetzung: lokaler Klon des Tankerkönig-Daten-Repos (Zugang nach Registrierung, siehe README),
mit den Ordnern  prices/JJJJ/MM/JJJJ-MM-TT-prices.csv  und  stations/JJJJ/MM/JJJJ-MM-TT-stations.csv

    python3 tools/build_profiles.py --data ~/tankerkoenig-data --plz 04 --since 2026-04-01

Was berechnet wird (Werte in 1/10 ct, gerundet, damit die Dateien klein bleiben):
  regional[fuel].hod_dow  7×48  typische Abweichung vom Tagesmittel je Wochentag und 30-Min.-Slot
  regional[fuel].dow      7     Wochentagseffekt (Tagesmittel ggü. gleitendem 7-Tage-Mittel)
  stations[id][fuel].hod  48    Tagesprofil der Tankstelle (über alle Wochentage)
  stations[id][fuel].dow  7     Wochentagseffekt der Tankstelle
  stations[id][fuel].off  1     mittlerer Abstand zum regionalen Durchschnittspreis
Zusätzlich ein Backtest der App-Regel gegen "sofort tanken" (siehe backtest()).

Lizenz der Ausgangsdaten: CC BY-NC-SA 4.0 (Tankerkönig) – die Kacheln erben diese Lizenz.
"""
from __future__ import annotations

import argparse
import json
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

FUELS = ("e5", "e10", "diesel")
SLOT_MIN = 30
SLOTS = 24 * 60 // SLOT_MIN
TZ = "Europe/Berlin"
OUT = Path(__file__).resolve().parent.parent / "app" / "data" / "profiles"

# Entscheidungsregel – muss zu app/js/decision.js passen
WAIT_THRESHOLD_CT = 1.5     # erst ab dieser erwarteten Ersparnis (ct/l) wird "Warten" empfohlen
HORIZON_H = 24              # so weit schaut die Regel nach vorn


# ---------------------------------------------------------------- Laden

def day_files(root: Path, kind: str, start: date, end: date):
    d = start
    while d <= end:
        p = root / kind / f"{d:%Y}" / f"{d:%m}" / f"{d:%Y-%m-%d}-{kind}.csv"
        if p.exists():
            yield d, p
        d += timedelta(days=1)


def load_stations(root: Path, end: date, prefixes: list[str]) -> pd.DataFrame:
    files = list(day_files(root, "stations", end - timedelta(days=40), end))
    if not files:
        raise SystemExit(f"Keine Stationsdatei unter {root}/stations gefunden.")
    st = pd.read_csv(files[-1][1], dtype={"post_code": str})
    st["post_code"] = st.post_code.fillna("").str.strip().str.zfill(5)
    st = st[st.post_code.str[:len(prefixes[0])].isin(prefixes)] if prefixes else st
    return st[["uuid", "name", "brand", "post_code", "city", "latitude", "longitude"]]


def load_prices(root: Path, start: date, end: date, ids: set[str]) -> pd.DataFrame:
    parts = []
    for d, p in day_files(root, "prices", start, end):
        df = pd.read_csv(p, usecols=["date", "station_uuid", *FUELS])
        df = df[df.station_uuid.isin(ids)]
        parts.append(df)
    if not parts:
        raise SystemExit("Keine Preisdateien im Zeitraum gefunden.")
    df = pd.concat(parts, ignore_index=True)
    df["date"] = pd.to_datetime(df.date, utc=True).dt.tz_convert(TZ)
    for f in FUELS:
        df.loc[df[f] <= 0.5, f] = np.nan   # 0/negativ = kein Preis
    return df.sort_values(["station_uuid", "date"])


def to_grid(prices: pd.DataFrame, fuel: str, start: date, end: date) -> pd.DataFrame:
    """Preis in Kraft zur Slot-Mitte, Zeilen = Slots, Spalten = Tankstellen (in ct/l)."""
    idx = pd.date_range(pd.Timestamp(start, tz=TZ), pd.Timestamp(end + timedelta(days=1), tz=TZ),
                        freq=f"{SLOT_MIN}min", inclusive="left") + pd.Timedelta(minutes=SLOT_MIN // 2)
    wide = (prices.dropna(subset=[fuel])
            .pivot_table(index="date", columns="station_uuid", values=fuel, aggfunc="last"))
    wide = wide.reindex(wide.index.union(idx)).sort_index().ffill().reindex(idx)
    return wide * 100


# ---------------------------------------------------------------- Profile

def slot_of(index: pd.DatetimeIndex) -> np.ndarray:
    return (index.hour * 60 + index.minute) // SLOT_MIN


def profiles(grid: pd.DataFrame):
    day = grid.index.normalize()
    daymean = grid.groupby(day).transform("mean")
    dev = grid - daymean                                   # Abweichung vom Tagesmittel
    slot, dow = slot_of(grid.index), grid.index.dayofweek

    # Tagesmittel je Tankstelle, Wochentagseffekt = Abweichung vom zentrierten 7-Tage-Mittel
    dm = grid.groupby(day).mean()
    dow_dev = dm - dm.rolling(7, center=True, min_periods=5).mean()
    dow_idx = dow_dev.index.dayofweek

    regional_mean = grid.mean(axis=1)
    out_reg = {
        "hod_dow": dev.mean(axis=1).groupby([dow, slot]).mean().unstack().reindex(range(7)).values,
        "dow": dow_dev.mean(axis=1).groupby(dow_idx).mean().reindex(range(7)).values,
    }
    st_hod = dev.groupby(slot).mean()                      # 48 × Tankstellen
    st_dow = dow_dev.groupby(dow_idx).mean().reindex(range(7))
    st_off = grid.sub(regional_mean, axis=0).mean()
    st_days = grid.notna().groupby(day).any().sum()
    return out_reg, st_hod, st_dow, st_off, st_days


def deci(a) -> list:
    """ct -> ganzzahlige 1/10 ct, NaN -> None (kompakt und gzip-freundlich)."""
    arr = np.asarray(a, dtype=float)
    return [None if np.isnan(v) else int(round(v * 10)) for v in arr.ravel()]


# ---------------------------------------------------------------- Backtest

def expected_path(hod: np.ndarray, s0: int, steps: int) -> np.ndarray:
    """Erwartete Preisänderung relativ zu jetzt für die nächsten `steps` Slots."""
    idx = (s0 + np.arange(steps + 1)) % SLOTS
    return hod[idx] - hod[s0]


def backtest(grid: pd.DataFrame, train_end: pd.Timestamp, regional_hod: np.ndarray | None = None) -> dict:
    """Für jeden Zeitpunkt 6–22 Uhr im Testzeitraum und jede Tankstelle:
       Regel (Profil aus Trainingszeitraum) vs. sofort tanken vs. Orakel (bestes Fenster)."""
    train, test = grid[grid.index < train_end], grid[grid.index >= train_end]
    if len(test) < SLOTS * 7:
        return {"error": "Testzeitraum zu kurz (< 7 Tage)"}
    dev = train - train.groupby(train.index.normalize()).transform("mean")
    hod = dev.groupby(slot_of(train.index)).mean()          # 48 × Tankstellen
    steps = HORIZON_H * 60 // SLOT_MIN
    arr = test.values
    slots = slot_of(test.index)
    hours = test.index.hour
    rule_save, oracle_save, worse, waits = [], [], 0, 0
    for j, sid in enumerate(test.columns):
        if sid not in hod.columns or hod[sid].isna().any():
            continue
        h = hod[sid].values
        col = arr[:, j]
        for i in range(0, len(col) - steps - 1):
            if not (6 <= hours[i] < 22) or np.isnan(col[i]):
                continue
            exp = expected_path(h, slots[i], steps)
            k = int(np.argmin(exp))
            future = col[i:i + steps + 1]
            if np.isnan(future).any():
                continue
            chosen = k if -exp[k] >= WAIT_THRESHOLD_CT else 0
            if chosen:
                waits += 1
            s = col[i] - future[chosen]
            rule_save.append(s)
            oracle_save.append(col[i] - future.min())
            worse += s < 0
    if not rule_save:
        return {"error": "keine auswertbaren Fälle"}
    rs = np.array(rule_save)
    return {
        "test_period": [str(test.index[0].date()), str(test.index[-1].date())],
        "cases": int(len(rs)),
        "share_wait": round(waits / len(rs), 3),
        "mean_saving_ct": round(float(rs.mean()), 2),          # ggü. sofort tanken, ct/l
        "median_saving_ct": round(float(np.median(rs)), 2),
        "share_worse_than_now": round(worse / len(rs), 3),
        "oracle_mean_saving_ct": round(float(np.mean(oracle_save)), 2),
        "threshold_ct": WAIT_THRESHOLD_CT,
        "horizon_h": HORIZON_H,
    }


# ---------------------------------------------------------------- Main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, required=True, help="Pfad zum Tankerkönig-Daten-Repo")
    ap.add_argument("--plz", nargs="*", default=["04"], help="PLZ-Präfixe (2-stellig), leer = ganz DE")
    ap.add_argument("--since", default="2026-04-01", help="Startdatum (Standard: Beginn 12-Uhr-Regel)")
    ap.add_argument("--until", default=None, help="Enddatum (Standard: letzter verfügbarer Tag)")
    ap.add_argument("--test-days", type=int, default=28, help="Tage am Ende für den Backtest")
    ap.add_argument("--out", type=Path, default=OUT)
    a = ap.parse_args()

    start = date.fromisoformat(a.since)
    if a.until:
        end = date.fromisoformat(a.until)
    else:
        files = sorted((a.data / "prices").glob("*/*/*-prices.csv"))
        end = date.fromisoformat(files[-1].name[:10])
    stations = load_stations(a.data, end, a.plz)
    print(f"{len(stations)} Tankstellen in PLZ {a.plz or 'DE'}, Zeitraum {start} – {end}")
    prices = load_prices(a.data, start, end, set(stations.uuid))
    train_end = pd.Timestamp(end - timedelta(days=a.test_days - 1), tz=TZ)

    a.out.mkdir(parents=True, exist_ok=True)
    index = {"generated": str(date.today()), "period": [str(start), str(end)], "slot_min": SLOT_MIN,
             "source": "Tankerkönig-Historie (MTS-K)", "license": "CC BY-NC-SA 4.0", "tiles": {}, "backtest": {}}
    stations["tile"] = stations.post_code.str[:2]
    tiles: dict[str, dict] = {}
    for fuel in FUELS:
        grid = to_grid(prices, fuel, start, end)
        print(f"  {fuel}: {grid.shape[1]} Tankstellen mit Daten")
        index["backtest"][fuel] = backtest(grid, train_end)
        for tile, group in stations.groupby("tile"):
            cols = [c for c in grid.columns if c in set(group.uuid)]
            if not cols:
                continue
            reg, st_hod, st_dow, st_off, st_days = profiles(grid[cols])
            t = tiles.setdefault(tile, {"tile": tile, "slot_min": SLOT_MIN, "period": index["period"],
                                        "regional": {}, "stations": {}})
            t["regional"][fuel] = {"hod_dow": deci(reg["hod_dow"]), "dow": deci(reg["dow"])}
            for sid in cols:
                s = t["stations"].setdefault(sid, {"days": int(st_days[sid])})
                s[fuel] = {"hod": deci(st_hod[sid]), "dow": deci(st_dow[sid]),
                           "off": int(round(float(st_off[sid]) * 10)) if not np.isnan(st_off[sid]) else None}

    for tile, t in tiles.items():
        path = a.out / f"{tile}.json"
        path.write_text(json.dumps(t, separators=(",", ":")))
        index["tiles"][tile] = {"file": f"{tile}.json", "stations": len(t["stations"]),
                                "bytes": path.stat().st_size}
    (a.out / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1))

    print("\nKacheln:", {k: f"{v['stations']} Tankst., {v['bytes'] // 1024} kB" for k, v in index["tiles"].items()})
    print("\nBacktest (Regel vs. sofort tanken, ct/l):")
    for fuel, b in index["backtest"].items():
        print(f"  {fuel}: {b}")
    # Größte Effekte für den Bericht
    for tile, t in tiles.items():
        for fuel, r in t["regional"].items():
            m = np.array([np.nan if v is None else v for v in r["hod_dow"]], float).reshape(7, SLOTS) / 10
            prof = np.nanmean(m, axis=0)
            dow = np.array([np.nan if v is None else v for v in r["dow"]], float) / 10
            print(f"  PLZ {tile} {fuel}: Tagesspanne {np.nanmax(prof) - np.nanmin(prof):.1f} ct, "
                  f"günstigster Slot {int(np.nanargmin(prof)) * SLOT_MIN // 60:02d}:{int(np.nanargmin(prof)) * SLOT_MIN % 60:02d}, "
                  f"Wochentage {np.round(dow, 1).tolist()}")


if __name__ == "__main__":
    main()
