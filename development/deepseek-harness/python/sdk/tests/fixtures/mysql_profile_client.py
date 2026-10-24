"""Actual public Python SDK to the built JavaScript dsh carrier; no private argv adapter."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from deepseek_harness import DeepSeekHarness

config = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
with DeepSeekHarness(
    dsh_bin=config["cli"], profile=config["profile"], patches=tuple(config["patches"]),
    dsh_home=config["home"], cwd=config["workspace"], runtime_cwd=config["workspace"],
    provider="deepseek-official", model="deepseek-v4-pro",
    initialize_timeout_seconds=60, request_timeout_seconds=60, shutdown_timeout_seconds=15,
) as harness:
    result = harness.run(config["prompt"], session_id=config["sessionId"])
Path(config["output"]).write_text(json.dumps({
    "sessionId": result.session_id, "finalResponse": result.final_response,
    "events": result.events, "finishReason": result.finish_reason,
}, ensure_ascii=False) + "\n", encoding="utf-8")
