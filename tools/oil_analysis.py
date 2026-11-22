#!/usr/bin/env python3
"""Ölpreis -> Spritpreis: Lag, Asymmetrie ("Rockets and Feathers") und Prognosetest.

Datenquellen (frei, ohne Key):
  - EU Weekly Oil Bulletin: deutsche Preise ohne Steuern (Euro-Super 95, Diesel), wöchentlich (Montag)
  - FRED: Brent (DCOILBRENTEU), NY-Harbor-Benzin (DGASNYH), NY-Harbor-Heizöl (DHOILNYH), täglich in USD
  - EZB: Referenzkurs EUR/USD, täglich

Ergebnis: app/data/oil-model.json (wird von der App angezeigt) und ein Bericht auf stdout.

    python3 tools/oil_analysis.py                 # lädt alles frisch herunter
    python3 tools/oil_analysis.py --cache /tmp/x  # Downloads zwischenspeichern
"""
from __future__ import annotations

import argparse
import io
import json
import urllib.request
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

URLS = {
    "wob.xlsx": "https://energy.ec.europa.eu/document/download/906e60ca-8b6a-44e7-8589-652854d2fd3f_en"
                "?filename=Weekly_Oil_Bulletin_Prices_History_maticni_4web.xlsx",
    "brent.csv": "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DCOILBRENTEU",
    "gas.csv": "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGASNYH",
    "ho.csv": "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DHOILNYH",
    "eurusd.csv": "https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A"
                  "?startPeriod=2005-01-01&format=csvdata",
}
L_PER_BARREL, L_PER_GALLON = 158.987, 3.78541
MAX_LAG = 6               # Wochen
FIT_START = "2015-01-01"
TEST_START = "2020-01-01"
VAT = 1.19                # Netto-Änderung -> Änderung an der Säule (Energiesteuer/CO2 sind Fixbeträge)
OUT = Path(__file__).resolve().parent.parent / "app" / "data" / "oil-model.json"


def fetch(name: str, cache: Path | None) -> bytes:
    if cache and (cache / name).exists():
        return (cache / name).read_bytes()
    req = urllib.request.Request(URLS[name], headers={"User-Agent": "tankzeit-oil-analysis/1.0"})
    with urllib.request.urlopen(req, timeout=180) as r:
        data = r.read()
    if cache:
        cache.mkdir(parents=True, exist_ok=True)
        (cache / name).write_bytes(data)
    return data


def fred(name: str, cache, fx: pd.Series, per_unit: float) -> pd.Series:
    s = pd.read_csv(io.BytesIO(fetch(name, cache)), na_values=".")
    s = s.set_axis(["date", "v"], axis=1).assign(date=lambda d: pd.to_datetime(d.date)).set_index("date").v.dropna()
    return (s / fx.reindex(s.index).ffill() / per_unit * 100).dropna()  # ct/l in EUR


def load(cache: Path | None):
    wob = pd.read_excel(io.BytesIO(fetch("wob.xlsx", cache)), "Prices wo taxes", header=None)
    head = wob.iloc[0].astype(str)
    col = lambda key: head[head == key].index[0]
    pump = pd.DataFrame({
        "date": pd.to_datetime(wob.iloc[3:, 0], errors="coerce"),
        "e5": pd.to_numeric(wob.iloc[3:, col("DE_price_wo_tax_euro95")], errors="coerce") / 10,
        "diesel": pd.to_numeric(wob.iloc[3:, col("DE_price_wo_tax_diesel")], errors="coerce") / 10,
    }).dropna().set_index("date").sort_index()

    fx = pd.read_csv(io.BytesIO(fetch("eurusd.csv", cache)))[["TIME_PERIOD", "OBS_VALUE"]]
    fx = fx.set_axis(["date", "v"], axis=1).assign(date=lambda d: pd.to_datetime(d.date)).set_index("date").v
    daily = {
        "brent": fred("brent.csv", cache, fx, L_PER_BARREL),
        "gas": fred("gas.csv", cache, fx, L_PER_GALLON),
        "ho": fred("ho.csv", cache, fx, L_PER_GALLON),
    }
    return pump, daily


def weekly_mean(s: pd.Series) -> pd.Series:
    """Mittel Mo–So der Woche vor dem Bulletin-Montag, indiziert auf diesen Montag."""
    w = s.resample("W-SUN").mean()
    w.index = w.index + pd.Timedelta(days=1)
    return w


def ols(X: np.ndarray, y: np.ndarray):
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ beta
    s2 = resid @ resid / (len(y) - X.shape[1])
    se = np.sqrt(np.diag(s2 * np.linalg.inv(X.T @ X)))
    return beta, se, np.sqrt(s2)


def asym_model(df: pd.DataFrame, fuel: str):
    """Δpump_t = c + Σ_k (up_k·Δb⁺_{t-k} + dn_k·Δb⁻_{t-k}) + ar·Δpump_{t-1} + ec·Margenabweichung_{t-1}"""
    d = df.diff()
    X = {"const": pd.Series(1.0, index=df.index)}
    for k in range(MAX_LAG + 1):
        X[f"up{k}"] = d.brent.shift(k).clip(lower=0)
        X[f"dn{k}"] = d.brent.shift(k).clip(upper=0)
    X["ar"] = d[fuel].shift(1)
    margin = df[fuel] - df.brent
    X["ec"] = (margin - margin.rolling(52, min_periods=26).mean()).shift(1)
    M = pd.concat([pd.DataFrame(X), d[fuel].rename("y")], axis=1).dropna().loc[FIT_START:]
    cols = [c for c in M.columns if c != "y"]
    beta, se, sd = ols(M[cols].values, M.y.values)
    return dict(zip(cols, beta)), dict(zip(cols, se)), sd, M


def step_response(b: dict, prefix: str, step: float, weeks: int = 10) -> list[float]:
    """Kumulierte Weitergabe (Anteil) eines dauerhaften Brent-Schritts in Woche 0."""
    out, level, prev = [], 0.0, 0.0
    for t in range(weeks + 1):
        dy = b.get(f"{prefix}{t}", 0.0) * step + b["ar"] * prev + b["ec"] * (level - step if t else 0.0)
        level, prev = level + dy, dy
        out.append(round(level / step, 3))
    return out


def weeks_to(resp: list[float], share: float):
    final = resp[-1]
    for t, v in enumerate(resp):
        if v >= share * final:
            return 0.0 if t == 0 else round(t - 1 + (share * final - resp[t - 1]) / (v - resp[t - 1]), 1)
    return None


def latency_test(pump: pd.Series, daily: pd.Series, delays=(0, 2, 4)) -> list[dict]:
    """Prognose der Änderung bis zum nächsten Bulletin-Montag aus der jüngsten Input-Bewegung,
    wenn die Daten `delay` Werktage verzögert vorliegen. Rollierend, nur Vergangenheit."""
    res = []
    y = pump.diff().shift(-1)
    for delay in delays:
        sig = {}
        for t in pump.index:
            avail = daily[daily.index <= t - pd.tseries.offsets.BDay(1 + delay)]
            if len(avail) >= 10:
                sig[t] = avail.iloc[-1] - avail.iloc[-6:-1].mean()
        M = pd.DataFrame({"c": 1.0, "s": pd.Series(sig), "y": y}).dropna().loc["2010":]
        p, a = [], []
        for t in M.index[M.index >= TEST_START]:
            tr = M.index < t
            b, *_ = np.linalg.lstsq(M.loc[tr, ["c", "s"]].values, M.y[tr].values, rcond=None)
            p.append(M.loc[t, ["c", "s"]].values @ b)
            a.append(M.y[t])
        p, a = np.array(p), np.array(a)
        strong = np.abs(p) >= 1.0
        res.append({
            "delay_workdays": delay,
            "corr": round(float(np.corrcoef(p, a)[0, 1]), 3),
            "share_strong": round(float(strong.mean()), 2),
            "hit_rate_strong": round(float(np.mean(np.sign(p[strong]) == np.sign(a[strong]))), 2) if strong.any() else None,
        })
    return res


def analyse(pump: pd.DataFrame, daily: dict, fuel: str) -> dict:
    df = pump[[fuel]].join(weekly_mean(daily["brent"]).rename("brent"), how="inner").dropna()
    b, se, sd, M = asym_model(df, fuel)
    up, dn = step_response(b, "up", 1.0), step_response(b, "dn", -1.0)
    product = "gas" if fuel == "e5" else "ho"
    return {
        "fit_period": [str(M.index[0].date()), str(M.index[-1].date())],
        "n_weeks": int(len(M)),
        "residual_sd_ct": round(float(sd), 2),
        "cum_response_up": up,
        "cum_response_down": dn,
        "first_week_up": up[0],
        "first_week_down": dn[0],
        "weeks_to_80pct_up": weeks_to(up, 0.8),
        "weeks_to_80pct_down": weeks_to(dn, 0.8),
        "coef_up": [round(b[f"up{k}"], 3) for k in range(MAX_LAG + 1)],
        "coef_down": [round(b[f"dn{k}"], 3) for k in range(MAX_LAG + 1)],
        "se_up": [round(se[f"up{k}"], 3) for k in range(MAX_LAG + 1)],
        "se_down": [round(se[f"dn{k}"], 3) for k in range(MAX_LAG + 1)],
        "forecast_test": {
            "brent": latency_test(df[fuel], daily["brent"]),
            product: latency_test(df[fuel], daily[product]),
        },
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", type=Path)
    ap.add_argument("--out", type=Path, default=OUT)
    a = ap.parse_args()
    pump, daily = load(a.cache)
    wb = weekly_mean(daily["brent"])
    recent = pump.join(wb.rename("brent"), how="inner").dropna().iloc[-104:]
    res = {
        "generated": str(date.today()),
        "last_bulletin": str(pump.index[-1].date()),
        "unit": "ct/l ohne Steuern",
        "vat_factor": VAT,
        "sources": ["EU Weekly Oil Bulletin", "FRED (DCOILBRENTEU, DGASNYH, DHOILNYH)", "EZB EUR/USD"],
        "series": {
            "dates": [str(d.date()) for d in recent.index],
            "brent": [round(v, 1) for v in recent.brent],
            "e5": [round(v, 1) for v in recent.e5],
            "diesel": [round(v, 1) for v in recent.diesel],
        },
        "fuels": {f: analyse(pump, daily, f) for f in ("e5", "diesel")},
    }
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")))

    print(f"Letztes Bulletin: {res['last_bulletin']}")
    for f, r in res["fuels"].items():
        print(f"\n== {f.upper()} ({r['fit_period'][0]} – {r['fit_period'][1]}, {r['n_weeks']} Wochen)")
        print(f"  Weitergabe 1. Woche: Anstieg {r['first_week_up']:.0%}, Rückgang {r['first_week_down']:.0%}")
        print(f"  80 % erreicht nach: Anstieg {r['weeks_to_80pct_up']} Wo., Rückgang {r['weeks_to_80pct_down']} Wo.")
        for src, rows in r["forecast_test"].items():
            for row in rows:
                print(f"  Prognosetest {src:5s} Verzögerung {row['delay_workdays']} WT: "
                      f"corr {row['corr']:+.2f}, starke Signale {row['share_strong']:.0%}, "
                      f"Treffer {row['hit_rate_strong']}")
    print(f"\nGeschrieben: {a.out}")


if __name__ == "__main__":
    main()
