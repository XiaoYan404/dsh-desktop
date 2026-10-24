"""Exercise the public Python SDK against the actual compiled CLI and local model fixture."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from deepseek_harness import DeepSeekHarness


config = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
with DeepSeekHarness(
    dsh_bin=config["bin"], dsh_home=config["home"], cwd=config["workspace"],
    patches=tuple(config["patches"]), provider="deepseek-official", model="deepseek-v4-flash",
    api_key="sdk-compat-local-fixture", base_url=config["baseUrl"],
    initialize_timeout_seconds=20, request_timeout_seconds=30,
) as harness:
    session = harness.start_session(config["sessionId"])
    result = session.run(config["prompt"])
    cwd = session.get_working_directory()

print(json.dumps({
    "sessionId": result.session_id, "finalResponse": result.final_response,
    "events": result.events, "cwd": cwd,
}, ensure_ascii=False))
