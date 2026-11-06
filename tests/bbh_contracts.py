#!/usr/bin/env python3
"""BBH source/selection/prompt contracts, offline; no evaluated model calls."""
import collections
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("bbh_import", ROOT / "tools/import_bbh.py")
bbh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bbh)


class BBHContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pack = json.loads(bbh.OUTPUT.read_text())

    def test_offline_rebuild_is_byte_identical(self):
        with patch.object(bbh.urllib.request, "urlopen", side_effect=AssertionError("network forbidden")):
            rebuilt = (json.dumps(bbh.build(), ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        self.assertEqual(rebuilt, bbh.OUTPUT.read_bytes())

    def test_complete_source_and_balanced_fixed_quick_selection(self):
        tasks = self.pack["tasks"]
        self.assertEqual(len(tasks), 6511)
        self.assertEqual(len({t["id"] for t in tasks}), 6511)
        by_id = {t["id"]: t for t in tasks}
        ids = self.pack["sources"]["quick_ids"]
        self.assertEqual(len(ids), 54)
        self.assertEqual(len(set(ids)), 54)
        self.assertEqual(set(collections.Counter(by_id[i]["meta"]["category"] for i in ids).values()), {2})
        self.assertEqual(len(self.pack["sources"]["counts_by_task"]), 27)
        self.assertEqual(sum(self.pack["sources"]["counts_by_task"].values()), 6511)

    def test_every_prompt_uses_official_three_shots_and_only_current_input(self):
        for name in self.pack["sources"]["counts_by_task"]:
            original = json.loads((bbh.SOURCE / "bbh" / f"{name}.json").read_text())["examples"]
            template = bbh.prompt_template((bbh.SOURCE / "cot-prompts" / f"{name}.txt").read_text())
            self.assertEqual(template.count("\nQ: "), 3)
            group = [t for t in self.pack["tasks"] if t["meta"]["category"] == name]
            self.assertEqual(len(group), len(original))
            for t, example in zip(group, original):
                self.assertEqual(t["prompt"], template + "\n\nQ: " + example["input"] + bbh.PROMPT_SUFFIX)
                self.assertEqual(t["answer"], example["target"])
                self.assertEqual(t["meta"]["prompt_sha256"], bbh.sha(t["prompt"].encode()))
                self.assertEqual(t["scorer"], "bbh")

    def test_missing_and_corrupt_sources_are_not_silently_replaced(self):
        manifest = json.loads(bbh.MANIFEST.read_text())
        first = manifest["files"][0]
        with tempfile.TemporaryDirectory(prefix="bbh-contract-") as tmp:
            root = Path(tmp)
            with self.assertRaisesRegex(FileNotFoundError, "--download"):
                bbh.sources(root)
            file = root / first["path"]
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("tampered source")
            with patch.object(bbh.urllib.request, "urlopen", side_effect=AssertionError("no overwrite")):
                with self.assertRaisesRegex(ValueError, "not overwritten"):
                    bbh.sources(root, download=True)
            self.assertEqual(file.read_text(), "tampered source")

    def test_manifest_contains_immutable_hashes_and_preserved_canary(self):
        manifest = json.loads(bbh.MANIFEST.read_text())
        revision = manifest["revision"]
        self.assertEqual(len(revision), 40)
        for f in manifest["files"]:
            self.assertIn(revision, f["url"])
            self.assertEqual(bbh.sha((bbh.SOURCE / f["path"]).read_bytes()), f["sha256"])
        self.assertIn("canary GUID", self.pack["sources"]["canary"])
        self.assertTrue((bbh.SOURCE / "LICENSE").read_text().startswith("MIT License"))

    def test_damaged_official_question_is_retained_and_flagged_not_in_quick(self):
        damaged = [t for t in self.pack["tasks"] if t["meta"].get("source_issue")]
        self.assertEqual({t["id"] for t in damaged}, set(bbh.SOURCE_ISSUES))
        self.assertEqual(len(damaged), 5)
        snark = next(t for t in damaged if t["id"] == "bbh:snarks:0088")
        self.assertIn("(A) The NB\nA:", snark["prompt"])
        self.assertTrue(set(t["id"] for t in damaged).isdisjoint(self.pack["sources"]["quick_ids"]))
        self.assertEqual(self.pack["sources"]["gradable_count"], 6506)
        by_id = {t["id"]: t for t in damaged}
        for left, right in [("0032", "0119"), ("0036", "0104")]:
            a, b = [by_id["bbh:causal_judgement:" + x] for x in (left, right)]
            self.assertEqual(a["prompt"], b["prompt"])
            self.assertNotEqual(a["answer"], b["answer"])


if __name__ == "__main__":
    unittest.main()
