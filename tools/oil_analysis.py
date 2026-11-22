#!/usr/bin/env python3
"""Schätzt Lag und Asymmetrie zwischen Brent (in EUR) und deutschen Spritpreisen.

Datenquellen (alle frei, ohne Key):
  - EU Weekly Oil Bulletin, Preise ohne Steuern (DE, Euro-Super 95 und Diesel), wöchentlich (Montag)
  - FRED DCOILBRENTEU, Brent Spot in USD/Barrel, täglich
  - EZB EXR D.USD.EUR.SP00.A, Referenzkurs EUR/USD, täglich

Ausgabe: app/public/data/oil-model.json (wird von der App gelesen) und ein Bericht auf stdout.

Aufruf:
  python3 tools/oil_analysis.py            # lädt die Daten selbst herunter
  python3 tools/oil_analysis.py --cache DIR  # nutzt/füllt einen Download-Ordner
"""
from __future__ import annotations

import argparse
import io
import json
import sys
import urllib.request
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

WOB_URL = ("https://energy.ec.europa.eu/document/download/906e60ca-8b6a-44e7-8589-652854d2fd3f_en"
           "?filename=Weekly_Oil_Bulletin_Prices_History_maticni_4web.xlsx")
BRENT_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DCOILBRENTEU"
EURUSD_URL = ("https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A"
              "?startPeriod=2005-01-01&format=csvdata")
L_PER_BARREL = 158.987
MAX_LAG = 6          # Wochen
FIT_START = "2015-01-01"
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "app" / "public" / "data" / "oil-model.json"


def fetch(url: str, cache: Path | None, name: str) -> bytes:
    if cache:
        p = cache / name
        if p.exists():
            return p.read_bytes()
    req = urllib.request.Request(url, headers={"User-Agent": "tankzeit-oil-analysis/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    if cache:
        cache.mkdir(parents=True, exist_ok=True)
        (cache / name).write_bytes(data)
    return data


def load(cache: Path | None) -> pd.DataFrame:
    wob = pd.read_excel(io.BytesIO(fetch(WOB_URL, cache, "wob.xlsx")), "Prices wo taxes", header=None)
    head = wob.iloc[0].astype(str)
    cols = {"e5": head[head == "DE_price_wo_tax_euro95"].index[0],
            "diesel": head[head == "DE_price_wo_tax_diesel"].index[0]}
    pump = pd.DataFrame({
        "date": pd.to_datetime(wob.iloc[3:, 0], errors="coerce"),
        **{k: pd.to_numeric(wob.iloc[3:, c], errors="coerce") / 10 for k, c in cols.items()},  # ct/l
    }).dropna().set_index("date").sort_index()

    brent = pd.read_csv(io.BytesIO(fetch(BRENT_URL, cache, "brent.csv")), na_values=".")
    brent = brent.set_axis(["date", "usd"], axis=1).assign(date=lambda d: pd.to_datetime(d.date))
    fx = pd.read_csv(io.BytesIO(fetch(EURUSD_URL, cache, "eurusd.csv")))[["TIME_PERIOD", "OBS_VALUE"]]
    fx = fx.set_axis(["date", "eurusd"], axis=1).assign(date=lambda d: pd.to_datetime(d.date))
    daily = brent.merge(fx, on="date", how="inner").dropna()
    daily["brent_ct_l"] = daily.usd / daily.eurusd / L_PER_BARREL * 100
    daily = daily.set_index("date")

    # Wochenmittel Brent der 7 Tage *vor* dem Bulletin-Montag (Mo-So der Vorwoche)
    wk = daily.brent_ct_l.resample("W-SUN").mean()
    wk.index = wk.index + pd.Timedelta(days=1)  # -> folgender Montag
    df = pump.join(wk.rename("brent"), how="inner").dropna()
    return df, daily


def design(df: pd.DataFrame, fuel: str, asym: bool, min_lag: int = 0) -> tuple[pd.DataFrame, pd.Series]:
    d = df.diff()
    X = {}
    for k in range(min_lag, MAX_LAG + 1):
        b = d.brent.shift(k)
        if asym:
            X[f"up{k}"] = b.clip(lower=0)
            X[f"dn{k}"] = b.clip(upper=0)
        else:
            X[f"b{k}"] = b
    X["ar1"] = d[fuel].shift(1)
    # Fehlerkorrektur: Abstand Pumpe-Brent ggü. gleitendem 52-Wochen-Mittel der Marge
    margin = df[fuel] - df.brent
    X["ec"] = (margin - margin.rolling(52, min_periods=26).mean()).shift(1)
    X = pd.DataFrame(X)
    X.insert(0, "const", 1.0)
    y = d[fuel]
    m = pd.concat([X, y.rename("y")], axis=1).dropna()
    return m.drop(columns="y"), m.y


def ols(X: pd.DataFrame, y: pd.Series):
    beta, *_ = np.linalg.lstsq(X.values, y.values, rcond=None)
    resid = y.values - X.values @ beta
    n, k = X.shape
    s2 = resid @ resid / (n - k)
    cov = s2 * np.linalg.inv(X.values.T @ X.values)
    return pd.Series(beta, X.columns), pd.Series(np.sqrt(np.diag(cov)), X.columns), np.sqrt(s2)


def cumulative_response(beta: pd.Series, prefix: str, step: float = 1.0, weeks: int = 10) -> list[float]:
    """Pumpenreaktion auf einen dauerhaften Brent-Schritt (step ct/l) in Woche 0, inkl. AR- und EC-Dynamik.
    Ergebnis normiert auf step (also Anteil der Weitergabe)."""
    resp, level, prev_dy = [], 0.0, 0.0
    for t in range(weeks + 1):
        dy = beta.get(f"{prefix}{t}", 0.0) * step + beta["ar1"] * prev_dy + beta["ec"] * (level - step if t else 0.0)
        level += dy
        prev_dy = dy
        resp.append(level / step)
    return resp


def first_week_reaching(resp: list[float], share: float) -> float | None:
    for t, v in enumerate(resp):
        if v >= share * resp[-1] and resp[-1] > 0:
            if t == 0:
                return 0.0
            prev = resp[t - 1]
            return t - 1 + (share * resp[-1] - prev) / (v - prev)  # linear interpoliert
    return None


def oos_eval(df: pd.DataFrame, fuel: str, start="2020-01-01", min_lag: int = 0) -> dict:
    """Rollierende 1-Wochen-Prognose: Modell mit Brent vs. naiv (keine Änderung) vs. nur Eigendynamik."""
    X, y = design(df, fuel, asym=True, min_lag=min_lag)
    idx = X.index[X.index >= start]
    preds, base_ar, actual = [], [], []
    for t in idx:
        tr = X.index < t - pd.Timedelta(days=1)
        if tr.sum() < 150:
            continue
        b, _, _ = ols(X[tr], y[tr])
        preds.append(float(X.loc[t] @ b))
        Xa = X.loc[tr, ["const", "ar1", "ec"]]
        ba, _, _ = ols(Xa, y[tr])
        base_ar.append(float(X.loc[t, ["const", "ar1", "ec"]] @ ba))
        actual.append(float(y.loc[t]))
    p, a, ar = map(np.array, (preds, actual, base_ar))
    mae = lambda e: float(np.mean(np.abs(e)))
    big = np.abs(p) >= 1.0
    return {
        "n_weeks": int(len(a)),
        "mae_naive_ct": round(mae(a), 2),
        "mae_ar_only_ct": round(mae(a - ar), 2),
        "mae_model_ct": round(mae(a - p), 2),
        "sign_hit_rate": round(float(np.mean(np.sign(p) == np.sign(a))), 3),
        "sign_hit_rate_when_signal_ge_1ct": round(float(np.mean(np.sign(p[big]) == np.sign(a[big]))), 3) if big.any() else None,
        "share_weeks_signal_ge_1ct": round(float(big.mean()), 3),
        "mean_abs_move_when_signal_ge_1ct": round(float(np.mean(np.abs(a[big]))), 2) if big.any() else None,
    }


def analyse(df: pd.DataFrame, fuel: str) -> dict:
    fit = df.loc[FIT_START:]
    Xs, ys = design(fit, fuel, asym=False)
    bs, ses, sig = ols(Xs, ys)
    Xa, ya = design(fit, fuel, asym=True)
    ba, sea, siga = ols(Xa, ya)
    up = cumulative_response(ba, "up", 1.0)
    dn = cumulative_response(ba, "dn", -1.0)
    sym = cumulative_response(bs, "b")
    # Test auf Asymmetrie: Summe up0..2 vs. dn0..2
    k = [f"up{i}" for i in range(3)], [f"dn{i}" for i in range(3)]
    early_up, early_dn = ba[k[0]].sum(), ba[k[1]].sum()
    return {
        "fit_period": [str(fit.index[0].date()), str(fit.index[-1].date())],
        "n_weeks": int(len(ys)),
        "residual_sd_ct": round(float(siga), 2),
        "lag_weights_symmetric": [round(float(bs[f"b{i}"]), 3) for i in range(MAX_LAG + 1)],
        "cum_response_symmetric": [round(v, 3) for v in sym],
        "cum_response_up": [round(v, 3) for v in up],
        "cum_response_down": [round(v, 3) for v in dn],
        "weeks_to_50pct_up": _r(first_week_reaching(up, 0.5)),
        "weeks_to_50pct_down": _r(first_week_reaching(dn, 0.5)),
        "weeks_to_80pct_up": _r(first_week_reaching(up, 0.8)),
        "weeks_to_80pct_down": _r(first_week_reaching(dn, 0.8)),
        "passthrough_first_3w_up": round(float(early_up), 3),
        "passthrough_first_3w_down": round(float(early_dn), 3),
        "ar1": round(float(ba["ar1"]), 3),
        "ec": round(float(ba["ec"]), 3),
        "coef_up": [round(float(ba[f"up{i}"]), 3) for i in range(MAX_LAG + 1)],
        "coef_down": [round(float(ba[f"dn{i}"]), 3) for i in range(MAX_LAG + 1)],
        "se_up": [round(float(sea[f"up{i}"]), 3) for i in range(MAX_LAG + 1)],
        "se_down": [round(float(sea[f"dn{i}"]), 3) for i in range(MAX_LAG + 1)],
        "const": round(float(ba["const"]), 3),
        "oos_nowcast": oos_eval(df, fuel),
        "oos_forward": oos_eval(df, fuel, min_lag=1),
    }


def _r(v):
    return None if v is None else round(float(v), 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", type=Path)
    ap.add_argument("--out", type=Path, default=OUT)
    a = ap.parse_args()
    df, daily = load(a.cache)
    res = {"generated": str(date.today()), "unit": "ct/l netto (ohne Steuern)",
           "note": "Wochenmodell. Brent = Mittel Mo-So vor dem Bulletin-Montag. Steuern (Energiesteuer, CO2, MwSt) "
                   "sind fix bzw. proportional; an der Säule wirkt eine Netto-Änderung x ca. 1,19-fach.",
           "max_lag_weeks": MAX_LAG,
           "sources": ["EU Weekly Oil Bulletin", "FRED DCOILBRENTEU", "EZB EXR"],
           "last_bulletin": str(df.index[-1].date()),
           "fuels": {}}
    for fuel in ("e5", "diesel"):
        res["fuels"][fuel] = analyse(df, fuel)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")))
    json.dump(res, sys.stdout, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
