"""Explicit built CLI modules use a Node carrier rather than Windows file associations."""
from __future__ import annotations

from pathlib import Path

import pytest

from deepseek_harness import HarnessClient, HarnessConfig


@pytest.mark.parametrize("extension", [".js", ".mjs", ".cjs", ".JS"])
def test_javascript_entry_uses_the_child_path_and_preserves_each_argument(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, extension: str
) -> None:
    entry = tmp_path / f"CLI 带空格{extension}"
    node = str(tmp_path / "Node 带空格" / "node.exe")
    lookups: list[tuple[str, str | None]] = []

    def find_node(command: str, *, path: str | None) -> str:
        lookups.append((command, path))
        return node

    monkeypatch.setattr("deepseek_harness.client.shutil.which", find_node)
    patch = tmp_path / "企业 配置.json"
    client = HarnessClient(HarnessConfig(
        dsh_bin=str(entry), dsh_home=str(tmp_path / "home"), patches=(str(patch),)
    ))
    env = {"PATH": "child-only-path"}
    assert client._default_launch_args(env) == (
        node, str(entry), "--profile", "sdk", "--patch", str(patch)
    )
    assert lookups == [("node", "child-only-path")]
    assert env["DSH_HOME"] == str(tmp_path / "home")


def test_missing_node_reports_the_explicit_javascript_requirement_before_spawn(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("deepseek_harness.client.shutil.which", lambda *args, **kwargs: None)

    def forbidden_spawn(*args: object, **kwargs: object) -> None:
        raise AssertionError("Node lookup failure must prevent process creation")

    monkeypatch.setattr("deepseek_harness.client.subprocess.Popen", forbidden_spawn)
    client = HarnessClient(HarnessConfig(dsh_bin=str(tmp_path / "bin.js"), dsh_home=str(tmp_path / "home")))
    with pytest.raises(FileNotFoundError, match="JavaScript dsh_bin requires Node.js on the child PATH"):
        client.start()


def test_executable_entry_does_not_require_node(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden_lookup(*args: object, **kwargs: object) -> None:
        raise AssertionError("Executable carriers do not require Node lookup")

    monkeypatch.setattr("deepseek_harness.client.shutil.which", forbidden_lookup)
    executable = tmp_path / "runtime.exe"
    client = HarnessClient(HarnessConfig(dsh_bin=str(executable), dsh_home=str(tmp_path / "home")))
    assert client._default_launch_args({}) == (str(executable), "--profile", "sdk")
