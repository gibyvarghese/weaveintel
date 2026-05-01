"""weaveintel/kaggle-runner entrypoint.

Reads {"command": "...", "payload": {...}} from stdin and writes the result
to stdout as a single JSON line. All errors are returned as {"error": "..."}
with exit code 1.

Commands:
    score_cv             Run k-fold cross-validation on supplied CSV.
    validate_submission  Validate a submission CSV (header / row / id checks).
    blend                Find optimal weighted blend of N OOF predictions.

The container is invoked by @weaveintel/tools-kaggle via @weaveintel/sandbox
ContainerExecutor with no network and no env. Inputs are deterministic.
"""
from __future__ import annotations

import io
import json
import sys
import time
import traceback
from typing import Any


def _read_csv(text: str):
    import pandas as pd
    return pd.read_csv(io.StringIO(text))


def _build_model(name: str, kwargs: dict[str, Any], random_state: int):
    name = (name or "logistic_regression").lower()
    if name == "logistic_regression":
        from sklearn.linear_model import LogisticRegression
        return LogisticRegression(random_state=random_state, max_iter=1000, **kwargs)
    if name == "random_forest":
        from sklearn.ensemble import RandomForestClassifier
        return RandomForestClassifier(random_state=random_state, n_estimators=200, **kwargs)
    if name == "gradient_boosting":
        from sklearn.ensemble import GradientBoostingClassifier
        return GradientBoostingClassifier(random_state=random_state, **kwargs)
    if name == "lightgbm":
        # Late import — lightgbm pulls libgomp; only loaded when requested.
        from lightgbm import LGBMClassifier
        defaults = {"n_estimators": 500, "learning_rate": 0.05, "num_leaves": 31, "verbose": -1}
        defaults.update(kwargs)
        return LGBMClassifier(random_state=random_state, **defaults)
    if name == "xgboost":
        from xgboost import XGBClassifier
        defaults = {
            "n_estimators": 500,
            "learning_rate": 0.05,
            "max_depth": 6,
            "tree_method": "hist",
            "eval_metric": "logloss",
        }
        defaults.update(kwargs)
        return XGBClassifier(random_state=random_state, **defaults)
    raise ValueError(f"unknown model: {name}")


def _supports_predict_proba(model) -> bool:
    return hasattr(model, "predict_proba")


def cmd_score_cv(payload: dict[str, Any]) -> dict[str, Any]:
    import numpy as np
    from sklearn.model_selection import StratifiedKFold, cross_val_score

    train_csv = payload["trainCsv"]
    target = payload["targetColumn"]
    metric = payload.get("metric", "accuracy")
    folds = int(payload.get("folds", 5))
    model_name = payload.get("model", "logistic_regression")
    model_kwargs = payload.get("modelKwargs") or {}
    random_state = int(payload.get("randomState", 42))
    capture_oof = bool(payload.get("captureOof", True))

    df = _read_csv(train_csv)
    if target not in df.columns:
        raise ValueError(f"target column '{target}' not found")
    y = df[target]
    X = df.drop(columns=[target]).select_dtypes(include="number").fillna(0)

    skf = StratifiedKFold(n_splits=folds, shuffle=True, random_state=random_state)
    model = _build_model(model_name, model_kwargs, random_state)

    started = time.time()
    scores = cross_val_score(model, X, y, cv=skf, scoring=metric)

    oof_predictions: list[float] | None = None
    if capture_oof:
        # Re-fit per fold to gather OOF predictions. We retrain a fresh model per
        # fold to keep semantics identical to cross_val_score above.
        oof = np.zeros(len(y), dtype=float)
        for tr_idx, va_idx in skf.split(X, y):
            fold_model = _build_model(model_name, model_kwargs, random_state)
            fold_model.fit(X.iloc[tr_idx], y.iloc[tr_idx])
            if _supports_predict_proba(fold_model):
                proba = fold_model.predict_proba(X.iloc[va_idx])
                # Binary: take positive class; multiclass: take argmax-class proba.
                oof[va_idx] = proba[:, 1] if proba.shape[1] == 2 else proba.max(axis=1)
            else:
                oof[va_idx] = fold_model.predict(X.iloc[va_idx]).astype(float)
        oof_predictions = [float(v) for v in oof]

    duration_ms = int((time.time() - started) * 1000)

    result: dict[str, Any] = {
        "cvScore": float(scores.mean()),
        "foldScores": [float(s) for s in scores],
        "metric": metric,
        "model": model_name,
        "durationMs": duration_ms,
    }
    if oof_predictions is not None:
        result["oofPredictions"] = oof_predictions
    return result


def cmd_validate_submission(payload: dict[str, Any]) -> dict[str, Any]:
    csv_text = payload.get("csvContent", "") or ""
    expected_headers = list(payload.get("expectedHeaders") or [])
    id_column = payload.get("idColumn")
    expected_row_count = payload.get("expectedRowCount")

    errors: list[str] = []
    warnings: list[str] = []

    if not csv_text:
        return {"valid": False, "rows": 0, "headers": [], "errors": ["empty submission"], "warnings": warnings}

    df = _read_csv(csv_text)
    headers = list(df.columns)
    rows = int(len(df))

    if headers != expected_headers:
        errors.append(f"header mismatch: got {headers}, expected {expected_headers}")
    if expected_row_count is not None and rows != int(expected_row_count):
        errors.append(f"row count mismatch: got {rows}, expected {expected_row_count}")
    if id_column:
        if id_column not in df.columns:
            errors.append(f"idColumn '{id_column}' not found")
        else:
            ids = df[id_column].astype(str)
            dupes = ids[ids.duplicated()].unique().tolist()
            if dupes:
                sample = ", ".join(dupes[:5])
                more = f" (+{len(dupes) - 5} more)" if len(dupes) > 5 else ""
                errors.append(f"duplicate ids: {sample}{more}")

    return {
        "valid": len(errors) == 0,
        "rows": rows,
        "headers": headers,
        "errors": errors,
        "warnings": warnings,
    }


COMMANDS = {
    "score_cv": cmd_score_cv,
    "validate_submission": cmd_validate_submission,
    "blend": None,  # set below to avoid forward-decl issues
}


def _score_blend(blended, y_true, metric: str) -> float:
    """Lower-is-better metrics returned as positive numbers; higher-is-better negated."""
    import numpy as np
    from sklearn.metrics import roc_auc_score, log_loss, mean_squared_error

    metric = metric.lower()
    if metric == "auc" or metric == "roc_auc":
        # maximize AUC → minimize -AUC
        return -float(roc_auc_score(y_true, blended))
    if metric == "logloss" or metric == "log_loss":
        # blended must be in (0,1)
        clipped = np.clip(blended, 1e-7, 1 - 1e-7)
        return float(log_loss(y_true, clipped))
    if metric == "rmse":
        return float(np.sqrt(mean_squared_error(y_true, blended)))
    raise ValueError(f"unsupported blend metric: {metric}")


def cmd_blend(payload: dict[str, Any]) -> dict[str, Any]:
    """Find optimal weights for a convex blend of N OOF prediction vectors.

    payload: { oofMatrix: number[][] (rows=models, cols=samples),
               yTrue: number[],
               metric: 'auc'|'rmse'|'logloss' }
    Returns: { weights, blendedScore, baselineMeanScore, baselineBestSoloScore, modelCount, sampleCount, metric }

    Optimization: SLSQP on the simplex (weights ≥ 0, sum = 1).
    """
    import numpy as np
    from scipy.optimize import minimize

    oof_matrix = np.asarray(payload["oofMatrix"], dtype=float)  # (n_models, n_samples)
    y_true = np.asarray(payload["yTrue"], dtype=float)
    metric = str(payload.get("metric", "auc"))

    if oof_matrix.ndim != 2:
        raise ValueError("oofMatrix must be a 2D array (models × samples)")
    n_models, n_samples = oof_matrix.shape
    if n_models < 2:
        raise ValueError("blend requires at least 2 OOF prediction vectors")
    if y_true.shape[0] != n_samples:
        raise ValueError(f"yTrue length {y_true.shape[0]} != sample count {n_samples}")

    def loss(w):
        blended = w @ oof_matrix
        return _score_blend(blended, y_true, metric)

    x0 = np.full(n_models, 1.0 / n_models)
    constraints = [{"type": "eq", "fun": lambda w: np.sum(w) - 1.0}]
    bounds = [(0.0, 1.0) for _ in range(n_models)]

    result = minimize(loss, x0, method="SLSQP", bounds=bounds, constraints=constraints,
                      options={"maxiter": 200, "ftol": 1e-9})
    weights = [float(w) for w in result.x]
    blended_loss = float(result.fun)

    # Baselines for context
    baseline_mean_loss = _score_blend(np.mean(oof_matrix, axis=0), y_true, metric)
    baseline_best_solo_loss = min(_score_blend(oof_matrix[i], y_true, metric) for i in range(n_models))

    # Convert losses back to "score" semantics for callers (negate AUC).
    def to_score(v: float) -> float:
        return -v if metric.lower() in ("auc", "roc_auc") else v

    return {
        "weights": weights,
        "blendedScore": to_score(blended_loss),
        "baselineMeanScore": to_score(baseline_mean_loss),
        "baselineBestSoloScore": to_score(baseline_best_solo_loss),
        "modelCount": int(n_models),
        "sampleCount": int(n_samples),
        "metric": metric,
        "converged": bool(result.success),
        "iterations": int(result.nit),
    }



def cmd_adversarial_validation(payload: dict[str, Any]) -> dict[str, Any]:
    """Detect train/test distribution shift via adversarial validation.

    payload: {
        trainMatrix: number[][] (rows=samples, cols=features),
        testMatrix: number[][] (rows=samples, cols=features),
        metric: 'auc'|'logloss' (optional, default 'auc'),
        topFeatures: int (optional, default 10)
    }
    Returns: { auc, topFeatures: [(name, importance)], model, converged, iterations }
    """
    import numpy as np
    from sklearn.ensemble import GradientBoostingClassifier
    from sklearn.metrics import roc_auc_score, log_loss
    from sklearn.model_selection import StratifiedKFold
    from sklearn.inspection import permutation_importance

    train_matrix = np.asarray(payload["trainMatrix"], dtype=float)
    test_matrix = np.asarray(payload["testMatrix"], dtype=float)
    metric = str(payload.get("metric", "auc"))
    n_top = int(payload.get("topFeatures", 10))
    feature_names = payload.get("featureNames") or [f"f{i}" for i in range(train_matrix.shape[1])]

    X = np.vstack([train_matrix, test_matrix])
    y = np.array([0] * len(train_matrix) + [1] * len(test_matrix))

    skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    aucs = []
    loglosses = []
    importances = np.zeros(X.shape[1])
    iterations = 0
    converged = True
    for train_idx, val_idx in skf.split(X, y):
        model = GradientBoostingClassifier(random_state=42, n_estimators=100)
        model.fit(X[train_idx], y[train_idx])
        proba = model.predict_proba(X[val_idx])[:, 1]
        aucs.append(roc_auc_score(y[val_idx], proba))
        loglosses.append(log_loss(y[val_idx], proba))
        # Permutation importance on validation fold
        result = permutation_importance(model, X[val_idx], y[val_idx], n_repeats=5, random_state=42)
        importances += result.importances_mean
        iterations += 1

    auc = float(np.mean(aucs))
    logloss = float(np.mean(loglosses))
    importances /= iterations
    # Top features by absolute importance
    top_idx = np.argsort(-np.abs(importances))[:n_top]
    top_features = [(feature_names[i], float(importances[i])) for i in top_idx]

    return {
        "auc": auc,
        "logloss": logloss,
        "topFeatures": top_features,
        "model": "GradientBoostingClassifier",
        "converged": converged,
        "iterations": iterations,
    }

COMMANDS["blend"] = cmd_blend
COMMANDS["adversarial_validation"] = cmd_adversarial_validation


def main() -> int:
    try:
        raw = sys.stdin.read()
        msg = json.loads(raw)
        command = msg.get("command")
        payload = msg.get("payload") or {}
        handler = COMMANDS.get(command)
        if handler is None:
            print(json.dumps({"error": f"unknown command: {command}"}))
            return 1
        result = handler(payload)
        print(json.dumps(result))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": str(exc), "trace": traceback.format_exc()}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
