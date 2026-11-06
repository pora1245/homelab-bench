#!/usr/bin/env python3
"""Installer tests use tiny local fixtures, never actual network downloads."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location("installer",ROOT/"tools/import_full_datasets.py")
installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)


class InstallerContracts(unittest.TestCase):
    def item(self,local=False):
        payload=b'{"question":"fixture"}\n'
        return {"group":"fixture","name":"fixture.jsonl","url":"https://example.invalid/pinned","bytes":len(payload),"sha256":hashlib.sha256(payload).hexdigest(),"local_only":local},payload

    def test_verified_download_is_atomic_and_reused(self):
        item,payload=self.item()
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/item["name"]
            with patch.object(installer,"DOWNLOAD",True),patch.object(installer.urllib.request,"urlopen",return_value=io.BytesIO(payload)) as fetch:
                installer.download_file(item,path)
                installer.download_file(item,path)
                self.assertEqual(fetch.call_count,1)
            self.assertEqual(path.read_bytes(),payload)
            self.assertFalse(path.with_name(path.name+".part").exists())

    def test_bad_download_removed_and_existing_bad_file_preserved(self):
        item,payload=self.item()
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/item["name"]
            with patch.object(installer,"DOWNLOAD",True),patch.object(installer.urllib.request,"urlopen",return_value=io.BytesIO(b"corrupt")):
                with self.assertRaisesRegex(ValueError,"hash/size"):installer.download_file(item,path)
            self.assertFalse(path.exists());self.assertEqual(list(Path(directory).iterdir()),[])
            path.write_bytes(b"keep-for-inspection")
            with self.assertRaisesRegex(ValueError,"Source hash mismatch"):installer.download_file(item,path)
            self.assertEqual(path.read_bytes(),b"keep-for-inspection")

    def test_local_only_requires_explicit_flag(self):
        item,payload=self.item(local=True)
        with tempfile.TemporaryDirectory() as directory,patch.object(installer,"DOWNLOAD",True),patch.object(installer,"DOWNLOAD_LOCAL_ONLY",False),patch.object(installer.urllib.request,"urlopen") as fetch:
            with self.assertRaises(PermissionError):installer.download_file(item,Path(directory)/item["name"])
            fetch.assert_not_called()

    def test_dry_run_has_no_network_or_filesystem_mutation(self):
        manifest=json.loads((ROOT/"datasets/sources/download-manifest.json").read_text())
        with tempfile.TemporaryDirectory() as directory,patch.object(installer,"ROOT",Path(directory)),patch.object(installer,"download_manifest",return_value=manifest["files"]),patch.object(installer,"DOWNLOAD",True),patch.object(installer,"DOWNLOAD_LOCAL_ONLY",False),patch.object(installer.urllib.request,"urlopen") as fetch:
            plan=installer.download_plan(Path(directory)/"empty-cache")
            groups={g["group"]:g for g in plan["groups"]}
            self.assertEqual(groups["gsm8k"]["status"],"download")
            for group in installer.LOCAL_ONLY:self.assertEqual(groups[group]["status"],"explicit_local_download_required")
            self.assertEqual(list(Path(directory).iterdir()),[])
            fetch.assert_not_called()

    def test_manifest_pins_every_source_and_all_lcb_shards(self):
        files=installer.download_manifest()
        self.assertEqual(len([i for i in files if i["group"]=="livecodebench"]),6)
        for i in files:
            self.assertRegex(i["url"],r"/[0-9a-f]{40}/")
            self.assertRegex(i["sha256"],r"^[0-9a-f]{64}$")
            self.assertGreater(i["bytes"],0)
            self.assertEqual(i["local_only"],i["group"] in installer.LOCAL_ONLY)

    def test_jsonl_loader_without_hf_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"source.jsonl";path.write_text('{"id":1}\n{"id":2}\n')
            self.assertEqual(list(installer.records([path])),[{"id":1},{"id":2}])

    def test_cache_miss_uses_pinned_download_loader(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/"fixture.jsonl";source.write_text('{"question":"q","answer":"a"}\n')
            with patch.object(installer,"download_group",return_value=[source]) as download:
                rows,files=installer.arrow(Path(directory)/"empty-cache",installer.CACHE_GLOBS["gsm8k"])
            download.assert_called_once_with("gsm8k")
            self.assertEqual(rows,[{"question":"q","answer":"a"}]);self.assertEqual(files,[source])


if __name__=="__main__":
    import argparse,sys
    parser=argparse.ArgumentParser()
    parser.add_argument("--json",type=Path,help="Write machine-readable installer test evidence")
    args=parser.parse_args()
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(InstallerContracts))
    if args.json:
        args.json.parent.mkdir(parents=True,exist_ok=True)
        args.json.write_text(json.dumps({"type":"installer_contract_validation","network_used":False,"tests":result.testsRun,"passed":result.testsRun-len(result.errors)-len(result.failures),"failures":[{"test":t.id(),"detail":detail} for t,detail in result.errors+result.failures]},indent=2)+"\n")
    sys.exit(not result.wasSuccessful())
