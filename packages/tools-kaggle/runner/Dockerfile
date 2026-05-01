# weaveintel/kaggle-runner — sandboxed CV scorer + submission validator
#
# Built and consumed by @weaveintel/tools-kaggle's `kaggle.local.score_cv` and
# `kaggle.local.validate_submission` MCP tools. The runner reads a single JSON
# message from stdin and writes a single JSON response to stdout. No network.
#
# Build:
#   docker build -t weaveintel/kaggle-runner:0.2.0 .
#   docker push  weaveintel/kaggle-runner:0.2.0
#
# Capture the resulting digest and:
#   1) Replace KAGGLE_RUNNER_IMAGE_DIGEST in packages/tools-kaggle/src/local-tools.ts
#   2) Register the digest in your @weaveintel/sandbox ImagePolicy via
#      kaggleRunnerImagePolicyEntry(digest).
#
# v0.2.0 (Phase K7a): adds LightGBM, XGBoost, scipy for the `blend` command,
# and OOF prediction capture in score_cv. Image grew from ~150MB to ~600MB.

FROM python:3.11-slim

# libgomp1 is needed by lightgbm/xgboost OpenMP runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
      pandas==2.2.* \
      scikit-learn==1.5.* \
      numpy==1.26.* \
      scipy==1.13.* \
      lightgbm==4.* \
      xgboost==2.*

WORKDIR /app
COPY score.py /app/score.py

ENTRYPOINT ["python", "/app/score.py"]
