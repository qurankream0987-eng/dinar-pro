#!/bin/sh
# Template launch of the inference server behind the gateway. Pin the image digest and verify
# the parser flags for the chosen model against that exact vLLM version before approval:
# Qwen3 and Qwen3.5 do NOT share the same tool-call / reasoning parser.
set -eu
: "${DINAR_VLLM_IMAGE:?pin vllm/vllm-openai@sha256:<digest> verified at approval}"
: "${DINAR_LLM_MODEL:?Qwen/Qwen3-14B or Qwen/Qwen3.5-9B}"
: "${DINAR_LLM_REVISION:?exact Hugging Face commit of the model}"
: "${DINAR_TOOL_CALL_PARSER:?verified parser for this model and vLLM version}"
: "${DINAR_VLLM_INTERNAL_KEY:?internal key, from the secret store, never committed}"
exec docker run --rm --gpus all --ipc=host \
  -p 127.0.0.1:8000:8000 \
  -e VLLM_API_KEY="$DINAR_VLLM_INTERNAL_KEY" \
  -v "${DINAR_HF_CACHE:-/var/lib/dinar-hf}:/root/.cache/huggingface" \
  "$DINAR_VLLM_IMAGE" \
  --model "$DINAR_LLM_MODEL" --revision "$DINAR_LLM_REVISION" \
  --served-model-name "$DINAR_LLM_MODEL" \
  --host 0.0.0.0 --port 8000 \
  --max-model-len "${DINAR_MAX_MODEL_LEN:-16384}" \
  --max-num-seqs "${DINAR_MAX_NUM_SEQS:-16}" \
  --gpu-memory-utilization "${DINAR_GPU_MEMORY_UTILIZATION:-0.90}" \
  --enable-auto-tool-choice --tool-call-parser "$DINAR_TOOL_CALL_PARSER" \
  --disable-log-requests
