"""Check serialized Docker layers, including files hidden by later deletions."""

import hashlib
import json
import sys
import tarfile

archive, architecture = sys.argv[1:]
assert architecture in {"amd64", "arm"}
nodes = []
with tarfile.open(archive) as image:
    manifests = json.load(image.extractfile("manifest.json"))
    assert len(manifests) == 1, "Expected one platform image"
    manifest = manifests[0]
    config = json.load(image.extractfile(manifest["Config"]))
    assert config["architecture"] == architecture
    for name in manifest["Layers"]:
        with tarfile.open(fileobj=image.extractfile(name), mode="r|*") as layer:
            for member in layer:
                filename = member.name.removeprefix("./")
                assert not (
                    filename == "tmp/node-runtime-amd64" and member.size > 0
                ), "Temporary amd64 Node remains in an immutable layer"
                if filename not in {"usr/local/bin/node", "usr/bin/node"}:
                    continue
                if not member.isfile():
                    continue
                with layer.extractfile(member) as binary:
                    header = binary.read(20)
                    assert header[:4] == b"\x7fELF", "Expected a native Node binary"
                    digest = hashlib.sha256(header)
                    while chunk := binary.read(1024 * 1024):
                        digest.update(chunk)
                endian = "little" if header[5] == 1 else "big"
                machine = int.from_bytes(header[18:20], endian)
                assert machine == {"amd64": 62, "arm": 40}[architecture], (
                    "Wrong Node architecture in an image layer"
                )
                nodes.append({"path": filename, "size": member.size, "sha256": digest.hexdigest()})
assert len(nodes) == 1, "Expected exactly one retained Node binary across all layers"
assert nodes[0]["path"] == (
    "usr/local/bin/node" if architecture == "amd64" else "usr/bin/node"
)
print(json.dumps({"pass": True, "architecture": architecture, "layers": len(manifest["Layers"]), "nodes": nodes}))
